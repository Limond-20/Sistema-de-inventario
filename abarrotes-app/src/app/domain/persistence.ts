/**
 * Lógica pura de dominio para la persistencia del estado en IndexedDB (Bloque D).
 *
 * =====================================================================================
 * NOTA PARA EL EQUIPO (ARQUITECTURA Y FUENTE DE VERDAD):
 * Esta persistencia en IndexedDB del navegador es una solución de prototipo para garantizar
 * que los datos operativos no se pierdan ante recargas accidentales de página durante las
 * pruebas piloto en mostrador.
 *
 * La base de datos definitiva será SQLite en local-server (Python), con la computadora de la
 * tienda (PC) fungiendo como la única fuente de verdad contable y de inventario.
 *
 * REGLA DE SEGURIDAD CRÍTICA:
 * El PIN de administrador NUNCA se almacena en texto plano en el estado ni en IndexedDB.
 * La autenticación se delega exclusivamente a PBKDF2 (>= 600,000 iteraciones + sal de 16 bytes).
 * =====================================================================================
 */

export type KardexChainVerifier = (entries: any[]) => { valid: boolean; error?: string };

export const CURRENT_SCHEMA_VERSION = 1;
export const STATE_STORAGE_KEY = 'binnitech_pos_state_v1';
export const DEFAULT_DEBOUNCE_MS = 500;

