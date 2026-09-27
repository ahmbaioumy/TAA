// Headless runner for the 40 hand-written validation scenarios in
// artifacts/TAA_40_Validation_Scenarios.md — calls the REAL engine
// (reconciliationEngine.ts / parsers.ts), not a re-implementation.
// Run: npx tsx scripts/validate40.ts   (from TAA_HTML/)
import {
  CognosRecord,
  AspectSegment,
  AspectIdentity,
  CMSPunch,
  ConfigRegistry,
  AspectCorrectionRow,
} from '../src/types/taa';
import { runReconciliation, generateAspectCorrectionsCsv } from '../src/services/reconciliationEngine';
import { DEFAULT_CONFIG } from '../src/services/configRegistry';
import { SUITE_RUN_DATE } from '../src/services/regressionSuite';
import {
  parseCognosReport,
  parseAspectSegments,
  parseAspectIdentity,
  parseCmsPunches,
  validateCmsFile,
  decodeFileBuffer,
  normalizeDateKey,
} from '../src/services/parsers';
import { assessHeadcountMapping } from '../src/services/punchAttribution';
import { isForcedHoldReason } from '../src/services/holdReasons';
import * as fs from 'fs';
import * as path from 'path';

interface CaseResult {
  id: string;
  name: string;
  passed: boolean;
  failures: string[];
}

const allResults: CaseResult[] = [];

