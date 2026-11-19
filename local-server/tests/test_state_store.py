"""Pruebas Bloque N: concurrencia, Kardex append-only, migración y recuperación SQLite."""
from __future__ import annotations

import concurrent.futures
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lansync.state_store import (
    DatabaseLockedError,
    KardexIntegrityError,
    SQLiteStateStore,
    StateStoreError,
    compute_kardex_hash,
)
from lansync.server import create_app

STATE_KEY = "binnitech_pos_state_v5"


def make_entry(entry_id: str, previous_hash: str, amount: int = 25) -> dict:
    entry = {
        "id": entry_id,
        "timestamp": "2026-11-15T10:00:00.000Z",
        "type": "ENTRADA_COMPRA",
        "producto": {"sku": "SKU-1", "name": "Producto de prueba"},
        "cantidad": 1,
        "saldoAnterior": 0,
        "saldoResultante": 1,
        "usuario": "Administrador",
        "referencia": f"REF-{entry_id}",
        "amount": amount,
        "amountCents": amount * 100,
        "previousHash": previous_hash,
    }
    entry["entryHash"] = compute_kardex_hash(entry)
    return entry


def test_hash_compatible_con_json_stringify_de_typescript_para_cantidades_decimales():
    entry = {
        "id": "K-X",
        "timestamp": "2026-11-15T10:00:00.000Z",
        "type": "ENTRADA_COMPRA",
        "producto": {"sku": "SKU", "name": "x"},
        "cantidad": 0.00005,
        "saldoAnterior": 0,
        "saldoResultante": 0.00005,
        "usuario": "A",
        "referencia": "R",
        "amount": 0.00005,
        "previousHash": "GENESIS",
    }
    # Vector calculado con computeKardexHash() de abarrotes-app/src/app/domain/kardex.ts.
    assert compute_kardex_hash(entry) == (
        "cb132a8b25e3e380ed455bd8148ed8e1926e2da4bcaa5b45c26f65725e42819c"
    )


def make_state(entries_newest_first: list[dict] | None = None, revision: int = 1) -> dict:
    return {
        "schemaVersion": 5,
        "timestamp": "2026-11-15T10:00:00.000Z",
        "activeUser": "Administrador",
        "revision": revision,
        "products": [],
        "creditCustomers": [],
        "kardex": entries_newest_first or [],
        "shrinkRecords": [],
        "auditLines": [],
    }


@pytest.fixture()
def store(tmp_path: Path) -> SQLiteStateStore:
    return SQLiteStateStore(tmp_path / "data" / "inventory.sqlite3")


def test_concurrencia_crea_snapshots_versionados_sin_perder_escrituras(store: SQLiteStateStore):
    total = 32

    def write(revision: int) -> int:
        return store.save("prueba_concurrencia", {"revision": revision, "kardex": []})

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        versions = list(pool.map(write, range(total)))

    assert sorted(versions) == list(range(1, total + 1))
    loaded, current_version = store.load_with_version("prueba_concurrencia")
    assert current_version == total
    assert 0 <= loaded["revision"] < total
    with sqlite3.connect(store.database_path) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM state_snapshots WHERE state_key = ?", ("prueba_concurrencia",)
        ).fetchone()[0] == total


def test_concurrencia_no_duplica_un_movimiento_si_llegan_dos_guardados_iguales(store: SQLiteStateStore):
    entry = make_entry("K-CONCURRENT", "GENESIS")
    state = make_state([entry])

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        versions = list(pool.map(lambda _: store.save(STATE_KEY, state), range(2)))

    assert sorted(versions) == [1, 2]
    with sqlite3.connect(store.database_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM kardex_entries").fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM state_snapshots WHERE state_key = ?", (STATE_KEY,)
        ).fetchone()[0] == 2


def test_rechaza_cadena_kardex_rota_y_no_guarda_snapshot_ni_movimientos(store: SQLiteStateStore):
    first = make_entry("K-1", "GENESIS")
    tampered = {**first, "cantidad": 99}  # entryHash ya no corresponde con los datos
    state = make_state([tampered])

    with pytest.raises(KardexIntegrityError, match="hash"):
        store.save(STATE_KEY, state)

    assert store.load(STATE_KEY) is None
    with sqlite3.connect(store.database_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM kardex_entries").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM state_snapshots").fetchone()[0] == 0


def test_kardex_es_append_only_y_no_permite_modificar_movimientos_confirmados(store: SQLiteStateStore):
    first = make_entry("K-1", "GENESIS")
    store.save(STATE_KEY, make_state([first]))

    edited = {**first, "description": "DESCRIPCIÓN-ALTERADA"}
    # description no forma parte del hash, pero SQLite también prohíbe editar metadatos ya sellados.
    with pytest.raises(KardexIntegrityError, match="modifica o reordena"):
        store.save(STATE_KEY, make_state([edited], revision=2))

    with sqlite3.connect(store.database_path) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("UPDATE kardex_entries SET entry_id = 'K-EDITADO' WHERE entry_id = 'K-1'")
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("DELETE FROM kardex_entries WHERE entry_id = 'K-1'")


