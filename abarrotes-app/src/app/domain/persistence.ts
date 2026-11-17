/**
 * Adaptadores de persistencia del estado (Bloques D y N).
 *
 * =====================================================================================
 * NOTA PARA EL EQUIPO (ARQUITECTURA Y FUENTE DE VERDAD):
 * En la PC, SQLite de local-server es la fuente persistente principal. IndexedDB conserva
 * un espejo de contingencia y permite migrar los datos existentes de instalaciones previas.
 * En otros orígenes (por ejemplo, ng serve o un dispositivo conectado por LAN), IndexedDB
 * sigue siendo el almacenamiento local del navegador.
 *
 * REGLA DE SEGURIDAD CRÍTICA:
 * El PIN de administrador NUNCA se almacena en texto plano en el estado ni en IndexedDB.
 * La autenticación se delega exclusivamente a PBKDF2 (>= 600,000 iteraciones + sal de 16 bytes).
 * =====================================================================================
 */

import type { BusinessSettings } from './settings';
import type { AppUser } from './auth';
import type { SecurityAuditEntry } from './audit-log';
import type { UsageActivityEntry, SatisfactionSurveyRecord } from './reports';
import type { PrivacyNoticeConfig } from './privacy';

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  storeName: 'Mi Tiendita',
  initialCashFloat: 1000.0,
  initialCashFloatCents: 100000,
  marginThresholdPct: 20.0,
  defaultIvaPct: 16.0,
  defaultIepsPct: 0.0,
  inactivityTimeoutMinutes: 5,
  maxDiscountPctWithoutPin: 10.0,
};

export function validateBusinessSettings(input: Partial<BusinessSettings>): {
  valid: boolean;
  ok: boolean;
  sanitized: BusinessSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const storeName = (input.storeName ?? DEFAULT_BUSINESS_SETTINGS.storeName).trim();
  if (storeName.length < 2) {
    errors.push('El nombre del negocio debe tener al menos 2 caracteres.');
  }

  const initialCashFloat = Math.max(
    0,
    Number(input.initialCashFloat ?? DEFAULT_BUSINESS_SETTINGS.initialCashFloat) || 0
  );
  const initialCashFloatCents = Math.round(initialCashFloat * 100);

  const marginThresholdPct = Math.min(
    100,
    Math.max(0, Number(input.marginThresholdPct ?? DEFAULT_BUSINESS_SETTINGS.marginThresholdPct) || 0)
  );
  const defaultIvaPct = Math.min(
    100,
    Math.max(0, Number(input.defaultIvaPct ?? DEFAULT_BUSINESS_SETTINGS.defaultIvaPct) || 0)
  );
  const defaultIepsPct = Math.min(
    100,
    Math.max(0, Number(input.defaultIepsPct ?? DEFAULT_BUSINESS_SETTINGS.defaultIepsPct) || 0)
  );

  const rawTimeout =
    input.inactivityTimeoutMinutes !== undefined
      ? Number(input.inactivityTimeoutMinutes)
      : DEFAULT_BUSINESS_SETTINGS.inactivityTimeoutMinutes;
  const inactivityTimeoutMinutes = Math.min(
    240,
    Math.max(1, Math.round(Number.isFinite(rawTimeout) ? rawTimeout : 5))
  );
  const maxDiscountPctWithoutPin = Math.min(
    100,
    Math.max(0, Number(input.maxDiscountPctWithoutPin ?? DEFAULT_BUSINESS_SETTINGS.maxDiscountPctWithoutPin) || 0)
  );

  return {
    valid: errors.length === 0,
    ok: errors.length === 0,
    sanitized: {
      storeName: storeName.length >= 2 ? storeName : DEFAULT_BUSINESS_SETTINGS.storeName,
      initialCashFloat,
      initialCashFloatCents,
      marginThresholdPct,
      defaultIvaPct,
      defaultIepsPct,
      inactivityTimeoutMinutes,
      maxDiscountPctWithoutPin,
    },
    errors,
  };
}

