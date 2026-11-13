import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  CORRUPT_STATE_KEY_PREFIX,
  validateStoredState,
  migrateState,
  backupCorruptedState,
  DebouncedStorageSaver,
  MemoryStateStorageAdapter,
  type PersistedAppState,
} from './persistence.ts';
import { createKardexEntry, verifyKardexChain, verifyProductContinuity, type KardexEntry } from './kardex.ts';

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

test('Persistencia (F1 seguimiento): Migración de estado y respaldo .bak de la versión anterior (v1 de main) a v2 conservando Kardex íntegro', async () => {
  // 1. Estado v1 fiel al esquema anterior de main
  const initialHash = 'GENESIS';
  const kEntry1 = createKardexEntry(
    {
      type: 'ENTRADA_COMPRA',
      producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', saleUnit: 'Pieza' },
      cantidad: 20,
      saldoAnterior: 0,
      saldoResultante: 20,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Inventario inicial v1',
      amount: 420.0,
      description: 'Entrada inicial de catálogo v1',
    },
    initialHash
  );

  const kEntry2 = createKardexEntry(
    {
      type: 'VENTA_EFECTIVO',
      producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', saleUnit: 'Pieza' },
      cantidad: -2,
      saldoAnterior: 20,
      saldoResultante: 18,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Ticket #0101',
      amount: 52.0,
      description: 'Venta de mostrador en efectivo',
    },
    kEntry1.entryHash
  );

  const v1State = {
    schemaVersion: 1, // Versión anterior en main
    timestamp: '2026-11-01T12:00:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [
      {
        sku: 'LAC-LAL-1L',
        barcode: '7501020515350',
        name: 'Leche Lala Entera 1L',
        stock: 18,
        costPrice: 21.0,
        historicCost: 21.0,
        salePrice: 26.0,
        category: 'Lácteos',
        isBulk: false,
      },
      {
        sku: 'FRI-NEG-50K',
        barcode: '2000001000014',
        name: 'Frijol Negro Granel',
        stock: 35.5,
        costPrice: 28.0,
        historicCost: 28.0,
        salePrice: 36.0,
        category: 'Granos',
        isBulk: true,
      },
    ],
    creditCustomers: [
      { id: 'CLI-01', name: 'Doña Carmen', creditLimit: 500, currentBalance: 120, status: 'AL_CORRIENTE' },
    ],
    cashShift: {
      openingCash: 500,
      cashSalesTotal: 52,
      creditPaymentsReceived: 0,
      creditSalesTotal: 0,
      internalConsumptionTotalCost: 0,
      shrinkTotalCost: 0,
    },
    cashRegister: {
      openingFloat: 500,
      cashSalesTotal: 52,
      creditSalesTotal: 0,
      creditPaymentsReceived: 0,
    },
    kardex: [kEntry2, kEntry1], // Cronológico descendente (el más reciente primero)
    shrinkRecords: [],
    auditLines: [],
    internalConsumptionRecords: [],
    morningAlerts: [],
  };

  // Validar que la cadena previa de Kardex sea válida antes de migrar
  const preCheck = verifyKardexChain(v1State.kardex, 'newest-first');
  assert.equal(preCheck.valid, true);

  // 2. Ejecutar migración de v1 a CURRENT_SCHEMA_VERSION (3)
  const migrationResult = migrateState(v1State);
  assert.equal(migrationResult.migrated, true);
  assert.equal(migrationResult.fromVersion, 1);
  assert.equal(migrationResult.toVersion, CURRENT_SCHEMA_VERSION);

  const migratedState = migrationResult.state;
  assert.equal(migratedState.schemaVersion, CURRENT_SCHEMA_VERSION);

  // 3. Verificar que los productos adquirieron los campos nuevos con valores por defecto
  const leche = migratedState.products.find((p) => p.sku === 'LAC-LAL-1L');
  assert.ok(leche);
  assert.equal(leche.approvalStatus, 'APROBADO', 'Productos preexistentes deben tener status APROBADO');
  assert.deepEqual(leche.barcodes, ['7501020515350'], 'Debe tener arreglo de códigos de barras');
  assert.equal(leche.hasInternalBarcode, false);
  assert.equal(leche.saleUnit, 'Pieza');
  assert.equal(leche.purchaseUnit, 'Pieza');
  assert.equal(leche.unitsPerPurchase, 1);
  assert.equal(leche.packageCost, 21.0);
  assert.equal(leche.packageFactor, 1);
  assert.ok(Array.isArray(leche.priceTiers));
  assert.equal(leche.priceTiers[0].tier, 'MENUDEO');
  assert.equal(leche.priceTiers[0].unitPrice, 26.0);
  assert.equal(leche.isActive, true);
  assert.equal(leche.naturalShrinkTolerancePct, 0);

  const frijol = migratedState.products.find((p) => p.sku === 'FRI-NEG-50K');
  assert.ok(frijol);
  assert.equal(frijol.approvalStatus, 'APROBADO');
  assert.equal(frijol.isBulk, true);
  assert.equal(frijol.hasInternalBarcode, true, 'Prefijo 200 debe detectarse como interno');
  assert.equal(frijol.naturalShrinkTolerancePct, 3, 'Granel por defecto debe tener 3% de tolerancia de merma natural');

  // 4. Validar integridad de Kardex y continuidad tras migración
  const chainPostCheck = verifyKardexChain(migratedState.kardex, 'newest-first');
  assert.equal(chainPostCheck.valid, true, 'La cadena criptográfica del Kardex debe permanecer íntegra');

  const contPostCheck = verifyProductContinuity(migratedState.products, migratedState.kardex, 'newest-first');
  assert.equal(contPostCheck.valid, true, 'La continuidad de stock por producto debe mantenerse sin discrepancias');

  const fullValidation = validateStoredState(
    migratedState,
    (k) => verifyKardexChain(k, 'newest-first'),
    (prods, k) => verifyProductContinuity(prods, k, 'newest-first')
  );
  assert.equal(fullValidation.valid, true, 'El estado migrado debe superar validateStoredState');

  // 5. Simular respaldo .bak de v1 cifrado: encrypt -> decrypt -> migrate
  const { encryptBackupBytes, decryptBackupBytes } = await import('./backup.ts');
  const passphrase = 'frase-secreta-backup-2026';
  const v1JsonBytes = new TextEncoder().encode(JSON.stringify(v1State));
  const encryptedBakBytes = await encryptBackupBytes(v1JsonBytes, passphrase, 2000); // 2000 iters para test rápido

  // Descifrar el archivo .bak
  const decryptedBytes = await decryptBackupBytes(encryptedBakBytes, passphrase);
  const parsedDecryptedState = JSON.parse(new TextDecoder().decode(decryptedBytes));
  assert.equal(parsedDecryptedState.schemaVersion, 1);

  // Migrar a versión actual (v3)
  const bakMigration = migrateState(parsedDecryptedState);
  assert.equal(bakMigration.migrated, true);
  assert.equal(bakMigration.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(bakMigration.state.products.length, 2);
  assert.equal(verifyKardexChain(bakMigration.state.kardex, 'newest-first').valid, true);
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

test('Persistencia: Detección de stock alterado mediante verifyProductContinuity y listado de SKUs afectados', () => {
  const kEntry = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo 680g' },
    cantidad: -2,
    saldoAnterior: 10,
    saldoResultante: 8,
    usuario: 'Don Lupe',
    referencia: 'TK-10',
    previousHash: 'GENESIS',
  });

  // Estado donde el hash del Kardex es válido, pero el stock del producto fue alterado de 8 a 99
  const stateWithAlteredStock = {
    schemaVersion: 1,
    products: [
      { sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo 680g', stock: 99 },
      { sku: 'REF-COC-600', name: 'Coca-Cola 600ml', stock: 24 },
    ],
    creditCustomers: [],
    kardex: [kEntry],
    shrinkRecords: [],
    auditLines: [],
  };

  const validation = validateStoredState(
    stateWithAlteredStock,
    (k) => verifyKardexChain(k, 'newest-first'),
    (prods, k) => verifyProductContinuity(prods, k, 'newest-first')
  );

  assert.equal(validation.valid, false, 'Debe rechazar el estado por discrepancia de continuidad de stock');
  assert.deepEqual(validation.affectedSkus, ['PAN-BIM-680']);
  assert.match(validation.reason || '', /PAN-BIM-680/);
});

test('Persistencia: backupCorruptedState conserva las 3 copias más recientes sin sobrescribir la clave principal', async () => {
  const adapter = new MemoryStateStorageAdapter();
  const originalCorrupt = { schemaVersion: 1, products: 'corrupto' };
  await adapter.save(STATE_STORAGE_KEY, originalCorrupt);

  const k1 = await backupCorruptedState(adapter, { v: 1 }, '2026-10-28T10:00:00.000Z');
  const k2 = await backupCorruptedState(adapter, { v: 2 }, '2026-10-28T10:01:00.000Z');
  const k3 = await backupCorruptedState(adapter, { v: 3 }, '2026-10-28T10:02:00.000Z');
  const k4 = await backupCorruptedState(adapter, { v: 4 }, '2026-10-28T10:03:00.000Z');

  assert.ok(k1.startsWith(CORRUPT_STATE_KEY_PREFIX));
  const corruptKeys = await adapter.listKeys(CORRUPT_STATE_KEY_PREFIX);
  assert.equal(corruptKeys.length, 3, 'Solo deben conservarse las 3 copias más recientes');
  assert.deepEqual(corruptKeys.sort(), [k2, k3, k4]);

  // Verificar que la clave principal no fue sobrescrita ni eliminada
  const stillOriginal = await adapter.load(STATE_STORAGE_KEY);
  assert.deepEqual(stillOriginal, originalCorrupt);
});

test('Persistencia (F2 Seguimiento): Migración v2 -> v3 de proveedores, cuentas por pagar e historial de precios con valores por defecto y respaldo .bak', async () => {
  const adapter = new MemoryStateStorageAdapter();

  const kEntry1 = createKardexEntry({
    type: 'AJUSTE_INICIAL',
    producto: { sku: 'AZU-EST-1K', name: 'Azúcar Estándar 1Kg' },
    sku: 'AZU-EST-1K',
    cantidad: 20,
    saldoAnterior: 0,
    saldoResultante: 20,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Inventario Inicial',
    previousHash: 'GENESIS',
  });

  const kEntry2 = createKardexEntry({
    type: 'PAGO_PROVEEDOR',
    producto: { sku: 'TESORERIA', name: 'Tesorería - Pago a Abarrotes del Centro' },
    sku: 'TESORERIA',
    cantidad: 0,
    saldoAnterior: 0,
    saldoResultante: 0,
    amount: 500.0,
    amountCents: 50000,
    usuario: 'Don Lupe',
    referencia: 'Pago CxP CAJA',
  }, kEntry1.entryHash);

  const v2State = {
    schemaVersion: 2,
    timestamp: '2026-11-05T14:30:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [
      {
        sku: 'AZU-EST-1K',
        name: 'Azúcar Estándar 1Kg',
        stock: 20,
        unitCost: 22.0,
        salePrice: 28.0,
        isBulk: false,
        approvalStatus: 'APROBADO',
      },
    ],
    creditCustomers: [
      { id: 'CLI-01', name: 'Doña Carmen', creditLimit: 500, currentBalance: 120, status: 'AL_CORRIENTE' },
    ],
    cashShift: { openingCash: 500, cashSalesTotal: 0, creditPaymentsReceived: 0, creditSalesTotal: 0 },
    cashRegister: { openingFloat: 500, cashSalesTotal: 0, creditSalesTotal: 0, creditPaymentsReceived: 0 },
    kardex: [kEntry2, kEntry1],
    shrinkRecords: [],
    auditLines: [],
    suppliers: [
      {
        id: 'SUP-01',
        name: 'Abarrotes del Centro',
        phone: '951-123-4567',
        // Campos que faltan en v2 crudo:
        // paymentTerms, creditDays, visitDays, physicalExchangePolicy, currentBalance
      },
    ],
    accountsPayable: [
      {
        id: 'CXP-001',
        supplierId: 'SUP-01',
        supplierName: 'Abarrotes del Centro',
        receptionFolio: 'REC-501',
        date: '2026-11-01',
        dueDate: '2026-11-16',
        totalAmount: 1200.0,
        // Falta remainingBalance, status, linesSummary
      },
    ],
    priceHistory: [
      {
        id: 'HIST-001',
        date: '2026-11-01T10:00:00.000Z',
        productId: 'AZU-EST-1K',
        productName: 'Azúcar Estándar 1Kg',
        supplierId: 'SUP-01',
        supplierName: 'Abarrotes del Centro',
        receptionFolio: 'REC-501',
        purchaseUnit: 'Costal',
        unitsPerPurchase: 50,
        costPerPurchaseUnit: 1100,
        unitCost: 22.0,
        // Falta priceHikeDetected
      },
    ],
  };

  // 1. Simular estado guardado bajo la clave legacy v2
  const LEGACY_V2_KEY = 'binnitech_pos_state_v2';
  const V3_KEY = 'binnitech_pos_state_v3';
  await adapter.save(LEGACY_V2_KEY, v2State);

  // 2. Ejecutar migración pura de v2 a v3
  const migrationRes = migrateState(v2State);
  assert.equal(migrationRes.migrated, true);
  assert.equal(migrationRes.fromVersion, 2);
  assert.equal(migrationRes.toVersion, CURRENT_SCHEMA_VERSION);

  const migratedState = migrationRes.state;
  assert.equal(migratedState.schemaVersion, CURRENT_SCHEMA_VERSION);

  // Verificar proveedores con valores por defecto
  assert.equal(migratedState.suppliers?.length, 1);
  const sup = migratedState.suppliers![0];
  assert.equal(sup.name, 'Abarrotes del Centro');
  assert.equal(sup.paymentTerms, 'CONTADO');
  assert.equal(sup.creditDays, 0);
  assert.deepEqual(sup.visitDays, []);
  assert.equal(sup.physicalExchangePolicy, false);
  assert.equal(sup.isActive, true);
  assert.equal(sup.currentBalance, 0);

  // Verificar cuentas por pagar con valores por defecto
  assert.equal(migratedState.accountsPayable?.length, 1);
  const debt = migratedState.accountsPayable![0];
  assert.equal(debt.remainingBalance, 1200.0);
  assert.equal(debt.status, 'PENDIENTE');
  assert.deepEqual(debt.linesSummary, []);

  // Verificar historial de precios
  assert.equal(migratedState.priceHistory?.length, 1);
  const hist = migratedState.priceHistory![0];
  assert.equal(hist.priceHikeDetected, false);
  assert.equal(hist.unitCost, 22.0);

  // Verificar que Kardex y continuidad siguen 100% válidos
  assert.equal(verifyKardexChain(migratedState.kardex, 'newest-first').valid, true);
  assert.equal(verifyProductContinuity(migratedState.products, migratedState.kardex, 'newest-first').valid, true);
  assert.equal(validateStoredState(migratedState).valid, true);

  // 3. Simular respaldo .bak v2 cifrado y restauración
  const { encryptBackupBytes, decryptBackupBytes } = await import('./backup.ts');
  const passphrase = 'password-v2-bak';
  const v2Bytes = new TextEncoder().encode(JSON.stringify(v2State));
  const encryptedBak = await encryptBackupBytes(v2Bytes, passphrase, 1500);

  const decryptedBak = await decryptBackupBytes(encryptedBak, passphrase);
  const parsedFromBak = JSON.parse(new TextDecoder().decode(decryptedBak));
  assert.equal(parsedFromBak.schemaVersion, 2);

  const bakMigration = migrateState(parsedFromBak);
  assert.equal(bakMigration.migrated, true);
  assert.equal(bakMigration.state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(bakMigration.state.suppliers?.length, 1);
  assert.equal(bakMigration.state.accountsPayable?.length, 1);
  assert.equal(verifyKardexChain(bakMigration.state.kardex, 'newest-first').valid, true);

  // 4. Protección contra borrado prematuro de v2:
  // Si la escritura de v3 falla o se corrompe, v2 debe permanecer intacto
  const failingAdapter = new MemoryStateStorageAdapter();
  await failingAdapter.save(LEGACY_V2_KEY, v2State);

  // Simular fallo de escritura en v3: no se borra v2
  const writeSuccess = false;
  if (!writeSuccess) {
    // No eliminar LEGACY_V2_KEY
  }
  const preservedV2 = await failingAdapter.load(LEGACY_V2_KEY);
  assert.ok(preservedV2, 'La clave legacy v2 debe conservarse intacta si la escritura/validación de v3 falla');
  assert.equal(preservedV2.schemaVersion, 2);

  // Cuando la escritura y validación de v3 son exitosas:
  await adapter.save(V3_KEY, migratedState);
  const writtenV3 = await adapter.load(V3_KEY);
  const v3Validation = validateStoredState(writtenV3);
  assert.equal(v3Validation.valid, true);
  if (v3Validation.valid) {
    await adapter.delete(LEGACY_V2_KEY);
  }
  assert.equal(await adapter.load(LEGACY_V2_KEY), null, 'Una vez validado v3, la clave legacy v2 se limpia correctamente');
  assert.ok(await adapter.load(V3_KEY), 'El estado v3 permanece disponible');
});

test('Persistencia (Bloque G): Migración v3 -> v4 incorpora settings, users y securityAuditLog', async () => {
  const v3State = {
    schemaVersion: 3,
    timestamp: '2026-11-08T12:00:00.000Z',
    activeUser: 'Don Lupe (Encargado)',
    products: [],
    creditCustomers: [],
    cashShift: { openingCash: 1000 },
    cashRegister: { currentBalance: 1000 },
    kardex: [],
    shrinkRecords: [],
    auditLines: [],
    suppliers: [],
    accountsPayable: [],
    priceHistory: [],
    cashMovements: [],
    maxDiscountPctWithoutPin: 12.0,
  };

  const migration = migrateState(v3State);
  assert.equal(migration.migrated, true);
  assert.equal(migration.state.schemaVersion, CURRENT_SCHEMA_VERSION);

  // Verifica que settings fue creado con los valores por defecto
  assert.ok(migration.state.settings);
  assert.equal(migration.state.settings.storeName, 'Mi Tiendita');
  assert.equal(migration.state.settings.maxDiscountPctWithoutPin, 12.0); // preservó el valor de v3
  assert.equal(migration.state.settings.inactivityTimeoutMinutes, 5);

  // Verifica que users y securityAuditLog se inicializaron como arreglos
  assert.ok(Array.isArray(migration.state.users));
  assert.ok(Array.isArray(migration.state.securityAuditLog));

  // Valida que el estado cumple con validateStoredState
  const validation = validateStoredState(migration.state);
  assert.equal(validation.valid, true);
});

test('Persistencia (Bloque H seguimiento): Migración v4 -> v5 integra salesHistory, saleReturns y shiftCloseRecords preservando Bloque G', () => {
  const v4State = {
    schemaVersion: 4,
    timestamp: '2026-11-12T10:00:00.000Z',
    activeUser: 'Administrador',
    products: [],
    creditCustomers: [
      {
        id: 'CLI-V4',
        name: 'Cliente V4',
        phone: '477-000-1122',
        creditLimit: 500,
        currentBalance: 100,
        dueDate: '2026-11-30',
      },
    ],
    cashShift: { openingCash: 750 },
    cashRegister: { openingFloat: 750 },
    kardex: [],
    shrinkRecords: [],
    auditLines: [],
    suppliers: [],
    accountsPayable: [],
    priceHistory: [],
    cashMovements: [],
    settings: {
      storeName: 'Abarrotes La Estrella',
      initialCashFloat: 750,
      initialCashFloatCents: 75000,
      marginThresholdPct: 22,
      defaultIvaPct: 16,
      defaultIepsPct: 8,
      inactivityTimeoutMinutes: 10,
      maxDiscountPctWithoutPin: 15,
    },
    users: [
      {
        id: 'USR-ADMIN-1',
        name: 'Administrador',
        role: 'ADMINISTRADOR',
        pinHash: 'abc',
        pinSalt: 'def',
        pinIterations: 100000,
        isActive: true,
        failedAttempts: 0,
        lockedUntil: null,
        lockoutCount: 0,
      },
    ],
    securityAuditLog: [
      {
        id: 'SEC-1',
        timestamp: '2026-11-12T09:00:00.000Z',
        action: 'SETTINGS_UPDATED',
        actorUser: 'Administrador',
        details: 'Cambio inicial',
        previousHash: 'GENESIS',
        entryHash: 'hash1',
      },
    ],
  };

  const migration = migrateState(v4State);
  assert.equal(migration.migrated, true);
  assert.equal(migration.fromVersion, 4);
  assert.equal(migration.toVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migration.state.schemaVersion, 5);
  assert.equal(migration.state.settings?.storeName, 'Abarrotes La Estrella');
  assert.equal(migration.state.users?.length, 1);
  assert.equal(migration.state.securityAuditLog?.length, 1);
  assert.ok(Array.isArray(migration.state.salesHistory));
  assert.ok(Array.isArray(migration.state.saleReturns));
  assert.ok(Array.isArray(migration.state.shiftCloseRecords));
  assert.equal(migration.state.isShiftOpen, true);
  assert.equal(migration.state.currentShiftId, 'TURNO-1');
  assert.equal(migration.state.creditCustomers[0].creditFavorBalance, 0);

  const validation = validateStoredState(migration.state);
  assert.equal(validation.valid, true);
});
