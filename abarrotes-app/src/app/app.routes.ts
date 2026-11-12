import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./views/dashboard/dashboard-view.component').then((m) => m.DashboardViewComponent),
    title: 'Inicio · Sistema de Inventario',
  },
  {
    path: 'pos',
    loadComponent: () => import('./views/pos/pos-view.component').then((m) => m.PosViewComponent),
    title: 'Punto de Venta y Fiado',
  },
  {
    path: 'recepcion',
    loadComponent: () =>
      import('./views/reception/reception-view.component').then((m) => m.ReceptionViewComponent),
    canActivate: [authGuard],
    title: 'Recibir Mercancía',
  },
  {
    path: 'auditoria',
    loadComponent: () =>
      import('./views/audit-dictamen/audit-dictamen-view.component').then(
        (m) => m.AuditDictamenViewComponent
      ),
    canActivate: [authGuard],
    title: 'Auditoría Exprés de Pasillo',
  },
  {
    path: 'catalogo',
    loadComponent: () =>
      import('./views/catalog/catalog-view.component').then((m) => m.CatalogViewComponent),
    title: 'Catálogo ABC, ROP y Precios',
  },
  {
    path: 'mermas',
    loadComponent: () =>
      import('./views/shrink/shrink-view.component').then((m) => m.ShrinkViewComponent),
    canActivate: [authGuard],
    title: 'Revisar Mermas',
  },
  {
    path: 'fefo',
    loadComponent: () => import('./views/fefo/fefo-view.component').then((m) => m.FefoViewComponent),
    canActivate: [authGuard],
    title: 'Caducidades y Cambio Físico (FEFO)',
  },
  {
    path: 'ajustes',
    loadComponent: () =>
      import('./views/settings/settings-view.component').then((m) => m.SettingsViewComponent),
    canActivate: [authGuard],
    title: 'Ajustes y Gestión de Usuarios',
  },
  { path: '**', redirectTo: '' },
];
