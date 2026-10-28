import { Injectable, computed, effect, signal } from '@angular/core';
import { addShrinkRecordIdempotent } from '../domain/shrink';
import {
  toCents,
  fromCents,
  sumMoney,
  subtractMoney,
  multiplyMoney,
  formatMxn,
  calculateTax,
} from '../domain/money';
import {
  computeCreditStatus,
  applyCreditPaymentPure,
  applyCreditSalePure,
  type CreditCustomerStatus,
} from '../domain/credit';
import {
  createKardexEntry,
  generateKardexId,
  appendKardexEntry,
  deductStock,
  deductStockForDisposal,
  resolveShortageAlertAdjustment,
  verifyKardexChain,
  verifyProductContinuity,
  KardexAsyncQueue,
  type KardexEntry,
  type KardexType,
} from '../domain/kardex';
import {
  isPinConfigured,
  setupInitialPin,
  verifyPinAttempt,
  loadPinState,
  createInitialPinState,
  type PinAuthConfig,
  type PinAuthState,
  type PinVerificationResult,
} from '../domain/pin';
import {
  CURRENT_SCHEMA_VERSION,
  STATE_STORAGE_KEY,
  DEFAULT_DEBOUNCE_MS,
  validateStoredState,
  migrateState,
  DebouncedStorageSaver,
  StateStorageAdapter,
  getDefaultStorageAdapter,
  type PersistedAppState,
} from '../domain/persistence';
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

export type { CreditCustomerStatus } from '../domain/credit';

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

export type { KardexEntry, KardexType } from '../domain/kardex';

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
  evidenceId?: string;
  reviewed: boolean;
}

export interface SupplierRoute {
  id: string;
  name: string;
  visitDays: string[];
  physicalExchangePolicy: boolean;
  phone: string;
}

export interface PerishableBatch {
  batchId: string;
  productId: string;
  productName: string;
  expiryDate: string;
  quantity: number;
  status: 'OPTIMO' | 'POR_VENCER' | 'VENCIDO';
  supplierId?: string;
}

export interface BlindAuditItem {
  sku: string;
  barcode: string;
  name: string;
  category: string;
  saleUnit: SaleUnit;
  location: string;
  unitCost: number;
  countedQty?: number;
  completed?: boolean;
}

// =====================================================================
//  UTILIDADES DE MARGEN, ROP Y PARSER OCR
// =====================================================================

/** Margen (%) sobre precio de venta. */
export function marginPct(cost: number, price: number): number {
  if (price <= 0) return 0;
  return ((price - cost) / price) * 100;
}

/**
 * Redondeo comercial inteligente:
 * - Menor a $50 MXN -> redondear al múltiplo de $0.50 o $1.00 superior más cercano (ej. $24.10 -> $24.50).
 * - Mayor o igual a $50 MXN -> redondear al peso entero superior ($78.20 -> $79.00).
 */
export function calculateCommercialRound(price: number): number {
  if (price <= 0) return 0;
  const cents = toCents(price);
  if (cents < 5000) {
    return fromCents(Math.ceil(cents / 50) * 50);
  } else {
    return fromCents(Math.ceil(cents / 100) * 100);
  }
}

