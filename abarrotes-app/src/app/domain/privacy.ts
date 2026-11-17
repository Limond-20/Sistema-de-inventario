/**
 * Datos personales de clientes del crédito / fiado (Bloque K).
 *
 * =====================================================================================
 * - Aviso de privacidad configurable y VERSIONADO: cada versión publicada guarda el texto final
 *   y su huella SHA-256, para poder demostrar qué texto exacto aceptó cada cliente.
 * - Registro de consentimiento por cliente: fecha, versión del aviso, huella del texto, quién lo
 *   recabó y cómo (verbal en mostrador, firma en papel, otro).
 * - Derechos ARCO:
 *     Acceso        -> buildCustomerDataExport (JSON con todo lo que la tienda tiene del cliente).
 *     Rectificación -> edición normal del cliente (se registra la solicitud).
 *     Cancelación   -> anonymizeCustomerData: borra nombre, alias, teléfono y notas, conserva
 *                      el ID, el saldo, las deudas y los abonos. El Kardex NO se toca.
 *     Oposición     -> registerOpposition: deja constancia y marca "no contactar".
 *
 * POR QUÉ EL KARDEX NO SE MODIFICA
 * El Kardex es append-only y encadenado con SHA-256 (Bloques C/D); además el servidor SQLite
 * (Bloque N) rechaza cualquier cambio a movimientos ya confirmados. Modificarlo rompería la
 * integridad contable. Desde el Bloque K los movimientos nuevos de crédito guardan solo el ID
 * del cliente; los movimientos históricos que mencionan el nombre se reportan en la exportación
 * y se ocultan en pantalla (retainedKardexEntryIds), pero siguen en el libro.
 * =====================================================================================
 */

export const PRIVACY_NOTICE_MIN_LENGTH = 200;
export const ANONYMIZED_NAME_PREFIX = 'Cliente anonimizado';
export const REDACTED_TEXT = '[dato eliminado]';
export const CUSTOMER_EXPORT_FORMAT = 'BTARCO-EXPORT';
export const CUSTOMER_EXPORT_VERSION = 1;

export type ConsentMethod = 'PRESENCIAL_VERBAL' | 'FIRMA_EN_PAPEL' | 'OTRO';
export type ArcoRight = 'ACCESO' | 'RECTIFICACION' | 'CANCELACION' | 'OPOSICION';
export type OppositionScope = 'CONTACTO' | 'RECORDATORIOS' | 'OTRO';
export type ConsentStatus = 'VIGENTE' | 'VERSION_ANTERIOR' | 'SIN_CONSENTIMIENTO' | 'ANONIMIZADO';

export interface PrivacyNoticeVersion {
  version: number;
  text: string;
  textHash: string;
  publishedAt: string;
  publishedBy: string;
}

export interface PrivacyNoticeConfig {
  responsibleName: string;
  contact: string;
  /** Plantilla editable; {{negocio}}, {{responsable}} y {{contacto}} se reemplazan al publicar. */
  template: string;
  currentVersion: number;
  versions: PrivacyNoticeVersion[];
}

export interface CustomerConsentRecord {
  id: string;
  noticeVersion: number;
  noticeTextHash: string;
  acceptedAt: string;
  acceptedLocalDate: string;
  collectedBy: string;
  collectedByUserId?: string;
  method: ConsentMethod;
  note?: string;
}

export interface ArcoRequestRecord {
  id: string;
  right: ArcoRight;
  registeredAt: string;
  attendedBy: string;
  detail: string;
}

export interface OppositionRecord {
  id: string;
  scope: OppositionScope;
  registeredAt: string;
  registeredBy: string;
  note?: string;
}

export interface CustomerPrivacyRecord {
  consents: CustomerConsentRecord[];
  arcoRequests: ArcoRequestRecord[];
  oppositions: OppositionRecord[];
  contactOptOut?: boolean;
  anonymizedAt?: string;
  anonymizedBy?: string;
  retainedKardexEntryIds?: string[];
}

/** Colecciones del estado que pueden contener datos personales de un cliente. */
export interface PrivacyDataScope {
  creditCustomers: any[];
  salesHistory?: any[];
  saleReturns?: any[];
  cashMovements?: any[];
  kardex?: any[];
  morningAlerts?: any[];
}

