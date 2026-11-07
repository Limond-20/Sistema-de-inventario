import { TestBed } from '@angular/core/testing';
import { MockInventoryService, ShrinkRecord, ReceptionLine } from './mock-inventory.service';
import { createKardexEntry, verifyProductContinuity } from '../domain/kardex';
import {
  CORRUPT_STATE_KEY_PREFIX,
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  IndexedDbStateStorageAdapter,
  MemoryStateStorageAdapter,
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
      providers: [MockInventoryService],
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
          saleUnit: 'Pieza',
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
      saleUnit: 'Pieza',
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
});
