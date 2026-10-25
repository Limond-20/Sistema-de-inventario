"""Prueba de extremo a extremo con el servidor REAL (uvicorn + TLS) y conexiones por red.

La "PC" se conecta por 127.0.0.1 y el "celular" por la IP de la red local, que el servidor ve como
un dispositivo ajeno (necesita el código del QR), igual que ocurre con un teléfono de verdad.
"""
import asyncio
import json
import socket
import ssl
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
import websockets

from lansync.netinfo import lan_ips

ROOT = Path(__file__).resolve().parents[1]
LAN = (lan_ips() or [None])[0]
pytestmark = pytest.mark.skipif(LAN is None, reason="sin IP de red local en esta máquina")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    base = tmp_path_factory.mktemp("e2e")
    static = base / "web"
    static.mkdir()
    (static / "index.html").write_text("<html>INDEX</html>")
    (static / "movil-prototipo.html").write_text("<html>MOVIL</html>")
    port = _free_port()
    certs = base / "certs"
    data = base / "data"
    proc = subprocess.Popen(
        [sys.executable, "-m", "lansync", "--port", str(port), "--static", str(static), "--cert-dir", str(certs), "--data-dir", str(data)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base_url = f"https://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(base_url + "/api/health", verify=False, timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("el servidor no arrancó:\n" + (proc.stdout.read() if proc.stdout else ""))
    yield {"port": port, "certs": certs}
    proc.terminate()
    proc.wait(timeout=10)


def _insecure():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def test_http_desde_la_pc_y_desde_la_red(server):
    p = server["port"]
    local = httpx.get(f"https://127.0.0.1:{p}/api/pairing", verify=False)
    assert local.status_code == 200
    data = local.json()
    assert data["url"].startswith(f"https://{LAN}:{p}/movil-prototipo.html?t=")
    # el "celular" (IP de la red) NO puede pedir el código de vinculación
    assert httpx.get(f"https://{LAN}:{p}/api/pairing", verify=False).status_code == 403
    assert httpx.get(f"https://{LAN}:{p}/vincular", verify=False).status_code == 403
    # pero sí puede cargar la app y la página móvil
    assert "INDEX" in httpx.get(f"https://{LAN}:{p}/recepcion", verify=False).text
    assert "MOVIL" in httpx.get(f"https://{LAN}:{p}/movil-prototipo.html", verify=False).text


def test_certificado_valido_para_la_ip_de_la_red(server):
    """Con el certificado de la tienda como autoridad, el navegador no debería rechazar la IP."""
    ctx = ssl.create_default_context(cafile=str(server["certs"] / "server.crt"))
    r = httpx.get(f"https://{LAN}:{server['port']}/api/health", verify=ctx)
    assert r.json() == {"ok": True}


def test_pc_y_celular_se_hablan_por_la_red(server):
    p = server["port"]
    token = httpx.get(f"https://127.0.0.1:{p}/api/pairing", verify=False).json()["token"]

    async def go():
        async with websockets.connect(f"wss://127.0.0.1:{p}/ws", ssl=_insecure()) as pc:
            assert json.loads(await pc.recv())["role"] == "pc"
            assert json.loads(await pc.recv()) == {"t": "presence", "pc": True, "phones": 0}
            async with websockets.connect(f"wss://{LAN}:{p}/ws", ssl=_insecure()) as phone:
                await phone.send(json.dumps({"t": "auth", "token": token}))
                assert json.loads(await phone.recv())["role"] == "phone"
                assert json.loads(await phone.recv())["t"] == "presence"
                assert json.loads(await pc.recv())["phones"] == 1

                scan = {"type": "BARCODE_SCANNED", "barcode": "7501020515350"}
                await phone.send(json.dumps({"t": "msg", "ch": "abarrotes_lan_sync", "data": scan}))
                got = json.loads(await asyncio.wait_for(pc.recv(), 3))
                assert got["data"] == scan and got["from"] == "phone"

                ocr = {"type": "OCR_TICKET_PARSED", "folio": "OCR-1", "lines": [{"sku": "A", "qty": 2}], "rawText": "x" * 50000}
                await pc.send(json.dumps({"t": "msg", "ch": "abarrotes_lan_sync", "data": ocr}))
                got = json.loads(await asyncio.wait_for(phone.recv(), 3))
                assert got["data"]["folio"] == "OCR-1" and len(got["data"]["rawText"]) == 50000

    asyncio.run(go())


def test_celular_con_codigo_falso_es_expulsado(server):
    async def go():
        async with websockets.connect(f"wss://{LAN}:{server['port']}/ws", ssl=_insecure()) as ws:
            await ws.send(json.dumps({"t": "auth", "token": "adivinando"}))
            with pytest.raises(websockets.ConnectionClosed) as e:
                await asyncio.wait_for(ws.recv(), 3)
            assert e.value.rcvd.code == 4401

    asyncio.run(go())


def test_sitio_ajeno_no_puede_conectarse_a_la_pc(server):
    """Un sitio web abierto en la PC no debe poder usar el WebSocket de la tienda."""
    async def go():
        with pytest.raises(Exception):
            async with websockets.connect(
                f"wss://127.0.0.1:{server['port']}/ws", ssl=_insecure(), origin="https://sitio-malo.example"
            ) as ws:
                await ws.recv()

    asyncio.run(go())


def test_celular_que_no_se_autentica_es_cerrado_por_tiempo(server):
    async def go():
        async with websockets.connect(f"wss://{LAN}:{server['port']}/ws", ssl=_insecure()) as ws:
            with pytest.raises(websockets.ConnectionClosed) as e:
                await asyncio.wait_for(ws.recv(), 8)
            assert e.value.rcvd.code == 4401

    t0 = time.time()
    asyncio.run(go())
    assert 4 < time.time() - t0 < 8


def test_subida_evidencia_por_red_real(server):
    """El celular sube una foto por la IP de la red local y la PC la ve por loopback."""
    p = server["port"]
    token = httpx.get(f"https://127.0.0.1:{p}/api/pairing", verify=False).json()["token"]
    jpeg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x12" * 50

    # 1. El celular sube por la IP externa con su token
    upload_res = httpx.post(
        f"https://{LAN}:{p}/api/evidencia",
        content=jpeg_bytes,
        headers={"Content-Type": "image/jpeg", "X-Lansync-Token": token},
        verify=False,
    )
    assert upload_res.status_code == 200
    res_data = upload_res.json()
    evidence_id = res_data["id"]
    assert len(evidence_id) == 32
    assert res_data["bytes"] == len(jpeg_bytes)

    # 2. La PC descarga por localhost (sin token)
    pc_res = httpx.get(f"https://127.0.0.1:{p}/api/evidencia/{evidence_id}", verify=False)
    assert pc_res.status_code == 200
    assert pc_res.content == jpeg_bytes
    assert pc_res.headers["cache-control"] == "private"
    assert pc_res.headers["x-content-type-options"] == "nosniff"

