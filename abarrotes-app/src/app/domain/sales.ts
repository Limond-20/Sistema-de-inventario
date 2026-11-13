/**
 * Lógica pura de dominio para ventas, cancelaciones y devoluciones con contra-asientos (Bloque H).
 *
 * =====================================================================================
 * REGLAS DE ORO DE INMUTABILIDAD CONTABLE:
 * 1. NUNCA se modifican, eliminan ni sobrescriben ventas pasadas.
 * 2. Toda cancelación total o devolución parcial genera un CONTRA-ASIENTO (SaleReturnRecord).
 * 3. Reembolso neto exacto: Si la venta tuvo descuento por línea o prorrateo global de ticket,
 *    el monto reembolsable por cada partida y acumulado total se calcula exclusivamente sobre
 *    los centavos netos efectivamente cobrados (nunca sobre el precio de lista sin descuento).
 * 4. Reposición de inventario:
 *    - condition = 'VENDIBLE': Registra entrada DEVOLUCION_VENTA y suma al stock físico activo.
 *    - condition = 'MERMA': Registra DEVOLUCION_VENTA e inmediatamente encadena una salida MERMA
 *      en el Kardex para que la contabilidad financiera cuadre sin inflar stock vendible.
 * 5. Reversión de pago:
 *    - Si fue en EFECTIVO: Extrae efectivo del cajón (CashMovement SALIDA), reduciendo el efectivo físico y teórico.
 *    - Si fue a FIADO: Absorbe primero la deuda pendiente del cliente hasta dejarla en $0.00
 *      (sin saldos negativos) y registra cualquier excedente por abonos previos como
 *      saldo a favor (SALDO_A_FAVOR) o reembolso en efectivo (REEMBOLSO_EFECTIVO).
 * 6. Toda devolución o cancelación exige PIN de encargado/administrador y un motivo obligatorio.
 * =====================================================================================
 */

import type { CreditCustomerLike, CreditDebtItem, CreditExcessResolution } from './credit';

export type SaleStatus = 'COMPLETADA' | 'DEVOLUCION_PARCIAL' | 'CANCELADA';
export type SalePaymentType = 'EFECTIVO' | 'FIADO';
export type ReturnCondition = 'VENDIBLE' | 'MERMA';

export interface SaleLineItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  subtotal: number; // Importe NETO efectivamente cobrado (en pesos)
  subtotalCents: number; // Importe NETO efectivamente cobrado (en centavos enteros)
  grossSubtotal?: number; // Importe bruto antes de descuentos manuales/ticket
  grossSubtotalCents?: number;
  discountAmount?: number; // Descuento total aplicado a esta partida (línea + prorrateo)
  discountCents?: number;
  effectiveUnitPrice?: number; // Precio unitario neto cobrado = subtotal / qty
  saleUnit?: string;
  tier?: string;
  returnedQty: number; // Cantidad total acumulada devuelta (0 <= returnedQty <= qty)
  returnedAmountCents?: number; // Centavos acumulados ya reembolsados en contra-asientos previos
}

export interface SaleReturnLineItem {
  sku: string;
  name: string;
  qty: number; // Cantidad devuelta en este contra-asiento específico (> 0)
  unitPrice: number;
  effectiveUnitPrice?: number;
  refundAmount: number;
  refundAmountCents: number;
  saleUnit?: string;
  condition?: ReturnCondition;
}

export interface SaleReturnRecord {
  id: string; // e.g. "DEV-1001-1"
  saleFolio: string; // Folio de la venta original (e.g. "V-1001")
  saleId: string;
  timestamp: string; // ISO 8601
  date: string; // AAAA-MM-DD local
  user: string; // Cajero u operador que procesó la devolución
  authorizedBy: string; // Encargado o Administrador que autorizó con PIN
  reason: string; // Motivo obligatorio
  condition?: ReturnCondition; // Destino físico del producto devuelto
  paymentType: SalePaymentType;
  customerId?: string;
  customerName?: string;
  items: SaleReturnLineItem[];
  totalRefund: number;
  totalRefundCents: number;
  isFullCancellation: boolean;
  creditDebtReverted?: number;
  creditDebtRevertedCents?: number;
  excessRefundAmount?: number;
  excessRefundAmountCents?: number;
  excessResolution?: CreditExcessResolution;
  cashRefundAmount?: number;
  cashRefundAmountCents?: number;
}

