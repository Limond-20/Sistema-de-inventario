import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./views/dashboard/dashboard-view.component').then((m) => m.DashboardViewComponent),
    title: 'Inicio · BinniStore',
  },
  {
    path: 'pos',
    loadComponent: () => import('./views/pos/pos-view.component').then((m) => m.PosViewComponent),
    title: 'Punto de Venta y Fiado · BinniStore',
  },
  {
    path: 'recepcion',
    loadComponent: () =>
      import('./views/reception/reception-view.component').then((m) => m.ReceptionViewComponent),
    canActivate: [authGuard],
    title: 'Recibir Mercancía · BinniStore',
  },
  {
    path: 'auditoria',
    loadComponent: () =>
      import('./views/audit-dictamen/audit-dictamen-view.component').then(
        (m) => m.AuditDictamenViewComponent
      ),
    canActivate: [authGuard],
    title: 'Auditoría Exprés de Pasillo · BinniStore',
  },
  {
    path: 'catalogo',
    loadComponent: () =>
      import('./views/catalog/catalog-view.component').then((m) => m.CatalogViewComponent),
    title: 'Catálogo y Precios · BinniStore',
  },
  {
    path: 'mermas',
    loadComponent: () =>
      import('./views/shrink/shrink-view.component').then((m) => m.ShrinkViewComponent),
    canActivate: [authGuard],
    title: 'Revisar Mermas · BinniStore',
  },
  {
    path: 'fefo',
    loadComponent: () => import('./views/fefo/fefo-view.component').then((m) => m.FefoViewComponent),
    canActivate: [authGuard],
    title: 'Caducidades y Cambio Físico · BinniStore',
  },
  {
    path: 'ajustes',
    loadComponent: () =>
      import('./views/settings/settings-view.component').then((m) => m.SettingsViewComponent),
    canActivate: [authGuard],
    title: 'Ajustes y Gestión de Usuarios · BinniStore',
  },
  {
    path: 'reportes',
    loadComponent: () =>
      import('./views/reports/reports-view.component').then((m) => m.ReportsViewComponent),
    canActivate: [authGuard],
    title: 'Reportes e Indicadores · BinniStore',
  },
  {
    path: 'licencia',
    loadComponent: () =>
      import('./views/license/license-view.component').then((m) => m.LicenseViewComponent),
    canActivate: [authGuard],
    title: 'Licencia y Vigencia · BinniStore',
  },
  {
    path: '**',
    loadComponent: () =>
      import('./views/not-found/not-found-view.component').then((m) => m.NotFoundViewComponent),
    title: 'Página no encontrada · BinniStore',
  },
];
