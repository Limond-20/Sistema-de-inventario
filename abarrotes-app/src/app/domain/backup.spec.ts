import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_PBKDF2_ITERATIONS,
  encryptBackupBytes,
  decryptBackupBytes,
  unpackBackupHeader,
  validateBackupPassphrase,
  isValidBackupFilename,
  formatRelativeBackupTime,
  isBackupOlderThan24h,
  InMemoryEncryptedBackupAdapter,
  BackupUnauthorizedError,
} from './backup.ts';
import { CURRENT_SCHEMA_VERSION, type PersistedAppState } from './persistence.ts';

function buildSampleState(stock = 15): PersistedAppState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    timestamp: '2026-11-06T18:00:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [
      {
        sku: 'LAC-LAL-1L',
        barcode: '7501020515350',
        name: 'Leche Lala Entera 1L',
        stock,
        salePrice: 26,
      },
    ],
    creditCustomers: [],
    cashShift: { openingCash: 500, cashSalesTotal: 0 },
    cashRegister: { openingFloat: 500, cashSalesTotal: 0 },
    kardex: [],
    shrinkRecords: [],
    auditLines: [],
    internalConsumptionRecords: [],
    morningAlerts: [],
  };
}

test('Respaldo Cifrado: validación de frase (mínimo 8 caracteres) y patrón estricto de archivo ^[0-9]{8}-[0-9]{6}\\.bak$', () => {
  assert.equal(validateBackupPassphrase('').valid, false);
  assert.equal(validateBackupPassphrase('1234567').valid, false);
  assert.equal(validateBackupPassphrase('12345678').valid, true);

  assert.equal(isValidBackupFilename('20261106-183045.bak'), true);
  assert.equal(isValidBackupFilename('../20261106-183045.bak'), false);
  assert.equal(isValidBackupFilename('%2e%2e%2f20261106-183045.bak'), false);
  assert.equal(isValidBackupFilename('20261106-183045-01.bak'), false);
});

test('Respaldo Cifrado: PBKDF2-HMAC-SHA256 600,000 iteraciones con versión y parámetros en encabezado cubiertos por AAD', async () => {
  assert.equal(BACKUP_PBKDF2_ITERATIONS, 600_000);
  const plaintext = new TextEncoder().encode(JSON.stringify({ tienda: 'Doña Lupe', caja: 1250.5 }));
  const phrase = 'frase-respaldo-segura';
  const encrypted = await encryptBackupBytes(plaintext, phrase);

  const hdr = unpackBackupHeader(encrypted);
  assert.equal(hdr.version, 1);
  assert.equal(hdr.kdfId, 1);
  assert.equal(hdr.cipherId, 1);
  assert.equal(hdr.iterations, 600_000);
  assert.equal(hdr.aad.byteLength, 28);

  // Descifrar con frase correcta (lee iteraciones del encabezado)
  const decrypted = await decryptBackupBytes(encrypted, phrase);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decrypted)), {
    tienda: 'Doña Lupe',
    caja: 1250.5,
  });

  // Frase incorrecta -> BackupUnauthorizedError (403)
  await assert.rejects(
    () => decryptBackupBytes(encrypted, 'frase-equivocada'),
    (err: any) => err instanceof BackupUnauthorizedError && err.status === 403
  );

  // Manipulación de iteraciones en el encabezado (bytes 8..12, cubierto por AAD) -> 403
  const tamperedHeader = new Uint8Array(encrypted);
  tamperedHeader[11] ^= 0x01;
  await assert.rejects(
    () => decryptBackupBytes(tamperedHeader, phrase),
    (err: any) => err instanceof BackupUnauthorizedError && err.status === 403
  );

  // Manipulación de 1 bit en el tag/ciphertext -> 403
  const tamperedCt = new Uint8Array(encrypted);
  tamperedCt[tamperedCt.length - 1] ^= 0x01;
  await assert.rejects(
    () => decryptBackupBytes(tamperedCt, phrase),
    (err: any) => err instanceof BackupUnauthorizedError && err.status === 403
  );
});

