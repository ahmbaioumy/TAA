// held-breakdown.ts — held-row diagnostic for the "Held for Review" reduction work
// (Phase 1, see plans/typed-percolating-torvalds.md), extended (launch-readiness.md
// Step 4) into the out-of-sample proof that the phase 1-5 gates never change pay.
// Reuses the exact real-data loading pipeline from scripts/replay-real.ts
// (localStorage stub, importConfigFromJson(Config.json), parseCognosReport w/
// configured drop patterns, parseAspectSegments/parseAspectIdentity,
// validateCmsFile+dedupeCmsPunches over every CMS_*.csv file found in samples_Files/,
// runReconciliation) — but WITHOUT replay-real.ts's hard row/punch-count assertions,
// since this tool exists specifically to inspect the current sample state (whatever
// samples_Files/ currently holds), not to gate the "byte-identical" replay proof.
//
// Usage (from TAA_HTML/):
//   npx tsx scripts/held-breakdown.ts --date=DD/MM/YYYY [--samples=<dir>]
//     [--save-baseline=<path>] [--compare=<path>] [--with-audit]
//     [--gates=on|off] [--window-hours=N]
//     [--compare-gates] [--released-out=<path>]
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
import { runReconciliation, ReconciliationInput, ReconciliationOutput } from '../src/services/reconciliationEngine';
import { runUnseenPunchAudit } from '../src/services/unseenPunchAudit';
import { runReconciliationWithAudit } from '../src/services/pipeline';
import { applyHoldPolicy, sanitizeHoldPolicy } from '../src/services/holdPolicy';
import { rebuildOutputs } from '../src/services/outputRebuild';
import { rowIsMustCheck } from '../src/services/reconciliationEngine';
import type { ConfigRegistry, ReconciliationRow } from '../src/types/taa';
import { resolveSamplesDir, listCmsFiles, findCognosFile } from './sampleFiles';

// --- Node has no `localStorage`. importConfigFromJson() calls saveConfigRegistry(),
// which writes through localStorage. Stub it as an in-memory no-op, same as
// replay-real.ts, so the import behaves exactly like the browser's config import
// without touching any real browser/user storage.
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

