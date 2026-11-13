/**
 * Dominio puro de Tesorería y Movimientos de Caja (Bloque F2 y Bloque H).
 *
 * =====================================================================================
 * FÓRMULA OFICIAL DEL EFECTIVO TEÓRICO DEL CAJÓN:
 *
 *   Efectivo Teórico en Cajón =
 *       Fondo Inicial (openingCash / openingFloat)
 *     + Ventas de Contado en Efectivo (cashSalesTotal)
 *     + Abonos de Clientes en Efectivo (creditPaymentsReceived)
 *     + Entradas Extraordinarias de Caja (cashInTotal)
 *     - Salidas de Efectivo del Cajón (cashPayoutsTotal)
 *       [Pagos a proveedores pagados desde CAJA + Retiros / Gastos menores]
 *
 * REGLA ESTRICTA DE MEDIOS DE PAGO Y AISLAMIENTO DE FONDOS:
 * 1. Abonos en Efectivo:
 *    Entran físicamente en monedas y billetes al cajón del mostrador, por lo que SUMAN
 *    al arqueo y al efectivo teórico del turno.
 *
 * 2. Abonos por Transferencia Electrónica o Tarjeta Bancaria:
 *    Amortizan legítimamente la deuda del cliente (reduciendo su saldo pendiente y
 *    actualizando su estatus crediticio), pero NO ingresan efectivo físico al cajón.
 *    Por tanto, NO suman al efectivo teórico de caja y se registran como FONDO_EXTERNO
 *    con paymentMethod = 'TRANSFERENCIA' | 'TARJETA'.
 *
 * 3. Pagos a Proveedores desde Fondo Externo (Bolsillo del dueño):
 *    Liquidan la cuenta por pagar sin tocar el dinero del cajón; no descuentan de caja.
 *
 * 4. Pagos a Proveedores desde Caja (CAJA):
 *    Extraen dinero físico del cajón para pagar remisiones o facturas; descuentan de caja
 *    (cashPayoutsTotal) y requieren validación de saldo disponible y PIN si exceden el tope.
 * =====================================================================================
 */

export type CashMovementType = 'ENTRADA' | 'SALIDA';

export type CashMovementSource = 'CAJA' | 'FONDO_EXTERNO';

export type CashPaymentMethod = 'EFECTIVO' | 'TRANSFERENCIA' | 'TARJETA' | 'OTRO';

export interface CashMovement {
  id: string;
  type: CashMovementType;
  amount: number;
  amountCents: number;
  reason: string; // Motivo o concepto contable del movimiento
  user: string; // Cajero o usuario responsable
  reference: string; // Referencia documental, folio o comprobante
  date: string; // Fecha local de negocio en formato AAAA-MM-DD
  timestamp: string; // Marca de tiempo ISO completa (AAAA-MM-DDTHH:mm:ss.sssZ o con offset)
  source?: CashMovementSource; // Origen o destino de fondos (CAJA o FONDO_EXTERNO)
  paymentMethod?: CashPaymentMethod; // Medio de pago: EFECTIVO, TRANSFERENCIA, TARJETA, OTRO
  supplierId?: string; // Proveedor asociado en pagos de CxP
  debtId?: string; // Factura o nota asociada si hubo amortización específica
  notes?: string;
}

export interface TheoreticalDrawerCashParams {
  /** Fondo inicial o flotante de apertura */
  openingFloat: number;
  /** Total de ventas de mostrador cobradas en efectivo */
  cashSales: number;
  /** Total de abonos de clientes cobrados exclusivamente en efectivo */
  cashCreditPayments: number;
  /** Entradas extraordinarias de efectivo registradas en el cajón */
  cashIn?: number;
  /** Salidas de efectivo del cajón (pagos a proveedores en efectivo, retiros) */
  cashPayouts?: number;
}

/**
 * Calcula el efectivo teórico que debe existir físicamente en el cajón
 * mediante aritmética de centavos enteros.
 */
export function calculateTheoreticalDrawerCash(params: TheoreticalDrawerCashParams): number {
  const openingCents = Math.round((Number(params.openingFloat) || 0) * 100);
  const salesCents = Math.round((Number(params.cashSales) || 0) * 100);
  const abonosCents = Math.round((Number(params.cashCreditPayments) || 0) * 100);
  const inCents = Math.round((Number(params.cashIn) || 0) * 100);
  const payoutsCents = Math.round((Number(params.cashPayouts) || 0) * 100);

  const theoreticalCents = openingCents + salesCents + abonosCents + inCents - payoutsCents;
  return Math.round(theoreticalCents) / 100;
}

