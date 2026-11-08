/**
 * Lógica pura de dominio para el Módulo de Catálogo (Bloque F1):
 * - Alta, edición y baja lógica de productos (bloqueo de borrado físico si tiene movimientos).
 * - Autogeneración de SKU interno editable y códigos de barras internos EAN-13 (prefijo 200).
 * - Validación de múltiples códigos de barras por producto sin duplicados en el catálogo.
 * - Conversión de unidades de compra a unidades de venta (ej. caja de 24, bulto de 50 kg, kg a g).
 * - Precios escalonados (menudeo, medio mayoreo, mayoreo con cantidad mínima).
 * - Descuentos por línea y por ticket en centavos enteros con tope configurable y exigencia de PIN.
 * - Tolerancia de merma natural en granel (% por producto) para clasificar conteos de auditoría.
 * - Validación e idempotencia para alta remota desde móvil (PRODUCT_CREATE_REQUEST).
 */

export const DEFAULT_MAX_DISCOUNT_PCT_WITHOUT_PIN = 10;

export type CatalogSaleUnit = 'Pieza' | 'Kg' | 'g' | 'L' | 'Lata' | 'Paquete';
export type CatalogPurchaseUnit =
  | 'Caja'
  | 'Bulto'
  | 'Costal'
  | 'Paquete'
  | 'Charola'
  | 'Pieza'
  | 'Kg'
  | 'g'
  | 'L'
  | 'Lata';

export type PriceTierCode = 'MENUDEO' | 'MEDIO_MAYOREO' | 'MAYOREO';

export interface ProductPriceTier {
  tier: PriceTierCode;
  label: string;
  minQty: number;
  unitPrice: number; // En pesos MXN (operado en centavos enteros)
  appliedTier?: PriceTierCode;
  tierLabel?: string;
}
export type PriceTier = ProductPriceTier;

export type AuditVarianceClassification =
  | 'SIN_DIFERENCIA'
  | 'MERMA_NATURAL'
  | 'FALTANTE'
  | 'SOBRANTE';
export type ShrinkVarianceClassification = AuditVarianceClassification;

export interface NaturalShrinkEvaluation {
  classification: AuditVarianceClassification;
  label: string;
  classificationLabel: string;
  diffQty: number;
  missingQty: number;
  missingPct: number;
  tolerancePct: number;
  maxAllowedShrinkQty: number;
  maxNaturalLossQty: number;
  isWithinNaturalTolerance: boolean;
  isWithinTolerance: boolean;
}
export type ShrinkToleranceEvaluation = NaturalShrinkEvaluation;

export interface CatalogUpsertInput {
  sku?: string;
  name: string;
  category: string;
  location?: string;
  barcode?: string;
  barcodes?: string[];
  hasInternalBarcode?: boolean;
  useInternalBarcode?: boolean;
  generateInternalCodeIfMissing?: boolean;
  saleUnit: CatalogSaleUnit;
  purchaseUnit: CatalogPurchaseUnit;
  unitsPerPurchase: number;
  cost?: number; // Costo por unidad de venta (o calculado desde paquete)
  unitCost?: number; // Alias de cost
  packageCost?: number; // Costo por unidad de compra opcional
  salePrice: number;
  targetMargin?: number;
  ivaRate?: number; // Ej. 0.16 o 16 para 16%
  iepsRate?: number; // Ej. 0.08 o 8 para 8%
  expiry?: string;
  minStock?: number;
  rop?: number;
  safetyStock?: number;
  dailySalesRate?: number;
  supplierLeadTimeDays?: number;
  initialStock?: number;
  isBulk?: boolean;
  naturalShrinkTolerancePct?: number;
  priceTiers?: Partial<ProductPriceTier>[];
  supplier?: string;
  acceptsPhysicalExchange?: boolean;
  nextVisitInfo?: string;
  abcClass?: 'A' | 'B' | 'C';
  emoji?: string;
  pin?: string;
}
export type CatalogProductInput = CatalogUpsertInput;

export interface BarcodeValidationResult {
  valid: boolean;
  normalizedBarcodes: string[];
  duplicateBarcode?: string;
  conflictingSku?: string;
  conflictingName?: string;
  error?: string;
  message?: string;
}

export interface CatalogValidationResult {
  valid: boolean;
  errors: string[];
  error?: string;
  message: string;
  normalizedBarcodes: string[];
  resolvedSku: string;
  hasInternalBarcode: boolean;
}

export interface CartLineDiscountInput {
  sku: string;
  name?: string;
  qty: number;
  unitPrice: number; // Precio unitario ya considerando el escalón (tier) activo
  baseUnitPrice?: number; // Precio Menudeo base original para evaluar el total descontado vs. menudeo
  discountPct?: number; // 0..100
  discountAmountPesos?: number; // Descuento fijo opcional en pesos para la línea
}

export interface EvaluatedCartLine {
  sku: string;
  qty: number;
  unitPrice: number;
  baseUnitPrice: number;
  grossSubtotal: number;
  grossCents: number;
  retailGrossCents: number;
  lineDiscountAmount: number;
  lineDiscountCents: number;
  lineDiscountPctEffective: number;
  netSubtotalAfterLineDiscount: number;
  netAfterLineCents: number;
  finalAllocatedAmount: number; // Importe neto final tras prorratear descuento de ticket (en pesos exactos)
  finalNetCents: number;
  exceedsLineCap: boolean;
}

