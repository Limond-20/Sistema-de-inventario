import { Component, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  CreditCustomer,
  MockInventoryService,
  PosSaleItem,
  Product,
} from '../../services/mock-inventory.service';

type CatalogTab = 'bulk' | 'all';
type BulkCalcMode = 'weight' | 'amount';

@Component({
  selector: 'app-pos-view',
  imports: [CommonModule, CurrencyPipe, DecimalPipe, FormsModule, RouterModule],
  templateUrl: './pos-view.component.html',
})
export class PosViewComponent implements OnInit, OnDestroy {
  protected readonly inv = inject(MockInventoryService);
  private readonly zone = inject(NgZone);

  // ---------- Pestañas y Búsqueda ----------
  protected readonly activeTab = signal<CatalogTab>('bulk');
  protected readonly searchQuery = signal<string>('');
  protected readonly syncNotification = signal<string | null>(null);
  protected readonly saleFeedback = signal<{ ok: boolean; text: string } | null>(null);

  // ---------- Carrito Activo ----------
  protected readonly cart = signal<PosSaleItem[]>([
    {
      sku: 'LAC-LAL-1L',
      barcode: '7501020515350',
      name: 'Leche Lala Entera 1L',
      emoji: '🥛',
      saleUnit: 'Pieza',
      isBulk: false,
      qty: 2,
      unitPrice: 26.0,
      subtotal: 52.0,
    },
    {
      sku: 'QUE-FRE-1K',
      barcode: '2000002000013',
      name: 'Queso Fresco Local (1 kg)',
      emoji: '🧀',
      saleUnit: 'Kg',
      isBulk: true,
      qty: 0.263,
      unitPrice: 95.0,
      subtotal: 25.0,
    },
  ]);

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

