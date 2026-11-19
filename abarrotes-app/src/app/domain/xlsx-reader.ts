/**
 * Lector ligero y 100% offline de archivos Excel (.xlsx) en TypeScript puro.
 *
 * Lee la estructura ZIP (Central Directory + DecompressionStream 'deflate-raw')
 * y XML de `sharedStrings.xml` + primera hoja de `xl/worksheets/` sin dependencias externas.
 */

export interface ZipEntryMeta {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const textDecoder = new TextDecoder('utf-8');

function decodeXmlEntities(input: string): string {
  if (!input || !input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (entity.startsWith('#x')) {
          const cp = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
        }
        if (entity.startsWith('#')) {
          const cp = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
        }
        return _match;
      }
    }
  });
}

function findEocdOffset(bytes: Uint8Array, view: DataView): number {
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function readZipCentralDirectory(bytes: Uint8Array): Map<string, ZipEntryMeta> {
  if (bytes.length < 4) {
    throw new Error('El archivo está vacío o incompleto.');
  }

  // Firma OLE2 (.xls binario de Excel 97-2003)
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error(
      'El archivo está en formato antiguo (.xls). Ábrelo en Excel y guárdalo como Libro de Excel (.xlsx) o CSV (.csv).'
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('El archivo no tiene un formato de libro Excel (.xlsx) válido.');
  }

  const eocdOffset = findEocdOffset(bytes, view);
  if (eocdOffset < 0) {
    throw new Error('No se pudo leer la estructura interna del archivo .xlsx.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + 46 > bytes.length) {
    throw new Error('El directorio interno del archivo .xlsx está dañado.');
  }

  const entries = new Map<string, ZipEntryMeta>();
  let pos = cdOffset;
  for (let i = 0; i < totalEntries && pos + 46 <= bytes.length; i++) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x02014b50) {
      throw new Error('Entrada ZIP corrupta en el archivo .xlsx.');
    }
    const compressionMethod = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameStart = pos + 46;
    const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos = nameStart + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function readZipEntryBytes(bytes: Uint8Array, meta: ZipEntryMeta): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lh = meta.localHeaderOffset;
  if (lh + 30 > bytes.length || view.getUint32(lh, true) !== 0x04034b50) {
    throw new Error(`No se pudo abrir la sección "${meta.name}" dentro del archivo .xlsx.`);
  }
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const dataEnd = dataStart + meta.compressedSize;
  if (dataEnd > bytes.length) {
    throw new Error(`La sección "${meta.name}" del archivo .xlsx está truncada.`);
  }

  const rawSlice = bytes.slice(dataStart, dataEnd);
  if (meta.compressionMethod === 0) {
    return rawSlice;
  }
  if (meta.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Tu navegador no soporta lectura nativa de archivos .xlsx; guarda el archivo como CSV (.csv).');
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rawSlice);
        controller.close();
      },
    }).pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(
    `El método de compresión (${meta.compressionMethod}) de este archivo .xlsx no es compatible. Guárdalo como CSV (.csv).`
  );
}

function getEntryByPath(entries: Map<string, ZipEntryMeta>, candidatePath: string): ZipEntryMeta | undefined {
  const clean = candidatePath.replace(/^\/+/, '');
  const exact = entries.get(clean);
  if (exact) return exact;
  const lower = clean.toLowerCase();
  for (const [k, v] of entries.entries()) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function colRefToIndex(colLetters: string): number {
  let col = 0;
  const upper = colLetters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function getAttr(attrStr: string, attrName: string): string {
  const escaped = attrName.replace(/[:\-]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(attrStr);
  return m ? decodeXmlEntities(m[1]) : '';
}

function parseSharedStringsXml(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<(?:[a-zA-Z0-9]+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?si>/gi;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRe.exec(xml)) !== null) {
    const inner = siMatch[1];
    const tRe = /<(?:[a-zA-Z0-9]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?t>/gi;
    let combined = '';
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRe.exec(inner)) !== null) {
      combined += decodeXmlEntities(tMatch[1]);
    }
    out.push(combined);
  }
  return out;
}

function resolveFirstWorksheetPath(
  entries: Map<string, ZipEntryMeta>,
  workbookXml: string | null,
  relsXml: string | null
): string | null {
  if (workbookXml) {
    const sheetMatch = /<(?:[a-zA-Z0-9]+:)?sheet\b([^>]*)\/?>/i.exec(workbookXml);
    if (sheetMatch) {
      const attrs = sheetMatch[1];
      const relId = getAttr(attrs, 'r:id') || getAttr(attrs, 'id');
      if (relId && relsXml) {
        const relRe = /<Relationship\b([^>]*)\/?>/gi;
        let relMatch: RegExpExecArray | null;
        while ((relMatch = relRe.exec(relsXml)) !== null) {
          const relAttrs = relMatch[1];
          if (getAttr(relAttrs, 'Id') === relId) {
            const target = getAttr(relAttrs, 'Target');
            if (target) {
              const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\//, '')}`;
              if (getEntryByPath(entries, normalized)) return normalized;
              if (getEntryByPath(entries, target)) return target;
            }
          }
        }
      }
    }
  }

  if (getEntryByPath(entries, 'xl/worksheets/sheet1.xml')) {
    return 'xl/worksheets/sheet1.xml';
  }
  const candidates = Array.from(entries.keys())
    .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/i.test(k))
    .sort();
  return candidates[0] ?? null;
}

function parseWorksheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<(?:[a-zA-Z0-9]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?row>/gi;
  const cellRe = /<(?:[a-zA-Z0-9]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?c>)/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowBody = rowMatch[1];
    const rowCells: string[] = [];
    let sequentialCol = 0;

    cellRe.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const refAttr = getAttr(attrs, 'r');
      const colMatch = /^([A-Za-z]+)/.exec(refAttr);
      const colIdx = colMatch ? colRefToIndex(colMatch[1]) : sequentialCol;
      sequentialCol = colIdx + 1;

      while (rowCells.length <= colIdx) rowCells.push('');

      if (!body) continue;

      const cellType = getAttr(attrs, 't');
      let value = '';
      if (cellType === 's') {
        const vMatch = /<(?:[a-zA-Z0-9]+:)?v[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?v>/i.exec(body);
        if (vMatch) {
          const idx = Number.parseInt(vMatch[1].trim(), 10);
          value = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
        }
      } else if (cellType === 'inlineStr') {
        const tRe = /<(?:[a-zA-Z0-9]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?t>/gi;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRe.exec(body)) !== null) {
          value += decodeXmlEntities(tMatch[1]);
        }
      } else if (cellType === 'b') {
        const vMatch = /<(?:[a-zA-Z0-9]+:)?v[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?v>/i.exec(body);
        value = vMatch && vMatch[1].trim() === '1' ? 'SI' : 'NO';
      } else if (cellType === 'e') {
        value = '';
      } else {
        const vMatch = /<(?:[a-zA-Z0-9]+:)?v[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?v>/i.exec(body);
        if (vMatch) {
          value = decodeXmlEntities(vMatch[1]);
        }
      }

      rowCells[colIdx] = value;
    }

    while (rowCells.length > 0 && rowCells[rowCells.length - 1] === '') {
      rowCells.pop();
    }
    if (rowCells.some((cell) => String(cell).trim().length > 0)) {
      rows.push(rowCells);
    }
  }

  return rows;
}

/**
 * Extrae las filas de la primera hoja de un archivo Excel `.xlsx` como matriz de cadenas.
 */
export async function parseXlsxBuffer(input: Uint8Array | ArrayBuffer): Promise<string[][]> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = readZipCentralDirectory(bytes);

  const readTextIfPresent = async (path: string): Promise<string | null> => {
    const meta = getEntryByPath(entries, path);
    if (!meta) return null;
    const raw = await readZipEntryBytes(bytes, meta);
    return textDecoder.decode(raw);
  };

  const workbookXml = await readTextIfPresent('xl/workbook.xml');
  const relsXml = await readTextIfPresent('xl/_rels/workbook.xml.rels');
  const sheetPath = resolveFirstWorksheetPath(entries, workbookXml, relsXml);
  if (!sheetPath) {
    throw new Error('El archivo .xlsx no contiene ninguna hoja de cálculo legible.');
  }

  const sharedStringsXml = await readTextIfPresent('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? parseSharedStringsXml(sharedStringsXml) : [];
  const sheetXml = await readTextIfPresent(sheetPath);
  if (!sheetXml) {
    throw new Error('No se pudo leer la hoja principal del archivo .xlsx.');
  }

  return parseWorksheetXml(sheetXml, sharedStrings);
}