export interface PersistedAppState {
  schemaVersion: number;
  timestamp: string;
  activeUser: string;
  products: any[];
  creditCustomers: any[];
  cashShift: any;
  cashRegister: any;
  kardex: any[];
  shrinkRecords: any[];
  auditLines: any[];
  internalConsumptionRecords?: any[];
  morningAlerts?: any[];
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Valida la integridad estructural y criptográfica del estado almacenado.
 * Detecta datos dañados, campos ausentes, tipos incorrectos o cadenas de Kardex alteradas.
 */
export function validateStoredState(
  data: any,
  kardexVerifier?: KardexChainVerifier
): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'El dato almacenado está vacío o no es un objeto válido.' };
  }

  // 1. Validar versión de esquema
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 0) {
    return { valid: false, reason: 'Versión de esquema inválida o ausente.' };
  }

  // 2. Validar que las colecciones requeridas sean arreglos
  if (!Array.isArray(data.products)) {
    return { valid: false, reason: 'La colección de productos está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.creditCustomers)) {
    return { valid: false, reason: 'La colección de clientes de fiado está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.kardex)) {
    return { valid: false, reason: 'La colección de Kardex está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.shrinkRecords)) {
    return { valid: false, reason: 'La colección de mermas está dañada o no es un arreglo.' };
  }
  if (!Array.isArray(data.auditLines)) {
    return { valid: false, reason: 'La colección de auditorías está dañada o no es un arreglo.' };
  }

  // 3. Validar consistencia básica de productos
  for (let i = 0; i < data.products.length; i++) {
    const p = data.products[i];
    if (!p || typeof p.sku !== 'string' || typeof p.stock !== 'number') {
      return { valid: false, reason: `Producto dañado en índice ${i} (SKU o stock no numérico).` };
    }
  }

  // 4. Validar integridad estructural y criptográfica del Kardex si contiene movimientos
  if (data.kardex.length > 0) {
    const k = data.kardex;
    for (let i = 0; i < k.length; i++) {
      const entry = k[i];
      if (!entry || typeof entry !== 'object' || !entry.id || !entry.previousHash) {
        return { valid: false, reason: `Entrada de Kardex dañada en índice ${i}.` };
      }
    }

    if (kardexVerifier) {
      const chainCheck = kardexVerifier(data.kardex);
      if (!chainCheck.valid) {
        return {
          valid: false,
          reason: `Integridad criptográfica del Kardex rota: ${chainCheck.error || 'cadena alterada'}.`,
        };
      }
    }
  }

  return { valid: true };
}

export interface MigrationResult {
  state: PersistedAppState;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  message?: string;
}

/**
 * Realiza migraciones simples de versiones anteriores de esquema a la versión actual.
 */
export function migrateState(data: any): MigrationResult {
  const rawVersion = typeof data?.schemaVersion === 'number' ? data.schemaVersion : 0;

  if (rawVersion === CURRENT_SCHEMA_VERSION) {
    return {
      state: data as PersistedAppState,
      migrated: false,
      fromVersion: rawVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
    };
  }

  let working = { ...data };

  // Migración de versión 0 (datos antiguos sin schemaVersion explícito) a versión 1
  if (rawVersion === 0) {
    working = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp: working.timestamp || new Date().toISOString(),
      activeUser: working.activeUser || 'Don Lupe (Encargado)',
      products: Array.isArray(working.products) ? working.products : [],
      creditCustomers: Array.isArray(working.creditCustomers) ? working.creditCustomers : [],
      cashShift: working.cashShift || {
        openingCash: 500,
        cashSalesTotal: 0,
        creditPaymentsReceived: 0,
        creditSalesTotal: 0,
        internalConsumptionTotalCost: 0,
        shrinkTotalCost: 0,
      },
      cashRegister: working.cashRegister || {
        openingFloat: 500,
        cashSalesTotal: 0,
        creditSalesTotal: 0,
        creditPaymentsReceived: 0,
      },
      kardex: Array.isArray(working.kardex) ? working.kardex : [],
      shrinkRecords: Array.isArray(working.shrinkRecords) ? working.shrinkRecords : [],
      auditLines: Array.isArray(working.auditLines) ? working.auditLines : [],
      internalConsumptionRecords: Array.isArray(working.internalConsumptionRecords)
        ? working.internalConsumptionRecords
        : [],
      morningAlerts: Array.isArray(working.morningAlerts) ? working.morningAlerts : [],
    };
  }

  return {
    state: working as PersistedAppState,
    migrated: true,
    fromVersion: rawVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    message: `Estado migrado de versión ${rawVersion} a versión ${CURRENT_SCHEMA_VERSION}.`,
  };
}

/**
 * Administrador de guardado diferido (debounce) para no saturar I/O de disco o IndexedDB.
 */
export class DebouncedStorageSaver {
  private timer: any = null;
  public readonly delayMs: number;

  constructor(delayMs = DEFAULT_DEBOUNCE_MS) {
    this.delayMs = delayMs;
  }

  schedule(task: () => Promise<void> | void): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      task();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async flush(task: () => Promise<void> | void): Promise<void> {
    this.cancel();
    await task();
  }
}

/**
 * Interfaz de adaptador de almacenamiento para desacoplar IndexedDB y permitir pruebas unitarias.
 */
export interface StateStorageAdapter {
  save(key: string, value: any): Promise<void>;
  load(key: string): Promise<any>;
  clear(): Promise<void>;
}

/**
 * Adaptador de almacenamiento en memoria para pruebas rápidas y entornos Node.js.
 */
export class MemoryStateStorageAdapter implements StateStorageAdapter {
  private store = new Map<string, string>();

  async save(key: string, value: any): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async load(key: string): Promise<any> {
    const raw = this.store.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Adaptador de almacenamiento nativo en IndexedDB del navegador de la PC (cero dependencias externas).
 */
export class IndexedDbStateStorageAdapter implements StateStorageAdapter {
  private dbName: string;
  private storeName: string;
  private dbVersion: number;

  constructor(
    dbName = 'binnitech_pos_db',
    storeName = 'app_state',
    dbVersion = 1
  ) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbVersion = dbVersion;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB no está disponible en este entorno.'));
      }
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async save(key: string, value: any): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async load(key: string): Promise<any> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }
}

/**
 * Obtiene el adaptador predeterminado: IndexedDB en el navegador, MemoryAdapter en Node/CLI.
 */
export function getDefaultStorageAdapter(): StateStorageAdapter {
  if (typeof globalThis.indexedDB !== 'undefined') {
    return new IndexedDbStateStorageAdapter();
  }
  return new MemoryStateStorageAdapter();
}
