import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTheoreticalDrawerCash,
  createCashMovement,
  sortCashMovementsByTimestamp,
  reconcileCashMovements,
  type CashMovement,
} from './cash.ts';

test('Tesorería (F2): Fórmula del efectivo teórico del cajón', () => {
  // Caso 1: Arqueo base
  // Fondo inicial: $500.00
  // Ventas contado efectivo: $1,250.50
  // Abonos de fiado en efectivo: $350.00
  // Entradas extraordinarias (ej. cambio de feria): $100.00
  // Salidas en efectivo (pago a proveedor en efectivo $400.00 + retiro $200.00): $600.00
  // Teórico: 500 + 1250.50 + 350 + 100 - 600 = $1,600.50
  const teorico = calculateTheoreticalDrawerCash({
    openingFloat: 500.0,
    cashSales: 1250.5,
    cashCreditPayments: 350.0,
    cashIn: 100.0,
    cashPayouts: 600.0,
  });
  assert.equal(teorico, 1600.5);

  // Caso 2: Un abono por transferencia bancaria ($500.00) o tarjeta ($300.00) NO debe contar como efectivo
  // Si el cliente abona $500 por transferencia, cashCreditPayments (en efectivo) se mantiene en $350.00
  // y el efectivo teórico en el cajón físico no se altera.
  const teoricoConTransferencia = calculateTheoreticalDrawerCash({
    openingFloat: 500.0,
    cashSales: 1250.5,
    cashCreditPayments: 350.0, // Solo efectivo
    cashIn: 100.0,
    cashPayouts: 600.0,
  });
  assert.equal(teoricoConTransferencia, 1600.5);

  // Caso 3: Sin entradas ni salidas extraordinarias
  const teoricoSimple = calculateTheoreticalDrawerCash({
    openingFloat: 300.0,
    cashSales: 800.0,
    cashCreditPayments: 150.0,
  });
  assert.equal(teoricoSimple, 1250.0);
});

