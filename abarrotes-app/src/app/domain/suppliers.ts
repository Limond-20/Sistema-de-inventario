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
export type SupplierPaymentSource = 'CAJA' | 'FONDO_EXTERNO';

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
 * Extrae la fecha local en formato AAAA-MM-DD sin desfase horario por UTC.
 * NUNCA usa toISOString() sobre fechas con hora local.
 */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parsea una fecha asegurando interpretación local para cadenas AAAA-MM-DD.
 */
export function parseLocalDate(baseDate: string | Date): Date {
  if (baseDate instanceof Date) {
    return new Date(baseDate.getTime());
  }
  const str = String(baseDate || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    return new Date(year, month, day, 12, 0, 0);
  }
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

/**
 * Normaliza nombres de contacto eliminando diacríticos, acentos, signos de puntuación y espacios superfluos.
 *
 * CRITERIO EXACTO DE "NOMBRE SIMILAR / DUPLICADO":
 * 1. Insensibilidad a mayúsculas/minúsculas y acentos:
 *    Se convierte a minúsculas y se descomponen los diacríticos Unicode (NFD), eliminando tildes (á->a, é->e, etc.).
 * 2. Neutralización de signos de puntuación y separadores:
 *    Signos como guiones (-), barras (/), puntos (.), comas (,), comillas y caracteres no alfanuméricos
 *    se transforman en espacios para que variantes como "Coca-Cola FEMSA" y "Coca Cola Femsa"
 *    colapsen en la misma clave canónica: "coca cola femsa" (DUPLICADO).
 * 3. Colapso de espacios en blanco y recorte:
 *    Múltiples espacios consecutivos se reducen a un solo espacio y se eliminan espacios iniciales/finales.
 * 4. Correspondencia canónica completa:
 *    Dos nombres son duplicados si y solo si sus claves canónicas normalizadas son idénticas.
 *    No se consideran duplicados los nombres que comparten palabras pero añaden términos distintivos
 *    (ejemplo: "Pedro" vs "Pedro Sánchez", "Distribuidora" vs "Distribuidora del Bajío"),
 *    evitando falsos positivos entre personas o entidades comerciales distintas.
 */
export function normalizeContactName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrae únicamente dígitos numéricos del teléfono para comparación normalizada.
 */
export function normalizePhoneNumber(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/**
 * Verifica si un proveedor candidato duplica a alguno existente (nombre normalizado o teléfono).
 */
export function checkSupplierDuplicate(
  candidate: { name: string; phone?: string; id?: string },
  existingSuppliers: readonly Supplier[]
): { isDuplicate: boolean; duplicateOf?: Supplier; reason?: string } {
  const normName = normalizeContactName(candidate.name);
  const normPhone = normalizePhoneNumber(candidate.phone || '');

  for (const s of existingSuppliers) {
    if (candidate.id && s.id === candidate.id) continue;
    if (s.isActive === false) continue;

    const sNormName = normalizeContactName(s.name);
    const sNormPhone = normalizePhoneNumber(s.phone || '');

    const nameMatches = normName.length > 0 && normName === sNormName;
    const phoneMatches = normPhone.length >= 7 && normPhone === sNormPhone;

    if (nameMatches && phoneMatches) {
      return {
        isDuplicate: true,
        duplicateOf: s,
        reason: `Ya existe un proveedor registrado con el mismo nombre y teléfono: "${s.name}" (${s.phone || 'Sin tel'}).`,
      };
    }
    if (nameMatches) {
      return {
        isDuplicate: true,
        duplicateOf: s,
        reason: `Ya existe un proveedor registrado con el mismo nombre: "${s.name}".`,
      };
    }
    if (phoneMatches) {
      return {
        isDuplicate: true,
        duplicateOf: s,
        reason: `Ya existe un proveedor registrado con el mismo teléfono: "${s.name}" (${s.phone}).`,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * Calcula la fecha de vencimiento sumando N días calendario a una fecha base (formato AAAA-MM-DD).
 * Utiliza exclusivamente fechas y componentes locales para evitar desfases de zona horaria.
 */
export function calculateDueDate(baseDate: string | Date, days: number): string {
  const d = parseLocalDate(baseDate);
  const cleanDays = Math.max(0, Math.round(Number(days) || 0));
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + cleanDays, 12, 0, 0);
  return formatLocalDate(target);
}

/**
 * Determina si una cuenta por pagar está vencida comparando su dueDate contra 'today'.
 */
export function isDebtOverdue(dueDate: string | Date, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  const dueStr = formatLocalDate(parseLocalDate(dueDate));
  const todayStr = formatLocalDate(today);
  return dueStr < todayStr;
}

/**
 * Determina si una deuda vence próximamente dentro de un umbral de días (ej. 3 días).
 */
export function isDebtDueSoon(dueDate: string | Date, thresholdDays = 3, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  const dueStr = formatLocalDate(parseLocalDate(dueDate));
  const todayStr = formatLocalDate(today);
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
  today: Date = new Date(),
  targetDebtId?: string
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
  let appliedTotalCents = 0;

  // 1. Si se especificó targetDebtId, amortizar primero esa factura/deuda concreta
  if (targetDebtId) {
    const target = mutableDebts.find((d) => d.id === targetDebtId);
    if (target && toCentsInt(target.remainingBalance) > 0) {
      const remCents = toCentsInt(target.remainingBalance);
      const payCents = Math.min(availableCents, remCents);
      const newRemCents = remCents - payCents;
      target.remainingBalance = fromCentsInt(newRemCents);
      target.status = newRemCents === 0 ? 'PAGADO' : (isDebtOverdue(target.dueDate, today) ? 'VENCIDO' : 'PENDIENTE');
      availableCents -= payCents;
      appliedTotalCents += payCents;
      affectedDebtIds.push(target.id);
    }
  }

  // 2. Si queda disponible, aplicar FIFO tradicional al resto (vencidas primero, luego vigentes)
  const overdueRemaining = mutableDebts
    .filter((d) => isDebtOverdue(d.dueDate, today) && toCentsInt(d.remainingBalance) > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date));

  for (const debt of overdueRemaining) {
    if (availableCents <= 0) break;
    const remCents = toCentsInt(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCentsInt(newRemCents);
    debt.status = newRemCents === 0 ? 'PAGADO' : 'VENCIDO';
    availableCents -= payCents;
    appliedTotalCents += payCents;
    if (!affectedDebtIds.includes(debt.id)) {
      affectedDebtIds.push(debt.id);
    }
  }

  const vigenteRemaining = mutableDebts
    .filter((d) => !isDebtOverdue(d.dueDate, today) && toCentsInt(d.remainingBalance) > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date));

  for (const debt of vigenteRemaining) {
    if (availableCents <= 0) break;
    const remCents = toCentsInt(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCentsInt(newRemCents);
    debt.status = newRemCents === 0 ? 'PAGADO' : 'PENDIENTE';
    availableCents -= payCents;
    appliedTotalCents += payCents;
    if (!affectedDebtIds.includes(debt.id)) {
      affectedDebtIds.push(debt.id);
    }
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