function makeDt(dateStr: string, timeStr: string): Date {
  const [d, m, y] = dateStr.split('/').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

// One "swipe event" row, matching real CMS export shape (login==logout +/- seconds).
function swipe(dateStr: string, loginId: string, timeStr: string): CMSPunch {
  const t = makeDt(dateStr, timeStr);
  return { Date: dateStr, LoginID: loginId, LoginDateTime: t, LogoutDateTime: new Date(t.getTime() + 3000) };
}

function mkCognos(overrides: Partial<CognosRecord> & { 'SIGN IN DATE': string; 'PF NO': string; 'LOGIN ID': string }): CognosRecord {
  return {
    SECTION: 'ECS',
    NAME: overrides.NAME || 'Test Employee',
    DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '',
    'SCH DURATION': '', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
    'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    ...overrides,
  };
}

function mkIdentity(empId: string, opts: { officer?: boolean; flex?: boolean; name?: string } = {}): AspectIdentity {
  const tags = [opts.officer ? 'OFCR' : '', opts.flex ? 'FLEX' : ''].filter(Boolean).join(' ');
  return {
    EMP_ID: empId,
    EMP_LAST_NAME: opts.name || 'Test Employee',
    EMP_SORT_NAME: `TEST EMPLOYEE ${tags}`.trim(),
    EMP_EXTRA_2: `emp${empId}`,
  };
}

function seg(empId: string, nomDate: string, segCode: string, opts: { start?: string; stop?: string; duration?: number } = {}): AspectSegment {
  return {
    EMP_ID: empId,
    NOM_DATE: nomDate,
    START_DATE: nomDate,
    SEG_CODE: segCode,
    START_MOMENT: opts.start ? `${opts.start} 00:00:00`.replace(' 00:00:00', '') : undefined,
    STOP_MOMENT: opts.stop,
    DURATION: opts.duration,
  };
}

// Convenience: build a full-datetime "DD/MM/YYYY HH:MM:SS" string.
function fdt(dateStr: string, timeStr: string): string {
  return `${dateStr} ${timeStr}:00`;
}

function run(id: string, name: string, fn: (fail: (msg: string) => void) => void) {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  try {
    fn(fail);
  } catch (e: any) {
    failures.push(`THREW: ${e?.stack || e}`);
  }
  allResults.push({ id, name, passed: failures.length === 0, failures });
}

function eq(fail: (msg: string) => void, label: string, actual: any, expected: any) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function includes(fail: (msg: string) => void, label: string, haystack: string, needle: string) {
  if (!haystack.includes(needle)) fail(`${label}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
}
function truthy(fail: (msg: string) => void, label: string, val: any) {
  if (!val) fail(`${label}: expected truthy, got ${JSON.stringify(val)}`);
}

// Pinned off (same as regressionSuite.ts's base config): these scenarios test
// generic Flex logic, not the Reduced Office Hours Friday rule.
const CFG: ConfigRegistry = { ...DEFAULT_CONFIG, reducedOfficeHoursEnabled: false };

// =====================================================================
// BR-01 — Nursing carve-out followed by very late departure
// =====================================================================
run('BR-01', 'Nursing carve-out + very late departure', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000001', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000001', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'NURSNG', START_MOMENT: fdt('11/09/2026', '14:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 60 },
  ];
  const identities = [mkIdentity('7000001')];
  const punches = [swipe('11/09/2026', '90001', '07:00'), swipe('11/09/2026', '90001', '15:20')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000001', 'LOGIN ID': '90001', DUTY1: '07:00 - 15:00', 'SCH DURATION': '8:0', 'SIGIN IN': '07:00', 'SIGIN OUT': '15:20' })];
  // Pinned on (Step 3 2026-09-24): the SCH DURATION MISMATCH->NOT_COMPARABLE downgrade this
  // case exercises is gated by releaseProvenSafeHolds — pin true so this case still proves
  // the release regardless of the ambient CFG's toggle state.
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, releaseProvenSafeHolds: true } });
  const row = out.rows[0];
  eq(fail, 'TAA_EFFECTIVE_END', row.TAA_EFFECTIVE_END, '14:00');
  eq(fail, 'TAA_LATE_MIN', row.TAA_LATE_MIN, 0);
  eq(fail, 'TAA_VERDICT', row.TAA_VERDICT, 'ABSENT');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'MARKED_ABSENT');
  // Phase 3 (2026-09-24): Cognos SCH DURATION (8:0=480m) excludes exactly the 60m nursing
  // deduction TAA's recomputed net (420m) already applies — an exact match otherwise, so
  // this SCH DURATION column now downgrades MISMATCH -> NOT_COMPARABLE. It was the only
  // mismatch column on this row (LEFT EARLY/SIGIN OUT both agree with the actual 15:20
  // logout), so the row is no longer held. Verdict/action/corrections are unchanged.
  eq(fail, 'holdReason', row.holdReason, undefined);
  eq(fail, 'includeInOutput', row.includeInOutput, true);
  const varMeas = row.details.varianceTrace?.measurements.find(m => m.label === 'LATE_LOGOUT');
  eq(fail, 'LATE_LOGOUT minutes', varMeas?.minutes, 80);
});

// =====================================================================
// BR-02 — Cross-midnight late arrival and early departure with two covers
// =====================================================================
run('BR-02', 'Cross-midnight late+early, two covers', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000002', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '19:00'), STOP_MOMENT: fdt('12/09/2026', '03:00'), DURATION: 480 },
    { EMP_ID: '7000002', NOM_DATE: '13/09/2026', START_DATE: '13/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('13/09/2026', '19:00'), STOP_MOMENT: fdt('14/09/2026', '03:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000002')];
  const punches = [
    swipe('11/09/2026', '90002', '19:08'), swipe('12/09/2026', '90002', '02:53'),
    // WP8: an unrelated login punching later that same calendar day — keeps 12/09 (the last day
    // with any punch in this fixture) from reading as a truncated export (the new truncated-
    // export coverage gate, reconciliationEngine.ts, judges coverage against the WHOLE export,
    // not just this login; a real multi-employee CMS file always has someone punching later).
    swipe('12/09/2026', 'sentinel-export-open', '23:30'),
  ];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000002', 'LOGIN ID': '90002', DUTY1: '19:00 - 03:00', 'SIGIN IN': '19:08', 'SIGIN OUT': '02:53' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_LATE_MIN', row.TAA_LATE_MIN, 8);
  eq(fail, 'TAA_EARLY_MIN', row.TAA_EARLY_MIN, 7);
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'LOGOFF_AND_COVER');
  includes(fail, 'TAA_ACTIONS_FIRED (LATE)', row.TAA_ACTIONS_FIRED, 'LATE_AND_COVER');
  includes(fail, 'TAA_ACTIONS_FIRED (LOGOFF)', row.TAA_ACTIONS_FIRED, 'LOGOFF_AND_COVER');
  const coverRows = out.aspectCorrections.filter(c => c.SegmentCode === 'COVER' && c.ID === '7000002');
  eq(fail, 'cover row count', coverRows.length, 2);
  coverRows.forEach(c => {
    eq(fail, `cover nominateDate for ${c.SegmentStarttime}`, c.nominateDate, '13/09/2026');
    eq(fail, `cover SegmentDate for ${c.SegmentStarttime}`, c.SegmentDate, '14/09/2026');
  });
  const starts = coverRows.map(c => c.SegmentStarttime).sort();
  eq(fail, 'cover start times', JSON.stringify(starts), JSON.stringify(['03:00', '03:08']));
});

// =====================================================================
// BR-03 — Officer night shift, RLS + late login + exactly 60m late logout
// =====================================================================
run('BR-03', 'Officer RLS + late login + 60m late logout boundary', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000003', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '23:00'), STOP_MOMENT: fdt('12/09/2026', '07:00'), DURATION: 480 },
    { EMP_ID: '7000003', NOM_DATE: '11/09/2026', START_DATE: '12/09/2026', SEG_CODE: 'RLS', START_MOMENT: fdt('12/09/2026', '06:00'), STOP_MOMENT: fdt('12/09/2026', '07:00'), DURATION: 60 },
  ];
  const identities = [mkIdentity('7000003', { officer: true })];
  const punches = [swipe('11/09/2026', '90003', '23:11'), swipe('12/09/2026', '90003', '07:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000003', 'LOGIN ID': '90003', DUTY1: '23:00 - 07:00', 'SCH DURATION': '8:0', 'SIGIN IN': '23:11', 'SIGIN OUT': '07:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_TIER', row.TAA_TIER, 'OFFICER_PLUS');
  eq(fail, 'TAA_LATE_MIN', row.TAA_LATE_MIN, 11);
  truthy(fail, 'TAA_EFFECTIVE_END is 06:00 (date qualifier expected across midnight)', row.TAA_EFFECTIVE_END.startsWith('06:00'));
  eq(fail, 'TAA_VERDICT', row.TAA_VERDICT, 'ABSENT');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  const absentRows = out.aspectCorrections.filter(c => c.ID === '7000003');
  eq(fail, 'correction row count (only ABSENT)', absentRows.length, 1);
  if (absentRows[0]) eq(fail, 'the one row is ABSENT', absentRows[0].SegmentCode, 'ABSENT');
});

// =====================================================================
// BR-04 — Absent day with OT1, OT2, RLS overlapping both
// =====================================================================
run('BR-04', 'Absent + OT1/OT2 + RLS overlap', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000004', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000004', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT1', START_MOMENT: fdt('11/09/2026', '15:00'), STOP_MOMENT: fdt('11/09/2026', '17:00'), DURATION: 120 },
    { EMP_ID: '7000004', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT2', START_MOMENT: fdt('11/09/2026', '17:00'), STOP_MOMENT: fdt('11/09/2026', '19:00'), DURATION: 120 },
    { EMP_ID: '7000004', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'RLS', START_MOMENT: fdt('11/09/2026', '16:00'), STOP_MOMENT: fdt('11/09/2026', '18:00'), DURATION: 120 },
  ];
  const identities = [mkIdentity('7000004')];
  const punches = [swipe('11/09/2026', '90004', '08:01'), swipe('11/09/2026', '90004', '19:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000004', 'LOGIN ID': '90004', DUTY1: '07:00 - 15:00', 'SCH DURATION': '10:0' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_LATE_MIN', row.TAA_LATE_MIN, 61);
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  // Replace-pair decision (2026-09-15): §4.6c already retires every OT1/OT2 segment
  // on an Absent day via its own 10/11 pair, so Rule 8 (ADJUST_OT_RLS) is skipped
  // entirely on this day — firing it too would draft a second, conflicting 10/11
  // pair against the same OT segments. OT_TO_SHIFT fires instead.
  includes(fail, 'TAA_ACTIONS_FIRED includes OT_TO_SHIFT', row.TAA_ACTIONS_FIRED, 'OT_TO_SHIFT');
  eq(fail, 'TAA_ACTIONS_FIRED does not include ADJUST_OT_RLS (skipped on an Absent day)', row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS'), false);
  // Fixed 2026-09-11: an RLS fully inside OT1+OT2 used to be classified MID_SHIFT_REMOVAL_SEGMENT
  // (a FORCED hold), silently blocking this entire day's ABSENT + OT-adjustment corrections from
  // ever reaching the export — even though R_8 already computes the right OT adjustment.
  eq(fail, 'not held for MID_SHIFT_REMOVAL_SEGMENT', row.holdReason, undefined);
  eq(fail, 'includeInOutput', row.includeInOutput, true);
  eq(fail, 'TAA_OT1 stays raw 120 (reduction shown in totals/corrections, not here)', row.TAA_OT1, '120');
  eq(fail, 'TAA_OT2 stays raw 120', row.TAA_OT2, '120');
  eq(fail, 'TAA_SCH_HOURS_RECOMPUTED nets the RLS overlap (480+120+120-120)', row.TAA_SCH_HOURS_RECOMPUTED, 600);
  // Audit-total reconciliation (bug fix 2026-09-11): the deduction fields the UI displays
  // must actually add up to the recomputed net, not just the net itself being right.
  const rawAdditions = 480 + 120 + 120;
  eq(fail, 'otInternalRemovalMinutes reports the 120m RLS-in-OT overlap', row.details.otInternalRemovalMinutes, 120);
  eq(fail, 'raw - release - nursing - OT-internal reconciles to the recomputed net',
    rawAdditions - row.details.releaseMinutes - row.details.nursingMinutes - row.details.otInternalRemovalMinutes,
    row.TAA_SCH_HOURS_RECOMPUTED);

  // Exact correction set — not just "at least N rows". Strengthened 2026-09-11: the
  // previous >=5 check would pass even with missing or duplicated rows. Reshaped
  // 2026-09-15: on an Absent day, Rule 8 no longer emits its own RLS-netted 10/11
  // pair (01:00 remainder) — §4.6c alone retires each OT segment via a 10/11 pair
  // at its FULL original duration (02:00), regardless of the RLS overlap, since the
  // day already pays zero either way.
  const corr = out.aspectCorrections.filter(c => c.ID === '7000004');
  const absent = corr.find(c => c.Code === '00' && c.SegmentCode === 'ABSENT');
  const ot1Original = corr.find(c => c.Code === '10' && c.SegmentCode === 'OT1');
  const ot1Replacement = corr.find(c => c.Code === '11' && c.SegmentCode === 'SHIFT' && c.SegmentStarttime === '15:00');
  const ot2Original = corr.find(c => c.Code === '10' && c.SegmentCode === 'OT2');
  const ot2Replacement = corr.find(c => c.Code === '11' && c.SegmentCode === 'SHIFT' && c.SegmentStarttime === '17:00');
  truthy(fail, 'ABSENT row exists', absent);
  if (absent) {
    eq(fail, 'ABSENT nominateDate', absent.nominateDate, '11/09/2026');
    eq(fail, 'ABSENT has no start/duration (full-day marker)', absent.SegmentStarttime, '');
  }
  truthy(fail, 'OT1 Code-10 original exists', ot1Original);
  if (ot1Original) {
    eq(fail, 'OT1 original start', ot1Original.SegmentStarttime, '15:00');
    eq(fail, 'OT1 original duration (full, not RLS-netted)', ot1Original.Segmentduration, '02:00');
  }
  truthy(fail, 'OT1 Code-11 SHIFT replacement exists', ot1Replacement);
  if (ot1Replacement) {
    eq(fail, 'OT1 replacement start matches the original (retired, not shrunk)', ot1Replacement.SegmentStarttime, '15:00');
    eq(fail, 'OT1 replacement duration matches the original full 02:00 (never netted against RLS)', ot1Replacement.Segmentduration, '02:00');
  }
  truthy(fail, 'OT2 Code-10 original exists', ot2Original);
  if (ot2Original) {
    eq(fail, 'OT2 original start', ot2Original.SegmentStarttime, '17:00');
    eq(fail, 'OT2 original duration (full, not RLS-netted)', ot2Original.Segmentduration, '02:00');
  }
  truthy(fail, 'OT2 Code-11 SHIFT replacement exists', ot2Replacement);
  if (ot2Replacement) {
    eq(fail, 'OT2 replacement start matches the original (retired, not shrunk)', ot2Replacement.SegmentStarttime, '17:00');
    eq(fail, 'OT2 replacement duration matches the original full 02:00 (never netted against RLS)', ot2Replacement.Segmentduration, '02:00');
  }
  eq(fail, 'no stray LATE/Log_off/COVER rows', corr.filter(c => ['LATE', 'Log_off', 'COVER'].includes(c.SegmentCode)).length, 0);
  eq(fail, 'no plain Code-00 SHIFT insert (must be the 10/11 replace pair only)', corr.filter(c => c.Code === '00' && c.SegmentCode === 'SHIFT').length, 0);
  eq(fail, 'exactly 5 correction rows total (1 ABSENT + 10/11 OT1 pair + 10/11 OT2 pair)', corr.length, 5);

  const csvDataLines = out.aspectCorrectionsCsv.split('\n').filter(l => l.trim().length > 0);
  eq(fail, 'all 5 corrections actually reach the exported CSV (not just the preview array)', csvDataLines.length, 5);
});

// =====================================================================
// BR-05 — Late login + unattended existing cover escalates
// =====================================================================
run('BR-05', 'Late login + unattended cover escalates to absent', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000005', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000005', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'COVER', START_MOMENT: fdt('11/09/2026', '15:00'), STOP_MOMENT: fdt('11/09/2026', '15:12'), DURATION: 12 },
  ];
  const identities = [mkIdentity('7000005')];
  const punches = [swipe('11/09/2026', '90005', '07:06'), swipe('11/09/2026', '90005', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000005', 'LOGIN ID': '90005', DUTY1: '07:00 - 15:00', 'SIGIN IN': '07:06', 'SIGIN OUT': '15:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, coverNotAttendedAction: 'markAbsent', coverExtendsAttendanceWindow: false } });
  const row = out.rows[0];
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  const rows = out.aspectCorrections.filter(c => c.ID === '7000005');
  eq(fail, 'exactly one correction row (ABSENT only)', rows.length, 1);
  if (rows[0]) {
    eq(fail, 'that row is ABSENT', rows[0].SegmentCode, 'ABSENT');
    eq(fail, 'ABSENT nominateDate is 11/09/2026', rows[0].nominateDate, '11/09/2026');
    eq(fail, 'ABSENT memo names the cover-not-attended escalation', rows[0].Memo, 'TAA Cover Not Attended 12m');
  }
});

// =====================================================================
// BR-06 — Officer partially-attended cover moved forward & stacked
// =====================================================================
run('BR-06', 'Officer cover moved forward & stacked', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000006', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000006', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'COVER', START_MOMENT: fdt('11/09/2026', '15:00'), STOP_MOMENT: fdt('11/09/2026', '15:10'), DURATION: 10 },
    { EMP_ID: '7000006', NOM_DATE: '12/09/2026', START_DATE: '12/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('12/09/2026', '07:00'), STOP_MOMENT: fdt('12/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000006', NOM_DATE: '12/09/2026', START_DATE: '12/09/2026', SEG_CODE: 'COVER', START_MOMENT: fdt('12/09/2026', '15:00'), STOP_MOMENT: fdt('12/09/2026', '15:12'), DURATION: 12 },
  ];
  const identities = [mkIdentity('7000006', { officer: true })];
  const punches = [swipe('11/09/2026', '90006', '07:00'), swipe('11/09/2026', '90006', '15:04')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000006', 'LOGIN ID': '90006', DUTY1: '07:00 - 15:00', 'SIGIN IN': '07:00', 'SIGIN OUT': '15:04' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, coverNotAttendedAction: 'moveCoverForward' } });
  const row = out.rows[0];
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'LATE_AND_COVER');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'LATE_AND_COVER_ADDED');
  const corr6 = out.aspectCorrections.filter(c => c.ID === '7000006');
  eq(fail, 'exactly one correction row (the moved cover)', corr6.length, 1);
  const newCover = corr6.find(c => c.SegmentDate === '12/09/2026' && c.SegmentCode === 'COVER' && c.SegmentStarttime === '15:12');
  truthy(fail, 'new cover exists at 12/09 15:12', newCover);
  if (newCover) {
    eq(fail, 'moved cover keeps full original duration 00:10', newCover.Segmentduration, '00:10');
    eq(fail, 'moved cover nominateDate is the target day 12/09/2026', newCover.nominateDate, '12/09/2026');
    eq(fail, 'memo names the fallback and the original 11/09 15:00 placement', newCover.Memo, 'TAA Cover Not Attended: moved forward (was 11/09/2026 15:00)');
  }
});

// =====================================================================
// BR-07 — Flex shift change + early logout after shifted end
// =====================================================================
run('BR-07', 'Flex branch A + early logout after shifted end', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000007', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000007', NOM_DATE: '12/09/2026', START_DATE: '12/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('12/09/2026', '07:00'), STOP_MOMENT: fdt('12/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000007', { flex: true })];
  const punches = [swipe('11/09/2026', '90007', '08:12'), swipe('11/09/2026', '90007', '15:52')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000007', 'LOGIN ID': '90007', DUTY1: '07:00 - 15:00', 'SIGIN IN': '08:12', 'SIGIN OUT': '15:52' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_TIER', row.TAA_TIER, 'FLEX');
  eq(fail, 'TAA_EFFECTIVE_START', row.TAA_EFFECTIVE_START, '08:00');
  eq(fail, 'TAA_EFFECTIVE_END', row.TAA_EFFECTIVE_END, '16:00');
  eq(fail, 'TAA_EARLY_MIN', row.TAA_EARLY_MIN, 8);
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'LOGOFF_AND_COVER');
  // Strengthened 2026-09-11: assert BOTH actions fired together (a row with two
  // findings — the flex shift-update AND the downstream early-logout — must report
  // both; checking TAA_ACTION alone only proves the later/more-severe one survived).
  includes(fail, 'actions fired includes flex shift-update', row.TAA_ACTIONS_FIRED, 'SHIFT_UPDATE_FLEX');
  includes(fail, 'actions fired includes the downstream early-logout', row.TAA_ACTIONS_FIRED, 'LOGOFF_AND_COVER');

  // Exact 4-row correction set — not just "a 10/11 pair exists somewhere".
  const corr = out.aspectCorrections.filter(c => c.ID === '7000007');
  eq(fail, 'exactly 4 correction rows (no missing/extra)', corr.length, 4);
  const original = corr.find(c => c.Code === '10' && c.SegmentCode === 'shift');
  const updated = corr.find(c => c.Code === '11' && c.SegmentCode === 'shift');
  const logoff = corr.find(c => c.SegmentCode === 'Log_off');
  const cover = corr.find(c => c.SegmentCode === 'COVER');
  truthy(fail, 'Code-10 original shift row exists', original);
  if (original) {
    eq(fail, 'original shift start (raw, pre-flex)', original.SegmentStarttime, '07:00');
    eq(fail, 'original shift duration preserved (8h)', original.Segmentduration, '08:00');
    eq(fail, 'original shift date', original.SegmentDate, '11/09/2026');
  }
  truthy(fail, 'Code-11 updated shift row exists', updated);
  if (updated) {
    eq(fail, 'updated shift start (rounded arrival)', updated.SegmentStarttime, '08:00');
    eq(fail, 'updated shift duration preserved (8h)', updated.Segmentduration, '08:00');
  }
  truthy(fail, 'Log_off row exists', logoff);
  if (logoff) {
    eq(fail, 'Log_off start (actual logout)', logoff.SegmentStarttime, '15:52');
    eq(fail, 'Log_off duration (8m early vs shifted end 16:00)', logoff.Segmentduration, '00:08');
  }
  truthy(fail, 'next-working-day COVER row exists', cover);
  if (cover) {
    eq(fail, 'COVER nominateDate/SegmentDate on the next working day', cover.nominateDate, '12/09/2026');
    eq(fail, 'COVER SegmentDate', cover.SegmentDate, '12/09/2026');
    eq(fail, 'COVER duration matches the 8m shortfall', cover.Segmentduration, '00:08');
  }
});

// =====================================================================
// BR-08 — Flex 1 min past cutoff + early-logout absence
// =====================================================================
run('BR-08', 'Flex branch B (1m past cutoff) + early-logout absence', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000008', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000008', NOM_DATE: '12/09/2026', START_DATE: '12/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('12/09/2026', '07:00'), STOP_MOMENT: fdt('12/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000008', { flex: true })];
  const punches = [swipe('11/09/2026', '90008', '10:01'), swipe('11/09/2026', '90008', '17:50')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000008', 'LOGIN ID': '90008', DUTY1: '07:00 - 15:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_EFFECTIVE_START', row.TAA_EFFECTIVE_START, '10:00');
  eq(fail, 'TAA_EFFECTIVE_END', row.TAA_EFFECTIVE_END, '18:00');
  eq(fail, 'TAA_LATE_MIN (flex, 1m not 181m)', row.TAA_LATE_MIN, 1);
  eq(fail, 'TAA_EARLY_MIN', row.TAA_EARLY_MIN, 10);
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  const rows = out.aspectCorrections.filter(c => c.ID === '7000008');
  const shiftPair = rows.filter(c => c.Code === '10' || c.Code === '11');
  const absentRows = rows.filter(c => c.SegmentCode === 'ABSENT');
  eq(fail, 'shift-update pair kept', shiftPair.length, 2);
  eq(fail, 'one ABSENT row', absentRows.length, 1);
  eq(fail, 'no LATE/Log_off/COVER rows', rows.filter(c => ['LATE', 'Log_off', 'COVER'].includes(c.SegmentCode)).length, 0);
});

// =====================================================================
// BR-09 — Flex-tagged night shift outside flex window
// =====================================================================
run('BR-09', 'Flex safety gate for out-of-window schedule', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000009', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '19:00'), STOP_MOMENT: fdt('12/09/2026', '03:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000009', { flex: true })];
  const punches = [swipe('11/09/2026', '90009', '19:05'), swipe('12/09/2026', '90009', '03:05')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000009', 'LOGIN ID': '90009', DUTY1: '19:00 - 03:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  // flexOutsideWindowTreatAsOps defaults to true: the row already ran standard/OPS
  // attendance math (this test's real subject); it is now labeled OPS to match.
  eq(fail, 'TAA_TIER', row.TAA_TIER, 'OPS');
  eq(fail, 'holdReason', row.holdReason, 'FLEX_SCHEDULE_OUTSIDE_WINDOW');
  eq(fail, 'includeInOutput', row.includeInOutput, false);
  eq(fail, 'no correction rows', out.aspectCorrections.filter(c => c.ID === '7000009').length, 0);
  // must NOT be clamped to 10:00 like a normal flex branch B
  const notClamped = row.TAA_EFFECTIVE_START !== '10:00';
  truthy(fail, 'schedule not clamped to flex cutoff', notClamped);

  // Toggle OFF: same row must still be labeled FLEX (hold is unaffected either way).
  const outToggledOff = runReconciliation({ processingDate: SUITE_RUN_DATE,
    cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches,
    config: { ...CFG, flexOutsideWindowTreatAsOps: false },
  });
  const rowToggledOff = outToggledOff.rows[0];
  eq(fail, 'TAA_TIER (toggle off)', rowToggledOff.TAA_TIER, 'FLEX');
  eq(fail, 'holdReason (toggle off)', rowToggledOff.holdReason, 'FLEX_SCHEDULE_OUTSIDE_WINDOW');
});

// =====================================================================
// BR-10 — Split shift with long gap, sparse 2nd-block evidence
// =====================================================================
run('BR-10', 'Split shift whole-day anchors, no per-block penalty', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000010', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '11:00'), DURATION: 240 },
    { EMP_ID: '7000010', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '13:00'), STOP_MOMENT: fdt('11/09/2026', '17:00'), DURATION: 240 },
  ];
  const identities = [mkIdentity('7000010')];
  const punches = [swipe('11/09/2026', '90010', '07:00'), swipe('11/09/2026', '90010', '11:00'), swipe('11/09/2026', '90010', '16:55'), swipe('11/09/2026', '90010', '17:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000010', 'LOGIN ID': '90010', DUTY1: '07:00 - 11:00', 'DUTY-2': '13:00 - 17:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, perBlockGapThresholdMinutes: 60 } });
  const row = out.rows[0];
  eq(fail, 'TAA_LATE_MIN', row.TAA_LATE_MIN, 0);
  eq(fail, 'TAA_EARLY_MIN', row.TAA_EARLY_MIN, 0);
  eq(fail, 'TAA_VERDICT', row.TAA_VERDICT, 'PRESENT');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
  eq(fail, 'no correction rows', out.aspectCorrections.filter(c => c.ID === '7000010').length, 0);
});

// =====================================================================
// BR-11 — Leave day, 59-min login below anomaly threshold
// =====================================================================
run('BR-11', 'Leave day 59m below anomaly threshold', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000011', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'ANNUAL' },
  ];
  const identities = [mkIdentity('7000011')];
  const punches = [swipe('11/09/2026', '90011', '10:00'), swipe('11/09/2026', '90011', '10:59')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000011', 'LOGIN ID': '90011', DUTY1: '07:00 - 15:00', 'SCH DURATION': '8:0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '08:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, leaveLoginThresholdMinutes: 60, compareScheduleColumnsOnLeaveDays: false } });
  const row = out.rows[0];
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'NO_ACTION_REQUIRED');
  eq(fail, 'TAA_LEAVE_TYPE_RECOMPUTED', row.TAA_LEAVE_TYPE_RECOMPUTED, 'ANNUAL');
  eq(fail, 'no correction rows', out.aspectCorrections.filter(c => c.ID === '7000011').length, 0);
});

// =====================================================================
// BR-12 — Leave day, exactly 60 minutes attendance
// =====================================================================
run('BR-12', 'Leave day exactly 60m anomaly boundary', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000012', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'ANNUAL' },
  ];
  const identities = [mkIdentity('7000012', { officer: true })];
  const punches = [swipe('11/09/2026', '90012', '10:00'), swipe('11/09/2026', '90012', '11:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000012', 'LOGIN ID': '90012', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '08:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, leaveLoginThresholdMinutes: 60 } });
  const row = out.rows[0];
  eq(fail, 'TAA_VERDICT', row.TAA_VERDICT, 'ABSENT');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  eq(fail, 'TAA_LEAVE_TYPE_RECOMPUTED preserved', row.TAA_LEAVE_TYPE_RECOMPUTED, 'ANNUAL');
  // Strengthened 2026-09-11: the doc gives a literal expected correction row; assert it.
  const corr12 = out.aspectCorrections.filter(c => c.ID === '7000012');
  eq(fail, 'exactly one correction row (the anomaly ABSENT marker)', corr12.length, 1);
  if (corr12[0]) {
    eq(fail, 'ABSENT nominateDate', corr12[0].nominateDate, '11/09/2026');
    eq(fail, 'ABSENT memo names the leave-day attendance anomaly', corr12[0].Memo, 'TAA Anomaly: Attendance recorded on scheduled leave day');
  }
});

// =====================================================================
// BR-13 — Public-holiday OT2 day, no login
// =====================================================================
run('BR-13', 'P/H-LV + OT2 no-show routes through attendance', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000013', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'P/H-LV' },
    { EMP_ID: '7000013', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT2', START_MOMENT: fdt('11/09/2026', '23:00'), STOP_MOMENT: fdt('12/09/2026', '07:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000013')];
  const punches: CMSPunch[] = [];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000013', 'LOGIN ID': '90013', 'SIGNIN DURATION': '00:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_OT2', row.TAA_OT2, '480');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_NS_NC');
  const rows = out.aspectCorrections.filter(c => c.ID === '7000013');
  const nsnc = rows.find(c => c.SegmentCode.toUpperCase().includes('ABSENT'));
  // Replace-pair decision (2026-09-15): OT2 must be explicitly retired, not left in
  // ASPECT alongside a new SHIFT insert — a 10 (original OT2) / 11 (SHIFT) pair.
  const ot2Original = rows.find(c => c.Code === '10' && c.SegmentCode === 'OT2');
  const shiftConv = rows.find(c => c.Code === '11' && c.SegmentCode === 'SHIFT');
  truthy(fail, 'ABSENT NS/NC row exists', nsnc);
  truthy(fail, 'OT2 Code-10 original (retired) row exists', ot2Original);
  truthy(fail, 'OT2-to-SHIFT Code-11 replacement row exists', shiftConv);
  if (nsnc) eq(fail, 'ABSENT NS/NC memo', nsnc.Memo, 'TAA Full Shift Absence NS/NC');
  if (ot2Original) {
    eq(fail, 'original OT2 start 23:00', ot2Original.SegmentStarttime, '23:00');
    eq(fail, 'original OT2 date 11/09', ot2Original.SegmentDate, '11/09/2026');
    eq(fail, 'original OT2 duration 08:00', ot2Original.Segmentduration, '08:00');
  }
  if (shiftConv) {
    eq(fail, 'replacement SHIFT keeps original start 23:00', shiftConv.SegmentStarttime, '23:00');
    eq(fail, 'replacement SHIFT keeps original date 11/09', shiftConv.SegmentDate, '11/09/2026');
    eq(fail, 'replacement SHIFT memo', shiftConv.Memo, 'TAA Absent Day: OT2 segment converted to SHIFT');
  }
  eq(fail, 'no plain Code-00 SHIFT insert (must be the 10/11 replace pair only)', rows.filter(c => c.Code === '00' && c.SegmentCode === 'SHIFT').length, 0);
  eq(fail, 'exactly 3 correction rows (1 ABSENT NS/NC + 10/11 OT2 pair)', rows.length, 3);
  // FIXED (2026-09-12): found while strengthening this case (2026-09-11) that
  // MIXED_LEAVE_AND_WORK_SEGMENTS fired on P/H-LV + OT2 (no SHIFT), setting
  // includeInOutput=FALSE — contradicting PRD.md's Non-Negotiables table, which cites
  // this EXACT pattern (PF 4507957) as "Evaluated & Paid as Public Holiday OT2", not
  // held. reconciliationEngine.ts now exempts a day whose leave segments are all a
  // configured publicHolidayOvertimeLeaveCodes entry (default P/H-LV) AND whose worked
  // segments are all OT2 — deliberately narrow (see doc/TAA_KNOWLEDGE_BASE.md §7k and
  // regressionSuite.ts reg-114/115/116, which guard the boundary: ANNUAL+OT2 and
  // P/H-LV+OT1 both still hold).
  eq(fail, 'includeInOutput=TRUE for this documented real case (PF 4507957)', row.includeInOutput, true);
  eq(fail, 'holdReason is not MIXED_LEAVE_AND_WORK_SEGMENTS (mechanism, not just outcome)', row.holdReason, undefined);
});

// =====================================================================
// BR-14 — Cross-midnight single swipe, sufficient CMS coverage
// =====================================================================
run('BR-14', 'Cross-midnight thin punch, sufficient file coverage', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000014', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '23:00'), STOP_MOMENT: fdt('12/09/2026', '07:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000014', { officer: true })];
  // F3 fix: coverage is judged against the EXPORT's own extent (any record
  // anywhere in the file touching a calendar day marks that day covered),
  // not one login's own far-apart timestamps — a punch on 20/09 says nothing
  // about whether 12/09 (the very next day, which this cross-midnight shift's
  // own window needs) was actually captured by the export. The 12/09 20:00
  // entry below is what makes that day genuinely present in the export; it's
  // placed well outside the +/-4h attribution search radius around the
  // shift's 07:00 end so it cannot itself be attributed as a companion punch
  // (this scenario's whole point is a genuinely uncovered companion punch —
  // distinguishes from BR-16's truncated file, where 12/09 is absent).
  const punches: CMSPunch[] = [
    swipe('01/09/2026', '90014', '08:00'),
    swipe('11/09/2026', '90014', '23:08'),
    swipe('12/09/2026', '90014', '20:00'),
    swipe('20/09/2026', '90014', '08:00'),
  ];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000014', 'LOGIN ID': '90014', 'SIGIN IN': '23:08', 'SIGIN OUT': '23:08', 'SIGNIN DURATION': '00:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, minAttendanceSpanMinutes: 1 } });
  const row = out.rows[0];
  eq(fail, 'TAA_VERDICT', row.TAA_VERDICT, 'ABSENT');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'ABSENT_SEGMENT');
  eq(fail, 'not a coverage hold', row.holdReason === 'INSUFFICIENT_CMS_COVERAGE', false);
});

// =====================================================================
// BR-15 — Cognos LOGIN ID blank while schedule exists
// =====================================================================
run('BR-15', 'Missing CMS join key forced hold', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000015', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000015')];
  const punches: CMSPunch[] = [swipe('11/09/2026', 'SOME-OTHER-LOGIN', '07:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000015', 'LOGIN ID': '' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'MANUAL_REVIEW_REQUIRED');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'COGNOS_DATA_GAP');
  eq(fail, 'holdReason', row.holdReason, 'MISSING_CMS_JOIN_KEY');
  eq(fail, 'includeInOutput', row.includeInOutput, false);
});

// =====================================================================
// BR-16 — Night shift, one swipe + incomplete next-day CMS coverage
// =====================================================================
run('BR-16', 'Insufficient CMS coverage precedes R_5/R_6', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000016', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '23:00'), STOP_MOMENT: fdt('12/09/2026', '07:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000016')];
  // Only ONE swipe for this login in the ENTIRE file -> file plainly doesn't
  // reach far enough to prove a missing counterpart exists.
  const punches: CMSPunch[] = [swipe('11/09/2026', '90016', '23:02')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000016', 'LOGIN ID': '90016' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'MANUAL_REVIEW_REQUIRED');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'COGNOS_DATA_GAP');
  eq(fail, 'holdReason', row.holdReason, 'INSUFFICIENT_CMS_COVERAGE');
  eq(fail, 'includeInOutput', row.includeInOutput, false);
});

// =====================================================================
// BR-17 — Overlapping NURSNG + RLS reduce only 1 hour (union, not sum)
// =====================================================================
run('BR-17', 'Removal interval union, not sum', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000017', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000017', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'NURSNG', START_MOMENT: fdt('11/09/2026', '14:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 60 },
    { EMP_ID: '7000017', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'RLS', START_MOMENT: fdt('11/09/2026', '14:30'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 30 },
  ];
  const identities = [mkIdentity('7000017')];
  const punches = [swipe('11/09/2026', '90017', '07:00'), swipe('11/09/2026', '90017', '14:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000017', 'LOGIN ID': '90017', 'SCH DURATION': '7:0', 'SIGIN IN': '07:00', 'SIGIN OUT': '14:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_SCH_HOURS_RECOMPUTED', row.TAA_SCH_HOURS_RECOMPUTED, 420);
  eq(fail, 'TAA_EFFECTIVE_END', row.TAA_EFFECTIVE_END, '14:00');
  eq(fail, 'TAA_EARLY_MIN', row.TAA_EARLY_MIN, 0);
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
});

// =====================================================================
// BR-18 — Duration-only release overlapping timestamped release
// =====================================================================
run('BR-18', 'Ambiguous overlapping removal duration hold', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000018', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000018', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'RLS', START_MOMENT: fdt('11/09/2026', '14:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 60 },
    { EMP_ID: '7000018', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'RLS-2H', DURATION: 120 },
  ];
  const identities = [mkIdentity('7000018')];
  const punches = [swipe('11/09/2026', '90018', '07:00'), swipe('11/09/2026', '90018', '14:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000018', 'LOGIN ID': '90018' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  // Contract (resolved 2026-09-11): TAA_ACTION reports the calculated business action;
  // holdReason/includeInOutput carry workflow safety separately. No lateness/early-logout
  // rule fired here, so NO_ACTION is correct — the hold is a POST-calculation
  // schedule-integrity finding, not a pre-calculation failure (contrast AL-09's
  // INVALID_ASPECT_DATETIME, where no trustworthy action exists at all and
  // MANUAL_REVIEW_REQUIRED is still forced). Matches reg-51/reg-53/reg-56.
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
  eq(fail, 'holdReason', row.holdReason, 'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION');
  eq(fail, 'not mislabeled INVALID_ASPECT_DATETIME', row.holdReason === 'INVALID_ASPECT_DATETIME', false);
  eq(fail, 'includeInOutput', row.includeInOutput, false);
});

// =====================================================================
// BR-19 — Mid-shift release is deducted from hours but never moved to shift end
// =====================================================================
run('BR-19', 'Mid-shift removal deducts hours but cannot fabricate an anchor', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000019', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000019', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'RLS', START_MOMENT: fdt('11/09/2026', '10:00'), STOP_MOMENT: fdt('11/09/2026', '11:00'), DURATION: 60 },
  ];
  const identities = [mkIdentity('7000019', { officer: true })];
  const punches = [swipe('11/09/2026', '90019', '07:00'), swipe('11/09/2026', '90019', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000019', 'LOGIN ID': '90019' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, releaseProximityToleranceMinutes: 2 } });
  const row = out.rows[0];
  // Login/logout are exactly on time, so no lateness fires. The mid-shift release costs its
  // 60 minutes (480 -> 420) but never moves the window (no anchor is fabricated) and no
  // longer holds the row.
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
  eq(fail, 'holdReason', row.holdReason, undefined);
  eq(fail, 'includeInOutput', row.includeInOutput, true);
  eq(fail, 'scheduled hours (480 - 60 released)', row.TAA_SCH_HOURS_RECOMPUTED, 420);
  eq(fail, 'effective end not moved', row.TAA_EFFECTIVE_END, '15:00');
  eq(fail, 'no generated corrections', out.aspectCorrections.filter(c => c.ID === '7000019').length, 0);
});

// =====================================================================
// BR-20 — Mixed leave day + worked shift with valid punch pair
// =====================================================================
run('BR-20', 'Mixed leave and worked segments hold', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000020', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'ANNUAL' },
    { EMP_ID: '7000020', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000020')];
  const punches = [swipe('11/09/2026', '90020', '07:00'), swipe('11/09/2026', '90020', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000020', 'LOGIN ID': '90020', 'LEAVE TYPE': 'ANNUAL', DUTY1: '07:00 - 15:00', 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'holdReason', row.holdReason, 'MIXED_LEAVE_AND_WORK_SEGMENTS');
  eq(fail, 'includeInOutput starts FALSE', row.includeInOutput, false);
  eq(fail, 'leave evidence preserved', row.TAA_LEAVE_TYPE_RECOMPUTED, 'ANNUAL');
});

// =====================================================================
// AL-01 — UTF-16 tab-delimited Cognos parser, multiline REMARK
// =====================================================================
run('AL-01', 'UTF-16 tab-delimited Cognos parser + multiline REMARK', (fail) => {
  const headers = ['SIGN IN DATE', 'SECTION', 'PF NO', 'NAME', 'LOGIN ID', 'DUTY1', 'OT1', 'DUTY-2', 'OT-2', 'SCH DURATION', 'SIGNIN DURATION', 'SIGIN IN', 'SIGIN OUT', 'LATE START', 'LEFT EARLY', 'LEAVE TYPE', 'LEAVE HR', 'REMARK'];
  const remark = 'Line one, has "quotes"\nLine two continues';
  const row = ['2026-09-11 00:00:00', 'ECS', '007001', 'Test Employee', '90041', '07:00 - 15:00', '', '', '', '8:0', '08:00', '07:00', '15:00', '0', '0', '', '0', remark];
  const text = headers.join('\t') + '\n' + row.map(v => (v.includes(',') || v.includes('"') || v.includes('\n')) ? `"${v.replace(/"/g, '""')}"` : v).join('\t');
  const buf = Buffer.from('﻿' + text, 'utf16le');
  const decoded = decodeFileBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const records = parseCognosReport(decoded);
  eq(fail, 'exactly one logical record', records.length, 1);
  if (records[0]) {
    eq(fail, 'SIGIN IN preserved', records[0]['SIGIN IN'], '07:00');
    eq(fail, 'SIGIN OUT preserved', records[0]['SIGIN OUT'], '15:00');
    eq(fail, 'REMARK round-trips exactly', records[0].REMARK, remark);
    eq(fail, 'PF NO preserved', records[0]['PF NO'], '007001');
  }
});

