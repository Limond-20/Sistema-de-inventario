"""Servidor local: sirve la app por HTTPS y enlaza la PC con los celulares por WebSocket.

Protocolo (JSON por WebSocket, ruta /ws):
  cliente -> servidor  {"t":"auth","token":"..."}                 (solo celulares; primer mensaje)
                       {"t":"msg","ch":"<canal>","data":{...}}    (se retransmite a los demás)
                       {"t":"ping"}
  servidor -> cliente  {"t":"hello","id":"..","role":"pc|phone"}
                       {"t":"presence","pc":true,"phones":1}
                       {"t":"msg","ch":"..","data":{..},"from":"pc|phone"}
                       {"t":"pong"}  /  {"t":"error","reason":".."}

Seguridad: desde la propia PC (loopback) se confía sin código; cualquier otro dispositivo
debe presentar el código de vinculación del QR. Se rechaza cualquier Origin que no sea el propio.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import segno
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from .netinfo import is_loopback, lan_ips
from .pairing import PairingStore

MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_EVIDENCIA_BYTES = 5 * 1024 * 1024
MAX_MSGS_PER_SECOND = 60
AUTH_TIMEOUT_SECONDS = 5
CHANNEL_NAME_MAX = 64
EVIDENCE_ID_RE = re.compile(r"^[a-f0-9]{32}$")

# Códigos de cierre propios (4000-4999)
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_RATE_LIMIT = 4429
CLOSE_TOO_BIG = 1009


@dataclass
class Client:
    id: str
    ws: WebSocket
    role: str
    window_start: float = field(default_factory=time.monotonic)
    window_count: int = 0

    def allow(self) -> bool:
        now = time.monotonic()
        if now - self.window_start >= 1.0:
            self.window_start, self.window_count = now, 0
        self.window_count += 1
        return self.window_count <= MAX_MSGS_PER_SECOND


class Hub:
    def __init__(self) -> None:
        self.clients: dict[str, Client] = {}

    def presence(self) -> dict:
        return {
            "t": "presence",
            "pc": any(c.role == "pc" for c in self.clients.values()),
            "phones": sum(1 for c in self.clients.values() if c.role == "phone"),
        }

    async def _fanout(self, text: str, exclude: str | None = None) -> None:
        dead: list[str] = []
        for c in list(self.clients.values()):
            if c.id == exclude:
                continue
            try:
                await c.ws.send_text(text)
            except Exception:
                dead.append(c.id)
        for cid in dead:
            self.clients.pop(cid, None)

    async def add(self, c: Client) -> None:
        self.clients[c.id] = c
        await self._fanout(json.dumps(self.presence()))

    async def remove(self, c: Client) -> None:
        if self.clients.pop(c.id, None) is not None:
            await self._fanout(json.dumps(self.presence()))

    async def relay(self, sender: Client, ch: str, data: object) -> None:
        await self._fanout(json.dumps({"t": "msg", "ch": ch, "data": data, "from": sender.role}), exclude=sender.id)

    async def drop_phones(self, code: int = CLOSE_UNAUTHORIZED) -> None:
        for c in [c for c in self.clients.values() if c.role == "phone"]:
            try:
                await c.ws.close(code=code)
            except Exception:
                pass


class SPAStaticFiles(StaticFiles):
    """Sirve la app Angular; las rutas internas (/pos, /recepcion...) devuelven index.html."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as ex:
            last = path.rsplit("/", 1)[-1]
            if ex.status_code == 404 and "." not in last and not path.startswith("api/") and path != "api":
                return await super().get_response("index.html", scope)
            raise


def _same_origin(origin: str, host: str | None) -> bool:
    if not host:
        return False
    try:
        return urlsplit(origin).netloc.lower() == host.lower()
    except ValueError:
        return False


def cleanup_stale_temp_evidencias(evidencias_dir: Path, max_age_seconds: float = 3600.0) -> int:
    """Borra archivos temporales (.tmp_*) con más de max_age_seconds (default 1 hora)."""
    removed = 0
    now = time.time()
    if not evidencias_dir.is_dir():
        return 0
    for p in evidencias_dir.glob(".tmp_*"):
        try:
            if p.is_file():
                if now - p.stat().st_mtime > max_age_seconds:
                    p.unlink(missing_ok=True)
                    removed += 1
        except OSError:
            pass
    return removed


