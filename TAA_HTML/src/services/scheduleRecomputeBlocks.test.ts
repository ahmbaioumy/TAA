import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from './configRegistry';
import { recomputeDaySchedule, ScheduleBlock } from './scheduleRecompute';
import { runReconciliation } from './reconciliationEngine';
import { SUITE_RUN_DATE } from './regressionSuite';
import { isForcedHoldReason } from './holdReasons';
import { AspectSegment, AspectIdentity, CMSPunch, CognosRecord } from '../types/taa';
import { parseDateTimeString } from './parsers';

// -----------------------------------------------------------------------
// Defect fix (A2/A4, scheduleRecompute.ts): duty1Block/duty2Block used to be
// built by collapsing a correctly-computed blocks[] array down to one span
// covering every gap regardless of perBlockGapThresholdMinutes (A4), and
// duty2Block was only ever populated from OT1/OT2 — a genuine second SHIFT
// segment fell into duty1Block and was swallowed by that same collapse (A2).
//
// Both are comparison-only: rawStart/rawEnd/effectiveStart/effectiveEnd/
// netScheduledMinutes (everything that drives the verdict, the charged
// variance, and the ASPECT correction rows actually uploaded) are computed
// directly from every addition segment's own timestamps, never from
// duty1Block/duty2Block — verified by a byte-identical before/after diff of
// every payroll field over the full sample dataset during this fix. These
// tests therefore assert BOTH the corrected block shape AND that nothing
// payroll-affecting moved.
// -----------------------------------------------------------------------

const D = '27/08/2026';
const dt = (s: string) => parseDateTimeString(s)!;

const identity = (id: string): AspectIdentity => ({
  EMP_ID: id, EMP_LAST_NAME: 'Test Agent', EMP_SORT_NAME: 'Test Agent', EMP_SHORT_NAME: 'Test Agent',
  EMP_EXTRA_2: 'tagent', EMP_EMAIL_ADR: 'tagent@thecontactcentre.ae', EMP_EXTRA_4: 'OPS',
} as AspectIdentity);

const seg = (o: Partial<AspectSegment> & { SEG_CODE: string }): AspectSegment =>
  ({ EMP_ID: '900001', NOM_DATE: D, START_DATE: D, ...o } as AspectSegment);

const punch = (inS: string, outS: string): CMSPunch =>
  ({ Date: D, LoginID: '55501', LoginDateTime: dt(inS), LogoutDateTime: dt(outS) });

const cognosRow = (o: Partial<CognosRecord>): CognosRecord => ({
  'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '900001', NAME: 'Test Agent',
  'LOGIN ID': '55501', DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '',
  'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '',
  'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '', ...o,
} as CognosRecord);

const run = (segments: AspectSegment[], punches: CMSPunch[], cognos: Partial<CognosRecord>) =>
  runReconciliation({ processingDate: SUITE_RUN_DATE,
    cognosRecords: [cognosRow(cognos)], aspectSegments: segments,
    aspectIdentities: [identity('900001')], cmsPunches: punches, config: DEFAULT_CONFIG,
  });

const fmt = (b: ScheduleBlock | null): string =>
  b ? `${b.start.getHours()}:${String(b.start.getMinutes()).padStart(2, '0')} - ${b.end.getHours()}:${String(b.end.getMinutes()).padStart(2, '0')}` : 'null';

// ---------------------------------------------------------------------------
// A2 — genuine two-shift day (domain rule: "when a staff member has two
// shifts, the second is in DUTY-2" — Cognos's own equivalent of an ASPECT
// second SHIFT segment).
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(fmt(rec.duty1Block), '7:00 - 15:00', 'duty1Block must be the FIRST shift only, not swallow the gap to the second');
  assert.equal(fmt(rec.duty2Block), '16:00 - 17:00', 'duty2Block must be the genuine second shift, not stay null');
  assert.equal(rec.scheduleShapeUnresolved, false, 'a clean 2-block/0-OT day is a documented, resolvable shape');

  // Extra punch from an unrelated agent, timestamped past this shift's end plus the
  // cmsPunchSearchWindowHours coverage grace, so the CMS export's own extent genuinely
  // covers this shift (see punchAttribution.ts coverageSufficientByWindowKey) — without
  // this, the export would appear to stop at 16:07 and the row would be held on
  // INSUFFICIENT_CMS_COVERAGE rather than exercising the DUTY1/DUTY-2 comparison below.
  const coveragePunch: CMSPunch = { Date: D, LoginID: '99999', LoginDateTime: dt(`${D} 22:05:00`), LogoutDateTime: dt(`${D} 22:10:00`) };
  const punches = [punch(`${D} 07:04:00`, `${D} 07:04:06`), punch(`${D} 16:07:00`, `${D} 16:07:06`), coveragePunch];
  const out = run(segments, punches, { DUTY1: '07:00 - 15:00', 'DUTY-2': '16:00 - 17:00', 'SCH DURATION': '9:0', 'SIGIN IN': '07:04', 'SIGIN OUT': '16:07' });
  const r = out.rows[0];
  // SCH DURATION is the full net (480 + 60 = 9:0): on the real sample, Cognos sums every shift on a two-shift day (12 of 19 real two-shift rows match the net; only 2 match the first shift alone).
  assert.equal(r.columnComparisons.find(c => c.column === 'DUTY1')?.status, 'MATCH', 'DUTY1 must now MATCH Cognos (was a false MISMATCH before the fix)');
  assert.equal(r.columnComparisons.find(c => c.column === 'DUTY-2')?.status, 'MATCH', 'DUTY-2 must now MATCH Cognos (was a false MISMATCH before the fix)');
  assert.notEqual(r.holdReason, 'MISMATCH_FOUND', 'a genuine 2-shift day fully attended must not be held on a comparison artifact');
  assert.equal(r.includeInOutput, true);
}