let cashSequence = 0;

/**
 * Genera un identificador único para movimientos de caja.
 */
export function generateCashMovementId(): string {
  cashSequence = (cashSequence + 1) % 1_000_000;
  return `CM-${Date.now()}-${cashSequence}`;
}

/**
 * Crea un movimiento de caja con montos en centavos enteros, fecha local AAAA-MM-DD
 * y timestamp ISO completo garantizado.
 */
export function createCashMovement(params: {
  type: CashMovementType;
  amount: number;
  reason: string;
  user: string;
  reference: string;
  date?: string;
  timestamp?: string;
  source?: CashMovementSource;
  paymentMethod?: CashPaymentMethod;
  supplierId?: string;
  debtId?: string;
  notes?: string;
}): CashMovement {
  const amountCents = Math.round((Number(params.amount) || 0) * 100);
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const localDateStr = params.date || `${year}-${month}-${day}`;
  const isoTimestamp = params.timestamp || now.toISOString();

  const source = params.source || 'CAJA';
  const paymentMethod = params.paymentMethod || (source === 'CAJA' ? 'EFECTIVO' : 'OTRO');

  return {
    id: generateCashMovementId(),
    type: params.type,
    amount: amountCents / 100,
    amountCents,
    reason: String(params.reason || '').trim(),
    user: String(params.user || '').trim(),
    reference: String(params.reference || '').trim(),
    date: localDateStr,
    timestamp: isoTimestamp,
    source,
    paymentMethod,
    supplierId: params.supplierId,
    debtId: params.debtId,
    notes: params.notes,
  };
}

/**
 * Ordena una lista de movimientos de caja por su timestamp ISO completo.
 * Si direction es 'desc' (por defecto), los movimientos más recientes quedan al inicio.
 * Si direction es 'asc', quedan en orden cronológico histórico.
 */
export function sortCashMovementsByTimestamp(
  movements: readonly CashMovement[],
  direction: 'asc' | 'desc' = 'desc'
): CashMovement[] {
  return [...movements].sort((a, b) => {
    const timeA = a.timestamp || a.date || '';
    const timeB = b.timestamp || b.date || '';
    const comp = timeA.localeCompare(timeB);
    if (comp !== 0) {
      return direction === 'asc' ? comp : -comp;
    }
    return direction === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  });
}

export interface ReconciledMovementItem {
  movement: CashMovement;
  /** Indica si este movimiento afectó físicamente el dinero en el cajón */
  affectsDrawerCash: boolean;
  /** Impacto neto en centavos sobre el cajón físico (+entrada / -salida) */
  drawerImpactCents: number;
  /** Saldo teórico acumulado en centavos tras este movimiento */
  runningBalanceCents: number;
  /** Saldo teórico acumulado en pesos */
  runningBalance: number;
}

export interface CashReconciliationSummary {
  openingFloat: number;
  cashSales: number;
  cashCreditPayments: number;
  cashInTotal: number;
  cashOutTotal: number;
  nonCashInTotal: number;
  nonCashOutTotal: number;
  theoreticalDrawerCash: number;
  items: ReconciledMovementItem[];
}

/**
 * Concilia los movimientos de caja línea por línea en orden cronológico por timestamp.
 * Separa con precisión los movimientos físicos de cajón (source === 'CAJA' y paymentMethod === 'EFECTIVO')
 * de los movimientos de fondos externos o electrónicos (transferencia, tarjeta, fondo externo).
 */
