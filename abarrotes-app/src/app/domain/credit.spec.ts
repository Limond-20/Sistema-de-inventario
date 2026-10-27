import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCreditStatus,
  applyCreditPaymentPure,
  applyCreditSalePure,
  allocatePaymentToDebts,
  type CreditCustomerLike,
  type CreditDebtItem,
} from './credit.ts';

const HOY = new Date('2026-10-25T12:00:00Z');

test('Fiado: Asignación de abonos amortiza primero lo vencido (más antiguo primero) y luego lo vigente', () => {
  // Partidas de adeudo del cliente:
  // Partida 1: Venció hace 15 días (2026-10-10) por $120 (más antigua vencida)
  // Partida 2: Venció hace 5 días (2026-10-20) por $180 (segunda vencida)
  // Partida 3: Vigente, vence el 2026-10-30 por $200 (vigente)
  // Total vencido: $300. Total vigente: $200. Total deuda: $500.
  const partidas: CreditDebtItem[] = [
    {
      id: 'D-01',
      date: '2026-10-01',
      dueDate: '2026-10-10',
      originalAmount: 120,
      remainingBalance: 120,
      description: 'Compra abarrotes quincena 1',
    },
    {
      id: 'D-02',
      date: '2026-10-10',
      dueDate: '2026-10-20',
      originalAmount: 180,
      remainingBalance: 180,
      description: 'Lácteos y pan semana 2',
    },
    {
      id: 'D-03',
      date: '2026-10-22',
      dueDate: '2026-10-30',
      originalAmount: 200,
      remainingBalance: 200,
      description: 'Despensa fin de semana',
    },
  ];

  // Caso A: Abono de $200 (cubre los $120 de D-01 y $80 de D-02; D-02 queda con $100 vencidos)
  const resA = allocatePaymentToDebts(partidas, 200, HOY);
  assert.equal(resA.totalApplied, 200);
  assert.equal(resA.updatedDebts.find((d) => d.id === 'D-01')?.remainingBalance, 0);
  assert.equal(resA.updatedDebts.find((d) => d.id === 'D-02')?.remainingBalance, 100);
  assert.equal(resA.updatedDebts.find((d) => d.id === 'D-03')?.remainingBalance, 200);
  assert.equal(resA.remainingOverdueBalance, 100);
  assert.equal(resA.remainingCurrentBalance, 200);
  assert.equal(resA.totalRemainingBalance, 300);
});

test('Fiado: Caso "abono cubre lo vencido pero queda saldo vigente"', () => {
  // Límite de crédito: $500.
  // Partida vencida: $300 (venció 2026-10-15)
  // Partida vigente: $150 (vence 2026-10-30)
  // Total deuda antes: $450 (estatus VENCIDO)
  const cliente: CreditCustomerLike = {
    id: 'CLI-TEST',
    name: 'Vecino Prueba',
    creditLimit: 500,
    currentBalance: 450,
    dueDate: '2026-10-15',
    status: 'VENCIDO',
    debts: [
      {
        id: 'D-VENCIDA',
        date: '2026-10-05',
        dueDate: '2026-10-15',
        originalAmount: 300,
        remainingBalance: 300,
      },
      {
        id: 'D-VIGENTE',
        date: '2026-10-22',
        dueDate: '2026-10-30',
        originalAmount: 150,
        remainingBalance: 150,
      },
    ],
  };

  assert.equal(computeCreditStatus(cliente, HOY), 'VENCIDO');

  // El cliente realiza un abono de $320:
  // - Cubre al 100% los $300 vencidos.
  // - Los $20 restantes amortizan la partida vigente, quedando $130 de saldo vigente.
  const resultado = applyCreditPaymentPure(cliente, 320, HOY);

  assert.equal(resultado.appliedAmount, 320);
  assert.equal(resultado.updatedCustomer.currentBalance, 130);
  assert.equal(resultado.updatedCustomer.overdueBalance, 0, 'No debe quedar saldo vencido');
  assert.equal(resultado.updatedCustomer.dueDate, '2026-10-30', 'La fecha representativa ahora es la vigente');

  // REGLA CRÍTICA VERIFICADA:
  // Ya no queda saldo vencido. El ratio es $130 / $500 = 26% (< 90%).
  // El estatus debe transicionar de VENCIDO a AL_CORRIENTE.
  assert.equal(
    resultado.updatedCustomer.status,
    'AL_CORRIENTE',
    'Al cubrir lo vencido, debe pasar a AL_CORRIENTE si el saldo vigente es menor al 90%'
  );
  assert.equal(computeCreditStatus(resultado.updatedCustomer, HOY), 'AL_CORRIENTE');
});