// =====================================================================
// AL-02 — CMS duplicate header names, use full-timestamp columns by position
// =====================================================================
run('AL-02', 'CMS positional full-datetime columns win over time-only', (fail) => {
  const cmsText = [
    'EIM Agent Monthly Attendance Report',
    'Agent:,Test_90022',
    'Date,Login ID,Login Time,Logout Time,Login Time,Logout Time',
    '11/09/2026,90022,23:05,07:02,11/09/2026 23:05:00,12/09/2026 07:02:00',
  ].join('\n');
  const punches = parseCmsPunches(cmsText);
  eq(fail, 'one punch parsed', punches.length, 1);
  if (punches[0] && punches[0].LogoutDateTime) {
    eq(fail, 'login date is 11/09', punches[0].LoginDateTime.getDate(), 11);
    eq(fail, 'logout date is 12/09 (not 11/09)', punches[0].LogoutDateTime.getDate(), 12);
    truthy(fail, 'logout after login (positive duration)', punches[0].LogoutDateTime.getTime() > punches[0].LoginDateTime.getTime());
  }
});

// =====================================================================
// AL-03 — Whitespace-padded employee identifiers join without losing zeros
// =====================================================================
run('AL-03', 'Whitespace-padded EMP_ID trims without numeric cast', (fail) => {
  const aspectText = 'EMP_ID,NOM_DATE,START_DATE,SEG_CODE,START_MOMENT,STOP_MOMENT,DURATION\n' +
    '  007001   ,11/09/2026,11/09/2026,SHIFT,11/09/2026 07:00:00,11/09/2026 15:00:00,480\n';
  const segs = parseAspectSegments(aspectText);
  eq(fail, 'one segment parsed', segs.length, 1);
  eq(fail, 'EMP_ID trimmed exactly to 007001 (no numeric cast)', segs[0]?.EMP_ID, '007001');

  const identities = [mkIdentity('007001')];
  const punches = [swipe('11/09/2026', '90023', '07:00'), swipe('11/09/2026', '90023', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '007001', 'LOGIN ID': '90023' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  eq(fail, 'joined row is not a data gap', out.rows[0]?.TAA_RESULT_CATEGORY, 'NO_ACTION_REQUIRED');
});

// =====================================================================
// AL-04 — Unpadded NOM_DATE / START_DATE normalize consistently
// =====================================================================
run('AL-04', 'Unpadded date normalization joins correctly', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000024', NOM_DATE: '1/9/2026', START_DATE: '1/9/2026', SEG_CODE: 'SHIFT', START_MOMENT: '1/9/2026 07:00:00', STOP_MOMENT: '1/9/2026 15:00:00', DURATION: 480 },
  ];
  const identities = [mkIdentity('7000024')];
  const punches = [swipe('01/09/2026', '90024', '07:06'), swipe('01/09/2026', '90024', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '01/09/2026', 'PF NO': '7000024', 'LOGIN ID': '90024' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'no COGNOS_DATA_GAP from date mismatch', row.TAA_RESULT_CATEGORY, 'LATE_AND_COVER_ADDED');
  eq(fail, 'late 6m fires', row.TAA_LATE_MIN, 6);
  const corr = out.aspectCorrections.find(c => c.ID === '7000024');
  if (corr) eq(fail, 'nominateDate zero-padded', corr.nominateDate, '01/09/2026');
});

// =====================================================================
// AL-05 — Headcount mapping gate excludes declared no-shows from denominator
// =====================================================================
run('AL-05', 'Headcount mapping denominator excludes declared no-shows', (fail) => {
  const cognos: CognosRecord[] = [];
  // 4 attendance claimants (logins 1-4), one of which (login 4) has no ASPECT/CMS mapping
  for (let i = 1; i <= 4; i++) {
    cognos.push(mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': `PF${i}`, 'LOGIN ID': `L${i}`, 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00', 'SIGNIN DURATION': '08:00' }));
  }
  // 6 declared no-shows: blank SIGIN IN/OUT and 00:00 duration
  for (let i = 5; i <= 10; i++) {
    cognos.push(mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': `PF${i}`, 'LOGIN ID': `L${i}`, 'SIGNIN DURATION': '00:00' }));
  }
  const aspectIdentities = Array.from({ length: 10 }, (_, i) => mkIdentity(`PF${i + 1}`));
  const cmsPunches: CMSPunch[] = [
    swipe('11/09/2026', 'L1', '07:00'), swipe('11/09/2026', 'L1', '15:00'),
    swipe('11/09/2026', 'L2', '07:00'), swipe('11/09/2026', 'L2', '15:00'),
    swipe('11/09/2026', 'L3', '07:00'), swipe('11/09/2026', 'L3', '15:00'),
    // L4 (attendance claimant) has NO cms punches at all -> the "1 missing" case
  ];
  const assessment = assessHeadcountMapping(cognos, aspectIdentities, cmsPunches, CFG);
  eq(fail, 'CMS expected denominator is 4 (attendance claimants only)', assessment.cmsExpectedEmployeeCount, 4);
  eq(fail, 'CMS mapping % is 75 (3/4), not 30 (3/10)', Math.round(assessment.cmsPercent), 75);
  eq(fail, 'exactly 1 attendance-claimant missing CMS evidence', assessment.cognosClaimsAttendanceButNoCmsCount, 1);
});