export interface SaleRecord {
  id: string; // ID único interno, e.g. "SALE-1700000000000-V-1001"
  folio: string; // Folio de ticket amigable, e.g. "V-1001"
  timestamp: string; // ISO 8601
  date: string; // AAAA-MM-DD local
  cashier: string; // Cajero u operador activo
  paymentType: SalePaymentType;
  customerId?: string; // Si fue a fiado
  customerName?: string;
  customerPreviousBalance?: number; // Saldo deudor antes de esta compra
  customerNewBalance?: number; // Saldo deudor resultante tras esta compra
  items: SaleLineItem[];
  subtotal: number;
  discountAmount?: number;
  total: number;
  totalCents: number;
  cashReceived?: number;
  change?: number;
  status: SaleStatus;
  reprintCount: number; // Veces que se ha reimpreso el ticket desde el historial
  returns: SaleReturnRecord[]; // Historial de contra-asientos
}

function formatLocalYyyyMmDd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function roundQty3(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}

let saleSequence = 0;

/**
 * Consulta el siguiente folio de venta correlativo sin consumir la secuencia global.
 */
export function peekNextSaleFolio(existingSalesCount: number = 0): string {
  const nextSeq = Math.max(saleSequence, existingSalesCount) + 1;
  return `V-${1000 + nextSeq}`;
}

/**
 * Genera un folio correlativo legible para tickets de venta (e.g. V-1001, V-1002).
 */
export function generateSaleFolio(existingSalesCount: number = 0): string {
  saleSequence = Math.max(saleSequence, existingSalesCount) + 1;
  return `V-${1000 + saleSequence}`;
}

/**
 * Genera un ID único para un contra-asiento de devolución.
 */
export function generateReturnId(saleFolio: string, returnIndex: number = 0): string {
  return `DEV-${saleFolio.replace('V-', '')}-${returnIndex + 1}`;
}

export interface CreateSaleLineInput {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
  grossSubtotal?: number;
  grossSubtotalCents?: number;
  netSubtotal?: number;
  netSubtotalCents?: number;
  discountAmount?: number;
  discountPct?: number;
  saleUnit?: string;
  tier?: string;
}

/**
 * Crea un registro inmutable de venta (SaleRecord) con centavos enteros.
 * Prorratea cualquier descuento de línea o global por ticket sobre cada partida
 * para garantizar que las devoluciones parciales reembolsen exactamente lo cobrado.
 */