def create_app(
    static_dir: Path | None = None,
    *,
    port: int = 8443,
    tls: bool = True,
    ips: list[str] | None = None,
    pairing: PairingStore | None = None,
    max_message_bytes: int = MAX_MESSAGE_BYTES,
    data_dir: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="Abarrotes · servidor local", docs_url=None, redoc_url=None, openapi_url=None)
    st = app.state
    st.hub = Hub()
    st.pairing = pairing or PairingStore()
    st.port = port
    st.tls = tls
    st.ips = ips if ips is not None else lan_ips()
    st.trusted_hosts = set()  # hosts adicionales de confianza (solo para pruebas)
    st.max_message_bytes = max_message_bytes
    if data_dir is None:
        data_dir = Path(__file__).resolve().parents[1] / "data"
    st.data_dir = Path(data_dir)
    st.evidencias_dir = st.data_dir / "evidencias"
    st.evidencias_dir.mkdir(parents=True, exist_ok=True)
    cleanup_stale_temp_evidencias(st.evidencias_dir, max_age_seconds=3600.0)

    def trusted(host: str | None) -> bool:
        return is_loopback(host) or (host in st.trusted_hosts)

    def require_local(request: Request) -> None:
        host = request.client.host if request.client else None
        if not trusted(host):
            raise HTTPException(status_code=403, detail="Solo desde la PC de la tienda.")

    def verify_access(request: Request) -> None:
        host = request.client.host if request.client else None
        if trusted(host):
            return
        token = request.headers.get("x-lansync-token")
        if not token or not st.pairing.valid(token):
            raise HTTPException(status_code=401, detail="Token no válido o ausente")

    def pairing_url(token: str) -> str:
        scheme = "https" if st.tls else "http"
        ip = st.ips[0] if st.ips else "localhost"
        return f"{scheme}://{ip}:{st.port}/movil-prototipo.html?t={token}"

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        path = request.url.path
        if path.startswith("/vendor/"):
            response.headers["Cache-Control"] = "public, max-age=604800"
        elif path.startswith("/api/evidencia"):
            response.headers["Cache-Control"] = "private"
        elif path.startswith("/api/") or path == "/vincular":
            response.headers["Cache-Control"] = "no-store"
        return response

    # ---------------------------- API ----------------------------
    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True}

    @app.get("/api/status", dependencies=[Depends(require_local)])
    async def status() -> dict:
        p = st.hub.presence()
        return {"pc": p["pc"], "phones": p["phones"], "ips": st.ips, "port": st.port, "tls": st.tls}

    @app.get("/api/pairing", dependencies=[Depends(require_local)])
    async def get_pairing() -> dict:
        token, exp = st.pairing.current()
        return {"token": token, "expiresAt": exp, "url": pairing_url(token)}

    @app.post("/api/pairing/rotate", dependencies=[Depends(require_local)])
    async def rotate_pairing() -> dict:
        token, exp = st.pairing.rotate()
        await st.hub.drop_phones()
        return {"token": token, "expiresAt": exp, "url": pairing_url(token)}

    @app.get("/api/pairing/qr.svg", dependencies=[Depends(require_local)])
    async def get_pairing_qr_svg() -> Response:
        token, _ = st.pairing.current()
        url = pairing_url(token)
        svg = segno.make(url, error="m").svg_inline(scale=7, border=2, dark="#0f172a")
        return Response(
            content=svg,
            media_type="image/svg+xml",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/vincular", response_class=HTMLResponse, dependencies=[Depends(require_local)])
    async def vincular() -> str:
        token, _ = st.pairing.current()
        url = pairing_url(token)
        svg = segno.make(url, error="m").svg_inline(scale=7, border=2, dark="#0f172a")
        no_net = "" if st.ips else (
            '<p class="warn">No se detectó una red. Conecta la PC al Wi-Fi de la tienda '
            "(sirve aunque no tenga internet) o activa la zona Wi-Fi del celular.</p>"
        )
        return _VINCULAR_HTML.format(svg=svg, url=url, no_net=no_net)

    @app.post("/api/evidencia")
    async def upload_evidencia(request: Request) -> dict:
        verify_access(request)

        cl_header = request.headers.get("content-length")
        if cl_header:
            try:
                if int(cl_header) > MAX_EVIDENCIA_BYTES:
                    raise HTTPException(status_code=413, detail="Excede el límite de 5 MB")
            except ValueError:
                pass

        raw_ct = request.headers.get("content-type") or ""
        ct = raw_ct.split(";")[0].strip().lower()
        if ct not in ("image/jpeg", "image/png", "image/webp"):
            raise HTTPException(status_code=415, detail="Tipo de contenido no soportado")

        temp_name = f".tmp_{uuid.uuid4().hex}"
        temp_path = st.evidencias_dir / temp_name
        total_bytes = 0
        hasher = hashlib.sha256()

        try:
            with temp_path.open("wb") as f:
                async for chunk in request.stream():
                    total_bytes += len(chunk)
                    if total_bytes > MAX_EVIDENCIA_BYTES:
                        raise HTTPException(status_code=413, detail="Excede el límite de 5 MB")
                    f.write(chunk)
                    hasher.update(chunk)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

        if total_bytes == 0:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Archivo vacío")

        try:
            with temp_path.open("rb") as f:
                head = f.read(16)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Error al verificar firma")

        valid = False
        if ct == "image/jpeg" and head.startswith(b"\xff\xd8\xff"):
            valid = True
        elif ct == "image/png" and head.startswith(b"\x89PNG\r\n\x1a\n"):
            valid = True
        elif ct == "image/webp" and len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            valid = True

        if not valid:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Firma de imagen inválida")

        evidence_id = uuid.uuid4().hex
        final_path = st.evidencias_dir / evidence_id
        temp_path.replace(final_path)

        return {
            "id": evidence_id,
            "bytes": total_bytes,
            "sha256": hasher.hexdigest(),
        }

    @app.get("/api/evidencia/{id:path}")
    async def get_evidencia(id: str, request: Request) -> Response:
        if not EVIDENCE_ID_RE.match(id):
            raise HTTPException(status_code=400, detail="ID de evidencia inválido")

        verify_access(request)

        target_path = (st.evidencias_dir / id).resolve()
        if target_path.parent != st.evidencias_dir.resolve() or not target_path.is_file():
            raise HTTPException(status_code=404, detail="Evidencia no encontrada")

        data = target_path.read_bytes()

        if data.startswith(b"\xff\xd8\xff"):
            media_type = "image/jpeg"
        elif data.startswith(b"\x89PNG\r\n\x1a\n"):
            media_type = "image/png"
        elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            media_type = "image/webp"
        else:
            media_type = "application/octet-stream"

        return Response(
            content=data,
            media_type=media_type,
            headers={
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private",
            },
        )

    # ---------------------------- WebSocket ----------------------------
    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        host = ws.client.host if ws.client else None
        is_trusted = trusted(host)
        origin = ws.headers.get("origin")
        if origin and not _same_origin(origin, ws.headers.get("host")):
            await ws.close(code=CLOSE_FORBIDDEN_ORIGIN)
            return
        await ws.accept()

        if is_trusted:
            role = "phone" if ws.query_params.get("role") == "phone" else "pc"
        else:
            role = "phone"
            try:
                first = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=AUTH_TIMEOUT_SECONDS))
            except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
                await _safe_close(ws, CLOSE_UNAUTHORIZED)
                return
            if not (isinstance(first, dict) and first.get("t") == "auth" and st.pairing.valid(first.get("token"))):
                await _safe_close(ws, CLOSE_UNAUTHORIZED)
                return

        client = Client(id=uuid.uuid4().hex[:8], ws=ws, role=role)
        await ws.send_text(json.dumps({"t": "hello", "id": client.id, "role": role}))
        await st.hub.add(client)
        try:
            while True:
                raw = await ws.receive_text()
                if len(raw.encode("utf-8")) > st.max_message_bytes:
                    await _safe_close(ws, CLOSE_TOO_BIG)
                    break
                if not client.allow():
                    await _safe_close(ws, CLOSE_RATE_LIMIT)
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    await ws.send_text(json.dumps({"t": "error", "reason": "json"}))
                    continue
                kind = msg.get("t") if isinstance(msg, dict) else None
                if kind == "ping":
                    await ws.send_text('{"t":"pong"}')
                elif kind == "msg":
                    ch = msg.get("ch")
                    if not isinstance(ch, str) or not ch or len(ch) > CHANNEL_NAME_MAX or "data" not in msg:
                        await ws.send_text(json.dumps({"t": "error", "reason": "mensaje inválido"}))
                        continue
                    await st.hub.relay(client, ch, msg["data"])
                # "auth" repetido y tipos desconocidos se ignoran
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await st.hub.remove(client)

    # ---------------------------- Archivos estáticos ----------------------------
    if static_dir is not None and Path(static_dir).is_dir():
        app.mount("/", SPAStaticFiles(directory=str(static_dir), html=True), name="app")
    else:
        @app.get("/", response_class=HTMLResponse)
        async def no_build() -> str:
            return (
                "<meta charset='utf-8'><h2>Falta compilar la app</h2>"
                "<p>Ejecuta <code>npm run build</code> dentro de <code>abarrotes-app</code> "
                "o indica la carpeta con <code>--static</code>.</p>"
                "<p><a href='/vincular'>Vincular celular</a></p>"
            )

    return app


