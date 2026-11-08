import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';
import { IconComponent } from './components/icon/icon.component';
import { MockInventoryService } from './services/mock-inventory.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent, IconComponent],
  template: `
    @if (!inv.isHydrated()) {
      <!-- Pantalla de carga durante la hidratación desde IndexedDB -->
      <div class="h-screen w-screen flex flex-col items-center justify-center bg-brand-800 text-white select-none p-8" data-testid="hydration-loading-screen">
        <div class="h-14 w-14 rounded-2xl bg-amber-400 text-slate-900 grid place-items-center shadow-xs mb-4">
          <app-icon name="logo" [size]="28" />
        </div>
        <h1 class="font-display text-2xl font-bold">Cargando datos de la tienda…</h1>
        <p class="text-sm text-brand-200 mt-1.5">Verificando integridad del Kardex y existencias por producto</p>
      </div>
    } @else {
      <div class="h-screen w-screen flex bg-slate-100 overflow-hidden select-none print-shell print:h-auto print:w-full print:overflow-visible print:bg-white print:block">
        <!-- Barra lateral fija -->
        <app-navbar class="print:hidden no-print" />

        <!-- Área de trabajo con márgenes; solo esta zona se desplaza si el contenido es largo -->
        <main class="flex-1 min-w-0 overflow-y-auto flex flex-col print:overflow-visible print:h-auto print:block">
          @if (inv.isReadOnlyMode()) {
            <div class="border-b border-amber-300 bg-amber-50 text-slate-900 px-10 py-3 text-sm font-semibold flex items-center justify-between shrink-0 print:hidden no-print" role="alert" data-testid="readonly-warning-banner">
              <div class="flex items-center gap-2.5 text-amber-900">
                <app-icon name="lock" [size]="18" />
                <span>{{ inv.readOnlyWarning() || 'Esta app ya está abierta en otra ventana' }} · Modo solo lectura</span>
              </div>
              <span class="rounded-full border border-amber-300 bg-amber-100 px-3 py-0.5 text-xs font-bold text-amber-900">Solo lectura</span>
            </div>
          }

          @if (inv.isBackupOlderThan24h()) {
            <div class="border-b border-amber-200 bg-amber-50/80 text-slate-900 px-10 py-2.5 text-xs font-semibold flex items-center justify-between shrink-0 print:hidden no-print" role="status" data-testid="stale-backup-banner">
              <div class="flex items-center gap-2 text-amber-900">
                <app-icon name="alert" [size]="16" />
                <span>El último respaldo cifrado tiene más de 24 horas (o aún no se ha realizado). Ingresa tu frase de respaldo para proteger la tienda.</span>
              </div>
              <span class="text-amber-800 tabular-nums">{{ inv.getRelativeLastBackupLabel() }}</span>
            </div>
          }

          <div class="px-10 py-8 max-w-[1440px] w-full mx-auto flex-1 print:p-0 print:max-w-none">
            <router-outlet />
          </div>
        </main>
      </div>

      <!-- Modal de Datos Dañados o Discrepancia de Continuidad (NO sobrescribe automáticamente) -->
      @if (inv.corruptedModalOpen()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-6" role="dialog" aria-modal="true" data-testid="corrupted-data-modal">
          <div class="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
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
                    SKUs afectados por discrepancia de continuidad (Stock vs. Kardex):
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
                    (click)="inv.requestStartWithDemoDataConfirmation()"
                    class="h-11 rounded-xl bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800"
                    data-testid="btn-start-demo-request">
                    Empezar con datos de demostración
                  </button>
                </div>
              } @else {
                <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3" data-testid="confirm-overwrite-box">
                  <p class="text-sm font-bold text-slate-900">
                    ¿Confirmas sobrescribir el estado principal con los datos de demostración?
                  </p>
                  <p class="text-xs text-slate-700">
                    La copia del dato dañado seguirá resguardada en <b>{{ inv.corruptedBackupKey() }}</b>, pero el estado activo de la tienda se reiniciará a los valores de demostración.
                  </p>
                  <div class="flex justify-end gap-3">
                    <button
                      type="button"
                      (click)="inv.cancelStartWithDemoDataConfirmation()"
                      class="h-10 rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                      Cancelar
                    </button>
                    <button
                      type="button"
                      (click)="inv.confirmStartWithDemoData()"
                      class="h-10 rounded-xl bg-[#a33f3f] px-5 text-xs font-semibold text-white hover:bg-[#8c3434]"
                      data-testid="btn-confirm-demo-overwrite">
                      Confirmar y empezar con datos de demostración
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
export class App {
  protected readonly inv = inject(MockInventoryService);
}
