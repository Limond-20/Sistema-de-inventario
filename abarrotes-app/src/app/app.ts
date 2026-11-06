import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';
import { MockInventoryService } from './services/mock-inventory.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavbarComponent],
  template: `
    @if (!inv.isHydrated()) {
      <!-- Pantalla de carga durante la hidratación desde IndexedDB -->
      <div class="h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-white select-none p-8" data-testid="hydration-loading-screen">
        <div class="h-14 w-14 rounded-2xl bg-amber-400 text-slate-900 grid place-items-center font-bold text-2xl animate-pulse mb-4">
          BT
        </div>
        <h1 class="text-xl font-bold tracking-tight">Cargando datos de la tienda…</h1>
        <p class="text-sm text-slate-300 mt-1.5">Verificando integridad del Kardex y existencias por producto en IndexedDB</p>
      </div>
    } @else {
      <div class="h-screen w-screen flex bg-slate-100 overflow-hidden select-none">
        <!-- Barra lateral fija -->
        <app-navbar />

        <!-- Área de trabajo con márgenes; solo esta zona se desplaza si el contenido es largo -->
        <main class="flex-1 min-w-0 overflow-y-auto flex flex-col">
          @if (inv.isReadOnlyMode()) {
            <div class="bg-amber-500 text-slate-950 px-8 py-3 font-bold text-sm flex items-center justify-between shadow-sm shrink-0" role="alert" data-testid="readonly-warning-banner">
              <div class="flex items-center gap-2.5">
                <span class="text-base">🔒</span>
                <span>{{ inv.readOnlyWarning() || 'Esta app ya está abierta en otra ventana' }} (Modo solo lectura: las escrituras están deshabilitadas en esta pestaña)</span>
              </div>
              <span class="rounded-full bg-slate-950/15 px-3 py-0.5 text-xs font-extrabold uppercase">Solo lectura</span>
            </div>
          }

          <div class="px-10 py-8 max-w-[1440px] w-full mx-auto flex-1">
            <router-outlet />
          </div>
        </main>
      </div>

      <!-- Modal de Datos Dañados o Discrepancia de Continuidad (NO sobrescribe automáticamente) -->
      @if (inv.corruptedModalOpen()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-6" role="dialog" aria-modal="true" data-testid="corrupted-data-modal">
          <div class="w-full max-w-2xl overflow-hidden rounded-2xl border-2 border-rose-300 bg-white text-slate-900 shadow-2xl">
            <div class="flex items-center justify-between border-b border-rose-200 bg-rose-50 px-7 py-5">
              <div class="flex items-center gap-3">
                <span class="text-2xl">⚠️</span>
                <div>
                  <h2 class="text-xl font-bold text-rose-950">Datos guardados dañados o alterados</h2>
                  <p class="text-xs font-semibold text-rose-700 mt-0.5">
                    El autoguardado ha sido bloqueado para NO sobrescribir tu información original.
                  </p>
                </div>
              </div>
            </div>

            <div class="p-7 space-y-4">
              <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                <p class="font-semibold text-slate-900 mb-1">Diagnóstico de integridad:</p>
                <p class="text-slate-700">{{ inv.corruptedDataWarning() }}</p>
                @if (inv.corruptedBackupKey()) {
                  <p class="mt-2 text-xs font-mono text-slate-600">
                    Copia de resguardo: <b>{{ inv.corruptedBackupKey() }}</b> (se conservan las 3 más recientes)
                  </p>
                }
              </div>

              @if (inv.corruptedAffectedSkus().length > 0) {
                <div class="rounded-xl border border-rose-200 bg-rose-50/70 p-4">
                  <p class="text-xs font-bold uppercase tracking-wider text-rose-900 mb-2">
                    SKUs afectados por discrepancia de continuidad (Stock vs. Kardex):
                  </p>
                  <div class="flex flex-wrap gap-2">
                    @for (sku of inv.corruptedAffectedSkus(); track sku) {
                      <span class="rounded-lg bg-rose-200/80 px-2.5 py-1 font-mono text-xs font-bold text-rose-950">
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
                    class="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-100"
                    data-testid="btn-download-corrupted">
                    Descargar datos dañados (JSON)
                  </button>
                  <button
                    type="button"
                    (click)="inv.retryRestorePersistedState()"
                    class="h-11 rounded-xl border border-brand-300 bg-brand-50 px-5 text-sm font-semibold text-brand-800 hover:bg-brand-100"
                    data-testid="btn-retry-corrupted">
                    Reintentar
                  </button>
                  <button
                    type="button"
                    (click)="inv.requestStartWithDemoDataConfirmation()"
                    class="h-11 rounded-xl bg-amber-500 px-5 text-sm font-bold text-slate-950 hover:bg-amber-400"
                    data-testid="btn-start-demo-request">
                    Empezar con datos de demostración
                  </button>
                </div>
              } @else {
                <div class="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 space-y-3" data-testid="confirm-overwrite-box">
                  <p class="text-sm font-bold text-amber-950">
                    ¿Confirmas sobrescribir el estado principal con los datos de demostración?
                  </p>
                  <p class="text-xs text-amber-900">
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
                      class="h-10 rounded-xl bg-rose-600 px-5 text-xs font-bold text-white hover:bg-rose-700"
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
