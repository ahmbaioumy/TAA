import assert from 'node:assert/strict';
import { ConfigRegistry } from '../types/taa';
import { DEFAULT_CONFIG, exportConfigToJson, importConfigFromJson, effectiveCmsCoverageGraceMinutes } from './configRegistry';

// This headless (Node/tsx) run has no browser `localStorage` global.
// importConfigFromJson calls saveConfigRegistry, which catches that absence and
// console.error's it — correct behavior for a real missing-storage case in the
// browser, but noisy and misleading here (a passing test printing an
// error-looking line could mask a real failure on a quick glance at CI output).
// Stub a minimal in-memory implementation so the test's environment is
// realistic; configRegistry.ts's catch-and-log itself is untouched.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

// Compile-time exhaustiveness guard: exportConfigToJson/importConfigFromJson
// work by (de)serializing the WHOLE ConfigRegistry object rather than a
// hand-picked field list, so today every field is automatically wired to the
// sidebar's Import/Export buttons. The one way that could silently regress is
// someone adding a field to the ConfigRegistry interface without updating
// this list — Record<keyof ConfigRegistry, true> requires every interface key
// (including optional ones) to be present, so a missed field fails `tsc
// --noEmit` (npm run lint) at compile time, before it ever ships.
const ALL_CONFIG_KEYS: Record<keyof ConfigRegistry, true> = {
  policyRules: true,
  roleTierKeywords: true,
  flexKeywords: true,
  flexCutoffTime: true,
  flexExpectedSchedStartWindow: true,
  flexBypassesMinuteBands: true,
  flexOutsideWindowTreatAsOps: true,
  roundingGridMinutes: true,
  roundingDirection: true,
  segmentUpdateRoundingGridMinutes: true,
  segmentUpdateRoundingDirection: true,
  shiftUpdateOriginalCode: true,
  shiftUpdateNewCode: true,
  originalShiftMemo: true,
  updatedShiftMemo: true,
  segmentGlossary: true,
  defaultFullDaySegmentDurationMinutes: true,
  cmsGraceWindowMinutes: true,
  leaveLoginThresholdMinutes: true,
  perBlockGapThresholdMinutes: true,
  cmsPunchSearchWindowHours: true,
  unseenPunchMaxReachHours: true,
  improperPunchMemoText: true,
  cmsRequiredCoverageDaysBefore: true,
  cmsRequiredCoverageDaysAfter: true,
  cmsCoverageGraceMinutes: true,
  validateUploadedHeadcount: true,
  minHeadcountMappingPercent: true,
  minAttendanceSpanMinutes: true,
  reducedOfficeHoursEnabled: true,
  reducedOfficeHoursDayOfWeek: true,
  reducedOfficeHoursRequiredMinutes: true,
  releaseProximityToleranceMinutes: true,
  comparisonToleranceMinutes: true,
  cognosSentinelValues: true,
  cognosSentinelDetectionMode: true,
  cognosBlankFillColumns: true,
  compareScheduleColumnsOnLeaveDays: true,
  leaveCodesWithoutDuration: true,
  publicHolidayOvertimeLeaveCodes: true,
  cognosAgreeOverrideExceptions: true,
  genericLeaveContainerCodes: true,
  cognosLeaveTypeVerdictValues: true,
  nonWorkingDaySegmentCodes: true,
  leaveSegmentCodes: true,
  partialDayLeaveDeductionCodes: true,
  existingAbsenceMarkerCodes: true,
  cognosLeaveTypeMappings: true,
  coverExtendsAttendanceWindow: true,
  retainLateCoverOnAbsent: true,
  coverFallbackWhenNoWorkingDayFound: true,
  coverFallbackDefaultTime: true,
  coverNotAttendedAction: true,
  coverSameDayWhenAlreadyCovered: true,
  coverMinimumDaysAfterRunDate: true,
  technicalSegmentCodes: true,
  technicalSegmentToleranceMinutes: true,
  releaseGridMinutes: true,
  releaseGridCodes: true,
  releaseProvenSafeHolds: true,
  holdPolicy: true,
  aspectNormalActionCode: true,
  otToShiftConversionCode: true,
  shiftToOt2ConversionCode: true,
  cognosDropPatterns: true,
  sectionMailboxMap: true,
  defaultOpsMailbox: true,
  emailZipEnabled: true,
  emailZipThreshold: true,
  employeeManagerMap: true,
  emailCorporateDomains: true,
  emailTemplates: true,
  emailDraftProtocolScheme: true,
  emailDraftRequestFileName: true,
  emailDraftStatusFileName: true,
  emailDraftVbsLauncherFileName: true,
  emailDraftStatusPollTimeoutSeconds: true,
  projectFolderSubfolderNames: true,
  cognosFolderFileName: true,
  aspectSegmentsFolderFileName: true,
  aspectIdentityFolderFileName: true,
  cmsOutputFileName: true,
  cmsFolderPollIntervalMs: true,
  cmsFolderPollTimeoutMinutes: true,
  cmsPreservedFilePatterns: true,
  cmsProtocolScheme: true,
  cmsVbsLauncherFileName: true,
  cmsAgentListDelimiter: true,
  cmsDateFormatPattern: true,
};

