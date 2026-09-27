import { ConfigRegistry, PolicyRuleItem, GlossaryEntry, CognosDropRule, SectionMailboxRule, EmployeeManagerRule, CognosLeaveTypeMapping, TaaActionCode } from '../types/taa';
import { DEFAULT_EMAIL_TEMPLATES, normalizeEmailTemplates } from './emailDrafts';
import { parseClockTimeString, parseDelimitedText } from './parsers';
import { lookupGlossary } from './scheduleRecompute';
import { sanitizeHoldPolicy } from './holdPolicy';

export interface ConfigValidationIssue {
  field: string;
  message: string;
  kind: 'time' | 'value' | 'band';
  // Absent = treated as ERROR (blocking), matching every pre-existing check
  // here. Only 'WARNING' is non-blocking — used for policy-band coverage
  // gaps, which are worth a reviewer's glance but don't prevent a Save.
  severity?: 'ERROR' | 'WARNING';
}

/**
 * Which TaaActionCode values reconciliationEngine.ts actually dispatches on for
 * each policy-rule segmentType. The Config Registry UI used to offer every
 * TaaActionCode for every rule row regardless of segmentType — selecting e.g.
 * LOGOFF_AND_COVER or ADJUST_OT_RLS for a "Late Login" rule looked like it fired
 * (variance charged, ruleFired text shown) but produced zero correction output,
 * silently. This is the single source of truth both the dropdown (restrict to
 * these options) and validateConfigForRun (flag anything outside them) use, so
 * the two can never drift back out of sync with each other or with the engine.
 * NO_ACTION is always valid and is not repeated in every entry below.
 */
export const IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE: Record<string, TaaActionCode[]> = {
  'Late Login': ['LATE_AND_COVER', 'ABSENT_SEGMENT'],
  'Early Login': [], // Rule 2 is "No Action" for both tiers — no other action is implemented.
  'Early Logout': ['LOGOFF_AND_COVER', 'ABSENT_SEGMENT'],
  'Late Logout': ['ABSENT_SEGMENT'],
  'No Login Record': ['MANUAL_REVIEW_REQUIRED', 'ABSENT_NS_NC'],
  'No Login or No Logout': ['ABSENT_SEGMENT'],
  'Cover Not Attended': ['ABSENT_SEGMENT'],
  'RLS segment added to OT with no adjustment': ['ADJUST_OT_RLS'],
};

export function implementedActionsForSegmentType(segmentType: string): TaaActionCode[] {
  return ['NO_ACTION', ...(IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE[segmentType] || [])];
}

