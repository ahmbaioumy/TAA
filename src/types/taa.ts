// Adding a value here? It must appear in the Hold Policy tab (src/services/holdPolicy.ts's
// StaffCategory/tabs, built from this same array) — see doc/PRD.md §Hold Policy "Extending"
// checklist. A missing tier fails holdPolicy.test.ts with a pointer message before it can
// ship silently. FLEX is a separate StaffCategory in the Hold Policy tab (row.TAA_TIER
// already folds isFlex in ahead of any RoleTier value — see determineRoleTier/isFlexStaff
// in reconciliationEngine.ts), so it is deliberately NOT listed here.
export const ROLE_TIERS = ['OPS', 'OFFICER_PLUS'] as const;
export type RoleTier = (typeof ROLE_TIERS)[number];

export type SegmentHoursRole = 'ADDITION' | 'REMOVAL' | 'NO_EFFECT';

// Adding a value here? It must appear in the Hold Policy tab (src/services/holdPolicy.ts's
// ACTION_POLICY_GROUP map) — see doc/PRD.md §Hold Policy "Extending" checklist. A missing
// action fails holdPolicy.test.ts with a pointer message before it can ship silently.
export type TaaActionCode =
  | 'NO_ACTION'
  | 'LATE_AND_COVER'
  | 'ABSENT_SEGMENT'
  | 'ABSENT_NS_NC'
  | 'LOGOFF_AND_COVER'
  | 'ADJUST_OT_RLS'
  | 'OT_TO_SHIFT'
  | 'SHIFT_UPDATE_FLEX'
  | 'SHIFT_UPDATE_AND_LATE_COVER_FLEX'
  | 'MANUAL_REVIEW_REQUIRED';

export type TaaResultCategory =
  | 'SHIFT_CHANGED'
  | 'LATE_AND_COVER_ADDED'
  | 'MARKED_ABSENT'
  | 'NO_ACTION_REQUIRED'
  | 'COGNOS_DATA_GAP';

export type CommunicationRule = 'NA' | 'EMAIL_OPS' | 'EMAIL_STAFF_CC_MANAGER';

export type EmailTemplateKey =
  | 'late_login_absence'
  | 'early_logout_absence'
  | 'late_logout_absence'
  | 'no_login_ns_nc'
  | 'single_punch_absence'
  | 'cover_not_attended'
  | 'generic'
  | 'ops_digest'
  | 'improper_login_logout';

export interface EmailTemplateContent {
  subject: string;
  body: string;
}

export type EmailTemplateRegistry = Record<EmailTemplateKey, EmailTemplateContent>;

// §Phase 3 — recompute-then-compare column comparison
export type ColumnComparisonStatus = 'MATCH' | 'MISMATCH' | 'COGNOS_BLANK' | 'NOT_COMPARABLE';

/** How a LEAVE TYPE comparison reached MATCH (or why it didn't) — returned as typed
 * data from compareCognosRow, never re-derived later by parsing note text. EXACT =
 * the Cognos value equals an identified ASPECT leave code verbatim. MAPPED = a
 * configured cognosLeaveTypeMappings entry connects them. NON_WORKING = neither side
 * has leave, but Cognos names a configured non-working (not-leave) code the day also
 * carries (the OFF case). VERDICT = both sides report an absence verdict (e.g.
 * U-ABSENT vs Absent NS/NC) — same conclusion, different spelling. NONE = no basis
 * matched (MISMATCH, COGNOS_BLANK, or NOT_COMPARABLE). */
export type LeaveTypeMatchBasis = 'EXACT' | 'MAPPED' | 'NON_WORKING' | 'REMOVAL_CODE' | 'VERDICT' | 'NONE';

/**
 * Hold Policy grouping for a compared Cognos column (doc/PRD.md §Hold Policy). Set by
 * compareCognosRow (cognosComparison.ts) via a typed column->group map — holdPolicy.ts only
 * READS this, never re-parses column text. 'OTHER' is the default for any column not yet
 * mapped, so a newly-added compared column still renders (as an auto "Other column" row)
 * instead of silently falling outside every policy group.
 * Adding a new compared Cognos column? Map it here (COLUMN_POLICY_GROUP in
 * cognosComparison.ts) — see doc/PRD.md §Hold Policy "Extending" checklist.
 */
export type PolicyGroup = 'SHIFT' | 'LATE_EARLY' | 'SCHEDULE' | 'SIGN_IN' | 'LEAVE' | 'OTHER';

export interface ColumnComparison {
  column: string; // Cognos column header this compares against
  cognosRaw: string;
  recomputedRaw: string; // formatted for display
  recomputedMinutes?: number; // numeric form when applicable, for tolerance checks
  status: ColumnComparisonStatus;
  note?: string;
  /** Hold Policy column group (see PolicyGroup) — stamped on every entry by
   * compareCognosRow before it returns; optional only so intermediate object literals
   * inside compareCognosRow type-check before that stamping pass runs. Every consumer
   * (holdPolicy.ts) must default a missing value to 'OTHER'. */
  policyGroup?: PolicyGroup;
}

// Adding a value here? It must appear in the Hold Policy tab (src/services/holdPolicy.ts —
// rows are built from HOLD_REASON_TEXT, reconciliationEngine.ts) — see doc/PRD.md §Hold
// Policy "Extending" checklist. A missing reason fails holdPolicy.test.ts with a pointer
// message before it can ship silently. Forced (evidence) reasons also need FORCED_HOLD_REASONS
// (holdReasons.ts) to stay locked in the tab.
export type HoldReasonCode =
  | 'MISMATCH_FOUND'
  | 'COGNOS_DATA_GAP'
  | 'UNCLASSIFIED_SEGMENT_CODE'
  | 'INSUFFICIENT_CMS_COVERAGE'
  | 'UNPARSEABLE_SIGN_IN_DATE'
  | 'MISSING_CMS_JOIN_KEY'
  | 'AMBIGUOUS_PUNCH_ATTRIBUTION'
  | 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW'
  | 'MID_SHIFT_REMOVAL_SEGMENT'
  | 'REMOVAL_SEGMENT_DURATION_UNKNOWN'
  | 'SEGMENT_STOP_DURATION_DISAGREE'
  | 'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION'
  | 'NO_LOGIN_MANUAL_REVIEW_CONFIGURED'
  | 'CONTESTED_SINGLE_PUNCH'
  | 'INVALID_ASPECT_DATETIME'
  | 'INVALID_CONFIG_TIME'
  | 'INVALID_CONFIG_VALUE'
  | 'FLEX_SCHEDULE_OUTSIDE_WINDOW'
  | 'MIXED_LEAVE_AND_WORK_SEGMENTS'
  | 'PUBLIC_HOLIDAY_SHIFT_MISCODED'
  | 'NEGATIVE_NET_SCHEDULE_MINUTES'
  | 'AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS'
  | 'CONFLICTING_IDENTITY_RECORD'
  | 'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS'
  | 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY'
  | 'STILL_CLOCKED_IN'
  | 'ABSENT_MARKED_BUT_ATTENDED'
  | 'TECHNICAL_SEGMENT_COVERS_VARIANCE';

