/**
 * Generador y formateador de tickets de venta imprimibles (Bloque H).
 *
 * Soporta anchos térmicos de 58 mm (32 columnas estándar) y 80 mm (48 columnas estándar)
 * con reglas nativas de `@media print`, sin dependencias ni librerías externas.
 */

import type { SaleRecord } from './sales';

export type TicketPaperWidth = '58mm' | '80mm';

export interface TicketFormatOptions {
  storeName: string;
  businessAddress?: string;
  businessPhone?: string;
  isCopy?: boolean;
  paperWidth?: TicketPaperWidth;
}

/**
 * Centra un texto dentro de un ancho de columna determinado.
 */
function centerText(text: string, width: number): string {
  const clean = text.trim();
  if (clean.length >= width) return clean.slice(0, width);
  const leftPad = Math.floor((width - clean.length) / 2);
  const rightPad = width - clean.length - leftPad;
  return ' '.repeat(leftPad) + clean + ' '.repeat(rightPad);
}

/**
 * Formatea una línea con texto alineado a la izquierda y número/valor alineado a la derecha.
 */
function formatTwoColumns(left: string, right: string, width: number): string {
  const l = left.trim();
  const r = right.trim();
  const totalLen = l.length + r.length;
  if (totalLen >= width) {
    const maxLeft = Math.max(width - r.length - 1, 0);
    return l.slice(0, maxLeft) + ' ' + r;
  }
  const spaces = width - totalLen;
  return l + ' '.repeat(spaces) + r;
}

/**
 * Formatea un ticket en texto monoespaciado plano para impresoras térmicas de 58 mm o 80 mm.
 */
export function formatTicketText(sale: SaleRecord, options: TicketFormatOptions): string {
  const width = options.paperWidth === '80mm' ? 48 : 32;
  const sep = '-'.repeat(width);
  const doubleSep = '='.repeat(width);
  const lines: string[] = [];

  // 1. Marca de copia prominente si es reimpresión
  if (options.isCopy) {
    lines.push(doubleSep);
    lines.push(centerText('*** COPIA DE TICKET ***', width));
    lines.push(doubleSep);
  }

  // 2. Encabezado del negocio
  lines.push(centerText(options.storeName || 'Mi Tiendita', width));
  if (options.businessAddress) {
    lines.push(centerText(options.businessAddress, width));
  }
  if (options.businessPhone) {
    lines.push(centerText(`Tel: ${options.businessPhone}`, width));
  }
  lines.push(sep);

  // 3. Metadatos de la venta
  lines.push(formatTwoColumns(`Folio: #${sale.folio}`, `Fecha: ${sale.date}`, width));
  lines.push(formatTwoColumns(`Hora: ${new Date(sale.timestamp).toLocaleTimeString()}`, `Cajero: ${sale.cashier}`, width));
  if (sale.paymentType === 'FIADO' && sale.customerName) {
    lines.push(formatTwoColumns('Cliente:', sale.customerName, width));
  }
  lines.push(sep);

  // 4. Detalle de partidas
  if (width === 48) {
    lines.push(formatTwoColumns('Cant  Descripcion', 'P.Unit    Importe', width));
  } else {
    lines.push(formatTwoColumns('Cant Descripcion', 'P.U     Total', width));
  }
  lines.push(sep);

  for (const item of sale.items) {
    const qtyStr = item.qty.toString();
    const unitPriceStr = `$${item.unitPrice.toFixed(2)}`;
    const subtotalStr = `$${item.subtotal.toFixed(2)}`;

    if (width === 48 && item.name.length <= 22) {
      const colLeft = `${qtyStr.padEnd(5)} ${item.name}`;
      const colRight = `${unitPriceStr.padStart(8)} ${subtotalStr.padStart(10)}`;
      lines.push(formatTwoColumns(colLeft, colRight, width));
    } else {
      // Formato multilínea estándar térmico: nombre completo sin truncar
      lines.push(item.name);
      const detailLeft = `  ${qtyStr} x ${unitPriceStr}`;
      lines.push(formatTwoColumns(detailLeft, subtotalStr, width));
    }

    if (item.returnedQty > 0) {
      const devStr = `  (Devuelto: -${item.returnedQty} ${item.saleUnit || 'pz'})`;
      lines.push(devStr);
    }
  }

  lines.push(sep);

  // 5. Totales
  lines.push(formatTwoColumns('Subtotal:', `$${sale.subtotal.toFixed(2)}`, width));
  if (sale.discountAmount && sale.discountAmount > 0) {
    lines.push(formatTwoColumns('Descuento:', `-$${sale.discountAmount.toFixed(2)}`, width));
  }
  lines.push(formatTwoColumns('TOTAL:', `$${sale.total.toFixed(2)}`, width));

  // 6. Forma de pago y saldo
  lines.push(sep);
  lines.push(formatTwoColumns('Forma de pago:', sale.paymentType, width));

  if (sale.paymentType === 'EFECTIVO') {
    if (typeof sale.cashReceived === 'number') {
      lines.push(formatTwoColumns('Efectivo recibido:', `$${sale.cashReceived.toFixed(2)}`, width));
    }
    if (typeof sale.change === 'number') {
      lines.push(formatTwoColumns('Cambio:', `$${sale.change.toFixed(2)}`, width));
    }
  } else if (sale.paymentType === 'FIADO') {
    if (typeof sale.customerPreviousBalance === 'number') {
      lines.push(formatTwoColumns('Saldo anterior:', `$${sale.customerPreviousBalance.toFixed(2)}`, width));
    }
    lines.push(formatTwoColumns('Cargo de hoy:', `$${sale.total.toFixed(2)}`, width));
    if (typeof sale.customerNewBalance === 'number') {
      lines.push(formatTwoColumns('Nuevo saldo deudor:', `$${sale.customerNewBalance.toFixed(2)}`, width));
    }
  }

  // 7. Sección de devoluciones asociadas si existen
  if (sale.returns && sale.returns.length > 0) {
    lines.push(sep);
    lines.push(centerText('CONTRA-ASIENTOS / DEVOLUCIONES', width));
    for (const ret of sale.returns) {
      lines.push(formatTwoColumns(`Devolución #${ret.id}`, `-$${ret.totalRefund.toFixed(2)}`, width));
      lines.push(` Motivo: ${ret.reason}`);
      lines.push(` Autorizó: ${ret.authorizedBy}`);
    }
    const totalRefunds = sale.returns.reduce((acc, r) => acc + r.totalRefund, 0);
    const netCharged = Math.max(0, sale.total - totalRefunds);
    lines.push(formatTwoColumns('Neto tras devolución:', `$${netCharged.toFixed(2)}`, width));
  }

  // 8. Pie de página
  lines.push(doubleSep);
  lines.push(centerText('¡Gracias por su compra!', width));
  lines.push(centerText('Conserve este ticket para devoluciones', width));
  lines.push('\n');

  return lines.join('\n');
}

