/**
 * Lógica pura de dominio para créditos y fiado vecinal.
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

export interface CreditCustomerLike {
  id?: string;
  name?: string;
  creditLimit: number;
  currentBalance: number;
  dueDate?: string | Date;
  status?: CreditCustomerStatus;
  overdueBalance?: number;
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
 *
 * Regla de negocio obligatoria: Un abono parcial NO debe limpiar el estatus VENCIDO
 * si aún queda saldo con fecha vencida.
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

  // Verificar si hay saldo con fecha vencida
  const hasExplicitOverdue =
    typeof cliente.overdueBalance === 'number' && toCents(cliente.overdueBalance) > 0;
  const isDateExpired = isDueDatePassed(cliente.dueDate, hoy);

  // Si tiene saldo vencido explícito, o si su fecha límite ya pasó y aún tiene saldo > 0:
  // O si el cliente ya estaba en estatus VENCIDO y aún debe saldo sin haber extendido su fecha a futuro:
  const isOverdue =
    hasExplicitOverdue ||
    isDateExpired ||
    (cliente.status === 'VENCIDO' && (isDateExpired || !cliente.dueDate));

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
 * Aplica un abono en efectivo a la cuenta de crédito de un cliente de forma pura.
 * Retorna el cliente actualizado con su nuevo saldo y nuevo estatus calculado con computeCreditStatus.
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
 * Retorna error si el cliente está vencido o excede su límite de crédito.
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
