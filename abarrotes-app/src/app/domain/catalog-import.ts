/**
 * Lógica pura para importación masiva de catálogo desde CSV y Excel (.xlsx):
 * - Generación de plantilla CSV con BOM UTF-8 compatible con Excel en español.
 * - Parser RFC-4180 tolerante a delimitador coma (,) o punto y coma (;), comillas y saltos de línea.
 * - Mapeo flexible de encabezados en español e inglés/aliases comunes.
 * - Previsualización con errores por fila, advertencias, duplicados intra-archivo y existentes,
 *   regla de permisos por rol en actualización de precios y normalización de fechas Excel/ISO.
 */

export type CatalogImportDuplicateMode = 'SKIP' | 'UPDATE';
export type CatalogImportRowStatus = 'VALID' | 'WARNING' | 'SKIPPED' | 'ERROR';
export type CatalogImportRowAction = 'CREATE' | 'UPDATE' | 'SKIP' | 'NONE';

export type ImportSaleUnit = 'Pieza' | 'Kg' | 'g' | 'L' | 'Lata' | 'Paquete';
export type ImportPurchaseUnit =
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

export interface CatalogImportNormalizedProduct {
  name: string;
  barcodes: string[];
  sku: string;
  category: string;
  location: string;
  salePrice: number;
  cost: number;
  saleUnit: ImportSaleUnit;
  purchaseUnit: ImportPurchaseUnit;
  unitsPerPurchase: number;
  initialStock: number;
  minStock: number;
  rop: number;
  ivaRate: number;
  iepsRate: number;
  supplier: string;
  expiry: string;
  isBulk: boolean;
  naturalShrinkTolerancePct: number;
  useInternalBarcode: boolean;
}

export interface CatalogImportRowPreview {
  rowNumber: number;
  rawName: string;
  action: CatalogImportRowAction;
  status: CatalogImportRowStatus;
  matchedExistingSku?: string;
  matchedExistingName?: string;
  errors: string[];
  warnings: string[];
  normalized: CatalogImportNormalizedProduct;
}

export interface CatalogImportPreviewResult {
  headerError?: string;
  rows: CatalogImportRowPreview[];
  totalRows: number;
  toCreateCount: number;
  toUpdateCount: number;
  skippedCount: number;
  errorCount: number;
  warningCount: number;
  requiresPin: boolean;
}

export interface ExistingCatalogProductLike {
  sku: string;
  name: string;
  barcode?: string;
  barcodes?: readonly string[];
  salePrice: number;
  historicCost?: number;
  unitCost?: number;
  category?: string;
  location?: string;
  supplier?: string;
  saleUnit?: string;
  purchaseUnit?: string;
  unitsPerPurchase?: number;
  minStock?: number;
  rop?: number;
  ivaRate?: number;
  iepsRate?: number;
  expiry?: string;
  isBulk?: boolean;
  naturalShrinkTolerancePct?: number;
  isActive?: boolean;
}

export const CATALOG_IMPORT_TEMPLATE_HEADERS: readonly string[] = [
  'Nombre',
  'Código de barras',
  'Clave interna',
  'Categoría',
  'Ubicación',
  'Precio de venta',
  'Costo unitario',
  'Unidad de venta',
  'Unidad de compra',
  'Unidades por empaque',
  'Stock inicial',
  'Stock mínimo',
  'Avisar para resurtir',
  'IVA %',
  'IEPS %',
  'Proveedor',
  'Caducidad',
  'A granel',
];

