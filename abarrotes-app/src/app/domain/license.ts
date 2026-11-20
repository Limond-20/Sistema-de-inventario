/**
 * Lógica pura de dominio para Licenciamiento Offline Semestral/Anual (Bloque J).
 *
 * =====================================================================================
 * DOCUMENTACIÓN HONESTA DE SEGURIDAD (LICENCIA EN EL CLIENTE SIN INTERNET):
 * Esta validación de licencia se ejecuta 100% en el cliente (sin servidor en la nube)
 * utilizando firmas asimétricas ECDSA P-256 (Web Crypto API) y detección de retroceso
 * de reloj apoyada en el Kardex encadenado SHA-256.
 *
 * - Qué SÍ logra (Disuasión y Control Operativo):
 *   1. Impide que una tienda genere sus propios códigos de activación o reutilice el
 *      código de otra sucursal (la clave privada ECDSA P-256 jamás sale del emisor y
 *      cada licencia está ligada al `idInstalación` único de la terminal).
 *   2. Impide evadir el vencimiento atrasando el reloj de Windows (compara la hora actual
 *      contra la fecha máxima observada en el estado y en la cadena del Kardex; un atraso
 *      mayor a 5 minutos activa el modo solo lectura).
 *   3. Protege al tendero: aun cuando expira el periodo de gracia de 7 días y el sistema
 *      entra en modo solo lectura (bloqueando ventas), SIEMPRE permite exportar reportes
 *      en CSV y crear respaldos cifrados `.bak`.
 *
 * - Qué NO puede impedir (No es infalible):
 *   Una verificación ejecutada localmente en el cliente disuade, pero NO es infalible.
 *   Un usuario con acceso físico y privilegios de administrador en la PC y conocimientos
 *   de programación podría modificar los archivos JavaScript locales, alterar el navegador
 *   con herramientas de depuración o sustituir la clave pública incrustada en su propia
 *   máquina. Sin embargo, al no poseer la clave privada, no puede emitir licencias válidas
 *   para terminales no modificadas.
 * =====================================================================================
 */

export const LICENSE_TOKEN_PREFIX = 'BT1';
export const LICENSE_WARNING_DAYS_BEFORE_EXPIRY = 15;
export const LICENSE_GRACE_PERIOD_DAYS = 7;
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutos (300,000 ms)

export const DEFAULT_INSTALLATION_ID = 'BT-DEMO-TIENDA-0001';

/**
 * Clave pública ECDSA P-256 (secp256r1) incrustada para verificar códigos de licencia.
 * La clave privada correspondiente NO se versiona en el repositorio (vive fuera de Git
 * en local-server/tools/license-issuer/private-key.jwk.json).
 */
export const DEFAULT_EMBEDDED_PUBLIC_KEY_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'jLm3mVfrHbp2RSaAqfre8IF4hwJvd5G2lTej73ke6rs',
  y: 'qp3-QNSh7L7zASh6vqzjbwM6n8Je6rpfda_tOF6c-D8',
};

/**
 * Licencia de demostración pre-firmada con la clave privada correspondiente a
 * DEFAULT_EMBEDDED_PUBLIC_KEY_JWK para DEFAULT_INSTALLATION_ID ('BT-DEMO-TIENDA-0001').
 * Payload: {"idInstalación":"BT-DEMO-TIENDA-0001","plan":"ANUAL","emitida":"2026-01-01","vence":"2028-12-31"}
 */
export const DEFAULT_DEMO_LICENSE_CODE =
  'BT1.eyJpZEluc3RhbGFjacOzbiI6IkJULURFTU8tVElFTkRBLTAwMDEiLCJwbGFuIjoiQU5VQUwiLCJlbWl0aWRhIjoiMjAyNi0wMS0wMSIsInZlbmNlIjoiMjAyOC0xMi0zMSJ9.XmgLXLmmMn67V_h_6CXWyhvfNmSYjQ85O4M7DrmG1y83QwAC_xW0an4ZDmsdrBDMA8ktN_Zp7DPbyO0m9jZGPw';

