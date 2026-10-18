import { Component, computed, inject } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuditLine, MockInventoryService } from '../../services/mock-inventory.service';

interface AuditView extends AuditLine {
  diffQty: number;
  diffMoney: number;
}

@Component({
  selector: 'app-audit-dictamen-view',
  imports: [CurrencyPipe, DecimalPipe, RouterLink],
  templateUrl: './audit-dictamen-view.component.html',
})
export class AuditDictamenViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly rows = computed<AuditView[]>(() =>
    this.inv.auditLines().map((l) => {
      const diffQty = +(l.countedQty - l.systemQty).toFixed(2);
      return { ...l, diffQty, diffMoney: +(diffQty * l.unitCost).toFixed(2) };
    }),
  );

  protected readonly withDiff = computed(() => this.rows().filter((r) => r.diffQty !== 0));
  protected readonly matches = computed(() => this.rows().filter((r) => r.diffQty === 0).length);
  protected readonly missingMoney = computed(() =>
    this.withDiff().filter((r) => r.diffMoney < 0).reduce((s, r) => s + r.diffMoney, 0),
  );
  protected readonly extraMoney = computed(() =>
    this.withDiff().filter((r) => r.diffMoney > 0).reduce((s, r) => s + r.diffMoney, 0),
  );
  protected readonly allDone = computed(() => this.withDiff().every((r) => r.status !== 'pendiente'));

  authorize(sku: string) { this.inv.setAuditStatus(sku, 'autorizado'); }
  recount(sku: string) { this.inv.setAuditStatus(sku, 'reconteo'); }
  undo(sku: string) { this.inv.setAuditStatus(sku, 'pendiente'); }

  unitLabel(r: AuditLine, qty: number) {
    if (r.saleUnit === 'Kg') return 'kg';
    const base = r.saleUnit === 'Lata' ? 'lata' : r.saleUnit === 'Paquete' ? 'paquete' : 'pieza';
    return Math.abs(qty) === 1 ? base : base + 's';
  }
}