export function createSaleRecord(params: {
  folio?: string;
  existingSalesCount?: number;
  cashier: string;
  paymentType: SalePaymentType;
  items: CreateSaleLineInput[];
  discountAmount?: number;
  itemsAlreadyNet?: boolean;
  cashReceived?: number;
  change?: number;
  customerId?: string;
  customerName?: string;
  customerPreviousBalance?: number;
  customerNewBalance?: number;
  timestamp?: string;
  date?: string;
}): SaleRecord {
  const now = new Date();
  const localDate = params.date || formatLocalYyyyMmDd(now);
  const isoTimestamp = params.timestamp || now.toISOString();

  const folio = params.folio || generateSaleFolio(params.existingSalesCount ?? 0);
  if (params.folio) {
    const parsedNum = Number(params.folio.replace(/^V-/, ''));
    if (!isNaN(parsedNum) && parsedNum >= 1000) {
      saleSequence = Math.max(saleSequence, parsedNum - 1000);
    }
  }
  const id = `SALE-${Date.now()}-${folio}`;

  let grossTotalCents = 0;
  let totalNetCents = 0;
  let lineItems: SaleLineItem[] = [];

  if (params.itemsAlreadyNet) {
    lineItems = params.items.map((i) => {
      const qty = roundQty3(i.qty);
      const netCents = Math.max(
        0,
        i.netSubtotalCents !== undefined
          ? Math.round(i.netSubtotalCents)
          : i.netSubtotal !== undefined
          ? Math.round(i.netSubtotal * 100)
          : Math.round(i.subtotal * 100)
      );
      const defaultGrossCents = Math.max(netCents, Math.round(i.unitPrice * qty * 100));
      const grossCents =
        i.grossSubtotalCents !== undefined
          ? Math.max(netCents, Math.round(i.grossSubtotalCents))
          : i.grossSubtotal !== undefined
          ? Math.max(netCents, Math.round(i.grossSubtotal * 100))
          : defaultGrossCents;
      const lineDiscCents = Math.max(0, grossCents - netCents);
      grossTotalCents += grossCents;
      totalNetCents += netCents;
      const effUnitPrice = qty > 0 ? Math.round((netCents / qty)) / 100 : Math.round(i.unitPrice * 100) / 100;
      return {
        sku: i.sku,
        name: i.name,
        qty,
        unitPrice: Math.round(i.unitPrice * 100) / 100,
        subtotal: netCents / 100,
        subtotalCents: netCents,
        grossSubtotal: grossCents / 100,
        grossSubtotalCents: grossCents,
        discountAmount: lineDiscCents / 100,
        discountCents: lineDiscCents,
        effectiveUnitPrice: effUnitPrice,
        saleUnit: i.saleUnit || 'Pieza',
        tier: i.tier,
        returnedQty: 0,
        returnedAmountCents: 0,
      };
    });

    const explicitDiscCents = Math.max(0, Math.round((params.discountAmount || 0) * 100));
    const derivedDiscCents = Math.max(explicitDiscCents, grossTotalCents - totalNetCents);
    const displaySubtotalCents = Math.max(grossTotalCents, totalNetCents + explicitDiscCents);

    return {
      id,
      folio,
      timestamp: isoTimestamp,
      date: localDate,
      cashier: params.cashier.trim() || 'Cajero',
      paymentType: params.paymentType,
      customerId: params.customerId,
      customerName: params.customerName,
      customerPreviousBalance: params.customerPreviousBalance,
      customerNewBalance: params.customerNewBalance,
      items: lineItems,
      subtotal: displaySubtotalCents / 100,
      discountAmount: derivedDiscCents / 100,
      total: totalNetCents / 100,
      totalCents: totalNetCents,
      cashReceived: params.cashReceived,
      change: params.change,
      status: 'COMPLETADA',
      reprintCount: 0,
      returns: [],
    };
  }

  // Modo estándar (items con subtotal bruto o con descuento explícito por línea y/o global)
  const preTicketLines = params.items.map((i) => {
    const qty = roundQty3(i.qty);
    const inputCents = Math.max(0, Math.round(i.subtotal * 100));
    const grossCents =
      i.grossSubtotalCents !== undefined
        ? Math.max(inputCents, Math.round(i.grossSubtotalCents))
        : i.grossSubtotal !== undefined
        ? Math.max(inputCents, Math.round(i.grossSubtotal * 100))
        : Math.max(inputCents, Math.round(i.unitPrice * qty * 100));

    let afterLineDiscountCents = inputCents;
    if (i.netSubtotalCents !== undefined) {
      afterLineDiscountCents = Math.max(0, Math.min(grossCents, Math.round(i.netSubtotalCents)));
    } else if (i.netSubtotal !== undefined) {
      afterLineDiscountCents = Math.max(0, Math.min(grossCents, Math.round(i.netSubtotal * 100)));
    } else if (i.discountAmount && i.discountAmount > 0) {
      afterLineDiscountCents = Math.max(0, inputCents - Math.round(i.discountAmount * 100));
    } else if (i.discountPct && i.discountPct > 0) {
      const disc = Math.round(inputCents * (Math.min(100, i.discountPct) / 100));
      afterLineDiscountCents = Math.max(0, inputCents - disc);
    }

    grossTotalCents += grossCents;
    return {
      raw: i,
      qty,
      grossCents,
      afterLineDiscountCents,
    };
  });

  const subtotalAfterLineDiscountsCents = preTicketLines.reduce((acc, l) => acc + l.afterLineDiscountCents, 0);
  const ticketDiscountCents = Math.min(
    subtotalAfterLineDiscountsCents,
    Math.max(0, Math.round((params.discountAmount || 0) * 100))
  );
  const finalTotalCents = Math.max(0, subtotalAfterLineDiscountsCents - ticketDiscountCents);

  // Prorratear descuento global de ticket en centavos enteros entre las líneas con saldo positivo
  let allocatedCents = preTicketLines.map((l) => {
    if (ticketDiscountCents === 0 || subtotalAfterLineDiscountsCents <= 0 || l.afterLineDiscountCents <= 0) {
      return l.afterLineDiscountCents;
    }
    return Math.round((l.afterLineDiscountCents * finalTotalCents) / subtotalAfterLineDiscountsCents);
  });

  const allocatedSum = allocatedCents.reduce((a, b) => a + b, 0);
  const roundingResidual = finalTotalCents - allocatedSum;
  if (roundingResidual !== 0 && allocatedCents.length > 0) {
    for (let idx = allocatedCents.length - 1; idx >= 0; idx--) {
      if (preTicketLines[idx].afterLineDiscountCents > 0 || idx === 0) {
        allocatedCents[idx] = Math.max(0, allocatedCents[idx] + roundingResidual);
        break;
      }
    }
  }

  lineItems = preTicketLines.map((l, idx) => {
    const finalLineCents = allocatedCents[idx] ?? 0;
    const lineDiscCents = Math.max(0, l.grossCents - finalLineCents);
    const effUnitPrice =
      l.qty > 0 ? Math.round((finalLineCents / l.qty)) / 100 : Math.round(l.raw.unitPrice * 100) / 100;
    return {
      sku: l.raw.sku,
      name: l.raw.name,
      qty: l.qty,
      unitPrice: Math.round(l.raw.unitPrice * 100) / 100,
      subtotal: finalLineCents / 100,
      subtotalCents: finalLineCents,
      grossSubtotal: l.grossCents / 100,
      grossSubtotalCents: l.grossCents,
      discountAmount: lineDiscCents / 100,
      discountCents: lineDiscCents,
      effectiveUnitPrice: effUnitPrice,
      saleUnit: l.raw.saleUnit || 'Pieza',
      tier: l.raw.tier,
      returnedQty: 0,
      returnedAmountCents: 0,
    };
  });

  totalNetCents = lineItems.reduce((acc, item) => acc + item.subtotalCents, 0);
  const lineDiscountSumCents = Math.max(0, grossTotalCents - subtotalAfterLineDiscountsCents);
  const totalDiscountCents = ticketDiscountCents + lineDiscountSumCents;
  const displaySubtotalCents =
    lineDiscountSumCents > 0 ? grossTotalCents : subtotalAfterLineDiscountsCents;

  return {
    id,
    folio,
    timestamp: isoTimestamp,
    date: localDate,
    cashier: params.cashier.trim() || 'Cajero',
    paymentType: params.paymentType,
    customerId: params.customerId,
    customerName: params.customerName,
    customerPreviousBalance: params.customerPreviousBalance,
    customerNewBalance: params.customerNewBalance,
    items: lineItems,
    subtotal: displaySubtotalCents / 100,
    discountAmount: totalDiscountCents / 100,
    total: totalNetCents / 100,
    totalCents: totalNetCents,
    cashReceived: params.cashReceived,
    change: params.change,
    status: 'COMPLETADA',
    reprintCount: 0,
    returns: [],
  };
}

