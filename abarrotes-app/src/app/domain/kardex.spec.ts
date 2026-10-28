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
