import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterOutlet, Router, RouterLink } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';
import { IconComponent } from './components/icon/icon.component';
import { MockInventoryService } from './services/mock-inventory.service';
import { canAccessRoute } from './domain/auth';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, RouterOutlet, RouterLink, NavbarComponent, IconComponent],
  template: `
    @if (!inv.isHydrated() && inv.storageNeedsUnlock()) {
      <!-- =====================================================================
           BLOQUE K: DESBLOQUEO / CONFIGURACIÓN DEL CIFRADO EN REPOSO AL INICIAR
           ===================================================================== -->
      <div class="h-screen w-screen overflow-y-auto flex items-center justify-center bg-brand-800 p-6 select-none" data-testid="storage-unlock-screen">
        <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-7 text-white shadow-2xl space-y-5">
          <div class="text-center space-y-2">
            <div class="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/15 text-amber-400 shadow-md mb-3"
              style="background: linear-gradient(145deg, #0e4a57 0%, #072b33 100%);">
              <app-icon [name]="recoveryMode() ? 'shield' : 'logo'" [size]="26" />
            </div>
            <p class="text-xs font-bold tracking-wide text-amber-400">BinniStore</p>
            <h1 class="text-xl font-bold tracking-tight">
              @if (recoveryMode()) {
                Recuperar con un respaldo
              } @else if (inv.storageCryptoStatus() === 'setup-new') {
                Crea el PIN del administrador
              } @else if (inv.storageCryptoStatus() === 'setup-migrate') {
                Protege los datos guardados
              } @else {
                Datos de la tienda cifrados
              }
            </h1>
            @if (!recoveryMode()) {
              <p class="text-xs text-slate-300 leading-relaxed">{{ inv.storageCryptoMessage() }}</p>
            }
          </div>

          @if (storageError()) {
            <div class="rounded-xl border border-rose-400/40 bg-rose-500/15 p-3 text-xs font-bold text-rose-200 text-center" data-testid="storage-unlock-error">
              {{ storageError() }}
            </div>
          }
          @if (storageInfo()) {
            <div class="rounded-xl border border-emerald-400/40 bg-emerald-500/15 p-3 text-xs font-semibold text-emerald-100 text-center">
              {{ storageInfo() }}
            </div>
          }

          @if (!recoveryMode()) {
            <div class="space-y-3">
              <label class="block space-y-1.5">
                <span class="block text-xs font-semibold text-slate-300">
                  {{ inv.storageCryptoStatus() === 'setup-new' ? 'PIN nuevo de administrador (mínimo 6 dígitos; mejor 8 o más)' : 'PIN de administrador' }}
                </span>
                <input type="password" inputmode="numeric" autocomplete="off" placeholder="••••••"
                  [ngModel]="storagePin()" (ngModelChange)="storagePin.set($event)" (keydown.enter)="submitStoragePin()"
                  data-testid="storage-unlock-pin"
                  class="h-11 w-full text-center text-xl tracking-widest font-mono rounded-xl border border-slate-700 bg-slate-800 px-3 font-bold text-white focus:border-amber-400 focus:outline-none" />
              </label>
              @if (inv.storageCryptoStatus() === 'setup-new') {
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">Repite el PIN</span>
                  <input type="password" inputmode="numeric" autocomplete="off" placeholder="••••••"
                    [ngModel]="storagePinConfirm()" (ngModelChange)="storagePinConfirm.set($event)" (keydown.enter)="submitStoragePin()"
                    data-testid="storage-unlock-pin-confirm"
                    class="h-11 w-full text-center text-xl tracking-widest font-mono rounded-xl border border-slate-700 bg-slate-800 px-3 font-bold text-white focus:border-amber-400 focus:outline-none" />
                </label>
              }
              <button type="button" [disabled]="storageBusy()" (click)="submitStoragePin()" data-testid="btn-storage-unlock"
                class="h-11 w-full rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-900 font-bold text-sm transition-colors shadow-xs">
                @if (storageBusy()) {
                  Verificando…
                } @else if (inv.storageCryptoStatus() === 'setup-new') {
                  Crear PIN y cifrar
                } @else if (inv.storageCryptoStatus() === 'setup-migrate') {
                  Cifrar datos y continuar
                } @else {
                  Abrir datos
                }
              </button>
              @if (inv.storageCryptoStatus() !== 'setup-new') {
                <button type="button" (click)="openRecovery()" data-testid="btn-storage-forgot-pin"
                  class="w-full text-xs font-semibold text-amber-300 hover:text-amber-200 underline underline-offset-2">
                  ¿Olvidaste el PIN? Recuperar desde un respaldo (.bak)
                </button>
              }
              <p class="text-[11px] text-slate-400 leading-relaxed">
                Los datos se guardan protegidos bajo llave en esta computadora y solo se abren con el PIN de un administrador.
                Si se olvida el PIN no hay forma de abrirlos: la única recuperación es un respaldo .bak y su frase.
              </p>
            </div>
          } @else {
            <div class="space-y-3" data-testid="storage-recovery-panel">
              @if (recoveryAdmins().length === 0) {
                <p class="text-xs text-slate-300 leading-relaxed">
                  Elige el respaldo cifrado (.bak) y escribe su frase de respaldo. Se verificará antes de cambiar cualquier cosa.
                </p>
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">Archivo .bak (disco o memoria USB)</span>
                  <input type="file" accept=".bak" (change)="onRecoveryFile($event)" data-testid="storage-recovery-file"
                    class="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-xs file:font-bold file:text-white" />
                </label>
                @if (inv.backupList().length > 0) {
                  <label class="block space-y-1.5">
                    <span class="block text-xs font-semibold text-slate-300">…o un respaldo del servidor local</span>
                    <select [ngModel]="recoveryServerFile()" (ngModelChange)="recoveryServerFile.set($event)"
                      class="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-sm text-white">
                      <option value="">— Ninguno —</option>
                      @for (b of inv.backupList(); track b.nombre) {
                        <option [value]="b.nombre">{{ b.nombre }}</option>
                      }
                    </select>
                  </label>
                }
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">Frase de respaldo</span>
                  <input type="password" autocomplete="off" [ngModel]="recoveryPassphrase()" (ngModelChange)="recoveryPassphrase.set($event)"
                    data-testid="storage-recovery-passphrase"
                    class="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-sm text-white focus:border-amber-400 focus:outline-none" />
                </label>
                <button type="button" [disabled]="storageBusy()" (click)="verifyRecoveryBackup()" data-testid="btn-storage-recovery-verify"
                  class="h-11 w-full rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-900 font-bold text-sm">
                  {{ storageBusy() ? 'Verificando respaldo…' : 'Verificar respaldo' }}
                </button>
              } @else {
                <div class="rounded-xl border border-amber-300/40 bg-amber-400/10 p-3 text-xs text-amber-100 leading-relaxed">
                  Respaldo válido del {{ recoveryBackupDate() }}. Al continuar se <b>borran los datos cifrados con el PIN olvidado</b>
                  en este equipo y se cargan los del respaldo; los movimientos posteriores al respaldo no se recuperan.
                </div>
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">Administrador</span>
                  <select [ngModel]="recoveryAdminId()" (ngModelChange)="recoveryAdminId.set($event)"
                    class="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-sm text-white">
                    @for (a of recoveryAdmins(); track a.id) {
                      <option [value]="a.id">{{ a.name }}</option>
                    }
                  </select>
                </label>
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">PIN nuevo</span>
                  <input type="password" inputmode="numeric" autocomplete="off" [ngModel]="storagePin()" (ngModelChange)="storagePin.set($event)"
                    data-testid="storage-recovery-new-pin"
                    class="h-11 w-full text-center text-xl tracking-widest font-mono rounded-xl border border-slate-700 bg-slate-800 px-3 font-bold text-white" />
                </label>
                <label class="block space-y-1.5">
                  <span class="block text-xs font-semibold text-slate-300">Repite el PIN nuevo</span>
                  <input type="password" inputmode="numeric" autocomplete="off" [ngModel]="storagePinConfirm()" (ngModelChange)="storagePinConfirm.set($event)"
                    class="h-11 w-full text-center text-xl tracking-widest font-mono rounded-xl border border-slate-700 bg-slate-800 px-3 font-bold text-white" />
                </label>
                <button type="button" [disabled]="storageBusy()" (click)="completeRecovery()" data-testid="btn-storage-recovery-complete"
                  class="h-11 w-full rounded-xl bg-rose-500 hover:bg-rose-400 disabled:opacity-60 text-white font-bold text-sm">
                  {{ storageBusy() ? 'Recuperando…' : 'Borrar datos bloqueados y restaurar respaldo' }}
                </button>
              }
              <button type="button" (click)="closeRecovery()" class="w-full text-xs font-semibold text-slate-300 hover:text-white underline underline-offset-2">
                Volver
              </button>
            </div>
          }
        </div>
      </div>
    } @else if (!inv.isHydrated()) {
      <!-- Pantalla de carga durante la hidratación desde IndexedDB -->
      <div class="h-screen w-screen flex flex-col items-center justify-center bg-brand-800 text-white select-none p-8" data-testid="hydration-loading-screen">
        <div class="h-16 w-16 rounded-2xl border border-white/15 text-amber-400 grid place-items-center shadow-md mb-4"
          style="background: linear-gradient(145deg, #0e4a57 0%, #072b33 100%);">
          <app-icon name="logo" [size]="30" />
        </div>
        <h1 class="font-display text-2xl font-bold">BinniStore · Cargando datos de la tienda…</h1>
        <p class="text-sm text-brand-200 mt-1.5">Verificando historial de movimientos y existencias por producto</p>
      </div>
    } @else {
      <div class="h-screen w-screen flex flex-col bg-slate-100 overflow-hidden select-none print-shell print:h-auto print:w-full print:overflow-visible print:bg-white print:block">
        <!-- Cabecera superior compacta y menú lateral desplegable -->
        <app-navbar class="print:hidden no-print shrink-0" />

        <!-- Área de trabajo con todo el ancho disponible -->
        <main class="flex-1 min-w-0 overflow-y-auto flex flex-col print:overflow-visible print:h-auto print:block">
          @if (inv.isReadOnlyMode()) {
            <div class="border-b border-amber-300 bg-amber-50 text-slate-900 px-6 py-3 text-sm font-semibold flex items-center justify-between gap-4 shrink-0 print:hidden no-print" role="alert" data-testid="readonly-warning-banner">
              <div class="flex items-center gap-2.5 text-amber-900">
                <app-icon name="lock" [size]="18" />
                <span>{{ inv.readOnlyWarning() || 'Esta app ya está abierta en otra ventana' }} · Modo solo lectura</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                @if (inv.isLicenseReadOnly()) {
                  <a routerLink="/licencia" data-testid="link-license-from-readonly" class="rounded-full border border-brand-600 bg-brand-700 px-3 py-0.5 text-xs font-bold text-white hover:bg-brand-800">
                    Ir a Licencia
                  </a>
                }
                <span class="rounded-full border border-amber-300 bg-amber-100 px-3 py-0.5 text-xs font-bold text-amber-900">Solo lectura</span>
              </div>
            </div>
          } @else if (inv.licenseWarningBanner()) {
            <div class="border-b border-amber-300 bg-amber-50 text-slate-900 px-6 py-2.5 text-xs font-semibold flex items-center justify-between gap-4 shrink-0 print:hidden no-print" role="status" data-testid="license-expiry-warning-banner">
              <div class="flex items-center gap-2 text-amber-950">
                <app-icon name="shield" [size]="16" />
                <span>{{ inv.licenseWarningBanner() }}</span>
              </div>
              <a routerLink="/licencia" data-testid="link-license-from-warning" class="shrink-0 rounded-lg border border-amber-400 bg-white px-3 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100">
                Renovar licencia
              </a>
            </div>
          }

          @if (inv.isBackupOlderThan24h()) {
            <div class="border-b border-amber-200 bg-amber-50/80 text-slate-900 px-6 py-2.5 text-xs font-semibold flex items-center justify-between gap-3 shrink-0 print:hidden no-print" role="status" data-testid="stale-backup-banner">
              <div class="flex items-center gap-2 text-amber-900">
                <app-icon name="alert" [size]="16" />
                <span>El último respaldo cifrado tiene más de 24 horas (o aún no se ha realizado). Ingresa tu frase de respaldo para proteger la tienda.</span>
              </div>
              <div class="flex items-center gap-3 shrink-0">
                <span class="text-amber-800 tabular-nums">{{ inv.getRelativeLastBackupLabel() }}</span>
                <button type="button" (click)="inv.openBackupModalRequested.set(true)" data-testid="btn-backup-from-stale-banner"
                  class="rounded-lg border border-amber-400 bg-white px-3 py-1 text-xs font-bold text-amber-950 hover:bg-amber-100">
                  Respaldar ahora
                </button>
              </div>
            </div>
          }

          @if (inv.accessDeniedBanner(); as deniedMsg) {
            <div class="border-b border-rose-200 bg-rose-50 text-rose-950 px-6 py-2.5 text-xs font-bold flex items-center justify-between gap-3 shrink-0 print:hidden no-print" role="alert" data-testid="access-denied-banner">
              <div class="flex items-center gap-2">
                <app-icon name="lock" [size]="15" />
                <span>{{ deniedMsg }}</span>
              </div>
              <button type="button" (click)="inv.clearAccessDenied()" class="text-xs underline font-semibold shrink-0 hover:text-rose-700">
                Cerrar aviso
              </button>
            </div>
          }

          <div class="px-6 py-5 max-w-[1600px] w-full mx-auto flex-1 print:p-0 print:max-w-none">
            <router-outlet />
          </div>
        </main>
      </div>

      <!-- =====================================================================
           PANTALLA DE BLOQUEO / INICIO DE SESIÓN POR PIN (BLOQUE G)
           ===================================================================== -->
      @if (inv.isSessionLocked()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-xs p-4 select-none"
          role="dialog" aria-modal="true" data-testid="lock-screen-modal">
          <div class="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 p-7 text-white shadow-2xl space-y-5">
            <div class="text-center space-y-2">
              <div class="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-400 text-slate-900 shadow-xs mb-3">
                <app-icon name="lock" [size]="24" />
              </div>
              <h2 class="text-xl font-bold tracking-tight">Terminal Bloqueada</h2>
              <p class="text-xs text-slate-400">
                {{ inv.businessSettings().storeName }} · BinniStore · Ingresa tu PIN personal para continuar
              </p>
            </div>

            @if (unlockError()) {
              <div class="rounded-xl border border-rose-400/40 bg-rose-500/15 p-3 text-xs font-bold text-rose-200 text-center"
                data-testid="lock-screen-error">
                {{ unlockError() }}
              </div>
            }

            <div class="space-y-4">
              <!-- Selección de usuario -->
              <div class="space-y-1.5">
                <label for="lock-select-user" class="block text-xs font-semibold text-slate-300">
                  Usuario
                </label>
                <select
                  id="lock-select-user"
                  [ngModel]="selectedUserId()"
                  (ngModelChange)="selectedUserId.set($event)"
                  data-testid="lock-select-user"
                  class="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-sm font-semibold text-white focus:border-amber-400 focus:outline-none">
                  @for (user of activeUsersList(); track user.id) {
                    <option [value]="user.id">{{ user.name }}{{ user.lockedUntil ? ' (Bloqueado temporalmente)' : '' }}</option>
                  }
                </select>
              </div>

              <!-- Entrada de PIN -->
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <label for="lock-input-pin" class="block text-xs font-semibold text-slate-300">
                    PIN de Acceso
                  </label>
                  <button type="button" (click)="showUnlockPin.set(!showUnlockPin())"
                    class="text-xs font-semibold text-amber-300 hover:text-amber-200 underline">
                    {{ showUnlockPin() ? 'Ocultar PIN' : 'Mostrar PIN' }}
                  </button>
                </div>
                <input
                  id="lock-input-pin"
                  [type]="showUnlockPin() ? 'text' : 'password'"
                  autofocus
                  maxlength="32"
                  pattern="[0-9]*"
                  inputmode="numeric"
                  placeholder="••••••"
                  [ngModel]="unlockPin()"
                  (ngModelChange)="unlockPin.set($event)"
                  (keydown.enter)="submitUnlock()"
                  data-testid="lock-input-pin"
                  class="h-11 w-full text-center text-xl tracking-widest font-mono rounded-xl border border-slate-700 bg-slate-800 px-3 font-bold text-white focus:border-amber-400 focus:outline-none" />
              </div>

              <button
                type="button"
                [disabled]="isSubmittingUnlock()"
                (click)="submitUnlock()"
                data-testid="btn-submit-unlock"
                class="h-11 w-full rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-900 font-bold text-sm transition-colors shadow-xs flex items-center justify-center gap-2">
                @if (isSubmittingUnlock()) {
                  <span>Verificando credenciales…</span>
                } @else {
                  <span>Desbloquear</span>
                }
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Modal de Datos Dañados o Discrepancia de Continuidad (NO sobrescribe automáticamente) -->
      @if (inv.corruptedModalOpen()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-6" role="dialog" aria-modal="true" data-testid="corrupted-data-modal">
          <div class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
            <div class="flex items-center justify-between border-b border-slate-200 px-7 py-5">
              <div class="flex items-center gap-3">
                <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-[#a33f3f]">
                  <app-icon name="alert" [size]="20" />
                </span>
                <div>
                  <h2 class="text-xl font-bold text-slate-900">Datos guardados dañados o alterados</h2>
                  <p class="text-xs font-semibold text-slate-500 mt-0.5">
                    El autoguardado ha sido bloqueado para no sobrescribir tu información original.
                  </p>
                </div>
              </div>
            </div>

            <div class="p-7 space-y-4">
              <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                <p class="font-semibold text-slate-900 mb-1">Diagnóstico de integridad:</p>
                <p class="text-slate-700">{{ inv.corruptedDataWarning() }}</p>
                @if (inv.corruptedBackupKey()) {
                  <p class="mt-2 text-xs text-slate-600 tabular-nums">
                    Copia de resguardo: <b class="text-slate-900">{{ inv.corruptedBackupKey() }}</b> (se conservan las 3 más recientes)
                  </p>
                }
              </div>

              @if (inv.corruptedAffectedSkus().length > 0) {
                <div class="rounded-xl border border-rose-200 bg-rose-50/70 p-4">
                  <p class="text-xs font-bold text-slate-800 mb-2">
                    Productos con diferencia entre existencias e historial:
                  </p>
                  <div class="flex flex-wrap gap-2">
                    @for (sku of inv.corruptedAffectedSkus(); track sku) {
                      <span class="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs font-bold text-[#a33f3f] tabular-nums">
                        {{ sku }}
                      </span>
                    }
                  </div>
                </div>
              }

              @if (!inv.corruptedConfirmOverwrite()) {
                <div class="pt-2 flex flex-wrap items-center justify-end gap-3">
                  <button
                    type="button"
                    (click)="inv.downloadCorruptedDataJson()"
                    class="flex h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    data-testid="btn-download-corrupted">
                    <app-icon name="download" [size]="16" />
                    <span>Descargar datos dañados (JSON)</span>
                  </button>
                  <button
                    type="button"
                    (click)="inv.retryRestorePersistedState()"
                    class="h-11 rounded-xl border border-slate-300 bg-slate-50 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-100"
                    data-testid="btn-retry-corrupted">
                    Reintentar
                  </button>
                  <button
                    type="button"
                    (click)="inv.requestStartCleanStoreConfirmation()"
                    class="h-11 rounded-xl bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800"
                    data-testid="btn-start-clean-request">
                    Reiniciar tienda en blanco
                  </button>
                </div>
              } @else {
                <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3" data-testid="confirm-overwrite-box">
                  <p class="text-sm font-bold text-slate-900">
                    ¿Confirmas reiniciar el estado de la tienda en blanco?
                  </p>
                  <p class="text-xs text-slate-700">
                    La copia del dato dañado seguirá resguardada en <b>{{ inv.corruptedBackupKey() }}</b>, pero el catálogo y registros activos iniciarán vacíos.
                  </p>
                  <div class="flex justify-end gap-3">
                    <button
                      type="button"
                      (click)="inv.cancelStartCleanStoreConfirmation()"
                      class="h-10 rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                      Cancelar
                    </button>
                    <button
                      type="button"
                      (click)="inv.confirmStartCleanStore()"
                      class="h-10 rounded-xl bg-[#a33f3f] px-5 text-xs font-semibold text-white hover:bg-[#8c3434]"
                      data-testid="btn-confirm-clean-overwrite">
                      Confirmar y reiniciar en blanco
                    </button>
                  </div>
                </div>
              }
            </div>
          </div>
        </div>
      }
    }
  `,
})
export class App implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  protected readonly router = inject(Router);

  // ---------- Control de Desbloqueo / Login ----------
  protected readonly selectedUserId = signal<string>('');
  protected readonly unlockPin = signal<string>('');
  protected readonly showUnlockPin = signal<boolean>(false);
  protected readonly unlockError = signal<string>('');
  protected readonly isSubmittingUnlock = signal<boolean>(false);

  protected readonly activeUsersList = () => this.inv.users().filter((u) => u.isActive);

  // ---------- Bloque K: desbloqueo del cifrado en reposo y recuperación por respaldo ----------
  protected readonly storagePin = signal<string>('');
  protected readonly storagePinConfirm = signal<string>('');
  protected readonly storageError = signal<string>('');
  protected readonly storageInfo = signal<string>('');
  protected readonly storageBusy = signal<boolean>(false);
  protected readonly recoveryMode = signal<boolean>(false);
  protected readonly recoveryPassphrase = signal<string>('');
  protected readonly recoveryServerFile = signal<string>('');
  protected readonly recoveryAdmins = signal<Array<{ id: string; name: string }>>([]);
  protected readonly recoveryAdminId = signal<string>('');
  protected readonly recoveryBackupDate = signal<string>('');
  private recoveryFileBytes: Uint8Array | null = null;

  async submitStoragePin(): Promise<void> {
    if (this.storageBusy()) return;
    this.storageError.set('');
    this.storageInfo.set('');
    const pin = this.storagePin().trim();
    if (!pin) {
      this.storageError.set('Ingresa el PIN de administrador.');
      return;
    }
    this.storageBusy.set(true);
    try {
      const status = this.inv.storageCryptoStatus();
      const res =
        status === 'locked'
          ? await this.inv.unlockEncryptedStorage(pin)
          : await this.inv.setupEncryptedStorage(pin, status === 'setup-new' ? this.storagePinConfirm() : undefined);
      if (!res.ok) {
        this.storageError.set(res.message);
      } else {
        this.storagePin.set('');
        this.storagePinConfirm.set('');
      }
    } finally {
      this.storageBusy.set(false);
    }
  }

  openRecovery(): void {
    this.storageError.set('');
    this.storageInfo.set('');
    this.storagePin.set('');
    this.storagePinConfirm.set('');
    this.recoveryMode.set(true);
  }

  closeRecovery(): void {
    this.inv.cancelEncryptedStorageRecovery();
    this.recoveryMode.set(false);
    this.recoveryAdmins.set([]);
    this.recoveryPassphrase.set('');
    this.recoveryServerFile.set('');
    this.recoveryFileBytes = null;
    this.storageError.set('');
  }

  async onRecoveryFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement)?.files?.[0];
    this.recoveryFileBytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
  }

  async verifyRecoveryBackup(): Promise<void> {
    this.storageError.set('');
    if (!this.recoveryFileBytes && !this.recoveryServerFile()) {
      this.storageError.set('Elige un archivo .bak o un respaldo del servidor.');
      return;
    }
    this.storageBusy.set(true);
    try {
      const res = await this.inv.beginEncryptedStorageRecovery({
        passphrase: this.recoveryPassphrase(),
        bakBytes: this.recoveryFileBytes ?? undefined,
        serverFilename: this.recoveryFileBytes ? undefined : this.recoveryServerFile(),
      });
      if (!res.ok || !res.admins) {
        this.storageError.set(res.message);
        return;
      }
      this.recoveryAdmins.set(res.admins);
      this.recoveryAdminId.set(res.admins[0].id);
      this.recoveryBackupDate.set(res.backupTimestamp ? new Date(res.backupTimestamp).toLocaleString('es-MX') : '');
      this.storageInfo.set(res.message);
    } finally {
      this.storageBusy.set(false);
    }
  }

  async completeRecovery(): Promise<void> {
    this.storageError.set('');
    this.storageBusy.set(true);
    try {
      const res = await this.inv.completeEncryptedStorageRecovery(
        this.recoveryAdminId(),
        this.storagePin(),
        this.storagePinConfirm()
      );
      if (!res.ok) {
        this.storageError.set(res.message);
        return;
      }
      this.storagePin.set('');
      this.storagePinConfirm.set('');
      this.recoveryMode.set(false);
      this.recoveryAdmins.set([]);
      this.recoveryFileBytes = null;
    } finally {
      this.storageBusy.set(false);
    }
  }

  ngOnInit(): void {
    this.inv.initInactivityListener();
    const current = this.inv.currentUser();
    if (current) {
      this.selectedUserId.set(current.id);
    } else if (this.inv.users().length > 0) {
      this.selectedUserId.set(this.inv.users()[0].id);
    }
  }

  ngOnDestroy(): void {
    this.inv.teardownInactivityListener();
  }

  async submitUnlock(): Promise<void> {
    this.unlockError.set('');
    const uid = this.selectedUserId() || this.inv.currentUser()?.id || (this.inv.users()[0]?.id ?? '');
    const pin = this.unlockPin().trim();

    if (!pin) {
      this.unlockError.set('Ingresa tu PIN de acceso.');
      return;
    }

    this.isSubmittingUnlock.set(true);
    try {
      const res = await this.inv.loginWithPin(uid, pin);
      if (!res.success) {
        this.unlockError.set(res.message);
      } else {
        this.unlockPin.set('');
        this.unlockError.set('');

        // Bloque G: Redirección inmediata si el usuario que desbloquea no tiene acceso a la vista actual
        const authenticatedUser = res.updatedUser || this.inv.currentUser();
        const role = authenticatedUser?.role || 'CAJERO';
        const currentUrl = this.router.url || '';
        if (!canAccessRoute(role, currentUrl)) {
          await this.router.navigate(['/pos']);
        }
      }
    } finally {
      this.isSubmittingUnlock.set(false);
    }
  }
}
