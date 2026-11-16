import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaleRecord, type SaleReturnRecord } from './sales.ts';
import type { KardexEntry } from './kardex.ts';
import type { CreditCustomerLike } from './credit.ts';
import type { ShrinkRecordLike } from './shrink.ts';
import {
  UTF8_BOM,
  normalizeDateToYyyyMmDd,
  resolveReportDateRange,
  buildSalesReport,
  buildMarginsReport,
  buildShrinkReport,
  buildOverdueCreditsReport,
  buildAuditDifferencesReport,
  buildSaleTimingReport,
  buildInventoryValuationReport,
  recordUsageActivity,
  computeUsage30DaysMetric,
  isSatisfactionSurveyDue,
  recordSatisfactionSurvey,
  computeSatisfactionMetric,
  buildReportsBundle,
  serializeCsv,
  exportSalesReportCsv,
  exportMarginsReportCsv,
  exportShrinkReportCsv,
  exportOverdueCreditsReportCsv,
  exportAuditDifferencesReportCsv,
  exportSaleTimingReportCsv,
  exportInventoryValuationReportCsv,
  exportIndicatorsPanelCsv,
  type ReportProductLike,
  type AuditLineLike,
} from './reports.ts';

test('Fechas: normaliza YYYY-MM-DD y DD/MM/YYYY, rechaza inválidas y resuelve hoy/semana/mes/rango', () => {
  assert.equal(normalizeDateToYyyyMmDd('2026-11-12'), '2026-11-12');
  assert.equal(normalizeDateToYyyyMmDd('22/10/2026'), '2026-10-22');
  assert.equal(normalizeDateToYyyyMmDd('2026-11-12 08:30:00'), '2026-11-12');
  assert.equal(normalizeDateToYyyyMmDd('2026-02-30'), null);
  assert.equal(normalizeDateToYyyyMmDd('31/04/2026'), null);
  assert.equal(normalizeDateToYyyyMmDd(''), null);

  // HOY
  assert.deepEqual(resolveReportDateRange({ preset: 'HOY', referenceDate: '2026-11-12' }), {
    preset: 'HOY',
    startDate: '2026-11-12',
    endDate: '2026-11-12',
  });

  // SEMANA: 2026-11-12 es jueves -> lunes 2026-11-09 al 2026-11-12
  assert.deepEqual(resolveReportDateRange({ preset: 'SEMANA', referenceDate: '2026-11-12' }), {
    preset: 'SEMANA',
    startDate: '2026-11-09',
    endDate: '2026-11-12',
  });

  // SEMANA cruce de año: 2026-01-01 es jueves -> lunes 2025-12-29 al 2026-01-01
  assert.deepEqual(resolveReportDateRange({ preset: 'SEMANA', referenceDate: '2026-01-01' }), {
    preset: 'SEMANA',
    startDate: '2025-12-29',
    endDate: '2026-01-01',
  });

  // MES
  assert.deepEqual(resolveReportDateRange({ preset: 'MES', referenceDate: '2026-11-12' }), {
    preset: 'MES',
    startDate: '2026-11-01',
    endDate: '2026-11-12',
  });

  // RANGO invertido se ordena automáticamente
  assert.deepEqual(
    resolveReportDateRange({
      preset: 'RANGO',
      startDate: '2026-10-31',
      endDate: '2026-10-05',
    }),
    {
      preset: 'RANGO',
      startDate: '2026-10-05',
      endDate: '2026-10-31',
    }
  );
});

