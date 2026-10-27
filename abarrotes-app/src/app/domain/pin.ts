/**
 * Lógica pura de dominio para autenticación por PIN de Administrador (Web Crypto API - PBKDF2).
 *
 * =====================================================================================
 * AVISO DE SEGURIDAD Y CONTROL DE AUTORIZACIÓN:
 * El PIN de administrador actúa estrictamente como un control interno de autorización operativa
 * en el flujo de trabajo de la tienda (Point of Sale / Backoffice). Su propósito es asegurar
 * que ajustes de auditoría, diferencias de inventario y bajas de merma cuenten con la aprobación
 * presencial del encargado o dueño, evitando errores u omisiones de cajeros en el mostrador.
 *
 * NO constituye un límite criptográfico contra alguien con acceso físico directo o privilegios
 * de administración en el sistema operativo de la computadora local (PC del negocio).
 * =====================================================================================
 */

export interface PinAuthConfig {
  salt: string;
  pinHash: string;
  iterations: number;
  maxAttempts: number;
  lockoutDurationMs: number;
}

export interface PinAuthState {
  failedAttempts: number;
  lockedUntil: number | null;
}

export function createInitialPinState(): PinAuthState {
  return { failedAttempts: 0, lockedUntil: null };
}

export interface PinVerificationResult {
  success: boolean;
  message: string;
  remainingAttempts: number;
  isLocked: boolean;
  lockedRemainingSeconds: number;
  nextState: PinAuthState;
  authorizedBy?: string;
  isFirstUseRequired?: boolean;
}

