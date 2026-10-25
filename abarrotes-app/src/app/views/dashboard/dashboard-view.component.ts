import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { Router, RouterLink, RouterModule } from '@angular/router';
import { MockInventoryService } from '../../services/mock-inventory.service';
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
