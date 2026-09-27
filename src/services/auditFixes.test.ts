import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfigForRun } from './configRegistry';
import { recomputeDaySchedule } from './scheduleRecompute';
import { runReconciliation, resolveNoLoginDecision, flexLateBandFires, isFlexScheduleWithinExpectedWindow, ReconciliationInput, lookupPolicyRule } from './reconciliationEngine';
import { runUnseenPunchAudit } from './unseenPunchAudit';
import { SUITE_RUN_DATE } from './regressionSuite';
import { simulateScenario } from './scenarioGuide';
import { isForcedHoldReason } from './holdReasons';
import { assessHeadcountMapping } from './punchAttribution';
import { AspectSegment, AspectIdentity, CMSPunch, CognosRecord, ColumnComparison, ConfigRegistry, PolicyRuleItem, RoleTier } from '../types/taa';
import { parseDateTimeString } from './parsers';
import { compareCognosRow, ComparisonContext } from './cognosComparison';

// -----------------------------------------------------------------------
// Regression coverage for the 2026-09-14 audit remediation pass. Each block
// targets one confirmed defect and its fix — see the change manifest / audit
// report for the full file:line citations. Follows this repo's headless
// tsx + node:assert convention (no framework): any failed assertion throws
// and the script exits non-zero.
// -----------------------------------------------------------------------

const D = '27/08/2026';
const dt = (s: string) => parseDateTimeString(s)!;

const seg = (o: Partial<AspectSegment> & { SEG_CODE: string }): AspectSegment =>
  ({ EMP_ID: '900001', NOM_DATE: D, START_DATE: D, ...o } as AspectSegment);

const identity = (o: Partial<AspectIdentity> & { EMP_ID: string }): AspectIdentity =>
  ({ EMP_LAST_NAME: 'Test Agent', EMP_SORT_NAME: 'Test Agent', EMP_SHORT_NAME: 'Test Agent', ...o } as AspectIdentity);

const punch = (id: string, inS: string, outS: string): CMSPunch =>
  ({ Date: D, LoginID: id, LoginDateTime: dt(inS), LogoutDateTime: dt(outS) });

const cognosRow = (o: Partial<CognosRecord>): CognosRecord => ({
  'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '900001', NAME: 'Test Agent',
  'LOGIN ID': '55501', DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '',
  'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '',
  'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '', ...o,
} as CognosRecord);

const run = (segments: AspectSegment[], punches: CMSPunch[], cognos: Partial<CognosRecord>, identities?: AspectIdentity[], config: ConfigRegistry = DEFAULT_CONFIG) =>
  runReconciliation({ processingDate: SUITE_RUN_DATE,
    cognosRecords: [cognosRow(cognos)], aspectSegments: segments,
    aspectIdentities: identities || [identity({ EMP_ID: '900001' })], cmsPunches: punches, config,
  });

// ---------------------------------------------------------------------------
// Fix D1 — negative netScheduledMinutes is clamped to 0 and flagged, never
// exported as a negative paid-hours total (480-minute shift, 600-minute
// duration-only trailing release).
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', DURATION: 600 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 0, 'must clamp to 0, never report negative');
  assert.equal(rec.negativeNetScheduleMinutes, true, 'must flag that the raw arithmetic went negative');

  const out = run(segments, [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 15:00:00`, `${D} 15:00:03`)], {});
  assert.equal(out.rows[0].holdReason, 'NEGATIVE_NET_SCHEDULE_MINUTES', 'row must be held, not silently exported with a floored total');
  assert.equal(isForcedHoldReason(out.rows[0].holdReason), true, 'a schedule-arithmetic integrity problem must be a forced (non-overridable) hold');
}

// ---------------------------------------------------------------------------
// Fix D2 — TAA_OT1/TAA_OT2 must not double-count a byte-identical duplicate
// OT1 row (net schedule already deduped it; OT1/OT2 minutes previously summed
// the raw, un-deduped segment list).
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.ot1Minutes, 120, 'duplicate OT1 row must not double TAA_OT1');
  assert.equal(rec.netScheduledMinutes, 600, '480 + 120, not 480 + 240');
}

// ---------------------------------------------------------------------------
// Fix D3 — duplicate detection must not be blind to date-format differences:
// the same SHIFT written as DD/MM/YYYY and YYYY-MM-DD must still collapse to
// one segment.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: '2026-08-27 07:00:00', STOP_MOMENT: '2026-08-27 15:00:00', DURATION: 480 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.additionSegments.length, 1, 'semantically identical segments in different date formats must dedupe');
  assert.equal(rec.netScheduledMinutes, 480, 'must not double-pay for the same shift written twice');
}

// ---------------------------------------------------------------------------
// Fix D4 — proximity tolerance must clip the subtracted interval to the true
// scheduled boundary, never subtract minutes lying outside it. A release
// stopping 1 minute past rawEnd (within the 2-minute default tolerance)
// still classifies TRAILING, but only the 60 minutes inside [14:00,15:00]
// may be subtracted — not the full 61-minute raw span to 15:01.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 14:00:00`, STOP_MOMENT: `${D} 15:01:00` }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 420, '480 - 60 (clipped to rawEnd), not 480 - 61 (the removal\'s own overrun span)');
}

// ---------------------------------------------------------------------------
// Fix D5 — two or more duration-only removals (no timestamps on ANY of them)
// in the same trailing group must be flagged ambiguous, not silently summed.
// The original R5 fix only covered a duration-only removal beside a
// TIMESTAMPED one; two duration-only removals together were unflagged.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', DURATION: 30 }),
    seg({ SEG_CODE: 'UN_RLS', DURATION: 20 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.ambiguousOverlappingRemovalSegments.length, 2, 'both duration-only removals must be flagged ambiguous');
}

// ---------------------------------------------------------------------------
// Fix D6 (new) — two DIFFERENT, genuinely overlapping ADDITION segments (two
// distinct COVER rows) must be flagged, not summed unconditionally.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 18:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 17:00:00`, STOP_MOMENT: `${D} 19:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.ambiguousOverlappingAdditionSegments.length, 2, 'two overlapping (non-identical) COVER rows must both be flagged');

  const out = run(segments, [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 19:00:00`, `${D} 19:00:03`)], {});
  assert.equal(out.rows[0].holdReason, 'AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS');
  // Post-audit correction: this is a scheduling-judgement call, NOT missing or
  // self-contradictory evidence — it must stay reviewer-releasable. Locking it
  // stranded a day's real corrections with no path to export them.
  assert.equal(isForcedHoldReason(out.rows[0].holdReason), false, 'must be reviewer-releasable, never a forced lock');

  // Sanity: OT1 starting the instant SHIFT ends (touching, not overlapping)
  // must NOT be flagged — the normal, universal 0-minute-gap shape.
  const touching = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
  ];
  assert.equal(recomputeDaySchedule(touching, DEFAULT_CONFIG).ambiguousOverlappingAdditionSegments.length, 0, 'touching, non-overlapping additions must not be flagged');

  // Post-audit correction: a COVER nested INSIDE a shift is the routine shape the
  // hours formula already models (and is present in the bundled sample dataset,
  // employee 600043) — flagging it withheld that day's real LATE/COVER corrections.
  const coverInsideShift = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 15:12:00`, DURATION: 12 }),
  ];
  const recCover = recomputeDaySchedule(coverInsideShift, DEFAULT_CONFIG);
  assert.equal(recCover.ambiguousOverlappingAdditionSegments.length, 0, 'a COVER inside a SHIFT is routine, never an ambiguous overlap');
  assert.equal(recCover.netScheduledMinutes, 492, 'and it still adds its minutes per the documented hours formula');
  const outCover = run(coverInsideShift, [punch('55501', `${D} 08:20:00`, `${D} 08:20:03`), punch('55501', `${D} 16:00:00`, `${D} 16:00:03`)], { DUTY1: '08:00 - 16:00', 'SIGIN IN': '08:20', 'SIGIN OUT': '16:00' });
  assert.ok(outCover.rows[0].details.generatedCorrections.length > 0, 'a genuinely late arrival on such a day must still produce corrections');
  assert.ok(outCover.aspectCorrectionsCsv.includes('LATE'), 'and they must reach the exported ASPECT correction CSV');
}