// =====================================================================
// AL-06 — One punch near two adjacent schedules is attributed once
// =====================================================================
run('AL-06', 'Punch attributed once across two adjacent windows', (fail) => {
  // Strengthened 2026-09-11: the previous fixture put both SHIFTs under the SAME
  // NOM_DATE, which the engine groups into ONE merged recompute window (segments
  // key on EMP_ID|NOM_DATE) — so it never actually built two separate attribution
  // windows, and the only assertion was a weak "not held" check. This version uses
  // two genuinely distinct employee-day windows (different NOM_DATE) for the same
  // Login ID, matching how attribution windows are really built: one per Cognos
  // row, keyed by that row's own (pfNo, NOM_DATE-derived) segment group.
  //
  // NOTE: START_DATE must equal START_MOMENT's own physical date, not NOM_DATE —
  // otherwise invalidDateTimeSegments fires (the exact fixture bug that broke a
  // BR-03 fixture in an earlier session: NOM_DATE is which SCHEDULE the segment
  // belongs to; START_DATE is a sanity-check against the segment's own START_MOMENT).
  const buildInputs = (cognosOrder: 'day-first' | 'night-first') => {
    const segs: AspectSegment[] = [
      { EMP_ID: '7000026', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
      { EMP_ID: '7000026', NOM_DATE: '12/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '19:00'), STOP_MOMENT: fdt('12/09/2026', '03:00'), DURATION: 480 },
    ];
    const identities = [mkIdentity('7000026')];
    // One login, four swipes: a normal on-time day-shift pair, the contested 18:57
    // swipe near the day's tail / the night's start, and the overnight's own closing
    // swipe just past its rawEnd.
    const punches = [
      swipe('11/09/2026', '90026', '07:00'),
      swipe('11/09/2026', '90026', '15:00'),
      swipe('11/09/2026', '90026', '18:57'),
      swipe('12/09/2026', '90026', '03:02'),
    ];
    const dayRow = mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000026', 'LOGIN ID': '90026', DUTY1: '07:00 - 15:00' });
    const nightRow = mkCognos({ 'SIGN IN DATE': '12/09/2026', 'PF NO': '7000026', 'LOGIN ID': '90026', DUTY1: '19:00 - 03:00' });
    const cognos = cognosOrder === 'day-first' ? [dayRow, nightRow] : [nightRow, dayRow];
    return runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  };

  const punchKey = (p: { LoginDateTime: Date; LogoutDateTime: Date | null }) => `${p.LoginDateTime.getTime()}|${p.LogoutDateTime ? p.LogoutDateTime.getTime() : 'OPEN'}`;

  const check = (out: ReturnType<typeof buildInputs>, label: string) => {
    const dayRow = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === '11/09/2026')!;
    const nightRow = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === '12/09/2026')!;
    truthy(fail, `${label}: both rows resolved`, dayRow && nightRow);
    const dayKeys = new Set(dayRow.details.punches.map(punchKey));
    const nightKeys = new Set(nightRow.details.punches.map(punchKey));
    const overlap = [...dayKeys].filter(k => nightKeys.has(k));
    eq(fail, `${label}: no punch appears in both rows' details.punches`, overlap.length, 0);
    eq(fail, `${label}: day row keeps exactly its 2 own punches (07:00, 15:00)`, dayRow.details.punches.length, 2);
    truthy(fail, `${label}: 18:57 swipe belongs to the overnight window, not the day`, nightKeys.has(punchKey(swipe('11/09/2026', '90026', '18:57'))));
    truthy(fail, `${label}: 18:57 swipe is NOT claimed by the day row`, !dayKeys.has(punchKey(swipe('11/09/2026', '90026', '18:57'))));
    eq(fail, `${label}: day row has no false late-logout (on-time 07:00-15:00)`, dayRow.TAA_LATE_MIN, 0);
    eq(fail, `${label}: day row is a normal present day, not a fabricated action`, dayRow.TAA_ACTION, 'NO_ACTION');
    truthy(fail, `${label}: night row is not a false no-show`, nightRow.TAA_ACTION !== 'ABSENT_NS_NC' && nightRow.holdReason !== 'INSUFFICIENT_CMS_COVERAGE');
  };

  check(buildInputs('day-first'), 'day-first order');
  check(buildInputs('night-first'), 'night-first order (must attribute identically)');
});