export const CLIENT_LICENSE_HONEST_DISCLOSURE = {
  title: 'Nota de transparencia técnica: la licencia en el cliente disuade, no es infalible',
  summary:
    'Una licencia verificada en el cliente disuade, no es infalible: la firma criptográfica ECDSA P-256 y el control de reloj evitan copias casuales, reutilización de códigos entre tiendas y atrasos del reloj de Windows, pero ninguna protección 100% offline en el cliente es infalible frente a quien modifique el código local de su propia PC.',
  details: [
    'La clave privada de emisión nunca se incluye en la aplicación ni en el repositorio; la terminal solo contiene la clave pública ECDSA P-256 para verificar códigos recibidos por WhatsApp.',
    'Cada código firma {idInstalación, plan, emitida, vence}, por lo que un código emitido para una tienda no funciona en otra instalación distinta.',
    'El sistema registra la fecha/hora máxima observada (incluyendo el Kardex encadenado SHA-256) y activa el modo solo lectura si el reloj se atrasa más de 5 minutos.',
    'Limitación inherente: al ejecutarse sin internet en la propia PC de la tienda, un técnico con acceso de administrador local podría alterar el código JavaScript de esa máquina. El objetivo del mecanismo es disuadir el uso sin licencia casual y organizar la renovación de soporte sin jamás secuestrar los datos del negocio (siempre puedes exportar CSV y respaldar en .bak).',
  ],
} as const;

export type LicensePlan = 'SEMESTRAL' | 'ANUAL';

export interface LicensePayload {
  idInstalación: string;
  /** Alias sin tilde para acceso consistente desde cualquier módulo */
  idInstalacion: string;
  plan: LicensePlan;
  emitida: string; // YYYY-MM-DD
  vence: string;   // YYYY-MM-DD
}

export type LicenseStatusKind =
  | 'ACTIVA'
  | 'POR_VENCER'
  | 'PERIODO_GRACIA'
  | 'VENCIDA'
  | 'RELOJ_RETROCEDIDO'
  | 'SIN_LICENCIA'
  | 'INVALIDA';

export interface LicenseStateRecord {
  installationId: string;
  licenseCode: string | null;
  maxObservedTimestampIso: string;
  activatedAtIso?: string | null;
}

export interface LicenseEvaluationResult {
  status: LicenseStatusKind;
  validSignature: boolean;
  installationMatched: boolean;
  clockRollbackDetected: boolean;
  clockRollbackDeltaMs: number;
  clockRollbackMinutes: number;
  isReadOnly: boolean;
  canSell: boolean;
  canExportAndBackup: boolean;
  daysRemaining: number | null;
  graceDaysRemaining: number | null;
  overdueDaysAfterGrace: number | null;
  warningBanner: string | null;
  readOnlyReason: string | null;
  statusLabel: string;
  payload: LicensePayload | null;
  installationId: string;
  maxObservedTimestampIso: string;
  evaluatedAtIso: string;
}

export interface LicenseActivationResult {
  ok: boolean;
  message: string;
  evaluation: LicenseEvaluationResult;
  updatedRecord?: LicenseStateRecord;
}

const INSTALLATION_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Genera un identificador aleatorio de instalación legible para compartir por WhatsApp:
 * formato BT-XXXX-XXXX-XXXX (ej. BT-7K9M-4P2Q-8R5T).
 */
