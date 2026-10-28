/**
 * Lógica pura de dominio para el Kardex de inventario (auditable, encadenado criptográficamente y append-only).
 */

export type KardexType =
  | 'VENTA_EFECTIVO'
  | 'VENTA_FIADO'
  | 'ABONO_FIADO'
  | 'ENTRADA_COMPRA'
  | 'AJUSTE_AUDITORIA'
  | 'BAJA_MERMA'
  | 'CONSUMO_INTERNO'
  | 'FALTANTE_SISTEMA'
  | 'CAMBIO_USUARIO';

export interface KardexProductInfo {
  sku: string;
  name: string;
  saleUnit?: string;
}

export interface KardexEntry {
  id: string;
  timestamp: string; // ISO 8601 string
  type: KardexType;
  producto: KardexProductInfo | string;
  cantidad: number;
  saldoAnterior: number;
  saldoResultante: number;
  usuario: string; // Usuario / cajero activo real
  referencia: string;
  description?: string;
  amount?: number;
  previousHash: string; // SHA-256 de la entrada anterior (o 'GENESIS')
  entryHash: string; // SHA-256 del JSON ordenado con previousHash + campos de esta entrada
}

export interface SystemShortageAlert {
  id: string;
  kind: 'por-agotarse';
  icon: string;
  title: string;
  detail: string;
  actionLabel: string;
  route: string;
  sku: string;
  negativeStock: number;
}

export interface StockItemLike {
  sku: string;
  name: string;
  stock: number;
  saleUnit?: string;
  [key: string]: any;
}

let sequenceCounter = 0;

/**
 * Genera un ID único para cada entrada del Kardex (sin colisiones).
 */
export function generateKardexId(): string {
  sequenceCounter = (sequenceCounter + 1) % 1_000_000_000;
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `K-${globalThis.crypto.randomUUID()}`;
  }
  const timestamp = Date.now();
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `K-${timestamp}-${sequenceCounter}-${rand}`;
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
 * Cola serializadora (candado asíncrono FIFO) para garantizar que la creación
 * y encadenamiento criptográfico de entradas del Kardex se ejecute estrictamente
 * de forma secuencial, previniendo bifurcaciones de hash bajo concurrencia.
 */
export class KardexAsyncQueue {
  private queue: Promise<any> = Promise.resolve();

  /**
   * Encola una tarea asíncrona o síncrona asegurando ejecución atómica secuencial.
   */
  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          try {
            const res = await task();
            resolve(res);
          } catch (err) {
            reject(err);
          }
        })
        .catch((err) => {
          reject(err);
        });
    });
  }
}

export const globalKardexQueue = new KardexAsyncQueue();

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

  const w = new Int32Array(64);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = r(w[t - 15], 7) ^ r(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = r(w[t - 2], 17) ^ r(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h0] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h0 + s1 + ch + k[t] + w[t]) | 0;
      const s0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h0 = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + h0) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Calcula el hash criptográfico SHA-256 encadenado de una entrada del Kardex
 * serializando los campos con JSON ordenado alfabéticamente (no con "|").
 */
export function computeKardexHash(
  entry: Omit<KardexEntry, 'entryHash'>,
  previousHash: string = 'GENESIS'
): string {
  const prodSku =
    typeof entry.producto === 'string'
      ? entry.producto
      : entry.producto?.sku || 'GENERIC';
  const canonicalPayload = {
    amount: entry.amount ?? 0,
    cantidad: entry.cantidad,
    id: entry.id,
    previousHash,
    producto: prodSku,
    referencia: entry.referencia,
    saldoAnterior: entry.saldoAnterior,
    saldoResultante: entry.saldoResultante,
    timestamp: entry.timestamp,
    type: entry.type,
    usuario: entry.usuario,
  };
  return sha256Sync(canonicalJsonStringify(canonicalPayload));
}

export interface CreateKardexEntryParams {
  type: KardexType;
  producto: KardexProductInfo | string;
  cantidad: number;
  saldoAnterior: number;
  saldoResultante: number;
  usuario: string; // Usuario / cajero activo
  referencia: string;
  previousHash?: string;
  timestamp?: string;
  description?: string;
  amount?: number;
}

/**
 * Crea una entrada de Kardex encadenada criptográficamente con SHA-256.
 */