// Runtime half of the same guard: every field DEFAULT_CONFIG actually ships
// (i.e. every field a real exported config file will carry a value for) must
// be one of the keys enumerated above.
Object.keys(DEFAULT_CONFIG).forEach(key => {
  assert.ok(key in ALL_CONFIG_KEYS, `DEFAULT_CONFIG.${key} is not covered by the exhaustive ConfigRegistry key list`);
});

// Round-trip fidelity: a config where EVERY field has been changed away from
// its default must come back byte-for-byte identical after
// exportConfigToJson -> importConfigFromJson. This is what the sidebar's
// Download/Upload buttons and the Config Registry's own Import/Export do
// under the hood (App.tsx handleExportConfig/handleImportConfigFile). Fields
// with a dedicated normalizer (policyRules, segmentGlossary, emailTemplates,
// cognosDropPatterns, cmsPreservedFilePatterns, sectionMailboxMap,
// employeeManagerMap) are given values that are already in normalized form,
// so this test checks lossless round-tripping without fighting normalization
// behaviour that's already covered by featureCompletion.test.ts.
const mutated: ConfigRegistry = {
  ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  roleTierKeywords: ['CUSTOM_ROLE_KEYWORD'],
  flexKeywords: ['CUSTOM_FLEX_KEYWORD'],
  flexCutoffTime: '11:30',
  flexExpectedSchedStartWindow: { start: '06:15', end: '11:00' },
  flexBypassesMinuteBands: false,
  flexOutsideWindowTreatAsOps: false,
  roundingGridMinutes: 45,
  roundingDirection: 'up',
  shiftUpdateOriginalCode: 'CUSTOM_ORIG',
  shiftUpdateNewCode: 'CUSTOM_NEW',
  originalShiftMemo: 'CustomOriginalMemo',
  updatedShiftMemo: 'CustomUpdatedMemo',
  defaultFullDaySegmentDurationMinutes: 500,
  leaveLoginThresholdMinutes: 90,
  perBlockGapThresholdMinutes: 75,
  cmsPunchSearchWindowHours: 6,
  unseenPunchMaxReachHours: 11,
  improperPunchMemoText: 'CustomImproperPunchMemo',
  cmsRequiredCoverageDaysBefore: 2,
  cmsRequiredCoverageDaysAfter: 3,
  // Deliberately off its 240 default: the round-trip must prove a non-default
  // value still serializes and survives export -> import. It no longer drives
  // the INSUFFICIENT_CMS_COVERAGE gate — that gate always uses
  // effectiveCmsCoverageGraceMinutes(config) = cmsPunchSearchWindowHours * 60
  // (deprecated field, kept only so old saved/exported configs still load).
  cmsCoverageGraceMinutes: 310,
  validateUploadedHeadcount: false,
  minHeadcountMappingPercent: 55,
  minAttendanceSpanMinutes: 5,
  reducedOfficeHoursEnabled: false,
  reducedOfficeHoursDayOfWeek: 4,
  reducedOfficeHoursRequiredMinutes: 180,
  releaseProximityToleranceMinutes: 9,
  comparisonToleranceMinutes: 4,
  cognosSentinelValues: [-111, -222],
  cognosSentinelDetectionMode: 'valueList',
  cognosBlankFillColumns: ['CUSTOM_COL'],
  compareScheduleColumnsOnLeaveDays: true,
  leaveCodesWithoutDuration: ['CUSTOM_LEAVE'],
  publicHolidayOvertimeLeaveCodes: ['CUSTOM_PH_LEAVE'],
  partialDayLeaveDeductionCodes: ['CUSTOM_PARTIAL_LEAVE'],
  genericLeaveContainerCodes: ['CUSTOM_GENERIC_LEAVE'],
  cognosLeaveTypeVerdictValues: ['CUSTOM-VERDICT'],
  coverExtendsAttendanceWindow: true,
  retainLateCoverOnAbsent: true,
  coverFallbackWhenNoWorkingDayFound: 'nextDirectDay',
  coverFallbackDefaultTime: '17:45',
  coverNotAttendedAction: 'moveCoverForward',
  coverSameDayWhenAlreadyCovered: true,
  // Deliberately off its 1 default, same reasoning as cmsCoverageGraceMinutes above —
  // proves the run-date floor's own config field survives export -> import.
  coverMinimumDaysAfterRunDate: 3,
  // Deliberately off its ['TECH','TECH2']/0 defaults — proves the technical-hold
  // config (WP5/B5/B15) survives export -> import, list and tolerance both.
  technicalSegmentCodes: ['CUSTOM_TECH'],
  technicalSegmentToleranceMinutes: 5,
  // Deliberately off its 30 / RLS-family defaults — proves the release-grid flag's config
  // (2026-09-27) survives export -> import.
  releaseGridMinutes: 15,
  releaseGridCodes: ['RLS', 'CUSTOM_RLS'],
  // Deliberately off its true default — proves the held-review-reduction kill switch
  // (Step 3, 2026-09-24) survives export -> import.
  releaseProvenSafeHolds: false,
  // Hold Policy (doc/PRD.md §Hold Policy) — a valid, non-locked released cell id, proving
  // the field round-trips through Export/Import untouched.
  holdPolicy: { released: ['OPS|MIXED_LEAVE_AND_WORK_SEGMENTS|ABSENT'] },
  aspectNormalActionCode: '99',
  otToShiftConversionCode: 'CUSTOM_SHIFT_CODE',
  shiftToOt2ConversionCode: 'CUSTOM_OT2_CONVERSION_CODE',
  cognosDropPatterns: [{ column: 'CUSTOM_COLUMN', values: ['CUSTOM*'] }],
  sectionMailboxMap: [{ section: 'CUSTOMSECTION', mailbox: 'custom@example.test' }],
  defaultOpsMailbox: 'custom-default-ops@example.test',
  // Both deliberately off their defaults (true / 2) so the round-trip proves they survive.
  emailZipEnabled: false,
  emailZipThreshold: 5,
  employeeManagerMap: [{ empId: 'EMP999', managerEmail: 'manager999@example.test' }],
  emailCorporateDomains: ['custom-domain.test'],
  emailTemplates: {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG.emailTemplates)),
    generic: { subject: 'CUSTOM SUBJECT {{name}}', body: 'CUSTOM BODY {{name}}' },
  },
  emailDraftProtocolScheme: 'custom-scheme',
  emailDraftRequestFileName: 'Custom_Request.json',
  emailDraftStatusFileName: 'Custom_Status.json',
  emailDraftVbsLauncherFileName: 'Custom_Launcher.vbs',
  emailDraftStatusPollTimeoutSeconds: 42,
  projectFolderSubfolderNames: { cognos: 'CustomCognos', aspect: 'CustomAspect', cms: 'CustomCms' },
  cognosFolderFileName: 'Custom_Cognos_LATEST.csv',
  aspectSegmentsFolderFileName: 'Custom_Aspect_LATEST.csv',
  aspectIdentityFolderFileName: 'Custom_Identity_LATEST.csv',
  cmsOutputFileName: 'Custom_Cms_LATEST.csv',
  cmsFolderPollIntervalMs: 9999,
  cmsFolderPollTimeoutMinutes: 30,
  // normalizePreservedFilePatterns unions supplied values with
  // DEFAULT_CONFIG.cmsPreservedFilePatterns — starting from the defaults and
  // adding one more keeps the mutated value idempotent under that union.
  cmsPreservedFilePatterns: [...DEFAULT_CONFIG.cmsPreservedFilePatterns, 'Custom_Extra_Pattern.txt'],
  cmsProtocolScheme: 'custom-cms-scheme',
  cmsVbsLauncherFileName: 'Custom_Cms_Launcher.vbs',
  cmsAgentListDelimiter: ';',
  cmsDateFormatPattern: 'YYYY-MM-DD',
  segmentGlossary: {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG.segmentGlossary)),
    ZTEST_CUSTOM: { code: 'ZTEST_CUSTOM', role: 'REMOVAL', description: 'Custom test glossary entry' },
  },
  policyRules: DEFAULT_CONFIG.policyRules.map(rule =>
    rule.id === 'rule-late-ops-band1'
      ? { ...rule, minMinutes: 7, maxMinutes: 55, conditionDescription: 'CUSTOM band', action: 'ABSENT_SEGMENT' as const, actionText: 'Custom action text', communication: 'EMAIL_OPS' as const }
      : rule
  ),
};

