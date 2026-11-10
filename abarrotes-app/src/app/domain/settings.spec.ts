import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUSINESS_SETTINGS,
  validateBusinessSettings,
  type BusinessSettings,
} from './settings.ts';

test('Ajustes (Bloque G): Valores por defecto de configuración del negocio', () => {
  assert.equal(typeof DEFAULT_BUSINESS_SETTINGS.storeName, 'string');
  assert.ok(DEFAULT_BUSINESS_SETTINGS.storeName.length >= 2);
  assert.notEqual(DEFAULT_BUSINESS_SETTINGS.storeName, 'Abarrotes Doña Lupe'); // Ya no valor fijo
  assert.equal(DEFAULT_BUSINESS_SETTINGS.initialCashFloat, 1000.0);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.initialCashFloatCents, 100000);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.marginThresholdPct, 20.0);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.defaultIvaPct, 16.0);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.defaultIepsPct, 0.0);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.inactivityTimeoutMinutes, 5);
  assert.equal(DEFAULT_BUSINESS_SETTINGS.maxDiscountPctWithoutPin, 10.0);
});

test('Ajustes (Bloque G): Validación y sanitización de parámetros', () => {
  // 1. Nombre demasiado corto
  const invalidName = validateBusinessSettings({ storeName: 'A' });
  assert.equal(invalidName.valid, false);
  assert.ok(invalidName.errors.some((e) => e.includes('al menos 2 caracteres')));

  // 2. Valores fuera de rango o negativos se sanitizan
  const sanitized = validateBusinessSettings({
    storeName: '  Super Abarrotes San Miguel  ',
    initialCashFloat: -500, // No puede ser negativo
    marginThresholdPct: 150, // Se acota a 100
    defaultIvaPct: 16,
    defaultIepsPct: 8,
    inactivityTimeoutMinutes: 0, // Se acota a mínimo 1 min
    maxDiscountPctWithoutPin: 15,
  });

  assert.equal(sanitized.valid, true);
  assert.equal(sanitized.sanitized.storeName, 'Super Abarrotes San Miguel');
  assert.equal(sanitized.sanitized.initialCashFloat, 0);
  assert.equal(sanitized.sanitized.initialCashFloatCents, 0);
  assert.equal(sanitized.sanitized.marginThresholdPct, 100);
  assert.equal(sanitized.sanitized.defaultIvaPct, 16);
  assert.equal(sanitized.sanitized.defaultIepsPct, 8);
  assert.equal(sanitized.sanitized.inactivityTimeoutMinutes, 1);
  assert.equal(sanitized.sanitized.maxDiscountPctWithoutPin, 15);
  assert.ok(sanitized.sanitized.updatedAt);
});
