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
  type StockItemLike,
  type KardexEntry,
} from './kardex.ts';

test('Kardex: IDs de Kardex únicos en 1,000 movimientos', () => {
  const ids = new Set<string>();
  const total = 1000;
  for (let i = 0; i < total; i++) {
    const id = generateKardexId();
    assert.ok(id && id.length > 5);
    ids.add(id);
  }
  assert.equal(ids.size, total, `Se debieron generar ${total} IDs estrictamente únicos`);
});

test('Kardex: Hash encadenado y verifyKardexChain detecta una entrada alterada', () => {
  // Construimos una cadena de 4 movimientos
  const e1 = createKardexEntry({
    type: 'ENTRADA_COMPRA',
    producto: { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli' },
    cantidad: 10,
    saldoAnterior: 0,
    saldoResultante: 10,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Nota #101',
  }, 'GENESIS');

  const e2 = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli' },
    cantidad: -2,
    saldoAnterior: 10,
    saldoResultante: 8,
    usuario: 'Cajero Matutino (Ana)',
    referencia: 'Ticket #001',
  }, e1.entryHash);

  const e3 = createKardexEntry({
    type: 'VENTA_FIADO',
    producto: { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli' },
    cantidad: -1,
    saldoAnterior: 8,
    saldoResultante: 7,
    usuario: 'Cajero Matutino (Ana)',
    referencia: 'Libreta Fiado Doña Carmen',
  }, e2.entryHash);

  // Orden cronológico inverso (el más reciente primero, como en el array del servicio)
  const cadenaValida: KardexEntry[] = [e3, e2, e1];

  const resultadoValido = verifyKardexChain(cadenaValida, 'newest-first');
  assert.equal(resultadoValido.valid, true, 'La cadena no alterada debe ser 100% válida');

  // CASO DE ALTERACIÓN MALICIOSA: Modificamos la cantidad o el usuario de e2
  const e2Alterada: KardexEntry = {
    ...e2,
    cantidad: -1, // Se intenta ocultar una venta de 2 a 1
    saldoResultante: 9,
  };
  const cadenaAlterada: KardexEntry[] = [e3, e2Alterada, e1];

  const resultadoInvalido = verifyKardexChain(cadenaAlterada, 'newest-first');
  assert.equal(resultadoInvalido.valid, false, 'verifyKardexChain debe detectar la alteración');
  assert.equal(resultadoInvalido.tamperedEntryId, e2.id);
  assert.match(resultadoInvalido.error || '', /alterada/i);
});

test('Kardex: Prueba de continuidad: saldoResultante[i] == saldoAnterior[i+1] y stock actual == último saldoResultante', () => {
  const sku = 'LECHE-LALA-1L';
  let prevHash = 'GENESIS';

  // Paso 0: Entrada inicial (stock inicial: 0 -> 12)
  const mov1 = createKardexEntry({
    type: 'ENTRADA_COMPRA',
    producto: { sku, name: 'Leche Lala 1L' },
    cantidad: 12,
    saldoAnterior: 0,
    saldoResultante: 12,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Nota Lala #554',
  }, prevHash);
  prevHash = mov1.entryHash;

  // Paso 1: Venta efectivo (12 -> 8)
  const mov2 = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku, name: 'Leche Lala 1L' },
    cantidad: -4,
    saldoAnterior: 12,
    saldoResultante: 8,
    usuario: 'Cajero Vespertino (Pedro)',
    referencia: 'Ticket #020',
  }, prevHash);
  prevHash = mov2.entryHash;

  // Paso 2: Merma autorizada (8 -> 6)
  const mov3 = createKardexEntry({
    type: 'BAJA_MERMA',
    producto: { sku, name: 'Leche Lala 1L' },
    cantidad: -2,
    saldoAnterior: 8,
    saldoResultante: 6,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Envase roto',
  }, prevHash);
  prevHash = mov3.entryHash;

  // Paso 3: Consumo interno (6 -> 5)
  const mov4 = createKardexEntry({
    type: 'CONSUMO_INTERNO',
    producto: { sku, name: 'Leche Lala 1L' },
    cantidad: -1,
    saldoAnterior: 6,
    saldoResultante: 5,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Comida personal',
  }, prevHash);

  const historialNewestFirst = [mov4, mov3, mov2, mov1];
  const stockActual = 5;

  const continuidadValida = verifyProductContinuity(sku, historialNewestFirst, stockActual, 'newest-first');
  assert.equal(continuidadValida.valid, true, 'La continuidad debe cumplirse a lo largo de todo el ciclo de vida');

  // Si el stock actual no coincide con el último saldoResultante
  const continuidadDiscrepante = verifyProductContinuity(sku, historialNewestFirst, 4, 'newest-first');
  assert.equal(continuidadDiscrepante.valid, false);
  assert.match(continuidadDiscrepante.error || '', /Discontinuidad final/);
});

