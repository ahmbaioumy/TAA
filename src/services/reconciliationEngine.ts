import {
  AspectSegment,
  AspectIdentity,
  CognosRecord,
  CMSPunch,
  ConfigRegistry,
  ReconciliationRow,
  AspectCorrectionRow,
  EmailActionItem,
  RoleTier,
  TaaActionCode,
  TaaResultCategory,
  CommunicationRule,
  PolicyRuleItem,
  HoldReasonCode,
  ColumnComparison,
  VarianceTrace,
  EmailTemplateKey,
  VerificationOverrideAudit,
  TaaSectionSource,
} from '../types/taa';
import {
  parseDateTimeString,
  parseClockTimeString,
  formatTimeHHMM,
  formatDateDDMMYYYY,
  normalizeDateKey,
  diffInMinutes,
  truncateToMinute,
  addDays,
  nextWeekMonday,
  startOfDay,
  formatMinutesToHHMM,
  snapTimeToGrid,
  parseCognosHMinutes,
} from './parsers';
import { isForcedHoldReason, HOLD_REASON_TEXT } from './holdReasons';
import { ConfigValidationIssue, validateConfigForRun } from './configRegistry';
import { recomputeDaySchedule, DayScheduleRecompute, isCodeInConfiguredSet, isWorkingDaySegment, resolveSegmentMinutes } from './scheduleRecompute';
import { attributePunches, ScheduledWindow, AttributionResult } from './punchAttribution';
import { compareCognosRow, ComparisonContext, isCognosSentinel, logoutOutcomeMatchesTaa } from './cognosComparison';
import { applyEmailTemplate, computeEmailStatusByRowId, findManagerEmail, planEmailDraftActions, resolveEmailRecipient } from './emailDrafts';
import { verificationFailedCheckSummary } from './verificationAudit';

export interface ReconciliationInput {
  cognosRecords: CognosRecord[];
  aspectSegments: AspectSegment[];
  aspectIdentities: AspectIdentity[];
  cmsPunches: CMSPunch[];
  config: ConfigRegistry;
  /** WP2/D5/B8: the run date. Newly assigned COVER must land on a working day
   * strictly after this date (config.coverMinimumDaysAfterRunDate). REQUIRED, not
   * optional with a Date.now() default — every caller must decide this explicitly,
   * and an implicit default would silently break every test that pins a cover date.
   * This is run CONTEXT, never persisted config: it must never be written into an
   * exported Config.json. A proven already-worked same-day cover bypasses this
   * floor entirely (invariant 9) and stays on the incident day. */
  processingDate: Date;
  verificationAudit?: VerificationOverrideAudit;
}

export interface ReconciliationOutput {
  rows: ReconciliationRow[];
  aspectCorrections: AspectCorrectionRow[];
  aspectCorrectionsCsv: string;
  annotatedCognosCsv: string;
  annotatedCognosTsv: string;
  emailActions: EmailActionItem[];
  emailActionsJson: string;
  verificationAudit?: VerificationOverrideAudit;
  /** Stamped by applyHoldPolicy (src/services/holdPolicy.ts) — the fingerprint of the
   * ConfigRegistry.holdPolicy actually applied to produce this output. Compared against
   * the currently-saved policy's fingerprint (isResultStale) to show the "Re-calculate
   * needed" stale state. Undefined only for an output that never went through
   * applyHoldPolicy (e.g. regression suite / trust matrix calling runReconciliation
   * directly — see pipeline.ts). */
  holdPolicyFingerprint?: string;
  summary: {
    totalRecords: number;
    shiftChangedCount: number;
    lateCoverCount: number;
    markedAbsentCount: number;
    noActionCount: number;
    cognosDataGapCount: number;
    disagreementsResolvedCount: number;
    overtimeRowsCount: number;
    flexRowsCount: number;
    otConvertedCount: number;
    otRlsAdjustedCount: number;
    heldForReviewCount: number;
    mismatchCount: number;
    mustCheckCount: number;
  };
}

/** Determine Role Tier by scanning EMP_SORT_NAME / EMP_SHORT_NAME (§4.2). */
export function determineRoleTier(identity: AspectIdentity | undefined, config: ConfigRegistry): RoleTier {
  if (!identity) return 'OPS';
  const textToScan = `${identity.EMP_SORT_NAME || ''} ${identity.EMP_SHORT_NAME || ''} ${identity.EMP_FIRST_NAME || ''}`.toUpperCase();
  for (const kw of config.roleTierKeywords) {
    if (textToScan.includes(kw.trim().toUpperCase())) return 'OFFICER_PLUS';
  }
  return 'OPS';
}

/** Determine if employee is Flex-tagged (§4.8). */
export function isFlexStaff(identity: AspectIdentity | undefined, config: ConfigRegistry): boolean {
  if (!identity) return false;
  const textToScan = `${identity.EMP_SORT_NAME || ''} ${identity.EMP_SHORT_NAME || ''} ${identity.EMP_FIRST_NAME || ''}`.toUpperCase();
  for (const kw of config.flexKeywords) {
    if (textToScan.includes(kw.trim().toUpperCase())) return true;
  }
  return false;
}

/** Is `d` the configured reduced-office-hours weekday (feature must be enabled)? */
function isReducedOfficeHoursWeekday(d: Date, config: ConfigRegistry): boolean {
  return !!config.reducedOfficeHoursEnabled && d.getDay() === config.reducedOfficeHoursDayOfWeek;
}

/** Reduced-office-hours minutes required for a row dated shiftDateStr, or null if not applicable.
 * Does not check Flex/window eligibility — callers decide that (see runReconciliation's
 * reducedOfficeHoursMin), since the cover-placement call sites only have dates, not identity. */
function getReducedOfficeHoursRequirement(shiftDateStr: string, config: ConfigRegistry): number | null {
  const d = parseDateTimeString(shiftDateStr);
  return d && isReducedOfficeHoursWeekday(d, config) ? config.reducedOfficeHoursRequiredMinutes : null;
}

/**
 * §4.8's flex algorithm (absolute 10:00 cutoff, shift-update-and-clamp) is
 * designed on the business premise that flex staff are ALWAYS scheduled to
 * start between config.flexExpectedSchedStartWindow (default 07:00-10:00).
 * Defect fix: it previously ran unconditionally for any flex-tagged
 * employee regardless of their actual ASPECT-scheduled start — a flex agent
 * on an afternoon/night shift (e.g. 14:00-22:00) with PERFECT attendance
 * got measured against the 10:00 cutoff as if they were 4+ hours late,
 * producing a fabricated ABSENT with a full-shift COVER, and rewrote their
 * ASPECT shift to start at the cutoff. This gate keeps the algorithm
 * confined to the schedules it was actually designed for; a flex employee
 * whose schedule falls outside the window is routed to the standard
 * attendance rules and held for review instead (FLEX_SCHEDULE_OUTSIDE_WINDOW).
 *
 * config.flexOutsideWindowTreatAsOps (default true) only changes the row's
 * reported TAA_TIER/role_tier label (FLEX -> OPS) once it lands there — it
 * never touches the forced FLEX_SCHEDULE_OUTSIDE_WINDOW hold, which still
 * applies either way.
 */
export function isFlexScheduleWithinExpectedWindow(rawStart: Date, config: ConfigRegistry): boolean {
  const [winStartH, winStartM] = (config.flexExpectedSchedStartWindow?.start || '07:00').split(':').map(Number);
  const [winEndH, winEndM] = (config.flexExpectedSchedStartWindow?.end || '10:00').split(':').map(Number);
  const rawStartMinOfDay = rawStart.getHours() * 60 + rawStart.getMinutes();
  return rawStartMinOfDay >= winStartH * 60 + winStartM && rawStartMinOfDay <= winEndH * 60 + winEndM;
}

/**
 * §4.8: once a flex employee arrives past the cutoff, the shift-time update
 * itself always happens — but the LATE/cover correction (and its variance
 * charge) only fires if flexBypassesMinuteBands is on, OR the lateness still
 * falls inside a configured Late Login band anyway. Extracted as its own
 * function (previously an inline expression only reconciliationEngine.ts
 * itself evaluated) so the Scenario Guide simulator can share the exact same
 * gate instead of re-deriving it — a past drift: the simulator always
 * charged the full late+cover variance with no band check at all, disagreeing
 * with a real run whenever flexBypassesMinuteBands was OFF and the lateness
 * fell outside every Late Login band.
 */
export function flexLateBandFires(config: ConfigRegistry, tier: RoleTier, lateMin: number): boolean {
  return config.flexBypassesMinuteBands !== false || !!lookupPolicyRule(config, 'Late Login', tier, lateMin);
}

/** Shared ranking of result categories so any code path deciding "does this new
 * finding outrank what's already on the row" (standard branch, and — since the
 * F08/F14 fix — both flex branches too) uses the exact same order. */
export const RESULT_CATEGORY_SEVERITY: Record<TaaResultCategory, number> = {
  NO_ACTION_REQUIRED: 0, SHIFT_CHANGED: 1, LATE_AND_COVER_ADDED: 2, MARKED_ABSENT: 3, COGNOS_DATA_GAP: 3,
};

/**
 * Find the policy rule (if any) matching a segment type, tier, and measured
 * minutes. Single source of truth for every minute-band decision in the
 * engine — also reused by the Scenario Guide page so its reference table and
 * simulator can never disagree with what a real reconciliation run does.
 */
export function lookupPolicyRule(config: ConfigRegistry, segmentType: string, tier: RoleTier, minutes: number): PolicyRuleItem | undefined {
  // `??`, not `||`: a deliberate maxMinutes of 0 is falsy and used to be rewritten as
  // 99999 (unbounded), turning a band meant to cover only "exactly 0 minutes" into one
  // that swallowed every variance. Same for minMinutes.
  return config.policyRules.find(
    r => r.segmentType === segmentType && r.tier === tier && minutes >= (r.minMinutes ?? 0) && minutes <= (r.maxMinutes ?? 99999)
  );
}

/** Normalize username: local(v) = v.split('@')[0]. */
export function extractLocalUsername(val: string | undefined): string {
  if (!val) return '';
  const trimmed = val.trim();
  return trimmed.includes('@') ? trimmed.split('@')[0].trim() : trimmed;
}

// Resolve the employee's username (§4.7). This is now PURELY "the username,
// if EMP_EXTRA_2 gives us one, else empty" — no falling back to a stripped
// EMP_EMAIL_ADR local part or to EMP_LAST_NAME. Both of those fallbacks were a
// latent correctness bug, not just formatting: a personal-domain local part
// can belong to a different employee entirely (al_wafa@hotmail.com's real
// alias is unrelated to "al_wafa"), and a bare surname handed to a mailbox
// resolver is exactly the same danger. The email-address and name-fallback
// paths now live in emailDrafts.ts's resolveEmailRecipient, which the caller
// runs with the full three-rule priority (username > corporate email > name)
// once it also has the Cognos NAME and the corporate-domain allow-list.
export function resolveOutlookRecipient(identity: AspectIdentity | undefined): {
  resolvedUsername: string;
  alias: string;
  emailAdr: string;
  isTerminated: boolean;
} {
  if (!identity) return { resolvedUsername: '', alias: '', emailAdr: '', isTerminated: false };

  const isTerminated = !!(identity.EMP_TERM_DATE && identity.EMP_TERM_DATE.trim()) || identity.EMP_ACTIVE_FLAG === 'F';
  const resolvedUsername = extractLocalUsername(identity.EMP_EXTRA_2);

  return { resolvedUsername, alias: identity.EMP_EXTRA_2 || '', emailAdr: identity.EMP_EMAIL_ADR || '', isTerminated };
}


/**
 * A time on a day other than the row's own SIGN IN DATE is printed with its date. A night
 * shift's 07:00 logout and its 07:00 scheduled end look identical as bare "07:00" strings,
 * so a reviewer checking a cross-midnight absence cannot tell which calendar day either
 * belongs to — the single most confusing thing about auditing the rows that matter most.
 */
function formatTimeQualified(d: Date | null, referenceDay: Date | null): string {
  if (!d) return '';
  if (!referenceDay) return formatTimeHHMM(d);
  const sameDay =
    d.getFullYear() === referenceDay.getFullYear() &&
    d.getMonth() === referenceDay.getMonth() &&
    d.getDate() === referenceDay.getDate();
  return sameDay ? formatTimeHHMM(d) : `${formatTimeHHMM(d)} (${formatDateDDMMYYYY(d)})`;
}

/** Full "DD/MM/YYYY HH:MM" for the trace modal's date+time display, shown regardless of day. */
function formatDateTimeFull(d: Date | null): string {
  if (!d) return '';
  return `${formatDateDDMMYYYY(d)} ${formatTimeHHMM(d)}`;
}

/**
 * ASPECT correction-row SegmentDate must be the PHYSICAL calendar date the
 * event actually happened on (doc/aspect.md §2's field-4-vs-field-5
 * distinction), never the shift's nominal day (nominateDate/nomDateStr).
 * Defect fix: 8 correction-emission sites previously hardcoded SegmentDate
 * to nomDateStr even when their own SegmentStarttime came from a
 * cross-midnight instant — a shift 19:00->03:00 with an early logout at
 * 02:52 wrote SegmentDate as the PREVIOUS day, 24 hours off from when the
 * agent actually logged off. Every correction row whose SegmentStarttime is
 * derived from a real Date must derive SegmentDate from that SAME Date via
 * this helper, not from the row's nominal day.
 */
function formatSegmentDate(instant: Date): string {
  return formatDateDDMMYYYY(instant);
}

/** One entry in the per-row variance audit trail. */
function traceMeasurement(
  label: VarianceTrace['measurements'][number]['label'],
  anchorLabel: string,
  anchorTime: Date | null,
  comparedTo: Date | null,
  minutes: number,
  rule: PolicyRuleItem | undefined,
  referenceDay: Date | null,
): VarianceTrace['measurements'][number] {
  return {
    label,
    anchorLabel,
    anchorTime: formatTimeQualified(anchorTime, referenceDay),
    comparedTo: formatTimeQualified(comparedTo, referenceDay),
    minutes,
    bandId: rule?.id,
    bandDescription: rule?.conditionDescription,
    bandAction: rule?.action,
  };
}

