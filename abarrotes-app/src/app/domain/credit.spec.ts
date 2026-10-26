import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCreditStatus,
  applyCreditPaymentPure,
  applyCreditSalePure,
  type CreditCustomerLike,
} from './credit.ts';

const HOY = new Date('2026-10-25T12:00:00Z');

test('Abono parcial sobre cliente vencido mantiene VENCIDO si queda saldo vencido', () => {
  // Cliente Familia López tiene deuda de $520 sobre límite de $500 y venció el 15 de octubre (hoy es 25 de octubre)
  const clienteVencido: CreditCustomerLike = {
    id: 'CLI-03',
    name: 'Familia López',
    creditLimit: 500.0,
    currentBalance: 520.0,
    dueDate: '2026-10-15',
    status: 'VENCIDO',
  };

  // Verificamos estado inicial antes del abono
  const statusInicial = computeCreditStatus(clienteVencido, HOY);
  assert.equal(statusInicial, 'VENCIDO', 'El cliente debe estar VENCIDO inicialmente');

  // Realiza un abono parcial de $200 (queda saldo de $320, que sigue con fecha vencida de 2026-10-15)
  const resultado = applyCreditPaymentPure(clienteVencido, 200, HOY);

  assert.equal(resultado.appliedAmount, 200);
  assert.equal(resultado.updatedCustomer.currentBalance, 320.0);
  // Regla crítica: El abono NO debe limpiar el estatus VENCIDO si queda saldo con fecha vencida
  assert.equal(
    resultado.updatedCustomer.status,
    'VENCIDO',
    'El estatus debe seguir siendo VENCIDO porque aún queda saldo con fecha vencida'
  );
  assert.equal(
    computeCreditStatus(resultado.updatedCustomer, HOY),
    'VENCIDO',
    'computeCreditStatus debe retornar VENCIDO mientras quede saldo vencido'
  );
});

test('Liquidación total de deuda limpia el estatus vencido a AL_CORRIENTE', () => {
  const clienteVencido: CreditCustomerLike = {
    id: 'CLI-03',
    name: 'Familia López',
    creditLimit: 500.0,
    currentBalance: 520.0,
    dueDate: '2026-10-15',
    status: 'VENCIDO',
  };

  // Paga la totalidad ($520)
  const resultado = applyCreditPaymentPure(clienteVencido, 520, HOY);
  assert.equal(resultado.updatedCustomer.currentBalance, 0);
  assert.equal(resultado.updatedCustomer.status, 'AL_CORRIENTE');
  assert.equal(computeCreditStatus(resultado.updatedCustomer, HOY), 'AL_CORRIENTE');
});

test('computeCreditStatus evalúa LIMITE_ALCANZADO cuando saldo/límite >= 0.9 y fecha no vencida', () => {
  // Límite $1,000, fecha futura 2026-10-30
  // Caso 1: Saldo $899 (89.9%) -> AL_CORRIENTE
  const c1: CreditCustomerLike = {
    creditLimit: 1000,
    currentBalance: 899,
    dueDate: '2026-10-30',
  };
  assert.equal(computeCreditStatus(c1, HOY), 'AL_CORRIENTE');

  // Caso 2: Saldo $900 (90%) -> LIMITE_ALCANZADO
  const c2: CreditCustomerLike = {
    creditLimit: 1000,
    currentBalance: 900,
    dueDate: '2026-10-30',
  };
  assert.equal(computeCreditStatus(c2, HOY), 'LIMITE_ALCANZADO');

  // Caso 3: Saldo $980 (98%) -> LIMITE_ALCANZADO
  const c3: CreditCustomerLike = {
    creditLimit: 1000,
    currentBalance: 980,
    dueDate: '2026-10-30',
  };
  assert.equal(computeCreditStatus(c3, HOY), 'LIMITE_ALCANZADO');
});

test('applyCreditSalePure bloquea fiado si cliente está vencido o excede límite', () => {
  const clienteVencido: CreditCustomerLike = {
    id: 'CLI-03',
    name: 'Familia López',
    creditLimit: 500.0,
    currentBalance: 320.0,
    dueDate: '2026-10-15',
    status: 'VENCIDO',
  };

  const ventaBloqueada = applyCreditSalePure(clienteVencido, 50, HOY);
  assert.equal(ventaBloqueada.ok, false);
  assert.match(ventaBloqueada.message, /Crédito bloqueado/);

  // Cliente al corriente pero excede límite
  const clienteCasiLleno: CreditCustomerLike = {
    id: 'CLI-01',
    name: 'Doña Carmen',
    creditLimit: 500.0,
    currentBalance: 480.0,
    dueDate: '2026-10-30',
    status: 'LIMITE_ALCANZADO',
  };
  const ventaExcedida = applyCreditSalePure(clienteCasiLleno, 30, HOY);
  assert.equal(ventaExcedida.ok, false);
  assert.match(ventaExcedida.message, /Límite de crédito excedido/);

  // Cliente al corriente con margen disponible
  const ventaExitosa = applyCreditSalePure(clienteCasiLleno, 15, HOY);
  assert.equal(ventaExitosa.ok, true);
  assert.equal(ventaExitosa.updatedCustomer?.currentBalance, 495.0);
  assert.equal(ventaExitosa.updatedCustomer?.status, 'LIMITE_ALCANZADO');
});
