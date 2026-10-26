/**
 * Lógica pura de dominio para autenticación por PIN de Administrador (Web Crypto API).
 * Aplica SHA-256 con sal para autorizar ajustes de auditoría y bajas de merma.
 * Regla de negocio: Máximo 3 intentos y bloqueo de 30 segundos.
 * Nunca almacena el PIN en texto claro.
 */

export interface PinAuthConfig {
  salt: string;
  pinHash: string;
  maxAttempts: number;
  lockoutDurationMs: number;
}

export interface PinAuthState {
  failedAttempts: number;
  lockedUntil: number | null;
}

export interface PinVerificationResult {
  success: boolean;
  message: string;
  remainingAttempts: number;
  isLocked: boolean;
  lockedRemainingSeconds: number;
  nextState: PinAuthState;
  authorizedBy?: string;
}

/**
 * Genera una sal criptográfica aleatoria en hexadecimal.
 */
export function generateSalt(length = 16): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * Calcula el hash SHA-256 con sal usando Web Crypto API.
 * Nunca almacena ni retorna el PIN en texto plano.
 */
export async function computePinHash(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${pin.trim()}`);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Crea una configuración de PIN segura con sal y hash.
 * El PIN por defecto de demostración es configurable (por defecto '1234').
 */
export async function createPinConfig(
  pin = '1234',
  salt: string = generateSalt(),
  maxAttempts = 3,
  lockoutDurationMs = 30_000
): Promise<PinAuthConfig> {
  const pinHash = await computePinHash(pin, salt);
  return {
    salt,
    pinHash,
    maxAttempts,
    lockoutDurationMs,
  };
}

/**
 * Estado inicial de intentos de PIN.
 */
export function createInitialPinState(): PinAuthState {
  return {
    failedAttempts: 0,
    lockedUntil: null,
  };
}

/**
 * Verifica un intento de PIN de forma pura según las reglas:
 * - Si está en ventana de bloqueo (< 30s): rechaza y reporta segundos restantes.
 * - Si el PIN es correcto: resetea intentos fallidos a 0 y autoriza.
 * - Si el PIN es incorrecto: incrementa intentos fallidos. Al 3er fallo bloquea por 30 segundos.
 */
export async function verifyPinAttempt(
  pin: string,
  config: PinAuthConfig,
  currentState: PinAuthState,
  now: number = Date.now(),
  authorizerName = 'Administrador'
): Promise<PinVerificationResult> {
  // 1. Verificar si actualmente está bloqueado
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

  // Si el bloqueo ya expiró, reseteamos el estado de fallos previo
  const effectiveAttempts =
    currentState.lockedUntil !== null && now >= currentState.lockedUntil
      ? 0
      : currentState.failedAttempts;

  // 2. Comprobar hash criptográfico
  const attemptHash = await computePinHash(pin, config.salt);
  const isValid = attemptHash === config.pinHash;

  if (isValid) {
    return {
      success: true,
      message: 'PIN verificado correctamente.',
      remainingAttempts: config.maxAttempts,
      isLocked: false,
      lockedRemainingSeconds: 0,
      nextState: {
        failedAttempts: 0,
        lockedUntil: null,
      },
      authorizedBy: authorizerName,
    };
  }

  // 3. Fallo de PIN: incrementar conteo
  const newFailedAttempts = effectiveAttempts + 1;

  if (newFailedAttempts >= config.maxAttempts) {
    const lockedUntil = now + config.lockoutDurationMs;
    const lockSeconds = Math.ceil(config.lockoutDurationMs / 1000);
    return {
      success: false,
      message: `PIN incorrecto. Se alcanzó el límite de ${config.maxAttempts} intentos. Bloqueado por ${lockSeconds} segundos.`,
      remainingAttempts: 0,
      isLocked: true,
      lockedRemainingSeconds: lockSeconds,
      nextState: {
        failedAttempts: newFailedAttempts,
        lockedUntil,
      },
    };
  }

  const remainingAttempts = config.maxAttempts - newFailedAttempts;
  return {
    success: false,
    message: `PIN incorrecto. Intentos restantes: ${remainingAttempts}.`,
    remainingAttempts,
    isLocked: false,
    lockedRemainingSeconds: 0,
    nextState: {
      failedAttempts: newFailedAttempts,
      lockedUntil: null,
    },
  };
}
