import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  AbcClass,
  MockInventoryService,
  Product,
  marginPct,
} from '../../services/mock-inventory.service';

const TODAY = new Date('2026-10-22T12:00:00');
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export type AbcFilter = 'ALL' | AbcClass;

@Component({
  selector: 'app-catalog-view',
  imports: [CommonModule, CurrencyPipe, DecimalPipe, FormsModule, RouterModule],
  templateUrl: './catalog-view.component.html',
})
export class CatalogViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly search = signal('');
  protected readonly category = signal<string>('Todos');
  protected readonly abcFilter = signal<AbcFilter>('ALL');
  protected readonly bulkSheetModalOpen = signal<boolean>(false);

  protected readonly categories = computed(() => [
    'Todos',
    ...new Set(this.inv.products().map((p) => p.category)),
  ]);

  protected readonly abcCounts = computed(() => {
    const all = this.inv.products();
    return {
      all: all.length,
      A: all.filter((p) => p.abcClass === 'A').length,
      B: all.filter((p) => p.abcClass === 'B').length,
      C: all.filter((p) => p.abcClass === 'C').length,
    };
  });

  protected readonly bulkProducts = computed(() =>
    this.inv.products().filter((p) => p.isBulk || p.barcode.startsWith('200')),
  );

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cat = this.category();
    const abc = this.abcFilter();
    return this.inv
      .products()
      .filter((p) => {
        const matchAbc = abc === 'ALL' || p.abcClass === abc;
        const matchCat = cat === 'Todos' || p.category === cat;
        const matchSearch =
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.barcode.includes(q) ||
          p.sku.toLowerCase().includes(q);
        return matchAbc && matchCat && matchSearch;
      })
      .map((p) => ({
        ...p,
        margin: marginPct(p.lastPurchaseCost, p.salePrice),
        daysLeft: this.daysLeft(p),
        belowRop: p.stock <= p.rop,
        costDiff: +(p.lastPurchaseCost - p.weightedAvgCost).toFixed(2),
      }));
  });

  private daysLeft(p: Product): number {
    return Math.round(
      (new Date(p.fefoExpiryDate + 'T12:00:00').getTime() - TODAY.getTime()) / 86_400_000,
    );
  }

  protected fmtDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  protected onSearch(e: Event): void {
    this.search.set((e.target as HTMLInputElement).value);
  }

  protected clearSearch(): void {
    this.search.set('');
  }

  protected openBulkSheetModal(): void {
    this.bulkSheetModalOpen.set(true);
  }

  protected closeBulkSheetModal(): void {
    this.bulkSheetModalOpen.set(false);
  }

  protected printBulkSheet(): void {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  /**
   * Genera barras determinísticas estilo EAN-13 a partir de los 13 dígitos del código
   * para renderizar un SVG nítido listo para escanear o imprimir en hoja carta.
   */
  protected buildBarcodeBars(barcode: string): { x: number; w: number; tall: boolean }[] {
    const bars: { x: number; w: number; tall: boolean }[] = [
      { x: 4, w: 1.5, tall: true },
      { x: 7, w: 1.5, tall: true },
    ];
    let cursor = 11;
    for (let i = 0; i < barcode.length; i++) {
      const digit = Number(barcode[i]) || 0;
      const w1 = (digit % 3) + 1;
      const gap1 = ((digit + 1) % 2) + 1.2;
      const w2 = ((digit + 2) % 3) + 1;
      bars.push({ x: cursor, w: w1, tall: false });
      cursor += w1 + gap1;
      bars.push({ x: cursor, w: w2, tall: false });
      cursor += w2 + 1.5;
      if (i === 5) {
        bars.push({ x: cursor, w: 1.2, tall: true });
        bars.push({ x: cursor + 2.5, w: 1.2, tall: true });
        cursor += 6;
      }
    }
    bars.push({ x: cursor, w: 1.5, tall: true });
    bars.push({ x: cursor + 3, w: 1.5, tall: true });
    return bars;
  }
}
