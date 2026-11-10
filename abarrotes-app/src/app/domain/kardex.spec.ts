import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKardexId,
  createKardexEntry,
  appendKardexEntry,
  deductStock,
  deductStockForDisposal,
  resolveShortageAlertAdjustment,
  verifyKardexChain,
  verifyProductContinuity,
  KardexAsyncQueue,
  computePhysicalStockFromKardex,
  computeWeightedAverageCostFromKardex,
  computeKardexInventoryValuation,
  type KardexEntry,
} from './kardex.ts';

test('Kardex: IDs de Kardex únicos en 1,000 movimientos', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const id = generateKardexId();
    assert.equal(ids.has(id), false, `ID duplicado detectado: ${id}`);
    ids.add(id);
  }
  assert.equal(ids.size, 1000, 'Deben generarse exactamente 1000 IDs únicos');
});

test('Kardex: Hash encadenado y verifyKardexChain detecta una entrada alterada', () => {
  // Construimos una secuencia válida de 5 movimientos
  let history: KardexEntry[] = [];
  let prevHash = 'GENESIS';

  for (let i = 1; i <= 5; i++) {
    const entry = createKardexEntry(
      {
        type: 'VENTA_EFECTIVO',
        producto: { sku: 'COCA-600', name: 'Coca Cola 600ml' },
        cantidad: -1,
        saldoAnterior: 20 - (i - 1),
        saldoResultante: 20 - i,
        usuario: 'Don Lupe (Encargado)',
        referencia: `Ticket #${i}`,
      },
      prevHash
    );
    history = appendKardexEntry(history, entry);
    prevHash = entry.entryHash;
  }

  // 1. Verificación inicial de la cadena intacta
  const checkInitial = verifyKardexChain(history);
  assert.equal(checkInitial.valid, true, 'La cadena inicial debe ser 100% válida');

  // 2. Modificación maliciosa de una entrada (alteramos cantidad de la entrada 2)
  const tamperedHistory = history.map((e, idx) => {
    if (idx === 2) {
      return { ...e, cantidad: -10 }; // Alteración sin recalcular hash
    }
    return e;
  });

  const checkTampered = verifyKardexChain(tamperedHistory);
  assert.equal(checkTampered.valid, false, 'verifyKardexChain debe detectar la alteración');
  assert.ok(checkTampered.error?.includes('Entrada alterada') || checkTampered.error?.includes('Ruptura de cadena'));
});

test('Kardex Concurrencia: 200 movimientos asíncronos concurrentes con Promise.all mantienen la cadena válida sin bifurcaciones', async () => {
  const queue = new KardexAsyncQueue();
  let entries: KardexEntry[] = [];
  let currentStock = 1000;

  // Lanzamos 200 movimientos concurrentes usando Promise.all y la cola serializadora
  const promises = Array.from({ length: 200 }, (_, i) => {
    return queue.enqueue(async () => {
      // Simular cálculo de hash o retraso asíncrono para forzar condiciones de carrera concurrentes
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
      const prevHash = entries.length > 0 ? entries[0].entryHash : 'GENESIS';
      const cantidad = -1;
      const saldoAnterior = currentStock;
      const saldoResultante = saldoAnterior + cantidad;
      currentStock = saldoResultante;

      const newEntry = createKardexEntry(
        {
          type: 'VENTA_EFECTIVO',
          producto: { sku: 'TEST-CONCURRENCIA', name: 'Producto Prueba' },
          cantidad,
          saldoAnterior,
          saldoResultante,
          usuario: `Cajero ${i % 3}`,
          referencia: `Ticket #${i + 1}`,
        },
        prevHash
      );
      entries = appendKardexEntry(entries, newEntry);
    });
  });

  await Promise.all(promises);

  assert.equal(entries.length, 200, 'Deben existir exactamente 200 entradas en el historial');
  const chainCheck = verifyKardexChain(entries);
  assert.equal(chainCheck.valid, true, `La cadena debe ser íntegra y no bifurcada: ${chainCheck.error}`);
  const continuityCheck = verifyProductContinuity('TEST-CONCURRENCIA', entries, currentStock);
  assert.equal(continuityCheck.valid, true, `La continuidad debe ser perfecta: ${continuityCheck.error}`);
});

