import type { SaleRecord, SaleReturnRecord, SalePaymentType } from './sales';
import type { KardexEntry } from './kardex';
import type { CreditCustomerLike } from './credit';
import type { ShrinkRecordLike } from './shrink';

export const UTF8_BOM = '\uFEFF';

export type ReportPeriodPreset = 'HOY' | 'SEMANA' | 'MES' | 'RANGO';

export type ReportTabKey =
  | 'VENTAS'
  | 'MARGENES'
  | 'MERMAS'
  | 'CREDITOS_VENCIDOS'
  | 'DIFERENCIAS_CONTEO'
  | 'TIEMPO_VENTAS'
  | 'VALUACION_INVENTARIO';

export interface ReportDateFilterInput {
  preset: ReportPeriodPreset;
  referenceDate?: string;
  startDate?: string;
  endDate?: string;
}

export interface ResolvedDateRange {
  preset: ReportPeriodPreset;
  startDate: string; // YYYY-MM-DD local
  endDate: string; // YYYY-MM-DD local
}

export interface ReportProductLike {
  sku: string;
  name: string;
  category?: string;
  stock: number;
  price: number;
  weightedAvgCost?: number;
  lastPurchaseCost?: number;
  purchaseCost?: number;
  historicCost?: number;
}

export interface KardexValuationLike {
  sku?: string;
  producto?: { sku?: string } | string;
  balanceAfter?: number;
  stockAfter?: number;
  saldoResultante?: number;
  weightedAvgCost?: number;
}

export interface AuditLineLike {
  sku: string;
  name: string;
  saleUnit?: string;
  location?: string;
  systemQty: number;
  countedQty: number;
  diffQty?: number;
  unitCost: number;
  diffValue?: number;
  status?: string;
  isWithinNaturalTolerance?: boolean;
  naturalShrinkTolerancePct?: number;
  date?: string;
  timestamp?: string;
}

// ============================================================================
//  Utilidades locales de fechas (sin desfase UTC) y redondeo seguro
// ============================================================================

export function roundQty3(qty: number): number {
  return Math.round((Number.isFinite(qty) ? qty : 0) * 1000) / 1000;
}

export function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function formatCentsMxn(cents: number): string {
  const rounded = Math.round(Number.isFinite(cents) ? cents : 0);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function centsToFixedPesos(cents: number): string {
  const rounded = Math.round(Number.isFinite(cents) ? cents : 0);
  return (rounded / 100).toFixed(2);
}

export function formatLocalYyyyMmDd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidCalendarYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2999) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Normaliza fechas en formato YYYY-MM-DD, DD/MM/YYYY o ISO completo a fecha local YYYY-MM-DD.
 * Evita usar Date.toISOString() sobre fechas calendario para prevenir desfases por zona horaria.
 */
