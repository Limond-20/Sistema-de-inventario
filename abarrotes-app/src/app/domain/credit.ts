/**
 * Lógica pura de dominio para créditos y fiado vecinal.
 *
 * =====================================================================================
 * POLÍTICA DE ASIGNACIÓN DE ABONOS Y REGLAS DE ESTATUS:
 * 1. ASIGNACIÓN ESTRICTA POR ANTIGÜEDAD Y VENCIMIENTO:
 *    Todo abono en efectivo recibido de un cliente se aplica primero contra las deudas con fecha vencida,
 *    priorizando la partida más antigua (FIFO por fecha de vencimiento/compra).
 *    Si el importe del abono es mayor al total de la deuda vencida, el remanente se destina a amortizar
 *    las partidas vigentes (no vencidas), también de la más antigua a la más reciente.
 *
 * 2. DETERMINACIÓN DEL ESTATUS DE CRÉDITO:
 *    - VENCIDO: Mientras exista aunque sea $0.01 de saldo cuya fecha límite ya haya transcurrido.
 *      Un abono parcial NUNCA quita el estatus VENCIDO si no liquidó la totalidad de la deuda vencida.
 *    - LIMITE_ALCANZADO: Cuando no queda saldo vencido, pero la deuda total vigente consume el 90%
 *      o más del límite autorizado (saldo / límite >= 0.9).
 *    - AL_CORRIENTE: Cuando no hay saldo vencido y el saldo vigente es menor al 90% del límite
 *      (o cuando la deuda total llega a $0.00).
 *
 * 3. CASO ESPECIAL: "ABONO CUBRE LO VENCIDO PERO QUEDA SALDO VIGENTE":
 *    Si un cliente debe $300 vencidos y $150 vigentes (Total: $450 con límite de $500), y abona $320:
 *    - Los primeros $300 liquidan el 100% de la deuda vencida (saldo vencido = $0).
 *    - Los $20 restantes amortizan la deuda vigente (saldo vigente remanente = $130).
 *    - Como ya no existe deuda con fecha vencida, el cliente sale inmediatamente de VENCIDO.
 *    - Su ratio es $130 / $500 = 26% (< 90%), por lo que su estatus resultante es AL_CORRIENTE.
 *
 * 4. REGLAS DE GESTIÓN (BLOQUE F2):
 *    - Alta y edición de clientes (nombre, teléfono, límite de crédito, plazo en días, notas).
 *    - Modificar límite de crédito o plazo en días exige PIN de administrador o encargado.
 *    - Baja lógica bloqueada si el cliente tiene saldo pendiente (> 0).
 *    - Búsqueda rápida por nombre, alias, teléfono o ID en el POS (omite clientes inactivos).
 *    - Ficha de cliente con historial de compras a crédito, abonos y saldo.
 * =====================================================================================
 */