/**
 * Codes produced by the unseen-punch audit (src/services/unseenPunchAudit.ts), which runs
 * AFTER runReconciliation as a separate pass over its output — the engine itself never emits
 * these. Kept out of HoldReasonCode deliberately: reconciliationEngine.ts's HOLD_REASON_TEXT
 * dictionary is typed `Record<HoldReasonCode, string>` (exhaustive), so folding an
 * engine-can-never-produce code into that union would force an edit to the engine file, which
 * is off-limits for this feature. ReconciliationRow.holdReason accepts this union alongside
 * HoldReasonCode instead.
 */
export type AuditHoldReasonCode = 'UNSEEN_PUNCH_OUTCOME';

/** Tri-state reviewer marker, UI-only (see ReconciliationRow.reviewStatus). Cycles
 * NOT_TOUCHED → PENDING → REVIEWED → NOT_TOUCHED via nextReviewStatus(). */
export type ReviewStatus = 'NOT_TOUCHED' | 'PENDING' | 'REVIEWED';

export type TaaSectionSource = 'COGNOS_SECTION' | 'ASPECT_EMP_EXTRA_4_FALLBACK' | 'NONE';

/** Where a REMOVAL (release/nursing) segment sits relative to the day's ADDITION window.
 * MID means it carves out of the middle of the shift (and is not chained to a removal at
 * either end) — its minutes are deducted from scheduled hours, but the effective window is
 * NOT moved, since subtracting it from the END would fabricate an early/late-logout finding.
 * OT_INTERNAL means it falls entirely inside the OT1/OT2 window(s) — the mid-shift risk
 * does not apply (no attendance anchor sits inside overtime to fabricate a finding against),
 * so it reduces netScheduledMinutes and is left for Rule 8 (RLS-over-OT) to correct, instead
 * of being held.
 * FULL_DAY means a duration-less, timestamp-less removal (a "full-day" segment): it takes the
 * day's whole remaining schedule, so it is never positioned against the shift window. */
export type RemovalPosition = 'LEADING' | 'TRAILING' | 'MID' | 'OUT_OF_WINDOW' | 'OT_INTERNAL' | 'FULL_DAY';

/** One REMOVAL segment's contribution to the effective window, spelled out for the audit
 * trail: which segment, where it sits, how many minutes it removed, and where those minutes
 * came from (the segment's own DURATION field, or derived from its timestamps). */
export interface RemovalTraceEntry {
  segCode: string;
  start: string; // '' when the segment carries no parseable START_MOMENT
  stop: string;
  position: RemovalPosition;
  minutes: number;
  minutesSource: 'DURATION' | 'TIMESTAMPS' | 'FULL_DAY_SCHEDULE' | 'FULL_DAY_DEFAULT' | 'UNKNOWN';
  /** Set when DURATION and (STOP - START) disagree by more than the tolerance. */
  durationDisagreementMinutes?: number;
}

/** Per-row arithmetic trace (Phase A of the variance audit). Every number that feeds a
 * late/early/late-logout verdict, with the anchor it was measured from, so a payroll
 * reviewer can reproduce the verdict by hand without reading the code. */
export interface VarianceTrace {
  rawStart: string;
  rawEnd: string;
  effectiveStart: string;
  effectiveEnd: string;
  leadingReleaseMinutes: number;
  trailingReleaseMinutes: number;
  nursingMinutes: number;
  /** Minutes subtracted by OT_INTERNAL removals (a release fully inside OT1/OT2) —
   * see DayScheduleRecompute.otInternalRemovalMinutes for the reconciliation this
   * exists to support. */
  otInternalRemovalMinutes: number;
  removals: RemovalTraceEntry[];
  actualFirstLogin: string;
  actualLastLogout: string;
  attendanceSpanMinutes: number;
  /** Phase 9 (informational only): sum of each attributed CLOSED punch's own login->logout
   * duration — the same quantity Cognos's own SIGNIN DURATION measures. Shown ALONGSIDE
   * (never replacing) attendanceSpanMinutes in the trace UI; null when there is no
   * closed-punch evidence to compute it from. UI-only — never feeds a verdict or an export. */
  staffedMinutes: number | null;
  punchCount: number;
  /** Each measured variance: what was measured, the anchor timestamp it was measured
   * from, the minutes produced, and the policy band (if any) that matched. */
  measurements: {
    label: 'LATE_LOGIN' | 'EARLY_LOGIN' | 'EARLY_LOGOUT' | 'LATE_LOGOUT' | 'FLEX_PAST_CUTOFF' | 'COVER_NOT_ATTENDED';
    anchorLabel: string; // e.g. 'effectiveEnd (raw end minus release/nursing)'
    anchorTime: string;
    comparedTo: string;
    minutes: number;
    bandId?: string;
    bandDescription?: string;
    bandAction?: string;
  }[];
}

export interface AspectSegment {
  PRI_INDEX?: number;
  EMP_SK?: string;
  EMP_ID: string;
  EMP_LAST_NAME?: string;
  EMP_FIRST_NAME?: string;
  EMP_SORT_NAME?: string;
  EMP_SHORT_NAME?: string;
  EMP_SENIORITY?: string;
  EMP_EFF_HIRE_DATE?: string;
  NOM_DATE: string; // DD/MM/YYYY
  START_DATE: string; // DD/MM/YYYY
  SEG_CODE: string;
  START_MOMENT?: string; // DD/MM/YYYY HH:MM:SS or DD/MM/YYYY
  STOP_MOMENT?: string;
  DURATION?: number; // integer minutes
  /** True when the raw DURATION cell was non-blank but failed to parse as a whole
   * number (e.g. "480.9", "480garbage") — distinct from a genuinely blank/absent
   * DURATION. DURATION itself is undefined in both cases; this flag lets the engine
   * tell "nothing was there" apart from "something invalid was there and got
   * discarded", so a repair from timestamps can be surfaced instead of silent. */
  DURATION_TEXT_MALFORMED?: boolean;
  // Phase 4 fix: MEMO deliberately removed — verified unused by any
  // reconciliation logic (only ever displayed/mapped), and real exports carry
  // large pasted-email blobs in it (924 rows in a 10.3MB sample file) that
  // otherwise sat in memory for the whole session for no purpose.
  RANK?: number;
  EMP_CLASS_1?: string;
  EMP_CLASS_1_DESCR?: string;
}

export interface AspectIdentity {
  PRI_INDEX?: number;
  EMP_SK?: string;
  EMP_ID: string; // trimmed join key
  EMP_LAST_NAME: string;
  EMP_FIRST_NAME?: string;
  EMP_SORT_NAME?: string;
  EMP_SHORT_NAME?: string;
  EMP_SENIORITY?: string;
  EMP_EFF_HIRE_DATE?: string;
  EMP_TERM_DATE?: string;
  EMP_ACTIVE_FLAG?: string;
  EMP_TIME_ZONE?: string;
  EMP_EMAIL_ADR?: string;
  EMP_MEMO?: string;
  EMP_CLASS_1?: string;
  EMP_CLASS_1_DESCR?: string;
  EMP_EXTRA_1?: string;
  EMP_EXTRA_2?: string; // Corporate username alias
  EMP_EXTRA_3?: string; // Legacy badge
  EMP_EXTRA_4?: string; // Section / Dept
  START_DATE?: string;
}