interface Args {
  date?: string;
  samples?: string;
  saveBaseline?: string;
  compare?: string;
  withAudit: boolean;
  gates?: 'on' | 'off';
  windowHours?: number;
  compareGates: boolean;
  releasedOut?: string;
  /** --policy=<path to JSON file>: either a bare array of Hold Policy cell ids, or
   * `{ "released": [...] }` — the same shape as ConfigRegistry.holdPolicy. Applied via
   * applyHoldPolicy AFTER --gates/--with-audit resolve, so it composes with both. */
  policy?: string;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { withAudit: false, compareGates: false };
  for (const arg of argv) {
    if (arg === '--with-audit') { result.withAudit = true; continue; }
    if (arg === '--compare-gates') { result.compareGates = true; continue; }
    const m = /^--(date|samples|save-baseline|compare|gates|window-hours|released-out|policy)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'date') result.date = val;
    else if (key === 'samples') result.samples = val;
    else if (key === 'save-baseline') result.saveBaseline = val;
    else if (key === 'compare') result.compare = val;
    else if (key === 'released-out') result.releasedOut = val;
    else if (key === 'policy') result.policy = val;
    else if (key === 'gates') {
      if (val !== 'on' && val !== 'off') {
        console.error(`FATAL: --gates must be "on" or "off", got "${val}".`);
        process.exit(1);
      }
      result.gates = val;
    } else if (key === 'window-hours') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`FATAL: --window-hours must be a positive number, got "${val}".`);
        process.exit(1);
      }
      result.windowHours = n;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (!args.date) {
  console.error(
    'FATAL: --date=DD/MM/YYYY is REQUIRED — this tool never defaults processingDate to the ' +
    'clock, same reasoning as replay-real.ts.\n' +
    'Usage: npx tsx scripts/held-breakdown.ts --date=DD/MM/YYYY [--samples=<dir>] ' +
    '[--save-baseline=<path>] [--compare=<path>] [--with-audit] [--gates=on|off] ' +
    '[--window-hours=N] [--compare-gates] [--released-out=<path>]'
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

// --- Paths — data-set independent (launch-readiness.md Step 2): every CMS_*.csv
// found in samples_Files/, and the Cognos report matched case-insensitively. ------

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
const baseConfig = importConfigFromJson(configJson);
if (args.windowHours !== undefined) {
  baseConfig.cmsPunchSearchWindowHours = args.windowHours;
  console.log(`Overriding cmsPunchSearchWindowHours -> ${args.windowHours}`);
}

// --- Decode + parse each real input file, exactly as UploadZone.tsx does. -

console.log(`Parsing Cognos: ${COGNOS_PATH}`);
const cognosRecords = parseCognosReport(decode(COGNOS_PATH), baseConfig.cognosDropPatterns);

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
// 709/502/38308 assertions with checks derived from the files themselves: nothing
// is silently dropped between "parsed" and "raw across files" totals. -------------

if (cognosRecords.length === 0) {
  console.error(`FATAL: parseCognosReport returned 0 rows from ${COGNOS_PATH} — nothing to reconcile.`);
  process.exit(1);
}
if (cmsPunchTotalAcrossFiles === 0) {
  console.error(`FATAL: 0 raw CMS punches parsed across ${CMS_FILES.length} file(s) — nothing to attribute.`);
  process.exit(1);
}
if (cmsPunches.length > cmsPunchTotalAcrossFiles) {
  console.error(
    `FATAL: dedupeCmsPunches produced MORE punches (${cmsPunches.length}) than the raw total ` +
    `(${cmsPunchTotalAcrossFiles}) — dedupe must only ever remove or keep punches, never add.`
  );
  process.exit(1);
}

// --- Run the real engine, once for --gates=on|off, twice for --compare-gates. ----

function runOnce(config: ConfigRegistry): ReconciliationOutput {
  const input: ReconciliationInput = {
    processingDate,
    cognosRecords,
    aspectSegments,
    aspectIdentities,
    cmsPunches,
    config,
  };
  // pipeline.ts's runReconciliationWithAudit (engine -> unseen-punch audit -> Hold Policy ->
  // initial review status) — same chain App.tsx uses. Hold Policy is a no-op here unless the
  // caller's config.holdPolicy.released is non-empty (--policy below), so --compare-gates'
  // OFF-vs-ON comparison is unaffected by this change.
  return runReconciliationWithAudit(input);
}

interface RowSnapshot {
  id: string;
  holdReason: string | null;
  TAA_VERDICT: string;
  TAA_ACTION: string;
  TAA_ACTIONS_FIRED: string;
  TAA_LATE_MIN: number;
  TAA_EARLY_MIN: number;
  /** The ASPECT corrections this row generated (details.generatedCorrections — see
   * ReconciliationRow.details in src/types/taa.ts), keyed by the fields that matter
   * for a payroll-facing diff. */
  corrections: Array<{ Code: string; SegmentCode: string; nominateDate: string }>;
}

function snapshot(row: ReconciliationRow): RowSnapshot {
  return {
    id: row.id,
    holdReason: row.holdReason ? String(row.holdReason) : null,
    TAA_VERDICT: row.TAA_VERDICT,
    TAA_ACTION: String(row.TAA_ACTION),
    TAA_ACTIONS_FIRED: row.TAA_ACTIONS_FIRED,
    TAA_LATE_MIN: row.TAA_LATE_MIN,
    TAA_EARLY_MIN: row.TAA_EARLY_MIN,
    corrections: (row.details.generatedCorrections || []).map(c => ({
      Code: c.Code,
      SegmentCode: c.SegmentCode,
      nominateDate: c.nominateDate,
    })),
  };
}

/** Which of the phase 1-5 gates released this row, inferred from the per-column
 * comparison notes and the dedicated details.noAttendanceGateReleased marker
 * (reconciliationEngine.ts) — no separate per-row provenance field exists for
 * every gate, so this reads the same text a reviewer would see in the trace
 * modal. A row can carry more than one gate. */
function classifyGates(row: ReconciliationRow): string[] {
  const gates = new Set<string>();
  for (const c of row.columnComparisons) {
    const note = c.note || '';
    if (c.status === 'MATCH' && /agrees with CMS staffed/.test(note)) gates.add('Phase 1: SIGNIN staffed-zero');
    if (c.status === 'NOT_COMPARABLE' && /^Both agree: not late/.test(note)) gates.add('Phase 1: LATE START/LEFT EARLY same-direction');
    if (c.status === 'NOT_COMPARABLE' && /exact match otherwise\.$/.test(note)) gates.add('Phase 3: SCH DURATION exact OT/release');
    if (/Cognos leave type is the day's full-day removal segment/.test(note)) gates.add('Phase 1: LEAVE TYPE REMOVAL_CODE');
    if (/^Action-neutral:/.test(note)) gates.add('Phase 4: worst-case action-neutral');
  }
  if (row.TAA_DISAGREE_REASON === 'DEFECT_1_RELEASE_IGNORED' && !row.holdReason) gates.add('Phase 2: defect1AutoExempt');
  if (row.details.noAttendanceGateReleased) gates.add('Phase 5: no-attendance all-agree');
  return [...gates];
}

if (args.compareGates) {
  console.log('---');
  console.log('--compare-gates: running OFF (releaseProvenSafeHolds=false) and ON (=true), both through the UI path (runReconciliation + runUnseenPunchAudit)...');
  const offConfig: ConfigRegistry = { ...baseConfig, releaseProvenSafeHolds: false };
  const onConfig: ConfigRegistry = { ...baseConfig, releaseProvenSafeHolds: true };
  const outOff = runOnce(offConfig);
  const outOn = runOnce(onConfig);

  if (outOff.rows.length !== outOn.rows.length) {
    console.error(`FATAL: row count differs OFF=${outOff.rows.length} ON=${outOn.rows.length} — the gate toggle must never add/remove rows.`);
    process.exit(1);
  }
  const total = outOff.rows.length;
  const offById = new Map(outOff.rows.map(r => [r.id, r]));
  const onById = new Map(outOn.rows.map(r => [r.id, r]));
  for (const id of offById.keys()) {
    if (!onById.has(id)) { console.error(`FATAL: row id ${id} present OFF, missing ON — rows do not pair 1:1.`); process.exit(1); }
  }

  const heldOff = outOff.rows.filter(r => !!r.holdReason);
  const heldOn = outOn.rows.filter(r => !!r.holdReason);
  const byReasonOn = new Map<string, number>();
  for (const r of heldOn) byReasonOn.set(String(r.holdReason), (byReasonOn.get(String(r.holdReason)) || 0) + 1);

  const payDiffs: string[] = [];
  const releasedByGate = new Map<string, { id: string; hasCorrections: boolean }[]>();
  const releasedWithCorrections: Array<{ id: string; pfNo: string; verdict: string; action: string; corrections: unknown[] }> = [];

  for (const [id, off] of offById) {
    const on = onById.get(id)!;
    const before = snapshot(off);
    const after = snapshot(on);
    if (
      before.TAA_VERDICT !== after.TAA_VERDICT ||
      before.TAA_ACTION !== after.TAA_ACTION ||
      before.TAA_ACTIONS_FIRED !== after.TAA_ACTIONS_FIRED ||
      before.TAA_LATE_MIN !== after.TAA_LATE_MIN ||
      before.TAA_EARLY_MIN !== after.TAA_EARLY_MIN ||
      JSON.stringify(before.corrections) !== JSON.stringify(after.corrections)
    ) {
      payDiffs.push(
        `${id}: verdict[${before.TAA_VERDICT}->${after.TAA_VERDICT}] action[${before.TAA_ACTION}->${after.TAA_ACTION}] ` +
        `actionsFired[${before.TAA_ACTIONS_FIRED}->${after.TAA_ACTIONS_FIRED}] late[${before.TAA_LATE_MIN}->${after.TAA_LATE_MIN}] ` +
        `early[${before.TAA_EARLY_MIN}->${after.TAA_EARLY_MIN}] corrections[${JSON.stringify(before.corrections)}->${JSON.stringify(after.corrections)}]`
      );
    }
    // Released = held OFF, not held ON.
    if (off.holdReason && !on.holdReason) {
      const gates = classifyGates(on);
      const label = gates.length > 0 ? gates.join(' + ') : '(gate not identified from notes)';
      if (!releasedByGate.has(label)) releasedByGate.set(label, []);
      const hasCorrections = (on.details.generatedCorrections || []).length > 0;
      releasedByGate.get(label)!.push({ id, hasCorrections });
      if (hasCorrections) {
        releasedWithCorrections.push({
          id,
          pfNo: on.originalCognos['PF NO'],
          verdict: on.TAA_VERDICT,
          action: String(on.TAA_ACTION),
          corrections: on.details.generatedCorrections,
        });
      }
    }
  }

  console.log('---');
  console.log(`=== --compare-gates report (date=${args.date}, windowHours=${args.windowHours ?? baseConfig.cmsPunchSearchWindowHours}) ===`);
  console.log(`Total rows: ${total}`);
  console.log(`Held OFF: ${heldOff.length} (${(100 * heldOff.length / total).toFixed(1)}%)`);
  console.log(`Held ON:  ${heldOn.length} (${(100 * heldOn.length / total).toFixed(1)}%)`);
  console.log('Held ON by reason:');
  for (const [reason, count] of [...byReasonOn.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  const releasedTotal = [...releasedByGate.values()].reduce((a, v) => a + v.length, 0);
  console.log(`Released rows (held OFF, not held ON): ${releasedTotal}`);
  console.log('Released rows by gate:');
  for (const [gate, rows] of [...releasedByGate.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${gate}: ${rows.length}`);
  }
  console.log('---');
  console.log(`Verdict/action/actionsFired/late/early/correction diffs OFF vs ON: ${payDiffs.length} (MUST be 0)`);
  if (payDiffs.length > 0) {
    console.log('STOP — pay-affecting diffs found. Full list:');
    for (const line of payDiffs) console.log(`  DIFF: ${line}`);
  }
  console.log('---');
  console.log(`Released rows carrying ASPECT corrections: ${releasedWithCorrections.length}`);
  const releasedOutPath = path.resolve(args.releasedOut || path.join(SAMPLES_DIR, '..', 'released_with_corrections.json'));
  fs.mkdirSync(path.dirname(releasedOutPath), { recursive: true });
  fs.writeFileSync(releasedOutPath, JSON.stringify({
    date: args.date,
    windowHours: args.windowHours ?? baseConfig.cmsPunchSearchWindowHours,
    count: releasedWithCorrections.length,
    rows: releasedWithCorrections,
  }, null, 2), 'utf-8');
  console.log(`Wrote released-with-corrections list to: ${releasedOutPath}`);

  if (payDiffs.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

// --- Single run (default: --gates=on unless --gates=off). ------------------------

const runConfig: ConfigRegistry = { ...baseConfig, releaseProvenSafeHolds: args.gates !== 'off' };
console.log(`Running reconciliation with processingDate=${processingDate.toDateString()}, releaseProvenSafeHolds=${runConfig.releaseProvenSafeHolds}...`);
const reconciliationInput: ReconciliationInput = {
  processingDate,
  cognosRecords,
  aspectSegments,
  aspectIdentities,
  cmsPunches,
  config: runConfig,
};
const engineOut = runReconciliation(reconciliationInput);

// --with-audit: chains runUnseenPunchAudit after runReconciliation, exactly the App.tsx
// runReconciliationWithAudit UI path (App.tsx ~63-67) — never applied by default, so every
// other invocation of this script (baselines, --compare) stays byte-identical to before this
// flag existed.
const auditedOut = args.withAudit ? runUnseenPunchAudit(reconciliationInput, engineOut) : null;
if (auditedOut) {
  const withoutHeld = engineOut.rows.filter(r => !!r.holdReason).length;
  const withHeld = auditedOut.rows.filter(r => !!r.holdReason).length;
  console.log('---');
  console.log(`Held WITHOUT audit (engine only): ${withoutHeld} / ${engineOut.rows.length}`);
  console.log(`Held WITH audit (App.tsx's own runReconciliationWithAudit path): ${withHeld} / ${auditedOut.rows.length}`);
  const reHeld: string[] = [];
  for (let i = 0; i < engineOut.rows.length; i++) {
    const before = engineOut.rows[i];
    const after = auditedOut.rows[i];
    if (!before.holdReason && after.holdReason) {
      reHeld.push(`  ${after.id}: released by the engine -> re-held ${after.holdReason} by the audit (${after.unseenPunchNote || ''})`);
    }
  }
  console.log(`Rows released by the engine that the audit re-holds: ${reHeld.length}`);
  for (const line of reHeld) console.log(line);
}

let out = auditedOut || engineOut;

// --policy=<path>: apply a candidate Hold Policy to the resolved output (composes with
// --gates/--with-audit above). Same applyHoldPolicy/rebuildOutputs/rowIsMustCheck wiring as
// pipeline.ts's runReconciliationWithAudit — see src/services/holdPolicy.ts.
if (args.policy) {
  const policyPath = path.resolve(args.policy);
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
  const releasedIds: unknown[] = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.released) ? raw.released : []);
  const holdPolicy = sanitizeHoldPolicy({ released: releasedIds });
  const policyConfig: ConfigRegistry = { ...runConfig, holdPolicy };
  out = applyHoldPolicy(out, policyConfig, { rebuildOutputs, rowIsMustCheck });
  console.log('---');
  console.log(`--policy: loaded ${releasedIds.length} id(s) from ${policyPath}, ${holdPolicy.released.length} valid/unlocked after sanitizeHoldPolicy.`);
}

const rows: ReconciliationRow[] = out.rows;

// --- Breakdown ------------------------------------------------------------

const total = rows.length;
const heldRows = rows.filter(r => !!r.holdReason);
const heldCount = heldRows.length;
const heldPct = total > 0 ? (100 * heldCount / total) : 0;

const byReason = new Map<string, number>();
for (const r of heldRows) {
  const key = String(r.holdReason);
  byReason.set(key, (byReason.get(key) || 0) + 1);
}

const mismatchFoundRows = heldRows.filter(r => r.holdReason === 'MISMATCH_FOUND');
const byMismatchColumn = new Map<string, number>();
for (const r of mismatchFoundRows) {
  const cols = (r.TAA_MISMATCH_COLUMNS || '').split(';').map(c => c.trim()).filter(Boolean);
  for (const c of cols) {
    byMismatchColumn.set(c, (byMismatchColumn.get(c) || 0) + 1);
  }
}

console.log('---');
console.log(`Total rows: ${total}`);
console.log(`Held: ${heldCount} (${heldPct.toFixed(1)}%)`);
console.log('Held by holdReason:');
for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason}: ${count}`);
}
console.log(`MISMATCH_FOUND rows: ${mismatchFoundRows.length}`);
console.log('MISMATCH_FOUND by TAA_MISMATCH_COLUMNS:');
for (const [col, count] of [...byMismatchColumn.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${col}: ${count}`);
}

// --- Per-row snapshot for --save-baseline / --compare ---------------------

if (args.saveBaseline) {
  const baseline = {
    processingDateArg: args.date,
    rows: rows.map(snapshot),
    aspectCorrectionsCsv: out.aspectCorrectionsCsv,
  };
  const outPath = path.resolve(args.saveBaseline);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log('---');
  console.log(`Wrote baseline snapshot (${rows.length} rows) to: ${outPath}`);
}

if (args.compare) {
  const comparePath = path.resolve(args.compare);
  const baselineRaw = fs.readFileSync(comparePath, 'utf-8');
  const baseline: { rows: RowSnapshot[]; aspectCorrectionsCsv: string } = JSON.parse(baselineRaw);
  const baselineById = new Map(baseline.rows.map(r => [r.id, r]));

  const nonHoldDiffs: string[] = [];
  const holdChanges: string[] = [];

  for (const row of rows) {
    const before = baselineById.get(row.id);
    const after = snapshot(row);
    if (!before) {
      nonHoldDiffs.push(`${row.id}: NEW ROW (not in baseline)`);
      continue;
    }
    if (
      before.TAA_VERDICT !== after.TAA_VERDICT ||
      before.TAA_ACTION !== after.TAA_ACTION ||
      before.TAA_ACTIONS_FIRED !== after.TAA_ACTIONS_FIRED ||
      before.TAA_LATE_MIN !== after.TAA_LATE_MIN ||
      before.TAA_EARLY_MIN !== after.TAA_EARLY_MIN ||
      JSON.stringify(before.corrections) !== JSON.stringify(after.corrections)
    ) {
      nonHoldDiffs.push(
        `${row.id}: verdict[${before.TAA_VERDICT}->${after.TAA_VERDICT}] action[${before.TAA_ACTION}->${after.TAA_ACTION}] ` +
        `actionsFired[${before.TAA_ACTIONS_FIRED}->${after.TAA_ACTIONS_FIRED}] late[${before.TAA_LATE_MIN}->${after.TAA_LATE_MIN}] ` +
        `early[${before.TAA_EARLY_MIN}->${after.TAA_EARLY_MIN}] corrections[${JSON.stringify(before.corrections)}->${JSON.stringify(after.corrections)}]`
      );
    }
    if (before.holdReason !== after.holdReason) {
      holdChanges.push(`${row.id}: hold ${before.holdReason ?? '(none)'} -> ${after.holdReason ?? '(none)'}`);
    }
  }
  for (const beforeId of baselineById.keys()) {
    if (!rows.some(r => r.id === beforeId)) {
      nonHoldDiffs.push(`${beforeId}: ROW REMOVED (was in baseline, missing now)`);
    }
  }

  console.log('---');
  console.log(`Compared against baseline: ${comparePath}`);
  console.log(`Verdict/action/actionsFired/late/early/corrections diffs: ${nonHoldDiffs.length} (must be 0)`);
  for (const line of nonHoldDiffs) console.log(`  DIFF: ${line}`);
  console.log(`Hold-status changes: ${holdChanges.length}`);
  for (const line of holdChanges) console.log(`  ${line}`);
}