function normalizeSectionKey(value: string): string {
  return (value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function resolveRoutingSection(cognos: CognosRecord, identity: AspectIdentity | undefined): {
  section: string;
  source: TaaSectionSource;
  cognosSection: string;
  aspectIdentitySection: string;
  mismatch: boolean;
} {
  const cognosSection = (cognos['SECTION'] || '').trim();
  const aspectIdentitySection = (identity?.EMP_EXTRA_4 || '').trim();
  const hasCognosSection = cognosSection.length > 0;
  const hasAspectSection = aspectIdentitySection.length > 0;
  const mismatch = hasCognosSection && hasAspectSection && normalizeSectionKey(cognosSection) !== normalizeSectionKey(aspectIdentitySection);

  if (hasCognosSection) {
    return { section: cognosSection, source: 'COGNOS_SECTION', cognosSection, aspectIdentitySection, mismatch };
  }
  if (hasAspectSection) {
    return { section: aspectIdentitySection, source: 'ASPECT_EMP_EXTRA_4_FALLBACK', cognosSection, aspectIdentitySection, mismatch: false };
  }
  return { section: '', source: 'NONE', cognosSection, aspectIdentitySection, mismatch: false };
}

function formatConfigIssue(issue: ConfigValidationIssue): string {
  return `${issue.field}: ${issue.message}`;
}

function buildInvalidConfigOutput(
  cognosRecords: CognosRecord[],
  identityMap: Map<string, AspectIdentity>,
  config: ConfigRegistry,
  issues: ConfigValidationIssue[],
  verificationAudit?: VerificationOverrideAudit,
): ReconciliationOutput {
  // Only an all-clock-value problem reports INVALID_CONFIG_TIME ("fix it to a valid
  // HH:MM"). Anything else — including the 'band' kind added when policy-band
  // overlaps became blocking — reports INVALID_CONFIG_VALUE, whose text points at
  // the setting rather than at a wall-clock field. The previous `some(kind ===
  // 'value')` test defaulted every non-'value' kind to INVALID_CONFIG_TIME, so a
  // band overlap told the user to go fix a clock value that was never wrong.
  // The specific issue text is carried verbatim in ruleFired below either way.
  const holdReason: HoldReasonCode = issues.every(issue => issue.kind === 'time') ? 'INVALID_CONFIG_TIME' : 'INVALID_CONFIG_VALUE';
  const issueLines = issues.map(formatConfigIssue);
  const ruleFired = `Invalid Config Registry value(s): ${issueLines.join(' | ')}`;

  let flexRowsCount = 0;
  const rows: ReconciliationRow[] = cognosRecords.map((cognos, rowIndex) => {
    const pfNo = (cognos['PF NO'] || '').trim();
    const identity = identityMap.get(pfNo);
    const tier = determineRoleTier(identity, config);
    const isFlex = isFlexStaff(identity, config);
    if (isFlex) flexRowsCount++;
    const recipientInfo = resolveOutlookRecipient(identity);
    const sectionResolution = resolveRoutingSection(cognos, identity);

    return {
      id: `rec-${rowIndex}-${pfNo}`,
      originalCognos: { ...cognos },
      TAA_MARKER: 'DERIVED_ANALYSIS_DO_NOT_REPLACE_OFFICIAL_REPORT',
      TAA_TIER: isFlex ? 'FLEX' : tier,
      TAA_OT1: '',
      TAA_OT2: '',
      TAA_SCH_HOURS_RECOMPUTED: 0,
      TAA_SCH_HOURS_FORMATTED: formatMinutesToHHMM(0),
      TAA_EFFECTIVE_START: '',
      TAA_EFFECTIVE_END: '',
      TAA_CMS_IN: '',
      TAA_CMS_OUT: '',
      TAA_LATE_MIN: 0,
      TAA_EARLY_MIN: 0,
      TAA_VERDICT: holdReason,
      TAA_ACTION: 'MANUAL_REVIEW_REQUIRED',
      TAA_ACTIONS_FIRED: 'MANUAL_REVIEW_REQUIRED',
      TAA_RESULT_CATEGORY: 'COGNOS_DATA_GAP',
      TAA_COGNOS_AGREE: false,
      TAA_DISAGREE_REASON: holdReason,
      TAA_USERNAME: recipientInfo.resolvedUsername,
      TAA_SECTION: sectionResolution.section,
      TAA_SECTION_SOURCE: sectionResolution.source,
      TAA_ASPECT_SECTION: sectionResolution.aspectIdentitySection,
      TAA_SECTION_MISMATCH: sectionResolution.mismatch,
      TAA_IS_TERMINATED: recipientInfo.isTerminated,
      columnComparisons: [],
      TAA_MISMATCH_COUNT: 0,
      TAA_MISMATCH_COLUMNS: '',
      TAA_FILLED_COLUMNS: '',
      TAA_LEAVE_TYPE_RECOMPUTED: '',
      TAA_LEAVE_TYPE_STATUS: 'NOT_COMPARABLE',
      TAA_LEAVE_TYPE_MATCH_BASIS: 'NONE',
      includeInOutput: false,
      includeDecisionSource: 'auto',
      reviewCompleted: false,
      reviewStatus: 'NOT_TOUCHED',
      holdReason,
      holdReasonText: `${HOLD_REASON_TEXT[holdReason]} (locked — cannot be included until resolved)`,
      coverFallbackNote: '',
      details: {
        isFlex,
        isLeaveDay: false,
        hasOvertime: false,
        ruleFired,
        reducedOfficeHoursApplied: false,
        punchCount: 0,
        releaseMinutes: 0,
        nursingMinutes: 0,
        otInternalRemovalMinutes: 0,
        chargedVarianceMinutes: 0,
        aspectSegments: [],
        punches: [],
        generatedCorrections: [],
        configValidationIssues: issueLines,
        sectionSource: sectionResolution.source,
        cognosSection: sectionResolution.cognosSection,
        aspectIdentitySection: sectionResolution.aspectIdentitySection,
        sectionMismatch: sectionResolution.mismatch,
      },
    };
  });

  const aspectCorrectionsCsv = generateAspectCorrectionsCsv([]);
  const annotatedCognosCsv = generateAnnotatedCognosFile(rows, ',', config, verificationAudit, []);
  const annotatedCognosTsv = generateAnnotatedCognosFile(rows, '\t', config, verificationAudit, []);
  const emailActionsJson = generateEmailActionsJson([], rows, config);

  return {
    rows,
    aspectCorrections: [],
    aspectCorrectionsCsv,
    annotatedCognosCsv,
    annotatedCognosTsv,
    emailActions: [],
    emailActionsJson,
    verificationAudit,
    summary: {
      totalRecords: cognosRecords.length,
      shiftChangedCount: 0,
      lateCoverCount: 0,
      markedAbsentCount: 0,
      noActionCount: 0,
      cognosDataGapCount: cognosRecords.length,
      disagreementsResolvedCount: 0,
      overtimeRowsCount: 0,
      flexRowsCount,
      otConvertedCount: 0,
      otRlsAdjustedCount: 0,
      heldForReviewCount: rows.length,
      mismatchCount: 0,
      // Every row here is forced-held (INVALID_CONFIG_TIME/INVALID_CONFIG_VALUE)
      // with no corrections — all of them qualify for Must Check via clause 1.
      mustCheckCount: rows.length,
    },
  };
}

/**
 * Main Reconciliation Engine — recompute-then-compare (PRD §4.13).
 *
 * Pipeline: (1) recompute every employee-day's schedule from ASPECT alone
 * (scheduleRecompute.ts); (2) attribute CMS punches globally so no punch is
 * ever claimed by two days (punchAttribution.ts); (3) decide the
 * verdict/action per the attendance rules; (4) compare every relevant
 * Cognos column against the recomputed value (cognosComparison.ts); (5) gate
 * inclusion in the ASPECT correction output on that comparison, never on
 * Cognos's own numbers.
 */
export function runReconciliation(input: ReconciliationInput): ReconciliationOutput {
  const { cognosRecords, aspectSegments, aspectIdentities, cmsPunches, config, verificationAudit, processingDate } = input;

  const identityMap = new Map<string, AspectIdentity>();
  // Duplicate Identity Master rows for the same EMP_ID previously resolved by
  // silently letting the LAST record win (Map.set overwrites the first).
  // Keep the FIRST instead and flag the EMP_ID so every row for that employee
  // is held rather than an invisible pick between two disagreeing source
  // rows — a byte-identical duplicate (a harmless re-imported copy) is not
  // flagged, only one that actually disagrees.
  const conflictingIdentityIds = new Set<string>();
  aspectIdentities.forEach(id => {
    if (!id.EMP_ID) return;
    const key = id.EMP_ID.trim();
    const existing = identityMap.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(id)) conflictingIdentityIds.add(key);
      return;
    }
    identityMap.set(key, id);
  });

  const configValidationIssues = validateConfigForRun(config);
  if (configValidationIssues.length > 0) {
    return buildInvalidConfigOutput(cognosRecords, identityMap, config, configValidationIssues, verificationAudit);
  }

  const segmentGroups = new Map<string, AspectSegment[]>();
  aspectSegments.forEach(seg => {
    // Defect fix: this previously keyed on the raw ASPECT NOM_DATE string
    // (e.g. "1/9/2026") while the Cognos side below is always normalized via
    // parseDateTimeString -> formatDateDDMMYYYY (e.g. "01/09/2026") — two
    // representations of the same day that never matched, silently sending
    // every row to COGNOS_DATA_GAP whenever the export's date formatting
    // wasn't already zero-padded DD/MM/YYYY. A NOM_DATE that fails to parse
    // is dropped from the join (normalizeDateKey returns null, key becomes
    // 'EMPID|null') rather than kept under its raw string, which would just
    // reintroduce a different silent mismatch.
    const dateKey = normalizeDateKey(seg.NOM_DATE);
    const key = `${seg.EMP_ID.trim()}|${dateKey}`;
    if (!segmentGroups.has(key)) segmentGroups.set(key, []);
    segmentGroups.get(key)!.push(seg);
  });

  // All segments per employee (unkeyed by date), for forward-looking Cover
  // Placement (§4.11) — needs the employee's future schedule beyond today.
  const segmentsByEmp = new Map<string, AspectSegment[]>();
  aspectSegments.forEach(seg => {
    const empKey = seg.EMP_ID.trim();
    if (!segmentsByEmp.has(empKey)) segmentsByEmp.set(empKey, []);
    segmentsByEmp.get(empKey)!.push(seg);
  });

  const punchesByLoginId = new Map<string, CMSPunch[]>();
  cmsPunches.forEach(p => {
    const lKey = p.LoginID.trim();
    if (!punchesByLoginId.has(lKey)) punchesByLoginId.set(lKey, []);
    punchesByLoginId.get(lKey)!.push(p);
  });

  // ---- Pass 1: recompute every row's schedule from ASPECT alone, and build
  // the scheduled windows punch attribution will use. Cognos DUTY1/DUTY-2
  // are never read here — they become comparison targets only, in Pass 3.
  const recomputeByRow = new Map<number, DayScheduleRecompute>();
  const nomDateByRow = new Map<number, string>();
  const pfNoByRow = new Map<number, string>();
  const signInDateUnparseableByRow = new Map<number, boolean>();
  const windows: ScheduledWindow[] = [];

  for (let rowIndex = 0; rowIndex < cognosRecords.length; rowIndex++) {
    const cognos = cognosRecords[rowIndex];
    const pfNo = (cognos['PF NO'] || '').trim();
    const loginId = (cognos['LOGIN ID'] || '').trim();
    const signInDateStr = (cognos['SIGN IN DATE'] || '').trim();
    const signInParsed = parseDateTimeString(signInDateStr);
    signInDateUnparseableByRow.set(rowIndex, !signInParsed);
    const nomDateStr = signInParsed ? formatDateDDMMYYYY(signInParsed) : '';
    nomDateByRow.set(rowIndex, nomDateStr);
    pfNoByRow.set(rowIndex, pfNo);

    const empSegs = segmentGroups.get(`${pfNo}|${nomDateStr}`) || [];
    const recompute = recomputeDaySchedule(empSegs, config);
    recomputeByRow.set(rowIndex, recompute);

    if (recompute.rawStart && recompute.rawEnd) {
      // Flex-aware search/coverage end (fixes the false-ABSENT-under-a-narrow-window
      // defect): a flex agent legally arriving after the cutoff has their whole shift
      // shift-and-clamp to start at arrival (or the cutoff) and run the SAME scheduled
      // duration from there (§4.8, evaluated later in Pass 3) — so their real logout can
      // land hours after rawEnd. Punch search/coverage must reach that latest legally
      // possible clamped end, not just rawEnd, or a genuine late logout under a narrow
      // cmsPunchSearchWindowHours is simply never found and the day is wrongly ABSENT.
      // attributionEnd = rawEnd + max(0, cutoff-on-rawStart's-day − rawStart) — the
      // largest amount the flex shift could have been pushed later, added onto rawEnd.
      let attributionEnd = recompute.rawEnd;
      if (isFlexStaff(identityMap.get(pfNo), config) && isFlexScheduleWithinExpectedWindow(recompute.rawStart, config)) {
        const cutoffTimeStr = config.flexCutoffTime || '10:00';
        const [ch, cm] = cutoffTimeStr.split(':').map(Number);
        const cutoffOnRawStartDay = new Date(
          recompute.rawStart.getFullYear(), recompute.rawStart.getMonth(), recompute.rawStart.getDate(), ch, cm, 0
        );
        const pushMs = Math.max(0, cutoffOnRawStartDay.getTime() - recompute.rawStart.getTime());
        attributionEnd = new Date(recompute.rawEnd.getTime() + pushMs);
      }
      windows.push({ key: `row-${rowIndex}`, loginId, rawStart: recompute.rawStart, rawEnd: recompute.rawEnd, attributionEnd, isSynthetic: false });
    } else if (recompute.isLeaveDay && signInParsed) {
      // Leave-day CMS check must never be date-keyed (§ Non-negotiables): a
      // synthetic full-day window still goes through the same ± search-hours
      // attribution as a real shift, so a cross-midnight punch is found.
      const dayStart = new Date(signInParsed.getFullYear(), signInParsed.getMonth(), signInParsed.getDate(), 0, 0, 0);
      const rawEnd = addDays(dayStart, 1);
      windows.push({ key: `row-${rowIndex}`, loginId, rawStart: dayStart, rawEnd, attributionEnd: rawEnd, isSynthetic: true });
    }
    // Else: genuine data gap (no ASPECT segments at all) — no window, no CMS
    // lookup; handled explicitly as COGNOS_DATA_GAP below.
  }

  const attribution: AttributionResult = attributePunches(windows, punchesByLoginId, config);

  // Sequential cover placement tracker for this run (§4.11 Step 3).
  const placedCoversThisRun = new Map<string, { start: Date; end: Date; duration: number }[]>();

  const results: ReconciliationRow[] = [];
  const allCorrections: AspectCorrectionRow[] = [];
  const emailActions: EmailActionItem[] = [];

  let shiftChangedCount = 0;
  let lateCoverCount = 0;
  let markedAbsentCount = 0;
  let noActionCount = 0;
  let disagreementsResolvedCount = 0;
  let overtimeRowsCount = 0;
  let flexRowsCount = 0;
  let otConvertedCount = 0;
  let otRlsAdjustedCount = 0;
  let heldForReviewCount = 0;
  let mismatchCount = 0;

  for (let rowIndex = 0; rowIndex < cognosRecords.length; rowIndex++) {
    const cognos = cognosRecords[rowIndex];
    const pfNo = pfNoByRow.get(rowIndex)!;
    const rowId = `rec-${rowIndex}-${pfNo}`;
    const loginId = (cognos['LOGIN ID'] || '').trim();
    const nomDateStr = nomDateByRow.get(rowIndex)!;
    const signInDateUnparseable = signInDateUnparseableByRow.get(rowIndex)!;
    const recompute = recomputeByRow.get(rowIndex)!;
    const windowKey = `row-${rowIndex}`;

    const identity = identityMap.get(pfNo);
    const tier = determineRoleTier(identity, config);
    const isFlex = isFlexStaff(identity, config);
    if (isFlex) flexRowsCount++;

    const recipientInfo = resolveOutlookRecipient(identity);
    const sectionResolution = resolveRoutingSection(cognos, identity);

    const empSegs = segmentGroups.get(`${pfNo}|${nomDateStr}`) || [];
    const employeeHasSegmentsOnOtherDates = empSegs.length === 0 && segmentsByEmp.has(pfNo);

    const hasOvertime = recompute.ot1Segments.length > 0 || recompute.ot2Segments.length > 0;
    if (hasOvertime) overtimeRowsCount++;

    // ---- Pass 2: attributed CMS punches for this row's window.
    const matchingPunches = attribution.punchesByWindowKey.get(windowKey) || [];
    const coverageSufficient = attribution.coverageSufficientByWindowKey.get(windowKey) ?? true;
    const hasAnyCmsData = attribution.hasAnyCmsDataByWindowKey.get(windowKey) ?? false;
    const shiftSpanCovered = attribution.shiftSpanCoveredByWindowKey.get(windowKey) ?? true;
    const missingJoinKey = attribution.missingJoinKeyWindowKeys.has(windowKey);
    const ambiguousAttribution = attribution.ambiguousAttributionWindowKeys.has(windowKey);
    const contestedAttribution = attribution.contestedWindowKeys.has(windowKey);
    // F4: a still-clocked-in punch (LogoutDateTime null — the CMS export was
    // generated before this employee logged out) proves a login but must
    // never contribute a logout time to variance math; excluded from the
    // last-logout computation below and forces its own hold (GATE, further
    // down) rather than letting a real-but-incomplete punch masquerade as
    // "no evidence" or feed a bogus duration.
    const closedMatchingPunches = matchingPunches.filter(
      (p): p is typeof p & { LogoutDateTime: Date } => p.LogoutDateTime !== null
    );
    const hasOpenPunchEvidence = closedMatchingPunches.length < matchingPunches.length;

    let actualFirstLoginDt: Date | null = null;
    let actualLastLogoutDt: Date | null = null;
    if (matchingPunches.length > 0) {
      const sortedByIn = [...matchingPunches].sort((a, b) => a.LoginDateTime.getTime() - b.LoginDateTime.getTime());
      actualFirstLoginDt = truncateToMinute(sortedByIn[0].LoginDateTime);
      if (closedMatchingPunches.length > 0) {
        const sortedByOut = [...closedMatchingPunches].sort((a, b) => b.LogoutDateTime.getTime() - a.LogoutDateTime.getTime());
        actualLastLogoutDt = truncateToMinute(sortedByOut[0].LogoutDateTime);
      }
    }
    const attendanceSpanMinutes = actualFirstLoginDt && actualLastLogoutDt ? diffInMinutes(actualFirstLoginDt, actualLastLogoutDt) : 0;
    // Phase 9 (informational only): sum of each attributed CLOSED punch's own
    // login->logout duration — the same quantity Cognos's own SIGNIN DURATION
    // measures (staffed/logged-in time), shown ALONGSIDE (never replacing) the
    // span above in the trace UI so a reviewer can judge for themselves
    // whether this CMS export's punches carry real session lengths or are
    // near-instantaneous swipe events. Purely additive: does not feed
    // insufficientEvidence, attendanceSpanMinutes, or any verdict/hold logic
    // below, and is never included in either export (see cognosComparison.ts,
    // ResultsView.tsx — UI-only by design).
    const staffedMinutes = closedMatchingPunches.length > 0
      ? closedMatchingPunches.reduce((sum, p) => sum + Math.max(0, diffInMinutes(truncateToMinute(p.LoginDateTime), truncateToMinute(p.LogoutDateTime))), 0)
      : null;
    // D4 fix: a single attributed punch (or a near-zero span) is no longer
    // automatic proof of absence — it is only trustworthy evidence when the
    // CMS export actually has enough coverage around this window to be sure
    // no companion punch was simply out of range.
    // D-F fix: "insufficient" must be judged on whether we actually derived a
    // login instant AND a logout instant, never on the raw number of CMS rows
    // that contributed them. A single closed CMS row can legitimately carry a
    // real multi-hour login->logout span (measured against a real export: 44%
    // of rows span an hour or more) — the old `matchingPunches.length <= 1`
    // proxy discarded that evidence purely because it arrived as one row
    // instead of two, and auto-Absented a genuinely valid, fully-evidenced day.
    const bothAnchorsPresent = !!actualFirstLoginDt && !!actualLastLogoutDt;
    const insufficientEvidence = !bothAnchorsPresent || attendanceSpanMinutes < config.minAttendanceSpanMinutes;
    const insufficientCoverage = insufficientEvidence && !coverageSufficient;
    // A day left short of punches BECAUSE a neighbouring shift claimed one that could
    // equally have been this day's is an attribution judgement, not evidence of absence.
    // Marking someone absent on that basis costs them a day's pay over a tie-break.
    // Leave days are excluded: a leave day with no punches is the CORRECT outcome
    // (LEAVE_EXCLUDED), not evidence starvation, so holding it would be pure noise. The
    // guard exists solely to stop thin evidence turning into an unpaid ABSENT.
    const contestedThinEvidence = insufficientEvidence && contestedAttribution && !recompute.isLeaveDay;

    const rawStartDt = recompute.rawStart;
    const rawEndDt = recompute.rawEnd;
    // Row-level output label: a flex-tagged employee scheduled outside the flex
    // window already runs standard/OPS attendance math (see the branch below) —
    // this only decides whether TAA_TIER/role_tier says so too, per
    // config.flexOutsideWindowTreatAsOps. The FLEX_SCHEDULE_OUTSIDE_WINDOW hold
    // is untouched by this flag.
    const isFlexOutOfWindow = isFlex && !!rawStartDt && !isFlexScheduleWithinExpectedWindow(rawStartDt, config);
    const effectiveTierLabel: RoleTier | 'FLEX' =
      (isFlexOutOfWindow && config.flexOutsideWindowTreatAsOps) ? tier : (isFlex ? 'FLEX' : tier);
    // Bug fix (2026-09-11 validation pass): these must be `let`, not `const` — the
    // flex branch below (§4.8) judges lateness/earliness against a SHIFTED anchor
    // (rounded arrival / cutoff clamp), not the raw ASPECT schedule, and must update
    // these so TAA_EFFECTIVE_START/TAA_EFFECTIVE_END (and the email template's
    // effective_start/effective_end placeholders) report what the row was actually
    // judged against instead of silently keeping the pre-shift raw times.
    let effectiveStartDt = recompute.effectiveStart;
    let effectiveEndDt = recompute.effectiveEnd;
    // F5: a login swipe more than cmsPunchSearchWindowHours before rawStart is
    // dropped (do not widen that radius — a night shift's tail must not swallow
    // the next day's login). If the only in-window punch is then a logout, Rule 6
    // would auto-Absent. Hold instead when an earlier unclaimed swipe exists for
    // this Login ID.
    const attributedInstant = actualFirstLoginDt;
    const logoutOnlyAttributed = !!(
      rawStartDt && rawEndDt && attributedInstant
      && Math.abs(attributedInstant.getTime() - rawEndDt.getTime())
        <= Math.abs(attributedInstant.getTime() - rawStartDt.getTime())
    );
    const hasUnclaimedEarlierSwipe = !!(rawStartDt && attribution.unclaimedPunches.some(p =>
      (p.LoginID || '').trim() === loginId
      && (p.LoginDateTime.getTime() < rawStartDt.getTime() || (p.LogoutDateTime !== null && p.LogoutDateTime.getTime() < rawStartDt.getTime()))
    ));
    const earlySwipeLogoutOnlyHold = insufficientEvidence
      && !insufficientCoverage
      && !recompute.isLeaveDay
      && logoutOnlyAttributed
      && hasUnclaimedEarlierSwipe;

    // Truncated-export coverage hold (Bug 2 fix): with 2+ usable punches (both anchors
    // present, so insufficientEvidence is already false — the existing single-punch
    // coverage gate above/below only fires when evidence itself is thin), a CMS export
    // that simply stops mid-shift can still leave the LAST attributed logout short of
    // this shift's own end. Measured per-login that reads identically to "left early" —
    // but it is a coverage gap, not proof of an early departure, whenever the export's
    // own extent (not just this login's punches) does not reach the shift's end either.
    // Guarded to real shift days only (rawEndDt/effectiveEndDt non-null — never fires for
    // a synthetic leave-day window, which has neither) and never for a login the export
    // never mentions at all (hasAnyCmsData=false is the normal No-Login path instead).
    const truncatedExportCoverageHold = !insufficientEvidence
      && hasAnyCmsData
      && !shiftSpanCovered
      && !recompute.isLeaveDay
      && !!rawEndDt
      && !!effectiveEndDt
      && !!actualLastLogoutDt
      && actualLastLogoutDt.getTime() < effectiveEndDt.getTime();

    // Start Decision Logic
    let verdict = 'PRESENT';
    let action: TaaActionCode = 'NO_ACTION';
    let resultCategory: TaaResultCategory = 'NO_ACTION_REQUIRED';
    let disagreeReason = 'MATCH';
    let ruleFired = 'Normal on-time arrival';
    let lateMin = 0;
    let earlyMin = 0;
    let chargedVarianceMin = 0;
    // Phase 4 "worst-case Cognos" gate (2026-09-24, plan worst-case-cognos-gate.md): the
    // charged Late Logout minutes and Cover Not Attended shortfall this row actually used,
    // captured from whichever branch (standard or flex, either arrival window) computed
    // them below — Gate B (SCH DURATION) reruns lookupPolicyRule against these plus the
    // Cognos gap to prove a COVER shortfall in Cognos's own figure can't cross a band.
    let gateLateLogoutChargeMin = 0;
    let gateCoverShortfallMin = 0;
    // Same-basis logout gate (2026-09-27): the attended-COVER credit the Late Logout charge used,
    // and the early-logout anchor (flex reduced-office-hours target, else the effective end), so
    // a disputed Cognos LEFT EARLY can be re-evaluated on exactly TAA's own basis.
    let gateLateLogoutCreditMin = 0;
    let gateEarlyAnchorDt: Date | null = null;
    let firedCommunicationRule: CommunicationRule = 'NA';
    let emailTemplateKey: EmailTemplateKey = 'generic';
    let forcedHoldReason: HoldReasonCode | undefined;
    // Phase A audit trail: every measured variance, the anchor it was measured from, and
    // the policy band that matched. Reproducing a verdict by hand must not require reading
    // the code — a payroll reviewer reads this.
    const varianceMeasurements: VarianceTrace['measurements'] = [];
    // WP5/B5/B15 — the REAL Date interval behind every variance that actually fired an
    // action (rule resolved to something other than NO_ACTION), kept separately from
    // varianceMeasurements because traceMeasurement formats its Date pair into display
    // strings and discards the Dates. Used only to test technical-segment coverage; never
    // pushed for a below-band measurement (that would let a stray technical segment block
    // a hold that should never have needed one) and never for Cover Not Attended or a
    // no-login absence via this array — those two are handled separately (see below).
    const firedVarianceIntervals: { label: string; start: Date; end: Date }[] = [];
    const referenceDay = rawStartDt || parseDateTimeString(nomDateStr);
    const rowCorrections: AspectCorrectionRow[] = [];
    // Absent + OT co-occurrence (§4.6c) must fire at most ONCE per
    // employee-day even though multiple independent rules (e.g. Late Login
    // AND Early Logout, or Rule 7 alongside either) can each mark the day
    // Absent in the same iteration — a second physical conversion of the
    // same OT segment is a duplicate segment change ASPECT's uploader
    // rejects the whole batch for, so this must be prevented at the point
    // of emission, not cleaned up afterward by dedupeAspectCorrections.
    // D-A fix: every action code that actually fired on this row (not just
    // the single most-severe one reported as TAA_ACTION) — a row with both
    // a late-login AND an early-logout finding must report both, not let
    // the later-evaluated rule silently mask the first.
    const firedActionCodes: string[] = [];
    // One entry per fired action carrying its OWN communication/template/variance —
    // unlike the row-level firedCommunicationRule/emailTemplateKey/chargedVarianceMin,
    // which applyMoreSevere*/downstream checks overwrite as a more severe finding is
    // discovered. This is what lets the email-building step below draft one notice per
    // fired action instead of only the most-severe survivor. Deliberately excludes
    // OT_TO_SHIFT/ADJUST_OT_RLS — payroll bookkeeping conversions, never independently
    // communicated per Rules to be taken.csv (always NA) — so they never get a bare
    // "generic/NA" email of their own; they still show in TAA_ACTIONS_FIRED via
    // firedActionCodes, and in the "OT Updates" sheet, unaffected.
    const firedActionDetails: { actionCode: TaaActionCode; communicationRule: CommunicationRule; emailTemplateKey: EmailTemplateKey; varianceMin: number; note: string }[] = [];
    const pushFiredAction = (detail: { actionCode: TaaActionCode; communicationRule: CommunicationRule; emailTemplateKey: EmailTemplateKey; varianceMin: number; note: string }) => {
      firedActionCodes.push(detail.actionCode);
      firedActionDetails.push(detail);
    };
    let otConvertedThisRow = false;
    const convertOtOnce = (): number => {
      if (otConvertedThisRow) return 0;
      otConvertedThisRow = true;
      const converted = convertOtSegmentsToShift(recompute.ot1Segments, recompute.ot2Segments, pfNo, nomDateStr, rowCorrections, config);
      if (converted > 0) firedActionCodes.push('OT_TO_SHIFT');
      return converted;
    };

    const isLeaveDay = recompute.isLeaveDay;
    // §4.6f: does this employee-day already carry a day-level absence marker
    // (config.existingAbsenceMarkerCodes, default ABSENT/Absent NS/NC)? Checked
    // against empSegs (every segment on the day), not recompute.additionSegments —
    // these markers carry no start/stop of their own and are never an ADDITION.
    const existingAbsenceMarkerSegment = empSegs.find(s => isCodeInConfiguredSet(s.SEG_CODE, config.existingAbsenceMarkerCodes || []));
    // WP1/D6: a configured leave code recorded as a DAY-LEVEL marker (no DURATION and no
    // START/STOP) on a day that ALSO carries a work segment. isLeaveDay above requires zero
    // work segments, so such a day was never treated as leave and, with no CMS punches, fell
    // through to the no-login rule and proposed an Absent NS/NC against someone whose leave
    // ASPECT already records (real: SICK / ANNUAL / TRMNTD / REGN days, Cognos agreeing).
    const dayLevelLeaveMarkers = empSegs.filter(s =>
      isCodeInConfiguredSet(s.SEG_CODE, config.leaveSegmentCodes || [])
      && s.DURATION == null && !(s.START_MOMENT || '').trim() && !(s.STOP_MOMENT || '').trim());
    // Same first-login..last-logout attendance measure the leave-day and existing-marker
    // gates use, computed once so the new gates below judge attendance identically.
    let sessionSpanMinutes = 0;
    if (matchingPunches.length > 0 && closedMatchingPunches.length > 0) {
      const spanStart = truncateToMinute(matchingPunches.reduce((min, p) => (p.LoginDateTime.getTime() < min.getTime() ? p.LoginDateTime : min), matchingPunches[0].LoginDateTime));
      const spanEnd = truncateToMinute(closedMatchingPunches.reduce((max, p) => (p.LogoutDateTime.getTime() > max.getTime() ? p.LogoutDateTime : max), closedMatchingPunches[0].LogoutDateTime));
      sessionSpanMinutes = Math.max(0, diffInMinutes(spanStart, spanEnd));
    }
    const invalidConfigClockFields = [
      ['flexCutoffTime', config.flexCutoffTime],
      ['flexExpectedSchedStartWindow.start', config.flexExpectedSchedStartWindow?.start],
      ['flexExpectedSchedStartWindow.end', config.flexExpectedSchedStartWindow?.end],
      ['coverFallbackDefaultTime', config.coverFallbackDefaultTime],
    ].filter(([, value]) => !value || !parseClockTimeString(value));

    const lookupRule = (segmentType: string, minutes: number): PolicyRuleItem | undefined =>
      lookupPolicyRule(config, segmentType, tier, minutes);

    // Reduced office hours (Flex, one configured weekday): the attendance relaxation only
    // applies to in-window Flex rows (the same rows that run the Flex algorithm below);
    // cover exclusion applies to ALL Flex staff regardless of window, per user decision —
    // placing make-up hours on a short office day is wrong no matter when their shift starts.
    const reducedOfficeHoursMin: number | null =
      rawStartDt && isFlex && isFlexScheduleWithinExpectedWindow(rawStartDt, config)
        ? getReducedOfficeHoursRequirement(nomDateStr, config)
        : null;
    const reducedHoursCoverExcluded = isFlex && !!config.reducedOfficeHoursEnabled;
    let reducedOfficeHoursApplied = false;

    // --- GATE 0: Missing CMS join key (user-confirmed) — a blank Cognos
    // LOGIN ID cannot be joined to any CMS punch at all. This is missing
    // evidence, not evidence of absence, and takes priority over every other
    // gate (leave-day, flex, standard) since none of them can be evaluated
    // without a join key either. Never auto-Absent; always held for review.
    if (missingJoinKey) {
      verdict = 'MISSING_LOGIN_ID';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'MISSING_CMS_JOIN_KEY';
      ruleFired = 'Cognos LOGIN ID is blank — cannot join to CMS punch data; needs manual verification, not an automatic Absent';
      forcedHoldReason = 'MISSING_CMS_JOIN_KEY';
    } else if (hasOpenPunchEvidence) {
      // --- GATE: still clocked in (F4) — a CMS punch attributed to this window has
      // no logout (the export's literal "0"/blank sentinel: this employee's shift
      // was still in progress when the export was generated). Sits above every
      // other gate for the same reason MISSING_CMS_JOIN_KEY does: with the true
      // attendance duration genuinely unknown, no attendance rule below (span,
      // late/early, absence) can be evaluated honestly against it. Never guesses a
      // logout time (e.g. "now") — always held until a later export supplies one.
      verdict = 'STILL_CLOCKED_IN';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'STILL_CLOCKED_IN';
      ruleFired = 'CMS shows this login still clocked in (no logout recorded) as of the export — attendance cannot be computed until a logout is available; never auto-resolved';
      forcedHoldReason = 'STILL_CLOCKED_IN';
    } else if (contestedThinEvidence) {
      // --- GATE: contested punch attribution left this day short of evidence.
      // Sits above every verdict gate for the same reason MISSING_CMS_JOIN_KEY does: with
      // the punch record in doubt, no attendance rule below can be evaluated honestly.
      verdict = 'CONTESTED_PUNCH_ATTRIBUTION';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'CONTESTED_SINGLE_PUNCH';
      ruleFired = `Only ${matchingPunches.length} CMS punch(es) attributed to this day, and another shift for the same login claimed a punch that could equally have belonged here — verify manually, never auto-Absent`;
      forcedHoldReason = 'CONTESTED_SINGLE_PUNCH';
    } else if (earlySwipeLogoutOnlyHold) {
      verdict = 'CONTESTED_PUNCH_ATTRIBUTION';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'CONTESTED_SINGLE_PUNCH';
      ruleFired = `Only an in-window logout punch was attributed; an earlier unclaimed swipe for this Login ID sits outside the ±${config.cmsPunchSearchWindowHours}h search window — verify manually, never auto-Absent`;
      forcedHoldReason = 'CONTESTED_SINGLE_PUNCH';
    } else if (truncatedExportCoverageHold) {
      // --- GATE (Bug 2 fix): a CMS export that stops mid-shift, on a day with usable
      // multi-punch evidence, can otherwise compute a large fabricated "left early" against
      // an employee who was actually still present when the export was generated. Sits
      // below the thin-evidence gates above (those already own the "not enough punches at
      // all" case) and above every attendance rule below, since none of them can honestly
      // tell a real early departure apart from an export that simply stopped recording.
      verdict = 'INSUFFICIENT_CMS_COVERAGE';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'INSUFFICIENT_CMS_COVERAGE';
      ruleFired = `CMS export does not fully cover this shift's own window around ${nomDateStr} — last attributed punch at ${formatTimeQualified(actualLastLogoutDt, referenceDay)} is before the shift's end and the export does not reach that far, cannot confirm the rest of the shift`;
      forcedHoldReason = 'INSUFFICIENT_CMS_COVERAGE';
    } else if (recompute.invalidDateTimeSegments.length > 0) {
      // A malformed or incomplete ASPECT time can alter both paid scheduled
      // minutes and the attendance anchors. No downstream rule may act on it.
      verdict = 'INVALID_ASPECT_DATETIME';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'INVALID_ASPECT_DATETIME';
      ruleFired = `${recompute.invalidDateTimeSegments.length} ASPECT segment(s) contain invalid or incomplete date/time evidence — correct the source schedule and recalculate`;
      forcedHoldReason = 'INVALID_ASPECT_DATETIME';
    } else if (invalidConfigClockFields.length > 0) {
      verdict = 'INVALID_CONFIG_TIME';
      action = 'MANUAL_REVIEW_REQUIRED';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = 'INVALID_CONFIG_TIME';
      ruleFired = `Invalid Config Registry clock value(s): ${invalidConfigClockFields.map(([field]) => field).join(', ')} — expected HH:MM`;
      forcedHoldReason = 'INVALID_CONFIG_TIME';
    } else
    // --- GATE 4.6b: Leave-Day Integrity Check (never date-keyed — matchingPunches
    // already comes from the global time-window attribution above) ---
    if (isLeaveDay) {
      let totalPunchMinutes = 0;
      if (matchingPunches.length > 0 && closedMatchingPunches.length > 0) {
        const earliestLogin = truncateToMinute(matchingPunches.reduce((min, p) => (p.LoginDateTime.getTime() < min.getTime() ? p.LoginDateTime : min), matchingPunches[0].LoginDateTime));
        const latestLogout = truncateToMinute(closedMatchingPunches.reduce((max, p) => (p.LogoutDateTime.getTime() > max.getTime() ? p.LogoutDateTime : max), closedMatchingPunches[0].LogoutDateTime));
        totalPunchMinutes = Math.max(0, diffInMinutes(earliestLogin, latestLogout));
      }
      if (totalPunchMinutes >= config.leaveLoginThresholdMinutes) {
        verdict = 'ABSENT';
        action = 'ABSENT_SEGMENT';
        resultCategory = 'MARKED_ABSENT';
        disagreeReason = 'LEAVE_DAY_LOGIN_ANOMALY';
        ruleFired = `Login of ${totalPunchMinutes}m on leave day exceeds ${config.leaveLoginThresholdMinutes}m threshold`;
        firedCommunicationRule = lookupRule('No Login or No Logout', 0)?.communication || 'NA';
        emailTemplateKey = 'generic';
        // The minutes worked on a scheduled leave day ARE this finding's measured
        // variance — previously left at 0, so the row and the annotated export
        // reported a blank variance for a finding whose entire content is "they
        // were logged in for N minutes on a leave day". Set here so the row,
        // the annotated export and the drafted email all report the same number.
        chargedVarianceMin = totalPunchMinutes;
        pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: totalPunchMinutes, note: ruleFired });
        rowCorrections.push({
          Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
          SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Anomaly: Attendance recorded on scheduled leave day',
        });
        markedAbsentCount++;
        otConvertedCount += convertOtOnce();
      } else {
        verdict = 'LEAVE_EXCLUDED';
        action = 'NO_ACTION';
        resultCategory = 'NO_ACTION_REQUIRED';
        disagreeReason = cognos['LEAVE TYPE'] === 'U-ABSENT' ? 'COGNOS_FALSE_ABSENCE' : 'MATCH';
        ruleFired = 'Scheduled Leave Day - Excluded from attendance penalties';
        noActionCount++;
      }
    } else if (existingAbsenceMarkerSegment) {
      // --- GATE 4.6f: Absence Already Recorded (user-reported, 2026-09-18) ---
      // A day carrying an ABSENT/Absent NS/NC segment still has a SHIFT/OT addition
      // segment alongside it (real export: 71 of 78 sampled absence-marked days do),
      // so isLeaveDay above never sees it — additionSegments.length > 0 fails its
      // gate. Left unguarded, the no-login branches below (flex ~line 894, standard
      // ~line 1223) then fire Rule 5 on zero CMS punches regardless, writing a
      // SECOND day-level absence marker on top of the first and drafting a fresh
      // NS/NC notice — a duplicate write the codebase already treats as a bug
      // elsewhere (see the retire-before-insert comment on the OT/SHIFT conversion
      // below). Provenance-agnostic by design: it does not matter whether the
      // existing marker was placed by WFM or by an earlier TAA run — either way the
      // day is already actioned. TAA tags the correct action for what the data
      // already shows; it does not adjudicate WHY the day is absent (that needs
      // supporting documents and HR-system confirmation TAA has no access to), so
      // this gate never reads MEMO and never upgrades ABSENT to Absent NS/NC.
      let totalPunchMinutes = 0;
      if (matchingPunches.length > 0 && closedMatchingPunches.length > 0) {
        const earliestLogin = truncateToMinute(matchingPunches.reduce((min, p) => (p.LoginDateTime.getTime() < min.getTime() ? p.LoginDateTime : min), matchingPunches[0].LoginDateTime));
        const latestLogout = truncateToMinute(closedMatchingPunches.reduce((max, p) => (p.LogoutDateTime.getTime() > max.getTime() ? p.LogoutDateTime : max), closedMatchingPunches[0].LogoutDateTime));
        totalPunchMinutes = Math.max(0, diffInMinutes(earliestLogin, latestLogout));
      }
      if (totalPunchMinutes >= config.leaveLoginThresholdMinutes) {
        // CMS contradicts the recorded absence. Removing it would restore a day's
        // pay — a human decision with the source documents, never an auto-write.
        verdict = 'ABSENCE_CONTRADICTED_BY_CMS';
        action = 'MANUAL_REVIEW_REQUIRED';
        resultCategory = 'COGNOS_DATA_GAP';
        disagreeReason = 'ABSENT_MARKED_BUT_ATTENDED';
        ruleFired = `ASPECT already tags this day "${existingAbsenceMarkerSegment.SEG_CODE}", but CMS shows ${totalPunchMinutes}m of attendance — a recorded absence is never auto-reversed`;
        forcedHoldReason = 'ABSENT_MARKED_BUT_ATTENDED';
      } else {
        verdict = 'ABSENCE_ALREADY_RECORDED';
        action = 'NO_ACTION';
        resultCategory = 'NO_ACTION_REQUIRED';
        disagreeReason = 'MATCH';
        ruleFired = `ASPECT already tags this day "${existingAbsenceMarkerSegment.SEG_CODE}" — day already actioned; no duplicate segment and no notice emitted`;
        noActionCount++;
      }
    } else if (!rawStartDt || !rawEndDt) {
      // Cognos Data Gap: no ASPECT schedule at all for this employee-day.
      verdict = 'COGNOS_DATA_GAP';
      action = 'NO_ACTION';
      resultCategory = 'COGNOS_DATA_GAP';
      disagreeReason = signInDateUnparseable
        ? 'UNPARSEABLE_SIGN_IN_DATE'
        : employeeHasSegmentsOnOtherDates
          ? 'COGNOS_ASPECT_DATE_MISMATCH'
          : 'COGNOS_DATA_GAP_SEGMENT_NOT_REFLECTED';
      ruleFired = signInDateUnparseable
        ? `Cognos SIGN IN DATE "${cognos['SIGN IN DATE']}" could not be parsed — row needs manual review, not auto-corrected`
        : employeeHasSegmentsOnOtherDates
          ? `ASPECT has segments for this employee but none on ${nomDateStr} — dates do not overlap between the two exports`
          : 'No schedule or duty block defined in data';
      if (signInDateUnparseable) {
        action = 'MANUAL_REVIEW_REQUIRED';
        forcedHoldReason = 'UNPARSEABLE_SIGN_IN_DATE';
      } else {
        forcedHoldReason = 'COGNOS_DATA_GAP';
      }
      // D14 fix: cognosDataGapCount used to be incremented only here — but
      // resultCategory is set to 'COGNOS_DATA_GAP' at 12 different gates
      // across this function, not just this one. The counter is now derived
      // from the finished rows (see the summary object below) so it can
      // never again diverge from the category it claims to count.
    } else if (dayLevelLeaveMarkers.length > 0 && recompute.shiftSegments.length > 0 && sessionSpanMinutes < config.leaveLoginThresholdMinutes) {
      // --- GATE (WP1/D6): day-level leave already recorded on a scheduled day, no real
      // attendance. Requires a scheduled SHIFT: leave REPLACES a shift, whereas leave plus
      // overtime-only (e.g. P/H-LV with a standalone OT2) means the overtime was the work the
      // agent agreed to do, so no attendance there is a genuine absence and must still reach the
      // no-login rule (pinned by trust-matrix case f7-ot2-standalone-onleave-noshow).
      // Treated exactly like a leave day: excluded from attendance penalties.
      // The MIXED_LEAVE_AND_WORK_SEGMENTS soft hold is still assigned further down, so a
      // reviewer still sees the row — but it no longer carries an absence recommendation
      // for a day ASPECT already records as leave. Real attendance (>= the leave-login
      // threshold) is NOT intercepted and is evaluated normally, as before.
      verdict = 'LEAVE_EXCLUDED';
      action = 'NO_ACTION';
      resultCategory = 'NO_ACTION_REQUIRED';
      disagreeReason = 'MATCH';
      ruleFired = `Day-level leave (${dayLevelLeaveMarkers.map(s => s.SEG_CODE).join(', ')}) already recorded on this scheduled day — excluded from attendance penalties; no absence proposed`;
      noActionCount++;
    } else if (recompute.fullDayRemovalMinutes > 0) {
      // --- GATE (WP1/D7): a bare full-day removal (no duration, no times — e.g. TRN NEW
      // HIRES) takes the whole scheduled day off the hours and collapses the effective
      // window to zero length. Late, early, late-logout and no-login are not stable
      // concepts against a zero-length window, so none of them is computed: doing so
      // produced "482m late logout" for an agent who simply attended a training day, and
      // Absent NS/NC for trainees who never punch CMS. The soft hold
      // FULL_DAY_REMOVAL_ON_SCHEDULED_DAY is still assigned below for a human to review.
      verdict = 'FULL_DAY_REMOVAL_REVIEW';
      action = 'NO_ACTION';
      resultCategory = 'NO_ACTION_REQUIRED';
      disagreeReason = 'MATCH';
      ruleFired = 'A full-day removal takes this whole scheduled day off the hours (effective window collapsed to zero) — attendance rules are not evaluated against a zero-length window; review with the source documents';
      noActionCount++;
    } else if (isFlex && isFlexScheduleWithinExpectedWindow(rawStartDt, config)) {
      // --- FLEX STAFF ALGORITHM (§4.8) ---
      const cutoffTimeStr = config.flexCutoffTime || '10:00';
      const [ch, cm] = cutoffTimeStr.split(':').map(Number);
      const cutoffDt = new Date(rawStartDt.getFullYear(), rawStartDt.getMonth(), rawStartDt.getDate(), ch, cm, 0);

      // SHIFT effective duration, not the raw addition span. SHIFT+OT (or a split
      // span) must not treat overtime/gaps as hours to slide with the flex pair.
      const flexDurationMin = flexShiftedDurationMinutes(recompute, rawStartDt, rawEndDt);
      const schedDurationHHMM = formatMinutesToHHMM(flexDurationMin);

      if (insufficientEvidence && insufficientCoverage) {
        // D-C fix: flex staff previously had NO evidence/coverage guard at
        // all — a single genuine swipe (or a coverage-edge gap) was
        // evaluated as a normal arrival instead of being held for review.
        // Mirrors the standard path's guard (below) exactly.
        verdict = 'INSUFFICIENT_CMS_COVERAGE';
        action = 'MANUAL_REVIEW_REQUIRED';
        resultCategory = 'COGNOS_DATA_GAP';
        disagreeReason = 'INSUFFICIENT_CMS_COVERAGE';
        ruleFired = `Flex Staff: CMS export does not fully cover the required window around ${nomDateStr} — ${matchingPunches.length} punch(es) found, cannot confirm attendance`;
        forcedHoldReason = 'INSUFFICIENT_CMS_COVERAGE';
      } else if (!actualFirstLoginDt && !actualLastLogoutDt) {
        // R6 fix: resolveNoLoginDecision honours every configured action, not just
        // NO_ACTION vs. hardcoded ABSENT_NS_NC — see its own doc comment.
        // F03 removal (2026-09-09, user-confirmed): CMS is a full-staff
        // export with no per-agent filtering, so "zero punches for this
        // login" is a single standard rule regardless of whether other
        // logins in the file have data — no per-row scope-gap guess. Upload-
        // time headcount mapping (assessHeadcountMapping in
        // punchAttribution.ts, surfaced in App.tsx) replaces the guard by
        // flagging the risk once, visibly, before Calculate.
        const noLoginRule = lookupRule('No Login Record', 0);
        const decision = resolveNoLoginDecision(noLoginRule, 'Flex Staff: ');
        verdict = decision.verdict;
        action = decision.action;
        resultCategory = decision.resultCategory;
        disagreeReason = decision.disagreeReason;
        ruleFired = decision.ruleFired;
        firedCommunicationRule = decision.communicationRule;
        if (decision.holdReason) {
          forcedHoldReason = decision.holdReason;
        } else if (decision.markAbsent) {
          emailTemplateKey = 'no_login_ns_nc';
          pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: 0, note: ruleFired });
          rowCorrections.push({
            Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'Absent NS/NC', nominateDate: nomDateStr, SegmentDate: '',
            SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Flex Staff Absence NS/NC',
          });
          markedAbsentCount++;
          otConvertedCount += convertOtOnce();
        } else if (decision.resultCategory === 'NO_ACTION_REQUIRED') {
          noActionCount++;
        }
      } else if (insufficientEvidence) {
        // D-C fix: genuine single punch with sufficient coverage — Rule 6
        // (missing login or logout) applies to flex staff too, not just
        // standard staff. Flex status changes the LATENESS rule (10:00
        // cutoff), never the evidence rule.
        verdict = 'ABSENT';
        action = 'ABSENT_SEGMENT';
        resultCategory = 'MARKED_ABSENT';
        disagreeReason = 'SINGLE_PUNCH_ONLY';
        ruleFired = 'Flex Staff: single punch only recorded without matching punch';
        firedCommunicationRule = lookupRule('No Login or No Logout', 0)?.communication || 'NA';
        emailTemplateKey = 'single_punch_absence';
        pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: 0, note: ruleFired });
        rowCorrections.push({
          Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
          SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Flex Incomplete Punch Pair Absence',
        });
        markedAbsentCount++;
        otConvertedCount += convertOtOnce();
      } else if (actualFirstLoginDt!.getTime() <= cutoffDt.getTime()) {
        // Branch A: Arrival <= 10:00 (No penalty, shift update pair if needed)
        const snappedArrival = snapTimeToGrid(actualFirstLoginDt!, config.roundingGridMinutes, config.roundingDirection);
        const originalStartHHMM = formatTimeHHMM(rawStartDt);
        const snappedArrivalHHMM = formatTimeHHMM(snappedArrival);

        if (originalStartHHMM !== snappedArrivalHHMM) {
          verdict = 'SHIFT_CHANGED_FLEX';
          action = 'SHIFT_UPDATE_FLEX';
          resultCategory = 'SHIFT_CHANGED';
          disagreeReason = 'MATCH';
          pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: 0, note: `Flex shift updated: ${originalStartHHMM} -> ${snappedArrivalHHMM}` });
          ruleFired = `Flex arrival at ${formatTimeHHMM(actualFirstLoginDt!)} (rounded to ${snappedArrivalHHMM} <= ${cutoffTimeStr})`;
          rowCorrections.push({
            Code: config.shiftUpdateOriginalCode, ID: pfNo, SegmentCode: SHIFT_CHANGE_SEGMENT_CODE, nominateDate: nomDateStr, SegmentDate: formatSegmentDate(rawStartDt),
            SegmentStarttime: originalStartHHMM, Segmentduration: schedDurationHHMM, Memo: config.originalShiftMemo,
          });
          rowCorrections.push({
            Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: SHIFT_CHANGE_SEGMENT_CODE, nominateDate: nomDateStr, SegmentDate: formatSegmentDate(snappedArrival),
            SegmentStarttime: snappedArrivalHHMM, Segmentduration: schedDurationHHMM, Memo: config.updatedShiftMemo,
          });
          shiftChangedCount++;
        } else {
          verdict = 'PRESENT';
          action = 'NO_ACTION';
          resultCategory = 'NO_ACTION_REQUIRED';
          disagreeReason = 'MATCH';
          ruleFired = 'Flex arrival on scheduled start';
        }

        // Downstream: early-logout / late-logout against the NEW shifted end
        // (§4.8 "every downstream rule applies normally against the NEW end").
        // F14 fix: extended through any OT segment genuinely scheduled to
        // start right where the shift-only end lands — see flexAttendanceEndDt.
        const newEndDt = flexAttendanceEndDt(recompute, new Date(snappedArrival.getTime() + flexDurationMin * 60 * 1000), actualLastLogoutDt);
        // Reduced office hours: relax ONLY the early-logout target (capped at newEndDt — this
        // policy may only ever relax, never demand attendance past the real shift end, and the
        // cap keeps earlyAnchor <= effectiveEndDt so a logout cannot be simultaneously early and
        // late — see evaluateEarlyAndLateLogout's earlyCheckEndDt doc comment).
        const reducedTargetMs = reducedOfficeHoursMin !== null && actualFirstLoginDt
          ? actualFirstLoginDt.getTime() + reducedOfficeHoursMin * 60000
          : null;
        // Only a target strictly before the normal end relaxes anything; otherwise behave exactly as feature-off.
        const earlyCheckEndDt = reducedTargetMs !== null && reducedTargetMs < newEndDt.getTime()
          ? new Date(reducedTargetMs)
          : undefined;
        if (earlyCheckEndDt && actualLastLogoutDt && actualLastLogoutDt.getTime() < newEndDt.getTime()) {
          reducedOfficeHoursApplied = true;
        }
        // Report the shifted anchors, not the raw pre-flex schedule (see the `let` comment above).
        effectiveStartDt = snappedArrival;
        effectiveEndDt = newEndDt;
        const downstream = evaluateEarlyAndLateLogout({
          effectiveEndDt: newEndDt,
          rawEndDt: newEndDt,
          actualLastLogoutDt,
          tier,
          config,
          pfNo,
          nomDateStr,
          segmentsByEmp,
          placedCoversThisRun,
          creditableCovers: [...coverIntervalsFromSegments(recompute.coverSegments), ...coverIntervalsFromCorrections(rowCorrections)],
          presence: presenceBlocks(closedMatchingPunches),
          processingDate,
          actualFirstLoginDt,
          effectiveStartDt,
          earlyCheckEndDt,
          reducedHoursCoverExcluded,
        });
        if (downstream) {
          earlyMin = downstream.earlyMin;
          gateLateLogoutChargeMin = downstream.lateLogoutMin; // Phase 4 gate capture (see declaration above)
          gateLateLogoutCreditMin = downstream.lateLogoutCreditedMin ?? 0;
          gateEarlyAnchorDt = earlyCheckEndDt ?? newEndDt;
          if (downstream.earlyMin > 0) {
            varianceMeasurements.push(traceMeasurement('EARLY_LOGOUT', earlyCheckEndDt ? 'reduced office hours target (actual login + required minutes, capped at shift end)' : 'flex shifted end (snapped start + SHIFT effective duration)', earlyCheckEndDt ?? newEndDt, actualLastLogoutDt, downstream.earlyMin, lookupRule('Early Logout', downstream.earlyMin), referenceDay));
          } else if (downstream.lateLogoutMin > 0) {
            varianceMeasurements.push(traceMeasurement('LATE_LOGOUT', 'flex shifted end (snapped start + SHIFT effective duration)', newEndDt, actualLastLogoutDt, downstream.lateLogoutMin, lookupRule('Late Logout', downstream.lateLogoutMin), referenceDay));
          }
          if (downstream.varianceInterval) firedVarianceIntervals.push(downstream.varianceInterval); // WP5/B5/B15
          if (downstream.infoNote) ruleFired += ` | ${downstream.infoNote}`;
        }
        // Only let the downstream check override the verdict when it actually
        // found an early/late-logout issue — its "nothing fired" result must
        // never clobber an already-decided SHIFT_CHANGED_FLEX/PRESENT verdict.
        if (downstream && downstream.resultCategory !== 'NO_ACTION_REQUIRED') {
          verdict = downstream.verdict;
          action = downstream.action;
          resultCategory = downstream.resultCategory;
          ruleFired += ` | ${downstream.ruleFired}`;
          // D-A fix: ADD the downstream variance rather than overwrite — a
          // shift-changed-flex day that ALSO has an early/late logout must
          // report the full picture, not just the later-evaluated number.
          chargedVarianceMin += downstream.chargedVarianceMin;
          firedCommunicationRule = downstream.communicationRule;
          emailTemplateKey = downstream.emailTemplateKey;
          pushFiredAction({ actionCode: downstream.action, communicationRule: downstream.communicationRule, emailTemplateKey: downstream.emailTemplateKey, varianceMin: downstream.chargedVarianceMin, note: downstream.ruleFired });
          downstream.rowCorrections.forEach(c => rowCorrections.push(c));
          if (downstream.holdReason) forcedHoldReason = downstream.holdReason;
          if (downstream.resultCategory === 'LATE_AND_COVER_ADDED' && !downstream.holdReason) {
            lateCoverCount++;
            const downstreamCover = downstream.rowCorrections.find(c => c.SegmentCode === 'COVER');
            if (downstreamCover) lateCoverCountedRows.add(downstreamCover);
          }
          if (downstream.resultCategory === 'MARKED_ABSENT') {
            markedAbsentCount++;
            otConvertedCount += convertOtOnce();
          }
        }

        // F08/F14 fix: flex staff previously never ran Rule 7 (Cover Not
        // Attended) or Rule 8 (RLS added to OT with no adjustment) at all —
        // both lived only in the standard branch below. A flex employee
        // could miss required cover minutes with zero correction, or have a
        // release genuinely overlap their OT with no adjustment ever
        // emitted. Same shared logic as the standard branch, applied here
        // with a severity-aware upgrade so it never downgrades whatever
        // Branch A already decided.
        const applyMoreSevereFlex = (newCategory: TaaResultCategory, newAction: TaaActionCode, newVerdict: string, comm: CommunicationRule, templateKey: EmailTemplateKey) => {
          if (RESULT_CATEGORY_SEVERITY[newCategory] >= RESULT_CATEGORY_SEVERITY[resultCategory]) {
            resultCategory = newCategory; action = newAction; verdict = newVerdict; firedCommunicationRule = comm; emailTemplateKey = templateKey;
          }
        };
        const coverNotAttendedFindings = evaluateCoverNotAttended(recompute.coverSegments, actualFirstLoginDt, actualLastLogoutDt, tier, config);
        gateCoverShortfallMin += coverNotAttendedFindings.reduce((acc, f) => acc + f.shortfallMinutes, 0); // Phase 4 gate capture (see declaration above)
        buildCoverNotAttendedOutcomes(
          coverNotAttendedFindings,
          { tier, tierLabel: ' FLEX', referenceDay, pfNo, nomDateStr, config, segmentsByEmp, placedCoversThisRun, processingDate, reducedHoursCoverExcluded },
        ).forEach(outcome => {
          varianceMeasurements.push(outcome.varianceMeasurement);
          chargedVarianceMin += outcome.chargedVarianceMinDelta;
          ruleFired += ` | ${outcome.ruleNote}`;
          if (outcome.correction) rowCorrections.push(outcome.correction);
          if (outcome.holdReason) {
            forcedHoldReason = outcome.holdReason;
          } else {
            firedVarianceIntervals.push(...outcome.varianceIntervals); // WP5/B5/B15
            applyMoreSevereFlex(outcome.resultCategory, outcome.actionCode, outcome.isAbsent ? 'ABSENT' : verdict, outcome.communicationRule, outcome.emailTemplateKey);
            pushFiredAction({ actionCode: outcome.actionCode, communicationRule: outcome.communicationRule, emailTemplateKey: outcome.emailTemplateKey, varianceMin: outcome.chargedVarianceMinDelta, note: outcome.ruleNote });
            if (outcome.isAbsent) {
              markedAbsentCount++;
              otConvertedCount += convertOtOnce();
            } else if (outcome.correction) {
              // D16 fix: moveCoverForward's placed cover was never counted here,
              // even though it is a real LATE/Log_off/COVER-shaped correction —
              // the exact gap between the Late & Cover card and its own tab.
              lateCoverCount++;
              lateCoverCountedRows.add(outcome.correction);
            }
          }
        });
        buildRlsOtAdjustmentOutcomes(
          evaluateRlsOtAdjustment(recompute.ot1Segments, recompute.ot2Segments, recompute.removalSegments, tier, config),
          pfNo, nomDateStr, config, otConvertedThisRow,
        ).forEach(outcome => {
          ruleFired += ` | ${outcome.ruleNote}`;
          firedActionCodes.push('ADJUST_OT_RLS');
          rowCorrections.push(outcome.originalCorrection, outcome.adjustedCorrection, ...outcome.extraOtRows, ...outcome.shiftInsertRows);
          otRlsAdjustedCount++;
        });

        if (resultCategory === 'NO_ACTION_REQUIRED') {
          noActionCount++;
        }
      } else {
        // Branch B: Arrival > 10:00 — shift update clamped to cutoff + Late+Cover
        // measured from the cutoff, full variance, minute-bands bypassed unless
        // configured otherwise (§4.8, flexBypassesMinuteBands).
        const originalStartHHMM = formatTimeHHMM(rawStartDt);
        lateMin = diffInMinutes(cutoffDt, actualFirstLoginDt!);
        const bandFires = flexLateBandFires(config, tier, lateMin);
        varianceMeasurements.push(traceMeasurement('FLEX_PAST_CUTOFF', `flex cutoff ${cutoffTimeStr} (not the scheduled start)`, cutoffDt, actualFirstLoginDt, lateMin, lookupRule('Late Login', lateMin), referenceDay));
        // "Already actioned" rule (see findAlreadyRecordedIncident): a LATE ASPECT already holds
        // for this day means no LATE and no COVER — only the shift-update pair (a schedule move,
        // not the late itself) is still emitted, so the row reads as a plain flex shift update.
        const recordedFlexLate = bandFires ? findAlreadyRecordedIncident(segmentsByEmp.get(pfNo) || [], nomDateStr, 'LATE', lateMin) : null;
        chargedVarianceMin = recordedFlexLate ? 0 : lateMin;

        verdict = 'LATE';
        action = recordedFlexLate ? 'SHIFT_UPDATE_FLEX' : 'SHIFT_UPDATE_AND_LATE_COVER_FLEX';
        resultCategory = recordedFlexLate ? 'SHIFT_CHANGED' : 'LATE_AND_COVER_ADDED';
        disagreeReason = 'MATCH';
        ruleFired = recordedFlexLate
          ? `Flex arrival ${formatTimeHHMM(actualFirstLoginDt!)} past ${cutoffTimeStr} cutoff by ${lateMin}m -> ${recordedFlexLate.note}`
          : `Flex arrival ${formatTimeHHMM(actualFirstLoginDt!)} past ${cutoffTimeStr} cutoff by ${lateMin}m (Full variance charged)`;
        firedCommunicationRule = 'NA'; // flex over-cutoff Late+Cover carries no email per §4.1 band-1 rows
        pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: chargedVarianceMin, note: ruleFired });

        rowCorrections.push({
          Code: config.shiftUpdateOriginalCode, ID: pfNo, SegmentCode: SHIFT_CHANGE_SEGMENT_CODE, nominateDate: nomDateStr, SegmentDate: formatSegmentDate(rawStartDt),
          SegmentStarttime: originalStartHHMM, Segmentduration: schedDurationHHMM, Memo: config.originalShiftMemo,
        });
        rowCorrections.push({
          Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: SHIFT_CHANGE_SEGMENT_CODE, nominateDate: nomDateStr, SegmentDate: formatSegmentDate(cutoffDt),
          SegmentStarttime: cutoffTimeStr, Segmentduration: schedDurationHHMM, Memo: config.updatedShiftMemo,
        });

        // Downstream: shift end also moved by the clamp — check early/late logout.
        // F14 fix: extended through any OT segment genuinely scheduled to
        // start right where the shift-only end lands — see flexAttendanceEndDt.
        // Computed before cover placement so a same-day cover can't start inside the moved shift.
        const newEndDt = flexAttendanceEndDt(recompute, new Date(cutoffDt.getTime() + flexDurationMin * 60 * 1000), actualLastLogoutDt);
        // Reduced office hours: relax ONLY the early-logout target (capped at newEndDt — see the
        // on-time-arrival branch's identical comment for why the cap is mandatory).
        const reducedTargetMs = reducedOfficeHoursMin !== null && actualFirstLoginDt
          ? actualFirstLoginDt.getTime() + reducedOfficeHoursMin * 60000
          : null;
        // Only a target strictly before the normal end relaxes anything; otherwise behave exactly as feature-off.
        const earlyCheckEndDt = reducedTargetMs !== null && reducedTargetMs < newEndDt.getTime()
          ? new Date(reducedTargetMs)
          : undefined;
        if (earlyCheckEndDt && actualLastLogoutDt && actualLastLogoutDt.getTime() < newEndDt.getTime()) {
          reducedOfficeHoursApplied = true;
        }

        if (bandFires && !recordedFlexLate) {
          // WP5/B5/B15 — flex bypasses minute bands by default, so "bandFires" (not a
          // lookupRule() != NO_ACTION check) is this branch's own definition of "the
          // action actually fired".
          firedVarianceIntervals.push({ label: 'FLEX_PAST_CUTOFF', start: cutoffDt, end: actualFirstLoginDt! });
          rowCorrections.push({
            Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'LATE', nominateDate: nomDateStr, SegmentDate: formatSegmentDate(cutoffDt),
            SegmentStarttime: cutoffTimeStr, Segmentduration: formatMinutesToHHMM(lateMin), Memo: `TAA Flex Late Login ${lateMin}m past ${cutoffTimeStr}`,
          });
          {
            const coverPlacement = tryPlaceSameDayCover(
              pfNo, nomDateStr, lateMin, 'afterEnd',
              { firstLoginDt: actualFirstLoginDt, lastLogoutDt: actualLastLogoutDt, effectiveStartDt: null, shiftEndDt: newEndDt },
              segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, presenceBlocks(closedMatchingPunches), reducedHoursCoverExcluded,
            ) ?? placeCoverSegment(pfNo, nomDateStr, lateMin, segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, processingDate, reducedHoursCoverExcluded);
            if (coverPlacement) {
              rowCorrections.push(coverPlacement);
              lateCoverCount++;
              lateCoverCountedRows.add(coverPlacement);
            } else {
              forcedHoldReason = describeCoverPlacementFailure(nomDateStr, segmentsByEmp.get(pfNo) || [], config, processingDate, reducedHoursCoverExcluded);
            }
          }
        } else {
          shiftChangedCount++;
        }

        // Report the shifted anchors, not the raw pre-flex schedule (see the `let` comment above).
        effectiveStartDt = cutoffDt;
        effectiveEndDt = newEndDt;
        const downstream = evaluateEarlyAndLateLogout({
          effectiveEndDt: newEndDt, rawEndDt: newEndDt, actualLastLogoutDt, tier, config, pfNo, nomDateStr, segmentsByEmp, placedCoversThisRun,
          creditableCovers: [...coverIntervalsFromSegments(recompute.coverSegments), ...coverIntervalsFromCorrections(rowCorrections)],
          presence: presenceBlocks(closedMatchingPunches),
          processingDate, actualFirstLoginDt, effectiveStartDt,
          earlyCheckEndDt, reducedHoursCoverExcluded,
        });
        if (downstream) {
          earlyMin = downstream.earlyMin;
          gateLateLogoutChargeMin = downstream.lateLogoutMin; // Phase 4 gate capture (see declaration above)
          gateLateLogoutCreditMin = downstream.lateLogoutCreditedMin ?? 0;
          gateEarlyAnchorDt = earlyCheckEndDt ?? newEndDt;
          if (downstream.earlyMin > 0) {
            varianceMeasurements.push(traceMeasurement('EARLY_LOGOUT', earlyCheckEndDt ? 'reduced office hours target (actual login + required minutes, capped at shift end)' : 'flex shifted end (cutoff + SHIFT effective duration)', earlyCheckEndDt ?? newEndDt, actualLastLogoutDt, downstream.earlyMin, lookupRule('Early Logout', downstream.earlyMin), referenceDay));
          } else if (downstream.lateLogoutMin > 0) {
            varianceMeasurements.push(traceMeasurement('LATE_LOGOUT', 'flex shifted end (cutoff + SHIFT effective duration)', newEndDt, actualLastLogoutDt, downstream.lateLogoutMin, lookupRule('Late Logout', downstream.lateLogoutMin), referenceDay));
          }
          if (downstream.varianceInterval) firedVarianceIntervals.push(downstream.varianceInterval); // WP5/B5/B15
          if (downstream.infoNote) ruleFired += ` | ${downstream.infoNote}`;
        }
        if (downstream && downstream.resultCategory !== 'NO_ACTION_REQUIRED') {
          ruleFired += ` | ${downstream.ruleFired}`;
          // D-A fix: ADD, don't drop — a late-cutoff flex day that ALSO
          // trips a downstream early/late logout must report both variances.
          chargedVarianceMin += downstream.chargedVarianceMin;
          firedCommunicationRule = downstream.communicationRule;
          emailTemplateKey = downstream.emailTemplateKey;
          pushFiredAction({ actionCode: downstream.action, communicationRule: downstream.communicationRule, emailTemplateKey: downstream.emailTemplateKey, varianceMin: downstream.chargedVarianceMin, note: downstream.ruleFired });
          downstream.rowCorrections.forEach(c => rowCorrections.push(c));
          if (downstream.holdReason) forcedHoldReason = downstream.holdReason;
          if (downstream.resultCategory === 'MARKED_ABSENT') {
            resultCategory = 'MARKED_ABSENT';
            action = downstream.action;
            verdict = downstream.verdict;
            markedAbsentCount++;
            otConvertedCount += convertOtOnce();
          } else if (downstream.resultCategory === 'LATE_AND_COVER_ADDED' && !downstream.holdReason) {
            lateCoverCount++;
            const downstreamCover = downstream.rowCorrections.find(c => c.SegmentCode === 'COVER');
            if (downstreamCover) lateCoverCountedRows.add(downstreamCover);
          }
        }

        // F08/F14 fix: same as Branch A above — Rule 7 (Cover Not Attended)
        // and Rule 8 (RLS added to OT with no adjustment) previously never
        // ran for flex staff at all.
        const applyMoreSevereFlexB = (newCategory: TaaResultCategory, newAction: TaaActionCode, newVerdict: string, comm: CommunicationRule, templateKey: EmailTemplateKey) => {
          if (RESULT_CATEGORY_SEVERITY[newCategory] >= RESULT_CATEGORY_SEVERITY[resultCategory]) {
            resultCategory = newCategory; action = newAction; verdict = newVerdict; firedCommunicationRule = comm; emailTemplateKey = templateKey;
          }
        };
        const coverNotAttendedFindings = evaluateCoverNotAttended(recompute.coverSegments, actualFirstLoginDt, actualLastLogoutDt, tier, config);
        gateCoverShortfallMin += coverNotAttendedFindings.reduce((acc, f) => acc + f.shortfallMinutes, 0); // Phase 4 gate capture (see declaration above)
        buildCoverNotAttendedOutcomes(
          coverNotAttendedFindings,
          { tier, tierLabel: ' FLEX', referenceDay, pfNo, nomDateStr, config, segmentsByEmp, placedCoversThisRun, processingDate, reducedHoursCoverExcluded },
        ).forEach(outcome => {
          varianceMeasurements.push(outcome.varianceMeasurement);
          chargedVarianceMin += outcome.chargedVarianceMinDelta;
          ruleFired += ` | ${outcome.ruleNote}`;
          if (outcome.correction) rowCorrections.push(outcome.correction);
          if (outcome.holdReason) {
            forcedHoldReason = outcome.holdReason;
          } else {
            firedVarianceIntervals.push(...outcome.varianceIntervals); // WP5/B5/B15
            applyMoreSevereFlexB(outcome.resultCategory, outcome.actionCode, outcome.isAbsent ? 'ABSENT' : verdict, outcome.communicationRule, outcome.emailTemplateKey);
            pushFiredAction({ actionCode: outcome.actionCode, communicationRule: outcome.communicationRule, emailTemplateKey: outcome.emailTemplateKey, varianceMin: outcome.chargedVarianceMinDelta, note: outcome.ruleNote });
            if (outcome.isAbsent) {
              markedAbsentCount++;
              otConvertedCount += convertOtOnce();
            } else if (outcome.correction) {
              // D16 fix: see the matching comment in the standard-branch call site.
              lateCoverCount++;
              lateCoverCountedRows.add(outcome.correction);
            }
          }
        });
        buildRlsOtAdjustmentOutcomes(
          evaluateRlsOtAdjustment(recompute.ot1Segments, recompute.ot2Segments, recompute.removalSegments, tier, config),
          pfNo, nomDateStr, config, otConvertedThisRow,
        ).forEach(outcome => {
          ruleFired += ` | ${outcome.ruleNote}`;
          firedActionCodes.push('ADJUST_OT_RLS');
          rowCorrections.push(outcome.originalCorrection, outcome.adjustedCorrection, ...outcome.extraOtRows, ...outcome.shiftInsertRows);
          otRlsAdjustedCount++;
        });
      }
    } else {
      // --- STANDARD / NON-FLEX ATTENDANCE RULES (§4.1) ---
      // Also reached by a flex-tagged employee whose ASPECT-scheduled start
      // falls outside the configured flex window — the §4.8 algorithm above
      // is skipped for them (isFlexScheduleWithinExpectedWindow gate), and
      // standard attendance rules apply instead so a normal shift measures
      // normally. The row is still held for a human to confirm the flex tag
      // or schedule, even when the standard evaluation below finds nothing
      // wrong — a flex tag on a non-flex-shaped schedule is itself the
      // anomaly, whatever verdict the numbers alone produce.
      if (isFlex) forcedHoldReason = 'FLEX_SCHEDULE_OUTSIDE_WINDOW';
      if (insufficientEvidence && insufficientCoverage) {
        // D4 fix: a lone punch (or none) near the edge of the CMS export's
        // actual coverage is a data-coverage gap, not proof of absence.
        verdict = 'INSUFFICIENT_CMS_COVERAGE';
        action = 'MANUAL_REVIEW_REQUIRED';
        resultCategory = 'COGNOS_DATA_GAP';
        disagreeReason = 'INSUFFICIENT_CMS_COVERAGE';
        ruleFired = `CMS export does not fully cover the required window around ${nomDateStr} — ${matchingPunches.length} punch(es) found, cannot confirm attendance`;
        forcedHoldReason = 'INSUFFICIENT_CMS_COVERAGE';
      } else if (!actualFirstLoginDt && !actualLastLogoutDt) {
        // R6 fix: same shared decision as the flex branch above.
        // F03 removal: see the identical comment in the flex path above.
        const noLoginRule = lookupRule('No Login Record', 0);
        const decision = resolveNoLoginDecision(noLoginRule, '');
        verdict = decision.verdict;
        action = decision.action;
        resultCategory = decision.resultCategory;
        disagreeReason = decision.disagreeReason;
        ruleFired = decision.ruleFired;
        firedCommunicationRule = decision.communicationRule;
        if (decision.holdReason) {
          forcedHoldReason = decision.holdReason;
        } else if (decision.markAbsent) {
          emailTemplateKey = 'no_login_ns_nc';
          pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: 0, note: ruleFired });
          rowCorrections.push({
            Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'Absent NS/NC', nominateDate: nomDateStr, SegmentDate: '',
            SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Full Shift Absence NS/NC',
          });
          markedAbsentCount++;
          otConvertedCount += convertOtOnce();
        } else if (decision.resultCategory === 'NO_ACTION_REQUIRED') {
          noActionCount++;
        }
      } else if (insufficientEvidence) {
        // Genuine single-punch / no-span case with SUFFICIENT coverage —
        // real Rule 6 (missing login or logout).
        verdict = 'ABSENT';
        action = 'ABSENT_SEGMENT';
        resultCategory = 'MARKED_ABSENT';
        disagreeReason = 'SINGLE_PUNCH_ONLY';
        ruleFired = 'Single punch only recorded without matching punch';
        firedCommunicationRule = lookupRule('No Login or No Logout', 0)?.communication || 'NA';
        emailTemplateKey = 'single_punch_absence';
        pushFiredAction({ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: 0, note: ruleFired });
        rowCorrections.push({
          Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
          SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Incomplete Punch Pair Absence',
        });
        markedAbsentCount++;
        otConvertedCount += convertOtOnce();
      } else {
        if (effectiveStartDt && actualFirstLoginDt!.getTime() > effectiveStartDt.getTime()) {
          lateMin = diffInMinutes(effectiveStartDt, actualFirstLoginDt!);
        }
        let earlyLoginMin = 0;
        if (effectiveStartDt && actualFirstLoginDt!.getTime() < effectiveStartDt.getTime()) {
          earlyLoginMin = diffInMinutes(actualFirstLoginDt!, effectiveStartDt);
        }
        if (effectiveEndDt && actualLastLogoutDt!.getTime() < effectiveEndDt.getTime()) {
          earlyMin = diffInMinutes(actualLastLogoutDt!, effectiveEndDt);
        }
        // D-B fix: measured from the EFFECTIVE (release/nursing/RLS-adjusted)
        // end, not the raw end — NURSNG/RLS/RLS-2H/RLS-3H/UN_RLS/Cover_RLS all
        // reduce the shift the same way Early Logout already accounts for
        // above; Late Logout must use the same real end, or a shift that
        // truly ended early (via a trailing reducer) lets staff log out well
        // past it without ever crossing the raw-end threshold.
        let lateLogoutMin = 0;
        if (effectiveEndDt && actualLastLogoutDt!.getTime() > effectiveEndDt.getTime()) {
          lateLogoutMin = diffInMinutes(effectiveEndDt, actualLastLogoutDt!);
        }

        const ruleFiredParts: string[] = [];
        const applyMoreSevere = (newCategory: TaaResultCategory, newAction: TaaActionCode, newVerdict: string, comm: CommunicationRule, templateKey: EmailTemplateKey) => {
          if (RESULT_CATEGORY_SEVERITY[newCategory] >= RESULT_CATEGORY_SEVERITY[resultCategory]) {
            resultCategory = newCategory; action = newAction; verdict = newVerdict; firedCommunicationRule = comm;
            emailTemplateKey = templateKey;
          }
        };

        if (lateMin > 0) {
          const lateRule = lookupRule('Late Login', lateMin);
          varianceMeasurements.push(traceMeasurement('LATE_LOGIN', 'effectiveStart (raw start plus any leading release)', effectiveStartDt, actualFirstLoginDt, lateMin, lateRule, referenceDay));
          // "Already actioned" rule: a LATE_AND_COVER finding whose LATE ASPECT already holds
          // takes no further action at all (see findAlreadyRecordedIncident). The ABSENT band
          // is never affected — only the LATE_AND_COVER outcome is.
          const recordedLate = lateRule && lateRule.action === 'LATE_AND_COVER'
            ? findAlreadyRecordedIncident(segmentsByEmp.get(pfNo) || [], nomDateStr, 'LATE', lateMin)
            : null;
          if (recordedLate) {
            if (verdict === 'PRESENT') verdict = 'LATE';
            ruleFiredParts.push(`${lateRule!.segmentType} (${tier}): ${lateMin}m -> ${recordedLate.note}`);
          } else if (lateRule && lateRule.action !== 'NO_ACTION') {
            chargedVarianceMin = lateMin;
            ruleFiredParts.push(`${lateRule.segmentType} (${tier}): ${lateMin}m -> ${lateRule.actionText}`);
            // WP5/B5/B15 — pushed only once the rule actually fires (never for a
            // below-band measurement), so a stray technical segment can never block a
            // hold that should never have needed one.
            if (effectiveStartDt && actualFirstLoginDt) firedVarianceIntervals.push({ label: 'LATE_LOGIN', start: effectiveStartDt, end: actualFirstLoginDt });
            if (lateRule.action === 'LATE_AND_COVER') {
              applyMoreSevere('LATE_AND_COVER_ADDED', 'LATE_AND_COVER', 'LATE', lateRule.communication, 'late_login_absence');
              pushFiredAction({ actionCode: 'LATE_AND_COVER', communicationRule: lateRule.communication, emailTemplateKey: 'late_login_absence', varianceMin: lateMin, note: ruleFiredParts[ruleFiredParts.length - 1] });
              rowCorrections.push({
                Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'LATE', nominateDate: nomDateStr, SegmentDate: effectiveStartDt ? formatSegmentDate(effectiveStartDt) : nomDateStr,
                SegmentStarttime: effectiveStartDt ? formatTimeHHMM(effectiveStartDt) : '08:00', Segmentduration: formatMinutesToHHMM(lateMin), Memo: `TAA Late Login ${lateMin}m`,
              });
              {
                const lateCover = tryPlaceSameDayCover(
                  pfNo, nomDateStr, lateMin, 'afterEnd',
                  { firstLoginDt: actualFirstLoginDt, lastLogoutDt: actualLastLogoutDt, effectiveStartDt, shiftEndDt: effectiveEndDt },
                  segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, presenceBlocks(closedMatchingPunches), reducedHoursCoverExcluded,
                ) ?? placeCoverSegment(pfNo, nomDateStr, lateMin, segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, processingDate, reducedHoursCoverExcluded);
                if (lateCover) {
                  rowCorrections.push(lateCover);
                  lateCoverCount++;
                  lateCoverCountedRows.add(lateCover);
                } else {
                  forcedHoldReason = describeCoverPlacementFailure(nomDateStr, segmentsByEmp.get(pfNo) || [], config, processingDate, reducedHoursCoverExcluded);
                }
              }
            } else if (lateRule.action === 'ABSENT_SEGMENT') {
              applyMoreSevere('MARKED_ABSENT', 'ABSENT_SEGMENT', 'ABSENT', lateRule.communication, 'late_login_absence');
              pushFiredAction({ actionCode: 'ABSENT_SEGMENT', communicationRule: lateRule.communication, emailTemplateKey: 'late_login_absence', varianceMin: lateMin, note: ruleFiredParts[ruleFiredParts.length - 1] });
              rowCorrections.push({
                Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
                SegmentStarttime: '', Segmentduration: '', Memo: `TAA Late Login ${lateMin}m Exceeds Threshold`,
              });
              markedAbsentCount++;
              otConvertedCount += convertOtOnce();
            } else {
              // The Config Registry dropdown is now restricted to what this branch
              // implements (see IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE / validateConfigForRun),
              // but an already-saved or imported config can still carry a stale,
              // unsupported action — hold rather than silently charge variance with zero
              // correction output, matching resolveNoLoginDecision's own fallback.
              forcedHoldReason = 'INVALID_CONFIG_VALUE';
            }
          }
        }

        if (earlyLoginMin > 0) {
          // Rule 2 in Rules to be taken.csv (Early Login -> No Action, both
          // tiers) previously had no code path at all — its "no action"
          // behavior was only an emergent side-effect of no other rule
          // firing, so an edit to this row in the Config Registry UI had no
          // observable effect anywhere, contradicting §6.4's "every rule is
          // editable through the UI" audit requirement. This lookup makes
          // the row genuinely reachable; the guard below keeps current
          // behavior identical (still No Action) unless someone
          // deliberately changes the config.
          const earlyLoginRule = lookupRule('Early Login', earlyLoginMin);
          varianceMeasurements.push(traceMeasurement('EARLY_LOGIN', 'effectiveStart (raw start plus any leading release)', effectiveStartDt, actualFirstLoginDt, earlyLoginMin, earlyLoginRule, referenceDay));
          if (earlyLoginRule && earlyLoginRule.action !== 'NO_ACTION') {
            ruleFiredParts.push(`${earlyLoginRule.segmentType} (${tier}): ${earlyLoginMin}m -> ${earlyLoginRule.actionText}`);
          }
        }

        if (earlyMin > 0) {
          const earlyRule = lookupRule('Early Logout', earlyMin);
          varianceMeasurements.push(traceMeasurement('EARLY_LOGOUT', 'effectiveEnd (raw end minus trailing release/nursing)', effectiveEndDt, actualLastLogoutDt, earlyMin, earlyRule, referenceDay));
          // "Already actioned" rule — mirror of the Late Login branch above.
          const recordedEarly = earlyRule && earlyRule.action === 'LOGOFF_AND_COVER'
            ? findAlreadyRecordedIncident(segmentsByEmp.get(pfNo) || [], nomDateStr, 'Log_off', earlyMin)
            : null;
          if (recordedEarly) {
            if (verdict === 'PRESENT') verdict = 'EARLY_LOGOUT';
            ruleFiredParts.push(`${earlyRule!.segmentType} (${tier}): ${earlyMin}m -> ${recordedEarly.note}`);
          } else if (earlyRule && earlyRule.action !== 'NO_ACTION') {
            // D-A fix: ADD this rule's minutes to whatever Late Login already
            // charged, instead of keeping only whichever fired first — a row
            // with both a late login AND an early logout must report the
            // FULL combined variance, not silently drop one of the two.
            chargedVarianceMin += earlyMin;
            ruleFiredParts.push(`${earlyRule.segmentType} (${tier}): ${earlyMin}m -> ${earlyRule.actionText}`);
            // WP5/B5/B15
            if (actualLastLogoutDt && effectiveEndDt) firedVarianceIntervals.push({ label: 'EARLY_LOGOUT', start: actualLastLogoutDt, end: effectiveEndDt });
            if (earlyRule.action === 'LOGOFF_AND_COVER') {
              applyMoreSevere('LATE_AND_COVER_ADDED', 'LOGOFF_AND_COVER', 'EARLY_LOGOUT', earlyRule.communication, 'early_logout_absence');
              pushFiredAction({ actionCode: 'LOGOFF_AND_COVER', communicationRule: earlyRule.communication, emailTemplateKey: 'early_logout_absence', varianceMin: earlyMin, note: ruleFiredParts[ruleFiredParts.length - 1] });
              rowCorrections.push({
                Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'Log_off', nominateDate: nomDateStr, SegmentDate: actualLastLogoutDt ? formatSegmentDate(actualLastLogoutDt) : nomDateStr,
                SegmentStarttime: actualLastLogoutDt ? formatTimeHHMM(actualLastLogoutDt) : '15:00', Segmentduration: formatMinutesToHHMM(earlyMin), Memo: `TAA Early Logout ${earlyMin}m`,
              });
              {
                const earlyCover = tryPlaceSameDayCover(
                  pfNo, nomDateStr, earlyMin, 'beforeStart',
                  { firstLoginDt: actualFirstLoginDt, lastLogoutDt: actualLastLogoutDt, effectiveStartDt, shiftEndDt: effectiveEndDt },
                  segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, presenceBlocks(closedMatchingPunches), reducedHoursCoverExcluded,
                ) ?? placeCoverSegment(pfNo, nomDateStr, earlyMin, segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, processingDate, reducedHoursCoverExcluded);
                if (earlyCover) {
                  rowCorrections.push(earlyCover);
                  lateCoverCount++;
                  lateCoverCountedRows.add(earlyCover);
                } else {
                  forcedHoldReason = describeCoverPlacementFailure(nomDateStr, segmentsByEmp.get(pfNo) || [], config, processingDate, reducedHoursCoverExcluded);
                }
              }
            } else if (earlyRule.action === 'ABSENT_SEGMENT') {
              applyMoreSevere('MARKED_ABSENT', 'ABSENT_SEGMENT', 'ABSENT', earlyRule.communication, 'early_logout_absence');
              pushFiredAction({ actionCode: 'ABSENT_SEGMENT', communicationRule: earlyRule.communication, emailTemplateKey: 'early_logout_absence', varianceMin: earlyMin, note: ruleFiredParts[ruleFiredParts.length - 1] });
              rowCorrections.push({
                Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
                SegmentStarttime: '', Segmentduration: '', Memo: `TAA Early Logout ${earlyMin}m Exceeds Threshold`,
              });
              markedAbsentCount++;
              otConvertedCount += convertOtOnce();
            } else {
              // Same defensive fallback as the Late Login branch above.
              forcedHoldReason = 'INVALID_CONFIG_VALUE';
            }
          }
        } else if (lateLogoutMin > 0) {
          // WP1 (D1/D2): `lateLogoutMin` above is the GROSS time past the effective end. Time the
          // agent spent working a COVER (one placed this run for this incident, or one already in
          // ASPECT) and is proven to have attended is make-up time, not chargeable extra time, so it
          // is credited BEFORE the configured band is applied — the same minutes may never count both
          // as earned COVER and as late logout. Only the remainder meets the band; the band itself is
          // untouched. Runs here, after any same-day cover has been placed above.
          const lateLogoutCreditedMin = actualLastLogoutDt && effectiveEndDt
            ? creditedCoverMinutes(
                [...coverIntervalsFromSegments(recompute.coverSegments), ...coverIntervalsFromCorrections(rowCorrections)],
                effectiveEndDt, actualLastLogoutDt, presenceBlocks(closedMatchingPunches))
            : 0;
          const lateLogoutChargeMin = Math.max(0, lateLogoutMin - lateLogoutCreditedMin);
          gateLateLogoutChargeMin = lateLogoutChargeMin; // Phase 4 gate capture (see declaration above)
          gateLateLogoutCreditMin = lateLogoutCreditedMin;
          const lateLogoutCreditNote = lateLogoutCreditedMin > 0
            ? `${lateLogoutMin}m gross - ${lateLogoutCreditedMin}m attended cover credited = ${lateLogoutChargeMin}m remaining`
            : '';
          const lateLogoutRule = lateLogoutChargeMin > 0 ? lookupRule('Late Logout', lateLogoutChargeMin) : undefined;
          varianceMeasurements.push(traceMeasurement('LATE_LOGOUT', `effectiveEnd (raw end minus trailing release/nursing) — NOT the rostered end${lateLogoutCreditNote ? ` | ${lateLogoutCreditNote}` : ''}`, effectiveEndDt, actualLastLogoutDt, lateLogoutChargeMin, lateLogoutRule, referenceDay));
          if (lateLogoutRule && lateLogoutRule.action !== 'NO_ACTION') {
            chargedVarianceMin += lateLogoutChargeMin;
            // WP5/B5/B15 — the GROSS window, not the credited-cover remainder (which has
            // no interval of its own). Using the gross span is the stricter test: a
            // technical segment must cover the whole gap, not just the uncredited part.
            if (effectiveEndDt && actualLastLogoutDt) firedVarianceIntervals.push({ label: 'LATE_LOGOUT', start: effectiveEndDt, end: actualLastLogoutDt });
            // State the anchor explicitly. Late Logout is measured from the RELEASE-ADJUSTED
            // end, so an agent released at 14:00 on a shift rostered to 15:00 is already 60
            // minutes "late" the moment they work their rostered end — the threshold for an
            // ABSENT. A reviewer must see which end the number was measured from before
            // approving an unpaid day, not have to infer it.
            ruleFiredParts.push(`Late Logout (${tier}): ${lateLogoutChargeMin}m past the release-adjusted end ${effectiveEndDt ? formatTimeHHMM(effectiveEndDt) : '—'} (rostered end ${rawEndDt ? formatTimeHHMM(rawEndDt) : '—'})${lateLogoutCreditNote ? ` [${lateLogoutCreditNote}]` : ''} -> ${lateLogoutRule.actionText}`);
            applyMoreSevere('MARKED_ABSENT', 'ABSENT_SEGMENT', 'ABSENT', lateLogoutRule.communication, 'late_logout_absence');
            pushFiredAction({ actionCode: 'ABSENT_SEGMENT', communicationRule: lateLogoutRule.communication, emailTemplateKey: 'late_logout_absence', varianceMin: lateLogoutChargeMin, note: ruleFiredParts[ruleFiredParts.length - 1] });
            rowCorrections.push({
              Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
              SegmentStarttime: '', Segmentduration: '', Memo: `TAA Late Logout ${lateLogoutChargeMin}m past release-adjusted end${lateLogoutCreditNote ? ` (${lateLogoutCreditNote})` : ''}`,
            });
            markedAbsentCount++;
            otConvertedCount += convertOtOnce();
          }
        }

        // Rule 7 — Cover Not Attended: any COVER segment already present in
        // this day's ASPECT data (a previously-placed cover that round-tripped
        // back per §4.12) is checked against the day's overall attended span.
        const coverNotAttendedFindings = evaluateCoverNotAttended(recompute.coverSegments, actualFirstLoginDt, actualLastLogoutDt, tier, config);
        gateCoverShortfallMin += coverNotAttendedFindings.reduce((acc, f) => acc + f.shortfallMinutes, 0); // Phase 4 gate capture (see declaration above)
        buildCoverNotAttendedOutcomes(
          coverNotAttendedFindings,
          { tier, tierLabel: '', referenceDay, pfNo, nomDateStr, config, segmentsByEmp, placedCoversThisRun, processingDate, reducedHoursCoverExcluded },
        ).forEach(outcome => {
          varianceMeasurements.push(outcome.varianceMeasurement);
          chargedVarianceMin += outcome.chargedVarianceMinDelta;
          ruleFiredParts.push(outcome.ruleNote);
          if (outcome.correction) rowCorrections.push(outcome.correction);
          if (outcome.holdReason) {
            forcedHoldReason = outcome.holdReason;
          } else {
            firedVarianceIntervals.push(...outcome.varianceIntervals); // WP5/B5/B15
            applyMoreSevere(outcome.resultCategory, outcome.actionCode, outcome.isAbsent ? 'ABSENT' : verdict, outcome.communicationRule, outcome.emailTemplateKey);
            pushFiredAction({ actionCode: outcome.actionCode, communicationRule: outcome.communicationRule, emailTemplateKey: outcome.emailTemplateKey, varianceMin: outcome.chargedVarianceMinDelta, note: outcome.ruleNote });
            if (outcome.isAbsent) {
              markedAbsentCount++;
              otConvertedCount += convertOtOnce();
            } else if (outcome.correction) {
              // D16 fix: this is the "moveCoverForward" branch of Rule 7 (Cover
              // Not Attended) — it places a real cover but, before this fix,
              // never counted it, so the Late & Cover card (23) undercounted
              // its own tab (61, via rowHasLateCoverCorrection) by exactly the
              // rows that took this path. Mirror the release side: releaseCover
              // already checks lateCoverCountedRows before decrementing, so an
              // uncounted cover here was safe from double-decrement but simply
              // invisible to the card the whole time.
              lateCoverCount++;
              lateCoverCountedRows.add(outcome.correction);
            }
          }
        });

        // Rule 8 — RLS segment added to OT with no adjustment: an OT segment
        // whose window overlaps a REMOVAL (release) segment either has its
        // duration shrunk (partial overlap — a separate SHIFT insert covers
        // the released time) or is fully re-typed to SHIFT (full overlap —
        // never a bare zero-duration row). See buildRlsOtAdjustmentOutcomes.
        buildRlsOtAdjustmentOutcomes(
          evaluateRlsOtAdjustment(recompute.ot1Segments, recompute.ot2Segments, recompute.removalSegments, tier, config),
          pfNo, nomDateStr, config, otConvertedThisRow,
        ).forEach(outcome => {
          ruleFiredParts.push(outcome.ruleNote);
          firedActionCodes.push('ADJUST_OT_RLS');
          rowCorrections.push(outcome.originalCorrection, outcome.adjustedCorrection, ...outcome.extraOtRows, ...outcome.shiftInsertRows);
          otRlsAdjustedCount++;
        });

        if (ruleFiredParts.length === 0) {
          verdict = 'PRESENT';
          action = 'NO_ACTION';
          resultCategory = 'NO_ACTION_REQUIRED';
          ruleFired = 'Attendance within acceptable thresholds';
          noActionCount++;
        } else {
          ruleFired = ruleFiredParts.join(' AND ');
        }
      }
    }

    // D2 fix: Absent excludes leftover timed penalties. Late Login and Early
    // Logout (both flex branches and the standard branch above) are independent
    // findings, not mutually exclusive — a day that trips both an ABSENT-triggering
    // Late Login AND a Late+Cover-triggering Early Logout (or vice versa, or Rule 7
    // Cover Not Attended) pushes both sets of corrections. applyMoreSevere* only
    // updates the REPORTED verdict/action; it never retracts an already-pushed row,
    // and dedupeAspectCorrections only collapses duplicate ABSENT markers. Once the
    // day's FINAL resultCategory is known (all rules above have already fired), an
    // ABSENT day must never also carry LATE, Log_off, or COVER — that is a payroll
    // double-hit (docked a full day AND charged a cover). OT->SHIFT conversion is
    // untouched (convertOtOnce already guards it); firedActionCodes is untouched so
    // TAA_ACTIONS_FIRED still shows every rule that genuinely fired, for audit.
    if (resultCategory === 'MARKED_ABSENT' && !config.retainLateCoverOnAbsent) {
      const STRIPPED_ON_ABSENT = new Set(['LATE', 'Log_off', 'COVER']);
      for (let i = rowCorrections.length - 1; i >= 0; i--) {
        const c = rowCorrections[i];
        if (!STRIPPED_ON_ABSENT.has(c.SegmentCode)) continue;
        if (c.SegmentCode === 'COVER') {
          // Release the reservation this COVER claimed in placedCoversThisRun —
          // otherwise the NEXT cover placed for this employee/target-day would
          // start later than it should, a new pay error in a different row.
          lateCoverCount -= releaseCover(c, placedCoversThisRun);
        }
        rowCorrections.splice(i, 1);
      }
    }

    // WP1 (D8): ONE physical day-level absence marker per employee-day, built here — at row level —
    // so the on-screen recommendation, the summary counter, the annotated export, the workbook and the
    // ASPECT CSV all describe the SAME decision. Independent rules (late login, early logout, late
    // logout, cover not attended) each push their own absence row; until now only the CSV serializer
    // collapsed them, silently keeping the first memo and losing every other reason (real case: PF
    // 90142567 was charged "Late Login 119m" and the "Late Logout 120m" reason vanished).
    // Only markers of the SAME segment type are merged. ABSENT and Absent NS/NC on one day would be a
    // genuine conflict the business has not ruled on, so they are deliberately left untouched here
    // rather than choosing a precedence. Every trigger is also kept in firedActionDetails/ruleFired.
    for (const markerCode of ['ABSENT', 'Absent NS/NC']) {
      const idxs = rowCorrections.map((c, i) => (c.SegmentCode === markerCode ? i : -1)).filter(i => i >= 0);
      if (idxs.length < 2) continue;
      const parts: string[] = [];
      idxs.forEach(i => {
        const part = (rowCorrections[i].Memo || '').replace(/^TAA\s+/i, '').replace(/\s+Exceeds Threshold$/i, '').trim();
        if (part && !parts.includes(part)) parts.push(part);
      });
      rowCorrections[idxs[0]] = { ...rowCorrections[idxs[0]], Memo: `TAA Absent - ${parts.join('; ')}` };
      for (let k = idxs.length - 1; k >= 1; k--) rowCorrections.splice(idxs[k], 1);
      // The counter is incremented once per firing rule; the day now carries one physical marker.
      markedAbsentCount -= idxs.length - 1;
    }

    // ---- Pass 3: recompute-then-compare against the original Cognos columns.
    // Leave identification (§Leave Segments) is independent of the full-day gate above:
    // config.leaveSegmentCodes drives which segments are "leave" for reporting/matching/
    // hours, config.nonWorkingDaySegmentCodes (a superset, also including non-leave codes
    // such as OFF) drives isLeaveDay. Both route through the same isCodeInConfiguredSet
    // helper as scheduleRecompute.ts, so a newly configured code (e.g. HOSPTLZD) can never
    // trigger one without the other.
    const leaveSegmentsForDay = empSegs.filter(s => isCodeInConfiguredSet(s.SEG_CODE, config.leaveSegmentCodes || []));
    const identifiedLeaveCodes = leaveSegmentsForDay.map(s => s.SEG_CODE);
    const nonWorkingCodes = recompute.nonWorkingSegments.map(s => s.SEG_CODE);
    // §4.6f: when the day already carries an ASPECT absence marker, that marker's own
    // SEG_CODE is what TAA reports for LEAVE TYPE. Without this, the gate's verdicts fall
    // through to '' and resolveLeaveTypeMatch's VERDICT fallback (cognosComparison.ts case
    // 5) cannot fire — Cognos's "ABSENT" would be compared against a blank and reported as
    // a MISMATCH, which then raises a MISMATCH_FOUND hold and drops the row into the review
    // queue. That is a fabricated disagreement: both sides agree the day is an absence, and
    // ASPECT literally carries the segment saying so. A genuine disagreement (Cognos naming
    // some OTHER leave type against an absence-marked day) still reports MISMATCH, because
    // the Cognos side then fails the same verdict-value test.
    const attendanceVerdictLabel = existingAbsenceMarkerSegment
      && (verdict === 'ABSENCE_ALREADY_RECORDED' || verdict === 'ABSENCE_CONTRADICTED_BY_CMS')
      ? (existingAbsenceMarkerSegment.SEG_CODE || '').trim()
      : verdict === 'NO_SHOW' ? 'Absent NS/NC' : verdict === 'ABSENT' ? 'ABSENT' : '';

    // LEAVE HR (§Non-negotiables, user-confirmed): only real ASPECT-recorded evidence is
    // comparable pay — an explicit DURATION (including a deliberate 0), otherwise a valid
    // START_MOMENT/STOP_MOMENT span. Never defaulted to a full day: the real Cognos sample
    // (samples_Files/Cognos_DescrepencyReport.csv) shows ANNUAL at both 480 minutes (109
    // rows) and 540 (1 row), and OFF at 30/50 minutes — no single default is safe, and OFF
    // is never in leaveSegmentCodes anyway. A leave segment with no real duration evidence
    // contributes nothing; if none of the day's leave segments have evidence, the day is
    // NOT_COMPARABLE rather than a guessed full day.
    const leaveDurationEvidence = (s: AspectSegment): number | null => {
      if (s.DURATION != null) return s.DURATION;
      if (s.START_MOMENT && s.STOP_MOMENT) {
        const start = parseDateTimeString(s.START_MOMENT);
        const stop = parseDateTimeString(s.STOP_MOMENT);
        if (start && stop && stop.getTime() >= start.getTime()) {
          return Math.round((truncateToMinute(stop).getTime() - truncateToMinute(start).getTime()) / 60000);
        }
      }
      return null;
    };
    const leaveDurationValues = leaveSegmentsForDay.map(leaveDurationEvidence).filter((m): m is number => m !== null);
    const leaveMinutes: number | null = leaveDurationValues.length === 0
      ? null
      : leaveDurationValues.reduce((acc, m) => acc + m, 0);

    // Same-basis logout evaluator (2026-09-27) — see ComparisonContext.logoutPolicy. Mirrors the
    // engine's own Early/Late Logout decision for any candidate logout instant: early logout is
    // measured to the early anchor, late logout from the release/nursing-adjusted end minus the
    // attended-COVER credit. A candidate BEFORE TAA's real logout may have attended less of the
    // COVER, so both the full credit and the credit reduced by that gap are tried; the outcome
    // is proved only when every reachable credit gives the same rule.
    const logoutOutcomeKey = (r?: PolicyRuleItem): string => (r && r.action !== 'NO_ACTION') ? r.id : 'none';
    const logoutMeasurement = [...varianceMeasurements].reverse().find(m => m.label === 'EARLY_LOGOUT' || m.label === 'LATE_LOGOUT');
    const taaLogoutOutcome = logoutMeasurement && logoutMeasurement.bandId && logoutMeasurement.bandAction && logoutMeasurement.bandAction !== 'NO_ACTION'
      ? logoutMeasurement.bandId : 'none';
    const policyEndDt = effectiveEndDt;
    const earlyAnchorForGate = gateEarlyAnchorDt ?? effectiveEndDt;
    // The last-logout time also decides Rule 7 (Cover Not Attended) for every ASPECT COVER on
    // the day — a disputed logout can turn an attended COVER into an unattended one (ABSENT).
    // Same function the engine itself runs, so it needs no separate self-check.
    const coverOutcomeAt = (logout: Date): string => evaluateCoverNotAttended(recompute.coverSegments, actualFirstLoginDt, logout, tier, config)
      .map(f => f.rule.id).sort().join(',');
    // Plausible ends Cognos may have measured LEFT EARLY from: the raw end, then the end of each
    // COVER chained contiguously onto it (touching or overlapping the running end).
    const cognosEndCandidates: Date[] = rawEndDt ? [rawEndDt] : [];
    if (rawEndDt) {
      let chainEnd = rawEndDt;
      const chainCovers = recompute.coverSegments
        .map(seg => ({ st: seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null, sp: seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null }))
        .filter((c): c is { st: Date; sp: Date } => !!c.st && !!c.sp)
        .sort((x, y) => x.st.getTime() - y.st.getTime());
      for (const c of chainCovers) {
        if (c.st.getTime() <= chainEnd.getTime() && c.sp.getTime() > chainEnd.getTime()) {
          chainEnd = c.sp;
          cognosEndCandidates.push(chainEnd);
        }
      }
    }
    const logoutPolicy = policyEndDt && earlyAnchorForGate ? {
      cognosEndCandidates,
      taaOutcome: `${taaLogoutOutcome}|${actualLastLogoutDt ? coverOutcomeAt(actualLastLogoutDt) : ''}`,
      outcomesAt: (logout: Date): Set<string> => {
        const logoutKeys = new Set<string>();
        if (logout.getTime() < earlyAnchorForGate.getTime()) {
          logoutKeys.add(logoutOutcomeKey(lookupRule('Early Logout', diffInMinutes(logout, earlyAnchorForGate))));
        } else if (logout.getTime() <= policyEndDt.getTime()) {
          logoutKeys.add('none');
        } else {
          const gross = diffInMinutes(policyEndDt, logout);
          const shortBy = actualLastLogoutDt && logout.getTime() < actualLastLogoutDt.getTime()
            ? Math.ceil((actualLastLogoutDt.getTime() - logout.getTime()) / 60000) : 0;
          for (const credit of [gateLateLogoutCreditMin, Math.max(0, gateLateLogoutCreditMin - shortBy)]) {
            const charge = Math.max(0, gross - credit);
            logoutKeys.add(charge > 0 ? logoutOutcomeKey(lookupRule('Late Logout', charge)) : 'none');
          }
        }
        const cover = coverOutcomeAt(logout);
        return new Set([...logoutKeys].map(k => `${k}|${cover}`));
      },
    } : undefined;

    const comparisonCtx: ComparisonContext = {
      rawStart: rawStartDt,
      rawEnd: rawEndDt,
      duty1Block: recompute.duty1Block,
      duty2Block: recompute.duty2Block,
      netScheduledMinutes: recompute.netScheduledMinutes,
      removalMinutes: recompute.releaseMinutes + recompute.nursingMinutes + recompute.otInternalRemovalMinutes,
      lateSegmentMinutes: empSegs
        .filter(x => (x.SEG_CODE || '').trim().toUpperCase() === 'LATE')
        .reduce((acc, x) => acc + (x.DURATION ?? 0), 0),
      coverMinutes: empSegs
        .filter(x => (x.SEG_CODE || '').trim().toUpperCase() === 'COVER')
        .reduce((acc, x) => acc + (x.DURATION ?? 0), 0),
      ot1Minutes: recompute.ot1Minutes,
      ot2Minutes: recompute.ot2Minutes,
      ot1Block: recompute.ot1Block,
      ot2Block: recompute.ot2Block,
      actualFirstLogin: actualFirstLoginDt,
      actualLastLogout: actualLastLogoutDt,
      staffedMinutes,
      hasAnyCmsData,
      identifiedLeaveCodes,
      nonWorkingCodes,
      fullDayRemovalCodes: recompute.fullDayRemovalSegments.map(s => s.SEG_CODE),
      attendanceVerdictLabel,
      leaveMinutes,
      isLeaveDay,
      // Only when the flex algorithm actually evaluated this row (tagged AND inside the
      // expected start window) — an out-of-window flex row runs standard rules and is held.
      isFlex: isFlex && !isFlexOutOfWindow,
      logoutPolicy,
    };
    const comparisonResult = compareCognosRow(cognos, comparisonCtx, config);
    if (comparisonResult.mismatchColumns.length > 0) {
      mismatchCount++;
      disagreementsResolvedCount++;
    }
    let cognosAgree = comparisonResult.cognosAgree;
    // Set true only by the legacy DEFECT_1_RELEASE_IGNORED branch below, which forces
    // cognosAgree to false independent of comparisonResult.mismatchColumns — see the
    // TAA_COGNOS_AGREE hold check further down.
    let cognosAgreeForcedFalseWithNoMismatch = false;
    // Set only in the DEFECT_1_RELEASE_IGNORED branch below when Cognos's claimed early-leave
    // minutes are fully explained by the trailing release/nursing deduction Cognos ignored
    // (within config.comparisonToleranceMinutes) — i.e. arithmetic proves TAA is correct, so
    // the row is not held for this reason alone (reporting/verdict/action untouched).
    let defect1AutoExempt = false;

    // Legacy disagreement diagnosis (kept for TAA_DISAGREE_REASON's existing
    // vocabulary) — now driven by the recomputed cognos-style comparison
    // rather than a standalone heuristic.
    const leftEarlyRaw = (cognos['LEFT EARLY'] || '').trim();
    const leftEarlyVal = /^-?\d+$/.test(leftEarlyRaw) ? Number(leftEarlyRaw) : null;
    const cognosClaimsRealEarly = leftEarlyVal !== null && leftEarlyVal < 0 && !isCognosSentinel(leftEarlyVal, cognos, config);
    if (
      disagreeReason === 'MATCH'
      && (recompute.releaseMinutes > 0 || recompute.nursingMinutes > 0)
      && earlyMin === 0
      && cognosClaimsRealEarly
    ) {
      // Keep the raw-window LEFT EARLY column compare (like-for-like with Cognos)
      // but do not report MATCH when the verdict used the effective end (Defect 1).
      disagreeReason = 'DEFECT_1_RELEASE_IGNORED';
      cognosAgree = false;
      cognosAgreeForcedFalseWithNoMismatch = true;
      // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this exemption
      // never fires and the row stays held as before Phase 2.
      // Same-basis fix (2026-09-27): the Cognos figure must ALSO reach TAA's own logout outcome
      // on TAA's basis — a -1 vs 0 raw pair (MATCH within tolerance) with a 60m trailing RLS is
      // 59m vs 60m past the release-adjusted end: no action vs ABSENT, never provably safe.
      defect1AutoExempt = config.releaseProvenSafeHolds
        && leftEarlyVal !== null
        && Math.abs(leftEarlyVal) <= recompute.trailingReleaseMinutes + recompute.nursingMinutes + config.comparisonToleranceMinutes
        && logoutOutcomeMatchesTaa(comparisonCtx, leftEarlyVal, config.comparisonToleranceMinutes ?? 1, cognos['SIGIN OUT']);
    } else if (cognos['LEAVE TYPE'] === 'U-ABSENT' && (verdict === 'PRESENT' || verdict === 'LATE')) {
      disagreeReason = 'DEFECT_2_NIGHT_SHIFT_PUNCH_LOST';
    } else if (isLeaveDay && (cognos['LEAVE TYPE'] === 'U-ABSENT' || parseInt(cognos['LATE START'] || '0', 10) === -480) && verdict === 'LEAVE_EXCLUDED') {
      disagreeReason = 'COGNOS_FALSE_ABSENCE';
    }
    // Reduced office hours (Flex, one configured weekday): a visible, non-blocking
    // marker, never a hold — do NOT set cognosAgree/cognosAgreeForcedFalseWithNoMismatch,
    // which would turn this into a MISMATCH_FOUND hold (the user asked for a flag only).
    // Only when still 'MATCH' so it never hides a DEFECT_1/DEFECT_2 diagnosis above.
    if (reducedOfficeHoursApplied && disagreeReason === 'MATCH') {
      disagreeReason = 'REDUCED_OFFICE_HOURS_POLICY';
    }
    // Release grid (business rule 2026-09-27): releases are booked on a fixed grid (default
    // 30 minutes: :00/:30). An off-grid release is a visible, NON-blocking flag — never a hold
    // and never rounded; the day was calculated with the release exactly as recorded.
    const releaseGrid = config.releaseGridMinutes ?? 0;
    let releaseGridNote = '';
    if (releaseGrid > 0) {
      const offGrid = empSegs.filter(seg => {
        if (!isCodeInConfiguredSet(seg.SEG_CODE, config.releaseGridCodes || [])) return false;
        const st = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
        const sp = seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null;
        const off = (d: Date | null) => !!d && ((d.getHours() * 60 + d.getMinutes()) % releaseGrid !== 0 || d.getSeconds() !== 0);
        return off(st) || off(sp);
      });
      if (offGrid.length > 0) {
        const describe = (seg: AspectSegment) => {
          const st = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
          const sp = seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null;
          return `${seg.SEG_CODE} ${st ? formatTimeHHMM(st) : '--:--'}-${sp ? formatTimeHHMM(sp) : '--:--'}`;
        };
        releaseGridNote = `Release not on the ${releaseGrid}-minute grid: ${offGrid.map(describe).join(', ')} — calculated exactly as recorded; check the booking in ASPECT.`;
        ruleFired += ` | ${releaseGridNote}`;
        if (disagreeReason === 'MATCH') disagreeReason = 'RELEASE_OFF_GRID';
      }
    }

    // --- Phase 4: "worst-case Cognos" gate (2026-09-24, plan worst-case-cognos-gate.md).
    // A MISMATCH column is "action-neutral" when plugging Cognos's OWN figure into the
    // live policy bands (lookupRule/lookupPolicyRule — never a hardcoded band number)
    // would drive the exact same action TAA's own figure already drove: even in the
    // worst case (Cognos is right and TAA is wrong), nothing downstream would change.
    // This NEVER changes verdict/action/corrections/TAA_COGNOS_AGREE and NEVER changes a
    // column's MATCH/MISMATCH status — it only lets the generic MISMATCH_FOUND hold below
    // skip when EVERY mismatch column on the row clears this bar. A note is appended to
    // the column's trace explaining why, so the column still reads MISMATCH honestly.
    const actionOrNoAction = (r?: PolicyRuleItem): TaaActionCode => (r && r.action !== 'NO_ACTION') ? r.action : 'NO_ACTION';
    const sameActionOutcome = (a?: PolicyRuleItem, b?: PolicyRuleItem): boolean => actionOrNoAction(a) === actionOrNoAction(b);
    const parseSignedMinutes = (s: string): number | null => {
      const trimmed = (s || '').trim();
      return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
    };
    const actionNeutralColumns = new Map<string, TaaActionCode>();

    // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, Gates A and B below
    // never populate actionNeutralColumns, so mismatchColumnsAllActionNeutral stays false and
    // every MISMATCH column holds the row exactly as it did before Phase 4.
    if (config.releaseProvenSafeHolds) {
    // Gate A — LEFT EARLY / LATE START. Flex staff run a different lateness algorithm
    // (cutoff clamp, flexBypassesMinuteBands) — TAA's own action there isn't a plain
    // lookupPolicyRule(minutes) outcome, so this gate never fires for a flex row (stays
    // MISMATCH, held as before).
    if (!isFlex && comparisonResult.mismatchColumns.includes('LEFT EARLY') && leftEarlyVal !== null && leftEarlyVal < 0) {
      // Same-basis fix (2026-09-27): Cognos's figure is re-evaluated through TAA's own anchors,
      // release/nursing adjustment, COVER credit, tier and BOTH Early and Late Logout rules
      // (logoutOutcomeMatchesTaa) — the old test clamped it to an early-logout minute count and
      // so called Cognos -1 vs TAA +1 with a 60m trailing RLS "NO_ACTION" while TAA exported an
      // ABSENT for 61m late logout (59m on Cognos's figure: no action).
      if (logoutOutcomeMatchesTaa(comparisonCtx, leftEarlyVal, config.comparisonToleranceMinutes ?? 1, cognos['SIGIN OUT'])) {
        actionNeutralColumns.set('LEFT EARLY', (logoutMeasurement?.bandAction && logoutMeasurement.bandAction !== 'NO_ACTION') ? logoutMeasurement.bandAction as TaaActionCode : 'NO_ACTION');
      }
    }
    if (!isFlex && comparisonResult.mismatchColumns.includes('LATE START')) {
      const lateStartVal = parseSignedMinutes(cognos['LATE START'] || '');
      if (lateStartVal !== null && lateStartVal < 0) {
        const cognosRule = lookupRule('Late Login', -lateStartVal);
        const taaRule = lookupRule('Late Login', lateMin);
        if (sameActionOutcome(cognosRule, taaRule)) actionNeutralColumns.set('LATE START', actionOrNoAction(taaRule));
      }
    }

    // Gate B — SCH DURATION cover gap: Cognos is missing part of the day's COVER (ASPECT
    // has more, i.e. the gap is bounded by comparisonCtx.coverMinutes), but not enough to
    // move either the Late Logout or the Cover Not Attended outcome across a band.
    if (comparisonResult.mismatchColumns.includes('SCH DURATION')) {
      const cognosSch = parseCognosHMinutes(cognos['SCH DURATION'] || '');
      if (cognosSch !== null) {
        const gap = recompute.netScheduledMinutes - cognosSch; // + => TAA's SCH is higher (ASPECT has more COVER)
        // Excluded (plan): a gap this size is EQUALLY explained by the day's LATE make-up
        // minutes (cognosComparison.ts's own note priority picks that explanation first,
        // ahead of the COVER one, whenever both math tests pass) — a genuine late-make-up
        // disagreement, not proven Cognos-missing-cover, so it stays held.
        const tol = config.comparisonToleranceMinutes ?? 1;
        // Exception (2026-09-27): when the gap is the day's ENTIRE COVER (±tol), both readings
        // name the same minutes — the make-up COVER ASPECT records for the LATE is exactly what
        // Cognos's SCH DURATION leaves out — so it is proven Cognos-missing-cover, not ambiguous.
        // The band-neutrality test below still has to pass before anything is released.
        // Real case: PF 4500508 23/09, LATE 10:00-10:40 + COVER 18:00-18:40, Cognos 8:00, TAA 8:40.
        const gapIsWholeCover = comparisonCtx.coverMinutes > 0 && Math.abs(gap - comparisonCtx.coverMinutes) <= tol;
        const explainedByLateMakeUp = gap !== 0 && comparisonCtx.lateSegmentMinutes > 0 && Math.abs(gap) <= comparisonCtx.lateSegmentMinutes + tol && !gapIsWholeCover;
        if (gap > 0 && gap <= comparisonCtx.coverMinutes + (gapIsWholeCover ? tol : 0) && !explainedByLateMakeUp) {
          const lateLogoutRuleBase = lookupRule('Late Logout', gateLateLogoutChargeMin);
          const lateLogoutRuleGap = lookupRule('Late Logout', gateLateLogoutChargeMin + gap);
          const coverRuleBase = gateCoverShortfallMin > 0 ? lookupRule('Cover Not Attended', gateCoverShortfallMin) : undefined;
          const coverRuleGap = gateCoverShortfallMin > 0 ? lookupRule('Cover Not Attended', Math.max(0, gateCoverShortfallMin - gap)) : undefined;
          const lateLogoutNeutral = sameActionOutcome(lateLogoutRuleBase, lateLogoutRuleGap);
          const coverNeutral = gateCoverShortfallMin <= 0 || sameActionOutcome(coverRuleBase, coverRuleGap);
          // Label with the outcome the gap could actually have moved: the cover rule when a COVER
          // shortfall exists (the old label always named the Late Logout action — "NO_ACTION"
          // on a row that exports a Cover-Not-Attended ABSENT).
          if (lateLogoutNeutral && coverNeutral) actionNeutralColumns.set('SCH DURATION', gateCoverShortfallMin > 0 ? actionOrNoAction(coverRuleBase) : actionOrNoAction(lateLogoutRuleBase));
        }
      }
    }
    } // end releaseProvenSafeHolds gate (Gates A/B)
    if (actionNeutralColumns.size > 0) {
      comparisonResult.comparisons = comparisonResult.comparisons.map(c => {
        const neutralAction = actionNeutralColumns.get(c.column);
        if (neutralAction === undefined) return c;
        const note = `Action-neutral: using Cognos's figure gives the same action (${neutralAction})`;
        return { ...c, note: c.note ? `${c.note} ${note}` : note };
      });
    }
    const mismatchColumnsAllActionNeutral =
      comparisonResult.mismatchColumns.length > 0
      && comparisonResult.mismatchColumns.every(col => actionNeutralColumns.has(col));

    // WP5/B5/B15 — technical-segment coverage. Computed here, after every branch above
    // has finished (firedVarianceIntervals is only complete once the row's decision
    // logic has fully run). A row that fired no variance (e.g. a no-login absence,
    // deliberately excluded — B15) never reaches this: there is nothing to excuse.
    // Held only when EVERY fired interval is fully covered, never "any" (trap 2) — a row
    // with two variances, only one technically covered, still exports both (B15's red
    // line). A SEPARATE local, never forcedHoldReason (trap 1): this is a releasable
    // hold and must sit below every forced code in the cascade below, or a row also
    // carrying a locked condition would report this one instead and become tickable.
    let technicalHoldReason: HoldReasonCode | undefined;
    if (firedVarianceIntervals.length > 0) {
      const technicalSegments = empSegs.filter(s => isCodeInConfiguredSet(s.SEG_CODE, config.technicalSegmentCodes || []));
      const technicalIntervals = coverIntervalsFromSegments(technicalSegments);
      if (technicalIntervals.length > 0) {
        const uncoveredBy = firedVarianceIntervals.map(v => uncoveredMinutes(v.start, v.end, technicalIntervals));
        if (uncoveredBy.every(m => m <= config.technicalSegmentToleranceMinutes)) {
          technicalHoldReason = 'TECHNICAL_SEGMENT_COVERS_VARIANCE';
          ruleFired += ` | Technical segment(s) cover the full charged variance (${technicalSegments.map(s => s.SEG_CODE).join(', ')}) — held for reviewer approval, correction(s) still built.`;
        } else if (uncoveredBy.some((m, i) => m < (firedVarianceIntervals[i].end.getTime() - firedVarianceIntervals[i].start.getTime()) / 60000)) {
          // B5: partial overlap proceeds with the overlap noted — never silently held, never silently dropped.
          ruleFired += ` | Technical segment(s) partially cover the charged variance (${technicalSegments.map(s => s.SEG_CODE).join(', ')}) — not enough to hold, correction(s) still exported.`;
        }
      }
    }

    // ---- Phase 5: review/approval gate.
    let holdReason: HoldReasonCode | undefined = forcedHoldReason;
    if (!holdReason && conflictingIdentityIds.has(pfNo)) holdReason = 'CONFLICTING_IDENTITY_RECORD';
    if (!holdReason && recompute.unclassifiedCodes.length > 0) holdReason = 'UNCLASSIFIED_SEGMENT_CODE';
    // Schedule-integrity holds. Each of these means a number that feeds the late/early
    // verdict is unknown or self-contradictory, so the verdict above — however confident it
    // looks — rests on a guess. Hold rather than push a guessed correction into payroll.
    if (!holdReason && recompute.unknownDurationRemovalSegments.length > 0) holdReason = 'REMOVAL_SEGMENT_DURATION_UNKNOWN';
    if (!holdReason && recompute.durationDisagreementSegments.length > 0) holdReason = 'SEGMENT_STOP_DURATION_DISAGREE';
    if (!holdReason && recompute.outOfWindowRemovalSegments.length > 0) holdReason = 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW';
    // R5 fix: a duration-only removal coexisting with a timestamped removal in the same
    // leading/trailing group — netScheduledMinutes may still be double-subtracting an
    // overlap the union fix (F04) can't detect without a real interval to compare against.
    if (!holdReason && recompute.ambiguousOverlappingRemovalSegments.length > 0) holdReason = 'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION';
    // Two or more DIFFERENT addition segments (e.g. two COVER rows) genuinely
    // overlapping in time — netScheduledMinutes summed both with no overlap check.
    if (!holdReason && recompute.ambiguousOverlappingAdditionSegments.length > 0) holdReason = 'AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS';
    // A removal (or combination) exceeding the day's addition minutes would report a
    // negative scheduled-minutes total — already clamped to 0 in scheduleRecompute.ts,
    // held here rather than trusting the clamp silently.
    if (!holdReason && recompute.negativeNetScheduleMinutes) holdReason = 'NEGATIVE_NET_SCHEDULE_MINUTES';
    // Ambiguous punch attribution (D-D residual tie): the punch WAS assigned
    // via the priority cascade so the verdict above is a best guess, not
    // fabricated — but it must still be reviewed before it reaches output.
    if (!holdReason && ambiguousAttribution) holdReason = 'AMBIGUOUS_PUNCH_ATTRIBUTION';
    // Mixed leave-and-work day (§Leave Segments): an identified leave segment coexists with
    // a worked Addition segment (SHIFT/OT/COVER/custom) on the same day. Never a forced hold
    // (not added to FORCED_HOLD_REASONS) — calculations already ran normally above so the
    // reviewer can inspect the evidence, and the existing includeInOutput approval releases
    // it. Placed after every data-integrity hold but before generic MISMATCH_FOUND, so a
    // genuine evidence problem still takes precedence, and this fires even when LEAVE TYPE
    // itself matched.
    // Public-holiday overtime exemption (decision 2026-09-12, KB §7k; PRD Non-Negotiables
    // "Holiday Overtime (PF 4507957 on 28/08)"): a day whose leave segments are ALL a
    // configured public-holiday-overtime leave code (default P/H-LV) and whose worked
    // segments are ALL OT2 is the documented, normal shape of holiday overtime — the staff
    // member attended and must be paid, so it is evaluated and exported like any working
    // day. Deliberately narrow: OT1, COVER, a real SHIFT, or any other leave code alongside
    // work is still a genuine leave/work conflict and still held (reg-108, BR-20, reg-115,
    // reg-116).
    const isPublicHolidayOvertimeDay =
      leaveSegmentsForDay.length > 0
      && leaveSegmentsForDay.every(s => isCodeInConfiguredSet(s.SEG_CODE, config.publicHolidayOvertimeLeaveCodes || []))
      && recompute.additionSegments.length > 0
      && recompute.additionSegments.every(s => (s.SEG_CODE || '').trim().toUpperCase() === 'OT2');
    // Public-holiday SHIFT miscoding (decision 2026-09-12, mirror of the exemption
    // above, reversed): same leave-side test, but every worked segment is SHIFT
    // instead of OT2 — staff was scheduled as a normal shift on a public-holiday-
    // leave day by mistake. !isPublicHolidayOvertimeDay is redundant-but-explicit:
    // a non-empty additionSegments list can never be "every element OT2" AND
    // "every element SHIFT" at once, so the two conditions are structurally
    // exclusive already; a day mixing SHIFT+OT2 (or any other code) satisfies
    // neither .every() and falls through unconverted to the generic
    // MIXED_LEAVE_AND_WORK_SEGMENTS hold below, same as today.
    // Re-run guard (decision 2026-09-15): a day whose ASPECT segments already
    // include an ABSENT/Absent NS/NC marker was already corrected by §4.6c above
    // (in an earlier TAA run, its OT segment was replaced with SHIFT via a 10/11
    // pair) — re-running TAA against that same, now-corrected ASPECT export must
    // never see the resulting P/H-LV + SHIFT shape and propose converting the
    // SHIFT back to OT2, which would undo §4.6c's fix.
    // Reuses the §4.6f gate's own detection (config.existingAbsenceMarkerCodes) —
    // one source of truth, not a second hardcoded list.
    const dayAlreadyHasAbsentMarker = !!existingAbsenceMarkerSegment;
    const isPublicHolidayShiftMiscodedDay =
      !isPublicHolidayOvertimeDay
      && !dayAlreadyHasAbsentMarker
      && leaveSegmentsForDay.length > 0
      && leaveSegmentsForDay.every(s => isCodeInConfiguredSet(s.SEG_CODE, config.publicHolidayOvertimeLeaveCodes || []))
      && recompute.additionSegments.length > 0
      && recompute.additionSegments.every(s => (s.SEG_CODE || '').trim().toUpperCase() === 'SHIFT');
    if (isPublicHolidayShiftMiscodedDay) {
      convertShiftSegmentsToOt2(recompute.additionSegments, pfNo, nomDateStr, rowCorrections, config);
    }
    // Phase 5 (held-review reduction, 2026-09-24) — "nobody worked, all sources agree" gate:
    // skips the two soft NO_ACTION holds just below (MIXED_LEAVE_AND_WORK_SEGMENTS,
    // FULL_DAY_REMOVAL_ON_SCHEDULED_DAY) ONLY, never PUBLIC_HOLIDAY_SHIFT_MISCODED and never
    // any forced hold. Requires CMS, Cognos and ASPECT to ALL agree nobody worked and the day
    // is leave: no action/correction owed on this row, no attributed CMS punch, Cognos itself
    // shows no sign-in, and LEAVE TYPE already resolved to MATCH (Step 1's REMOVAL_CODE basis
    // included). MISMATCH_FOUND and every hold below still runs normally on the unheld row, so
    // a real disagreement (e.g. an out-of-window punch via runUnseenPunchAudit) still holds it.
    const cognosSigninDurationRaw = (cognos['SIGNIN DURATION'] || '').trim();
    // Kill switch (releaseProvenSafeHolds, Step 3 2026-09-24): when off, this gate never
    // releases MIXED_LEAVE_AND_WORK_SEGMENTS/FULL_DAY_REMOVAL_ON_SCHEDULED_DAY and both
    // soft holds fire exactly as they did before Phase 5.
    const noAttendanceAllAgree =
      config.releaseProvenSafeHolds
      && !holdReason
      && action === 'NO_ACTION'
      && firedActionCodes.length === 0
      && rowCorrections.length === 0
      && matchingPunches.length === 0
      && !(cognos['SIGIN IN'] || '').trim()
      && !(cognos['SIGIN OUT'] || '').trim()
      && (cognosSigninDurationRaw === '' || parseCognosHMinutes(cognosSigninDurationRaw) === 0)
      && comparisonResult.comparisons.find(c => c.column === 'LEAVE TYPE')?.status === 'MATCH';
    // Set ONLY when the gate actually released this row (skipped one of the two soft holds
    // below) — the unseen-punch audit's own dedicated re-hold marker (details.
    // noAttendanceGateReleased). Never inferred from ruleFired text by that audit.
    let noAttendanceGateReleased: { holdReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY' | 'MIXED_LEAVE_AND_WORK_SEGMENTS' } | undefined;
    if (!holdReason && leaveSegmentsForDay.length > 0 && recompute.additionSegments.length > 0 && !isPublicHolidayOvertimeDay) {
      if (isPublicHolidayShiftMiscodedDay) {
        holdReason = 'PUBLIC_HOLIDAY_SHIFT_MISCODED';
      } else if (!noAttendanceAllAgree) {
        holdReason = 'MIXED_LEAVE_AND_WORK_SEGMENTS';
      } else {
        ruleFired = `${ruleFired ? ruleFired + ' — ' : ''}Released: no attendance in CMS or Cognos; both name ${leaveSegmentsForDay.map(s => s.SEG_CODE).join(', ') || 'leave'}; no action owed.`;
        noAttendanceGateReleased = { holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS' };
      }
    }
    // Soft, reviewer-releasable (NOT in FORCED_HOLD_REASONS): a full-day removal (no duration,
    // no times) just took an entire scheduled day off the hours. The maths is what the user
    // asked for, but if the agent actually worked that day the attendance rules above will
    // have charged a late-logout against a fully released window — so a human confirms first.
    if (!holdReason && recompute.fullDayRemovalMinutes > 0) {
      if (!noAttendanceAllAgree) {
        holdReason = 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY';
      } else {
        ruleFired = `${ruleFired ? ruleFired + ' — ' : ''}Released: no attendance in CMS or Cognos; both name ${leaveSegmentsForDay.map(s => s.SEG_CODE).join(', ') || recompute.fullDayRemovalSegments.map(s => s.SEG_CODE).join(', ') || 'leave'}; no action owed.`;
        noAttendanceGateReleased = { holdReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY' };
      }
    }
    // Soft, reviewer-releasable signal (deliberately NOT in FORCED_HOLD_REASONS):
    // a malformed (not merely blank) DURATION cell was silently repaired from
    // timestamps. MUST stay below every FORCED hold — it previously sat above
    // AMBIGUOUS_PUNCH_ATTRIBUTION (which IS forced), so a row carrying both
    // conditions reported this releasable reason instead of the locked one and
    // became tickable into the payroll CSV. Only the soft leave/work and generic
    // MISMATCH_FOUND holds may follow it.
    if (!holdReason && recompute.malformedDurationRepairedSegments.length > 0) holdReason = 'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS';
    // WP5/B5/B15 — releasable, MUST stay below every forced code above and MUST stay
    // above the generic MISMATCH_FOUND below (more specific and more actionable — a
    // reviewer checking a technical-outage claim needs to see THIS reason, not a bare
    // column-mismatch hold).
    if (!holdReason && technicalHoldReason) holdReason = technicalHoldReason;
    // TAA_COGNOS_AGREE can be forced to false above (DEFECT_1_RELEASE_IGNORED)
    // independent of comparisonResult.mismatchColumns — previously such a row
    // could still auto-include because inclusion only ever checked
    // mismatchColumns. Every TAA_COGNOS_AGREE=false is held unless its
    // disagreeReason is an explicitly configured exception (none ship by
    // default — a business/vendor decision is required to add one).
    const cognosAgreeOverrideUnexempted =
      cognosAgreeForcedFalseWithNoMismatch
      && comparisonResult.mismatchColumns.length === 0
      && !(config.cognosAgreeOverrideExceptions || []).includes(disagreeReason)
      && !defect1AutoExempt;
    if (!holdReason && ((comparisonResult.mismatchColumns.length > 0 && !mismatchColumnsAllActionNeutral) || cognosAgreeOverrideUnexempted)) holdReason = 'MISMATCH_FOUND';
    const forced = isForcedHoldReason(holdReason);
    // NOT applying an "always force action=MANUAL_REVIEW_REQUIRED on any forced hold"
    // change here: it satisfies the 40-scenario validation pack's BR-18 expectation but
    // directly contradicts 3 existing hand-authored regression cases (reg-51, reg-53,
    // reg-56 in regressionSuite.ts), which explicitly assert action=NO_ACTION for this
    // exact class of schedule-integrity hold (MID_SHIFT_REMOVAL_SEGMENT,
    // REMOVAL_SEGMENT_DURATION_UNKNOWN, SEGMENT_STOP_DURATION_DISAGREE). That is a real
    // policy conflict between two authoritative specs, not a mechanical bug — see the
    // conversation/report for the decision this needs before either side is changed.
    const includeInOutput = !holdReason;
    if (holdReason) heldForReviewCount++;

    // D-A fix: every distinct action code that actually fired this row,
    // reported alongside the single most-severe TAA_ACTION — a row carrying
    // two findings (e.g. late login AND early logout) must surface both.
    const actionsFiredList = Array.from(new Set(firedActionCodes));
    const actionsFiredStr = actionsFiredList.join('; ');

    // Build an Email Action for every row, unconditionally — sourced from the
    // rule that actually fired (D5 fix), not re-derived by action+tier alone.
    //
    // The fired Communication Rule used to be the sole gate on whether an
    // EmailActionItem was built at all: rows with no fired rule (NA) got no
    // action, so a NO_ACTION_REQUIRED row had no way to be emailed. That
    // blocked a legitimate case: a TAA agent who spots something worth
    // flagging on a row the rules engine didn't flag still needs to be able
    // to draft a notice for it. So this now always builds an action — a row
    // whose communication_rule stays 'NA' is exactly how downstream code
    // tells a policy-required email apart from an ad-hoc/optional one, even
    // though such a row may still carry a specific template_key (e.g. a rule
    // fired with a real finding but its own configured communication is NA):
    // whenever no rule fires at all, emailTemplateKey keeps its 'generic'
    // default, so the case-detail block still renders. planEmailDraftActions,
    // poolEmailOpsActionsBySection and computeEmailStatusByRowId already key
    // strictly off EMAIL_OPS/EMAIL_STAFF_CC_MANAGER, so 'NA' rows keep being
    // excluded from Bulk Draft, the Actions JSON, and TAA_EMAIL_STATUS with
    // no changes needed there. There used to be a second, hardcoded gate here
    // too, requiring the action to be ABSENT_SEGMENT / ABSENT_NS_NC /
    // LATE_AND_COVER. With the shipped rule set that changed nothing — every
    // §4.1 row carrying an EMAIL_* rule lands on one of those actions — but it
    // silently overrode config: PRD §4.1 and KB "do not hard-code the email
    // decisions" both make communication a data-driven property of the rule,
    // and an operator who set EMAIL_OPS on any other action would have got no
    // email and no explanation.
    // One EmailActionItem PER FIRED ACTION (not one per row) — a row firing
    // both a Late+Cover finding and a separate Absent finding (e.g.
    // config.retainLateCoverOnAbsent on) must draft both notices, each with
    // its OWN template/communication/variance, not just the most-severe
    // survivor's. Deduped by actionCode (first occurrence wins, same as
    // actionsFiredList's Set dedup above) — two different sub-rules landing
    // on the SAME action code (e.g. Late Login and Late Logout both
    // producing ABSENT_SEGMENT) is one finding, one email, not two
    // near-duplicate absence notices.
    const seenEmailActionCodes = new Set<TaaActionCode>();
    const dedupedFiredActions = firedActionDetails.filter(d => {
      if (seenEmailActionCodes.has(d.actionCode)) return false;
      seenEmailActionCodes.add(d.actionCode);
      return true;
    });
    // A row where NO rule fired at all still gets exactly one generic/NA
    // item (unchanged from before this row-vs-action split existed) — see
    // the long comment above about why every row always gets an email.
    const emailSources = dedupedFiredActions.length > 0
      ? dedupedFiredActions
      : [{ actionCode: action, communicationRule: firedCommunicationRule, emailTemplateKey, varianceMin: chargedVarianceMin, note: ruleFired }];

    emailSources.forEach(source => {
      const emailName = cognos['NAME'] || identity?.EMP_LAST_NAME || pfNo;
      const templatedAction = applyEmailTemplate({
        // Composite id whenever a row fires more than one action, so a second
        // action never silently overwrites the first in any Map keyed by
        // row_id. Consumers group these back via base_row_id below — never by
        // splitting this string, which is unsafe when a PF NO itself contains
        // a '#' (real occurrence in samples_Files/Cognos.csv: `PF NO = "PT #"`).
        row_id: emailSources.length > 1 ? `${rowId}#${source.actionCode}` : rowId,
        base_row_id: rowId,
        template_key: source.emailTemplateKey,
        emp_id: pfNo, name: emailName, nominate_date: nomDateStr, role_tier: effectiveTierLabel, category: source.note,
        variance_minutes: source.varianceMin, taa_action: source.actionCode, communication_rule: source.communicationRule,
        extra_2_alias: identity?.EMP_EXTRA_2 || '', email_adr: identity?.EMP_EMAIL_ADR || '', resolved_username: recipientInfo.resolvedUsername,
        login_id: loginId, section: sectionResolution.section, is_terminated: recipientInfo.isTerminated, subject: '', body: '', to: '',
      }, config.emailTemplates, {
        // Ad-hoc/generic case-detail placeholders — a NO_ACTION_REQUIRED row's
        // {{finding}}/{{taa_action}} are legitimately blank, so the generic
        // template leans on these instead to give an agent drafting a manual
        // notice the full picture TAA computed for the row.
        sch_hours: formatMinutesToHHMM(recompute.netScheduledMinutes),
        effective_start: formatTimeQualified(effectiveStartDt, referenceDay),
        effective_end: formatTimeQualified(effectiveEndDt, referenceDay),
        cms_in: formatTimeQualified(actualFirstLoginDt, referenceDay),
        cms_out: formatTimeQualified(actualLastLogoutDt, referenceDay),
        late_min: String(lateMin),
        early_min: String(earlyMin),
        verdict,
        result_category: resultCategory,
        actions_fired: actionsFiredStr || 'None',
      });
      if (actionsFiredList.length > 1) {
        templatedAction.body += `\n\nActions fired (all, this row): ${actionsFiredStr}`;
      }
      // Recipient resolution (§4.7) — done once here, unconditionally, so `to`
      // is already correct even for an EMAIL_OPS row that a later single-row
      // override (buildIndividualOverride) turns into an individual notice.
      // TERMINATED takes priority over the normal resolution: the recipient is
      // deliberately left blank rather than guessed, and the subject makes
      // that unmissable, exactly as the old VBA companion did.
      if (recipientInfo.isTerminated) {
        templatedAction.to = '';
        templatedAction.subject = `[TERMINATED - VERIFY] ${templatedAction.subject}`;
        templatedAction.body += '\n\nAUDIT WARNING: this employee record is flagged TERMINATED - verify before acting on this notice.';
      } else {
        const recipient = resolveEmailRecipient({
          username: recipientInfo.resolvedUsername,
          emailAdr: identity?.EMP_EMAIL_ADR || '',
          name: emailName,
          corporateDomains: config.emailCorporateDomains,
        });
        templatedAction.to = recipient.to;
        if (recipient.usedNameFallback) {
          templatedAction.subject = `[VERIFY RECIPIENT] ${templatedAction.subject}`;
        }
      }
      // Manager CC only ever applies on the staff-facing path — EMAIL_OPS goes
      // to a shared mailbox, never to a manager. Optional: no mapping for this
      // employee just means no CC, never a warning. Gated on THIS action's own
      // communication rule, not the row-level firedCommunicationRule — the
      // row-level value is only the most-severe survivor and would silently
      // apply the wrong action's audience to a second, less-severe email.
      if (source.communicationRule === 'EMAIL_STAFF_CC_MANAGER') {
        templatedAction.cc = findManagerEmail(config.employeeManagerMap, pfNo);
      }
      emailActions.push(templatedAction);
    });

    rowCorrections.forEach(c => allCorrections.push(c));

    if (reducedOfficeHoursApplied) {
      ruleFired += ` | Reduced office hours: ${reducedOfficeHoursMin}m required from actual login`;
    }

    const reconciliationRow: ReconciliationRow = {
      id: rowId,
      originalCognos: { ...cognos },
      TAA_MARKER: 'DERIVED_ANALYSIS_DO_NOT_REPLACE_OFFICIAL_REPORT',
      TAA_TIER: effectiveTierLabel,
      TAA_OT1: recompute.ot1Minutes > 0 ? String(recompute.ot1Minutes) : '',
      TAA_OT2: recompute.ot2Minutes > 0 ? String(recompute.ot2Minutes) : '',
      TAA_SCH_HOURS_RECOMPUTED: recompute.netScheduledMinutes,
      TAA_SCH_HOURS_FORMATTED: formatMinutesToHHMM(recompute.netScheduledMinutes),
      // Qualified with a date whenever they fall on a different calendar day from the
      // shift's own start — otherwise a night shift's 07:00 logout is indistinguishable
      // from a 07:00 logout on the shift's own morning.
      TAA_EFFECTIVE_START: formatTimeQualified(effectiveStartDt, referenceDay),
      TAA_EFFECTIVE_END: formatTimeQualified(effectiveEndDt, referenceDay),
      TAA_CMS_IN: formatTimeQualified(actualFirstLoginDt, referenceDay),
      TAA_CMS_OUT: formatTimeQualified(actualLastLogoutDt, referenceDay),
      TAA_LATE_MIN: lateMin,
      TAA_EARLY_MIN: earlyMin,
      TAA_VERDICT: verdict,
      TAA_ACTION: action,
      TAA_ACTIONS_FIRED: actionsFiredStr,
      TAA_RESULT_CATEGORY: resultCategory,
      TAA_COGNOS_AGREE: cognosAgree,
      TAA_DISAGREE_REASON: disagreeReason,
      TAA_USERNAME: recipientInfo.resolvedUsername,
      TAA_SECTION: sectionResolution.section,
      TAA_SECTION_SOURCE: sectionResolution.source,
      TAA_ASPECT_SECTION: sectionResolution.aspectIdentitySection,
      TAA_SECTION_MISMATCH: sectionResolution.mismatch,
      TAA_IS_TERMINATED: recipientInfo.isTerminated,
      columnComparisons: comparisonResult.comparisons,
      TAA_MISMATCH_COUNT: comparisonResult.mismatchColumns.length,
      TAA_MISMATCH_COLUMNS: comparisonResult.mismatchColumns.join('; '),
      TAA_FILLED_COLUMNS: comparisonResult.filledColumns.join('; '),
      TAA_LEAVE_TYPE_RECOMPUTED: comparisonResult.leaveTypeRecomputed,
      TAA_LEAVE_TYPE_STATUS: comparisonResult.comparisons.find(c => c.column === 'LEAVE TYPE')?.status || 'NOT_COMPARABLE',
      TAA_LEAVE_TYPE_MATCH_BASIS: comparisonResult.leaveTypeMatchBasis,
      includeInOutput,
      includeDecisionSource: 'auto',
      reviewCompleted: false,
      reviewStatus: 'NOT_TOUCHED',
      holdReason,
      holdReasonText: (() => {
        if (!holdReason) return undefined;
        const baseText = holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS'
          ? `${HOLD_REASON_TEXT[holdReason]} Leave: ${identifiedLeaveCodes.join(', ')}; Work: ${recompute.additionSegments.map(s => s.SEG_CODE).join(', ')}.`
          : holdReason === 'UNCLASSIFIED_SEGMENT_CODE'
            ? `${HOLD_REASON_TEXT[holdReason]} Unclassified code(s): ${recompute.unclassifiedCodes.join(', ')}.`
            : HOLD_REASON_TEXT[holdReason];
        return forced ? `${baseText} (locked — cannot be included until resolved)` : baseText;
      })(),
      coverFallbackNote: getCoverFallbackNote(rowCorrections, config),
      releaseGridNote: releaseGridNote || undefined,
      details: {
        isFlex, isLeaveDay, hasOvertime, ruleFired, reducedOfficeHoursApplied,
        punchCount: matchingPunches.length,
        rawShiftStart: rawStartDt ? formatTimeHHMM(rawStartDt) : undefined,
        rawShiftEnd: rawEndDt ? formatTimeHHMM(rawEndDt) : undefined,
        rawShiftStartFull: formatDateTimeFull(rawStartDt),
        rawShiftEndFull: formatDateTimeFull(rawEndDt),
        cmsFirstLoginFull: formatDateTimeFull(actualFirstLoginDt),
        cmsLastLogoutFull: formatDateTimeFull(actualLastLogoutDt),
        releaseMinutes: recompute.releaseMinutes,
        nursingMinutes: recompute.nursingMinutes,
        otInternalRemovalMinutes: recompute.otInternalRemovalMinutes,
        chargedVarianceMinutes: chargedVarianceMin,
        aspectSegments: empSegs,
        punches: matchingPunches,
        generatedCorrections: rowCorrections,
        unclassifiedSegmentCodes: recompute.unclassifiedCodes,
        invalidAspectDateTimes: recompute.invalidDateTimeSegments.map(s =>
          `${s.SEG_CODE}: NOM_DATE=${s.NOM_DATE || '(blank)'}, START_DATE=${s.START_DATE || '(blank)'}, START=${s.START_MOMENT || '(blank)'}, STOP=${s.STOP_MOMENT || '(blank)'}`
        ),
        sectionSource: sectionResolution.source,
        cognosSection: sectionResolution.cognosSection,
        aspectIdentitySection: sectionResolution.aspectIdentitySection,
        sectionMismatch: sectionResolution.mismatch,
        scheduleShapeUnresolved: recompute.scheduleShapeUnresolved,
        coverageSufficient,
        noAttendanceGateReleased,
        varianceTrace: {
          rawStart: formatTimeQualified(rawStartDt, referenceDay),
          rawEnd: formatTimeQualified(rawEndDt, referenceDay),
          effectiveStart: formatTimeQualified(effectiveStartDt, referenceDay),
          effectiveEnd: formatTimeQualified(effectiveEndDt, referenceDay),
          leadingReleaseMinutes: recompute.leadingReleaseMinutes,
          trailingReleaseMinutes: recompute.trailingReleaseMinutes,
          nursingMinutes: recompute.nursingMinutes,
          otInternalRemovalMinutes: recompute.otInternalRemovalMinutes,
          removals: recompute.removalTrace,
          actualFirstLogin: formatTimeQualified(actualFirstLoginDt, referenceDay),
          actualLastLogout: formatTimeQualified(actualLastLogoutDt, referenceDay),
          attendanceSpanMinutes,
          staffedMinutes,
          punchCount: matchingPunches.length,
          measurements: varianceMeasurements,
        },
      },
    };

    results.push(reconciliationRow);
  }

  const aspectCorrectionsCsv = generateAspectCorrectionsCsv(
    results.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections)
  );
  const annotatedCognosCsv = generateAnnotatedCognosFile(results, ',', config, verificationAudit, emailActions);
  const annotatedCognosTsv = generateAnnotatedCognosFile(results, '\t', config, verificationAudit, emailActions);
  const emailActionsJson = generateEmailActionsJson(emailActions, results, config);

  return {
    rows: results,
    aspectCorrections: allCorrections,
    aspectCorrectionsCsv,
    annotatedCognosCsv,
    annotatedCognosTsv,
    emailActions,
    emailActionsJson,
    verificationAudit,
    summary: {
      totalRecords: cognosRecords.length,
      shiftChangedCount, lateCoverCount, markedAbsentCount, noActionCount,
      // D14 fix: derived from the finished rows, not a single-gate increment
      // — see the comment where the old counter was removed above.
      cognosDataGapCount: results.filter(r => r.TAA_RESULT_CATEGORY === 'COGNOS_DATA_GAP').length,
      disagreementsResolvedCount, overtimeRowsCount, flexRowsCount, otConvertedCount, otRlsAdjustedCount,
      heldForReviewCount, mismatchCount,
      // D19/B7/B12 — a duplicate view over the same rows, never added into
      // any other total.
      mustCheckCount: results.filter(rowIsMustCheck).length,
    },
  };
}