export interface CognosRecord {
  'SIGN IN DATE': string;
  SECTION: string;
  'PF NO': string;
  NAME: string;
  'LOGIN ID': string;
  DUTY1: string;
  OT1: string;
  'DUTY-2': string;
  'OT-2': string;
  'SCH DURATION': string;
  'SIGNIN DURATION': string;
  'SIGIN IN': string;
  'SIGIN OUT': string;
  'LATE START': string;
  'LEFT EARLY': string;
  'LEAVE TYPE': string;
  'LEAVE HR': string;
  REMARK: string;
  [key: string]: string;
}

export interface CMSPunch {
  Date: string;
  LoginID: string;
  LoginTimeStr?: string;
  LogoutTimeStr?: string;
  LoginDateTime: Date;
  /** F4 fix: null when this punch is still open — the CMS export's literal "0"
   * (or blank) Logout Time sentinel, meaning the employee was still clocked in
   * when the export was generated. NEVER "00:00", which is a legitimate
   * cross-midnight logout. Every consumer must treat null as "no logout
   * evidence yet" (the STILL_CLOCKED_IN hold), never guess a time. */
  LogoutDateTime: Date | null;
  /** True exactly when LogoutDateTime is null for the open-logout-sentinel reason above. */
  stillClockedIn?: boolean;
}

export interface SegmentDefinition {
  Rank: number;
  Code: string;
  Description: string;
  DefaultDuration?: number;
  UpdatedBy?: string;
  UpdatedOn?: number;
}

export interface CognosDropRule {
  column: string; // raw Cognos column header to match, e.g. "PF NO", "SECTION", "LEAVE TYPE"
  values: string[]; // wildcard patterns (e.g. "UAE*"), matched case-insensitively against that column
}

export interface SectionMailboxRule {
  section: string; // matched case-insensitively/trimmed against EmailActionItem.section
  mailbox: string;
}

// Optional employee -> manager mailbox mapping, used to fill the CC line on
// EMAIL_STAFF_CC_MANAGER drafts (§4.7). No manager data exists in any source
// file (Cognos, ASPECT) — this was previously resolved live against Exchange
// by the VBA companion. Uploaded once via CSV, same shape/pattern as
// SectionMailboxRule. A row with no match simply means no CC, never an error.
export interface EmployeeManagerRule {
  empId: string; // matched against EmailActionItem.emp_id (Cognos PF NO / ASPECT EMP_ID)
  managerEmail: string;
}

export interface PolicyRuleItem {
  id: string;
  sn?: number;
  segmentType: string; // e.g. "Late Login", "Early logout", etc.
  tier: RoleTier;
  minMinutes?: number;
  maxMinutes?: number;
  conditionDescription: string;
  action: TaaActionCode;
  actionText: string;
  communication: CommunicationRule;
}

export interface GlossaryEntry {
  code: string;
  role: SegmentHoursRole;
  /** @deprecated superseded by ConfigRegistry.nonWorkingDaySegmentCodes /
   * leaveSegmentCodes. Retained only so an older exported config JSON still
   * imports cleanly (one-time migration source) — no longer authoritative,
   * never read by the engine. */
  isLeaveGateExclusion?: boolean;
  isWriteOnlyAction?: boolean; // LATE, ABSENT, etc.
  description?: string;
}

/** One user-configured Cognos LEAVE TYPE -> ASPECT segment code(s) mapping (§Leave
 * Segments page). A Cognos value with no mapping still matches when it equals an
 * identified ASPECT leave code exactly (case/whitespace-insensitive) — a mapping is
 * only needed for a genuine spelling difference, e.g. Cognos "U-ABSENT" meaning
 * ASPECT "UNCERTIFIEDSICK" or "HOSPTLZD". */
export interface CognosLeaveTypeMapping {
  cognosLeaveType: string;
  aspectSegmentCodes: string[];
}

/**
 * Hold Policy (doc/PRD.md §Hold Policy) — per staff-category x hold-reason x action
 * pre-approval of already-understood held rows. `released` lists cell ids the user has
 * unticked ("release this"); anything NOT listed stays held (fail-closed by construction).
 * Cell id = `"<StaffCategory>|<RuleKey>|<ActionGroup>"`:
 *  - StaffCategory = RoleTier | 'FLEX' (row.TAA_TIER already folds isFlex in).
 *  - RuleKey = HoldReasonCode, or for MISMATCH_FOUND a column-group key
 *    `MISMATCH_FOUND:SHIFT|LATE_EARLY|SCHEDULE|SIGN_IN|LEAVE|NO_COLUMN|OTHER` (see PolicyGroup).
 *  - ActionGroup = one of the 6 groups in src/services/holdPolicy.ts's ACTION_POLICY_GROUP.
 * See src/services/holdPolicy.ts for the single module that reads/writes/classifies this.
 */
export interface HoldPolicy {
  released: string[];
}

export interface ConfigRegistry {
  // Policy rules
  policyRules: PolicyRuleItem[];

  /** See HoldPolicy above / src/services/holdPolicy.ts. Default `{ released: [] }` = hold
   * everything (fail-closed) — an older exported config JSON without this field gets the
   * same default via the `...DEFAULT_CONFIG, ...parsed` merge in configRegistry.ts. */
  holdPolicy: HoldPolicy;
  
  // Keyword classifications
  roleTierKeywords: string[]; // ['OFCR', 'OFFICER', 'ANALYST', 'SPECIALIST', 'COORDINATOR', 'SUPERVISOR']
  flexKeywords: string[]; // ['FLX', 'FLIX', 'FLEX', 'FELX']
  
  // Flex parameters (§4.8)
  flexCutoffTime: string; // "10:00" absolute
  flexExpectedSchedStartWindow: { start: string; end: string }; // 07:00 - 10:00
  flexBypassesMinuteBands: boolean; // true
  flexOutsideWindowTreatAsOps: boolean; // true — label a flex-tagged row as OPS (not FLEX) when its schedule falls outside flexExpectedSchedStartWindow; the manual-review hold still applies either way
  /** Flex staff on this weekday need only reducedOfficeHoursRequiredMinutes of CMS
   * login counted from actual first login; the rest of the shift is WFH. */
  reducedOfficeHoursEnabled: boolean;
  /** 0=Sunday .. 6=Saturday (JS Date.getDay()). */
  reducedOfficeHoursDayOfWeek: number;
  reducedOfficeHoursRequiredMinutes: number;
  roundingGridMinutes: number; // 30
  roundingDirection: 'nearest' | 'up' | 'down';
  // Rule 8 (RLS added to OT) rounds the RLS-released portion of an OT segment
  // separately from flex late-arrival snapping above — the user's rule is that
  // segment updates (Shift/RLS/OT) always round, while Late/Cover never does,
  // so this is a distinct knob rather than reusing roundingGridMinutes/roundingDirection.
  segmentUpdateRoundingGridMinutes: number; // 30
  segmentUpdateRoundingDirection: 'nearest' | 'up' | 'down'; // 'up' — never under-count a release
  shiftUpdateOriginalCode: string; // "10"
  shiftUpdateNewCode: string; // "11"
  originalShiftMemo: string; // "OrginalShift"
  updatedShiftMemo: string; // "updatedshift"
  
