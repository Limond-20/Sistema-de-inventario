import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKardexId,
  createKardexEntry,
  appendKardexEntry,
  deductStock,
  type StockItemLike,
  type KardexEntry,
} from './kardex.ts';

test('IDs de Kardex únicos en 1,000 movimientos', () => {
  const ids = new Set<string>();
  const total = 1000;

  for (let i = 0; i < total; i++) {
    const id = generateKardexId();
    assert.ok(id && id.length > 5, 'El ID debe tener formato válido');
    ids.add(id);
  }

  assert.equal(ids.size, total, `Se debieron generar ${total} IDs estrictamente únicos`);
});

test('Venta sin existencias genera FALTANTE_SISTEMA y stock negativo', () => {
  // Producto con solo 1 pieza en inventario
  const producto: StockItemLike = {
    sku: 'LECHE-LALA-1L',
    name: 'Leche Lala Entera 1L',
    stock: 1,
    saleUnit: 'Pieza',
  };

  // Se venden 3 piezas (faltan 2)
  const resultado = deductStock(producto, 3, {
    saleType: 'VENTA_EFECTIVO',
    usuario: 'Cajero Mostrador',
    referencia: 'Ticket #0045',
    amount: 72.0,
  });

  // 1. El stock debe quedar en negativo exacto (-2), nunca enmascarado con Math.max(0, ...)
  assert.equal(
    resultado.updatedProduct.stock,
    -2,
    'El stock debe quedar en -2 (no ocultar la diferencia a 0)'
  );

  // 2. Debe generar 2 entradas de Kardex: la venta y el movimiento FALTANTE_SISTEMA
  assert.equal(resultado.kardexEntries.length, 2);

  const entradaVenta = resultado.kardexEntries.find((e) => e.type === 'VENTA_EFECTIVO');
  assert.ok(entradaVenta, 'Debe registrar la venta en Kardex');
  assert.equal(entradaVenta.saldoAnterior, 1);
  assert.equal(entradaVenta.saldoResultante, -2);
  assert.equal(entradaVenta.cantidad, -3);

  const entradaFaltante = resultado.kardexEntries.find((e) => e.type === 'FALTANTE_SISTEMA');
  assert.ok(entradaFaltante, 'Debe registrar el movimiento FALTANTE_SISTEMA en Kardex');
  assert.equal(entradaFaltante.saldoResultante, -2);
  assert.match(entradaFaltante.referencia, /Faltante por venta sin existencia/);

  // 3. Debe generar alerta visible en el tablero
  assert.ok(resultado.shortageAlert, 'Debe generar una alerta visible en el tablero');
  assert.equal(resultado.shortageAlert.sku, 'LECHE-LALA-1L');
  assert.equal(resultado.shortageAlert.negativeStock, -2);
  assert.match(resultado.shortageAlert.title, /Stock en negativo/);
});

test('Venta con existencias normales no genera FALTANTE_SISTEMA', () => {
  const producto: StockItemLike = {
    sku: 'HUE-BLA-1K',
    name: 'Huevo Blanco 1kg',
    stock: 10,
    saleUnit: 'Kg',
  };

  const resultado = deductStock(producto, 2, {
    saleType: 'VENTA_FIADO',
    usuario: 'Don Lupe',
    referencia: 'Libreta Fiado #12',
    amount: 90.0,
  });

  assert.equal(resultado.updatedProduct.stock, 8);
  assert.equal(resultado.kardexEntries.length, 1);
  assert.equal(resultado.kardexEntries[0].type, 'VENTA_FIADO');
  assert.equal(resultado.shortageAlert, undefined);
});

test('Kardex completo y append-only', () => {
  const historial: KardexEntry[] = [];
  const entrada1 = createKardexEntry({
    type: 'ENTRADA_COMPRA',
    producto: { sku: 'PAN-BIM-BLA', name: 'Pan Bimbo' },
    cantidad: 10,
    saldoAnterior: 0,
    saldoResultante: 10,
    usuario: 'Don Lupe',
    referencia: 'Nota #1234',
  });

  const actualizado = appendKardexEntry(historial, entrada1);
  assert.equal(actualizado.length, 1);
  assert.equal(actualizado[0].id, entrada1.id);
  assert.ok(
    /^\d{4}-\d{2}-\d{2}T/.test(actualizado[0].timestamp),
    'El timestamp debe estar en formato ISO'
  );
  assert.notEqual(actualizado, historial, 'Debe preservar inmutabilidad');
});
