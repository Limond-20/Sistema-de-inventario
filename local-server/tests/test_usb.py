"""Pruebas de la copia automática del respaldo cifrado a USB (Bloque L).

Todo se simula con carpetas temporales: no se toca ninguna memoria USB real ni se depende del sistema operativo.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lansync.backup import BackupStore
from lansync.pairing import PairingStore
from lansync.server import create_app
from lansync.usb import (
    MAX_USB_BACKUPS,
    USB_SUBDIR,
    UsbBackupCopier,
    list_removable_drives,
)

PASSPHRASE = "frase-secreta-de-prueba-123"


class Clock:
    """Reloj controlable. Las horas son locales para que 'el mismo día' sea igual en cualquier zona horaria."""

    def __init__(self, year=2026, month=11, day=15, hour=10):
        self.current = datetime(year, month, day, hour, 0).astimezone()

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **kwargs) -> None:
        self.current = self.current + timedelta(**kwargs)


def make_backup(store: BackupStore, minute: int, payload: object | None = None) -> str:
    when = datetime(2026, 11, 15, 8, minute, 0, tzinfo=timezone.utc)
    entry = store.create(payload if payload is not None else {"n": minute}, PASSPHRASE, now=when)
    return entry["nombre"]


@pytest.fixture()
def env(tmp_path):
    store = BackupStore(tmp_path / "data" / "respaldos")
    usb = tmp_path / "usb_E"
    usb.mkdir()
    clock = Clock()
    copier = UsbBackupCopier(store, tmp_path / "data", usb_dir=usb, now=clock)
    return {"store": store, "usb": usb, "clock": clock, "copier": copier, "tmp": tmp_path}


# ----------------------------------------------------------------- detección de unidades
def test_windows_solo_unidades_extraibles_y_listas(tmp_path):
    for name in ("C", "D", "E", "G"):
        (tmp_path / name).mkdir()
    roots = [str(tmp_path / n) for n in ("C", "D", "E", "F_lector_vacio", "G")]
    kinds = {"C": 3, "D": 2, "E": 3, "F_lector_vacio": 2, "G": 2}

    drives = list_removable_drives(
        platform="win32",
        listdrives=lambda: roots,
        drive_type=lambda root: kinds[Path(root).name],
    )

    # C y E son discos fijos; F es un lector de tarjetas vacío (no existe como carpeta): se omiten.
    assert [d.name for d in drives] == ["D", "G"]


def test_windows_sin_unidades_si_listdrives_falla():
    def boom():
        raise OSError("sin acceso")

    assert list_removable_drives(platform="win32", listdrives=boom, drive_type=lambda r: 2) == []


def test_linux_usa_solo_montajes_bajo_media(tmp_path):
    media = tmp_path / "media"
    usb, otro = media / "tienda" / "USB", tmp_path / "datos"
    usb.mkdir(parents=True)
    otro.mkdir()
    drives = list_removable_drives(
        platform="linux",
        mounts_reader=lambda: ["/", str(otro), str(usb), str(media / "tienda" / "desmontada")],
        media_prefixes=(str(media) + os.sep,),
    )
    assert drives == [usb]  # el disco del sistema, otras carpetas y los montajes inexistentes se omiten


def test_macos_ignora_enlaces_como_macintosh_hd(tmp_path):
    volumes = tmp_path / "Volumes"
    volumes.mkdir()
    (volumes / "USB").mkdir()
    try:
        (volumes / "Macintosh HD").symlink_to(tmp_path, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Este sistema no permite crear enlaces simbólicos sin permisos de administrador (pasa en Windows).")
    drives = list_removable_drives(platform="darwin", volumes_dir=volumes)
    assert [d.name for d in drives] == ["USB"]


# ----------------------------------------------------------------- copia
def test_copia_el_bak_mas_reciente_identico_y_sin_la_frase(env):
    older = make_backup(env["store"], 1)
    newest = make_backup(env["store"], 2)

    result = env["copier"].maybe_copy()

    assert result["copiado"] is True and result["archivo"] == newest
    copied = env["usb"] / USB_SUBDIR / newest
    original = env["store"].respaldos_dir / newest
    assert copied.read_bytes() == original.read_bytes()  # es el archivo ya cifrado, byte por byte
    assert not (env["usb"] / USB_SUBDIR / older).exists()  # solo el más reciente
    assert PASSPHRASE.encode() not in copied.read_bytes()
    # La frase tampoco queda en el archivo de estado ni en la carpeta de datos.
    state_text = (env["tmp"] / "data" / "usb_estado.json").read_text(encoding="utf-8")
    assert PASSPHRASE not in state_text
    # No quedan temporales en la memoria USB.
    assert [p.name for p in (env["usb"] / USB_SUBDIR).iterdir()] == [newest]


def test_una_sola_copia_por_dia_y_otra_al_dia_siguiente(env):
    first = make_backup(env["store"], 1)
    assert env["copier"].maybe_copy()["archivo"] == first

    second = make_backup(env["store"], 2)
    env["clock"].advance(hours=1)  # el mismo día
    assert env["copier"].maybe_copy() == {"copiado": False, "motivo": "ya_copiado_hoy"}
    assert not (env["usb"] / USB_SUBDIR / second).exists()

    env["clock"].advance(days=1)  # al día siguiente sí
    result = env["copier"].maybe_copy()
    assert result["copiado"] is True and result["archivo"] == second
    assert (env["usb"] / USB_SUBDIR / second).is_file()


def test_si_cambia_la_memoria_usb_el_mismo_dia_se_copia_de_nuevo(tmp_path):
    store = BackupStore(tmp_path / "data" / "respaldos")
    usb_a, usb_b = tmp_path / "A", tmp_path / "B"
    usb_a.mkdir()
    usb_b.mkdir()
    current = {"drives": [usb_a]}
    clock = Clock()
    copier = UsbBackupCopier(store, tmp_path / "data", drives_provider=lambda: current["drives"], now=clock)
    name = make_backup(store, 1)

    assert copier.maybe_copy()["copiado"] is True
    assert copier.maybe_copy()["motivo"] == "ya_copiado_hoy"

    current["drives"] = [usb_b]
    assert copier.maybe_copy()["copiado"] is True
    assert (usb_b / USB_SUBDIR / name).is_file()


def test_sin_unidad_conectada_no_copia_ni_falla(tmp_path):
    store = BackupStore(tmp_path / "data" / "respaldos")
    make_backup(store, 1)
    copier = UsbBackupCopier(store, tmp_path / "data", drives_provider=lambda: [], now=Clock())

    assert copier.maybe_copy() == {"copiado": False, "motivo": "sin_unidad"}
    status = copier.status()
    assert status["unidadConectada"] is False
    assert status["ultimaCopia"] is None
    assert status["aviso"] is True


def test_sin_respaldos_no_hace_nada(env):
    assert env["copier"].maybe_copy() == {"copiado": False, "motivo": "sin_respaldos"}
    assert not (env["usb"] / USB_SUBDIR).exists()


def test_desactivado_no_copia(env):
    make_backup(env["store"], 1)
    copier = UsbBackupCopier(env["store"], env["tmp"] / "data", enabled=False, usb_dir=env["usb"], now=env["clock"])
    assert copier.maybe_copy() == {"copiado": False, "motivo": "desactivado"}
    assert copier.status()["activo"] is False
    assert copier.status()["aviso"] is False
    assert not (env["usb"] / USB_SUBDIR).exists()


def test_usb_dir_que_no_existe_se_trata_como_unidad_no_conectada(env):
    make_backup(env["store"], 1)
    gone = env["tmp"] / "E_desconectada"
    copier = UsbBackupCopier(env["store"], env["tmp"] / "data", usb_dir=gone, now=env["clock"])
    assert copier.maybe_copy()["motivo"] == "sin_unidad"
    assert not gone.exists()  # no se inventa la carpeta de una unidad que no está


# ----------------------------------------------------------------- errores
def test_error_de_copia_se_registra_y_se_reintenta_despues(env):
    make_backup(env["store"], 1)
    # "BinniStore-Respaldos" existe como ARCHIVO: no se puede crear la carpeta -> la copia falla.
    (env["usb"] / USB_SUBDIR).write_text("estorbo")

    result = env["copier"].maybe_copy()
    assert result["copiado"] is False and result["motivo"] == "error"
    status = env["copier"].status()
    assert status["ultimoError"] and status["ultimaCopia"] is None

    env["clock"].advance(minutes=1)
    assert env["copier"].maybe_copy()["motivo"] == "reintento_pendiente"  # no insiste cada minuto

    (env["usb"] / USB_SUBDIR).unlink()  # se arregla el problema
    env["clock"].advance(minutes=10)
    assert env["copier"].maybe_copy()["copiado"] is True
    assert env["copier"].status()["ultimoError"] is None


def test_un_archivo_que_no_es_respaldo_cifrado_no_se_copia(env):
    fake = env["store"].respaldos_dir / "20261115-090000.bak"
    fake.write_bytes(b"esto no es un respaldo cifrado")

    result = env["copier"].maybe_copy()

    assert result["motivo"] == "error"
    assert not (env["usb"] / USB_SUBDIR / fake.name).exists()


def test_poda_solo_respaldos_propios_y_deja_lo_demas(env):
    dest = env["usb"] / USB_SUBDIR
    dest.mkdir()
    for i in range(MAX_USB_BACKUPS + 2):  # 32 respaldos viejos con nombre válido
        (dest / f"20250101-{i:06d}.bak").write_bytes(b"viejo")
    (dest / "foto-familia.jpg").write_bytes(b"no tocar")
    (env["usb"] / "tarea.docx").write_bytes(b"no tocar")
    newest = make_backup(env["store"], 5)

    assert env["copier"].maybe_copy()["copiado"] is True

    baks = sorted(p.name for p in dest.glob("*.bak"))
    assert len(baks) == MAX_USB_BACKUPS
    assert newest in baks
    assert (dest / "foto-familia.jpg").read_bytes() == b"no tocar"
    assert (env["usb"] / "tarea.docx").read_bytes() == b"no tocar"


# ----------------------------------------------------------------- aviso de 7 días
def test_aviso_cuando_pasan_mas_de_7_dias(env):
    make_backup(env["store"], 1)
    assert env["copier"].status()["aviso"] is True  # nunca se ha copiado

    env["copier"].maybe_copy()
    status = env["copier"].status()
    assert status["aviso"] is False and status["diasDesdeUltimaCopia"] == 0
    assert status["ultimaCopia"].endswith("Z")

    env["clock"].advance(days=6, hours=23)
    assert env["copier"].status()["aviso"] is False
    env["clock"].advance(hours=2)  # ya pasaron más de 7 días
    status = env["copier"].status()
    assert status["aviso"] is True and status["diasDesdeUltimaCopia"] == 7
    assert status["umbralDias"] == 7


def test_archivo_de_estado_danado_no_rompe(env):
    make_backup(env["store"], 1)
    (env["tmp"] / "data").mkdir(exist_ok=True)
    (env["tmp"] / "data" / "usb_estado.json").write_text("{no es json", encoding="utf-8")
    assert env["copier"].status()["ultimaCopia"] is None
    assert env["copier"].maybe_copy()["copiado"] is True


# ----------------------------------------------------------------- API
@pytest.fixture()
def api(tmp_path):
    (tmp_path / "index.html").write_text("<html>INDEX</html>")
    data_dir = tmp_path / "data"
    usb = tmp_path / "usb"
    usb.mkdir()
    app = create_app(
        tmp_path,
        port=8443,
        tls=True,
        ips=["192.168.1.70"],
        pairing=PairingStore(path=data_dir / "pairing.json"),
        data_dir=data_dir,
        usb_enabled=True,
        usb_dir=usb,
    )
    app.state.trusted_hosts.add("testclient")  # la PC de la tienda
    return app, usb


def test_api_estado_solo_desde_la_pc(tmp_path):
    (tmp_path / "index.html").write_text("x")
    app = create_app(tmp_path, ips=["192.168.1.70"], data_dir=tmp_path / "data", usb_enabled=True)
    with TestClient(app) as c:  # 'testclient' NO es de confianza aquí: es otro dispositivo
        assert c.get("/api/usb/estado").status_code == 403
        assert c.post("/api/usb/copiar").status_code == 403


def test_api_estado_y_copia_al_crear_respaldo(api):
    app, usb = api
    with TestClient(app) as c:
        before = c.get("/api/usb/estado")
        assert before.status_code == 200
        body = before.json()
        assert body["activo"] is True and body["unidadConectada"] is True
        assert body["ultimaCopia"] is None and body["aviso"] is True
        assert before.headers["cache-control"] == "no-store"

        r = c.post("/api/respaldo", json={"productos": [{"id": 1}]}, headers={"x-backup-passphrase": PASSPHRASE})
        assert r.status_code == 200
        name = r.json()["nombre"]  # la respuesta del respaldo no cambia

        copied = usb / USB_SUBDIR / name
        assert copied.is_file()
        assert copied.read_bytes() == (app.state.respaldos_dir / name).read_bytes()

        after = c.get("/api/usb/estado").json()
        assert after["ultimoArchivo"] == name and after["aviso"] is False and after["ultimaCopia"]
        assert PASSPHRASE not in json.dumps(after)


def test_api_copiar_ahora_ignora_el_limite_diario(api):
    app, usb = api
    with TestClient(app) as c:
        c.post("/api/respaldo", json={"a": 1}, headers={"x-backup-passphrase": PASSPHRASE})
        second = c.post("/api/respaldo", json={"a": 2}, headers={"x-backup-passphrase": PASSPHRASE}).json()["nombre"]
        # El segundo respaldo del mismo día no se copió solo...
        assert not (usb / USB_SUBDIR / second).exists()
        # ...pero "Copiar ahora" sí lo copia.
        r = c.post("/api/usb/copiar")
        assert r.status_code == 200 and r.json()["copiado"] is True and r.json()["archivo"] == second
        assert (usb / USB_SUBDIR / second).is_file()


def test_api_desactivada_por_defecto_no_copia_nada(tmp_path):
    (tmp_path / "index.html").write_text("x")
    usb = tmp_path / "usb"
    usb.mkdir()
    app = create_app(tmp_path, ips=["192.168.1.70"], data_dir=tmp_path / "data", usb_dir=usb)  # usb_enabled=False
    app.state.trusted_hosts.add("testclient")
    with TestClient(app) as c:
        assert c.get("/api/usb/estado").json()["activo"] is False
        assert c.post("/api/usb/copiar").status_code == 409
        r = c.post("/api/respaldo", json={"a": 1}, headers={"x-backup-passphrase": PASSPHRASE})
        assert r.status_code == 200
        assert not (usb / USB_SUBDIR).exists()


def test_tarea_periodica_copia_sin_que_nadie_pida_respaldo(tmp_path):
    (tmp_path / "index.html").write_text("x")
    data_dir = tmp_path / "data"
    usb = tmp_path / "usb"
    usb.mkdir()
    store = BackupStore(data_dir / "respaldos")
    name = make_backup(store, 3)  # el respaldo ya existía antes de conectar la USB

    app = create_app(tmp_path, ips=["192.168.1.70"], data_dir=data_dir, usb_enabled=True, usb_dir=usb, usb_poll_seconds=0.05)
    with TestClient(app):
        deadline = time.monotonic() + 10
        target = usb / USB_SUBDIR / name
        while not target.is_file() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert target.is_file()
