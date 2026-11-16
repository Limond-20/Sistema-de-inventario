import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUsbLastCopyLabel,
  isUsbCopyStale,
  parseUsbBackupStatus,
  usbBackupTone,
  usbBackupWarning,
  type UsbBackupStatus,
} from './usb-backup.ts';

const NOW = Date.parse('2026-11-15T18:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function status(partial: Partial<UsbBackupStatus> = {}): UsbBackupStatus {
  return {
    activo: true,
    unidadConectada: true,
    ultimaCopia: iso(2 * HOUR),
    ultimoArchivo: '20261115-160000.bak',
    aviso: false,
    umbralDias: 7,
    ultimoError: null,
    ...partial,
  };
}

test('USB (Bloque L): etiqueta "Última copia a USB: hace X"', () => {
  assert.equal(formatUsbLastCopyLabel(null, NOW), 'Sin copia a USB todavía');
  assert.equal(formatUsbLastCopyLabel('no es fecha', NOW), 'Sin copia a USB todavía');
  assert.equal(formatUsbLastCopyLabel(iso(10_000), NOW), 'hace unos segundos');
  assert.equal(formatUsbLastCopyLabel(iso(5 * 60_000), NOW), 'hace 5 min');
  assert.equal(formatUsbLastCopyLabel(iso(3 * HOUR), NOW), 'hace 3 h');
  assert.equal(formatUsbLastCopyLabel(iso(DAY + HOUR), NOW), 'hace 1 día');
  assert.equal(formatUsbLastCopyLabel(iso(4 * DAY), NOW), 'hace 4 días');
  assert.equal(formatUsbLastCopyLabel(iso(-HOUR), NOW), 'hace unos segundos'); // reloj adelantado: nunca "hace -1 h"
});

test('USB (Bloque L): aviso solo cuando pasan MÁS de 7 días o nunca hubo copia', () => {
  assert.equal(isUsbCopyStale(null, NOW), true);
  assert.equal(isUsbCopyStale('basura', NOW), true);
  assert.equal(isUsbCopyStale(iso(6 * DAY + 23 * HOUR), NOW), false);
  assert.equal(isUsbCopyStale(iso(7 * DAY), NOW), false); // exactamente 7 días: todavía no
  assert.equal(isUsbCopyStale(iso(7 * DAY + 1000), NOW), true);
  assert.equal(isUsbCopyStale(iso(2 * DAY), NOW, 1), true); // umbral configurable
});

test('USB (Bloque L): tono y mensaje de aviso', () => {
  assert.equal(usbBackupTone(status(), NOW), 'ok');
  assert.equal(usbBackupWarning(status(), NOW), null);

  const old = status({ ultimaCopia: iso(8 * DAY), unidadConectada: false });
  assert.equal(usbBackupTone(old, NOW), 'warn');
  assert.match(usbBackupWarning(old, NOW) ?? '', /más de 7 días sin copia a USB\. Conecta la memoria USB/);

  const never = status({ ultimaCopia: null, unidadConectada: true });
  assert.match(usbBackupWarning(never, NOW) ?? '', /Aún no hay copia a USB\./);

  // Con la función desactivada (--sin-usb) no se molesta al tendero.
  assert.equal(usbBackupWarning(status({ activo: false, ultimaCopia: null }), NOW), null);
});

test('USB (Bloque L): interpreta la respuesta del servidor y rechaza formatos raros', () => {
  const ok = parseUsbBackupStatus({
    activo: true,
    unidadConectada: true,
    ultimaCopia: '2026-11-15T16:00:00Z',
    ultimoArchivo: '20261115-160000.bak',
    aviso: false,
    umbralDias: 7,
    ultimoError: null,
    extra: 'se ignora',
  });
  assert.deepEqual(ok, {
    activo: true,
    unidadConectada: true,
    ultimaCopia: '2026-11-15T16:00:00Z',
    ultimoArchivo: '20261115-160000.bak',
    aviso: false,
    umbralDias: 7,
    ultimoError: null,
  });
  assert.equal(parseUsbBackupStatus(null), null);
  assert.equal(parseUsbBackupStatus('texto'), null);
  assert.equal(parseUsbBackupStatus({ unidadConectada: true }), null);
  const partial = parseUsbBackupStatus({ activo: true, umbralDias: -3 });
  assert.equal(partial?.umbralDias, 7);
  assert.equal(partial?.ultimaCopia, null);
});
