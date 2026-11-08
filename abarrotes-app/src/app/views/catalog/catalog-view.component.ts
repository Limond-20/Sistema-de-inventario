import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  AbcClass,
  MockInventoryService,
  Product,
  PurchaseUnit,
  SaleUnit,
  PriceTier,
  marginPct,
} from '../../services/mock-inventory.service';
import {
  calculateUnitCostFromPurchasePackage,
  getAllProductBarcodes,
  normalizePriceTiers,
} from '../../domain/catalog';

const TODAY = new Date('2026-10-22T12:00:00');
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export type AbcFilter = 'ALL' | AbcClass;

@Component({
  selector: 'app-catalog-view',
  imports: [CommonModule, CurrencyPipe, DecimalPipe, FormsModule, RouterModule],
  templateUrl: './catalog-view.component.html',
})
export class CatalogViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly search = signal('');
  protected readonly category = signal<string>('Todos');
  protected readonly abcFilter = signal<AbcFilter>('ALL');
  protected readonly showInactive = signal<boolean>(false);
  protected readonly bulkSheetModalOpen = signal<boolean>(false);

  // Modal de Alta / Edición de Producto (Bloque F1)
  protected readonly productModalOpen = signal<boolean>(false);
  protected readonly editingOriginalSku = signal<string | null>(null);
  protected readonly formFeedback = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly catalogBanner = signal<{ ok: boolean; message: string } | null>(null);

  // Modal de Aprobación de Producto Móvil
  protected readonly approvalModalOpen = signal<boolean>(false);
  protected readonly approvingProduct = signal<Product | null>(null);
  protected readonly approvalPrice = signal<number>(0);
  protected readonly approvalCost = signal<number>(0);
  protected readonly approvalPin = signal<string>('');
  protected readonly approvalFeedback = signal<{ ok: boolean; message: string } | null>(null);

  protected readonly pendingApprovalList = computed(() =>
    this.inv.products().filter((p) => p.approvalStatus === 'PENDIENTE_APROBACION')
  );

  // Campos del formulario
  protected readonly formName = signal<string>('');
  protected readonly formSku = signal<string>('');
  protected readonly formSkuManuallyEdited = signal<boolean>(false);
  protected readonly formCategory = signal<string>('Abarrotes');
  protected readonly formLocation = signal<string>('Anaquel General');
  protected readonly formSupplier = signal<string>('Proveedor General');
  protected readonly formSaleUnit = signal<SaleUnit>('Pieza');
  protected readonly formPurchaseUnit = signal<PurchaseUnit>('Caja');
  protected readonly formUnitsPerPurchase = signal<number>(1);
  protected readonly formPackageCost = signal<number>(0);
  protected readonly formCost = signal<number>(0);
  protected readonly formSalePrice = signal<number>(0);
  protected readonly formIvaRate = signal<number>(0);
  protected readonly formIepsRate = signal<number>(0);
  protected readonly formExpiry = signal<string>('2027-12-31');
  protected readonly formMinStock = signal<number>(5);
  protected readonly formRop = signal<number>(5);
  protected readonly formInitialStock = signal<number>(0);
  protected readonly formAdminPin = signal<string>('');
  protected readonly formIsBulk = signal<boolean>(false);
  protected readonly formShrinkTolerancePct = signal<number>(0);

  // Códigos de barras múltiples + código interno
  protected readonly formBarcodes = signal<string[]>([]);
  protected readonly formNewBarcodeInput = signal<string>('');
  protected readonly formUseInternalBarcode = signal<boolean>(false);

  // Precios escalonados (Menudeo, Medio Mayoreo, Mayoreo)
  protected readonly formMedioMayoreoMinQty = signal<number>(6);
  protected readonly formMedioMayoreoPrice = signal<number>(0);
  protected readonly formMayoreoMinQty = signal<number>(12);
  protected readonly formMayoreoPrice = signal<number>(0);

  protected readonly saleUnitOptions: SaleUnit[] = ['Pieza', 'Kg', 'g', 'L', 'Lata', 'Paquete'];
  protected readonly purchaseUnitOptions: PurchaseUnit[] = [
    'Pieza',
    'Caja',
    'Bulto',
    'Costal',
    'Paquete',
    'Charola',
    'Kg',
    'g',
    'L',
    'Lata',
  ];

  protected readonly categories = computed(() => [
    'Todos',
    ...new Set(this.inv.products().map((p) => p.category)),
  ]);

  protected readonly abcCounts = computed(() => {
    const all = this.inv.products().filter((p) => this.showInactive() || p.isActive !== false);
    return {
      all: all.length,
      A: all.filter((p) => p.abcClass === 'A').length,
      B: all.filter((p) => p.abcClass === 'B').length,
      C: all.filter((p) => p.abcClass === 'C').length,
    };
  });

  /** Productos sin código de fábrica o a granel para la hoja imprimible de mostrador. */
  protected readonly bulkProducts = computed(() =>
    this.inv
      .products()
      .filter(
        (p) =>
          p.isActive !== false &&
          (p.isBulk || p.hasInternalBarcode || p.barcode.startsWith('200')),
      ),
  );

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cat = this.category();
    const abc = this.abcFilter();
    const includeInactive = this.showInactive();
    return this.inv
      .products()
      .filter((p) => {
        if (!includeInactive && p.isActive === false) return false;
        const matchAbc = abc === 'ALL' || p.abcClass === abc;
        const matchCat = cat === 'Todos' || p.category === cat;
        const allCodes = getAllProductBarcodes(p);
        const matchSearch =
          !q ||
          p.name.toLowerCase().includes(q) ||
          allCodes.some((code) => code.toLowerCase().includes(q)) ||
          p.sku.toLowerCase().includes(q) ||
          (p.location || '').toLowerCase().includes(q);
        return matchAbc && matchCat && matchSearch;
      })
      .map((p) => ({
        ...p,
        allBarcodes: getAllProductBarcodes(p),
        tiers: normalizePriceTiers(p.salePrice, p.priceTiers),
        margin: marginPct(p.lastPurchaseCost, p.salePrice),
        daysLeft: this.daysLeft(p),
        belowRop: p.stock <= p.rop,
        costDiff: +(p.lastPurchaseCost - p.weightedAvgCost).toFixed(2),
        hasMovements: this.inv.hasProductKardexMovements(p.sku),
      }));
  });

  private daysLeft(p: Product): number {
    return Math.round(
      (new Date(p.fefoExpiryDate + 'T12:00:00').getTime() - TODAY.getTime()) / 86_400_000,
    );
  }

  protected fmtDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  protected onSearch(e: Event): void {
    this.search.set((e.target as HTMLInputElement).value);
  }

  protected clearSearch(): void {
    this.search.set('');
  }

  protected openBulkSheetModal(): void {
    this.bulkSheetModalOpen.set(true);
  }

  protected closeBulkSheetModal(): void {
    this.bulkSheetModalOpen.set(false);
  }

  protected printBulkSheet(): void {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  // ---------- Acciones de Alta, Edición y Baja Lógica (Bloque F1) ----------

  protected openCreateModal(): void {
    this.editingOriginalSku.set(null);
    this.formFeedback.set(null);
    this.formName.set('');
    this.formCategory.set('Abarrotes');
    this.formSku.set('');
    this.formSkuManuallyEdited.set(false);
    this.formLocation.set('Pasillo General');
    this.formSupplier.set('Proveedor General');
    this.formSaleUnit.set('Pieza');
    this.formPurchaseUnit.set('Caja');
    this.formUnitsPerPurchase.set(1);
    this.formPackageCost.set(0);
    this.formCost.set(15);
    this.formSalePrice.set(20);
    this.formIvaRate.set(0);
    this.formIepsRate.set(0);
    this.formExpiry.set('2027-12-31');
    this.formMinStock.set(5);
    this.formRop.set(5);
    this.formInitialStock.set(0);
    this.formAdminPin.set('');
    this.formIsBulk.set(false);
    this.formShrinkTolerancePct.set(0);
    this.formBarcodes.set([]);
    this.formNewBarcodeInput.set('');
    this.formUseInternalBarcode.set(false);
    this.formMedioMayoreoMinQty.set(6);
    this.formMedioMayoreoPrice.set(19);
    this.formMayoreoMinQty.set(12);
    this.formMayoreoPrice.set(18);
    this.productModalOpen.set(true);
  }

  protected openEditModal(p: Product): void {
    this.editingOriginalSku.set(p.sku);
    this.formFeedback.set(null);
    this.formName.set(p.name);
    this.formCategory.set(p.category);
    this.formSku.set(p.sku);
    this.formSkuManuallyEdited.set(true);
    this.formLocation.set(p.location || 'Pasillo General');
    this.formSupplier.set(p.supplier || 'Proveedor General');
    this.formSaleUnit.set(p.saleUnit);
    this.formPurchaseUnit.set(p.purchaseUnit);
    this.formUnitsPerPurchase.set(p.unitsPerPurchase || 1);
    this.formPackageCost.set(+(p.historicCost * (p.unitsPerPurchase || 1)).toFixed(2));
    this.formCost.set(p.historicCost);
    this.formSalePrice.set(p.salePrice);
    this.formIvaRate.set(p.ivaRate ?? 0);
    this.formIepsRate.set(p.iepsRate ?? 0);
    this.formExpiry.set(p.expiry);
    this.formMinStock.set(p.minStock);
    this.formRop.set(p.rop);
    this.formInitialStock.set(p.stock);
    this.formAdminPin.set('');
    this.formIsBulk.set(p.isBulk);
    this.formShrinkTolerancePct.set(p.naturalShrinkTolerancePct ?? (p.isBulk ? 3 : 0));
    this.formBarcodes.set([...getAllProductBarcodes(p)]);
    this.formNewBarcodeInput.set('');
    this.formUseInternalBarcode.set(Boolean(p.hasInternalBarcode));

    const tiers = normalizePriceTiers(p.salePrice, p.priceTiers);
    const medio = tiers.find((t) => t.tier === 'MEDIO_MAYOREO');
    const mayoreo = tiers.find((t) => t.tier === 'MAYOREO');
    this.formMedioMayoreoMinQty.set(medio ? medio.minQty : 6);
    this.formMedioMayoreoPrice.set(medio ? medio.unitPrice : p.salePrice);
    this.formMayoreoMinQty.set(mayoreo ? mayoreo.minQty : 12);
    this.formMayoreoPrice.set(mayoreo ? mayoreo.unitPrice : p.salePrice);
    this.productModalOpen.set(true);
  }

  protected closeProductModal(): void {
    this.productModalOpen.set(false);
    this.formFeedback.set(null);
  }

  protected onNameOrCategoryChange(): void {
    if (!this.editingOriginalSku() && !this.formSkuManuallyEdited()) {
      const suggested = this.inv.generateSuggestedInternalSku(
        this.formName(),
        this.formCategory(),
      );
      this.formSku.set(suggested);
    }
  }

  protected regenerateSuggestedSku(): void {
    const suggested = this.inv.generateSuggestedInternalSku(
      this.formName(),
      this.formCategory(),
    );
    this.formSku.set(suggested);
    this.formSkuManuallyEdited.set(false);
  }

  protected onSaleUnitChange(unit: SaleUnit): void {
    this.formSaleUnit.set(unit);
    if (unit === 'Kg' || unit === 'g' || unit === 'L') {
      this.formIsBulk.set(true);
      if (this.formShrinkTolerancePct() === 0) {
        this.formShrinkTolerancePct.set(3);
      }
    }
  }

  protected recalculateUnitCostFromPackage(): void {
    const pkgCost = Number(this.formPackageCost());
    const factor = Number(this.formUnitsPerPurchase()) || 1;
    if (pkgCost > 0 && factor > 0) {
      const unitCost = calculateUnitCostFromPurchasePackage(pkgCost, factor);
      this.formCost.set(unitCost);
    }
  }

  protected addBarcodeToList(): void {
    const code = this.formNewBarcodeInput().trim();
    if (!code) return;
    if (!this.formBarcodes().includes(code)) {
      this.formBarcodes.update((list) => [...list, code]);
    }
    this.formNewBarcodeInput.set('');
  }

  protected removeBarcodeFromList(code: string): void {
    this.formBarcodes.update((list) => list.filter((c) => c !== code));
  }

  protected generateAndAddInternalBarcode(): void {
    const internal = this.inv.generateNextInternalBarcode();
    if (!this.formBarcodes().includes(internal)) {
      this.formBarcodes.update((list) => [...list, internal]);
    }
    this.formUseInternalBarcode.set(true);
  }

  protected async saveProductForm(): Promise<void> {
    this.formFeedback.set(null);
    const baseSalePrice = Number(this.formSalePrice());
    const tiers: PriceTier[] = [
      { tier: 'MENUDEO', label: 'Menudeo', minQty: 1, unitPrice: baseSalePrice },
      {
        tier: 'MEDIO_MAYOREO',
        label: 'Medio Mayoreo',
        minQty: Math.max(1, Number(this.formMedioMayoreoMinQty()) || 6),
        unitPrice: Number(this.formMedioMayoreoPrice()) > 0 ? Number(this.formMedioMayoreoPrice()) : baseSalePrice,
      },
      {
        tier: 'MAYOREO',
        label: 'Mayoreo',
        minQty: Math.max(1, Number(this.formMayoreoMinQty()) || 12),
        unitPrice: Number(this.formMayoreoPrice()) > 0 ? Number(this.formMayoreoPrice()) : baseSalePrice,
      },
    ];

    const pendingCode = this.formNewBarcodeInput().trim();
    const barcodes = [...this.formBarcodes()];
    if (pendingCode && !barcodes.includes(pendingCode)) {
      barcodes.push(pendingCode);
    }

    const editSku = this.editingOriginalSku();
    if (editSku) {
      const res = await this.inv.updateCatalogProduct(editSku, {
        name: this.formName(),
        sku: this.formSku(),
        category: this.formCategory(),
        location: this.formLocation(),
        supplier: this.formSupplier(),
        saleUnit: this.formSaleUnit(),
        purchaseUnit: this.formPurchaseUnit(),
        unitsPerPurchase: Number(this.formUnitsPerPurchase()),
        cost: Number(this.formCost()),
        salePrice: baseSalePrice,
        ivaRate: Number(this.formIvaRate()),
        iepsRate: Number(this.formIepsRate()),
        expiry: this.formExpiry(),
        minStock: Number(this.formMinStock()),
        rop: Number(this.formRop()),
        isBulk: this.formIsBulk(),
        naturalShrinkTolerancePct: Number(this.formShrinkTolerancePct()),
        barcodes,
        useInternalBarcode: this.formUseInternalBarcode(),
        priceTiers: tiers,
      });
      if (!res.ok) {
        this.formFeedback.set({ ok: false, message: res.message });
        return;
      }
      this.catalogBanner.set({ ok: true, message: res.message });
      this.closeProductModal();
      return;
    }

    const res = await this.inv.createCatalogProduct(
      {
        name: this.formName(),
        sku: this.formSku(),
        category: this.formCategory(),
        location: this.formLocation(),
        supplier: this.formSupplier(),
        saleUnit: this.formSaleUnit(),
        purchaseUnit: this.formPurchaseUnit(),
        unitsPerPurchase: Number(this.formUnitsPerPurchase()),
        cost: Number(this.formCost()),
        salePrice: baseSalePrice,
        ivaRate: Number(this.formIvaRate()),
        iepsRate: Number(this.formIepsRate()),
        expiry: this.formExpiry(),
        minStock: Number(this.formMinStock()),
        rop: Number(this.formRop()),
        initialStock: Number(this.formInitialStock()),
        isBulk: this.formIsBulk(),
        naturalShrinkTolerancePct: Number(this.formShrinkTolerancePct()),
        barcodes,
        useInternalBarcode: this.formUseInternalBarcode(),
        priceTiers: tiers,
      },
      this.formAdminPin(),
    );

    if (!res.ok) {
      this.formFeedback.set({ ok: false, message: res.message });
      return;
    }
    this.catalogBanner.set({ ok: true, message: res.message });
    this.closeProductModal();
  }

  protected async deactivateProduct(p: Product): Promise<void> {
    const res = await this.inv.deactivateOrDeleteCatalogProduct(p.sku);
    this.catalogBanner.set({ ok: res.ok, message: res.message });
  }

  protected async reactivateProduct(p: Product): Promise<void> {
    const res = await this.inv.reactivateCatalogProduct(p.sku);
    this.catalogBanner.set({ ok: res.ok, message: res.message });
  }

  protected async assignInternalCode(p: Product): Promise<void> {
    const res = await this.inv.assignInternalBarcodeToProduct(p.sku);
    this.catalogBanner.set({ ok: res.ok, message: res.message });
  }

  // ---------- Aprobación de Productos Móviles ----------

  protected openApprovalModal(p: Product): void {
    this.approvingProduct.set(p);
    this.approvalPrice.set(p.salePrice);
    this.approvalCost.set(p.unitCost ?? p.historicCost ?? 0);
    this.approvalPin.set('');
    this.approvalFeedback.set(null);
    this.approvalModalOpen.set(true);
  }

  protected closeApprovalModal(): void {
    this.approvalModalOpen.set(false);
    this.approvingProduct.set(null);
    this.approvalFeedback.set(null);
  }

  protected async confirmApproval(): Promise<void> {
    const prod = this.approvingProduct();
    if (!prod) return;
    const pin = this.approvalPin().trim();
    if (!pin) {
      this.approvalFeedback.set({ ok: false, message: 'Ingresa el PIN de administrador o encargado.' });
      return;
    }
    const res = await this.inv.approvePendingProduct(prod.sku, {
      pin,
      newPrice: Number(this.approvalPrice()) || prod.salePrice,
      newCost: Number(this.approvalCost()) >= 0 ? Number(this.approvalCost()) : prod.unitCost,
    });
    if (res.ok) {
      this.catalogBanner.set({ ok: true, message: res.message });
      this.closeApprovalModal();
    } else {
      this.approvalFeedback.set({ ok: false, message: res.message });
    }
  }

  protected async rejectProduct(prod: Product): Promise<void> {
    const res = await this.inv.rejectPendingProduct(prod.sku);
    this.catalogBanner.set({ ok: res.ok, message: res.message });
  }

  /**
   * Genera barras determinísticas estilo EAN-13 a partir de los 13 dígitos del código
   * para renderizar un SVG nítido listo para escanear o imprimir en hoja carta.
   */
  protected buildBarcodeBars(barcode: string): { x: number; w: number; tall: boolean }[] {
    const bars: { x: number; w: number; tall: boolean }[] = [
      { x: 4, w: 1.5, tall: true },
      { x: 7, w: 1.5, tall: true },
    ];
    let cursor = 11;
    for (let i = 0; i < barcode.length; i++) {
      const digit = Number(barcode[i]) || 0;
      const w1 = (digit % 3) + 1;
      const gap1 = ((digit + 1) % 2) + 1.2;
      const w2 = ((digit + 2) % 3) + 1;
      bars.push({ x: cursor, w: w1, tall: false });
      cursor += w1 + gap1;
      bars.push({ x: cursor, w: w2, tall: false });
      cursor += w2 + 1.5;
      if (i === 5) {
        bars.push({ x: cursor, w: 1.2, tall: true });
        bars.push({ x: cursor + 2.5, w: 1.2, tall: true });
        cursor += 6;
      }
    }
    bars.push({ x: cursor, w: 1.5, tall: true });
    bars.push({ x: cursor + 3, w: 1.5, tall: true });
    return bars;
  }
}