export interface CartDiscountEvaluation {
  lines: EvaluatedCartLine[];
  grossTotal: number;
  grossSubtotalCents: number;
  retailGrossTotal: number;
  retailGrossSubtotalCents: number;
  totalLineDiscounts: number;
  lineDiscountsTotalCents: number;
  subtotalAfterLineDiscounts: number;
  ticketDiscountPct: number;
  ticketDiscountAmount: number;
  ticketDiscountCents: number;
  totalDiscountAmount: number;
  totalDiscountCents: number;
  totalDiscountVsRetailAmount: number;
  totalDiscountVsRetailCents: number;
  effectiveTotalDiscountPct: number;
  effectiveDiscountPct: number;
  effectiveDiscountVsRetailPct: number;
  finalTotal: number;
  finalTotalCents: number;
  maxDiscountPctWithoutPin: number;
  requiresPin: boolean;
  reasons: string[];
  pinReason?: string;
}

export interface MobileProductCreatePayload {
  type?: string;
  requestId?: string;
  barcode: string;
  name: string;
  salePrice: number;
  cost: number;
  saleUnit: CatalogSaleUnit;
  category?: string;
}
export type MobileProductCreateRequest = MobileProductCreatePayload;

// =====================================================================
//  HELPERS DE CENTAVOS ENTEROS (SIN PUNTO FLOTANTE)
// =====================================================================

function toCentsInt(amount: number): number {
  if (typeof amount !== 'number' || Number.isNaN(amount) || !Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * 100);
}

function fromCentsInt(cents: number): number {
  if (typeof cents !== 'number' || Number.isNaN(cents) || !Number.isFinite(cents)) {
    return 0;
  }
  return Math.round(cents) / 100;
}

// =====================================================================
//  SKU INTERNO Y CÓDIGOS DE BARRAS EAN-13 INTERNOS
// =====================================================================

function sanitizeCodeToken(text: string, fallback = 'GEN', maxLen = 3): string {
  const clean = (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!clean) return fallback;
  return clean.slice(0, maxLen).padEnd(maxLen, 'X');
}

/**
 * Autogenera un SKU interno legible (ej. "LAC-LEC-001") garantizando que no exista colisión.
 */
