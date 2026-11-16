/**
 * Copia del respaldo cifrado a memoria USB (Bloque L).
 * La copia la hace local-server (no el navegador); aquí solo se interpreta su estado
 * (GET /api/usb/estado) para mostrar "Última copia a USB: hace X" y avisar si pasan más de 7 días.
 * Sin dependencias: el archivo debe poder ejecutarse con `npm run test:domain` (Node) y compilarse con Angular.
 */

export const USB_WARN_AFTER_DAYS = 7;

export interface UsbBackupStatus {
  /** false si el servidor se inició con --sin-usb */
  activo: boolean;
  /** hay una unidad extraíble (o la carpeta de --usb-dir) disponible ahora mismo */
  unidadConectada: boolean;
  /** fecha ISO (UTC) de la última copia exitosa, o null si nunca se ha copiado */
  ultimaCopia: string | null;
  ultimoArchivo: string | null;
  /** el servidor ya calculó que pasaron más de `umbralDias` días (o que nunca se copió) */
  aviso: boolean;
  umbralDias: number;
  ultimoError: string | null;
}

export type UsbBackupTone = 'ok' | 'warn';

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Valida la respuesta del servidor; devuelve null si no tiene el formato esperado. */
export function parseUsbBackupStatus(raw: unknown): UsbBackupStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['activo'] !== 'boolean') return null;
  const threshold = typeof r['umbralDias'] === 'number' && r['umbralDias'] > 0 ? r['umbralDias'] : USB_WARN_AFTER_DAYS;
  return {
    activo: r['activo'],
    unidadConectada: r['unidadConectada'] === true,
    ultimaCopia: asStringOrNull(r['ultimaCopia']),
    ultimoArchivo: asStringOrNull(r['ultimoArchivo']),
    aviso: r['aviso'] === true,
    umbralDias: threshold,
    ultimoError: asStringOrNull(r['ultimoError']),
  };
}

/** "hace 3 días", "hace 5 h"… o "Sin copia a USB todavía". */
export function formatUsbLastCopyLabel(
  lastCopyIso: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const ts = lastCopyIso ? Date.parse(lastCopyIso) : Number.NaN;
  if (Number.isNaN(ts)) return 'Sin copia a USB todavía';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return 'hace unos segundos';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `hace ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? 'hace 1 día' : `hace ${diffDays} días`;
}

/** true si nunca hubo copia o ya pasaron MÁS de `thresholdDays` días (se calcula aquí con el reloj de la app). */
export function isUsbCopyStale(
  lastCopyIso: string | null | undefined,
  nowMs: number = Date.now(),
  thresholdDays: number = USB_WARN_AFTER_DAYS,
): boolean {
  const ts = lastCopyIso ? Date.parse(lastCopyIso) : Number.NaN;
  if (Number.isNaN(ts)) return true;
  return nowMs - ts > thresholdDays * 24 * 60 * 60 * 1000;
}

export function usbBackupTone(status: UsbBackupStatus, nowMs: number = Date.now()): UsbBackupTone {
  return isUsbCopyStale(status.ultimaCopia, nowMs, status.umbralDias) ? 'warn' : 'ok';
}

/** Mensaje de aviso para mostrar bajo la etiqueta, o null si todo está bien. */
export function usbBackupWarning(status: UsbBackupStatus, nowMs: number = Date.now()): string | null {
  if (!status.activo) return null;
  if (!isUsbCopyStale(status.ultimaCopia, nowMs, status.umbralDias)) return null;
  const hint = status.unidadConectada ? 'La copia se hará sola con el siguiente respaldo.' : 'Conecta la memoria USB a esta PC.';
  if (!status.ultimaCopia) return `Aún no hay copia a USB. ${hint}`;
  return `Han pasado más de ${status.umbralDias} días sin copia a USB. ${hint}`;
}
