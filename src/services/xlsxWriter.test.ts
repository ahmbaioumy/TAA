import assert from 'node:assert/strict';
import { buildXlsxWorkbook, crc32, sanitizeSheetName } from './xlsxWriter';
import { buildEmlForAction, buildEmlZip, buildEmlZipFileName, buildUniqueEmlFileNames, shouldBundleEmlZip } from './emlBuilder';
import { DEFAULT_CONFIG, importConfigFromJson, normalizeEmailZipEnabled, normalizeEmailZipThreshold } from './configRegistry';
import { EmailActionItem } from '../types/taa';

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

// --- Bundled email drafts: one stored .zip of .eml files (emlBuilder.buildEmlZip) ---
const emlAction: EmailActionItem = {
  row_id: 'r1', base_row_id: 'r1', template_key: 'late_login_absence', emp_id: '4500001', name: 'Test User',
  nominate_date: '06/09/2026', role_tier: 'OPS', category: 'Late Login', variance_minutes: 61,
  taa_action: 'ABSENT_SEGMENT', communication_rule: 'EMAIL_STAFF_CC_MANAGER', extra_2_alias: 'test.user',
  email_adr: 'test.user@example.test', resolved_username: 'test.user', login_id: '12345', section: 'TEST',
  subject: 'Late login — 06/09/2026', body: 'Dear Test User,\nلقد تأخرت', to: 'test.user@thecontactcentre.ae',
};
const emlActions: EmailActionItem[] = [
  emlAction,
  { ...emlAction, row_id: 'r2', base_row_id: 'r2' }, // same file name as r1 -> must get a _2 suffix
  { ...emlAction, row_id: 'r3', base_row_id: 'r3', template_key: 'ops_digest', section: 'Prestige', to: '', ops_mailbox: 'prestige@example.test' },
];
const emlZipEntries = readZip(buildEmlZip(emlActions));
const expectedEmlNames = buildUniqueEmlFileNames(emlActions);
assert.equal(emlZipEntries.length, 3, 'one .eml per action inside the zip');
assert.deepEqual(emlZipEntries.map(e => e.name), expectedEmlNames, 'zip entries use the same unique names a separate download would');
assert.equal(new Set(emlZipEntries.map(e => e.name)).size, 3, 'entry names must be unique');
emlZipEntries.forEach((entry, i) => {
  assert.ok(entry.name.endsWith('.eml'), `${entry.name} must be a .eml`);
  assert.equal(crc32(entry.data), entry.storedCrc, `CRC-32 mismatch for ${entry.name}`);
  const text = new TextDecoder().decode(entry.data);
  assert.equal(text, buildEmlForAction(emlActions[i]), `${entry.name} must be byte-identical to the separate .eml download`);
  assert.ok(text.includes('X-Unsent: 1'), `${entry.name} must still open as an unsent draft`);
});
assert.ok(new TextDecoder().decode(emlZipEntries[2].data).includes('To: prestige@example.test'), 'an OPS digest in the zip is addressed to its ops_mailbox');
assert.equal(buildEmlZipFileName('27092026', 6), 'TAA_Email_Drafts_27092026_6.zip');

// --- ZIP toggle + threshold (config.emailZipEnabled / emailZipThreshold) ---
assert.equal(DEFAULT_CONFIG.emailZipEnabled, true, 'bundling ships ON');
assert.equal(DEFAULT_CONFIG.emailZipThreshold, 2, 'the browser prompts from the 2nd download, so the default is 2');
assert.equal(shouldBundleEmlZip(6, true, 2), true, '6 drafts, on, threshold 2 -> zip');
assert.equal(shouldBundleEmlZip(2, true, 2), true, 'count == threshold -> zip');
assert.equal(shouldBundleEmlZip(1, true, 2), false, 'below threshold -> separate .eml');
assert.equal(shouldBundleEmlZip(6, false, 2), false, 'toggle OFF -> always separate .eml');
assert.equal(shouldBundleEmlZip(0, true, 1), false, 'nothing to download -> no zip');
assert.equal(normalizeEmailZipThreshold(undefined), 2);
assert.equal(normalizeEmailZipThreshold('abc'), 2);
assert.equal(normalizeEmailZipThreshold(0), 1);
assert.equal(normalizeEmailZipThreshold(-3), 1);
assert.equal(normalizeEmailZipThreshold(3.7), 3);
assert.equal(normalizeEmailZipThreshold('5'), 5);
assert.equal(normalizeEmailZipEnabled(undefined), true, 'older configs without the field get the default ON');
assert.equal(normalizeEmailZipEnabled(false), false);
const legacyImport = importConfigFromJson(JSON.stringify({ ...DEFAULT_CONFIG, emailZipEnabled: undefined, emailZipThreshold: undefined }));
assert.equal(legacyImport.emailZipEnabled, true, 'a config exported before these fields existed imports with bundling ON');
assert.equal(legacyImport.emailZipThreshold, 2);

console.log('xlsxWriter tests passed.');