  // Hours formula & glossary (§4.14)
  segmentGlossary: Record<string, GlossaryEntry>;

  // Full-day segments (no START_MOMENT/STOP_MOMENT, blank DURATION) that are
  // classified ADDITION or REMOVAL in segmentGlossary. Their duration is the
  // day's own scheduled duration (SHIFT + OT + COVER); this value is the
  // FALLBACK, used only when the day has no schedule to take it from.
  // Applied ONLY when a segment's DURATION is undefined AND its glossary role
  // is ADDITION or REMOVAL; NO_EFFECT segments and an explicit DURATION: 0 are
  // never affected.
  defaultFullDaySegmentDurationMinutes: number; // default 480 min (8h)

  // Join & calculation parameters
  /** @deprecated superseded by cmsPunchSearchWindowHours; retained only so an
   * older exported config JSON still parses. Never read by the engine. */
  cmsGraceWindowMinutes?: number;
  leaveLoginThresholdMinutes: number; // default 60 min (§4.6b)
  perBlockGapThresholdMinutes: number; // DUTY1/DUTY-2 comparison-block merge for OT and non-SHIFT additions only (two SHIFT segments never merge) — not per-block attendance penalties

  // Punch attribution (Phase 1) — replaces the old fixed grace window with a
  // symmetric search radius plus an explicit CMS-coverage requirement, so a
  // cross-midnight shift's closing punch is found without an unbounded tail
  // swallowing the *next* shift's login.
  cmsPunchSearchWindowHours: number; // default 5 — ± hours around the ASPECT scheduled window
  /** Unseen-punch audit (src/services/unseenPunchAudit.ts) backstop — a candidate punch more
   * than this many hours beyond its owning ASPECT window's own edge is dropped rather than
   * investigated. Default 8. Never read by the engine itself. */
  unseenPunchMaxReachHours: number;
  /** Neutral ASPECT Memo text (unseenPunchAudit.ts's neutralizeReasonMemos) and the neutral
   * 'improper_login_logout' email template both draw on this — every reason-carrying correction
   * Memo on a REASON- or OUTCOME-flagged row is replaced with this exact text, since the engine's
   * specific reason may be wrong whenever a punch sits outside the search window. Default 'TAA
   * Improper Login/Logout - under review'. Never read by the engine itself. */
  improperPunchMemoText: string;
  cmsRequiredCoverageDaysBefore: number; // default 1 — CMS export must include the day before NOM_DATE
  cmsRequiredCoverageDaysAfter: number; // default 1 — and the day after
  /** @deprecated — ignored; the engine uses cmsPunchSearchWindowHours * 60
   * (see effectiveCmsCoverageGraceMinutes in configRegistry.ts). Retained only
   * so an older exported config JSON still parses. Field default is 4*60. */
  cmsCoverageGraceMinutes: number; // default 4*60 (240)
  /** Upload-time headcount mapping gate (replaces the F03 per-row scope-gap guard,
   * removed 2026-09-09 — user-confirmed CMS is a full-staff export with no per-agent
   * filtering, so "zero CMS punches" is now one standard rule for every row). When
   * true, Calculate is blocked (pending explicit acknowledgement) if the lowest of
   * the Cognos->ASPECT or Cognos->CMS mapping percentages falls below
   * minHeadcountMappingPercent. When false, the check is skipped entirely — no
   * warning, no gate. See assessHeadcountMapping in punchAttribution.ts. */
  validateUploadedHeadcount: boolean; // default true
  minHeadcountMappingPercent: number; // default 70 — 0-100
  minAttendanceSpanMinutes: number; // default 1 — below this, treated as no real attendance evidence
  releaseProximityToleranceMinutes: number; // default 2 — leading/trailing release classification window

