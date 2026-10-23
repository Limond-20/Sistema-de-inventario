import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, PercentPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AbcClass, MockInventoryService, Product } from '../../services/mock-inventory.service';
import {
  ABC_POLICIES,
  AbcFlag,
  AbcResult,
  CATEGORY_FREQUENCY_HINT,
  GuidedAnswer,
  GuidedFrequency,
  summarizeAbc,
} from '../../services/abc-classifier';

type Mode = 'auto' | 'guiado';

interface FrequencyOption {
  value: GuidedFrequency;
  icon: string;
  label: string;
  hint: string;
}

@Component({
  selector: 'app-abc-classification-view',
  imports: [CurrencyPipe, PercentPipe, RouterModule],
  templateUrl: './abc-classification-view.component.html',
})
export class AbcClassificationViewComponent {
  protected readonly inv = inject(MockInventoryService);
  protected readonly policies: Record<string, any> = ABC_POLICIES;
  protected readonly classes: AbcClass[] = ['A', 'B', 'C'];

  protected readonly mode = signal<Mode>('auto');
  protected readonly toast = signal<string | null>(null);

  // ---------------- MODO AUTOMÁTICO ----------------

  protected readonly results = this.inv.abcSuggestions;
  protected readonly summary = computed(() => summarizeAbc(this.results()));
  protected readonly changes = this.inv.pendingAbcChanges;

  protected product(sku: string): Product {
    return this.inv.products().find((p) => p.sku === sku)!;
  }

  protected applyAll(): void {
    const n = this.inv.applyAbcResults(this.results());
    this.flash(n ? `Listo: ${n} producto(s) cambiaron de clase.` : 'Todo estaba al día, no hubo cambios.');
  }

  protected applyOne(r: AbcResult): void {
    this.inv.applyAbcResults(this.results(), [r.sku]);
    this.flash(`${this.product(r.sku).name} ahora es Clase ${r.finalClass}.`);
  }

  protected pin(sku: string, value: string): void {
    this.inv.pinAbc(sku, value === '' ? null : (value as AbcClass));
  }

  protected pinnedOf(sku: string): AbcClass | '' {
    return this.inv.abcPinned()[sku] ?? '';
  }

  protected flagLabel(f: AbcFlag): string {
    switch (f) {
      case 'DINERO_DORMIDO':
        return '😴 Dinero dormido';
      case 'GANCHO':
        return '🧲 Producto gancho';
      case 'NUEVO':
        return '🆕 Nuevo';
      case 'CANDADO':
        return '🔒 Fijado por ti';
      case 'ESTABILIZADO':
        return '⚖️ En la orilla';
      default:
        return '';
    }
  }

  // ---------------- MODO GUIADO ----------------

  protected readonly frequencyOptions: FrequencyOption[] = [
    { value: 'VARIAS_AL_DIA', icon: '🔥', label: 'Varias veces al día', hint: 'Casi cada cliente lo lleva' },
    { value: 'POR_SEMANA', icon: '📅', label: 'Unas veces por semana', hint: 'Sale, pero no diario' },
    { value: 'CASI_NO', icon: '💤', label: 'Casi no se vende', hint: 'Lleva tiempo en el anaquel' },
  ];

  protected readonly step = signal(0);
  protected readonly answers = signal<Record<string, GuidedAnswer>>({});
  protected readonly guidedDone = signal(false);

  protected readonly guidedProducts = computed(() => this.inv.products());
  protected readonly currentGuided = computed(() => this.guidedProducts()[this.step()]);
  protected readonly currentAnswer = computed(() => {
    const p = this.currentGuided();
    return p ? this.answers()[p.sku] ?? this.defaultAnswer(p) : null;
  });
  protected readonly guidedResults = computed(() =>
    this.guidedDone() ? this.inv.previewGuided(Object.values(this.answers())) : [],
  );
  protected readonly guidedSummary = computed(() => summarizeAbc(this.guidedResults()));

  /** Respuesta precargada según la categoría: el tendero solo confirma. */
  private defaultAnswer(p: Product): GuidedAnswer {
    return {
      sku: p.sku,
      frequency: CATEGORY_FREQUENCY_HINT[p.category] ?? 'POR_SEMANA',
      losesCustomer: !!p.isTrafficDriver,
    };
  }

  protected setFrequency(value: GuidedFrequency): void {
    const p = this.currentGuided();
    const a = this.currentAnswer();
    if (!p || !a) return;
    this.answers.update((m) => ({ ...m, [p.sku]: { ...a, frequency: value } }));
  }

  protected setLosesCustomer(value: boolean): void {
    const p = this.currentGuided();
    const a = this.currentAnswer();
    if (!p || !a) return;
    this.answers.update((m) => ({ ...m, [p.sku]: { ...a, losesCustomer: value } }));
  }

  protected next(): void {
    const p = this.currentGuided();
    const a = this.currentAnswer();
    if (p && a) this.answers.update((m) => ({ ...m, [p.sku]: a }));
    if (this.step() < this.guidedProducts().length - 1) {
      this.step.update((s) => s + 1);
    } else {
      this.guidedDone.set(true);
    }
  }

  protected back(): void {
    if (this.guidedDone()) {
      this.guidedDone.set(false);
      return;
    }
    this.step.update((s) => Math.max(0, s - 1));
  }

  protected restartGuided(): void {
    this.answers.set({});
    this.step.set(0);
    this.guidedDone.set(false);
  }

  protected saveGuided(): void {
    const n = this.inv.applyAbcResults(this.guidedResults());
    this.flash(`Clasificación inicial guardada (${n} cambio(s)). Se ajustará sola con tus ventas.`);
    this.mode.set('auto');
    this.restartGuided();
  }

  private flash(msg: string): void {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3500);
  }

  // ---------------- ESTILOS ----------------

  protected classChip(c: AbcClass | string): string {
    return c === 'A'
      ? 'bg-emerald-100 text-emerald-900 border-emerald-400'
      : c === 'B'
        ? 'bg-blue-100 text-blue-900 border-blue-400'
        : 'bg-slate-100 text-slate-700 border-slate-300';
  }

  protected classBar(c: AbcClass | string): string {
    return c === 'A' ? 'bg-emerald-500' : c === 'B' ? 'bg-blue-500' : 'bg-slate-400';
  }
}
