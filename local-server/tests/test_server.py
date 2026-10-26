import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from lansync.pairing import PairingStore
from lansync.server import create_app


@pytest.fixture()
def app(tmp_path):
    (tmp_path / "index.html").write_text("<html>INDEX</html>")
    (tmp_path / "movil-prototipo.html").write_text("<html>MOVIL</html>")
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor" / "lib.js").write_text("x=1")
    data_dir = tmp_path / "data"
    pairing = PairingStore(path=data_dir / "pairing.json")
    a = create_app(tmp_path, port=8443, tls=True, ips=["192.168.1.70"], pairing=pairing, data_dir=data_dir)
    return a


@pytest.fixture()
def local_app(app):
    """La PC de la tienda: 'testclient' cuenta como loopback."""
    app.state.trusted_hosts.add("testclient")
    return app


@pytest.fixture()
def client(app):
    with TestClient(app) as c:  # un solo ciclo de eventos para todas las conexiones, como uvicorn
        yield c


@pytest.fixture()
def local_client(local_app):
    with TestClient(local_app) as c:
        yield c


def test_health_y_cabeceras(app, client):
    c = client
    r = c.get("/api/health")
    assert r.json() == {"ok": True}
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"


def test_endpoints_locales_prohibidos_desde_otro_dispositivo(app, client):
    c = client  # 'testclient' no es loopback => es "otro dispositivo"
    for path in ("/api/pairing", "/api/pairing/qr.svg", "/api/status", "/vincular"):
        assert c.get(path).status_code == 403
    assert c.post("/api/pairing/rotate").status_code == 403


def test_pairing_desde_la_pc(local_app, local_client):
    c = local_client
    d = c.get("/api/pairing").json()
    assert d["url"].startswith("https://192.168.1.70:8443/movil-prototipo.html?t=")
    assert d["url"].endswith(d["token"])
    assert c.get("/api/pairing").json()["token"] == d["token"]  # estable hasta rotar


def test_pairing_qr_svg_desde_la_pc(local_app, local_client):
    res = local_client.get("/api/pairing/qr.svg")
    assert res.status_code == 200
    assert "image/svg+xml" in res.headers["content-type"]
    assert "no-store" in res.headers.get("cache-control", "")
    assert "<svg" in res.text and "</svg>" in res.text


def test_pairing_qr_svg_cambia_al_rotar(local_app, local_client):
    c = local_client
    svg1 = c.get("/api/pairing/qr.svg").text
    c.post("/api/pairing/rotate")
    svg2 = c.get("/api/pairing/qr.svg").text
    assert "<svg" in svg1 and "<svg" in svg2
    assert svg1 != svg2


def test_pairing_con_parametro_ip_valida(local_app, local_client):
    c = local_client
    res = c.get("/api/pairing?ip=192.168.1.70")
    assert res.status_code == 200
    assert "https://192.168.1.70:8443/movil-prototipo.html?t=" in res.json()["url"]

    res_qr = c.get("/api/pairing/qr.svg?ip=192.168.1.70&nocache=123")
    assert res_qr.status_code == 200
    assert "<svg" in res_qr.text


def test_pairing_con_parametro_ip_invalida_rechaza_400(local_app, local_client):
    c = local_client
    res = c.get("/api/pairing?ip=10.99.99.99")
    assert res.status_code == 400
    assert "IP no válida" in res.text

    res_qr = c.get("/api/pairing/qr.svg?ip=10.99.99.99&nocache=123")
    assert res_qr.status_code == 400
    assert "IP no válida" in res_qr.text


def test_vincular_muestra_qr(local_app, local_client):
    html = TestClient(local_app).get("/vincular").text
    assert "<svg" in html and "movil-prototipo.html?t=" in html


def test_spa_fallback_y_estaticos(app, client):
    c = client
    assert "INDEX" in c.get("/").text
    assert "INDEX" in c.get("/recepcion").text           # ruta interna de Angular
    assert "MOVIL" in c.get("/movil-prototipo.html").text
    assert c.get("/vendor/lib.js").headers["cache-control"].startswith("public")
    assert c.get("/falta.js").status_code == 404           # un archivo inexistente NO devuelve index


def _phone_token(app):
    return app.state.pairing.current()[0]


def test_celular_sin_codigo_es_rechazado(app, client):
    c = client
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"t": "auth", "token": "falso"}))
            ws.receive_text()
    assert e.value.code == 4401


