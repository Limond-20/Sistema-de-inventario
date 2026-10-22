import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900">
      <app-navbar />
      <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <router-outlet />
      </main>
    </div>
  `,
})
export class App {}