test('Ventas + Márgenes: totales exactos calculados a mano en centavos, redondeo, devoluciones y filtros', () => {
  const products: ReportProductLike[] = [
    {
      sku: 'COC-600',
      name: 'Coca-Cola 600ml',
      category: 'Bebidas',
      stock: 20,
      price: 20.0,
      weightedAvgCost: 13.0,
    },
    {
      sku: 'QUE-GRA',
      name: 'Queso fresco granel',
      category: 'Lácteos',
      stock: 5,
      price: 125.0,
      weightedAvgCost: 87.5,
    },
    {
      sku: 'PAN-DOL',
      name: 'Bolillo pieza',
      category: 'Panadería',
      stock: 50,
      price: 3.33,
      historicCost: 1.5,
    },
  ];

  // Timestamps sin 'Z' usan hora local determinista (horas 9, 14 y fuera de rango 2026-11-01)
  const ts1Start = new Date(2026, 10, 10, 9, 10, 0).toISOString();
  const ts1End = new Date(2026, 10, 10, 9, 10, 25).toISOString(); // 25s
  const sale1 = createSaleRecord({
    folio: 'V-1001',
    cashier: 'Ana',
    paymentType: 'EFECTIVO',
    date: '2026-11-10',
    timestamp: ts1End,
    startedAt: ts1Start,
    finishedAt: ts1End,
    items: [
      { sku: 'COC-600', name: 'Coca-Cola 600ml', qty: 3, unitPrice: 20.0, unitCost: 13.0, subtotal: 60.0 },
      // 0.350 kg * $125.00 = $43.75 (4375 cents); costo = round(0.35 * 8750) = 3063 cents
      { sku: 'QUE-GRA', name: 'Queso fresco granel', qty: 0.35, unitPrice: 125.0, unitCost: 87.5, subtotal: 43.75 },
    ],
  });

  // Venta 2 con descuento de $10 sobre $100 bruto -> neto $90.00 (9000 cents) a FIADO el mismo periodo
  const ts2Start = new Date(2026, 10, 11, 14, 0, 0).toISOString();
  const ts2End = new Date(2026, 10, 11, 14, 1, 5).toISOString(); // 65s
  const sale2 = createSaleRecord({
    folio: 'V-1002',
    cashier: 'Beto',
    paymentType: 'FIADO',
    customerId: 'CLI-1',
    customerName: 'Doña Mary',
    date: '2026-11-11',
    timestamp: ts2End,
    startedAt: ts2Start,
    finishedAt: ts2End,
    discountAmount: 10.0,
    items: [
      { sku: 'COC-600', name: 'Coca-Cola 600ml', qty: 5, unitPrice: 20.0, unitCost: 13.0, subtotal: 100.0 },
    ],
  });

  // Venta 3 fuera de la semana (2026-11-02), con centavos fraccionarios (3 * 3.33 = 9.99 = 999c)
  const sale3 = createSaleRecord({
    folio: 'V-1003',
    cashier: 'Ana',
    paymentType: 'EFECTIVO',
    date: '2026-11-02',
    timestamp: new Date(2026, 10, 2, 18, 0, 0).toISOString(),
    durationMs: 12_000,
    items: [
      { sku: 'PAN-DOL', name: 'Bolillo pieza', qty: 3, unitPrice: 3.33, unitCost: 1.5, subtotal: 9.99 },
    ],
  });

  // Devolución parcial sobre sale2 (1 Coca de 5 con precio neto efectivo $18.00 = 1800c, costo $13.00 = 1300c)
  const ret1: SaleReturnRecord = {
    id: 'DEV-1002-1',
    saleFolio: 'V-1002',
    saleId: sale2.id,
    timestamp: new Date(2026, 10, 11, 14, 30, 0).toISOString(),
    date: '2026-11-11',
    user: 'Beto',
    authorizedBy: 'Admin',
    reason: 'Cliente cambió de opinión',
    condition: 'VENDIBLE',
    paymentType: 'FIADO',
    customerId: 'CLI-1',
    customerName: 'Doña Mary',
    items: [
      {
        sku: 'COC-600',
        name: 'Coca-Cola 600ml',
        qty: 1,
        unitPrice: 20.0,
        effectiveUnitPrice: 18.0,
        refundAmount: 18.0,
        refundAmountCents: 1800,
      },
    ],
    totalRefund: 18.0,
    totalRefundCents: 1800,
    isFullCancellation: false,
  };
  // Colocamos ret1 también dentro de sale2.returns para verificar deduplicación por id
  sale2.returns = [ret1];

  const weekRange = resolveReportDateRange({ preset: 'SEMANA', referenceDate: '2026-11-12' });
  const salesReport = buildSalesReport([sale1, sale2, sale3], [ret1], weekRange);

  // Totales a mano semana 2026-11-09..2026-11-12:
  // sale1 = 6000 + 4375 = 10375c; sale2 = 9000c (bruto 10000 - desc 1000). Gross = 19375c
  // Devolución = 1800c (no doble contada!). Net = 17575c ($175.75)
  assert.equal(salesReport.ticketCount, 2);
  assert.equal(salesReport.returnEventCount, 1);
  assert.equal(salesReport.grossSalesCents, 19375);
  assert.equal(salesReport.discountsCents, 1000);
  assert.equal(salesReport.returnsCents, 1800);
  assert.equal(salesReport.netSalesCents, 17575);
  // averageTicketCents = Math.round(19375 / 2) = 9688 (redondeo mitad arriba)
  assert.equal(salesReport.averageTicketCents, 9688);

  const cashRow = salesReport.byPaymentType.find((r) => r.paymentType === 'EFECTIVO')!;
  const fiadoRow = salesReport.byPaymentType.find((r) => r.paymentType === 'FIADO')!;
  assert.equal(cashRow.netSalesCents, 10375);
  assert.equal(fiadoRow.grossSalesCents, 9000);
  assert.equal(fiadoRow.returnsCents, 1800);
  assert.equal(fiadoRow.netSalesCents, 7200);
  assert.equal(cashRow.netSalesCents + fiadoRow.netSalesCents, salesReport.netSalesCents);

  // Horas locales: 9h tiene +10375c, 14h tiene +9000c bruto y -1800c dev = +7200c neto
  assert.equal(salesReport.byHour[9].grossSalesCents, 10375);
  assert.equal(salesReport.byHour[14].grossSalesCents, 9000);
  assert.equal(salesReport.byHour[14].returnsCents, 1800);
  assert.equal(salesReport.byHour[14].netSalesCents, 7200);
  assert.equal(salesReport.peakHour, 9);

  // Por producto semana:
  // COC-600: gross 3+5=8 u (6000+9000=15000c), returned 1 u (1800c) -> net 7 u, 13200c
  // QUE-GRA: gross 0.35 u, 4375c -> net 0.35 u, 4375c
  const cocProd = salesReport.byProduct.find((p) => p.sku === 'COC-600')!;
  const queProd = salesReport.byProduct.find((p) => p.sku === 'QUE-GRA')!;
  assert.equal(cocProd.netQty, 7);
  assert.equal(cocProd.netSalesCents, 13200);
  assert.equal(queProd.netQty, 0.35);
  assert.equal(queProd.netSalesCents, 4375);

  // Márgenes calculados a mano en semana:
  // COC-600: rev neto 13200c; costo neto = 7 * 1300 = 9100c -> margen = 4100c (31.06%)
  // QUE-GRA: rev neto 4375c; costo = Math.round(0.35 * 8750) = 3063c -> margen = 1312c (29.99%)
  // Total rev = 17575c; total costo = 12163c; total margen = 5412c (30.79%)
  const marginsReport = buildMarginsReport([sale1, sale2, sale3], [ret1], products, weekRange);
  assert.equal(marginsReport.totalNetRevenueCents, 17575);
  assert.equal(marginsReport.totalNetCostCents, 12163);
  assert.equal(marginsReport.totalMarginCents, 5412);
  assert.equal(marginsReport.overallMarginPct, 30.79);

  const cocMargin = marginsReport.byProduct.find((p) => p.sku === 'COC-600')!;
  const queMargin = marginsReport.byProduct.find((p) => p.sku === 'QUE-GRA')!;
  assert.equal(cocMargin.marginCents, 4100);
  assert.equal(cocMargin.marginPct, 31.06);
  assert.equal(queMargin.netCostCents, 3063);
  assert.equal(queMargin.marginCents, 1312);
  assert.equal(queMargin.marginPct, 29.99);

  const bySaleSum = marginsReport.bySale.reduce((acc, s) => acc + s.marginCents, 0);
  assert.equal(bySaleSum, marginsReport.totalMarginCents);

  // Filtro MES incluye también sale3 (1/3 de $10 aprox: $9.99 ingreso, $4.50 costo -> $5.49 margen)
  const monthRange = resolveReportDateRange({ preset: 'MES', referenceDate: '2026-11-12' });
  const monthSales = buildSalesReport([sale1, sale2, sale3], [ret1], monthRange);
  assert.equal(monthSales.ticketCount, 3);
  assert.equal(monthSales.netSalesCents, 17575 + 999);
});

