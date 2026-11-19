import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  generateCatalogImportCsvTemplate,
  parseCsvText,
  previewCatalogImport,
  excelSerialToIsoDate,
  normalizeImportDate,
} from './catalog-import.ts';
import { parseXlsxBuffer } from './xlsx-reader.ts';

function buildMinimalZip(files: Array<{ name: string; data: Uint8Array; compress?: boolean }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const uncompressed = f.data;
    const method = f.compress === false ? 0 : 8;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(uncompressed)) : uncompressed;
    const crcVal = crc32(uncompressed) >>> 0;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crcVal, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, uncompressed.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, compressed);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crcVal, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, uncompressed.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + compressed.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of centralParts) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);

  const totalLen = offset + cdSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of [...localParts, ...centralParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

test('Importación CSV: parseCsvText soporta BOM UTF-8, coma, punto y coma y comillas escapadas', () => {
  const templateCsv = generateCatalogImportCsvTemplate();
  assert.equal(templateCsv.startsWith('\uFEFF'), true);
  const templateRows = parseCsvText(templateCsv);
  assert.equal(templateRows.length, 3);
  assert.equal(templateRows[0][0], 'Nombre');

  const semicolonCsv =
    '\uFEFFNombre;Precio de venta;Costo unitario;Código de barras\r\n' +
    '"Crema Lala, 200ml";$19.50;14,20;7501020512999\r\n' +
    '"Sal ""La Fina"" 1kg";$22.00;16.00;\r\n';
  const rows = parseCsvText(semicolonCsv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'Crema Lala, 200ml');
  assert.equal(rows[1][2], '14,20');
  assert.equal(rows[2][0], 'Sal "La Fina" 1kg');
});

test('Importación Excel (.xlsx): parseXlsxBuffer lee sharedStrings, inlineStr, booleanos y rechaza .xls antiguo', async () => {
  const enc = new TextEncoder();
  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Productos" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    </Relationships>`;
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
      <si><t>Nombre</t></si>
      <si><t>Precio de venta</t></si>
      <si><t>Costo unitario</t></si>
      <si><t>A granel</t></si>
    </sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="s"><v>1</v></c>
          <c r="C1" t="s"><v>2</v></c>
          <c r="D1" t="s"><v>3</v></c>
        </row>
        <row r="2">
          <c r="A2" t="inlineStr"><is><t>Azúcar Morena &amp; Natural</t></is></c>
          <c r="B2"><v>34.5</v></c>
          <c r="C2"><v>26</v></c>
          <c r="D2" t="b"><v>1</v></c>
        </row>
      </sheetData>
    </worksheet>`;

  const xlsxBytes = buildMinimalZip([
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(relsXml) },
    { name: 'xl/sharedStrings.xml', data: enc.encode(sharedStringsXml) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);

  const rows = await parseXlsxBuffer(xlsxBytes);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['Nombre', 'Precio de venta', 'Costo unitario', 'A granel']);
  assert.deepEqual(rows[1], ['Azúcar Morena & Natural', '34.5', '26', 'SI']);

  // Rechaza firma OLE2 (.xls antiguo) con mensaje claro
  const oleLegacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(() => parseXlsxBuffer(oleLegacy), /formato antiguo \(\.xls\)/i);
});

test('Importación masiva: previewCatalogImport valida errores por fila, duplicados, roles y fechas Excel', () => {
  assert.equal(excelSerialToIsoDate(46752), '2027-12-31');
  assert.equal(normalizeImportDate('31/12/2028').iso, '2028-12-31');

  const templatePreview = previewCatalogImport(parseCsvText(generateCatalogImportCsvTemplate()), []);
  assert.equal(templatePreview.headerError, undefined);
  assert.equal(templatePreview.toCreateCount, 2);
  assert.equal(templatePreview.errorCount, 0);

  const existing = [
    {
      sku: 'LAC-LAL-1L',
      name: 'Leche Lala Entera 1L',
      barcode: '7501020512111',
      barcodes: ['7501020512111', '012345678905'],
      salePrice: 26,
      historicCost: 21,
    },
  ];

  const rows = [
    ['Nombre', 'Código de barras', 'Clave interna', 'Precio de venta', 'Costo unitario', 'Stock inicial', 'Caducidad'],
    ['Producto Nuevo', '7501000111999', '', '25.00', '18.00', '12', '46752'],
    ['Leche Lala Actualizada', '0012345678905', '', '28.00', '22.00', '99', '30/06/2028'],
    ['Repetido Archivo', '7501000111999', '', '15.00', '10.00', '5', ''],
    ['A', '7501000888777', '', '0', '-2', '-1', ''],
  ];

  // 1) Modo SKIP con Encargado
  const skipPreview = previewCatalogImport(rows, existing, { duplicateMode: 'SKIP', allowPriceUpdate: false });
  assert.equal(skipPreview.toCreateCount, 1);
  assert.equal(skipPreview.skippedCount, 1);
  assert.equal(skipPreview.errorCount, 2);
  assert.equal(skipPreview.rows[0].normalized.expiry, '2027-12-31');

  // 2) Modo UPDATE con Encargado bloquea cambio de precios en existente
  const encargadoUpdate = previewCatalogImport(rows, existing, { duplicateMode: 'UPDATE', allowPriceUpdate: false });
  assert.equal(encargadoUpdate.rows[1].status, 'ERROR');
  assert.match(encargadoUpdate.rows[1].errors[0], /Solo el Administrador puede cambiar precios/);

  // 3) Modo UPDATE con Administrador permite actualizar y advierte que no sobrescribe existencias
  const adminUpdate = previewCatalogImport(rows, existing, { duplicateMode: 'UPDATE', allowPriceUpdate: true });
  assert.equal(adminUpdate.rows[1].action, 'UPDATE');
  assert.equal(adminUpdate.toUpdateCount, 1);
  assert.equal(adminUpdate.rows[1].warnings.some((w) => w.includes('no se sobrescriben')), true);
});
