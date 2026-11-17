/**
 * Cifrado en reposo del estado local (Bloque K).
 *
 * =====================================================================================
 * QUÉ HACE
 * `EncryptedStorageAdapter` envuelve a cualquier `StateStorageAdapter` (hoy IndexedDB; mañana
 * cualquier otro almacenamiento local) y cifra cada valor con AES-256-GCM antes de entregarlo
 * al adaptador interno. Las claves (nombres de registro) quedan en claro para poder listarlas;
 * los valores nunca.
 *
 * LLAVES (cifrado por sobre / envelope encryption)
 * - Una llave de datos aleatoria (DEK, AES-256-GCM) cifra todos los registros.
 * - La DEK se guarda envuelta por cada PIN de administrador: KEK = PBKDF2-HMAC-SHA256(PIN, sal
 *   aleatoria de 16 bytes, 600,000 iteraciones). Cada administrador tiene su propia "ranura".
 * - Cambiar el PIN solo re-envuelve la DEK (no hay que volver a cifrar todos los datos).
 * - La DEK solo vive en memoria mientras la app está abierta y desbloqueada.
 *
 * FORMATO VERSIONADO
 * - Registro cifrado: { __btenc: 1, alg: 'AES-256-GCM', kid, iv, ct } (base64).
 *   AAD = "BTENC|v1|<kid>|<clave del registro>": un registro no se puede mover a otra clave ni a
 *   otro almacén sin que falle la autenticación.
 * - Almacén de llaves (`__binnitech_keystore_v1__`): { format: 'BTKEYS', version: 1, kid, slots[] }.
 *   Cada ranura guarda sus propias iteraciones, así se pueden subir en el futuro sin romper nada.
 *
 * SI SE OLVIDA EL PIN
 * No hay puerta trasera: sin un PIN de administrador válido, lo cifrado no se puede leer. La
 * recuperación es restaurar un respaldo .bak (Bloque E, protegido por la frase de respaldo) y
 * definir un PIN nuevo. Ver README, sección "Datos personales (Bloque K)".
 *
 * LÍMITE CONOCIDO
 * La fuerza del cifrado depende del PIN: un PIN de 6 dígitos tiene solo 1,000,000 de
 * combinaciones. PBKDF2 con 600,000 iteraciones hace lento cada intento, pero con el archivo
 * robado y hardware dedicado sigue siendo atacable. Por eso se recomienda un PIN de 8+ dígitos.
 * =====================================================================================
 */

import type { StateStorageAdapter } from './persistence';

export const STORAGE_KEYSTORE_KEY = '__binnitech_keystore_v1__';
export const STORAGE_KEYSTORE_FORMAT = 'BTKEYS';
export const STORAGE_KEYSTORE_VERSION = 1;
export const ENCRYPTED_RECORD_VERSION = 1;
export const ENCRYPTED_RECORD_ALG = 'AES-256-GCM';
export const STORAGE_PBKDF2_ITERATIONS = 600_000;
export const STORAGE_SALT_BYTES = 16;
export const STORAGE_IV_BYTES = 12;
export const STORAGE_DEK_BYTES = 32;

export type EncryptedStorageStatus = 'unconfigured' | 'locked' | 'unlocked';

/** Registro cifrado tal como queda guardado en el adaptador interno (IndexedDB). */
export interface EncryptedRecordEnvelope {
  __btenc: number;
  alg: string;
  kid: string;
  iv: string;
  ct: string;
}

/** Ranura de llave: la DEK envuelta con la KEK derivada del PIN de un administrador. */
export interface StorageKeySlot {
  slotId: string;
  kdf: 'PBKDF2-HMAC-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  wrappedKey: string;
  /** Sal del hash de PIN del usuario al momento de envolver (detecta ranuras desactualizadas). */
  userPinSalt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageKeystore {
  format: string;
  version: number;
  kid: string;
  cipher: string;
  createdAt: string;
  updatedAt: string;
  slots: StorageKeySlot[];
}

export interface EncryptedStorageOptions {
  iterations?: number;
  keystoreKey?: string;
  now?: () => Date;
}

export interface UnlockResult {
  ok: boolean;
  slotId?: string;
  message: string;
}

export interface MigrationReport {
  migratedKeys: string[];
  alreadyEncryptedKeys: string[];
}

export class StorageLockedError extends Error {
  readonly code = 'STORAGE_LOCKED';
  constructor(message = 'El almacenamiento cifrado está bloqueado: ingresa el PIN de administrador.') {
    super(message);
    this.name = 'StorageLockedError';
  }
}

export class StorageDecryptionError extends Error {
  readonly code = 'STORAGE_DECRYPT';
  constructor(message = 'No se pudo descifrar el registro: llave incorrecta o dato alterado.') {
    super(message);
    this.name = 'StorageDecryptionError';
  }
}

export class UnsupportedEncryptionFormatError extends Error {
  readonly code = 'STORAGE_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEncryptionFormatError';
  }
}

