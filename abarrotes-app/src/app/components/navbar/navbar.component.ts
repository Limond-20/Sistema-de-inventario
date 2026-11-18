import { Component, ElementRef, HostListener, OnDestroy, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterModule } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MockInventoryService } from '../../services/mock-inventory.service';
import { LanSyncService } from '../../services/lan-sync.service';
import { IconComponent, IconName } from '../icon/icon.component';
import { MIN_BACKUP_PASSPHRASE_LENGTH } from '../../domain/backup';
import { SATISFACTION_SCALE_OPTIONS } from '../../domain/reports';
import {
  formatUsbLastCopyLabel,
  parseUsbBackupStatus,
  usbBackupWarning,
  type UsbBackupStatus,
} from '../../domain/usb-backup';

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
  imports: [CommonModule, CurrencyPipe, DatePipe, FormsModule, RouterModule, RouterLink, IconComponent],
  templateUrl: './navbar.component.html',
})
export class NavbarComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  protected readonly lanSync = inject(LanSyncService);
  protected readonly satisfactionOptions = SATISFACTION_SCALE_OPTIONS;

  // ---------- Sincronización Celular (LanSync) ----------
  protected readonly isPhoneLinked = computed(() => {
    if (this.lanSync.isUnavailable()) {
      return this.inv.phoneLinked();
    }
    return this.lanSync.hasPhones();
  });

  protected readonly phoneButtonLabel = computed(() => {
    if (this.lanSync.isUnavailable()) {
      return this.inv.phoneLinked() ? 'Móvil Conectado' : 'Móvil (QR)';
    }
    if (this.lanSync.hasPhones()) {
      const c = this.lanSync.phones();
      return c > 1 ? `Móvil Conectado (${c})` : 'Móvil Conectado';
    }
    return 'Móvil (QR)';
  });

  protected readonly canCloseShiftGlobal = computed(() => {
    const role = this.inv.currentUser()?.role;
    return role !== 'CAJERO';
  });

  protected readonly canBackupGlobal = computed(() => {
    const role = this.inv.currentUser()?.role;
    return role !== 'CAJERO';
  });

  constructor() {
    effect(() => {
      if (this.inv.openBackupModalRequested()) {
        this.inv.openBackupModalRequested.set(false);
        this.openBackupModal();
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.qrOpen()) this.closeQr();
    if (this.closeShiftModalOpen()) this.closeCloseShiftModal();
    if (this.backupModalOpen()) this.closeBackupModal();
    if (this.resetDemoModalOpen()) this.closeResetDemoModal();
  }

  protected readonly availableIps = signal<string[]>([]);
  protected readonly selectedIp = signal<string>('');
  protected readonly forbiddenAccess = signal<boolean>(false);
  protected readonly realPairingUrl = signal<string>('');
  protected readonly qrCacheBust = signal<number>(Date.now());
  protected readonly rotatingCode = signal<boolean>(false);
  protected readonly confirmingRotateCode = signal<boolean>(false);

  protected readonly qrImageUrl = computed(() => {
    const ipParam = this.selectedIp() ? `&ip=${encodeURIComponent(this.selectedIp())}` : '';
    return `/api/pairing/qr.svg?nocache=${this.qrCacheBust()}${ipParam}`;
  });
  private readonly router = inject(Router);

  // ---------- Reloj Digital en Vivo ----------
  protected readonly now = signal<Date>(new Date());
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private usbTimer: ReturnType<typeof setInterval> | null = null;

  // ---------- Modales y Menú Lateral Desplegable ----------
  protected readonly navDrawerRef = viewChild<ElementRef<HTMLDialogElement>>('navDrawer');
  protected readonly drawerOpen = signal<boolean>(false);
  protected readonly qrOpen = signal<boolean>(false);
  protected readonly closeShiftModalOpen = signal<boolean>(false);
  protected readonly shiftClosedSuccess = signal<boolean>(false);

  openDrawer(): void {
    const dlg = this.navDrawerRef()?.nativeElement;
    this.drawerOpen.set(true);
    if (dlg && typeof dlg.showModal === 'function' && !dlg.open) {
      dlg.showModal();
    }
  }

  closeDrawer(): void {
    const dlg = this.navDrawerRef()?.nativeElement;
    this.drawerOpen.set(false);
    if (dlg && typeof dlg.close === 'function' && dlg.open) {
      dlg.close();
    }
  }

  onDrawerNativeClose(): void {
    this.drawerOpen.set(false);
  }

  onDrawerBackdropClick(event: MouseEvent): void {
    const dlg = this.navDrawerRef()?.nativeElement;
    if (dlg && event.target === dlg) {
      this.closeDrawer();
    }
  }

  protected readonly qr = buildFakeQr();
  protected readonly mobileUrl = typeof window !== 'undefined' ? `${window.location.origin}/movil-prototipo.html` : '/movil-prototipo.html';

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  
  /** Opciones del menú lateral (solo rutas que no están ya como tarjetas en Inicio) */
  protected readonly navItems: {
    key: string;
    label: string;
    icon: IconName;
    link: string;
    query: Record<string, string> | null;
  }[] = [
    { key: 'inicio', label: 'Inicio', icon: 'home', link: '/', query: null },
    { key: 'reportes', label: 'Reportes e indicadores', icon: 'chart', link: '/reportes', query: null },
    { key: 'ajustes', label: 'Ajustes y usuarios', icon: 'settings', link: '/ajustes', query: null },
    { key: 'licencia', label: 'Licencia', icon: 'shield', link: '/licencia', query: null },
  ];

  protected isActive(key: string): boolean {
    const u = this.url() ?? '';
    if (key === 'inicio') {
      return u === '/' || u === '';
    }
    return u.startsWith('/' + key);
  }

  ngOnInit(): void {
    this.clockTimer = setInterval(() => {
      this.now.set(new Date());
    }, 1000);
    // Copia a USB (Bloque L): consulta el estado a local-server al abrir y luego cada minuto.
    void this.refreshUsbStatus();
    this.usbTimer = setInterval(() => void this.refreshUsbStatus(), 60_000);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.usbTimer) {
      clearInterval(this.usbTimer);
      this.usbTimer = null;
    }
  }

  openQr(): void {
    this.confirmingRotateCode.set(false);
    this.qrOpen.set(true);
    if (!this.lanSync.isUnavailable()) {
      this.initPairingModal();
    }
  }

  async initPairingModal(): Promise<void> {
    const status = await this.lanSync.fetchStatus();
    if (status && Array.isArray(status.ips)) {
      this.availableIps.set(status.ips);
      if (status.ips.length > 0 && !status.ips.includes(this.selectedIp())) {
        this.selectedIp.set(status.ips[0]);
      }
    }
    await this.refreshPairingInfo();
  }

  async refreshPairingInfo(): Promise<void> {
    const res = await this.lanSync.fetchPairingInfo(this.selectedIp() || undefined);
    if (res.forbidden) {
      this.forbiddenAccess.set(true);
      return;
    }
    this.forbiddenAccess.set(false);
    if (res.ok && res.info) {
      this.realPairingUrl.set(res.info.url);
    }
  }

  onIpChange(ip: string): void {
    this.selectedIp.set(ip);
    this.qrCacheBust.set(Date.now());
    this.refreshPairingInfo();
  }

  requestRotateCode(): void {
    this.confirmingRotateCode.set(true);
  }

  cancelRotateCode(): void {
    this.confirmingRotateCode.set(false);
  }

  async handleRotateCode(): Promise<void> {
    this.confirmingRotateCode.set(false);
    this.rotatingCode.set(true);
    try {
      const info = await this.lanSync.rotatePairing();
      if (info) {
        this.qrCacheBust.set(Date.now());
        await this.refreshPairingInfo();
      }
    } finally {
      this.rotatingCode.set(false);
    }
  }
  closeQr(): void {
    this.confirmingRotateCode.set(false);
    this.qrOpen.set(false);
  }
 

  async onUserChange(targetUser: string, selectEl?: HTMLSelectElement): Promise<void> {
    if (!targetUser || targetUser === this.inv.activeUser()) return;
    if (targetUser === 'Administrador') {
      const pin = window.prompt('Ingrese el PIN de Administrador (mínimo 6 dígitos):');
      if (!pin) {
        if (selectEl) selectEl.value = this.inv.activeUser();
        return;
      }
      const res = await this.inv.setActiveUser('Administrador', pin);
      if (!res.success) {
        alert(res.message);
        if (selectEl) selectEl.value = this.inv.activeUser();
        return;
      }
    } else {
      await this.inv.setActiveUser(targetUser);
    }
  }

  openCloseShift(): void {
    this.shiftClosedSuccess.set(false);
    this.shiftBackupMessage.set(null);
    this.closeShiftError.set(null);
    this.lastSatisfactionSaved.set(false);
    this.closedShiftSummary.set(null);
    this.closeShiftSatisfactionRating.set(null);
    this.closeShiftSatisfactionComment.set('');
    this.physicalCashCounted.set(this.inv.getExpectedDrawerCash());
    this.shiftClosePin.set('');
    this.shiftCloseNotes.set('');
    this.closeShiftModalOpen.set(true);
  }
  closeCloseShiftModal(): void {
    this.closeShiftModalOpen.set(false);
  }
  async confirmCloseShift(): Promise<void> {
    this.closeShiftError.set(null);
    this.shiftBackupMessage.set(null);

    const phrase = this.closeShiftPassphrase().trim();
    if (!this.inv.hasSessionBackupPassphrase() && phrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
      const msg = 'Ingresa tu frase de respaldo (mínimo 8 caracteres) antes de cerrar el turno.';
      this.closeShiftError.set(msg);
      this.shiftBackupMessage.set(msg);
      return;
    }

    if (this.inv.isShiftOpen()) {
      const pin = this.shiftClosePin().trim();
      if (!pin) {
        const msg = 'Ingresa el PIN de Encargado o Administrador para cerrar el turno.';
        this.closeShiftError.set(msg);
        this.shiftBackupMessage.set(msg);
        return;
      }

      const satRating = this.closeShiftSatisfactionRating();
      const counted = Number(this.physicalCashCounted()) || 0;
      const previewStatusLabel = this.shiftCutSummary().statusLabel;
      const cutRes = await this.inv.closeShift({
        physicalCash: counted,
        pin,
        notes: this.shiftCloseNotes().trim() || undefined,
        satisfactionRating: satRating ?? undefined,
        satisfactionComment: this.closeShiftSatisfactionComment().trim() || undefined,
      });

      if (!cutRes.ok) {
        this.closeShiftError.set(cutRes.message);
        this.shiftBackupMessage.set(cutRes.message);
        return;
      }

      this.lastSatisfactionSaved.set(!!cutRes.satisfactionSaved);
      if (cutRes.record) {
        this.closedShiftSummary.set({
          physicalCash: cutRes.record.physicalCash,
          theoreticalCash: cutRes.record.theoreticalCash,
          statusLabel: previewStatusLabel,
        });
      }
    }

    const backupRes = await this.inv.closeShiftWithAutoBackup(phrase || undefined);
    if (!backupRes.ok) {
      this.closeShiftError.set(backupRes.message);
      this.shiftBackupMessage.set(backupRes.message);
      return;
    }

    this.closeShiftPassphrase.set('');
    this.shiftClosePin.set('');
    this.shiftCloseNotes.set('');
    if (backupRes.entry) {
      this.shiftBackupMessage.set(`Respaldo cifrado automático generado: ${backupRes.entry.nombre}`);
    }
    this.closeShiftSatisfactionRating.set(null);
    this.closeShiftSatisfactionComment.set('');
    this.shiftClosedSuccess.set(true);
  }

  // ---------- Respaldos Cifrados AES-GCM y Copia a USB (Bloque E) ----------
  protected readonly backupModalOpen = signal<boolean>(false);
  protected readonly backupPassphraseInput = signal<string>('');
  protected readonly backupFeedback = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly backupBusy = signal<boolean>(false);
  protected readonly pendingRestoreFilename = signal<string | null>(null);
  protected readonly restorePassphraseInput = signal<string>('');
  protected readonly closeShiftPassphrase = signal<string>('');
  protected readonly physicalCashCounted = signal<number>(0);
  protected readonly shiftClosePin = signal<string>('');
  protected readonly shiftCloseNotes = signal<string>('');
  protected readonly closeShiftError = signal<string | null>(null);
  protected readonly lastSatisfactionSaved = signal<boolean>(false);
  protected readonly closedShiftSummary = signal<{
    physicalCash: number;
    theoreticalCash: number;
    statusLabel: string;
  } | null>(null);
  protected readonly shiftCutSummary = computed(() =>
    this.inv.getShiftCutSummary(Number(this.physicalCashCounted()) || 0),
  );
  protected readonly shiftBackupMessage = signal<string | null>(null);
  protected readonly closeShiftSatisfactionRating = signal<number | null>(null);
  protected readonly closeShiftSatisfactionComment = signal<string>('');
  protected readonly selectedImportFile = signal<File | null>(null);
  protected readonly importPassphraseInput = signal<string>('');

  protected readonly relativeBackupLabel = computed(() => {
    const currentMs = this.now().getTime();
    return this.inv.getRelativeLastBackupLabel(currentMs);
  });

  // ---------- Copia a USB desde el servidor local (Bloque L) ----------
  /** null = el servidor no responde (por ejemplo con `ng serve`): se oculta la línea de USB. */
  protected readonly usbStatus = signal<UsbBackupStatus | null>(null);
  protected readonly usbLastCopyLabel = computed(() =>
    formatUsbLastCopyLabel(this.usbStatus()?.ultimaCopia, this.now().getTime()),
  );
  protected readonly usbWarning = computed(() => {
    const status = this.usbStatus();
    return status ? usbBackupWarning(status, this.now().getTime()) : null;
  });

  private async refreshUsbStatus(): Promise<void> {
    try {
      const res = await fetch('/api/usb/estado', { cache: 'no-store' });
      this.usbStatus.set(res.ok ? parseUsbBackupStatus(await res.json()) : null);
    } catch {
      this.usbStatus.set(null);
    }
  }

  openBackupModal(): void {
    this.backupFeedback.set(null);
    this.pendingRestoreFilename.set(null);
    this.restorePassphraseInput.set('');
    this.backupModalOpen.set(true);
    void this.inv.refreshBackupList();
  }

  closeBackupModal(): void {
    this.backupModalOpen.set(false);
    this.pendingRestoreFilename.set(null);
    this.restorePassphraseInput.set('');
    this.backupPassphraseInput.set('');
  }

  async handleQuickBackupNow(): Promise<void> {
    if (this.inv.hasSessionBackupPassphrase()) {
      this.backupBusy.set(true);
      try {
        const res = await this.inv.backupNow();
        this.backupFeedback.set({ ok: res.ok, text: res.message });
      } finally {
        this.backupBusy.set(false);
      }
      this.openBackupModal();
      return;
    }
    this.openBackupModal();
  }

  async submitBackupNow(): Promise<void> {
    const typed = this.backupPassphraseInput().trim();
    const resCheck = !this.inv.hasSessionBackupPassphrase()
      ? this.inv.setSessionBackupPassphrase(typed)
      : typed
        ? this.inv.setSessionBackupPassphrase(typed)
        : { valid: true };

    if (!resCheck.valid) {
      this.backupFeedback.set({
        ok: false,
        text: resCheck.message || 'La frase de respaldo debe tener al menos 8 caracteres.',
      });
      return;
    }

    this.backupBusy.set(true);
    try {
      const res = await this.inv.backupNow(typed || undefined);
      this.backupPassphraseInput.set('');
      this.backupFeedback.set({ ok: res.ok, text: res.message });
    } finally {
      this.backupBusy.set(false);
    }
  }

  requestRestoreConfirmation(filename: string): void {
    this.pendingRestoreFilename.set(filename);
    this.restorePassphraseInput.set('');
    this.backupFeedback.set(null);
  }

  cancelRestoreConfirmation(): void {
    this.pendingRestoreFilename.set(null);
    this.restorePassphraseInput.set('');
  }

  async confirmRestoreBackup(): Promise<void> {
    const filename = this.pendingRestoreFilename();
    if (!filename) return;
    const phrase = this.restorePassphraseInput().trim();
    if (phrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
      this.backupFeedback.set({
        ok: false,
        text: 'Ingresa la frase de respaldo (mínimo 8 caracteres) para descifrar y restaurar.',
      });
      return;
    }

    this.backupBusy.set(true);
    try {
      const res = await this.inv.restoreFromBackup(phrase, filename);
      this.restorePassphraseInput.set('');
      if (res.ok) {
        this.pendingRestoreFilename.set(null);
      }
      this.backupFeedback.set({ ok: res.ok, text: res.message });
    } finally {
      this.backupBusy.set(false);
    }
  }

  async handleCopyToUsb(filename?: string): Promise<void> {
    this.backupBusy.set(true);
    try {
      const res = await this.inv.copyBackupToUsbDrive(filename);
      this.backupFeedback.set({ ok: res.ok, text: res.message });
    } catch (err: any) {
      this.backupFeedback.set({
        ok: false,
        text: err?.message || 'No se pudo copiar el respaldo a la memoria USB.',
      });
    } finally {
      this.backupBusy.set(false);
    }
  }

  onImportFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files && input.files.length > 0 ? input.files[0] : null;
    this.selectedImportFile.set(file);
  }

  async handleImportAndRestoreBak(): Promise<void> {
    const file = this.selectedImportFile();
    if (!file) {
      this.backupFeedback.set({
        ok: false,
        text: 'Selecciona un archivo .bak desde disco o memoria USB.',
      });
      return;
    }
    const phrase = (this.importPassphraseInput().trim() || this.backupPassphraseInput().trim());
    if (phrase.length < MIN_BACKUP_PASSPHRASE_LENGTH && !this.inv.hasSessionBackupPassphrase()) {
      this.backupFeedback.set({
        ok: false,
        text: 'Ingresa la frase de respaldo (mínimo 8 caracteres) para descifrar el archivo .bak.',
      });
      return;
    }

    this.backupBusy.set(true);
    try {
      const buf = await file.arrayBuffer();
      const effectivePhrase = phrase || (this.inv as any).sessionBackupPassphrase || '';
      const res = await this.inv.importAndRestoreFromBakBytes(new Uint8Array(buf), effectivePhrase, file.name);
      if (res.ok) {
        this.selectedImportFile.set(null);
        this.importPassphraseInput.set('');
      }
      this.backupFeedback.set({ ok: res.ok, text: res.message });
    } finally {
      this.backupBusy.set(false);
    }
  }

  async handleUndoLastRestore(): Promise<void> {
    this.backupBusy.set(true);
    try {
      const res = await this.inv.undoLastRestore();
      this.backupFeedback.set({ ok: res.ok, text: res.message });
    } finally {
      this.backupBusy.set(false);
    }
  }

  // ---------- Restablecer Datos de Demostración (Bloque D) ----------
  protected readonly resetDemoModalOpen = signal<boolean>(false);
  protected readonly resetDemoSuccess = signal<boolean>(false);

  openResetDemoModal(): void {
    this.resetDemoSuccess.set(false);
    this.resetDemoModalOpen.set(true);
  }

  closeResetDemoModal(): void {
    this.resetDemoModalOpen.set(false);
    this.resetDemoSuccess.set(false);
  }

  async confirmResetDemo(): Promise<void> {
    await this.inv.resetToDemoData();
    this.resetDemoSuccess.set(true);
    setTimeout(() => {
      this.closeResetDemoModal();
    }, 1200);
  }
}