// =====================================================================
// AL-07 — Irreducible punch-attribution tie is held
// =====================================================================
run('AL-07', 'Ambiguous punch attribution tie is held, never auto-decided', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000027', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000027')];
  // Two identical Cognos rows for the same login/day/window -> two windows tie exactly.
  const punches = [swipe('11/09/2026', '90027', '07:05'), swipe('11/09/2026', '90027', '15:00')];
  const cognos = [
    mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000027', 'LOGIN ID': '90027', DUTY1: '07:00 - 15:00' }),
    mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000027', 'LOGIN ID': '90027', DUTY1: '07:00 - 15:00' }),
  ];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  eq(fail, 'both tied rows resolved (not dropped)', out.rows.length, 2);
  const held = out.rows.some(r => r.holdReason === 'AMBIGUOUS_PUNCH_ATTRIBUTION' || r.holdReason === 'CONTESTED_SINGLE_PUNCH');
  truthy(fail, 'at least one row held for ambiguous/contested attribution', held);
  // Strengthened 2026-09-11: the doc's real concern is that NEITHER window is
  // silently auto-marked absent while the tie is unresolved — an ambiguous
  // attribution judgment must never cost anyone a day's pay.
  out.rows.forEach((r, i) => {
    truthy(fail, `row ${i}: no fabricated absence from the unresolved tie`, r.TAA_ACTION !== 'ABSENT_SEGMENT' && r.TAA_ACTION !== 'ABSENT_NS_NC');
  });
});