def test_migra_estado_existente_de_indexeddb_solo_si_sqlite_esta_vacio(store: SQLiteStateStore):
    first = make_entry("K-1", "GENESIS")
    legacy_state = make_state([first])

    migrated, saved_state, version = store.migrate(STATE_KEY, legacy_state)
    assert migrated is True
    assert saved_state == legacy_state
    assert version == 1

    different_local_copy = make_state([], revision=999)
    migrated_again, authoritative_state, current_version = store.migrate(STATE_KEY, different_local_copy)
    assert migrated_again is False
    assert authoritative_state == legacy_state
    assert current_version == 1

    with sqlite3.connect(store.database_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM kardex_entries").fetchone()[0] == 1


def test_recupera_estado_y_cadena_despues_de_reiniciar_servidor(tmp_path: Path):
    db_path = tmp_path / "data" / "inventory.sqlite3"
    first = make_entry("K-1", "GENESIS")
    second = make_entry("K-2", first["entryHash"], amount=40)
    expected = make_state([second, first], revision=7)

    first_process = SQLiteStateStore(db_path)
    first_process.save(STATE_KEY, expected)

    # Nueva instancia: representa reiniciar Python / local-server.
    restarted_process = SQLiteStateStore(db_path)
    restored, version = restarted_process.load_with_version(STATE_KEY)
    assert version == 1
    assert restored == expected
    assert restarted_process.save(STATE_KEY, make_state([second, first], revision=8)) == 2


def test_api_sqlite_solo_es_accesible_desde_la_pc_y_persiste_en_el_servidor(tmp_path: Path):
    data_dir = tmp_path / "data"
    app = create_app(tmp_path, tls=False, ips=[], data_dir=data_dir)
    with TestClient(app) as remote_client:
        assert remote_client.get(f"/api/estado?key={STATE_KEY}").status_code == 403
        assert remote_client.put("/api/estado", json={"key": STATE_KEY, "value": make_state()}).status_code == 403

    app.state.trusted_hosts.add("testclient")
    with TestClient(app) as local_client:
        entry = make_entry("K-API-1", "GENESIS")
        state = make_state([entry], revision=3)
        saved = local_client.put("/api/estado", json={"key": STATE_KEY, "value": state})
        assert saved.status_code == 200
        assert saved.json()["version"] == 1
        loaded = local_client.get(f"/api/estado?key={STATE_KEY}")
        assert loaded.status_code == 200
        assert loaded.json()["value"] == state


def test_migracion_api_y_respaldos_cifrados_incluyen_base_sqlite(tmp_path: Path):
    data_dir = tmp_path / "data"
    app = create_app(tmp_path, tls=False, ips=[], data_dir=data_dir)
    app.state.trusted_hosts.add("testclient")
    with TestClient(app) as client:
        entry = make_entry("K-BACKUP-1", "GENESIS")
        state = make_state([entry], revision=11)

        migrated = client.post("/api/estado/migrar", json={"key": STATE_KEY, "value": state})
        assert migrated.status_code == 200
        assert migrated.json()["migrated"] is True
        second_migration = client.post(
            "/api/estado/migrar",
            json={"key": STATE_KEY, "value": make_state([], revision=99)},
        )
        assert second_migration.json()["migrated"] is False
        assert second_migration.json()["value"] == state

        phrase = "frase-respaldo-bloque-n"
        created = client.post(
            "/api/respaldo",
            json=state,
            headers={"X-Backup-Passphrase": phrase},
        )
        assert created.status_code == 200
        backup_bundle = app.state.backups.restore_bundle(phrase, created.json()["nombre"])
        assert backup_bundle["state"] == state
        assert backup_bundle["database"].startswith(b"SQLite format 3")

        # Simular pérdida de la base activa y recuperar la copia incluida en el .bak.
        app.state.state_store.clear()
        assert client.get(f"/api/estado?key={STATE_KEY}").json()["found"] is False
        restored = client.post(
            "/api/respaldo/restaurar",
            json={"nombre": created.json()["nombre"]},
            headers={"X-Backup-Passphrase": phrase},
        )
        assert restored.status_code == 200
        assert restored.json() == state
        assert client.get(f"/api/estado?key={STATE_KEY}").json()["value"] == state


def test_cifrado_sqlite_sin_texto_claro_y_aad_y_manipulacion(tmp_path: Path):
    db_path = tmp_path / "data" / "inventory.sqlite3"
    s = SQLiteStateStore(db_path, pin_iterations=1_000)
    secret_name = "Doña Eufrosina Matus Secreto"
    entry = make_entry("K-SEC-1", "GENESIS", amount=77)
    entry["producto"] = {"sku": "SKU-SECRETO-9", "name": "Producto Confidencial XYZ"}
    entry["entryHash"] = compute_kardex_hash(entry)
    state = make_state([entry], revision=5)
    state["creditCustomers"] = [{"id": "CLI-1", "name": secret_name, "phone": "971-555-8899"}]

    s.save(STATE_KEY, state)
    assert s.load(STATE_KEY) == state

    # Volcar WAL a disco y comprobar que no existe texto claro ni en .sqlite3 ni en -wal
    with sqlite3.connect(db_path) as raw_conn:
        raw_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        snap_row = raw_conn.execute("SELECT payload_json FROM state_snapshots LIMIT 1").fetchone()
        kardex_row = raw_conn.execute("SELECT payload_json FROM kardex_entries LIMIT 1").fetchone()
        assert json.loads(snap_row[0])["__btenc__"] == 1
        assert json.loads(kardex_row[0])["__btenc__"] == 1

    raw_bytes = db_path.read_bytes()
    for secret in [b"Eufrosina", b"971-555-8899", b"Producto Confidencial", b"SKU-SECRETO-9"]:
        assert secret not in raw_bytes

    # Mover sobre cifrado de una clave a otra (viola AAD) debe fallar
    with sqlite3.connect(db_path) as conn:
        enc_blob = conn.execute(
            "SELECT payload_json FROM state_snapshots WHERE state_key = ?", (STATE_KEY,)
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO state_snapshots(state_key, snapshot_version, payload_json) VALUES (?, 1, ?)",
            ("otra_clave", enc_blob),
        )
        conn.commit()
    with pytest.raises(StateStoreError, match="descifrar"):
        s.load("otra_clave")

    # Corromper 1 byte del ciphertext en state_snapshots debe rechazarse por GCM tag
    parsed = json.loads(enc_blob)
    tampered_ct = ("A" if parsed["ct"][0] != "A" else "B") + parsed["ct"][1:]
    parsed["ct"] = tampered_ct
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE state_snapshots SET payload_json = ? WHERE state_key = ?",
            (json.dumps(parsed), STATE_KEY),
        )
        conn.commit()
    with pytest.raises(StateStoreError, match="descifrar"):
        s.load(STATE_KEY)