// ---------------------------------------------------------------------------
// A4 — perBlockGapThresholdMinutes must actually change behaviour. It governs OT and
// non-SHIFT additions; two SHIFT segments are never merged (see the SHIFT tests below).
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 18:00:00`, STOP_MOMENT: `${D} 22:00:00`, DURATION: 240 }),
  ];
  // The gap is exactly 7 hours (420 minutes).
  const below = recomputeDaySchedule(segments, { ...DEFAULT_CONFIG, perBlockGapThresholdMinutes: 60 });
  const above = recomputeDaySchedule(segments, { ...DEFAULT_CONFIG, perBlockGapThresholdMinutes: 500 });

  assert.equal(below.otBlocks.length, 2, 'a threshold below a 7-hour gap must split into two distinct blocks');
  assert.equal(fmt(below.otBlocks[0]), '7:00 - 11:00', 'the first block must not swallow the gap when the threshold says split');
  assert.equal(above.otBlocks.length, 1, 'a threshold above the gap must merge into one block');
  assert.equal(fmt(above.otBlocks[0]), '7:00 - 22:00', 'a merged block must still span the full range');
  assert.notEqual(
    fmt(below.otBlocks[0]), fmt(above.otBlocks[0]),
    'the SAME segments under two different threshold values must produce different block shapes — proves the config knob is no longer inert',
  );
}

// ---------------------------------------------------------------------------
// SHIFT segments are never merged with each other, whatever the gap (real Cognos behaviour:
// every SHIFT segment is its own duty). 17-21 Sept sample: 29 two-shift days, all 0-minute gaps.
// ---------------------------------------------------------------------------
{
  // Back-to-back shifts (0-minute gap) are two blocks -> DUTY1 + DUTY-2, both MATCH Cognos.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 2);
  assert.equal(fmt(rec.duty1Block), '8:00 - 16:00');
  assert.equal(fmt(rec.duty2Block), '16:00 - 17:00');
  assert.equal(rec.scheduleShapeUnresolved, false);
  const r = run(segments, [punch(`${D} 08:00:00`, `${D} 08:00:05`), punch(`${D} 17:00:00`, `${D} 17:00:05`)], { DUTY1: '08:00 - 16:00', 'DUTY-2': '16:00 - 17:00', 'SCH DURATION': '9:0' }).rows[0];
  assert.equal(r.columnComparisons.find(c => c.column === 'DUTY1')?.status, 'MATCH');
  assert.equal(r.columnComparisons.find(c => c.column === 'DUTY-2')?.status, 'MATCH');
  // Nothing payroll-facing depends on the blocks: hours and window are those of the merged span.
  assert.equal(rec.netScheduledMinutes, 540);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '8:00 - 17:00');
}
{
  // The later shift listed FIRST in ASPECT (16:30-17:30 then 08:30-16:30): DUTY1 is still the earlier one.
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 16:30:00`, STOP_MOMENT: `${D} 17:30:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:30:00`, STOP_MOMENT: `${D} 16:30:00`, DURATION: 480 }),
  ], DEFAULT_CONFIG);
  assert.equal(fmt(rec.duty1Block), '8:30 - 16:30');
  assert.equal(fmt(rec.duty2Block), '16:30 - 17:30');
}
{
  // A 30-minute gap between two SHIFTs is also two duties (each SHIFT segment is one duty).
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 12:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 12:30:00`, STOP_MOMENT: `${D} 16:30:00`, DURATION: 240 }),
  ], DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 2);
}
{
  // Three back-to-back SHIFTs: an unmodeled shape (only DUTY1/DUTY-2 exist) — duty2 is never a guess.
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 12:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 12:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 20:00:00`, DURATION: 240 }),
  ], DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 3);
  assert.equal(rec.duty2Block, null);
  assert.equal(rec.scheduleShapeUnresolved, true);
}
{
  // What still merges: contiguous OT1+OT2 stay ONE OT block (the standard OT day), and a COVER
  // that extends the window merges into an adjacent SHIFT.
  const ot = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 17:00:00`, STOP_MOMENT: `${D} 18:00:00`, DURATION: 60 }),
  ], DEFAULT_CONFIG);
  assert.equal(ot.otBlocks.length, 1, 'contiguous OT1+OT2 must remain one OT block');
  assert.equal(ot.scheduleShapeUnresolved, false);
  const cover = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 16:30:00`, DURATION: 30 }),
  ], { ...DEFAULT_CONFIG, coverExtendsAttendanceWindow: true });
  assert.equal(cover.nonOtBlocks.length, 1, 'SHIFT + adjacent COVER (window-extending) still merges');
  assert.equal(fmt(cover.duty1Block), '8:00 - 16:30');
}

