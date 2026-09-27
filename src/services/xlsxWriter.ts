// Minimal, dependency-free .xlsx (OOXML) writer. This project ships as a
// single standalone HTML file with zero runtime dependencies beyond React —
// pulling in a library like SheetJS (~950KB) for one export button would
// break that convention, so this hand-rolls just enough of OOXML + ZIP to
// produce a valid multi-sheet workbook Excel opens with no repair prompt.
//
// Design choices that keep this small:
// - ZIP entries use the "stored" (uncompressed) method — no deflate needed,
//   just a CRC-32 and plain header records, so there's no dependency on
//   CompressionStream support.
// - Cells use inline strings (t="inlineStr") instead of a shared-strings
//   table — simpler, and fully valid OOXML at this data scale (rows in the
//   tens to low hundreds per sheet).
// - Multi-line cell values (embedded \n) are supported via a single shared
//   wrapText style applied to every cell, so exported sheets can mirror the
//   ResultsView table's grouped, multi-line cells exactly.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

// Only & < > need escaping in XML text content (" and ' are safe inside
// <t>...</t>); a handful of C0 control characters are outright illegal in
// XML 1.0 and are stripped rather than escaped (embedded \n/\t/\r are kept —
// \n is exactly how a multi-line cell encodes its line breaks).
function escapeXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function columnLetter(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel sheet-name rules: max 31 chars, no [ ] : * ? / \, not blank, can't
// start/end with an apostrophe. A generic safety net for the reusable
// writer — the 7 TAA tab labels this project actually uses already satisfy
// all of this untouched.
export function sanitizeSheetName(name: string): string {
  let s = (name || '').replace(/[[\]:*?/\\]/g, '');
  s = s.slice(0, 31);
  s = s.replace(/^'+|'+$/g, '');
  return s || 'Sheet';
}

function uniqueSheetNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(raw => {
    const name = sanitizeSheetName(raw);
    const key = name.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const suffix = ` (${count + 1})`;
    return sanitizeSheetName(name.slice(0, 31 - suffix.length) + suffix);
  });
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function buildContentTypesXml(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + overrides
    + '</Types>';
}

function buildRootRelsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
}

function buildWorkbookXml(sheetNames: string[]): string {
  const sheets = sheetNames.map((name, i) =>
    `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');
  return `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets}</sheets>`
    + '</workbook>';
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  const stylesRel = `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${stylesRel}</Relationships>`;
}

// Single style (index 0): wrapText so embedded \n in a cell renders as a
// line break, matching the ResultsView table's multi-line cells.
const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>'
  + '</styleSheet>';

function buildSheetXml(rows: string[][]): string {
  const rowsXml = rows.map((row, rIdx) => {
    const r = rIdx + 1;
    const cells = row.map((value, cIdx) => {
      const ref = `${columnLetter(cIdx)}${r}`;
      const text = escapeXml(String(value ?? ''));
      return `<c r="${ref}" t="inlineStr" s="0"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  return `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// A ZIP file needs no compression to be valid — "stored" entries (method 0)
// just need a correct CRC-32 and the standard local/central header records.
// All multi-byte fields are little-endian, written via DataView so field
// offsets can't drift.
function buildZip(entries: ZipEntry[]): Uint8Array {
  const { time, date } = dosDateTime(new Date());
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed to extract
    ldv.setUint16(6, 0, true); // general purpose flag
    ldv.setUint16(8, 0, true); // compression method: stored
    ldv.setUint16(10, time, true);
    ldv.setUint16(12, date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true); // compressed size
    ldv.setUint32(22, size, true); // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    localChunks.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed to extract
    cdv.setUint16(8, 0, true); // general purpose flag
    cdv.setUint16(10, 0, true); // compression method: stored
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra field length
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal file attributes
    cdv.setUint32(38, 0, true); // external file attributes
    cdv.setUint32(42, offset, true); // relative offset of local header
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + entry.data.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central directory start
  edv.setUint16(8, entries.length, true); // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, centralDirSize, true);
  edv.setUint32(16, centralDirOffset, true);
  edv.setUint16(20, 0, true); // comment length

  const total = centralDirOffset + centralDirSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) { out.set(chunk, pos); pos += chunk.length; }
  for (const chunk of centralChunks) { out.set(chunk, pos); pos += chunk.length; }
  out.set(eocd, pos);
  return out;
}

export function buildXlsxWorkbook(sheets: { name: string; rows: string[][] }[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = uniqueSheetNames(sheets.map(s => s.name));

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(buildContentTypesXml(sheets.length)) },
    { name: '_rels/.rels', data: encoder.encode(buildRootRelsXml()) },
    { name: 'xl/workbook.xml', data: encoder.encode(buildWorkbookXml(names)) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(buildWorkbookRelsXml(sheets.length)) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(buildSheetXml(sheet.rows)),
    })),
  ];

  return buildZip(entries);
}
