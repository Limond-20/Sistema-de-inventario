import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { MockInventoryService, Product, marginPct } from '../../services/mock-inventory.service';

const TODAY = new Date('2026-10-17T12:00:00');
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

@Component({
  selector: 'app-catalog-view',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './catalog-view.component.html',
})
export class CatalogViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly search = signal('');
  protected readonly category = signal<string>('Todos');

  protected readonly categories = computed(() => ['Todos', ...new Set(this.inv.products().map((p) => p.category))]);

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cat = this.category();
    return this.inv
      .products()
      .filter((p) => (cat === 'Todos' || p.category === cat) && (!q || p.name.toLowerCase().includes(q) || p.barcode.includes(q)))
      .map((p) => ({ ...p, margin: marginPct(p.newCost, p.salePrice), daysLeft: this.daysLeft(p), low: p.stock < p.minStock }));
  });

  private daysLeft(p: Product) {
    return Math.round((new Date(p.expiry + 'T12:00:00').getTime() - TODAY.getTime()) / 86_400_000);
  }

  protected fmtDate(iso: string) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  protected onSearch(e: Event) { this.search.set((e.target as HTMLInputElement).value); }
  protected clearSearch() { this.search.set(''); }
}