// ---------------------------------------------------------------------------
// Unmodeled shapes — never guess which block wins the one DUTY-2 slot.
// ---------------------------------------------------------------------------
{
  // Three distinct non-OT blocks in one day.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 09:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 12:00:00`, STOP_MOMENT: `${D} 14:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 17:00:00`, STOP_MOMENT: `${D} 19:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 3);
  assert.equal(rec.duty2Block, null, '3+ non-OT blocks is an unmodeled shape — duty2Block must never be a guess');
  assert.equal(rec.scheduleShapeUnresolved, true);
}
{
  // A genuine second shift AND real OT the same day — two claimants for one slot.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 18:00:00`, STOP_MOMENT: `${D} 19:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 2);
  assert.equal(rec.otBlocks.length, 1);
  assert.equal(rec.duty2Block, null, 'a second shift AND real OT the same day is an unmodeled shape — neither may silently win the slot');
  assert.equal(rec.scheduleShapeUnresolved, true);
}

// ---------------------------------------------------------------------------
// Standalone-OT day (public-holiday OT2, no base SHIFT) — the real PF 4507957
// shape. Before this fix, 0 non-OT blocks + 1 OT block matched none of the
// three pairing branches, so duty1Block AND duty2Block were both null —
// leaving the D10 SCH DURATION fallback ("add duty2 back in when duty1 is
// empty") permanently dead, and producing a false SCH DURATION/DUTY-2
// MISMATCH on every public-holiday OT row even though it was fully attended.
// ---------------------------------------------------------------------------
{
  const segments = [
    seg({ SEG_CODE: 'P/H-LV' }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 23:00:00`, STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 0);
  assert.equal(rec.otBlocks.length, 1);
  assert.equal(rec.duty1Block, null, 'no base SHIFT exists — duty1Block must stay null, never guessed from the OT block');
  assert.equal(fmt(rec.duty2Block), '23:00 - 7:00', 'duty2Block must now resolve to the standalone OT window instead of staying null');
  assert.equal(rec.scheduleShapeUnresolved, false, 'a single standalone OT block is a fully determined shape, not an unmodeled one');
}
{
  // Guard: 0 non-OT blocks + 2+ OT blocks must stay unresolved — the new
  // branch must not swallow the genuinely ambiguous multi-OT shape.
  const segments = [
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 23:00:00`, STOP_MOMENT: '28/08/2026 03:00:00', DURATION: 240 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 12:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.nonOtBlocks.length, 0);
  assert.equal(rec.otBlocks.length, 2, 'OT1 10:00-12:00 and OT2 23:00-03:00 do not merge — real gap between them');
  assert.equal(rec.duty2Block, null, '2+ OT blocks with no non-OT block is unmodeled — never guess which OT block wins the slot');
  assert.equal(rec.scheduleShapeUnresolved, true);
}
{
  // End-to-end: the SCH DURATION and DUTY-2 comparisons must now MATCH
  // instead of falsely flagging a fully-attended public-holiday OT day.
  const segments = [
    seg({ SEG_CODE: 'P/H-LV' }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 23:00:00`, STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 }),
  ];
  const punches = [punch(`${D} 23:00:00`, '28/08/2026 07:00:00')];
  const out = run(segments, punches, { DUTY1: '', 'DUTY-2': '23:00 - 07:00', OT1: '', 'OT-2': '8:00', 'SCH DURATION': '8:0', 'SIGIN IN': '23:00', 'SIGIN OUT': '07:00' });
  const r = out.rows[0];
  assert.equal(r.columnComparisons.find(c => c.column === 'SCH DURATION')?.status, 'MATCH', 'SCH DURATION must now MATCH (was a false MISMATCH — duty2Block was null)');
  assert.equal(r.columnComparisons.find(c => c.column === 'DUTY-2')?.status, 'MATCH', 'DUTY-2 must now MATCH Cognos (was a false MISMATCH — "Cognos lists a block ASPECT does not evidence")');
}

// ---------------------------------------------------------------------------
// OT1/OT-2 fill format (user-confirmed, post-launch): a single-segment OT day
// fills as a time range ("HH:MM - HH:MM", matching DUTY1/DUTY-2's own
// convention) instead of a duration. A day with 2+ non-contiguous OT1 (resp.
// OT2) segments still falls back to a duration — a combined range would be
// misleading, and this app never guesses.
// ---------------------------------------------------------------------------
{
  // Single OT1 segment -> ot1Block resolves, fill shows the range.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(fmt(rec.ot1Block), '16:00 - 17:00', 'a single OT1 segment must resolve to its own time window');
  assert.equal(rec.ot2Block, null, 'no OT2 segments exist — ot2Block must stay null');

  const punches = [punch(`${D} 08:00:00`, `${D} 17:00:00`)];
  const out = run(segments, punches, { DUTY1: '08:00 - 16:00', OT1: '', 'SCH DURATION': '8:0', 'SIGIN IN': '08:00', 'SIGIN OUT': '17:00' });
  const ot1Comparison = out.rows[0].columnComparisons.find(c => c.column === 'OT1');
  assert.equal(ot1Comparison?.recomputedRaw, '16:00 - 17:00', 'OT1 fill must show the range, not a duration, for a single-segment day');
}
{
  // Two non-contiguous OT2 segments the same day -> ot2Block stays null, fill
  // falls back to duration (never a guessed combined range).
  const segments = [
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 05:00:00`, STOP_MOMENT: `${D} 06:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 20:00:00`, STOP_MOMENT: `${D} 21:30:00`, DURATION: 90 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.otBlocks.length, 2, 'the two OT2 windows do not merge — a real 14-hour gap between them');
  assert.equal(rec.ot2Block, null, '2+ non-contiguous OT2 segments must never collapse into one guessed range');

  const punches = [punch(`${D} 05:00:00`, `${D} 06:00:00`)];
  const out = run(segments, punches, { 'OT-2': '', 'SCH DURATION': '2:30' });
  const ot2Comparison = out.rows[0].columnComparisons.find(c => c.column === 'OT-2');
  assert.equal(ot2Comparison?.recomputedRaw, '02:30', 'OT-2 fill must fall back to a duration when the day is not a single contiguous OT2 window');
}

// ---------------------------------------------------------------------------
// Normal cases (the ~90% shape) — must be byte-identical to before the fix.
// ---------------------------------------------------------------------------
{
  // Single shift + OT with the documented 0-minute gap.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(fmt(rec.duty1Block), '7:00 - 15:00');
  assert.equal(fmt(rec.duty2Block), '15:00 - 17:00');
  assert.equal(rec.scheduleShapeUnresolved, false);
}
{
  // Single shift, no OT at all — the majority case in the real dataset.
  const segments = [seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 })];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(fmt(rec.duty1Block), '7:00 - 15:00');
  assert.equal(rec.duty2Block, null);
  assert.equal(rec.scheduleShapeUnresolved, false);
}

