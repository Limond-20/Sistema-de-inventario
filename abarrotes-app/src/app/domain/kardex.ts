/**
 * Lógica pura de dominio para el Kardex de inventario (auditable y estrictamente append-only).
 */

export type KardexType =
  | 'VENTA_EFECTIVO'
  | 'VENTA_FIADO'
  | 'ABONO_FIADO'
  | 'ENTRADA_COMPRA'
  | 'AJUSTE_AUDITORIA'
  | 'BAJA_MERMA'
  | 'CONSUMO_INTERNO'
  | 'FALTANTE_SISTEMA';

export interface KardexProductInfo {
  sku: string;
  name: string;
  saleUnit?: string;
}

export interface KardexEntry {
  id: string;
  timestamp: string; // ISO 8601 string (ej. 2026-10-25T12:00:00.000Z)
  type: KardexType;
  producto: KardexProductInfo | string;
  cantidad: number;
  saldoAnterior: number;
  saldoResultante: number;
  usuario: string;
  referencia: string;
  description?: string;
  amount?: number;
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

let sequenceCounter = 0;

/**
 * Genera un ID único para cada entrada del Kardex.
 * Garantiza unicidad incluso ante miles de movimientos por milisegundo.
 * No depende de los últimos 4 dígitos de la hora.
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

export interface CreateKardexEntryParams {
  type: KardexType;
  producto: KardexProductInfo | string;
  cantidad: number;
  saldoAnterior: number;
  saldoResultante: number;
  usuario: string;
  referencia: string;
  timestamp?: string;
  description?: string;
  amount?: number;
}

/**
 * Crea una entrada de Kardex con id único y fecha ISO estándar.
 */
export function createKardexEntry(params: CreateKardexEntryParams): KardexEntry {
  const prodName = typeof params.producto === 'string' ? params.producto : params.producto.name;
  const defaultDesc = `${params.type}: ${prodName} (Cant: ${params.cantidad >= 0 ? '+' : ''}${params.cantidad}, Saldo: ${params.saldoResultante})`;

  return {
    id: generateKardexId(),
    timestamp: params.timestamp || new Date().toISOString(),
    type: params.type,
    producto: params.producto,
    cantidad: params.cantidad,
    saldoAnterior: params.saldoAnterior,
    saldoResultante: params.saldoResultante,
    usuario: params.usuario,
    referencia: params.referencia,
    description: params.description ?? defaultDesc,
    amount: params.amount ?? 0,
  };
}

/**
 * Agrega una nueva entrada al Kardex preservando inmutabilidad y comportamiento append-only.
 * Estrictamente append-only: NO existen métodos para editar o eliminar entradas registradas.
 */
export function appendKardexEntry(
  history: readonly KardexEntry[],
  newEntry: KardexEntry
): KardexEntry[] {
  return [newEntry, ...history];
}

export interface StockItemLike {
  sku: string;
  name: string;
  stock: number;
  saleUnit?: string;
  [key: string]: any;
}

export interface StockDeductionResult<T extends StockItemLike> {
  updatedProduct: T;
  kardexEntries: KardexEntry[];
  shortageAlert?: SystemShortageAlert;
}

/**
 * Descuenta existencias de un producto sin enmascarar negativos (elimina Math.max(0, stock)).
 * Permite vender sin existencias previas, dejando el stock negativo si no hay suficiente.
 * Si el stock resulta negativo, genera automáticamente una entrada FALTANTE_SISTEMA en el Kardex
 * y una alerta para el tablero.
 */
export function deductStock<T extends StockItemLike>(
  product: T,
  qtySold: number,
  context: {
    saleType: 'VENTA_EFECTIVO' | 'VENTA_FIADO' | 'CONSUMO_INTERNO' | 'BAJA_MERMA';
    usuario: string;
    referencia: string;
    amount?: number;
    description?: string;
  }
): StockDeductionResult<T> {
  const saldoAnterior = product.stock;
  // Sin Math.max(0, ...): no se ocultan diferencias de inventario
  const saldoResultante = Math.round((saldoAnterior - qtySold) * 1000) / 1000;

  const entries: KardexEntry[] = [];

  const mainEntry = createKardexEntry({
    type: context.saleType,
    producto: {
      sku: product.sku,
      name: product.name,
      saleUnit: product.saleUnit,
    },
    cantidad: -qtySold,
    saldoAnterior,
    saldoResultante,
    usuario: context.usuario,
    referencia: context.referencia,
    amount: context.amount,
    description: context.description,
  });
  entries.push(mainEntry);

  let shortageAlert: SystemShortageAlert | undefined;

  // Si el stock resultante es negativo (< 0), se vendió sin existencias en sistema
  if (saldoResultante < 0) {
    const shortageEntry = createKardexEntry({
      type: 'FALTANTE_SISTEMA',
      producto: {
        sku: product.sku,
        name: product.name,
        saleUnit: product.saleUnit,
      },
      cantidad: saldoResultante,
      saldoAnterior,
      saldoResultante,
      usuario: context.usuario,
      referencia: `Faltante por venta sin existencia (${context.referencia})`,
      description: `FALTANTE EN SISTEMA: ${product.name} quedó en ${saldoResultante} ${product.saleUnit || 'piezas'}. Requiere ajuste físico urgente.`,
      amount: 0,
    });
    entries.push(shortageEntry);

    shortageAlert = {
      id: `ALERT-FALTANTE-${product.sku}-${Date.now()}`,
      kind: 'por-agotarse',
      icon: '🚨',
      title: `Stock en negativo: ${product.name} (${saldoResultante} ${product.saleUnit || 'Pz'})`,
      detail: `Se vendieron productos sin existencia registrada en sistema. Faltante detectado: ${Math.abs(saldoResultante)} ${product.saleUnit || 'Pz'}.`,
      actionLabel: 'Ver en catálogo',
      route: '/catalogo',
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