  // Recompute-then-compare (Phase 3)
  comparisonToleranceMinutes: number; // default 1 — per-column tolerance before flagging MISMATCH
  cognosSentinelValues: number[]; // default [-480, -540] — Cognos "N/A" placeholders, not real variances
  /** How LATE START / LEFT EARLY sentinel values are detected. 'valueList' = only
   * cognosSentinelValues; 'negatedLeaveHr' = only the structural rule (value === -LEAVE HR);
   * 'both' (default) = either, PLUS a row with no SIGIN IN/SIGIN OUT at all — a value computed
   * from no real attendance data is never a genuine variance to compare. The sentinel is always
   * -LEAVE HR by construction, so a fixed value list alone misses e.g. a 600-minute day (-600). */
  cognosSentinelDetectionMode: 'valueList' | 'negatedLeaveHr' | 'both';
  /** Cognos columns that are structurally blank by design (OT1/OT-2) — TAA
   * fills them ONLY when empty, never overwrites a populated value (§Non-negotiables). */
  cognosBlankFillColumns: string[];
  /** Leave-day comparison (§Non-negotiables, user-confirmed): DUTY1/DUTY-2/SCH DURATION on a
   * leave day are Cognos's paid-leave entitlement, not a roster to attend — comparing them
   * against ASPECT's leave segment (which has no shift) is a guaranteed false mismatch. Default
   * false = suppress those 3 columns as NOT_COMPARABLE on a leave day; LEAVE TYPE/LEAVE HR still
   * compared (those are the genuine pay-affecting checks on a leave day). */
  compareScheduleColumnsOnLeaveDays: boolean;
  /** Leave codes that are structural full-day entries with NO real duration in ASPECT (bare
   * SEG_CODE row, no START_MOMENT/STOP_MOMENT/DURATION) — e.g. real ANNUAL/P/H-LV rows. Comparing
   * their (always-zero) summed duration against Cognos's LEAVE HR would report a fake pay gap on
   * every such row. A leave code NOT in this list (e.g. LEAVE with a real DURATION) is compared
   * normally — a genuine duration mismatch there is real pay. */
  leaveCodesWithoutDuration: string[];
  /** Leave codes where a same-day OT2-only work segment is the documented, normal shape of
   * public-holiday overtime (default P/H-LV; PRD Non-Negotiables "Holiday Overtime") — exempts
   * MIXED_LEAVE_AND_WORK_SEGMENTS when every leave segment on the day is one of these codes AND
   * every worked (Addition) segment is OT2. Deliberately narrow: OT1, COVER, SHIFT, or any leave
   * code not in this list still holds for reviewer approval as a genuine leave/work conflict. */
  publicHolidayOvertimeLeaveCodes: string[];
  /** disagreeReason values (e.g. "DEFECT_1_RELEASE_IGNORED") explicitly exempted from the
   * TAA_COGNOS_AGREE=false hold below. Empty by default (fail-closed) — every row where the
   * legacy disagreement diagnosis forces TAA_COGNOS_AGREE to false is held for review unless a
   * business/vendor decision explicitly adds its disagreeReason here; never inferred. */
  cognosAgreeOverrideExceptions: string[];
  /** Generic leave-container codes (e.g. LEAVE) that describe "on leave" without naming the
   * REASON — when an employee-day carries this code alongside a more specific one (e.g. both
   * LEAVE and ANNUAL), the specific code is preferred for TAA_VERDICT/LEAVE TYPE comparison
   * purposes; the generic one is never picked over a specific one just because it happened to be
   * first in the ASPECT export's row order. */
  genericLeaveContainerCodes: string[];
  /** Codes meaning "do not judge attendance on this day" — the full-day gate (isLeaveDay).
   * Superset of leaveSegmentCodes: also includes non-leave non-working codes such as OFF
   * (a scheduled weekly day off is not leave, but must still stop the tool marking someone
   * absent). Authoritative; supersedes the deprecated GlossaryEntry.isLeaveGateExclusion
   * flag, migrated in once on load/import (see configRegistry.ts). */
  nonWorkingDaySegmentCodes: string[];
  /** Normalized ASPECT codes identified as LEAVE — a proper subset of
   * nonWorkingDaySegmentCodes (every leave code also gates attendance; not every gating
   * code is leave, e.g. OFF). Drives LEAVE TYPE reporting/matching, LEAVE HR, and the
   * MIXED_LEAVE_AND_WORK_SEGMENTS hold — independent of the ADDITION/REMOVAL schedule-hours
   * role, and independent of whether the day also carries a worked Addition segment. */
  leaveSegmentCodes: string[];
  /** Partial-day leave (half-day ANNUAL): a listed code that carries BOTH its own
   * START_MOMENT and STOP_MOMENT on a day that also has a timed Addition (SHIFT/OT) is
   * deducted from that day's schedule as a REMOVAL — positioned leading/trailing like a
   * release, so it moves the effective window and reduces netScheduledMinutes. Only that
   * timed shape: a bare (full-day) or duration-only row of the same code keeps its
   * Segment Glossary role (No Effect for ANNUAL), so full-day leave behaves exactly as
   * before. Reclassifying the code itself as Removal would also turn every bare full-day
   * row into a full-day removal — this list exists so that is never needed. */
  partialDayLeaveDeductionCodes: string[];
  /** ASPECT codes meaning "this employee-day is already tagged absent" (§4.6f Absence
   * Already Recorded). Deliberately separate from nonWorkingDaySegmentCodes/
   * leaveSegmentCodes: ABSENT/Absent NS/NC still carry a SHIFT/OT addition segment
   * alongside them (isLeaveDay requires additionSegments.length === 0, so gate 4.6b
   * never sees these days), and they are TAA's own day-level markers, not a leave
   * type to reconcile LEAVE TYPE against. Provenance-agnostic: it does not matter
   * whether the marker was placed by WFM or by an earlier TAA run — a day already
   * tagged absent must never receive a second, duplicate absence marker or a fresh
   * NS/NC notice regardless of who wrote the first one. Also read by the §4.6e
   * re-run guard (was the hardcoded ABSENT_MARKER_CODES set). */
  existingAbsenceMarkerCodes: string[];
  /** User-managed Cognos LEAVE TYPE -> ASPECT leave code exceptions (§Leave Segments page).
   * Exact normalized equality is always accepted without an entry here; a mapping is only
   * needed when Cognos's spelling differs from any identified ASPECT leave code, e.g.
   * Cognos "U-ABSENT" -> ASPECT "UNCERTIFIEDSICK"/"HOSPTLZD". */
  cognosLeaveTypeMappings: CognosLeaveTypeMapping[];
  /** Cognos LEAVE TYPE values that are Cognos's OWN verdict/false-absence output, not a competing
   * leave code — comparing e.g. Cognos "U-ABSENT" against ASPECT's real "ANNUAL" would manufacture
   * a code-mismatch out of exactly the false-absence pattern this tool exists to correct. When
   * Cognos's LEAVE TYPE is one of these AND ASPECT shows a genuine leave code, the LEAVE TYPE
   * column is NOT_COMPARABLE (see TAA_VERDICT/TAA_DISAGREE_REASON instead), never MISMATCH. */
  cognosLeaveTypeVerdictValues: string[];
  /** COVER is a correction mechanism, not part of the shift's own attendance window. Default
   * false = COVER never extends rawStart/rawEnd (so an unattended cover placed after shift end
   * doesn't push effectiveEnd later and get charged as both an early-logout AND a cover-not-
   * attended finding for the same day). COVER still counts toward netScheduledMinutes either way
   * — the hours formula genuinely needs it. */
  coverExtendsAttendanceWindow: boolean;

  /** Absent + Late/Logoff+Cover co-occurrence (user-confirmed policy decision, superseding
   * the "Absent excludes leftover timed penalties" D2 fix, PRD §4.6d). Default false = today's
   * behavior: when a day's final resultCategory resolves to MARKED_ABSENT, any LATE/Log_off/
   * COVER correction a less-severe rule already pushed for that day is stripped before export
   * (avoids docking a full day's pay AND charging a Late+Cover for the same day). When true,
   * that strip is skipped — the ABSENT marker and the LATE/Log_off/COVER rows are exported
   * together, and the cover reservation they claimed is kept (not released). Uniform across
   * every path that currently strips (standard Late Login/Early Logout/Late Logout, both flex
   * branches, Rule 7 Cover Not Attended) — one generic gate, matching how the strip itself is
   * implemented. Retained rows auto-include exactly like a normal Absent row (no extra hold) —
   * a deliberate, user-confirmed choice; enabling this removes the double-pay-hit protection the
   * D2 fix existed for, uniformly and with no per-row check. */
  retainLateCoverOnAbsent: boolean;

  // Cover placement parameters (§4.11 & §4.12)
  /** Fallback used only when no future SHIFT/OT1/OT2 segment exists for the employee —
   * i.e. the next working day's ASPECT data hasn't been uploaded yet, not that the
   * employee genuinely has no future working day. `sameDay` reuses the normal
   * end-of-last-segment placement logic anchored to the incident day itself and ignores
   * coverFallbackDefaultTime entirely; `nextDirectDay` and `nextWeekMonday` both use it. */
  coverFallbackWhenNoWorkingDayFound: 'sameDay' | 'nextDirectDay' | 'nextWeekMonday';
  coverFallbackDefaultTime: string; // "HH:MM", default "08:00" — used by nextDirectDay/nextWeekMonday only, never sameDay
  coverNotAttendedAction: 'markAbsent' | 'moveCoverForward';
  /** Off by default — preserves the existing next-working-day search unchanged. When on, a
   * LATE_AND_COVER/LOGOFF_AND_COVER first checks whether the agent was already logged in for
   * the full cover duration on the incident day itself (stayed past schedule end after a late
   * login, or arrived before schedule start ahead of an early logout). If that whole window
   * sits inside the agent's own first-login..last-logout span that day, the cover is placed
   * there instead of searching ahead. Otherwise (or if the toggle is off) the existing
   * next-working-day search / coverFallbackWhenNoWorkingDayFound logic runs exactly as today. */
  coverSameDayWhenAlreadyCovered: boolean;
  /** WP2/D5/B8 — a NEWLY assigned COVER (never a proven same-day-worked one, see
   * coverSameDayWhenAlreadyCovered) must land on a working day at least this many days
   * after the run date (ReconciliationInput.processingDate), not merely after the
   * incident date. Default 1. Applies to every fallback in
   * coverFallbackWhenNoWorkingDayFound too — a fallback that would otherwise resolve
   * at or before the floor is pushed forward to the next working day after it. */
  coverMinimumDaysAfterRunDate: number;

