"""Copia automática del respaldo cifrado más reciente a una memoria USB (Bloque L).

Qué hace:
  * Cuando hay una unidad extraíble conectada (o se indicó una carpeta con --usb-dir), copia el
    respaldo .bak MÁS RECIENTE una vez al día a la subcarpeta "BinniStore-Respaldos" de esa unidad.
  * Solo copia el archivo YA CIFRADO (AES-256-GCM). Jamás recibe ni guarda la frase de respaldo.
  * Guarda en data/usb_estado.json cuándo fue la última copia, para que la app muestre
    "Última copia a USB: hace X" y avise si pasan más de 7 días.

Qué NO hace (ver README del servidor): no detecta unidades desde el navegador, no expulsa la unidad,
no cifra la memoria USB en sí, y no puede copiar si la unidad no está conectada en la PC del servidor.

Detección de unidades:
  * Windows: os.listdrives() (Python 3.12+) y GetDriveTypeW == DRIVE_REMOVABLE (2).
    Algunos discos duros USB se reportan como "fijos" (DRIVE_FIXED) y NO se detectan solos:
    para ellos usa --usb-dir E:\\ (la letra de la unidad).
  * Linux: puntos de montaje bajo /media y /run/media. macOS: /Volumes.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import string
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .backup import BACKUP_FILENAME_RE, MAGIC_PREFIX, BackupStore

USB_SUBDIR = "BinniStore-Respaldos"
STATE_FILENAME = "usb_estado.json"
WARN_AFTER_DAYS = 7
MAX_USB_BACKUPS = 30  # solo se podan archivos AAAAMMDD-HHMMSS.bak dentro de BinniStore-Respaldos
DRIVE_REMOVABLE = 2  # valor de GetDriveTypeW para unidades extraíbles
RETRY_AFTER_ERROR_SECONDS = 300

NowFn = Callable[[], datetime]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ detección de unidades
def _windows_drive_type(root: str) -> int:
    import ctypes  # solo existe en Windows

    return int(ctypes.windll.kernel32.GetDriveTypeW(root))  # type: ignore[attr-defined]


def _windows_listdrives() -> list[str]:
    if hasattr(os, "listdrives"):  # Python 3.12+ en Windows
        return list(os.listdrives())  # type: ignore[attr-defined]
    return [f"{letter}:\\" for letter in string.ascii_uppercase if os.path.exists(f"{letter}:\\")]


def _read_proc_mounts() -> list[str]:
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    mounts: list[str] = []
    for line in lines:
        parts = line.split()
        if len(parts) >= 2:
            mounts.append(parts[1].replace("\\040", " "))
    return mounts


def list_removable_drives(
    *,
    platform: str | None = None,
    listdrives: Callable[[], list[str]] | None = None,
    drive_type: Callable[[str], int] | None = None,
    mounts_reader: Callable[[], list[str]] | None = None,
    volumes_dir: Path | None = None,
    media_prefixes: tuple[str, ...] = ("/media/", "/run/media/"),
) -> list[Path]:
    """Devuelve las unidades extraíbles listas para escribir. Los parámetros permiten simularlo en pruebas."""
    plat = platform or sys.platform
    found: list[Path] = []

    if plat.startswith("win"):
        lister = listdrives or _windows_listdrives
        kind = drive_type or _windows_drive_type
        try:
            roots = lister()
        except OSError:
            return []
        for root in roots:
            try:
                if kind(root) != DRIVE_REMOVABLE:
                    continue
                if os.path.isdir(root):  # un lector de tarjetas vacío también es "extraíble": se omite
                    found.append(Path(root))
            except OSError:
                continue
        return found

    if plat == "darwin":
        base = volumes_dir or Path("/Volumes")
        try:
            for entry in sorted(base.iterdir()):
                if entry.is_dir() and not entry.is_symlink():  # "Macintosh HD" es un enlace a "/"
                    found.append(entry)
        except OSError:
            return []
        return found

    reader = mounts_reader or _read_proc_mounts
    for mount in reader():
        if mount.startswith(media_prefixes) and os.path.isdir(mount):
            found.append(Path(mount))
    return found


# ------------------------------------------------------------------ copia
class UsbBackupCopier:
    def __init__(
        self,
        backups: BackupStore,
        data_dir: Path,
        *,
        enabled: bool = True,
        usb_dir: Path | None = None,
        drives_provider: Callable[[], list[Path]] | None = None,
        now: NowFn | None = None,
    ) -> None:
        self.backups = backups
        self.state_path = Path(data_dir) / STATE_FILENAME
        self.enabled = enabled
        self.usb_dir = Path(usb_dir) if usb_dir else None
        self._drives_provider = drives_provider or list_removable_drives
        self._now = now or _utc_now
        self._lock = threading.Lock()

    # ----- estado persistente
    def _load_state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _save_state(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_name(f".tmp_{uuid.uuid4().hex}")
        try:
            tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
        finally:
            tmp.unlink(missing_ok=True)

    # ----- destino
    def _find_target(self) -> tuple[Path | None, str]:
        """Devuelve (carpeta raíz de la unidad, modo). Modo: 'carpeta' (--usb-dir) o 'automatico'."""
        if self.usb_dir is not None:
            return (self.usb_dir if self.usb_dir.is_dir() else None), "carpeta"
        try:
            drives = self._drives_provider()
        except Exception:
            drives = []
        return (drives[0] if drives else None), "automatico"

    # ----- estado para la app
    def status(self) -> dict:
        state = self._load_state()
        last_iso = state.get("ultimaCopia")
        last_dt = _parse_iso(last_iso)
        now = self._now()
        days = None
        if last_dt is not None:
            days = max(0, (now - last_dt).days)
        target, mode = self._find_target() if self.enabled else (None, "desactivado")
        stale = self.enabled and (last_dt is None or (now - last_dt) > timedelta(days=WARN_AFTER_DAYS))
        return {
            "activo": self.enabled,
            "modo": mode,
            "unidadConectada": target is not None,
            "ultimaCopia": _iso_utc(last_dt) if last_dt else None,
            "ultimoArchivo": state.get("ultimoArchivo"),
            "ultimoDestino": state.get("ultimoDestino"),
            "diasDesdeUltimaCopia": days,
            "umbralDias": WARN_AFTER_DAYS,
            "aviso": bool(stale),
            "ultimoError": state.get("ultimoError"),
        }

    # ----- copia
    def maybe_copy(self, *, force: bool = False) -> dict:
        """Copia el .bak más reciente si hay unidad y hoy aún no se copió a ese destino. No lanza excepciones."""
        if not self.enabled:
            return {"copiado": False, "motivo": "desactivado"}
        with self._lock:
            return self._maybe_copy_locked(force)

    def _maybe_copy_locked(self, force: bool) -> dict:
        state = self._load_state()
        now = self._now()
        today = now.astimezone().date()

        latest = self._latest_backup()
        if latest is None:
            return {"copiado": False, "motivo": "sin_respaldos"}

        # Reintento tras un error: no insistir más de una vez cada 5 minutos.
        last_attempt = _parse_iso(state.get("ultimoIntento"))
        if not force and state.get("ultimoError") and last_attempt and (now - last_attempt).total_seconds() < RETRY_AFTER_ERROR_SECONDS:
            return {"copiado": False, "motivo": "reintento_pendiente"}

        # Verifica la unidad antes de consultar el estado diario: sin unidad no hay nada que hacer.
        target_root, _mode = self._find_target()
        if target_root is None:
            return {"copiado": False, "motivo": "sin_unidad"}

        destination = target_root / USB_SUBDIR
        last_copy = _parse_iso(state.get("ultimaCopia"))
        same_destination = state.get("ultimoDestino") == str(destination)
        if not force and last_copy and same_destination and last_copy.astimezone().date() == today:
            return {"copiado": False, "motivo": "ya_copiado_hoy"}
        if not force and same_destination and state.get("ultimoArchivo") == latest.name and (destination / latest.name).is_file():
            return {"copiado": False, "motivo": "sin_cambios"}

        state["ultimoIntento"] = _iso_utc(now)
        try:
            self._copy_file(latest, destination)
            self._prune(destination)
        except Exception as exc:  # unidad retirada, disco lleno, sin permisos...
            state["ultimoError"] = f"{type(exc).__name__}: {exc}"[:300]
            self._save_state(state)
            return {"copiado": False, "motivo": "error", "error": state["ultimoError"]}

        state["ultimaCopia"] = _iso_utc(now)
        state["ultimoArchivo"] = latest.name
        state["ultimoDestino"] = str(destination)
        state["ultimoError"] = None
        self._save_state(state)
        return {"copiado": True, "motivo": "ok", "archivo": latest.name, "destino": str(destination)}

    def _latest_backup(self) -> Path | None:
        entries = self.backups.list_all()  # ordenados del más nuevo al más viejo
        for entry in entries:
            path = self.backups.respaldos_dir / entry["nombre"]
            if path.is_file() and BACKUP_FILENAME_RE.match(path.name):
                return path
        return None

    @staticmethod
    def _copy_file(source: Path, destination_dir: Path) -> None:
        with source.open("rb") as fh:
            if fh.read(len(MAGIC_PREFIX)) != MAGIC_PREFIX:
                raise ValueError("El archivo no es un respaldo cifrado válido; no se copia.")
        destination_dir.mkdir(parents=True, exist_ok=True)
        final_path = destination_dir / source.name
        tmp_path = destination_dir / f".tmp_{uuid.uuid4().hex}"
        try:
            shutil.copyfile(source, tmp_path)
            if _sha256(tmp_path) != _sha256(source):
                raise OSError("La copia no coincide con el original (verificación SHA-256).")
            tmp_path.replace(final_path)
        finally:
            tmp_path.unlink(missing_ok=True)

    @staticmethod
    def _prune(destination_dir: Path) -> None:
        files = sorted(
            (p for p in destination_dir.glob("*.bak") if p.is_file() and BACKUP_FILENAME_RE.match(p.name)),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in files[MAX_USB_BACKUPS:]:
            try:
                old.unlink(missing_ok=True)
            except OSError:
                pass
        # Restos de copias interrumpidas (solo los .tmp_* propios dentro de BinniStore-Respaldos)
        for leftover in destination_dir.glob(".tmp_*"):
            try:
                if leftover.is_file():
                    leftover.unlink(missing_ok=True)
            except OSError:
                pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
