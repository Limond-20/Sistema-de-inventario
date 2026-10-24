import { Routes } from '@angular/router';
import { DashboardViewComponent } from './views/dashboard/dashboard-view.component';
import { PosViewComponent } from './views/pos/pos-view.component';
import { ReceptionViewComponent } from './views/reception/reception-view.component';
import { AuditDictamenViewComponent } from './views/audit-dictamen/audit-dictamen-view.component';
import { CatalogViewComponent } from './views/catalog/catalog-view.component';
import { ShrinkViewComponent } from './views/shrink/shrink-view.component';
import { FefoViewComponent } from './views/fefo/fefo-view.component';

export const routes: Routes = [
  { path: '', component: DashboardViewComponent, title: 'Inicio · Abarrotes Doña Lupe' },
  { path: 'pos', component: PosViewComponent, title: 'Punto de Venta y Fiado · Abarrotes Doña Lupe' },
  { path: 'recepcion', component: ReceptionViewComponent, title: 'Recibir Mercancía' },
  { path: 'auditoria', component: AuditDictamenViewComponent, title: 'Auditoría Exprés de Pasillo' },
  { path: 'catalogo', component: CatalogViewComponent, title: 'Catálogo ABC, ROP y Precios' },
  { path: 'mermas', component: ShrinkViewComponent, title: 'Revisar Mermas' },
  { path: 'fefo', component: FefoViewComponent, title: 'Caducidades y Cambio Físico (FEFO)' },
  { path: '**', redirectTo: '' },
];
