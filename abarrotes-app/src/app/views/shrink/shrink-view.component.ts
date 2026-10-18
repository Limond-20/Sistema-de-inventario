import { Component, computed, inject } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { MockInventoryService } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-shrink-view',
  imports: [CurrencyPipe],
  template: `
    <section class="mb-5">
      <h1 class="text-3xl font-extrabold">🗑️ Revisar Mermas</h1>
      <p class="text-lg text-slate-600">Productos rotos o caducados que se dieron de baja desde el celular, con su foto de evidencia.</p>
    </section>

    <section class="grid md:grid-cols-3 gap-4 mb-6">
      <div class="rounded-2xl border-4 border-red-600 bg-red-50 p-4">
        <p class="text-red-800 font-semibold">💸 Pérdida de esta semana</p>
        <p class="text-4xl font-extrabold text-red-700">{{ totalLoss() | currency: 'MXN' : 'symbol-narrow' }}</p>
      </div>
      <div class="rounded-2xl border-4 border-slate-300 bg-white p-4">
        <p class="text-slate-600 font-semibold">💥 Envase roto</p>
        <p class="text-4xl font-extrabold">{{ broken() }} registros</p>
      </div>
      <div class="rounded-2xl border-4 border-slate-300 bg-white p-4">
        <p class="text-slate-600 font-semibold">📅 Caducado sin devolución</p>
        <p class="text-4xl font-extrabold">{{ expired() }} registros</p>
      </div>
    </section>

    <section class="flex flex-col gap-4">
      @for (r of inv.shrinkRecords(); track r.id) {
        <article class="rounded-2xl border-4 bg-white p-5 grid md:grid-cols-12 gap-4 items-center"
          [class]="r.reviewed ? 'border-slate-200 opacity-80' : 'border-red-500'">
          <div class="md:col-span-2 h-24 rounded-xl bg-gradient-to-br from-amber-100 to-red-200 flex flex-col items-center justify-center border-2 border-red-300">
            <span class="text-4xl">{{ r.emoji }}{{ r.reason === 'Envase Roto en Piso' ? '💥' : '📅' }}</span>
            <span class="text-xs font-bold text-red-800">📷 Foto de evidencia</span>
          </div>
          <div class="md:col-span-5">
            <p class="text-xl font-extrabold">{{ r.qty }} × {{ r.name }}</p>
            <p class="text-base font-bold text-red-700">{{ r.reason === 'Envase Roto en Piso' ? '💥' : '📅' }} {{ r.reason }}</p>
            <p class="text-sm text-slate-500">Folio {{ r.id }} · {{ r.date }} {{ r.time }} · {{ r.registeredBy }}</p>
          </div>
          <div class="md:col-span-2 text-right">
            <p class="text-sm text-slate-500">Pérdida</p>
            <p class="text-2xl font-extrabold text-red-700">{{ r.qty * r.unitCost | currency: 'MXN' : 'symbol-narrow' }}</p>
          </div>
          <div class="md:col-span-3">
            @if (r.reviewed) {
              <p class="text-lg font-extrabold text-green-700 text-center">✔️ Revisado</p>
            } @else {
              <button type="button" (click)="inv.markShrinkReviewed(r.id)"
                class="w-full min-h-[64px] rounded-xl border-4 border-green-800 bg-green-600 hover:bg-green-700 text-white text-lg font-extrabold">
                ✅ Marcar como Revisado
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
