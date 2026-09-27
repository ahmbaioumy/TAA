// Reduced Office Hours — before/after impact audit on real data.
//
// Runs the real sample dataset (../samples_Files/) twice — once with the reduced-office-
// hours feature OFF, once ON — and reports exactly what changed: which rows lost an
// early-logout/absence action, whether any cover moved off the configured weekday, and
// whether anything outside that scope moved at all. Six guards (G1-G6) fail loudly and
// exit 1 if the feature's effect ever exceeds its documented scope.
//
// Usage (from TAA_HTML/):
//   npx tsx scripts/audit-reduced-office-hours.ts [--date=DD/MM/YYYY] [--day=0-6]
//     [--minutes=N] [--out=<output-dir>]

import * as fs from 'fs';
import * as path from 'path';
import {
  decodeFileBuffer,
  parseCognosReport,
  parseAspectSegments,
  parseAspectIdentity,
  validateCmsFile,
  dedupeCmsPunches,
  parseDateTimeString,
} from '../src/services/parsers';
import { importConfigFromJson } from '../src/services/configRegistry';
import { runReconciliation, isFlexScheduleWithinExpectedWindow } from '../src/services/reconciliationEngine';
import { ConfigRegistry, ReconciliationRow, AspectCorrectionRow } from '../src/types/taa';
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