/** Precio sugerido redondeado comercialmente para cumplir el margen objetivo. */
export function suggestedPrice(cost: number, targetMargin: number): number {
  if (targetMargin >= 100) return fromCents(Math.ceil(toCents(cost) * 1.5));
  const rawCents = Math.round(toCents(cost) / (1 - targetMargin / 100));
  return calculateCommercialRound(fromCents(rawCents));
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
    let lineTotal = multiplyMoney(rawAmount, qty);

    if (qty > 1 && rawAmount > product.historicCost * 2.2) {
      const candidateUnit = rawAmount / qty;
      if (Math.abs(candidateUnit - product.historicCost) < Math.abs(rawAmount - product.historicCost)) {
        unitNewCost = fromCents(Math.round(toCents(candidateUnit)));
        lineTotal = fromCents(toCents(rawAmount));
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
      newCost: fromCents(toCents(unitNewCost)),
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
    newCost: fromCents(Math.round(toCents(lineTotal) / (qtyPurchase * p.unitsPerPurchase))),
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

export const SUPPLIER_ROUTES: SupplierRoute[] = [
  {
    id: 'SUP-LAL',
    name: 'Lala (Lácteos)',
    visitDays: ['Martes', 'Viernes'],
    physicalExchangePolicy: true,
    phone: '800-433-5252',
  },
  {
    id: 'SUP-BIM',
    name: 'Bimbo (Panadería)',
    visitDays: ['Lunes', 'Miércoles', 'Viernes'],
    physicalExchangePolicy: true,
    phone: '800-910-2462',
  },
  {
    id: 'SUP-SAB',
    name: 'Sabritas',
    visitDays: ['Jueves'],
    physicalExchangePolicy: false,
    phone: '800-901-9500',
  },
];

export const PERISHABLE_BATCHES: PerishableBatch[] = [
  {
    batchId: 'LOT-LAL-201',
    productId: 'LAC-LAL-1L',
    productName: 'Leche Lala Entera 1L',
    expiryDate: '2026-10-24', // Dentro de 48h (Viernes visita Lala)
    quantity: 8,
    status: 'POR_VENCER',
    supplierId: 'SUP-LAL',
  },
  {
    batchId: 'LOT-BIM-504',
    productId: 'PAN-BIM-680',
    productName: 'Pan Blanco Bimbo Grande 680g',
    expiryDate: '2026-10-23', // Mañana (Viernes visita Bimbo)
    quantity: 5,
    status: 'POR_VENCER',
    supplierId: 'SUP-BIM',
  },
  {
    batchId: 'LOT-YOP-102',
    productId: 'YOG-YOP-1K',
    productName: 'Yoghurt Yoplait Fresa 1kg',
    expiryDate: '2026-11-15',
    quantity: 12,
    status: 'OPTIMO',
    supplierId: 'SUP-LAL',
  },
];

// =====================================================================
//  SERVICIO
// =====================================================================

function buildInitialKardex(): KardexEntry[] {
  // Cadena criptográfica semilla (orden cronológico ascendente)
  const e1 = createKardexEntry({
    type: 'VENTA_EFECTIVO',
    producto: { sku: 'VAR-01', name: 'Leche Lala, Bolillos, Queso' },
    cantidad: -3,
    saldoAnterior: 10,
    saldoResultante: 7,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Ticket #0101',
    amount: 112.0,
    description: 'Venta de mostrador en efectivo (Leche Lala, Bolillos, Queso)',
  }, 'GENESIS');

  const e2 = createKardexEntry({
    type: 'VENTA_FIADO',
    producto: { sku: 'CLI-04', name: 'Don Roberto Hernández' },
    cantidad: -3,
    saldoAnterior: 0,
    saldoResultante: 145.0,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Libreta Fiado #102',
    amount: 145.0,
    description: 'Venta anotada en libreta a Don Roberto Hernández (3 art.)',
  }, e1.entryHash);

  const e3 = createKardexEntry({
    type: 'ABONO_FIADO',
    producto: { sku: 'CLI-03', name: 'Doña María López - Casa Azul' },
    cantidad: 0,
    saldoAnterior: 150.0,
    saldoResultante: 0,
    usuario: 'Don Lupe (Encargado)',
    referencia: 'Abono Doña María López',
    amount: 150.0,
    description: 'Abono en efectivo de Doña María López - Casa Azul',
  }, e2.entryHash);

  // Se retorna newest-first: [e3, e2, e1]
  return [e3, e2, e1];
}

@Injectable({ providedIn: 'root' })
export class MockInventoryService {
  readonly storeName = 'Abarrotes Doña Lupe';
  readonly today = 'Jueves 22 de octubre de 2026';

  /** Selector de cajero/usuario actual en la app (no valor fijo) */
  readonly availableUsers = signal<string[]>([
    'Don Lupe (Encargado)',
    'María (Cajera Mañana)',
    'Pedro (Cajero Tarde)',
    'Administrador',
  ]);
  readonly activeUser = signal<string>('Don Lupe (Encargado)');
  readonly kardexQueue = new KardexAsyncQueue();

  /**
   * Encola una operación que altera el Kardex para asegurar ejecución serializada
   * y atómica, impidiendo bifurcaciones de hash bajo concurrencia.
   */
  async enqueueKardexOperation<T>(task: () => Promise<T> | T): Promise<T> {
    return this.kardexQueue.enqueue(task);
  }

  /**
   * Cambia el usuario activo.
   * Cambiar a 'Administrador' exige validación de PIN de al menos 6 dígitos.
   * Cada cambio de usuario genera una entrada auditable de tipo 'CAMBIO_USUARIO' en el Kardex.
   */
  async setActiveUser(name: string, pin?: string): Promise<{ success: boolean; message: string }> {
    const target = name?.trim();
    if (!target) return { success: false, message: 'Nombre de usuario inválido.' };
    const prevUser = this.activeUser();
    if (target === prevUser) return { success: true, message: 'Usuario actual sin cambios.' };

    if (target === 'Administrador') {
      const pinCheck = await this.verifyAdminPin(pin || '');
      if (!pinCheck.success) {
        return { success: false, message: pinCheck.message };
      }
    }

    return this.enqueueKardexOperation(() => {
      this.activeUser.set(target);
      const lastEntry = this.kardex()[0];
      const prevHash = lastEntry ? lastEntry.entryHash : 'GENESIS';
      const entry = createKardexEntry(
        {
          type: 'CAMBIO_USUARIO',
          producto: { sku: 'SISTEMA', name: 'Sesión de Usuario', saleUnit: 'Sesión' },
          cantidad: 0,
          saldoAnterior: 0,
          saldoResultante: 0,
          usuario: target,
          referencia: `Cambio de usuario activo: "${prevUser}" -> "${target}"`,
          description: `CAMBIO DE USUARIO ACTIVO: Se transfirió la sesión de "${prevUser}" a "${target}".`,
          amount: 0,
        },
        prevHash
      );
      this.kardex.update((prev) => appendKardexEntry(prev, entry));
      this.scheduleSave();
      return { success: true, message: `Usuario activo cambiado a ${target}.` };
    });
  }

  // ---------- Persistencia de Estado en IndexedDB (Bloque D) ----------
  storageAdapter: StateStorageAdapter = getDefaultStorageAdapter();
  private readonly storageSaver = new DebouncedStorageSaver(DEFAULT_DEBOUNCE_MS);
  readonly corruptedDataWarning = signal<string | null>(null);
  readonly isHydrated = signal<boolean>(false);

  constructor() {
    this.initLanSyncListener();
    this.initPersistence();
  }

  private initPersistence(): void {
    try {
      effect(() => {
        // Trackeamos reactivamente las señales principales
        const _p = this.products();
        const _c = this.creditCustomers();
        const _s = this.cashShift();
        const _r = this.cashRegister();
        const _k = this.kardex();
        const _sr = this.shrinkRecords();
        const _al = this.auditLines();
        const _ic = this.internalConsumptionRecords();
        const _u = this.activeUser();
        const _ma = this.morningAlerts();

        if (this.isHydrated()) {
          this.scheduleSave();
        }
      });
    } catch {
      // Ignorar si se inicializa fuera de un contexto de inyección de Angular
    }

    this.restorePersistedState().catch((err) => {
      console.warn('[MockInventoryService] Error en restauración de estado:', err);
    });
  }

  getPersistedStateSnapshot(): PersistedAppState {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      activeUser: this.activeUser(),
      products: this.products(),
      creditCustomers: this.creditCustomers(),
      cashShift: this.cashShift(),
      cashRegister: this.cashRegister(),
      kardex: this.kardex(),
      shrinkRecords: this.shrinkRecords(),
      auditLines: this.auditLines(),
      internalConsumptionRecords: this.internalConsumptionRecords(),
      morningAlerts: this.morningAlerts(),
    };
  }

  scheduleSave(): void {
    if (!this.isHydrated()) return;
    this.storageSaver.schedule(async () => {
      try {
        await this.storageAdapter.save(STATE_STORAGE_KEY, this.getPersistedStateSnapshot());
      } catch (err) {
        console.warn('[MockInventoryService] Error guardando estado en almacenamiento diferido:', err);
      }
    });
  }

  async flushSave(): Promise<void> {
    await this.storageSaver.flush(async () => {
      try {
        await this.storageAdapter.save(STATE_STORAGE_KEY, this.getPersistedStateSnapshot());
      } catch (err) {
        console.warn('[MockInventoryService] Error en flushSave de almacenamiento:', err);
      }
    });
  }

  async restorePersistedState(): Promise<{ success: boolean; corrupted?: boolean; reason?: string }> {
    try {
      const raw = await this.storageAdapter.load(STATE_STORAGE_KEY);
      if (!raw) {
        this.isHydrated.set(true);
        return { success: true };
      }

      // 1. Migración de versión si procede
      const migration = migrateState(raw);
      const stateToValidate = migration.state;

      // 2. Validación de integridad estructural y de cadena Kardex
      const validation = validateStoredState(stateToValidate, (k) =>
        verifyKardexChain(k, 'newest-first')
      );
      if (!validation.valid) {
        const warnMsg = `Los datos guardados en el navegador estaban dañados (${validation.reason}). Se restauraron los datos iniciales de demostración.`;
        this.corruptedDataWarning.set(warnMsg);
        this.morningAlerts.update((prev) => [
          {
            id: 'ALERT-DATA-CORRUPT',
            kind: 'auditoria',
            icon: '⚠️',
            title: 'Datos restaurados a modo demostración',
            detail: warnMsg,
            actionLabel: 'Descartar aviso',
            route: '/',
          },
          ...prev.filter((a) => a.id !== 'ALERT-DATA-CORRUPT'),
        ]);
        this.isHydrated.set(true);
        await this.flushSave();
        return { success: false, corrupted: true, reason: validation.reason };
      }

      // 3. Hidratación del estado validado
      this.products.set(stateToValidate.products);
      this.creditCustomers.set(stateToValidate.creditCustomers);
      if (stateToValidate.cashShift) this.cashShift.set(stateToValidate.cashShift);
      if (stateToValidate.cashRegister) this.cashRegister.set(stateToValidate.cashRegister);
      if (stateToValidate.internalConsumptionRecords) {
        this.internalConsumptionRecords.set(stateToValidate.internalConsumptionRecords);
      }
      this.kardex.set(stateToValidate.kardex);
      this.shrinkRecords.set(stateToValidate.shrinkRecords);
      this.auditLines.set(stateToValidate.auditLines);
      if (stateToValidate.morningAlerts) this.morningAlerts.set(stateToValidate.morningAlerts);
      if (stateToValidate.activeUser) this.activeUser.set(stateToValidate.activeUser);

      this.isHydrated.set(true);

      if (migration.migrated) {
        await this.flushSave();
      }

      return { success: true };
    } catch (err: any) {
      const errMsg = `Error al leer almacenamiento local: ${err?.message || err}. Se usan datos de demostración.`;
      this.corruptedDataWarning.set(errMsg);
      this.isHydrated.set(true);
      return { success: false, corrupted: true, reason: errMsg };
    }
  }

  async resetToDemoData(): Promise<void> {
    this.storageSaver.cancel();
    await this.storageAdapter.clear();
    this.products.set(structuredClone(PRODUCTS));
    this.creditCustomers.set(structuredClone(CREDIT_CUSTOMERS));
    this.cashShift.set({
      openingCash: 500.0,
      cashSalesTotal: 0.0,
      creditPaymentsReceived: 0.0,
      creditSalesTotal: 0.0,
      internalConsumptionTotalCost: 0.0,
      shrinkTotalCost: 0.0,
    });
    this.cashRegister.set({
      openingFloat: 500.0,
      cashSalesTotal: 0.0,
      creditSalesTotal: 0.0,
      creditPaymentsReceived: 0.0,
    });
    this.internalConsumptionRecords.set([]);
    this.kardex.set(buildInitialKardex());
    this.morningAlerts.set(structuredClone(MORNING_ALERTS));
    this.auditLines.set(structuredClone(AUDIT_LINES));
    this.shrinkRecords.set(structuredClone(SHRINK_RECORDS));
    this.activeUser.set('Don Lupe (Encargado)');
    this.corruptedDataWarning.set(null);
    this.isHydrated.set(true);
    await this.flushSave();
  }

  private initLanSyncListener(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel('abarrotes_lan_sync');
        channel.onmessage = (event) => {
          this.handleIncomingLanMessage(event.data);
        };
      } catch (err) {
        console.warn('[MockInventoryService] Error en BroadcastChannel:', err);
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (ev: StorageEvent) => {
        if (ev.key === 'abarrotes_lan_last_event' && ev.newValue) {
          try {
            const data = JSON.parse(ev.newValue);
            this.handleIncomingLanMessage(data);
          } catch {
            // ignore
          }
        }
      });

      const winLan = typeof window !== 'undefined' ? (window as any).LanSync : undefined;
      if (winLan) {
        winLan.on('peers', (s: any) => {
          if (s && s.status !== 'unavailable') {
            this.phoneLinked.set(s.phones > 0);
          }
        });
        if (winLan.status !== 'unavailable') {
          this.phoneLinked.set(winLan.phones > 0);
        }
      }
    }
  }

  private handleIncomingLanMessage(data: any): void {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'MERMA_SUBMIT' && data.record) {
      this.addShrinkRecord(data.record);
    }
  }

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

  readonly kardex = signal<KardexEntry[]>(buildInitialKardex());

  readonly morningAlerts = signal<MorningAlert[]>(structuredClone(MORNING_ALERTS));
  readonly auditLines = signal<AuditLine[]>(structuredClone(AUDIT_LINES));
  readonly shrinkRecords = signal<ShrinkRecord[]>(structuredClone(SHRINK_RECORDS));
  readonly supplierRoutes = signal<SupplierRoute[]>(structuredClone(SUPPLIER_ROUTES));
  readonly perishableBatches = signal<PerishableBatch[]>(structuredClone(PERISHABLE_BATCHES));
  readonly blindAuditMission = signal<BlindAuditItem[]>([]);

  // ===================================================================
  // SEGURIDAD OPERACIONAL: PIN DE AUTORIZACIÓN (PBKDF2 >= 100,000 it.)
  // Control de autorización para piso de venta, no seguridad física de la PC.
  // ===================================================================
  readonly isPinSetupRequired = signal<boolean>(!isPinConfigured());
  readonly pinState = signal<PinAuthState>(loadPinState());

  /** Establece el PIN de administrador por primera vez (obligatorio en primer uso). */
  async setupInitialPin(newPin: string): Promise<{ success: boolean; message: string }> {
    try {
      await setupInitialPin(newPin);
      this.isPinSetupRequired.set(false);
      this.pinState.set(loadPinState());
      return { success: true, message: 'PIN de administrador configurado exitosamente.' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Error al configurar el PIN.' };
    }
  }

  /** Reconfigura el PIN de administrador. */
  async configureAdminPin(newPin: string): Promise<void> {
    await this.setupInitialPin(newPin);
  }

  /**
   * Verifica un intento de PIN con persistencia ante recarga de página (máx. 3 intentos y bloqueo 30s).
   * Registra quién autorizó la operación en el Kardex.
   */
  async verifyAdminPin(pin: string, authorizer?: string): Promise<PinVerificationResult> {
    const authUser = authorizer || this.activeUser();
    const result = await verifyPinAttempt(pin, undefined, Date.now(), authUser);
    this.pinState.set(loadPinState());
    return result;
  }

  /** Verifica la integridad de la cadena criptográfica completa del Kardex. */
  verifyKardexIntegrity(): { valid: boolean; errorIndex?: number; error?: string; tamperedEntryId?: string } {
    return verifyKardexChain(this.kardex(), 'newest-first');
  }

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

  // ---------- Getters para los Badges del Dashboard ----------
  /** Número de entradas con precios con margen caído pendientes. */
  getMarginDropAlertsCount(): number {
    return this.brokenMarginLinesCount();
  }

  /** Número de productos pendientes de contar hoy en auditoría. */
  getPendingAuditMissionCount(): number {
    return this.auditLines().filter((l) => l.status === 'pendiente' && l.countedQty !== l.systemQty).length;
  }

  /** Número de lotes que requieren cambio físico en las próximas 48h. */
  getUrgentFefoCount(): number {
    return this.getUpcomingFefoExchanges().length;
  }

  // ---------- Corte de Caja y Punto de Venta (POS) ----------

  /**
   * Devuelve el efectivo real que debe existir físicamente en el cajón:
   * openingCash ($500.00) + cashSalesTotal + creditPaymentsReceived
   */
  getRealDrawerCash(): number {
    const s = this.cashShift();
    return sumMoney([s.openingCash, s.cashSalesTotal, s.creditPaymentsReceived]);
  }

  /** Alias para compatibilidad con vistas y componentes existentes. */
  getExpectedDrawerCash(): number {
    return this.getRealDrawerCash();
  }

  /**
   * Procesa una venta en efectivo:
   * - Valida que el efectivo recibido cubra el total.
   * - Calcula el cambio exacto.
   * - Descuenta existencias en tiempo real con deductStock (permite stock negativo y registra faltantes reales).
   * - Suma a cashSalesTotal en el arqueo del cajón.
   * - Registra en Kardex como 'VENTA_EFECTIVO' (y 'FALTANTE_SISTEMA' con hash encadenado).
   */
  processCashSale(items: CartItem[], cashReceived: number): SaleResult {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', total: 0, change: 0 };
    }
    const total = sumMoney(items.map((item) => item.subtotal));
    if (cashReceived < total) {
      return {
        ok: false,
        message: `El efectivo recibido ($${cashReceived.toFixed(2)}) es menor al total a pagar ($${total.toFixed(2)}).`,
        total,
        change: 0,
      };
    }
    const change = subtractMoney(cashReceived, total);

    const shortageAlerts: MorningAlert[] = [];
    const newKardexEntries: KardexEntry[] = [];
    let currentHash = this.kardex()[0]?.entryHash || 'GENESIS';
    const currentUser = this.activeUser();

    this.products.update((list) =>
      list.map((p) => {
        const soldItem = items.find((i) => i.sku === p.sku);
        if (!soldItem) return p;

        const deduction = deductStock(p, soldItem.qty, {
          saleType: 'VENTA_EFECTIVO',
          usuario: currentUser,
          referencia: 'Venta Mostrador Efectivo',
          amount: soldItem.subtotal,
          description: `Venta en efectivo: ${soldItem.qty} ${p.saleUnit} de ${p.name}`,
          previousHash: currentHash,
        });

        for (const entry of deduction.kardexEntries) {
          newKardexEntries.push(entry);
          currentHash = entry.entryHash;
        }

        if (deduction.shortageAlert) {
          shortageAlerts.push(deduction.shortageAlert);
        }

        return deduction.updatedProduct;
      }),
    );

    // Actualizar totales de caja (Efectivo físico entra al cajón)
    this.cashShift.update((s) => ({
      ...s,
      cashSalesTotal: sumMoney([s.cashSalesTotal, total]),
    }));
    this.cashRegister.update((r) => ({
      ...r,
      cashSalesTotal: sumMoney([r.cashSalesTotal, total]),
    }));

    // Registrar en Kardex encadenado (el más reciente al frente)
    this.kardex.update((entries) => [...newKardexEntries.reverse(), ...entries]);

    if (shortageAlerts.length > 0) {
      this.morningAlerts.update((alerts) => [...shortageAlerts, ...alerts]);
    }

    this.scheduleSave();

    return {
      ok: true,
      message: `Venta cobrada con éxito. Cambio: $${change.toFixed(2)}`,
      total,
      change,
    };
  }

  /**
   * Procesa una venta cargada a la Libreta Digital de Fiado (Crédito Vecinal):
   * - Bloquea la venta si el cliente tiene estatus 'VENCIDO' (según applyCreditSalePure).
   * - Bloquea si la venta excede el límite de crédito disponible.
   * - Suma a creditSalesTotal (NO SUMA EFECTIVO AL CAJÓN: +$0.00).
   * - Descuenta existencias de inventario físico con deductStock.
   * - Registra en Kardex como 'VENTA_FIADO' (y 'FALTANTE_SISTEMA' con hash encadenado).
   */
  processCreditSale(items: CartItem[], customerId: string): CreditResult {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', total: 0 };
    }
    const total = sumMoney(items.map((item) => item.subtotal));
    const customer = this.creditCustomers().find((c) => c.id === customerId);
    if (!customer) {
      return { ok: false, message: 'Selecciona un cliente para cargar el fiado.', total };
    }

    const saleResult = applyCreditSalePure(customer, total, new Date());
    if (!saleResult.ok) {
      return {
        ok: false,
        message: saleResult.message,
        total,
        availableCredit: saleResult.availableCredit,
      };
    }

    // Actualizar cliente usando lógica pura
    this.creditCustomers.update((list) =>
      list.map((c) => (c.id === customerId ? saleResult.updatedCustomer! : c)),
    );

    // Sumar a crédito (NO ENTRA DINERO EN EFECTIVO AL CAJÓN)
    this.cashShift.update((s) => ({
      ...s,
      creditSalesTotal: sumMoney([s.creditSalesTotal, total]),
    }));
    this.cashRegister.update((r) => ({
      ...r,
      creditSalesTotal: sumMoney([r.creditSalesTotal, total]),
    }));

    const shortageAlerts: MorningAlert[] = [];
    const newKardexEntries: KardexEntry[] = [];
    let currentHash = this.kardex()[0]?.entryHash || 'GENESIS';
    const currentUser = this.activeUser();

    this.products.update((list) =>
      list.map((p) => {
        const soldItem = items.find((i) => i.sku === p.sku);
        if (!soldItem) return p;

        const deduction = deductStock(p, soldItem.qty, {
          saleType: 'VENTA_FIADO',
          usuario: currentUser,
          referencia: `Fiado Cliente ${customer.name}`,
          amount: soldItem.subtotal,
          description: `Fiado a ${customer.name}: ${soldItem.qty} ${p.saleUnit} de ${p.name}`,
          previousHash: currentHash,
        });

        for (const entry of deduction.kardexEntries) {
          newKardexEntries.push(entry);
          currentHash = entry.entryHash;
        }

        if (deduction.shortageAlert) {
          shortageAlerts.push(deduction.shortageAlert);
        }

        return deduction.updatedProduct;
      }),
    );

    this.kardex.update((entries) => [...newKardexEntries.reverse(), ...entries]);

    if (shortageAlerts.length > 0) {
      this.morningAlerts.update((alerts) => [...shortageAlerts, ...alerts]);
    }

    this.scheduleSave();

    return {
      ok: true,
      message: saleResult.message,
      total,
      availableCredit: saleResult.availableCredit,
    };
  }

  /**
   * Procesa el Consumo Interno (alimentos o suministros tomados para la tienda o comida del personal):
   * - Valida artículos y responsable obligatorio.
   * - Se valúa estrictamente al COSTO DE COMPRA, NO al precio de venta.
   * - No permite baja mayor que la existencia a menos que se autorice con PIN de administrador y motivo.
   * - Si se autoriza en negativo, FALTANTE_SISTEMA registra solo el déficit real que sobrepasó la existencia.
   * - No entra dinero al cajón de efectivo ($0.00).
   * - Registra en internalConsumptionRecords y Kardex encadenado como 'CONSUMO_INTERNO'.
   */
  async processInternalConsumption(
    items: CartItem[],
    responsible: string,
    pin?: string,
    reason?: string,
  ): Promise<{ ok: boolean; message: string; totalCost: number; remainingAttempts?: number; isLocked?: boolean }> {
    if (!items.length) {
      return { ok: false, message: 'El carrito está vacío.', totalCost: 0 };
    }
    const cleanResponsible = responsible?.trim() || this.activeUser();
    const catalog = this.products();

    // Validar si algún producto sobrepasa la existencia disponible
    const hasExceedingItems = items.some((item) => {
      const prod = catalog.find((p) => p.sku === item.sku);
      return prod ? item.qty > prod.stock : false;
    });

    let authorizer = cleanResponsible;
    if (hasExceedingItems) {
      if (!pin || !reason?.trim()) {
        return {
          ok: false,
          message: 'Baja bloqueada: la cantidad solicitada supera la existencia disponible en tienda. Requiere autorización con PIN de administrador y motivo justificado.',
          totalCost: 0,
        };
      }
      const pinResult = await this.verifyAdminPin(pin, cleanResponsible);
      if (!pinResult.success) {
        return {
          ok: false,
          message: pinResult.message,
          totalCost: 0,
          remainingAttempts: pinResult.remainingAttempts,
          isLocked: pinResult.isLocked,
        };
      }
      authorizer = pinResult.authorizedBy || cleanResponsible;
    }

    const detailedItems = items.map((item) => {
      const prod = catalog.find((p) => p.sku === item.sku);
      const unitCost =
        prod?.purchaseCost ??
        prod?.lastPurchaseCost ??
        prod?.weightedAvgCost ??
        prod?.historicCost ??
        multiplyMoney(item.unitPrice, 0.75);
      const subtotalCost = multiplyMoney(unitCost, item.qty);
      return {
        productId: item.sku,
        name: item.name,
        quantity: item.qty,
        unitCost: fromCents(toCents(unitCost)),
        subtotalCost,
      };
    });

    const totalCost = sumMoney(detailedItems.map((i) => i.subtotalCost));
    const shortageAlerts: MorningAlert[] = [];
    const newKardexEntries: KardexEntry[] = [];
    let currentHash = this.kardex()[0]?.entryHash || 'GENESIS';

    this.products.update((list) =>
      list.map((p) => {
        const consumed = items.find((i) => i.sku === p.sku);
        if (!consumed) return p;

        const disposal = deductStockForDisposal({
          product: p,
          qtyToDeduct: consumed.qty,
          type: 'CONSUMO_INTERNO',
          usuario: authorizer,
          referencia: `Consumo Interno autorizado por ${authorizer}`,
          adminPinAuthorized: hasExceedingItems,
          overrideReason: reason?.trim(),
          amount: multiplyMoney(consumed.unitPrice * 0.75, consumed.qty),
          description: `Consumo interno: ${consumed.qty} ${p.saleUnit} de ${p.name} (Valuado al Costo)`,
          previousHash: currentHash,
        });

        if (!disposal.ok || !disposal.updatedProduct) {
          return p;
        }

        if (disposal.kardexEntries) {
          for (const entry of disposal.kardexEntries) {
            newKardexEntries.push(entry);
            currentHash = entry.entryHash;
          }
        }

        if (disposal.shortageAlert) {
          shortageAlerts.push(disposal.shortageAlert);
        }

        return disposal.updatedProduct;
      }),
    );

    // Registrar en colección de consumos internos
    const record: InternalConsumptionRecord = {
      id: 'CI-' + generateKardexId().slice(2, 10),
      timestamp: new Date(),
      responsible: authorizer,
      items: detailedItems,
      totalCost,
    };
    this.internalConsumptionRecords.update((records) => [record, ...records]);

    // Sumar al total contable de consumos internos (Cajón de efectivo: +$0.00)
    this.cashShift.update((s) => ({
      ...s,
      internalConsumptionTotalCost: sumMoney([s.internalConsumptionTotalCost, totalCost]),
    }));

    // Registrar en Kardex encadenado (el más reciente al frente)
    this.kardex.update((entries) => [...newKardexEntries.reverse(), ...entries]);

    if (shortageAlerts.length > 0) {
      this.morningAlerts.update((alerts) => [...shortageAlerts, ...alerts]);
    }

    this.scheduleSave();

    return {
      ok: true,
      message: `Consumo interno registrado a cargo de ${authorizer} por un costo contable de $${totalCost.toFixed(2)}. Existencias descontadas sin entrada al cajón.`,
      totalCost,
    };
  }

  /**
   * Resuelve una alerta de faltante o stock en negativo realizando un ajuste físico autorizado con PIN.
   * Regla de negocio: Cuadra el stock al conteo físico real, registra AJUSTE_AUDITORIA en Kardex y limpia la alerta.
   */
  async resolveShortageAlertWithPin(
    alertId: string,
    sku: string,
    realPhysicalStock: number,
    pin: string,
    authorizerName = 'Administrador',
    reason = 'Ajuste físico de stock para resolver alerta de faltante',
  ): Promise<{ ok: boolean; message: string; remainingAttempts?: number; isLocked?: boolean }> {
    const pinResult = await this.verifyAdminPin(pin, authorizerName);
    if (!pinResult.success) {
      return {
        ok: false,
        message: pinResult.message,
        remainingAttempts: pinResult.remainingAttempts,
        isLocked: pinResult.isLocked,
      };
    }

    const prod = this.products().find((p) => p.sku === sku);
    if (!prod) {
      return { ok: false, message: `Producto con SKU ${sku} no encontrado.` };
    }

    const authorizer = pinResult.authorizedBy || authorizerName;
    return this.enqueueKardexOperation(() => {
      const previousHash = this.kardex()[0]?.entryHash || 'GENESIS';
      const { updatedProduct, kardexEntry } = resolveShortageAlertAdjustment(
        prod,
        realPhysicalStock,
        authorizer,
        alertId,
        previousHash,
      );

      // Actualizar existencia física en catálogo
      this.products.update((list) =>
        list.map((p) => (p.sku === sku ? updatedProduct : p)),
      );

      this.kardex.update((k) => [kardexEntry, ...k]);

      // Eliminar la alerta de morningAlerts
      this.morningAlerts.update((alerts) =>
        alerts.filter((a) => a.id !== alertId && !(a.id.includes(sku) && a.kind === 'por-agotarse')),
      );

      this.scheduleSave();

      return {
        ok: true,
        message: `Alerta resuelta: inventario de ${prod.name} cuadrado a ${realPhysicalStock} ${prod.saleUnit} por ${authorizer}.`,
      };
    });
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
      const total = sumMoney(items.map((item) => item.subtotal));
      const res = this.processCashSale(items, total);
      return { ok: res.ok, message: res.message, total: res.total };
    }
  }

  /**
   * Registra un abono en efectivo de un cliente de fiado:
   * - Aplica amortización FIFO pura con applyCreditPaymentPure (primero lo vencido, más antiguo primero).
   * - REGLA OBLIGATORIA: Un abono parcial NO debe limpiar el estatus VENCIDO si queda saldo con fecha vencida.
   * - Suma el dinero recibido a creditPaymentsReceived (¡SÍ ENTRA EFECTIVO FÍSICO AL CAJÓN!).
   * - Registra entrada en Kardex encadenada.
   */
  registerCreditPayment(customerId: string, amount: number): { ok: boolean; message: string } {
    if (isNaN(amount) || amount <= 0) {
      return { ok: false, message: 'Ingresa un monto de abono mayor a $0.00.' };
    }
    const customer = this.creditCustomers().find((c) => c.id === customerId);
    if (!customer) {
      return { ok: false, message: 'Cliente no encontrado.' };
    }

    const paymentResult = applyCreditPaymentPure(customer, amount, new Date());
    const applied = paymentResult.appliedAmount;
    if (applied <= 0) {
      return { ok: false, message: `${customer.name} no tiene deuda pendiente.` };
    }

    this.creditCustomers.update((list) =>
      list.map((c) => (c.id === customerId ? paymentResult.updatedCustomer : c)),
    );

    this.cashShift.update((s) => ({
      ...s,
      creditPaymentsReceived: sumMoney([s.creditPaymentsReceived, applied]),
    }));

    this.cashRegister.update((reg) => ({
      ...reg,
      creditPaymentsReceived: sumMoney([reg.creditPaymentsReceived, applied]),
    }));

    const previousHash = this.kardex()[0]?.entryHash || 'GENESIS';
    const entry = createKardexEntry({
      type: 'ABONO_FIADO',
      producto: { sku: customer.id, name: customer.name },
      cantidad: 0,
      saldoAnterior: customer.currentBalance,
      saldoResultante: paymentResult.updatedCustomer.currentBalance,
      usuario: this.activeUser(),
      referencia: `Abono deudor: ${customer.name}`,
      amount: applied,
      description: `Abono en efectivo recibido de ${customer.name}`,
    }, previousHash);

    this.kardex.update((entries) => [entry, ...entries]);

    this.scheduleSave();

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
    const line = buildLine(sku, qtyPurchase, multiplyMoney(costPerPurchaseUnit, qtyPurchase));
    const p = this.products().find((x) => x.sku === sku)!;
    line.salePrice = p.salePrice;
    line.historicCost = p.historicCost;
    return line;
  }

  /** Guarda la entrada: suma existencias, recalcula Costo Promedio Ponderado, actualiza reposición y genera Kardex encadenado. */
  saveReception(lines: ReceptionLine[], folio: string): void {
    const newKardexEntries: KardexEntry[] = [];
    const nowIso = new Date().toISOString();
    let currentHash = this.kardex()[0]?.entryHash || 'GENESIS';
    const currentUser = this.activeUser();

    this.products.update((list) =>
      list.map((p) => {
        const line = lines.find((l) => l.sku === p.sku);
        if (!line) return p;
        const incomingUnits = line.qtyPurchase * line.unitsPerPurchase;
        const saldoAnterior = p.stock;
        const newTotalStock = Math.round((saldoAnterior + incomingUnits) * 1000) / 1000;
        const newWeightedAvg =
          newTotalStock > 0
            ? fromCents(
                Math.round(
                  (toCents(p.stock * p.weightedAvgCost) + toCents(incomingUnits * line.newCost)) /
                    newTotalStock,
                ),
              )
            : line.newCost;

        const entry = createKardexEntry({
          type: 'ENTRADA_COMPRA',
          producto: { sku: p.sku, name: p.name, saleUnit: p.saleUnit },
          cantidad: incomingUnits,
          saldoAnterior,
          saldoResultante: newTotalStock,
          usuario: currentUser,
          referencia: `Nota #${folio}`,
          timestamp: nowIso,
          amount: line.lineTotal,
          description: `Entrada compra Nota #${folio}: +${incomingUnits} ${p.saleUnit} de ${p.name}`,
        }, currentHash);

        newKardexEntries.push(entry);
        currentHash = entry.entryHash;

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

    this.kardex.update((k) => [...newKardexEntries.reverse(), ...k]);

    if (folio === this.ocrNote()?.folio) {
      this.ocrNote.set(null);
      this.morningAlerts.update((a) => a.filter((x) => x.kind !== 'margen'));
    }
    this.lastSavedNote.set(folio);
    this.scheduleSave();
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
    this.scheduleSave();
  }

  // ---------- Mermas ----------

  addShrinkRecord(record: ShrinkRecord): void {
    if (!record || !record.id) return;
    const cleanRecord: ShrinkRecord = {
      ...record,
      emoji: record.emoji || this.products().find((p) => p.sku === record.sku)?.emoji || '📦',
    };
    const prev = this.shrinkRecords();
    const next = addShrinkRecordIdempotent(prev, cleanRecord);
    if (next.length === prev.length) {
      return; // Ya existía en la lista (duplicado ignorado)
    }
    this.shrinkRecords.set(next);
    this.cashShift.update((s) => ({
      ...s,
      shrinkTotalCost: sumMoney([s.shrinkTotalCost, multiplyMoney(record.unitCost, record.qty)]),
    }));
    this.scheduleSave();
  }

  /**
   * Marca una merma como revisada/aprobada.
   * Regla de negocio: No permite baja mayor que la existencia disponible sin PIN de administrador y motivo.
   */
  markShrinkReviewed(
    id: string,
    authorizedBy = 'Administrador (PIN)',
    pin?: string,
    reason?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const record = this.shrinkRecords().find((r) => r.id === id);
    if (!record) return Promise.resolve({ ok: false, message: 'Registro de merma no encontrado.' });

    const prod = this.products().find((p) => p.sku === record.sku);
    if (!prod) return Promise.resolve({ ok: false, message: `Producto ${record.sku} no encontrado en catálogo.` });

    const currentStock = prod.stock;
    const isExceeding = record.qty > currentStock;

    if (isExceeding) {
      if (!pin || !reason?.trim()) {
        return Promise.resolve({
          ok: false,
          message: `Baja de merma bloqueada: la cantidad (${record.qty}) supera la existencia disponible (${currentStock}). Requiere PIN de administrador y motivo justificado.`,
        });
      }
    }

    return this.enqueueKardexOperation(async () => {
      if (isExceeding && pin) {
        const pinCheck = await this.verifyAdminPin(pin, authorizedBy);
        if (!pinCheck.success) {
          return { ok: false, message: pinCheck.message };
        }
      }

      const previousHash = this.kardex()[0]?.entryHash || 'GENESIS';
      const disposal = deductStockForDisposal({
        product: prod,
        qtyToDeduct: record.qty,
        type: 'BAJA_MERMA',
        usuario: authorizedBy,
        referencia: `Aprobación merma #${record.id}`,
        adminPinAuthorized: isExceeding,
        overrideReason: reason?.trim(),
        amount: multiplyMoney(record.unitCost, record.qty),
        description: `Baja de merma #${record.id} aprobada por ${authorizedBy}: ${record.qty} ${record.saleUnit} de ${record.name}`,
        previousHash,
      });

      if (!disposal.ok || !disposal.updatedProduct) {
        return { ok: false, message: disposal.message };
      }

      this.products.update((list) =>
        list.map((p) => (p.sku === record.sku ? disposal.updatedProduct! : p)),
      );

      this.shrinkRecords.update((list) =>
        list.map((r) =>
          r.id === id
            ? { ...r, reviewed: true, registeredBy: `${r.registeredBy} | Aprobó: ${authorizedBy}` }
            : r,
        ),
      );

      if (disposal.kardexEntries) {
        this.kardex.update((k) => [...disposal.kardexEntries!.reverse(), ...k]);
      }

      this.scheduleSave();

      return {
        ok: true,
        message: `Merma #${record.id} aprobada con éxito por ${authorizedBy}.`,
      };
    });
  }

  /**
   * Aprueba la baja de merma validando obligatoriamente el PIN de administrador con Web Crypto PBKDF2.
   * Regla de negocio: Máximo 3 intentos y bloqueo de 30 segundos. Registra quién autorizó en el Kardex.
   */
  async authorizeShrinkReview(
    shrinkRecordId: string,
    pin: string,
    authorizerName = 'Administrador',
    reason = 'Autorización de baja por merma',
  ): Promise<{ ok: boolean; message: string; remainingAttempts?: number; isLocked?: boolean }> {
    const pinResult = await this.verifyAdminPin(pin, authorizerName);
    if (!pinResult.success) {
      return {
        ok: false,
        message: pinResult.message,
        remainingAttempts: pinResult.remainingAttempts,
        isLocked: pinResult.isLocked,
      };
    }
    const authorizer = pinResult.authorizedBy || authorizerName;
    const res = await this.markShrinkReviewed(shrinkRecordId, authorizer, pin, reason);
    return {
      ok: res.ok,
      message: res.message,
      remainingAttempts: pinResult.remainingAttempts,
      isLocked: false,
    };
  }

  // ---------- Agenda de Rutas y FEFO ----------

  /**
   * Retorna los lotes que deben retirarse hoy según el proveedor que visita mañana o en 48h.
   */
  getUpcomingFefoExchanges(): {
    batch: PerishableBatch;
    supplier?: SupplierRoute;
    urgent: boolean;
    nextVisitText: string;
  }[] {
    const suppliers = this.supplierRoutes();
    return this.perishableBatches()
      .filter((b) => b.status === 'POR_VENCER' || b.status === 'VENCIDO')
      .map((batch) => {
        const supplier = suppliers.find((s) => s.id === batch.supplierId);
        return {
          batch,
          supplier,
          urgent: true,
          nextVisitText: supplier ? `Visita: ${supplier.visitDays.join(', ')}` : 'Visita próxima',
        };
      });
  }

  /**
   * Resuelve el cambio físico:
   * - CAMBIO_EFECTIVO: actualiza la caducidad sin alterar costos contables.
   * - MERMA_RECHAZADA: descuenta a merma al costo contable con deductStockForDisposal (bloquea si excede stock sin PIN).
   */
  resolvePhysicalExchange(
    batchId: string,
    action: 'CAMBIO_EFECTIVO' | 'MERMA_RECHAZADA',
    newExpiryDate?: string,
    pin?: string,
    reason?: string,
  ): { ok: boolean; message: string } {
    const batch = this.perishableBatches().find((b) => b.batchId === batchId);
    if (!batch) return { ok: false, message: 'Lote no encontrado' };

    if (action === 'CAMBIO_EFECTIVO') {
      const nextDate = newExpiryDate || '2026-11-28';
      this.perishableBatches.update((list) =>
        list.map((b) => (b.batchId === batchId ? { ...b, expiryDate: nextDate, status: 'OPTIMO' } : b)),
      );
      return {
        ok: true,
        message: `Cambio físico exitoso de ${batch.quantity} piezas de ${batch.productName}. Nueva caducidad: ${nextDate}. Sin afectación a costos.`,
      };
    } else {
      const product = this.products().find((p) => p.sku === batch.productId);
      const currentStock = product ? product.stock : 0;
      const isExceeding = batch.quantity > currentStock;

      if (isExceeding && (!pin || !reason?.trim())) {
        return {
          ok: false,
          message: `Baja de merma bloqueada: la cantidad (${batch.quantity}) supera la existencia en tienda (${currentStock}). Requiere PIN de administrador y motivo.`,
        };
      }

      this.perishableBatches.update((list) =>
        list.map((b) => (b.batchId === batchId ? { ...b, status: 'VENCIDO' } : b)),
      );

      const unitCost = product ? product.historicCost : 25;
      const totalLoss = multiplyMoney(unitCost, batch.quantity);

      if (product) {
        const previousHash = this.kardex()[0]?.entryHash || 'GENESIS';
        const disposal = deductStockForDisposal({
          product,
          qtyToDeduct: batch.quantity,
          type: 'BAJA_MERMA',
          usuario: this.activeUser(),
          referencia: `Merma lote ${batch.batchId}`,
          adminPinAuthorized: isExceeding,
          overrideReason: reason?.trim(),
          amount: totalLoss,
          description: `Merma rechazada FEFO: ${batch.quantity}x ${batch.productName} ($${totalLoss.toFixed(2)})`,
          previousHash,
        });

        if (!disposal.ok || !disposal.updatedProduct) {
          return { ok: false, message: disposal.message };
        }

        this.products.update((list) =>
          list.map((p) => (p.sku === batch.productId ? disposal.updatedProduct! : p)),
        );

        if (disposal.kardexEntries) {
          this.kardex.update((k) => [...disposal.kardexEntries!.reverse(), ...k]);
        }
      }

      const now = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
      this.shrinkRecords.update((list) => [
        {
          id: 'M-' + generateKardexId().slice(2, 10),
          date: '22/10/2026',
          time: now,
          sku: batch.productId,
          name: batch.productName,
          emoji: '',
          qty: batch.quantity,
          saleUnit: product ? product.saleUnit : 'Pieza',
          reason: 'Caducado sin devolución',
          unitCost,
          registeredBy: `${this.activeUser()} (Módulo FEFO)`,
          hasPhoto: false,
          reviewed: true,
        },
        ...list,
      ]);

      this.cashShift.update((s) => ({
        ...s,
        shrinkTotalCost: sumMoney([s.shrinkTotalCost, totalLoss]),
      }));

      this.scheduleSave();

      return {
        ok: true,
        message: `Cambio rechazado por proveedor. Se mandaron ${batch.quantity} piezas a merma por $${totalLoss.toFixed(2)} al costo.`,
      };
    }
  }

  // ---------- Recepción y Alta Rápida de Productos ----------

  /**
   * Da de alta al instante un producto no registrado en la nota de proveedor con redondeo comercial.
   */
  registerNewQuickProduct(
    name: string,
    category: string,
    isBulk: boolean,
    purchaseCost: number,
    targetMargin: number,
    saleUnit: SaleUnit = isBulk ? 'Kg' : 'Pieza',
    purchaseUnit: PurchaseUnit = isBulk ? 'Costal' : 'Pieza',
  ): Product {
    const cleanName = name.trim();
    const sku =
      cleanName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '-')
        .slice(0, 10) +
      '-' +
      String(Date.now()).slice(-3);

    const barcode = isBulk
      ? '200' + String(Date.now()).slice(-10)
      : '750' + String(Date.now()).slice(-10);

    const salePrice = calculateCommercialRound(purchaseCost / (1 - (targetMargin || 20) / 100));

    const newProd: Product = {
      sku,
      barcode,
      name: cleanName,
      category: category || 'Abarrotes',
      emoji: '',
      purchaseUnit,
      unitsPerPurchase: 1,
      saleUnit,
      historicCost: purchaseCost,
      purchaseCost,
      newCost: purchaseCost,
      weightedAvgCost: purchaseCost,
      lastPurchaseCost: purchaseCost,
      salePrice,
      targetMargin: targetMargin || 20,
      monthlySalesUnits: 30,
      expiry: '2027-12-31',
      fefoExpiryDate: '2027-12-31',
      acceptsPhysicalExchange: false,
      stock: 0,
      minStock: 5,
      abcClass: 'B',
      dailySalesRate: 1,
      supplierLeadTimeDays: 3,
      safetyStock: 2,
      rop: calculateROP(1, 3, 2),
      isBulk,
      supplier: 'Proveedor General',
    };

    this.products.update((list) => [newProd, ...list]);
    return newProd;
  }

  // ---------- Auditoría Ciega Exprés ----------

  /**
   * Genera una lista de 15 productos (10 Clase A, 4 Clase B, 1 Clase C) omitiendo el stock del sistema.
   */
  generateDailyBlindAuditMission(): BlindAuditItem[] {
    const prods = this.products();
    const classA = prods.filter((p) => p.abcClass === 'A').slice(0, 10);
    const classB = prods.filter((p) => p.abcClass === 'B').slice(0, 4);
    const classC = prods.filter((p) => p.abcClass === 'C').slice(0, 1);
    const selected = [...classA, ...classB, ...classC];

    const locations: Record<string, string> = {
      Lácteos: 'Refrigerador 1 · Puerta 1',
      Aceites: 'Anaquel B · Repisa 2',
      Granos: 'Piso · Báscula',
      Enlatados: 'Anaquel B · Repisa 3',
      Bebidas: 'Refrigerador 2',
      Panadería: 'Isla Central',
      Pastas: 'Anaquel C · Repisa 1',
      Limpieza: 'Anaquel D · Repisa 4',
    };

    return selected.map((p) => ({
      sku: p.sku,
      barcode: p.barcode,
      name: p.name,
      category: p.category,
      saleUnit: p.saleUnit,
      location: locations[p.category] || 'Pasillo 3',
      unitCost: p.historicCost,
      countedQty: undefined,
      completed: false,
    }));
  }

  /**
   * Compara el conteo físico vs el stock teórico y calcula la diferencia en piezas y pesos ($).
   */
  submitBlindAuditResults(counts: { sku: string; countedQty: number }[]): void {
    const newAuditLines: AuditLine[] = counts.map((c) => {
      const p = this.products().find((x) => x.sku === c.sku);
      const systemQty = p ? p.stock : 0;
      const unitCost = p ? p.historicCost : 10;
      const name = p ? p.name : c.sku;
      const saleUnit = p ? p.saleUnit : 'Pieza';
      return {
        sku: c.sku,
        name,
        emoji: '',
        location: 'Pasillo 3 · Auditoría Ciega Móvil',
        saleUnit,
        systemQty,
        countedQty: c.countedQty,
        unitCost,
        status: 'pendiente' as AuditStatus,
      };
    });

    this.auditLines.set(newAuditLines);
    this.morningAlerts.update((alerts) => [
      ...alerts.filter((a) => a.kind !== 'auditoria'),
      {
        id: 'A-BLIND-' + Date.now(),
        kind: 'auditoria',
        icon: '',
        title: `Llegó auditoría ciega de 15 productos desde el celular`,
        detail: `Revisa las diferencias encontradas antes de cuadrar stock.`,
        actionLabel: 'Revisar auditoría',
        route: '/auditoria',
      },
    ]);
  }

  /**
   * Cuadra el stock al conteo físico en una sola transacción:
   * - MERMA_OPERATIVA: merma normal granel/corte.
   * - FALTANTE_INJUSTIFICADO: pérdida o extravío no justificado.
   * - Registra en Kardex quién autorizó el ajuste.
   */
  applySquareAdjustment(
    productId: string,
    type: 'MERMA_OPERATIVA' | 'FALTANTE_INJUSTIFICADO',
    authorizedBy = 'Administrador (PIN)',
  ): { ok: boolean; message: string } {
    const line = this.auditLines().find((l) => l.sku === productId);
    if (!line) return { ok: false, message: 'Producto no encontrado en auditoría' };

    const diffQty = Math.round((line.countedQty - line.systemQty) * 1000) / 1000;
    const diffMoney = multiplyMoney(line.unitCost, diffQty);

    // 1. Cuadrar stock en catálogo
    this.products.update((list) =>
      list.map((p) => (p.sku === productId ? { ...p, stock: line.countedQty } : p)),
    );

    // 2. Marcar auditoría como autorizada
    this.auditLines.update((list) =>
      list.map((l) => (l.sku === productId ? { ...l, status: 'autorizado' as AuditStatus } : l)),
    );

    // 3. Registrar Kardex encadenado
    const typeLabel =
      type === 'MERMA_OPERATIVA'
        ? 'Merma Normal Granel/Corte'
        : 'Faltante Injustificado';

    const previousHash = this.kardex()[0]?.entryHash || 'GENESIS';
    this.kardex.update((k) => [
      createKardexEntry({
        type: 'AJUSTE_AUDITORIA',
        producto: { sku: line.sku, name: line.name, saleUnit: line.saleUnit },
        cantidad: diffQty,
        saldoAnterior: line.systemQty,
        saldoResultante: line.countedQty,
        usuario: authorizedBy,
        referencia: `Auditoría Ciega [${typeLabel}] - ${line.sku}`,
        amount: Math.abs(diffMoney),
        description: `Ajuste Auditoría [${typeLabel}]: ${line.name} (Dif: ${diffQty > 0 ? '+' : ''}${diffQty} ${line.saleUnit}, $${Math.abs(diffMoney).toFixed(2)})`,
      }, previousHash),
      ...k,
    ]);

    // 4. Si fue faltante (diffQty < 0), computar merma
    if (diffQty < 0) {
      const loss = Math.abs(diffMoney);
      this.cashShift.update((s) => ({
        ...s,
        shrinkTotalCost: sumMoney([s.shrinkTotalCost, loss]),
      }));
      this.shrinkRecords.update((list) => [
        {
          id: 'M-' + generateKardexId().slice(2, 10),
          date: '22/10/2026',
          time: new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }),
          sku: line.sku,
          name: line.name,
          emoji: '',
          qty: Math.abs(diffQty),
          saleUnit: line.saleUnit,
          reason: type === 'MERMA_OPERATIVA' ? 'Envase Roto en Piso' : 'Caducado sin devolución',
          unitCost: line.unitCost,
          registeredBy: `Auditoría Ciega (${typeLabel}) - Aut: ${authorizedBy}`,
          hasPhoto: false,
          reviewed: true,
        },
        ...list,
      ]);
    }

    this.scheduleSave();

    return {
      ok: true,
      message: `Stock cuadrado a ${line.countedQty} ${line.saleUnit}. Kardex actualizado como ${typeLabel} por ${authorizedBy}.`,
    };
  }

  /**
   * Cuadra el stock verificando el PIN de administrador con Web Crypto API.
   * Regla de negocio: Máximo 3 intentos y bloqueo de 30 segundos. Registra quién autorizó en el Kardex.
   */
  async authorizeAndApplySquareAdjustment(
    productId: string,
    type: 'MERMA_OPERATIVA' | 'FALTANTE_INJUSTIFICADO',
    pin: string,
    authorizerName = 'Administrador',
  ): Promise<{ ok: boolean; message: string; remainingAttempts?: number; isLocked?: boolean }> {
    const pinResult = await this.verifyAdminPin(pin, authorizerName);
    if (!pinResult.success) {
      return {
        ok: false,
        message: pinResult.message,
        remainingAttempts: pinResult.remainingAttempts,
        isLocked: pinResult.isLocked,
      };
    }
    const authorizer = pinResult.authorizedBy || authorizerName;
    const res = this.applySquareAdjustment(productId, type, authorizer);
    return {
      ok: true,
      message: res.message,
      remainingAttempts: pinResult.remainingAttempts,
      isLocked: false,
    };
  }
}