// Applies the same Section-pooling/redirect/ops_mailbox routing plan as the
// in-app Bulk Draft button (see planEmailDraftActions) so the internal
// email-actions list never ships an EMAIL_OPS action without an ops_mailbox.
// Rows cleared for the reviewed outputs. Built once, not rebuilt inside a
// filter callback for every action.
function eligibleRowIdSet(rows: ReconciliationRow[] | undefined): ReadonlySet<string> | null {
  return rows
    ? new Set(rows.filter(r => r.includeInOutput && !isForcedHoldReason(r.holdReason)).map(r => r.id))
    : null;
}

export function generateEmailActionsJson(emailActions: EmailActionItem[], rows: ReconciliationRow[] | undefined, config: ConfigRegistry): string {
  const { eligible } = computeEmailStatusByRowId(
    emailActions, eligibleRowIdSet(rows), config.sectionMailboxMap, config.emailTemplates,
  );
  const { finalActions } = planEmailDraftActions(eligible, config.sectionMailboxMap, config.emailTemplates);
  return JSON.stringify(finalActions, null, 2);
}

interface DownstreamResult {
  verdict: string;
  action: TaaActionCode;
  resultCategory: TaaResultCategory;
  ruleFired: string;
  chargedVarianceMin: number;
  communicationRule: CommunicationRule;
  emailTemplateKey: EmailTemplateKey;
  rowCorrections: AspectCorrectionRow[];
  holdReason?: HoldReasonCode;
  earlyMin: number;
  lateLogoutMin: number;
  /** WP5/B5/B15 — the real Date interval behind whichever of earlyMin/lateLogoutMin
   * actually fired an action here (undefined when neither did). Late Logout uses the
   * GROSS window [effectiveEndDt, actualLastLogoutDt], matching the standard path's
   * own choice (see its comment) — the stricter test, not the credited remainder. */
  varianceInterval?: { label: 'EARLY_LOGOUT' | 'LATE_LOGOUT'; start: Date; end: Date };
  /** Trace-only explanation for a finding that deliberately took no action (the "already
   * actioned" rule) — appended to ruleFired by the caller even on NO_ACTION_REQUIRED. */
  infoNote?: string;
  /** Attended-COVER minutes credited against the gross late-logout time (0 when none). */
  lateLogoutCreditedMin?: number;
}