def test_celular_con_primer_mensaje_que_no_es_auth_es_rechazado(app, client):
    c = client
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"t": "msg", "ch": "x", "data": 1}))
            ws.receive_text()
    assert e.value.code == 4401


def test_relevo_celular_a_pc_sin_eco_y_presencia(local_app, local_client):
    # La PC y el celular comparten host 'testclient' en la prueba: el celular entra con role=phone + auth
    c = local_client
    with c.websocket_connect("/ws") as pc:
        hello = json.loads(pc.receive_text())
        assert hello["t"] == "hello" and hello["role"] == "pc"
        assert json.loads(pc.receive_text()) == {"t": "presence", "pc": True, "phones": 0}

        with c.websocket_connect("/ws?role=phone") as phone:
            assert json.loads(phone.receive_text())["role"] == "phone"
            assert json.loads(pc.receive_text()) == {"t": "presence", "pc": True, "phones": 1}
            assert json.loads(phone.receive_text())["phones"] == 1

            payload = {"type": "BARCODE_SCANNED", "barcode": "7501020515350"}
            phone.send_text(json.dumps({"t": "msg", "ch": "abarrotes_lan_sync", "data": payload}))
            got = json.loads(pc.receive_text())
            assert got == {"t": "msg", "ch": "abarrotes_lan_sync", "data": payload, "from": "phone"}

            # y de PC a celular
            pc.send_text(json.dumps({"t": "msg", "ch": "abarrotes_lan_sync", "data": {"type": "X"}}))
            assert json.loads(phone.receive_text())["data"] == {"type": "X"}

            # sin eco: el emisor no recibe su propio mensaje (lo comprobamos con un ping)
            phone.send_text('{"t":"ping"}')
            assert json.loads(phone.receive_text()) == {"t": "pong"}
        assert json.loads(pc.receive_text()) == {"t": "presence", "pc": True, "phones": 0}


def test_celular_remoto_autenticado_recibe_y_envia(app, client):
    # 'testclient' NO es de confianza => debe autenticarse con el código del QR
    c = client
    with c.websocket_connect("/ws") as phone:
        phone.send_text(json.dumps({"t": "auth", "token": _phone_token(app)}))
        h = json.loads(phone.receive_text())
        assert h["t"] == "hello" and h["role"] == "phone"


def test_mensajes_invalidos_no_rompen_la_conexion(local_app, local_client):
    c = local_client
    with c.websocket_connect("/ws") as ws:
        ws.receive_text(); ws.receive_text()
        ws.send_text("esto no es json")
        assert json.loads(ws.receive_text())["t"] == "error"
        ws.send_text(json.dumps({"t": "msg", "ch": "", "data": 1}))
        assert json.loads(ws.receive_text())["t"] == "error"
        ws.send_text(json.dumps({"t": "msg", "ch": "a" * 200, "data": 1}))
        assert json.loads(ws.receive_text())["t"] == "error"
        ws.send_text('{"t":"ping"}')
        assert json.loads(ws.receive_text()) == {"t": "pong"}


def test_mensaje_demasiado_grande_cierra(tmp_path):
    app = create_app(None, ips=[], max_message_bytes=1000)
    app.state.trusted_hosts.add("testclient")
    with TestClient(app) as c:
        with pytest.raises(WebSocketDisconnect) as e:
            with c.websocket_connect("/ws") as ws:
                ws.receive_text(); ws.receive_text()
                ws.send_text(json.dumps({"t": "msg", "ch": "x", "data": "a" * 5000}))
                ws.receive_text()
    assert e.value.code == 1009


def test_limite_de_mensajes_por_segundo(local_app, local_client):
    c = local_client
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/ws") as ws:
            ws.receive_text(); ws.receive_text()
            for _ in range(80):
                ws.send_text('{"t":"ping"}')
            for _ in range(80):
                ws.receive_text()
    assert e.value.code == 4429


def test_origen_ajeno_es_rechazado(local_app, local_client):
    c = local_client
    with pytest.raises(Exception):
        with c.websocket_connect("/ws", headers={"origin": "https://sitio-malo.example", "host": "localhost:8443"}):
            pass
    # mismo origen: permitido
    with c.websocket_connect("/ws", headers={"origin": "https://localhost:8443", "host": "localhost:8443"}) as ws:
        assert json.loads(ws.receive_text())["t"] == "hello"