{
  // Overlapping leading releases: effectiveStart is the latest STOP, not summed minutes.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 08:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'UN_RLS', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 08:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '8:00 - 15:00', 'overlapping leading RLS must not double-move effectiveStart');
  // R5 fix: leadingReleaseMinutes now reports the UNIONED total (60m — the same single
  // hour actually removed from netScheduledMinutes), not the raw per-segment sum
  // (60m + 60m = 120m) — a reviewer reconciling net = raw - release by hand must see
  // the same number netScheduledMinutes actually subtracted.
  assert.equal(rec.leadingReleaseMinutes, 60);
}

{
  // A MID-shift removal never moves the window, but its minutes ARE released minutes: they
  // come off scheduled hours and off the SCH DURATION comparison.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 420, 'MID removal must subtract its minutes from netScheduledMinutes');
  assert.equal(rec.releaseMinutes, 60, 'MID removal is reported in releaseMinutes so raw - release - nursing - otInternal = net reconciles');
  assert.equal(rec.midShiftRemovalSegments.length, 1);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '7:00 - 15:00', 'MID removal must not move the effective window');
}

{
  // REEM shape (PF 4507179, 15/09/2026): UN_RLS 12:00-15:00 runs straight into a trailing
  // NURSNG 15:00-16:00 on an 08:00-16:00 shift. The UN_RLS does not reach the 16:00 end by
  // itself, but it is chained to the NURSNG, so 12:00-16:00 is ONE trailing block: the agent
  // is not required from 12:00. It used to be labelled MID, left the effective end at 15:00
  // and held the row.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'UN_RLS', START_MOMENT: `${D} 12:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 180 }),
    seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.midShiftRemovalSegments.length, 0, 'a release chained to a trailing removal is trailing, not MID');
  assert.equal(rec.netScheduledMinutes, 240, '480 - 180 release - 60 nursing');
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '8:00 - 12:00', 'the chained block moves the effective end to where it starts');
  assert.equal(480 - rec.releaseMinutes - rec.nursingMinutes - rec.otInternalRemovalMinutes, rec.netScheduledMinutes, 'the audit trail reconciles');

  // Agent left at 12:00 exactly as released: no early logout, no hold, SCH DURATION matches Cognos.
  const out = run(segments, [punch(`${D} 08:00:00`, `${D} 08:00:05`), punch(`${D} 12:00:00`, `${D} 12:00:05`)], { DUTY1: '08:00 - 16:00', 'SCH DURATION': '4:0' });
  const r = out.rows[0];
  assert.notEqual(r.holdReason, 'MID_SHIFT_REMOVAL_SEGMENT');
  assert.equal(r.TAA_ACTION, 'NO_ACTION', 'leaving at the release start is not an early logout');
  assert.equal(r.TAA_SCH_HOURS_RECOMPUTED, 240);
  assert.equal(r.columnComparisons.find(c => c.column === 'SCH DURATION')?.status, 'MATCH');
}

{
  // A release chained to the START (leading) grows the same way: RLS 08:00-09:00 then
  // UN_RLS 09:00-10:00 both delay the required start to 10:00.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 09:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'UN_RLS', START_MOMENT: `${D} 09:00:00`, STOP_MOMENT: `${D} 10:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.midShiftRemovalSegments.length, 0);
  assert.equal(rec.netScheduledMinutes, 360);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '10:00 - 16:00');
}

{
  // A mid-shift release that is NOT adjacent to a trailing one stays MID (window unmoved),
  // even when a different trailing release exists elsewhere on the day.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.midShiftRemovalSegments.length, 1);
  assert.equal(rec.netScheduledMinutes, 360, '480 - 60 mid - 60 nursing');
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '8:00 - 15:00', 'only the trailing nursing moves the end');
}

