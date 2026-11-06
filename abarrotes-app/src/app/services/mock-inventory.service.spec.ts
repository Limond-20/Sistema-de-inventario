import { TestBed } from '@angular/core/testing';
import { MockInventoryService, ShrinkRecord, ReceptionLine } from './mock-inventory.service';
import { createKardexEntry } from '../domain/kardex';
import {
  CORRUPT_STATE_KEY_PREFIX,
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  IndexedDbStateStorageAdapter,
  MemoryStateStorageAdapter,
} from '../domain/persistence';

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
});
