import type { PersistedAppState } from './persistence';

export const BACKUP_MAGIC_ASCII = 'BTBAK';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_KDF_PBKDF2_SHA256 = 1;
export const BACKUP_CIPHER_AES_256_GCM = 1;

export const BACKUP_HEADER_META_LEN = 12; // 5B magic + 1B version + 1B kdf + 1B cipher + 4B uint32 BE iterations
export const BACKUP_SALT_LEN = 16;
export const BACKUP_AAD_LEN = BACKUP_HEADER_META_LEN + BACKUP_SALT_LEN; // 28 bytes cubiertos por AAD
export const BACKUP_NONCE_LEN = 12;
export const BACKUP_TAG_LEN = 16;
export const BACKUP_MIN_BLOB_LEN = BACKUP_AAD_LEN + BACKUP_NONCE_LEN + BACKUP_TAG_LEN; // 56 bytes

export const BACKUP_PBKDF2_ITERATIONS = 600_000;
export const MIN_ALLOWED_ITERATIONS = 1_000;
export const MAX_ALLOWED_ITERATIONS = 10_000_000;

export const MIN_BACKUP_PASSPHRASE_LENGTH = 8;
export const MAX_RETAINED_BACKUPS = 30;
export const HOURLY_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
export const STALE_BACKUP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 horas
export const PRERESTORE_STATE_KEY_PREFIX = 'binnitech_pos_state_prerestore_';
export const BACKUP_FILENAME_REGEX = /^[0-9]{8}-[0-9]{6}\.bak$/;

export type SaveIndicatorStatus = 'saved' | 'saving' | 'error';

export interface BackupHeaderInfo {
  version: number;
  kdfId: number;
  cipherId: number;
  iterations: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

export interface BackupEntryMeta {
  nombre: string;
  fecha: string;
  tamano: number;
  name: string;
  date: string;
  size: number;
}

export interface BackupOperationResult {
  ok: boolean;
  status?: number;
  message: string;
  entry?: BackupEntryMeta;
}

export interface RestoreOperationResult {
  ok: boolean;
  status?: number;
  message: string;
  state?: PersistedAppState;
  preRestoreKey?: string;
}

export interface UsbCopyResult {
  ok: boolean;
  method: 'filesystem' | 'download';
  filename: string;
  message: string;
}

export interface BackupTransportAdapter {
  createBackup(state: PersistedAppState, passphrase: string): Promise<BackupEntryMeta>;
  listBackups(): Promise<BackupEntryMeta[]>;
  restoreBackup(passphrase: string, filename?: string): Promise<PersistedAppState>;
  getBackupRawBytes(filename: string): Promise<Uint8Array>;
}

export class BackupUnauthorizedError extends Error {
  readonly status = 403;
  constructor(message = 'No autorizado') {
    super(message);
    this.name = 'BackupUnauthorizedError';
  }
}

export class BackupValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

export function validateBackupPassphrase(passphrase: string | null | undefined): {
  valid: boolean;
  message?: string;
} {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    return {
      valid: false,
      message: `La frase de respaldo debe tener al menos ${MIN_BACKUP_PASSPHRASE_LENGTH} caracteres.`,
    };
  }
  return { valid: true };
}

export function isValidBackupFilename(filename: string | null | undefined): boolean {
  return typeof filename === 'string' && BACKUP_FILENAME_REGEX.test(filename);
}

function getMagicBytes(): Uint8Array {
  return new Uint8Array([0x42, 0x54, 0x42, 0x41, 0x4b]); // "BTBAK" (5 bytes)
}

function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API no disponible en este entorno.');
}

function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return arr;
}

/**
 * Empaqueta el encabezado de 28 bytes cubierto por el AAD:
 *   [0..5]   Magic "BTBAK"
 *   [5]      Versión (uint8 = 1)
 *   [6]      KDF ID (uint8 = 1 -> PBKDF2-HMAC-SHA256)
 *   [7]      Cipher ID (uint8 = 1 -> AES-256-GCM)
 *   [8..12]  Iteraciones PBKDF2 (uint32 big-endian, ej. 600,000)
 *   [12..28] Salt (16 bytes)
 */
