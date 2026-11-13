import { Routes } from '@angular/router';
import { DashboardViewComponent } from './views/dashboard/dashboard-view.component';
import { PosViewComponent } from './views/pos/pos-view.component';
import { ReceptionViewComponent } from './views/reception/reception-view.component';
import { AuditDictamenViewComponent } from './views/audit-dictamen/audit-dictamen-view.component';
import { CatalogViewComponent } from './views/catalog/catalog-view.component';
import { ShrinkViewComponent } from './views/shrink/shrink-view.component';
import { FefoViewComponent } from './views/fefo/fefo-view.component';
import { SettingsViewComponent } from './views/settings/settings-view.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', component: DashboardViewComponent, title: 'Inicio · Sistema de Inventario' },
  { path: 'pos', component: PosViewComponent, title: 'Punto de Venta y Fiado' },
  { path: 'recepcion', component: ReceptionViewComponent, canActivate: [authGuard], title: 'Recibir Mercancía' },
  { path: 'auditoria', component: AuditDictamenViewComponent, canActivate: [authGuard], title: 'Auditoría Exprés de Pasillo' },
  { path: 'catalogo', component: CatalogViewComponent, title: 'Catálogo ABC, ROP y Precios' },
  { path: 'mermas', component: ShrinkViewComponent, canActivate: [authGuard], title: 'Revisar Mermas' },
  { path: 'fefo', component: FefoViewComponent, canActivate: [authGuard], title: 'Caducidades y Cambio Físico (FEFO)' },
  { path: 'ajustes', component: SettingsViewComponent, canActivate: [authGuard], title: 'Ajustes y Gestión de Usuarios' },
  { path: '**', redirectTo: '' },
];
