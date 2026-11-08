import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInternalSku,
  computeEan13CheckDigit,
  computeUpcACheckDigit,
  computeEan8CheckDigit,
  normalizeBarcode,
  barcodesMatch,
  generateInternalBarcode,
  getAllProductBarcodes,
  validateBarcodeUniqueness,
  convertPurchaseToSaleQty,
  calculateUnitCostFromPurchasePackage,
  calculateProductTaxes,
  calculateBulkSaleCost,
  normalizePriceTiers,
  resolveTierUnitPrice,
  evaluateCartDiscounts,
  evaluateNaturalShrinkTolerance,
  evaluateCumulativeNaturalShrink,
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

test('Catálogo (F1 seguimiento): Códigos de barras normalizados UPC-A/EAN-13/EAN-8, equivalencia y duplicados', () => {
  // UPC-A (12 dígitos) y EAN-13 (13 dígitos) con '0' son equivalentes
  const upcA = '012345678905';
  const ean13 = '0012345678905';
  const ean8 = '96385074';

  const normUpc = normalizeBarcode(upcA);
  const normEan13 = normalizeBarcode(ean13);
  const normEan8 = normalizeBarcode(ean8);

  assert.equal(normUpc.format, 'UPC-A');
  assert.equal(normUpc.validCheckDigit, true);
  assert.equal(normUpc.normalized, ean13);

  assert.equal(normEan13.validCheckDigit, true);
  assert.equal(barcodesMatch(upcA, ean13), true);

  assert.equal(normEan8.format, 'EAN-8');
  assert.equal(normEan8.validCheckDigit, true);

  // Duplicado cruzado entre producto existente con EAN-13 y candidato con UPC-A
  const existing = [
    {
      sku: 'AB-ARR-001',
      name: 'Arroz 1kg',
      barcodes: [ean13],
    },
  ];
  const duplicateCheck = validateBarcodeUniqueness([upcA], existing);
  assert.equal(duplicateCheck.valid, false);
  assert.match(duplicateCheck.error || '', /equivalencia UPC-A\/EAN-13/);
  assert.equal(duplicateCheck.conflictingSku, 'AB-ARR-001');
});

test('Catálogo (F1 seguimiento): Dígito de verificación inválido avisa y permite continuar con confirmación', () => {
  // 7501031311309 es válido (dígito 9). Si ponemos 4 al final, es inválido.
  const invalidCode = '7501031311304';
  const norm = normalizeBarcode(invalidCode);
  assert.equal(norm.validCheckDigit, false);
  assert.equal(norm.expectedCheckDigit, '9');
  assert.equal(norm.actualCheckDigit, '4');

  // Sin confirmación previa: rechaza y solicita confirmación
  const unconfirmed = validateCatalogProductInput(
    {
      name: 'Refresco Cola 600ml',
      category: 'Bebidas',
      saleUnit: 'Pieza',
      unitsPerPurchase: 1,
      cost: 12.0,
      salePrice: 18.0,
      barcode: invalidCode,
    },
    []
  );
  assert.equal(unconfirmed.valid, false);
  assert.equal(unconfirmed.requiresBarcodeConfirmation, true);
  assert.match(unconfirmed.error || '', /dígito de verificación inválido/i);

  // Con confirmación: permite continuar
  const confirmed = validateCatalogProductInput(
    {
      name: 'Refresco Cola 600ml',
      category: 'Bebidas',
      saleUnit: 'Pieza',
      unitsPerPurchase: 1,
      cost: 12.0,
      salePrice: 18.0,
      barcode: invalidCode,
      confirmInvalidBarcode: true,
    },
    []
  );
  assert.equal(confirmed.valid, true);
});