// =====================================================================
// AL-08 — Bare date timestamp means midnight
// =====================================================================
run('AL-08', 'Bare-date STOP_MOMENT parses as midnight, not missing', (fail) => {
  const segs: AspectSegment[] = [
    // Genuinely bare — no time component at all (strengthened 2026-09-11: this
    // previously supplied '12/09/2026 00:00:00', an already-explicit midnight
    // timestamp, which never exercised the "bare date means midnight" branch it
    // claimed to test). parseDateTimeString's DD/MM/YYYY regex has an optional
    // time group and defaults hours/mins/secs to 0 when it's absent.
    { EMP_ID: '7000028', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '11/09/2026 20:00:00', STOP_MOMENT: '12/09/2026', DURATION: 240 },
  ];
  const identities = [mkIdentity('7000028')];
  const punches = [swipe('11/09/2026', '90028', '20:00'), swipe('12/09/2026', '90028', '00:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000028', 'LOGIN ID': '90028', DUTY1: '20:00 - 00:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  truthy(fail, 'TAA_EFFECTIVE_END is 00:00 (midnight, not blank) — full date qualifier is expected/documented', row.TAA_EFFECTIVE_END.startsWith('00:00'));
  eq(fail, 'TAA_SCH_HOURS_RECOMPUTED', row.TAA_SCH_HOURS_RECOMPUTED, 240);
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'NO_ACTION_REQUIRED');
});

// =====================================================================
// AL-09 — Incomplete ASPECT timestamp locks the row
// =====================================================================
run('AL-09', 'Incomplete ASPECT timestamp forces INVALID_ASPECT_DATETIME', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000029', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00') },
  ];
  const identities = [mkIdentity('7000029')];
  const punches = [swipe('11/09/2026', '90029', '07:00'), swipe('11/09/2026', '90029', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000029', 'LOGIN ID': '90029' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'holdReason', row.holdReason, 'INVALID_ASPECT_DATETIME');
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'MANUAL_REVIEW_REQUIRED');
  eq(fail, 'includeInOutput', row.includeInOutput, false);
});

// =====================================================================
// AL-10 — Byte-identical ASPECT duplicate doesn't double-count hours
// =====================================================================
run('AL-10', 'Duplicate identical SHIFT rows do not double schedule hours', (fail) => {
  const segs: AspectSegment[] = [
    { PRI_INDEX: 1, EMP_ID: '7000030', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { PRI_INDEX: 1, EMP_ID: '7000030', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000030')];
  const punches = [swipe('11/09/2026', '90030', '07:00'), swipe('11/09/2026', '90030', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000030', 'LOGIN ID': '90030', 'SCH DURATION': '8:0' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_SCH_HOURS_RECOMPUTED stays 480 (not 960)', row.TAA_SCH_HOURS_RECOMPUTED, 480);
  // Strengthened 2026-09-11: the doc documents the action/category/comparison/CSV
  // shape too, not just the hours total.
  eq(fail, 'TAA_ACTION', row.TAA_ACTION, 'NO_ACTION');
  eq(fail, 'TAA_RESULT_CATEGORY', row.TAA_RESULT_CATEGORY, 'NO_ACTION_REQUIRED');
  const schDurationComp = row.columnComparisons.find(c => c.column === 'SCH DURATION');
  eq(fail, 'SCH DURATION compares MATCH (not inflated by the duplicate)', schDurationComp?.status, 'MATCH');
  const csvLines = out.aspectCorrectionsCsv.split('\n').filter(l => l.trim().length > 0);
  eq(fail, 'empty output, zero correction rows', csvLines.length, 0);
});

// =====================================================================
// AL-11 — Comparison tolerance boundary inclusive at 1 minute
// =====================================================================
run('AL-11', 'Comparison tolerance: 1m matches, 2m mismatches (circular)', (fail) => {
  const makeRow = (pf: string, cognosSigninIn: string) => {
    const segs: AspectSegment[] = [
      { EMP_ID: pf, NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    ];
    const identities = [mkIdentity(pf)];
    const punches = [swipe('11/09/2026', `L${pf}`, '07:01'), swipe('11/09/2026', `L${pf}`, '15:00')];
    const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': pf, 'LOGIN ID': `L${pf}`, 'SIGIN IN': cognosSigninIn, 'SIGIN OUT': '15:00' })];
    return runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, comparisonToleranceMinutes: 1 } }).rows[0];
  };
  const a = makeRow('7000031A', '07:00'); // diff = 1 -> MATCH
  const b = makeRow('7000031B', '06:59'); // diff = 2 -> MISMATCH
  const aComp = a.columnComparisons.find(c => c.column === 'SIGIN IN');
  const bComp = b.columnComparisons.find(c => c.column === 'SIGIN IN');
  eq(fail, 'subcase A (1m diff) status', aComp?.status, 'MATCH');
  eq(fail, 'subcase B (2m diff) status', bComp?.status, 'MISMATCH');
});

// =====================================================================
// AL-12 — Fill blank OT columns only, never overwrite populated Cognos
// =====================================================================
run('AL-12', 'Blank-fill OT1 only, never overwrite populated OT-2', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000032', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    { EMP_ID: '7000032', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT1', START_MOMENT: fdt('11/09/2026', '15:00'), STOP_MOMENT: fdt('11/09/2026', '16:00'), DURATION: 60 },
    { EMP_ID: '7000032', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT2', START_MOMENT: fdt('11/09/2026', '16:00'), STOP_MOMENT: fdt('11/09/2026', '18:00'), DURATION: 120 },
  ];
  const identities = [mkIdentity('7000032')];
  const punches = [swipe('11/09/2026', '90032', '07:00'), swipe('11/09/2026', '90032', '18:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000032', 'LOGIN ID': '90032', OT1: '', 'OT-2': '01:30' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, cognosBlankFillColumns: ['OT1', 'OT-2'] } });
  const row = out.rows[0];
  includes(fail, 'TAA_FILLED_COLUMNS includes OT1', row.TAA_FILLED_COLUMNS, 'OT1');
  const ot2Comp = row.columnComparisons.find(c => c.column === 'OT-2');
  eq(fail, 'OT-2 populated value untouched (still 01:30)', ot2Comp?.cognosRaw, '01:30');
  eq(fail, 'OT-2 compares MISMATCH (01:30 vs recomputed 02:00)', ot2Comp?.status, 'MISMATCH');
});

// =====================================================================
// AL-13 — Dynamic Cognos sentinel equals negative leave hours
// =====================================================================
run('AL-13', 'Dynamic sentinel detection beyond fixed [-480,-540] list', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000033', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'ANNUAL' },
  ];
  const identities = [mkIdentity('7000033')];
  const punches: CMSPunch[] = [];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000033', 'LOGIN ID': '90033', 'LEAVE HR': '10:00', 'LATE START': '-600', 'LEFT EARLY': '-600', 'LEAVE TYPE': 'ANNUAL' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, cognosSentinelDetectionMode: 'both' } });
  const row = out.rows[0];
  const lateStartComp = row.columnComparisons.find(c => c.column === 'LATE START');
  const leftEarlyComp = row.columnComparisons.find(c => c.column === 'LEFT EARLY');
  eq(fail, 'LATE START recognized as sentinel (NOT_COMPARABLE)', lateStartComp?.status, 'NOT_COMPARABLE');
  eq(fail, 'LEFT EARLY recognized as sentinel (NOT_COMPARABLE)', leftEarlyComp?.status, 'NOT_COMPARABLE');
});