// ---------------------------------------------------------------------------
// Post-audit correction: hold-cascade ordering. A SOFT hold must never pre-empt
// a FORCED one — DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS previously sat above
// AMBIGUOUS_PUNCH_ATTRIBUTION, so a row carrying both reported the releasable
// reason and became tickable into the payroll CSV.
// ---------------------------------------------------------------------------
{
  const tieDay = '11/09/2026';
  const tieSeg = (o: Partial<AspectSegment> & { SEG_CODE: string }): AspectSegment =>
    ({ EMP_ID: '7000027', NOM_DATE: tieDay, START_DATE: tieDay, ...o } as AspectSegment);
  const tiePunch = (t: string): CMSPunch =>
    ({ Date: tieDay, LoginID: '90027', LoginDateTime: dt(`${tieDay} ${t}`), LogoutDateTime: dt(`${tieDay} ${t}`) });
  // Two identical Cognos rows tie for the same punches (the AL-07 recipe) AND the
  // shift carries a malformed DURATION cell, so both conditions land on one row.
  const tieCognos = [
    cognosRow({ 'SIGN IN DATE': tieDay, 'PF NO': '7000027', 'LOGIN ID': '90027', DUTY1: '07:00 - 15:00' }),
    cognosRow({ 'SIGN IN DATE': tieDay, 'PF NO': '7000027', 'LOGIN ID': '90027', DUTY1: '07:00 - 15:00' }),
  ];
  const withMalformed = runReconciliation({ processingDate: SUITE_RUN_DATE,
    cognosRecords: tieCognos,
    aspectSegments: [tieSeg({ SEG_CODE: 'SHIFT', START_MOMENT: `${tieDay} 07:00:00`, STOP_MOMENT: `${tieDay} 15:00:00`, DURATION_TEXT_MALFORMED: true })],
    aspectIdentities: [identity({ EMP_ID: '7000027' })],
    cmsPunches: [tiePunch('07:05:00'), tiePunch('15:00:00')],
    config: DEFAULT_CONFIG,
  });
  withMalformed.rows.forEach(r => {
    assert.notEqual(
      r.holdReason, 'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS',
      'the soft duration-repair hold must never win over a forced hold on the same row',
    );
    assert.equal(isForcedHoldReason(r.holdReason), true, 'both tied rows must keep their forced attribution hold');
  });
}

// ---------------------------------------------------------------------------
// Post-audit correction: the proximity clip must keep the documented
// `raw − release − nursing − otInternal = net` reconciliation balancing.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 14:00:00`, STOP_MOMENT: `${D} 15:01:00` }), // stops 1m past rawEnd
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 420, 'only the 60 minutes inside the window may be subtracted');
  assert.equal(
    480 - rec.releaseMinutes - rec.nursingMinutes - rec.otInternalRemovalMinutes,
    rec.netScheduledMinutes,
    'reported deductions must reconcile exactly to netScheduledMinutes',
  );
}

// ---------------------------------------------------------------------------
// Post-audit correction: a blocking policy-band issue must not be reported as an
// invalid CLOCK value ("fix it to a valid HH:MM"), which sent the user hunting a
// field that was never wrong.
// ---------------------------------------------------------------------------
{
  const overlapping = DEFAULT_CONFIG.policyRules.map(r =>
    r.id === 'rule-late-ops-band2' ? { ...r, minMinutes: 30 } : r);
  const out = run(
    [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })],
    [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 15:00:00`, `${D} 15:00:03`)],
    {}, undefined, { ...DEFAULT_CONFIG, policyRules: overlapping },
  );
  assert.equal(out.rows[0].holdReason, 'INVALID_CONFIG_VALUE', 'a band overlap is a value problem, not a clock problem');
  assert.ok((out.rows[0].details.ruleFired || '').includes('both cover minute'), 'and the specific band message must still reach the row trace');
}

// ---------------------------------------------------------------------------
// Fix E — a generated SHIFT->OT2 ("10"/"11") or OT->SHIFT conversion row must
// derive Segmentduration from timestamps when the raw DURATION field is
// null, never leave it blank when a real duration is computable.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'P/H-LV', START_MOMENT: `${D} 00:00:00`, STOP_MOMENT: `${D} 00:00:00` }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00` }), // DURATION intentionally omitted
  ];
  const out = run(segments, [], { 'LEAVE TYPE': 'P/H-LV' });
  const row = out.rows[0];
  const shiftReplacementRows = row.details.generatedCorrections.filter(c => c.SegmentCode === 'SHIFT' || c.SegmentCode === DEFAULT_CONFIG.shiftToOt2ConversionCode);
  assert.ok(shiftReplacementRows.length >= 2, 'expected the "10"/"11" replacement pair to be generated');
  shiftReplacementRows.forEach(c => {
    assert.notEqual(c.Segmentduration, '', `generated correction row must not have a blank duration when timestamps give 480m: ${JSON.stringify(c)}`);
  });
}

// ---------------------------------------------------------------------------
// Fix E (malformed-duration soft hold) — a segment with a non-blank but
// malformed DURATION cell (rejected by the F13 parser fix) and valid
// timestamps must surface DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS — a soft,
// reviewer-releasable signal, not silently indistinguishable from a clean
// duration.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION_TEXT_MALFORMED: true }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.malformedDurationRepairedSegments.length, 1);

  const out = run(segments, [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 15:00:00`, `${D} 15:00:03`)], {});
  assert.equal(out.rows[0].holdReason, 'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS');
  assert.equal(isForcedHoldReason(out.rows[0].holdReason), false, 'must be soft/reviewer-releasable, not a forced hold');
}

// ---------------------------------------------------------------------------
// Fix F — TAA_COGNOS_AGREE forced to false by the legacy DEFECT_1_RELEASE_
// IGNORED diagnosis (with zero real column mismatch) must be held, not
// silently auto-included just because mismatchColumns was empty — UNLESS
// arithmetic proves TAA is correct: Cognos's claimed LEFT EARLY is fully
// explained by the trailing release/nursing minutes it ignored (within
// config.comparisonToleranceMinutes). Reporting (TAA_DISAGREE_REASON,
// TAA_COGNOS_AGREE=false) is unchanged either way — only the hold differs.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 14:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 60 }),
  ];
  const punches = [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 14:13:00`, `${D} 14:13:03`)];

  // Cognos's claimed early (47m) <= the 60m nursing deduction TAA already applied — the
  // deduction fully explains it, so this must now be auto-exempted (released), not held.
  const cognosExplained = cognosRow({
    // SCH DURATION 7:0: Cognos deducts the nursing hour (its own REMARK says -60), and the
    // comparison is release-adjusted, so no column disagrees — only the legacy diagnosis does.
    DUTY1: '07:00 - 15:00', 'SCH DURATION': '7:0', 'SIGNIN DURATION': '07:13',
    'SIGIN IN': '07:00', 'SIGIN OUT': '14:13', 'LEFT EARLY': '-47',
    REMARK: 'NURSNG:14:00 - 15:00( -60 Minutes) :',
  });
  const outExplained = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosExplained], aspectSegments: segments, aspectIdentities: [identity({ EMP_ID: '900001' })], cmsPunches: punches, config: DEFAULT_CONFIG });
  const rowExplained = outExplained.rows[0];
  assert.equal(rowExplained.TAA_DISAGREE_REASON, 'DEFECT_1_RELEASE_IGNORED');
  assert.equal(rowExplained.TAA_COGNOS_AGREE, false);
  assert.equal(rowExplained.TAA_MISMATCH_COUNT, 0, 'the formal column comparison finds no mismatch — the disagreement is legacy-diagnosis-only');
  assert.notEqual(rowExplained.holdReason, 'MISMATCH_FOUND', '47m claimed early <= 60m nursing deduction — arithmetic proves TAA correct, must not be held');
  assert.equal(rowExplained.includeInOutput, true);

  // Same shape, but Cognos claims far more early (200m) than the 60m deduction can explain.
  // Note the claimed 200m also no longer matches Cognos's OWN raw-window arithmetic (rawEnd
  // 15:00 minus the actual 14:13 logout is 47m, not 200m) — so this is held for two
  // independent, compounding reasons: (1) the arithmetic gate does not exempt it (200 > 60m
  // deduction + tol), and (2) the formal LEFT EARLY column comparison itself now finds a
  // real disagreement (both sides report "left early", but by very different amounts).
  // Both are real, unrelated-to-config holds, so the override allowlist correctly cannot
  // rescue this row either — it only ever bypasses reason (1), never a genuine (2).
  const cognosUnexplained = cognosRow({
    DUTY1: '07:00 - 15:00', 'SCH DURATION': '7:0', 'SIGNIN DURATION': '07:13',
    'SIGIN IN': '07:00', 'SIGIN OUT': '14:13', 'LEFT EARLY': '-200',
    REMARK: 'NURSNG:14:00 - 15:00( -60 Minutes) :',
  });
  const outUnexplained = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosUnexplained], aspectSegments: segments, aspectIdentities: [identity({ EMP_ID: '900001' })], cmsPunches: punches, config: DEFAULT_CONFIG });
  const rowUnexplained = outUnexplained.rows[0];
  assert.equal(rowUnexplained.TAA_DISAGREE_REASON, 'DEFECT_1_RELEASE_IGNORED');
  assert.equal(rowUnexplained.TAA_COGNOS_AGREE, false);
  assert.equal(rowUnexplained.holdReason, 'MISMATCH_FOUND', '200m claimed early far exceeds the 60m deduction — must still be held');
  assert.equal(rowUnexplained.includeInOutput, false);

  // The exception allowlist still exempts the "no real column mismatch" shape from Fix F's
  // original fixture (kept as its own case): with the new arithmetic gate this row is
  // released by default already (47m <= 60m), but the explicitly configured exception path
  // must remain functional and non-regressive on it.
  const exemptConfig = { ...DEFAULT_CONFIG, cognosAgreeOverrideExceptions: ['DEFECT_1_RELEASE_IGNORED'] };
  const outExempt = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosExplained], aspectSegments: segments, aspectIdentities: [identity({ EMP_ID: '900001' })], cmsPunches: punches, config: exemptConfig });
  assert.notEqual(outExempt.rows[0].holdReason, 'MISMATCH_FOUND', 'an explicitly configured exception must be honored');
}