test('Mermas + Auditoría Stock-Conteo + Créditos Vencidos + Tiempos + Valuación Inventario', () => {
  const products: ReportProductLike[] = [
    { sku: 'A-1', name: 'Aceite 850ml', category: 'Aceites', stock: 10, price: 42.0, weightedAvgCost: 31.5 },
    { sku: 'Q-1', name: 'Queso panela kg', category: 'Lácteos', stock: 2.5, price: 110.0, historicCost: 78.33 },
    { sku: 'C-1', name: 'Refresco 600ml', category: 'Bebidas', stock: 5, price: 18.0, purchaseCost: 11.2 },
  ];

  // Mermas mixtas YYYY-MM-DD y DD/MM/YYYY
  const shrinkRecords: ShrinkRecordLike[] = [
    { id: 'M-1', sku: 'A-1', name: 'Aceite 850ml', qty: 2, unitCost: 31.5, reason: 'Envase Roto en Piso', date: '10/11/2026', reviewed: true },
    { id: 'M-2', sku: 'Q-1', name: 'Queso panela kg', qty: 0.3, unitCost: 78.33, reason: 'Caducidad', date: '2026-11-11', reviewed: false },
    { id: 'M-3', sku: 'C-1', name: 'Refresco 600ml', qty: 5, unitCost: 11.2, reason: 'Caducidad', date: '2026-10-01', reviewed: true }, // fuera de rango
  ];

  const weekRange = resolveReportDateRange({ preset: 'SEMANA', referenceDate: '2026-11-12' });
  const shrinkReport = buildShrinkReport(shrinkRecords, products, weekRange);
  // M-1 = 2 * 3150 = 6300c; M-2 = round(0.3 * 7833) = 2350c -> total = 8650c
  assert.equal(shrinkReport.recordCount, 2);
  assert.equal(shrinkReport.reviewedCount, 1);
  assert.equal(shrinkReport.unreviewedCount, 1);
  assert.equal(shrinkReport.totalLossCents, 8650);
  assert.equal(shrinkReport.byReason.length, 2);
  assert.equal(shrinkReport.byReason[0].reason, 'Envase Roto en Piso');
  assert.equal(shrinkReport.byReason[0].totalLossCents, 6300);

  // Auditoría stock-conteo
  const auditLines: AuditLineLike[] = [
    { sku: 'A-1', name: 'Aceite 850ml', saleUnit: 'Pieza', systemQty: 10, countedQty: 8, diffQty: -2, unitCost: 31.5, status: 'pendiente', date: '2026-11-11' },
    { sku: 'Q-1', name: 'Queso panela kg', saleUnit: 'Kg', systemQty: 2.5, countedQty: 2.4, diffQty: -0.1, unitCost: 78.33, status: 'autorizado', isWithinNaturalTolerance: true, date: '2026-11-11' },
    { sku: 'C-1', name: 'Refresco 600ml', saleUnit: 'Pieza', systemQty: 5, countedQty: 6, diffQty: 1, unitCost: 11.2, status: 'pendiente', date: '2026-11-11' },
  ];
  const auditReport = buildAuditDifferencesReport(auditLines, products, weekRange);
  // Faltante = 6300c, Merma natural = round(0.1*7833)=783c, Sobrante = 1120c -> neto = -6300 - 783 + 1120 = -5963c
  assert.equal(auditReport.totalAuditedSkus, 3);
  assert.equal(auditReport.shortageValueCents, 6300);
  assert.equal(auditReport.naturalToleranceLossCents, 783);
  assert.equal(auditReport.surplusValueCents, 1120);
  assert.equal(auditReport.netVarianceCents, -5963);

  // Créditos vencidos por cliente y antigüedad al 2026-11-12
  const customers: CreditCustomerLike[] = [
    {
      id: 'C1',
      name: 'Juan Pérez',
      phone: '5511111111',
      currentBalance: 350.0,
      dueDate: '2026-11-08', // 4 días (1_7_DIAS)
      debtItems: [
        { id: 'D1', folio: 'F1', date: '2026-10-01', dueDate: '2026-10-05', originalAmount: 200, remainingAmount: 200 }, // 38 días -> MAS_30_DIAS
        { id: 'D2', folio: 'F2', date: '2026-11-01', dueDate: '2026-11-08', originalAmount: 150, remainingAmount: 150 }, // 4 días -> 1_7_DIAS
      ],
    },
    {
      id: 'C2',
      name: 'María López',
      phone: '5522222222',
      currentBalance: 120.5,
      dueDate: '2026-11-01', // 11 días -> 8_15_DIAS
      debtItems: [
        { id: 'D3', folio: 'F3', date: '2026-10-20', dueDate: '2026-11-01', originalAmount: 120.5, remainingAmount: 120.5 },
      ],
    },
    {
      id: 'C3',
      name: 'Pedro al Día',
      phone: '5533333333',
      currentBalance: 100.0,
      dueDate: '2026-11-20', // No vencido todavía
      debtItems: [
        { id: 'D4', folio: 'F4', date: '2026-11-10', dueDate: '2026-11-20', originalAmount: 100, remainingAmount: 100 },
      ],
    },
  ];
  const overdueReport = buildOverdueCreditsReport(customers, '2026-11-12');
  // Cartera total = 35000 + 12050 + 10000 = 57050c; Vencido = 35000 + 12050 = 47050c
  assert.equal(overdueReport.totalPortfolioCents, 57050);
  assert.equal(overdueReport.totalOverdueCents, 47050);
  assert.equal(overdueReport.overdueCustomerCount, 2);
  assert.equal(overdueReport.byCustomer[0].customerId, 'C1');
  assert.equal(overdueReport.byCustomer[0].maxDaysOverdue, 38);
  assert.equal(overdueReport.byCustomer[0].agingBucket, 'MAS_30_DIAS');

  const bucketSum = overdueReport.byAgingBucket.reduce((s, b) => s + b.overdueCents, 0);
  assert.equal(bucketSum, overdueReport.totalOverdueCents);
  assert.equal(overdueReport.byAgingBucket.find((b) => b.bucket === '1_7_DIAS')!.overdueCents, 15000);
  assert.equal(overdueReport.byAgingBucket.find((b) => b.bucket === '8_15_DIAS')!.overdueCents, 12050);
  assert.equal(overdueReport.byAgingBucket.find((b) => b.bucket === 'MAS_30_DIAS')!.overdueCents, 20000);

  // Tiempos de venta: promedio de 20s, 40s y 120s = 60s; mediana = 40s
  const timedSales = [
    createSaleRecord({
      folio: 'V-1',
      cashier: 'Ana',
      paymentType: 'EFECTIVO',
      date: '2026-11-11',
      durationMs: 20_000,
      items: [{ sku: 'A-1', name: 'Aceite 850ml', qty: 1, unitPrice: 42, subtotal: 42 }],
    }),
    createSaleRecord({
      folio: 'V-2',
      cashier: 'Ana',
      paymentType: 'EFECTIVO',
      date: '2026-11-11',
      durationMs: 40_000,
      items: [{ sku: 'A-1', name: 'Aceite 850ml', qty: 1, unitPrice: 42, subtotal: 42 }],
    }),
    createSaleRecord({
      folio: 'V-3',
      cashier: 'Beto',
      paymentType: 'EFECTIVO',
      date: '2026-11-11',
      durationMs: 120_000,
      items: [{ sku: 'A-1', name: 'Aceite 850ml', qty: 1, unitPrice: 42, subtotal: 42 }],
    }),
    createSaleRecord({
      folio: 'V-4',
      cashier: 'Beto',
      paymentType: 'EFECTIVO',
      date: '2026-11-11',
      // Sin cronometraje previo
      items: [{ sku: 'A-1', name: 'Aceite 850ml', qty: 1, unitPrice: 42, subtotal: 42 }],
    }),
  ];
  const timingReport = buildSaleTimingReport(timedSales, weekRange);
  assert.equal(timingReport.totalSalesInRange, 4);
  assert.equal(timingReport.measuredSaleCount, 3);
  assert.equal(timingReport.unmeasuredSaleCount, 1);
  assert.equal(timingReport.averageDurationMs, 60_000);
  assert.equal(timingReport.averageDurationSec, 60);
  assert.equal(timingReport.minDurationMs, 20_000);
  assert.equal(timingReport.maxDurationMs, 120_000);
  assert.equal(timingReport.medianDurationMs, 40_000);
  assert.equal(timingReport.fastSalesCount, 1);
  assert.equal(timingReport.normalSalesCount, 1);
  assert.equal(timingReport.slowSalesCount, 1);

  // Valuación inventario a costo y a precio:
  // A-1: stock Kardex 12 u * costo 3150c = 37800c; precio 4200c = 50400c
  // Q-1: stock prod 2.5 u * costo 7833c = round(2.5 * 7833) = 19583c; precio 11000c = 27500c
  // C-1: stock prod 5 u * costo 1120c = 5600c; precio 1800c = 9000c
  const kardex: KardexEntry[] = [
    {
      id: 'K-1',
      date: '2026-11-11',
      time: '10:00',
      timestamp: '2026-11-11T10:00:00',
      type: 'ENTRADA',
      sku: 'A-1',
      productName: 'Aceite 850ml',
      qty: 12,
      balanceBefore: 10,
      balanceAfter: 12,
      unitCost: 31.5,
      weightedAvgCost: 31.5,
      usuario: 'Admin',
      referencia: 'COMPRA',
      hash: 'abc',
      previousHash: 'GENESIS',
    },
  ];
  const valReport = buildInventoryValuationReport(products, kardex);
  assert.equal(valReport.totalCostCents, 37800 + 19583 + 5600); // 62983c
  assert.equal(valReport.totalRetailCents, 50400 + 27500 + 9000); // 86900c
  assert.equal(valReport.potentialProfitCents, 86900 - 62983); // 23917c
});