{
  // A release sitting in an UNSCHEDULED gap (between two shifts) has no scheduled time to
  // remove, so it must dock nothing.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 18:00:00`, STOP_MOMENT: `${D} 22:00:00`, DURATION: 240 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 13:00:00`, STOP_MOMENT: `${D} 14:00:00`, DURATION: 60 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 480, 'a release with no scheduled time under it removes nothing');
}

{
  // The guard against hiding a real finding: released 10:00-11:00 mid-shift, but the agent
  // walks out at 10:00 and never returns. The window is not moved, so this is still measured
  // against the 15:00 end (a genuine early logout), not silently excused by the release.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 60 }),
  ];
  const out = run(segments, [punch(`${D} 07:00:00`, `${D} 07:00:05`), punch(`${D} 10:00:00`, `${D} 10:00:05`)], { DUTY1: '07:00 - 15:00', 'SCH DURATION': '7:0' });
  const r = out.rows[0];
  assert.notEqual(r.holdReason, 'MID_SHIFT_REMOVAL_SEGMENT');
  assert.equal(r.TAA_EFFECTIVE_END, '15:00', 'a mid-shift release must not move the window');
  assert.notEqual(r.TAA_ACTION, 'NO_ACTION', 'leaving 5h before the end is still an early logout');
}

