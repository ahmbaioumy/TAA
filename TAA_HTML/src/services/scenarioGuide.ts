import { ConfigRegistry, PolicyRuleItem, RoleTier, TaaActionCode, CommunicationRule } from '../types/taa';
import { lookupPolicyRule, resolveNoLoginDecision, flexLateBandFires, isFlexScheduleWithinExpectedWindow } from './reconciliationEngine';
import { snapTimeToGrid, parseHHMMToMinutes } from './parsers';
import { effectiveCmsCoverageGraceMinutes } from './configRegistry';

/**
 * Scenario Guide domain logic — a plain-English, always-current manual and
 * simulator for "what does the app do when X happens", built entirely from
 * the live ConfigRegistry. Nothing here is a stored/authored copy of a rule:
 * every case/outcome line is generated fresh from config.policyRules and the
 * relevant scalar config fields each time buildScenarioCatalog/
 * simulateScenario is called, and every minute-band decision goes through
 * lookupPolicyRule() — the exact function reconciliationEngine.ts itself
 * uses — so this page can never disagree with a real reconciliation run.
 *
 * The branch ORDER mirrored below (Leave Day -> Data Gap -> Flex vs Standard
 * -> rule evaluation -> most-severe-wins) copies reconciliationEngine.ts's
 * runReconciliation() control flow (roughly lines 291-753) and
 * evaluateEarlyAndLateLogout() (lines 929-983). If that control flow changes,
 * this file needs a matching update — it is a deliberate, documented mirror,
 * not a shared code path, because runReconciliation() operates on full
 * ASPECT/CMS records and has side effects (correction rows, running totals)
 * that don't apply to a hypothetical "what if" check.
 *
 * A second, important kind of "live" handled here: several policyRules
 * categories only READ some of their own fields at runtime (e.g. Late Logout
 * always results in Marked Absent once its minute band matches, regardless
 * of what the row's Action dropdown says; RLS-OT isn't gated by its row at
 * all). Every group below states plainly which of its fields are actually
 * load-bearing, so the guide never implies a field controls behavior that it
 * doesn't.
 */

// ---------------------------------------------------------------------------
// Fixed vocabulary: what each action/communication CODE means in plain
// English. This is the only "authored" text in this module — it's stable
// because the code's real-world meaning is fixed by the rest of the app
// (e.g. what LATE_AND_COVER causes downstream). WHICH code applies for a
// given case is always read live from config, never hardcoded here.
// ---------------------------------------------------------------------------

export const ACTION_DESCRIPTIONS: Record<TaaActionCode, string> = {
  NO_ACTION: 'No action is taken.',
  LATE_AND_COVER: 'Marked Late for the day; a cover segment is added to the next working day (or to the same day, right after the shift, if "Place Cover Same-Day" is ON and the agent already stayed long enough).',
  ABSENT_SEGMENT: 'Marked Absent for the day.',
  ABSENT_NS_NC: 'Marked Absent — No Show / No Call.',
  LOGOFF_AND_COVER: 'Marked as an early log-off; a cover segment is added to the next working day (or to the same day, right before the shift, if "Place Cover Same-Day" is ON and the agent already arrived early enough).',
  ADJUST_OT_RLS: 'The overtime segment’s released window is converted to SHIFT and cut out of the OT segment’s own span — the surviving OT time (before, after, or on both sides of the release) is reissued as an adjusted OT correction at its own real start time; if the release fully covers the OT segment, the whole segment is converted to SHIFT instead.',
  OT_TO_SHIFT: 'An OT1/OT2 segment scheduled on a day marked Absent is explicitly replaced with SHIFT (a 10/11 pair — the OT segment is retired, not left alongside a new insert) so overtime premium pay does not pass through on a day not worked.',
  SHIFT_UPDATE_FLEX: 'The scheduled shift start time is updated to match the actual arrival; no lateness penalty.',
  SHIFT_UPDATE_AND_LATE_COVER_FLEX: 'Marked Late from the flex cutoff time; the shift start is updated to the cutoff and a cover segment is added to the next working day (or to the same day, right after the moved shift end, if "Place Cover Same-Day" is ON and the agent already stayed long enough).',
  MANUAL_REVIEW_REQUIRED: 'Held for manual review — no automatic correction is generated.',
};

export const COMMUNICATION_DESCRIPTIONS: Record<CommunicationRule, string> = {
  NA: 'No email is sent.',
  EMAIL_OPS: 'OPS is notified by email.',
  EMAIL_STAFF_CC_MANAGER: 'The employee is emailed, with their manager copied.',
};

function tierLabel(tier: RoleTier): string {
  return tier === 'OFFICER_PLUS' ? 'Officer+' : 'Ops staff';
}

function formatMinuteBand(minMinutes?: number, maxMinutes?: number): string {
  const min = minMinutes ?? 0;
  const max = maxMinutes ?? 99999;
  if (min <= 0 && max >= 99999) return 'any duration';
  if (max >= 99999) return `${min}+ minutes`;
  if (min <= 0) return `up to ${max} minutes`;
  return `${min}–${max} minutes`;
}

function rowsFor(config: ConfigRegistry, sn: number): PolicyRuleItem[] {
  return config.policyRules
    .filter(r => r.sn === sn)
    .slice()
    .sort((a, b) => (a.tier === b.tier ? (a.minMinutes ?? 0) - (b.minMinutes ?? 0) : a.tier === 'OPS' ? -1 : 1));
}