function escapeCsvCell(value: string | number): string {
  const str = String(value ?? '');
  if (/[",\r\n;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Genera una plantilla CSV UTF-8 con BOM y dos filas de ejemplo listas para abrir en Excel.
 */
export function generateCatalogImportCsvTemplate(): string {
  const sampleRows: (string | number)[][] = [
    [
      'Galletas Emperador Chocolate 109g',
      '7501000673216',
      '',
      'Abarrotes',
      'Anaquel A · Repisa 2',
      '20.00',
      '14.50',
      'Pieza',
      'Caja',
      '12',
      '24',
      '6',
      '8',
      '0',
      '0',
      'Gamesa',
      '2027-06-30',
      'NO',
    ],
    [
      'Frijol Bayo Granel',
      '',
      '',
      'Granos',
      'Piso · Báscula',
      '38.00',
      '29.00',
      'Kg',
      'Costal',
      '50',
      '25',
      '10',
      '15',
      '0',
      '0',
      'Abarrotera del Centro',
      '2027-12-31',
      'SI',
    ],
  ];

  const lines = [
    CATALOG_IMPORT_TEMPLATE_HEADERS.map(escapeCsvCell).join(','),
    ...sampleRows.map((row) => row.map(escapeCsvCell).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function detectCsvDelimiter(firstLineSample: string): ',' | ';' {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (let i = 0; i < firstLineSample.length; i++) {
    const ch = firstLineSample[i];
    if (ch === '"') {
      if (inQuotes && firstLineSample[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (ch === ',') commas++;
      else if (ch === ';') semicolons++;
    }
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Parsea texto CSV (RFC-4180) soportando BOM UTF-8, delimitador `,` o `;` (Excel en español),
 * comillas escapadas `""` y saltos de línea dentro de celdas entrecomilladas.
 */
export function parseCsvText(rawText: string): string[][] {
  const clean = String(rawText ?? '').replace(/^\uFEFF/, '');
  if (!clean.trim()) return [];

  const firstBreak = clean.search(/\r\n|\r|\n/);
  const firstLine = firstBreak >= 0 ? clean.slice(0, firstBreak) : clean;
  const delimiter = detectCsvDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (clean[i + 1] === '\n') i++;
      row.push(field.trim());
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field.trim());
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some((c) => c.length > 0)) {
    rows.push(row);
  }
  return rows;
}

function normalizeHeaderKey(header: string): string {
  return String(header ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[%().:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type ImportFieldKey =
  | 'name'
  | 'barcode'
  | 'sku'
  | 'category'
  | 'location'
  | 'salePrice'
  | 'cost'
  | 'saleUnit'
  | 'purchaseUnit'
  | 'unitsPerPurchase'
  | 'initialStock'
  | 'minStock'
  | 'rop'
  | 'ivaRate'
  | 'iepsRate'
  | 'supplier'
  | 'expiry'
  | 'isBulk';

const HEADER_ALIAS_MAP: Record<string, ImportFieldKey> = {
  nombre: 'name',
  'nombre del producto': 'name',
  producto: 'name',
  descripcion: 'name',
  articulo: 'name',
  'codigo de barras': 'barcode',
  codigo: 'barcode',
  codigos: 'barcode',
  'codigos de barras': 'barcode',
  barras: 'barcode',
  ean: 'barcode',
  ean13: 'barcode',
  'ean 13': 'barcode',
  upc: 'barcode',
  'clave interna': 'sku',
  clave: 'sku',
  sku: 'sku',
  categoria: 'category',
  departamento: 'category',
  familia: 'category',
  ubicacion: 'location',
  pasillo: 'location',
  anaquel: 'location',
  'precio de venta': 'salePrice',
  precio: 'salePrice',
  'precio publico': 'salePrice',
  'precio menudeo': 'salePrice',
  'precio unitario': 'salePrice',
  pvp: 'salePrice',
  'costo unitario': 'cost',
  costo: 'cost',
  'costo compra': 'cost',
  'costo de compra': 'cost',
  'ultimo costo': 'cost',
  'costo por unidad': 'cost',
  'unidad de venta': 'saleUnit',
  unidad: 'saleUnit',
  'u venta': 'saleUnit',
  'unidad de compra': 'purchaseUnit',
  empaque: 'purchaseUnit',
  'u compra': 'purchaseUnit',
  presentacion: 'purchaseUnit',
  'unidades por empaque': 'unitsPerPurchase',
  'unidades por compra': 'unitsPerPurchase',
  factor: 'unitsPerPurchase',
  'piezas por caja': 'unitsPerPurchase',
  contenido: 'unitsPerPurchase',
  'stock inicial': 'initialStock',
  'existencia inicial': 'initialStock',
  existencia: 'initialStock',
  existencias: 'initialStock',
  stock: 'initialStock',
  'inventario inicial': 'initialStock',
  'cantidad inicial': 'initialStock',
  'stock minimo': 'minStock',
  minimo: 'minStock',
  'existencia minima': 'minStock',
  'avisar para resurtir': 'rop',
  'aviso resurtido': 'rop',
  'punto de reorden': 'rop',
  rop: 'rop',
  iva: 'ivaRate',
  'iva %': 'ivaRate',
  'tasa iva': 'ivaRate',
  ieps: 'iepsRate',
  'ieps %': 'iepsRate',
  'tasa ieps': 'iepsRate',
  proveedor: 'supplier',
  distribuidor: 'supplier',
  caducidad: 'expiry',
  'fecha de caducidad': 'expiry',
  vencimiento: 'expiry',
  'a granel': 'isBulk',
  granel: 'isBulk',
  bascula: 'isBulk',
  'venta a granel': 'isBulk',
};

function parseLocaleMoneyOrNumber(raw: string | undefined): number | null {
  const s = String(raw ?? '').trim().replace(/\$/g, '').replace(/\s+/g, '');
  if (!s) return null;
  let normalized = s;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, '');
  } else if (/^\d+,\d{1,4}$/.test(normalized) && !normalized.includes('.')) {
    normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function roundMoneyCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  // Época Excel Windows: 1899-12-30 (compensa el año bisiesto ficticio 1900 de Lotus)
  const utcMs = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(utcMs);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function normalizeImportDate(raw: string | undefined, fallback = '2027-12-31'): {
  iso: string;
  valid: boolean;
} {
  const clean = String(raw ?? '').trim();
  if (!clean) return { iso: fallback, valid: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return { iso: clean, valid: true };
  }
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(clean);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1990 && year <= 2100) {
      return {
        iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        valid: true,
      };
    }
    return { iso: fallback, valid: false };
  }
  if (/^\d{4,6}(\.\d+)?$/.test(clean)) {
    const iso = excelSerialToIsoDate(Number(clean));
    if (iso) return { iso, valid: true };
  }
  return { iso: fallback, valid: false };
}

function normalizeSaleUnit(raw: string | undefined): { unit: ImportSaleUnit; valid: boolean } {
  const key = normalizeHeaderKey(raw ?? '');
  if (!key) return { unit: 'Pieza', valid: true };
  if (['pieza', 'piezas', 'pza', 'pz', 'unidad'].includes(key)) return { unit: 'Pieza', valid: true };
  if (['kg', 'kilo', 'kilogramo', 'kilogramos'].includes(key)) return { unit: 'Kg', valid: true };
  if (['g', 'gr', 'gramo', 'gramos'].includes(key)) return { unit: 'g', valid: true };
  if (['l', 'lt', 'litro', 'litros'].includes(key)) return { unit: 'L', valid: true };
  if (['lata', 'latas'].includes(key)) return { unit: 'Lata', valid: true };
  if (['paquete', 'paquetes', 'paq'].includes(key)) return { unit: 'Paquete', valid: true };
  return { unit: 'Pieza', valid: false };
}

function normalizePurchaseUnit(raw: string | undefined, saleUnit: ImportSaleUnit): ImportPurchaseUnit {
  const key = normalizeHeaderKey(raw ?? '');
  if (!key) {
    return saleUnit === 'Kg' || saleUnit === 'g' || saleUnit === 'L' ? 'Costal' : 'Pieza';
  }
  if (key === 'caja' || key === 'cajas') return 'Caja';
  if (key === 'bulto' || key === 'bultos') return 'Bulto';
  if (key === 'costal' || key === 'costales') return 'Costal';
  if (key === 'paquete' || key === 'paquetes' || key === 'paq') return 'Paquete';
  if (key === 'charola' || key === 'charolas') return 'Charola';
  if (key === 'kg' || key === 'kilo') return 'Kg';
  if (key === 'g' || key === 'gr') return 'g';
  if (key === 'l' || key === 'lt' || key === 'litro') return 'L';
  if (key === 'lata' || key === 'latas') return 'Lata';
  return 'Pieza';
}

function parseBoolFlag(raw: string | undefined): boolean {
  const key = normalizeHeaderKey(raw ?? '');
  return ['si', '1', 'true', 'yes', 'x', 'granel'].includes(key);
}

function canonicalBarcodeKeys(raw: string): string[] {
  const clean = String(raw || '').trim();
  if (!clean) return [];
  if (!/^\d+$/.test(clean)) return [clean];
  if (clean.length === 12) return [clean, '0' + clean];
  if (clean.length === 13 && clean.startsWith('0')) return [clean, clean.slice(1)];
  return [clean];
}

function isBarcodeCheckDigitValid(raw: string): { checked: boolean; valid: boolean } {
  const clean = String(raw || '').trim();
  if (!/^\d+$/.test(clean)) return { checked: false, valid: true };
  if (clean.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const d = Number(clean[i]);
      sum += i % 2 === 0 ? d : d * 3;
    }
    const check = (10 - (sum % 10)) % 10;
    return { checked: true, valid: check === Number(clean[12]) };
  }
  if (clean.length === 12) {
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      const d = Number(clean[i]);
      sum += i % 2 === 0 ? d * 3 : d;
    }
    const check = (10 - (sum % 10)) % 10;
    return { checked: true, valid: check === Number(clean[11]) };
  }
  if (clean.length === 8) {
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const d = Number(clean[i]);
      sum += i % 2 === 0 ? d * 3 : d;
    }
    const check = (10 - (sum % 10)) % 10;
    return { checked: true, valid: check === Number(clean[7]) };
  }
  return { checked: false, valid: true };
}

function splitBarcodesCell(raw: string | undefined): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(/[|;,\s]+/)
        .map((c) => c.trim())
        .filter(Boolean)
    )
  );
}

/**
 * Valida una matriz de filas (primera fila = encabezados) contra el catálogo actual y
 * produce una vista previa detallada fila por fila sin mutar ningún estado.
 */
export function previewCatalogImport(
  rows: readonly (readonly string[])[],
  existingProducts: readonly ExistingCatalogProductLike[],
  options: {
    duplicateMode?: CatalogImportDuplicateMode;
    allowPriceUpdate?: boolean;
  } = {}
): CatalogImportPreviewResult {
  const duplicateMode: CatalogImportDuplicateMode = options.duplicateMode ?? 'SKIP';
  const allowPriceUpdate = options.allowPriceUpdate ?? true;

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      headerError: 'El archivo no contiene filas. Descarga la plantilla CSV e incluye al menos un producto.',
      rows: [],
      totalRows: 0,
      toCreateCount: 0,
      toUpdateCount: 0,
      skippedCount: 0,
      errorCount: 0,
      warningCount: 0,
      requiresPin: false,
    };
  }

  const headerRow = rows[0] || [];
  const colIndexByField = new Map<ImportFieldKey, number>();
  for (let col = 0; col < headerRow.length; col++) {
    const norm = normalizeHeaderKey(headerRow[col] || '');
    const directKey = HEADER_ALIAS_MAP[norm];
    if (directKey && !colIndexByField.has(directKey)) {
      colIndexByField.set(directKey, col);
      continue;
    }
    const altNorm = HEADER_ALIAS_MAP[normalizeHeaderKey(String(headerRow[col] || '').replace(/%/g, ' %'))];
    if (altNorm && !colIndexByField.has(altNorm)) {
      colIndexByField.set(altNorm, col);
    }
  }

  const missingHeaders: string[] = [];
  if (!colIndexByField.has('name')) missingHeaders.push('Nombre');
  if (!colIndexByField.has('salePrice')) missingHeaders.push('Precio de venta');
  if (missingHeaders.length > 0) {
    return {
      headerError: `Faltan columnas obligatorias en el encabezado: ${missingHeaders.join(', ')}. Usa la plantilla sugerida.`,
      rows: [],
      totalRows: 0,
      toCreateCount: 0,
      toUpdateCount: 0,
      skippedCount: 0,
      errorCount: 0,
      warningCount: 0,
      requiresPin: false,
    };
  }

  const existingBySku = new Map<string, ExistingCatalogProductLike>();
  const existingByBarcodeKey = new Map<string, ExistingCatalogProductLike>();
  for (const prod of existingProducts || []) {
    if (!prod || !prod.sku) continue;
    existingBySku.set(prod.sku.trim().toUpperCase(), prod);
    const codes: string[] = [];
    if (prod.barcode) codes.push(prod.barcode);
    if (Array.isArray(prod.barcodes)) codes.push(...prod.barcodes);
    for (const code of codes) {
      for (const key of canonicalBarcodeKeys(code)) {
        if (!existingByBarcodeKey.has(key)) existingByBarcodeKey.set(key, prod);
      }
    }
  }

  const seenFileSkus = new Map<string, number>();
  const seenFileBarcodes = new Map<string, number>();

  const getCell = (dataRow: readonly string[], field: ImportFieldKey): string => {
    const idx = colIndexByField.get(field);
    return idx !== undefined ? String(dataRow[idx] ?? '').trim() : '';
  };

  const parsedRows: CatalogImportRowPreview[] = [];

  for (let i = 1; i < rows.length; i++) {
    const rawRow: readonly string[] = rows[i] || [];
    if (!rawRow.some((cell: string) => String(cell ?? '').trim().length > 0)) {
      continue;
    }

    const rowNumber = i + 1;
    const rawName = getCell(rawRow, 'name');
    const rawSku = getCell(rawRow, 'sku').toUpperCase();
    const rawBarcodes = splitBarcodesCell(getCell(rawRow, 'barcode'));
    const rawCategory = getCell(rawRow, 'category') || 'Abarrotes';
    const rawLocation = getCell(rawRow, 'location') || 'Pasillo General';
    const rawSupplier = getCell(rawRow, 'supplier') || 'Proveedor General';
    const rawSalePrice = parseLocaleMoneyOrNumber(getCell(rawRow, 'salePrice'));
    const rawCostCell = getCell(rawRow, 'cost');
    const rawCost = rawCostCell ? parseLocaleMoneyOrNumber(rawCostCell) : 0;
    const unitInfo = normalizeSaleUnit(getCell(rawRow, 'saleUnit'));
    const purchaseUnit = normalizePurchaseUnit(getCell(rawRow, 'purchaseUnit'), unitInfo.unit);
    const rawUnitsCell = getCell(rawRow, 'unitsPerPurchase');
    const parsedUnits = rawUnitsCell ? parseLocaleMoneyOrNumber(rawUnitsCell) : 1;
    const rawStockCell = getCell(rawRow, 'initialStock');
    const parsedStock = rawStockCell ? parseLocaleMoneyOrNumber(rawStockCell) : 0;
    const rawMinCell = getCell(rawRow, 'minStock');
    const parsedMinStock = rawMinCell ? parseLocaleMoneyOrNumber(rawMinCell) : 5;
    const rawRopCell = getCell(rawRow, 'rop');
    const parsedRop = rawRopCell ? parseLocaleMoneyOrNumber(rawRopCell) : (parsedMinStock ?? 5);
    const rawIvaCell = getCell(rawRow, 'ivaRate');
    const parsedIva = rawIvaCell ? parseLocaleMoneyOrNumber(rawIvaCell) : 0;
    const rawIepsCell = getCell(rawRow, 'iepsRate');
    const parsedIeps = rawIepsCell ? parseLocaleMoneyOrNumber(rawIepsCell) : 0;
    const expiryInfo = normalizeImportDate(getCell(rawRow, 'expiry'));
    const isBulk =
      parseBoolFlag(getCell(rawRow, 'isBulk')) ||
      unitInfo.unit === 'Kg' ||
      unitInfo.unit === 'g' ||
      unitInfo.unit === 'L';

    const errors: string[] = [];
    const warnings: string[] = [];

    if (rawName.length < 2) {
      errors.push('El nombre debe tener al menos 2 caracteres.');
    }
    if (rawSalePrice === null || rawSalePrice <= 0) {
      errors.push('El precio de venta debe ser mayor a $0.00.');
    }
    if (rawCost === null || rawCost < 0) {
      errors.push('El costo unitario no es válido.');
    }
    if (parsedUnits === null || parsedUnits <= 0) {
      errors.push('Las unidades por empaque deben ser mayores a 0.');
    }
    if (parsedStock === null || parsedStock < 0) {
      errors.push('El stock inicial no puede ser negativo.');
    }
    if (parsedMinStock === null || parsedMinStock < 0) {
      errors.push('El stock mínimo no puede ser negativo.');
    }
    if (parsedRop === null || parsedRop < 0) {
      errors.push('El valor de resurtido no puede ser negativo.');
    }
    if (parsedIva === null || parsedIva < 0 || parsedIva > 100) {
      errors.push('El IVA % debe estar entre 0 y 100.');
    }
    if (parsedIeps === null || parsedIeps < 0 || parsedIeps > 100) {
      errors.push('El IEPS % debe estar entre 0 y 100.');
    }
    if (!unitInfo.valid) {
      warnings.push(`Unidad desconocida "${getCell(rawRow, 'saleUnit')}"; se asignará "Pieza".`);
    }
    if (!expiryInfo.valid) {
      warnings.push('Caducidad no reconocida; se usará 2027-12-31.');
    }

    const salePrice = rawSalePrice && rawSalePrice > 0 ? roundMoneyCents(rawSalePrice) : 0;
    const cost = rawCost !== null && rawCost >= 0 ? roundMoneyCents(rawCost) : 0;

    if (salePrice > 0 && cost > 0 && cost >= salePrice) {
      warnings.push('El costo es igual o mayor al precio de venta.');
    }
    if (rawBarcodes.length === 0) {
      warnings.push('Sin código de fábrica: se generará un código interno de tienda.');
    } else {
      for (const code of rawBarcodes) {
        const chk = isBarcodeCheckDigitValid(code);
        if (chk.checked && !chk.valid) {
          warnings.push(`Código ${code}: dígito verificador inusual (revísalo con tu escáner).`);
        }
      }
    }

    // Duplicados dentro del mismo archivo
    if (rawSku) {
      const prevRow = seenFileSkus.get(rawSku);
      if (prevRow !== undefined) {
        errors.push(`Clave "${rawSku}" repetida en este archivo (fila ${prevRow}).`);
      } else {
        seenFileSkus.set(rawSku, rowNumber);
      }
    }
    for (const code of rawBarcodes) {
      let dupRow: number | undefined;
      for (const k of canonicalBarcodeKeys(code)) {
        if (seenFileBarcodes.has(k)) {
          dupRow = seenFileBarcodes.get(k);
          break;
        }
      }
      if (dupRow !== undefined) {
        errors.push(`Código ${code} repetido dentro del archivo (fila ${dupRow}).`);
      } else {
        for (const k of canonicalBarcodeKeys(code)) {
          seenFileBarcodes.set(k, rowNumber);
        }
      }
    }

    // Coincidencia con catálogo existente
    let matched: ExistingCatalogProductLike | undefined;
    if (rawSku && existingBySku.has(rawSku)) {
      matched = existingBySku.get(rawSku);
    } else {
      for (const code of rawBarcodes) {
        for (const k of canonicalBarcodeKeys(code)) {
          const hit = existingByBarcodeKey.get(k);
          if (hit) {
            matched = hit;
            break;
          }
        }
        if (matched) break;
      }
    }

    const normalized: CatalogImportNormalizedProduct = {
      name: rawName,
      barcodes: rawBarcodes,
      sku: rawSku,
      category: rawCategory,
      location: rawLocation,
      salePrice,
      cost,
      saleUnit: unitInfo.unit,
      purchaseUnit,
      unitsPerPurchase: parsedUnits && parsedUnits > 0 ? Math.round(parsedUnits * 1000) / 1000 : 1,
      initialStock: parsedStock && parsedStock >= 0 ? Math.round(parsedStock * 1000) / 1000 : 0,
      minStock: parsedMinStock && parsedMinStock >= 0 ? Math.round(parsedMinStock * 1000) / 1000 : 5,
      rop: parsedRop && parsedRop >= 0 ? Math.round(parsedRop * 1000) / 1000 : 5,
      ivaRate: parsedIva && parsedIva >= 0 ? Math.round(parsedIva * 100) / 100 : 0,
      iepsRate: parsedIeps && parsedIeps >= 0 ? Math.round(parsedIeps * 100) / 100 : 0,
      supplier: rawSupplier,
      expiry: expiryInfo.iso,
      isBulk,
      naturalShrinkTolerancePct: isBulk ? 3 : 0,
      useInternalBarcode: rawBarcodes.length === 0,
    };

    let action: CatalogImportRowAction = 'CREATE';
    let status: CatalogImportRowStatus = 'VALID';

    if (matched) {
      if (duplicateMode === 'SKIP') {
        action = 'SKIP';
        status = 'SKIPPED';
        warnings.push(`Ya existe como "${matched.name}" (${matched.sku}); se omitirá.`);
      } else {
        action = 'UPDATE';
        const existingCost = roundMoneyCents(Number(matched.historicCost ?? matched.unitCost ?? 0));
        const existingPrice = roundMoneyCents(Number(matched.salePrice ?? 0));
        const priceOrCostChanged =
          (salePrice > 0 && salePrice !== existingPrice) ||
          (rawCostCell !== '' && cost !== existingCost);

        if (!allowPriceUpdate && priceOrCostChanged) {
          errors.push('Solo el Administrador puede cambiar precios o costos de productos existentes.');
        }
        if (normalized.initialStock > 0) {
          warnings.push('Las existencias de productos existentes no se sobrescriben al importar.');
        }
      }
    }

    if (errors.length > 0) {
      status = 'ERROR';
      action = 'NONE';
    } else if (action !== 'SKIP') {
      status = warnings.length > 0 ? 'WARNING' : 'VALID';
    }

    parsedRows.push({
      rowNumber,
      rawName,
      action,
      status,
      matchedExistingSku: matched?.sku,
      matchedExistingName: matched?.name,
      errors,
      warnings,
      normalized,
    });
  }

  if (parsedRows.length === 0) {
    return {
      headerError: 'El archivo solo contiene encabezados y no tiene filas de productos.',
      rows: [],
      totalRows: 0,
      toCreateCount: 0,
      toUpdateCount: 0,
      skippedCount: 0,
      errorCount: 0,
      warningCount: 0,
      requiresPin: false,
    };
  }

  const toCreateCount = parsedRows.filter((r) => r.action === 'CREATE').length;
  const toUpdateCount = parsedRows.filter((r) => r.action === 'UPDATE').length;
  const skippedCount = parsedRows.filter((r) => r.status === 'SKIPPED').length;
  const errorCount = parsedRows.filter((r) => r.status === 'ERROR').length;
  const warningCount = parsedRows.filter((r) => r.status === 'WARNING').length;

  return {
    rows: parsedRows,
    totalRows: parsedRows.length,
    toCreateCount,
    toUpdateCount,
    skippedCount,
    errorCount,
    warningCount,
    requiresPin: toCreateCount + toUpdateCount > 0,
  };
}
