"""Pruebas de respaldo cifrado (Bloque E): AES-GCM + PBKDF2 (600,000 iteraciones), encabezado con AAD,
compatibilidad cruzada Python <-> TypeScript, validación estricta de nombre y prueba por red real."""
from __future__ import annotations

import json
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from lansync.backup import (
    PBKDF2_ITERATIONS,
    decrypt_backup_bytes,
    encrypt_backup_bytes,
    unpack_backup_header,
)
from lansync.pairing import PairingStore
from lansync.server import create_app


@pytest.fixture()
def app(tmp_path):
    (tmp_path / "index.html").write_text("<html>INDEX</html>")
    data_dir = tmp_path / "data"
    pairing = PairingStore(path=data_dir / "pairing.json")
    return create_app(tmp_path, port=8443, tls=True, ips=["192.168.1.70"], pairing=pairing, data_dir=data_dir)


@pytest.fixture()
def local_app(app):
    app.state.trusted_hosts.add("testclient")
    return app


@pytest.fixture()
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def local_client(local_app):
    with TestClient(local_app) as c:
        yield c


SAMPLE_STATE = {
    "schemaVersion": 2,
    "activeUser": "Don Lupe (Encargado)",
    "products": [{"sku": "LAC-LAL-1L", "name": "Leche Lala Entera 1L", "stock": 18, "salePrice": 26.0}],
    "kardex": [
        {
            "id": "K-1001",
            "sku": "LAC-LAL-1L",
            "previousHash": "GENESIS",
            "entryHash": "a1b2c3d4e5f6",
        }
    ],
}


def test_encabezado_pbkdf2_600k_y_aad():
    assert PBKDF2_ITERATIONS == 600_000
    raw_plain = json.dumps(SAMPLE_STATE).encode("utf-8")
    blob = encrypt_backup_bytes(raw_plain, "frase-600k-segura")
    hdr = unpack_backup_header(blob)
    assert hdr["version"] == 1
    assert hdr["kdf_id"] == 1
    assert hdr["cipher_id"] == 1
    assert hdr["iterations"] == 600_000
    assert len(hdr["salt"]) == 16
    assert len(hdr["nonce"]) == 12
    assert len(hdr["aad"]) == 28

    # Descifra correctamente leyendo los parámetros del encabezado
    assert json.loads(decrypt_backup_bytes(blob, "frase-600k-segura").decode("utf-8")) == SAMPLE_STATE


def test_respaldo_prohibido_desde_otro_dispositivo(client):
    assert client.get("/api/respaldo").status_code == 403
    assert client.post(
        "/api/respaldo",
        json=SAMPLE_STATE,
        headers={"X-Backup-Passphrase": "frase-segura-tienda"},
    ).status_code == 403
    assert client.post(
        "/api/respaldo/restaurar",
        json={},
        headers={"X-Backup-Passphrase": "frase-segura-tienda"},
    ).status_code == 403


def test_respaldar_listar_restaurar_y_no_guardar_frase(local_app, local_client):
    phrase = "dona-lupe-respaldo-2026"
    res = local_client.post(
        "/api/respaldo",
        json=SAMPLE_STATE,
        headers={"X-Backup-Passphrase": phrase},
    )
    assert res.status_code == 200
    meta = res.json()
    assert re.match(r"^[0-9]{8}-[0-9]{6}\.bak$", meta["nombre"])
    assert meta["tamano"] >= 56
    assert "fecha" in meta

    # Verificar archivo físico en data/respaldos/AAAAMMDD-HHMMSS.bak
    bak_path = local_app.state.respaldos_dir / meta["nombre"]
    assert bak_path.is_file()
    raw_bytes = bak_path.read_bytes()
    assert raw_bytes.startswith(b"BTBAK")
    assert b"Leche Lala" not in raw_bytes
    assert b"LAC-LAL-1L" not in raw_bytes
    assert phrase.encode("utf-8") not in raw_bytes

    # Verificar que no se guardó la frase en ningún archivo de data/
    for p in local_app.state.data_dir.rglob("*"):
        if p.is_file():
            assert phrase.encode("utf-8") not in p.read_bytes()

    # Listar respaldos
    list_res = local_client.get("/api/respaldo")
    assert list_res.status_code == 200
    items = list_res.json()
    assert len(items) == 1
    assert items[0]["nombre"] == meta["nombre"]
    assert items[0]["tamano"] == len(raw_bytes)
    assert items[0]["fecha"] == meta["fecha"]

    # Descargar .bak crudo (para copia a USB)
    dl_res = local_client.get(f"/api/respaldo/{meta['nombre']}")
    assert dl_res.status_code == 200
    assert dl_res.content == raw_bytes

    # Restaurar con frase correcta
    rest_res = local_client.post(
        "/api/respaldo/restaurar",
        json={"nombre": meta["nombre"]},
        headers={"X-Backup-Passphrase": phrase},
    )
    assert rest_res.status_code == 200
    assert rest_res.json() == SAMPLE_STATE


