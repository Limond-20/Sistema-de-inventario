import { TestBed } from '@angular/core/testing';
import { MockInventoryService, ShrinkRecord, ReceptionLine } from './mock-inventory.service';
import { verifyKardexChain } from '../domain/kardex';
import {
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  MemoryStateStorageAdapter,
} from '../domain/persistence';

describe('MockInventoryService Integración (Bloque C)', () => {
  let service: MockInventoryService;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    TestBed.configureTestingModule({
      providers: [MockInventoryService],
    });
    service = TestBed.inject(MockInventoryService);
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

  it('7. Persistencia (Bloque D): Datos dañados arrancan con datos de demostración y emiten alerta visible', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

    // Guardamos datos corruptos (colección no arreglo y kardex alterado)
    await memoryAdapter.save(STATE_STORAGE_KEY, {
      schemaVersion: 1,
      products: 'productos-corruptos-no-array',
      kardex: [],
    });

    const restoreResult = await service.restorePersistedState();
    expect(restoreResult.success).toBeFalse();
    expect(restoreResult.corrupted).toBeTrue();

    // Comprobamos que el aviso de corrupción está activo
    expect(service.corruptedDataWarning()).toContain('dañados');

    // Comprobamos que los productos arrancaron con los datos iniciales de demostración
    expect(service.products().length).toBeGreaterThan(0);
    const prod = service.products().find((p) => p.sku === 'REF-COC-600');
    expect(prod).toBeDefined();

    // Comprobamos que se emitió una alerta visible en el tablero
    const alert = service.morningAlerts().find((a) => a.id === 'ALERT-DATA-CORRUPT');
    expect(alert).toBeDefined();
    expect(alert!.title).toContain('demostración');
  });

  it('8. Persistencia (Bloque D): Migración simple de versión anterior (v0 -> v1)', async () => {
    const memoryAdapter = new MemoryStateStorageAdapter();
    service.storageAdapter = memoryAdapter;

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
      kardex: [],
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
});