  // ---------- Computadas del Catálogo ----------
  protected readonly displayedProducts = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const tab = this.activeTab();
    return this.inv.products().filter((p) => {
      const matchesTab = tab === 'all' ? true : p.isBulk || p.abcClass === 'A';
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.barcode.includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q);
      return matchesTab && matchesSearch;
    });
  });

  // ---------- Computadas del Carrito ----------
  protected readonly cartTotal = computed(() =>
    +this.cart().reduce((sum, item) => sum + item.subtotal, 0).toFixed(2),
  );

  protected readonly cartItemsCount = computed(() => this.cart().length);

  // ---------- Computadas Calculadora Granel ----------
  protected readonly calculatedBulkKg = computed(() => {
    const prod = this.bulkModalProduct();
    if (!prod) return 0;
    if (this.bulkMode() === 'weight') {
      return Math.max(0.01, +Number(this.bulkWeightKg() || 0).toFixed(3));
    }
    const pesos = Math.max(1, Number(this.bulkAmountPesos() || 0));
    return +(pesos / prod.salePrice).toFixed(3);
  });

  protected readonly calculatedBulkGrams = computed(() =>
    Math.round(this.calculatedBulkKg() * 1000),
  );

  protected readonly calculatedBulkSubtotal = computed(() => {
    const prod = this.bulkModalProduct();
    if (!prod) return 0;
    if (this.bulkMode() === 'amount') {
      return Math.max(1, +Number(this.bulkAmountPesos() || 0).toFixed(2));
    }
    return +(this.calculatedBulkKg() * prod.salePrice).toFixed(2);
  });

  // ---------- Computadas Efectivo y Cambio ----------
  protected readonly cashChange = computed(() =>
    +((Number(this.cashReceived()) || 0) - this.cartTotal()).toFixed(2),
  );

  protected readonly canConfirmCash = computed(
    () => this.cart().length > 0 && (Number(this.cashReceived()) || 0) >= this.cartTotal(),
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
    const available = +(customer.creditLimit - customer.currentBalance).toFixed(2);
    const projectedBalance = +(customer.currentBalance + total).toFixed(2);

    if (customer.status === 'VENCIDO') {
      return {
        allowed: false,
        available,
        projectedBalance,
        reason: `🚫 BLOQUEADO POR SALDO VENCIDO: ${customer.name} tiene una deuda vencida de $${customer.currentBalance.toFixed(2)} desde el ${customer.dueDate}. Debe registrar un abono antes de llevar más mercancía fiada.`,
      };
    }

    if (projectedBalance > customer.creditLimit) {
      return {
        allowed: false,
        available,
        projectedBalance,
        reason: `🚫 REBASA EL LÍMITE DE CRÉDITO: La cuenta actual es de $${total.toFixed(2)}, pero ${customer.name} solo tiene $${Math.max(0, available).toFixed(2)} disponibles (Límite: $${customer.creditLimit.toFixed(2)}).`,
      };
    }

    return {
      allowed: true,
      available,
      projectedBalance,
      reason: `✅ Crédito aprobado. Nuevo saldo de ${customer.name}: $${projectedBalance.toFixed(2)} de $${customer.creditLimit.toFixed(2)}.`,
    };
  });

  ngOnInit(): void {
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

  private onExternalBarcodeEvent(data: Record<string, unknown>): void {
    if (!data || data['type'] !== 'BARCODE_SCANNED') return;
    const code = String(data['barcode'] ?? '').trim();
    const product = this.inv.findProductByBarcode(code);
    if (!product) return;

    this.inv.phoneLinked.set(true);
    if (product.isBulk && product.saleUnit === 'Kg') {
      this.openBulkCalculator(product);
      this.syncNotification.set(
        `📱 Código de granel recibido (${product.barcode}): Indica los kilos o pesos ($) a despachar de ${product.name}.`,
      );
    } else {
      this.addUnitToCart(product, 1);
      this.syncNotification.set(
        `📱 Escaneado desde el celular: +1 ${product.emoji} ${product.name} ($${product.salePrice.toFixed(2)}) agregado al ticket.`,
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
        const nextSub = +(existing.subtotal + subtotal).toFixed(2);
        return list.map((i) => (i.sku === prod.sku ? { ...i, qty: nextQty, subtotal: nextSub } : i));
      }
      return [
        ...list,
        {
          sku: prod.sku,
          barcode: prod.barcode,
          name: prod.name,
          emoji: prod.emoji,
          saleUnit: prod.saleUnit,
          isBulk: prod.isBulk,
          qty: qtyKg,
          unitPrice: prod.salePrice,
          subtotal,
        },
      ];
    });

    this.closeBulkCalculator();
  }

  addUnitToCart(product: Product, delta = 1): void {
    this.cart.update((list) => {
      const existing = list.find((i) => i.sku === product.sku);
      if (existing) {
        const nextQty = +(existing.qty + delta).toFixed(3);
        if (nextQty <= 0) {
          return list.filter((i) => i.sku !== product.sku);
        }
        return list.map((i) =>
          i.sku === product.sku
            ? {
                ...i,
                qty: nextQty,
                subtotal: +(nextQty * i.unitPrice).toFixed(2),
              }
            : i,
        );
      }
      if (delta <= 0) return list;
      return [
        ...list,
        {
          sku: product.sku,
          barcode: product.barcode,
          name: product.name,
          emoji: product.emoji,
          saleUnit: product.saleUnit,
          isBulk: product.isBulk,
          qty: delta,
          unitPrice: product.salePrice,
          subtotal: +(delta * product.salePrice).toFixed(2),
        },
      ];
    });
  }

  adjustCartItemQty(item: PosSaleItem, delta: number): void {
    const step = item.saleUnit === 'Kg' ? 0.25 * delta : delta;
    const nextQty = +(item.qty + step).toFixed(3);
    if (nextQty <= 0) {
      this.removeCartItem(item.sku);
      return;
    }
    this.cart.update((list) =>
      list.map((i) =>
        i.sku === item.sku
          ? {
              ...i,
              qty: nextQty,
              subtotal: +(nextQty * i.unitPrice).toFixed(2),
            }
          : i,
      ),
    );
  }

  removeCartItem(sku: string): void {
    this.cart.update((list) => list.filter((i) => i.sku !== sku));
  }

  clearCart(): void {
    this.cart.set([]);
  }

  // ---------- Flujo Cobro en Efectivo ----------
  openCashModal(): void {
    if (!this.cart().length) return;
    const total = this.cartTotal();
    const suggestedBill =
      total <= 50 ? 50 : total <= 100 ? 100 : total <= 200 ? 200 : total <= 500 ? 500 : Math.ceil(total / 100) * 100;
    this.cashReceived.set(suggestedBill);
    this.cashModalOpen.set(true);
  }

  closeCashModal(): void {
    this.cashModalOpen.set(false);
  }

  setExactCash(): void {
    this.cashReceived.set(this.cartTotal());
  }

  confirmCashSale(): void {
    if (!this.canConfirmCash()) return;
    const change = this.cashChange();
    const result = this.inv.processSale(this.cart(), 'EFECTIVO');
    if (result.ok) {
      this.cart.set([]);
      this.cashModalOpen.set(false);
      this.saleFeedback.set({
        ok: true,
        text: `💵 ${result.message} Cambio entregado al cliente: $${change.toFixed(2)}.`,
      });
    }
  }

  // ---------- Flujo Libreta de Fiado y Abonos ----------
  openCreditModal(): void {
    this.abonoFeedback.set(null);
    this.creditModalOpen.set(true);
  }

  closeCreditModal(): void {
    this.creditModalOpen.set(false);
  }

  selectCustomerForFiado(customerId: string): void {
    this.selectedCustomerId.set(customerId);
    this.abonoCustomerId.set(customerId);
    this.abonoFeedback.set(null);
  }

  confirmCreditSale(): void {
    const check = this.creditValidation();
    if (!check.allowed || !this.cart().length) return;
    const result = this.inv.processSale(this.cart(), 'FIADO', this.selectedCustomerId());
    if (result.ok) {
      this.cart.set([]);
      this.creditModalOpen.set(false);
      this.saleFeedback.set({
        ok: true,
        text: `📓 ${result.message}`,
      });
    } else {
      this.saleFeedback.set({
        ok: false,
        text: result.message,
      });
    }
  }

  submitCustomerAbono(): void {
    const res = this.inv.registerCreditPayment(this.abonoCustomerId(), Number(this.abonoAmount()));
    this.abonoFeedback.set(res.message);
  }
}
