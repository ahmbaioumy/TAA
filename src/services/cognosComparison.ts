import { CognosLeaveTypeMapping, CognosRecord, ColumnComparison, ColumnComparisonStatus, ConfigRegistry, LeaveTypeMatchBasis, PolicyGroup } from '../types/taa';
import { formatTimeHHMM, formatMinutesToHHMM, parseHHMMToMinutes, parseCognosHMinutes, parseClockTimeString } from './parsers';
import { ScheduleBlock } from './scheduleRecompute';

/**
 * Hold Policy column->group map (doc/PRD.md §Hold Policy). Adding a new compared Cognos
 * column? Add it here (or accept the 'OTHER' default, which still renders as an auto
 * "Other column" row — see holdPolicy.ts's holdPolicyLayout). Not exhaustive-typed against
 * a fixed column-name union on purpose: CognosRecord's column set is open-ended
 * ([key: string]: string), so a missing entry must degrade gracefully, not fail to compile.
 */
const COLUMN_POLICY_GROUP: Record<string, PolicyGroup> = {
  'DUTY1': 'SHIFT',
  'DUTY-2': 'SHIFT',
  'LATE START': 'LATE_EARLY',
  'LEFT EARLY': 'LATE_EARLY',
  'SCH DURATION': 'SCHEDULE',
  'OT1': 'SCHEDULE',
  'OT-2': 'SCHEDULE',
  'SIGNIN DURATION': 'SIGN_IN',
  'SIGIN IN': 'SIGN_IN',
  'SIGIN OUT': 'SIGN_IN',
  'LEAVE TYPE': 'LEAVE',
  'LEAVE HR': 'LEAVE',
};

function policyGroupForColumn(column: string): PolicyGroup {
  return COLUMN_POLICY_GROUP[column] ?? 'OTHER';
}

export interface ComparisonContext {
  rawStart: Date | null;
  rawEnd: Date | null;
  duty1Block: ScheduleBlock | null;
  duty2Block: ScheduleBlock | null;
  netScheduledMinutes: number;
  /** Release + nursing + OT-internal removal minutes actually taken off netScheduledMinutes,
   * and the total of the day's existing LATE segments. Used ONLY to explain a SCH DURATION
   * mismatch in its `note` (display text) — never a status, verdict or output input. */
  removalMinutes: number;
  lateSegmentMinutes: number;
  coverMinutes: number;
  ot1Minutes: number;
  ot2Minutes: number;
  /** Single contiguous OT1/OT2 window for the day, null when there is none or when it
   * splits into 2+ non-contiguous segments (see scheduleRecompute.ts's singleOtBlock).
   * Display-only: when set, the OT1/OT-2 fill shows this range instead of a duration —
   * ot1Minutes/ot2Minutes (unaffected) still drive the match/mismatch check and pay. */
  ot1Block: ScheduleBlock | null;
  ot2Block: ScheduleBlock | null;
  actualFirstLogin: Date | null;
  actualLastLogout: Date | null;
  /** Phase 9 (informational only): sum of each attributed CLOSED punch's own
   * login->logout duration — the same quantity Cognos's own SIGNIN DURATION measures
   * (staffed/logged-in time), as opposed to actualFirstLogin/actualLastLogout's first-to-last
   * SPAN above. null when there is no closed-punch evidence to compute it from. Attached to the
   * SIGNIN DURATION comparison's `note` as DISPLAY TEXT ONLY (see minutesColumn's `extraNote`
   * param below) — must never influence a comparison `status`, a verdict, or either CSV export. */
  staffedMinutes: number | null;
  /** true when the CMS export holds at least one punch anywhere for this row's Login ID, even
   * if none fell inside this specific window/search radius. Lets timeOfDayColumn tell "this
   * Login ID has no CMS record in the export at all" (missing evidence — NOT_COMPARABLE) apart
   * from "CMS has data for this login but nothing near this window" (a genuine disagreement
   * worth flagging — MISMATCH). */
  hasAnyCmsData: boolean;
  /** Every identified ASPECT leave segment's own SEG_CODE for this employee-day (from
   * config.leaveSegmentCodes), not deduped/normalized — may be empty. Independent of
   * isLeaveDay: a mixed leave-and-work day still carries its real codes here. */
  identifiedLeaveCodes: string[];
  /** Codes on this day that gate attendance (config.nonWorkingDaySegmentCodes) but are
   * NOT leave — e.g. OFF. Used only for the NON_WORKING match basis (a scheduled day off
   * is never reported as a leave type, but still needs to match Cognos naming it). */
  nonWorkingCodes: string[];
  /** This day's full-day removal segment SEG_CODEs (scheduleRecompute.ts's
   * fullDayRemovalSegments — e.g. TRN, Addition/Removal codes), not deduped/normalized —
   * may be empty. These are removal codes, not leave, so they never populate
   * identifiedLeaveCodes; used only for the REMOVAL_CODE match basis, which lets Cognos
   * naming the day's removal segment (e.g. "TRN New Hires") count as a LEAVE TYPE match
   * instead of a mismatch. */
  fullDayRemovalCodes: string[];
  /** The attendance verdict label ('ABSENT' / 'Absent NS/NC' / ''), used ONLY as a
   * fallback when no identified leave code and no non-working match exists — e.g.
   * Cognos U-ABSENT vs TAA's own "Absent NS/NC" false-absence finding. */
  attendanceVerdictLabel: string;
  /** null = not comparable — no identified leave segment carries real duration evidence
   * (an explicit DURATION, including a deliberate 0, or a valid START_MOMENT/STOP_MOMENT
   * span). Never defaulted to a full day — the real Cognos sample shows ANNUAL at both
   * 480 and 540 minutes and OFF at 30/50, so no single default is safe. A number here is
   * genuine ASPECT-recorded evidence, safe to compare against Cognos LEAVE HR. */
  leaveMinutes: number | null;
  isLeaveDay: boolean;
  /** Flex-tagged employee (doc/PRD.md §4.8). Cognos prints a flex employee's fixed BASE
   * roster in DUTY1 and measures LATE START / LEFT EARLY against it, while ASPECT holds the
   * flex-moved shift TAA measures against by design — see the flex roster downgrade below. */
  isFlex?: boolean;
  /** Same-basis logout evaluator (2026-09-27), built by the engine from its OWN anchors: the
   * release/nursing-adjusted end (Late Logout), the early-logout anchor, the attended-COVER
   * credit and the employee's tier. Given a candidate last-logout instant it returns every
   * policy outcome key (a rule id, or 'none') the Early/Late Logout rules could reach — more
   * than one only when the COVER credit for that instant cannot be pinned down. taaOutcome is
   * the outcome TAA itself reached. Absent => no release is ever proved from LEFT EARLY. */
  logoutPolicy?: { outcomesAt: (logout: Date) => Set<string>; taaOutcome: string };
}