export const INITIAL_POLICY_RULES: PolicyRuleItem[] = [
  // 1. Late Login - OPS
  {
    id: 'rule-late-ops-band1',
    sn: 1,
    segmentType: 'Late Login',
    tier: 'OPS',
    minMinutes: 6,
    maxMinutes: 60,
    conditionDescription: '6 to 60 minutes',
    action: 'LATE_AND_COVER',
    actionText: 'Mark late & add cover on the next eligible working day (or same day, if the agent already covered it)',
    communication: 'NA',
  },
  {
    id: 'rule-late-ops-band2',
    sn: 1,
    segmentType: 'Late Login',
    tier: 'OPS',
    minMinutes: 61,
    maxMinutes: 99999,
    conditionDescription: '61 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_OPS',
  },
  // 1. Late Login - Officer+
  {
    id: 'rule-late-ofcr-band1',
    sn: 1,
    segmentType: 'Late Login',
    tier: 'OFFICER_PLUS',
    minMinutes: 11,
    maxMinutes: 60,
    conditionDescription: '11 to 60 minutes',
    action: 'LATE_AND_COVER',
    actionText: 'Mark late & add cover on the next eligible working day (or same day, if the agent already covered it)',
    communication: 'NA',
  },
  {
    id: 'rule-late-ofcr-band2',
    sn: 1,
    segmentType: 'Late Login',
    tier: 'OFFICER_PLUS',
    minMinutes: 61,
    maxMinutes: 99999,
    conditionDescription: '61 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 2. Early Login - Both tiers
  {
    id: 'rule-earlyin-ops',
    sn: 2,
    segmentType: 'Early Login',
    tier: 'OPS',
    minMinutes: 0,
    maxMinutes: 99999,
    conditionDescription: 'Any duration',
    action: 'NO_ACTION',
    actionText: 'No Action',
    communication: 'NA',
  },
  {
    id: 'rule-earlyin-ofcr',
    sn: 2,
    segmentType: 'Early Login',
    tier: 'OFFICER_PLUS',
    minMinutes: 0,
    maxMinutes: 99999,
    conditionDescription: 'Any duration',
    action: 'NO_ACTION',
    actionText: 'No Action',
    communication: 'NA',
  },

  // 3. Early Logout - OPS
  {
    id: 'rule-earlyout-ops-band1',
    sn: 3,
    segmentType: 'Early Logout',
    tier: 'OPS',
    minMinutes: 5,
    maxMinutes: 9,
    conditionDescription: '5 to 9 minutes',
    action: 'LOGOFF_AND_COVER',
    actionText: 'Mark log off & add cover on the next eligible working day (or same day, if the agent already covered it)',
    communication: 'NA',
  },
  {
    id: 'rule-earlyout-ops-band2',
    sn: 3,
    segmentType: 'Early Logout',
    tier: 'OPS',
    minMinutes: 10,
    maxMinutes: 99999,
    conditionDescription: '10 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_OPS',
  },
  // 3. Early Logout - Officer+
  {
    id: 'rule-earlyout-ofcr-band1',
    sn: 3,
    segmentType: 'Early Logout',
    tier: 'OFFICER_PLUS',
    minMinutes: 6,
    maxMinutes: 20,
    conditionDescription: '6 to 20 minutes',
    action: 'LOGOFF_AND_COVER',
    actionText: 'Mark log off & add cover on the next eligible working day (or same day, if the agent already covered it)',
    communication: 'NA',
  },
  {
    id: 'rule-earlyout-ofcr-band2',
    sn: 3,
    segmentType: 'Early Logout',
    tier: 'OFFICER_PLUS',
    minMinutes: 21,
    maxMinutes: 99999,
    conditionDescription: '21 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 4. Late Logout - OPS & Officer+
  {
    id: 'rule-lateout-ops',
    sn: 4,
    segmentType: 'Late Logout',
    tier: 'OPS',
    minMinutes: 60,
    maxMinutes: 99999,
    conditionDescription: '1 hour and above (60+ min)',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_OPS',
  },
  {
    id: 'rule-lateout-ofcr',
    sn: 4,
    segmentType: 'Late Logout',
    tier: 'OFFICER_PLUS',
    minMinutes: 60,
    maxMinutes: 99999,
    conditionDescription: '1 hour and above (60+ min)',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 5. No Login Record - OPS & Officer+
  {
    id: 'rule-nologin-ops',
    sn: 5,
    segmentType: 'No Login Record',
    tier: 'OPS',
    conditionDescription: 'No CMS punches recorded',
    action: 'ABSENT_NS_NC',
    actionText: 'Mark Absent NS/NC',
    communication: 'EMAIL_OPS',
  },
  {
    id: 'rule-nologin-ofcr',
    sn: 5,
    segmentType: 'No Login Record',
    tier: 'OFFICER_PLUS',
    conditionDescription: 'No CMS punches recorded',
    action: 'ABSENT_NS_NC',
    actionText: 'Mark Absent NS/NC',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 6. Missing Login or Logout (Single Punch Only)
  {
    id: 'rule-singlepunch-ops',
    sn: 6,
    segmentType: 'No Login or No Logout',
    tier: 'OPS',
    conditionDescription: 'Single punch only',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_OPS',
  },
  {
    id: 'rule-singlepunch-ofcr',
    sn: 6,
    segmentType: 'No Login or No Logout',
    tier: 'OFFICER_PLUS',
    conditionDescription: 'Single punch only',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 7. Cover Not Attended - OPS
  {
    id: 'rule-covermiss-ops-band1',
    sn: 7,
    segmentType: 'Cover Not Attended',
    tier: 'OPS',
    minMinutes: 5,
    maxMinutes: 9,
    conditionDescription: '5 to 9 minutes',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'NA',
  },
  {
    id: 'rule-covermiss-ops-band2',
    sn: 7,
    segmentType: 'Cover Not Attended',
    tier: 'OPS',
    minMinutes: 10,
    maxMinutes: 99999,
    conditionDescription: '10 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_OPS',
  },
  // 7. Cover Not Attended - Officer+
  {
    id: 'rule-covermiss-ofcr-band1',
    sn: 7,
    segmentType: 'Cover Not Attended',
    tier: 'OFFICER_PLUS',
    minMinutes: 6,
    maxMinutes: 19,
    conditionDescription: '6 to 19 minutes',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'NA',
  },
  {
    id: 'rule-covermiss-ofcr-band2',
    sn: 7,
    segmentType: 'Cover Not Attended',
    tier: 'OFFICER_PLUS',
    minMinutes: 20,
    maxMinutes: 99999,
    conditionDescription: '20 minutes and above',
    action: 'ABSENT_SEGMENT',
    actionText: 'Mark Absent',
    communication: 'EMAIL_STAFF_CC_MANAGER',
  },

  // 8. Release Added to OT with No Adjustment
  {
    id: 'rule-rls-ot-ops',
    sn: 8,
    segmentType: 'RLS segment added to OT with no adjustment',
    tier: 'OPS',
    conditionDescription: 'Second shift / OT cancelled by RLS',
    action: 'ADJUST_OT_RLS',
    actionText: 'Adjust the OT duration with RLS',
    communication: 'NA',
  },
  {
    id: 'rule-rls-ot-ofcr',
    sn: 8,
    segmentType: 'RLS segment added to OT with no adjustment',
    tier: 'OFFICER_PLUS',
    conditionDescription: 'Second shift / OT cancelled by RLS',
    action: 'ADJUST_OT_RLS',
    actionText: 'Adjust the OT duration with RLS',
    communication: 'NA',
  },
];

export const DEFAULT_SEGMENT_GLOSSARY: Record<string, GlossaryEntry> = {
  // Schedule-Defining / Additions
  'SHIFT': { code: 'SHIFT', role: 'ADDITION', description: 'Primary scheduled shift container' },
  'COVER': { code: 'COVER', role: 'ADDITION', description: 'Cover segment added to compensate for previous variance' },
  'OT1': { code: 'OT1', role: 'ADDITION', description: 'Regular overtime extending a shift' },
  'OT2': { code: 'OT2', role: 'ADDITION', description: 'Public holiday standalone overtime' },

  // Reductions / Carve-outs
  'RLS': { code: 'RLS', role: 'REMOVAL', description: 'Release staff (hours reduction)' },
  'RLS-2H': { code: 'RLS-2H', role: 'REMOVAL', description: 'Release 2 hours' },
  'RLS-3H': { code: 'RLS-3H', role: 'REMOVAL', description: 'Release 3 hours' },
  'UN_RLS': { code: 'UN_RLS', role: 'REMOVAL', description: 'Unplanned release' },
  // Defect fix: this key (and 12 others below) was previously mixed-case
  // ("Cover_RLS") while parseAspectSegments uppercases every real ASPECT
  // SEG_CODE on import ("COVER_RLS") — a direct Record lookup could never
  // match, so this REMOVAL's minutes were silently never subtracted from
  // real shifts. lookupGlossary() in scheduleRecompute.ts now matches
  // case-insensitively regardless, but the key itself is uppercased too so
  // the Config Registry / Discovery Glossary UI (which still does direct
  // Object.keys()/property access) shows one entry per code, not a
  // duplicate "COVER_RLS discovered" row alongside "Cover_RLS configured".
  'COVER_RLS': { code: 'COVER_RLS', role: 'REMOVAL', description: 'Cover release' },
  'NURSNG': { code: 'NURSNG', role: 'REMOVAL', description: 'Nursing mother hour deduction (trailing)' },
  // Split-shift unpaid gap (decision 2026-09-21). Unclassified, it force-held the row and its
  // minutes stayed in the scheduled hours; on all 5 real sample rows Cognos deducts exactly
  // the SPLIT minutes (60, 90, 60, 180, 60). Typically mid-shift, so it deducts hours
  // without moving the attendance window.
  'SPLIT': { code: 'SPLIT', role: 'REMOVAL', description: 'Split-shift unpaid gap (deducted from scheduled hours)' },

  // Full-Day Leaves / non-working days (§Leave Segments — gate + leave identity now
  // live on ConfigRegistry.nonWorkingDaySegmentCodes/leaveSegmentCodes, not the
  // deprecated isLeaveGateExclusion flag below; kept unset here since it is no
  // longer authoritative).
  'ANNUAL': { code: 'ANNUAL', role: 'NO_EFFECT', description: 'Annual Vacation Leave' },
  'P/H-LV': { code: 'P/H-LV', role: 'NO_EFFECT', description: 'Public Holiday Leave' },
  'OFF': { code: 'OFF', role: 'NO_EFFECT', description: 'Scheduled Weekly Off — non-working, but NOT a leave type (§Leave Segments)' },
  'LEAVE': { code: 'LEAVE', role: 'NO_EFFECT', description: 'General Leave with synthetic window' },
  'PLN_SK': { code: 'PLN_SK', role: 'NO_EFFECT', description: 'Planned Sick Leave' },
  'SICK': { code: 'SICK', role: 'NO_EFFECT', description: 'Sick Leave' },
  'MTN-LV': { code: 'MTN-LV', role: 'NO_EFFECT', description: 'Maternity Leave' },
  'SPL-LV': { code: 'SPL-LV', role: 'NO_EFFECT', description: 'Special Leave' },
  'TRMNTD': { code: 'TRMNTD', role: 'NO_EFFECT', description: 'Terminated employee record' },
  'REGN': { code: 'REGN', role: 'NO_EFFECT', description: 'Resignation' },
  'SUSPND': { code: 'SUSPND', role: 'NO_EFFECT', description: 'Suspended' },
  'ANNL-8': { code: 'ANNL-8', role: 'NO_EFFECT', description: 'Annual Leave 8h' },
  // Seeded leave codes with no prior glossary entry (§Leave Segments) — source-system
  // spelling HOSPTLZD confirmed, both classified NO_EFFECT so the default config
  // validates immediately (a leave code with no schedule-hours classification blocks
  // reconciliation).
  'HOSPTLZD': { code: 'HOSPTLZD', role: 'NO_EFFECT', description: 'Hospitalized Leave' },
  'UNCERTIFIEDSICK': { code: 'UNCERTIFIEDSICK', role: 'NO_EFFECT', description: 'Uncertified Sick Leave' },

  // Informational / Breaks
  'BREAK1': { code: 'BREAK1', role: 'NO_EFFECT', description: 'Scheduled Break 1' },
  'BREAK2': { code: 'BREAK2', role: 'NO_EFFECT', description: 'Scheduled Break 2' },
  'BREAK3': { code: 'BREAK3', role: 'NO_EFFECT', description: 'Scheduled Break 3' },
  'BREAK4': { code: 'BREAK4', role: 'NO_EFFECT', description: 'Scheduled Break 4' },
  'PRY-BK': { code: 'PRY-BK', role: 'NO_EFFECT', description: 'Prayer Break' },
  'BRFNG': { code: 'BRFNG', role: 'NO_EFFECT', description: 'Briefing Session' },
  'CMT': { code: 'CMT', role: 'NO_EFFECT', description: 'Commitment tag' },
  'RTM': { code: 'RTM', role: 'NO_EFFECT', description: 'Real-time Management Holiday Tag' },
  'TRN PLANNED': { code: 'TRN PLANNED', role: 'NO_EFFECT', description: 'Planned Training' },
  'EMAIL': { code: 'EMAIL', role: 'NO_EFFECT', description: 'Email Queue Tag' },

  // Team / queue / campaign tags — pre-classified NO_EFFECT (§8 item 1). Each
  // carries a full shift-length duration overlapping the SAME window as the
  // employee's own SHIFT segment (confirmed against samples_Files/
  // ASPECT_Schdule_Segments.csv), i.e. these describe WHICH team/queue the
  // employee is on during their shift, not additional worked time. Left
  // unclassified they hit UNCLASSIFIED_SEGMENT_CODE and hold every row that
  // carries one for no reason — 562+ segment occurrences in the sample data.
  'PRESTIGE ARB': { code: 'PRESTIGE ARB', role: 'NO_EFFECT', description: 'Team/queue tag: Prestige Arb' },
  '101-EGS': { code: '101-EGS', role: 'NO_EFFECT', description: 'Team/queue tag: 101-EGS' },
  'ES & SMB': { code: 'ES & SMB', role: 'NO_EFFECT', description: 'Team/queue tag: ES & SMB' },
  'RET/CAN-EGS': { code: 'RET/CAN-EGS', role: 'NO_EFFECT', description: 'Team/queue tag: RET/CAN-EGS' },
  'USMB-EGS': { code: 'USMB-EGS', role: 'NO_EFFECT', description: 'Team/queue tag: USMB-EGS' },
  'ECS': { code: 'ECS', role: 'NO_EFFECT', description: 'Team/queue tag: ECS' },
  'PRESTIGE-EGS': { code: 'PRESTIGE-EGS', role: 'NO_EFFECT', description: 'Team/queue tag: Prestige-EGS' },
  'OB-SALES': { code: 'OB-SALES', role: 'NO_EFFECT', description: 'Team/queue tag: OB-Sales' },
  'FLUP': { code: 'FLUP', role: 'NO_EFFECT', description: 'Team/queue tag: FLUP' },
  'E&MONEY AJM': { code: 'E&MONEY AJM', role: 'NO_EFFECT', description: 'Team/queue tag: e&Money Ajm' },
  'DOZ_RET_AR': { code: 'DOZ_RET_AR', role: 'NO_EFFECT', description: 'Team/queue tag: DOZ_RET_AR' },
  'EARLY STAGE': { code: 'EARLY STAGE', role: 'NO_EFFECT', description: 'Team/queue tag: Early Stage' },
  'HIGH CONSP': { code: 'HIGH CONSP', role: 'NO_EFFECT', description: 'Team/queue tag: High Consp' },
  'BILL REV': { code: 'BILL REV', role: 'NO_EFFECT', description: 'Team/queue tag: Bill Rev' },
  'E&MONEY-EGS': { code: 'E&MONEY-EGS', role: 'NO_EFFECT', description: 'Team/queue tag: e&money-EGS' },
  'O_ADHR': { code: 'O_ADHR', role: 'NO_EFFECT', description: 'Adherence/audit tag' },
  'COLLECTION BACK OFFICE': { code: 'COLLECTION BACK OFFICE', role: 'NO_EFFECT', description: 'Team/queue tag: Collection Back Office' },

  // Write-Only Output Codes
  'LATE': { code: 'LATE', role: 'NO_EFFECT', isWriteOnlyAction: true, description: 'Output: Late Arrival Correction' },
  'LOG_OFF': { code: 'LOG_OFF', role: 'NO_EFFECT', isWriteOnlyAction: true, description: 'Output: Early Logout Correction' },
  'ABSENT': { code: 'ABSENT', role: 'NO_EFFECT', isWriteOnlyAction: true, description: 'Output: Full Absence Day Marker' },
  'ABSENT NS/NC': { code: 'ABSENT NS/NC', role: 'NO_EFFECT', isWriteOnlyAction: true, description: 'Output: No Show / No Call Absence' },
};

// §Leave Segments defaults. Seeded from the twelve codes previously flagged
// isLeaveGateExclusion:true, plus the two newly seeded leave codes (HOSPTLZD,
// UNCERTIFIEDSICK — neither existed in the glossary before this feature).
// nonWorkingDaySegmentCodes is the full-day-gate superset (includes OFF);
// leaveSegmentCodes is that same set minus OFF — a scheduled day off is not a
// leave type (user-confirmed), but must still stop the day being judged for
// attendance.
const LEGACY_LEAVE_GATE_CODES = ['ANNUAL', 'P/H-LV', 'OFF', 'LEAVE', 'PLN_SK', 'SICK', 'MTN-LV', 'SPL-LV', 'TRMNTD', 'REGN', 'SUSPND', 'ANNL-8'];
export const DEFAULT_NON_WORKING_DAY_SEGMENT_CODES = [...LEGACY_LEAVE_GATE_CODES, 'HOSPTLZD', 'UNCERTIFIEDSICK'];
export const DEFAULT_LEAVE_SEGMENT_CODES = DEFAULT_NON_WORKING_DAY_SEGMENT_CODES.filter(c => c !== 'OFF');
// §4.6f Absence Already Recorded. Deliberately not part of the two lists above: these
// days still carry a SHIFT/OT addition segment alongside the marker (isLeaveDay
// requires additionSegments.length === 0), and the marker is a day-level "already
// actioned" flag, not a leave type to reconcile LEAVE TYPE against.
export const DEFAULT_EXISTING_ABSENCE_MARKER_CODES = ['ABSENT', 'Absent NS/NC'];
export const DEFAULT_COGNOS_LEAVE_TYPE_MAPPINGS: CognosLeaveTypeMapping[] = [
  { cognosLeaveType: 'U-ABSENT', aspectSegmentCodes: ['UNCERTIFIEDSICK', 'HOSPTLZD'] },
];

export const DEFAULT_CONFIG: ConfigRegistry = {
  policyRules: INITIAL_POLICY_RULES,
  roleTierKeywords: ['OFCR', 'OFFICER', 'ANALYST', 'SPECIALIST', 'COORDINATOR', 'SUPERVISOR'],
  flexKeywords: ['FLX', 'FLIX', 'FLEX', 'FELX'],
  
  flexCutoffTime: '10:00',
  flexExpectedSchedStartWindow: { start: '07:00', end: '10:00' },
  flexBypassesMinuteBands: true,
  flexOutsideWindowTreatAsOps: true,
  roundingGridMinutes: 30,
  roundingDirection: 'nearest',
  segmentUpdateRoundingGridMinutes: 30,
  segmentUpdateRoundingDirection: 'up',
  shiftUpdateOriginalCode: '10',
  shiftUpdateNewCode: '11',
  originalShiftMemo: 'OrginalShift',
  updatedShiftMemo: 'updatedshift',

  segmentGlossary: DEFAULT_SEGMENT_GLOSSARY,
  defaultFullDaySegmentDurationMinutes: 480,

  leaveLoginThresholdMinutes: 60,
  perBlockGapThresholdMinutes: 60,

  cmsPunchSearchWindowHours: 5,
  unseenPunchMaxReachHours: 8,
  improperPunchMemoText: 'TAA Improper Login/Logout - under review',
  cmsRequiredCoverageDaysBefore: 1,
  cmsRequiredCoverageDaysAfter: 1,
  // Deprecated/ignored (kept only so old saved/exported configs still load —
  // see cmsCoverageGraceMinutes in src/types/taa.ts). The engine always uses
  // effectiveCmsCoverageGraceMinutes(config) = cmsPunchSearchWindowHours * 60
  // (user decision: one linked setting, not two).
  cmsCoverageGraceMinutes: 4 * 60,
  validateUploadedHeadcount: true,
  minHeadcountMappingPercent: 70,
  minAttendanceSpanMinutes: 1,
  reducedOfficeHoursEnabled: true,
  reducedOfficeHoursDayOfWeek: 5,
  reducedOfficeHoursRequiredMinutes: 240,
  releaseProximityToleranceMinutes: 2,

  comparisonToleranceMinutes: 1,
  cognosSentinelValues: [-480, -540],
  cognosSentinelDetectionMode: 'both',
  cognosBlankFillColumns: ['OT1', 'OT-2'],
  compareScheduleColumnsOnLeaveDays: false,
  leaveCodesWithoutDuration: ['ANNUAL', 'P/H-LV', 'OFF'],
  publicHolidayOvertimeLeaveCodes: ['P/H-LV'],
  cognosAgreeOverrideExceptions: [],
  genericLeaveContainerCodes: ['LEAVE'],
  cognosLeaveTypeVerdictValues: ['U-ABSENT', 'Absent NS/NC', 'ABSENT'],
  nonWorkingDaySegmentCodes: DEFAULT_NON_WORKING_DAY_SEGMENT_CODES,
  leaveSegmentCodes: DEFAULT_LEAVE_SEGMENT_CODES,
  partialDayLeaveDeductionCodes: ['ANNUAL'],
  existingAbsenceMarkerCodes: DEFAULT_EXISTING_ABSENCE_MARKER_CODES,
  cognosLeaveTypeMappings: DEFAULT_COGNOS_LEAVE_TYPE_MAPPINGS,
  coverExtendsAttendanceWindow: false,
  retainLateCoverOnAbsent: false,

  coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday',
  coverFallbackDefaultTime: '08:00',
  coverNotAttendedAction: 'markAbsent',
  coverSameDayWhenAlreadyCovered: false,
  coverMinimumDaysAfterRunDate: 1,

  technicalSegmentCodes: ['TECH', 'TECH2'],
  technicalSegmentToleranceMinutes: 0,
  releaseGridMinutes: 30,
  releaseGridCodes: ['RLS', 'RLS-2H', 'RLS-3H', 'UN_RLS', 'Cover_RLS'],

  releaseProvenSafeHolds: true,

  holdPolicy: { released: [] }, // Hold Policy tab (doc/PRD.md §Hold Policy) — default hold everything

  aspectNormalActionCode: '00',
  otToShiftConversionCode: 'SHIFT', // §4.6c Absent + OT co-occurrence
  shiftToOt2ConversionCode: 'OT2', // Public-holiday SHIFT miscoding (mirror, reversed)
  cognosDropPatterns: [], // Default empty §6.6 — no silent drops until user opts in

  sectionMailboxMap: [],
  employeeManagerMap: [],
  emailCorporateDomains: ['thecontactcentre.ae'],

  emailTemplates: DEFAULT_EMAIL_TEMPLATES,
  emailDraftProtocolScheme: 'taa-email',
  emailDraftRequestFileName: 'TAA_Email_Draft_Request.json',
  emailDraftStatusFileName: 'TAA_Email_Draft_Status.json',
  emailDraftVbsLauncherFileName: 'TAA_Email_Launcher.vbs',
  emailDraftStatusPollTimeoutSeconds: 20,

  // RETIRED (2026-09-08) — folder automation and RunCMSExport are both gone;
  // kept only so an older exported config JSON still imports without error.
  projectFolderSubfolderNames: { cognos: 'Cognos', aspect: 'ASPECT', cms: 'CMS' },
  cognosFolderFileName: 'Cognos_DescrepencyReport_LATEST.csv',
  aspectSegmentsFolderFileName: 'ASPECT_Schdule_Segments_LATEST.csv',
  aspectIdentityFolderFileName: 'ASPECT_ExtraFiled_LATEST.csv',
  cmsOutputFileName: 'CMS_Login_logout_LATEST.csv',
  cmsFolderPollIntervalMs: 3000,
  cmsFolderPollTimeoutMinutes: 15,
  cmsPreservedFilePatterns: ['*.xlsm', '*.vbs', 'Install_TAA_Protocol.bat'],
  cmsProtocolScheme: 'taa-cms',
  cmsVbsLauncherFileName: 'TAA_CMS_Launcher.vbs',
  cmsAgentListDelimiter: ',',
  cmsDateFormatPattern: 'DD/MM/YYYY',
};

/** Coverage grace always equals the CMS punch search window (user decision: one linked setting). */
export function effectiveCmsCoverageGraceMinutes(config: ConfigRegistry): number {
  return config.cmsPunchSearchWindowHours * 60;
}

function minutesFromClock(value: string): number | null {
  const parsed = parseClockTimeString(value);
  return parsed ? parsed.hours * 60 + parsed.minutes : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerNumber(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

/**
 * Fail-closed checks for Config Registry values that feed schedule math,
 * punch attribution, or email-adjacent output routing. The engine uses this
 * before any calculation so an unsafe value can never produce NaN dates,
 * unbounded attribution, or payroll correction rows.
 */
export function validateConfigForRun(config: ConfigRegistry): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  const requireClock = (field: string, value: string | undefined) => {
    if (!value || !parseClockTimeString(value)) {
      issues.push({ field, kind: 'time', message: `${field} must be a valid HH:MM wall-clock value.` });
    }
  };
  const requirePositiveInt = (field: string, value: unknown) => {
    if (!isIntegerNumber(value) || value <= 0) {
      issues.push({ field, kind: 'value', message: `${field} must be a positive whole number.` });
    }
  };
  const requireNonNegativeInt = (field: string, value: unknown) => {
    if (!isIntegerNumber(value) || value < 0) {
      issues.push({ field, kind: 'value', message: `${field} must be zero or a positive whole number.` });
    }
  };
  const requirePercent = (field: string, value: unknown) => {
    if (!isIntegerNumber(value) || value < 0 || value > 100) {
      issues.push({ field, kind: 'value', message: `${field} must be a whole number from 0 to 100.` });
    }
  };

  requireClock('flexCutoffTime', config.flexCutoffTime);
  requireClock('flexExpectedSchedStartWindow.start', config.flexExpectedSchedStartWindow?.start);
  requireClock('flexExpectedSchedStartWindow.end', config.flexExpectedSchedStartWindow?.end);
  requireClock('coverFallbackDefaultTime', config.coverFallbackDefaultTime);

  const flexStart = minutesFromClock(config.flexExpectedSchedStartWindow?.start || '');
  const flexEnd = minutesFromClock(config.flexExpectedSchedStartWindow?.end || '');
  if (flexStart !== null && flexEnd !== null && flexStart > flexEnd) {
    issues.push({
      field: 'flexExpectedSchedStartWindow',
      kind: 'value',
      message: 'flexExpectedSchedStartWindow.start must be at or before flexExpectedSchedStartWindow.end on the same day.',
    });
  }

  requirePositiveInt('roundingGridMinutes', config.roundingGridMinutes);
  if (isIntegerNumber(config.roundingGridMinutes) && config.roundingGridMinutes > 1440) {
    issues.push({ field: 'roundingGridMinutes', kind: 'value', message: 'roundingGridMinutes must not exceed one day (1440 minutes).' });
  }
  requirePositiveInt('reducedOfficeHoursRequiredMinutes', config.reducedOfficeHoursRequiredMinutes);
  if (isIntegerNumber(config.reducedOfficeHoursRequiredMinutes) && config.reducedOfficeHoursRequiredMinutes > 1440) {
    issues.push({ field: 'reducedOfficeHoursRequiredMinutes', kind: 'value', message: 'reducedOfficeHoursRequiredMinutes must not exceed one day (1440 minutes).' });
  }
  if (!isIntegerNumber(config.reducedOfficeHoursDayOfWeek) || config.reducedOfficeHoursDayOfWeek < 0 || config.reducedOfficeHoursDayOfWeek > 6) {
    issues.push({ field: 'reducedOfficeHoursDayOfWeek', kind: 'value', message: 'reducedOfficeHoursDayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).' });
  }
  requirePositiveInt('segmentUpdateRoundingGridMinutes', config.segmentUpdateRoundingGridMinutes);
  if (isIntegerNumber(config.segmentUpdateRoundingGridMinutes) && config.segmentUpdateRoundingGridMinutes > 1440) {
    issues.push({ field: 'segmentUpdateRoundingGridMinutes', kind: 'value', message: 'segmentUpdateRoundingGridMinutes must not exceed one day (1440 minutes).' });
  }
  requirePositiveInt('cmsPunchSearchWindowHours', config.cmsPunchSearchWindowHours);
  requirePositiveInt('unseenPunchMaxReachHours', config.unseenPunchMaxReachHours);
  if (!config.improperPunchMemoText || !config.improperPunchMemoText.trim()) {
    issues.push({ field: 'improperPunchMemoText', kind: 'value', message: 'improperPunchMemoText must not be blank.' });
  } else if (/[\r\n]/.test(config.improperPunchMemoText)) {
    issues.push({ field: 'improperPunchMemoText', kind: 'value', message: 'improperPunchMemoText must not contain a newline.' });
  }
  requireNonNegativeInt('cmsRequiredCoverageDaysBefore', config.cmsRequiredCoverageDaysBefore);
  requireNonNegativeInt('cmsRequiredCoverageDaysAfter', config.cmsRequiredCoverageDaysAfter);
  // cmsCoverageGraceMinutes is deprecated/ignored (see effectiveCmsCoverageGraceMinutes) — no longer validated.
  requirePercent('minHeadcountMappingPercent', config.minHeadcountMappingPercent);
  requirePositiveInt('minAttendanceSpanMinutes', config.minAttendanceSpanMinutes);
  requirePositiveInt('leaveLoginThresholdMinutes', config.leaveLoginThresholdMinutes);
  requirePositiveInt('defaultFullDaySegmentDurationMinutes', config.defaultFullDaySegmentDurationMinutes);
  requireNonNegativeInt('perBlockGapThresholdMinutes', config.perBlockGapThresholdMinutes);
  requireNonNegativeInt('releaseProximityToleranceMinutes', config.releaseProximityToleranceMinutes);
  requireNonNegativeInt('comparisonToleranceMinutes', config.comparisonToleranceMinutes);
  requireNonNegativeInt('coverMinimumDaysAfterRunDate', config.coverMinimumDaysAfterRunDate);
  requireNonNegativeInt('technicalSegmentToleranceMinutes', config.technicalSegmentToleranceMinutes);
  requireNonNegativeInt('releaseGridMinutes', config.releaseGridMinutes);

  if (!config.aspectNormalActionCode?.trim()) {
    issues.push({ field: 'aspectNormalActionCode', kind: 'value', message: 'aspectNormalActionCode must not be blank.' });
  }
  if (!config.shiftUpdateOriginalCode?.trim()) {
    issues.push({ field: 'shiftUpdateOriginalCode', kind: 'value', message: 'shiftUpdateOriginalCode must not be blank.' });
  }
  if (!config.shiftUpdateNewCode?.trim()) {
    issues.push({ field: 'shiftUpdateNewCode', kind: 'value', message: 'shiftUpdateNewCode must not be blank.' });
  }
  if (!config.otToShiftConversionCode?.trim()) {
    issues.push({ field: 'otToShiftConversionCode', kind: 'value', message: 'otToShiftConversionCode must not be blank.' });
  }
  if (!config.shiftToOt2ConversionCode?.trim()) {
    issues.push({ field: 'shiftToOt2ConversionCode', kind: 'value', message: 'shiftToOt2ConversionCode must not be blank.' });
  }

  // §Leave Segments: every leave code must also gate attendance (leaveSegmentCodes is a
  // subset of nonWorkingDaySegmentCodes — see the type comment on ConfigRegistry), and must
  // carry an explicit schedule-hours classification. Fail-closed, same as every other
  // engine-facing value here — an unclassified leave code would otherwise silently fall
  // through to UNCLASSIFIED_SEGMENT_CODE deep in the recompute instead of a clear message.
  const nonWorkingSet = new Set((config.nonWorkingDaySegmentCodes || []).map(c => (c || '').trim().toUpperCase()));
  (config.leaveSegmentCodes || []).forEach(code => {
    const trimmed = (code || '').trim();
    if (!trimmed) return;
    if (!nonWorkingSet.has(trimmed.toUpperCase())) {
      issues.push({ field: 'leaveSegmentCodes', kind: 'value', message: `Leave code "${trimmed}" must also be listed in nonWorkingDaySegmentCodes — every leave code gates attendance.` });
    }
    if (!lookupGlossary(config.segmentGlossary, trimmed)) {
      issues.push({ field: 'leaveSegmentCodes', kind: 'value', message: `Leave code "${trimmed}" has no schedule-hours classification in the Segment Glossary — classify it before running reconciliation.` });
    }
  });

  // Partial-day leave deduction only applies to a code the engine identifies as leave —
  // a non-leave code here would deduct hours while never being reported as leave.
  const leaveSet = new Set((config.leaveSegmentCodes || []).map(c => (c || '').trim().toUpperCase()));
  (config.partialDayLeaveDeductionCodes || []).forEach(code => {
    const trimmed = (code || '').trim();
    if (!trimmed) return;
    if (!leaveSet.has(trimmed.toUpperCase())) {
      issues.push({ field: 'partialDayLeaveDeductionCodes', kind: 'value', message: `Partial-day leave code "${trimmed}" must also be listed in leaveSegmentCodes.` });
    }
    const role = lookupGlossary(config.segmentGlossary, trimmed)?.role;
    if (role === 'ADDITION') {
      issues.push({ field: 'partialDayLeaveDeductionCodes', kind: 'value', message: `Partial-day leave code "${trimmed}" is classified Addition in the Segment Glossary — a timed row cannot both add and deduct hours.` });
    }
  });

  // Policy-band overlaps/inversions were previously surfaced only in an
  // informational modal (BandIssuesModal) and never blocked Save or a run —
  // the engine's lookupPolicyRule() takes the first matching band, so an
  // overlap silently resolves by row order. ERROR-severity band issues are
  // exactly as blocking as every other check above; WARNING-severity ones
  // (coverage gaps) stay advisory-only.
  validatePolicyBands(config.policyRules || []).forEach(bandIssue => {
    if (bandIssue.severity !== 'ERROR') return;
    issues.push({
      field: `policyRules[${bandIssue.segmentType} / ${bandIssue.tier}]`,
      kind: 'band',
      severity: 'ERROR',
      message: bandIssue.message,
    });
  });

  // A rule whose configured action the engine has no dispatch for looks like it
  // fires (variance charged, ruleFired text shown) but silently produces zero
  // correction output — see IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE above. Defense in
  // depth alongside the UI dropdown restriction, so an already-saved or imported
  // config carrying a stale invalid action still gets caught before a run.
  (config.policyRules || []).forEach(rule => {
    const allowed = implementedActionsForSegmentType(rule.segmentType);
    if (!allowed.includes(rule.action)) {
      issues.push({
        field: `policyRules[${rule.segmentType} / ${rule.tier}].action`,
        kind: 'value',
        severity: 'ERROR',
        message: `Action "${rule.action}" is not implemented for "${rule.segmentType}" — the engine would charge variance but produce no correction. Choose one of: ${allowed.join(', ')}.`,
      });
    }
  });

  return issues;
}

const STORAGE_KEY = 'TAA_CONFIG_REGISTRY_V1';

// Migrates a pre-per-column cognosDropPatterns shape (flat string[] matched
// only against NAME) into the current CognosDropRule[] shape, so an older
// exported/saved config still loads instead of erroring or silently losing
// the user's tuned drop list.
function normalizeCognosDropPatterns(raw: unknown): CognosDropRule[] {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.cognosDropPatterns;
  if (raw.length === 0) return [];
  if (typeof raw[0] === 'string') {
    return [{ column: 'NAME', values: raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) }];
  }
  return raw as CognosDropRule[];
}

function normalizePreservedFilePatterns(raw: unknown): string[] {
  const supplied = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
  return Array.from(new Set([...DEFAULT_CONFIG.cmsPreservedFilePatterns, ...supplied]));
}

// Trims/uppercases each row's section (matching lookupGlossary's uppercase-key
// convention elsewhere in this file) and de-dupes by section, last value
// wins — so a saved/imported config never carries two rows for the same
// section pointing at different mailboxes. Legacy exported configs may still
// carry the old single `opsMailbox` string field; there's no way to guess
// which section it belonged to, so it's simply dropped (ConfigRegistry no
// longer has that field in its type).
export function normalizeSectionMailboxMap(raw: unknown): SectionMailboxRule[] {
  if (!Array.isArray(raw)) return [];
  const bySection = new Map<string, string>();
  raw.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const section = String((entry as SectionMailboxRule).section || '').trim().toUpperCase();
    const mailbox = String((entry as SectionMailboxRule).mailbox || '').trim();
    if (!section || !mailbox) return;
    bySection.set(section, mailbox);
  });
  return Array.from(bySection.entries()).map(([section, mailbox]) => ({ section, mailbox }));
}

// Section->Mailbox CSV import/export — the first CSV-based config field in
// the app. Reuses parseDelimitedText (parsers.ts) rather than a hand-rolled
// splitter so quoted fields and comma/tab auto-detection work the same way
// the four data-file uploads already do.
export function parseSectionMailboxCsv(text: string): SectionMailboxRule[] {
  const rows = parseDelimitedText(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  const sectionIdx = header.findIndex(h => h.trim().toLowerCase() === 'section');
  const mailboxIdx = header.findIndex(h => h.trim().toLowerCase() === 'mailbox');
  if (sectionIdx === -1 || mailboxIdx === -1) {
    throw new Error('CSV must have a header row with "Section" and "Mailbox" columns.');
  }
  return normalizeSectionMailboxMap(
    dataRows
      .filter(row => row.length > Math.max(sectionIdx, mailboxIdx))
      .map(row => ({ section: row[sectionIdx] || '', mailbox: row[mailboxIdx] || '' }))
  );
}

export function exportSectionMailboxCsv(rules: SectionMailboxRule[]): string {
  const lines = ['Section,Mailbox', ...rules.map(r => `${r.section},${r.mailbox}`)];
  return lines.join('\n');
}

// Employee -> Manager mailbox CSV import/export — same shape and the same
// upsert-by-key/last-value-wins normalization as normalizeSectionMailboxMap
// above, keyed on EmpId (Cognos PF NO / ASPECT EMP_ID) instead of Section.
// Optional: an employee with no row here simply drafts with no CC.
export function normalizeEmployeeManagerMap(raw: unknown): EmployeeManagerRule[] {
  if (!Array.isArray(raw)) return [];
  const byEmpId = new Map<string, string>();
  raw.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const empId = String((entry as EmployeeManagerRule).empId || '').trim();
    const managerEmail = String((entry as EmployeeManagerRule).managerEmail || '').trim();
    if (!empId || !managerEmail) return;
    byEmpId.set(empId, managerEmail);
  });
  return Array.from(byEmpId.entries()).map(([empId, managerEmail]) => ({ empId, managerEmail }));
}

export function parseEmployeeManagerCsv(text: string): EmployeeManagerRule[] {
  const rows = parseDelimitedText(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  const empIdIdx = header.findIndex(h => h.trim().toLowerCase() === 'empid');
  const managerIdx = header.findIndex(h => h.trim().toLowerCase() === 'manageremail');
  if (empIdIdx === -1 || managerIdx === -1) {
    throw new Error('CSV must have a header row with "EmpId" and "ManagerEmail" columns.');
  }
  return normalizeEmployeeManagerMap(
    dataRows
      .filter(row => row.length > Math.max(empIdIdx, managerIdx))
      .map(row => ({ empId: row[empIdIdx] || '', managerEmail: row[managerIdx] || '' }))
  );
}

export function exportEmployeeManagerCsv(rules: EmployeeManagerRule[]): string {
  const lines = ['EmpId,ManagerEmail', ...rules.map(r => `${r.empId},${r.managerEmail}`)];
  return lines.join('\n');
}

// Defect fix: DEFAULT_SEGMENT_GLOSSARY's 13 previously mixed-case keys (e.g.
// "Cover_RLS") are now uppercased to match what parseAspectSegments always
// produces. A config saved/exported before that change still carries the
// old mixed-case keys, and the shallow spread merge below
// ({...DEFAULT_CONFIG.segmentGlossary, ...parsed.segmentGlossary}) would
// otherwise keep BOTH "COVER_RLS" (new default) and "Cover_RLS" (old saved
// entry) as two separate glossary rows instead of one. Uppercase every
// loaded/imported key before merging so an older config collapses onto the
// current key, keeping whichever classification the user actually saved.
function normalizeSegmentGlossaryKeys(raw: unknown): Record<string, GlossaryEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const normalized: Record<string, GlossaryEntry> = {};
  Object.entries(raw as Record<string, GlossaryEntry>).forEach(([key, entry]) => {
    const upperKey = key.trim().toUpperCase();
    if (!upperKey) return;
    normalized[upperKey] = { ...entry, code: upperKey };
  });
  return normalized;
}

// §Leave Segments review point 5: per-FIELD glossary merge, not the whole-entry
// replace normalizeSegmentGlossaryKeys' caller used to do. A saved entry that
// predates a newly introduced default field (e.g. a future GlossaryEntry addition)
// must not silently drop that field's default value — `{ ...defaultEntry, ...
// savedEntry, code }` keeps every default field the saved entry doesn't explicitly
// override, while user classifications (role, description, ...) still win.
function mergeSegmentGlossary(defaultGlossary: Record<string, GlossaryEntry>, savedRaw: unknown): Record<string, GlossaryEntry> {
  const savedNormalized = normalizeSegmentGlossaryKeys(savedRaw);
  const merged: Record<string, GlossaryEntry> = { ...defaultGlossary };
  Object.entries(savedNormalized).forEach(([key, savedEntry]) => {
    merged[key] = { ...(defaultGlossary[key] || {}), ...savedEntry, code: key } as GlossaryEntry;
  });
  return merged;
}

function normalizeCodeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach(v => {
    if (typeof v !== 'string') return;
    const trimmed = v.trim().toUpperCase();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  });
  return result;
}

function normalizeCognosLeaveTypeMappings(raw: unknown): CognosLeaveTypeMapping[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, CognosLeaveTypeMapping>();
  raw.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const cognosLeaveType = String((entry as CognosLeaveTypeMapping).cognosLeaveType || '').trim();
    const aspectSegmentCodes = normalizeCodeList((entry as CognosLeaveTypeMapping).aspectSegmentCodes);
    if (!cognosLeaveType || aspectSegmentCodes.length === 0) return;
    byKey.set(cognosLeaveType.toUpperCase(), { cognosLeaveType, aspectSegmentCodes });
  });
  return Array.from(byKey.values());
}

