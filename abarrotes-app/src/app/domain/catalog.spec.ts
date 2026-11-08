import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInternalSku,
  computeEan13CheckDigit,
  generateInternalBarcode,
  getAllProductBarcodes,
  validateBarcodeUniqueness,
  convertPurchaseToSaleQty,
  calculateUnitCostFromPurchasePackage,
  calculateProductTaxes,
  normalizePriceTiers,
  resolveTierUnitPrice,
  evaluateCartDiscounts,
  evaluateNaturalShrinkTolerance,
  hasProductMovements,
  validateCatalogProductInput,
  validateMobileProductCreateRequest,
} from './catalog.ts';

test('Catálogo (F1): autogeneración de SKU interno editable y códigos internos EAN-13 sin colisiones', () => {
  const existingSkus = ['LAC-LEC-ENT', 'LAC-LEC-001'];
  const sku1 = generateInternalSku('Leche Entera 1L', 'Lácteos', []);
  assert.equal(sku1, 'LAC-LEC-ENT');

  const skuNoCollision = generateInternalSku('Leche Entera 1L', 'Lácteos', existingSkus);
  assert.equal(skuNoCollision, 'LAC-LEC-002');

  const code1 = generateInternalBarcode([], 1);
  assert.equal(code1.length, 13);
  assert.equal(code1.startsWith('200'), true);
  assert.equal(code1[12], computeEan13CheckDigit(code1.slice(0, 12)));

  const code2 = generateInternalBarcode([code1], 1);
  assert.notEqual(code1, code2);
  assert.equal(code2.startsWith('200'), true);
});

test('Catálogo (F1): varios códigos de barras por producto y validación de duplicados entre productos', () => {
  const catalog = [
    {
      sku: 'REF-COC-600',
      name: 'Coca-Cola Original 600ml',
      barcode: '7501055300075',
      barcodes: ['7501055300075', '7501055301072'],
    },
    {
      sku: 'LAC-LAL-1L',
      name: 'Leche Lala Entera 1L',
      barcode: '7501020515350',
      barcodes: ['7501020515350'],
    },
  ];

  assert.deepEqual(getAllProductBarcodes(catalog[0]), ['7501055300075', '7501055301072']);

  // Duplicado contra código secundario de otro producto
  const dupAgainstSecondary = validateBarcodeUniqueness(
    ['7509999999999', '7501055301072'],
    catalog,
    'NUEVO-SKU'
  );
  assert.equal(dupAgainstSecondary.valid, false);
  assert.equal(dupAgainstSecondary.duplicateBarcode, '7501055301072');
  assert.equal(dupAgainstSecondary.conflictingSku, 'REF-COC-600');

  // Duplicado dentro del mismo producto
  const dupInternal = validateBarcodeUniqueness(
    ['7501111111111', '7501111111111'],
    catalog,
    'NUEVO-SKU'
  );
  assert.equal(dupInternal.valid, false);

  // Edición del propio producto conservando sus códigos
  const ownEdit = validateBarcodeUniqueness(
    ['7501055300075', '7501055301072', '7501055309993'],
    catalog,
    'REF-COC-600'
  );
  assert.equal(ownEdit.valid, true);
  assert.equal(ownEdit.normalizedBarcodes.length, 3);
});

test('Catálogo (F1): conversión de unidades de compra (caja de 24, bulto de 50 kg, kg a g) y costos en centavos', () => {
  // 3 cajas de 24 piezas = 72 piezas
  assert.equal(convertPurchaseToSaleQty(3, 24, 'Caja', 'Pieza'), 72);
  // 2 bultos de 50 kg = 100 kg
  assert.equal(convertPurchaseToSaleQty(2, 50, 'Bulto', 'Kg'), 100);
  // 1.5 Kg comprado para vender en gramos (g) = 1500 g
  assert.equal(convertPurchaseToSaleQty(1.5, 1, 'Kg', 'g'), 1500);

  // Costo unitario de una caja de 24 que cuesta $338.40 -> $14.10 exactos
  assert.equal(calculateUnitCostFromPurchasePackage(338.4, 24, 'Caja', 'Pieza'), 14.1);
  // Bulto de 50 kg a $1,400.00 -> $28.00/kg
  assert.equal(calculateUnitCostFromPurchasePackage(1400, 50, 'Bulto', 'Kg'), 28);

  // Cálculo de IVA (16%) e IEPS (8%) en centavos enteros
  const taxes = calculateProductTaxes(100, 0.16, 0.08);
  assert.equal(taxes.baseCents, 10000);
  assert.equal(taxes.ivaCents, 1600);
  assert.equal(taxes.iepsCents, 800);
  assert.equal(taxes.totalPesos, 124);
});