function toReferenceRow(rule: PolicyRuleItem): RuleReferenceRow {
  return {
    tier: rule.tier,
    band: formatMinuteBand(rule.minMinutes, rule.maxMinutes),
    action: rule.action,
    communication: rule.communication,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioLine {
  id: string;
  caseText: string;
  resultText: string;
  action: TaaActionCode;
  communication: CommunicationRule;
  note?: string;
}

export interface RuleReferenceRow {
  tier: RoleTier;
  band: string;
  action: TaaActionCode;
  communication: CommunicationRule;
}

export interface ScenarioGroup {
  refCode: string;
  title: string;
  complexity: 'complex' | 'simple';
  lines: ScenarioLine[];
  referenceRows?: RuleReferenceRow[];
  configFields?: { field: string; value: string }[];
  summary: string;
}

// ---------------------------------------------------------------------------
// R_1 / R_3 — fully live: band, action, and communication are all read
// directly from the matching policyRules row.
// ---------------------------------------------------------------------------

function buildLiveActionGroup(config: ConfigRegistry, sn: number, refCode: string, title: string, caseVerb: string, summary: string): ScenarioGroup {
  const rows = rowsFor(config, sn);
  const lines: ScenarioLine[] = rows.map(rule => ({
    id: rule.id,
    caseText: `${tierLabel(rule.tier)} ${caseVerb} ${formatMinuteBand(rule.minMinutes, rule.maxMinutes)}`,
    resultText: ACTION_DESCRIPTIONS[rule.action],
    action: rule.action,
    communication: rule.communication,
  }));
  return { refCode, title, complexity: 'simple', lines, referenceRows: rows.map(toReferenceRow), summary };
}

// ---------------------------------------------------------------------------
// R_2 — Early Arrival: not evaluated by the engine at all. Informational.
// ---------------------------------------------------------------------------

function buildEarlyLoginGroup(config: ConfigRegistry): ScenarioGroup {
  const rows = rowsFor(config, 2);
  const lines: ScenarioLine[] = [{
    id: 'early-login-info',
    caseText: 'Any employee arrives before their scheduled/effective start time',
    resultText: 'No action is taken — arriving early is never penalized or flagged.',
    action: 'NO_ACTION',
    communication: 'NA',
    note: 'This category’s rows exist for documentation only — the engine only ever measures lateness, never earliness, so editing this table has no effect on real behavior.',
  }];
  return {
    refCode: 'R_2', title: 'Early Arrival', complexity: 'simple', lines,
    referenceRows: rows.map(toReferenceRow),
    summary: 'Not evaluated by the engine — informational only.',
  };
}

// ---------------------------------------------------------------------------
// R_4 — Very Late Departure: band + communication are live; the action is
// always Marked Absent once a non-"No Action" band matches (the specific
// Action code stored on the row is not read).
// ---------------------------------------------------------------------------

function buildLateLogoutGroup(config: ConfigRegistry): ScenarioGroup {
  const rows = rowsFor(config, 4);
  const lines: ScenarioLine[] = rows.map(rule => {
    const fires = rule.action !== 'NO_ACTION';
    return {
      id: rule.id,
      caseText: `${tierLabel(rule.tier)} logs out ${formatMinuteBand(rule.minMinutes, rule.maxMinutes)} past the scheduled end`,
      resultText: fires ? ACTION_DESCRIPTIONS.ABSENT_SEGMENT : ACTION_DESCRIPTIONS.NO_ACTION,
      action: fires ? 'ABSENT_SEGMENT' : 'NO_ACTION',
      communication: rule.communication,
      note: fires ? 'Marked Absent is the fixed outcome for this category once the band matches — the row’s own Action value isn’t read, only whether it’s "No Action" or not.' : undefined,
    };
  });
  return {
    refCode: 'R_4', title: 'Very Late Departure', complexity: 'simple', lines, referenceRows: rows.map(toReferenceRow),
    summary: 'Band and Communication are live; the resulting action is always Marked Absent (fixed), not read from the row’s Action field.',
  };
}

// ---------------------------------------------------------------------------
// R_5 / R_6 — No Login Record / Single Punch Only: minute band isn’t used
// (always checked, not gated by minutes); action is fixed; communication is
// the only field genuinely read live.
// ---------------------------------------------------------------------------

function buildFixedActionGroup(config: ConfigRegistry, sn: number, refCode: string, title: string, caseText: string, fixedAction: TaaActionCode): ScenarioGroup {
  const rows = rowsFor(config, sn);
  const lines: ScenarioLine[] = rows.map(rule => ({
    id: rule.id,
    caseText: `${tierLabel(rule.tier)} ${caseText}`,
    resultText: ACTION_DESCRIPTIONS[fixedAction],
    action: fixedAction,
    communication: rule.communication,
    note: 'The action is fixed for this category — only the communication rule is read live from this row.',
  }));
  return {
    refCode, title, complexity: 'simple', lines, referenceRows: rows.map(toReferenceRow),
    summary: 'Not minute-gated — fires as soon as the condition is true. Only Communication is live; Action/Min/Max are informational.',
  };
}

// ---------------------------------------------------------------------------
// R_7 — Cover Not Attended: band + communication are live (they gate
// whether the rule fires at all); the real ACTION is controlled by the
// separate config.coverNotAttendedAction toggle, not by the row's Action
// field.
// ---------------------------------------------------------------------------

function buildCoverNotAttendedGroup(config: ConfigRegistry): ScenarioGroup {
  const rows = rowsFor(config, 7);
  const moveForward = config.coverNotAttendedAction === 'moveCoverForward';
  const lines: ScenarioLine[] = rows.map(rule => {
    const fires = rule.action !== 'NO_ACTION';
    const resultText = !fires
      ? ACTION_DESCRIPTIONS.NO_ACTION
      : moveForward
        ? 'The cover segment is moved forward to the next working day instead of marking Absent; recorded as Late & Cover.'
        : ACTION_DESCRIPTIONS.ABSENT_SEGMENT;
    return {
      id: rule.id,
      caseText: `${tierLabel(rule.tier)}’s previously-placed cover segment goes unattended for ${formatMinuteBand(rule.minMinutes, rule.maxMinutes)}`,
      resultText,
      action: !fires ? 'NO_ACTION' : moveForward ? 'LATE_AND_COVER' : 'ABSENT_SEGMENT',
      communication: rule.communication,
      note: fires ? `Real outcome follows the app’s "Cover Not Attended" setting (currently: ${moveForward ? 'move cover forward' : 'mark absent'}) — not this row’s Action value.` : undefined,
    };
  });
  return {
    refCode: 'R_7', title: 'Cover Segment Not Attended', complexity: 'complex', lines, referenceRows: rows.map(toReferenceRow),
    configFields: [{ field: 'coverNotAttendedAction', value: config.coverNotAttendedAction }],
    summary: 'Band and Communication are live and gate whether this fires. The resulting action follows the coverNotAttendedAction setting, not the row’s Action field.',
  };
}

// ---------------------------------------------------------------------------
// R_8 — RLS-OT: unconditional. Not gated by this table at all.
// ---------------------------------------------------------------------------

function buildRlsOtGroup(config: ConfigRegistry): ScenarioGroup {
  const rows = rowsFor(config, 8);
  const lines: ScenarioLine[] = [{
    id: 'rls-ot-info',
    caseText: 'Any overtime (OT1/OT2) segment overlaps a release/RLS segment, by any amount',
    resultText: ACTION_DESCRIPTIONS.ADJUST_OT_RLS,
    action: 'ADJUST_OT_RLS',
    communication: 'NA',
    note: 'Unconditional — fires on any overlap regardless of minute thresholds, and this category’s Action/Communication fields aren’t read at all.',
  }];
  return {
    refCode: 'R_8', title: 'Overtime Adjusted for Release Overlap', complexity: 'complex', lines, referenceRows: rows.map(toReferenceRow),
    summary: 'Not gated by this table — always fires on any overlap. The rows shown below are informational only.',
  };
}

// ---------------------------------------------------------------------------
// R_9–R_12 — branch-logic scenarios that aren’t in policyRules at all.
// Every number here is read live from the matching config field.
// ---------------------------------------------------------------------------

function buildLeaveDayGroup(config: ConfigRegistry): ScenarioGroup {
  const tiers: RoleTier[] = ['OPS', 'OFFICER_PLUS'];
  const lines: ScenarioLine[] = tiers.map(tier => {
    const comm = lookupPolicyRule(config, 'No Login or No Logout', tier, 0)?.communication || 'NA';
    return {
      id: `leave-anomaly-${tier}`,
      caseText: `${tierLabel(tier)} is on a scheduled Leave Day but logs ${config.leaveLoginThresholdMinutes}+ minutes on CMS`,
      resultText: ACTION_DESCRIPTIONS.ABSENT_SEGMENT,
      action: 'ABSENT_SEGMENT',
      communication: comm,
      note: `Communication follows the "Only One Punch Recorded" rule (R_6) for ${tierLabel(tier)}.`,
    };
  });
  lines.push({
    id: 'leave-excluded',
    caseText: `Any employee is on a scheduled Leave Day and logs under ${config.leaveLoginThresholdMinutes} minutes on CMS`,
    resultText: 'Leave Excluded — the day is skipped entirely; no lateness or absence check applies.',
    action: 'NO_ACTION',
    communication: 'NA',
  });
  return {
    refCode: 'R_9', title: 'Scheduled Leave Day', complexity: 'complex', lines,
    configFields: [{ field: 'leaveLoginThresholdMinutes', value: String(config.leaveLoginThresholdMinutes) }],
    summary: 'Checked before anything else — a Leave Day never reaches the normal Late/Early rules.',
  };
}

/** §4.6f Absence Already Recorded (2026-09-18). Sits immediately after the Leave Day
 * gate and before the data-gap check — mirroring runReconciliation()'s own order. */
function buildAlreadyAbsentGroup(config: ConfigRegistry): ScenarioGroup {
  const lines: ScenarioLine[] = [
    {
      id: 'already-absent-no-attendance',
      caseText: `ASPECT already tags the day absent (${(config.existingAbsenceMarkerCodes || []).join(' / ') || 'no codes configured'}) and CMS shows under ${config.leaveLoginThresholdMinutes} minutes`,
      resultText: 'Absence Already Recorded — the day is already actioned. No second absence segment is written and no notice is drafted.',
      action: 'NO_ACTION',
      communication: 'NA',
      note: 'TAA never re-marks a day that is already marked, and never upgrades an existing ABSENT to Absent NS/NC — the reason for an absence needs supporting documents and HR-system confirmation, which TAA has no access to.',
    },
    {
      id: 'already-absent-but-attended',
      caseText: `ASPECT already tags the day absent but CMS shows ${config.leaveLoginThresholdMinutes}+ minutes of attendance`,
      resultText: ACTION_DESCRIPTIONS.MANUAL_REVIEW_REQUIRED,
      action: 'MANUAL_REVIEW_REQUIRED',
      communication: 'NA',
      note: 'Removing a recorded absence restores a day of pay, so it is always a human decision — TAA surfaces the contradiction and never auto-reverses it.',
    },
  ];
  return {
    refCode: 'R_13', title: 'Absence Already Recorded', complexity: 'complex', lines,
    configFields: [
      { field: 'existingAbsenceMarkerCodes', value: (config.existingAbsenceMarkerCodes || []).join(', ') },
      { field: 'leaveLoginThresholdMinutes', value: String(config.leaveLoginThresholdMinutes) },
    ],
    summary: 'Checked straight after the Leave Day gate. These marker codes sit alongside a normal SHIFT, so the Leave Day gate above never catches them.',
  };
}

function buildDataGapGroup(): ScenarioGroup {
  const lines: ScenarioLine[] = [
    {
      id: 'gap-unparseable',
      caseText: 'Cognos’s Sign In Date value for this row can’t be parsed as a date',
      resultText: ACTION_DESCRIPTIONS.MANUAL_REVIEW_REQUIRED,
      action: 'MANUAL_REVIEW_REQUIRED',
      communication: 'NA',
    },
    {
      id: 'gap-mismatch',
      caseText: 'ASPECT has segments for this employee, but none dated on this Cognos row’s date',
      resultText: 'Flagged as a Cognos/ASPECT date mismatch and held for review; no automatic correction is generated until resolved.',
      action: 'NO_ACTION',
      communication: 'NA',
    },
    {
      id: 'gap-none',
      caseText: 'No ASPECT schedule exists anywhere for this employee on this date',
      resultText: 'Flagged as a data gap and held for review; no automatic correction is generated until resolved.',
      action: 'NO_ACTION',
      communication: 'NA',
    },
  ];
  return {
    refCode: 'R_10', title: 'Missing ASPECT Schedule (Data Gap)', complexity: 'complex', lines,
    summary: 'Checked before the Flex/Standard rules — with no ASPECT schedule there is nothing to recompute against.',
  };
}

function buildInsufficientCoverageGroup(config: ConfigRegistry): ScenarioGroup {
  const lines: ScenarioLine[] = [{
    id: 'insufficient-coverage',
    // The coverage rule is measured against the EXPORT's own extent, not against
    // one employee's punches and not against a flat day-buffer around the report
    // date range. Keep this text in step with punchAttribution.ts's
    // buildExportDayCoverage / isRangeCoveredByExport — it is the page's whole
    // purpose to describe what the engine actually does.
    caseText: `No usable punch is found, or the login-to-logout span is under ${config.minAttendanceSpanMinutes} min (a single CMS record already carrying a real login AND logout hours apart counts as fully sufficient — the number of records is never itself the problem), and the uploaded CMS export itself doesn’t reach far enough to prove a missing punch is real. Coverage is measured against the export: every date in it counts as fully covered except its latest date, which only counts up to the last punch recorded on it. The shift’s own start-to-end window must be covered with ${effectiveCmsCoverageGraceMinutes(config)} min of margin on each side — always the same ±${config.cmsPunchSearchWindowHours}-hour radius used to search for a companion punch (the grace is linked to the search window, so the export is never trusted past the point it was actually searched)`,
    resultText: ACTION_DESCRIPTIONS.MANUAL_REVIEW_REQUIRED,
    action: 'MANUAL_REVIEW_REQUIRED',
    communication: 'NA',
    note: 'Applies identically to Flex and Standard staff. A same-day shift on a fully-covered date is NOT held by this rule — only a shift whose window runs past what the export actually contains.',
  }];
  return {
    refCode: 'R_11', title: 'Insufficient CMS Coverage', complexity: 'complex', lines,
    configFields: [
      { field: 'minAttendanceSpanMinutes', value: String(config.minAttendanceSpanMinutes) },
      { field: 'cmsCoverageGraceMinutes (linked, = search window × 60)', value: String(effectiveCmsCoverageGraceMinutes(config)) },
      { field: 'cmsPunchSearchWindowHours', value: String(config.cmsPunchSearchWindowHours) },
    ],
    summary: 'A safety net — thin CMS evidence is held for human review instead of being auto-marked absent.',
  };
}

function buildFlexArrivalGroup(config: ConfigRegistry): ScenarioGroup {
  const lines: ScenarioLine[] = [
    {
      id: 'flex-ontime-exact',
      caseText: `Flex staff arrives at/before ${config.flexCutoffTime} and lands exactly on the scheduled start (rounded to the nearest ${config.roundingGridMinutes} min, rounding ${config.roundingDirection})`,
      resultText: ACTION_DESCRIPTIONS.NO_ACTION,
      action: 'NO_ACTION',
      communication: 'NA',
    },
    {
      id: 'flex-ontime-shifted',
      caseText: `Flex staff arrives at/before ${config.flexCutoffTime} but not exactly on the scheduled start`,
      resultText: ACTION_DESCRIPTIONS.SHIFT_UPDATE_FLEX,
      action: 'SHIFT_UPDATE_FLEX',
      communication: 'NA',
    },
    {
      id: 'flex-late',
      caseText: `Flex staff arrives after ${config.flexCutoffTime}`,
      resultText: `${ACTION_DESCRIPTIONS.SHIFT_UPDATE_AND_LATE_COVER_FLEX} No email is sent for this — flex late-arrival cover is silent by design.`,
      action: 'SHIFT_UPDATE_AND_LATE_COVER_FLEX',
      communication: 'NA',
      note: config.flexBypassesMinuteBands
        ? 'The full variance is charged regardless of the Late Login minute bands (bypass is ON).'
        : 'Still checked against the Late Login minute bands before charging (bypass is OFF).',
    },
  ];
  return {
    refCode: 'R_12', title: 'Flex Staff Arrival', complexity: 'complex', lines,
    configFields: [
      { field: 'flexCutoffTime', value: config.flexCutoffTime },
      { field: 'flexExpectedSchedStartWindow', value: `${config.flexExpectedSchedStartWindow.start}–${config.flexExpectedSchedStartWindow.end}` },
      { field: 'roundingGridMinutes', value: String(config.roundingGridMinutes) },
      { field: 'roundingDirection', value: config.roundingDirection },
      { field: 'flexBypassesMinuteBands', value: String(config.flexBypassesMinuteBands) },
    ],
    summary: 'Departure is then checked against the (possibly shifted) shift end using the same rules as Early/Late Departure (R_3/R_4).',
  };
}

/**
 * Every scenario the app can produce, grouped and pre-ordered hardest/most
 * config-sensitive first, then the simple minute-band rules. Pure function
 * of `config` — call it fresh (e.g. inside useMemo keyed on config) rather
 * than caching its result, so it always reflects the live settings.
 */
export function buildScenarioCatalog(config: ConfigRegistry): ScenarioGroup[] {
  return [
    buildFlexArrivalGroup(config),
    buildLeaveDayGroup(config),
    buildAlreadyAbsentGroup(config),
    buildDataGapGroup(),
    buildInsufficientCoverageGroup(config),
    buildCoverNotAttendedGroup(config),
    buildRlsOtGroup(config),
    buildFixedActionGroup(config, 5, 'R_5', 'No CMS Punches At All', 'has no CMS punches at all during the scheduled window', 'ABSENT_NS_NC'),
    buildFixedActionGroup(config, 6, 'R_6', 'Only One Punch Recorded', `has a login-to-logout span under ${config.minAttendanceSpanMinutes} min — too thin to trust as a real day (login or logout is effectively missing), regardless of how many CMS records were found`, 'ABSENT_SEGMENT'),
    buildLiveActionGroup(config, 1, 'R_1', 'Late Arrival', 'arrives late by', 'Measured against the effective scheduled start. Band, Action, and Communication are all read live from this table.'),
    buildLiveActionGroup(config, 3, 'R_3', 'Early Departure', 'leaves early by', 'Measured against the effective scheduled end (after release/nursing carve-outs). Band, Action, and Communication are all read live from this table.'),
    buildLateLogoutGroup(config),
    buildEarlyLoginGroup(config),
  ];
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export type DataGapReason = 'unparseable' | 'dateMismatch' | 'noSegments';

export interface ScenarioSimInput {
  tier: RoleTier;
  isFlex: boolean;
  isLeaveDay: boolean;
  leaveDayPunchMinutes?: number;
  /** §4.6f: the day's ASPECT segments already carry an absence marker
   * (config.existingAbsenceMarkerCodes). Independent of isLeaveDay — these markers
   * normally sit alongside a normal SHIFT, which is exactly why the leave-day gate
   * never catches them. */
  alreadyMarkedAbsent: boolean;
  absenceMarkerPunchMinutes?: number;
  hasAspectSchedule: boolean;
  dataGapReason?: DataGapReason;
  punchCount: number;
  attendanceSpanMinutes?: number;
  coverageSufficient: boolean;
  rawStartTime?: string;
  actualFirstLoginTime?: string;
  lateMin?: number;
  earlyMin?: number;
  lateLogoutMin?: number;
  coverShortfallMin?: number;
  rlsOverlapMin?: number;
}

export interface ScenarioSimResult {
  verdict: string;
  action: TaaActionCode;
  actionText: string;
  communication: CommunicationRule;
  communicationText: string;
  refCode: string;
  trace: string[];
}

function buildResult(verdict: string, action: TaaActionCode, communication: CommunicationRule, refCode: string, trace: string[]): ScenarioSimResult {
  return { verdict, action, actionText: ACTION_DESCRIPTIONS[action], communication, communicationText: COMMUNICATION_DESCRIPTIONS[communication], refCode, trace };
}

function snapMinutesToGrid(minutesOfDay: number, gridMinutes: number, direction: 'nearest' | 'up' | 'down'): number {
  const base = new Date(2000, 0, 1, 0, 0, 0, 0);
  base.setMinutes(minutesOfDay);
  const snapped = snapTimeToGrid(base, gridMinutes, direction);
  return snapped.getHours() * 60 + snapped.getMinutes();
}

function formatMinutesAsHHMM(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface DepartureResult {
  fired: boolean;
  category: number;
  action: TaaActionCode;
  verdict: string;
  communication: CommunicationRule;
  refCode: string;
}

/** Mirrors reconciliationEngine.ts's evaluateEarlyAndLateLogout (lines 929-983) — shared by both the standard path and the flex downstream check, same as the real engine. */
function evaluateDeparture(earlyMin: number, lateLogoutMin: number, tier: RoleTier, config: ConfigRegistry, trace: string[]): DepartureResult {
  if (earlyMin > 0) {
    const rule = lookupPolicyRule(config, 'Early Logout', tier, earlyMin);
    if (rule && rule.action !== 'NO_ACTION') {
      trace.push(`Early Logout ${earlyMin}m — ${ACTION_DESCRIPTIONS[rule.action]}`);
      if (rule.action === 'LOGOFF_AND_COVER') return { fired: true, category: 2, action: 'LOGOFF_AND_COVER', verdict: 'EARLY_LOGOUT', communication: rule.communication, refCode: 'R_3' };
      if (rule.action === 'ABSENT_SEGMENT') return { fired: true, category: 3, action: 'ABSENT_SEGMENT', verdict: 'ABSENT', communication: rule.communication, refCode: 'R_3' };
    } else {
      trace.push(`Early Logout ${earlyMin}m — within tolerance, no rule fires.`);
    }
  } else if (lateLogoutMin > 0) {
    const rule = lookupPolicyRule(config, 'Late Logout', tier, lateLogoutMin);
    if (rule && rule.action !== 'NO_ACTION') {
      trace.push(`Late Logout ${lateLogoutMin}m past shift end — Marked Absent (fixed outcome for this category).`);
      return { fired: true, category: 3, action: 'ABSENT_SEGMENT', verdict: 'ABSENT', communication: rule.communication, refCode: 'R_4' };
    } else {
      trace.push(`Late Logout ${lateLogoutMin}m — within tolerance, no rule fires.`);
    }
  }
  return { fired: false, category: 0, action: 'NO_ACTION', verdict: 'PRESENT', communication: 'NA', refCode: 'R_3' };
}

/**
 * Plug in an assumption, get the exact action the app would take — mirrors
 * runReconciliation()'s decision order (lines 291-753 of
 * reconciliationEngine.ts) but from simple scalar inputs instead of full
 * ASPECT/CMS records. Every minute-band decision calls lookupPolicyRule(),
 * so tuning a threshold in Config Registry changes the answer immediately.
 */
export function simulateScenario(input: ScenarioSimInput, config: ConfigRegistry): ScenarioSimResult {
  const trace: string[] = [];

  if (input.isLeaveDay) {
    const totalPunchMinutes = input.leaveDayPunchMinutes ?? 0;
    trace.push(`Scheduled Leave Day: total CMS login span ${totalPunchMinutes}m vs the ${config.leaveLoginThresholdMinutes}m threshold.`);
    if (totalPunchMinutes >= config.leaveLoginThresholdMinutes) {
      const comm = lookupPolicyRule(config, 'No Login or No Logout', input.tier, 0)?.communication || 'NA';
      trace.push('At/over threshold — treated as a Leave Day login anomaly.');
      return buildResult('ABSENT', 'ABSENT_SEGMENT', comm, 'R_9', trace);
    }
    trace.push('Under threshold — Leave Excluded, no penalty.');
    return buildResult('LEAVE_EXCLUDED', 'NO_ACTION', 'NA', 'R_9', trace);
  }

  // §4.6f Absence Already Recorded — mirrors the engine's gate order: straight after
  // the Leave Day gate, before the data-gap check.
  if (input.alreadyMarkedAbsent) {
    const totalPunchMinutes = input.absenceMarkerPunchMinutes ?? 0;
    trace.push(`ASPECT already tags this day absent (${(config.existingAbsenceMarkerCodes || []).join(' / ')}) — the day is already actioned.`);
    trace.push(`CMS login span ${totalPunchMinutes}m vs the ${config.leaveLoginThresholdMinutes}m threshold.`);
    if (totalPunchMinutes >= config.leaveLoginThresholdMinutes) {
      trace.push('At/over threshold — CMS contradicts the recorded absence. Held for a human; a recorded absence is never auto-reversed.');
      return buildResult('ABSENCE_CONTRADICTED_BY_CMS', 'MANUAL_REVIEW_REQUIRED', 'NA', 'R_13', trace);
    }
    trace.push('Under threshold — no duplicate absence segment is written and no notice is drafted.');
    return buildResult('ABSENCE_ALREADY_RECORDED', 'NO_ACTION', 'NA', 'R_13', trace);
  }

  if (!input.hasAspectSchedule) {
    trace.push('No ASPECT schedule found for this employee-day.');
    if (input.dataGapReason === 'unparseable') {
      trace.push('Cognos’s Sign In Date can’t be parsed — held for manual review.');
      return buildResult('COGNOS_DATA_GAP', 'MANUAL_REVIEW_REQUIRED', 'NA', 'R_10', trace);
    }
    trace.push(
      input.dataGapReason === 'dateMismatch'
        ? 'ASPECT has segments for this employee but none on this date — Cognos/ASPECT date mismatch.'
        : 'No ASPECT segments exist for this employee at all — genuine data gap.'
    );
    return buildResult('COGNOS_DATA_GAP', 'NO_ACTION', 'NA', 'R_10', trace);
  }

  const attendanceSpanMinutes = input.attendanceSpanMinutes ?? 0;
  // D-F fix: mirrors reconciliationEngine.ts's anchor-presence fix — a single
  // punch can legitimately carry a real multi-hour span (one CMS row with a
  // genuine login AND logout hours apart), so the punch COUNT is never itself
  // disqualifying. Only a genuine zero-punch day (handled separately below)
  // or a real thin/near-instant span keeps this "insufficient".
  const insufficientEvidence = input.punchCount === 0 || attendanceSpanMinutes < config.minAttendanceSpanMinutes;
  const insufficientCoverage = insufficientEvidence && !input.coverageSufficient;
  trace.push(`Punches: ${input.punchCount}, span ${attendanceSpanMinutes}m (needs ≥ ${config.minAttendanceSpanMinutes}m) — ${insufficientEvidence ? 'insufficient evidence' : 'sufficient evidence'}.`);

  if (insufficientEvidence && insufficientCoverage) {
    trace.push('CMS export doesn’t fully cover the required window — held for manual review.');
    return buildResult('INSUFFICIENT_CMS_COVERAGE', 'MANUAL_REVIEW_REQUIRED', 'NA', 'R_11', trace);
  }
  if (input.punchCount === 0) {
    // Shared with reconciliationEngine.ts's own no-login handling (both the flex
    // and standard branches there call the same function) — this used to be an
    // independent reimplementation here that only ever produced ABSENT_NS_NC,
    // silently disagreeing with a real run whenever "No Login Record" was
    // configured to NO_ACTION or MANUAL_REVIEW_REQUIRED instead.
    const decision = resolveNoLoginDecision(lookupPolicyRule(config, 'No Login Record', input.tier, 0), '');
    trace.push(decision.ruleFired);
    return buildResult(decision.verdict, decision.action, decision.communicationRule, 'R_5', trace);
  }
  if (insufficientEvidence) {
    const comm = lookupPolicyRule(config, 'No Login or No Logout', input.tier, 0)?.communication || 'NA';
    trace.push(`Attendance span (${attendanceSpanMinutes}m) is too thin to trust as real evidence — Marked Absent.`);
    return buildResult('ABSENT', 'ABSENT_SEGMENT', comm, 'R_6', trace);
  }

  // §4.8's flex-cutoff algorithm only applies when the employee's scheduled
  // start actually falls inside the configured flex window — shared with
  // reconciliationEngine.ts's own isFlexScheduleWithinExpectedWindow gate. A
  // past drift: this simulator previously ran the flex-cutoff branch for ANY
  // isFlex input regardless of scheduled start, disagreeing with a real run
  // whenever a flex-tagged employee's schedule fell outside the window (which
  // routes to standard rules + a forced FLEX_SCHEDULE_OUTSIDE_WINDOW hold).
  const rawStartMinOfDay = parseHHMMToMinutes(input.rawStartTime || config.flexCutoffTime);
  const rawStartDateForWindowCheck = new Date(2000, 0, 1, Math.floor(rawStartMinOfDay / 60), rawStartMinOfDay % 60);
  const isFlexWithinWindow = input.isFlex && isFlexScheduleWithinExpectedWindow(rawStartDateForWindowCheck, config);

  if (input.isFlex && !isFlexWithinWindow) {
    trace.push(`Flex-tagged, but scheduled start ${input.rawStartTime || '(unspecified)'} falls outside the expected flex window ${config.flexExpectedSchedStartWindow.start}–${config.flexExpectedSchedStartWindow.end} — standard attendance rules apply instead, and the row is still held for review (FLEX_SCHEDULE_OUTSIDE_WINDOW) even if standard evaluation finds nothing wrong.`);
  }

  if (isFlexWithinWindow) {
    const cutoffMin = parseHHMMToMinutes(config.flexCutoffTime);
    const arrivalMin = parseHHMMToMinutes(input.actualFirstLoginTime || '00:00');
    trace.push(`Flex arrival ${input.actualFirstLoginTime || '--:--'} vs cutoff ${config.flexCutoffTime}.`);

    let category = 0;
    let action: TaaActionCode = 'NO_ACTION';
    let verdict = 'PRESENT';
    let communication: CommunicationRule = 'NA';
    let refCode = 'R_12';

    if (arrivalMin <= cutoffMin) {
      const rawStartMin = parseHHMMToMinutes(input.rawStartTime || config.flexCutoffTime);
      const snappedMin = snapMinutesToGrid(arrivalMin, config.roundingGridMinutes, config.roundingDirection);
      if (snappedMin !== rawStartMin) {
        trace.push(`Arrival rounds to ${formatMinutesAsHHMM(snappedMin)}, different from the scheduled start ${input.rawStartTime || '(unspecified)'} — shift start is updated.`);
        category = 1;
        action = 'SHIFT_UPDATE_FLEX';
        verdict = 'SHIFT_CHANGED_FLEX';
      } else {
        trace.push('Arrival matches the scheduled start exactly — Present, no action.');
      }
    } else {
      const lateMin = arrivalMin - cutoffMin;
      // bandFires does NOT change the reported verdict/action/category below — a real
      // run always reports LATE / SHIFT_UPDATE_AND_LATE_COVER_FLEX once past cutoff. It
      // only gates whether the LATE + COVER correction ROWS themselves get written (the
      // shift-update pair is written either way) — surfaced here only as an explanatory
      // trace line, exactly matching reconciliationEngine.ts's own Branch B.
      const bandFires = flexLateBandFires(config, input.tier, lateMin);
      trace.push(`Arrival is ${lateMin}m past the ${config.flexCutoffTime} cutoff — full variance charged; shift start updated to cutoff. No email is sent for this.${bandFires ? '' : ' Note: flexBypassesMinuteBands is OFF and no Late Login band matches this lateness, so the LATE + cover correction ROWS themselves are not written — only the shift-time update is (the verdict/action still report Late).'}`);
      category = 2;
      action = 'SHIFT_UPDATE_AND_LATE_COVER_FLEX';
      verdict = 'LATE';
    }

    const departure = evaluateDeparture(input.earlyMin ?? 0, input.lateLogoutMin ?? 0, input.tier, config, trace);
    if (departure.fired && departure.category >= category) {
      category = departure.category;
      action = departure.action;
      verdict = departure.verdict;
      communication = departure.communication;
      refCode = departure.refCode;
    }
    return buildResult(verdict, action, communication, refCode, trace);
  }

  // --- Standard / non-flex path (also reached by a flex-tagged employee whose
  // schedule falls outside the expected flex window, per the gate above) ---
  let category = 0;
  let action: TaaActionCode = 'NO_ACTION';
  let verdict = 'PRESENT';
  let communication: CommunicationRule = 'NA';
  let refCode = 'R_1';
  const applyMoreSevere = (newCategory: number, newAction: TaaActionCode, newVerdict: string, comm: CommunicationRule, newRef: string) => {
    if (newCategory >= category) {
      category = newCategory;
      action = newAction;
      verdict = newVerdict;
      communication = comm;
      refCode = newRef;
    }
  };

  const lateMin = input.lateMin ?? 0;
  if (lateMin > 0) {
    const rule = lookupPolicyRule(config, 'Late Login', input.tier, lateMin);
    if (rule && rule.action !== 'NO_ACTION') {
      trace.push(`Late Login ${lateMin}m — ${ACTION_DESCRIPTIONS[rule.action]}`);
      if (rule.action === 'LATE_AND_COVER') applyMoreSevere(2, 'LATE_AND_COVER', 'LATE', rule.communication, 'R_1');
      else if (rule.action === 'ABSENT_SEGMENT') applyMoreSevere(3, 'ABSENT_SEGMENT', 'ABSENT', rule.communication, 'R_1');
    } else {
      trace.push(`Late Login ${lateMin}m — within tolerance, no rule fires.`);
    }
  }

  const departure = evaluateDeparture(input.earlyMin ?? 0, input.lateLogoutMin ?? 0, input.tier, config, trace);
  if (departure.fired) applyMoreSevere(departure.category, departure.action, departure.verdict, departure.communication, departure.refCode);

  const coverShortfallMin = input.coverShortfallMin ?? 0;
  if (coverShortfallMin > 0) {
    const rule = lookupPolicyRule(config, 'Cover Not Attended', input.tier, coverShortfallMin);
    if (rule && rule.action !== 'NO_ACTION') {
      const moveForward = config.coverNotAttendedAction === 'moveCoverForward';
      trace.push(`Cover Not Attended ${coverShortfallMin}m — ${moveForward ? 'cover moved forward, Late & Cover' : 'Marked Absent'}.`);
      applyMoreSevere(moveForward ? 2 : 3, moveForward ? 'LATE_AND_COVER' : 'ABSENT_SEGMENT', moveForward ? verdict : 'ABSENT', rule.communication, 'R_7');
    } else {
      trace.push(`Cover Not Attended ${coverShortfallMin}m — within tolerance, no rule fires.`);
    }
  }

  const rlsOverlapMin = input.rlsOverlapMin ?? 0;
  let rlsFired = false;
  if (rlsOverlapMin > 0) {
    if (category >= 3) {
      // §4.6c already retires every OT segment on an Absent day via its own 10/11
      // pair (OT_TO_SHIFT) — Rule 8 is skipped entirely so it never drafts a second,
      // conflicting pair against the same OT segment. See reconciliationEngine.ts's
      // buildRlsOtAdjustmentOutcomes.
      trace.push(`OT overlaps a release segment by ${rlsOverlapMin}m — Rule 8 skipped: the day is Absent, so the OT segment is already replaced by SHIFT (OT_TO_SHIFT) instead.`);
    } else {
      rlsFired = true;
      trace.push(`OT overlaps a release segment by ${rlsOverlapMin}m — OT duration adjusted (ADJUST_OT_RLS), independent of the verdict above.`);
    }
  }

  if (category === 0) {
    if (rlsFired) {
      refCode = 'R_8';
    } else {
      trace.push('Nothing exceeded any threshold — Present, no action.');
    }
  }
  return buildResult(verdict, action, communication, refCode, trace);
}
