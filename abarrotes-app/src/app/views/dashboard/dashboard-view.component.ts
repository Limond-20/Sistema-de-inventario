import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { Router, RouterLink, RouterModule } from '@angular/router';
import { MockInventoryService, MorningAlert } from '../../services/mock-inventory.service';
import { ClassificationDiscrepancy } from '../../services/abc-classifier';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-dashboard-view',
  imports: [CommonModule, CurrencyPipe, RouterModule, RouterLink, IconComponent],
  templateUrl: './dashboard-view.component.html',
})
export class DashboardViewComponent {
  protected readonly inv = inject(MockInventoryService);
  private readonly router = inject(Router);

  // ---------- Modal de Reclasificación Mensual ABC ----------
  protected readonly abcModalOpen = signal<boolean>(false);
  protected readonly selectedDiscrepancies = signal<ClassificationDiscrepancy[]>([]);

  // ---------- Alertas de Faltante / Stock Negativo (Resolución con PIN) ----------
  protected readonly shortageAlerts = computed(() =>
    this.inv.morningAlerts().filter(
      (a) => a.kind === 'por-agotarse' || a.id.startsWith('A-FALTANTE'),
    ),
  );

  protected readonly resolveModalOpen = signal<boolean>(false);
  protected readonly selectedShortageAlert = signal<MorningAlert | null>(null);
  protected readonly resolveCountedQty = signal<number>(0);
  protected readonly resolvePin = signal<string>('');
  protected readonly resolveAuthorizer = signal<string>('Administrador');
  protected readonly resolveError = signal<string>('');
  protected readonly resolveSuccess = signal<string>('');

  openResolveAlertModal(alert: MorningAlert): void {
    this.selectedShortageAlert.set(alert);
    this.resolveCountedQty.set(0);
    this.resolvePin.set('');
    this.resolveError.set('');
    this.resolveSuccess.set('');
    this.resolveModalOpen.set(true);
  }

  closeResolveAlertModal(): void {
    this.resolveModalOpen.set(false);
  }

  setResolveCountedQty(val: string): void {
    this.resolveCountedQty.set(Number(val) || 0);
  }

  setResolvePin(val: string): void {
    this.resolvePin.set(val || '');
  }

  async submitResolveAlert(): Promise<void> {
    const alert = this.selectedShortageAlert();
    if (!alert) return;
    const parts = alert.id.split('-');
    const sku = (alert as any).sku || (parts.length >= 3 ? parts[2] : '');
    const res = await this.inv.resolveShortageAlertWithPin(
      alert.id,
      sku,
      Number(this.resolveCountedQty()),
      this.resolvePin(),
      this.resolveAuthorizer(),
    );
    if (res.ok) {
      this.resolveSuccess.set(res.message);
      setTimeout(() => {
        this.closeResolveAlertModal();
      }, 1000);
    } else {
      this.resolveError.set(res.message);
    }
  }

  // ---------- Indicadores de Badges para los Módulos ----------
  /** Getters para alertas numéricas directas */
  protected readonly marginAlertsCount = computed(() => this.inv.getMarginDropAlertsCount());
  protected readonly pendingAuditMissionCount = computed(() => this.inv.getPendingAuditMissionCount());
  protected readonly urgentFefoCount = computed(() => this.inv.getUrgentFefoCount());

  /** Discrepancias pendientes de la propuesta mensual ABC */
  protected readonly pendingAbcCount = computed(() => {
    if (this.inv.abcProposalDismissed()) return 0;
    return this.inv.abcDiscrepancies().length;
  });

  openAbcModal(): void {
    this.selectedDiscrepancies.set(structuredClone(this.inv.abcDiscrepancies()));
    this.abcModalOpen.set(true);
  }

  closeAbcModal(): void {
    this.abcModalOpen.set(false);
  }

  confirmAbcChanges(): void {
    this.inv.confirmClassificationChanges(this.selectedDiscrepancies());
    this.abcModalOpen.set(false);
  }

  postponeAbcChanges(): void {
    this.inv.dismissAbcProposal();
    this.abcModalOpen.set(false);
  }

  goToFiados(): void {
    this.router.navigate(['/pos'], { queryParams: { tab: 'fiados' } });
  }
}