// §Leave Segments review point 6: one-time, non-resurrecting migration. Derives
// nonWorkingDaySegmentCodes/leaveSegmentCodes from the legacy per-code
// isLeaveGateExclusion flag ONLY when the new field is entirely absent from the
// saved/imported config (a pre-migration config). Once either field exists, it is
// trusted exactly as saved — never unioned with the legacy flags again — so a leave
// code the user deliberately removed is not silently re-added on every load.
function migrateLeaveConfig(parsed: any, mergedGlossary: Record<string, GlossaryEntry>): {
  nonWorkingDaySegmentCodes: string[];
  leaveSegmentCodes: string[];
} {
  const legacyFlaggedCodes = Object.values(mergedGlossary)
    .filter(entry => entry.isLeaveGateExclusion)
    .map(entry => entry.code.trim().toUpperCase());

  const nonWorkingDaySegmentCodes = Array.isArray(parsed?.nonWorkingDaySegmentCodes)
    ? normalizeCodeList(parsed.nonWorkingDaySegmentCodes)
    : normalizeCodeList([...DEFAULT_NON_WORKING_DAY_SEGMENT_CODES, ...legacyFlaggedCodes]);

  const leaveSegmentCodes = Array.isArray(parsed?.leaveSegmentCodes)
    ? normalizeCodeList(parsed.leaveSegmentCodes)
    : normalizeCodeList([...DEFAULT_LEAVE_SEGMENT_CODES, ...legacyFlaggedCodes.filter(c => c.toUpperCase() !== 'OFF')]);

  return { nonWorkingDaySegmentCodes, leaveSegmentCodes };
}