export interface ReturnItemRequest {
  sku: string;
  qty: number;
  condition?: ReturnCondition;
}

/**
 * Valida si una solicitud de devolución o cancelación de venta es procedente.
 * Acumula solicitudes repetidas por SKU para impedir devolver por encima de
 * maxReturnableQty = originalSoldQty - alreadyReturnedQty.
 */
export function validateSaleReturn(
  sale: SaleRecord,
  itemsToReturn: ReturnItemRequest[],
  reason: string,
  options?: { condition?: ReturnCondition }
): { valid: boolean; error?: string } {
  if (!sale) {
    return { valid: false, error: 'Venta no encontrada.' };
  }

  if (sale.status === 'CANCELADA') {
    return { valid: false, error: `La venta #${sale.folio} ya fue cancelada en su totalidad anteriormente.` };
  }

  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3) {
    return { valid: false, error: 'Debes ingresar un motivo descriptivo para la devolución (mínimo 3 caracteres).' };
  }

  if (options?.condition && options.condition !== 'VENDIBLE' && options.condition !== 'MERMA') {
    return { valid: false, error: `Condición de producto inválida: "${options.condition}". Usa VENDIBLE o MERMA.` };
  }

  if (!itemsToReturn || itemsToReturn.length === 0) {
    return { valid: false, error: 'Debes seleccionar al menos un producto para devolver.' };
  }

  const accumulatedBySku = new Map<string, number>();

  for (const req of itemsToReturn) {
    if (req.condition && req.condition !== 'VENDIBLE' && req.condition !== 'MERMA') {
      return { valid: false, error: `Condición de devolución inválida para SKU ${req.sku}.` };
    }
    if (typeof req.qty !== 'number' || isNaN(req.qty) || req.qty <= 0) {
      return { valid: false, error: `Cantidad a devolver inválida para el producto con SKU ${req.sku}.` };
    }

    const line = sale.items.find((i) => i.sku === req.sku);
    if (!line) {
      return { valid: false, error: `El producto con SKU ${req.sku} no forma parte de la venta #${sale.folio}.` };
    }

    const combinedQty = roundQty3((accumulatedBySku.get(req.sku) || 0) + req.qty);
    accumulatedBySku.set(req.sku, combinedQty);

    const alreadyReturned = line.returnedQty || 0;
    const maxReturnableQty = roundQty3(Math.max(0, line.qty - alreadyReturned));

    if (combinedQty > maxReturnableQty + 1e-6) {
      return {
        valid: false,
        error: `No puedes devolver ${combinedQty} ${line.saleUnit || 'pz'} de ${line.name}. Solo quedan ${maxReturnableQty} disponibles para devolución.`,
      };
    }
  }

  let totalQtyRequested = 0;
  for (const qty of accumulatedBySku.values()) {
    totalQtyRequested += qty;
  }
  if (totalQtyRequested <= 0) {
    return { valid: false, error: 'La cantidad total a devolver debe ser mayor a 0.' };
  }

  return { valid: true };
}