const json = exportConfigToJson(mutated);
const restored = importConfigFromJson(json);
assert.deepEqual(
  restored,
  mutated,
  'round-tripping a fully customized config through Export (Download) then Import (Upload) must not lose or reset any field',
);

// Coverage grace is linked to the search window (user decision: one setting,
// not two) — cmsCoverageGraceMinutes itself is ignored by the engine.
assert.equal(
  effectiveCmsCoverageGraceMinutes({ ...DEFAULT_CONFIG, cmsPunchSearchWindowHours: 5, cmsCoverageGraceMinutes: 30 }),
  300,
  'effectiveCmsCoverageGraceMinutes must equal cmsPunchSearchWindowHours * 60, ignoring cmsCoverageGraceMinutes',
);

// Hold Policy (doc/PRD.md §Hold Policy) — old exported config JSON (no holdPolicy field at
// all) must default to { released: [] } (hold everything), never throw/crash.
const oldJsonNoHoldPolicy = (() => {
  const clone = JSON.parse(exportConfigToJson(DEFAULT_CONFIG));
  delete clone.holdPolicy;
  return JSON.stringify(clone);
})();
const restoredOld = importConfigFromJson(oldJsonNoHoldPolicy);
assert.deepEqual(
  restoredOld.holdPolicy,
  { released: [] },
  'an old exported config with no holdPolicy field must default to { released: [] } (hold everything)',
);