function toCents(amount: number): number {
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function fromCents(cents: number): number {
  if (typeof cents !== 'number' || isNaN(cents) || !isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

export type CreditCustomerStatus = 'AL_CORRIENTE' | 'LIMITE_ALCANZADO' | 'VENCIDO';

export type CreditExcessResolution = 'SALDO_A_FAVOR' | 'REEMBOLSO_EFECTIVO' | 'NINGUNO';

export interface CreditDebtItem {
  id: string;
  date: string; // ISO yyyy-mm-dd
  dueDate: string; // ISO yyyy-mm-dd
  originalAmount: number;
  remainingBalance: number;
  description?: string;
  saleFolio?: string;
}

export type CreditPaymentMethod = 'EFECTIVO' | 'TRANSFERENCIA' | 'TARJETA';

export interface CreditPaymentRecord {
  id: string;
  date: string; // ISO YYYY-MM-DDTHH:mm:ss
  amount: number;
  previousBalance: number;
  remainingBalance: number;
  paymentMethod?: CreditPaymentMethod;
  note?: string;
}

export interface CustomerInput {
  name: string;
  phone?: string;
  alias?: string;
  creditLimit: number;
  creditDays?: number;
  notes?: string;
}

export interface CreditCustomerLike {
  id?: string;
  name?: string;
  alias?: string;
  phone?: string;
  creditLimit: number;
  creditDays?: number;
  currentBalance: number;
  creditFavorBalance?: number;
  dueDate?: string | Date;
  status?: CreditCustomerStatus;
  overdueBalance?: number;
  notes?: string;
  isActive?: boolean;
  debts?: CreditDebtItem[];
  payments?: CreditPaymentRecord[];
  [key: string]: any;
}

export interface CreditCustomer extends CreditCustomerLike {
  id: string;
  name: string;
  creditLimit: number;
  currentBalance: number;
  creditFavorBalance?: number;
  debts: CreditDebtItem[];
  payments: CreditPaymentRecord[];
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
 * Normaliza nombres de contacto eliminando diacríticos, acentos y espacios superfluos.
 */
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
 * Verifica si un cliente candidato duplica a alguno existente (nombre normalizado o teléfono).
 */
export function checkCustomerDuplicate(
  candidate: { name: string; phone?: string; alias?: string; id?: string },
  existingCustomers: readonly CreditCustomerLike[]
): { isDuplicate: boolean; duplicateOf?: CreditCustomerLike; reason?: string } {
  const normName = normalizeContactName(candidate.name);
  const normPhone = normalizePhoneNumber(candidate.phone || '');

  for (const c of existingCustomers) {
    if (candidate.id && c.id === candidate.id) continue;
    if (c.isActive === false) continue;

    const cNormName = normalizeContactName(c.name || '');
    const cNormPhone = normalizePhoneNumber(c.phone || '');

    const nameMatches = normName.length > 0 && normName === cNormName;
    const phoneMatches = normPhone.length >= 7 && normPhone === cNormPhone;

    if (nameMatches && phoneMatches) {
      return {
        isDuplicate: true,
        duplicateOf: c,
        reason: `Ya existe un cliente con el mismo nombre y teléfono: "${c.name}" (${c.phone || 'Sin tel'}).`,
      };
    }
    if (nameMatches) {
      return {
        isDuplicate: true,
        duplicateOf: c,
        reason: `Ya existe un cliente con el mismo nombre: "${c.name}".`,
      };
    }
    if (phoneMatches) {
      return {
        isDuplicate: true,
        duplicateOf: c,
        reason: `Ya existe un cliente con el mismo teléfono: "${c.name}" (${c.phone}).`,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * Calcula la fecha de vencimiento sumando N días calendario a una fecha base (formato AAAA-MM-DD).
 * Utiliza exclusivamente fechas y componentes locales para evitar desfases de zona horaria.
 */
export function calculateCustomerDueDate(baseDate: string | Date, days: number): string {
  const d = parseLocalDate(baseDate);
  const cleanDays = Math.max(0, Math.round(Number(days) || 0));
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + cleanDays, 12, 0, 0);
  return formatLocalDate(target);
}

/**
 * Valida los datos de entrada para alta o edición de un cliente de fiado.
 */
export function validateCustomerInput(input: CustomerInput): {
  valid: boolean;
  error?: string;
  normalized?: CustomerInput & { creditDays: number; creditLimit: number };
} {
  const name = String(input.name || '').trim();
  if (!name || name.length < 2) {
    return { valid: false, error: 'El nombre del cliente debe tener al menos 2 caracteres.' };
  }
  const limitCents = toCents(input.creditLimit);
  if (limitCents < 0 || isNaN(limitCents)) {
    return { valid: false, error: 'El límite de crédito no puede ser negativo.' };
  }
  const creditDays = input.creditDays !== undefined ? Math.max(1, Math.round(Number(input.creditDays))) : 15;
  const phone = input.phone ? String(input.phone).trim() : '';
  const alias = input.alias ? String(input.alias).trim() : undefined;
  const notes = input.notes ? String(input.notes).trim() : undefined;

  return {
    valid: true,
    normalized: {
      name,
      phone,
      alias,
      creditLimit: fromCents(limitCents),
      creditDays,
      notes,
    },
  };
}

/**
 * Valida si un cliente puede darse de baja lógica.
 * Regla: No se puede dar de baja si tiene saldo pendiente (> 0).
 */
export function canDeactivateCustomer(customer: CreditCustomerLike): { canDeactivate: boolean; reason?: string } {
  const balanceCents = toCents(customer.currentBalance);
  if (balanceCents > 0) {
    return {
      canDeactivate: false,
      reason: `No se puede dar de baja al cliente "${customer.name || 'Sin nombre'}" porque tiene un saldo pendiente de $${customer.currentBalance.toFixed(2)}.`,
    };
  }
  return { canDeactivate: true };
}

/**
 * Verifica si la modificación de datos del cliente requiere PIN de administrador/encargado.
 * Regla: Cambiar límite de crédito o plazo en días exige PIN.
 */
export function requiresPinForCreditTermsChange(
  oldCustomer: CreditCustomerLike,
  newTerms: { creditLimit?: number; creditDays?: number }
): boolean {
  if (newTerms.creditLimit !== undefined) {
    if (toCents(newTerms.creditLimit) !== toCents(oldCustomer.creditLimit)) {
      return true;
    }
  }
  if (newTerms.creditDays !== undefined) {
    const oldDays = oldCustomer.creditDays !== undefined ? Math.round(Number(oldCustomer.creditDays)) : 15;
    const newDays = Math.round(Number(newTerms.creditDays));
    if (oldDays !== newDays) {
      return true;
    }
  }
  return false;
}

/**
 * Búsqueda rápida de clientes para el POS:
 * Busca por coincidencia insensible a mayúsculas en nombre, alias, teléfono o ID.
 * Omite clientes inactivos (baja lógica).
 */
export function searchCreditCustomers<T extends CreditCustomerLike>(
  query: string,
  customers: readonly T[]
): T[] {
  const q = (query || '').toLowerCase().trim();
  const activeCustomers = customers.filter((c) => c.isActive !== false);
  if (!q) return activeCustomers;

  return activeCustomers.filter((c) => {
    const nameMatch = (c.name || '').toLowerCase().includes(q);
    const aliasMatch = (c.alias || '').toLowerCase().includes(q);
    const phoneMatch = (c.phone || '').replace(/[\s-]/g, '').includes(q.replace(/[\s-]/g, ''));
    const idMatch = (c.id || '').toLowerCase().includes(q);
    return nameMatch || aliasMatch || phoneMatch || idMatch;
  });
}

/**
 * Determina si una fecha de vencimiento dada ya transcurrió respecto a 'hoy'.
 * Compara las fechas a nivel de día local (AAAA-MM-DD) para evitar problemas de desfase horario.
 */
export function isDueDatePassed(dueDate: string | Date | undefined, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  const dueStr = formatLocalDate(parseLocalDate(dueDate));
  const todayStr = formatLocalDate(today);
  return dueStr < todayStr;
}

/**
 * Calcula el estatus de crédito de un cliente basándose en su saldo, límite y vencimiento:
 * 1. VENCIDO: Si hay saldo pendiente y tiene fecha vencida o saldo vencido remanente.
 * 2. LIMITE_ALCANZADO: Si no está vencido pero el saldo actual consume el 90% o más del límite (saldo / límite >= 0.9).
 * 3. AL_CORRIENTE: Si tiene saldo menor al 90% del límite y sin deudas vencidas, o si su saldo es 0.
 */
export function computeCreditStatus(
  cliente: CreditCustomerLike,
  hoy: Date = new Date()
): CreditCustomerStatus {
  const balanceCents = toCents(cliente.currentBalance);

  // Si no debe nada o tiene saldo a favor, siempre está al corriente
  if (balanceCents <= 0) {
    return 'AL_CORRIENTE';
  }

  // Verificar si hay saldo con fecha vencida:
  // Si tiene partidas desglosadas (debts), el saldo vencido es la suma de partidas vencidas
  let hasExplicitOverdue = false;
  if (Array.isArray(cliente.debts) && cliente.debts.length > 0) {
    const overdueSumCents = cliente.debts
      .filter((d) => isDueDatePassed(d.dueDate, hoy))
      .reduce((sum, d) => sum + toCents(d.remainingBalance), 0);
    hasExplicitOverdue = overdueSumCents > 0;
    // Si tiene partidas desglosadas y no queda ninguna vencida, no está vencido
    if (!hasExplicitOverdue && typeof cliente.overdueBalance === 'number') {
      hasExplicitOverdue = toCents(cliente.overdueBalance) > 0;
    }
  } else {
    hasExplicitOverdue =
      typeof cliente.overdueBalance === 'number' && toCents(cliente.overdueBalance) > 0;
  }

  const isDateExpired = isDueDatePassed(cliente.dueDate, hoy);

  const isOverdue =
    hasExplicitOverdue ||
    (isDateExpired && balanceCents > 0) ||
    (cliente.status === 'VENCIDO' && (hasExplicitOverdue || (isDateExpired && balanceCents > 0)));

  if (isOverdue) {
    return 'VENCIDO';
  }

  const limitCents = toCents(cliente.creditLimit);
  if (limitCents > 0) {
    const ratio = balanceCents / limitCents;
    if (ratio >= 0.9) {
      return 'LIMITE_ALCANZADO';
    }
  }

  return 'AL_CORRIENTE';
}

/**
 * Asigna un abono a la lista de adeudos del cliente: primero lo vencido (más antiguo primero),
 * y si sobra, a lo vigente (más antiguo primero).
 */
export function allocatePaymentToDebts(
  debts: readonly CreditDebtItem[],
  paymentAmount: number,
  today: Date = new Date()
): {
  updatedDebts: CreditDebtItem[];
  totalApplied: number;
  remainingOverdueBalance: number;
  remainingCurrentBalance: number;
  totalRemainingBalance: number;
} {
  let availableCents = toCents(paymentAmount);
  if (availableCents <= 0) {
    const overdueCents = debts
      .filter((d) => isDueDatePassed(d.dueDate, today))
      .reduce((s, d) => s + toCents(d.remainingBalance), 0);
    const totalCents = debts.reduce((s, d) => s + toCents(d.remainingBalance), 0);
    return {
      updatedDebts: debts.map((d) => ({ ...d })),
      totalApplied: 0,
      remainingOverdueBalance: fromCents(overdueCents),
      remainingCurrentBalance: fromCents(totalCents - overdueCents),
      totalRemainingBalance: fromCents(totalCents),
    };
  }

  // Ordenamos cronológicamente: primero vencidos por dueDate ascendente (más antiguos primero)
  // luego vigentes por dueDate ascendente
  const mutableDebts = debts.map((d) => ({ ...d }));

  const overdueIndices = mutableDebts
    .map((d, index) => ({ index, debt: d }))
    .filter((x) => isDueDatePassed(x.debt.dueDate, today) && toCents(x.debt.remainingBalance) > 0)
    .sort((a, b) => a.debt.dueDate.localeCompare(b.debt.dueDate) || a.debt.date.localeCompare(b.debt.date))
    .map((x) => x.index);

  const vigenteIndices = mutableDebts
    .map((d, index) => ({ index, debt: d }))
    .filter((x) => !isDueDatePassed(x.debt.dueDate, today) && toCents(x.debt.remainingBalance) > 0)
    .sort((a, b) => a.debt.dueDate.localeCompare(b.debt.dueDate) || a.debt.date.localeCompare(b.debt.date))
    .map((x) => x.index);

  let appliedTotalCents = 0;

  // 1. Primero amortizar lo vencido (más antiguo primero)
  for (const idx of overdueIndices) {
    if (availableCents <= 0) break;
    const debt = mutableDebts[idx];
    const remCents = toCents(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCents(newRemCents);
    availableCents -= payCents;
    appliedTotalCents += payCents;
  }

  // 2. Si sobra abono, amortizar lo vigente (más antiguo primero)
  for (const idx of vigenteIndices) {
    if (availableCents <= 0) break;
    const debt = mutableDebts[idx];
    const remCents = toCents(debt.remainingBalance);
    const payCents = Math.min(availableCents, remCents);
    const newRemCents = remCents - payCents;
    debt.remainingBalance = fromCents(newRemCents);
    availableCents -= payCents;
    appliedTotalCents += payCents;
  }

  const finalOverdueCents = mutableDebts
    .filter((d) => isDueDatePassed(d.dueDate, today))
    .reduce((s, d) => s + toCents(d.remainingBalance), 0);
  const finalTotalCents = mutableDebts.reduce((s, d) => s + toCents(d.remainingBalance), 0);
  const finalVigenteCents = finalTotalCents - finalOverdueCents;

  return {
    updatedDebts: mutableDebts,
    totalApplied: fromCents(appliedTotalCents),
    remainingOverdueBalance: fromCents(finalOverdueCents),
    remainingCurrentBalance: fromCents(finalVigenteCents),
    totalRemainingBalance: fromCents(finalTotalCents),
  };
}

/**
 * Aplica un abono en efectivo a la cuenta de crédito de un cliente de forma pura.
 * Si el cliente tiene desglose de partidas (debts), ejecuta la asignación FIFO priorizando vencidas.
 */
export function applyCreditPaymentPure<T extends CreditCustomerLike>(
  cliente: T,
  paymentAmount: number,
  hoy: Date = new Date(),
  paymentNote?: string,
  paymentMethod: CreditPaymentMethod = 'EFECTIVO'
): { updatedCustomer: T; appliedAmount: number; changeOrExcess: number } {
  const balanceCents = toCents(cliente.currentBalance);
  const payCents = toCents(paymentAmount);
  if (payCents <= 0 || balanceCents <= 0) {
    return {
      updatedCustomer: { ...cliente },
      appliedAmount: 0,
      changeOrExcess: payCents > 0 ? fromCents(payCents) : 0,
    };
  }

  // Si tiene desglose de partidas:
  if (Array.isArray(cliente.debts) && cliente.debts.length > 0) {
    const allocation = allocatePaymentToDebts(cliente.debts, paymentAmount, hoy);
    const excessCents = Math.max(0, payCents - toCents(allocation.totalApplied));

    // Determinar la fecha de vencimiento más representativa restante:
    let nextDueDate = cliente.dueDate;
    const remainingDebts = allocation.updatedDebts.filter((d) => toCents(d.remainingBalance) > 0);
    if (remainingDebts.length > 0) {
      const activeOverdue = remainingDebts.filter((d) => isDueDatePassed(d.dueDate, hoy));
      if (activeOverdue.length > 0) {
        activeOverdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        nextDueDate = activeOverdue[0].dueDate;
      } else {
        remainingDebts.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        nextDueDate = remainingDebts[0].dueDate;
      }
    }

    const candidate: T = {
      ...cliente,
      currentBalance: allocation.totalRemainingBalance,
      overdueBalance: allocation.remainingOverdueBalance,
      dueDate: nextDueDate,
      debts: allocation.updatedDebts,
    };

    if (allocation.totalApplied > 0) {
      const paymentRecord: CreditPaymentRecord = {
        id: `PAG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        date: hoy.toISOString(),
        amount: allocation.totalApplied,
        previousBalance: fromCents(balanceCents),
        remainingBalance: allocation.totalRemainingBalance,
        paymentMethod,
        note: paymentNote || (paymentMethod === 'EFECTIVO' ? 'Abono en efectivo' : `Abono por ${paymentMethod.toLowerCase()}`),
      };
      candidate.payments = Array.isArray(cliente.payments)
        ? [paymentRecord, ...cliente.payments]
        : [paymentRecord];
    }

    candidate.status = computeCreditStatus(candidate, hoy);

    return {
      updatedCustomer: candidate,
      appliedAmount: allocation.totalApplied,
      changeOrExcess: fromCents(excessCents),
    };
  }

  // Si no tiene desglose de partidas, aplica reducción proporcional sobre el saldo total y overdueBalance
  const appliedCents = Math.min(payCents, balanceCents);
  const newBalanceCents = balanceCents - appliedCents;
  const newBalance = fromCents(newBalanceCents);
  const excessCents = payCents - appliedCents;

  let newOverdueBalance = cliente.overdueBalance;
  if (typeof cliente.overdueBalance === 'number') {
    newOverdueBalance = fromCents(Math.max(0, toCents(cliente.overdueBalance) - appliedCents));
  }

  const candidate: T = {
    ...cliente,
    currentBalance: newBalance,
    overdueBalance: newOverdueBalance,
  };

  if (appliedCents > 0) {
    const paymentRecord: CreditPaymentRecord = {
      id: `PAG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      date: hoy.toISOString(),
      amount: fromCents(appliedCents),
      previousBalance: fromCents(balanceCents),
      remainingBalance: newBalance,
      paymentMethod,
      note: paymentNote || (paymentMethod === 'EFECTIVO' ? 'Abono en efectivo' : `Abono por ${paymentMethod.toLowerCase()}`),
    };
    candidate.payments = Array.isArray(cliente.payments)
      ? [paymentRecord, ...cliente.payments]
      : [paymentRecord];
  }

  const nextStatus = computeCreditStatus(candidate, hoy);
  candidate.status = nextStatus;

  return {
    updatedCustomer: candidate,
    appliedAmount: fromCents(appliedCents),
    changeOrExcess: fromCents(excessCents),
  };
}

/**
 * Carga una nueva venta a fiado a un cliente de forma pura.
 */
export function applyCreditSalePure<T extends CreditCustomerLike>(
  cliente: T,
  saleAmount: number,
  hoy: Date = new Date(),
  saleDetails?: { id?: string; date?: string; dueDate?: string; description?: string; saleFolio?: string }
): { ok: boolean; message: string; updatedCustomer?: T; availableCredit: number; favorAppliedAmount?: number } {
  const balanceCents = toCents(cliente.currentBalance);
  const limitCents = toCents(cliente.creditLimit);
  const saleCents = toCents(saleAmount);
  const favorCents = Math.max(0, toCents(cliente.creditFavorBalance || 0));
  const appliedFavorCents = Math.min(favorCents, saleCents);
  const netNewDebtCents = Math.max(0, saleCents - appliedFavorCents);
  const newFavorCents = favorCents - appliedFavorCents;
  const availableCents = Math.max(0, limitCents - balanceCents);

  const currentStatus = computeCreditStatus(cliente, hoy);
  if (currentStatus === 'VENCIDO') {
    return {
      ok: false,
      message: `Crédito bloqueado: el cliente tiene pagos vencidos ($${fromCents(balanceCents).toFixed(2)}).`,
      availableCredit: fromCents(availableCents),
    };
  }

  if (balanceCents + netNewDebtCents > limitCents) {
    return {
      ok: false,
      message: `Límite de crédito excedido. Disponible: $${fromCents(availableCents).toFixed(2)} de su límite de $${fromCents(limitCents).toFixed(2)}.`,
      availableCredit: fromCents(availableCents),
    };
  }

  const newBalanceCents = balanceCents + netNewDebtCents;
  const newDebts = Array.isArray(cliente.debts) ? [...cliente.debts] : (saleDetails ? [] : undefined);
  let saleDueDateStr: string | undefined;

  if (saleDetails && netNewDebtCents > 0) {
    const defaultDays = cliente.creditDays || 15;
    const saleDateStr = saleDetails.date || formatLocalDate(hoy);
    saleDueDateStr = saleDetails.dueDate || calculateCustomerDueDate(saleDateStr, defaultDays);

    newDebts?.push({
      id: saleDetails.id || `FIADO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      date: saleDateStr,
      dueDate: saleDueDateStr,
      originalAmount: fromCents(netNewDebtCents),
      remainingBalance: fromCents(netNewDebtCents),
      description: saleDetails.description || 'Compra a crédito POS',
      ...(saleDetails.saleFolio ? { saleFolio: saleDetails.saleFolio } : {}),
    });
  }

  const candidate: T = {
    ...cliente,
    currentBalance: fromCents(newBalanceCents),
    ...(cliente.creditFavorBalance !== undefined || newFavorCents > 0
      ? { creditFavorBalance: fromCents(newFavorCents) }
      : {}),
    ...(newDebts !== undefined ? { debts: newDebts } : {}),
    ...(saleDueDateStr && (!cliente.dueDate || cliente.currentBalance === 0) ? { dueDate: saleDueDateStr } : {}),
  };
  candidate.status = computeCreditStatus(candidate, hoy);

  const remainingAvailableCents = Math.max(0, limitCents - newBalanceCents);

  return {
    ok: true,
    message:
      appliedFavorCents > 0
        ? `Venta cargada con éxito (se aplicaron $${fromCents(appliedFavorCents).toFixed(2)} de saldo a favor). Saldo total: $${candidate.currentBalance.toFixed(2)}.`
        : `Venta cargada con éxito. Saldo total: $${candidate.currentBalance.toFixed(2)}.`,
    updatedCustomer: candidate,
    availableCredit: fromCents(remainingAvailableCents),
    favorAppliedAmount: fromCents(appliedFavorCents),
  };
}

/**
 * Absorbe deuda pendiente de un cliente ante una devolución de venta a fiado (Bloque H seguimiento):
 * - Nunca permite saldos de deuda negativos (topa la absorción en currentBalance -> $0.00).
 * - Prioriza partidas vinculadas al folio original y luego deuda pendiente por FIFO.
 * - Si la devolución supera el saldo deudor pendiente, registra el remanente como
 *   'SALDO_A_FAVOR' (creditFavorBalance) o como 'REEMBOLSO_EFECTIVO'.
 */
export function applyCreditReturnAbsorptionPure<T extends CreditCustomerLike>(
  cliente: T,
  refundAmount: number,
  options?: {
    saleFolio?: string;
    date?: Date;
    excessMode?: 'SALDO_A_FAVOR' | 'REEMBOLSO_EFECTIVO';
  }
): {
  updatedCustomer: T;
  revertedAmount: number;
  excessAmount: number;
  favorBalanceAdded: number;
  cashRefundAmount: number;
  excessResolution: CreditExcessResolution;
} {
  const hoy = options?.date || new Date();
  const excessMode = options?.excessMode || 'SALDO_A_FAVOR';
  const refundCents = Math.max(0, toCents(refundAmount));
  const oldBalanceCents = Math.max(0, toCents(cliente.currentBalance));
  const priorFavorCents = Math.max(0, toCents(cliente.creditFavorBalance || 0));

  if (refundCents <= 0) {
    return {
      updatedCustomer: { ...cliente },
      revertedAmount: 0,
      excessAmount: 0,
      favorBalanceAdded: 0,
      cashRefundAmount: 0,
      excessResolution: 'NINGUNO',
    };
  }

  let remainingRefundCents = refundCents;
  const folioTag = options?.saleFolio || '';
  const debtsCopy: CreditDebtItem[] = Array.isArray(cliente.debts)
    ? cliente.debts.map((d) => ({ ...d }))
    : [];

  if (debtsCopy.length > 0 && oldBalanceCents > 0) {
    if (folioTag) {
      for (const debt of debtsCopy) {
        if (remainingRefundCents <= 0) break;
        const matchesSale =
          debt.saleFolio === folioTag || (debt.description && debt.description.includes(folioTag));
        if (matchesSale) {
          const debtBalCents = Math.max(0, toCents(debt.remainingBalance));
          const deductCents = Math.min(debtBalCents, remainingRefundCents);
          debt.remainingBalance = fromCents(debtBalCents - deductCents);
          remainingRefundCents -= deductCents;
        }
      }
    }

    if (remainingRefundCents > 0) {
      for (const debt of debtsCopy) {
        if (remainingRefundCents <= 0) break;
        const debtBalCents = Math.max(0, toCents(debt.remainingBalance));
        if (debtBalCents > 0) {
          const deductCents = Math.min(debtBalCents, remainingRefundCents);
          debt.remainingBalance = fromCents(debtBalCents - deductCents);
          remainingRefundCents -= deductCents;
        }
      }
    }
  } else if (oldBalanceCents > 0) {
    const deductCents = Math.min(oldBalanceCents, remainingRefundCents);
    remainingRefundCents -= deductCents;
  }

  const maxAbsorbableCents = Math.min(oldBalanceCents, refundCents);
  const absorbedByLoopCents = refundCents - remainingRefundCents;
  const actualRevertedCents = Math.min(oldBalanceCents, absorbedByLoopCents);
  const newBalanceCents = Math.max(0, oldBalanceCents - actualRevertedCents);
  const excessCents = Math.max(0, refundCents - actualRevertedCents);

  const activeDebts = debtsCopy.filter((d) => toCents(d.remainingBalance) > 0);
  const favorAddedCents = excessMode === 'SALDO_A_FAVOR' ? excessCents : 0;
  const cashRefundCents = excessMode === 'REEMBOLSO_EFECTIVO' ? excessCents : 0;
  const excessResolution: CreditExcessResolution =
    excessCents > 0 ? excessMode : 'NINGUNO';

  const newFavorCents = priorFavorCents + favorAddedCents;

  let newOverdueBalance = cliente.overdueBalance;
  if (activeDebts.length > 0) {
    const overdueCents = activeDebts
      .filter((d) => isDueDatePassed(d.dueDate, hoy))
      .reduce((acc, d) => acc + toCents(d.remainingBalance), 0);
    newOverdueBalance = fromCents(overdueCents);
  } else if (newBalanceCents === 0) {
    newOverdueBalance = 0;
  } else if (typeof cliente.overdueBalance === 'number') {
    newOverdueBalance = fromCents(Math.max(0, toCents(cliente.overdueBalance) - actualRevertedCents));
  }

  const candidate: T = {
    ...cliente,
    currentBalance: fromCents(newBalanceCents),
    overdueBalance: newOverdueBalance,
    debts: activeDebts,
    ...(cliente.creditFavorBalance !== undefined || favorAddedCents > 0
      ? { creditFavorBalance: fromCents(newFavorCents) }
      : {}),
  };
  candidate.status = newBalanceCents === 0 ? 'AL_CORRIENTE' : computeCreditStatus(candidate, hoy);

  // Asegurar invariant maxAbsorbableCents >= actualRevertedCents >= 0
  void maxAbsorbableCents;

  return {
    updatedCustomer: candidate,
    revertedAmount: fromCents(actualRevertedCents),
    excessAmount: fromCents(excessCents),
    favorBalanceAdded: fromCents(favorAddedCents),
    cashRefundAmount: fromCents(cashRefundCents),
    excessResolution,
  };
}