function resolvePriorLineRefundedCents(sale: SaleRecord, line: SaleLineItem): number {
  if (typeof line.returnedAmountCents === 'number' && !isNaN(line.returnedAmountCents)) {
    return Math.max(0, Math.round(line.returnedAmountCents));
  }
  return (sale.returns || []).reduce((sum, r) => {
    const matched = (r.items || []).filter((ri) => ri.sku === line.sku);
    return sum + matched.reduce((s, ri) => s + Math.round(ri.refundAmountCents || 0), 0);
  }, 0);
}

function resolveEffectiveLineNetCents(sale: SaleRecord, line: SaleLineItem): number {
  const rawLineCents = Math.max(0, Math.round(line.subtotalCents || line.subtotal * 100));
  const sumLinesCents = sale.items.reduce(
    (acc, it) => acc + Math.max(0, Math.round(it.subtotalCents || it.subtotal * 100)),
    0
  );
  const saleTotalCents = Math.max(0, Math.round(sale.totalCents ?? sale.total * 100));
  // Compatibilidad con tickets heredados donde subtotalCents no reflejó descuento global
  if (sumLinesCents > saleTotalCents && sumLinesCents > 0) {
    return Math.round((rawLineCents * saleTotalCents) / sumLinesCents);
  }
  return rawLineCents;
}

/**
 * Calcula en centavos enteros el reembolso neto exacto para una línea dada una cantidad `reqQty`.
 * - Usa el importe neto cobrado real de la partida (descontando descuentos de línea/ticket).
 * - Evita deriva de redondeo en devoluciones parciales sucesivas mediante cálculo acumulado.
 * - Garantiza que nunca se reembolse más de lo cobrado en la línea ni en el ticket completo.
 */
export function calculateSaleReturnLineRefundCents(
  sale: SaleRecord,
  line: SaleLineItem,
  reqQty: number
): number {
  if (!line || line.qty <= 0 || reqQty <= 0) return 0;

  const effectiveLineNetCents = resolveEffectiveLineNetCents(sale, line);
  const priorLineRefundedCents = resolvePriorLineRefundedCents(sale, line);
  const remainingLineCents = Math.max(0, effectiveLineNetCents - priorLineRefundedCents);

  const alreadyReturnedQty = line.returnedQty || 0;
  const maxReturnableQty = roundQty3(Math.max(0, line.qty - alreadyReturnedQty));
  if (maxReturnableQty <= 0 || remainingLineCents <= 0) return 0;

  const boundedQty = Math.min(reqQty, maxReturnableQty);
  if (boundedQty >= maxReturnableQty - 1e-6) {
    return remainingLineCents;
  }

  const targetTotalReturnedQty = Math.min(line.qty, alreadyReturnedQty + boundedQty);
  const targetCumulativeCents = Math.round((targetTotalReturnedQty * effectiveLineNetCents) / line.qty);
  return Math.max(0, Math.min(remainingLineCents, targetCumulativeCents - priorLineRefundedCents));
}

/**
 * Calcula una previsualización exacta del reembolso total y por línea en centavos y pesos.
 */
