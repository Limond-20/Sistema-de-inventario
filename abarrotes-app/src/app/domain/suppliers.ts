/**
 * Lógica pura de dominio para Proveedores, Cuentas por Pagar (CxP) e Historial de Precios.
 *
 * Reglas de negocio:
 * 1. Dinero siempre en centavos enteros con money.ts.
 * 2. Cuentas por pagar: compras a crédito generan deudas con fecha de vencimiento exacta (YYYY-MM-DD).
 * 3. Asignación de pagos al proveedor en orden FIFO (más antiguas/vencidas primero).
 * 4. Pagos en efectivo registran salida de caja en el corte de turno (bloque H).
 * 5. Baja lógica bloqueada si el proveedor tiene saldo por pagar pendiente (> 0).
 * 6. Historial de costos/precios por proveedor y producto para análisis de márgenes y alertas de alza.
 */

function toCents(amount: number): number {
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  if (typeof cents !== 'number' || isNaN(cents) || !isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

const toCentsInt = toCents;
const fromCentsInt = fromCents;

export type SupplierPaymentTerms = 'CONTADO' | 'CREDITO';

export interface Supplier {
  id: string;
  name: string;
  phone: string;
  visitDays: string[];
  paymentTerms: SupplierPaymentTerms;
  creditDays: number; // Plazo en días si es crédito (ej. 15, 30)
  physicalExchangePolicy: boolean; // Si acepta cambio físico
  notes?: string;
  isActive: boolean;
  currentBalance: number; // Saldo pendiente total por pagar en pesos
}

export interface SupplierInput {
  name: string;
  phone: string;
  visitDays?: string[];
  paymentTerms?: SupplierPaymentTerms;
  creditDays?: number;
  physicalExchangePolicy?: boolean;
  notes?: string;
}

export interface AccountsPayableDebt {
  id: string;
  supplierId: string;
  supplierName: string;
  receptionFolio: string;
  date: string; // ISO YYYY-MM-DD
  dueDate: string; // ISO YYYY-MM-DD
  totalAmount: number; // Total en pesos
  remainingBalance: number; // Saldo pendiente en pesos
  status: 'PENDIENTE' | 'PAGADO' | 'VENCIDO';
  linesSummary?: {
    sku: string;
    productName: string;
    qty: number;
    unitCost: number;
    subtotal: number;
  }[];
}

export interface ProductPriceHistoryRecord {
  id: string;
  date: string; // ISO YYYY-MM-DDTHH:mm:ss
  productId: string; // SKU
  productName: string;
  supplierId: string;
  supplierName: string;
  receptionFolio: string;
  purchaseUnit: string;
  unitsPerPurchase: number;
  costPerPurchaseUnit: number;
  unitCost: number; // Costo por unidad de venta
  previousUnitCost?: number;
  priceHikeDetected?: boolean;
  hikePct?: number;
}

/**
 * Calcula la fecha de vencimiento sumando N días calendario a una fecha base (en formato YYYY-MM-DD).
 */
export function calculateDueDate(baseDate: string | Date, days: number): string {
  const d = typeof baseDate === 'string' ? new Date(baseDate.includes('T') ? baseDate : `${baseDate}T12:00:00`) : new Date(baseDate);
  if (isNaN(d.getTime())) {
    const today = new Date();
    today.setDate(today.getDate() + Math.max(0, days));
    return today.toISOString().slice(0, 10);
  }
  const cleanDays = Math.max(0, Math.round(Number(days) || 0));
  d.setDate(d.getDate() + cleanDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Determina si una cuenta por pagar está vencida comparando su dueDate contra 'today'.
 */
export function isDebtOverdue(dueDate: string | Date, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  const dueStr = typeof dueDate === 'string' ? dueDate.trim().slice(0, 10) : dueDate.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  return dueStr < todayStr;
}

/**
 * Determina si una deuda vence próximamente dentro de un umbral de días (ej. 3 días).
 */
export function isDebtDueSoon(dueDate: string | Date, thresholdDays = 3, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  const dueStr = typeof dueDate === 'string' ? dueDate.trim().slice(0, 10) : dueDate.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  if (dueStr < todayStr) return true; // Ya vencida cuenta como urgente
  const limitStr = calculateDueDate(todayStr, thresholdDays);
  return dueStr <= limitStr;
}

/**
 * Valida la entrada para crear o editar un proveedor.
 */
export function validateSupplierInput(input: SupplierInput): { valid: boolean; error?: string; normalized?: SupplierInput } {
  const name = String(input.name || '').trim();
  if (!name || name.length < 2) {
    return { valid: false, error: 'El nombre del proveedor debe tener al menos 2 caracteres.' };
  }
  const phone = String(input.phone || '').trim();
  const paymentTerms: SupplierPaymentTerms = input.paymentTerms === 'CREDITO' ? 'CREDITO' : 'CONTADO';
  const creditDays = paymentTerms === 'CREDITO' ? Math.max(1, Math.round(Number(input.creditDays) || 15)) : 0;
  const visitDays = Array.isArray(input.visitDays) ? input.visitDays.filter(Boolean) : [];
  const physicalExchangePolicy = Boolean(input.physicalExchangePolicy);
  const notes = input.notes ? String(input.notes).trim() : undefined;

  return {
    valid: true,
    normalized: {
      name,
      phone,
      paymentTerms,
      creditDays,
      visitDays,
      physicalExchangePolicy,
      notes,
    },
  };
}

/**
 * Valida si un proveedor puede darse de baja lógica.
 * Regla: No se puede dar de baja si tiene cuentas por pagar con saldo pendiente (> 0).
 */
export function canDeactivateSupplier(supplier: Supplier, pendingDebts: AccountsPayableDebt[] = []): { canDeactivate: boolean; reason?: string } {
  const balanceCents = toCentsInt(supplier.currentBalance);
  if (balanceCents > 0) {
    return {
      canDeactivate: false,
      reason: `No se puede dar de baja al proveedor "${supplier.name}" porque tiene un saldo pendiente de pago de $${supplier.currentBalance.toFixed(2)}.`,
    };
  }

  const supplierDebts = pendingDebts.filter((d) => d.supplierId === supplier.id && toCentsInt(d.remainingBalance) > 0);
  if (supplierDebts.length > 0) {
    const totalPendingCents = supplierDebts.reduce((sum, d) => sum + toCentsInt(d.remainingBalance), 0);
    return {
      canDeactivate: false,
      reason: `No se puede dar de baja al proveedor "${supplier.name}" porque tiene ${supplierDebts.length} cuenta(s) por pagar pendientes por $${fromCentsInt(totalPendingCents).toFixed(2)}.`,
    };
  }

  return { canDeactivate: true };
}

/**
 * Asigna un abono o pago a las cuentas por pagar de un proveedor siguiendo orden FIFO
 * (vencidas primero por dueDate ascendente, luego vigentes por dueDate ascendente).
 */
export function allocateSupplierPaymentToDebts(
  debts: readonly AccountsPayableDebt[],
  paymentAmount: number,
  today: Date = new Date()
): {
  updatedDebts: AccountsPayableDebt[];
  totalApplied: number;
  remainingOverdueBalance: number;
  remainingCurrentBalance: number;
  totalRemainingBalance: number;
  excessAmount: number;
  affectedDebtIds: string[];
} {
  let availableCents = toCentsInt(paymentAmount);
  if (availableCents <= 0) {
    const overdueCents = debts
      .filter((d) => isDebtOverdue(d.dueDate, today))
      .reduce((s, d) => s + toCentsInt(d.remainingBalance), 0);
    const totalCents = debts.reduce((s, d) => s + toCentsInt(d.remainingBalance), 0);
    return {
      updatedDebts: debts.map((d) => ({ ...d })),
      totalApplied: 0,
      remainingOverdueBalance: fromCentsInt(overdueCents),
      remainingCurrentBalance: fromCentsInt(totalCents - overdueCents),
      totalRemainingBalance: fromCentsInt(totalCents),
      excessAmount: 0,
      affectedDebtIds: [],
    };
  }

  const mutableDebts = debts.map((d) => ({ ...d }));
  const affectedDebtIds: string[] = [];

  // Separar en vencidas y vigentes con saldo > 0
  const overdueIndices = mutableDebts
    .map((d, index) => ({ index, debt: d }))
    .filter((x) => isDebtOverdue(x.debt.dueDate, today) && toCentsInt(x.debt.remainingBalance) > 0)
    .sort((a, b) => a.debt.dueDate.localeCompare(b.debt.dueDate) || a.debt.date.localeCompare(b.debt.date))
    .map((x) => x.index);

  const vigenteIndices = mutableDebts
    .map((d, index) => ({ index, debt: d }))
    .filter((x) => !isDebtOverdue(x.debt.dueDate, today) && toCentsInt(x.debt.remainingBalance) > 0)
    .sort((a, b) => a.debt.dueDate.localeCompare(b.debt.dueDate) || a.debt.date.localeCompare(b.debt.date))
    .map((x) => x.index);

  let appliedTotalCents = 0;

  // 1. Amortizar cuentas vencidas (más antiguas primero)
  for (const idx of overdueIndices) {
    if (availableCents <= 0) break;
    const debt = mutableDebts[idx];
    const remCents = toCentsInt(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCentsInt(newRemCents);
    debt.status = newRemCents === 0 ? 'PAGADO' : 'VENCIDO';
    availableCents -= payCents;
    appliedTotalCents += payCents;
    affectedDebtIds.push(debt.id);
  }

  // 2. Amortizar cuentas vigentes (más antiguas primero)
  for (const idx of vigenteIndices) {
    if (availableCents <= 0) break;
    const debt = mutableDebts[idx];
    const remCents = toCentsInt(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCentsInt(newRemCents);
    debt.status = newRemCents === 0 ? 'PAGADO' : 'PENDIENTE';
    availableCents -= payCents;
    appliedTotalCents += payCents;
    affectedDebtIds.push(debt.id);
  }

  const finalOverdueCents = mutableDebts
    .filter((d) => isDebtOverdue(d.dueDate, today))
    .reduce((s, d) => s + toCentsInt(d.remainingBalance), 0);
  const finalTotalCents = mutableDebts.reduce((s, d) => s + toCentsInt(d.remainingBalance), 0);
  const finalVigenteCents = finalTotalCents - finalOverdueCents;

  return {
    updatedDebts: mutableDebts,
    totalApplied: fromCentsInt(appliedTotalCents),
    remainingOverdueBalance: fromCentsInt(finalOverdueCents),
    remainingCurrentBalance: fromCentsInt(finalVigenteCents),
    totalRemainingBalance: fromCentsInt(finalTotalCents),
    excessAmount: fromCentsInt(availableCents),
    affectedDebtIds,
  };
}

/**
 * Detecta si un nuevo costo unitario representa un incremento de precio respecto al costo histórico.
 */
export function detectPriceHike(
  currentUnitCost: number,
  previousUnitCost?: number
): { isHike: boolean; hikePct: number; diffCents: number } {
  const currentCents = toCentsInt(currentUnitCost);
  const prevCents = typeof previousUnitCost === 'number' ? toCentsInt(previousUnitCost) : 0;
  if (prevCents <= 0 || currentCents <= prevCents) {
    return { isHike: false, hikePct: 0, diffCents: 0 };
  }
  const diffCents = currentCents - prevCents;
  const hikePct = Math.round((diffCents / prevCents) * 10000) / 100; // Porcentaje con 2 decimales
  return {
    isHike: true,
    hikePct,
    diffCents,
  };
}
