import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents,
  fromCents,
  sumMoney,
  subtractMoney,
  multiplyMoney,
  formatMxn,
  calculateTax,
} from './money.ts';

test('Dinero en centavos: 0.1 + 0.2 en centavos no sufre de imprecisión flotante', () => {
  // En JavaScript puro con flotantes: 0.1 + 0.2 === 0.30000000000000004 !== 0.3
  assert.notEqual(0.1 + 0.2, 0.3, 'Verificación del fallo clásico de punto flotante en JS');

  // Con toCents:
  const centavosA = toCents(0.1); // 10 centavos
  const centavosB = toCents(0.2); // 20 centavos
  const sumaCentavos = centavosA + centavosB;

  assert.equal(centavosA, 10, '0.1 peso son exactamente 10 centavos');
  assert.equal(centavosB, 20, '0.2 pesos son exactamente 20 centavos');
  assert.equal(sumaCentavos, 30, 'La suma debe ser exactamente 30 centavos');
  assert.equal(fromCents(sumaCentavos), 0.3, '30 centavos deben ser exactamente 0.3 pesos');
  assert.equal(sumMoney([0.1, 0.2]), 0.3, 'sumMoney([0.1, 0.2]) debe ser 0.3 exacto');
});

test('fromCents y toCents conversiones y valores borde', () => {
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents(0.99), 99);
  assert.equal(toCents(0), 0);
  assert.equal(toCents(NaN), 0);

  assert.equal(fromCents(1250), 12.5);
  assert.equal(fromCents(99), 0.99);
  assert.equal(fromCents(0), 0);
  assert.equal(fromCents(NaN), 0);
});

test('Resta y multiplicación monetaria sin residuos decimales', () => {
  // Cambio de $100 con total de $73.30
  const cambio = subtractMoney(100, 73.3);
  assert.equal(cambio, 26.7);

  // 3 piezas de $19.99
  const subtotal = multiplyMoney(19.99, 3);
  assert.equal(subtotal, 59.97);

  // Cantidad fraccional (granel): 0.350 kg a $85.00/kg
  const frijolGranel = multiplyMoney(85.0, 0.35);
  assert.equal(frijolGranel, 29.75);
});

test('Cálculo de impuestos IVA e IEPS con modos de redondeo', () => {
  // IVA 16% sobre $100.00 -> $16.00
  const iva = calculateTax(100, 0.16);
  assert.equal(iva, 16);

  // IEPS 8% sobre $25.50 (204 centavos de impuesto)
  const ieps = calculateTax(25.5, 0.08);
  assert.equal(ieps, 2.04);

  // Modos de redondeo en centavos
  // 125 centavos * 0.16 = 20.0
  assert.equal(calculateTax(1.25, 0.16, false, 'round'), 0.2);
  // 129 centavos * 0.16 = 20.64 -> round: 21, floor: 20, ceil: 21
  assert.equal(calculateTax(1.29, 0.16, false, 'round'), 0.21);
  assert.equal(calculateTax(1.29, 0.16, false, 'floor'), 0.2);
  assert.equal(calculateTax(1.29, 0.16, false, 'ceil'), 0.21);
});

test('Formato MXN de montos', () => {
  const formateado = formatMxn(1250.5);
  // Normalizar espacios no separables si los genera Intl en es-MX
  const normalizado = formateado.replace(/\u00a0/g, ' ');
  assert.ok(normalizado.includes('$1,250.50') || normalizado.includes('1,250.50'));
});
