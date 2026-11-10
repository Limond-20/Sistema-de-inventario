import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDueDate,
  isDebtOverdue,
  isDebtDueSoon,
  validateSupplierInput,
  canDeactivateSupplier,
  allocateSupplierPaymentToDebts,
  detectPriceHike,
  type Supplier,
  type AccountsPayableDebt,
} from './suppliers.ts';

test('Proveedores (F2): cálculo de fechas de vencimiento y detección de deudas vencidas / por vencer', () => {
  const baseDate = '2026-10-01';
  const dueIn15Days = calculateDueDate(baseDate, 15);
  assert.equal(dueIn15Days, '2026-10-16');

  const dueIn30Days = calculateDueDate(baseDate, 30);
  assert.equal(dueIn30Days, '2026-10-31');

  // Evaluar vencimiento frente a fecha de referencia '2026-10-20'
  const todayRef = new Date('2026-10-20T12:00:00Z');

  // Deuda con vencimiento 2026-10-16 ya venció el 20 de octubre
  assert.equal(isDebtOverdue('2026-10-16', todayRef), true);
  // Deuda con vencimiento 2026-10-25 sigue vigente
  assert.equal(isDebtOverdue('2026-10-25', todayRef), false);

  // Deuda con vencimiento 2026-10-22 está dentro de los 3 días próximos a vencer
  assert.equal(isDebtDueSoon('2026-10-22', 3, todayRef), true);
  // Deuda con vencimiento 2026-10-30 NO vence pronto
  assert.equal(isDebtDueSoon('2026-10-30', 3, todayRef), false);
});