export function packBackupHeader(
  salt: Uint8Array,
  iterations: number = BACKUP_PBKDF2_ITERATIONS,
  version: number = BACKUP_FORMAT_VERSION,
  kdfId: number = BACKUP_KDF_PBKDF2_SHA256,
  cipherId: number = BACKUP_CIPHER_AES_256_GCM
): Uint8Array {
  if (salt.byteLength !== BACKUP_SALT_LEN) {
    throw new Error('Salt debe ser de 16 bytes.');
  }
  const aad = new Uint8Array(BACKUP_AAD_LEN);
  const magic = getMagicBytes();
  aad.set(magic, 0);
  const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
  view.setUint8(5, version);
  view.setUint8(6, kdfId);
  view.setUint8(7, cipherId);
  view.setUint32(8, iterations >>> 0, false); // big-endian
  aad.set(salt, BACKUP_HEADER_META_LEN);
  return aad;
}

/**
 * Desempaqueta y valida el encabezado de un archivo .bak, extrayendo versión, parámetros KDF, salt, nonce y AAD.
 */
export function unpackBackupHeader(blob: Uint8Array): BackupHeaderInfo {
  if (!(blob instanceof Uint8Array) || blob.byteLength < BACKUP_MIN_BLOB_LEN) {
    throw new BackupUnauthorizedError('No autorizado');
  }
  const magic = getMagicBytes();
  for (let i = 0; i < magic.length; i++) {
    if (blob[i] !== magic[i]) {
      throw new BackupUnauthorizedError('No autorizado');
    }
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = view.getUint8(5);
  const kdfId = view.getUint8(6);
  const cipherId = view.getUint8(7);
  const iterations = view.getUint32(8, false); // big-endian

  if (
    version !== BACKUP_FORMAT_VERSION ||
    kdfId !== BACKUP_KDF_PBKDF2_SHA256 ||
    cipherId !== BACKUP_CIPHER_AES_256_GCM
  ) {
    throw new BackupUnauthorizedError('No autorizado');
  }
  if (iterations < MIN_ALLOWED_ITERATIONS || iterations > MAX_ALLOWED_ITERATIONS) {
    throw new BackupUnauthorizedError('No autorizado');
  }

  const aad = blob.slice(0, BACKUP_AAD_LEN);
  const salt = blob.slice(BACKUP_HEADER_META_LEN, BACKUP_AAD_LEN);
  const nonce = blob.slice(BACKUP_AAD_LEN, BACKUP_AAD_LEN + BACKUP_NONCE_LEN);
  const ciphertext = blob.slice(BACKUP_AAD_LEN + BACKUP_NONCE_LEN);

  return {
    version,
    kdfId,
    cipherId,
    iterations,
    salt,
    nonce,
    aad,
    ciphertext,
  };
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = BACKUP_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Cifra bytes en claro usando AES-256-GCM + PBKDF2-HMAC-SHA256 (por defecto 600,000 iteraciones)
 * con el mismo formato binario (.bak) que local-server/lansync/backup.py:
 *   [0..5]   Magic "BTBAK"
 *   [5]      Versión (1)
 *   [6]      KDF ID (1 = PBKDF2-HMAC-SHA256)
 *   [7]      Cipher ID (1 = AES-256-GCM)
 *   [8..12]  Iteraciones (uint32 BE = 600,000)
 *   [12..28] Salt (16B)
 *   [28..40] Nonce/IV (12B)
 *   [40..]   Ciphertext + Tag (16B), con AAD = [0..28]
 */
export async function encryptBackupBytes(
  plaintext: Uint8Array,
  passphrase: string,
  iterations: number = BACKUP_PBKDF2_ITERATIONS
): Promise<Uint8Array> {
  const check = validateBackupPassphrase(passphrase);
  if (!check.valid) {
    throw new BackupValidationError(check.message!);
  }
  const subtle = getSubtleCrypto();
  const salt = randomBytes(BACKUP_SALT_LEN);
  const nonce = randomBytes(BACKUP_NONCE_LEN);
  const aad = packBackupHeader(salt, iterations);

  const key = await deriveAesGcmKey(passphrase, salt, iterations);
  const ctBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
      tagLength: 128,
    },
    key,
    plaintext as unknown as BufferSource
  );
  const ciphertext = new Uint8Array(ctBuffer);
  const result = new Uint8Array(aad.byteLength + nonce.byteLength + ciphertext.byteLength);
  result.set(aad, 0);
  result.set(nonce, aad.byteLength);
  result.set(ciphertext, aad.byteLength + nonce.byteLength);
  return result;
}

