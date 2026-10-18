import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  MockInventoryService,
  ReceptionLine,
  marginPct,
  suggestedPrice,
} from '../../services/mock-inventory.service';

type Mode = 'ocr' | 'manual';

interface LineView extends ReceptionLine {
  margin: number;
  costUp: boolean;
  broken: boolean;
  suggested: number;
  suggestedMargin: number;
}

@Component({
  selector: 'app-reception-view',
  imports: [CurrencyPipe, DecimalPipe, FormsModule, RouterLink],
  templateUrl: './reception-view.component.html',
})
export class ReceptionViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly mode = signal<Mode>('ocr');
  protected readonly ocrLines = signal<ReceptionLine[]>(structuredClone(this.inv.ocrNote()?.lines ?? []));
  protected readonly manualLines = signal<ReceptionLine[]>([]);
  protected readonly savedSummary = signal<{ folio: string; lines: number; total: number; adjusted: number } | null>(null);

  // ---------- Formulario manual ----------
  protected manualSku = '';
  protected manualQty = 1;
  protected manualCost: number | null = null;

  protected readonly lines = computed<LineView[]>(() => {
    const src = this.mode() === 'ocr' ? this.ocrLines() : this.manualLines();
    return src.map((l) => {
      const margin = marginPct(l.newCost, l.salePrice);
      const suggested = suggestedPrice(l.newCost, l.targetMargin);
      return {
        ...l,
        margin,
        costUp: l.newCost > l.historicCost,
        broken: !l.resolved && margin < l.targetMargin,
        suggested,
        suggestedMargin: marginPct(l.newCost, suggested),
      };
    });
  });

  protected readonly pendingCount = computed(() => this.lines().filter((l) => l.broken).length);
  protected readonly total = computed(() => this.lines().reduce((s, l) => s + l.lineTotal, 0));
  protected readonly canSave = computed(() => this.lines().length > 0 && this.pendingCount() === 0);

  protected readonly selectedProduct = computed(() => this.inv.products().find((p) => p.sku === this.manualSkuSig()));
  private readonly manualSkuSig = signal('');

  setMode(m: Mode) {
    this.mode.set(m);
    this.savedSummary.set(null);
  }

  onManualSkuChange(sku: string) {
    this.manualSku = sku;
    this.manualSkuSig.set(sku);
    const p = this.inv.products().find((x) => x.sku === sku);
    this.manualCost = p ? +(p.newCost * p.unitsPerPurchase).toFixed(2) : null;
  }

  changeManualQty(d: number) {
    this.manualQty = Math.max(1, Math.min(99, this.manualQty + d));
  }

  addManualLine() {
    if (!this.manualSku || !this.manualCost || this.manualCost <= 0) return;
    const line = this.inv.createManualLine(this.manualSku, this.manualQty, this.manualCost);
    this.manualLines.update((list) => [...list.filter((l) => l.sku !== line.sku), line]);
    this.manualSku = '';
    this.manualSkuSig.set('');
    this.manualQty = 1;
    this.manualCost = null;
  }

  removeManualLine(sku: string) {
    this.manualLines.update((list) => list.filter((l) => l.sku !== sku));
  }

  applySuggested(line: LineView) {
    const update = (list: ReceptionLine[]) =>
      list.map((l) => (l.sku === line.sku ? { ...l, salePrice: line.suggested, resolved: true } : l));
    if (this.mode() === 'ocr') this.ocrLines.update(update);
    else this.manualLines.update(update);
  }

  reloadNote() {
    this.inv.reloadOcrNote();
    this.ocrLines.set(structuredClone(this.inv.ocrNote()!.lines));
    this.savedSummary.set(null);
  }

  save() {
    if (!this.canSave()) return;
    const isOcr = this.mode() === 'ocr';
    const src = isOcr ? this.ocrLines() : this.manualLines();
    const folio = isOcr ? this.inv.ocrNote()!.folio : `MAN-${String(Date.now()).slice(-5)}`;
    this.inv.saveReception(src, folio);
    this.savedSummary.set({
      folio,
      lines: src.length,
      total: src.reduce((s, l) => s + l.lineTotal, 0),
      adjusted: src.filter((l) => l.resolved).length,
    });
    if (isOcr) this.ocrLines.set([]);
    else this.manualLines.set([]);
  }
}