def test_rotar_codigo_desconecta_celulares_y_anula_el_viejo(local_app, local_client):
    c = local_client
    viejo = c.get("/api/pairing").json()["token"]
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/ws?role=phone") as phone:
            phone.receive_text(); phone.receive_text()
            nuevo = c.post("/api/pairing/rotate").json()["token"]
            assert nuevo != viejo
            phone.receive_text()  # recibe el cierre
    assert not local_app.state.pairing.valid(viejo)
    assert local_app.state.pairing.valid(nuevo)


def test_codigo_vence():
    t = [1000.0]
    store = PairingStore(ttl_seconds=60, clock=lambda: t[0])
    tok, _ = store.current()
    assert store.valid(tok)
    t[0] += 61
    assert not store.valid(tok)
    assert store.current()[0] != tok
    assert not store.valid(None) and not store.valid("") and not store.valid(123)


def test_codigo_sobrevive_reinicios_y_rotar_lo_reemplaza(tmp_path):
    f = tmp_path / "datos" / "pairing.json"
    a = PairingStore(path=f)
    tok, _ = a.current()
    assert PairingStore(path=f).valid(tok)              # "reinicio": mismo código
    assert PairingStore(path=f).current()[0] == tok
    nuevo, _ = a.rotate()
    b = PairingStore(path=f)
    assert b.valid(nuevo) and not b.valid(tok)
    # archivo dañado o vencido: se ignora sin romper
    f.write_text("no es json")
    assert PairingStore(path=f).current()[0]
    f.unlink()
    t = [0.0]
    c = PairingStore(ttl_seconds=10, clock=lambda: t[0], path=f)
    tok2, _ = c.current()
    t[0] = 11.0
    assert not PairingStore(ttl_seconds=10, clock=lambda: t[0], path=f).valid(tok2)


