// =====================================================================
//  CLASIFICADOR ABC POR UTILIDAD NETA GENERADA (PARETO ADAPTATIVO)
//
//  Fórmula de Valor de Utilización (VU):
//    VU = (product.salePrice - product.purchaseCost) * product.monthlySalesUnits
//
//  Umbrales de Pareto acumulados sobre Utilidad Neta:
//    Clase A: 0% a 80% de la ganancia total (Críticos: nunca deben faltar)
//    Clase B: 80% a 95% de la ganancia total (Rotación media)
//    Clase C: 95% a 100% de la ganancia total (Dinero dormido / liquidar)
// =====================================================================

import type { AbcClass, Product } from './mock-inventory.service';

export type AbcSource = 'MANUAL' | 'AUTOMATICA' | 'GUIADA';
export type AbcFlag = 'DINERO_DORMIDO' | 'GANCHO' | 'NUEVO' | 'CANDADO' | 'ESTABILIZADO';
export type GuidedFrequency = 'VARIAS_AL_DIA' | 'POR_SEMANA' | 'CASI_NO';

export interface GuidedAnswer {
  sku: string;
  frequency: GuidedFrequency;
  losesCustomer: boolean;
}

export interface AbcPolicy {
  label: string;
  plainMeaning: string;
  countEveryDays: number;
  serviceLevel: number;
  reorderAlert: boolean;
}

export const ABC_POLICIES: Record<string, AbcPolicy> = {
  A: {
    label: '🔥 Clase A',
    plainMeaning: 'Genera el 80% de tu ganancia neta. Nunca debe faltar.',
    countEveryDays: 7,
    serviceLevel: 0.97,
    reorderAlert: true,
  },
  B: {
    label: '⚡ Clase B',
    plainMeaning: 'Rotación intermedia (15% de ganancia). Vigilar periódicamente.',
    countEveryDays: 15,
    serviceLevel: 0.9,
    reorderAlert: true,
  },
  C: {
    label: '💤 Clase C',
    plainMeaning: 'Apenas genera el 5% de ganancia. Evitar sobrecompra.',
    countEveryDays: 30,
    serviceLevel: 0.8,
    reorderAlert: false,
  },
};

export const CATEGORY_FREQUENCY_HINT: Record<string, GuidedFrequency> = {
  Lácteos: 'VARIAS_AL_DIA',
  Huevo: 'VARIAS_AL_DIA',
  Panadería: 'VARIAS_AL_DIA',
  Bebidas: 'VARIAS_AL_DIA',
  Granos: 'POR_SEMANA',
  Aceites: 'POR_SEMANA',
  Endulzantes: 'POR_SEMANA',
  Pastas: 'POR_SEMANA',
  Enlatados: 'POR_SEMANA',
  Limpieza: 'CASI_NO',
  Higiene: 'CASI_NO',
};

export interface AbcResult {
  sku: string;
  currentClass: AbcClass;
  computedClass: AbcClass;
  finalClass: AbcClass;
  source: AbcSource;
  share: number;
  cumulativeBefore: number;
  rank: number;
  grossProfit: number;
  ticketCount: number;
  changed: boolean;
  reason: string;
  flags: AbcFlag[];
}

export interface ClassificationDiscrepancy {
  product: Product;
  currentClass: AbcClass;
  proposedClass: AbcClass;
  netProfit: number;
  monthlySalesUnits: number;
  share: number;
  cumulativePct: number;
}

/**
 * Obtiene el costo de compra unitario del producto, priorizando
 * purchaseCost, lastPurchaseCost, weightedAvgCost o historicCost.
 */
export function getProductPurchaseCost(product: Product): number {
  return product.purchaseCost ?? product.lastPurchaseCost ?? product.weightedAvgCost ?? product.historicCost ?? 0;
}

/**
 * Obtiene las unidades vendidas mensualmente (30 días).
 * Si no está definido en el producto, se proyecta desde dailySalesRate * 30.
 */
export function getProductMonthlySalesUnits(product: Product): number {
  if (typeof product.monthlySalesUnits === 'number') {
    return product.monthlySalesUnits;
  }
  return product.dailySalesRate ? +(product.dailySalesRate * 30).toFixed(1) : 0;
}

/**
 * Calcula el Valor de Utilización (VU) obligatorio:
 * VU = (product.salePrice - product.purchaseCost) * product.monthlySalesUnits
 * (Utilidad Neta Generada en pesos por mes, NO ingresos brutos).
 */
