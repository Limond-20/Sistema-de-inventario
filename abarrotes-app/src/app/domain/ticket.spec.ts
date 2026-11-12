import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSaleRecord, applySaleReturnPure } from './sales.ts';
import { formatTicketText, formatTicketHtml } from './ticket.ts';

describe('Ticket Imprimible 58mm y 80mm (Bloque H)', () => {
  it('genera ticket de venta en efectivo con nombre del negocio, líneas, total y cambio', () => {
    const sale = createSaleRecord({
      folio: 'V-1001',
      cashier: 'Don Lupe (Encargado)',
      paymentType: 'EFECTIVO',
      items: [
        { sku: 'COCA-600', name: 'Coca-Cola 600ml', qty: 2, unitPrice: 18.0, subtotal: 36.0 },
        { sku: 'SABRITAS-45G', name: 'Sabritas Sal 45g', qty: 1, unitPrice: 20.0, subtotal: 20.0 },
      ],
      cashReceived: 100.0,
      change: 44.0,
    });

    const ticket58 = formatTicketText(sale, {
      storeName: 'Abarrotes Doña Lupe',
      paperWidth: '58mm',
    });

    assert.match(ticket58, /Abarrotes Doña Lupe/);
    assert.match(ticket58, /#V-1001/);
    assert.match(ticket58, /Coca-Cola 600ml/);
    assert.match(ticket58, /TOTAL:\s+\$56\.00/);
    assert.match(ticket58, /EFECTIVO/);
    assert.match(ticket58, /Efectivo recibido:\s+\$100\.00/);
    assert.match(ticket58, /Cambio:\s+\$44\.00/);
    // Primera emisión no lleva marca de copia
    assert.doesNotMatch(ticket58, /COPIA DE TICKET/);

    const ticketHtml = formatTicketHtml(sale, {
      storeName: 'Abarrotes Doña Lupe',
      paperWidth: '58mm',
    });
    assert.match(ticketHtml, /ticket-58mm/);
    assert.match(ticketHtml, /#V-1001/);
    assert.match(ticketHtml, /@media print/);
  });

  it('genera ticket a fiado con saldo anterior y nuevo saldo deudor', () => {
    const saleFiado = createSaleRecord({
      folio: 'V-1002',
      cashier: 'Don Lupe',
      paymentType: 'FIADO',
      customerId: 'CLI-01',
      customerName: 'Doña Mari',
      customerPreviousBalance: 150.0,
      customerNewBalance: 235.0,
      items: [
        { sku: 'ACE-1L', name: 'Aceite 1L', qty: 1, unitPrice: 45.0, subtotal: 45.0 },
        { sku: 'HUEVO-1K', name: 'Huevo Blanco 1kg', qty: 1, unitPrice: 40.0, subtotal: 40.0 },
      ],
    });

    const ticket80 = formatTicketText(saleFiado, {
      storeName: 'Abarrotes Doña Lupe',
      paperWidth: '80mm',
    });

    assert.match(ticket80, /Doña Mari/);
    assert.match(ticket80, /Saldo anterior:\s+\$150\.00/);
    assert.match(ticket80, /Cargo de hoy:\s+\$85\.00/);
    assert.match(ticket80, /Nuevo saldo deudor:\s+\$235\.00/);
  });

  it('reimprime desde el historial incluyendo la marca destacada de COPIA', () => {
    const sale = createSaleRecord({
      folio: 'V-1003',
      cashier: 'Don Lupe',
      paymentType: 'EFECTIVO',
      items: [{ sku: 'PAN-1', name: 'Pan dulce', qty: 4, unitPrice: 12.0, subtotal: 48.0 }],
    });

    const ticketCopia = formatTicketText(sale, {
      storeName: 'Abarrotes Doña Lupe',
      isCopy: true,
      paperWidth: '58mm',
    });

    assert.match(ticketCopia, /\*\*\* COPIA DE TICKET \*\*\*/);

    const htmlCopia = formatTicketHtml(sale, {
      storeName: 'Abarrotes Doña Lupe',
      isCopy: true,
      paperWidth: '58mm',
    });
    assert.match(htmlCopia, /ticket-copy-banner/);
    assert.match(htmlCopia, /\*\*\* COPIA DE TICKET \*\*\*/);
  });

  it('despliega los contra-asientos cuando la venta tiene devoluciones', () => {
    const sale = createSaleRecord({
      folio: 'V-1004',
      cashier: 'Don Lupe',
      paymentType: 'EFECTIVO',
      items: [
        { sku: 'JAB-1', name: 'Jabón Zote', qty: 2, unitPrice: 25.0, subtotal: 50.0 },
      ],
    });

    const { updatedSale } = applySaleReturnPure(sale, {
      itemsToReturn: [{ sku: 'JAB-1', qty: 1 }],
      user: 'Cajero',
      authorizedBy: 'Don Lupe (Encargado)',
      reason: 'Jabón equivocado',
    });

    const ticketDev = formatTicketText(updatedSale, {
      storeName: 'Abarrotes Doña Lupe',
      isCopy: true,
    });

    assert.match(ticketDev, /CONTRA-ASIENTOS \/ DEVOLUCIONES/);
    assert.match(ticketDev, /Jabón equivocado/);
    assert.match(ticketDev, /-\$25\.00/);
    assert.match(ticketDev, /Neto tras devoluci[oó]n:\s+\$25\.00/i);
  });
});
