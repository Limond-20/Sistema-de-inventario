import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EncryptedStorageAdapter,
  STORAGE_KEYSTORE_KEY,
  STORAGE_PBKDF2_ITERATIONS,
  ENCRYPTED_RECORD_VERSION,
  StorageLockedError,
  StorageDecryptionError,
  UnsupportedEncryptionFormatError,
  base64ToBytes,
  findEncryptedLayer,
  isEncryptedEnvelope,
} from './encrypted-storage.ts';
import {
  MemoryStateStorageAdapter,
  ServerStateStorageAdapter,
  STATE_STORAGE_KEY,
  CORRUPT_STATE_KEY_PREFIX,
} from './persistence.ts';

const ADMIN_PIN = '847261';
const OTHER_ADMIN_PIN = '503918';
// Las pruebas estructurales usan pocas iteraciones para no tardar; las marcadas "600k" usan el valor real.
const FAST = { iterations: 1_000 };

function sampleState() {
  return {
    schemaVersion: 6,
    timestamp: '2026-11-16T20:00:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [{ sku: 'LAC-LAL-1L', name: 'Leche Lala 1L', stock: 12 }],
    creditCustomers: [
      {
        id: 'CLI-77',
        name: 'Doña Eufrosina Matus',
        phone: '971-555-0199',
        creditLimit: 800,
        currentBalance: 245.5,
        debts: [],
        payments: [],
      },
    ],
    kardex: [],
    shrinkRecords: [],
    auditLines: [],
  };
}

/** Lee lo que realmente quedó en el almacenamiento interno (lo que vería alguien con el disco). */
async function rawDump(inner: MemoryStateStorageAdapter): Promise<string> {
  const keys = await inner.listKeys();
  const values = await Promise.all(keys.map((k) => inner.load(k)));
  return JSON.stringify(values);
}

test('K1 (600k): cifrar y descifrar devuelve exactamente el mismo estado', async () => {
  assert.equal(STORAGE_PBKDF2_ITERATIONS, 600_000);
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);

  const slots = await enc.listSlots();
  assert.equal(slots.length, 1);
  assert.equal(slots[0].iterations, 600_000);
  assert.equal(base64ToBytes(slots[0].salt).length, 16);

  const state = sampleState();
  await enc.save(STATE_STORAGE_KEY, state);
  assert.deepEqual(await enc.load(STATE_STORAGE_KEY), state);

  const raw = await inner.load(STATE_STORAGE_KEY);
  assert.ok(isEncryptedEnvelope(raw), 'el valor interno debe ser un sobre cifrado');
  assert.equal(raw.__btenc, ENCRYPTED_RECORD_VERSION);
  assert.equal(raw.alg, 'AES-256-GCM');
  assert.equal(base64ToBytes(raw.iv).length, 12);
});

test('K2: el dato guardado no es legible (sin nombres, teléfonos ni montos en claro)', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);
  await enc.save(STATE_STORAGE_KEY, sampleState());

  const dump = await rawDump(inner);
  for (const secret of ['Eufrosina', '971-555-0199', 'Leche Lala', 'creditCustomers', '245.5', ADMIN_PIN]) {
    assert.ok(!dump.includes(secret), `"${secret}" no debe aparecer en el almacenamiento`);
  }

  // Mismo valor guardado dos veces -> IV distinto -> texto cifrado distinto.
  const first = await inner.load(STATE_STORAGE_KEY);
  await enc.save(STATE_STORAGE_KEY, sampleState());
  const second = await inner.load(STATE_STORAGE_KEY);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ct, second.ct);
});