test('Kardex: Prueba de continuidad: saldoResultante[i] == saldoAnterior[i+1] y stock actual == último saldoResultante', () => {
  let entries: KardexEntry[] = [];
  let prevHash = 'GENESIS';
  let stock = 100;

  // 10 transacciones secuenciales del producto 'JABON-ROSA'
  for (let i = 0; i < 10; i++) {
    const qty = -(i + 1);
    const saldoAnt = stock;
    stock = saldoAnt + qty;
    const entry = createKardexEntry(
      {
        type: 'VENTA_EFECTIVO',
        producto: { sku: 'JABON-ROSA', name: 'Jabón Rosa 400g' },
        cantidad: qty,
        saldoAnterior: saldoAnt,
        saldoResultante: stock,
        usuario: 'Don Lupe (Encargado)',
        referencia: `Venta #${i + 1}`,
      },
      prevHash
    );
    entries = appendKardexEntry(entries, entry);
    prevHash = entry.entryHash;
  }

  // Verificación de continuidad exitosa
  const continuityOk = verifyProductContinuity('JABON-ROSA', entries, stock);
  assert.equal(continuityOk.valid, true);

  // Verificación de falla si el stock actual no coincide con el último saldo
  const continuityFail = verifyProductContinuity('JABON-ROSA', entries, stock + 5);
  assert.equal(continuityFail.valid, false);
  assert.ok(continuityFail.error?.includes('Discontinuidad final'));
});

test('Mermas y consumo interno: no permitir baja mayor que la existencia a menos que se autorice con PIN y motivo', () => {
  const prod = { sku: 'LECHE-LALA', name: 'Leche Entera 1L', stock: 5, saleUnit: 'L' };

  // 1. Intento de baja por 8 unidades (mayor a stock: 5) SIN PIN: Bloqueado
  const bajaBloqueada = deductStockForDisposal({
    product: prod,
    qtyToDeduct: 8,
    type: 'BAJA_MERMA',
    usuario: 'Pedro (Cajero)',
    referencia: 'Cartón aplastado',
  });

  assert.equal(bajaBloqueada.ok, false);
  assert.equal(bajaBloqueada.requiresPin, true);
  assert.ok(bajaBloqueada.message.includes('supera la existencia disponible'));

  // 2. Intento de baja CON PIN pero SIN motivo: Bloqueado
  const bajaSinMotivo = deductStockForDisposal({
    product: prod,
    qtyToDeduct: 8,
    type: 'BAJA_MERMA',
    usuario: 'Pedro (Cajero)',
    referencia: 'Cartón aplastado',
    adminPinAuthorized: true,
    overrideReason: '   ',
  });

  assert.equal(bajaSinMotivo.ok, false);
  assert.ok(bajaSinMotivo.message.includes('obligatorio indicar el motivo'));

  // 3. Intento de baja CON PIN y CON motivo: Aprobada, genera FALTANTE_SISTEMA y alerta
  const bajaAutorizada = deductStockForDisposal({
    product: prod,
    qtyToDeduct: 8,
    type: 'BAJA_MERMA',
    usuario: 'Pedro (Cajero)',
    referencia: 'Cartón aplastado',
    adminPinAuthorized: true,
    overrideReason: 'Cajas llegaron rotas del proveedor y no se habían registrado',
  });

  assert.equal(bajaAutorizada.ok, true);
  assert.equal(bajaAutorizada.updatedProduct?.stock, -3); // 5 - 8 = -3
  assert.equal(bajaAutorizada.kardexEntries?.length, 2); // BAJA_MERMA + FALTANTE_SISTEMA
  assert.equal(bajaAutorizada.kardexEntries?.[0].type, 'BAJA_MERMA');
  assert.equal(bajaAutorizada.kardexEntries?.[1].type, 'FALTANTE_SISTEMA');
  assert.equal(bajaAutorizada.kardexEntries?.[1].cantidad, -3); // Solo el déficit real
  assert.ok(bajaAutorizada.shortageAlert !== undefined);
  assert.equal(bajaAutorizada.shortageAlert?.negativeStock, -3);
});

