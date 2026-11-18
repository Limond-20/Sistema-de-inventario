import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MockInventoryService, ShrinkRecord } from '../../services/mock-inventory.service';

@Component({
  selector: 'app-shrink-view',
  imports: [CurrencyPipe, FormsModule, RouterLink],
  template: `
    <!-- ===================== ENCABEZADO EJECUTIVO ===================== -->
    <section class="mb-5 flex flex-wrap items-end justify-between gap-4 pb-3 border-b border-slate-200">
      <div>
        <h1 class="text-2xl sm:text-3xl font-black text-slate-900">Mermas y Bajas de Mercancía</h1>
      </div>

      <div class="flex items-center gap-5">
        <div class="flex items-center gap-2 text-sm text-slate-600">
          <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
          <span>Sincronización móvil activa</span>
        </div>
        <a routerLink="/fefo"
          class="flex h-10 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 shadow-2xs transition-colors hover:bg-slate-50">
          Cambios Físicos FEFO@if (inv.getUrgentFefoCount() > 0) { ({{ inv.getUrgentFefoCount() }}) }
        </a>
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

    <!-- ===================== FEEDBACK DE REVISIÓN ===================== -->
    @if (shrinkFeedback(); as fb) {
      <div role="alert" data-testid="shrink-feedback-banner"
        class="mb-4 rounded-xl border px-4 py-3 text-xs font-bold flex items-center justify-between gap-3"
        [class]="fb.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-rose-300 bg-rose-50 text-rose-950'">
        <span>{{ fb.message }}</span>
        <button type="button" (click)="shrinkFeedback.set(null)" class="text-xs underline font-semibold shrink-0">
          Cerrar
        </button>
      </div>
    }

    <!-- ===================== LISTA DE REGISTROS CON EVIDENCIA ===================== -->
    <section class="flex flex-col gap-3">
      @for (r of inv.shrinkRecords(); track r.id) {
        <article class="rounded-xl border bg-white p-4 shadow-2xs transition-all grid md:grid-cols-12 gap-4 items-center"
          [class]="r.reviewed ? 'border-slate-200 bg-slate-50/50' : 'border-slate-300'">

          <!-- Miniatura de Evidencia Fotográfica -->
          <div class="md:col-span-2 h-20 rounded-xl bg-slate-100 flex flex-col items-center justify-center border border-slate-200 shadow-2xs overflow-hidden relative text-center">
            @if (r.evidenceId && !imgErrors().has(r.id)) {
              <img [src]="'/api/evidencia/' + r.evidenceId"
                   (error)="onImgError(r.id)"
                   (click)="openLightbox('/api/evidencia/' + r.evidenceId)"
                   class="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                   alt="Evidencia #{{ r.id }}"
                   title="Clic para ver en grande" />
              <div class="absolute bottom-1 right-1 bg-slate-900/75 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded pointer-events-none">
                Ver foto
              </div>
            } @else {
              <div class="flex flex-col items-center justify-center p-2 text-slate-500">
                <svg class="w-6 h-6 mb-1 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span class="text-[10px] font-bold text-slate-600 uppercase tracking-tight">Foto Evidencia</span>
              </div>
            }
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
              <button type="button" (click)="onConfirmShrink(r)" data-testid="btn-confirm-shrink"
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

    <!-- Modal de Autorización PIN cuando la merma supera stock -->
    @if (pendingShrinkAuth(); as rec) {
      <div class="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4" role="dialog" aria-modal="true"
           data-testid="modal-shrink-pin-auth" (click)="closeShrinkAuthModal()">
        <div class="bg-white rounded-2xl border border-slate-200 max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
             (click)="$event.stopPropagation()">
          <div class="bg-slate-900 text-white px-5 py-4 flex items-center justify-between shrink-0">
            <div>
              <h2 class="text-base font-bold">Autorizar Baja de Merma con PIN</h2>
              <p class="text-xs text-slate-300 mt-0.5">{{ rec.qty }} {{ rec.saleUnit }} × {{ rec.name }}</p>
            </div>
            <button type="button" (click)="closeShrinkAuthModal()" class="text-xs text-slate-300 hover:text-white font-semibold">
              Cerrar
            </button>
          </div>
          <div class="p-5 space-y-3.5 overflow-y-auto flex-1">
            <p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-950">
              La cantidad de merma ({{ rec.qty }}) supera la existencia actual registrada. Ingresa PIN de Administrador y el motivo para autorizar el ajuste.
            </p>
            <label class="block space-y-1">
              <span class="block text-xs font-bold text-slate-700">PIN de Administrador *</span>
              <input type="password" inputmode="numeric" maxlength="32" data-testid="input-shrink-auth-pin"
                [ngModel]="shrinkAuthPin()" (ngModelChange)="shrinkAuthPin.set($event)"
                placeholder="Ingresa PIN de autorización"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm font-mono font-bold text-slate-900" />
            </label>
            <label class="block space-y-1">
              <span class="block text-xs font-bold text-slate-700">Motivo justificado *</span>
              <input type="text" data-testid="input-shrink-auth-reason"
                [ngModel]="shrinkAuthReason()" (ngModelChange)="shrinkAuthReason.set($event)"
                placeholder="Ej. Conteo físico rezagado / derrame en pasillo"
                class="w-full h-10 rounded-lg border border-slate-300 px-3 text-xs text-slate-900" />
            </label>
            @if (shrinkAuthError(); as err) {
              <div role="alert" data-testid="shrink-auth-error"
                class="rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs font-bold text-rose-900">
                {{ err }}
              </div>
            }
          </div>
          <div class="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3.5 flex justify-end gap-2">
            <button type="button" (click)="closeShrinkAuthModal()"
              class="h-10 px-4 rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-100">
              Cancelar
            </button>
            <button type="button" (click)="submitShrinkAuth()" data-testid="btn-submit-shrink-auth"
              class="h-10 px-5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold">
              Autorizar Baja de Merma
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Modal / Visor de Evidencia en Grande -->
    @if (selectedEvidenceUrl()) {
      <div class="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-6"
           role="dialog" aria-modal="true" aria-label="Evidencia Fotográfica de Merma"
           (click)="closeLightbox()">
        <div class="relative bg-white rounded-2xl border border-slate-200 max-w-2xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
             (click)="$event.stopPropagation()">
          <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-white">
            <h2 class="text-base font-bold text-slate-900">Evidencia Fotográfica de Merma</h2>
            <button type="button" (click)="closeLightbox()"
                    class="h-9 px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors">
              Cerrar
            </button>
          </div>
          <div class="p-6 flex items-center justify-center bg-slate-100 overflow-auto">
            <img [src]="selectedEvidenceUrl()" class="max-h-[70vh] w-auto object-contain rounded-xl border border-slate-200 shadow-xs" alt="Evidencia en grande" />
          </div>
        </div>
      </div>
    }
  `,
})
export class ShrinkViewComponent {
  protected readonly inv = inject(MockInventoryService);
  protected readonly totalLoss = computed(() => this.inv.shrinkRecords().reduce((s, r) => s + r.qty * r.unitCost, 0));
  protected readonly broken = computed(() => this.inv.shrinkRecords().filter((r) => r.reason === 'Envase Roto en Piso').length);
  protected readonly expired = computed(() => this.inv.shrinkRecords().filter((r) => r.reason !== 'Envase Roto en Piso').length);