export function normalizeDateToYyyyMmDd(raw: string | Date | undefined | null): string | null {
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? formatLocalYyyyMmDd(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const ymdExact = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymdExact) {
    const y = Number(ymdExact[1]);
    const m = Number(ymdExact[2]);
    const d = Number(ymdExact[3]);
    return isValidCalendarYmd(y, m, d) ? trimmed : null;
  }

  const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const d = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    const y = Number(dmyMatch[3]);
    if (!isValidCalendarYmd(y, m, d)) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const ymdSpace = /^(\d{4})-(\d{2})-(\d{2})\s/.exec(trimmed);
  if (ymdSpace) {
    const y = Number(ymdSpace[1]);
    const m = Number(ymdSpace[2]);
    const d = Number(ymdSpace[3]);
    return isValidCalendarYmd(y, m, d) ? `${ymdSpace[1]}-${ymdSpace[2]}-${ymdSpace[3]}` : null;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return formatLocalYyyyMmDd(new Date(parsedMs));
}

function toUtcEpochDays(yyyyMmDd: string): number | null {
  const norm = normalizeDateToYyyyMmDd(yyyyMmDd);
  if (!norm) return null;
  const [y, m, d] = norm.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addDaysLocal(yyyyMmDd: string, deltaDays: number): string {
  const norm = normalizeDateToYyyyMmDd(yyyyMmDd) || formatLocalYyyyMmDd(new Date());
  const [y, m, d] = norm.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Math.trunc(deltaDays)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function daysBetweenLocalDates(fromYyyyMmDd: string, toYyyyMmDd: string): number {
  const fromDays = toUtcEpochDays(fromYyyyMmDd);
  const toDays = toUtcEpochDays(toYyyyMmDd);
  if (fromDays === null || toDays === null) return 0;
  return toDays - fromDays;
}

/**
 * Resuelve el rango de fechas local [startDate, endDate] según el preset solicitado:
 * - HOY: [ref, ref]
 * - SEMANA: Lunes de la semana calendario de ref hasta ref
 * - MES: Día 01 del mes de ref hasta ref
 * - RANGO: [startDate, endDate] ordenados de menor a mayor
 */
export function resolveReportDateRange(input: ReportDateFilterInput): ResolvedDateRange {
  const ref = normalizeDateToYyyyMmDd(input.referenceDate) || formatLocalYyyyMmDd(new Date());
  const [y, m, d] = ref.split('-').map(Number);

  if (input.preset === 'HOY') {
    return { preset: 'HOY', startDate: ref, endDate: ref };
  }

  if (input.preset === 'SEMANA') {
    const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Dom .. 6=Sab
    const daysSinceMonday = (utcDay + 6) % 7;
    return {
      preset: 'SEMANA',
      startDate: addDaysLocal(ref, -daysSinceMonday),
      endDate: ref,
    };
  }

  if (input.preset === 'MES') {
    const startOfMonth = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
    return { preset: 'MES', startDate: startOfMonth, endDate: ref };
  }

  const rawStart = normalizeDateToYyyyMmDd(input.startDate) || ref;
  const rawEnd = normalizeDateToYyyyMmDd(input.endDate) || rawStart;
  if (rawStart <= rawEnd) {
    return { preset: 'RANGO', startDate: rawStart, endDate: rawEnd };
  }
  return { preset: 'RANGO', startDate: rawEnd, endDate: rawStart };
}

export function isDateWithinRange(
  rawDate: string | undefined | null,
  range: Pick<ResolvedDateRange, 'startDate' | 'endDate'>
): boolean {
  const norm = normalizeDateToYyyyMmDd(rawDate);
  if (!norm) return false;
  return norm >= range.startDate && norm <= range.endDate;
}

export function extractLocalHour(timestamp: string | undefined | null): number | null {
  if (typeof timestamp !== 'string' || !timestamp.trim()) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getHours();
}

// ============================================================================
//  Helpers compartidos de ventas, devoluciones y costos en centavos
// ============================================================================

function resolveRecordLocalDate(record: { date?: string; timestamp?: string }): string | null {
  return normalizeDateToYyyyMmDd(record.date) || normalizeDateToYyyyMmDd(record.timestamp);
}

function collectUniqueReturns(
  sales: SaleRecord[],
  extraReturns: SaleReturnRecord[] = []
): SaleReturnRecord[] {
  const byId = new Map<string, SaleReturnRecord>();
  for (const sale of sales) {
    if (!Array.isArray(sale.returns)) continue;
    for (const ret of sale.returns) {
      if (ret?.id && !byId.has(ret.id)) {
        byId.set(ret.id, ret);
      }
    }
  }
  for (const ret of extraReturns) {
    if (ret?.id) {
      byId.set(ret.id, ret);
    }
  }
  return Array.from(byId.values());
}

function buildProductMap(products: ReportProductLike[]): Map<string, ReportProductLike> {
  const map = new Map<string, ReportProductLike>();
  for (const p of products) {
    if (p?.sku) map.set(p.sku, p);
  }
  return map;
}

export function resolveProductUnitCostCents(product?: Partial<ReportProductLike> | null): number {
  if (!product) return 0;
  const costPesos =
    product.weightedAvgCost ??
    product.lastPurchaseCost ??
    product.purchaseCost ??
    product.historicCost ??
    0;
  return Math.max(0, Math.round((Number.isFinite(costPesos) ? costPesos : 0) * 100));
}

function resolveSaleLineNetCents(line: {
  subtotalCents?: number;
  subtotal?: number;
}): number {
  if (line.subtotalCents !== undefined && Number.isFinite(line.subtotalCents)) {
    return Math.max(0, Math.round(line.subtotalCents));
  }
  return Math.max(0, Math.round((line.subtotal ?? 0) * 100));
}

function resolveReturnLineCents(line: {
  refundAmountCents?: number;
  refundAmount?: number;
}): number {
  if (line.refundAmountCents !== undefined && Number.isFinite(line.refundAmountCents)) {
    return Math.max(0, Math.round(line.refundAmountCents));
  }
  return Math.max(0, Math.round((line.refundAmount ?? 0) * 100));
}

function resolveSaleTotalCents(sale: SaleRecord): number {
  if (sale.totalCents !== undefined && Number.isFinite(sale.totalCents)) {
    return Math.max(0, Math.round(sale.totalCents));
  }
  return Math.max(0, Math.round((sale.total ?? 0) * 100));
}

function resolveReturnTotalCents(ret: SaleReturnRecord): number {
  if (ret.totalRefundCents !== undefined && Number.isFinite(ret.totalRefundCents)) {
    return Math.max(0, Math.round(ret.totalRefundCents));
  }
  return Math.max(0, Math.round((ret.totalRefund ?? 0) * 100));
}

// ============================================================================
//  1. Reporte de Ventas (total, forma de pago, producto y hora)
// ============================================================================

export interface SalesByPaymentRow {
  paymentType: SalePaymentType;
  ticketCount: number;
  grossSalesCents: number;
  returnsCents: number;
  netSalesCents: number;
  sharePct: number;
}

export interface SalesByProductRow {
  sku: string;
  name: string;
  grossQty: number;
  returnedQty: number;
  netQty: number;
  grossSalesCents: number;
  returnsCents: number;
  netSalesCents: number;
}

export interface SalesByHourRow {
  hour: number;
  label: string;
  ticketCount: number;
  grossSalesCents: number;
  returnsCents: number;
  netSalesCents: number;
}

export interface SalesReport {
  range: ResolvedDateRange;
  ticketCount: number;
  cancelledTicketCount: number;
  returnEventCount: number;
  grossSalesCents: number;
  discountsCents: number;
  returnsCents: number;
  netSalesCents: number;
  averageTicketCents: number;
  byPaymentType: SalesByPaymentRow[];
  byProduct: SalesByProductRow[];
  byHour: SalesByHourRow[];
  peakHour: number | null;
}

export function buildSalesReport(
  sales: SaleRecord[],
  returns: SaleReturnRecord[],
  range: ResolvedDateRange
): SalesReport {
  const filteredSales = sales.filter((s) => isDateWithinRange(resolveRecordLocalDate(s), range));
  const uniqueReturns = collectUniqueReturns(sales, returns);
  const filteredReturns = uniqueReturns.filter((r) => isDateWithinRange(resolveRecordLocalDate(r), range));

  let grossSalesCents = 0;
  let discountsCents = 0;
  let returnsCents = 0;
  let cancelledTicketCount = 0;

  const paymentAcc: Record<
    SalePaymentType,
    { ticketCount: number; grossSalesCents: number; returnsCents: number }
  > = {
    EFECTIVO: { ticketCount: 0, grossSalesCents: 0, returnsCents: 0 },
    FIADO: { ticketCount: 0, grossSalesCents: 0, returnsCents: 0 },
  };

  const productMap = new Map<string, SalesByProductRow>();

  const hours: SalesByHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59`,
    ticketCount: 0,
    grossSalesCents: 0,
    returnsCents: 0,
    netSalesCents: 0,
  }));

  for (const sale of filteredSales) {
    const saleCents = resolveSaleTotalCents(sale);
    const saleDiscCents = Math.max(0, Math.round((sale.discountAmount ?? 0) * 100));
    grossSalesCents += saleCents;
    discountsCents += saleDiscCents;
    if (sale.status === 'CANCELADA') {
      cancelledTicketCount += 1;
    }

    const pType: SalePaymentType = sale.paymentType === 'FIADO' ? 'FIADO' : 'EFECTIVO';
    paymentAcc[pType].ticketCount += 1;
    paymentAcc[pType].grossSalesCents += saleCents;

    const hr = extractLocalHour(sale.timestamp);
    if (hr !== null) {
      hours[hr].ticketCount += 1;
      hours[hr].grossSalesCents += saleCents;
    }

    for (const item of sale.items || []) {
      const qty = Math.max(0, roundQty3(item.qty));
      const lineCents = resolveSaleLineNetCents(item);
      const existing = productMap.get(item.sku) || {
        sku: item.sku,
        name: item.name,
        grossQty: 0,
        returnedQty: 0,
        netQty: 0,
        grossSalesCents: 0,
        returnsCents: 0,
        netSalesCents: 0,
      };
      existing.grossQty = roundQty3(existing.grossQty + qty);
      existing.grossSalesCents += lineCents;
      productMap.set(item.sku, existing);
    }
  }

  for (const ret of filteredReturns) {
    const retCents = resolveReturnTotalCents(ret);
    returnsCents += retCents;

    const pType: SalePaymentType = ret.paymentType === 'FIADO' ? 'FIADO' : 'EFECTIVO';
    paymentAcc[pType].returnsCents += retCents;

    const hr = extractLocalHour(ret.timestamp);
    if (hr !== null) {
      hours[hr].returnsCents += retCents;
    }

    for (const rItem of ret.items || []) {
      const qty = Math.max(0, roundQty3(rItem.qty));
      const lineRetCents = resolveReturnLineCents(rItem);
      const existing = productMap.get(rItem.sku) || {
        sku: rItem.sku,
        name: rItem.name,
        grossQty: 0,
        returnedQty: 0,
        netQty: 0,
        grossSalesCents: 0,
        returnsCents: 0,
        netSalesCents: 0,
      };
      existing.returnedQty = roundQty3(existing.returnedQty + qty);
      existing.returnsCents += lineRetCents;
      productMap.set(rItem.sku, existing);
    }
  }

  const netSalesCents = grossSalesCents - returnsCents;
  const ticketCount = filteredSales.length;
  const averageTicketCents = ticketCount > 0 ? Math.round(grossSalesCents / ticketCount) : 0;

  const byPaymentType: SalesByPaymentRow[] = (['EFECTIVO', 'FIADO'] as SalePaymentType[]).map((pt) => {
    const bucket = paymentAcc[pt];
    return {
      paymentType: pt,
      ticketCount: bucket.ticketCount,
      grossSalesCents: bucket.grossSalesCents,
      returnsCents: bucket.returnsCents,
      netSalesCents: bucket.grossSalesCents - bucket.returnsCents,
      sharePct:
        grossSalesCents > 0 ? round2((bucket.grossSalesCents * 100) / grossSalesCents) : 0,
    };
  });

  const byProduct = Array.from(productMap.values())
    .map((p) => ({
      ...p,
      netQty: roundQty3(p.grossQty - p.returnedQty),
      netSalesCents: p.grossSalesCents - p.returnsCents,
    }))
    .sort((a, b) => b.netSalesCents - a.netSalesCents || a.sku.localeCompare(b.sku));

  let peakHour: number | null = null;
  let peakHourGross = 0;
  for (const row of hours) {
    row.netSalesCents = row.grossSalesCents - row.returnsCents;
    if (row.grossSalesCents > peakHourGross) {
      peakHourGross = row.grossSalesCents;
      peakHour = row.hour;
    }
  }

  return {
    range,
    ticketCount,
    cancelledTicketCount,
    returnEventCount: filteredReturns.length,
    grossSalesCents,
    discountsCents,
    returnsCents,
    netSalesCents,
    averageTicketCents,
    byPaymentType,
    byProduct,
    byHour: hours,
    peakHour,
  };
}

// ============================================================================
//  2. Reporte de Márgenes (ganancia por producto y por venta)
// ============================================================================

export interface MarginByProductRow {
  sku: string;
  name: string;
  netQty: number;
  netRevenueCents: number;
  netCostCents: number;
  marginCents: number;
  marginPct: number;
}

export interface MarginBySaleRow {
  saleId: string;
  folio: string;
  date: string;
  cashier: string;
  paymentType: SalePaymentType;
  netRevenueCents: number;
  netCostCents: number;
  marginCents: number;
  marginPct: number;
}

export interface MarginsReport {
  range: ResolvedDateRange;
  totalNetRevenueCents: number;
  totalNetCostCents: number;
  totalMarginCents: number;
  overallMarginPct: number;
  priorPeriodReturnsAdjustmentCents: number;
  byProduct: MarginByProductRow[];
  bySale: MarginBySaleRow[];
}

export function computeMarginPct(revenueCents: number, marginCents: number): number {
  if (revenueCents <= 0) return 0;
  return Math.round((marginCents * 10000) / revenueCents) / 100;
}

export function buildMarginsReport(
  sales: SaleRecord[],
  returns: SaleReturnRecord[],
  products: ReportProductLike[],
  range: ResolvedDateRange
): MarginsReport {
  const catalog = buildProductMap(products);
  const saleLineCostIndex = new Map<string, number>();

  for (const sale of sales) {
    for (const item of sale.items || []) {
      const unitCostCents =
        item.unitCostCents !== undefined && Number.isFinite(item.unitCostCents)
          ? Math.max(0, Math.round(item.unitCostCents))
          : item.unitCost !== undefined && Number.isFinite(item.unitCost)
          ? Math.max(0, Math.round(item.unitCost * 100))
          : resolveProductUnitCostCents(catalog.get(item.sku));
      saleLineCostIndex.set(`${sale.id}::${item.sku}`, unitCostCents);
    }
  }

  const filteredSales = sales.filter((s) => isDateWithinRange(resolveRecordLocalDate(s), range));
  const filteredReturns = collectUniqueReturns(sales, returns).filter((r) =>
    isDateWithinRange(resolveRecordLocalDate(r), range)
  );

  const productAcc = new Map<
    string,
    { sku: string; name: string; netQty: number; netRevenueCents: number; netCostCents: number }
  >();
  const saleAcc = new Map<
    string,
    {
      saleId: string;
      folio: string;
      date: string;
      cashier: string;
      paymentType: SalePaymentType;
      netRevenueCents: number;
      netCostCents: number;
    }
  >();

  for (const sale of filteredSales) {
    const saleDate = resolveRecordLocalDate(sale) || range.startDate;
    let saleRevCents = 0;
    let saleCostCents = 0;

    for (const item of sale.items || []) {
      const qty = Math.max(0, roundQty3(item.qty));
      const revCents = resolveSaleLineNetCents(item);
      const unitCostCents =
        saleLineCostIndex.get(`${sale.id}::${item.sku}`) ??
        resolveProductUnitCostCents(catalog.get(item.sku));
      const lineCostCents = Math.round(qty * unitCostCents);

      saleRevCents += revCents;
      saleCostCents += lineCostCents;

      const prodRow = productAcc.get(item.sku) || {
        sku: item.sku,
        name: item.name,
        netQty: 0,
        netRevenueCents: 0,
        netCostCents: 0,
      };
      prodRow.netQty = roundQty3(prodRow.netQty + qty);
      prodRow.netRevenueCents += revCents;
      prodRow.netCostCents += lineCostCents;
      productAcc.set(item.sku, prodRow);
    }

    saleAcc.set(sale.id, {
      saleId: sale.id,
      folio: sale.folio,
      date: saleDate,
      cashier: sale.cashier,
      paymentType: sale.paymentType,
      netRevenueCents: saleRevCents,
      netCostCents: saleCostCents,
    });
  }

  let priorPeriodReturnsAdjustmentCents = 0;
  for (const ret of filteredReturns) {
    let retRevTotal = 0;
    let retCostTotal = 0;

    for (const rItem of ret.items || []) {
      const qty = Math.max(0, roundQty3(rItem.qty));
      const retLineCents = resolveReturnLineCents(rItem);
      const unitCostCents =
        saleLineCostIndex.get(`${ret.saleId}::${rItem.sku}`) ??
        resolveProductUnitCostCents(catalog.get(rItem.sku));
      const retLineCostCents = Math.round(qty * unitCostCents);

      retRevTotal += retLineCents;
      retCostTotal += retLineCostCents;

      const prodRow = productAcc.get(rItem.sku) || {
        sku: rItem.sku,
        name: rItem.name,
        netQty: 0,
        netRevenueCents: 0,
        netCostCents: 0,
      };
      prodRow.netQty = roundQty3(prodRow.netQty - qty);
      prodRow.netRevenueCents -= retLineCents;
      prodRow.netCostCents -= retLineCostCents;
      productAcc.set(rItem.sku, prodRow);
    }

    const saleRow = saleAcc.get(ret.saleId);
    if (saleRow) {
      saleRow.netRevenueCents -= retRevTotal;
      saleRow.netCostCents -= retCostTotal;
    } else {
      priorPeriodReturnsAdjustmentCents -= retRevTotal - retCostTotal;
    }
  }

  const byProduct: MarginByProductRow[] = Array.from(productAcc.values())
    .map((p) => {
      const marginCents = p.netRevenueCents - p.netCostCents;
      return {
        ...p,
        marginCents,
        marginPct: computeMarginPct(p.netRevenueCents, marginCents),
      };
    })
    .sort((a, b) => b.marginCents - a.marginCents || a.sku.localeCompare(b.sku));

  const bySale: MarginBySaleRow[] = Array.from(saleAcc.values())
    .map((s) => {
      const marginCents = s.netRevenueCents - s.netCostCents;
      return {
        ...s,
        marginCents,
        marginPct: computeMarginPct(s.netRevenueCents, marginCents),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.folio.localeCompare(a.folio));

  const totalNetRevenueCents = byProduct.reduce((acc, r) => acc + r.netRevenueCents, 0);
  const totalNetCostCents = byProduct.reduce((acc, r) => acc + r.netCostCents, 0);
  const totalMarginCents = totalNetRevenueCents - totalNetCostCents;

  return {
    range,
    totalNetRevenueCents,
    totalNetCostCents,
    totalMarginCents,
    overallMarginPct: computeMarginPct(totalNetRevenueCents, totalMarginCents),
    priorPeriodReturnsAdjustmentCents,
    byProduct,
    bySale,
  };
}

// ============================================================================
//  3. Reporte de Mermas (por motivo y por producto)
// ============================================================================

export interface ShrinkByReasonRow {
  reason: string;
  recordCount: number;
  totalQty: number;
  totalLossCents: number;
  sharePct: number;
}

export interface ShrinkByProductRow {
  sku: string;
  name: string;
  recordCount: number;
  totalQty: number;
  totalLossCents: number;
  reasons: string[];
}

export interface ShrinkReport {
  range: ResolvedDateRange;
  recordCount: number;
  reviewedCount: number;
  unreviewedCount: number;
  totalQty: number;
  totalLossCents: number;
  byReason: ShrinkByReasonRow[];
  byProduct: ShrinkByProductRow[];
}

export function buildShrinkReport(
  shrinkRecords: ShrinkRecordLike[],
  products: ReportProductLike[],
  range: ResolvedDateRange
): ShrinkReport {
  const catalog = buildProductMap(products);
  const filtered = shrinkRecords.filter((r) => isDateWithinRange(r['date'], range));

  let reviewedCount = 0;
  let totalQty = 0;
  let totalLossCents = 0;

  const reasonAcc = new Map<string, { reason: string; recordCount: number; totalQty: number; totalLossCents: number }>();
  const productAcc = new Map<
    string,
    { sku: string; name: string; recordCount: number; totalQty: number; totalLossCents: number; reasonsSet: Set<string> }
  >();

  for (const rec of filtered) {
    const qty = Math.max(0, roundQty3(rec.qty ?? 0));
    const unitCostCents =
      rec.unitCost !== undefined && Number.isFinite(rec.unitCost)
        ? Math.max(0, Math.round(rec.unitCost * 100))
        : resolveProductUnitCostCents(rec.sku ? catalog.get(rec.sku) : undefined);
    const lossCents = Math.round(qty * unitCostCents);
    const reason =
      typeof rec['reason'] === 'string' && rec['reason'].trim()
        ? rec['reason'].trim()
        : 'Sin motivo especificado';
    const sku = (rec.sku || rec.id || 'SIN-SKU').trim();
    const name = (rec.name || catalog.get(sku)?.name || sku).trim();

    if (rec['reviewed']) reviewedCount += 1;
    totalQty = roundQty3(totalQty + qty);
    totalLossCents += lossCents;

    const rRow = reasonAcc.get(reason) || { reason, recordCount: 0, totalQty: 0, totalLossCents: 0 };
    rRow.recordCount += 1;
    rRow.totalQty = roundQty3(rRow.totalQty + qty);
    rRow.totalLossCents += lossCents;
    reasonAcc.set(reason, rRow);

    const pRow = productAcc.get(sku) || {
      sku,
      name,
      recordCount: 0,
      totalQty: 0,
      totalLossCents: 0,
      reasonsSet: new Set<string>(),
    };
    pRow.recordCount += 1;
    pRow.totalQty = roundQty3(pRow.totalQty + qty);
    pRow.totalLossCents += lossCents;
    pRow.reasonsSet.add(reason);
    productAcc.set(sku, pRow);
  }

  const byReason: ShrinkByReasonRow[] = Array.from(reasonAcc.values())
    .map((r) => ({
      ...r,
      sharePct: totalLossCents > 0 ? round2((r.totalLossCents * 100) / totalLossCents) : 0,
    }))
    .sort((a, b) => b.totalLossCents - a.totalLossCents || a.reason.localeCompare(b.reason));

  const byProduct: ShrinkByProductRow[] = Array.from(productAcc.values())
    .map((p) => ({
      sku: p.sku,
      name: p.name,
      recordCount: p.recordCount,
      totalQty: p.totalQty,
      totalLossCents: p.totalLossCents,
      reasons: Array.from(p.reasonsSet).sort(),
    }))
    .sort((a, b) => b.totalLossCents - a.totalLossCents || a.sku.localeCompare(b.sku));

  return {
    range,
    recordCount: filtered.length,
    reviewedCount,
    unreviewedCount: Math.max(0, filtered.length - reviewedCount),
    totalQty,
    totalLossCents,
    byReason,
    byProduct,
  };
}

// ============================================================================
//  4. Reporte de Créditos Vencidos (por cliente y antigüedad)
// ============================================================================

export type OverdueAgingBucket = '1_7_DIAS' | '8_15_DIAS' | '16_30_DIAS' | 'MAS_30_DIAS';

export interface OverdueCustomerRow {
  customerId: string;
  name: string;
  phone: string;
  totalBalanceCents: number;
  overdueCents: number;
  maxDaysOverdue: number;
  agingBucket: OverdueAgingBucket;
  oldestDueDate: string | null;
}

export interface OverdueAgingRow {
  bucket: OverdueAgingBucket;
  label: string;
  customerCount: number;
  overdueCents: number;
  sharePct: number;
}

export interface OverdueCreditsReport {
  asOfDate: string;
  totalPortfolioCents: number;
  totalOverdueCents: number;
  overdueCustomerCount: number;
  totalIndebtedCustomerCount: number;
  overdueRatePct: number;
  byCustomer: OverdueCustomerRow[];
  byAgingBucket: OverdueAgingRow[];
}

const AGING_BUCKETS: { bucket: OverdueAgingBucket; label: string }[] = [
  { bucket: '1_7_DIAS', label: '1 a 7 días' },
  { bucket: '8_15_DIAS', label: '8 a 15 días' },
  { bucket: '16_30_DIAS', label: '16 a 30 días' },
  { bucket: 'MAS_30_DIAS', label: 'Más de 30 días' },
];

export function classifyOverdueBucket(daysOverdue: number): OverdueAgingBucket {
  if (daysOverdue <= 7) return '1_7_DIAS';
  if (daysOverdue <= 15) return '8_15_DIAS';
  if (daysOverdue <= 30) return '16_30_DIAS';
  return 'MAS_30_DIAS';
}

export function buildOverdueCreditsReport(
  customers: CreditCustomerLike[],
  referenceDate?: string
): OverdueCreditsReport {
  const asOfDate = normalizeDateToYyyyMmDd(referenceDate) || formatLocalYyyyMmDd(new Date());

  let totalPortfolioCents = 0;
  let totalOverdueCents = 0;
  let totalIndebtedCustomerCount = 0;

  const bucketAmounts: Record<OverdueAgingBucket, number> = {
    '1_7_DIAS': 0,
    '8_15_DIAS': 0,
    '16_30_DIAS': 0,
    MAS_30_DIAS: 0,
  };
  const bucketCustomers: Record<OverdueAgingBucket, Set<string>> = {
    '1_7_DIAS': new Set(),
    '8_15_DIAS': new Set(),
    '16_30_DIAS': new Set(),
    MAS_30_DIAS: new Set(),
  };

  const byCustomer: OverdueCustomerRow[] = [];

  for (const cust of customers) {
    const balanceCents = Math.max(0, Math.round((cust.currentBalance ?? 0) * 100));
    if (balanceCents <= 0) continue;

    const customerId = String(cust.id || cust.name || 'SIN-ID');
    const customerName = String(cust.name || customerId);

    totalIndebtedCustomerCount += 1;
    totalPortfolioCents += balanceCents;

    let customerOverdueCents = 0;
    let maxDaysOverdue = 0;
    let oldestDueDate: string | null = null;

    const rawDebts =
      Array.isArray(cust.debts) && cust.debts.length > 0
        ? (cust.debts as unknown as Record<string, unknown>[])
        : Array.isArray(cust['debtItems'])
          ? (cust['debtItems'] as Record<string, unknown>[])
          : [];
    const activeItems = rawDebts.filter((d) => {
      const rem =
        typeof d['remainingCents'] === 'number'
          ? d['remainingCents']
          : Math.round((Number(d['remainingBalance'] ?? d['remainingAmount']) || 0) * 100);
      return rem > 0;
    });

    if (activeItems.length > 0) {
      for (const item of activeItems) {
        const remCents = Math.max(
          0,
          Math.round(
            typeof item['remainingCents'] === 'number'
              ? item['remainingCents']
              : (Number(item['remainingBalance'] ?? item['remainingAmount']) || 0) * 100
          )
        );
        const itemDue =
          normalizeDateToYyyyMmDd(item['dueDate'] as string | Date | undefined) ||
          normalizeDateToYyyyMmDd(cust.dueDate);
        if (!itemDue || itemDue >= asOfDate) continue;

        const days = Math.max(1, daysBetweenLocalDates(itemDue, asOfDate));
        const bucket = classifyOverdueBucket(days);
        const allocCents = Math.min(remCents, Math.max(0, balanceCents - customerOverdueCents));
        customerOverdueCents += allocCents;
        bucketAmounts[bucket] += allocCents;
        if (allocCents > 0) {
          bucketCustomers[bucket].add(customerId);
        }
        if (days > maxDaysOverdue) maxDaysOverdue = days;
        if (!oldestDueDate || itemDue < oldestDueDate) oldestDueDate = itemDue;
      }

      // Conciliar en caso de saldo vencido residual sin partidas individuales vencidas
      if (customerOverdueCents === 0 && (cust.overdueBalance ?? 0) > 0) {
        const fallbackDue = normalizeDateToYyyyMmDd(cust.dueDate);
        const days = fallbackDue && fallbackDue < asOfDate
          ? Math.max(1, daysBetweenLocalDates(fallbackDue, asOfDate))
          : 1;
        const fallbackOverdueCents = Math.min(balanceCents, Math.round((cust.overdueBalance ?? 0) * 100));
        const bucket = classifyOverdueBucket(days);
        customerOverdueCents = fallbackOverdueCents;
        bucketAmounts[bucket] += fallbackOverdueCents;
        bucketCustomers[bucket].add(customerId);
        maxDaysOverdue = days;
        oldestDueDate = fallbackDue;
      }
    } else {
      const due = normalizeDateToYyyyMmDd(cust.dueDate);
      const explicitOverdueCents = Math.min(balanceCents, Math.max(0, Math.round((cust.overdueBalance ?? 0) * 100)));
      if (due && due < asOfDate) {
        const days = Math.max(1, daysBetweenLocalDates(due, asOfDate));
        const overdue = explicitOverdueCents > 0 ? explicitOverdueCents : balanceCents;
        const bucket = classifyOverdueBucket(days);
        customerOverdueCents = overdue;
        bucketAmounts[bucket] += overdue;
        bucketCustomers[bucket].add(customerId);
        maxDaysOverdue = days;
        oldestDueDate = due;
      } else if (explicitOverdueCents > 0) {
        customerOverdueCents = explicitOverdueCents;
        bucketAmounts['1_7_DIAS'] += explicitOverdueCents;
        bucketCustomers['1_7_DIAS'].add(customerId);
        maxDaysOverdue = 1;
        oldestDueDate = due;
      }
    }

    if (customerOverdueCents > 0) {
      totalOverdueCents += customerOverdueCents;
      byCustomer.push({
        customerId,
        name: customerName,
        phone: String(cust['phone'] || ''),
        totalBalanceCents: balanceCents,
        overdueCents: customerOverdueCents,
        maxDaysOverdue,
        agingBucket: classifyOverdueBucket(maxDaysOverdue),
        oldestDueDate,
      });
    }
  }

  byCustomer.sort((a, b) => b.overdueCents - a.overdueCents || b.maxDaysOverdue - a.maxDaysOverdue);

  const byAgingBucket: OverdueAgingRow[] = AGING_BUCKETS.map(({ bucket, label }) => {
    const cents = bucketAmounts[bucket];
    return {
      bucket,
      label,
      customerCount: bucketCustomers[bucket].size,
      overdueCents: cents,
      sharePct: totalOverdueCents > 0 ? round2((cents * 100) / totalOverdueCents) : 0,
    };
  });

  return {
    asOfDate,
    totalPortfolioCents,
    totalOverdueCents,
    overdueCustomerCount: byCustomer.length,
    totalIndebtedCustomerCount,
    overdueRatePct: totalPortfolioCents > 0 ? round2((totalOverdueCents * 100) / totalPortfolioCents) : 0,
    byCustomer,
    byAgingBucket,
  };
}

// ============================================================================
//  5. Reporte de Diferencias Stock-Conteo (Auditoría)
// ============================================================================

export interface AuditDifferenceRow {
  sku: string;
  name: string;
  saleUnit: string;
  systemQty: number;
  countedQty: number;
  diffQty: number;
  unitCostCents: number;
  diffValueCents: number;
  classification: 'CUADRA' | 'MERMA_NATURAL' | 'FALTANTE' | 'SOBRANTE';
  status: string;
  date: string | null;
}

export interface AuditDifferencesReport {
  range: ResolvedDateRange;
  totalAuditedSkus: number;
  exactMatchCount: number;
  varianceSkuCount: number;
  naturalToleranceCount: number;
  shortageSkuCount: number;
  surplusSkuCount: number;
  shortageValueCents: number; // positivo representando dinero faltante
  naturalToleranceLossCents: number; // positivo representando merma natural
  surplusValueCents: number; // positivo representando sobrante
  netVarianceCents: number; // suma algebraica (sobrante - faltantes)
  items: AuditDifferenceRow[];
}

export function buildAuditDifferencesReport(
  auditLines: AuditLineLike[],
  products: ReportProductLike[],
  range: ResolvedDateRange,
  options?: { includeUndated?: boolean }
): AuditDifferencesReport {
  const includeUndated = options?.includeUndated ?? true;
  const catalog = buildProductMap(products);

  const filtered = auditLines.filter((line) => {
    const lineDate = resolveRecordLocalDate(line);
    if (!lineDate) return includeUndated;
    return isDateWithinRange(lineDate, range);
  });

  let exactMatchCount = 0;
  let naturalToleranceCount = 0;
  let shortageSkuCount = 0;
  let surplusSkuCount = 0;
  let shortageValueCents = 0;
  let naturalToleranceLossCents = 0;
  let surplusValueCents = 0;
  let netVarianceCents = 0;

  const items: AuditDifferenceRow[] = filtered.map((line) => {
    const unitCostCents =
      line.unitCost !== undefined && Number.isFinite(line.unitCost)
        ? Math.max(0, Math.round(line.unitCost * 100))
        : resolveProductUnitCostCents(catalog.get(line.sku));
    const systemQty = Number.isFinite(line.systemQty) ? line.systemQty : 0;
    const countedQty = Number.isFinite(line.countedQty) ? line.countedQty : 0;
    const rawDiff =
      typeof line.diffQty === 'number' && Number.isFinite(line.diffQty)
        ? line.diffQty
        : countedQty - systemQty;
    const diffQty = roundQty3(rawDiff);
    const diffValueCents = Math.round(diffQty * unitCostCents);
    netVarianceCents += diffValueCents;

    let classification: AuditDifferenceRow['classification'] = 'CUADRA';
    if (diffQty === 0) {
      exactMatchCount += 1;
      classification = 'CUADRA';
    } else if (diffQty < 0 && line.isWithinNaturalTolerance) {
      naturalToleranceCount += 1;
      naturalToleranceLossCents += Math.abs(diffValueCents);
      classification = 'MERMA_NATURAL';
    } else if (diffQty < 0) {
      shortageSkuCount += 1;
      shortageValueCents += Math.abs(diffValueCents);
      classification = 'FALTANTE';
    } else {
      surplusSkuCount += 1;
      surplusValueCents += diffValueCents;
      classification = 'SOBRANTE';
    }

    return {
      sku: line.sku,
      name: line.name,
      saleUnit: line.saleUnit || 'Pieza',
      systemQty: roundQty3(systemQty),
      countedQty: roundQty3(countedQty),
      diffQty,
      unitCostCents,
      diffValueCents,
      classification,
      status: line.status || 'pendiente',
      date: resolveRecordLocalDate(line),
    };
  });

  items.sort((a, b) => Math.abs(b.diffValueCents) - Math.abs(a.diffValueCents) || a.sku.localeCompare(b.sku));

  return {
    range,
    totalAuditedSkus: items.length,
    exactMatchCount,
    varianceSkuCount: naturalToleranceCount + shortageSkuCount + surplusSkuCount,
    naturalToleranceCount,
    shortageSkuCount,
    surplusSkuCount,
    shortageValueCents,
    naturalToleranceLossCents,
    surplusValueCents,
    netVarianceCents,
    items,
  };
}

// ============================================================================
//  6. Reporte de Tiempo Promedio por Venta (POS)
// ============================================================================

export interface SaleTimingByCashierRow {
  cashier: string;
  saleCount: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

export interface SaleTimingItemRow {
  saleId: string;
  folio: string;
  date: string;
  cashier: string;
  paymentType: SalePaymentType;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  itemCount: number;
  totalCents: number;
}

export interface SaleTimingReport {
  range: ResolvedDateRange;
  totalSalesInRange: number;
  measuredSaleCount: number;
  unmeasuredSaleCount: number;
  averageDurationMs: number;
  averageDurationSec: number;
  minDurationMs: number;
  maxDurationMs: number;
  medianDurationMs: number;
  fastSalesCount: number; // <= 30s
  normalSalesCount: number; // > 30s && <= 90s
  slowSalesCount: number; // > 90s
  byCashier: SaleTimingByCashierRow[];
  items: SaleTimingItemRow[];
}

export function formatDurationCompact(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 60) {
    return `${(safeMs / 1000).toFixed(1)} s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function resolveSaleDurationMs(sale: SaleRecord): number | null {
  if (sale.durationMs !== undefined && Number.isFinite(sale.durationMs) && sale.durationMs >= 0) {
    return Math.round(sale.durationMs);
  }
  if (sale.startedAt && sale.finishedAt) {
    const startMs = Date.parse(sale.startedAt);
    const endMs = Date.parse(sale.finishedAt);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      return Math.round(endMs - startMs);
    }
  }
  return null;
}

export function buildSaleTimingReport(
  sales: SaleRecord[],
  range: ResolvedDateRange
): SaleTimingReport {
  const filtered = sales.filter(
    (s) => s.status !== 'CANCELADA' && isDateWithinRange(resolveRecordLocalDate(s), range)
  );

  const items: SaleTimingItemRow[] = [];
  let unmeasuredSaleCount = 0;

  for (const sale of filtered) {
    const durationMs = resolveSaleDurationMs(sale);
    if (durationMs === null) {
      unmeasuredSaleCount += 1;
      continue;
    }
    const itemCount = (sale.items || []).reduce((acc, i) => acc + (i.qty > 0 ? 1 : 0), 0);
    items.push({
      saleId: sale.id,
      folio: sale.folio,
      date: resolveRecordLocalDate(sale) || range.startDate,
      cashier: (sale.cashier || 'Cajero').trim() || 'Cajero',
      paymentType: sale.paymentType,
      startedAt: sale.startedAt || sale.timestamp,
      finishedAt: sale.finishedAt || sale.timestamp,
      durationMs,
      itemCount,
      totalCents: resolveSaleTotalCents(sale),
    });
  }

  const measuredSaleCount = items.length;
  if (measuredSaleCount === 0) {
    return {
      range,
      totalSalesInRange: filtered.length,
      measuredSaleCount: 0,
      unmeasuredSaleCount,
      averageDurationMs: 0,
      averageDurationSec: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      medianDurationMs: 0,
      fastSalesCount: 0,
      normalSalesCount: 0,
      slowSalesCount: 0,
      byCashier: [],
      items: [],
    };
  }

  let totalMs = 0;
  let minDurationMs = Number.POSITIVE_INFINITY;
  let maxDurationMs = 0;
  let fastSalesCount = 0;
  let normalSalesCount = 0;
  let slowSalesCount = 0;

  const cashierAcc = new Map<
    string,
    { cashier: string; count: number; totalMs: number; minMs: number; maxMs: number }
  >();

  for (const item of items) {
    totalMs += item.durationMs;
    if (item.durationMs < minDurationMs) minDurationMs = item.durationMs;
    if (item.durationMs > maxDurationMs) maxDurationMs = item.durationMs;

    if (item.durationMs <= 30_000) fastSalesCount += 1;
    else if (item.durationMs <= 90_000) normalSalesCount += 1;
    else slowSalesCount += 1;

    const cRow = cashierAcc.get(item.cashier) || {
      cashier: item.cashier,
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
    };
    cRow.count += 1;
    cRow.totalMs += item.durationMs;
    if (item.durationMs < cRow.minMs) cRow.minMs = item.durationMs;
    if (item.durationMs > cRow.maxMs) cRow.maxMs = item.durationMs;
    cashierAcc.set(item.cashier, cRow);
  }

  const sortedDurations = items.map((i) => i.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(sortedDurations.length / 2);
  const medianDurationMs =
    sortedDurations.length % 2 === 1
      ? sortedDurations[mid]
      : Math.round((sortedDurations[mid - 1] + sortedDurations[mid]) / 2);

  const averageDurationMs = Math.round(totalMs / measuredSaleCount);
  const averageDurationSec = Math.round(averageDurationMs / 100) / 10;

  const byCashier: SaleTimingByCashierRow[] = Array.from(cashierAcc.values())
    .map((c) => ({
      cashier: c.cashier,
      saleCount: c.count,
      averageDurationMs: Math.round(c.totalMs / c.count),
      minDurationMs: c.minMs,
      maxDurationMs: c.maxMs,
    }))
    .sort((a, b) => a.averageDurationMs - b.averageDurationMs);

  items.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));

  return {
    range,
    totalSalesInRange: filtered.length,
    measuredSaleCount,
    unmeasuredSaleCount,
    averageDurationMs,
    averageDurationSec,
    minDurationMs,
    maxDurationMs,
    medianDurationMs,
    fastSalesCount,
    normalSalesCount,
    slowSalesCount,
    byCashier,
    items,
  };
}

// ============================================================================
//  7. Reporte de Valor del Inventario a Costo y a Precio
// ============================================================================

export interface InventoryValuationCategoryRow {
  category: string;
  skuCount: number;
  totalUnits: number;
  totalCostCents: number;
  totalRetailCents: number;
  potentialProfitCents: number;
}

export interface InventoryValuationItemRow {
  sku: string;
  name: string;
  category: string;
  stock: number;
  unitCostCents: number;
  unitPriceCents: number;
  costValueCents: number;
  retailValueCents: number;
  potentialProfitCents: number;
  potentialMarginPct: number;
}

export interface InventoryValuationReport {
  skuCount: number;
  totalUnitsOnHand: number;
  totalCostCents: number;
  totalRetailCents: number;
  potentialProfitCents: number;
  overallMarginPct: number;
  byCategory: InventoryValuationCategoryRow[];
  items: InventoryValuationItemRow[];
}

export function buildInventoryValuationReport(
  products: ReportProductLike[],
  kardexEntries: KardexValuationLike[] = []
): InventoryValuationReport {
  const kardexLatestBySku = new Map<string, { balanceAfter: number; weightedAvgCost?: number }>();
  for (const entry of kardexEntries) {
    const sku =
      entry?.sku ||
      (typeof entry?.producto === 'object' && entry.producto
        ? entry.producto.sku
        : typeof entry?.producto === 'string'
          ? entry.producto
          : '') ||
      '';
    if (!sku || kardexLatestBySku.has(sku)) continue;
    const balanceAfter =
      typeof entry.balanceAfter === 'number'
        ? entry.balanceAfter
        : typeof entry.stockAfter === 'number'
          ? entry.stockAfter
          : typeof entry.saldoResultante === 'number'
            ? entry.saldoResultante
            : 0;
    kardexLatestBySku.set(sku, {
      balanceAfter,
      weightedAvgCost: entry.weightedAvgCost,
    });
  }

  let totalUnitsOnHand = 0;
  let totalCostCents = 0;
  let totalRetailCents = 0;

  const categoryAcc = new Map<string, InventoryValuationCategoryRow>();
  const items: InventoryValuationItemRow[] = [];

  for (const prod of products) {
    const kardexInfo = kardexLatestBySku.get(prod.sku);
    const effectiveStock = roundQty3(
      kardexInfo && kardexInfo.balanceAfter > 0 ? kardexInfo.balanceAfter : Math.max(0, prod.stock)
    );
    const catalogCost =
      prod.weightedAvgCost ??
      kardexInfo?.weightedAvgCost ??
      prod.lastPurchaseCost ??
      prod.purchaseCost ??
      prod.historicCost ??
      0;
    const unitCostCents = Math.max(0, Math.round(catalogCost * 100));
    const unitPriceCents = Math.max(0, Math.round((prod.price ?? 0) * 100));

    const costValueCents = Math.round(effectiveStock * unitCostCents);
    const retailValueCents = Math.round(effectiveStock * unitPriceCents);
    const potentialProfitCents = retailValueCents - costValueCents;
    const category = (prod.category || 'General').trim();

    totalUnitsOnHand = roundQty3(totalUnitsOnHand + effectiveStock);
    totalCostCents += costValueCents;
    totalRetailCents += retailValueCents;

    items.push({
      sku: prod.sku,
      name: prod.name,
      category,
      stock: effectiveStock,
      unitCostCents,
      unitPriceCents,
      costValueCents,
      retailValueCents,
      potentialProfitCents,
      potentialMarginPct: computeMarginPct(retailValueCents, potentialProfitCents),
    });

    const catRow = categoryAcc.get(category) || {
      category,
      skuCount: 0,
      totalUnits: 0,
      totalCostCents: 0,
      totalRetailCents: 0,
      potentialProfitCents: 0,
    };
    catRow.skuCount += 1;
    catRow.totalUnits = roundQty3(catRow.totalUnits + effectiveStock);
    catRow.totalCostCents += costValueCents;
    catRow.totalRetailCents += retailValueCents;
    catRow.potentialProfitCents += potentialProfitCents;
    categoryAcc.set(category, catRow);
  }

  items.sort((a, b) => b.retailValueCents - a.retailValueCents || a.sku.localeCompare(b.sku));
  const byCategory = Array.from(categoryAcc.values()).sort(
    (a, b) => b.totalRetailCents - a.totalRetailCents || a.category.localeCompare(b.category)
  );
  const potentialProfitCents = totalRetailCents - totalCostCents;

  return {
    skuCount: items.length,
    totalUnitsOnHand,
    totalCostCents,
    totalRetailCents,
    potentialProfitCents,
    overallMarginPct: computeMarginPct(totalRetailCents, potentialProfitCents),
    byCategory,
    items,
  };
}

// ============================================================================
//  8. Bitácora Local de Uso (30 días) y Satisfacción Semanal (1..5)
// ============================================================================

export interface UsageActivityEntry {
  date: string; // YYYY-MM-DD local
  actionsCount: number;
  salesCount: number;
  lastActiveAt: string; // ISO 8601
  users: string[];
}

export interface Usage30DaysMetric {
  asOfDate: string;
  windowStartDate: string;
  activeDays: number;
  windowDays: number;
  adherencePct: number;
  totalActions30d: number;
  totalSales30d: number;
  activeDates: string[];
}

export interface SatisfactionSurveyRecord {
  id: string;
  date: string; // YYYY-MM-DD local
  timestamp: string; // ISO 8601
  rating: 1 | 2 | 3 | 4 | 5;
  respondent: string;
  shiftId?: string;
  comment?: string;
}

export interface SatisfactionDueStatus {
  due: boolean;
  daysSinceLast: number | null;
  nextDueDate: string;
  lastSurvey?: SatisfactionSurveyRecord;
}

export interface SatisfactionScaleOption {
  value: 1 | 2 | 3 | 4 | 5;
  label: string;
}

export const SATISFACTION_SCALE_OPTIONS: readonly SatisfactionScaleOption[] = [
  { value: 1, label: 'Muy malo' },
  { value: 2, label: 'Malo' },
  { value: 3, label: 'Regular' },
  { value: 4, label: 'Bueno' },
  { value: 5, label: 'Excelente' },
] as const;

export interface SatisfactionMetric {
  asOfDate: string;
  responseCount: number;
  averageRating: number | null;
  latestRating: number | null;
  lastSurveyDate: string | null;
  isDueNow: boolean;
  nextDueDate: string;
}

export function recordUsageActivity(
  log: UsageActivityEntry[],
  params?: { date?: string; timestamp?: string; user?: string; isSale?: boolean }
): UsageActivityEntry[] {
  const now = new Date();
  const timestamp = params?.timestamp || now.toISOString();
  const date = normalizeDateToYyyyMmDd(params?.date) || formatLocalYyyyMmDd(now);
  const user = (params?.user || '').trim();
  const isSale = Boolean(params?.isSale);

  const byDate = new Map<string, UsageActivityEntry>();
  for (const entry of log) {
    const normDate = normalizeDateToYyyyMmDd(entry?.date);
    if (!normDate) continue;
    byDate.set(normDate, {
      date: normDate,
      actionsCount: Math.max(0, Math.round(entry.actionsCount || 0)),
      salesCount: Math.max(0, Math.round(entry.salesCount || 0)),
      lastActiveAt: entry.lastActiveAt || timestamp,
      users: Array.isArray(entry.users) ? [...entry.users] : [],
    });
  }

  const current = byDate.get(date) || {
    date,
    actionsCount: 0,
    salesCount: 0,
    lastActiveAt: timestamp,
    users: [],
  };

  const nextUsers =
    user && !current.users.includes(user) ? [...current.users, user] : current.users;

  byDate.set(date, {
    date,
    actionsCount: current.actionsCount + 1,
    salesCount: current.salesCount + (isSale ? 1 : 0),
    lastActiveAt: timestamp > current.lastActiveAt ? timestamp : current.lastActiveAt,
    users: nextUsers,
  });

  return Array.from(byDate.values())
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 365);
}

export function computeUsage30DaysMetric(
  log: UsageActivityEntry[],
  referenceDate?: string
): Usage30DaysMetric {
  const asOfDate = normalizeDateToYyyyMmDd(referenceDate) || formatLocalYyyyMmDd(new Date());
  const windowStartDate = addDaysLocal(asOfDate, -29);
  const windowDays = 30;

  const activeByDate = new Map<string, UsageActivityEntry>();
  for (const entry of log) {
    const d = normalizeDateToYyyyMmDd(entry?.date);
    if (!d || d < windowStartDate || d > asOfDate) continue;
    if ((entry.actionsCount || 0) <= 0) continue;
    const prev = activeByDate.get(d);
    activeByDate.set(d, {
      date: d,
      actionsCount: (prev?.actionsCount || 0) + entry.actionsCount,
      salesCount: (prev?.salesCount || 0) + (entry.salesCount || 0),
      lastActiveAt: entry.lastActiveAt,
      users: entry.users || [],
    });
  }

  const activeDates = Array.from(activeByDate.keys()).sort();
  let totalActions30d = 0;
  let totalSales30d = 0;
  for (const entry of activeByDate.values()) {
    totalActions30d += entry.actionsCount;
    totalSales30d += entry.salesCount;
  }

  const activeDays = activeDates.length;
  return {
    asOfDate,
    windowStartDate,
    activeDays,
    windowDays,
    adherencePct: round2((activeDays * 100) / windowDays),
    totalActions30d,
    totalSales30d,
    activeDates,
  };
}

function getLatestSurvey(surveys: SatisfactionSurveyRecord[]): SatisfactionSurveyRecord | undefined {
  const valid = surveys.filter(
    (s) =>
      s &&
      normalizeDateToYyyyMmDd(s.date) !== null &&
      Number.isInteger(s.rating) &&
      s.rating >= 1 &&
      s.rating <= 5
  );
  if (valid.length === 0) return undefined;
  return [...valid].sort((a, b) => {
    const dCmp = (normalizeDateToYyyyMmDd(b.date) || '').localeCompare(
      normalizeDateToYyyyMmDd(a.date) || ''
    );
    if (dCmp !== 0) return dCmp;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  })[0];
}

export function isSatisfactionSurveyDue(
  surveys: SatisfactionSurveyRecord[],
  referenceDate?: string
): SatisfactionDueStatus {
  const today = normalizeDateToYyyyMmDd(referenceDate) || formatLocalYyyyMmDd(new Date());
  const latest = getLatestSurvey(surveys);
  if (!latest) {
    return { due: true, daysSinceLast: null, nextDueDate: today };
  }
  const lastDate = normalizeDateToYyyyMmDd(latest.date) || today;
  const days = daysBetweenLocalDates(lastDate, today);
  return {
    due: days >= 7,
    daysSinceLast: days,
    nextDueDate: addDaysLocal(lastDate, 7),
    lastSurvey: latest,
  };
}

export function recordSatisfactionSurvey(
  surveys: SatisfactionSurveyRecord[],
  params: {
    rating: number;
    respondent: string;
    shiftId?: string;
    comment?: string;
    date?: string;
    timestamp?: string;
    force?: boolean;
  }
): {
  ok: boolean;
  message: string;
  surveys: SatisfactionSurveyRecord[];
  record?: SatisfactionSurveyRecord;
} {
  if (!Number.isInteger(params.rating) || params.rating < 1 || params.rating > 5) {
    return {
      ok: false,
      message: 'La calificación de satisfacción debe ser un número entero del 1 al 5.',
      surveys,
    };
  }

  const now = new Date();
  const date = normalizeDateToYyyyMmDd(params.date) || formatLocalYyyyMmDd(now);
  const timestamp = params.timestamp || now.toISOString();
  const dueStatus = isSatisfactionSurveyDue(surveys, date);

  if (!params.force && !dueStatus.due) {
    return {
      ok: false,
      message: `La encuesta semanal ya fue registrada (${dueStatus.lastSurvey?.date}). Próxima disponible el ${dueStatus.nextDueDate}.`,
      surveys,
    };
  }

  const record: SatisfactionSurveyRecord = {
    id: `SAT-${Date.now()}-${surveys.length + 1}`,
    date,
    timestamp,
    rating: params.rating as 1 | 2 | 3 | 4 | 5,
    respondent: params.respondent.trim() || 'Tendero',
    shiftId: params.shiftId,
    comment: params.comment?.trim() || undefined,
  };

  return {
    ok: true,
    message: `Encuesta semanal guardada (${record.rating}/5).`,
    surveys: [record, ...surveys],
    record,
  };
}

export function computeSatisfactionMetric(
  surveys: SatisfactionSurveyRecord[],
  referenceDate?: string
): SatisfactionMetric {
  const asOfDate = normalizeDateToYyyyMmDd(referenceDate) || formatLocalYyyyMmDd(new Date());
  const valid = surveys.filter(
    (s) =>
      s &&
      normalizeDateToYyyyMmDd(s.date) !== null &&
      Number.isInteger(s.rating) &&
      s.rating >= 1 &&
      s.rating <= 5
  );
  const dueStatus = isSatisfactionSurveyDue(valid, asOfDate);

  if (valid.length === 0) {
    return {
      asOfDate,
      responseCount: 0,
      averageRating: null,
      latestRating: null,
      lastSurveyDate: null,
      isDueNow: dueStatus.due,
      nextDueDate: dueStatus.nextDueDate,
    };
  }

  const sum = valid.reduce((acc, s) => acc + s.rating, 0);
  const latest = getLatestSurvey(valid)!;

  return {
    asOfDate,
    responseCount: valid.length,
    averageRating: round2(sum / valid.length),
    latestRating: latest.rating,
    lastSurveyDate: normalizeDateToYyyyMmDd(latest.date),
    isDueNow: dueStatus.due,
    nextDueDate: dueStatus.nextDueDate,
  };
}

// ============================================================================
//  Panel con los 8 Indicadores Operativos (Imagen 4)
// ============================================================================

export type IndicatorId =
  | 'VENTAS'
  | 'MARGENES'
  | 'MERMAS'
  | 'CREDITOS_VENCIDOS'
  | 'DIFERENCIA_CONTEO'
  | 'TIEMPO_POR_VENTA'
  | 'USO_30_DIAS'
  | 'SATISFACCION';

export type IndicatorTone = 'emerald' | 'amber' | 'red' | 'slate';

export interface IndicatorCardMetric {
  id: IndicatorId;
  order: number;
  title: string;
  subtitle: string;
  valueFormatted: string;
  rawValue: number | null;
  detail: string;
  statusBadge: string;
  tone: IndicatorTone;
  targetReportTab?: ReportTabKey;
}

export interface ReportsBundle {
  range: ResolvedDateRange;
  sales: SalesReport;
  margins: MarginsReport;
  shrink: ShrinkReport;
  overdueCredits: OverdueCreditsReport;
  auditDifferences: AuditDifferencesReport;
  saleTiming: SaleTimingReport;
  inventoryValuation: InventoryValuationReport;
  usage30Days: Usage30DaysMetric;
  satisfaction: SatisfactionMetric;
  indicators: IndicatorCardMetric[];
}

export function buildEightIndicatorsPanel(params: {
  sales: SalesReport;
  margins: MarginsReport;
  shrink: ShrinkReport;
  overdueCredits: OverdueCreditsReport;
  auditDifferences: AuditDifferencesReport;
  saleTiming: SaleTimingReport;
  usage30Days: Usage30DaysMetric;
  satisfaction: SatisfactionMetric;
}): IndicatorCardMetric[] {
  const {
    sales,
    margins,
    shrink,
    overdueCredits,
    auditDifferences,
    saleTiming,
    usage30Days,
    satisfaction,
  } = params;

  const avgMarginPct = margins.overallMarginPct;

  return [
    {
      id: 'VENTAS',
      order: 1,
      title: 'Ventas',
      subtitle: 'Ingreso neto del periodo',
      valueFormatted: formatCentsMxn(sales.netSalesCents),
      rawValue: sales.netSalesCents,
      detail: `${sales.ticketCount} ticket(s) · Bruto ${formatCentsMxn(sales.grossSalesCents)} · Dev. ${formatCentsMxn(sales.returnsCents)}`,
      statusBadge: sales.netSalesCents > 0 ? 'Activo' : 'Sin ventas',
      tone: sales.netSalesCents > 0 ? 'emerald' : 'slate',
      targetReportTab: 'VENTAS',
    },
    {
      id: 'MARGENES',
      order: 2,
      title: 'Márgenes',
      subtitle: 'Ganancia por producto y por venta',
      valueFormatted: `${formatCentsMxn(margins.totalMarginCents)} (${avgMarginPct.toFixed(1)}%)`,
      rawValue: margins.totalMarginCents,
      detail: `Ingreso neto ${formatCentsMxn(margins.totalNetRevenueCents)} vs Costo ${formatCentsMxn(margins.totalNetCostCents)}`,
      statusBadge:
        margins.totalNetRevenueCents === 0
          ? 'Sin datos'
          : avgMarginPct >= 20
          ? 'Saludable'
          : avgMarginPct >= 12
          ? 'Ajustado'
          : 'Margen bajo',
      tone:
        margins.totalNetRevenueCents === 0
          ? 'slate'
          : avgMarginPct >= 20
          ? 'emerald'
          : avgMarginPct >= 12
          ? 'amber'
          : 'red',
      targetReportTab: 'MARGENES',
    },
    {
      id: 'MERMAS',
      order: 3,
      title: 'Mermas',
      subtitle: 'Pérdidas por caducidad, rotura o faltante',
      valueFormatted: formatCentsMxn(shrink.totalLossCents),
      rawValue: shrink.totalLossCents,
      detail: `${shrink.recordCount} registro(s) · ${shrink.totalQty} u. · ${shrink.unreviewedCount} sin auditar`,
      statusBadge: shrink.totalLossCents === 0 ? 'Cero merma' : 'Con pérdidas',
      tone: shrink.totalLossCents === 0 ? 'emerald' : shrink.unreviewedCount > 0 ? 'red' : 'amber',
      targetReportTab: 'MERMAS',
    },
    {
      id: 'CREDITOS_VENCIDOS',
      order: 4,
      title: 'Créditos vencidos',
      subtitle: 'Fiado fuera de plazo',
      valueFormatted: formatCentsMxn(overdueCredits.totalOverdueCents),
      rawValue: overdueCredits.totalOverdueCents,
      detail: `${overdueCredits.overdueCustomerCount} cliente(s) vencido(s) · Cartera total ${formatCentsMxn(overdueCredits.totalPortfolioCents)}`,
      statusBadge: overdueCredits.totalOverdueCents === 0 ? 'Al corriente' : `${overdueCredits.overdueRatePct.toFixed(1)}% vencido`,
      tone: overdueCredits.totalOverdueCents === 0 ? 'emerald' : overdueCredits.overdueRatePct >= 25 ? 'red' : 'amber',
      targetReportTab: 'CREDITOS_VENCIDOS',
    },
    {
      id: 'DIFERENCIA_CONTEO',
      order: 5,
      title: 'Diferencia stock-conteo',
      subtitle: 'Existencia del sistema contra conteo físico',
      valueFormatted: formatCentsMxn(auditDifferences.netVarianceCents),
      rawValue: auditDifferences.netVarianceCents,
      detail: `${auditDifferences.varianceSkuCount} de ${auditDifferences.totalAuditedSkus} SKU con variación · Faltante ${formatCentsMxn(auditDifferences.shortageValueCents)}`,
      statusBadge:
        auditDifferences.totalAuditedSkus === 0
          ? 'Sin conteos'
          : auditDifferences.shortageValueCents === 0 && auditDifferences.surplusValueCents === 0
          ? 'Cuadrado'
          : 'Con diferencias',
      tone:
        auditDifferences.totalAuditedSkus === 0
          ? 'slate'
          : auditDifferences.shortageValueCents === 0
          ? 'emerald'
          : 'red',
      targetReportTab: 'DIFERENCIAS_CONTEO',
    },
    {
      id: 'TIEMPO_POR_VENTA',
      order: 6,
      title: 'Tiempo por venta',
      subtitle: 'Rapidez de cobro en mostrador',
      valueFormatted:
        saleTiming.measuredSaleCount > 0 ? formatDurationCompact(saleTiming.averageDurationMs) : 'Sin mediciones',
      rawValue: saleTiming.measuredSaleCount > 0 ? saleTiming.averageDurationMs : null,
      detail:
        saleTiming.measuredSaleCount > 0
          ? `${saleTiming.measuredSaleCount} venta(s) cronometrada(s) · Mín ${formatDurationCompact(saleTiming.minDurationMs)} · Máx ${formatDurationCompact(saleTiming.maxDurationMs)}`
          : `${saleTiming.totalSalesInRange} venta(s) sin cronometraje previo`,
      statusBadge:
        saleTiming.measuredSaleCount === 0
          ? 'Pendiente'
          : saleTiming.averageDurationMs <= 45_000
          ? 'Ágil'
          : saleTiming.averageDurationMs <= 90_000
          ? 'Estándar'
          : 'Lento',
      tone:
        saleTiming.measuredSaleCount === 0
          ? 'slate'
          : saleTiming.averageDurationMs <= 45_000
          ? 'emerald'
          : saleTiming.averageDurationMs <= 90_000
          ? 'amber'
          : 'red',
      targetReportTab: 'TIEMPO_VENTAS',
    },
    {
      id: 'USO_30_DIAS',
      order: 7,
      title: 'Uso a los 30 días',
      subtitle: 'Días con actividad (bitácora local)',
      valueFormatted: `${usage30Days.activeDays} / ${usage30Days.windowDays} días`,
      rawValue: usage30Days.activeDays,
      detail: `${usage30Days.adherencePct.toFixed(1)}% constancia · ${usage30Days.totalActions30d} operaciones · ${usage30Days.totalSales30d} ventas`,
      statusBadge:
        usage30Days.activeDays >= 20 ? 'Constante' : usage30Days.activeDays >= 8 ? 'En marcha' : 'Inicial',
      tone: usage30Days.activeDays >= 20 ? 'emerald' : usage30Days.activeDays >= 8 ? 'amber' : 'slate',
    },
    {
      id: 'SATISFACCION',
      order: 8,
      title: 'Satisfacción',
      subtitle: 'Encuesta semanal (1 a 5) al cerrar turno',
      valueFormatted:
        satisfaction.latestRating !== null ? `${satisfaction.latestRating} / 5` : 'Sin encuesta',
      rawValue: satisfaction.latestRating,
      detail:
        satisfaction.responseCount > 0
          ? `Promedio ${satisfaction.averageRating?.toFixed(2)}/5 (${satisfaction.responseCount} resp.) · Última: ${satisfaction.lastSurveyDate}`
          : 'Disponible una vez por semana al cerrar turno',
      statusBadge: satisfaction.isDueNow ? 'Encuesta pendiente' : 'Semana cubierta',
      tone:
        satisfaction.latestRating === null
          ? 'slate'
          : satisfaction.latestRating >= 4
          ? 'emerald'
          : satisfaction.latestRating === 3
          ? 'amber'
          : 'red',
    },
  ];
}

export function buildReportsBundle(params: {
  filter: ReportDateFilterInput;
  sales: SaleRecord[];
  returns: SaleReturnRecord[];
  shrinkRecords: ShrinkRecordLike[];
  customers: CreditCustomerLike[];
  auditLines: AuditLineLike[];
  products: ReportProductLike[];
  kardexEntries?: KardexValuationLike[];
  usageActivityLog?: UsageActivityEntry[];
  satisfactionSurveys?: SatisfactionSurveyRecord[];
  includeUndatedAudit?: boolean;
}): ReportsBundle {
  const range = resolveReportDateRange(params.filter);
  const referenceDate = normalizeDateToYyyyMmDd(params.filter.referenceDate) || range.endDate;

  const sales = buildSalesReport(params.sales, params.returns, range);
  const margins = buildMarginsReport(params.sales, params.returns, params.products, range);
  const shrink = buildShrinkReport(params.shrinkRecords, params.products, range);
  const overdueCredits = buildOverdueCreditsReport(params.customers, referenceDate);
  const auditDifferences = buildAuditDifferencesReport(params.auditLines, params.products, range, {
    includeUndated: params.includeUndatedAudit,
  });
  const saleTiming = buildSaleTimingReport(params.sales, range);
  const inventoryValuation = buildInventoryValuationReport(params.products, params.kardexEntries || []);
  const usage30Days = computeUsage30DaysMetric(params.usageActivityLog || [], referenceDate);
  const satisfaction = computeSatisfactionMetric(params.satisfactionSurveys || [], referenceDate);

  const indicators = buildEightIndicatorsPanel({
    sales,
    margins,
    shrink,
    overdueCredits,
    auditDifferences,
    saleTiming,
    usage30Days,
    satisfaction,
  });

  return {
    range,
    sales,
    margins,
    shrink,
    overdueCredits,
    auditDifferences,
    saleTiming,
    inventoryValuation,
    usage30Days,
    satisfaction,
    indicators,
  };
}

// ============================================================================
//  9. Exportación CSV UTF-8 con BOM (\uFEFF)
// ============================================================================

function neutralizeCsvFormula(text: string): string {
  if (!text) return '';
  const trimmed = text.trimStart();
  if (!trimmed) return text;
  const first = trimmed[0];
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
    return `'${text}`;
  }
  if (first === '-' && !/^-\d+(?:\.\d+)?$/.test(trimmed)) {
    return `'${text}`;
  }
  return text;
}