def test_subida_evidencia_valida_y_descarga(local_app, local_client):
    c = local_client
    jpeg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 40
    r = c.post("/api/evidencia", content=jpeg_bytes, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 200
    res = r.json()
    assert "id" in res and len(res["id"]) == 32
    assert res["bytes"] == len(jpeg_bytes)
    assert "sha256" in res

    # Descarga desde loopback (PC)
    r_get = c.get(f"/api/evidencia/{res['id']}")
    assert r_get.status_code == 200
    assert r_get.content == jpeg_bytes
    assert r_get.headers["x-content-type-options"] == "nosniff"
    assert r_get.headers["cache-control"] == "private"
    assert r_get.headers["content-type"].startswith("image/jpeg")


def test_subida_evidencia_png_y_webp(app, client):
    token = _phone_token(app)
    c = client
    # PNG
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 30
    r_png = c.post(
        "/api/evidencia",
        content=png_bytes,
        headers={"Content-Type": "image/png", "X-Lansync-Token": token},
    )
    assert r_png.status_code == 200
    png_id = r_png.json()["id"]
    get_png = c.get(f"/api/evidencia/{png_id}", headers={"X-Lansync-Token": token})
    assert get_png.status_code == 200
    assert get_png.headers["content-type"].startswith("image/png")

    # WebP
    webp_bytes = b"RIFF\x18\x00\x00\x00WEBPVP8 " + b"\x00" * 20
    r_webp = c.post(
        "/api/evidencia",
        content=webp_bytes,
        headers={"Content-Type": "image/webp", "X-Lansync-Token": token},
    )
    assert r_webp.status_code == 200
    webp_id = r_webp.json()["id"]
    get_webp = c.get(f"/api/evidencia/{webp_id}", headers={"X-Lansync-Token": token})
    assert get_webp.status_code == 200
    assert get_webp.headers["content-type"].startswith("image/webp")


def test_subida_evidencia_tipo_falso(local_client):
    c = local_client
    html_bytes = b"<!DOCTYPE html><html><body><h1>Fake</h1></body></html>"
    r = c.post("/api/evidencia", content=html_bytes, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 400
    assert "Firma" in r.text or "inválida" in r.text


def test_subida_evidencia_content_type_no_soportado(local_client):
    c = local_client
    jpeg_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 30
    r = c.post("/api/evidencia", content=jpeg_bytes, headers={"Content-Type": "text/plain"})
    assert r.status_code == 415


def test_subida_evidencia_excede_5mb_content_length(local_client):
    c = local_client
    r = c.post(
        "/api/evidencia",
        content=b"\xff\xd8\xff\xe0",
        headers={"Content-Type": "image/jpeg", "Content-Length": str(5 * 1024 * 1024 + 10)},
    )
    assert r.status_code == 413


def test_subida_evidencia_excede_5mb_streaming(local_client):
    c = local_client
    big_body = b"\xff\xd8\xff\xe0" + (b"\x00" * (5 * 1024 * 1024 + 100))
    r = c.post("/api/evidencia", content=big_body, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 413


def test_subida_evidencia_sin_token_rechaza_sin_leer(client):
    c = client  # cliente ajeno (no loopback)
    big_body = b"\xff\xd8\xff\xe0" + (b"\x00" * (6 * 1024 * 1024))
    r = c.post("/api/evidencia", content=big_body, headers={"Content-Type": "image/jpeg"})
    # Debe ser 401 ANTES de evaluar Content-Length o leer streaming
    assert r.status_code == 401


def test_subida_evidencia_token_falso(client):
    c = client
    jpeg_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 20
    r = c.post(
        "/api/evidencia",
        content=jpeg_bytes,
        headers={"Content-Type": "image/jpeg", "X-Lansync-Token": "token-falso-invalido"},
    )
    assert r.status_code == 401


def test_get_evidencia_path_traversal_y_formatos(local_app, local_client):
    c = local_client
    # Path traversal con %2e%2e%2f
    assert c.get("/api/evidencia/%2e%2e%2fsecret").status_code in (400, 404)

    # Longitud 31
    assert c.get("/api/evidencia/" + ("a" * 31)).status_code == 400

    # Longitud 33
    assert c.get("/api/evidencia/" + ("a" * 33)).status_code == 400

    # Mayúsculas
    assert c.get("/api/evidencia/" + ("a" * 31 + "F")).status_code == 400

    # ID válido inexistente
    assert c.get("/api/evidencia/" + ("0" * 32)).status_code == 404


def test_get_evidencia_sin_token_rechaza(app, client):
    # GET sin token desde cliente externo
    assert client.get("/api/evidencia/" + ("0" * 32)).status_code == 401


def test_no_quedan_temporales_tras_rechazo_por_tamano(local_app, local_client):
    c = local_client
    ev_dir = local_app.state.evidencias_dir
    big_body = b"\xff\xd8\xff\xe0" + (b"\x00" * (5 * 1024 * 1024 + 200))
    r = c.post("/api/evidencia", content=big_body, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 413
    assert list(ev_dir.glob(".tmp_*")) == [], "No deben quedar archivos .tmp_* tras rechazo por tamaño"


def test_no_quedan_temporales_tras_rechazo_por_firma(local_app, local_client):
    c = local_client
    ev_dir = local_app.state.evidencias_dir
    bad_body = b"<html><body>No es imagen</body></html>"
    r = c.post("/api/evidencia", content=bad_body, headers={"Content-Type": "image/jpeg"})
    assert r.status_code == 400
    assert list(ev_dir.glob(".tmp_*")) == [], "No deben quedar archivos .tmp_* tras rechazo por firma"


def test_no_quedan_temporales_tras_corte_de_conexion(local_app, local_client):
    c = local_client
    ev_dir = local_app.state.evidencias_dir

    def stream_con_corte():
        yield b"\xff\xd8\xff\xe0"
        yield b"\x00" * 1024
        raise ConnectionResetError("Corte abrupto de red durante la subida")

    with pytest.raises(Exception):
        c.post("/api/evidencia", content=stream_con_corte(), headers={"Content-Type": "image/jpeg"})

    assert list(ev_dir.glob(".tmp_*")) == [], "No deben quedar archivos .tmp_* tras corte de conexión"


def test_arranque_borra_temporales_viejos(tmp_path):
    data_dir = tmp_path / "data"
    ev_dir = data_dir / "evidencias"
    ev_dir.mkdir(parents=True)

    old_tmp = ev_dir / ".tmp_viejo"
    old_tmp.write_bytes(b"viejo")
    # Poner mtime hace 2 horas (7200 s atrás)
    import os
    os.utime(old_tmp, (time.time() - 7200, time.time() - 7200))

    new_tmp = ev_dir / ".tmp_reciente"
    new_tmp.write_bytes(b"nuevo")
    # Poner mtime hace 10 minutos (600 s atrás)
    os.utime(new_tmp, (time.time() - 600, time.time() - 600))

    # Arrancar la app debe ejecutar la limpieza
    create_app(tmp_path, port=8443, data_dir=data_dir)

    assert not old_tmp.exists(), "El temporal de más de 1 hora debe ser eliminado"
    assert new_tmp.exists(), "El temporal reciente (<1h) debe conservarse"