async def _safe_close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


_VINCULAR_HTML = """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vincular celular</title>
<style>
 body{{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:24px;display:flex;justify-content:center}}
 main{{max-width:760px;width:100%;background:#fff;border-radius:20px;padding:28px;box-shadow:0 6px 24px rgba(15,23,42,.12)}}
 h1{{margin:0 0 6px;font-size:28px}} .sub{{color:#475569;margin:0 0 18px;font-size:18px}}
 .grid{{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}}
 .qr{{background:#fff;border:3px solid #0f172a;border-radius:16px;padding:10px}} .qr svg{{display:block;width:260px;height:260px}}
 ol{{font-size:19px;line-height:1.5;padding-left:22px;margin:0;flex:1;min-width:260px}} li{{margin-bottom:10px}}
 .status{{margin-top:22px;border-radius:14px;padding:16px 18px;font-size:20px;font-weight:700}}
 .off{{background:#fef3c7;color:#92400e}} .on{{background:#dcfce7;color:#166534}}
 .url{{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all;color:#475569;margin-top:16px}}
 button{{margin-top:16px;min-height:52px;padding:0 20px;font-size:17px;font-weight:700;border-radius:12px;border:2px solid #94a3b8;background:#fff;cursor:pointer}}
 .warn{{background:#fee2e2;color:#991b1b;border-radius:12px;padding:12px 14px;font-weight:600}}
</style></head><body><main>
<h1>Vincular celular</h1><p class="sub">Convierte tu celular en el escáner de la tienda.</p>
{no_net}
<div class="grid"><div class="qr">{svg}</div>
<ol>
 <li>Conecta el celular al <b>mismo Wi-Fi</b> que esta computadora (sirve aunque el Wi-Fi no tenga internet).</li>
 <li>Abre la <b>cámara</b> del celular y apunta al código.</li>
 <li>Si aparece una advertencia de seguridad, toca <b>Avanzado</b> y luego <b>Continuar</b>. Es normal: el certificado lo creó esta misma computadora.</li>
</ol></div>
<div id="st" class="status off">Esperando celular…</div>
<div class="url">{url}</div>
<button id="rot">Generar código nuevo (desvincula los celulares)</button>
</main>
<script>
async function poll(){{
  try{{
    const r=await fetch('/api/status',{{cache:'no-store'}}); const s=await r.json(); const el=document.getElementById('st');
    if(s.phones>0){{el.className='status on';el.textContent='Celular enlazado ('+s.phones+')';}}
    else{{el.className='status off';el.textContent='Esperando celular…';}}
  }}catch(e){{}}
}}
setInterval(poll,2000);poll();
document.getElementById('rot').onclick=async()=>{{
  if(!confirm('Se desvincularán los celulares actuales. ¿Continuar?'))return;
  await fetch('/api/pairing/rotate',{{method:'POST'}});location.reload();
}};
</script></body></html>
"""


