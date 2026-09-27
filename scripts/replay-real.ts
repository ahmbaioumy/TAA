// Reproducible real-data replay — WP8 track A3.
//
// Reproduces the documented real upload path exactly:
//   decodeFileBuffer -> importConfigFromJson(samples_Files/Config.json)
//   -> parseCognosReport(..., config.cognosDropPatterns)   (configured drop rules)
//   -> validateCmsFile per CMS file -> dedupeCmsPunches
//   -> parseAspectSegments / parseAspectIdentity
//   -> runReconciliation
//
// This is the sole committed, re-runnable proof behind every "byte-identical"
// claim in WP1-WP7. It intentionally does NOT default processingDate to the
// clock: a defaulted clock is how a replay silently stops being a replay.
// Data-set independent (launch-readiness.md Step 2): finds every CMS_*.csv and the
// Cognos report (case-insensitive) in samples_Files/ rather than one week's fixed
// filenames, and its guard checks are derived from the files (not a pinned count).
//
// Usage (from TAA_HTML/):
//   npx tsx scripts/replay-real.ts --date=DD/MM/YYYY --out=<output-dir> [--samples=<dir>]
//   npm run test:replay-real -- --date=DD/MM/YYYY --out=<output-dir>
//
// samples_Files/ is READ-ONLY to this script — it only reads from there.

import * as fs from 'fs';
import * as path from 'path';
import {
  decodeFileBuffer,
  parseCognosReport,
  parseAspectSegments,
  parseAspectIdentity,
  validateCmsFile,
  dedupeCmsPunches,
} from '../src/services/parsers';
import { importConfigFromJson } from '../src/services/configRegistry';
import { runReconciliation } from '../src/services/reconciliationEngine';
import { resolveSamplesDir, listCmsFiles, findCognosFile } from './sampleFiles';

// --- Node has no `localStorage`. importConfigFromJson() calls
// saveConfigRegistry(), which writes through localStorage. Stub it as an
// in-memory no-op so the import behaves exactly like the browser's config
// import without touching any real browser/user storage. Never removed
// after the run — this process exits immediately after.
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

// --- CLI args -----------------------------------------------------------