/**
 * Flex pair duration is the SHIFT effective window, never the raw addition span.
 * SHIFT+OT would otherwise treat overtime as hours to slide with the start;
 * OT2-only days (no SHIFT) keep the full effective window.
 */
function flexShiftedDurationMinutes(recompute: DayScheduleRecompute, rawStartDt: Date, rawEndDt: Date): number {
  const flexStart = recompute.effectiveStart || rawStartDt;
  let flexEnd = recompute.effectiveEnd || rawEndDt;
  let lastShiftStop: Date | null = null;
  for (const s of recompute.shiftSegments) {
    if (!s.STOP_MOMENT) continue;
    const parsed = parseDateTimeString(s.STOP_MOMENT);
    if (!parsed) continue;
    const d = truncateToMinute(parsed);
    if (!lastShiftStop || d.getTime() > lastShiftStop.getTime()) lastShiftStop = d;
  }
  if (lastShiftStop && flexEnd.getTime() > lastShiftStop.getTime()) flexEnd = lastShiftStop;
  return Math.max(0, diffInMinutes(flexStart, flexEnd));
}

/** F14 fix: flexShiftedDurationMinutes above deliberately EXCLUDES OT — needed so the
 * flex shift-update correction row's own duration reflects only the SHIFT (8h), never
 * a fabricated SHIFT+OT span that would corrupt the separately-tracked OT segment
 * (V01_FLEX_OT_DURATION regression guard). But the downstream early/late-logout
 * ANCHOR needs the opposite in ONE specific case: a flex employee who arrives, works
 * their SHIFT, and continues straight into a genuinely scheduled OT block (real data:
 * OT always starts the instant the SHIFT ends) is on time logging out at the OT's own
 * end — charging "late logout" measured only against the SHIFT's own end, ignoring OT
 * they were also scheduled and demonstrably worked, previously produced a false
 * absence on a real overtime day.
 *
 * Critical guard (reg-71): a flex employee who logs out AT the shift-only end and
 * never attends the OT at all must NOT have their anchor silently extended — that
 * would turn "worked exactly the adjusted shift, skipped OT" into a manufactured
 * early-logout/absence against an OT block they were never near. The anchor only
 * extends into an OT segment when actualLastLogoutDt itself is demonstrably PAST the
 * current end — i.e. there is real punch evidence of continuing to work, not just an
 * OT segment sitting in the schedule. */