  /** WP5/B5/B15 — segment codes (matched via isCodeInConfiguredSet, case-insensitive,
   * trimmed) whose windows count as "technical" outage time an agent could not work
   * around. When every variance interval that actually fired an action on a row (late
   * login, flex past-cutoff, early logout, late logout, or the unattended part of a
   * Cover Not Attended window) sits inside the union of that day's technical segments
   * — within technicalSegmentToleranceMinutes — the row is held under
   * TECHNICAL_SEGMENT_COVERS_VARIANCE instead of exporting the penalty. A config
   * default, never a code literal: any code list behaves identically. Default
   * ['TECH','TECH2'] matches the real data; the codes must still be classified
   * NO_EFFECT in segmentGlossary for the variance to exist in the first place — while
   * they are REMOVAL the window simply moves and this never fires. */
  technicalSegmentCodes: string[];
  /** WP5/B5/B15 — minutes of a fired variance interval allowed to fall OUTSIDE the
   * technical segment coverage before the row is still held for review (i.e. how much
   * slack is tolerated at the edges of the technical window). Default 0: coverage must
   * be exact. Partial coverage below this tolerance still exports the correction, with
   * the shortfall noted in the trace — never silently dropped and never silently held. */
  technicalSegmentToleranceMinutes: number;
  /** Release grid (business rule 2026-09-27): a release is only ever booked on this grid —
   * e.g. 30 => starts/stops at :00 or :30, never 14:35 or 15:22. A releaseGridCodes segment off
   * the grid is FLAGGED (TAA_DISAGREE_REASON RELEASE_OFF_GRID + a trace line), never held and
   * never rounded: TAA still calculates with the release exactly as ASPECT recorded it. 0 turns
   * the check off. */
  releaseGridMinutes: number;
  /** Segment codes the release grid applies to (matched via isCodeInConfiguredSet). */
  releaseGridCodes: string[];

  /** Kill switch for the "held-review reduction" gates (Phases 1-5, 2026-09-24):
   * cognosComparison.ts's SIGNIN staffed-zero MATCH downgrade, LATE START/LEFT EARLY
   * same-direction NOT_COMPARABLE downgrade, SCH DURATION exact-OT/exact-release
   * NOT_COMPARABLE downgrade, and LEAVE TYPE REMOVAL_CODE match basis; and
   * reconciliationEngine.ts's defect1AutoExempt, the "worst-case Cognos" action-neutral
   * gate, and the noAttendanceAllAgree ("nobody worked, all sources agree") gate. Default
   * true (the reduced-holding behavior ships on). When false, every one of those gates is
   * skipped and a row that any of them would have released instead holds exactly as it did
   * before Phase 1 — lets the business revert to the stricter, pre-reduction holding
   * behavior with a config toggle, no code change. Missing from an older exported/imported
   * config JSON defaults to true (see configRegistry.ts's `...DEFAULT_CONFIG, ...parsed`
   * merge). unseenPunchAudit.ts's post-engine re-hold is unaffected either way (it only
   * ever re-holds a row the engine released, harmless whichever way this toggle is set). */
  releaseProvenSafeHolds: boolean;

  // Normal ASPECT output organization code
  aspectNormalActionCode: string; // "00" — inserting a new segment

  // Absent + OT co-occurrence (§4.6c): SegmentCode written when an OT1/OT2
  // segment is converted to a shift segment because that day was marked Absent
  otToShiftConversionCode: string; // "SHIFT"

  // Public-holiday SHIFT miscoding (mirror of §4.6c, reversed): SegmentCode
  // written for the "11" replacement row when a SHIFT segment on a public-
  // holiday-leave day (a code in publicHolidayOvertimeLeaveCodes) is converted
  // because staff was mistakenly scheduled as a normal shift instead of the
  // OT2 holiday overtime the PRD documents. Emitted as a shiftUpdateOriginalCode
  // / shiftUpdateNewCode pair (not a bare insert) so the original SHIFT segment
  // is explicitly retired, not left duplicated alongside the new OT2. Unlike
  // otToShiftConversionCode's caller, this conversion still leaves the row held
  // (PUBLIC_HOLIDAY_SHIFT_MISCODED) for one reviewer approval pass, never
  // auto-included.
  shiftToOt2ConversionCode: string; // "OT2"

  // Cognos drop patterns (default empty — no silent drops §6.6). Per-column,
  // e.g. { column: "PF NO", values: ["UAE*"] } — a row is dropped if ANY rule's
  // column value matches ANY of that rule's wildcard values.
  cognosDropPatterns: CognosDropRule[];

  // Section -> OPS mailbox routing for EMAIL_OPS-communication actions
  // (§4.7/§6.1). Replaces the old single global opsMailbox: EMAIL_OPS cases
  // are pooled per Section into one digest email addressed to that
  // Section's mailbox. A Section with no matching row here has its EMAIL_OPS
  // cases HELD — reported but not drafted. They are never re-routed to the
  // employee, because §4.1 chose OPS precisely to keep the employee and their
  // line manager off the recipient list (see poolEmailOpsActionsBySection in
  // emailDrafts.ts).
  sectionMailboxMap: SectionMailboxRule[];

  // Fallback OPS mailbox for EMAIL_OPS cases whose Section has no row in
  // sectionMailboxMap. Those cases are still pooled per Section+date, but the
  // digest is addressed here instead of being held — still an OPS mailbox,
  // never the employee. Blank = no fallback: unmapped Sections are HELD.
  defaultOpsMailbox: string;

  // Optional employee -> manager mailbox map (§4.7 CC), uploaded via CSV in
  // the Config Registry / Email Config Wizard. No entry for an employee simply
  // means the draft opens with no CC — never an error, never a block.
  employeeManagerMap: EmployeeManagerRule[];

  // Domains trusted enough that stripping their local part safely identifies
  // the same person (§4.7). A personal/unknown domain (e.g. a Hotmail address)
  // is never used this way — its local part can belong to someone else
  // entirely. A domain ending in "." is treated as truncated and prefix-matched.
  emailCorporateDomains: string[];

  // Outlook draft helper (§6.1/§6.3). The browser resolves each recipient and
  // renders the subject/body itself, then downloads a ready-to-open .eml file
  // per draft — no folder permission, no external process, no protocol.
  // Double-clicking the .eml opens it in Outlook as an editable, unsent draft.
  emailTemplates: EmailTemplateRegistry;
  // Retained ONLY so an older exported config JSON (from the removed
  // taa-email: protocol bridge) still imports cleanly — nothing reads these
  // anymore.
  emailDraftProtocolScheme: string;
  emailDraftRequestFileName: string;
  emailDraftStatusFileName: string;
  emailDraftVbsLauncherFileName: string;
  emailDraftStatusPollTimeoutSeconds: number;