export function buildDefaultDemoUsers(): AppUser[] {
  return [
    {
      id: 'USR-ADMIN-01',
      name: 'Administrador',
      role: 'ADMINISTRADOR',
      salt: 'c4ca4238a0b923820dcc509a6f75849b',
      pinHash: 'b5d84871032321ef80a525f20f1fb2a1d2e1329bf33783a0026e64c125dfef11',
      iterations: 600000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'USR-LUPE-01',
      name: 'Don Lupe (Encargado)',
      role: 'ENCARGADO',
      salt: 'c81e728d9d4c2f636f067f89cc14862c',
      pinHash: 'f454f738f6d89efd95e0c52bb1b415a99577747e44e99f5b2b2b2b2b2b2b2b2b',
      iterations: 600000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'USR-MARIA-01',
      name: 'María (Cajera)',
      role: 'CAJERO',
      salt: 'eccbc87e4b5ce2fe28308fd9f2a7baf3',
      pinHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
      iterations: 600000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'USR-PEDRO-01',
      name: 'Pedro (Cajero)',
      role: 'CAJERO',
      salt: 'a87ff679a2f3e71d9181a67b7542122c',
      pinHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      iterations: 600000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
}

export type KardexChainVerifier = (entries: any[]) => { valid: boolean; error?: string };
export type ProductContinuityVerifier = (
  products: any[],
  entries: any[]
) => { valid: boolean; error?: string; affectedSkus: string[] };

export const CURRENT_SCHEMA_VERSION = 6;
export const STATE_STORAGE_KEY = 'binnitech_pos_state_v6';
export const LEGACY_STATE_STORAGE_KEY_V5 = 'binnitech_pos_state_v5';
export const LEGACY_STATE_STORAGE_KEY_V4 = 'binnitech_pos_state_v4';
export const LEGACY_STATE_STORAGE_KEY_V3 = 'binnitech_pos_state_v3';
export const LEGACY_STATE_STORAGE_KEY_V2 = 'binnitech_pos_state_v2';
export const LEGACY_STATE_STORAGE_KEY_V1 = 'binnitech_pos_state_v1';
export const LEGACY_STATE_STORAGE_KEY = 'binnitech_pos_state_v4';
export const CORRUPT_STATE_KEY_PREFIX = 'binnitech_pos_state_corrupt_';
export const MAX_CORRUPT_BACKUPS = 3;
export const WRITER_LOCK_NAME = 'binnitech_pos_writer';
export const DEFAULT_DEBOUNCE_MS = 500;

export interface PersistedAppState {
  schemaVersion: number;
  timestamp: string;
  activeUser: string;
  products: any[];
  creditCustomers: any[];
  cashShift: any;
  cashRegister: any;
  kardex: any[];
  shrinkRecords: any[];
  auditLines: any[];
  internalConsumptionRecords?: any[];
  morningAlerts?: any[];
  maxDiscountPctWithoutPin?: number;
  suppliers?: any[];
  accountsPayable?: any[];
  priceHistory?: any[];
  cashMovements?: any[];
  settings?: BusinessSettings;
  users?: AppUser[];
  securityAuditLog?: SecurityAuditEntry[];
  salesHistory?: any[];
  saleReturns?: any[];
  shiftCloseRecords?: any[];
  isShiftOpen?: boolean;
  currentShiftId?: string;
  usageActivityLog?: UsageActivityEntry[];
  satisfactionSurveys?: SatisfactionSurveyRecord[];
  /** Bloque K: aviso de privacidad configurable y versionado (campo opcional, sin cambio de esquema). */
  privacyNotice?: PrivacyNoticeConfig;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  affectedSkus?: string[];
}

/**
 * Valida la integridad estructural, criptográfica (cadena Kardex) y de continuidad de stock por producto.
 * Detecta datos dañados, campos ausentes, tipos incorrectos, cadenas de Kardex alteradas o stock manipulado.
 */
export function validateStoredState(
  data: any,
  kardexVerifier?: KardexChainVerifier,
  continuityVerifier?: ProductContinuityVerifier
): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'El dato almacenado está vacío o no es un objeto válido.' };
  }

  // 1. Validar versión de esquema
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 0) {
    return { valid: false, reason: 'Versión de esquema inválida o ausente.' };
  }

  // 2. Validar que las colecciones requeridas sean arreglos
  if (!Array.isArray(data.products)) {
    return { valid: false, reason: 'La colección de productos está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.creditCustomers)) {
    return { valid: false, reason: 'La colección de clientes de fiado está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.kardex)) {
    return { valid: false, reason: 'La colección de Kardex está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.shrinkRecords)) {
    return { valid: false, reason: 'La colección de mermas está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.auditLines)) {
    return { valid: false, reason: 'La colección de auditorías está dañada o no es un arreglo.' };
  }
  if (data.suppliers !== undefined && !Array.isArray(data.suppliers)) {
    return { valid: false, reason: 'La colección de proveedores está dañada o no es un arreglo.' };
  }
  if (data.accountsPayable !== undefined && !Array.isArray(data.accountsPayable)) {
    return { valid: false, reason: 'La colección de cuentas por pagar está dañada o no es un arreglo.' };
  }
  if (data.priceHistory !== undefined && !Array.isArray(data.priceHistory)) {
    return { valid: false, reason: 'La colección de historial de precios está dañada o no es un arreglo.' };
  }
  if (data.cashMovements !== undefined && !Array.isArray(data.cashMovements)) {
    return { valid: false, reason: 'La colección de movimientos de caja está dañada o no es un arreglo.' };
  }
  if (data.users !== undefined && !Array.isArray(data.users)) {
    return { valid: false, reason: 'La colección de usuarios está dañada o no es un arreglo.' };
  }
  if (data.securityAuditLog !== undefined && !Array.isArray(data.securityAuditLog)) {
    return { valid: false, reason: 'La bitácora de auditoría de seguridad está dañada o no es un arreglo.' };
  }

  // 3. Validar consistencia básica de productos
  for (let i = 0; i < data.products.length; i++) {
    const p = data.products[i];
    if (!p || typeof p.sku !== 'string' || typeof p.stock !== 'number' || Number.isNaN(p.stock)) {
      return { valid: false, reason: `Producto dañado en índice ${i} (SKU o stock no numérico).` };
    }
  }

  // 4. Validar integridad estructural y criptográfica del Kardex si contiene movimientos
  if (data.kardex.length > 0) {
    const k = data.kardex;
    for (let i = 0; i < k.length; i++) {
      const entry = k[i];
      if (!entry || typeof entry !== 'object' || !entry.id || !entry.previousHash) {
        return { valid: false, reason: `Entrada de Kardex dañada en índice ${i}.` };
      }
    }

    if (kardexVerifier) {
      const chainCheck = kardexVerifier(data.kardex);
      if (!chainCheck.valid) {
        return {
          valid: false,
          reason: `Integridad criptográfica del Kardex rota: ${chainCheck.error || 'cadena alterada'}.`,
        };
      }
    }
  }

  // 5. Validar continuidad de stock por producto frente al Kardex
  if (continuityVerifier && data.kardex.length > 0) {
    const contCheck = continuityVerifier(data.products, data.kardex);
    if (!contCheck.valid) {
      return {
        valid: false,
        reason: contCheck.error || `Discrepancia de continuidad de stock en SKU(s): ${contCheck.affectedSkus.join(', ')}`,
        affectedSkus: contCheck.affectedSkus,
      };
    }
  }

  return { valid: true, affectedSkus: [] };
}

export interface MigrationResult {
  state: PersistedAppState;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  message?: string;
}

/**
 * Normaliza y complementa un producto guardado en versiones previas de esquema
 * con todos los campos nuevos y sus valores por defecto (Bloque F1 seguimiento).
 */
export function migrateCustomerDefaults(c: any): any {
  return {
    ...c,
    creditDays: typeof c?.creditDays === 'number' ? c.creditDays : 15,
    isActive: c?.isActive !== false,
    debts: Array.isArray(c?.debts) ? c.debts : [],
    payments: Array.isArray(c?.payments) ? c.payments : [],
    creditFavorBalance:
      typeof c?.creditFavorBalance === 'number' && !isNaN(c.creditFavorBalance)
        ? Math.max(0, c.creditFavorBalance)
        : 0,
  };
}

export function migrateSupplierDefaults(s: any): any {
  if (!s || typeof s !== 'object') return s;
  return {
    ...s,
    paymentTerms: s.paymentTerms === 'CREDITO' ? 'CREDITO' : 'CONTADO',
    creditDays: typeof s.creditDays === 'number' ? s.creditDays : 0,
    visitDays: Array.isArray(s.visitDays) ? s.visitDays : [],
    physicalExchangePolicy: Boolean(s.physicalExchangePolicy),
    isActive: s.isActive !== false,
    currentBalance: typeof s.currentBalance === 'number' ? s.currentBalance : 0,
  };
}

export function migrateAccountsPayableDefaults(d: any): any {
  if (!d || typeof d !== 'object') return d;
  return {
    ...d,
    totalAmount: typeof d.totalAmount === 'number' ? d.totalAmount : 0,
    remainingBalance: typeof d.remainingBalance === 'number' ? d.remainingBalance : typeof d.totalAmount === 'number' ? d.totalAmount : 0,
    status: d.status || 'PENDIENTE',
    linesSummary: Array.isArray(d.linesSummary) ? d.linesSummary : [],
  };
}

export function migratePriceHistoryDefaults(h: any): any {
  if (!h || typeof h !== 'object') return h;
  return {
    ...h,
    priceHikeDetected: Boolean(h.priceHikeDetected),
    unitCost: typeof h.unitCost === 'number' ? h.unitCost : 0,
  };
}

export function migrateProductDefaults(p: any): any {
  if (!p || typeof p !== 'object') return p;
  const isBulk = Boolean(p.isBulk || p.saleUnit === 'Kg' || p.saleUnit === 'g' || p.saleUnit === 'L');
  const salePrice = typeof p.salePrice === 'number' ? p.salePrice : 0;
  const historicCost =
    typeof p.historicCost === 'number'
      ? p.historicCost
      : typeof p.costPrice === 'number'
      ? p.costPrice
      : typeof p.cost === 'number'
      ? p.cost
      : 0;
  const unitCost = typeof p.unitCost === 'number' ? p.unitCost : historicCost;
  const unitsPerPurchase =
    typeof p.unitsPerPurchase === 'number' && p.unitsPerPurchase > 0 ? p.unitsPerPurchase : 1;
  const packageCost =
    typeof p.packageCost === 'number'
      ? p.packageCost
      : Math.round(unitCost * unitsPerPurchase * 100) / 100;
  const packageFactor =
    typeof p.packageFactor === 'number' && p.packageFactor > 0 ? p.packageFactor : unitsPerPurchase;

  const rawBarcodes: string[] = [];
  if (p.barcode && String(p.barcode).trim()) {
    rawBarcodes.push(String(p.barcode).trim());
  }
  if (Array.isArray(p.barcodes)) {
    for (const b of p.barcodes) {
      const clean = String(b || '').trim();
      if (clean && !rawBarcodes.includes(clean)) rawBarcodes.push(clean);
    }
  }

  const priceTiers =
    Array.isArray(p.priceTiers) && p.priceTiers.length > 0
      ? p.priceTiers
      : [
          {
            tier: 'MENUDEO',
            label: 'Menudeo',
            minQty: 1,
            unitPrice: salePrice,
            appliedTier: 'MENUDEO',
            tierLabel: 'Menudeo',
          },
        ];

  return {
    ...p,
    barcode: p.barcode || (rawBarcodes[0] ?? ''),
    barcodes: rawBarcodes.length > 0 ? rawBarcodes : p.barcode ? [p.barcode] : [],
    hasInternalBarcode:
      typeof p.hasInternalBarcode === 'boolean'
        ? p.hasInternalBarcode
        : Boolean(
            (p.barcode && String(p.barcode).startsWith('200')) ||
              rawBarcodes.some((c) => c.startsWith('200'))
          ),
    location: p.location || 'Pasillo General',
    purchaseUnit: p.purchaseUnit || (isBulk ? 'Costal' : 'Pieza'),
    unitsPerPurchase,
    saleUnit: p.saleUnit || (isBulk ? 'Kg' : 'Pieza'),
    historicCost,
    unitCost,
    purchaseCost: typeof p.purchaseCost === 'number' ? p.purchaseCost : unitCost,
    newCost: typeof p.newCost === 'number' ? p.newCost : unitCost,
    weightedAvgCost: typeof p.weightedAvgCost === 'number' ? p.weightedAvgCost : unitCost,
    lastPurchaseCost: typeof p.lastPurchaseCost === 'number' ? p.lastPurchaseCost : unitCost,
    packageCost,
    packageFactor,
    salePrice,
    ivaRate: typeof p.ivaRate === 'number' ? p.ivaRate : 0,
    iepsRate: typeof p.iepsRate === 'number' ? p.iepsRate : 0,
    priceTiers,
    targetMargin: typeof p.targetMargin === 'number' ? p.targetMargin : 20,
    monthlySalesUnits: typeof p.monthlySalesUnits === 'number' ? p.monthlySalesUnits : 30,
    expiry: p.expiry || '2027-12-31',
    fefoExpiryDate: p.fefoExpiryDate || p.expiry || '2027-12-31',
    acceptsPhysicalExchange: Boolean(p.acceptsPhysicalExchange),
    minStock: typeof p.minStock === 'number' ? p.minStock : 5,
    abcClass: p.abcClass || 'B',
    dailySalesRate: typeof p.dailySalesRate === 'number' ? p.dailySalesRate : 1,
    supplierLeadTimeDays: typeof p.supplierLeadTimeDays === 'number' ? p.supplierLeadTimeDays : 3,
    safetyStock: typeof p.safetyStock === 'number' ? p.safetyStock : 2,
    rop: typeof p.rop === 'number' ? p.rop : typeof p.minStock === 'number' ? p.minStock : 5,
    isBulk,
    naturalShrinkTolerancePct:
      typeof p.naturalShrinkTolerancePct === 'number'
        ? p.naturalShrinkTolerancePct
        : isBulk
        ? 3
        : 0,
    isActive: p.isActive !== false,
    approvalStatus: p.approvalStatus || 'APROBADO',
    supplier: p.supplier || 'Distribuidora General',
    bulkCostResidualCents:
      typeof p.bulkCostResidualCents === 'number' ? p.bulkCostResidualCents : 0,
    bulkSoldQtyCurrentPackage:
      typeof p.bulkSoldQtyCurrentPackage === 'number' ? p.bulkSoldQtyCurrentPackage : 0,
    bulkCostCentsCurrentPackage:
      typeof p.bulkCostCentsCurrentPackage === 'number' ? p.bulkCostCentsCurrentPackage : 0,
  };
}

/**
 * Realiza migraciones de versiones anteriores de esquema (v0, v1) a la versión actual (v2).
 */
export function migrateState(data: any): MigrationResult {
  const rawVersion = typeof data?.schemaVersion === 'number' ? data.schemaVersion : 0;

  if (rawVersion === CURRENT_SCHEMA_VERSION) {
    return {
      state: data as PersistedAppState,
      migrated: false,
      fromVersion: rawVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
    };
  }

  let working = { ...data };

  // Migración de versiones anteriores (v0 o v1) a CURRENT_SCHEMA_VERSION (v2)
  if (rawVersion < CURRENT_SCHEMA_VERSION) {
    const migratedProducts = Array.isArray(working.products)
      ? working.products.map(migrateProductDefaults)
      : working.products;

    working = {
      ...working,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp: working.timestamp || new Date().toISOString(),
      activeUser: working.activeUser || 'Don Lupe (Encargado)',
      products: migratedProducts,
      creditCustomers: Array.isArray(working.creditCustomers)
        ? working.creditCustomers.map(migrateCustomerDefaults)
        : [],
      cashShift: working.cashShift || {
        openingCash: 500,
        cashSalesTotal: 0,
        creditPaymentsReceived: 0,
        creditSalesTotal: 0,
        internalConsumptionTotalCost: 0,
        shrinkTotalCost: 0,
      },
      cashRegister: working.cashRegister || {
        openingFloat: 500,
        cashSalesTotal: 0,
        creditSalesTotal: 0,
        creditPaymentsReceived: 0,
      },
      kardex: Array.isArray(working.kardex) ? working.kardex : [],
      shrinkRecords: Array.isArray(working.shrinkRecords) ? working.shrinkRecords : [],
      auditLines: Array.isArray(working.auditLines) ? working.auditLines : [],
      internalConsumptionRecords: Array.isArray(working.internalConsumptionRecords)
        ? working.internalConsumptionRecords
        : [],
      morningAlerts: Array.isArray(working.morningAlerts) ? working.morningAlerts : [],
      maxDiscountPctWithoutPin:
        typeof working.maxDiscountPctWithoutPin === 'number'
          ? working.maxDiscountPctWithoutPin
          : 10,
      suppliers: Array.isArray(working.suppliers)
        ? working.suppliers.map(migrateSupplierDefaults)
        : [],
      accountsPayable: Array.isArray(working.accountsPayable)
        ? working.accountsPayable.map(migrateAccountsPayableDefaults)
        : [],
      priceHistory: Array.isArray(working.priceHistory)
        ? working.priceHistory.map(migratePriceHistoryDefaults)
        : [],
      cashMovements: Array.isArray(working.cashMovements) ? working.cashMovements : [],
      settings: working.settings
        ? validateBusinessSettings({
            ...working.settings,
            maxDiscountPctWithoutPin:
              typeof working.maxDiscountPctWithoutPin === 'number'
                ? working.maxDiscountPctWithoutPin
                : working.settings.maxDiscountPctWithoutPin,
          }).sanitized
        : {
            ...DEFAULT_BUSINESS_SETTINGS,
            maxDiscountPctWithoutPin:
              typeof working.maxDiscountPctWithoutPin === 'number'
                ? working.maxDiscountPctWithoutPin
                : 10,
          },
      users: Array.isArray(working.users) && working.users.length > 0 ? working.users : buildDefaultDemoUsers(),
      securityAuditLog: Array.isArray(working.securityAuditLog) ? working.securityAuditLog : [],
      salesHistory: Array.isArray(working.salesHistory) ? working.salesHistory : [],
      saleReturns: Array.isArray(working.saleReturns)
        ? working.saleReturns
        : Array.isArray(working.salesHistory)
        ? working.salesHistory.flatMap((s: any) => (Array.isArray(s?.returns) ? s.returns : []))
        : [],
      shiftCloseRecords: Array.isArray(working.shiftCloseRecords) ? working.shiftCloseRecords : [],
      isShiftOpen: typeof working.isShiftOpen === 'boolean' ? working.isShiftOpen : true,
      currentShiftId:
        typeof working.currentShiftId === 'string' && working.currentShiftId.trim()
          ? working.currentShiftId
          : 'TURNO-1',
      usageActivityLog: Array.isArray(working.usageActivityLog) ? working.usageActivityLog : [],
      satisfactionSurveys: Array.isArray(working.satisfactionSurveys) ? working.satisfactionSurveys : [],
    };
  }

  return {
    state: working as PersistedAppState,
    migrated: true,
    fromVersion: rawVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    message: `Estado migrado de versión ${rawVersion} a versión ${CURRENT_SCHEMA_VERSION}.`,
  };
}

/**
 * Administrador de guardado diferido (debounce) para cambios menores, con soporte de flush inmediato.
 */
export class DebouncedStorageSaver {
  private timer: any = null;
  private pendingTask: (() => Promise<void> | void) | null = null;
  public readonly delayMs: number;

  constructor(delayMs = DEFAULT_DEBOUNCE_MS) {
    this.delayMs = delayMs;
  }

  hasPending(): boolean {
    return this.timer !== null;
  }

  schedule(task: () => Promise<void> | void): void {
    this.pendingTask = task;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const toRun = this.pendingTask;
      this.pendingTask = null;
      if (toRun) {
        toRun();
      }
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingTask = null;
  }

  async flush(task?: () => Promise<void> | void): Promise<void> {
    const toRun = task || this.pendingTask;
    this.cancel();
    if (toRun) {
      await toRun();
    }
  }
}

/**
 * Interfaz de adaptador de almacenamiento para desacoplar IndexedDB y permitir pruebas unitarias.
 */
export interface StateStorageAdapter {
  save(key: string, value: any): Promise<void>;
  load(key: string): Promise<any>;
  delete?(key: string): Promise<void>;
  listKeys?(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * Adaptador de almacenamiento en memoria para pruebas rápidas y entornos Node.js.
 */
export class MemoryStateStorageAdapter implements StateStorageAdapter {
  private store = new Map<string, string>();

  async save(key: string, value: any): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async load(key: string): Promise<any> {
    const raw = this.store.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Adaptador de almacenamiento nativo en IndexedDB del navegador de la PC (cero dependencias externas).
 * Resuelve la promesa en tx.oncomplete y rechaza en tx.onerror / tx.onabort.
 */
export class IndexedDbStateStorageAdapter implements StateStorageAdapter {
  private dbName: string;
  private storeName: string;
  private dbVersion: number;

  constructor(
    dbName = 'binnitech_pos_db',
    storeName = 'app_state',
    dbVersion = 1
  ) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbVersion = dbVersion;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB no está disponible en este entorno.'));
      }
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async save(key: string, value: any): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Error en transacción IndexedDB al guardar.'));
      };
      tx.onabort = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Transacción IndexedDB abortada al guardar.'));
      };
    });
  }

  async load(key: string): Promise<any> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(key);
      let result: any = null;
      req.onsuccess = () => {
        result = req.result ?? null;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        const err = tx.error || req.error;
        db.close();
        reject(err || new Error('Error en transacción IndexedDB al cargar.'));
      };
      tx.onabort = () => {
        const err = tx.error || req.error;
        db.close();
        reject(err || new Error('Transacción IndexedDB abortada al cargar.'));
      };
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Error en transacción IndexedDB al eliminar.'));
      };
      tx.onabort = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Transacción IndexedDB abortada al eliminar.'));
      };
    });
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAllKeys();
      let keys: string[] = [];
      req.onsuccess = () => {
        const rawKeys = Array.isArray(req.result) ? req.result.map((k) => String(k)) : [];
        keys = prefix ? rawKeys.filter((k) => k.startsWith(prefix)) : rawKeys;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(keys);
      };
      tx.onerror = () => {
        const err = tx.error || req.error;
        db.close();
        reject(err || new Error('Error en transacción IndexedDB al listar claves.'));
      };
      tx.onabort = () => {
        const err = tx.error || req.error;
        db.close();
        reject(err || new Error('Transacción IndexedDB abortada al listar claves.'));
      };
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Error en transacción IndexedDB al limpiar.'));
      };
      tx.onabort = () => {
        const err = tx.error;
        db.close();
        reject(err || new Error('Transacción IndexedDB abortada al limpiar.'));
      };
    });
  }
}