test('Respaldo Cifrado: Compatibilidad cruzada bidireccional entre local-server (Python) y backup.ts (TypeScript)', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const localServerDir = join(here, '..', '..', '..', '..', 'local-server');
  const tmp = mkdtempSync(join(tmpdir(), 'bak-cross-'));
  const pyOutFile = join(tmp, 'py_created.bak');
  const tsOutFile = join(tmp, 'ts_created.bak');
  const phrase = 'frase-cruzada-600k-tienda';
  const py = process.platform === 'win32' ? 'python' : 'python3';

  try {
    // 1. Crear .bak con Python (local-server/lansync/backup.py) y descifrarlo con backup.ts
    const pyCreateScript = [
      'import json, sys; from pathlib import Path',
      'from lansync.backup import encrypt_backup_bytes',
      `data = json.dumps({"origen": "python-server", "stock": 42}).encode("utf-8")`,
      `Path(${JSON.stringify(pyOutFile)}).write_bytes(encrypt_backup_bytes(data, ${JSON.stringify(phrase)}))`,
    ].join('; ');
    execFileSync(py, ['-c', pyCreateScript], { cwd: localServerDir, stdio: 'pipe' });

    const pyBytes = new Uint8Array(readFileSync(pyOutFile));
    const decFromPy = await decryptBackupBytes(pyBytes, phrase);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(decFromPy)), {
      origen: 'python-server',
      stock: 42,
    });

    // 2. Crear .bak con backup.ts y descifrarlo con Python (local-server/lansync/backup.py)
    const tsPayload = new TextEncoder().encode(JSON.stringify({ origen: 'typescript-client', stock: 99 }));
    const tsBytes = await encryptBackupBytes(tsPayload, phrase);
    writeFileSync(tsOutFile, tsBytes);

    const pyDecryptScript = [
      'import json; from pathlib import Path',
      'from lansync.backup import decrypt_backup_bytes',
      `raw = Path(${JSON.stringify(tsOutFile)}).read_bytes()`,
      `print(decrypt_backup_bytes(raw, ${JSON.stringify(phrase)}).decode("utf-8"))`,
    ].join('; ');
    const pyStdout = execFileSync(py, ['-c', pyDecryptScript], {
      cwd: localServerDir,
      encoding: 'utf8',
    }).trim();
    assert.deepEqual(JSON.parse(pyStdout), {
      origen: 'typescript-client',
      stock: 99,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Respaldo Cifrado: InMemoryEncryptedBackupAdapter conserva los 30 más recientes y restaura estado', async () => {
  const adapter = new InMemoryEncryptedBackupAdapter(30, 1_000);
  const phrase = 'clave-tienda-2026';

  for (let i = 1; i <= 33; i++) {
    await adapter.createBackup(buildSampleState(i), phrase);
  }

  const list = await adapter.listBackups();
  assert.equal(list.length, 30);
  assert.match(list[0].nombre, /^[0-9]{8}-[0-9]{6}\.bak$/);

  const latestRestored = await adapter.restoreBackup(phrase);
  assert.equal(latestRestored.products[0].stock, 33);
});

test('Respaldo Cifrado: formatRelativeBackupTime e isBackupOlderThan24h', () => {
  const base = Date.parse('2026-11-06T18:00:00Z');
  assert.equal(formatRelativeBackupTime(null, base), 'Sin respaldos');
  assert.equal(formatRelativeBackupTime('2026-11-06T17:59:40Z', base), 'hace unos segundos');
  assert.equal(formatRelativeBackupTime('2026-11-06T17:45:00Z', base), 'hace 15 min');
  assert.equal(formatRelativeBackupTime('2026-11-06T15:00:00Z', base), 'hace 3 h');
  assert.equal(isBackupOlderThan24h('2026-11-06T15:00:00Z', base), false);
  assert.equal(isBackupOlderThan24h('2026-11-05T17:59:59Z', base), true);
});