test('Catálogo (F1 seguimiento): Merma natural acumulada por periodo señala si 3 conteos de -2% superan tolerancia mensual de 3%', () => {
  // Base mensual vendida/rotada: 100 kg. Tolerancia mensual: 3% (máximo 3.0 kg de pérdida acumulada).
  const periodBaseQty = 100;
  const tolerancePct = 3;

  // 1er conteo: -2% (pérdida de 2 kg, acumulado previo 0) -> dentro de tolerancia mensual (2 kg <= 3 kg)
  const eval1 = evaluateCumulativeNaturalShrink({
    systemQty: 50,
    countedQty: 48, // -2 kg
    naturalShrinkTolerancePct: tolerancePct,
    periodBaseQty,
    accumulatedPeriodShrinkQty: 0,
  });
  assert.equal(eval1.classification, 'MERMA_NATURAL');
  assert.equal(eval1.isWithinNaturalTolerance, true);
  assert.equal(eval1.accumulatedPeriodShrinkQty, 2);

  // 2do conteo: -2% adicional (pérdida de 2 kg, acumulado previo 2 kg -> total 4 kg > 3 kg)
  const eval2 = evaluateCumulativeNaturalShrink({
    systemQty: 48,
    countedQty: 46, // -2 kg
    naturalShrinkTolerancePct: tolerancePct,
    periodBaseQty,
    accumulatedPeriodShrinkQty: eval1.accumulatedPeriodShrinkQty,
  });
  assert.equal(eval2.classification, 'FALTANTE');
  assert.equal(eval2.isWithinNaturalTolerance, false);
  assert.equal(eval2.exceedsPeriodAccumulatedTolerance, true);
  assert.match(eval2.label, /supera tolerancia/);

  // 3er conteo: -2% adicional (pérdida de 2 kg, acumulado previo 4 kg -> total 6 kg)
  const eval3 = evaluateCumulativeNaturalShrink({
    systemQty: 46,
    countedQty: 44, // -2 kg
    naturalShrinkTolerancePct: tolerancePct,
    periodBaseQty,
    accumulatedPeriodShrinkQty: eval2.accumulatedPeriodShrinkQty,
  });
  assert.equal(eval3.classification, 'FALTANTE');
  assert.equal(eval3.isWithinNaturalTolerance, false);
  assert.equal(eval3.exceedsPeriodAccumulatedTolerance, true);
  assert.equal(eval3.accumulatedPeriodShrinkQty, 6);
});

test('Catálogo (F1 seguimiento): Costo en granel: bulto de 50 kg a $847.00 vendido en tandas de 0.350 kg coincide dentro de 1 centavo', () => {
  const packageCostPesos = 847.0; // $847.00 = 84,700 centavos
  const packageFactor = 50; // 50 kg
  const portionQty = 0.35; // 350 gramos
  const expectedTotalCostCents = 84700;

  let totalCostCentsAccum = 0;
  let cumulativeSold = 0;
  let priorCostCents = 0;

  // Vendemos sucesivamente 0.350 kg hasta agotar los 50 kg
  while (cumulativeSold < packageFactor) {
    const remaining = Math.round((packageFactor - cumulativeSold) * 1000) / 1000;
    const saleQty = Math.min(portionQty, remaining);

    const step = calculateBulkSaleCost({
      packageCostPesos,
      packageFactor,
      saleQty,
      cumulativeSoldQtyPrior: cumulativeSold,
      cumulativeCostCentsPrior: priorCostCents,
    });

    totalCostCentsAccum += step.saleCostCents;
    priorCostCents = step.cumulativeCostCentsAfter;
    cumulativeSold = step.cumulativeSoldQtyAfter;
  }

  assert.equal(cumulativeSold, 50);
  // La suma acumulada de los costos de todas las tandas debe coincidir con $847.00 dentro de 1 centavo (aquí es exacto)
  const differenceCents = Math.abs(totalCostCentsAccum - expectedTotalCostCents);
  assert.ok(
    differenceCents <= 1,
    `La diferencia (${differenceCents} centavos) supera el tope de 1 centavo.`
  );
  assert.equal(totalCostCentsAccum, expectedTotalCostCents);
});

test('Catálogo (F1 seguimiento): Descuentos por debajo del costo bloquean sin PIN y registran la causa', () => {
  // Producto con costo $20.00 (2000 centavos), precio menudeo $25.00
  // Descuento del 30% lleva el precio a $17.50 (< $20.00 de costo)
  const lines = [
    {
      sku: 'ACE-1L',
      name: 'Aceite 1L',
      qty: 1,
      unitPrice: 25.0,
      baseUnitPrice: 25.0,
      unitCost: 20.0,
      discountPct: 30, // 30% off -> $17.50
    },
  ];

  const evalResult = evaluateCartDiscounts({
    lines,
    maxDiscountPctWithoutPin: 15,
  });

  assert.equal(evalResult.requiresPin, true);
  assert.ok(evalResult.reasons.some((r) => r.includes('costo')));
  assert.equal(evalResult.lines[0].isBelowCost, true);
});