test('K3 (600k): PIN incorrecto no desbloquea y no deja leer ni escribir', async () => {
  const inner = new MemoryStateStorageAdapter();
  const first = new EncryptedStorageAdapter(inner);
  await first.initialize('USR-ADMIN', ADMIN_PIN);
  await first.save(STATE_STORAGE_KEY, sampleState());

  // "Reinicio" de la app: nueva instancia sobre el mismo almacenamiento, sin llave en memoria.
  const reopened = new EncryptedStorageAdapter(inner);
  assert.equal(await reopened.getStatus(), 'locked');
  await assert.rejects(() => reopened.load(STATE_STORAGE_KEY), StorageLockedError);
  await assert.rejects(() => reopened.save(STATE_STORAGE_KEY, { x: 1 }), StorageLockedError);

  const wrong = await reopened.unlock('123987');
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /incorrecto/);
  assert.equal(await reopened.getStatus(), 'locked');
  await assert.rejects(() => reopened.load(STATE_STORAGE_KEY), StorageLockedError);

  const right = await reopened.unlock(ADMIN_PIN);
  assert.equal(right.ok, true);
  assert.equal(right.slotId, 'USR-ADMIN');
  assert.deepEqual(await reopened.load(STATE_STORAGE_KEY), sampleState());
});

test('K4: migración del dato sin cifrar existente (todas las claves, con verificación)', async () => {
  const inner = new MemoryStateStorageAdapter();
  const legacyState = sampleState();
  const corruptKey = `${CORRUPT_STATE_KEY_PREFIX}2026-11-01T00:00:00.000Z`;
  await inner.save(STATE_STORAGE_KEY, legacyState);
  await inner.save(corruptKey, { schemaVersion: 6, products: 'dañado' });

  const enc = new EncryptedStorageAdapter(inner, FAST);
  assert.equal(await enc.getStatus(), 'unconfigured');
  // Antes de configurar se puede leer (para verificar el PIN contra los usuarios guardados) pero no escribir.
  assert.deepEqual(await enc.load(STATE_STORAGE_KEY), legacyState);
  await assert.rejects(() => enc.save(STATE_STORAGE_KEY, legacyState), StorageLockedError);

  const report = await enc.initialize('USR-ADMIN', ADMIN_PIN);
  assert.deepEqual(report.migratedKeys.sort(), [STATE_STORAGE_KEY, corruptKey].sort());

  assert.ok(isEncryptedEnvelope(await inner.load(STATE_STORAGE_KEY)));
  assert.ok(isEncryptedEnvelope(await inner.load(corruptKey)));
  assert.ok(!(await rawDump(inner)).includes('Eufrosina'));
  assert.deepEqual(await enc.load(STATE_STORAGE_KEY), legacyState);
  assert.deepEqual(await enc.load(corruptKey), { schemaVersion: 6, products: 'dañado' });

  // El almacén de llaves no aparece como dato de la app.
  assert.ok(!(await enc.listKeys()).includes(STORAGE_KEYSTORE_KEY));
  await assert.rejects(() => enc.load(STORAGE_KEYSTORE_KEY));
});

test('K5: migración interrumpida se reanuda al desbloquear y load re-cifra lo que encuentre en claro', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);

  // Simula un dato en claro que quedó a medias (o escrito por una versión anterior de la app).
  await inner.save('binnitech_pos_state_prerestore_X', { schemaVersion: 6, secreto: 'Eufrosina' });

  const reopened = new EncryptedStorageAdapter(inner, FAST);
  assert.equal((await reopened.unlock(ADMIN_PIN)).ok, true);
  const report = await reopened.migratePlaintext();
  assert.deepEqual(report.migratedKeys, ['binnitech_pos_state_prerestore_X']);
  assert.ok(isEncryptedEnvelope(await inner.load('binnitech_pos_state_prerestore_X')));

  await inner.save('otra_clave', { secreto: 'Eufrosina' });
  assert.deepEqual(await reopened.load('otra_clave'), { secreto: 'Eufrosina' });
  assert.ok(isEncryptedEnvelope(await inner.load('otra_clave')), 'load debe re-cifrar el dato heredado');
});

