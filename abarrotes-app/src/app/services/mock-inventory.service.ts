import { Injectable, computed, signal } from '@angular/core';

// =====================================================================
//  MODELOS
// =====================================================================

export type PurchaseUnit = 'Caja' | 'Costal' | 'Paquete' | 'Charola';
export type SaleUnit = 'Pieza' | 'Kg' | 'Lata' | 'Paquete';

export interface Product {
  sku: string;
  barcode: string;
  name: string;
  category: string;
  emoji: string;
  purchaseUnit: PurchaseUnit;
  /** Cuántas unidades de venta trae una unidad de compra (ej. caja c/12). */
  unitsPerPurchase: number;
  saleUnit: SaleUnit;
  /** Costo histórico por unidad de venta (MXN). */
  historicCost: number;
  /** Costo más reciente por unidad de venta (MXN). */
  newCost: number;
  /** Precio de venta actual al público por unidad de venta (MXN). */
  salePrice: number;
  /** Margen mínimo deseado (%) sobre precio de venta. */
  targetMargin: number;
  /** Fecha de caducidad del lote en anaquel (ISO yyyy-mm-dd). */
  expiry: string;
  stock: number;
  minStock: number;
  supplier: string;
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
//  UTILIDADES DE MARGEN
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

// =====================================================================
//  DATOS SIMULADOS (Abarrotes Doña Lupe · León, Gto.)
// =====================================================================

const PRODUCTS: Product[] = [
  { sku: 'LAC-LAL-1L', barcode: '7501020515343', name: 'Leche Lala Entera 1L', category: 'Lácteos', emoji: '🥛', purchaseUnit: 'Caja', unitsPerPurchase: 12, saleUnit: 'Pieza', historicCost: 24.5, newCost: 24.5, salePrice: 30, targetMargin: 15, expiry: '2026-10-19', stock: 48, minStock: 24, supplier: 'Grupo Lala' },
  { sku: 'HUE-BAC-18', barcode: '7501069210117', name: 'Huevo Blanco Bachoco 18 pzas', category: 'Huevo', emoji: '🥚', purchaseUnit: 'Charola', unitsPerPurchase: 1, saleUnit: 'Paquete', historicCost: 58, newCost: 58, salePrice: 72, targetMargin: 18, expiry: '2026-11-02', stock: 3, minStock: 10, supplier: 'Bachoco' },
  { sku: 'ACE-NUT-850', barcode: '7501039120651', name: 'Aceite Nutrioli 850ml', category: 'Aceites', emoji: '🫒', purchaseUnit: 'Caja', unitsPerPurchase: 12, saleUnit: 'Pieza', historicCost: 42.5, newCost: 47, salePrice: 51, targetMargin: 15, expiry: '2027-06-30', stock: 18, minStock: 12, supplier: 'Distribuidora del Bajío' },
  { sku: 'ATU-DOL-140', barcode: '7501045401249', name: 'Atún Dolores en Agua 140g', category: 'Enlatados', emoji: '🐟', purchaseUnit: 'Caja', unitsPerPurchase: 24, saleUnit: 'Lata', historicCost: 20.5, newCost: 20.5, salePrice: 26, targetMargin: 18, expiry: '2028-03-15', stock: 40, minStock: 24, supplier: 'Distribuidora del Bajío' },
  { sku: 'FRI-NEG-50K', barcode: '2000000500017', name: 'Frijol Negro Granel Costal 50kg', category: 'Granos', emoji: '🫘', purchaseUnit: 'Costal', unitsPerPurchase: 50, saleUnit: 'Kg', historicCost: 24.5, newCost: 29, salePrice: 32, targetMargin: 20, expiry: '2027-04-01', stock: 22.5, minStock: 10, supplier: 'Distribuidora del Bajío' },
  { sku: 'ARR-SOS-900', barcode: '7501052410012', name: 'Arroz SOS Súper Extra 900g', category: 'Granos', emoji: '🍚', purchaseUnit: 'Caja', unitsPerPurchase: 20, saleUnit: 'Pieza', historicCost: 27.6, newCost: 27.6, salePrice: 34, targetMargin: 15, expiry: '2027-08-20', stock: 12, minStock: 10, supplier: 'Distribuidora del Bajío' },
  { sku: 'PAS-MOD-200', barcode: '7501018310103', name: 'Pasta La Moderna Fideo 200g', category: 'Pastas', emoji: '🍝', purchaseUnit: 'Caja', unitsPerPurchase: 40, saleUnit: 'Pieza', historicCost: 9.9, newCost: 9.9, salePrice: 13, targetMargin: 20, expiry: '2027-12-10', stock: 35, minStock: 20, supplier: 'Distribuidora del Bajío' },
  { sku: 'AZU-ZUL-1K', barcode: '7501031311200', name: 'Azúcar Estándar Zulka 1kg', category: 'Endulzantes', emoji: '🧂', purchaseUnit: 'Caja', unitsPerPurchase: 10, saleUnit: 'Pieza', historicCost: 31.8, newCost: 31.8, salePrice: 38, targetMargin: 12, expiry: '2028-01-01', stock: 14, minStock: 10, supplier: 'Distribuidora del Bajío' },
  { sku: 'CHI-LAC-220', barcode: '7501017004200', name: 'Chiles Jalapeños La Costeña 220g', category: 'Enlatados', emoji: '🌶️', purchaseUnit: 'Caja', unitsPerPurchase: 24, saleUnit: 'Lata', historicCost: 14.2, newCost: 14.2, salePrice: 19, targetMargin: 20, expiry: '2028-05-30', stock: 24, minStock: 12, supplier: 'Distribuidora del Bajío' },
  { sku: 'HAR-MAS-1K', barcode: '7501018540100', name: 'Harina de Maíz Maseca 1kg', category: 'Harinas', emoji: '🌽', purchaseUnit: 'Caja', unitsPerPurchase: 10, saleUnit: 'Pieza', historicCost: 21.4, newCost: 21.4, salePrice: 27, targetMargin: 18, expiry: '2027-02-14', stock: 4, minStock: 10, supplier: 'Gruma' },
  { sku: 'YOG-YOP-1K', barcode: '7501032394820', name: 'Yoghurt Yoplait Fresa 1kg', category: 'Lácteos', emoji: '🍓', purchaseUnit: 'Caja', unitsPerPurchase: 6, saleUnit: 'Pieza', historicCost: 41.3, newCost: 41.3, salePrice: 52, targetMargin: 18, expiry: '2026-10-20', stock: 9, minStock: 6, supplier: 'Sigma Alimentos' },
  { sku: 'PAN-BIM-680', barcode: '7441029502004', name: 'Pan Blanco Bimbo Grande 680g', category: 'Panadería', emoji: '🍞', purchaseUnit: 'Charola', unitsPerPurchase: 8, saleUnit: 'Pieza', historicCost: 41, newCost: 41, salePrice: 50, targetMargin: 16, expiry: '2026-10-18', stock: 7, minStock: 6, supplier: 'Grupo Bimbo' },
  { sku: 'REF-COC-600', barcode: '7501055300075', name: 'Coca-Cola Original 600ml', category: 'Bebidas', emoji: '🥤', purchaseUnit: 'Paquete', unitsPerPurchase: 24, saleUnit: 'Pieza', historicCost: 14.1, newCost: 14.1, salePrice: 19, targetMargin: 22, expiry: '2027-01-25', stock: 6, minStock: 24, supplier: 'Arca Continental' },
  { sku: 'JAB-ZOT-400', barcode: '7501026006012', name: 'Jabón Zote Rosa 400g', category: 'Limpieza', emoji: '🧼', purchaseUnit: 'Caja', unitsPerPurchase: 25, saleUnit: 'Pieza', historicCost: 18.6, newCost: 18.6, salePrice: 25, targetMargin: 22, expiry: '2029-09-01', stock: 30, minStock: 12, supplier: 'Distribuidora del Bajío' },
];

const MORNING_ALERTS: MorningAlert[] = [
  { id: 'A1', kind: 'cambio-fisico', icon: '⚠️', title: 'Separar 4 cajas de Leche Lala Entera 1L', detail: 'Caduca el domingo 19 de octubre. El repartidor de Lala viene mañana a las 8:00 a.m. para hacer el cambio físico.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A2', kind: 'cambio-fisico', icon: '⚠️', title: 'Separar 7 piezas de Pan Blanco Bimbo Grande', detail: 'Caduca mañana sábado 18. Ponlas en la caja de devoluciones; el repartidor de Bimbo pasa hoy a las 4:00 p.m.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A3', kind: 'cambio-fisico', icon: '⚠️', title: 'Separar 9 Yoghurt Yoplait Fresa 1kg', detail: 'Caduca el martes 20. Sigma Alimentos acepta cambio físico solo con 2 días de anticipación.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A4', kind: 'margen', icon: '🔺', title: 'Nota #DB-20931: 2 productos subieron de costo', detail: 'Aceite Nutrioli y Frijol Negro Granel ahora te dejan menos ganancia. Revísalos antes de guardar la mercancía.', actionLabel: 'Revisar nota', route: '/recepcion' },
  { id: 'A5', kind: 'por-agotarse', icon: '📉', title: 'Quedan solo 3 paquetes de Huevo Bachoco 18 pzas', detail: 'Se venden unos 6 al día. Pídelo hoy para que no te falte el fin de semana.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A6', kind: 'por-agotarse', icon: '📉', title: 'Quedan 6 Coca-Cola 600ml y 4 Maseca 1kg', detail: 'Arca Continental pasa el lunes. Gruma (Maseca) pasa el miércoles.', actionLabel: 'Ver en catálogo', route: '/catalogo' },
  { id: 'A7', kind: 'auditoria', icon: '📋', title: 'Llegó el conteo del Pasillo 3 desde el celular', detail: 'Hay 3 productos con diferencias. Revisa antes de cerrar caja.', actionLabel: 'Revisar conteo', route: '/auditoria' },
];

function buildLine(sku: string, qtyPurchase: number, lineTotal: number): ReceptionLine {
  const p = PRODUCTS.find((x) => x.sku === sku)!;
  return {
    sku: p.sku,
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
    date: '17/10/2026',
    driver: 'J. Ramírez',
    route: 'Ruta 14',
    receivedFrom: 'Celular de Apoyo · 6:58 p.m.',
    lines: [
      buildLine('ACE-NUT-850', 2, 1128.0), // $47.00 c/u → margen 8% (subió)
      buildLine('ATU-DOL-140', 3, 1476.0),
      buildLine('FRI-NEG-50K', 1, 1450.0), // $29.00/kg → margen 9% (subió)
      buildLine('ARR-SOS-900', 2, 1104.0),
      buildLine('PAS-MOD-200', 1, 396.0),
      buildLine('AZU-ZUL-1K', 2, 636.0),
    ],
  };
}

const AUDIT_LINES: AuditLine[] = [
  { sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', location: 'Anaquel B · Repisa 2', saleUnit: 'Pieza', systemQty: 18, countedQty: 15, unitCost: 42.5, status: 'pendiente' },
  { sku: 'ATU-DOL-140', name: 'Atún Dolores en Agua 140g', emoji: '🐟', location: 'Anaquel B · Repisa 3', saleUnit: 'Lata', systemQty: 40, countedQty: 40, unitCost: 20.5, status: 'pendiente' },
  { sku: 'FRI-NEG-50K', name: 'Frijol Negro Granel (costal abierto)', emoji: '🫘', location: 'Piso · Junto a báscula', saleUnit: 'Kg', systemQty: 22.5, countedQty: 19.8, unitCost: 24.5, status: 'pendiente' },
  { sku: 'ARR-SOS-900', name: 'Arroz SOS Súper Extra 900g', emoji: '🍚', location: 'Anaquel C · Repisa 1', saleUnit: 'Pieza', systemQty: 12, countedQty: 14, unitCost: 27.6, status: 'pendiente' },
  { sku: 'CHI-LAC-220', name: 'Chiles Jalapeños La Costeña 220g', emoji: '🌶️', location: 'Anaquel C · Repisa 2', saleUnit: 'Lata', systemQty: 24, countedQty: 21, unitCost: 14.2, status: 'pendiente' },
];

const SHRINK_RECORDS: ShrinkRecord[] = [
  { id: 'M-0412', date: '17/10/2026', time: '6:15 p.m.', sku: 'LAC-LAL-1L', name: 'Leche Lala Entera 1L', emoji: '🥛', qty: 2, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 24.5, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0411', date: '17/10/2026', time: '11:40 a.m.', sku: 'HUE-BAC-18', name: 'Huevo Blanco Bachoco 18 pzas', emoji: '🥚', qty: 1, saleUnit: 'Paquete', reason: 'Envase Roto en Piso', unitCost: 58, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: false },
  { id: 'M-0410', date: '16/10/2026', time: '8:05 p.m.', sku: 'YOG-YOP-1K', name: 'Yoghurt Yoplait Fresa 1kg', emoji: '🍓', qty: 3, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41.3, registeredBy: 'Celular · Doña Lupe', hasPhoto: true, reviewed: false },
  { id: 'M-0409', date: '15/10/2026', time: '9:30 a.m.', sku: 'PAN-BIM-680', name: 'Pan Blanco Bimbo Grande 680g', emoji: '🍞', qty: 2, saleUnit: 'Pieza', reason: 'Caducado sin devolución', unitCost: 41, registeredBy: 'Celular · Toño', hasPhoto: true, reviewed: true },
  { id: 'M-0408', date: '14/10/2026', time: '5:50 p.m.', sku: 'ACE-NUT-850', name: 'Aceite Nutrioli 850ml', emoji: '🫒', qty: 1, saleUnit: 'Pieza', reason: 'Envase Roto en Piso', unitCost: 42.5, registeredBy: 'Celular · Doña Lupe', hasPhoto: true, reviewed: true },
];

// =====================================================================
//  SERVICIO
// =====================================================================

@Injectable({ providedIn: 'root' })
export class MockInventoryService {
  readonly storeName = 'Abarrotes Doña Lupe';
  readonly today = 'Sábado 17 de octubre de 2026';

  readonly products = signal<Product[]>(structuredClone(PRODUCTS));
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

  // ---------- Recepción ----------

  /** Nota nueva (simula volver a recibirla desde el celular). */
  reloadOcrNote(): void {
    this.ocrNote.set(buildOcrNote());
  }

  /** Crea una línea manual a partir de un producto del catálogo. */
  createManualLine(sku: string, qtyPurchase: number, costPerPurchaseUnit: number): ReceptionLine {
    const line = buildLine(sku, qtyPurchase, +(qtyPurchase * costPerPurchaseUnit).toFixed(2));
    const p = this.products().find((x) => x.sku === sku)!;
    line.salePrice = p.salePrice;
    line.historicCost = p.historicCost;
    return line;
  }

  /** Guarda la entrada: suma existencias, actualiza costos y precios. */
  saveReception(lines: ReceptionLine[], folio: string): void {
    this.products.update((list) =>
      list.map((p) => {
        const line = lines.find((l) => l.sku === p.sku);
        if (!line) return p;
        return {
          ...p,
          stock: +(p.stock + line.qtyPurchase * line.unitsPerPurchase).toFixed(2),
          historicCost: line.newCost,
          newCost: line.newCost,
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