/**
 * Genera el documento HTML formateado para impresión térmica (`@media print`).
 */
export function formatTicketHtml(sale: SaleRecord, options: TicketFormatOptions): string {
  const paperClass = options.paperWidth === '80mm' ? 'ticket-80mm' : 'ticket-58mm';
  const widthPx = options.paperWidth === '80mm' ? '280px' : '200px';

  const copyBanner = options.isCopy
    ? `<div class="ticket-copy-banner">*** COPIA DE TICKET ***</div>`
    : '';

  const itemsHtml = sale.items
    .map(
      (item) => `
    <tr>
      <td class="text-left">${item.qty}</td>
      <td class="text-left">
        ${item.name}
        ${item.returnedQty > 0 ? `<div class="returned-tag">(Devuelto: -${item.returnedQty} ${item.saleUnit || 'pz'})</div>` : ''}
      </td>
      <td class="text-right">$${item.unitPrice.toFixed(2)}</td>
      <td class="text-right font-bold">$${item.subtotal.toFixed(2)}</td>
    </tr>`
    )
    .join('');

  let creditDetailsHtml = '';
  if (sale.paymentType === 'FIADO') {
    creditDetailsHtml = `
      <div class="row"><span>Cliente:</span><strong>${sale.customerName || 'Cliente fiado'}</strong></div>
      ${typeof sale.customerPreviousBalance === 'number' ? `<div class="row"><span>Saldo anterior:</span><span>$${sale.customerPreviousBalance.toFixed(2)}</span></div>` : ''}
      <div class="row"><span>Cargo de hoy:</span><span>$${sale.total.toFixed(2)}</span></div>
      ${typeof sale.customerNewBalance === 'number' ? `<div class="row font-bold highlight"><span>Nuevo saldo deudor:</span><span>$${sale.customerNewBalance.toFixed(2)}</span></div>` : ''}
    `;
  } else {
    creditDetailsHtml = `
      ${typeof sale.cashReceived === 'number' ? `<div class="row"><span>Recibido:</span><span>$${sale.cashReceived.toFixed(2)}</span></div>` : ''}
      ${typeof sale.change === 'number' ? `<div class="row font-bold"><span>Cambio:</span><span>$${sale.change.toFixed(2)}</span></div>` : ''}
    `;
  }

  let returnsHtml = '';
  if (sale.returns && sale.returns.length > 0) {
    const totalRefunds = sale.returns.reduce((acc, r) => acc + r.totalRefund, 0);
    returnsHtml = `
      <div class="divider dashed"></div>
      <div class="text-center font-bold">CONTRA-ASIENTOS / DEVOLUCIONES</div>
      ${sale.returns
        .map(
          (r) => `
        <div class="row text-red"><span>Devolución #${r.id}:</span><span>-$${r.totalRefund.toFixed(2)}</span></div>
        <div class="text-xs text-muted">Motivo: ${r.reason} (Aut: ${r.authorizedBy})</div>
      `
        )
        .join('')}
      <div class="row font-bold"><span>Neto resultante:</span><span>$${Math.max(0, sale.total - totalRefunds).toFixed(2)}</span></div>
    `;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Ticket #${sale.folio}</title>
  <style>
    @page {
      margin: 0;
      size: ${options.paperWidth || '58mm'} auto;
    }
    body {
      margin: 0;
      padding: 8px 6px;
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      line-height: 1.25;
      color: #000;
      background: #fff;
      width: ${widthPx};
      max-width: ${widthPx};
    }
    .ticket-copy-banner {
      border-top: 2px solid #000;
      border-bottom: 2px solid #000;
      text-align: center;
      font-weight: bold;
      padding: 4px 0;
      margin-bottom: 6px;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .font-bold { font-weight: bold; }
    .text-xs { font-size: 10px; }
    .text-muted { color: #444; }
    .store-name { font-size: 14px; font-weight: bold; text-align: center; }
    .divider { border-bottom: 1px solid #000; margin: 4px 0; }
    .divider.dashed { border-bottom: 1px dashed #000; }
    .row { display: flex; justify-content: space-between; margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin: 4px 0; }
    th { border-bottom: 1px solid #000; padding: 2px 0; font-size: 11px; }
    td { padding: 2px 0; vertical-align: top; }
    .returned-tag { font-size: 10px; font-style: italic; color: #555; }
    .highlight { background: #eee; padding: 2px; }
    @media print {
      body { width: 100%; max-width: 100%; }
      .no-print { display: none; }
    }
  </style>
</head>
<body class="${paperClass}">
  ${copyBanner}
  <div class="store-name">${options.storeName || 'Mi Tiendita'}</div>
  ${options.businessAddress ? `<div class="text-center text-xs">${options.businessAddress}</div>` : ''}
  ${options.businessPhone ? `<div class="text-center text-xs">Tel: ${options.businessPhone}</div>` : ''}
  
  <div class="divider"></div>
  <div class="row"><span>Folio:</span><strong>#${sale.folio}</strong></div>
  <div class="row"><span>Fecha:</span><span>${sale.date}</span></div>
  <div class="row"><span>Cajero:</span><span>${sale.cashier}</span></div>

  <div class="divider dashed"></div>
  <table>
    <thead>
      <tr>
        <th class="text-left" style="width: 15%;">Cant</th>
        <th class="text-left" style="width: 45%;">Desc</th>
        <th class="text-right" style="width: 20%;">P.U</th>
        <th class="text-right" style="width: 20%;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml}
    </tbody>
  </table>

  <div class="divider"></div>
  <div class="row"><span>Subtotal:</span><span>$${sale.subtotal.toFixed(2)}</span></div>
  ${sale.discountAmount && sale.discountAmount > 0 ? `<div class="row"><span>Descuento:</span><span>-$${sale.discountAmount.toFixed(2)}</span></div>` : ''}
  <div class="row font-bold" style="font-size: 13px;"><span>TOTAL:</span><span>$${sale.total.toFixed(2)}</span></div>

  <div class="divider dashed"></div>
  <div class="row"><span>Forma de pago:</span><strong>${sale.paymentType}</strong></div>
  ${creditDetailsHtml}

  ${returnsHtml}

  <div class="divider"></div>
  <div class="text-center text-xs" style="margin-top: 6px;">¡Gracias por su compra!</div>
  <div class="text-center text-xs">Conserve su comprobante</div>
</body>
</html>
  `.trim();
}