function flexAttendanceEndDt(recompute: DayScheduleRecompute, shiftOnlyEndDt: Date, actualLastLogoutDt: Date | null): Date {
  let end = shiftOnlyEndDt;
  if (!actualLastLogoutDt || actualLastLogoutDt.getTime() <= end.getTime()) return end;
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const s of [...recompute.ot1Segments, ...recompute.ot2Segments]) {
      const parsedStart = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
      const parsedStop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
      if (!parsedStart || !parsedStop) continue;
      const otStart = truncateToMinute(parsedStart);
      const otStop = truncateToMinute(parsedStop);
      if (otStart.getTime() <= end.getTime() && otStop.getTime() > end.getTime() && actualLastLogoutDt.getTime() > end.getTime()) {
        end = otStop;
        advanced = true;
      }
    }
  }
  return end;
}

/** F08/F14 fix shared logic: Rule 7 (Cover Not Attended) and Rule 8 (RLS added to OT
 * with no adjustment) used to live only inline in the standard (non-flex) branch — a
 * flex employee's COVER segments and OT/release overlaps were never evaluated at all,
 * so a flex staffer could miss required cover minutes with zero correction, or work a
 * genuine OT window that a release partially overlapped and never get it adjusted.
 * Extracted here as pure math so both the standard and flex branches call the exact
 * same rule, never two copies that can drift. */
interface CoverNotAttendedFinding {
  coverSeg: AspectSegment;
  covStart: Date;
  covEnd: Date;
  overlapMinutes: number;
  coverDurationMinutes: number;
  shortfallMinutes: number;
  rule: PolicyRuleItem;
  /** WP5/B5/B15 — carried through so buildCoverNotAttendedOutcomes can construct the
   * unattended interval(s) without re-threading punches a second time. Both are
   * guaranteed non-null here (the function returns [] above when either is missing). */
  actualFirstLoginDt: Date;
  actualLastLogoutDt: Date;
}

