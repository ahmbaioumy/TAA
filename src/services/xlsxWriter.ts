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

import { buildZip, ZipEntry } from './zipWriter';

// Re-exported so existing callers/tests that import crc32 from here keep working.
export { crc32 } from './zipWriter';

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
