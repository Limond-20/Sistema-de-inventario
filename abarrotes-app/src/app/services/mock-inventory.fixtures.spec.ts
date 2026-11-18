import { createKardexEntry, type KardexEntry } from '../domain/kardex';
import { fromCents, multiplyMoney, toCents } from '../domain/money';
import {
  DEFAULT_MAX_DISCOUNT_PCT_WITHOUT_PIN,
  evaluateNaturalShrinkTolerance,
  normalizePriceTiers,
} from '../domain/catalog';
import { buildDefaultDemoUsers } from '../domain/auth';
import { generateLicenseKeyPair, signLicensePayload } from '../domain/license';
import { type Supplier } from '../domain/suppliers';
import {
  MockInventoryService,
  calculateROP,
  type Product,
  type CreditCustomer,
  type MorningAlert,
  type ReceptionLine,
  type SupplierNote,
  type AuditLine,
  type ShrinkRecord,
  type SupplierRoute,
  type PerishableBatch,
} from './mock-inventory.service';

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

const DEFAULT_CATEGORY_LOCATIONS: Record<string, string> = {
  Lácteos: 'Refrigerador 1 · Puerta 1',
  Aceites: 'Anaquel B · Repisa 2',
  Granos: 'Piso · Báscula',
  Enlatados: 'Anaquel B · Repisa 3',
  Bebidas: 'Refrigerador 2',
  Panadería: 'Isla Central',
  Pastas: 'Anaquel C · Repisa 1',
  Limpieza: 'Anaquel D · Repisa 4',
  Huevo: 'Mostrador · Rejilla',
  Endulzantes: 'Piso · Costales',
};

const PRODUCTS: Product[] = PRODUCT_SEEDS.map((seed) => {
  const hasInternal = seed.barcode.startsWith('200');
  return {
    ...seed,
    unitCost: seed.historicCost,
    barcodes: seed.barcodes && seed.barcodes.length > 0 ? seed.barcodes : [seed.barcode],
    hasInternalBarcode: seed.hasInternalBarcode ?? hasInternal,
    location: seed.location || DEFAULT_CATEGORY_LOCATIONS[seed.category] || 'Pasillo General',
    ivaRate: seed.ivaRate ?? (seed.category === 'Limpieza' ? 16 : 0),
    iepsRate: seed.iepsRate ?? (seed.category === 'Bebidas' ? 8 : 0),
    priceTiers: normalizePriceTiers(seed.salePrice, seed.priceTiers),
    naturalShrinkTolerancePct: seed.naturalShrinkTolerancePct ?? (seed.isBulk ? 3 : 0),
    isActive: seed.isActive ?? true,
    rop: calculateROP(seed.dailySalesRate, seed.supplierLeadTimeDays, seed.safetyStock),
  };
});

export const INITIAL_SUPPLIERS: Supplier[] = [
  {
    id: 'SUP-01',
    name: 'Distribuidora del Bajío',
    phone: '477-123-4567',
    visitDays: ['Lunes', 'Jueves'],
    paymentTerms: 'CREDITO',
    creditDays: 15,
    physicalExchangePolicy: true,
    notes: 'Proveedor principal de abarrotes secos y granos.',
    isActive: true,
    currentBalance: 0,
  },
  {
    id: 'SUP-02',
    name: 'Grupo Lala',
    phone: '800-433-5252',
    visitDays: ['Martes', 'Viernes'],
    paymentTerms: 'CONTADO',
    creditDays: 0,
    physicalExchangePolicy: true,
    notes: 'Lácteos y derivados. Pago contra entrega.',
    isActive: true,
    currentBalance: 0,
  },
  {
    id: 'SUP-03',
    name: 'Grupo Bimbo',
    phone: '800-246-2600',
    visitDays: ['Miércoles', 'Sábado'],
    paymentTerms: 'CREDITO',
    creditDays: 7,
    physicalExchangePolicy: true,
    notes: 'Pan empacado y repostería.',
    isActive: true,
    currentBalance: 0,
  },
];

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

function enrichAuditLineWithTolerance(line: AuditLine, catalog: Product[]): AuditLine {
  const prod = catalog.find((p) => p.sku === line.sku);
  const tolerancePct =
    line.naturalShrinkTolerancePct ??
    prod?.naturalShrinkTolerancePct ??
    (prod?.isBulk ? 3 : 0);
  const evalRes = evaluateNaturalShrinkTolerance(line.systemQty, line.countedQty, tolerancePct);
  return {
    ...line,
    naturalShrinkTolerancePct: evalRes.tolerancePct,
    varianceClassification: evalRes.classification,
    classificationLabel: evalRes.classificationLabel,
    isWithinNaturalTolerance: evalRes.isWithinTolerance && evalRes.classification === 'MERMA_NATURAL',
  };
}

