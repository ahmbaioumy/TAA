import assert from 'node:assert/strict';
import { buildXlsxWorkbook, crc32, sanitizeSheetName } from './xlsxWriter';

// A minimal, INDEPENDENT zip central-directory reader — deliberately not
// sharing any code with xlsxWriter.ts's writer, so a bug in the writer's own
// assumptions about its format isn't invisible to a reader built on the same
// assumptions. Only needs to handle "stored" (uncompressed) entries, since
// that's all the writer ever produces.
interface ReadEntry {
  name: string;
  data: Uint8Array;
  storedCrc: number;
}

function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD has no comment in anything this writer produces, so it's always
  // exactly the last 22 bytes.
  const eocdOffset = bytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, 'EOCD signature must be at the expected offset (no comment expected)');
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ReadEntry[] = [];
  let pos = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(view.getUint32(pos, true), 0x02014b50, `central directory entry ${i} signature`);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `local header signature for ${name}`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);

    entries.push({ name, data, storedCrc: crc });
  }
  return entries;
}

// Enough to catch a missing/misplaced closing tag without a real XML parser:
// walk open/self-closing/close tags with a stack, ignoring the <?xml ...?>
// declaration, and assert the stack is empty at the end.
function assertWellFormedXml(xmlText: string, label: string) {
  assert.ok(xmlText.startsWith('<?xml'), `${label} should start with an XML declaration`);
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z0-9_:.-]+)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xmlText))) {
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `${label}: mismatched closing tag </${name}> (expected </${top}>)`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, `${label}: unclosed tag(s) remain: ${stack.join(', ')}`);
}

// --- sanitizeSheetName ---
assert.equal(sanitizeSheetName('All'), 'All');
assert.equal(sanitizeSheetName('1. Shift Changed'), '1. Shift Changed');
assert.equal(sanitizeSheetName('Bad[Na]me:Here?/\\*'), 'BadNameHere', 'disallowed characters must be stripped');
assert.equal(sanitizeSheetName("'quoted'"), 'quoted', 'leading/trailing apostrophes must be stripped');
assert.equal(sanitizeSheetName(''), 'Sheet', 'blank input must fall back to a non-empty name');
assert.equal(sanitizeSheetName('x'.repeat(50)).length, 31, 'names over 31 chars must be truncated');

// --- crc32 sanity: known vector "123456789" -> 0xCBF43926 (standard check value) ---
assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);

// --- Round-trip a small 2-sheet workbook ---
const sheets = [
  { name: 'All', rows: [
    ['Include', 'Employee'],
    ['Yes', 'A & B <Co> "Ltd" it\'s\nline two'],
  ] },
  { name: '1. Shift Changed', rows: [
    ['Include', 'Employee'],
  ] },
];
const bytes = buildXlsxWorkbook(sheets);
const entries = readZip(bytes);

// 2 sheets + 5 fixed parts ([Content_Types].xml, _rels/.rels, workbook.xml,
// workbook.xml.rels, styles.xml).
assert.equal(entries.length, 7, 'expected 5 fixed parts + 2 worksheet parts');

for (const entry of entries) {
  const actualCrc = crc32(entry.data);
  assert.equal(actualCrc, entry.storedCrc, `CRC-32 mismatch for ${entry.name} — archive is corrupt`);
}

const byName = new Map(entries.map(e => [e.name, e.data]));
const decode = (name: string) => new TextDecoder().decode(byName.get(name)!);

for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
  assert.ok(byName.has(name), `missing expected part: ${name}`);
  assertWellFormedXml(decode(name), name);
}

const workbookXml = decode('xl/workbook.xml');
assert.ok(workbookXml.includes('name="All"'), 'workbook.xml must list the "All" sheet');
assert.ok(workbookXml.includes('name="1. Shift Changed"'), 'workbook.xml must list the "1. Shift Changed" sheet');

const sheet1Xml = decode('xl/worksheets/sheet1.xml');
assert.ok(sheet1Xml.includes('&amp;'), 'escaped &');
assert.ok(sheet1Xml.includes('&lt;Co&gt;'), 'escaped < and >');
assert.ok(sheet1Xml.includes('"Ltd" it\'s'), 'plain " and \' need no escaping inside <t>');
assert.ok(sheet1Xml.includes('line two'), 'embedded newline content must survive into the cell text');

console.log('xlsxWriter tests passed.');
