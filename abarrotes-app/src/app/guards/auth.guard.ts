import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { MockInventoryService } from '../services/mock-inventory.service';
import { canAccessRoute } from '../domain/auth';

/**
 * Route guard acoplado a la matriz de permisos por rol (Bloque G).
 * Si el usuario autenticado actual no tiene autorización para acceder a la ruta solicitada,
 * redirige automáticamente a la terminal de punto de venta (/pos).
 */
export const authGuard: CanActivateFn = (route, state) => {
  const inv = inject(MockInventoryService);
  const router = inject(Router);

  const currentUser = inv.currentUser();
  const currentRole = currentUser?.role || 'CAJERO';
  const targetPath = state.url || '';

  if (!canAccessRoute(currentRole, targetPath)) {
    return router.createUrlTree(['/pos']);
  }
  return true;
};
