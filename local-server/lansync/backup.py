"""Respaldo cifrado del estado de la tienda (AES-256-GCM + PBKDF2-HMAC-SHA256 >= 600,000 iteraciones).

Formato binario de archivo .bak (encabezado versionado y parametrizado cubierto por AAD):
  - [0..5]   Magic ASCII: b"BTBAK" (5 bytes)
  - [5]      Versión de formato (uint8): 1
  - [6]      KDF ID (uint8): 1 = PBKDF2-HMAC-SHA256
  - [7]      Cipher ID (uint8): 1 = AES-256-GCM (salt 16B, nonce 12B, tag 16B)
  - [8..12]  Iteraciones PBKDF2 (uint32 big-endian, por defecto 600,000)
  - [12..28] Salt aleatorio: 16 bytes
  - [28..40] Nonce (IV) aleatorio: 12 bytes
  - [40..]   Ciphertext + Tag de autenticación GCM (16 bytes)
  * AAD (Additional Authenticated Data) = bytes [0..28] (Magic + Versión + KDF + Cipher + Iteraciones + Salt)

La frase de respaldo NUNCA se guarda en disco. Si se pierde la frase, el respaldo no se puede descifrar.
"""
from __future__ import annotations

import json
import os
import re
import struct
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC_PREFIX = b"BTBAK"
FORMAT_VERSION = 1
KDF_PBKDF2_SHA256 = 1
CIPHER_AES_256_GCM = 1

HEADER_META_LEN = 12  # 5B magic + 1B version + 1B kdf + 1B cipher + 4B uint32 iterations
SALT_LEN = 16
AAD_LEN = HEADER_META_LEN + SALT_LEN  # 28 bytes cubiertos por AAD
NONCE_LEN = 12
TAG_LEN = 16
MIN_BLOB_LEN = AAD_LEN + NONCE_LEN + TAG_LEN  # 56 bytes
KEY_LEN = 32

PBKDF2_ITERATIONS = 600_000
MIN_ALLOWED_ITERATIONS = 1_000
MAX_ALLOWED_ITERATIONS = 10_000_000

MIN_PASSPHRASE_LEN = 8
MAX_BACKUPS = 30
BACKUP_FILENAME_RE = re.compile(r"^[0-9]{8}-[0-9]{6}\.bak$")


class BackupError(Exception):
    """Error base de operaciones de respaldo."""


class BackupPassphraseError(BackupError):
    """Frase de respaldo inválida (demasiado corta o vacía)."""


class BackupDecryptionError(BackupError):
    """Error al descifrar o autenticar el archivo de respaldo (frase incorrecta o archivo manipulado)."""


class BackupNotFoundError(BackupError):
    """El archivo de respaldo solicitado no existe."""


class BackupInvalidFilenameError(BackupError):
    """El nombre de archivo no cumple el patrón ^[0-9]{8}-[0-9]{6}\\.bak$."""


def validate_passphrase(passphrase: str | None) -> str:
    if not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE_LEN:
        raise BackupPassphraseError(f"La frase de respaldo debe tener al menos {MIN_PASSPHRASE_LEN} caracteres.")
    return passphrase


def validate_backup_filename(filename: str) -> str:
    if not isinstance(filename, str) or not BACKUP_FILENAME_RE.match(filename):
        raise BackupInvalidFilenameError("Nombre de respaldo inválido.")
    return filename


def pack_backup_header(
    salt: bytes,
    iterations: int = PBKDF2_ITERATIONS,
    version: int = FORMAT_VERSION,
    kdf_id: int = KDF_PBKDF2_SHA256,
    cipher_id: int = CIPHER_AES_256_GCM,
) -> bytes:
    if len(salt) != SALT_LEN:
        raise ValueError("Salt debe ser de 16 bytes")
    meta = struct.pack(">5sBBBI", MAGIC_PREFIX, version, kdf_id, cipher_id, iterations)
    return meta + salt


def unpack_backup_header(blob: bytes) -> dict:
    if not isinstance(blob, (bytes, bytearray)) or len(blob) < MIN_BLOB_LEN:
        raise BackupDecryptionError("No autorizado")
    raw = bytes(blob)
    magic, version, kdf_id, cipher_id, iterations = struct.unpack(">5sBBBI", raw[:HEADER_META_LEN])
    if magic != MAGIC_PREFIX:
        raise BackupDecryptionError("No autorizado")
    if version != FORMAT_VERSION or kdf_id != KDF_PBKDF2_SHA256 or cipher_id != CIPHER_AES_256_GCM:
        raise BackupDecryptionError("No autorizado")
    if iterations < MIN_ALLOWED_ITERATIONS or iterations > MAX_ALLOWED_ITERATIONS:
        raise BackupDecryptionError("No autorizado")

    salt = raw[HEADER_META_LEN:AAD_LEN]
    nonce = raw[AAD_LEN : AAD_LEN + NONCE_LEN]
    ciphertext = raw[AAD_LEN + NONCE_LEN :]
    aad = raw[:AAD_LEN]
    return {
        "version": version,
        "kdf_id": kdf_id,
        "cipher_id": cipher_id,
        "iterations": iterations,
        "salt": salt,
        "nonce": nonce,
        "aad": aad,
        "ciphertext": ciphertext,
    }