function evaluateCoverNotAttended(
  coverSegments: AspectSegment[], actualFirstLoginDt: Date | null, actualLastLogoutDt: Date | null,
  tier: RoleTier, config: ConfigRegistry
): CoverNotAttendedFinding[] {
  if (!actualFirstLoginDt || !actualLastLogoutDt) return [];
  const findings: CoverNotAttendedFinding[] = [];
  coverSegments.forEach(coverSeg => {
    const parsedCovStart = coverSeg.START_MOMENT ? parseDateTimeString(coverSeg.START_MOMENT) : null;
    const parsedCovEnd = coverSeg.STOP_MOMENT ? parseDateTimeString(coverSeg.STOP_MOMENT) : null;
    if (!parsedCovStart || !parsedCovEnd) return;
    const covStart = truncateToMinute(parsedCovStart);
    const covEnd = truncateToMinute(parsedCovEnd);
    const overlapStart = Math.max(covStart.getTime(), actualFirstLoginDt.getTime());
    const overlapEnd = Math.min(covEnd.getTime(), actualLastLogoutDt.getTime());
    const overlapMinutes = Math.max(0, Math.floor((overlapEnd - overlapStart) / 60000));
    const coverDurationMinutes = coverSeg.DURATION ?? Math.floor((covEnd.getTime() - covStart.getTime()) / 60000);
    const shortfallMinutes = Math.max(0, coverDurationMinutes - overlapMinutes);
    if (shortfallMinutes <= 0) return;
    const coverRule = lookupPolicyRule(config, 'Cover Not Attended', tier, shortfallMinutes);
    if (!coverRule || coverRule.action === 'NO_ACTION') return;
    findings.push({ coverSeg, covStart, covEnd, overlapMinutes, coverDurationMinutes, shortfallMinutes, rule: coverRule, actualFirstLoginDt, actualLastLogoutDt });
  });
  return findings;
}

interface RlsOtAdjustmentFinding {
  otSeg: AspectSegment;
  otStart: Date;
  otEnd: Date;
  otDuration: number;
  /** Merged (non-overlapping) RLS windows clipped to this OT segment's own
   * span — used to place the OT->SHIFT conversion row(s) at the actual
   * released time, not the OT segment's own full start/duration. Two removal
   * segments covering the identical window (e.g. RLS + UN_RLS both
   * 16:00-17:00, see reg-74) collapse to one merged interval here so the
   * conversion never double-emits for the same physical hour. */
  mergedOverlapIntervals: { start: Date; end: Date }[];
}

/** Merge a set of (possibly overlapping/duplicate) intervals into the
 * smallest non-overlapping set covering the same time. Shared by the overlap
 * total (below) and by RlsOtAdjustmentFinding.mergedOverlapIntervals so the
 * two can never disagree on what counts as "the same released window". */
function unionIntervals(intervals: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  const sorted = intervals
    .map(i => ({ start: i.start.getTime(), end: i.end.getTime() }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];
  const merged: { start: number; end: number }[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      if (sorted[i].end > last.end) last.end = sorted[i].end;
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged.map(m => ({ start: new Date(m.start), end: new Date(m.end) }));
}

/**
 * WP1 — proof of CONTINUOUS attendance, used ONLY to credit cover against late logout
 * (decision B6; Rule 7 / Cover Not Attended deliberately keeps its own first-login..last-logout
 * span and is not changed by this).
 *
 * Every closed CMS session is rounded OUTWARD to whole minutes (login floored, logout ceiled) and
 * sessions that touch or overlap are merged. Outward rounding means a badge hand-off with a few
 * seconds between one logout and the next login reads as continuous, while a real gap of a full
 * minute or more does not — so no separate tolerance setting is needed. A 113-minute gap (real case
 * rec-282: logged out 16:47, back 18:40) breaks presence, so a cover inside it earns no credit.
 */
function presenceBlocks(punches: CMSPunch[]): { start: Date; end: Date }[] {
  const oneMin = 60000;
  return unionIntervals(punches
    .filter(p => p.LoginDateTime && p.LogoutDateTime)
    .map(p => ({
      start: new Date(Math.floor(p.LoginDateTime.getTime() / oneMin) * oneMin),
      end: new Date(Math.ceil(p.LogoutDateTime!.getTime() / oneMin) * oneMin),
    })));
}

/**
 * WP1 (D1/D2) — minutes of the late-logout window `[windowStart, windowEnd]` that were spent
 * working a COVER and are proven attended. Those minutes are make-up time the agent owed and was
 * scheduled to work, so they must not ALSO be charged as late logout (owner-confirmed: the same
 * minutes may never count both as earned COVER and as chargeable late logout).
 *
 * `covers` may come from a COVER placed this run for this incident AND from any COVER already in
 * ASPECT — whichever incident it belongs to, working it is repayment, not unauthorised extra time.
 * They are unioned first so a cover present in both places is counted once. Only minutes that are
 * inside a cover AND inside the window AND inside `presence` are credited. Never negative.
 */
function creditedCoverMinutes(
  covers: { start: Date; end: Date }[],
  windowStart: Date,
  windowEnd: Date,
  presence: { start: Date; end: Date }[],
): number {
  const ws = windowStart.getTime();
  const we = windowEnd.getTime();
  if (!(we > ws)) return 0;
  const clipped = unionIntervals(covers).map(c => ({ start: Math.max(c.start.getTime(), ws), end: Math.min(c.end.getTime(), we) }));
  let creditedMs = 0;
  for (const c of clipped) {
    if (c.end <= c.start) continue;
    for (const p of presence) {
      const s = Math.max(c.start, p.start.getTime());
      const e = Math.min(c.end, p.end.getTime());
      if (e > s) creditedMs += e - s;
    }
  }
  return Math.floor(creditedMs / 60000);
}

/**
 * WP5/B5/B15 — minutes of `[start, end]` NOT covered by `intervals` (e.g. a day's
 * technical segments). Mirrors creditedCoverMinutes' clip-and-sum shape, inverted:
 * that function sums what IS covered inside a window; this sums what is left over.
 */
function uncoveredMinutes(start: Date, end: Date, intervals: { start: Date; end: Date }[]): number {
  const s = start.getTime();
  const e = end.getTime();
  if (!(e > s)) return 0;
  const merged = unionIntervals(intervals).map(i => ({ start: Math.max(i.start.getTime(), s), end: Math.min(i.end.getTime(), e) }));
  let coveredMs = 0;
  for (const m of merged) {
    if (m.end > m.start) coveredMs += m.end - m.start;
  }
  return Math.max(0, Math.ceil((e - s - coveredMs) / 60000));
}

/** Interval extraction from ASPECT segments (start/stop timestamps) — segments without
 * both are skipped. Despite the name, this is code-agnostic: it just parses whatever
 * segments it is given. Originally COVER-only (WP1/D1/D2); WP5/B5/B15 reuses it
 * unchanged for the technical-segment coverage check — do not fork it. */
function coverIntervalsFromSegments(segments: AspectSegment[]): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  for (const s of segments) {
    const a = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
    const b = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
    if (a && b && b.getTime() > a.getTime()) out.push({ start: a, end: b });
  }
  return out;
}

/** COVER intervals from correction rows this run generated (SegmentDate + SegmentStarttime + HH:MM duration). */
function coverIntervalsFromCorrections(corrections: AspectCorrectionRow[]): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  for (const c of corrections) {
    if (c.SegmentCode !== 'COVER' || !c.SegmentDate || !c.SegmentStarttime || !c.Segmentduration) continue;
    const start = parseDateTimeString(`${c.SegmentDate} ${c.SegmentStarttime}:00`);
    const m = /^(\d+):(\d{2})$/.exec(c.Segmentduration);
    if (!start || !m) continue;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (minutes > 0) out.push({ start, end: new Date(start.getTime() + minutes * 60000) });
  }
  return out;
}

/** Subtract a set of already-merged, non-overlapping `cuts` from `base`,
 * returning the remaining pieces of `base` in chronological order. Used to
 * find what's left of an OT segment once its released (RLS-covered) windows
 * are removed — the released windows themselves can sit at the front, the
 * back, in the middle, or span the whole segment. */
function subtractIntervals(base: { start: Date; end: Date }, cuts: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  const result: { start: Date; end: Date }[] = [];
  let cursor = base.start.getTime();
  const baseEnd = base.end.getTime();
  const sortedCuts = [...cuts].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const cut of sortedCuts) {
    const cutStart = Math.max(cut.start.getTime(), base.start.getTime());
    const cutEnd = Math.min(cut.end.getTime(), baseEnd);
    if (cutEnd <= cutStart) continue;
    if (cutStart > cursor) result.push({ start: new Date(cursor), end: new Date(cutStart) });
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < baseEnd) result.push({ start: new Date(cursor), end: new Date(baseEnd) });
  return result;
}

function evaluateRlsOtAdjustment(
  ot1Segments: AspectSegment[], ot2Segments: AspectSegment[], removalSegments: AspectSegment[],
  tier: RoleTier, config: ConfigRegistry
): RlsOtAdjustmentFinding[] {
  const rlsOtRule = lookupPolicyRule(config, 'RLS segment added to OT with no adjustment', tier, 0);
  if (rlsOtRule && rlsOtRule.action === 'NO_ACTION') return [];
  const findings: RlsOtAdjustmentFinding[] = [];
  [...ot1Segments, ...ot2Segments].forEach(otSeg => {
    const parsedOtStart = otSeg.START_MOMENT ? parseDateTimeString(otSeg.START_MOMENT) : null;
    const parsedOtEnd = otSeg.STOP_MOMENT ? parseDateTimeString(otSeg.STOP_MOMENT) : null;
    if (!parsedOtStart || !parsedOtEnd) return;
    const otStart = truncateToMinute(parsedOtStart);
    const otEnd = truncateToMinute(parsedOtEnd);
    const overlapIntervals: { start: Date; end: Date }[] = [];
    removalSegments.forEach(rls => {
      if (rls.SEG_CODE === 'NURSNG') return;
      const parsedRStart = rls.START_MOMENT ? parseDateTimeString(rls.START_MOMENT) : null;
      const parsedREnd = rls.STOP_MOMENT ? parseDateTimeString(rls.STOP_MOMENT) : null;
      if (!parsedRStart || !parsedREnd) return;
      const rStart = truncateToMinute(parsedRStart);
      const rEnd = truncateToMinute(parsedREnd);
      const s = Math.max(rStart.getTime(), otStart.getTime());
      const e = Math.min(rEnd.getTime(), otEnd.getTime());
      if (e > s) overlapIntervals.push({ start: new Date(s), end: new Date(e) });
    });
    const mergedOverlapIntervals = unionIntervals(overlapIntervals);
    if (mergedOverlapIntervals.length === 0) return;
    const otDuration = otSeg.DURATION ?? Math.floor((otEnd.getTime() - otStart.getTime()) / 60000);
    findings.push({ otSeg, otStart, otEnd, otDuration, mergedOverlapIntervals });
  });
  return findings;
}

/** R2 fix: the three call sites (flex Branch A, flex Branch B, standard) previously
 * each carried their own copy-pasted correction-emission logic for both Rule 7 and
 * Rule 8 — only the finding-evaluation math (evaluateCoverNotAttended/
 * evaluateRlsOtAdjustment above) had been shared. Three live copies of the same
 * business logic is exactly how R1 (raw, un-normalized START_DATE reaching the
 * exported SegmentDate) and R3 (Rule 8's adjustment incrementing the wrong summary
 * counter) happened — a fix applied to one copy silently didn't apply to the other
 * two. These two builders are now the ONLY place that turns a finding into an
 * AspectCorrectionRow; every call site applies the returned outcome the same way. */
/** R6 fix: F09's fix only special-cased `noLoginRule.action === 'NO_ACTION'` and
 * otherwise hardcoded ABSENT_NS_NC regardless of what else the dropdown might say —
 * ConfigRegistryView.tsx renders every TaaActionCode as a selectable action for
 * every rule, so an administrator choosing, say, LATE_AND_COVER for "No Login
 * Record" (which has no punch to measure a variance from — that action cannot be
 * executed for a no-login case) still silently got ABSENT_NS_NC with no
 * indication their choice was ignored. Now: NO_ACTION and ABSENT_NS_NC behave as
 * before; MANUAL_REVIEW_REQUIRED holds the row instead of auto-absenting; any
 * other configured action is one the engine cannot execute for this rule, so it
 * holds as an invalid config value rather than guessing. Shared by both the flex
 * and standard no-login branches so they can never diverge on this decision. */
export interface NoLoginDecision {
  verdict: string;
  action: TaaActionCode;
  resultCategory: TaaResultCategory;
  disagreeReason: string;
  ruleFired: string;
  communicationRule: CommunicationRule;
  markAbsent: boolean;
  holdReason?: HoldReasonCode;
}

export function resolveNoLoginDecision(noLoginRule: PolicyRuleItem | undefined, contextLabel: string): NoLoginDecision {
  const configuredAction = noLoginRule?.action;
  const communicationRule = noLoginRule?.communication || 'NA';

  if (configuredAction === 'NO_ACTION') {
    return {
      verdict: 'PRESENT', action: 'NO_ACTION', resultCategory: 'NO_ACTION_REQUIRED', disagreeReason: 'MATCH',
      ruleFired: `${contextLabel}No login recorded, but "No Login Record" is configured to NO_ACTION`,
      communicationRule: 'NA', markAbsent: false,
    };
  }
  if (configuredAction === 'MANUAL_REVIEW_REQUIRED') {
    return {
      verdict: 'NO_SHOW', action: 'MANUAL_REVIEW_REQUIRED', resultCategory: 'COGNOS_DATA_GAP', disagreeReason: 'NO_CMS_PUNCHES',
      ruleFired: `${contextLabel}No login recorded; "No Login Record" is configured to MANUAL_REVIEW_REQUIRED — held instead of auto-marked absent`,
      communicationRule, markAbsent: false, holdReason: 'NO_LOGIN_MANUAL_REVIEW_CONFIGURED',
    };
  }
  if (configuredAction && configuredAction !== 'ABSENT_NS_NC') {
    return {
      verdict: 'NO_SHOW', action: 'MANUAL_REVIEW_REQUIRED', resultCategory: 'COGNOS_DATA_GAP', disagreeReason: 'NO_CMS_PUNCHES',
      ruleFired: `${contextLabel}No login recorded; "No Login Record" is configured to ${configuredAction}, which this rule cannot execute — held for manual review`,
      communicationRule, markAbsent: false, holdReason: 'INVALID_CONFIG_VALUE',
    };
  }
  return {
    verdict: 'NO_SHOW', action: 'ABSENT_NS_NC', resultCategory: 'MARKED_ABSENT', disagreeReason: 'NO_CMS_PUNCHES',
    ruleFired: `${contextLabel}No login recorded`, communicationRule, markAbsent: true,
  };
}

interface CoverNotAttendedOutcome {
  varianceMeasurement: VarianceTrace['measurements'][number];
  ruleNote: string;
  correction: AspectCorrectionRow | null;
  actionCode: 'LATE_AND_COVER' | 'ABSENT_SEGMENT';
  chargedVarianceMinDelta: number;
  isAbsent: boolean;
  resultCategory: TaaResultCategory;
  communicationRule: CommunicationRule;
  emailTemplateKey: EmailTemplateKey;
  /** Set only when config.coverNotAttendedAction === 'moveCoverForward' and the
   * target day couldn't safely take the moved cover — the caller must hold the row
   * instead of applying the (absent) correction/severity fields above. */
  holdReason?: HoldReasonCode;
  /** WP5/B5/B15 — the unattended part(s) of the cover window, i.e. the actual gap(s)
   * this finding is charging: [covStart, actualFirstLoginDt] when login is after
   * covStart, and [actualLastLogoutDt, covEnd] when logout is before covEnd. Each kept
   * only when it has positive duration. Deliberately NOT covStart..covEnd (the whole
   * scheduled window, which is what varianceMeasurement's anchor/comparedTo show) —
   * that would require a technical segment to cover attended time too. */
  varianceIntervals: { label: 'COVER_NOT_ATTENDED'; start: Date; end: Date }[];
}

function buildCoverNotAttendedOutcomes(
  findings: CoverNotAttendedFinding[],
  params: {
    tier: RoleTier;
    tierLabel: string; // '' for standard rows, ' FLEX' for flex rows — display only
    referenceDay: Date | null;
    pfNo: string;
    nomDateStr: string;
    config: ConfigRegistry;
    segmentsByEmp: Map<string, AspectSegment[]>;
    placedCoversThisRun: Map<string, { start: Date; end: Date; duration: number }[]>;
    /** WP2/D5/B8: the moveCoverForward branch below re-places an unattended cover on a
     * NEW day the agent hasn't worked yet — a newly assigned cover in every sense the
     * run-date floor cares about, so it must respect the floor exactly like the other
     * placeCoverSegment call sites. */
    processingDate: Date;
    /** Reduced office hours: threaded into the moveCoverForward re-placement so the new
     * cover date also excludes the configured weekday, same as every other cover site. */
    reducedHoursCoverExcluded?: boolean;
  },
): CoverNotAttendedOutcome[] {
  const { tier, tierLabel, referenceDay, pfNo, nomDateStr, config, segmentsByEmp, placedCoversThisRun, processingDate } = params;
  const reducedHoursCoverExcluded = params.reducedHoursCoverExcluded ?? false;
  return findings.map(finding => {
    const { covStart, covEnd, overlapMinutes, coverDurationMinutes, shortfallMinutes, rule: coverRule, actualFirstLoginDt, actualLastLogoutDt } = finding;
    const varianceMeasurement = traceMeasurement(
      'COVER_NOT_ATTENDED',
      `COVER segment ${formatTimeQualified(covStart, referenceDay)}-${formatTimeQualified(covEnd, referenceDay)} (${coverDurationMinutes}m scheduled, ${overlapMinutes}m attended)`,
      covStart, covEnd, shortfallMinutes, coverRule, referenceDay,
    );
    const ruleNote = `Cover Not Attended (${tier}${tierLabel}): ${shortfallMinutes}m unattended -> ${coverRule.actionText}`;
    // WP5/B5/B15 — the unattended gap(s), not the whole scheduled cover window.
    const varianceIntervals: CoverNotAttendedOutcome['varianceIntervals'] = [];
    if (actualFirstLoginDt.getTime() > covStart.getTime()) {
      const end = actualFirstLoginDt.getTime() < covEnd.getTime() ? actualFirstLoginDt : covEnd;
      if (end.getTime() > covStart.getTime()) varianceIntervals.push({ label: 'COVER_NOT_ATTENDED', start: covStart, end });
    }
    if (actualLastLogoutDt.getTime() < covEnd.getTime()) {
      const start = actualLastLogoutDt.getTime() > covStart.getTime() ? actualLastLogoutDt : covStart;
      if (covEnd.getTime() > start.getTime()) varianceIntervals.push({ label: 'COVER_NOT_ATTENDED', start, end: covEnd });
    }

    if (config.coverNotAttendedAction === 'moveCoverForward') {
      const moved = placeCoverSegment(pfNo, nomDateStr, coverDurationMinutes, segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, processingDate, reducedHoursCoverExcluded);
      if (moved) {
        // Preserve any fallback note placeCoverSegment already attached — this branch
        // used to overwrite Memo wholesale, silently dropping "placed without ASPECT
        // data" traceability for a re-placed cover. coverFallbackByRow still has the
        // entry (keyed by this same row object) even though Memo is being rewritten.
        const fallbackOption = coverFallbackByRow.get(moved);
        moved.Memo = `TAA Cover Not Attended: moved forward (was ${formatDateDDMMYYYY(covStart)} ${formatTimeHHMM(covStart)})${fallbackOption ? ` | ${describeCoverFallback(fallbackOption, config)}` : ''}`;
        return {
          varianceMeasurement, ruleNote, correction: moved, actionCode: 'LATE_AND_COVER', chargedVarianceMinDelta: shortfallMinutes,
          isAbsent: false, resultCategory: 'LATE_AND_COVER_ADDED', communicationRule: coverRule.communication, emailTemplateKey: 'cover_not_attended', varianceIntervals,
        };
      }
      return {
        varianceMeasurement, ruleNote, correction: null, actionCode: 'LATE_AND_COVER', chargedVarianceMinDelta: shortfallMinutes,
        isAbsent: false, resultCategory: 'LATE_AND_COVER_ADDED', communicationRule: coverRule.communication, emailTemplateKey: 'cover_not_attended',
        holdReason: describeCoverPlacementFailure(nomDateStr, segmentsByEmp.get(pfNo) || [], config, processingDate, reducedHoursCoverExcluded), varianceIntervals,
      };
    }

    return {
      varianceMeasurement, ruleNote, actionCode: 'ABSENT_SEGMENT', chargedVarianceMinDelta: shortfallMinutes,
      isAbsent: true, resultCategory: 'MARKED_ABSENT', communicationRule: coverRule.communication, emailTemplateKey: 'cover_not_attended', varianceIntervals,
      correction: {
        Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
        SegmentStarttime: '', Segmentduration: '', Memo: `TAA Cover Not Attended ${shortfallMinutes}m`,
      },
    };
  });
}

interface RlsOtAdjustmentOutcome {
  ruleNote: string;
  originalCorrection: AspectCorrectionRow;
  adjustedCorrection: AspectCorrectionRow;
  /** A release sitting in the MIDDLE of the OT segment leaves TWO surviving
   * OT pieces (one before the release, one after). adjustedCorrection always
   * carries the first surviving piece; any further pieces land here as plain
   * Code 00 inserts under the same OT code. Empty on full overlap and on the
   * (overwhelmingly common) case of exactly one surviving piece. */
  extraOtRows: AspectCorrectionRow[];
  /** Code 00 insert(s) recoding the RLS-released portion of the OT segment to
   * SHIFT — one per released window. Empty on full overlap: in that case
   * adjustedCorrection itself already carries the full duration re-typed to
   * SHIFT (see buildRlsOtAdjustmentOutcomes below), so a separate insert
   * would double-pay the released hour. */
  shiftInsertRows: AspectCorrectionRow[];
}

/**
 * Rule 8 (RLS added to OT with no adjustment) - user-confirmed 2026-09-15:
 * an OT segment overlapped by a release must never be "corrected" by simply
 * shrinking its duration while leaving the shrunk row at the OT segment's
 * OWN original start time -- that assumes the release always sits at the
 * trailing edge, which silently double-pays or drops time when it does not
 * (a leading or mid-segment release, both real ASPECT shapes even though
 * unseen in the sample data). It must also never produce a 10/11 pair whose
 * new row carries 00:00 duration, which ASPECT rejects outright.
 *
 * The OT segment's own [otStart, otEnd) window has each released window
 * (RLS/UN_RLS overlap, rounded to the segment-update grid -- see below) CUT
 * OUT of it via subtractIntervals(). What is left is 0, 1, or 2 pieces:
 *   - 0 pieces (full overlap): the pair's "new" row keeps the segment's FULL
 *     original duration but swaps SegmentCode to otToShiftConversionCode --
 *     the whole segment is re-typed, never shrunk to a zero-duration row.
 *   - 1 piece (release at the front or back -- the only shape seen in real
 *     data so far): the pair's "new" row IS that surviving piece, at ITS OWN
 *     start time (not necessarily the segment's original start -- a 10/11
 *     pair with a different start is an accepted ASPECT shape, the same one
 *     the flex shift-update pair above already uses).
 *   - 2 pieces (release in the middle, user-confirmed 2026-09-15 -- untested
 *     in real data): the pair's "new" row is the first piece; the second
 *     piece becomes a plain Code 00 insert under the same OT code.
 * Each released window becomes its own separate Code 00 SHIFT insert,
 * clamped to the OT segment's own span (never the RLS segment's full window,
 * which can extend into the already-scheduled SHIFT and double-count time if
 * mirrored wholesale).
 *
 * Rounding (config.segmentUpdateRoundingGridMinutes /
 * segmentUpdateRoundingDirection -- a separate knob from the flex late-
 * arrival rounding above: Shift/RLS/OT segment updates round, Late/Cover
 * never do) widens or narrows each released window's OWN edges via
 * snapTimeToGrid before the subtraction -- "up" widens (start snapped down,
 * end snapped up), "down" narrows, "nearest" snaps both -- then clamps to the
 * OT segment's span. This must snap the release's edges, not the OT row's
 * shrunk duration in place: rounding a duration while keeping the original
 * start (the pre-fix approach) reintroduces the same double-pay/gap bug this
 * rewrite exists to close, just at a different threshold.
 *
 * `dayAlreadyMarkedAbsent` (true when an earlier rule this row already fired
 * marked the whole day Absent, e.g. Late Logout/Early Logout/Cover Not
 * Attended -- all three run before this call at every one of the three call
 * sites) skips this rule ENTIRELY (decision 2026-09-15): convertOtSegmentsToShift
 * (Section 4.6c) already unconditionally retires EVERY OT1/OT2 segment on an
 * Absent day via its own 10/11 replace pair, at the segment's own full original
 * duration, regardless of any RLS overlap. Letting this rule also fire would
 * draft a SECOND, conflicting 10/11 pair against the same OT segment -- one
 * shortening it (Rule 8's own adjustment), one retiring it outright (§4.6c) --
 * which is exactly the "duplicated/re-changed segment" shape ASPECT rejects the
 * whole upload for. See BR-04 in scripts/validate40.ts, which pins the exact
 * 5-row correction set for an Absent day with two RLS-overlapped OT segments
 * (no ADJUST_OT_RLS, only the two §4.6c pairs).
 */
function buildRlsOtAdjustmentOutcomes(
  findings: RlsOtAdjustmentFinding[], pfNo: string, nomDateStr: string, config: ConfigRegistry, dayAlreadyMarkedAbsent: boolean,
): RlsOtAdjustmentOutcome[] {
  // §4.6c already retires every OT segment on an Absent day (see doc comment
  // above) -- never draft a second, conflicting 10/11 pair here.
  if (dayAlreadyMarkedAbsent) return [];
  return findings.flatMap(finding => {
    const { otSeg, otStart, otEnd, otDuration, mergedOverlapIntervals } = finding;
    // R1 fix: every other correction-emission site in this file derives SegmentDate
    // from the segment's own real Date instant via formatSegmentDate() -- the PHYSICAL
    // calendar day the event happened on (doc/aspect.md Section 2's field-4-vs-field-5
    // distinction), never a raw, un-normalized CSV string. This site used to read
    // `otSeg.START_DATE || nomDateStr` directly: START_DATE is stored by parsers.ts
    // exactly as the ASPECT export wrote it (e.g. un-padded "1/9/2026"), so an
    // un-padded export reached the ASPECT upload file un-normalized. otStart is
    // already the parsed, truncated-to-minute Date this OT segment's own
    // START_MOMENT resolved to, so deriving the date from it is strictly correct
    // and needs no fallback to nomDateStr.
    const physicalDate = formatSegmentDate(otStart);
    const windowMinutes = (w: { start: Date; end: Date }) => Math.floor((w.end.getTime() - w.start.getTime()) / 60000);
    const windowLabel = (w: { start: Date; end: Date }) => `${formatTimeHHMM(w.start)}-${formatTimeHHMM(w.end)}`;

    // Widen (direction "up") or narrow ("down") each released window's own
    // edges to the grid -- never round a duration held at a fixed start, or
    // the same class of bug this rewrite closes reappears at a new
    // threshold. "nearest" snaps both edges to their own nearest gridline.
    const startDir = config.segmentUpdateRoundingDirection === 'up' ? 'down' : config.segmentUpdateRoundingDirection === 'down' ? 'up' : 'nearest';
    const endDir = config.segmentUpdateRoundingDirection;
    const releasedWindows = unionIntervals(
      mergedOverlapIntervals
        .map(interval => ({
          start: new Date(Math.max(snapTimeToGrid(interval.start, config.segmentUpdateRoundingGridMinutes, startDir).getTime(), otStart.getTime())),
          end: new Date(Math.min(snapTimeToGrid(interval.end, config.segmentUpdateRoundingGridMinutes, endDir).getTime(), otEnd.getTime())),
        }))
        .filter(w => w.end.getTime() > w.start.getTime())
    );
    if (releasedWindows.length === 0) return [];

    const remainingOtWindows = subtractIntervals({ start: otStart, end: otEnd }, releasedWindows);

    const originalCorrection: AspectCorrectionRow = {
      Code: config.shiftUpdateOriginalCode, ID: pfNo, SegmentCode: otSeg.SEG_CODE, nominateDate: nomDateStr, SegmentDate: physicalDate,
      SegmentStarttime: formatTimeHHMM(otStart), Segmentduration: formatMinutesToHHMM(otDuration), Memo: 'TAA Original OT before RLS adjustment',
    };

    if (remainingOtWindows.length > 0) {
      // Partial overlap (leading, trailing, or middle -- one or more OT
      // pieces survive): the pair's "new" row IS the first surviving piece,
      // at its own start/duration. Any FURTHER surviving piece (a
      // mid-segment release) becomes a separate Code 00 insert under the
      // same OT code. Each released window becomes a separate Code 00 SHIFT
      // insert. (The day is never already-Absent here -- see the function's
      // top-level guard above.)
      const [firstRemaining, ...restRemaining] = remainingOtWindows;
      const adjustedCorrection: AspectCorrectionRow = {
        Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: otSeg.SEG_CODE, nominateDate: nomDateStr, SegmentDate: formatSegmentDate(firstRemaining.start),
        SegmentStarttime: formatTimeHHMM(firstRemaining.start), Segmentduration: formatMinutesToHHMM(windowMinutes(firstRemaining)), Memo: 'TAA OT adjusted for overlapping RLS',
      };
      const extraOtRows: AspectCorrectionRow[] = restRemaining.map(w => ({
        Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: otSeg.SEG_CODE, nominateDate: nomDateStr,
        SegmentDate: formatSegmentDate(w.start), SegmentStarttime: formatTimeHHMM(w.start), Segmentduration: formatMinutesToHHMM(windowMinutes(w)),
        Memo: `TAA OT segment ${otSeg.SEG_CODE} remainder after RLS split`,
      }));
      const shiftInsertRows: AspectCorrectionRow[] = releasedWindows.map(w => ({
        Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: config.otToShiftConversionCode, nominateDate: nomDateStr,
        SegmentDate: formatSegmentDate(w.start), SegmentStarttime: formatTimeHHMM(w.start), Segmentduration: formatMinutesToHHMM(windowMinutes(w)),
        Memo: `TAA RLS-released ${otSeg.SEG_CODE} time converted to ${config.otToShiftConversionCode}`,
      }));
      return [{
        ruleNote: `RLS added to OT: ${otSeg.SEG_CODE} kept ${remainingOtWindows.map(windowLabel).join(', ')}; ${releasedWindows.map(windowLabel).join(', ')} converted to ${config.otToShiftConversionCode}`,
        originalCorrection, adjustedCorrection, extraOtRows, shiftInsertRows,
      }];
    }

    // Full overlap (released windows consume the whole OT segment). The day is
    // never already-Absent here -- see the function's top-level guard above.
    // Otherwise: the pair's "new" row keeps the FULL original duration but
    // is re-typed to SHIFT -- never a bare 00:00 duration row, which ASPECT
    // rejects. No separate insert: this row already covers the released time.
    const adjustedCorrection: AspectCorrectionRow = {
      Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: config.otToShiftConversionCode, nominateDate: nomDateStr, SegmentDate: physicalDate,
      SegmentStarttime: formatTimeHHMM(otStart), Segmentduration: formatMinutesToHHMM(otDuration),
      Memo: `TAA ${otSeg.SEG_CODE} fully released by RLS -- converted to ${config.otToShiftConversionCode}`,
    };
    return [{
      ruleNote: `RLS added to OT: ${otSeg.SEG_CODE} fully released -- converted to ${config.otToShiftConversionCode}`,
      originalCorrection, adjustedCorrection, extraOtRows: [], shiftInsertRows: [],
    }];
  });
}

/**
 * Shared early-logout / late-logout evaluation, used both by the standard
 * non-flex path's downstream check and — critically, previously missing
 * entirely for late-arriving flex staff (audit finding) — by both flex
 * branches after their shift-update clamps the end time.
 */