test('Bitácora de uso a 30 días, encuesta semanal de satisfacción (1..5) y panel de 8 indicadores', () => {
  let usageLog = recordUsageActivity([], { date: '2026-10-10', user: 'Ana', isSale: true }); // Fuera de ventana 30d respecto a 2026-11-12
  usageLog = recordUsageActivity(usageLog, { date: '2026-10-14', user: 'Ana', isSale: true }); // Día -29 (dentro)
  usageLog = recordUsageActivity(usageLog, { date: '2026-11-12', user: 'Ana', isSale: true });
  usageLog = recordUsageActivity(usageLog, { date: '2026-11-12', user: 'Beto', isSale: false });

  const usageMetric = computeUsage30DaysMetric(usageLog, '2026-11-12');
  assert.equal(usageMetric.windowStartDate, '2026-10-14');
  assert.equal(usageMetric.activeDays, 2);
  assert.equal(usageMetric.totalActions30d, 3);
  assert.equal(usageMetric.totalSales30d, 2);
  assert.equal(usageMetric.adherencePct, 6.67);

  // Encuesta semanal 1..5
  assert.equal(isSatisfactionSurveyDue([], '2026-11-12').due, true);
  const badRating = recordSatisfactionSurvey([], { rating: 6, respondent: 'Admin', date: '2026-11-12' });
  assert.equal(badRating.ok, false);
  const decimalRating = recordSatisfactionSurvey([], { rating: 4.5, respondent: 'Admin', date: '2026-11-12' });
  assert.equal(decimalRating.ok, false);

  const firstSurvey = recordSatisfactionSurvey([], {
    rating: 4,
    respondent: 'Encargado',
    shiftId: 'TURNO-1',
    date: '2026-11-05',
  });
  assert.equal(firstSurvey.ok, true);
  // Día 6 después (2026-11-11): aún NO toca
  assert.equal(isSatisfactionSurveyDue(firstSurvey.surveys, '2026-11-11').due, false);
  const tooSoon = recordSatisfactionSurvey(firstSurvey.surveys, {
    rating: 5,
    respondent: 'Encargado',
    date: '2026-11-11',
  });
  assert.equal(tooSoon.ok, false);

  // Día 7 exacto (2026-11-12): ya toca
  assert.equal(isSatisfactionSurveyDue(firstSurvey.surveys, '2026-11-12').due, true);
  const secondSurvey = recordSatisfactionSurvey(firstSurvey.surveys, {
    rating: 5,
    respondent: 'Encargado',
    date: '2026-11-12',
  });
  assert.equal(secondSurvey.ok, true);

  const satMetric = computeSatisfactionMetric(secondSurvey.surveys, '2026-11-12');
  assert.equal(satMetric.responseCount, 2);
  assert.equal(satMetric.averageRating, 4.5);
  assert.equal(satMetric.latestRating, 5);
  assert.equal(satMetric.isDueNow, false);
  assert.equal(satMetric.nextDueDate, '2026-11-19');

  // Panel completo con los 8 indicadores en el orden exacto de la Imagen 4
  const bundle = buildReportsBundle({
    filter: { preset: 'HOY', referenceDate: '2026-11-12' },
    sales: [],
    returns: [],
    shrinkRecords: [],
    customers: [],
    auditLines: [],
    products: [],
    usageActivityLog: usageLog,
    satisfactionSurveys: secondSurvey.surveys,
  });
  assert.equal(bundle.indicators.length, 8);
  assert.deepEqual(
    bundle.indicators.map((i) => i.id),
    [
      'VENTAS',
      'MARGENES',
      'MERMAS',
      'CREDITOS_VENCIDOS',
      'DIFERENCIA_CONTEO',
      'TIEMPO_POR_VENTA',
      'USO_30_DIAS',
      'SATISFACCION',
    ]
  );
  assert.equal(bundle.indicators[6].valueFormatted, '2 / 30 días');
  assert.equal(bundle.indicators[7].valueFormatted, '5 / 5');
});

