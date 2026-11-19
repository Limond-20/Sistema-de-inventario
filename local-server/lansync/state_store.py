"""Persistencia SQLite de la PC: snapshots versionados, Kardex append-only y cifrado AES-256-GCM en reposo."""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import hashlib
import json
import math
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SQLITE_KEYSTORE_META_KEY = "keystore_v1"
SQLITE_KEYSTORE_FORMAT = "BTSQLKEYS"
SQLITE_KEYSTORE_VERSION = 1
SQLITE_ENC_VERSION = 1
SQLITE_ENC_ALG = "AES-256-GCM"
SQLITE_PBKDF2_ITERATIONS = 600_000
SQLITE_DEK_BYTES = 32
SQLITE_SALT_BYTES = 16
SQLITE_IV_BYTES = 12


class StateStoreError(Exception):
    """Error base de persistencia del estado."""


class DatabaseLockedError(StateStoreError):
    """La base SQLite está cifrada con PIN y requiere desbloqueo antes de operar."""


class KardexIntegrityError(StateStoreError):
    """El Kardex recibido no continúa íntegramente la cadena almacenada."""


class SnapshotNotFoundError(StateStoreError):
    """No existe un snapshot para la clave solicitada."""


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi_protect(raw: bytes) -> bytes | None:
    if os.name != "nt":
        return None
    try:
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        blob_in = _DataBlob(len(raw), buf)
        blob_out = _DataBlob()
        # CRYPTPROTECT_UI_FORBIDDEN = 0x1
        ok = crypt32.CryptProtectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0x1,
            ctypes.byref(blob_out),
        )
        if not ok:
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))
    except Exception:
        return None


def _dpapi_unprotect(blob: bytes) -> bytes | None:
    if os.name != "nt":
        return None
    try:
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        buf = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        blob_in = _DataBlob(len(blob), buf)
        blob_out = _DataBlob()
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0x1,
            ctypes.byref(blob_out),
        )
        if not ok:
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))
    except Exception:
        return None