test('Mermas y consumo interno: no permitir baja mayor que la existencia a menos que se autorice con PIN y motivo', () => {
  const producto: StockItemLike = {
    sku: 'PAN-BIM-BLA',
    name: 'Pan Bimbo Blanco',
    stock: 2,
    saleUnit: 'Pieza',
  };

  // Intento 1: Dar de baja 5 piezas sin PIN
  const bajaBloqueada = deductStockForDisposal({
    product: producto,
    qtyToDeduct: 5,
    type: 'BAJA_MERMA',
    usuario: 'Cajero (Pedro)',
    referencia: 'Rotura en piso',
  });

  assert.equal(bajaBloqueada.ok, false);
  assert.equal(bajaBloqueada.requiresPin, true);
  assert.match(bajaBloqueada.message, /supera la existencia disponible/);

  // Intento 2: Con PIN pero sin motivo
  const bajaSinMotivo = deductStockForDisposal({
    product: producto,
    qtyToDeduct: 5,
    type: 'BAJA_MERMA',
    usuario: 'Cajero (Pedro)',
    referencia: 'Rotura en piso',
    adminPinAuthorized: true,
    overrideReason: '',
  });
  assert.equal(bajaSinMotivo.ok, false);
  assert.match(bajaSinMotivo.message, /obligatorio indicar el motivo/);

  // Intento 3: Con PIN y motivo justificado
  const bajaAutorizada = deductStockForDisposal({
    product: producto,
    qtyToDeduct: 5,
    type: 'BAJA_MERMA',
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Rotura en descarga',
    adminPinAuthorized: true,
    overrideReason: 'Caja completa se aplastó en la camioneta del proveedor',
  });

  assert.equal(bajaAutorizada.ok, true);
  assert.equal(bajaAutorizada.updatedProduct?.stock, -3);

  // FALTANTE_SISTEMA registra estrictamente el déficit real (tenía 2, bajó 5 -> déficit real: 3)
  const faltanteEntry = bajaAutorizada.kardexEntries?.find((e) => e.type === 'FALTANTE_SISTEMA');
  assert.ok(faltanteEntry, 'Debe registrar movimiento FALTANTE_SISTEMA');
  assert.equal(faltanteEntry.cantidad, -3, 'El déficit real debe ser exactamente 3 piezas');
});

test('FALTANTE_SISTEMA en ventas registra solo el déficit real que sobrepasó la existencia', () => {
  // Caso 1: Había 2 en existencia y se vendieron 5 -> el déficit real es 3 (no 5)
  const prod1: StockItemLike = {
    sku: 'JAB-ZOT-BLA',
    name: 'Jabón Zote Blanco',
    stock: 2,
    saleUnit: 'Pieza',
  };
  const res1 = deductStock(prod1, 5, {
    saleType: 'VENTA_EFECTIVO',
    usuario: 'Cajero Matutino',
    referencia: 'Ticket #100',
  });

  assert.equal(res1.updatedProduct.stock, -3);
  const faltante1 = res1.kardexEntries.find((e) => e.type === 'FALTANTE_SISTEMA');
  assert.ok(faltante1);
  assert.equal(faltante1.cantidad, -3, 'El déficit real es de 3 piezas');

  // Caso 2: El stock ya estaba en -1 y se venden 2 más -> el déficit real introducido por esta venta es 2
  const prod2: StockItemLike = {
    sku: 'JAB-ZOT-BLA',
    name: 'Jabón Zote Blanco',
    stock: -1,
    saleUnit: 'Pieza',
  };
  const res2 = deductStock(prod2, 2, {
    saleType: 'VENTA_EFECTIVO',
    usuario: 'Cajero Matutino',
    referencia: 'Ticket #101',
  });

  assert.equal(res2.updatedProduct.stock, -3);
  const faltante2 = res2.kardexEntries.find((e) => e.type === 'FALTANTE_SISTEMA');
  assert.ok(faltante2);
  assert.equal(faltante2.cantidad, -2, 'El déficit real de la nueva venta es de 2 piezas completas');
});

test('Resolución de alerta de faltante con ajuste físico autorizado con PIN', () => {
  const prodNegativo: StockItemLike = {
    sku: 'FRI-NEG-50K',
    name: 'Frijol Negro Granel',
    stock: -4.5,
    saleUnit: 'Kg',
  };

  // El encargado cuenta en piso y encuentra 15 kg reales
  const resolucion = resolveShortageAlertAdjustment(
    prodNegativo,
    15,
    'Don Lupe (Encargado)',
    'A-FALTANTE-01'
  );

  assert.equal(resolucion.updatedProduct.stock, 15);
  assert.equal(resolucion.kardexEntry.type, 'AJUSTE_AUDITORIA');
  assert.equal(resolucion.kardexEntry.saldoAnterior, -4.5);
  assert.equal(resolucion.kardexEntry.saldoResultante, 15);
  assert.equal(resolucion.kardexEntry.cantidad, 19.5); // -4.5 a 15 es una subida neta de +19.5
  assert.equal(resolucion.kardexEntry.usuario, 'Don Lupe (Encargado)');
  assert.match(resolucion.kardexEntry.referencia, /A-FALTANTE-01/);
});