// ---------------------------------------------------------------------------
// Fix G — conflicting duplicate Identity Master rows for the same EMP_ID must
// hold every row for that employee, not silently take the last record.
// ---------------------------------------------------------------------------
{
  const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
  const conflictingIdentities = [
    identity({ EMP_ID: '900001', EMP_LAST_NAME: 'First Record' }),
    identity({ EMP_ID: '900001', EMP_LAST_NAME: 'Second Record (conflicting)' }),
  ];
  const out = run(segments, [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 15:00:00`, `${D} 15:00:03`)], {}, conflictingIdentities);
  assert.equal(out.rows[0].holdReason, 'CONFLICTING_IDENTITY_RECORD');
  assert.equal(isForcedHoldReason(out.rows[0].holdReason), true);

  // Byte-identical duplicates (a harmless re-imported copy) must NOT be flagged.
  const identicalIdentities = [
    identity({ EMP_ID: '900001', EMP_LAST_NAME: 'Same Record' }),
    identity({ EMP_ID: '900001', EMP_LAST_NAME: 'Same Record' }),
  ];
  const outIdentical = run(segments, [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 15:00:00`, `${D} 15:00:03`)], {}, identicalIdentities);
  assert.notEqual(outIdentical.rows[0].holdReason, 'CONFLICTING_IDENTITY_RECORD');
}

// ---------------------------------------------------------------------------
// Fix C — headcount threshold comparison must use the unrounded percentage.
// 5 of 8 employees have ASPECT evidence = 62.5%, which rounds to 63% and
// would incorrectly pass a 63% minimum under the old rounded comparison.
// ---------------------------------------------------------------------------
{
  const cognosRecords: CognosRecord[] = Array.from({ length: 8 }, (_, i) => cognosRow({ 'PF NO': `emp-${i}`, 'LOGIN ID': `login-${i}` }));
  const aspectIdentities: AspectIdentity[] = Array.from({ length: 5 }, (_, i) => identity({ EMP_ID: `emp-${i}` }));
  const config = { ...DEFAULT_CONFIG, validateUploadedHeadcount: true, minHeadcountMappingPercent: 63 };
  const assessment = assessHeadcountMapping(cognosRecords, aspectIdentities, [], config);
  assert.equal(assessment.aspectPercent, 63, 'displayed percent still rounds normally');
  assert.equal(assessment.sufficient, false, 'the true 62.5% must fail a 63% minimum despite rounding to 63% for display');
}

// ---------------------------------------------------------------------------
// Fix B — a policy-band overlap (two rules covering the same minute) must be
// an ERROR-severity, Save-blocking validateConfigForRun issue, not merely a
// visual-only warning.
// ---------------------------------------------------------------------------
{
  const overlappingRules: PolicyRuleItem[] = [
    { id: 'r1', sn: 1, segmentType: 'Late Login', tier: 'OPS', minMinutes: 6, maxMinutes: 60, conditionDescription: '', action: 'LATE_AND_COVER', actionText: '', communication: 'NA' },
    { id: 'r2', sn: 1, segmentType: 'Late Login', tier: 'OPS', minMinutes: 30, maxMinutes: 90, conditionDescription: '', action: 'ABSENT_SEGMENT', actionText: '', communication: 'NA' },
  ];
  const config = { ...DEFAULT_CONFIG, policyRules: overlappingRules };
  const issues = validateConfigForRun(config);
  assert.ok(issues.some(i => i.kind === 'band' && i.severity === 'ERROR'), 'an overlapping band pair must be a blocking ERROR issue');

  // The shipped default policy rules must remain clean (no false positives).
  assert.deepEqual(validateConfigForRun(DEFAULT_CONFIG), [], 'the default config must validate with zero issues');
}

// ---------------------------------------------------------------------------
// Fix I — a rule-action combination the engine has no dispatch for (e.g.
// ADJUST_OT_RLS on a "Late Login" rule) must be a blocking ERROR, not a
// silently-ignored dropdown choice.
// ---------------------------------------------------------------------------
{
  const badRules: PolicyRuleItem[] = [
    { id: 'r1', sn: 1, segmentType: 'Late Login', tier: 'OPS', minMinutes: 6, maxMinutes: 60, conditionDescription: '', action: 'ADJUST_OT_RLS', actionText: '', communication: 'NA' },
  ];
  const issues = validateConfigForRun({ ...DEFAULT_CONFIG, policyRules: badRules });
  assert.ok(issues.some(i => i.field.includes('Late Login') && i.message.includes('not implemented')), 'an unimplemented action for this segment type must be flagged');
}

// ---------------------------------------------------------------------------
// Fix J — Scenario Guide shares reconciliationEngine.ts's own no-login
// decision function; a "No Login Record" rule configured to NO_ACTION must
// simulate the same outcome the real engine would produce, not the
// simulator's own previously-hardcoded ABSENT_NS_NC.
// ---------------------------------------------------------------------------
{
  const noActionConfig: ConfigRegistry = {
    ...DEFAULT_CONFIG,
    policyRules: DEFAULT_CONFIG.policyRules.map(r => (r.segmentType === 'No Login Record' && r.tier === 'OPS' ? { ...r, action: 'NO_ACTION' as const } : r)),
  };
  const simResult = simulateScenario(
    { tier: 'OPS', isFlex: false, isLeaveDay: false, alreadyMarkedAbsent: false, hasAspectSchedule: true, punchCount: 0, coverageSufficient: true },
    noActionConfig,
  );
  assert.equal(simResult.action, 'NO_ACTION', 'Scenario Guide must reflect a NO_ACTION-configured No Login Record rule, via the shared decision function');

  // Cross-check against a real run with the identical no-punch shape.
  const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
  const out = run(segments, [], {}, undefined, noActionConfig);
  assert.equal(out.rows[0].TAA_ACTION, 'NO_ACTION', 'a real run with the same config must agree with the simulator');
}