def test_get_respaldo_path_traversal_y_patron_estricto(local_client):
    """Valida GET /api/respaldo/{nombre} con ^[0-9]{8}-[0-9]{6}\\.bak$ y prueba con ../ y %2e%2e%2f."""
    # Path traversal con ../ y %2e%2e%2f
    assert local_client.get("/api/respaldo/../pairing.json").status_code in (400, 404)
    assert local_client.get("/api/respaldo/%2e%2e%2fpairing.json").status_code in (400, 404)
    assert local_client.get("/api/respaldo/%2e%2e%2f20261106-120000.bak").status_code in (400, 404)
    assert local_client.get("/api/respaldo/..%2f..%2fsecret.bak").status_code in (400, 404)

    # Nombres que no cumplen ^[0-9]{8}-[0-9]{6}\.bak$
    assert local_client.get("/api/respaldo/respaldo.bak").status_code == 400
    assert local_client.get("/api/respaldo/20261106-120000-01.bak").status_code == 400
    assert local_client.get("/api/respaldo/20261106-120000.json").status_code == 400

    # Nombre con formato válido pero inexistente -> 404
    assert local_client.get("/api/respaldo/20991231-235959.bak").status_code == 404


def test_frase_incorrecta_responde_403_sin_detalles(local_client):
    local_client.post(
        "/api/respaldo",
        json=SAMPLE_STATE,
        headers={"X-Backup-Passphrase": "frase-correcta-1234"},
    )

    wrong = local_client.post(
        "/api/respaldo/restaurar",
        json={},
        headers={"X-Backup-Passphrase": "frase-equivocada-9999"},
    )
    assert wrong.status_code == 403
    body = wrong.json()
    assert body == {"detail": "No autorizado"}


def test_archivo_manipulado_en_cuerpo_y_encabezado_aad_responde_403(local_app, local_client):
    phrase = "frase-integra-2026"
    r = local_client.post(
        "/api/respaldo",
        json=SAMPLE_STATE,
        headers={"X-Backup-Passphrase": phrase},
    )
    nombre = r.json()["nombre"]
    bak_path = local_app.state.respaldos_dir / nombre
    original = bytearray(bak_path.read_bytes())

    # 1. Alterar 1 bit en el cuerpo cifrado / tag GCM
    tampered_ct = bytearray(original)
    tampered_ct[-1] ^= 0x01
    bak_path.write_bytes(bytes(tampered_ct))

    res_ct = local_client.post(
        "/api/respaldo/restaurar",
        json={"nombre": nombre},
        headers={"X-Backup-Passphrase": phrase},
    )
    assert res_ct.status_code == 403
    assert res_ct.json() == {"detail": "No autorizado"}

    # 2. Alterar el parámetro de iteraciones en el encabezado (bytes 8..12, cubierto por AAD)
    tampered_iters = bytearray(original)
    tampered_iters[11] ^= 0x01
    bak_path.write_bytes(bytes(tampered_iters))

    res_iters = local_client.post(
        "/api/respaldo/restaurar",
        json={"nombre": nombre},
        headers={"X-Backup-Passphrase": phrase},
    )
    assert res_iters.status_code == 403
    assert res_iters.json() == {"detail": "No autorizado"}

    # 3. Alterar 1 bit en el salt (bytes 12..28, cubierto por AAD)
    tampered_salt = bytearray(original)
    tampered_salt[15] ^= 0x01
    bak_path.write_bytes(bytes(tampered_salt))

    res_salt = local_client.post(
        "/api/respaldo/restaurar",
        json={"nombre": nombre},
        headers={"X-Backup-Passphrase": phrase},
    )
    assert res_salt.status_code == 403
    assert res_salt.json() == {"detail": "No autorizado"}


