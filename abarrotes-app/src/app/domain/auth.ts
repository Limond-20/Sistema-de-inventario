/**
 * Lógica pura de dominio para Autenticación, Roles y Usuarios (Bloque G).
 *
 * MATRIZ DE PERMISOS:
 * - CAJERO:
 *     * vender: operar en el Punto de Venta (POS).
 *     * cobrar: registrar pagos en efectivo y transferencias.
 *     * abonar: registrar abonos a cuentas de fiado vecinal.
 *     * (Restricción: NO puede recepción, mermas, auditoría, ajustes, usuarios, respaldos ni restablecer).
 * - ENCARGADO:
 *     * Todo lo de Cajero (vender, cobrar, abonar).
 *     * recepcion: recibir compras de proveedores y notas de remisión.
 *     * mermas: registrar y revisar mermas por caducidad o merma natural.
 *     * auditoria: ejecutar auditorías de pasillo y conteos físicos.
 *     * cortes: realizar y consultar arqueos y cortes de turno/caja.
 *     * (Restricción: NO puede ajustes, administración de usuarios, respaldos ni restablecer).
 * - ADMINISTRADOR:
 *     * Todo lo de Encargado.
 *     * ajustes: modificar nombre de tienda, fondo inicial, márgenes, impuestos e inactividad.
 *     * usuarios: alta, baja lógica, cambio de rol y restablecimiento de PIN de usuarios.
 *     * precios: editar precios base y costos en catálogo.
 *     * respaldos: generar, exportar, cifrar e importar respaldos .bak.
 *     * restablecer: reinicializar estado operativo de la tienda.
 */

export const DEFAULT_PIN_ITERATIONS = 600_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const FIRST_LOCKOUT_MS = 30_000;   // 30 segundos en el primer bloqueo
export const SUBSEQUENT_LOCKOUT_MS = 300_000; // 5 minutos en bloqueos posteriores

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

export function generateSalt(length = 16): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function computePinHash(
  pin: string,
  saltHex: string,
  iterations = DEFAULT_PIN_ITERATIONS
): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(pin.trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const saltBytes = hexToBytes(saltHex);
  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

export function isTrivialPin(pin: string): boolean {
  const clean = pin.trim();
  if (clean.length < 6) return true;
  if (new Set(clean.split('')).size === 1) return true;
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
  let isDescending = true;
  for (let i = 1; i < clean.length; i++) {
    const prev = parseInt(clean[i - 1], 10);
    const curr = parseInt(clean[i], 10);
    if ((prev - 1 + 10) % 10 !== curr) {
      isDescending = false;
      break;
    }
  }
  return isDescending;
}

export function validatePinPolicy(pin: string): { valid: boolean; error?: string; reason?: string } {
  const clean = (pin ?? '').trim();
  if (clean.length < 6) {
    return {
      valid: false,
      error: 'El PIN debe contener al menos 6 dígitos numéricos.',
      reason: 'El PIN debe contener al menos 6 dígitos numéricos.',
    };
  }
  if (!/^\d{6,}$/.test(clean)) {
    return {
      valid: false,
      error: 'El PIN solo debe contener números (0-9).',
      reason: 'El PIN solo debe contener números (0-9).',
    };
  }
  if (isTrivialPin(clean)) {
    return {
      valid: false,
      error: 'El PIN no puede ser una secuencia trivial (dígitos idénticos, consecutivos o patrones simples).',
      reason: 'El PIN no puede ser una secuencia trivial (dígitos idénticos, consecutivos o patrones simples).',
    };
  }
  return { valid: true };
}

export type UserRole = 'CAJERO' | 'ENCARGADO' | 'ADMINISTRADOR';

export type Permission =
  | 'vender'
  | 'cobrar'
  | 'abonar'
  | 'recepcion'
  | 'mermas'
  | 'auditoria'
  | 'cortes'
  | 'ajustes'
  | 'usuarios'
  | 'precios'
  | 'respaldos'
  | 'restablecer';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  CAJERO: ['vender', 'cobrar', 'abonar'],
  ENCARGADO: ['vender', 'cobrar', 'abonar', 'recepcion', 'mermas', 'auditoria', 'cortes'],
  ADMINISTRADOR: [
    'vender',
    'cobrar',
    'abonar',
    'recepcion',
    'mermas',
    'auditoria',
    'cortes',
    'ajustes',
    'usuarios',
    'precios',
    'respaldos',
    'restablecer',
  ],
};

