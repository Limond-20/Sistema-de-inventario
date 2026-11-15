"""Persistencia SQLite de la PC: snapshots versionados y Kardex append-only."""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any


class StateStoreError(Exception):
    """Error base de persistencia del estado."""


class KardexIntegrityError(StateStoreError):
    """El Kardex recibido no continúa íntegramente la cadena almacenada."""


class SnapshotNotFoundError(StateStoreError):
    """No existe un snapshot para la clave solicitada."""


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
        integer_part, dot, fractional_part = unsigned.partition(".")
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
    """SQLite durable con transacciones serializadas y Kardex físicamente append-only."""

    def __init__(self, database_path: Path, *, timeout_seconds: float = 15.0) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.timeout_seconds = timeout_seconds
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

    def _initialise(self) -> None:
        conn = self._connect()
        try:
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
                """
            )
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

    def _verify_existing_ledger(self, conn: sqlite3.Connection) -> list[sqlite3.Row]:
        rows = conn.execute(
            "SELECT sequence, entry_id, previous_hash, entry_hash, payload_json "
            "FROM kardex_entries ORDER BY sequence ASC"
        ).fetchall()
        previous_hash = "GENESIS"
        for row in rows:
            try:
                entry = json.loads(row["payload_json"])
            except (TypeError, ValueError) as exc:
                raise KardexIntegrityError("La tabla append-only del Kardex contiene JSON inválido.") from exc
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
        return rows

    def _append_and_verify_kardex(
        self, conn: sqlite3.Connection, entries_newest_first: list[dict[str, Any]]
    ) -> None:
        incoming = verify_kardex_chain(entries_newest_first)
        stored_rows = self._verify_existing_ledger(conn)

        if len(incoming) < len(stored_rows):
            raise KardexIntegrityError(
                "El Kardex recibido elimina movimientos que ya están confirmados en SQLite."
            )

        for index, row in enumerate(stored_rows):
            entry = incoming[index]
            incoming_payload = self._json_payload(entry)
            if (
                entry.get("id") != row["entry_id"]
                or entry.get("entryHash") != row["entry_hash"]
                or incoming_payload != row["payload_json"]
            ):
                raise KardexIntegrityError(
                    "El Kardex recibido modifica o reordena movimientos ya confirmados en SQLite."
                )

        # Solo se insertan los elementos posteriores al último hash confirmado.
        for entry in incoming[len(stored_rows) :]:
            try:
                conn.execute(
                    "INSERT INTO kardex_entries(entry_id, previous_hash, entry_hash, payload_json) "
                    "VALUES (?, ?, ?, ?)",
                    (
                        entry["id"],
                        entry["previousHash"],
                        entry["entryHash"],
                        self._json_payload(entry),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise KardexIntegrityError(
                    f"No se pudo anexar el movimiento {entry.get('id')}: ID duplicado o cadena concurrente."
                ) from exc

    def _save_in_transaction(self, conn: sqlite3.Connection, state_key: str, value: Any) -> int:
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
        conn.execute(
            "INSERT INTO state_snapshots(state_key, snapshot_version, schema_version, state_timestamp, payload_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (state_key, next_version, schema_version, state_timestamp, payload_json),
        )
        return next_version

    def save(self, state_key: str, value: Any) -> int:
        if not isinstance(state_key, str) or not state_key or len(state_key) > 256:
            raise StateStoreError("Clave de almacenamiento inválida.")
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            version = self._save_in_transaction(conn, state_key, value)
            conn.commit()
            return version
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def migrate(self, state_key: str, value: Any) -> tuple[bool, Any, int]:
        """Importa IndexedDB solo cuando la clave aún no existe en el servidor."""
        if not isinstance(state_key, str) or not state_key or len(state_key) > 256:
            raise StateStoreError("Clave de almacenamiento inválida.")
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload_json, snapshot_version FROM state_snapshots "
                "WHERE state_key = ? ORDER BY snapshot_version DESC LIMIT 1",
                (state_key,),
            ).fetchone()
            if row:
                conn.commit()
                return False, json.loads(row["payload_json"]), int(row["snapshot_version"])
            version = self._save_in_transaction(conn, state_key, value)
            conn.commit()
            return True, value, version
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def load_with_version(self, state_key: str) -> tuple[Any | None, int]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT payload_json, snapshot_version FROM state_snapshots "
                "WHERE state_key = ? ORDER BY snapshot_version DESC LIMIT 1",
                (state_key,),
            ).fetchone()
            if not row:
                return None, 0
            return json.loads(row["payload_json"]), int(row["snapshot_version"])
        finally:
            conn.close()

    def load(self, state_key: str) -> Any | None:
        return self.load_with_version(state_key)[0]

    def delete(self, state_key: str) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM state_snapshots WHERE state_key = ?", (state_key,))
            conn.commit()
        except Exception:
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
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM state_snapshots")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def backup_bytes(self) -> bytes:
        """Crea una copia consistente de SQLite, incluyendo datos y esquema, vía API backup."""
        fd, temp_name = tempfile.mkstemp(prefix="state-backup-", suffix=".sqlite3", dir=self.database_path.parent)
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            source = self._connect()
            target = sqlite3.connect(temp_path)
            try:
                source.backup(target)
            finally:
                target.close()
                source.close()
            return temp_path.read_bytes()
        finally:
            temp_path.unlink(missing_ok=True)

    def restore_bytes(self, database_bytes: bytes) -> None:
        """Valida y sustituye atómicamente el archivo SQLite restaurado desde un .bak autenticado."""
        if not isinstance(database_bytes, (bytes, bytearray)) or not database_bytes:
            raise StateStoreError("El respaldo no contiene una base SQLite válida.")
        fd, temp_name = tempfile.mkstemp(
            prefix=".restore-state-", suffix=".sqlite3", dir=self.database_path.parent
        )
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            temp_path.write_bytes(bytes(database_bytes))
            check = sqlite3.connect(temp_path)
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
                rows = check.execute(
                    "SELECT sequence, entry_id, previous_hash, entry_hash, payload_json "
                    "FROM kardex_entries ORDER BY sequence ASC"
                ).fetchall()
                previous_hash = "GENESIS"
                for row in rows:
                    entry = json.loads(row[4])
                    if (
                        entry.get("id") != row[1]
                        or entry.get("previousHash") != previous_hash
                        or row[2] != previous_hash
                        or entry.get("entryHash") != row[3]
                        or compute_kardex_hash(entry) != row[3]
                    ):
                        raise KardexIntegrityError(
                            f"El respaldo contiene una cadena Kardex rota en la secuencia {row[0]}."
                        )
                    previous_hash = row[3]
            finally:
                check.close()
            # No deben sobrevivir archivos WAL del estado anterior junto a la nueva base.
            Path(str(self.database_path) + "-wal").unlink(missing_ok=True)
            Path(str(self.database_path) + "-shm").unlink(missing_ok=True)
            os.replace(temp_path, self.database_path)
            # Reafirma WAL e instala triggers append-only aun en una copia de versión anterior.
            self._initialise()
        finally:
            temp_path.unlink(missing_ok=True)