  protected readonly selectedEvidenceUrl = signal<string | null>(null);
  protected readonly imgErrors = signal<Set<string>>(new Set());
  protected readonly shrinkFeedback = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly pendingShrinkAuth = signal<ShrinkRecord | null>(null);
  protected readonly shrinkAuthPin = signal<string>('');
  protected readonly shrinkAuthReason = signal<string>('');
  protected readonly shrinkAuthError = signal<string | null>(null);

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.pendingShrinkAuth()) {
      this.closeShrinkAuthModal();
      return;
    }
    if (this.selectedEvidenceUrl()) {
      this.closeLightbox();
    }
  }

  async onConfirmShrink(r: ShrinkRecord): Promise<void> {
    this.shrinkFeedback.set(null);
    const res = await this.inv.markShrinkReviewed(r.id);
    if (res.ok) {
      this.shrinkFeedback.set({ ok: true, message: res.message });
      return;
    }
    this.shrinkFeedback.set({ ok: false, message: res.message });
    if (res.message.toLowerCase().includes('pin')) {
      this.pendingShrinkAuth.set(r);
      this.shrinkAuthPin.set('');
      this.shrinkAuthReason.set('');
      this.shrinkAuthError.set(null);
    }
  }

  closeShrinkAuthModal(): void {
    this.pendingShrinkAuth.set(null);
    this.shrinkAuthPin.set('');
    this.shrinkAuthReason.set('');
    this.shrinkAuthError.set(null);
  }

  async submitShrinkAuth(): Promise<void> {
    const rec = this.pendingShrinkAuth();
    if (!rec) return;
    const pin = this.shrinkAuthPin().trim();
    const reason = this.shrinkAuthReason().trim();
    if (!pin) {
      this.shrinkAuthError.set('Ingresa el PIN de Administrador.');
      return;
    }
    if (!reason) {
      this.shrinkAuthError.set('Ingresa el motivo justificado de la merma.');
      return;
    }
    const res = await this.inv.markShrinkReviewed(rec.id, 'Administrador (PIN)', pin, reason);
    if (!res.ok) {
      this.shrinkAuthError.set(res.message);
      return;
    }
    this.shrinkFeedback.set({ ok: true, message: res.message });
    this.closeShrinkAuthModal();
  }

  openLightbox(url: string): void {
    this.selectedEvidenceUrl.set(url);
  }

  closeLightbox(): void {
    this.selectedEvidenceUrl.set(null);
  }

  onImgError(id: string): void {
    this.imgErrors.update((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
  }
}
