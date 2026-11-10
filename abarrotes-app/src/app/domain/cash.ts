/**
 * Dominio puro de Tesorería y Movimientos de Caja.
 * Tipo único CashMovement:
 * - Reutilizado en Bloque F2 para registro contable de pagos a proveedor (tanto de cajón como fondo externo).
 * - Diseñado para ser reutilizado en el Bloque H (retiros de efectivo, gastos varios y entradas extraordinarias).
 */

export type CashMovementType = 'ENTRADA' | 'SALIDA';

export type CashMovementSource = 'CAJA' | 'FONDO_EXTERNO';

export interface CashMovement {
  id: string;
  type: CashMovementType;
  amount: number;
  amountCents: number;
  reason: string; // Motivo o concepto contable del movimiento
  user: string; // Cajero o usuario responsable
  reference: string; // Referencia documental, folio o comprobante
  date: string; // Fecha local en formato AAAA-MM-DD
  timestamp?: string; // Marca de tiempo ISO exacta
  source?: CashMovementSource; // Origen o destino de fondos (CAJA o FONDO_EXTERNO)
  supplierId?: string; // Proveedor asociado en pagos de CxP
  debtId?: string; // Factura o nota asociada si hubo amortización específica
  notes?: string;
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
 * Crea un movimiento de caja con montos en centavos enteros y fecha local.
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

  return {
    id: generateCashMovementId(),
    type: params.type,
    amount: amountCents / 100,
    amountCents,
    reason: String(params.reason || '').trim(),
    user: String(params.user || '').trim(),
    reference: String(params.reference || '').trim(),
    date: localDateStr,
    timestamp: params.timestamp || now.toISOString(),
    source: params.source || 'CAJA',
    supplierId: params.supplierId,
    debtId: params.debtId,
    notes: params.notes,
  };
}