// ---------------------------------------------------------------------------
// Fix J — the Scenario Guide's flex simulation must not enter the flex-cutoff
// branch when the (simulated) scheduled start falls outside the configured
// flex window — matching reconciliationEngine.ts's isFlexScheduleWithinExpectedWindow
// gate, shared via the same function.
// ---------------------------------------------------------------------------
{
  // Default window is 07:00-10:00; 14:00 is well outside it.
  assert.equal(isFlexScheduleWithinExpectedWindow(new Date(2000, 0, 1, 14, 0), DEFAULT_CONFIG), false);

  const simResult = simulateScenario(
    {
      tier: 'OPS', isFlex: true, isLeaveDay: false, alreadyMarkedAbsent: false, hasAspectSchedule: true, punchCount: 2,
      coverageSufficient: true, attendanceSpanMinutes: 480, rawStartTime: '14:00', actualFirstLoginTime: '14:00',
    },
    DEFAULT_CONFIG,
  );
  assert.ok(
    simResult.trace.some(line => line.includes('outside the expected flex window')),
    'must route through the schedule-window gate instead of silently applying flex-cutoff math to an out-of-window schedule',
  );
  assert.notEqual(simResult.action, 'SHIFT_UPDATE_FLEX', 'must not apply the flex algorithm outside its designed window');
  assert.notEqual(simResult.action, 'SHIFT_UPDATE_AND_LATE_COVER_FLEX', 'must not apply the flex algorithm outside its designed window');
}

// ---------------------------------------------------------------------------
// Fix J — flexLateBandFires is the single shared gate for whether a flex
// late-arrival's LATE+cover correction rows actually get written; the
// Scenario Guide previously charged the full variance unconditionally with
// no band check at all.
// ---------------------------------------------------------------------------
{
  const bypassOffConfig: ConfigRegistry = {
    ...DEFAULT_CONFIG,
    flexBypassesMinuteBands: false,
    // Push every Late Login OPS band's minimum well above any lateness this
    // test measures, so lookupPolicyRule('Late Login', 'OPS', lateMin) finds nothing.
    policyRules: DEFAULT_CONFIG.policyRules.map(r => (r.segmentType === 'Late Login' && r.tier === 'OPS' ? { ...r, minMinutes: 500 } : r)),
  };
  assert.equal(flexLateBandFires(bypassOffConfig, 'OPS', 50), false, 'bypass OFF and no matching band must not fire');
  assert.equal(flexLateBandFires(bypassOffConfig, 'OPS', 600), true, 'bypass OFF but a band still matches this lateness must fire');
  assert.equal(flexLateBandFires(DEFAULT_CONFIG, 'OPS', 1), true, 'bypass ON (default) always fires regardless of bands');
}

// ---------------------------------------------------------------------------
// Phase 1 (held-review reduction, 2026-09-24) — cognosComparison.ts's SIGNIN
// DURATION and LEFT EARLY/LATE START same-direction downgrades. Uses
// compareCognosRow directly against a minimal ComparisonContext (rather than a
// full engine run) so each case pins the exact ctx shape that flips the result,
// independent of any other engine logic. Base context: nothing scheduled, no
// leave, no removals — only the fields each case actually varies are set.
// ---------------------------------------------------------------------------
{
  const baseCtx: ComparisonContext = {
    rawStart: null, rawEnd: null, duty1Block: null, duty2Block: null,
    netScheduledMinutes: 0, removalMinutes: 0, lateSegmentMinutes: 0, coverMinutes: 0,
    ot1Minutes: 0, ot2Minutes: 0, ot1Block: null, ot2Block: null,
    actualFirstLogin: null, actualLastLogout: null, staffedMinutes: null,
    hasAnyCmsData: true, identifiedLeaveCodes: [], nonWorkingCodes: [], fullDayRemovalCodes: [],
    attendanceVerdictLabel: '', leaveMinutes: null, isLeaveDay: false,
  };
  const find = (cols: ColumnComparison[], name: string) => cols.find(c => c.column === name);
  // Same-basis logout evaluator as the engine builds it (ComparisonContext.logoutPolicy), for a
  // plain OPS day with no release and no COVER: effective end = raw end, no credit. Without it
  // compareCognosRow can never prove a LEFT EARLY release (fail closed, case c2).
  const simpleLogoutPolicy = (rawEnd: Date, actualLogout: Date): ComparisonContext['logoutPolicy'] => {
    const key = (r?: PolicyRuleItem) => (r && r.action !== 'NO_ACTION') ? r.id : 'none';
    const outcomeOf = (logout: Date): string => {
      const diff = Math.floor((logout.getTime() - rawEnd.getTime()) / 60000);
      if (diff < 0) return key(lookupPolicyRule(DEFAULT_CONFIG, 'Early Logout', 'OPS', -diff));
      return diff > 0 ? key(lookupPolicyRule(DEFAULT_CONFIG, 'Late Logout', 'OPS', diff)) : 'none';
    };
    return { taaOutcome: outcomeOf(actualLogout), outcomesAt: (logout: Date) => new Set([outcomeOf(logout)]) };
  };

  // (a) Cognos SIGIN IN/OUT hours apart but SIGNIN DURATION="00:00", and the CMS evidence
  // behind them is two instantaneous swipes (staffedMinutes ~0) -> MATCH, not held.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'SIGNIN DURATION': '00:00' });
    const ctx: ComparisonContext = {
      ...baseCtx,
      actualFirstLogin: dt(`${D} 07:09:00`), actualLastLogout: dt(`${D} 15:10:00`),
      staffedMinutes: 0,
    };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = find(result.comparisons, 'SIGNIN DURATION');
    assert.equal(comp?.status, 'MATCH', '(a) instantaneous swipes: SIGNIN DURATION must MATCH, not MISMATCH');
    assert.ok(!result.mismatchColumns.includes('SIGNIN DURATION'), '(a) must not carry SIGNIN DURATION into mismatchColumns (would hold the row as MISMATCH_FOUND)');
  }

  // (b) Same 00:00 + real timestamps, but staffedMinutes is large (a real logged-in
  // session) -> genuine Cognos calculation failure, still MISMATCH.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'SIGNIN DURATION': '00:00' });
    const ctx: ComparisonContext = {
      ...baseCtx,
      actualFirstLogin: dt(`${D} 07:09:00`), actualLastLogout: dt(`${D} 15:10:00`),
      staffedMinutes: 481,
    };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = find(result.comparisons, 'SIGNIN DURATION');
    assert.equal(comp?.status, 'MISMATCH', '(b) real logged-in session: SIGNIN DURATION must stay MISMATCH');
    assert.ok(result.mismatchColumns.includes('SIGNIN DURATION'), '(b) must carry SIGNIN DURATION into mismatchColumns');
  }

  // (c) LEFT EARLY: Cognos says 3, TAA recomputes 11 — both non-negative, both below the
  // live "Late Logout" policy boundary -> same outcome on TAA's basis -> NOT_COMPARABLE.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:00', 'SIGIN OUT': '15:11', 'LEFT EARLY': '3' });
    const ctx: ComparisonContext = {
      ...baseCtx,
      rawEnd: dt(`${D} 15:00:00`), actualLastLogout: dt(`${D} 15:11:00`),
      logoutPolicy: simpleLogoutPolicy(dt(`${D} 15:00:00`), dt(`${D} 15:11:00`)),
    };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = find(result.comparisons, 'LEFT EARLY');
    assert.equal(comp?.status, 'NOT_COMPARABLE', '(c) both agree "not left early" below the policy boundary -> NOT_COMPARABLE');
    assert.ok(!result.mismatchColumns.includes('LEFT EARLY'), '(c) must not hold the row on LEFT EARLY');
  }

  // (c2) Same figures but no same-basis evaluator in the context: nothing proves the two
  // figures reach the same payroll outcome, so LEFT EARLY stays MISMATCH (fail closed).
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:00', 'SIGIN OUT': '15:11', 'LEFT EARLY': '3' });
    const ctx: ComparisonContext = { ...baseCtx, rawEnd: dt(`${D} 15:00:00`), actualLastLogout: dt(`${D} 15:11:00`) };
    const comp = find(compareCognosRow(cognos, ctx, DEFAULT_CONFIG).comparisons, 'LEFT EARLY');
    assert.equal(comp?.status, 'MISMATCH', '(c2) no logoutPolicy -> no proof -> stays MISMATCH');
  }

  // (d) LEFT EARLY: Cognos says -10 (left early), TAA recomputes +5 (stayed late) — a sign
  // flip, a real disagreement -> stays MISMATCH regardless of band.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:00', 'SIGIN OUT': '15:05', 'LEFT EARLY': '-10' });
    const ctx: ComparisonContext = {
      ...baseCtx,
      rawEnd: dt(`${D} 15:00:00`), actualLastLogout: dt(`${D} 15:05:00`),
    };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = find(result.comparisons, 'LEFT EARLY');
    assert.equal(comp?.status, 'MISMATCH', '(d) a sign flip is a genuine disagreement, must stay MISMATCH');
    assert.ok(result.mismatchColumns.includes('LEFT EARLY'), '(d) must hold the row on LEFT EARLY');
  }

  // (e) LEFT EARLY straddling the LIVE "Late Logout" policy boundary (never pinned to 60 —
  // built from DEFAULT_CONFIG's own rule, per the regression-suite live-config rule):
  // Cognos just below the boundary, TAA just above it -> different bands -> stays MISMATCH.
  {
    const lateLogoutMin = Math.min(
      ...DEFAULT_CONFIG.policyRules.filter(r => r.segmentType === 'Late Logout').map(r => r.minMinutes ?? 0)
    );
    const belowBoundary = lateLogoutMin - 5;
    const aboveBoundary = lateLogoutMin + 5;
    // Real clock times (15:00 + N minutes). The previous `15:${aboveBoundary}` built "15:65" —
    // an unparseable time, so actualLastLogout was null and this case passed without ever
    // comparing a straddling pair.
    const rawEnd = dt(`${D} 15:00:00`);
    const logout = new Date(rawEnd.getTime() + aboveBoundary * 60000);
    const hhmm = `${String(logout.getHours()).padStart(2, '0')}:${String(logout.getMinutes()).padStart(2, '0')}`;
    const cognos = cognosRow({ 'SIGIN IN': '07:00', 'SIGIN OUT': hhmm, 'LEFT EARLY': String(belowBoundary) });
    const ctx: ComparisonContext = {
      ...baseCtx,
      rawEnd, actualLastLogout: logout,
      logoutPolicy: simpleLogoutPolicy(rawEnd, logout),
    };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = find(result.comparisons, 'LEFT EARLY');
    assert.equal(comp?.status, 'MISMATCH', `(e) straddling the live Late Logout boundary (${lateLogoutMin}m) must stay MISMATCH`);
    assert.ok(result.mismatchColumns.includes('LEFT EARLY'), '(e) must hold the row on LEFT EARLY');
  }
}

