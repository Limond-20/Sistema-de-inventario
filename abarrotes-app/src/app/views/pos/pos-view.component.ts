import { Component, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import {
  CreditCustomer,
  MockInventoryService,
  PosSaleItem,
  PriceTierCode,
  Product,
} from '../../services/mock-inventory.service';
import {
  parseMoney,
  sumMoney,
  subtractMoney,
  multiplyMoney,
} from '../../domain/money';
import { getAllProductBarcodes } from '../../domain/catalog';

type BulkCalcMode = 'weight' | 'amount';

@Component({
  selector: 'app-pos-view',
  imports: [CommonModule, CurrencyPipe, DecimalPipe, FormsModule, RouterModule],
  templateUrl: './pos-view.component.html',
})
export class PosViewComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  private readonly zone = inject(NgZone);
  private readonly route = inject(ActivatedRoute);

  // ---------- Búsqueda y Feedback ----------
  protected readonly searchQuery = signal<string>('');
  protected readonly syncNotification = signal<string | null>(null);
  protected readonly saleFeedback = signal<{ ok: boolean; text: string } | null>(null);

  // ---------- Carrito Activo ----------
  protected readonly cart = signal<PosSaleItem[]>([
    {
      sku: 'LAC-LAL-1L',
      barcode: '7501020515350',
      name: 'Leche Lala Entera 1L',
      emoji: '',
      saleUnit: 'Pieza',
      isBulk: false,
      qty: 2,
      unitPrice: 26.0,
      subtotal: 52.0,
      selectedTier: 'MENUDEO',
      discountPct: 0,
    },
    {
      sku: 'QUE-FRE-1K',
      barcode: '2000002000013',
      name: 'Queso Fresco Local (1 kg)',
      emoji: '',
      saleUnit: 'Kg',
      isBulk: true,
      qty: 0.263,
      unitPrice: 95.0,
      subtotal: 25.0,
      selectedTier: 'MENUDEO',
      discountPct: 0,
    },
  ]);

  // ---------- Descuentos por Ticket y Autorización PIN (Bloque F1.3) ----------
  protected readonly ticketDiscountPct = signal<number>(0);
  protected readonly discountAuthPin = signal<string>('');
  protected readonly discountCapModalOpen = signal<boolean>(false);
  protected readonly newMaxDiscountCap = signal<number>(10);
  protected readonly discountCapAdminPin = signal<string>('');
  protected readonly discountCapFeedback = signal<{ ok: boolean; message: string } | null>(null);

  // ---------- Modal Calculadora Dual de Granel ----------
  protected readonly bulkModalProduct = signal<Product | null>(null);
  protected readonly bulkMode = signal<BulkCalcMode>('amount');
  protected readonly bulkWeightKg = signal<number>(0.5);
  protected readonly bulkAmountPesos = signal<number>(25);

  // ---------- Modal Cobro en Efectivo ----------
  protected readonly cashModalOpen = signal<boolean>(false);
  protected readonly cashReceived = signal<number>(100);

  // ---------- Modal Libreta Digital de Fiado y Abonos ----------
  protected readonly creditModalOpen = signal<boolean>(false);
  protected readonly selectedCustomerId = signal<string>('CLI-01');
  protected readonly abonoCustomerId = signal<string>('CLI-03');
  protected readonly abonoAmount = signal<number>(200);
  protected readonly abonoFeedback = signal<string | null>(null);

  // ---------- Modal Consumo Interno ----------
  protected readonly internalConsumptionModalOpen = signal<boolean>(false);
  protected readonly consumptionResponsible = signal<string>('Dueño (Don Lupe)');
  protected readonly consumptionPin = signal<string>('');
  protected readonly consumptionReason = signal<string>('');
  protected readonly hasExceedingStockItems = computed(() => {
    const catalog = this.inv.products();
    return this.cart().some((item) => {
      const p = catalog.find((x) => x.sku === item.sku);
      return p ? item.qty > p.stock : false;
    });
  });
  protected readonly responsibleOptions: string[] = [
    'Dueño (Don Lupe)',
    'Empleado 1 (Toño)',
    'Personal de Mostrador',
  ];

  private syncChannel: BroadcastChannel | null = null;
  private readonly storageListener = (ev: StorageEvent) => {
    if (ev.key === 'abarrotes_lan_last_event' && ev.newValue) {
      try {
        const payload = JSON.parse(ev.newValue);
        this.zone.run(() => this.onExternalBarcodeEvent(payload));
      } catch {
        // ignore invalid json
      }
    }
  };

  // ---------- Accesos Rápidos en Carrusel ----------
  protected readonly quickAccessProducts = computed(() => {
    const pinnedSet = new Set(this.inv.pinnedQuickAccessSkus());
    return this.inv
      .products()
      .filter((p) => p.isActive !== false && p.approvalStatus !== 'PENDIENTE_APROBACION' && pinnedSet.has(p.sku));
  });

  // ---------- Lista Completa de Productos Activos ----------
  protected readonly displayedProducts = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const all = this.inv
      .products()
      .filter((p) => p.isActive !== false && p.approvalStatus !== 'PENDIENTE_APROBACION');
    if (!q) return all;
    return all.filter((p) => {
      const codes = getAllProductBarcodes(p);
      return (
        p.name.toLowerCase().includes(q) ||
        codes.some((c) => c.toLowerCase().includes(q)) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  });

  // ---------- Evaluación de Descuentos por Línea y por Ticket (Bloque F1.3) ----------
  protected readonly cartDiscountEvaluation = computed(() =>
    this.inv.evaluatePosCartDiscounts(this.cart(), this.ticketDiscountPct()),
  );

  protected readonly hasAnyDiscount = computed(
    () => this.cartDiscountEvaluation().totalDiscountCents > 0,
  );

  // ---------- Computadas del Carrito ----------
  protected readonly cartGrossTotal = computed(() =>
    sumMoney(this.cart().map((item) => item.subtotal)),
  );

  protected readonly cartTotal = computed(() =>
    this.cartDiscountEvaluation().finalTotal,
  );

  protected readonly cartItemsCount = computed(() => this.cart().length);

  // ---------- Computadas Calculadora Granel ----------
  protected readonly calculatedBulkKg = computed(() => {
    const prod = this.bulkModalProduct();
    if (!prod) return 0;
    if (this.bulkMode() === 'weight') {
      return Math.max(0.01, +Number(this.bulkWeightKg() || 0).toFixed(3));
    }
    const pesos = Math.max(1, parseMoney(this.bulkAmountPesos() || 0));
    return +(pesos / prod.salePrice).toFixed(3);
  });

  protected readonly calculatedBulkGrams = computed(() =>
    Math.round(this.calculatedBulkKg() * 1000),
  );

  protected readonly calculatedBulkSubtotal = computed(() => {
    const prod = this.bulkModalProduct();
    if (!prod) return 0;
    if (this.bulkMode() === 'amount') {
      return Math.max(1, parseMoney(this.bulkAmountPesos() || 0));
    }
    return multiplyMoney(prod.salePrice, this.calculatedBulkKg());
  });

  // ---------- Computadas Efectivo y Cambio ----------
  protected readonly cashChange = computed(() => {
    const received = parseMoney(this.cashReceived() || 0);
    return subtractMoney(received, this.cartTotal());
  });

  protected readonly canConfirmCash = computed(
    () => this.cart().length > 0 && parseMoney(this.cashReceived() || 0) >= this.cartTotal(),
  );

  // ---------- Computadas Fiado (Crédito) ----------
  protected readonly selectedCustomer = computed<CreditCustomer | undefined>(() =>
    this.inv.creditCustomers().find((c) => c.id === this.selectedCustomerId()),
  );

  protected readonly creditValidation = computed(() => {
    const customer = this.selectedCustomer();
    const total = this.cartTotal();
    if (!customer) {
      return { allowed: false, reason: 'Selecciona un cliente de la lista.' };
    }
    const available = subtractMoney(customer.creditLimit, customer.currentBalance);
    const projectedBalance = sumMoney([customer.currentBalance, total]);

    if (customer.status === 'VENCIDO') {
      return {
        allowed: false,
        available,
        projectedBalance,
        reason: `BLOQUEADO POR SALDO VENCIDO: ${customer.name} tiene una deuda vencida de $${customer.currentBalance.toFixed(2)} desde el ${customer.dueDate}. Debe registrar un abono antes de llevar más mercancía fiada.`,
      };
    }

    if (projectedBalance > customer.creditLimit) {
      return {
        allowed: false,
        available,
        projectedBalance,
        reason: `REBASA EL LÍMITE DE CRÉDITO: La cuenta actual es de $${total.toFixed(2)}, pero ${customer.name} solo tiene $${Math.max(0, available).toFixed(2)} disponibles (Límite: $${customer.creditLimit.toFixed(2)}).`,
      };
    }

    return {
      allowed: true,
      available,
      projectedBalance,
      reason: `Crédito aprobado. Nuevo saldo de ${customer.name}: $${projectedBalance.toFixed(2)} de $${customer.creditLimit.toFixed(2)}.`,
    };
  });

  ngOnInit(): void {
    this.route.queryParams.subscribe((params) => {
      if (params['tab'] === 'fiados') {
        this.openCreditModal();
      }
    });

    if (typeof BroadcastChannel !== 'undefined') {
      this.syncChannel = new BroadcastChannel('abarrotes_lan_sync');
      this.syncChannel.onmessage = (event) => {
        this.zone.run(() => this.onExternalBarcodeEvent(event.data));
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

  isPinned(sku: string): boolean {
    return this.inv.pinnedQuickAccessSkus().includes(sku);
  }

  togglePin(sku: string, ev?: Event): void {
    if (ev) ev.stopPropagation();
    if (this.isPinned(sku)) {
      this.inv.unpinProductQuickAccess(sku);
    } else {
      this.inv.pinProductQuickAccess(sku);
    }
  }

  pinSuggestion(sku: string): void {
    this.inv.pinProductQuickAccess(sku);
  }

  dismissSuggestion(sku: string): void {
    this.inv.dismissQuickAccessSuggestion(sku);
  }

  private onExternalBarcodeEvent(data: Record<string, unknown>): void {
    if (!data || data['type'] !== 'BARCODE_SCANNED') return;
    const code = String(data['barcode'] ?? '').trim();
    const product = this.inv.findProductByBarcode(code);
    if (!product) return;

    this.inv.phoneLinked.set(true);
    if (product.isBulk && product.saleUnit === 'Kg') {
      this.openBulkCalculator(product);
      this.syncNotification.set(
        `Código de granel recibido (${product.barcode}): Indica kilos o pesos a despachar de ${product.name}.`,
      );
    } else {
      this.addUnitToCart(product, 1);
      this.syncNotification.set(
        `Escaneado desde el celular: +1 ${product.name} ($${product.salePrice.toFixed(2)}) agregado al ticket.`,
      );
    }
  }

  // ---------- Acciones del Escáner / Buscador ----------
  onSearchOrBarcodeSubmit(): void {
    const q = this.searchQuery().trim();
    if (!q) return;
    const exactBarcode = this.inv.findProductByBarcode(q);
    if (exactBarcode) {
      this.onProductCardClick(exactBarcode);
      this.searchQuery.set('');
      return;
    }
    const matches = this.displayedProducts();
    if (matches.length === 1) {
      this.onProductCardClick(matches[0]);
      this.searchQuery.set('');
    }
  }

  // ---------- Selección de Producto ----------
  onProductCardClick(product: Product): void {
    if (product.approvalStatus === 'PENDIENTE_APROBACION') return;
    this.saleFeedback.set(null);
    if (product.isBulk && product.saleUnit === 'Kg') {
      this.openBulkCalculator(product);
    } else {
      this.addUnitToCart(product, 1);
    }
  }

  openBulkCalculator(product: Product): void {
    this.bulkModalProduct.set(product);
    this.bulkMode.set('amount');
    this.bulkAmountPesos.set(25);
    this.bulkWeightKg.set(0.5);
  }

  closeBulkCalculator(): void {
    this.bulkModalProduct.set(null);
  }

  setPresetWeight(kg: number): void {
    this.bulkMode.set('weight');
    this.bulkWeightKg.set(kg);
  }

  setPresetAmount(pesos: number): void {
    this.bulkMode.set('amount');
    this.bulkAmountPesos.set(pesos);
  }

  confirmBulkItem(): void {
    const prod = this.bulkModalProduct();
    if (!prod) return;
    const qtyKg = this.calculatedBulkKg();
    const subtotal = this.calculatedBulkSubtotal();
    if (qtyKg <= 0 || subtotal <= 0) return;

    this.cart.update((list) => {
      const existing = list.find((i) => i.sku === prod.sku);
      if (existing) {
        const nextQty = +(existing.qty + qtyKg).toFixed(3);
        const nextSub = sumMoney([existing.subtotal, subtotal]);
        return list.map((i) => (i.sku === prod.sku ? { ...i, qty: nextQty, subtotal: nextSub } : i));
      }
      return [
        ...list,
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: '',
          saleUnit: prod.saleUnit,
          isBulk: prod.isBulk,
          qty: qtyKg,
          unitPrice: prod.salePrice,
          subtotal,
          selectedTier: 'MENUDEO',
          discountPct: 0,
        },
      ];
    });

    this.closeBulkCalculator();
  }

  addUnitToCart(product: Product, delta = 1): void {
    if (product.approvalStatus === 'PENDIENTE_APROBACION') return;
    this.cart.update((list) => {
      const existing = list.find((i) => i.sku === product.sku);
      if (existing) {
        const nextQty = +(existing.qty + delta).toFixed(3);
        if (nextQty <= 0) {
          return list.filter((i) => i.sku !== product.sku);
        }
        const resolved = this.inv.resolveProductUnitPriceForQty(product.sku, nextQty);
        const nextSub = multiplyMoney(resolved.unitPrice, nextQty);
        return list.map((i) =>
          i.sku === product.sku
            ? {
                ...i,
                qty: nextQty,
                unitPrice: resolved.unitPrice,
                selectedTier: resolved.appliedTier,
                subtotal: nextSub,
              }
            : i,
        );
      }
      if (delta <= 0) return list;
      const resolved = this.inv.resolveProductUnitPriceForQty(product.sku, delta);
      return [
        ...list,
        {
          sku: product.sku,
          barcode: product.barcode,
          name: product.name,
          emoji: '',
          saleUnit: product.saleUnit,
          isBulk: product.isBulk,
          qty: delta,
          unitPrice: resolved.unitPrice,
          subtotal: multiplyMoney(resolved.unitPrice, delta),
          selectedTier: resolved.appliedTier,
          discountPct: 0,
        },
      ];
    });
  }

  updateCartQty(sku: string, delta: number): void {
    const item = this.cart().find((i) => i.sku === sku);
    if (!item) return;
    const step = item.isBulk && item.saleUnit === 'Kg' ? 0.25 : 1;
    const nextQty = +(item.qty + delta * step).toFixed(3);

    if (nextQty <= 0) {
      this.removeFromCart(sku);
      return;
    }

    const resolved = this.inv.resolveProductUnitPriceForQty(sku, nextQty);
    this.cart.update((list) =>
      list.map((i) =>
        i.sku === sku
          ? {
              ...i,
              qty: nextQty,
              unitPrice: resolved.unitPrice,
              selectedTier: resolved.appliedTier,
              subtotal: multiplyMoney(resolved.unitPrice, nextQty),
            }
          : i,
      ),
    );
  }

  /**
   * Selector manual de nivel de precio escalonado en el POS (Menudeo, Medio Mayoreo, Mayoreo).
   */
  setCartItemPriceTier(sku: string, tier: PriceTierCode): void {
    const item = this.cart().find((i) => i.sku === sku);
    if (!item) return;
    const resolved = this.inv.resolveProductUnitPriceForQty(sku, item.qty, tier);
    this.cart.update((list) =>
      list.map((i) =>
        i.sku === sku
          ? {
              ...i,
              selectedTier: resolved.appliedTier,
              unitPrice: resolved.unitPrice,
              subtotal: multiplyMoney(resolved.unitPrice, i.qty),
            }
          : i,
      ),
    );
  }

  /**
   * Asigna porcentaje de descuento por línea en el carrito del POS.
   */
  setCartItemDiscountPct(sku: string, pct: number): void {
    const cleanPct = Math.max(0, Math.min(100, Number(pct) || 0));
    this.cart.update((list) =>
      list.map((i) => (i.sku === sku ? { ...i, discountPct: cleanPct } : i)),
    );
  }

  setTicketDiscount(pct: number): void {
    const cleanPct = Math.max(0, Math.min(100, Number(pct) || 0));
    this.ticketDiscountPct.set(cleanPct);
  }

  openDiscountCapModal(): void {
    this.newMaxDiscountCap.set(this.inv.maxDiscountPctWithoutPin());
    this.discountCapAdminPin.set('');
    this.discountCapFeedback.set(null);
    this.discountCapModalOpen.set(true);
  }

  closeDiscountCapModal(): void {
    this.discountCapModalOpen.set(false);
    this.discountCapFeedback.set(null);
  }

  async saveDiscountCap(): Promise<void> {
    const res = await this.inv.setMaxDiscountPctWithoutPin(
      Number(this.newMaxDiscountCap()),
      this.discountCapAdminPin(),
    );
    this.discountCapFeedback.set({ ok: res.ok, message: res.message });
    if (res.ok) {
      this.closeDiscountCapModal();
    }
  }

  adjustCartItemQty(item: PosSaleItem, delta: number): void {
    this.updateCartQty(item.sku, delta);
  }

  removeFromCart(sku: string): void {
    this.cart.update((list) => list.filter((i) => i.sku !== sku));
  }

  removeCartItem(sku: string): void {
    this.removeFromCart(sku);
  }

  clearCart(): void {
    this.cart.set([]);
    this.ticketDiscountPct.set(0);
    this.discountAuthPin.set('');
    this.saleFeedback.set(null);
  }

  // ---------- Modal Efectivo ----------
  openCashModal(): void {
    if (!this.cart().length) return;
    const total = this.cartTotal();
    const suggestedBills = [50, 100, 200, 500].find((b) => b >= total) ?? Math.ceil(total);
    this.cashReceived.set(suggestedBills);
    this.discountAuthPin.set('');
    this.cashModalOpen.set(true);
  }

  closeCashModal(): void {
    this.cashModalOpen.set(false);
  }

  setCashExact(): void {
    this.cashReceived.set(this.cartTotal());
  }

  setExactCash(): void {
    this.setCashExact();
  }

  setCashBill(amount: number): void {
    this.cashReceived.set(amount);
  }

  async confirmCashSale(): Promise<void> {
    if (!this.canConfirmCash()) return;
    const evalRes = this.cartDiscountEvaluation();
    if (evalRes.totalDiscountCents > 0 || evalRes.requiresPin) {
      const res = await this.inv.processSaleWithDiscounts({
        items: this.cart(),
        ticketDiscountPct: this.ticketDiscountPct(),
        paymentType: 'EFECTIVO',
        cashReceived: parseMoney(this.cashReceived() || 0),
        pin: this.discountAuthPin(),
      });
      if (res.ok) {
        this.saleFeedback.set({ ok: true, text: res.message });
        this.cart.set([]);
        this.ticketDiscountPct.set(0);
        this.discountAuthPin.set('');
        this.closeCashModal();
      } else {
        this.saleFeedback.set({ ok: false, text: res.message });
      }
      return;
    }

    const res = this.inv.processCashSale(this.cart(), parseMoney(this.cashReceived() || 0));
    if (res.ok) {
      this.saleFeedback.set({ ok: true, text: res.message });
      this.cart.set([]);
      this.ticketDiscountPct.set(0);
      this.closeCashModal();
    } else {
      this.saleFeedback.set({ ok: false, text: res.message });
    }
  }

  // ---------- Modal Fiado ----------
  openCreditModal(): void {
    this.discountAuthPin.set('');
    this.creditModalOpen.set(true);
    this.abonoFeedback.set(null);
  }

  selectCustomerForFiado(id: string): void {
    this.selectedCustomerId.set(id);
  }

  closeCreditModal(): void {
    this.creditModalOpen.set(false);
  }

  async confirmCreditSale(): Promise<void> {
    const val = this.creditValidation();
    if (!val.allowed) return;
    const customer = this.selectedCustomer();
    if (!customer) return;

    const evalRes = this.cartDiscountEvaluation();
    if (evalRes.totalDiscountCents > 0 || evalRes.requiresPin) {
      const res = await this.inv.processSaleWithDiscounts({
        items: this.cart(),
        ticketDiscountPct: this.ticketDiscountPct(),
        paymentType: 'FIADO',
        customerId: customer.id,
        pin: this.discountAuthPin(),
      });
      if (res.ok) {
        this.saleFeedback.set({ ok: true, text: res.message });
        this.cart.set([]);
        this.ticketDiscountPct.set(0);
        this.discountAuthPin.set('');
        this.closeCreditModal();
      } else {
        this.saleFeedback.set({ ok: false, text: res.message });
      }
      return;
    }

    const res = this.inv.processCreditSale(this.cart(), customer.id);
    if (res.ok) {
      this.saleFeedback.set({ ok: true, text: res.message });
      this.cart.set([]);
      this.ticketDiscountPct.set(0);
      this.closeCreditModal();
    } else {
      this.saleFeedback.set({ ok: false, text: res.message });
    }
  }

  // ---------- Modal Consumo Interno ----------
  openInternalConsumptionModal(): void {
    if (!this.cart().length) return;
    this.internalConsumptionModalOpen.set(true);
  }

  closeInternalConsumptionModal(): void {
    this.internalConsumptionModalOpen.set(false);
  }

  async confirmInternalConsumption(): Promise<void> {
    if (!this.cart().length) return;
    const res = await this.inv.processInternalConsumption(
      this.cart(),
      this.consumptionResponsible(),
      this.consumptionPin(),
      this.consumptionReason(),
    );
    if (res.ok) {
      this.saleFeedback.set({ ok: true, text: res.message });
      this.cart.set([]);
      this.consumptionPin.set('');
      this.consumptionReason.set('');
      this.closeInternalConsumptionModal();
    } else {
      this.saleFeedback.set({ ok: false, text: res.message });
    }
  }

  executeAbono(): void {
    const customerId = this.abonoCustomerId();
    const amount = parseMoney(this.abonoAmount());
    const res = this.inv.registerCreditPayment(customerId, amount);
    this.abonoFeedback.set(res.message);
  }

  submitCustomerAbono(): void {
    this.executeAbono();
  }
}
