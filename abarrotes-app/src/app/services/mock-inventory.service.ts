import { Injectable, computed, signal } from '@angular/core';
import {
  AbcResult,
  ClassificationDiscrepancy,
  GuidedAnswer,
  calculateAbcRankings,
  calculateVU,
  confirmClassificationChanges,
  proposeNewClassification,
} from './abc-classifier';

// =====================================================================
//  MODELOS
// =====================================================================

export type PurchaseUnit = 'Caja' | 'Costal' | 'Paquete' | 'Charola' | 'Pieza' | 'Kg' | 'Lata';
export type SaleUnit = 'Pieza' | 'Kg' | 'Lata' | 'Paquete';
export type AbcClass = 'A' | 'B' | 'C';

export interface Product {
  sku: string;
  barcode: string;
  name: string;
  category: string;
  emoji: string;
  purchaseUnit: PurchaseUnit;
  /** Cuántas unidades de venta trae una unidad de compra (ej. 1 para pieza/kg directo o 12 para caja c/12). */
  unitsPerPurchase: number;
  saleUnit: SaleUnit;
  /** Costo histórico por unidad de venta (MXN). */
  historicCost: number;
  /** Costo de compra unitario usado para el Valor de Utilización (VU) de Pareto. */
  purchaseCost?: number;
  /** Costo más reciente por unidad de venta (MXN). */
  newCost: number;
  /** Costo Promedio Ponderado contable (MXN). */
  weightedAvgCost: number;
  /** Último Costo de Reposición para blindaje contra inflación (MXN). */
  lastPurchaseCost: number;
  /** Precio de venta actual al público por unidad de venta (MXN). */
  salePrice: number;
  /** Margen mínimo deseado (%) sobre precio de venta. */
  targetMargin: number;
  /** Unidades mensuales vendidas estimadas (30 días) para cálculo VU = (Precio - Costo) * Unidades. */
  monthlySalesUnits?: number;
  /** Fecha de caducidad del lote en anaquel (ISO yyyy-mm-dd). */
  expiry: string;
  /** Fecha FEFO (First Expired, First Out) del lote más próximo a vencer. */
  fefoExpiryDate: string;
  /** Indica si el proveedor acepta Cambio Físico mano a mano sin costo. */
  acceptsPhysicalExchange: boolean;
  /** Hora o día de próxima visita del repartidor para cambio físico. */
  nextVisitInfo?: string;
  stock: number;
  minStock: number;
  /** Clasificación ABC (Pareto): A = 80% ventas, B = rotación media, C = baja rotación / dinero dormido. */
  abcClass: AbcClass;
  /** Venta promedio diaria en unidades o kg. */
  dailySalesRate: number;
  /** Días que tarda en surtir el proveedor (Lead Time). */
  supplierLeadTimeDays: number;
  /** Stock de seguridad para cubrir picos de demanda. */
  safetyStock: number;
  /** Punto de Reorden: (dailySalesRate * supplierLeadTimeDays) + safetyStock */
  rop: number;
  /** true para productos a granel o sin código de fábrica (Frijol, Queso, Huevo, Azúcar, Pan). */
  isBulk: boolean;
  /** Producto gancho (si se acaba, el cliente se va a otra tienda). */
  isTrafficDriver?: boolean;
  supplier: string;
}

export type CreditCustomerStatus = 'AL_CORRIENTE' | 'LIMITE_ALCANZADO' | 'VENCIDO';

export interface CreditCustomer {
  id: string;
  name: string;
  alias?: string;
  phone: string;
  creditLimit: number;
  currentBalance: number;
  dueDate: string;
  status: CreditCustomerStatus;
  notes?: string;
}

export interface InternalConsumptionRecord {
  id: string;
  timestamp: Date;
  responsible: string;
  items: {
    productId: string;
    name: string;
    quantity: number;
    unitCost: number;
    subtotalCost: number;
  }[];
  totalCost: number;
}

export interface CashShiftSummary {
  openingCash: number;
  cashSalesTotal: number;
  creditPaymentsReceived: number;
  creditSalesTotal: number;
  internalConsumptionTotalCost: number;
  shrinkTotalCost: number;
}

export interface CashRegisterSummary {
  /** Fondo fijo inicial de caja para dar cambio. */
  openingFloat: number;
  /** Ventas cobradas en efectivo hoy. */
  cashSalesTotal: number;
  /** Ventas anotadas como "fiado" hoy (no entran en billetes al cajón). */
  creditSalesTotal: number;
  /** Abonos en efectivo recibidos hoy de deudas anteriores (sí entran al cajón). */
  creditPaymentsReceived: number;
}

export interface PosSaleItem {
  sku: string;
  barcode: string;
  name: string;
  emoji: string;
  saleUnit: SaleUnit;
  isBulk: boolean;
  /** Cantidad en unidades o kilogramos (ej. 0.263 kg). */
  qty: number;
  unitPrice: number;
  subtotal: number;
}

export type CartItem = PosSaleItem;

export interface SaleResult {
  ok: boolean;
  message: string;
  total: number;
  change: number;
}

export interface CreditResult {
  ok: boolean;
  message: string;
  total: number;
  availableCredit?: number;
}

export interface KardexEntry {
  id: string;
  timestamp: string;
  type: 'VENTA_EFECTIVO' | 'VENTA_FIADO' | 'ABONO_FIADO' | 'ENTRADA_COMPRA' | 'AJUSTE_AUDITORIA' | 'BAJA_MERMA' | 'CONSUMO_INTERNO';
  description: string;
  amount: number;
}

export type AlertKind = 'cambio-fisico' | 'por-agotarse' | 'margen' | 'auditoria';

export interface MorningAlert {
  id: string;
  kind: AlertKind;
  icon: string;
  title: string;
  detail: string;
  actionLabel: string;
  route: string;
}

export interface ReceptionLine {
  sku: string;
  barcode?: string;
  name: string;
  emoji: string;
  qtyPurchase: number;
  purchaseUnit: PurchaseUnit;
  unitsPerPurchase: number;
  saleUnit: SaleUnit;
  /** Importe total de la línea según la nota. */
  lineTotal: number;
  historicCost: number;
  newCost: number;
  salePrice: number;
  targetMargin: number;
  /** true cuando el tendero ya aceptó el precio sugerido. */
  resolved: boolean;
}

export interface SupplierNote {
  folio: string;
  supplier: string;
  date: string;
  driver: string;
  route: string;
  receivedFrom: string;
  lines: ReceptionLine[];
}

export type AuditStatus = 'pendiente' | 'autorizado' | 'reconteo';

export interface AuditLine {
  sku: string;
  name: string;
  emoji: string;
  location: string;
  saleUnit: SaleUnit;
  systemQty: number;
  countedQty: number;
  unitCost: number;
  status: AuditStatus;
}

export type ShrinkReason = 'Envase Roto en Piso' | 'Caducado sin devolución';

export interface ShrinkRecord {
  id: string;
  date: string;
  time: string;
  sku: string;
  name: string;
  emoji: string;
  qty: number;
  saleUnit: SaleUnit;
  reason: ShrinkReason;
  unitCost: number;
  registeredBy: string;
  hasPhoto: boolean;
  reviewed: boolean;
}

// =====================================================================
//  UTILIDADES DE MARGEN, ROP Y PARSER OCR
// =====================================================================

/** Margen (%) sobre precio de venta. */
export function marginPct(cost: number, price: number): number {
  if (price <= 0) return 0;
  return ((price - cost) / price) * 100;
}