const RAW_AUDIT_LINES: AuditLine[] = [
  { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', location: 'Anaquel B · Repisa 2', saleUnit: 'Pieza', systemQty: 18, countedQty: 15, unitCost: 34.0, status: 'pendiente' },
  { sku: 'ATU-DOL-140', name: 'Atún Dolores en Agua 140g', emoji: '🐟', location: 'Anaquel B · Repisa 3', saleUnit: 'Lata', systemQty: 40, countedQty: 40, unitCost: 16.5, status: 'pendiente' },
  { sku: 'FRI-NEG-50K', name: 'Frijol Negro Granel (1 kg)', emoji: '🫘', location: 'Piso · Junto a báscula', saleUnit: 'Kg', systemQty: 16.5, countedQty: 14.8, unitCost: 28.0, status: 'pendiente' },
  { sku: 'ARR-SOS-900', name: 'Arroz SOS Súper Extra 900g', emoji: '🍚', location: 'Anaquel C · Repisa 1', saleUnit: 'Pieza', systemQty: 16, countedQty: 18, unitCost: 27.6, status: 'pendiente' },
  { sku: 'CHI-LAC-220', name: 'Chiles Jalapeños La Costeña 220g', emoji: '🌶️', location: 'Anaquel C · Repisa 2', saleUnit: 'Lata', systemQty: 24, countedQty: 21, unitCost: 14.2, status: 'pendiente' },
];

const AUDIT_LINES: AuditLine[] = RAW_AUDIT_LINES.map((l) => enrichAuditLineWithTolerance(l, PRODUCTS));

const SHRINK_RECORDS: ShrinkRecord[] = [
  { id: 'M-0412', date: '22/10/2026', time: '9:15 a.m.', sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', emoji: '🥛', qty: 2, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 21.0, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0411', date: '21/10/2026', time: '11:40 a.m.', sku: 'HUE-BAC-18', name: 'Huevo Blanco Granel (1 kg)', emoji: '🥚', qty: 1, saleUnit: 'Kg', reason: 'Envase Roto en Piso', unitCost: 36.0, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0410', date: '20/10/2026', time: '8:05 p.m.', sku: 'YOG-YOP-1K', name: 'Yoghurt Yoplait Fresa 1kg', emoji: '🍓', qty: 3, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41.3, registeredBy: 'Celular · Encargado', hasPhoto: true, reviewed: false },
  { id: 'M-0409', date: '19/10/2026', time: '9:30 a.m.', sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo Grande 680g', emoji: '🍞', qty: 2, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: true },
  { id: 'M-0408', date: '18/10/2026', time: '5:50 p.m.', sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', qty: 1, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 34.0, registeredBy: 'Celular · Encargado', hasPhoto: true, reviewed: true },
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
  // Cadena criptográfica semilla (orden cronológico ascendente):
  // Incluye entradas iniciales para cada producto del catálogo base para garantizar
  // que verifyProductContinuity(productos, kardex) valide cada SKU desde el arranque.
  const chronoEntries: KardexEntry[] = [];
  let prevHash = 'GENESIS';

  for (const p of PRODUCTS) {
    const initEntry = createKardexEntry(
      {
        type: 'ENTRADA_COMPRA',
        producto: { sku: p.sku, name: p.name, saleUnit: p.saleUnit },
        cantidad: p.stock,
        saldoAnterior: 0,
        saldoResultante: p.stock,
        usuario: 'Don Lupe (Encargado)',
        referencia: `Inventario inicial (${p.sku})`,
        amount: multiplyMoney(p.historicCost, p.stock),
        description: `Existencia inicial de catálogo: ${p.stock} ${p.saleUnit} de ${p.name}`,
      },
      prevHash
    );
    chronoEntries.push(initEntry);
    prevHash = initEntry.entryHash;
  }

  const e1 = createKardexEntry(
    {
      type: 'VENTA_EFECTIVO',
      producto: { sku: 'VAR-01', name: 'Leche Lala, Bolillos, Queso' },
      cantidad: -3,
      saldoAnterior: 10,
      saldoResultante: 7,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Ticket #0101',
      amount: 112.0,
      description: 'Venta de mostrador en efectivo (Leche Lala, Bolillos, Queso)',
    },
    prevHash
  );
  chronoEntries.push(e1);

  const e2 = createKardexEntry(
    {
      type: 'VENTA_FIADO',
      producto: { sku: 'CLI-04', name: 'Don Roberto Hernández' },
      cantidad: -3,
      saldoAnterior: 0,
      saldoResultante: 145.0,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Libreta Fiado #102',
      amount: 145.0,
      description: 'Venta anotada en libreta a Don Roberto Hernández (3 art.)',
    },
    e1.entryHash
  );
  chronoEntries.push(e2);

  const e3 = createKardexEntry(
    {
      type: 'ABONO_FIADO',
      producto: { sku: 'CLI-03', name: 'Doña María López - Casa Azul' },
      cantidad: 0,
      saldoAnterior: 150.0,
      saldoResultante: 0,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Abono Doña María López',
      amount: 150.0,
      description: 'Abono en efectivo de Doña María López - Casa Azul',
    },
    e2.entryHash
  );
  chronoEntries.push(e3);

  // Se retorna newest-first
  return chronoEntries.reverse();
}

export {
  PRODUCTS,
  CREDIT_CUSTOMERS,
  MORNING_ALERTS,
  AUDIT_LINES,
  SHRINK_RECORDS,
  buildInitialKardex,
  buildOcrNote,
};

let cachedTestKeyPair: { privateKeyJwk: JsonWebKey; publicKeyJwk: JsonWebKey } | null = null;

export async function getTestLicensePublicKeyJwk(): Promise<JsonWebKey> {
  if (!cachedTestKeyPair) {
    cachedTestKeyPair = await generateLicenseKeyPair();
  }
  return cachedTestKeyPair.publicKeyJwk;
}

export async function applyTestLicenseOnly(service: MockInventoryService): Promise<void> {
  if (!cachedTestKeyPair) {
    cachedTestKeyPair = await generateLicenseKeyPair();
  }
  service.setLicensePublicKeyForTesting(cachedTestKeyPair.publicKeyJwk);
  const code = await signLicensePayload(
    {
      idInstalación: service.installationId(),
      plan: 'ANUAL',
      emitida: '2026-01-01',
      vence: '2028-12-31',
    },
    cachedTestKeyPair.privateKeyJwk
  );
  service.licenseCode.set(code);
  await service.refreshLicenseState();
}

export async function resetMockServiceToTestFixtures(
  service: MockInventoryService,
  options?: { issueFreshLicense?: boolean; skipUsersReset?: boolean; includeEmptyOcrNote?: boolean }
): Promise<void> {
  if (options?.issueFreshLicense !== false) {
    await applyTestLicenseOnly(service);
  }

  if (!options?.skipUsersReset) {
    service.users.set(buildDefaultDemoUsers());
    const defaultUser = service.users().find((u) => u.name.includes('Don Lupe')) || service.users()[0];
    service.currentUser.set(defaultUser || null);
    service.activeUser.set(defaultUser ? defaultUser.name : 'Don Lupe (Encargado)');
  }
  service.autoSaveBlocked.set(false);
  service.corruptedDataWarning.set(null);
  service.corruptedModalOpen.set(false);
  service.corruptedConfirmOverwrite.set(false);
  service.products.set(structuredClone(PRODUCTS));
  service.creditCustomers.set(structuredClone(CREDIT_CUSTOMERS));
  service.cashShift.set({
    openingCash: 500.0,
    cashSalesTotal: 0.0,
    creditPaymentsReceived: 0.0,
    creditSalesTotal: 0.0,
    internalConsumptionTotalCost: 0.0,
    shrinkTotalCost: 0.0,
  });
  service.cashRegister.set({
    openingFloat: 500.0,
    cashSalesTotal: 0.0,
    creditSalesTotal: 0.0,
    creditPaymentsReceived: 0.0,
  });
  service.internalConsumptionRecords.set([]);
  service.kardex.set(buildInitialKardex());
  service.morningAlerts.set(structuredClone(MORNING_ALERTS));
  service.auditLines.set(structuredClone(AUDIT_LINES));
  service.shrinkRecords.set(structuredClone(SHRINK_RECORDS));
  service.supplierRoutes.set(structuredClone(SUPPLIER_ROUTES));
  service.suppliers.set(structuredClone(INITIAL_SUPPLIERS));
  service.perishableBatches.set(structuredClone(PERISHABLE_BATCHES));
  service.ocrNote.set(buildOcrNote());
  service.pinnedQuickAccessSkus.set([
    'HUE-BAC-18',
    'FRI-NEG-50K',
    'AZU-ZUL-1K',
    'QUE-FRE-1K',
    'PAN-BOL-PZ',
  ]);
  service.accountsPayable.set([]);
  service.productPriceHistory.set([]);
  service.cashMovements.set([]);
  service.salesHistory.set([]);
  service.usageActivityLog.set([]);
  service.satisfactionSurveys.set([]);
  service.saleReturns.set([]);
  service.shiftCloseRecords.set([]);
  service.isShiftOpen.set(true);
  service.currentShiftId.set('TURNO-1');
  service.shiftOpenedBy.set('Don Lupe (Encargado)');
  service.maxDiscountPctWithoutPin.set(DEFAULT_MAX_DISCOUNT_PCT_WITHOUT_PIN);
}