// Tampered/hand-edited import: a released id pointing at a locked (forced/evidence) reason,
// or at MANUAL_REVIEW_REQUIRED, must be stripped on import — never silently release a row
// the Hold Policy tab itself would lock.
const tamperedJson = (() => {
  const clone = JSON.parse(exportConfigToJson(DEFAULT_CONFIG));
  clone.holdPolicy = {
    released: [
      'OPS|MIXED_LEAVE_AND_WORK_SEGMENTS|ABSENT', // valid, kept
      'OPS|MISSING_CMS_JOIN_KEY|NO_ACTION', // locked (forced) reason — must be stripped
      'FLEX|MANUAL_REVIEW_REQUIRED|NO_ACTION', // MANUAL_REVIEW_REQUIRED — must be stripped
      'not-a-valid-cell-id', // malformed — must be stripped
    ],
  };
  return JSON.stringify(clone);
})();
const restoredTampered = importConfigFromJson(tamperedJson);
assert.deepEqual(
  restoredTampered.holdPolicy,
  { released: ['OPS|MIXED_LEAVE_AND_WORK_SEGMENTS|ABSENT'] },
  'import must strip released ids pointing at locked/forced reasons, MANUAL_REVIEW_REQUIRED, or malformed ids',
);

console.log('Config export/import round-trip tests passed.');
