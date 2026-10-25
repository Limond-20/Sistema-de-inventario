import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  template: `
    <div class="h-screen w-screen flex bg-slate-100 overflow-hidden select-none">
      <!-- Barra lateral fija -->
      <app-navbar />

      <!-- Área de trabajo con márgenes; solo esta zona se desplaza si el contenido es largo -->
      <main class="flex-1 min-w-0 overflow-y-auto">
        <div class="px-10 py-8 max-w-[1440px] mx-auto">
          <router-outlet />
        </div>
      </main>
    </div>
  `,
})
export class App {}