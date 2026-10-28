/**
 * Lógica pura de dominio para manejo de dinero en centavos enteros.
 * Elimina problemas de punto flotante en cálculos financieros y de punto de venta.
 *
 * =====================================================================================
 * REGLAS CONTABLES, FINANCIERAS Y FISCALES:
 *
 * 1. REGLA DE REDONDEO: MITAD HACIA ARRIBA (HALF-UP)
 *    En todas las operaciones aritméticas que produzcan fracciones de centavo (ej. cálculo
 *    de impuestos, precios multiplicados por cantidades fraccionarias de báscula en granel,
 *    o división de montos), se aplica la regla de redondeo de la mitad hacia arriba (Half-Up).
 *    Si la fracción de centavo es mayor o igual a 0.5 (es decir, >= 5 en el siguiente dígito
 *    decimal), se redondea hacia el entero de centavos superior más cercano; de lo contrario
 *    se conserva el entero inferior. Esto se implementa determinísticamente con Math.round()
 *    sobre enteros de centavos para garantizar reproducibilidad exacta y cero pérdida de valor.
 *
 * 2. CÁLCULO DE IVA / IMPUESTOS: POR LÍNEA (PARTIDA POR PARTIDA)
 *    De conformidad con los estándares de facturación electrónica y comercial mexicana
 *    (Código Fiscal de la Federación y lineamientos de Anexo 20 del SAT), el cálculo de impuestos
 *    se efectúa a nivel partida (por línea del ticket o factura).
 *    Cada línea de venta redondea individualmente su importe de impuesto a centavos enteros
 *    (2 decimales) antes de sumarse al total general del comprobante.
 *    Esto garantiza que el precio neto por producto exhibido al consumidor coincida exactamente
 *    con el ticket físico y la salida de inventario.
 *    La función calculateCartTaxes() calcula el impuesto reglamentario por partida
 *    (totalTaxByLineSum) y lo contrasta con el cálculo teórico sobre la base total agrupada
 *    (taxOnTotalBase), exponiendo la diferencia en centavos (roundingDifferenceCents) para fines
 *    de auditoría contable, conciliación fiscal y control de mermas/discrepancias.
 * =====================================================================================
 */

/**
 * Convierte un monto decimal en pesos a centavos enteros.
 * Redondea al entero más cercano para evitar imprecisiones de punto flotante.
 */
export function toCents(amount: number): number {
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * 100);
}

/**
 * Convierte un monto en centavos enteros a pesos decimales (number).
 */
export function fromCents(cents: number): number {
  if (typeof cents !== 'number' || isNaN(cents) || !isFinite(cents)) {
    return 0;
  }
  return Math.round(cents) / 100;
}

/**
 * Parsea un valor de dinero (cadena o número) directamente a centavos enteros,
 * evitando las pérdidas de precisión asociadas a parseFloat() y expresiones con toFixed().
 * Acepta formatos como "$1,250.50", "1250.50", " 45.9 ", etc.
 */
export function parseMoneyToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    return toCents(value);
  }
  const clean = value.toString().replace(/[\$,\s]/g, '').trim();
  if (!clean) return 0;

  const isNegative = clean.startsWith('-');
  const raw = isNegative ? clean.slice(1) : clean;
  const parts = raw.split('.');
  if (parts.length > 2) return 0;

  const intPart = parseInt(parts[0] || '0', 10);
  if (isNaN(intPart)) return 0;

  let centsPart = 0;
  if (parts.length === 2) {
    const decStr = parts[1];
    if (decStr.length === 0) {
      centsPart = 0;
    } else if (decStr.length === 1) {
      centsPart = parseInt(decStr + '0', 10);
    } else if (decStr.length === 2) {
      centsPart = parseInt(decStr, 10);
    } else {
      // Redondeo de mitad hacia arriba para fracciones de centavo
      const firstTwo = parseInt(decStr.slice(0, 2), 10);
      const third = parseInt(decStr[2], 10);
      centsPart = third >= 5 ? firstTwo + 1 : firstTwo;
    }
  }

  const totalCents = intPart * 100 + (isNaN(centsPart) ? 0 : centsPart);
  return isNegative ? -totalCents : totalCents;
}

/**
 * Parsea un valor de dinero directamente a pesos exactos a partir de centavos enteros.
 */
export function parseMoney(value: string | number | null | undefined): number {
  return fromCents(parseMoneyToCents(value));
}