// ---------------------------------------------------------------------------------------
// Utilidades (autocontenidas: los módulos de dominio no se importan entre sí en tiempo de
// ejecución para que `node --experimental-strip-types` pueda cargarlos sin bundler).
// ---------------------------------------------------------------------------------------

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) no está disponible: se requiere https:// o localhost.');
  }
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function asBuffer(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function recordAad(kid: string, storageKey: string): Uint8Array {
  return new TextEncoder().encode(`BTENC|v${ENCRYPTED_RECORD_VERSION}|${kid}|${storageKey}`);
}

function slotAad(kid: string, slotId: string): Uint8Array {
  return new TextEncoder().encode(`BTKEYS|v${STORAGE_KEYSTORE_VERSION}|${kid}|${slotId}`);
}

/** Detecta si un valor guardado es un registro cifrado (sin intentar descifrarlo). */
export function isEncryptedEnvelope(value: unknown): value is EncryptedRecordEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).__btenc === 'number' &&
    typeof (value as any).iv === 'string' &&
    typeof (value as any).ct === 'string'
  );
}

export function isValidKeystore(value: unknown): value is StorageKeystore {
  const ks = value as StorageKeystore;
  return (
    !!ks &&
    typeof ks === 'object' &&
    ks.format === STORAGE_KEYSTORE_FORMAT &&
    typeof ks.version === 'number' &&
    typeof ks.kid === 'string' &&
    Array.isArray(ks.slots)
  );
}

/** Deriva la KEK (AES-256-GCM, no exportable) a partir del PIN con PBKDF2-HMAC-SHA256. */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations = STORAGE_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const material = await subtle.importKey(
    'raw',
    asBuffer(new TextEncoder().encode(String(pin ?? '').trim())),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: asBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  // Exportable únicamente para poder re-envolverla al cambiar o agregar un PIN de administrador.
  return getSubtle().importKey('raw', asBuffer(raw), { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function buildSlot(
  dek: CryptoKey,
  kid: string,
  slotId: string,
  pin: string,
  iterations: number,
  nowIso: string,
  userPinSalt?: string,
  createdAt?: string
): Promise<StorageKeySlot> {
  const subtle = getSubtle();
  const salt = randomBytes(STORAGE_SALT_BYTES);
  const iv = randomBytes(STORAGE_IV_BYTES);
  const kek = await deriveKeyFromPin(pin, salt, iterations);
  const rawDek = new Uint8Array(await subtle.exportKey('raw', dek));
  const wrapped = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(slotAad(kid, slotId)) },
      kek,
      asBuffer(rawDek)
    )
  );
  rawDek.fill(0);
  return {
    slotId,
    kdf: 'PBKDF2-HMAC-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(wrapped),
    userPinSalt,
    createdAt: createdAt || nowIso,
    updatedAt: nowIso,
  };
}

async function tryOpenSlot(kid: string, slot: StorageKeySlot, pin: string): Promise<CryptoKey | null> {
  try {
    const kek = await deriveKeyFromPin(pin, base64ToBytes(slot.salt), slot.iterations);
    const raw = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: asBuffer(base64ToBytes(slot.iv)),
          additionalData: asBuffer(slotAad(kid, slot.slotId)),
        },
        kek,
        asBuffer(base64ToBytes(slot.wrappedKey))
      )
    );
    if (raw.length !== STORAGE_DEK_BYTES) return null;
    const dek = await importDek(raw);
    raw.fill(0);
    return dek;
  } catch {
    // AES-GCM rechaza la etiqueta de autenticación: PIN incorrecto o ranura alterada.
    return null;
  }
}