export function generateInstallationId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const chars: string[] = [];
  for (let i = 0; i < 12; i++) {
    chars.push(INSTALLATION_ID_ALPHABET[bytes[i] % INSTALLATION_ID_ALPHABET.length]);
  }
  return `BT-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

export function normalizeInstallationId(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toUpperCase();
}

export function isValidYyyyMmDd(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function formatLocalYyyyMmDd(dateInput: Date | number | string = new Date()): string {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseYyyyMmDdToLocalMidnightMs(yyyyMmDd: string): number {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/**
 * Calcula los días calendario restantes entre la fecha local actual y la fecha `vence` (YYYY-MM-DD).
 * - > 0: faltan N días para vencer
 * - 0: vence hoy
 * - < 0: venció hace |N| días (ej. -1 = 1er día de gracia; -7 = 7mo y último día de gracia; -8 = gracia agotada)
 */
export function computeDaysUntilExpiry(
  venceYyyyMmDd: string,
  nowInput: Date | number | string = new Date()
): number {
  const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const todayYyyyMmDd =
    typeof nowInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(nowInput.trim())
      ? nowInput.trim()
      : formatLocalYyyyMmDd(nowDate);

  const [ty, tm, td] = todayYyyyMmDd.split('-').map(Number);
  const [vy, vm, vd] = venceYyyyMmDd.split('-').map(Number);
  const todayUtcMs = Date.UTC(ty, tm - 1, td);
  const venceUtcMs = Date.UTC(vy, vm - 1, vd);
  return Math.round((venceUtcMs - todayUtcMs) / 86_400_000);
}

// ---------- Codificación Base64URL compatible con navegador y Node ----------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = globalThis.btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const clean = b64url.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (clean.length % 4)) % 4;
  const padded = clean + '='.repeat(padLen);
  const binary = globalThis.atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------- Generación y Firma ECDSA P-256 (para pruebas y emisión) ----------

export async function generateLicenseKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}> {
  const { subtle } = globalThis.crypto;
  const kp = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const priv = await subtle.exportKey('jwk', kp.privateKey);
  const pub = await subtle.exportKey('jwk', kp.publicKey);
  return {
    publicKeyJwk: {
      kty: pub.kty,
      crv: pub.crv,
      x: pub.x,
      y: pub.y,
    },
    privateKeyJwk: {
      kty: priv.kty,
      crv: priv.crv,
      x: priv.x,
      y: priv.y,
      d: priv.d,
    },
  };
}

export function canonicalizeLicensePayload(input: {
  idInstalación?: string;
  idInstalacion?: string;
  plan: LicensePlan;
  emitida: string;
  vence: string;
}): { canonicalJson: string; payload: LicensePayload } {
  const idInstalación = normalizeInstallationId(input.idInstalación ?? input.idInstalacion);
  if (!idInstalación || idInstalación.length < 4) {
    throw new Error('El idInstalación es obligatorio y debe tener al menos 4 caracteres.');
  }
  const plan = String(input.plan ?? '').trim().toUpperCase() as LicensePlan;
  if (plan !== 'SEMESTRAL' && plan !== 'ANUAL') {
    throw new Error(`Plan de licencia inválido: "${input.plan}". Debe ser SEMESTRAL o ANUAL.`);
  }
  const emitida = String(input.emitida ?? '').trim();
  if (!isValidYyyyMmDd(emitida)) {
    throw new Error(`Fecha emitida inválida: "${emitida}". Formato requerido: YYYY-MM-DD.`);
  }
  const vence = String(input.vence ?? '').trim();
  if (!isValidYyyyMmDd(vence)) {
    throw new Error(`Fecha vence inválida: "${vence}". Formato requerido: YYYY-MM-DD.`);
  }
  if (vence < emitida) {
    throw new Error(`La fecha de vencimiento (${vence}) no puede ser menor a la de emisión (${emitida}).`);
  }

  const canonicalObj = {
    idInstalación,
    plan,
    emitida,
    vence,
  };

  return {
    canonicalJson: JSON.stringify(canonicalObj),
    payload: {
      ...canonicalObj,
      idInstalacion: idInstalación,
    },
  };
}

export async function signLicensePayload(
  input: {
    idInstalación?: string;
    idInstalacion?: string;
    plan: LicensePlan;
    emitida: string;
    vence: string;
  },
  privateKeyJwk: JsonWebKey
): Promise<string> {
  const { canonicalJson } = canonicalizeLicensePayload(input);
  const payloadBytes = new TextEncoder().encode(canonicalJson);
  const { subtle } = globalThis.crypto;
  const privateKey = await subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sigBuffer = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    payloadBytes
  );
  const sigBytes = new Uint8Array(sigBuffer);
  return `${LICENSE_TOKEN_PREFIX}.${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(sigBytes)}`;
}

// ---------- Extracción, Parseo y Verificación con Clave Pública ----------

export interface ParsedLicenseToken {
  ok: boolean;
  error?: string;
  rawToken?: string;
  payloadBytes?: Uint8Array;
  signatureBytes?: Uint8Array;
  payload?: LicensePayload;
}

/**
 * Extrae y decodifica un código corto de licencia `BT1.<payload>.<firma>`, tolerando
 * texto envolvente o saltos de línea al copiar desde un mensaje de WhatsApp.
 */
export function parseLicenseCode(rawInput: string | null | undefined): ParsedLicenseToken {
  const text = String(rawInput ?? '').trim();
  if (!text) {
    return { ok: false, error: 'El código de licencia está vacío.' };
  }

  // Permitir pegar el mensaje completo de WhatsApp o un código con saltos de línea
  const match = text.match(/BT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const candidate = match ? match[0] : text.replace(/\s+/g, '');

  const parts = candidate.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_TOKEN_PREFIX) {
    return {
      ok: false,
      error: 'Formato de código inválido. Se esperaba un código corto con prefijo BT1.',
    };
  }

  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = base64UrlToBytes(parts[1]);
    signatureBytes = base64UrlToBytes(parts[2]);
  } catch {
    return { ok: false, error: 'Codificación Base64URL dañada en el código de licencia.' };
  }

  if (signatureBytes.length !== 64) {
    return {
      ok: false,
      error: 'Longitud de firma ECDSA P-256 inválida.',
    };
  }

  let decodedObj: any;
  try {
    const jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    decodedObj = JSON.parse(jsonStr);
  } catch {
    return { ok: false, error: 'El contenido del código de licencia no es un JSON válido.' };
  }

  try {
    const { payload } = canonicalizeLicensePayload({
      idInstalación: decodedObj?.idInstalación ?? decodedObj?.idInstalacion,
      plan: decodedObj?.plan,
      emitida: decodedObj?.emitida,
      vence: decodedObj?.vence,
    });
    return {
      ok: true,
      rawToken: candidate,
      payloadBytes,
      signatureBytes,
      payload,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'Los campos del payload de licencia son inválidos.',
    };
  }
}

export async function verifyLicenseSignature(
  rawCode: string | null | undefined,
  publicKeyJwk: JsonWebKey = DEFAULT_EMBEDDED_PUBLIC_KEY_JWK
): Promise<{ valid: boolean; error?: string; payload?: LicensePayload }> {
  const parsed = parseLicenseCode(rawCode);
  if (!parsed.ok || !parsed.payloadBytes || !parsed.signatureBytes || !parsed.payload) {
    return { valid: false, error: parsed.error || 'Código de licencia inválido.' };
  }

  try {
    const { subtle } = globalThis.crypto;
    const pubKey = await subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const verified = await subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      pubKey,
      parsed.signatureBytes as BufferSource,
      parsed.payloadBytes as BufferSource
    );
    if (!verified) {
      return {
        valid: false,
        error: 'Firma criptográfica ECDSA P-256 inválida o código alterado.',
      };
    }
    return { valid: true, payload: parsed.payload };
  } catch {
    return {
      valid: false,
      error: 'No se pudo verificar la firma criptográfica con la clave pública incrustada.',
    };
  }
}

// ---------- Detección de Retroceso del Reloj (Kardex + Marca Máxima Vista) ----------

function parseValidTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Ignorar cadenas puramente descriptivas que no sean fechas ISO/parseables
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/**
 * Calcula la fecha/hora máxima vista por la aplicación combinando:
 * 1. El registro previo `previousMaxIso` guardado en el estado/almacenamiento.
 * 2. Todas las entradas de la cadena criptográfica del Kardex (`kardexEntries`).
 * 3. Marcas de tiempo adicionales opcionales (ventas, cortes, bitácora de auditoría).
 */
export function computeMaxObservedTimestamp(params: {
  previousMaxIso?: string | null;
  kardexEntries?: ReadonlyArray<{ timestamp?: unknown }> | null;
  additionalTimestamps?: ReadonlyArray<unknown> | null;
  fallbackIso?: string;
}): string {
  let maxMs = 0;

  const prevMs = parseValidTimestampMs(params.previousMaxIso);
  if (prevMs !== null && prevMs > maxMs) {
    maxMs = prevMs;
  }

  if (Array.isArray(params.kardexEntries)) {
    for (const entry of params.kardexEntries) {
      const ms = parseValidTimestampMs(entry?.timestamp);
      if (ms !== null && ms > maxMs) {
        maxMs = ms;
      }
    }
  }

  if (Array.isArray(params.additionalTimestamps)) {
    for (const ts of params.additionalTimestamps) {
      const ms = parseValidTimestampMs(ts);
      if (ms !== null && ms > maxMs) {
        maxMs = ms;
      }
    }
  }

  if (maxMs <= 0) {
    const fbMs = parseValidTimestampMs(params.fallbackIso) ?? Date.now();
    return new Date(fbMs).toISOString();
  }

  return new Date(maxMs).toISOString();
}

/**
 * Detecta si la hora actual del sistema es menor a la fecha máxima vista por más de 5 minutos.
 */
export function detectClockRollback(
  nowInput: Date | number | string,
  maxObservedIso: string | null | undefined,
  toleranceMs = CLOCK_ROLLBACK_TOLERANCE_MS
): {
  rolledBack: boolean;
  deltaMs: number;
  rollbackMinutes: number;
  updatedMaxObservedIso: string;
} {
  const nowMs = parseValidTimestampMs(nowInput) ?? Date.now();
  const maxMs = parseValidTimestampMs(maxObservedIso) ?? nowMs;
  const deltaMs = maxMs - nowMs;

  if (deltaMs > toleranceMs) {
    return {
      rolledBack: true,
      deltaMs,
      rollbackMinutes: Math.ceil(deltaMs / 60_000),
      updatedMaxObservedIso: new Date(maxMs).toISOString(),
    };
  }

  const nextMaxMs = Math.max(maxMs, nowMs);
  return {
    rolledBack: false,
    deltaMs: Math.max(0, deltaMs),
    rollbackMinutes: 0,
    updatedMaxObservedIso: new Date(nextMaxMs).toISOString(),
  };
}

// ---------- Evaluación Integral de Licencia y Modo Solo Lectura ----------

export async function evaluateLicenseStatus(params: {
  licenseCode: string | null | undefined;
  installationId: string;
  now?: Date | number | string;
  maxObservedTimestampIso?: string | null;
  kardexEntries?: ReadonlyArray<{ timestamp?: unknown }> | null;
  additionalTimestamps?: ReadonlyArray<unknown> | null;
  publicKeyJwk?: JsonWebKey;
}): Promise<LicenseEvaluationResult> {
  const nowDate =
    params.now instanceof Date
      ? params.now
      : params.now !== undefined
      ? new Date(params.now)
      : new Date();
  const evaluatedAtIso = nowDate.toISOString();
  const installationId = normalizeInstallationId(params.installationId) || DEFAULT_INSTALLATION_ID;

  // 1. Consolidar la fecha máxima observada (incluyendo el Kardex encadenado)
  const consolidatedMaxIso = computeMaxObservedTimestamp({
    previousMaxIso: params.maxObservedTimestampIso,
    kardexEntries: params.kardexEntries,
    additionalTimestamps: params.additionalTimestamps,
    fallbackIso: evaluatedAtIso,
  });

  // 2. Verificar si el reloj retrocedió más de 5 minutos
  const clockCheck = detectClockRollback(nowDate, consolidatedMaxIso, CLOCK_ROLLBACK_TOLERANCE_MS);

  // 3. Si no hay código de licencia registrado
  if (!params.licenseCode || !String(params.licenseCode).trim()) {
    const readOnlyReason = clockCheck.rolledBack
      ? `Reloj del sistema atrasado (${clockCheck.rollbackMinutes} min respecto al último registro ${clockCheck.updatedMaxObservedIso}). Corrige la fecha y hora de la PC.`
      : 'Sin licencia activa registrada. Ingresa un código de licencia válido.';
    return {
      status: clockCheck.rolledBack ? 'RELOJ_RETROCEDIDO' : 'SIN_LICENCIA',
      validSignature: false,
      installationMatched: false,
      clockRollbackDetected: clockCheck.rolledBack,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: clockCheck.rollbackMinutes,
      isReadOnly: true,
      canSell: false,
      canExportAndBackup: true,
      daysRemaining: null,
      graceDaysRemaining: null,
      overdueDaysAfterGrace: null,
      warningBanner: readOnlyReason,
      readOnlyReason,
      statusLabel: clockCheck.rolledBack ? 'Reloj atrasado (Solo lectura)' : 'Sin licencia (Solo lectura)',
      payload: null,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  // 4. Verificar firma ECDSA P-256 con la clave pública incrustada
  const verification = await verifyLicenseSignature(
    params.licenseCode,
    params.publicKeyJwk ?? DEFAULT_EMBEDDED_PUBLIC_KEY_JWK
  );

  if (!verification.valid || !verification.payload) {
    const reason = verification.error || 'El código de licencia tiene una firma inválida o fue alterado.';
    return {
      status: 'INVALIDA',
      validSignature: false,
      installationMatched: false,
      clockRollbackDetected: clockCheck.rolledBack,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: clockCheck.rollbackMinutes,
      isReadOnly: true,
      canSell: false,
      canExportAndBackup: true,
      daysRemaining: null,
      graceDaysRemaining: null,
      overdueDaysAfterGrace: null,
      warningBanner: reason,
      readOnlyReason: reason,
      statusLabel: 'Licencia inválida (Solo lectura)',
      payload: null,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  const payload = verification.payload;
  const installationMatched = normalizeInstallationId(payload.idInstalación) === installationId;

  if (!installationMatched) {
    const reason = `El código de licencia pertenece a otra instalación (${payload.idInstalación}) y no coincide con esta terminal (${installationId}).`;
    return {
      status: 'INVALIDA',
      validSignature: true,
      installationMatched: false,
      clockRollbackDetected: clockCheck.rolledBack,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: clockCheck.rollbackMinutes,
      isReadOnly: true,
      canSell: false,
      canExportAndBackup: true,
      daysRemaining: null,
      graceDaysRemaining: null,
      overdueDaysAfterGrace: null,
      warningBanner: reason,
      readOnlyReason: reason,
      statusLabel: 'ID de otra instalación (Solo lectura)',
      payload,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  const daysRemaining = computeDaysUntilExpiry(payload.vence, nowDate);

  // 5. Si se detectó retroceso de reloj (> 5 minutos), forzar modo solo lectura con aviso
  if (clockCheck.rolledBack) {
    const reason = `Se detectó un retroceso en el reloj del sistema de ${clockCheck.rollbackMinutes} minutos (hora actual anterior al último movimiento registrado en Kardex/sistema). Modo solo lectura activo: ajusta la fecha y hora de la PC para volver a vender.`;
    return {
      status: 'RELOJ_RETROCEDIDO',
      validSignature: true,
      installationMatched: true,
      clockRollbackDetected: true,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: clockCheck.rollbackMinutes,
      isReadOnly: true,
      canSell: false,
      canExportAndBackup: true,
      daysRemaining,
      graceDaysRemaining:
        daysRemaining < 0 && daysRemaining >= -LICENSE_GRACE_PERIOD_DAYS
          ? LICENSE_GRACE_PERIOD_DAYS + daysRemaining + 1
          : null,
      overdueDaysAfterGrace:
        daysRemaining < -LICENSE_GRACE_PERIOD_DAYS
          ? Math.abs(daysRemaining) - LICENSE_GRACE_PERIOD_DAYS
          : null,
      warningBanner: reason,
      readOnlyReason: reason,
      statusLabel: 'Reloj atrasado (Solo lectura)',
      payload,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  // 6. Evaluar vigencia:
  // Caso A: Faltan más de 15 días (ACTIVA sin aviso)
  if (daysRemaining > LICENSE_WARNING_DAYS_BEFORE_EXPIRY) {
    return {
      status: 'ACTIVA',
      validSignature: true,
      installationMatched: true,
      clockRollbackDetected: false,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: 0,
      isReadOnly: false,
      canSell: true,
      canExportAndBackup: true,
      daysRemaining,
      graceDaysRemaining: null,
      overdueDaysAfterGrace: null,
      warningBanner: null,
      readOnlyReason: null,
      statusLabel: 'Licencia activa',
      payload,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  // Caso B: Aviso 15 días antes de vencer (0 <= daysRemaining <= 15)
  if (daysRemaining >= 0) {
    const dayText =
      daysRemaining === 0
        ? 'vence HOY'
        : daysRemaining === 1
        ? 'vence mañana (falta 1 día)'
        : `vence en ${daysRemaining} días`;
    const banner = `Aviso de licencia: tu plan ${payload.plan} ${dayText} (${payload.vence}). Solicita tu código de renovación por WhatsApp.`;
    return {
      status: 'POR_VENCER',
      validSignature: true,
      installationMatched: true,
      clockRollbackDetected: false,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: 0,
      isReadOnly: false,
      canSell: true,
      canExportAndBackup: true,
      daysRemaining,
      graceDaysRemaining: null,
      overdueDaysAfterGrace: null,
      warningBanner: banner,
      readOnlyReason: null,
      statusLabel: `Por vencer (${daysRemaining} d)`,
      payload,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  // Caso C: Tras vencer, 7 días de gracia (-7 <= daysRemaining < 0)
  if (daysRemaining >= -LICENSE_GRACE_PERIOD_DAYS) {
    // Si venció ayer (daysRemaining = -1), está en el día 1 de 7 de gracia (quedan 7 días incluyendo hoy).
    // Si venció hace 7 días (daysRemaining = -7), es el último día de gracia (queda 1 día).
    const graceDaysRemaining = LICENSE_GRACE_PERIOD_DAYS + daysRemaining + 1;
    const expiredDaysAgo = Math.abs(daysRemaining);
    const banner = `Licencia vencida el ${payload.vence} (hace ${expiredDaysAgo} día${expiredDaysAgo === 1 ? '' : 's'}). Periodo de gracia activo: quedan ${graceDaysRemaining} día${graceDaysRemaining === 1 ? '' : 's'} antes de pasar a modo solo lectura.`;
    return {
      status: 'PERIODO_GRACIA',
      validSignature: true,
      installationMatched: true,
      clockRollbackDetected: false,
      clockRollbackDeltaMs: clockCheck.deltaMs,
      clockRollbackMinutes: 0,
      isReadOnly: false,
      canSell: true,
      canExportAndBackup: true,
      daysRemaining,
      graceDaysRemaining,
      overdueDaysAfterGrace: 0,
      warningBanner: banner,
      readOnlyReason: null,
      statusLabel: `Periodo de gracia (${graceDaysRemaining} d restantes)`,
      payload,
      installationId,
      maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
      evaluatedAtIso,
    };
  }

  // Caso D: Gracia agotada (daysRemaining < -7) -> Modo solo lectura (permite exportar y respaldar, no vender)
  const overdueDaysAfterGrace = Math.abs(daysRemaining) - LICENSE_GRACE_PERIOD_DAYS;
  const reason = `Licencia vencida el ${payload.vence} y periodo de gracia de ${LICENSE_GRACE_PERIOD_DAYS} días agotado. Modo solo lectura activo: puedes exportar reportes CSV y respaldar (.bak), pero no registrar ventas hasta ingresar un código de renovación.`;
  return {
    status: 'VENCIDA',
    validSignature: true,
    installationMatched: true,
    clockRollbackDetected: false,
    clockRollbackDeltaMs: clockCheck.deltaMs,
    clockRollbackMinutes: 0,
    isReadOnly: true,
    canSell: false,
    canExportAndBackup: true,
    daysRemaining,
    graceDaysRemaining: 0,
    overdueDaysAfterGrace,
    warningBanner: reason,
    readOnlyReason: reason,
    statusLabel: 'Vencida · Modo solo lectura',
    payload,
    installationId,
    maxObservedTimestampIso: clockCheck.updatedMaxObservedIso,
    evaluatedAtIso,
  };
}

/**
 * Valida y aplica un nuevo código de licencia (activación inicial o renovación).
 */
export async function validateAndActivateLicense(params: {
  newLicenseCode: string;
  installationId: string;
  currentPayload?: LicensePayload | null;
  now?: Date | number | string;
  maxObservedTimestampIso?: string | null;
  kardexEntries?: ReadonlyArray<{ timestamp?: unknown }> | null;
  additionalTimestamps?: ReadonlyArray<unknown> | null;
  publicKeyJwk?: JsonWebKey;
}): Promise<LicenseActivationResult> {
  const cleanCode = String(params.newLicenseCode ?? '').trim();
  const evaluation = await evaluateLicenseStatus({
    licenseCode: cleanCode,
    installationId: params.installationId,
    now: params.now,
    maxObservedTimestampIso: params.maxObservedTimestampIso,
    kardexEntries: params.kardexEntries,
    additionalTimestamps: params.additionalTimestamps,
    publicKeyJwk: params.publicKeyJwk,
  });

  if (!evaluation.validSignature || !evaluation.payload) {
    return {
      ok: false,
      message: evaluation.readOnlyReason || 'Firma criptográfica inválida o código malformado.',
      evaluation,
    };
  }

  if (!evaluation.installationMatched) {
    return {
      ok: false,
      message:
        evaluation.readOnlyReason ||
        `El código pertenece a otra instalación (${evaluation.payload.idInstalación}).`,
      evaluation,
    };
  }

  if (evaluation.clockRollbackDetected) {
    return {
      ok: false,
      message:
        evaluation.readOnlyReason ||
        'No se puede activar la licencia mientras el reloj del sistema presente un atraso mayor a 5 minutos.',
      evaluation,
    };
  }

  if (evaluation.status === 'VENCIDA') {
    return {
      ok: false,
      message: `El código ingresado ya se encuentra vencido (${evaluation.payload.vence}) con periodo de gracia agotado.`,
      evaluation,
    };
  }

  if (params.currentPayload && evaluation.payload.vence < params.currentPayload.vence) {
    return {
      ok: false,
      message: `La nueva licencia vence el ${evaluation.payload.vence}, que es anterior al vencimiento actual (${params.currentPayload.vence}).`,
      evaluation,
    };
  }

  const parsed = parseLicenseCode(cleanCode);
  const normalizedToken = parsed.rawToken || cleanCode;

  return {
    ok: true,
    message: `Licencia ${evaluation.payload.plan} activada correctamente. Vigente hasta el ${evaluation.payload.vence}.`,
    evaluation,
    updatedRecord: {
      installationId: evaluation.installationId,
      licenseCode: normalizedToken,
      maxObservedTimestampIso: evaluation.maxObservedTimestampIso,
      activatedAtIso: evaluation.evaluatedAtIso,
    },
  };
}
