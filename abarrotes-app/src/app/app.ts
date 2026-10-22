import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  template: `
    <div class="min-h-screen bg-slate-100 text-slate-900 flex flex-col">
      <app-navbar />
      <main class="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1">
        <router-outlet />
      </main>
      <footer class="border-t border-slate-200/80 bg-white/70 py-3 px-6 text-center text-xs font-semibold text-slate-500 print:hidden">
        Abarrotes Doña Lupe · Sistema Híbrido POS + Inventario (Clasificación ABC · ROP · FEFO · Blindaje de Márgenes)
      </footer>
    </div>
  `,
})
export class App {}