export interface PinStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryPinStorage implements PinStorageAdapter {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function getDefaultStorage(): PinStorageAdapter {
  if (typeof globalThis.localStorage !== 'undefined') {
    return globalThis.localStorage;
  }
  return new MemoryPinStorage();
}

const STORAGE_KEY_CONFIG = 'binnitech_pin_config_v2';
const STORAGE_KEY_STATE = 'binnitech_pin_state_v2';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Genera una sal criptográfica aleatoria de 16 bytes en hexadecimal.
 */
export function generateSalt(length = 16): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * Deriva el hash del PIN usando PBKDF2 (SHA-256, >= 100,000 iteraciones).
 * Nunca almacena el PIN en texto plano.
 */
export async function computePinHash(
  pin: string,
  saltHex: string,
  iterations = 100_000
): Promise<string> {
  const cleanPin = pin.trim();
  const enc = new TextEncoder();
  const saltBytes = hexToBytes(saltHex);

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(cleanPin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

/**
 * Verifica si ya existe un PIN configurado en el sistema.
 */
export function isPinConfigured(storage: PinStorageAdapter = getDefaultStorage()): boolean {
  return storage.getItem(STORAGE_KEY_CONFIG) !== null;
}

/**
 * Obtiene la configuración guardada o null si no se ha configurado (primer uso obligatorio).
 */
export function loadPinConfig(storage: PinStorageAdapter = getDefaultStorage()): PinAuthConfig | null {
  const raw = storage.getItem(STORAGE_KEY_CONFIG);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Obliga a crear el PIN en el primer uso (sin PIN por defecto).
 */
export async function setupInitialPin(
  newPin: string,
  storage: PinStorageAdapter = getDefaultStorage(),
  iterations = 100_000,
  maxAttempts = 3,
  lockoutDurationMs = 30_000
): Promise<PinAuthConfig> {
  const clean = newPin.trim();
  if (clean.length < 4) {
    throw new Error('El PIN debe tener al menos 4 caracteres numéricos.');
  }

  const salt = generateSalt(16);
  const pinHash = await computePinHash(clean, salt, iterations);

  const config: PinAuthConfig = {
    salt,
    pinHash,
    iterations,
    maxAttempts,
    lockoutDurationMs,
  };

  storage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  // Resetea cualquier estado anterior
  storage.setItem(
    STORAGE_KEY_STATE,
    JSON.stringify({ failedAttempts: 0, lockedUntil: null })
  );

  return config;
}

/**
 * Lee el estado persistido de intentos y bloqueo (sobrevive a recargas).
 */
export function loadPinState(storage: PinStorageAdapter = getDefaultStorage()): PinAuthState {
  const raw = storage.getItem(STORAGE_KEY_STATE);
  if (!raw) {
    return { failedAttempts: 0, lockedUntil: null };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
    };
  } catch {
    return { failedAttempts: 0, lockedUntil: null };
  }
}

/**
 * Guarda el estado persistido de intentos y bloqueo.
 */
export function savePinState(
  state: PinAuthState,
  storage: PinStorageAdapter = getDefaultStorage()
): void {
  storage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
}

/**
 * Verifica un intento de PIN considerando persistencia de intentos, bloqueo y obligatoriedad de primer uso.
 */
export async function verifyPinAttempt(
  pin: string,
  storage: PinStorageAdapter = getDefaultStorage(),
  now: number = Date.now(),
  authorizerName = 'Administrador'
): Promise<PinVerificationResult> {
  const config = loadPinConfig(storage);
  if (!config) {
    return {
      success: false,
      message: 'No hay PIN configurado. Es obligatorio crear el PIN de administrador en el primer uso.',
      remainingAttempts: 0,
      isLocked: false,
      lockedRemainingSeconds: 0,
      nextState: { failedAttempts: 0, lockedUntil: null },
      isFirstUseRequired: true,
    };
  }

  const currentState = loadPinState(storage);

  // 1. Verificar si está en ventana de bloqueo
  if (currentState.lockedUntil !== null) {
    if (now < currentState.lockedUntil) {
      const remainingSeconds = Math.max(1, Math.ceil((currentState.lockedUntil - now) / 1000));
      return {
        success: false,
        message: `Acceso bloqueado por seguridad (${remainingSeconds} s restantes).`,
        remainingAttempts: 0,
        isLocked: true,
        lockedRemainingSeconds: remainingSeconds,
        nextState: { ...currentState },
      };
    }
  }

  // Si el bloqueo expiró, reseteamos el conteo de fallos
  const effectiveAttempts =
    currentState.lockedUntil !== null && now >= currentState.lockedUntil
      ? 0
      : currentState.failedAttempts;

  // 2. Verificar PBKDF2 hash
  const attemptHash = await computePinHash(pin, config.salt, config.iterations);
  const isValid = attemptHash === config.pinHash;

  if (isValid) {
    const nextState: PinAuthState = { failedAttempts: 0, lockedUntil: null };
    savePinState(nextState, storage);
    return {
      success: true,
      message: 'PIN verificado correctamente.',
      remainingAttempts: config.maxAttempts,
      isLocked: false,
      lockedRemainingSeconds: 0,
      nextState,
      authorizedBy: authorizerName,
    };
  }

  // 3. Fallo: incrementar y persistir
  const newFailedAttempts = effectiveAttempts + 1;
  if (newFailedAttempts >= config.maxAttempts) {
    const lockedUntil = now + config.lockoutDurationMs;
    const lockSeconds = Math.ceil(config.lockoutDurationMs / 1000);
    const nextState: PinAuthState = {
      failedAttempts: newFailedAttempts,
      lockedUntil,
    };
    savePinState(nextState, storage);
    return {
      success: false,
      message: `PIN incorrecto. Límite de ${config.maxAttempts} intentos alcanzado. Bloqueado por ${lockSeconds} segundos.`,
      remainingAttempts: 0,
      isLocked: true,
      lockedRemainingSeconds: lockSeconds,
      nextState,
    };
  }

  const remainingAttempts = config.maxAttempts - newFailedAttempts;
  const nextState: PinAuthState = {
    failedAttempts: newFailedAttempts,
    lockedUntil: null,
  };
  savePinState(nextState, storage);

  return {
    success: false,
    message: `PIN incorrecto. Intentos restantes: ${remainingAttempts}.`,
    remainingAttempts,
    isLocked: false,
    lockedRemainingSeconds: 0,
    nextState,
  };
}