// =====================================================================
// AL-14 — Cognos 00:00 duration: placeholder vs instantaneous swipes vs real failure
// =====================================================================
run('AL-14', 'SIGNIN DURATION=00:00 context determines MATCH vs MISMATCH vs NOT_COMPARABLE', (fail) => {
  // Subcase A (Phase 1, 2026-09-24, held-review reduction): real Cognos SIGIN IN/SIGIN OUT
  // hours apart, but the CMS evidence behind them is two INSTANTANEOUS swipe events (each
  // login==logout +/- seconds) — staffedMinutes ~= 0. All 21 real rows with Cognos 00:00
  // fit this shape; Cognos 00:00 correctly reports "no real logged-in duration" here, and
  // the SIGIN IN/SIGIN OUT gap is the first-to-last SPAN, not a session Cognos failed to
  // time — so this now downgrades to MATCH, not a genuine mismatch (see cognosComparison.ts).
  const segsA: AspectSegment[] = [{ EMP_ID: '7000034A', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 }];
  const identA = [mkIdentity('7000034A')];
  const punchA = [swipe('11/09/2026', 'LA', '07:09'), swipe('11/09/2026', 'LA', '15:10')];
  const cogA = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000034A', 'LOGIN ID': 'LA', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10' })];
  // Pinned on (Step 3 2026-09-24): this MISMATCH->MATCH downgrade is gated by
  // releaseProvenSafeHolds — pin true regardless of the ambient CFG's toggle state.
  const outA = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cogA, aspectSegments: segsA, aspectIdentities: identA, cmsPunches: punchA, config: { ...CFG, releaseProvenSafeHolds: true } });
  const compA = outA.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
  eq(fail, 'subcase A: instantaneous swipes -> SIGNIN DURATION MATCH', compA?.status, 'MATCH');

  // Subcase A2: same 00:00 + real timestamps, but the CMS evidence is a single CLOSED
  // punch spanning the whole shift (a real logged-in session, staffedMinutes large) ->
  // Cognos 00:00 is then a genuine calculation failure, unchanged from before Phase 1.
  const segsA2: AspectSegment[] = [{ EMP_ID: '7000034A2', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 }];
  const identA2 = [mkIdentity('7000034A2')];
  const punchA2 = [{ Date: '11/09/2026', LoginID: 'LA2', LoginDateTime: makeDt('11/09/2026', '07:09'), LogoutDateTime: makeDt('11/09/2026', '15:10') }];
  const cogA2 = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000034A2', 'LOGIN ID': 'LA2', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10' })];
  const outA2 = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cogA2, aspectSegments: segsA2, aspectIdentities: identA2, cmsPunches: punchA2, config: CFG });
  const compA2 = outA2.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
  eq(fail, 'subcase A2: real logged-in session -> SIGNIN DURATION genuinely MISMATCH', compA2?.status, 'MISMATCH');

  // Subcase B: no CMS at all, Cognos SIGIN IN/OUT also blank -> structural placeholder
  const segsB: AspectSegment[] = [{ EMP_ID: '7000034B', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 }];
  const identB = [mkIdentity('7000034B')];
  const cogB = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000034B', 'LOGIN ID': 'LB', 'SIGNIN DURATION': '00:00' })];
  const outB = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cogB, aspectSegments: segsB, aspectIdentities: identB, cmsPunches: [], config: CFG });
  const compB = outB.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
  eq(fail, 'subcase B: SIGNIN DURATION NOT_COMPARABLE (placeholder)', compB?.status, 'NOT_COMPARABLE');
});

// =====================================================================
// AL-15 — Specific leave code wins over generic container
// =====================================================================
run('AL-15', 'Specific ANNUAL wins over generic LEAVE container', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000035', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'LEAVE' },
    { EMP_ID: '7000035', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'ANNUAL' },
  ];
  const identities = [mkIdentity('7000035')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000035', 'LOGIN ID': '90035', 'LEAVE TYPE': 'Annual Leave' })];
  const cfg: ConfigRegistry = { ...CFG, cognosLeaveTypeMappings: [...CFG.cognosLeaveTypeMappings, { cognosLeaveType: 'Annual Leave', aspectSegmentCodes: ['ANNUAL'] }] };
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config: cfg });
  const row = out.rows[0];
  eq(fail, 'TAA_LEAVE_TYPE_RECOMPUTED is ANNUAL (specific wins)', row.TAA_LEAVE_TYPE_RECOMPUTED, 'ANNUAL');
  eq(fail, 'TAA_LEAVE_TYPE_STATUS MATCH via mapping', row.TAA_LEAVE_TYPE_STATUS, 'MATCH');
  eq(fail, 'TAA_LEAVE_TYPE_MATCH_BASIS MAPPED', row.TAA_LEAVE_TYPE_MATCH_BASIS, 'MAPPED');
});

// =====================================================================
// AL-16 — Schedule block-gap threshold is strict boundary
// (Rewritten 2026-09-21: two SHIFT segments are never merged — every SHIFT is its own Cognos
// duty — so the threshold's strict-< boundary is now proved on two OT1 segments after a SHIFT.)
// =====================================================================
run('AL-16', 'Block gap threshold uses strict < , not <=', (fail) => {
  const mk = (id: string, login: string, ot1bStart: string, ot1bStop: string, ot1bDur: number) => {
    const segs: AspectSegment[] = [
      { EMP_ID: id, NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '11:00'), DURATION: 240 },
      { EMP_ID: id, NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT1', START_MOMENT: fdt('11/09/2026', '11:00'), STOP_MOMENT: fdt('11/09/2026', '13:00'), DURATION: 120 },
      { EMP_ID: id, NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'OT1', START_MOMENT: fdt('11/09/2026', ot1bStart), STOP_MOMENT: fdt('11/09/2026', ot1bStop), DURATION: ot1bDur },
    ];
    const cog = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': id, 'LOGIN ID': login, DUTY1: '07:00 - 11:00' })];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cog, aspectSegments: segs, aspectIdentities: [mkIdentity(id)], cmsPunches: [swipe('11/09/2026', login, '07:00'), swipe('11/09/2026', login, ot1bStop)], config: { ...CFG, perBlockGapThresholdMinutes: 60 } });
    return out.rows[0].columnComparisons;
  };
  // Subcase A: OT1 gap = 59m -> the two OT1 segments merge into ONE OT block 11:00-15:59.
  const compA = mk('7000036A', 'LA36', '13:59', '15:59', 120);
  // Subcase B: OT1 gap = 60m exactly -> stays split into two OT blocks (unmodeled shape, DUTY-2 left blank).
  const compB = mk('7000036B', 'LB36', '14:00', '16:00', 120);
  const duty2A = compA.find(c => c.column === 'DUTY-2');
  const ot1A = compA.find(c => c.column === 'OT1');
  const duty2B = compB.find(c => c.column === 'DUTY-2');
  const ot1B = compB.find(c => c.column === 'OT1');
  eq(fail, 'A (59m gap) merges the OT1 rows into one block: OT1 shows the single window', ot1A?.recomputedRaw, '11:00 - 15:59');
  eq(fail, 'A: DUTY-2 is that merged OT block', duty2A?.recomputedRaw, '11:00 - 15:59');
  eq(fail, 'B (60m gap) stays two OT blocks: OT1 falls back to the summed duration', ot1B?.recomputedRaw, '04:00');
  eq(fail, 'B: DUTY-2 is left blank (two OT blocks = unmodeled shape, never guessed)', duty2B?.recomputedRaw, '');
});

// =====================================================================
// AL-17 — ASPECT CSV writer enforces exact wire format and escaping
// =====================================================================
run('AL-17', 'ASPECT correction CSV writer: format, escaping, de-dup', (fail) => {
  const row1: AspectCorrectionRow = { Code: '00', ID: '7000037', SegmentCode: 'Absent NS/NC', nominateDate: '11/09/2026', SegmentDate: '', SegmentStarttime: '', Segmentduration: '', Memo: 'Reason, says "review"' };
  const row2: AspectCorrectionRow = { ...row1 };
  const csv = generateAspectCorrectionsCsv([row1, row2]);
  const lines = csv.split('\n');
  eq(fail, 'no header line — data rows only', lines.length, 1);
  const dataLine = lines[0];
  truthy(fail, 'line ends with trailing comma', dataLine.endsWith(','));
  includes(fail, 'SegmentCode with spaces is quoted', dataLine, '"Absent NS/NC"');
  includes(fail, 'Memo quoted with doubled inner quotes', dataLine, '"Reason, says ""review"""');
  includes(fail, 'Code stays string 00', dataLine, '00,');
});

// =====================================================================
// AL-18 — Annotated Cognos output blocks formula injection; ASPECT CSV untouched
// =====================================================================
run('AL-18', 'Formula-injection escaping differs by output type', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000038', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000038')];
  const punches = [swipe('11/09/2026', '90038', '07:06'), swipe('11/09/2026', '90038', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000038', 'LOGIN ID': '90038', NAME: '=HYPERLINK("bad")' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  includes(fail, 'annotated CSV escapes NAME with leading apostrophe', out.annotatedCognosCsv, "'=HYPERLINK");

  const correctionRow: AspectCorrectionRow = { Code: '00', ID: '7000038', SegmentCode: 'LATE', nominateDate: '11/09/2026', SegmentDate: '11/09/2026', SegmentStarttime: '07:00', Segmentduration: '00:06', Memo: '=review' };
  const aspectCsv = generateAspectCorrectionsCsv([correctionRow]);
  includes(fail, 'ASPECT CSV Memo stays exactly "=review" (quoted, no apostrophe)', aspectCsv, '"=review"');
  eq(fail, 'ASPECT CSV must NOT contain the escaped apostrophe form', aspectCsv.includes("'=review"), false);
});