test('Catálogo (F1): precios escalonados (menudeo, medio mayoreo, mayoreo) por cantidad y por selector POS', () => {
  const product = {
    salePrice: 20,
    priceTiers: normalizePriceTiers(20, [
      { tier: 'MEDIO_MAYOREO', label: 'Medio Mayoreo', minQty: 6, unitPrice: 18.5 },
      { tier: 'MAYOREO', label: 'Mayoreo', minQty: 12, unitPrice: 17.0 },
    ]),
  };

  assert.equal(resolveTierUnitPrice(product, 1).tier, 'MENUDEO');
  assert.equal(resolveTierUnitPrice(product, 1).unitPrice, 20);

  assert.equal(resolveTierUnitPrice(product, 6).tier, 'MEDIO_MAYOREO');
  assert.equal(resolveTierUnitPrice(product, 6).unitPrice, 18.5);

  assert.equal(resolveTierUnitPrice(product, 15).tier, 'MAYOREO');
  assert.equal(resolveTierUnitPrice(product, 15).unitPrice, 17.0);

  // Selector explícito en el POS (forzar Medio Mayoreo aunque lleve 2 piezas)
  const forced = resolveTierUnitPrice(product, 2, 'MEDIO_MAYOREO');
  assert.equal(forced.tier, 'MEDIO_MAYOREO');
  assert.equal(forced.unitPrice, 18.5);
});

test('Catálogo (F1): descuentos por línea y por ticket en centavos enteros con tope configurable y PIN', () => {
  // Tope sin PIN: 10%
  const withinCap = evaluateCartDiscounts(
    [
      { sku: 'A', name: 'Producto A', qty: 2, unitPrice: 50, discountPct: 5 }, // $100 - $5 = $95
      { sku: 'B', name: 'Producto B', qty: 1, unitPrice: 100, discountPct: 0 }, // $100
    ],
    5, // 5% descuento adicional en ticket sobre $195 = $9.75
    10 // Tope 10%
  );

  assert.equal(withinCap.grossTotal, 200);
  assert.equal(withinCap.totalLineDiscounts, 5);
  assert.equal(withinCap.subtotalAfterLineDiscounts, 195);
  assert.equal(withinCap.ticketDiscountAmount, 9.75);
  assert.equal(withinCap.finalTotal, 185.25);
  assert.equal(withinCap.requiresPin, false);
  // Suma de importes prorrateados por línea cuadra al centavo con finalTotal
  const sumAllocated =
    Math.round(
      withinCap.lines.reduce((acc, l) => acc + Math.round(l.finalAllocatedAmount * 100), 0)
    ) / 100;
  assert.equal(sumAllocated, withinCap.finalTotal);

  // Caso que supera el tope en una línea (15% > 10%) -> exige PIN
  const exceedsLine = evaluateCartDiscounts(
    [{ sku: 'A', name: 'Producto A', qty: 1, unitPrice: 100, discountPct: 15 }],
    0,
    10
  );
  assert.equal(exceedsLine.requiresPin, true);
  assert.equal(exceedsLine.finalTotal, 85);

  // Caso que supera el tope en el ticket (12% > 10%) -> exige PIN
  const exceedsTicket = evaluateCartDiscounts(
    [{ sku: 'A', name: 'Producto A', qty: 1, unitPrice: 100, discountPct: 0 }],
    12,
    10
  );
  assert.equal(exceedsTicket.requiresPin, true);
  assert.equal(exceedsTicket.finalTotal, 88);

  // Prioridad Mayoreo + Descuento por Ticket:
  // Menudeo = $100, Mayoreo = $92 (8% menos vs menudeo).
  // 1) Solo Mayoreo sin descuento manual (0%) -> NO pide PIN ($92).
  const wholesaleOnly = evaluateCartDiscounts(
    [{ sku: 'A', name: 'Producto A', qty: 12, unitPrice: 92, baseUnitPrice: 100, discountPct: 0 }],
    0,
    10
  );
  assert.equal(wholesaleOnly.requiresPin, false);
  assert.equal(wholesaleOnly.finalTotal, 1104);

  // 2) Mayoreo ($92) + 5% de descuento por ticket -> se acumulan ($92 * 0.95 = $87.40/u = 12.6% total sobre menudeo $100)
  // Como 12.6% > tope 10% sobre precio menudeo, exige PIN (requiresPin = true).
  const wholesalePlusTicket = evaluateCartDiscounts(
    [{ sku: 'A', name: 'Producto A', qty: 1, unitPrice: 92, baseUnitPrice: 100, discountPct: 0 }],
    5,
    10
  );
  assert.equal(wholesalePlusTicket.finalTotal, 87.4);
  assert.equal(wholesalePlusTicket.retailGrossTotal, 100);
  assert.equal(wholesalePlusTicket.totalDiscountVsRetailAmount, 12.6);
  assert.equal(wholesalePlusTicket.effectiveDiscountVsRetailPct, 12.6);
  assert.equal(wholesalePlusTicket.requiresPin, true);
});

