import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCreditStatus,
  applyCreditPaymentPure,
  applyCreditSalePure,
  allocatePaymentToDebts,
  validateCustomerInput,
  canDeactivateCustomer,
  requiresPinForCreditTermsChange,
  searchCreditCustomers,
  calculateCustomerDueDate,
  type CreditCustomerLike,
  type CreditDebtItem,
  type CustomerInput,
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

  // Caso B: Abono de $350 (cubre $120 de D-01, $180 de D-02 = $300 vencido liquidado, y $50 de D-03 vigente)
  const resB = allocatePaymentToDebts(partidas, 350, HOY);
  assert.equal(resB.totalApplied, 350);
  assert.equal(resB.updatedDebts.find((d) => d.id === 'D-01')?.remainingBalance, 0);
  assert.equal(resB.updatedDebts.find((d) => d.id === 'D-02')?.remainingBalance, 0);
  assert.equal(resB.updatedDebts.find((d) => d.id === 'D-03')?.remainingBalance, 150);
  assert.equal(resB.remainingOverdueBalance, 0);
  assert.equal(resB.remainingCurrentBalance, 150);
  assert.equal(resB.totalRemainingBalance, 150);
});

test('Fiado: Caso "abono cubre lo vencido pero queda saldo vigente"', () => {
  // Cliente debe $300 vencidos y $150 vigentes (Total: $450 con límite de $500). Abona $320.
  const cliente: CreditCustomerLike = {
    creditLimit: 500.0,
    currentBalance: 450.0,
    dueDate: '2026-10-10',
    overdueBalance: 300.0,
    status: 'VENCIDO',
    debts: [
      {
        id: 'D-01',
        date: '2026-10-01',
        dueDate: '2026-10-10',
        originalAmount: 300,
        remainingBalance: 300,
      },
      {
        id: 'D-02',
        date: '2026-10-22',
        dueDate: '2026-10-31',
        originalAmount: 150,
        remainingBalance: 150,
      },
    ],
  };

  const resultado = applyCreditPaymentPure(cliente, 320, HOY);
  assert.equal(resultado.appliedAmount, 320);
  assert.equal(resultado.changeOrExcess, 0);

  // 1. Saldo vencido remanente debe ser $0.00
  assert.equal(resultado.updatedCustomer.overdueBalance, 0);
  // 2. Saldo total remanente debe ser $130.00 ($450 - $320)
  assert.equal(resultado.updatedCustomer.currentBalance, 130.0);
  // 3. Estatus debe pasar inmediatamente a 'AL_CORRIENTE' (130 / 500 = 26% < 90%)
  assert.equal(resultado.updatedCustomer.status, 'AL_CORRIENTE');
  assert.equal(computeCreditStatus(resultado.updatedCustomer, HOY), 'AL_CORRIENTE');
});

test('Fiado: Caso "abono cubre lo vencido pero saldo vigente restante es >= 90% del límite"', () => {
  // Límite: $500. Deuda total: $480 ($100 vencidos + $380 vigentes). Abona $100.
  const cliente: CreditCustomerLike = {
    creditLimit: 500.0,
    currentBalance: 480.0,
    dueDate: '2026-10-10',
    overdueBalance: 100.0,
    status: 'VENCIDO',
    debts: [
      {
        id: 'D-01',
        date: '2026-10-01',
        dueDate: '2026-10-10',
        originalAmount: 100,
        remainingBalance: 100,
      },
      {
        id: 'D-02',
        date: '2026-10-22',
        dueDate: '2026-10-31',
        originalAmount: 380,
        remainingBalance: 380,
      },
    ],
  };

  const resultado = applyCreditPaymentPure(cliente, 100, HOY);
  assert.equal(resultado.appliedAmount, 100);
  assert.equal(resultado.updatedCustomer.overdueBalance, 0);
  assert.equal(resultado.updatedCustomer.currentBalance, 380.0);

  // 380 / 500 = 76% (< 90%) -> AL_CORRIENTE
  assert.equal(resultado.updatedCustomer.status, 'AL_CORRIENTE');

  // Ahora si la deuda restante fuera $460 (460 / 500 = 92% >= 90%)
  const clienteAlLimite: CreditCustomerLike = {
    creditLimit: 500.0,
    currentBalance: 560.0,
    dueDate: '2026-10-10',
    overdueBalance: 100.0,
    status: 'VENCIDO',
    debts: [
      {
        id: 'D-01',
        date: '2026-10-01',
        dueDate: '2026-10-10',
        originalAmount: 100,
        remainingBalance: 100,
      },
      {
        id: 'D-02',
        date: '2026-10-22',
        dueDate: '2026-10-31',
        originalAmount: 460,
        remainingBalance: 460,
      },
    ],
  };

  const resAlLimite = applyCreditPaymentPure(clienteAlLimite, 100, HOY);
  assert.equal(resAlLimite.updatedCustomer.currentBalance, 460.0);
  assert.equal(resAlLimite.updatedCustomer.status, 'LIMITE_ALCANZADO');
  assert.equal(computeCreditStatus(resAlLimite.updatedCustomer, HOY), 'LIMITE_ALCANZADO');
});