export const DEFAULT_PRIVACY_NOTICE_TEMPLATE = `AVISO DE PRIVACIDAD - {{negocio}}

{{responsable}}, responsable de "{{negocio}}", usa tus datos personales solo para llevar tu cuenta de crédito (fiado) en la tienda.

¿Qué datos usamos? Tu nombre, apodo o referencia, tu teléfono (si nos lo das) y una nota de domicilio o de pago (si nos la das). También guardamos lo que compras a crédito, tus abonos y tu saldo. No pedimos datos sensibles.

¿Para qué los usamos? 1) Anotar tus compras a crédito y tus abonos. 2) Saber cuánto debes y cuándo vence. 3) Avisarte de tu saldo, solo si nos diste tu teléfono. No vendemos ni compartimos tus datos, salvo que una autoridad competente lo pida conforme a la ley.

¿Cómo los cuidamos? Se guardan cifrados en la computadora de la tienda y solo el personal autorizado los consulta.

Tus derechos ARCO: puedes pedir el Acceso a tus datos, Rectificarlos si están mal, Cancelarlos y Oponerte a que los usemos para avisos. Pídelo en la tienda o en: {{contacto}}. Es gratuito. Si pides la cancelación borramos tu nombre, apodo, teléfono y notas; tu saldo pendiente y los movimientos contables ya registrados se conservan con un número de cliente porque son parte de la contabilidad de la tienda y no se pueden modificar.

Cambios a este aviso: te los mostraremos en la tienda y te pediremos de nuevo tu aceptación.

Fundamento: Ley Federal de Protección de Datos Personales en Posesión de los Particulares (DOF 20/03/2025).`;

// ---------------------------------------------------------------------------------------
// Utilidades autocontenidas
// ---------------------------------------------------------------------------------------

let privacySeq = 0;