// ---------------------------------------------------------------------------
// Phase 3 (held-review reduction, 2026-09-24) — SCH DURATION MISMATCH ->
// NOT_COMPARABLE downgrade, ONLY when the whole gap is exactly (within tol)
// one known, deliberate Cognos omission (overtime left out, or release/
// nursing not deducted). Partial cases (COVER not fully included, LATE
// make-up, under-deducted release) must stay MISMATCH.
// ---------------------------------------------------------------------------
{
  const schBaseCtx: ComparisonContext = {
    rawStart: null, rawEnd: null, duty1Block: null, duty2Block: null,
    netScheduledMinutes: 0, removalMinutes: 0, lateSegmentMinutes: 0, coverMinutes: 0,
    ot1Minutes: 0, ot2Minutes: 0, ot1Block: null, ot2Block: null,
    actualFirstLogin: null, actualLastLogout: null, staffedMinutes: null,
    hasAnyCmsData: true, identifiedLeaveCodes: [], nonWorkingCodes: [], fullDayRemovalCodes: [],
    attendanceVerdictLabel: '', leaveMinutes: null, isLeaveDay: false,
  };
  const findSch = (result: ReturnType<typeof compareCognosRow>) => result.comparisons.find(c => c.column === 'SCH DURATION');

  // (f) Exact OT: recomputed 480m (8:0) includes 60m of OT1; Cognos SCH DURATION 420m (7:0)
  // leaves it out — gap is exactly the OT minutes -> NOT_COMPARABLE, not MISMATCH.
  {
    const cognos = cognosRow({ 'SCH DURATION': '7:0' });
    const ctx: ComparisonContext = { ...schBaseCtx, netScheduledMinutes: 480, ot1Minutes: 60 };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = findSch(result);
    assert.equal(comp?.status, 'NOT_COMPARABLE', '(f) gap exactly equals OT minutes -> NOT_COMPARABLE');
    assert.ok(comp?.note?.includes('overtime'), '(f) note must explain the OT exclusion');
    assert.ok(!result.mismatchColumns.includes('SCH DURATION'), '(f) must not hold the row on SCH DURATION');
  }

  // (g) Exact release: recomputed 420m (7:0) already has the 60m release deducted; Cognos
  // SCH DURATION 480m (8:0) never deducted it — gap is exactly the release minutes ->
  // NOT_COMPARABLE, not MISMATCH.
  {
    const cognos = cognosRow({ 'SCH DURATION': '8:0' });
    const ctx: ComparisonContext = { ...schBaseCtx, netScheduledMinutes: 420, removalMinutes: 60 };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = findSch(result);
    assert.equal(comp?.status, 'NOT_COMPARABLE', '(g) gap exactly equals release/nursing minutes -> NOT_COMPARABLE');
    assert.ok(comp?.note?.includes('release/nursing'), '(g) note must explain the release/nursing omission');
    assert.ok(!result.mismatchColumns.includes('SCH DURATION'), '(g) must not hold the row on SCH DURATION');
  }

  // (h) Partial: recomputed 420m (7:0) includes 100m of COVER; Cognos 360m (6:0) is 60m
  // lower — less than the full 100m of COVER, so Cognos only partially missed it (the
  // existing "does not fully include" case) -> must stay MISMATCH, not be downgraded.
  {
    const cognos = cognosRow({ 'SCH DURATION': '6:0' });
    const ctx: ComparisonContext = { ...schBaseCtx, netScheduledMinutes: 420, coverMinutes: 100 };
    const result = compareCognosRow(cognos, ctx, DEFAULT_CONFIG);
    const comp = findSch(result);
    assert.equal(comp?.status, 'MISMATCH', '(h) partial COVER gap must stay MISMATCH, not be downgraded');
    assert.ok(result.mismatchColumns.includes('SCH DURATION'), '(h) must hold the row on SCH DURATION');
  }
}