/**
 * Suma una lista de valores en pesos convirtiéndolos a centavos enteros en el proceso.
 */
export function sumMoney(amounts: number[]): number {
  const totalCents = amounts.reduce((sum, a) => sum + toCents(a), 0);
  return fromCents(totalCents);
}

/**
 * Resta dos montos en pesos trabajando en centavos enteros: a - b.
 */
export function subtractMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

/**
 * Multiplica un precio o costo unitario por una cantidad, redondeando a centavos enteros
 * con la regla de la mitad hacia arriba.
 */
export function multiplyMoney(unitAmount: number, qty: number): number {
  if (isNaN(unitAmount) || isNaN(qty)) return 0;
  const unitCents = toCents(unitAmount);
  return fromCents(Math.round(unitCents * qty));
}

/**
 * Formatea un monto en pesos o centavos a cadena legible de moneda mexicana (MXN).
 * Ejemplo: 1250.5 -> "$1,250.50"
 */
export function formatMxn(amountOrCents: number, isCents = false): string {
  const pesos = isCents ? fromCents(amountOrCents) : amountOrCents;
  const safePesos = isNaN(pesos) || !isFinite(pesos) ? 0 : pesos;
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safePesos);
}

/**
 * Calcula impuestos (IVA, IEPS) sobre un monto con modo de redondeo especificado.
 * @param amount Monto base en pesos o centavos.
 * @param rate Tasa porcentual (ej. 0.16 para 16% IVA o 0.08 para 8% IEPS).
 * @param isCents Si amount ya está en centavos.
 * @param rounding Modo de redondeo ('round' | 'floor' | 'ceil').
 * @returns Impuesto calculado en la misma unidad que el input (pesos si !isCents, centavos si isCents).
 */
export function calculateTax(
  amount: number,
  rate: number,
  isCents = false,
  rounding: 'round' | 'floor' | 'ceil' = 'round'
): number {
  const cents = isCents ? amount : toCents(amount);
  const rawTaxCents = cents * rate;
  let taxCents = 0;
  switch (rounding) {
    case 'floor':
      taxCents = Math.floor(rawTaxCents);
      break;
    case 'ceil':
      taxCents = Math.ceil(rawTaxCents);
      break;
    case 'round':
    default:
      taxCents = Math.round(rawTaxCents);
      break;
  }
  return isCents ? taxCents : fromCents(taxCents);
}

export interface TaxLineItem {
  price: number;
  qty: number;
  taxRate: number; // Ej. 0.16 para 16% IVA
}

export interface TaxCalculationResult {
  lineSubtotals: number[]; // Subtotales por línea en pesos
  lineTaxes: number[];     // Impuesto por línea en pesos (redondeado por partida)
  totalSubtotal: number;   // Suma de subtotales
  totalTaxByLineSum: number; // Suma de impuestos calculados por línea
  taxOnTotalBase: number;  // Impuesto calculado sobre la base total agrupada
  roundingDifferenceCents: number; // Diferencia en centavos entre ambos métodos
}

/**
 * Calcula impuestos partida por partida vs sobre la base total.
 * Permite auditar discrepancias de centavos habituales en facturación e inventario.
 */
export function calculateCartTaxes(items: TaxLineItem[]): TaxCalculationResult {
  let totalSubtotalCents = 0;
  let totalTaxByLineCents = 0;
  const lineSubtotals: number[] = [];
  const lineTaxes: number[] = [];

  for (const item of items) {
    const lineCents = Math.round(toCents(item.price) * item.qty);
    const lineTaxCents = Math.round(lineCents * item.taxRate);
    totalSubtotalCents += lineCents;
    totalTaxByLineCents += lineTaxCents;
    lineSubtotals.push(fromCents(lineCents));
    lineTaxes.push(fromCents(lineTaxCents));
  }

  const uniformRate = items.length > 0 ? items[0].taxRate : 0.16;
  const taxOnTotalCents = Math.round(totalSubtotalCents * uniformRate);

  return {
    lineSubtotals,
    lineTaxes,
    totalSubtotal: fromCents(totalSubtotalCents),
    totalTaxByLineSum: fromCents(totalTaxByLineCents),
    taxOnTotalBase: fromCents(taxOnTotalCents),
    roundingDifferenceCents: Math.abs(totalTaxByLineCents - taxOnTotalCents),
  };
}
