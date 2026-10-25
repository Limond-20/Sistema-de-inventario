import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MockInventoryService, PerishableBatch, SupplierRoute } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-fefo-view',
  imports: [CommonModule, RouterLink],
  template: `
    <div class="content-card flex flex-col gap-5 select-none">
      <!-- ===================== ENCABEZADO ===================== -->
      <section class="flex flex-wrap items-end justify-between gap-4 pb-3 border-b border-slate-200">
        <div>
          <!-- Se eliminó el span superior que decía "Control de Caducidades..." -->
          <h1 class="text-2xl sm:text-3xl font-black text-slate-900 mt-1">Caducidades y Cambio Físico</h1>
          <p class="text-sm text-slate-600 mt-0.5">
            Lotes con fecha de caducidad crítica que deben retirarse hoy del anaquel para el cambio mano a mano con el repartidor.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <a routerLink="/mermas"
            class="h-10 px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-bold text-xs flex items-center gap-1.5 shadow-2xs transition-colors">
            Ver Registro de Mermas
          </a>
          <a routerLink="/"
            class="h-10 px-4 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs flex items-center gap-1.5 transition-colors">
            Volver al Inicio
          </a>
        </div>
      </section>

      <!-- ===================== FEEDBACK DE ACCIÓN ===================== -->
      @if (actionFeedback(); as fb) {
        <div class="rounded-xl border p-4 text-xs font-bold flex items-center justify-between gap-3 shadow-2xs"
          [class]="fb.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-amber-300 bg-amber-50 text-amber-950'">
          <span>{{ fb.msg }}</span>
          <button type="button" (click)="actionFeedback.set(null)" class="text-xs underline font-semibold">
            Cerrar
          </button>
        </div>
      }

      <!-- ===================== TARJETA DE VISITAS DE REPARTIDORES EN 48 HORAS ===================== -->
      <section class="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <!-- Se aumentó un poco la letra de Agenda de Ruta y se cambió el tono -->
            <span class="text-xs font-bold uppercase tracking-wider text-slate-500 block">Agenda de Ruta</span>
            <h2 class="text-base font-bold text-slate-900 mt-0.5">Proveedores en Ruta (Próximas 48 Horas)</h2>
          </div>
          <!-- Se eliminó el fondo y borde azul de la fecha, dejándolo limpio -->
          <span class="text-sm font-medium text-slate-500">
            Día de hoy: Jueves · Visita mañana: Viernes
          </span>
        </div>

        <div class="grid sm:grid-cols-3 gap-3">
          @for (route of inv.supplierRoutes(); track route.id) {
            <!-- Se eliminaron los bordes azules condicionales, todas usan el borde limpio -->
            <div class="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-col justify-between gap-2">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-bold text-slate-900">{{ route.name }}</span>
                  @if (route.visitDays.includes('Viernes')) {
                    <!-- Se ajustó el color de la etiqueta para que no resalte de forma agresiva -->
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 uppercase tracking-wide">
                      Llega Mañana
                    </span>
                  }
                </div>
                <p class="text-[11px] text-slate-600 mt-1">
                  Días de reparto: <b class="text-slate-700">{{ route.visitDays.join(', ') }}</b>
                </p>
                <p class="text-[11px] text-slate-500 mt-0.5 font-mono">
                  Tel: {{ route.phone }}
                </p>
              </div>

              <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                <span class="text-slate-500">Cambio físico:</span>
                <span class="font-bold" [class]="route.physicalExchangePolicy ? 'text-emerald-700' : 'text-slate-500'">
                  {{ route.physicalExchangePolicy ? 'Mano a Mano (Sin costo)' : 'Sin convenio' }}
                </span>
              </div>
            </div>
          }
        </div>
      </section>

      <!-- ===================== LISTA DE LOTES A RETIRAR DEL ESTANTE HOY ===================== -->
      <section class="flex flex-col gap-3">
        <div class="flex items-end justify-between px-1 mb-2">
          <div>
            <h3 class="text-sm font-bold text-slate-900">Lotes que deben separarse del estante hoy</h3>
            <p class="text-xs text-slate-500 mt-0.5">Colócalos en la canasta de devoluciones para el repartidor.</p>
          </div>
          <!-- Se eliminó el fondo rojo y se dejó un texto armónico -->
          <span class="text-sm font-semibold text-slate-500">
            {{ urgentBatches().length }} lote(s) pendientes
          </span>
        </div>

        @for (item of urgentBatches(); track item.batch.batchId) {
          <!-- Se eliminaron los bordes amarillos/ámbar condicionales -->
          <article class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-4">

            <!-- 1. Producto y Folio de Lote -->
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide">
                  Vence en 48h
                </span>
                <span class="font-mono text-xs font-medium text-slate-400">Lote #{{ item.batch.batchId }}</span>
              </div>
              <h4 class="text-base font-bold text-slate-900 leading-snug">{{ item.batch.productName }}</h4>
              <p class="text-xs text-slate-500 mt-0.5">
                Proveedor: <b class="text-slate-700">{{ item.supplier?.name ?? 'Proveedor General' }}</b> · {{ item.nextVisitText }}
              </p>
            </div>

            <!-- 2. Cantidad a separar y fecha -->
            <div class="flex items-center gap-4 lg:gap-6">
              <div class="text-center px-4 border-r border-slate-200">
                <span class="block text-[10px] font-bold uppercase tracking-wider text-slate-400">A Separar</span>
                <p class="text-2xl font-black text-slate-800 leading-none mt-1 font-mono">{{ item.batch.quantity }}</p>
                <span class="block text-[10px] text-slate-500 mt-0.5">piezas</span>
              </div>

              <div class="text-center px-4 rounded-lg bg-red-50/50 border border-red-100 py-2">
                <span class="block text-[10px] font-bold uppercase tracking-wider text-red-800">Caducidad</span>
                <p class="text-sm font-black text-red-700 mt-0.5 font-mono">{{ item.batch.expiryDate }}</p>
                <span class="block text-[10px] text-red-600 mt-0.5 font-semibold">Crítica</span>
              </div>

              <!-- 3. Botones de Acción ajustados al diseño limpio -->
              <div class="flex gap-2">
                <button
                  type="button"
                  (click)="onExchangeSuccess(item.batch.batchId)"
                  class="h-10 px-4 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold transition-colors">
                  Registrar Cambio Exitoso
                </button>
                <button
                  type="button"
                  (click)="onExchangeRejected(item.batch.batchId)"
                  class="h-10 px-4 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-700 text-xs font-bold transition-colors">
                  Rechazado / Mandar a Merma
                </button>
              </div>
            </div>

          </article>
        } @empty {
          <div class="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500 text-xs shadow-2xs">
            <p class="text-base font-bold text-slate-800">No hay lotes con caducidad crítica hoy</p>
            <p class="mt-0.5">Todos los productos perecederos se encuentran en rango óptimo de rotación FEFO.</p>
          </div>
        }
      </section>
    </div>
  `
})
export class FefoViewComponent {
  protected readonly inv = inject(MockInventoryService);
  protected readonly actionFeedback = signal<{ ok: boolean; msg: string } | null>(null);

  protected readonly urgentBatches = computed(() => this.inv.getUpcomingFefoExchanges());

  onExchangeSuccess(batchId: string): void {
    const res = this.inv.resolvePhysicalExchange(batchId, 'CAMBIO_EFECTIVO', '2026-11-28');
    this.actionFeedback.set({ ok: res.ok, msg: res.message });
  }

  onExchangeRejected(batchId: string): void {
    const res = this.inv.resolvePhysicalExchange(batchId, 'MERMA_RECHAZADA');
    this.actionFeedback.set({ ok: false, msg: res.message });
  }
}