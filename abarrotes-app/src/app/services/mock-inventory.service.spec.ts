import { calculateDueDate } from '../domain/suppliers';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MockInventoryService, ShrinkRecord, ReceptionLine, PosSaleItem } from './mock-inventory.service';
import { PosViewComponent } from '../views/pos/pos-view.component';
import { createKardexEntry, verifyProductContinuity } from '../domain/kardex';
import {
  CORRUPT_STATE_KEY_PREFIX,
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  LEGACY_STATE_STORAGE_KEY,
  IndexedDbStateStorageAdapter,
  MemoryStateStorageAdapter,
  migrateProductDefaults,
  type StateStorageAdapter,
} from '../domain/persistence';
import {
  InMemoryEncryptedBackupAdapter,
  PRERESTORE_STATE_KEY_PREFIX,
  encryptBackupBytes,
} from '../domain/backup';

describe('MockInventoryService Integración (Bloques C y D)', () => {
  let service: MockInventoryService;

  beforeEach(async () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    try {
      await new IndexedDbStateStorageAdapter().clear();
    } catch {
      // ignore if IndexedDB is unavailable
    }
    TestBed.configureTestingModule({
      providers: [MockInventoryService, provideRouter([])],
    });
    service = TestBed.inject(MockInventoryService);
    service.storageAdapter = new MemoryStateStorageAdapter();
    await service.acquireWriterLock();
    await service.restorePersistedState();
  });

  afterEach(async () => {
    if (service) {
      await service.releaseWriterLock();
      service.ngOnDestroy();
    }
  });

  it('1. Venta sin stock -> deja existencia en negativo, genera FALTANTE_SISTEMA y alerta visible', () => {
    // Tomamos un producto existente del catálogo: REF-COC-600 (Coca-Cola 600ml, stock inicial = 14)
    const prodBefore = service.products().find((p) => p.sku === 'REF-COC-600')!;
    expect(prodBefore).toBeDefined();
    const initialStock = prodBefore.stock;

    // Vendemos 16 piezas (supera el stock por 2 piezas)
    const qtyToSell = initialStock + 2;
    const saleResult = service.processCashSale(
      [
        {
          sku: 'REF-COC-600',
          barcode: prodBefore.barcode,
          name: prodBefore.name,
          emoji: '🥤',
          saleUnit: prodBefore.saleUnit,
          isBulk: false,
          qty: qtyToSell,
          unitPrice: prodBefore.salePrice,
          subtotal: qtyToSell * prodBefore.salePrice,
        },
      ],
      qtyToSell * prodBefore.salePrice,
    );

    expect(saleResult.ok).toBeTrue();

    // Verificamos stock en negativo (-2)
    const prodAfter = service.products().find((p) => p.sku === 'REF-COC-600')!;
    expect(prodAfter.stock).toBe(-2);

    // Verificamos que el Kardex registró VENTA_EFECTIVO y FALTANTE_SISTEMA
    const recentKardex = service.kardex();
    const shortageEntry = recentKardex.find(
      (k) =>
        k.type === 'FALTANTE_SISTEMA' &&
        (typeof k.producto === 'string' ? k.producto === 'REF-COC-600' : k.producto.sku === 'REF-COC-600'),
    );
    expect(shortageEntry).toBeDefined();
    expect(shortageEntry!.cantidad).toBe(-2); // Solo el déficit real
    expect(shortageEntry!.saldoResultante).toBe(-2);

    // Verificamos que se generó la alerta matutina
    const alert = service
      .morningAlerts()
      .find((a) => a.id.includes('REF-COC-600') || a.title.includes('REF-COC-600'));
    expect(alert).toBeDefined();
    expect(alert!.actionLabel).toBe('Resolver con PIN');
  });

  it('2. Abono parcial a cliente vencido -> amortiza deuda pero NO limpia estatus VENCIDO si queda saldo vencido', () => {
    // Tomamos un cliente vencido: CLI-03 (Familia López, saldo 520)
    const customer = service.creditCustomers().find((c) => c.id === 'CLI-03')!;
    expect(customer).toBeDefined();
    expect(customer.status).toBe('VENCIDO');
    const initialBalance = customer.currentBalance;

    // Abonamos parcialmente $200 (quedan $320 con fecha vencida)
    const abonoResult = service.registerCreditPayment('CLI-03', 200);
    expect(abonoResult.ok).toBeTrue();

    const customerAfter = service.creditCustomers().find((c) => c.id === 'CLI-03')!;
    expect(customerAfter.currentBalance).toBe(initialBalance - 200);
    // El abono parcial NO debe limpiar el estatus VENCIDO si queda saldo con fecha vencida
    expect(customerAfter.status).toBe('VENCIDO');

    // Verificamos que se registró en Kardex como ABONO_FIADO
    const abonoEntry = service.kardex().find((k) => k.type === 'ABONO_FIADO');
    expect(abonoEntry).toBeDefined();
    expect(abonoEntry!.amount).toBe(200);
  });

  it('3. Ajuste con PIN -> resuelve la alerta de faltante cuadrando el stock con autorización criptográfica', async () => {
    // Primero configuramos el PIN obligatorio (mínimo 6 dígitos no trivial)
    const pinSetup = await service.setupInitialPin('984312');
    expect(pinSetup.success).toBeTrue();

    // Provocamos un faltante en PAS-MOD-200 (stock 35) vendiendo 40 para tener alerta
    const prodMod = service.products().find((p) => p.sku === 'PAS-MOD-200')!;
    service.processCashSale(
      [
        {
          sku: 'PAS-MOD-200',
          barcode: prodMod.barcode,
          name: prodMod.name,
          emoji: '🍝',
          saleUnit: 'Pieza' as const,
          isBulk: false,
          qty: prodMod.stock + 5,
          unitPrice: prodMod.salePrice,
          subtotal: (prodMod.stock + 5) * prodMod.salePrice,
        },
      ],
      1000,
    );

    const alert = service
      .morningAlerts()
      .find((a) => a.id.includes('PAS-MOD-200') || a.title.includes('PAS-MOD-200'));
    expect(alert).toBeDefined();

    // Intentamos resolver con PIN incorrecto -> debe fallar
    const failRes = await service.resolveShortageAlertWithPin(alert!.id, 'PAS-MOD-200', 10, '000000');
    expect(failRes.ok).toBeFalse();

    // Resolvemos con PIN correcto y conteo físico real de 10 paquetes
    const okRes = await service.resolveShortageAlertWithPin(
      alert!.id,
      'PAS-MOD-200',
      10,
      '984312',
      'Don Lupe (Encargado)',
    );
    expect(okRes.ok).toBeTrue();

    // Stock cuadrado a 10 paquetes
    const prodAfter = service.products().find((p) => p.sku === 'PAS-MOD-200')!;
    expect(prodAfter.stock).toBe(10);

    // Entrada en Kardex AJUSTE_AUDITORIA registrada por Don Lupe
    const auditEntry = service.kardex().find((k) => k.type === 'AJUSTE_AUDITORIA');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.usuario).toBe('Don Lupe (Encargado)');
    expect(auditEntry!.saldoResultante).toBe(10);

    // Alerta eliminada
    const alertAfter = service.morningAlerts().find((a) => a.id === alert!.id);
    expect(alertAfter).toBeUndefined();
  });

  it('4. Baja de merma mayor a existencia: bloqueada sin PIN, permitida con PIN y motivo', async () => {
    await service.setupInitialPin('984312');

    // Usamos PAN-BIM-680 (Pan Blanco Bimbo Grande, stock 7 piezas)
    const prod = service.products().find((p) => p.sku === 'PAN-BIM-680')!;
    expect(prod).toBeDefined();
    const initialStock = prod.stock;

    const shrinkRecord: ShrinkRecord = {
      id: 'SHRINK-TEST-001',
      date: '2026-10-28',
      time: '12:00',
      sku: 'PAN-BIM-680',
      name: prod.name,
      emoji: prod.emoji,
      qty: initialStock + 10, // supera existencia
      saleUnit: 'Pieza' as const,
      reason: 'Envase Roto en Piso',
      unitCost: prod.historicCost,
      registeredBy: 'Pedro (Cajero)',
      hasPhoto: false,
      reviewed: false,
    };
    service.addShrinkRecord(shrinkRecord);

    // 1. Intento sin PIN -> Bloqueado
    const blockedRes = await service.markShrinkReviewed(shrinkRecord.id, 'Pedro (Cajero)');
    expect(blockedRes.ok).toBeFalse();
    expect(blockedRes.message).toContain('supera la existencia disponible');

    // 2. Intento con PIN pero sin motivo justificado -> Bloqueado
    const noReasonRes = await service.markShrinkReviewed(shrinkRecord.id, 'Administrador', '984312', '');
    expect(noReasonRes.ok).toBeFalse();

    // 3. Intento con PIN válido y motivo justificado -> Aprobado
    const approvedRes = await service.markShrinkReviewed(
      shrinkRecord.id,
      'Administrador',
      '984312',
      'Lote aplastado durante descarga de camión proveedor',
    );
    expect(approvedRes.ok).toBeTrue();

    const prodAfter = service.products().find((p) => p.sku === 'PAN-BIM-680')!;
    expect(prodAfter.stock).toBe(-10);

    // Kardex contiene BAJA_MERMA y FALTANTE_SISTEMA
    const entries = service.kardex();
    const mermaEntry = entries.find(
      (k) =>
        k.type === 'BAJA_MERMA' &&
        (typeof k.producto === 'string' ? k.producto === 'PAN-BIM-680' : k.producto.sku === 'PAN-BIM-680'),
    );
    expect(mermaEntry).toBeDefined();
    expect(mermaEntry!.usuario).toBe('Administrador');
  });

  it('5. Cadena de Kardex íntegra y válida tras la ejecución combinada de todas las operaciones', async () => {
    await service.setupInitialPin('984312');

    // a) Venta sin stock de ARR-SOS-900 (stock 16) vendiendo 20
    const prod = service.products().find((p) => p.sku === 'ARR-SOS-900')!;
    service.processCashSale(
      [
        {
          sku: 'ARR-SOS-900',
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 20,
          unitPrice: prod.salePrice,
          subtotal: 20 * prod.salePrice,
        },
      ],
      1000,
    );

    // b) Cambio de usuario activo a Administrador con PIN
    const switchRes = await service.setActiveUser('Administrador', '984312');
    expect(switchRes.success).toBeTrue();
    expect(service.activeUser()).toBe('Administrador');

    // c) Abono de cliente
    service.registerCreditPayment('CLI-01', 100);

    // d) Recepción de mercancía
    const receptionLines: ReceptionLine[] = [
      {
        sku: 'ARR-SOS-900',
        barcode: prod.barcode,
        name: prod.name,
        emoji: prod.emoji,
        purchaseUnit: 'Caja',
        qtyPurchase: 2,
        unitsPerPurchase: 20,
        saleUnit: 'Pieza',
        lineTotal: 1104,
        historicCost: 27.6,
        newCost: 27.6,
        salePrice: 34.0,
        targetMargin: 15,
        resolved: true,
      },
    ];
    service.saveReception(receptionLines, 'FOLIO-TEST-999');

    // e) Verificación integral de la cadena criptográfica
    const integrity = service.verifyKardexIntegrity();
    expect(integrity.valid).toBeTrue();
    expect(integrity.error).toBeUndefined();
    expect(service.kardex().length).toBeGreaterThan(3);
  });

  it('6. Persistencia (Bloque D): Guardar estado, recargar y recuperar intacto', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    // Mutamos estado: venta de 2 piezas de Coca-Cola
    const prod = service.products().find((p) => p.sku === 'REF-COC-600')!;
    service.processCashSale(
      [
        {
          sku: 'REF-COC-600',
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 2,
          unitPrice: prod.salePrice,
          subtotal: 2 * prod.salePrice,
        },
      ],
      100
    );

    // Guardamos estado
    await service.flushSave();

    // Verificamos que el adaptador contenga el estado guardado
    const savedState = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(savedState).toBeTruthy();
    expect(savedState.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // Creamos o simulamos un segundo servicio / recarga
    const restoredService = TestBed.inject(MockInventoryService);
    restoredService.storageAdapter = memoryAdapter;
    const restoreResult = await restoredService.restorePersistedState();
    expect(restoreResult.success).toBeTrue();

    // Verificamos que el producto REF-COC-600 se recuperó con el stock reducido
    const restoredProd = restoredService.products().find((p) => p.sku === 'REF-COC-600')!;
    expect(restoredProd.stock).toBe(prod.stock - 2);
    expect(restoredService.cashShift().cashSalesTotal).toBe(2 * prod.salePrice);
  });

  it('7. Persistencia (Bloque D): Dato dañado conserva copia en binnitech_pos_state_corrupt_<ISO>, bloquea autoguardado y NO sobrescribe STATE_STORAGE_KEY', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;
    await service.restorePersistedState();

    // Guardamos un dato dañado crudo en STATE_STORAGE_KEY
    const rawCorruptedPayload = {
      schemaVersion: 1,
      products: 'productos-corruptos-no-array',
      kardex: [],
    };
    await memoryAdapter.save(STATE_STORAGE_KEY, rawCorruptedPayload);

    const restoreResult = await service.restorePersistedState();
    expect(restoreResult.success).toBeFalse();
    expect(restoreResult.corrupted).toBeTrue();
    expect(restoreResult.backupKey).toBeDefined();
    expect(restoreResult.backupKey!.startsWith(CORRUPT_STATE_KEY_PREFIX)).toBeTrue();

    // 1. Verificamos que el dato crudo original NO fue sobrescrito en STATE_STORAGE_KEY
    const stillCorrupted = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(stillCorrupted).toEqual(rawCorruptedPayload);

    // 2. Verificamos que se creó la copia en 'binnitech_pos_state_corrupt_<ISO>'
    const backupCopy = await memoryAdapter.load(restoreResult.backupKey!);
    expect(backupCopy).toEqual(rawCorruptedPayload);

    // 3. Autoguardado bloqueado y modal abierto con las 3 opciones
    expect(service.autoSaveBlocked()).toBeTrue();
    expect(service.corruptedModalOpen()).toBeTrue();

    // Intentar guardar mientras está bloqueado NO debe sobrescribir STATE_STORAGE_KEY
    service.scheduleSave();
    await service.flushSave();
    const afterBlockedFlush = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(afterBlockedFlush).toEqual(rawCorruptedPayload);

    // Opción 1: Descargar datos dañados (JSON) -> devuelve JSON y NO sobrescribe
    const downloadedJson = service.downloadCorruptedDataJson();
    expect(JSON.parse(downloadedJson)).toEqual(rawCorruptedPayload);
    expect(await memoryAdapter.load(STATE_STORAGE_KEY)).toEqual(rawCorruptedPayload);

    // Opción 2: "Empezar con datos de demostración" con confirmación -> ÚNICA opción que sobrescribe
    service.requestStartWithDemoDataConfirmation();
    expect(service.corruptedConfirmOverwrite()).toBeTrue();
    await service.confirmStartWithDemoData();

    expect(service.autoSaveBlocked()).toBeFalse();
    expect(service.corruptedModalOpen()).toBeFalse();
    const overwrittenState = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(Array.isArray(overwrittenState.products)).toBeTrue();
    // Y la copia del dato dañado sigue intacta en su clave de respaldo
    expect(await memoryAdapter.load(restoreResult.backupKey!)).toEqual(rawCorruptedPayload);
  });

  it('8. Persistencia (Bloque D): Migración simple de versión anterior (v0 -> v1)', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    const initialKardexEntry = createKardexEntry(
      {
        type: 'ENTRADA_COMPRA',
        producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', saleUnit: 'Pieza' },
        cantidad: 25,
        saldoAnterior: 0,
        saldoResultante: 25,
        usuario: 'Don Lupe (Encargado)',
        referencia: 'Inventario Inicial',
      },
      'GENESIS'
    );

    // Guardamos estado versión 0 (datos antiguos sin schemaVersion explícito)
    await memoryAdapter.save(STATE_STORAGE_KEY, {
      timestamp: '2026-10-20T00:00:00.000Z',
      activeUser: 'Don Lupe (Encargado)',
      products: [
        {
          sku: 'LAC-LAL-1L',
          name: 'Leche Lala Entera 1L',
          stock: 25,
          salePrice: 28,
        },
      ],
      creditCustomers: [],
      kardex: [initialKardexEntry],
      shrinkRecords: [],
      auditLines: [],
    });

    const restoreResult = await service.restorePersistedState();
    expect(restoreResult.success).toBeTrue();

    // Verificamos que el estado ahora tiene versión 1 y colecciones inicializadas
    const snapshot = service.getPersistedStateSnapshot();
    expect(snapshot.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(service.products().length).toBe(1);
    expect(service.products()[0].sku).toBe('LAC-LAL-1L');
    expect(service.products()[0].stock).toBe(25);
  });

  it('9. Persistencia (Bloque D): Botón "Restablecer datos de demostración" limpia almacenamiento y restaura valores de fábrica', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;
    await service.restorePersistedState();

    // Modificamos datos
    service.products.update((list) => list.slice(0, 1));
    expect(service.products().length).toBe(1);

    await service.flushSave();

    // Ejecutamos resetToDemoData
    await service.resetToDemoData();

    // Verificamos que se restauraron los 5+ productos base de catálogo
    expect(service.products().length).toBeGreaterThan(3);
    expect(service.creditCustomers().length).toBeGreaterThan(1);
    expect(service.corruptedDataWarning()).toBeNull();
  });

  it('10. Persistencia (Bloque D): Evento pagehide guarda inmediatamente lo pendiente (flushSave)', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;
    await service.restorePersistedState();

    // Hacemos un cambio menor diferido (con scheduleSave / debounce de 500 ms)
    service.activeUser.set('Pedro (Cajero)');
    service.scheduleSave();

    // Antes de que pasen los 500 ms del debounce, aún no se ha volcado a storageAdapter
    const beforePageHide = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(beforePageHide).toBeNull();

    // Disparamos el evento 'pagehide' en window
    window.dispatchEvent(new Event('pagehide'));

    // Esperamos microtareas para que la promesa de flushSave concluya
    await new Promise((resolve) => setTimeout(resolve, 15));

    const afterPageHide = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(afterPageHide).toBeTruthy();
    expect(afterPageHide.activeUser).toBe('Pedro (Cajero)');
  });

  it('11. Persistencia (Bloque D): Stock alterado se detecta en el arranque con verifyProductContinuity(productos, kardex) y lista los SKU afectados', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;
    await service.restorePersistedState();

    // Guardamos un estado válido inicial
    await service.flushSave();
    const validSaved = await memoryAdapter.load(STATE_STORAGE_KEY);
    expect(validSaved).toBeTruthy();

    // Alteramos directamente el stock de REF-COC-600 en el almacenamiento sin pasar por el Kardex
    const tamperedState = structuredClone(validSaved);
    const targetProd = tamperedState.products.find((p: any) => p.sku === 'REF-COC-600');
    expect(targetProd).toBeDefined();
    targetProd.stock = 999; // El Kardex dice 14, pero el stock fue alterado a 999
    await memoryAdapter.save(STATE_STORAGE_KEY, tamperedState);

    // Al restaurar en el arranque, verifyProductContinuity debe detectar la discrepancia
    const restoreResult = await service.restorePersistedState();
    expect(restoreResult.success).toBeFalse();
    expect(restoreResult.corrupted).toBeTrue();
    expect(restoreResult.affectedSkus).toContain('REF-COC-600');

    // Se trata igual que datos dañados: autoguardado bloqueado, modal abierto, lista de SKUs afectados y copia de respaldo
    expect(service.autoSaveBlocked()).toBeTrue();
    expect(service.corruptedModalOpen()).toBeTrue();
    expect(service.corruptedAffectedSkus()).toContain('REF-COC-600');
    expect(service.corruptedDataWarning()).toContain('REF-COC-600');
  });

  it('12. Persistencia (Bloque D): Mensaje LAN recibido antes de hidratar se encola y se aplica después en orden', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    // Preparamos un estado válido en el adaptador antes de hidratar
    await service.restorePersistedState();
    await service.flushSave();

    // Simulamos el estado previo a terminar la hidratación (isHydrated = false)
    service.isHydrated.set(false);
    service.scannedBarcodesHistory.set([]);
    const shrinkCountBefore = service.shrinkRecords().length;

    // Enviamos 3 mensajes LAN mientras isHydrated === false
    service.handleIncomingLanMessage({ type: 'BARCODE_SCANNED', barcode: '7501055300075' });
    service.handleIncomingLanMessage({ type: 'BARCODE_SCANNED', barcode: '7501000111204' });
    service.handleIncomingLanMessage({
      type: 'MERMA_SUBMIT',
      record: {
        id: 'M-LAN-PREHYDRATE-1',
        date: '22/10/2026',
        time: '09:15',
        sku: 'PAN-BIM-680',
        name: 'Pan Blanco Bimbo Grande 680g',
        emoji: '🍞',
        qty: 1,
        saleUnit: 'Pieza',
        reason: 'Envase Roto en Piso',
        unitCost: 38.0,
        registeredBy: 'Celular LAN',
        hasPhoto: false,
        reviewed: false,
      },
    });

    // Mientras no ha hidratado, aún NO se han aplicado
    expect(service.scannedBarcodesHistory().length).toBe(0);
    expect(service.shrinkRecords().some((r) => r.id === 'M-LAN-PREHYDRATE-1')).toBeFalse();

    // Completamos la hidratación llamando a restorePersistedState()
    const restoreRes = await service.restorePersistedState();
    expect(restoreRes.success).toBeTrue();
    expect(service.isHydrated()).toBeTrue();

    // Los mensajes encolados se aplicaron después de hidratar, en estricto orden FIFO
    expect(service.scannedBarcodesHistory()).toEqual(['7501055300075', '7501000111204']);
    expect(service.lastScannedBarcode()).toBe('7501000111204');
    expect(service.shrinkRecords().length).toBe(shrinkCountBefore + 1);
    expect(service.shrinkRecords()[0].id).toBe('M-LAN-PREHYDRATE-1');
  });

  it('13. Persistencia (Bloque D): Dos instancias concurrentes -> solo una escribe y la segunda entra en modo solo lectura', async () => {
    const sharedAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = sharedAdapter;
    await service.restorePersistedState();

    // La primera instancia (service) ya adquirió el bloqueo 'binnitech_pos_writer'
    const firstHasLock = await service.acquireWriterLock();
    expect(firstHasLock).toBeTrue();
    expect(service.isReadOnlyMode()).toBeFalse();

    // Creamos una segunda instancia concurrente que intenta adquirir 'binnitech_pos_writer'
    const secondInstance = new MockInventoryService();
    secondInstance.storageAdapter = sharedAdapter;
    const secondHasLock = await secondInstance.acquireWriterLock();

    expect(secondHasLock).toBeFalse();
    expect(secondInstance.isReadOnlyMode()).toBeTrue();
    expect(secondInstance.readOnlyWarning()).toBe('Esta app ya está abierta en otra ventana');

    // La primera instancia escribe un cambio en el almacenamiento
    const prod = service.products().find((p) => p.sku === 'REF-COC-600')!;
    const sale1 = service.processCashSale(
      [
        {
          sku: 'REF-COC-600',
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: prod.salePrice,
          subtotal: prod.salePrice,
        },
      ],
      100
    );
    expect(sale1.ok).toBeTrue();
    await service.flushSave();

    const savedByFirst = await sharedAdapter.load(STATE_STORAGE_KEY);
    expect(savedByFirst).toBeTruthy();
    expect(savedByFirst.cashShift.cashSalesTotal).toBe(prod.salePrice);

    // La segunda instancia intenta vender o guardar -> es rechazada por estar en modo solo lectura y NO sobrescribe
    const sale2 = secondInstance.processCashSale(
      [
        {
          sku: 'REF-COC-600',
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 5,
          unitPrice: prod.salePrice,
          subtotal: 5 * prod.salePrice,
        },
      ],
      500
    );
    expect(sale2.ok).toBeFalse();
    expect(sale2.message).toContain('Esta app ya está abierta en otra ventana');

    secondInstance.activeUser.set('Intruso Solo Lectura');
    secondInstance.scheduleSave();
    await secondInstance.flushSave();

    const verifyStillFirst = await sharedAdapter.load(STATE_STORAGE_KEY);
    expect(verifyStillFirst.cashShift.cashSalesTotal).toBe(prod.salePrice);
    expect(verifyStillFirst.activeUser).not.toBe('Intruso Solo Lectura');

    await secondInstance.releaseWriterLock();
    secondInstance.ngOnDestroy();
  });

  it('14. Persistencia (Bloque D): IndexedDbStateStorageAdapter real en navegador resuelve en tx.oncomplete y conserva las 3 copias corruptas más recientes', async () => {
    const idbAdapter = new IndexedDbStateStorageAdapter('binnitech_test_idb_spec', 'app_state');
    await idbAdapter.clear();

    service.storageAdapter = idbAdapter;

    // 1. Guardamos dato dañado 4 veces con distintas marcas de tiempo y restauramos para provocar 4 respaldos
    for (let i = 1; i <= 4; i++) {
      await idbAdapter.save(STATE_STORAGE_KEY, {
        schemaVersion: 1,
        products: `corrupto-intento-${i}`,
        kardex: [],
      });
      await new Promise((r) => setTimeout(r, 5));
      const res = await service.restorePersistedState();
      expect(res.corrupted).toBeTrue();
    }

    // Verificamos en IndexedDB real que existen exactamente 3 copias 'binnitech_pos_state_corrupt_<ISO>' y la clave principal intacta
    const allKeys = await idbAdapter.listKeys();
    const corruptKeys = allKeys.filter((k) => k.startsWith(CORRUPT_STATE_KEY_PREFIX)).sort();
    expect(corruptKeys.length).toBe(3);

    const latestBackup = await idbAdapter.load(corruptKeys[2]);
    expect(latestBackup.products).toBe('corrupto-intento-4');

    const mainStillUntouched = await idbAdapter.load(STATE_STORAGE_KEY);
    expect(mainStillUntouched.products).toBe('corrupto-intento-4');

    await idbAdapter.clear();
  });

  it('15. Respaldo Cifrado (Bloque E): Ciclo respaldar -> restaurar conserva el Kardex válido y la continuidad de productos', async () => {
    const encryptedAdapter = new InMemoryEncryptedBackupAdapter(30, 5_000);
    service.backupAdapter = encryptedAdapter;

    // 1. Ejecutamos operaciones que generan entradas encadenadas en el Kardex
    const prod = service.products().find((p) => p.sku === 'LAC-LAL-1L')!;
    const initialStock = prod.stock;
    const saleRes = service.processCashSale(
      [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 3,
          unitPrice: prod.salePrice,
          subtotal: 3 * prod.salePrice,
        },
      ],
      100
    );
    expect(saleRes.ok).toBeTrue();
    await service.flushSave();

    const expectedKardexLen = service.kardex().length;
    const expectedHeadHash = service.kardex()[0].entryHash;

    // 2. Creamos respaldo cifrado con frase de >= 8 caracteres
    const backupRes = await service.backupNow('frase-respaldo-segura-2026');
    expect(backupRes.ok).toBeTrue();
    expect(backupRes.entry).toBeDefined();
    expect(backupRes.entry!.nombre.endsWith('.bak')).toBeTrue();
    expect(service.backupSaveLabel()).toBe('Guardado');
    expect(service.getRelativeLastBackupLabel()).toBe('hace unos segundos');

    // 3. Restablecemos a datos de demostración (perdiendo la venta de 3 unidades)
    await service.resetToDemoData();
    expect(service.products().find((p) => p.sku === 'LAC-LAL-1L')!.stock).toBe(initialStock);

    // 4. Restauramos desde el respaldo cifrado .bak
    const restoreRes = await service.restoreFromBackup(
      'frase-respaldo-segura-2026',
      backupRes.entry!.nombre
    );
    expect(restoreRes.ok).toBeTrue();
    expect(restoreRes.status).toBe(200);

    // 5. Verificamos que el stock, la caja y el Kardex encadenado se conservaron íntegros
    expect(service.products().find((p) => p.sku === 'LAC-LAL-1L')!.stock).toBe(initialStock - 3);
    expect(service.kardex().length).toBe(expectedKardexLen);
    expect(service.kardex()[0].entryHash).toBe(expectedHeadHash);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();
    expect(verifyProductContinuity(service.products(), service.kardex(), 'newest-first').valid).toBeTrue();
  });

  it('16. Respaldo Cifrado (Bloque E): Frase incorrecta o archivo manipulado responde 403 y NO altera los datos actuales', async () => {
    const encryptedAdapter = new InMemoryEncryptedBackupAdapter(30, 5_000);
    service.backupAdapter = encryptedAdapter;

    // Creamos un respaldo inicial
    const backupRes = await service.backupNow('frase-correcta-tienda');
    expect(backupRes.ok).toBeTrue();

    // Realizamos una nueva venta después del respaldo (estado actual distinto al del respaldo)
    const prod = service.products().find((p) => p.sku === 'ATU-DOL-140')!;
    service.processCashSale(
      [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 2,
          unitPrice: prod.salePrice,
          subtotal: 2 * prod.salePrice,
        },
      ],
      100
    );
    await service.flushSave();

    const currentStock = service.products().find((p) => p.sku === 'ATU-DOL-140')!.stock;
    const currentCash = service.cashShift().cashSalesTotal;
    const currentKardexHash = service.kardex()[0].entryHash;

    // 1. Intentamos restaurar con una frase INCORRECTA
    const wrongPhraseRes = await service.restoreFromBackup(
      'frase-equivocada-intruso',
      backupRes.entry!.nombre
    );
    expect(wrongPhraseRes.ok).toBeFalse();
    expect(wrongPhraseRes.status).toBe(403);
    expect(service.backupSaveLabel()).toBe('No se pudo guardar');

    // Los datos actuales en memoria e IndexedDB NO se alteraron
    expect(service.products().find((p) => p.sku === 'ATU-DOL-140')!.stock).toBe(currentStock);
    expect(service.cashShift().cashSalesTotal).toBe(currentCash);
    expect(service.kardex()[0].entryHash).toBe(currentKardexHash);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();

    // 2. Manipulamos 1 byte del archivo .bak y probamos con la frase correcta -> también rechaza 403 sin alterar datos
    encryptedAdapter.tamperWithFile(backupRes.entry!.nombre);
    const tamperedRes = await service.restoreFromBackup(
      'frase-correcta-tienda',
      backupRes.entry!.nombre
    );
    expect(tamperedRes.ok).toBeFalse();
    expect(tamperedRes.status).toBe(403);
    expect(service.products().find((p) => p.sku === 'ATU-DOL-140')!.stock).toBe(currentStock);
  });

  it('17. Respaldo Cifrado (Bloque E): Respaldo automático al cerrar caja y por hora si hay cambios, sin guardar la frase en disco/storage', async () => {
    const encryptedAdapter = new InMemoryEncryptedBackupAdapter(30, 2_000);
    service.backupAdapter = encryptedAdapter;

    // 1. Respaldo automático al cerrar turno de caja
    const closeBackup = await service.closeShiftWithAutoBackup('clave-cierre-turno-88');
    expect(closeBackup).toBeTruthy();
    expect(closeBackup!.ok).toBeTrue();
    expect(service.backupList().length).toBe(1);

    // 2. Si no hay cambios desde el último respaldo, el respaldo horario no duplica archivos
    const noChangeHourly = await service.runHourlyAutoBackupIfChanged();
    expect(noChangeHourly).toBeNull();
    expect(service.backupList().length).toBe(1);

    // 3. Al ocurrir un cambio y ejecutarse el ciclo horario, se genera un nuevo respaldo cifrado
    service.activeUser.set('Toño (Mostrador)');
    await service.flushSave();
    expect(service.hasChangesSinceLastBackup()).toBeTrue();

    const changedHourly = await service.runHourlyAutoBackupIfChanged();
    expect(changedHourly).toBeTruthy();
    expect(changedHourly!.ok).toBeTrue();
    expect(service.backupList().length).toBe(2);

    // 4. Verificamos que la frase NUNCA se guardó en localStorage ni en el adaptador de persistencia
    const persisted = await service.storageAdapter.load(STATE_STORAGE_KEY);
    expect(JSON.stringify(persisted)).not.toContain('clave-cierre-turno-88');
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        expect(localStorage.getItem(k)).not.toContain('clave-cierre-turno-88');
      }
    }
  });

  it('18. Guarda central assertWritable(): recorre TODOS los métodos mutadores en modo solo lectura y verifica que el estado no cambia', async () => {
    await service.setupInitialPin('984312');

    // Modificamos un dato inicial antes de entrar en modo solo lectura para comprobar que tampoco resetToDemoData lo revierte
    const targetSku = 'LAC-LAL-1L';
    const prod = service.products().find((p) => p.sku === targetSku)!;
    service.processCashSale(
      [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: prod.salePrice,
          subtotal: prod.salePrice,
        },
      ],
      100
    );
    await service.flushSave();

    // Activamos modo solo lectura en la instancia
    service.isReadOnlyMode.set(true);
    service.readOnlyWarning.set('Esta app ya está abierta en otra ventana');
    expect(service.assertWritable()).toBeFalse();

    const assertSpy = spyOn(service, 'assertWritable').and.callThrough();

    // Capturamos foto completa del estado antes de recorrer los métodos mutadores
    const captureState = () => {
      const { timestamp: _ts, ...persistedWithoutTimestamp } = structuredClone(
        service.getPersistedStateSnapshot()
      );
      return {
        persisted: persistedWithoutTimestamp,
        abcPinned: structuredClone(service.abcPinned()),
        abcProposalDismissed: service.abcProposalDismissed(),
        pinnedQuickAccess: structuredClone(service.pinnedQuickAccessSkus()),
        dismissedQuickAccess: structuredClone(service.dismissedQuickAccessSuggestions()),
        ocrNote: structuredClone(service.ocrNote()),
        perishableBatches: structuredClone(service.perishableBatches()),
        corruptedConfirmOverwrite: service.corruptedConfirmOverwrite(),
      };
    };

    const beforeState = captureState();

    const sampleCart = [
      {
        sku: prod.sku,
        barcode: prod.barcode,
        name: prod.name,
        emoji: prod.emoji,
        saleUnit: prod.saleUnit,
        isBulk: false,
        qty: 2,
        unitPrice: prod.salePrice,
        subtotal: 2 * prod.salePrice,
      },
    ];

    const mutatorInvocations: Array<{ name: string; run: () => Promise<any> | any }> = [
      { name: 'resetToDemoData', run: () => service.resetToDemoData() },
      { name: 'confirmStartWithDemoData', run: () => service.confirmStartWithDemoData() },
      { name: 'requestStartWithDemoDataConfirmation', run: () => service.requestStartWithDemoDataConfirmation() },
      { name: 'cancelStartWithDemoDataConfirmation', run: () => service.cancelStartWithDemoDataConfirmation() },
      { name: 'toggleTrafficDriver', run: () => service.toggleTrafficDriver(targetSku) },
      { name: 'pinAbc', run: () => service.pinAbc(targetSku, 'C') },
      {
        name: 'applyAbcResults',
        run: () =>
          service.applyAbcResults([
            {
              sku: targetSku,
              currentClass: 'A',
              computedClass: 'C',
              finalClass: 'C',
              source: 'MANUAL',
              share: 0.1,
              cumulativeBefore: 0,
              rank: 1,
              grossProfit: 100,
              ticketCount: 10,
              changed: true,
              reason: 'Test',
              flags: [],
            },
          ]),
      },
      {
        name: 'confirmClassificationChanges',
        run: () =>
          service.confirmClassificationChanges([
            {
              sku: targetSku,
              name: prod.name,
              currentClass: 'A',
              proposedClass: 'C',
              vu: 10,
              sharePct: 5,
            } as any,
          ]),
      },
      { name: 'dismissAbcProposal', run: () => service.dismissAbcProposal() },
      { name: 'pinProductQuickAccess', run: () => service.pinProductQuickAccess('JAB-ZOT-400') },
      { name: 'unpinProductQuickAccess', run: () => service.unpinProductQuickAccess('HUE-BAC-18') },
      { name: 'dismissQuickAccessSuggestion', run: () => service.dismissQuickAccessSuggestion(targetSku) },
      { name: 'setActiveUser', run: () => service.setActiveUser('Pedro (Cajero Tarde)') },
      { name: 'setupInitialPin', run: () => service.setupInitialPin('837465') },
      { name: 'configureAdminPin', run: () => service.configureAdminPin('837465') },
      { name: 'processCashSale', run: () => service.processCashSale(sampleCart, 200) },
      { name: 'processCreditSale', run: () => service.processCreditSale(sampleCart, 'CLI-01') },
      { name: 'processSale', run: () => service.processSale(sampleCart, 'EFECTIVO') },
      {
        name: 'processInternalConsumption',
        run: () => service.processInternalConsumption(sampleCart, 'Don Lupe (Encargado)'),
      },
      {
        name: 'resolveShortageAlertWithPin',
        run: () => service.resolveShortageAlertWithPin('A1', targetSku, 50, '984312'),
      },
      { name: 'registerCreditPayment', run: () => service.registerCreditPayment('CLI-01', 50) },
      { name: 'reloadOcrNote', run: () => service.reloadOcrNote() },
      { name: 'setCustomOcrNote', run: () => service.setCustomOcrNote([], 'FOLIO-RO') },
      {
        name: 'saveReception',
        run: () =>
          service.saveReception(
            [
              {
                sku: targetSku,
                name: prod.name,
                emoji: prod.emoji,
                qtyPurchase: 10,
                purchaseUnit: 'Pieza',
                unitsPerPurchase: 1,
                saleUnit: 'Pieza',
                lineTotal: 210,
                historicCost: 21,
                newCost: 21,
                salePrice: 26,
                targetMargin: 20,
                resolved: true,
              },
            ],
            'FOLIO-RO'
          ),
      },
      { name: 'setAuditStatus', run: () => service.setAuditStatus('ACE-NUT-850', 'autorizado') },
      {
        name: 'addShrinkRecord',
        run: () =>
          service.addShrinkRecord({
            id: 'M-RO-999',
            date: '22/10/2026',
            time: '12:00',
            sku: targetSku,
            name: prod.name,
            emoji: prod.emoji,
            qty: 1,
            saleUnit: 'Pieza',
            reason: 'Envase Roto en Piso',
            unitCost: 21,
            registeredBy: 'Test RO',
            hasPhoto: false,
            reviewed: false,
          }),
      },
      { name: 'markShrinkReviewed', run: () => service.markShrinkReviewed('M-0412', 'Admin', '984312', 'Test') },
      { name: 'authorizeShrinkReview', run: () => service.authorizeShrinkReview('M-0412', '984312', 'Admin', 'Test') },
      {
        name: 'resolvePhysicalExchange',
        run: () => service.resolvePhysicalExchange('LOT-LAL-201', 'CAMBIO_EFECTIVO', '2026-12-31'),
      },
      {
        name: 'registerNewQuickProduct',
        run: () => service.registerNewQuickProduct('Producto RO', 'Abarrotes', false, 15, 20),
      },
      {
        name: 'submitBlindAuditResults',
        run: () => service.submitBlindAuditResults([{ sku: targetSku, countedQty: 99 }]),
      },
      {
        name: 'applySquareAdjustment',
        run: () => service.applySquareAdjustment('ACE-NUT-850', 'MERMA_OPERATIVA'),
      },
      {
        name: 'authorizeAndApplySquareAdjustment',
        run: () => service.authorizeAndApplySquareAdjustment('ACE-NUT-850', 'MERMA_OPERATIVA', '984312'),
      },
      {
        name: 'handleIncomingLanMessage',
        run: () => service.handleIncomingLanMessage({ type: 'BARCODE_SCANNED', barcode: '7501020515350' }),
      },
      {
        name: 'restoreFromBackup',
        run: () => service.restoreFromBackup('frase-respaldo-segura', '20261022-120000.bak'),
      },
      {
        name: 'importAndRestoreFromBakBytes',
        run: () => service.importAndRestoreFromBakBytes(new Uint8Array(64), 'frase-respaldo-segura'),
      },
      { name: 'undoLastRestore', run: () => service.undoLastRestore() },
      {
        name: 'createCatalogProduct',
        run: () =>
          service.createCatalogProduct({
            name: 'Producto RO F1',
            sku: 'ABA-RO-001',
            category: 'Abarrotes',
            location: 'Pasillo 1',
            saleUnit: 'Pieza',
            purchaseUnit: 'Caja',
            unitsPerPurchase: 24,
            unitCost: 10,
            salePrice: 15,
            ivaRate: 16,
            iepsRate: 0,
            rop: 5,
            initialStock: 10,
            pin: '984312',
          }),
      },
      {
        name: 'updateCatalogProduct',
        run: () =>
          service.updateCatalogProduct(targetSku, {
            name: prod.name,
            sku: targetSku,
            category: prod.category,
            location: 'Pasillo 1',
            saleUnit: prod.saleUnit,
            purchaseUnit: prod.purchaseUnit,
            unitsPerPurchase: prod.unitsPerPurchase,
            unitCost: prod.unitCost,
            salePrice: prod.salePrice,
            ivaRate: 16,
            iepsRate: 0,
            rop: prod.rop,
          }),
      },
      {
        name: 'deactivateOrDeleteCatalogProduct',
        run: () => service.deactivateOrDeleteCatalogProduct(targetSku, '984312'),
      },
      {
        name: 'deletePhysicalProduct',
        run: () => service.deletePhysicalProduct(targetSku, '984312'),
      },
      {
        name: 'reactivateCatalogProduct',
        run: () => service.reactivateCatalogProduct(targetSku, '984312'),
      },
      {
        name: 'assignInternalBarcodeToProduct',
        run: () => service.assignInternalBarcodeToProduct(targetSku),
      },
      {
        name: 'setMaxDiscountPctWithoutPin',
        run: () => service.setMaxDiscountPctWithoutPin(15, '984312'),
      },
      {
        name: 'processSaleWithDiscounts',
        run: () =>
          service.processSaleWithDiscounts({
            items: [
              {
                sku: targetSku,
                barcode: prod.barcode,
                name: prod.name,
                emoji: prod.emoji,
                saleUnit: prod.saleUnit,
                isBulk: false,
                qty: 1,
                unitPrice: prod.salePrice,
                subtotal: prod.salePrice,
              },
            ],
            paymentMethod: 'EFECTIVO',
            receivedAmount: 100,
          }),
      },
      {
        name: 'handleProductCreateRequestFromLan',
        run: () =>
          service.handleProductCreateRequestFromLan({
            barcode: '7509998887776',
            name: 'Producto Móvil RO',
            salePrice: 20,
            cost: 15,
            saleUnit: 'Pieza',
          }),
      },
    ];

    for (const mutator of mutatorInvocations) {
      const callsBefore = assertSpy.calls.count();
      await mutator.run();
      expect(assertSpy.calls.count())
        .withContext(`El método mutador "${mutator.name}" debe invocar assertWritable()`)
        .toBeGreaterThan(callsBefore);
    }

    const afterState = captureState();
    expect(afterState).toEqual(beforeState);
  });

  it('19. Restaurar (Bloque E): valida con validateStoredState (cadena y continuidad), guarda binnitech_pos_state_prerestore_<ISO> y ofrece "Deshacer restauración"', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;
    const encryptedAdapter = new InMemoryEncryptedBackupAdapter(30, 2_000);
    service.backupAdapter = encryptedAdapter;

    // 1. Creamos un respaldo en el estado A (stock inicial de LAC-LAL-1L = 20)
    const prodInitial = service.products().find((p) => p.sku === 'LAC-LAL-1L')!;
    const stockStateA = prodInitial.stock;
    const backupRes = await service.backupNow('frase-prerestore-2026');
    expect(backupRes.ok).toBeTrue();

    // 2. Avanzamos al estado B: vendemos 4 unidades de LAC-LAL-1L (stock pasa a 16)
    service.processCashSale(
      [
        {
          sku: prodInitial.sku,
          barcode: prodInitial.barcode,
          name: prodInitial.name,
          emoji: prodInitial.emoji,
          saleUnit: prodInitial.saleUnit,
          isBulk: false,
          qty: 4,
          unitPrice: prodInitial.salePrice,
          subtotal: 4 * prodInitial.salePrice,
        },
      ],
      300
    );
    await service.flushSave();
    const stockStateB = service.products().find((p) => p.sku === 'LAC-LAL-1L')!.stock;
    expect(stockStateB).toBe(stockStateA - 4);

    // 3. Restauramos el respaldo del estado A -> debe guardar el estado B en 'binnitech_pos_state_prerestore_<ISO>'
    const restoreRes = await service.restoreFromBackup(
      'frase-prerestore-2026',
      backupRes.entry!.nombre
    );
    expect(restoreRes.ok).toBeTrue();
    expect(restoreRes.preRestoreKey).toBeDefined();
    expect(restoreRes.preRestoreKey!.startsWith(PRERESTORE_STATE_KEY_PREFIX)).toBeTrue();
    expect(service.canUndoRestore()).toBeTrue();
    expect(service.products().find((p) => p.sku === 'LAC-LAL-1L')!.stock).toBe(stockStateA);

    // Verificamos que la copia prerestore existe en storageAdapter con el estado B
    const savedPreRestore = await memoryAdapter.load(restoreRes.preRestoreKey!);
    expect(savedPreRestore).toBeTruthy();
    expect(savedPreRestore.products.find((p: any) => p.sku === 'LAC-LAL-1L').stock).toBe(stockStateB);

    // 4. Ejecutamos "Deshacer restauración" (undoLastRestore) -> vuelve al estado B
    const undoRes = await service.undoLastRestore();
    expect(undoRes.ok).toBeTrue();
    expect(service.canUndoRestore()).toBeFalse();
    expect(service.products().find((p) => p.sku === 'LAC-LAL-1L')!.stock).toBe(stockStateB);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();
  });

  it('20. Sin frase en memoria (Bloque E): muestra aviso permanente, detecta respaldo > 24 h y el cierre de turno exige la frase antes de cerrar', async () => {
    const encryptedAdapter = new InMemoryEncryptedBackupAdapter(30, 2_000);
    service.backupAdapter = encryptedAdapter;

    // 1. Al iniciar sin frase en memoria, el aviso permanente está activo
    service.clearSessionBackupPassphrase();
    expect(service.hasSessionBackupPassphrase()).toBeFalse();
    expect(service.autoBackupStoppedWarning()).toBe('Respaldo automático detenido: ingresa la frase');

    // 2. Con respaldo de hace > 24 h, isBackupOlderThan24h() activa el banner
    service.lastBackupIso.set(null);
    expect(service.isBackupOlderThan24h()).toBeFalse();

    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    service.lastBackupIso.set(twentyFiveHoursAgo);
    expect(service.isBackupOlderThan24h()).toBeTrue();

    // 3. El cierre de turno sin frase en memoria ni frase explícita falla con 400 pidiendo la frase
    const closeWithoutPhrase = await service.closeShiftWithAutoBackup();
    expect(closeWithoutPhrase.ok).toBeFalse();
    expect(closeWithoutPhrase.status).toBe(400);
    expect(closeWithoutPhrase.message).toContain('frase de respaldo');

    // 4. Al proporcionar la frase en el cierre de turno, se realiza el respaldo, desaparece el aviso y isBackupOlderThan24h() pasa a false
    const closeWithPhrase = await service.closeShiftWithAutoBackup('frase-cierre-obligatoria');
    expect(closeWithPhrase.ok).toBeTrue();
    expect(service.hasSessionBackupPassphrase()).toBeTrue();
    expect(service.autoBackupStoppedWarning()).toBeNull();
    expect(service.isBackupOlderThan24h()).toBeFalse();
  });

  it('21. Importar un .bak desde disco o USB para restaurar en otra PC (importAndRestoreFromBakBytes)', async () => {
    // Simulamos PC 1: vende 5 unidades de FRI-NEG-50K y genera bytes cifrados .bak para USB/disco
    const prod = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    const initialStock = prod.stock;
    service.processCashSale(
      [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: true,
          qty: 5,
          unitPrice: prod.salePrice,
          subtotal: 5 * prod.salePrice,
        },
      ],
      300
    );
    await service.flushSave();

    const pc1Snapshot = service.getPersistedStateSnapshot();
    const plainBytes = new TextEncoder().encode(JSON.stringify(pc1Snapshot));
    const usbBakBytes = await encryptBackupBytes(plainBytes, 'frase-usb-otra-pc', 2_000);

    // Simulamos PC 2 (con datos iniciales limpios) que importa el archivo .bak desde USB
    await service.resetToDemoData();
    expect(service.products().find((p) => p.sku === 'FRI-NEG-50K')!.stock).toBe(initialStock);

    // Frase incorrecta al importar desde USB -> 403 y no altera estado
    const badImport = await service.importAndRestoreFromBakBytes(
      usbBakBytes,
      'frase-incorrecta-usb',
      'usb-respaldo.bak'
    );
    expect(badImport.ok).toBeFalse();
    expect(badImport.status).toBe(403);
    expect(service.products().find((p) => p.sku === 'FRI-NEG-50K')!.stock).toBe(initialStock);

    // Frase correcta al importar desde USB -> restaura estado de PC 1 y guarda prerestore
    const goodImport = await service.importAndRestoreFromBakBytes(
      usbBakBytes,
      'frase-usb-otra-pc',
      'usb-respaldo.bak'
    );
    expect(goodImport.ok).toBeTrue();
    expect(goodImport.status).toBe(200);
    expect(goodImport.preRestoreKey?.startsWith(PRERESTORE_STATE_KEY_PREFIX)).toBeTrue();
    expect(service.products().find((p) => p.sku === 'FRI-NEG-50K')!.stock).toBe(initialStock - 5);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();
  });

  it('22. flushSave ya no traga errores: un adaptador que lanza error deja visible "No se pudo guardar"', async () => {
    const failingAdapter: StateStorageAdapter = {
      async save(): Promise<void> {
        throw new Error('QuotaExceededError: Disco lleno en IndexedDB');
      },
      async load(): Promise<any> {
        return null;
      },
      async clear(): Promise<void> {},
    };

    service.storageAdapter = failingAdapter;

    // Ejecutamos una venta o flushSave directo con el adaptador que falla
    const prod = service.products().find((p) => p.sku === 'LAC-LAL-1L')!;
    service.processCashSale(
      [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: prod.salePrice,
          subtotal: prod.salePrice,
        },
      ],
      50
    );
    await service.flushSave();

    // Esperamos microtareas para verificar que ningún effect() sobrescriba el estado de error
    await new Promise((r) => setTimeout(r, 20));

    expect(service.indexedDbSaveStatus()).toBe('error');
    expect(service.indexedDbSaveLabel()).toBe('No se pudo guardar');
    expect(service.lastSaveError()).toContain('QuotaExceededError');
  });

  // =========================================================================
  //  BLOQUE F1: CATÁLOGO (Alta, baja lógica, códigos múltiples, precios
  //  escalonados, descuentos con tope/PIN, tolerancia de merma natural y
  //  PRODUCT_CREATE_REQUEST desde móvil)
  // =========================================================================

  it('23. Bloque F1 (Integración): Crear producto con stock inicial (AJUSTE_INICIAL + PIN), venderlo, verlo en el Kardex y que persista tras recargar', async () => {
    await service.setupInitialPin('984312');
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    // 1. Intento de crear producto con stock inicial sin PIN -> falla pidiendo PIN
    const noPinRes = await service.createCatalogProduct({
      name: 'Café Soluble Olla 200g',
      sku: 'ABA-CAF-200',
      category: 'Abarrotes',
      location: 'Pasillo 2 · Estante B',
      saleUnit: 'Pieza',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 12,
      packageCost: 720, // $720 / 12 = $60.00 costo unitario
      salePrice: 85,
      ivaRate: 0,
      iepsRate: 0,
      rop: 6,
      initialStock: 24,
      barcodes: ['7501059299016', '7501059299023'],
      priceTiers: [
        { tier: 'MENUDEO', label: 'Menudeo', minQty: 1, unitPrice: 85 },
        { tier: 'MEDIO_MAYOREO', label: 'Medio Mayoreo', minQty: 6, unitPrice: 80 },
        { tier: 'MAYOREO', label: 'Mayoreo', minQty: 12, unitPrice: 74 },
      ],
    });
    expect(noPinRes.ok).toBeFalse();
    expect(noPinRes.requiresPin).toBeTrue();

    // 2. Crear producto con PIN de Administrador ('984312') -> genera AJUSTE_INICIAL en el Kardex
    const createRes = await service.createCatalogProduct({
      name: 'Café Soluble Olla 200g',
      sku: 'ABA-CAF-200',
      category: 'Abarrotes',
      location: 'Pasillo 2 · Estante B',
      saleUnit: 'Pieza',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 12,
      packageCost: 720,
      salePrice: 85,
      ivaRate: 0,
      iepsRate: 0,
      rop: 6,
      initialStock: 24,
      barcodes: ['7501059299016', '7501059299023'],
      priceTiers: [
        { tier: 'MENUDEO', label: 'Menudeo', minQty: 1, unitPrice: 85 },
        { tier: 'MEDIO_MAYOREO', label: 'Medio Mayoreo', minQty: 6, unitPrice: 80 },
        { tier: 'MAYOREO', label: 'Mayoreo', minQty: 12, unitPrice: 74 },
      ],
      pin: '984312',
    });
    expect(createRes.ok).toBeTrue();
    expect(createRes.product?.unitCost).toBe(60);
    expect(createRes.product?.stock).toBe(24);

    // Se puede buscar por cualquiera de sus códigos de barras
    expect(service.findProductByBarcode('7501059299016')?.sku).toBe('ABA-CAF-200');
    expect(service.findProductByBarcode('7501059299023')?.sku).toBe('ABA-CAF-200');

    // 3. Vender 6 piezas (aplica precio escalonado MEDIO_MAYOREO = $80)
    const tierResolved = service.resolveProductUnitPriceForQty(createRes.product!, 6);
    expect(tierResolved.activeTier).toBe('MEDIO_MAYOREO');
    expect(tierResolved.unitPrice).toBe(80);

    const saleRes = await service.processSaleWithDiscounts({
      items: [
        {
          sku: 'ABA-CAF-200',
          barcode: '7501059299028',
          name: 'Café Soluble Olla 200g',
          emoji: '[P]',
          saleUnit: 'Pieza',
          isBulk: false,
          qty: 6,
          unitPrice: tierResolved.unitPrice,
          selectedTier: tierResolved.activeTier,
          subtotal: 6 * tierResolved.unitPrice,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 500,
    });
    expect(saleRes.ok).toBeTrue();
    expect(saleRes.totalCharged).toBe(480);

    // 4. Verificar entradas en el Kardex (AJUSTE_INICIAL + VENTA_EFECTIVO) y cadena SHA-256
    const prodMovements = service
      .kardex()
      .filter((e) => (typeof e.producto === 'string' ? e.producto : e.producto.sku) === 'ABA-CAF-200');
    expect(prodMovements.length).toBe(2);
    expect(prodMovements.some((e) => e.type === 'AJUSTE_INICIAL' && e.cantidad === 24 && e.saldoResultante === 24)).toBeTrue();
    expect(prodMovements.some((e) => e.type === 'VENTA_EFECTIVO' && e.cantidad === -6 && e.saldoResultante === 18)).toBeTrue();
    expect(service.verifyKardexIntegrity().valid).toBeTrue();

    await service.flushSave();

    // 5. Simulamos recargar la aplicación desde IndexedDB / storageAdapter
    const reloadedService = new MockInventoryService();
    reloadedService.storageAdapter = service.storageAdapter;
    const restoreRes = await reloadedService.restorePersistedState();
    expect(restoreRes.success).toBeTrue();

    const reloadedProd = reloadedService.products().find((p) => p.sku === 'ABA-CAF-200');
    expect(reloadedProd).toBeTruthy();
    expect(reloadedProd!.stock).toBe(18);
    expect(reloadedProd!.barcodes).toEqual(['7501059299016', '7501059299023']);
    expect(
      reloadedService
        .kardex()
        .filter((e) => (typeof e.producto === 'string' ? e.producto : e.producto.sku) === 'ABA-CAF-200').length
    ).toBe(2);
    expect(reloadedService.verifyKardexIntegrity().valid).toBeTrue();
  });

  it('24. Bloque F1: Rechaza códigos de barras duplicados entre productos y aplica baja lógica (no borra si tiene movimientos en Kardex)', async () => {
    await service.setupInitialPin('984312');
    // 1. Intentar dar de alta un producto con el código de barras de Leche Lala ('7501020515350')
    const dupRes = await service.createCatalogProduct({
      name: 'Clon Leche',
      sku: 'LAC-CLON-01',
      category: 'Lácteos',
      location: 'Refrigerador 1',
      saleUnit: 'Pieza',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 12,
      unitCost: 20,
      salePrice: 25,
      ivaRate: 0,
      iepsRate: 0,
      rop: 5,
      initialStock: 0,
      barcodes: ['7501020515350'],
    });
    expect(dupRes.ok).toBeFalse();
    expect(dupRes.message).toContain('duplicado');

    // 2. Intentar borrar físicamente un producto con movimientos en el Kardex ('LAC-LAL-1L') -> bloqueado
    const physicalDelWithMovements = await service.deletePhysicalProduct('LAC-LAL-1L', '984312');
    expect(physicalDelWithMovements.ok).toBeFalse();
    expect(physicalDelWithMovements.message).toContain('movimientos');

    // 3. deactivateOrDeleteCatalogProduct sobre producto con movimientos aplica baja lógica (isActive = false)
    const logicalDeactivate = await service.deactivateOrDeleteCatalogProduct('LAC-LAL-1L', '984312');
    expect(logicalDeactivate.ok).toBeTrue();
    expect(logicalDeactivate.action).toBe('DEACTIVATED');
    const lalaAfter = service.products().find((p) => p.sku === 'LAC-LAL-1L')!;
    expect(lalaAfter.isActive).toBeFalse();
    // Un producto dado de baja lógica ya no aparece en el buscador de escaneo del POS
    expect(service.findProductByBarcode('7501020515350')).toBeUndefined();

    // 4. Reactivar producto con PIN
    const reactivateRes = await service.reactivateCatalogProduct('LAC-LAL-1L', '984312');
    expect(reactivateRes.ok).toBeTrue();
    expect(service.findProductByBarcode('7501020515350')?.sku).toBe('LAC-LAL-1L');
  });

  it('25. Bloque F1: Descuentos por línea y por ticket en centavos con tope configurable y PIN al pasar el tope', async () => {
    await service.setupInitialPin('984312');
    // Tope por defecto = 10%
    expect(service.maxDiscountPctWithoutPin()).toBe(10);
    const prod = service.products().find((p) => p.sku === 'LAC-LAL-1L')!; // $26.50

    // 1. Descuento de 5% por línea (dentro del tope de 10%) -> NO pide PIN
    const saleWithinCap = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 2,
          unitPrice: 26.5,
          discountPct: 5,
          subtotal: 53,
        },
      ],
      ticketDiscountPct: 0,
      paymentMethod: 'EFECTIVO',
      receivedAmount: 100,
    });
    expect(saleWithinCap.ok).toBeTrue();
    expect(saleWithinCap.totalCharged).toBe(50.35);

    // 2. Descuento de 15% por ticket (supera tope de 10%) sin PIN -> bloqueado con requiresPin = true
    const saleOverCapNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 2,
          unitPrice: 26.5,
          discountPct: 0,
          subtotal: 53,
        },
      ],
      ticketDiscountPct: 15,
      paymentMethod: 'EFECTIVO',
      receivedAmount: 100,
    });
    expect(saleOverCapNoPin.ok).toBeFalse();
    expect(saleOverCapNoPin.requiresPin).toBeTrue();

    // 3. Mismo descuento de 15% con PIN válido de encargado/admin -> se procesa y registra el descuento en la referencia del Kardex
    const saleOverCapWithPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 2,
          unitPrice: 26.5,
          discountPct: 0,
          subtotal: 53,
        },
      ],
      ticketDiscountPct: 15,
      paymentMethod: 'EFECTIVO',
      receivedAmount: 100,
      pin: '984312', // Administrador / Encargado
    });
    expect(saleOverCapWithPin.ok).toBeTrue();
    expect(saleOverCapWithPin.totalCharged).toBe(45.05);
    expect(service.kardex()[0].referencia).toContain('DESC-$7.95');

    // 4. Prioridad Mayoreo + descuento por ticket:
    // Leche Lala: Menudeo $26.50, Mayoreo (12 pzas) = $23.80 (~10.19% menos que menudeo).
    // Si además se aplica 4% de descuento por ticket, se acumulan y el total descontado sobre el precio menudeo (~13.78%) supera el tope de 10% -> exige PIN.
    const wholesalePlusTicketNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 12,
          unitPrice: 23.8,
          selectedTier: 'MAYOREO',
          discountPct: 0,
          subtotal: 285.6,
        },
      ],
      ticketDiscountPct: 4,
      paymentMethod: 'EFECTIVO',
      receivedAmount: 300,
    });
    expect(wholesalePlusTicketNoPin.ok).toBeFalse();
    expect(wholesalePlusTicketNoPin.requiresPin).toBeTrue();
    expect(wholesalePlusTicketNoPin.evaluation?.effectiveDiscountVsRetailPct).toBeGreaterThan(10);
  });

  it('26. Bloque F1: Tolerancia de merma natural en granel (% por producto) clasifica diferencias dentro de tolerancia como "Merma natural" y no como faltante', () => {
    // FRI-NEG-50K es granel con systemQty = 16.5 kg y naturalShrinkTolerancePct = 3% (tolerancia = 0.495 kg)
    // Contamos 16.2 kg -> diferencia -0.3 kg (1.82% <= 3%) -> debe marcarse como "Merma natural"
    service.submitBlindAuditResults([{ sku: 'FRI-NEG-50K', countedQty: 16.2 }]);
    const lineWithin = service.auditLines().find((l) => l.sku === 'FRI-NEG-50K')!;
    expect(lineWithin.varianceClassification).toBe('MERMA_NATURAL');
    expect(lineWithin.classificationLabel).toBe('Merma natural');
    expect(lineWithin.isWithinNaturalTolerance).toBeTrue();

    // Al cuadrar el ajuste en el Kardex, la referencia indica [Merma natural]
    service.applySquareAdjustment('FRI-NEG-50K', 'MERMA_OPERATIVA');
    expect(service.kardex()[0].referencia).toContain('Merma natural');

    // Si la diferencia supera el 3% (ej. teórico 16.2 kg, contado 14.8 kg -> -1.4 kg > 3%), se marca como "Faltante"
    service.submitBlindAuditResults([{ sku: 'FRI-NEG-50K', countedQty: 14.8 }]);
    const lineOver = service.auditLines().find((l) => l.sku === 'FRI-NEG-50K')!;
    expect(lineOver.varianceClassification).toBe('FALTANTE');
    expect(lineOver.classificationLabel).toBe('Faltante');
    expect(lineOver.isWithinNaturalTolerance).toBeFalse();
  });

  it('27. Bloque F1: Móvil envía PRODUCT_CREATE_REQUEST y la PC lo valida y crea de forma idempotente (queda PENDIENTE_APROBACION)', async () => {
    await service.setupInitialPin('984312');
    await service.restorePersistedState();
    const countBefore = service.products().length;

    // 1. Primer envío de PRODUCT_CREATE_REQUEST por LAN
    service.handleIncomingLanMessage({
      type: 'PRODUCT_CREATE_REQUEST',
      requestId: 'REQ-7509998887776',
      barcode: '7509998887776',
      name: 'Galletas Marías Móvil 170g',
      salePrice: 20,
      cost: 14.5,
      saleUnit: 'Pieza',
    });

    expect(service.products().length).toBe(countBefore + 1);
    // En el POS ordinario no aparece al escanear por estar pendiente de aprobación
    expect(service.findProductByBarcode('7509998887776')).toBeUndefined();

    // Con includePending = true sí se localiza para revisión administrativa
    const pending = service.findProductByBarcode('7509998887776', false, true);
    expect(pending).toBeTruthy();
    expect(pending!.approvalStatus).toBe('PENDIENTE_APROBACION');
    expect(pending!.name).toBe('Galletas Marías Móvil 170g');
    expect(pending!.salePrice).toBe(20);
    expect(pending!.unitCost).toBe(14.5);

    // 2. Reenvío duplicado del mismo PRODUCT_CREATE_REQUEST -> idempotente, no duplica
    const duplicateRes = service.handleProductCreateRequestFromLan({
      type: 'PRODUCT_CREATE_REQUEST',
      requestId: 'REQ-7509998887776',
      barcode: '7509998887776',
      name: 'Galletas Marías Móvil 170g',
      salePrice: 20,
      cost: 14.5,
      saleUnit: 'Pieza',
    });
    expect(duplicateRes.ok).toBeTrue();
    expect(duplicateRes.idempotentDuplicate).toBeTrue();
    expect(service.products().length).toBe(countBefore + 1);

    // 3. Aprobación con PIN desde la PC permitiendo corregir precio y costo
    const approveRes = await service.approvePendingProduct(pending!.sku, {
      pin: '984312',
      newPrice: 22.0,
      newCost: 15.0,
    });
    expect(approveRes.ok).toBeTrue();

    // Ahora sí está aprobado y aparece en el POS
    const approved = service.findProductByBarcode('7509998887776');
    expect(approved).toBeTruthy();
    expect(approved!.approvalStatus).toBe('APROBADO');
    expect(approved!.salePrice).toBe(22.0);
    expect(approved!.unitCost).toBe(15.0);
    expect(service.kardex()[0].referencia).toContain('Aprobación móvil');
  });

  it('28. Seguimiento F1: Persistencia migra productos v1 a v2 y maneja fallback de almacenamiento', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    // Simular un estado v1 en LEGACY_STATE_STORAGE_KEY ('binnitech_pos_state_v1')
    const v1State = {
      schemaVersion: 1,
      timestamp: '2026-10-22T00:00:00.000Z',
      activeUser: 'Don Lupe (Encargado)',
      products: [
        {
          sku: 'LEG-PROD-01',
          name: 'Producto Legado V1',
          stock: 10,
          salePrice: 30,
          cost: 20,
          barcode: '7501000000018',
        },
      ],
      creditCustomers: [],
      kardex: [],
      shrinkRecords: [],
      auditLines: [],
    };
    await memoryAdapter.save(LEGACY_STATE_STORAGE_KEY, v1State);

    const restoreRes = await service.restorePersistedState();
    expect(restoreRes.success).toBeTrue();

    const migrated = service.products().find((p) => p.sku === 'LEG-PROD-01');
    expect(migrated).toBeDefined();
    expect(migrated!.approvalStatus).toBe('APROBADO');
    expect(migrated!.barcodes).toContain('7501000000018');
    expect(migrated!.priceTiers).toBeDefined();
    expect(migrated!.priceTiers?.length).toBeGreaterThan(0);
  });

  it('29. Seguimiento F1: Códigos de barras: equivalencia UPC-A/EAN-13 en escáner y rechazo de duplicados cruzados', async () => {
    await service.setupInitialPin('984312');
    // Leche Lala tiene EAN-13 '7501020515350'
    // Añadimos un producto con UPC-A de 12 dígitos '012345678905'
    const createRes = await service.createCatalogProduct({
      name: 'Cereal Maíz 500g',
      category: 'Abarrotes',
      saleUnit: 'Pieza',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 1,
      cost: 25,
      salePrice: 35,
      barcode: '012345678905', // UPC-A
      initialStock: 10,
      pin: '984312',
    });
    expect(createRes.ok).toBeTrue();

    // Escanear como EAN-13 canónico '0012345678905' encuentra el producto
    const foundByEan = service.findProductByBarcode('0012345678905');
    expect(foundByEan).toBeTruthy();
    expect(foundByEan!.name).toBe('Cereal Maíz 500g');

    // Intentar registrar otro producto con EAN-13 equivalente debe fallar por duplicado
    const dupRes = await service.createCatalogProduct({
      name: 'Cereal Clon',
      category: 'Abarrotes',
      saleUnit: 'Pieza',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 1,
      cost: 20,
      salePrice: 30,
      barcode: '0012345678905',
      pin: '984312',
    });
    expect(dupRes.ok).toBeFalse();
    expect(dupRes.message).toMatch(/duplicado|equivalencia/i);
  });

  it('30. Seguimiento F1: Merma natural genera movimiento MERMA_NATURAL en Kardex con valor en centavos y se suma al reporte', async () => {
    await service.setupInitialPin('984312');
    // FRI-NEG-50K es granel con existencia 16.5 kg, costo $18.00/kg
    service.submitBlindAuditResults([{ sku: 'FRI-NEG-50K', countedQty: 16.2 }]); // Diferencia -0.3 kg dentro de tolerancia (3%)

    const squareRes = service.applySquareAdjustment('FRI-NEG-50K', 'MERMA_OPERATIVA', 'Administrador');
    expect(squareRes.ok).toBeTrue();

    const latestKardex = service.kardex()[0];
    expect(latestKardex.type).toBe('MERMA_NATURAL');
    // 0.3 kg * $28.00 = $8.40 (840 centavos)
    expect(latestKardex.amount).toBe(8.4);
    expect(latestKardex.referencia).toContain('Merma natural');

    // Se suma a shrinkRecords con razón 'Merma natural'
    const latestShrink = service.shrinkRecords()[0];
    expect(latestShrink.sku).toBe('FRI-NEG-50K');
    expect(latestShrink.reason).toBe('Merma natural');
    expect(latestShrink.qty).toBe(0.3);

    // Se actualizó cumulativeNaturalShrinkQty en el producto
    const prod = service.products().find((p) => p.sku === 'FRI-NEG-50K');
    expect(prod?.cumulativeNaturalShrinkQty).toBe(0.3);
  });

  it('31. Seguimiento F1: Costo en granel: guarda costo y factor en saveReception y calcula venta en tandas', () => {
    // Registramos recepción de bulto de 50 kg a $847.00
    const receptionLines: ReceptionLine[] = [
      {
        sku: 'FRI-NEG-50K',
        name: 'Frijol Negro 50kg',
        emoji: '🫘',
        qtyPurchase: 1,
        purchaseUnit: 'Bulto',
        unitsPerPurchase: 50,
        saleUnit: 'Kg',
        lineTotal: 847.0,
        historicCost: 16.94,
        newCost: 16.94,
        packageCost: 847.0,
        packageFactor: 50,
        salePrice: 24.0,
        targetMargin: 29,
        resolved: true,
      },
    ];

    service.saveReception(receptionLines, 'REC-TEST-50K');
    const updatedProd = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    expect(updatedProd.packageCost).toBe(847.0);
    expect(updatedProd.packageFactor).toBe(50);
    expect(updatedProd.unitsPerPurchase).toBe(50);
  });

  it('32. Seguimiento F1: Descuentos bloquean venta por debajo del costo sin PIN y registran escalón [MAYOREO] en Kardex', async () => {
    await service.setupInitialPin('984312');
    const prod = service.products().find((p) => p.sku === 'LAC-LAL-1L')!; // Costo $18.50, Menudeo $26.50

    // 1. Venta por debajo del costo ($15.00 < $18.50) intentada sin PIN -> bloqueada
    const belowCostNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: prod.salePrice,
          discountPct: 50, // 50% de $26.50 = $13.25 (< costo $18.50)
          subtotal: 13.25,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 20,
    });
    expect(belowCostNoPin.ok).toBeFalse();
    expect(belowCostNoPin.requiresPin).toBeTrue();
    expect(belowCostNoPin.message).toMatch(/costo/i);

    // 2. Con PIN correcto -> venta autorizada
    const belowCostWithPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: prod.salePrice,
          discountPct: 50,
          subtotal: 13.25,
        },
      ],
      pin: '984312',
      paymentMethod: 'EFECTIVO',
      receivedAmount: 20,
    });
    expect(belowCostWithPin.ok).toBeTrue();

    // 3. Venta con escalón Mayoreo registra [MAYOREO] en la referencia del Kardex
    const wholesaleSale = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 12,
          unitPrice: 23.8,
          selectedTier: 'MAYOREO',
          activeTier: 'MAYOREO',
          discountPct: 0,
          subtotal: 285.6,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 300,
    });
    expect(wholesaleSale.ok).toBeTrue();
    const latestKardex = service.kardex()[0];
    expect(latestKardex.referencia).toContain('[MAYOREO]');
  });

  it('33. Seguimiento F1: Migración: no borra binnitech_pos_state_v1 si falla la escritura de v2, y la elimina al verificar con éxito', async () => {
    const validV1State = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      activeUser: 'Don Lupe (Encargado)',
      products: service.products(),
      creditCustomers: service.creditCustomers(),
      cashShift: service.cashShift(),
      cashRegister: service.cashRegister(),
      kardex: service.kardex(),
      shrinkRecords: service.shrinkRecords(),
      auditLines: service.auditLines(),
    };

    class FailingV2StorageAdapter extends MemoryStateStorageAdapter {
      override async save(key: string, value: any): Promise<void> {
        if (key === STATE_STORAGE_KEY) {
          throw new Error('Fallo simulado de disco al escribir v2');
        }
        await super.save(key, value);
      }
    }

    const failingAdapter = new FailingV2StorageAdapter();
    await failingAdapter.save(LEGACY_STATE_STORAGE_KEY, validV1State);

    service.storageAdapter = failingAdapter;
    const res = await service.restorePersistedState();
    expect(res.success).toBeTrue();

    const v1LoadedAfterFailure = await failingAdapter.load(LEGACY_STATE_STORAGE_KEY);
    expect(v1LoadedAfterFailure).toBeTruthy();
    expect(v1LoadedAfterFailure.schemaVersion).toBe(1);

    const healthyAdapter = new MemoryStateStorageAdapter();
    await healthyAdapter.save(LEGACY_STATE_STORAGE_KEY, validV1State);
    service.storageAdapter = healthyAdapter;

    const healthyRes = await service.restorePersistedState();
    expect(healthyRes.success).toBeTrue();

    const v2Loaded = await healthyAdapter.load(STATE_STORAGE_KEY);
    expect(v2Loaded).toBeTruthy();
    expect(v2Loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const v1AfterSuccess = await healthyAdapter.load(LEGACY_STATE_STORAGE_KEY);
    expect(v1AfterSuccess).toBeNull();
  });

  it('34. Seguimiento F1: Los productos PENDIENTE_APROBACION no pueden recibirse, venderse, auditarse, entrar a ABC, reportes ni resolverse al escanear', async () => {
    service.handleProductCreateRequestFromLan({
      type: 'PRODUCT_CREATE_REQUEST',
      requestId: 'REQ-PEND-TEST',
      barcode: '7501059299092',
      name: 'Galleta de Avena Móvil',
      salePrice: 15.0,
      cost: 10.0,
      saleUnit: 'Pieza',
    });

    const pendingProd = service.products().find((p) => p.barcode === '7501059299092')!;
    expect(pendingProd).toBeDefined();
    expect(pendingProd.approvalStatus).toBe('PENDIENTE_APROBACION');

    // 1. No pueden recibirse en inventario
    expect(() => {
      service.saveReception(
        [
          {
            sku: pendingProd.sku,
            name: pendingProd.name,
            emoji: '📦',
            qtyPurchase: 5,
            purchaseUnit: 'Caja',
            unitsPerPurchase: 10,
            saleUnit: 'Pieza',
            lineTotal: 500,
            historicCost: 10,
            newCost: 10,
            salePrice: 15,
            targetMargin: 20,
            resolved: true,
          },
        ],
        'REC-BLOCKED'
      );
    }).toThrowError(/pendiente de aprobación/i);

    // 2. No pueden venderse en efectivo ni a crédito
    const cashSaleRes = service.processCashSale(
      [
        {
          sku: pendingProd.sku,
          barcode: pendingProd.barcode,
          name: pendingProd.name,
          emoji: '📦',
          saleUnit: 'Pieza',
          isBulk: false,
          qty: 1,
          unitPrice: 15,
          subtotal: 15,
        },
      ],
      50
    );
    expect(cashSaleRes.ok).toBeFalse();
    expect(cashSaleRes.message).toMatch(/pendiente de aprobación/i);

    const creditSaleRes = service.processCreditSale(
      [
        {
          sku: pendingProd.sku,
          barcode: pendingProd.barcode,
          name: pendingProd.name,
          emoji: '📦',
          saleUnit: 'Pieza',
          isBulk: false,
          qty: 1,
          unitPrice: 15,
          subtotal: 15,
        },
      ],
      'CLI-DON-JUAN'
    );
    expect(creditSaleRes.ok).toBeFalse();
    expect(creditSaleRes.message).toMatch(/pendiente de aprobación/i);

    // 3. No pueden contarse en auditoría
    service.submitBlindAuditResults([
      { sku: pendingProd.sku, countedQty: 10 },
      { sku: 'LAC-LAL-1L', countedQty: 20 },
    ]);
    expect(service.auditLines().some((l) => l.sku === pendingProd.sku)).toBeFalse();

    const squareRes = service.applySquareAdjustment(pendingProd.sku, 'MERMA_OPERATIVA');
    expect(squareRes.ok).toBeFalse();

    // 4. No pueden entrar a la clasificación ABC
    expect(service.abcSuggestions().some((r) => r.sku === pendingProd.sku)).toBeFalse();
    const guidedRes = service.previewGuided([{ sku: pendingProd.sku, frequency: 'VARIAS_AL_DIA', losesCustomer: true }]);
    expect(guidedRes.some((r) => r.sku === pendingProd.sku)).toBeFalse();

    // 5. No pueden entrar a reportes
    expect(service.fefoExchangeProducts().some((p) => p.sku === pendingProd.sku)).toBeFalse();
    expect(service.criticalRopProducts().some((p) => p.sku === pendingProd.sku)).toBeFalse();
    expect(service.quickAccessSuggestions().some((p) => p.sku === pendingProd.sku)).toBeFalse();

    // 6. No pueden resolverse al escanear en celular ni en POS
    expect(service.findProductByBarcode('7501059299092')).toBeUndefined();
    expect(service.resolveScannedBarcode('7501059299092')).toBeNull();
  });

  it('35. Seguimiento F1: Merma natural: auditoría con diferencia dentro de tolerancia baja stock una sola vez y Kardex mantiene continuidad', () => {
    const frijol = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    const previousStock = frijol.stock; // 16.5 kg
    const countedQty = Math.round((previousStock - 1.0) * 1000) / 1000; // 15.5 kg (-1.0 kg dentro de tolerancia de 3% sobre base mensual)

    service.auditLines.set([
      {
        sku: frijol.sku,
        name: frijol.name,
        emoji: '🫘',
        location: frijol.location || 'Pasillo Granel',
        saleUnit: 'Kg',
        systemQty: previousStock,
        countedQty,
        unitCost: frijol.unitCost ?? 16.94,
        status: 'pendiente',
        naturalShrinkTolerancePct: 3,
      },
    ]);

    const initialKardexCount = service.kardex().length;
    const res = service.applySquareAdjustment(frijol.sku, 'MERMA_OPERATIVA', 'Administrador (PIN)');
    expect(res.ok).toBeTrue();

    const updatedFrijol = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    expect(updatedFrijol.stock).toBe(countedQty);

    expect(service.kardex().length).toBe(initialKardexCount + 1);
    const latestKardex = service.kardex()[0];
    expect(latestKardex.type).toBe('MERMA_NATURAL');
    expect(latestKardex.saldoAnterior).toBe(previousStock);
    expect(latestKardex.cantidad).toBe(-1.0);
    expect(latestKardex.saldoResultante).toBe(countedQty);

    const continuity = verifyProductContinuity(service.products(), service.kardex(), 'newest-first');
    expect(continuity.valid).toBeTrue();
    expect(continuity.affectedSkus.length).toBe(0);
  });

  it('36. Seguimiento F1: Persistencia del residuo de redondeo en granel tras recarga/reinicio a mitad de un bulto de 50 kg', async () => {
    service.saveReception(
      [
        {
          sku: 'FRI-NEG-50K',
          name: 'Frijol Negro 50kg',
          emoji: '🫘',
          qtyPurchase: 1,
          purchaseUnit: 'Bulto',
          unitsPerPurchase: 50,
          saleUnit: 'Kg',
          lineTotal: 847.0,
          historicCost: 16.94,
          newCost: 16.94,
          packageCost: 847.0,
          packageFactor: 50,
          salePrice: 24.0,
          targetMargin: 29,
          resolved: true,
        },
      ],
      'REC-50K-TEST'
    );

    let firstHalfQty = 0;
    while (firstHalfQty < 25.0) {
      const tanda = Math.min(0.35, Math.round((25.0 - firstHalfQty) * 1000) / 1000);
      const res = service.processCashSale(
        [
          {
            sku: 'FRI-NEG-50K',
            barcode: '2000001000014',
            name: 'Frijol Negro',
            emoji: '🫘',
            saleUnit: 'Kg',
            isBulk: true,
            qty: tanda,
            unitPrice: 24.0,
            subtotal: tanda * 24.0,
          },
        ],
        50
      );
      expect(res.ok).toBeTrue();
      firstHalfQty = Math.round((firstHalfQty + tanda) * 1000) / 1000;
    }

    const prodAtHalf = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    expect(prodAtHalf.bulkSoldQtyCurrentPackage).toBe(25.0);
    expect(typeof prodAtHalf.bulkCostResidualCents).toBe('number');
    const residualAtHalf = prodAtHalf.bulkCostResidualCents;

    await service.flushSave();
    await service.restorePersistedState();

    const prodAfterReload = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    expect(prodAfterReload.bulkSoldQtyCurrentPackage).toBe(25.0);
    expect(prodAfterReload.bulkCostResidualCents).toBe(residualAtHalf);

    let secondHalfQty = 0;
    while (secondHalfQty < 25.0) {
      const tanda = Math.min(0.35, Math.round((25.0 - secondHalfQty) * 1000) / 1000);
      const res = service.processCashSale(
        [
          {
            sku: 'FRI-NEG-50K',
            barcode: '2000001000014',
            name: 'Frijol Negro',
            emoji: '🫘',
            saleUnit: 'Kg',
            isBulk: true,
            qty: tanda,
            unitPrice: 24.0,
            subtotal: tanda * 24.0,
          },
        ],
        50
      );
      expect(res.ok).toBeTrue();
      secondHalfQty = Math.round((secondHalfQty + tanda) * 1000) / 1000;
    }

    const prodFinished = service.products().find((p) => p.sku === 'FRI-NEG-50K')!;
    expect(prodFinished.bulkSoldQtyCurrentPackage).toBe(50.0);
    expect(prodFinished.cumulativeBulkCostCents).toBe(84700);
  });

  it('37. Seguimiento F1: Bloqueo de venta bajo costo aplica a cada escalón de mayoreo (Menudeo, Medio Mayoreo, Mayoreo) y pide PIN', async () => {
    await service.setupInitialPin('984312');
    const prod = service.products().find((p) => p.sku === 'LAC-LAL-1L')!;

    // 1. Escalón MENUDEO vendido por debajo del costo ($15.00 < $18.50)
    const menudeoNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: 15.0,
          activeTier: 'MENUDEO',
          selectedTier: 'MENUDEO',
          subtotal: 15.0,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 20,
    });
    expect(menudeoNoPin.ok).toBeFalse();
    expect(menudeoNoPin.requiresPin).toBeTrue();
    expect(menudeoNoPin.message).toMatch(/costo/i);

    const menudeoWithPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 1,
          unitPrice: 15.0,
          activeTier: 'MENUDEO',
          selectedTier: 'MENUDEO',
          subtotal: 15.0,
        },
      ],
      pin: '984312',
      paymentMethod: 'EFECTIVO',
      receivedAmount: 20,
    });
    expect(menudeoWithPin.ok).toBeTrue();

    // 2. Escalón MEDIO_MAYOREO vendido por debajo del costo ($16.00 < $18.50)
    const medioNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 6,
          unitPrice: 16.0,
          activeTier: 'MEDIO_MAYOREO',
          selectedTier: 'MEDIO_MAYOREO',
          subtotal: 96.0,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 100,
    });
    expect(medioNoPin.ok).toBeFalse();
    expect(medioNoPin.requiresPin).toBeTrue();
    expect(medioNoPin.message).toMatch(/costo/i);

    const medioWithPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 6,
          unitPrice: 16.0,
          activeTier: 'MEDIO_MAYOREO',
          selectedTier: 'MEDIO_MAYOREO',
          subtotal: 96.0,
        },
      ],
      pin: '984312',
      paymentMethod: 'EFECTIVO',
      receivedAmount: 100,
    });
    expect(medioWithPin.ok).toBeTrue();

    // 3. Escalón MAYOREO vendido por debajo del costo ($17.00 < $18.50)
    const mayoreoNoPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 12,
          unitPrice: 17.0,
          activeTier: 'MAYOREO',
          selectedTier: 'MAYOREO',
          subtotal: 204.0,
        },
      ],
      paymentMethod: 'EFECTIVO',
      receivedAmount: 250,
    });
    expect(mayoreoNoPin.ok).toBeFalse();
    expect(mayoreoNoPin.requiresPin).toBeTrue();
    expect(mayoreoNoPin.message).toMatch(/costo/i);

    const mayoreoWithPin = await service.processSaleWithDiscounts({
      items: [
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: false,
          qty: 12,
          unitPrice: 17.0,
          activeTier: 'MAYOREO',
          selectedTier: 'MAYOREO',
          subtotal: 204.0,
        },
      ],
      pin: '984312',
      paymentMethod: 'EFECTIVO',
      receivedAmount: 250,
    });
    expect(mayoreoWithPin.ok).toBeTrue();
  });

  it('38. Seguimiento F1: Persistencia: con ambas claves (v1 y v2) presentes, la app carga v2 y no migra v1 sobre v2', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service['storageAdapter'] = memoryAdapter;

    // Crear un estado v1 con un producto distintivo
    const v1State = {
      schemaVersion: 1,
      products: [
        {
          sku: 'PROD-V1-ONLY',
          barcode: '750100000001',
          name: 'Producto Antiguo v1',
          stock: 10,
          historicCost: 15.0,
          salePrice: 20.0,
          saleUnit: 'Pieza',
        },
      ],
      kardex: [],
      shrinkRecords: [],
      auditLines: [],
      creditCustomers: [],
      cashShift: { openingCash: 500, cashSalesTotal: 0, creditPaymentsReceived: 0 },
      cashRegister: { currentBalance: 500, cashSalesTotal: 0, cashPayoutsTotal: 0 },
    };

    // Crear un estado v2 con un producto moderno distintivo
    const v2State = {
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
      activeUser: 'Don Lupe (Encargado)',
      products: [
        {
          sku: 'PROD-V2-CURRENT',
          barcode: '750200000002',
          name: 'Producto Vigente v2',
          stock: 45,
          historicCost: 25.0,
          salePrice: 35.0,
          saleUnit: 'Pieza',
          barcodes: ['750200000002'],
          isActive: true,
          approvalStatus: 'APROBADO',
        },
      ],
      kardex: [],
      shrinkRecords: [],
      auditLines: [],
      creditCustomers: [],
      cashShift: { openingCash: 1000, cashSalesTotal: 0, creditPaymentsReceived: 0 },
      cashRegister: { currentBalance: 1000, cashSalesTotal: 0, cashPayoutsTotal: 0 },
    };

    // Guardar ambas claves simultáneamente en el almacenamiento
    await memoryAdapter.save(LEGACY_STATE_STORAGE_KEY, v1State);
    await memoryAdapter.save(STATE_STORAGE_KEY, v2State);

    // Restaurar estado
    const restoreResult = await service.restorePersistedState();
    expect(restoreResult.success).toBeTrue();

    // Comprobar que cargó v2
    const currentProds = service.products();
    expect(currentProds.some((p) => p.sku === 'PROD-V2-CURRENT')).toBeTrue();
    expect(currentProds.some((p) => p.sku === 'PROD-V1-ONLY')).toBeFalse();
    expect(service.cashShift().openingCash).toBe(1000);

    // Comprobar que en el storage adapter, v2 sigue intacto y v1 no migró sobre v2
    const loadedV2 = (await memoryAdapter.load(STATE_STORAGE_KEY)) as any;
    expect(loadedV2.products.some((p: any) => p.sku === 'PROD-V2-CURRENT')).toBeTrue();
    expect(loadedV2.products.some((p: any) => p.sku === 'PROD-V1-ONLY')).toBeFalse();

    // La clave v1 permanece guardada e intacta
    const loadedV1 = (await memoryAdapter.load(LEGACY_STATE_STORAGE_KEY)) as any;
    expect(loadedV1).toBeTruthy();
    expect(loadedV1.products[0].sku).toBe('PROD-V1-ONLY');
  });

  it('39. Seguimiento F1: POS: escaneo de producto PENDIENTE_APROBACION devuelve "Producto pendiente de aprobación: avisa al encargado" y no "no encontrado"', () => {
    // 1. Registrar producto en estado PENDIENTE_APROBACION con código de barras específico
    const pendingBarcode = '7509988112233';
    service.products.update((list) => [
      ...list,
      migrateProductDefaults({
        sku: 'PEND-POS-01',
        barcode: pendingBarcode,
        barcodes: [pendingBarcode],
        name: 'Galletas Pendientes Aprobación',
        category: 'Abarrotes',
        emoji: '🍪',
        purchaseUnit: 'Pieza',
        unitsPerPurchase: 1,
        saleUnit: 'Pieza',
        historicCost: 15.0,
        unitCost: 15.0,
        salePrice: 22.0,
        stock: 10,
        minStock: 2,
        isBulk: false,
        isActive: true,
        approvalStatus: 'PENDIENTE_APROBACION',
      }),
    ]);

    // 2. Escanear el código del producto pendiente en el POS
    const scanPending = service.scanBarcodeForPos(pendingBarcode);
    expect(scanPending.ok).toBeFalse();
    expect(scanPending.isPendingApproval).toBeTrue();
    expect(scanPending.isNotFound).toBeFalse();
    expect(scanPending.message).toBe('Producto pendiente de aprobación: avisa al encargado');
    expect(scanPending.message).not.toMatch(/no encontrado/i);

    // 3. Contrastar con un código genuinamente inexistente ("no encontrado")
    const scanUnknown = service.scanBarcodeForPos('0000000000000');
    expect(scanUnknown.ok).toBeFalse();
    expect(scanUnknown.isPendingApproval).toBeFalse();
    expect(scanUnknown.isNotFound).toBeTrue();
    expect(scanUnknown.message).toMatch(/no encontrado/i);

    // 4. Contrastar con un producto aprobado y activo ("encontrado")
    const scanApproved = service.scanBarcodeForPos('7501020515350'); // Leche Lala
    expect(scanApproved.ok).toBeTrue();
    expect(scanApproved.isPendingApproval).toBeFalse();
    expect(scanApproved.isNotFound).toBeFalse();
    expect(scanApproved.product?.sku).toBe('LAC-LAL-1L');
  });

  it('40. Seguimiento F1: POS integración (PosViewComponent): escaneo de producto PENDIENTE_APROBACION muestra "Producto pendiente de aprobación: avisa al encargado" y no "no encontrado"', () => {
    const pendingBarcode = '7509988112233';
    service.products.update((list) => [
      ...list,
      migrateProductDefaults({
        sku: 'PEND-POS-01',
        barcode: pendingBarcode,
        barcodes: [pendingBarcode],
        name: 'Galletas Pendientes Aprobación',
        category: 'Abarrotes',
        emoji: '🍪',
        purchaseUnit: 'Pieza',
        unitsPerPurchase: 1,
        saleUnit: 'Pieza',
        historicCost: 15.0,
        unitCost: 15.0,
        salePrice: 22.0,
        stock: 10,
        minStock: 2,
        isBulk: false,
        isActive: true,
        approvalStatus: 'PENDIENTE_APROBACION',
      }),
    ]);

    // Crear componente dentro del contexto de inyección de TestBed
    const comp = TestBed.runInInjectionContext(() => new PosViewComponent());
    comp.ngOnInit();

    // 1. Simular escaneo en input de búsqueda
    comp['searchQuery'].set(pendingBarcode);
    expect(comp['pendingApprovalFound']()).toBeTrue();

    // 2. Ejecutar búsqueda / escaneo (onSearchOrBarcodeSubmit)
    comp.onSearchOrBarcodeSubmit();
    const feedback = comp['saleFeedback']();
    expect(feedback).not.toBeNull();
    expect(feedback?.ok).toBeFalse();
    expect(feedback?.text).toBe('Producto pendiente de aprobación: avisa al encargado');
    expect(feedback?.text).not.toMatch(/no encontrado/i);

    // 3. Simular escaneo desde celular / LAN (onExternalBarcodeEvent)
    comp['onExternalBarcodeEvent']({
      type: 'BARCODE_SCANNED',
      barcode: pendingBarcode,
    });
    expect(comp['syncNotification']()).toBe('Producto pendiente de aprobación: avisa al encargado');

    comp.ngOnDestroy();
  });
  it('41. Bloque F2: Cliente nuevo, fiado en POS, abono amortizado por FIFO y actualización de estatus', async () => {
    // 1. Alta de cliente nuevo
    const createRes = service.createCustomer({
      name: 'Doña Silvia - Tiendita La Esquina',
      alias: 'Doña Silvia',
      phone: '477-555-1234',
      creditLimit: 800.0,
      creditDays: 15,
      notes: 'Vecina de confianza',
    });
    expect(createRes.ok).toBeTrue();
    expect(createRes.customer).toBeDefined();
    const custId = createRes.customer!.id;

    // Verificar estado inicial
    const custInitial = service.getCustomerDetail(custId);
    expect(custInitial).toBeDefined();
    expect(custInitial!.currentBalance).toBe(0);
    expect(custInitial!.status).toBe('AL_CORRIENTE');
    expect(custInitial!.isActive).toBeTrue();

    // 2. Cargar venta a fiado por $300.00
    const saleItems: PosSaleItem[] = [
      {
        sku: 'AB-PAN-01',
        barcode: '75010001',
        name: 'Pan Dulce Artesanal',
        emoji: '🥐',
                unitPrice: 30.0,
        saleUnit: 'Pieza',
        isBulk: false,
        qty: 10,
        subtotal: 300.0,
      },
    ];
    const fiadoRes1 = service.processCreditSale(saleItems, custId);
    expect(fiadoRes1.ok).toBeTrue();

    const custAfterSale1 = service.getCustomerDetail(custId)!;
    expect(custAfterSale1.currentBalance).toBe(300.0);
    expect(custAfterSale1.status).toBe('AL_CORRIENTE'); // 300 / 800 = 37.5% (< 90%)
    expect(custAfterSale1.debts?.length).toBe(1);
    expect(custAfterSale1.debts?.[0].remainingBalance).toBe(300.0);

    // 3. Segunda venta a fiado por $450.00 -> Total saldo: $750.00 (750 / 800 = 93.75% >= 90%) -> LIMITE_ALCANZADO
    const saleItems2: PosSaleItem[] = [
      {
        sku: 'AB-HUE-01',
        barcode: '75010002',
        name: 'Huevo Blanco 1Kg',
        emoji: '🥚',
                unitPrice: 45.0,
        saleUnit: 'Pieza',
        isBulk: false,
        qty: 10,
        subtotal: 450.0,
      },
    ];
    const fiadoRes2 = service.processCreditSale(saleItems2, custId);
    expect(fiadoRes2.ok).toBeTrue();

    const custAfterSale2 = service.getCustomerDetail(custId)!;
    expect(custAfterSale2.currentBalance).toBe(750.0);
    expect(custAfterSale2.status).toBe('LIMITE_ALCANZADO');
    expect(custAfterSale2.debts?.length).toBe(2);

    // 4. Abono deudor en efectivo por $400.00: liquida los $300 de la 1ra deuda y amortiza $100 de la 2da
    const payRes = service.registerCreditPayment(custId, 400.0);
    expect(payRes.ok).toBeTrue();
    expect(payRes.applied).toBe(400.0);

    const custAfterPay = service.getCustomerDetail(custId)!;
    expect(custAfterPay.currentBalance).toBe(350.0); // 750 - 400 = 350
    expect(custAfterPay.status).toBe('AL_CORRIENTE'); // 350 / 800 = 43.75% (< 90%)
    expect(custAfterPay.debts?.[0].remainingBalance).toBe(0); // 1ra partida liquidada
    expect(custAfterPay.debts?.[1].remainingBalance).toBe(350.0); // 2da partida amortizada ($450 - $100 = $350)
    expect(custAfterPay.payments?.length).toBe(1);
    expect(custAfterPay.payments?.[0].amount).toBe(400.0);

    // 5. Verificar Kardex encadenado (ABONO_FIADO)
    const abonoKardex = service.kardex().find((k) => k.type === 'ABONO_FIADO' && (typeof k.producto === 'string' ? k.producto : k.producto.sku) === custId);
    expect(abonoKardex).toBeDefined();
    expect(abonoKardex?.amount).toBe(400.0);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();

    // 6. Verificar persistencia tras flush y restore
    await service.flushSave();
    const reloadedService = new MockInventoryService();
    reloadedService.storageAdapter = service.storageAdapter;
    const restoreRes = await reloadedService.restorePersistedState();
    expect(restoreRes.success).toBeTrue();

    const reloadedCust = reloadedService.getCustomerDetail(custId);
    expect(reloadedCust).toBeDefined();
    expect(reloadedCust!.currentBalance).toBe(350.0);
    expect(reloadedCust!.status).toBe('AL_CORRIENTE');
  });

  it('42. Bloque F2: Edición de límite o plazo de cliente exige PIN (rechaza sin PIN o erróneo, aplica con PIN)', async () => {
    await service.setupInitialPin('984312');

    const createRes = service.createCustomer({
      name: 'Don Rogelio Mecánico',
      creditLimit: 500.0,
      creditDays: 15,
    });
    expect(createRes.ok).toBeTrue();
    const custId = createRes.customer!.id;

    // 1. Modificar sólo notas/nombre sin tocar límite ni plazo -> NO exige PIN
    const updateNameRes = await service.updateCustomerWithPinCheck(custId, {
      name: 'Don Rogelio Taller Istmo',
      creditLimit: 500.0,
      creditDays: 15,
      notes: 'Cambio de nombre comercial',
    });
    expect(updateNameRes.ok).toBeTrue();
    expect(updateNameRes.customer?.name).toBe('Don Rogelio Taller Istmo');

    // 2. Modificar límite a $1,000.00 sin PIN -> Bloqueado
    const updateLimitNoPin = await service.updateCustomerWithPinCheck(custId, {
      name: 'Don Rogelio Taller Istmo',
      creditLimit: 1000.0,
      creditDays: 15,
    });
    expect(updateLimitNoPin.ok).toBeFalse();
    expect(updateLimitNoPin.message).toContain('PIN de encargado');

    // 3. Modificar con PIN erróneo -> Bloqueado
    const updateLimitWrongPin = await service.updateCustomerWithPinCheck(
      custId,
      {
        name: 'Don Rogelio Taller Istmo',
        creditLimit: 1000.0,
        creditDays: 15,
      },
      '000000',
    );
    expect(updateLimitWrongPin.ok).toBeFalse();
    expect(updateLimitWrongPin.message).toContain('incorrecto');

    // 4. Modificar plazo a 30 días con PIN correcto -> Exitoso
    const updateSuccess = await service.updateCustomerWithPinCheck(
      custId,
      {
        name: 'Don Rogelio Taller Istmo',
        creditLimit: 1000.0,
        creditDays: 30,
      },
      '984312',
    );
    expect(updateSuccess.ok).toBeTrue();
    expect(updateSuccess.customer?.creditLimit).toBe(1000.0);
    expect(updateSuccess.customer?.creditDays).toBe(30);
  });

  it('43. Bloque F2: Baja lógica de cliente y proveedor bloqueada si tienen saldo pendiente; permitida si saldo es 0', async () => {
    // --- CLIENTE ---
    const custRes = service.createCustomer({
      name: 'Cliente Para Baja',
      creditLimit: 500.0,
      creditDays: 15,
    });
    const custId = custRes.customer!.id;

    // Con saldo 0 se puede dar de baja
    const deact1 = service.deleteCustomerLogical(custId);
    expect(deact1.ok).toBeTrue();
    expect(service.getCustomerDetail(custId)!.isActive).toBeFalse();

    // Reactivar para probar bloqueo con deuda
    service.creditCustomers.update((list) =>
      list.map((c) => (c.id === custId ? { ...c, isActive: true, currentBalance: 150.0 } : c)),
    );

    const deactBlocked = service.deleteCustomerLogical(custId);
    expect(deactBlocked.ok).toBeFalse();
    expect(deactBlocked.message).toContain('saldo pendiente');

    // --- PROVEEDOR ---
    const suppRes = service.createSupplier({
      name: 'Proveedor Para Baja',
      phone: '477-111-2222',
      paymentTerms: 'CREDITO',
      creditDays: 15,
    });
    expect(suppRes.ok).toBeTrue();
    const suppId = suppRes.supplier!.id;

    // Sin saldo se da de baja
    const deactSuppClean = service.deleteSupplierLogical(suppId);
    expect(deactSuppClean.ok).toBeTrue();

    // Reactivar y asignar saldo por pagar
    service.suppliers.update((list) =>
      list.map((s) => (s.id === suppId ? { ...s, isActive: true, currentBalance: 320.0 } : s)),
    );
    const deactSuppBlocked = service.deleteSupplierLogical(suppId);
    expect(deactSuppBlocked.ok).toBeFalse();
    expect(deactSuppBlocked.message).toContain('saldo pendiente');
  });

  it('44. Bloque F2: Proveedor nuevo, recepción de compra a crédito genera cuenta por pagar con vencimiento y alerta en tablero', async () => {
    // 1. Alta de proveedor nuevo
    const suppRes = service.createSupplier({
      name: 'Distribuidora Lácteos Santa Clara',
      phone: '800-726-8225',
      visitDays: ['Martes', 'Viernes'],
      paymentTerms: 'CREDITO',
      creditDays: 15,
      physicalExchangePolicy: true,
      notes: 'Leches y yogures gourmet',
    });
    expect(suppRes.ok).toBeTrue();
    const suppId = suppRes.supplier!.id;

    // 2. Crear recepción de compra a crédito
    const receptionLines = [
      service.createManualLine('LAC-LAL-1L', 5, 18.0), // 5 cajas x 12 pzas = 60 pzas a $18 = $1,080.00
    ];

    service.saveReception(receptionLines, 'REC-SC-1001', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 15,
    });

    // 3. Verificar cuenta por pagar (CxP)
    const pendingDebts = service.getPendingAccountsPayable(suppId);
    expect(pendingDebts.length).toBe(1);
    const debt = pendingDebts[0];
    expect(debt.receptionFolio).toBe('REC-SC-1001');
    expect(debt.totalAmount).toBe(receptionLines[0].lineTotal);
    expect(debt.remainingBalance).toBe(receptionLines[0].lineTotal);
    expect(debt.status).toBe('PENDIENTE');

    // Verificar vencimiento calculado a 15 días
    const todayStr = new Date().toISOString().slice(0, 10);
    const expectedDueDate = calculateDueDate(todayStr, 15);
    expect(debt.dueDate).toBe(expectedDueDate);

    // 4. Saldo del proveedor actualizado
    const supp = service.suppliers().find((s) => s.id === suppId)!;
    expect(supp.currentBalance).toBe(receptionLines[0].lineTotal);

    // 5. Alerta en tablero de pago próximo a vencer
    const alert = service.morningAlerts().find((a) => a.kind === 'vencimiento_proveedor' && a.id.includes('REC-SC-1001'));
    expect(alert).toBeDefined();
    expect(alert?.detail).toContain(expectedDueDate);

    // 6. Kardex encadenado con ENTRADA_COMPRA
    expect(service.verifyKardexIntegrity().valid).toBeTrue();
  });

  it('45. Bloque F2: Pago a proveedor en efectivo genera salida de caja (cashPayoutsTotal), movimiento en Kardex y liquida CxP', async () => {
    // 1. Crear proveedor y cuenta por pagar
    const suppRes = service.createSupplier({
      name: 'Abarrotes Don Pepe',
      phone: '477-333-4444',
      paymentTerms: 'CREDITO',
      creditDays: 7,
    });
    const suppId = suppRes.supplier!.id;

    const lines = [service.createManualLine('ACE-NUT-850', 24, 35.0)]; // 2 cajas x 12 = 24 pzas x $35 = $840.00
    service.saveReception(lines, 'REC-PEP-2002', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 7,
    });

    // Simular ventas en efectivo para tener suficiente efectivo en cajón ($1,500)
    service.cashShift.update((s) => ({ ...s, cashSalesTotal: 1000.0 }));
    service.cashRegister.update((r) => ({ ...r, cashSalesTotal: 1000.0 }));

    const initialDrawerCash = service.getRealDrawerCash();
    const initialPayouts = service.cashShift().cashPayoutsTotal || 0;

    // 2. Realizar pago en efectivo de $500.00
    const payRes1 = await service.registerSupplierPayment(suppId, 500.0, 'EFECTIVO', 'Don Lupe (Encargado)');
    expect(payRes1.ok).toBeTrue();
    expect(payRes1.appliedAmount).toBe(500.0);
    expect(payRes1.remainingBalance).toBe(340.0); // 840 - 500 = 340

    // 3. Comprobar salida de caja y reducción del efectivo en cajón
    expect(service.cashShift().cashPayoutsTotal).toBe(initialPayouts + 500.0);
    expect(service.cashRegister().cashPayoutsTotal).toBe(initialPayouts + 500.0);
    expect(service.getRealDrawerCash()).toBe(initialDrawerCash - 500.0);

    // 4. Comprobar movimiento en Kardex de tipo PAGO_PROVEEDOR registrado con sku: 'TESORERIA'
    const kardexPayout = service.kardex().find((k) => k.type === 'PAGO_PROVEEDOR' && (k.sku === 'TESORERIA' || (typeof k.producto !== 'string' && k.producto.sku === 'TESORERIA')));
    expect(kardexPayout).toBeDefined();
    expect(kardexPayout?.amount).toBe(500.0);
    expect(kardexPayout?.cantidad).toBe(0);
    expect(kardexPayout?.quantity).toBe(0);
    expect(service.verifyKardexIntegrity().valid).toBeTrue();

    // 5. Liquidar el restante $340.00 en efectivo desde el cajón
    const payRes2 = await service.registerSupplierPayment(suppId, 340.0, 'EFECTIVO', 'Don Lupe');
    expect(payRes2.ok).toBeTrue();
    expect(payRes2.remainingBalance).toBe(0);
    expect(service.cashShift().cashPayoutsTotal).toBe(initialPayouts + 840.0);
    expect(service.getRealDrawerCash()).toBe(initialDrawerCash - 840.0);

    const pendingDebts = service.getPendingAccountsPayable(suppId);
    expect(pendingDebts.length).toBe(0); // Totalmente liquidada
  });

  it('46. Bloque F2: Historial de precios por proveedor y producto registra entradas y detecta alzas de costo', () => {
    const suppRes = service.createSupplier({
      name: 'Distribuidora Frijoles',
      phone: '477-999-8888',
      paymentTerms: 'CONTADO',
    });
    const suppId = suppRes.supplier!.id;

    // 1. Primera recepción a costo base de $22.00
    const line1 = service.createManualLine('FRI-NEG-50K', 2, 22.0);
    service.saveReception([line1], 'REC-FRI-01', {
      paymentType: 'CONTADO',
      supplierId: suppId,
    });

    const history1 = service.getProductPriceHistory('FRI-NEG-50K', suppId);
    expect(history1.length).toBeGreaterThanOrEqual(1);
    expect(history1[0].unitCost).toBe(22.0);
    expect(history1[0].priceHikeDetected).toBeFalse();

    // 2. Segunda recepción con incremento a $26.40 (+20%)
    const line2 = service.createManualLine('FRI-NEG-50K', 2, 26.4);
    service.saveReception([line2], 'REC-FRI-02', {
      paymentType: 'CONTADO',
      supplierId: suppId,
    });

    const history2 = service.getProductPriceHistory('FRI-NEG-50K', suppId);
    expect(history2[0].unitCost).toBe(26.4);
    expect(history2[0].previousUnitCost).toBe(22.0);
    expect(history2[0].priceHikeDetected).toBeTrue();
    expect(history2[0].hikePct).toBe(20);

    // 3. Comprobar que se generó alerta de alza en el tablero
    const hikeAlert = service.morningAlerts().find((a) => a.kind === 'margen' && a.id.includes('FRI-NEG-50K'));
    expect(hikeAlert).toBeDefined();
    expect(hikeAlert?.title).toContain('+20%');
  });



  it('47. Seguimiento F2: Validación de efectivo en cajón y opción de pago a proveedor con fondo externo (bolsillo del dueño)', async () => {
    const suppRes = service.createSupplier({
      name: 'Distribuidora San Juan',
      phone: '477-555-1234',
      paymentTerms: 'CREDITO',
      creditDays: 15,
    });
    const suppId = suppRes.supplier!.id;

    // Recepción a crédito de $5,000.00 (mayor que el efectivo en caja)
    service.saveReception([service.createManualLine('FRI-NEG-50K', 5, 1000.0)], 'REC-SJ-5000', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 15,
    });

    const realCash = service.getRealDrawerCash();
    const excessiveAmount = realCash + 1000.0; // Supera el dinero en cajón

    // 1. Intento de pago con CAJA que excede el efectivo disponible sin PIN -> RECHAZADO con mensaje descriptivo exacto
    const rejectRes = await service.registerSupplierPayment(suppId, excessiveAmount, 'EFECTIVO', 'Don Lupe', { source: 'CAJA' });
    expect(rejectRes.ok).toBeFalse();
    expect(rejectRes.message).toBe(`El pago en efectivo ($${excessiveAmount.toFixed(2)}) excede el efectivo disponible en cajón ($${realCash.toFixed(2)}). Se requiere PIN de encargado para autorizar la salida extraordinaria.`);

    // El arqueo y saldo permanecen intactos
    expect(service.getRealDrawerCash()).toBe(realCash);
    expect(service.cashShift().cashPayoutsTotal || 0).toBe(0);

    // 1b. Intento con PIN incorrecto -> RECHAZADO
    const wrongPinRes = await service.registerSupplierPayment(suppId, excessiveAmount, 'EFECTIVO', 'Don Lupe', { source: 'CAJA', pin: '000000' });
    expect(wrongPinRes.ok).toBeFalse();
    expect(wrongPinRes.message).toContain('PIN de encargado incorrecto');

    // 2. Pago con FONDO_EXTERNO por $2,500.00 -> PERMITIDO aunque no salga de la caja
    const extRes = await service.registerSupplierPayment(suppId, 2500.0, 'EFECTIVO', 'Don Lupe', { source: 'FONDO_EXTERNO' });
    expect(extRes.ok).toBeTrue();
    expect(extRes.appliedAmount).toBe(2500.0);
    expect(extRes.remainingBalance).toBe(2500.0);

    // NO se tocó el efectivo de la tienda ni cashPayoutsTotal
    expect(service.getRealDrawerCash()).toBe(realCash);
    expect(service.cashShift().cashPayoutsTotal || 0).toBe(0);

    // 3. Pago con CAJA dentro del saldo disponible -> Descuenta del cajón y suma a cashPayoutsTotal
    const validAmount = 50.0;
    expect(validAmount).toBeLessThanOrEqual(realCash);
    const cajaRes = await service.registerSupplierPayment(suppId, validAmount, 'EFECTIVO', 'Don Lupe', { source: 'CAJA' });
    expect(cajaRes.ok).toBeTrue();
    expect(cajaRes.appliedAmount).toBe(validAmount);
    expect(service.cashShift().cashPayoutsTotal).toBe(validAmount);
    expect(service.getRealDrawerCash()).toBe(realCash - validAmount);
  });

  it('48. Seguimiento F2: Aislamiento estricto de movimientos monetarios (PAGO_PROVEEDOR) para no contaminar valuaciones ni conteos físicos en Kardex', async () => {
    const suppRes = service.createSupplier({
      name: 'Comercializadora Kardex Test',
      phone: '477-888-9999',
      paymentTerms: 'CREDITO',
    });
    const suppId = suppRes.supplier!.id;

    // Crear producto físico y registrar compra
    const initialValuation = service.getInventoryValuation();
    const initialPhysicalUnits = initialValuation.totalPhysicalUnits;

    // Generar recepción a crédito y luego pago de tesorería de $1,200.00
    service.saveReception([service.createManualLine('ACE-NUT-850', 10, 30.0)], 'REC-KARDEX-01', {
      paymentType: 'CREDITO',
      supplierId: suppId,
    });

    const paymentRes = await service.registerSupplierPayment(suppId, 300.0, 'EFECTIVO', 'Don Lupe', { source: 'FONDO_EXTERNO' });
    expect(paymentRes.ok).toBeTrue();

    // Comprobar que la entrada en el Kardex tiene sku: 'TESORERIA', quantity: 0, stockAfter: 0
    const entry = service.kardex()[0];
    expect(entry.type).toBe('PAGO_PROVEEDOR');
    expect(entry.sku).toBe('TESORERIA');
    expect(entry.quantity).toBe(0);
    expect(entry.cantidad).toBe(0);
    expect(entry.saldoAnterior).toBe(0);
    expect(entry.saldoResultante).toBe(0);
    expect(entry.stockAfter).toBe(0);
    expect(entry.amountCents).toBe(30000);

    // Verificación de integridad SHA-256 encadenada
    expect(service.verifyKardexIntegrity().valid).toBeTrue();

    // Verificación de que TESORERIA no tiene stock físico
    expect(service.getPhysicalStockFromKardex('TESORERIA')).toBe(0);
    expect(service.getProductCPP('TESORERIA')).toBe(0);

    // Valuación de inventario no incluye montos de tesorería
    const postValuation = service.getInventoryValuation();
    expect(postValuation.totalSkus).toBeGreaterThan(0);
    expect(postValuation.totalPhysicalUnits).toBe(initialPhysicalUnits + 10);
  });

  it('49. Seguimiento F2: Amortización específica por remisión/factura (targetDebtId) en CxP además del FIFO automático', async () => {
    const suppRes = service.createSupplier({
      name: 'Proveedor Notas Múltiples',
      phone: '477-222-1111',
      paymentTerms: 'CREDITO',
    });
    const suppId = suppRes.supplier!.id;

    // Registrar 2 compras a crédito con folios distintos
    service.saveReception([service.createManualLine('ACE-NUT-850', 10, 20.0)], 'REC-NOTA-A', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 5, // Vence pronto
    });
    service.saveReception([service.createManualLine('ACE-NUT-850', 10, 30.0)], 'REC-NOTA-B', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 30, // Vence más tarde
    });

    const pending = service.getPendingAccountsPayable(suppId);
    expect(pending.length).toBe(2);
    const notaA = pending.find((d) => d.receptionFolio === 'REC-NOTA-A')!;
    const notaB = pending.find((d) => d.receptionFolio === 'REC-NOTA-B')!;

    // Pagar específicamente NOTA-B ($300.00) por targetDebtId
    const payRes = await service.registerSupplierPayment(suppId, 300.0, 'EFECTIVO', 'Don Lupe', {
      source: 'FONDO_EXTERNO',
      targetDebtId: notaB.id,
    });

    expect(payRes.ok).toBeTrue();

    const afterDebts = service.accountsPayable().filter((d) => d.supplierId === suppId);
    const updatedNotaB = afterDebts.find((d) => d.id === notaB.id)!;
    const updatedNotaA = afterDebts.find((d) => d.id === notaA.id)!;

    // NOTA-B quedó pagada
    expect(updatedNotaB.remainingBalance).toBe(0);
    expect(updatedNotaB.status).toBe('PAGADO');

    // NOTA-A (aunque más antigua) sigue con saldo completo
    expect(updatedNotaA.remainingBalance).toBe(notaA.remainingBalance);
  });

  it('50. Seguimiento F2: Resumen visual de abono de cliente en POS (saldo anterior, abono, nuevo saldo sin emojis)', () => {
    // 1. Crear cliente con saldo
    const custRes = service.createCustomer({
      name: 'Doña Petra Abonos',
      alias: 'Doña Petra',
      phone: '477-666-7777',
      creditLimit: 1000.0,
      creditDays: 15,
    });
    const custId = custRes.customer!.id;

    // Venta a crédito de $400.00
    service.activeUser.set('Don Lupe (Encargado)');
    const saleItems: PosSaleItem[] = [
      {
        sku: 'AB-PAN-01',
        barcode: '75010001',
        name: 'Pan Dulce Artesanal',
        emoji: '🥐',
        unitPrice: 40.0,
        saleUnit: 'Pieza',
        isBulk: false,
        qty: 10,
        subtotal: 400.0,
      },
    ];
    const saleRes = service.processCreditSale(saleItems, custId);
    expect(saleRes.ok).toBeTrue();

    // 2. Registrar abono de $150.00
    const abonoRes = service.registerCreditPayment(custId, 150.0);
    expect(abonoRes.ok).toBeTrue();
    expect(abonoRes.previousBalance).toBe(400.0);
    expect(abonoRes.applied).toBe(150.0);
    expect(abonoRes.newBalance).toBe(250.0);
    expect(abonoRes.customerName).toBe('Doña Petra Abonos');

    // 3. Probar componente PosViewComponent y la señal abonoSuccessSummary
    const comp = TestBed.runInInjectionContext(() => new PosViewComponent());
    comp.ngOnInit();

    // Seleccionar cliente y monto
    (comp as any).abonoCustomerId.set(custId);
    (comp as any).abonoAmount.set(100.0);

    // Ejecutar abono
    comp.executeAbono();

    const summary = (comp as any).abonoSuccessSummary();
    expect(summary).not.toBeNull();
    expect(summary.customerName).toBe('Doña Petra Abonos');
    expect(summary.previousBalance).toBe(250.0);
    expect(summary.applied).toBe(100.0);
    expect(summary.newBalance).toBe(150.0);

    // Cerrar resumen manualmente
    comp.closeAbonoSummary();
    expect((comp as any).abonoSuccessSummary()).toBeNull();
  });

  it('51. Seguimiento F2: Rechazo de pago mayor al saldo de deuda y validación de efectivo en cajón con PIN de encargado', async () => {
    const suppRes = service.createSupplier({
      name: 'Proveedor Validaciones Pagos',
      phone: '951-444-5555',
      paymentTerms: 'CREDITO',
      creditDays: 15,
    });
    const suppId = suppRes.supplier!.id;

    // Crear recepción a crédito por $400.00
    service.saveReception([service.createManualLine('ACE-NUT-850', 10, 40.0)], 'REC-DEBT-01', {
      paymentType: 'CREDITO',
      supplierId: suppId,
      creditDays: 15,
    });

    const pending = service.getPendingAccountsPayable(suppId);
    expect(pending.length).toBe(1);
    const debtId = pending[0].id;

    // 1. Rechazo de pago mayor al saldo de una remisión específica (targetDebtId)
    const overTargetRes = await service.registerSupplierPayment(suppId, 450.0, 'EFECTIVO', 'Don Lupe', {
      source: 'FONDO_EXTERNO',
      targetDebtId: debtId,
    });
    expect(overTargetRes.ok).toBeFalse();
    expect(overTargetRes.message).toContain('supera el saldo de la deuda seleccionada');

    // 2. Rechazo de pago mayor al saldo total del proveedor (general FIFO)
    const overSupplierRes = await service.registerSupplierPayment(suppId, 600.0, 'EFECTIVO', 'Don Lupe', {
      source: 'FONDO_EXTERNO',
    });
    expect(overSupplierRes.ok).toBeFalse();
    expect(overSupplierRes.message).toContain('supera el saldo pendiente total del proveedor');

    // 3. Pago en efectivo que supera el cajón sin PIN -> Rechazado
    // Supongamos cajón en $50.00
    service.cashShift.update((s) => ({ ...s, openingCash: 50.0, cashSalesTotal: 0, creditPaymentsReceived: 0, cashPayoutsTotal: 0 }));
    service.cashRegister.update((r) => ({ ...r, openingFloat: 50.0, cashSalesTotal: 0, creditPaymentsReceived: 0, cashPayoutsTotal: 0 }));
    expect(service.getRealDrawerCash()).toBe(50.0);

    const drawerExceededRes = await service.registerSupplierPayment(suppId, 100.0, 'EFECTIVO', 'Don Lupe', {
      source: 'CAJA',
    });
    expect(drawerExceededRes.ok).toBeFalse();
    expect(drawerExceededRes.message).toContain('Se requiere PIN de encargado para autorizar la salida extraordinaria');

    // 4. Con PIN inválido -> Rechazado
    const invalidPinRes = await service.registerSupplierPayment(suppId, 100.0, 'EFECTIVO', 'Don Lupe', {
      source: 'CAJA',
      pin: '000000',
    });
    expect(invalidPinRes.ok).toBeFalse();
    expect(invalidPinRes.message).toContain('PIN de encargado incorrecto');

    // 5. Con PIN válido -> Autorizado
    await service.setupInitialPin('984312');
    const validPinRes = await service.registerSupplierPayment(suppId, 100.0, 'EFECTIVO', 'Don Lupe', {
      source: 'CAJA',
      pin: '984312',
    });
    expect(validPinRes.ok).toBeTrue();
    expect(validPinRes.appliedAmount).toBe(100.0);
    expect(validPinRes.remainingBalance).toBe(300.0);
  });

  it('52. Seguimiento F2: Detección y prevención de duplicados en Clientes y Proveedores con aviso y confirmación', () => {
    // 1. Proveedores: alta original
    const s1 = service.createSupplier({
      name: 'Comercializadora Oaxaqueña',
      phone: '951-111-2222',
      paymentTerms: 'CONTADO',
    });
    expect(s1.ok).toBeTrue();

    // Intento de duplicado por nombre similar con acentos/mayúsculas sin confirmación
    const dupSupName = service.createSupplier({
      name: '  comercializadora oaxaquena  ',
      phone: '951-999-0000',
    });
    expect(dupSupName.ok).toBeFalse();
    expect(dupSupName.duplicateWarning).toBeTrue();
    expect(dupSupName.message).toContain('Ya existe un proveedor registrado');

    // Con confirmación explícita (confirmDuplicate = true) -> Se crea
    const confirmedSup = service.createSupplier(
      { name: '  comercializadora oaxaquena  ', phone: '951-999-0000' },
      true
    );
    expect(confirmedSup.ok).toBeTrue();

    // 2. Clientes: alta original
    const c1 = service.createCustomer({
      name: 'Don Florencio Morales',
      phone: '951-555-8888',
      creditLimit: 500,
    });
    expect(c1.ok).toBeTrue();

    // Intento de duplicado por teléfono idéntico
    const dupCustPhone = service.createCustomer({
      name: 'Florencio M.',
      phone: '(951) 555 8888',
      creditLimit: 300,
    });
    expect(dupCustPhone.ok).toBeFalse();
    expect(dupCustPhone.duplicateWarning).toBeTrue();
    expect(dupCustPhone.message).toContain('Ya existe un cliente');

    // Con confirmación -> Se crea
    const confirmedCust = service.createCustomer(
      { name: 'Florencio M.', phone: '(951) 555 8888', creditLimit: 300 },
      true
    );
    expect(confirmedCust.ok).toBeTrue();
  });

  it('53. Seguimiento F2: Tipo único CashMovement registrado en pagos a proveedor y abonos de clientes', async () => {
    const initialMovements = service.cashMovements().length;

    // 1. Alta de proveedor y recepción a crédito
    const supRes = service.createSupplier({
      name: 'Lácteos Lala Movimientos',
      phone: '800-111-2233',
      paymentTerms: 'CREDITO',
    });
    const suppId = supRes.supplier!.id;

    service.saveReception([service.createManualLine('LAC-LAL-1L', 10, 20.0)], 'REC-MOV-01', {
      paymentType: 'CREDITO',
      supplierId: suppId,
    });

    // Simular suficiente dinero en caja para pagar
    service.cashShift.update((s) => ({ ...s, cashSalesTotal: 1000.0 }));

    // Realizar pago a proveedor de $150.00 desde CAJA
    const payRes = await service.registerSupplierPayment(suppId, 150.0, 'EFECTIVO', 'Don Lupe (Encargado)', {
      source: 'CAJA',
    });
    expect(payRes.ok).toBeTrue();

    // Verificar que se registró un CashMovement de tipo SALIDA
    const afterPayMovements = service.cashMovements();
    expect(afterPayMovements.length).toBe(initialMovements + 1);
    const payoutMov = afterPayMovements[0];
    expect(payoutMov.type).toBe('SALIDA');
    expect(payoutMov.amount).toBe(150.0);
    expect(payoutMov.amountCents).toBe(15000);
    expect(payoutMov.source).toBe('CAJA');
    expect(payoutMov.supplierId).toBe(suppId);
    expect(payoutMov.reason).toContain('Pago a proveedor');
    expect(payoutMov.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // Formato AAAA-MM-DD local

    // 2. Alta de cliente y registro de abono en efectivo
    const custRes = service.createCustomer({
      name: 'Vecino Abonos CashMov',
      phone: '951-777-1111',
      creditLimit: 500,
    });
    const custId = custRes.customer!.id;

    service.processCreditSale([
      { sku: 'ACE-NUT-850', barcode: '1', name: 'Aceite', emoji: '🍾', saleUnit: 'Pieza', isBulk: false, qty: 5, unitPrice: 40.0, subtotal: 200.0 },
    ], custId);

    // Registrar abono de $80.00
    const abonoRes = service.registerCreditPayment(custId, 80.0);
    expect(abonoRes.ok).toBeTrue();

    // Verificar que se registró un CashMovement de tipo ENTRADA
    const finalMovements = service.cashMovements();
    expect(finalMovements.length).toBe(initialMovements + 2);
    const abonoMov = finalMovements[0];
    expect(abonoMov.type).toBe('ENTRADA');
    expect(abonoMov.amount).toBe(80.0);
    expect(abonoMov.amountCents).toBe(8000);
    expect(abonoMov.source).toBe('CAJA');
    expect(abonoMov.reason).toContain('Abono de cliente');
    expect(abonoMov.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('54. Seguimiento F2: Persistencia schemaVersion 3 hidrata proveedores, cuentas por pagar y no elimina v2 hasta validar v3', async () => {
    // 1. Simular carga de un snapshot con versión 2 en storageAdapter
    const adapter = (service as any).storageAdapter;
    const v2Data = {
      schemaVersion: 2,
      timestamp: '2026-11-05T12:00:00.000Z',
      activeUser: 'Don Lupe (Encargado)',
      products: service.products(),
      creditCustomers: service.creditCustomers(),
      cashShift: service.cashShift(),
      cashRegister: service.cashRegister(),
      kardex: service.kardex(),
      shrinkRecords: service.shrinkRecords(),
      auditLines: service.auditLines(),
      suppliers: [
        {
          id: 'SUP-LEGACY-V2',
          name: 'Proveedor de v2',
          phone: '951-333-2211',
          isActive: true,
          currentBalance: 0,
        },
      ],
      accountsPayable: [],
      priceHistory: [],
    };

    // Guardar bajo clave legacy v2
    await adapter.save('binnitech_pos_state_v2', v2Data);

    // Ejecutar restorePersistedState
    const restoreRes = await service.restorePersistedState();
    expect(restoreRes.success).toBeTrue();

    // Verificar que el servicio se hidrató y el proveedor de v2 está presente
    const foundSup = service.suppliers().find((s) => s.id === 'SUP-LEGACY-V2');
    expect(foundSup).toBeDefined();
    expect(foundSup?.paymentTerms).toBe('CONTADO'); // Migrado con valor por defecto

    // Verificar que el estado guardado ahora está en v3
    const v3Saved = await adapter.load('binnitech_pos_state_v3');
    expect(v3Saved).toBeDefined();
    expect(v3Saved.schemaVersion).toBe(3);

    // Verificar que la clave legacy v2 fue eliminada tras la validación exitosa de v3
    const legacyCheck = await adapter.load('binnitech_pos_state_v2');
    expect(legacyCheck).toBeNull();
  });
});
