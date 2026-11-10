/**
 * Lógica pura de dominio para la Bitácora de Auditoría de Seguridad Encadenada (Bloque G).
 *
 * Registra de forma inmutable y encadenada criptográficamente (SHA-256):
 * - Altas, bajas lógicas y modificaciones de usuarios y roles.
 * - Cambios de PIN de acceso y administración.
 * - Modificaciones a los parámetros de ajustes del negocio.
 */

export const GENESIS_SECURITY_AUDIT_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';

export type SecurityAuditAction =
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DEACTIVATED'
  | 'USER_REACTIVATED'
  | 'PIN_CHANGED'
  | 'SETTINGS_UPDATED';

export interface SecurityAuditEntry {
  id: string;
  sequence: number;
  timestamp: string; // ISO 8601
  date: string; // AAAA-MM-DD fecha local
  action: SecurityAuditAction;
  actorUser: string;
  targetUser?: string;
  details: string;
  metadata?: Record<string, any>;
  prevHash: string;
  entryHash: string;
}

let auditSeq = 0;

export function generateAuditEntryId(): string {
  auditSeq = (auditSeq + 1) % 1_000_000;
  return `SEC-AUDIT-${Date.now()}-${auditSeq}`;
}

/**
 * Obtiene la fecha local actual en formato AAAA-MM-DD.
 */
function getLocalDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Serializa un objeto en formato JSON canónico determinista con claves ordenadas alfabéticamente.
 */
export function canonicalJsonStringify(obj: Record<string, any>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, any> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }
  return JSON.stringify(sortedObj);
}

/**
 * Algoritmo SHA-256 síncrono puro (FIPS 180-4) para encadenamiento y auditoría en cualquier entorno.
 */
export function sha256Sync(input: string): string {
  function r(v: number, a: number) {
    return (v >>> a) | (v << (32 - a));
  }
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const withOne = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setBigUint64(withOne.length - 8, BigInt(bitLen), false);

  const w = new Uint32Array(64);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = r(w[j - 15], 7) ^ r(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = r(w[j - 2], 17) ^ r(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let j = 0; j < 64; j++) {
      const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + k[j] + w[j]) >>> 0;
      const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((val) => val.toString(16).padStart(8, '0')).join('');
}

/**
 * Calcula el hash SHA-256 de una entrada de auditoría mediante serialización JSON canónica.
 */
export function computeSecurityAuditEntryHash(
  payload: {
    sequence: number;
    timestamp: string;
    date: string;
    action: SecurityAuditAction;
    actorUser: string;
    targetUser?: string;
    details: string;
    metadata?: Record<string, any>;
  },
  prevHash: string
): string {
  const canonicalPayload = canonicalJsonStringify({
    action: payload.action,
    actorUser: payload.actorUser,
    date: payload.date,
    details: payload.details,
    metadata: payload.metadata || {},
    prevHash,
    sequence: payload.sequence,
    targetUser: payload.targetUser || '',
    timestamp: payload.timestamp,
  });
  return sha256Sync(canonicalPayload);
}

/**
 * Crea una nueva entrada de auditoría de seguridad encadenada con la entrada previa.
 */
export function createSecurityAuditEntry(
  params: {
    action: SecurityAuditAction;
    actorUser: string;
    targetUser?: string;
    details: string;
    metadata?: Record<string, any>;
    timestamp?: string;
    date?: string;
  },
  previousEntry?: SecurityAuditEntry | null
): SecurityAuditEntry {
  const now = new Date();
  const timestamp = params.timestamp || now.toISOString();
  const date = params.date || getLocalDateString(now);
  const sequence = previousEntry ? previousEntry.sequence + 1 : 1;
  const prevHash = previousEntry ? previousEntry.entryHash : GENESIS_SECURITY_AUDIT_HASH;

  const payload = {
    sequence,
    timestamp,
    date,
    action: params.action,
    actorUser: (params.actorUser || 'Sistema').trim(),
    targetUser: params.targetUser?.trim() || undefined,
    details: (params.details || '').trim(),
    metadata: params.metadata || {},
  };

  const entryHash = computeSecurityAuditEntryHash(payload, prevHash);

  return {
    id: generateAuditEntryId(),
    sequence,
    timestamp,
    date,
    action: payload.action,
    actorUser: payload.actorUser,
    targetUser: payload.targetUser,
    details: payload.details,
    metadata: payload.metadata,
    prevHash,
    entryHash,
  };
}

/**
 * Valida la integridad criptográfica de la bitácora de auditoría de seguridad.
 * Soporta orden newest-first (por defecto en la app) u oldest-first.
 */
export function verifySecurityAuditChain(
  entries: SecurityAuditEntry[],
  order: 'oldest-first' | 'newest-first' = 'newest-first'
): { valid: boolean; error?: string; corruptedIndex?: number } {
  if (!entries || entries.length === 0) {
    return { valid: true };
  }

  // Normalizar a orden cronológico (oldest-first, secuencia ascendente 1, 2, 3...)
  const chronological =
    order === 'newest-first' ? [...entries].reverse() : [...entries];

  let expectedPrevHash = GENESIS_SECURITY_AUDIT_HASH;

  for (let i = 0; i < chronological.length; i++) {
    const entry = chronological[i];
    const originalIndex = order === 'newest-first' ? entries.length - 1 - i : i;

    // 1. Validar encadenamiento de hash previo
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        error: `Ruptura en la cadena en secuencia #${entry.sequence}: prevHash '${entry.prevHash}' no coincide con el hash esperado '${expectedPrevHash}'.`,
        corruptedIndex: originalIndex,
      };
    }

    // 2. Validar integridad del hash de la entrada
    const computedHash = computeSecurityAuditEntryHash(
      {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        date: entry.date,
        action: entry.action,
        actorUser: entry.actorUser,
        targetUser: entry.targetUser,
        details: entry.details,
        metadata: entry.metadata,
      },
      entry.prevHash
    );

    if (computedHash !== entry.entryHash) {
      return {
        valid: false,
        error: `Hash alterado en secuencia #${entry.sequence}: '${entry.entryHash}' no coincide con el hash calculado '${computedHash}'.`,
        corruptedIndex: originalIndex,
      };
    }

    expectedPrevHash = entry.entryHash;
  }

  return { valid: true };
}