function parseArgs(argv: string[]): { date?: string; day?: string; minutes?: string; out?: string } {
  const result: { date?: string; day?: string; minutes?: string; out?: string } = {};
  for (const arg of argv) {
    const m = /^--(date|day|minutes|out)=(.*)$/.exec(arg);
    if (m) result[m[1] as 'date' | 'day' | 'minutes' | 'out'] = m[2];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const DATE_ARG = args.date || '23/09/2026'; // fixed default — never the clock, for reproducibility
const DAY_OF_WEEK = args.day !== undefined ? Number(args.day) : 5; // Friday
const REQUIRED_MINUTES = args.minutes !== undefined ? Number(args.minutes) : 240;
const OUT_DIR = args.out ? path.resolve(args.out) : undefined;

function parseCliDate(s: string): Date {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (!m) { console.error(`FATAL: --date="${s}" is not DD/MM/YYYY.`); process.exit(1); }
  const [, dd, mm, yyyy] = m as unknown as [string, string, string, string];
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (Number.isNaN(d.getTime())) { console.error(`FATAL: --date="${s}" did not parse.`); process.exit(1); }
  return d;
}
const processingDate = parseCliDate(DATE_ARG);

// --- Load real data, data-set independent (launch-readiness.md Step 2): every
// CMS_*.csv found in samples_Files/ (or --samples=<dir>), Cognos report matched
// case-insensitively — not reused as a module from replay-real.ts, this is its own
// copy of the loader, per the implementation brief. ----------------------------------

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

console.log(`Loading real config: ${CONFIG_PATH}`);
const configJson = fs.readFileSync(CONFIG_PATH, 'utf-8');
const baseConfig = importConfigFromJson(configJson);

const cognosRecords = parseCognosReport(decode(COGNOS_PATH), baseConfig.cognosDropPatterns);
const aspectSegments = parseAspectSegments(decode(ASPECT_SEGMENTS_PATH));
const aspectIdentities = parseAspectIdentity(decode(ASPECT_IDENTITY_PATH));

let cmsPunchesRaw: ReturnType<typeof dedupeCmsPunches> = [];
let cmsPunchTotalAcrossFiles = 0;
for (const cmsPath of CMS_FILES) {
  const text = decode(cmsPath);
  const result = validateCmsFile(text, path.basename(cmsPath));
  if ('reason' in result) { console.error(`FATAL: CMS file "${cmsPath}" failed validation: ${result.reason}`); process.exit(1); }
  cmsPunchTotalAcrossFiles += result.punches.length;
  cmsPunchesRaw = cmsPunchesRaw.concat(result.punches);
}
const cmsPunches = dedupeCmsPunches(cmsPunchesRaw);

// Data-derived checks (launch-readiness.md Step 2), not a count pinned to one week's files.
if (cmsPunchTotalAcrossFiles === 0) {
  console.error(`FATAL: 0 raw CMS punches parsed across ${CMS_FILES.length} file(s) — nothing to attribute. STOP.`);
  process.exit(1);
}
if (cmsPunches.length > cmsPunchTotalAcrossFiles) {
  console.error(`FATAL: dedupeCmsPunches produced MORE punches (${cmsPunches.length}) than the raw total (${cmsPunchTotalAcrossFiles}). STOP.`);
  process.exit(1);
}

// --- Run twice: OFF and ON. -----------------------------------------------

const offConfig: ConfigRegistry = { ...baseConfig, reducedOfficeHoursEnabled: false };
const onConfig: ConfigRegistry = {
  ...baseConfig,
  reducedOfficeHoursEnabled: true,
  reducedOfficeHoursDayOfWeek: DAY_OF_WEEK,
  reducedOfficeHoursRequiredMinutes: REQUIRED_MINUTES,
};

console.log(`Running OFF (baseline) and ON (day=${DAY_OF_WEEK}, minutes=${REQUIRED_MINUTES})...`);
const outOff = runReconciliation({ processingDate, cognosRecords, aspectSegments, aspectIdentities, cmsPunches, config: offConfig });
const outOn = runReconciliation({ processingDate, cognosRecords, aspectSegments, aspectIdentities, cmsPunches, config: onConfig });

// Data-derived check: OFF and ON must produce the same row count as each other and as
// the parsed Cognos records (never pinned to one week's fixed number, Step 2).
if (outOff.rows.length !== outOn.rows.length) {
  console.error(`FATAL: row count differs OFF=${outOff.rows.length} ON=${outOn.rows.length}. STOP.`);
  process.exit(1);
}
if (outOff.rows.length === 0 || outOff.rows.length > cognosRecords.length) {
  console.error(`FATAL: unexpected row count ${outOff.rows.length} (parsed Cognos records: ${cognosRecords.length}). STOP.`);
  process.exit(1);
}

// --- Pair rows by id. -------------------------------------------------------

const offById = new Map(outOff.rows.map(r => [r.id, r]));
const onById = new Map(outOn.rows.map(r => [r.id, r]));
if (offById.size !== onById.size) { console.error('FATAL: row id sets differ in size between OFF and ON.'); process.exit(1); }
for (const id of offById.keys()) {
  if (!onById.has(id)) { console.error(`FATAL: row id ${id} present OFF, missing ON — rows do not pair 1:1.`); process.exit(1); }
}

// --- Action classification. -------------------------------------------------

type Category = 'LATE' | 'EARLY_LOGOUT' | 'ABSENT_EARLY_LOGOUT' | 'ABSENT_LATE_LOGOUT' | 'ABSENT_OTHER' | 'COVER' | 'UNMAPPED';

function classify(c: AspectCorrectionRow): Category {
  if (c.SegmentCode === 'LATE') return 'LATE';
  if (c.SegmentCode === 'Log_off') return 'EARLY_LOGOUT';
  if (c.SegmentCode === 'COVER') return 'COVER';
  if (c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC') {
    if (c.Memo.startsWith('TAA Early Logout')) return 'ABSENT_EARLY_LOGOUT';
    if (c.Memo.startsWith('TAA Late Logout')) return 'ABSENT_LATE_LOGOUT';
    return 'ABSENT_OTHER';
  }
  return 'UNMAPPED';
}

function countByCategory(corrections: AspectCorrectionRow[]): Record<Category, number> {
  const counts: Record<Category, number> = { LATE: 0, EARLY_LOGOUT: 0, ABSENT_EARLY_LOGOUT: 0, ABSENT_LATE_LOGOUT: 0, ABSENT_OTHER: 0, COVER: 0, UNMAPPED: 0 };
  for (const c of corrections) counts[classify(c)]++;
  return counts;
}

// --- Eligibility per row (OFF row used for schedule facts — feature-independent). -------

function weekdayOf(row: ReconciliationRow): number | null {
  const raw = row.originalCognos['SIGN IN DATE'];
  const d = raw ? parseDateTimeString(raw) : null;
  return d ? d.getDay() : null;
}

function inWindow(row: ReconciliationRow): boolean | null {
  const rawStart = row.details.rawShiftStart; // "HH:MM" or undefined
  if (!rawStart) return null;
  const [h, m] = rawStart.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return isFlexScheduleWithinExpectedWindow(new Date(2000, 0, 1, h, m, 0), onConfig);
}

// --- Eligibility counts. -----------------------------------------------------

let onConfiguredWeekday = 0, onConfiguredWeekdayFlex = 0, onConfiguredWeekdayFlexInWindow = 0;
for (const row of outOff.rows) {
  if (weekdayOf(row) === DAY_OF_WEEK) {
    onConfiguredWeekday++;
    if (row.details.isFlex) {
      onConfiguredWeekdayFlex++;
      if (inWindow(row) === true) onConfiguredWeekdayFlexInWindow++;
    }
  }
}

// --- Per-row diff + guards. --------------------------------------------------

const unmappedMemos = new Set<string>();
const changedRows: { id: string; off: ReconciliationRow; on: ReconciliationRow }[] = [];
const guardFailures: { guard: string; id: string; detail: string }[] = [];
const verdictTransitions = new Map<string, number>();

const offTotals: Record<Category, number> = { LATE: 0, EARLY_LOGOUT: 0, ABSENT_EARLY_LOGOUT: 0, ABSENT_LATE_LOGOUT: 0, ABSENT_OTHER: 0, COVER: 0, UNMAPPED: 0 };
const onTotals: Record<Category, number> = { LATE: 0, EARLY_LOGOUT: 0, ABSENT_EARLY_LOGOUT: 0, ABSENT_LATE_LOGOUT: 0, ABSENT_OTHER: 0, COVER: 0, UNMAPPED: 0 };
let earlyMinSumOff = 0, earlyMinSumOn = 0;
let holdCountOff = 0, holdCountOn = 0;
let includeCountOff = 0, includeCountOn = 0;
let flaggedCount = 0;
let coverOnConfiguredWeekdayFlexOn = 0;
let coverOnDayFlexOff = 0;
const coverOnDayFlexOffRows: {
  id: string; pfNo: string; name: string; rowDate: string;
  offCover: { date: string; duration: string };
  onCovers: { date: string; duration: string }[];
}[] = [];
let coverDisappearedCount = 0;
let coverMovedCount = 0;

for (const [id, off] of offById) {
  const on = onById.get(id)!;

  for (const c of off.details.generatedCorrections) if (classify(c) === 'UNMAPPED') unmappedMemos.add(`${c.SegmentCode} | ${c.Memo}`);
  for (const c of on.details.generatedCorrections) if (classify(c) === 'UNMAPPED') unmappedMemos.add(`${c.SegmentCode} | ${c.Memo}`);

  const offCounts = countByCategory(off.details.generatedCorrections);
  const onCounts = countByCategory(on.details.generatedCorrections);
  (Object.keys(offTotals) as Category[]).forEach(k => { offTotals[k] += offCounts[k]; onTotals[k] += onCounts[k]; });

  earlyMinSumOff += off.TAA_EARLY_MIN; earlyMinSumOn += on.TAA_EARLY_MIN;
  if (off.holdReason) holdCountOff++; if (on.holdReason) holdCountOn++;
  if (off.includeInOutput) includeCountOff++; if (on.includeInOutput) includeCountOn++;
  if (on.TAA_DISAGREE_REASON === 'REDUCED_OFFICE_HOURS_POLICY') flaggedCount++;

  const wd = weekdayOf(off);
  const rowIsFlex = off.details.isFlex;

  // G4: no COVER on the configured weekday for a Flex row, in the ON run.
  const onCoverOnConfiguredWeekday = on.details.generatedCorrections.some(c => c.SegmentCode === 'COVER' && parseDateTimeString(c.nominateDate)?.getDay() === DAY_OF_WEEK);
  if (rowIsFlex && onCoverOnConfiguredWeekday) {
    coverOnConfiguredWeekdayFlexOn++;
    guardFailures.push({ guard: 'G4', id, detail: `Flex row has a COVER dated on the configured weekday (day=${DAY_OF_WEEK}) in the ON run` });
  }

  // Cover moves — same weekday test as G4/the ON count above, applied to the OFF run.
  if (rowIsFlex) {
    const offCoversOnDay = off.details.generatedCorrections.filter(c => c.SegmentCode === 'COVER' && parseDateTimeString(c.nominateDate)?.getDay() === DAY_OF_WEEK);
    if (offCoversOnDay.length > 0) {
      coverOnDayFlexOff += offCoversOnDay.length;
      const onCovers = on.details.generatedCorrections.filter(c => c.SegmentCode === 'COVER');
      for (const offCover of offCoversOnDay) {
        coverOnDayFlexOffRows.push({
          id, pfNo: off.originalCognos['PF NO'], name: off.originalCognos.NAME, rowDate: off.originalCognos['SIGN IN DATE'],
          offCover: { date: offCover.nominateDate, duration: offCover.Segmentduration },
          onCovers: onCovers.map(c => ({ date: c.nominateDate, duration: c.Segmentduration })),
        });
      }
      if (onCovers.length === 0) {
        coverDisappearedCount++;
      } else {
        coverMovedCount++;
      }
    }
  }

  // G6: every flagged row must be Flex + on the configured weekday.
  if (on.TAA_DISAGREE_REASON === 'REDUCED_OFFICE_HOURS_POLICY' && !(rowIsFlex && wd === DAY_OF_WEEK)) {
    guardFailures.push({ guard: 'G6', id, detail: `Flagged row is not Flex+configured-weekday (isFlex=${rowIsFlex}, weekday=${wd})` });
  }

  const correctionsKey = (r: ReconciliationRow) => r.details.generatedCorrections.map(c => `${c.SegmentCode}|${c.nominateDate}|${c.Segmentduration}`).sort().join(';');
  const changed = off.TAA_VERDICT !== on.TAA_VERDICT || off.TAA_ACTION !== on.TAA_ACTION || off.TAA_ACTIONS_FIRED !== on.TAA_ACTIONS_FIRED
    || off.TAA_EARLY_MIN !== on.TAA_EARLY_MIN || off.TAA_LATE_MIN !== on.TAA_LATE_MIN || off.holdReason !== on.holdReason
    || off.includeInOutput !== on.includeInOutput || off.TAA_DISAGREE_REASON !== on.TAA_DISAGREE_REASON
    || correctionsKey(off) !== correctionsKey(on);

  if (!changed) continue;
  changedRows.push({ id, off, on });

  const transitionKey = `${off.TAA_VERDICT} -> ${on.TAA_VERDICT}`;
  verdictTransitions.set(transitionKey, (verdictTransitions.get(transitionKey) || 0) + 1);

  // G1: a changed row must be Flex. Non-cover changes additionally require the configured weekday.
  if (!rowIsFlex) {
    guardFailures.push({ guard: 'G1', id, detail: 'Non-Flex row changed between OFF and ON' });
  } else if (wd !== DAY_OF_WEEK) {
    const nonCoverFieldsChanged = off.TAA_VERDICT !== on.TAA_VERDICT || off.TAA_ACTION !== on.TAA_ACTION || off.TAA_EARLY_MIN !== on.TAA_EARLY_MIN || off.TAA_LATE_MIN !== on.TAA_LATE_MIN;
    if (nonCoverFieldsChanged) {
      guardFailures.push({ guard: 'G1', id, detail: `Flex row changed on a non-configured weekday (weekday=${wd})` });
    }
  }

  // G2: relax-only — ON early-logout counts and TAA_EARLY_MIN must not exceed OFF.
  if (onCounts.EARLY_LOGOUT + onCounts.ABSENT_EARLY_LOGOUT > offCounts.EARLY_LOGOUT + offCounts.ABSENT_EARLY_LOGOUT) {
    guardFailures.push({ guard: 'G2', id, detail: 'ON has MORE early-logout actions than OFF' });
  }
  if (on.TAA_EARLY_MIN > off.TAA_EARLY_MIN) {
    guardFailures.push({ guard: 'G2', id, detail: `ON TAA_EARLY_MIN (${on.TAA_EARLY_MIN}) exceeds OFF (${off.TAA_EARLY_MIN})` });
  }

  // G3: LATE / ABSENT_LATE_LOGOUT / TAA_LATE_MIN must be untouched.
  if (onCounts.LATE !== offCounts.LATE || onCounts.ABSENT_LATE_LOGOUT !== offCounts.ABSENT_LATE_LOGOUT || on.TAA_LATE_MIN !== off.TAA_LATE_MIN) {
    guardFailures.push({ guard: 'G3', id, detail: 'Late-side counts or TAA_LATE_MIN differ between OFF and ON' });
  }

  // G5: no new holds.
  if (!off.holdReason && on.holdReason) {
    guardFailures.push({ guard: 'G5', id, detail: `New hold introduced ON: ${on.holdReason}` });
  }
}

// --- Console report. ---------------------------------------------------------

console.log('\n=== Eligibility ===');
console.log(`Rows on configured weekday (day=${DAY_OF_WEEK}): ${onConfiguredWeekday}`);
console.log(`  of those, Flex: ${onConfiguredWeekdayFlex}`);
console.log(`  of those, in-window (Flex start inside ${JSON.stringify(baseConfig.flexExpectedSchedStartWindow)}): ${onConfiguredWeekdayFlexInWindow}`);

console.log(`\n=== Action impact (OFF vs ON, all ${outOff.rows.length} rows) ===`);
console.log('category'.padEnd(22) + 'OFF'.padStart(6) + 'ON'.padStart(6) + 'delta'.padStart(8));
(Object.keys(offTotals) as Category[]).forEach(k => {
  console.log(k.padEnd(22) + String(offTotals[k]).padStart(6) + String(onTotals[k]).padStart(6) + String(onTotals[k] - offTotals[k]).padStart(8));
});
console.log(`\nTAA_EARLY_MIN sum: OFF=${earlyMinSumOff} ON=${earlyMinSumOn} (delta ${earlyMinSumOn - earlyMinSumOff})`);
console.log(`Rows with holdReason: OFF=${holdCountOff} ON=${holdCountOn}`);
console.log(`Rows with includeInOutput=true: OFF=${includeCountOff} ON=${includeCountOn}`);
console.log(`Rows flagged REDUCED_OFFICE_HOURS_POLICY: ${flaggedCount}`);

console.log('\n=== Verdict transitions (changed rows only) ===');
for (const [k, v] of [...verdictTransitions.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k} : ${v}`);
if (verdictTransitions.size === 0) console.log('  (none)');

console.log(`\n=== Cover moves ===`);
console.log(`Flex COVER on configured weekday: OFF=${coverOnDayFlexOff}, ON=${coverOnConfiguredWeekdayFlexOn} (must be 0)`);
for (const row of coverOnDayFlexOffRows) {
  const onList = row.onCovers.length > 0 ? row.onCovers.map(c => `${c.date} ${c.duration}m`).join(', ') : 'none';
  console.log(`  ${row.pfNo} ${row.name} ${row.rowDate}: OFF cover ${row.offCover.date} ${row.offCover.duration}m -> ON ${onList}`);
}
console.log(`\nCOVER count change reason split (of the ${coverOnDayFlexOff} Flex COVER(s) dated on the configured weekday, OFF):`);
console.log(`  disappeared (early-logout action removed): ${coverDisappearedCount}`);
console.log(`  moved to another date: ${coverMovedCount}`);

if (unmappedMemos.size > 0) {
  console.log(`\n=== Unmapped memos (${unmappedMemos.size}) ===`);
  for (const m of unmappedMemos) console.log(`  ${m}`);
}

console.log(`\n=== Guards ===`);
const guardIds = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
for (const g of guardIds) {
  const failures = guardFailures.filter(f => f.guard === g);
  console.log(`${g}: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
}

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csvLines = ['pf_no,name,date,weekday,is_flex,in_window,cms_in,cms_out,verdict_off,verdict_on,action_off,action_on,early_min_off,early_min_on,corrections_off,corrections_on,disagree_reason_on'];
  for (const { id, off, on } of changedRows) {
    const wd = weekdayOf(off);
    csvLines.push([
      off.originalCognos['PF NO'], off.originalCognos.NAME, off.originalCognos['SIGN IN DATE'], wd ?? '',
      off.details.isFlex, inWindow(off) ?? '', off.TAA_CMS_IN, off.TAA_CMS_OUT,
      off.TAA_VERDICT, on.TAA_VERDICT, off.TAA_ACTION, on.TAA_ACTION, off.TAA_EARLY_MIN, on.TAA_EARLY_MIN,
      off.details.generatedCorrections.map(c => c.SegmentCode).join('/'), on.details.generatedCorrections.map(c => c.SegmentCode).join('/'),
      on.TAA_DISAGREE_REASON,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'impact_rows.csv'), csvLines.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'impact_summary.json'), JSON.stringify({
    dayOfWeek: DAY_OF_WEEK, requiredMinutes: REQUIRED_MINUTES,
    eligibility: { onConfiguredWeekday, onConfiguredWeekdayFlex, onConfiguredWeekdayFlexInWindow },
    actionImpact: { off: offTotals, on: onTotals },
    earlyMinSum: { off: earlyMinSumOff, on: earlyMinSumOn },
    holdCount: { off: holdCountOff, on: holdCountOn },
    includeCount: { off: includeCountOff, on: includeCountOn },
    flaggedCount,
    verdictTransitions: Object.fromEntries(verdictTransitions),
    coverOnConfiguredWeekdayFlexOn,
    coverOnDayFlexOff,
    coverOnDayFlexOn: coverOnConfiguredWeekdayFlexOn,
    coverOnDayFlexOffMoves: coverOnDayFlexOffRows,
    coverCountChangeReasonSplit: { disappeared: coverDisappearedCount, moved: coverMovedCount },
    unmappedMemos: [...unmappedMemos],
    guardFailures,
  }, null, 2), 'utf-8');
  console.log(`\nWrote ${changedRows.length} changed rows to ${path.join(OUT_DIR, 'impact_rows.csv')}`);
  console.log(`Wrote summary to ${path.join(OUT_DIR, 'impact_summary.json')}`);
}

if (guardFailures.length > 0) {
  console.error(`\nFATAL: ${guardFailures.length} guard violation(s). See above.`);
  process.exit(1);
}

console.log('\nAll guards passed.');