// ---------------------------------------------------------------------------
// Phase 4 "worst-case Cognos" gate (2026-09-24, plan worst-case-cognos-gate.md) —
// reconciliationEngine.ts's MISMATCH_FOUND skip for a mismatch column that is
// "action-neutral": plugging Cognos's own figure into the LIVE policy bands
// (lookupPolicyRule — every threshold below is read from DEFAULT_CONFIG, never
// pinned) drives the exact same action TAA's own figure already drove. Never
// changes verdict/action/corrections (asserted directly below) — only the hold.
// ---------------------------------------------------------------------------
{
  const tier: RoleTier = 'OPS';
  const firstBandMin = (segmentType: string): number => Math.min(
    ...DEFAULT_CONFIG.policyRules.filter(r => r.segmentType === segmentType && r.tier === tier && r.action !== 'NO_ACTION').map(r => r.minMinutes ?? 0)
  );
  const firstEarlyBand = firstBandMin('Early Logout'); // live OPS value (5 today)
  const firstLateLoginBand = firstBandMin('Late Login'); // live OPS value (6 today)
  const firstLateLogoutBand = firstBandMin('Late Logout'); // live OPS value (60 today)
  const toCognosH = (mins: number) => `${Math.floor(mins / 60)}:${mins % 60}`;

  // --- Gate A / LEFT EARLY: Cognos claims early-leave minutes just below vs. at the live
  // Early Logout band, no release involved. TAA's own logout is exactly on time (earlyMin=0,
  // NO_ACTION) throughout — only Cognos's column value changes between the two runs.
  {
    const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
    const punches = [punch('55501', `${D} 07:00:00`, `${D} 15:00:00`)];
    const cognosBase = { 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00' };

    const released = run(segments, punches, { ...cognosBase, 'LEFT EARLY': String(-(firstEarlyBand - 1)) });
    assert.ok(released.rows[0].TAA_MISMATCH_COLUMNS.includes('LEFT EARLY'), 'released case must still be a genuine LEFT EARLY mismatch');
    assert.equal(released.rows[0].holdReason, undefined, `Cognos early ${firstEarlyBand - 1}m (below the ${firstEarlyBand}m band, same NO_ACTION as TAA) must be released`);
    assert.equal(released.rows[0].TAA_ACTION, 'NO_ACTION', 'TAA_ACTION must be untouched by the gate');

    const held = run(segments, punches, { ...cognosBase, 'LEFT EARLY': String(-firstEarlyBand) });
    assert.equal(held.rows[0].holdReason, 'MISMATCH_FOUND', `Cognos early ${firstEarlyBand}m (a real action, unlike TAA's NO_ACTION) must stay held`);
    assert.equal(held.rows[0].TAA_ACTION, 'NO_ACTION', 'TAA_ACTION must be untouched by the gate even while held');
  }

  // --- Gate A / LEFT EARLY with a trailing release: same 120m release Cognos's raw-window
  // figure ignores (defect1AutoExempt's own inputs) fully explains a below-band Cognos claim;
  // an over-release claim crosses the live band and must stay held.
  {
    const segments = [
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
      seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 13:00:00`, STOP_MOMENT: `${D} 15:00:00` }), // 120m trailing release
    ];
    const punches = [
      punch('55501', `${D} 07:00:00`, `${D} 12:58:00`), // 2m before the release-adjusted end -> TAA earlyMin=2 (below band)
      // Unrelated login, far past the shift's own end — proves the CMS export itself reaches
      // past this shift's raw end, so the early logout above is real evidence, not a
      // truncated-export coverage gap (see the "unseen-7" pattern in regressionSuite.ts).
      punch('99999', `${D} 15:30:00`, `${D} 15:30:03`),
    ];
    const cognosBase = { 'SIGIN IN': '07:00', 'SIGIN OUT': '12:58' };

    const released = run(segments, punches, { ...cognosBase, 'LEFT EARLY': '-120' });
    assert.ok(released.rows[0].TAA_MISMATCH_COLUMNS.includes('LEFT EARLY'), 'released case must still be a genuine LEFT EARLY mismatch');
    assert.equal(released.rows[0].holdReason, undefined, '120m Cognos-claimed early, fully absorbed by the 120m release, is the same NO_ACTION TAA already found (earlyMin=2)');
    assert.equal(released.rows[0].TAA_EARLY_MIN, 2, 'TAA_EARLY_MIN must be untouched by the gate');

    const held = run(segments, punches, { ...cognosBase, 'LEFT EARLY': String(-(120 + firstEarlyBand)) });
    assert.equal(held.rows[0].holdReason, 'MISMATCH_FOUND', `once the release-adjusted claim reaches the live ${firstEarlyBand}m band it must stay held`);
    assert.equal(held.rows[0].TAA_EARLY_MIN, 2, 'TAA_EARLY_MIN must be untouched by the gate even while held');
  }

  // --- Gate A / LATE START: same shape as LEFT EARLY, no release involved. TAA's own
  // arrival is exactly on time (lateMin=0, NO_ACTION).
  {
    const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
    const punches = [punch('55501', `${D} 07:00:00`, `${D} 15:00:00`)];
    const cognosBase = { 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00' };

    const released = run(segments, punches, { ...cognosBase, 'LATE START': String(-(firstLateLoginBand - 1)) });
    assert.ok(released.rows[0].TAA_MISMATCH_COLUMNS.includes('LATE START'), 'released case must still be a genuine LATE START mismatch');
    assert.equal(released.rows[0].holdReason, undefined, `Cognos late ${firstLateLoginBand - 1}m (below the ${firstLateLoginBand}m band, same NO_ACTION as TAA) must be released`);

    const held = run(segments, punches, { ...cognosBase, 'LATE START': String(-firstLateLoginBand) });
    assert.equal(held.rows[0].holdReason, 'MISMATCH_FOUND', `Cognos late ${firstLateLoginBand}m (a real action, unlike TAA's NO_ACTION) must stay held`);
  }

  // --- Gate B / SCH DURATION: a COVER segment Cognos's SCH DURATION only partly captures.
  // Shared base: SHIFT 07:00-15:00 (480m) + COVER 15:00-16:00 (60m, C = the live Late Logout
  // band so "far from band" and "at the band" are both derived, never pinned).
  {
    const C = firstLateLogoutBand;
    // (a) gap <= cover, late logout (0) + gap stays below the Late Logout band -> released.
    {
      const gap = C - 1;
      const segments = [
        seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
        seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: C }),
      ];
      const punches = [punch('55501', `${D} 07:00:00`, `${D} 16:00:00`)]; // out exactly at cover end -> 0 late logout, cover fully attended
      const net = 480 + C;
      const out = run(segments, punches, { 'SCH DURATION': toCognosH(net - gap) });
      assert.ok(out.rows[0].TAA_MISMATCH_COLUMNS.includes('SCH DURATION'), '(a) must still be a genuine SCH DURATION mismatch');
      assert.equal(out.rows[0].holdReason, undefined, `(a) gap ${gap}m <= cover ${C}m, and 0m/${gap}m late logout are both below the ${firstLateLogoutBand}m band -> released`);
    }
    // (b) late logout + gap crosses the Late Logout band -> held.
    {
      const E = C - 1; // charged late logout, just below the band
      const gap = 2;
      const segments = [
        seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
        seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: C }),
      ];
      const logoutMinutesPastRawEnd = C + E; // cover (fully credited) + charged remainder
      const logoutDt = new Date(dt(`${D} 15:00:00`).getTime() + logoutMinutesPastRawEnd * 60000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const logoutStr = `${D} ${pad(logoutDt.getHours())}:${pad(logoutDt.getMinutes())}:00`;
      const punches = [punch('55501', `${D} 07:00:00`, logoutStr)];
      const net = 480 + C;
      const out = run(segments, punches, { 'SCH DURATION': toCognosH(net - gap) });
      assert.ok(out.rows[0].TAA_MISMATCH_COLUMNS.includes('SCH DURATION'), '(b) must still be a genuine SCH DURATION mismatch');
      assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', `(b) charged late logout ${E}m + gap ${gap}m crosses the ${firstLateLogoutBand}m band (TAA's own ${E}m does not) -> held`);
    }
    // (c) gap > cover -> held, even with zero late logout either side.
    {
      const gap = C + 1;
      const segments = [
        seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
        seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: C }),
      ];
      const punches = [punch('55501', `${D} 07:00:00`, `${D} 16:00:00`)];
      const net = 480 + C;
      const out = run(segments, punches, { 'SCH DURATION': toCognosH(net - gap) });
      assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', `(c) gap ${gap}m exceeds the day's own cover minutes (${C}m) -> held`);
    }
    // (d) no COVER at all -> held, however small the gap.
    {
      const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
      const punches = [punch('55501', `${D} 07:00:00`, `${D} 15:00:00`)];
      const out = run(segments, punches, { 'SCH DURATION': toCognosH(480 - 5) });
      assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', '(d) a gap with zero ASPECT COVER minutes behind it can never be proven cover-caused -> held');
    }
  }

  // --- Mixed: an action-neutral SCH DURATION cover gap alongside a genuinely non-neutral
  // LEFT EARLY (Cognos claims non-negative — "not early" — while TAA measures a real,
  // above-band early logout) must still hold: EVERY mismatch column must clear the gate.
  {
    const gap = 9; // <= the 10m leading COVER, comfortably below the Late Logout band
    const earlyPastBand = firstEarlyBand + 5; // a real, above-band early logout
    const segments = [
      seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 06:50:00`, STOP_MOMENT: `${D} 07:00:00`, DURATION: 10 }), // leading, fully attended
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    ];
    const logoutDt = new Date(dt(`${D} 15:00:00`).getTime() - earlyPastBand * 60000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const logoutStr = `${D} ${pad(logoutDt.getHours())}:${pad(logoutDt.getMinutes())}:00`;
    const punches = [
      punch('55501', `${D} 06:50:00`, logoutStr),
      // Unrelated login, far past the shift's own end — see the identical filler above.
      punch('99999', `${D} 15:30:00`, `${D} 15:30:03`),
    ];
    const net = 490; // 10m leading cover + 480m shift
    const out = run(segments, punches, {
      'SCH DURATION': toCognosH(net - gap), 'LEFT EARLY': '2',
      'SIGIN IN': '06:50', 'SIGIN OUT': `${pad(logoutDt.getHours())}:${pad(logoutDt.getMinutes())}`,
    });
    assert.ok(out.rows[0].TAA_MISMATCH_COLUMNS.includes('SCH DURATION'), 'mixed case must carry a genuine SCH DURATION mismatch');
    assert.ok(out.rows[0].TAA_MISMATCH_COLUMNS.includes('LEFT EARLY'), 'mixed case must carry a genuine LEFT EARLY mismatch (Cognos claims non-negative, TAA measures real earliness)');
    assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', 'SCH DURATION alone is action-neutral, but LEFT EARLY is not -> the row must still be held');
  }
}

// ---------------------------------------------------------------------------
// Phase 5 (held-review reduction, 2026-09-24) — the "nobody worked, all agree"
// release gate (reconciliationEngine.ts's noAttendanceAllAgree, ~line 2148) and
// its Step 1 dependency, LEAVE TYPE's REMOVAL_CODE match basis
// (cognosComparison.ts's resolveLeaveTypeMatch). Fixture mirrors
// regressionSuite.ts's reg-149: a bare TRN NEW HIRES full-day-removal segment,
// added to the test config as REMOVAL since it is not in DEFAULT_CONFIG's own
// glossary (see regressionSuite.ts:6978).
// ---------------------------------------------------------------------------
{
  const trnConfig: ConfigRegistry = {
    ...DEFAULT_CONFIG,
    segmentGlossary: { ...DEFAULT_CONFIG.segmentGlossary, 'TRN NEW HIRES': { code: 'TRN NEW HIRES', role: 'REMOVAL', description: 'training' } },
  };
  const trnSegments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 09:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'TRN NEW HIRES' }), // bare — no DURATION, no START/STOP -> full-day removal
  ];
  const trnCognos = { 'LEAVE TYPE': 'TRN New Hires', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '', 'SCH DURATION': '8:0' };

  // (1) 0 punches, Cognos names the day's own removal segment ("TRN New Hires" vs SEG_CODE
  // "TRN NEW HIRES" — proves the match is case-insensitive too) -> LEAVE TYPE MATCH via
  // REMOVAL_CODE, CMS/Cognos both show no attendance -> released (no hold).
  {
    const out = run(trnSegments, [], trnCognos, undefined, trnConfig);
    const r = out.rows[0];
    const leaveType = r.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    assert.equal(leaveType?.status, 'MATCH', 'Cognos "TRN New Hires" vs SEG_CODE "TRN NEW HIRES" must MATCH (case-insensitive)');
    assert.equal(r.TAA_LEAVE_TYPE_MATCH_BASIS, 'REMOVAL_CODE', 'match basis must be REMOVAL_CODE');
    assert.equal(r.holdReason, undefined, 'no attendance in CMS or Cognos and LEAVE TYPE matches -> released, not held');
    assert.equal(r.TAA_ACTION, 'NO_ACTION');
    assert.equal(r.details.generatedCorrections.length, 0, 'no corrections generated');
  }

  // (2) Same fixture + one CMS punch inside the shift -> matchingPunches > 0 -> gate condition 2
  // fails -> stays held.
  {
    const out = run(trnSegments, [punch('55501', `${D} 09:05:00`, `${D} 09:05:03`)], trnCognos, undefined, trnConfig);
    assert.equal(out.rows[0].holdReason, 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', 'a real CMS punch on the day must still hold for review');
  }

  // (3) 0 punches, but Cognos itself claims a sign-in -> gate condition 3 fails (Cognos does
  // not agree nobody worked) -> stays held, even with matchingPunches still at 0.
  {
    const out = run(trnSegments, [], { ...trnCognos, 'SIGIN IN': '09:00' }, undefined, trnConfig);
    assert.equal(out.rows[0].holdReason, 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', 'Cognos SIGIN IN populated must still hold for review');
  }

  // (4) 0 punches, but Cognos LEAVE TYPE names a genuinely different code -> LEAVE TYPE fails
  // to MATCH (gate condition 4) -> stays held (now via MISMATCH_FOUND on top of/regardless of
  // FULL_DAY_REMOVAL_ON_SCHEDULED_DAY — either way, never released).
  {
    const out = run(trnSegments, [], { ...trnCognos, 'LEAVE TYPE': 'ANNUAL' }, undefined, trnConfig);
    const r = out.rows[0];
    const leaveType = r.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    assert.notEqual(leaveType?.status, 'MATCH', 'Cognos ANNUAL vs ASPECT TRN NEW HIRES must not MATCH');
    assert.ok(r.holdReason, 'LEAVE TYPE mismatch must hold the row');
  }

  // (5) Released row (case 1's exact fixture) + an out-of-window CMS punch the base run's own
  // ±cmsPunchSearchWindowHours radius never attributes, placed inside runUnseenPunchAudit's
  // wider unseenPunchMaxReachHours reach (both read from the LIVE config, never pinned — the
  // midpoint of the two live hour values sits outside the narrower radius and inside the wider
  // reach by construction).
  //
  // reconciliationEngine.ts's FULL_DAY_REMOVAL_REVIEW branch (~line 1066-1079) sets
  // TAA_VERDICT='FULL_DAY_REMOVAL_REVIEW', TAA_ACTION='NO_ACTION' and 0 corrections whenever
  // recompute.fullDayRemovalMinutes > 0 — driven entirely by the day's ASPECT segments, never
  // by CMS attendance (a zero-length effective window can never yield a stable late/early/
  // no-login figure). So no punch placement can change verdict/action/corrections for this
  // fixture; classifyUnseenPunchDiff (unseenPunchAudit.ts) would see only a ruleFired diff
  // (REASON), never an OUTCOME-class diff — which is exactly why the engine also stamps
  // details.noAttendanceGateReleased on a row the no-attendance gate released, and
  // unseenPunchAudit.ts re-holds it under that original soft reason as soon as ANY flag
  // (REASON or OUTCOME) attaches, instead of trusting classifyUnseenPunchDiff alone (a gap
  // this exact case first exposed — see report).
  {
    const searchH = trnConfig.cmsPunchSearchWindowHours;
    const reachH = trnConfig.unseenPunchMaxReachHours;
    assert.ok(reachH > searchH, 'test assumes the live audit reach exceeds the live base search radius');
    const distanceH = (searchH + reachH) / 2; // outside the base radius, inside the audit reach
    const farLoginDt = new Date(dt(`${D} 09:00:00`).getTime() - distanceH * 3600000);
    const farPunch: CMSPunch = { Date: D, LoginID: '55501', LoginDateTime: farLoginDt, LogoutDateTime: new Date(farLoginDt.getTime() + 3000) };

    const input: ReconciliationInput = {
      processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosRow(trnCognos)],
      aspectSegments: trnSegments,
      aspectIdentities: [identity({ EMP_ID: '900001' })],
      cmsPunches: [farPunch],
      config: trnConfig,
    };
    const base = runReconciliation(input);
    assert.equal(base.rows[0].holdReason, undefined, 'base run: the far punch must sit outside the live search radius, reproducing case 1 exactly');
    assert.deepEqual(base.rows[0].details.noAttendanceGateReleased, { holdReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY' }, 'engine must stamp the re-hold marker on the row it released');
    const audited = runUnseenPunchAudit(input, base);
    const row = audited.rows[0];
    assert.equal(row.unseenPunchFlag, 'REASON', 'verdict/action/corrections are invariant to attendance on a bare full-day-removal day -> the audit itself classifies this REASON');
    assert.equal(row.holdReason, 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', 'the no-attendance-gate marker must re-hold the row under its original soft reason even on a bare REASON classification');
    assert.equal(row.includeInOutput, false, 'a re-held row must not be auto-includable');
    assert.equal(row.includeDecisionSource, 'auto');
    assert.ok(row.unseenPunchNote?.includes('Re-held: a CMS punch outside the search window contradicts the no-attendance release'), 'note must explain the re-hold');
  }

  // (5b) MIXED_LEAVE_AND_WORK_SEGMENTS variant of case 5 — same re-hold marker, same audit
  // re-hold behavior, on the OTHER soft hold the no-attendance gate can release.
  {
    const sickSegments = [
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 09:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 480 }),
      seg({ SEG_CODE: 'SICK' }),
    ];
    const sickCognos = { 'LEAVE TYPE': 'SICK', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '', 'SCH DURATION': '8:0' };
    const searchH = DEFAULT_CONFIG.cmsPunchSearchWindowHours;
    const reachH = DEFAULT_CONFIG.unseenPunchMaxReachHours;
    const distanceH = (searchH + reachH) / 2;
    const farLoginDt = new Date(dt(`${D} 09:00:00`).getTime() - distanceH * 3600000);
    const farPunch: CMSPunch = { Date: D, LoginID: '55501', LoginDateTime: farLoginDt, LogoutDateTime: new Date(farLoginDt.getTime() + 3000) };

    const input: ReconciliationInput = {
      processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosRow(sickCognos)],
      aspectSegments: sickSegments,
      aspectIdentities: [identity({ EMP_ID: '900001' })],
      cmsPunches: [farPunch],
      config: DEFAULT_CONFIG,
    };
    const base = runReconciliation(input);
    assert.equal(base.rows[0].holdReason, undefined, 'base run: SICK day, 0 attributed punches, both sides agree -> released');
    assert.deepEqual(base.rows[0].details.noAttendanceGateReleased, { holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS' }, 'engine must stamp the re-hold marker with the MIXED_LEAVE reason for this shape');
    const audited = runUnseenPunchAudit(input, base);
    const row = audited.rows[0];
    assert.equal(row.holdReason, 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'an out-of-window punch must re-hold a released MIXED SICK day under its original soft reason');
    assert.equal(row.includeInOutput, false, 'a re-held row must not be auto-includable');
    assert.ok(row.unseenPunchNote?.includes('Re-held: a CMS punch outside the search window contradicts the no-attendance release'), 'note must explain the re-hold');
  }
}

// ---------------------------------------------------------------------------
// Step 3 (launch readiness, 2026-09-24) — releaseProvenSafeHolds kill switch.
// One representative released fixture per phase 1-5 gate, re-run with
// releaseProvenSafeHolds: false, must hold again exactly as it did before that
// gate existed. Reuses the exact fixtures the gates' own tests above prove
// release with (config: DEFAULT_CONFIG, releaseProvenSafeHolds defaults true) —
// only the toggle changes, live config otherwise, per the memory rule on
// regression cases pinning business toggles.
// ---------------------------------------------------------------------------
{
  const offConfig: ConfigRegistry = { ...DEFAULT_CONFIG, releaseProvenSafeHolds: false };
  assert.equal(DEFAULT_CONFIG.releaseProvenSafeHolds, true, 'guard: the toggle must default to true, or this off-fixture proves nothing');

  const baseCtx: ComparisonContext = {
    rawStart: null, rawEnd: null, duty1Block: null, duty2Block: null,
    netScheduledMinutes: 0, removalMinutes: 0, lateSegmentMinutes: 0, coverMinutes: 0,
    ot1Minutes: 0, ot2Minutes: 0, ot1Block: null, ot2Block: null,
    actualFirstLogin: null, actualLastLogout: null, staffedMinutes: null,
    hasAnyCmsData: true, identifiedLeaveCodes: [], nonWorkingCodes: [], fullDayRemovalCodes: [],
    attendanceVerdictLabel: '', leaveMinutes: null, isLeaveDay: false,
  };

  // Phase 1a — SIGNIN staffed-zero MATCH: off, must revert to MISMATCH.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'SIGNIN DURATION': '00:00' });
    const ctx: ComparisonContext = { ...baseCtx, actualFirstLogin: dt(`${D} 07:09:00`), actualLastLogout: dt(`${D} 15:10:00`), staffedMinutes: 0 };
    const result = compareCognosRow(cognos, ctx, offConfig);
    const comp = result.comparisons.find(c => c.column === 'SIGNIN DURATION');
    assert.equal(comp?.status, 'MISMATCH', 'kill switch off: SIGNIN staffed-zero MATCH downgrade must not fire');
    assert.ok(result.mismatchColumns.includes('SIGNIN DURATION'));
  }

  // Phase 1b — LEFT EARLY same-direction NOT_COMPARABLE: off, must revert to MISMATCH.
  {
    const cognos = cognosRow({ 'SIGIN IN': '07:00', 'SIGIN OUT': '15:11', 'LEFT EARLY': '3' });
    const ctx: ComparisonContext = { ...baseCtx, rawEnd: dt(`${D} 15:00:00`), actualLastLogout: dt(`${D} 15:11:00`) };
    const result = compareCognosRow(cognos, ctx, offConfig);
    const comp = result.comparisons.find(c => c.column === 'LEFT EARLY');
    assert.equal(comp?.status, 'MISMATCH', 'kill switch off: LEFT EARLY same-direction downgrade must not fire');
    assert.ok(result.mismatchColumns.includes('LEFT EARLY'));
  }

  // Phase 2 — defect1AutoExempt: off, the "47m <= 60m nursing deduction" release must hold again.
  {
    const segments = [
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
      seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 14:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 60 }),
    ];
    const punches = [punch('55501', `${D} 07:00:00`, `${D} 07:00:03`), punch('55501', `${D} 14:13:00`, `${D} 14:13:03`)];
    const cognosExplained = cognosRow({
      DUTY1: '07:00 - 15:00', 'SCH DURATION': '7:0', 'SIGNIN DURATION': '07:13',
      'SIGIN IN': '07:00', 'SIGIN OUT': '14:13', 'LEFT EARLY': '-47',
      REMARK: 'NURSNG:14:00 - 15:00( -60 Minutes) :',
    });
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosExplained], aspectSegments: segments, aspectIdentities: [identity({ EMP_ID: '900001' })], cmsPunches: punches, config: offConfig });
    assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', 'kill switch off: defect1AutoExempt must not fire, row held as before Phase 2');
  }

  // Phase 3 — SCH DURATION exact-OT NOT_COMPARABLE: off, must revert to MISMATCH.
  {
    const cognos = cognosRow({ 'SCH DURATION': '7:0' });
    const ctx: ComparisonContext = { ...baseCtx, netScheduledMinutes: 480, ot1Minutes: 60 };
    const result = compareCognosRow(cognos, ctx, offConfig);
    const comp = result.comparisons.find(c => c.column === 'SCH DURATION');
    assert.equal(comp?.status, 'MISMATCH', 'kill switch off: SCH DURATION exact-OT downgrade must not fire');
    assert.ok(result.mismatchColumns.includes('SCH DURATION'));
  }

  // Phase 4 — worst-case action-neutral gate: off, the released "Cognos claims below-band
  // early, TAA NO_ACTION" case must hold again.
  {
    const tier: RoleTier = 'OPS';
    const firstEarlyBand = Math.min(
      ...DEFAULT_CONFIG.policyRules.filter(r => r.segmentType === 'Early Logout' && r.tier === tier && r.action !== 'NO_ACTION').map(r => r.minMinutes ?? 0)
    );
    const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
    const punches = [punch('55501', `${D} 07:00:00`, `${D} 15:00:00`)];
    const cognosBase = { 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00' };
    const out = run(segments, punches, { ...cognosBase, 'LEFT EARLY': String(-(firstEarlyBand - 1)) }, undefined, offConfig);
    assert.equal(out.rows[0].holdReason, 'MISMATCH_FOUND', 'kill switch off: worst-case action-neutral gate must not fire, row held as before Phase 4');
  }

  // Phase 5 — no-attendance all-agree gate (+ its Step 1 REMOVAL_CODE dependency): off, the
  // released bare TRN NEW HIRES full-day-removal day must hold again.
  {
    const trnConfig: ConfigRegistry = {
      ...offConfig,
      segmentGlossary: { ...offConfig.segmentGlossary, 'TRN NEW HIRES': { code: 'TRN NEW HIRES', role: 'REMOVAL', description: 'training' } },
    };
    const trnSegments = [
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 09:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 480 }),
      seg({ SEG_CODE: 'TRN NEW HIRES' }),
    ];
    const trnCognos = { 'LEAVE TYPE': 'TRN New Hires', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '', 'SCH DURATION': '8:0' };
    const out = run(trnSegments, [], trnCognos, undefined, trnConfig);
    assert.equal(out.rows[0].holdReason, 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', 'kill switch off: no-attendance all-agree gate must not fire, row held as before Phase 5');
  }
}

console.log('Audit remediation regression tests passed.');
