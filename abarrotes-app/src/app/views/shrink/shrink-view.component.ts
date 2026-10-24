import { Component, computed, inject } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { MockInventoryService } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-shrink-view',
  imports: [CurrencyPipe],
  template: `
    <!-- ===================== ENCABEZADO EJECUTIVO ===================== -->
    <section class="mb-5 flex flex-wrap items-end justify-between gap-4 pb-3 border-b border-slate-200">
      <div>
        <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
          Control de Pérdidas · Evidencia Fotográfica
        </span>
        <h1 class="text-2xl sm:text-3xl font-black text-slate-900 mt-1">Mermas y Bajas de Mercancía</h1>
        <p class="text-sm text-slate-600 mt-0.5">
          Productos dados de baja por rotura o caducidad sin devolución reportados desde la terminal móvil.
        </p>
      </div>

      <div class="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-3.5 py-2 shadow-2xs text-xs font-semibold text-slate-600">
        <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
        <span>Sincronización móvil activa</span>
      </div>
    </section>

    <!-- ===================== RESUMEN DE MERMAS (3 TARJETAS KPI) ===================== -->
    <section class="grid sm:grid-cols-3 gap-3 mb-5">
      <div class="rounded-xl border border-red-200 bg-red-50/70 p-4 shadow-2xs">
        <span class="text-[11px] font-bold uppercase tracking-wider text-red-800">Pérdida Neta Semanal</span>
        <p class="text-2xl font-black text-red-700 mt-0.5 font-mono tabular-nums">{{ totalLoss() | currency: 'MXN' : 'symbol-narrow' }}</p>
        <p class="text-xs text-red-900/70 mt-0.5">Valuado a costo de reposición</p>
      </div>

      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Envase Roto en Piso</span>
        <p class="text-2xl font-black text-slate-900 mt-0.5 font-mono tabular-nums">{{ broken() }} registros</p>
        <p class="text-xs text-slate-500 mt-0.5">Accidentes de pasillo o descarga</p>
      </div>

      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Caducado sin Devolución</span>
        <p class="text-2xl font-black text-slate-900 mt-0.5 font-mono tabular-nums">{{ expired() }} registros</p>
        <p class="text-xs text-slate-500 mt-0.5">Sin convenio de cambio físico</p>
      </div>
    </section>

    <!-- ===================== LISTA DE REGISTROS CON EVIDENCIA ===================== -->
    <section class="flex flex-col gap-3">
      @for (r of inv.shrinkRecords(); track r.id) {
        <article class="rounded-xl border bg-white p-4 shadow-2xs transition-all grid md:grid-cols-12 gap-4 items-center"
          [class]="r.reviewed ? 'border-slate-200 bg-slate-50/50' : 'border-slate-300'">

          <!-- Miniatura de Evidencia Fotográfica -->
          <div class="md:col-span-2 h-20 rounded-xl bg-slate-100 flex flex-col items-center justify-center border border-slate-200 shadow-2xs p-2 text-center">
            <svg class="w-6 h-6 text-slate-500 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span class="text-[10px] font-bold text-slate-600 uppercase tracking-tight">
              Foto Evidencia
            </span>
          </div>

          <!-- Detalle del Producto y Causa -->
          <div class="md:col-span-5">
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span class="px-2.5 py-0.5 rounded-md text-xs font-bold"
                [class]="r.reason === 'Envase Roto en Piso'
                  ? 'bg-slate-100 text-slate-800 border border-slate-200'
                  : 'bg-amber-100 text-amber-900 border border-amber-200'">
                {{ r.reason }}
              </span>
              <span class="font-mono text-xs font-semibold text-slate-400">Folio #{{ r.id }}</span>
            </div>
            <p class="text-base font-bold text-slate-900 leading-snug">{{ r.qty }} {{ r.saleUnit }} × {{ r.name }}</p>
            <p class="text-xs text-slate-500 mt-1">
              {{ r.date }} a las {{ r.time }} · Registrado por: <b class="text-slate-700">{{ r.registeredBy }}</b>
            </p>
          </div>

          <!-- Impacto Financiero -->
          <div class="md:col-span-2 text-right bg-slate-50 border border-slate-200 rounded-xl p-3">
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Pérdida al Costo</p>
            <p class="text-xl font-black text-red-700 font-mono tabular-nums mt-0.5">
              -{{ r.qty * r.unitCost | currency: 'MXN' : 'symbol-narrow' }}
            </p>
            <p class="text-[11px] text-slate-400 font-mono">{{ r.unitCost | currency: 'MXN' : 'symbol-narrow' }} c/u</p>
          </div>

          <!-- Acción de Revisión -->
          <div class="md:col-span-3">
            @if (r.reviewed) {
              <div class="h-11 rounded-xl bg-slate-100 border border-slate-200 text-slate-600 font-bold text-xs flex items-center justify-center gap-2">
                <svg class="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
                </svg>
                <span>Revisada y Auditada</span>
              </div>
            } @else {
              <button type="button" (click)="inv.markShrinkReviewed(r.id)"
                class="w-full h-11 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold shadow-2xs flex items-center justify-center transition-colors">
                Confirmar Revisión
              </button>
            }
          </div>
        </article>
      } @empty {
        <div class="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500 text-xs shadow-2xs">
          <p class="text-sm font-bold text-slate-800">Sin mermas registradas</p>
          <p class="mt-0.5">No hay reportes de productos rotos o caducados pendientes de auditar.</p>
        </div>
      }
    </section>
  `,
})
export class ShrinkViewComponent {
  protected readonly inv = inject(MockInventoryService);
  protected readonly totalLoss = computed(() => this.inv.shrinkRecords().reduce((s, r) => s + r.qty * r.unitCost, 0));
  protected readonly broken = computed(() => this.inv.shrinkRecords().filter((r) => r.reason === 'Envase Roto en Piso').length);
  protected readonly expired = computed(() => this.inv.shrinkRecords().filter((r) => r.reason !== 'Envase Roto en Piso').length);
}