{
  // A release fully contained inside OT1+OT2 is OT_INTERNAL, not MID: it DOES reduce
  // netScheduledMinutes (Rule 8 already corrects the OT duration to match), but the
  // effective window is untouched — no attendance anchor sits inside overtime to move.
  const segments = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 17:00:00`, STOP_MOMENT: `${D} 19:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 18:00:00`, DURATION: 120 }),
  ];
  const rec = recomputeDaySchedule(segments, DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 600, 'OT-internal removal must subtract from netScheduledMinutes (480+120+120-120)');
  assert.equal(rec.midShiftRemovalSegments.length, 0, 'must not be classified MID');
  assert.equal(rec.otInternalRemovalSegments.length, 1);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '7:00 - 19:00', 'OT-internal removal must not move the effective window');
}

// ---------------------------------------------------------------------------
// SCH DURATION column = the full net schedule (all ADDITIONs incl. OT and COVER minus all
// REMOVALs, glossary-role driven), never a time span.
// ---------------------------------------------------------------------------
// Coverage punch: unrelated agent, timestamped past every shift end used by schColumn's
// callers (latest is 19:00) plus the cmsPunchSearchWindowHours grace, so the CMS export's
// own extent covers the shift and these rows exercise the SCH DURATION comparison instead
// of holding on INSUFFICIENT_CMS_COVERAGE (see punchAttribution.ts coverage checks).
const schColumnCoveragePunch: CMSPunch = { Date: D, LoginID: '99998', LoginDateTime: dt(`${D} 23:55:00`), LogoutDateTime: dt(`${D} 23:59:00`) };
const schColumn = (segments: AspectSegment[], cognosSch: string) => {
  const r = run(segments, [punch(`${D} 08:00:00`, `${D} 08:00:05`), schColumnCoveragePunch], { DUTY1: '08:00 - 16:00', 'SCH DURATION': cognosSch }).rows[0];
  return { r, sch: r.columnComparisons.find(c => c.column === 'SCH DURATION')! };
};
{
  // REEM 16/09: SHIFT 08-16, NURSNG 15-16, COVER 48+6+5 -> 480 - 60 + 59 = 479 (07:59); Cognos 7:58 is within the 1-minute tolerance.
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'NURSNG', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 60 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 15:48:00`, DURATION: 48 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:48:00`, STOP_MOMENT: `${D} 15:54:00`, DURATION: 6 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 15:54:00`, STOP_MOMENT: `${D} 15:59:00`, DURATION: 5 }),
  ], '7:58');
  assert.equal(sch.recomputedMinutes, 479);
  assert.equal(sch.status, 'MATCH');
}
{
  // OT counts: SHIFT 480 + OT1 120 = 600. Cognos leaves OT out (8:0) — the gap is exactly
  // the OT minutes, a fully-explained Cognos omission, so hold reduction phase 1
  // (cognosComparison.ts otExactMatch downgrade, 2026-09-24) downgrades this from MISMATCH
  // to NOT_COMPARABLE rather than holding it. Was asserted MISMATCH before that change.
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 18:00:00`, DURATION: 120 }),
  ], '8:0');
  assert.equal(sch.recomputedMinutes, 600);
  assert.equal(sch.status, 'NOT_COMPARABLE');
  assert.ok(/excludes the 120m overtime/.test(sch.note || ''), 'the downgrade note must say Cognos omits overtime');
}
{
  // A release inside OT reduces the column too (every removal comes off).
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 18:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 16:30:00`, STOP_MOMENT: `${D} 17:30:00`, DURATION: 60 }),
  ], '10:0');
  assert.equal(sch.recomputedMinutes, 540);
}
{
  // NO_EFFECT tags (breaks, briefing, queue tags) never count; a custom ADDITION code added to the glossary does.
  const base = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'BREAK1', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 10:15:00`, DURATION: 15 }),
    seg({ SEG_CODE: 'BRFNG', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 08:15:00`, DURATION: 15 }),
  ];
  assert.equal(recomputeDaySchedule(base, DEFAULT_CONFIG).netScheduledMinutes, 480, 'NO_EFFECT segments must not count');
  const custom = seg({ SEG_CODE: 'EXTRA_ADD', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 16:30:00`, DURATION: 30 });
  const cfg = { ...DEFAULT_CONFIG, segmentGlossary: { ...DEFAULT_CONFIG.segmentGlossary, EXTRA_ADD: { code: 'EXTRA_ADD', role: 'ADDITION' as const } } };
  assert.equal(recomputeDaySchedule([...base, custom], cfg).netScheduledMinutes, 510, 'a custom ADDITION code from the glossary must count');
}

// ---------------------------------------------------------------------------
// Full-day segments (no DURATION, no START/STOP): the segment's duration is the day's OWN
// scheduled duration (SHIFT + OT + COVER); defaultFullDaySegmentDurationMinutes is only the
// fallback for a day with no schedule. A bare REMOVAL used to resolve to UNKNOWN (0 min) and
// force-hold the row; a bare ADDITION always took the flat default.
// ---------------------------------------------------------------------------
{
  const scheduledDay = [
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT1', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 17:00:00`, STOP_MOMENT: `${D} 17:30:00`, DURATION: 30 }),
  ];
  const fullDayRls = seg({ SEG_CODE: 'RLS' });

  // 8h shift + 2h OT + 30m cover = 630: the bare removal takes exactly that, not a flat 480.
  const rec = recomputeDaySchedule([...scheduledDay, fullDayRls], DEFAULT_CONFIG);
  assert.equal(rec.fullDayRemovalMinutes, 630, 'full-day removal = the day\'s scheduled duration, not the 480 default');
  assert.equal(rec.netScheduledMinutes, 0);
  assert.equal(rec.releaseMinutes, 630, 'reported in releaseMinutes so raw - release = net reconciles');
  assert.equal(630 - rec.releaseMinutes - rec.nursingMinutes - rec.otInternalRemovalMinutes, rec.netScheduledMinutes);
  assert.equal(rec.unknownDurationRemovalSegments.length, 0, 'no REMOVAL_SEGMENT_DURATION_UNKNOWN for a full-day removal');
  assert.equal(rec.outOfWindowRemovalSegments.length, 0);
  assert.equal(rec.ambiguousOverlappingRemovalSegments.length, 0);
  assert.equal(rec.negativeNetScheduleMinutes, false);
  assert.equal(rec.removalTrace.length, 1);
  assert.equal(rec.removalTrace[0].position, 'FULL_DAY');
  assert.equal(rec.removalTrace[0].minutesSource, 'FULL_DAY_SCHEDULE');
  assert.equal(rec.removalTrace[0].minutes, 630);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '7:00 - 7:00', 'the agent is not required: window collapses to the start');

  // A different configured default must NOT change the answer on a day that has a schedule.
  const cfg500 = { ...DEFAULT_CONFIG, defaultFullDaySegmentDurationMinutes: 500 };
  assert.equal(recomputeDaySchedule([...scheduledDay, fullDayRls], cfg500).fullDayRemovalMinutes, 630);

  // A timed release on the same day: the full-day removal takes only what is LEFT (570), so
  // the total never overshoots into NEGATIVE_NET_SCHEDULE_MINUTES.
  const withMid = recomputeDaySchedule([
    ...scheduledDay,
    seg({ SEG_CODE: 'UN_RLS', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 60 }),
    fullDayRls,
  ], DEFAULT_CONFIG);
  assert.equal(withMid.fullDayRemovalMinutes, 570);
  assert.equal(withMid.releaseMinutes, 630);
  assert.equal(withMid.netScheduledMinutes, 0);
  assert.equal(withMid.negativeNetScheduleMinutes, false);
  assert.equal(withMid.ambiguousOverlappingRemovalSegments.length, 0);

  // Two full-day removals overlap by definition — no ambiguity hold, the second removes 0.
  const two = recomputeDaySchedule([...scheduledDay, fullDayRls, seg({ SEG_CODE: 'UN_RLS' })], DEFAULT_CONFIG);
  assert.equal(two.fullDayRemovalMinutes, 630);
  assert.equal(two.ambiguousOverlappingRemovalSegments.length, 0);
  assert.deepEqual(two.removalTrace.map(t => t.minutes), [630, 0]);
}

{
  // No schedule at all: nothing to remove from. No OUT_OF_WINDOW / UNKNOWN hold; it removes 0
  // and reports the config default as its source.
  const rec = recomputeDaySchedule([seg({ SEG_CODE: 'RLS' })], DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 0);
  assert.equal(rec.fullDayRemovalMinutes, 0);
  assert.equal(rec.outOfWindowRemovalSegments.length, 0);
  assert.equal(rec.unknownDurationRemovalSegments.length, 0);
  assert.equal(rec.negativeNetScheduleMinutes, false);
  assert.equal(rec.removalTrace[0].minutesSource, 'FULL_DAY_DEFAULT');
}