  // RETIRED (2026-09-08) — project folder automation (§6.1a) and the
  // RunCMSExport VBA macro it fed are both gone; CMS data is a plain manual
  // upload now. Kept only so an older exported config JSON still imports
  // without error — nothing reads these anymore.
  projectFolderSubfolderNames: { cognos: string; aspect: string; cms: string };
  cognosFolderFileName: string;
  aspectSegmentsFolderFileName: string;
  aspectIdentityFolderFileName: string;
  cmsOutputFileName: string;
  cmsFolderPollIntervalMs: number;
  cmsFolderPollTimeoutMinutes: number;
  cmsPreservedFilePatterns: string[];
  // RETIRED (2026-09-08) — RunCMSExport (Avaya CMS Supervisor COM export) was
  // removed along with the rest of the VBA Companion. Kept only so an older
  // exported config JSON still imports without error.
  cmsProtocolScheme: string;
  cmsVbsLauncherFileName: string;
  cmsAgentListDelimiter: string;
  cmsDateFormatPattern: string;
}

export interface ReconciliationRow {
  id: string;
  // Original 18 Cognos columns
  originalCognos: CognosRecord;
  
  // Appended 18 TAA Analysis columns
  TAA_MARKER: string; // DERIVED_ANALYSIS_DO_NOT_REPLACE_OFFICIAL_REPORT
  TAA_TIER: 'OPS' | 'OFFICER_PLUS' | 'FLEX';
  TAA_OT1: string;
  TAA_OT2: string;
  TAA_SCH_HOURS_RECOMPUTED: number; // in minutes
  TAA_SCH_HOURS_FORMATTED: string; // e.g. "8:00"
  TAA_EFFECTIVE_START: string;
  TAA_EFFECTIVE_END: string;
  TAA_CMS_IN: string;
  TAA_CMS_OUT: string;
  TAA_LATE_MIN: number;
  TAA_EARLY_MIN: number;
  TAA_VERDICT: string;
  TAA_ACTION: TaaActionCode;
  /** D-A: every distinct action code that fired this row, semicolon-joined —
   * TAA_ACTION alone only reports the single most-severe one. */
  TAA_ACTIONS_FIRED: string;
  TAA_RESULT_CATEGORY: TaaResultCategory;
  TAA_COGNOS_AGREE: boolean;
  TAA_DISAGREE_REASON: string;
  TAA_USERNAME: string;
  TAA_SECTION: string;
  TAA_SECTION_SOURCE: TaaSectionSource;
  TAA_ASPECT_SECTION: string;
  TAA_SECTION_MISMATCH: boolean;
  TAA_IS_TERMINATED: boolean;

  // Phase 3 — recompute-then-compare column-by-column validation
  columnComparisons: ColumnComparison[];
  TAA_MISMATCH_COUNT: number;
  TAA_MISMATCH_COLUMNS: string; // semicolon-joined column names
  /** Cognos columns that were blank and filled from the recompute this run
   * (fill-if-blank, §Non-negotiables) — never a column that already had a value. */
  TAA_FILLED_COLUMNS: string;

  // Leave-type reconciliation (§Leave Segments) — the recomputed leave evidence,
  // wired off the same LEAVE TYPE entry in columnComparisons (one source of truth).
  TAA_LEAVE_TYPE_RECOMPUTED: string;
  TAA_LEAVE_TYPE_STATUS: ColumnComparisonStatus;
  TAA_LEAVE_TYPE_MATCH_BASIS: LeaveTypeMatchBasis;

  // Phase 5 — review/approval workflow gating the ASPECT correction output
  includeInOutput: boolean;
  /** 'policy' = released by the Hold Policy tab (applyHoldPolicy, src/services/holdPolicy.ts)
   * — see details.holdPolicyRelease for the reason/category/action that released it. */
  includeDecisionSource: 'auto' | 'user' | 'policy';
  /** WP3 (D12) — a reviewer has looked at this row and signed off on it. One
   * checkbox covers both meanings (B10): for a row with no corrections,
   * ticking sets only this flag; for an actionable row, ticking sets this
   * AND includeInOutput together. Never set true by auto-inclusion — a clean
   * row that is auto-included with no human involved must still export
   * FALSE here, or the column is meaningless. Never persisted outside this
   * run; a fresh reconciliation starts every row at false. */
  reviewCompleted: boolean;
  /** UI-only tri-state review marker for the reviewer's own workflow tracking.
   * Never persisted, never exported (does not feed CSV/xlsx output), and resets
   * to 'NOT_TOUCHED' on every fresh reconciliation run. Independent of
   * reviewCompleted/includeInOutput/includeDecisionSource, which drive exports. */
  reviewStatus: ReviewStatus;
  holdReason?: HoldReasonCode | AuditHoldReasonCode;
  holdReasonText?: string;
  /** Set by the unseen-punch audit only, on either a REASON or OUTCOME flag — explains what was
   * found outside the engine's search window and how it changed (or would have changed) this
   * row. Reviewer-facing note text; never read by the engine. */
  unseenPunchNote?: string;
  /** Set by the unseen-punch audit only. 'REASON' = the ASPECT row stays in output, only its
   * email is held (HELD_UNSEEN_PUNCH). 'OUTCOME' = includeInOutput forced false and
   * holdReason = 'UNSEEN_PUNCH_OUTCOME'. Undefined when the audit found nothing for this row. */
  unseenPunchFlag?: 'REASON' | 'OUTCOME';
  /** Set only when this row's generated COVER correction(s) were placed via the
   * coverFallbackWhenNoWorkingDayFound fallback (no ASPECT data for the next working
   * day) — a short, fixed, deterministic reason string, empty when cover was placed
   * against real future schedule data (or no cover fired at all). */
  coverFallbackNote: string;
  /** Release grid flag (2026-09-27): names every release segment booked off the configured
   * grid (config.releaseGridMinutes), e.g. "RLS 14:35-15:00". Informational only — never a
   * hold, never changes the calculation. Empty/undefined when every release is on the grid. */
  releaseGridNote?: string;