// =====================================================================
// AL-19 — Mismatch approval gates correction output and records override
// =====================================================================
run('AL-19', 'Mismatch holds output; forced hold never releasable the same way', (fail) => {
  const segs: AspectSegment[] = [
    { EMP_ID: '7000039', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000039')];
  const punches = [swipe('11/09/2026', '90039', '07:06'), swipe('11/09/2026', '90039', '15:00')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000039', 'LOGIN ID': '90039', 'SIGIN IN': '07:20', 'SIGIN OUT': '15:00' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_LATE_MIN still computed (6m)', row.TAA_LATE_MIN, 6);
  eq(fail, 'holdReason MISMATCH_FOUND', row.holdReason, 'MISMATCH_FOUND');
  eq(fail, 'includeInOutput FALSE before approval', row.includeInOutput, false);
  // out.aspectCorrections is an UNFILTERED preview (every row's proposed
  // correction, held or not) — the real export gate is aspectCorrectionsCsv,
  // built from rows.filter(r => r.includeInOutput) inside runReconciliation.
  const csvDataLines = out.aspectCorrectionsCsv.split('\n').filter(l => l.trim().length > 0);
  eq(fail, 'zero correction rows in the actual exported CSV before approval', csvDataLines.length, 0);

  // Strengthened 2026-09-11: exercise the actual approval TRANSITION, not just the
  // initial held state. Mirrors App.tsx's handleToggleInclude exactly (a deliberate
  // copy, not a refactor into shared code — this codebase's own convention, per
  // featureCompletion.test.ts's comment about buildResultsWorkbookSheets, is to keep
  // an independent copy of a UI predicate in tests as a drift guard) so this proves
  // the real approval code path, not an invented one:
  //   rows.map(r => r.id === rowId && !isForcedHoldReason(r.holdReason)
  //     ? {...r, includeInOutput: true, includeDecisionSource: 'user'} : r)
  //   generateAspectCorrectionsCsv(rows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections))
  const approve = (rows: typeof out.rows, rowId: string) =>
    rows.map(r => (r.id === rowId && !isForcedHoldReason(r.holdReason)
      ? { ...r, includeInOutput: true, includeDecisionSource: 'user' as const }
      : r));
  const rowsAfterApproval = approve(out.rows, row.id);
  const approvedRow = rowsAfterApproval.find(r => r.id === row.id)!;
  eq(fail, 'includeInOutput flips to TRUE after approval', approvedRow.includeInOutput, true);
  eq(fail, 'includeDecisionSource records the user override', approvedRow.includeDecisionSource, 'user');
  const csvAfterApproval = generateAspectCorrectionsCsv(rowsAfterApproval.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  const approvedCsvLines = csvAfterApproval.split('\n').filter(l => l.trim().length > 0);
  eq(fail, 'LATE + COVER rows appear in the export after approval', approvedCsvLines.length, 2);
  truthy(fail, 'the approved CSV actually contains a LATE row', approvedCsvLines.some(l => l.includes(',LATE,')));
  truthy(fail, 'the approved CSV actually contains a COVER row', approvedCsvLines.some(l => l.includes(',COVER,')));
  eq(fail, 'mismatch evidence is preserved after approval (not erased)', approvedRow.holdReason, 'MISMATCH_FOUND');
  eq(fail, 'the mismatch column is still reported', approvedRow.TAA_MISMATCH_COLUMNS.includes('SIGIN IN'), true);

  // INVALID_ASPECT_DATETIME must NOT be releasable through the same toggle — the
  // guard lives in the data model itself (isForcedHoldReason), not just in a UI
  // disabled-checkbox that a determined caller could bypass.
  const invalidSegs: AspectSegment[] = [
    { EMP_ID: '7000029', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00') },
  ];
  const invalidPunches = [swipe('11/09/2026', '90029', '07:00'), swipe('11/09/2026', '90029', '15:00')];
  const invalidCognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000029', 'LOGIN ID': '90029' })];
  const invalidOut = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: invalidCognos, aspectSegments: invalidSegs, aspectIdentities: [mkIdentity('7000029')], cmsPunches: invalidPunches, config: CFG });
  const invalidRow = invalidOut.rows[0];
  eq(fail, 'control: INVALID_ASPECT_DATETIME is the hold on this row', invalidRow.holdReason, 'INVALID_ASPECT_DATETIME');
  const rowsAfterAttemptedApproval = approve(invalidOut.rows, invalidRow.id);
  const stillHeldRow = rowsAfterAttemptedApproval.find(r => r.id === invalidRow.id)!;
  eq(fail, 'the SAME toggle path refuses to release a forced hold', stillHeldRow.includeInOutput, false);
  eq(fail, 'includeDecisionSource stays auto (never laundered to user)', stillHeldRow.includeDecisionSource, 'auto');
  truthy(fail, 'MISMATCH_FOUND is reviewer-releasable (not forced)', !isForcedHoldReason('MISMATCH_FOUND'));
  truthy(fail, 'INVALID_ASPECT_DATETIME is a forced (non-releasable) hold', isForcedHoldReason('INVALID_ASPECT_DATETIME'));
});

// =====================================================================
// AL-20 — Cover placement fallback is explicit
// =====================================================================
run('AL-20', 'Cover fallback: nextWeekMonday vs sameDay, explicit note', (fail) => {
  const makeInput = (fallback: 'nextWeekMonday' | 'sameDay') => {
    const segs: AspectSegment[] = [
      { EMP_ID: '7000040', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
    ];
    const identities = [mkIdentity('7000040')];
    const punches = [swipe('11/09/2026', '90040', '07:08'), swipe('11/09/2026', '90040', '15:00')];
    const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000040', 'LOGIN ID': '90040', 'SIGIN IN': '07:08', 'SIGIN OUT': '15:00' })];
    return runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...CFG, coverFallbackWhenNoWorkingDayFound: fallback, coverFallbackDefaultTime: '08:00' } });
  };
  const outA = makeInput('nextWeekMonday');
  const coverA = outA.aspectCorrections.find(c => c.ID === '7000040' && c.SegmentCode === 'COVER');
  truthy(fail, 'subcase A: cover row exists', coverA);
  if (coverA) {
    eq(fail, 'A nominateDate = 14/09/2026 (next Monday)', coverA.nominateDate, '14/09/2026');
    eq(fail, 'A SegmentDate = 14/09/2026', coverA.SegmentDate, '14/09/2026');
    eq(fail, 'A start = 08:00', coverA.SegmentStarttime, '08:00');
    truthy(fail, 'A memo names the fallback', coverA.Memo && /fallback|monday|next week/i.test(coverA.Memo));
  }
  const outB = makeInput('sameDay');
  const coverB = outB.aspectCorrections.find(c => c.ID === '7000040' && c.SegmentCode === 'COVER');
  truthy(fail, 'subcase B: cover row exists', coverB);
  if (coverB) {
    eq(fail, 'B nominateDate = 11/09/2026 (incident day)', coverB.nominateDate, '11/09/2026');
    eq(fail, 'B SegmentDate = 11/09/2026', coverB.SegmentDate, '11/09/2026');
    eq(fail, 'B start = 15:00 (after last incident-day segment)', coverB.SegmentStarttime, '15:00');
  }
});

// =====================================================================
// AL-21 — Literal "0" Logout Time (still clocked in) held, not file-rejected
// =====================================================================
run('AL-21', 'Open-logout ("0") row held for review, file not rejected', (fail) => {
  const cmsText = [
    'EIM Agent Monthly Attendance Report',
    'Agent:,Test_90041',
    'Date,Login ID,Login Time,Logout Time,Login Time,Logout Time',
    '11/09/2026,90041,08:00,0,11/09/2026 08:00:00,',
    '11/09/2026,90042,07:00,15:00,11/09/2026 07:00:00,11/09/2026 15:00:00',
    '11/09/2026,90043,23:00,00:00,11/09/2026 23:00:00,12/09/2026 00:00:00',
  ].join('\n');

  const validation = validateCmsFile(cmsText, 'test.csv');
  truthy(fail, 'file accepted, not rejected (literal "0" row present)', validation.ok);
  if (!validation.ok) return;
  eq(fail, 'all 3 rows produced punches (none silently dropped)', validation.punches.length, 3);

  const openPunch = validation.punches.find(p => p.LoginID === '90041');
  truthy(fail, '"0" row parsed: login recorded', openPunch && openPunch.LoginDateTime);
  truthy(fail, '"0" row: LogoutDateTime is null (never guessed)', openPunch !== undefined && openPunch.LogoutDateTime === null);
  eq(fail, '"0" row: stillClockedIn flag set', !!openPunch?.stillClockedIn, true);

  const closedPunch = validation.punches.find(p => p.LoginID === '90042');
  truthy(fail, 'ordinary row: LogoutDateTime is a real Date', closedPunch?.LogoutDateTime instanceof Date);
  eq(fail, 'ordinary row: stillClockedIn not set', !!closedPunch?.stillClockedIn, false);

  const crossMidnightPunch = validation.punches.find(p => p.LoginID === '90043');
  truthy(fail, '00:00 cross-midnight row: NOT treated as still-clocked-in', crossMidnightPunch?.LogoutDateTime instanceof Date && !crossMidnightPunch?.stillClockedIn);
  if (crossMidnightPunch?.LogoutDateTime) {
    eq(fail, '00:00 cross-midnight row: logout lands on 12/09 (next day)', crossMidnightPunch.LogoutDateTime.getDate(), 12);
  }

  // Now run it through the real engine: the open punch, once attributed to a
  // scheduled window, must force STILL_CLOCKED_IN — never a computed duration,
  // never a crash on the null LogoutDateTime.
  const segs: AspectSegment[] = [
    { EMP_ID: '7000041', NOM_DATE: '11/09/2026', START_DATE: '11/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: fdt('11/09/2026', '07:00'), STOP_MOMENT: fdt('11/09/2026', '15:00'), DURATION: 480 },
  ];
  const identities = [mkIdentity('7000041')];
  const cognos = [mkCognos({ 'SIGN IN DATE': '11/09/2026', 'PF NO': '7000041', 'LOGIN ID': '90041' })];
  const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognos, aspectSegments: segs, aspectIdentities: identities, cmsPunches: validation.punches, config: CFG });
  const row = out.rows[0];
  eq(fail, 'TAA_VERDICT is STILL_CLOCKED_IN', row.TAA_VERDICT, 'STILL_CLOCKED_IN');
  eq(fail, 'TAA_ACTION is MANUAL_REVIEW_REQUIRED (never a guessed duration)', row.TAA_ACTION, 'MANUAL_REVIEW_REQUIRED');
  eq(fail, 'TAA_RESULT_CATEGORY is COGNOS_DATA_GAP', row.TAA_RESULT_CATEGORY, 'COGNOS_DATA_GAP');
  eq(fail, 'holdReason is STILL_CLOCKED_IN (forced, never auto-releasable)', row.holdReason, 'STILL_CLOCKED_IN');
  eq(fail, 'includeInOutput is false', row.includeInOutput, false);
});

// =====================================================================
// Report
// =====================================================================
const passed = allResults.filter(r => r.passed);
const failed = allResults.filter(r => !r.passed);

console.log('\n=== TAA 40-Scenario Validation Report ===\n');
allResults.forEach(r => {
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
  if (!r.passed) {
    r.failures.forEach(f => console.log(`      - ${f}`));
  }
});
console.log(`\n${passed.length}/${allResults.length} passed, ${failed.length} failed.\n`);

// Machine-readable dump for the report-writing step.
fs.writeFileSync(
  path.join(process.cwd(), 'scripts', 'validate40-results.json'),
  JSON.stringify(allResults, null, 2)
);

if (failed.length > 0) process.exitCode = 1;