test('Catálogo (F1): tolerancia de merma natural en granel marca diferencias dentro del % como "Merma natural" y no faltante', () => {
  // Queso fresco granel: 10 kg en sistema, tolerancia 3% (máx 0.300 kg). Conteo físico: 9.8 kg (-0.2 kg = 2%)
  const withinTol = evaluateNaturalShrinkTolerance({
    isBulk: true,
    naturalShrinkTolerancePct: 3,
    systemQty: 10,
    countedQty: 9.8,
  });
  assert.equal(withinTol.classification, 'MERMA_NATURAL');
  assert.equal(withinTol.label, 'Merma natural');
  assert.equal(withinTol.isWithinNaturalTolerance, true);

  // Fuera de tolerancia: 10 kg en sistema, tolerancia 3%, conteo 9.2 kg (-0.8 kg = 8%) -> Faltante
  const outsideTol = evaluateNaturalShrinkTolerance({
    isBulk: true,
    naturalShrinkTolerancePct: 3,
    systemQty: 10,
    countedQty: 9.2,
  });
  assert.equal(outsideTol.classification, 'FALTANTE');
  assert.equal(outsideTol.label, 'Faltante');
  assert.equal(outsideTol.isWithinNaturalTolerance, false);
});

test('Catálogo (F1): protección de baja lógica (no se borra si tiene movimientos en Kardex) y validación móvil', () => {
  const kardex = [{ producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala' } }];
  assert.equal(hasProductMovements('LAC-LAL-1L', kardex), true);
  assert.equal(hasProductMovements('NUEVO-SIN-MOV', kardex), false);

  const validInput = validateCatalogProductInput(
    {
      name: 'Jabón Líquido 1L',
      category: 'Limpieza',
      saleUnit: 'L',
      purchaseUnit: 'Caja',
      unitsPerPurchase: 12,
      cost: 28.5,
      salePrice: 38.0,
      initialStock: 24,
    },
    []
  );
  assert.equal(validInput.valid, true);
  assert.equal(validInput.hasInternalBarcode, true);
  assert.equal(validInput.normalizedBarcodes[0].startsWith('200'), true);

  const mobileCheck = validateMobileProductCreateRequest({
    type: 'PRODUCT_CREATE_REQUEST',
    product: {
      barcode: '7509988776655',
      name: 'Galletas Chokis 90g',
      salePrice: 22.5,
      cost: 17.0,
      saleUnit: 'Pieza',
    },
  });
  assert.equal(mobileCheck.valid, true);
  assert.equal(mobileCheck.normalized?.barcode, '7509988776655');
  assert.equal(mobileCheck.normalized?.salePrice, 22.5);
});
