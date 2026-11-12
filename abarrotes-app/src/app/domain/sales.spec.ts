import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaleRecord,
  validateSaleReturn,
  applySaleReturnPure,
  revertCustomerCreditDebtFromReturn,
  type SaleRecord,
} from './sales.ts';
import {
  applyCreditPaymentPure,
  applyCreditSalePure,
  type CreditCustomer,
} from './credit.ts';

describe('Ventas y Contra-asientos de Devolución (Bloque H)', () => {
  it('crea un registro de venta inmutable con folio correlativo y centavos exactos', () => {
    const sale = createSaleRecord({
      existingSalesCount: 15,
      cashier: 'Don Lupe (Encargado)',
      paymentType: 'EFECTIVO',
      items: [
        { sku: 'LECHE-LALA', name: 'Leche Lala 1L', qty: 2, unitPrice: 28.5, subtotal: 57.0 },
        { sku: 'PAN-BIMBO', name: 'Pan Bimbo Blanco', qty: 1, unitPrice: 42.0, subtotal: 42.0 },
      ],
      discountAmount: 5.0,
      cashReceived: 100.0,
      change: 6.0,
    });

    assert.equal(sale.folio, 'V-1016');
    assert.equal(sale.subtotal, 99.0);
    assert.equal(sale.discountAmount, 5.0);
    assert.equal(sale.total, 94.0);
    assert.equal(sale.totalCents, 9400);
    assert.equal(sale.status, 'COMPLETADA');
    assert.equal(sale.items.length, 2);
    assert.equal(sale.items[0].returnedQty, 0);
    assert.equal(sale.returns.length, 0);
  });

  it('valida rechazo de devoluciones por motivos inválidos o cantidades que exceden lo vendido', () => {
    const sale = createSaleRecord({
      existingSalesCount: 1,
      cashier: 'Don Lupe',
      paymentType: 'EFECTIVO',
      items: [{ sku: 'ACE-1L', name: 'Aceite 1L', qty: 2, unitPrice: 45.0, subtotal: 90.0 }],
    });

    // 1. Motivo vacío
    const checkNoReason = validateSaleReturn(sale, [{ sku: 'ACE-1L', qty: 1 }], '  ');
    assert.equal(checkNoReason.valid, false);
    assert.match(checkNoReason.error || '', /motivo/i);

    // 2. SKU no perteneciente
    const checkBadSku = validateSaleReturn(
      sale,
      [{ sku: 'SKU-INEXISTENTE', qty: 1 }],
      'Empaque roto'
    );
    assert.equal(checkBadSku.valid, false);
    assert.match(checkBadSku.error || '', /no forma parte/i);

    // 3. Cantidad negativa o cero
    const checkZeroQty = validateSaleReturn(sale, [{ sku: 'ACE-1L', qty: 0 }], 'Empaque roto');
    assert.equal(checkZeroQty.valid, false);

    // 4. Cantidad superior a lo comprado
    const checkExceedQty = validateSaleReturn(
      sale,
      [{ sku: 'ACE-1L', qty: 3 }],
      'Empaque roto'
    );
    assert.equal(checkExceedQty.valid, false);
    assert.match(checkExceedQty.error || '', /disponibles/i);
  });

  it('aplica devolución parcial por línea: genera contra-asiento y marca DEVOLUCION_PARCIAL sin mutar el historial', () => {
    const originalSale = createSaleRecord({
      existingSalesCount: 100,
      cashier: 'Don Lupe',
      paymentType: 'EFECTIVO',
      items: [
        { sku: 'JAB-ROSA', name: 'Jabón Rosa Venus', qty: 5, unitPrice: 12.0, subtotal: 60.0 },
        { sku: 'CLORO-1L', name: 'Cloro Los Patitos 1L', qty: 2, unitPrice: 20.0, subtotal: 40.0 },
      ],
    });

    // Devolvemos 2 jabones de los 5 comprados
    const { returnRecord, updatedSale } = applySaleReturnPure(originalSale, {
      itemsToReturn: [{ sku: 'JAB-ROSA', qty: 2 }],
      user: 'Cajero Matutino',
      authorizedBy: 'Don Lupe (Encargado)',
      reason: 'Cliente cambió de opinión antes de retirarse',
    });

    // Validar contra-asiento
    assert.equal(returnRecord.saleFolio, originalSale.folio);
    assert.equal(returnRecord.isFullCancellation, false);
    assert.equal(returnRecord.items.length, 1);
    assert.equal(returnRecord.items[0].sku, 'JAB-ROSA');
    assert.equal(returnRecord.items[0].qty, 2);
    assert.equal(returnRecord.items[0].refundAmount, 24.0);
    assert.equal(returnRecord.items[0].refundAmountCents, 2400);
    assert.equal(returnRecord.totalRefund, 24.0);
    assert.equal(returnRecord.totalRefundCents, 2400);
    assert.equal(returnRecord.authorizedBy, 'Don Lupe (Encargado)');

    // Validar venta actualizada
    assert.equal(updatedSale.status, 'DEVOLUCION_PARCIAL');
    assert.equal(updatedSale.items[0].returnedQty, 2);
    assert.equal(updatedSale.items[1].returnedQty, 0);
    assert.equal(updatedSale.returns.length, 1);

    // Inmutabilidad contable: la venta original no fue alterada
    assert.equal(originalSale.status, 'COMPLETADA');
    assert.equal(originalSale.items[0].returnedQty, 0);
    assert.equal(originalSale.returns.length, 0);

    // Segunda devolución: devolvemos los 3 jabones restantes y los 2 cloros
    const secondReturn = applySaleReturnPure(updatedSale, {
      itemsToReturn: [
        { sku: 'JAB-ROSA', qty: 3 },
        { sku: 'CLORO-1L', qty: 2 },
      ],
      user: 'Cajero Matutino',
      authorizedBy: 'Don Lupe (Encargado)',
      reason: 'Devolución del resto del ticket',
    });

    assert.equal(secondReturn.returnRecord.isFullCancellation, true);
    assert.equal(secondReturn.returnRecord.totalRefund, 76.0); // 3*12 + 2*20 = 36 + 40 = 76
    assert.equal(secondReturn.updatedSale.status, 'CANCELADA');
    assert.equal(secondReturn.updatedSale.returns.length, 2);
    assert.equal(secondReturn.updatedSale.items[0].returnedQty, 5);
    assert.equal(secondReturn.updatedSale.items[1].returnedQty, 2);

    // Intentar devolver sobre la venta ya CANCELADA es rechazado
    const thirdAttempt = validateSaleReturn(
      secondReturn.updatedSale,
      [{ sku: 'JAB-ROSA', qty: 1 }],
      'Intento extra'
    );
    assert.equal(thirdAttempt.valid, false);
    assert.match(thirdAttempt.error || '', /ya fue cancelada/i);
  });

  it('revierte deuda de cliente en ventas a fiado recalculando su estatus crediticio', () => {
    const customer: CreditCustomer = {
      id: 'CLI-001',
      name: 'Doña Mari',
      creditLimit: 500.0,
      currentBalance: 460.0, // Cerca del límite (92% -> LIMITE_ALCANZADO)
      creditDays: 15,
      status: 'LIMITE_ALCANZADO',
      debts: [
        {
          id: 'DEBT-01',
          date: '2026-11-01',
          dueDate: '2026-11-16',
          originalAmount: 200.0,
          remainingBalance: 200.0,
          description: 'Compra semanal Nota #V-2001',
        },
        {
          id: 'DEBT-02',
          date: '2026-11-10',
          dueDate: '2026-11-25',
          originalAmount: 260.0,
          remainingBalance: 260.0,
          description: 'Abarrotes fin de semana Nota #V-2005',
        },
      ],
      payments: [],
      notes: 'Cliente vecinal',
      isActive: true,
    };

    const sale = createSaleRecord({
      folio: 'V-2005',
      cashier: 'Don Lupe',
      paymentType: 'FIADO',
      customerId: 'CLI-001',
      customerName: 'Doña Mari',
      items: [
        { sku: 'AZUCAR-1K', name: 'Azúcar Morena 1kg', qty: 2, unitPrice: 30.0, subtotal: 60.0 },
        { sku: 'FRIJOL-1K', name: 'Frijol Negro 1kg', qty: 5, unitPrice: 40.0, subtotal: 200.0 },
      ],
    });

    // El cliente devuelve los 5 kg de frijol ($200) de la nota V-2005
    const { returnRecord } = applySaleReturnPure(sale, {
      itemsToReturn: [{ sku: 'FRIJOL-1K', qty: 5 }],
      user: 'Cajero',
      authorizedBy: 'Don Lupe',
      reason: 'Frijol con gorgojo',
    });

    const { updatedCustomer, revertedAmount } = revertCustomerCreditDebtFromReturn(
      customer,
      returnRecord,
      new Date('2026-11-12')
    );

    assert.equal(revertedAmount, 200.0);
    assert.equal(updatedCustomer.currentBalance, 260.0); // 460 - 200 = 260
    // Límite de $500, nuevo saldo de $260 = 52% (< 90%), debe salir de LIMITE_ALCANZADO a AL_CORRIENTE
    assert.equal(updatedCustomer.status, 'AL_CORRIENTE');
    assert.equal(updatedCustomer.debts.length, 2);
    // La partida DEBT-02 bajó de $260 a $60
    const debt02 = updatedCustomer.debts.find((d) => d.id === 'DEBT-02')!;
    assert.equal(debt02.remainingBalance, 60.0);
  });

  it('devolución parcial repetida rechaza superar originalSoldQty - alreadyReturnedQty y solicitudes duplicadas por SKU', () => {
    const sale = createSaleRecord({
      folio: 'V-3001',
      cashier: 'Cajero 1',
      paymentType: 'EFECTIVO',
      items: [{ sku: 'REF-600', name: 'Refresco 600ml', qty: 4, unitPrice: 18.0, subtotal: 72.0 }],
    });

    // Primera devolución de 2 unidades (quedan 2 disponibles)
    const first = applySaleReturnPure(sale, {
      itemsToReturn: [{ sku: 'REF-600', qty: 2 }],
      user: 'Cajero 1',
      authorizedBy: 'Encargado',
      reason: 'Botellas mal selladas',
    });
    assert.equal(first.updatedSale.items[0].returnedQty, 2);

    // Intento de devolver 3 unidades cuando solo quedan 4 - 2 = 2 -> RECHAZADO
    const overSecond = validateSaleReturn(
      first.updatedSale,
      [{ sku: 'REF-600', qty: 3 }],
      'Otro defecto'
    );
    assert.equal(overSecond.valid, false);
    assert.match(overSecond.error || '', /Solo quedan 2 disponibles/i);

    // Intento de enviar el SKU duplicado en una sola petición sumando más de lo disponible -> RECHAZADO
    const dupSkuAttempt = validateSaleReturn(
      first.updatedSale,
      [
        { sku: 'REF-600', qty: 1 },
        { sku: 'REF-600', qty: 2 },
      ],
      'Intento duplicado'
    );
    assert.equal(dupSkuAttempt.valid, false);
    assert.match(dupSkuAttempt.error || '', /Solo quedan 2 disponibles/i);
  });

  it('reembolsa el importe neto en centavos exactos sobre ventas con descuento por línea o prorrateado de ticket', () => {
    // 3 unidades a $10.00 ($30.00 bruto) con descuento de ticket de $1.00 -> neto cobrado $29.00 (2900 centavos)
    const sale = createSaleRecord({
      folio: 'V-3002',
      cashier: 'Cajero 1',
      paymentType: 'EFECTIVO',
      items: [{ sku: 'GALLETAS', name: 'Galletas Surtidas', qty: 3, unitPrice: 10.0, subtotal: 30.0 }],
      discountAmount: 1.0,
    });

    assert.equal(sale.totalCents, 2900);
    assert.equal(sale.items[0].subtotalCents, 2900);

    // Devolver de 1 en 1 en 3 contra-asientos sucesivos no debe exceder jamás 2900 centavos ni perder centavos
    const r1 = applySaleReturnPure(sale, {
      itemsToReturn: [{ sku: 'GALLETAS', qty: 1 }],
      user: 'Cajero 1',
      authorizedBy: 'Encargado',
      reason: 'Caja abollada #1',
    });
    const r2 = applySaleReturnPure(r1.updatedSale, {
      itemsToReturn: [{ sku: 'GALLETAS', qty: 1 }],
      user: 'Cajero 1',
      authorizedBy: 'Encargado',
      reason: 'Caja abollada #2',
    });
    const r3 = applySaleReturnPure(r2.updatedSale, {
      itemsToReturn: [{ sku: 'GALLETAS', qty: 1 }],
      user: 'Cajero 1',
      authorizedBy: 'Encargado',
      reason: 'Caja abollada #3',
    });

    const sumRefundedCents =
      r1.returnRecord.totalRefundCents +
      r2.returnRecord.totalRefundCents +
      r3.returnRecord.totalRefundCents;

    // Nunca devuelve el precio de lista ($30.00 = 3000) ni excede lo cobrado ($29.00 = 2900)
    assert.equal(sumRefundedCents, 2900);
    assert.ok(r1.returnRecord.totalRefundCents < 1000);
    assert.equal(r3.updatedSale.status, 'CANCELADA');
  });

  it('en venta a fiado con abono previo absorbe la deuda a $0.00 sin saldo negativo y registra remanente a favor o en efectivo', () => {
    const baseCustomer: CreditCustomer = {
      id: 'CLI-FIADO-RET',
      name: 'Señor José',
      creditLimit: 500.0,
      currentBalance: 0,
      creditFavorBalance: 0,
      creditDays: 15,
      status: 'AL_CORRIENTE',
      debts: [],
      payments: [],
      isActive: true,
    };

    // 1. Compra fiada de $200.00 (folio V-3010)
    const afterSale = applyCreditSalePure(baseCustomer, 200.0, new Date('2026-11-10T10:00:00'), {
      saleFolio: 'V-3010',
      date: '2026-11-10',
      description: 'Compra Fiado #V-3010',
    }).updatedCustomer!;
    assert.equal(afterSale.currentBalance, 200.0);

    // 2. Cliente realiza abono parcial de $150.00 -> deuda restante queda en $50.00
    const afterPay = applyCreditPaymentPure(
      afterSale,
      150.0,
      new Date('2026-11-11T10:00:00'),
      'Abono parcial efectivo',
      'EFECTIVO'
    ).updatedCustomer;
    assert.equal(afterPay.currentBalance, 50.0);

    const sale = createSaleRecord({
      folio: 'V-3010',
      cashier: 'Cajero 1',
      paymentType: 'FIADO',
      customerId: afterPay.id,
      customerName: afterPay.name,
      items: [{ sku: 'CARNE-1K', name: 'Bistec 1kg', qty: 2, unitPrice: 100.0, subtotal: 200.0 }],
    });

    // 3. Devuelve $120.00 (> $50.00 de deuda restante) con exceso a SALDO_A_FAVOR
    const ret = applySaleReturnPure(sale, {
      itemsToReturn: [{ sku: 'CARNE-1K', qty: 1.2 }],
      user: 'Cajero 1',
      authorizedBy: 'Encargado',
      reason: 'Devolución parcial por corte equivocado',
    }).returnRecord;

    const favorRes = revertCustomerCreditDebtFromReturn(afterPay, ret, {
      date: new Date('2026-11-12T10:00:00'),
      excessMode: 'SALDO_A_FAVOR',
    });

    assert.equal(favorRes.revertedAmount, 50.0);
    assert.equal(favorRes.updatedCustomer.currentBalance, 0); // Jamás negativo
    assert.equal(favorRes.excessAmount, 70.0);
    assert.equal(favorRes.favorBalanceAdded, 70.0);
    assert.equal(favorRes.cashRefundAmount, 0);
    assert.equal(favorRes.updatedCustomer.creditFavorBalance, 70.0);
    assert.equal(favorRes.updatedCustomer.status, 'AL_CORRIENTE');

    // Al hacer una compra fiada futura de $100.00, consume los $70.00 a favor y solo adeuda $30.00
    const nextSale = applyCreditSalePure(
      favorRes.updatedCustomer,
      100.0,
      new Date('2026-11-13T10:00:00'),
      { saleFolio: 'V-3011', date: '2026-11-13', description: 'Compra #V-3011' }
    );
    assert.equal(nextSale.ok, true);
    assert.equal(nextSale.favorAppliedAmount, 70.0);
    assert.equal(nextSale.updatedCustomer!.currentBalance, 30.0);
    assert.equal(nextSale.updatedCustomer!.creditFavorBalance, 0);

    // 4. Si en lugar de saldo a favor elige REEMBOLSO_EFECTIVO sobre el mismo exceso de $70.00
    const cashRes = revertCustomerCreditDebtFromReturn(afterPay, ret, {
      date: new Date('2026-11-12T10:00:00'),
      excessMode: 'REEMBOLSO_EFECTIVO',
    });
    assert.equal(cashRes.revertedAmount, 50.0);
    assert.equal(cashRes.updatedCustomer.currentBalance, 0);
    assert.equal(cashRes.excessAmount, 70.0);
    assert.equal(cashRes.cashRefundAmount, 70.0);
    assert.equal(cashRes.favorBalanceAdded, 0);
  });
});