def test_compatibilidad_cruzada_python_y_typescript(tmp_path):
    """Un .bak creado por el servidor Python se descifra con backup.ts y un .bak creado por backup.ts se descifra en Python."""
    repo_root = Path(__file__).resolve().parents[2]
    backup_ts = (repo_root / "abarrotes-app" / "src" / "app" / "domain" / "backup.ts").as_uri()
    phrase = "clave-cruzada-600k-2026"

    # 1. Cifrado en Python (600,000 iteraciones) -> Descifrado en TypeScript (backup.ts)
    py_bak_file = tmp_path / "from_python.bak"
    py_plaintext = json.dumps(SAMPLE_STATE, ensure_ascii=False).encode("utf-8")
    py_bak_file.write_bytes(encrypt_backup_bytes(py_plaintext, phrase, iterations=600_000))

    ts_bak_file = tmp_path / "from_typescript.bak"
    node_script = f"""
import {{ readFileSync, writeFileSync }} from 'node:fs';
import {{ decryptBackupBytes, encryptBackupBytes, unpackBackupHeader }} from '{backup_ts}';

const pyBlob = new Uint8Array(readFileSync({json.dumps(py_bak_file.as_posix())}));
const hdr = unpackBackupHeader(pyBlob);
if (hdr.iterations !== 600000 || hdr.version !== 1) {{
  throw new Error('Header mismatch in TS: ' + JSON.stringify(hdr));
}}
const decBytes = await decryptBackupBytes(pyBlob, {json.dumps(phrase)});
const decObj = JSON.parse(new TextDecoder().decode(decBytes));

// Ahora ciframos en TypeScript con 600,000 iteraciones y escribimos a disco para que Python lo descifre
const tsPlain = new TextEncoder().encode(JSON.stringify({{ ...decObj, roundtrip: 'ts-to-py' }}));
const tsEnc = await encryptBackupBytes(tsPlain, {json.dumps(phrase)}, 600000);
writeFileSync({json.dumps(ts_bak_file.as_posix())}, tsEnc);
console.log(JSON.stringify(decObj));
"""
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", node_script],
        capture_output=True,
        text=True,
        check=True,
    )
    decrypted_in_ts = json.loads(proc.stdout.strip())
    assert decrypted_in_ts == SAMPLE_STATE

    # 2. Descifrar en Python el archivo .bak generado por backup.ts
    ts_blob = ts_bak_file.read_bytes()
    ts_hdr = unpack_backup_header(ts_blob)
    assert ts_hdr["iterations"] == 600_000
    assert ts_hdr["version"] == 1
    decrypted_in_py = json.loads(decrypt_backup_bytes(ts_blob, phrase).decode("utf-8"))
    assert decrypted_in_py == {**SAMPLE_STATE, "roundtrip": "ts-to-py"}


def test_conserva_los_30_mas_recientes(local_app, local_client, monkeypatch):
    import lansync.backup as bmod
    monkeypatch.setattr(bmod, "PBKDF2_ITERATIONS", 1_000)

    phrase = "frase-rotacion-30"
    created_names = []
    for i in range(34):
        r = local_client.post(
            "/api/respaldo",
            json={"seq": i},
            headers={"X-Backup-Passphrase": phrase},
        )
        assert r.status_code == 200
        created_names.append(r.json()["nombre"])

    listed = local_client.get("/api/respaldo").json()
    assert len(listed) == 30
    disk_files = sorted(p.name for p in local_app.state.respaldos_dir.glob("*.bak"))
    assert len(disk_files) == 30
    assert set(disk_files) == set(created_names[-30:])


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_respaldo_por_red_real_completo(tmp_path):
    """Levanta uvicorn en un puerto TCP real de loopback y prueba respaldar, listar, restaurar, frase incorrecta y archivo manipulado."""
    port = _free_port()
    data_dir = tmp_path / "data_net"
    app = create_app(None, port=port, tls=False, ips=["127.0.0.1"], data_dir=data_dir)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base_url = f"http://127.0.0.1:{port}"
    try:
        with httpx.Client(base_url=base_url, timeout=15.0) as http:
            ready = False
            for _ in range(60):
                try:
                    if http.get("/api/health").status_code == 200:
                        ready = True
                        break
                except Exception:
                    time.sleep(0.05)
            assert ready, "El servidor uvicorn no levantó a tiempo"

            phrase = "frase-red-real-2026"
            # 1. Respaldar por red real
            r_save = http.post(
                "/api/respaldo",
                json=SAMPLE_STATE,
                headers={"X-Backup-Passphrase": phrase},
            )
            assert r_save.status_code == 200
            saved_meta = r_save.json()
            bak_name = saved_meta["nombre"]
            assert re.match(r"^[0-9]{8}-[0-9]{6}\.bak$", bak_name)

            # 2. Listar por red real
            r_list = http.get("/api/respaldo")
            assert r_list.status_code == 200
            backups = r_list.json()
            assert len(backups) == 1
            assert backups[0]["nombre"] == bak_name

            # 3. Restaurar por red real con frase correcta
            r_restore = http.post(
                "/api/respaldo/restaurar",
                json={"nombre": bak_name},
                headers={"X-Backup-Passphrase": phrase},
            )
            assert r_restore.status_code == 200
            assert r_restore.json() == SAMPLE_STATE

            # 4. Frase incorrecta por red real -> 403 sin detalles
            r_bad_phrase = http.post(
                "/api/respaldo/restaurar",
                json={"nombre": bak_name},
                headers={"X-Backup-Passphrase": "otra-frase-distinta"},
            )
            assert r_bad_phrase.status_code == 403
            assert r_bad_phrase.json() == {"detail": "No autorizado"}

            # 5. Manipular archivo .bak en disco y verificar rechazo 403 por red real
            bak_file = data_dir / "respaldos" / bak_name
            corrupted = bytearray(bak_file.read_bytes())
            corrupted[-4] ^= 0xFF
            bak_file.write_bytes(bytes(corrupted))

            r_tampered = http.post(
                "/api/respaldo/restaurar",
                json={"nombre": bak_name},
                headers={"X-Backup-Passphrase": phrase},
            )
            assert r_tampered.status_code == 403
            assert r_tampered.json() == {"detail": "No autorizado"}
    finally:
        server.should_exit = True
        thread.join(timeout=5.0)
