import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  validateStoredState,
  migrateState,
  DebouncedStorageSaver,
  MemoryStateStorageAdapter,
  type PersistedAppState,
} from './persistence.ts';
import { createKardexEntry, verifyKardexChain, type KardexEntry } from './kardex.ts';

test('Persistencia: Guardar, recargar y recuperar estado intacto', async () => {
  const adapter = new MemoryStateStorageAdapter();

  // Construir una entrada de Kardex válida con hash encadenado
  const kEntry = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo 680g' },
    cantidad: -2,
    saldoAnterior: 10,
    saldoResultante: 8,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'TICKET-TEST-001',
    previousHash: 'GENESIS',
  });

  const sampleState: PersistedAppState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    timestamp: '2026-10-28T10:00:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [
      { sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo 680g', stock: 8, costPrice: 38, salePrice: 48 },
      { sku: 'REF-COC-600', name: 'Coca-Cola 600ml', stock: 24, costPrice: 14, salePrice: 19 },
    ],
    creditCustomers: [
      { id: 'cli-01', name: 'Doña Mary', balance: 120, creditLimit: 500, status: 'AL_CORRIENTE' },
    ],
    cashShift: {
      openingCash: 500,
      cashSalesTotal: 96,
      creditPaymentsReceived: 0,
      creditSalesTotal: 0,
      internalConsumptionTotalCost: 0,
      shrinkTotalCost: 0,
    },
    cashRegister: {
      openingFloat: 500,
      cashSalesTotal: 96,
      creditSalesTotal: 0,
      creditPaymentsReceived: 0,
    },
    kardex: [kEntry],
    shrinkRecords: [
      { id: 'sh-01', sku: 'PAN-BIM-680', quantity: 1, reason: 'Caducado', reportedBy: 'Cajero' },
    ],
    auditLines: [
      { sku: 'PAN-BIM-680', systemStock: 8, physicalCount: 8, status: 'CUADRADO' },
    ],
    internalConsumptionRecords: [],
    morningAlerts: [],
  };

  // 1. Guardar en adapter
  await adapter.save(STATE_STORAGE_KEY, sampleState);

  // 2. Cargar (simular recarga de página)
  const loaded = await adapter.load(STATE_STORAGE_KEY);
  assert.ok(loaded, 'El estado guardado debe existir al recuperarlo');

  // 3. Validar integridad
  const validation = validateStoredState(loaded, (k) => verifyKardexChain(k, 'newest-first'));
  assert.equal(validation.valid, true, `El estado cargado debe ser válido: ${validation.reason}`);

  // 4. Comparar contenido
  assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(loaded.activeUser, 'Don Lupe (Encargado)');
  assert.equal(loaded.products.length, 2);
  assert.equal(loaded.products[0].sku, 'PAN-BIM-680');
  assert.equal(loaded.kardex.length, 1);
  assert.equal(loaded.kardex[0].entryHash, kEntry.entryHash);
  assert.equal(loaded.creditCustomers[0].name, 'Doña Mary');
  assert.equal(loaded.shrinkRecords.length, 1);
  assert.equal(loaded.auditLines.length, 1);
});

test('Persistencia: Detección de datos dañados y rechazo por corrupción', async () => {
  // Caso 1: Nulo o vacío
  assert.equal(validateStoredState(null).valid, false);
  assert.equal(validateStoredState({}).valid, false);

  // Caso 2: Falta versión de esquema o es negativa
  assert.equal(validateStoredState({ schemaVersion: -1 }).valid, false);

  // Caso 3: Colecciones no arreglos
  assert.equal(
    validateStoredState({
      schemaVersion: 1,
      products: 'no-es-arreglo',
      creditCustomers: [],
      kardex: [],
      shrinkRecords: [],
      auditLines: [],
    }).valid,
    false
  );

  // Caso 4: Producto con stock corrupto (string en vez de número)
  assert.equal(
    validateStoredState({
      schemaVersion: 1,
      products: [{ sku: 'PROD-1', stock: 'mucho' }],
      creditCustomers: [],
      kardex: [],
      shrinkRecords: [],
      auditLines: [],
    }).valid,
    false
  );

  // Caso 5: Kardex con hash manipulado (tampering)
  const kEntry = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo 680g' },
    cantidad: -1,
    saldoAnterior: 5,
    saldoResultante: 4,
    usuario: 'Don Lupe',
    referencia: 'TK-1',
    previousHash: 'GENESIS',
  });

  const tamperedEntry: KardexEntry = {
    ...kEntry,
    cantidad: 999, // Alteración maliciosa o por corrupción
  };

  const corruptState = {
    schemaVersion: 1,
    products: [{ sku: 'PAN-BIM-680', stock: 4 }],
    creditCustomers: [],
    kardex: [tamperedEntry],
    shrinkRecords: [],
    auditLines: [],
  };

  const valCorrupt = validateStoredState(corruptState, (k) =>
    verifyKardexChain(k, 'newest-first')
  );
  assert.equal(valCorrupt.valid, false);
  assert.match(valCorrupt.reason || '', /Kardex/i);
});

test('Persistencia: Migración simple de versión 0/antigua a versión actual', () => {
  const legacyData = {
    // Sin schemaVersion (versión 0 implícita)
    products: [{ sku: 'LECHE-LALA', name: 'Leche Lala 1L', stock: 12 }],
    creditCustomers: [{ id: 'c-1', name: 'Don Chon', balance: 50 }],
    // Sin kardex, shrinkRecords, ni auditLines
  };

  const result = migrateState(legacyData);
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 0);
  assert.equal(result.toVersion, CURRENT_SCHEMA_VERSION);

  // Estado migrado debe tener las colecciones requeridas inicializadas
  assert.equal(result.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.state.products.length, 1);
  assert.ok(Array.isArray(result.state.kardex));
  assert.ok(Array.isArray(result.state.shrinkRecords));
  assert.ok(Array.isArray(result.state.auditLines));
  assert.ok(result.state.cashShift);
  assert.equal(result.state.activeUser, 'Don Lupe (Encargado)');

  // Un estado que ya está en la versión actual no sufre cambios
  const noMigration = migrateState(result.state);
  assert.equal(noMigration.migrated, false);
  assert.equal(noMigration.fromVersion, CURRENT_SCHEMA_VERSION);
});

test('Persistencia: DebouncedStorageSaver retrasa la ejecución y procesa última tarea', async () => {
  const saver = new DebouncedStorageSaver(50);
  let executeCount = 0;
  let lastValue = '';

  saver.schedule(() => {
    executeCount++;
    lastValue = 'primer-intento';
  });
  saver.schedule(() => {
    executeCount++;
    lastValue = 'segundo-intento';
  });
  saver.schedule(() => {
    executeCount++;
    lastValue = 'tercer-intento';
  });

  // Justo después de planificar, no debe haberse ejecutado todavía
  assert.equal(executeCount, 0);

  // Esperar más de 50 ms para que el debounce dispare
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(executeCount, 1, 'Solo debió ejecutarse 1 vez tras las llamadas seguidas');
  assert.equal(lastValue, 'tercer-intento', 'Debió ejecutarse con el último estado planificado');

  // Probar flush inmediato
  let flushed = false;
  saver.schedule(() => {
    flushed = true;
  });
  await saver.flush(() => {
    flushed = true;
  });
  assert.equal(flushed, true, 'flush debe ejecutar de inmediato');
});