test('FALTANTE_SISTEMA en ventas registra solo el déficit real que sobrepasó la existencia', () => {
  // Caso A: Stock inicial positivo (3 piezas). Vendemos 5 piezas.
  // Déficit real que faltó: 5 - 3 = 2 piezas. Saldo resultante = -2.
  const prodA = { sku: 'ATUN-140', name: 'Atún Dolores 140g', stock: 3, saleUnit: 'Pz' };
  const resA = deductStock(prodA, 5, {
    saleType: 'VENTA_EFECTIVO',
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Ticket V-001',
  });

  assert.equal(resA.updatedProduct.stock, -2);
  assert.equal(resA.kardexEntries.length, 2);
  assert.equal(resA.kardexEntries[0].type, 'VENTA_EFECTIVO');
  assert.equal(resA.kardexEntries[0].cantidad, -5);
  assert.equal(resA.kardexEntries[0].saldoResultante, -2);

  assert.equal(resA.kardexEntries[1].type, 'FALTANTE_SISTEMA');
  assert.equal(resA.kardexEntries[1].cantidad, -2); // Exactamente el déficit real
  assert.equal(resA.kardexEntries[1].saldoAnterior, -2);
  assert.equal(resA.kardexEntries[1].saldoResultante, -2); // No salta saldo

  // Caso B: Stock inicial ya en negativo (-2 piezas). Vendemos 3 piezas más.
  // Todo lo vendido es déficit real (3 piezas). Saldo resultante = -5.
  const prodB = { sku: 'ATUN-140', name: 'Atún Dolores 140g', stock: -2, saleUnit: 'Pz' };
  const resB = deductStock(prodB, 3, {
    saleType: 'VENTA_EFECTIVO',
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Ticket V-002',
  });

  assert.equal(resB.updatedProduct.stock, -5);
  assert.equal(resB.kardexEntries[1].cantidad, -3); // Déficit de 3 piezas
  assert.equal(resB.kardexEntries[1].saldoResultante, -5);
});

test('Resolución de alerta de faltante con ajuste físico autorizado con PIN', () => {
  const prodEnNegativo = { sku: 'HUEVO-KG', name: 'Huevo Blanco 1Kg', stock: -4, saleUnit: 'Kg' };
  const alertId = 'A-FALTANTE-HUEVO-KG-12345';

  // El dueño cuenta en anaquel y constata que físicamente hay 12 kg
  const res = resolveShortageAlertAdjustment(
    prodEnNegativo,
    12,
    'Don Lupe (Encargado)',
    alertId,
    'PREV-HASH-XYZ'
  );

  assert.equal(res.updatedProduct.stock, 12);
  assert.equal(res.kardexEntry.type, 'AJUSTE_AUDITORIA');
  assert.equal(res.kardexEntry.saldoAnterior, -4);
  assert.equal(res.kardexEntry.saldoResultante, 12);
  assert.equal(res.kardexEntry.cantidad, 16); // 12 - (-4) = +16 kg ajustados
  assert.equal(res.kardexEntry.usuario, 'Don Lupe (Encargado)');
  assert.ok(res.kardexEntry.referencia.includes(alertId));
});


