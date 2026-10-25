import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterModule } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MockInventoryService } from '../../services/mock-inventory.service';
import { LanSyncService } from '../../services/lan-sync.service';
import { IconComponent, IconName } from '../icon/icon.component';

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
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }
  return m;
}

@Component({
  selector: 'app-navbar',
  imports: [CommonModule, CurrencyPipe, DatePipe, RouterModule, RouterLink, IconComponent],
  templateUrl: './navbar.component.html',
})
export class NavbarComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  protected readonly lanSync = inject(LanSyncService);

  // ---------- Sincronización Celular (LanSync) ----------
  protected readonly isPhoneLinked = computed(() => {
    if (this.lanSync.isUnavailable()) {
      return this.inv.phoneLinked();
    }
    return this.lanSync.hasPhones();
  });

  protected readonly phoneButtonLabel = computed(() => {
    if (this.lanSync.isUnavailable()) {
      return this.inv.phoneLinked() ? 'Móvil Conectado (Demo)' : 'Móvil (QR) · Modo demostración';
    }
    if (this.lanSync.hasPhones()) {
      const c = this.lanSync.phones();
      return c > 1 ? `Móvil Conectado (${c})` : 'Móvil Conectado';
    }
    return 'Móvil (QR)';
  });

  protected readonly realPairingUrl = signal<string>('');
  protected readonly qrCacheBust = signal<number>(Date.now());
  protected readonly rotatingCode = signal<boolean>(false);
  private readonly router = inject(Router);

  // ---------- Reloj Digital en Vivo ----------
  protected readonly now = signal<Date>(new Date());
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  // ---------- Modales ----------
  protected readonly qrOpen = signal<boolean>(false);
  protected readonly closeShiftModalOpen = signal<boolean>(false);
  protected readonly shiftClosedSuccess = signal<boolean>(false);

  protected readonly qr = buildFakeQr();
  protected readonly mobileUrl = typeof window !== 'undefined' ? `${window.location.origin}/movil-prototipo.html` : '/movil-prototipo.html';

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  
    /** Opciones de la barra lateral (mismas pantallas que ya existían) */
  protected readonly navItems: {
    key: string;
    label: string;
    icon: IconName;
    link: string;
    query: Record<string, string> | null;
  }[] = [
    { key: 'inicio', label: 'Inicio', icon: 'home', link: '/', query: null },
    { key: 'pos', label: 'Punto de venta', icon: 'cart', link: '/pos', query: null },
    { key: 'recepcion', label: 'Recepción de mercancía', icon: 'inbox', link: '/recepcion', query: null },
    { key: 'auditoria', label: 'Auditoría de pasillo', icon: 'clipboard', link: '/auditoria', query: null },
    { key: 'fiados', label: 'Libreta de fiados', icon: 'book', link: '/pos', query: { tab: 'fiados' } },
    { key: 'catalogo', label: 'Catálogo y precios', icon: 'box', link: '/catalogo', query: null },
    { key: 'mermas', label: 'Mermas y consumos', icon: 'trash', link: '/mermas', query: null },
  ];

  protected isActive(key: string): boolean {
    const u = this.url() ?? '';
    switch (key) {
      case 'inicio':
        return u === '/' || u === '';
      case 'pos':
        return u.startsWith('/pos') && !u.includes('tab=fiados');
      case 'fiados':
        return u.startsWith('/pos') && u.includes('tab=fiados');
      case 'mermas':
        return u.startsWith('/mermas') || u.startsWith('/fefo');
      default:
        return u.startsWith('/' + key);
    }
  }

  ngOnInit(): void {
    this.clockTimer = setInterval(() => {
      this.now.set(new Date());
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  openQr(): void {
    this.qrOpen.set(true);
    if (!this.lanSync.isUnavailable()) {
      this.refreshPairingInfo();
    }
  }

  async refreshPairingInfo(): Promise<void> {
    const info = await this.lanSync.fetchPairingInfo();
    if (info) {
      this.realPairingUrl.set(info.url);
    }
  }

  async handleRotateCode(): Promise<void> {
    if (!window.confirm('Se desvincularán los celulares actuales y se generará un código nuevo. ¿Deseas continuar?')) {
      return;
    }
    this.rotatingCode.set(true);
    try {
      const info = await this.lanSync.rotatePairing();
      if (info) {
        this.realPairingUrl.set(info.url);
        this.qrCacheBust.set(Date.now());
      }
    } finally {
      this.rotatingCode.set(false);
    }
  }
  closeQr(): void {
    this.qrOpen.set(false);
  }
 

  openCloseShift(): void {
    this.shiftClosedSuccess.set(false);
    this.closeShiftModalOpen.set(true);
  }
  closeCloseShiftModal(): void {
    this.closeShiftModalOpen.set(false);
  }
  confirmCloseShift(): void {
    this.shiftClosedSuccess.set(true);
  }
}
