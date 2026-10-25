/**
 * Lógica pura de dominio para mermas e inventario.
 */

export interface ShrinkRecordLike {
  id: string;
  sku?: string;
  name?: string;
  emoji?: string;
  qty?: number;
  unitCost?: number;
  [key: string]: any;
}

/**
 * Función pura que agrega un registro de merma a una lista garantizando idempotencia por id.
 * Si el registro entrante ya existe en la lista (mismo id) o no tiene id, no se duplica y retorna la lista existente.
 * Si es un registro nuevo, retorna una nueva lista con el registro añadido al inicio.
 */
export function addShrinkRecordIdempotent<T extends { id: string }>(
  records: readonly T[],
  incoming: T
): T[] {
  if (!incoming || !incoming.id) {
    return [...records];
  }
  const exists = records.some((r) => r.id === incoming.id);
  if (exists) {
    return [...records];
  }
  return [incoming, ...records];
}