test('Fiado: Abono parcial sobre cliente vencido mantiene VENCIDO si queda saldo vencido', () => {
  const clienteVencido: CreditCustomerLike = {
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

test('Fiado (F2): Validación de entrada de cliente y cálculo de plazo en días', () => {
  const valid = validateCustomerInput({
    name: 'Doña Rosaura',
    phone: '477-987-6543',
    alias: 'La Comadre',
    creditLimit: 800.0,
    creditDays: 20,
    notes: 'Paga cada quincena puntual',
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.normalized?.name, 'Doña Rosaura');
  assert.equal(valid.normalized?.creditDays, 20);
  assert.equal(valid.normalized?.creditLimit, 800.0);

  const invalidName = validateCustomerInput({
    name: ' ',
    creditLimit: 500.0,
  });
  assert.equal(invalidName.valid, false);
  assert.match(invalidName.error || '', /al menos 2 caracteres/);

  const invalidLimit = validateCustomerInput({
    name: 'Don Pedro',
    creditLimit: -50.0,
  });
  assert.equal(invalidLimit.valid, false);
  assert.match(invalidLimit.error || '', /no puede ser negativo/);

  // Plazo default
  const defaultPlazo = validateCustomerInput({
    name: 'Don Pedro',
    creditLimit: 300.0,
  });
  assert.equal(defaultPlazo.valid, true);
  assert.equal(defaultPlazo.normalized?.creditDays, 15);

  const dueDate = calculateCustomerDueDate('2026-10-01', 15);
  assert.equal(dueDate, '2026-10-16');
});

test('Fiado (F2): Baja lógica bloqueada si tiene saldo pendiente (> 0) y permitida si saldo es 0', () => {
  const debtor: CreditCustomerLike = {
    id: 'CLI-DEBT',
    name: 'Don Rogelio',
    creditLimit: 600.0,
    currentBalance: 150.0,
    isActive: true,
  };

  const deactCheck = canDeactivateCustomer(debtor);
  assert.equal(deactCheck.canDeactivate, false);
  assert.match(deactCheck.reason || '', /saldo pendiente de \$150\.00/);

  const cleanCustomer: CreditCustomerLike = {
    ...debtor,
    currentBalance: 0,
  };
  const deactClean = canDeactivateCustomer(cleanCustomer);
  assert.equal(deactClean.canDeactivate, true);
});

test('Fiado (F2): Modificación de límite de crédito o plazo en días exige PIN', () => {
  const customer: CreditCustomerLike = {
    id: 'CLI-01',
    name: 'Doña Carmen',
    creditLimit: 500.0,
    creditDays: 15,
    currentBalance: 0,
  };

  // Sin cambios de términos (solo nombre o notas): NO pide PIN
  assert.equal(requiresPinForCreditTermsChange(customer, {}), false);
  assert.equal(requiresPinForCreditTermsChange(customer, { creditLimit: 500.0, creditDays: 15 }), false);

  // Cambiar límite de crédito: SÍ pide PIN
  assert.equal(requiresPinForCreditTermsChange(customer, { creditLimit: 750.0 }), true);

  // Cambiar plazo en días: SÍ pide PIN
  assert.equal(requiresPinForCreditTermsChange(customer, { creditDays: 30 }), true);
});

test('Fiado (F2): Búsqueda rápida en el POS (nombre, alias, teléfono, ID) y omisión de inactivos', () => {
  const customers: CreditCustomerLike[] = [
    {
      id: 'CLI-01',
      name: 'Doña Carmen - Vecina Casa Blanca',
      alias: 'Casa Blanca',
      phone: '477-234-8812',
      creditLimit: 500.0,
      currentBalance: 100.0,
      isActive: true,
    },
    {
      id: 'CLI-02',
      name: 'Taller Mecánico El Istmo',
      alias: 'Don Rogelio',
      phone: '477-391-0455',
      creditLimit: 600.0,
      currentBalance: 0.0,
      isActive: true,
    },
    {
      id: 'CLI-03',
      name: 'Baja Lógica Anterior',
      alias: 'Inactivo',
      phone: '477-000-0000',
      creditLimit: 300.0,
      currentBalance: 0.0,
      isActive: false, // Inactivo
    },
  ];

  // Búsqueda por alias
  const searchAlias = searchCreditCustomers('Rogelio', customers);
  assert.equal(searchAlias.length, 1);
  assert.equal(searchAlias[0].id, 'CLI-02');

  // Búsqueda por teléfono
  const searchPhone = searchCreditCustomers('234-8812', customers);
  assert.equal(searchPhone.length, 1);
  assert.equal(searchPhone[0].id, 'CLI-01');

  // Búsqueda vacía devuelve todos los activos
  const searchAll = searchCreditCustomers('', customers);
  assert.equal(searchAll.length, 2);
  assert.equal(searchAll.some((c) => c.id === 'CLI-03'), false);
});

test('Fiado (F2): Ficha de cliente registra compras a crédito con partidas (debts) e historial de abonos (payments)', () => {
  const cliente: CreditCustomerLike = {
    id: 'CLI-10',
    name: 'Familia Ramírez',
    creditLimit: 1000.0,
    creditDays: 14,
    currentBalance: 0,
    debts: [],
    payments: [],
  };

  // 1. Cargar primera compra a crédito
  const venta1 = applyCreditSalePure(cliente, 250.0, HOY, {
    id: 'FIADO-01',
    description: 'Abarrotes y lácteos',
  });
  assert.equal(venta1.ok, true);
  assert.equal(venta1.updatedCustomer?.currentBalance, 250.0);
  assert.equal(venta1.updatedCustomer?.debts?.length, 1);
  assert.equal(venta1.updatedCustomer?.debts?.[0].remainingBalance, 250.0);
  assert.equal(venta1.updatedCustomer?.debts?.[0].dueDate, '2026-11-08'); // 14 días después del 25 de octubre

  // 2. Cargar segunda compra a crédito
  const venta2 = applyCreditSalePure(venta1.updatedCustomer!, 300.0, HOY, {
    id: 'FIADO-02',
    description: 'Despensa fin de semana',
  });
  assert.equal(venta2.ok, true);
  assert.equal(venta2.updatedCustomer?.currentBalance, 550.0);
  assert.equal(venta2.updatedCustomer?.debts?.length, 2);

  // 3. Realizar abono de $350.00
  const abono = applyCreditPaymentPure(venta2.updatedCustomer!, 350.0, HOY, 'Abono quincenal');
  assert.equal(abono.appliedAmount, 350.0);
  assert.equal(abono.updatedCustomer.currentBalance, 200.0); // 550 - 350 = 200
  assert.equal(abono.updatedCustomer.payments?.length, 1);
  assert.equal(abono.updatedCustomer.payments?.[0].amount, 350.0);
  assert.equal(abono.updatedCustomer.payments?.[0].previousBalance, 550.0);
  assert.equal(abono.updatedCustomer.payments?.[0].remainingBalance, 200.0);

  // La partida FIADO-01 (más antigua) se liquidó completamente ($250 -> $0)
  assert.equal(abono.updatedCustomer.debts?.find((d) => d.id === 'FIADO-01')?.remainingBalance, 0);
  // La partida FIADO-02 se amortizó con los $100 restantes ($300 -> $200)
  assert.equal(abono.updatedCustomer.debts?.find((d) => d.id === 'FIADO-02')?.remainingBalance, 200.0);
});