// Defect fix: a saved/imported config's policyRules previously replaced
// INITIAL_POLICY_RULES wholesale with no repair step (unlike every other
// schema-evolving field above). A rule saved before the `communication`
// field existed, or hand-edited, ends up with `communication: undefined`.
// Every reconciliationEngine lookup does `rule.communication || 'NA'`, so
// that silently reads as the same 'NA' that legitimately means "no email
// required" — suppressing the email icon/draft for every row that fires
// that rule, with no visible error. Backfill missing fields per rule id
// from the current defaults, and add any default rule missing entirely
// from the saved array (e.g. one added after the user's config was saved).
function normalizePolicyRules(raw: unknown): PolicyRuleItem[] {
  const saved = Array.isArray(raw) ? (raw as Partial<PolicyRuleItem>[]) : [];
  const savedById = new Map(saved.filter(r => r && r.id).map(r => [r.id as string, r]));
  const result = INITIAL_POLICY_RULES.map(defaultRule => {
    const savedRule = savedById.get(defaultRule.id);
    if (!savedRule) return defaultRule;
    savedById.delete(defaultRule.id);
    return {
      ...defaultRule,
      ...savedRule,
      communication: savedRule.communication || defaultRule.communication,
      action: savedRule.action || defaultRule.action,
      actionText: savedRule.actionText || defaultRule.actionText,
      conditionDescription: savedRule.conditionDescription || defaultRule.conditionDescription,
    } as PolicyRuleItem;
  });
  // Preserve any saved rules with ids not present in the current defaults
  // (e.g. a user-added custom rule), trusting they carry complete fields.
  savedById.forEach(rule => result.push(rule as PolicyRuleItem));
  return result;
}