export function generateInternalSku(
  name: string,
  category = 'General',
  existingSkus: Iterable<string> = []
): string {
  const taken = new Set(Array.from(existingSkus, (s) => String(s).trim().toUpperCase()));
  const catPrefix = sanitizeCodeToken(category, 'CAT', 3);

  const words = (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, ''))
    .filter((w) => w.length >= 2 && !['DE', 'LA', 'EL', 'EN', 'CON', 'PARA'].includes(w));

  const namePrefix =
    words.length > 0 ? sanitizeCodeToken(words[0], 'PRD', 3) : sanitizeCodeToken(name, 'PRD', 3);

  const secondToken =
    words.length > 1 ? sanitizeCodeToken(words[1], '01', 3) : '';

  if (secondToken) {
    const candidateDescriptive = `${catPrefix}-${namePrefix}-${secondToken}`;
    if (!taken.has(candidateDescriptive)) {
      return candidateDescriptive;
    }
  }

  for (let seq = 1; seq <= 9999; seq++) {
    const numStr = String(seq).padStart(3, '0');
    const candidate = `${catPrefix}-${namePrefix}-${numStr}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  return `${catPrefix}-${namePrefix}-${Date.now().toString().slice(-4)}`;
}

/**
 * Calcula el dígito verificador EAN-13 (módulo 10 GS1) para los primeros 12 dígitos.
 */
export function computeEan13CheckDigit(first12Digits: string): string {
  const clean = String(first12Digits).replace(/\D/g, '').slice(0, 12).padEnd(12, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(clean[i]) || 0;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = sum % 10;
  const check = mod === 0 ? 0 : 10 - mod;
  return String(check);
}

/**
 * Genera un código de barras interno EAN-13 con prefijo 200 para productos sin código de fábrica.
 */
export function generateInternalBarcode(
  existingBarcodes: Iterable<string> = [],
  sequenceStart = 1
): string {
  const taken = new Set(Array.from(existingBarcodes, (b) => String(b).trim()));
  for (let seq = Math.max(1, sequenceStart); seq <= 999_999; seq++) {
    const body = `200${String(seq).padStart(9, '0')}`; // 12 dígitos
    const full = `${body}${computeEan13CheckDigit(body)}`;
    if (!taken.has(full)) {
      return full;
    }
  }
  const fallback12 = `200${String(Date.now()).slice(-9).padStart(9, '0')}`;
  return `${fallback12}${computeEan13CheckDigit(fallback12)}`;
}

/**
 * Devuelve todos los códigos de barras asociados a un producto (principal + secundarios),
 * limpios y sin duplicados internos.
 */
export function getAllProductBarcodes(product: {
  barcode?: string;
  barcodes?: readonly string[];
}): string[] {
  const rawList: string[] = [];
  if (product.barcode && String(product.barcode).trim()) {
    rawList.push(String(product.barcode).trim());
  }
  if (Array.isArray(product.barcodes)) {
    for (const code of product.barcodes) {
      const clean = String(code || '').trim();
      if (clean) rawList.push(clean);
    }
  }
  return Array.from(new Set(rawList));
}

/**
 * Valida que ningún código de barras de `candidateBarcodes` esté repetido en otro producto del catálogo.
 */
export function validateBarcodeUniqueness(
  candidateBarcodes: readonly string[],
  existingProducts: readonly {
    sku: string;
    name: string;
    barcode?: string;
    barcodes?: readonly string[];
  }[],
  excludeSku?: string
): BarcodeValidationResult {
  const normalized: string[] = [];
  const seenInSelf = new Set<string>();
  const normExclude = excludeSku ? excludeSku.trim().toUpperCase() : '';

  for (const raw of candidateBarcodes) {
    const clean = String(raw || '').trim();
    if (!clean) continue;
    if (seenInSelf.has(clean)) {
      const errMsg = `El código de barras duplicado ${clean} está repetido dentro del mismo producto.`;
      return {
        valid: false,
        normalizedBarcodes: normalized,
        duplicateBarcode: clean,
        conflictingSku: excludeSku,
        error: errMsg,
        message: errMsg,
      };
    }
    seenInSelf.add(clean);
    normalized.push(clean);
  }

  for (const prod of existingProducts) {
    if (!prod || !prod.sku) continue;
    if (normExclude && prod.sku.trim().toUpperCase() === normExclude) {
      continue;
    }
    const prodCodes = getAllProductBarcodes(prod);
    for (const candidate of normalized) {
      if (prodCodes.includes(candidate)) {
        const errMsg = `Código de barras duplicado: ${candidate} ya está asignado al producto "${prod.name}" (${prod.sku}).`;
        return {
          valid: false,
          normalizedBarcodes: normalized,
          duplicateBarcode: candidate,
          conflictingSku: prod.sku,
          conflictingName: prod.name,
          error: errMsg,
          message: errMsg,
        };
      }
    }
  }

  return {
    valid: true,
    normalizedBarcodes: normalized,
  };
}

// =====================================================================
//  CONVERSIÓN DE UNIDADES DE COMPRA A VENTA E IMPUESTOS
// =====================================================================

/**
 * Calcula el factor de conversión efectivo entre la unidad de compra y la unidad de venta.
 */
export function resolveConversionFactor(
  unitsPerPurchase: number,
  purchaseUnit?: CatalogPurchaseUnit | string,
  saleUnit?: CatalogSaleUnit | string
): number {
  const rawFactor = Number(unitsPerPurchase);
  if (Number.isFinite(rawFactor) && rawFactor > 0) {
    if (rawFactor === 1 && purchaseUnit === 'Kg' && saleUnit === 'g') {
      return 1000;
    }
    return Math.round(rawFactor * 1000) / 1000;
  }
  if (purchaseUnit === 'Kg' && saleUnit === 'g') {
    return 1000;
  }
  return 1;
}

/**
 * Convierte una cantidad comprada (ej. 2 cajas de 24, o 1 bulto de 50 kg) a unidades de venta.
 */
export function convertPurchaseToSaleQty(
  purchaseQty: number,
  unitsPerPurchase: number,
  purchaseUnit?: CatalogPurchaseUnit | string,
  saleUnit?: CatalogSaleUnit | string
): number {
  if (!Number.isFinite(purchaseQty) || purchaseQty <= 0) return 0;
  const factor = resolveConversionFactor(unitsPerPurchase, purchaseUnit, saleUnit);
  return Math.round(purchaseQty * factor * 1000) / 1000;
}

/**
 * Calcula el costo por unidad de venta a partir del costo por unidad de compra (ej. caja o bulto)
 * operando en centavos enteros con redondeo Half-Up.
 */
export function calculateUnitCostFromPurchasePackage(
  packageCostPesos: number,
  unitsPerPurchase: number,
  purchaseUnit?: CatalogPurchaseUnit | string,
  saleUnit?: CatalogSaleUnit | string
): number {
  const factor = resolveConversionFactor(unitsPerPurchase, purchaseUnit, saleUnit);
  if (factor <= 0) return 0;
  const packageCents = toCentsInt(packageCostPesos);
  return fromCentsInt(Math.round(packageCents / factor));
}

/**
 * Calcula el desglose de IVA e IEPS en centavos enteros sobre un precio o costo base.
 * Soporta tasas tanto en fracción (0.16) como en porcentaje (16).
 */
export function calculateProductTaxes(
  baseAmountPesos: number,
  ivaRate = 0,
  iepsRate = 0
): {
  baseCents: number;
  ivaCents: number;
  iepsCents: number;
  totalTaxCents: number;
  totalCents: number;
  totalPesos: number;
} {
  const baseCents = toCentsInt(baseAmountPesos);
  const rawIva = Math.max(0, Number(ivaRate) || 0);
  const rawIeps = Math.max(0, Number(iepsRate) || 0);
  const safeIva = rawIva > 1 ? rawIva / 100 : rawIva;
  const safeIeps = rawIeps > 1 ? rawIeps / 100 : rawIeps;
  const ivaCents = Math.round(baseCents * safeIva);
  const iepsCents = Math.round(baseCents * safeIeps);
  const totalTaxCents = ivaCents + iepsCents;
  const totalCents = baseCents + totalTaxCents;
  return {
    baseCents,
    ivaCents,
    iepsCents,
    totalTaxCents,
    totalCents,
    totalPesos: fromCentsInt(totalCents),
  };
}

// =====================================================================
//  PRECIOS ESCALONADOS (MENUDEO, MEDIO MAYOREO, MAYOREO)
// =====================================================================

const TIER_DEFAULT_LABELS: Record<PriceTierCode, string> = {
  MENUDEO: 'Menudeo',
  MEDIO_MAYOREO: 'Medio Mayoreo',
  MAYOREO: 'Mayoreo',
};

/**
 * Normaliza la tabla de precios escalonados de un producto asegurando que el escalón MENUDEO
 * coincida siempre con `baseSalePrice` (cantidad mínima 1).
 */
export function normalizePriceTiers(
  baseSalePrice: number,
  tiers?: readonly Partial<ProductPriceTier>[]
): ProductPriceTier[] {
  const basePriceClean = fromCentsInt(toCentsInt(baseSalePrice));
  const result: ProductPriceTier[] = [
    {
      tier: 'MENUDEO',
      label: TIER_DEFAULT_LABELS.MENUDEO,
      minQty: 1,
      unitPrice: basePriceClean,
      appliedTier: 'MENUDEO',
      tierLabel: TIER_DEFAULT_LABELS.MENUDEO,
    },
  ];

  if (!Array.isArray(tiers)) {
    return result;
  }

  for (const raw of tiers) {
    if (!raw || !raw.tier || raw.tier === 'MENUDEO') continue;
    if (raw.tier !== 'MEDIO_MAYOREO' && raw.tier !== 'MAYOREO') continue;
    const tierCode: PriceTierCode = raw.tier === 'MAYOREO' ? 'MAYOREO' : 'MEDIO_MAYOREO';
    const minQty = Math.max(1, Number(raw.minQty) || 1);
    const unitPrice = fromCentsInt(toCentsInt(Number(raw.unitPrice) || 0));
    if (unitPrice <= 0 || minQty <= 1) continue;
    const existingIdx = result.findIndex((t) => t.tier === tierCode);
    const resolvedLabel = raw.label?.trim() || TIER_DEFAULT_LABELS[tierCode];
    const entry: ProductPriceTier = {
      tier: tierCode,
      label: resolvedLabel,
      minQty,
      unitPrice,
      appliedTier: tierCode,
      tierLabel: resolvedLabel,
    };
    if (existingIdx >= 0) {
      result[existingIdx] = entry;
    } else {
      result.push(entry);
    }
  }

  return result.sort((a, b) => a.minQty - b.minQty);
}

/**
 * Determina el precio unitario escalonado aplicable según la cantidad o el escalón elegido manualmente en el POS.
 * Soporta tanto `(productObj, qty, forcedTier)` como `(baseSalePrice, priceTiers, qty, forcedTier)`.
 */
export function resolveTierUnitPrice(
  productOrBasePrice:
    | { salePrice: number; priceTiers?: readonly ProductPriceTier[] }
    | number,
  qtyOrTiers?: number | readonly Partial<ProductPriceTier>[],
  forcedTierOrQty?: PriceTierCode | number,
  explicitForcedTier?: PriceTierCode
): ProductPriceTier & { appliedTier: PriceTierCode; tierLabel: string } {
  let baseSalePrice: number;
  let rawTiers: readonly Partial<ProductPriceTier>[] | undefined;
  let qty: number;
  let forcedTier: PriceTierCode | undefined;

  if (typeof productOrBasePrice === 'number') {
    baseSalePrice = productOrBasePrice;
    rawTiers = Array.isArray(qtyOrTiers) ? qtyOrTiers : undefined;
    qty = typeof forcedTierOrQty === 'number' ? forcedTierOrQty : 1;
    forcedTier = explicitForcedTier;
  } else {
    baseSalePrice = productOrBasePrice.salePrice;
    rawTiers = productOrBasePrice.priceTiers;
    qty = typeof qtyOrTiers === 'number' ? qtyOrTiers : 1;
    forcedTier =
      typeof forcedTierOrQty === 'string' ? forcedTierOrQty : explicitForcedTier;
  }

  const tiers = normalizePriceTiers(baseSalePrice, rawTiers);
  if (forcedTier) {
    const found = tiers.find((t) => t.tier === forcedTier);
    if (found) {
      return {
        ...found,
        appliedTier: found.tier,
        tierLabel: found.label,
      };
    }
  }

  const safeQty = Math.max(0, Number(qty) || 0);
  let matched = tiers[0];
  for (const tier of tiers) {
    if (safeQty >= tier.minQty) {
      matched = tier;
    }
  }
  return {
    ...matched,
    appliedTier: matched.tier,
    tierLabel: matched.label,
  };
}

// =====================================================================
//  DESCUENTOS POR LÍNEA Y POR TICKET (CENTAVOS ENTEROS + TOPE CON PIN)
// =====================================================================

/**
 * Evalúa los descuentos por línea y por ticket trabajando exclusivamente en centavos enteros.
 * Determina si se rebasa el tope configurable (`maxDiscountPctWithoutPin`) para exigir PIN.
 */
export function evaluateCartDiscounts(
  lines: readonly CartLineDiscountInput[],
  ticketDiscountPct = 0,
  maxDiscountPctWithoutPin = DEFAULT_MAX_DISCOUNT_PCT_WITHOUT_PIN,
  ticketDiscountAmountPesos = 0
): CartDiscountEvaluation {
  const safeCapPct = Math.max(0, Number(maxDiscountPctWithoutPin) || 0);
  const safeTicketPct = Math.min(100, Math.max(0, Number(ticketDiscountPct) || 0));
  const safeTicketFixedCents = Math.max(0, toCentsInt(Number(ticketDiscountAmountPesos) || 0));

  let grossTotalCents = 0;
  let retailGrossTotalCents = 0;
  let totalLineDiscountsCents = 0;
  const reasons: string[] = [];

  const intermediateLines = lines.map((line) => {
    const qty = Math.max(0, Number(line.qty) || 0);
    const unitCents = Math.max(0, toCentsInt(line.unitPrice));
    const baseUnitCents = Math.max(
      unitCents,
      line.baseUnitPrice !== undefined ? toCentsInt(line.baseUnitPrice) : unitCents
    );
    const grossLineCents = Math.round(unitCents * qty);
    const retailLineCents = Math.round(baseUnitCents * qty);

    const linePct = Math.min(100, Math.max(0, Number(line.discountPct) || 0));
    const fixedLineCents = Math.max(0, toCentsInt(Number(line.discountAmountPesos) || 0));

    const rawDiscountCents =
      fixedLineCents > 0 ? fixedLineCents : Math.round(grossLineCents * (linePct / 100));
    const lineDiscountCents = Math.min(grossLineCents, Math.max(0, rawDiscountCents));
    const netLineCents = grossLineCents - lineDiscountCents;

    const effectiveLinePct =
      grossLineCents > 0
        ? Math.round((lineDiscountCents / grossLineCents) * 10000) / 100
        : 0;

    // Si hay descuento explícito en línea y además un escalón de mayoreo activo, evaluar el descuento total vs. precio menudeo
    const lineDiscountVsRetailCents = Math.max(0, retailLineCents - netLineCents);
    const effectiveLineVsRetailPct =
      lineDiscountCents > 0 && retailLineCents > 0
        ? Math.round((lineDiscountVsRetailCents / retailLineCents) * 10000) / 100
        : effectiveLinePct;

    const exceedsLineCap =
      effectiveLinePct > safeCapPct + 1e-6 || effectiveLineVsRetailPct > safeCapPct + 1e-6;
    if (exceedsLineCap) {
      const shownPct = Math.max(effectiveLinePct, effectiveLineVsRetailPct);
      reasons.push(
        `Descuento en línea "${line.name || line.sku}" (${shownPct.toFixed(1)}% sobre menudeo) supera el tope de ${safeCapPct}%.`
      );
    }

    grossTotalCents += grossLineCents;
    retailGrossTotalCents += retailLineCents;
    totalLineDiscountsCents += lineDiscountCents;

    return {
      sku: line.sku,
      qty,
      unitPrice: fromCentsInt(unitCents),
      baseUnitPrice: fromCentsInt(baseUnitCents),
      grossLineCents,
      retailLineCents,
      lineDiscountCents,
      netLineCents,
      effectiveLinePct,
      exceedsLineCap,
    };
  });

  const subtotalAfterLineCents = grossTotalCents - totalLineDiscountsCents;

  const rawTicketDiscountCents =
    safeTicketFixedCents > 0
      ? safeTicketFixedCents
      : Math.round(subtotalAfterLineCents * (safeTicketPct / 100));
  const ticketDiscountCents = Math.min(
    subtotalAfterLineCents,
    Math.max(0, rawTicketDiscountCents)
  );

  const effectiveTicketDiscountPct =
    subtotalAfterLineCents > 0
      ? Math.round((ticketDiscountCents / subtotalAfterLineCents) * 10000) / 100
      : 0;

  if (effectiveTicketDiscountPct > safeCapPct + 1e-6) {
    reasons.push(
      `Descuento por ticket (${effectiveTicketDiscountPct.toFixed(1)}%) supera el tope de ${safeCapPct}%.`
    );
  }

  const finalTotalCents = subtotalAfterLineCents - ticketDiscountCents;
  const totalDiscountCents = totalLineDiscountsCents + ticketDiscountCents;
  const effectiveTotalDiscountPct =
    grossTotalCents > 0
      ? Math.round((totalDiscountCents / grossTotalCents) * 10000) / 100
      : 0;

  // Total descontado respecto al precio Menudeo (acumula rebaja por escalón Mayoreo + descuento por línea/ticket)
  const totalDiscountVsRetailCents = Math.max(0, retailGrossTotalCents - finalTotalCents);
  const effectiveDiscountVsRetailPct =
    retailGrossTotalCents > 0
      ? Math.round((totalDiscountVsRetailCents / retailGrossTotalCents) * 10000) / 100
      : 0;

  // Cuando se aplica un descuento manual (línea o ticket), el tope maxDiscountPctWithoutPin evalúa el total descontado sobre el precio menudeo
  if (
    totalDiscountCents > 0 &&
    effectiveDiscountVsRetailPct > safeCapPct + 1e-6 &&
    reasons.length === 0
  ) {
    reasons.push(
      `Descuento total sobre precio menudeo (${effectiveDiscountVsRetailPct.toFixed(1)}%) supera el tope de ${safeCapPct}%.`
    );
  } else if (
    reasons.length === 0 &&
    effectiveTotalDiscountPct > safeCapPct + 1e-6
  ) {
    reasons.push(
      `Descuento acumulado total (${effectiveTotalDiscountPct.toFixed(1)}%) supera el tope de ${safeCapPct}%.`
    );
  }

  // Prorratear el descuento de ticket entre las líneas en centavos enteros para que la suma cuadre al centavo
  let allocatedSumCents = 0;
  const allocatedCentsPerLine = intermediateLines.map((l) => {
    if (subtotalAfterLineCents <= 0 || l.netLineCents <= 0) return 0;
    const share = Math.round((l.netLineCents * finalTotalCents) / subtotalAfterLineCents);
    allocatedSumCents += share;
    return share;
  });

  // Ajustar cualquier residuo de redondeo de 1 centavo en la última línea con importe positivo
  const diffCents = finalTotalCents - allocatedSumCents;
  if (diffCents !== 0 && allocatedCentsPerLine.length > 0) {
    for (let i = allocatedCentsPerLine.length - 1; i >= 0; i--) {
      if (intermediateLines[i].netLineCents > 0 || i === 0) {
        allocatedCentsPerLine[i] = Math.max(0, allocatedCentsPerLine[i] + diffCents);
        break;
      }
    }
  }

  const evaluatedLines: EvaluatedCartLine[] = intermediateLines.map((l, idx) => ({
    sku: l.sku,
    qty: l.qty,
    unitPrice: l.unitPrice,
    baseUnitPrice: l.baseUnitPrice,
    grossSubtotal: fromCentsInt(l.grossLineCents),
    grossCents: l.grossLineCents,
    retailGrossCents: l.retailLineCents,
    lineDiscountAmount: fromCentsInt(l.lineDiscountCents),
    lineDiscountCents: l.lineDiscountCents,
    lineDiscountPctEffective: l.effectiveLinePct,
    netSubtotalAfterLineDiscount: fromCentsInt(l.netLineCents),
    netAfterLineCents: l.netLineCents,
    finalAllocatedAmount: fromCentsInt(allocatedCentsPerLine[idx]),
    finalNetCents: allocatedCentsPerLine[idx],
    exceedsLineCap: l.exceedsLineCap,
  }));

  return {
    lines: evaluatedLines,
    grossTotal: fromCentsInt(grossTotalCents),
    grossSubtotalCents: grossTotalCents,
    retailGrossTotal: fromCentsInt(retailGrossTotalCents),
    retailGrossSubtotalCents: retailGrossTotalCents,
    totalLineDiscounts: fromCentsInt(totalLineDiscountsCents),
    lineDiscountsTotalCents: totalLineDiscountsCents,
    subtotalAfterLineDiscounts: fromCentsInt(subtotalAfterLineCents),
    ticketDiscountPct: effectiveTicketDiscountPct,
    ticketDiscountAmount: fromCentsInt(ticketDiscountCents),
    ticketDiscountCents,
    totalDiscountAmount: fromCentsInt(totalDiscountCents),
    totalDiscountCents,
    totalDiscountVsRetailAmount: fromCentsInt(totalDiscountVsRetailCents),
    totalDiscountVsRetailCents,
    effectiveTotalDiscountPct,
    effectiveDiscountPct: effectiveTotalDiscountPct,
    effectiveDiscountVsRetailPct,
    finalTotal: fromCentsInt(finalTotalCents),
    finalTotalCents,
    maxDiscountPctWithoutPin: safeCapPct,
    requiresPin: reasons.length > 0,
    reasons,
    pinReason: reasons[0],
  };
}

// =====================================================================
//  TOLERANCIA DE MERMA NATURAL EN GRANEL (% POR PRODUCTO)
// =====================================================================

/**
 * Evalúa la diferencia de conteo físico en auditoría frente al porcentaje de tolerancia
 * de merma natural del producto (especialmente en granel por evaporación, corte o despunte).
 * Las diferencias negativas dentro de la tolerancia se clasifican como 'MERMA_NATURAL'
 * ("Merma natural") y NO como 'FALTANTE'.
 */
export function evaluateNaturalShrinkTolerance(
  paramsOrSystemQty:
    | {
        isBulk?: boolean;
        naturalShrinkTolerancePct?: number;
        systemQty: number;
        countedQty: number;
      }
    | number,
  countedQtyArg?: number,
  tolerancePctArg?: number
): NaturalShrinkEvaluation {
  const systemQty =
    typeof paramsOrSystemQty === 'number'
      ? Number(paramsOrSystemQty) || 0
      : Number(paramsOrSystemQty.systemQty) || 0;
  const countedQty =
    typeof paramsOrSystemQty === 'number'
      ? Number(countedQtyArg) || 0
      : Number(paramsOrSystemQty.countedQty) || 0;
  const tolerancePct = Math.max(
    0,
    typeof paramsOrSystemQty === 'number'
      ? Number(tolerancePctArg) || 0
      : Number(paramsOrSystemQty.naturalShrinkTolerancePct) || 0
  );

  const diffQty = Math.round((countedQty - systemQty) * 1000) / 1000;
  const maxAllowedShrinkQty =
    systemQty > 0 && tolerancePct > 0
      ? Math.round(systemQty * (tolerancePct / 100) * 1000) / 1000
      : 0;

  if (Math.abs(diffQty) < 0.0005) {
    return {
      classification: 'SIN_DIFERENCIA',
      label: 'Sin diferencia',
      classificationLabel: 'Sin diferencia',
      diffQty: 0,
      missingQty: 0,
      missingPct: 0,
      tolerancePct,
      maxAllowedShrinkQty,
      maxNaturalLossQty: maxAllowedShrinkQty,
      isWithinNaturalTolerance: true,
      isWithinTolerance: true,
    };
  }

  if (diffQty > 0) {
    return {
      classification: 'SOBRANTE',
      label: 'Sobrante',
      classificationLabel: 'Sobrante',
      diffQty,
      missingQty: 0,
      missingPct: 0,
      tolerancePct,
      maxAllowedShrinkQty,
      maxNaturalLossQty: maxAllowedShrinkQty,
      isWithinNaturalTolerance: false,
      isWithinTolerance: false,
    };
  }

  const missingQty = Math.round((systemQty - countedQty) * 1000) / 1000;
  const missingPct =
    systemQty > 0 ? Math.round((missingQty / systemQty) * 10000) / 100 : 100;

  const isWithinNaturalTolerance =
    tolerancePct > 0 &&
    systemQty > 0 &&
    missingQty <= maxAllowedShrinkQty + 1e-6;

  if (isWithinNaturalTolerance) {
    return {
      classification: 'MERMA_NATURAL',
      label: 'Merma natural',
      classificationLabel: 'Merma natural',
      diffQty,
      missingQty,
      missingPct,
      tolerancePct,
      maxAllowedShrinkQty,
      maxNaturalLossQty: maxAllowedShrinkQty,
      isWithinNaturalTolerance: true,
      isWithinTolerance: true,
    };
  }

  return {
    classification: 'FALTANTE',
    label: 'Faltante',
    classificationLabel: 'Faltante',
    diffQty,
    missingQty,
    missingPct,
    tolerancePct,
    maxAllowedShrinkQty,
    maxNaturalLossQty: maxAllowedShrinkQty,
    isWithinNaturalTolerance: false,
    isWithinTolerance: false,
  };
}

// =====================================================================
//  PROTECCIÓN CONTRA BORRADO SI TIENE MOVIMIENTOS (BAJA LÓGICA)
// =====================================================================

/**
 * Determina si un producto tiene movimientos históricos en el Kardex o registros de merma.
 * Si devuelve true, el producto NO puede borrarse físicamente; solo procede su baja lógica.
 */
export function hasProductMovements(
  sku: string,
  kardex: readonly { producto?: string | { sku: string }; sku?: string }[],
  shrinkRecords: readonly { sku: string }[] = []
): boolean {
  const cleanSku = String(sku || '').trim().toUpperCase();
  if (!cleanSku) return false;

  for (const entry of kardex) {
    if (!entry) continue;
    const entrySku =
      typeof entry.sku === 'string'
        ? entry.sku
        : typeof entry.producto === 'string'
        ? entry.producto
        : entry.producto?.sku || '';
    if (entrySku.trim().toUpperCase() === cleanSku) {
      return true;
    }
  }

  for (const shrink of shrinkRecords) {
    if (shrink?.sku && shrink.sku.trim().toUpperCase() === cleanSku) {
      return true;
    }
  }

  return false;
}

// =====================================================================
//  VALIDACIÓN DE ALTA / EDICIÓN DE PRODUCTO Y SOLICITUD MÓVIL
// =====================================================================

const VALID_SALE_UNITS: readonly CatalogSaleUnit[] = [
  'Pieza',
  'Kg',
  'g',
  'L',
  'Lata',
  'Paquete',
];

/**
 * Valida todos los campos de alta o edición de un producto en el catálogo.
 */
export function validateCatalogProductInput(
  input: CatalogUpsertInput,
  existingProducts: readonly {
    sku: string;
    name: string;
    barcode?: string;
    barcodes?: readonly string[];
  }[] = [],
  editingSku?: string
): CatalogValidationResult {
  const errors: string[] = [];
  const cleanName = String(input?.name || '').trim();
  if (!cleanName || cleanName.length < 2) {
    errors.push('El nombre del producto es obligatorio (mínimo 2 caracteres).');
  }

  const cleanCategory = String(input?.category || '').trim() || 'General';
  const existingSkus = existingProducts.map((p) => p.sku);
  const rawSku = String(input?.sku || '').trim().toUpperCase();
  const resolvedSku =
    rawSku || generateInternalSku(cleanName, cleanCategory, existingSkus);

  if (!editingSku || resolvedSku !== editingSku.trim().toUpperCase()) {
    const skuCollision = existingProducts.find(
      (p) => p.sku.trim().toUpperCase() === resolvedSku
    );
    if (skuCollision) {
      errors.push(
        `El SKU "${resolvedSku}" ya está en uso por el producto "${skuCollision.name}".`
      );
    }
  }

  if (!VALID_SALE_UNITS.includes(input.saleUnit)) {
    errors.push(`Unidad de venta inválida (${input.saleUnit}).`);
  }

  const factor = Number(input.unitsPerPurchase ?? 1);
  if (!Number.isFinite(factor) || factor <= 0) {
    errors.push('El factor de conversión de unidad de compra debe ser mayor a 0.');
  }

  const resolvedUnitCost =
    input.unitCost !== undefined
      ? input.unitCost
      : input.cost !== undefined
      ? input.cost
      : input.packageCost !== undefined
      ? calculateUnitCostFromPurchasePackage(
          input.packageCost,
          factor,
          input.purchaseUnit,
          input.saleUnit
        )
      : 0;

  const costCents = toCentsInt(resolvedUnitCost);
  const salePriceCents = toCentsInt(input.salePrice);
  if (costCents < 0) {
    errors.push('El costo no puede ser negativo.');
  }
  if (salePriceCents <= 0) {
    errors.push('El precio de venta debe ser mayor a $0.00.');
  }

  if (input.ivaRate !== undefined && (input.ivaRate < 0 || input.ivaRate > 100)) {
    errors.push('La tasa de IVA debe estar entre 0% y 100%.');
  }
  if (input.iepsRate !== undefined && (input.iepsRate < 0 || input.iepsRate > 100)) {
    errors.push('La tasa de IEPS debe estar entre 0% y 100%.');
  }

  if (
    input.naturalShrinkTolerancePct !== undefined &&
    (input.naturalShrinkTolerancePct < 0 || input.naturalShrinkTolerancePct > 100)
  ) {
    errors.push('La tolerancia de merma natural debe estar entre 0% y 100%.');
  }

  if (input.initialStock !== undefined && input.initialStock < 0) {
    errors.push('El stock inicial no puede ser negativo.');
  }

  // Recolectar códigos de barras propuestos
  const rawBarcodes: string[] = [];
  if (input.barcode && String(input.barcode).trim()) {
    rawBarcodes.push(String(input.barcode).trim());
  }
  if (Array.isArray(input.barcodes)) {
    for (const b of input.barcodes) {
      const clean = String(b || '').trim();
      if (clean && !rawBarcodes.includes(clean)) {
        rawBarcodes.push(clean);
      }
    }
  }

  let hasInternalBarcode = false;
  if (rawBarcodes.length === 0) {
    const allExistingBarcodes = existingProducts.flatMap((p) =>
      getAllProductBarcodes(p)
    );
    const internalCode = generateInternalBarcode(
      allExistingBarcodes,
      existingProducts.length + 1
    );
    rawBarcodes.push(internalCode);
    hasInternalBarcode = true;
  } else {
    hasInternalBarcode = rawBarcodes[0].startsWith('200');
  }

  const barcodeCheck = validateBarcodeUniqueness(
    rawBarcodes,
    existingProducts,
    editingSku || resolvedSku
  );
  if (!barcodeCheck.valid && barcodeCheck.error) {
    errors.push(barcodeCheck.error);
  }

  return {
    valid: errors.length === 0,
    errors,
    error: errors[0],
    message: errors[0] || '',
    normalizedBarcodes: barcodeCheck.normalizedBarcodes,
    resolvedSku,
    hasInternalBarcode,
  };
}

/**
 * Valida la solicitud PRODUCT_CREATE_REQUEST enviada desde el teléfono móvil al escanear un código desconocido.
 */
export function validateMobileProductCreateRequest(payload: any): {
  valid: boolean;
  error?: string;
  message?: string;
  normalized?: MobileProductCreatePayload;
} {
  if (!payload || typeof payload !== 'object') {
    const err = 'Solicitud móvil inválida.';
    return { valid: false, error: err, message: err };
  }
  const prod = payload.product && typeof payload.product === 'object' ? payload.product : payload;
  const barcode = String(prod.barcode || '').trim();
  const name = String(prod.name || '').trim();
  const salePrice = fromCentsInt(toCentsInt(Number(prod.salePrice ?? prod.price) || 0));
  const cost = fromCentsInt(toCentsInt(Number(prod.cost ?? prod.historicCost) || 0));
  const rawUnit = String(prod.saleUnit || prod.unit || 'Pieza').trim();

  const unitMap: Record<string, CatalogSaleUnit> = {
    pieza: 'Pieza',
    pza: 'Pieza',
    kg: 'Kg',
    g: 'g',
    gr: 'g',
    l: 'L',
    lt: 'L',
    litro: 'L',
    lata: 'Lata',
    paquete: 'Paquete',
  };
  const saleUnit: CatalogSaleUnit =
    unitMap[rawUnit.toLowerCase()] ||
    (VALID_SALE_UNITS.includes(rawUnit as CatalogSaleUnit)
      ? (rawUnit as CatalogSaleUnit)
      : 'Pieza');

  if (!barcode) {
    const err = 'El código de barras es obligatorio.';
    return { valid: false, error: err, message: err };
  }
  if (!name || name.length < 2) {
    const err = 'El nombre del producto es obligatorio.';
    return { valid: false, error: err, message: err };
  }
  if (salePrice <= 0) {
    const err = 'El precio de venta debe ser mayor a $0.00.';
    return { valid: false, error: err, message: err };
  }
  if (cost < 0) {
    const err = 'El costo no puede ser negativo.';
    return { valid: false, error: err, message: err };
  }

  return {
    valid: true,
    normalized: {
      requestId: payload.requestId ? String(payload.requestId).trim() : `REQ-${barcode}`,
      barcode,
      name,
      salePrice,
      cost,
      saleUnit,
      category: String(prod.category || 'Abarrotes').trim(),
    },
  };
}
