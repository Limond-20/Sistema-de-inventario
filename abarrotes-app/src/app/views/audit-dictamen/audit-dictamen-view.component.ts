import { Component, NgZone, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuditLine, MockInventoryService } from '../../services/mock-inventory.service';
import { sumMoney, multiplyMoney } from '../../domain/money';
import { IconComponent } from '../../components/icon/icon.component';

interface AuditView extends AuditLine {
  diffQty: number;
  diffMoney: number;
}

@Component({
  selector: 'app-audit-dictamen-view',
  imports: [CurrencyPipe, DecimalPipe, RouterLink, IconComponent],
  templateUrl: './audit-dictamen-view.component.html',
})
export class AuditDictamenViewComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  private readonly zone = inject(NgZone);

  private syncChannel: BroadcastChannel | null = null;
  private readonly storageListener = (ev: StorageEvent) => {
    if (ev.key === 'abarrotes_lan_last_event' && ev.newValue) {
      try {
        const data = JSON.parse(ev.newValue);
        if (data && data.type === 'AUDIT_SUBMIT' && Array.isArray(data.counts)) {
          this.zone.run(() => this.inv.submitBlindAuditResults(data.counts));
        }
      } catch {
        // ignore
      }
    }
  };

  protected readonly rows = computed<AuditView[]>(() =>
    this.inv.auditLines().map((l) => {
      const diffQty = +(l.countedQty - l.systemQty).toFixed(2);
      return { ...l, diffQty, diffMoney: multiplyMoney(l.unitCost, diffQty) };
    }),
  );

  protected readonly withDiff = computed(() => this.rows().filter((r) => r.diffQty !== 0));
  protected readonly matches = computed(() => this.rows().filter((r) => r.diffQty === 0).length);
  protected readonly missingMoney = computed(() =>
    sumMoney(this.withDiff().filter((r) => r.diffMoney < 0).map((r) => r.diffMoney)),
  );
  protected readonly extraMoney = computed(() =>
    sumMoney(this.withDiff().filter((r) => r.diffMoney > 0).map((r) => r.diffMoney)),
  );
  protected readonly allDone = computed(() => this.withDiff().every((r) => r.status !== 'pendiente'));

  ngOnInit(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.syncChannel = new BroadcastChannel('abarrotes_lan_sync');
      this.syncChannel.onmessage = (event) => {
        const data = event.data;
        if (data && data.type === 'AUDIT_SUBMIT' && Array.isArray(data.counts)) {
          this.zone.run(() => this.inv.submitBlindAuditResults(data.counts));
        }
      };
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.storageListener);
    }
  }

  ngOnDestroy(): void {
    if (this.syncChannel) {
      this.syncChannel.close();
      this.syncChannel = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
  }

  applySquare(sku: string, type: 'MERMA_OPERATIVA' | 'FALTANTE_INJUSTIFICADO'): void {
    this.inv.applySquareAdjustment(sku, type);
  }

  recount(sku: string): void {
    this.inv.setAuditStatus(sku, 'reconteo');
  }

  undo(sku: string): void {
    this.inv.setAuditStatus(sku, 'pendiente');
  }

  loadBlindMissionSample(): void {
    const mission = this.inv.generateDailyBlindAuditMission();
    const testDiffs: Record<string, number> = {
      'ACE-NUT-850': -3,
      'FRI-NEG-50K': -1.7,
      'ARR-SOS-900': 2,
      'CHI-LAC-220': -3,
      'PAN-BOL-PZ': -4,
    };
    const sampleCounts = mission.map((m) => {
      const p = this.inv.products().find((x) => x.sku === m.sku);
      const stock = p ? p.stock : 10;
      const diff = testDiffs[m.sku] ?? 0;
      return {
        sku: m.sku,
        countedQty: Math.max(0, +(stock + diff).toFixed(2)),
      };
    });
    this.inv.submitBlindAuditResults(sampleCounts);
  }

  unitLabel(r: AuditLine, qty: number): string {
    if (r.saleUnit === 'Kg') return 'kg';
    const base = r.saleUnit === 'Lata' ? 'lata' : r.saleUnit === 'Paquete' ? 'paquete' : 'pieza';
    return Math.abs(qty) === 1 ? base : base + 's';
  }
}