/**
 * Descifra un blob .bak leyendo versión y parámetros KDF (iteraciones) directamente del encabezado cubierto por AAD.
 * Lanza BackupUnauthorizedError (403) sin detalles internos si la frase es incorrecta o si cualquier byte (incluido el encabezado) fue manipulado.
 */
export async function decryptBackupBytes(
  blob: Uint8Array,
  passphrase: string
): Promise<Uint8Array> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new BackupUnauthorizedError('No autorizado');
  }
  const parsed = unpackBackupHeader(blob);
  try {
    const subtle = getSubtleCrypto();
    const key = await deriveAesGcmKey(passphrase, parsed.salt, parsed.iterations);
    const plainBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.nonce as unknown as BufferSource,
        additionalData: parsed.aad as unknown as BufferSource,
        tagLength: 128,
      },
      key,
      parsed.ciphertext as unknown as BufferSource
    );
    return new Uint8Array(plainBuffer);
  } catch {
    throw new BackupUnauthorizedError('No autorizado');
  }
}

export function formatBackupFilename(date: Date = new Date(), existingNames?: Set<string>): string {
  let dt = new Date(Math.floor(date.getTime() / 1000) * 1000);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  while (true) {
    const yyyy = dt.getUTCFullYear();
    const mm = pad2(dt.getUTCMonth() + 1);
    const dd = pad2(dt.getUTCDate());
    const hh = pad2(dt.getUTCHours());
    const min = pad2(dt.getUTCMinutes());
    const ss = pad2(dt.getUTCSeconds());
    const candidate = `${yyyy}${mm}${dd}-${hh}${min}${ss}.bak`;
    if (!existingNames || !existingNames.has(candidate)) {
      return candidate;
    }
    dt = new Date(dt.getTime() + 1000);
  }
}

