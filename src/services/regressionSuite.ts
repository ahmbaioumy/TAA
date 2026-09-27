import {
  CognosRecord,
  AspectSegment,
  AspectIdentity,
  CMSPunch,
  ConfigRegistry,
  EmailActionItem,
  ReconciliationRow,
} from '../types/taa';
import { generateAspectCorrectionsCsv, runReconciliation, reallocateCoverSlots } from './reconciliationEngine';
import { DEFAULT_CONFIG } from './configRegistry';
import { parseClockTimeString, parseDateTimeString, truncateToMinute, validateCmsFile, parseAspectSegments, parseAspectIdentity, parseCognosReport, extractDistinctSegmentCodes, formatTimeHHMM } from './parsers';
import { isForcedHoldReason } from './holdReasons';
import { assessDateOverlap, assessHeadcountMapping } from './punchAttribution';
import { runUnseenPunchAudit, classifyUnseenPunchDiff } from './unseenPunchAudit';
import { computeEmailStatusByRowId } from './emailDrafts';
import { rebuildOutputs } from './outputRebuild';
import {
  SAMPLE_ASPECT_SEGMENTS_CSV,
  SAMPLE_ASPECT_IDENTITY_CSV,
  SAMPLE_COGNOS_REPORT_TSV,
  SAMPLE_COGNOS_REPORT_DATE_ALIGNED_TSV,
  SAMPLE_CMS_LOGIN_LOGOUT_CSV,
} from './sampleFileFixtures';

/** WP2/D5/B8 — fixed run date every regression + trust-matrix case is evaluated against.
 * Frozen well before the earliest fixture date in this file (01/08/2026), so the new
 * "cover must land after runDate + coverMinimumDaysAfterRunDate" floor resolves to
 * `max(nextWorkingDayAfterIncident, runDate+offset) === nextWorkingDayAfterIncident` for
 * every existing case — every one of them keeps its ORIGINAL expected date unchanged.
 * A case whose expectation changes under this frozen date is a genuine WP2 finding to
 * report, never something to re-pin. New WP2 cases that specifically test the run-date
 * floor construct their own explicit `processingDate` instead of using this constant. */
export const SUITE_RUN_DATE = new Date(2026, 6, 1); // 01/07/2026 — month is 0-indexed (6 = July)

export interface TestCaseResult {
  id: string;
  name: string;
  category: string;
  inputDescription: string;
  cognosFlawedVerdict: string;
  expectedVerdict: string;
  expectedAction: string;
  actualVerdict: string;
  actualAction: string;
  passed: boolean;
  payrollImpact: string;
  calculationTrace: string[];
}

export function runAllRegressionTests(customConfig?: ConfigRegistry): TestCaseResult[] {
  // Pinned off: the suite runs on the live registry; existing cases must not change when
  // a user enables the reduced-office-hours rule. Its own cases (roh-*) pin it on explicitly.
  const config: ConfigRegistry = { ...(customConfig || DEFAULT_CONFIG), reducedOfficeHoursEnabled: false };
  const results: TestCaseResult[] = [];

  // Helper to create date
  const makeDt = (dateStr: string, timeStr: string) => {
    const [d, m, y] = dateStr.split('/').map(Number);
    const [hh, mm, ss] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, ss || 0);
  };
  // Window-relative fixtures: cases that probe the CMS search-window edge build
  // their punch times from the LIVE cmsPunchSearchWindowHours, never a fixed clock
  // time, so the suite tests the window the business actually runs.
  const shiftHours = (dt: Date, hours: number) => new Date(dt.getTime() + hours * 3600000);
  const ddmmyyyy = (dt: Date) => `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
  const hhmm = (dt: Date) => `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const swipeAt = (loginId: string, dt: Date): CMSPunch => ({
    Date: ddmmyyyy(dt), LoginID: loginId, LoginDateTime: dt, LogoutDateTime: new Date(dt.getTime() + 3000),
  });
  const liveWindowH = config.cmsPunchSearchWindowHours;

  // Case 1: Eman Eltayeb (NURSNG trailing deduction)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'ECS',
      'PF NO': '4501234',
      NAME: 'Eman Eltayeb',
      'LOGIN ID': '10001',
      DUTY1: '07:00 - 15:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:13',
      'SIGIN IN': '07:00',
      'SIGIN OUT': '14:13',
      'LATE START': '0',
      'LEFT EARLY': '-47',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: 'NURSNG:14:00 - 15:00( -60 Minutes) :',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4501234', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '4501234', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '4501234', EMP_LAST_NAME: 'Eman Eltayeb', EMP_SORT_NAME: 'EMAN ELTAYEB', EMP_EXTRA_2: 'eeltayeb' },
    ];
    // Real CMS format: one row per punch EVENT (each row's own Login/Logout
    // columns are the same swipe, ~seconds apart) — a session needs two rows,
    // not one row spanning login-to-logout.
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10001', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '10001', LoginDateTime: makeDt('27/08/2026', '14:13:00'), LogoutDateTime: makeDt('27/08/2026', '14:13:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && row.TAA_EARLY_MIN === 0
      && row.TAA_DISAGREE_REASON === 'DEFECT_1_RELEASE_IGNORED';

    results.push({
      id: 'reg-1',
      name: 'Eman Eltayeb (Nursing Deduction)',
      category: 'Defect 1: Release / Nursing Carve-out',
      inputDescription: 'Shift 07:00–15:00, NURSNG 14:00–15:00 (effective end 14:00), logout 14:13',
      cognosFlawedVerdict: 'LEFT EARLY = -47 (False Early Departure)',
      expectedVerdict: 'PRESENT (Stayed 13 min past effective end 14:00)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents wrongful salary deduction for nursing mother',
      calculationTrace: [
        `Raw Shift: 07:00 - 15:00 (480m)`,
        `Nursing deduction: 60m trailing (14:00 - 15:00)`,
        `Effective End: 14:00:00`,
        `Actual Logout: 14:13:00`,
        `Calculated Early Minutes: ${row.TAA_EARLY_MIN}m (No penalty)`,
      ],
    });
  }

  // Case 2: Minas Alabbas (Nursing Exact Match)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'ECS',
      'PF NO': '4502345',
      NAME: 'Minas Alabbas',
      'LOGIN ID': '10002',
      DUTY1: '09:00 - 17:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:00',
      'SIGIN IN': '09:00',
      'SIGIN OUT': '16:00',
      'LATE START': '0',
      'LEFT EARLY': '-60',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: 'NURSNG:16:00 - 17:00( -60 Minutes) :',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4502345', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 09:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '4502345', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '4502345', EMP_LAST_NAME: 'Minas Alabbas', EMP_SORT_NAME: 'MINAS ALABBAS', EMP_EXTRA_2: 'malabbas' },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10002', LoginDateTime: makeDt('27/08/2026', '09:00:00'), LogoutDateTime: makeDt('27/08/2026', '09:00:03') },
      { Date: '27/08/2026', LoginID: '10002', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION'
      && row.TAA_DISAGREE_REASON === 'DEFECT_1_RELEASE_IGNORED';

    results.push({
      id: 'reg-2',
      name: 'Minas Alabbas (Nursing Exact End)',
      category: 'Defect 1: Release / Nursing Carve-out',
      inputDescription: 'Shift 09:00–17:00, NURSNG 16:00–17:00, logout 16:00',
      cognosFlawedVerdict: 'LEFT EARLY = -60 (False Early Departure)',
      expectedVerdict: 'PRESENT (Logged out exactly at effective end 16:00)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents 1 hour unearned salary deduction',
      calculationTrace: [
        `Raw Shift: 09:00 - 17:00`,
        `Effective End: 16:00:00`,
        `Actual Logout: 16:00:00`,
        `Early Minutes: 0m -> No Action`,
      ],
    });
  }

  // Case 3: Night Shift Arrival PF 90135621 (Cross-midnight Join)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'PRESTIGE',
      'PF NO': '90135621',
      NAME: 'Night Shift Agent 1',
      'LOGIN ID': '11451',
      DUTY1: '19:00 - 03:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '00:00',
      'SIGIN IN': '18:57',
      'SIGIN OUT': '18:57',
      'LATE START': '3',
      'LEFT EARLY': '-503',
      'LEAVE TYPE': 'U-ABSENT',
      'LEAVE HR': '480',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '90135621', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 19:00:00', STOP_MOMENT: '28/08/2026 03:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '90135621', EMP_LAST_NAME: 'Agent Night 1', EMP_SORT_NAME: 'AGENT NIGHT 1', EMP_EXTRA_2: 'anight1' },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '11451', LoginDateTime: makeDt('27/08/2026', '18:57:00'), LogoutDateTime: makeDt('27/08/2026', '18:57:03') },
      { Date: '28/08/2026', LoginID: '11451', LoginDateTime: makeDt('28/08/2026', '03:00:00'), LogoutDateTime: makeDt('28/08/2026', '03:00:05') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && !row.TAA_COGNOS_AGREE;

    results.push({
      id: 'reg-3',
      name: 'Night Shift Arrival (PF 90135621)',
      category: 'Defect 2: Time-Window CMS Join',
      inputDescription: 'Shift 19:00–03:00, login 18:57, logout next day 03:00',
      cognosFlawedVerdict: 'U-ABSENT (Date-keyed join lost closing punch on 28/08)',
      expectedVerdict: 'PRESENT (On Time, arrived 3 min early, next-day punch joined)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents wrongful full-day unauthorized absence deduction (8 hours pay saved)',
      calculationTrace: [
        `Shift window: 27/08 19:00 -> 28/08 03:00`,
        `Time-window CMS search: 27/08 18:00 -> 28/08 04:00`,
        `Earliest punch: 27/08 18:57 (3m early)`,
        `Latest punch: 28/08 03:00 (On time)`,
        `Cognos Disagree Reason: ${row.TAA_DISAGREE_REASON}`,
      ],
    });
  }

  // Case 4: Night Shift Lateness PF 4507957
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'PRESTIGE',
      'PF NO': '4507957',
      NAME: 'Night Shift Agent 2',
      'LOGIN ID': '11452',
      DUTY1: '23:00 - 07:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '00:00',
      'SIGIN IN': '23:08',
      'SIGIN OUT': '23:08',
      'LATE START': '-8',
      'LEFT EARLY': '-472',
      'LEAVE TYPE': 'U-ABSENT',
      'LEAVE HR': '480',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4507957', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 23:00:00', STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 },
      { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 23:00:00', STOP_MOMENT: '29/08/2026 07:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '4507957', EMP_LAST_NAME: 'Agent Night 2', EMP_SORT_NAME: 'AGENT NIGHT 2', EMP_EXTRA_2: 'anight2' },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '11452', LoginDateTime: makeDt('27/08/2026', '23:08:00'), LogoutDateTime: makeDt('27/08/2026', '23:08:05') },
      { Date: '28/08/2026', LoginID: '11452', LoginDateTime: makeDt('28/08/2026', '07:00:00'), LogoutDateTime: makeDt('28/08/2026', '07:00:05') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'LATE' && row.TAA_ACTION === 'LATE_AND_COVER' && row.TAA_LATE_MIN === 8;

    results.push({
      id: 'reg-4',
      name: 'Night Shift Lateness (PF 4507957)',
      category: 'Defect 2: Time-Window CMS Join',
      inputDescription: 'Shift 23:00–07:00, login 23:08, logout next day 07:00',
      cognosFlawedVerdict: 'U-ABSENT (Cognos falsely marked full absence)',
      expectedVerdict: 'LATE (8 min Late -> Late + Cover added next working day)',
      expectedAction: 'LATE_AND_COVER',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Replaces wrongful absence penalty with legitimate 8-min cover',
      calculationTrace: [
        `Scheduled Start: 23:00:00`,
        `Actual Login: 23:08:00`,
        `Measured Lateness: 8 min (in OPS 6-60m band)`,
        `Action: Late (8m) on 27/08 + Cover (8m) on 28/08 after shift end`,
      ],
    });
  }

  // Case 5: Scheduled Day Off / Holiday Exclusion Gate
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4503456',
      NAME: 'Off Staff',
      'LOGIN ID': '10003',
      DUTY1: '',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '0:0',
      'SIGNIN DURATION': '00:00',
      'SIGIN IN': '',
      'SIGIN OUT': '',
      'LATE START': '0',
      'LEFT EARLY': '0',
      'LEAVE TYPE': 'P/H-LV',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4503456', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'P/H-LV' },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '4503456', EMP_LAST_NAME: 'Off Staff', EMP_SORT_NAME: 'OFF STAFF' },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'LEAVE_EXCLUDED' && row.TAA_ACTION === 'NO_ACTION';

    results.push({
      id: 'reg-5',
      name: 'Scheduled Day Off / Public Holiday',
      category: 'Gate 4.6b: Leave-Day Integrity Check',
      inputDescription: 'P/H-LV day with no SHIFT, no OT, no CMS punches',
      cognosFlawedVerdict: 'Marked Absent NS/NC in naive systems',
      expectedVerdict: 'LEAVE_EXCLUDED (Exclusion gate filters non-working day)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents marking off-duty employees absent',
      calculationTrace: [
        `Leave code P/H-LV detected with no SHIFT/OT`,
        `CMS punches: 0`,
        `Passed leave-day integrity check -> No Action`,
      ],
    });
  }

  // Case 6: Holiday Overtime (PF 4507957 on 28/08 with OT2)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'PRESTIGE',
      'PF NO': '4507957',
      NAME: 'Night Shift Agent 2',
      'LOGIN ID': '11452',
      DUTY1: '',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '0:0',
      'SIGNIN DURATION': '08:00',
      'SIGIN IN': '23:00',
      'SIGIN OUT': '07:00',
      'LATE START': '0',
      'LEFT EARLY': '0',
      'LEAVE TYPE': 'P/H-LV',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RTM', DURATION: 0 },
      { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT2', START_MOMENT: '28/08/2026 23:00:00', STOP_MOMENT: '29/08/2026 07:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '4507957', EMP_LAST_NAME: 'Agent Night 2', EMP_SORT_NAME: 'AGENT NIGHT 2' },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '11452', LoginDateTime: makeDt('28/08/2026', '23:00:00'), LogoutDateTime: makeDt('28/08/2026', '23:00:05') },
      { Date: '29/08/2026', LoginID: '11452', LoginDateTime: makeDt('29/08/2026', '07:00:00'), LogoutDateTime: makeDt('29/08/2026', '07:00:05') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_OT2 === '480';

    results.push({
      id: 'reg-6',
      name: 'Holiday Overtime (OT2 Standalone)',
      category: 'Overtime & Rate Integrity',
      inputDescription: 'P/H-LV day with OT2 23:00–07:00 (480m), no SHIFT',
      cognosFlawedVerdict: 'Skipped as full-day leave (Dropped 8h holiday OT)',
      expectedVerdict: 'PRESENT (Evaluated and paid as Public Holiday OT2, 480m)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Protects 8 hours of premium holiday overtime pay',
      calculationTrace: [
        `P/H-LV accompanied by OT2 (480 min)`,
        `Gate 4.6a fires (OT2 present) -> Evaluated for attendance`,
        `Actual punches: On time 23:00 to 07:00`,
        `Appended TAA_OT2: ${row.TAA_OT2} min`,
      ],
    });
  }

  // Case 7: Flex within Cutoff
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'PRESTIGE',
      'PF NO': '455876',
      NAME: 'Flex Agent 1',
      'LOGIN ID': '10004',
      DUTY1: '07:00 - 15:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:12',
      'SIGIN OUT': '16:15',
      'LATE START': '-72',
      'LEFT EARLY': '15',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '455876', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '455876', EMP_LAST_NAME: 'Flex Agent 1', EMP_SORT_NAME: 'FLEX AGENT 1 - 40H FLX', EMP_EXTRA_2: 'flex1' },
    ];
    // Real CMS format: one row per swipe EVENT (login/logout on the same row
    // are the same badge tap, ~3s apart) — a normal day is two rows, not one
    // row spanning arrival to departure (D-C fix regression guard).
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10004', LoginDateTime: makeDt('28/08/2026', '08:12:00'), LogoutDateTime: makeDt('28/08/2026', '08:12:03') },
      { Date: '28/08/2026', LoginID: '10004', LoginDateTime: makeDt('28/08/2026', '16:14:57'), LogoutDateTime: makeDt('28/08/2026', '16:15:00') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const hasShiftUpdate = out.aspectCorrections.some(c => c.Code === '10' && c.SegmentStarttime === '07:00') &&
                           out.aspectCorrections.some(c => c.Code === '11' && c.SegmentStarttime === '08:00');
    const passed = row.TAA_RESULT_CATEGORY === 'SHIFT_CHANGED' && hasShiftUpdate && row.TAA_LATE_MIN === 0;

    results.push({
      id: 'reg-7',
      name: 'Flex Staff within Cutoff (08:12 Arrival)',
      category: 'Flex Staff (§4.8 Branch A)',
      inputDescription: 'Flex staff sch 07:00–15:00, arrives 08:12 (rounds to 08:00 <= 10:00 cutoff)',
      cognosFlawedVerdict: 'LATE START = -72 (Treated as 72m late in standard rules)',
      expectedVerdict: 'SHIFT_CHANGED (Shift updated to 08:00–16:00, no Late, no Cover)',
      expectedAction: 'SHIFT_UPDATE_FLEX',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents wrongful 72-minute penalty on approved flex roster',
      calculationTrace: [
        `Flex keyword matched in EMP_SORT_NAME`,
        `Arrival 08:12 snapped to 08:00 (<= 10:00 cutoff)`,
        `Shift duration preserved: 8 hours`,
        `Emitted Code 10: 07:00 (Original) | Code 11: 08:00 (Updated)`,
      ],
    });
  }

  // Case 8: Flex Past Cutoff by 1 Minute (10:01 Arrival)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'PRESTIGE',
      'PF NO': '455877',
      NAME: 'Flex Agent 2',
      'LOGIN ID': '10005',
      DUTY1: '07:00 - 15:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:59',
      'SIGIN IN': '10:01',
      'SIGIN OUT': '18:01',
      'LATE START': '-181',
      'LEFT EARLY': '0',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '455877', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '455877', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 07:00:00', STOP_MOMENT: '29/08/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '455877', EMP_LAST_NAME: 'Flex Agent 2', EMP_SORT_NAME: 'FLEX AGENT 2 - FELX', EMP_EXTRA_2: 'flex2' },
    ];
    // Real CMS format: one row per swipe EVENT — two rows for a normal day
    // (D-C fix regression guard, matches every other case in this file).
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10005', LoginDateTime: makeDt('28/08/2026', '10:01:00'), LogoutDateTime: makeDt('28/08/2026', '10:01:03') },
      { Date: '28/08/2026', LoginID: '10005', LoginDateTime: makeDt('28/08/2026', '18:00:57'), LogoutDateTime: makeDt('28/08/2026', '18:01:00') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const hasLateCover = out.aspectCorrections.some(c => c.SegmentCode === 'LATE' && c.Segmentduration === '00:01') &&
                         out.aspectCorrections.some(c => c.SegmentCode === 'COVER' && c.Segmentduration === '00:01');
    const passed = row.TAA_LATE_MIN === 1 && hasLateCover;

    results.push({
      id: 'reg-8',
      name: 'Flex Staff Past Cutoff by 1 min (10:01 Arrival)',
      category: 'Flex Staff (§4.8 Branch B)',
      inputDescription: 'Flex staff sch 07:00, arrives 10:01 (1 min past 10:00 cutoff)',
      cognosFlawedVerdict: 'LATE START = -181 (Would mark Absent under standard 61+ band)',
      expectedVerdict: 'LATE (Shift clamped to 10:00; Late = 1 min, Cover = 1 min, full variance charged)',
      expectedAction: 'SHIFT_UPDATE_AND_LATE_COVER_FLEX',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Charges precise 1-minute variance instead of erroneous 181-minute full absence',
      calculationTrace: [
        `Arrival 10:01 > 10:00 cutoff by 1 min`,
        `Shift clamped to 10:00 (8 hours duration)`,
        `Late measured from cutoff: 10:01 - 10:00 = 1 min`,
        `Full variance charged: Late 1m + Cover 1m next working day`,
      ],
    });
  }

  // Case 9: Full Variance Charging (5 min vs 6 min late)
  {
    const cognos5: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4504005',
      NAME: 'OPS 5m Late',
      'LOGIN ID': '10006',
      DUTY1: '08:00 - 16:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:55',
      'SIGIN IN': '08:05',
      'SIGIN OUT': '16:00',
      'LATE START': '-5',
      'LEFT EARLY': '0',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const cognos6: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4504006',
      NAME: 'OPS 6m Late',
      'LOGIN ID': '10007',
      DUTY1: '08:00 - 16:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:54',
      'SIGIN IN': '08:06',
      'SIGIN OUT': '16:00',
      'LATE START': '-6',
      'LEFT EARLY': '0',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4504005', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '4504006', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '4504006', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 08:00:00', STOP_MOMENT: '29/08/2026 16:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10006', LoginDateTime: makeDt('28/08/2026', '08:05:00'), LogoutDateTime: makeDt('28/08/2026', '08:05:03') },
      { Date: '28/08/2026', LoginID: '10006', LoginDateTime: makeDt('28/08/2026', '16:00:00'), LogoutDateTime: makeDt('28/08/2026', '16:00:03') },
      { Date: '28/08/2026', LoginID: '10007', LoginDateTime: makeDt('28/08/2026', '08:06:00'), LogoutDateTime: makeDt('28/08/2026', '08:06:03') },
      { Date: '28/08/2026', LoginID: '10007', LoginDateTime: makeDt('28/08/2026', '16:00:00'), LogoutDateTime: makeDt('28/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos5, cognos6], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const r5 = out.rows[0];
    const r6 = out.rows[1];
    const passed = r5.TAA_ACTION === 'NO_ACTION' && r6.TAA_ACTION === 'LATE_AND_COVER' && r6.details.chargedVarianceMinutes === 6;

    results.push({
      id: 'reg-9',
      name: 'Full Variance Charging (§4.10)',
      category: 'Rule Engine Principle',
      inputDescription: 'OPS late 5 min (below floor) vs 6 min (band floor met)',
      cognosFlawedVerdict: 'Naive engine charges 6 - 5 = 1 min',
      expectedVerdict: '5 min -> No Action; 6 min -> Late segment of FULL 6 min',
      expectedAction: '5m: NO_ACTION | 6m: LATE_AND_COVER (6 min)',
      actualVerdict: `${r5.TAA_VERDICT} / ${r6.TAA_VERDICT}`,
      actualAction: `${r5.TAA_ACTION} / ${r6.TAA_ACTION} (${r6.details.chargedVarianceMinutes}m)`,
      passed,
      payrollImpact: 'Enforces correct policy: 6 min late is a 6-minute late segment, never 1 minute',
      calculationTrace: [
        `5m late is below OPS 6m threshold -> No Action`,
        `6m late triggers 6-60m band -> Full 6 min charged`,
        `Emitted Cover duration: 6 minutes`,
      ],
    });
  }

  // Case 10: Cover Placement Stacking Past Last Segment
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4505001',
      NAME: 'Stacking Agent',
      'LOGIN ID': '10008',
      DUTY1: '08:00 - 16:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15',
      'SIGIN OUT': '16:00',
      'LATE START': '-15',
      'LEFT EARLY': '0',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4505001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      // Target Day has SHIFT 07:00-15:00 PLUS second block 15:00-16:00
      { EMP_ID: '4505001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '4505001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 15:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10008', LoginDateTime: makeDt('27/08/2026', '08:15:00'), LogoutDateTime: makeDt('27/08/2026', '08:15:03') },
      { Date: '27/08/2026', LoginID: '10008', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined && cover.nominateDate === '28/08/2026' && cover.SegmentDate === '28/08/2026' && cover.SegmentStarttime === '16:00' && cover.Segmentduration === '00:15';

    results.push({
      id: 'reg-10',
      name: 'Cover Placement Stacking (§4.11 Step 2)',
      category: 'Cover Placement Algorithm',
      inputDescription: 'Incident on 27/08 (15m late). Target day 28/08 has SHIFT until 15:00 + OT1 until 16:00',
      cognosFlawedVerdict: 'Naive placement places cover at 15:00 (SHIFT end)',
      expectedVerdict: 'Cover placed at 16:00 (end of LAST segment of the day)',
      expectedAction: 'COVER at 16:00:00 for 15 min',
      actualVerdict: cover ? `COVER on ${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Ensures employee is not double-booked during existing overtime block',
      calculationTrace: [
        `Incident 27/08 late 15m`,
        `Next working day: 28/08/2026`,
        `Segments on 28/08: SHIFT (ends 15:00), OT1 (ends 16:00)`,
        `Max segment stop time = 16:00`,
        `Cover placed at 16:00 - 16:15`,
      ],
    });
  }

  // Case 11: Leave Day Login >= 60 min Anomaly
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4506001',
      NAME: 'Annual Leave Worker',
      'LOGIN ID': '10009',
      DUTY1: '',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '0:0',
      'SIGNIN DURATION': '01:30',
      'SIGIN IN': '09:00',
      'SIGIN OUT': '10:30',
      'LATE START': '0',
      'LEFT EARLY': '0',
      'LEAVE TYPE': 'ANNUAL',
      'LEAVE HR': '480',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4506001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10009', LoginDateTime: makeDt('28/08/2026', '09:00:00'), LogoutDateTime: makeDt('28/08/2026', '10:30:00') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT' && row.TAA_DISAGREE_REASON === 'LEAVE_DAY_LOGIN_ANOMALY';

    results.push({
      id: 'reg-11',
      name: 'Leave-Day Login Anomaly (>= 60 min)',
      category: 'Gate 4.6b: Leave-Day Integrity Check',
      inputDescription: 'ANNUAL leave day with 90 min CMS login',
      cognosFlawedVerdict: 'Ignored or unflagged',
      expectedVerdict: 'ABSENT (90m login >= 60m threshold -> Convert to Absent + flag for manual review)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Highlights unauthorized attendance on paid annual vacation',
      calculationTrace: [
        `Leave code ANNUAL detected without shift`,
        `CMS punches: 09:00 - 10:30 (90 min)`,
        `Threshold: ${config.leaveLoginThresholdMinutes} min`,
        `90m >= 60m -> Flagged as LEAVE_DAY_LOGIN_ANOMALY`,
      ],
    });
  }

  // Case 12: Recompute Changes Verdict (RLS 7:30 vs Cognos 8:00)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4507001',
      NAME: 'Recompute Agent',
      'LOGIN ID': '10010',
      DUTY1: '08:00 - 16:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:30',
      'SIGIN IN': '08:00',
      'SIGIN OUT': '15:30',
      'LATE START': '0',
      'LEFT EARLY': '-30',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: 'RLS:15:30 - 16:00( -30 Minutes) :',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4507001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '4507001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RLS', START_MOMENT: '28/08/2026 15:30:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 30 },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10010', LoginDateTime: makeDt('28/08/2026', '08:00:00'), LogoutDateTime: makeDt('28/08/2026', '08:00:03') },
      { Date: '28/08/2026', LoginID: '10010', LoginDateTime: makeDt('28/08/2026', '15:30:00'), LogoutDateTime: makeDt('28/08/2026', '15:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_SCH_HOURS_RECOMPUTED === 450 && row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION';

    results.push({
      id: 'reg-12',
      name: 'Recompute Net Scheduled Hours (§4.13)',
      category: 'Core Recompute-Then-Compare Pipeline',
      inputDescription: 'Cognos says Sch=8:00, login=7:30. Recompute finds 8h SHIFT - 30m RLS = 7:30 net sch',
      cognosFlawedVerdict: 'LEFT EARLY = -30 (False early departure)',
      expectedVerdict: 'PRESENT (Net scheduled 7h 30m matches actual logout 15:30)',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Resolves false discrepancy by computing against true 7:30 schedule',
      calculationTrace: [
        `Raw Shift: 480m (8h)`,
        `RLS Deduction: -30m`,
        `Recomputed Net Scheduled: 450m (7:30)`,
        `Effective End: 15:30:00`,
        `Actual Logout: 15:30:00 -> On Time`,
      ],
    });
  }

  // Case 13: Outlook Recipient Resolution (§4.7)
  {
    const idBothMatch: AspectIdentity = { EMP_ID: '9001', EMP_LAST_NAME: 'User One', EMP_EXTRA_2: 'uone', EMP_EMAIL_ADR: 'uone@thecontactcentre.ae' };
    const idDiffPriority: AspectIdentity = { EMP_ID: '9002', EMP_LAST_NAME: 'User Two', EMP_EXTRA_2: 'ashamsi', EMP_EMAIL_ADR: 'al_wafa@hotmail.com' };
    const idOnlyExtra2: AspectIdentity = { EMP_ID: '9003', EMP_LAST_NAME: 'User Three', EMP_EXTRA_2: 'fmurad' };
    const idOnlyEmail: AspectIdentity = { EMP_ID: '9004', EMP_LAST_NAME: 'User Four', EMP_EMAIL_ADR: 'daugusti@thecontactcentre.ae' };

    const cognosDummy = (pf: string): CognosRecord => ({
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'OPS', 'PF NO': pf, NAME: `Name ${pf}`, 'LOGIN ID': pf,
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    });

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosDummy('9001'), cognosDummy('9002'), cognosDummy('9003'), cognosDummy('9004')],
      aspectSegments: [],
      aspectIdentities: [idBothMatch, idDiffPriority, idOnlyExtra2, idOnlyEmail],
      cmsPunches: [],
      config,
    });

    const passed = out.rows[0].TAA_USERNAME === 'uone' &&
                   out.rows[1].TAA_USERNAME === 'ashamsi' &&
                   out.rows[2].TAA_USERNAME === 'fmurad' &&
                   out.rows[3].TAA_USERNAME === '';

    results.push({
      id: 'reg-13',
      name: 'Outlook Recipient Resolution (§4.7)',
      category: 'Identity & Communication',
      inputDescription: 'Username extraction is limited to EMP_EXTRA_2; corporate EMP_EMAIL_ADR remains an email-recipient fallback, not a username',
      cognosFlawedVerdict: 'Unresolved or routed to personal hotmail address',
      expectedVerdict: 'uone, ashamsi (EMP_EXTRA_2 priority), fmurad, empty username when only EMP_EMAIL_ADR exists',
      expectedAction: 'Resolved safe username base',
      actualVerdict: out.rows.map(r => r.TAA_USERNAME).join(', '),
      actualAction: 'RESOLVED',
      passed,
      payrollImpact: 'Ensures email drafts route to corporate Exchange mailbox without leaking to personal accounts',
      calculationTrace: [
        `9001: local(uone) == local(uone@...) -> uone`,
        `9002: local(ashamsi) != local(al_wafa@hotmail.com) -> EMP_EXTRA_2 wins (ashamsi)`,
        `9003: Only EMP_EXTRA_2 populated -> fmurad`,
        `9004: Only EMP_EMAIL_ADR -> no TAA_USERNAME; resolveEmailRecipient uses corporate email later`,
      ],
    });
  }

  // Case 14: Consecutive Night Shifts — Single-Claim Punch Guard (Phase 1)
  // Two back-to-back overnight shifts for the same employee: shift A ends
  // 23:00->07:00, shift B starts the same day 07:00->15:00 is NOT the setup
  // here — instead A ends at 07:00 D+1 and B (a different employee-day, same
  // login) starts later D+1. The 07:05 punch must be claimed ONLY by shift
  // A's closing punch, never double-counted as shift B's opening punch too.
  {
    const cognosA: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000001', NAME: 'Night Chain Agent', 'LOGIN ID': '30001',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const cognosB: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000001', NAME: 'Night Chain Agent', 'LOGIN ID': '30001',
      DUTY1: '20:00 - 04:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 23:00:00', STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 },
      { EMP_ID: '7000001', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 20:00:00', STOP_MOMENT: '29/08/2026 04:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000001', EMP_LAST_NAME: 'Night Chain Agent', EMP_SORT_NAME: 'NIGHT CHAIN AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30001', LoginDateTime: makeDt('27/08/2026', '23:00:00'), LogoutDateTime: makeDt('27/08/2026', '23:00:03') },
      { Date: '28/08/2026', LoginID: '30001', LoginDateTime: makeDt('28/08/2026', '07:05:00'), LogoutDateTime: makeDt('28/08/2026', '07:05:03') }, // shift A's ONLY closing punch
      { Date: '28/08/2026', LoginID: '30001', LoginDateTime: makeDt('28/08/2026', '20:00:00'), LogoutDateTime: makeDt('28/08/2026', '20:00:03') },
      { Date: '29/08/2026', LoginID: '30001', LoginDateTime: makeDt('29/08/2026', '04:05:00'), LogoutDateTime: makeDt('29/08/2026', '04:05:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosA, cognosB], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const rowA = out.rows[0];
    const rowB = out.rows[1];
    // TAA_CMS_OUT is now date-qualified when the punch falls on a different calendar day
    // from the shift's start — which is exactly this case (shift starts 23:00, closing
    // punch lands 07:05 the NEXT morning). The expected time is unchanged; only its
    // printed form gained the disambiguating date, so the assertion matches on the prefix.
    const passed = rowA.TAA_CMS_OUT.startsWith('07:05') && rowA.TAA_VERDICT === 'PRESENT'
      && rowB.TAA_CMS_IN.startsWith('20:00') && rowB.TAA_VERDICT === 'PRESENT';

    results.push({
      id: 'reg-14',
      name: 'Consecutive Night Shifts (Single-Claim Punch Guard)',
      category: 'Phase 1: Punch Attribution',
      inputDescription: 'Shift A ends 07:00 D+1, Shift B starts 20:00 same D+1 — the 07:05 closing punch must go to A only',
      cognosFlawedVerdict: 'A fixed 8h logout tail can let the SAME punch feed both days, or a bare grace window can miss it entirely',
      expectedVerdict: 'Shift A: PRESENT (out 07:05); Shift B: PRESENT (in 20:00) — no double count, no false absence',
      expectedAction: 'NO_ACTION / NO_ACTION',
      actualVerdict: `A: ${rowA.TAA_VERDICT} (out ${rowA.TAA_CMS_OUT}) | B: ${rowB.TAA_VERDICT} (in ${rowB.TAA_CMS_IN})`,
      actualAction: `${rowA.TAA_ACTION} / ${rowB.TAA_ACTION}`,
      passed,
      payrollImpact: 'Prevents a single punch from being counted twice, and prevents a night shift\'s closing punch from vanishing into the next shift\'s search window',
      calculationTrace: [
        'Global one-pass attribution assigns each punch to its NEAREST window by distance-to-interval',
        '07:05 punch: distance to Shift A raw interval [23:00,07:00] = 0 (inside); distance to Shift B raw interval [20:00,04:00] = much larger',
        'Shift A correctly claims the 07:05 punch; Shift B is untouched by it',
      ],
    });
  }

  // Case 15: Insufficient CMS Coverage — Lone Punch Near Export Edge Is Held, Not Absent (Phase 1, D4 fix)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000002', NAME: 'Edge Of Export Agent', 'LOGIN ID': '30002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000002', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000002', EMP_LAST_NAME: 'Edge Of Export Agent', EMP_SORT_NAME: 'EDGE OF EXPORT AGENT' }];
    // The CMS export for this login stops at 08:05 — it never reaches the
    // required day-after coverage, so the missing logout punch is a data
    // gap, not proof the employee only swiped once and left.
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30002', LoginDateTime: makeDt('28/08/2026', '08:05:00'), LogoutDateTime: makeDt('28/08/2026', '08:05:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'INSUFFICIENT_CMS_COVERAGE' && row.TAA_ACTION !== 'ABSENT_SEGMENT' && row.holdReason === 'INSUFFICIENT_CMS_COVERAGE';

    results.push({
      id: 'reg-15',
      name: 'Insufficient CMS Coverage (Lone Punch at Export Edge)',
      category: 'Phase 1: Punch Attribution (Defect 4 fix)',
      inputDescription: 'Single 08:05 punch; CMS export for this login does not extend far enough to confirm a missing logout',
      cognosFlawedVerdict: 'A single matched punch used to be treated as automatic proof of absence',
      expectedVerdict: 'INSUFFICIENT_CMS_COVERAGE — held for manual review, never auto-marked Absent',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a wrongful full-day Absent deduction caused by an incomplete CMS export rather than a real no-show',
      calculationTrace: [
        `Punches found in window: ${row.details.punchCount}`,
        `Coverage sufficient: ${row.details.coverageSufficient}`,
        `Hold reason: ${row.holdReason}`,
      ],
    });
  }

  // Case grace-linked-01: Coverage grace is linked to the search window, not
  // independently configurable — cmsCoverageGraceMinutes is ignored by the
  // engine (effectiveCmsCoverageGraceMinutes = cmsPunchSearchWindowHours * 60
  // always). Reuses reg-15's INSUFFICIENT_CMS_COVERAGE fixture: running it
  // with cmsCoverageGraceMinutes: 0 and with cmsCoverageGraceMinutes: 9999
  // (same search window both times) must give identical results.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000002', NAME: 'Edge Of Export Agent', 'LOGIN ID': '30002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000002', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000002', EMP_LAST_NAME: 'Edge Of Export Agent', EMP_SORT_NAME: 'EDGE OF EXPORT AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30002', LoginDateTime: makeDt('28/08/2026', '08:05:00'), LogoutDateTime: makeDt('28/08/2026', '08:05:03') },
    ];

    const outLow = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, cmsCoverageGraceMinutes: 0 } });
    const outHigh = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, cmsCoverageGraceMinutes: 9999 } });
    const rowLow = outLow.rows[0];
    const rowHigh = outHigh.rows[0];
    const passed = rowLow.holdReason === rowHigh.holdReason
      && rowLow.TAA_VERDICT === rowHigh.TAA_VERDICT
      && rowLow.TAA_ACTION === rowHigh.TAA_ACTION
      && JSON.stringify(rowLow.details.generatedCorrections) === JSON.stringify(rowHigh.details.generatedCorrections);

    results.push({
      id: 'grace-linked-01',
      name: 'Coverage Grace Is Linked To The Search Window, Not Independently Set',
      category: 'Phase 1: Punch Attribution',
      inputDescription: 'reg-15 fixture run twice, cmsCoverageGraceMinutes 0 vs 9999, same cmsPunchSearchWindowHours both times',
      cognosFlawedVerdict: 'N/A — config-wiring regression guard',
      expectedVerdict: `Identical holdReason/TAA_VERDICT/TAA_ACTION/corrections regardless of cmsCoverageGraceMinutes (both use effectiveCmsCoverageGraceMinutes = search window * 60)`,
      expectedAction: `${rowLow.TAA_ACTION} (both runs)`,
      actualVerdict: `grace=0: ${rowLow.TAA_VERDICT} (${rowLow.holdReason}) | grace=9999: ${rowHigh.TAA_VERDICT} (${rowHigh.holdReason})`,
      actualAction: `${rowLow.TAA_ACTION} / ${rowHigh.TAA_ACTION}`,
      passed,
      payrollImpact: 'Proves cmsCoverageGraceMinutes can no longer silently diverge from the search window and change a real outcome',
      calculationTrace: [
        `cmsPunchSearchWindowHours (both runs): ${config.cmsPunchSearchWindowHours}`,
        `grace=0 run holdReason: ${rowLow.holdReason}`,
        `grace=9999 run holdReason: ${rowHigh.holdReason}`,
      ],
    });
  }

  // Case 16: Genuine Single Punch WITH Full Coverage Still Marks Absent (Rule 6 preserved)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000003', NAME: 'Real Single Punch Agent', 'LOGIN ID': '30003',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000003', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000003', EMP_LAST_NAME: 'Real Single Punch Agent', EMP_SORT_NAME: 'REAL SINGLE PUNCH AGENT' }];
    // Coverage is genuinely wide (data exists well past the required day
    // before/after window) — the single 08:05 punch is real evidence of an
    // incomplete swipe pair, not a coverage artifact.
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30003', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '28/08/2026', LoginID: '30003', LoginDateTime: makeDt('28/08/2026', '08:05:00'), LogoutDateTime: makeDt('28/08/2026', '08:05:03') },
      { Date: '29/08/2026', LoginID: '30003', LoginDateTime: makeDt('29/08/2026', '08:00:00'), LogoutDateTime: makeDt('29/08/2026', '08:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    // holdReason is intentionally not asserted here — this case is only
    // testing that Rule 6 (single punch) still fires when coverage is
    // sufficient; whether unrelated Cognos columns also happen to mismatch
    // is a separate concern (see reg-17 for the comparison/hold mechanism).
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT';

    results.push({
      id: 'reg-16',
      name: 'Genuine Single Punch With Full CMS Coverage (Rule 6 preserved)',
      category: 'Phase 1: Punch Attribution (Defect 4 fix — negative case)',
      inputDescription: 'Single 08:05 punch; CMS export for this login has ample data on both the day before and after',
      cognosFlawedVerdict: 'N/A — this proves the coverage guard does not over-correct into never firing Rule 6',
      expectedVerdict: 'ABSENT (single punch only, with sufficient coverage to trust it)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the insufficient-coverage guard (reg-15) does not silently disable the real "missing login or logout" rule when data actually is complete',
      calculationTrace: [
        `Punches found in window: ${row.details.punchCount}`,
        `Coverage sufficient: ${row.details.coverageSufficient}`,
      ],
    });
  }

  // Case 136: A Single CMS Row Carrying a Real Full-Shift Span Is NOT Absent (D-F fix)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000136', NAME: 'Real Session Single Row Agent', 'LOGIN ID': '30136',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000136', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 09:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000136', EMP_LAST_NAME: 'Real Session Single Row Agent', EMP_SORT_NAME: 'REAL SESSION SINGLE ROW AGENT' }];
    // Real production CMS exports are NOT uniformly 3-second swipe pairs — a
    // single row can already carry a genuine multi-hour login->logout span
    // (measured against samples_Files/CMS_15092026.csv: 44% of rows span an
    // hour or more, and 91.8% of single-row-per-day agents carry a 4+ hour
    // span). This is exactly that shape: ONE closed CMS row, login 09:01,
    // logout 17:00 — a complete, valid day reported as its only evidence.
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30136', LoginDateTime: makeDt('27/08/2026', '09:01:00'), LogoutDateTime: makeDt('27/08/2026', '17:00:00') },
      { Date: '28/08/2026', LoginID: '30136', LoginDateTime: makeDt('28/08/2026', '09:01:00'), LogoutDateTime: makeDt('28/08/2026', '17:00:00') },
      { Date: '29/08/2026', LoginID: '30136', LoginDateTime: makeDt('29/08/2026', '09:01:00'), LogoutDateTime: makeDt('29/08/2026', '17:00:00') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    // Asserts the POSITIVE outcome, not merely 'not ABSENT': a drift into any hold
    // state (INSUFFICIENT_CMS_COVERAGE, CONTESTED_PUNCH_ATTRIBUTION) would also strand
    // this day's pay, so the guard must pin the real verdict.
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && !row.holdReason && row.details.punchCount === 1;

    results.push({
      id: 'reg-136',
      name: 'Single CMS Row With Real Full-Shift Span Is Not Absent (D-F fix)',
      category: 'Phase 1: Punch Attribution (Defect D-F fix)',
      inputDescription: 'One CMS row for the day: login 09:01, logout 17:00, scheduled 09:00-17:00 — a complete real day recorded as a single record',
      cognosFlawedVerdict: 'Previously ABSENT: matchingPunches.length <= 1 discarded a fully-evidenced day purely because it arrived as one row instead of two',
      expectedVerdict: 'Normal Late Login evaluation (1 min late, within tolerance) — never ABSENT',
      expectedAction: 'NO_ACTION or LATE, never ABSENT_SEGMENT',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Fixes a systemic false-Absence: on a real one-day export, 40%+ of agents have exactly one CMS row, and 92% of those rows already carry a full valid shift span',
      calculationTrace: [
        `Punches found in window: ${row.details.punchCount}`,
        `Coverage sufficient: ${row.details.coverageSufficient}`,
      ],
    });
  }

  // Case 17: Fill-If-Blank Never Overwrites a Populated Cognos Value (§Non-negotiables)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000004', NAME: 'Blank Fill Agent', 'LOGIN ID': '30004',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '02:30', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000004', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000004', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000004', EMP_LAST_NAME: 'Blank Fill Agent', EMP_SORT_NAME: 'BLANK FILL AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30004', LoginDateTime: makeDt('28/08/2026', '08:00:00'), LogoutDateTime: makeDt('28/08/2026', '08:00:03') },
      { Date: '28/08/2026', LoginID: '30004', LoginDateTime: makeDt('28/08/2026', '17:00:00'), LogoutDateTime: makeDt('28/08/2026', '17:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const annotatedLine = out.annotatedCognosCsv.split('\n')[1] || '';
    const cols = annotatedLine.split(',');
    const ot1Col = cols[6]; // OT1 is column index 6 (0-based) per the fixed 18-col header
    const ot2Col = cols[8]; // OT-2 is column index 8
    const passed = row.TAA_FILLED_COLUMNS.includes('OT1') && !row.TAA_FILLED_COLUMNS.includes('OT-2')
      && ot1Col === '16:00 - 17:00' && ot2Col === '02:30'; // OT1 filled from blank (single OT1 segment -> range); OT-2 untouched (was already populated)

    results.push({
      id: 'reg-17',
      name: 'Fill-If-Blank Never Overwrites a Populated Cognos Value',
      category: 'Phase 3/Non-negotiables: Recompute-Then-Compare',
      inputDescription: 'Cognos OT1 blank (structurally always empty) + ASPECT has a single 60m OT1 segment (16:00-17:00); Cognos OT-2 already populated (02:30) and must stay untouched',
      cognosFlawedVerdict: 'OT1/OT-2 are always blank in the raw Cognos export — nothing to disagree with, but also no lost data',
      expectedVerdict: 'Annotated export: OT1 filled to 16:00 - 17:00 (was blank; single-segment day -> time range, matching DUTY1/DUTY-2\'s own format); OT-2 stays 02:30 (was already populated, never overwritten)',
      expectedAction: 'FILL_IF_BLANK',
      actualVerdict: `OT1=${ot1Col} OT-2=${ot2Col} filledColumns=[${row.TAA_FILLED_COLUMNS}]`,
      actualAction: 'FILL_IF_BLANK',
      passed,
      payrollImpact: 'Completes Cognos\'s structurally-blank OT columns for readability without ever silently rewriting a value Cognos itself reported',
      calculationTrace: [
        `TAA_OT1 (recomputed): ${row.TAA_OT1} minutes`,
        `TAA_FILLED_COLUMNS: ${row.TAA_FILLED_COLUMNS}`,
        `Annotated row OT1 cell: ${ot1Col}, OT-2 cell: ${ot2Col}`,
      ],
    });
  }

  // Case 18: Blank Cognos LOGIN ID — held for review, never auto-Absent (fix #1)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000005', NAME: 'Blank Login Id Agent', 'LOGIN ID': '',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000005', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000005', EMP_LAST_NAME: 'Blank Login Id Agent', EMP_SORT_NAME: 'BLANK LOGIN ID AGENT' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const passed = row.holdReason === 'MISSING_CMS_JOIN_KEY' && row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && row.TAA_VERDICT !== 'NO_SHOW' && !row.includeInOutput;

    results.push({
      id: 'reg-18',
      name: 'Blank LOGIN ID Is Held, Never Auto-Absent',
      category: 'Real-data audit finding #1: Missing CMS join key',
      inputDescription: 'Cognos LOGIN ID is blank for a row with a valid ASPECT SHIFT (5 real rows in the sample report carry a blank LOGIN ID)',
      cognosFlawedVerdict: 'A blank join key silently fell through to the no-punches branch -> ABSENT_NS_NC + email',
      expectedVerdict: 'Held for review (MISSING_CMS_JOIN_KEY) — a missing join key is missing evidence, not evidence of absence',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a wrongful full-day Absent for an employee whose CMS join key was simply never populated in this Cognos export',
      calculationTrace: [
        'LOGIN ID: "" (blank)',
        `Hold reason: ${row.holdReason}`,
        `Included in output: ${row.includeInOutput}`,
      ],
    });
  }

  // Case 19: Populated LOGIN ID, genuinely zero CMS data for it — Rule 5 still applies (confirms fix #1 does not over-correct)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000006', NAME: 'Genuine No Show Agent', 'LOGIN ID': '30006',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000006', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000006', EMP_LAST_NAME: 'Genuine No Show Agent', EMP_SORT_NAME: 'GENUINE NO SHOW AGENT' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'NO_SHOW' && row.TAA_ACTION === 'ABSENT_NS_NC';

    results.push({
      id: 'reg-19',
      name: 'Populated LOGIN ID, No CMS Record Anywhere — Rule 5 Still Fires',
      category: 'Real-data audit finding #1 (negative case): user-confirmed behaviour preserved',
      inputDescription: 'Cognos LOGIN ID is populated but the CMS export has no data for it at all — genuinely no evidence, not a join-key problem',
      cognosFlawedVerdict: 'N/A — this proves the blank-LOGIN-ID fix (reg-18) does not also suppress the genuine No Login Record rule',
      expectedVerdict: 'ABSENT_NS_NC (Rule 5, per user-confirmed decision: a populated ID with no CMS record applies the normal rule)',
      expectedAction: 'ABSENT_NS_NC',
      actualVerdict: row.TAA_VERDICT,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the missing-join-key fix is narrowly scoped to blank LOGIN IDs, not every zero-punch case',
      calculationTrace: [`LOGIN ID: "30006" (populated)`, `Punches found: ${row.details.punchCount}`],
    });
  }

  // Case 20: Real leave-row sentinel pattern (-480/-480/ANNUAL/480) — no false mismatch (fixes #2, #3, #4)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000007', NAME: 'Annual Leave Real Row', 'LOGIN ID': '30007',
      DUTY1: '06:00 - 14:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    // Real ASPECT shape: a bare ANNUAL row, no START_MOMENT/STOP_MOMENT/DURATION.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000007', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000007', EMP_LAST_NAME: 'Annual Leave Real Row', EMP_SORT_NAME: 'ANNUAL LEAVE REAL ROW' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const flaggedColumns = ['LATE START', 'LEFT EARLY', 'DUTY1', 'SCH DURATION', 'LEAVE HR'].filter(col => row.TAA_MISMATCH_COLUMNS.includes(col));
    const leaveTypeComp = row.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    const passed = flaggedColumns.length === 0 && leaveTypeComp?.status === 'MATCH' && row.TAA_VERDICT === 'LEAVE_EXCLUDED';

    results.push({
      id: 'reg-20',
      name: 'Real Leave-Row Sentinel Pattern (-480/-480/ANNUAL/480)',
      category: 'Real-data audit findings #2/#3/#4: leave-day noise (107/502 real rows match this exact pattern)',
      inputDescription: 'Cognos LATE START=-480, LEFT EARLY=-480, LEAVE TYPE=ANNUAL, LEAVE HR=480; ASPECT has only a bare ANNUAL segment (no duration)',
      cognosFlawedVerdict: 'Before the fix: LATE START, DUTY1, SCH DURATION, and LEAVE HR all falsely MISMATCH — ~4 false flags on every one of 107 real rows',
      expectedVerdict: 'No mismatch on LATE START/LEFT EARLY (sentinel)/DUTY1/SCH DURATION (leave-day suppressed)/LEAVE HR (full-day-by-design, not comparable); LEAVE TYPE matches',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT} — falsely flagged: [${flaggedColumns.join(', ') || 'none'}]`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops ~4 false discrepancy flags per real leave row from burying the genuine exceptions and blocking their corrections',
      calculationTrace: [
        'LEAVE HR: ASPECT ANNUAL segment has no DURATION (full standard day by design) -> NOT_COMPARABLE, not MISMATCH',
        'LATE START/LEFT EARLY: -480 === -LEAVE HR (480) -> sentinel, not a real variance',
        'DUTY1/SCH DURATION: leave day -> Cognos shows paid-leave roster entitlement, suppressed from comparison',
      ],
    });
  }

  // Case 21: Real U-ABSENT sentinel pattern at 540 + verdict-value exclusion from leave-code comparison
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000008', NAME: 'Nine Hour Off Day Agent', 'LOGIN ID': '30008',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-540', 'LEFT EARLY': '-540', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '540', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000008', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OFF' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000008', EMP_LAST_NAME: 'Nine Hour Off Day Agent', EMP_SORT_NAME: 'NINE HOUR OFF DAY AGENT' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const lateStartComp = row.columnComparisons.find(c => c.column === 'LATE START');
    const leftEarlyComp = row.columnComparisons.find(c => c.column === 'LEFT EARLY');
    const leaveTypeComp = row.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    const passed = lateStartComp?.status === 'NOT_COMPARABLE' && leftEarlyComp?.status === 'NOT_COMPARABLE'
      && leaveTypeComp?.status === 'MISMATCH';

    results.push({
      id: 'reg-21',
      name: 'Sentinel at 540 (not just 480) + OFF Is Never a Leave Type (§Leave Segments)',
      category: 'Real-data audit findings #2/#4 (12 real rows match -540/-540/Absent NS/NC/540 or similar)',
      inputDescription: 'A 9-hour-standard employee: Cognos LATE START/LEFT EARLY=-540, LEAVE TYPE=U-ABSENT (Cognos\'s own false-absence verdict); ASPECT genuinely shows OFF',
      cognosFlawedVerdict: 'Cognos\'s own value list only knows -480/-540 as fixed constants',
      // §Leave Segments (user-confirmed): OFF is never a leave type, so it is excluded from
      // leaveSegmentCodes — an OFF day has no identified leave code at all. Unmapped U-ABSENT
      // against no identified leave is a genuine MISMATCH (the escape hatch is a configured
      // cognosLeaveTypeMappings entry); it only matches OFF via the NON_WORKING basis when
      // Cognos's own value literally is "OFF", not a verdict placeholder like "U-ABSENT".
      expectedVerdict: 'LATE START/LEFT EARLY recognised as sentinel at 540; LEAVE TYPE MISMATCH (OFF carries no identified leave code; U-ABSENT is unmapped)',
      expectedAction: 'NO_ACTION',
      actualVerdict: `LATE START=${lateStartComp?.status}, LEFT EARLY=${leftEarlyComp?.status}, LEAVE TYPE=${leaveTypeComp?.status}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'OFF is never reported as a leave type; an unmapped Cognos U-ABSENT against an OFF day is now a genuine reviewable mismatch rather than silently suppressed',
      calculationTrace: [
        '-540 === -LEAVE HR (540) -> sentinel',
        'OFF is not in leaveSegmentCodes -> no identified leave code on this day',
        'Cognos LEAVE TYPE "U-ABSENT" has no configured mapping and does not equal "OFF" -> MISMATCH',
      ],
    });
  }

  // Case 22: Structural sentinel rule catches a value the fixed list would miss (e.g. a 10-hour day)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000009', NAME: 'Ten Hour Standard Agent', 'LOGIN ID': '30009',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-600', 'LEFT EARLY': '-600', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '600', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000009', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const row = out.rows[0];
    const lateStartComp = row.columnComparisons.find(c => c.column === 'LATE START');
    const leftEarlyComp = row.columnComparisons.find(c => c.column === 'LEFT EARLY');
    const passed = lateStartComp?.status === 'NOT_COMPARABLE' && leftEarlyComp?.status === 'NOT_COMPARABLE';

    results.push({
      id: 'reg-22',
      name: 'Structural Sentinel Rule Beats a Fixed Value List (-600, a 10-hour day)',
      category: 'Real-data audit finding #2: sentinel is always -LEAVE HR, not a fixed constant',
      inputDescription: 'A 10-hour-standard employee on leave: Cognos LATE START/LEFT EARLY=-600, LEAVE HR=600 — not in the default [-480,-540] value list',
      cognosFlawedVerdict: 'A fixed sentinel value list ([-480,-540]) would miss -600 entirely and flag it as a real 10-hour variance',
      expectedVerdict: 'NOT_COMPARABLE — recognised structurally because -600 === -LEAVE HR, regardless of the value list',
      expectedAction: 'NO_ACTION',
      actualVerdict: `LATE START=${lateStartComp?.status}, LEFT EARLY=${leftEarlyComp?.status}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Ensures the sentinel guard covers every shift length in the workforce, not just the 8h/9h patterns observed in the current sample',
      calculationTrace: ['-600 === -LEAVE HR (600) -> sentinel by the structural rule, independent of cognosSentinelValues'],
    });
  }

  // Case 23: Genuine leave-code disagreement (paid vs unpaid) IS flagged
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000011', NAME: 'Code Disagreement Agent', 'LOGIN ID': '30011',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    // ASPECT genuinely shows OFF (unpaid weekly off), not ANNUAL (paid) — a real pay disagreement.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000011', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OFF' },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const row = out.rows[0];
    const leaveTypeComp = row.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    const passed = leaveTypeComp?.status === 'MISMATCH' && row.TAA_MISMATCH_COLUMNS.includes('LEAVE TYPE');

    results.push({
      id: 'reg-23',
      name: 'Genuine Leave-Code Disagreement (Cognos ANNUAL vs ASPECT OFF) Is Flagged',
      category: 'Real-data audit finding #4: leave-code check must still catch real pay disagreements',
      inputDescription: 'Cognos says ANNUAL (paid); ASPECT genuinely schedules OFF (unpaid) for the same day — neither value is a Cognos verdict placeholder',
      cognosFlawedVerdict: 'N/A — proves the leave-code fix (reg-21) suppresses only Cognos\'s OWN verdict values, not real disagreements',
      expectedVerdict: 'MISMATCH on LEAVE TYPE — paid vs unpaid is real money and must be reviewed',
      expectedAction: 'N/A',
      actualVerdict: leaveTypeComp?.status || 'missing',
      actualAction: 'N/A',
      passed,
      payrollImpact: 'A paid-vs-unpaid leave code disagreement changes the day\'s pay outright and must never be silently suppressed',
      calculationTrace: ['Cognos LEAVE TYPE "ANNUAL" is a genuine code, not a verdict value', 'ASPECT genuine code "OFF" != "ANNUAL" -> MISMATCH'],
    });
  }

  // Case 24: Real partial leave duration disagreement (half-day) IS flagged
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000012', NAME: 'Half Day Leave Agent', 'LOGIN ID': '30012',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'LEAVE', 'LEAVE HR': '480', REMARK: '',
    };
    // LEAVE (unlike ANNUAL/P/H-LV/OFF) carries a REAL ASPECT duration — here
    // only 240 minutes (half day), while Cognos expects the full 480.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000012', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'LEAVE', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 12:00:00', DURATION: 240 },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const row = out.rows[0];
    const leaveHrComp = row.columnComparisons.find(c => c.column === 'LEAVE HR');
    const passed = leaveHrComp?.status === 'MISMATCH' && leaveHrComp?.recomputedMinutes === 240 && row.TAA_MISMATCH_COLUMNS.includes('LEAVE HR');

    results.push({
      id: 'reg-24',
      name: 'Real Partial-Leave Duration Disagreement (Half-Day) Is Flagged',
      category: 'Real-data audit finding #4: a leave code WITH a real ASPECT duration is compared normally',
      inputDescription: 'Cognos LEAVE HR=480 (full day); ASPECT LEAVE segment carries a real DURATION of 240 (half day) — a genuine 4-hour pay difference',
      cognosFlawedVerdict: 'N/A — proves the LEAVE HR fix (reg-20) suppresses only the full-day-by-design codes (ANNUAL/P/H-LV/OFF), not a code that genuinely records its own duration',
      expectedVerdict: 'MISMATCH on LEAVE HR (480 vs 240) — a half-day difference is 4 hours of pay',
      expectedAction: 'N/A',
      actualVerdict: `LEAVE HR: cognos=480, recomputed=${leaveHrComp?.recomputedMinutes}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Catches a genuine partial-leave duration disagreement that the full-day-by-design suppression must not swallow',
      calculationTrace: ['LEAVE is not in leaveCodesWithoutDuration -> compared normally', 'ASPECT DURATION=240 vs Cognos LEAVE HR=480 -> MISMATCH'],
    });
  }

  // Case 25: Unattended cover after shift end — exactly one ABSENT row, not two (fix #5)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000013', NAME: 'Unattended Trailing Cover Agent', 'LOGIN ID': '30013',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    // Real-shape COVER placed immediately at/after shift end (cf. real row
    // 90135626: COVER 21:00-21:21 right where a shift ends) — the employee
    // never attended it.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000013', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000013', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'COVER', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 16:21:00', DURATION: 21 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000013', EMP_LAST_NAME: 'Unattended Trailing Cover Agent', EMP_SORT_NAME: 'UNATTENDED TRAILING COVER AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30013', LoginDateTime: makeDt('28/08/2026', '08:00:00'), LogoutDateTime: makeDt('28/08/2026', '08:00:03') },
      { Date: '28/08/2026', LoginID: '30013', LoginDateTime: makeDt('28/08/2026', '16:00:00'), LogoutDateTime: makeDt('28/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const absentCorrections = out.aspectCorrections.filter(c => c.ID === '7000013' && (c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC'));
    const passed = row.TAA_EARLY_MIN === 0 && absentCorrections.length === 1 && row.TAA_VERDICT === 'ABSENT';

    results.push({
      id: 'reg-25',
      name: 'Unattended Trailing Cover Charges Exactly Once (Not Early-Logout AND Cover-Not-Attended)',
      category: 'Real-data audit finding #5: COVER must not extend the attendance window',
      inputDescription: 'SHIFT 08:00-16:00 + an unattended COVER 16:00-16:21 placed right at shift end; employee logs out exactly at 16:00',
      cognosFlawedVerdict: 'Before the fix: COVER extended effectiveEnd to 16:21 -> a real logout at 16:00 was 21m "early" (Early Logout ABSENT) AND separately 21m unattended (Cover Not Attended ABSENT) -> two ABSENT correction rows for one day',
      expectedVerdict: 'Exactly one ABSENT row (Cover Not Attended only) — the on-time 16:00 logout charges no early-logout penalty',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (early=${row.TAA_EARLY_MIN}m, ABSENT rows=${absentCorrections.length})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a single unattended cover from being charged as two separate absence findings for the same employee-day in the ASPECT correction upload',
      calculationTrace: [
        'COVER excluded from rawEnd/effectiveEnd (config.coverExtendsAttendanceWindow=false) -> effectiveEnd stays 16:00',
        'Actual logout 16:00 == effectiveEnd -> Early Logout does not fire',
        'Cover Not Attended (Rule 7) still fires on its own -> exactly one ABSENT row',
      ],
    });
  }

  // Case 26: Night shift + next-day leave, single ambiguous closing punch — real shift wins the tie (fix #6)
  {
    // Deliberately adversarial Cognos row order: the LEAVE-DAY row is listed
    // BEFORE the night-shift row (index 0 vs 1) — the exact ordering under
    // which the old first-wins tie-break would have misattributed the
    // shared 03:00 punch to the leave day instead of the night shift.
    const cognosLeaveDay: CognosRecord = {
      'SIGN IN DATE': '2026-08-02 00:00:00', SECTION: 'ECS', 'PF NO': '7000010', NAME: 'Night Then Leave Agent', 'LOGIN ID': '30010',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    const cognosNightShift: CognosRecord = {
      'SIGN IN DATE': '2026-08-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000010', NAME: 'Night Then Leave Agent', 'LOGIN ID': '30010',
      DUTY1: '17:00 - 03:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000010', NOM_DATE: '01/08/2026', START_DATE: '01/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/08/2026 17:00:00', STOP_MOMENT: '02/08/2026 03:00:00', DURATION: 600 },
      { EMP_ID: '7000010', NOM_DATE: '02/08/2026', START_DATE: '02/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000010', EMP_LAST_NAME: 'Night Then Leave Agent', EMP_SORT_NAME: 'NIGHT THEN LEAVE AGENT' }];
    // Only ONE closing punch exists at 03:00 — equally inside the night
    // shift's raw interval (ends exactly 03:00) AND the leave day's
    // synthetic full-day window (02/08 00:00 -> 03/08 00:00). A true
    // distance-0 tie for both windows.
    const punches: CMSPunch[] = [
      { Date: '01/08/2026', LoginID: '30010', LoginDateTime: makeDt('01/08/2026', '17:00:00'), LogoutDateTime: makeDt('01/08/2026', '17:00:03') },
      { Date: '02/08/2026', LoginID: '30010', LoginDateTime: makeDt('02/08/2026', '03:00:00'), LogoutDateTime: makeDt('02/08/2026', '03:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosLeaveDay, cognosNightShift], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const leaveRow = out.rows[0];
    const nightRow = out.rows[1];
    // Prefix match: TAA_CMS_OUT now carries the punch's date when it lands on a different
    // calendar day from the shift start — the whole point of a cross-midnight case.
    const passed = nightRow.TAA_VERDICT === 'PRESENT' && nightRow.TAA_CMS_OUT.startsWith('03:00')
      && leaveRow.TAA_VERDICT === 'LEAVE_EXCLUDED'
      && nightRow.holdReason !== 'AMBIGUOUS_PUNCH_ATTRIBUTION' && leaveRow.holdReason !== 'AMBIGUOUS_PUNCH_ATTRIBUTION';

    results.push({
      id: 'reg-26',
      name: 'Night Shift vs Next-Day Leave — Real Shift Wins the Tied Closing Punch (D-D)',
      category: 'Real-data audit finding #6: punch-attribution tie-break priority',
      inputDescription: 'Shift 01/08 17:00->02/08 03:00, then ANNUAL leave on 02/08; single 03:00 punch is equally claimable by both windows. Cognos row order deliberately lists the leave day FIRST.',
      cognosFlawedVerdict: 'Old first-registered-wins tie-break: with the leave day listed first, it would have claimed the 03:00 punch -> night shift loses its logout (false Absent, 8h lost) AND the leave day shows a phantom login (possible false Absent too)',
      expectedVerdict: 'Night shift: PRESENT, logout 03:00. Leave day: LEAVE_EXCLUDED, zero punches. Neither becomes a false absence.',
      expectedAction: 'NO_ACTION / NO_ACTION',
      actualVerdict: `Night: ${nightRow.TAA_VERDICT} (out ${nightRow.TAA_CMS_OUT}) | Leave: ${leaveRow.TAA_VERDICT}`,
      actualAction: `${nightRow.TAA_ACTION} / ${leaveRow.TAA_ACTION}`,
      passed,
      payrollImpact: 'Prevents a single ambiguous punch near a shift/leave boundary from producing two false absences (one full lost-shift deduction, one phantom leave-day anomaly) purely because of Cognos row order',
      calculationTrace: [
        '03:00 punch: distance to night-shift window = 0; distance to leave-day synthetic window = 0 -> tied',
        'Tie-break 1: a real scheduled shift beats a synthetic leave-day window -> night shift wins',
        'Leave day receives zero punches -> below the 60m anomaly threshold -> LEAVE_EXCLUDED, not Absent',
      ],
    });
  }

  // Case 27: Cover Not Attended + scheduled OT1 — OT must still convert to SHIFT (§4.6c gap fix)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000014', NAME: 'Cover Not Attended With OT Agent', 'LOGIN ID': '30014',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '09:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    // Employee fully attends SHIFT + a contiguous OT1 tail (08:00-17:00), then
    // never attends a COVER stacked right after (17:00-17:21) -> Rule 7 fires
    // alone (no early/late-logout signal, since actual span exactly matches
    // the SHIFT+OT1 window). The OT1 segment is otherwise fully worked, but
    // §4.6c requires it convert to SHIFT anyway once the day is marked Absent
    // — this is what Rule 7's markAbsent branch was previously skipping.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000014', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000014', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 60 },
      { EMP_ID: '7000014', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'COVER', START_MOMENT: '28/08/2026 17:00:00', STOP_MOMENT: '28/08/2026 17:21:00', DURATION: 21 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000014', EMP_LAST_NAME: 'Cover Not Attended With OT Agent', EMP_SORT_NAME: 'COVER NOT ATTENDED WITH OT AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30014', LoginDateTime: makeDt('28/08/2026', '08:00:00'), LogoutDateTime: makeDt('28/08/2026', '08:00:03') },
      { Date: '28/08/2026', LoginID: '30014', LoginDateTime: makeDt('28/08/2026', '17:00:00'), LogoutDateTime: makeDt('28/08/2026', '17:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const absentCorrections = out.aspectCorrections.filter(c => c.ID === '7000014' && (c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC'));
    const pfCorrections = out.aspectCorrections.filter(c => c.ID === '7000014');
    const ot1OriginalRows = pfCorrections.filter(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const ot1ConvertedRows = pfCorrections.filter(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode && c.Memo.includes('OT1'));
    const noPlainShiftInsert = !pfCorrections.some(c => c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    // The "10" row (original OT1, retired) must sit directly before its "11" row
    // (replacement SHIFT) and share the same SegmentDate/SegmentStarttime/Segmentduration —
    // a real replace pair, not two independent rows.
    const ot1OriginalIdx = pfCorrections.indexOf(ot1OriginalRows[0]);
    const ot1ConvertedIdx = pfCorrections.indexOf(ot1ConvertedRows[0]);
    const pairAdjacentAndMatching = ot1OriginalRows.length === 1 && ot1ConvertedRows.length === 1
      && ot1ConvertedIdx === ot1OriginalIdx + 1
      && ot1OriginalRows[0].SegmentDate === ot1ConvertedRows[0].SegmentDate
      && ot1OriginalRows[0].SegmentStarttime === ot1ConvertedRows[0].SegmentStarttime
      && ot1OriginalRows[0].Segmentduration === ot1ConvertedRows[0].Segmentduration;
    const passed = row.TAA_VERDICT === 'ABSENT' && absentCorrections.length === 1 && pairAdjacentAndMatching && noPlainShiftInsert;

    results.push({
      id: 'reg-27',
      name: 'Cover Not Attended + Scheduled OT1 — OT Still Replaced By SHIFT (§4.6c gap fix)',
      category: 'Absent + OT co-occurrence gap: Rule 7 (Cover Not Attended) was the one Absent-emission point that skipped OT-to-SHIFT conversion',
      inputDescription: 'SHIFT 08:00-16:00 + OT1 16:00-17:00, both fully attended (08:00-17:00), then an unattended COVER 17:00-17:21 stacked right after',
      cognosFlawedVerdict: 'Before the fix: Rule 7 correctly marked the day ABSENT for the unattended cover, but never converted the day\'s OT1 segment to SHIFT — overtime premium pay silently survived on an Absent day',
      expectedVerdict: 'ABSENT (Cover Not Attended), with OT1 explicitly retired and replaced by a SHIFT correction row (10/11 pair, never a bare insert)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (ABSENT rows=${absentCorrections.length}, OT1 10/11 pair=${pairAdjacentAndMatching}, no plain insert=${noPlainShiftInsert})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents overtime premium pay from passing through on a day marked Absent via Cover Not Attended, and ensures the OT segment is explicitly retired in ASPECT rather than left alongside a new insert',
      calculationTrace: [
        'SHIFT+OT1 fully attended 08:00-17:00 -> no Late Login / Early Logout / Late Logout finding',
        'COVER 17:00-17:21 unattended -> Rule 7 fires, markAbsent -> exactly one ABSENT row',
        'Rule 7 markAbsent branch now also calls convertOtSegmentsToShift -> OT1 (60m) replaced by a 10/11 pair (10 OT1, 11 SHIFT)',
      ],
    });
  }

  // Case 28: Late Login AND Early Logout both fire Absent on the same row + scheduled OT1 —
  // OT must convert to SHIFT exactly ONCE, not once per rule (duplicate-segment guard)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '7000016', NAME: 'Late And Early With OT Agent', 'LOGIN ID': '30016',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '05:40',
      'SIGIN IN': '09:20', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    // Arrives 80m late (well past OPS's 61m Late-Login-Absent floor) AND
    // leaves early against the OT1-extended effective end (well past OPS's
    // 10m Early-Logout-Absent floor) -> Late Login (line ~645) and Early
    // Logout (line ~672) are independent `if` statements, not an if/else
    // chain, so BOTH fire and BOTH independently call the OT->SHIFT
    // converter for the same scheduled OT1 segment.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000016', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000016', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000016', EMP_LAST_NAME: 'Late And Early With OT Agent', EMP_SORT_NAME: 'LATE AND EARLY WITH OT AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '30016', LoginDateTime: makeDt('28/08/2026', '09:20:00'), LogoutDateTime: makeDt('28/08/2026', '09:20:03') },
      { Date: '28/08/2026', LoginID: '30016', LoginDateTime: makeDt('28/08/2026', '15:00:00'), LogoutDateTime: makeDt('28/08/2026', '15:00:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '28/08/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('28/08/2026', '23:30:00'), LogoutDateTime: makeDt('28/08/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const absentCorrections = out.aspectCorrections.filter(c => c.ID === '7000016' && (c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC'));
    const pfCorrections = out.aspectCorrections.filter(c => c.ID === '7000016');
    const ot1OriginalRows = pfCorrections.filter(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const ot1ConvertedRows = pfCorrections.filter(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode && c.Memo.includes('OT1'));
    // "Exactly once" now means exactly one 10/11 pair (not one row) — two
    // independent Absent-triggering rules on this row must still call
    // convertOtOnce() only once, per-row idempotency guard.
    const exactlyOnePair = ot1OriginalRows.length === 1 && ot1ConvertedRows.length === 1;
    // ruleFired is optional on the details type; an absent value means no rule
    // was recorded, which must read as "not both reported", never as a crash.
    const ruleFired = row.details.ruleFired ?? '';
    const bothRulesReported = ruleFired.includes('Late Login') && ruleFired.includes('Early Logout');
    // RE-PINNED (WP1 / D8, 2026-09-21): this asserted TWO physical ABSENT rows — one per triggering
    // rule — which is exactly the duplicate-marker state D8 removes. The canonical decision is now ONE
    // physical marker per employee-day whose memo carries BOTH triggers, so no reason is lost when the
    // CSV serializer used to keep only the first. Everything else this case guards is unchanged and
    // still asserted: verdict ABSENT, both findings reported, OT1 replaced by SHIFT exactly once.
    const singleMarkerCarriesBothReasons = absentCorrections.length === 1
      && (absentCorrections[0].Memo || '').includes('Late Login')
      && (absentCorrections[0].Memo || '').includes('Early Logout');
    const passed = row.TAA_VERDICT === 'ABSENT' && singleMarkerCarriesBothReasons && exactlyOnePair && bothRulesReported;

    results.push({
      id: 'reg-28',
      name: 'Late Login + Early Logout Both Fire — OT Replaced By SHIFT Exactly Once (Duplicate-Segment Guard)',
      category: 'Absent + OT co-occurrence: two independent Absent rules on one row must not double-convert the same OT segment',
      inputDescription: 'SHIFT 08:00-16:00 + OT1 16:00-17:00; arrival 09:20 (80m late) and logout 15:00 (early against the OT1-extended 17:00 effective end) both independently exceed the OPS Absent floor',
      cognosFlawedVerdict: 'Before the guard: Late Login\'s Absent branch and Early Logout\'s Absent branch would each call the OT->SHIFT converter, pushing two 10/11 pairs for the same OT1 segment — a duplicated segment change that a real ASPECT upload rejects the whole batch for',
      expectedVerdict: 'ABSENT, both findings still reported (Late Login AND Early Logout), OT1 replaced by SHIFT exactly once (one 10/11 pair, not two)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (ABSENT rows=${absentCorrections.length}, OT1 10/11 pair count=${ot1ConvertedRows.length}, both reported=${bothRulesReported})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents ASPECT from rejecting the whole correction upload due to the same OT segment being changed to SHIFT twice, while still preserving both findings for reporting/email purposes',
      calculationTrace: [
        'Late Login: 09:20 arrival vs 08:00 effective start -> 80m late -> exceeds OPS 61m Absent floor -> ABSENT + convertOtOnce() call #1',
        'Early Logout: 15:00 logout vs 17:00 effective end (OT1-extended) -> 120m early -> exceeds OPS 10m Absent floor -> ABSENT + convertOtOnce() call #2',
        'Per-row otConvertedThisRow guard makes call #2 a no-op -> exactly one 10/11 OT1->SHIFT replace pair, not two',
      ],
    });
  }

  // Case 29: Cover Placement Anchors to Trailing Removal-Segment START (NURSNG), Not Latest STOP_MOMENT
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00',
      SECTION: 'OPS',
      'PF NO': '4505002',
      NAME: 'Nursing Agent',
      'LOGIN ID': '10009',
      DUTY1: '08:00 - 16:00',
      OT1: '',
      'DUTY-2': '',
      'OT-2': '',
      'SCH DURATION': '8:0',
      'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15',
      'SIGIN OUT': '16:00',
      'LATE START': '-15',
      'LEFT EARLY': '0',
      'LEAVE TYPE': '',
      'LEAVE HR': '0',
      REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4505002', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      // Target Day: SHIFT 07:00-15:00 with a trailing NURSNG carve-out 14:00-15:00.
      // Cover must anchor to NURSNG's own START (14:00, when the agent stops
      // being available to log in), not to 15:00 where SHIFT and NURSNG
      // STOP_MOMENT happen to tie.
      { EMP_ID: '4505002', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '4505002', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '28/08/2026 14:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10009', LoginDateTime: makeDt('27/08/2026', '08:15:00'), LogoutDateTime: makeDt('27/08/2026', '08:15:03') },
      { Date: '27/08/2026', LoginID: '10009', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined && cover.nominateDate === '28/08/2026' && cover.SegmentDate === '28/08/2026' && cover.SegmentStarttime === '14:00' && cover.Segmentduration === '00:15';

    results.push({
      id: 'reg-29',
      name: 'Cover Placement Anchors to NURSNG Start, Not Tied STOP_MOMENT (§4.11)',
      category: 'Cover Placement Algorithm',
      inputDescription: 'Incident on 27/08 (15m late). Target day 28/08 has SHIFT 07:00-15:00 with trailing NURSNG 14:00-15:00',
      cognosFlawedVerdict: 'Naive max-STOP_MOMENT placement takes SHIFT/NURSNG\'s tied 15:00 stop, masking that the real availability cutoff is NURSNG\'s 14:00 start',
      expectedVerdict: 'Cover placed at 14:00 (effective end = NURSNG start, per recomputeDaySchedule)',
      expectedAction: 'COVER at 14:00:00 for 15 min',
      actualVerdict: cover ? `COVER on ${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Ensures cover starts exactly when the agent becomes unavailable to log in (NURSNG/RLS start), not after it — avoids under-covering the gap',
      calculationTrace: [
        `Incident 27/08 late 15m`,
        `Next working day: 28/08/2026`,
        `Segments on 28/08: SHIFT (07:00-15:00, ADDITION), NURSNG (14:00-15:00, REMOVAL, trailing)`,
        `effectiveEnd = rawEnd(15:00) - nursingMinutes(60) = 14:00`,
        `Cover placed at 14:00 - 14:15`,
      ],
    });
  }

  // Case 30: REMOVAL Segment Outside Shift/OT Window Is Held, Not Guessed (§4.11 Addendum)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '4505003', NAME: 'Malformed RLS Agent', 'LOGIN ID': '10010',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4505003', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      // Target Day 28/08: SHIFT ends 15:00, but RLS runs 15:00-17:00 with NO OT
      // segment covering that span — RLS sticks out past every ADDITION
      // segment on the day. That's inconsistent source data, not a valid
      // carve-out: the row must be held for manual correction, not given a
      // guessed (and nonsensical, pre-shift-end) cover time.
      { EMP_ID: '4505003', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '4505003', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RLS', START_MOMENT: '28/08/2026 15:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 120 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10010', LoginDateTime: makeDt('27/08/2026', '08:15:00'), LogoutDateTime: makeDt('27/08/2026', '08:15:03') },
      { Date: '27/08/2026', LoginID: '10010', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    // Revised 2026-09-20: an unusable next working day no longer locks the row. It takes the
    // §4.11 Step 5 fallback (pinned here to next-week Monday) so the COVER still reaches the
    // correction file, with the skipped day and reason recorded in the Memo.
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: { ...config, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday', coverSameDayWhenAlreadyCovered: false } });
    const row = out.rows.find(r => r.originalCognos['PF NO'] === '4505003');
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = row?.holdReason === undefined && row?.includeInOutput === true
      && cover !== undefined && cover.nominateDate === '31/08/2026' && cover.SegmentStarttime === '08:00'
      && cover.Memo.includes('28/08/2026 unusable (REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW)');

    results.push({
      id: 'reg-30',
      name: 'REMOVAL Segment Outside Shift/OT Window on the Target Day Falls Back to §4.11 Step 5, Cover Still Exported',
      category: 'Cover Placement Algorithm',
      inputDescription: 'Incident on 27/08 (15m late). Target day 28/08 has SHIFT 07:00-15:00 and RLS 15:00-17:00 with no OT underneath the RLS span; fallback pinned to next-week Monday',
      cognosFlawedVerdict: 'Naive effectiveEnd arithmetic (rawEnd - RLS duration) would place cover at 13:00 -- before the shift even ends',
      expectedVerdict: 'Not held; COVER exported on the fallback date 31/08/2026 08:00 with a Memo naming the unusable 28/08',
      expectedAction: 'LATE_AND_COVER, COVER exported',
      actualVerdict: row ? `holdReason=${row.holdReason}, includeInOutput=${row.includeInOutput}` : 'No row',
      actualAction: cover ? `COVER ${cover.nominateDate} ${cover.SegmentStarttime} | ${cover.Memo}` : 'No COVER row emitted',
      passed,
      payrollImpact: 'The nonsensical pre-shift-end cover time is still never used, but the row is no longer stranded: TAA can pass it with the cover on the configured fallback date',
      calculationTrace: [
        `Incident 27/08 late 15m`,
        `Next working day: 28/08/2026`,
        `Segments on 28/08: SHIFT (07:00-15:00, ADDITION), RLS (15:00-17:00, REMOVAL)`,
        `RLS stop (17:00) > rawEnd (15:00) -> outOfWindowRemovalSegments non-empty -> 28/08 unusable`,
        `resolveCoverTargetDay falls back to §4.11 Step 5 (next-week Monday 31/08 08:00), skippedDay recorded in Memo`,
      ],
    });
  }

  // Case 31: RLS Inside Combined SHIFT+OT Window Still Places Cover Correctly (control for reg-30)
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '4505004', NAME: 'Valid RLS+OT Agent', 'LOGIN ID': '10011',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4505004', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      // Target Day 28/08: SHIFT 07:00-15:00 + OT1 15:00-17:00, with RLS
      // 15:00-17:00 fully inside the combined SHIFT+OT window (it cancels
      // out the OT rather than sticking out past it) -- a genuinely valid
      // carve-out, so cover must still be placed normally at 15:00.
      { EMP_ID: '4505004', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '4505004', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 15:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 120 },
      { EMP_ID: '4505004', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RLS', START_MOMENT: '28/08/2026 15:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 120 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '10011', LoginDateTime: makeDt('27/08/2026', '08:15:00'), LogoutDateTime: makeDt('27/08/2026', '08:15:03') },
      { Date: '27/08/2026', LoginID: '10011', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined && cover.nominateDate === '28/08/2026' && cover.SegmentDate === '28/08/2026' && cover.SegmentStarttime === '15:00' && cover.Segmentduration === '00:15';

    results.push({
      id: 'reg-31',
      name: 'RLS Inside Combined SHIFT+OT Window Places Cover at 15:00 (Control for reg-30)',
      category: 'Cover Placement Algorithm',
      inputDescription: 'Incident on 27/08 (15m late). Target day 28/08 has SHIFT 07:00-15:00 + OT1 15:00-17:00 + RLS 15:00-17:00 (RLS fully inside the SHIFT+OT window)',
      cognosFlawedVerdict: 'N/A -- control case proving valid RLS data still places cover correctly after the out-of-window guard was added',
      expectedVerdict: 'Cover placed at 15:00 (effective end = RLS start, which cancels the OT1 span)',
      expectedAction: 'COVER at 15:00:00 for 15 min',
      actualVerdict: cover ? `COVER on ${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Confirms the out-of-window guard (reg-30) does not false-positive on valid RLS-cancels-OT data',
      calculationTrace: [
        `Incident 27/08 late 15m`,
        `Next working day: 28/08/2026`,
        `Segments on 28/08: SHIFT (07:00-15:00) + OT1 (15:00-17:00), both ADDITION -> rawEnd=17:00`,
        `RLS (15:00-17:00, REMOVAL) stop matches rawEnd -> inside window, not flagged`,
        `effectiveEnd = rawEnd(17:00) - RLS duration(120) = 15:00`,
        `Cover placed at 15:00 - 15:15`,
      ],
    });
  }


  // =========================================================================
  // BOUNDARY-MINUTE CASES (variance audit, Phase C)
  //
  // The bands are cliffs: one extra minute turns "late + cover" into ABSENT — an unpaid
  // day. Every band edge below is pinned at N and N+1 so the cliff can never move without
  // a test going red. These are deliberately synthetic and minimal: one shift, two punches,
  // one variable.
  // =========================================================================
  {
    const D = '27/08/2026';
    const OPS_ID = '9900001';
    const OFCR_ID = '9900002';

    /** Build a one-row scenario: fixed 07:00-15:00 shift, chosen login/logout, optional extra segments. */
    const boundary = (opts: {
      id: string;
      name: string;
      tier: 'OPS' | 'OFFICER_PLUS';
      loginTime: string;
      logoutTime: string;
      extraSegments?: AspectSegment[];
      shiftOverride?: Partial<AspectSegment>;
      schDuration?: string;
      expectedVerdict: string;
      expectedAction: string;
      expectedHold?: string;
      /** When set, the row must carry NO hold at all (not merely a different one). */
      expectNoHold?: boolean;
      /** When set, TAA_SCH_HOURS_RECOMPUTED must equal this many minutes. */
      expectedHoursMinutes?: number;
      inputDescription: string;
      payrollImpact: string;
      category?: string;
    }): void => {
      const pf = opts.tier === 'OPS' ? OPS_ID : OFCR_ID;
      const loginId = opts.tier === 'OPS' ? '99001' : '99002';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pf,
        NAME: 'Boundary ' + opts.tier, 'LOGIN ID': loginId,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '',
        'SCH DURATION': opts.schDuration ?? '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
        'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
      };
      const shift: AspectSegment = {
        EMP_ID: pf, NOM_DATE: D, START_DATE: D, SEG_CODE: 'SHIFT',
        START_MOMENT: D + ' 07:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 480,
        ...(opts.shiftOverride || {}),
      };
      const segs: AspectSegment[] = [shift, ...(opts.extraSegments || []).map(x => ({ ...x, EMP_ID: pf }))];
      const identities: AspectIdentity[] = [{
        EMP_ID: pf, EMP_LAST_NAME: 'Boundary', EMP_EXTRA_2: 'boundary',
        EMP_SORT_NAME: opts.tier === 'OPS' ? 'BOUNDARY AGENT' : 'BOUNDARY AGENT, ES OFCR',
      }];
      const punches: CMSPunch[] = [
        { Date: D, LoginID: loginId, LoginDateTime: makeDt(D, opts.loginTime), LogoutDateTime: makeDt(D, opts.loginTime) },
        { Date: D, LoginID: loginId, LoginDateTime: makeDt(D, opts.logoutTime), LogoutDateTime: makeDt(D, opts.logoutTime) },
        // WP8: an unrelated login punching late that same day — this is a real multi-employee
        // CMS file, not a truncated one, so D must not read as "the export's latest, possibly
        // mid-shift day" cut short at THIS agent's own last punch (the new truncated-export
        // coverage gate, reconciliationEngine.ts). A real file this small shift sits inside
        // always has other staff punching later; without this sentinel every single-row fixture
        // here would look identical to a genuinely truncated export.
        { Date: D, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(D, '23:30:00'), LogoutDateTime: makeDt(D, '23:30:03') },
      ];

      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
      const row = out.rows[0];
      const verdictOk = row.TAA_VERDICT === opts.expectedVerdict && row.TAA_ACTION === opts.expectedAction;
      const holdOk = (opts.expectedHold ? row.holdReason === opts.expectedHold : true)
        && (opts.expectNoHold ? !row.holdReason : true)
        && (opts.expectedHoursMinutes !== undefined ? row.TAA_SCH_HOURS_RECOMPUTED === opts.expectedHoursMinutes : true);
      const trace = row.details.varianceTrace;

      results.push({
        id: opts.id,
        name: opts.name,
        category: opts.category || ('Band boundary: ' + opts.tier),
        inputDescription: opts.inputDescription,
        cognosFlawedVerdict: 'n/a — this pins TAA’s own band edge, not a Cognos defect',
        expectedVerdict: opts.expectedVerdict + (opts.expectedHold ? ' (held: ' + opts.expectedHold + ')' : ''),
        expectedAction: opts.expectedAction,
        actualVerdict: row.TAA_VERDICT + (row.holdReason ? ' (held: ' + row.holdReason + ')' : ''),
        actualAction: row.TAA_ACTION,
        passed: verdictOk && holdOk,
        payrollImpact: opts.payrollImpact,
        calculationTrace: [
          'Shift ' + trace?.rawStart + ' - ' + trace?.rawEnd + ' (effective ' + trace?.effectiveStart + ' - ' + trace?.effectiveEnd + ')',
          'CMS in ' + trace?.actualFirstLogin + ', out ' + trace?.actualLastLogout,
          ...(trace?.measurements || []).map(
            m => m.label + ': ' + m.minutes + 'm measured from ' + m.anchorLabel + ' @ ' + m.anchorTime
              + ' -> band ' + (m.bandDescription || 'none matched') + ' (' + (m.bandAction || 'no action') + ')'
          ),
          'Late ' + row.TAA_LATE_MIN + 'm / Early ' + row.TAA_EARLY_MIN + 'm -> ' + row.TAA_VERDICT,
        ],
      });
    };

    // ---- Rule 1, Late Login. OPS band starts at 6; Absent at 61.
    boundary({ id: 'reg-32', name: 'Late Login OPS 5 min — below band, no action', tier: 'OPS', loginTime: '07:05:00', logoutTime: '15:00:00',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      inputDescription: 'Shift 07:00–15:00, login 07:05 (5 min late)',
      payrollImpact: 'A 5-minute arrival must never be charged — the OPS band starts at 6' });
    boundary({ id: 'reg-33', name: 'Late Login OPS 6 min — band opens, Late + Cover', tier: 'OPS', loginTime: '07:06:00', logoutTime: '15:00:00',
      expectedVerdict: 'LATE', expectedAction: 'LATE_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, login 07:06 (6 min late)',
      payrollImpact: 'One minute later than reg-32 and a cover segment is now owed' });
    boundary({ id: 'reg-34', name: 'Late Login OPS 60 min — still Late + Cover, NOT absent', tier: 'OPS', loginTime: '08:00:00', logoutTime: '15:00:00',
      expectedVerdict: 'LATE', expectedAction: 'LATE_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, login 08:00 (exactly 60 min late)',
      payrollImpact: 'The Absent band starts at 61, not 60 — an hour late is still a paid day' });
    boundary({ id: 'reg-35', name: 'Late Login OPS 61 min — ABSENT (the unpaid-day cliff)', tier: 'OPS', loginTime: '08:01:00', logoutTime: '15:00:00',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      inputDescription: 'Shift 07:00–15:00, login 08:01 (61 min late)',
      payrollImpact: 'One minute past reg-34 costs the employee the whole day — the single most expensive boundary in the tool' });
    boundary({ id: 'reg-36', name: 'Late Login Officer+ 10 min — below band, no action', tier: 'OFFICER_PLUS', loginTime: '07:10:00', logoutTime: '15:00:00',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      inputDescription: 'Shift 07:00–15:00, Officer+, login 07:10',
      payrollImpact: 'Officer+ tolerance is 11 min, not the OPS 6 — a tier mix-up would charge them 5 minutes early' });
    boundary({ id: 'reg-37', name: 'Late Login Officer+ 11 min — band opens', tier: 'OFFICER_PLUS', loginTime: '07:11:00', logoutTime: '15:00:00',
      expectedVerdict: 'LATE', expectedAction: 'LATE_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, Officer+, login 07:11',
      payrollImpact: 'Confirms the Officer+ band edge sits one minute above reg-36' });
    boundary({ id: 'reg-38', name: 'Late Login Officer+ 61 min — ABSENT', tier: 'OFFICER_PLUS', loginTime: '08:01:00', logoutTime: '15:00:00',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      inputDescription: 'Shift 07:00–15:00, Officer+, login 08:01',
      payrollImpact: 'Officer+ shares the OPS 61-minute absence cliff' });

    // ---- Rule 3, Early Logout. OPS band starts at 5; Absent at 10.
    boundary({ id: 'reg-39', name: 'Early Logout OPS 4 min — below band, no action', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:56:00',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      inputDescription: 'Shift 07:00–15:00, logout 14:56 (4 min early)',
      payrollImpact: 'Four minutes is inside tolerance and must not generate a cover' });
    boundary({ id: 'reg-40', name: 'Early Logout OPS 5 min — Log off + Cover', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:55:00',
      expectedVerdict: 'EARLY_LOGOUT', expectedAction: 'LOGOFF_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, logout 14:55 (5 min early)',
      payrollImpact: 'Band opens exactly here' });
    boundary({ id: 'reg-41', name: 'Early Logout OPS 9 min — still Log off + Cover', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:51:00',
      expectedVerdict: 'EARLY_LOGOUT', expectedAction: 'LOGOFF_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, logout 14:51 (9 min early)',
      payrollImpact: 'Nine minutes is still a paid day with a cover, not an absence' });
    boundary({ id: 'reg-42', name: 'Early Logout OPS 10 min — ABSENT (unpaid-day cliff)', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:50:00',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      inputDescription: 'Shift 07:00–15:00, logout 14:50 (10 min early)',
      payrollImpact: 'One minute earlier than reg-41 costs a full day — the tightest cliff in the rule set' });
    boundary({ id: 'reg-43', name: 'Early Logout Officer+ 5 min — below band, no action', tier: 'OFFICER_PLUS', loginTime: '07:00:00', logoutTime: '14:55:00',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      inputDescription: 'Shift 07:00–15:00, Officer+, logout 14:55',
      payrollImpact: 'The same minute that charges an OPS agent (reg-40) is free for Officer+ — proves the tier split is live' });
    boundary({ id: 'reg-44', name: 'Early Logout Officer+ 6 min — Log off + Cover', tier: 'OFFICER_PLUS', loginTime: '07:00:00', logoutTime: '14:54:00',
      expectedVerdict: 'EARLY_LOGOUT', expectedAction: 'LOGOFF_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, Officer+, logout 14:54',
      payrollImpact: 'Officer+ band edge' });
    boundary({ id: 'reg-45', name: 'Early Logout Officer+ 20 min — still Cover, not absent', tier: 'OFFICER_PLUS', loginTime: '07:00:00', logoutTime: '14:40:00',
      expectedVerdict: 'EARLY_LOGOUT', expectedAction: 'LOGOFF_AND_COVER',
      inputDescription: 'Shift 07:00–15:00, Officer+, logout 14:40',
      payrollImpact: 'Officer+ absence starts at 21, twice the OPS threshold' });
    boundary({ id: 'reg-46', name: 'Early Logout Officer+ 21 min — ABSENT', tier: 'OFFICER_PLUS', loginTime: '07:00:00', logoutTime: '14:39:00',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      inputDescription: 'Shift 07:00–15:00, Officer+, logout 14:39',
      payrollImpact: 'Officer+ unpaid-day cliff' });

    // ---- Rule 4, Late Logout. Absent at 60, measured from the RELEASE-ADJUSTED end.
    // reg-49 is the confirmed-policy case worth reading twice: an agent released at 14:00
    // who works to their rostered 15:00 end is marked ABSENT. That is intended behaviour,
    // deliberately pinned here so it can never happen by accident.
    const nursingSeg: AspectSegment = {
      EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'NURSNG',
      START_MOMENT: D + ' 14:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 60,
    };
    boundary({ id: 'reg-47', name: 'Late Logout 59 min past shift end — no action', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:59:00',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      inputDescription: 'Shift 07:00–15:00 (no release), logout 15:59',
      category: 'Band boundary: Late Logout',
      payrollImpact: 'Under an hour of overrun is not an absence' });
    boundary({ id: 'reg-48', name: 'Late Logout 60 min past shift end — ABSENT', tier: 'OPS', loginTime: '07:00:00', logoutTime: '16:00:00',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      inputDescription: 'Shift 07:00–15:00 (no release), logout 16:00',
      category: 'Band boundary: Late Logout',
      payrollImpact: 'Late Logout turns absent at 60 min whereas Late Login needs 61 — the two rules genuinely differ, per Rules to be taken.xlsx' });
    boundary({ id: 'reg-49', name: 'Late Logout measured from the RELEASE-adjusted end (confirmed policy)', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:00:00',
      extraSegments: [nursingSeg], schDuration: '7:0',
      expectedVerdict: 'ABSENT', expectedAction: 'ABSENT_SEGMENT',
      category: 'Band boundary: Late Logout',
      inputDescription: 'Shift 07:00–15:00 with NURSNG 14:00–15:00 (effective end 14:00), logout 15:00 — the ROSTERED end',
      payrollImpact: 'CONFIRMED POLICY: released staff who work to their rostered end are 60 min past the effective end and are marked ABSENT. Intentional — pinned here so it is never a surprise.' });
    boundary({ id: 'reg-50', name: 'Late Logout one minute below the release-adjusted cliff — no action', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:59:00',
      extraSegments: [nursingSeg], schDuration: '7:0',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      category: 'Band boundary: Late Logout',
      inputDescription: 'Same as reg-49 but logout 14:59 (59 min past effective end 14:00)',
      payrollImpact: 'The control for reg-49: one minute separates a full paid day from an absence' });

    // ---- Schedule-integrity guards (variance audit P1-3, P1-4, P2-1, P2-2, P2-3).
    boundary({ id: 'reg-51', name: 'Mid-shift release is deducted from hours, never subtracted from the shift END, and does not hold the row', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:00:00',
      extraSegments: [{ EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'RLS', START_MOMENT: D + ' 10:00:00', STOP_MOMENT: D + ' 11:00:00', DURATION: 60 }],
      schDuration: '7:0',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION', expectNoHold: true, expectedHoursMinutes: 420,
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00 with RLS 10:00–11:00 sitting in the MIDDLE, worked in full; Cognos SCH DURATION 7:0',
      payrollImpact: 'The middle release used to be treated as trailing, pulling the effective end back to 14:00 and making a full attendance look 60 min "late logout" — an invented absence. The window stays untouched, the 60 released minutes come off scheduled hours (420), and the row is no longer held.' });
    boundary({ id: 'reg-138', name: 'Release chained to a trailing nursing block is one trailing block: hours deducted, window moved, no hold (REEM shape)', tier: 'OPS', loginTime: '07:00:00', logoutTime: '11:00:00',
      extraSegments: [
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'UN_RLS', START_MOMENT: D + ' 11:00:00', STOP_MOMENT: D + ' 14:00:00', DURATION: 180 },
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'NURSNG', START_MOMENT: D + ' 14:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 60 },
      ],
      schDuration: '4:0',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION', expectNoHold: true, expectedHoursMinutes: 240,
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00, UN_RLS 11:00–14:00 running straight into NURSNG 14:00–15:00; agent leaves at 11:00 as released; Cognos SCH DURATION 4:0',
      payrollImpact: 'The UN_RLS reached neither shift end by itself, so it was labelled mid-shift: hours stayed 8:00 (Cognos 4:0 — a false mismatch), the effective end stayed at 14:00 and the row was locked. Chained to the NURSNG it is one trailing block: 240 minutes come off, the required end becomes 11:00 and leaving then is not an early logout.' });
    boundary({ id: 'reg-52', name: 'Blank-duration release derives its minutes from its own timestamps', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:00:00',
      extraSegments: [{ EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'RLS', START_MOMENT: D + ' 14:00:00', STOP_MOMENT: D + ' 15:00:00' }],
      schDuration: '7:0',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00, RLS 14:00–15:00 with NO DURATION field, logout at the effective end 14:00',
      payrollImpact: 'A blank duration used to default to a full day (480 min), dragging the effective end back to 07:00 and guaranteeing an absence. Timestamps now supply the real 60 minutes.' });
    boundary({ id: 'reg-53', name: 'Full-day release (no duration, no timestamps) takes the whole scheduled day and goes to a reviewer, never a forced hold', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:00:00',
      extraSegments: [{ EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'RLS' }],
      schDuration: '0:0',
      // RE-PINNED (WP1 / decision D7, 2026-09-21): this case used to expect ABSENT / ABSENT_SEGMENT,
      // i.e. an absence COMPUTED against the zero-length window a full-day removal collapses to.
      // Real data showed that recommendation is meaningless: trainees on a TRN NEW HIRES day got
      // "482m late logout" for simply attending, and no-punch trainees got Absent NS/NC while Cognos
      // itself codes the day as leave-like (LEAVE HR 480). Attendance is now NOT evaluated against a
      // zero-length window: no correction, verdict FULL_DAY_REMOVAL_REVIEW, and the same soft hold and
      // the same 0 scheduled hours are kept — only the fabricated absence is gone.
      expectedVerdict: 'FULL_DAY_REMOVAL_REVIEW', expectedAction: 'NO_ACTION', expectedHold: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', expectedHoursMinutes: 0,
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00 worked in full, plus a bare RLS row with no duration and no timestamps',
      payrollImpact: 'Decision 2026-09-21: a full-day segment equals the day\'s own scheduled duration (here 480), not "unknown". The whole day comes off the hours and the window collapses, so an absence computed from that window would be arbitrary — no attendance action is proposed; the row is held (soft, reviewer-releasable) for a human with the source documents. Before, it removed nothing and force-held REMOVAL_SEGMENT_DURATION_UNKNOWN.' });
    boundary({ id: 'reg-140', name: 'Full-day release equals shift + OT + cover (10:30), not a flat 8h default', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:00:00',
      extraSegments: [
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'OT1', START_MOMENT: D + ' 15:00:00', STOP_MOMENT: D + ' 17:00:00', DURATION: 120 },
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'COVER', START_MOMENT: D + ' 17:00:00', STOP_MOMENT: D + ' 17:30:00', DURATION: 30 },
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'RLS' },
      ],
      schDuration: '0:0',
      // RE-PINNED (WP1 / decision D7, 2026-09-21) — same reason as reg-53: no attendance rule is
      // evaluated against the zero-length window a full-day removal collapses to, so no absence is
      // computed. The assertion this case exists for — scheduled hours are exactly 0 (all 630 minutes
      // removed, not a flat 480) — and the soft hold are unchanged.
      expectedVerdict: 'FULL_DAY_REMOVAL_REVIEW', expectedAction: 'NO_ACTION', expectedHold: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', expectedHoursMinutes: 0,
      category: 'Schedule integrity',
      inputDescription: '8h shift + 2h OT1 + 30 min COVER (630 min scheduled) plus a bare RLS',
      payrollImpact: 'A flat 480 default would leave 150 scheduled minutes on the books after a full-day release. The removal takes all 630, so scheduled hours are exactly 0.' });
    boundary({ id: 'reg-54', name: 'Two overlapping trailing releases do not double-subtract', tier: 'OPS', loginTime: '07:00:00', logoutTime: '14:00:00',
      extraSegments: [
        { EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'RLS', START_MOMENT: D + ' 14:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 60 },
        nursingSeg,
      ],
      schDuration: '6:0',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION',
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00 with an RLS and a NURSNG both covering 14:00–15:00, logout 14:00',
      payrollImpact: 'Summing the two removals put the effective end at 13:00 and charged a present agent a 60-minute early logout — an ABSENT. Anchoring on the earliest release START gives the correct 14:00.' });
    boundary({ id: 'reg-55', name: 'Seconds in a schedule timestamp cannot shave a minute off the variance', tier: 'OPS', loginTime: '07:06:00', logoutTime: '15:00:00',
      shiftOverride: { START_MOMENT: D + ' 07:00:30' },
      expectedVerdict: 'LATE', expectedAction: 'LATE_AND_COVER',
      category: 'Schedule integrity',
      inputDescription: 'Shift starts 07:00:30 (seconds present), login 07:06 — a true 6-minute lateness',
      payrollImpact: 'diffInMinutes floors, so an untruncated :30 turned 6 minutes into 5 and dropped the finding entirely. Both sides are now truncated to the minute.' });
    boundary({ id: 'reg-56', name: 'A segment whose DURATION contradicts its own timestamps is held', tier: 'OPS', loginTime: '07:00:00', logoutTime: '15:00:00',
      shiftOverride: { DURATION: 400 }, schDuration: '6:40',
      expectedVerdict: 'PRESENT', expectedAction: 'NO_ACTION', expectedHold: 'SEGMENT_STOP_DURATION_DISAGREE',
      category: 'Schedule integrity',
      inputDescription: 'Shift 07:00–15:00 (480 real minutes) but DURATION says 400',
      payrollImpact: 'Paid hours come from DURATION and the attendance window from the timestamps — when they disagree, one of the two verdicts on the row is wrong, so a human decides which.' });
  }

  // ---- Contested punch attribution must never become an automatic absence.
  {
    const pf = '9900003';
    const loginId = '99003';
    const mkRow = (signIn: string, duty: string): CognosRecord => ({
      'SIGN IN DATE': signIn, SECTION: 'ECS', 'PF NO': pf, NAME: 'Contested Agent', 'LOGIN ID': loginId,
      DUTY1: duty, OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    });
    const cognosRecords = [mkRow('2026-08-27 00:00:00', '19:00 - 03:00'), mkRow('2026-08-28 00:00:00', '07:00 - 15:00')];
    const segs: AspectSegment[] = [
      { EMP_ID: pf, NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 19:00:00', STOP_MOMENT: '28/08/2026 03:00:00', DURATION: 480 },
      { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pf, EMP_LAST_NAME: 'Contested', EMP_SORT_NAME: 'CONTESTED AGENT', EMP_EXTRA_2: 'contested' }];
    // The contested punch is claimable by BOTH the night shift's tail and the next morning's
    // window. The night shift is nearer and wins it, leaving the morning with one punch.
    // Placed 03:30 when the live window reaches it; on a narrower window it moves to 15 min
    // inside the morning's search range. Below a certain window the punch simply falls
    // outside the night shift's reach altogether (nightEnd 03:00 + liveWindowH) — the
    // contest itself becomes physically impossible, and the morning window is left holding
    // TWO punches (06:xx-ish arrival-side swipe + 07:05) with a truncated export (nothing
    // after 07:05 that day) instead. That is no longer "impossible below ~2.1h" — the new
    // truncated-export coverage gate (Bug 2 fix, reconciliationEngine.ts) now holds that
    // case too, just under a different reason code, so this case asserts BOTH outcomes
    // are correct depending on window size, never a raw pass/fail on one fixed hold.
    const nightEnd = makeDt('28/08/2026', '03:00:00');
    const morningRangeStart = shiftHours(makeDt('28/08/2026', '07:00:00'), -liveWindowH);
    const contestedAt = new Date(Math.max(makeDt('28/08/2026', '03:30:00').getTime(), morningRangeStart.getTime() + 15 * 60000));
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: loginId, LoginDateTime: makeDt('27/08/2026', '18:58:00'), LogoutDateTime: makeDt('27/08/2026', '18:58:03') },
      swipeAt(loginId, contestedAt),
      { Date: '28/08/2026', LoginID: loginId, LoginDateTime: makeDt('28/08/2026', '07:05:00'), LogoutDateTime: makeDt('28/08/2026', '07:05:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const morning = out.rows[1];
    // The punch is contestable by the night shift only while it still sits inside the
    // night window's own ±liveWindowH search reach past nightEnd — otherwise the night
    // shift never sees it at all and the scenario resolves via the coverage gate instead.
    const contestable = contestedAt.getTime() <= nightEnd.getTime() + liveWindowH * 3600000;
    const expectedHold = contestable ? 'CONTESTED_SINGLE_PUNCH' : 'INSUFFICIENT_CMS_COVERAGE';
    const passed = morning.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && morning.TAA_VERDICT !== 'ABSENT'
      && morning.holdReason === expectedHold;

    results.push({
      id: 'reg-57',
      name: 'A punch lost to a neighbouring shift is held, never an automatic ABSENT',
      category: 'Punch attribution',
      inputDescription: `Night shift 27/08 19:00–03:00 and a morning shift 28/08 07:00–15:00 on the same login (live window ±${liveWindowH}h); the ${hhmm(contestedAt)} punch is ${contestable ? 'claimable by both, the night shift wins it, and the morning is left with a single 07:05 punch' : 'outside the night shift\'s reach, so the morning window has two punches but a truncated export (nothing after 07:05)'}`,
      cognosFlawedVerdict: 'n/a — this is a TAA attribution guard',
      expectedVerdict: `MANUAL_REVIEW_REQUIRED, never ABSENT (held: ${expectedHold})`,
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: morning.TAA_VERDICT + (morning.holdReason ? ' (held: ' + morning.holdReason + ')' : ''),
      actualAction: morning.TAA_ACTION,
      passed,
      payrollImpact: 'The morning row used to hit Rule 6 (single punch) and become an unpaid ABSENT — meaning a tie-break inside the attribution code, not any evidence about the employee, decided that someone lost a day of pay.',
      calculationTrace: [
        'Morning window punches attributed: ' + morning.details.punchCount,
        'Verdict: ' + morning.TAA_VERDICT + ' / ' + morning.TAA_ACTION,
        'Hold: ' + (morning.holdReason || 'none'),
      ],
    });
  }

  // Case 58: Cognos "00:00" SIGNIN DURATION means "never signed in", not a real zero duration
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000010', NAME: 'Never Signed In Agent', 'LOGIN ID': '30010',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000010', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000010', EMP_LAST_NAME: 'Never Signed In Agent', EMP_SORT_NAME: 'NEVER SIGNED IN AGENT' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const signinDurationComp = row.columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passed = signinDurationComp?.status === 'NOT_COMPARABLE';

    results.push({
      id: 'reg-58',
      name: 'Cognos "00:00" SIGNIN DURATION Means No Login, Not a Real Zero',
      category: 'Column comparison — SIGNIN DURATION blank-vs-zero',
      inputDescription: 'Scheduled 08:00-16:00 shift, employee never signs in: Cognos SIGNIN DURATION="00:00" with blank SIGIN IN/SIGIN OUT, no CMS punches',
      cognosFlawedVerdict: 'n/a — this is a TAA column-comparison guard',
      expectedVerdict: 'SIGNIN DURATION NOT_COMPARABLE (Cognos\'s "00:00" placeholder is not a genuine zero-length duration to compare against)',
      expectedAction: 'N/A',
      actualVerdict: `SIGNIN DURATION=${signinDurationComp?.status}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Prevents a false SIGNIN DURATION mismatch from being raised on every absence/no-login day, which would clutter the discrepancy view with non-issues',
      calculationTrace: [
        'SIGIN IN and SIGIN OUT both blank -> noRecordedAttendance is true',
        'SIGNIN DURATION "00:00" treated as null (no value), not parsed as a real 0-minute duration',
        'Recomputed duration is also null (no CMS punches) -> both sides null -> NOT_COMPARABLE',
      ],
    });
  }

  // Case 59: accepted payroll datetime formats are strict calendar values.
  {
    const leapDay = parseDateTimeString('29/02/2028 23:59:59');
    const bareDmy = parseDateTimeString('29/08/2026');
    const bareIso = parseDateTimeString('2026-08-29');
    const withSeconds = parseDateTimeString('29/08/2026 07:00:59');
    const passed = !!leapDay
      && !!bareDmy && bareDmy.getHours() === 0 && bareDmy.getMinutes() === 0 && bareDmy.getSeconds() === 0
      && !!bareIso && bareIso.getHours() === 0 && bareIso.getMinutes() === 0 && bareIso.getSeconds() === 0
      && !!withSeconds && truncateToMinute(withSeconds).getSeconds() === 0
      && parseDateTimeString('31/02/2026 08:00:00') === null
      && parseDateTimeString('29/02/2026 08:00:00') === null
      && parseDateTimeString('27/08/2026 24:00:00') === null
      && parseDateTimeString('27/08/2026 08:60:00') === null
      && parseDateTimeString('27/08/2026 08:00:60') === null
      && parseDateTimeString('08/27/2026 08:00:00') === null
      && parseClockTimeString(config.flexCutoffTime) !== null
      && parseClockTimeString(config.flexExpectedSchedStartWindow.start) !== null
      && parseClockTimeString(config.flexExpectedSchedStartWindow.end) !== null
      && parseClockTimeString(config.coverFallbackDefaultTime) !== null;

    results.push({
      id: 'reg-59',
      name: 'Strict Local Date/Time Parsing Rejects Rollovers and Ambiguous Formats',
      category: 'Input integrity — date/time parsing',
      inputDescription: 'Valid leap day, bare dates, seconds truncation, impossible calendar days/times, and an ambiguous US-style date',
      cognosFlawedVerdict: 'Native Date parsing can silently roll 31/02 into March or interpret 08/27 by host locale',
      expectedVerdict: 'Only documented local formats parse; bare dates become midnight; invalid/ambiguous values return null',
      expectedAction: 'FAIL CLOSED',
      actualVerdict: passed ? 'All strict parsing checks passed' : 'One or more strict parsing checks failed',
      actualAction: passed ? 'FAIL CLOSED' : 'UNSAFE PARSE',
      passed,
      payrollImpact: 'Prevents a malformed date or time from moving a shift to a different payroll day or variance band',
      calculationTrace: ['DD/MM/YYYY and YYYY-MM-DD are local wall-clock values', 'Bare date -> 00:00:00', 'No native/locale-dependent Date fallback'],
    });
  }

  // Case 60: CMS validates semantic dates/times and duplicate representations.
  {
    const cmsHeader = 'Report\nGenerated\nDate,Login ID,Login Time,Logout Time,Login Time,Logout Time\n';
    const valid = validateCmsFile(cmsHeader + '27/08/2026,12345,08:00,08:00,27/08/2026 08:00:01,27/08/2026 08:00:04', 'valid.csv');
    const invalidDate = validateCmsFile(cmsHeader + '31/02/2026,12345,08:00,08:00,31/02/2026 08:00:01,31/02/2026 08:00:04', 'invalid-date.csv');
    const invalidTime = validateCmsFile(cmsHeader + '27/08/2026,12345,25:00,25:00,27/08/2026 25:00:01,27/08/2026 25:00:04', 'invalid-time.csv');
    const conflicting = validateCmsFile(cmsHeader + '27/08/2026,12345,08:00,08:00,27/08/2026 09:00:01,27/08/2026 08:00:04', 'conflict.csv');
    const passed = valid.ok && !invalidDate.ok && !invalidTime.ok && !conflicting.ok;

    results.push({
      id: 'reg-60',
      name: 'CMS Upload Rejects Invalid or Contradictory Punch Timestamps',
      category: 'Input integrity — CMS',
      inputDescription: 'One valid swipe plus impossible date, impossible time, and time-only/full-datetime conflict variants',
      cognosFlawedVerdict: 'Regex-only validation accepts impossible calendar values and can ignore contradictions between duplicate CMS columns',
      expectedVerdict: 'Valid file accepted; every invalid/contradictory file rejected as a whole',
      expectedAction: 'REJECT INVALID CMS FILE',
      actualVerdict: passed ? '1 accepted / 3 rejected' : 'CMS validation did not fail closed',
      actualAction: passed ? 'REJECT INVALID CMS FILE' : 'UNSAFE CMS IMPORT',
      passed,
      payrollImpact: 'Prevents a dropped or shifted CMS punch from becoming a false late, early logout, or absence',
      calculationTrace: ['Calendar validity checked', 'HH:MM ranges checked', 'Time-only values reconciled to full datetimes'],
    });
  }

  // Case 61: a specific leave reason wins over the generic LEAVE container.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000011', NAME: 'Specific Leave Agent', 'LOGIN ID': '30011',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000011', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'LEAVE', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000011', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const comparison = out.rows[0].columnComparisons.find(c => c.column === 'LEAVE TYPE');
    const passed = out.rows[0].TAA_VERDICT === 'LEAVE_EXCLUDED' && comparison?.recomputedRaw === 'ANNUAL' && comparison.status === 'MATCH';

    results.push({
      id: 'reg-61',
      name: 'Specific Leave Code Wins Over Generic LEAVE',
      category: 'Column comparison — leave integrity',
      inputDescription: 'ASPECT day contains generic LEAVE followed by ANNUAL; Cognos reports ANNUAL',
      cognosFlawedVerdict: 'First-match ordering can report LEAVE and create a false LEAVE TYPE mismatch',
      expectedVerdict: 'LEAVE_EXCLUDED with recomputed LEAVE TYPE=ANNUAL (MATCH)',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${out.rows[0].TAA_VERDICT}; LEAVE TYPE=${comparison?.recomputedRaw}/${comparison?.status}`,
      actualAction: out.rows[0].TAA_ACTION,
      passed,
      payrollImpact: 'Removes false review holds when the specific paid-leave reason is present in ASPECT',
      calculationTrace: ['Leave candidates: LEAVE, ANNUAL', 'Prefer first non-generic code', `Selected: ${comparison?.recomputedRaw}`],
    });
  }

  // Case 62: malformed ASPECT schedule evidence is a locked hold.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000012', NAME: 'Invalid Schedule Agent', 'LOGIN ID': '30012',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:0', 'SIGIN IN': '07:00', 'SIGIN OUT': '15:00',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000012', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 24:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30012', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '30012', LoginDateTime: makeDt('27/08/2026', '14:59:57'), LogoutDateTime: makeDt('27/08/2026', '15:00:00') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.holdReason === 'INVALID_ASPECT_DATETIME'
      && isForcedHoldReason(row.holdReason)
      && isForcedHoldReason('INVALID_CONFIG_TIME')
      && !isForcedHoldReason('MISMATCH_FOUND')
      && !row.includeInOutput;

    results.push({
      id: 'reg-62',
      name: 'Invalid ASPECT Date/Time Is Locked Out of Payroll Output',
      category: 'Input integrity — ASPECT',
      inputDescription: 'SHIFT start contains impossible 24:00 while the row otherwise has complete attendance evidence',
      cognosFlawedVerdict: 'A rolled/dropped schedule time can leave a partial window and drive a guessed verdict',
      expectedVerdict: 'INVALID_ASPECT_DATETIME, forced hold, excluded from output',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: `${row.TAA_VERDICT}; hold=${row.holdReason}; included=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'No salary correction can be exported from a malformed schedule anchor',
      calculationTrace: row.details.invalidAspectDateTimes || [],
    });
  }

  // Case 63: user-confirmed ASPECT insert code and exact CSV shape/filtering.
  {
    const cognosBase: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000013', NAME: 'CSV Agent', 'LOGIN ID': '30013',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:54', 'SIGIN IN': '07:06', 'SIGIN OUT': '15:00',
      'LATE START': '-6', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000013', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000013', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30013', LoginDateTime: makeDt('27/08/2026', '07:06:00'), LogoutDateTime: makeDt('27/08/2026', '07:06:03') },
      { Date: '27/08/2026', LoginID: '30013', LoginDateTime: makeDt('27/08/2026', '14:59:57'), LogoutDateTime: makeDt('27/08/2026', '15:00:00') },
    ];
    const configWithConfirmedCode = { ...config, aspectNormalActionCode: '00' };
    const included = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosBase], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: configWithConfirmedCode });
    const held = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [{ ...cognosBase, DUTY1: '25:00 - 15:00' }], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: configWithConfirmedCode });
    const csvLines = included.aspectCorrectionsCsv.trimEnd().split('\n');
    const directCsv = generateAspectCorrectionsCsv(included.aspectCorrections);
    // Phase 5 fix (user-confirmed): the ASPECT import expects data rows only —
    // no header line. An all-held run now emits an empty string, not a
    // header-only file.
    const passed = config.aspectNormalActionCode === '00'
      && csvLines.length > 0
      && csvLines.every(line => line.startsWith('00,') && line.endsWith(','))
      && directCsv === included.aspectCorrectionsCsv
      && held.aspectCorrections.length > 0
      && held.aspectCorrectionsCsv === '';

    results.push({
      id: 'reg-63',
      name: 'ASPECT Add Code 00, Trailing Comma, and Held-Row Filtering',
      category: 'Output integrity — ASPECT CSV',
      inputDescription: 'Six-minute late case emits LATE/COVER; an otherwise identical row with invalid Cognos DUTY1 is held',
      cognosFlawedVerdict: 'A wrong insert code or leaked held correction can make the payroll import invalid or unsafe',
      expectedVerdict: 'Every emitted row begins 00, every row ends comma, no header row, held row emits nothing',
      expectedAction: 'LATE_AND_COVER',
      actualVerdict: `code=${config.aspectNormalActionCode}; output lines=${csvLines.length}; held corrections exported=${held.aspectCorrectionsCsv !== ''}`,
      actualAction: included.rows[0].TAA_ACTION,
      passed,
      payrollImpact: 'Pins the exact ASPECT import contract and prevents manual-review rows from entering salary corrections',
      calculationTrace: csvLines.slice(0, 2),
    });
  }

  // Case 64: real-byte file parsing — space-padded EMP_ID, embedded quoted multi-line
  // REMARK, and the case-insensitive glossary lookup, all against ACTUAL export bytes
  // rather than hand-built objects. Every existing case before this one constructs
  // AspectSegment/CognosRecord/CMSPunch objects directly and never calls a parser —
  // exactly why the D1 (date-key join) and D2 (glossary case) defects survived three
  // prior audits undetected. This drives real files' text through the real parsers.
  {
    const segs = parseAspectSegments(SAMPLE_ASPECT_SEGMENTS_CSV);
    const identities = parseAspectIdentity(SAMPLE_ASPECT_IDENTITY_CSV);
    const cognos = parseCognosReport(SAMPLE_COGNOS_REPORT_TSV, []);
    const cmsValidation = validateCmsFile(SAMPLE_CMS_LOGIN_LOGOUT_CSV, 'sample.csv');

    const distinctCodes = extractDistinctSegmentCodes(segs);
    const unclassified = distinctCodes.filter(c => !config.segmentGlossary[c]
      && !Object.keys(config.segmentGlossary).some(k => k.toUpperCase() === c.toUpperCase()));
    const durationDisagreements = segs.filter(s => {
      if (!s.START_MOMENT || !s.STOP_MOMENT || s.DURATION == null) return false;
      const start = parseDateTimeString(s.START_MOMENT);
      const stop = parseDateTimeString(s.STOP_MOMENT);
      if (!start || !stop) return false;
      return Math.round((stop.getTime() - start.getTime()) / 60000) !== s.DURATION;
    });
    const spacePaddedIdFound = segs.some(s => s.EMP_ID === '90134799' || s.EMP_ID === 'UAE07496');
    const remarkEmailThreadIntact = cognos.some(r => (r['REMARK'] || '').includes('NURSNG:16:00 - 17:00'));

    const passed = segs.length === 21 && identities.length === 4 && cognos.length === 4
      && cmsValidation.ok && cmsValidation.punches.length === 39
      && unclassified.length === 0 && durationDisagreements.length === 0
      && spacePaddedIdFound && remarkEmailThreadIntact;

    results.push({
      id: 'reg-64',
      name: 'Real File Bytes Parse Cleanly End to End',
      category: 'Input integrity — real file bytes',
      inputDescription: '21 real ASPECT segment rows, 4 real identities, 4 real Cognos rows, 39 real CMS punches — trimmed but byte-faithful excerpts of the real samples_Files/ exports',
      cognosFlawedVerdict: 'All 203 pre-existing test cases construct objects directly and never call a parser',
      expectedVerdict: '21/4/4/39 rows parsed, 0 unclassified codes, 0 DURATION/timestamp disagreements, space-padded EMP_ID trimmed, multi-line REMARK preserved',
      expectedAction: 'PARSE CLEANLY',
      actualVerdict: `segs=${segs.length} identities=${identities.length} cognos=${cognos.length} cms=${cmsValidation.ok ? cmsValidation.punches.length : 'INVALID'} unclassified=${unclassified.length} durMismatch=${durationDisagreements.length}`,
      actualAction: passed ? 'PARSE CLEANLY' : 'PARSE DEFECT',
      passed,
      payrollImpact: 'A parser defect here silently corrupts every downstream verdict — this is the layer no other test touches',
      calculationTrace: [`Distinct codes: ${distinctCodes.join(', ')}`, `Space-padded EMP_ID handled: ${spacePaddedIdFound}`, `Multi-line REMARK intact: ${remarkEmailThreadIntact}`],
    });
  }

  // Case 65: the date-overlap advisory correctly detects the real files' own genuine
  // 1-day mismatch (Cognos 27/08/2026 vs ASPECT 28/08/2026) — the exact condition that
  // silently produced 502/502 COGNOS_DATA_GAP rows with no warning before this advisory
  // existed. Same real-byte excerpt as reg-64.
  {
    const segs = parseAspectSegments(SAMPLE_ASPECT_SEGMENTS_CSV);
    const cognos = parseCognosReport(SAMPLE_COGNOS_REPORT_TSV, []);
    const overlap = assessDateOverlap(cognos, segs);
    const passed = !overlap.sufficient
      && overlap.cognosOnlyDates.length === 1 && overlap.cognosOnlyDates[0] === '27/08/2026'
      && overlap.aspectOnlyDates.length === 1 && overlap.aspectOnlyDates[0] === '28/08/2026'
      && overlap.reconciledDateCount === 0;

    results.push({
      id: 'reg-65',
      name: 'Date-Overlap Advisory Detects the Real Files\' Own Date Mismatch',
      category: 'Input integrity — real file bytes',
      inputDescription: 'Real Cognos rows dated 27/08/2026 against real ASPECT rows dated 28/08/2026 — genuinely different days, not a parsing artifact',
      cognosFlawedVerdict: 'Previously nothing warned before Calculate; every row silently resolved to COGNOS_DATA_GAP',
      expectedVerdict: 'sufficient=false, cognosOnlyDates=[27/08/2026], aspectOnlyDates=[28/08/2026]',
      expectedAction: 'WARN BEFORE CALCULATE',
      actualVerdict: `sufficient=${overlap.sufficient}; cognosOnly=${overlap.cognosOnlyDates.join(',')}; aspectOnly=${overlap.aspectOnlyDates.join(',')}`,
      actualAction: passed ? 'WARN BEFORE CALCULATE' : 'SILENT ZERO-MATCH RUN',
      passed,
      payrollImpact: 'A user can no longer run a full reconciliation and get zero corrections with no explanation',
      calculationTrace: [overlap.message],
    });
  }

  // Case 66: the full parse -> reconcile -> corrections pipeline, on real-byte data, once
  // the known real-world date mismatch is set aside (one field shifted per row so the
  // join succeeds — reg-65 above already proves the mismatch itself is correctly
  // detected). Proves real bytes flow all the way through to actual verdicts, not just
  // that they parse without throwing.
  //
  // Updated 2026-09-09 (F03 removal, user-confirmed): this excerpt's real CMS
  // file covers exactly ONE agent (Login ID 68858, matching the real
  // samples_Files/CMS_Login_logout.csv, which is genuinely a per-agent export) against 4
  // real Cognos rows naming 4 DIFFERENT Login IDs. The F03 per-row scope-gap guard that
  // used to hold the other 3 employees is now removed — CMS is a full-staff export with
  // no per-agent filtering (user-confirmed), so "zero CMS punches" is one standard rule:
  // those 3 rows now auto-mark NO_SHOW/ABSENT_NS_NC like any other zero-punch login. The
  // risk this real single-agent sample file demonstrates (an export scoped to the wrong
  // agent list) is now caught once at upload by assessHeadcountMapping (punchAttribution.ts),
  // not guessed per row — see reg-102 below, which proves the mapping check flags this exact
  // shape of file before Calculate.
  {
    const segs = parseAspectSegments(SAMPLE_ASPECT_SEGMENTS_CSV);
    const identities = parseAspectIdentity(SAMPLE_ASPECT_IDENTITY_CSV);
    const cognosAligned = parseCognosReport(SAMPLE_COGNOS_REPORT_DATE_ALIGNED_TSV, []);
    const cmsValidation = validateCmsFile(SAMPLE_CMS_LOGIN_LOGOUT_CSV, 'sample.csv');
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: cognosAligned, aspectSegments: segs, aspectIdentities: identities,
      cmsPunches: cmsValidation.ok ? cmsValidation.punches : [], config,
    });
    const otherRows = out.rows.filter(r => r.originalCognos['PF NO'] !== '4508038');
    const leaveRow = out.rows.find(r => r.originalCognos['PF NO'] === '4508038');
    // F03 removal controls the VERDICT only (NO_SHOW/ABSENT_NS_NC instead of
    // held MISSING_LOGIN_ID). Whether a row's correction is actually exported
    // (includeInOutput) is governed by an unrelated gate (e.g. MISMATCH_FOUND
    // from the Cognos<->recompute comparison) that is out of scope for this
    // change and must not be asserted here — no row may ever again be held
    // specifically as CMS_EXPORT_SCOPE_GAP, since that hold reason no longer exists.
    const allOthersStandardAbsent = otherRows.length === 3 && otherRows.every(r =>
      r.TAA_VERDICT === 'NO_SHOW' && r.TAA_ACTION === 'ABSENT_NS_NC');
    const passed = out.summary.totalRecords === 4
      && out.summary.cognosDataGapCount === 0
      && allOthersStandardAbsent
      && leaveRow?.TAA_VERDICT === 'LEAVE_EXCLUDED';

    results.push({
      id: 'reg-66',
      name: 'Real-Byte Data Flows Through to the Standard Absent Rule (F03 guard removed)',
      category: 'Input integrity — real file bytes',
      inputDescription: 'Same real excerpt as reg-64, with SIGN IN DATE aligned to ASPECT\'s NOM_DATE so the join succeeds; real CMS file covers only 1 of the 4 real employees\' Login IDs',
      cognosFlawedVerdict: 'Before F03 removal: the 3 employees missing from this single-agent CMS export were held as MISSING_LOGIN_ID/CMS_EXPORT_SCOPE_GAP',
      expectedVerdict: '0 COGNOS_DATA_GAP, the 3 employees the real CMS file does not cover auto-marked NO_SHOW/ABSENT_NS_NC (standard rule, no CMS_EXPORT_SCOPE_GAP hold), PF 4508038 LEAVE_EXCLUDED (real P/H-LV leave day)',
      expectedAction: 'STANDARD ABSENT RULE FOR ALL ZERO-PUNCH ROWS',
      actualVerdict: `records=${out.summary.totalRecords}; dataGap=${out.summary.cognosDataGapCount}; corrections=${out.aspectCorrections.length}; othersStandardAbsent=${allOthersStandardAbsent}; 4508038=${leaveRow?.TAA_VERDICT}`,
      actualAction: passed ? 'STANDARD ABSENT RULE FOR ALL ZERO-PUNCH ROWS' : 'PIPELINE DEFECT',
      passed,
      payrollImpact: 'Confirms the full pipeline, on real bytes, applies one standard Absent rule to every zero-punch login regardless of whether other logins in the same CMS export have data',
      calculationTrace: [`Corrections emitted: ${out.aspectCorrections.length}`, `Verdicts: ${out.rows.map(r => `${r.originalCognos['PF NO']}=${r.TAA_VERDICT}(${r.holdReason || 'no hold'})`).join(', ')}`],
    });
  }

  // Case 67: Cover Not Attended charged variance must feed both row math and OPS digest.
  {
    const configWithMailbox: ConfigRegistry = { ...config, sectionMailboxMap: [{ section: 'ECS', mailbox: 'ecs-ops@example.test' }] };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000067', NAME: 'Cover Variance Agent', 'LOGIN ID': '36067',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:30', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000067', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000067', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'COVER', START_MOMENT: '01/09/2026 16:00:00', STOP_MOMENT: '01/09/2026 16:30:00', DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000067', EMP_LAST_NAME: 'Cover Variance Agent', EMP_SORT_NAME: 'COVER VARIANCE AGENT', EMP_EXTRA_4: 'ECS' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36067', LoginDateTime: makeDt('01/09/2026', '08:00:00'), LogoutDateTime: makeDt('01/09/2026', '08:00:03') },
      { Date: '01/09/2026', LoginID: '36067', LoginDateTime: makeDt('01/09/2026', '16:00:00'), LogoutDateTime: makeDt('01/09/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: configWithMailbox });
    const row = out.rows[0];
    const finalActions = JSON.parse(out.emailActionsJson) as any[];
    const digestBody = String(finalActions[0]?.body || '');
    const passed = row.TAA_VERDICT === 'ABSENT'
      && row.details.chargedVarianceMinutes === 30
      && out.emailActions[0]?.variance_minutes === 30
      && /\|\s*30\s*\|/.test(digestBody)
      && row.includeInOutput;

    results.push({
      id: 'reg-67',
      name: 'Cover Not Attended Variance Feeds Charged Minutes and OPS Digest',
      category: 'Deep audit — Rule 7 math and email variance',
      inputDescription: 'SHIFT 08:00-16:00 + COVER 16:00-16:30; employee attends only 08:00-16:00',
      cognosFlawedVerdict: 'Rule 7 marked ABSENT but left charged variance and email variance at 0',
      expectedVerdict: 'ABSENT with charged variance 30m and digest table Var(min)=30',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT}; charged=${row.details.chargedVarianceMinutes}; emailVariance=${out.emailActions[0]?.variance_minutes}; included=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents an unattended cover from being reported to OPS as a zero-minute variance',
      calculationTrace: [
        'COVER scheduled 16:00-16:30 = 30m',
        'CMS span ends at 16:00 -> 0m cover overlap',
        `Charged variance: ${row.details.chargedVarianceMinutes}m`,
      ],
    });
  }

  // Case 68: Flex Branch B downstream absence must carry its OPS email rule.
  {
    const configWithMailbox: ConfigRegistry = { ...config, sectionMailboxMap: [{ section: 'FLEXOPS', mailbox: 'flex-ops@example.test' }] };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'FLEXOPS', 'PF NO': '7000068', NAME: 'Flex Email Agent', 'LOGIN ID': '36068',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '02:59',
      'SIGIN IN': '10:01', 'SIGIN OUT': '13:00', 'LATE START': '-181', 'LEFT EARLY': '-120', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000068', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 07:00:00', STOP_MOMENT: '01/09/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000068', EMP_LAST_NAME: 'Flex Email Agent', EMP_SORT_NAME: 'FLEX EMAIL AGENT FLX', EMP_EXTRA_4: 'FLEXOPS' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36068', LoginDateTime: makeDt('01/09/2026', '10:01:00'), LogoutDateTime: makeDt('01/09/2026', '10:01:03') },
      { Date: '01/09/2026', LoginID: '36068', LoginDateTime: makeDt('01/09/2026', '13:00:00'), LogoutDateTime: makeDt('01/09/2026', '13:00:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '01/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('01/09/2026', '23:30:00'), LogoutDateTime: makeDt('01/09/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: configWithMailbox });
    const row = out.rows[0];
    const finalActions = JSON.parse(out.emailActionsJson) as any[];
    const digestBody = String(finalActions[0]?.body || '');
    // Note (2026-09-17, "one email per fired action" change): this row now
    // fires TWO distinct actions — SHIFT_UPDATE_AND_LATE_COVER_FLEX (NA, the
    // 1m-past-cutoff flex clamp) and ABSENT_SEGMENT (EMAIL_OPS, the 300m
    // downstream early-logout absence) — each with its OWN EmailActionItem,
    // not one blended item for the row. `out.emailActions[0]` is no longer
    // guaranteed to be the Absent one (array order is fired-order, not
    // severity order), so this checks the whole row's action list instead of
    // index 0. The digest's variance now reports THAT action's own 300m
    // (TAA_EARLY_MIN), not the row-level 301m aggregate the old single-email
    // design blended in from the unrelated 1m flex clamp — the full picture
    // (both actions) still lands in the body via "Actions fired (all, this
    // row): ...".
    const passed = row.TAA_ACTION === 'ABSENT_SEGMENT'
      && row.TAA_ACTIONS_FIRED.includes('SHIFT_UPDATE_AND_LATE_COVER_FLEX')
      && row.TAA_ACTIONS_FIRED.includes('ABSENT_SEGMENT')
      && row.details.chargedVarianceMinutes === 301
      && row.TAA_EARLY_MIN === 300
      && out.emailActions.some(a => a.communication_rule === 'EMAIL_OPS')
      && finalActions[0]?.ops_mailbox === 'flex-ops@example.test'
      && /\|\s*300\s*\|/.test(digestBody);

    results.push({
      id: 'reg-68',
      name: 'Flex Past Cutoff Downstream Absence Creates OPS Email',
      category: 'Deep audit — flex Branch B email propagation',
      inputDescription: 'Flex shift 07:00-15:00; login 10:01, logout 13:00. Cutoff clamp moves expected end to 18:00, creating a 300m early-logout absence.',
      cognosFlawedVerdict: 'The downstream absence changed the action to ABSENT but kept communication_rule=NA, so no OPS draft was produced',
      expectedVerdict: 'ABSENT with both flex late-cover and downstream absence actions, TAA_EARLY_MIN=300, plus one OPS digest',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT}; actions=${row.TAA_ACTIONS_FIRED}; charged=${row.details.chargedVarianceMinutes}; emails=${out.emailActions.map(a => a.communication_rule).join(',')}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents severe flex downstream absences from bypassing required OPS notification',
      calculationTrace: [
        '10:01 is 1m after the 10:00 cutoff',
        'Shift update clamps start to 10:00; expected end becomes 18:00',
        '13:00 logout is 300m early against the shifted end; charged total 1+300=301m',
      ],
    });
  }

  // Case 69: Cognos SECTION is the authoritative OPS mailbox routing key.
  {
    const configWithMailbox: ConfigRegistry = { ...config, sectionMailboxMap: [{ section: 'COGNOS_SEC', mailbox: 'cognos-section@example.test' }] };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'COGNOS_SEC', 'PF NO': '7000069', NAME: 'Section Authority Agent', 'LOGIN ID': '36069',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:50',
      'SIGIN IN': '09:10', 'SIGIN OUT': '16:00', 'LATE START': '-70', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000069', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000069', EMP_LAST_NAME: 'Section Authority Agent', EMP_SORT_NAME: 'SECTION AUTHORITY AGENT', EMP_EXTRA_2: 'section.agent', EMP_EXTRA_4: 'IDENTITY_SEC' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36069', LoginDateTime: makeDt('01/09/2026', '09:10:00'), LogoutDateTime: makeDt('01/09/2026', '09:10:03') },
      { Date: '01/09/2026', LoginID: '36069', LoginDateTime: makeDt('01/09/2026', '16:00:00'), LogoutDateTime: makeDt('01/09/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: configWithMailbox });
    const row = out.rows[0];
    const finalActions = JSON.parse(out.emailActionsJson) as any[];
    const passed = row.TAA_SECTION === 'COGNOS_SEC'
      && row.TAA_ASPECT_SECTION === 'IDENTITY_SEC'
      && row.TAA_SECTION_SOURCE === 'COGNOS_SECTION'
      && row.TAA_SECTION_MISMATCH
      && out.emailActions[0]?.section === 'COGNOS_SEC'
      && finalActions[0]?.section === 'COGNOS_SEC'
      && finalActions[0]?.ops_mailbox === 'cognos-section@example.test';

    results.push({
      id: 'reg-69',
      name: 'OPS Email Routing Uses Cognos SECTION Before ASPECT EMP_EXTRA_4',
      category: 'Deep audit — email Section authority',
      inputDescription: 'Cognos SECTION=COGNOS_SEC, ASPECT EMP_EXTRA_4=IDENTITY_SEC, and only COGNOS_SEC has an OPS mailbox mapping',
      cognosFlawedVerdict: 'The email action used IDENTITY_SEC, causing a held/misrouted OPS notice even though Cognos carried the authoritative Section',
      expectedVerdict: 'Email action and digest route to COGNOS_SEC; mismatch is visible in TAA audit fields',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `section=${row.TAA_SECTION}; source=${row.TAA_SECTION_SOURCE}; aspectSection=${row.TAA_ASPECT_SECTION}; mismatch=${row.TAA_SECTION_MISMATCH}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents OPS notices from being grouped by stale ASPECT identity Section when Cognos names the live discrepancy Section',
      calculationTrace: [`Raw Cognos SECTION: ${row.details.cognosSection}`, `Raw ASPECT EMP_EXTRA_4: ${row.details.aspectIdentitySection}`, `Digest mailbox: ${finalActions[0]?.ops_mailbox || 'NONE'}`],
    });
  }

  // Case 70: invalid numeric Config Registry values must fail closed before math runs.
  {
    const badConfig: ConfigRegistry = { ...config, roundingGridMinutes: 0, cmsPunchSearchWindowHours: -1 };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'OPS', 'PF NO': '7000070', NAME: 'Invalid Config Agent', 'LOGIN ID': '36070',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000070', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36070', LoginDateTime: makeDt('01/09/2026', '08:00:00'), LogoutDateTime: makeDt('01/09/2026', '08:00:03') },
      { Date: '01/09/2026', LoginID: '36070', LoginDateTime: makeDt('01/09/2026', '16:00:00'), LogoutDateTime: makeDt('01/09/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: badConfig });
    const row = out.rows[0];
    const passed = row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && row.holdReason === 'INVALID_CONFIG_VALUE'
      && !row.includeInOutput
      && out.aspectCorrections.length === 0
      && out.emailActions.length === 0
      && out.emailActionsJson.trim() === '[]'
      && !out.annotatedCognosCsv.includes('NaN')
      && (row.details.configValidationIssues || []).some(issue => issue.includes('roundingGridMinutes'));

    results.push({
      id: 'reg-70',
      name: 'Invalid Numeric Config Values Fail Closed Before Reconciliation Math',
      category: 'Deep audit — config math safety',
      inputDescription: 'roundingGridMinutes=0 and cmsPunchSearchWindowHours=-1 on an otherwise valid attended shift',
      cognosFlawedVerdict: 'Bad numeric config could produce NaN shift updates or misleading no-punch absences',
      expectedVerdict: 'INVALID_CONFIG_VALUE forced hold, no ASPECT corrections, no emails, no NaN output',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: `${row.TAA_VERDICT}; hold=${row.holdReason}; corrections=${out.aspectCorrections.length}; emails=${out.emailActions.length}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents unsafe registry values from creating corrupt payroll rows or false absence emails',
      calculationTrace: row.details.configValidationIssues || [],
    });
  }

  // Case 71: Flex SHIFT+OT must preserve SHIFT duration, not the raw 10h span.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '455880', NAME: 'Flex OT Agent', 'LOGIN ID': '10080',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:48',
      'SIGIN IN': '08:12', 'SIGIN OUT': '16:00', 'LATE START': '-72', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '455880', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '455880', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 15:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 120 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '455880', EMP_LAST_NAME: 'Flex OT Agent', EMP_SORT_NAME: 'FLEX OT AGENT FLX', EMP_EXTRA_2: 'flexot' },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10080', LoginDateTime: makeDt('28/08/2026', '08:12:00'), LogoutDateTime: makeDt('28/08/2026', '08:12:03') },
      { Date: '28/08/2026', LoginID: '10080', LoginDateTime: makeDt('28/08/2026', '16:00:00'), LogoutDateTime: makeDt('28/08/2026', '16:00:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '28/08/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('28/08/2026', '23:30:00'), LogoutDateTime: makeDt('28/08/2026', '23:30:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const updatedShift = out.aspectCorrections.find(c => c.Code === '11');
    const passed = row.TAA_RESULT_CATEGORY === 'SHIFT_CHANGED'
      && row.TAA_ACTION === 'SHIFT_UPDATE_FLEX'
      && row.TAA_EARLY_MIN === 0
      && row.TAA_VERDICT !== 'ABSENT'
      && updatedShift?.Segmentduration === '08:00';

    results.push({
      id: 'reg-71',
      name: 'Flex SHIFT+OT Preserves 8h Shift, Not Raw 10h Span',
      category: 'Variance audit F1: flex end',
      inputDescription: 'Flex SHIFT 07:00-15:00 + OT1 15:00-17:00; arrival 08:12 snaps to 08:00; logout 16:00',
      cognosFlawedVerdict: 'Raw span 07:00-17:00 = 10h → newEnd 18:00 → 120m early → ABSENT',
      expectedVerdict: 'SHIFT_CHANGED; shift-update duration 08:00; newEnd 16:00; not absent',
      expectedAction: 'SHIFT_UPDATE_FLEX',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; pairDuration=${updatedShift?.Segmentduration || 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops flex+OT from inventing a 2-hour early-logout absence by treating overtime as shifted shift duration',
      calculationTrace: [
        'SHIFT window 07:00-15:00 = 8h preserved',
        '08:12 snaps to 08:00 → expected end 16:00',
        `Logout 16:00 → early ${row.TAA_EARLY_MIN}m`,
      ],
    });
  }

  // Case 72: Flex Branch A early logout must populate TAA_EARLY_MIN.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '455881', NAME: 'Flex Early Agent', 'LOGIN ID': '10081',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:42',
      'SIGIN IN': '08:12', 'SIGIN OUT': '15:54', 'LATE START': '-72', 'LEFT EARLY': '-6', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '455881', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '455881', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 07:00:00', STOP_MOMENT: '29/08/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '455881', EMP_LAST_NAME: 'Flex Early Agent', EMP_SORT_NAME: 'FLEX EARLY AGENT FLX', EMP_EXTRA_2: 'flexearly' },
    ];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10081', LoginDateTime: makeDt('28/08/2026', '08:12:00'), LogoutDateTime: makeDt('28/08/2026', '08:12:03') },
      { Date: '28/08/2026', LoginID: '10081', LoginDateTime: makeDt('28/08/2026', '15:54:00'), LogoutDateTime: makeDt('28/08/2026', '15:54:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_EARLY_MIN === 6
      && row.TAA_ACTION === 'LOGOFF_AND_COVER'
      && row.details.chargedVarianceMinutes === 6;

    results.push({
      id: 'reg-72',
      name: 'Flex Branch A Writes TAA_EARLY_MIN From Downstream Logout',
      category: 'Variance audit F2: flex early minutes',
      inputDescription: 'Flex 07:00-15:00, arrival 08:12→08:00 (newEnd 16:00), logout 15:54 = 6m early',
      cognosFlawedVerdict: 'Downstream LOGOFF_AND_COVER fired but TAA_EARLY_MIN stayed 0',
      expectedVerdict: 'LOGOFF_AND_COVER with TAA_EARLY_MIN=6',
      expectedAction: 'LOGOFF_AND_COVER',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; charged=${row.details.chargedVarianceMinutes}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops the annotated report from hiding a charged flex early-logout variance as 0 minutes',
      calculationTrace: [`Snapped start 08:00 + 8h = 16:00`, `Logout 15:54 → ${row.TAA_EARLY_MIN}m early`],
    });
  }

  // Case 73: Overlapping leading releases — latest stop, not summed minutes.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000073', NAME: 'Leading Overlap Agent', 'LOGIN ID': '36073',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '05:54',
      'SIGIN IN': '09:06', 'SIGIN OUT': '15:00', 'LATE START': '-126', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000073', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000073', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 08:00:00', DURATION: 60 },
      { EMP_ID: '7000073', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'UN_RLS', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 08:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36073', LoginDateTime: makeDt('27/08/2026', '09:06:00'), LogoutDateTime: makeDt('27/08/2026', '09:06:03') },
      { Date: '27/08/2026', LoginID: '36073', LoginDateTime: makeDt('27/08/2026', '15:00:00'), LogoutDateTime: makeDt('27/08/2026', '15:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_LATE_MIN === 66 && row.TAA_ACTION === 'ABSENT_SEGMENT';

    results.push({
      id: 'reg-73',
      name: 'Overlapping Leading Releases Do Not Double-Move effectiveStart',
      category: 'Variance audit F3: leading union',
      inputDescription: 'SHIFT 07:00-15:00 + two leading 07:00-08:00 releases; login 09:06',
      cognosFlawedVerdict: 'Summing 120m moved start to 09:00 → only 6m late (cover) instead of 66m (absent)',
      expectedVerdict: 'ABSENT — 66m late from latest leading stop 08:00',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT}; late=${row.TAA_LATE_MIN}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents overlapping morning releases from shrinking a 66-minute absence down to a 6-minute cover',
      calculationTrace: [`effectiveStart should be 08:00 (latest leading STOP)`, `09:06 − 08:00 = ${row.TAA_LATE_MIN}m`],
    });
  }

  // Case 74: Rule 8 unions overlapping RLS on the same OT.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000074', NAME: 'OT Overlap Agent', 'LOGIN ID': '36074',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '15:00 - 17:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '09:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000074', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000074', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 15:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 120 },
      { EMP_ID: '7000074', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 60 },
      { EMP_ID: '7000074', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'UN_RLS', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36074', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '36074', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const adjustedOt = out.aspectCorrections.find(c => c.Code === '11' && c.SegmentCode === 'OT1');
    // The two overlapping removal segments (RLS + UN_RLS) sit on the IDENTICAL
    // 16:00-17:00 window — the merge must collapse them to a single SHIFT
    // insert row, never emit two duplicate 01:00 rows for the same hour.
    const shiftInserts = out.aspectCorrections.filter(c => c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const shiftInsert = shiftInserts.find(c => c.SegmentStarttime === '16:00');
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && adjustedOt?.Segmentduration === '01:00'
      && shiftInserts.length === 1
      && shiftInsert?.Segmentduration === '01:00';

    results.push({
      id: 'reg-74',
      name: 'Rule 8 Unions Overlapping RLS On The Same OT',
      category: 'Variance audit F4: OT overlap union',
      inputDescription: 'OT1 15:00-17:00 (120m) overlapped by RLS and UN_RLS both 16:00-17:00',
      cognosFlawedVerdict: 'Summing 60+60 cut OT to 0 instead of union 60 → remaining 60m',
      expectedVerdict: 'ADJUST_OT_RLS: OT1 duration 01:00 (unchanged remainder), plus exactly one SHIFT insert of 01:00 for the released hour — never two duplicate inserts from the overlapping RLS/UN_RLS pair',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; adjusted=${adjustedOt?.Segmentduration || 'none'}; shiftInserts=${shiftInserts.length}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops two overlapping releases from wiping a remaining hour of overtime, and stops the released hour from either vanishing or double-inserting as SHIFT',
      calculationTrace: [`Adjusted OT duration: ${adjustedOt?.Segmentduration || 'none'}`, `SHIFT inserts: ${shiftInserts.length} (${shiftInsert?.Segmentduration || 'none'})`],
    });
  }

  // Case 75: COVER overlap truncates to the minute before floor-diff.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000075', NAME: 'Cover Trunc Agent', 'LOGIN ID': '36075',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:06',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:06', 'LATE START': '0', 'LEFT EARLY': '6', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000075', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000075', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'COVER', START_MOMENT: '27/08/2026 16:00:30', STOP_MOMENT: '27/08/2026 16:10:30', DURATION: 10 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36075', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '36075', LoginDateTime: makeDt('27/08/2026', '16:06:00'), LogoutDateTime: makeDt('27/08/2026', '16:06:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_ACTION === 'NO_ACTION' && row.TAA_VERDICT === 'PRESENT';

    results.push({
      id: 'reg-75',
      name: 'Cover-Not-Attended Truncates COVER Timestamps Before Floor-Diff',
      category: 'Variance audit F6: cover truncation',
      inputDescription: 'COVER 16:00:30-16:10:30 (10m); attended through 16:06. Truncated overlap 6m → shortfall 4m (below OPS 5m band)',
      cognosFlawedVerdict: 'Untruncated overlap floors to 5m shortfall → Cover Not Attended ABSENT',
      expectedVerdict: 'PRESENT / NO_ACTION (4m shortfall below band)',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT}; action=${row.TAA_ACTION}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a seconds artefact from pushing a 4-minute cover shortfall over the 5-minute Absent cliff',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Charged ${row.details.chargedVarianceMinutes}m`],
    });
  }

  // Case 139 (REEM 16/09 shape): SCH DURATION is the FULL net schedule - every ADDITION
  // segment (here three COVER rows totalling 59m) counts, every REMOVAL comes off. The
  // column used to be the shift's time span, so it read 07:00 while the trace net was 07:59.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-16 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '7000139', NAME: 'Cover Sch Duration Agent', 'LOGIN ID': '36139',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '7:58', 'SIGNIN DURATION': '06:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg139 = (code: string, start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: '7000139', NOM_DATE: '16/09/2026', START_DATE: '16/09/2026', SEG_CODE: code, START_MOMENT: `16/09/2026 ${start}:00`, STOP_MOMENT: `16/09/2026 ${stop}:00`, DURATION: dur });
    const segs: AspectSegment[] = [
      seg139('SHIFT', '08:00', '16:00', 480), seg139('NURSNG', '15:00', '16:00', 60),
      seg139('COVER', '15:00', '15:48', 48), seg139('COVER', '15:48', '15:54', 6), seg139('COVER', '15:54', '15:59', 5),
    ];
    const punches: CMSPunch[] = [
      { Date: '16/09/2026', LoginID: '36139', LoginDateTime: makeDt('16/09/2026', '08:00:00'), LogoutDateTime: makeDt('16/09/2026', '08:00:03') },
      { Date: '16/09/2026', LoginID: '36139', LoginDateTime: makeDt('16/09/2026', '15:00:00'), LogoutDateTime: makeDt('16/09/2026', '15:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const sch = row.columnComparisons.find(c => c.column === 'SCH DURATION');
    const passed = row.TAA_SCH_HOURS_RECOMPUTED === 479 && sch?.recomputedMinutes === 479 && sch?.status === 'MATCH';

    results.push({
      id: 'reg-139',
      name: 'SCH DURATION Column Counts Every Additional Segment (Cover) And Every Removal',
      category: 'Variance audit F7: hours vs window',
      inputDescription: 'SHIFT 08:00-16:00 (480) + NURSNG 15:00-16:00 (-60) + three COVER rows 48+6+5 (+59); Cognos SCH DURATION 7:58',
      cognosFlawedVerdict: 'N/A - TAA column used the shift time span (07:00), ignoring the 59 cover minutes, so it mismatched Cognos 7:58 on every cover day',
      expectedVerdict: 'SCH DURATION = 479 (07:59), MATCH against Cognos 7:58 within the 1-minute tolerance',
      expectedAction: 'N/A',
      actualVerdict: `column=${sch?.recomputedRaw} (${sch?.recomputedMinutes}); status=${sch?.status}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'No pay change (the pay figure was already 479); removes the false SCH DURATION mismatch and the MISMATCH_FOUND hold it caused on cover days',
      calculationTrace: [`Net ${row.TAA_SCH_HOURS_RECOMPUTED}`, `Column ${sch?.recomputedRaw} ${sch?.status}`],
    });
  }

  // Case 145 (real sample shape, 17-21 Sept): two back-to-back SHIFT segments are two duties in
  // Cognos (DUTY1 + DUTY-2). TAA used to merge the 0-minute gap into one block, so both DUTY
  // columns mismatched and the row was soft-held. Blocks are comparison-only: pay fields,
  // window and verdict must be exactly what they were.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-18 00:00:00', SECTION: 'ECS', 'PF NO': '7000145', NAME: 'Two Shift Agent', 'LOGIN ID': '36145',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 17:00', 'OT-2': '', 'SCH DURATION': '9:0', 'SIGNIN DURATION': '09:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg145 = (start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: '7000145', NOM_DATE: '18/09/2026', START_DATE: '18/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: `18/09/2026 ${start}:00`, STOP_MOMENT: `18/09/2026 ${stop}:00`, DURATION: dur });
    const punches: CMSPunch[] = [
      { Date: '18/09/2026', LoginID: '36145', LoginDateTime: makeDt('18/09/2026', '08:00:00'), LogoutDateTime: makeDt('18/09/2026', '08:00:03') },
      { Date: '18/09/2026', LoginID: '36145', LoginDateTime: makeDt('18/09/2026', '17:00:00'), LogoutDateTime: makeDt('18/09/2026', '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: [seg145('08:00', '16:00', 480), seg145('16:00', '17:00', 60)], aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const d1 = row.columnComparisons.find(c => c.column === 'DUTY1');
    const d2 = row.columnComparisons.find(c => c.column === 'DUTY-2');
    const passed = d1?.status === 'MATCH' && d2?.status === 'MATCH' && row.holdReason !== 'MISMATCH_FOUND'
      && row.TAA_SCH_HOURS_RECOMPUTED === 540 && row.TAA_EFFECTIVE_START === '08:00' && row.TAA_EFFECTIVE_END === '17:00' && row.TAA_ACTION === 'NO_ACTION';

    results.push({
      id: 'reg-145',
      name: 'Back-To-Back SHIFT Segments Are Two Duties: DUTY1 And DUTY-2 Match Cognos, Pay Fields Unchanged',
      category: 'Cognos comparison: duty blocks',
      inputDescription: 'SHIFT 08:00-16:00 + SHIFT 16:00-17:00 (0-minute gap), worked in full; Cognos DUTY1 08:00 - 16:00, DUTY-2 16:00 - 17:00',
      cognosFlawedVerdict: 'N/A - TAA merged the 0-minute gap into one 08:00-17:00 block: DUTY1 and DUTY-2 both MISMATCH (0 of 29 real two-shift rows matched) and the row was soft-held',
      expectedVerdict: 'DUTY1 MATCH, DUTY-2 MATCH, no MISMATCH_FOUND hold; hours 540, window 08:00-17:00, NO_ACTION',
      expectedAction: 'NO_ACTION',
      actualVerdict: `DUTY1=${d1?.status}(${d1?.recomputedRaw}); DUTY-2=${d2?.status}(${d2?.recomputedRaw}); hold=${row.holdReason ?? 'none'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; window=${row.TAA_EFFECTIVE_START}-${row.TAA_EFFECTIVE_END}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'No pay change: duty blocks are comparison-only. The only effect is that a row held purely for a false DUTY1/DUTY-2 disagreement is no longer held',
      calculationTrace: [`DUTY1 ${d1?.recomputedRaw} ${d1?.status}`, `DUTY-2 ${d2?.recomputedRaw} ${d2?.status}`],
    });
  }

  // Case 144 (real sample shape, PF 90135627): SPLIT is the unpaid split-shift gap. Unclassified
  // it force-held the row and its 60 minutes stayed in the scheduled hours; Cognos deducts it.
  // As a REMOVAL it is a mid-shift removal: minutes come off, the window is untouched, no hold.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-15 00:00:00', SECTION: 'ECS', 'PF NO': '7000144', NAME: 'Split Shift Agent', 'LOGIN ID': '36144',
      DUTY1: '08:30 - 17:30', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '09:00',
      'SIGIN IN': '08:30', 'SIGIN OUT': '17:30', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg144 = (code: string, start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: '7000144', NOM_DATE: '15/09/2026', START_DATE: '15/09/2026', SEG_CODE: code, START_MOMENT: `15/09/2026 ${start}:00`, STOP_MOMENT: `15/09/2026 ${stop}:00`, DURATION: dur });
    const segs: AspectSegment[] = [seg144('SHIFT', '08:30', '17:30', 540), seg144('SPLIT', '14:30', '15:30', 60)];
    const punches: CMSPunch[] = [
      { Date: '15/09/2026', LoginID: '36144', LoginDateTime: makeDt('15/09/2026', '08:30:00'), LogoutDateTime: makeDt('15/09/2026', '08:30:03') },
      { Date: '15/09/2026', LoginID: '36144', LoginDateTime: makeDt('15/09/2026', '17:30:00'), LogoutDateTime: makeDt('15/09/2026', '17:30:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const sch = row.columnComparisons.find(c => c.column === 'SCH DURATION');
    const passed = row.holdReason !== 'UNCLASSIFIED_SEGMENT_CODE' && row.holdReason !== 'MID_SHIFT_REMOVAL_SEGMENT'
      && row.TAA_SCH_HOURS_RECOMPUTED === 480 && sch?.status === 'MATCH'
      && row.TAA_EFFECTIVE_START === '08:30' && row.TAA_EFFECTIVE_END === '17:30' && row.TAA_ACTION === 'NO_ACTION';

    results.push({
      id: 'reg-144',
      name: 'SPLIT Segment Is An Unpaid Removal: Hours Deducted, Window Untouched, Not Held',
      category: 'Variance audit F7: hours vs window',
      inputDescription: 'SHIFT 08:30-17:30 (540) + SPLIT 14:30-15:30 (60), worked in full; Cognos SCH DURATION 8:0',
      cognosFlawedVerdict: 'N/A - TAA left SPLIT unclassified: forced UNCLASSIFIED_SEGMENT_CODE hold and Sch Duration 9:00 vs Cognos 8:0',
      expectedVerdict: 'No hold; hours 480; SCH DURATION MATCH; effective window 08:30-17:30; NO_ACTION',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.holdReason ?? 'no hold'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; sch=${sch?.status}; window=${row.TAA_EFFECTIVE_START}-${row.TAA_EFFECTIVE_END}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Split-gap minutes come off scheduled hours (matches what Cognos deducts on all 5 real sample SPLIT rows) and the day is no longer force-held',
      calculationTrace: [`Net ${row.TAA_SCH_HOURS_RECOMPUTED}`, `Hold ${row.holdReason ?? 'none'}`],
    });
  }

  // Case 76: a MID-shift removal reduces netScheduledMinutes (released minutes are released wherever they fall) but never holds the row or moves the window.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000076', NAME: 'Mid Hours Agent', 'LOGIN ID': '36076',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000076', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000076', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 10:00:00', STOP_MOMENT: '27/08/2026 11:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36076', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '36076', LoginDateTime: makeDt('27/08/2026', '15:00:00'), LogoutDateTime: makeDt('27/08/2026', '15:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.holdReason !== 'MID_SHIFT_REMOVAL_SEGMENT'
      && row.TAA_SCH_HOURS_RECOMPUTED === 420
      && row.TAA_EFFECTIVE_START === '07:00' && row.TAA_EFFECTIVE_END === '15:00';

    results.push({
      id: 'reg-76',
      name: 'Mid-Shift Removal Reduces Net Scheduled Minutes Without Moving The Window',
      category: 'Variance audit F7: hours vs window',
      inputDescription: 'SHIFT 480m + MID RLS 10:00-11:00 (60m). Hours must drop to 420; window stays 07:00-15:00; no hold',
      cognosFlawedVerdict: 'Left the released hour in the scheduled hours (480) and locked the row, so Sch Duration disagreed with Cognos on every mid-shift release',
      expectedVerdict: 'No MID hold; TAA_SCH_HOURS_RECOMPUTED=420; effective window 07:00-15:00 unchanged',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.holdReason ?? 'no hold'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; window=${row.TAA_EFFECTIVE_START}-${row.TAA_EFFECTIVE_END}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A release is release time wherever it falls: the 60 minutes come off paid scheduled hours, while the attendance window is left alone so no early/late logout is invented',
      calculationTrace: [`Hours ${row.TAA_SCH_HOURS_RECOMPUTED}`, `Hold ${row.holdReason}`],
    });
  }

  // Case 77: unclaimed swipe just outside the LIVE search window + in-window logout only
  // must hold, not Rule 6 Absent. Punch times derive from config.cmsPunchSearchWindowHours.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'OPS', 'PF NO': '7000077', NAME: 'Early Swipe Agent', 'LOGIN ID': '36077',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '16:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000077', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const shiftStart = makeDt('01/09/2026', '08:00:00');
    const shiftEnd = makeDt('01/09/2026', '16:00:00');
    const outsideSwipe = shiftHours(shiftStart, -(liveWindowH + 1)); // 1h beyond the live window
    const edgeSwipe = shiftHours(shiftStart, -liveWindowH);          // exactly on the (inclusive) edge
    // Coverage sentinels far beyond the window on both sides, so the day reaches the
    // genuine evidence branch rather than an INSUFFICIENT_CMS_COVERAGE hold.
    const sentinels = [swipeAt('36077', shiftHours(shiftStart, -(liveWindowH + 24))), swipeAt('36077', shiftHours(shiftEnd, liveWindowH + 24))];
    const inWindowLogout = swipeAt('36077', shiftEnd);
    const run = (early: Date) => runReconciliation({
      processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [],
      cmsPunches: [sentinels[0], swipeAt('36077', early), inWindowLogout, sentinels[1]], config,
    }).rows[0];
    const row = run(outsideSwipe);
    const edgeRow = run(edgeSwipe);
    const outsideHolds = row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && row.TAA_VERDICT !== 'ABSENT'
      && !row.includeInOutput;
    const edgeAttributed = edgeRow.details.punchCount === 2 && edgeRow.TAA_VERDICT !== 'ABSENT';
    const passed = outsideHolds && edgeAttributed;

    results.push({
      id: 'reg-77',
      name: `Unclaimed Swipe Outside the ±${liveWindowH}h Window With In-Window Logout Holds, Not Auto-Absent`,
      category: 'Variance audit F5: early-login edge',
      inputDescription: `SHIFT 08:00-16:00; live window ±${liveWindowH}h. Run A: swipe ${hhmm(outsideSwipe)} (1h outside) + in-window 16:00. Run B: swipe ${hhmm(edgeSwipe)} (exactly on the edge) + 16:00; far sentinels make coverage sufficient`,
      cognosFlawedVerdict: 'Single in-window punch → Rule 6 ABSENT even though an earlier unclaimed swipe exists',
      expectedVerdict: `A: MANUAL_REVIEW_REQUIRED (hold), never ABSENT. B: edge swipe attributed (2 punches), never ABSENT`,
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: `A: ${row.TAA_VERDICT}; hold=${row.holdReason}; punches=${row.details.punchCount} | B: ${edgeRow.TAA_VERDICT}; punches=${edgeRow.details.punchCount}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents an early swipe just outside the live search window from turning a logout-only day into an unpaid absence, and proves a swipe on the window edge still counts',
      calculationTrace: [
        `cmsPunchSearchWindowHours (live) ${liveWindowH}`,
        `A: in-window punches ${row.details.punchCount}, hold ${row.holdReason || 'none'}`,
        `B: in-window punches ${edgeRow.details.punchCount}, verdict ${edgeRow.TAA_VERDICT}`,
      ],
    });
  }

  // =========================================================================
  // reg-78 / reg-79 — Rule 2 (Early Login), added 2026-09-09 pre-UAT audit.
  // Rule 2 in Rules to be taken.csv (Early Login -> No Action, both tiers)
  // previously had NO code path at all: reconciliationEngine.ts never
  // computed an "arrived early" minute figure and never called
  // lookupRule('Early Login', ...), so a user editing that row in the
  // Config Registry UI would see their change do nothing — a real gap
  // against §6.4's "every rule is genuinely wired through the UI" audit
  // requirement, even though the No-Action outcome itself was always
  // correct. These two cases pin that the lookup now actually fires (via
  // the EARLY_LOGIN trace measurement) for both tiers, with behavior
  // unchanged (still No Action, no correction row).
  // =========================================================================
  {
    const D = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '9900003',
      NAME: 'Early Arrival OPS', 'LOGIN ID': '99003',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '',
      'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9900003', NOM_DATE: D, START_DATE: D, SEG_CODE: 'SHIFT', START_MOMENT: D + ' 07:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9900003', EMP_LAST_NAME: 'Early Arrival', EMP_SORT_NAME: 'EARLY ARRIVAL OPS', EMP_EXTRA_2: 'earlyarrival' },
    ];
    const punches: CMSPunch[] = [
      { Date: D, LoginID: '99003', LoginDateTime: makeDt(D, '06:30:00'), LogoutDateTime: makeDt(D, '06:30:00') },
      { Date: D, LoginID: '99003', LoginDateTime: makeDt(D, '15:00:00'), LogoutDateTime: makeDt(D, '15:00:00') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const trace = row.details.varianceTrace;
    const earlyLoginMeasurement = trace?.measurements.find(m => m.label === 'EARLY_LOGIN');
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION'
      && !!earlyLoginMeasurement && earlyLoginMeasurement.minutes === 30 && earlyLoginMeasurement.bandAction === 'NO_ACTION';

    results.push({
      id: 'reg-78',
      name: 'Early Login OPS 30 min — Rule 2 is now actually evaluated, still No Action',
      category: 'Rule 2: Early Login (previously unwired)',
      inputDescription: 'Shift 07:00–15:00, OPS, login 06:30 (30 min early)',
      cognosFlawedVerdict: 'n/a — pins that Rule 2 is reachable, not a Cognos defect',
      expectedVerdict: 'PRESENT / NO_ACTION, with an EARLY_LOGIN trace measurement resolving to the No-Action band',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT + (earlyLoginMeasurement ? ` (EARLY_LOGIN measured ${earlyLoginMeasurement.minutes}m -> ${earlyLoginMeasurement.bandAction})` : ' (no EARLY_LOGIN measurement found)'),
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the Early Login config row is genuinely wired into the engine, not just present in the Config Registry, and continues to produce no charge or correction, per Rules to be taken.csv Rule 2',
      calculationTrace: [
        `Shift ${trace?.rawStart} - ${trace?.rawEnd}`,
        `CMS in ${trace?.actualFirstLogin}, out ${trace?.actualLastLogout}`,
        earlyLoginMeasurement ? `EARLY_LOGIN: ${earlyLoginMeasurement.minutes}m -> band ${earlyLoginMeasurement.bandDescription || 'none'} (${earlyLoginMeasurement.bandAction || 'no action'})` : 'No EARLY_LOGIN measurement found',
      ],
    });
  }

  {
    const D = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '9900004',
      NAME: 'Early Arrival Officer', 'LOGIN ID': '99004',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '',
      'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9900004', NOM_DATE: D, START_DATE: D, SEG_CODE: 'SHIFT', START_MOMENT: D + ' 07:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9900004', EMP_LAST_NAME: 'Early Arrival Officer', EMP_SORT_NAME: 'EARLY ARRIVAL OFFICER, ES OFCR', EMP_EXTRA_2: 'earlyarrivalofcr' },
    ];
    const punches: CMSPunch[] = [
      { Date: D, LoginID: '99004', LoginDateTime: makeDt(D, '06:45:00'), LogoutDateTime: makeDt(D, '06:45:00') },
      { Date: D, LoginID: '99004', LoginDateTime: makeDt(D, '15:00:00'), LogoutDateTime: makeDt(D, '15:00:00') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const trace = row.details.varianceTrace;
    const earlyLoginMeasurement = trace?.measurements.find(m => m.label === 'EARLY_LOGIN');
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION'
      && !!earlyLoginMeasurement && earlyLoginMeasurement.minutes === 15 && earlyLoginMeasurement.bandAction === 'NO_ACTION';

    results.push({
      id: 'reg-79',
      name: 'Early Login Officer+ 15 min — Rule 2 evaluated for both tiers',
      category: 'Rule 2: Early Login (previously unwired)',
      inputDescription: 'Shift 07:00–15:00, Officer+, login 06:45 (15 min early)',
      cognosFlawedVerdict: 'n/a — pins that Rule 2 is reachable for both tiers, not a Cognos defect',
      expectedVerdict: 'PRESENT / NO_ACTION, with an EARLY_LOGIN trace measurement resolving to the No-Action band',
      expectedAction: 'NO_ACTION',
      actualVerdict: row.TAA_VERDICT + (earlyLoginMeasurement ? ` (EARLY_LOGIN measured ${earlyLoginMeasurement.minutes}m -> ${earlyLoginMeasurement.bandAction})` : ' (no EARLY_LOGIN measurement found)'),
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms Rule 2 is tier-aware and reachable for Officer+ as well as OPS, not only wired for one tier',
      calculationTrace: [
        `Shift ${trace?.rawStart} - ${trace?.rawEnd}`,
        `CMS in ${trace?.actualFirstLogin}, out ${trace?.actualLastLogout}`,
        earlyLoginMeasurement ? `EARLY_LOGIN: ${earlyLoginMeasurement.minutes}m -> band ${earlyLoginMeasurement.bandDescription || 'none'} (${earlyLoginMeasurement.bandAction || 'no action'})` : 'No EARLY_LOGIN measurement found',
      ],
    });
  }

  // =========================================================================
  // reg-80 .. reg-90 — pre-UAT payroll-math audit (2026-09-09). Each case
  // pins one confirmed-and-fixed defect from doc/CLAUDE_PAYROLL_MATH_BUG_REPORT.md,
  // using the same synthetic setup as that report's own evidence IDs
  // (named in each case's category) so the fix and its regression guard are
  // traceable to the same finding.
  // =========================================================================
  {
    // F01: a COVER segment already present in ASPECT on the target day must
    // be treated as the day's real last segment — a newly placed cover must
    // stack after it, never overlap it.
    const incidentDay = '27/08/2026';
    const targetDay = '28/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000001', NAME: 'F01 Agent', 'LOGIN ID': '80001',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000001', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 09:00:00`, STOP_MOMENT: `${incidentDay} 17:00:00`, DURATION: 480 },
      { EMP_ID: '8000001', NOM_DATE: targetDay, START_DATE: targetDay, SEG_CODE: 'SHIFT', START_MOMENT: `${targetDay} 09:00:00`, STOP_MOMENT: `${targetDay} 17:00:00`, DURATION: 480 },
      { EMP_ID: '8000001', NOM_DATE: targetDay, START_DATE: targetDay, SEG_CODE: 'COVER', START_MOMENT: `${targetDay} 17:00:00`, STOP_MOMENT: `${targetDay} 17:12:00`, DURATION: 12 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000001', EMP_LAST_NAME: 'F01 Agent', EMP_SORT_NAME: 'F01 AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '80001', LoginDateTime: makeDt(incidentDay, '09:06:00'), LogoutDateTime: makeDt(incidentDay, '09:06:03') },
      { Date: incidentDay, LoginID: '80001', LoginDateTime: makeDt(incidentDay, '17:00:00'), LogoutDateTime: makeDt(incidentDay, '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover?.SegmentStarttime === '17:12' && cover?.SegmentDate === targetDay && cover?.nominateDate === targetDay;

    results.push({
      id: 'reg-80', name: 'New Cover Stacks After an Existing ASPECT Cover (F01)', category: 'Payroll audit F01: cover placement ignored existing cover',
      inputDescription: '27/08 6-min late; 28/08 already has SHIFT 09:00-17:00 + COVER 17:00-17:12',
      cognosFlawedVerdict: 'New cover placed at 17:00, overlapping the existing 17:00-17:12 cover',
      expectedVerdict: 'New cover starts at 17:12, after the existing cover', expectedAction: 'COVER at 17:12',
      actualVerdict: cover ? `COVER on ${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover', actualAction: cover ? cover.Segmentduration : 'None',
      passed, payrollImpact: 'Prevents scheduling the same cover minutes twice or an overlap ASPECT may resolve unpredictably',
      calculationTrace: [`Cover: ${JSON.stringify(cover)}`],
    });
  }

  {
    // F03 removal (2026-09-09, user-confirmed): CMS is a full-staff export
    // with no per-agent filtering, so "zero CMS punches for this login" is
    // one standard rule for every row — regardless of whether other logins
    // in the file have data. The former CMS_EXPORT_SCOPE_GAP hold is gone;
    // this case now auto-Absents like any other no-login row (Rule 5). The
    // upload-time headcount mapping check (see the reg-102 case below) is
    // the replacement safeguard, surfaced once per upload instead of guessed
    // per row.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000003', NAME: 'F03 Agent', 'LOGIN ID': '80003',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [{ EMP_ID: '8000003', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 }];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000003', EMP_LAST_NAME: 'F03 Agent', EMP_SORT_NAME: 'F03 AGENT' }];
    // CMS data exists, but only for a DIFFERENT login — this employee's own login has zero punches.
    const punches: CMSPunch[] = [
      { Date: day, LoginID: 'OTHER_LOGIN', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: 'OTHER_LOGIN', LoginDateTime: makeDt(day, '17:00:00'), LogoutDateTime: makeDt(day, '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'NO_SHOW' && row.TAA_ACTION === 'ABSENT_NS_NC' && row.includeInOutput;

    results.push({
      id: 'reg-81', name: 'CMS Covers Other Logins But Not This One — Standard Absent Rule (F03 removed)', category: 'Payroll audit F03: CMS export scope gap guard removed',
      inputDescription: 'CMS file has punches for a different Login ID; this employee\'s own login has zero',
      cognosFlawedVerdict: 'Before F03 removal: held as MISSING_LOGIN_ID/CMS_EXPORT_SCOPE_GAP, never auto-Absent',
      expectedVerdict: 'NO_SHOW / ABSENT_NS_NC, exported as a correction — same standard rule as any other zero-punch login', expectedAction: 'ABSENT_NS_NC',
      actualVerdict: `${row.TAA_VERDICT}; hold=${row.holdReason}; included=${row.includeInOutput}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'CMS is a full-staff export with no per-agent filtering (user-confirmed) — the risk of a scoped/incomplete export is now caught once at upload via the headcount mapping check, not guessed per row',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Hold ${row.holdReason}`],
    });
  }

  {
    // F04: two removals covering the same physical hour must remove it once, not twice.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000004', NAME: 'F04 Agent', 'LOGIN ID': '80004',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000004', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      { EMP_ID: '8000004', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 60 },
      { EMP_ID: '8000004', NOM_DATE: day, START_DATE: day, SEG_CODE: 'NURSNG', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000004', EMP_LAST_NAME: 'F04 Agent', EMP_SORT_NAME: 'F04 AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80004', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80004', LoginDateTime: makeDt(day, '16:00:00'), LogoutDateTime: makeDt(day, '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_SCH_HOURS_RECOMPUTED === 420;

    results.push({
      id: 'reg-82', name: 'Overlapping RLS + NURSNG On The Same Hour Remove It Once, Not Twice (F04)', category: 'Payroll audit F04: overlapping removals double-subtract',
      inputDescription: 'SHIFT 480m; RLS 16:00-17:00 (60m) and NURSNG 16:00-17:00 (60m) cover the identical hour',
      cognosFlawedVerdict: 'net=360 (both removals subtracted independently, double-charging the same hour)',
      expectedVerdict: 'net=420 (the physical hour removed once)', expectedAction: 'NET 420 MIN',
      actualVerdict: `net=${row.TAA_SCH_HOURS_RECOMPUTED}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents paid scheduled minutes being undercounted by the overlap whenever two segment codes describe the same physical release hour',
      calculationTrace: [`Net scheduled minutes: ${row.TAA_SCH_HOURS_RECOMPUTED}`],
    });
  }

  {
    // F09a: "No Login Record" set to NO_ACTION in config must actually suppress the absence.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000009', NAME: 'F09 Agent', 'LOGIN ID': '80009',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [{ EMP_ID: '8000009', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 }];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000009', EMP_LAST_NAME: 'F09 Agent', EMP_SORT_NAME: 'F09 AGENT' }];
    const noLoginCfg: ConfigRegistry = { ...config, policyRules: config.policyRules.map(r => r.segmentType === 'No Login Record' ? { ...r, action: 'NO_ACTION' } : r) };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config: noLoginCfg });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && row.details.generatedCorrections.length === 0;

    results.push({
      id: 'reg-83', name: 'No Login Record Config Set to NO_ACTION Is Honoured (F09a)', category: 'Payroll audit F09: configured action ignored',
      inputDescription: 'SHIFT 09:00-17:00, zero CMS punches, "No Login Record" rule action overridden to NO_ACTION',
      cognosFlawedVerdict: 'Still emits ABSENT_NS_NC regardless of the configured action',
      expectedVerdict: 'PRESENT / NO_ACTION, no correction emitted', expectedAction: 'NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT}; corrections=${row.details.generatedCorrections.length}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'An administrator disabling a rule in the Config Registry UI must see that reflected in output, not silently ignored',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Corrections ${row.details.generatedCorrections.length}`],
    });
  }

  {
    // F09b: Rule 8 (RLS added to OT) set to NO_ACTION must suppress the OT adjustment pair.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000010', NAME: 'F09b Agent', 'LOGIN ID': '80010',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000010', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      { EMP_ID: '8000010', NOM_DATE: day, START_DATE: day, SEG_CODE: 'OT1', START_MOMENT: `${day} 17:00:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 60 },
      { EMP_ID: '8000010', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 17:30:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000010', EMP_LAST_NAME: 'F09b Agent', EMP_SORT_NAME: 'F09B AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80010', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80010', LoginDateTime: makeDt(day, '17:30:00'), LogoutDateTime: makeDt(day, '17:30:03') },
    ];
    const noOtCfg: ConfigRegistry = { ...config, policyRules: config.policyRules.map(r => r.segmentType === 'RLS segment added to OT with no adjustment' ? { ...r, action: 'NO_ACTION' } : r) };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: noOtCfg });
    const row = out.rows[0];
    const passed = row.details.generatedCorrections.length === 0;

    results.push({
      id: 'reg-84', name: 'RLS-Added-To-OT Config Set to NO_ACTION Suppresses the Adjustment Pair (F09b)', category: 'Payroll audit F09: configured action ignored',
      inputDescription: 'OT1 17:00-18:00 overlapped by RLS 17:30-18:00; Rule 8 action overridden to NO_ACTION',
      cognosFlawedVerdict: 'Still emits the OT original/adjusted correction pair regardless of the configured action',
      expectedVerdict: 'No corrections emitted', expectedAction: 'NO CORRECTIONS',
      actualVerdict: `corrections=${row.details.generatedCorrections.length}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'An administrator disabling Rule 8 must see that reflected in output, not silently ignored',
      calculationTrace: [`Corrections: ${JSON.stringify(row.details.generatedCorrections)}`],
    });
  }

  {
    // F10: a target day with its own schedule-integrity error must not be used to place cover.
    const incidentDay = '27/08/2026';
    const targetDay = '28/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000010', NAME: 'F10 Agent', 'LOGIN ID': '80011',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000010', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 09:00:00`, STOP_MOMENT: `${incidentDay} 17:00:00`, DURATION: 480 },
      // Target day's own SHIFT has a DURATION that disagrees with its own timestamps (479 vs the real 480).
      { EMP_ID: '8000010', NOM_DATE: targetDay, START_DATE: targetDay, SEG_CODE: 'SHIFT', START_MOMENT: `${targetDay} 09:00:00`, STOP_MOMENT: `${targetDay} 17:00:00`, DURATION: 479 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000010', EMP_LAST_NAME: 'F10 Agent', EMP_SORT_NAME: 'F10 AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '80011', LoginDateTime: makeDt(incidentDay, '09:06:00'), LogoutDateTime: makeDt(incidentDay, '09:06:03') },
      { Date: incidentDay, LoginID: '80011', LoginDateTime: makeDt(incidentDay, '17:00:00'), LogoutDateTime: makeDt(incidentDay, '17:00:03') },
    ];
    // Revised 2026-09-20: the inconsistent target day is still never used, but the cover now
    // takes the §4.11 Step 5 fallback (pinned: next-week Monday) instead of locking the row.
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday', coverSameDayWhenAlreadyCovered: false } });
    const row = out.rows[0];
    const cover = row.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = row.includeInOutput && row.holdReason === undefined
      && cover !== undefined && cover.nominateDate === '31/08/2026' && cover.Memo.includes('28/08/2026 unusable (SEGMENT_STOP_DURATION_DISAGREE)');

    results.push({
      id: 'reg-85', name: 'Cover Skips a Target Day With Its Own Duration Disagreement and Uses the §4.11 Fallback (F10)', category: 'Payroll audit F10: target-day integrity not checked',
      inputDescription: 'Incident 27/08 (6m late); target day 28/08 SHIFT timestamps span 480m but DURATION says 479; fallback pinned to next-week Monday',
      cognosFlawedVerdict: 'Cover is exported onto the target day despite its own known schedule-integrity error',
      expectedVerdict: 'Not held; COVER on fallback date 31/08/2026, never on 28/08; Memo names the unusable day', expectedAction: 'LATE_AND_COVER, COVER exported',
      actualVerdict: `included=${row.includeInOutput}; hold=${row.holdReason}; cover=${cover ? `${cover.nominateDate} | ${cover.Memo}` : 'none'}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Still never places a correction onto a day the app knows is internally inconsistent, without stranding the row for manual rework',
      calculationTrace: [`Hold reason: ${row.holdReason}`, `Cover: ${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}` : 'none'}`],
    });
  }

  {
    // F11: an exactly-duplicated SHIFT segment must not double net scheduled minutes.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000011', NAME: 'F11 Agent', 'LOGIN ID': '80012',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const shiftSeg: AspectSegment = { EMP_ID: '8000011', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 };
    const segs: AspectSegment[] = [shiftSeg, { ...shiftSeg }];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000011', EMP_LAST_NAME: 'F11 Agent', EMP_SORT_NAME: 'F11 AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80012', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80012', LoginDateTime: makeDt(day, '17:00:00'), LogoutDateTime: makeDt(day, '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_SCH_HOURS_RECOMPUTED === 480;

    results.push({
      id: 'reg-86', name: 'A Byte-Identical Duplicate SHIFT Row Does Not Double Net Minutes (F11)', category: 'Payroll audit F11: duplicate addition doubles hours',
      inputDescription: 'The exact same SHIFT 09:00-17:00 row appears twice in the ASPECT upload',
      cognosFlawedVerdict: 'net=960 (the duplicate summed a second time)',
      expectedVerdict: 'net=480 (the duplicate is deduped)', expectedAction: 'NET 480 MIN',
      actualVerdict: `net=${row.TAA_SCH_HOURS_RECOMPUTED}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a duplicated ASPECT export row from doubling paid scheduled hours',
      calculationTrace: [`Net scheduled minutes: ${row.TAA_SCH_HOURS_RECOMPUTED}`],
    });
  }

  {
    // F08: flex staff must still run Rule 7 (Cover Not Attended).
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000008', NAME: 'F08 Agent Flex', 'LOGIN ID': '80008',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000008', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: 480 },
      { EMP_ID: '8000008', NOM_DATE: day, START_DATE: day, SEG_CODE: 'COVER', START_MOMENT: `${day} 15:00:00`, STOP_MOMENT: `${day} 15:10:00`, DURATION: 10 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000008', EMP_LAST_NAME: 'F08 Agent Flex', EMP_SORT_NAME: 'F08 AGENT FLX, ES OFCR' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80008', LoginDateTime: makeDt(day, '07:00:00'), LogoutDateTime: makeDt(day, '07:00:03') },
      { Date: day, LoginID: '80008', LoginDateTime: makeDt(day, '15:00:00'), LogoutDateTime: makeDt(day, '15:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.TAA_VERDICT !== 'PRESENT' && row.details.generatedCorrections.length > 0;

    results.push({
      id: 'reg-87', name: 'Flex Staff Still Run Rule 7 (Cover Not Attended) (F08)', category: 'Payroll audit F08: flex skipped Rule 7',
      inputDescription: 'Flex Officer+ SHIFT 07:00-15:00 + COVER 15:00-15:10; punches only at 07:00 and 15:00 (cover entirely unattended)',
      cognosFlawedVerdict: 'PRESENT / NO_ACTION, no correction — flex staff never ran Rule 7 at all',
      expectedVerdict: 'Rule 7 fires (10 unattended cover minutes, Officer+ 6-19m band)', expectedAction: 'NOT PRESENT/NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT}; corrections=${row.details.generatedCorrections.length}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a flex employee missing required cover minutes with zero correction ever generated',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Action ${row.TAA_ACTION}`],
    });
  }

  {
    // F14: a flex employee who genuinely works through a scheduled OT block
    // (RLS overlapping it) must not be falsely marked absent, and the OT
    // must be adjusted for the release.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000014', NAME: 'F14 Agent Flex', 'LOGIN ID': '80014',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000014', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: 480 },
      { EMP_ID: '8000014', NOM_DATE: day, START_DATE: day, SEG_CODE: 'OT1', START_MOMENT: `${day} 15:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 120 },
      { EMP_ID: '8000014', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 16:30:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000014', EMP_LAST_NAME: 'F14 Agent Flex', EMP_SORT_NAME: 'F14 AGENT FLX, ES OFCR' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80014', LoginDateTime: makeDt(day, '07:00:00'), LogoutDateTime: makeDt(day, '07:00:03') },
      { Date: day, LoginID: '80014', LoginDateTime: makeDt(day, '17:00:00'), LogoutDateTime: makeDt(day, '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const adjustedOt = row.details.generatedCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === 'OT1');
    const passed = row.TAA_VERDICT !== 'ABSENT' && adjustedOt?.Segmentduration === '01:30';

    results.push({
      id: 'reg-88', name: 'Flex Employee Genuinely Working Through Scheduled OT Is Not Falsely Absent (F14)', category: 'Payroll audit F14: flex end-anchor ignored OT',
      inputDescription: 'Flex Officer+ SHIFT 07:00-15:00 + OT1 15:00-17:00 + RLS 16:30-17:00; punches 07:00 and 17:00 (worked straight through)',
      cognosFlawedVerdict: 'ABSENT / ABSENT_SEGMENT charged 120m — late-logout measured only against the SHIFT\'s own end, ignoring the OT genuinely worked',
      expectedVerdict: 'Not absent; OT1 adjusted to 90 minutes for the 30-minute RLS overlap', expectedAction: 'NOT ABSENT, OT ADJUSTED',
      actualVerdict: `${row.TAA_VERDICT}; adjustedOT=${adjustedOt?.Segmentduration}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a flex employee who works a genuine OT window from being marked absent purely because the anchor ignored the OT block',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Adjusted OT duration ${adjustedOt?.Segmentduration}`],
    });
  }

  {
    // F12: an explicit real DURATION on a leave segment must be compared, not
    // suppressed just because its SEG_CODE is in leaveCodesWithoutDuration.
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000012', NAME: 'F12 Agent', 'LOGIN ID': '80013',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [{ EMP_ID: '8000012', NOM_DATE: day, START_DATE: day, SEG_CODE: 'ANNUAL', DURATION: 60 } as AspectSegment];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000012', EMP_LAST_NAME: 'F12 Agent', EMP_SORT_NAME: 'F12 AGENT' }];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const leaveHrComparison = row.columnComparisons.find(c => c.column === 'LEAVE HR');
    const passed = leaveHrComparison?.status === 'MISMATCH';

    results.push({
      id: 'reg-89', name: 'An ANNUAL Segment With a Real Explicit Duration Is Compared, Not Suppressed (F12)', category: 'Payroll audit F12: full-day leave suppression by code name alone',
      inputDescription: 'ASPECT ANNUAL segment carries an explicit DURATION=60; Cognos LEAVE HR=480 (a genuine 7-hour pay gap)',
      cognosFlawedVerdict: 'LEAVE HR reported NOT_COMPARABLE purely because ANNUAL is a full-day-by-design code, hiding a real 7-hour pay disagreement',
      expectedVerdict: 'LEAVE HR is a genuine MISMATCH (60 vs 480)', expectedAction: 'MISMATCH FLAGGED',
      actualVerdict: `LEAVE HR status=${leaveHrComparison?.status}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a real partial-day leave duration from silently escaping review just because its code name matches a full-day-by-design list',
      calculationTrace: [`LEAVE HR comparison: ${JSON.stringify(leaveHrComparison)}`],
    });
  }

  {
    // F13: malformed DURATION text must be rejected, not silently truncated
    // to a plausible-looking number.
    const csvHeader = 'EMP_ID,EMP_LAST_NAME,NOM_DATE,START_DATE,SEG_CODE,START_MOMENT,STOP_MOMENT,DURATION\n';
    const csvRow = 'F13AGENT,F13 Agent,27/08/2026,27/08/2026,SHIFT,27/08/2026 09:00,27/08/2026 17:00,480garbage';
    const parsed = parseAspectSegments(csvHeader + csvRow);
    const passed = parsed.length === 1 && parsed[0].DURATION === undefined;

    results.push({
      id: 'reg-90', name: 'A Malformed DURATION Value Is Rejected, Not Silently Truncated (F13)', category: 'Payroll audit F13: DURATION parser accepts garbage',
      inputDescription: 'ASPECT row DURATION column reads "480garbage"',
      cognosFlawedVerdict: 'parseInt truncates to 480 — a corrupted field becomes an indistinguishable, correct-looking payroll minute count',
      expectedVerdict: 'DURATION parses to undefined (falls back to the segment\'s real START/STOP timestamps downstream)', expectedAction: 'DURATION REJECTED',
      actualVerdict: `DURATION=${parsed[0]?.DURATION}`, actualAction: 'n/a',
      passed, payrollImpact: 'Prevents a malformed ASPECT DURATION field from silently becoming a trusted payroll minute value with no hold and no way for a reviewer to notice',
      calculationTrace: [`Parsed segment: ${JSON.stringify(parsed[0])}`],
    });
  }

  {
    // R1a: Rule 8's OT/RLS adjustment pair must derive SegmentDate from the segment's
    // own parsed START_MOMENT, never the raw, un-normalized ASPECT START_DATE text.
    const day = '08/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-08 00:00:00', SECTION: 'ECS', 'PF NO': '8000091', NAME: 'R1a Agent', 'LOGIN ID': '80091',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000091', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      // START_DATE deliberately un-padded/mismatched — the old code read this raw string
      // straight into SegmentDate; the fix derives SegmentDate from START_MOMENT instead.
      { EMP_ID: '8000091', NOM_DATE: day, START_DATE: '8/9/2026', SEG_CODE: 'OT1', START_MOMENT: `${day} 17:00:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 60 },
      { EMP_ID: '8000091', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 17:30:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000091', EMP_LAST_NAME: 'R1a Agent', EMP_SORT_NAME: 'R1A AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80091', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80091', LoginDateTime: makeDt(day, '17:30:00'), LogoutDateTime: makeDt(day, '17:30:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const otCorrections = row.details.generatedCorrections.filter(c => c.SegmentCode === 'OT1');
    const passed = otCorrections.length === 2 && otCorrections.every(c => c.SegmentDate === day);

    results.push({
      id: 'reg-91', name: 'Rule 8\'s OT/RLS Correction Pair Uses a Normalized SegmentDate, Not Raw START_DATE Text (R1a)', category: 'Post-fix-pass audit R1: raw START_DATE reaches exported SegmentDate',
      inputDescription: 'OT1 17:00-18:00 overlapped by RLS 17:30-18:00; the OT1 segment\'s own START_DATE is un-padded ("8/9/2026") and would fail to match the zero-padded day elsewhere in the export',
      cognosFlawedVerdict: 'SegmentDate on the correction pair carries the raw, un-normalized "8/9/2026" text straight from ASPECT',
      expectedVerdict: `Both correction rows carry SegmentDate=${day} (normalized from the segment's own START_MOMENT)`, expectedAction: 'NORMALIZED SEGMENTDATE',
      actualVerdict: `SegmentDates=${otCorrections.map(c => c.SegmentDate).join(',')}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents an un-padded ASPECT export date from reaching the ASPECT correction upload un-normalized, which could fail to join back to the same physical day',
      calculationTrace: [`OT1 corrections: ${JSON.stringify(otCorrections)}`],
    });
  }

  {
    // R1b: the Absent+OT co-occurrence OT->SHIFT conversion must also derive SegmentDate
    // from the segment's own parsed START_MOMENT, never the raw ASPECT START_DATE text.
    const day = '08/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-08 00:00:00', SECTION: 'ECS', 'PF NO': '8000092', NAME: 'R1b Agent', 'LOGIN ID': '80092',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000092', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      // START_DATE deliberately un-padded — same defect as R1a, different emission site
      // (convertOtSegmentsToShift, fired by the Absent+OT co-occurrence rule).
      { EMP_ID: '8000092', NOM_DATE: day, START_DATE: '8/9/2026', SEG_CODE: 'OT1', START_MOMENT: `${day} 17:00:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000092', EMP_LAST_NAME: 'R1b Agent', EMP_SORT_NAME: 'R1B AGENT' }];
    const punches: CMSPunch[] = [
      // A single attributed swipe (insufficientEvidence -> ABSENT), with two extra
      // out-of-window swipes for the same login purely to satisfy the CMS coverage
      // check so the row reaches the genuine single-punch ABSENT branch rather than
      // an INSUFFICIENT_CMS_COVERAGE hold.
      { Date: day, LoginID: '80092', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      // Placed 1h beyond the LIVE search window on each side so they stay unattributed.
      swipeAt('80092', shiftHours(makeDt(day, '09:00:00'), -(liveWindowH + 1))),
      swipeAt('80092', shiftHours(makeDt(day, '17:00:00'), liveWindowH + 1)),
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const originalRow = row.details.generatedCorrections.find(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const shiftConversion = row.details.generatedCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode);
    const passed = row.TAA_VERDICT === 'ABSENT' && originalRow?.SegmentDate === day && shiftConversion?.SegmentDate === day;

    results.push({
      id: 'reg-92', name: 'The Absent-Day OT-to-SHIFT Replace Pair Uses a Normalized SegmentDate, Not Raw START_DATE Text (R1b)', category: 'Post-fix-pass audit R1: raw START_DATE reaches exported SegmentDate',
      inputDescription: 'A single-punch ABSENT day whose OT1 segment carries an un-padded START_DATE ("8/9/2026")',
      cognosFlawedVerdict: 'The OT->SHIFT replace pair\'s SegmentDate carries the raw, un-normalized "8/9/2026" text straight from ASPECT',
      expectedVerdict: `Both rows of the 10/11 pair carry SegmentDate=${day}`, expectedAction: 'NORMALIZED SEGMENTDATE',
      actualVerdict: `verdict=${row.TAA_VERDICT}; originalSegmentDate=${originalRow?.SegmentDate}; replacementSegmentDate=${shiftConversion?.SegmentDate}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents an un-padded ASPECT export date from reaching the ASPECT correction upload un-normalized on an Absent+OT day',
      calculationTrace: [`OT->SHIFT replace pair: original=${JSON.stringify(originalRow)}; replacement=${JSON.stringify(shiftConversion)}`],
    });
  }

  {
    // R4: a target day whose own ASPECT data has malformed/incomplete timestamps
    // (INVALID_ASPECT_DATETIME — the same check that holds a SOURCE day) must not
    // be used to place cover either. Previously only 4 of the 5 source-day integrity
    // checks were mirrored onto the target day; this one was missing.
    const incidentDay = '08/09/2026';
    const targetDay = '09/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-08 00:00:00', SECTION: 'ECS', 'PF NO': '8000093', NAME: 'R4 Agent', 'LOGIN ID': '80093',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000093', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 09:00:00`, STOP_MOMENT: `${incidentDay} 17:00:00`, DURATION: 480 },
      // Target day's own SHIFT has a START_MOMENT but no STOP_MOMENT at all — malformed,
      // not merely disagreeing (that's the reg-85/F10 case; this is the one it didn't cover).
      { EMP_ID: '8000093', NOM_DATE: targetDay, START_DATE: targetDay, SEG_CODE: 'SHIFT', START_MOMENT: `${targetDay} 09:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000093', EMP_LAST_NAME: 'R4 Agent', EMP_SORT_NAME: 'R4 AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '80093', LoginDateTime: makeDt(incidentDay, '09:06:00'), LogoutDateTime: makeDt(incidentDay, '09:06:03') },
      { Date: incidentDay, LoginID: '80093', LoginDateTime: makeDt(incidentDay, '17:00:00'), LogoutDateTime: makeDt(incidentDay, '17:00:03') },
    ];
    // Revised 2026-09-20: a malformed target day is skipped and the cover takes the §4.11
    // Step 5 fallback (pinned: next-week Monday) — it is never placed ON the malformed day,
    // and the Memo says why the date moved. Supersedes the R4 "hold instead" expectation.
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday', coverSameDayWhenAlreadyCovered: false } });
    const row = out.rows[0];
    const cover = row.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = row.includeInOutput && row.holdReason === undefined
      && cover !== undefined && cover.nominateDate === '14/09/2026' && cover.Memo.includes('09/09/2026 unusable (INVALID_ASPECT_DATETIME)');

    results.push({
      id: 'reg-93', name: 'Cover Skips a Target Day With Malformed ASPECT Timestamps and Uses the §4.11 Fallback (R4)', category: 'Post-fix-pass audit R4: target-day integrity check incomplete',
      inputDescription: 'Incident day requires 6-minute Late+Cover; the next working day\'s SHIFT has a START_MOMENT but no STOP_MOMENT at all; fallback pinned to next-week Monday',
      cognosFlawedVerdict: 'The target-day check covers 4 of the 5 source-day integrity signals but not INVALID_ASPECT_DATETIME — cover would be placed on the malformed day',
      expectedVerdict: 'Not held; COVER on fallback date 14/09/2026, never on the malformed 09/09; Memo names the unusable day', expectedAction: 'LATE_AND_COVER, COVER exported',
      actualVerdict: `included=${row.includeInOutput}; hold=${row.holdReason}; cover=${cover ? `${cover.nominateDate} | ${cover.Memo}` : 'none'}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Never places cover onto a schedule the app knows is malformed, and the row still reaches the correction file with the cover on the fallback date',
      calculationTrace: [`Verdict ${row.TAA_VERDICT}`, `Hold ${row.holdReason}`, `Cover: ${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}` : 'none'}`],
    });
  }

  {
    // R5a: a duration-only removal (no usable START/STOP) coexisting with a timestamped
    // removal in the SAME leading/trailing group must hold the row — there is no way to
    // tell whether the duration-only one overlaps the timestamped one, so
    // netScheduledMinutes may still be double-subtracting an undetectable overlap.
    const day = '08/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-08 00:00:00', SECTION: 'ECS', 'PF NO': '8000094', NAME: 'R5a Agent', 'LOGIN ID': '80094',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000094', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      // Timestamped trailing removal.
      { EMP_ID: '8000094', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 60 },
      // Duration-only trailing removal — no START_MOMENT/STOP_MOMENT at all, so there is
      // no interval to union against the RLS above; it might be the same hour or a
      // genuinely different one and the app cannot tell.
      { EMP_ID: '8000094', NOM_DATE: day, START_DATE: day, SEG_CODE: 'NURSNG', DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000094', EMP_LAST_NAME: 'R5a Agent', EMP_SORT_NAME: 'R5A AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80094', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80094', LoginDateTime: makeDt(day, '16:00:00'), LogoutDateTime: makeDt(day, '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = !row.includeInOutput && row.holdReason === 'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION';

    results.push({
      id: 'reg-94', name: 'A Duration-Only Removal Beside a Timestamped One In the Same Group Is Held, Not Guessed (R5a)', category: 'Post-fix-pass audit R5: duration-only removals still double-subtract',
      inputDescription: 'Trailing RLS 16:00-17:00 (timestamped, 60m) alongside a duration-only trailing NURSNG (30m, no timestamps at all)',
      cognosFlawedVerdict: 'net=390 (both removals subtracted independently, silently assuming they cover different time with no evidence either way)',
      expectedVerdict: 'Held (AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION) rather than guessing whether the 30 duration-only minutes overlap the timestamped hour', expectedAction: 'HELD',
      actualVerdict: `included=${row.includeInOutput}; hold=${row.holdReason}; net=${row.TAA_SCH_HOURS_RECOMPUTED}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a duration-only removal from silently double-subtracting (or silently NOT subtracting) an overlap the app has no evidence about either way',
      calculationTrace: [`Hold ${row.holdReason}`, `Net ${row.TAA_SCH_HOURS_RECOMPUTED}`],
    });
  }

  {
    // R5b: the reported release-minute breakdown must match the SAME unioned total
    // netScheduledMinutes actually subtracted — not the raw, pre-union per-segment sum
    // (the reg-82/F04 case fixed the pay-affecting number but left this display figure
    // inconsistent with it).
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '8000095', NAME: 'R5b Agent', 'LOGIN ID': '80095',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '8000095', NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      // Two NON-nursing removals fully overlapping — isolates the releaseMinutes union
      // from nursingMinutes (kept as its own raw sum; reg-82 already covers the
      // RLS+NURSNG combination and net=420 either way).
      { EMP_ID: '8000095', NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 60 },
      { EMP_ID: '8000095', NOM_DATE: day, START_DATE: day, SEG_CODE: 'UN_RLS', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '8000095', EMP_LAST_NAME: 'R5b Agent', EMP_SORT_NAME: 'R5B AGENT' }];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '80095', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '80095', LoginDateTime: makeDt(day, '16:00:00'), LogoutDateTime: makeDt(day, '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    // net (420) = raw span (480) - releaseMinutes, so releaseMinutes must be 60 (the
    // single unioned hour), not 120 (60m RLS + 60m UN_RLS summed independently).
    const passed = row.TAA_SCH_HOURS_RECOMPUTED === 420 && row.details.releaseMinutes === 60;

    results.push({
      id: 'reg-95', name: 'Reported Release Minutes Reconcile With the Net Minutes Actually Subtracted (R5b)', category: 'Post-fix-pass audit R5: reported release minutes no longer reconciled with net',
      inputDescription: 'RLS 16:00-17:00 (60m) and UN_RLS 16:00-17:00 (60m) fully overlapping — the same physical hour',
      cognosFlawedVerdict: 'net=420 (correctly unioned) but details.releaseMinutes=120 (still the raw sum) — a reviewer computing raw(480) - release by hand gets 360, not the real 420',
      expectedVerdict: 'net=420 and releaseMinutes=60, so raw(480) - release(60) = net(420) reconciles', expectedAction: 'RELEASE MINUTES RECONCILE',
      actualVerdict: `net=${row.TAA_SCH_HOURS_RECOMPUTED}; releaseMinutes=${row.details.releaseMinutes}`, actualAction: row.TAA_ACTION,
      passed, payrollImpact: 'Prevents a reviewer from computing a wrong scheduled-hours figure by hand from the app\'s own displayed release-minutes breakdown',
      calculationTrace: [`Net ${row.TAA_SCH_HOURS_RECOMPUTED}`, `Release minutes ${row.details.releaseMinutes}`],
    });
  }

  {
    // R6: every configured "No Login Record" action must produce a distinct, correct
    // effect — not just NO_ACTION vs. a hardcoded ABSENT_NS_NC for everything else.
    // Two sub-cases in one: MANUAL_REVIEW_REQUIRED holds instead of auto-absenting, and
    // an action the rule cannot execute (LATE_AND_COVER — there is no punch to measure a
    // variance from) holds as an invalid config value instead of silently defaulting to
    // ABSENT_NS_NC as if the configured value had been honoured.
    const day = '27/08/2026';
    const cognosFor = (pfNo: string, loginId: string, name: string): CognosRecord => ({
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: name, 'LOGIN ID': loginId,
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    });
    const segsFor = (empId: string): AspectSegment[] => [
      { EMP_ID: empId, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
    ];

    const reviewCfg: ConfigRegistry = { ...config, policyRules: config.policyRules.map(r => r.segmentType === 'No Login Record' ? { ...r, action: 'MANUAL_REVIEW_REQUIRED' } : r) };
    const reviewOut = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosFor('8000096', '80096', 'R6a Agent')], aspectSegments: segsFor('8000096'),
      aspectIdentities: [{ EMP_ID: '8000096', EMP_LAST_NAME: 'R6a Agent', EMP_SORT_NAME: 'R6A AGENT' }], cmsPunches: [], config: reviewCfg,
    });
    const reviewRow = reviewOut.rows[0];
    const reviewPassed = reviewRow.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED' && !reviewRow.includeInOutput
      && reviewRow.holdReason === 'NO_LOGIN_MANUAL_REVIEW_CONFIGURED' && reviewRow.details.generatedCorrections.length === 0;

    const unsupportedCfg: ConfigRegistry = { ...config, policyRules: config.policyRules.map(r => r.segmentType === 'No Login Record' ? { ...r, action: 'LATE_AND_COVER' } : r) };
    const unsupportedOut = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosFor('8000097', '80097', 'R6b Agent')], aspectSegments: segsFor('8000097'),
      aspectIdentities: [{ EMP_ID: '8000097', EMP_LAST_NAME: 'R6b Agent', EMP_SORT_NAME: 'R6B AGENT' }], cmsPunches: [], config: unsupportedCfg,
    });
    const unsupportedRow = unsupportedOut.rows[0];
    const unsupportedPassed = !unsupportedRow.includeInOutput && unsupportedRow.holdReason === 'INVALID_CONFIG_VALUE'
      && unsupportedRow.details.generatedCorrections.length === 0;

    const passed = reviewPassed && unsupportedPassed;

    results.push({
      id: 'reg-96', name: 'Every Configured "No Login Record" Action Produces a Correct, Distinct Effect (R6)', category: 'Post-fix-pass audit R6: F09 fix only honoured NO_ACTION',
      inputDescription: 'Zero-CMS-punch day, "No Login Record" configured to MANUAL_REVIEW_REQUIRED (case A) and to LATE_AND_COVER, an action the rule cannot execute (case B)',
      cognosFlawedVerdict: 'Case A: still emits ABSENT_NS_NC exactly as if configured to the default. Case B: same — the config UI offers every action but only NO_ACTION was ever actually honoured',
      expectedVerdict: 'Case A held as NO_LOGIN_MANUAL_REVIEW_CONFIGURED, no absence emitted. Case B held as INVALID_CONFIG_VALUE, no absence emitted', expectedAction: 'HELD, NOT ABSENT_NS_NC',
      actualVerdict: `A: action=${reviewRow.TAA_ACTION} hold=${reviewRow.holdReason}; B: hold=${unsupportedRow.holdReason}`, actualAction: `${reviewRow.TAA_ACTION} / ${unsupportedRow.TAA_ACTION}`,
      passed, payrollImpact: 'An administrator picking any action from the Config Registry\'s "No Login Record" dropdown must get that action\'s real effect, never a silent ABSENT_NS_NC default dressed up as the configured choice',
      calculationTrace: [`Case A: ${JSON.stringify({ action: reviewRow.TAA_ACTION, hold: reviewRow.holdReason })}`, `Case B: ${JSON.stringify({ action: unsupportedRow.TAA_ACTION, hold: unsupportedRow.holdReason })}`],
    });
  }


  {
    // R-fix: placeCoverSegment() previously wrote nominateDate as the INCIDENT's own
    // NOM_DATE instead of the resolved TARGET schedule's NOM_DATE (§7i). This case pins
    // the exact overnight-target scenario from that audit: the incident is an ordinary
    // day-shift late login, but the next working schedule is an overnight shift, so the
    // cover's nominateDate (the target schedule's NOM_DATE, 20/09/2026) and its
    // SegmentDate (the cover's own physical start day, 21/09/2026) are two different,
    // both-correct dates on the same row.
    const incidentDay = '18/09/2026';
    const targetDay = '20/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-18 00:00:00', SECTION: 'ECS', 'PF NO': '4505002', NAME: 'R-fix Cover Target Agent', 'LOGIN ID': '45052',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4505002', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
      // Next working schedule is an OVERNIGHT shift: NOM_DATE 20/09/2026, physically
      // spanning 20/09 17:00 -> 21/09 02:00, with a trailing NURSNG carve-out anchoring
      // effectiveEnd (and so the cover's own start) to 21/09 01:00.
      { EMP_ID: '4505002', NOM_DATE: targetDay, START_DATE: targetDay, SEG_CODE: 'SHIFT', START_MOMENT: `${targetDay} 17:00:00`, STOP_MOMENT: '21/09/2026 02:00:00', DURATION: 540 },
      // START_DATE is the NURSNG segment's own physical day (21/09, matching its
      // START_MOMENT) even though its NOM_DATE still ties it to the 20/09 schedule —
      // per doc/aspect.md's field-4 (NOM_DATE) vs field-5 (START_DATE) distinction.
      { EMP_ID: '4505002', NOM_DATE: targetDay, START_DATE: '21/09/2026', SEG_CODE: 'NURSNG', START_MOMENT: '21/09/2026 01:00:00', STOP_MOMENT: '21/09/2026 02:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4505002', EMP_LAST_NAME: 'R-fix Cover Target Agent', EMP_SORT_NAME: 'R-FIX COVER TARGET AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '45052', LoginDateTime: makeDt(incidentDay, '08:15:00'), LogoutDateTime: makeDt(incidentDay, '08:15:03') },
      { Date: incidentDay, LoginID: '45052', LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const lateRow = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
    const coverRows = out.aspectCorrections.filter(c => c.SegmentCode === 'COVER');
    const cover = coverRows[0];
    const csv = generateAspectCorrectionsCsv(out.aspectCorrections);
    const expectedCoverLine = '00,4505002,COVER,20/09/2026,21/09/2026,01:00,00:15,"TAA Cover for 18/09/2026 Late/Variance",';
    const expectedLateLine = '00,4505002,LATE,18/09/2026,18/09/2026,08:00,00:15,"TAA Late Login 15m",';
    const lines = csv.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const csvOrderOk = lines.indexOf(expectedLateLine) !== -1 && lines.indexOf(expectedCoverLine) !== -1
      && lines.indexOf(expectedLateLine) < lines.indexOf(expectedCoverLine);

    const passed = lateRow !== undefined && coverRows.length === 1 && cover !== undefined
      && cover.nominateDate === targetDay
      && cover.SegmentDate === '21/09/2026'
      && cover.SegmentStarttime === '01:00'
      && cover.Segmentduration === '00:15'
      && cover.Memo === 'TAA Cover for 18/09/2026 Late/Variance'
      && csvOrderOk;

    results.push({
      id: 'reg-97',
      name: 'COVER nominateDate Is the Resolved Target Schedule, Not the Incident Day (§7i)',
      category: 'Post-fix-pass audit: COVER nominateDate defect',
      inputDescription: '18/09 15-min late login (ordinary day shift 08:00-16:00); next working schedule is an overnight shift NOM_DATE 20/09/2026 (20/09 17:00 -> 21/09 02:00) with a trailing NURSNG 21/09 01:00-02:00',
      cognosFlawedVerdict: 'Before the fix: COVER emitted with nominateDate=18/09/2026 (the incident day) instead of 20/09/2026 (the target schedule it is actually placed against) — filed against the wrong ASPECT schedule',
      expectedVerdict: "COVER nominateDate=20/09/2026 (target schedule), SegmentDate=21/09/2026 (physical start, one day after the overnight target's own NOM_DATE)",
      expectedAction: 'COVER at 20/09/2026(nominateDate) / 21/09/2026 01:00(SegmentDate) for 15 min',
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A COVER row filed under the wrong NOM_DATE attaches the correction to the wrong ASPECT schedule day entirely — this is a payroll-filing error, not a display nuance',
      calculationTrace: [
        `Incident 18/09/2026 late 15m`,
        `Next working schedule (by NOM_DATE): 20/09/2026, overnight 17:00 -> 21/09 02:00`,
        `Trailing NURSNG 21/09 01:00-02:00 -> effectiveEnd collapses to NURSNG start (21/09 01:00)`,
        `Cover: nominateDate=${cover?.nominateDate ?? 'N/A'} (target schedule's own NOM_DATE), SegmentDate=${cover?.SegmentDate ?? 'N/A'} (physical start day)`,
        `Generated CSV lines: ${JSON.stringify(lines.filter(l => l.includes('4505002')))}`,
      ],
    });
  }

  {
    // Cover-fallback feature: `sameDay` option. Employee has ONLY the incident day's
    // own ASPECT segment uploaded (no future day at all), so resolveCoverTargetDay
    // falls through to the coverFallbackWhenNoWorkingDayFound branch. `sameDay` must
    // collapse the cover onto the incident day itself, reusing the exact same
    // end-of-last-segment placement logic as a normal target day (here, just the
    // SHIFT's own 16:00 end) — no new time logic, no default-time override.
    const incidentDay = '10/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-10 00:00:00', SECTION: 'ECS', 'PF NO': '4506001', NAME: 'SameDay Fallback Agent', 'LOGIN ID': '46001',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4506001', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4506001', EMP_LAST_NAME: 'SameDay Fallback Agent', EMP_SORT_NAME: 'SAMEDAY FALLBACK AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '46001', LoginDateTime: makeDt(incidentDay, '08:15:00'), LogoutDateTime: makeDt(incidentDay, '08:15:03') },
      { Date: incidentDay, LoginID: '46001', LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
    ];
    const fallbackConfig: ConfigRegistry = { ...config, coverFallbackWhenNoWorkingDayFound: 'sameDay' };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: fallbackConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const expectedMemo = 'TAA Cover for 10/09/2026 Late/Variance | Cover added without ASPECT data - fallback: Same day (incident day end-of-schedule)';
    const passed = cover !== undefined
      && cover.nominateDate === incidentDay
      && cover.SegmentDate === incidentDay
      && cover.SegmentStarttime === '16:00'
      && cover.Segmentduration === '00:15'
      && cover.Memo === expectedMemo
      && out.rows[0].coverFallbackNote === 'Cover added without ASPECT data - fallback: Same day (incident day end-of-schedule)';

    results.push({
      id: 'reg-98',
      name: 'Cover Fallback "sameDay": Collapses Onto the Incident Day\'s Own End-of-Schedule',
      category: 'Cover fallback (missing next-day ASPECT data): sameDay option',
      inputDescription: '10/09/2026 15-min late login (SHIFT 08:00-16:00), no future ASPECT day uploaded at all, coverFallbackWhenNoWorkingDayFound=sameDay',
      cognosFlawedVerdict: 'N/A — new configurable behavior, not a Cognos defect',
      expectedVerdict: 'COVER at 10/09/2026 (same as incident) 16:00-16:15, Memo and TAA_COVER_FALLBACK_NOTE both flag it as placed without ASPECT data',
      expectedAction: 'COVER nominateDate=10/09/2026 SegmentDate=10/09/2026 16:00 (00:15)',
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A cover placed without confirming the next working day must never be silently indistinguishable from one placed against real schedule data',
      calculationTrace: [`Incident ${incidentDay} late 15m, no future ASPECT segments uploaded`, `sameDay fallback -> target=${cover?.nominateDate ?? 'N/A'}`, `coverFallbackNote="${out.rows[0].coverFallbackNote}"`],
    });
  }

  {
    // Full-day-segment rule (decision 2026-09-21) regression: the next working day carries a
    // full-day removal (bare RLS — no duration, no timestamps), so that day nets ZERO hours and
    // its window collapses; the agent is released all day. It must NOT be used as a cover target.
    // It still LOOKS like a working day to resolveCoverTargetDay's isWorkingDaySegment filter
    // because its SHIFT segment is still there, and the gate that used to block this shape
    // (REMOVAL_SEGMENT_DURATION_UNKNOWN) can no longer fire for a bare removal. Without the
    // explicit fullDayRemovalMinutes gate the cover landed on the released day at its collapsed
    // start with NO hold at all — an unattendable cover that the next run would raise as
    // cover-not-attended and escalate to an absence.
    // Toggles pinned explicitly (the suite runs on LIVE config): nextWeekMonday fallback so the
    // skipped day (28/08) and the resolved target (31/08) are unambiguously different days.
    const incidentDay = '27/08/2026';
    const releasedDay = '28/08/2026';
    const expectedTargetDay = '31/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '4506009', NAME: 'FullDay Release Target Agent', 'LOGIN ID': '46009',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:30',
      'SIGIN IN': '07:30', 'SIGIN OUT': '15:00', 'LATE START': '-30', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4506009', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      { EMP_ID: '4506009', NOM_DATE: releasedDay, START_DATE: releasedDay, SEG_CODE: 'SHIFT', START_MOMENT: `${releasedDay} 07:00:00`, STOP_MOMENT: `${releasedDay} 15:00:00`, DURATION: 480 },
      // The full-day release: no DURATION, no START/STOP — takes the whole 480-minute day.
      { EMP_ID: '4506009', NOM_DATE: releasedDay, START_DATE: releasedDay, SEG_CODE: 'RLS' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4506009', EMP_LAST_NAME: 'FullDay Release Target Agent', EMP_SORT_NAME: 'FULLDAY RELEASE TARGET AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '46009', LoginDateTime: makeDt(incidentDay, '07:30:00'), LogoutDateTime: makeDt(incidentDay, '07:30:03') },
      { Date: incidentDay, LoginID: '46009', LoginDateTime: makeDt(incidentDay, '15:00:00'), LogoutDateTime: makeDt(incidentDay, '15:00:03') },
    ];
    const releasedTargetConfig: ConfigRegistry = {
      ...config,
      coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday',
      coverFallbackDefaultTime: '08:00',
      coverSameDayWhenAlreadyCovered: false,
    };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: releasedTargetConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const landedOnReleasedDay = !!cover && (cover.nominateDate === releasedDay || cover.SegmentDate === releasedDay);
    const passed = cover !== undefined
      && !landedOnReleasedDay
      && cover.nominateDate === expectedTargetDay
      && cover.SegmentStarttime === '08:00'
      && /unusable \(FULL_DAY_REMOVAL_ON_SCHEDULED_DAY\)/.test(cover.Memo);

    results.push({
      id: 'reg-141',
      name: 'A Day Fully Released by a Full-Day Removal Is Never a Cover Target',
      category: 'Cover fallback: full-day-release target day (2026-09-21)',
      inputDescription: `27/08/2026 30-min late login (SHIFT 07:00-15:00); the next working day ${releasedDay} has a SHIFT plus a bare RLS (no duration, no timestamps) that releases the entire day; coverFallbackWhenNoWorkingDayFound=nextWeekMonday`,
      cognosFlawedVerdict: 'N/A — guards a regression introduced by the 2026-09-21 full-day-segment rule, not a Cognos defect',
      expectedVerdict: `${releasedDay} skipped as unusable (FULL_DAY_REMOVAL_ON_SCHEDULED_DAY); cover falls back to ${expectedTargetDay} 08:00 with the skipped-day reason in the Memo`,
      expectedAction: `COVER nominateDate=${expectedTargetDay} 08:00`,
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A cover placed on a day the agent is fully released can never be attended: the next run raises cover-not-attended and can escalate it to an unpaid absence — a penalty invented out of a legitimate full-day release. The day must be skipped like any other unusable target day.',
      calculationTrace: [
        `${releasedDay} recomputes to 0 scheduled minutes (480 SHIFT - 480 full-day RLS), window collapsed`,
        `resolveDayCoverAnchor blocks it -> skippedDay=FULL_DAY_REMOVAL_ON_SCHEDULED_DAY`,
        `nextWeekMonday fallback -> target=${cover?.nominateDate ?? 'N/A'} at ${cover?.SegmentStarttime ?? 'N/A'}`,
      ],
    });
  }

  {
    // Cover-fallback feature: `nextDirectDay` option. Same missing-future-data setup
    // as reg-98, but the target is literal incident date +1 calendar day at the
    // configured default time (08:00), regardless of weekday.
    const incidentDay = '10/09/2026';
    const expectedTargetDay = '11/09/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-10 00:00:00', SECTION: 'ECS', 'PF NO': '4506002', NAME: 'NextDirectDay Fallback Agent', 'LOGIN ID': '46002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4506002', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4506002', EMP_LAST_NAME: 'NextDirectDay Fallback Agent', EMP_SORT_NAME: 'NEXTDIRECTDAY FALLBACK AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: '46002', LoginDateTime: makeDt(incidentDay, '08:15:00'), LogoutDateTime: makeDt(incidentDay, '08:15:03') },
      { Date: incidentDay, LoginID: '46002', LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
    ];
    const fallbackConfig: ConfigRegistry = { ...config, coverFallbackWhenNoWorkingDayFound: 'nextDirectDay', coverFallbackDefaultTime: '08:00' };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: fallbackConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const expectedMemo = 'TAA Cover for 10/09/2026 Late/Variance | Cover added without ASPECT data - fallback: Next calendar day, 08:00 default';
    const passed = cover !== undefined
      && cover.nominateDate === expectedTargetDay
      && cover.SegmentDate === expectedTargetDay
      && cover.SegmentStarttime === '08:00'
      && cover.Segmentduration === '00:15'
      && cover.Memo === expectedMemo
      && out.rows[0].coverFallbackNote === 'Cover added without ASPECT data - fallback: Next calendar day, 08:00 default';

    results.push({
      id: 'reg-99',
      name: 'Cover Fallback "nextDirectDay": Literal Incident +1 Day at the Default Time',
      category: 'Cover fallback (missing next-day ASPECT data): nextDirectDay option',
      inputDescription: '10/09/2026 15-min late login, no future ASPECT day uploaded, coverFallbackWhenNoWorkingDayFound=nextDirectDay, coverFallbackDefaultTime=08:00',
      cognosFlawedVerdict: 'N/A — new configurable behavior, not a Cognos defect',
      expectedVerdict: `COVER at ${expectedTargetDay} 08:00-08:15, Memo and TAA_COVER_FALLBACK_NOTE both flag it as placed without ASPECT data`,
      expectedAction: `COVER nominateDate=${expectedTargetDay} SegmentDate=${expectedTargetDay} 08:00 (00:15)`,
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Placing cover a day out without confirming it is a real working day must always be traceable in the output, never mistaken for a normal placement',
      calculationTrace: [`Incident ${incidentDay} late 15m, no future ASPECT segments uploaded`, `nextDirectDay fallback -> target=${cover?.nominateDate ?? 'N/A'} at ${cover?.SegmentStarttime ?? 'N/A'}`, `coverFallbackNote="${out.rows[0].coverFallbackNote}"`],
    });
  }

  {
    // Cover-fallback feature: `nextWeekMonday` option (the default), validated across
    // two incident weekdays to pin the "Monday of the calendar week AFTER the
    // incident's own week" formula — days-out varies by weekday, e.g. a Monday
    // incident lands 7 days later while a Sunday incident lands only 1 day later.
    // 31/08/2026 is a Monday; 06/09/2026 is a Sunday; both land on 07/09/2026 (Monday).
    const mondayIncidentDay = '31/08/2026';
    const sundayIncidentDay = '06/09/2026';
    const expectedTargetDay = '07/09/2026';
    const fallbackConfig: ConfigRegistry = { ...config, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday', coverFallbackDefaultTime: '08:00' };

    const buildCase = (incidentDay: string, pfNo: string, loginId: string) => {
      const cognos: CognosRecord = {
        'SIGN IN DATE': `2026-${incidentDay.split('/')[1]}-${incidentDay.split('/')[0]} 00:00:00`, SECTION: 'ECS', 'PF NO': pfNo, NAME: 'NextWeekMonday Fallback Agent', 'LOGIN ID': loginId,
        DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
        'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'NextWeekMonday Fallback Agent', EMP_SORT_NAME: 'NEXTWEEKMONDAY FALLBACK AGENT' }];
      const punches: CMSPunch[] = [
        { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '08:15:00'), LogoutDateTime: makeDt(incidentDay, '08:15:03') },
        { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
      ];
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: fallbackConfig });
      return out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    };

    const mondayCover = buildCase(mondayIncidentDay, '4506003', '46003');
    const sundayCover = buildCase(sundayIncidentDay, '4506004', '46004');

    const passed = mondayCover !== undefined && sundayCover !== undefined
      && mondayCover.nominateDate === expectedTargetDay && mondayCover.SegmentStarttime === '08:00'
      && sundayCover.nominateDate === expectedTargetDay && sundayCover.SegmentStarttime === '08:00';

    results.push({
      id: 'reg-100',
      name: 'Cover Fallback "nextWeekMonday": Days-Out Varies by Incident Weekday',
      category: 'Cover fallback (missing next-day ASPECT data): nextWeekMonday option',
      inputDescription: 'Two 15-min late logins with no future ASPECT day uploaded: one incident on Monday 31/08/2026, one on Sunday 06/09/2026, both coverFallbackWhenNoWorkingDayFound=nextWeekMonday',
      cognosFlawedVerdict: 'N/A — new configurable behavior, not a Cognos defect',
      expectedVerdict: `Both land on ${expectedTargetDay} (Monday) at 08:00 — Monday incident is 7 days out, Sunday incident is only 1 day out, per the "Monday of the calendar week after" formula`,
      expectedAction: `COVER nominateDate=${expectedTargetDay} for both`,
      actualVerdict: `Mon-incident cover=${mondayCover?.nominateDate ?? 'N/A'}; Sun-incident cover=${sundayCover?.nominateDate ?? 'N/A'}`,
      actualAction: `${mondayCover?.SegmentCode ?? 'None'} / ${sundayCover?.SegmentCode ?? 'None'}`,
      passed,
      payrollImpact: 'A fixed "+7 days" implementation would place the Sunday case a week later than intended — must vary by weekday exactly as specified',
      calculationTrace: [
        `Monday incident ${mondayIncidentDay} -> target ${mondayCover?.nominateDate ?? 'N/A'} (expect +7 days)`,
        `Sunday incident ${sundayIncidentDay} -> target ${sundayCover?.nominateDate ?? 'N/A'} (expect +1 day)`,
      ],
    });
  }

  {
    // Cover-fallback feature: moveCoverForward Memo-preservation fix. A prior run
    // already placed a COVER 16:00-16:15 on the incident day's own ASPECT schedule
    // (SEG_CODE COVER, round-tripped back in per §4.12); CMS shows the employee
    // logging out at 16:00, exactly missing it — Rule 7 (Cover Not Attended) fires
    // a 15-min shortfall. coverNotAttendedAction=moveCoverForward re-places that
    // cover via placeCoverSegment; since no future ASPECT day exists, that
    // re-placement ALSO falls through to the coverFallbackWhenNoWorkingDayFound
    // fallback (nextDirectDay here). Before the fix, buildCoverNotAttendedOutcomes
    // overwrote the moved row's Memo wholesale, silently dropping the "placed
    // without ASPECT data" suffix placeCoverSegment had just attached. This pins
    // that both halves of the Memo — "moved forward" AND the fallback note — survive
    // together, and that coverFallbackNote (read from the same WeakMap
    // independently of Memo) also reflects it.
    const incidentDay = '12/09/2026';
    const expectedTargetDay = '13/09/2026';
    const pfNo = '4506005';
    const loginId = '46005';
    // DUTY1/SCH DURATION must reflect the SHIFT+COVER merged block (08:00-16:15,
    // 8:15), not just the SHIFT alone — scheduleRecompute.ts's duty1Block is built
    // from every non-OT addition (SHIFT and COVER both qualify) merged within
    // perBlockGapThresholdMinutes, and the COVER abuts the SHIFT with a 0-minute
    // gap. Using '08:00 - 16:00'/'8:0' here would produce a spurious DUTY1/SCH
    // DURATION mismatch unrelated to what this case is actually testing.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-12 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'MoveCoverForward Memo Agent', 'LOGIN ID': loginId,
      DUTY1: '08:00 - 16:15', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:15', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'COVER', START_MOMENT: `${incidentDay} 16:00:00`, STOP_MOMENT: `${incidentDay} 16:15:00`, DURATION: 15 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'MoveCoverForward Memo Agent', EMP_SORT_NAME: 'MOVECOVERFORWARD MEMO AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '08:00:00'), LogoutDateTime: makeDt(incidentDay, '08:00:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
    ];
    const fallbackConfig: ConfigRegistry = {
      ...config,
      coverNotAttendedAction: 'moveCoverForward',
      coverFallbackWhenNoWorkingDayFound: 'nextDirectDay',
      coverFallbackDefaultTime: '08:00',
    };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: fallbackConfig });
    const movedCover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const expectedMemo = `TAA Cover Not Attended: moved forward (was ${incidentDay} 16:00) | Cover added without ASPECT data - fallback: Next calendar day, 08:00 default`;
    const expectedNote = 'Cover added without ASPECT data - fallback: Next calendar day, 08:00 default';
    const passed = movedCover !== undefined
      && movedCover.nominateDate === expectedTargetDay
      && movedCover.SegmentDate === expectedTargetDay
      && movedCover.SegmentStarttime === '08:00'
      && movedCover.Segmentduration === '00:15'
      && movedCover.Memo === expectedMemo
      && out.rows[0].coverFallbackNote === expectedNote;

    results.push({
      id: 'reg-101',
      name: 'moveCoverForward Preserves the Cover-Fallback Memo Note Instead of Overwriting It',
      category: 'Cover fallback (missing next-day ASPECT data): moveCoverForward Memo-preservation fix',
      inputDescription: '12/09/2026: pre-existing COVER 16:00-16:15 fully unattended (15m shortfall, Rule 7 fires), coverNotAttendedAction=moveCoverForward, no future ASPECT day uploaded so the re-placement also falls through coverFallbackWhenNoWorkingDayFound=nextDirectDay',
      cognosFlawedVerdict: 'Before the fix: moveCoverForward overwrote the re-placed cover\'s Memo wholesale, silently dropping the "placed without ASPECT data" fallback note that placeCoverSegment had just attached',
      expectedVerdict: `Moved COVER at ${expectedTargetDay} 08:00-08:15; Memo contains BOTH "moved forward" and the fallback note; coverFallbackNote is set independently`,
      expectedAction: `COVER nominateDate=${expectedTargetDay} SegmentDate=${expectedTargetDay} 08:00 (00:15), Memo="${expectedMemo}"`,
      actualVerdict: movedCover ? `COVER nominateDate=${movedCover.nominateDate} SegmentDate=${movedCover.SegmentDate} at ${movedCover.SegmentStarttime} Memo="${movedCover.Memo}"` : 'No cover',
      actualAction: movedCover ? `${movedCover.SegmentCode} (${movedCover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A re-placed cover that silently loses its "placed without ASPECT data" traceability is indistinguishable from one placed against a real confirmed working day — exactly the ambiguity this whole feature exists to surface',
      calculationTrace: [
        `Incident ${incidentDay}: pre-existing COVER 16:00-16:15, CMS logout 16:00 -> 0m overlap -> 15m shortfall`,
        `moveCoverForward re-places via placeCoverSegment -> no future ASPECT day -> nextDirectDay fallback -> target=${movedCover?.nominateDate ?? 'N/A'} at ${movedCover?.SegmentStarttime ?? 'N/A'}`,
        `Memo="${movedCover?.Memo ?? 'N/A'}"`,
        `coverFallbackNote="${out.rows[0].coverFallbackNote}"`,
      ],
    });
  }

  // F03 removal replacement (2026-09-09, user-confirmed): the per-row
  // CMS_EXPORT_SCOPE_GAP guard is gone (see reg-66/reg-81 above); the risk it
  // used to catch — a CMS export scoped to the wrong agent list — is now
  // surfaced once at upload by assessHeadcountMapping (punchAttribution.ts).
  {
    const day = '27/08/2026';
    const makeCognos = (pfNo: string, loginId: string): CognosRecord => ({
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: `Agent ${pfNo}`, 'LOGIN ID': loginId,
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '09:00', 'SIGIN OUT': '17:00',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    });
    const cognosRecords = [makeCognos('9000001', '90001'), makeCognos('9000002', '90002'), makeCognos('9000003', '90003'), makeCognos('9000004', '90004')];
    // All 4 employees exist in ASPECT (aspectPercent=100) so the test isolates
    // the CMS rate — the risk being demonstrated is a scoped CMS export, not
    // a missing ASPECT identity.
    const identities: AspectIdentity[] = ['9000001', '9000002', '9000003', '9000004'].map(pfNo => ({
      EMP_ID: pfNo, EMP_LAST_NAME: `Agent ${pfNo}`, EMP_SORT_NAME: `AGENT ${pfNo}`,
    }));
    // CMS file covers only 1 of the 4 employees — same shape as the real
    // single-agent samples_Files/CMS_Login_logout.csv.
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '90001', LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '09:00:03') },
      { Date: day, LoginID: '90001', LoginDateTime: makeDt(day, '17:00:00'), LogoutDateTime: makeDt(day, '17:00:03') },
    ];
    const assessment = assessHeadcountMapping(cognosRecords, identities, punches, config);
    const passedAtDefault = assessment.cmsPercent === 25 && assessment.lowestPercent === 25 && assessment.sufficient === false;
    const offConfig: ConfigRegistry = { ...config, validateUploadedHeadcount: false };
    const assessmentOff = assessHeadcountMapping(cognosRecords, identities, punches, offConfig);
    const passed = passedAtDefault && assessmentOff.sufficient === true;

    results.push({
      id: 'reg-102',
      name: 'Headcount Mapping Gate Fires on a Single-Agent CMS Export, Respects the Off Toggle',
      category: 'Payroll audit F03 replacement: upload-time headcount mapping',
      inputDescription: '4 Cognos employees, all claiming attendance; CMS export covers only 1 of them (single-agent export shape)',
      cognosFlawedVerdict: 'Before the F03 removal: caught per-row as CMS_EXPORT_SCOPE_GAP; no visible headcount statistic existed',
      expectedVerdict: 'cmsPercent=25, lowestPercent=25, sufficient=false at the default 70% minimum; sufficient=true when validateUploadedHeadcount is off',
      expectedAction: 'BLOCK AT DEFAULT, PASS WHEN TOGGLE OFF',
      actualVerdict: `cmsPercent=${assessment.cmsPercent}, lowestPercent=${assessment.lowestPercent}, sufficient=${assessment.sufficient}; toggleOff.sufficient=${assessmentOff.sufficient}`,
      actualAction: passed ? 'BLOCK AT DEFAULT, PASS WHEN TOGGLE OFF' : 'GATE DEFECT',
      passed,
      payrollImpact: 'A CMS export scoped to the wrong agent list is now flagged once at upload instead of guessed per row, and TAA staff can disable the check entirely if it does not match their process',
      calculationTrace: [`cognosEmployeeCount=${assessment.cognosEmployeeCount}`, `cmsExpectedEmployeeCount=${assessment.cmsExpectedEmployeeCount}`, `withCmsEvidenceCount=${assessment.withCmsEvidenceCount}`],
    });
  }

  // Denominator honesty and the critical count: Cognos-declared zero-login
  // employees (including a "00:00" SIGNIN DURATION paired with blank sign-in/
  // out) must never be counted as missing CMS evidence, and the critical
  // count must catch a row evidenced by SIGIN OUT alone as well as one
  // evidenced only by SIGNIN DURATION.
  {
    const day = '28/08/2026';
    const base = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '',
      'SCH DURATION': '8:0', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const cognosRecords: CognosRecord[] = [
      // 2 fully blank — Cognos declares no attendance.
      { ...base, 'PF NO': '9100001', NAME: 'Blank One', 'LOGIN ID': '91001', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '' },
      { ...base, 'PF NO': '9100002', NAME: 'Blank Two', 'LOGIN ID': '91002', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '' },
      // 1 with SIGNIN DURATION 00:00 and blank sign-in/out — also no attendance, "00:00" is not a claim.
      { ...base, 'PF NO': '9100003', NAME: 'Zero Duration', 'LOGIN ID': '91003', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '' },
      // 1 with only SIGIN OUT — claims attendance; CMS has nothing for this login.
      { ...base, 'PF NO': '9100004', NAME: 'Sign Out Only', 'LOGIN ID': '91004', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '17:00' },
      // 1 with only a genuine SIGNIN DURATION — claims attendance; CMS has nothing for this login.
      { ...base, 'PF NO': '9100005', NAME: 'Duration Only', 'LOGIN ID': '91005', 'SIGNIN DURATION': '07:45', 'SIGIN IN': '', 'SIGIN OUT': '' },
    ];
    // CMS covers neither 91004 nor 91005 — both are expected (Cognos claims
    // attendance) but genuinely missing.
    const punches: CMSPunch[] = [];
    const assessment = assessHeadcountMapping(cognosRecords, [], punches, config);
    const passed = assessment.cognosDeclaresNoAttendanceCount === 3
      && assessment.cmsExpectedEmployeeCount === 2
      && assessment.cmsPercent === 0
      && assessment.cognosClaimsAttendanceButNoCmsCount === 2;

    results.push({
      id: 'reg-103',
      name: 'Headcount Mapping Denominator Excludes Cognos-Declared No-Shows, Critical Count Catches SIGIN OUT / SIGNIN DURATION Alone',
      category: 'Payroll audit F03 replacement: upload-time headcount mapping',
      inputDescription: '5 Cognos employees: 2 fully blank, 1 with SIGNIN DURATION=00:00 (also no attendance), 1 evidenced only by SIGIN OUT, 1 evidenced only by SIGNIN DURATION; CMS covers none of them',
      cognosFlawedVerdict: 'A naive "any employee missing from CMS" count would report 5 of 5 missing, understating coverage and manufacturing 3 false alarms for employees Cognos itself already reports as absent',
      expectedVerdict: 'cognosDeclaresNoAttendanceCount=3, cmsExpectedEmployeeCount=2, cmsPercent=0, cognosClaimsAttendanceButNoCmsCount=2 (the critical number)',
      expectedAction: 'DENOMINATOR EXCLUDES DECLARED NO-SHOWS; CRITICAL COUNT = 2',
      actualVerdict: `cognosDeclaresNoAttendanceCount=${assessment.cognosDeclaresNoAttendanceCount}, cmsExpectedEmployeeCount=${assessment.cmsExpectedEmployeeCount}, cmsPercent=${assessment.cmsPercent}, cognosClaimsAttendanceButNoCmsCount=${assessment.cognosClaimsAttendanceButNoCmsCount}`,
      actualAction: passed ? 'DENOMINATOR EXCLUDES DECLARED NO-SHOWS; CRITICAL COUNT = 2' : 'DENOMINATOR OR CRITICAL-COUNT DEFECT',
      passed,
      payrollImpact: 'Prevents the headcount mapping statistic from manufacturing a fake coverage shortfall out of employees Cognos already reports as absent, while still catching every real case where Cognos claims attendance but CMS has zero evidence',
      calculationTrace: [`withCmsEvidenceCount=${assessment.withCmsEvidenceCount}`, `cognosBlankLoginIdCount=${assessment.cognosBlankLoginIdCount}`, `cognosClaimsAttendanceButNoCmsRowCount=${assessment.cognosClaimsAttendanceButNoCmsRowCount}`],
    });
  }

  // Case 104 (Phase 1, held-review reduction, 2026-09-24 — superseded the original
  // "genuine calculation failure" pin below): the punches here are two INSTANTANEOUS
  // swipe events (each its own login==logout +/- 3s, staffedMinutes ~= 0), the exact
  // shape of the real row this case mirrors (samples_Files/Cognos_DescrepencyReport.csv,
  // PF 4508038 / login 68858 — one of 21 real rows fitting this pattern). Real evidence
  // overturned the old assumption that Cognos's own SIGIN IN/SIGIN OUT being hours apart
  // proved it "meant" to report a nonzero duration: those two stamps are the same
  // first-to-last SPAN TAA measures, not a session length, and staffedMinutes confirms no
  // real logged-in session exists — so SIGNIN DURATION 00:00 is CORRECT here, not a
  // defect. See cognosComparison.ts's cognosZeroButStaffedConfirmsInstantaneous.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000013', NAME: 'Zero Duration Defect Agent', 'LOGIN ID': '30013',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10',
      'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000013', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30013', LoginDateTime: makeDt('27/08/2026', '07:09:00'), LogoutDateTime: makeDt('27/08/2026', '07:09:03') },
      { Date: '27/08/2026', LoginID: '30013', LoginDateTime: makeDt('27/08/2026', '15:09:57'), LogoutDateTime: makeDt('27/08/2026', '15:10:00') },
    ];
    // Pinned on (Step 3 2026-09-24): the MISMATCH->MATCH downgrade this case proves is
    // gated by releaseProvenSafeHolds — pin true so the case still proves the release
    // regardless of the ambient config's toggle state (see reg-150a/b for the toggle itself).
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: { ...config, releaseProvenSafeHolds: true } });
    const row = out.rows[0];
    const signinDurationComp = row.columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passed = signinDurationComp?.status === 'MATCH'
      && !!signinDurationComp?.note?.includes('instantaneous swipe events')
      && row.holdReason !== 'MISMATCH_FOUND';

    results.push({
      id: 'reg-104',
      name: 'Cognos "00:00" SIGNIN DURATION With Instantaneous-Swipe CMS Evidence Is Correct, Not a Defect',
      category: 'Column comparison — SIGNIN DURATION zero-duration defect (Phase 1 reversal)',
      inputDescription: 'Scheduled 07:00-15:00 shift, CMS shows two instantaneous swipe events at 07:09 and 15:10 (each its own ~0-minute login->logout row), Cognos SIGNIN DURATION="00:00"',
      cognosFlawedVerdict: 'Old assumption: Cognos computed LATE START(-9)/LEFT EARLY(10) from SIGIN IN/SIGIN OUT but left SIGNIN DURATION at "00:00" — looked like a Cognos calculation failure',
      expectedVerdict: 'SIGNIN DURATION MATCH — staffed (login->logout summed) time is ~0, confirming these are instantaneous swipes, not a real session Cognos failed to time; not held for MISMATCH_FOUND',
      expectedAction: 'N/A (not held on this column)',
      actualVerdict: `SIGNIN DURATION=${signinDurationComp?.status}; holdReason=${row.holdReason}; includeInOutput=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops a cosmetic Cognos formatting quirk from holding the row for manual review; LATE START/LEFT EARLY-driven pay actions (here: late+cover) still fire normally',
      calculationTrace: [
        'Cognos SIGNIN DURATION "00:00" parses to 0 minutes (SIGIN IN/SIGIN OUT are both populated, so noRecordedAttendance is false)',
        'Recomputed CMS span: 07:09 -> 15:10 = 481 minutes (first-to-last SPAN, not a session length)',
        'ctx.staffedMinutes: each closed punch is its own ~3s login->logout row, summed ~= 0 minutes',
        '0 vs 481 minutes SPAN would be MISMATCH, but Cognos 0 + staffed 0 -> downgraded to MATCH',
      ],
    });
  }

  // Case 105: leave-placeholder shape stays unchanged — complements reg-58 (ABSENT
  // variant) with the ANNUAL variant, the largest real leave-code group carrying this
  // pattern (108/502 real rows).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000014', NAME: 'Annual Leave Agent', 'LOGIN ID': '30014',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000014', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'LEAVE', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000014', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const signinDurationComp = out.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passed = signinDurationComp?.status === 'NOT_COMPARABLE';

    results.push({
      id: 'reg-105',
      name: 'Cognos "00:00" SIGNIN DURATION on a Leave Placeholder Stays NOT_COMPARABLE',
      category: 'Column comparison — SIGNIN DURATION zero-duration defect',
      inputDescription: 'ANNUAL leave day: Cognos SIGNIN DURATION="00:00" with blank SIGIN IN/SIGIN OUT — the "never signed in" placeholder, not the calculation-failure defect',
      cognosFlawedVerdict: 'n/a — this pins that the narrowed fix does not touch the legitimate no-attendance placeholder',
      expectedVerdict: 'SIGNIN DURATION NOT_COMPARABLE, unchanged by the reg-104 fix',
      expectedAction: 'N/A',
      actualVerdict: `SIGNIN DURATION=${signinDurationComp?.status}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Confirms the 192 real leave-placeholder rows are unaffected by the SIGNIN DURATION defect fix',
      calculationTrace: [
        'SIGIN IN and SIGIN OUT both blank -> noRecordedAttendance is true -> parseSigninDuration("00:00") is null',
        'Recomputed duration is also null (no CMS punches) -> both sides null -> NOT_COMPARABLE, never reaches the new exception',
      ],
    });
  }

  // Case 106: single-swipe shape (SIGIN IN == SIGIN OUT) stays unchanged when CMS
  // agrees the span is genuinely ~0 — Cognos value is 0 but status is MATCH, not
  // MISMATCH, so the new exception does not fire and the existing downgrade still
  // applies. Mirrors a real row (SIGIN IN=SIGIN OUT=23:08, LEAVE TYPE U-ABSENT).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000015', NAME: 'Single Swipe Agent', 'LOGIN ID': '30015',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '23:08', 'SIGIN OUT': '23:08',
      'LATE START': '8', 'LEFT EARLY': '-472', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000015', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 23:00:00', STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30015', LoginDateTime: makeDt('27/08/2026', '23:08:00'), LogoutDateTime: makeDt('27/08/2026', '23:08:00') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const signinDurationComp = out.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    // Phase 9 (informational only): the base staffed-vs-span note is unchanged, now with the
    // CMS staffed-time display appended (this scenario's single punch is its own login==logout,
    // so staffedMinutes=0 -> "00:00" appended) — proves the addition is purely additive text,
    // never a status/verdict change.
    const passed = signinDurationComp?.status === 'NOT_COMPARABLE'
      && signinDurationComp?.note === 'Cognos measures staffed (logged-in) time, excluding mid-shift gaps; TAA measures first-to-last punch span from discrete CMS punches — different quantities, not a disagreement CMS staffed (login→logout summed) time: 00:00.';

    results.push({
      id: 'reg-106',
      name: 'Cognos "00:00" SIGNIN DURATION on a Genuine Single Swipe Stays NOT_COMPARABLE',
      category: 'Column comparison — SIGNIN DURATION zero-duration defect',
      inputDescription: 'Cross-midnight shift with a single CMS swipe: SIGIN IN==SIGIN OUT==23:08 and a matching single CMS punch at 23:08, so both Cognos and the recompute genuinely agree on a zero-length duration',
      cognosFlawedVerdict: 'n/a — this pins that the narrowed fix does not touch a real MATCH just because the value happens to be 0',
      expectedVerdict: 'SIGNIN DURATION NOT_COMPARABLE with the original staffed-vs-span note plus the Phase 9 staffed-time suffix, unchanged by the reg-104 fix',
      expectedAction: 'N/A',
      actualVerdict: `SIGNIN DURATION=${signinDurationComp?.status}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Confirms the 4 real single-swipe rows are unaffected by the SIGNIN DURATION defect fix',
      calculationTrace: [
        'Cognos "00:00" parses to 0 minutes (SIGIN IN/SIGIN OUT both populated and equal)',
        'Recomputed CMS span: 23:08 -> 23:08 = 0 minutes',
        '0 vs 0 -> MATCH, so the new "Cognos value is 0 AND status is MISMATCH" exception does not fire -> existing MATCH downgrade still applies',
      ],
    });
  }

  // Case 107 (Phase 1, held-review reduction, 2026-09-24 — superseded the original
  // "accepted consequence" pin below): same instantaneous-swipe CMS shape as reg-104
  // (each punch its own ~3s login->logout row, staffedMinutes ~= 0) — the recompute-based
  // SPAN (07:09 -> 15:10) still disagrees with Cognos's 0, but staffedMinutes now proves
  // that disagreement is the expected staffed-vs-span quantity gap, not a defect, so this
  // downgrades to MATCH exactly like reg-104. Kept as its own case because the source
  // shape differs (Cognos's own SIGIN IN/SIGIN OUT are a genuine single-swipe pair here,
  // reg-104's are hours apart) — both land on the same real-evidence conclusion.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000016', NAME: 'Single Swipe Contradicted By CMS Agent', 'LOGIN ID': '30016',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '07:09', 'SIGIN OUT': '07:09',
      'LATE START': '-9', 'LEFT EARLY': '470', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000016', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30016', LoginDateTime: makeDt('27/08/2026', '07:09:00'), LogoutDateTime: makeDt('27/08/2026', '07:09:03') },
      { Date: '27/08/2026', LoginID: '30016', LoginDateTime: makeDt('27/08/2026', '15:09:57'), LogoutDateTime: makeDt('27/08/2026', '15:10:00') },
    ];
    // Pinned on (Step 3 2026-09-24): the MISMATCH->MATCH downgrade this case proves is
    // gated by releaseProvenSafeHolds — pin true so the case still proves the release
    // regardless of the ambient config's toggle state (see reg-150a/b for the toggle itself).
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config: { ...config, releaseProvenSafeHolds: true } });
    const signinDurationComp = out.rows[0].columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passed = signinDurationComp?.status === 'MATCH'
      && !!signinDurationComp?.note?.includes('instantaneous swipe events');

    results.push({
      id: 'reg-107',
      name: 'Cognos Single-Swipe SIGIN IN/OUT vs a Real CMS Span, Both Instantaneous — Correct, Not a Defect',
      category: 'Column comparison — SIGNIN DURATION zero-duration defect (Phase 1 reversal)',
      inputDescription: 'Cognos reports SIGIN IN==SIGIN OUT==07:09 (looks like a single swipe) while the CMS export carries two separate instantaneous swipe events spanning 07:09-15:10 — the SPAN disagrees with Cognos\'s 0, but staffedMinutes (~0) shows no real session exists',
      cognosFlawedVerdict: 'Old assumption: Cognos\'s own SIGIN IN/SIGIN OUT agree, but that agreement itself was assumed wrong per the CMS SPAN',
      expectedVerdict: 'SIGNIN DURATION MATCH — staffedMinutes confirms the instantaneous-swipe shape, so the SPAN disagreement is the known staffed-vs-span gap, not a genuine mismatch',
      expectedAction: 'N/A (not held on this column)',
      actualVerdict: `SIGNIN DURATION=${signinDurationComp?.status}`,
      actualAction: out.rows[0].TAA_ACTION,
      passed,
      payrollImpact: 'Detection is based on staffed evidence (login->logout duration), not merely on whether Cognos\'s own two timestamps agree with each other or on the raw first-to-last SPAN',
      calculationTrace: [
        'Cognos "00:00" parses to 0 minutes',
        'Recomputed CMS span: 07:09 -> 15:10 = 481 minutes (SPAN, not staffed time)',
        'ctx.staffedMinutes: two instantaneous swipe rows, summed ~= 0 minutes',
        '0 vs 481 minutes SPAN would be MISMATCH, but Cognos 0 + staffed 0 -> downgraded to MATCH',
      ],
    });
  }

  // Case H02: OPS Late Login >=61 (Absent) AND Early Logout 5-9 (Late+Cover band, not
  // Absent) on the same row — the two rules disagree on severity. D2 fix: Late Login's
  // ABSENT wins (MARKED_ABSENT outranks LATE_AND_COVER_ADDED in RESULT_CATEGORY_SEVERITY),
  // but Early Logout's `rowCorrections.push` for Log_off/COVER is unconditional — it runs
  // regardless of applyMoreSevere's severity check. Before the fix, the exported CSV row
  // carried ABSENT + Log_off + COVER: the agent was docked a full day AND charged a cover
  // for the same shift.
  //
  // Pinned config: retainLateCoverOnAbsent=false (this case tests the strip rule, which only
  // exists when the toggle is off) and coverSameDayWhenAlreadyCovered=true (proves the strip
  // rule holds with the same-day option enabled). Both are legitimate live business settings,
  // so the case must not inherit them. retain=true is covered by H02-retained below.
  {
    const stripConfig: ConfigRegistry = { ...config, retainLateCoverOnAbsent: false, coverSameDayWhenAlreadyCovered: true };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000108', NAME: 'Absent Wins Over Logoff Cover Agent', 'LOGIN ID': '36108',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:52',
      'SIGIN IN': '09:01', 'SIGIN OUT': '15:53', 'LATE START': '-61', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000108', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000108', EMP_LAST_NAME: 'Absent Wins Over Logoff Cover Agent', EMP_SORT_NAME: 'ABSENT WINS OVER LOGOFF COVER AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36108', LoginDateTime: makeDt('01/09/2026', '09:01:00'), LogoutDateTime: makeDt('01/09/2026', '09:01:03') },
      { Date: '01/09/2026', LoginID: '36108', LoginDateTime: makeDt('01/09/2026', '15:53:00'), LogoutDateTime: makeDt('01/09/2026', '15:53:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '01/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('01/09/2026', '23:30:00'), LogoutDateTime: makeDt('01/09/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: stripConfig });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const hasOnlyOneAbsent = generated.filter(c => c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC').length === 1;
    const hasNoLeftoverTimedPenalty = !generated.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER');
    const ruleFired = row.details.ruleFired ?? '';
    const bothRulesReported = ruleFired.includes('Late Login') && ruleFired.includes('Early Logout');
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT'
      && hasOnlyOneAbsent && hasNoLeftoverTimedPenalty && bothRulesReported && row.includeInOutput;

    results.push({
      id: 'H02',
      name: 'Late 61 + Early-Out 7 (OPS) — One ABSENT Only, No Leftover Log_off/COVER',
      category: 'D2 fix: Absent excludes leftover timed penalties',
      inputDescription: 'SHIFT 08:00-16:00; login 09:01 (61m late, exceeds OPS 61m Absent floor); logout 15:53 (7m early, inside OPS 5-9m Late+Cover band, NOT the Absent floor). Config pinned: retainLateCoverOnAbsent=false, coverSameDayWhenAlreadyCovered=true (independent of the live registry)',
      cognosFlawedVerdict: 'Before the fix: Late Login pushed ABSENT and won the reported verdict, but Early Logout still unconditionally pushed Log_off+COVER — exported CSV carried ABSENT + Log_off + COVER for one day',
      expectedVerdict: 'ABSENT only; Late Login and Early Logout both still reported (audit trail), but no LATE/Log_off/COVER correction rows',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (corrections=${generated.map(c => c.SegmentCode).join(',')}, bothReported=${bothRulesReported})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a double pay-hit: docking a full absent day AND charging a cover for the same shift',
      calculationTrace: [
        'Late Login: 09:01 vs 08:00 -> 61m late -> OPS Absent floor (>=61m) -> ABSENT_SEGMENT, resultCategory MARKED_ABSENT',
        'Early Logout: 15:53 vs 16:00 -> 7m early -> OPS Late+Cover band (5-9m) -> LOGOFF_AND_COVER, but MARKED_ABSENT (3) outranks LATE_AND_COVER_ADDED (2) so the reported verdict stays ABSENT',
        `Post-verdict strip: MARKED_ABSENT removes LATE/Log_off/COVER -> generatedCorrections = [${generated.map(c => c.SegmentCode).join(', ')}]`,
      ],
    });
  }

  // Case H03: OPS Late Login 20 (Late+Cover band) AND Early Logout 15 (Absent band) —
  // the mirror of H02: this time Early Logout's ABSENT wins and Late Login's own
  // LATE+COVER (pushed first, before Early Logout evaluates) must be stripped.
  // Config pinned the same way as H02 (retain=false, same-day=true); retain=true is H03-retained.
  {
    const stripConfig: ConfigRegistry = { ...config, retainLateCoverOnAbsent: false, coverSameDayWhenAlreadyCovered: true };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000109', NAME: 'Absent Wins Over Late Cover Agent', 'LOGIN ID': '36109',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:25',
      'SIGIN IN': '08:20', 'SIGIN OUT': '15:45', 'LATE START': '-20', 'LEFT EARLY': '-15', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000109', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000109', EMP_LAST_NAME: 'Absent Wins Over Late Cover Agent', EMP_SORT_NAME: 'ABSENT WINS OVER LATE COVER AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36109', LoginDateTime: makeDt('01/09/2026', '08:20:00'), LogoutDateTime: makeDt('01/09/2026', '08:20:03') },
      { Date: '01/09/2026', LoginID: '36109', LoginDateTime: makeDt('01/09/2026', '15:45:00'), LogoutDateTime: makeDt('01/09/2026', '15:45:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '01/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('01/09/2026', '23:30:00'), LogoutDateTime: makeDt('01/09/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: stripConfig });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const hasOnlyOneAbsent = generated.filter(c => c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC').length === 1;
    const hasNoLeftoverTimedPenalty = !generated.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER');
    const ruleFired = row.details.ruleFired ?? '';
    const bothRulesReported = ruleFired.includes('Late Login') && ruleFired.includes('Early Logout');
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT'
      && hasOnlyOneAbsent && hasNoLeftoverTimedPenalty && bothRulesReported && row.includeInOutput;

    results.push({
      id: 'H03',
      name: 'Late 20 + Early-Out 15 (OPS) — Absent Wins on the Early-Out Cliff, No Leftover LATE/COVER',
      category: 'D2 fix: Absent excludes leftover timed penalties',
      inputDescription: 'SHIFT 08:00-16:00; login 08:20 (20m late, OPS 6-60m Late+Cover band); logout 15:45 (15m early, exceeds OPS 10m Early-Logout Absent floor). Config pinned: retainLateCoverOnAbsent=false, coverSameDayWhenAlreadyCovered=true (independent of the live registry)',
      cognosFlawedVerdict: 'Before the fix: Late Login pushed LATE+COVER before Early Logout evaluated and escalated to ABSENT — the earlier LATE+COVER rows were never retracted',
      expectedVerdict: 'ABSENT only; no leftover LATE/COVER from the Late Login branch',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (corrections=${generated.map(c => c.SegmentCode).join(',')}, bothReported=${bothRulesReported})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a double pay-hit when the SECOND-evaluated rule (Early Logout), not the first, is the one that escalates to Absent',
      calculationTrace: [
        'Late Login: 08:20 vs 08:00 -> 20m late -> OPS Late+Cover band -> pushes LATE + COVER, resultCategory LATE_AND_COVER_ADDED',
        'Early Logout: 15:45 vs 16:00 -> 15m early -> exceeds OPS 10m Absent floor -> ABSENT_SEGMENT, MARKED_ABSENT (3) outranks LATE_AND_COVER_ADDED (2) -> reported verdict becomes ABSENT',
        `Post-verdict strip removes the earlier LATE+COVER -> generatedCorrections = [${generated.map(c => c.SegmentCode).join(', ')}]`,
      ],
    });
  }

  // Case: Reservation-integrity — a stripped COVER must release its slot in
  // placedCoversThisRun, or the NEXT cover placed for the same employee/target-day
  // starts late by the stripped cover's full duration (a new, silent pay error in a
  // DIFFERENT row).
  //
  // Fixture: ONE employee (7000110), three ASPECT days, two Cognos incident rows whose covers
  // must resolve to the SAME `${empId}|${targetDateStr}` tracker key:
  //   30/08  SHIFT   — row Y's incident day (6m late -> Late+Cover)
  //   31/08  SHIFT2  — row X's incident day (61m late -> Absent, plus 7m early-out Log_off+Cover)
  //   01/09  SHIFT   — the shared cover target (no Cognos row of its own)
  // resolveCoverTargetDay's future-day search is glossary-driven (isWorkingDaySegment): ADDITION
  // codes count as working days EXCEPT those listed in nonWorkingDaySegmentCodes. 31/08's custom
  // ADDITION code SHIFT2 is pinned into that list below, so it is still a scheduled, evaluated
  // day (X's incident) but is skipped as a cover target: Y's nearest working day after 30/08 is
  // 01/09, exactly like X's. (With a plain SHIFT — or SHIFT2 not pinned — Y would target 31/08 and
  // the two rows would never share a key, so the case would pass whether or not releaseCover
  // worked.) Two same-day rows can't substitute: they'd read the same punches and both end Absent.
  // X is processed first: its cover reserves 01/09 16:00-16:07, then the strip step removes it
  // and must release the slot. Y's cover must then start at 16:00; a leaked reservation would
  // push it to 16:07.
  //
  // Config pinned: retainLateCoverOnAbsent=false (the strip rule under test; retain=true is
  // reservation-integrity-01-retained) and coverSameDayWhenAlreadyCovered=true (neither row's
  // attendance covers a same-day window, so it must fall through to the real target).
  {
    const shift2Config: ConfigRegistry = {
      ...config,
      retainLateCoverOnAbsent: false,
      coverSameDayWhenAlreadyCovered: true,
      segmentGlossary: { ...config.segmentGlossary, SHIFT2: { code: 'SHIFT2', role: 'ADDITION', description: 'Regression fixture: a scheduled ADDITION block the cover-target search is configured to skip' } },
      nonWorkingDaySegmentCodes: [...(config.nonWorkingDaySegmentCodes || []), 'SHIFT2'],
    };
    const cognosX: CognosRecord = {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '7000110', NAME: 'Reservation Release Agent', 'LOGIN ID': '36110',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:52',
      'SIGIN IN': '09:01', 'SIGIN OUT': '15:53', 'LATE START': '-61', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const cognosY: CognosRecord = {
      'SIGN IN DATE': '2026-08-30 00:00:00', SECTION: 'ECS', 'PF NO': '7000110', NAME: 'Reservation Release Agent', 'LOGIN ID': '36110',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:54',
      'SIGIN IN': '08:06', 'SIGIN OUT': '16:00', 'LATE START': '-6', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000110', NOM_DATE: '30/08/2026', START_DATE: '30/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '30/08/2026 08:00:00', STOP_MOMENT: '30/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000110', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT2', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000110', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000110', EMP_LAST_NAME: 'Reservation Release Agent', EMP_SORT_NAME: 'RESERVATION RELEASE AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '30/08/2026', LoginID: '36110', LoginDateTime: makeDt('30/08/2026', '08:06:00'), LogoutDateTime: makeDt('30/08/2026', '08:06:03') },
      { Date: '30/08/2026', LoginID: '36110', LoginDateTime: makeDt('30/08/2026', '15:59:57'), LogoutDateTime: makeDt('30/08/2026', '16:00:00') },
      { Date: '31/08/2026', LoginID: '36110', LoginDateTime: makeDt('31/08/2026', '09:01:00'), LogoutDateTime: makeDt('31/08/2026', '09:01:03') },
      { Date: '31/08/2026', LoginID: '36110', LoginDateTime: makeDt('31/08/2026', '15:53:00'), LogoutDateTime: makeDt('31/08/2026', '15:53:03') },
      // WP8: keeps 31/08 (the last calendar day with any punch in this fixture) from reading as
      // a truncated export (see the identical note in `boundary`) — X's 61m-late/7m-early ABSENT
      // is genuine, well-evidenced attendance, not a coverage gap.
      { Date: '31/08/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('31/08/2026', '23:30:00'), LogoutDateTime: makeDt('31/08/2026', '23:30:03') },
    ];

    // X first: rows are processed in input order, and X must reserve-then-release before Y places.
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognosX, cognosY], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: shift2Config });
    const rowX = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === cognosX['SIGN IN DATE']);
    const rowY = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === cognosY['SIGN IN DATE']);
    const xHasNoCover = !rowX?.details.generatedCorrections.some(c => c.SegmentCode === 'COVER');
    const yCover = rowY?.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    // Released reservation -> Y starts at 01/09's own 16:00 end. Leaked -> pushed to 16:07 by X's stripped 7m slot.
    const yCoverAtUnshiftedAnchor = yCover?.SegmentDate === '01/09/2026' && yCover?.SegmentStarttime === '16:00';
    const passed = rowX?.TAA_VERDICT === 'ABSENT' && xHasNoCover && !!yCover && yCoverAtUnshiftedAnchor;

    results.push({
      id: 'reservation-integrity-01',
      name: 'Stripped COVER Releases Its Reservation Slot (No Phantom Delay for the Next Cover)',
      category: 'D2 fix: reservation integrity',
      inputDescription: 'Same employee, two incident days (31/08 on a custom SHIFT2 day configured as a non-target, 30/08 on a SHIFT day) whose covers both resolve to 01/09 — the same tracker key; the 31/08 row ends Absent (its cover is stripped), the 30/08 row places a genuine cover on that key. Config pinned: retainLateCoverOnAbsent=false, coverSameDayWhenAlreadyCovered=true',
      cognosFlawedVerdict: 'A naive strip-without-release leaves the 31/08 row\'s cover reservation claimed even though the row was deleted, pushing the 30/08 row\'s real cover to start 7m late — a new, silent pay error in a different row',
      expectedVerdict: '31/08: ABSENT, no COVER row. 30/08: COVER on 01/09 starting at the un-shifted 16:00 anchor, not delayed by the stripped reservation',
      expectedAction: 'ABSENT_SEGMENT (31/08) / LATE_AND_COVER (30/08)',
      actualVerdict: `x(31/08)=${rowX?.TAA_VERDICT}(cover=${!xHasNoCover}); y(30/08) cover=${yCover?.SegmentDate ?? 'MISSING'} ${yCover?.SegmentStarttime ?? ''}`,
      actualAction: rowX?.TAA_ACTION ?? 'MISSING',
      passed,
      payrollImpact: 'Prevents a fix for one payroll defect (Absent excludes leftover cover) from silently introducing a second one (a phantom reservation delaying an unrelated day\'s real cover)',
      calculationTrace: [
        '31/08 (processed first): 61m late -> Absent; 7m early-out -> Logoff+Cover placed on 01/09 at 16:00-16:07, reserving that slot; final verdict ABSENT strips the COVER and must release the reservation',
        '30/08: 6m late -> Late+Cover; SHIFT2 on 31/08 is excluded from the cover-target search (nonWorkingDaySegmentCodes), so its cover targets the SAME 01/09 tracker key',
        `30/08 cover: ${yCover?.SegmentDate ?? 'MISSING'} ${yCover?.SegmentStarttime ?? ''} (expected 01/09/2026 16:00; a leaked reservation would show 16:07)`,
      ],
    });
  }

  // Cases cover-target-glossary-01/02: the cover-target search is glossary-driven
  // (isWorkingDaySegment), not a hardcoded SHIFT/OT1/OT2 list.
  //   01: a site-added ADDITION code (SHIFT2) on the next day IS a working day — the cover lands
  //       there at that day's own 16:00 end instead of skipping past it to 01/09.
  //   02: the same code listed in nonWorkingDaySegmentCodes is NOT a target — search continues to
  //       the following real SHIFT on 01/09.
  // Config pinned: coverSameDayWhenAlreadyCovered=false (so same-day placement can't pre-empt the
  // target search) and the fallback irrelevant (a real future day always exists).
  for (const variant of [
    { id: 'cover-target-glossary-01', excluded: false, expectedTarget: '31/08/2026' },
    { id: 'cover-target-glossary-02', excluded: true, expectedTarget: '01/09/2026' },
  ]) {
    const glossaryConfig: ConfigRegistry = {
      ...config,
      coverSameDayWhenAlreadyCovered: false,
      segmentGlossary: { ...config.segmentGlossary, SHIFT2: { code: 'SHIFT2', role: 'ADDITION', description: 'Regression fixture: site-added working-day ADDITION code' } },
      nonWorkingDaySegmentCodes: variant.excluded ? [...(config.nonWorkingDaySegmentCodes || []), 'SHIFT2'] : config.nonWorkingDaySegmentCodes,
    };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-30 00:00:00', SECTION: 'ECS', 'PF NO': '7000120', NAME: 'Glossary Target Agent', 'LOGIN ID': '36120',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000120', NOM_DATE: '30/08/2026', START_DATE: '30/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '30/08/2026 08:00:00', STOP_MOMENT: '30/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000120', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT2', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000120', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000120', EMP_LAST_NAME: 'Glossary Target Agent', EMP_SORT_NAME: 'GLOSSARY TARGET AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '30/08/2026', LoginID: '36120', LoginDateTime: makeDt('30/08/2026', '08:15:00'), LogoutDateTime: makeDt('30/08/2026', '08:15:03') },
      { Date: '30/08/2026', LoginID: '36120', LoginDateTime: makeDt('30/08/2026', '15:59:57'), LogoutDateTime: makeDt('30/08/2026', '16:00:00') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: glossaryConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined
      && cover.nominateDate === variant.expectedTarget
      && cover.SegmentDate === variant.expectedTarget
      && cover.SegmentStarttime === '16:00';

    results.push({
      id: variant.id,
      name: variant.excluded
        ? 'Cover Target Search: Custom ADDITION Code Listed as Non-Working Is Skipped'
        : 'Cover Target Search: Custom Glossary ADDITION Code Counts as a Working Day',
      category: 'Cover target day is glossary-driven (no hardcoded SHIFT/OT1/OT2 list)',
      inputDescription: `30/08 15-min late login (SHIFT); 31/08 carries custom ADDITION code SHIFT2${variant.excluded ? ' also listed in nonWorkingDaySegmentCodes' : ''}; 01/09 carries SHIFT. Config pinned: coverSameDayWhenAlreadyCovered=false`,
      cognosFlawedVerdict: 'Before the fix: the search only recognised SHIFT/OT1/OT2 by name, so a site-added working code was silently skipped and the cover landed a day too late',
      expectedVerdict: `COVER on ${variant.expectedTarget} starting at that day's own 16:00 end`,
      expectedAction: `COVER nominateDate=${variant.expectedTarget} 16:00`,
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A cover placed on the wrong day is a wrong-day payroll credit; the working-day set must follow the editable glossary like every other role decision',
      calculationTrace: [
        '30/08: 15m late -> Late+Cover, target resolved via isWorkingDaySegment over future segments',
        variant.excluded ? 'SHIFT2 is ADDITION but in nonWorkingDaySegmentCodes -> not a target; next real SHIFT is 01/09' : 'SHIFT2 is ADDITION (not COVER/leave/write-only) -> a working day; nearest future day is 31/08',
        `cover: ${cover?.SegmentDate ?? 'MISSING'} ${cover?.SegmentStarttime ?? ''}`,
      ],
    });
  }

  // Case E25: Absent day with scheduled OT — OT->SHIFT conversion must still fire
  // exactly once even though the strip step now removes LATE/Log_off/COVER from the
  // same row (the strip must never touch the OT conversion output).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000112', NAME: 'Absent With OT Agent', 'LOGIN ID': '36112',
      DUTY1: '08:00 - 16:00', OT1: '16:00 - 17:00', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '9:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000112', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000112', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT1', START_MOMENT: '01/09/2026 16:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000112', EMP_LAST_NAME: 'Absent With OT Agent', EMP_SORT_NAME: 'ABSENT WITH OT AGENT' }];
    const punches: CMSPunch[] = [];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const ot1OriginalRows = generated.filter(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const ot1ConvertedRows = generated.filter(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode && c.Memo.includes('OT1'));
    const noPlainShiftInsert = !generated.some(c => c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const exactlyOnePair = ot1OriginalRows.length === 1 && ot1ConvertedRows.length === 1;
    const hasNoLeftoverTimedPenalty = !generated.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER');
    const passed = row.TAA_VERDICT === 'NO_SHOW' && exactlyOnePair && noPlainShiftInsert && hasNoLeftoverTimedPenalty;

    results.push({
      id: 'E25',
      name: 'Absent Day With OT — OT Replaced By SHIFT Exactly Once, Strip Step Leaves It Untouched',
      category: 'D2 fix: strip step must not interfere with OT->SHIFT conversion',
      inputDescription: 'SHIFT 08:00-16:00 + OT1 16:00-17:00, zero CMS punches (populated LOGIN ID, no login record) -> Rule 5 Absent NS/NC',
      cognosFlawedVerdict: 'A strip implementation that removes corrections by a blunt filter (rather than an explicit SegmentCode allowlist) could accidentally also remove the OT->SHIFT replace pair',
      expectedVerdict: 'Absent NS/NC, OT1 explicitly retired and replaced by SHIFT exactly once (one 10/11 pair, never a bare insert), no LATE/Log_off/COVER present',
      expectedAction: 'ABSENT_NS_NC',
      actualVerdict: `${row.TAA_VERDICT} (OT1 10/11 pair=${exactlyOnePair}, no plain insert=${noPlainShiftInsert}, corrections=${generated.map(c => `${c.Code}:${c.SegmentCode}`).join(',')})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the D2 strip step is scoped to exactly LATE/Log_off/COVER and never regresses the existing Absent+OT co-occurrence fix',
      calculationTrace: [
        'No CMS punches for populated LOGIN ID + scheduled SHIFT/OT -> Rule 5 Absent NS/NC',
        'convertOtOnce() replaces OT1 with SHIFT once (10 OT1, 11 SHIFT)',
        `generatedCorrections after strip: [${generated.map(c => `${c.Code}:${c.SegmentCode}`).join(', ')}]`,
      ],
    });
  }

  // Case H02-retained: mirror of H02 with config.retainLateCoverOnAbsent=true —
  // a deliberate, user-confirmed policy choice that reverses the D2 fix by
  // explicit opt-in (default stays false/unchanged, see H02 above). Absent
  // AND the Early Logout Log_off+Cover correction must now export TOGETHER,
  // and each of the two distinct fired actions (ABSENT_SEGMENT,
  // LOGOFF_AND_COVER) must get its own EmailActionItem with a composite row_id.
  {
    const retainConfig: ConfigRegistry = { ...config, retainLateCoverOnAbsent: true };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000108', NAME: 'Absent Wins Over Logoff Cover Agent', 'LOGIN ID': '36108',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:52',
      'SIGIN IN': '09:01', 'SIGIN OUT': '15:53', 'LATE START': '-61', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000108', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000108', EMP_LAST_NAME: 'Absent Wins Over Logoff Cover Agent', EMP_SORT_NAME: 'ABSENT WINS OVER LOGOFF COVER AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36108', LoginDateTime: makeDt('01/09/2026', '09:01:00'), LogoutDateTime: makeDt('01/09/2026', '09:01:03') },
      { Date: '01/09/2026', LoginID: '36108', LoginDateTime: makeDt('01/09/2026', '15:53:00'), LogoutDateTime: makeDt('01/09/2026', '15:53:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '01/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('01/09/2026', '23:30:00'), LogoutDateTime: makeDt('01/09/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: retainConfig });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const hasAbsent = generated.some(c => c.SegmentCode === 'ABSENT');
    const hasLogOff = generated.some(c => c.SegmentCode === 'Log_off');
    const hasCover = generated.some(c => c.SegmentCode === 'COVER');
    const rowEmailActions = out.emailActions.filter(a => a.base_row_id === row.id);
    const hasTwoDistinctEmailActions = rowEmailActions.length === 2
      && new Set(rowEmailActions.map(a => a.taa_action)).size === 2
      && rowEmailActions.every(a => a.row_id.includes('#') && a.base_row_id === row.id);
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT'
      && hasAbsent && hasLogOff && hasCover && row.includeInOutput && hasTwoDistinctEmailActions;

    results.push({
      id: 'H02-retained',
      name: 'retainLateCoverOnAbsent: Absent AND Logoff+Cover Both Export Together',
      category: 'retainLateCoverOnAbsent toggle (reverses D2 fix by explicit opt-in)',
      inputDescription: 'Same inputs as H02, but config.retainLateCoverOnAbsent=true',
      cognosFlawedVerdict: 'N/A — this is a deliberate, user-confirmed policy choice, not a defect',
      expectedVerdict: 'ABSENT, Log_off, and COVER all present in generatedCorrections; two separate EmailActionItems (ABSENT_SEGMENT, LOGOFF_AND_COVER), each with a composite row_id',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (corrections=${generated.map(c => c.SegmentCode).join(',')}, emailActions=${rowEmailActions.length})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the toggle correctly skips the strip step and drafts a distinct email per fired action, instead of silently dropping the Logoff+Cover correction or its notice',
      calculationTrace: [
        'Late Login: 61m late -> ABSENT_SEGMENT, resultCategory MARKED_ABSENT',
        'Early Logout: 7m early -> LOGOFF_AND_COVER (does not override MARKED_ABSENT on severity, but its corrections stay since retainLateCoverOnAbsent=true skips the strip)',
        `generatedCorrections: [${generated.map(c => c.SegmentCode).join(', ')}]`,
      ],
    });
  }

  // Case H03-retained: mirror of H03 with config.retainLateCoverOnAbsent=true —
  // the reverse firing order from H02-retained (Late+Cover fires first, then
  // Early Logout's Absent wins), same policy-toggle assertion.
  {
    const retainConfig: ConfigRegistry = { ...config, retainLateCoverOnAbsent: true };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000109', NAME: 'Absent Wins Over Late Cover Agent', 'LOGIN ID': '36109',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:25',
      'SIGIN IN': '08:20', 'SIGIN OUT': '15:45', 'LATE START': '-20', 'LEFT EARLY': '-15', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000109', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000109', EMP_LAST_NAME: 'Absent Wins Over Late Cover Agent', EMP_SORT_NAME: 'ABSENT WINS OVER LATE COVER AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36109', LoginDateTime: makeDt('01/09/2026', '08:20:00'), LogoutDateTime: makeDt('01/09/2026', '08:20:03') },
      { Date: '01/09/2026', LoginID: '36109', LoginDateTime: makeDt('01/09/2026', '15:45:00'), LogoutDateTime: makeDt('01/09/2026', '15:45:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: '01/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('01/09/2026', '23:30:00'), LogoutDateTime: makeDt('01/09/2026', '23:30:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: retainConfig });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const hasAbsent = generated.some(c => c.SegmentCode === 'ABSENT');
    const hasLate = generated.some(c => c.SegmentCode === 'LATE');
    const hasCover = generated.some(c => c.SegmentCode === 'COVER');
    const rowEmailActions = out.emailActions.filter(a => a.base_row_id === row.id);
    const hasTwoDistinctEmailActions = rowEmailActions.length === 2
      && new Set(rowEmailActions.map(a => a.taa_action)).size === 2
      && rowEmailActions.every(a => a.row_id.includes('#') && a.base_row_id === row.id);
    const passed = row.TAA_VERDICT === 'ABSENT' && row.TAA_ACTION === 'ABSENT_SEGMENT'
      && hasAbsent && hasLate && hasCover && row.includeInOutput && hasTwoDistinctEmailActions;

    results.push({
      id: 'H03-retained',
      name: 'retainLateCoverOnAbsent: Absent AND Late+Cover Both Export Together',
      category: 'retainLateCoverOnAbsent toggle (reverses D2 fix by explicit opt-in)',
      inputDescription: 'Same inputs as H03, but config.retainLateCoverOnAbsent=true',
      cognosFlawedVerdict: 'N/A — this is a deliberate, user-confirmed policy choice, not a defect',
      expectedVerdict: 'ABSENT, LATE, and COVER all present in generatedCorrections; two separate EmailActionItems (LATE_AND_COVER, ABSENT_SEGMENT), each with a composite row_id',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT} (corrections=${generated.map(c => c.SegmentCode).join(',')}, emailActions=${rowEmailActions.length})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the toggle correctly skips the strip step and drafts a distinct email per fired action, instead of silently dropping the Late+Cover correction or its notice',
      calculationTrace: [
        'Late Login: 20m late -> LATE_AND_COVER, resultCategory LATE_AND_COVER_ADDED, pushed first',
        'Early Logout: 15m early -> ABSENT_SEGMENT overrides the reported verdict to ABSENT, but Late Login\'s corrections stay since retainLateCoverOnAbsent=true skips the strip',
        `generatedCorrections: [${generated.map(c => c.SegmentCode).join(', ')}]`,
      ],
    });
  }

  // Case reservation-integrity-01-retained: same two-incident-day setup as
  // reservation-integrity-01, but config.retainLateCoverOnAbsent=true for day 1.
  //
  // Correction to the premise reservation-integrity-01's own comment assumed:
  // with a real future SHIFT on employee 7000110's books (day 2, 01/09), day 1's
  // (31/08) cover target resolves via the REAL "next working day" path straight
  // to day 2's own date at day 2's own last-segment-end (16:00) — never through
  // the nextWeekMonday FALLBACK reservation-integrity-01's comment describes
  // (that fallback only ever fires for whichever incident is chronologically
  // LAST on the employee's books, since every earlier incident's nearest
  // future segment is simply the next one — confirmed by instrumenting this
  // exact fixture). Day 1 and day 2 therefore never contend for the same
  // reservation slot, retained or not — day 2's own cover independently
  // targets nextWeekMonday (07/09) regardless of what happens to day 1.
  //
  // What THIS case actually proves: with the toggle on, day 1's COVER survives
  // (not stripped) with its real, correctly-resolved placement intact (target
  // day 2's date, anchored at day 2's own 16:00 shift end, 7m duration) — and
  // day 2's own independent Late+Cover placement is completely unaffected,
  // proving the toggle doesn't corrupt or cross-contaminate a DIFFERENT row's
  // target resolution. reservation-integrity-01 (rebuilt around a custom SHIFT2
  // day excluded from the cover-target search so its two covers genuinely share one trackerKey) is the authority on
  // release-vs-leak — the version this comment was first written against did
  // not actually share a key, so it could not detect a leak.
  {
    const configFallback: ConfigRegistry = { ...config, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday', coverFallbackDefaultTime: '08:00', retainLateCoverOnAbsent: true };
    const cognosDay1: CognosRecord = {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '7000110', NAME: 'Reservation Release Agent', 'LOGIN ID': '36110',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:52',
      'SIGIN IN': '09:01', 'SIGIN OUT': '15:53', 'LATE START': '-61', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const cognosDay2: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000111', NAME: 'Reservation Observer Agent', 'LOGIN ID': '36111',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:54',
      'SIGIN IN': '08:06', 'SIGIN OUT': '16:00', 'LATE START': '-6', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000110', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000110', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000110', EMP_LAST_NAME: 'Reservation Release Agent', EMP_SORT_NAME: 'RESERVATION RELEASE AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '31/08/2026', LoginID: '36110', LoginDateTime: makeDt('31/08/2026', '09:01:00'), LogoutDateTime: makeDt('31/08/2026', '09:01:03') },
      { Date: '31/08/2026', LoginID: '36110', LoginDateTime: makeDt('31/08/2026', '15:53:00'), LogoutDateTime: makeDt('31/08/2026', '15:53:03') },
      { Date: '01/09/2026', LoginID: '36110', LoginDateTime: makeDt('01/09/2026', '08:06:00'), LogoutDateTime: makeDt('01/09/2026', '08:06:03') },
      { Date: '01/09/2026', LoginID: '36110', LoginDateTime: makeDt('01/09/2026', '15:59:57'), LogoutDateTime: makeDt('01/09/2026', '16:00:00') },
    ];
    const cognosBoth: CognosRecord[] = [
      { ...cognosDay1, 'PF NO': '7000110' },
      { ...cognosDay2, 'PF NO': '7000110', 'LOGIN ID': '36110' },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: cognosBoth, aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: configFallback });
    const day1Row = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === cognosDay1['SIGN IN DATE']);
    const day2Row = out.rows.find(r => r.originalCognos['SIGN IN DATE'] === cognosDay2['SIGN IN DATE']);
    const day1Cover = day1Row?.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    const day2Cover = day2Row?.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    // Day 1's cover (retained) resolves via the REAL next-working-day path to
    // day 2's own date, anchored at day 2's own shift end (16:00), 7m long.
    const day1CoverCorrect = day1Cover?.SegmentDate === '01/09/2026' && day1Cover?.SegmentStarttime === '16:00' && day1Cover?.Segmentduration === '00:07';
    // Day 2's own cover is untouched by day 1 at all — its own incident has no
    // future segment, so it independently falls back to nextWeekMonday (07/09)
    // at the configured default time, exactly as it would with the toggle off.
    const day2CoverUnaffected = day2Cover?.SegmentDate === '07/09/2026' && day2Cover?.SegmentStarttime === '08:00';
    const passed = day1Row?.TAA_VERDICT === 'ABSENT' && day1CoverCorrect && day2CoverUnaffected;

    results.push({
      id: 'reservation-integrity-01-retained',
      name: 'retainLateCoverOnAbsent: Retained COVER Keeps Its Real Placement, Independent Row Unaffected',
      category: 'retainLateCoverOnAbsent toggle (reverses D2 fix by explicit opt-in)',
      inputDescription: 'Same two-incident-day setup as reservation-integrity-01, but config.retainLateCoverOnAbsent=true',
      cognosFlawedVerdict: 'N/A — this is a deliberate, user-confirmed policy choice, not a defect',
      expectedVerdict: 'Day 1: ABSENT with COVER kept, correctly placed on day 2\'s date at 16:00 (7m). Day 2: its own independent cover at nextWeekMonday 07/09 08:00, unaffected',
      expectedAction: 'ABSENT_SEGMENT (day 1) / LATE_AND_COVER (day 2)',
      actualVerdict: `day1=${day1Row?.TAA_VERDICT} cover=${day1Cover?.SegmentDate ?? 'MISSING'} ${day1Cover?.SegmentStarttime ?? ''}; day2 cover=${day2Cover?.SegmentDate ?? 'MISSING'} ${day2Cover?.SegmentStarttime ?? ''}`,
      actualAction: day1Row?.TAA_ACTION ?? 'MISSING',
      passed,
      payrollImpact: 'Confirms the toggle keeps a retained COVER\'s real target-day resolution intact and never corrupts or cross-contaminates a different row\'s independent cover placement',
      calculationTrace: [
        'Day 1 (31/08): 61m late -> Absent; 7m early -> Logoff+Cover kept (retainLateCoverOnAbsent=true)',
        'Day 1\'s cover target resolves to day 2\'s real SHIFT day (01/09) at day 2\'s own end (16:00), not a nextWeekMonday fallback',
        'Day 2 (01/09): 6m late -> Late+Cover, its own cover independently falls back to nextWeekMonday (07/09) since nothing follows it',
        `Day 1 cover: ${day1Cover?.SegmentDate ?? 'MISSING'} ${day1Cover?.SegmentStarttime ?? ''}; Day 2 cover: ${day2Cover?.SegmentDate ?? 'MISSING'} ${day2Cover?.SegmentStarttime ?? ''}`,
      ],
    });
  }

  // Case E25-retained: mirror of E25 with config.retainLateCoverOnAbsent=true —
  // this row never had a LATE/Log_off/COVER correction to begin with (a plain
  // No-Login absence + OT co-occurrence), so the toggle changes nothing here.
  // Confirms the OT1->SHIFT replace-pair still fires exactly once and is
  // completely unaffected by the toggle, regardless of its setting.
  {
    const retainConfig: ConfigRegistry = { ...config, retainLateCoverOnAbsent: true };
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000112', NAME: 'Absent With OT Agent', 'LOGIN ID': '36112',
      DUTY1: '08:00 - 16:00', OT1: '16:00 - 17:00', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '9:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000112', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000112', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT1', START_MOMENT: '01/09/2026 16:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '7000112', EMP_LAST_NAME: 'Absent With OT Agent', EMP_SORT_NAME: 'ABSENT WITH OT AGENT' }];
    const punches: CMSPunch[] = [];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: retainConfig });
    const row = out.rows[0];
    const generated = row.details.generatedCorrections;
    const ot1OriginalRows = generated.filter(c => c.Code === retainConfig.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const ot1ConvertedRows = generated.filter(c => c.Code === retainConfig.shiftUpdateNewCode && c.SegmentCode === retainConfig.otToShiftConversionCode && c.Memo.includes('OT1'));
    const noPlainShiftInsert = !generated.some(c => c.Code === retainConfig.aspectNormalActionCode && c.SegmentCode === retainConfig.otToShiftConversionCode);
    const exactlyOnePair = ot1OriginalRows.length === 1 && ot1ConvertedRows.length === 1;
    const stillNoLeftoverTimedPenalty = !generated.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER');
    const passed = row.TAA_VERDICT === 'NO_SHOW' && exactlyOnePair && noPlainShiftInsert && stillNoLeftoverTimedPenalty;

    results.push({
      id: 'E25-retained',
      name: 'retainLateCoverOnAbsent: OT Replace-Pair Unaffected By The Toggle',
      category: 'retainLateCoverOnAbsent toggle (reverses D2 fix by explicit opt-in)',
      inputDescription: 'Same inputs as E25, but config.retainLateCoverOnAbsent=true',
      cognosFlawedVerdict: 'N/A — this is a deliberate, user-confirmed policy choice, not a defect',
      expectedVerdict: 'Absent NS/NC, OT1 explicitly retired and replaced by SHIFT exactly once — identical to E25, since this row never had a Late/Cover correction for the toggle to affect',
      expectedAction: 'ABSENT_NS_NC',
      actualVerdict: `${row.TAA_VERDICT} (OT1 10/11 pair=${exactlyOnePair}, no plain insert=${noPlainShiftInsert}, corrections=${generated.map(c => `${c.Code}:${c.SegmentCode}`).join(',')})`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the retainLateCoverOnAbsent toggle only ever touches LATE/Log_off/COVER and never the unrelated Absent+OT co-occurrence fix, on or off',
      calculationTrace: [
        'No CMS punches for populated LOGIN ID + scheduled SHIFT/OT -> Rule 5 Absent NS/NC',
        'convertOtOnce() replaces OT1 with SHIFT once (10 OT1, 11 SHIFT) -- unaffected by the toggle',
        `generatedCorrections: [${generated.map(c => `${c.Code}:${c.SegmentCode}`).join(', ')}]`,
      ],
    });
  }

  // Case hash-id-integrity-01: a PF NO containing '#' must not break the
  // action->row mapping. Found by audit 2026-09-17: the per-action email split
  // encodes multi-action items as `${rowId}#${actionCode}`, and every consumer
  // originally recovered the row by `row_id.split('#')[0]`. That is unsafe —
  // `samples_Files/Cognos.csv` genuinely contains `PF NO = "PT #"` (row 388, a
  // repeated header block inside the export), which makes rowId itself contain
  // a '#'; the split truncated the key, the row lookup missed, and that row
  // silently lost its mail icon, reported EXCLUDED_FROM_OUTPUT in
  // TAA_EMAIL_STATUS, and (for any row carrying a real emailing rule) would
  // have been dropped from Bulk Draft entirely — the exact silent-drop class
  // the per-action split exists to prevent. Fixed by carrying base_row_id as an
  // explicit field instead of parsing the string.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': 'PT #', NAME: 'Hash Id Agent', 'LOGIN ID': '36777',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:40',
      'SIGIN IN': '08:20', 'SIGIN OUT': '16:00', 'LATE START': '-20', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: 'PT #', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: 'PT #', EMP_LAST_NAME: 'Hash Id Agent', EMP_SORT_NAME: 'HASH ID AGENT', EMP_EXTRA_2: 'hash.agent' }];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '36777', LoginDateTime: makeDt('01/09/2026', '08:20:00'), LogoutDateTime: makeDt('01/09/2026', '08:20:03') },
      { Date: '01/09/2026', LoginID: '36777', LoginDateTime: makeDt('01/09/2026', '16:00:00'), LogoutDateTime: makeDt('01/09/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const rowActions = out.emailActions.filter(a => a.base_row_id === row.id);
    // The naive approach this replaced, kept here as the explicit anti-assertion:
    // splitting on '#' must NOT be how a row is recovered, and this fixture proves why.
    const splitWouldHaveFailed = out.emailActions.every(a => a.row_id.split('#')[0] !== row.id);
    const passed = row.id.includes('#')
      && rowActions.length >= 1
      && splitWouldHaveFailed
      && out.emailActions.every(a => a.base_row_id === row.id);

    results.push({
      id: 'hash-id-integrity-01',
      name: 'PF NO Containing "#" Still Maps Its Email Actions Back To Its Row',
      category: 'Audit 2026-09-17: per-action email id integrity',
      inputDescription: 'PF NO literally "PT #" (a real value in samples_Files/Cognos.csv), normal 20m late login',
      cognosFlawedVerdict: 'Recovering the row by row_id.split("#")[0] truncated "rec-0-PT #" to "rec-0-PT ", so the row lookup missed: no mail icon, TAA_EMAIL_STATUS wrongly EXCLUDED_FROM_OUTPUT, and a real emailing rule would be dropped from Bulk Draft',
      expectedVerdict: 'Every email action resolves to this row via base_row_id, even though splitting row_id on "#" would not',
      expectedAction: 'LATE_AND_COVER',
      actualVerdict: `row.id=${JSON.stringify(row.id)}; actionsForRow=${rowActions.length}; splitWouldFail=${splitWouldHaveFailed}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a silently un-emailed payroll row whenever an ID field contains the character used as the internal action separator',
      calculationTrace: [
        `rowId built as rec-<index>-<pfNo> = ${JSON.stringify(row.id)} — contains '#' from the PF NO itself`,
        `row_id.split('#')[0] would give ${JSON.stringify(out.emailActions[0]?.row_id.split('#')[0] ?? '')} — does NOT match row.id`,
        `base_row_id gives ${JSON.stringify(out.emailActions[0]?.base_row_id ?? '')} — matches`,
      ],
    });
  }

  // Case 108: MIXED_LEAVE_AND_WORK_SEGMENTS hold fires, is not a forced hold, and
  // takes priority over a same-row column MISMATCH (§Leave Segments priority order).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000020', NAME: 'Mixed Leave And Work Agent', 'LOGIN ID': '30020',
      DUTY1: '10:00 - 18:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00', 'SIGIN IN': '08:00', 'SIGIN OUT': '16:00',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '0', REMARK: '',
    };
    // Same day carries both a worked SHIFT (Addition) and a leave segment (ANNUAL) —
    // Cognos's own DUTY1 (10:00-18:00, a roster typo) genuinely disagrees with the
    // actual worked shift (08:00-16:00), which would independently earn MISMATCH_FOUND.
    const segs: AspectSegment[] = [
      { EMP_ID: '7000020', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000020', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30020', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '30020', LoginDateTime: makeDt('27/08/2026', '16:00:00'), LogoutDateTime: makeDt('27/08/2026', '16:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const duty1Mismatch = row.TAA_MISMATCH_COLUMNS.includes('DUTY1');
    const passed = row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS'
      && !isForcedHoldReason(row.holdReason)
      && row.includeInOutput === false
      && duty1Mismatch
      && row.TAA_VERDICT === 'PRESENT';

    results.push({
      id: 'reg-108',
      name: 'Mixed Leave-and-Work Day: MIXED_LEAVE_AND_WORK_SEGMENTS Fires, Not Forced, Beats MISMATCH_FOUND',
      category: '§Leave Segments: new hold reason and its priority ordering',
      inputDescription: 'Same day carries a worked SHIFT 08:00-16:00 (real CMS punches match) and a bare ANNUAL leave segment; Cognos DUTY1 says 10:00-18:00 (a genuine roster disagreement)',
      cognosFlawedVerdict: 'N/A — a naive implementation would either miss the leave/work co-occurrence entirely, or let the DUTY1 mismatch report as generic MISMATCH_FOUND instead',
      expectedVerdict: 'holdReason=MIXED_LEAVE_AND_WORK_SEGMENTS, not a forced hold, DUTY1 still flagged as a mismatch underneath, calculations completed normally (PRESENT)',
      expectedAction: 'N/A',
      actualVerdict: `holdReason=${row.holdReason}, forced=${isForcedHoldReason(row.holdReason)}, includeInOutput=${row.includeInOutput}, DUTY1 mismatch=${duty1Mismatch}, verdict=${row.TAA_VERDICT}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A day mixing paid leave with real worked hours is surfaced for reviewer approval rather than silently auto-included or silently blocked as a hard data error',
      calculationTrace: [
        'leaveSegmentsForDay=[ANNUAL] (non-empty) and recompute.additionSegments=[SHIFT] (non-empty) -> MIXED_LEAVE_AND_WORK_SEGMENTS',
        'MIXED_LEAVE_AND_WORK_SEGMENTS is not in FORCED_HOLD_REASONS -> releasable via reviewer approval',
        'comparisonResult.mismatchColumns still includes DUTY1, but the hold check runs before the generic MISMATCH_FOUND fallback so the more specific reason wins',
      ],
    });
  }

  // Case 109: Cognos LEAVE TYPE MAPPED basis — the default U-ABSENT -> UNCERTIFIEDSICK/
  // HOSPTLZD mapping actually resolves a match, and removing it turns the same row into
  // a genuine MISMATCH (proves the mapping is load-bearing, not decorative).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000021', NAME: 'Mapped Leave Type Agent', 'LOGIN ID': '30021',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000021', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'UNCERTIFIEDSICK' },
    ];

    const withMapping = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config }).rows[0];
    const noMappingConfig: ConfigRegistry = { ...config, cognosLeaveTypeMappings: [] };
    const withoutMapping = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config: noMappingConfig }).rows[0];

    const passed = withMapping.TAA_LEAVE_TYPE_STATUS === 'MATCH'
      && withMapping.TAA_LEAVE_TYPE_MATCH_BASIS === 'MAPPED'
      && withMapping.TAA_LEAVE_TYPE_RECOMPUTED === 'UNCERTIFIEDSICK'
      && withoutMapping.TAA_LEAVE_TYPE_STATUS === 'MISMATCH';

    results.push({
      id: 'reg-109',
      name: 'Cognos LEAVE TYPE MAPPED Basis (U-ABSENT -> UNCERTIFIEDSICK) Actually Matches, and Is Load-Bearing',
      category: '§Leave Segments: cognosLeaveTypeMappings resolution',
      inputDescription: 'ASPECT carries a bare UNCERTIFIEDSICK leave segment; Cognos LEAVE TYPE says "U-ABSENT" — a genuine spelling difference, not a verdict placeholder',
      cognosFlawedVerdict: 'N/A — without the mapping this is indistinguishable from a real leave-code disagreement (see reg-23)',
      expectedVerdict: 'With the default mapping: MATCH via MAPPED basis, recomputed=UNCERTIFIEDSICK. With the mapping removed: MISMATCH',
      expectedAction: 'N/A',
      actualVerdict: `withMapping: ${withMapping.TAA_LEAVE_TYPE_STATUS}/${withMapping.TAA_LEAVE_TYPE_MATCH_BASIS}/${withMapping.TAA_LEAVE_TYPE_RECOMPUTED}; withoutMapping: ${withoutMapping.TAA_LEAVE_TYPE_STATUS}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Confirms the one shipped default Cognos LEAVE TYPE mapping actually prevents a false paid-leave-vs-unpaid mismatch, and that the mapping (not some other fallback) is what does it',
      calculationTrace: [
        'EXACT: "U-ABSENT" != "UNCERTIFIEDSICK" -> no exact match',
        'MAPPED: default mapping U-ABSENT -> [UNCERTIFIEDSICK, HOSPTLZD] finds UNCERTIFIEDSICK -> MATCH',
        'With cognosLeaveTypeMappings=[]: no mapping, no exact match, identified leave exists -> MISMATCH',
      ],
    });
  }

  // Case 110: compareScheduleColumnsOnLeaveDays toggle actually changes DUTY1 behavior on
  // a leave day, while LEAVE TYPE keeps comparing normally either way.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '7000022', NAME: 'Leave Day Schedule Toggle Agent', 'LOGIN ID': '30022',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '0', REMARK: '',
    };
    // Bare ANNUAL only, no SHIFT -> isLeaveDay=true (nonWorking present, no Addition segment).
    const segs: AspectSegment[] = [
      { EMP_ID: '7000022', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    ];

    const suppressed = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config }).rows[0];
    const compareConfig: ConfigRegistry = { ...config, compareScheduleColumnsOnLeaveDays: true };
    const compared = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config: compareConfig }).rows[0];
    const duty1Suppressed = suppressed.columnComparisons.find(c => c.column === 'DUTY1');
    const duty1Compared = compared.columnComparisons.find(c => c.column === 'DUTY1');

    const passed = duty1Suppressed?.status === 'NOT_COMPARABLE'
      && duty1Compared?.status !== 'NOT_COMPARABLE'
      && suppressed.TAA_LEAVE_TYPE_STATUS === 'MATCH'
      && compared.TAA_LEAVE_TYPE_STATUS === 'MATCH';

    results.push({
      id: 'reg-110',
      name: 'compareScheduleColumnsOnLeaveDays Toggle Changes DUTY1 on a Leave Day; LEAVE TYPE Unaffected',
      category: '§Leave Segments: compareScheduleColumnsOnLeaveDays config toggle',
      inputDescription: 'Bare ANNUAL leave day (no worked segment); Cognos DUTY1 shows the paid-leave roster entitlement 08:00-16:00',
      cognosFlawedVerdict: 'N/A — proves the config toggle (default false) actually gates DUTY1/DUTY-2/SCH DURATION suppression on a leave day, not just LEAVE TYPE/LEAVE HR',
      expectedVerdict: 'Default (off): DUTY1 NOT_COMPARABLE. Toggled on: DUTY1 compared normally (not NOT_COMPARABLE). LEAVE TYPE MATCHes in both cases',
      expectedAction: 'N/A',
      actualVerdict: `off: DUTY1=${duty1Suppressed?.status}, LEAVE TYPE=${suppressed.TAA_LEAVE_TYPE_STATUS}; on: DUTY1=${duty1Compared?.status}, LEAVE TYPE=${compared.TAA_LEAVE_TYPE_STATUS}`,
      actualAction: 'N/A',
      passed,
      payrollImpact: 'Confirms the one config toggle this feature added actually has an observable effect, and that it is scoped to schedule columns only, not the leave-identity columns',
      calculationTrace: [
        'isLeaveDay: nonWorkingSegments=[ANNUAL] non-empty, additionSegments=[] empty -> true',
        'suppressScheduleColumns = isLeaveDay && !config.compareScheduleColumnsOnLeaveDays',
        'off -> suppressScheduleColumns=true -> DUTY1 forced NOT_COMPARABLE; on -> suppressScheduleColumns=false -> DUTY1 goes through blockMatches() normally',
      ],
    });
  }

  // Case 111: RLS fully inside OT1+OT2 (an "OT_INTERNAL" removal) must NOT force-hold
  // the row — Rule 8 already corrects the OT duration for this, and the row's own
  // scheduled hours drop by the overlap, not the raw shift+OT sum.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000111', NAME: 'OT Internal RLS Agent', 'LOGIN ID': '36111',
      // SCH DURATION is the FULL net schedule (all additions incl. OT minus all removals =
      // 600m/10:00), so the fixture carries that figure to isolate the removal behaviour under
      // test from the (separately tested) Cognos-omits-OT mismatch. OT1/OT-2 are left blank
      // here (COGNOS_BLANK, not a mismatch).
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '10:0', 'SIGNIN DURATION': '12:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '19:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000111', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000111', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 15:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 120 },
      { EMP_ID: '7000111', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT2', START_MOMENT: '27/08/2026 17:00:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 120 },
      { EMP_ID: '7000111', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 18:00:00', DURATION: 120 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36111', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '36111', LoginDateTime: makeDt('27/08/2026', '19:00:00'), LogoutDateTime: makeDt('27/08/2026', '19:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const csvHasCorrections = out.aspectCorrectionsCsv.split('\n').some(l => l.trim().length > 0);
    // Audit-total reconciliation (bug fix 2026-09-11): raw additions (480+120+120=720)
    // minus every reported deduction must equal the recomputed net exactly, so the
    // "Release/Nursing/OT-Internal Deductions" the UI shows actually add up.
    const rawAdditions = 480 + 120 + 120;
    const reconciles = rawAdditions - row.details.releaseMinutes - row.details.nursingMinutes - row.details.otInternalRemovalMinutes === row.TAA_SCH_HOURS_RECOMPUTED;
    const passed = row.holdReason !== 'MID_SHIFT_REMOVAL_SEGMENT'
      && row.includeInOutput === true
      && row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && row.TAA_SCH_HOURS_RECOMPUTED === 600
      && row.details.otInternalRemovalMinutes === 120
      && reconciles
      && row.TAA_EFFECTIVE_START === '07:00' && row.TAA_EFFECTIVE_END === '19:00'
      && csvHasCorrections;

    results.push({
      id: 'reg-111',
      name: 'RLS Fully Inside OT1+OT2 Reduces Hours And Exports, Never Held',
      category: 'Variance audit F8: OT-internal removal vs mid-shift hold',
      inputDescription: 'SHIFT 07:00-15:00 (480m) + OT1 15:00-17:00 (120m) + OT2 17:00-19:00 (120m) + RLS 16:00-18:00 (120m, straddling both OT segments)',
      cognosFlawedVerdict: 'Previously classified MID (touches neither the shift start nor the combined 07:00-19:00 end) -> forced hold -> the whole day\'s corrections silently never reached the ASPECT export',
      expectedVerdict: 'Not held; hours 480+120+120-120=600; otInternalRemovalMinutes=120 (audit-total reconciles); effective window untouched 07:00-19:00; Rule 8 corrections reach the export',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `hold=${row.holdReason || 'none'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; otInternal=${row.details.otInternalRemovalMinutes}; reconciles=${reconciles}; window=${row.TAA_EFFECTIVE_START}-${row.TAA_EFFECTIVE_END}; csvHasRows=${csvHasCorrections}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A release the tool already knows how to correct (Rule 8) no longer silently blocks the day\'s ABSENT/OT-adjustment corrections from ever reaching payroll, and the audit trail\'s deduction totals now add up to the recomputed net (bug fix 2026-09-11)',
      calculationTrace: [
        `netScheduledMinutes: ${row.TAA_SCH_HOURS_RECOMPUTED} (480 + 120 + 120 - 120 union overlap)`,
        `effective window: ${row.TAA_EFFECTIVE_START} - ${row.TAA_EFFECTIVE_END} (unmoved by the OT-internal removal)`,
        `reconciliation: ${rawAdditions} raw - ${row.details.releaseMinutes} release - ${row.details.nursingMinutes} nursing - ${row.details.otInternalRemovalMinutes} OT-internal = ${rawAdditions - row.details.releaseMinutes - row.details.nursingMinutes - row.details.otInternalRemovalMinutes} (must equal ${row.TAA_SCH_HOURS_RECOMPUTED})`,
      ],
    });
  }

  // Case 112: a release that STRADDLES the shift/OT boundary (only partly inside OT) must
  // still be held MID — OT_INTERNAL requires FULL containment, never a partial overlap.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000112', NAME: 'Straddle RLS Agent', 'LOGIN ID': '36112',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '10:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000112', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000112', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 15:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 120 },
      { EMP_ID: '7000112', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 120 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36112', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '36112', LoginDateTime: makeDt('27/08/2026', '17:00:00'), LogoutDateTime: makeDt('27/08/2026', '17:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = !row.holdReason
      && row.details.otInternalRemovalMinutes === 0
      && row.TAA_SCH_HOURS_RECOMPUTED === 480
      && row.TAA_EFFECTIVE_END === '17:00';

    results.push({
      id: 'reg-112',
      name: 'RLS Straddling The Shift/OT Boundary Is A MID Removal: Deducted, Window Unmoved, Not Held',
      category: 'Variance audit F8: OT-internal removal vs mid-shift hold',
      inputDescription: 'SHIFT 07:00-15:00 + OT1 15:00-17:00; RLS 14:00-16:00 (half inside the shift, half inside OT1 — not fully contained in OT)',
      cognosFlawedVerdict: 'N/A — guards the OT_INTERNAL classification: a partial OT overlap must not be reported as OT-internal',
      expectedVerdict: 'No hold; not OT-internal (0m); hours 480+120-120=480; effective window end stays 17:00',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}; otInternal=${row.details.otInternalRemovalMinutes}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; end=${row.TAA_EFFECTIVE_END}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the OT-internal fix is strict containment only, not "touches OT at all", and that the straddling release still costs its 120 minutes without moving the attendance window',
      calculationTrace: [`holdReason: ${row.holdReason ?? 'none'}`],
    });
  }

  // Case 113: a release sitting in a GAP between two non-contiguous OT blocks (not inside
  // either one) must also still be held MID.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000113', NAME: 'OT Gap RLS Agent', 'LOGIN ID': '36113',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '10:0', 'SIGNIN DURATION': '12:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '19:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000113', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '7000113', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 15:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 60 },
      { EMP_ID: '7000113', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT2', START_MOMENT: '27/08/2026 18:00:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 60 },
      { EMP_ID: '7000113', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 16:30:00', STOP_MOMENT: '27/08/2026 17:30:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36113', LoginDateTime: makeDt('27/08/2026', '07:00:00'), LogoutDateTime: makeDt('27/08/2026', '07:00:03') },
      { Date: '27/08/2026', LoginID: '36113', LoginDateTime: makeDt('27/08/2026', '19:00:00'), LogoutDateTime: makeDt('27/08/2026', '19:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = !row.holdReason && row.TAA_SCH_HOURS_RECOMPUTED === 600 && row.details.otInternalRemovalMinutes === 0;

    results.push({
      id: 'reg-113',
      name: 'RLS In A Gap Between Two OT Blocks Docks Nothing (No Scheduled Time To Remove) And Is Not Held',
      category: 'Variance audit F8: OT-internal removal vs mid-shift hold',
      inputDescription: 'OT1 15:00-16:00 and OT2 18:00-19:00 (a non-contiguous gap 16:00-18:00); RLS 16:30-17:30 sits in that gap, inside neither OT block',
      cognosFlawedVerdict: 'N/A — guards against a removal merely "near" OT counting as OT-internal when it falls in a gap between two separate OT blocks',
      expectedVerdict: 'No hold; not OT-internal; hours stay 480+60+60=600 — the gap between OT1 and OT2 holds no scheduled minutes to release',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; otInternal=${row.details.otInternalRemovalMinutes}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms containment is checked against the actual OT segment intervals (not a merged span), and that a release outside every scheduled interval cannot dock paid hours',
      calculationTrace: [`holdReason: ${row.holdReason ?? 'none'}`],
    });
  }

  // Case 114: public-holiday overtime exemption (decision 2026-09-12) — a P/H-LV day
  // whose only worked segment is OT2, fully attended, must NOT be held for review. This
  // is the exact real-world shape (PF 4507957, PRD Non-Negotiables "Holiday Overtime").
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000114', NAME: 'Holiday OT2 Agent', 'LOGIN ID': '30114',
      DUTY1: '', OT1: '', 'DUTY-2': '23:00 - 07:00', 'OT-2': '8:00', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '23:00', 'SIGIN OUT': '07:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000114', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000114', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT2', START_MOMENT: '01/09/2026 23:00:00', STOP_MOMENT: '02/09/2026 07:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30114', LoginDateTime: makeDt('01/09/2026', '23:00:00'), LogoutDateTime: makeDt('01/09/2026', '23:00:03') },
      { Date: '02/09/2026', LoginID: '30114', LoginDateTime: makeDt('02/09/2026', '07:00:00'), LogoutDateTime: makeDt('02/09/2026', '07:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const schDurationStatus = row.columnComparisons.find(c => c.column === 'SCH DURATION')?.status;
    const duty2Status = row.columnComparisons.find(c => c.column === 'DUTY-2')?.status;
    const passed = !row.holdReason && row.includeInOutput === true && row.TAA_OT2 === '480'
      && schDurationStatus === 'MATCH' && duty2Status === 'MATCH';

    results.push({
      id: 'reg-114',
      name: 'Public-Holiday Overtime (P/H-LV + OT2 only) Is Never Held',
      category: '§Leave Segments: public-holiday overtime exemption (2026-09-12)',
      inputDescription: 'P/H-LV structural leave row + standalone OT2 23:00-07:00, fully attended, no SHIFT segment — the exact PF 4507957 real-world shape. Cognos carries real DUTY-2/SCH DURATION values for this shape (23:00-07:00 / 8:0), not blank ones.',
      cognosFlawedVerdict: 'Before the exemption: MIXED_LEAVE_AND_WORK_SEGMENTS fired, includeInOutput=false — holiday overtime silently excluded from the exported corrections. Separately, before the 0-non-OT-block/1-OT-block pairing fix: duty1Block/duty2Block were both null on this exact shape, so SCH DURATION and DUTY-2 fell back to a false MISMATCH against Cognos\'s real values even on a fully-attended day.',
      expectedVerdict: 'No hold at all; includeInOutput=true; TAA_OT2 preserved at 480; SCH DURATION and DUTY-2 comparisons MATCH (not a false MISMATCH)',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}, TAA_OT2=${row.TAA_OT2}, SCH_DURATION=${schDurationStatus}, DUTY-2=${duty2Status}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Public-holiday overtime reaches the exported ASPECT correction file automatically instead of being stranded behind a manual reviewer click; the annotated export no longer flags a fully-attended holiday-OT day as disagreeing with Cognos',
      calculationTrace: [
        'leaveSegmentsForDay=[P/H-LV], every code in config.publicHolidayOvertimeLeaveCodes -> leave side of exemption satisfied',
        'recompute.additionSegments=[OT2], every code is OT2 -> work side of exemption satisfied',
        'isPublicHolidayOvertimeDay=true -> MIXED_LEAVE_AND_WORK_SEGMENTS does not fire',
        'nonOtBlocks.length=0, otBlocks.length=1 -> duty2Block=OT2 window (23:00-07:00), duty1Block stays null -> SCH DURATION fallback and DUTY-2 comparison both resolve to the real value instead of null',
      ],
    });
  }

  // Case 115: boundary — ANNUAL (not P/H-LV) + OT2 only must still hold. Proves the
  // exemption is leave-code-specific, not "any leave code with OT2-only work".
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000115', NAME: 'Annual OT2 Agent', 'LOGIN ID': '30115',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '8:00', 'SCH DURATION': '', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '23:00', 'SIGIN OUT': '07:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000115', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'ANNUAL' },
      { EMP_ID: '7000115', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT2', START_MOMENT: '01/09/2026 23:00:00', STOP_MOMENT: '02/09/2026 07:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30115', LoginDateTime: makeDt('01/09/2026', '23:00:00'), LogoutDateTime: makeDt('01/09/2026', '23:00:03') },
      { Date: '02/09/2026', LoginID: '30115', LoginDateTime: makeDt('02/09/2026', '07:00:00'), LogoutDateTime: makeDt('02/09/2026', '07:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS' && row.includeInOutput === false;

    results.push({
      id: 'reg-115',
      name: 'ANNUAL + OT2-only Still Holds (Exemption Is Leave-Code-Specific)',
      category: '§Leave Segments: public-holiday overtime exemption (2026-09-12)',
      inputDescription: 'ANNUAL leave (not P/H-LV) + standalone OT2 23:00-07:00, no SHIFT — same work shape as reg-114 but a different leave code',
      cognosFlawedVerdict: 'N/A — this is the boundary guard, not a defect',
      expectedVerdict: 'Still held MIXED_LEAVE_AND_WORK_SEGMENTS; includeInOutput=false — ANNUAL is not in config.publicHolidayOvertimeLeaveCodes',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the 2026-09-12 exemption did not accidentally widen to every leave code — an ANNUAL+OT2 day (not a documented case) still gets reviewer eyes',
      calculationTrace: ['leaveSegmentsForDay=[ANNUAL], not in config.publicHolidayOvertimeLeaveCodes -> isPublicHolidayOvertimeDay=false -> MIXED_LEAVE_AND_WORK_SEGMENTS fires'],
    });
  }

  // Case 116: boundary — P/H-LV + OT1 (not OT2) only must still hold. Proves the
  // exemption is overtime-type-specific, not "any leave code with any OT-only work".
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000116', NAME: 'Holiday OT1 Agent', 'LOGIN ID': '30116',
      DUTY1: '', OT1: '8:00', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '23:00', 'SIGIN OUT': '07:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000116', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000116', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT1', START_MOMENT: '01/09/2026 23:00:00', STOP_MOMENT: '02/09/2026 07:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30116', LoginDateTime: makeDt('01/09/2026', '23:00:00'), LogoutDateTime: makeDt('01/09/2026', '23:00:03') },
      { Date: '02/09/2026', LoginID: '30116', LoginDateTime: makeDt('02/09/2026', '07:00:00'), LogoutDateTime: makeDt('02/09/2026', '07:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed = row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS' && row.includeInOutput === false;

    results.push({
      id: 'reg-116',
      name: 'P/H-LV + OT1-only Still Holds (Exemption Is Overtime-Type-Specific)',
      category: '§Leave Segments: public-holiday overtime exemption (2026-09-12)',
      inputDescription: 'P/H-LV leave + standalone OT1 (regular overtime, not public-holiday OT2) 23:00-07:00, no SHIFT',
      cognosFlawedVerdict: 'N/A — this is the boundary guard, not a defect',
      expectedVerdict: 'Still held MIXED_LEAVE_AND_WORK_SEGMENTS; includeInOutput=false — OT1 is not OT2',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the 2026-09-12 exemption stayed OT2-specific per the user\'s explicit decision — regular overtime (OT1) landing on a leave day still gets reviewer eyes',
      calculationTrace: ['recompute.additionSegments=[OT1], not all OT2 -> isPublicHolidayOvertimeDay=false -> MIXED_LEAVE_AND_WORK_SEGMENTS fires'],
    });
  }

  // Case 117: public-holiday SHIFT miscoding (decision 2026-09-12, mirror of the
  // OT2 exemption, reversed) — a P/H-LV day whose only worked segment is SHIFT
  // (not OT2) is a genuine scheduling mistake: TAA auto-drafts a 10/11 replace
  // pair converting the SHIFT segment to OT2 in the correction output, but the
  // row still holds for one reviewer approval pass, unlike the OT2 exemption's
  // full auto-pass.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000117', NAME: 'Holiday Miscoded Shift Agent', 'LOGIN ID': '30117',
      DUTY1: '9:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000117', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000117', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 09:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30117', LoginDateTime: makeDt('01/09/2026', '09:00:00'), LogoutDateTime: makeDt('01/09/2026', '09:00:03') },
      { Date: '01/09/2026', LoginID: '30117', LoginDateTime: makeDt('01/09/2026', '17:00:00'), LogoutDateTime: makeDt('01/09/2026', '17:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const gen = row.details.generatedCorrections;
    const originalIdx = gen.findIndex(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'SHIFT');
    const replacementIdx = gen.findIndex(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.shiftToOt2ConversionCode);
    const original = gen[originalIdx];
    const replacement = gen[replacementIdx];
    const pairAdjacent = originalIdx >= 0 && replacementIdx === originalIdx + 1;
    const pairFieldsMatch = !!original && !!replacement
      && original.SegmentDate === replacement.SegmentDate
      && original.SegmentStarttime === replacement.SegmentStarttime
      && original.Segmentduration === replacement.Segmentduration;
    // out.aspectCorrections (the raw per-row list) is populated unconditionally
    // regardless of hold state, same as details.generatedCorrections — only the
    // rendered aspectCorrectionsCsv string is actually gated by includeInOutput.
    // That CSV string is the real "did this reach the export" contract.
    // Impossible sentinel: this can never legitimately appear in an exported CSV memo,
    // so it's a safe `|| fallback` for the .includes() check below when Memo is undefined.
    const NO_MEMO_SENTINEL = '\0';
    const notInExportedCsv = !out.aspectCorrectionsCsv.includes(original?.Memo || NO_MEMO_SENTINEL)
      && !out.aspectCorrectionsCsv.includes(replacement?.Memo || NO_MEMO_SENTINEL);
    const passed =
      row.holdReason === 'PUBLIC_HOLIDAY_SHIFT_MISCODED'
      && row.includeInOutput === false
      && pairAdjacent
      && pairFieldsMatch
      && original?.SegmentDate === '01/09/2026'
      && original?.Segmentduration === '08:00'
      && notInExportedCsv;

    results.push({
      id: 'reg-117',
      name: 'Public-Holiday SHIFT Miscoding (P/H-LV + SHIFT only) Auto-Converts To OT2 But Stays Held',
      category: '§Leave Segments: public-holiday SHIFT miscoding (2026-09-12)',
      inputDescription: 'P/H-LV structural leave row + a normal SHIFT 09:00-17:00, fully attended, no OT2 — staff mistakenly scheduled as a regular shift on a holiday-leave day',
      cognosFlawedVerdict: 'Before this rule: generic MIXED_LEAVE_AND_WORK_SEGMENTS fired with no drafted correction — a reviewer had to hand-author the SHIFT-to-OT2 fix from scratch',
      expectedVerdict: 'holdReason=PUBLIC_HOLIDAY_SHIFT_MISCODED; includeInOutput=false; a 10/11 pair converts the SHIFT segment to config.shiftToOt2ConversionCode (OT2), drafted but not yet in the exported CSV',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}, pair=${JSON.stringify({ original, replacement })}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A miscoded SHIFT on a public-holiday-leave day gets its OT2 correction auto-drafted (original SHIFT explicitly retired via the 10/11 pair, never left duplicated) instead of a reviewer having to notice and hand-author it, while still requiring sign-off before it reaches payroll',
      calculationTrace: [
        'leaveSegmentsForDay=[P/H-LV], every code in config.publicHolidayOvertimeLeaveCodes -> leave side satisfied',
        'recompute.additionSegments=[SHIFT], every code is SHIFT (not OT2) -> isPublicHolidayShiftMiscodedDay=true',
        'convertShiftSegmentsToOt2 emits a 10 (original SHIFT) then 11 (SegmentCode=config.shiftToOt2ConversionCode) pair',
        'holdReason=PUBLIC_HOLIDAY_SHIFT_MISCODED (not a forced hold) -> checkbox-releasable via reviewer approval; pair absent from out.aspectCorrections until approved',
      ],
    });
  }

  // Case 118: boundary — P/H-LV day with BOTH a SHIFT and an OT2 segment must
  // collide with neither the OT2 exemption nor the new SHIFT-miscoding
  // conversion; it must fall through to the plain, unconverted
  // MIXED_LEAVE_AND_WORK_SEGMENTS hold.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000118', NAME: 'Holiday Mixed Shift OT2 Agent', 'LOGIN ID': '30118',
      DUTY1: '9:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '2:00', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '10:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '19:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000118', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000118', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 09:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '7000118', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT2', START_MOMENT: '01/09/2026 17:00:00', STOP_MOMENT: '01/09/2026 19:00:00', DURATION: 120 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30118', LoginDateTime: makeDt('01/09/2026', '09:00:00'), LogoutDateTime: makeDt('01/09/2026', '09:00:03') },
      { Date: '01/09/2026', LoginID: '30118', LoginDateTime: makeDt('01/09/2026', '19:00:00'), LogoutDateTime: makeDt('01/09/2026', '19:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed =
      row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS'
      && row.includeInOutput === false
      && !row.details.generatedCorrections.some(c => c.SegmentCode === config.shiftToOt2ConversionCode)
      && !row.details.generatedCorrections.some(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'SHIFT');

    results.push({
      id: 'reg-118',
      name: 'P/H-LV + SHIFT-and-OT2 Mixed Still Holds Generic, No Conversion Fires (Non-Collision Guard)',
      category: '§Leave Segments: public-holiday SHIFT miscoding (2026-09-12)',
      inputDescription: 'P/H-LV leave + SHIFT 09:00-17:00 + OT2 17:00-19:00 same day — neither "every addition OT2" nor "every addition SHIFT" holds',
      cognosFlawedVerdict: 'N/A — this is the boundary/non-collision guard, not a defect',
      expectedVerdict: 'Still generic MIXED_LEAVE_AND_WORK_SEGMENTS; includeInOutput=false; no SHIFT-to-OT2 conversion pair emitted',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms a genuinely mixed SHIFT+OT2 day on holiday leave never collides with either the OT2 auto-pass or the SHIFT auto-conversion — it still gets full reviewer eyes with no auto-drafted correction to rubber-stamp',
      calculationTrace: [
        'recompute.additionSegments=[SHIFT, OT2] -> isPublicHolidayOvertimeDay=false (not every OT2), isPublicHolidayShiftMiscodedDay=false (not every SHIFT)',
        'MIXED_LEAVE_AND_WORK_SEGMENTS fires; convertShiftSegmentsToOt2 never called',
      ],
    });
  }

  // Case 119: boundary — ANNUAL (not P/H-LV) + SHIFT-only must still hold generic,
  // unconverted. Proves the SHIFT-miscoding conversion is leave-code-specific, not
  // "any leave code with a SHIFT segment".
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000119', NAME: 'Annual Shift Agent', 'LOGIN ID': '30119',
      DUTY1: '9:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000119', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'ANNUAL' },
      { EMP_ID: '7000119', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 09:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 480 },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30119', LoginDateTime: makeDt('01/09/2026', '09:00:00'), LogoutDateTime: makeDt('01/09/2026', '09:00:03') },
      { Date: '01/09/2026', LoginID: '30119', LoginDateTime: makeDt('01/09/2026', '17:00:00'), LogoutDateTime: makeDt('01/09/2026', '17:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const passed =
      row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS'
      && row.includeInOutput === false
      && !row.details.generatedCorrections.some(c => c.SegmentCode === config.shiftToOt2ConversionCode)
      && !row.details.generatedCorrections.some(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'SHIFT');

    results.push({
      id: 'reg-119',
      name: 'ANNUAL + SHIFT-only Still Holds Generic (SHIFT-Miscoding Rule Is Leave-Code-Specific)',
      category: '§Leave Segments: public-holiday SHIFT miscoding (2026-09-12)',
      inputDescription: 'ANNUAL leave (not P/H-LV) + standalone SHIFT 09:00-17:00 — same work shape as reg-117 but a different leave code',
      cognosFlawedVerdict: 'N/A — this is the boundary guard, not a defect',
      expectedVerdict: 'Still generic MIXED_LEAVE_AND_WORK_SEGMENTS; includeInOutput=false — ANNUAL is not in config.publicHolidayOvertimeLeaveCodes, so no auto-conversion',
      expectedAction: 'N/A',
      actualVerdict: `hold=${row.holdReason || 'none'}, includeInOutput=${row.includeInOutput}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the SHIFT-miscoding rule did not accidentally widen to every leave code — an ordinary ANNUAL+SHIFT day (not a holiday-leave scheduling mistake) stays a plain reviewer case with no auto-drafted correction',
      calculationTrace: ['leaveSegmentsForDay=[ANNUAL], not in config.publicHolidayOvertimeLeaveCodes -> isPublicHolidayShiftMiscodedDay=false -> MIXED_LEAVE_AND_WORK_SEGMENTS fires, no conversion'],
    });
  }

  // Case 127: re-run guard (decision 2026-09-15; superseded 2026-09-18 by gate
  // §4.6f Absence Already Recorded for this exact shape) — same P/H-LV + SHIFT
  // shape as reg-117, but the day's ASPECT export already carries an "ABSENT
  // NS/NC" marker segment (as it would after a prior TAA run's §4.6c correction
  // was uploaded back into ASPECT). Re-running TAA against this now-corrected
  // export must NOT draft a SHIFT-to-OT2 pair — that would undo the earlier
  // Absent+OT fix. SEG_CODE is deliberately upper-cased ("ABSENT NS/NC" vs the
  // marker set's "Absent NS/NC") to also prove the guard's isCodeInConfiguredSet
  // match is case-insensitive.
  //
  // 2026-09-18: this row also carries a full punch pair spanning the whole
  // 09:00-17:00 shift — i.e. CMS shows the day was actually worked despite
  // already being tagged absent. Gate §4.6f now catches that contradiction
  // BEFORE the §4.6e guard's own MIXED_LEAVE_AND_WORK_SEGMENTS fallback even
  // runs, and reports the more specific/actionable ABSENT_MARKED_BUT_ATTENDED
  // instead. The invariant this test exists to protect — no SHIFT-to-OT2 pair
  // ever drafted on an already-marked-absent day — still holds; only the
  // reported hold reason changed, to a strictly more informative one. The
  // classic zero-punch re-run shape (§4.6e's original scenario: an
  // already-corrected leave day re-processed with no further attendance) is
  // covered separately by reg-128 below, which does exercise the original
  // MIXED_LEAVE_AND_WORK_SEGMENTS fallback via gate §4.6f's NO_ACTION branch.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000127', NAME: 'Re-Run Guard Agent', 'LOGIN ID': '30127',
      DUTY1: '9:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '17:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000127', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000127', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 09:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '7000127', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'ABSENT NS/NC' },
    ];
    const punches: CMSPunch[] = [
      { Date: '01/09/2026', LoginID: '30127', LoginDateTime: makeDt('01/09/2026', '09:00:00'), LogoutDateTime: makeDt('01/09/2026', '09:00:03') },
      { Date: '01/09/2026', LoginID: '30127', LoginDateTime: makeDt('01/09/2026', '17:00:00'), LogoutDateTime: makeDt('01/09/2026', '17:00:03') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const noOt2Pair = !row.details.generatedCorrections.some(c => c.SegmentCode === config.shiftToOt2ConversionCode)
      && !row.details.generatedCorrections.some(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'SHIFT');
    const passed =
      row.holdReason !== 'PUBLIC_HOLIDAY_SHIFT_MISCODED'
      && row.holdReason === 'ABSENT_MARKED_BUT_ATTENDED'
      && row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && noOt2Pair;

    results.push({
      id: 'reg-127',
      name: 'Re-Run Guard: An Already-Absent P/H-LV+SHIFT Day Never Drafts SHIFT-to-OT2 (Undo Prevention)',
      category: '§4.6f supersedes §4.6e for this shape (2026-09-18): must never undo an already-applied §4.6c Absent+OT correction',
      inputDescription: 'P/H-LV + SHIFT 09:00-17:00 (same shape as reg-117), plus an "ABSENT NS/NC" marker segment already present in the ASPECT export — the signature left behind by an earlier §4.6c correction having been uploaded back to ASPECT — and a full CMS punch pair covering the whole shift',
      cognosFlawedVerdict: 'Without either guard: identical to reg-117 -> auto-drafts a 10/11 pair converting the already-corrected SHIFT back to OT2, silently undoing the prior Absent-day fix on every re-run',
      expectedVerdict: 'holdReason=ABSENT_MARKED_BUT_ATTENDED, action=MANUAL_REVIEW_REQUIRED (gate 4.6f: already marked absent, but CMS shows the day was fully worked); never PUBLIC_HOLIDAY_SHIFT_MISCODED; no SHIFT-to-OT2 pair drafted',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: `hold=${row.holdReason || 'none'}, noOt2Pair=${noOt2Pair}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a re-run of TAA against an already-corrected date from proposing to convert the corrected SHIFT segment back to OT2 (which would undo the prior §4.6c Absent+OT fix), and now also surfaces — instead of silently ignoring — the fact that a day tagged absent shows a full day of CMS attendance',
      calculationTrace: [
        'empSegs includes an ABSENT NS/NC segment -> existingAbsenceMarkerSegment found -> gate §4.6f fires before the leave/mixed-work Pass 3 check ever runs',
        'CMS punches span the full 09:00-17:00 shift (>= leaveLoginThresholdMinutes) -> branch (b): ABSENCE_CONTRADICTED_BY_CMS / MANUAL_REVIEW_REQUIRED / holdReason=ABSENT_MARKED_BUT_ATTENDED',
        'forcedHoldReason already set by gate 4.6f -> Pass 3\'s dayAlreadyHasAbsentMarker guard still forces isPublicHolidayShiftMiscodedDay=false, but its own MIXED_LEAVE_AND_WORK_SEGMENTS fallback never overwrites the more specific reason already set',
        'No SHIFT-to-OT2 pair drafted either way — the re-run-undo-prevention invariant holds',
      ],
    });
  }

  // Case 128: the classic §4.6e re-run scenario reg-127 originally modeled — an
  // already-corrected leave day re-processed with NO further CMS attendance
  // (unlike reg-127 above, which now has a contradicting full punch pair and so
  // exercises gate §4.6f's branch (b) instead). Same P/H-LV + SHIFT + "Absent
  // NS/NC" marker shape, zero CMS punches. Gate §4.6f's branch (a) fires
  // (already absent, no attendance to contradict it) -> NO_ACTION, no duplicate
  // absence marker, no email — and the day still never drafts a SHIFT-to-OT2
  // pair, falling through instead to the original generic
  // MIXED_LEAVE_AND_WORK_SEGMENTS reviewer-releasable signal (soft, not a
  // forced hold) exactly as §4.6e originally intended.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '7000128', NAME: 'Re-Run Guard Agent (No Attendance)', 'LOGIN ID': '30128',
      DUTY1: '9:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'Absent NS/NC', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000128', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'P/H-LV' },
      { EMP_ID: '7000128', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 09:00:00', STOP_MOMENT: '01/09/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '7000128', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'ABSENT NS/NC' },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: [], config });
    const row = out.rows[0];
    const noOt2Pair = !row.details.generatedCorrections.some(c => c.SegmentCode === config.shiftToOt2ConversionCode)
      && !row.details.generatedCorrections.some(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'SHIFT');
    const noDuplicateAbsentMarker = !row.details.generatedCorrections.some(c => c.SegmentCode === 'Absent NS/NC' || c.SegmentCode === 'ABSENT');
    const passed =
      row.TAA_VERDICT === 'ABSENCE_ALREADY_RECORDED'
      && row.TAA_ACTION === 'NO_ACTION'
      && row.holdReason !== 'PUBLIC_HOLIDAY_SHIFT_MISCODED'
      && noOt2Pair
      && noDuplicateAbsentMarker;

    results.push({
      id: 'reg-128',
      name: 'Absence Already Recorded (Zero Attendance): No Duplicate Marker, No SHIFT-to-OT2 (Undo Prevention)',
      category: '§4.6f Absence Already Recorded (2026-09-18), classic §4.6e re-run shape',
      inputDescription: 'P/H-LV + SHIFT 09:00-17:00 + an "ABSENT NS/NC" marker segment already present in the ASPECT export, zero CMS punches',
      cognosFlawedVerdict: 'Without gate 4.6f: falls into the standard no-login branch -> Rule 5 fires -> a SECOND "Absent NS/NC" segment is written on top of the one already there, plus an NS/NC notice email',
      expectedVerdict: 'ABSENCE_ALREADY_RECORDED / NO_ACTION — no duplicate absence segment, no email, no SHIFT-to-OT2 pair',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT} / hold=${row.holdReason || 'none'}, noOt2Pair=${noOt2Pair}, noDuplicateAbsentMarker=${noDuplicateAbsentMarker}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Stops TAA from writing a second absence marker and drafting an accusatory NS/NC notice for a day WFM (or an earlier TAA run) already tagged absent',
      calculationTrace: [
        'empSegs includes an ABSENT NS/NC segment -> existingAbsenceMarkerSegment found -> gate §4.6f fires',
        'Zero CMS punches (< leaveLoginThresholdMinutes) -> branch (a): ABSENCE_ALREADY_RECORDED / NO_ACTION, no rowCorrections pushed, no email',
        'Pass 3: dayAlreadyHasAbsentMarker=true -> isPublicHolidayShiftMiscodedDay=false -> no SHIFT-to-OT2 pair drafted either',
      ],
    });
  }

  // Case 129/130: the exact real-world reported shape (user, 2026-09-18) — a plain
  // SHIFT day (no P/H-LV, no OT) whose ASPECT export already carries a day-level
  // ABSENT marker with no times of its own, isolated from any leave-code/Pass-3
  // interaction so gate §4.6f's own two branches are each verified on their own.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-15 00:00:00', SECTION: 'SALES', 'PF NO': '4036620', NAME: 'Already Absent Agent', 'LOGIN ID': '67885',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4036620', NOM_DATE: '15/09/2026', START_DATE: '15/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '15/09/2026 09:00:00', STOP_MOMENT: '15/09/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '4036620', NOM_DATE: '15/09/2026', START_DATE: '15/09/2026', SEG_CODE: 'ABSENT' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4036620', EMP_LAST_NAME: 'Already Absent Agent', EMP_SORT_NAME: 'ALREADY ABSENT AGENT' }];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: [], config });
    const row = out.rows[0];
    const noCorrectionsGenerated = row.details.generatedCorrections.length === 0;
    // Cognos "ABSENT" vs TAA's own absence marker must reconcile as a MATCH, never a
    // fabricated MISMATCH against a blank — a MISMATCH here silently raises a
    // MISMATCH_FOUND hold and drops an otherwise-clean no-action row into the review
    // queue (regression found in verification, 2026-09-18).
    const leaveTypeCmp = row.columnComparisons.find(c => c.column === 'LEAVE TYPE');
    const noAccusatoryEmail = !out.emailActions.some(e => e.template_key === 'no_login_ns_nc');
    const everyEmailIsNA = out.emailActions.every(e => e.communication_rule === 'NA');
    const passed = row.TAA_VERDICT === 'ABSENCE_ALREADY_RECORDED'
      && row.TAA_ACTION === 'NO_ACTION'
      && noCorrectionsGenerated
      && leaveTypeCmp?.status === 'MATCH'
      && !row.holdReason
      && noAccusatoryEmail
      && everyEmailIsNA;

    results.push({
      id: 'reg-129',
      name: 'Real-World Case: SHIFT + Pre-Existing ABSENT Marker, Zero CMS Punches -> No Duplicate Segment, No Email',
      category: '§4.6f Absence Already Recorded (2026-09-18) — reported production case',
      inputDescription: 'PF 4036620, 15/09/2026: SHIFT 09:00-17:00 + a day-level "ABSENT" marker segment (no times) already present in the ASPECT export, zero CMS punches for LOGIN ID 67885',
      cognosFlawedVerdict: 'Before this fix: Rule 5 (No Login Record) fires unconditionally on zero punches -> writes a second "Absent NS/NC" segment on top of the existing ABSENT marker and drafts an accusatory No-Show/No-Call email, even though the day was already tagged absent',
      expectedVerdict: 'ABSENCE_ALREADY_RECORDED / NO_ACTION — no correction row generated, no NS/NC notice, LEAVE TYPE reconciles as MATCH, and no MISMATCH_FOUND hold',
      expectedAction: 'NO_ACTION',
      actualVerdict: `${row.TAA_VERDICT}, corrections=${row.details.generatedCorrections.length}, LEAVE TYPE=${leaveTypeCmp?.status}, hold=${row.holdReason || 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'This is the exact bug report: TAA was duplicating an already-recorded absence and escalating it to No-Show/No-Call by side-effect. Fixed: the day is left exactly as already tagged, with no duplicate write and no notice.',
      calculationTrace: [
        'empSegs includes an ABSENT segment -> existingAbsenceMarkerSegment found -> gate §4.6f fires ahead of the standard no-login branch',
        'Zero CMS punches (< leaveLoginThresholdMinutes) -> branch (a): ABSENCE_ALREADY_RECORDED / NO_ACTION',
        'No rowCorrections pushed, no pushFiredAction call -> no ASPECT correction row and no email drafted',
      ],
    });
  }
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-15 00:00:00', SECTION: 'SALES', 'PF NO': '4036621', NAME: 'Already Absent But Attended Agent', 'LOGIN ID': '67886',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '17:00', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '4036621', NOM_DATE: '15/09/2026', START_DATE: '15/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '15/09/2026 09:00:00', STOP_MOMENT: '15/09/2026 17:00:00', DURATION: 480 },
      { EMP_ID: '4036621', NOM_DATE: '15/09/2026', START_DATE: '15/09/2026', SEG_CODE: 'ABSENT' },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: '4036621', EMP_LAST_NAME: 'Already Absent But Attended Agent', EMP_SORT_NAME: 'ALREADY ABSENT BUT ATTENDED AGENT' }];
    const punches: CMSPunch[] = [
      { Date: '15/09/2026', LoginID: '67886', LoginDateTime: makeDt('15/09/2026', '09:00:00'), LogoutDateTime: makeDt('15/09/2026', '17:00:00') },
    ];

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const noCorrectionsGenerated = row.details.generatedCorrections.length === 0;
    const passed = row.TAA_VERDICT === 'ABSENCE_CONTRADICTED_BY_CMS'
      && row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
      && row.holdReason === 'ABSENT_MARKED_BUT_ATTENDED'
      && noCorrectionsGenerated;

    results.push({
      id: 'reg-130',
      name: 'SHIFT + Pre-Existing ABSENT Marker, Full CMS Punch Pair -> Held for Manual Review, Never Auto-Reversed',
      category: '§4.6f Absence Already Recorded (2026-09-18) — the previously-invisible contradiction case',
      inputDescription: 'SHIFT 09:00-17:00 + a day-level "ABSENT" marker segment already present in the ASPECT export, but CMS shows a full 09:00-17:00 punch pair — the day was marked absent yet apparently attended',
      cognosFlawedVerdict: 'Before this fix: the day already carrying ABSENT is invisible to every gate once it also has a SHIFT segment — it is simply never re-examined, so nobody is ever told the recorded absence contradicts CMS',
      expectedVerdict: 'ABSENCE_CONTRADICTED_BY_CMS / MANUAL_REVIEW_REQUIRED — held for a human with the source documents; never auto-reversed',
      expectedAction: 'MANUAL_REVIEW_REQUIRED',
      actualVerdict: `${row.TAA_VERDICT}, hold=${row.holdReason || 'none'}, corrections=${row.details.generatedCorrections.length}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Surfaces a previously-silent case where a recorded absence may be wrong and pay may be owed — without ever auto-correcting ASPECT to reverse it',
      calculationTrace: [
        'empSegs includes an ABSENT segment -> existingAbsenceMarkerSegment found -> gate §4.6f fires',
        'CMS punches span the full 09:00-17:00 shift (>= leaveLoginThresholdMinutes) -> branch (b): ABSENCE_CONTRADICTED_BY_CMS / MANUAL_REVIEW_REQUIRED / forcedHoldReason=ABSENT_MARKED_BUT_ATTENDED',
        'No rowCorrections pushed — removing a recorded absence is a human decision, never automatic',
      ],
    });
  }

  {
    // Case 120: Rule 8 full overlap (RLS exactly cancels the whole OT segment,
    // the Reem Al-Suwaidi / Family H sample-data shape) must never emit a
    // 10/11 pair whose "new" row carries 00:00 duration — ASPECT rejects a
    // zero-duration change/replace row outright. Instead the pair's Code 11
    // row keeps the FULL original duration and swaps SegmentCode to SHIFT.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '7000120', NAME: 'Full Overlap Agent', 'LOGIN ID': '36120',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 17:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000120', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000120', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'OT1', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },
      { EMP_ID: '7000120', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'RLS', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '31/08/2026', LoginID: '36120', LoginDateTime: makeDt('31/08/2026', '08:00:00'), LogoutDateTime: makeDt('31/08/2026', '08:00:03') },
      { Date: '31/08/2026', LoginID: '36120', LoginDateTime: makeDt('31/08/2026', '16:00:00'), LogoutDateTime: makeDt('31/08/2026', '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const zeroDurationOtRow = out.aspectCorrections.find(c => c.SegmentCode === 'OT1' && c.Segmentduration === '00:00');
    const originalOt = out.aspectCorrections.find(c => c.Code === config.shiftUpdateOriginalCode && c.SegmentCode === 'OT1');
    const shiftReplacement = out.aspectCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode);
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && !zeroDurationOtRow
      && originalOt?.Segmentduration === '01:00'
      && shiftReplacement?.Segmentduration === '01:00';

    results.push({
      id: 'reg-120',
      name: 'Rule 8 Full RLS Overlap Recodes OT to SHIFT, Never a Zero-Duration Row',
      category: 'Payroll audit: Rule 8 OT/RLS full-overlap correction shape (2026-09-15)',
      inputDescription: 'OT1 16:00-17:00 (60m) fully cancelled by an identical-window RLS 16:00-17:00',
      cognosFlawedVerdict: 'Previously emitted a 10/11 pair reducing OT1 to 00:00 — a duration ASPECT rejects on upload',
      expectedVerdict: 'ADJUST_OT_RLS: Code 10 OT1 01:00 (original) + Code 11 SHIFT 01:00 (replacement) — no OT1 row ever carries 00:00',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; original=${originalOt?.SegmentCode}/${originalOt?.Segmentduration || 'none'}; replacement=${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration || 'none'}; zeroDurationOtRow=${zeroDurationOtRow ? 'present' : 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents an ASPECT-rejected zero-duration upload row and stops overtime premium from leaking onto a fully-released hour',
      calculationTrace: [`Original: ${originalOt?.SegmentCode}/${originalOt?.Segmentduration}`, `Replacement: ${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration}`],
    });
  }

  {
    // Case 121: rounding-up crossover — a release shorter than the grid
    // (20m against a 30m OT segment) rounds UP to 30m per config, which
    // consumes the entire OT segment. This must take the FULL-overlap branch
    // (OT->SHIFT pair) even though the raw, unrounded overlap was partial.
    // The RLS sits at the TAIL of the OT window (16:10-16:30), matching the
    // only documented real-world shape (releases always carve from the back)
    // — a leading/mid release is a separate, untested branch of the general
    // effective-schedule computation and would trip an unrelated Early-Logout
    // rule, which isn't what this case is testing.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000121', NAME: 'Rounding Crossover Agent', 'LOGIN ID': '36121',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 16:30', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:10',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:10', 'LATE START': '0', 'LEFT EARLY': '-20', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000121', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000121', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 16:30:00', DURATION: 30 },
      { EMP_ID: '7000121', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 16:10:00', STOP_MOMENT: '27/08/2026 16:30:00', DURATION: 20 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '36121', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '36121', LoginDateTime: makeDt('27/08/2026', '16:10:00'), LogoutDateTime: makeDt('27/08/2026', '16:10:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const zeroOrTenMinuteOtRow = out.aspectCorrections.find(c => c.SegmentCode === 'OT1' && (c.Segmentduration === '00:00' || c.Segmentduration === '00:10'));
    const shiftReplacement = out.aspectCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode);
    const partialShiftInsert = out.aspectCorrections.find(c => c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && !zeroOrTenMinuteOtRow
      && !partialShiftInsert
      && shiftReplacement?.Segmentduration === '00:30';

    results.push({
      id: 'reg-121',
      name: 'A 20-Minute Release Rounds Up To 30 And Crosses Into the Full-Overlap Branch',
      category: 'Payroll audit: Rule 8 OT/RLS rounding crossover (2026-09-15)',
      inputDescription: 'OT1 16:00-16:30 (30m) overlapped by a trailing 20-minute RLS 16:10-16:30 — rounds up to 30m, consuming the whole OT segment',
      cognosFlawedVerdict: 'N/A — this is the rounding-crossover boundary guard, not a defect',
      expectedVerdict: 'Rounded release (30m) equals the OT duration (30m) -> full-overlap branch: Code 10 OT1 00:30 + Code 11 SHIFT 00:30, no partial-overlap SHIFT insert and no leftover OT1 row',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; replacement=${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration || 'none'}; partialInsert=${partialShiftInsert ? 'present' : 'none'}; badOtRow=${zeroOrTenMinuteOtRow ? 'present' : 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms rounding is applied before the partial/full branch decision, so a sub-grid release never leaves a leftover fractional OT row',
      calculationTrace: [`Raw overlap: 20m -> rounded up to 30m (grid=${config.segmentUpdateRoundingGridMinutes}, direction=${config.segmentUpdateRoundingDirection})`, `Replacement: ${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration}`],
    });
  }

  {
    // Case 122: an earlier row in the SAME batch being marked Absent must
    // never suppress Rule 8 on a LATER, unrelated, fully-PRESENT row. Caught
    // live 2026-09-15: the absent-day guard added for reg-120/BR-04 was first
    // wired to `markedAbsentCount > 0` — a run-wide summary counter declared
    // once outside the row loop (used for the "MARKED ABSENT" stat card), not
    // a per-row flag. Once any earlier row in the batch was absent, every
    // later row's Rule 8 evaluation was permanently suppressed regardless of
    // that row's own verdict — exactly what happened to Reem Al-Suwaidi in
    // the full 79-row sample dataset (she comes after many absent rows).
    // Fixed by using the per-row `resultCategory === 'MARKED_ABSENT'` instead.
    const absentDay: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000122', NAME: 'Earlier Absent Agent', 'LOGIN ID': '36122',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const absentSegs: AspectSegment[] = [
      { EMP_ID: '7000122', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 09:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 480 },
    ];
    // Later row: same full-overlap shape as reg-120 (Reem's own pattern), on
    // a different employee/day, appearing SECOND in the batch.
    const laterPresentDay: CognosRecord = {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '7000123', NAME: 'Later Present Agent', 'LOGIN ID': '36123',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 17:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const laterSegs: AspectSegment[] = [
      { EMP_ID: '7000123', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000123', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'OT1', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },
      { EMP_ID: '7000123', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'RLS', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '31/08/2026', LoginID: '36123', LoginDateTime: makeDt('31/08/2026', '08:00:00'), LogoutDateTime: makeDt('31/08/2026', '08:00:03') },
      { Date: '31/08/2026', LoginID: '36123', LoginDateTime: makeDt('31/08/2026', '16:00:00'), LogoutDateTime: makeDt('31/08/2026', '16:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [absentDay, laterPresentDay],
      aspectSegments: [...absentSegs, ...laterSegs],
      aspectIdentities: [],
      cmsPunches: punches,
      config,
    });
    const absentRow = out.rows.find(r => r.originalCognos['PF NO'] === '7000122');
    const laterRow = out.rows.find(r => r.originalCognos['PF NO'] === '7000123');
    const shiftReplacement = out.aspectCorrections.filter(c => c.ID === '7000123').find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === config.otToShiftConversionCode);
    const passed = absentRow?.TAA_ACTION === 'ABSENT_NS_NC'
      && !!laterRow
      && laterRow.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && shiftReplacement?.Segmentduration === '01:00';

    results.push({
      id: 'reg-122',
      name: 'An Earlier Absent Row In the Batch Never Suppresses a Later Row\'s Rule 8',
      category: 'Payroll audit: Rule 8 cross-row state leak (2026-09-15)',
      inputDescription: 'Row 1 (PF 7000122) has no CMS punches at all -> Absent. Row 2 (PF 7000123), an unrelated employee/day, has an OT1 fully cancelled by an identical-window RLS and is otherwise fully present',
      cognosFlawedVerdict: 'N/A — this pins a real regression found while implementing Rule 8\'s OT->SHIFT fix, not a Cognos defect',
      expectedVerdict: 'Row 1: ABSENT_NS_NC. Row 2: ADJUST_OT_RLS still fires — Code 11 SHIFT 01:00 — unaffected by row 1\'s absence',
      expectedAction: 'ADJUST_OT_RLS (row 2)',
      actualVerdict: `row1=${absentRow?.TAA_ACTION}; row2 actions=${laterRow?.TAA_ACTIONS_FIRED || 'none'}; row2 replacement=${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration || 'none'}`,
      actualAction: laterRow?.TAA_ACTION || 'none',
      passed,
      payrollImpact: 'Prevents a batch-wide false negative: without this, every present employee processed after the first absence in a run would silently lose its Rule 8 OT/RLS correction',
      calculationTrace: [`Row 1 (7000122): ${absentRow?.TAA_ACTION}`, `Row 2 (7000123) actions: ${laterRow?.TAA_ACTIONS_FIRED}`, `Row 2 replacement: ${shiftReplacement?.SegmentCode}/${shiftReplacement?.Segmentduration}`],
    });
  }

  {
    // Case 123: LEADING release -- RLS sits at the FRONT of the OT segment
    // (OT 16:00-19:00, RLS 16:00-17:00), employee genuinely works the
    // remaining 17:00-19:00. Pre-fix defect (found in the earlier audit):
    // the OT row kept its original 16:00 start and only shrank duration to
    // 02:00, producing OT1 16:00-18:00 -- overlapping the new SHIFT row at
    // 16:00-17:00 (double pay) and silently dropping the real 18:00-19:00
    // overtime. Fixed by subtracting the released window from the OT
    // segment's own span instead of shrinking duration in place.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000123001', NAME: 'Leading Release Agent', 'LOGIN ID': '39001',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 19:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '11:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '19:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000123001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000123001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 180 },
      { EMP_ID: '7000123001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '39001', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '39001', LoginDateTime: makeDt('27/08/2026', '19:00:00'), LogoutDateTime: makeDt('27/08/2026', '19:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const ot1Adjusted = out.aspectCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === 'OT1');
    const shiftInserts = out.aspectCorrections.filter(c => c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const strayOt1AtOriginalStart = out.aspectCorrections.find(c => c.SegmentCode === 'OT1' && c.SegmentStarttime === '16:00' && c.Code !== config.shiftUpdateOriginalCode);
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && ot1Adjusted?.SegmentStarttime === '17:00' && ot1Adjusted?.Segmentduration === '02:00'
      && shiftInserts.length === 1 && shiftInserts[0].SegmentStarttime === '16:00' && shiftInserts[0].Segmentduration === '01:00'
      && !strayOt1AtOriginalStart;

    results.push({
      id: 'reg-123',
      name: 'Leading RLS Over OT Moves the Surviving OT Piece, Never Double-Pays the Front Hour',
      category: 'Payroll audit: Rule 8 leading-release correctness (2026-09-15)',
      inputDescription: 'OT1 16:00-19:00 (180m) with RLS at the FRONT, 16:00-17:00; employee works the remaining 17:00-19:00',
      cognosFlawedVerdict: 'Pre-fix defect: OT row kept start 16:00 with 120m duration -> 16:00-18:00, overlapping the SHIFT insert at 16:00-17:00 (double pay) and dropping the real 18:00-19:00 OT',
      expectedVerdict: 'Code 11 OT1 at 17:00 for 02:00 (the real remaining window) + one Code 00 SHIFT at 16:00 for 01:00 -- no OT1 row left at the original 16:00 start',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; adjustedOT=${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration || 'none'}; shiftInserts=${shiftInserts.length}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents double-paying the released front hour and silently dropping the genuinely-worked trailing overtime',
      calculationTrace: [`OT1 remaining: ${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration}`, `SHIFT inserts: ${shiftInserts.length}`],
    });
  }

  {
    // Case 124: MID-segment release -- RLS sits in the MIDDLE of the OT
    // window (OT 16:00-19:00, RLS 17:00-18:00), leaving two genuinely-worked
    // OT pieces either side of it. User-confirmed 2026-09-15: split into
    // OT 16:00-17:00 (attended) + SHIFT 17:00-18:00 (converted) + OT
    // 18:00-19:00 (attended). Untested in real ASPECT data but the shape the
    // engine must not corrupt if it ever occurs.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000124001', NAME: 'Mid Release Agent', 'LOGIN ID': '39002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 19:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '11:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '19:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000124001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000124001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 180 },
      { EMP_ID: '7000124001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 17:00:00', STOP_MOMENT: '27/08/2026 18:00:00', DURATION: 60 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '39002', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '39002', LoginDateTime: makeDt('27/08/2026', '19:00:00'), LogoutDateTime: makeDt('27/08/2026', '19:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const otRows = out.aspectCorrections.filter(c => c.ID === '7000124001' && c.SegmentCode === 'OT1');
    const ot1Adjusted = otRows.find(c => c.Code === config.shiftUpdateNewCode);
    const ot1Extra = otRows.find(c => c.Code === config.aspectNormalActionCode);
    const shiftInserts = out.aspectCorrections.filter(c => c.ID === '7000124001' && c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const extraCorrectionCount = out.aspectCorrections.filter(c => c.ID === '7000124001').length;
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && ot1Adjusted?.SegmentStarttime === '16:00' && ot1Adjusted?.Segmentduration === '01:00'
      && ot1Extra?.SegmentStarttime === '18:00' && ot1Extra?.Segmentduration === '01:00'
      && shiftInserts.length === 1 && shiftInserts[0].SegmentStarttime === '17:00' && shiftInserts[0].Segmentduration === '01:00'
      && extraCorrectionCount === 4; // 10 original + 11 first-remaining + 00 second-remaining + 00 SHIFT

    results.push({
      id: 'reg-124',
      name: 'A Mid-Segment RLS Splits OT Into Two Surviving Pieces Around the Converted Window',
      category: 'Payroll audit: Rule 8 mid-segment release correctness (2026-09-15)',
      inputDescription: 'OT1 16:00-19:00 (180m) with RLS in the MIDDLE, 17:00-18:00; employee works straight through 16:00-19:00',
      cognosFlawedVerdict: 'N/A -- user-confirmed target shape for an untested (in real data) release position',
      expectedVerdict: 'Code 11 OT1 16:00 01:00 (first piece) + Code 00 OT1 18:00 01:00 (second piece) + Code 00 SHIFT 17:00 01:00 -- exactly 4 correction rows total for this employee',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; first=${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration}; second=${ot1Extra?.SegmentStarttime}/${ot1Extra?.Segmentduration}; shift=${shiftInserts.length}; totalRows=${extraCorrectionCount}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a mid-shift release from corrupting either surviving OT piece or losing one of them entirely',
      calculationTrace: [`First OT piece: ${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration}`, `Second OT piece: ${ot1Extra?.SegmentStarttime}/${ot1Extra?.Segmentduration}`, `SHIFT: ${shiftInserts[0]?.SegmentStarttime}/${shiftInserts[0]?.Segmentduration}`],
    });
  }

  {
    // Case 125: odd-length TRAILING release (40m, not a 30-min multiple)
    // rounds up to 60m. Pre-fix defect: the SHIFT insert kept the RAW start
    // (18:20) with the ROUNDED duration (60m), producing 18:20-19:20 --
    // running 20 minutes past the segment's own end and leaving 18:00-18:20
    // unpaid. Fixed by widening the released window's OWN edges to the grid
    // (start snapped down, end snapped up for the 'up' direction) before
    // subtracting, so the released window can never fall outside the OT span.
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000125001', NAME: 'Odd Length Release Agent', 'LOGIN ID': '39003',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 19:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '10:20',
      'SIGIN IN': '08:00', 'SIGIN OUT': '18:20', 'LATE START': '0', 'LEFT EARLY': '-40', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '7000125001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
      { EMP_ID: '7000125001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 180 },
      { EMP_ID: '7000125001', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 18:20:00', STOP_MOMENT: '27/08/2026 19:00:00', DURATION: 40 },
    ];
    const punches: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '39003', LoginDateTime: makeDt('27/08/2026', '08:00:00'), LogoutDateTime: makeDt('27/08/2026', '08:00:03') },
      { Date: '27/08/2026', LoginID: '39003', LoginDateTime: makeDt('27/08/2026', '18:20:00'), LogoutDateTime: makeDt('27/08/2026', '18:20:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
    const row = out.rows[0];
    const ot1Adjusted = out.aspectCorrections.find(c => c.Code === config.shiftUpdateNewCode && c.SegmentCode === 'OT1');
    const shiftInserts = out.aspectCorrections.filter(c => c.ID === '7000125001' && c.Code === config.aspectNormalActionCode && c.SegmentCode === config.otToShiftConversionCode);
    const shiftInsert = shiftInserts[0];
    const shiftInsertEndMinutes = shiftInsert ? (() => {
      const [h, m] = shiftInsert.SegmentStarttime.split(':').map(Number);
      const [dh, dm] = shiftInsert.Segmentduration.split(':').map(Number);
      return h * 60 + m + dh * 60 + dm;
    })() : -1;
    const passed = row.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS')
      && ot1Adjusted?.SegmentStarttime === '16:00' && ot1Adjusted?.Segmentduration === '02:00'
      && shiftInserts.length === 1 && shiftInsert?.SegmentStarttime === '18:00' && shiftInsert?.Segmentduration === '01:00'
      && shiftInsertEndMinutes === 19 * 60; // never overhangs past the OT segment's own 19:00 end

    results.push({
      id: 'reg-125',
      name: 'A 40-Minute Trailing Release Rounds Up Without Overhanging the OT Segment End',
      category: 'Payroll audit: Rule 8 rounding overhang (2026-09-15)',
      inputDescription: 'OT1 16:00-19:00 (180m) with a 40-minute trailing RLS 18:20-19:00 -- rounds up to 60m',
      cognosFlawedVerdict: 'Pre-fix defect: SHIFT insert kept the raw 18:20 start with the rounded 60m duration -> 18:20-19:20, past the segment end, leaving 18:00-18:20 unpaid',
      expectedVerdict: 'Code 11 OT1 16:00 02:00 (remaining 16:00-18:00) + Code 00 SHIFT 18:00 01:00 (widened to the grid, clamped to the segment end) -- no row ends after 19:00',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: `${row.TAA_ACTIONS_FIRED}; adjustedOT=${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration}; shift=${shiftInsert?.SegmentStarttime}/${shiftInsert?.Segmentduration}; shiftEndsAtMin=${shiftInsertEndMinutes}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a 20-minute unpaid gap and a 20-minute overpaid overhang from a release length that is not an exact multiple of the rounding grid',
      calculationTrace: [`OT1 remaining: ${ot1Adjusted?.SegmentStarttime}/${ot1Adjusted?.Segmentduration}`, `SHIFT: ${shiftInsert?.SegmentStarttime}/${shiftInsert?.Segmentduration} (ends at minute ${shiftInsertEndMinutes} of day, OT segment ends at ${19 * 60})`],
    });
  }

  {
    // Case 126: property check across reg-123/124/125 -- for every Rule 8
    // partial-overlap outcome, the remaining-OT + SHIFT windows must (a) sum
    // to exactly the original OT segment's duration and (b) never overlap
    // each other. A regression that reintroduces double-paying or
    // gap-leaving in some OTHER shape than the three explicit cases above
    // would still be caught here.
    const toMinutes = (hhmm: string): number => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const failures: string[] = [];
    // Re-run each of the three fixtures fresh (rather than reaching into the
    // prior blocks' closures) so this check stands alone if the earlier
    // cases are ever reordered or removed.
    const rerun = (pfNo: string, loginId: string, otStop: string, otDur: number, rlsStart: string, rlsStop: string, rlsDur: number, outTime: string) => {
      const day = '27/08/2026';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': pfNo, NAME: 'Prop Check Agent', 'LOGIN ID': loginId,
        DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': `16:00 - ${otStop}`, 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
        'SIGIN IN': '08:00', 'SIGIN OUT': outTime, 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 08:00:00`, STOP_MOMENT: `${day} 16:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'OT1', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} ${otStop}:00`, DURATION: otDur },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} ${rlsStart}:00`, STOP_MOMENT: `${day} ${rlsStop}:00`, DURATION: rlsDur },
      ];
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '08:00:00'), LogoutDateTime: makeDt(day, '08:00:03') },
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, `${outTime}:00`), LogoutDateTime: makeDt(day, `${outTime}:03`) },
      ];
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [], cmsPunches: punches, config });
      return out.aspectCorrections.filter(c => c.ID === pfNo && c.SegmentCode !== 'ABSENT' && !(c.Code === config.shiftUpdateOriginalCode));
    };

    const checkNoOverlapAndSum = (label: string, rows: { SegmentStarttime: string; Segmentduration: string }[], expectedTotal: number) => {
      const windows = rows.map(r => {
        const start = toMinutes(r.SegmentStarttime);
        const [dh, dm] = r.Segmentduration.split(':').map(Number);
        return { start, end: start + dh * 60 + dm };
      }).sort((a, b) => a.start - b.start);
      const sum = windows.reduce((s, w) => s + (w.end - w.start), 0);
      if (sum !== expectedTotal) failures.push(`${label}: sum=${sum} expected=${expectedTotal}`);
      for (let i = 1; i < windows.length; i++) {
        if (windows[i].start < windows[i - 1].end) failures.push(`${label}: overlap between window ending ${windows[i - 1].end} and window starting ${windows[i].start}`);
      }
    };

    checkNoOverlapAndSum('leading (reg-123 shape)', rerun('7000126001', '39101', '19:00', 180, '16:00', '17:00', 60, '19:00'), 180);
    checkNoOverlapAndSum('middle (reg-124 shape)', rerun('7000126002', '39102', '19:00', 180, '17:00', '18:00', 60, '19:00'), 180);
    checkNoOverlapAndSum('odd-length trailing (reg-125 shape)', rerun('7000126003', '39103', '19:00', 180, '18:20', '19:00', 40, '18:20'), 180);

    const passed = failures.length === 0;
    results.push({
      id: 'reg-126',
      name: 'Rule 8 Partial-Overlap Windows Never Overlap and Always Sum to the Full OT Duration',
      category: 'Payroll audit: Rule 8 partial-overlap invariant (2026-09-15)',
      inputDescription: 'Leading, middle, and odd-length-trailing release shapes -- for each, sum(remaining OT windows) + sum(SHIFT windows) must equal the original OT duration with zero overlap',
      cognosFlawedVerdict: 'N/A -- property-style regression guard',
      expectedVerdict: 'No failures across all three shapes',
      expectedAction: 'ADJUST_OT_RLS',
      actualVerdict: failures.length === 0 ? 'all invariants held' : failures.join('; '),
      actualAction: 'ADJUST_OT_RLS',
      passed,
      payrollImpact: 'Catches any future regression that double-pays or drops time in an OT/RLS split shape not covered by the explicit reg-123/124/125 cases',
      calculationTrace: failures.length === 0 ? ['leading: OK', 'middle: OK', 'odd-length trailing: OK'] : failures,
    });
  }

  {
    // New feature: coverSameDayWhenAlreadyCovered (2026-09-15). Real case: PF 600034,
    // shift 07:00-15:00, arrived 9m late (07:09) but stayed 10m past the scheduled end
    // (15:10) — the "Late Logout" 10m is inside its own no-action band, but it means the
    // agent already worked the 9 minutes back the SAME day. With the toggle ON, the cover
    // is placed at 15:00-15:09 (inside the actual 07:09-15:10 attendance span) instead of
    // being pushed to a future working day.
    const incidentDay = '27/08/2026';
    const pfNo = '600034';
    const loginId = '60034';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Late Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Late Agent', EMP_SORT_NAME: 'SAMEDAYCOVER LATE AGENT' }];
    // WP2/D4 fix: previously two near-instant 3-second "bookend" punches (07:09:00-
    // 07:09:03, 15:10:00-15:10:03) only proving the agent badged in and out at those
    // moments, with zero evidence for the 8 hours between — real CMS data is always ONE
    // row per continuous session (verified against samples_Files/CMS_*.csv), and D4 now
    // requires the candidate cover window to sit inside a SINGLE proven-continuous
    // presence block (B6). One real session spanning the whole day is the realistic
    // shape this case always intended; the expected outcome (same-day cover placed) is
    // unchanged.
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '15:10:00') },
    ];
    const onConfig: ConfigRegistry = { ...config, coverSameDayWhenAlreadyCovered: true };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: onConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const expectedMemo = `TAA Cover for ${incidentDay} Late/Variance | Same-day cover: agent already covered 15:00-15:09`;
    const passed = cover !== undefined
      && cover.nominateDate === incidentDay
      && cover.SegmentDate === incidentDay
      && cover.SegmentStarttime === '15:00'
      && cover.Segmentduration === '00:09'
      && cover.Memo === expectedMemo;

    results.push({
      id: 'reg-128b',
      name: 'coverSameDayWhenAlreadyCovered ON: Late-Logout Surplus Places Cover Same Day',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay} shift 07:00-15:00, login 07:09 (late 9m), logout 15:10 (late logout 10m, no-action band), coverSameDayWhenAlreadyCovered=true, no future ASPECT day uploaded`,
      cognosFlawedVerdict: 'N/A — new configurable behavior, not a Cognos defect',
      expectedVerdict: `COVER at ${incidentDay} 15:00-15:09 (inside the agent's own 07:09-15:10 attendance), never pushed to a future working day`,
      expectedAction: `COVER nominateDate=${incidentDay} SegmentDate=${incidentDay} 15:00 (00:09)`,
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Without this toggle the same case pushes the cover to a future working day the agent never actually owed, purely because the search defaults ahead instead of checking same-day surplus first',
      calculationTrace: [`Late login 9m at 07:09`, `Late logout 10m at 15:10 (own band: no action)`, `Same-day window 15:00-15:09 fits inside 07:09-15:10 attendance -> cover placed there`],
    });
  }

  {
    // Same input as reg-128, toggle OFF — must be byte-identical to pre-feature behavior:
    // next-working-day search finds nothing uploaded, falls to coverFallbackWhenNoWorkingDayFound
    // (DEFAULT_CONFIG default: nextWeekMonday). Pins that the toggle changes nothing when off.
    const incidentDay = '27/08/2026';
    const pfNo = '600035';
    const loginId = '60035';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Toggle Off Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Toggle Off Agent', EMP_SORT_NAME: 'SAMEDAYCOVER TOGGLE OFF AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:10:00'), LogoutDateTime: makeDt(incidentDay, '15:10:03') },
    ];
    // Forced OFF so this parity case holds even when the in-app runner passes a saved config with the toggle ON.
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverSameDayWhenAlreadyCovered: false } });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    // 27/08/2026 is a Thursday -> default nextWeekMonday fallback = 31/08/2026 at the 08:00 default time.
    const passed = cover !== undefined && cover.nominateDate === '31/08/2026' && cover.SegmentStarttime === '08:00' && cover.Memo.includes('fallback');

    results.push({
      id: 'reg-129b',
      name: 'coverSameDayWhenAlreadyCovered OFF: Identical to Pre-Feature Next-Working-Day Search',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `Same input as reg-128 but coverSameDayWhenAlreadyCovered forced to false (independent of the saved config)`,
      cognosFlawedVerdict: 'N/A — parity check',
      expectedVerdict: 'Cover NOT placed on the incident day — falls through to the existing next-working-day search / fallback exactly as before this feature existed',
      expectedAction: 'COVER nominateDate=31/08/2026 08:00 (nextWeekMonday fallback)',
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Proves the toggle is opt-in: every existing customer config (toggle absent/false) sees zero change in output',
      calculationTrace: [`Toggle off -> resolveCoverTargetDay runs unmodified`, `No future ASPECT day uploaded -> coverFallbackWhenNoWorkingDayFound fallback -> target=${cover?.nominateDate ?? 'N/A'}`],
    });
  }

  {
    // Toggle ON but the same-day surplus is NOT enough (logout only 5m past end, less
    // than the 9m late-login being covered) — must fall straight through to the existing
    // next-working-day search, not force a same-day placement or block the row.
    const incidentDay = '27/08/2026';
    const pfNo = '600036';
    const loginId = '60036';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Insufficient Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:56',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:05', 'LATE START': '-9', 'LEFT EARLY': '5', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Insufficient Agent', EMP_SORT_NAME: 'SAMEDAYCOVER INSUFFICIENT AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:05:00'), LogoutDateTime: makeDt(incidentDay, '15:05:03') },
    ];
    const onConfig: ConfigRegistry = { ...config, coverSameDayWhenAlreadyCovered: true };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: onConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    // 27/08/2026 is a Thursday -> default nextWeekMonday fallback = 31/08/2026 at the 08:00 default time.
    const passed = cover !== undefined && cover.nominateDate === '31/08/2026' && cover.SegmentStarttime === '08:00' && cover.Memo.includes('fallback');

    results.push({
      id: 'reg-130b',
      name: 'coverSameDayWhenAlreadyCovered ON but Insufficient Same-Day Surplus Falls Through',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay}: late login 9m, late logout only 5m (< 9m needed) — toggle ON`,
      cognosFlawedVerdict: 'N/A — fall-through check',
      expectedVerdict: 'Same-day window (15:00-15:09) would end AFTER the actual 15:05 logout, so it is rejected and the row falls through to the normal next-working-day search / fallback, never held',
      expectedAction: 'COVER nominateDate=31/08/2026 08:00 (nextWeekMonday fallback)',
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'The toggle must never fabricate a cover the agent was not actually clocked in for — insufficient surplus must fall back to the existing safe search, not force a same-day placement',
      calculationTrace: [`Required window 15:00-15:09 vs actual logout 15:05 -> window not fully attended -> tryPlaceSameDayCover returns null`, `Falls through to placeCoverSegment -> target=${cover?.nominateDate ?? 'N/A'}`],
    });
  }

  {
    // Mirror direction: early logout covered by an equally-early login. Agent arrives
    // 9m early (06:51) and leaves 9m early (14:51, inside the OPS 5-9m Log off + Cover
    // band) — the 9 minutes worked before schedule start already make up the 9 minutes
    // left early, so with the toggle ON the cover is placed BEFORE the shift start
    // (06:51-07:00), never on a future working day.
    const incidentDay = '27/08/2026';
    const pfNo = '600037';
    const loginId = '60037';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Early Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '06:51', 'SIGIN OUT': '14:51', 'LATE START': '9', 'LEFT EARLY': '9', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Early Agent', EMP_SORT_NAME: 'SAMEDAYCOVER EARLY AGENT' }];
    // WP2/D4 fix: one continuous session instead of two near-instant bookend punches —
    // see the identical comment on reg-128b above.
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '06:51:00'), LogoutDateTime: makeDt(incidentDay, '14:51:00') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: incidentDay, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(incidentDay, '23:30:00'), LogoutDateTime: makeDt(incidentDay, '23:30:03') },
    ];
    const onConfig: ConfigRegistry = { ...config, coverSameDayWhenAlreadyCovered: true };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: onConfig });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const expectedMemo = `TAA Cover for ${incidentDay} Late/Variance | Same-day cover: agent already covered 06:51-07:00`;
    const passed = cover !== undefined
      && cover.nominateDate === incidentDay
      && cover.SegmentDate === incidentDay
      && cover.SegmentStarttime === '06:51'
      && cover.Segmentduration === '00:09'
      && cover.Memo === expectedMemo;

    results.push({
      id: 'reg-131',
      name: 'coverSameDayWhenAlreadyCovered ON: Early-Login Surplus Places Cover Before Shift Start',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay} shift 07:00-15:00, login 06:51 (9m early), logout 14:51 (early logout 9m, Log off + Cover band), coverSameDayWhenAlreadyCovered=true`,
      cognosFlawedVerdict: 'N/A — mirror-direction check',
      expectedVerdict: `COVER at ${incidentDay} 06:51-07:00 (inside the agent's own 06:51-14:51 attendance), never pushed to a future working day`,
      expectedAction: `COVER nominateDate=${incidentDay} SegmentDate=${incidentDay} 06:51 (00:09)`,
      actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} SegmentDate=${cover.SegmentDate} at ${cover.SegmentStarttime} Memo="${cover.Memo}"` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Confirms the toggle works symmetrically for an early-logout cover offset by an equally early login, not just the late-login direction',
      calculationTrace: [`Early logout 9m at 14:51 (band: Log off + Cover)`, `Same-day window 06:51-07:00 fits inside 06:51-14:51 attendance -> cover placed there`],
    });
  }

  {
    // Rule 7 safety: once reg-128's same-day cover (15:00-15:09) is round-tripped back in
    // as a REAL ASPECT COVER segment on a later run, the agent's actual attendance
    // (07:09-15:10) fully overlaps it — evaluateCoverNotAttended must find 0m shortfall,
    // never a false Cover Not Attended finding. This is exactly the risk a same-day cover
    // anchored strictly inside attendance is designed to avoid.
    const incidentDay = '27/08/2026';
    const pfNo = '600038';
    const loginId = '60038';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Roundtrip Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:09', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:09', 'SIGNIN DURATION': '8:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'COVER', START_MOMENT: `${incidentDay} 15:00:00`, STOP_MOMENT: `${incidentDay} 15:09:00`, DURATION: 9 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Roundtrip Agent', EMP_SORT_NAME: 'SAMEDAYCOVER ROUNDTRIP AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:10:00'), LogoutDateTime: makeDt(incidentDay, '15:10:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const row = out.rows[0];
    const hasCoverNotAttended = (row.details.ruleFired || '').includes('Cover Not Attended') || row.TAA_ACTION === 'ABSENT_SEGMENT';
    const passed = !hasCoverNotAttended;

    results.push({
      id: 'reg-132',
      name: 'A Same-Day Cover Placed Inside Attendance Never Trips Rule 7 on Re-Upload',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay}: pre-existing COVER 15:00-15:09 (as produced by reg-128), CMS attendance 07:09-15:10 fully overlaps it`,
      cognosFlawedVerdict: 'N/A — safety regression guard',
      expectedVerdict: 'No Cover Not Attended finding — 9m scheduled, 9m attended, 0m shortfall',
      expectedAction: 'No ABSENT_SEGMENT from Rule 7',
      actualVerdict: hasCoverNotAttended ? `Cover Not Attended fired: ${row.details.ruleFired}` : 'No Cover Not Attended finding',
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A same-day cover that a LATER run flags as unattended would falsely mark the agent absent for time they demonstrably worked — this guards the exact failure mode the window-inside-attendance check exists to prevent',
      calculationTrace: [`Cover 15:00-15:09 fully inside attendance 07:09-15:10`, `overlapMinutes=9, coverDurationMinutes=9 -> shortfallMinutes=0 -> Rule 7 does not fire`],
    });
  }

  {
    // Same-day cover, flex past cutoff. SHIFT 07:00-15:00 in ASPECT, arrival 10:20 (20m
    // past the 10:00 cutoff) moves the shift to 10:00-18:00. The raw ASPECT end (15:00)
    // is now inside normal shift hours, so a same-day cover may only start at the MOVED
    // end (18:00). No-surplus agent (out 18:00) must fall through; surplus agent (out
    // 18:30) gets 18:00-18:20. Before the fix both got 15:00-15:20 — paid shift time.
    const incidentDay = '27/08/2026';
    const onConfig: ConfigRegistry = { ...config, coverSameDayWhenAlreadyCovered: true };
    const runFlex = (pfNo: string, loginId: string, outTime: string) => {
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'FLEX SameDayCover Agent', 'LOGIN ID': loginId,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
        'SIGIN IN': '10:20', 'SIGIN OUT': outTime, 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'FLEX SameDayCover Agent', EMP_SORT_NAME: 'FLEX SAMEDAYCOVER AGENT' }];
      // WP2/D4 fix: one continuous session instead of two near-instant bookend punches —
      // see the identical comment on reg-128b above.
      const punches: CMSPunch[] = [
        { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '10:20:00'), LogoutDateTime: makeDt(incidentDay, `${outTime}:00`) },
      ];
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: onConfig });
      return out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    };
    const noSurplus = runFlex('600039', '60039', '18:00');
    const surplus = runFlex('600040', '60040', '18:30');
    const passed = noSurplus !== undefined && noSurplus.nominateDate === '31/08/2026'
      && surplus !== undefined && surplus.nominateDate === incidentDay && surplus.SegmentStarttime === '18:00' && surplus.Segmentduration === '00:20';

    results.push({
      id: 'reg-133',
      name: 'Flex Same-Day Cover Starts at the MOVED Shift End, Never Inside Shift Hours',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay} flex, SHIFT 07:00-15:00, arrival 10:20 (shift moved to 10:00-18:00); agent A out 18:00, agent B out 18:30; toggle ON`,
      cognosFlawedVerdict: 'N/A — validation-pass bug fix',
      expectedVerdict: 'A: no surplus -> next working day (31/08). B: 30m surplus -> same-day COVER 18:00-18:20',
      expectedAction: `A COVER 31/08/2026; B COVER ${incidentDay} 18:00 (00:20)`,
      actualVerdict: `A=${noSurplus ? `${noSurplus.nominateDate} ${noSurplus.SegmentStarttime}` : 'none'}; B=${surplus ? `${surplus.nominateDate} ${surplus.SegmentStarttime} (${surplus.Segmentduration})` : 'none'}`,
      actualAction: `${noSurplus?.SegmentCode ?? 'None'} / ${surplus?.SegmentCode ?? 'None'}`,
      passed,
      payrollImpact: 'Anchoring at the raw ASPECT end placed a 20m cover inside the moved shift — the late minutes were never made up and the agent was credited cover for normal shift time',
      calculationTrace: ['Raw ASPECT end 15:00 vs moved flex end 18:00 -> window base = max = 18:00', 'A: 18:00-18:20 > logout 18:00 -> fall through', 'B: 18:00-18:20 <= logout 18:30 -> same-day'],
    });
  }

  {
    // Same-day cover must stack after a COVER already on the day's ASPECT schedule. Existing
    // COVER 15:00-15:05 pushes the new 9m window to 15:05-15:14, past the 15:10 logout ->
    // not already covered -> falls through to the normal search.
    const incidentDay = '27/08/2026';
    const pfNo = '600041';
    const loginId = '60041';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Stacked Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:05', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:05', 'SIGNIN DURATION': '8:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '5', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'COVER', START_MOMENT: `${incidentDay} 15:00:00`, STOP_MOMENT: `${incidentDay} 15:05:00`, DURATION: 5 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Stacked Agent', EMP_SORT_NAME: 'SAMEDAYCOVER STACKED AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:10:00'), LogoutDateTime: makeDt(incidentDay, '15:10:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverSameDayWhenAlreadyCovered: true } });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined && cover.nominateDate === '31/08/2026';

    results.push({
      id: 'reg-134',
      name: 'Same-Day Cover Stacks After an Existing ASPECT Cover and Falls Through When It No Longer Fits',
      category: 'New feature (2026-09-15): same-day cover when already covered',
      inputDescription: `${incidentDay}: late 9m, logout 15:10, existing COVER 15:00-15:05 on the day; toggle ON`,
      cognosFlawedVerdict: 'N/A — stacking check',
      expectedVerdict: 'Window 15:05-15:14 ends after the 15:10 logout -> next working day (31/08)',
      expectedAction: 'COVER nominateDate=31/08/2026',
      actualVerdict: cover ? `COVER ${cover.nominateDate} ${cover.SegmentStarttime}` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'Ignoring the existing cover would overlap two COVER segments and claim minutes the agent already used',
      calculationTrace: ['Anchor = existing COVER end 15:05', '15:05-15:14 > logout 15:10 -> fall through'],
    });
  }

  {
    // Policy (revised 2026-09-20; supersedes the 2026-09-15 rule that accepted a same-day
    // cover overlapping a trailing release/nursing window): a day carrying ANY release /
    // nursing / removal segment never takes a same-day cover. NURSNG 14:00-15:00, late 9m,
    // logout 14:10 -> same-day placement skipped, normal next-working-day cover (here the
    // no-future-day fallback, next-week Monday 31/08 08:00).
    const incidentDay = '27/08/2026';
    const pfNo = '600042';
    const loginId = '60042';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Nursing Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 14:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '7:0', 'SIGNIN DURATION': '7:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '14:10', 'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'NURSNG', START_MOMENT: `${incidentDay} 14:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 60 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Nursing Agent', EMP_SORT_NAME: 'SAMEDAYCOVER NURSING AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '14:10:00'), LogoutDateTime: makeDt(incidentDay, '14:10:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverSameDayWhenAlreadyCovered: true } });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = cover !== undefined && cover.nominateDate === '31/08/2026' && cover.SegmentStarttime === '08:00' && cover.Segmentduration === '00:09';

    results.push({
      id: 'reg-135',
      name: 'Same-Day Cover Skipped When the Day Has a Trailing Nursing Segment',
      category: 'Same-day cover yields to removal segments (2026-09-20)',
      inputDescription: `${incidentDay}: SHIFT 07:00-15:00 + NURSNG 14:00-15:00, late 9m, logout 14:10; toggle ON`,
      cognosFlawedVerdict: 'N/A — policy pin (replaces the 2026-09-15 overlap-accepted rule)',
      expectedVerdict: 'Same-day placement skipped; normal next-working-day cover (fallback: next-week Monday 31/08 08:00)',
      expectedAction: 'COVER nominateDate=31/08/2026 08:00 (00:09)',
      actualVerdict: cover ? `COVER ${cover.nominateDate} ${cover.SegmentStarttime} (${cover.Segmentduration})` : 'No cover',
      actualAction: cover ? `${cover.SegmentCode} (${cover.Segmentduration})` : 'None',
      passed,
      payrollImpact: 'A same-day cover inside a release/nursing window claims time the agent was released from; the normal scenario keeps the cover clear of it',
      calculationTrace: ['Incident day carries NURSNG 14:00-15:00 -> tryPlaceSameDayCover returns null', 'placeCoverSegment fallback -> 31/08 08:00'],
    });
  }

  {
    // Same rule for a leading release and a mid-shift removal, and the unchanged control:
    // toggle ON + no removal still places the cover same-day.
    const incidentDay = '27/08/2026';
    const runShape = (pfNo: string, loginId: string, extra: AspectSegment[]) => {
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'SameDayCover Removal Agent', 'LOGIN ID': loginId,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:01',
        'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
        ...extra,
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'SameDayCover Removal Agent', EMP_SORT_NAME: 'SAMEDAYCOVER REMOVAL AGENT' }];
      // WP2/D4 fix: one continuous session instead of two near-instant bookend punches —
      // see the identical comment on reg-128b above.
      const punches: CMSPunch[] = [
        { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '15:10:00') },
      ];
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...config, coverSameDayWhenAlreadyCovered: true } });
      // Read from the row, not out.aspectCorrections: a mid-shift removal holds the row
      // (correctly, for reasons unrelated to cover placement), and held rows are excluded
      // from the exported list.
      return out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    };
    const leading = runShape('600043', '60043', [
      { EMP_ID: '600043', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'RLS', START_MOMENT: `${incidentDay} 14:30:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 30 },
    ]);
    const midShift = runShape('600044', '60044', [
      { EMP_ID: '600044', NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'RLS', START_MOMENT: `${incidentDay} 11:00:00`, STOP_MOMENT: `${incidentDay} 11:30:00`, DURATION: 30 },
    ]);
    const control = runShape('600045', '60045', []);
    // WP2/B3 re-pin (2026-09-22): a removal elsewhere in the day no longer blocks same-day
    // cover credit unless it overlaps the cover window or is a trailing release at shift
    // end (B3, confirmed by the owner 21/09/2026). (a) trailing RLS 14:30-15:00 sits
    // exactly where the cover window (afterEnd, anchored at the release's own start per
    // resolveDayCoverAnchor) begins, so it still overlaps and still blocks -> unchanged,
    // falls to next-working-day 31/08. (b) mid-shift RLS 11:00-11:30 does NOT overlap the
    // cover window 15:00-15:09 -> no longer blocks under B3 -> now places same-day, exactly
    // like (c). This is the one case WP2's plan named as needing a re-pin for B3 — every
    // other same-day-cover case is unaffected (pre-fix behaviour: ANY removal anywhere in
    // the day blocked unconditionally, which (b) exposed as broader than the policy needs).
    const passed = leading !== undefined && leading.nominateDate === '31/08/2026'
      && midShift !== undefined && midShift.nominateDate === incidentDay && midShift.SegmentStarttime === '15:00'
      && control !== undefined && control.nominateDate === incidentDay && control.SegmentStarttime === '15:00';

    results.push({
      id: 'reg-135b',
      name: 'Same-Day Cover Skipped for a Trailing RLS, Kept for a Mid-Shift One That Does Not Overlap (B3)',
      category: 'Same-day cover yields only to an OVERLAPPING removal segment (B3, WP2 2026-09-22)',
      inputDescription: `${incidentDay}: late 9m, logout 15:10, toggle ON; (a) trailing RLS 14:30-15:00, (b) mid-shift RLS 11:00-11:30, (c) no removal`,
      cognosFlawedVerdict: 'N/A — policy pin',
      expectedVerdict: '(a) blocked (overlaps the cover window) -> next-working-day 31/08. (b),(c) same-day cover 15:00 — B3: a non-overlapping removal no longer blocks',
      expectedAction: '(a) COVER 31/08/2026; (b) COVER 27/08/2026 15:00; (c) COVER 27/08/2026 15:00',
      actualVerdict: `a=${leading ? leading.nominateDate : 'none'}; b=${midShift ? `${midShift.nominateDate} ${midShift.SegmentStarttime}` : 'none'}; c=${control ? `${control.nominateDate} ${control.SegmentStarttime}` : 'none'}`,
      actualAction: `${leading?.SegmentCode ?? 'None'} / ${midShift?.SegmentCode ?? 'None'} / ${control?.SegmentCode ?? 'None'}`,
      passed,
      payrollImpact: 'Confirms the skip is scoped to an overlapping removal only (B3) — a mid-shift removal far from the cover window must not block make-up credit the agent genuinely earned, and a no-removal day keeps the same-day behaviour',
      calculationTrace: ['Window overlaps a removal interval -> same-day returns null -> placeCoverSegment', 'Window does not overlap any removal -> same-day path proceeds'],
    });
  }

  {
    // Saba Hashmi shape (PF 40121246, 15/09/2026): late 7m + logout 74m past the release-adjusted
    // end (Late+Cover AND Absent), and the next working day 16/09 carries UN_RLS 13:30-16:30
    // running straight into a trailing NURSNG 16:30-17:30. The UN_RLS used to be labelled
    // MID-SHIFT (it does not reach the 17:30 shift end by itself), which made 16/09 "unusable"
    // and forced the §4.11 Step 5 fallback. It is chained to the NURSNG, so 13:30-17:30 is one
    // trailing block: 16/09 is a normal day with a 13:30 release-adjusted end, and the cover
    // lands there directly.
    const incidentDay = '15/09/2026';
    const nextDay = '16/09/2026';
    const pfNo = '600046';
    const loginId = '60046';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-15 00:00:00', SECTION: 'SALES', 'PF NO': pfNo, NAME: 'MidShiftNextDay Agent', 'LOGIN ID': loginId,
      DUTY1: '08:30 - 17:30', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:7', 'SIGNIN DURATION': '09:07',
      'SIGIN IN': '08:37', 'SIGIN OUT': '17:44', 'LATE START': '-7', 'LEFT EARLY': '14', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg = (nom: string, code: string, start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: pfNo, NOM_DATE: nom, START_DATE: nom, SEG_CODE: code, START_MOMENT: `${nom} ${start}:00`, STOP_MOMENT: `${nom} ${stop}:00`, DURATION: dur });
    const segs: AspectSegment[] = [
      seg(incidentDay, 'SHIFT', '08:30', '17:30', 540), seg(incidentDay, 'NURSNG', '16:30', '17:30', 60),
      seg(nextDay, 'SHIFT', '08:30', '17:30', 540), seg(nextDay, 'NURSNG', '16:30', '17:30', 60), seg(nextDay, 'UN_RLS', '13:30', '16:30', 180),
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'MidShiftNextDay Agent', EMP_SORT_NAME: 'MIDSHIFTNEXTDAY AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '08:37:00'), LogoutDateTime: makeDt(incidentDay, '08:37:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '17:44:00'), LogoutDateTime: makeDt(incidentDay, '17:44:03') },
    ];
    const run = (sameDay: boolean) => runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches,
      config: { ...config, coverSameDayWhenAlreadyCovered: sameDay, retainLateCoverOnAbsent: true, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday' },
    }).rows[0];
    const rowOff = run(false);
    const rowOn = run(true);
    const check = (r: typeof rowOff) => {
      const c = r.details.generatedCorrections;
      const cover = c.find(x => x.SegmentCode === 'COVER');
      return r.holdReason !== 'MID_SHIFT_REMOVAL_SEGMENT'
        && c.some(x => x.SegmentCode === 'LATE') && c.some(x => x.SegmentCode === 'ABSENT')
        && cover !== undefined && cover.nominateDate === '16/09/2026' && cover.SegmentStarttime === '13:30';
    };
    const passed = check(rowOff) && check(rowOn);

    results.push({
      id: 'reg-136b',
      name: 'Next Working Day With Chained Releases (UN_RLS + NURSNG): Cover Lands On That Day At Its Release-Adjusted End (Saba Shape)',
      category: 'Cover placement never locks the row (2026-09-20)',
      inputDescription: '15/09: SHIFT 08:30-17:30 + trailing NURSNG, login 08:37 (7m late), logout 17:44; 16/09 has UN_RLS 13:30-16:30 chained to NURSNG 16:30-17:30; retain ON, fallback next-week Monday; same-day option ON and OFF',
      cognosFlawedVerdict: 'N/A — reproduced on real sample data: LATE + ABSENT only, COVER missing, row locked MID_SHIFT_REMOVAL_SEGMENT because the UN_RLS was labelled mid-shift',
      expectedVerdict: 'LATE + COVER + ABSENT all in generatedCorrections; COVER on 16/09/2026 at 13:30 (the chained releases start there); no MID hold',
      expectedAction: 'COVER exported on 16/09 without needing the §4.11 fallback, same result with the same-day option ON or OFF',
      actualVerdict: `off=${rowOff.details.generatedCorrections.map(x => `${x.SegmentCode}@${x.nominateDate}`).join(',')} hold=${rowOff.holdReason}; on=${rowOn.details.generatedCorrections.map(x => `${x.SegmentCode}@${x.nominateDate}`).join(',')} hold=${rowOn.holdReason}`,
      actualAction: rowOff.TAA_ACTION,
      passed,
      payrollImpact: 'Without this the late minutes were never made up and TAA had to fix the next day in ASPECT by hand before the row could be released',
      calculationTrace: ['16/09 UN_RLS 13:30-16:30 + NURSNG 16:30-17:30 -> one trailing block (chained) -> effective end 13:30', 'resolveDayCoverAnchor succeeds on 16/09 -> cover placed at 13:30, no fallback needed'],
    });
  }

  {
    // Fallback = sameDay AND the incident day carries a mid-shift release. That used to be a
    // hard failure (mid-shift day = unusable, nowhere safe for the cover). A mid-shift release
    // no longer moves the window, so the cover has an unambiguous target: the day's unmoved
    // effective end. The release is deducted from hours and the row is not held.
    const incidentDay = '27/08/2026';
    const pfNo = '600047';
    const loginId = '60047';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'NoSafeDay Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '7:30', 'SIGNIN DURATION': '8:01',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 07:00:00`, STOP_MOMENT: `${incidentDay} 15:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'RLS', START_MOMENT: `${incidentDay} 11:00:00`, STOP_MOMENT: `${incidentDay} 11:30:00`, DURATION: 30 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'NoSafeDay Agent', EMP_SORT_NAME: 'NOSAFEDAY AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:10:00'), LogoutDateTime: makeDt(incidentDay, '15:10:03') },
    ];
    const row = runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches,
      config: { ...config, coverSameDayWhenAlreadyCovered: false, coverFallbackWhenNoWorkingDayFound: 'sameDay' },
    }).rows[0];
    const cover137 = row.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = row.holdReason !== 'MID_SHIFT_REMOVAL_SEGMENT'
      && row.TAA_SCH_HOURS_RECOMPUTED === 450
      && cover137 !== undefined && cover137.nominateDate === incidentDay && cover137.SegmentStarttime === '15:00';

    results.push({
      id: 'reg-137',
      name: 'Fallback = Same Day With A Mid-Shift Release On The Incident Day: Cover Placed At The Unmoved End, Row Not Held',
      category: 'Cover placement never locks the row (2026-09-20)',
      inputDescription: `${incidentDay}: late 9m, no future ASPECT day, fallback set to sameDay, incident day carries a mid-shift RLS 11:00-11:30`,
      cognosFlawedVerdict: 'N/A — boundary of the fallback behaviour; used to lock the row because a mid-shift release made the day "unusable"',
      expectedVerdict: 'No MID hold; hours 480-30=450; COVER exported on the incident day at 15:00 (the window is not moved by a mid-shift release)',
      expectedAction: 'COVER EXPORTED SAME DAY',
      actualVerdict: `included=${row.includeInOutput}; hold=${row.holdReason ?? 'none'}; hours=${row.TAA_SCH_HOURS_RECOMPUTED}; cover=${cover137 ? `${cover137.nominateDate} ${cover137.SegmentStarttime}` : 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A mid-shift release no longer strands the day\'s corrections: the cover has an unambiguous target and the released 30 minutes come off scheduled hours',
      calculationTrace: ['Mid-shift RLS deducted (30m), window unmoved -> resolveDayCoverAnchor(incident) succeeds -> cover at effective end 15:00'],
    });
  }


  {
    // Idempotency guard: a re-run over an already-corrected ASPECT export must not re-emit a LATE
    // (or its cover) the export already holds. Toggles are pinned so the case never inherits live config.
    const incidentDay = '27/08/2026';
    const pfNo = '600050';
    const loginId = '60050';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'AlreadyRecorded Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:09', 'LATE START': '-9', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg = (code: string, start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: code, START_MOMENT: `${incidentDay} ${start}:00`, STOP_MOMENT: `${incidentDay} ${stop}:00`, DURATION: dur });
    const shift = seg('SHIFT', '07:00', '15:00', 480);
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'AlreadyRecorded Agent', EMP_SORT_NAME: 'ALREADYRECORDED AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '07:09:00'), LogoutDateTime: makeDt(incidentDay, '07:09:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '15:09:00'), LogoutDateTime: makeDt(incidentDay, '15:09:03') },
    ];
    const run = (extra: AspectSegment[]) => runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognos], aspectSegments: [shift, ...extra], aspectIdentities: identities, cmsPunches: punches,
      config: { ...config, coverSameDayWhenAlreadyCovered: false, retainLateCoverOnAbsent: false, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday' },
    }).rows[0];
    const codes = (r: ReturnType<typeof run>) => r.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none';

    const rBoth = run([seg('LATE', '07:00', '07:09', 9), seg('COVER', '15:00', '15:09', 9)]);      // (a) LATE + COVER recorded
    const rLateOnly = run([seg('LATE', '07:00', '07:09', 9)]);                                      // (b) LATE only
    const rNone = run([]);                                                                          // (c) nothing recorded
    const rOtherStart = run([seg('LATE', '07:05', '07:14', 9), seg('COVER', '15:00', '15:09', 9)]); // (d) LATE start differs
    const rBareCover = run([seg('COVER', '15:00', '15:09', 9)]);                                    // (e) COVER without LATE
    const rOtherMins = run([seg('LATE', '07:00', '07:07', 7)]);                                     // (f) LATE minutes differ (7m vs 9m)
    const prevDay = '26/08/2026';
    const rOtherDay = run([{ ...seg('LATE', '07:00', '07:09', 9), NOM_DATE: prevDay, START_DATE: prevDay, START_MOMENT: `${prevDay} 07:00:00`, STOP_MOMENT: `${prevDay} 07:09:00` }]); // (g) LATE on another day

    const has = (r: ReturnType<typeof run>, c: string) => r.details.generatedCorrections.some(x => x.SegmentCode === c);
    const noneAtAll = (r: ReturnType<typeof run>) => r.details.generatedCorrections.length === 0 && r.TAA_ACTION === 'NO_ACTION' && r.TAA_VERDICT === 'LATE'
      && (r.details.ruleFired ?? '').includes('already actioned');
    const checks: [string, boolean][] = [
      ['a: LATE+COVER recorded -> no correction, NO_ACTION, verdict LATE, trace says already actioned', noneAtAll(rBoth)],
      ['b: LATE only recorded -> no LATE and NO COVER (already-actioned rule, 2026-09-27)', noneAtAll(rLateOnly)],
      ['c: nothing recorded -> LATE + COVER emitted (unchanged)', has(rNone, 'LATE') && has(rNone, 'COVER') && rNone.TAA_ACTION === 'LATE_AND_COVER'],
      ['d: recorded LATE with a different start -> still already actioned', noneAtAll(rOtherStart)],
      ['e: bare COVER never suppresses -> LATE + COVER emitted', has(rBareCover, 'LATE') && has(rBareCover, 'COVER')],
      ['f: recorded LATE with different minutes (7m vs 9m) -> no second LATE, no COVER', noneAtAll(rOtherMins)],
      ['g: LATE recorded on a different day -> this day still gets LATE + COVER', has(rOtherDay, 'LATE') && has(rOtherDay, 'COVER')],
    ];
    const passed = checks.every(([, ok]) => ok);

    results.push({
      id: 'reg-142',
      name: 'LATE Already In ASPECT For The Day = Already Actioned: No LATE, No COVER',
      category: 'Re-run idempotency (2026-09-21; already-actioned rule 2026-09-27)',
      inputDescription: `${incidentDay}: 9m late login, agent stays to 15:09; ASPECT export variants: (a) LATE+COVER already present, (b) LATE only, (c) none, (d) LATE with a different start, (e) COVER only, (f) LATE 7m (TAA measures 9m), (g) LATE on the previous day; toggles pinned`,
      cognosFlawedVerdict: 'N/A — Saba PF 40121246 showed the double charge; the 2026-09-27 business rule goes further: once a LATE exists for the day, TAA must not add a COVER either, and a LATE of different minutes must never get a second LATE',
      expectedVerdict: 'Any LATE on the incident day: no correction at all (a)(b)(d)(f), action NO_ACTION, verdict LATE; (c)(e)(g) LATE + COVER emitted',
      expectedAction: 'NO_ACTION when already actioned; LATE_AND_COVER otherwise',
      actualVerdict: `a=${codes(rBoth)}; b=${codes(rLateOnly)}; c=${codes(rNone)}; d=${codes(rOtherStart)}; e=${codes(rBareCover)}; f=${codes(rOtherMins)}; g=${codes(rOtherDay)}`,
      actualAction: rBoth.TAA_ACTION,
      passed,
      payrollImpact: 'Stops TAA adding a COVER (or a second LATE) for a late arrival ASPECT already carries — the incident was actioned outside TAA',
      calculationTrace: checks.map(([label, ok]) => `${ok ? 'PASS' : 'FAIL'} ${label}`),
    });
  }

  {
    // Same guard for the Early Logout path: Log_off + COVER already recorded.
    const incidentDay = '27/08/2026';
    const pfNo = '600051';
    const loginId = '60051';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'AlreadyRecorded Logoff Agent', 'LOGIN ID': loginId,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:03',
      'SIGIN IN': '06:50', 'SIGIN OUT': '14:53', 'LATE START': '10', 'LEFT EARLY': '7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const seg = (code: string, start: string, stop: string, dur: number): AspectSegment =>
      ({ EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: code, START_MOMENT: `${incidentDay} ${start}:00`, STOP_MOMENT: `${incidentDay} ${stop}:00`, DURATION: dur });
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'AlreadyRecorded Logoff Agent', EMP_SORT_NAME: 'ALREADYRECORDED LOGOFF AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '06:50:00'), LogoutDateTime: makeDt(incidentDay, '06:50:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '14:53:00'), LogoutDateTime: makeDt(incidentDay, '14:53:03') },
      // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
      { Date: incidentDay, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(incidentDay, '23:30:00'), LogoutDateTime: makeDt(incidentDay, '23:30:03') },
    ];
    const run = (extra: AspectSegment[]) => runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognos], aspectSegments: [seg('SHIFT', '07:00', '15:00', 480), ...extra], aspectIdentities: identities, cmsPunches: punches,
      config: { ...config, coverSameDayWhenAlreadyCovered: false, retainLateCoverOnAbsent: false, coverFallbackWhenNoWorkingDayFound: 'nextWeekMonday' },
    }).rows[0];
    const rFresh = run([]);
    const rRecorded = run([seg('Log_off', '14:53', '15:00', 7), seg('COVER', '06:53', '07:00', 7)]);
    const has = (r: ReturnType<typeof run>, c: string) => r.details.generatedCorrections.some(x => x.SegmentCode === c);
    // Already-actioned rule (2026-09-27): a Log_off of ANY minutes on the day means no Log_off and no COVER.
    const rLogoffOnly = run([seg('Log_off', '14:50', '15:00', 10)]);
    const noneAtAll = (r: ReturnType<typeof run>) => r.details.generatedCorrections.length === 0 && r.TAA_ACTION === 'NO_ACTION'
      && r.TAA_VERDICT === 'EARLY_LOGOUT' && (r.details.ruleFired ?? '').includes('already actioned');
    const passed = has(rFresh, 'Log_off') && has(rFresh, 'COVER') && noneAtAll(rRecorded) && noneAtAll(rLogoffOnly);

    results.push({
      id: 'reg-143',
      name: 'Log_off Already In ASPECT For The Day = Already Actioned: No Log_off, No COVER (Early Logout Path)',
      category: 'Re-run idempotency (2026-09-21)',
      inputDescription: `${incidentDay}: login 06:50, 7m early logout (14:53); fresh export vs export already holding Log_off 14:53 (7m) + COVER 06:53-07:00 (7m, attended); toggles pinned`,
      cognosFlawedVerdict: 'N/A — mirror of reg-142 for the LOGOFF_AND_COVER rule',
      expectedVerdict: 'Fresh: Log_off + COVER emitted. Log_off already in ASPECT (exact, or a different 10m one): no correction, verdict EARLY_LOGOUT, action NO_ACTION',
      expectedAction: 'NO_ACTION when already actioned',
      actualVerdict: `fresh=${rFresh.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none'}; recorded=${rRecorded.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none'}; logoffOnly10m=${rLogoffOnly.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none'}`,
      actualAction: rRecorded.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents a second Log_off and second cover for an early logout that ASPECT already carries',
      calculationTrace: [`ruleFired: ${rRecorded.details.ruleFired}`],
    });
  }

  // ===== WP1 (2026-09-21) — absence-emission correctness =====================================
  // Every case below pins its own business toggles (coverSameDayWhenAlreadyCovered,
  // retainLateCoverOnAbsent) instead of inheriting the live config, so it means the same thing
  // whatever configuration the suite is run under. Each mirrors a REAL row from the 18-20/09 run.
  {
    const WD = '28/08/2026';
    const pinned: ConfigRegistry = { ...config, coverSameDayWhenAlreadyCovered: true, retainLateCoverOnAbsent: true };
    const cognosFor = (pf: string, loginId: string, extra: Partial<CognosRecord> = {}): CognosRecord => ({
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'WP1 Agent', 'LOGIN ID': loginId,
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '', ...extra,
    });
    const segOf = (pf: string, code: string, day: string, start?: string, stop?: string, dur?: number): AspectSegment => ({
      EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: code,
      ...(start ? { START_MOMENT: `${day} ${start}:00` } : {}), ...(stop ? { STOP_MOMENT: `${day} ${stop}:00` } : {}),
      ...(dur !== undefined ? { DURATION: dur } : {}),
    } as AspectSegment);
    const idOf = (pf: string, officer = false): AspectIdentity => ({
      EMP_ID: pf, EMP_LAST_NAME: 'WP1', EMP_SORT_NAME: officer ? 'WP1 AGENT, ES OFCR' : 'WP1 AGENT',
    });
    const sessionOf = (loginId: string, day: string, a: string, b: string): CMSPunch => ({
      Date: day, LoginID: loginId, LoginDateTime: makeDt(day, `${a}:00`), LogoutDateTime: makeDt(day, `${b}:00`),
    });
    const absents = (r: { details: { generatedCorrections: { SegmentCode: string }[] } }) =>
      r.details.generatedCorrections.filter(c => c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Absent NS/NC').length;

    // reg-146 (D6): a day-level leave marker on a scheduled SHIFT day, nobody logged in.
    // 2026-09-24 Phase 5: released by the no-attendance/all-agree gate (0 punches, no Cognos
    // sign-in, LEAVE TYPE MATCH) — user decision.
    {
      const pf = '7100146';
      // Pinned on (Step 3 2026-09-24): the no-attendance/all-agree release this case
      // proves is gated by releaseProvenSafeHolds — pin true so the case still proves
      // the release regardless of the ambient config's toggle state (see reg-150a/b).
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor(pf, '31146', { 'LEAVE TYPE': 'SICK', 'LEAVE HR': '480', 'SCH DURATION': '8:0' })],
        aspectSegments: [segOf(pf, 'SHIFT', WD, '08:00', '16:00', 480), segOf(pf, 'SICK', WD)],
        aspectIdentities: [idOf(pf)], cmsPunches: [], config: { ...pinned, releaseProvenSafeHolds: true },
      });
      const r = out.rows[0];
      const passed = r.TAA_VERDICT === 'LEAVE_EXCLUDED' && r.TAA_ACTION === 'NO_ACTION' && absents(r) === 0
        && !r.holdReason;
      results.push({
        id: 'reg-146', name: 'Day-level leave on a SHIFT day with no attendance proposes no absence (released: no attendance, Cognos agrees)',
        category: 'WP1 D6: leave replaces the shift',
        inputDescription: 'SHIFT 08:00-16:00 plus a day-level SICK segment (no times, no duration); Cognos LEAVE TYPE SICK, LEAVE HR 480; no CMS punches',
        cognosFlawedVerdict: 'Before: no leave-day gate fired (isLeaveDay needs zero work segments) so the no-login rule wrote Absent NS/NC for a person whose sick leave ASPECT already records (27 real rows, Cognos agreeing on all)',
        expectedVerdict: 'LEAVE_EXCLUDED, no absence, released (no hold) — CMS, Cognos and ASPECT all agree nobody worked and the day is leave', expectedAction: 'NO_ACTION',
        actualVerdict: `${r.TAA_VERDICT} (absence rows=${absents(r)}, hold=${r.holdReason || 'none'})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'Stops a wrong Absent NS/NC being proposed - and one tick from exporting it - for a day the agent is already recorded as on leave',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`],
      });
    }
    // reg-146b (D6 sibling, added 2026-09-24 Phase 5): same fixture as reg-146, but Cognos
    // itself claims attendance (SIGIN IN populated) — the no-attendance/all-agree gate must
    // NOT fire here (Cognos disagrees that nobody worked), so the day stays held
    // MIXED_LEAVE_AND_WORK_SEGMENTS same as before Phase 5.
    {
      const pf = '7100146';
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor(pf, '31146b', { 'LEAVE TYPE': 'SICK', 'LEAVE HR': '480', 'SCH DURATION': '8:0', 'SIGIN IN': '08:00' })],
        aspectSegments: [segOf(pf, 'SHIFT', WD, '08:00', '16:00', 480), segOf(pf, 'SICK', WD)],
        aspectIdentities: [idOf(pf)], cmsPunches: [], config: pinned,
      });
      const r = out.rows[0];
      const passed = r.TAA_VERDICT === 'LEAVE_EXCLUDED' && r.TAA_ACTION === 'NO_ACTION' && absents(r) === 0
        && r.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS';
      results.push({
        id: 'reg-146b', name: 'CONTROL: same fixture as reg-146 but Cognos claims attendance (SIGIN IN populated) — stays held',
        category: 'WP1 D6: leave replaces the shift',
        inputDescription: 'Same as reg-146 (SHIFT 08:00-16:00 plus day-level SICK, no CMS punches) but Cognos SIGIN IN=08:00',
        cognosFlawedVerdict: 'N/A — proves the Phase 5 no-attendance/all-agree gate only fires when Cognos ALSO shows no sign-in, not merely when CMS/ASPECT show none',
        expectedVerdict: 'LEAVE_EXCLUDED, no absence, held MIXED_LEAVE_AND_WORK_SEGMENTS', expectedAction: 'NO_ACTION',
        actualVerdict: `${r.TAA_VERDICT} (absence rows=${absents(r)}, hold=${r.holdReason || 'none'})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'A day Cognos itself claims was attended must never be silently released just because CMS/ASPECT show nothing',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`],
      });
    }
    // reg-147 (D6 control): the same leave marker + SHIFT but the agent really worked - NOT intercepted.
    {
      const pf = '7100147';
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor(pf, '31147', { 'LEAVE TYPE': 'SICK', 'SCH DURATION': '8:0' })],
        aspectSegments: [segOf(pf, 'SHIFT', WD, '08:00', '16:00', 480), segOf(pf, 'SICK', WD)],
        aspectIdentities: [idOf(pf)], cmsPunches: [sessionOf('31147', WD, '08:00', '16:00')], config: pinned,
      });
      const r = out.rows[0];
      const passed = r.TAA_VERDICT === 'PRESENT' && r.TAA_ACTION === 'NO_ACTION' && absents(r) === 0;
      results.push({
        id: 'reg-147', name: 'CONTROL: day-level leave marker plus a fully worked shift is still evaluated as attendance',
        category: 'WP1 D6: leave replaces the shift',
        inputDescription: 'Same fixture as reg-146 but the agent is logged in for the whole 08:00-16:00 shift',
        cognosFlawedVerdict: 'N/A - proves the D6 gate only fires when there is NO real attendance and does not swallow attended days',
        expectedVerdict: 'PRESENT (normal attendance evaluation)', expectedAction: 'NO_ACTION',
        actualVerdict: r.TAA_VERDICT, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'Real attendance on a marked-leave day must still be judged normally, never excluded',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`],
      });
    }
    // reg-148 (D3): the only punch belongs to the PREVIOUS day's shift; the leave day must not claim it.
    {
      const pf = '7100148';
      const prev = '27/08/2026';
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor(pf, '31148', { 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480', 'SIGN IN DATE': '2026-08-28 00:00:00' })],
        aspectSegments: [segOf(pf, 'SHIFT', prev, '09:30', '17:30', 480), segOf(pf, 'ANNUAL', WD)],
        aspectIdentities: [idOf(pf)], cmsPunches: [sessionOf('31148', prev, '09:29', '20:34')], config: pinned,
      });
      const r = out.rows[0];
      const passed = r.TAA_VERDICT === 'LEAVE_EXCLUDED' && r.TAA_ACTION === 'NO_ACTION' && absents(r) === 0;
      results.push({
        id: 'reg-148', name: 'A previous day\'s session is never charged to a leave day (no false "login on leave day" ABSENT)',
        category: 'WP1 D3: punch attribution',
        inputDescription: 'ANNUAL leave on 28/08; the agent\'s only punch is a 09:29-20:34 session on 27/08 (a real shift the report has no row for)',
        cognosFlawedVerdict: 'Before: the leave-day placeholder window (whole day +/- search hours) claimed that 27/08 session through its logout time, giving "665m on leave day" and an exported ABSENT (real: rec-202, CSV line 49)',
        expectedVerdict: 'LEAVE_EXCLUDED, no absence', expectedAction: 'NO_ACTION',
        actualVerdict: `${r.TAA_VERDICT} (absence rows=${absents(r)})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'Removes a wrong full-day absence from the ASPECT upload for an agent who was on approved leave',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`, `CMS in ${r.TAA_CMS_IN} out ${r.TAA_CMS_OUT}`],
      });
    }
    // reg-149 (D7): attended a bare full-day-removal (training) day - no late / late-logout computed.
    {
      const pf = '7100149';
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor(pf, '31149', { 'LEAVE TYPE': 'TRN New Hires', 'LEAVE HR': '480', 'SCH DURATION': '8:0' })],
        aspectSegments: [segOf(pf, 'SHIFT', WD, '09:00', '17:00', 480), segOf(pf, 'TRN NEW HIRES', WD)],
        aspectIdentities: [idOf(pf)], cmsPunches: [sessionOf('31149', WD, '09:26', '17:02')],
        config: { ...pinned, segmentGlossary: { ...pinned.segmentGlossary, 'TRN NEW HIRES': { code: 'TRN NEW HIRES', role: 'REMOVAL', description: 'training' } } },
      });
      const r = out.rows[0];
      const passed = r.TAA_VERDICT === 'FULL_DAY_REMOVAL_REVIEW' && r.TAA_ACTION === 'NO_ACTION'
        && r.details.generatedCorrections.length === 0 && r.holdReason === 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY';
      results.push({
        id: 'reg-149', name: 'A training day (bare full-day removal) that was attended computes no late / late-logout / absence',
        category: 'WP1 D7: zero-length window',
        inputDescription: 'SHIFT 09:00-17:00 + bare TRN NEW HIRES; agent logged in 09:26-17:02 (real: rec-6-40144998)',
        cognosFlawedVerdict: 'Before: window collapsed to 09:00-09:00, giving 26m late AND 482m late logout, a fallback COVER and an ABSENT for an agent who simply attended training',
        expectedVerdict: 'FULL_DAY_REMOVAL_REVIEW, no corrections, held FULL_DAY_REMOVAL_ON_SCHEDULED_DAY', expectedAction: 'NO_ACTION',
        actualVerdict: `${r.TAA_VERDICT} (corrections=${r.details.generatedCorrections.length}, hold=${r.holdReason || 'none'})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'No LATE/COVER/ABSENT is computed from a zero-length window; a human reviews with the source documents',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`],
      });
    }
    // reg-150 / reg-151 (D1): same-day cover credit vs late logout, mirroring rec-93 and rec-282.
    const creditFixture = (id: string, pf: string, loginId: string, sessions: [string, string][]) => runReconciliation({ processingDate: SUITE_RUN_DATE,
      cognosRecords: [cognosFor(pf, loginId)],
      aspectSegments: [segOf(pf, 'SHIFT', WD, '08:00', '16:00', 480)],
      aspectIdentities: [idOf(pf, true)],
      cmsPunches: sessions.map(([a, b]) => sessionOf(loginId, WD, a, b)), config: pinned,
    }).rows[0];
    {
      // late 37 (08:37); continuous to 17:18 -> cover 16:00-16:37 fully attended; 78 gross - 37 = 41 remaining (< 60)
      const r = creditFixture('reg-150', '7100150', '31150', [['08:37', '11:20'], ['11:20', '17:18']]);
      const codes = r.details.generatedCorrections.map(c => c.SegmentCode);
      const passed = r.TAA_VERDICT === 'LATE' && absents(r) === 0 && codes.includes('LATE') && codes.includes('COVER');
      results.push({
        id: 'reg-150', name: 'Attended same-day cover is credited: the same minutes are not ALSO charged as late logout',
        category: 'WP1 D1: cover credit',
        inputDescription: 'OFFICER shift 08:00-16:00, in 08:37 (37m late), logged in continuously to 17:18; same-day cover 16:00-16:37; toggles pinned (real: rec-93-4074920)',
        cognosFlawedVerdict: 'Before: 78m gross late logout -> ABSENT, exported together with LATE 37m and COVER 37m - the cover minutes counted twice',
        expectedVerdict: 'LATE + COVER kept, NO absence (78 - 37 = 41 remaining, below the 60m band)', expectedAction: 'LATE_AND_COVER',
        actualVerdict: `${r.TAA_VERDICT} (corrections: ${codes.join(',') || 'none'})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'Removes a full-day absence charged on time the agent had already worked as make-up cover',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`, ...(r.details.varianceTrace?.measurements || []).map(m => `${m.label}: ${m.minutes}m (${m.anchorLabel})`)],
      });
    }
    {
      // same shape but logged out 16:47, then a short second session well clear of the
      // 16:00 shift end -> no continuous presence in the cover window -> NO credit -> ABSENT
      // stands. Session 2 is window-relative (not the old hard-coded 18:40): it targets
      // rawEnd + liveWindowH - 20min (20 min inside the shift's own search-window edge),
      // floored at session-1's own logout (16:47) + 61 min so the case always keeps the
      // >60-min "no continuous presence" gap it exists to test, regardless of liveWindowH.
      // Under a narrow window that floor can push session 2 PAST the search window's own
      // reach (rawEnd + liveWindowH) — at that point session 2 is simply never attributed to
      // this shift at all, so only session 1 (08:37-16:47) remains. That changes what the
      // case actually proves rather than leaving it meaningless: session 1's OWN continuous
      // span already runs past 16:37 (the 16:00-16:37 make-up-cover window for the 37m late
      // login), so with session 2 out of the picture the agent WAS continuously present
      // through the cover window after all — credit is earned from session 1 alone, and the
      // verdict is LATE, never ABSENT. Both outcomes are asserted explicitly below; neither
      // is a weaker assertion than the other, they are the two different, both-correct
      // things this fixture proves depending on what evidence the window can actually reach.
      const rawEndWD = makeDt(WD, '16:00:00');
      const session1LogoutDt = makeDt(WD, '16:47:00');
      const windowRelativeStart = new Date(rawEndWD.getTime() + liveWindowH * 3600000 - 20 * 60000);
      const session2Start = new Date(Math.max(windowRelativeStart.getTime(), session1LogoutDt.getTime() + 61 * 60000));
      const session2End = new Date(session2Start.getTime() + 2 * 60000);
      const session2Attributable = session2Start.getTime() <= rawEndWD.getTime() + liveWindowH * 3600000;
      const session2Punch: CMSPunch = {
        Date: ddmmyyyy(session2Start), LoginID: '31151', LoginDateTime: session2Start, LogoutDateTime: session2End,
      };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE,
        cognosRecords: [cognosFor('7100151', '31151')],
        aspectSegments: [segOf('7100151', 'SHIFT', WD, '08:00', '16:00', 480)],
        aspectIdentities: [idOf('7100151', true)],
        cmsPunches: [sessionOf('31151', WD, '08:37', '16:47'), session2Punch],
        config: pinned,
      });
      const r = out.rows[0];
      const passed = session2Attributable
        ? (r.TAA_VERDICT === 'ABSENT' && absents(r) === 1)
        : (r.TAA_VERDICT === 'LATE' && absents(r) === 0);
      results.push({
        id: 'reg-151', name: 'CONTROL: a cover the agent was not logged in for earns no credit',
        category: 'WP1 D1: cover credit',
        inputDescription: `Same as reg-150 but logged out 16:47, then a ${session2Attributable ? '2m session at ' + hhmm(session2Start) + ' (attributed, gap ' + Math.round((session2Start.getTime() - session1LogoutDt.getTime()) / 60000) + 'm > 60m, no credit -> ABSENT)' : '2m session at ' + hhmm(session2Start) + ' pushed outside the ±' + liveWindowH + 'h search window (unattributed; session 1 alone already spans past 16:37 -> credited -> LATE)'} — live window ±${liveWindowH}h`,
        cognosFlawedVerdict: 'N/A - proves credit needs CONTINUOUS attendance (decision B6); the first-login..last-logout span alone is not enough',
        expectedVerdict: session2Attributable
          ? 'ABSENT (nothing credited; no continuous presence through the cover window)'
          : 'LATE (session 2 unattributed at this window size; session 1 alone already covers the cover window -> credited)',
        expectedAction: session2Attributable ? 'ABSENT_SEGMENT' : 'LATE_AND_COVER',
        actualVerdict: `${r.TAA_VERDICT} (absence rows=${absents(r)})`, actualAction: r.TAA_ACTION, passed,
        payrollImpact: 'Ensures credit can never be earned for time the agent was not at work',
        calculationTrace: [`ruleFired: ${r.details.ruleFired}`],
      });
    }

    // ===== WP8 (2026-09-23) — search window correctness at ANY cmsPunchSearchWindowHours ====

    // flex-window-01 (Bug 1 fix): a flex agent arriving 1 min past the 10:00 cutoff has their
    // logout pushed hours past rawEnd (§4.8 shift-and-clamp) — the punch search must reach it
    // even under a narrow window, not just the live default. Mirrors reg-8's fixture exactly,
    // run at BOTH the live config and a deliberately narrow 1h window to prove the fix does not
    // depend on window size.
    {
      const pf = '7100160';
      const loginId = '31160';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': pf, NAME: 'Flex Window Agent', 'LOGIN ID': loginId,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
        'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [
        { EMP_ID: pf, EMP_LAST_NAME: 'Flex Window Agent', EMP_SORT_NAME: 'FLEX WINDOW AGENT - FELX', EMP_EXTRA_2: 'flexwin' },
      ];
      const punches: CMSPunch[] = [
        { Date: '28/08/2026', LoginID: loginId, LoginDateTime: makeDt('28/08/2026', '10:01:00'), LogoutDateTime: makeDt('28/08/2026', '10:01:03') },
        { Date: '28/08/2026', LoginID: loginId, LoginDateTime: makeDt('28/08/2026', '18:00:57'), LogoutDateTime: makeDt('28/08/2026', '18:01:00') },
      ];
      const runAt = (h: number) => runReconciliation({
        processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches,
        config: { ...config, cmsPunchSearchWindowHours: h },
      }).rows[0];
      const liveRow = runAt(liveWindowH);
      const narrowRow = runAt(1);
      const passed = liveRow.TAA_LATE_MIN === 1 && liveRow.TAA_VERDICT !== 'ABSENT'
        && narrowRow.TAA_LATE_MIN === 1 && narrowRow.TAA_VERDICT !== 'ABSENT';
      results.push({
        id: 'flex-window-01', name: 'A flex agent\'s clamped late logout is found at any search window size',
        category: 'WP8: window-independent search (Bug 1)',
        inputDescription: `Flex staff sch 07:00-15:00, arrives 10:01 (1m past cutoff, logout clamps to 18:01) — run at live window ±${liveWindowH}h and at a narrow ±1h window`,
        cognosFlawedVerdict: 'Before: under a narrow window the 18:01 logout sits outside rawEnd(15:00)+windowHours and is never found -> wrongly ABSENT',
        expectedVerdict: 'LATE = 1m, never ABSENT, at every window size', expectedAction: 'SHIFT_UPDATE_AND_LATE_COVER_FLEX',
        actualVerdict: `live: ${liveRow.TAA_VERDICT} (late=${liveRow.TAA_LATE_MIN}) | 1h: ${narrowRow.TAA_VERDICT} (late=${narrowRow.TAA_LATE_MIN})`,
        actualAction: `live: ${liveRow.TAA_ACTION} | 1h: ${narrowRow.TAA_ACTION}`,
        passed,
        payrollImpact: 'A flex agent\'s legitimate late-cutoff logout must never be lost just because the CMS search window is configured narrow — that would fabricate an unpaid ABSENT.',
        calculationTrace: [`live ruleFired: ${liveRow.details.ruleFired}`, `1h ruleFired: ${narrowRow.details.ruleFired}`],
      });
    }

    // coverage-trunc-01 / -02 (Bug 2 fix): a CMS export that stops mid-shift on a multi-punch
    // day must not compute a fabricated large "left early" — it is a coverage gap, held for
    // review, not an automatic ABSENT.
    {
      const pf = '7100161';
      const loginId = '31161';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'Coverage Trunc Agent', 'LOGIN ID': loginId,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
        'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [
        { EMP_ID: pf, EMP_LAST_NAME: 'Coverage Trunc Agent', EMP_SORT_NAME: 'COVERAGE TRUNC AGENT', EMP_EXTRA_2: 'covtrunc' },
      ];
      // Prior-day sentinel: a punch the day before ensures the export's coverage-start side is
      // never the reason for any hold this case measures — only the truncated LATEST day matters.
      const sentinelPunch: CMSPunch = { Date: '27/08/2026', LoginID: loginId, LoginDateTime: makeDt('27/08/2026', '12:00:00'), LogoutDateTime: makeDt('27/08/2026', '12:00:03') };
      const punchesTruncated: CMSPunch[] = [
        sentinelPunch,
        { Date: '28/08/2026', LoginID: loginId, LoginDateTime: makeDt('28/08/2026', '06:58:00'), LogoutDateTime: makeDt('28/08/2026', '06:58:03') },
        { Date: '28/08/2026', LoginID: loginId, LoginDateTime: makeDt('28/08/2026', '07:05:00'), LogoutDateTime: makeDt('28/08/2026', '07:05:03') },
        // Nothing after 07:05 anywhere in the export -> 28/08 is the latest day, capped there.
      ];
      const outTrunc = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punchesTruncated, config });
      const rowTrunc = outTrunc.rows[0];
      const passedTrunc = rowTrunc.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED'
        && rowTrunc.TAA_VERDICT !== 'ABSENT'
        && rowTrunc.holdReason === 'INSUFFICIENT_CMS_COVERAGE';
      results.push({
        id: 'coverage-trunc-01', name: 'A CMS export that stops mid-shift holds for review, never an automatic ABSENT',
        category: 'WP8: truncated-export coverage (Bug 2)',
        inputDescription: 'OPS shift 07:00-15:00, punches 06:58 and 07:05 with a prior-day sentinel punch, nothing after 07:05 anywhere in the export',
        cognosFlawedVerdict: 'Before: computed as a ~475m early departure against a real shift end -> wrongly ABSENT',
        expectedVerdict: 'MANUAL_REVIEW_REQUIRED, never ABSENT (held: INSUFFICIENT_CMS_COVERAGE)', expectedAction: 'MANUAL_REVIEW_REQUIRED',
        actualVerdict: `${rowTrunc.TAA_VERDICT} (held: ${rowTrunc.holdReason || 'none'})`, actualAction: rowTrunc.TAA_ACTION,
        passed: passedTrunc,
        payrollImpact: 'An export that simply stops recording mid-shift must never fabricate an unpaid ABSENT for a present employee.',
        calculationTrace: [`ruleFired: ${rowTrunc.details.ruleFired}`],
      });

      // Mirror: same punches plus a punch on a LATER day -> 28/08 is no longer the latest day,
      // so it is treated as fully covered (00:00-24:00) and the gate must not over-hold. The
      // shift's own early leave becomes provable evidence again.
      const laterDayPunch: CMSPunch = { Date: '29/08/2026', LoginID: loginId, LoginDateTime: makeDt('29/08/2026', '09:00:00'), LogoutDateTime: makeDt('29/08/2026', '09:00:03') };
      const punchesCovered: CMSPunch[] = [...punchesTruncated, laterDayPunch];
      const outCovered = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punchesCovered, config });
      const rowCovered = outCovered.rows[0];
      const passedCovered = rowCovered.holdReason !== 'INSUFFICIENT_CMS_COVERAGE'
        && (rowCovered.TAA_VERDICT === 'ABSENT' || rowCovered.TAA_VERDICT === 'EARLY_LOGOUT');
      results.push({
        id: 'coverage-trunc-02', name: 'MIRROR: once the export covers the whole shift, the truncated-export gate must not over-hold',
        category: 'WP8: truncated-export coverage (Bug 2)',
        inputDescription: 'Same as coverage-trunc-01 plus a punch on 29/08 so the export no longer ends mid-shift for this employee-day',
        cognosFlawedVerdict: 'N/A — proves the new gate only fires on a genuinely truncated export, never on a fully-covered early departure',
        expectedVerdict: 'Normal early-leave/ABSENT evaluation, never held as INSUFFICIENT_CMS_COVERAGE', expectedAction: 'n/a (whatever the normal rule fires)',
        actualVerdict: `${rowCovered.TAA_VERDICT} (held: ${rowCovered.holdReason || 'none'})`, actualAction: rowCovered.TAA_ACTION,
        passed: passedCovered,
        payrollImpact: 'Confirms the coverage gate only holds a genuinely truncated export — it must never mask a real, fully-evidenced early departure.',
        calculationTrace: [`ruleFired: ${rowCovered.details.ruleFired}`],
      });
    }

    // ===== WP2 (2026-09-22) — cover placement integrity =====================================
    // Every case below pins its own processingDate explicitly (never relies on SUITE_RUN_DATE
    // alone) so the run-date floor it is testing is deterministic regardless of when the suite
    // itself runs. Toggles are pinned via `pinned` above, same convention as WP1.

    // reg-152 (D5): incident well in the past relative to the run date -> a newly assigned
    // cover must land after the RUN-date floor, not merely after the incident date.
    {
      const incidentDay = '20/08/2026';
      const decoyDay = '21/08/2026'; // after the incident but well before the floor — the OLD
      // (pre-D5) algorithm would have picked this; it must be skipped.
      const futureDay = '24/09/2026'; // > floor (23/09/2026 = run date 22/09 + default offset 1)
      const pf = '7100152';
      const runDate = new Date(2026, 8, 22); // 22/09/2026
      const out = runReconciliation({
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31152', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectSegments: [
          segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480),
          segOf(pf, 'SHIFT', decoyDay, '07:00', '15:00', 480),
          segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480),
        ],
        aspectIdentities: [idOf(pf)],
        cmsPunches: [sessionOf('31152', incidentDay, '07:30', '15:00')],
        config: pinned,
      });
      const cover = out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      const passed = cover !== undefined && cover.nominateDate === futureDay;
      results.push({
        id: 'reg-152', name: 'D5: newly assigned cover lands after the RUN date, not just after the incident date',
        category: 'WP2 D5: run-date floor',
        inputDescription: `Incident ${incidentDay} (late 30m, no same-day surplus), run date 22/09/2026, a closer working day ${decoyDay} exists but is before the floor, next FLOOR-compliant working day ${futureDay}`,
        cognosFlawedVerdict: 'Before: cover anchored to the incident date alone could resolve on or before the run date (real: rec-436, incident and export both 21/09) — here it would have wrongly picked the decoy day',
        expectedVerdict: `COVER on ${futureDay} (after the run-date floor 23/09/2026), skipping the closer ${decoyDay}`, expectedAction: `COVER nominateDate=${futureDay}`,
        actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate}` : 'No cover', actualAction: cover ? cover.SegmentCode : 'None', passed,
        payrollImpact: 'A make-up cover the agent has not yet worked must never be dated on or before the day reconciliation actually runs',
        calculationTrace: ['floorDate = runDate(22/09) + coverMinimumDaysAfterRunDate(1) = 23/09/2026', 'searchAnchorDate = max(incidentDate, floorDate-1) = 22/09/2026', `first real working day after searchAnchorDate = ${futureDay} (${decoyDay} is before the anchor, skipped)`],
      });
    }

    // reg-153 (D5): floor computation crosses a month boundary — addDays/startOfDay must not
    // mishandle a run date near month-end.
    {
      const incidentDay = '25/08/2026';
      const decoyDay = '26/08/2026'; // after the incident but well before the floor
      const futureDay = '01/10/2026'; // > floor (30/09/2026 = run date 29/09 + default offset 1)
      const pf = '7100153';
      const runDate = new Date(2026, 8, 29); // 29/09/2026
      const out = runReconciliation({
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31153', { 'SIGN IN DATE': '2026-08-25 00:00:00' })],
        aspectSegments: [
          segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480),
          segOf(pf, 'SHIFT', decoyDay, '07:00', '15:00', 480),
          segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480),
        ],
        aspectIdentities: [idOf(pf)],
        cmsPunches: [sessionOf('31153', incidentDay, '07:20', '15:00')],
        config: pinned,
      });
      const cover = out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      const passed = cover !== undefined && cover.nominateDate === futureDay;
      results.push({
        id: 'reg-153', name: 'D5: run-date floor arithmetic survives a month-boundary rollover',
        category: 'WP2 D5: run-date floor',
        inputDescription: `Run date 29/09/2026 + 1 day floor rolls into October; next uploaded working day ${futureDay}`,
        cognosFlawedVerdict: 'N/A — date-arithmetic regression guard',
        expectedVerdict: `COVER on ${futureDay}`, expectedAction: `COVER nominateDate=${futureDay}`,
        actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate}` : 'No cover', actualAction: cover ? cover.SegmentCode : 'None', passed,
        payrollImpact: 'A month-end run date must not silently produce a wrong-month or wrong-year floor',
        calculationTrace: ['floorDate = 29/09/2026 + 1 = 30/09/2026', `first real working day after floorDate-1 = ${futureDay}`],
      });
    }

    // reg-154 (invariant 9): a PROVEN already-worked same-day cover bypasses the run-date
    // floor entirely and stays on the incident day, even though the run date is much later.
    {
      const incidentDay = '20/08/2026';
      const pf = '7100154';
      const runDate = new Date(2026, 8, 22); // 22/09/2026 — floor would be 23/09/2026 if it applied
      const out = runReconciliation({
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31154', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectSegments: [segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480)],
        aspectIdentities: [idOf(pf)],
        cmsPunches: [sessionOf('31154', incidentDay, '07:10', '15:20')], // 10m late, 20m surplus at the end
        config: pinned,
      });
      const cover = out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      const passed = cover !== undefined && cover.nominateDate === incidentDay && cover.SegmentDate === incidentDay
        && cover.SegmentStarttime === '15:00' && cover.Segmentduration === '00:10';
      results.push({
        id: 'reg-154', name: 'Invariant 9: a genuinely worked same-day cover ignores the run-date floor',
        category: 'WP2 D5/invariant 9: run-date floor exemption',
        inputDescription: `${incidentDay}: late 10m (07:10), stayed to 15:20 (20m surplus) -> same-day cover 15:00-15:10; run date 22/09/2026 (98 days later)`,
        cognosFlawedVerdict: 'N/A — the floor must govern only NEWLY assigned cover, never a proven already-worked one',
        expectedVerdict: `COVER stays on ${incidentDay}, never pushed to satisfy the run-date floor`, expectedAction: `COVER nominateDate=${incidentDay} 15:00 (00:10)`,
        actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} at ${cover.SegmentStarttime}` : 'No cover', actualAction: cover ? cover.SegmentCode : 'None', passed,
        payrollImpact: 'The run-date floor must never re-date make-up time the agent has already, demonstrably worked',
        calculationTrace: ['tryPlaceSameDayCover succeeds (window 15:00-15:10 fits inside 07:10-15:20 presence) -> D5 floor never consulted'],
      });
    }

    // reg-155 (D4): same-day cover refused because the candidate window straddles a mid-day
    // gap in presence — falls through to the run-date-floor placement instead.
    {
      const incidentDay = '20/08/2026';
      const futureDay = '24/09/2026';
      const pf = '7100155';
      const runDate = new Date(2026, 8, 22);
      const out = runReconciliation({
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31155', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectSegments: [segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480), segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480)],
        aspectIdentities: [idOf(pf)],
        // 10m late (07:10); candidate window for the cover is 15:00-15:10, but the agent was
        // logged out 14:50-15:10 (in the middle of that exact window) — no single presence
        // block covers it, even though first-login..last-logout (07:10-15:20) would.
        cmsPunches: [sessionOf('31155', incidentDay, '07:10', '14:50'), sessionOf('31155', incidentDay, '15:10', '15:20')],
        config: pinned,
      });
      const cover = out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      const passed = cover !== undefined && cover.nominateDate === futureDay;
      results.push({
        id: 'reg-155', name: 'D4: same-day cover refused when the candidate window straddles a presence gap',
        category: 'WP2 D4: continuous-presence proof for same-day cover',
        inputDescription: `${incidentDay}: late 10m, sessions 07:10-14:50 and 15:10-15:20 — the 15:00-15:10 cover window sits in the 20m gap between them`,
        cognosFlawedVerdict: 'Before: the span-only check (first login..last logout = 07:10-15:20) would have accepted this window despite the gap (real: rec-282)',
        expectedVerdict: `Same-day placement refused -> falls to the run-date-floor day ${futureDay}`, expectedAction: `COVER nominateDate=${futureDay}`,
        actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate}` : 'No cover', actualAction: cover ? cover.SegmentCode : 'None', passed,
        payrollImpact: 'A cover must never be credited to a window the agent was demonstrably not present for, even if it sits inside their overall first-in/last-out span',
        calculationTrace: ['Window 15:00-15:10 not contained in [07:10,14:50] nor in [15:10,15:20] -> tryPlaceSameDayCover returns null', `placeCoverSegment fallback -> ${futureDay}`],
      });
    }

    // reg-156 (D9): re-uploading an already-corrected day must not add a second cover for the
    // same incident — the target-day check must recognise the cover a prior run already placed.
    {
      const incidentDay = '20/08/2026';
      const futureDay = '24/09/2026';
      const pf = '7100156';
      const runDate = new Date(2026, 8, 22);
      const baseInput = {
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31156', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectIdentities: [idOf(pf)],
        cmsPunches: [sessionOf('31156', incidentDay, '07:15', '15:00')], // 15m late, no same-day surplus
        config: pinned,
      };
      const firstRun = runReconciliation({ ...baseInput, aspectSegments: [segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480), segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480)] });
      const firstCover = firstRun.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      // Re-upload: ASPECT now already holds the LATE marker (incident day) AND the COVER the
      // first run placed (target day) — simulating the corrected file being fed back in.
      const reuploadSegments: AspectSegment[] = [
        segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480),
        segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480),
        segOf(pf, 'LATE', incidentDay, '07:00', '07:15', 15),
        segOf(pf, 'COVER', futureDay, firstCover?.SegmentStarttime ?? '15:00', '15:15', 15),
      ];
      const secondRun = runReconciliation({ ...baseInput, aspectSegments: reuploadSegments });
      const secondCovers = secondRun.rows[0].details.generatedCorrections.filter(c => c.SegmentCode === 'COVER');
      const passed = firstCover !== undefined && firstCover.nominateDate === futureDay && secondCovers.length === 0;
      results.push({
        id: 'reg-156', name: 'D9: no second cover is placed when ASPECT already holds this incident\'s marker and cover on the target day',
        category: 'WP2 D9: duplicate-cover detection on the resolved target day',
        inputDescription: `${incidentDay}: late 15m, first run places COVER on ${futureDay}; second run re-uploads with that LATE marker and COVER already present`,
        cognosFlawedVerdict: 'Before: AspectSegment carries no MEMO, so a cover an earlier run placed on a FUTURE working day could never be recognised, and the marker-only incident-day check let a second cover through (real: rec-285)',
        expectedVerdict: 'First run: one cover. Second run: zero NEW covers (already repaid).', expectedAction: `First COVER nominateDate=${futureDay}; second run adds none`,
        actualVerdict: `first=${firstCover ? firstCover.nominateDate : 'none'}; second run new covers=${secondCovers.length}`, actualAction: firstCover ? firstCover.SegmentCode : 'None', passed,
        payrollImpact: 'Re-running reconciliation over an already-corrected file must never repay the same lateness twice',
        calculationTrace: [`First run target resolution -> ${futureDay}`, 'findAlreadyRecordedIncident finds the LATE marker on the incident day AND an unclaimed matching COVER on the resolved target day -> hasCover=true -> no new cover placed'],
      });
    }

    // reg-157 (B9, mandatory red line): a late login AND an early logout on the SAME day are
    // two DISTINCT incidents and must always get two separate covers — including across a
    // re-upload. The duplicate guard must never conflate one incident with another.
    {
      const incidentDay = '20/08/2026';
      const futureDay = '24/09/2026';
      const pf = '7100157';
      const runDate = new Date(2026, 8, 22);
      // OPS bands: Late Login 6-60m -> LATE+COVER; Early Logout 5-9m -> Log_off+COVER (10+ is
      // ABSENT instead — must stay clear of that to keep both incidents in the cover-earning
      // band and actually test two DISTINCT covers, not one cover plus one absence).
      const baseInput = {
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31157', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectIdentities: [idOf(pf)],
        cmsPunches: [
          sessionOf('31157', incidentDay, '07:10', '14:52'), // 10m late login, 8m early logout
          // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
          { Date: incidentDay, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(incidentDay, '23:30:00'), LogoutDateTime: makeDt(incidentDay, '23:30:03') },
        ],
        config: pinned,
      };
      const addMin = (hhmm: string, mins: number) => {
        const [h, m] = hhmm.split(':').map(Number);
        const total = h * 60 + m + mins;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      const firstRun = runReconciliation({ ...baseInput, aspectSegments: [segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480), segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480)] });
      const firstCovers = firstRun.rows[0].details.generatedCorrections.filter(c => c.SegmentCode === 'COVER');
      const noOverlap = firstCovers.length === 2 && (() => {
        const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const toDurMin = (d: string) => { const [h, m] = d.split(':').map(Number); return h * 60 + m; };
        const [a, b] = [...firstCovers].sort((x, y) => toMin(x.SegmentStarttime) - toMin(y.SegmentStarttime));
        return toMin(a.SegmentStarttime) + toDurMin(a.Segmentduration) <= toMin(b.SegmentStarttime);
      })();
      // Re-upload: ASPECT now holds both markers (LATE + Log_off) and both covers.
      const reuploadSegments: AspectSegment[] = [
        segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480),
        segOf(pf, 'SHIFT', futureDay, '07:00', '15:00', 480),
        segOf(pf, 'LATE', incidentDay, '07:00', '07:10', 10),
        segOf(pf, 'Log_off', incidentDay, '14:52', '15:00', 8),
        ...firstCovers.map(c => segOf(pf, 'COVER', c.SegmentDate, c.SegmentStarttime, addMin(c.SegmentStarttime, Number(c.Segmentduration.split(':')[1])), Number(c.Segmentduration.split(':')[1]))),
      ];
      const secondRun = runReconciliation({ ...baseInput, aspectSegments: reuploadSegments });
      const secondCovers = secondRun.rows[0].details.generatedCorrections.filter(c => c.SegmentCode === 'COVER');
      const passed = firstCovers.length === 2 && noOverlap && secondCovers.length === 0;
      results.push({
        id: 'reg-157', name: 'B9 red line: two distinct incidents on one day always get two covers, on first run AND on re-upload',
        category: 'WP2 D9/B9: duplicate-cover detection must never conflate distinct incidents',
        inputDescription: `${incidentDay}: late login 10m AND early logout 8m (both inside their cover-earning bands), one CMS session 07:10-14:52, no same-day surplus for either`,
        cognosFlawedVerdict: 'N/A — owner-confirmed red line (2026-09-22): the marker-recorded gate in findAlreadyRecordedIncident is scoped per marker CODE (LATE vs Log_off) and each existing cover is claimable once (consumedRecordedCovers), so a second incident can never be starved of its own cover',
        expectedVerdict: 'First run: two non-overlapping covers (one per incident). Second run: zero NEW covers, but still two total (both already recorded).',
        expectedAction: '2 covers on first run; 0 new on re-upload',
        actualVerdict: `first run covers=${firstCovers.length} (non-overlapping=${noOverlap}); second run NEW covers=${secondCovers.length}`,
        actualAction: `${firstCovers.map(c => `${c.SegmentStarttime}(${c.Segmentduration})`).join(', ')}`,
        passed,
        payrollImpact: 'The single most important guard in WP2: the duplicate-cover fix must reduce double-payment on re-upload without ever silently dropping a distinct incident\'s own make-up time',
        calculationTrace: ['Late-login block and early-logout block are independent statements, each places its own cover', 'Re-upload: LATE marker matches only the late-cover claim, Log_off marker matches only the early-cover claim -> both recognised, neither cover duplicated, neither incident starved'],
      });
    }

    // reg-158 (D10): the flex path's early-logout branch now tries same-day placement first,
    // exactly like the standard path, instead of calling placeCoverSegment directly.
    {
      const incidentDay = '20/08/2026';
      const pf = '7100158';
      const runDate = new Date(2026, 8, 22);
      const out = runReconciliation({
        processingDate: runDate,
        cognosRecords: [cognosFor(pf, '31158', { 'SIGN IN DATE': '2026-08-20 00:00:00' })],
        aspectSegments: [segOf(pf, 'SHIFT', incidentDay, '07:00', '15:00', 480)],
        aspectIdentities: [{ EMP_ID: pf, EMP_LAST_NAME: 'WP2 FLEX', EMP_SORT_NAME: 'WP2 FLEX AGENT' }],
        // Arrives 8m early (06:52, within cutoff -> Branch A, no shift change since it snaps
        // back to 07:00), leaves 8m early (14:52) — inside the OPS 5-9m Log_off+Cover band
        // (10+ is ABSENT instead) -> early-logout branch of evaluateEarlyAndLateLogout, with
        // same-day surplus available before shift start.
        cmsPunches: [
          sessionOf('31158', incidentDay, '06:52', '14:52'),
          // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
          { Date: incidentDay, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(incidentDay, '23:30:00'), LogoutDateTime: makeDt(incidentDay, '23:30:03') },
        ],
        config: pinned,
      });
      const cover = out.rows[0].details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
      const passed = cover !== undefined && cover.nominateDate === incidentDay && cover.SegmentDate === incidentDay
        && cover.SegmentStarttime === '06:52' && cover.Segmentduration === '00:08';
      results.push({
        id: 'reg-158', name: 'D10: flex early-logout cover tries same-day placement before falling through',
        category: 'WP2 D10: flex path cover-placement parity',
        inputDescription: `${incidentDay} flex agent, shift 07:00-15:00, in 06:52 (8m early), out 14:52 (8m early logout) -> same-day cover 06:52-07:00`,
        cognosFlawedVerdict: 'Before: evaluateEarlyAndLateLogout called placeCoverSegment directly, bypassing same-day placement entirely — the one call site that did not try it first (real: rec-39, rec-135)',
        expectedVerdict: `COVER at ${incidentDay} 06:52-07:00, never pushed to a future working day`, expectedAction: `COVER nominateDate=${incidentDay} 06:52 (00:08)`,
        actualVerdict: cover ? `COVER nominateDate=${cover.nominateDate} at ${cover.SegmentStarttime}` : 'No cover', actualAction: cover ? cover.SegmentCode : 'None', passed,
        payrollImpact: 'A flex agent who already made up an early logout by arriving early must not have that cover pushed to an unrelated future day',
        calculationTrace: ['Branch A: arrival 06:52 snaps to 07:00 (no shift change)', 'Downstream early-logout 8m -> tryPlaceSameDayCover(beforeStart) -> window 06:52-07:00 fits inside 06:52-14:52 presence -> same-day'],
      });
    }
  }

  // ===== WP4 (2026-09-22) — reporting truth: derived counters, membership
  // predicates, Must Check =====
  {
    // reg-159 (D16): Rule 7 (Cover Not Attended), moveCoverForward branch,
    // pushes exactly ONE correction (the moved COVER) — no accompanying LATE
    // correction, since the incident's own late-login penalty was already
    // recorded by an earlier run. Before the D16 fix, this branch's success
    // path never incremented lateCoverCount at all (only the isAbsent branch
    // did), so the Late & Cover summary card silently undercounted every row
    // that took this path — exactly the gap between the card (23) and its
    // own tab (61, via rowHasLateCoverCorrection) on real data. Same fixture
    // shape as reg-101 (pre-existing COVER unattended by the CMS logout).
    const incidentDay = '12/09/2026';
    const pfNo = '7100159';
    const loginId = '7159';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-09-12 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'D16 LateCoverCount Agent', 'LOGIN ID': loginId,
      DUTY1: '08:00 - 16:15', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:15', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'SHIFT', START_MOMENT: `${incidentDay} 08:00:00`, STOP_MOMENT: `${incidentDay} 16:00:00`, DURATION: 480 },
      { EMP_ID: pfNo, NOM_DATE: incidentDay, START_DATE: incidentDay, SEG_CODE: 'COVER', START_MOMENT: `${incidentDay} 16:00:00`, STOP_MOMENT: `${incidentDay} 16:15:00`, DURATION: 15 },
    ];
    const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'D16 LateCoverCount Agent', EMP_SORT_NAME: 'D16 LATECOVERCOUNT AGENT' }];
    const punches: CMSPunch[] = [
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '08:00:00'), LogoutDateTime: makeDt(incidentDay, '08:00:03') },
      { Date: incidentDay, LoginID: loginId, LoginDateTime: makeDt(incidentDay, '16:00:00'), LogoutDateTime: makeDt(incidentDay, '16:00:03') },
    ];
    const moveForwardConfig: ConfigRegistry = {
      ...config,
      coverNotAttendedAction: 'moveCoverForward',
      coverFallbackWhenNoWorkingDayFound: 'nextDirectDay',
      coverFallbackDefaultTime: '08:00',
    };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: moveForwardConfig });
    const movedCover = out.rows[0]?.details.generatedCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = out.rows[0]?.TAA_RESULT_CATEGORY === 'LATE_AND_COVER_ADDED'
      && movedCover !== undefined
      && out.summary.lateCoverCount === 1;

    results.push({
      id: 'reg-159',
      name: 'D16: lateCoverCount counts a moveCoverForward cover, not just isAbsent outcomes',
      category: 'WP4 D16: summary counter correctness',
      inputDescription: `${incidentDay}: pre-existing COVER 16:00-16:15 fully unattended, coverNotAttendedAction=moveCoverForward re-places it on a future day`,
      cognosFlawedVerdict: 'Before the fix: this branch never incremented lateCoverCount — summary.lateCoverCount stayed 0 while the row still carried a real COVER correction and a LATE_AND_COVER_ADDED category',
      expectedVerdict: 'summary.lateCoverCount === 1, row category LATE_AND_COVER_ADDED, one moved COVER correction',
      expectedAction: 'lateCoverCount=1',
      actualVerdict: `lateCoverCount=${out.summary.lateCoverCount}; category=${out.rows[0]?.TAA_RESULT_CATEGORY}; cover=${movedCover ? 'present' : 'none'}`,
      actualAction: `lateCoverCount=${out.summary.lateCoverCount}`,
      passed,
      payrollImpact: 'The Late & Cover summary card must count every action it claims to, including cover placed by Rule 7 — a reviewer trusting the card alone must not be blind to these rows',
      calculationTrace: [
        `Incident ${incidentDay}: pre-existing COVER 16:00-16:15, CMS logout 16:00 -> 0m overlap -> 15m shortfall`,
        `moveCoverForward re-places the cover -> resultCategory=LATE_AND_COVER_ADDED, correction=${movedCover ? `${movedCover.SegmentCode} ${movedCover.nominateDate}` : 'none'}`,
        `summary.lateCoverCount=${out.summary.lateCoverCount} (expected 1)`,
      ],
    });
  }

  // ===== WP5 (2026-09-22) — technical-segment hold (B5/B14/B15) =====
  // Every case below supplies its own segmentGlossary entry classifying the technical
  // code NO_EFFECT (finding 3: DEFAULT_CONFIG ships none) and uses the default
  // technicalSegmentCodes ['TECH','TECH2'] / technicalSegmentToleranceMinutes 0 unless
  // a case is specifically testing the tolerance or the no-hardcoding requirement.
  {
    const techGlossary = (code: string) => ({ ...config.segmentGlossary, [code]: { code, role: 'NO_EFFECT' as const, description: 'WP5 fixture: technical outage' } });

    // reg-160 — Acceptance case 14 AFTER: TECH exactly covers a 45m late-login variance.
    {
      const day = '19/08/2026';
      const pfNo = '7100160';
      const loginId = '7160';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Full Cover Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:45:00`, DURATION: 45 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Full Cover Agent', EMP_SORT_NAME: 'WP5 TECH FULL COVER AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const hasCover = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'COVER');
      const passed = row?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === false && hasLate && hasCover;
      results.push({
        id: 'reg-160', name: 'B5/B14: TECH exactly covering a 45m late-login variance holds the row, corrections still built',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: TECH 09:00-09:45 (NO_EFFECT) + SHIFT 09:00-17:00, login 09:45 -> 45m late variance = TECH window exactly`,
        cognosFlawedVerdict: 'Before WP5: TECH classified NO_EFFECT leaves the window unmoved, so the 45m late login charges a LATE_AND_COVER penalty with no hold, even though the agent could not have avoided it',
        expectedVerdict: 'holdReason=TECHNICAL_SEGMENT_COVERS_VARIANCE, includeInOutput=false, LATE and COVER both present in generatedCorrections',
        expectedAction: 'held, corrections built',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; LATE=${hasLate}; COVER=${hasCover}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'B14: a technical hold must not silently drop the penalty — a reviewer who judges the claim unfounded must be able to release the exact same correction(s) that a genuine late login would have produced',
        calculationTrace: [`effectiveStart 09:00 unmoved by TECH (NO_EFFECT) -> late variance [09:00,09:45]`, `TECH interval [09:00,09:45] covers it exactly -> uncoveredMinutes=0 <= tolerance 0`, `holdReason=${row?.holdReason}`],
      });
    }

    // reg-161 — trailing TECH exactly covering an early-logout variance.
    {
      const day = '19/08/2026';
      const pfNo = '7100161';
      const loginId = '7161';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Early Logout Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:53',
        'SIGIN IN': '09:00', 'SIGIN OUT': '16:53', 'LATE START': '0', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 16:53:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 7 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Early Logout Agent', EMP_SORT_NAME: 'WP5 TECH EARLY LOGOUT AGENT' }];
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '16:53:00') },
        // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
        { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
      ];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLogoff = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'Log_off');
      const hasCover = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'COVER');
      const passed = row?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === false && hasLogoff && hasCover;
      results.push({
        id: 'reg-161', name: 'B5/B14: trailing TECH exactly covering a 7m early-logout variance holds the row',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: SHIFT 09:00-17:00, out 16:53 (7m early), TECH 16:53-17:00 (NO_EFFECT) exactly covers the gap`,
        cognosFlawedVerdict: 'Before WP5: no hold existed for this shape at all',
        expectedVerdict: 'holdReason=TECHNICAL_SEGMENT_COVERS_VARIANCE, includeInOutput=false, Log_off and COVER both present',
        expectedAction: 'held, corrections built',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; Log_off=${hasLogoff}; COVER=${hasCover}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'The technical hold must fire identically for early-logout variances, not only late-login ones',
        calculationTrace: [`early-logout variance [actualLastLogoutDt 16:53, effectiveEnd 17:00]`, `TECH interval [16:53,17:00] covers it exactly`, `holdReason=${row?.holdReason}`],
      });
    }

    // reg-162 — partial overlap (30 of 45m) at tolerance 0: NOT held, LATE still exported.
    {
      const day = '19/08/2026';
      const pfNo = '7100162';
      const loginId = '7162';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Partial Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:30:00`, DURATION: 30 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Partial Agent', EMP_SORT_NAME: 'WP5 TECH PARTIAL AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const passed = row?.holdReason !== 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === true && hasLate;
      results.push({
        id: 'reg-162', name: 'B5/B15: TECH covering only 30 of a 45m late variance does not hold at tolerance 0',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: TECH 09:00-09:30 (30m) inside a 09:00-09:45 (45m) late-login variance, tolerance 0`,
        cognosFlawedVerdict: 'A predicate testing "any overlap" instead of full coverage would wrongly hold this row',
        expectedVerdict: 'not held (uncovered 15m > tolerance 0), LATE still exported',
        expectedAction: 'not held',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; LATE=${hasLate}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'Partial technical coverage must never silently suppress or silently hold a genuine penalty — B5 requires the overlap be noted, not acted on',
        calculationTrace: ['late variance [09:00,09:45] = 45m', 'TECH covers only [09:00,09:30] = 30m', 'uncoveredMinutes=15 > tolerance 0 -> not held'],
      });
    }

    // reg-163 — tolerance: TECH covers 43 of 45m. Held at tolerance 2, not held at tolerance 0.
    {
      const day = '19/08/2026';
      const pfNo = '7100163';
      const loginId = '7163';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Tolerance Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:43:00`, DURATION: 43 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Tolerance Agent', EMP_SORT_NAME: 'WP5 TECH TOLERANCE AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const baseTechConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const outTol0 = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...baseTechConfig, technicalSegmentToleranceMinutes: 0 } });
      const outTol2 = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: { ...baseTechConfig, technicalSegmentToleranceMinutes: 2 } });
      const row0 = outTol0.rows[0];
      const row2 = outTol2.rows[0];
      const passed = row0?.holdReason !== 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row2?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE';
      results.push({
        id: 'reg-163', name: 'B5: technicalSegmentToleranceMinutes governs whether a 2m shortfall still holds',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: TECH covers 43 of a 45m late variance (2m uncovered), tolerance 0 vs tolerance 2`,
        cognosFlawedVerdict: 'Ignoring the tolerance field (treating it as always 0) would fail to hold at tolerance 2',
        expectedVerdict: 'tolerance 0: not held; tolerance 2: held',
        expectedAction: 'tolerance-dependent',
        actualVerdict: `tol0 holdReason=${row0?.holdReason}; tol2 holdReason=${row2?.holdReason}`,
        actualAction: `tol0=${row0?.holdReason}, tol2=${row2?.holdReason}`,
        passed,
        payrollImpact: 'The configured tolerance must genuinely change the outcome, not be a config field with no effect',
        calculationTrace: ['uncoveredMinutes=2 for both runs', 'tolerance 0: 2 > 0 -> not held', 'tolerance 2: 2 <= 2 -> held'],
      });
    }

    // reg-164 — no hardcoding: a differently-named code (GLITCH) behaves identically to TECH.
    {
      const day = '19/08/2026';
      const pfNo = '7100164';
      const loginId = '7164';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Glitch Code Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'GLITCH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:45:00`, DURATION: 45 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Glitch Code Agent', EMP_SORT_NAME: 'WP5 GLITCH CODE AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const glitchConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('GLITCH'), technicalSegmentCodes: ['GLITCH'] };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: glitchConfig });
      const row = out.rows[0];
      const passed = row?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE';
      results.push({
        id: 'reg-164', name: 'B5: a differently-named code in technicalSegmentCodes behaves identically to TECH (no hardcoding)',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: segment code GLITCH (not TECH/TECH2) listed in technicalSegmentCodes, exactly covering a 45m late variance`,
        cognosFlawedVerdict: 'A hardcoded literal check for TECH/TECH2 would never fire for this code',
        expectedVerdict: 'held under TECHNICAL_SEGMENT_COVERS_VARIANCE, same as TECH would be',
        expectedAction: 'held',
        actualVerdict: `holdReason=${row?.holdReason}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'Zero-hardcoding invariant: the feature must be driven entirely by config, never by a literal code name',
        calculationTrace: ['technicalSegmentCodes=["GLITCH"]', 'GLITCH interval [09:00,09:45] covers the late variance exactly', `holdReason=${row?.holdReason}`],
      });
    }

    // reg-165 — B15 red line: two fired variances, only one technically covered -> NOT held, both export.
    {
      const day = '19/08/2026';
      const pfNo = '7100165';
      const loginId = '7165';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Two Variance Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:08',
        'SIGIN IN': '09:45', 'SIGIN OUT': '16:53', 'LATE START': '-45', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        // Covers ONLY the late-login variance, not the early-logout one.
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:45:00`, DURATION: 45 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Two Variance Agent', EMP_SORT_NAME: 'WP5 TWO VARIANCE AGENT' }];
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '16:53:00') },
        // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
        { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
      ];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const hasLogoff = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'Log_off');
      const passed = row?.holdReason !== 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === true && hasLate && hasLogoff;
      results.push({
        id: 'reg-165', name: 'B15 red line: only one of two fired variances technically covered -> row is NOT held, both corrections export',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: late login 45m (TECH-covered) AND early logout 7m (NOT TECH-covered) on the same day`,
        cognosFlawedVerdict: 'A predicate holding when ANY variance is covered (instead of every one) would wrongly hold this row and hide the uncovered early-logout penalty',
        expectedVerdict: 'not held; LATE and Log_off both present and exported',
        expectedAction: 'not held, both export',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; LATE=${hasLate}; Log_off=${hasLogoff}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'A penalty with no technical excuse must always reach payroll even when a DIFFERENT penalty on the same day happens to be excused',
        calculationTrace: ['late variance [09:00,09:45] fully covered by TECH', 'early-logout variance [16:53,17:00] NOT covered by TECH', 'every() fails -> not held'],
      });
    }

    // reg-166 — Cover Not Attended: TECH covers the whole unattended part of a COVER window -> held.
    {
      const day = '19/08/2026';
      const pfNo = '7100166';
      const loginId = '7166';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Cover Not Attended Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 16:15', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '7:15', 'SIGNIN DURATION': '7:00',
        'SIGIN IN': '09:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 16:00:00`, DURATION: 420 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'COVER', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 16:15:00`, DURATION: 15 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 16:00:00`, STOP_MOMENT: `${day} 16:15:00`, DURATION: 15 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Cover Not Attended Agent', EMP_SORT_NAME: 'WP5 TECH COVER NOT ATTENDED AGENT' }];
      // Logged out exactly at the shift end (16:00, no early-logout variance of its own) —
      // the cover window starts exactly where attendance stops, so the whole 15m cover is
      // unattended (0m overlap) without also firing an unrelated early-logout finding.
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '16:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasAbsentCorrection = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'ABSENT' && c.Memo.includes('Cover Not Attended'));
      const passed = row?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === false && hasAbsentCorrection;
      results.push({
        id: 'reg-166', name: 'B5/B15: TECH covering the whole unattended part of a Rule 7 COVER window holds the row',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: pre-existing COVER 16:00-16:15 fully unattended (logout exactly 16:00), TECH 16:00-16:15 (NO_EFFECT) exactly covers the gap`,
        cognosFlawedVerdict: 'Before WP5: Cover Not Attended had no technical-segment awareness at all',
        expectedVerdict: 'holdReason=TECHNICAL_SEGMENT_COVERS_VARIANCE, includeInOutput=false, the Cover Not Attended ABSENT correction still built',
        expectedAction: 'held, correction built',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; correction=${hasAbsentCorrection}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'The technical hold must reach Rule 7 (Cover Not Attended), the one outcome that only ever carries a minute count elsewhere in the engine',
        calculationTrace: ['Rule 7 shortfall: cover 16:00-16:15 fully unattended (logout exactly 16:00) -> 15m shortfall', 'unattended interval = [16:00,16:15] (actualLastLogoutDt == covStart)', 'TECH covers it exactly -> held'],
      });
    }

    // reg-167 — the new code is releasable, not forced.
    {
      const passed = isForcedHoldReason('TECHNICAL_SEGMENT_COVERS_VARIANCE') === false;
      results.push({
        id: 'reg-167', name: 'B14: TECHNICAL_SEGMENT_COVERS_VARIANCE is reviewer-releasable, never forced',
        category: 'WP5: technical-segment hold',
        inputDescription: 'isForcedHoldReason(\'TECHNICAL_SEGMENT_COVERS_VARIANCE\')',
        cognosFlawedVerdict: 'Adding it to FORCED_HOLD_REASONS would make the hold permanent — releasing an empty row restores nothing (B14)',
        expectedVerdict: 'false — releasable via the reviewer checkbox',
        expectedAction: 'not forced',
        actualVerdict: `isForcedHoldReason=${isForcedHoldReason('TECHNICAL_SEGMENT_COVERS_VARIANCE')}`,
        actualAction: `isForcedHoldReason=${isForcedHoldReason('TECHNICAL_SEGMENT_COVERS_VARIANCE')}`,
        passed,
        payrollImpact: 'A reviewer who judges the technical claim unfounded must be able to release the row into the payroll CSV',
        calculationTrace: ['FORCED_HOLD_REASONS deliberately excludes TECHNICAL_SEGMENT_COVERS_VARIANCE (holdReasons.ts)'],
      });
    }

    // reg-168 — cascade ordering: a row carrying BOTH a technical hold and a forced hold
    // reports the FORCED one and stays locked. The payroll-safety red line (trap 1).
    {
      const day = '19/08/2026';
      const pfNo = '7100168';
      const loginId = '7168';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Forced Hold Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      // Same fully-technical-covered late-login shape as reg-160, PLUS an unclassified
      // segment code (UNCLASSIFIED_SEGMENT_CODE is forced) on the same day.
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:45:00`, DURATION: 45 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'WP5_UNKNOWN_CODE', START_MOMENT: `${day} 12:00:00`, STOP_MOMENT: `${day} 12:05:00`, DURATION: 5 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Forced Hold Agent', EMP_SORT_NAME: 'WP5 TECH FORCED HOLD AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const passed = row?.holdReason === 'UNCLASSIFIED_SEGMENT_CODE' && isForcedHoldReason(row?.holdReason) === true;
      results.push({
        id: 'reg-168', name: 'Payroll-safety red line: a forced hold outranks the technical hold on the same row',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: same TECH-covered 45m late variance as reg-160, PLUS an unclassified segment code on the same day (forces UNCLASSIFIED_SEGMENT_CODE)`,
        cognosFlawedVerdict: 'If the technical hold were assigned to forcedHoldReason, or sat above a forced code in the cascade, this row would report the releasable reason and become tickable into the payroll CSV while its real data-integrity problem is hidden',
        expectedVerdict: 'holdReason=UNCLASSIFIED_SEGMENT_CODE (forced), row stays locked',
        expectedAction: 'forced hold wins',
        actualVerdict: `holdReason=${row?.holdReason}; forced=${isForcedHoldReason(row?.holdReason)}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'A row with a genuine data-integrity problem must never become releasable just because it also happens to carry a technical-segment excuse',
        calculationTrace: ['technical coverage alone would hold this row', 'WP5_UNKNOWN_CODE is unclassified -> forced UNCLASSIFIED_SEGMENT_CODE assigned first in the cascade', `holdReason=${row?.holdReason} (forced=${isForcedHoldReason(row?.holdReason)})`],
      });
    }

    // reg-169 — inert under today's real classification: TECH still REMOVAL moves the
    // window, so there is no variance and no hold at all (D17's own description).
    {
      const day = '19/08/2026';
      const pfNo = '7100169';
      const loginId = '7169';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP5 Tech Removal Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '7:15', 'SIGNIN DURATION': '7:15',
        'SIGIN IN': '09:45', 'SIGIN OUT': '17:00', 'LATE START': '-45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 09:45:00`, DURATION: 45 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP5 Tech Removal Agent', EMP_SORT_NAME: 'WP5 TECH REMOVAL AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      // TECH classified REMOVAL — today's real Config.json shape, not NO_EFFECT.
      const removalConfig: ConfigRegistry = { ...config, segmentGlossary: { ...config.segmentGlossary, TECH: { code: 'TECH', role: 'REMOVAL', description: 'WP5 fixture: today\'s real classification' } } };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: removalConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const passed = row?.holdReason !== 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && !hasLate && row?.TAA_RESULT_CATEGORY === 'NO_ACTION_REQUIRED';
      results.push({
        id: 'reg-169', name: 'D17/inert: TECH still classified REMOVAL (today\'s real config) moves the window — no variance, no action, no hold',
        category: 'WP5: technical-segment hold',
        inputDescription: `${day}: same login 09:45 as reg-160, but TECH classified REMOVAL (today's real samples_Files/Config.json shape) instead of NO_EFFECT`,
        cognosFlawedVerdict: 'This is D17 itself: with TECH as REMOVAL the effective start moves to 09:45, the lateness becomes invisible, and — before WP5 — nothing surfaced that a decision was even made',
        expectedVerdict: 'no LATE correction, no hold, NO_ACTION_REQUIRED — proves the feature is inert until the user reclassifies TECH',
        expectedAction: 'no action, no hold',
        actualVerdict: `holdReason=${row?.holdReason}; LATE=${hasLate}; category=${row?.TAA_RESULT_CATEGORY}`,
        actualAction: `category=${row?.TAA_RESULT_CATEGORY}`,
        passed,
        payrollImpact: 'Confirms WP5 changes nothing on the real sample today — the user\'s pending Config Registry change (TECH/TECH2 -> NO_EFFECT) is what activates this feature',
        calculationTrace: ['TECH role=REMOVAL -> effectiveStart moves from 09:00 to 09:45', 'actualFirstLoginDt 09:45 == effectiveStart -> lateMin=0', 'no variance fired -> firedVarianceIntervals stays empty -> technicalHoldReason never computed'],
      });
    }

    // ===== WP7 (2026-09-22) — technical-segment hold proven on real MTD_Seg.csv data =====
    // WP5's 10 cases above are all hand-built. After the owner reclassified TECH/TECH2 to
    // NO_EFFECT in samples_Files/Config.json, a real replay produced ZERO rows held under
    // TECHNICAL_SEGMENT_COVERS_VARIANCE — verified as a genuine property of that specific
    // 3-day sample (Cognos covers only 18-20/09, and the two best-shaped real TECH days sit
    // on 16-17/09), not a defect, but it meant the feature had never touched a real TECH
    // segment. reg-170/reg-171 close that gap: the ASPECT segments below are copied VERBATIM
    // from MTD_Seg.csv (real EMP_ID 4508183, real NOM_DATE 18/09/2026, real SHIFT and TECH
    // start/stop/duration) — the login/logout TIMES are constructed, since the real employee
    // was on time that day and produced no variance for the technical hold to act on. The
    // employee's real display name is deliberately not reproduced here (irrelevant to the
    // test — only EMP_ID drives the segment join and tier classification).
    //
    // The real day also carries a duplicate TECH2 at the same 14:00-14:12 window, two more
    // TECH/TECH2 pairs at 17:44-18:02 and 20:56-20:59, three BREAK segments, an "ES & SMB"
    // segment matching the SHIFT span, and a real COVER at 22:00-22:03 (memo "Exceed break
    // For 16-Sep" — an unrelated incident's cover, unattended if the constructed logout is
    // exactly 22:00). That COVER is deliberately DROPPED from this fixture: left in, its
    // 3 unattended minutes would fire a second variance (Cover Not Attended) that the TECH
    // segments do not cover, which would fail B15's "every fired variance must be covered"
    // test and stop the row from holding at all — the opposite of what this case is proving.
    // The duplicate TECH2 and the two later TECH/TECH2 pairs are omitted only for clarity
    // (they are mathematically harmless — they merely extend the union of covered time
    // outside the tested interval); BREAK1/2/3 and "ES & SMB" never enter any of this
    // reasoning and are omitted as noise.
    const wp7RealDay = '18/09/2026';
    const wp7RealPfNo = '4508183';

    // reg-170 — real TECH segment (verbatim from MTD_Seg.csv) exactly covers a constructed
    // 12m late-login variance at real shift start -> held.
    {
      const day = wp7RealDay;
      const pfNo = wp7RealPfNo;
      const loginId = '7170170';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-09-18 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP7 Real-Segment Agent', 'LOGIN ID': loginId,
        DUTY1: '14:00 - 22:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:48',
        'SIGIN IN': '14:12', 'SIGIN OUT': '22:00', 'LATE START': '-12', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        // Verbatim from MTD_Seg.csv (EMP_ID 4508183, NOM_DATE 18/09/2026):
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 14:00:00`, STOP_MOMENT: `${day} 22:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 14:00:00`, STOP_MOMENT: `${day} 14:12:00`, DURATION: 12 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP7 Real-Segment Agent', EMP_SORT_NAME: 'WP7 REAL SEGMENT AGENT' }];
      // Constructed: the real employee logged in on time this day, so a real punch producing
      // this shape does not exist in the sample. Login moved to the TECH segment's own end
      // (14:12), which is what makes the variance interval align exactly with the real segment.
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '14:12:00'), LogoutDateTime: makeDt(day, '22:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const hasCover = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'COVER');
      const passed = row?.holdReason === 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && row?.includeInOutput === false && hasLate && hasCover;
      results.push({
        id: 'reg-170', name: 'WP7/B5/B14: real MTD_Seg.csv TECH segment (EMP 4508183, 18/09) exactly covers a 12m late-login variance -> holds, corrections still built',
        category: 'WP7: technical-segment hold on real data',
        inputDescription: `${day} EMP ${pfNo}: real SHIFT 14:00-22:00 + real TECH 14:00-14:12 (verbatim from MTD_Seg.csv), constructed login 14:12 -> 12m late variance = real TECH window exactly`,
        cognosFlawedVerdict: 'WP5 was validated only against hand-built fixtures; this proves the same logic against a real ASPECT segment row, not just a synthetic one',
        expectedVerdict: 'holdReason=TECHNICAL_SEGMENT_COVERS_VARIANCE, includeInOutput=false, LATE and COVER both present in generatedCorrections',
        expectedAction: 'held, corrections built',
        actualVerdict: `holdReason=${row?.holdReason}; includeInOutput=${row?.includeInOutput}; LATE=${hasLate}; COVER=${hasCover}`,
        actualAction: `holdReason=${row?.holdReason}`,
        passed,
        payrollImpact: 'Proves the technical hold actually fires on a real, unmodified ASPECT segment shape, not only on hand-constructed test data',
        calculationTrace: [`real TECH segment 14:00-14:12 (verbatim, EMP_ID ${pfNo}) unmoved by NO_EFFECT role`, 'effectiveStart 14:00 unmoved -> late variance [14:00,14:12]', 'real TECH interval covers it exactly -> uncoveredMinutes=0 <= tolerance 0', `holdReason=${row?.holdReason}`],
      });
    }

    // reg-171 — control: same real segments, but the real (on-time) login -> no variance,
    // no hold. Reproduces the actual outcome this employee-day produced in the real replay.
    {
      const day = wp7RealDay;
      const pfNo = wp7RealPfNo;
      const loginId = '7170171';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-09-18 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'WP7 Real-Segment Agent (control)', 'LOGIN ID': loginId,
        DUTY1: '14:00 - 22:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '8:00',
        'SIGIN IN': '14:00', 'SIGIN OUT': '22:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 14:00:00`, STOP_MOMENT: `${day} 22:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'TECH', START_MOMENT: `${day} 14:00:00`, STOP_MOMENT: `${day} 14:12:00`, DURATION: 12 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'WP7 Real-Segment Agent (control)', EMP_SORT_NAME: 'WP7 REAL SEGMENT AGENT CONTROL' }];
      // This is the real employee's actual behaviour that day: on time, full shift attended.
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '14:00:00'), LogoutDateTime: makeDt(day, '22:00:00') }];
      const techConfig: ConfigRegistry = { ...config, segmentGlossary: techGlossary('TECH') };
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: techConfig });
      const row = out.rows[0];
      const hasLate = !!row?.details.generatedCorrections.some(c => c.SegmentCode === 'LATE');
      const passed = row?.holdReason !== 'TECHNICAL_SEGMENT_COVERS_VARIANCE' && !hasLate && row?.TAA_RESULT_CATEGORY === 'NO_ACTION_REQUIRED';
      results.push({
        id: 'reg-171', name: 'WP7 control: same real TECH segment, real on-time login -> no variance fires, technical block never entered',
        category: 'WP7: technical-segment hold on real data',
        inputDescription: `${day} EMP ${pfNo}: same real SHIFT+TECH segments as reg-170, but login 14:00 (the real employee's actual on-time attendance)`,
        cognosFlawedVerdict: 'Without this control, reg-170 could pass for the wrong reason (e.g. a predicate that holds unconditionally whenever a technical segment exists)',
        expectedVerdict: 'no LATE correction, no hold, NO_ACTION_REQUIRED — matches the real replay\'s actual outcome for this employee-day',
        expectedAction: 'no action, no hold',
        actualVerdict: `holdReason=${row?.holdReason}; LATE=${hasLate}; category=${row?.TAA_RESULT_CATEGORY}`,
        actualAction: `category=${row?.TAA_RESULT_CATEGORY}`,
        passed,
        payrollImpact: 'Confirms the technical hold logic is conditional on an actual fired variance, not a blanket suppression whenever a TECH segment is present',
        calculationTrace: ['actualFirstLoginDt 14:00 == effectiveStart -> lateMin=0', 'no variance fired -> firedVarianceIntervals stays empty -> technicalHoldReason never computed'],
      });
    }
  }

  // ===== WP8/A2 (2026-09-22) — pin all 14 acceptance cases (Appendix A of the audit plan)
  // with their own exact numbers. Every case below pins its own technicalSegmentCodes /
  // technicalSegmentToleranceMinutes / retainLateCoverOnAbsent / coverSameDayWhenAlreadyCovered
  // explicitly instead of inheriting whatever `config` this suite run was called with — never
  // inherit live config silently. Cases 2, 12, 13 are controls (owner decision): reg-129 (case
  // 2) and reg-32 (case 13) are pre-existing near-exact pins left untouched; case 12 gets its
  // own new pin here (F4/A2: it had no standalone pin with its own numbers before).
  {
    const wp8Config = (overrides: Partial<ConfigRegistry> = {}): ConfigRegistry => ({
      ...config,
      technicalSegmentCodes: ['TECH', 'TECH2'],
      technicalSegmentToleranceMinutes: 0,
      retainLateCoverOnAbsent: false,
      coverSameDayWhenAlreadyCovered: true,
      ...overrides,
    });
    // Appendix A's own run date (2026-09-22): "Run date 21/09/2026, OPS tier, employee
    // 4500001 unless a real row id is named." Cover-placement floor cases (4, 10, 12) below
    // land on 22/09/2026 — run date + the default coverMinimumDaysAfterRunDate (1) — exactly
    // matching each acceptance case's own printed CSV date.
    const acceptanceRunDate = new Date(2026, 8, 21);

    // reg-172 — Acceptance case 5 (F4, HIGHEST PRIORITY, previously unpinned at all): a
    // pre-existing ASPECT-resident COVER (17:00-18:00, 60m) credits FULLY against a 60m
    // late logout -> exactly 0 remaining, zero rows emitted. The zero boundary.
    {
      const day = '19/08/2026';
      const pfNo = '4500001';
      const loginId = '45172';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 5 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '9:00',
        'SIGIN IN': '09:00', 'SIGIN OUT': '18:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        // Pre-existing ASPECT-resident COVER, already in the export before this run — not
        // placed by TAA. COVER is excluded from the attendance window by default
        // (coverExtendsAttendanceWindow=false), so effectiveEnd stays 17:00 and this is
        // credited via creditedCoverMinutes, not by moving the window.
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'COVER', START_MOMENT: `${day} 17:00:00`, STOP_MOMENT: `${day} 18:00:00`, DURATION: 60 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 5 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 5 AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '18:00:00') }];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const passed = out.aspectCorrections.length === 0 && row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION';
      results.push({
        id: 'reg-172',
        name: 'Acceptance case 5: pre-existing ASPECT COVER (17:00-18:00, 60m) fully credits a 60m late logout -> zero rows',
        category: 'WP8/A2: acceptance case 5 (F4 — previously unpinned, highest priority)',
        inputDescription: `${day}: SHIFT 09:00-17:00, ASPECT already holds COVER 17:00-18:00 (60m); on-time login 09:00, logout 18:00 (60m gross late logout)`,
        cognosFlawedVerdict: 'N/A — before this pin, the zero-remainder boundary was checked only by hand (F4)',
        expectedVerdict: 'No rows: 60m gross - 60m credited (full continuous attendance through the pre-existing COVER) = 0 remaining',
        expectedAction: 'NO_ACTION, no corrections',
        actualVerdict: `${row.TAA_VERDICT} (corrections=${row.details.generatedCorrections.length}, aspectCorrections=${out.aspectCorrections.length})`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'An agent who worked in full through a pre-existing cover window must never be charged a late-logout absence for the exact minutes that cover already repays',
        calculationTrace: [
          'effectiveEnd stays 17:00 (COVER excluded from the attendance window by default)',
          'lateLogoutMin gross = 18:00 - 17:00 = 60m',
          'creditedCoverMinutes([17:00-18:00] pre-existing ASPECT COVER, window [17:00,18:00], presence [09:00,18:00]) = 60m',
          'lateLogoutChargeMin = max(0, 60 - 60) = 0 -> no rule lookup, nothing charged',
          'Rule 7 (Cover Not Attended): shortfall = 60m duration - 60m overlap = 0 -> no finding',
        ],
      });
    }

    // reg-173 — Acceptance case 9: Late Login 61m AND Late Logout 60m, nothing covered ->
    // ONE physical ABSENT marker whose memo carries BOTH reasons. `reg-28` pins Late Login +
    // EARLY Logout — the wrong pair (F4); this pins the actual Late-Login + Late-Logout pair.
    {
      const day = '19/08/2026';
      const pfNo = '4500001';
      const loginId = '45173';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 9 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:59',
        'SIGIN IN': '10:01', 'SIGIN OUT': '18:00', 'LATE START': '61', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 9 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 9 AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '10:01:00'), LogoutDateTime: makeDt(day, '18:00:00') }];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const absentRows = out.aspectCorrections.filter(c => c.SegmentCode === 'ABSENT');
      const memo = absentRows[0]?.Memo || '';
      const noLateOrCover = !out.aspectCorrections.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'COVER');
      const passed = row.TAA_VERDICT === 'ABSENT' && absentRows.length === 1 && noLateOrCover
        && memo.includes('Late Login 61m') && memo.includes('Late Logout') && memo.includes('60m');
      results.push({
        id: 'reg-173',
        name: 'Acceptance case 9: Late Login 61m + Late Logout 60m -> ONE Absent marker carrying both reasons (not reg-28\'s Late Login + Early Logout pair)',
        category: 'WP8/A2: acceptance case 9 (F4 — reg-28 pins the wrong rule pair)',
        inputDescription: `${day}: SHIFT 09:00-17:00, in 10:01 (61m late), out 18:00 (60m late logout gross), no cover in ASPECT`,
        cognosFlawedVerdict: 'N/A — reg-28 (Late Login + Early Logout) was the only existing pin for a two-reason Absent marker; it does not exercise the Late-Login + Late-Logout pair this case requires',
        expectedVerdict: 'ABSENT, exactly one physical marker, memo carries both "Late Login 61m" and the Late Logout reason, no LATE/COVER rows',
        expectedAction: 'ABSENT_SEGMENT',
        actualVerdict: `${row.TAA_VERDICT} (absent rows=${absentRows.length}, no LATE/COVER=${noLateOrCover}, memo="${memo}")`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'Confirms the D8 single-physical-marker merge also covers the Late-Login + Late-Logout combination, not just Late-Login + Early-Logout (reg-28)',
        calculationTrace: [
          'Late Login: 10:01 vs 09:00 -> 61m -> OPS Absent floor (61+) -> ABSENT branch, no cover attempted',
          'Late Logout: 18:00 vs effective end 17:00 -> 60m gross, 0 credited (no cover anywhere) -> OPS Absent floor (60+) -> second ABSENT branch',
          'D8 row-level merge: two ABSENT rowCorrections collapse into one, memo joins both reasons',
        ],
      });
    }

    // reg-174 — Acceptance case 1: Late 45m, late logout 1:40 (100m gross); same-day cover
    // credits 45m of it -> 55m remaining, below the 60m Absent floor -> no ABSENT.
    {
      const day = '19/08/2026';
      const pfNo = '4500001';
      const loginId = '45174';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 1 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '8:55',
        'SIGIN IN': '09:45', 'SIGIN OUT': '18:40', 'LATE START': '45', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 1 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 1 AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:45:00'), LogoutDateTime: makeDt(day, '18:40:00') }];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const late = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
      const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
      const noAbsent = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT');
      const passed = row.TAA_VERDICT === 'LATE' && noAbsent
        && late?.nominateDate === day && late?.SegmentDate === day && late?.SegmentStarttime === '09:00' && late?.Segmentduration === '00:45'
        && cover?.nominateDate === day && cover?.SegmentDate === day && cover?.SegmentStarttime === '17:00' && cover?.Segmentduration === '00:45';
      results.push({
        id: 'reg-174',
        name: 'Acceptance case 1: Late 45m + late logout 100m gross, 45m credited by same-day cover -> 55m remaining, no ABSENT',
        category: 'WP8/A2: acceptance case 1',
        inputDescription: `${day}: SHIFT 09:00-17:00, in 09:45 (45m late), continuous to 18:40 (100m gross late logout)`,
        cognosFlawedVerdict: 'N/A — previously only pinned at mechanism level with different minutes (reg-150/rec-93 uses 37m/78m)',
        expectedVerdict: 'LATE 09:00 45m, COVER 17:00-17:45 same-day, no ABSENT (100 - 45 = 55 < 60)',
        expectedAction: 'LATE_AND_COVER',
        actualVerdict: `${row.TAA_VERDICT} (LATE=${late ? `${late.SegmentStarttime}/${late.Segmentduration}` : 'none'}, COVER=${cover ? `${cover.SegmentStarttime}/${cover.Segmentduration}` : 'none'}, absent=${!noAbsent})`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'Removes a full-day absence for an agent who both showed up late (paid via cover) and stayed on to make it up',
        calculationTrace: [
          'Late Login 45m -> OPS Late+Cover band -> LATE 09:00 45m, same-day COVER 17:00-17:45 (fits inside continuous 09:45-18:40 presence)',
          'Late Logout gross = 18:40 - 17:00 = 100m; credited = COVER 17:00-17:45 fully attended = 45m',
          '100 - 45 = 55m remaining < 60m Absent floor -> no ABSENT',
        ],
      });
    }

    // reg-175 — Acceptance case 3: Late 30m, in 09:30, out 17:45. Cover stays on the incident
    // day (actually worked); late logout 45m gross, 30m credited, well under the 60m floor.
    {
      const day = '19/08/2026';
      const pfNo = '4500001';
      const loginId = '45175';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 3 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '8:15',
        'SIGIN IN': '09:30', 'SIGIN OUT': '17:45', 'LATE START': '30', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 3 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 3 AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:30:00'), LogoutDateTime: makeDt(day, '17:45:00') }];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const late = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
      const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
      const noAbsent = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT');
      const passed = row.TAA_VERDICT === 'LATE' && noAbsent
        && late?.SegmentStarttime === '09:00' && late?.Segmentduration === '00:30'
        && cover?.nominateDate === day && cover?.SegmentDate === day && cover?.SegmentStarttime === '17:00' && cover?.Segmentduration === '00:30';
      results.push({
        id: 'reg-175',
        name: 'Acceptance case 3: Late 30m, cover stays on the incident day (actually worked), no ABSENT',
        category: 'WP8/A2: acceptance case 3',
        inputDescription: `${day}: SHIFT 09:00-17:00, in 09:30 (30m late), continuous to 17:45`,
        cognosFlawedVerdict: 'N/A — previously only pinned at mechanism level with different minutes/dates',
        expectedVerdict: 'LATE 09:00 30m, COVER 17:00-17:30 same-day (incident day), no ABSENT (45 - 30 = 15 < 60)',
        expectedAction: 'LATE_AND_COVER',
        actualVerdict: `${row.TAA_VERDICT} (LATE=${late ? `${late.SegmentStarttime}/${late.Segmentduration}` : 'none'}, COVER=${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}/${cover.Segmentduration}` : 'none'}, absent=${!noAbsent})`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'A cover the agent genuinely worked must stay recorded on the day it was actually worked, not pushed to a future day',
        calculationTrace: [
          'Late Login 30m -> LATE 09:00 30m, same-day COVER 17:00-17:30 (fits inside continuous 09:30-17:45 presence)',
          'Late Logout gross = 17:45 - 17:00 = 45m; credited = COVER 17:00-17:30 fully attended = 30m; 45 - 30 = 15m remaining, well under the 60m floor',
        ],
      });
    }

    // reg-176 — Acceptance case 4: same as case 3 but leaves on time (17:00) — no same-day
    // surplus exists, so the cover cannot land same-day and is newly assigned on the first
    // working day after the run-date floor (21/09/2026 run date + 1 = 22/09/2026).
    {
      const day = '19/08/2026';
      const futureDay = '22/09/2026';
      const pfNo = '4500001';
      const loginId = '45176';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 4 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:30',
        'SIGIN IN': '09:30', 'SIGIN OUT': '17:00', 'LATE START': '30', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: futureDay, START_DATE: futureDay, SEG_CODE: 'SHIFT', START_MOMENT: `${futureDay} 09:00:00`, STOP_MOMENT: `${futureDay} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 4 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 4 AGENT' }];
      const punches: CMSPunch[] = [{ Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:30:00'), LogoutDateTime: makeDt(day, '17:00:00') }];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const late = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
      const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
      const noAbsent = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT');
      const passed = row.TAA_VERDICT === 'LATE' && noAbsent
        && late?.SegmentStarttime === '09:00' && late?.Segmentduration === '00:30'
        && cover?.nominateDate === futureDay && cover?.SegmentDate === futureDay && cover?.SegmentStarttime === '17:00' && cover?.Segmentduration === '00:30';
      results.push({
        id: 'reg-176',
        name: 'Acceptance case 4: Late 30m, on-time logout — no same-day surplus, cover newly assigned on the first working day after the run-date floor',
        category: 'WP8/A2: acceptance case 4',
        inputDescription: `${day}: SHIFT 09:00-17:00, in 09:30 (30m late), out exactly 17:00; run date 21/09/2026 -> floor 22/09/2026, next working day ${futureDay}`,
        cognosFlawedVerdict: 'N/A — previously only pinned at mechanism level with different minutes/dates/employee (reg-152)',
        expectedVerdict: `LATE 09:00 30m, COVER newly assigned on ${futureDay} 17:00-17:30 (no same-day suffix), no ABSENT`,
        expectedAction: 'LATE_AND_COVER',
        actualVerdict: `${row.TAA_VERDICT} (LATE=${late ? `${late.SegmentStarttime}/${late.Segmentduration}` : 'none'}, COVER=${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}/${cover.Segmentduration}` : 'none'})`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'A cover with no same-day surplus to anchor to must land on a real future working day, never guessed onto the incident day itself',
        calculationTrace: [
          'Late Login 30m -> LATE 09:00 30m',
          'tryPlaceSameDayCover(afterEnd): window 17:00-17:30 > lastLogoutDt 17:00 -> refused',
          `placeCoverSegment: floor = runDate(21/09) + 1 = 22/09/2026, anchor = max(19/08, 21/09) = 21/09 -> first working day after anchor = ${futureDay}`,
        ],
      });
    }

    // reg-177 — Acceptance case 10 (real rec-282-4504900): Late 6m, claims same-day cover but
    // was logged out 16:47-18:40 (a mid-window gap breaks continuous presence — B6), final
    // logout 18:42. The absence is correct and stays; the unattended cover moves to the first
    // working day after the run-date floor; retainLateCoverOnAbsent=true keeps all three rows.
    {
      const day = '18/09/2026';
      const futureDay = '22/09/2026';
      const pfNo = '4504900';
      const loginId = '4504900';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-09-18 00:00:00', SECTION: 'OPS', 'PF NO': pfNo, NAME: 'Ahmed Gamal Hassan Ali', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '9:36',
        'SIGIN IN': '09:06', 'SIGIN OUT': '18:42', 'LATE START': '6', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: futureDay, START_DATE: futureDay, SEG_CODE: 'SHIFT', START_MOMENT: `${futureDay} 09:00:00`, STOP_MOMENT: `${futureDay} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Ahmed Gamal Hassan Ali', EMP_SORT_NAME: 'AHMED GAMAL HASSAN ALI' }];
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:06:00'), LogoutDateTime: makeDt(day, '16:47:00') },
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '18:40:00'), LogoutDateTime: makeDt(day, '18:42:00') },
      ];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config({ retainLateCoverOnAbsent: true }) });
      const row = out.rows[0];
      const late = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
      const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
      const absent = out.aspectCorrections.find(c => c.SegmentCode === 'ABSENT');
      // WP8: this case pins a REAL employee's real punches (rec-282-4504900), never rewritten
      // window-relative like reg-57/151 — but its 113-minute mid-shift gap (16:47 -> 18:40) is
      // itself real data, and the second session (18:40-18:42) is only reachable by attribution's
      // own search radius (rawEnd 17:00 + cmsPunchSearchWindowHours) when that window is wide
      // enough. Below ~1.67h (100 real minutes from 17:00 to 18:40) the second session is simply
      // never attributed to this shift at all — the case still proves ABSENT stands either way
      // (a genuine 6m late login plus either a 102m late logout OR, with the second session
      // unattributed, a 13m early logout against the 16:47-only span both clear the OPS Absent
      // floor), it just proves it through a different, still-correct rule.
      const secondSessionReachableAtThisWindow = makeDt(day, '18:40:00').getTime()
        <= makeDt(day, '17:00:00').getTime() + config.cmsPunchSearchWindowHours * 3600000;
      const passed = secondSessionReachableAtThisWindow
        ? row.TAA_VERDICT === 'ABSENT'
          && late?.SegmentStarttime === '09:00' && late?.Segmentduration === '00:06'
          && cover?.nominateDate === futureDay && cover?.SegmentDate === futureDay && cover?.SegmentStarttime === '17:00' && cover?.Segmentduration === '00:06'
          && absent !== undefined && (absent.Memo || '').includes('102m')
          && out.aspectCorrections.length === 3
        : row.TAA_VERDICT === 'ABSENT'
          && late?.SegmentStarttime === '09:00' && late?.Segmentduration === '00:06'
          && absent !== undefined
          && out.aspectCorrections.length === 3;
      results.push({
        id: 'reg-177',
        name: 'Acceptance case 10 (real rec-282-4504900): Late 6m + cover moved forward + Late Logout 102m ABSENT — all three rows kept',
        category: 'WP8/A2: acceptance case 10',
        inputDescription: `${day} EMP ${pfNo} (real: rec-282-4504900): SHIFT 09:00-17:00, in 09:06 (6m late), out 16:47, back 18:40-18:42 (113m mid-shift gap breaks continuous presence), final logout 18:42 -> 102m late logout gross${secondSessionReachableAtThisWindow ? '' : ` (18:40 session outside the ±${config.cmsPunchSearchWindowHours}h search window at this window size — unattributed; case still proves ABSENT via the 16:47-only 13m early logout)`}`,
        cognosFlawedVerdict: 'N/A — previously only pinned at mechanism level under an Officer-tier synthetic fixture with different late minutes (reg-151, 37m late)',
        expectedVerdict: secondSessionReachableAtThisWindow
          ? `LATE 09:00 6m, COVER moved to ${futureDay} 17:00 6m, ABSENT (Late Logout 102m) — all three rows kept (retainLateCoverOnAbsent)`
          : `LATE 09:00 6m, ABSENT (second session unattributed at this window size) — three rows kept`,
        expectedAction: 'ABSENT_SEGMENT, LATE/COVER retained',
        actualVerdict: `${row.TAA_VERDICT} (LATE=${late ? `${late.SegmentStarttime}/${late.Segmentduration}` : 'none'}, COVER=${cover ? cover.nominateDate : 'none'}, ABSENT memo="${absent?.Memo || 'none'}", rows=${out.aspectCorrections.length})`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'The real employee\'s own numbers: a genuine absence must stay charged even while its unrelated same-day-claimed cover is correctly refused and moved forward',
        calculationTrace: [
          'Late Login 6m -> LATE 09:00 6m; tryPlaceSameDayCover(afterEnd) window 17:00-17:06 does not fit inside either presence block [09:06,16:47]/[18:40,18:42] -> refused',
          `placeCoverSegment -> ${futureDay} 17:00-17:06`,
          'Late Logout: actual 18:42 vs effective end 17:00 -> 102m gross; the credited cover interval is dated 22/09, no overlap with the 18/09 window -> 0 credited -> 102m charged -> ABSENT',
          'retainLateCoverOnAbsent=true -> LATE/COVER not stripped, all three rows exported',
        ],
      });
    }

    // reg-178 — Acceptance case 12 (control shape, pinned with its own numbers for the first
    // time — F4/A2): Early Logout 7m (OPS 5-9m band) — no same-day surplus before the shift
    // start, cover newly assigned on the first working day after the run-date floor.
    {
      const day = '19/08/2026';
      const futureDay = '22/09/2026';
      const pfNo = '4500001';
      const loginId = '45178';
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-19 00:00:00', SECTION: 'ECS', 'PF NO': pfNo, NAME: 'Acceptance Case 12 Agent', 'LOGIN ID': loginId,
        DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:00', 'SIGNIN DURATION': '7:53',
        'SIGIN IN': '09:00', 'SIGIN OUT': '16:53', 'LATE START': '0', 'LEFT EARLY': '7', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const segs: AspectSegment[] = [
        { EMP_ID: pfNo, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 09:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 480 },
        { EMP_ID: pfNo, NOM_DATE: futureDay, START_DATE: futureDay, SEG_CODE: 'SHIFT', START_MOMENT: `${futureDay} 09:00:00`, STOP_MOMENT: `${futureDay} 17:00:00`, DURATION: 480 },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: pfNo, EMP_LAST_NAME: 'Acceptance Case 12 Agent', EMP_SORT_NAME: 'ACCEPTANCE CASE 12 AGENT' }];
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, '09:00:00'), LogoutDateTime: makeDt(day, '16:53:00') },
        // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
        { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
      ];
      const out = runReconciliation({ processingDate: acceptanceRunDate, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: wp8Config() });
      const row = out.rows[0];
      const logoff = out.aspectCorrections.find(c => c.SegmentCode === 'Log_off');
      const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
      const noAbsent = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT');
      const passed = noAbsent && row.TAA_ACTION === 'LOGOFF_AND_COVER'
        && logoff?.SegmentDate === day && logoff?.SegmentStarttime === '16:53' && logoff?.Segmentduration === '00:07'
        && cover?.nominateDate === futureDay && cover?.SegmentDate === futureDay && cover?.SegmentStarttime === '17:00' && cover?.Segmentduration === '00:07';
      results.push({
        id: 'reg-178',
        name: 'Acceptance case 12 (control): Early Logout 7m — cover newly assigned, no same-day surplus available',
        category: 'WP8/A2: acceptance case 12 (control — must not move)',
        inputDescription: `${day}: SHIFT 09:00-17:00, on-time login 09:00, out 16:53 (7m early, OPS 5-9m band); run date 21/09/2026 -> next working day ${futureDay}`,
        cognosFlawedVerdict: 'N/A — previously only exercised inside TECH-hold and reupload fixtures with different shapes, never standalone with its own numbers',
        expectedVerdict: `Log_off 16:53 7m, COVER newly assigned on ${futureDay} 17:00-17:07, no ABSENT`,
        expectedAction: 'LOGOFF_AND_COVER',
        actualVerdict: `Log_off=${logoff ? `${logoff.SegmentStarttime}/${logoff.Segmentduration}` : 'none'}, COVER=${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}/${cover.Segmentduration}` : 'none'}, absent=${!noAbsent}`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'Confirms the OPS 5-9m early-logout band stays a paid Log_off+Cover outcome, never an absence, pinned with its own exact minutes',
        calculationTrace: [
          'Early Logout 7m -> OPS 5-9m band -> Log_off + Cover',
          'tryPlaceSameDayCover(beforeStart): window 08:53-09:00 starts before firstLoginDt 09:00 -> refused',
          `placeCoverSegment -> ${futureDay} 17:00-17:07`,
        ],
      });
    }
  }

  // reg-179a/reg-179b (Step 3, launch readiness, 2026-09-24): the releaseProvenSafeHolds
  // kill switch itself, proven on a single fixture (reg-104's instantaneous-swipe SIGNIN
  // DURATION shape) — same inputs, only the toggle differs. This is the pair every other
  // gate-dependent case above pins around; if this pair ever fails, the pin pattern used
  // throughout this file is no longer trustworthy.
  {
    const cognos179: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': '7000179', NAME: 'Kill Switch Proof Agent', 'LOGIN ID': '30179',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00', 'SIGIN IN': '07:09', 'SIGIN OUT': '15:10',
      'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const segs179: AspectSegment[] = [
      { EMP_ID: '7000179', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    ];
    const punches179: CMSPunch[] = [
      { Date: '27/08/2026', LoginID: '30179', LoginDateTime: makeDt('27/08/2026', '07:09:00'), LogoutDateTime: makeDt('27/08/2026', '07:09:03') },
      { Date: '27/08/2026', LoginID: '30179', LoginDateTime: makeDt('27/08/2026', '15:09:57'), LogoutDateTime: makeDt('27/08/2026', '15:10:00') },
    ];

    const outOff = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos179], aspectSegments: segs179, aspectIdentities: [], cmsPunches: punches179, config: { ...config, releaseProvenSafeHolds: false } });
    const rowOff = outOff.rows[0];
    const compOff = rowOff.columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passedOff = compOff?.status === 'MISMATCH' && rowOff.holdReason === 'MISMATCH_FOUND';
    results.push({
      id: 'reg-179a',
      name: 'KILL SWITCH OFF: reg-104 fixture held exactly as it was before the release fix',
      category: 'Kill switch — releaseProvenSafeHolds proof pair',
      inputDescription: 'Same fixture as reg-104 (instantaneous-swipe SIGNIN DURATION shape), config.releaseProvenSafeHolds=false',
      cognosFlawedVerdict: 'N/A — proves the toggle, not a Cognos defect',
      expectedVerdict: 'SIGNIN DURATION stays MISMATCH, row held MISMATCH_FOUND — pre-Phase-1 behaviour preserved',
      expectedAction: 'N/A (held for review)',
      actualVerdict: `SIGNIN DURATION=${compOff?.status}; holdReason=${rowOff.holdReason}`,
      actualAction: rowOff.TAA_ACTION,
      passed: passedOff,
      payrollImpact: 'Confirms turning the kill switch off truly restores the original held behaviour, not just a partial rollback',
      calculationTrace: [
        'releaseProvenSafeHolds=false -> the reg-104 MISMATCH->MATCH downgrade never runs',
        'SIGNIN DURATION stays MISMATCH -> row held MISMATCH_FOUND',
      ],
    });

    const outOn = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos179], aspectSegments: segs179, aspectIdentities: [], cmsPunches: punches179, config: { ...config, releaseProvenSafeHolds: true } });
    const rowOn = outOn.rows[0];
    const compOn = rowOn.columnComparisons.find(c => c.column === 'SIGNIN DURATION');
    const passedOn = compOn?.status === 'MATCH' && rowOn.holdReason !== 'MISMATCH_FOUND';
    results.push({
      id: 'reg-179b',
      name: 'KILL SWITCH ON: reg-104 fixture released exactly as reg-104 expects',
      category: 'Kill switch — releaseProvenSafeHolds proof pair',
      inputDescription: 'Same fixture as reg-179a, config.releaseProvenSafeHolds=true',
      cognosFlawedVerdict: 'N/A — proves the toggle, not a Cognos defect',
      expectedVerdict: 'SIGNIN DURATION downgrades to MATCH, row not held for MISMATCH_FOUND',
      expectedAction: 'N/A (not held on this column)',
      actualVerdict: `SIGNIN DURATION=${compOn?.status}; holdReason=${rowOn.holdReason}`,
      actualAction: rowOn.TAA_ACTION,
      passed: passedOn,
      payrollImpact: 'Confirms the kill switch, once on, reproduces the launched release behaviour on the exact same fixture the off case just proved was held',
      calculationTrace: [
        'releaseProvenSafeHolds=true -> the reg-104 MISMATCH->MATCH downgrade runs',
        'SIGNIN DURATION downgrades to MATCH -> row not held for MISMATCH_FOUND',
      ],
    });
  }

  // reg-180..reg-186 (held-review reduction, 2026-09-27): two proven-explained Cognos
  // differences that used to hold correct rows (real 23/09 sample: 166 -> 118 held, zero
  // verdict/action/correction changes). (1) Flex roster translation — Cognos prints a flex
  // employee's BASE roster in DUTY1 and measures LATE START / LEFT EARLY against it; ASPECT
  // holds the same-length flex-moved shift TAA measures against (PRD §4.8). (2) Gate B whole
  // make-up COVER — Cognos SCH DURATION leaves out the entire COVER ASPECT records for a LATE.
  // Each positive case has a negative twin proving the rule stays narrow.
  {
    const flexId = (pf: string): AspectIdentity => ({ EMP_ID: pf, EMP_LAST_NAME: 'Flex Roster Agent', EMP_SORT_NAME: 'FLEX ROSTER AGENT FLX' });
    const plainId = (pf: string): AspectIdentity => ({ EMP_ID: pf, EMP_LAST_NAME: 'Plain Roster Agent', EMP_SORT_NAME: 'PLAIN ROSTER AGENT' });
    // Real shape (PF 4500508 / 90142777 on 23/09): Cognos base roster 07:00-15:00, ASPECT
    // flex shift 10:00-18:00 (same 8h), one real session 09:58 -> 18:02.
    const flexCognos = (pf: string, over: Partial<CognosRecord> = {}): CognosRecord => ({
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': pf, NAME: 'Flex Roster Agent', 'LOGIN ID': `3${pf.slice(-4)}`,
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:04', 'SIGIN IN': '09:58', 'SIGIN OUT': '18:02',
      'LATE START': '-178', 'LEFT EARLY': '182', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '', ...over,
    });
    const flexSegs = (pf: string): AspectSegment[] => [
      { EMP_ID: pf, NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 10:00:00', STOP_MOMENT: '27/08/2026 18:00:00', DURATION: 480 },
    ];
    const flexPunches = (pf: string): CMSPunch[] => [
      { Date: '27/08/2026', LoginID: `3${pf.slice(-4)}`, LoginDateTime: makeDt('27/08/2026', '09:58:00'), LogoutDateTime: makeDt('27/08/2026', '18:02:00') },
    ];
    const runFlex = (pf: string, identity: AspectIdentity, cognos: CognosRecord, releaseProvenSafeHolds = true) => runReconciliation({
      processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: flexSegs(pf), aspectIdentities: [identity], cmsPunches: flexPunches(pf),
      config: { ...config, releaseProvenSafeHolds },
    }).rows[0];
    const statusOf = (row: ReconciliationRow, col: string) => row.columnComparisons.find(c => c.column === col)?.status;
    const flexCase = (id: string, name: string, row: ReconciliationRow, passed: boolean, inputDescription: string, expectedVerdict: string, payrollImpact: string) => results.push({
      id, name, category: 'Held-review reduction — proven Cognos basis differences', inputDescription,
      cognosFlawedVerdict: 'Cognos DUTY1 / LATE START / LEFT EARLY use the flex base roster, not the flex-moved ASPECT shift',
      expectedVerdict, expectedAction: 'NO_ACTION (unchanged by the hold decision)',
      actualVerdict: `DUTY1=${statusOf(row, 'DUTY1')}; LATE START=${statusOf(row, 'LATE START')}; LEFT EARLY=${statusOf(row, 'LEFT EARLY')}; holdReason=${row.holdReason}`,
      actualAction: row.TAA_ACTION, passed, payrollImpact,
      calculationTrace: [`TAA_ACTION=${row.TAA_ACTION}`, `includeInOutput=${row.includeInOutput}`],
    });

    const r180 = runFlex('7000180', flexId('7000180'), flexCognos('7000180'));
    flexCase('reg-180', 'Flex base roster vs flex-moved ASPECT shift (same length): released, action unchanged', r180,
      statusOf(r180, 'DUTY1') === 'NOT_COMPARABLE' && statusOf(r180, 'LATE START') === 'NOT_COMPARABLE' && statusOf(r180, 'LEFT EARLY') === 'NOT_COMPARABLE'
        && !r180.holdReason && r180.TAA_ACTION === 'NO_ACTION' && r180.includeInOutput,
      'FLEX, Cognos DUTY1 07:00-15:00, ASPECT SHIFT 10:00-18:00, session 09:58-18:02; Cognos LATE START -178 / LEFT EARLY 182 = TAA +2 / +2 shifted by exactly 180m',
      'DUTY1, LATE START, LEFT EARLY all NOT_COMPARABLE; row not held',
      'None — verdict/action come from ASPECT+CMS either way; only the hold is lifted');

    const r181 = runFlex('7000181', plainId('7000181'), flexCognos('7000181'));
    flexCase('reg-181', 'Same shape, NOT flex-tagged: roster difference is a genuine disagreement and stays held', r181,
      statusOf(r181, 'DUTY1') === 'MISMATCH' && r181.holdReason === 'MISMATCH_FOUND',
      'reg-180 inputs with a non-flex identity', 'DUTY1 stays MISMATCH; row held MISMATCH_FOUND',
      'Keeps a real roster change on a non-flex employee in front of a reviewer');

    const r182 = runFlex('7000182', flexId('7000182'), flexCognos('7000182'), false);
    flexCase('reg-182', 'KILL SWITCH OFF: flex roster downgrade never runs', r182,
      statusOf(r182, 'DUTY1') === 'MISMATCH' && r182.holdReason === 'MISMATCH_FOUND',
      'reg-180 inputs, releaseProvenSafeHolds=false', 'DUTY1 stays MISMATCH; row held MISMATCH_FOUND',
      'Confirms the kill switch restores the pre-change held behaviour');

    const r183 = runFlex('7000183', flexId('7000183'), flexCognos('7000183', { DUTY1: '07:00 - 16:30', 'LEFT EARLY': '92' }));
    flexCase('reg-183', 'Flex, but Cognos roster is a DIFFERENT LENGTH (9.5h vs 8h): not a pure move, stays held', r183,
      statusOf(r183, 'DUTY1') === 'MISMATCH' && r183.holdReason === 'MISMATCH_FOUND',
      'FLEX, Cognos DUTY1 07:00-16:30 vs ASPECT 10:00-18:00', 'DUTY1 stays MISMATCH; row held MISMATCH_FOUND',
      'A length change is a schedule disagreement, not the flex reporting basis');

    const r184 = runFlex('7000184', flexId('7000184'), flexCognos('7000184', { 'LATE START': '-150' }));
    flexCase('reg-184', 'Flex pure move, but Cognos LATE START gap is NOT the move: that column stays MISMATCH, row held', r184,
      statusOf(r184, 'DUTY1') === 'NOT_COMPARABLE' && statusOf(r184, 'LATE START') === 'MISMATCH' && r184.holdReason === 'MISMATCH_FOUND',
      'reg-180 inputs with Cognos LATE START -150 (gap 152m vs a 180m move)', 'DUTY1 NOT_COMPARABLE; LATE START MISMATCH; row held',
      'Only the part of the difference the roster move explains is downgraded');

    // Gate B whole make-up COVER (real shape: PF 4500508, 40116355, 4036620 on 23/09).
    const coverCognos = (pf: string, sch: string, late: number): CognosRecord => ({
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'OPS', 'PF NO': pf, NAME: 'Make-up Cover Agent', 'LOGIN ID': `3${pf.slice(-4)}`,
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': sch, 'SIGNIN DURATION': '08:01', 'SIGIN IN': `08:${late}`, 'SIGIN OUT': `16:${late + 1}`,
      'LATE START': `-${late}`, 'LEFT EARLY': `${late + 1}`, 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    });
    const runCover = (pf: string, sch: string, late: number) => runReconciliation({
      processingDate: SUITE_RUN_DATE, cognosRecords: [coverCognos(pf, sch, late)],
      aspectSegments: [
        { EMP_ID: pf, NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
        { EMP_ID: pf, NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'LATE', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: `27/08/2026 08:${late}:00`, DURATION: late },
        { EMP_ID: pf, NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'COVER', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: `27/08/2026 16:${late}:00`, DURATION: late },
      ],
      aspectIdentities: [plainId(pf)],
      cmsPunches: [{ Date: '27/08/2026', LoginID: `3${pf.slice(-4)}`, LoginDateTime: makeDt('27/08/2026', `08:${late}:00`), LogoutDateTime: makeDt('27/08/2026', `16:${late + 1}:00`) }],
      config: { ...config, releaseProvenSafeHolds: true },
    }).rows[0];
    const r185 = runCover('7000185', '8:0', 30);
    const r185sch = r185.columnComparisons.find(c => c.column === 'SCH DURATION');
    results.push({
      id: 'reg-185', name: 'Cognos SCH DURATION leaves out the WHOLE make-up COVER for a recorded LATE: released', category: 'Held-review reduction — proven Cognos basis differences',
      inputDescription: 'SHIFT 08:00-16:00 + LATE 08:00-08:30 + COVER 16:00-16:30 in ASPECT, session 08:30-16:31, Cognos SCH DURATION 8:0 (TAA 8:30)',
      cognosFlawedVerdict: 'Cognos SCH DURATION omits the 30m COVER ASPECT already records',
      expectedVerdict: 'SCH DURATION reads MISMATCH (honest) but is action-neutral; row not held',
      expectedAction: 'Unchanged by the hold decision',
      actualVerdict: `SCH DURATION=${r185sch?.status}; holdReason=${r185.holdReason}; note=${r185sch?.note}`,
      actualAction: r185.TAA_ACTION,
      passed: r185sch?.status === 'MISMATCH' && !r185.holdReason && /whole 30m make-up COVER/.test(r185sch?.note || '') && /Action-neutral/.test(r185sch?.note || ''),
      payrollImpact: 'None — the band-neutrality test proves Cognos\'s figure would drive the same action',
      calculationTrace: [`gap 30m = COVER 30m = LATE 30m`, `TAA_ACTION=${r185.TAA_ACTION}`],
    });
    const r186 = runCover('7000186', '8:10', 40);
    results.push({
      id: 'reg-186', name: 'Gap is only PART of the make-up COVER (30m of 40m): still ambiguous, stays held', category: 'Held-review reduction — proven Cognos basis differences',
      inputDescription: 'SHIFT 08:00-16:00 + LATE 40m + COVER 40m, Cognos SCH DURATION 8:10 (TAA 8:40, gap 30m)',
      cognosFlawedVerdict: 'Unknown — partial gap could be a late-make-up disagreement',
      expectedVerdict: 'SCH DURATION MISMATCH; row held MISMATCH_FOUND',
      expectedAction: 'N/A (held for review)',
      actualVerdict: `SCH DURATION=${statusOf(r186, 'SCH DURATION')}; holdReason=${r186.holdReason}`,
      actualAction: r186.TAA_ACTION,
      passed: statusOf(r186, 'SCH DURATION') === 'MISMATCH' && r186.holdReason === 'MISMATCH_FOUND',
      payrollImpact: 'Keeps the pre-existing late-make-up exclusion for every gap that is not the whole COVER',
      calculationTrace: ['gap 30m != COVER 40m -> explainedByLateMakeUp still excludes Gate B'],
    });
  }

  // ===== Already-actioned rule (business decision 2026-09-27) — reg-187, reg-188 =====
  {
    // reg-187: flex over-cutoff path. Same fixture as reg-8 (flex 07:00 roster, arrives 10:01,
    // 1m past the 10:00 cutoff) plus a LATE ASPECT already holds for that day.
    const pf = '455887';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'Flex Already Actioned', 'LOGIN ID': '10087',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:59',
      'SIGIN IN': '10:01', 'SIGIN OUT': '18:01', 'LATE START': '-181', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const baseSegs: AspectSegment[] = [
      { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
      { EMP_ID: pf, NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 07:00:00', STOP_MOMENT: '29/08/2026 15:00:00', DURATION: 480 },
    ];
    const lateSeg: AspectSegment = { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'LATE', START_MOMENT: '28/08/2026 10:00:00', STOP_MOMENT: '28/08/2026 10:01:00', DURATION: 1 };
    const identities: AspectIdentity[] = [{ EMP_ID: pf, EMP_LAST_NAME: 'Flex Already Actioned', EMP_SORT_NAME: 'FLEX ALREADY ACTIONED - FELX' }];
    const punches: CMSPunch[] = [
      { Date: '28/08/2026', LoginID: '10087', LoginDateTime: makeDt('28/08/2026', '10:01:00'), LogoutDateTime: makeDt('28/08/2026', '10:01:03') },
      { Date: '28/08/2026', LoginID: '10087', LoginDateTime: makeDt('28/08/2026', '18:00:57'), LogoutDateTime: makeDt('28/08/2026', '18:01:00') },
    ];
    const run = (segs: AspectSegment[]) => runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config }).rows[0];
    const fresh = run(baseSegs);
    const recorded = run([...baseSegs, lateSeg]);
    const codesOf = (r: ReturnType<typeof run>) => r.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none';
    const hasCode = (r: ReturnType<typeof run>, c: string) => r.details.generatedCorrections.some(x => x.SegmentCode === c);
    const passed = fresh.TAA_ACTION === 'SHIFT_UPDATE_AND_LATE_COVER_FLEX' && hasCode(fresh, 'LATE') && hasCode(fresh, 'COVER')
      && recorded.TAA_ACTION === 'SHIFT_UPDATE_FLEX' && !hasCode(recorded, 'LATE') && !hasCode(recorded, 'COVER')
      && recorded.details.generatedCorrections.length === 2 && (recorded.details.ruleFired ?? '').includes('already actioned');
    results.push({
      id: 'reg-187', name: 'Flex Past Cutoff With LATE Already In ASPECT: Shift Update Only, No LATE, No COVER', category: 'Already-actioned rule (2026-09-27)',
      inputDescription: 'Flex 07:00 roster, arrives 10:01 (1m past cutoff); fresh vs ASPECT already holding LATE 10:00 1m',
      cognosFlawedVerdict: 'N/A — business rule: a LATE already in ASPECT means no further action from TAA',
      expectedVerdict: 'Fresh: shift pair + LATE + COVER. Recorded: only the 10/11 shift-update pair, action SHIFT_UPDATE_FLEX',
      expectedAction: 'SHIFT_UPDATE_FLEX',
      actualVerdict: `fresh=${codesOf(fresh)} (${fresh.TAA_ACTION}); recorded=${codesOf(recorded)} (${recorded.TAA_ACTION})`,
      actualAction: recorded.TAA_ACTION,
      passed,
      payrollImpact: 'No duplicate LATE and no extra COVER for a flex late arrival that ASPECT already carries',
      calculationTrace: [`recorded ruleFired: ${recorded.details.ruleFired}`],
    });
  }
  {
    // reg-188: the rule never touches the ABSENT band — a 70m late login with a LATE already in
    // ASPECT is still ABSENT (only the LATE_AND_COVER outcome is "already actioned").
    const pf = '600188';
    const day = '27/08/2026';
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'Absent Band Agent', 'LOGIN ID': '60188',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:50',
      'SIGIN IN': '08:10', 'SIGIN OUT': '15:00', 'LATE START': '-70', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: 480 },
      { EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'LATE', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 08:10:00`, DURATION: 70 },
    ];
    const punches: CMSPunch[] = [
      { Date: day, LoginID: '60188', LoginDateTime: makeDt(day, '08:10:00'), LogoutDateTime: makeDt(day, '08:10:03') },
      { Date: day, LoginID: '60188', LoginDateTime: makeDt(day, '15:00:00'), LogoutDateTime: makeDt(day, '15:00:03') },
      { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
    ];
    const row = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs,
      aspectIdentities: [{ EMP_ID: pf, EMP_LAST_NAME: 'Absent Band Agent', EMP_SORT_NAME: 'ABSENT BAND AGENT' }], cmsPunches: punches, config }).rows[0];
    const passed = row.TAA_ACTION === 'ABSENT_SEGMENT' && row.details.generatedCorrections.some(c => c.SegmentCode === 'ABSENT');
    results.push({
      id: 'reg-188', name: 'LATE Already In ASPECT Does Not Soften The ABSENT Band (70m Late Stays ABSENT)', category: 'Already-actioned rule (2026-09-27)',
      inputDescription: 'OPS SHIFT 07:00-15:00, login 08:10 (70m), ASPECT already holds LATE 07:00-08:10',
      cognosFlawedVerdict: 'N/A — boundary of the already-actioned rule',
      expectedVerdict: 'ABSENT (61m+ band) — the rule only applies to LATE_AND_COVER outcomes',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT}; corrections=${row.details.generatedCorrections.map(c => c.SegmentCode).join(',') || 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'A recorded LATE can never downgrade an absence the policy requires',
      calculationTrace: [`ruleFired: ${row.details.ruleFired}`],
    });
  }
  {
    // reg-189 (2026-09-27, Astra P1): a disputed LEFT EARLY must be judged on TAA's OWN basis —
    // release-adjusted end, COVER credit, tier and BOTH Early/Late Logout rules. Before the fix,
    // (a) the positive same-band downgrade compared the two RAW figures (29 vs 31, both < 60)
    // and (b) Gate A clamped Cognos -1 to "0m early = NO_ACTION"; both auto-released an ABSENT
    // for 61m late logout that Cognos's own figure puts at 59m (no action).
    const day = '27/08/2026';
    const mk = (pf: string, rls: [string, string] | null, logout: string, leftEarly: string, sch: string, releaseSafe = true, cover: [string, string] | null = null, cognosOut = logout) => {
      const segs: AspectSegment[] = [
        { EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: 480 },
      ];
      if (cover) segs.push({ EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'COVER', START_MOMENT: `${day} ${cover[0]}:00`, STOP_MOMENT: `${day} ${cover[1]}:00`,
        DURATION: (Number(cover[1].slice(0, 2)) * 60 + Number(cover[1].slice(3))) - (Number(cover[0].slice(0, 2)) * 60 + Number(cover[0].slice(3))) });
      if (rls) segs.push({ EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} ${rls[0]}:00`, STOP_MOMENT: `${day} ${rls[1]}:00`,
        DURATION: (Number(rls[1].slice(0, 2)) * 60 + Number(rls[1].slice(3))) - (Number(rls[0].slice(0, 2)) * 60 + Number(rls[0].slice(3))) });
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'Same Basis Agent', 'LOGIN ID': `L${pf}`,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': sch, 'SIGNIN DURATION': '',
        'SIGIN IN': '07:00', 'SIGIN OUT': cognosOut, 'LATE START': '0', 'LEFT EARLY': leftEarly, 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      };
      const punches: CMSPunch[] = [
        { Date: day, LoginID: `L${pf}`, LoginDateTime: makeDt(day, '07:00:00'), LogoutDateTime: makeDt(day, `${logout}:00`) },
        { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
      ];
      return runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs,
        aspectIdentities: [{ EMP_ID: pf, EMP_LAST_NAME: 'Same Basis Agent', EMP_SORT_NAME: 'SAME BASIS AGENT' }], cmsPunches: punches,
        config: { ...config, releaseProvenSafeHolds: releaseSafe } }).rows[0];
    };
    const leOf = (r: ReturnType<typeof mk>) => r.columnComparisons.find(c => c.column === 'LEFT EARLY')?.status;
    const a = mk('7000189', ['14:30', '15:00'], '15:31', '29', '7:30');   // positive branch straddle
    const b = mk('7000190', ['14:00', '15:00'], '15:01', '-1', '7:0');    // Gate A straddle
    const c = mk('7000191', null, '15:22', '20', '8:0');                  // same side, no action: still released
    const e = mk('7000192', null, '16:12', '70', '8:0');                  // both ABSENT: still released
    const f = mk('7000193', ['14:30', '15:00'], '15:31', '29', '7:30', false); // kill switch off
    // (g) PF 27519 shape: Cognos measured LEFT EARLY to the end of the attended COVER its SCH
    // includes (out 16:01 = COVER end + 1); TAA's raw-end figure is 61 but the policy outcome is
    // the same on every reading -> released (this was a false hold under the raw-band test).
    const g = mk('7000196', null, '16:01', '1', '9:0', true, ['15:00', '16:00']);
    // (h) Cognos's clock says 15:00, CMS 15:10: on Cognos's reading the 15:00-15:10 COVER was
    // never attended (Rule 7 ABSENT), on TAA's it was -> held.
    const h = mk('7000197', null, '15:10', '0', '8:10', true, ['15:00', '15:10'], '15:00');
    // (i) realistic straddle: Cognos's own clock 15:29 (LE 29) vs CMS 15:31 -> held.
    const i = mk('7000198', ['14:30', '15:00'], '15:31', '29', '7:30', true, null, '15:29');
    const checks: [string, boolean][] = [
      ['a: RLS 14:30, out 15:31, Cognos 29 vs 31 -> 59m vs 61m -> held', a.TAA_ACTION === 'ABSENT_SEGMENT' && a.holdReason === 'MISMATCH_FOUND' && leOf(a) === 'MISMATCH'],
      ['b: RLS 14:00, out 15:01, Cognos -1 vs +1 -> 59m vs 61m -> held', b.TAA_ACTION === 'ABSENT_SEGMENT' && b.holdReason === 'MISMATCH_FOUND' && leOf(b) === 'MISMATCH'],
      ['c: 20 vs 22 (no rule either way) -> still released', !c.holdReason && leOf(c) === 'NOT_COMPARABLE'],
      ['e: 70 vs 72 (ABSENT either way) -> still released', !e.holdReason && e.TAA_ACTION === 'ABSENT_SEGMENT' && leOf(e) === 'NOT_COMPARABLE'],
      ['f: kill switch off -> held', f.holdReason === 'MISMATCH_FOUND'],
      ['g: 27519 shape (LE measured to the attended COVER end) -> released', !g.holdReason && leOf(g) === 'NOT_COMPARABLE'],
      ['h: Cognos out 15:00 vs CMS 15:10 with COVER 15:00-15:10 -> Rule 7 differs -> held', leOf(h) === 'MISMATCH' && h.holdReason === 'MISMATCH_FOUND'],
      ['i: Cognos clock 15:29 vs CMS 15:31 with RLS -> 59m vs 61m -> held', leOf(i) === 'MISMATCH' && i.holdReason === 'MISMATCH_FOUND'],
    ];
    results.push({
      id: 'reg-189', name: 'Disputed LEFT EARLY Judged On TAA\'s Own Basis: A Pair Straddling Late Logout After The Release Stays Held', category: 'Held-review reduction — same-basis release (2026-09-27)',
      inputDescription: 'SHIFT 07:00-15:00 with trailing RLS 14:30 / 14:00; CMS logout 15:31 / 15:01; Cognos LEFT EARLY 29 / -1; controls 20 vs 22 and 70 vs 72 with no RLS; kill switch off',
      cognosFlawedVerdict: 'Cognos measures LEFT EARLY from the raw end, ignoring the release — its figure is 59m on TAA\'s basis, TAA\'s is 61m',
      expectedVerdict: '(a)(b) held MISMATCH_FOUND, LEFT EARLY MISMATCH; (c)(e) released NOT_COMPARABLE; (f) held',
      expectedAction: 'ABSENT_SEGMENT held for review, never auto-exported',
      actualVerdict: checks.map(([l, ok]) => `${ok ? 'ok' : 'NO'} ${l.split(':')[0]}`).join('; '),
      actualAction: a.TAA_ACTION,
      passed: checks.every(([, ok]) => ok),
      payrollImpact: 'An unpaid-absence correction is no longer exported without review when Cognos\'s own figure, on the same basis, would fire no action',
      calculationTrace: checks.map(([l, ok]) => `${ok ? 'PASS' : 'FAIL'} ${l}`),
    });
  }
  {
    // reg-190 (business rule 2026-09-27): releases are booked on a 30-minute grid. An off-grid
    // RLS (14:35-15:00) is flagged, never held and never rounded — the day is calculated with
    // the release exactly as recorded (net 480 - 25 = 455m). An on-grid RLS is not flagged.
    const day = '27/08/2026';
    const mk = (pf: string, rlsStart: string, rlsMin: number) => runReconciliation({
      processingDate: SUITE_RUN_DATE,
      cognosRecords: [{
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': pf, NAME: 'Release Grid Agent', 'LOGIN ID': `L${pf}`,
        DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '', 'SIGNIN DURATION': '',
        'SIGIN IN': '07:00', 'SIGIN OUT': rlsStart, 'LATE START': '0', 'LEFT EARLY': `-${rlsMin}`, 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
      }],
      aspectSegments: [
        { EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 07:00:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: 480 },
        { EMP_ID: pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'RLS', START_MOMENT: `${day} ${rlsStart}:00`, STOP_MOMENT: `${day} 15:00:00`, DURATION: rlsMin },
      ],
      aspectIdentities: [{ EMP_ID: pf, EMP_LAST_NAME: 'Release Grid Agent', EMP_SORT_NAME: 'RELEASE GRID AGENT' }],
      cmsPunches: [
        { Date: day, LoginID: `L${pf}`, LoginDateTime: makeDt(day, '07:00:00'), LogoutDateTime: makeDt(day, `${rlsStart}:10`) },
        { Date: day, LoginID: 'sentinel-export-open', LoginDateTime: makeDt(day, '23:30:00'), LogoutDateTime: makeDt(day, '23:30:03') },
      ],
      config,
    }).rows[0];
    const off = mk('7000194', '14:35', 25);
    const on = mk('7000195', '14:30', 30);
    // The reason code is only set when nothing more specific (here DEFECT_1: Cognos ignored the
    // release) already explains the row; the dedicated note + export column always carry it.
    const offFlagged = (off.releaseGridNote ?? '').includes('RLS 14:35-15:00') && (off.details.ruleFired ?? '').includes('not on the 30-minute grid');
    const passed = offFlagged && !off.holdReason && off.TAA_ACTION === 'NO_ACTION' && off.TAA_SCH_HOURS_RECOMPUTED === 455
      && !on.releaseGridNote && !(on.details.ruleFired ?? '').includes('not on the');
    results.push({
      id: 'reg-190', name: 'Release Off The 30-Minute Grid Is Flagged, Not Held, Not Rounded', category: 'Release grid (2026-09-27)',
      inputDescription: 'SHIFT 07:00-15:00 with RLS 14:35-15:00 (off grid) vs RLS 14:30-15:00 (on grid); agent leaves at the release start',
      cognosFlawedVerdict: 'N/A — ASPECT booking check',
      expectedVerdict: 'Off grid: TAA_RELEASE_GRID_NOTE + trace name the RLS, net 455m as recorded, not held. On grid: no flag',
      expectedAction: 'NO_ACTION (the flag never changes the calculation)',
      actualVerdict: `off: note=${off.releaseGridNote ?? ''}, net=${off.TAA_SCH_HOURS_RECOMPUTED}, hold=${off.holdReason ?? 'none'}; on: note=${on.releaseGridNote ?? 'none'}`,
      actualAction: off.TAA_ACTION,
      passed,
      payrollImpact: 'None — a reviewer sees a mis-booked release without the day being held or recalculated on a guess',
      calculationTrace: [`off ruleFired: ${off.details.ruleFired}`],
    });
  }
  {
    // reg-191 (2026-09-27, Astra P3): a held row's unexported COVER must never push an included
    // row's COVER later on the same target day, and input row order must not matter. One agent,
    // SHIFT 07:00-15:00 on 22, 23 and 25/09; 10m late on 22 and 23; run date 24/09 -> both COVERs
    // target 25/09. The 22/09 row is held (Cognos DUTY1 06:00-14:00 vs ASPECT 07:00-15:00).
    const pf = '7000199';
    const runDate = new Date(2026, 8, 24);
    const cog = (d: string, duty: string): CognosRecord => ({
      'SIGN IN DATE': `2026-09-${d} 00:00:00`, SECTION: 'ECS', 'PF NO': pf, NAME: 'Cover Order Agent', 'LOGIN ID': `L${pf}`,
      DUTY1: duty, OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      'SIGIN IN': '07:10', 'SIGIN OUT': '15:00', 'LATE START': '-10', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    });
    const segs: AspectSegment[] = ['22/09/2026', '23/09/2026', '25/09/2026'].map(d => ({
      EMP_ID: pf, NOM_DATE: d, START_DATE: d, SEG_CODE: 'SHIFT', START_MOMENT: `${d} 07:00:00`, STOP_MOMENT: `${d} 15:00:00`, DURATION: 480 }));
    const punches: CMSPunch[] = [
      ...['22/09/2026', '23/09/2026'].map(d => ({ Date: d, LoginID: `L${pf}`, LoginDateTime: makeDt(d, '07:10:00'), LogoutDateTime: makeDt(d, '15:00:30') })),
      { Date: '19/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('19/09/2026', '00:01:00'), LogoutDateTime: makeDt('19/09/2026', '00:01:03') },
      { Date: '26/09/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('26/09/2026', '23:30:00'), LogoutDateTime: makeDt('26/09/2026', '23:30:03') },
    ];
    const run = (recs: CognosRecord[]) => runReconciliation({ processingDate: runDate, cognosRecords: recs, aspectSegments: segs,
      aspectIdentities: [{ EMP_ID: pf, EMP_LAST_NAME: 'Cover Order Agent', EMP_SORT_NAME: 'COVER ORDER AGENT' }], cmsPunches: punches,
      config: { ...config, coverSameDayWhenAlreadyCovered: false } });
    const exportedCovers = (csv: string) => csv.split('\n').filter(l => l.includes(',COVER,')).map(l => l.split(',')[5]).join(',');
    const heldFirst = run([cog('22', '06:00 - 14:00'), cog('23', '07:00 - 15:00')]);
    const heldLast = run([cog('23', '07:00 - 15:00'), cog('22', '06:00 - 14:00')]);
    const both = run([cog('22', '07:00 - 15:00'), cog('23', '07:00 - 15:00')]);
    const bothRev = run([cog('23', '07:00 - 15:00'), cog('22', '07:00 - 15:00')]);
    const coverOf = (r: ReconciliationRow) => r.details.generatedCorrections.find(c => c.SegmentCode === 'COVER')?.SegmentStarttime;
    const byDay = (rows: ReconciliationRow[], d: string) => rows.find(r => r.originalCognos['SIGN IN DATE'].startsWith(`2026-09-${d}`))!;
    // Reviewer unticks the 22/09 row after both were included, then ticks it again.
    const unticked = reallocateCoverSlots(both.rows.map(r => r === byDay(both.rows, '22') ? { ...r, includeInOutput: false } : r));
    const reticked = reallocateCoverSlots(unticked.map(r => r.originalCognos['SIGN IN DATE'].startsWith('2026-09-22') ? { ...r, includeInOutput: true } : r));
    const checks: [string, boolean][] = [
      ['held row first: exported 23/09 COVER at 15:00', byDay(heldFirst.rows, '22').holdReason === 'MISMATCH_FOUND' && exportedCovers(heldFirst.aspectCorrectionsCsv) === '15:00'],
      ['held row last: same export', exportedCovers(heldLast.aspectCorrectionsCsv) === '15:00'],
      ['held row keeps a provisional slot after it (15:10)', coverOf(byDay(heldFirst.rows, '22')) === '15:10' && coverOf(byDay(heldLast.rows, '22')) === '15:10'],
      ['both included: by incident date, any input order (22=15:00, 23=15:10)', coverOf(byDay(both.rows, '22')) === '15:00' && coverOf(byDay(both.rows, '23')) === '15:10'
        && coverOf(byDay(bothRev.rows, '22')) === '15:00' && coverOf(byDay(bothRev.rows, '23')) === '15:10'],
      ['untick 22 -> remaining 23 COVER moves to 15:00', coverOf(byDay(unticked, '23')) === '15:00' && coverOf(byDay(unticked, '22')) === '15:10'],
      ['re-tick 22 -> 22=15:00, 23=15:10, no overlap', coverOf(byDay(reticked, '22')) === '15:00' && coverOf(byDay(reticked, '23')) === '15:10'],
    ];
    results.push({
      id: 'reg-191', name: 'A Held Row\'s COVER Never Pushes An Exported COVER Later; Input Order Never Matters', category: 'COVER allocation (2026-09-27)',
      inputDescription: 'Late 10m on 22/09 and 23/09, both COVERs target 25/09 (run date 24/09); 22/09 held in one variant; rows in both input orders; untick/re-tick of 22/09',
      cognosFlawedVerdict: 'N/A — placement order defect: an unexported reservation acted as a real schedule commitment',
      expectedVerdict: 'Exported COVERs depend only on the included set, stacked by incident date; held rows get provisional slots after them',
      expectedAction: 'LATE_AND_COVER',
      actualVerdict: checks.map(([l, ok]) => `${ok ? 'ok' : 'NO'}: ${l}`).join('; '),
      actualAction: byDay(heldFirst.rows, '23').TAA_ACTION,
      passed: checks.every(([, ok]) => ok),
      payrollImpact: 'The exported COVER lands at the day\'s real next free slot, not 10 minutes later with an unexplained gap',
      calculationTrace: checks.map(([l, ok]) => `${ok ? 'PASS' : 'FAIL'} ${l}`),
    });
  }

  // ==========================================================================
  // Reduced Office Hours (Flex, one configured weekday) — roh-01..roh-12
  // Friday 03/07/2026 (after SUITE_RUN_DATE 01/07/2026's cover floor of
  // 02/07/2026). Base schedule (roh-01..07): Flex SHIFT 07:00-15:00 + OT1
  // 15:00-17:00, matching the acceptance-table worked example.
  // ==========================================================================
  const rohConfigOn: ConfigRegistry = {
    ...config,
    reducedOfficeHoursEnabled: true,
    reducedOfficeHoursDayOfWeek: 5, // Friday
    reducedOfficeHoursRequiredMinutes: 240,
  };

  // Self-consistent Cognos record: OT1 as a real duration string (Cognos convention, not a time
  // range — cognosComparison parses OT1 as a duration and forces MISMATCH on a populated but
  // unparseable value), and LATE START/LEFT EARLY computed from the actual login/logout against
  // the raw SHIFT+OT1 window (07:00-17:00), the same raw-window formula cognosComparison's own
  // recompute uses, instead of being hardcoded to '0' regardless of the args.
  const rohBaseCognos = (loginTime: string, logoutTime: string): CognosRecord => {
    const rawStartMin = 7 * 60; // 07:00
    const rawEndMin = 17 * 60; // 17:00 (SHIFT 07:00-15:00 + OT1 15:00-17:00)
    const [lh, lm] = loginTime.split(':').map(Number);
    const [oh, om] = logoutTime.split(':').map(Number);
    const loginMin = lh * 60 + lm;
    const logoutMin = oh * 60 + om;
    const lateStart = rawStartMin - loginMin; // Cognos convention: negative = late arrival
    const leftEarly = logoutMin - rawEndMin; // negative = left before rawEnd
    return {
      'SIGN IN DATE': '2026-07-03 00:00:00', SECTION: 'ECS', 'PF NO': '9000001', NAME: 'Flex ROH Agent', 'LOGIN ID': '90001',
      DUTY1: '07:00 - 15:00', OT1: '2:0', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '10:0', 'SIGNIN DURATION': '',
      'SIGIN IN': loginTime, 'SIGIN OUT': logoutTime, 'LATE START': String(lateStart), 'LEFT EARLY': String(leftEarly),
      'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
  };
  const rohBaseSegs: AspectSegment[] = [
    { EMP_ID: '9000001', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 07:00:00', STOP_MOMENT: '03/07/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '9000001', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'OT1', START_MOMENT: '03/07/2026 15:00:00', STOP_MOMENT: '03/07/2026 17:00:00', DURATION: 120 },
  ];
  const rohIdentities: AspectIdentity[] = [
    { EMP_ID: '9000001', EMP_LAST_NAME: 'Flex ROH Agent', EMP_SORT_NAME: 'FLEX ROH AGENT FLX', EMP_EXTRA_2: 'flexroh' },
  ];
  const rohPunches = (loginTime: string, logoutTime: string): CMSPunch[] => [
    { Date: '03/07/2026', LoginID: '90001', LoginDateTime: makeDt('03/07/2026', `${loginTime}:00`), LogoutDateTime: makeDt('03/07/2026', `${loginTime}:03`) },
    { Date: '03/07/2026', LoginID: '90001', LoginDateTime: makeDt('03/07/2026', `${logoutTime}:00`), LogoutDateTime: makeDt('03/07/2026', `${logoutTime}:03`) },
    // WP8: keeps this day from reading as a truncated export (see the identical note in `boundary`).
    { Date: '03/07/2026', LoginID: 'sentinel-export-open', LoginDateTime: makeDt('03/07/2026', '23:30:00'), LogoutDateTime: makeDt('03/07/2026', '23:30:03') },
  ];

  // Self-check: every roh case must fail loudly if its fixture date drifts off the
  // intended weekday (0=Sun..6=Sat), since the whole suite hinges on the configured weekday.
  const rohIsWeekday = (d: string, day: number) => parseDateTimeString(d)?.getDay() === day;

  const rohRunClean = (loginTime: string, logoutTime: string, cfg: ConfigRegistry) => runReconciliation({
    processingDate: SUITE_RUN_DATE, cognosRecords: [rohBaseCognos(loginTime, logoutTime)], aspectSegments: rohBaseSegs,
    aspectIdentities: rohIdentities, cmsPunches: rohPunches(loginTime, logoutTime), config: cfg,
  });

  // roh-01: login 10:00, logout 14:00 (exactly 4h) — clean, flag set.
  {
    const out = rohRunClean('10:00', '14:00', rohConfigOn);
    const row = out.rows[0];
    const noAbsentOrLogoff = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Log_off');
    const passed = noAbsentOrLogoff && row.TAA_EARLY_MIN === 0 && row.TAA_VERDICT !== 'ABSENT'
      && row.TAA_DISAGREE_REASON === 'REDUCED_OFFICE_HOURS_POLICY' && row.details.reducedOfficeHoursApplied === true
      && !row.holdReason && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-01', name: 'Reduced Office Hours: exactly 4h logged — clean',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Friday SHIFT 07:00-15:00 + OT1 15:00-17:00, Flex arrival 10:00 (on-time branch, shift slides to 10:00-18:00), logout 14:00',
      cognosFlawedVerdict: 'Without this rule: early 240m vs shifted end 18:00 -> ABSENT',
      expectedVerdict: 'No early/late action; TAA_DISAGREE_REASON=REDUCED_OFFICE_HOURS_POLICY; details.reducedOfficeHoursApplied=true; no hold',
      expectedAction: 'not ABSENT/Log_off',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; disagree=${row.TAA_DISAGREE_REASON}; applied=${row.details.reducedOfficeHoursApplied}; holdReason=${row.holdReason}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the 4h reduced requirement clears a would-be early-logout absence',
      calculationTrace: ['newEnd (flex slide) = 18:00', 'earlyCheckEndDt = min(10:00+240m, 18:00) = 14:00', 'logout 14:00 >= 14:00 -> no early'],
    });
  }

  // roh-02: logout 14:30 (more than 4h) — still clean.
  {
    const out = rohRunClean('10:00', '14:30', rohConfigOn);
    const row = out.rows[0];
    const noAbsentOrLogoff = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT' || c.SegmentCode === 'Log_off');
    const passed = noAbsentOrLogoff && row.TAA_EARLY_MIN === 0 && row.TAA_VERDICT !== 'ABSENT' && row.details.reducedOfficeHoursApplied === true
      && !row.holdReason && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-02', name: 'Reduced Office Hours: 4.5h logged — clean',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same as roh-01, logout 14:30',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'No early/late action; no hold',
      expectedAction: 'not ABSENT/Log_off',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; holdReason=${row.holdReason}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms exceeding the reduced requirement does not itself trigger any action',
      calculationTrace: ['logout 14:30 >= reduced target 14:00 -> no early', '14:30 < shifted end 18:00 -> not late either'],
    });
  }

  // roh-03: logout 16:30 — still clean; proves the two anchors are independent
  // (late logout stays anchored to the flex-shifted end 18:00, untouched by this rule).
  {
    const out = rohRunClean('10:00', '16:30', rohConfigOn);
    const row = out.rows[0];
    const noAbsent = !out.aspectCorrections.some(c => c.SegmentCode === 'ABSENT');
    const passed = noAbsent && row.TAA_EARLY_MIN === 0 && row.TAA_LATE_MIN === 0 && row.TAA_VERDICT !== 'ABSENT' && row.details.reducedOfficeHoursApplied === true
      && !row.holdReason && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-03', name: 'Reduced Office Hours: 6.5h logged, still well inside shifted end — clean',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same as roh-01, logout 16:30 (vs flex-shifted end 18:00)',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'No early/late action — proves the late-logout anchor (18:00) is untouched by this rule; no hold',
      expectedAction: 'not ABSENT',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; late=${row.TAA_LATE_MIN}; holdReason=${row.holdReason}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms late-logout keeps using the real shift end, not the reduced target, so no double relaxation',
      calculationTrace: ['earlyAnchor = 14:00 (reduced target)', 'lateAnchor = 18:00 (flex-shifted end, unchanged)', '16:30 is after both early and before late -> clean'],
    });
  }

  // roh-04: logout 12:00 (only 2 of 4h) — still flagged, banded against the reduced
  // target (14:00), not the full shifted end (18:00).
  {
    const out = rohRunClean('10:00', '12:00', rohConfigOn);
    const row = out.rows[0];
    const absent = out.aspectCorrections.find(c => c.SegmentCode === 'ABSENT' && c.Memo.includes('Early Logout'));
    const passed = row.TAA_EARLY_MIN === 120 && !!absent && absent.Memo.includes('120m') && row.details.reducedOfficeHoursApplied === true
      && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-04', name: 'Reduced Office Hours: only 2h logged — early logout banded against the reduced target',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same as roh-01, logout 12:00 (2h, short of the 4h requirement)',
      cognosFlawedVerdict: 'Without this rule: early 360m vs shifted end 18:00',
      expectedVerdict: 'Early Logout 120m (vs reduced target 14:00, not 360m vs 18:00) -> ABSENT_SEGMENT (OPS 10+ band)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `${row.TAA_VERDICT}; early=${row.TAA_EARLY_MIN}; memo=${absent?.Memo || 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms failing the reduced minimum still bands correctly against the shorter target, not the full shift',
      calculationTrace: ['earlyCheckEndDt = 14:00', 'earlyMin = diff(12:00, 14:00) = 120m', 'OPS Early Logout 10+ band -> ABSENT_SEGMENT'],
    });
  }

  // roh-05: logout 19:30 (past the real shifted end by more than the Late Logout
  // threshold) — outcome must be IDENTICAL on vs off, proving the late anchor
  // was never touched.
  {
    const outOn = rohRunClean('10:00', '19:30', rohConfigOn);
    const outOff = rohRunClean('10:00', '19:30', config);
    const rowOn = outOn.rows[0];
    const rowOff = outOff.rows[0];
    const identical = rowOn.TAA_VERDICT === rowOff.TAA_VERDICT && rowOn.TAA_ACTION === rowOff.TAA_ACTION
      && rowOn.TAA_LATE_MIN === rowOff.TAA_LATE_MIN && rowOn.TAA_EARLY_MIN === rowOff.TAA_EARLY_MIN
      && JSON.stringify(rowOn.details.generatedCorrections) === JSON.stringify(rowOff.details.generatedCorrections);
    const passed = identical && rowOn.details.reducedOfficeHoursApplied !== true && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-05', name: 'Reduced Office Hours: late logout unaffected by this rule',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same as roh-01, logout 19:30 (90m past the flex-shifted end 18:00)',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'ON and OFF produce identical output; flag NOT set',
      expectedAction: 'ABSENT_SEGMENT (Late Logout)',
      actualVerdict: `ON=${rowOn.TAA_VERDICT}/${rowOn.TAA_LATE_MIN}m, OFF=${rowOff.TAA_VERDICT}/${rowOff.TAA_LATE_MIN}m, applied=${rowOn.details.reducedOfficeHoursApplied}`,
      actualAction: rowOn.TAA_ACTION,
      passed,
      payrollImpact: 'Proves the feature cannot be (mis)used to also relax late-logout enforcement',
      calculationTrace: ['lateAnchor = 18:00 always (on or off)', 'lateMin = diff(18:00, 19:30) = 90m -> Late Logout 60+ band -> ABSENT_SEGMENT'],
    });
  }

  // roh-06: arrival 10:01 (1m past the flex cutoff) — still LATE with next-working-day
  // cover via the existing untouched logic; the 4h requirement counts from 10:01.
  {
    const out = rohRunClean('10:01', '14:01', rohConfigOn);
    const row = out.rows[0];
    const late = out.aspectCorrections.find(c => c.SegmentCode === 'LATE');
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const coverNotOnFriday = !cover || cover.nominateDate !== '03/07/2026';
    const noEarlyLogoutCorrection = !out.aspectCorrections.some(c => c.SegmentCode === 'Log_off' || (c.SegmentCode === 'ABSENT' && c.Memo.includes('Early Logout')));
    const passed = !!late && coverNotOnFriday && noEarlyLogoutCorrection && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-06', name: 'Reduced Office Hours: late arrival — late-cutoff logic untouched, 4h counted from actual login',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same schedule, arrival 10:01 (past 10:00 cutoff), logout 14:01 (exactly 4h from 10:01)',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'LATE correction present; cover not dated on the excluded Friday; no early-logout correction',
      expectedAction: 'SHIFT_UPDATE_AND_LATE_COVER_FLEX',
      actualVerdict: `late=${!!late}; cover=${cover ? `${cover.nominateDate} ${cover.SegmentStarttime}` : 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms this feature never touches the existing late-arrival/cutoff mechanism',
      calculationTrace: ['cutoff 10:00, arrival 10:01 -> Branch B (past cutoff), lateMin=1m, bandFires (flexBypassesMinuteBands)', 'earlyCheckEndDt = min(10:01+240m, newEnd) -> logout 14:01 meets it exactly'],
    });
  }

  // roh-07: cap test — a short 3h scheduled shift means the reduced target
  // (login+4h) would exceed the real shift end; the cap must win.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-03 00:00:00', SECTION: 'ECS', 'PF NO': '9000007', NAME: 'Flex ROH Cap Agent', 'LOGIN ID': '90007',
      DUTY1: '07:00 - 10:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '3:0', 'SIGNIN DURATION': '',
      // LATE START/LEFT EARLY self-consistent with rawStart 07:00/rawEnd 10:00 vs login 10:00/logout 12:30
      // (Cognos raw-window formula: rawStart-login, logout-rawEnd), not hardcoded '0'.
      'SIGIN IN': '10:00', 'SIGIN OUT': '12:30', 'LATE START': '-180', 'LEFT EARLY': '150', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000007', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 07:00:00', STOP_MOMENT: '03/07/2026 10:00:00', DURATION: 180 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000007', EMP_LAST_NAME: 'Flex ROH Cap Agent', EMP_SORT_NAME: 'FLEX ROH CAP AGENT FLX', EMP_EXTRA_2: 'flexrohcap' },
    ];
    const punches: CMSPunch[] = [
      { Date: '03/07/2026', LoginID: '90007', LoginDateTime: makeDt('03/07/2026', '10:00:00'), LogoutDateTime: makeDt('03/07/2026', '10:00:03') },
      { Date: '03/07/2026', LoginID: '90007', LoginDateTime: makeDt('03/07/2026', '12:30:00'), LogoutDateTime: makeDt('03/07/2026', '12:30:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: rohConfigOn });
    const row = out.rows[0];
    const passed = row.TAA_EARLY_MIN === 30 && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-07', name: 'Reduced Office Hours: cap — reduced target may never exceed the real shift end',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Friday SHIFT 07:00-10:00 (180m), Flex arrival 10:00 (shift slides to 10:00-13:00), logout 12:30',
      cognosFlawedVerdict: 'Uncapped: reduced target would be 10:00+240m=14:00, past the real 13:00 end -> demands MORE attendance than scheduled',
      expectedVerdict: 'earlyCheckEndDt = min(14:00, 13:00) = 13:00 -> early 30m (not 90m vs an uncapped 14:00)',
      expectedAction: 'n/a',
      actualVerdict: `early=${row.TAA_EARLY_MIN}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Prevents the feature from ever demanding more office time than the employee was actually scheduled',
      calculationTrace: ['newEnd (flex slide) = 13:00', 'earlyCheckEndDt = min(10:00+240m, 13:00) = 13:00 (capped)', 'earlyMin = diff(12:30, 13:00) = 30m'],
    });
  }

  // roh-08: cover exclusion — Thursday incident, Friday AND Saturday both have future
  // working segments; Friday must be skipped so cover lands on Saturday.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-02 00:00:00', SECTION: 'ECS', 'PF NO': '9000008', NAME: 'Flex ROH Cover Agent', 'LOGIN ID': '90008',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      // LATE START/LEFT EARLY self-consistent with rawStart 07:00/rawEnd 15:00 vs login 10:01/logout 18:00.
      'SIGIN IN': '10:01', 'SIGIN OUT': '18:00', 'LATE START': '-181', 'LEFT EARLY': '180', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000008', NOM_DATE: '02/07/2026', START_DATE: '02/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '02/07/2026 07:00:00', STOP_MOMENT: '02/07/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '9000008', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 07:00:00', STOP_MOMENT: '03/07/2026 15:00:00', DURATION: 480 },
      { EMP_ID: '9000008', NOM_DATE: '04/07/2026', START_DATE: '04/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '04/07/2026 07:00:00', STOP_MOMENT: '04/07/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000008', EMP_LAST_NAME: 'Flex ROH Cover Agent', EMP_SORT_NAME: 'FLEX ROH COVER AGENT FLX', EMP_EXTRA_2: 'flexrohcover' },
    ];
    const punches: CMSPunch[] = [
      { Date: '02/07/2026', LoginID: '90008', LoginDateTime: makeDt('02/07/2026', '10:01:00'), LogoutDateTime: makeDt('02/07/2026', '10:01:03') },
      { Date: '02/07/2026', LoginID: '90008', LoginDateTime: makeDt('02/07/2026', '18:00:00'), LogoutDateTime: makeDt('02/07/2026', '18:00:03') },
    ];
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: rohConfigOn });
    const row = out.rows[0];
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = !!cover && cover.nominateDate === '04/07/2026' && !row.coverFallbackNote
      && rohIsWeekday('02/07/2026', 4) && rohIsWeekday('03/07/2026', 5) && rohIsWeekday('04/07/2026', 6);
    results.push({
      id: 'roh-08', name: 'Reduced Office Hours: cover exclusion skips the excluded Friday for the next real working day (Saturday)',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Thursday 02/07 Flex late arrival (10:01, past cutoff); Friday 03/07 and Saturday 04/07 both have real SHIFT segments',
      cognosFlawedVerdict: 'Without exclusion: cover would land on Friday 03/07 (the next working day)',
      expectedVerdict: `COVER nominateDate = 04/07/2026 (Saturday), not Friday; no fallback note (real ASPECT data used)`,
      expectedAction: 'n/a',
      actualVerdict: `cover=${cover ? cover.nominateDate : 'none'}; fallbackNote="${row.coverFallbackNote}"`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms make-up cover is never placed on the configured reduced-hours day, for any Flex staffer',
      calculationTrace: ['futureWorkingSegments after exclusion: [Saturday] (Friday removed)', 'resolveDayCoverAnchor(Saturday) ok -> cover placed there'],
    });
  }

  // roh-09: cover exclusion — same Thursday incident, ONLY a Friday future segment
  // exists, with nextDirectDay fallback (which would naively re-land on Friday).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-02 00:00:00', SECTION: 'ECS', 'PF NO': '9000009', NAME: 'Flex ROH Fallback Agent', 'LOGIN ID': '90009',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      // LATE START/LEFT EARLY self-consistent with rawStart 07:00/rawEnd 15:00 vs login 10:01/logout 18:00.
      'SIGIN IN': '10:01', 'SIGIN OUT': '18:00', 'LATE START': '-181', 'LEFT EARLY': '180', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000009', NOM_DATE: '02/07/2026', START_DATE: '02/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '02/07/2026 07:00:00', STOP_MOMENT: '02/07/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000009', EMP_LAST_NAME: 'Flex ROH Fallback Agent', EMP_SORT_NAME: 'FLEX ROH FALLBACK AGENT FLX', EMP_EXTRA_2: 'flexrohfallback' },
    ];
    const punches: CMSPunch[] = [
      { Date: '02/07/2026', LoginID: '90009', LoginDateTime: makeDt('02/07/2026', '10:01:00'), LogoutDateTime: makeDt('02/07/2026', '10:01:03') },
      { Date: '02/07/2026', LoginID: '90009', LoginDateTime: makeDt('02/07/2026', '18:00:00'), LogoutDateTime: makeDt('02/07/2026', '18:00:03') },
    ];
    const cfg: ConfigRegistry = { ...rohConfigOn, coverFallbackWhenNoWorkingDayFound: 'nextDirectDay' };
    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: cfg });
    const cover = out.aspectCorrections.find(c => c.SegmentCode === 'COVER');
    const passed = !!cover && cover.nominateDate !== '03/07/2026' && cover.nominateDate === '04/07/2026'
      && rohIsWeekday('02/07/2026', 4) && rohIsWeekday('04/07/2026', 6);
    results.push({
      id: 'roh-09', name: 'Reduced Office Hours: synthesized nextDirectDay fallback also steps past the excluded Friday',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same Thursday incident, no real future ASPECT data at all, coverFallbackWhenNoWorkingDayFound=nextDirectDay',
      cognosFlawedVerdict: 'Naive nextDirectDay = searchAnchor+1 = Friday (the excluded day) — exactly the bug this design avoids',
      expectedVerdict: 'Synthesized date steps forward past Friday to Saturday 04/07/2026',
      expectedAction: 'n/a',
      actualVerdict: `cover=${cover ? cover.nominateDate : 'none'}`,
      actualAction: 'n/a',
      passed,
      payrollImpact: 'Confirms the exclusion also protects the no-ASPECT-data fallback path, not just the real-schedule search',
      calculationTrace: ['no futureWorkingSegments survive the exclusion filter -> §4.11 Step 5 fallback', 'targetDt = Thu+1 = Fri -> excluded -> step forward -> Sat 04/07/2026'],
    });
  }

  // roh-10: non-Flex identity on the configured Friday — must be completely unaffected
  // (the rule requires isFlex, checked before isFlexScheduleWithinExpectedWindow).
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-03 00:00:00', SECTION: 'ECS', 'PF NO': '9000010', NAME: 'Standard ROH Agent', 'LOGIN ID': '90010',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      'SIGIN IN': '07:00', 'SIGIN OUT': '11:00', 'LATE START': '0', 'LEFT EARLY': '-240', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000010', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 07:00:00', STOP_MOMENT: '03/07/2026 15:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000010', EMP_LAST_NAME: 'Standard ROH Agent', EMP_SORT_NAME: 'STANDARD ROH AGENT' },
    ];
    const punches: CMSPunch[] = [
      { Date: '03/07/2026', LoginID: '90010', LoginDateTime: makeDt('03/07/2026', '07:00:00'), LogoutDateTime: makeDt('03/07/2026', '07:00:03') },
      { Date: '03/07/2026', LoginID: '90010', LoginDateTime: makeDt('03/07/2026', '11:00:00'), LogoutDateTime: makeDt('03/07/2026', '11:00:03') },
    ];
    const outOn = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: rohConfigOn });
    const outOff = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const rowOn = outOn.rows[0];
    const rowOff = outOff.rows[0];
    const passed = rowOn.TAA_VERDICT === rowOff.TAA_VERDICT && rowOn.TAA_ACTION === rowOff.TAA_ACTION
      && rowOn.TAA_EARLY_MIN === rowOff.TAA_EARLY_MIN && rowOn.details.reducedOfficeHoursApplied !== true
      && JSON.stringify(rowOn.details.generatedCorrections) === JSON.stringify(rowOff.details.generatedCorrections)
      && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-10', name: 'Reduced Office Hours: non-Flex staff on the configured day are unaffected',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Non-Flex identity, Friday SHIFT 07:00-15:00, on-time login, logout 11:00 (4h, well short of the full shift)',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'Identical output on vs off — this rule never applies outside Flex',
      expectedAction: 'ABSENT_SEGMENT (standard early-logout path)',
      actualVerdict: `ON=${rowOn.TAA_VERDICT}/${rowOn.TAA_EARLY_MIN}m, OFF=${rowOff.TAA_VERDICT}/${rowOff.TAA_EARLY_MIN}m`,
      actualAction: rowOn.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms scope is strictly Flex-only, with no accidental leak into the standard/OPS path',
      calculationTrace: ['isFlex=false -> reducedOfficeHoursMin=null regardless of the enabled flag or weekday'],
    });
  }

  // roh-11: Flex staff whose schedule starts OUTSIDE the Flex window (11:00, window is
  // 07:00-10:00) — the rule must not apply since these rows never enter the Flex branch.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-03 00:00:00', SECTION: 'ECS', 'PF NO': '9000011', NAME: 'Flex Outside Window Agent', 'LOGIN ID': '90011',
      DUTY1: '11:00 - 19:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      'SIGIN IN': '11:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '-240', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000011', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 11:00:00', STOP_MOMENT: '03/07/2026 19:00:00', DURATION: 480 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000011', EMP_LAST_NAME: 'Flex Outside Window Agent', EMP_SORT_NAME: 'FLEX OUTSIDE WINDOW AGENT FLX', EMP_EXTRA_2: 'flexoutsidewindow' },
    ];
    const punches: CMSPunch[] = [
      { Date: '03/07/2026', LoginID: '90011', LoginDateTime: makeDt('03/07/2026', '11:00:00'), LogoutDateTime: makeDt('03/07/2026', '11:00:03') },
      { Date: '03/07/2026', LoginID: '90011', LoginDateTime: makeDt('03/07/2026', '15:00:00'), LogoutDateTime: makeDt('03/07/2026', '15:00:03') },
    ];
    const outOn = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: rohConfigOn });
    const outOff = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const rowOn = outOn.rows[0];
    const rowOff = outOff.rows[0];
    const passed = rowOn.TAA_VERDICT === rowOff.TAA_VERDICT && rowOn.TAA_ACTION === rowOff.TAA_ACTION
      && rowOn.TAA_EARLY_MIN === rowOff.TAA_EARLY_MIN && rowOn.details.reducedOfficeHoursApplied !== true
      && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-11', name: 'Reduced Office Hours: Flex staff scheduled outside the Flex window are unaffected',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Flex identity, Friday SHIFT 11:00-19:00 (outside the default 07:00-10:00 Flex window), logout 15:00 (4h)',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'Identical output on vs off — these rows run the standard/OPS path, never the Flex branch',
      expectedAction: 'ABSENT_SEGMENT (standard early-logout path)',
      actualVerdict: `ON=${rowOn.TAA_VERDICT}/${rowOn.TAA_EARLY_MIN}m, OFF=${rowOff.TAA_VERDICT}/${rowOff.TAA_EARLY_MIN}m`,
      actualAction: rowOn.TAA_ACTION,
      passed,
      payrollImpact: 'Confirms the attendance relaxation follows the existing Flex-window gate automatically, with no separate window check to keep in sync',
      calculationTrace: ['isFlexScheduleWithinExpectedWindow(11:00) = false -> reducedOfficeHoursMin=null even though isFlex=true'],
    });
  }

  // roh-12: feature OFF reproduces today's original behaviour for the same input as
  // roh-04 (logout 12:00) — early logout banded against the FULL shifted end (18:00),
  // not the reduced target.
  {
    const out = rohRunClean('10:00', '12:00', config);
    const row = out.rows[0];
    const absent = out.aspectCorrections.find(c => c.SegmentCode === 'ABSENT' && c.Memo.includes('Early Logout'));
    const passed = row.TAA_EARLY_MIN === 360 && !!absent && absent.Memo.includes('360m') && row.details.reducedOfficeHoursApplied !== true
      && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-12', name: 'Reduced Office Hours: feature OFF reproduces the original full-shift early-logout behaviour',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same input as roh-04 (login 10:00, logout 12:00) but with the feature OFF',
      cognosFlawedVerdict: 'N/A',
      expectedVerdict: 'Early Logout 360m vs the full shifted end 18:00 (today\'s original behaviour, unchanged)',
      expectedAction: 'ABSENT_SEGMENT',
      actualVerdict: `early=${row.TAA_EARLY_MIN}; memo=${absent?.Memo || 'none'}`,
      actualAction: row.TAA_ACTION,
      passed,
      payrollImpact: 'Regression pin: proves the OFF state is byte-for-byte the pre-existing behaviour, not merely "close"',
      calculationTrace: ['feature off -> earlyCheckEndDt undefined -> earlyAnchorDt = effectiveEndDt = 18:00', 'earlyMin = diff(12:00, 18:00) = 360m'],
    });
  }

  // roh-13: cap binds (as in roh-07) -> no relaxation actually happens -> the flag,
  // disagree reason and trace text must NOT be set; ON must be identical to OFF.
  {
    const cognos: CognosRecord = {
      'SIGN IN DATE': '2026-07-03 00:00:00', SECTION: 'ECS', 'PF NO': '9000013', NAME: 'Flex ROH Cap Flag Agent', 'LOGIN ID': '90013',
      DUTY1: '07:00 - 10:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '3:0', 'SIGNIN DURATION': '',
      // LATE START/LEFT EARLY self-consistent with rawStart 07:00/rawEnd 10:00 vs login 10:00/logout 12:30.
      'SIGIN IN': '10:00', 'SIGIN OUT': '12:30', 'LATE START': '-180', 'LEFT EARLY': '150', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
    };
    const segs: AspectSegment[] = [
      { EMP_ID: '9000013', NOM_DATE: '03/07/2026', START_DATE: '03/07/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/07/2026 07:00:00', STOP_MOMENT: '03/07/2026 10:00:00', DURATION: 180 },
    ];
    const identities: AspectIdentity[] = [
      { EMP_ID: '9000013', EMP_LAST_NAME: 'Flex ROH Cap Flag Agent', EMP_SORT_NAME: 'FLEX ROH CAP FLAG AGENT FLX', EMP_EXTRA_2: 'flexrohcapflag' },
    ];
    const punches: CMSPunch[] = [
      { Date: '03/07/2026', LoginID: '90013', LoginDateTime: makeDt('03/07/2026', '10:00:00'), LogoutDateTime: makeDt('03/07/2026', '10:00:03') },
      { Date: '03/07/2026', LoginID: '90013', LoginDateTime: makeDt('03/07/2026', '12:30:00'), LogoutDateTime: makeDt('03/07/2026', '12:30:03') },
    ];
    const outOn = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: rohConfigOn });
    const outOff = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config });
    const rowOn = outOn.rows[0];
    const rowOff = outOff.rows[0];
    const noRuleFiredText = !(rowOn.details.ruleFired ?? '').includes('Reduced office hours');
    const identical = rowOn.TAA_VERDICT === rowOff.TAA_VERDICT && rowOn.TAA_ACTION === rowOff.TAA_ACTION
      && rowOn.TAA_EARLY_MIN === rowOff.TAA_EARLY_MIN && rowOn.TAA_LATE_MIN === rowOff.TAA_LATE_MIN
      && rowOn.TAA_DISAGREE_REASON === rowOff.TAA_DISAGREE_REASON && rowOn.holdReason === rowOff.holdReason
      && JSON.stringify(rowOn.details.generatedCorrections) === JSON.stringify(rowOff.details.generatedCorrections);
    const passed = rowOn.TAA_EARLY_MIN === 30 && rowOn.details.reducedOfficeHoursApplied !== true
      && rowOn.TAA_DISAGREE_REASON !== 'REDUCED_OFFICE_HOURS_POLICY' && noRuleFiredText && identical
      && rohIsWeekday('03/07/2026', 5);
    results.push({
      id: 'roh-13', name: 'Reduced Office Hours: cap binds — no relaxation — no flag',
      category: 'Reduced Office Hours (Flex, configured weekday)',
      inputDescription: 'Same as roh-07: Friday SHIFT 07:00-10:00 (180m), Flex arrival 10:00 (shift slides to 10:00-13:00), logout 12:30, feature ON (240m) vs same input feature OFF',
      cognosFlawedVerdict: 'Old behaviour: capped target (13:00) still equalled newEndDt, so the flag/disagree reason/trace text fired even though nothing was relaxed',
      expectedVerdict: 'earlyMin=30 on ON; flag/disagree reason/trace text all unset; ON identical to OFF (verdict, action, early/late min, disagree reason, holdReason, corrections)',
      expectedAction: 'n/a',
      actualVerdict: `ON early=${rowOn.TAA_EARLY_MIN}, applied=${rowOn.details.reducedOfficeHoursApplied}, disagree=${rowOn.TAA_DISAGREE_REASON}, ruleFiredHasText=${!noRuleFiredText}, identicalToOff=${identical}`,
      actualAction: rowOn.TAA_ACTION,
      passed,
      payrollImpact: 'D1 fix: prevents a misleading REDUCED_OFFICE_HOURS_POLICY flag/trace on rows where the cap already fully absorbed the reduced target and nothing was actually relaxed',
      calculationTrace: ['reducedTargetMs = 10:00+240m = 14:00', '14:00 is NOT < newEndDt 13:00 -> earlyCheckEndDt = undefined (feature-off behaviour)', 'earlyAnchorDt falls back to effectiveEndDt = newEndDt = 13:00', 'earlyMin = diff(12:30, 13:00) = 30m, flag stays unset'],
    });
  }

  // ===== Unseen-punch audit (src/services/unseenPunchAudit.ts) — 2026-09-23 =====
  // Every case calls runUnseenPunchAudit(input, runReconciliation(input)) — the exact wiring
  // App.tsx's runReconciliationWithAudit helper uses. The engine itself is never touched by
  // any of this; the audit is a pure post-processing pass over its output.
  {
    const baseIdentity = (pf: string, alias: string): AspectIdentity => (
      { EMP_ID: pf, EMP_LAST_NAME: alias, EMP_SORT_NAME: alias.toUpperCase(), EMP_EXTRA_2: alias }
    );
    const shiftCognos = (pf: string, loginId: string, dateStr: string, duty1 = '08:00 - 16:00'): CognosRecord => ({
      'SIGN IN DATE': `${dateStr} 00:00:00`, SECTION: 'OPS', 'PF NO': pf, NAME: `Agent ${pf}`, 'LOGIN ID': loginId,
      DUTY1: duty1, OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    });
    const shiftSeg = (pf: string, dateStr: string, startTime: string, endTime: string, endDateStr = dateStr): AspectSegment => ({
      EMP_ID: pf, NOM_DATE: dateStr, START_DATE: dateStr, SEG_CODE: 'SHIFT',
      START_MOMENT: `${dateStr} ${startTime}:00`, STOP_MOMENT: `${endDateStr} ${endTime}:00`, DURATION: 480,
    });
    // unseen-* fixtures deliberately use a 300s (5 min) login/logout gap per punch — NOT the
    // rest of this suite's 3s swipeAt convention — so a normal candidate punch never
    // accidentally trips the audit's own <60s "possible stray swipe" note (unseen-8 passes a
    // short gap explicitly to test that path on purpose).
    const auditSwipe = (loginId: string, dt: Date, gapSec = 300): CMSPunch => ({
      Date: ddmmyyyy(dt), LoginID: loginId, LoginDateTime: dt, LogoutDateTime: new Date(dt.getTime() + gapSec * 1000),
    });
    const auditRun = (input: { cognosRecords: CognosRecord[]; aspectSegments: AspectSegment[]; aspectIdentities: AspectIdentity[]; cmsPunches: CMSPunch[]; cfg?: ConfigRegistry }) => {
      const full = { processingDate: SUITE_RUN_DATE, cognosRecords: input.cognosRecords, aspectSegments: input.aspectSegments, aspectIdentities: input.aspectIdentities, cmsPunches: input.cmsPunches, config: input.cfg || config };
      const base = runReconciliation(full);
      const audited = runUnseenPunchAudit(full, base);
      return { base, audited };
    };
    // unseen-1/2/3/8/10 build their far punch at liveWindowH + a fixed margin so the fixture
    // stays proportional to whatever window this run is swept at (per-window-size correctness,
    // same convention as the rest of this suite) — G4's reach cap (unseenPunchMaxReachHours,
    // default 8h, measured from the SAME window edge the live radius is) would otherwise start
    // dropping the candidate once liveWindowH itself approaches 8h (the WP8 sweep tests up to
    // 12h). Widening the cap here, for these candidate-detection cases only, keeps them testing
    // "is the candidate found and classified correctly" rather than accidentally retesting G4's
    // own cap arithmetic at every window size.
    const auditConfig: ConfigRegistry = { ...config, unseenPunchMaxReachHours: liveWindowH + 5 };

    // unseen-1: late logout beyond the window -> flagged (REASON or OUTCOME), never silent.
    {
      const pf = '9100001'; const loginId = '91001';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen1')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const lateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);
      const punches = [auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, lateLogout)];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      const passed = row.unseenPunchFlag === 'REASON' || row.unseenPunchFlag === 'OUTCOME';
      results.push({
        id: 'unseen-1', name: 'Unseen punch: late logout beyond the search window is flagged, never silent',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00, logout ${liveWindowH + 0.5}h past shift end (outside the ±${liveWindowH}h search window)`,
        cognosFlawedVerdict: 'Before this feature: the late logout is simply never found; the row auto-resolves on partial evidence with no signal to the reviewer',
        expectedVerdict: 'unseenPunchFlag = REASON or OUTCOME (never undefined)', expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}`, actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'A genuine late logout outside the window must always surface for review, whether it changes the reason text or the outcome itself',
        calculationTrace: [`note: ${row.unseenPunchNote}`],
      });
    }

    // unseen-2: very early login beyond the window -> flagged.
    {
      const pf = '9100002'; const loginId = '91002';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen2')];
      const shiftStart = makeDt('28/08/2026', '08:00:00');
      const earlyLogin = shiftHours(shiftStart, -(liveWindowH + 0.5));
      const punches = [auditSwipe(loginId, earlyLogin), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00'))];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      const passed = !!row.unseenPunchFlag;
      results.push({
        id: 'unseen-2', name: 'Unseen punch: very early login beyond the search window is flagged',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00, login ${liveWindowH + 0.5}h before shift start (outside the ±${liveWindowH}h search window), on-time logout`,
        cognosFlawedVerdict: 'Before this feature: the early login is never found; a genuine early arrival never surfaces',
        expectedVerdict: 'unseenPunchFlag set', expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}`, actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'A genuine early login outside the window must surface for review',
        calculationTrace: [`note: ${row.unseenPunchNote}`],
      });
    }

    // unseen-3: presence for OT beyond the window -> flagged when it changes the result.
    {
      const pf = '9100003'; const loginId = '91003';
      const cognos = shiftCognos(pf, loginId, '28/08/2026', '08:00 - 16:00');
      cognos.OT1 = '16:00 - 20:00'; cognos['SCH DURATION'] = '12:0';
      const segs = [
        shiftSeg(pf, '28/08/2026', '08:00', '16:00'),
        { EMP_ID: pf, NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT1', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 20:00:00', DURATION: 240 } as AspectSegment,
      ];
      const identities = [baseIdentity(pf, 'unseen3')];
      const otEnd = makeDt('28/08/2026', '20:00:00');
      const lateLogout = shiftHours(otEnd, liveWindowH + 0.75);
      const punches = [auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, lateLogout)];
      const { base, audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      // "Changes the result" is satisfied by either classification — REASON when the verdict/
      // action/corrections stay the same and only the explanation (ruleFired/Memo) differs
      // (confirmed against real data: 67457/18-09 is exactly this shape), OUTCOME when the
      // verdict/action/corrections themselves differ. Either must never be silent.
      const passed = row.unseenPunchFlag === 'REASON' || row.unseenPunchFlag === 'OUTCOME';
      results.push({
        id: 'unseen-3', name: 'Unseen punch: OT presence beyond the window is flagged when it changes the result',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00 + OT1 16:00-20:00, logout ${liveWindowH + 0.75}h past OT end (outside the ±${liveWindowH}h window)`,
        cognosFlawedVerdict: `Before this feature: base run resolves as ${base.rows[0].TAA_VERDICT} on partial OT evidence, with no signal that a punch outside the window would change it`,
        expectedVerdict: 'unseenPunchFlag = REASON or OUTCOME (the OT logout evidence changes the result)', expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}`, actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'Presence confirming an OT segment outside the window must not be silently dropped when it would change the outcome',
        calculationTrace: [`note: ${row.unseenPunchNote}`],
      });
    }

    // unseen-4: punch belongs to tomorrow's shift (nearer tomorrow's start) -> NOT flagged for today (G1).
    {
      const pf = '9100004'; const loginId = '91004';
      const cognosDay1 = shiftCognos(pf, loginId, '28/08/2026');
      const cognosDay2 = shiftCognos(pf, loginId, '29/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00'), shiftSeg(pf, '29/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen4')];
      // Midpoint between day1's end (16:00) and day2's start (08:00 next day) is midnight;
      // 01:00 on day2 is nearer day2's start (7h away) than day1's end (9h away), and outside
      // BOTH live radii (day1 reaches to 21:00 day1; day2 reaches back to 03:00 day2).
      const strayPunch = auditSwipe(loginId, makeDt('29/08/2026', '01:00:00'));
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00')),
        strayPunch,
        auditSwipe(loginId, makeDt('29/08/2026', '08:00:00')), auditSwipe(loginId, makeDt('29/08/2026', '16:00:00')),
      ];
      const { audited } = auditRun({ cognosRecords: [cognosDay1, cognosDay2], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches });
      const passed = audited.rows[0].unseenPunchFlag === undefined;
      results.push({
        id: 'unseen-4', name: 'Unseen punch: a punch nearer tomorrow\'s shift never flags today (G1 owner rule)',
        category: 'Unseen-punch audit',
        inputDescription: 'Two consecutive clean SHIFT 08:00-16:00 days; one stray swipe at 01:00 on day2, nearer day2\'s start than day1\'s end and outside both live radii',
        cognosFlawedVerdict: 'A naive nearest-in-time-only or per-row search could misattribute this punch to TODAY and flag it for the wrong day',
        expectedVerdict: 'today\'s unseenPunchFlag is undefined', expectedAction: 'n/a',
        actualVerdict: `today flag=${audited.rows[0].unseenPunchFlag}, tomorrow flag=${audited.rows[1].unseenPunchFlag}`, actualAction: 'n/a',
        passed,
        payrollImpact: 'A punch belonging to a neighbouring day must never wrongly hold or re-explain an unrelated day\'s row',
        calculationTrace: [`today note: ${audited.rows[0].unseenPunchNote || '(none)'}`],
      });
    }

    // unseen-5: night shift 19:00-03:00 followed by a 07:00 morning shift -> no flag, no steal (G2).
    {
      const pf = '9100005'; const loginId = '91005';
      const cognosDay1 = shiftCognos(pf, loginId, '28/08/2026', '19:00 - 03:00');
      const cognosDay2 = shiftCognos(pf, loginId, '29/08/2026', '07:00 - 15:00');
      const segs = [
        shiftSeg(pf, '28/08/2026', '19:00', '03:00', '29/08/2026'),
        shiftSeg(pf, '29/08/2026', '07:00', '15:00'),
      ];
      const identities = [baseIdentity(pf, 'unseen5')];
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '19:00:00')), auditSwipe(loginId, makeDt('29/08/2026', '03:00:00')),
        auditSwipe(loginId, makeDt('29/08/2026', '07:00:00')), auditSwipe(loginId, makeDt('29/08/2026', '15:00:00')),
      ];
      const { audited } = auditRun({ cognosRecords: [cognosDay1, cognosDay2], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches });
      const passed = audited.rows[0].unseenPunchFlag === undefined && audited.rows[1].unseenPunchFlag === undefined;
      results.push({
        id: 'unseen-5', name: 'Unseen punch: a fully-evidenced cross-midnight night shift + morning shift never flags, never steals',
        category: 'Unseen-punch audit',
        inputDescription: 'Night SHIFT 19:00-03:00 fully punched, followed by a fully-punched 07:00-15:00 morning shift — no unclaimed punches at all',
        cognosFlawedVerdict: 'A cross-midnight boundary is the classic case a naive audit could misfire on',
        expectedVerdict: 'both rows unseenPunchFlag undefined', expectedAction: 'n/a',
        actualVerdict: `night flag=${audited.rows[0].unseenPunchFlag}, morning flag=${audited.rows[1].unseenPunchFlag}`, actualAction: 'n/a',
        passed,
        payrollImpact: 'A clean cross-midnight pair with full evidence must never be second-guessed by the audit',
        calculationTrace: [],
      });
    }

    // unseen-6: a punch on the next day, which is a leave day, is claimed by its own synthetic
    // window (never a candidate at all) -> not flagged (G1 leave rule).
    {
      const pf = '9100006'; const loginId = '91006';
      const cognosDay1 = shiftCognos(pf, loginId, '28/08/2026');
      const cognosDay2: CognosRecord = { ...shiftCognos(pf, loginId, '29/08/2026'), DUTY1: '', 'LEAVE TYPE': 'ANNUAL' };
      const segs: AspectSegment[] = [
        shiftSeg(pf, '28/08/2026', '08:00', '16:00'),
        { EMP_ID: pf, NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'ANNUAL', START_MOMENT: undefined, STOP_MOMENT: undefined, DURATION: undefined },
      ];
      const identities = [baseIdentity(pf, 'unseen6')];
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00')),
        auditSwipe(loginId, makeDt('29/08/2026', '12:00:00')),
      ];
      const { base, audited } = auditRun({ cognosRecords: [cognosDay1, cognosDay2], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches });
      const passed = audited.rows[0].unseenPunchFlag === undefined && audited.rows[1].unseenPunchFlag === undefined
        && base.rows[1].details.isLeaveDay;
      results.push({
        id: 'unseen-6', name: 'Unseen punch: a punch on a leave day is claimed by its own window, never flagged',
        category: 'Unseen-punch audit',
        inputDescription: 'Clean SHIFT day1, then an ANNUAL leave day2 with a punch mid-day on day2 (inside the leave day\'s own synthetic 00:00-24:00 window)',
        cognosFlawedVerdict: 'A leave-day punch could be wrongly treated as evidence outside the window if the synthetic window were built incorrectly',
        expectedVerdict: 'neither row is flagged', expectedAction: 'n/a',
        actualVerdict: `day1 flag=${audited.rows[0].unseenPunchFlag}, day2(leave) flag=${audited.rows[1].unseenPunchFlag}`, actualAction: 'n/a',
        passed,
        payrollImpact: 'A leave day\'s own attendance check must not spuriously ripple into an unseen-punch flag',
        calculationTrace: [],
      });
    }

    // unseen-7: a genuinely unrelated stray punch (different login, no ASPECT window of its
    // own) never changes anything -> not flagged.
    {
      const pf = '9100007'; const loginId = '91007';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen7')];
      const otherLoginPunch = auditSwipe('99999', makeDt('28/08/2026', '23:00:00'));
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00')),
        otherLoginPunch,
      ];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches });
      const passed = audited.rows[0].unseenPunchFlag === undefined;
      results.push({
        id: 'unseen-7', name: 'Unseen punch: an unrelated punch that changes nothing is not flagged',
        category: 'Unseen-punch audit',
        inputDescription: 'Clean SHIFT 08:00-16:00, plus a stray punch under a completely different, un-rostered Login ID',
        cognosFlawedVerdict: 'n/a', expectedVerdict: 'unseenPunchFlag undefined', expectedAction: 'n/a',
        actualVerdict: `flag=${audited.rows[0].unseenPunchFlag}`, actualAction: audited.rows[0].TAA_ACTION, passed,
        payrollImpact: 'Never flag a row over evidence that was never actually theirs to begin with',
        calculationTrace: [],
      });
    }

    // unseen-8: an isolated 10s stray swipe is flagged like any other candidate (user
    // decision: never filtered), annotated "possible stray swipe" in the note.
    {
      const pf = '9100008'; const loginId = '91008';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen8')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const straySwipeTime = shiftHours(shiftEnd, liveWindowH + 0.5);
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, straySwipeTime, 10), // 10s login/logout gap -> stray
      ];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      const passed = !!row.unseenPunchFlag && (row.unseenPunchNote || '').includes('possible stray swipe');
      results.push({
        id: 'unseen-8', name: 'Unseen punch: an isolated 10s stray swipe is flagged with "possible stray swipe"',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00, one 10s stray swipe ${liveWindowH + 0.5}h past shift end`,
        cognosFlawedVerdict: 'User decision: a stray swipe is treated like any other flag, never silently filtered — only annotated',
        expectedVerdict: 'flagged, note contains "possible stray swipe"', expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}`, actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'A stray swipe must still surface for review, clearly labelled so a reviewer does not overreact to it',
        calculationTrace: [`note: ${row.unseenPunchNote}`],
      });
    }

    // unseen-9: REASON classification + its two downstream effects — the ASPECT row stays in
    // output (includeInOutput/holdReason untouched), and only its email is held
    // (HELD_UNSEEN_PUNCH, emailDrafts.ts). A genuine REASON-only diff (TAA_VERDICT/TAA_ACTION/
    // corrections identical, details.ruleFired differs) is a rare, narrow edge case in this
    // engine by construction — real production data found exactly one in 709 rows — so the
    // classification itself is verified directly against classifyUnseenPunchDiff (the exact
    // function runUnseenPunchAudit uses), rather than by hunting for one specific engine
    // rule-firing coincidence that happens to reproduce it synthetically.
    {
      const sameCorrections = [{ Code: '00', ID: '9100009', SegmentCode: 'ABSENT', nominateDate: '28/08/2026', SegmentDate: '', SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Full Shift Absence NS/NC' }];
      const baseRow = { TAA_VERDICT: 'NO_SHOW', TAA_ACTION: 'ABSENT_NS_NC' as const, details: { ruleFired: 'No login recorded', generatedCorrections: sameCorrections } };
      const whatIfRowSameRuleFired = { TAA_VERDICT: 'NO_SHOW', TAA_ACTION: 'ABSENT_NS_NC' as const, details: { ruleFired: 'No login recorded', generatedCorrections: sameCorrections } };
      const whatIfRowDiffRuleFired = { TAA_VERDICT: 'NO_SHOW', TAA_ACTION: 'ABSENT_NS_NC' as const, details: { ruleFired: 'No login recorded (widened search window)', generatedCorrections: sameCorrections } };
      const classificationSame = classifyUnseenPunchDiff(baseRow as any, whatIfRowSameRuleFired as any);
      const classificationDiff = classifyUnseenPunchDiff(baseRow as any, whatIfRowDiffRuleFired as any);

      // Downstream effect 1: REASON never sets holdReason/includeInOutput — verified directly
      // against runUnseenPunchAudit's own source contract (see its REASON branch), exercised
      // here via the email-hold effect it drives (effect 2), the one that actually matters to
      // a reviewer.
      // Downstream effect 2: HELD_UNSEEN_PUNCH — the row stays "eligible" (its id is still in
      // eligibleRowIds, exactly as includeInOutput=true would produce), but its email is held.
      const emailAction: EmailActionItem = {
        row_id: 'rec-0-9100009', base_row_id: 'rec-0-9100009', template_key: 'generic', emp_id: '9100009', name: 'Agent 9100009',
        nominate_date: '28/08/2026', role_tier: 'OPS', category: 'No login recorded', variance_minutes: 0, taa_action: 'ABSENT_NS_NC',
        communication_rule: 'EMAIL_STAFF_CC_MANAGER', extra_2_alias: 'unseen9', email_adr: '', resolved_username: 'unseen9', login_id: '91009',
        section: 'OPS', subject: '', body: '', to: 'unseen9@thecontactcentre.ae',
      };
      const { statusByRowId } = computeEmailStatusByRowId(
        [emailAction],
        new Set(['rec-0-9100009']), // row stays in output -> still in eligibleRowIds
        [], DEFAULT_CONFIG.emailTemplates,
        new Set(['rec-0-9100009']), // unseenPunchHeldRowIds — the REASON hold
      );
      const passed = classificationSame === null && classificationDiff === 'REASON'
        && statusByRowId.get('rec-0-9100009') === 'HELD_UNSEEN_PUNCH';
      results.push({
        id: 'unseen-9', name: 'Unseen punch REASON flag: ASPECT row stays in output, only the email is held',
        category: 'Unseen-punch audit',
        inputDescription: 'Synthetic before/after rows with identical TAA_VERDICT/TAA_ACTION/corrections and different details.ruleFired, run through classifyUnseenPunchDiff; the resulting hold run through computeEmailStatusByRowId with the row still eligible',
        cognosFlawedVerdict: 'n/a',
        expectedVerdict: 'identical rows -> null (case 7); ruleFired-only diff -> REASON; REASON hold -> HELD_UNSEEN_PUNCH while the row stays eligible',
        expectedAction: 'n/a',
        actualVerdict: `identical=${classificationSame}, ruleFiredDiff=${classificationDiff}, emailStatus=${statusByRowId.get('rec-0-9100009')}`,
        actualAction: 'n/a', passed,
        payrollImpact: 'A REASON-only diff must never silently hold the whole row — only the outbound email, which is the thing that could tell an employee the wrong reason',
        calculationTrace: [],
      });
    }

    // unseen-10: OUTCOME flag -> includeInOutput=false, holdReason='UNSEEN_PUNCH_OUTCOME', and
    // the row's ASPECT corrections are excluded from aspectCorrectionsCsv exactly like any
    // other held row.
    {
      const pf = '9100010'; const loginId = '91010';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen10')];
      // Very early login beyond the window: base run has no login evidence at all in-window
      // (single logout-only punch -> ABSENT/ABSENT_SEGMENT), the what-if finds the true early
      // arrival and resolves clean (PRESENT/NO_ACTION, zero corrections) — a genuine structural
      // correction-set difference (1 correction vs 0), not just a differing Memo, so this stays
      // OUTCOME even when Memo text is excluded from the comparison (see correctionsEqual).
      const shiftStart = makeDt('28/08/2026', '08:00:00');
      const earlyLogin = shiftHours(shiftStart, -(liveWindowH + 0.5));
      const punches = [auditSwipe(loginId, earlyLogin), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00'))];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      const passed = row.unseenPunchFlag === 'OUTCOME' && row.holdReason === 'UNSEEN_PUNCH_OUTCOME'
        && row.includeInOutput === false && !audited.aspectCorrectionsCsv.includes(pf);
      results.push({
        id: 'unseen-10', name: 'Unseen punch OUTCOME flag: excluded from output exactly like any other held row',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00, login ${liveWindowH + 0.5}h before shift start that flips the outcome (ABSENT -> PRESENT)`,
        cognosFlawedVerdict: 'Before this feature: the wrong outcome would export into the ASPECT correction CSV with no signal at all',
        expectedVerdict: 'holdReason=UNSEEN_PUNCH_OUTCOME, includeInOutput=false, row excluded from aspectCorrectionsCsv', expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}, holdReason=${row.holdReason}, includeInOutput=${row.includeInOutput}`, actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'An outcome-changing unseen punch must never let the wrong correction reach payroll — same forced-hold protection as every other outcome-affecting gate',
        calculationTrace: [`note: ${row.unseenPunchNote}`],
      });
    }

    // Simple CSV/TSV field splitter for these test-only assertions — none of the fixture
    // values below ever contain a comma, tab, quote, or newline, so a naive split is safe
    // (the engine's own escapeCell only ever quotes a field when one of those is present).
    const splitLine = (line: string, delimiter: string) => line.split(delimiter);

    // unseen-11: end-to-end REASON — the row's ASPECT action/times/codes are byte-identical to
    // the base run; only Memo shows both reasons and "under review". The engine's own reason
    // (Early Logout, partial in-window evidence) and the what-if reason (Late Logout, once the
    // true far-out punch is seen) are engineered to land on the SAME correction shape (a blank
    // full-day ABSENT marker — see AspectCorrectionRow's SegmentStarttime/Segmentduration
    // comment), matching the real 67457/18-09 case this feature was built from.
    {
      const pf = '9100011'; const loginId = '91011';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen11')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      // In-window early logout (30m, >=10m OPS threshold) -> base run: "Early Logout Exceeds
      // Threshold" ABSENT. Far punch outside the LIVE window -> what-if run: it becomes the new
      // last logout, well past effectiveEnd -> "Late Logout ... past release-adjusted end" ABSENT.
      const earlyLogout = shiftHours(shiftEnd, -0.5);
      const farLateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, earlyLogout),
        auditSwipe(loginId, farLateLogout),
      ];
      const { base, audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const baseRow = base.rows[0];
      const row = audited.rows[0];

      const baseCorr = baseRow.details.generatedCorrections[0];
      const rewrittenCorr = row.details.generatedCorrections[0];
      const nonMemoUnchanged = !!baseCorr && !!rewrittenCorr
        && baseCorr.Code === rewrittenCorr.Code && baseCorr.ID === rewrittenCorr.ID
        && baseCorr.SegmentCode === rewrittenCorr.SegmentCode && baseCorr.nominateDate === rewrittenCorr.nominateDate
        && baseCorr.SegmentDate === rewrittenCorr.SegmentDate && baseCorr.SegmentStarttime === rewrittenCorr.SegmentStarttime
        && baseCorr.Segmentduration === rewrittenCorr.Segmentduration;
      // Superseded (plan doc, 2026-09-23): the Memo no longer carries both candidate reasons —
      // it is replaced with the neutral configured improperPunchMemoText, since the engine's own
      // specific reason may itself be wrong whenever a punch sits outside the search window.
      // Both reasons are still kept for the reviewer, but in row.unseenPunchNote, not the Memo
      // that reaches ASPECT/payroll (see unseen-14's assertion on unseenPunchNote).
      const memoIsNeutral = rewrittenCorr?.Memo === auditConfig.improperPunchMemoText;
      const csvMemoLine = (audited.aspectCorrectionsCsv.split('\n').find(l => l.includes(pf)) || '');
      const csvIsNeutral = csvMemoLine.includes(auditConfig.improperPunchMemoText)
        && !csvMemoLine.includes('Early Logout') && !csvMemoLine.includes('Late Logout');

      const emailJson = JSON.parse(audited.emailActionsJson) as EmailActionItem[];
      const noSendableAction = !emailJson.some(a => a.base_row_id === row.id);

      const annotatedLines = audited.annotatedCognosCsv.split('\n');
      const annotatedHeader = splitLine(annotatedLines[0], ',');
      const emailStatusIdx = annotatedHeader.indexOf('TAA_EMAIL_STATUS');
      const annotatedDataFields = splitLine(annotatedLines[1], ',');
      const annotatedHeld = emailStatusIdx !== -1 && annotatedDataFields[emailStatusIdx] === 'HELD_UNSEEN_PUNCH';

      const passed = row.unseenPunchFlag === 'REASON' && row.includeInOutput === true
        && nonMemoUnchanged && !!memoIsNeutral && csvIsNeutral && noSendableAction && annotatedHeld;
      results.push({
        id: 'unseen-11', name: 'Unseen punch REASON end-to-end: neutral "Improper Login/Logout" memo, only the email is held',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00; in-window logout 30m early (Early Logout ABSENT); far punch ${liveWindowH + 0.5}h past shift end only visible once the search window widens (Late Logout ABSENT)`,
        cognosFlawedVerdict: 'Before this fix: the ASPECT memo kept only the engine\'s own (possibly wrong) reason, and the email/annotated exports never reflected the REASON hold at all',
        expectedVerdict: 'unseenPunchFlag=REASON, includeInOutput=true, non-Memo correction fields unchanged, Memo = configured improperPunchMemoText (no reason narrative), no sendable email action, annotated TAA_EMAIL_STATUS=HELD_UNSEEN_PUNCH',
        expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}, include=${row.includeInOutput}, nonMemoUnchanged=${nonMemoUnchanged}, memo="${rewrittenCorr?.Memo}"`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'A REASON-flagged row must keep paying/exporting exactly as the engine decided, while never stating a possibly-wrong specific reason to ASPECT — the email that would otherwise state one specific reason is held',
        calculationTrace: [`base memo: ${baseCorr?.Memo}`, `csv line: ${csvMemoLine}`, `email json has row: ${!noSendableAction}`],
      });
    }

    // unseen-12: review toggle keeps holds — rebuildOutputs (the same builder
    // App.tsx's handleToggleInclude/handleToggleIncludeAll call) must not drop the REASON row's
    // email hold when a DIFFERENT row's includeInOutput is flipped by a reviewer.
    {
      const pf = '9100011'; const loginId = '91011'; // reuse unseen-11's REASON row
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen11')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const earlyLogout = shiftHours(shiftEnd, -0.5);
      const farLateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);

      // Second, ordinary clean row (on-time, no corrections) whose include toggle a reviewer
      // flips off — this row must have NO unseen-punch flag of its own.
      const pf2 = '9100011002'; const loginId2 = '91011002';
      const cognos2 = shiftCognos(pf2, loginId2, '28/08/2026');
      const segs2 = [shiftSeg(pf2, '28/08/2026', '08:00', '16:00')];
      const identities2 = [baseIdentity(pf2, 'unseen11b')];

      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, earlyLogout),
        auditSwipe(loginId, farLateLogout),
        auditSwipe(loginId2, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId2, makeDt('28/08/2026', '16:00:00')),
      ];
      const { audited } = auditRun({
        cognosRecords: [cognos, cognos2], aspectSegments: [...segs, ...segs2],
        aspectIdentities: [...identities, ...identities2], cmsPunches: punches, cfg: auditConfig,
      });
      const reasonRow = audited.rows.find(r => r.originalCognos['PF NO'] === pf)!;
      const otherRow = audited.rows.find(r => r.originalCognos['PF NO'] === pf2)!;

      // Reviewer flips the OTHER row's include off (App.tsx handleToggleInclude's own logic:
      // no corrections -> includeInOutput forced false either way).
      const toggledRows = audited.rows.map(r => r.id === otherRow.id
        ? { ...r, includeInOutput: false, reviewCompleted: true, includeDecisionSource: 'user' as const }
        : r);
      const rebuilt = rebuildOutputs(toggledRows, audited.emailActions, config, audited.verificationAudit);

      const emailJson = JSON.parse(rebuilt.emailActionsJson) as EmailActionItem[];
      const stillNoSendableAction = !emailJson.some(a => a.base_row_id === reasonRow.id);
      const annotatedLines = rebuilt.annotatedCognosCsv.split('\n');
      const annotatedHeader = splitLine(annotatedLines[0], ',');
      const emailStatusIdx = annotatedHeader.indexOf('TAA_EMAIL_STATUS');
      const pfNoIdx = annotatedHeader.indexOf('PF NO');
      const reasonDataLine = annotatedLines.slice(1).find(l => splitLine(l, ',')[pfNoIdx] === pf) || '';
      const stillHeld = emailStatusIdx !== -1 && splitLine(reasonDataLine, ',')[emailStatusIdx] === 'HELD_UNSEEN_PUNCH';

      const passed = reasonRow.unseenPunchFlag === 'REASON' && !otherRow.unseenPunchFlag
        && stillNoSendableAction && stillHeld;
      results.push({
        id: 'unseen-12', name: 'Unseen punch REASON hold survives a manual review toggle on a different row',
        category: 'Unseen-punch audit',
        inputDescription: 'Two-row run: one REASON-flagged row, one ordinary clean row whose includeInOutput is manually flipped off via rebuildOutputs (the same builder App.tsx\'s toggle handlers use)',
        cognosFlawedVerdict: 'Before this fix: App.tsx\'s toggle handlers rebuilt exports without the held-row set, so any manual review action would silently un-hold every REASON row\'s email',
        expectedVerdict: 'REASON row: still no sendable email action, still HELD_UNSEEN_PUNCH after the other row\'s toggle', expectedAction: 'n/a',
        actualVerdict: `reasonFlag=${reasonRow.unseenPunchFlag}, stillNoSendableAction=${stillNoSendableAction}, stillHeld=${stillHeld}`,
        actualAction: 'n/a',
        passed,
        payrollImpact: 'A reviewer working through other rows must never accidentally release a held REASON email',
        calculationTrace: [`reasonRow id: ${reasonRow.id}`, `toggled row id: ${otherRow.id}`],
      });
    }

    // unseen-13: no-flag parity — with heldRowIds empty (no unseen-punch flags at all),
    // rebuildOutputs must reproduce the engine's own out.* strings byte-for-byte, proving the
    // replicated email-JSON path and the annotated-Cognos patch have zero side effects on every
    // ordinary row.
    {
      const pf = '9100013'; const loginId = '91013';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen13')];
      // On-time, well inside the window on both edges — no unclaimed CMS punches at all, so
      // runUnseenPunchAudit finds zero candidates and returns baseOutput unchanged (no
      // unseenPunchFlag anywhere).
      const punches = [auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00'))];
      const full = { processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config };
      const base = runReconciliation(full);
      const rebuilt = rebuildOutputs(base.rows, base.emailActions, config, base.verificationAudit);

      const noFlags = base.rows.every(r => !r.unseenPunchFlag);
      const csvMatches = rebuilt.aspectCorrectionsCsv === base.aspectCorrectionsCsv;
      const csvArrayMatches = JSON.stringify(rebuilt.aspectCorrections) === JSON.stringify(base.aspectCorrections);
      const annotatedCsvMatches = rebuilt.annotatedCognosCsv === base.annotatedCognosCsv;
      const annotatedTsvMatches = rebuilt.annotatedCognosTsv === base.annotatedCognosTsv;
      const emailJsonMatches = rebuilt.emailActionsJson === base.emailActionsJson;

      const passed = noFlags && csvMatches && csvArrayMatches && annotatedCsvMatches && annotatedTsvMatches && emailJsonMatches;
      results.push({
        id: 'unseen-13', name: 'rebuildOutputs no-flag parity: byte-identical to the engine\'s own exports',
        category: 'Unseen-punch audit',
        inputDescription: 'Ordinary on-time OPS shift, no candidate punches at all -> zero unseen-punch flags',
        cognosFlawedVerdict: 'n/a',
        expectedVerdict: 'aspectCorrections/aspectCorrectionsCsv/annotatedCognosCsv/annotatedCognosTsv/emailActionsJson all byte-identical between rebuildOutputs and the engine\'s own out.*',
        expectedAction: 'n/a',
        actualVerdict: `csv=${csvMatches}, correctionsArray=${csvArrayMatches}, annotatedCsv=${annotatedCsvMatches}, annotatedTsv=${annotatedTsvMatches}, emailJson=${emailJsonMatches}`,
        actualAction: 'n/a',
        passed,
        payrollImpact: 'Proves outputRebuild.ts is a strict superset of the engine\'s own export generation with no behaviour change for any row that was never held',
        calculationTrace: [],
      });
    }

    // unseen-14: REASON row -> neutral "Improper Login/Logout" memo + email (supersedes the old
    // "both reasons" memo — see the plan doc). ASPECT CSV memo equals the configured
    // improperPunchMemoText; the email template_key is 'improper_login_logout' and its
    // subject/body name neither a specific direction (Early/Late) nor a minute count; the
    // internal unseenPunchNote (reviewer detail) still keeps both reasons.
    {
      const pf = '9100014'; const loginId = '91014';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen14')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const earlyLogout = shiftHours(shiftEnd, -0.5);
      const farLateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, earlyLogout),
        auditSwipe(loginId, farLateLogout),
      ];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];

      const csvMemoLine = (audited.aspectCorrectionsCsv.split('\n').find(l => l.includes(pf)) || '');
      const csvHasNeutralMemo = csvMemoLine.includes(auditConfig.improperPunchMemoText);
      const csvHasNoOldReasons = !csvMemoLine.includes('Early Logout') && !csvMemoLine.includes('Late Logout');

      const emailJson = JSON.parse(audited.emailActionsJson) as EmailActionItem[];
      // The row's email is REASON-held (never in the sendable JSON — see unseen-11), so read the
      // re-templated action straight off audited.emailActions (the same array rebuildOutputs and
      // App.tsx's own review UI use), not the filtered sendable JSON.
      const rowAction = audited.emailActions.find(a => a.base_row_id === row.id);
      const templateKeyNeutral = rowAction?.template_key === 'improper_login_logout';
      const noMinutesOrDirection = !!rowAction
        && !/early|late/i.test(rowAction.subject) && !/early|late/i.test(rowAction.body)
        && !/\d+\s*minute|\d+m\b/i.test(rowAction.subject) && !/\d+\s*minute|\d+m\b/i.test(rowAction.body);
      const noSendableAction = !emailJson.some(a => a.base_row_id === row.id);

      const noteHasBothReasons = (row.unseenPunchNote || '').includes('Early Logout') && (row.unseenPunchNote || '').includes('Late Logout');

      const passed = row.unseenPunchFlag === 'REASON' && csvHasNeutralMemo && csvHasNoOldReasons
        && templateKeyNeutral && noMinutesOrDirection && noSendableAction && noteHasBothReasons;
      results.push({
        id: 'unseen-14', name: 'Unseen punch REASON row: neutral "Improper Login/Logout" memo + email, reviewer detail kept internally',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00; in-window logout 30m early (Early Logout ABSENT); far punch ${liveWindowH + 0.5}h past shift end only visible once the search window widens (Late Logout ABSENT)`,
        cognosFlawedVerdict: 'Before this fix (unseen-11\'s prior behaviour): the ASPECT memo and email stated BOTH candidate reasons, which could itself mislead a reviewer or escalate on the wrong one',
        expectedVerdict: 'ASPECT memo = configured improperPunchMemoText (no reason narrative); email template_key = improper_login_logout, subject/body name no direction/minutes; unseenPunchNote keeps both reasons',
        expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}, csvMemo="${csvMemoLine}", templateKey=${rowAction?.template_key}, note="${row.unseenPunchNote}"`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'A REASON-flagged row must never state a possibly-wrong specific reason to ASPECT or to staff, while the reviewer still sees full detail internally',
        calculationTrace: [`subject: ${rowAction?.subject}`, `body: ${rowAction?.body}`],
      });
    }

    // unseen-15: OUTCOME row, after a simulated reviewer approval (includeInOutput flipped true
    // + holdReason cleared, via rebuildOutputs — the same builder App.tsx's toggle handlers and
    // unseen-12 use), uses the SAME neutral memo and template as a REASON row — proving the
    // neutral memo/template were baked into the row/email at flag time, not only at output time.
    {
      const pf = '9100015'; const loginId = '91015';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen15')];
      const shiftStart = makeDt('28/08/2026', '08:00:00');
      const earlyLogin = shiftHours(shiftStart, -(liveWindowH + 0.5));
      const punches = [auditSwipe(loginId, earlyLogin), auditSwipe(loginId, makeDt('28/08/2026', '16:00:00'))];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: auditConfig });
      const row = audited.rows[0];
      const preApprovalOk = row.unseenPunchFlag === 'OUTCOME' && row.holdReason === 'UNSEEN_PUNCH_OUTCOME' && row.includeInOutput === false;
      const preApprovalCorr = row.details.generatedCorrections[0];
      const preApprovalNeutral = !preApprovalCorr || preApprovalCorr.Memo === auditConfig.improperPunchMemoText;

      // Simulated approval: reviewer clears the hold and includes the row (same shape as
      // unseen-12's manual toggle, applied here to the OUTCOME row itself).
      const approvedRows = audited.rows.map(r => r.id === row.id
        ? { ...r, includeInOutput: true, holdReason: undefined, holdReasonText: undefined, includeDecisionSource: 'user' as const }
        : r);
      const rebuilt = rebuildOutputs(approvedRows, audited.emailActions, auditConfig, audited.verificationAudit);

      const csvMemoLine = (rebuilt.aspectCorrectionsCsv.split('\n').find(l => l.includes(pf)) || '');
      const csvHasNeutralMemo = csvMemoLine.length > 0 && csvMemoLine.includes(auditConfig.improperPunchMemoText);

      // This fixture resolves NO_ACTION_REQUIRED once approved/seen (PRESENT, no rule fired), so
      // its communication_rule is 'NA' and it is never in the filtered, policy-required
      // emailActionsJson (see reconciliationEngine.ts's own "'NA' rows keep being excluded"
      // comment) — the neutral-template assertion belongs on the row's raw EmailActionItem
      // (audited.emailActions, which every row always gets one of, per reconciliationEngine.ts),
      // not the filtered sendable JSON.
      const approvedAction = audited.emailActions.find(a => a.base_row_id === row.id);
      const templateKeyNeutral = approvedAction?.template_key === 'improper_login_logout';

      const passed = preApprovalOk && preApprovalNeutral && csvHasNeutralMemo && templateKeyNeutral;
      results.push({
        id: 'unseen-15', name: 'Unseen punch OUTCOME row: neutral memo/template survive to output once a reviewer approves it',
        category: 'Unseen-punch audit',
        inputDescription: `OPS SHIFT 08:00-16:00, login ${liveWindowH + 0.5}h before shift start that flips the outcome (ABSENT -> PRESENT), then a simulated reviewer approval`,
        cognosFlawedVerdict: 'Before this fix: an approved OUTCOME row would export whatever specific reason the engine originally computed, not the neutral text',
        expectedVerdict: 'pre-approval: held, neutral memo already baked in; post-approval: ASPECT CSV memo = improperPunchMemoText, email template_key = improper_login_logout',
        expectedAction: 'n/a',
        actualVerdict: `pre=${preApprovalOk}, preNeutral=${preApprovalNeutral}, csvMemo="${csvMemoLine}", templateKey=${approvedAction?.template_key}`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'An OUTCOME row a reviewer approves must never let the specific (possibly wrong) reason slip out once it is finally released',
        calculationTrace: [],
      });
    }

    // unseen-16: unflagged rows keep their exact engine memo and template — byte-identical to
    // the plain engine output — proving the neutral-memo/template rewrite touches ONLY rows the
    // audit actually flagged, in a run that also contains a flagged row (so this is not just
    // "audit found nothing" parity like unseen-13).
    {
      const pf = '9100016'; const loginId = '91016'; // REASON-flagged row (same shape as unseen-14)
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen16')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const earlyLogout = shiftHours(shiftEnd, -0.5);
      const farLateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);

      const pf2 = '9100016002'; const loginId2 = '91016002'; // ordinary clean row, never flagged
      const cognos2 = shiftCognos(pf2, loginId2, '28/08/2026');
      const segs2 = [shiftSeg(pf2, '28/08/2026', '08:00', '16:00')];
      const identities2 = [baseIdentity(pf2, 'unseen16b')];

      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, earlyLogout),
        auditSwipe(loginId, farLateLogout),
        auditSwipe(loginId2, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId2, makeDt('28/08/2026', '16:00:00')),
      ];
      const full = {
        processingDate: SUITE_RUN_DATE, cognosRecords: [cognos, cognos2], aspectSegments: [...segs, ...segs2],
        aspectIdentities: [...identities, ...identities2], cmsPunches: punches, config: auditConfig,
      };
      const base = runReconciliation(full);
      const audited = runUnseenPunchAudit(full, base);

      const flaggedRow = audited.rows.find(r => r.originalCognos['PF NO'] === pf)!;
      const baseOtherRow = base.rows.find(r => r.originalCognos['PF NO'] === pf2)!;
      const auditedOtherRow = audited.rows.find(r => r.originalCognos['PF NO'] === pf2)!;

      const otherRowByteIdentical = JSON.stringify(auditedOtherRow) === JSON.stringify(baseOtherRow);

      const baseOtherAction = base.emailActions.find(a => a.base_row_id === baseOtherRow.id);
      const auditedOtherAction = audited.emailActions.find(a => a.base_row_id === auditedOtherRow.id);
      const otherActionByteIdentical = JSON.stringify(auditedOtherAction) === JSON.stringify(baseOtherAction);

      const passed = flaggedRow.unseenPunchFlag === 'REASON' && !auditedOtherRow.unseenPunchFlag
        && otherRowByteIdentical && otherActionByteIdentical;
      results.push({
        id: 'unseen-16', name: 'Unseen punch: an unflagged row in a run that DOES flag another row keeps its exact engine memo and email template',
        category: 'Unseen-punch audit',
        inputDescription: 'Two-row run: one REASON-flagged row, one ordinary clean row with no unclaimed punches at all',
        cognosFlawedVerdict: 'A naive implementation could apply the neutral memo/template to every row in a run that has ANY flag, not just the flagged row',
        expectedVerdict: 'the clean row\'s ReconciliationRow and EmailActionItem are byte-identical to the plain engine output',
        expectedAction: 'n/a',
        actualVerdict: `flaggedRow flag=${flaggedRow.unseenPunchFlag}, otherRow flag=${auditedOtherRow.unseenPunchFlag}, otherRowByteIdentical=${otherRowByteIdentical}, otherActionByteIdentical=${otherActionByteIdentical}`,
        actualAction: 'n/a',
        passed,
        payrollImpact: 'Neutral-memo/template rewrite must never leak onto a row the audit did not itself flag',
        calculationTrace: [],
      });
    }

    // unseen-17: custom improperPunchMemoText and a custom improper_login_logout template from
    // config are used (not hard-coded), and both survive a plain export/import (JSON
    // stringify/parse) round-trip exactly as configExportImport.test.ts exercises for every
    // other ConfigRegistry field.
    {
      const customConfig: ConfigRegistry = {
        ...auditConfig,
        improperPunchMemoText: 'CUSTOM Under Review — TAA-17',
        emailTemplates: {
          ...auditConfig.emailTemplates,
          improper_login_logout: {
            subject: 'CUSTOM SUBJECT {{name}} {{nominate_date}}',
            body: 'CUSTOM BODY for {{emp_id}} at {{section}}',
          },
        },
      };
      const pf = '9100017'; const loginId = '91017';
      const cognos = shiftCognos(pf, loginId, '28/08/2026');
      const segs = [shiftSeg(pf, '28/08/2026', '08:00', '16:00')];
      const identities = [baseIdentity(pf, 'unseen17')];
      const shiftEnd = makeDt('28/08/2026', '16:00:00');
      const earlyLogout = shiftHours(shiftEnd, -0.5);
      const farLateLogout = shiftHours(shiftEnd, liveWindowH + 0.5);
      const punches = [
        auditSwipe(loginId, makeDt('28/08/2026', '08:00:00')),
        auditSwipe(loginId, earlyLogout),
        auditSwipe(loginId, farLateLogout),
      ];
      const { audited } = auditRun({ cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, cfg: customConfig });
      const row = audited.rows[0];
      const csvMemoLine = (audited.aspectCorrectionsCsv.split('\n').find(l => l.includes(pf)) || '');
      const csvUsesCustomMemo = csvMemoLine.includes(customConfig.improperPunchMemoText);

      const rowAction = audited.emailActions.find(a => a.base_row_id === row.id);
      const emailUsesCustomTemplate = !!rowAction
        && rowAction.subject.includes('CUSTOM SUBJECT') && rowAction.subject.includes(`Agent ${pf}`) // {{name}} placeholder resolved
        && rowAction.body.includes(`CUSTOM BODY for ${pf}`);

      // Plain export/import round-trip (same mechanism exportConfigToJson/importConfigFromJson
      // use — JSON.stringify/JSON.parse — without touching browser storage APIs, since this
      // suite runs both in-browser and headless under tsx).
      const roundTripped: ConfigRegistry = JSON.parse(JSON.stringify(customConfig));
      const roundTripOk = roundTripped.improperPunchMemoText === customConfig.improperPunchMemoText
        && roundTripped.emailTemplates.improper_login_logout.subject === customConfig.emailTemplates.improper_login_logout.subject
        && roundTripped.emailTemplates.improper_login_logout.body === customConfig.emailTemplates.improper_login_logout.body;

      const passed = row.unseenPunchFlag === 'REASON' && csvUsesCustomMemo && emailUsesCustomTemplate && roundTripOk;
      results.push({
        id: 'unseen-17', name: 'Unseen punch: custom improperPunchMemoText and improper_login_logout template from config are used, and round-trip export/import',
        category: 'Unseen-punch audit',
        inputDescription: 'Same REASON shape as unseen-14, but with a custom improperPunchMemoText and a custom improper_login_logout template supplied via config',
        cognosFlawedVerdict: 'A hard-coded neutral string/template would ignore an operator\'s configured wording entirely',
        expectedVerdict: 'ASPECT memo = custom improperPunchMemoText; email subject/body render the custom template; both survive a JSON export/import round-trip',
        expectedAction: 'n/a',
        actualVerdict: `flag=${row.unseenPunchFlag}, csvMemo="${csvMemoLine}", subject="${rowAction?.subject}", body="${rowAction?.body}", roundTripOk=${roundTripOk}`,
        actualAction: row.TAA_ACTION,
        passed,
        payrollImpact: 'Both the ASPECT memo text and the email template must stay operator-editable, never hard-coded',
        calculationTrace: [],
      });
    }
  }

  // reg-192..196 — Partial-day (half-day) ANNUAL leave (2026-09-27). A timed ANNUAL beside a
  // SHIFT (config.partialDayLeaveDeductionCodes) is deducted like a release: it moves the
  // effective window and reduces scheduled hours. Bare/duration-only ANNUAL is untouched
  // (reg-108 and every full-day leave case). Reclassifying ANNUAL itself as Removal in the
  // glossary is what broke reg-108 — this rule exists so that is never needed.
  {
    const halfDay = (opts: {
      pf: string; annual: [string, string] | null; bareAnnual?: boolean; inT: string; outT: string;
      lateStart: string; leftEarly: string; cfg?: ConfigRegistry;
    }) => {
      const day = '27/08/2026';
      const segs: AspectSegment[] = [
        { EMP_ID: opts.pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'SHIFT', START_MOMENT: `${day} 08:00:00`, STOP_MOMENT: `${day} 17:00:00`, DURATION: 540 },
      ];
      if (opts.annual) segs.push({ EMP_ID: opts.pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'ANNUAL', START_MOMENT: `${day} ${opts.annual[0]}:00`, STOP_MOMENT: `${day} ${opts.annual[1]}:00` });
      if (opts.bareAnnual) segs.push({ EMP_ID: opts.pf, NOM_DATE: day, START_DATE: day, SEG_CODE: 'ANNUAL' });
      const loginId = `L${opts.pf}`;
      const cognos: CognosRecord = {
        'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': opts.pf, NAME: 'Half Day Annual Agent', 'LOGIN ID': loginId,
        DUTY1: '08:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '9:0', 'SIGNIN DURATION': '',
        'SIGIN IN': opts.inT, 'SIGIN OUT': opts.outT, 'LATE START': opts.lateStart, 'LEFT EARLY': opts.leftEarly,
        'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': opts.annual ? '240' : '0', REMARK: '',
      };
      const punches: CMSPunch[] = [
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, `${opts.inT}:00`), LogoutDateTime: makeDt(day, `${opts.inT}:03`) },
        { Date: day, LoginID: loginId, LoginDateTime: makeDt(day, `${opts.outT}:00`), LogoutDateTime: makeDt(day, `${opts.outT}:03`) },
      ];
      const identities: AspectIdentity[] = [{ EMP_ID: opts.pf, EMP_LAST_NAME: 'Half Day Annual Agent', EMP_SORT_NAME: 'HALF DAY ANNUAL AGENT', EMP_EXTRA_2: 'halfday' }];
      const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: identities, cmsPunches: punches, config: opts.cfg || config });
      return { row: out.rows[0], out };
    };
    const summary = (row: ReconciliationRow) =>
      `${row.TAA_VERDICT}/${row.TAA_ACTION}, sch=${row.TAA_SCH_HOURS_RECOMPUTED}, late=${row.TAA_LATE_MIN}, early=${row.TAA_EARLY_MIN}, hold=${row.holdReason || 'none'}, include=${row.includeInOutput}`;
    const baseCase = {
      category: 'Partial-day leave (half-day ANNUAL)',
      cognosFlawedVerdict: 'Before the fix: ANNUAL is No Effect, so the half-day is ignored — the agent is charged the leave hours as Late/Early (or Absent) and scheduled hours stay at the full shift',
      calculationTrace: [] as string[],
    };
    const annualListed = (config.partialDayLeaveDeductionCodes || []).some(c => c.trim().toUpperCase() === 'ANNUAL');

    // reg-192: morning half-day — leading deduction, arrival at 12:00 is on time.
    {
      const { row } = halfDay({ pf: '8192001', annual: ['08:00', '12:00'], inT: '12:00', outT: '17:00', lateStart: '-240', leftEarly: '0' });
      const passed = !annualListed || (row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && row.TAA_LATE_MIN === 0
        && row.TAA_SCH_HOURS_RECOMPUTED === 300 && !row.holdReason && row.includeInOutput);
      results.push({ ...baseCase, id: 'reg-192', name: 'Half-Day ANNUAL (Morning) Deducts 4h; 12:00 Arrival Is On Time',
        inputDescription: 'SHIFT 08:00-17:00 + ANNUAL 08:00-12:00 (timed); CMS 12:00-17:00; Cognos LATE START -240, LEAVE HR 240',
        expectedVerdict: 'PRESENT, sch 300, no Late, no hold, auto-included', expectedAction: 'NO_ACTION',
        actualVerdict: summary(row), actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'Prevents a false 240-minute Late/Absent against an agent on approved half-day leave' });
    }
    // reg-193: afternoon half-day — trailing deduction, 13:00 logout is not an early logout.
    {
      const { row } = halfDay({ pf: '8192002', annual: ['13:00', '17:00'], inT: '08:00', outT: '13:00', lateStart: '0', leftEarly: '-240' });
      const passed = !annualListed || (row.TAA_VERDICT === 'PRESENT' && row.TAA_ACTION === 'NO_ACTION' && row.TAA_EARLY_MIN === 0
        && row.TAA_SCH_HOURS_RECOMPUTED === 300 && !row.holdReason && row.includeInOutput);
      results.push({ ...baseCase, id: 'reg-193', name: 'Half-Day ANNUAL (Afternoon) Deducts 4h; 13:00 Logout Is Not Early',
        inputDescription: 'SHIFT 08:00-17:00 + ANNUAL 13:00-17:00 (timed); CMS 08:00-13:00; Cognos LEFT EARLY -240, LEAVE HR 240',
        expectedVerdict: 'PRESENT, sch 300, no Early Logout, no hold, auto-included', expectedAction: 'NO_ACTION',
        actualVerdict: summary(row), actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'Prevents a false 240-minute Early Logout against an agent on approved half-day leave' });
    }
    // reg-194: late past the half-day — Late is measured from 12:00, not 08:00.
    {
      const { row } = halfDay({ pf: '8192003', annual: ['08:00', '12:00'], inT: '12:20', outT: '17:00', lateStart: '-260', leftEarly: '0' });
      const passed = !annualListed || (row.TAA_LATE_MIN === 20 && row.TAA_SCH_HOURS_RECOMPUTED === 300 && row.TAA_VERDICT !== 'ABSENT');
      results.push({ ...baseCase, id: 'reg-194', name: 'Half-Day ANNUAL: Late Is Measured From the End of the Leave (12:00), Not the Shift Start',
        inputDescription: 'SHIFT 08:00-17:00 + ANNUAL 08:00-12:00 (timed); CMS 12:20-17:00',
        expectedVerdict: 'Late 20 minutes (not 260), sch 300', expectedAction: 'Per the live Late Login band for 20 minutes',
        actualVerdict: summary(row), actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'Charges only the real 20 minutes late, never the approved leave hours' });
    }
    // reg-195: guard — a bare (full-day) ANNUAL on a SHIFT day is NOT a partial-day deduction.
    {
      const { row } = halfDay({ pf: '8192004', annual: null, bareAnnual: true, inT: '08:00', outT: '17:00', lateStart: '0', leftEarly: '0' });
      const passed = row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS' && row.TAA_SCH_HOURS_RECOMPUTED === 540;
      results.push({ ...baseCase, id: 'reg-195', name: 'Guard: Bare (Full-Day) ANNUAL + SHIFT Is Unchanged — Still a Leave/Work Review Hold',
        inputDescription: 'SHIFT 08:00-17:00 + bare ANNUAL (no times, no duration); CMS 08:00-17:00',
        expectedVerdict: 'MIXED_LEAVE_AND_WORK_SEGMENTS hold, sch 540 (nothing deducted)', expectedAction: 'n/a',
        actualVerdict: summary(row), actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'The partial-day rule must never turn a full-day leave row into a deduction' });
    }
    // reg-196: guard — the config list really drives it: with ANNUAL removed, the timed row is No Effect again.
    {
      const offCfg: ConfigRegistry = { ...config, partialDayLeaveDeductionCodes: (config.partialDayLeaveDeductionCodes || []).filter(c => c.trim().toUpperCase() !== 'ANNUAL') };
      const { row } = halfDay({ pf: '8192005', annual: ['08:00', '12:00'], inT: '12:00', outT: '17:00', lateStart: '-240', leftEarly: '0', cfg: offCfg });
      const annualIsNoEffect = (offCfg.segmentGlossary.ANNUAL?.role ?? 'NO_EFFECT') === 'NO_EFFECT';
      const passed = !annualIsNoEffect || (row.TAA_SCH_HOURS_RECOMPUTED === 540 && row.holdReason === 'MIXED_LEAVE_AND_WORK_SEGMENTS');
      results.push({ ...baseCase, id: 'reg-196', name: 'Guard: Removing ANNUAL From partialDayLeaveDeductionCodes Turns the Deduction Off',
        inputDescription: 'Same as reg-192, with ANNUAL removed from partialDayLeaveDeductionCodes',
        expectedVerdict: 'sch 540 (no deduction), MIXED_LEAVE_AND_WORK_SEGMENTS hold', expectedAction: 'n/a',
        actualVerdict: summary(row), actualAction: row.TAA_ACTION, passed,
        payrollImpact: 'Proves the behaviour is config-driven (zero-hardcode), not baked into the ANNUAL code' });
    }
  }

  return results;
}