/** True only when Cognos's LEFT EARLY figure, placed on TAA's own basis (same anchors,
 * release/nursing adjustment, COVER credit, tier and rules — ctx.logoutPolicy), reaches exactly
 * the policy outcome TAA reached, AND the evaluator reproduces TAA's outcome from TAA's own
 * logout (self-check: if it can't, nothing is proved and the row stays held). Replaces the old
 * raw-figure band test, which compared two raw figures against the Late Logout band and so
 * missed a pair straddling it on the release-adjusted basis (Cognos 29 vs TAA 31 with a 30m
 * trailing RLS = 59m vs 61m: no action vs ABSENT). */
export function logoutOutcomeMatchesTaa(ctx: ComparisonContext, cognosLeftEarlyMin: number): boolean {
  const policy = ctx.logoutPolicy;
  if (!policy || !ctx.rawEnd || !ctx.actualLastLogout) return false;
  const own = policy.outcomesAt(ctx.actualLastLogout);
  if (own.size !== 1 || !own.has(policy.taaOutcome)) return false;
  const cognosLogout = new Date(ctx.rawEnd.getTime() + cognosLeftEarlyMin * 60000);
  const theirs = policy.outcomesAt(cognosLogout);
  return theirs.size === 1 && theirs.has(policy.taaOutcome);
}

export interface RowComparisonResult {
  comparisons: ColumnComparison[];
  mismatchColumns: string[];
  filledColumns: string[]; // Cognos columns that were blank and got a recomputed value
  cognosAgree: boolean; // true iff every compared column is MATCH or COGNOS_BLANK-with-nothing-to-compare
  /** Same value as the LEAVE TYPE entry in `comparisons` — exposed directly so callers
   * (TAA_LEAVE_TYPE_RECOMPUTED/MATCH_BASIS) never need to re-find/re-parse it. */
  leaveTypeRecomputed: string;
  leaveTypeMatchBasis: LeaveTypeMatchBasis;
}

function formatBlock(b: ScheduleBlock | null): string {
  if (!b) return '';
  return `${formatTimeHHMM(b.start)} - ${formatTimeHHMM(b.end)}`;
}

function parseCognosBlock(str: string): { startMin: number; endMin: number } | null {
  const match = (str || '').trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = parseClockTimeString(match[1]);
  const end = parseClockTimeString(match[2]);
  if (!start || !end) return null;
  return { startMin: start.hours * 60 + start.minutes, endMin: end.hours * 60 + end.minutes };
}

/**
 * parseHHMMToMinutes() returns 0 for an empty string — correct for "no
 * variance" contexts, wrong here: a blank Cognos cell means NO VALUE, not a
 * real 0:00. Comparing blank-as-0 against a nonzero recompute produced a
 * false MISMATCH and silently defeated the fill-if-blank rule (a column can
 * only be "filled" if it is first recognised as genuinely blank).
 */
function parseBlankableHHMM(s: string): number | null {
  if (!s || !s.trim()) return null;
  const match = s.trim().match(/^(-)?\d+:(\d{1,2})$/);
  if (!match || parseInt(match[2], 10) > 59) return null;
  return parseHHMMToMinutes(s);
}

function timeOfDayDiffMinutes(aMin: number, bMin: number): number {
  const diff = Math.abs(aMin - bMin);
  return Math.min(diff, 1440 - diff); // wrap-aware, e.g. 23:58 vs 00:02
}

function blockMatches(cognosBlock: string, recomputed: ScheduleBlock | null, toleranceMin: number): ColumnComparisonStatus {
  const parsedCognos = parseCognosBlock(cognosBlock);
  if ((cognosBlock || '').trim() && !parsedCognos) return 'MISMATCH';
  if (!parsedCognos && !recomputed) return 'NOT_COMPARABLE';
  if (!parsedCognos && recomputed) return 'COGNOS_BLANK'; // ASPECT has a block Cognos never captured
  if (parsedCognos && !recomputed) return 'MISMATCH'; // Cognos lists a block ASPECT does not evidence
  const recStartMin = (recomputed as ScheduleBlock).start.getHours() * 60 + (recomputed as ScheduleBlock).start.getMinutes();
  const recEndMin = (recomputed as ScheduleBlock).end.getHours() * 60 + (recomputed as ScheduleBlock).end.getMinutes();
  const startOk = timeOfDayDiffMinutes(parsedCognos!.startMin, recStartMin) <= toleranceMin;
  const endOk = timeOfDayDiffMinutes(parsedCognos!.endMin, recEndMin) <= toleranceMin;
  return startOk && endOk ? 'MATCH' : 'MISMATCH';
}

function minutesColumn(
  column: string,
  cognosRaw: string,
  recomputedMinutes: number | null,
  toleranceMin: number,
  parseCognos: (s: string) => number | null,
  fillIfBlank: boolean,
  treatPopulatedNullAsInvalid: boolean = true,
  /** Defect fix (D7): true for the columns whose recompute derives from CMS punch
   * evidence (SIGNIN DURATION, LATE START, LEFT EARLY) — when the caller passes true
   * AND recomputedMinutes is null ONLY because this Login ID has no CMS record
   * anywhere in the export, that is missing evidence, not a disagreement to flag. */
  missingCmsEvidence: boolean = false,
  /** When set, display the recomputed value as this block's "HH:MM - HH:MM" range
   * instead of a duration — used only by OT1/OT-2, only when the day's OT resolves to
   * exactly one contiguous window. Display-only: the match/mismatch check below still
   * compares minutes, never the block, so this cannot change MATCH/MISMATCH/COGNOS_BLANK
   * status, only how the recomputed value is printed. */
  rangeBlockForDisplay: ScheduleBlock | null = null,
): ColumnComparison {
  const cognosVal = parseCognos(cognosRaw);
  const recomputedFormatted = recomputedMinutes === null
    ? ''
    : (rangeBlockForDisplay ? formatBlock(rangeBlockForDisplay) : formatMinutesToHHMM(recomputedMinutes));

  if (treatPopulatedNullAsInvalid && (cognosRaw || '').trim() && cognosVal === null) {
    return { column, cognosRaw, recomputedRaw: recomputedFormatted, recomputedMinutes: recomputedMinutes ?? undefined, status: 'MISMATCH', note: 'Cognos value is not a valid time/duration format' };
  }

  if (cognosVal === null && recomputedMinutes === null) {
    return { column, cognosRaw, recomputedRaw: recomputedFormatted, status: 'NOT_COMPARABLE' };
  }
  if (cognosVal === null && recomputedMinutes !== null) {
    return {
      column,
      cognosRaw,
      recomputedRaw: recomputedFormatted,
      recomputedMinutes,
      status: 'COGNOS_BLANK',
      note: fillIfBlank ? 'Structurally blank in Cognos — filled from recompute' : 'Cognos never captured this value',
    };
  }
  if (cognosVal !== null && recomputedMinutes === null) {
    return missingCmsEvidence
      ? { column, cognosRaw, recomputedRaw: '', status: 'NOT_COMPARABLE', note: 'No CMS record exists anywhere in the export for this Login ID — missing evidence, not a disagreement' }
      : { column, cognosRaw, recomputedRaw: '', status: 'MISMATCH', note: 'Cognos has a value but recompute found none' };
  }
  const match = Math.abs((cognosVal as number) - (recomputedMinutes as number)) <= toleranceMin;
  return {
    column,
    cognosRaw,
    recomputedRaw: recomputedFormatted,
    recomputedMinutes: recomputedMinutes as number,
    status: match ? 'MATCH' : 'MISMATCH',
  };
}