  // Internal calculation details for UI explanation
  details: {
    isFlex: boolean;
    /** Set when the reduced-office-hours early-logout relaxation was actually used for this row. */
    reducedOfficeHoursApplied?: boolean;
    isLeaveDay: boolean;
    hasOvertime: boolean;
    ruleFired?: string;
    punchCount: number;
    rawShiftStart?: string;
    rawShiftEnd?: string;
    rawShiftStartFull?: string;
    rawShiftEndFull?: string;
    cmsFirstLoginFull?: string;
    cmsLastLogoutFull?: string;
    releaseMinutes: number;
    nursingMinutes: number;
    /** See DayScheduleRecompute.otInternalRemovalMinutes — reported separately from
     * releaseMinutes so raw additions - releaseMinutes - nursingMinutes -
     * otInternalRemovalMinutes reconciles to TAA_SCH_HOURS_RECOMPUTED exactly. */
    otInternalRemovalMinutes: number;
    chargedVarianceMinutes: number;
    aspectSegments: AspectSegment[];
    punches: CMSPunch[];
    generatedCorrections: AspectCorrectionRow[];
    isAnomaly?: boolean;
    anomalyReason?: string;
    unclassifiedSegmentCodes?: string[];
    invalidAspectDateTimes?: string[];
    configValidationIssues?: string[];
    sectionSource: TaaSectionSource;
    cognosSection: string;
    aspectIdentitySection: string;
    sectionMismatch: boolean;
    /** True when the day's schedule shape didn't resolve deterministically to a
     * DUTY1/DUTY-2 pair (3+ distinct non-OT blocks, a genuine second shift alongside
     * real OT, or OT itself splitting into more than one block) — see
     * scheduleRecompute.ts's scheduleShapeUnresolved. Comparison-only: never
     * indicates a payroll-affecting problem, only that the annotated report's
     * DUTY1/DUTY-2 comparison couldn't be resolved without guessing. */
    scheduleShapeUnresolved?: boolean;
    coverageSufficient?: boolean;
    /** Phase A variance audit trail — every anchor and every measured minute count. */
    varianceTrace?: VarianceTrace;
    /** Phase 5 (held-review reduction, 2026-09-24) — set ONLY when reconciliationEngine.ts's
     * noAttendanceAllAgree gate actually released this row (skipped the soft hold named here),
     * never inferred by the unseen-punch audit from ruleFired text. The audit
     * (unseenPunchAudit.ts) reads this dedicated marker to re-hold a released row the instant it
     * attaches ANY unseenPunchFlag — an out-of-window punch is itself evidence the "nobody
     * worked" agreement this gate required no longer holds, regardless of whether that punch
     * alone would have changed verdict/action/corrections. */
    noAttendanceGateReleased?: { holdReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY' | 'MIXED_LEAVE_AND_WORK_SEGMENTS' };
    /** Set only by applyHoldPolicy (src/services/holdPolicy.ts) when the Hold Policy tab
     * released this row — the pre-release holdReason, its StaffCategory/ActionGroup, and
     * every RuleKey cell that had to be ticked off for the release (a MISMATCH_FOUND row
     * needs every disagreeing column's group released). Drives ResultsView.tsx's "Released
     * by policy" chip and trace banner; never set for a normally-included or user-included row. */
    holdPolicyRelease?: { reason: string; category: string; actionGroup: string; columnGroups: string[] };
  };
}

export interface AspectCorrectionRow {
  Code: string; // "0" = insert new segment; "10"/"11" = original/updated change pair
  ID: string; // trimmed EMP_ID
  SegmentCode: string; // LATE, COVER, ABSENT, shift, etc.
  // The NOM_DATE of the schedule this correction BELONGS TO in ASPECT (the owning
  // schedule day, not necessarily the incident day). Same-day actions (LATE, Log_off,
  // ABSENT, shift-update pairs) use the incident schedule's own NOM_DATE. A placed
  // COVER is the exception: it belongs to the resolved TARGET working schedule, so
  // nominateDate here is the target day's NOM_DATE — never the original late/early
  // incident's NOM_DATE (the incident date is still preserved in Memo).
  nominateDate: string; // DD/MM/YYYY
  // The PHYSICAL calendar date the correction's own instant falls on. Usually equals
  // nominateDate, but not always: a cross-midnight event, or a COVER placed against an
  // overnight target schedule, can land SegmentDate one calendar day after nominateDate.
  SegmentDate: string; // DD/MM/YYYY
  SegmentStarttime: string; // HH:MM or empty for ABSENT
  Segmentduration: string; // HH:MM, or empty for ABSENT (no fixed duration)
  Memo: string;
  /** COVER placement metadata (2026-09-27) — NEVER exported (generateAspectCorrectionsCsv writes
   * only the named ASPECT fields). A next-working-day COVER is stacked on its target day after the
   * day's last segment (baseStartMs) and after every earlier COVER in the same group (key =
   * employee|target day); reallocateCoverSlots re-stacks each group from the FINAL include set so a
   * held row's unexported COVER never pushes an exported one later, and input row order never
   * matters. fixed = a same-day cover credited against proven attendance: never moved, and its
   * group is left exactly as placed. */
  coverSlot?: { key: string; fixed?: boolean; baseStartMs?: number; durationMin?: number; incidentNomDate?: string };
}

export interface EmailActionItem {
  row_id: string;
  /** The reconciliation row this item belongs to (`ReconciliationRow.id`), carried
   * explicitly rather than parsed back out of `row_id`. A row that fires more than one
   * action gets one item per action, whose `row_id` is `${base_row_id}#${actionCode}` —
   * but `row_id` is NOT safely splittable, because a PF NO can itself contain a `#`
   * (real occurrence: `PF NO = "PT #"` in samples_Files/Cognos.csv), which silently
   * truncated the lookup key and made that row's email un-findable. Every consumer that
   * maps an action back to its row MUST use this field, never string-split `row_id`.
   * On a synthesized pooled `ops_digest` item this equals its own `row_id` — such an
   * item belongs to a Section+date group, not to a single reconciliation row. */
  base_row_id: string;
  template_key: EmailTemplateKey;
  emp_id: string;
  name: string;
  nominate_date: string;
  role_tier: string;
  category: string;
  variance_minutes: number;
  taa_action: string;
  communication_rule: CommunicationRule;
  extra_2_alias: string;
  email_adr: string;
  resolved_username: string;
  login_id: string;
  section: string;
  is_terminated?: boolean;
  subject: string;
  body: string;
  template_warnings?: string[];
  // Final resolved To: recipient (§4.7), computed entirely in the browser —
  // either "username@corporateDomain", a corporate EMP_EMAIL_ADR used as-is,
  // or the plain Cognos NAME when neither is available (Outlook's Check Names
  // then resolves it, which is why a name is safe here but a stripped
  // personal-domain local part is not). Empty when the row is TERMINATED —
  // see the [TERMINATED - VERIFY] subject prefix instead. Always present
  // (possibly empty), never optional — every item needs a definite answer.
  to: string;
  // Manager CC (§4.7), looked up from ConfigRegistry.employeeManagerMap by
  // emp_id. Only ever set for EMAIL_STAFF_CC_MANAGER cases. Absent (not
  // blank) when no mapping exists — that is expected, optional enrichment,
  // never a warning or a review flag.
  cc?: string;
  // Only set on synthesized Section-digest items (template_key: 'ops_digest'),
  // produced by poolEmailOpsActionsBySection. Carries the resolved Section
  // mailbox, which is what the .eml builder addresses the draft to instead
  // of `to` for these items.
  ops_mailbox?: string;
  // True when ops_mailbox is the config's defaultOpsMailbox fallback rather
  // than a Section-specific mapping (the Section had no row in
  // sectionMailboxMap).
  ops_mailbox_is_default?: boolean;
}

export interface VerificationFailedCheck {
  suite: 'regression' | 'trust_matrix';
  id: string;
  name: string;
  expected: string;
  actual: string;
}

export interface VerificationInputSummary {
  name: string;
  record_count: number;
}

export interface VerificationOverrideAudit {
  acknowledged_at: string;
  acknowledgement_phrase: 'PROCEED WITH FAILED CHECKS';
  reason: string;
  regression_passed: number;
  regression_total: number;
  trust_matrix_passed: number;
  trust_matrix_total: number;
  failed_checks: VerificationFailedCheck[];
  inputs: {
    cognos: VerificationInputSummary;
    aspect_segments: VerificationInputSummary;
    aspect_identity: VerificationInputSummary;
    cms: VerificationInputSummary;
  };
}

export interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
}