export function parseBackupFilenameDate(filename: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.bak$/.exec(filename);
  if (!m) return new Date().toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export function formatRelativeBackupTime(
  lastBackupIso: string | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!lastBackupIso) {
    return 'Sin respaldos';
  }
  const ts = Date.parse(lastBackupIso);
  if (Number.isNaN(ts)) {
    return 'Sin respaldos';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) {
    return 'hace unos segundos';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `hace ${diffMin} min`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `hace ${diffHours} h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? 'hace 1 día' : `hace ${diffDays} días`;
}

export function isBackupOlderThan24h(
  lastBackupIso: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!lastBackupIso) return false;
  const ts = Date.parse(lastBackupIso);
  if (Number.isNaN(ts)) return false;
  return nowMs - ts > STALE_BACKUP_THRESHOLD_MS;
}

/**
 * Adaptador de respaldos cifrados en memoria/local (usa AES-256-GCM + PBKDF2 real y retiene máximo 30).
 * No almacena jamás la frase de respaldo.
 */
export class InMemoryEncryptedBackupAdapter implements BackupTransportAdapter {
  private readonly files = new Map<string, { blob: Uint8Array; date: string }>();
  private readonly maxBackups: number;
  private readonly iterations: number;
  private lastEpochSec = 0;

  constructor(maxBackups: number = MAX_RETAINED_BACKUPS, iterations: number = BACKUP_PBKDF2_ITERATIONS) {
    this.maxBackups = maxBackups;
    this.iterations = iterations;
  }

  async createBackup(state: PersistedAppState, passphrase: string): Promise<BackupEntryMeta> {
    const check = validateBackupPassphrase(passphrase);
    if (!check.valid) {
      throw new BackupValidationError(check.message!);
    }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(state));
    const encrypted = await encryptBackupBytes(jsonBytes, passphrase, this.iterations);

    let nowSec = Math.floor(Date.now() / 1000);
    if (nowSec <= this.lastEpochSec) {
      nowSec = this.lastEpochSec + 1;
    }
    const existing = new Set(this.files.keys());
    const filename = formatBackupFilename(new Date(nowSec * 1000), existing);
    const isoDate = parseBackupFilenameDate(filename);
    this.lastEpochSec = Math.floor(Date.parse(isoDate) / 1000);

    this.files.set(filename, { blob: encrypted, date: isoDate });
    this.pruneOldBackups();

    return {
      nombre: filename,
      fecha: isoDate,
      tamano: encrypted.byteLength,
      name: filename,
      date: isoDate,
      size: encrypted.byteLength,
    };
  }

  private pruneOldBackups(): void {
    const sortedNames = Array.from(this.files.keys()).sort().reverse();
    for (const oldName of sortedNames.slice(this.maxBackups)) {
      this.files.delete(oldName);
    }
  }

  async listBackups(): Promise<BackupEntryMeta[]> {
    const sortedNames = Array.from(this.files.keys()).sort().reverse();
    return sortedNames.map((name) => {
      const item = this.files.get(name)!;
      return {
        nombre: name,
        fecha: item.date,
        tamano: item.blob.byteLength,
        name,
        date: item.date,
        size: item.blob.byteLength,
      };
    });
  }

  async restoreBackup(passphrase: string, filename?: string): Promise<PersistedAppState> {
    const sortedNames = Array.from(this.files.keys()).sort().reverse();
    const targetName = filename || sortedNames[0];
    if (!targetName || !this.files.has(targetName)) {
      throw new Error('Respaldo no encontrado');
    }
    const entry = this.files.get(targetName)!;
    const decryptedBytes = await decryptBackupBytes(entry.blob, passphrase);
    try {
      const jsonText = new TextDecoder().decode(decryptedBytes);
      return JSON.parse(jsonText) as PersistedAppState;
    } catch {
      throw new BackupUnauthorizedError('No autorizado');
    }
  }

  async getBackupRawBytes(filename: string): Promise<Uint8Array> {
    if (!isValidBackupFilename(filename)) {
      throw new BackupValidationError('Nombre de respaldo inválido');
    }
    const entry = this.files.get(filename);
    if (!entry) {
      throw new Error('Respaldo no encontrado');
    }
    return new Uint8Array(entry.blob);
  }

  /** Útil en pruebas para simular manipulación de bytes de un archivo .bak */
  tamperWithFile(filename: string, byteOffsetFromEnd = 1): void {
    const entry = this.files.get(filename);
    if (!entry) return;
    const copy = new Uint8Array(entry.blob);
    const idx = Math.max(0, copy.length - byteOffsetFromEnd);
    copy[idx] ^= 0xff;
    this.files.set(filename, { blob: copy, date: entry.date });
  }
}

/**
 * Adaptador híbrido: se comunica con local-server (/api/respaldo, /api/respaldo/restaurar)
 * y, cuando el servidor local no está levantado (p. ej. ng serve o pruebas aisladas sin backend),
 * utiliza el almacén local cifrado con AES-256-GCM.
 */
export class HttpBackupTransportAdapter implements BackupTransportAdapter {
  private readonly fallback = new InMemoryEncryptedBackupAdapter();

  private normalizeEntry(raw: any): BackupEntryMeta {
    const nombre = String(raw.nombre || raw.name || '');
    const fecha = String(raw.fecha || raw.date || new Date().toISOString());
    const tamano = Number(raw.tamano ?? raw['tamaño'] ?? raw.size ?? 0);
    return {
      nombre,
      fecha,
      tamano,
      name: nombre,
      date: fecha,
      size: tamano,
    };
  }

  async createBackup(state: PersistedAppState, passphrase: string): Promise<BackupEntryMeta> {
    const check = validateBackupPassphrase(passphrase);
    if (!check.valid) {
      throw new BackupValidationError(check.message!);
    }

    if (typeof fetch === 'function') {
      try {
        const res = await fetch('/api/respaldo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Backup-Passphrase': encodeURIComponent(passphrase),
          },
          body: JSON.stringify(state),
        });
        if (res.status === 200) {
          const data = await res.json();
          return this.normalizeEntry(data);
        }
        if (res.status === 400 || res.status === 403) {
          const errBody = await res.json().catch(() => ({}));
          throw new BackupValidationError(errBody?.detail || 'No se pudo crear el respaldo.');
        }
      } catch (err) {
        if (err instanceof BackupValidationError || err instanceof BackupUnauthorizedError) {
          throw err;
        }
        // Si fetch falla por red o 404 (servidor Python no activo en ng serve), usar cifrado local AES-GCM
      }
    }

    return this.fallback.createBackup(state, passphrase);
  }

  async listBackups(): Promise<BackupEntryMeta[]> {
    if (typeof fetch === 'function') {
      try {
        const res = await fetch('/api/respaldo', { cache: 'no-store' });
        if (res.status === 200) {
          const list = await res.json();
          if (Array.isArray(list)) {
            return list.map((item) => this.normalizeEntry(item));
          }
        }
      } catch {
        // Fallback cuando local-server no está activo
      }
    }
    return this.fallback.listBackups();
  }

  async restoreBackup(passphrase: string, filename?: string): Promise<PersistedAppState> {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
      throw new BackupUnauthorizedError('No autorizado');
    }

    if (typeof fetch === 'function') {
      try {
        const res = await fetch('/api/respaldo/restaurar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Backup-Passphrase': encodeURIComponent(passphrase),
          },
          body: JSON.stringify(filename ? { nombre: filename } : {}),
        });
        if (res.status === 200) {
          return (await res.json()) as PersistedAppState;
        }
        if (res.status === 403) {
          throw new BackupUnauthorizedError('No autorizado');
        }
      } catch (err) {
        if (err instanceof BackupUnauthorizedError) {
          throw err;
        }
      }
    }

    return this.fallback.restoreBackup(passphrase, filename);
  }

  async getBackupRawBytes(filename: string): Promise<Uint8Array> {
    if (!isValidBackupFilename(filename)) {
      throw new BackupValidationError('Nombre de respaldo inválido');
    }
    if (typeof fetch === 'function') {
      try {
        const res = await fetch(`/api/respaldo/${encodeURIComponent(filename)}`, {
          cache: 'no-store',
        });
        if (res.status === 200) {
          const buf = await res.arrayBuffer();
          return new Uint8Array(buf);
        }
      } catch {
        // Fallback
      }
    }
    return this.fallback.getBackupRawBytes(filename);
  }
}

/**
 * Copia un archivo .bak cifrado a una memoria USB (o carpeta elegida por el usuario).
 * Usa File System Access API (`window.showDirectoryPicker`) cuando está disponible en el navegador
 * (Chromium/Edge/Chrome en localhost o HTTPS) y descarga el archivo `.bak` directamente como respaldo
 * en navegadores sin soporte (Firefox, Safari).
 */
export async function copyBackupToUsb(
  filename: string,
  rawBytes: Uint8Array
): Promise<UsbCopyResult> {
  const win = typeof window !== 'undefined' ? (window as any) : undefined;
  if (win && typeof win.showDirectoryPicker === 'function') {
    const dirHandle = await win.showDirectoryPicker({ mode: 'readwrite' });
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(rawBytes);
    await writable.close();
    return {
      ok: true,
      method: 'filesystem',
      filename,
      message: `Respaldo ${filename} guardado directamente en la carpeta / memoria USB seleccionada.`,
    };
  }

  if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    try {
      const blob = new Blob([rawBytes as unknown as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Ignorar en entornos sin DOM completo
    }
  }

  return {
    ok: true,
    method: 'download',
    filename,
    message: `El navegador no soporta acceso directo a carpetas (File System Access API). Se inició la descarga de ${filename} para copiarlo a la memoria USB.`,
  };
}