/**
 * Adaptador primario SQLite: la PC consulta y escribe en local-server.
 * IndexedDB conserva una copia espejo y permite continuar si el servidor local no responde.
 * Los endpoints del servidor están protegidos para aceptar únicamente conexiones loopback.
 */
export class ServerStateStorageAdapter implements StateStorageAdapter {
  private readonly fallback: StateStorageAdapter;
  private readonly baseUrl: string;
  private readonly pendingPrefix = '__binnitech_server_pending__';

  constructor(
    fallback: StateStorageAdapter = new IndexedDbStateStorageAdapter(),
    baseUrl = ''
  ) {
    this.fallback = fallback;
    this.baseUrl = baseUrl;
  }

  /** Adaptador local de contingencia (Bloque K lo usa para encontrar la capa de cifrado). */
  get fallbackAdapter(): StateStorageAdapter {
    return this.fallback;
  }

  private get enabled(): boolean {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
    const hostname = window.location?.hostname?.toLowerCase().replace(/^\[|\]$/g, '') || '';
    const localHost = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
    // En `ng serve` (4200, etc.) el mismo origen es Angular, no local-server: usar IndexedDB.
    return localHost && (this.baseUrl.length > 0 || window.location.port === '8443');
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** null significa que el servidor no respondió; los errores HTTP funcionales se propagan. */
  private async request(path: string, init?: RequestInit): Promise<Response | null> {
    if (!this.enabled) return null;
    try {
      const response = await fetch(this.endpoint(path), {
        cache: 'no-store',
        ...init,
      });
      if (response.status >= 500) return null;
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Error del servidor SQLite (${response.status}).`);
      }
      return response;
    } catch (error: any) {
      // No ocultar errores HTTP que indican rechazo de integridad/permisos/validación.
      if (error instanceof Error && /servidor SQLite|Kardex|cadena|hash|integridad/i.test(error.message)) {
        throw error;
      }
      if (error instanceof TypeError || error?.name === 'TypeError') return null;
      throw error;
    }
  }

  private pendingKey(key: string): string {
    return `${this.pendingPrefix}${encodeURIComponent(key)}`;
  }

  private async clearPending(key: string): Promise<void> {
    if (this.fallback.delete) await this.fallback.delete(this.pendingKey(key));
  }

  private async queuePending(key: string, operation: 'save' | 'delete', value?: any): Promise<void> {
    await this.fallback.save(this.pendingKey(key), { key, operation, value });
  }

  /** Reintenta las escrituras que se hicieron en IndexedDB mientras SQLite estuvo desconectado. */
  private async replayPending(): Promise<void> {
    if (!this.enabled || !this.fallback.listKeys || !this.fallback.delete) return;
    const pendingKeys = await this.fallback.listKeys(this.pendingPrefix);
    for (const pendingKey of pendingKeys) {
      const pending = await this.fallback.load(pendingKey);
      if (!pending || typeof pending.key !== 'string') {
        await this.fallback.delete(pendingKey);
        continue;
      }
      const response = pending.operation === 'delete'
        ? await this.request(`/api/estado?key=${encodeURIComponent(pending.key)}`, { method: 'DELETE' })
        : await this.request('/api/estado', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: pending.key, value: pending.value }),
          });
      if (!response) return;
      await this.fallback.delete(pendingKey);
    }
  }

  async save(key: string, value: any): Promise<void> {
    if (!this.enabled) {
      await this.fallback.save(key, value);
      return;
    }
    await this.replayPending();
    const response = await this.request('/api/estado', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (!response) {
      await this.fallback.save(key, value);
      await this.queuePending(key, 'save', value);
      return;
    }
    // SQLite ya confirmó la transacción; el espejo IndexedDB es best-effort.
    try {
      await this.fallback.save(key, value);
      await this.clearPending(key);
    } catch (error) {
      console.warn('[ServerStateStorageAdapter] SQLite guardó el estado, pero falló el espejo IndexedDB:', error);
    }
  }

  async load(key: string): Promise<any> {
    if (!this.enabled) return this.fallback.load(key);
    await this.replayPending();
    const response = await this.request(`/api/estado?key=${encodeURIComponent(key)}`);
    if (!response) return this.fallback.load(key);

    const result = await response.json();
    if (result?.found) {
      try {
        await this.fallback.save(key, result.value);
      } catch (error) {
        console.warn('[ServerStateStorageAdapter] No se pudo actualizar el espejo IndexedDB:', error);
      }
      return result.value ?? null;
    }

    // Primera ejecución: importa el dato antiguo de IndexedDB únicamente si SQLite está vacío.
    const legacyValue = await this.fallback.load(key);
    if (legacyValue === null || legacyValue === undefined) return null;
    let migrationResponse: Response | null;
    try {
      migrationResponse = await this.request('/api/estado/migrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: legacyValue }),
      });
    } catch {
      // Deja que restorePersistedState valide el dato local y active su flujo de recuperación.
      return legacyValue;
    }
    if (!migrationResponse) return legacyValue;
    const migration = await migrationResponse.json();
    const authoritativeValue = migration?.value ?? legacyValue;
    try {
      await this.fallback.save(key, authoritativeValue);
    } catch {
      // La migración SQLite ya quedó confirmada.
    }
    return authoritativeValue;
  }

  async delete(key: string): Promise<void> {
    if (!this.enabled) {
      if (this.fallback.delete) await this.fallback.delete(key);
      return;
    }
    await this.replayPending();
    const response = await this.request(`/api/estado?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (!response) {
      if (this.fallback.delete) await this.fallback.delete(key);
      await this.queuePending(key, 'delete');
      return;
    }
    if (this.fallback.delete) await this.fallback.delete(key);
    await this.clearPending(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    if (!this.enabled) {
      const keys = this.fallback.listKeys ? await this.fallback.listKeys(prefix) : [];
      return keys.filter((key) => !key.startsWith(this.pendingPrefix));
    }
    const response = await this.request(
      `/api/estado/keys${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`
    );
    const localKeys = this.fallback.listKeys ? await this.fallback.listKeys(prefix) : [];
    const serverKeys = response ? (await response.json()).keys || [] : [];
    return Array.from(new Set([...serverKeys, ...localKeys])).filter(
      (key) => !key.startsWith(this.pendingPrefix)
    ).sort();
  }

  async clear(): Promise<void> {
    if (!this.enabled) {
      await this.fallback.clear();
      return;
    }
    const response = await this.request('/api/estado/todo', { method: 'DELETE' });
    if (!response) {
      await this.fallback.clear();
      return;
    }
    await this.fallback.clear();
  }
}

/**
 * Copia el dato crudo dañado a la clave 'binnitech_pos_state_corrupt_<ISO>' sin sobrescribir
 * la clave original y conserva únicamente las 3 copias más recientes.
 */
export async function backupCorruptedState(
  adapter: StateStorageAdapter,
  rawData: any,
  nowIso: string = new Date().toISOString()
): Promise<string> {
  let backupKey = `${CORRUPT_STATE_KEY_PREFIX}${nowIso}`;
  if (adapter.listKeys) {
    const existing = await adapter.listKeys(CORRUPT_STATE_KEY_PREFIX);
    if (existing.includes(backupKey)) {
      backupKey = `${CORRUPT_STATE_KEY_PREFIX}${nowIso}_${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  await adapter.save(backupKey, rawData);

  if (adapter.listKeys && adapter.delete) {
    const allCorruptKeys = await adapter.listKeys(CORRUPT_STATE_KEY_PREFIX);
    allCorruptKeys.sort();
    while (allCorruptKeys.length > MAX_CORRUPT_BACKUPS) {
      const oldest = allCorruptKeys.shift()!;
      await adapter.delete(oldest);
    }
  }

  return backupKey;
}

/**
 * Obtiene el adaptador predeterminado: SQLite en la PC local, IndexedDB en otros
 * navegadores y MemoryAdapter en Node/CLI.
 *
 * `wrapLocalAdapter` permite envolver el almacenamiento del navegador (IndexedDB) sin que este
 * módulo dependa de otros en tiempo de ejecución; el Bloque K lo usa para cifrarlo en reposo.
 * SQLite no se envuelve: el servidor necesita leer el Kardex para verificar su cadena SHA-256.
 */
export function getDefaultStorageAdapter(
  wrapLocalAdapter: (local: StateStorageAdapter) => StateStorageAdapter = (local) => local
): StateStorageAdapter {
  if (typeof window !== 'undefined') {
    const hostname = window.location?.hostname?.toLowerCase().replace(/^\[|\]$/g, '') || '';
    const localHost = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
    if (localHost && window.location.port === '8443') {
      return new ServerStateStorageAdapter(wrapLocalAdapter(new IndexedDbStateStorageAdapter()));
    }
  }
  if (typeof globalThis.indexedDB !== 'undefined') {
    return wrapLocalAdapter(new IndexedDbStateStorageAdapter());
  }
  return new MemoryStateStorageAdapter();
}