test('K6: dato alterado o movido a otra clave se rechaza (AES-GCM + AAD)', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);
  await enc.save(STATE_STORAGE_KEY, sampleState());

  const envelope = await inner.load(STATE_STORAGE_KEY);
  const bytes = base64ToBytes(envelope.ct);
  bytes[5] ^= 0xff;
  await inner.save(STATE_STORAGE_KEY, { ...envelope, ct: Buffer.from(bytes).toString('base64') });
  await assert.rejects(() => enc.load(STATE_STORAGE_KEY), StorageDecryptionError);

  await enc.save('clave_a', { saldo: 100 });
  await inner.save('clave_b', await inner.load('clave_a'));
  await assert.rejects(() => enc.load('clave_b'), StorageDecryptionError);
});

test('K7: formato versionado: versiones desconocidas se rechazan sin intentar adivinar', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);
  await enc.save('k', { a: 1 });
  const envelope = await inner.load('k');
  await inner.save('k', { ...envelope, __btenc: 2 });
  await assert.rejects(() => enc.load('k'), UnsupportedEncryptionFormatError);

  const keystore = await inner.load(STORAGE_KEYSTORE_KEY);
  assert.equal(keystore.format, 'BTKEYS');
  assert.equal(keystore.version, 1);
  await inner.save(STORAGE_KEYSTORE_KEY, { ...keystore, version: 99 });
  await assert.rejects(() => new EncryptedStorageAdapter(inner, FAST).getStatus(), UnsupportedEncryptionFormatError);
});

test('K8: ranuras por administrador; cambiar el PIN no re-cifra los datos', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);
  await enc.save(STATE_STORAGE_KEY, sampleState());
  const ctBefore = (await inner.load(STATE_STORAGE_KEY)).ct;

  await enc.setSlot('USR-ADMIN-2', OTHER_ADMIN_PIN);
  const viaSecond = new EncryptedStorageAdapter(inner, FAST);
  assert.equal((await viaSecond.unlock(OTHER_ADMIN_PIN)).slotId, 'USR-ADMIN-2');

  // Cambio de PIN del primer admin: solo se re-envuelve su ranura.
  await enc.setSlot('USR-ADMIN', '615243');
  assert.equal((await inner.load(STATE_STORAGE_KEY)).ct, ctBefore);
  assert.equal((await new EncryptedStorageAdapter(inner, FAST).unlock(ADMIN_PIN)).ok, false);
  const viaNewPin = new EncryptedStorageAdapter(inner, FAST);
  assert.equal((await viaNewPin.unlock('615243')).ok, true);
  assert.deepEqual(await viaNewPin.load(STATE_STORAGE_KEY), sampleState());

  assert.equal(await enc.removeSlot('USR-ADMIN-2'), true);
  await assert.rejects(() => enc.removeSlot('USR-ADMIN'), /última llave/);
});

test('K9: clear conserva el PIN; resetAll (olvido de PIN) deja todo sin configurar', async () => {
  const inner = new MemoryStateStorageAdapter();
  const enc = new EncryptedStorageAdapter(inner, FAST);
  await enc.initialize('USR-ADMIN', ADMIN_PIN);
  await enc.save(STATE_STORAGE_KEY, sampleState());

  await enc.clear();
  assert.equal(await enc.load(STATE_STORAGE_KEY), null);
  assert.equal(await new EncryptedStorageAdapter(inner, FAST).getStatus(), 'locked');

  await enc.resetAll();
  assert.equal(await enc.getStatus(), 'unconfigured');
  assert.deepEqual(await inner.listKeys(), []);
});

test('K10: la capa de cifrado se encuentra también detrás del adaptador SQLite (reutilizable)', () => {
  const enc = new EncryptedStorageAdapter(new MemoryStateStorageAdapter(), FAST);
  assert.equal(findEncryptedLayer(enc), enc);
  assert.equal(findEncryptedLayer(new ServerStateStorageAdapter(enc)), enc);
  assert.equal(findEncryptedLayer(new MemoryStateStorageAdapter()), null);
  assert.equal(findEncryptedLayer(new ServerStateStorageAdapter(new MemoryStateStorageAdapter())), null);
});
