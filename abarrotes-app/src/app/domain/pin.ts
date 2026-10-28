/**
 * Lógica pura de dominio para autenticación por PIN de Administrador (Web Crypto API - PBKDF2).
 *
 * =====================================================================================
 * AVISO DE SEGURIDAD Y CONTROL DE AUTORIZACIÓN:
 * El PIN de administrador actúa estrictamente como un control interno de autorización operativa
 * en el flujo de trabajo de la tienda (Point of Sale / Backoffice). Su propósito es asegurar
 * que ajustes de auditoría, diferencias de inventario, cambio al perfil Administrador y bajas
 * de merma cuenten con la aprobación presencial del encargado o dueño, evitando errores u omisiones
 * de cajeros en el mostrador.
 *
 * NO constituye un límite criptográfico contra alguien con acceso físico directo o privilegios
 * de administración en el sistema operativo de la computadora local (PC del negocio).
 * =====================================================================================
 */

export const DEFAULT_PIN_ITERATIONS = 600_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const FIRST_LOCKOUT_MS = 30_000;   // 30 segundos en el primer bloqueo
export const SUBSEQUENT_LOCKOUT_MS = 300_000; // 5 minutos en bloqueos posteriores

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
  lockoutCount: number;
}

export function createInitialPinState(): PinAuthState {
  return { failedAttempts: 0, lockedUntil: null, lockoutCount: 0 };
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
  verificationDurationMs?: number;
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
 * Valida si un PIN es trivial (ej. dígitos idénticos, consecutivos ascendentes o descendentes).
 */
export function isTrivialPin(pin: string): boolean {
  const clean = pin.trim();
  if (clean.length < 6) return true;

  // 1. Todos los dígitos iguales (ej. "111111", "000000", "999999")
  if (new Set(clean.split('')).size === 1) {
    return true;
  }

  // 2. Secuencia ascendente continua (ej. "123456", "234567", "012345")
  let isAscending = true;
  for (let i = 1; i < clean.length; i++) {
    const prev = parseInt(clean[i - 1], 10);
    const curr = parseInt(clean[i], 10);
    if ((prev + 1) % 10 !== curr) {
      isAscending = false;
      break;
    }
  }
  if (isAscending) return true;

  // 3. Secuencia descendente continua (ej. "654321", "543210")
  let isDescending = true;
  for (let i = 1; i < clean.length; i++) {
    const prev = parseInt(clean[i - 1], 10);
    const curr = parseInt(clean[i], 10);
    if ((prev - 1 + 10) % 10 !== curr) {
      isDescending = false;
      break;
    }
  }
  if (isDescending) return true;

  // 4. Patrones de dos dígitos repetidos (ej. "121212", "090909")
  if (clean.length % 2 === 0) {
    const pair = clean.slice(0, 2);
    if (pair.repeat(clean.length / 2) === clean) {
      return true;
    }
  }

  return false;
}

/**
 * Valida la política de seguridad del PIN: mínimo 6 dígitos numéricos y no trivial.
 */
export function validatePinPolicy(pin: string): { valid: boolean; error?: string } {
  const clean = (pin ?? '').trim();
  if (clean.length < 6) {
    return {
      valid: false,
      error: 'El PIN debe contener al menos 6 dígitos numéricos.',
    };
  }
  if (!/^\d{6,}$/.test(clean)) {
    return {
      valid: false,
      error: 'El PIN solo debe contener números (0-9).',
    };
  }
  if (isTrivialPin(clean)) {
    return {
      valid: false,
      error: 'El PIN no puede ser una secuencia trivial (dígitos idénticos, consecutivos o patrones simples).',
    };
  }
  return { valid: true };
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
 * Deriva el hash del PIN usando PBKDF2 (SHA-256, >= 600,000 iteraciones).
 * Nunca almacena el PIN en texto plano.
 */
export async function computePinHash(
  pin: string,
  saltHex: string,
  iterations = DEFAULT_PIN_ITERATIONS
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
 * Exige mínimo 6 dígitos y rechaza secuencias triviales.
 */
export async function setupInitialPin(
  newPin: string,
  storage: PinStorageAdapter = getDefaultStorage(),
  iterations = DEFAULT_PIN_ITERATIONS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  lockoutDurationMs = FIRST_LOCKOUT_MS
): Promise<PinAuthConfig> {
  const policyCheck = validatePinPolicy(newPin);
  if (!policyCheck.valid) {
    throw new Error(policyCheck.error);
  }

  const clean = newPin.trim();
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
    JSON.stringify(createInitialPinState())
  );

  return config;
}

/**
 * Lee el estado persistido de intentos, bloqueo y conteo de bloqueos previos (sobrevive a recargas).
 */
export function loadPinState(storage: PinStorageAdapter = getDefaultStorage()): PinAuthState {
  const raw = storage.getItem(STORAGE_KEY_STATE);
  if (!raw) {
    return createInitialPinState();
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
      lockoutCount: typeof parsed.lockoutCount === 'number' ? parsed.lockoutCount : 0,
    };
  } catch {
    return createInitialPinState();
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
 * Verifica un intento de PIN considerando persistencia de intentos, bloqueo escalado
 * (30 s en primer bloqueo, 5 min en posteriores) e iteraciones PBKDF2 (>= 600,000).
 */
export async function verifyPinAttempt(
  pin: string,
  storage: PinStorageAdapter = getDefaultStorage(),
  now: number = Date.now(),
  authorizerName = 'Administrador'
): Promise<PinVerificationResult> {
  const startTime = typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
  const config = loadPinConfig(storage);
  if (!config) {
    return {
      success: false,
      message: 'No hay PIN configurado. Es obligatorio crear el PIN de administrador en el primer uso.',
      remainingAttempts: 0,
      isLocked: false,
      lockedRemainingSeconds: 0,
      nextState: createInitialPinState(),
      isFirstUseRequired: true,
    };
  }

  const currentState = loadPinState(storage);

  // 1. Verificar si está actualmente en ventana de bloqueo
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

  // Si el bloqueo expiró, reseteamos el conteo de fallos del ciclo actual manteniendo el lockoutCount
  const effectiveAttempts =
    currentState.lockedUntil !== null && now >= currentState.lockedUntil
      ? 0
      : currentState.failedAttempts;

  // 2. Verificar PBKDF2 hash (>= 600,000 iteraciones)
  const attemptHash = await computePinHash(pin, config.salt, config.iterations);
  const endTime = typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
  const durationMs = Math.round((endTime - startTime) * 100) / 100;
  const isValid = attemptHash === config.pinHash;

  if (isValid) {
    // Al autenticar correctamente, se reinician todos los contadores de bloqueo
    const nextState: PinAuthState = { failedAttempts: 0, lockedUntil: null, lockoutCount: 0 };
    savePinState(nextState, storage);
    return {
      success: true,
      message: 'PIN verificado correctamente.',
      remainingAttempts: config.maxAttempts,
      isLocked: false,
      lockedRemainingSeconds: 0,
      nextState,
      authorizedBy: authorizerName,
      verificationDurationMs: durationMs,
    };
  }

  // 3. Fallo: incrementar y evaluar si requiere bloqueo escalado
  const newFailedAttempts = effectiveAttempts + 1;
  if (newFailedAttempts >= config.maxAttempts) {
    const newLockoutCount = (currentState.lockoutCount || 0) + 1;
    // Bloqueo escalado: 1er bloqueo -> 30s (30,000 ms), posteriores -> 5 min (300,000 ms)
    const lockoutDurationMs = newLockoutCount === 1 ? FIRST_LOCKOUT_MS : SUBSEQUENT_LOCKOUT_MS;
    const lockedUntil = now + lockoutDurationMs;
    const lockSeconds = Math.ceil(lockoutDurationMs / 1000);

    const nextState: PinAuthState = {
      failedAttempts: newFailedAttempts,
      lockedUntil,
      lockoutCount: newLockoutCount,
    };
    savePinState(nextState, storage);

    const lockDurationText = newLockoutCount === 1 ? '30 segundos' : '5 minutos';
    return {
      success: false,
      message: `PIN incorrecto. Límite de ${config.maxAttempts} intentos alcanzado. Bloqueado por ${lockDurationText}.`,
      remainingAttempts: 0,
      isLocked: true,
      lockedRemainingSeconds: lockSeconds,
      nextState,
      verificationDurationMs: durationMs,
    };
  }

  const remainingAttempts = config.maxAttempts - newFailedAttempts;
  const nextState: PinAuthState = {
    failedAttempts: newFailedAttempts,
    lockedUntil: null,
    lockoutCount: currentState.lockoutCount || 0,
  };
  savePinState(nextState, storage);

  return {
    success: false,
    message: `PIN incorrecto. Intentos restantes: ${remainingAttempts}.`,
    remainingAttempts,
    isLocked: false,
    lockedRemainingSeconds: 0,
    nextState,
    verificationDurationMs: durationMs,
  };
}
