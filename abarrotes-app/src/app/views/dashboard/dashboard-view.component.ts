import { Component, computed, inject } from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import { RouterLink, RouterModule } from '@angular/router';
import { AlertKind, MockInventoryService } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-dashboard-view',
  imports: [CommonModule, CurrencyPipe, DecimalPipe, RouterModule, RouterLink],
  templateUrl: './dashboard-view.component.html',
})
export class DashboardViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly alerts = computed(() => {
    const order: AlertKind[] = ['margen', 'cambio-fisico', 'auditoria', 'por-agotarse'];
    return [...this.inv.morningAlerts()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  });

  protected readonly overdueCustomersCount = computed(
    () => this.inv.creditCustomers().filter((c) => c.status !== 'AL_CORRIENTE').length,
  );

  /** Clases por tipo de alerta, respetando los colores semánticos. */
  protected styleFor(kind: AlertKind) {
    switch (kind) {
      case 'margen':
        return {
          card: 'border-red-500 bg-white',
          tag: 'bg-red-600 text-white',
          tagText: '🔺 Subió el costo',
          btn: 'bg-red-600 border-red-800 hover:bg-red-700',
        };
      case 'cambio-fisico':
        return {
          card: 'border-amber-500 bg-white',
          tag: 'bg-amber-600 text-white',
          tagText: '⚠️ Cambio físico (FEFO)',
          btn: 'bg-amber-600 border-amber-800 hover:bg-amber-700',
        };
      case 'auditoria':
        return {
          card: 'border-amber-500 bg-white',
          tag: 'bg-amber-600 text-white',
          tagText: '📋 Auditoría ciega',
          btn: 'bg-amber-600 border-amber-800 hover:bg-amber-700',
        };
      default:
        return {
          card: 'border-blue-500 bg-white',
          tag: 'bg-blue-600 text-white',
          tagText: '📉 Punto de Reorden (ROP)',
          btn: 'bg-blue-600 border-blue-800 hover:bg-blue-700',
        };
    }
  }
}
