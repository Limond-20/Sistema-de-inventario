"""Pruebas Bloque N: concurrencia, Kardex append-only, migración y recuperación SQLite."""
from __future__ import annotations

import concurrent.futures
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lansync.state_store import (
    KardexIntegrityError,
    SQLiteStateStore,
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