test('Kardex (F2 Bloque B): PAGO_PROVEEDOR no desvirtúa inventario físico, CPP ni valuación de inventario', () => {
  const entryCompra = createKardexEntry({
    type: 'ENTRADA_COMPRA',
    producto: { sku: 'ACEITE-850', name: 'Aceite 850ml' },
    sku: 'ACEITE-850',
    cantidad: 10,
    quantity: 10,
    saldoAnterior: 0,
    saldoResultante: 10,
    stockAfter: 10,
    amount: 350.0,
    amountCents: 35000,
    usuario: 'Don Lupe',
    referencia: 'Factura F-100',
  }, 'GENESIS');

  const entryPagoTesoreria = createKardexEntry({
    type: 'PAGO_PROVEEDOR',
    producto: { sku: 'TESORERIA', name: 'Tesorería - Pago a Distribuidora' },
    sku: 'TESORERIA',
    cantidad: 0,
    quantity: 0,
    saldoAnterior: 0,
    saldoResultante: 0,
    stockAfter: 0,
    amount: 1500.0,
    amountCents: 150000,
    usuario: 'Don Lupe',
    referencia: 'Pago CxP CAJA: Distribuidora',
  }, entryCompra.entryHash);

  const entryVenta = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'ACEITE-850', name: 'Aceite 850ml' },
    sku: 'ACEITE-850',
    cantidad: -2,
    quantity: -2,
    saldoAnterior: 10,
    saldoResultante: 8,
    stockAfter: 8,
    amount: 80.0,
    amountCents: 8000,
    usuario: 'Cajero 1',
    referencia: 'Ticket T-01',
  }, entryPagoTesoreria.entryHash);

  const history = [entryVenta, entryPagoTesoreria, entryCompra];

  // 1. Cadena criptográfica SHA-256 intacta
  const chainCheck = verifyKardexChain(history, 'newest-first');
  assert.equal(chainCheck.valid, true);

  // 2. Continuidad de producto para ACEITE-850 válida a pesar de la presencia de PAGO_PROVEEDOR
  const continuity = verifyProductContinuity('ACEITE-850', history, 8, 'newest-first');
  assert.equal(continuity.valid, true);

  // 3. Stock físico ignorando tesorería pura
  const physicalStock = computePhysicalStockFromKardex('ACEITE-850', history, 'newest-first');
  assert.equal(physicalStock, 8);

  const tesoreriaStock = computePhysicalStockFromKardex('TESORERIA', history);
  assert.equal(tesoreriaStock, 0);

  // 4. CPP (Costo Promedio Ponderado)
  const cpp = computeWeightedAverageCostFromKardex('ACEITE-850', history);
  assert.equal(cpp, 35.0);

  // 5. Valuación total del inventario: 8 piezas a $35.00 = $280.00
  const valuation = computeKardexInventoryValuation([
    { sku: 'ACEITE-850', cost: 35.0, stock: 8 },
    { sku: 'TESORERIA', cost: 1500.0, stock: 0 },
  ], history);
  assert.equal(valuation.totalPhysicalUnits, 8);
  assert.equal(valuation.totalValuationCents, 28000);
  assert.equal(valuation.totalValuation, 280.0);
});