test('Tesorería (F2): CashMovement conserva fecha AAAA-MM-DD y timestamp ISO completo', () => {
  const mov = createCashMovement({
    type: 'ENTRADA',
    amount: 150.75,
    reason: 'Abono cliente Don Pedro',
    user: 'Don Lupe (Encargado)',
    reference: 'ABONO-CLI-01',
    date: '2026-11-12',
    timestamp: '2026-11-12T10:30:00.000Z',
    source: 'CAJA',
    paymentMethod: 'EFECTIVO',
  });

  assert.equal(mov.type, 'ENTRADA');
  assert.equal(mov.amount, 150.75);
  assert.equal(mov.amountCents, 15075);
  assert.equal(mov.date, '2026-11-12');
  assert.match(mov.date, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.equal(mov.timestamp, '2026-11-12T10:30:00.000Z');
  assert.match(mov.timestamp, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
  assert.equal(mov.source, 'CAJA');
  assert.equal(mov.paymentMethod, 'EFECTIVO');
});

test('Tesorería (F2): Ordenamiento de CashMovement por timestamp ISO', () => {
  const mov1 = createCashMovement({
    type: 'ENTRADA',
    amount: 100,
    reason: 'Movimiento mañana',
    user: 'Cajero',
    reference: 'REF-1',
    timestamp: '2026-11-12T08:00:00.000Z',
  });
  const mov2 = createCashMovement({
    type: 'SALIDA',
    amount: 50,
    reason: 'Movimiento mediodía',
    user: 'Cajero',
    reference: 'REF-2',
    timestamp: '2026-11-12T12:00:00.000Z',
  });
  const mov3 = createCashMovement({
    type: 'ENTRADA',
    amount: 200,
    reason: 'Movimiento tarde',
    user: 'Cajero',
    reference: 'REF-3',
    timestamp: '2026-11-12T16:00:00.000Z',
  });

  const desordenados = [mov2, mov3, mov1];

  // Orden descendente (más reciente primero, para vista de bitácora)
  const desc = sortCashMovementsByTimestamp(desordenados, 'desc');
  assert.equal(desc[0].timestamp, '2026-11-12T16:00:00.000Z');
  assert.equal(desc[1].timestamp, '2026-11-12T12:00:00.000Z');
  assert.equal(desc[2].timestamp, '2026-11-12T08:00:00.000Z');

  // Orden ascendente (cronológico histórico, para conciliación de saldo)
  const asc = sortCashMovementsByTimestamp(desordenados, 'asc');
  assert.equal(asc[0].timestamp, '2026-11-12T08:00:00.000Z');
  assert.equal(asc[1].timestamp, '2026-11-12T12:00:00.000Z');
  assert.equal(asc[2].timestamp, '2026-11-12T16:00:00.000Z');
});

test('Tesorería (F2): Conciliación cronológica por timestamp y aislamiento de pagos electrónicos', () => {
  const openingFloat = 500.0;
  const cashSales = 1000.0; // Total contado ventas en efectivo
  // Saldo base inicial en cajón = 500 + 1000 = $1,500.00

  const movAbonoEfectivo = createCashMovement({
    type: 'ENTRADA',
    amount: 200.0,
    reason: 'Abono deudor Don Roberto',
    user: 'Cajero',
    reference: 'AB-01',
    timestamp: '2026-11-12T09:00:00.000Z',
    source: 'CAJA',
    paymentMethod: 'EFECTIVO',
  });

  const movAbonoTransferencia = createCashMovement({
    type: 'ENTRADA',
    amount: 450.0,
    reason: 'Abono deudor Doña Carmen',
    user: 'Cajero',
    reference: 'AB-02-SPEI',
    timestamp: '2026-11-12T10:30:00.000Z',
    source: 'FONDO_EXTERNO',
    paymentMethod: 'TRANSFERENCIA',
  });

  const movPagoProveedorCaja = createCashMovement({
    type: 'SALIDA',
    amount: 300.0,
    reason: 'Pago a proveedor Bimbo (Efectivo de cajón)',
    user: 'Encargado',
    reference: 'PXP-BIM',
    timestamp: '2026-11-12T11:00:00.000Z',
    source: 'CAJA',
    paymentMethod: 'EFECTIVO',
  });

  const movPagoProveedorBolsillo = createCashMovement({
    type: 'SALIDA',
    amount: 800.0,
    reason: 'Pago a proveedor Lala (Bolsillo dueño)',
    user: 'Don Lupe',
    reference: 'PXP-LAL-EXT',
    timestamp: '2026-11-12T13:00:00.000Z',
    source: 'FONDO_EXTERNO',
    paymentMethod: 'TRANSFERENCIA',
  });

  const conciliacion = reconcileCashMovements(openingFloat, cashSales, [
    movPagoProveedorBolsillo,
    movAbonoEfectivo,
    movPagoProveedorCaja,
    movAbonoTransferencia,
  ]);

  // Resumen global:
  // Efectivo en cajón: 500 (fondo) + 1000 (ventas) + 200 (abono efectivo) - 300 (pago caja) = $1,400.00
  // Abono por transferencia ($450) y pago desde bolsillo ($800) quedan aislados como no-efectivo
  assert.equal(conciliacion.openingFloat, 500.0);
  assert.equal(conciliacion.cashSales, 1000.0);
  assert.equal(conciliacion.cashCreditPayments, 200.0);
  assert.equal(conciliacion.cashOutTotal, 300.0);
  assert.equal(conciliacion.nonCashInTotal, 450.0);
  assert.equal(conciliacion.nonCashOutTotal, 800.0);
  assert.equal(conciliacion.theoreticalDrawerCash, 1400.0);

  // Verificación de los items conciliados cronológicamente
  assert.equal(conciliacion.items.length, 4);
  // Item 1 (09:00): Abono efectivo +$200 -> saldo 1700
  assert.equal(conciliacion.items[0].movement.reference, 'AB-01');
  assert.equal(conciliacion.items[0].affectsDrawerCash, true);
  assert.equal(conciliacion.items[0].runningBalance, 1700.0);

  // Item 2 (10:30): Abono transferencia $450 -> saldo cajón se mantiene en 1700
  assert.equal(conciliacion.items[1].movement.reference, 'AB-02-SPEI');
  assert.equal(conciliacion.items[1].affectsDrawerCash, false);
  assert.equal(conciliacion.items[1].runningBalance, 1700.0);

  // Item 3 (11:00): Pago proveedor cajón -$300 -> saldo 1400
  assert.equal(conciliacion.items[2].movement.reference, 'PXP-BIM');
  assert.equal(conciliacion.items[2].affectsDrawerCash, true);
  assert.equal(conciliacion.items[2].runningBalance, 1400.0);

  // Item 4 (13:00): Pago bolsillo $800 -> saldo cajón se mantiene en 1400
  assert.equal(conciliacion.items[3].movement.reference, 'PXP-LAL-EXT');
  assert.equal(conciliacion.items[3].affectsDrawerCash, false);
  assert.equal(conciliacion.items[3].runningBalance, 1400.0);
});