function timeOfDayColumn(column: string, cognosRaw: string, recomputedDt: Date | null, toleranceMin: number, hasAnyCmsData: boolean): ColumnComparison {
  const recomputedFormatted = recomputedDt ? formatTimeHHMM(recomputedDt) : '';
  const cognosTrim = (cognosRaw || '').trim();
  if (!cognosTrim && !recomputedDt) return { column, cognosRaw, recomputedRaw: recomputedFormatted, status: 'NOT_COMPARABLE' };
  if (!cognosTrim && recomputedDt) return { column, cognosRaw, recomputedRaw: recomputedFormatted, status: 'COGNOS_BLANK' };
  if (cognosTrim && !recomputedDt) {
    // Defect fix (D7): a CMS Login ID with NO record anywhere in the export is missing
    // evidence, not a disagreement — the recompute has nothing to compare Cognos's value
    // against, through no fault of the reconciliation. Only when the export DOES hold data
    // for this login (just nothing landed inside this window's search radius) is the gap a
    // genuine, worth-flagging mismatch.
    return hasAnyCmsData
      ? { column, cognosRaw, recomputedRaw: '', status: 'MISMATCH', note: 'No CMS evidence found for recompute' }
      : { column, cognosRaw, recomputedRaw: '', status: 'NOT_COMPARABLE', note: 'No CMS record exists anywhere in the export for this Login ID — missing evidence, not a disagreement' };
  }
  const parsedClock = parseClockTimeString(cognosTrim);
  if (!parsedClock) return { column, cognosRaw, recomputedRaw: recomputedFormatted, status: 'MISMATCH', note: 'Cognos value is not a valid HH:MM wall-clock time' };
  const cognosMin = parsedClock.hours * 60 + parsedClock.minutes;
  const recMin = (recomputedDt as Date).getHours() * 60 + (recomputedDt as Date).getMinutes();
  const diff = timeOfDayDiffMinutes(cognosMin, recMin);
  return {
    column,
    cognosRaw,
    recomputedRaw: recomputedFormatted,
    status: diff <= toleranceMin ? 'MATCH' : 'MISMATCH',
    note: diff > toleranceMin ? 'Cognos time-of-day loses the calendar date on cross-midnight shifts — verify against TAA_CMS_IN/OUT, not this column' : undefined,
  };
}

/**
 * Detects a Cognos LATE START / LEFT EARLY sentinel — a placeholder Cognos
 * emits when there is no real attendance to compare (leave/absence days),
 * not a genuine measured variance. Real data shows the sentinel is always
 * exactly -LEAVE HR (e.g. -480 for an 8h day, -540 for a 9h day) — a fixed
 * value list alone silently misses any other shift length (e.g. -600).
 */

/**
 * True when Cognos itself claims the employee attended this day — any of
 * SIGIN IN, SIGIN OUT, or a genuine (non-zero) SIGNIN DURATION is present.
 * Used by the upload-time headcount mapping check (assessHeadcountMapping in
 * punchAttribution.ts) to find rows where Cognos says "this person was here"
 * but the CMS export has zero punches for them — the one payroll-risk case,
 * as opposed to a row where Cognos itself already reports no attendance.
 *
 * Deliberately separate from noRecordedAttendance (used inline at
 * isCognosSentinel below and in compareCognosRow) — that check only tests
 * SIGIN IN/SIGIN OUT and drives live column-comparison/sentinel logic that is
 * out of scope here. Widening it to include SIGNIN DURATION would change
 * payroll-facing verdicts; this function exists so the headcount statistic
 * can use a three-field claim without touching that behavior.
 */
export function cognosClaimsAttendance(cognos: CognosRecord): boolean {
  if ((cognos['SIGIN IN'] || '').trim()) return true;
  if ((cognos['SIGIN OUT'] || '').trim()) return true;
  const dur = (cognos['SIGNIN DURATION'] || '').trim();
  // Cognos emits a literal "00:00" duration (paired with blank SIGIN IN/OUT)
  // to mean "never signed in" — see the noRecordedAttendance comment below and
  // at compareCognosRow's SIGNIN DURATION handling. Treating "00:00" as a
  // claim of attendance would invent a false discrepancy in the headcount
  // mapping check.
  return !!dur && !/^0+(:0+)?$/.test(dur);
}

export function isCognosSentinel(value: number | null, cognos: CognosRecord, config: ConfigRegistry): boolean {
  if (value === null) return false;
  const mode = config.cognosSentinelDetectionMode || 'both';
  const sentinels = config.cognosSentinelValues || [-480, -540];
  const byList = sentinels.includes(value);

  const leaveHrRaw = (cognos['LEAVE HR'] || '').trim();
  const leaveHr = /^\d+$/.test(leaveHrRaw) ? Number(leaveHrRaw) : NaN;
  const byNegatedLeaveHr = !isNaN(leaveHr) && leaveHr > 0 && value === -leaveHr;

  if (mode === 'valueList') return byList;
  if (mode === 'negatedLeaveHr') return byNegatedLeaveHr;

  // 'both' (default): either numeric rule, OR no real attendance was ever
  // recorded — a value computed with no SIGIN IN/SIGIN OUT can never be a
  // genuine variance to compare, whatever number it happens to be.
  const noRecordedAttendance = !(cognos['SIGIN IN'] || '').trim() && !(cognos['SIGIN OUT'] || '').trim();
  return byList || byNegatedLeaveHr || noRecordedAttendance;
}

interface LeaveTypeResolution {
  status: ColumnComparisonStatus;
  recomputed: string;
  basis: LeaveTypeMatchBasis;
  note?: string;
}

/**
 * LEAVE TYPE matching (§Leave Segments). Evaluates every actual ASPECT leave code
 * identified on the day against Cognos's single LEAVE TYPE value, in order:
 *   1. EXACT       — Cognos value equals an identified leave code verbatim
 *   2. MAPPED       — a configured cognosLeaveTypeMappings entry connects them
 *   3. NON_WORKING  — no identified leave, but Cognos names a configured non-working
 *                     (not-leave) code the day also carries — the OFF case: OFF is
 *                     never reported as a leave type, but Cognos saying "OFF" against
 *                     an ASPECT OFF day is a genuine day-off agreement, not a mismatch.
 *   4/5. Cognos populated with nothing above firing -> MISMATCH, except when no leave
 *        is identified at all, where a shared absence-verdict spelling (e.g. Cognos
 *        "U-ABSENT" vs TAA's own "Absent NS/NC") still counts as VERDICT agreement.
 *   6. Cognos blank, leave identified -> COGNOS_BLANK.
 *   7. Neither side reports leave -> NOT_COMPARABLE.
 * Deterministic candidate selection (steps 4/6's displayed "best guess", and ties within
 * a mapping): exact match first, then a mapped code in mapping-list order, then a
 * specific non-generic code in normalized alphabetical order, generic LEAVE only when
 * nothing specific exists — so the display never depends on ASPECT export row order.
 */