test('CSV UTF-8 con BOM, escape RFC-4180, protección anti-inyección y exportación de todos los reportes', () => {
  const rawCsv = serializeCsv(
    ['Producto', 'Importe', 'Fórmula'],
    [
      ['Queso, "Fresco"\nLácteo', -15.5, '=SUM(A1:A2)'],
      ['Refresco +Plus', 20, '+cmd'],
    ]
  );
  assert.ok(rawCsv.startsWith(UTF8_BOM), 'Debe iniciar con BOM UTF-8 (\\uFEFF)');
  assert.ok(rawCsv.includes('"Queso, ""Fresco""\nLácteo",-15.5,\'=SUM(A1:A2)'));
  assert.ok(rawCsv.includes('\'+cmd'));

  const range = resolveReportDateRange({ preset: 'HOY', referenceDate: '2026-11-12' });
  const bundle = buildReportsBundle({
    filter: { preset: 'HOY', referenceDate: '2026-11-12' },
    sales: [
      createSaleRecord({
        folio: 'V-2001',
        cashier: 'Ana',
        paymentType: 'EFECTIVO',
        date: '2026-11-12',
        durationMs: 15_000,
        items: [{ sku: 'SKU-1', name: 'Frijol 1kg', qty: 2, unitPrice: 35, unitCost: 24, subtotal: 70 }],
      }),
    ],
    returns: [],
    shrinkRecords: [{ id: 'S-1', sku: 'SKU-1', name: 'Frijol 1kg', qty: 1, unitCost: 24, reason: 'Rotura', date: '2026-11-12' }],
    customers: [{ id: 'C-1', name: 'Carlos', currentBalance: 50, dueDate: '2026-11-01', overdueBalance: 50 }],
    auditLines: [{ sku: 'SKU-1', name: 'Frijol 1kg', systemQty: 10, countedQty: 9, diffQty: -1, unitCost: 24, date: '2026-11-12' }],
    products: [{ sku: 'SKU-1', name: 'Frijol 1kg', category: 'Granos', stock: 10, price: 35, weightedAvgCost: 24 }],
  });

  const csvs = [
    exportSalesReportCsv(bundle.sales, 'Mi Tienda'),
    exportMarginsReportCsv(bundle.margins),
    exportShrinkReportCsv(bundle.shrink),
    exportOverdueCreditsReportCsv(bundle.overdueCredits),
    exportAuditDifferencesReportCsv(bundle.auditDifferences),
    exportSaleTimingReportCsv(bundle.saleTiming),
    exportInventoryValuationReportCsv(bundle.inventoryValuation),
    exportIndicatorsPanelCsv(bundle.indicators, bundle.range),
  ];

  for (const csv of csvs) {
    assert.ok(csv.startsWith(UTF8_BOM));
    assert.ok(csv.length > 20);
  }
  assert.ok(csvs[0].includes('70.00'));
  assert.ok(csvs[1].includes('22.00')); // Margen 70 - 48 = 22.00
  assert.ok(csvs[2].includes('24.00'));
  assert.ok(csvs[3].includes('50.00'));
  assert.ok(csvs[4].includes('-24.00'));
  assert.ok(csvs[5].includes('15000'));
  assert.ok(csvs[6].includes('350.00'));
  assert.ok(csvs[7].includes('Tiempo por venta'));

  // Validación reforzada contra bypass de inyección CSV con espacios iniciales
  const csvSpaced = serializeCsv(
    ['Nombre', 'FormulaSpaced', 'FormulaMinus', 'SafeMinus'],
    [
      ['Item1', '   =SUM(A1:A5)', '   -2+3', '   -15.50'],
      ['Item2', '   @IMPORT', '   +1234', -99.9],
    ]
  );
  assert.ok(csvSpaced.includes('\'   =SUM(A1:A5)'));
  assert.ok(csvSpaced.includes('\'   -2+3'));
  assert.ok(csvSpaced.includes('\'   @IMPORT'));
  assert.ok(csvSpaced.includes('\'   +1234'));
  assert.ok(csvSpaced.includes('"   -15.50"'));
  assert.ok(csvSpaced.includes('-99.9'));
});