def main(argv: list[str] | None = None) -> None:
    import argparse

    import uvicorn

    from .tls import ensure_cert

    root = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser(description="Servidor local de enlace PC-celular")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--static", default=str(root / "abarrotes-app" / "dist" / "abarrotes-app" / "browser"))
    ap.add_argument("--cert-dir", default=str(root / "local-server" / "certs"))
    ap.add_argument("--data-dir", default=str(root / "local-server" / "data"), help="donde se guarda el código de vinculación")
    ap.add_argument("--no-tls", action="store_true", help="HTTP simple (la cámara en vivo del celular no funcionará)")
    args = ap.parse_args(argv)

    ips = lan_ips()
    pairing = PairingStore(path=Path(args.data_dir) / "pairing.json")
    app = create_app(Path(args.static), port=args.port, tls=not args.no_tls, ips=ips, pairing=pairing, data_dir=Path(args.data_dir))
    kw: dict = {}
    if not args.no_tls:
        cert, key = ensure_cert(Path(args.cert_dir), ips)
        kw = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    scheme = "http" if args.no_tls else "https"
    print("\n  Servidor de la tienda en marcha")
    print(f"  En esta PC:      {scheme}://localhost:{args.port}/")
    print(f"  Vincular celular: {scheme}://localhost:{args.port}/vincular")
    if ips:
        print(f"  Red local:       {scheme}://{ips[0]}:{args.port}/")
    else:
        print("  (No se detectó red local: conecta la PC al Wi-Fi)")
    print("  Cierra esta ventana para detener el servidor.\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", access_log=False,
                ws_max_size=MAX_MESSAGE_BYTES, **kw)