function resolveLeaveTypeMatch(
  cognosLeaveTypeRaw: string,
  identifiedLeaveCodes: string[],
  nonWorkingCodes: string[],
  attendanceVerdictLabel: string,
  mappings: CognosLeaveTypeMapping[],
  genericContainerCodes: Set<string>,
  verdictValues: Set<string>,
  fullDayRemovalCodes: string[] = [],
): LeaveTypeResolution {
  const cognosLeaveType = cognosLeaveTypeRaw.trim();
  const cognosUpper = cognosLeaveType.toUpperCase();
  const uniqueCandidates = Array.from(new Set(identifiedLeaveCodes.map(c => (c || '').trim()).filter(Boolean)));
  const sortedCandidates = [...uniqueCandidates].sort((a, b) => a.localeCompare(b));
  const specificCandidates = sortedCandidates.filter(c => !genericContainerCodes.has(c.toUpperCase()));
  const bestGuess = specificCandidates[0] || sortedCandidates[0] || '';

  // 1. EXACT
  const exactMatch = uniqueCandidates.find(c => c.toUpperCase() === cognosUpper);
  if (cognosUpper && exactMatch) {
    return { status: 'MATCH', recomputed: exactMatch, basis: 'EXACT' };
  }

  // 2. MAPPED
  if (cognosUpper) {
    const mapping = mappings.find(m => (m.cognosLeaveType || '').trim().toUpperCase() === cognosUpper);
    if (mapping) {
      const mappedTargetsUpper = (mapping.aspectSegmentCodes || []).map(c => (c || '').trim().toUpperCase());
      const mappedMatch = sortedCandidates
        .slice()
        .sort((a, b) => mappedTargetsUpper.indexOf(a.toUpperCase()) - mappedTargetsUpper.indexOf(b.toUpperCase()))
        .find(c => mappedTargetsUpper.includes(c.toUpperCase()));
      if (mappedMatch) return { status: 'MATCH', recomputed: mappedMatch, basis: 'MAPPED' };
    }
  }

  // 3. NON_WORKING — only when no identified leave exists (OFF is never leave)
  if (cognosUpper && uniqueCandidates.length === 0) {
    const nonWorkingMatch = nonWorkingCodes.find(c => (c || '').trim().toUpperCase() === cognosUpper);
    if (nonWorkingMatch) {
      return {
        status: 'MATCH',
        recomputed: nonWorkingMatch,
        basis: 'NON_WORKING',
        note: `Both sides show a scheduled day off ("${nonWorkingMatch}") — not a leave type`,
      };
    }
  }

  // 3.5. REMOVAL_CODE — Cognos names the day's own full-day removal segment (e.g. "TRN
  // New Hires"): that segment is a removal code, not leave, so it never reaches
  // identifiedLeaveCodes above, but Cognos reporting it here is still agreement, not a
  // mismatch.
  if (cognosUpper) {
    const removalMatch = fullDayRemovalCodes.find(c => (c || '').trim().toUpperCase() === cognosUpper);
    if (removalMatch) {
      return {
        status: 'MATCH',
        recomputed: removalMatch,
        basis: 'REMOVAL_CODE',
        note: "Cognos leave type is the day's full-day removal segment in ASPECT",
      };
    }
  }

  // 4. Cognos populated, identified leave exists, nothing above fired
  if (cognosUpper && uniqueCandidates.length > 0) {
    return { status: 'MISMATCH', recomputed: bestGuess, basis: 'NONE' };
  }

  // 5. Cognos populated, no identified leave, no non-working match — verdict fallback
  if (cognosUpper && uniqueCandidates.length === 0) {
    const cognosIsVerdict = verdictValues.has(cognosUpper);
    const recomputedIsVerdict = !!attendanceVerdictLabel && verdictValues.has(attendanceVerdictLabel.toUpperCase());
    if (cognosIsVerdict && recomputedIsVerdict) {
      return {
        status: 'MATCH',
        recomputed: attendanceVerdictLabel,
        basis: 'VERDICT',
        note: `Both sides report an absence verdict ("${cognosLeaveType}" vs "${attendanceVerdictLabel}") — same conclusion, different value spelling`,
      };
    }
    return { status: 'MISMATCH', recomputed: attendanceVerdictLabel || '', basis: 'NONE' };
  }

  // 6. Cognos blank, leave identified
  if (!cognosUpper && uniqueCandidates.length > 0) {
    return { status: 'COGNOS_BLANK', recomputed: bestGuess, basis: 'NONE' };
  }

  // 7. Neither side reports leave
  return { status: 'NOT_COMPARABLE', recomputed: '', basis: 'NONE' };
}

/**
 * Phase 3 — recompute-then-compare. This is the core deliverable: every
 * relevant Cognos column gets its own recomputed value and an explicit
 * MATCH / MISMATCH / COGNOS_BLANK / NOT_COMPARABLE status, instead of the
 * previous three ad-hoc heuristics collapsed into one boolean.
 */
