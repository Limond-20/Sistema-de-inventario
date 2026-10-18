import { Routes } from '@angular/router';
import { DashboardViewComponent } from './views/dashboard/dashboard-view.component';
import { ReceptionViewComponent } from './views/reception/reception-view.component';
import { AuditDictamenViewComponent } from './views/audit-dictamen/audit-dictamen-view.component';
import { CatalogViewComponent } from './views/catalog/catalog-view.component';
import { ShrinkViewComponent } from './views/shrink/shrink-view.component';

export const routes: Routes = [
  { path: '', component: DashboardViewComponent, title: 'Inicio · Abarrotes Doña Lupe' },
  { path: 'recepcion', component: ReceptionViewComponent, title: 'Recibir Mercancía' },
  { path: 'auditoria', component: AuditDictamenViewComponent, title: 'Auditoría Exprés de Pasillo' },
  { path: 'catalogo', component: CatalogViewComponent, title: 'Catálogo y Precios' },
  { path: 'mermas', component: ShrinkViewComponent, title: 'Revisar Mermas' },
  { path: '**', redirectTo: '' },
];