{
  // A removal with only ONE of START/STOP is not a full-day segment — still unknown, still held.
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 14:00:00` }),
  ], DEFAULT_CONFIG);
  assert.equal(rec.fullDayRemovalSegments.length, 0);
  assert.equal(rec.invalidDateTimeSegments.length, 1, 'a half-specified removal is still invalid data');
}

{
  // Full-day ADDITION (custom non-schedule code): equals the day's schedule, so it must not add
  // on top of it (no 480 + 480 double count) …
  const addCfg = (defaultMinutes: number) => ({
    ...DEFAULT_CONFIG,
    defaultFullDaySegmentDurationMinutes: defaultMinutes,
    segmentGlossary: {
      ...DEFAULT_CONFIG.segmentGlossary,
      FULLDAYADD: { code: 'FULLDAYADD', role: 'ADDITION' as const },
      FULLDAYADD2: { code: 'FULLDAYADD2', role: 'ADDITION' as const },
    },
  });
  const shift = seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 });
  const onScheduledDay = recomputeDaySchedule([shift, seg({ SEG_CODE: 'FULLDAYADD' })], addCfg(480));
  assert.equal(onScheduledDay.netScheduledMinutes, 480, 'a full-day addition on a scheduled day adds nothing extra');
  assert.equal(onScheduledDay.fullDayAdditionSegments.length, 1);
  assert.equal(onScheduledDay.additionSegments.length, 1, 'kept out of additionSegments: it has no window');
  assert.equal(onScheduledDay.invalidDateTimeSegments.length, 0, 'a bare full-day addition is not malformed data');

  // … and on a day with no schedule it falls back to the configured default (non-default value pinned).
  const noSchedule = recomputeDaySchedule([seg({ SEG_CODE: 'FULLDAYADD' })], addCfg(500));
  assert.equal(noSchedule.netScheduledMinutes, 500, 'no schedule -> configured default');
  assert.equal(noSchedule.isLeaveDay, false, 'FULLDAYADD is not a configured non-working code here');
  const twoNoSchedule = recomputeDaySchedule([seg({ SEG_CODE: 'FULLDAYADD' }), seg({ SEG_CODE: 'FULLDAYADD2' })], addCfg(500));
  assert.equal(twoNoSchedule.netScheduledMinutes, 500, 'the fallback is applied once per day, never per segment');

  // A bare schedule-defining code can never define a window: it stays invalid data.
  const bareShift = recomputeDaySchedule([seg({ SEG_CODE: 'SHIFT' })], DEFAULT_CONFIG);
  assert.equal(bareShift.invalidDateTimeSegments.length, 1);
  assert.equal(bareShift.fullDayAdditionSegments.length, 0);
}

{
  // Full-day ADDITION and full-day REMOVAL on the SAME day (one leave code classed Addition,
  // another classed Removal, both bare). The addition supplies the day's only scheduled minutes,
  // so the removal must take them: the removal's basis counts the addition's own contribution,
  // not just timed SHIFT/OT/COVER rows. Previously the removal saw "no schedule", removed
  // nothing, and left the day paid a full 8 hours while netScheduledMinutes said it WAS
  // scheduled — the two halves of the same day's arithmetic disagreeing.
  const cfg = {
    ...DEFAULT_CONFIG,
    defaultFullDaySegmentDurationMinutes: 500,
    segmentGlossary: {
      ...DEFAULT_CONFIG.segmentGlossary,
      ANNUAL: { code: 'ANNUAL', role: 'ADDITION' as const },
      'SPL-LV': { code: 'SPL-LV', role: 'REMOVAL' as const },
    },
  };
  const rec = recomputeDaySchedule([seg({ SEG_CODE: 'ANNUAL' }), seg({ SEG_CODE: 'SPL-LV' })], cfg);
  assert.equal(rec.netScheduledMinutes, 0, 'the full-day removal must take the minutes the full-day addition supplied');
  assert.equal(rec.fullDayRemovalMinutes, 500, 'and it takes the configured default the addition contributed, not a hardcoded 480');
  assert.equal(rec.removalTrace[0].minutesSource, 'FULL_DAY_SCHEDULE', 'the day HAD a schedule — it came from the full-day addition');

  // The reverse shape is untouched: with a real timed schedule the addition contributes
  // nothing, so the basis is the timed schedule alone and the removal still takes exactly that.
  const withTimed = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'ANNUAL' }),
    seg({ SEG_CODE: 'SPL-LV' }),
  ], cfg);
  assert.equal(withTimed.netScheduledMinutes, 0);
  assert.equal(withTimed.fullDayRemovalMinutes, 480, 'basis is the real 480 shift, never 480 + the 500 default');
}

{
  // Codes left as No Effect (ANNUAL/P-H-LV/SICK by default) are untouched: they neither add nor deduct.
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'ANNUAL' }),
  ], DEFAULT_CONFIG);
  assert.equal(rec.netScheduledMinutes, 480);
  assert.equal(rec.fullDayRemovalSegments.length, 0);
  assert.equal(rec.removalTrace.length, 0);

  // Reclassified as Removal in the Segment Glossary, the same code now deducts the whole day.
  const annualAsRemoval = { ...DEFAULT_CONFIG, segmentGlossary: { ...DEFAULT_CONFIG.segmentGlossary, ANNUAL: { code: 'ANNUAL', role: 'REMOVAL' as const } } };
  const wiped = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'OT2', START_MOMENT: `${D} 15:00:00`, STOP_MOMENT: `${D} 17:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'ANNUAL' }),
  ], annualAsRemoval);
  assert.equal(wiped.fullDayRemovalMinutes, 600);
  assert.equal(wiped.netScheduledMinutes, 0);
}