def derive_backup_key(passphrase: str, salt: bytes, iterations: int | None = None) -> bytes:
    iters = iterations if iterations is not None else PBKDF2_ITERATIONS
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN,
        salt=salt,
        iterations=iters,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_backup_bytes(
    plaintext: bytes,
    passphrase: str,
    iterations: int | None = None,
) -> bytes:
    phrase = validate_passphrase(passphrase)
    iters = iterations if iterations is not None else PBKDF2_ITERATIONS
    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    aad = pack_backup_header(salt, iterations=iters)
    key = derive_backup_key(phrase, salt, iterations=iters)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad)
    return aad + nonce + ciphertext


def decrypt_backup_bytes(blob: bytes, passphrase: str) -> bytes:
    if not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE_LEN:
        raise BackupDecryptionError("No autorizado")
    parsed = unpack_backup_header(blob)
    try:
        key = derive_backup_key(passphrase, parsed["salt"], iterations=parsed["iterations"])
        return AESGCM(key).decrypt(parsed["nonce"], parsed["ciphertext"], parsed["aad"])
    except (InvalidTag, ValueError, Exception) as exc:
        raise BackupDecryptionError("No autorizado") from exc


def _parse_filename_iso(filename: str, fallback_mtime: float) -> str:
    stem = filename[:-4] if filename.endswith(".bak") else filename
    try:
        dt = datetime.strptime(stem, "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except ValueError:
        return datetime.fromtimestamp(fallback_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _format_entry(path: Path) -> dict:
    st = path.stat()
    iso_date = _parse_filename_iso(path.name, st.st_mtime)
    size = st.st_size
    return {
        "nombre": path.name,
        "fecha": iso_date,
        "tamano": size,
        "tamaño": size,
        "name": path.name,
        "date": iso_date,
        "size": size,
    }


class BackupStore:
    def __init__(self, respaldos_dir: Path, max_backups: int = MAX_BACKUPS) -> None:
        self.respaldos_dir = Path(respaldos_dir)
        self.max_backups = max_backups
        self.respaldos_dir.mkdir(parents=True, exist_ok=True)
        self._last_dt: datetime | None = None

    def _next_filename(self, now: datetime | None = None) -> tuple[str, datetime]:
        dt = (now or datetime.now(timezone.utc)).replace(microsecond=0)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if self._last_dt is not None and dt <= self._last_dt:
            dt = self._last_dt + timedelta(seconds=1)
        while True:
            candidate = f"{dt.strftime('%Y%m%d-%H%M%S')}.bak"
            if not (self.respaldos_dir / candidate).exists():
                self._last_dt = dt
                return candidate, dt
            dt = dt + timedelta(seconds=1)

    def _prune_old_backups(self) -> None:
        files = sorted(
            [p for p in self.respaldos_dir.glob("*.bak") if p.is_file() and BACKUP_FILENAME_RE.match(p.name)],
            key=lambda p: p.name,
            reverse=True,
        )
        for old_file in files[self.max_backups :]:
            try:
                old_file.unlink(missing_ok=True)
            except OSError:
                pass

    def create(self, state_obj: object, passphrase: str, now: datetime | None = None) -> dict:
        validate_passphrase(passphrase)
        try:
            plaintext = json.dumps(state_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise BackupError("El estado proporcionado no es JSON serializable.") from exc

        encrypted = encrypt_backup_bytes(plaintext, passphrase)
        filename, _ = self._next_filename(now)
        temp_path = self.respaldos_dir / f".tmp_{uuid.uuid4().hex}"
        final_path = self.respaldos_dir / filename

        try:
            temp_path.write_bytes(encrypted)
            temp_path.replace(final_path)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

        self._prune_old_backups()
        return _format_entry(final_path)

    def list_all(self) -> list[dict]:
        if not self.respaldos_dir.is_dir():
            return []
        files = sorted(
            [p for p in self.respaldos_dir.glob("*.bak") if p.is_file() and BACKUP_FILENAME_RE.match(p.name)],
            key=lambda p: p.name,
            reverse=True,
        )
        return [_format_entry(p) for p in files]

    def _resolve_backup_path(self, filename: str | None) -> Path:
        if not filename:
            files = sorted(
                [p for p in self.respaldos_dir.glob("*.bak") if p.is_file() and BACKUP_FILENAME_RE.match(p.name)],
                key=lambda p: p.name,
                reverse=True,
            )
            if not files:
                raise BackupNotFoundError("No hay respaldos disponibles.")
            return files[0]

        validate_backup_filename(filename)

        target = (self.respaldos_dir / filename).resolve()
        if target.parent != self.respaldos_dir.resolve() or not target.is_file():
            raise BackupNotFoundError("Respaldo no encontrado.")
        return target

    def restore(self, passphrase: str, filename: str | None = None) -> object:
        target = self._resolve_backup_path(filename)
        blob = target.read_bytes()
        plaintext = decrypt_backup_bytes(blob, passphrase)
        try:
            return json.loads(plaintext.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise BackupDecryptionError("No autorizado") from exc

    def read_raw(self, filename: str) -> bytes:
        validate_backup_filename(filename)
        target = self._resolve_backup_path(filename)
        return target.read_bytes()
