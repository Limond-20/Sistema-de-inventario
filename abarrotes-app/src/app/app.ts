import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  template: `
    <div class="h-screen w-screen flex flex-col bg-slate-900 overflow-hidden select-none">
      <!-- Barra de herramientas compacta de escritorio (h-12) -->
      <app-navbar />

      <!-- Área de trabajo de la terminal (sin scroll de ventana, fija en pantalla) -->
      <main class="flex-1 bg-slate-100 overflow-y-auto relative flex flex-col">
        <router-outlet />
      </main>
    </div>
  `,
})
export class App {}