def _write_restrictive_bytes(path: Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _derive_pin_kek(pin: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=SQLITE_DEK_BYTES,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(pin.strip().encode("utf-8"))


def _b64_encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64_decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def _snapshot_aad(kid: str, state_key: str, snapshot_version: int) -> bytes:
    return f"BTSQL|v1|snapshot|{kid}|{state_key}|{snapshot_version}".encode("utf-8")


def _kardex_aad(kid: str, entry_id: str, previous_hash: str, entry_hash: str) -> bytes:
    return f"BTSQL|v1|kardex|{kid}|{entry_id}|{previous_hash}|{entry_hash}".encode("utf-8")


def _slot_aad(kid: str, slot_id: str) -> bytes:
    return f"BTSQLKEYS|v1|{kid}|{slot_id}".encode("utf-8")


def _local_wrap_aad(kid: str) -> bytes:
    return f"BTSQLKEYS|v1|{kid}|local-key".encode("utf-8")


def _parse_encrypted_envelope(payload_text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(payload_text)
    except (TypeError, ValueError):
        return None
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("__btenc__"), int)
        and isinstance(parsed.get("iv"), str)
        and isinstance(parsed.get("ct"), str)
        and isinstance(parsed.get("kid"), str)
    ):
        return parsed
    return None


def _encrypt_json_payload(dek: bytes, kid: str, plaintext_json: str, aad: bytes) -> str:
    iv = os.urandom(SQLITE_IV_BYTES)
    ct = AESGCM(dek).encrypt(iv, plaintext_json.encode("utf-8"), aad)
    return json.dumps(
        {
            "__btenc__": SQLITE_ENC_VERSION,
            "alg": SQLITE_ENC_ALG,
            "kid": kid,
            "iv": _b64_encode(iv),
            "ct": _b64_encode(ct),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _decrypt_envelope(dek: bytes, expected_kid: str, envelope: dict[str, Any], aad: bytes) -> str:
    if envelope.get("__btenc__") != SQLITE_ENC_VERSION or envelope.get("alg") != SQLITE_ENC_ALG:
        raise StateStoreError("Formato de cifrado en SQLite no soportado.")
    if envelope.get("kid") != expected_kid:
        raise StateStoreError("El registro cifrado corresponde a otra llave de almacén.")
    try:
        iv = _b64_decode(envelope["iv"])
        ct = _b64_decode(envelope["ct"])
        plain = AESGCM(dek).decrypt(iv, ct, aad)
        return plain.decode("utf-8")
    except (InvalidTag, ValueError, KeyError, UnicodeDecodeError) as exc:
        raise StateStoreError("No se pudo descifrar el registro SQLite: llave incorrecta o dato alterado.") from exc


def _normalise_js_value(value: Any) -> Any:
    """Normaliza números para aproximar la serialización de JSON.stringify."""
    if isinstance(value, float):
        if not math.isfinite(value):
            raise KardexIntegrityError("El Kardex contiene un número no finito.")
        if value == 0:
            return 0
        if value.is_integer() and abs(value) < 1e21:
            return int(value)
        return value
    if isinstance(value, list):
        return [_normalise_js_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _normalise_js_value(item) for key, item in value.items()}
    return value


def _js_number_to_string(value: int | float) -> str:
    """Representa números como JSON.stringify (incluidos sus umbrales de notación)."""
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise KardexIntegrityError("El Kardex contiene un número no finito.")
    if value == 0:
        return "0"  # JSON.stringify(-0) === "0"

    absolute = abs(value)
    raw = repr(value).lower()
    if "e" not in raw:
        # Python escribe algunos enteros grandes como decimal fijo; JS usa notación
        # exponencial desde 1e21. En el rango compartido, repr ya es la forma más corta.
        if absolute >= 1e21:
            raw = format(value, ".15e")
        else:
            return raw[:-2] if raw.endswith(".0") else raw

    mantissa, exponent_text = raw.split("e", 1)
    exponent = int(exponent_text)
    if 1e-6 <= absolute < 1e21:
        # ECMAScript usa decimal fijo en [1e-6, 1e21). Expandir el exponente
        # sin recalcular el valor evita introducir redondeos binarios adicionales.
        sign = "-" if mantissa.startswith("-") else ""
        unsigned = mantissa.lstrip("+-")
        integer_part, _dot, fractional_part = unsigned.partition(".")
        digits = integer_part + fractional_part
        decimal_position = len(integer_part) + exponent
        if decimal_position <= 0:
            return sign + "0." + ("0" * (-decimal_position)) + digits
        if decimal_position >= len(digits):
            return sign + digits + ("0" * (decimal_position - len(digits)))
        return sign + digits[:decimal_position] + "." + digits[decimal_position:]

    # Fuera del rango anterior, JS conserva la notación exponencial, sin ceros
    # iniciales en el exponente y con '+' explícito para exponentes positivos.
    sign = "-" if mantissa.startswith("-") else ""
    unsigned_mantissa = mantissa.lstrip("+-")
    exponent_sign = "+" if exponent >= 0 else "-"
    return f"{sign}{unsigned_mantissa}e{exponent_sign}{abs(exponent)}"


def _js_json_dumps(value: Any) -> str:
    """JSON compacto UTF-8 compatible con JSON.stringify para los campos del hash."""
    normalised = _normalise_js_value(value)

    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, (int, float)):
            return _js_number_to_string(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, list):
            return "[" + ",".join(encode(element) for element in item) + "]"
        if isinstance(item, dict):
            return "{" + ",".join(
                json.dumps(str(key), ensure_ascii=False) + ":" + encode(element)
                for key, element in item.items()
            ) + "}"
        raise KardexIntegrityError("El Kardex contiene un tipo de dato no serializable.")

    return encode(normalised)


def compute_kardex_hash(entry: dict[str, Any]) -> str:
    """Replica computeKardexHash de kardex.ts (payload canónico, claves ordenadas)."""
    product = entry.get("producto")
    if isinstance(product, str):
        product_sku = product
    elif isinstance(product, dict):
        product_sku = product.get("sku") or "GENERIC"
    else:
        product_sku = "GENERIC"

    payload: dict[str, Any] = {"amount": entry.get("amount") or 0}
    # En TS, JSON.stringify omite propiedades cuyo valor es undefined.
    fields = {
        "cantidad": "cantidad",
        "id": "id",
        "previousHash": "previousHash",
        "producto": None,
        "referencia": "referencia",
        "saldoAnterior": "saldoAnterior",
        "saldoResultante": "saldoResultante",
        "timestamp": "timestamp",
        "type": "type",
        "usuario": "usuario",
    }
    for output_key, source_key in fields.items():
        if output_key == "producto":
            payload[output_key] = product_sku
        elif source_key in entry:
            payload[output_key] = entry[source_key]
    canonical = {key: payload[key] for key in sorted(payload)}
    return hashlib.sha256(_js_json_dumps(canonical).encode("utf-8")).hexdigest()


def verify_kardex_chain(entries_newest_first: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Valida el hash y previousHash de toda la cadena y devuelve orden cronológico."""
    if not isinstance(entries_newest_first, list):
        raise KardexIntegrityError("La colección Kardex debe ser un arreglo.")
    chronological = list(reversed(entries_newest_first))
    previous_hash = "GENESIS"
    seen_ids: set[str] = set()
    for index, entry in enumerate(chronological):
        if not isinstance(entry, dict):
            raise KardexIntegrityError(f"La entrada Kardex #{index + 1} no es un objeto.")
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            raise KardexIntegrityError(f"La entrada Kardex #{index + 1} no tiene un ID válido.")
        if entry_id in seen_ids:
            raise KardexIntegrityError(f"ID de Kardex duplicado: {entry_id}.")
        seen_ids.add(entry_id)
        if entry.get("previousHash") != previous_hash:
            raise KardexIntegrityError(
                f"Ruptura de cadena en entrada #{entry_id}: previousHash no coincide con el hash previo."
            )
        expected_hash = compute_kardex_hash(entry)
        if entry.get("entryHash") != expected_hash:
            raise KardexIntegrityError(
                f"Entrada alterada #{entry_id}: el hash calculado no coincide con entryHash."
            )
        previous_hash = expected_hash
    return chronological


class SQLiteStateStore:
    """SQLite durable con transacciones serializadas, Kardex append-only y cifrado AES-256-GCM en reposo."""

    def __init__(
        self,
        database_path: Path,
        *,
        timeout_seconds: float = 15.0,
        pin_iterations: int = SQLITE_PBKDF2_ITERATIONS,
    ) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.local_key_path = self.database_path.parent / ".sqlite_local.key"
        self.timeout_seconds = timeout_seconds
        self._pin_iterations = pin_iterations
        self._dek: bytes | None = None
        self._kid: str | None = None
        self._mode: str = "local-key"
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.database_path,
            timeout=self.timeout_seconds,
            isolation_level=None,
        )
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {int(self.timeout_seconds * 1000)}")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA synchronous = FULL")
        return conn

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS state_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                state_key TEXT NOT NULL,
                snapshot_version INTEGER NOT NULL,
                schema_version INTEGER,
                state_timestamp TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(state_key, snapshot_version)
            );
            CREATE INDEX IF NOT EXISTS idx_state_snapshots_key_version
                ON state_snapshots(state_key, snapshot_version DESC);

            CREATE TABLE IF NOT EXISTS kardex_entries (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id TEXT NOT NULL UNIQUE,
                previous_hash TEXT NOT NULL,
                entry_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TRIGGER IF NOT EXISTS kardex_no_update
            BEFORE UPDATE ON kardex_entries
            BEGIN
                SELECT RAISE(ABORT, 'Kardex append-only: UPDATE no permitido');
            END;
            CREATE TRIGGER IF NOT EXISTS kardex_no_delete
            BEFORE DELETE ON kardex_entries
            BEGIN
                SELECT RAISE(ABORT, 'Kardex append-only: DELETE no permitido');
            END;

            CREATE TABLE IF NOT EXISTS store_meta (
                meta_key TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            );
            """
        )

    def _load_or_create_local_kek(self) -> bytes:
        if self.local_key_path.is_file():
            raw = self.local_key_path.read_bytes()
            if raw.startswith(b"DPAPI1:"):
                unpacked = _dpapi_unprotect(raw[7:])
                if unpacked and len(unpacked) == SQLITE_DEK_BYTES:
                    return unpacked
            elif raw.startswith(b"RAW1:") and len(raw) == 5 + SQLITE_DEK_BYTES:
                return raw[5:]
            raise StateStoreError("La llave local de cifrado SQLite (.sqlite_local.key) está dañada.")

        kek = os.urandom(SQLITE_DEK_BYTES)
        protected = _dpapi_protect(kek)
        if protected is not None:
            _write_restrictive_bytes(self.local_key_path, b"DPAPI1:" + protected)
        else:
            _write_restrictive_bytes(self.local_key_path, b"RAW1:" + kek)
        return kek

    @staticmethod
    def _load_keystore_from_conn(conn: sqlite3.Connection) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT meta_value FROM store_meta WHERE meta_key = ?",
            (SQLITE_KEYSTORE_META_KEY,),
        ).fetchone()
        if not row:
            return None
        ks = json.loads(row["meta_value"])
        if (
            not isinstance(ks, dict)
            or ks.get("format") != SQLITE_KEYSTORE_FORMAT
            or ks.get("version") != SQLITE_KEYSTORE_VERSION
            or not isinstance(ks.get("kid"), str)
        ):
            raise StateStoreError("El almacén de llaves SQLite tiene un formato no válido.")
        return ks

    @staticmethod
    def _save_keystore_to_conn(conn: sqlite3.Connection, ks: dict[str, Any]) -> None:
        conn.execute(
            "INSERT INTO store_meta(meta_key, meta_value) VALUES (?, ?) "
            "ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value",
            (SQLITE_KEYSTORE_META_KEY, json.dumps(ks, ensure_ascii=False, separators=(",", ":"))),
        )

    def _encrypt_plaintext_snapshots(self, conn: sqlite3.Connection, dek: bytes, kid: str) -> None:
        rows = conn.execute("SELECT id, state_key, snapshot_version, payload_json FROM state_snapshots").fetchall()
        for row in rows:
            raw_text = row["payload_json"]
            if _parse_encrypted_envelope(raw_text) is not None:
                continue
            aad = _snapshot_aad(kid, row["state_key"], int(row["snapshot_version"]))
            enc_text = _encrypt_json_payload(dek, kid, raw_text, aad)
            conn.execute(
                "UPDATE state_snapshots SET payload_json = ? WHERE id = ?",
                (enc_text, int(row["id"])),
            )

    def _initialise(self) -> None:
        conn = self._connect()
        try:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            ks = self._load_keystore_from_conn(conn)
            if ks is None:
                kid = os.urandom(16).hex()
                dek = os.urandom(SQLITE_DEK_BYTES)
                local_kek = self._load_or_create_local_kek()
                iv = os.urandom(SQLITE_IV_BYTES)
                ct = AESGCM(local_kek).encrypt(iv, dek, _local_wrap_aad(kid))
                ks = {
                    "format": SQLITE_KEYSTORE_FORMAT,
                    "version": SQLITE_KEYSTORE_VERSION,
                    "mode": "local-key",
                    "kid": kid,
                    "cipher": SQLITE_ENC_ALG,
                    "wrappedLocal": {"iv": _b64_encode(iv), "ct": _b64_encode(ct)},
                    "slots": [],
                }
                self._save_keystore_to_conn(conn, ks)
                self._encrypt_plaintext_snapshots(conn, dek, kid)
                conn.commit()
                self._dek = dek
                self._kid = kid
                self._mode = "local-key"
                return

            mode = ks.get("mode", "local-key")
            kid = ks["kid"]
            if mode == "pin":
                conn.commit()
                self._dek = None
                self._kid = kid
                self._mode = "pin"
                self.local_key_path.unlink(missing_ok=True)
                return

            wrapped = ks.get("wrappedLocal")
            if not isinstance(wrapped, dict) or "iv" not in wrapped or "ct" not in wrapped:
                raise StateStoreError("Falta la envoltura local de la llave SQLite.")
            local_kek = self._load_or_create_local_kek()
            try:
                dek = AESGCM(local_kek).decrypt(
                    _b64_decode(wrapped["iv"]),
                    _b64_decode(wrapped["ct"]),
                    _local_wrap_aad(kid),
                )
            except (InvalidTag, ValueError) as exc:
                raise StateStoreError("No se pudo abrir la llave local de SQLite.") from exc
            if len(dek) != SQLITE_DEK_BYTES:
                raise StateStoreError("Longitud de llave de datos SQLite inválida.")
            self._encrypt_plaintext_snapshots(conn, dek, kid)
            conn.commit()
            self._dek = dek
            self._kid = kid
            self._mode = "local-key"
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def is_locked(self) -> bool:
        return self._mode == "pin" and self._dek is None

    def _require_unlocked(self) -> tuple[bytes, str]:
        if self.is_locked() or self._dek is None or self._kid is None:
            raise DatabaseLockedError("La base de datos está cifrada con PIN y bloqueada.")
        return self._dek, self._kid

    def crypto_status(self) -> dict[str, Any]:
        conn = self._connect()
        try:
            ks = self._load_keystore_from_conn(conn) or {}
            slots = [
                {"slotId": str(s.get("slotId", "")), "iterations": int(s.get("iterations", 0))}
                for s in (ks.get("slots") or [])
                if isinstance(s, dict)
            ]
            mode = str(ks.get("mode", self._mode))
            return {
                "mode": mode,
                "configured": mode == "pin",
                "unlocked": self._dek is not None,
                "slots": slots,
            }
        finally:
            conn.close()

    def configure_pin_encryption(
        self,
        slot_id: str,
        pin: str,
        *,
        iterations: int | None = None,
    ) -> dict[str, Any]:
        clean_slot = str(slot_id or "").strip()
        clean_pin = str(pin or "").strip()
        if not clean_slot or not clean_pin:
            raise StateStoreError("Se requiere identificador de administrador y PIN válidos.")
        iters = iterations if iterations is not None else self._pin_iterations

        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ks = self._load_keystore_from_conn(conn)
            if not ks:
                raise StateStoreError("Almacén de llaves SQLite no inicializado.")
            if ks.get("mode") == "pin":
                raise StateStoreError("El cifrado por PIN de SQLite ya está configurado.")
            dek, kid = self._require_unlocked()
            self._encrypt_plaintext_snapshots(conn, dek, kid)

            salt = os.urandom(SQLITE_SALT_BYTES)
            iv = os.urandom(SQLITE_IV_BYTES)
            kek = _derive_pin_kek(clean_pin, salt, iters)
            wrapped_key = AESGCM(kek).encrypt(iv, dek, _slot_aad(kid, clean_slot))
            slot = {
                "slotId": clean_slot,
                "kdf": "PBKDF2-HMAC-SHA256",
                "iterations": iters,
                "salt": _b64_encode(salt),
                "iv": _b64_encode(iv),
                "wrappedKey": _b64_encode(wrapped_key),
            }
            next_ks = {
                "format": SQLITE_KEYSTORE_FORMAT,
                "version": SQLITE_KEYSTORE_VERSION,
                "mode": "pin",
                "kid": kid,
                "cipher": SQLITE_ENC_ALG,
                "slots": [slot],
            }
            self._save_keystore_to_conn(conn, next_ks)
            conn.commit()
            self._mode = "pin"
            self.local_key_path.unlink(missing_ok=True)
            return self.crypto_status()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def unlock_with_pin(self, pin: str) -> tuple[bool, str | None]:
        clean_pin = str(pin or "").strip()
        if not clean_pin:
            return False, None
        conn = self._connect()
        try:
            ks = self._load_keystore_from_conn(conn)
            if not ks:
                return False, None
            if ks.get("mode") != "pin":
                return (self._dek is not None), "local-key"
            kid = ks["kid"]
            for slot in ks.get("slots") or []:
                try:
                    salt = _b64_decode(slot["salt"])
                    iv = _b64_decode(slot["iv"])
                    wrapped = _b64_decode(slot["wrappedKey"])
                    iters = int(slot.get("iterations") or self._pin_iterations)
                    kek = _derive_pin_kek(clean_pin, salt, iters)
                    dek = AESGCM(kek).decrypt(iv, wrapped, _slot_aad(kid, slot["slotId"]))
                    if len(dek) == SQLITE_DEK_BYTES:
                        self._dek = dek
                        self._kid = kid
                        self._mode = "pin"
                        self.local_key_path.unlink(missing_ok=True)
                        return True, str(slot["slotId"])
                except (InvalidTag, ValueError, KeyError):
                    continue
            return False, None
        finally:
            conn.close()

    def lock(self) -> None:
        if self._mode == "pin":
            self._dek = None

    def set_pin_slot(
        self,
        slot_id: str,
        pin: str,
        *,
        iterations: int | None = None,
    ) -> dict[str, Any]:
        dek, kid = self._require_unlocked()
        clean_slot = str(slot_id or "").strip()
        clean_pin = str(pin or "").strip()
        if not clean_slot or not clean_pin:
            raise StateStoreError("Identificador de administrador o PIN inválido.")
        iters = iterations if iterations is not None else self._pin_iterations

        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ks = self._load_keystore_from_conn(conn)
            if not ks or ks.get("mode") != "pin":
                raise StateStoreError("El cifrado por PIN de SQLite aún no está configurado.")
            salt = os.urandom(SQLITE_SALT_BYTES)
            iv = os.urandom(SQLITE_IV_BYTES)
            kek = _derive_pin_kek(clean_pin, salt, iters)
            wrapped_key = AESGCM(kek).encrypt(iv, dek, _slot_aad(kid, clean_slot))
            new_slot = {
                "slotId": clean_slot,
                "kdf": "PBKDF2-HMAC-SHA256",
                "iterations": iters,
                "salt": _b64_encode(salt),
                "iv": _b64_encode(iv),
                "wrappedKey": _b64_encode(wrapped_key),
            }
            existing_slots = [s for s in (ks.get("slots") or []) if s.get("slotId") != clean_slot]
            existing_slots.append(new_slot)
            ks["slots"] = existing_slots
            self._save_keystore_to_conn(conn, ks)
            conn.commit()
            return self.crypto_status()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def remove_pin_slot(self, slot_id: str) -> bool:
        self._require_unlocked()
        clean_slot = str(slot_id or "").strip()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ks = self._load_keystore_from_conn(conn)
            if not ks or ks.get("mode") != "pin":
                conn.commit()
                return False
            slots = list(ks.get("slots") or [])
            if not any(s.get("slotId") == clean_slot for s in slots):
                conn.commit()
                return False
            if len(slots) <= 1:
                raise StateStoreError("No se puede eliminar la última llave de administrador en SQLite.")
            ks["slots"] = [s for s in slots if s.get("slotId") != clean_slot]
            self._save_keystore_to_conn(conn, ks)
            conn.commit()
            return True
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def reset_with_new_pin(
        self,
        slot_id: str,
        pin: str,
        *,
        iterations: int | None = None,
    ) -> dict[str, Any]:
        """Elimina la base cifrada irrecuperable (PIN olvidado) y crea una nueva protegida con el PIN nuevo."""
        clean_slot = str(slot_id or "").strip()
        clean_pin = str(pin or "").strip()
        if not clean_slot or not clean_pin:
            raise StateStoreError("Se requiere identificador de administrador y PIN nuevo válidos.")
        iters = iterations if iterations is not None else self._pin_iterations

        self.local_key_path.unlink(missing_ok=True)
        Path(str(self.database_path) + "-wal").unlink(missing_ok=True)
        Path(str(self.database_path) + "-shm").unlink(missing_ok=True)
        self.database_path.unlink(missing_ok=True)

        kid = os.urandom(16).hex()
        dek = os.urandom(SQLITE_DEK_BYTES)
        salt = os.urandom(SQLITE_SALT_BYTES)
        iv = os.urandom(SQLITE_IV_BYTES)
        kek = _derive_pin_kek(clean_pin, salt, iters)
        wrapped_key = AESGCM(kek).encrypt(iv, dek, _slot_aad(kid, clean_slot))
        ks = {
            "format": SQLITE_KEYSTORE_FORMAT,
            "version": SQLITE_KEYSTORE_VERSION,
            "mode": "pin",
            "kid": kid,
            "cipher": SQLITE_ENC_ALG,
            "slots": [
                {
                    "slotId": clean_slot,
                    "kdf": "PBKDF2-HMAC-SHA256",
                    "iterations": iters,
                    "salt": _b64_encode(salt),
                    "iv": _b64_encode(iv),
                    "wrappedKey": _b64_encode(wrapped_key),
                }
            ],
        }
        conn = self._connect()
        try:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            self._save_keystore_to_conn(conn, ks)
            conn.commit()
            self._dek = dek
            self._kid = kid
            self._mode = "pin"
            return self.crypto_status()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def _is_main_state_key(state_key: str) -> bool:
        return state_key.startswith("binnitech_pos_state_v")

    @staticmethod
    def _json_payload(value: Any) -> str:
        try:
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise StateStoreError("El estado proporcionado no es JSON serializable.") from exc

    def _decode_snapshot_payload(self, raw_payload: str, state_key: str, snapshot_version: int) -> str:
        env = _parse_encrypted_envelope(raw_payload)
        if env is None:
            return raw_payload
        dek, kid = self._require_unlocked()
        return _decrypt_envelope(dek, kid, env, _snapshot_aad(kid, state_key, snapshot_version))

    def _decode_kardex_payload(
        self,
        raw_payload: str,
        entry_id: str,
        previous_hash: str,
        entry_hash: str,
    ) -> dict[str, Any]:
        env = _parse_encrypted_envelope(raw_payload)
        if env is not None:
            dek, kid = self._require_unlocked()
            try:
                plain_text = _decrypt_envelope(dek, kid, env, _kardex_aad(kid, entry_id, previous_hash, entry_hash))
            except StateStoreError as exc:
                raise KardexIntegrityError(f"La entrada Kardex cifrada #{entry_id} no pasó autenticación.") from exc
        else:
            plain_text = raw_payload
        try:
            obj = json.loads(plain_text)
        except (TypeError, ValueError) as exc:
            raise KardexIntegrityError("La tabla append-only del Kardex contiene JSON inválido.") from exc
        if not isinstance(obj, dict):
            raise KardexIntegrityError("Entrada de Kardex corrupta en SQLite.")
        return obj

    def _verify_existing_ledger(self, conn: sqlite3.Connection) -> list[tuple[sqlite3.Row, dict[str, Any]]]:
        rows = conn.execute(
            "SELECT sequence, entry_id, previous_hash, entry_hash, payload_json "
            "FROM kardex_entries ORDER BY sequence ASC"
        ).fetchall()
        previous_hash = "GENESIS"
        decoded_rows: list[tuple[sqlite3.Row, dict[str, Any]]] = []
        for row in rows:
            entry = self._decode_kardex_payload(
                row["payload_json"],
                row["entry_id"],
                row["previous_hash"],
                row["entry_hash"],
            )
            if (
                entry.get("id") != row["entry_id"]
                or entry.get("previousHash") != previous_hash
                or entry.get("previousHash") != row["previous_hash"]
                or entry.get("entryHash") != row["entry_hash"]
                or compute_kardex_hash(entry) != row["entry_hash"]
            ):
                raise KardexIntegrityError(
                    f"La cadena de hashes almacenada está rota en la secuencia {row['sequence']}."
                )
            previous_hash = row["entry_hash"]
            decoded_rows.append((row, entry))
        return decoded_rows

    def _append_and_verify_kardex(
        self, conn: sqlite3.Connection, entries_newest_first: list[dict[str, Any]]
    ) -> None:
        dek, kid = self._require_unlocked()
        incoming = verify_kardex_chain(entries_newest_first)
        stored_pairs = self._verify_existing_ledger(conn)

        if len(incoming) < len(stored_pairs):
            raise KardexIntegrityError(
                "El Kardex recibido elimina movimientos que ya están confirmados en SQLite."
            )

        for index, (row, stored_entry) in enumerate(stored_pairs):
            entry = incoming[index]
            incoming_payload = self._json_payload(entry)
            stored_canonical = self._json_payload(stored_entry)
            if (
                entry.get("id") != row["entry_id"]
                or entry.get("entryHash") != row["entry_hash"]
                or incoming_payload != stored_canonical
            ):
                raise KardexIntegrityError(
                    "El Kardex recibido modifica o reordena movimientos ya confirmados en SQLite."
                )

        # Solo se insertan los elementos posteriores al último hash confirmado, cifrados con AES-256-GCM.
        for entry in incoming[len(stored_pairs) :]:
            entry_id = entry["id"]
            prev_hash = entry["previousHash"]
            entry_hash = entry["entryHash"]
            plain_json = self._json_payload(entry)
            encrypted_json = _encrypt_json_payload(
                dek,
                kid,
                plain_json,
                _kardex_aad(kid, entry_id, prev_hash, entry_hash),
            )
            try:
                conn.execute(
                    "INSERT INTO kardex_entries(entry_id, previous_hash, entry_hash, payload_json) "
                    "VALUES (?, ?, ?, ?)",
                    (entry_id, prev_hash, entry_hash, encrypted_json),
                )
            except sqlite3.IntegrityError as exc:
                raise KardexIntegrityError(
                    f"No se pudo anexar el movimiento {entry_id}: ID duplicado o cadena concurrente."
                ) from exc

    def _save_in_transaction(self, conn: sqlite3.Connection, state_key: str, value: Any) -> int:
        dek, kid = self._require_unlocked()
        payload_json = self._json_payload(value)
        if self._is_main_state_key(state_key) and isinstance(value, dict):
            kardex = value.get("kardex", [])
            if not isinstance(kardex, list):
                raise KardexIntegrityError("La colección Kardex debe ser un arreglo.")
            self._append_and_verify_kardex(conn, kardex)

        row = conn.execute(
            "SELECT COALESCE(MAX(snapshot_version), 0) AS max_version "
            "FROM state_snapshots WHERE state_key = ?",
            (state_key,),
        ).fetchone()
        next_version = int(row["max_version"]) + 1
        schema_version = value.get("schemaVersion") if isinstance(value, dict) else None
        state_timestamp = value.get("timestamp") if isinstance(value, dict) else None
        encrypted_payload = _encrypt_json_payload(
            dek,
            kid,
            payload_json,
            _snapshot_aad(kid, state_key, next_version),
        )
        conn.execute(
            "INSERT INTO state_snapshots(state_key, snapshot_version, schema_version, state_timestamp, payload_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (state_key, next_version, schema_version, state_timestamp, encrypted_payload),
        )
        return next_version

    def save(self, state_key: str, value: Any) -> int:
        if not isinstance(state_key, str) or not state_key or len(state_key) > 256:
            raise StateStoreError("Clave de almacenamiento inválida.")
        self._require_unlocked()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            version = self._save_in_transaction(conn, state_key, value)
            conn.commit()
            return version
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def migrate(self, state_key: str, value: Any) -> tuple[bool, Any, int]:
        """Importa IndexedDB solo cuando la clave aún no existe en el servidor."""
        if not isinstance(state_key, str) or not state_key or len(state_key) > 256:
            raise StateStoreError("Clave de almacenamiento inválida.")
        self._require_unlocked()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload_json, snapshot_version FROM state_snapshots "
                "WHERE state_key = ? ORDER BY snapshot_version DESC LIMIT 1",
                (state_key,),
            ).fetchone()
            if row:
                snap_ver = int(row["snapshot_version"])
                plain = self._decode_snapshot_payload(row["payload_json"], state_key, snap_ver)
                conn.commit()
                return False, json.loads(plain), snap_ver
            version = self._save_in_transaction(conn, state_key, value)
            conn.commit()
            return True, value, version
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def load_with_version(self, state_key: str) -> tuple[Any | None, int]:
        self._require_unlocked()
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT payload_json, snapshot_version FROM state_snapshots "
                "WHERE state_key = ? ORDER BY snapshot_version DESC LIMIT 1",
                (state_key,),
            ).fetchone()
            if not row:
                return None, 0
            snap_ver = int(row["snapshot_version"])
            plain = self._decode_snapshot_payload(row["payload_json"], state_key, snap_ver)
            return json.loads(plain), snap_ver
        finally:
            conn.close()

    def load(self, state_key: str) -> Any | None:
        return self.load_with_version(state_key)[0]

    def delete(self, state_key: str) -> None:
        self._require_unlocked()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM state_snapshots WHERE state_key = ?", (state_key,))
            conn.commit()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def list_keys(self, prefix: str | None = None) -> list[str]:
        conn = self._connect()
        try:
            if prefix:
                rows = conn.execute(
                    "SELECT DISTINCT state_key FROM state_snapshots "
                    "WHERE state_key LIKE ? ESCAPE '\\' ORDER BY state_key",
                    (self._escape_like(prefix) + "%",),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT DISTINCT state_key FROM state_snapshots ORDER BY state_key"
                ).fetchall()
            return [str(row["state_key"]) for row in rows]
        finally:
            conn.close()

    @staticmethod
    def _escape_like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    def clear(self) -> None:
        """Elimina snapshots, pero conserva el Kardex append-only como libro histórico."""
        self._require_unlocked()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM state_snapshots")
            conn.commit()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def backup_bytes(self) -> bytes:
        """Crea una copia SQLite portable (descifrada) para incluirse dentro del respaldo .bak cifrado."""
        self._require_unlocked()
        fd, temp_name = tempfile.mkstemp(prefix="state-backup-", suffix=".sqlite3", dir=self.database_path.parent)
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            source = self._connect()
            target = sqlite3.connect(temp_path)
            try:
                self._ensure_schema(target)
                source.execute("BEGIN")
                k_rows = source.execute(
                    "SELECT sequence, entry_id, previous_hash, entry_hash, payload_json, created_at "
                    "FROM kardex_entries ORDER BY sequence ASC"
                ).fetchall()
                for row in k_rows:
                    entry = self._decode_kardex_payload(
                        row["payload_json"],
                        row["entry_id"],
                        row["previous_hash"],
                        row["entry_hash"],
                    )
                    target.execute(
                        "INSERT INTO kardex_entries(sequence, entry_id, previous_hash, entry_hash, payload_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            int(row["sequence"]),
                            row["entry_id"],
                            row["previous_hash"],
                            row["entry_hash"],
                            self._json_payload(entry),
                            row["created_at"],
                        ),
                    )
                s_rows = source.execute(
                    "SELECT id, state_key, snapshot_version, schema_version, state_timestamp, payload_json, created_at "
                    "FROM state_snapshots ORDER BY id ASC"
                ).fetchall()
                for row in s_rows:
                    plain = self._decode_snapshot_payload(
                        row["payload_json"],
                        row["state_key"],
                        int(row["snapshot_version"]),
                    )
                    target.execute(
                        "INSERT INTO state_snapshots(id, state_key, snapshot_version, schema_version, state_timestamp, payload_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            int(row["id"]),
                            row["state_key"],
                            int(row["snapshot_version"]),
                            row["schema_version"],
                            row["state_timestamp"],
                            plain,
                            row["created_at"],
                        ),
                    )
                target.commit()
                source.commit()
            finally:
                target.close()
                source.close()
            return temp_path.read_bytes()
        finally:
            temp_path.unlink(missing_ok=True)

    def restore_bytes(self, database_bytes: bytes) -> None:
        """Valida, re-cifra bajo la llave activa y sustituye atómicamente el SQLite restaurado desde un .bak."""
        if not isinstance(database_bytes, (bytes, bytearray)) or not database_bytes:
            raise StateStoreError("El respaldo no contiene una base SQLite válida.")
        dek, kid = self._require_unlocked()

        fd_in, temp_in_name = tempfile.mkstemp(
            prefix=".restore-in-", suffix=".sqlite3", dir=self.database_path.parent
        )
        os.close(fd_in)
        temp_in = Path(temp_in_name)

        fd_out, temp_out_name = tempfile.mkstemp(
            prefix=".restore-out-", suffix=".sqlite3", dir=self.database_path.parent
        )
        os.close(fd_out)
        temp_out = Path(temp_out_name)

        try:
            temp_in.write_bytes(bytes(database_bytes))
            check = sqlite3.connect(temp_in)
            check.row_factory = sqlite3.Row
            out_conn = sqlite3.connect(temp_out)
            try:
                result = check.execute("PRAGMA integrity_check").fetchone()
                if not result or result[0] != "ok":
                    raise StateStoreError("La base SQLite del respaldo no superó integrity_check.")
                tables = {
                    row[0]
                    for row in check.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if not {"state_snapshots", "kardex_entries"}.issubset(tables):
                    raise StateStoreError("El respaldo no contiene las tablas de estado requeridas.")
                snapshot_columns = {
                    row[1] for row in check.execute("PRAGMA table_info(state_snapshots)").fetchall()
                }
                kardex_columns = {
                    row[1] for row in check.execute("PRAGMA table_info(kardex_entries)").fetchall()
                }
                if not {"state_key", "snapshot_version", "payload_json"}.issubset(snapshot_columns):
                    raise StateStoreError("La tabla de snapshots del respaldo no tiene el esquema esperado.")
                if not {"sequence", "entry_id", "previous_hash", "entry_hash", "payload_json"}.issubset(kardex_columns):
                    raise StateStoreError("La tabla Kardex del respaldo no tiene el esquema esperado.")

                # Leer keystore actual para preservar la configuración de cifrado del equipo
                cur_conn = self._connect()
                try:
                    current_ks = self._load_keystore_from_conn(cur_conn)
                finally:
                    cur_conn.close()

                self._ensure_schema(out_conn)
                if current_ks is not None:
                    self._save_keystore_to_conn(out_conn, current_ks)

                k_rows = check.execute(
                    "SELECT sequence, entry_id, previous_hash, entry_hash, payload_json, created_at "
                    "FROM kardex_entries ORDER BY sequence ASC"
                ).fetchall()
                previous_hash = "GENESIS"
                for row in k_rows:
                    entry = self._decode_kardex_payload(
                        row["payload_json"],
                        row["entry_id"],
                        row["previous_hash"],
                        row["entry_hash"],
                    )
                    if (
                        entry.get("id") != row["entry_id"]
                        or entry.get("previousHash") != previous_hash
                        or row["previous_hash"] != previous_hash
                        or entry.get("entryHash") != row["entry_hash"]
                        or compute_kardex_hash(entry) != row["entry_hash"]
                    ):
                        raise KardexIntegrityError(
                            f"El respaldo contiene una cadena Kardex rota en la secuencia {row['sequence']}."
                        )
                    previous_hash = row["entry_hash"]
                    enc_kardex = _encrypt_json_payload(
                        dek,
                        kid,
                        self._json_payload(entry),
                        _kardex_aad(kid, row["entry_id"], row["previous_hash"], row["entry_hash"]),
                    )
                    out_conn.execute(
                        "INSERT INTO kardex_entries(sequence, entry_id, previous_hash, entry_hash, payload_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            int(row["sequence"]),
                            row["entry_id"],
                            row["previous_hash"],
                            row["entry_hash"],
                            enc_kardex,
                            row["created_at"],
                        ),
                    )

                s_rows = check.execute(
                    "SELECT id, state_key, snapshot_version, schema_version, state_timestamp, payload_json, created_at "
                    "FROM state_snapshots ORDER BY id ASC"
                ).fetchall()
                for row in s_rows:
                    plain = self._decode_snapshot_payload(
                        row["payload_json"],
                        row["state_key"],
                        int(row["snapshot_version"]),
                    )
                    enc_snap = _encrypt_json_payload(
                        dek,
                        kid,
                        plain,
                        _snapshot_aad(kid, row["state_key"], int(row["snapshot_version"])),
                    )
                    out_conn.execute(
                        "INSERT INTO state_snapshots(id, state_key, snapshot_version, schema_version, state_timestamp, payload_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            int(row["id"]),
                            row["state_key"],
                            int(row["snapshot_version"]),
                            row["schema_version"],
                            row["state_timestamp"],
                            enc_snap,
                            row["created_at"],
                        ),
                    )
                out_conn.commit()
            finally:
                out_conn.close()
                check.close()

            # No deben sobrevivir archivos WAL del estado anterior junto a la nueva base.
            Path(str(self.database_path) + "-wal").unlink(missing_ok=True)
            Path(str(self.database_path) + "-shm").unlink(missing_ok=True)
            os.replace(temp_out, self.database_path)
            if current_ks and current_ks.get("mode") == "pin":
                self._dek = dek
                self._kid = kid
                self._mode = "pin"
            else:
                self._initialise()
        finally:
            temp_in.unlink(missing_ok=True)
            temp_out.unlink(missing_ok=True)