function evaluateEarlyAndLateLogout(params: {
  effectiveEndDt: Date;
  /** Kept for reporting only. Late Logout is measured from effectiveEndDt (see below). */
  rawEndDt: Date;
  actualLastLogoutDt: Date | null;
  tier: RoleTier;
  config: ConfigRegistry;
  pfNo: string;
  nomDateStr: string;
  segmentsByEmp: Map<string, AspectSegment[]>;
  placedCoversThisRun: Map<string, { start: Date; end: Date; duration: number }[]>;
  /** WP1: COVER intervals that may be credited against late logout (ASPECT covers + covers this run placed). */
  creditableCovers?: { start: Date; end: Date }[];
  /** WP1: proven continuous attendance blocks (see presenceBlocks). Without these no credit is given.
   * WP2/D10: also reused as the presence evidence for the early-logout same-day-cover check
   * below, instead of re-threading punches a second time — same blocks, same B6 standard. */
  presence?: { start: Date; end: Date }[];
  /** WP2/D5/B8: threaded through to placeCoverSegment/describeCoverPlacementFailure below. */
  processingDate: Date;
  /** WP2/D10: needed for the early-logout branch's tryPlaceSameDayCover 'beforeStart' check
   * (mirrors the standard path's early-logout site) — this function previously called
   * placeCoverSegment directly, bypassing same-day placement entirely. */
  actualFirstLoginDt: Date | null;
  effectiveStartDt: Date | null;
  /** Reduced-office-hours early-logout target. Defaults to effectiveEndDt. Late logout never uses it. */
  earlyCheckEndDt?: Date;
  /** Passed through to cover placement. */
  reducedHoursCoverExcluded?: boolean;
}): DownstreamResult | null {
  const {
    effectiveEndDt, rawEndDt, actualLastLogoutDt, tier, config, pfNo, nomDateStr, segmentsByEmp, placedCoversThisRun, processingDate,
    actualFirstLoginDt, effectiveStartDt,
  } = params;
  if (!actualLastLogoutDt) return null;

  const earlyAnchorDt = params.earlyCheckEndDt ?? effectiveEndDt;
  let earlyMin = 0;
  if (actualLastLogoutDt.getTime() < earlyAnchorDt.getTime()) earlyMin = diffInMinutes(actualLastLogoutDt, earlyAnchorDt);
  let lateLogoutMin = 0;
  // Anchor fix: this helper measured Late Logout from rawEndDt while the standard non-flex
  // path measured it from effectiveEndDt — the same rule, two different answers, differing
  // by exactly the release/nursing minutes. The divergence was masked only because the two
  // flex callers happen to pass the same Date for both parameters. Confirmed policy is the
  // release-adjusted (effective) end, so both paths now use it.
  let lateLogoutCreditNote = '';
  let lateLogoutCreditedMin = 0;
  if (actualLastLogoutDt.getTime() > effectiveEndDt.getTime()) {
    const grossMin = diffInMinutes(effectiveEndDt, actualLastLogoutDt);
    // WP1 (D1/D2): same credit as the standard branch — attended cover time is make-up time, never
    // also chargeable late logout. Only the remainder meets the configured band.
    const creditedMin = params.creditableCovers && params.presence
      ? creditedCoverMinutes(params.creditableCovers, effectiveEndDt, actualLastLogoutDt, params.presence)
      : 0;
    lateLogoutMin = Math.max(0, grossMin - creditedMin);
    lateLogoutCreditedMin = creditedMin;
    if (creditedMin > 0) lateLogoutCreditNote = `${grossMin}m gross - ${creditedMin}m attended cover credited = ${lateLogoutMin}m remaining`;
  }

  const lookupRule = (segmentType: string, minutes: number): PolicyRuleItem | undefined =>
    lookupPolicyRule(config, segmentType, tier, minutes);

  const rowCorrections: AspectCorrectionRow[] = [];

  if (earlyMin > 0) {
    const rule = lookupRule('Early Logout', earlyMin);
    if (rule && rule.action !== 'NO_ACTION') {
      if (rule.action === 'LOGOFF_AND_COVER') {
        // "Already actioned" rule (see findAlreadyRecordedIncident): no Log_off, no COVER.
        // Returned as NO_ACTION_REQUIRED so callers never fire an action for it; infoNote
        // carries the explanation into the row's trace.
        const recordedLogoff = findAlreadyRecordedIncident(segmentsByEmp.get(pfNo) || [], nomDateStr, 'Log_off', earlyMin);
        if (recordedLogoff) {
          return { verdict: 'EARLY_LOGOUT', action: 'NO_ACTION', resultCategory: 'NO_ACTION_REQUIRED', ruleFired: 'No downstream early/late-logout action', chargedVarianceMin: 0, communicationRule: 'NA', emailTemplateKey: 'generic', rowCorrections: [], earlyMin, lateLogoutMin, lateLogoutCreditedMin, infoNote: `${rule.segmentType} (${tier}): ${earlyMin}m -> ${recordedLogoff.note}` };
        }
        rowCorrections.push({
          Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'Log_off', nominateDate: nomDateStr, SegmentDate: formatSegmentDate(actualLastLogoutDt),
          SegmentStarttime: formatTimeHHMM(actualLastLogoutDt), Segmentduration: formatMinutesToHHMM(earlyMin), Memo: `TAA Early Logout ${earlyMin}m`,
        });
        // WP2/D10 fix: previously called placeCoverSegment directly here, bypassing
        // same-day cover placement entirely — the only one of the four early/late-logout
        // sites that did. Now tries same-day first, exactly like the standard path's own
        // early-logout site, falling through to the normal next-working-day search when
        // it doesn't apply.
        const cover = tryPlaceSameDayCover(
          pfNo, nomDateStr, earlyMin, 'beforeStart',
          { firstLoginDt: actualFirstLoginDt, lastLogoutDt: actualLastLogoutDt, effectiveStartDt, shiftEndDt: earlyAnchorDt },
          segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, params.presence || [], params.reducedHoursCoverExcluded ?? false,
        ) ?? placeCoverSegment(pfNo, nomDateStr, earlyMin, segmentsByEmp.get(pfNo) || [], placedCoversThisRun, config, processingDate, params.reducedHoursCoverExcluded ?? false);
        if (cover) {
          rowCorrections.push(cover);
          return { verdict: 'EARLY_LOGOUT', action: 'LOGOFF_AND_COVER', resultCategory: 'LATE_AND_COVER_ADDED', ruleFired: `${rule.segmentType} (${tier}): ${earlyMin}m -> ${rule.actionText}`, chargedVarianceMin: earlyMin, communicationRule: rule.communication, emailTemplateKey: 'early_logout_absence', rowCorrections, earlyMin, lateLogoutMin, lateLogoutCreditedMin, varianceInterval: { label: 'EARLY_LOGOUT', start: actualLastLogoutDt, end: earlyAnchorDt } };
        }
        const coverBlockReason = describeCoverPlacementFailure(nomDateStr, segmentsByEmp.get(pfNo) || [], config, processingDate, params.reducedHoursCoverExcluded ?? false);
        return { verdict: 'EARLY_LOGOUT', action: 'MANUAL_REVIEW_REQUIRED', resultCategory: 'LATE_AND_COVER_ADDED', ruleFired: `${rule.segmentType} (${tier}): ${earlyMin}m -> ${rule.actionText} (cover target day has a schedule integrity problem: ${coverBlockReason})`, chargedVarianceMin: earlyMin, communicationRule: rule.communication, emailTemplateKey: 'early_logout_absence', rowCorrections, holdReason: coverBlockReason, earlyMin, lateLogoutMin, lateLogoutCreditedMin };
      }
      if (rule.action === 'ABSENT_SEGMENT') {
        rowCorrections.push({
          Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
          SegmentStarttime: '', Segmentduration: '', Memo: `TAA Early Logout ${earlyMin}m Exceeds Threshold`,
        });
        return { verdict: 'ABSENT', action: 'ABSENT_SEGMENT', resultCategory: 'MARKED_ABSENT', ruleFired: `${rule.segmentType} (${tier}): ${earlyMin}m -> ${rule.actionText}`, chargedVarianceMin: earlyMin, communicationRule: rule.communication, emailTemplateKey: 'early_logout_absence', rowCorrections, earlyMin, lateLogoutMin, lateLogoutCreditedMin, varianceInterval: { label: 'EARLY_LOGOUT', start: actualLastLogoutDt, end: earlyAnchorDt } };
      }
    }
  } else if (lateLogoutMin > 0) {
    const rule = lookupRule('Late Logout', lateLogoutMin);
    if (rule && rule.action !== 'NO_ACTION') {
      rowCorrections.push({
        Code: config.aspectNormalActionCode, ID: pfNo, SegmentCode: 'ABSENT', nominateDate: nomDateStr, SegmentDate: '',
        SegmentStarttime: '', Segmentduration: '', Memo: `TAA Late Logout ${lateLogoutMin}m${lateLogoutCreditNote ? ` (${lateLogoutCreditNote})` : ''}`,
      });
      // WP5/B5/B15 — gross window, matching the standard path's own choice (comment above).
      return { verdict: 'ABSENT', action: 'ABSENT_SEGMENT', resultCategory: 'MARKED_ABSENT', ruleFired: `Late Logout (${tier}): ${lateLogoutMin}m past the release-adjusted end ${formatTimeHHMM(effectiveEndDt)} (rostered end ${formatTimeHHMM(rawEndDt)})${lateLogoutCreditNote ? ` [${lateLogoutCreditNote}]` : ''} -> ${rule.actionText}`, chargedVarianceMin: lateLogoutMin, communicationRule: rule.communication, emailTemplateKey: 'late_logout_absence', rowCorrections, earlyMin, lateLogoutMin, lateLogoutCreditedMin, varianceInterval: { label: 'LATE_LOGOUT', start: effectiveEndDt, end: actualLastLogoutDt } };
    }
  }
  return { verdict: 'PRESENT', action: 'NO_ACTION', resultCategory: 'NO_ACTION_REQUIRED', ruleFired: 'No downstream early/late-logout issue', chargedVarianceMin: 0, communicationRule: 'NA', emailTemplateKey: 'generic', rowCorrections: [], earlyMin, lateLogoutMin, lateLogoutCreditedMin };
}

/**
 * Shared by convertOtSegmentsToShift/convertShiftSegmentsToOt2 below: a generated
 * "10"/"11" replacement or OT->SHIFT conversion row previously read only the raw
 * DURATION field (`seg.DURATION != null ? formatMinutesToHHMM(seg.DURATION) : ''`),
 * so a segment with a blank/malformed DURATION but perfectly valid START_MOMENT/
 * STOP_MOMENT timestamps produced a correction row with a BLANK Segmentduration —
 * even though a real duration was derivable. Falls back to the same
 * resolveSegmentMinutes() trust order the rest of the engine uses (DURATION, then
 * timestamps); only stays blank when genuinely neither is available, rather than
 * fabricating the full-day default into an export row.
 */
function resolveConversionRowDuration(seg: AspectSegment, config: ConfigRegistry): string {
  const resolved = resolveSegmentMinutes(seg, config.segmentGlossary, config.defaultFullDaySegmentDurationMinutes ?? 480);
  if (resolved.source === 'DURATION' || resolved.source === 'TIMESTAMPS') return formatMinutesToHHMM(resolved.minutes);
  return '';
}

/**
 * Absent + OT Co-occurrence (§4.6c, replace-pair decision 2026-09-15): whenever an
 * Absent action is added for a day, any OT1/OT2 segments scheduled that day must not
 * survive as OT in ASPECT — each is explicitly retired and replaced with SHIFT via a
 * shiftUpdateOriginalCode/shiftUpdateNewCode ("10"/"11") pair, the same replace
 * mechanism §4.6e (below) uses in reverse. Row "10" carries the segment exactly as it
 * exists (SegmentCode: seg.SEG_CODE, i.e. OT1 or OT2); row "11" carries the identical
 * SegmentDate/SegmentStarttime/Segmentduration with SegmentCode swapped to
 * otToShiftConversionCode. Unlike §4.6e, this pair is NOT held for reviewer approval —
 * the day is already marked Absent and pays zero regardless of which code the segment
 * carries, so there is no over-payment risk an insert-only approach would have avoided
 * either; the replace shape exists purely so ASPECT no longer shows OT on an Absent
 * day, not to gate payroll risk. SegmentDate uses the segment's own physical
 * START_DATE (which can differ from NOM_DATE for a post-midnight OT tail), not the
 * shift day — see doc/aspect.md §2's field-4-vs-field-5 distinction. Rule 8
 * (buildRlsOtAdjustmentOutcomes) is skipped entirely on an Absent day so it never
 * drafts a second, conflicting 10/11 pair on the same OT segment — see its own guard.
 */
function convertOtSegmentsToShift(
  ot1Segments: AspectSegment[], ot2Segments: AspectSegment[], pfNo: string, nomDateStr: string,
  rowCorrections: AspectCorrectionRow[], config: ConfigRegistry
): number {
  const otSegments = [...ot1Segments, ...ot2Segments];
  for (const seg of otSegments) {
    const segStartDt = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
    // R1 fix: derive SegmentDate from the segment's own parsed START_MOMENT via
    // formatSegmentDate() — the physical calendar day the event happened on — rather
    // than the raw, un-normalized ASPECT START_DATE CSV text (parsers.ts stores it
    // exactly as exported, e.g. un-padded "1/9/2026"). Only fall back to nomDateStr
    // when the segment carries no usable START_MOMENT at all.
    const segmentDate = segStartDt ? formatSegmentDate(segStartDt) : nomDateStr;
    const segmentStarttime = segStartDt ? formatTimeHHMM(segStartDt) : '';
    const segmentDuration = resolveConversionRowDuration(seg, config);
    rowCorrections.push({
      Code: config.shiftUpdateOriginalCode, ID: pfNo, SegmentCode: seg.SEG_CODE, nominateDate: nomDateStr,
      SegmentDate: segmentDate, SegmentStarttime: segmentStarttime,
      Segmentduration: segmentDuration, Memo: `TAA Absent Day: original ${seg.SEG_CODE} segment being replaced by ${config.otToShiftConversionCode}`,
    });
    rowCorrections.push({
      Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: config.otToShiftConversionCode, nominateDate: nomDateStr,
      SegmentDate: segmentDate, SegmentStarttime: segmentStarttime,
      Segmentduration: segmentDuration, Memo: `TAA Absent Day: ${seg.SEG_CODE} segment converted to ${config.otToShiftConversionCode}`,
    });
  }
  return otSegments.length;
}

/**
 * Public-holiday SHIFT miscoding (decision 2026-09-12, mirror of §4.6c /
 * convertOtSegmentsToShift above, reversed): a day whose leave segments are ALL a
 * configured public-holiday-overtime leave code (default P/H-LV) but whose worked
 * (Addition) segments are ALL SHIFT means staff was mistakenly scheduled as a
 * normal shift on a public-holiday-leave day, instead of the OT2 the PRD documents
 * for holiday overtime. Like convertOtSegmentsToShift above, this emits a
 * shiftUpdateOriginalCode/shiftUpdateNewCode ("10"/"11") replace pair per SHIFT
 * segment — the original SHIFT is explicitly retired, not left duplicated
 * alongside the new OT2 (an insert-only approach would leave the day carrying both,
 * double-counting hours on the pay-adding side). Both rows in the pair share the
 * same SegmentDate/SegmentStarttime/Segmentduration; only the Code/SegmentCode
 * differ. SegmentDate uses the segment's own physical START_DATE (can differ from
 * NOM_DATE for a post-midnight SHIFT tail), not the shift day — see
 * convertOtSegmentsToShift's own comment / doc/aspect.md §2's field-4-vs-field-5
 * distinction. Unlike the OT2 exemption this mirrors, the caller does NOT skip the
 * hold: this is a genuine scheduling mistake being auto-corrected, not the
 * documented normal shape, so the row still requires one manual reviewer approval
 * (PUBLIC_HOLIDAY_SHIFT_MISCODED, checkbox-releasable) before this correction
 * reaches the export CSV. The caller also skips this rule entirely once the day
 * already carries an ABSENT/Absent NS/NC segment (re-run guard, decision
 * 2026-09-15) — otherwise re-running TAA against a date already corrected by
 * §4.6c above would see P/H-LV leave + the now-replaced SHIFT segment and
 * mistakenly propose converting that SHIFT back to OT2, undoing §4.6c's fix.
 */
function convertShiftSegmentsToOt2(
  shiftSegments: AspectSegment[], pfNo: string, nomDateStr: string,
  rowCorrections: AspectCorrectionRow[], config: ConfigRegistry
): number {
  for (const seg of shiftSegments) {
    const segStartDt = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
    const segmentDate = segStartDt ? formatSegmentDate(segStartDt) : nomDateStr;
    const segmentStarttime = segStartDt ? formatTimeHHMM(segStartDt) : '';
    const segmentDuration = resolveConversionRowDuration(seg, config);
    rowCorrections.push({
      Code: config.shiftUpdateOriginalCode, ID: pfNo, SegmentCode: seg.SEG_CODE, nominateDate: nomDateStr,
      SegmentDate: segmentDate, SegmentStarttime: segmentStarttime,
      Segmentduration: segmentDuration, Memo: `TAA Public-Holiday Leave Day: original ${seg.SEG_CODE} segment being replaced (should have been ${config.shiftToOt2ConversionCode})`,
    });
    rowCorrections.push({
      Code: config.shiftUpdateNewCode, ID: pfNo, SegmentCode: config.shiftToOt2ConversionCode, nominateDate: nomDateStr,
      SegmentDate: segmentDate, SegmentStarttime: segmentStarttime,
      Segmentduration: segmentDuration, Memo: `TAA Public-Holiday Leave Day: ${seg.SEG_CODE} segment converted to ${config.shiftToOt2ConversionCode}`,
    });
  }
  return shiftSegments.length;
}

/** Place Cover Segment on Next Working Day (§4.11). */
type CoverFallbackOption = ConfigRegistry['coverFallbackWhenNoWorkingDayFound'];

/** Result of resolving where cover should land: either a real target day, or the
 * specific reason placement isn't safe (never a generic fallback label) — shared by
 * placeCoverSegment and describeCoverPlacementFailure so the two can never disagree.
 * fallbackOption is set only when the target day was synthesized by
 * coverFallbackWhenNoWorkingDayFound (§4.11 Step 5) rather than found from a real
 * future ASPECT segment. */
type CoverTargetResolution =
  | { ok: true; targetDateStr: string; lastSegmentEndDt: Date; fallbackOption?: CoverFallbackOption; skippedDay?: { date: string; reason: HoldReasonCode } }
  | { ok: false; blockReason: HoldReasonCode };

/** Given a candidate day's own ASPECT segments, compute the safe cover-anchor time —
 * end of that day's last real segment (SHIFT/OT/COVER, release-aware), integrity-gated
 * exactly like a normal target day. Shared by the future-working-day path and the
 * `sameDay` fallback so both reuse identical placement logic, never a re-implementation.
 * A day whose own timestamps don't yield a computable end (thin/malformed data) resolves
 * with lastSegmentEndDt: null rather than failing outright — the caller decides whether
 * that means falling through to another fallback or blocking placement. */