/** Precio sugerido redondeado hacia arriba al peso entero para cumplir el margen objetivo. */
export function suggestedPrice(cost: number, targetMargin: number): number {
  return Math.ceil(cost / (1 - targetMargin / 100));
}

/** Calcula el Punto de Reorden (ROP): (Venta Diaria × Días Proveedor) + Stock de Seguridad */
export function calculateROP(dailySalesRate: number, supplierLeadTimeDays: number, safetyStock: number): number {
  return +(dailySalesRate * supplierLeadTimeDays + safetyStock).toFixed(1);
}

function normalizeText(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Limpia errores comunes de OCR en un token numérico:
 * - Cambia 'O' / 'o' por '0'
 * - Cambia 'l' / 'I' / '|' por '1'
 * - Quita símbolos de moneda ('$', 'S' inicial)
 */
export function cleanOcrNumber(token: string): number {
  if (!token) return NaN;
  let cleaned = String(token).trim();
  cleaned = cleaned.replace(/^[Ss$]+/, '');
  cleaned = cleaned
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/,/g, '.');
  cleaned = cleaned.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length > 2) {
    cleaned = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  }
  return parseFloat(cleaned);
}

/**
 * Busca coincidencias de descripción contra el catálogo de productos.
 */
export function matchProductFromCatalog(rawDesc: string, catalog: Product[]): Product | null {
  const norm = normalizeText(rawDesc);
  for (const p of catalog) {
    if (norm.includes(p.barcode) || norm.includes(p.sku.toLowerCase())) {
      return p;
    }
  }

  let best: Product | null = null;
  let bestScore = 0;

  for (const p of catalog) {
    const tokens = normalizeText(p.name)
      .replace(/[()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !['en', 'de', 'la', 'el'].includes(t));

    let score = 0;
    for (const tk of tokens) {
      if (norm.includes(tk)) score += tk.length >= 4 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 2 ? best : null;
}

/**
 * Analiza texto crudo proveniente de OCR o pegado de prueba con el patrón:
 * [Cantidad] [Descripción] [Costo Unitario o Total]
 */
export function parseTicketOCR(rawText: string, catalog: Product[]): ReceptionLine[] {
  if (!rawText) return [];
  const rawLines = rawText.split(/\r?\n/);
  const result: ReceptionLine[] = [];

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line || line.length < 5) continue;

    const upper = line.toUpperCase();
    if (
      upper.startsWith('TOTAL') ||
      upper.startsWith('SUBTOTAL') ||
      upper.startsWith('FOLIO') ||
      upper.startsWith('DISTRIBUIDORA') ||
      upper.startsWith('NOTA ') ||
      upper.startsWith('FECHA') ||
      upper.startsWith('CLIENTE')
    ) {
      continue;
    }

    const match = line.match(
      /^([0-9OoIl|]+(?:[.,][0-9OoIl|]+)?)\s+(?:(?:PZ|PZA|PZAS|CJ|CAJA|CS|KG|LT|LATA|LATAS)\b\s*)?(.+?)\s+([Ss$]?\s*[0-9OoIl|]+(?:[.,][0-9OoIl|]{1,2})?)\s*$/i,
    );
    if (!match) continue;

    const qty = cleanOcrNumber(match[1]);
    const desc = match[2].trim();
    const rawAmount = cleanOcrNumber(match[3]);

    if (isNaN(qty) || qty <= 0 || isNaN(rawAmount) || rawAmount <= 0) continue;

    const product = matchProductFromCatalog(desc, catalog);
    if (!product) continue;

    let unitNewCost = rawAmount;
    let lineTotal = +(qty * rawAmount).toFixed(2);

    if (qty > 1 && rawAmount > product.historicCost * 2.2) {
      const candidateUnit = rawAmount / qty;
      if (Math.abs(candidateUnit - product.historicCost) < Math.abs(rawAmount - product.historicCost)) {
        unitNewCost = +candidateUnit.toFixed(2);
        lineTotal = +rawAmount.toFixed(2);
      }
    }

    result.push({
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      emoji: product.emoji,
      qtyPurchase: qty,
      purchaseUnit: product.purchaseUnit,
      unitsPerPurchase: 1,
      saleUnit: product.saleUnit,
      lineTotal,
      historicCost: product.historicCost,
      newCost: +unitNewCost.toFixed(2),
      salePrice: product.salePrice,
      targetMargin: product.targetMargin,
      resolved: false,
    });
  }

  return result;
}

// =====================================================================
//  DATOS SIMULADOS (Abarrotes Doña Lupe · León, Gto.)
//  Incluye los 5 productos base con sus códigos EAN-13 exactos y estrategias ABC / ROP / FEFO
// =====================================================================

interface ProductSeed extends Omit<Product, 'rop'> {}

const PRODUCT_SEEDS: ProductSeed[] = [
  // --- 5 PRODUCTOS BASE DEL LABORATORIO EAN-13 / OCR ---
  {
    sku: 'LAC-LAL-1L',
    barcode: '7501020515350',
    name: 'Leche Lala Entera 1L',
    category: 'Lácteos',
    emoji: '🥛',
    purchaseUnit: 'Pieza',
    unitsPerPurchase: 1,
    saleUnit: 'Pieza',
    historicCost: 21.0,
    purchaseCost: 21.0,
    newCost: 21.0,
    weightedAvgCost: 20.8,
    lastPurchaseCost: 21.0,
    salePrice: 26.0,
    targetMargin: 20,
    monthlySalesUnits: 420,
    expiry: '2026-10-24',
    fefoExpiryDate: '2026-10-24',
    acceptsPhysicalExchange: true,
    nextVisitInfo: 'Mañana 8:00 a.m. (Camión Lala)',
    stock: 20,
    minStock: 24,
    abcClass: 'A',
    dailySalesRate: 14,
    supplierLeadTimeDays: 1,
    safetyStock: 10,
    isBulk: false,
    supplier: 'Grupo Lala',
  },
  {
    sku: 'ACE-NUT-850',
    barcode: '7501039121122',
    name: 'Aceite Nutrioli 850ml',
    category: 'Aceites',
    emoji: '🫒',
    purchaseUnit: 'Pieza',
    unitsPerPurchase: 1,
    saleUnit: 'Pieza',
    historicCost: 34.0,
    purchaseCost: 39.0,
    newCost: 39.0,
    weightedAvgCost: 34.0,
    lastPurchaseCost: 39.0,
    salePrice: 42.0,
    targetMargin: 18,
    monthlySalesUnits: 150,
    expiry: '2027-06-30',
    fefoExpiryDate: '2027-06-30',
    acceptsPhysicalExchange: false,
    stock: 18,
    minStock: 23,
    abcClass: 'B',
    dailySalesRate: 5,
    supplierLeadTimeDays: 3,
    safetyStock: 8,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'ATU-DOL-140',
    barcode: '7501045403014',
    name: 'Atún Dolores en Agua 140g',
    category: 'Enlatados',
    emoji: '🐟',
    purchaseUnit: 'Lata',
    unitsPerPurchase: 1,
    saleUnit: 'Lata',
    historicCost: 16.5,
    purchaseCost: 16.5,
    newCost: 16.5,
    weightedAvgCost: 16.2,
    lastPurchaseCost: 16.5,
    salePrice: 21.0,
    targetMargin: 20,
    monthlySalesUnits: 180,
    expiry: '2028-03-15',
    fefoExpiryDate: '2028-03-15',
    acceptsPhysicalExchange: false,
    stock: 40,
    minStock: 24,
    abcClass: 'B',
    dailySalesRate: 6,
    supplierLeadTimeDays: 3,
    safetyStock: 6,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'FRI-NEG-50K',
    barcode: '2000001000014',
    name: 'Frijol Negro Granel (1 kg)',
    category: 'Granos',
    emoji: '🫘',
    purchaseUnit: 'Kg',
    unitsPerPurchase: 1,
    saleUnit: 'Kg',
    historicCost: 28.0,
    purchaseCost: 32.0,
    newCost: 32.0,
    weightedAvgCost: 28.0,
    lastPurchaseCost: 32.0,
    salePrice: 36.0,
    targetMargin: 22,
    monthlySalesUnits: 135,
    expiry: '2027-04-01',
    fefoExpiryDate: '2027-04-01',
    acceptsPhysicalExchange: false,
    stock: 16.5,
    minStock: 20,
    abcClass: 'B',
    dailySalesRate: 4.5,
    supplierLeadTimeDays: 3,
    safetyStock: 6.5,
    isBulk: true,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'QUE-FRE-1K',
    barcode: '2000002000013',
    name: 'Queso Fresco Local (1 kg)',
    category: 'Lácteos',
    emoji: '🧀',
    purchaseUnit: 'Kg',
    unitsPerPurchase: 1,
    saleUnit: 'Kg',
    historicCost: 75.0,
    purchaseCost: 75.0,
    newCost: 75.0,
    weightedAvgCost: 74.0,
    lastPurchaseCost: 75.0,
    salePrice: 95.0,
    targetMargin: 20,
    monthlySalesUnits: 75,
    expiry: '2026-10-24',
    fefoExpiryDate: '2026-10-24',
    acceptsPhysicalExchange: true,
    nextVisitInfo: 'Jueves 9:30 a.m. (Lácteos San Juan)',
    stock: 6.5,
    minStock: 5,
    abcClass: 'A',
    dailySalesRate: 2.5,
    supplierLeadTimeDays: 2,
    safetyStock: 2,
    isBulk: true,
    supplier: 'Lácteos San Juan',
  },
  // --- PRODUCTOS ADICIONALES CON CLASIFICACIÓN ABC, ROP Y GRANEL ---
  {
    sku: 'HUE-BAC-18',
    barcode: '2000003000012',
    name: 'Huevo Blanco Granel (1 kg)',
    category: 'Huevo',
    emoji: '🥚',
    purchaseUnit: 'Kg',
    unitsPerPurchase: 1,
    saleUnit: 'Kg',
    historicCost: 36.0,
    purchaseCost: 36.0,
    newCost: 36.0,
    weightedAvgCost: 35.5,
    lastPurchaseCost: 36.0,
    salePrice: 46.0,
    targetMargin: 20,
    monthlySalesUnits: 240,
    expiry: '2026-11-05',
    fefoExpiryDate: '2026-11-05',
    acceptsPhysicalExchange: false,
    stock: 9,
    minStock: 18,
    abcClass: 'A',
    dailySalesRate: 8,
    supplierLeadTimeDays: 2,
    safetyStock: 5,
    isBulk: true,
    supplier: 'Bachoco',
  },
  {
    sku: 'AZU-ZUL-1K',
    barcode: '2000004000011',
    name: 'Azúcar Estándar Granel (1 kg)',
    category: 'Endulzantes',
    emoji: '🧂',
    purchaseUnit: 'Kg',
    unitsPerPurchase: 1,
    saleUnit: 'Kg',
    historicCost: 24.0,
    purchaseCost: 24.0,
    newCost: 24.0,
    weightedAvgCost: 23.8,
    lastPurchaseCost: 24.0,
    salePrice: 31.0,
    targetMargin: 18,
    monthlySalesUnits: 120,
    expiry: '2028-01-01',
    fefoExpiryDate: '2028-01-01',
    acceptsPhysicalExchange: false,
    stock: 28,
    minStock: 15,
    abcClass: 'B',
    dailySalesRate: 4,
    supplierLeadTimeDays: 3,
    safetyStock: 5,
    isBulk: true,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'PAN-BOL-PZ',
    barcode: '2000005000010',
    name: 'Bolillo Caliente de Panadería',
    category: 'Panadería',
    emoji: '🥖',
    purchaseUnit: 'Pieza',
    unitsPerPurchase: 1,
    saleUnit: 'Pieza',
    historicCost: 1.8,
    purchaseCost: 1.8,
    newCost: 1.8,
    weightedAvgCost: 1.8,
    lastPurchaseCost: 1.8,
    salePrice: 3.0,
    targetMargin: 35,
    monthlySalesUnits: 1050,
    expiry: '2026-10-23',
    fefoExpiryDate: '2026-10-23',
    acceptsPhysicalExchange: false,
    stock: 45,
    minStock: 20,
    abcClass: 'A',
    dailySalesRate: 35,
    supplierLeadTimeDays: 1,
    safetyStock: 10,
    isBulk: true,
    supplier: 'Panadería El Trigo',
  },
  {
    sku: 'PAN-BIM-680',
    barcode: '7441029502004',
    name: 'Pan Blanco Bimbo Grande 680g',
    category: 'Panadería',
    emoji: '🍞',
    purchaseUnit: 'Charola',
    unitsPerPurchase: 8,
    saleUnit: 'Pieza',
    historicCost: 41.0,
    purchaseCost: 41.0,
    newCost: 41.0,
    weightedAvgCost: 41.0,
    lastPurchaseCost: 41.0,
    salePrice: 50.0,
    targetMargin: 16,
    monthlySalesUnits: 90,
    expiry: '2026-10-23',
    fefoExpiryDate: '2026-10-23',
    acceptsPhysicalExchange: true,
    nextVisitInfo: 'Hoy 4:00 p.m. (Repartidor Bimbo)',
    stock: 7,
    minStock: 6,
    abcClass: 'B',
    dailySalesRate: 3,
    supplierLeadTimeDays: 2,
    safetyStock: 2,
    isBulk: false,
    supplier: 'Grupo Bimbo',
  },
  {
    sku: 'YOG-YOP-1K',
    barcode: '7501032394820',
    name: 'Yoghurt Yoplait Fresa 1kg',
    category: 'Lácteos',
    emoji: '🍓',
    purchaseUnit: 'Caja',
    unitsPerPurchase: 6,
    saleUnit: 'Pieza',
    historicCost: 41.3,
    purchaseCost: 41.3,
    newCost: 41.3,
    weightedAvgCost: 41.0,
    lastPurchaseCost: 41.3,
    salePrice: 52.0,
    targetMargin: 18,
    monthlySalesUnits: 60,
    expiry: '2026-10-25',
    fefoExpiryDate: '2026-10-25',
    acceptsPhysicalExchange: true,
    nextVisitInfo: 'Viernes 11:00 a.m. (Sigma Alimentos)',
    stock: 9,
    minStock: 6,
    abcClass: 'B',
    dailySalesRate: 2,
    supplierLeadTimeDays: 2,
    safetyStock: 2,
    isBulk: false,
    supplier: 'Sigma Alimentos',
  },
  {
    sku: 'REF-COC-600',
    barcode: '7501055300075',
    name: 'Coca-Cola Original 600ml',
    category: 'Bebidas',
    emoji: '🥤',
    purchaseUnit: 'Paquete',
    unitsPerPurchase: 24,
    saleUnit: 'Pieza',
    historicCost: 14.1,
    purchaseCost: 14.1,
    newCost: 14.1,
    weightedAvgCost: 14.1,
    lastPurchaseCost: 14.1,
    salePrice: 19.0,
    targetMargin: 22,
    monthlySalesUnits: 540,
    expiry: '2027-01-25',
    fefoExpiryDate: '2027-01-25',
    acceptsPhysicalExchange: true,
    nextVisitInfo: 'Lunes 10:00 a.m. (Arca Continental)',
    stock: 14,
    minStock: 36,
    abcClass: 'A',
    dailySalesRate: 18,
    supplierLeadTimeDays: 2,
    safetyStock: 12,
    isBulk: false,
    supplier: 'Arca Continental',
  },
  {
    sku: 'ARR-SOS-900',
    barcode: '7501052410012',
    name: 'Arroz SOS Súper Extra 900g',
    category: 'Granos',
    emoji: '🍚',
    purchaseUnit: 'Caja',
    unitsPerPurchase: 20,
    saleUnit: 'Pieza',
    historicCost: 27.6,
    purchaseCost: 27.6,
    newCost: 27.6,
    weightedAvgCost: 27.2,
    lastPurchaseCost: 27.6,
    salePrice: 34.0,
    targetMargin: 15,
    monthlySalesUnits: 75,
    expiry: '2027-08-20',
    fefoExpiryDate: '2027-08-20',
    acceptsPhysicalExchange: false,
    stock: 16,
    minStock: 10,
    abcClass: 'B',
    dailySalesRate: 2.5,
    supplierLeadTimeDays: 3,
    safetyStock: 4,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'PAS-MOD-200',
    barcode: '7501018310103',
    name: 'Pasta La Moderna Fideo 200g',
    category: 'Pastas',
    emoji: '🍝',
    purchaseUnit: 'Caja',
    unitsPerPurchase: 40,
    saleUnit: 'Pieza',
    historicCost: 9.9,
    purchaseCost: 9.9,
    newCost: 9.9,
    weightedAvgCost: 9.8,
    lastPurchaseCost: 9.9,
    salePrice: 13.0,
    targetMargin: 20,
    monthlySalesUnits: 120,
    expiry: '2027-12-10',
    fefoExpiryDate: '2027-12-10',
    acceptsPhysicalExchange: false,
    stock: 35,
    minStock: 20,
    abcClass: 'C',
    dailySalesRate: 4,
    supplierLeadTimeDays: 3,
    safetyStock: 6,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'CHI-LAC-220',
    barcode: '7501017004200',
    name: 'Chiles Jalapeños La Costeña 220g',
    category: 'Enlatados',
    emoji: '🌶️',
    purchaseUnit: 'Caja',
    unitsPerPurchase: 24,
    saleUnit: 'Lata',
    historicCost: 14.2,
    purchaseCost: 14.2,
    newCost: 14.2,
    weightedAvgCost: 14.0,
    lastPurchaseCost: 14.2,
    salePrice: 19.0,
    targetMargin: 20,
    monthlySalesUnits: 24,
    expiry: '2028-05-30',
    fefoExpiryDate: '2028-05-30',
    acceptsPhysicalExchange: false,
    stock: 24,
    minStock: 12,
    abcClass: 'C',
    dailySalesRate: 0.8,
    supplierLeadTimeDays: 4,
    safetyStock: 3,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
  {
    sku: 'JAB-ZOT-400',
    barcode: '7501026006012',
    name: 'Jabón Zote Rosa 400g',
    category: 'Limpieza',
    emoji: '🧼',
    purchaseUnit: 'Caja',
    unitsPerPurchase: 25,
    saleUnit: 'Pieza',
    historicCost: 18.6,
    purchaseCost: 18.6,
    newCost: 18.6,
    weightedAvgCost: 18.5,
    lastPurchaseCost: 18.6,
    salePrice: 25.0,
    targetMargin: 22,
    monthlySalesUnits: 18,
    expiry: '2029-09-01',
    fefoExpiryDate: '2029-09-01',
    acceptsPhysicalExchange: false,
    stock: 30,
    minStock: 12,
    abcClass: 'C',
    dailySalesRate: 0.6,
    supplierLeadTimeDays: 4,
    safetyStock: 3,
    isBulk: false,
    supplier: 'Distribuidora del Bajío',
  },
];

const PRODUCTS: Product[] = PRODUCT_SEEDS.map((seed) => ({
  ...seed,
  rop: calculateROP(seed.dailySalesRate, seed.supplierLeadTimeDays, seed.safetyStock),
}));

const CREDIT_CUSTOMERS: CreditCustomer[] = [
  {
    id: 'CLI-01',
    name: 'Doña Carmen - Vecina Casa Blanca',
    alias: 'Casa Blanca',
    phone: '477-234-8812',
    creditLimit: 500.0,
    currentBalance: 185.0,
    dueDate: '2026-10-28',
    status: 'AL_CORRIENTE',
    notes: 'Paga puntual cada sábado por la mañana.',
  },
  {
    id: 'CLI-02',
    name: 'Taller Mecánico El Istmo',
    alias: 'Don Rogelio',
    phone: '477-391-0455',
    creditLimit: 600.0,
    currentBalance: 590.0,
    dueDate: '2026-10-25',
    status: 'LIMITE_ALCANZADO',
    notes: 'Quedan solo $10.00 de crédito disponible.',
  },
  {
    id: 'CLI-03',
    name: 'Familia López',
    alias: 'Depto 4',
    phone: '477-512-9034',
    creditLimit: 500.0,
    currentBalance: 520.0,
    dueDate: '2026-10-15',
    status: 'VENCIDO',
    notes: 'Saldo vencido la semana pasada. Requiere abono para volver a fiar.',
  },
  {
    id: 'CLI-04',
    name: 'Don Roberto - Carpintería',
    alias: 'Don Beto',
    phone: '477-680-1129',
    creditLimit: 400.0,
    currentBalance: 95.0,
    dueDate: '2026-10-30',
    status: 'AL_CORRIENTE',
    notes: 'Vecino de la esquina, liquida los viernes.',
  },
];

const MORNING_ALERTS: MorningAlert[] = [
  { id: 'A1', kind: 'cambio-fisico', icon: '⚠️', title: 'Separar 4 cajas de Leche Lala Entera 1L', detail: 'Caduca en 2 días (FEFO). El repartidor de Lala viene mañana a las 8:00 a.m. para hacer el cambio físico mano a mano.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A2', kind: 'cambio-fisico', icon: '⚠️', title: 'Separar 7 piezas de Pan Blanco Bimbo Grande', detail: 'Caduca mañana. Ponlas en la charola de devoluciones; el repartidor de Bimbo pasa hoy a las 4:00 p.m.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A4', kind: 'margen', icon: '🔺', title: 'Nota #DB-20931: 2 productos subieron de costo', detail: 'Aceite Nutrioli y Frijol Negro Granel ahora te dejan menos ganancia. Revísalos antes de guardar la mercancía.', actionLabel: 'Revisar nota', route: '/recepcion' },
  { id: 'A5', kind: 'por-agotarse', icon: '📉', title: '5 Productos Clase A están debajo de su Punto de Reorden (ROP)', detail: 'Leche Lala, Aceite Nutrioli, Frijol Negro, Huevo Blanco y Coca-Cola 600ml requieren pedido hoy.', actionLabel: 'Ver ROP en Catálogo', route: '/catalogo' },
  { id: 'A7', kind: 'auditoria', icon: '📋', title: 'Llegó el conteo del Pasillo 3 desde el celular', detail: 'Hay 3 productos con diferencias. Revisa antes de cerrar caja.', actionLabel: 'Revisar conteo', route: '/auditoria' },
];

function buildLine(sku: string, qtyPurchase: number, lineTotal: number): ReceptionLine {
  const p = PRODUCTS.find((x) => x.sku === sku)!;
  return {
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    emoji: p.emoji,
    qtyPurchase,
    purchaseUnit: p.purchaseUnit,
    unitsPerPurchase: p.unitsPerPurchase,
    saleUnit: p.saleUnit,
    lineTotal,
    historicCost: p.historicCost,
    newCost: +(lineTotal / (qtyPurchase * p.unitsPerPurchase)).toFixed(2),
    salePrice: p.salePrice,
    targetMargin: p.targetMargin,
    resolved: false,
  };
}

/** Nota de remisión simulada, "leída por OCR" desde el celular. */
function buildOcrNote(): SupplierNote {
  return {
    folio: 'DB-20931',
    supplier: 'Distribuidora del Bajío S.A. de C.V.',
    date: '22/10/2026',
    driver: 'J. Ramírez',
    route: 'Ruta 14',
    receivedFrom: 'Celular de Apoyo · OCR',
    lines: [
      buildLine('LAC-LAL-1L', 10, 210.0),   // $21.00 c/u → margen 19.2% (se mantiene costo histórico)
      buildLine('ACE-NUT-850', 12, 468.0),  // $39.00 c/u (antes $34.00) → margen cae al 7% (ROJO)
      buildLine('ATU-DOL-140', 24, 396.0),  // $16.50 c/u → margen 21% (OK)
      buildLine('FRI-NEG-50K', 15, 480.0),  // $32.00/kg (antes $28.00) → margen cae al 11% (ROJO)
      buildLine('QUE-FRE-1K', 5, 375.0),    // $75.00/kg → margen 21% (OK)
    ],
  };
}

const AUDIT_LINES: AuditLine[] = [
  { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', location: 'Anaquel B · Repisa 2', saleUnit: 'Pieza', systemQty: 18, countedQty: 15, unitCost: 34.0, status: 'pendiente' },
  { sku: 'ATU-DOL-140', name: 'Atún Dolores en Agua 140g', emoji: '🐟', location: 'Anaquel B · Repisa 3', saleUnit: 'Lata', systemQty: 40, countedQty: 40, unitCost: 16.5, status: 'pendiente' },
  { sku: 'FRI-NEG-50K', name: 'Frijol Negro Granel (1 kg)', emoji: '🫘', location: 'Piso · Junto a báscula', saleUnit: 'Kg', systemQty: 16.5, countedQty: 14.8, unitCost: 28.0, status: 'pendiente' },
  { sku: 'ARR-SOS-900', name: 'Arroz SOS Súper Extra 900g', emoji: '🍚', location: 'Anaquel C · Repisa 1', saleUnit: 'Pieza', systemQty: 16, countedQty: 18, unitCost: 27.6, status: 'pendiente' },
  { sku: 'CHI-LAC-220', name: 'Chiles Jalapeños La Costeña 220g', emoji: '🌶️', location: 'Anaquel C · Repisa 2', saleUnit: 'Lata', systemQty: 24, countedQty: 21, unitCost: 14.2, status: 'pendiente' },
];

const SHRINK_RECORDS: ShrinkRecord[] = [
  { id: 'M-0412', date: '22/10/2026', time: '9:15 a.m.', sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', emoji: '🥛', qty: 2, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 21.0, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0411', date: '21/10/2026', time: '11:40 a.m.', sku: 'HUE-BAC-18', name: 'Huevo Blanco Granel (1 kg)', emoji: '🥚', qty: 1, saleUnit: 'Kg', reason: 'Envase Roto en Piso', unitCost: 36.0, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0410', date: '20/10/2026', time: '8:05 p.m.', sku: 'YOG-YOP-1K', name: 'Yoghurt Yoplait Fresa 1kg', emoji: '🍓', qty: 3, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41.3, registeredBy: 'Celular · Doña Lupe', hasPhoto: true, reviewed: false },
  { id: 'M-0409', date: '19/10/2026', time: '9:30 a.m.', sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo Grande 680g', emoji: '🍞', qty: 2, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: true },
  { id: 'M-0408', date: '18/10/2026', time: '5:50 p.m.', sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', qty: 1, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 34.0, registeredBy: 'Celular · Doña Lupe', hasPhoto: true, reviewed: true },
];

// =====================================================================
//  SERVICIO
// =====================================================================

@Injectable({ providedIn: 'root' })
export class MockInventoryService {
  readonly storeName = 'Abarrotes Doña Lupe';
  readonly today = 'Jueves 22 de octubre de 2026';

  readonly products = signal<Product[]>(structuredClone(PRODUCTS));
  readonly creditCustomers = signal<CreditCustomer[]>(structuredClone(CREDIT_CUSTOMERS));

  /** Turno y arqueo de caja con desglose estricto (efectivo vs fiado vs consumo interno). */
  readonly cashShift = signal<CashShiftSummary>({
    openingCash: 500.0,
    cashSalesTotal: 0.0,
    creditPaymentsReceived: 0.0,
    creditSalesTotal: 0.0,
    internalConsumptionTotalCost: 0.0,
    shrinkTotalCost: 0.0,
  });

  readonly cashRegister = signal<CashRegisterSummary>({
    openingFloat: 500.0,
    cashSalesTotal: 0.0,
    creditSalesTotal: 0.0,
    creditPaymentsReceived: 0.0,
  });

  /** Registro histórico de consumos internos para alimentación o uso de la tienda. */
  readonly internalConsumptionRecords = signal<InternalConsumptionRecord[]>([]);

  readonly kardex = signal<KardexEntry[]>([
    {
      id: 'K-103',
      timestamp: '10:42 a.m.',
      type: 'ABONO_FIADO',
      description: 'Abono en efectivo de Doña María López - Casa Azul',
      amount: 150.0,
    },
    {
      id: 'K-102',
      timestamp: '10:15 a.m.',
      type: 'VENTA_FIADO',
      description: 'Venta anotada en libreta a Don Roberto Hernández (3 art.)',
      amount: 145.0,
    },
    {
      id: 'K-101',
      timestamp: '09:50 a.m.',
      type: 'VENTA_EFECTIVO',
      description: 'Venta de mostrador en efectivo (Leche Lala, Bolillos, Queso)',
      amount: 112.0,
    },
  ]);

  readonly morningAlerts = signal<MorningAlert[]>(structuredClone(MORNING_ALERTS));
  readonly auditLines = signal<AuditLine[]>(structuredClone(AUDIT_LINES));
  readonly shrinkRecords = signal<ShrinkRecord[]>(structuredClone(SHRINK_RECORDS));

  /** Estado de vinculación con el celular. */
  readonly phoneLinked = signal(false);

  /** Última nota de proveedor recibida por OCR (o null si ya se guardó). */
  readonly ocrNote = signal<SupplierNote | null>(buildOcrNote());
  readonly lastSavedNote = signal<string | null>(null);

  readonly pendingAuditCount = computed(
    () => this.auditLines().filter((l) => l.status === 'pendiente' && l.countedQty !== l.systemQty).length,
  );
  readonly pendingShrinkCount = computed(() => this.shrinkRecords().filter((r) => !r.reviewed).length);

  /** Productos Clase A que están en o por debajo de su Punto de Reorden (ROP). */
  readonly criticalRopProducts = computed(() =>
    this.products().filter((p) => p.abcClass === 'A' && p.stock <= p.rop),
  );

  /** Lotes próximos a caducar para semáforo FEFO y Cambio Físico. */
  readonly fefoExchangeProducts = computed(() =>
    this.products().filter((p) => p.acceptsPhysicalExchange),
  );

  /** Total acumulado de deuda por cobrar en la libreta de fiado. */
  readonly totalAccountsReceivable = computed(() =>
    this.creditCustomers().reduce((sum, c) => sum + c.currentBalance, 0),
  );

  // ---------- Clasificación ABC por Utilidad Neta (VU) y Propuestas ----------
  readonly abcConfig = signal({ windowDays: 30, minDaysForAuto: 14 });
  readonly lastAbcRun = signal<string>('22 de octubre de 2026');
  readonly abcPinned = signal<Record<string, AbcClass>>({});

  toggleTrafficDriver(sku: string): void {
    this.products.update((list) =>
      list.map((p) => (p.sku === sku ? { ...p, isTrafficDriver: !p.isTrafficDriver } : p)),
    );
  }

  pinAbc(sku: string, value: AbcClass | null): void {
    this.abcPinned.update((m) => {
      const copy = { ...m };
      if (!value) delete copy[sku];
      else copy[sku] = value;
      return copy;
    });
  }

  readonly abcSuggestions = computed<AbcResult[]>(() => {
    const products = this.products();
    const rankings = calculateAbcRankings(products);
    const pinned = this.abcPinned();

    return products.map((p, idx) => {
      const rank = rankings.get(p.sku);
      const computedClass = rank?.proposedClass ?? p.abcClass;
      const finalClass = pinned[p.sku] ?? (p.isTrafficDriver && computedClass === 'C' ? 'B' : computedClass);
      const changed = finalClass !== p.abcClass;
      const flags: any[] = [];
      if (pinned[p.sku]) flags.push('CANDADO');
      if (p.isTrafficDriver) flags.push('GANCHO');

      return {
        sku: p.sku,
        currentClass: p.abcClass,
        computedClass,
        finalClass,
        source: pinned[p.sku] ? 'MANUAL' : 'AUTOMATICA',
        share: (rank?.share ?? 0) / 100,
        cumulativeBefore: ((rank?.cumulativePct ?? 0) - (rank?.share ?? 0)) / 100,
        rank: idx + 1,
        grossProfit: rank?.netProfit ?? 0,
        ticketCount: Math.round((p.dailySalesRate || 1) * 25),
        changed,
        reason: `Utilidad neta: $${(rank?.netProfit ?? 0).toFixed(0)}/mes.`,
        flags,
      };
    });
  });

  readonly pendingAbcChanges = computed<AbcResult[]>(() =>
    this.abcSuggestions().filter((r) => r.changed),
  );

  applyAbcResults(results: AbcResult[], skus?: string[]): number {
    const targetSkus = new Set(skus ?? results.filter((r) => r.changed).map((r) => r.sku));
    let count = 0;
    this.products.update((list) =>
      list.map((p) => {
        if (!targetSkus.has(p.sku)) return p;
        const res = results.find((r) => r.sku === p.sku);
        if (res && res.finalClass !== p.abcClass) {
          count++;
          return { ...p, abcClass: res.finalClass };
        }
        return p;
      }),
    );
    this.lastAbcRun.set(new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }));
    return count;
  }

  previewGuided(answers: GuidedAnswer[]): AbcResult[] {
    const answerMap = new Map(answers.map((a) => [a.sku, a]));
    return this.products().map((p, idx) => {
      const ans = answerMap.get(p.sku);
      let computedClass: AbcClass = p.abcClass;
      if (ans) {
        computedClass = ans.frequency === 'VARIAS_AL_DIA' ? 'A' : ans.frequency === 'POR_SEMANA' ? 'B' : 'C';
      }
      let finalClass = computedClass;
      if (ans?.losesCustomer && finalClass === 'C') finalClass = 'B';
      return {
        sku: p.sku,
        currentClass: p.abcClass,
        computedClass,
        finalClass,
        source: 'GUIADA',
        share: 0.1,
        cumulativeBefore: 0,
        rank: idx + 1,
        grossProfit: calculateVU(p),
        ticketCount: Math.round((p.dailySalesRate || 1) * 20),
        changed: finalClass !== p.abcClass,
        reason: 'Estimado con respuestas guiadas.',
        flags: ans?.losesCustomer ? ['GANCHO'] : [],
      };
    });
  }

  /** Discrepancias entre la clase actual y la propuesta calculada con VU. */
  readonly abcDiscrepancies = computed<ClassificationDiscrepancy[]>(() =>
    proposeNewClassification(this.products()),
  );
  readonly abcProposalDismissed = signal(false);

  /** Aplica los cambios de clasificación aceptados por el usuario. */
  confirmClassificationChanges(accepted: ClassificationDiscrepancy[]): void {
    this.products.update((list) => confirmClassificationChanges(list, accepted));
    this.abcProposalDismissed.set(false);
  }

  /** Pospone la revisión de reclasificación para fin de mes. */
  dismissAbcProposal(): void {
    this.abcProposalDismissed.set(true);
  }

  // ---------- Accesos Rápidos POS y Sugerencias de Clase A ----------
  /** Productos fijados manualmente en el acceso rápido del mostrador. */
  readonly pinnedQuickAccessSkus = signal<string[]>([
    'HUE-BAC-18', // Huevo Blanco
    'FRI-NEG-50K', // Frijol Negro
    'AZU-ZUL-1K',  // Azúcar
    'QUE-FRE-1K',  // Queso Fresco
    'PAN-BOL-PZ',  // Pan / Bolillo
  ]);

  /** Sugerencias descartadas por el usuario para no insistir. */
  readonly dismissedQuickAccessSuggestions = signal<string[]>([]);

  pinProductQuickAccess(sku: string): void {
    if (!this.pinnedQuickAccessSkus().includes(sku)) {
      this.pinnedQuickAccessSkus.update((list) => [...list, sku]);
    }
  }

  unpinProductQuickAccess(sku: string): void {
    this.pinnedQuickAccessSkus.update((list) => list.filter((s) => s !== sku));
  }

  dismissQuickAccessSuggestion(sku: string): void {
    if (!this.dismissedQuickAccessSuggestions().includes(sku)) {
      this.dismissedQuickAccessSuggestions.update((list) => [...list, sku]);
    }
  }

  /** Productos de Clase A que NO están anclados en acceso rápido ni descartados. */
  readonly quickAccessSuggestions = computed(() => {
    const pinned = new Set(this.pinnedQuickAccessSkus());
    const dismissed = new Set(this.dismissedQuickAccessSuggestions());
    return this.products().filter((p) => p.abcClass === 'A' && !pinned.has(p.sku) && !dismissed.has(p.sku));
  });

  // ---------- Badges de Alerta Operativa para el Dashboard ----------
  /** true si la nota OCR tiene productos donde el costo subió y rompió el margen objetivo. */
  readonly hasPendingOcrMarginIssue = computed(() => {
    const note = this.ocrNote();
    if (!note) return false;
    return note.lines.some((l) => !l.resolved && marginPct(l.newCost, l.salePrice) < l.targetMargin);
  });

  readonly brokenMarginLinesCount = computed(() => {
    const note = this.ocrNote();
    if (!note) return 0;
    return note.lines.filter((l) => !l.resolved && marginPct(l.newCost, l.salePrice) < l.targetMargin).length;
  });

  readonly overdueCustomersCount = computed(() =>
    this.creditCustomers().filter((c) => c.status === 'VENCIDO' || c.status === 'LIMITE_ALCANZADO').length,
  );

  // ---------- Corte de Caja y Punto de Venta (POS) ----------

  /**
   * Devuelve el efectivo real que debe existir físicamente en el cajón:
   * openingCash ($500.00) + cashSalesTotal + creditPaymentsReceived
   */
  getRealDrawerCash(): number {
    const s = this.cashShift();
    return +(s.openingCash + s.cashSalesTotal + s.creditPaymentsReceived).toFixed(2);
  }

  /** Alias para compatibilidad con vistas y componentes existentes. */
  getExpectedDrawerCash(): number {
    return this.getRealDrawerCash();
  }

  /**
   * Procesa una venta en efectivo:
   * - Valida que el efectivo recibido cubra el total.
   * - Calcula el cambio exacto.
   * - Descuenta existencias en tiempo real.
   * - Suma a cashSalesTotal en el arqueo del cajón.
   * - Registra en Kardex como 'VENTA_EFECTIVO'.
   */
  processCashSale(items: CartItem[], cashReceived: number): SaleResult {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', total: 0, change: 0 };
    }
    const total = +items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2);
    if (cashReceived < total) {
      return {
        ok: false,
        message: `El efectivo recibido ($${cashReceived.toFixed(2)}) es menor al total a pagar ($${total.toFixed(2)}).`,
        total,
        change: 0,
      };
    }
    const change = +(cashReceived - total).toFixed(2);

    // Descontar existencias en tiempo real
    this.products.update((list) =>
      list.map((p) => {
        const soldItem = items.find((i) => i.sku === p.sku);
        if (!soldItem) return p;
        const nextStock = Math.max(0, +(p.stock - soldItem.qty).toFixed(3));
        return { ...p, stock: nextStock };
      }),
    );

    // Actualizar totales de caja (Efectivo físico entra al cajón)
    this.cashShift.update((s) => ({
      ...s,
      cashSalesTotal: +(s.cashSalesTotal + total).toFixed(2),
    }));
    this.cashRegister.update((r) => ({
      ...r,
      cashSalesTotal: +(r.cashSalesTotal + total).toFixed(2),
    }));

    // Registrar en Kardex
    const now = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
    const summaryNames = items.slice(0, 2).map((i) => i.name).join(', ');
    this.kardex.update((entries) => [
      {
        id: 'K-' + String(Date.now()).slice(-4),
        timestamp: now,
        type: 'VENTA_EFECTIVO',
        description: `Venta en efectivo (${items.length} art.: ${summaryNames})`,
        amount: total,
      },
      ...entries,
    ]);

    return {
      ok: true,
      message: `Venta cobrada con éxito. Cambio: $${change.toFixed(2)}`,
      total,
      change,
    };
  }

  /**
   * Procesa una venta cargada a la Libreta Digital de Fiado (Crédito Vecinal):
   * - Bloquea la venta si el cliente tiene estatus 'VENCIDO'.
   * - Bloquea si la venta excede el límite de crédito disponible.
   * - Suma a creditSalesTotal (NO SUMA EFECTIVO AL CAJÓN: +$0.00).
   * - Descuenta existencias de inventario físico.
   * - Registra en Kardex como 'VENTA_FIADO'.
   */
  processCreditSale(items: CartItem[], customerId: string): CreditResult {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', total: 0 };
    }
    const total = +items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2);
    const customer = this.creditCustomers().find((c) => c.id === customerId);
    if (!customer) {
      return { ok: false, message: 'Selecciona un cliente para cargar el fiado.', total };
    }
    if (customer.status === 'VENCIDO') {
      return {
        ok: false,
        message: `Crédito bloqueado: el cliente tiene pagos vencidos ($${customer.currentBalance.toFixed(2)}).`,
        total,
        availableCredit: Math.max(0, +(customer.creditLimit - customer.currentBalance).toFixed(2)),
      };
    }
    if (customer.currentBalance + total > customer.creditLimit) {
      const available = Math.max(0, +(customer.creditLimit - customer.currentBalance).toFixed(2));
      return {
        ok: false,
        message: `Límite de crédito excedido. Disponible: $${available.toFixed(2)} de su límite de $${customer.creditLimit.toFixed(2)}.`,
        total,
        availableCredit: available,
      };
    }

    // Actualizar saldo y estatus del cliente
    this.creditCustomers.update((list) =>
      list.map((c) => {
        if (c.id !== customerId) return c;
        const newBal = +(c.currentBalance + total).toFixed(2);
        const ratio = newBal / c.creditLimit;
        const nextStatus: CreditCustomerStatus =
          c.status === 'VENCIDO' ? 'VENCIDO' : ratio >= 0.9 ? 'LIMITE_ALCANZADO' : 'AL_CORRIENTE';
        return { ...c, currentBalance: newBal, status: nextStatus };
      }),
    );

    // Sumar a crédito (NO ENTRA DINERO EN EFECTIVO AL CAJÓN)
    this.cashShift.update((s) => ({
      ...s,
      creditSalesTotal: +(s.creditSalesTotal + total).toFixed(2),
    }));
    this.cashRegister.update((r) => ({
      ...r,
      creditSalesTotal: +(r.creditSalesTotal + total).toFixed(2),
    }));

    // Descontar inventario físico
    this.products.update((list) =>
      list.map((p) => {
        const soldItem = items.find((i) => i.sku === p.sku);
        if (!soldItem) return p;
        const nextStock = Math.max(0, +(p.stock - soldItem.qty).toFixed(3));
        return { ...p, stock: nextStock };
      }),
    );

    // Registrar en Kardex
    const now = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
    this.kardex.update((entries) => [
      {
        id: 'K-' + String(Date.now()).slice(-4),
        timestamp: now,
        type: 'VENTA_FIADO',
        description: `Fiado cargado a la libreta de ${customer.name} (${items.length} art.)`,
        amount: total,
      },
      ...entries,
    ]);

    const remainingAvailable = +(customer.creditLimit - (customer.currentBalance + total)).toFixed(2);

    return {
      ok: true,
      message: `Venta cargada a la cuenta de ${customer.name}. Saldo total: $${(customer.currentBalance + total).toFixed(2)}.`,
      total,
      availableCredit: remainingAvailable,
    };
  }

  /**
   * Procesa el Consumo Interno (alimentos o suministros tomados para la tienda o comida del personal):
   * - Valida artículos y responsable obligatorio.
   * - Se valúa estrictamente al COSTO DE COMPRA (weightedAvgCost / purchaseCost / historicCost), NO al precio de venta.
   * - Descuenta existencias físicas de inventario.
   * - No entra dinero al cajón de efectivo ($0.00).
   * - Registra en internalConsumptionRecords y Kardex como 'CONSUMO_INTERNO'.
   */
  processInternalConsumption(
    items: CartItem[],
    responsible: string,
  ): { ok: boolean; message: string; totalCost: number } {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', totalCost: 0 };
    }
    const cleanResponsible = responsible?.trim() || 'Dueño (Don Lupe)';

    const catalog = this.products();
    const detailedItems = items.map((item) => {
      const prod = catalog.find((p) => p.sku === item.sku);
      const unitCost =
        prod?.purchaseCost ??
        prod?.lastPurchaseCost ??
        prod?.weightedAvgCost ??
        prod?.historicCost ??
        +(item.unitPrice * 0.75).toFixed(2);
      const subtotalCost = +(unitCost * item.qty).toFixed(2);
      return {
        productId: item.sku,
        name: item.name,
        quantity: item.qty,
        unitCost: +unitCost.toFixed(2),
        subtotalCost,
      };
    });

    const totalCost = +detailedItems.reduce((sum, i) => sum + i.subtotalCost, 0).toFixed(2);

    // Descontar inventario físico
    this.products.update((list) =>
      list.map((p) => {
        const consumed = items.find((i) => i.sku === p.sku);
        if (!consumed) return p;
        const nextStock = Math.max(0, +(p.stock - consumed.qty).toFixed(3));
        return { ...p, stock: nextStock };
      }),
    );

    // Registrar en colección de consumos internos
    const record: InternalConsumptionRecord = {
      id: 'CI-' + String(Date.now()).slice(-4),
      timestamp: new Date(),
      responsible: cleanResponsible,
      items: detailedItems,
      totalCost,
    };
    this.internalConsumptionRecords.update((records) => [record, ...records]);

    // Sumar al total contable de consumos internos (Cajón de efectivo: +$0.00)
    this.cashShift.update((s) => ({
      ...s,
      internalConsumptionTotalCost: +(s.internalConsumptionTotalCost + totalCost).toFixed(2),
    }));

    // Registrar en Kardex
    const now = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
    this.kardex.update((entries) => [
      {
        id: 'K-' + String(Date.now()).slice(-4),
        timestamp: now,
        type: 'CONSUMO_INTERNO',
        description: `Consumo Interno autorizado por ${cleanResponsible} (${items.length} art., Valuado al Costo: $${totalCost.toFixed(2)})`,
        amount: totalCost,
      },
      ...entries,
    ]);

    return {
      ok: true,
      message: `Consumo interno registrado a cargo de ${cleanResponsible} por un costo contable de $${totalCost.toFixed(2)}. Existencias descontadas sin entrada al cajón.`,
      totalCost,
    };
  }

  /**
   * Método de compatibilidad para llamadas generales de venta.
   */
  processSale(
    items: PosSaleItem[],
    paymentType: 'EFECTIVO' | 'FIADO',
    customerId?: string,
  ): { ok: boolean; message: string; total: number } {
    if (paymentType === 'FIADO') {
      const res = this.processCreditSale(items, customerId || '');
      return { ok: res.ok, message: res.message, total: res.total };
    } else {
      const total = +items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2);
      const res = this.processCashSale(items, total);
      return { ok: res.ok, message: res.message, total: res.total };
    }
  }

  /**
   * Registra un abono en efectivo de un cliente de fiado:
   * - Disminuye su deuda (currentBalance) y actualiza su estatus.
   * - Suma el dinero recibido a creditPaymentsReceived (¡SÍ ENTRA EFECTIVO FÍSICO AL CAJÓN!).
   */
  registerCreditPayment(customerId: string, amount: number): { ok: boolean; message: string } {
    if (isNaN(amount) || amount <= 0) {
      return { ok: false, message: 'Ingresa un monto de abono mayor a $0.00.' };
    }
    const customer = this.creditCustomers().find((c) => c.id === customerId);
    if (!customer) {
      return { ok: false, message: 'Cliente no encontrado.' };
    }
    const applied = Math.min(amount, customer.currentBalance);
    if (applied <= 0) {
      return { ok: false, message: `${customer.name} no tiene deuda pendiente.` };
    }

    this.creditCustomers.update((list) =>
      list.map((c) => {
        if (c.id !== customerId) return c;
        const newBal = Math.max(0, +(c.currentBalance - applied).toFixed(2));
        const nextStatus: CreditCustomerStatus =
          newBal / c.creditLimit >= 0.9 ? 'LIMITE_ALCANZADO' : 'AL_CORRIENTE';
        return {
          ...c,
          currentBalance: newBal,
          status: nextStatus,
        };
      }),
    );

    this.cashShift.update((s) => ({
      ...s,
      creditPaymentsReceived: +(s.creditPaymentsReceived + applied).toFixed(2),
    }));

    this.cashRegister.update((reg) => ({
      ...reg,
      creditPaymentsReceived: +(reg.creditPaymentsReceived + applied).toFixed(2),
    }));

    const now = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
    this.kardex.update((entries) => [
      {
        id: 'K-' + String(Date.now()).slice(-4),
        timestamp: now,
        type: 'ABONO_FIADO',
        description: `Abono en efectivo recibido de ${customer.name}`,
        amount: applied,
      },
      ...entries,
    ]);

    return {
      ok: true,
      message: `Se registró abono de $${applied.toFixed(2)} en efectivo de ${customer.name}.`,
    };
  }

  // ---------- Recepción ----------

  /** Nota nueva (simula volver a recibirla desde el celular). */
  reloadOcrNote(): void {
    this.ocrNote.set(buildOcrNote());
  }

  /** Actualiza la nota OCR activa con líneas obtenidas del laboratorio OCR o BroadcastChannel. */
  setCustomOcrNote(lines: ReceptionLine[], folio = 'OCR-LAB', receivedFrom = 'Laboratorio OCR / Celular'): void {
    this.ocrNote.set({
      folio,
      supplier: 'Proveedor Validado por OCR',
      date: '22/10/2026',
      driver: 'Repartidor en Mostrador',
      route: 'Recepción Directa',
      receivedFrom,
      lines: structuredClone(lines),
    });
  }

  /** Busca un producto por su código EAN-13. */
  findProductByBarcode(barcode: string): Product | undefined {
    const clean = String(barcode || '').trim();
    return this.products().find((p) => p.barcode === clean);
  }

  /** Crea una línea manual a partir de un producto del catálogo. */
  createManualLine(sku: string, qtyPurchase: number, costPerPurchaseUnit: number): ReceptionLine {
    const line = buildLine(sku, qtyPurchase, +(qtyPurchase * costPerPurchaseUnit).toFixed(2));
    const p = this.products().find((x) => x.sku === sku)!;
    line.salePrice = p.salePrice;
    line.historicCost = p.historicCost;
    return line;
  }

  /** Guarda la entrada: suma existencias, recalcula Costo Promedio Ponderado y actualiza Último Costo de Reposición. */
  saveReception(lines: ReceptionLine[], folio: string): void {
    this.products.update((list) =>
      list.map((p) => {
        const line = lines.find((l) => l.sku === p.sku);
        if (!line) return p;
        const incomingUnits = line.qtyPurchase * line.unitsPerPurchase;
        const newTotalStock = +(p.stock + incomingUnits).toFixed(2);
        const newWeightedAvg =
          newTotalStock > 0
            ? +((p.stock * p.weightedAvgCost + incomingUnits * line.newCost) / newTotalStock).toFixed(2)
            : line.newCost;
        return {
          ...p,
          stock: newTotalStock,
          weightedAvgCost: newWeightedAvg,
          historicCost: line.newCost,
          newCost: line.newCost,
          lastPurchaseCost: line.newCost,
          salePrice: line.salePrice,
        };
      }),
    );
    if (folio === this.ocrNote()?.folio) {
      this.ocrNote.set(null);
      this.morningAlerts.update((a) => a.filter((x) => x.kind !== 'margen'));
    }
    this.lastSavedNote.set(folio);
  }

  // ---------- Auditoría ----------

  setAuditStatus(sku: string, status: AuditStatus): void {
    this.auditLines.update((list) => list.map((l) => (l.sku === sku ? { ...l, status } : l)));
    if (status === 'autorizado') {
      const line = this.auditLines().find((l) => l.sku === sku)!;
      this.products.update((list) => list.map((p) => (p.sku === sku ? { ...p, stock: line.countedQty } : p)));
    }
    if (this.pendingAuditCount() === 0) {
      this.morningAlerts.update((a) => a.filter((x) => x.kind !== 'auditoria'));
    }
  }

  // ---------- Mermas ----------

  markShrinkReviewed(id: string): void {
    this.shrinkRecords.update((list) => list.map((r) => (r.id === id ? { ...r, reviewed: true } : r)));
  }
}
