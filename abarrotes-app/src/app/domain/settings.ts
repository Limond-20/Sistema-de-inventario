/**
 * Lógica pura de dominio para Ajustes del Negocio y Parámetros Globales (Bloque G).
 *
 * Elimina el valor fijo "Abarrotes Doña Lupe" y permite parametrizar:
 * - Nombre comercial del negocio (reflejado en encabezados, tickets y hoja de códigos).
 * - Fondo inicial sugerido en caja (en pesos y centavos enteros).
 * - Umbral de margen porcentual.
 * - Tasas de impuestos por defecto (IVA e IEPS).
 * - Tiempo de bloqueo automático de sesión por inactividad.
 * - Tope de descuento sin PIN (conservado del Bloque F1).
 */

export interface BusinessSettings {
  storeName: string;
  initialCashFloat: number;
  initialCashFloatCents: number;
  marginThresholdPct: number;
  defaultIvaPct: number;
  defaultIepsPct: number;
  inactivityTimeoutMinutes: number;
  maxDiscountPctWithoutPin: number;
  updatedAt?: string;
  updatedBy?: string;
}

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
  errors: string[];
  sanitized: BusinessSettings;
} {
  const errors: string[] = [];

  const storeName = (input.storeName ?? DEFAULT_BUSINESS_SETTINGS.storeName).trim();
  if (storeName.length < 2) {
    errors.push('El nombre del negocio debe tener al menos 2 caracteres.');
  }

  const initialCashFloat = Math.max(0, Number(input.initialCashFloat ?? DEFAULT_BUSINESS_SETTINGS.initialCashFloat) || 0);
  const initialCashFloatCents = Math.round(initialCashFloat * 100);

  const marginThresholdPct = Math.min(100, Math.max(0, Number(input.marginThresholdPct ?? DEFAULT_BUSINESS_SETTINGS.marginThresholdPct) || 0));
  const defaultIvaPct = Math.min(100, Math.max(0, Number(input.defaultIvaPct ?? DEFAULT_BUSINESS_SETTINGS.defaultIvaPct) || 0));
  const defaultIepsPct = Math.min(100, Math.max(0, Number(input.defaultIepsPct ?? DEFAULT_BUSINESS_SETTINGS.defaultIepsPct) || 0));

  const rawTimeout = input.inactivityTimeoutMinutes !== undefined ? Number(input.inactivityTimeoutMinutes) : DEFAULT_BUSINESS_SETTINGS.inactivityTimeoutMinutes;
  const inactivityTimeoutMinutes = Math.min(240, Math.max(1, Math.round(Number.isFinite(rawTimeout) ? rawTimeout : 5)));
  const maxDiscountPctWithoutPin = Math.min(100, Math.max(0, Number(input.maxDiscountPctWithoutPin ?? DEFAULT_BUSINESS_SETTINGS.maxDiscountPctWithoutPin) || 0));

  const sanitized: BusinessSettings = {
    storeName,
    initialCashFloat,
    initialCashFloatCents,
    marginThresholdPct,
    defaultIvaPct,
    defaultIepsPct,
    inactivityTimeoutMinutes,
    maxDiscountPctWithoutPin,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };

  return {
    valid: errors.length === 0,
    errors,
    sanitized,
  };
}