def test_cifrado_sqlite_ciclo_pin_bloqueo_423_ranuras_y_olvido_pin(tmp_path: Path):
    data_dir = tmp_path / "data"
    db_path = data_dir / "inventory.sqlite3"
    store = SQLiteStateStore(db_path, pin_iterations=1_000)
    app = create_app(tmp_path, tls=False, ips=[], data_dir=data_dir)
    app.state.state_store = store
    app.state.trusted_hosts.add("testclient")

    entry = make_entry("K-PIN-1", "GENESIS", amount=55)
    state = make_state([entry], revision=12)

    with TestClient(app) as client:
        assert store.local_key_path.is_file()
        assert client.put("/api/estado", json={"key": STATE_KEY, "value": state}).status_code == 200

        phrase = "respaldo-pin-sqlite-2026"
        bak_res = client.post("/api/respaldo", json=state, headers={"X-Backup-Passphrase": phrase})
        assert bak_res.status_code == 200
        bak_name = bak_res.json()["nombre"]

        # Activar cifrado por PIN -> borra .sqlite_local.key del disco
        cfg = client.post("/api/estado/cifrado/configurar", json={"slotId": "USR-ADMIN", "pin": "984312"})
        assert cfg.status_code == 200
        assert cfg.json()["mode"] == "pin"
        assert cfg.json()["configured"] is True
        assert cfg.json()["unlocked"] is True
        assert not store.local_key_path.exists()

    # Simular reinicio del servidor: la base arranca bloqueada y sin llave local
    app2 = create_app(tmp_path, tls=False, ips=[], data_dir=data_dir)
    app2.state.state_store = SQLiteStateStore(db_path, pin_iterations=1_000)
    app2.state.trusted_hosts.add("testclient")
    with TestClient(app2) as client2:
        st_res = client2.get("/api/estado/cifrado").json()
        assert st_res["mode"] == "pin"
        assert st_res["unlocked"] is False
        assert client2.get(f"/api/estado?key={STATE_KEY}").status_code == 423
        assert client2.put("/api/estado", json={"key": STATE_KEY, "value": state}).status_code == 423
        assert client2.post("/api/estado/cifrado/desbloquear", json={"pin": "000000"}).status_code == 403

        # Desbloqueo correcto
        unlock = client2.post("/api/estado/cifrado/desbloquear", json={"pin": "984312"})
        assert unlock.status_code == 200
        assert unlock.json()["unlocked"] is True
        assert client2.get(f"/api/estado?key={STATE_KEY}").json()["value"] == state

        # Gestión de ranuras de administradores
        assert client2.post("/api/estado/cifrado/ranura", json={"slotId": "USR-ADMIN-2", "pin": "718293"}).status_code == 200
        assert client2.delete("/api/estado/cifrado/ranura/USR-ADMIN").status_code == 200
        # Nunca deja sin ranuras
        assert client2.delete("/api/estado/cifrado/ranura/USR-ADMIN-2").status_code == 400

    # Reinicio con USR-ADMIN ya eliminado -> solo abre con PIN del admin 2
    app3 = create_app(tmp_path, tls=False, ips=[], data_dir=data_dir)
    app3.state.state_store = SQLiteStateStore(db_path, pin_iterations=1_000)
    app3.state.trusted_hosts.add("testclient")
    with TestClient(app3) as client3:
        assert client3.post("/api/estado/cifrado/desbloquear", json={"pin": "984312"}).status_code == 403
        # Recuperación desde .bak mientras SQLite está bloqueado (solo lee .bak sin tocar DB)
        bak_preview = client3.post(
            "/api/respaldo/restaurar",
            json={"nombre": bak_name, "previewOnly": True},
            headers={"X-Backup-Passphrase": phrase},
        )
        assert bak_preview.status_code == 200
        assert bak_preview.json() == state

        # Reinicio con PIN nuevo tras olvido
        reset = client3.post("/api/estado/cifrado/reiniciar", json={"slotId": "USR-ADMIN", "pin": "625140"})
        assert reset.status_code == 200
        assert reset.json()["unlocked"] is True
        assert client3.put("/api/estado", json={"key": STATE_KEY, "value": state}).status_code == 200
        assert client3.get(f"/api/estado?key={STATE_KEY}").json()["value"] == state