test('Fiado: Caso "abono cubre lo vencido pero saldo vigente restante es >= 90% del límite"', () => {
  // Límite $500. Vencido: $50. Vigente: $460. Total: $510 (VENCIDO).
  // Abona $50 exactos -> liquida lo vencido, pero queda saldo vigente de $460 ($460/$500 = 92% >= 90%).
  const cliente: CreditCustomerLike = {
    creditLimit: 500,
    currentBalance: 510,
    debts: [
      { id: 'D1', date: '2026-10-01', dueDate: '2026-10-15', originalAmount: 50, remainingBalance: 50 },
      { id: 'D2', date: '2026-10-23', dueDate: '2026-10-30', originalAmount: 460, remainingBalance: 460 },
    ],
  };

  const resultado = applyCreditPaymentPure(cliente, 50, HOY);
  assert.equal(resultado.updatedCustomer.currentBalance, 460);
  assert.equal(resultado.updatedCustomer.overdueBalance, 0);
  assert.equal(
    resultado.updatedCustomer.status,
    'LIMITE_ALCANZADO',
    'Al cubrir lo vencido pero tener saldo vigente >= 90%, debe pasar a LIMITE_ALCANZADO'
  );
});

test('Fiado: Abono parcial sobre cliente vencido mantiene VENCIDO si queda saldo vencido', () => {
  const clienteVencido: CreditCustomerLike = {
    id: 'CLI-03',
    name: 'Familia López',
    creditLimit: 500.0,
    currentBalance: 520.0,
    dueDate: '2026-10-15',
    overdueBalance: 520.0,
    status: 'VENCIDO',
  };

  const resultado = applyCreditPaymentPure(clienteVencido, 200, HOY);
  assert.equal(resultado.appliedAmount, 200);
  assert.equal(resultado.updatedCustomer.currentBalance, 320.0);
  assert.equal(resultado.updatedCustomer.status, 'VENCIDO');
  assert.equal(computeCreditStatus(resultado.updatedCustomer, HOY), 'VENCIDO');
});

test('Fiado: Liquidación total de deuda limpia el estatus vencido a AL_CORRIENTE', () => {
  const clienteVencido: CreditCustomerLike = {
    creditLimit: 500.0,
    currentBalance: 520.0,
    dueDate: '2026-10-15',
    overdueBalance: 520.0,
    status: 'VENCIDO',
  };

  const resultado = applyCreditPaymentPure(clienteVencido, 520, HOY);
  assert.equal(resultado.updatedCustomer.currentBalance, 0);
  assert.equal(resultado.updatedCustomer.status, 'AL_CORRIENTE');
});

test('Fiado: applyCreditSalePure bloquea fiado si cliente está vencido o excede límite', () => {
  const clienteVencido: CreditCustomerLike = {
    id: 'CLI-03',
    creditLimit: 500.0,
    currentBalance: 320.0,
    dueDate: '2026-10-15',
    overdueBalance: 320.0,
    status: 'VENCIDO',
  };

  const ventaBloqueada = applyCreditSalePure(clienteVencido, 50, HOY);
  assert.equal(ventaBloqueada.ok, false);
  assert.match(ventaBloqueada.message, /Crédito bloqueado/);
});