test('Proveedores (F2): validación de alta de proveedor y bloqueo de baja lógica si tiene saldo pendiente', () => {
  // Validación de datos válidos
  const valid = validateSupplierInput({
    name: 'Distribuidora del Bajío',
    phone: '477-123-4567',
    paymentTerms: 'CREDITO',
    creditDays: 20,
    visitDays: ['Martes', 'Viernes'],
    physicalExchangePolicy: true,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.normalized?.name, 'Distribuidora del Bajío');
  assert.equal(valid.normalized?.creditDays, 20);

  // Validación de nombre inválido
  const invalid = validateSupplierInput({
    name: ' ',
    phone: '123',
  });
  assert.equal(valid.valid, true);
  assert.equal(invalid.valid, false);

  const supplierWithDebt: Supplier = {
    id: 'SUP-TEST-01',
    name: 'Lala',
    phone: '800-433-5252',
    visitDays: ['Martes'],
    paymentTerms: 'CREDITO',
    creditDays: 15,
    physicalExchangePolicy: true,
    isActive: true,
    currentBalance: 1250.0, // Tiene saldo pendiente
  };

  const deactCheck = canDeactivateSupplier(supplierWithDebt);
  assert.equal(deactCheck.canDeactivate, false);
  assert.match(deactCheck.reason || '', /saldo pendiente de pago/);

  const supplierClean: Supplier = {
    ...supplierWithDebt,
    currentBalance: 0,
  };
  const deactClean = canDeactivateSupplier(supplierClean, []);
  assert.equal(deactClean.canDeactivate, true);
});

test('Proveedores (F2): asignación FIFO de pagos a cuentas por pagar (vencidas primero, luego vigentes)', () => {
  const todayRef = new Date('2026-10-20T12:00:00Z');

  const debts: AccountsPayableDebt[] = [
    {
      id: 'CXP-01',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-101',
      date: '2026-09-25',
      dueDate: '2026-10-10', // VENCIDA hace 10 días
      totalAmount: 1000.0,
      remainingBalance: 400.0,
      status: 'VENCIDO',
    },
    {
      id: 'CXP-02',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-102',
      date: '2026-10-01',
      dueDate: '2026-10-15', // VENCIDA hace 5 días
      totalAmount: 800.0,
      remainingBalance: 800.0,
      status: 'VENCIDO',
    },
    {
      id: 'CXP-03',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-103',
      date: '2026-10-12',
      dueDate: '2026-10-27', // VIGENTE
      totalAmount: 600.0,
      remainingBalance: 600.0,
      status: 'PENDIENTE',
    },
  ];

  // Caso 1: Abono de $1,000.00
  // Debe liquidar CXP-01 ($400) y amortizar $600 de CXP-02 (quedando $200 de CXP-02). CXP-03 queda intacta ($600).
  const alloc1 = allocateSupplierPaymentToDebts(debts, 1000.0, todayRef);
  assert.equal(alloc1.totalApplied, 1000.0);
  assert.equal(alloc1.excessAmount, 0);

  const cxp1 = alloc1.updatedDebts.find((d) => d.id === 'CXP-01')!;
  assert.equal(cxp1.remainingBalance, 0);
  assert.equal(cxp1.status, 'PAGADO');

  const cxp2 = alloc1.updatedDebts.find((d) => d.id === 'CXP-02')!;
  assert.equal(cxp2.remainingBalance, 200.0);
  assert.equal(cxp2.status, 'VENCIDO');

  const cxp3 = alloc1.updatedDebts.find((d) => d.id === 'CXP-03')!;
  assert.equal(cxp3.remainingBalance, 600.0);
  assert.equal(cxp3.status, 'PENDIENTE');

  assert.equal(alloc1.remainingOverdueBalance, 200.0);
  assert.equal(alloc1.remainingCurrentBalance, 600.0);
  assert.equal(alloc1.totalRemainingBalance, 800.0);

  // Caso 2: Pago posterior de $900.00 sobre el estado remanente (liquida los $200 vencidos y los $600 vigentes, sobrando $100)
  const alloc2 = allocateSupplierPaymentToDebts(alloc1.updatedDebts, 900.0, todayRef);
  assert.equal(alloc2.totalApplied, 800.0);
  assert.equal(alloc2.excessAmount, 100.0);
  assert.equal(alloc2.totalRemainingBalance, 0);
  assert.equal(alloc2.remainingOverdueBalance, 0);
});

test('Proveedores (F2): detección de alza de precio por proveedor e historial', () => {
  // Sin costo anterior
  const checkInitial = detectPriceHike(35.0, undefined);
  assert.equal(checkInitial.isHike, false);

  // Mismo costo o costo menor
  const checkSame = detectPriceHike(35.0, 35.0);
  assert.equal(checkSame.isHike, false);

  const checkLower = detectPriceHike(32.0, 35.0);
  assert.equal(checkLower.isHike, false);

  // Alza de precio: de $28.00 a $32.00 (+14.29%)
  const checkHike = detectPriceHike(32.0, 28.0);
  assert.equal(checkHike.isHike, true);
  assert.equal(checkHike.diffCents, 400); // 400 centavos = $4.00
  assert.equal(checkHike.hikePct, 14.29);
});


test('Proveedores (F2): amortización específica de remisión/factura por targetDebtId con spillover FIFO', () => {
  const todayRef = new Date('2026-10-20T12:00:00Z');

  const debts: AccountsPayableDebt[] = [
    {
      id: 'CXP-01',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-101',
      date: '2026-09-25',
      dueDate: '2026-10-10', // VENCIDA
      totalAmount: 1000.0,
      remainingBalance: 500.0,
      status: 'VENCIDO',
    },
    {
      id: 'CXP-02',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-102',
      date: '2026-10-01',
      dueDate: '2026-10-15', // VENCIDA
      totalAmount: 800.0,
      remainingBalance: 800.0,
      status: 'VENCIDO',
    },
    {
      id: 'CXP-03',
      supplierId: 'SUP-01',
      supplierName: 'Distribuidora A',
      receptionFolio: 'REC-103',
      date: '2026-10-12',
      dueDate: '2026-10-27', // VIGENTE
      totalAmount: 600.0,
      remainingBalance: 300.0,
      status: 'PENDIENTE',
    },
  ];

  // Caso 1: Pago de $300.00 dirigido explícitamente a CXP-03 (que es vigente y no la más antigua)
  const alloc1 = allocateSupplierPaymentToDebts(debts, 300.0, todayRef, 'CXP-03');
  assert.equal(alloc1.totalApplied, 300.0);
  assert.equal(alloc1.excessAmount, 0);

  const cxp3After = alloc1.updatedDebts.find((d) => d.id === 'CXP-03')!;
  assert.equal(cxp3After.remainingBalance, 0);
  assert.equal(cxp3After.status, 'PAGADO');

  // CXP-01 y CXP-02 deben seguir intactas
  const cxp1After = alloc1.updatedDebts.find((d) => d.id === 'CXP-01')!;
  assert.equal(cxp1After.remainingBalance, 500.0);
  assert.equal(cxp1After.status, 'VENCIDO');

  // Caso 2: Pago de $600.00 dirigido a CXP-03 (saldo $300):
  // Liquida primero CXP-03 ($300) y el remanente de $300 pasa por FIFO a CXP-01 (quedando en $200)
  const alloc2 = allocateSupplierPaymentToDebts(debts, 600.0, todayRef, 'CXP-03');
  assert.equal(alloc2.totalApplied, 600.0);
  assert.equal(alloc2.excessAmount, 0);

  const cxp3Paid = alloc2.updatedDebts.find((d) => d.id === 'CXP-03')!;
  assert.equal(cxp3Paid.remainingBalance, 0);
  assert.equal(cxp3Paid.status, 'PAGADO');

  const cxp1Part = alloc2.updatedDebts.find((d) => d.id === 'CXP-01')!;
  assert.equal(cxp1Part.remainingBalance, 200.0); // 500 - 300 = 200
  assert.equal(cxp1Part.status, 'VENCIDO');
});