/** Cifra un valor JSON y devuelve el sobre versionado (exportada para pruebas). */
export async function encryptRecord(
  dek: CryptoKey,
  kid: string,
  storageKey: string,
  value: unknown
): Promise<EncryptedRecordEnvelope> {
  const iv = randomBytes(STORAGE_IV_BYTES);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await getSubtle().encrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(recordAad(kid, storageKey)) },
      dek,
      asBuffer(plain)
    )
  );
  return {
    __btenc: ENCRYPTED_RECORD_VERSION,
    alg: ENCRYPTED_RECORD_ALG,
    kid,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ct),
  };
}

/** Descifra un sobre versionado; lanza error si la versión no se reconoce o la llave no corresponde. */
export async function decryptRecord(
  dek: CryptoKey,
  kid: string,
  storageKey: string,
  envelope: EncryptedRecordEnvelope
): Promise<any> {
  if (envelope.__btenc !== ENCRYPTED_RECORD_VERSION || envelope.alg !== ENCRYPTED_RECORD_ALG) {
    throw new UnsupportedEncryptionFormatError(
      `Formato de registro cifrado no soportado (versión ${envelope.__btenc}, ${envelope.alg}).`
    );
  }
  if (envelope.kid !== kid) {
    throw new StorageDecryptionError(
      `El registro "${storageKey}" fue cifrado con otro almacén de llaves (${envelope.kid}).`
    );
  }
  try {
    const plain = await getSubtle().decrypt(
      {
        name: 'AES-GCM',
        iv: asBuffer(base64ToBytes(envelope.iv)),
        additionalData: asBuffer(recordAad(kid, storageKey)),
      },
      dek,
      asBuffer(base64ToBytes(envelope.ct))
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new StorageDecryptionError(`El registro "${storageKey}" se descifró pero no es JSON válido.`);
    }
    throw new StorageDecryptionError(
      `No se pudo descifrar "${storageKey}": llave incorrecta o dato alterado.`
    );
  }
}

/**
 * Adaptador que cifra en reposo todo lo que guarda el adaptador interno.
 * Reutilizable con cualquier `StateStorageAdapter` (IndexedDB hoy; otro almacenamiento local mañana).
 */
export class EncryptedStorageAdapter implements StateStorageAdapter {
  readonly inner: StateStorageAdapter;
  private readonly iterations: number;
  private readonly keystoreKey: string;
  private readonly now: () => Date;
  private dek: CryptoKey | null = null;
  private keystore: StorageKeystore | null = null;
  private unlockedSlotId: string | null = null;

