/**
 * Lógica pura de dominio para manejo de dinero en centavos enteros.
 * Elimina problemas de punto flotante en cálculos financieros y de punto de venta.
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
 * Multiplica un precio o costo unitario por una cantidad, redondeando a centavos enteros.
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