test('Márgenes: Devolución con múltiples partidas rebaja individualmente el costo de cada producto', () => {
  const products: ReportProductLike[] = [
    { sku: 'P1', name: 'Prod 1', stock: 10, price: 50.0, weightedAvgCost: 30.0 },
    { sku: 'P2', name: 'Prod 2', stock: 10, price: 80.0, weightedAvgCost: 50.0 },
  ];
  const sale = createSaleRecord({
    folio: 'V-M1',
    cashier: 'Ana',
    paymentType: 'EFECTIVO',
    date: '2026-11-12',
    items: [
      { sku: 'P1', name: 'Prod 1', qty: 2, unitPrice: 50.0, unitCost: 30.0, subtotal: 100.0 },
      { sku: 'P2', name: 'Prod 2', qty: 2, unitPrice: 80.0, unitCost: 50.0, subtotal: 160.0 },
    ],
  });
  // Devolución de 1 unidad de P1 ($50 rev, $30 cost) y 1 unidad de P2 ($80 rev, $50 cost)
  const ret: SaleReturnRecord = {
    id: 'DEV-M1',
    saleFolio: 'V-M1',
    saleId: sale.id,
    timestamp: '2026-11-12T12:00:00Z',
    date: '2026-11-12',
    user: 'Ana',
    authorizedBy: 'Admin',
    reason: 'Defecto',
    paymentType: 'EFECTIVO',
    items: [
      { sku: 'P1', name: 'Prod 1', qty: 1, unitPrice: 50.0, refundAmount: 50.0, refundAmountCents: 5000 },
      { sku: 'P2', name: 'Prod 2', qty: 1, unitPrice: 80.0, refundAmount: 80.0, refundAmountCents: 8000 },
    ],
    totalRefund: 130.0,
    totalRefundCents: 13000,
  };
  const range = resolveReportDateRange({ preset: 'HOY', referenceDate: '2026-11-12' });
  const rep = buildMarginsReport([sale], [ret], products, range);
  const p1 = rep.byProduct.find((p) => p.sku === 'P1')!;
  const p2 = rep.byProduct.find((p) => p.sku === 'P2')!;
  assert.equal(p1.netQty, 1);
  assert.equal(p1.netRevenueCents, 5000);
  assert.equal(p1.netCostCents, 3000);
  assert.equal(p1.marginCents, 2000);

  assert.equal(p2.netQty, 1);
  assert.equal(p2.netRevenueCents, 8000);
  assert.equal(p2.netCostCents, 5000);
  assert.equal(p2.marginCents, 3000);

  assert.equal(rep.totalNetRevenueCents, 13000);
  assert.equal(rep.totalNetCostCents, 8000);
  assert.equal(rep.totalMarginCents, 5000);
});

