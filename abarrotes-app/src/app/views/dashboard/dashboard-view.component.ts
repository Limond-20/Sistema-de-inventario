import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AlertKind, MockInventoryService } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-dashboard-view',
  imports: [RouterLink],
  templateUrl: './dashboard-view.component.html',
})
export class DashboardViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly alerts = computed(() => {
    const order: AlertKind[] = ['margen', 'cambio-fisico', 'auditoria', 'por-agotarse'];
    return [...this.inv.morningAlerts()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  });

  /** Clases por tipo de alerta, respetando los colores semánticos. */
  protected styleFor(kind: AlertKind) {
    switch (kind) {
      case 'margen':
        return { card: 'border-red-600 bg-red-50', tag: 'bg-red-600', tagText: 'Subió el costo', btn: 'bg-red-600 border-red-800 hover:bg-red-700' };
      case 'cambio-fisico':
        return { card: 'border-amber-600 bg-amber-50', tag: 'bg-amber-600', tagText: 'Cambio físico', btn: 'bg-amber-600 border-amber-800 hover:bg-amber-700' };
      case 'auditoria':
        return { card: 'border-amber-600 bg-amber-50', tag: 'bg-amber-600', tagText: 'Auditoría', btn: 'bg-amber-600 border-amber-800 hover:bg-amber-700' };
      default:
        return { card: 'border-blue-500 bg-blue-50', tag: 'bg-blue-600', tagText: 'Por agotarse', btn: 'bg-blue-600 border-blue-800 hover:bg-blue-700' };
    }
  }
}
