/** Investigation only: classifies every SCH DURATION mismatch against Cognos by cause, so the
 * per-cause counts are reproducible rather than asserted.
 * Run from TAA_HTML: node node_modules/tsx/dist/cli.mjs scripts/analyze-sch-duration.ts --date=DD/MM/YYYY
 * Reads ../samples_Files (read-only); does not change app code, inputs, configuration or payroll data.
 *
 * File list and load order mirror scripts/replay-real.ts (WP8 track A3): real
 * Config.json drives the Cognos drop rules, and all five real CMS files are
 * read. processingDate is a required CLI argument, never the clock — a
 * defaulted clock is how a replay/analysis silently stops being reproducible.
 */
import { readFileSync } from 'node:fs';
import { importConfigFromJson } from '../src/services/configRegistry';
import { runReconciliation } from '../src/services/reconciliationEngine';
import { parseAspectSegments, parseAspectIdentity, parseCognosReport, parseCmsPunches, decodeFileBuffer, parseCognosHMinutes } from '../src/services/parsers';
import { resolveSamplesDir, listCmsFiles, findCognosFile } from './sampleFiles';

if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

function parseArgs(argv: string[]): { date?: string } {
  const result: { date?: string } = {};
  for (const arg of argv) {
    const m = /^--date=(.*)$/.exec(arg);
    if (m) result.date = m[1];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.date) {
  console.error(
    'FATAL: --date=DD/MM/YYYY is REQUIRED. This analysis never defaults processingDate ' +
    'to the clock — an undated run is not reproducible.\n' +
    'Usage: npx tsx scripts/analyze-sch-duration.ts --date=DD/MM/YYYY'
  );
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

const decode = (p: string) => { const b = readFileSync(p); return decodeFileBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
// Data-set independent (launch-readiness.md Step 2): every CMS_*.csv found in
// samples_Files/ (or --samples=<dir>), Cognos report matched case-insensitively.
const SAMPLES_DIR = resolveSamplesDir(process.argv.slice(2));
const COGNOS_PATH = findCognosFile(SAMPLES_DIR);
const CMS_FILES = listCmsFiles(SAMPLES_DIR);
if (CMS_FILES.length === 0) {
  console.error(`FATAL: no CMS_*.csv files found in ${SAMPLES_DIR}.`);
  process.exit(1);
}

const config = importConfigFromJson(readFileSync(`${SAMPLES_DIR}/Config.json`, 'utf-8'));

const out = runReconciliation({ processingDate,
  cognosRecords: parseCognosReport(decode(COGNOS_PATH), config.cognosDropPatterns),
  aspectSegments: parseAspectSegments(decode(`${SAMPLES_DIR}/MTD_Seg.csv`)),
  aspectIdentities: parseAspectIdentity(decode(`${SAMPLES_DIR}/employeeinfo.csv`)),
  cmsPunches: CMS_FILES.flatMap(f => parseCmsPunches(decode(f))),
  config,
});

const causes: Record<string, string[]> = {};
const add = (k: string, row: string) => (causes[k] ||= []).push(row);
let comparable = 0, matches = 0;
const holds: Record<string, number> = {};
for (const r of out.rows as any[]) {
  holds[r.holdReason || '(none)'] = (holds[r.holdReason || '(none)'] || 0) + 1;
  const sch = r.columnComparisons?.find((c: any) => c.column === 'SCH DURATION');
  if (!sch || sch.status === 'NOT_COMPARABLE' || sch.status === 'COGNOS_BLANK') continue;
  comparable++;
  if (sch.status === 'MATCH') { matches++; continue; }
  const cog = parseCognosHMinutes(sch.cognosRaw);
  const segs = r.details.aspectSegments || [];
  const codes = new Set<string>(segs.map((s: any) => s.SEG_CODE));
  const gap = cog === null ? null : cog - r.TAA_SCH_HOURS_RECOMPUTED; // + => Cognos higher
  const label = `${r.id} cognos ${sch.cognosRaw} vs TAA ${sch.recomputedRaw} (gap ${gap}m)`;
  const shifts = segs.filter((s: any) => s.SEG_CODE === 'SHIFT').length;
  const note: string = sch.note || '';
  let cause: string;
  if (codes.has('OT1') || codes.has('OT2')) cause = '1. Cognos omits OT (by decision)';
  else if (/did not deduct/.test(note)) cause = '2. Cognos did not deduct a release';
  else if (/LATE make-up|COVER that Cognos/.test(note)) cause = '3. COVER / LATE make-up skew between extracts';
  else if (/likely did not deduct all/.test(note)) cause = '2. Cognos did not deduct a release';
  else if (shifts > 1) cause = '4. multi-shift leftover';
  else cause = '5. unexplained residual';
  add(cause, label + ` codes=${[...codes].filter(c => !/^(BREAK|PRY|BRFNG)/.test(c)).join(',')}`);
}
console.log(`SCH DURATION comparable rows: ${comparable}, MATCH: ${matches}, MISMATCH: ${comparable - matches}`);
for (const k of Object.keys(causes).sort()) console.log(`  ${k}: ${causes[k].length}`);
console.log('\nResidual rows (cause 5):');
(causes['5. unexplained residual'] || []).forEach(l => console.log('  ' + l));
console.log('\nHold reasons:', JSON.stringify(holds));
