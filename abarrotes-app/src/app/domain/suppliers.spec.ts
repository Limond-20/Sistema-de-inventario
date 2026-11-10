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
  checkSupplierDuplicate,
  formatLocalDate,
  parseLocalDate,
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

test('Fechas (F2 Seguimiento): cálculo de vencimiento con fecha local AAAA-MM-DD sin desfase UTC a las 19:00 y 23:30 (plazos 15/30 días, cruce de mes y año)', () => {
  // Caso 1: Hora fijada a las 19:00 (típica hora en México donde toISOString convertiría a +6 horas = día siguiente en UTC)
  // Fecha base: 31 de Octubre de 2026 a las 19:00:00 local
  const dateAt1900 = new Date(2026, 9, 31, 19, 0, 0); // Octubre es mes 9
  assert.equal(formatLocalDate(dateAt1900), '2026-10-31', 'La fecha local a las 19:00 debe ser 2026-10-31');

  // Plazo 15 días: 31 Octubre + 15 días = 15 Noviembre (cruce de mes)
  const due15Days1900 = calculateDueDate(dateAt1900, 15);
  assert.equal(due15Days1900, '2026-11-15');

  // Plazo 30 días: 31 Octubre + 30 días = 30 Noviembre
  const due30Days1900 = calculateDueDate(dateAt1900, 30);
  assert.equal(due30Days1900, '2026-11-30');

  // Caso 2: Hora fijada a las 23:30 (cerca de medianoche)
  // Fecha base: 20 de Diciembre de 2026 a las 23:30:00 local
  const dateAt2330 = new Date(2026, 11, 20, 23, 30, 0); // Diciembre es mes 11
  assert.equal(formatLocalDate(dateAt2330), '2026-12-20', 'La fecha local a las 23:30 debe ser 2026-12-20');

  // Plazo 15 días: 20 Diciembre + 15 días = 4 Enero 2027 (cruce de mes y año)
  const due15Days2330 = calculateDueDate(dateAt2330, 15);
  assert.equal(due15Days2330, '2027-01-04');

  // Plazo 30 días: 20 Diciembre + 30 días = 19 Enero 2027 (cruce de mes y año)
  const due30Days2330 = calculateDueDate(dateAt2330, 30);
  assert.equal(due30Days2330, '2027-01-19');

  // Verificación de que la comparación de vencimiento también respeta la fecha local sin desfase horario
  const todayAt2330 = new Date(2026, 9, 31, 23, 30, 0);
  // Una deuda que vence el mismo día 2026-10-31 NO está vencida hoy a las 23:30
  assert.equal(isDebtOverdue('2026-10-31', todayAt2330), false);
  // Una deuda que venció ayer 2026-10-30 sí está vencida
  assert.equal(isDebtOverdue('2026-10-30', todayAt2330), true);
});

test('Proveedores (F2 Seguimiento): Detección y prevención de proveedores duplicados (nombre normalizado + teléfono)', () => {
  const existingSuppliers: Supplier[] = [
    {
      id: 'SUP-01',
      name: 'Distribuidora del Bajío',
      phone: '477-123-4567',
      visitDays: ['Lunes'],
      paymentTerms: 'CREDITO',
      creditDays: 15,
      physicalExchangePolicy: true,
      isActive: true,
      currentBalance: 0,
    },
    {
      id: 'SUP-02',
      name: 'Lácteos Santa Clara',
      phone: '55-9876-5432',
      visitDays: ['Martes'],
      paymentTerms: 'CONTADO',
      creditDays: 0,
      physicalExchangePolicy: false,
      isActive: true,
      currentBalance: 0,
    },
    {
      id: 'SUP-INACTIVE',
      name: 'Abarrotes Don Pepe',
      phone: '951-999-8877',
      visitDays: [],
      paymentTerms: 'CONTADO',
      creditDays: 0,
      physicalExchangePolicy: false,
      isActive: false, // Inactivo
      currentBalance: 0,
    },
  ];

  // 1. Duplicado por nombre idéntico con mayúsculas y acentos
  const dupName = checkSupplierDuplicate(
    { name: '  dístribuidora DEL bajio  ', phone: '999-000-1111' },
    existingSuppliers
  );
  assert.equal(dupName.isDuplicate, true);
  assert.equal(dupName.duplicateOf?.id, 'SUP-01');
  assert.match(dupName.reason || '', /mismo nombre/);

  // 2. Duplicado por teléfono (mismos dígitos en distinto formato)
  const dupPhone = checkSupplierDuplicate(
    { name: 'Comercializadora Nueva', phone: '(477) 123 4567' },
    existingSuppliers
  );
  assert.equal(dupPhone.isDuplicate, true);
  assert.equal(dupPhone.duplicateOf?.id, 'SUP-01');
  assert.match(dupPhone.reason || '', /mismo teléfono/);

  // 3. Duplicado exacto (nombre y teléfono coinciden)
  const dupBoth = checkSupplierDuplicate(
    { name: 'Lácteos Santa Clara', phone: '5598765432' },
    existingSuppliers
  );
  assert.equal(dupBoth.isDuplicate, true);
  assert.equal(dupBoth.duplicateOf?.id, 'SUP-02');

  // 4. Proveedor no duplicado (distinto nombre y teléfono)
  const notDup = checkSupplierDuplicate(
    { name: 'Bimbo México', phone: '55-1122-3344' },
    existingSuppliers
  );
  assert.equal(notDup.isDuplicate, false);

  // 5. Comparación contra sí mismo en edición (mismo id) no debe marcar duplicado
  const selfCheck = checkSupplierDuplicate(
    { id: 'SUP-01', name: 'Distribuidora del Bajío', phone: '477-123-4567' },
    existingSuppliers
  );
  assert.equal(selfCheck.isDuplicate, false);

  // 6. Proveedor dado de baja (isActive: false) no bloquea nuevo registro
  const inactiveCheck = checkSupplierDuplicate(
    { name: 'Abarrotes Don Pepe', phone: '951-999-8877' },
    existingSuppliers
  );
  assert.equal(inactiveCheck.isDuplicate, false);
});