export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'SI' : 'NO';
  }
  const safe = neutralizeCsvFormula(String(value));
  if (/[",\r\n]/.test(safe) || safe.startsWith(' ') || safe.endsWith(' ')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function serializeCsv(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][]
): string {
  const headerLine = headers.map((h) => escapeCsvCell(h)).join(',');
  const dataLines = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  return `${UTF8_BOM}${[headerLine, ...dataLines].join('\r\n')}\r\n`;
}

export function exportSalesReportCsv(report: SalesReport, storeName = ''): string {
  const rows: (string | number)[][] = [];
  for (const pay of report.byPaymentType) {
    rows.push([
      'FORMA_PAGO',
      pay.paymentType,
      pay.paymentType === 'EFECTIVO' ? 'Ventas de Contado' : 'Ventas a Fiado',
      pay.ticketCount,
      centsToFixedPesos(pay.grossSalesCents),
      centsToFixedPesos(pay.returnsCents),
      centsToFixedPesos(pay.netSalesCents),
      `${pay.sharePct.toFixed(2)}%`,
    ]);
  }
  for (const prod of report.byProduct) {
    rows.push([
      'PRODUCTO',
      prod.sku,
      prod.name,
      prod.netQty,
      centsToFixedPesos(prod.grossSalesCents),
      centsToFixedPesos(prod.returnsCents),
      centsToFixedPesos(prod.netSalesCents),
      `${prod.grossQty} vendido / ${prod.returnedQty} dev.`,
    ]);
  }
  for (const hr of report.byHour) {
    if (hr.ticketCount === 0 && hr.returnsCents === 0) continue;
    rows.push([
      'HORA',
      hr.label,
      storeName || 'Sucursal',
      hr.ticketCount,
      centsToFixedPesos(hr.grossSalesCents),
      centsToFixedPesos(hr.returnsCents),
      centsToFixedPesos(hr.netSalesCents),
      `${report.range.startDate} a ${report.range.endDate}`,
    ]);
  }
  rows.push([
    'TOTAL',
    `${report.range.startDate}..${report.range.endDate}`,
    'TOTAL VENTAS DEL PERIODO',
    report.ticketCount,
    centsToFixedPesos(report.grossSalesCents),
    centsToFixedPesos(report.returnsCents),
    centsToFixedPesos(report.netSalesCents),
    `Descuentos: $${centsToFixedPesos(report.discountsCents)}`,
  ]);
  return serializeCsv(
    ['Sección', 'Clave / Hora', 'Descripción', 'Cantidad / Tickets', 'Bruto MXN', 'Devoluciones MXN', 'Neto MXN', 'Detalle'],
    rows
  );
}

export function exportMarginsReportCsv(report: MarginsReport): string {
  const rows: (string | number)[][] = report.byProduct.map((p) => [
    'PRODUCTO',
    p.sku,
    p.name,
    p.netQty,
    centsToFixedPesos(p.netRevenueCents),
    centsToFixedPesos(p.netCostCents),
    centsToFixedPesos(p.marginCents),
    p.marginPct.toFixed(2),
  ]);
  for (const s of report.bySale) {
    rows.push([
      'VENTA',
      s.folio,
      `${s.date} · ${s.cashier} (${s.paymentType})`,
      1,
      centsToFixedPesos(s.netRevenueCents),
      centsToFixedPesos(s.netCostCents),
      centsToFixedPesos(s.marginCents),
      s.marginPct.toFixed(2),
    ]);
  }
  rows.push([
    'TOTAL',
    `${report.range.startDate}..${report.range.endDate}`,
    'TOTAL MARGEN DEL PERIODO',
    report.bySale.length,
    centsToFixedPesos(report.totalNetRevenueCents),
    centsToFixedPesos(report.totalNetCostCents),
    centsToFixedPesos(report.totalMarginCents),
    report.overallMarginPct.toFixed(2),
  ]);
  return serializeCsv(
    ['Nivel', 'SKU / Folio', 'Nombre / Detalle', 'Cant. Neta', 'Ingreso Neto MXN', 'Costo Neto MXN', 'Ganancia MXN', 'Margen %'],
    rows
  );
}

export function exportShrinkReportCsv(report: ShrinkReport): string {
  const rows: (string | number)[][] = [
    ...report.byReason.map((r) => [
      'MOTIVO',
      r.reason,
      '-',
      r.recordCount,
      r.totalQty,
      centsToFixedPesos(r.totalLossCents),
      `${r.sharePct.toFixed(2)}%`,
    ]),
    ...report.byProduct.map((p) => [
      'PRODUCTO',
      p.sku,
      p.name,
      p.recordCount,
      p.totalQty,
      centsToFixedPesos(p.totalLossCents),
      p.reasons.join('; '),
    ]),
    [
      'TOTAL',
      `${report.range.startDate}..${report.range.endDate}`,
      'TOTAL MERMAS',
      report.recordCount,
      report.totalQty,
      centsToFixedPesos(report.totalLossCents),
      `${report.reviewedCount} auditadas / ${report.unreviewedCount} pendientes`,
    ],
  ];
  return serializeCsv(
    ['Agrupación', 'Motivo / SKU', 'Producto', 'Registros', 'Cantidad Total', 'Pérdida al Costo MXN', 'Detalle'],
    rows
  );
}

export function exportOverdueCreditsReportCsv(report: OverdueCreditsReport): string {
  const rows: (string | number)[][] = [
    ...report.byAgingBucket.map((b) => [
      'ANTIGUEDAD',
      b.bucket,
      b.label,
      b.customerCount,
      0,
      centsToFixedPesos(b.overdueCents),
      `${b.sharePct.toFixed(2)}%`,
    ]),
    ...report.byCustomer.map((c) => [
      'CLIENTE',
      c.customerId,
      c.name,
      c.maxDaysOverdue,
      c.oldestDueDate || '-',
      centsToFixedPesos(c.overdueCents),
      `Saldo total $${centsToFixedPesos(c.totalBalanceCents)}`,
    ]),
    [
      'TOTAL',
      report.asOfDate,
      'TOTAL VENCIDO',
      report.overdueCustomerCount,
      report.totalIndebtedCustomerCount,
      centsToFixedPesos(report.totalOverdueCents),
      `Cartera total $${centsToFixedPesos(report.totalPortfolioCents)} (${report.overdueRatePct.toFixed(2)}%)`,
    ],
  ];
  return serializeCsv(
    ['Sección', 'ID / Rango', 'Cliente / Antigüedad', 'Días / Clientes', 'Vencimiento Más Antiguo', 'Saldo Vencido MXN', 'Detalle'],
    rows
  );
}

export function exportAuditDifferencesReportCsv(report: AuditDifferencesReport): string {
  const rows: (string | number)[][] = report.items.map((item) => [
    item.sku,
    item.name,
    item.saleUnit,
    item.systemQty,
    item.countedQty,
    item.diffQty,
    centsToFixedPesos(item.unitCostCents),
    centsToFixedPesos(item.diffValueCents),
    item.classification,
    item.status,
  ]);
  rows.push([
    'TOTAL',
    `${report.totalAuditedSkus} SKUs auditados`,
    '-',
    0,
    0,
    report.varianceSkuCount,
    '-',
    centsToFixedPesos(report.netVarianceCents),
    `Faltante $${centsToFixedPesos(report.shortageValueCents)} / Sobrante $${centsToFixedPesos(report.surplusValueCents)}`,
    `Natural $${centsToFixedPesos(report.naturalToleranceLossCents)}`,
  ]);
  return serializeCsv(
    ['SKU', 'Producto', 'Unidad', 'Sistema', 'Conteo Físico', 'Diferencia', 'Costo Unit. MXN', 'Impacto Neto MXN', 'Clasificación', 'Estatus'],
    rows
  );
}

export function exportSaleTimingReportCsv(report: SaleTimingReport): string {
  const rows: (string | number)[][] = report.items.map((item) => [
    item.folio,
    item.date,
    item.cashier,
    item.paymentType,
    item.startedAt,
    item.finishedAt,
    item.durationMs,
    (item.durationMs / 1000).toFixed(2),
    item.itemCount,
    centsToFixedPesos(item.totalCents),
  ]);
  rows.push([
    'PROMEDIO',
    `${report.range.startDate}..${report.range.endDate}`,
    `${report.measuredSaleCount} ventas medidas`,
    '-',
    '-',
    '-',
    report.averageDurationMs,
    report.averageDurationSec.toFixed(1),
    report.totalSalesInRange,
    '-',
  ]);
  return serializeCsv(
    ['Folio', 'Fecha', 'Cajero', 'Forma de Pago', 'Inicio ISO', 'Fin ISO', 'Duración (ms)', 'Duración (seg)', 'Partidas', 'Total MXN'],
    rows
  );
}

export function exportInventoryValuationReportCsv(report: InventoryValuationReport): string {
  const rows: (string | number)[][] = report.items.map((item) => [
    item.sku,
    item.name,
    item.category,
    item.stock,
    centsToFixedPesos(item.unitCostCents),
    centsToFixedPesos(item.unitPriceCents),
    centsToFixedPesos(item.costValueCents),
    centsToFixedPesos(item.retailValueCents),
    centsToFixedPesos(item.potentialProfitCents),
    item.potentialMarginPct.toFixed(2),
  ]);
  rows.push([
    'TOTAL',
    `${report.skuCount} productos`,
    'INVENTARIO COMPLETO',
    report.totalUnitsOnHand,
    '-',
    '-',
    centsToFixedPesos(report.totalCostCents),
    centsToFixedPesos(report.totalRetailCents),
    centsToFixedPesos(report.potentialProfitCents),
    report.overallMarginPct.toFixed(2),
  ]);
  return serializeCsv(
    ['SKU', 'Producto', 'Categoría', 'Existencia', 'Costo Unit. MXN', 'Precio Unit. MXN', 'Valor a Costo MXN', 'Valor a Precio MXN', 'Utilidad Potencial MXN', 'Margen %'],
    rows
  );
}

export function exportIndicatorsPanelCsv(indicators: IndicatorCardMetric[], range: ResolvedDateRange): string {
  const rows: (string | number)[][] = indicators.map((ind) => [
    ind.order,
    ind.id,
    ind.title,
    ind.subtitle,
    ind.valueFormatted,
    ind.statusBadge,
    ind.detail,
    `${range.startDate}..${range.endDate}`,
  ]);
  return serializeCsv(
    ['#', 'Clave', 'Indicador', 'Descripción', 'Valor Actual', 'Estado', 'Detalle', 'Periodo'],
    rows
  );
}