export function loadConfigRegistry(): ConfigRegistry {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Legacy single-mailbox field, replaced by sectionMailboxMap — strip it
      // so it doesn't linger forever in the merged/re-saved object via the
      // ...parsed spread below (there's no section to attribute it to).
      delete parsed.opsMailbox;
      const segmentGlossary = mergeSegmentGlossary(DEFAULT_CONFIG.segmentGlossary, parsed.segmentGlossary);
      const { nonWorkingDaySegmentCodes, leaveSegmentCodes } = migrateLeaveConfig(parsed, segmentGlossary);
      // Merge with defaults to guarantee all schema properties exist
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        policyRules: normalizePolicyRules(parsed.policyRules),
        segmentGlossary,
        nonWorkingDaySegmentCodes,
        leaveSegmentCodes,
        cognosLeaveTypeMappings: Array.isArray(parsed.cognosLeaveTypeMappings)
          ? normalizeCognosLeaveTypeMappings(parsed.cognosLeaveTypeMappings)
          : DEFAULT_CONFIG.cognosLeaveTypeMappings,
        emailTemplates: normalizeEmailTemplates(parsed.emailTemplates),
        cognosDropPatterns: normalizeCognosDropPatterns(parsed.cognosDropPatterns),
        cmsPreservedFilePatterns: normalizePreservedFilePatterns(parsed.cmsPreservedFilePatterns),
        sectionMailboxMap: normalizeSectionMailboxMap(parsed.sectionMailboxMap),
        employeeManagerMap: normalizeEmployeeManagerMap(parsed.employeeManagerMap),
      };
    }
  } catch (e) {
    console.error('Failed to read config from localStorage', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function saveConfigRegistry(config: ConfigRegistry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config to localStorage', e);
  }
}

export function resetConfigRegistry(): ConfigRegistry {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear config from localStorage', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function exportConfigToJson(config: ConfigRegistry): string {
  return JSON.stringify(config, null, 2);
}

export function importConfigFromJson(jsonStr: string): ConfigRegistry {
  const parsed = JSON.parse(jsonStr);
  if (!parsed.policyRules || !Array.isArray(parsed.policyRules)) {
    throw new Error('Invalid configuration format: Missing policyRules array');
  }
  delete parsed.opsMailbox;
  const segmentGlossary = mergeSegmentGlossary(DEFAULT_CONFIG.segmentGlossary, parsed.segmentGlossary);
  const { nonWorkingDaySegmentCodes, leaveSegmentCodes } = migrateLeaveConfig(parsed, segmentGlossary);
  const merged: ConfigRegistry = {
    ...DEFAULT_CONFIG,
    ...parsed,
    policyRules: normalizePolicyRules(parsed.policyRules),
    segmentGlossary,
    nonWorkingDaySegmentCodes,
    leaveSegmentCodes,
    cognosLeaveTypeMappings: Array.isArray(parsed.cognosLeaveTypeMappings)
      ? normalizeCognosLeaveTypeMappings(parsed.cognosLeaveTypeMappings)
      : DEFAULT_CONFIG.cognosLeaveTypeMappings,
    emailTemplates: normalizeEmailTemplates(parsed.emailTemplates),
    cognosDropPatterns: normalizeCognosDropPatterns(parsed.cognosDropPatterns),
    cmsPreservedFilePatterns: normalizePreservedFilePatterns(parsed.cmsPreservedFilePatterns),
    sectionMailboxMap: normalizeSectionMailboxMap(parsed.sectionMailboxMap),
    employeeManagerMap: normalizeEmployeeManagerMap(parsed.employeeManagerMap),
    // Hold Policy (doc/PRD.md §Hold Policy) — sanitizeHoldPolicy drops malformed ids and
    // any id pointing at a locked (forced/evidence) reason or MANUAL_REVIEW_REQUIRED, so a
    // tampered or hand-edited export can never release a row the tab itself would lock.
    // Missing entirely (older export) -> DEFAULT_CONFIG.holdPolicy ({ released: [] }).
    holdPolicy: sanitizeHoldPolicy(parsed.holdPolicy),
  };
  saveConfigRegistry(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Policy-band validation (§ variance audit P3-1)
// ---------------------------------------------------------------------------

export interface PolicyBandIssue {
  severity: 'ERROR' | 'WARNING';
  segmentType: string;
  tier: string;
  message: string;
  ruleIds: string[];
}

/**
 * The bands decide pay, and they are user-editable. lookupPolicyRule() returns the FIRST
 * rule whose range contains the measured minutes, so two overlapping bands silently resolve
 * by typing order — which can hand someone "Absent" where the table says "late + cover", or
 * the reverse. Nothing checked for that. This validates a band table the way a reviewer
 * would read it:
 *
 *  - OVERLAP     two bands claim the same minute (ERROR: the verdict depends on row order)
 *  - INVERTED    maxMinutes below minMinutes (ERROR: the band can never match)
 *  - GAP         a minute between two bands that no band covers (WARNING: falls through to
 *                "no action", which is the safe direction, but is usually a typo)
 *  - LEADING GAP the lowest band's own minMinutes is above 0 (WARNING: every minute below it
 *                falls through to "no action" too — e.g. Late Login OPS starting at 6 means
 *                0-5 minutes are deliberately uncovered, which is correct today but, like any
 *                GAP, worth a reviewer's glance rather than silently assumed)
 *
 * Rules with no minMinutes/maxMinutes at all (Rule 5/6/8 — "no login record", "single
 * punch", "RLS on OT") are unbanded by design and are skipped.
 */
export function validatePolicyBands(rules: PolicyRuleItem[]): PolicyBandIssue[] {
  const issues: PolicyBandIssue[] = [];
  const groups = new Map<string, PolicyRuleItem[]>();

  rules.forEach(r => {
    if (r.minMinutes == null && r.maxMinutes == null) return; // unbanded by design
    const key = `${r.segmentType}||${r.tier}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  });

  groups.forEach((group, key) => {
    const [segmentType, tier] = key.split('||');
    const banded = group
      .map(r => ({ rule: r, min: r.minMinutes ?? 0, max: r.maxMinutes ?? 99999 }))
      .sort((a, b) => a.min - b.min);

    banded.forEach(b => {
      if (b.max < b.min) {
        issues.push({
          severity: 'ERROR', segmentType, tier, ruleIds: [b.rule.id],
          message: `Band "${b.rule.conditionDescription}" has maxMinutes (${b.max}) below minMinutes (${b.min}) — it can never match, so this rule never fires.`,
        });
      }
    });

    if (banded.length > 0 && banded[0].min > 0) {
      issues.push({
        severity: 'WARNING', segmentType, tier, ruleIds: [banded[0].rule.id],
        message: `No band covers 0${banded[0].min - 1 > 0 ? `-${banded[0].min - 1}` : ''} minute(s), below the lowest band "${banded[0].rule.conditionDescription}" — a variance in that range produces no action at all.`,
      });
    }

    for (let i = 1; i < banded.length; i++) {
      const prev = banded[i - 1];
      const cur = banded[i];
      if (cur.min <= prev.max) {
        issues.push({
          severity: 'ERROR', segmentType, tier, ruleIds: [prev.rule.id, cur.rule.id],
          message: `Bands "${prev.rule.conditionDescription}" (${prev.min}-${prev.max}) and "${cur.rule.conditionDescription}" (${cur.min}-${cur.max}) both cover minute ${cur.min} — whichever is listed first silently wins.`,
        });
      } else if (cur.min > prev.max + 1) {
        issues.push({
          severity: 'WARNING', segmentType, tier, ruleIds: [prev.rule.id, cur.rule.id],
          message: `No band covers ${prev.max + 1}${cur.min - 1 > prev.max + 1 ? `-${cur.min - 1}` : ''} minute(s) — a variance in that range produces no action at all.`,
        });
      }
    }
  });

  return issues;
}

export interface PolicyRuleDrift {
  ruleId: string;
  segmentType: string;
  tier: string;
  field: 'minMinutes' | 'maxMinutes' | 'action' | 'conditionDescription' | 'communication';
  defaultValue: string;
  liveValue: string;
}

/**
 * The Regression Suite (§6.6) and Trust Matrix assert against the SHIPPED default
 * bands (e.g. reg-35 expects OPS Late Login to flip to Absent at exactly 61 minutes).
 * They now run against the LIVE config (see RegressionSuiteView), so a user who has
 * tuned their own thresholds will see cases fail that are not engine defects — the
 * suite is correctly reporting that the live policy no longer matches the scenario
 * it was written to check. This diff makes that distinction visible instead of
 * leaving a red "FAILED" card that looks identical to a real bug.
 */
export function diffPolicyRulesFromDefaults(liveRules: PolicyRuleItem[]): PolicyRuleDrift[] {
  const drift: PolicyRuleDrift[] = [];
  const defaultsById = new Map(INITIAL_POLICY_RULES.map(r => [r.id, r]));

  for (const live of liveRules) {
    const def = defaultsById.get(live.id);
    if (!def) continue; // user-added custom rule, not a drift from a shipped one
    const fields: Array<PolicyRuleDrift['field']> = ['minMinutes', 'maxMinutes', 'action', 'conditionDescription', 'communication'];
    for (const field of fields) {
      const defaultValue = def[field];
      const liveValue = live[field];
      if (defaultValue !== liveValue) {
        drift.push({
          ruleId: live.id,
          segmentType: live.segmentType,
          tier: live.tier,
          field,
          defaultValue: String(defaultValue ?? '—'),
          liveValue: String(liveValue ?? '—'),
        });
      }
    }
  }

  return drift;
}