export function compareCognosRow(cognos: CognosRecord, ctx: ComparisonContext, config: ConfigRegistry): RowComparisonResult {
  const tol = config.comparisonToleranceMinutes ?? 1;
  const fillColumns = new Set(config.cognosBlankFillColumns || []);
  // Leave day (§Non-negotiables, user-confirmed): Cognos prints the paid-leave
  // entitlement (e.g. DUTY1 06:00-14:00, SCH DURATION 8:0) as roster context,
  // not a shift ASPECT ever schedules — comparing them is a guaranteed false
  // mismatch on a perfectly correct row. Default: suppress those 3 columns.
  const suppressScheduleColumns = ctx.isLeaveDay && !config.compareScheduleColumnsOnLeaveDays;

  const comparisons: ColumnComparison[] = [];

  // Hold Policy shift folding (doc/PRD.md §Hold Policy, Design review point 2): when DUTY1
  // mismatches, capture how many minutes its start/end moved so LATE START / LEFT EARLY can
  // be folded into the 'SHIFT' policy group below when their own gap equals that move (±tol)
  // — a late-arrival number that is fully explained by a roster shift change, not a separate
  // disagreement. null when DUTY1 doesn't parse on both sides (nothing to fold against).
  let duty1StartMoveMin: number | null = null;
  let duty1EndMoveMin: number | null = null;
  // Flex roster translation (held-review reduction, 2026-09-27): signed minutes ASPECT's
  // DUTY1 start moved relative to Cognos's (+ => ASPECT later), set ONLY for a flex
  // employee whose DUTY1 differs from Cognos by a pure translation — same shift length
  // (±tol), start and end moved by the same amount. Cognos prints a flex employee's fixed
  // BASE roster (e.g. 07:00-15:00 every day) while ASPECT holds the flex-moved shift of
  // the same length, and doc/PRD.md §4.8 measures flex attendance against the ASPECT shift
  // by design — so the whole difference is a known Cognos reporting basis, not a
  // disagreement about what happened. Measured on the real 23/09 sample: 43 of 50
  // SHIFT-only MISMATCH_FOUND holds were exactly this shape. null => no downgrade.
  let flexRosterShiftMin: number | null = null;
  let flexRosterEndShiftMin: number | null = null;

  // Schedule-definition columns
  if (suppressScheduleColumns) {
    comparisons.push({ column: 'DUTY1', cognosRaw: cognos['DUTY1'] || '', recomputedRaw: formatBlock(ctx.duty1Block), status: 'NOT_COMPARABLE', note: 'Leave day — Cognos shows the paid-leave roster entitlement, not a shift to attend' });
    comparisons.push({ column: 'DUTY-2', cognosRaw: cognos['DUTY-2'] || '', recomputedRaw: formatBlock(ctx.duty2Block), status: 'NOT_COMPARABLE', note: 'Leave day — Cognos shows the paid-leave roster entitlement, not a shift to attend' });
  } else {
    const duty1Status = blockMatches(cognos['DUTY1'] || '', ctx.duty1Block, tol);
    comparisons.push({
      column: 'DUTY1',
      cognosRaw: cognos['DUTY1'] || '',
      recomputedRaw: formatBlock(ctx.duty1Block),
      status: duty1Status,
    });
    if (duty1Status === 'MISMATCH') {
      const parsedDuty1 = parseCognosBlock(cognos['DUTY1'] || '');
      if (parsedDuty1 && ctx.duty1Block) {
        const recStartMin = ctx.duty1Block.start.getHours() * 60 + ctx.duty1Block.start.getMinutes();
        const recEndMin = ctx.duty1Block.end.getHours() * 60 + ctx.duty1Block.end.getMinutes();
        duty1StartMoveMin = timeOfDayDiffMinutes(parsedDuty1.startMin, recStartMin);
        duty1EndMoveMin = timeOfDayDiffMinutes(parsedDuty1.endMin, recEndMin);
        const signedWrap = (d: number) => ((d % 1440) + 2160) % 1440 - 720; // -> [-720, 720)
        const startShift = signedWrap(recStartMin - parsedDuty1.startMin);
        const endShift = signedWrap(recEndMin - parsedDuty1.endMin);
        // Kill switch (releaseProvenSafeHolds): when off, flexRosterShiftMin stays null and
        // DUTY1 / LATE START / LEFT EARLY stay MISMATCH exactly as before.
        if (config.releaseProvenSafeHolds && ctx.isFlex && Math.abs(startShift - endShift) <= tol) {
          flexRosterShiftMin = startShift;
          flexRosterEndShiftMin = endShift;
          comparisons[comparisons.length - 1] = {
            ...comparisons[comparisons.length - 1],
            status: 'NOT_COMPARABLE',
            note: `Flex staff: Cognos prints the base roster; ASPECT holds the same-length shift moved ${startShift > 0 ? 'later' : 'earlier'} by ${Math.abs(startShift)}m, which TAA measures against by design (PRD §4.8)`,
          };
        }
      }
    }
    comparisons.push({
      column: 'DUTY-2',
      cognosRaw: cognos['DUTY-2'] || '',
      recomputedRaw: formatBlock(ctx.duty2Block),
      status: blockMatches(cognos['DUTY-2'] || '', ctx.duty2Block, tol),
    });
  }
  comparisons.push(
    minutesColumn('OT1', cognos['OT1'] || '', ctx.ot1Minutes, tol, parseBlankableHHMM, fillColumns.has('OT1'), true, false, ctx.ot1Block)
  );
  comparisons.push(
    minutesColumn('OT-2', cognos['OT-2'] || '', ctx.ot2Minutes, tol, parseBlankableHHMM, fillColumns.has('OT-2'), true, false, ctx.ot2Block)
  );

  // Calculated attendance columns.
  // SCH DURATION is the FULL net schedule: every ADDITION segment (SHIFT, COVER, OT1, OT2 and
  // any custom ADDITION code) minus every REMOVAL segment (release, nursing, ...), as the
  // Segment Glossary roles define them — the very figure behind TAA_SCH_HOURS_RECOMPUTED, so
  // this column and the pay figure can never drift apart (decision 2026-09-20).
  //
  // History: an earlier "D10" fix compared against duty1Block's time SPAN instead, because
  // Cognos's own SCH DURATION does not include overtime. A span cannot see extra ADDITION
  // segments at all (REEM 16/09: COVER 48+6+5 = 59 min left the column at 07:00 while the net
  // was 07:59 and Cognos 7:58), and it ignored releases until they were bolted on. Measured on
  // the real sample data, the net matches Cognos on plain days as well as the span did and on
  // COVER days far better (Cognos runs one minute under on many cover rows, which the
  // comparison tolerance absorbs). Cognos leaving OT out is a Cognos defect, not a rule to
  // copy — on an OT day this column therefore MISMATCHes by design, and says why below.
  const schDurationRecomputed = ctx.netScheduledMinutes;
  if (suppressScheduleColumns) {
    comparisons.push({ column: 'SCH DURATION', cognosRaw: cognos['SCH DURATION'] || '', recomputedRaw: formatMinutesToHHMM(schDurationRecomputed), status: 'NOT_COMPARABLE', note: 'Leave day — Cognos shows the paid-leave roster entitlement, not a shift to attend' });
  } else {
    const schDurationComparison = minutesColumn('SCH DURATION', cognos['SCH DURATION'] || '', schDurationRecomputed, tol, parseCognosHMinutes, false);
    if (schDurationComparison.status === 'MISMATCH') {
      // Explain WHY, most specific first. Display text only — status, verdict and holds are
      // decided elsewhere and never read this note. Causes measured on the real sample data.
      const cognosSch = parseCognosHMinutes(cognos['SCH DURATION'] || '');
      const gap = cognosSch === null ? null : cognosSch - schDurationRecomputed; // + => Cognos higher
      if (ctx.ot1Minutes + ctx.ot2Minutes > 0) {
        schDurationComparison.note = 'TAA counts OT1/OT2 in the scheduled duration; Cognos SCH DURATION leaves overtime out.';
      } else if (gap !== null && gap > 0 && ctx.removalMinutes > 0 && Math.abs(gap - ctx.removalMinutes) <= tol) {
        schDurationComparison.note = `Cognos SCH DURATION did not deduct the ${ctx.removalMinutes}m release/nursing/split that ASPECT records for this day.`;
      } else if (gap !== null && gap > 0 && ctx.removalMinutes > 0 && gap < ctx.removalMinutes) {
        schDurationComparison.note = `Cognos SCH DURATION is ${gap}m higher; ASPECT records ${ctx.removalMinutes}m of release/nursing/split — Cognos likely did not deduct all of it.`;
      } else if (gap !== null && gap < 0 && ctx.lateSegmentMinutes > 0 && ctx.coverMinutes > 0 && Math.abs(-gap - ctx.coverMinutes) <= tol) {
        // Same exception as the engine's Gate B gapIsWholeCover: the gap is the whole COVER.
        schDurationComparison.note = `Cognos SCH DURATION leaves out the whole ${ctx.coverMinutes}m make-up COVER ASPECT records for the ${ctx.lateSegmentMinutes}m LATE — the COVER was probably added after the Cognos extract.`;
      } else if (gap !== null && gap !== 0 && ctx.lateSegmentMinutes > 0 && Math.abs(gap) <= ctx.lateSegmentMinutes + tol) {
        schDurationComparison.note = `Differs by about the LATE make-up minutes (${ctx.lateSegmentMinutes}m) — the ASPECT and Cognos extracts likely disagree on whether the make-up COVER exists yet.`;
      } else if (gap !== null && gap < 0 && ctx.coverMinutes > 0 && Math.abs(gap) <= ctx.coverMinutes + tol) {
        schDurationComparison.note = `ASPECT records ${ctx.coverMinutes}m of COVER that Cognos SCH DURATION does not fully include — the COVER was probably added after the Cognos extract.`;
      }

      // Downgrade MISMATCH -> NOT_COMPARABLE, but ONLY when the whole gap is exactly
      // (within tol) explained by one known, deliberate Cognos omission — never for the
      // partial cases above (COVER not fully included, LATE make-up, release not fully
      // deducted), which stay MISMATCH because the gap is not fully accounted for.
      const otMinutes = ctx.ot1Minutes + ctx.ot2Minutes;
      // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this downgrade
      // never fires and the row stays MISMATCH/held exactly as it did before Phase 3.
      const otExactMatch = config.releaseProvenSafeHolds && otMinutes > 0 && gap !== null && Math.abs(-gap - otMinutes) <= tol;
      const releaseExactMatch = config.releaseProvenSafeHolds && otMinutes === 0 && gap !== null && gap > 0 && ctx.removalMinutes > 0 && Math.abs(gap - ctx.removalMinutes) <= tol;
      if (otExactMatch) {
        schDurationComparison.status = 'NOT_COMPARABLE';
        schDurationComparison.note = `Cognos SCH DURATION excludes the ${otMinutes}m overtime TAA includes — exact match otherwise.`;
      } else if (releaseExactMatch) {
        schDurationComparison.status = 'NOT_COMPARABLE';
        schDurationComparison.note = `Cognos did not deduct the ${ctx.removalMinutes}m release/nursing — exact match otherwise.`;
      }
    }
    comparisons.push(schDurationComparison);
  }

  // Cognos emits the literal "00:00" for SIGNIN DURATION (paired with blank
  // SIGIN IN/SIGIN OUT) to mean "employee never signed in" — not a genuine
  // zero-length duration. Same noRecordedAttendance signal as isCognosSentinel().
  const noRecordedAttendance = !(cognos['SIGIN IN'] || '').trim() && !(cognos['SIGIN OUT'] || '').trim();
  const parseSigninDuration = (s: string): number | null => (noRecordedAttendance ? null : parseBlankableHHMM(s));

  const signinDurationMinutes =
    ctx.actualFirstLogin && ctx.actualLastLogout
      ? Math.max(0, Math.floor((ctx.actualLastLogout.getTime() - ctx.actualFirstLogin.getTime()) / 60000))
      : null;
  const signinDurationComparison = minutesColumn('SIGNIN DURATION', cognos['SIGNIN DURATION'] || '', signinDurationMinutes, tol, parseSigninDuration, false, !noRecordedAttendance, !ctx.hasAnyCmsData);
  // Verified against 294 real worked rows: Cognos's SIGNIN DURATION measures STAFFED
  // (logged-in) time, TAA can only measure first-punch-to-last-punch SPAN from discrete
  // CMS punches (doc/PRD.md — no session boundaries in the export). Cognos's figure is
  // shorter than the span in 163/294 rows (mid-shift breaks it excludes and TAA cannot
  // see), equal in 130, longer in just 1 — a one-directional gap between two different
  // quantities, not a disagreement. Only downgrade the case where BOTH sides parsed to a
  // real value (a genuine MATCH or the quantity-mismatch MISMATCH) — leave every other
  // status (COGNOS_BLANK, sentinel NOT_COMPARABLE, missing-evidence MISMATCH,
  // invalid-format MISMATCH) exactly as computed, since those are real data gaps, not
  // this quantity gap.
  //
  // Former "narrowed exception" (19 real rows, samples_Files/Cognos_DescrepencyReport.csv)
  // treated every Cognos-0-but-MISMATCH row as a genuine Cognos calculation failure. Real
  // evidence from the full sample set overturns that: ALL 21 real rows where Cognos emits
  // SIGNIN DURATION 00:00 have a CMS staffed (login->logout summed, ctx.staffedMinutes)
  // time of 0-1 minute — every one of them is a pair of instantaneous swipe events (in and
  // out punched together), not a real logged-in session. Cognos's own SIGIN IN/SIGIN OUT
  // being hours apart in those rows is the first-to-last SPAN (exactly what
  // signinDurationMinutes above also measures) — not evidence Cognos "meant" to report a
  // nonzero duration and failed to. So: Cognos 0 + staffed time within tolerance of 0 is
  // Cognos correctly reporting "no real signed-in duration" for instantaneous swipes, and
  // downgrades to MATCH exactly like the staffed-vs-span case below. Cognos 0 is still a
  // genuine calculation failure — and stays MISMATCH — only when ctx.staffedMinutes is
  // null (no CMS evidence to confirm either way) or > tol (a real session existed and
  // Cognos still reported 00:00).
  const cognosSigninMinutes = parseSigninDuration(cognos['SIGNIN DURATION'] || '');
  const bothSigninValuesParsed = cognosSigninMinutes !== null && signinDurationMinutes !== null;
  // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this downgrade
  // never fires and a Cognos-0-but-MISMATCH row stays MISMATCH/held as before Phase 1.
  const cognosZeroButStaffedConfirmsInstantaneous =
    config.releaseProvenSafeHolds &&
    cognosSigninMinutes === 0 && signinDurationComparison.status === 'MISMATCH' &&
    ctx.staffedMinutes !== null && ctx.staffedMinutes <= tol;
  const cognosZeroDurationMismatch =
    cognosSigninMinutes === 0 && signinDurationComparison.status === 'MISMATCH' &&
    !cognosZeroButStaffedConfirmsInstantaneous;
  const finalSigninDurationComparison: ColumnComparison = cognosZeroButStaffedConfirmsInstantaneous
    ? { ...signinDurationComparison, status: 'MATCH', note: 'Cognos 00:00 agrees with CMS staffed (login→logout summed) time — the punches are instantaneous swipe events, so the first-to-last span is not a signed-in duration' }
    : cognosZeroDurationMismatch
    ? { ...signinDurationComparison, note: 'Cognos reports SIGNIN DURATION 00:00 despite real SIGIN IN/SIGIN OUT values hours apart — a Cognos duration-calculation failure, not a staffed-vs-span quantity difference' }
    : bothSigninValuesParsed && (signinDurationComparison.status === 'MATCH' || signinDurationComparison.status === 'MISMATCH')
    ? { ...signinDurationComparison, status: 'NOT_COMPARABLE', note: 'Cognos measures staffed (logged-in) time, excluding mid-shift gaps; TAA measures first-to-last punch span from discrete CMS punches — different quantities, not a disagreement' }
    : signinDurationComparison;
  // Phase 9 (informational only, user-confirmed): append the CMS staffed
  // (login->logout summed) duration to whichever note above was chosen —
  // never changes `status`, never replaces the note, purely appends display
  // text so a reviewer sees both quantities side by side. See ResultsView.tsx
  // for where this reaches the trace modal.
  const staffedNote = ctx.staffedMinutes !== null
    ? `CMS staffed (login→logout summed) time: ${formatMinutesToHHMM(ctx.staffedMinutes)}.`
    : null;
  comparisons.push(
    staffedNote
      ? { ...finalSigninDurationComparison, note: finalSigninDurationComparison.note ? `${finalSigninDurationComparison.note} ${staffedNote}` : staffedNote }
      : finalSigninDurationComparison
  );

  comparisons.push(timeOfDayColumn('SIGIN IN', cognos['SIGIN IN'] || '', ctx.actualFirstLogin, tol, ctx.hasAnyCmsData));
  comparisons.push(timeOfDayColumn('SIGIN OUT', cognos['SIGIN OUT'] || '', ctx.actualLastLogout, tol, ctx.hasAnyCmsData));

  // LATE START / LEFT EARLY: recomputed using Cognos's OWN documented raw-window
  // formula (rawStart - actualLogin / actualLogout - rawEnd) so this compares
  // like-for-like — did Cognos's own arithmetic match reality, independent of
  // the release/nursing-adjusted EFFECTIVE window that drives the verdict.
  // Verified against 294 real worked non-leave rows before considering a flex-shifted
  // alternative anchor: this raw anchor fits 194 (66%), an arrival-snapped "flex" anchor
  // fits only 88 (30%), 64 (22%) fit neither — real Cognos data is not self-consistent
  // here (same conclusion the SCH DURATION formula below already documents). The one
  // real WFM-FLEX employee in the sample data (login 68858, arrived 09:26 vs 07:00
  // schedule) matches the RAW anchor exactly (LATE START -146, LEFT EARLY 206) — do
  // NOT make this flex-aware without new evidence; it would trade a 66% fit for a 30% one.
  const parseSignedInt = (s: string): number | null => {
    const trimmed = (s || '').trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
  };

  // Same-direction downgrade (Phase 1, held-review reduction, 2026-09-24): a MISMATCH
  // where BOTH sides already agree on the yes/no question this column exists to answer
  // (not late / not left early) is not a real disagreement — the leftover minute gap is
  // Cognos measuring from session data (SIGIN IN/OUT wall-clock stamps) that TAA cannot
  // see behind a CMS punch export. Only downgrades a genuine MISMATCH (both values parsed
  // as real numbers); a sign flip (one side says "late/left early", the other doesn't) or
  // both-negative values are a real disagreement and stay MISMATCH untouched. For LEFT
  // EARLY specifically, also require both values to reach the SAME policy outcome on TAA's
  // own basis (logoutOutcomeMatchesTaa: release-adjusted end, COVER credit, the employee's
  // tier and the live Early/Late Logout rules — never a hardcoded 60). The earlier raw-figure
  // band test missed pairs that straddle the band once the trailing release is applied
  // (reg-189). A 3-vs-11 gap below the band is still as cosmetic as a 200-vs-206 gap above
  // it. LATE START has no analogous "arriving early" band in the live config (Late Login
  // only bands LATE arrivals, i.e. the negative side of this column) — arriving early by
  // any amount never fires a rule, so same-direction non-negative alone is enough there.
  const cognosLateStart = ctx.rawStart && ctx.actualFirstLogin
    ? Math.floor((ctx.rawStart.getTime() - ctx.actualFirstLogin.getTime()) / 60000)
    : null;
  const lateStartRawVal = parseSignedInt(cognos['LATE START'] || '');
  if (isCognosSentinel(lateStartRawVal, cognos, config)) {
    comparisons.push({ column: 'LATE START', cognosRaw: cognos['LATE START'] || '', recomputedRaw: cognosLateStart !== null ? String(cognosLateStart) : '', status: 'NOT_COMPARABLE', note: 'Cognos sentinel value (not a real variance — no attendance recorded to measure against)' });
  } else {
    const lateStartComparison = minutesColumn('LATE START', cognos['LATE START'] || '', cognosLateStart, tol, parseSignedInt, false, true, !ctx.hasAnyCmsData);
    // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this same-direction
    // downgrade never fires and the row stays MISMATCH/held as before Phase 1.
    comparisons.push(
      config.releaseProvenSafeHolds && lateStartComparison.status === 'MISMATCH' && lateStartRawVal !== null && cognosLateStart !== null && lateStartRawVal >= 0 && cognosLateStart >= 0
        ? { ...lateStartComparison, status: 'NOT_COMPARABLE', note: 'Both agree: not late — the minute gap comes from Cognos session data TAA cannot see' }
        : lateStartComparison
    );
  }

  const cognosLeftEarly = ctx.rawEnd && ctx.actualLastLogout
    ? Math.floor((ctx.actualLastLogout.getTime() - ctx.rawEnd.getTime()) / 60000)
    : null;
  const leftEarlyRawVal = parseSignedInt(cognos['LEFT EARLY'] || '');
  if (isCognosSentinel(leftEarlyRawVal, cognos, config)) {
    comparisons.push({ column: 'LEFT EARLY', cognosRaw: cognos['LEFT EARLY'] || '', recomputedRaw: cognosLeftEarly !== null ? String(cognosLeftEarly) : '', status: 'NOT_COMPARABLE', note: 'Cognos sentinel value (not a real variance — no attendance recorded to measure against)' });
  } else {
    const leftEarlyComparison = minutesColumn('LEFT EARLY', cognos['LEFT EARLY'] || '', cognosLeftEarly, tol, parseSignedInt, false, true, !ctx.hasAnyCmsData);
    // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this same-direction
    // downgrade never fires and the row stays MISMATCH/held as before Phase 1.
    // Same-basis fix (2026-09-27): the two figures must reach the same policy outcome on TAA's
    // own basis (logoutOutcomeMatchesTaa), not merely sit in the same raw Late Logout band.
    const sameLogoutOutcome =
      config.releaseProvenSafeHolds &&
      leftEarlyRawVal !== null && cognosLeftEarly !== null && leftEarlyRawVal >= 0 && cognosLeftEarly >= 0 &&
      logoutOutcomeMatchesTaa(ctx, leftEarlyRawVal);
    comparisons.push(
      leftEarlyComparison.status === 'MISMATCH' && sameLogoutOutcome
        ? { ...leftEarlyComparison, status: 'NOT_COMPARABLE', note: 'Same logout outcome on TAA\'s basis (release-adjusted end, COVER credit, tier rules) — the minute gap comes from Cognos session data TAA cannot see' }
        : leftEarlyComparison
    );
  }

  // Leave columns (§Leave Segments) — see resolveLeaveTypeMatch for the matching order.
  const cognosLeaveType = (cognos['LEAVE TYPE'] || '').trim();
  const genericLeaveContainerCodes = new Set((config.genericLeaveContainerCodes || ['LEAVE']).map(c => c.toUpperCase()));
  const verdictValues = new Set((config.cognosLeaveTypeVerdictValues || ['U-ABSENT', 'Absent NS/NC', 'ABSENT']).map(v => v.toUpperCase()));
  const leaveTypeResolution = resolveLeaveTypeMatch(
    cognosLeaveType,
    ctx.identifiedLeaveCodes,
    ctx.nonWorkingCodes,
    ctx.attendanceVerdictLabel,
    config.cognosLeaveTypeMappings || [],
    genericLeaveContainerCodes,
    verdictValues,
    // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, the REMOVAL_CODE
    // match basis never fires (empty list) and the row falls through to MISMATCH/held as
    // before Phase 1.
    config.releaseProvenSafeHolds ? ctx.fullDayRemovalCodes : [],
  );
  comparisons.push({
    column: 'LEAVE TYPE',
    cognosRaw: cognosLeaveType,
    recomputedRaw: leaveTypeResolution.recomputed,
    status: leaveTypeResolution.status,
    note: leaveTypeResolution.note,
  });

  // LEAVE HR: only comparable when at least one identified leave segment carries real
  // ASPECT-recorded duration evidence (ctx.leaveMinutes — see ComparisonContext). Never
  // defaulted to a full day: the real Cognos sample shows ANNUAL at both 480 and 540
  // minutes, and OFF at 30/50 — no single default is safe, and OFF is never leave here
  // regardless (ctx.leaveMinutes only ever reflects config.leaveSegmentCodes segments).
  if (ctx.leaveMinutes === null) {
    comparisons.push({ column: 'LEAVE HR', cognosRaw: cognos['LEAVE HR'] || '', recomputedRaw: '', status: 'NOT_COMPARABLE', note: 'Full standard day by design (no ASPECT-recorded duration to compare)' });
  } else {
    comparisons.push(minutesColumn('LEAVE HR', cognos['LEAVE HR'] || '', ctx.leaveMinutes, tol, parseSignedInt, false));
  }

  // Stamp every comparison with its Hold Policy column group (default 'OTHER' for an
  // unmapped column). Then fold LATE START / LEFT EARLY into 'SHIFT' when their own gap
  // vs Cognos equals the DUTY1 start/end move captured above (±tol) — see the comment at
  // duty1StartMoveMin/duty1EndMoveMin. Only LATE START/LEFT EARLY entries are eligible;
  // every other column keeps its plain COLUMN_POLICY_GROUP mapping.
  const lateStartGapMin = lateStartRawVal !== null && cognosLateStart !== null ? Math.abs(lateStartRawVal - cognosLateStart) : null;
  const leftEarlyGapMin = leftEarlyRawVal !== null && cognosLeftEarly !== null ? Math.abs(leftEarlyRawVal - cognosLeftEarly) : null;
  const foldLateStart = duty1StartMoveMin !== null && lateStartGapMin !== null && Math.abs(lateStartGapMin - duty1StartMoveMin) <= tol;
  const foldLeftEarly = duty1EndMoveMin !== null && leftEarlyGapMin !== null && Math.abs(leftEarlyGapMin - duty1EndMoveMin) <= tol;
  // Flex roster translation, continued (see flexRosterShiftMin): Cognos measures LATE START
  // (roster start - login) and LEFT EARLY (logout - roster end) against the base roster, TAA
  // against the moved ASPECT shift — so on a pure translation each gap must equal the shift's
  // move EXACTLY, in the right direction (TAA - Cognos LATE START = start move; Cognos - TAA
  // LEFT EARLY = end move). Only then is the column's whole difference the roster basis;
  // any other gap (a real disagreement on top of the move) stays MISMATCH and still holds.
  const flexExplainsLateStart = flexRosterShiftMin !== null && lateStartRawVal !== null && cognosLateStart !== null
    && Math.abs((cognosLateStart - lateStartRawVal) - flexRosterShiftMin) <= tol;
  const flexExplainsLeftEarly = flexRosterEndShiftMin !== null && leftEarlyRawVal !== null && cognosLeftEarly !== null
    && Math.abs((leftEarlyRawVal - cognosLeftEarly) - flexRosterEndShiftMin) <= tol;
  const flexRosterNote = `Flex staff: Cognos measured this against its base roster, TAA against the moved ASPECT shift — the gap is exactly the ${Math.abs(flexRosterShiftMin ?? 0)}m roster move`;
  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i];
    c.policyGroup = policyGroupForColumn(c.column);
    if (c.column === 'LATE START' && foldLateStart) c.policyGroup = 'SHIFT';
    if (c.column === 'LEFT EARLY' && foldLeftEarly) c.policyGroup = 'SHIFT';
    if (c.status === 'MISMATCH' && ((c.column === 'LATE START' && flexExplainsLateStart) || (c.column === 'LEFT EARLY' && flexExplainsLeftEarly))) {
      comparisons[i] = { ...c, policyGroup: 'SHIFT', status: 'NOT_COMPARABLE', note: flexRosterNote };
    }
  }

  const mismatchColumns = comparisons.filter(c => c.status === 'MISMATCH').map(c => c.column);
  const filledColumns = comparisons
    .filter(c => fillColumns.has(c.column) && c.status === 'COGNOS_BLANK' && c.recomputedRaw)
    .map(c => c.column);
  const cognosAgree = mismatchColumns.length === 0;

  return {
    comparisons,
    mismatchColumns,
    filledColumns,
    cognosAgree,
    leaveTypeRecomputed: leaveTypeResolution.recomputed,
    leaveTypeMatchBasis: leaveTypeResolution.basis,
  };
}