export interface AppUser {
  id: string;
  name: string;
  role: UserRole;
  salt: string;
  pinHash: string;
  iterations: number;
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: number | null;
  lockoutCount: number;
  createdAt: string;
  updatedAt?: string;
}

export interface UserPinVerifyResult {
  success: boolean;
  message: string;
  user?: AppUser;
  remainingAttempts: number;
  isLocked: boolean;
  lockedRemainingSeconds: number;
  updatedUser: AppUser;
}

let userSeq = 0;

export function generateUserId(): string {
  userSeq = (userSeq + 1) % 1_000_000;
  return `USR-${Date.now()}-${userSeq}`;
}

/**
 * Normaliza nombres para comparación y prevención de duplicados (minúsculas, sin acentos).
 */
export function normalizeUserName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Verifica si existe un usuario duplicado por nombre.
 */
export function checkUserDuplicate(users: AppUser[], name: string, excludeId?: string): boolean {
  const norm = normalizeUserName(name);
  if (!norm) return false;
  return users.some((u) => u.id !== excludeId && normalizeUserName(u.name) === norm);
}

/**
 * Determina si un rol cuenta con un permiso específico.
 */
export function hasPermission(role: UserRole, permission: Permission): boolean {
  const list = ROLE_PERMISSIONS[role];
  return !!list && list.includes(permission);
}

/**
 * Valida si un rol tiene autorización para acceder a una ruta de la aplicación.
 */