function generateId(prefix: string): string {
  privacySeq = (privacySeq + 1) % 1_000_000;
  const rand =
    typeof globalThis.crypto?.getRandomValues === 'function'
      ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
      : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now()}-${privacySeq}-${rand}`;
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toCents(amount: unknown): number {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Huella SHA-256 (hex) del texto del aviso. */
export async function computeTextHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text) as unknown as BufferSource
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function renderPrivacyNotice(
  template: string,
  values: { storeName: string; responsibleName: string; contact: string }
): string {
  const responsable = values.responsibleName.trim() || 'El dueño o encargado';
  const contacto = values.contact.trim() || 'el mostrador de la tienda';
  return template
    .split('{{negocio}}').join(values.storeName.trim() || 'la tienda')
    .split('{{responsable}}').join(responsable)
    .split('{{contacto}}').join(contacto)
    .trim();
}

// ---------------------------------------------------------------------------------------
// Aviso de privacidad versionado
// ---------------------------------------------------------------------------------------

export function validatePrivacyNoticeInput(input: {
  template: string;
  responsibleName: string;
  contact: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (String(input.template || '').trim().length < PRIVACY_NOTICE_MIN_LENGTH) {
    errors.push(`El aviso de privacidad debe tener al menos ${PRIVACY_NOTICE_MIN_LENGTH} caracteres.`);
  }
  if (String(input.responsibleName || '').trim().length < 3) {
    errors.push('Indica el nombre de la persona responsable de los datos (dueño o encargado).');
  }
  if (String(input.contact || '').trim().length < 5) {
    errors.push('Indica un teléfono, correo o domicilio para recibir solicitudes ARCO.');
  }
  return { valid: errors.length === 0, errors };
}

export async function buildDefaultPrivacyNoticeConfig(
  storeName: string,
  now: Date = new Date()
): Promise<PrivacyNoticeConfig> {
  const text = renderPrivacyNotice(DEFAULT_PRIVACY_NOTICE_TEMPLATE, {
    storeName,
    responsibleName: '',
    contact: '',
  });
  return {
    responsibleName: '',
    contact: '',
    template: DEFAULT_PRIVACY_NOTICE_TEMPLATE,
    currentVersion: 1,
    versions: [
      {
        version: 1,
        text,
        textHash: await computeTextHash(text),
        publishedAt: now.toISOString(),
        publishedBy: 'Sistema (plantilla inicial)',
      },
    ],
  };
}

export function getCurrentNoticeVersion(config: PrivacyNoticeConfig | null | undefined): PrivacyNoticeVersion | null {
  if (!config || !Array.isArray(config.versions)) return null;
  return config.versions.find((v) => v.version === config.currentVersion) ?? null;
}

/**
 * Publica una nueva versión del aviso. Las versiones anteriores se conservan (los
 * consentimientos apuntan a ellas). Si el texto final no cambió, no crea versión.
 */
export async function publishPrivacyNoticeVersion(
  config: PrivacyNoticeConfig,
  input: { template: string; responsibleName: string; contact: string; storeName: string; publishedBy: string },
  now: Date = new Date()
): Promise<{ ok: boolean; config: PrivacyNoticeConfig; message: string; errors?: string[] }> {
  const validation = validatePrivacyNoticeInput(input);
  if (!validation.valid) {
    return { ok: false, config, message: validation.errors.join(' '), errors: validation.errors };
  }
  const text = renderPrivacyNotice(input.template, input);
  const textHash = await computeTextHash(text);
  const current = getCurrentNoticeVersion(config);
  const base: PrivacyNoticeConfig = {
    ...config,
    responsibleName: input.responsibleName.trim(),
    contact: input.contact.trim(),
    template: input.template,
  };
  if (current && current.textHash === textHash) {
    return { ok: true, config: base, message: `Sin cambios en el texto: sigue vigente la versión ${current.version}.` };
  }
  const nextVersion = Math.max(0, ...config.versions.map((v) => v.version)) + 1;
  return {
    ok: true,
    config: {
      ...base,
      currentVersion: nextVersion,
      versions: [
        ...config.versions,
        { version: nextVersion, text, textHash, publishedAt: now.toISOString(), publishedBy: input.publishedBy },
      ],
    },
    message: `Aviso de privacidad publicado (versión ${nextVersion}). Los clientes con una versión anterior deben aceptarlo de nuevo.`,
  };
}

// ---------------------------------------------------------------------------------------
// Consentimiento y solicitudes ARCO por cliente
// ---------------------------------------------------------------------------------------

export function getCustomerPrivacy(customer: any): CustomerPrivacyRecord {
  const p = customer?.privacy || {};
  return {
    ...p,
    consents: Array.isArray(p.consents) ? p.consents : [],
    arcoRequests: Array.isArray(p.arcoRequests) ? p.arcoRequests : [],
    oppositions: Array.isArray(p.oppositions) ? p.oppositions : [],
  };
}

export function isCustomerAnonymized(customer: any): boolean {
  return Boolean(customer?.privacy?.anonymizedAt);
}

export function getLatestConsent(customer: any): CustomerConsentRecord | null {
  const consents = getCustomerPrivacy(customer).consents;
  return consents.length > 0 ? consents[consents.length - 1] : null;
}

export function getConsentStatus(customer: any, config: PrivacyNoticeConfig | null | undefined): ConsentStatus {
  if (isCustomerAnonymized(customer)) return 'ANONIMIZADO';
  const latest = getLatestConsent(customer);
  if (!latest) return 'SIN_CONSENTIMIENTO';
  if (config && latest.noticeVersion !== config.currentVersion) return 'VERSION_ANTERIOR';
  return 'VIGENTE';
}

export function createConsentRecord(params: {
  notice: PrivacyNoticeVersion;
  collectedBy: string;
  collectedByUserId?: string;
  method?: ConsentMethod;
  note?: string;
  now?: Date;
}): CustomerConsentRecord {
  const now = params.now ?? new Date();
  const collectedBy = String(params.collectedBy || '').trim();
  if (!collectedBy) {
    throw new Error('Debe registrarse quién recabó el consentimiento.');
  }
  return {
    id: generateId('CONS'),
    noticeVersion: params.notice.version,
    noticeTextHash: params.notice.textHash,
    acceptedAt: now.toISOString(),
    acceptedLocalDate: formatLocalDate(now),
    collectedBy,
    collectedByUserId: params.collectedByUserId,
    method: params.method ?? 'PRESENCIAL_VERBAL',
    note: params.note?.trim() || undefined,
  };
}

export function appendConsentToCustomer<T>(customer: T, consent: CustomerConsentRecord): T {
  const privacy = getCustomerPrivacy(customer);
  return { ...(customer as any), privacy: { ...privacy, consents: [...privacy.consents, consent] } };
}

export function appendArcoRequest<T>(
  customer: T,
  params: { right: ArcoRight; attendedBy: string; detail: string; now?: Date }
): T {
  const privacy = getCustomerPrivacy(customer);
  const record: ArcoRequestRecord = {
    id: generateId('ARCO'),
    right: params.right,
    registeredAt: (params.now ?? new Date()).toISOString(),
    attendedBy: params.attendedBy,
    detail: params.detail,
  };
  return { ...(customer as any), privacy: { ...privacy, arcoRequests: [...privacy.arcoRequests, record] } };
}

export function registerOpposition<T>(
  customer: T,
  params: { scope: OppositionScope; registeredBy: string; note?: string; now?: Date }
): T {
  const now = params.now ?? new Date();
  const privacy = getCustomerPrivacy(customer);
  const record: OppositionRecord = {
    id: generateId('OPOS'),
    scope: params.scope,
    registeredAt: now.toISOString(),
    registeredBy: params.registeredBy,
    note: params.note?.trim() || undefined,
  };
  const updated = {
    ...(customer as any),
    privacy: {
      ...privacy,
      oppositions: [...privacy.oppositions, record],
      contactOptOut: privacy.contactOptOut || params.scope === 'CONTACTO' || params.scope === 'RECORDATORIOS',
    },
  };
  return appendArcoRequest(updated, {
    right: 'OPOSICION',
    attendedBy: params.registeredBy,
    detail: `Oposición registrada (${params.scope})${record.note ? `: ${record.note}` : ''}.`,
    now,
  });
}

// ---------------------------------------------------------------------------------------
// Relación del cliente con el Kardex (solo lectura)
// ---------------------------------------------------------------------------------------

function personalTokens(customer: any): string[] {
  return [customer?.name, customer?.alias, customer?.phone]
    .map((t) => String(t ?? '').trim())
    .filter((t) => t.length >= 3);
}

function entryMentions(entry: any, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const productName = typeof entry?.producto === 'object' ? entry?.producto?.name : entry?.producto;
  const haystack = [entry?.referencia, entry?.description, productName].map((t) => String(t ?? '')).join('\n');
  return tokens.some((t) => haystack.includes(t));
}

/** Movimientos del Kardex ligados al cliente (por ID o porque mencionan sus datos). */
export function findKardexEntriesForCustomer(kardex: readonly any[], customer: any): any[] {
  const id = String(customer?.id ?? '');
  const tokens = personalTokens(customer);
  return (kardex || []).filter((entry) => {
    if (!entry) return false;
    if (id && entry.customerId === id) return true;
    const productSku = typeof entry.producto === 'object' ? entry.producto?.sku : entry.producto;
    if (id && (entry.type === 'ABONO_FIADO' || entry.type === 'VENTA_FIADO') && productSku === id) return true;
    return entryMentions(entry, tokens);
  });
}

// ---------------------------------------------------------------------------------------
// Acceso: exportación de los datos de un cliente
// ---------------------------------------------------------------------------------------

export function buildCustomerDataExport(
  scope: PrivacyDataScope,
  customerId: string,
  params: { exportedBy: string; storeName: string; notice?: PrivacyNoticeConfig | null; now?: Date }
): { ok: boolean; message: string; data?: Record<string, any>; fileName?: string } {
  const customer = scope.creditCustomers.find((c) => c?.id === customerId);
  if (!customer) return { ok: false, message: 'Cliente no encontrado.' };
  const now = params.now ?? new Date();
  const privacy = getCustomerPrivacy(customer);
  const versionsById = new Map((params.notice?.versions || []).map((v) => [v.version, v]));

  const sales = (scope.salesHistory || []).filter((s) => s?.customerId === customerId);
  const returns = (scope.saleReturns || []).filter((r) => r?.customerId === customerId);
  const cash = (scope.cashMovements || []).filter((m) =>
    String(m?.reference || '').startsWith(`ABONO-${customerId}-`)
  );
  const kardex = findKardexEntriesForCustomer(scope.kardex || [], customer);

  const data = {
    formato: CUSTOMER_EXPORT_FORMAT,
    version: CUSTOMER_EXPORT_VERSION,
    derecho: 'ACCESO',
    negocio: params.storeName,
    generadoEn: now.toISOString(),
    generadoPor: params.exportedBy,
    titular: {
      id: customer.id,
      nombre: customer.name,
      alias: customer.alias ?? null,
      telefono: customer.phone || null,
      notas: customer.notes ?? null,
      activo: customer.isActive !== false,
      anonimizado: isCustomerAnonymized(customer),
    },
    credito: {
      limite: customer.creditLimit,
      plazoDias: customer.creditDays ?? null,
      saldoActual: customer.currentBalance,
      saldoAFavor: customer.creditFavorBalance ?? 0,
      vencimiento: customer.dueDate ?? null,
      estatus: customer.status ?? null,
    },
    deudas: customer.debts || [],
    abonos: customer.payments || [],
    ventasACredito: sales.map((s) => ({
      folio: s.folio,
      fecha: s.date,
      timestamp: s.timestamp,
      total: s.total,
      articulos: (s.items || []).map((i: any) => ({ nombre: i.name, cantidad: i.qty, importe: i.subtotal })),
      estado: s.status,
    })),
    devoluciones: returns,
    movimientosDeCaja: cash.map((m) => ({
      id: m.id,
      fecha: m.date,
      tipo: m.type,
      monto: m.amount,
      motivo: m.reason,
      metodo: m.paymentMethod,
    })),
    kardexRelacionado: {
      nota:
        'Movimientos del libro Kardex ligados a este cliente. El Kardex es append-only y encadenado ' +
        'con SHA-256: no se modifica ni se borra para no romper la integridad contable.',
      movimientos: kardex.map((k) => ({
        id: k.id,
        fecha: k.timestamp,
        tipo: k.type,
        referencia: k.referencia,
        descripcion: k.description,
        importe: k.amount,
        hash: k.entryHash,
      })),
    },
    privacidad: {
      consentimientos: privacy.consents.map((c) => ({
        ...c,
        textoDelAviso: versionsById.get(c.noticeVersion)?.text ?? null,
      })),
      solicitudesArco: privacy.arcoRequests,
      oposiciones: privacy.oppositions,
      noContactar: Boolean(privacy.contactOptOut),
      anonimizadoEn: privacy.anonymizedAt ?? null,
    },
  };

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return {
    ok: true,
    message: `Exportación de datos del cliente ${customer.id} generada.`,
    data,
    fileName: `datos-cliente-${customer.id}-${stamp}.json`,
  };
}

// ---------------------------------------------------------------------------------------
// Cancelación: anonimización que no rompe Kardex ni saldo
// ---------------------------------------------------------------------------------------

export interface AnonymizationReport {
  customerId: string;
  pseudonym: string;
  balancePreserved: number;
  favorBalancePreserved: number;
  debtsPreserved: number;
  paymentsPreserved: number;
  salesUpdated: number;
  returnsUpdated: number;
  cashMovementsUpdated: number;
  alertsUpdated: number;
  kardexEntriesRetained: number;
  kardexModified: false;
}

export function buildAnonymizedName(customerId: string): string {
  return `${ANONYMIZED_NAME_PREFIX} ${customerId}`;
}

/** Reemplaza nombre/alias por el seudónimo y el teléfono por "[dato eliminado]". */
function makeScrubber(customer: any, pseudonym: string): (text: unknown) => any {
  const replacements: Array<[string, string]> = [];
  const name = String(customer?.name ?? '').trim();
  const alias = String(customer?.alias ?? '').trim();
  const phone = String(customer?.phone ?? '').trim();
  if (name.length >= 2) replacements.push([name, pseudonym]);
  if (alias.length >= 3 && alias !== name) replacements.push([alias, pseudonym]);
  if (phone.length >= 5) replacements.push([phone, REDACTED_TEXT]);
  replacements.sort((a, b) => b[0].length - a[0].length);
  return (text: unknown) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  };
}

/**
 * Anonimiza a un cliente (derecho de cancelación) en todas las colecciones modificables.
 * Función pura: devuelve un nuevo alcance; no toca `scope.kardex`.
 */
export function anonymizeCustomerData<T extends PrivacyDataScope>(
  scope: T,
  customerId: string,
  params: { anonymizedBy: string; now?: Date }
): { ok: boolean; message: string; scope: T; report?: AnonymizationReport } {
  const customer = scope.creditCustomers.find((c) => c?.id === customerId);
  if (!customer) return { ok: false, message: 'Cliente no encontrado.', scope };
  if (isCustomerAnonymized(customer)) {
    return { ok: false, message: 'El cliente ya fue anonimizado.', scope };
  }
  const by = String(params.anonymizedBy || '').trim();
  if (!by) return { ok: false, message: 'Debe registrarse quién realizó la cancelación.', scope };

  const now = params.now ?? new Date();
  const pseudonym = buildAnonymizedName(customer.id);
  const scrub = makeScrubber(customer, pseudonym);
  const fullName = String(customer.name ?? '').trim();
  const linkedKardex = findKardexEntriesForCustomer(scope.kardex || [], customer);
  let salesUpdated = 0;
  let returnsUpdated = 0;
  let cashMovementsUpdated = 0;
  let alertsUpdated = 0;

  const privacy = getCustomerPrivacy(customer);
  let anonymized: any = {
    ...customer,
    name: pseudonym,
    alias: undefined,
    phone: '',
    notes: undefined,
    isActive: toCents(customer.currentBalance) > 0 ? customer.isActive !== false : false,
    debts: (customer.debts || []).map((d: any) => ({ ...d, description: scrub(d.description) })),
    payments: (customer.payments || []).map((p: any) => ({ ...p, note: scrub(p.note) })),
    privacy: {
      ...privacy,
      contactOptOut: true,
      anonymizedAt: now.toISOString(),
      anonymizedBy: by,
      retainedKardexEntryIds: linkedKardex.map((k) => k.id),
    },
  };
  anonymized = appendArcoRequest(anonymized, {
    right: 'CANCELACION',
    attendedBy: by,
    detail:
      `Datos de identificación eliminados (nombre, alias, teléfono y notas). Se conservaron ID, saldo, ` +
      `deudas y abonos. ${linkedKardex.length} movimiento(s) del Kardex se conservan sin cambios.`,
    now,
  });

  const salesHistory = scope.salesHistory?.map((s) => {
    if (s?.customerId !== customerId) return s;
    salesUpdated++;
    return {
      ...s,
      customerName: pseudonym,
      returns: Array.isArray(s.returns)
        ? s.returns.map((r: any) => (r?.customerName !== undefined ? { ...r, customerName: pseudonym } : r))
        : s.returns,
    };
  });

  const saleReturns = scope.saleReturns?.map((r) => {
    if (r?.customerId !== customerId) return r;
    returnsUpdated++;
    return { ...r, customerName: pseudonym };
  });

  const cashMovements = scope.cashMovements?.map((m) => {
    const linked = String(m?.reference || '').startsWith(`ABONO-${customerId}-`);
    const mentions =
      fullName.length >= 4 &&
      [m?.reason, m?.notes].some((t) => typeof t === 'string' && t.includes(fullName));
    if (!linked && !mentions) return m;
    cashMovementsUpdated++;
    return { ...m, reason: scrub(m.reason), notes: scrub(m.notes) };
  });

  const morningAlerts = scope.morningAlerts?.map((a) => {
    const fields = [a?.title, a?.detail];
    if (fullName.length < 4 || !fields.some((t) => typeof t === 'string' && t.includes(fullName))) return a;
    alertsUpdated++;
    return { ...a, title: scrub(a.title), detail: scrub(a.detail) };
  });

  const nextScope = {
    ...scope,
    creditCustomers: scope.creditCustomers.map((c) => (c?.id === customerId ? anonymized : c)),
    ...(salesHistory ? { salesHistory } : {}),
    ...(saleReturns ? { saleReturns } : {}),
    ...(cashMovements ? { cashMovements } : {}),
    ...(morningAlerts ? { morningAlerts } : {}),
  } as T;

  return {
    ok: true,
    message: `Cliente ${customer.id} anonimizado. Saldo y Kardex conservados sin cambios.`,
    scope: nextScope,
    report: {
      customerId: customer.id,
      pseudonym,
      balancePreserved: customer.currentBalance,
      favorBalancePreserved: customer.creditFavorBalance ?? 0,
      debtsPreserved: (customer.debts || []).length,
      paymentsPreserved: (customer.payments || []).length,
      salesUpdated,
      returnsUpdated,
      cashMovementsUpdated,
      alertsUpdated,
      kardexEntriesRetained: linkedKardex.length,
      kardexModified: false,
    },
  };
}