test('Créditos Vencidos: Tope estricto de deuda vencida contra el saldo total del cliente para evitar morosidad > 100%', () => {
  const customer: CreditCustomerLike = {
    id: 'CLI-EXCESS',
    name: 'Don Carlos',
    currentBalance: 150.0,
    creditLimit: 500.0,
    dueDate: '2026-11-01',
    debtItems: [
      { id: 'D-1', folio: 'F-1', date: '2026-10-01', dueDate: '2026-10-15', remainingAmount: 100.0 }, // 10000c
      { id: 'D-2', folio: 'F-2', date: '2026-10-10', dueDate: '2026-10-25', remainingAmount: 100.0 }, // 10000c
    ],
  };
  const rep = buildOverdueCreditsReport([customer], '2026-11-12');
  assert.equal(rep.totalPortfolioCents, 15000);
  assert.equal(rep.totalOverdueCents, 15000); // Topado al saldo total del cliente
  assert.equal(rep.overdueRatePct, 100);
  assert.equal(rep.byCustomer.length, 1);
  assert.equal(rep.byCustomer[0].overdueCents, 15000);
  assert.equal(rep.byCustomer[0].totalBalanceCents, 15000);
});

test('Auditoría y Tiempos: Robustez ante cantidades indefinidas/nulas en auditoría y cajero vacío en tiempos', () => {
  const products: ReportProductLike[] = [
    { sku: 'AUD-SKU', name: 'Leche 1L', stock: 10, price: 28.0, weightedAvgCost: 20.0 },
  ];
  const auditLines: AuditLineLike[] = [
    {
      sku: 'AUD-SKU',
      name: 'Leche 1L',
      saleUnit: 'Pieza',
      systemQty: undefined as any,
      countedQty: 7,
      unitCost: 20.0,
      date: '2026-11-12',
    },
  ];
  const range = resolveReportDateRange({ preset: 'HOY', referenceDate: '2026-11-12' });
  const audRep = buildAuditDifferencesReport(auditLines, products, range);
  assert.equal(audRep.totalAuditedSkus, 1);
  assert.equal(audRep.items[0].systemQty, 0);
  assert.equal(audRep.items[0].countedQty, 7);
  assert.equal(audRep.items[0].diffQty, 7);
  assert.equal(audRep.items[0].diffValueCents, 14000);
  assert.equal(audRep.surplusValueCents, 14000);

  const sale = createSaleRecord({
    folio: 'V-NOCASHIER',
    cashier: '   ',
    paymentType: 'EFECTIVO',
    date: '2026-11-12',
    durationMs: 25_000,
    items: [{ sku: 'AUD-SKU', name: 'Leche 1L', qty: 1, unitPrice: 28.0, subtotal: 28.0 }],
  });
  const timeRep = buildSaleTimingReport([sale], range);
  assert.equal(timeRep.measuredSaleCount, 1);
  assert.equal(timeRep.items[0].cashier, 'Cajero');
  assert.equal(timeRep.byCashier[0].cashier, 'Cajero');
});