export function canAccessRoute(role: UserRole, routePath: string): boolean {
  const clean = routePath.split('?')[0].replace(/^\//, '');
  switch (clean) {
    case '':
    case 'pos':
      return hasPermission(role, 'vender');
    case 'recepcion':
      return hasPermission(role, 'recepcion');
    case 'mermas':
    case 'fefo':
      return hasPermission(role, 'mermas');
    case 'auditoria':
      return hasPermission(role, 'auditoria');
    case 'catalogo':
      return true; // Todos pueden ver catálogo; la edición de precios requiere 'precios'
    case 'ajustes':
      return hasPermission(role, 'ajustes');
    default:
      return true;
  }
}

/**
 * Crea un nuevo usuario con credenciales derivadas mediante PBKDF2.
 */
export async function createAppUser(params: {
  name: string;
  role: UserRole;
  pin: string;
  iterations?: number;
}): Promise<{ ok: boolean; message: string; user?: AppUser }> {
  const cleanName = (params.name || '').trim();
  if (cleanName.length < 2) {
    return { ok: false, message: 'El nombre de usuario debe tener al menos 2 caracteres.' };
  }

  const pinValidation = validatePinPolicy(params.pin);
  if (!pinValidation.valid) {
    return { ok: false, message: pinValidation.error || 'PIN inválido.' };
  }

  const salt = generateSalt(16);
  const iterations = params.iterations || DEFAULT_PIN_ITERATIONS;
  const pinHash = await computePinHash(params.pin, salt, iterations);

  const user: AppUser = {
    id: generateUserId(),
    name: cleanName,
    role: params.role,
    salt,
    pinHash,
    iterations,
    isActive: true,
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCount: 0,
    createdAt: new Date().toISOString(),
  };

  return { ok: true, message: 'Usuario creado exitosamente.', user };
}

/**
 * Verifica un intento de PIN para un usuario específico, gestionando el bloqueo temporal individual.
 */
export async function verifyUserPinAttempt(
  user: AppUser,
  pin: string,
  now: number = Date.now()
): Promise<UserPinVerifyResult> {
  const updatedUser: AppUser = { ...user };

  // 1. Verificar si el usuario está actualmente bloqueado
  if (updatedUser.lockedUntil && now < updatedUser.lockedUntil) {
    const remainingMs = updatedUser.lockedUntil - now;
    const remainingSec = Math.ceil(remainingMs / 1000);
    return {
      success: false,
      message: `Usuario bloqueado temporalmente. Reintenta en ${remainingSec} segundos.`,
      remainingAttempts: 0,
      isLocked: true,
      lockedRemainingSeconds: remainingSec,
      updatedUser,
    };
  }

  // 2. Si el periodo de bloqueo ya transcurrió, se limpia lockedUntil
  if (updatedUser.lockedUntil && now >= updatedUser.lockedUntil) {
    updatedUser.lockedUntil = null;
    updatedUser.failedAttempts = 0;
  }

  // 3. Comprobar hash del PIN
  const hash = await computePinHash(pin, updatedUser.salt, updatedUser.iterations);
  if (hash === updatedUser.pinHash) {
    // Éxito: limpiar contadores de error
    updatedUser.failedAttempts = 0;
    updatedUser.lockedUntil = null;
    return {
      success: true,
      message: 'Autenticación exitosa.',
      user: updatedUser,
      remainingAttempts: DEFAULT_MAX_ATTEMPTS,
      isLocked: false,
      lockedRemainingSeconds: 0,
      updatedUser,
    };
  }

  // 4. Fallo: incrementar intentos fallidos
  const currentFails = (updatedUser.failedAttempts || 0) + 1;
  updatedUser.failedAttempts = currentFails;

  if (currentFails >= DEFAULT_MAX_ATTEMPTS) {
    const newLockoutCount = (updatedUser.lockoutCount || 0) + 1;
    const duration = newLockoutCount === 1 ? FIRST_LOCKOUT_MS : SUBSEQUENT_LOCKOUT_MS;
    updatedUser.lockoutCount = newLockoutCount;
    updatedUser.lockedUntil = now + duration;
    updatedUser.failedAttempts = 0;
    const lockedSec = Math.ceil(duration / 1000);

    return {
      success: false,
      message: `Demasiados intentos fallidos. Usuario bloqueado por ${lockedSec} segundos.`,
      remainingAttempts: 0,
      isLocked: true,
      lockedRemainingSeconds: lockedSec,
      updatedUser,
    };
  }

  const remaining = DEFAULT_MAX_ATTEMPTS - currentFails;
  return {
    success: false,
    message: `PIN incorrecto. Intentos restantes: ${remaining}.`,
    remainingAttempts: remaining,
    isLocked: false,
    lockedRemainingSeconds: 0,
    updatedUser,
  };
}

/**
 * Cambia el PIN de un usuario validando primero su PIN actual y las reglas de seguridad.
 */
export async function updateUserPin(
  user: AppUser,
  currentPin: string,
  newPin: string
): Promise<{ success: boolean; message: string; updatedUser?: AppUser }> {
  // 1. Validar PIN actual
  const check = await verifyUserPinAttempt(user, currentPin);
  if (!check.success) {
    return { success: false, message: `PIN actual incorrecto: ${check.message}` };
  }

  // 2. Validar nuevo PIN
  const policy = validatePinPolicy(newPin);
  if (!policy.valid) {
    return { success: false, message: policy.error || 'El nuevo PIN no cumple con las políticas.' };
  }

  // 3. Generar nueva sal y hash
  const newSalt = generateSalt(16);
  const iterations = user.iterations || DEFAULT_PIN_ITERATIONS;
  const newHash = await computePinHash(newPin, newSalt, iterations);

  const updated: AppUser = {
    ...user,
    salt: newSalt,
    pinHash: newHash,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, message: 'PIN actualizado correctamente.', updatedUser: updated };
}

/**
 * Protección contra suicidio administrativo:
 * Impide desactivar (baja lógica), eliminar o degradar el rol (ADMINISTRADOR -> ENCARGADO / CAJERO)
 * si el usuario objetivo es el único ADMINISTRADOR activo en el sistema.
 */
export function validateAdminSuicideProtection(
  users: readonly AppUser[],
  targetUserId: string,
  action: 'DEACTIVATE' | 'DELETE' | 'CHANGE_ROLE',
  newRole?: UserRole
): { allowed: boolean; error?: string } {
  const targetUser = users.find((u) => u.id === targetUserId);
  if (!targetUser) {
    return { allowed: false, error: 'Usuario no encontrado.' };
  }

  // Si el usuario objetivo no es un Administrador activo, la operación no compromete el quórum de administradores
  if (targetUser.role !== 'ADMINISTRADOR' || !targetUser.isActive) {
    return { allowed: true };
  }

  const activeAdmins = users.filter((u) => u.role === 'ADMINISTRADOR' && u.isActive);

  if (action === 'DEACTIVATE') {
    if (activeAdmins.length <= 1) {
      return {
        allowed: false,
        error: 'No es posible desactivar al único Administrador activo del sistema. Debe existir al menos un Administrador activo.',
      };
    }
  } else if (action === 'DELETE') {
    if (activeAdmins.length <= 1) {
      return {
        allowed: false,
        error: 'No es posible eliminar al único Administrador activo del sistema. Debe existir al menos un Administrador activo.',
      };
    }
  } else if (action === 'CHANGE_ROLE') {
    if (newRole && newRole !== 'ADMINISTRADOR' && activeAdmins.length <= 1) {
      return {
        allowed: false,
        error: 'No es posible degradar el rol del único Administrador activo del sistema. Debe existir al menos un Administrador activo.',
      };
    }
  }

  return { allowed: true };
}

export interface SupervisorPinVerifyResult {
  success: boolean;
  message: string;
  supervisor?: AppUser;
  updatedUsers?: AppUser[];
}

/**
 * Valida un PIN de elevación de privilegios / override contra los supervisores activos
 * (ENCARGADO o ADMINISTRADOR). No cierra ni altera la sesión activa del cajero operador.
 */
export async function verifySupervisorPinAttempt(
  users: readonly AppUser[],
  pin: string,
  allowedRoles: readonly UserRole[] = ['ENCARGADO', 'ADMINISTRADOR'],
  now: number = Date.now()
): Promise<SupervisorPinVerifyResult> {
  const cleanPin = (pin || '').trim();
  if (!cleanPin) {
    return { success: false, message: 'Ingresa el PIN de autorización del supervisor.' };
  }

  const eligibleSupervisors = users.filter((u) => u.isActive && allowedRoles.includes(u.role));
  if (eligibleSupervisors.length === 0) {
    return {
      success: false,
      message: 'No hay supervisores activos (Encargado o Administrador) configurados.',
    };
  }

  for (const supervisor of eligibleSupervisors) {
    const attempt = await verifyUserPinAttempt(supervisor, cleanPin, now);
    if (attempt.success) {
      const updatedUsers = users.map((u) => (u.id === supervisor.id ? (attempt.updatedUser || u) : u));
      return {
        success: true,
        message: `Operación autorizada por ${supervisor.name} (${supervisor.role}).`,
        supervisor: attempt.updatedUser || supervisor,
        updatedUsers,
      };
    }
  }

  return {
    success: false,
    message: 'PIN de supervisor incorrecto o no autorizado.',
  };
}

/**
 * Genera el listado inicial de usuarios demostrativos con credenciales PBKDF2 precalculadas.
 */
export function buildDefaultDemoUsers(): AppUser[] {
  return [
    {
      id: 'USR-ADMIN',
      name: 'Administrador',
      role: 'ADMINISTRADOR',
      salt: 'bc818b371e58ad34c5f2527938452548',
      pinHash: 'ac7f3d51c091ee3c3905982363322765e3f322e800c9769208f4bcb1bd028ec0', // PIN: 984312
      iterations: DEFAULT_PIN_ITERATIONS,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-10-20T08:00:00.000Z',
    },
    {
      id: 'USR-LUPE',
      name: 'Don Lupe (Encargado)',
      role: 'ENCARGADO',
      salt: '5e2cdc2e754f41563633968024c9a151',
      pinHash: '74cda2bd9fd7ff352344389e563be18b4be5d72c7e1a4c1aea1cefccf8d4cf43', // PIN: 839201
      iterations: DEFAULT_PIN_ITERATIONS,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-10-20T08:00:00.000Z',
    },
    {
      id: 'USR-MARIA',
      name: 'María (Cajera Mañana)',
      role: 'CAJERO',
      salt: '34cea95978a3b37736cb1e70c2e0dfb3',
      pinHash: 'defd37da44aa87d158ec3c9ca136e1e2490e85f547cdcee8dddda0f6244aafdb', // PIN: 719283
      iterations: DEFAULT_PIN_ITERATIONS,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-10-20T08:00:00.000Z',
    },
    {
      id: 'USR-PEDRO',
      name: 'Pedro (Cajero Tarde)',
      role: 'CAJERO',
      salt: '8fe73e117b1a3892a11e0354751995d0',
      pinHash: '05d2f218988a26c4184b16b4d962206412522c58bbadc4cb458681e090ab92b2', // PIN: 628491
      iterations: DEFAULT_PIN_ITERATIONS,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-10-20T08:00:00.000Z',
    },
  ];
}