export function previewSaleReturnRefund(
  sale: SaleRecord,
  itemsToReturn: ReturnItemRequest[]
): { lineRefundsCents: Record<string, number>; totalRefundCents: number; totalRefund: number } {
  const lineRefundsCents: Record<string, number> = {};
  if (!sale || !Array.isArray(itemsToReturn)) {
    return { lineRefundsCents, totalRefundCents: 0, totalRefund: 0 };
  }

  const qtyBySku = new Map<string, number>();
  for (const req of itemsToReturn) {
    if (typeof req.qty === 'number' && req.qty > 0) {
      qtyBySku.set(req.sku, roundQty3((qtyBySku.get(req.sku) || 0) + req.qty));
    }
  }

  const priorSaleRefundedCents = (sale.returns || []).reduce(
    (sum, r) => sum + Math.max(0, Math.round(r.totalRefundCents || r.totalRefund * 100)),
    0
  );
  const saleTotalCents = Math.max(0, Math.round(sale.totalCents ?? sale.total * 100));
  const maxRemainingSaleCents = Math.max(0, saleTotalCents - priorSaleRefundedCents);

  let runningTotalCents = 0;
  for (const [sku, qty] of qtyBySku.entries()) {
    const line = sale.items.find((i) => i.sku === sku);
    if (!line) continue;
    let cents = calculateSaleReturnLineRefundCents(sale, line, qty);
    const availableForTicket = Math.max(0, maxRemainingSaleCents - runningTotalCents);
    if (cents > availableForTicket) {
      cents = availableForTicket;
    }
    lineRefundsCents[sku] = cents;
    runningTotalCents += cents;
  }

  return {
    lineRefundsCents,
    totalRefundCents: runningTotalCents,
    totalRefund: runningTotalCents / 100,
  };
}

/**
 * Aplica una devolución o cancelación pura (contra-asiento contable inmutable).
 * Retorna el nuevo contra-asiento y la venta actualizada (sin mutación destructiva).
 */
export function applySaleReturnPure(
  sale: SaleRecord,
  params: {
    itemsToReturn: ReturnItemRequest[];
    user: string;
    authorizedBy: string;
    reason: string;
    condition?: ReturnCondition;
    timestamp?: string;
    date?: string;
  }
): { returnRecord: SaleReturnRecord; updatedSale: SaleRecord } {
  const defaultCondition: ReturnCondition = params.condition || 'VENDIBLE';
  const validation = validateSaleReturn(sale, params.itemsToReturn, params.reason, {
    condition: defaultCondition,
  });
  if (!validation.valid) {
    throw new Error(validation.error || 'Devolución no válida');
  }

  const now = new Date();
  const localDate = params.date || formatLocalYyyyMmDd(now);
  const isoTimestamp = params.timestamp || now.toISOString();

  const returnIndex = (sale.returns || []).length;
  const returnId = generateReturnId(sale.folio, returnIndex);

  // Consolidar solicitudes por SKU manteniendo condición explícita si existe
  const consolidatedRequests = new Map<string, { qty: number; condition: ReturnCondition }>();
  for (const req of params.itemsToReturn) {
    const prev = consolidatedRequests.get(req.sku);
    consolidatedRequests.set(req.sku, {
      qty: roundQty3((prev?.qty || 0) + req.qty),
      condition: req.condition || prev?.condition || defaultCondition,
    });
  }

  const refundPreview = previewSaleReturnRefund(
    sale,
    Array.from(consolidatedRequests.entries()).map(([sku, val]) => ({
      sku,
      qty: val.qty,
      condition: val.condition,
    }))
  );

  const returnLines: SaleReturnLineItem[] = [];
  for (const [sku, reqVal] of consolidatedRequests.entries()) {
    const line = sale.items.find((i) => i.sku === sku)!;
    const refundCents = refundPreview.lineRefundsCents[sku] ?? 0;
    const effUnitPrice =
      reqVal.qty > 0
        ? Math.round((refundCents / reqVal.qty)) / 100
        : line.effectiveUnitPrice ?? line.unitPrice;

    returnLines.push({
      sku: line.sku,
      name: line.name,
      qty: reqVal.qty,
      unitPrice: line.unitPrice,
      effectiveUnitPrice: effUnitPrice,
      refundAmount: refundCents / 100,
      refundAmountCents: refundCents,
      saleUnit: line.saleUnit,
      condition: reqVal.condition,
    });
  }

  const totalRefundCents = refundPreview.totalRefundCents;

  // Actualizar copia inmutable de la venta
  const updatedItems: SaleLineItem[] = sale.items.map((line) => {
    const reqVal = consolidatedRequests.get(line.sku);
    if (!reqVal) {
      return { ...line };
    }
    const lineRefundCents = refundPreview.lineRefundsCents[line.sku] ?? 0;
    const priorReturnedCents = resolvePriorLineRefundedCents(sale, line);
    const newReturnedQty = roundQty3((line.returnedQty || 0) + reqVal.qty);
    return {
      ...line,
      returnedQty: newReturnedQty,
      returnedAmountCents: priorReturnedCents + lineRefundCents,
    };
  });

  // Determinar si es cancelación total (todos los productos fueron devueltos en su totalidad)
  const isFullCancellation = updatedItems.every((item) => item.returnedQty >= item.qty - 1e-6);
  const newStatus: SaleStatus = isFullCancellation ? 'CANCELADA' : 'DEVOLUCION_PARCIAL';

  const returnRecord: SaleReturnRecord = {
    id: returnId,
    saleFolio: sale.folio,
    saleId: sale.id,
    timestamp: isoTimestamp,
    date: localDate,
    user: params.user.trim() || 'Cajero',
    authorizedBy: params.authorizedBy.trim() || 'Encargado',
    reason: params.reason.trim(),
    condition: defaultCondition,
    paymentType: sale.paymentType,
    customerId: sale.customerId,
    customerName: sale.customerName,
    items: returnLines,
    totalRefund: totalRefundCents / 100,
    totalRefundCents,
    isFullCancellation,
    ...(sale.paymentType === 'EFECTIVO'
      ? {
          cashRefundAmount: totalRefundCents / 100,
          cashRefundAmountCents: totalRefundCents,
          excessResolution: 'NINGUNO' as CreditExcessResolution,
        }
      : {}),
  };

  const updatedSale: SaleRecord = {
    ...sale,
    status: newStatus,
    items: updatedItems,
    returns: [...(sale.returns || []), returnRecord],
  };

  return {
    returnRecord,
    updatedSale,
  };
}