def test_respaldo_bak_portable_entre_equipos_y_migracion_sqlite_sin_cifrar(tmp_path: Path):
    # 1. Crear base legacy sin cifrado (como versión anterior)
    legacy_dir = tmp_path / "legacy"
    legacy_dir.mkdir(parents=True)
    legacy_db = legacy_dir / "inventory.sqlite3"
    entry = make_entry("K-LEG-1", "GENESIS", amount=33)
    legacy_state = make_state([entry], revision=2)
    with sqlite3.connect(legacy_db) as conn:
        conn.executescript(
            """
            CREATE TABLE state_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                state_key TEXT NOT NULL,
                snapshot_version INTEGER NOT NULL,
                schema_version INTEGER,
                state_timestamp TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(state_key, snapshot_version)
            );
            CREATE TABLE kardex_entries (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id TEXT NOT NULL UNIQUE,
                previous_hash TEXT NOT NULL,
                entry_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            """
        )
        conn.execute(
            "INSERT INTO state_snapshots(state_key, snapshot_version, schema_version, payload_json) VALUES (?, 1, 5, ?)",
            (STATE_KEY, json.dumps(legacy_state)),
        )
        conn.execute(
            "INSERT INTO kardex_entries(entry_id, previous_hash, entry_hash, payload_json) VALUES (?, ?, ?, ?)",
            (entry["id"], entry["previousHash"], entry["entryHash"], json.dumps(entry)),
        )
        conn.commit()

    # Al abrir con SQLiteStateStore, lee el Kardex heredado y cifra snapshot en sitio
    migrated_store = SQLiteStateStore(legacy_db, pin_iterations=1_000)
    assert migrated_store.load(STATE_KEY) == legacy_state
    with sqlite3.connect(legacy_db) as conn:
        raw_snap = conn.execute("SELECT payload_json FROM state_snapshots WHERE state_key = ?", (STATE_KEY,)).fetchone()[0]
        assert json.loads(raw_snap)["__btenc__"] == 1

    # Agregar segundo movimiento: debe encadenarse correctamente y guardarse cifrado
    entry2 = make_entry("K-LEG-2", entry["entryHash"], amount=44)
    migrated_store.save(STATE_KEY, make_state([entry2, entry], revision=3))

    # Exportar backup portable desde migrated_store (Equipo A) e importarlo en Equipo B (llave distinta)
    portable_db = migrated_store.backup_bytes()
    equipo_b = SQLiteStateStore(tmp_path / "equipo_b" / "inventory.sqlite3", pin_iterations=1_000)
    equipo_b.configure_pin_encryption("USR-ADMIN", "918273")
    equipo_b.restore_bytes(portable_db)
    assert not equipo_b.is_locked()
    restored_b = equipo_b.load(STATE_KEY)
    assert restored_b["revision"] == 3
    assert len(restored_b["kardex"]) == 2