  constructor(inner: StateStorageAdapter, options: EncryptedStorageOptions = {}) {
    this.inner = inner;
    this.iterations = options.iterations ?? STORAGE_PBKDF2_ITERATIONS;
    this.keystoreKey = options.keystoreKey ?? STORAGE_KEYSTORE_KEY;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------- Estado del almacén de llaves ----------------

  async loadKeystore(): Promise<StorageKeystore | null> {
    const raw = await this.inner.load(this.keystoreKey);
    if (raw === null || raw === undefined) return null;
    if (!isValidKeystore(raw)) {
      throw new UnsupportedEncryptionFormatError('El almacén de llaves está dañado o tiene un formato desconocido.');
    }
    if (raw.version > STORAGE_KEYSTORE_VERSION) {
      throw new UnsupportedEncryptionFormatError(
        `El almacén de llaves es de una versión más nueva (${raw.version}); actualiza la aplicación.`
      );
    }
    return raw;
  }

  async getStatus(): Promise<EncryptedStorageStatus> {
    if (this.dek && this.keystore) return 'unlocked';
    const ks = await this.loadKeystore();
    return ks ? 'locked' : 'unconfigured';
  }

  isUnlocked(): boolean {
    return this.dek !== null && this.keystore !== null;
  }

  getUnlockedSlotId(): string | null {
    return this.unlockedSlotId;
  }

  async listSlots(): Promise<StorageKeySlot[]> {
    const ks = this.keystore ?? (await this.loadKeystore());
    return ks ? ks.slots.map((s) => ({ ...s })) : [];
  }

  /** Olvida la llave de datos de la memoria. */
  lock(): void {
    this.dek = null;
    this.keystore = null;
    this.unlockedSlotId = null;
  }

  /**
   * Primera configuración: crea la llave de datos, la ranura del administrador y cifra
   * (migra) todo lo que ya estuviera guardado sin cifrar.
   */
  async initialize(slotId: string, pin: string, userPinSalt?: string): Promise<MigrationReport> {
    if (!slotId) throw new Error('Se requiere el identificador del administrador para la ranura de llave.');
    if (!String(pin ?? '').trim()) throw new Error('Se requiere el PIN de administrador.');
    const existing = await this.loadKeystore();
    if (existing) {
      throw new Error('El cifrado ya está configurado en este equipo; desbloquéalo con el PIN de administrador.');
    }
    const nowIso = this.now().toISOString();
    const kid = bytesToHex(randomBytes(16));
    const dek = await importDek(randomBytes(STORAGE_DEK_BYTES));
    const slot = await buildSlot(dek, kid, slotId, pin, this.iterations, nowIso, userPinSalt);
    const keystore: StorageKeystore = {
      format: STORAGE_KEYSTORE_FORMAT,
      version: STORAGE_KEYSTORE_VERSION,
      kid,
      cipher: ENCRYPTED_RECORD_ALG,
      createdAt: nowIso,
      updatedAt: nowIso,
      slots: [slot],
    };
    // Primero se escribe el almacén de llaves: si la migración se interrumpe, al desbloquear
    // se reanuda (migratePlaintext) y no queda ningún dato cifrado con una llave perdida.
    await this.inner.save(this.keystoreKey, keystore);
    this.keystore = keystore;
    this.dek = dek;
    this.unlockedSlotId = slotId;
    return this.migratePlaintext();
  }

  async unlock(pin: string): Promise<UnlockResult> {
    const ks = await this.loadKeystore();
    if (!ks) {
      return { ok: false, message: 'El cifrado todavía no está configurado en este equipo.' };
    }
    if (!String(pin ?? '').trim()) {
      return { ok: false, message: 'Ingresa el PIN de administrador.' };
    }
    const attempts = await Promise.all(ks.slots.map((slot) => tryOpenSlot(ks.kid, slot, pin)));
    const index = attempts.findIndex((key) => key !== null);
    if (index < 0) {
      return { ok: false, message: 'PIN de administrador incorrecto.' };
    }
    this.dek = attempts[index];
    this.keystore = ks;
    this.unlockedSlotId = ks.slots[index].slotId;
    return { ok: true, slotId: this.unlockedSlotId, message: 'Datos desbloqueados.' };
  }

  /** Agrega o re-envuelve la ranura de un administrador (requiere estar desbloqueado). */
  async setSlot(slotId: string, pin: string, userPinSalt?: string): Promise<void> {
    const { dek, keystore } = this.requireUnlocked();
    const nowIso = this.now().toISOString();
    const previous = keystore.slots.find((s) => s.slotId === slotId);
    const slot = await buildSlot(
      dek,
      keystore.kid,
      slotId,
      pin,
      this.iterations,
      nowIso,
      userPinSalt,
      previous?.createdAt
    );
    const next: StorageKeystore = {
      ...keystore,
      updatedAt: nowIso,
      slots: [...keystore.slots.filter((s) => s.slotId !== slotId), slot],
    };
    await this.inner.save(this.keystoreKey, next);
    this.keystore = next;
  }

  /** Elimina la ranura de un administrador; nunca deja el almacén sin ranuras. */
  async removeSlot(slotId: string): Promise<boolean> {
    const { keystore } = this.requireUnlocked();
    if (!keystore.slots.some((s) => s.slotId === slotId)) return false;
    if (keystore.slots.length <= 1) {
      throw new Error('No se puede eliminar la última llave de administrador: los datos quedarían inaccesibles.');
    }
    const next: StorageKeystore = {
      ...keystore,
      updatedAt: this.now().toISOString(),
      slots: keystore.slots.filter((s) => s.slotId !== slotId),
    };
    await this.inner.save(this.keystoreKey, next);
    this.keystore = next;
    return true;
  }

  /**
   * Cifra todo valor que siga en claro dentro del adaptador interno y comprueba cada uno
   * leyéndolo de vuelta. Si la comprobación falla, se reescribe el valor original en claro.
   */
  async migratePlaintext(): Promise<MigrationReport> {
    const { dek, keystore } = this.requireUnlocked();
    const report: MigrationReport = { migratedKeys: [], alreadyEncryptedKeys: [] };
    if (!this.inner.listKeys) return report;
    const keys = (await this.inner.listKeys()).filter((k) => k !== this.keystoreKey);
    for (const key of keys) {
      const raw = await this.inner.load(key);
      if (raw === null || raw === undefined) continue;
      if (isEncryptedEnvelope(raw)) {
        report.alreadyEncryptedKeys.push(key);
        continue;
      }
      const envelope = await encryptRecord(dek, keystore.kid, key, raw);
      await this.inner.save(key, envelope);
      let verified = false;
      try {
        const back = await this.inner.load(key);
        const decoded = isEncryptedEnvelope(back) ? await decryptRecord(dek, keystore.kid, key, back) : undefined;
        verified = JSON.stringify(decoded) === JSON.stringify(raw);
      } catch {
        verified = false;
      }
      if (!verified) {
        await this.inner.save(key, raw);
        throw new Error(`La migración de "${key}" no pasó la verificación; el dato original se conservó sin cambios.`);
      }
      report.migratedKeys.push(key);
    }
    return report;
  }

  /**
   * Borra TODO lo guardado (incluido el almacén de llaves). Solo para la recuperación por
   * respaldo cuando se olvidó el PIN: los datos cifrados con el PIN perdido son irrecuperables.
   */
  async resetAll(): Promise<void> {
    this.lock();
    await this.inner.clear();
    if (this.inner.delete) {
      await this.inner.delete(this.keystoreKey);
    }
  }

  // ---------------- StateStorageAdapter ----------------

  async save(key: string, value: any): Promise<void> {
    this.assertNotKeystoreKey(key);
    const { dek, keystore } = this.requireUnlocked();
    await this.inner.save(key, await encryptRecord(dek, keystore.kid, key, value));
  }

  async load(key: string): Promise<any> {
    this.assertNotKeystoreKey(key);
    const raw = await this.inner.load(key);
    if (raw === null || raw === undefined) return null;
    if (!isEncryptedEnvelope(raw)) {
      // Dato heredado sin cifrar (anterior al Bloque K). Se puede leer para migrarlo; si ya hay
      // llave en memoria se vuelve a guardar cifrado de inmediato.
      if (this.isUnlocked()) {
        try {
          await this.save(key, raw);
        } catch {
          // El dato se devuelve aunque el re-cifrado falle; migratePlaintext lo reintentará.
        }
      }
      return raw;
    }
    if (!this.dek || !this.keystore) {
      throw new StorageLockedError();
    }
    return decryptRecord(this.dek, this.keystore.kid, key, raw);
  }

  async delete(key: string): Promise<void> {
    this.assertNotKeystoreKey(key);
    if (this.inner.delete) await this.inner.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = this.inner.listKeys ? await this.inner.listKeys(prefix) : [];
    return keys.filter((k) => k !== this.keystoreKey);
  }

  /** Borra los datos pero conserva el almacén de llaves (el PIN sigue siendo el mismo). */
  async clear(): Promise<void> {
    const keystore = await this.inner.load(this.keystoreKey);
    await this.inner.clear();
    if (keystore) await this.inner.save(this.keystoreKey, keystore);
  }

  // ---------------- Internos ----------------

  private requireUnlocked(): { dek: CryptoKey; keystore: StorageKeystore } {
    if (!this.dek || !this.keystore) throw new StorageLockedError();
    return { dek: this.dek, keystore: this.keystore };
  }

  private assertNotKeystoreKey(key: string): void {
    if (key === this.keystoreKey) {
      throw new Error('La clave del almacén de llaves está reservada.');
    }
  }
}

/**
 * Busca la capa de cifrado dentro de una pila de adaptadores
 * (p. ej. ServerStateStorageAdapter -> EncryptedStorageAdapter -> IndexedDbStateStorageAdapter).
 */
export function findEncryptedLayer(adapter: unknown): EncryptedStorageAdapter | null {
  let current: any = adapter;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof EncryptedStorageAdapter) return current;
    current = current.fallbackAdapter ?? null;
  }
  return null;
}
