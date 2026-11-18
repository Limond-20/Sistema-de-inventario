import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found-view',
  imports: [RouterLink],
  template: `
    <section
      class="mx-auto my-12 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs space-y-4"
      data-testid="not-found-view">
      <div class="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-700 text-xl font-bold">
        404
      </div>
      <h1 class="text-xl font-bold text-slate-900">Página no encontrada (404)</h1>
      <p class="text-sm text-slate-600">
        La dirección solicitada no existe o fue movida. Regresa a la pantalla principal para continuar.
      </p>
      <a
        routerLink="/"
        class="btn inline-flex h-11 items-center justify-center rounded-xl bg-brand-700 px-6 text-sm font-semibold text-white hover:bg-brand-800">
        Volver al Inicio
      </a>
    </section>
  `,
})
export class NotFoundViewComponent {}
