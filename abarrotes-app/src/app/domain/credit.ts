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

export interface CreditDebtItem {
  id: string;
  date: string; // ISO yyyy-mm-dd
  dueDate: string; // ISO yyyy-mm-dd
  originalAmount: number;
  remainingBalance: number;
  description?: string;
}

export interface CreditCustomerLike {
  id?: string;
  name?: string;
  creditLimit: number;
  currentBalance: number;
  dueDate?: string | Date;
  status?: CreditCustomerStatus;
  overdueBalance?: number;
  debts?: CreditDebtItem[];
  [key: string]: any;
}

/**
 * Determina si una fecha de vencimiento dada ya transcurrió respecto a 'hoy'.
 * Compara las fechas a nivel de día (YYYY-MM-DD) para evitar problemas de desfase horario.
 */
export function isDueDatePassed(dueDate: string | Date | undefined, today: Date = new Date()): boolean {
  if (!dueDate) return false;
  let dueStr: string;
  if (typeof dueDate === 'string') {
    dueStr = dueDate.trim().slice(0, 10);
  } else {
    dueStr = dueDate.toISOString().slice(0, 10);
  }

  const todayStr = today.toISOString().slice(0, 10);
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
  hoy: Date = new Date()
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
    // Si queda vencido, la fecha vencida más antigua; si solo queda vigente, la fecha vigente más próxima
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
  hoy: Date = new Date()
): { ok: boolean; message: string; updatedCustomer?: T; availableCredit: number } {
  const balanceCents = toCents(cliente.currentBalance);
  const limitCents = toCents(cliente.creditLimit);
  const saleCents = toCents(saleAmount);
  const availableCents = Math.max(0, limitCents - balanceCents);

  const currentStatus = computeCreditStatus(cliente, hoy);
  if (currentStatus === 'VENCIDO') {
    return {
      ok: false,
      message: `Crédito bloqueado: el cliente tiene pagos vencidos ($${fromCents(balanceCents).toFixed(2)}).`,
      availableCredit: fromCents(availableCents),
    };
  }

  if (balanceCents + saleCents > limitCents) {
    return {
      ok: false,
      message: `Límite de crédito excedido. Disponible: $${fromCents(availableCents).toFixed(2)} de su límite de $${fromCents(limitCents).toFixed(2)}.`,
      availableCredit: fromCents(availableCents),
    };
  }

  const newBalanceCents = balanceCents + saleCents;
  const candidate: T = {
    ...cliente,
    currentBalance: fromCents(newBalanceCents),
  };
  candidate.status = computeCreditStatus(candidate, hoy);

  const remainingAvailableCents = Math.max(0, limitCents - newBalanceCents);

  return {
    ok: true,
    message: `Venta cargada con éxito. Saldo total: $${candidate.currentBalance.toFixed(2)}.`,
    updatedCustomer: candidate,
    availableCredit: fromCents(remainingAvailableCents),
  };
}