export function createKardexEntry(
  params: CreateKardexEntryParams,
  previousHash: string = params.previousHash || 'GENESIS'
): KardexEntry {
  const prodName = typeof params.producto === 'string' ? params.producto : params.producto.name;
  const defaultDesc = `${params.type}: ${prodName} (Cant: ${params.cantidad >= 0 ? '+' : ''}${params.cantidad}, Saldo: ${params.saldoResultante})`;
  const id = generateKardexId();
  const timestamp = params.timestamp || new Date().toISOString();

  const baseEntry: Omit<KardexEntry, 'entryHash'> = {
    id,
    timestamp,
    type: params.type,
    producto: params.producto,
    cantidad: params.cantidad,
    saldoAnterior: params.saldoAnterior,
    saldoResultante: params.saldoResultante,
    usuario: params.usuario,
    referencia: params.referencia,
    description: params.description ?? defaultDesc,
    amount: params.amount ?? 0,
    previousHash,
  };

  const entryHash = computeKardexHash(baseEntry, previousHash);

  return {
    ...baseEntry,
    entryHash,
  };
}

/**
 * Agrega una nueva entrada al Kardex preservando inmutabilidad y comportamiento append-only.
 */
export function appendKardexEntry(
  history: readonly KardexEntry[],
  newEntry: KardexEntry
): KardexEntry[] {
  return [newEntry, ...history];
}

/**
 * Verifica la integridad del encadenamiento criptográfico del Kardex.
 * Detecta si alguna entrada fue alterada, suprimida o reordenada.
 */
export function verifyKardexChain(
  entries: readonly KardexEntry[],
  order: 'chronological' | 'newest-first' = 'newest-first'
): { valid: boolean; error?: string; tamperedEntryId?: string; tamperedIndex?: number } {
  if (!entries || entries.length === 0) {
    return { valid: true };
  }

  // Trabajamos cronológicamente de la más antigua (génesis) a la más reciente
  const chrono = order === 'newest-first' ? [...entries].reverse() : [...entries];

  for (let i = 0; i < chrono.length; i++) {
    const entry = chrono[i];
    const expectedPreviousHash = i === 0 ? 'GENESIS' : chrono[i - 1].entryHash;

    if (entry.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        error: `Ruptura de cadena en entrada #${entry.id}: previousHash no coincide con el hash previo.`,
        tamperedEntryId: entry.id,
        tamperedIndex: i,
      };
    }

    const recomputedHash = computeKardexHash(entry, entry.previousHash);
    if (recomputedHash !== entry.entryHash) {
      return {
        valid: false,
        error: `Entrada alterada #${entry.id}: el hash calculado no coincide con entryHash.`,
        tamperedEntryId: entry.id,
        tamperedIndex: i,
      };
    }
  }

  return { valid: true };
}

/**
 * Verifica la continuidad de inventario por producto:
 * Para todas las entradas cronológicas del producto:
 * saldoResultante[i] == saldoAnterior[i+1] y stock actual == último saldoResultante.
 */
export function verifyProductContinuity(
  sku: string,
  entries: readonly KardexEntry[],
  currentStock: number,
  order: 'chronological' | 'newest-first' = 'newest-first'
): { valid: boolean; error?: string; discrepantIndex?: number } {
  const chrono = order === 'newest-first' ? [...entries].reverse() : [...entries];
  const prodEntries = chrono.filter((e) => {
    const prodSku = typeof e.producto === 'string' ? e.producto : e.producto?.sku;
    return prodSku === sku;
  });

  if (prodEntries.length === 0) {
    return { valid: true };
  }

  for (let i = 0; i < prodEntries.length - 1; i++) {
    const current = prodEntries[i];
    const next = prodEntries[i + 1];
    if (current.saldoResultante !== next.saldoAnterior) {
      return {
        valid: false,
        error: `Discontinuidad en producto ${sku} entre entradas #${current.id} (resultante: ${current.saldoResultante}) y #${next.id} (anterior: ${next.saldoAnterior})`,
        discrepantIndex: i,
      };
    }
  }

  const lastEntry = prodEntries[prodEntries.length - 1];
  if (lastEntry.saldoResultante !== currentStock) {
    return {
      valid: false,
      error: `Discontinuidad final: el stock actual (${currentStock}) no coincide con el último saldoResultante (${lastEntry.saldoResultante}) de la entrada #${lastEntry.id}`,
    };
  }

  return { valid: true };
}

export interface StockDeductionResult<T extends StockItemLike> {
  updatedProduct: T;
  kardexEntries: KardexEntry[];
  shortageAlert?: SystemShortageAlert;
}