export function reconcileCashMovements(
  openingFloat: number,
  cashSales: number,
  movements: readonly CashMovement[]
): CashReconciliationSummary {
  const openingCents = Math.round((Number(openingFloat) || 0) * 100);
  const salesCents = Math.round((Number(cashSales) || 0) * 100);
  let runningCents = openingCents + salesCents;

  let cashCreditPaymentsCents = 0;
  let cashInCents = 0;
  let cashOutCents = 0;
  let nonCashInCents = 0;
  let nonCashOutCents = 0;

  // Orden cronológico ascendente (más antiguo al más reciente) para calcular saldo acumulado
  const sortedAsc = sortCashMovementsByTimestamp(movements, 'asc');
  const items: ReconciledMovementItem[] = [];

  for (const m of sortedAsc) {
    const isCashDrawer = m.source === 'CAJA' && (!m.paymentMethod || m.paymentMethod === 'EFECTIVO');
    let drawerImpactCents = 0;

    if (isCashDrawer) {
      if (m.type === 'ENTRADA') {
        drawerImpactCents = m.amountCents;
        if (m.reason.toLowerCase().includes('abono')) {
          cashCreditPaymentsCents += m.amountCents;
        } else {
          cashInCents += m.amountCents;
        }
        runningCents += m.amountCents;
      } else {
        drawerImpactCents = -m.amountCents;
        cashOutCents += m.amountCents;
        runningCents -= m.amountCents;
      }
    } else {
      // Movimiento no en efectivo de cajón (Transferencia, Tarjeta o Fondo Externo)
      if (m.type === 'ENTRADA') {
        nonCashInCents += m.amountCents;
      } else {
        nonCashOutCents += m.amountCents;
      }
    }

    items.push({
      movement: m,
      affectsDrawerCash: isCashDrawer,
      drawerImpactCents,
      runningBalanceCents: runningCents,
      runningBalance: Math.round(runningCents) / 100,
    });
  }

  return {
    openingFloat: openingCents / 100,
    cashSales: salesCents / 100,
    cashCreditPayments: cashCreditPaymentsCents / 100,
    cashInTotal: cashInCents / 100,
    cashOutTotal: cashOutCents / 100,
    nonCashInTotal: nonCashInCents / 100,
    nonCashOutTotal: nonCashOutCents / 100,
    theoreticalDrawerCash: Math.round(runningCents) / 100,
    items,
  };
}


export type ShiftStatus = 'ABIERTO' | 'CERRADO';

export interface ShiftCutParams {
  openingCash: number;
  cashSales: number;
  creditPayments: number;
  cashIn: number;
  cashOut: number;
  physicalCash: number;
}

export interface ShiftCutResult {
  theoreticalCash: number;
  physicalCash: number;
  difference: number;
  differenceCents: number;
  status: 'CUADRADA' | 'SOBRANTE' | 'FALTANTE';
  statusLabel: string;
}

export interface ShiftCloseRecord {
  id: string; // e.g. "CORTE-20261112-113000"
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  authorizedBy: string; // Autorizado con PIN de Encargado/Admin
  openingCash: number;
  cashSales: number;
  creditPayments: number;
  cashIn: number;
  cashOut: number;
  theoreticalCash: number;
  physicalCash: number;
  difference: number;
  status: 'CUADRADA' | 'SOBRANTE' | 'FALTANTE';
  notes?: string;
}

/**
 * Calcula el arqueo y corte de caja:
 * Suma: ventas de contado + abonos + entradas - salidas (más fondo inicial)
 * Compara contra el conteo físico y reporta diferencia exacta (cuadrada, sobrante o faltante).
 */
export function calculateShiftCut(params: ShiftCutParams): ShiftCutResult {
  const theoretical = calculateTheoreticalDrawerCash({
    openingFloat: params.openingCash,
    cashSales: params.cashSales,
    cashCreditPayments: params.creditPayments,
    cashIn: params.cashIn,
    cashPayouts: params.cashOut,
  });
  const theoreticalCents = Math.round(theoretical * 100);
  const physicalCents = Math.round((Number(params.physicalCash) || 0) * 100);
  const diffCents = physicalCents - theoreticalCents;
  const difference = Math.round(diffCents) / 100;

  let status: 'CUADRADA' | 'SOBRANTE' | 'FALTANTE' = 'CUADRADA';
  let statusLabel = 'Caja Cuadrada ($0.00)';
  if (diffCents > 0) {
    status = 'SOBRANTE';
    statusLabel = `Sobrante de $${difference.toFixed(2)}`;
  } else if (diffCents < 0) {
    status = 'FALTANTE';
    statusLabel = `Faltante de $${Math.abs(difference).toFixed(2)}`;
  }

  return {
    theoreticalCash: theoretical,
    physicalCash: Math.round(physicalCents) / 100,
    difference,
    differenceCents: diffCents,
    status,
    statusLabel,
  };
}

/**
 * Valida el bloqueo de edición si el turno actual está cerrado.
 */
export function assertShiftOpen(isShiftOpen: boolean): { allowed: boolean; error?: string } {
  if (!isShiftOpen) {
    return {
      allowed: false,
      error: 'El turno de caja actual está cerrado con corte final. Abre un nuevo turno para realizar operaciones.',
    };
  }
  return { allowed: true };
}