test('Kardex (F2 Seguimiento): verifyProductContinuity y verifyKardexChain siguen válidos tras PAGO_PROVEEDOR y tras ABONO_FIADO', () => {
  const products = [
    { sku: 'ACEITE-850', name: 'Aceite 850ml', stock: 7 },
    { sku: 'ARROZ-1K', name: 'Arroz 1Kg', stock: 15 },
  ];

  let history: KardexEntry[] = [];
  let prevHash = 'GENESIS';

  function addEntry(data: any): KardexEntry {
    const entry = createKardexEntry(data, prevHash);
    history = [entry, ...history];
    prevHash = entry.entryHash;
    return entry;
  }

  // 1. Inventario inicial de Aceite: 10 pzas
  addEntry({
    type: 'AJUSTE_INICIAL',
    producto: { sku: 'ACEITE-850', name: 'Aceite 850ml' },
    sku: 'ACEITE-850',
    cantidad: 10,
    quantity: 10,
    saldoAnterior: 0,
    saldoResultante: 10,
    stockAfter: 10,
    usuario: 'Don Lupe',
    referencia: 'Apertura',
  });

  // 2. Inventario inicial de Arroz: 15 pzas
  addEntry({
    type: 'AJUSTE_INICIAL',
    producto: { sku: 'ARROZ-1K', name: 'Arroz 1Kg' },
    sku: 'ARROZ-1K',
    cantidad: 15,
    quantity: 15,
    saldoAnterior: 0,
    saldoResultante: 15,
    stockAfter: 15,
    usuario: 'Don Lupe',
    referencia: 'Apertura',
  });

  // 3. Venta de 2 Aceites (saldo 10 -> 8)
  addEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'ACEITE-850', name: 'Aceite 850ml' },
    sku: 'ACEITE-850',
    cantidad: -2,
    quantity: -2,
    saldoAnterior: 10,
    saldoResultante: 8,
    stockAfter: 8,
    usuario: 'Cajero',
    referencia: 'Ticket 101',
  });

  // 4. PAGO_PROVEEDOR (Tesorería pura: cantidad 0, saldo 0, importe $450)
  addEntry({
    type: 'PAGO_PROVEEDOR',
    producto: { sku: 'TESORERIA', name: 'Tesorería - Pago a Lala' },
    sku: 'TESORERIA',
    cantidad: 0,
    quantity: 0,
    saldoAnterior: 0,
    saldoResultante: 0,
    stockAfter: 0,
    amount: 450.0,
    amountCents: 45000,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Pago CxP CAJA: Lala',
  });

  // 5. ABONO_FIADO (Abono de fiado en efectivo: cliente 'CLI-01', cantidad 0, importe $200)
  addEntry({
    type: 'ABONO_FIADO',
    producto: { sku: 'CLI-01', name: 'Doña Carmen Gómez' },
    sku: 'CLI-01',
    cantidad: 0,
    quantity: 0,
    saldoAnterior: 350.0,
    saldoResultante: 150.0,
    stockAfter: 150.0,
    amount: 200.0,
    amountCents: 20000,
    usuario: 'Cajero',
    referencia: 'Abono cliente',
  });

  // 6. Venta de 1 Aceite adicional (saldo 8 -> 7)
  addEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'ACEITE-850', name: 'Aceite 850ml' },
    sku: 'ACEITE-850',
    cantidad: -1,
    quantity: -1,
    saldoAnterior: 8,
    saldoResultante: 7,
    stockAfter: 7,
    usuario: 'Cajero',
    referencia: 'Ticket 102',
  });

  // 7. Otro PAGO_PROVEEDOR desde Fondo Externo
  addEntry({
    type: 'PAGO_PROVEEDOR',
    producto: { sku: 'TESORERIA', name: 'Tesorería - Pago a Bimbo' },
    sku: 'TESORERIA',
    cantidad: 0,
    quantity: 0,
    saldoAnterior: 0,
    saldoResultante: 0,
    stockAfter: 0,
    amount: 800.0,
    amountCents: 80000,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Pago CxP FONDO_EXTERNO: Bimbo',
  });

  // 8. Otro ABONO_FIADO
  addEntry({
    type: 'ABONO_FIADO',
    producto: { sku: 'CLI-02', name: 'Don Ramón' },
    sku: 'CLI-02',
    cantidad: 0,
    quantity: 0,
    saldoAnterior: 500.0,
    saldoResultante: 300.0,
    stockAfter: 300.0,
    amount: 200.0,
    amountCents: 20000,
    usuario: 'Cajero',
    referencia: 'Abono cliente',
  });

  // Verificaciones críticas de integridad criptográfica y continuidad:
  // A. Cadena completa SHA-256 válida
  const chainCheck = verifyKardexChain(history, 'newest-first');
  assert.equal(chainCheck.valid, true, `Cadena rota: ${chainCheck.error}`);

  // B. Continuidad de productos físicos (ACEITE-850 con stock 7 y ARROZ-1K con stock 15)
  const continuityCheck = verifyProductContinuity(products, history, 'newest-first');
  assert.equal(continuityCheck.valid, true, `Continuidad falló: ${continuityCheck.error}`);
  assert.deepEqual(continuityCheck.affectedSkus, []);

  // C. Verificación individual
  assert.equal(verifyProductContinuity('ACEITE-850', history, 7, 'newest-first').valid, true);
  assert.equal(verifyProductContinuity('ARROZ-1K', history, 15, 'newest-first').valid, true);
});