{
  // Engine level: a bare release that wipes a worked day is releasable-by-reviewer (soft hold),
  // never the old forced REMOVAL_SEGMENT_DURATION_UNKNOWN, and never silently exported.
  const out = run(
    [
      seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 07:00:00`, STOP_MOMENT: `${D} 15:00:00`, DURATION: 480 }),
      seg({ SEG_CODE: 'RLS' }),
    ],
    [punch(`${D} 07:00:00`, `${D} 07:00:05`), punch(`${D} 15:00:00`, `${D} 15:00:05`)],
    { DUTY1: '07:00 - 15:00', 'SCH DURATION': '0:0' },
  );
  const r = out.rows[0];
  assert.equal(r.holdReason, 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY');
  assert.notEqual(r.holdReason, 'REMOVAL_SEGMENT_DURATION_UNKNOWN');
  assert.equal(r.TAA_SCH_HOURS_RECOMPUTED, 0);
  assert.equal(isForcedHoldReason(r.holdReason), false, 'reviewer-releasable, not a forced hold');
}

// ---------------------------------------------------------------------------
// Real two-shift shapes from the sample (PF 4507948: SHIFT 120+480, Cognos 10:0;
// PF 4700281: SHIFT 480+60, Cognos 9:0) — Cognos SCH DURATION is the SUM of the shifts.
// ---------------------------------------------------------------------------
{
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 10:00:00`, DURATION: 120 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 12:00:00`, STOP_MOMENT: `${D} 20:00:00`, DURATION: 480 }),
  ], '10:0');
  assert.equal(sch.recomputedMinutes, 600);
  assert.equal(sch.status, 'MATCH', 'a short shift listed first plus a long shift sums to 10:00, as Cognos does');
}
{
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 18:00:00`, STOP_MOMENT: `${D} 19:00:00`, DURATION: 60 }),
  ], '9:0');
  assert.equal(sch.recomputedMinutes, 540);
  assert.equal(sch.status, 'MATCH');
}

// ---------------------------------------------------------------------------
// SCH DURATION mismatch notes: display text only. Exactly-explained gaps (the whole gap
// accounted for by one known Cognos omission) downgrade to NOT_COMPARABLE under hold
// reduction phase 1 (cognosComparison.ts otExactMatch/releaseExactMatch, 2026-09-24);
// only partially-explained gaps stay MISMATCH.
// ---------------------------------------------------------------------------
{
  // Cognos left the release in (8:0) while ASPECT records a 60m mid-shift release -> 7:00.
  // The whole gap (60m) is exactly the release minutes -> exact match -> NOT_COMPARABLE.
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'RLS', START_MOMENT: `${D} 10:00:00`, STOP_MOMENT: `${D} 11:00:00`, DURATION: 60 }),
  ], '8:0');
  assert.equal(sch.status, 'NOT_COMPARABLE');
  assert.ok(/did not deduct the 60m/.test(sch.note || ''), `note was: ${sch.note}`);
}
{
  // ASPECT has a 16m make-up COVER after a 16m LATE that Cognos does not show yet (Cognos 8:0, net 8:16).
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
    seg({ SEG_CODE: 'LATE', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 08:16:00`, DURATION: 16 }),
    seg({ SEG_CODE: 'COVER', START_MOMENT: `${D} 16:00:00`, STOP_MOMENT: `${D} 16:16:00`, DURATION: 16 }),
  ], '8:0');
  assert.equal(sch.recomputedMinutes, 496);
  assert.equal(sch.status, 'MISMATCH');
  assert.ok(/LATE make-up minutes \(16m\)/.test(sch.note || ''), `note was: ${sch.note}`);
}
{
  // A mismatch with no known cause carries no invented explanation.
  const { sch } = schColumn([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:00:00`, STOP_MOMENT: `${D} 16:00:00`, DURATION: 480 }),
  ], '8:30');
  assert.equal(sch.status, 'MISMATCH');
  assert.ok(!sch.note, 'no cause identified -> no note');
}
// SPLIT is an unpaid gap: a REMOVAL by default, deducted, and never an unclassified code.
{
  const rec = recomputeDaySchedule([
    seg({ SEG_CODE: 'SHIFT', START_MOMENT: `${D} 08:30:00`, STOP_MOMENT: `${D} 17:30:00`, DURATION: 540 }),
    seg({ SEG_CODE: 'SPLIT', START_MOMENT: `${D} 14:30:00`, STOP_MOMENT: `${D} 15:30:00`, DURATION: 60 }),
  ], DEFAULT_CONFIG);
  assert.equal(rec.unclassifiedCodes.length, 0);
  assert.equal(rec.netScheduledMinutes, 480);
  assert.equal(fmt({ start: rec.effectiveStart!, end: rec.effectiveEnd! }), '8:30 - 17:30', 'a mid-shift SPLIT must not move the window');
}

console.log('Schedule-recompute block tests passed.');