export function calculateVU(product: Product): number {
  const purchaseCost = getProductPurchaseCost(product);
  const unitProfit = Math.max(0, product.salePrice - purchaseCost);
  const monthlyUnits = getProductMonthlySalesUnits(product);
  return +(unitProfit * monthlyUnits).toFixed(2);
}

/**
 * Calcula la clasificación ABC calculada según Pareto sobre la Utilidad Neta:
 * Devuelve un mapa con la clase propuesta y datos de ranking por SKU.
 */
export function calculateAbcRankings(products: Product[]): Map<string, { proposedClass: AbcClass; netProfit: number; monthlyUnits: number; share: number; cumulativePct: number }> {
  const scored = products.map((p) => {
    const netProfit = calculateVU(p);
    const monthlyUnits = getProductMonthlySalesUnits(p);
    return {
      product: p,
      netProfit,
      monthlyUnits,
    };
  });

  const totalNetProfit = scored.reduce((sum, item) => sum + item.netProfit, 0);

  // Ordenar de mayor a menor utilidad neta generada
  scored.sort((a, b) => b.netProfit - a.netProfit);

  const results = new Map<string, { proposedClass: AbcClass; netProfit: number; monthlyUnits: number; share: number; cumulativePct: number }>();

  let cumulativeRunning = 0;

  for (const item of scored) {
    const share = totalNetProfit > 0 ? item.netProfit / totalNetProfit : 0;
    const cumBefore = cumulativeRunning;
    cumulativeRunning += share;

    let proposedClass: AbcClass;
    if (cumBefore < 0.80) {
      proposedClass = 'A';
    } else if (cumBefore < 0.95) {
      proposedClass = 'B';
    } else {
      proposedClass = 'C';
    }

    // Si el producto no deja ganancia y tiene stock, se clasifica como C
    if (item.netProfit <= 0 && item.product.stock > 0) {
      proposedClass = 'C';
    }

    results.set(item.product.sku, {
      proposedClass,
      netProfit: item.netProfit,
      monthlyUnits: item.monthlyUnits,
      share: +(share * 100).toFixed(1),
      cumulativePct: +(cumulativeRunning * 100).toFixed(1),
    });
  }

  return results;
}

/**
 * Compara la clase actual vs la calculada y devuelve la lista de discrepancias:
 * ({ product, currentClass, proposedClass, netProfit })
 *
 * NOTA: El sistema NO muta los productos automáticamente.
 */
export function proposeNewClassification(products: Product[]): ClassificationDiscrepancy[] {
  const rankings = calculateAbcRankings(products);
  const discrepancies: ClassificationDiscrepancy[] = [];

  for (const p of products) {
    const rank = rankings.get(p.sku);
    if (!rank) continue;

    if (rank.proposedClass !== p.abcClass) {
      discrepancies.push({
        product: p,
        currentClass: p.abcClass,
        proposedClass: rank.proposedClass,
        netProfit: rank.netProfit,
        monthlySalesUnits: rank.monthlyUnits,
        share: rank.share,
        cumulativePct: rank.cumulativePct,
      });
    }
  }

  return discrepancies.sort((a, b) => b.netProfit - a.netProfit);
}

/**
 * Aplica los cambios de clasificación aceptados por el usuario.
 * Devuelve un nuevo arreglo de productos con los cambios aplicados.
 */
export function confirmClassificationChanges(
  products: Product[],
  acceptedChanges: Array<{ sku: string; proposedClass: AbcClass } | ClassificationDiscrepancy>,
): Product[] {
  const changesMap = new Map<string, AbcClass>();
  for (const c of acceptedChanges) {
    const sku = 'product' in c ? c.product.sku : c.sku;
    changesMap.set(sku, c.proposedClass);
  }

  return products.map((p) => {
    if (changesMap.has(p.sku)) {
      return {
        ...p,
        abcClass: changesMap.get(p.sku)!,
      };
    }
    return p;
  });
}

/** Resumen estadístico por clase ABC. */
export function summarizeAbc(results: AbcResult[] | Array<{ finalClass: AbcClass; share: number }>) {
  const classes: AbcClass[] = ['A', 'B', 'C'];
  const by = (c: AbcClass) => results.filter((r) => r.finalClass === c);
  const shareOf = (c: AbcClass) => by(c).reduce((s, r) => s + (r.share || 0), 0);
  return classes.map((c) => ({
    cls: c,
    count: by(c).length,
    pctProducts: results.length ? by(c).length / results.length : 0,
    pctBusiness: shareOf(c),
  }));
}