/**
 * Descuenta existencias en ventas (POS): permite vender sin existencias dejando stock negativo.
 * FALTANTE_SISTEMA registra ESTRICTAMENTE el déficit real que sobrepasó la existencia.
 */
export function deductStock<T extends StockItemLike>(
  product: T,
  qtySold: number,
  context: {
    saleType: 'VENTA_EFECTIVO' | 'VENTA_FIADO';
    usuario: string; // Usuario / cajero activo
    referencia: string;
    previousHash?: string;
    amount?: number;
    description?: string;
  }
): StockDeductionResult<T> {
  const saldoAnterior = product.stock;
  const saldoResultante = Math.round((saldoAnterior - qtySold) * 1000) / 1000;
  const entries: KardexEntry[] = [];
  let prevHash = context.previousHash || 'GENESIS';

  const saleEntry = createKardexEntry(
    {
      type: context.saleType,
      producto: { sku: product.sku, name: product.name, saleUnit: product.saleUnit },
      cantidad: -qtySold,
      saldoAnterior,
      saldoResultante,
      usuario: context.usuario,
      referencia: context.referencia,
      amount: context.amount,
      description: context.description,
    },
    prevHash
  );
  entries.push(saleEntry);
  prevHash = saleEntry.entryHash;

  let shortageAlert: SystemShortageAlert | undefined;

  // Si el stock resultante es negativo, se vendió sin existencias
  if (saldoResultante < 0) {
    // DÉFICIT REAL: solo la porción que excedió la existencia registrada
    const realDeficit =
      saldoAnterior >= 0
        ? Math.round((qtySold - saldoAnterior) * 1000) / 1000
        : qtySold;

    // FALTANTE_SISTEMA se encadena sin saltar el stock (mantiene continuidad en saldoResultante)
    const shortageEntry = createKardexEntry(
      {
        type: 'FALTANTE_SISTEMA',
        producto: { sku: product.sku, name: product.name, saleUnit: product.saleUnit },
        cantidad: -realDeficit,
        saldoAnterior: saldoResultante,
        saldoResultante: saldoResultante,
        usuario: context.usuario,
        referencia: `Faltante real por venta sin stock: ${product.sku} (Déficit: ${realDeficit})`,
        description: `FALTANTE EN SISTEMA: ${product.name} déficit real de ${realDeficit} ${product.saleUnit || 'Pz'}. Saldo actual: ${saldoResultante}.`,
        amount: 0,
      },
      prevHash
    );
    entries.push(shortageEntry);

    shortageAlert = {
      id: `A-FALTANTE-${product.sku}-${Date.now()}`,
      kind: 'por-agotarse',
      icon: '🚨',
      title: `Stock en negativo: ${product.name} (${saldoResultante} ${product.saleUnit || 'Pz'})`,
      detail: `Venta sin existencia. Déficit real: ${realDeficit} ${product.saleUnit || 'Pz'}. Saldo: ${saldoResultante}. Requiere ajuste físico con PIN.`,
      actionLabel: 'Resolver con PIN',
      route: '/auditoria',
      sku: product.sku,
      negativeStock: saldoResultante,
    };
  }

  return {
    updatedProduct: {
      ...product,
      stock: saldoResultante,
    },
    kardexEntries: entries,
    shortageAlert,
  };
}

export interface DisposalParams<T extends StockItemLike> {
  product: T;
  qtyToDeduct: number;
  type: 'BAJA_MERMA' | 'CONSUMO_INTERNO';
  usuario: string; // Usuario / cajero activo
  referencia: string;
  adminPinAuthorized?: boolean;
  overrideReason?: string;
  previousHash?: string;
  amount?: number;
  description?: string;
}

export interface DisposalResult<T extends StockItemLike> {
  ok: boolean;
  message: string;
  requiresPin?: boolean;
  updatedProduct?: T;
  kardexEntries?: KardexEntry[];
  shortageAlert?: SystemShortageAlert;
}

/**
 * Descuenta existencias para Mermas o Consumo Interno:
 * REGLA: No permitir baja mayor que la existencia registrada a menos que se autorice con PIN de admin y motivo.
 */