function parseArgs(argv: string[]): { date?: string; out?: string } {
  const result: { date?: string; out?: string } = {};
  for (const arg of argv) {
    const m = /^--(date|out)=(.*)$/.exec(arg);
    if (m) result[m[1] as 'date' | 'out'] = m[2];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (!args.date) {
  console.error(
    'FATAL: --date=DD/MM/YYYY is REQUIRED. This replay never defaults processingDate ' +
    'to the clock — an undated run is not a reproducible replay.\n' +
    'Usage: npx tsx scripts/replay-real.ts --date=DD/MM/YYYY --out=<output-dir>'
  );
  process.exit(1);
}
if (!args.out) {
  console.error('FATAL: --out=<output-directory> is REQUIRED.');
  process.exit(1);
}

function parseCliDate(s: string): Date {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (!m) {
    console.error(`FATAL: --date="${s}" is not DD/MM/YYYY.`);
    process.exit(1);
  }
  const [, dd, mm, yyyy] = m as unknown as [string, string, string, string];
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (Number.isNaN(d.getTime())) {
    console.error(`FATAL: --date="${s}" did not parse to a valid date.`);
    process.exit(1);
  }
  return d;
}

const processingDate = parseCliDate(args.date);
const outDir = path.resolve(args.out);

// --- Paths — data-set independent (launch-readiness.md Step 2): every CMS_*.csv
// found in samples_Files/ (resolved relative to CWD, or --samples=<dir> if given —
// this script is always run from TAA_HTML/, per the npm script and every other
// script in this directory), and the Cognos report matched case-insensitively. ---
const SAMPLES_DIR = resolveSamplesDir(process.argv.slice(2));
const CONFIG_PATH = path.join(SAMPLES_DIR, 'Config.json');
const COGNOS_PATH = findCognosFile(SAMPLES_DIR);
const ASPECT_SEGMENTS_PATH = path.join(SAMPLES_DIR, 'MTD_Seg.csv');
const ASPECT_IDENTITY_PATH = path.join(SAMPLES_DIR, 'employeeinfo.csv');
const CMS_FILES = listCmsFiles(SAMPLES_DIR);
if (CMS_FILES.length === 0) {
  console.error(`FATAL: no CMS_*.csv files found in ${SAMPLES_DIR}.`);
  process.exit(1);
}

function decode(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return decodeFileBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

// --- Load config first (real Config.json), exactly as the app does on
// "Import Config Registry" — this is what supplies the configured Cognos
// drop rules applied to the Cognos parse below. ---------------------------

console.log(`Loading real config: ${CONFIG_PATH}`);
const configJson = fs.readFileSync(CONFIG_PATH, 'utf-8');
const config = importConfigFromJson(configJson);

// --- Decode + parse each real input file, exactly as UploadZone.tsx does. -

console.log(`Parsing Cognos: ${COGNOS_PATH}`);
const cognosRecords = parseCognosReport(decode(COGNOS_PATH), config.cognosDropPatterns);

console.log(`Parsing ASPECT segments: ${ASPECT_SEGMENTS_PATH}`);
const aspectSegments = parseAspectSegments(decode(ASPECT_SEGMENTS_PATH));

console.log(`Parsing ASPECT identity: ${ASPECT_IDENTITY_PATH}`);
const aspectIdentities = parseAspectIdentity(decode(ASPECT_IDENTITY_PATH));

console.log(`Parsing ${CMS_FILES.length} CMS files...`);
let cmsPunchesRaw: ReturnType<typeof dedupeCmsPunches> = [];
let cmsPunchTotalAcrossFiles = 0;
for (const cmsPath of CMS_FILES) {
  const text = decode(cmsPath);
  const result = validateCmsFile(text, path.basename(cmsPath));
  if ('reason' in result) {
    console.error(`FATAL: CMS file "${cmsPath}" failed validation: ${result.reason}`);
    process.exit(1);
  }
  console.log(`  ${path.basename(cmsPath)}: ${result.punches.length} punches`);
  cmsPunchTotalAcrossFiles += result.punches.length;
  cmsPunchesRaw = cmsPunchesRaw.concat(result.punches);
}
const cmsPunches = dedupeCmsPunches(cmsPunchesRaw);
console.log(`CMS punches: ${cmsPunchTotalAcrossFiles} raw across files, ${cmsPunches.length} after dedupeCmsPunches`);

// --- Data-derived checks (launch-readiness.md Step 2) — replace the old fixed
// 38,308-punch assertion pinned to one specific week's files with a check derived
// from the files themselves: dedupe must only ever remove/keep punches, never
// invent them, and the CMS files actually parsed must contribute something. -------

if (cmsPunchTotalAcrossFiles === 0) {
  console.error(`FATAL: 0 raw CMS punches parsed across ${CMS_FILES.length} file(s) — nothing to attribute. STOP.`);
  process.exit(1);
}
if (cmsPunches.length > cmsPunchTotalAcrossFiles) {
  console.error(
    `FATAL: dedupeCmsPunches produced MORE punches (${cmsPunches.length}) than the raw total ` +
    `(${cmsPunchTotalAcrossFiles}) — dedupe must only ever remove or keep punches, never add. STOP.`
  );
  process.exit(1);
}

// --- Run the real engine. -------------------------------------------------

console.log(`Running reconciliation with processingDate=${processingDate.toDateString()}...`);
const out = runReconciliation({
  processingDate,
  cognosRecords,
  aspectSegments,
  aspectIdentities,
  cmsPunches,
  config,
});

// Row count = parsed Cognos records after the engine's own drop rules — derived from
// the files, not pinned to one specific week's number (launch-readiness.md Step 2).
if (out.rows.length === 0) {
  console.error(`FATAL: engine produced 0 rows from ${cognosRecords.length} parsed Cognos records. STOP.`);
  process.exit(1);
}
if (out.rows.length > cognosRecords.length) {
  console.error(
    `FATAL: engine produced MORE rows (${out.rows.length}) than parsed Cognos records ` +
    `(${cognosRecords.length}) — every row must trace back to a Cognos record. STOP.`
  );
  process.exit(1);
}

// --- Write output directory (create if missing — never a file path). -----

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify(out.rows, null, 2), 'utf-8');
fs.writeFileSync(path.join(outDir, 'aspect_corrections.csv'), out.aspectCorrectionsCsv, 'utf-8');

const summaryOut = {
  processingDateArg: args.date,
  processingDateResolved: processingDate.toISOString(),
  inputCounts: {
    cognosRecords: cognosRecords.length,
    aspectSegments: aspectSegments.length,
    aspectIdentities: aspectIdentities.length,
    cmsPunchesRawTotal: cmsPunchTotalAcrossFiles,
    cmsPunchesAfterDedupe: cmsPunches.length,
  },
  summary: out.summary,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summaryOut, null, 2), 'utf-8');

console.log('---');
console.log(`Wrote replay output to: ${outDir}`);
console.log(JSON.stringify(summaryOut, null, 2));