function resolveDayCoverAnchor(
  candidateDateStr: string, empSegments: AspectSegment[], config: ConfigRegistry
): {
  ok: true; lastSegmentEndDt: Date | null;
  /** B3 fix: the day's removal intervals themselves (start/end), not just a day-wide
   * boolean — lets the caller (tryPlaceSameDayCover) block a same-day cover only when
   * it actually overlaps a removal, or is a trailing release at shift end (which,
   * because lastSegmentEndDt above is already anchored to a trailing release's own
   * START per the comment below, collapses to the same overlap check), rather than on
   * ANY removal anywhere in the day regardless of distance from the cover window. */
  removalIntervals: { start: Date; end: Date }[];
  /** A removal segment with neither a usable STOP_MOMENT nor a DURATION cannot be
   * turned into an interval — that is a data problem, not a scoping question, so it
   * still blocks unconditionally rather than being silently skipped. */
  hasUnresolvedRemovalSegments: boolean;
} | { ok: false; blockReason: HoldReasonCode } {
  // Anchor to the day's EFFECTIVE end, not the latest raw STOP_MOMENT: a
  // trailing REMOVAL segment (RLS/RLS-2H/RLS-3H/UN_RLS/Cover_RLS/NURSNG)
  // means the agent is unavailable to log in from that segment's START,
  // so cover must begin there — recomputeDaySchedule already derives this
  // (effectiveEnd = raw addition stop minus trailing release/nursing
  // minutes, which for a trailing removal segment equals its own start).
  const candidateDaySegments = empSegments.filter(s => (normalizeDateKey(s.NOM_DATE) || s.NOM_DATE) === candidateDateStr);
  const candidateDaySchedule = recomputeDaySchedule(candidateDaySegments, config);
  // F10 fix: a target day the app already knows has its OWN schedule
  // integrity problem must not be used to place cover on — placing an
  // exportable correction onto a day whose own data is contradictory just
  // compounds the error. Previously only out-of-window removals blocked
  // placement; every integrity signal that would hold a row if this were
  // the SOURCE day now blocks the TARGET day too.
  if (candidateDaySchedule.outOfWindowRemovalSegments.length > 0) return { ok: false, blockReason: 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW' };
  if (candidateDaySchedule.unknownDurationRemovalSegments.length > 0) return { ok: false, blockReason: 'REMOVAL_SEGMENT_DURATION_UNKNOWN' };
  if (candidateDaySchedule.durationDisagreementSegments.length > 0) return { ok: false, blockReason: 'SEGMENT_STOP_DURATION_DISAGREE' };
  // R4 fix: a target day carrying a malformed/incomplete/contradictory ASPECT
  // date/time is exactly the same integrity problem that holds a SOURCE day
  // (INVALID_ASPECT_DATETIME, checked first among every gate above) — but was
  // missing from this list, so cover could still be placed onto a target day
  // whose own timestamps the app already knows are unreliable.
  if (candidateDaySchedule.invalidDateTimeSegments.length > 0) return { ok: false, blockReason: 'INVALID_ASPECT_DATETIME' };
  // A full-day removal took this candidate day's ENTIRE schedule (net 0, window collapsed):
  // the agent is not required at all that day, so it is not a usable cover target — a cover
  // placed there could never be attended, and the next run would raise a cover-not-attended
  // finding (escalating to an absence) against a day the agent was legitimately released
  // from. The day still LOOKS like a working day to resolveCoverTargetDay's
  // isWorkingDaySegment filter, because its SHIFT segment is still present. Until the
  // full-day-segment rule (2026-09-21) this shape was blocked by the
  // REMOVAL_SEGMENT_DURATION_UNKNOWN gate above, which a bare removal can no longer trip.
  // Treated like every other unusable target day: skippedDay + the configured fallback, so
  // the cover still reaches the correction file with a Memo saying why this day was skipped.
  if (candidateDaySchedule.fullDayRemovalMinutes > 0) return { ok: false, blockReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY' };

  let lastSegmentEndDt: Date | null = candidateDaySchedule.effectiveEnd || candidateDaySchedule.rawEnd;

  // F01 fix: a COVER segment already on the target day's real ASPECT
  // schedule (placed by a PRIOR run, or already present in the upload) is
  // the day's true last segment just as much as a SHIFT/OT block — but
  // COVER deliberately never extends effectiveEnd/rawEnd (so an unattended
  // cover isn't double-charged as both early-logout AND cover-not-attended,
  // see coverExtendsAttendanceWindow). That means lastSegmentEndDt above
  // can land BEFORE an existing cover's own end, and a newly placed cover
  // would silently overlap it. Only real, timestamped COVER segments are
  // considered here — one with neither a usable STOP_MOMENT nor a DURATION
  // is genuinely unresolvable, so it is skipped rather than guessed at
  // (any resulting overlap with it is a pre-existing data problem, not one
  // this run created).
  candidateDaySegments
    .filter(s => s.SEG_CODE === 'COVER')
    .forEach(s => {
      const parsedStop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
      const parsedStart = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
      const coverEnd = parsedStop
        ? truncateToMinute(parsedStop)
        : (parsedStart && typeof s.DURATION === 'number')
          ? new Date(truncateToMinute(parsedStart).getTime() + s.DURATION * 60000)
          : null;
      if (coverEnd && (!lastSegmentEndDt || coverEnd.getTime() > lastSegmentEndDt.getTime())) {
        lastSegmentEndDt = coverEnd;
      }
    });

  // B3 fix: turn the day's removal segments into intervals (same parse pattern as the
  // COVER-segment loop just above) instead of collapsing them into one boolean. A
  // removal that cannot be resolved to an interval (no STOP_MOMENT and no DURATION)
  // still blocks unconditionally via hasUnresolvedRemovalSegments — we cannot reason
  // about where it sits relative to a candidate window, so we must not guess.
  const removalIntervals: { start: Date; end: Date }[] = [];
  let hasUnresolvedRemovalSegments = false;
  candidateDaySchedule.removalSegments.forEach(s => {
    const parsedStart = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
    const parsedStop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
    const start = parsedStart ? truncateToMinute(parsedStart) : null;
    const end = parsedStop
      ? truncateToMinute(parsedStop)
      : (start && typeof s.DURATION === 'number') ? new Date(start.getTime() + s.DURATION * 60000) : null;
    if (start && end) {
      removalIntervals.push({ start, end });
    } else {
      hasUnresolvedRemovalSegments = true;
    }
  });
  // A bare full-day-removal segment with net 0 scheduled minutes (fullDayRemovalMinutes
  // gate above only blocks when the removal actually took time) still carries no
  // START_MOMENT/STOP_MOMENT by definition (isFullDayBareSegment) — same "cannot
  // resolve to an interval" case as the loop above, so it blocks the same way rather
  // than being silently treated as absent from the day.
  if (candidateDaySchedule.fullDayRemovalSegments.length > 0) hasUnresolvedRemovalSegments = true;

  return { ok: true, lastSegmentEndDt, removalIntervals, hasUnresolvedRemovalSegments };
}

function resolveCoverTargetDay(
  incidentDate: Date, incidentNomDateStr: string, empSegments: AspectSegment[], config: ConfigRegistry, processingDate: Date,
  reducedHoursCoverExcluded = false,
): CoverTargetResolution {
  // D5/B2/B8 fix: a NEWLY assigned cover (this whole function — a proven already-worked
  // same-day cover never reaches here, see tryPlaceSameDayCover/invariant 9) must land on
  // a working day at least config.coverMinimumDaysAfterRunDate days after the RUN date,
  // not merely after the incident date. Real incidents are typically several days old by
  // the time reconciliation runs, so anchoring only to the incident date (the pre-fix
  // behaviour) could and did resolve to a date in the past (rec-436: incident 21/09,
  // exported cover also dated 21/09). searchAnchorDate is whichever is LATER — the
  // existing "day strictly after the incident" search is preserved unchanged when the
  // incident is already recent enough that the run-date floor doesn't bind (e.g. a
  // backdated processingDate, or an incident on the run day itself).
  const floorDate = addDays(startOfDay(processingDate), config.coverMinimumDaysAfterRunDate);
  const searchAnchorDate = incidentDate.getTime() >= floorDate.getTime() ? incidentDate : addDays(floorDate, -1);

  const futureWorkingSegments = empSegments.filter(s => {
    // Glossary-driven (ADDITION role, minus COVER/leave/write-only): a site-added
    // working code must count as a working day, not be silently skipped.
    if (!isWorkingDaySegment(s, config)) return false;
    const segDate = parseDateTimeString(s.NOM_DATE);
    if (!segDate) return false;
    // Reduced office hours: a Flex staffer's configured weekday can never receive make-up
    // COVER — removed from the candidate list here (NOT as a resolveDayCoverAnchor block),
    // so the next real eligible working day naturally becomes sorted[0] below, instead of
    // dropping into the §4.11 Step 5 fallback (whose nextDirectDay option can land right
    // back on the excluded day).
    if (reducedHoursCoverExcluded && isReducedOfficeHoursWeekday(segDate, config)) return false;
    return segDate.getTime() > searchAnchorDate.getTime();
  });

  let targetDateStr = '';
  let lastSegmentEndDt: Date | null = null;
  // Set when the next working day exists but fails its schedule-integrity gate (e.g. a
  // mid-shift release). It is then treated exactly like "no working day found" and takes
  // the §4.11 Step 5 fallback below, so the cover still lands in the correction file
  // instead of locking the whole row. The reason is kept for the Memo.
  let skippedDay: { date: string; reason: HoldReasonCode } | undefined;

  if (futureWorkingSegments.length > 0) {
    const sorted = [...futureWorkingSegments].sort((a, b) => parseDateTimeString(a.NOM_DATE)!.getTime() - parseDateTimeString(b.NOM_DATE)!.getTime());
    const targetSeg = sorted[0];
    // Defect fix: canonicalize via normalizeDateKey rather than carrying the
    // raw ASPECT NOM_DATE string straight through to the output CSV's
    // SegmentDate and into the same-day filter below — an unpadded raw
    // string (e.g. "1/9/2026") would silently fail to match other segments
    // on the same physical day whose NOM_DATE happened to be zero-padded.
    targetDateStr = normalizeDateKey(targetSeg.NOM_DATE) || targetSeg.NOM_DATE;
    const anchor = resolveDayCoverAnchor(targetDateStr, empSegments, config);
    if (anchor.ok) {
      lastSegmentEndDt = anchor.lastSegmentEndDt;
    } else {
      skippedDay = { date: targetDateStr, reason: anchor.blockReason };
      targetDateStr = '';
    }
  }

  // §4.11 Step 5 — no future working day found, i.e. the next working day's ASPECT
  // data hasn't been uploaded yet (or the found day's own timestamps didn't yield a
  // computable end). coverFallbackWhenNoWorkingDayFound picks how to place cover
  // anyway; every branch here marks fallbackOption so the row can carry a fixed
  // "placed without ASPECT data" note in both outputs (Memo suffix + exported column).
  if (!targetDateStr || !lastSegmentEndDt) {
    const fallbackOption = config.coverFallbackWhenNoWorkingDayFound;

    // D5/B8 fix: every fallback branch below must also respect the run-date floor — a
    // fallback that resolved at or before it would quietly reintroduce the exact
    // past-dated cover D5 exists to fix (this is the ONLY reason floorDate/searchAnchorDate
    // are computed even though this branch runs when no real future-day data exists).
    if (fallbackOption === 'sameDay' && incidentDate.getTime() >= floorDate.getTime() && !(reducedHoursCoverExcluded && isReducedOfficeHoursWeekday(incidentDate, config))) {
      // Collapses cover onto the incident day itself, reusing resolveDayCoverAnchor
      // unchanged — no separate time logic, no default-time override. The incident
      // day is guaranteed to already carry a real ASPECT schedule (rows with none are
      // routed to COGNOS_DATA_GAP before cover placement is ever reached), so this
      // should never hit the null-anchor branch in practice. Only reachable when the
      // incident itself is not before the floor — see the else-branch comment below
      // for the (today, not live in samples_Files/Config.json) case where it is.
      const incidentDateStr = normalizeDateKey(incidentNomDateStr) || incidentNomDateStr;
      const anchor = resolveDayCoverAnchor(incidentDateStr, empSegments, config);
      if (!anchor.ok) return anchor;
      if (!anchor.lastSegmentEndDt) return { ok: false, blockReason: 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW' };
      return { ok: true, targetDateStr: incidentDateStr, lastSegmentEndDt: anchor.lastSegmentEndDt, fallbackOption, skippedDay };
    }
    // fallbackOption === 'sameDay' but the incident day itself is before the floor: its
    // own definition ("place on the incident day") is fundamentally incompatible with
    // "must be after the run date" for that incident, so there is no date this fallback
    // can honestly return. Falls through to the synthesized-date branch below (same as
    // nextDirectDay/nextWeekMonday, anchored off the floor) rather than either silently
    // violating the floor or inventing new fallback semantics — fails toward a
    // floor-compliant synthesized date, never toward the past-dated bug this fixes.

    let targetDt = fallbackOption === 'nextWeekMonday' ? nextWeekMonday(searchAnchorDate) : addDays(searchAnchorDate, 1);
    // Reduced office hours: a synthesized fallback date must not land on the excluded
    // weekday either — step forward until it doesn't (bounded: a weekday cycle is 7 days).
    for (let i = 0; i < 7 && reducedHoursCoverExcluded && isReducedOfficeHoursWeekday(targetDt, config); i++) {
      targetDt = addDays(targetDt, 1);
    }
    targetDateStr = formatDateDDMMYYYY(targetDt);
    const [fh, fm] = (config.coverFallbackDefaultTime || '08:00').split(':').map(Number);
    lastSegmentEndDt = new Date(targetDt.getFullYear(), targetDt.getMonth(), targetDt.getDate(), fh, fm, 0);
    return { ok: true, targetDateStr, lastSegmentEndDt, fallbackOption, skippedDay };
  }

  return { ok: true, targetDateStr, lastSegmentEndDt };
}

/** Short, fixed, deterministic text describing which fallback placed a cover without
 * real ASPECT data — used identically in the ASPECT correction row's Memo suffix and
 * the exported TAA_COVER_FALLBACK_NOTE column, so the two outputs can never disagree. */
function describeCoverFallback(option: CoverFallbackOption, config: ConfigRegistry): string {
  const defaultTime = config.coverFallbackDefaultTime || '08:00';
  switch (option) {
    case 'sameDay': return 'Cover added without ASPECT data - fallback: Same day (incident day end-of-schedule)';
    case 'nextDirectDay': return `Cover added without ASPECT data - fallback: Next calendar day, ${defaultTime} default`;
    case 'nextWeekMonday': return `Cover added without ASPECT data - fallback: Next-week Mon, ${defaultTime} default`;
  }
}

/** Carries which fallback (if any) produced a given placed COVER correction row, keyed
 * by object identity so it survives being merged/reassigned across the several
 * placeCoverSegment call sites without re-parsing free text back out of Memo — which
 * buildCoverNotAttendedOutcomes's moveCoverForward branch overwrites wholesale. Rows
 * are freshly built per run and never persisted, so entries are naturally
 * garbage-collected once their row object is unreachable; no manual cleanup needed. */
const coverFallbackByRow = new WeakMap<AspectCorrectionRow, CoverFallbackOption>();

/** D2 fix: keyed by object identity, same pattern as coverFallbackByRow — lets a
 * COVER row that gets stripped because the day's final verdict turned out ABSENT
 * (evaluated after this row was pushed) release the exact reservation slot it
 * claimed in placedCoversThisRun. Leaving it claimed would push the NEXT cover for
 * this employee/target-day later, a new pay error in a different row. */
const coverReservationByRow = new WeakMap<AspectCorrectionRow, { trackerKey: string; entry: { start: Date; end: Date; duration: number } }>();
/** D2 fix: marks exactly which placed COVER rows were counted in lateCoverCount at
 * push time — Rule 7's moveCoverForward cover is never counted there, so a strip
 * must not blindly decrement per stripped COVER row or it would double-count. */
const lateCoverCountedRows = new WeakSet<AspectCorrectionRow>();

/** D2 fix: releases a previously-placed COVER's reservation and, if it was counted,
 * its lateCoverCount contribution — called when the row is stripped because the
 * day's final action turned out to be ABSENT. */
function releaseCover(row: AspectCorrectionRow, placedCoversThisRun: Map<string, { start: Date; end: Date; duration: number }[]>): number {
  const reservation = coverReservationByRow.get(row);
  if (reservation) {
    const list = placedCoversThisRun.get(reservation.trackerKey);
    if (list) {
      const idx = list.indexOf(reservation.entry);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  return lateCoverCountedRows.has(row) ? 1 : 0;
}

/** config.coverSameDayWhenAlreadyCovered (off by default): before searching ahead for a
 * future working day, checks whether the agent was already logged in for the FULL cover
 * duration on the incident day itself — stayed past the day's own scheduled/effective end
 * after a late login (`direction: 'afterEnd'`), or arrived before the effective start ahead
 * of an early logout (`direction: 'beforeStart'`). Only when that whole window sits inside
 * a SINGLE proven-continuous presence block (D4 fix — see below) is the cover placed there;
 * every other case (toggle off, window doesn't fit, day fails resolveDayCoverAnchor's
 * schedule-integrity gates, or the window overlaps a removal/release/nursing segment)
 * returns null so the caller falls straight through to the existing placeCoverSegment
 * (next-working-day search / coverFallbackWhenNoWorkingDayFound) exactly as before this
 * toggle existed.
 *
 * D4 fix (WP2): the pre-fix version checked only that the window sat inside the single
 * span [firstLoginDt, lastLogoutDt] — invisible to a mid-window gap where the agent was
 * genuinely logged out (rec-282: logged out 16:47-18:40, cover credited anyway). `presence`
 * is the same presenceBlocks() output WP1 uses for late-logout credit (B6: cover credit
 * requires proof of CONTINUOUS attendance — Rule 7/evaluateCoverNotAttended is NOT changed
 * by this and keeps its own span measure, deliberately, per B6). The window must fall
 * entirely inside ONE presence block, not just inside the union of all of them.
 *
 * B3 fix (WP2): the pre-fix version blocked on ANY removal/release/nursing segment
 * anywhere in the day (`anchor.hasRemovalSegments`, a day-wide boolean), even one nowhere
 * near the cover window. Now blocks only when a removal interval actually OVERLAPS the
 * candidate window — which also catches a trailing release at shift end without a special
 * case, because resolveDayCoverAnchor already anchors lastSegmentEndDt to a trailing
 * release's own START (see its doc comment), so the 'afterEnd' window necessarily starts
 * at/after that release's start and overlaps it. Full interval only: any overlap blocks
 * the WHOLE window (never split a partly-worked cover) and falls through to the normal
 * next-working-day search, exactly as full-day blocking did before. */
function tryPlaceSameDayCover(
  empId: string,
  incidentNomDateStr: string,
  durationMinutes: number,
  direction: 'afterEnd' | 'beforeStart',
  attendance: { firstLoginDt: Date | null; lastLogoutDt: Date | null; effectiveStartDt: Date | null; shiftEndDt: Date | null },
  empSegments: AspectSegment[],
  placedCoversThisRun: Map<string, { start: Date; end: Date; duration: number }[]>,
  config: ConfigRegistry,
  presence: { start: Date; end: Date }[],
  reducedHoursCoverExcluded = false,
): AspectCorrectionRow | null {
  if (!config.coverSameDayWhenAlreadyCovered) return null;
  const { firstLoginDt, lastLogoutDt, effectiveStartDt, shiftEndDt } = attendance;
  if (!firstLoginDt || !lastLogoutDt) return null;
  if (presence.length === 0) return null;

  const incidentDateStr = normalizeDateKey(incidentNomDateStr) || incidentNomDateStr;
  // Reduced office hours: a Flex staffer's configured weekday never receives make-up COVER,
  // including same-day cover — refused unconditionally, before any window math.
  if (reducedHoursCoverExcluded) {
    const incidentDay = parseDateTimeString(incidentDateStr);
    if (incidentDay && isReducedOfficeHoursWeekday(incidentDay, config)) return null;
  }
  const anchor = resolveDayCoverAnchor(incidentDateStr, empSegments, config);
  if (!anchor.ok) return null;
  if (anchor.hasUnresolvedRemovalSegments) return null;

  const trackerKey = `${empId}|${incidentDateStr}`;
  const existingCovers = placedCoversThisRun.get(trackerKey) || [];

  let windowStart: Date;
  let windowEnd: Date;

  if (direction === 'afterEnd') {
    if (!anchor.lastSegmentEndDt) return null;
    // A flex shift update moves the real end past the raw ASPECT end the anchor is built
    // from — starting at the raw end would put the cover inside normal shift hours.
    const baseEndMs = Math.max(anchor.lastSegmentEndDt.getTime(), shiftEndDt ? shiftEndDt.getTime() : 0);
    // Only stack after covers that are themselves anchored at/after the day's own end —
    // a 'beforeStart' cover sharing this trackerKey lives in a disjoint, earlier window
    // and must never be treated as "the last cover" for this direction.
    const afterEntries = existingCovers.filter(c => c.start.getTime() >= baseEndMs);
    windowStart = afterEntries.length > 0
      ? new Date(Math.max(...afterEntries.map(c => c.end.getTime())))
      : new Date(baseEndMs);
    windowEnd = new Date(windowStart.getTime() + durationMinutes * 60000);
    if (windowEnd.getTime() > lastLogoutDt.getTime()) return null;
  } else {
    if (!effectiveStartDt) return null;
    const beforeEntries = existingCovers.filter(c => c.end.getTime() <= effectiveStartDt.getTime());
    windowEnd = beforeEntries.length > 0
      ? new Date(Math.min(...beforeEntries.map(c => c.start.getTime())))
      : new Date(effectiveStartDt);
    windowStart = new Date(windowEnd.getTime() - durationMinutes * 60000);
    if (windowStart.getTime() < firstLoginDt.getTime()) return null;
  }

  // B3: block only on a removal actually overlapping this specific window — never split,
  // any overlap blocks the whole thing.
  const overlapsRemoval = anchor.removalIntervals.some(r => r.start.getTime() < windowEnd.getTime() && r.end.getTime() > windowStart.getTime());
  if (overlapsRemoval) return null;

  // D4: the window must fall entirely inside ONE presence block — proof of CONTINUOUS
  // attendance, not just that it sits somewhere inside the overall first-login..last-logout
  // span (which a mid-window logout, e.g. rec-282, would satisfy without the agent actually
  // being there for it).
  const fitsSinglePresenceBlock = presence.some(b => b.start.getTime() <= windowStart.getTime() && b.end.getTime() >= windowEnd.getTime());
  if (!fitsSinglePresenceBlock) return null;

  const reservationEntry = { start: windowStart, end: windowEnd, duration: durationMinutes };
  existingCovers.push(reservationEntry);
  placedCoversThisRun.set(trackerKey, existingCovers);

  const memo = `TAA Cover for ${incidentNomDateStr} Late/Variance | Same-day cover: agent already covered ${formatTimeHHMM(windowStart)}-${formatTimeHHMM(windowEnd)}`;
  const row: AspectCorrectionRow = {
    Code: config.aspectNormalActionCode, ID: empId, SegmentCode: 'COVER', nominateDate: incidentDateStr, SegmentDate: formatSegmentDate(windowStart),
    SegmentStarttime: formatTimeHHMM(windowStart), Segmentduration: formatMinutesToHHMM(durationMinutes), Memo: memo,
  };
  coverReservationByRow.set(row, { trackerKey, entry: reservationEntry });
  return row;
}

interface RecordedIncident { note: string }

const segCodeIs = (seg: AspectSegment, code: string) => (seg.SEG_CODE || '').trim().toUpperCase() === code.toUpperCase();
const segNomKey = (seg: AspectSegment) => normalizeDateKey(seg.NOM_DATE) || seg.NOM_DATE;
function recordedSegMinutes(seg: AspectSegment): number | null {
  if (typeof seg.DURATION === 'number') return seg.DURATION;
  const a = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
  const b = seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null;
  return a && b ? Math.round((b.getTime() - a.getTime()) / 60000) : null;
}

/** "Already actioned" rule (business decision 2026-09-27, doc/PRD.md §4.1): when ASPECT
 * already holds a LATE (or Log_off) segment on the incident's own schedule day, the incident
 * has been actioned outside TAA and TAA takes NO further action for it — no marker AND no
 * COVER. Any segment of that code on that NOM day counts, whatever its start or minutes: a
 * recorded LATE of 8m against TAA's measured 10m is still "already added", never a second
 * LATE (which is what the previous exact start+duration match exported) and never a COVER on
 * top of it. The caller keeps the verdict for the reviewer and traces both figures. */
function findAlreadyRecordedIncident(
  empSegments: AspectSegment[], incidentNomDateStr: string, code: 'LATE' | 'Log_off', measuredMinutes: number,
): RecordedIncident | null {
  const incidentKey = normalizeDateKey(incidentNomDateStr) || incidentNomDateStr;
  const markers = empSegments.filter(s => segCodeIs(s, code) && segNomKey(s) === incidentKey);
  if (markers.length === 0) return null;
  const describe = (seg: AspectSegment) => {
    const st = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
    const mins = recordedSegMinutes(seg);
    return `${st ? formatTimeHHMM(st) : '--:--'} ${mins !== null ? `${mins}m` : '?m'}`;
  };
  return {
    note: `ASPECT already has ${code} ${markers.map(describe).join(', ')} vs TAA ${measuredMinutes}m — already actioned, no correction (no ${code}, no COVER)`,
  };
}

function placeCoverSegment(
  empId: string, incidentNomDateStr: string, durationMinutes: number, empSegments: AspectSegment[],
  placedCoversThisRun: Map<string, { start: Date; end: Date; duration: number }[]>, config: ConfigRegistry, processingDate: Date,
  reducedHoursCoverExcluded = false,
): AspectCorrectionRow | null {
  const incidentDate = parseDateTimeString(incidentNomDateStr);
  if (!incidentDate) return null;

  const resolution = resolveCoverTargetDay(incidentDate, incidentNomDateStr, empSegments, config, processingDate, reducedHoursCoverExcluded);
  if (!resolution.ok) return null;
  const { targetDateStr, lastSegmentEndDt, fallbackOption, skippedDay } = resolution;

  const trackerKey = `${empId}|${targetDateStr}`;
  const existingCovers = placedCoversThisRun.get(trackerKey) || [];
  let coverStartDt = new Date(lastSegmentEndDt);
  if (existingCovers.length > 0) coverStartDt = new Date(existingCovers[existingCovers.length - 1].end);

  const coverEndDt = new Date(coverStartDt.getTime() + durationMinutes * 60 * 1000);
  const reservationEntry = { start: coverStartDt, end: coverEndDt, duration: durationMinutes };
  existingCovers.push(reservationEntry);
  placedCoversThisRun.set(trackerKey, existingCovers);

  const skippedNote = skippedDay ? ` | Next working day ${skippedDay.date} unusable (${skippedDay.reason})` : '';
  const memo = `TAA Cover for ${incidentNomDateStr} Late/Variance${skippedNote}${fallbackOption ? ` | ${describeCoverFallback(fallbackOption, config)}` : ''}`;

  const row: AspectCorrectionRow = {
    // Defect fix: nominateDate must be the RESOLVED TARGET schedule's own NOM_DATE
    // (targetDateStr), never the incident's NOM_DATE. ASPECT keys a segment to its
    // owning schedule by NOM_DATE — resolveCoverTargetDay() above already filters
    // target-day segments by NOM_DATE for exactly this reason — so a COVER written
    // with the incident's NOM_DATE would file itself against the wrong (incident)
    // schedule day instead of the working day it's actually placed on. The incident
    // date is preserved in Memo for traceability. This applies equally to the
    // synthesized fallback target (§4.11 Step 5): resolveCoverTargetDay() returns
    // that fallback date through the same targetDateStr field.
    //
    // SegmentDate, separately, must stay the cover's own PHYSICAL start day, not the
    // targetDateStr bucket it was scheduled against — targetDaySchedule.effectiveEnd
    // (a night shift's end) or a stack of same-day covers pushed past midnight can
    // both land coverStartDt on the day AFTER targetDateStr. So nominateDate and
    // SegmentDate can legitimately differ by one calendar day for an overnight target.
    Code: config.aspectNormalActionCode, ID: empId, SegmentCode: 'COVER', nominateDate: targetDateStr, SegmentDate: formatSegmentDate(coverStartDt),
    SegmentStarttime: formatTimeHHMM(coverStartDt), Segmentduration: formatMinutesToHHMM(durationMinutes), Memo: memo,
  };
  if (fallbackOption) coverFallbackByRow.set(row, fallbackOption);
  coverReservationByRow.set(row, { trackerKey, entry: reservationEntry });
  return row;
}

/** F10 fix: when placeCoverSegment returns null, callers previously all reported the
 * same generic REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW hold reason regardless of which
 * target-day integrity problem actually caused it. Reuses the exact same resolution
 * logic so this can never disagree with why placement actually failed. */
function describeCoverPlacementFailure(incidentNomDateStr: string, empSegments: AspectSegment[], config: ConfigRegistry, processingDate: Date, reducedHoursCoverExcluded = false): HoldReasonCode {
  const incidentDate = parseDateTimeString(incidentNomDateStr);
  if (!incidentDate) return 'INVALID_ASPECT_DATETIME';
  const resolution = resolveCoverTargetDay(incidentDate, incidentNomDateStr, empSegments, config, processingDate, reducedHoursCoverExcluded);
  return resolution.ok ? 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW' : resolution.blockReason;
}

/** Scans a row's assembled corrections for any COVER placed via
 * coverFallbackWhenNoWorkingDayFound and returns one fixed, deterministic note —
 * empty when no fallback fired. Multiple covers using different fallback options in
 * the same row (rare — would need two independent late/early findings) are joined. */
function getCoverFallbackNote(corrections: AspectCorrectionRow[], config: ConfigRegistry): string {
  const options = new Set<CoverFallbackOption>();
  corrections.forEach(c => {
    const opt = coverFallbackByRow.get(c);
    if (opt) options.add(opt);
  });
  if (options.size === 0) return '';
  return Array.from(options).map(opt => describeCoverFallback(opt, config)).join(' | ');
}

// Deliberately does NOT carry generateAnnotatedCognosFile's leading-"=+-@"
// apostrophe guard, and must not gain one. That guard exists because the
// annotated Cognos report is opened in Excel, where a leading "=" would be
// evaluated as a formula. This file is machine-imported by ASPECT instead, so
// prefixing an apostrophe would push a literal "'" into the uploaded Memo/ID
// and corrupt the very data the upload is meant to correct. Memo is always
// double-quoted (quoteAlways), so a leading "=" is already inert to a CSV
// parser — the asymmetry between the two writers is intentional.
function escapeAspectCsvField(val: string, quoteOnSpace = false): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r') || (quoteOnSpace && val.includes(' '))) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
function quoteAlways(val: string): string {
  return `"${val.replace(/"/g, '""')}"`;
}

// A day-level absence marker (ABSENT / Absent NS/NC) has no meaningful
// SegmentStarttime/Segmentduration of its own — two different rules firing
// on the same employee-day (e.g. Early Logout AND Cover Not Attended, once
// an unattended trailing cover pushed both to fire) previously emitted two
// separate ABSENT rows with different Memo text, which would double-count
// the day in the ASPECT upload. Collapse to one marker per employee-day,
// keeping the first (most-informative) Memo. Byte-identical duplicates of
// any OTHER row shape (e.g. the same OT->SHIFT conversion emitted twice by
// two absence-triggering rules on the same day) are also collapsed.
export const ABSENT_MARKER_CODES = new Set(['ABSENT', 'Absent NS/NC']);
function dedupeAspectCorrections(corrections: AspectCorrectionRow[]): AspectCorrectionRow[] {
  const seenExact = new Set<string>();
  const seenAbsentMarker = new Set<string>();
  const result: AspectCorrectionRow[] = [];
  for (const c of corrections) {
    const exactKey = [c.Code, c.ID, c.SegmentCode, c.nominateDate, c.SegmentDate, c.SegmentStarttime, c.Segmentduration, c.Memo].join('|');
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);
    if (ABSENT_MARKER_CODES.has(c.SegmentCode)) {
      const markerKey = [c.Code, c.ID, c.SegmentCode, c.nominateDate, c.SegmentDate].join('|');
      if (seenAbsentMarker.has(markerKey)) continue;
      seenAbsentMarker.add(markerKey);
    }
    result.push(c);
  }
  return result;
}

/**
 * Generate ASPECT Correction CSV with mandatory trailing commas (§5 Output 1).
 * Phase 5 fix (user-confirmed): no header row — the ASPECT import expects data
 * rows only. An empty result set therefore produces an empty (0-byte) string,
 * not a header-only file.
 */
export function generateAspectCorrectionsCsv(rawCorrections: AspectCorrectionRow[]): string {
  const corrections = dedupeAspectCorrections(rawCorrections);
  const lines = corrections.map(c => {
    const fields = [
      escapeAspectCsvField(String(c.Code ?? '')),
      escapeAspectCsvField(String(c.ID ?? '')),
      escapeAspectCsvField(String(c.SegmentCode ?? ''), true),
      escapeAspectCsvField(String(c.nominateDate ?? '')),
      escapeAspectCsvField(String(c.SegmentDate ?? '')),
      escapeAspectCsvField(String(c.SegmentStarttime ?? '')),
      escapeAspectCsvField(String(c.Segmentduration ?? '')),
    ];
    fields.push(quoteAlways(String(c.Memo ?? '')));
    return fields.join(',') + ',';
  });
  return lines.join('\n');
}

/**
 * Generate Annotated Cognos Report File. Original 18 columns are preserved
 * with ONE exception: a column listed in config.cognosBlankFillColumns that
 * was empty in the source is filled with its recomputed value — never a
 * populated cell. Filled cells are also listed in TAA_FILLED_COLUMNS so a
 * reviewer can always tell what Cognos exported vs. what TAA supplied.
 */
export function generateAnnotatedCognosFile(
  rows: ReconciliationRow[],
  delimiter: string = ',',
  config?: ConfigRegistry,
  verificationAudit?: VerificationOverrideAudit,
  // Optional so existing callers keep working; when supplied, every row gains a
  // durable record of what happened to its email. Without it the two email
  // columns render as UNKNOWN rather than silently claiming NOT_REQUIRED.
  emailActions?: EmailActionItem[],
): string {
  if (rows.length === 0) return '';

  const originalHeaders = [
    'SIGN IN DATE', 'SECTION', 'PF NO', 'NAME', 'LOGIN ID', 'DUTY1', 'OT1', 'DUTY-2', 'OT-2',
    'SCH DURATION', 'SIGNIN DURATION', 'SIGIN IN', 'SIGIN OUT', 'LATE START', 'LEFT EARLY', 'LEAVE TYPE', 'LEAVE HR', 'REMARK',
  ];
  const appendedHeaders = [
    'TAA_MARKER', 'TAA_TIER', 'TAA_OT1', 'TAA_OT2', 'TAA_SCH_HOURS_RECOMPUTED', 'TAA_EFFECTIVE_START', 'TAA_EFFECTIVE_END',
    'TAA_CMS_IN', 'TAA_CMS_OUT', 'TAA_LATE_MIN', 'TAA_EARLY_MIN', 'TAA_VERDICT', 'TAA_ACTION', 'TAA_ACTIONS_FIRED', 'TAA_RESULT_CATEGORY',
    'TAA_COGNOS_AGREE', 'TAA_DISAGREE_REASON', 'TAA_USERNAME', 'TAA_SECTION', 'TAA_SECTION_SOURCE', 'TAA_ASPECT_SECTION', 'TAA_SECTION_MISMATCH',
    'TAA_MISMATCH_COUNT', 'TAA_MISMATCH_COLUMNS', 'TAA_FILLED_COLUMNS',
    'TAA_LEAVE_TYPE_RECOMPUTED', 'TAA_LEAVE_TYPE_STATUS', 'TAA_LEAVE_TYPE_MATCH_BASIS',
    'TAA_INCLUDED_IN_OUTPUT', 'TAA_HOLD_REASON', 'TAA_COVER_FALLBACK_NOTE',
    // Email outcome, so a case that required a notice and did not get one is
    // still traceable after the browser session ends.
    'TAA_COMMUNICATION_RULE', 'TAA_EMAIL_STATUS',
    'TAA_VERIFICATION_STATUS', 'TAA_VERIFICATION_OVERRIDE_AT', 'TAA_VERIFICATION_OVERRIDE_REASON', 'TAA_VERIFICATION_FAILED_CHECKS',
    // WP3 — appended at the end; do not insert earlier, appendedHeaders and
    // lineValues below must stay positionally zipped.
    'TAA_REVIEW_COMPLETED', 'TAA_COGNOS_ISSUE_LABEL',
    // 2026-09-27 — release booked off the configured grid (informational, never a hold).
    'TAA_RELEASE_GRID_NOTE',
  ];
  const allHeaders = [...originalHeaders, ...appendedHeaders];

  // A row can now fire more than one action, each its own EmailActionItem —
  // collapse back to one communication rule per underlying row
  // (TAA_COMMUNICATION_RULE is a single column here). Keyed off base_row_id,
  // never a split of row_id (a PF NO can contain '#'). First non-NA action
  // seen wins: a row with both an NA and a real (EMAIL_OPS/
  // EMAIL_STAFF_CC_MANAGER) action reports the real one, since NA is "nothing
  // to report" rather than a competing finding.
  const communicationByRowId = new Map<string, CommunicationRule>();
  (emailActions || []).forEach(a => {
    const base = a.base_row_id;
    const existing = communicationByRowId.get(base);
    if (!existing || existing === 'NA') communicationByRowId.set(base, a.communication_rule);
  });
  const emailStatusByRowId = emailActions && config
    ? computeEmailStatusByRowId(emailActions, eligibleRowIdSet(rows), config.sectionMailboxMap, config.emailTemplates).statusByBaseRowId
    : null;

  const escapeCell = (val: any): string => {
    let str = val === undefined || val === null ? '' : String(val);
    if (/^[=+\-@]/.test(str)) str = `'${str}`;
    if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const lines = [allHeaders.map(escapeCell).join(delimiter)];
  const fillCols = new Set(config?.cognosBlankFillColumns || []);

  rows.forEach(r => {
    const orig = r.originalCognos;
    const getOriginal = (col: string): string => {
      const raw = (orig as any)[col] || '';
      if (raw || !fillCols.has(col)) return raw;
      const comparison = r.columnComparisons.find(c => c.column === col);
      return comparison && comparison.status === 'COGNOS_BLANK' ? comparison.recomputedRaw : raw;
    };
    const lineValues = [
      orig['SIGN IN DATE'] || '', orig['SECTION'] || '', orig['PF NO'] || '', orig['NAME'] || '', orig['LOGIN ID'] || '',
      getOriginal('DUTY1'), getOriginal('OT1'), getOriginal('DUTY-2'), getOriginal('OT-2'),
      orig['SCH DURATION'] || '', orig['SIGNIN DURATION'] || '', orig['SIGIN IN'] || '', orig['SIGIN OUT'] || '',
      orig['LATE START'] || '', orig['LEFT EARLY'] || '', orig['LEAVE TYPE'] || '', orig['LEAVE HR'] || '', orig['REMARK'] || '',
      r.TAA_MARKER, r.TAA_TIER, r.TAA_OT1, r.TAA_OT2, r.TAA_SCH_HOURS_RECOMPUTED, r.TAA_EFFECTIVE_START, r.TAA_EFFECTIVE_END,
      r.TAA_CMS_IN, r.TAA_CMS_OUT, r.TAA_LATE_MIN, r.TAA_EARLY_MIN, r.TAA_VERDICT, r.TAA_ACTION, r.TAA_ACTIONS_FIRED, r.TAA_RESULT_CATEGORY,
      r.TAA_COGNOS_AGREE ? 'TRUE' : 'FALSE', r.TAA_DISAGREE_REASON, r.TAA_USERNAME, r.TAA_SECTION, r.TAA_SECTION_SOURCE, r.TAA_ASPECT_SECTION, r.TAA_SECTION_MISMATCH ? 'TRUE' : 'FALSE',
      r.TAA_MISMATCH_COUNT, r.TAA_MISMATCH_COLUMNS, r.TAA_FILLED_COLUMNS,
      r.TAA_LEAVE_TYPE_RECOMPUTED, r.TAA_LEAVE_TYPE_STATUS, r.TAA_LEAVE_TYPE_MATCH_BASIS,
      r.includeInOutput ? 'TRUE' : 'FALSE', r.holdReason || '', r.coverFallbackNote || '',
      // A row with no email action never fired an emailing rule, so NA is the
      // honest value; UNKNOWN only when the caller supplied no email context.
      communicationByRowId.get(r.id) || (emailActions ? 'NA' : 'UNKNOWN'),
      emailStatusByRowId ? (emailStatusByRowId.get(r.id) || 'NOT_REQUIRED') : 'UNKNOWN',
      verificationAudit ? 'OVERRIDE_USED' : 'ALL_CHECKS_PASSED',
      verificationAudit?.acknowledged_at || '',
      verificationAudit?.reason || '',
      verificationFailedCheckSummary(verificationAudit),
      // WP3 — appended at the end (see appendedHeaders comment above).
      r.reviewCompleted ? 'TRUE' : 'FALSE',
      r.TAA_COGNOS_AGREE ? '' : describeDisagreement(r),
      r.releaseGridNote || '',
    ];
    lines.push(lineValues.map(escapeCell).join(delimiter));
  });

  return lines.join('\n');
}

// Correction SegmentCodes that make up a Late+Cover / Logoff+Cover finding —
// the exact same set STRIPPED_ON_ABSENT (above) removes when a day resolves
// to MARKED_ABSENT and config.retainLateCoverOnAbsent is off. Whether a row's
// own generatedCorrections still contains one of these is deliberately used
// (below, and in ResultsView.tsx) instead of TAA_ACTIONS_FIRED/action codes:
// TAA_ACTIONS_FIRED intentionally still lists LATE_AND_COVER/LOGOFF_AND_COVER
// for audit even on a row where the correction was stripped, so matching on
// it would wrongly surface every stripped Absent row in "2. Late + Cover" —
// generatedCorrections reflects what was ACTUALLY exported, post-strip.
// WP3 (D11/B11/D13) — the three diagnosed Cognos bugs this tool actually
// knows the root cause of, vs. every other column mismatch (~800 rows on
// real data) that the old badge lumped in with them. One helper, used by
// the on-screen badge, the workbook export and the annotated CSV, so the
// three can never disagree about which rows are "known issues".
const KNOWN_COGNOS_ISSUE_REASONS = new Set([
  'DEFECT_1_RELEASE_IGNORED',
  'DEFECT_2_NIGHT_SHIFT_PUNCH_LOST',
  'COGNOS_FALSE_ABSENCE',
]);
export function describeDisagreement(row: ReconciliationRow): string {
  return KNOWN_COGNOS_ISSUE_REASONS.has(row.TAA_DISAGREE_REASON)
    ? 'Known Cognos issue'
    : `Cognos mismatch: ${row.TAA_MISMATCH_COLUMNS}`;
}

export const LATE_COVER_SEGMENT_CODES = new Set(['LATE', 'Log_off', 'COVER']);
export const rowHasLateCoverCorrection = (row: ReconciliationRow): boolean =>
  row.details.generatedCorrections.some(c => LATE_COVER_SEGMENT_CODES.has(c.SegmentCode));

// D15/WP4 — the literal SegmentCode the two flex shift-time-rewrite branches
// (arrival <= cutoff, and arrival > cutoff) push their 10/11 pair under.
// Deliberately lowercase and distinct from the OT/SHIFT bookkeeping
// conversions, which reuse the same "10"/"11" Codes but push SegmentCode
// values of 'OT1'/'OT2'/'SHIFT'/the configured conversion codes instead —
// a case-insensitive or Code-only match would wrongly pull those in. One
// exported constant, used at both emission sites and here, so they can
// never drift apart.
export const SHIFT_CHANGE_SEGMENT_CODE = 'shift';
export const rowHasShiftChangeCorrection = (row: ReconciliationRow): boolean =>
  row.details.generatedCorrections.some(c => c.SegmentCode === SHIFT_CHANGE_SEGMENT_CODE);

// D19/B7/B12 — "Must Check": a row a human must look at because pay is on
// the line and the engine cannot act on its own. Two clauses, both real on
// real data — a predicate over corrections alone would miss the forced-hold
// rows (they stop at MANUAL_REVIEW_REQUIRED before any correction is built,
// so generatedCorrections is always empty for them).
const MUST_CHECK_PAY_AFFECTING_CODES = new Set([...ABSENT_MARKER_CODES, ...LATE_COVER_SEGMENT_CODES]);
export const rowIsMustCheck = (row: ReconciliationRow): boolean =>
  isForcedHoldReason(row.holdReason)
  || (!!row.holdReason && row.details.generatedCorrections.some(c => MUST_CHECK_PAY_AFFECTING_CODES.has(c.SegmentCode)));

// Plain-text equivalents of ResultsView.tsx's getCategoryBadge() labels, for
// the Excel export's Category column.
const CATEGORY_BADGE_LABELS: Record<TaaResultCategory, string> = {
  SHIFT_CHANGED: '1. Shift Changed (Flex)',
  LATE_AND_COVER_ADDED: '2. Late + Cover Added',
  MARKED_ABSENT: '3. Marked Absent',
  NO_ACTION_REQUIRED: '4. No Action Required (Resolved)',
  COGNOS_DATA_GAP: '5. Cognos Data Gap',
};

/**
 * Builds one sheet per Results-view category tab, each holding the exact
 * columns and per-cell line-groupings the on-screen table shows
 * (ResultsView.tsx's table) — a direct sheet-for-table mirror, not a
 * redesign. The 6 category predicates below are literal copies of
 * ResultsView.tsx's `counts`/`filteredRows` predicates — a row can land in
 * both its category sheet AND "Held for Review" simultaneously, exactly like
 * the on-screen tabs. If either changes, check the other.
 */
export function buildResultsWorkbookSheets(
  rows: ReconciliationRow[],
  emailActions: EmailActionItem[],
): { name: string; rows: string[][] }[] {
  // A row can now fire more than one action (one EmailActionItem each) — this
  // Excel export shows one Email cell per row, so keep the first non-NA action
  // seen for that base row (matches generateAnnotatedCognosFile's
  // TAA_COMMUNICATION_RULE logic). Keyed off base_row_id, never a split of
  // row_id (a PF NO can contain '#').
  const emailActionsByRow = new Map<string, EmailActionItem>();
  emailActions.forEach(a => {
    const base = a.base_row_id;
    const existing = emailActionsByRow.get(base);
    if (!existing || existing.communication_rule === 'NA') emailActionsByRow.set(base, a);
  });

  const header = [
    'Include', 'Email', 'Employee', 'Date', 'Role Tier', 'Category',
    'Cognos Original (Raw)', 'Recomputed (True TAA)', 'Actual Punches', 'Final Action', 'Details',
    // WP3 — appended at the end; header and buildRow below must stay positionally zipped.
    'Reviewed',
  ];

  const buildRow = (row: ReconciliationRow): string[] => {
    const orig = row.originalCognos;
    const emailAction = emailActionsByRow.get(row.id);
    const isDisagree = !row.TAA_COGNOS_AGREE;

    const employee = `${orig['NAME'] || 'Staff'}\nPF: ${orig['PF NO'] || ''} • CMS: ${orig['LOGIN ID'] || ''} • Sec: ${orig['SECTION'] || ''}`;
    const date = (orig['SIGN IN DATE'] || '').split(' ')[0];

    let category = CATEGORY_BADGE_LABELS[row.TAA_RESULT_CATEGORY] || row.TAA_RESULT_CATEGORY;
    if (row.holdReason) {
      category += `\n${isForcedHoldReason(row.holdReason) ? 'Locked' : 'Held'}: ${row.holdReason}`;
    }

    const cognosOriginal = `Sch: ${orig['SCH DURATION'] || orig['DUTY1'] || ''}\nLate: ${orig['LATE START'] || '0'}m | Early: ${orig['LEFT EARLY'] || '0'}m`;

    let recomputed = `Net: ${row.TAA_SCH_HOURS_FORMATTED} (${row.TAA_EFFECTIVE_START}–${row.TAA_EFFECTIVE_END})\nLate: ${row.TAA_LATE_MIN}m | Early: ${row.TAA_EARLY_MIN}m`;
    if (isDisagree) recomputed += `  [${describeDisagreement(row)}]`;

    const actualPunches = row.TAA_CMS_IN
      ? `In: ${row.TAA_CMS_IN}\nOut: ${row.TAA_CMS_OUT || 'None'}`
      : 'No Punches';

    let finalAction = `${row.TAA_ACTION}\n${row.TAA_USERNAME ? `@${row.TAA_USERNAME}` : ''}`;
    if (row.TAA_IS_TERMINATED) finalAction += '  [TERMINATED]';

    // The on-screen "Details" column is a click-to-expand trace toggle, not
    // a data field — this is the closest single-cell equivalent, built from
    // the same fields the trace modal's header surfaces.
    const details = [row.details.ruleFired, row.TAA_VERDICT, row.TAA_DISAGREE_REASON]
      .filter(Boolean)
      .concat(row.TAA_MISMATCH_COLUMNS ? [`Mismatch: ${row.TAA_MISMATCH_COLUMNS}`] : [])
      .join('\n');

    return [
      row.includeInOutput ? 'Yes' : 'No',
      emailAction ? emailAction.communication_rule : '-',
      employee,
      date,
      row.TAA_TIER,
      category,
      cognosOriginal,
      recomputed,
      actualPunches,
      finalAction,
      details,
      // WP3 — appended at the end (see header comment above).
      row.reviewCompleted ? 'Yes' : 'No',
    ];
  };

  const buildSheet = (name: string, filteredRows: ReconciliationRow[]) => ({
    name,
    rows: [header, ...filteredRows.map(buildRow)],
  });

  return [
    buildSheet('All', rows),
    // D15/WP4 — correction-based, not category-only (same shape as "2. Late +
    // Cover" below): the flex Branch B shift-time rewrite lands its row in
    // LATE_AND_COVER_ADDED, not SHIFT_CHANGED, but still carries a genuine
    // 'shift' 10/11 pair — the category test alone hid 18 of 40 real shift
    // changes. `|| rowHasShiftChangeCorrection` is a superset, never a filter.
    buildSheet('1. Shift Changed', rows.filter(r => r.TAA_RESULT_CATEGORY === 'SHIFT_CHANGED' || rowHasShiftChangeCorrection(r))),
    // Correction-based, not category-based (mirrors "OT Updates" below): a row
    // retained via config.retainLateCoverOnAbsent carries BOTH a Late/Logoff+
    // Cover correction AND a final MARKED_ABSENT category, so it must show up
    // here too, not just under "3. Absent" — otherwise a reviewer auditing
    // this tab would never see the cover that was actually placed.
    buildSheet('2. Late + Cover', rows.filter(rowHasLateCoverCorrection)),
    buildSheet('3. Absent', rows.filter(r => r.TAA_RESULT_CATEGORY === 'MARKED_ABSENT')),
    buildSheet('4. No Action', rows.filter(r => r.TAA_RESULT_CATEGORY === 'NO_ACTION_REQUIRED')),
    buildSheet('5. Data Gap', rows.filter(r => r.TAA_RESULT_CATEGORY === 'COGNOS_DATA_GAP')),
    buildSheet('Held for Review', rows.filter(r => !!r.holdReason)),
    buildSheet('OT Updates', rows.filter(r => r.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS') || r.TAA_ACTIONS_FIRED.includes('OT_TO_SHIFT'))),
    // D19/B7/B12 — a duplicate view, never a move: a row keeps its own
    // category sheet AND appears here when it also qualifies for Must Check.
    buildSheet('Must Check', rows.filter(rowIsMustCheck)),
  ];
}