export function deductStockForDisposal<T extends StockItemLike>(
  params: DisposalParams<T>
): DisposalResult<T> {
  const currentStock = params.product.stock;

  // Si la cantidad solicitada excede la existencia
  if (params.qtyToDeduct > currentStock) {
    if (!params.adminPinAuthorized) {
      return {
        ok: false,
        requiresPin: true,
        message: `Baja no permitida: la cantidad solicitada (${params.qtyToDeduct}) supera la existencia disponible (${currentStock} ${params.product.saleUnit || 'Pz'}). Se requiere PIN de administrador y justificación.`,
      };
    }
    if (!params.overrideReason?.trim()) {
      return {
        ok: false,
        requiresPin: true,
        message: 'Para autorizar una baja por encima de existencias es obligatorio indicar el motivo de la diferencia.',
      };
    }
  }

  const saldoAnterior = currentStock;
  const saldoResultante = Math.round((saldoAnterior - params.qtyToDeduct) * 1000) / 1000;
  const entries: KardexEntry[] = [];
  let prevHash = params.previousHash || 'GENESIS';

  const refWithMotive = params.overrideReason
    ? `${params.referencia} [Excedente autorizado: ${params.overrideReason}]`
    : params.referencia;

  const mainEntry = createKardexEntry(
    {
      type: params.type,
      producto: { sku: params.product.sku, name: params.product.name, saleUnit: params.product.saleUnit },
      cantidad: -params.qtyToDeduct,
      saldoAnterior,
      saldoResultante,
      usuario: params.usuario,
      referencia: refWithMotive,
      amount: params.amount,
      description: params.description,
    },
    prevHash
  );
  entries.push(mainEntry);
  prevHash = mainEntry.entryHash;

  let shortageAlert: SystemShortageAlert | undefined;

  // Si el saldo quedó negativo (por override autorizado)
  if (saldoResultante < 0) {
    const realDeficit =
      saldoAnterior >= 0
        ? Math.round((params.qtyToDeduct - saldoAnterior) * 1000) / 1000
        : params.qtyToDeduct;

    const shortageEntry = createKardexEntry(
      {
        type: 'FALTANTE_SISTEMA',
        producto: { sku: params.product.sku, name: params.product.name, saleUnit: params.product.saleUnit },
        cantidad: -realDeficit,
        saldoAnterior: saldoResultante,
        saldoResultante: saldoResultante,
        usuario: params.usuario,
        referencia: `Déficit en baja autorizada con PIN: ${params.product.sku} (Déficit: ${realDeficit})`,
        description: `FALTANTE EN SISTEMA (Baja sobregirada): ${params.product.name} déficit real ${realDeficit} ${params.product.saleUnit || 'Pz'}.`,
        amount: 0,
      },
      prevHash
    );
    entries.push(shortageEntry);

    shortageAlert = {
      id: `A-FALTANTE-${params.product.sku}-${Date.now()}`,
      kind: 'por-agotarse',
      icon: '🚨',
      title: `Stock en negativo: ${params.product.name} (${saldoResultante} ${params.product.saleUnit || 'Pz'})`,
      detail: `Baja sobregirada autorizada con PIN. Déficit real: ${realDeficit}. Saldo: ${saldoResultante}.`,
      actionLabel: 'Resolver con PIN',
      route: '/auditoria',
      sku: params.product.sku,
      negativeStock: saldoResultante,
    };
  }

  return {
    ok: true,
    message: 'Baja autorizada y procesada correctamente.',
    updatedProduct: {
      ...params.product,
      stock: saldoResultante,
    },
    kardexEntries: entries,
    shortageAlert,
  };
}

/**
 * Resuelve una alerta de faltante de stock mediante conteo físico autorizado por PIN de administrador.
 */
export function resolveShortageAlertAdjustment<T extends StockItemLike>(
  product: T,
  countedPhysicalStock: number,
  authorizerName: string,
  alertId: string,
  previousHash: string = 'GENESIS'
): { updatedProduct: T; kardexEntry: KardexEntry } {
  const saldoAnterior = product.stock;
  const saldoResultante = Math.round(countedPhysicalStock * 1000) / 1000;
  const diff = Math.round((saldoResultante - saldoAnterior) * 1000) / 1000;

  const kardexEntry = createKardexEntry(
    {
      type: 'AJUSTE_AUDITORIA',
      producto: { sku: product.sku, name: product.name, saleUnit: product.saleUnit },
      cantidad: diff,
      saldoAnterior,
      saldoResultante,
      usuario: authorizerName,
      referencia: `Resolución Alerta Faltante #${alertId}`,
      description: `Ajuste por resolución de alerta de faltante: ${product.name} cuadrado de ${saldoAnterior} a ${saldoResultante} ${product.saleUnit || 'Pz'}`,
      amount: 0,
    },
    previousHash
  );

  return {
    updatedProduct: {
      ...product,
      stock: saldoResultante,
    },
    kardexEntry,
  };
}
