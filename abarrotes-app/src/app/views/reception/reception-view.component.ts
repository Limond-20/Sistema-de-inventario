import { Component, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  MockInventoryService,
  ReceptionLine,
  marginPct,
  parseTicketOCR,
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

declare const Tesseract: {
  recognize: (
    image: File | Blob | string,
    lang: string,
    options?: { logger?: (m: { status?: string; progress?: number }) => void },
  ) => Promise<{ data: { text: string } }>;
};

const PRESET_TICKETS: Record<string, string> = {
  inflacion: [
    'DISTRIBUIDORA DEL BAJIO S.A. DE C.V.',
    'FOLIO: DB-20931',
    '1O Leche Lala Entera 1L $24.5O',
    '12 Aceite Nutrioli 850ml $39.OO',
    '24 Atun Dolores en Agua 140g $16.50',
    '15 Frijol Negro Granel 1 kg $32.OO',
    '5 Queso Fresco Local 1 kg $75.00',
  ].join('\n'),
  queso_atun: [
    'LACTEOS Y ABARROTES DEL CENTRO',
    'FOLIO: LC-8841',
    '10 Leche Lala Entera 1L $21.00',
    '2O Atun Dolores en Agua 140g $19.5O',
    '8 Queso Fresco Local 1 kg $86.OO',
  ].join('\n'),
  estable: [
    'NOTA DE PROVEEDOR SIN ALZAS',
    '10 Leche Lala Entera 1L $21.00',
    '12 Aceite Nutrioli 850ml $34.00',
    '24 Atun Dolores en Agua 140g $16.50',
    '10 Frijol Negro Granel 1 kg $28.00',
    '5 Queso Fresco Local 1 kg $75.00',
  ].join('\n'),
};

@Component({
  selector: 'app-reception-view',
  imports: [CurrencyPipe, DecimalPipe, FormsModule, RouterLink],
  templateUrl: './reception-view.component.html',
})
export class ReceptionViewComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  private readonly zone = inject(NgZone);

  protected readonly mode = signal<Mode>('ocr');
  protected readonly ocrLines = signal<ReceptionLine[]>(structuredClone(this.inv.ocrNote()?.lines ?? []));
  protected readonly manualLines = signal<ReceptionLine[]>([]);
  protected readonly savedSummary = signal<{ folio: string; lines: number; total: number; adjusted: number } | null>(null);

  // ---------- Laboratorio / Simulador OCR y Lector ----------
  protected readonly labOpen = signal<boolean>(true);
  protected readonly rawTicketText = signal<string>(PRESET_TICKETS['inflacion']);
  protected readonly ocrRunning = signal<boolean>(false);
  protected readonly ocrProgress = signal<number>(0);
  protected readonly ocrStatusText = signal<string>('');
  protected readonly lastSyncBanner = signal<string | null>(null);
  protected readonly lastScannedProduct = signal<{
    barcode: string;
    name: string;
    emoji: string;
    salePrice: number;
    historicCost: number;
    time: string;
  } | null>(null);

  private syncChannel: BroadcastChannel | null = null;
  private readonly storageListener = (ev: StorageEvent) => {
    if (ev.key === 'abarrotes_lan_last_event' && ev.newValue) {
      try {
        const data = JSON.parse(ev.newValue);
        this.zone.run(() => this.handleIncomingSyncEvent(data));
      } catch {
        // ignore invalid json
      }
    }
  };

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

  /** Los 5 productos base con sus códigos EAN-13 exactos para pruebas rápidas */
  protected readonly baseFiveProducts = computed(() => this.inv.products().slice(0, 5));

  ngOnInit(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.syncChannel = new BroadcastChannel('abarrotes_lan_sync');
      this.syncChannel.onmessage = (event) => {
        this.zone.run(() => this.handleIncomingSyncEvent(event.data));
      };
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.storageListener);
    }
  }

  ngOnDestroy(): void {
    if (this.syncChannel) {
      this.syncChannel.close();
      this.syncChannel = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
  }

  toggleLab(): void {
    this.labOpen.update((v) => !v);
  }

  setMode(m: Mode): void {
    this.mode.set(m);
    this.savedSummary.set(null);
  }

  loadPresetTicket(key: 'inflacion' | 'queso_atun' | 'estable'): void {
    this.rawTicketText.set(PRESET_TICKETS[key]);
    this.runOcrParserFromText();
  }

  runOcrParserFromText(): void {
    const parsed = parseTicketOCR(this.rawTicketText(), this.inv.products());
    if (parsed.length === 0) {
      this.lastSyncBanner.set(
        '⚠️ No se encontraron líneas con el patrón [Cantidad] [Descripción] [Costo]. Verifica el texto de prueba.',
      );
      return;
    }
    const folio = 'OCR-' + String(Date.now()).slice(-4);
    this.inv.setCustomOcrNote(parsed, folio, 'Simulador OCR en PC');
    this.ocrLines.set(structuredClone(parsed));
    this.mode.set('ocr');
    this.savedSummary.set(null);
    this.lastSyncBanner.set(
      `🧪 Parser OCR ejecutado: se cargaron ${parsed.length} productos en la tabla de recepción (Folio #${folio}).`,
    );
  }

  async onPcTicketImageSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (typeof Tesseract === 'undefined') {
      this.lastSyncBanner.set('⚠️ La librería Tesseract.js aún no termina de cargar desde el CDN.');
      return;
    }

    this.ocrRunning.set(true);
    this.ocrProgress.set(5);
    this.ocrStatusText.set('🔎 Iniciando reconocimiento óptico (Tesseract Español)...');

    try {
      const res = await Tesseract.recognize(file, 'spa', {
        logger: (m) => {
          if (m && typeof m.progress === 'number') {
            this.zone.run(() => {
              this.ocrProgress.set(Math.max(5, Math.round(m.progress! * 100)));
              this.ocrStatusText.set(
                m.status === 'recognizing text'
                  ? '📖 Reconociendo renglones y precios del ticket...'
                  : '⚙️ Procesando imagen...',
              );
            });
          }
        },
      });

      const text = res?.data?.text ?? '';
      this.zone.run(() => {
        this.rawTicketText.set(text);
        this.runOcrParserFromText();
      });
    } catch {
      this.zone.run(() => {
        this.lastSyncBanner.set('⚠️ Ocurrió un error al leer la imagen con Tesseract.');
      });
    } finally {
      this.zone.run(() => {
        this.ocrRunning.set(false);
        input.value = '';
      });
    }
  }

  simulateBarcodeScanOnPC(barcode: string): void {
    const p = this.inv.findProductByBarcode(barcode);
    if (!p) return;
    this.handleIncomingSyncEvent({
      type: 'BARCODE_SCANNED',
      barcode: p.barcode,
      product: p,
    });
  }

  private handleIncomingSyncEvent(data: Record<string, unknown>): void {
    if (!data || typeof data['type'] !== 'string') return;
    const time = new Date().toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    this.inv.phoneLinked.set(true);

    if (data['type'] === 'OCR_TICKET_PARSED') {
      const incomingLines = Array.isArray(data['lines']) ? (data['lines'] as ReceptionLine[]) : [];
      const folio = typeof data['folio'] === 'string' ? data['folio'] : 'OCR-MOVIL';
      if (typeof data['rawText'] === 'string' && data['rawText']) {
        this.rawTicketText.set(data['rawText']);
      }
      if (incomingLines.length > 0) {
        this.inv.setCustomOcrNote(incomingLines, folio, `Celular en Vivo · ${time}`);
        this.ocrLines.set(structuredClone(incomingLines));
        this.mode.set('ocr');
        this.savedSummary.set(null);
        this.lastSyncBanner.set(
          `📡 Recibido desde movil-prototipo.html a las ${time}: Ticket #${folio} con ${incomingLines.length} productos.`,
        );
      }
    } else if (data['type'] === 'BARCODE_SCANNED') {
      const code = String(data['barcode'] ?? '');
      const catalogProduct = this.inv.findProductByBarcode(code);
      if (catalogProduct) {
        this.lastScannedProduct.set({
          barcode: catalogProduct.barcode,
          name: catalogProduct.name,
          emoji: catalogProduct.emoji,
          salePrice: catalogProduct.salePrice,
          historicCost: catalogProduct.historicCost,
          time,
        });
        // Agregar o incrementar en la tabla activa para que el tendero lo vea de inmediato
        const addOrIncrement = (list: ReceptionLine[]) => {
          const existing = list.find((l) => l.sku === catalogProduct.sku);
          if (existing) {
            return list.map((l) =>
              l.sku === catalogProduct.sku
                ? {
                    ...l,
                    qtyPurchase: l.qtyPurchase + 1,
                    lineTotal: +((l.qtyPurchase + 1) * l.newCost * l.unitsPerPurchase).toFixed(2),
                  }
                : l,
            );
          }
          const newLine: ReceptionLine = {
            sku: catalogProduct.sku,
            barcode: catalogProduct.barcode,
            name: catalogProduct.name,
            emoji: catalogProduct.emoji,
            qtyPurchase: 1,
            purchaseUnit: catalogProduct.purchaseUnit,
            unitsPerPurchase: catalogProduct.unitsPerPurchase,
            saleUnit: catalogProduct.saleUnit,
            lineTotal: catalogProduct.historicCost * catalogProduct.unitsPerPurchase,
            historicCost: catalogProduct.historicCost,
            newCost: catalogProduct.historicCost,
            salePrice: catalogProduct.salePrice,
            targetMargin: catalogProduct.targetMargin,
            resolved: false,
          };
          return [newLine, ...list];
        };

        if (this.mode() === 'ocr') {
          this.ocrLines.update(addOrIncrement);
        } else {
          this.manualLines.update(addOrIncrement);
        }

        this.lastSyncBanner.set(
          `📡 Código EAN-13 recibido (${code}): ${catalogProduct.emoji} ${catalogProduct.name} · Precio Venta: $${catalogProduct.salePrice.toFixed(2)}`,
        );
      }
    }
  }

  onManualSkuChange(sku: string): void {
    this.manualSku = sku;
    this.manualSkuSig.set(sku);
    const p = this.inv.products().find((x) => x.sku === sku);
    this.manualCost = p ? +(p.newCost * p.unitsPerPurchase).toFixed(2) : null;
  }

  changeManualQty(d: number): void {
    this.manualQty = Math.max(1, Math.min(99, this.manualQty + d));
  }

  addManualLine(): void {
    if (!this.manualSku || !this.manualCost || this.manualCost <= 0) return;
    const line = this.inv.createManualLine(this.manualSku, this.manualQty, this.manualCost);
    this.manualLines.update((list) => [...list.filter((l) => l.sku !== line.sku), line]);
    this.manualSku = '';
    this.manualSkuSig.set('');
    this.manualQty = 1;
    this.manualCost = null;
  }

  removeManualLine(sku: string): void {
    this.manualLines.update((list) => list.filter((l) => l.sku !== sku));
  }

  applySuggested(line: LineView): void {
    const update = (list: ReceptionLine[]) =>
      list.map((l) => (l.sku === line.sku ? { ...l, salePrice: line.suggested, resolved: true } : l));
    if (this.mode() === 'ocr') this.ocrLines.update(update);
    else this.manualLines.update(update);
  }

  reloadNote(): void {
    this.inv.reloadOcrNote();
    this.ocrLines.set(structuredClone(this.inv.ocrNote()!.lines));
    this.savedSummary.set(null);
  }

  save(): void {
    if (!this.canSave()) return;
    const isOcr = this.mode() === 'ocr';
    const src = isOcr ? this.ocrLines() : this.manualLines();
    const folio = isOcr ? (this.inv.ocrNote()?.folio ?? 'OCR-LAB') : `MAN-${String(Date.now()).slice(-5)}`;
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
