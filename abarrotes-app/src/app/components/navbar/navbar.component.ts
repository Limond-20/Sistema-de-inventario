import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MockInventoryService } from '../../services/mock-inventory.service';

/** Genera una matriz tipo QR (simulada) con los 3 cuadros de posición reales. */
function buildFakeQr(size = 29, seed = 20931): boolean[][] {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const m: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => rnd() > 0.52));
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (border || core);
      }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0; }
  return m;
}

@Component({
  selector: 'app-navbar',
  imports: [RouterLink],
  templateUrl: './navbar.component.html',
})
export class NavbarComponent {
  protected readonly inv = inject(MockInventoryService);
  private readonly router = inject(Router);

  protected readonly qrOpen = signal(false);
  protected readonly qr = buildFakeQr();
  protected readonly mobileUrl = `${location.origin}/movil-prototipo.html`;

  private readonly url = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => (e as NavigationEnd).urlAfterRedirects)),
    { initialValue: this.router.url },
  );
  protected readonly isHome = computed(() => this.url() === '/' || this.url() === '');

  openQr() { this.qrOpen.set(true); }
  closeQr() { this.qrOpen.set(false); }
  simulateLink() {
    this.inv.phoneLinked.set(true);
    this.qrOpen.set(false);
  }
}