/**
 * Revierte la deuda de un cliente en la libreta digital de fiados tras una devolución:
 * - Reduce el saldo pendiente en el cliente por el monto reembolsado, nunca por debajo de $0.00.
 * - Amortiza primero las partidas asociadas al folio de la venta y luego las pendientes por FIFO.
 * - Si el reembolso excede el saldo deudor pendiente (ej. por abonos previos), absorbe la deuda
 *   hasta $0.00 y registra el remanente como saldo a favor ('SALDO_A_FAVOR') o reembolso en efectivo
 *   ('REEMBOLSO_EFECTIVO'), sin generar jamás saldos de deuda negativos.
 */
export function revertCustomerCreditDebtFromReturn<T extends CreditCustomerLike>(
  customer: T,
  returnRecord: SaleReturnRecord,
  dateOrOptions:
    | Date
    | {
        date?: Date;
        excessMode?: 'SALDO_A_FAVOR' | 'REEMBOLSO_EFECTIVO';
      } = new Date()
): {
  updatedCustomer: T;
  revertedAmount: number;
  excessAmount: number;
  favorBalanceAdded: number;
  cashRefundAmount: number;
  excessResolution: CreditExcessResolution;
} {
  const isDate = dateOrOptions instanceof Date;
  const date = isDate ? dateOrOptions : dateOrOptions?.date || new Date();
  const excessMode: 'SALDO_A_FAVOR' | 'REEMBOLSO_EFECTIVO' = isDate
    ? 'SALDO_A_FAVOR'
    : dateOrOptions?.excessMode || 'SALDO_A_FAVOR';

  const refundCents = Math.max(
    0,
    Math.round(returnRecord.totalRefundCents ?? returnRecord.totalRefund * 100)
  );
  const oldBalanceCents = Math.max(0, Math.round((customer.currentBalance || 0) * 100));
  const priorFavorCents = Math.max(0, Math.round((customer.creditFavorBalance || 0) * 100));

  if (refundCents <= 0) {
    return {
      updatedCustomer: { ...customer },
      revertedAmount: 0,
      excessAmount: 0,
      favorBalanceAdded: 0,
      cashRefundAmount: 0,
      excessResolution: 'NINGUNO',
    };
  }

  let remainingRefundCents = refundCents;
  const folioTag = returnRecord.saleFolio;
  const customerDebts: CreditDebtItem[] = Array.isArray(customer.debts) ? customer.debts : [];
  const debtsCopy: CreditDebtItem[] = customerDebts.map((d) => ({ ...d }));

  if (debtsCopy.length > 0 && oldBalanceCents > 0) {
    // 1. Priorizar partidas que correspondan al folio devuelto
    for (const debt of debtsCopy) {
      if (remainingRefundCents <= 0) break;
      const matchesSale =
        debt.saleFolio === folioTag || (debt.description && debt.description.includes(folioTag));
      if (matchesSale) {
        const debtBalanceCents = Math.max(0, Math.round(debt.remainingBalance * 100));
        const deductCents = Math.min(debtBalanceCents, remainingRefundCents);
        debt.remainingBalance = (debtBalanceCents - deductCents) / 100;
        remainingRefundCents -= deductCents;
      }
    }

    // 2. Amortizar otras deudas pendientes por orden FIFO si aún resta saldo por absorber
    if (remainingRefundCents > 0) {
      for (const debt of debtsCopy) {
        if (remainingRefundCents <= 0) break;
        const debtBalanceCents = Math.max(0, Math.round(debt.remainingBalance * 100));
        if (debtBalanceCents > 0) {
          const deductCents = Math.min(debtBalanceCents, remainingRefundCents);
          debt.remainingBalance = (debtBalanceCents - deductCents) / 100;
          remainingRefundCents -= deductCents;
        }
      }
    }
  } else if (oldBalanceCents > 0) {
    // Cliente sin desglose de partidas: absorber contra saldo total actual
    const deductCents = Math.min(oldBalanceCents, remainingRefundCents);
    remainingRefundCents -= deductCents;
  }

  const absorbedCentsRaw = refundCents - remainingRefundCents;
  const unitemizedBalanceCents = Math.max(0, oldBalanceCents - absorbedCentsRaw);
  const extraUnitemizedAbsorbCents =
    debtsCopy.length > 0 && debtsCopy.every((d) => Math.round(d.remainingBalance * 100) === 0)
      ? Math.min(unitemizedBalanceCents, remainingRefundCents)
      : 0;

  const actualRevertedCents = Math.min(oldBalanceCents, absorbedCentsRaw + extraUnitemizedAbsorbCents);
  const newBalanceCents = Math.max(0, oldBalanceCents - actualRevertedCents);
  const excessCents = Math.max(0, refundCents - actualRevertedCents);

  const activeDebts = debtsCopy.filter((d) => Math.round(d.remainingBalance * 100) > 0);
  const favorAddedCents = excessMode === 'SALDO_A_FAVOR' ? excessCents : 0;
  const cashRefundCents = excessMode === 'REEMBOLSO_EFECTIVO' ? excessCents : 0;
  const excessResolution: CreditExcessResolution =
    excessCents > 0 ? excessMode : 'NINGUNO';

  const newFavorCents = priorFavorCents + favorAddedCents;
  const todayLocalDate = formatLocalYyyyMmDd(date instanceof Date ? date : new Date(date));

  let newOverdueBalance = customer.overdueBalance;
  if (newBalanceCents === 0) {
    newOverdueBalance = 0;
  } else if (activeDebts.length > 0) {
    const overdueCents = activeDebts
      .filter((d) => d.dueDate < todayLocalDate && Math.round(d.remainingBalance * 100) > 0)
      .reduce((acc, d) => acc + Math.round(d.remainingBalance * 100), 0);
    newOverdueBalance = overdueCents / 100;
  } else if (typeof customer.overdueBalance === 'number') {
    newOverdueBalance = Math.max(
      0,
      (Math.round(customer.overdueBalance * 100) - actualRevertedCents) / 100
    );
  }

  let newStatus: 'AL_CORRIENTE' | 'LIMITE_ALCANZADO' | 'VENCIDO' = 'AL_CORRIENTE';
  if (newBalanceCents > 0) {
    const hasOverdue = activeDebts.some(
      (d) => d.dueDate < todayLocalDate && Math.round(d.remainingBalance * 100) > 0
    );
    if (hasOverdue || (newOverdueBalance || 0) > 0) {
      newStatus = 'VENCIDO';
    } else if (
      customer.creditLimit > 0 &&
      newBalanceCents / 100 >= customer.creditLimit * 0.9
    ) {
      newStatus = 'LIMITE_ALCANZADO';
    } else {
      newStatus = 'AL_CORRIENTE';
    }
  }

  const updatedCustomer: T = {
    ...customer,
    currentBalance: newBalanceCents / 100,
    overdueBalance: newOverdueBalance,
    debts: activeDebts,
    status: newStatus,
    ...(customer.creditFavorBalance !== undefined || favorAddedCents > 0
      ? { creditFavorBalance: newFavorCents / 100 }
      : {}),
  };

  return {
    updatedCustomer,
    revertedAmount: actualRevertedCents / 100,
    excessAmount: excessCents / 100,
    favorBalanceAdded: favorAddedCents / 100,
    cashRefundAmount: cashRefundCents / 100,
    excessResolution,
  };
}
