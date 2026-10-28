import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents,
  fromCents,
  parseMoneyToCents,
  parseMoney,
  sumMoney,
  subtractMoney,
  multiplyMoney,
  formatMxn,
  calculateTax,
  calculateCartTaxes,
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

test('parseMoneyToCents y parseMoney manejan cadenas, símbolos monetarios y redondeo de centavos', () => {
  assert.equal(parseMoneyToCents('$1,250.50'), 125050);
  assert.equal(parseMoney('$1,250.50'), 1250.5);

  assert.equal(parseMoneyToCents(' 87.50 '), 8750);
  assert.equal(parseMoney(' 87.50 '), 87.5);

  assert.equal(parseMoneyToCents('10.335'), 1034); // Mitad hacia arriba
  assert.equal(parseMoneyToCents('10.334'), 1033);

  assert.equal(parseMoneyToCents('-$45.20'), -4520);
  assert.equal(parseMoney('-$45.20'), -45.2);

  // Valores vacíos o inválidos
  assert.equal(parseMoneyToCents(''), 0);
  assert.equal(parseMoneyToCents(null), 0);
  assert.equal(parseMoneyToCents(undefined), 0);
  assert.equal(parseMoneyToCents('abc'), 0);

  // Valor numérico directo
  assert.equal(parseMoneyToCents(12.5), 1250);
  assert.equal(parseMoney(12.5), 12.5);
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

test('Venta a granel exacta: 0.350 kg x $87.50 a nivel centavos', () => {
  const precioKilo = 87.50;
  const peso = 0.350;

  // 87.50 pesos = 8750 centavos
  const centavosKilo = toCents(precioKilo);
  assert.equal(centavosKilo, 8750);

  // 8750 * 0.350 = 3062.5 centavos -> Math.round -> 3063 centavos ($30.63)
  const total = multiplyMoney(precioKilo, peso);
  assert.equal(total, 30.63);
  assert.equal(toCents(total), 3063);

  // Verificamos que formateado da $30.63
  const formateado = formatMxn(total).replace(/\u00a0/g, ' ');
  assert.ok(formateado.includes('30.63'));
});

test('IVA por línea contra el IVA sobre el total (auditoría de discrepancia de centavos)', () => {
  // Tres partidas que generan fracciones de centavos en IVA al 16%:
  // Línea 1: 1 x $10.33 -> 1033 centavos. IVA 16% = 165.28 -> 165 centavos ($1.65)
  // Línea 2: 1 x $10.33 -> 1033 centavos. IVA 16% = 165.28 -> 165 centavos ($1.65)
  // Línea 3: 1 x $10.33 -> 1033 centavos. IVA 16% = 165.28 -> 165 centavos ($1.65)
  // Suma IVA por línea: 165 + 165 + 165 = 495 centavos ($4.95)
  // Base total: 3 x 1033 = 3099 centavos ($30.99)
  // IVA sobre base total: 3099 * 0.16 = 495.84 -> 496 centavos ($4.96)
  // Discrepancia: exactamente 1 centavo
  const items = [
    { price: 10.33, qty: 1, taxRate: 0.16 },
    { price: 10.33, qty: 1, taxRate: 0.16 },
    { price: 10.33, qty: 1, taxRate: 0.16 },
  ];

  const resultado = calculateCartTaxes(items);

  assert.equal(resultado.totalSubtotal, 30.99);
  assert.deepEqual(resultado.lineTaxes, [1.65, 1.65, 1.65]);
  assert.equal(resultado.totalTaxByLineSum, 4.95);
  assert.equal(resultado.taxOnTotalBase, 4.96);
  assert.equal(resultado.roundingDifferenceCents, 1);
});
