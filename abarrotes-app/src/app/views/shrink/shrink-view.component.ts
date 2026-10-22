import { Component, computed, inject } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { MockInventoryService } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-shrink-view',
  imports: [CurrencyPipe],
  template: `
    <!-- ===================== ENCABEZADO EJECUTIVO ===================== -->
    <section class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <span class="px-3 py-1 rounded-full bg-red-100 text-red-900 text-xs font-extrabold uppercase tracking-wider border border-red-200">
          Control de Pérdidas · Evidencia Fotográfica Obligatoria
        </span>
        <h1 class="text-3xl sm:text-4xl font-black text-slate-900 mt-1">🗑️ Revisar Mermas y Bajas</h1>
        <p class="text-base text-slate-600">
          Productos rotos o caducados sin devolución dados de baja desde el celular con foto obligatoria.
        </p>
      </div>
    </section>

    <!-- ===================== BENTO GRID DE RESUMEN DE MERMAS ===================== -->
    <section class="grid sm:grid-cols-3 gap-4 mb-6">
      <div class="rounded-2xl border border-red-300 bg-red-50/80 p-5 shadow-xs">
        <span class="text-xs font-extrabold uppercase tracking-wider text-red-800">💸 Pérdida de esta Semana</span>
        <p class="text-3xl font-black text-red-700 mt-1 tabular-nums">{{ totalLoss() | currency: 'MXN' : 'symbol-narrow' }}</p>
        <p class="text-xs text-red-900/80 mt-0.5">Valuado a costo de reposición</p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <span class="text-xs font-extrabold uppercase tracking-wider text-slate-400">💥 Envase Roto en Piso</span>
        <p class="text-3xl font-black text-slate-900 mt-1 tabular-nums">{{ broken() }} registros</p>
        <p class="text-xs text-slate-500 mt-0.5">Accidentes de pasillo o descarga</p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <span class="text-xs font-extrabold uppercase tracking-wider text-slate-400">📅 Caducado sin Devolución</span>
        <p class="text-3xl font-black text-slate-900 mt-1 tabular-nums">{{ expired() }} registros</p>
        <p class="text-xs text-slate-500 mt-0.5">Proveedores sin convenio de cambio físico</p>
      </div>
    </section>

    <!-- ===================== LISTA DE REGISTROS CON EVIDENCIA FOTOGRÁFICA ===================== -->
    <section class="flex flex-col gap-4">
      @for (r of inv.shrinkRecords(); track r.id) {
        <article class="rounded-2xl border-2 bg-white p-5 shadow-xs hover:shadow-sm transition-all grid md:grid-cols-12 gap-5 items-center"
          [class]="r.reviewed ? 'border-slate-200 opacity-85' : 'border-red-300'">

          <!-- Miniatura de Evidencia Fotográfica -->
          <div class="md:col-span-2 h-24 rounded-2xl bg-gradient-to-br from-rose-50 via-amber-50 to-red-100 flex flex-col items-center justify-center border border-red-200 shadow-2xs">
            <span class="text-4xl leading-none">{{ r.emoji }}{{ r.reason === 'Envase Roto en Piso' ? '💥' : '📅' }}</span>
            <span class="mt-1.5 px-2 py-0.5 rounded-full bg-white/90 text-[11px] font-extrabold text-red-900 border border-red-200">
              📷 Evidencia
            </span>
          </div>

          <!-- Detalle del Producto y Causa -->
          <div class="md:col-span-5">
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span class="px-2.5 py-0.5 rounded-md text-xs font-extrabold"
                [class]="r.reason === 'Envase Roto en Piso'
                  ? 'bg-red-100 text-red-900 border border-red-200'
                  : 'bg-amber-100 text-amber-900 border border-amber-200'">
                {{ r.reason === 'Envase Roto en Piso' ? '💥 Envase Roto en Piso' : '📅 ' + r.reason }}
              </span>
              <span class="font-mono text-xs font-bold text-slate-400">Folio #{{ r.id }}</span>
            </div>
            <p class="text-xl font-black text-slate-900">{{ r.qty }} × {{ r.name }}</p>
            <p class="text-xs font-semibold text-slate-500 mt-1">
              📅 {{ r.date }} a las {{ r.time }} · Reportado desde celular por: <b class="text-slate-700">{{ r.registeredBy }}</b>
            </p>
          </div>

          <!-- Impacto Financiero -->
          <div class="md:col-span-2 text-right bg-red-50/70 border border-red-100 rounded-xl p-3">
            <p class="text-[11px] font-extrabold uppercase tracking-wider text-red-800">Pérdida Neta</p>
            <p class="text-2xl font-black text-red-700 tabular-nums mt-0.5">
              -{{ r.qty * r.unitCost | currency: 'MXN' : 'symbol-narrow' }}
            </p>
            <p class="text-[11px] text-slate-500">{{ r.unitCost | currency: 'MXN' : 'symbol-narrow' }} c/u</p>
          </div>

          <!-- Acción de Revisión -->
          <div class="md:col-span-3">
            @if (r.reviewed) {
              <div class="h-14 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 font-extrabold text-sm flex items-center justify-center gap-2">
                <span>✔️</span>
                <span>Merma Revisada y Auditada</span>
              </div>
            } @else {
              <button type="button" (click)="inv.markShrinkReviewed(r.id)"
                class="w-full h-14 rounded-xl border-2 border-emerald-800 bg-emerald-600 hover:bg-emerald-700 text-white text-base font-extrabold shadow-xs flex items-center justify-center gap-2">
                <span>✅</span>
                <span>Confirmar Revisión</span>
              </button>
            }
          </div>
        </article>
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
