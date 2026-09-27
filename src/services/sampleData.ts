import { CognosRecord, AspectSegment, AspectIdentity, CMSPunch } from '../types/taa';
import { parseDateTimeString } from './parsers';

// ============================================================================
// Sample "Load Sample Test Data" dataset.
//
// Organized into lettered scenario families, each exercising a distinct rule,
// algorithm, or hold reason of the reconciliation engine. EMP_ID/PF NO 600xxx
// and LOGIN ID 600xx are new employees added for this coverage pass; lower
// numeric IDs (90135621, 4507957, 4500116, 4500483, 455876/455877, 4508901-04)
// are the original 10 kept from the first sample set.
// ============================================================================

export function getSampleCognosRecords(): CognosRecord[] {
  return [
    // ---- Original 10 (kept; REMARK relabelled where it clarifies a family) ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '90135621', NAME: 'Said Al-Falasi', 'LOGIN ID': '11451',
      DUTY1: '19:00 - 03:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '18:57', 'SIGIN OUT': '18:57', 'LATE START': '3', 'LEFT EARLY': '-503', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Night shift cross-midnight (Family B: 3-min early login -> No Action; single punch -> Absent for the shift)',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '4507957', NAME: 'Rashid Al-Nuaimi', 'LOGIN ID': '11452',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '23:08', 'SIGIN OUT': '23:08', 'LATE START': '-8', 'LEFT EARLY': '-472', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family L: night SHIFT; 27/08',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '4507957', NAME: 'Rashid Al-Nuaimi', 'LOGIN ID': '11452',
      DUTY1: '', OT1: '', 'DUTY-2': '23:00 - 07:00', 'OT-2': '8:00', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '23:00', 'SIGIN OUT': '23:00', 'LATE START': '0', 'LEFT EARLY': '-480', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family L: OT2 standalone on P/H-LV day (no base SHIFT); attended in full',
    },
    {
      'SIGN IN DATE': '2026-08-29 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '4507957', NAME: 'Rashid Al-Nuaimi', 'LOGIN ID': '11452',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '23:00', 'SIGIN OUT': '07:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family L: night SHIFT; 29/08',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '4500116', NAME: 'Eman Eltayeb', 'LOGIN ID': '67356',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:13',
      'SIGIN IN': '07:00', 'SIGIN OUT': '14:13', 'LATE START': '0', 'LEFT EARLY': '-47', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'NURSNG:14:00 - 15:00( -60 Minutes) : Nursing hour approved',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '4500483', NAME: 'Minas Alabbas', 'LOGIN ID': '67645',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'NURSNG:16:00 - 17:00( -60 Minutes) :',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '455876', NAME: 'Fatima Al-Marzouqi', 'LOGIN ID': '68858',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '08:03',
      'SIGIN IN': '08:12', 'SIGIN OUT': '16:15', 'LATE START': '-72', 'LEFT EARLY': '75', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family J: Flex Branch A; non-grid arrival rounds to 08:00',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '455877', NAME: 'Mariam Al-Kaabi', 'LOGIN ID': '68859',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:59',
      'SIGIN IN': '10:01', 'SIGIN OUT': '18:01', 'LATE START': '-181', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family J: Flex Branch B; 1 min past absolute cutoff',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'OPS', 'PF NO': '4508901', NAME: 'Hassan Al-Zahiri', 'LOGIN ID': '67890',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '07:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: Cover Placement simple baseline',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'OPS', 'PF NO': '4508902', NAME: 'Sara Al-Blooshi', 'LOGIN ID': '67891',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family Q: 8h sentinel (-480)',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'SALES', 'PF NO': '4508903', NAME: 'Khaled Mansoori', 'LOGIN ID': '67892',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '06:54',
      'SIGIN IN': '09:06', 'SIGIN OUT': '16:00', 'LATE START': '-66', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family V: EMAIL_OPS unmapped Section (sectionMailboxMap ships empty -> default OPS mailbox; held if that is blank)',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'OPS', 'PF NO': '4508904', NAME: 'Amina Al-Hammadi', 'LOGIN ID': '67893',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480',
      REMARK: 'Annual leave; no login',
    },

    // ---- Family A: Late Login ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600001', NAME: 'Yousef Al-Marri', 'LOGIN ID': '60001',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:43',
      'SIGIN IN': '08:17', 'SIGIN OUT': '16:00', 'LATE START': '-17', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family A: OPS Late Login band (17m)',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600001', NAME: 'Yousef Al-Marri', 'LOGIN ID': '60001',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:58',
      'SIGIN IN': '09:02', 'SIGIN OUT': '16:00', 'LATE START': '-62', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family A: OPS Late Login cliff (62m) -> Absent + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600002', NAME: 'Nasser Al-Marri', 'LOGIN ID': '60002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:49',
      'SIGIN IN': '08:11', 'SIGIN OUT': '16:00', 'LATE START': '-11', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family A: Officer+ Late Login band floor (11m)',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600002', NAME: 'Nasser Al-Marri', 'LOGIN ID': '60002',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:59',
      'SIGIN IN': '09:01', 'SIGIN OUT': '16:00', 'LATE START': '-61', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family A/V: Officer+ Late Login cliff floor (61m) -> Absent + EMAIL_STAFF_CC_MANAGER (username-wins email baseline)',
    },

    // ---- Family B: Early Login ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600003', NAME: 'Mona Al-Suwaidi', 'LOGIN ID': '60003',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:20',
      'SIGIN IN': '07:40', 'SIGIN OUT': '16:00', 'LATE START': '20', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family B: OPS Early Login (20m early) -> No Action',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'CARE', 'PF NO': '600004', NAME: 'Faisal Al-Ketbi', 'LOGIN ID': '60004',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:55',
      'SIGIN IN': '07:05', 'SIGIN OUT': '16:00', 'LATE START': '55', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family B: Officer+ Early Login (55m early) -> No Action',
    },

    // ---- Family C: Early Logout ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600005', NAME: 'Layla Al-Hashimi', 'LOGIN ID': '60005',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:53',
      'SIGIN IN': '08:00', 'SIGIN OUT': '15:53', 'LATE START': '0', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family C: OPS Early Logout band (7m)',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600005', NAME: 'Layla Al-Hashimi', 'LOGIN ID': '60005',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:00', 'SIGIN OUT': '15:45', 'LATE START': '0', 'LEFT EARLY': '-15', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family C: OPS Early Logout cliff (15m) -> Absent + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600006', NAME: 'Marwan Al-Qassimi', 'LOGIN ID': '60006',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:47',
      'SIGIN IN': '08:00', 'SIGIN OUT': '15:47', 'LATE START': '0', 'LEFT EARLY': '-13', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family C: Officer+ Early Logout band (13m)',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600006', NAME: 'Marwan Al-Qassimi', 'LOGIN ID': '60006',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:35',
      'SIGIN IN': '08:00', 'SIGIN OUT': '15:35', 'LATE START': '0', 'LEFT EARLY': '-25', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family C: Officer+ Early Logout cliff (25m) -> Absent + EMAIL_STAFF_CC_MANAGER',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600007', NAME: 'Huda Al-Zaabi', 'LOGIN ID': '60007',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:52',
      'SIGIN IN': '08:00', 'SIGIN OUT': '14:52', 'LATE START': '0', 'LEFT EARLY': '-68', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family C: trailing NURSNG 15:00-16:00 -> effective end 15:00; 14:52 is 8m early vs effective end (band) but 68m vs raw 16:00 end (would be cliff Absent) -- release-adjusted comparison is authoritative',
    },

    // ---- Family D: Late Logout ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600008', NAME: 'Rashed Al-Mheiri', 'LOGIN ID': '60008',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '9:05',
      'SIGIN IN': '08:00', 'SIGIN OUT': '17:05', 'LATE START': '0', 'LEFT EARLY': '65', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family D: OPS Late Logout (65m past end) -> Absent + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '600009', NAME: 'Salim Al-Nuaimi', 'LOGIN ID': '60009',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '9:03',
      'SIGIN IN': '08:00', 'SIGIN OUT': '17:03', 'LATE START': '0', 'LEFT EARLY': '63', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family D: Officer+ Late Logout (63m past end) -> Absent + EMAIL_STAFF_CC_MANAGER',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600010', NAME: 'Aysha Al-Kaabi', 'LOGIN ID': '60010',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'CONFIRMED POLICY (not a data bug): trailing NURSNG 14:00-15:00 -> effective end 14:00. Logging out exactly at the rostered 15:00 end is still 60 min PAST the effective end -> Absent; even though the full rostered shift was worked. Mirrors regressionSuite.ts reg-49.',
    },

    // ---- Family E: No Login Record ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600011', NAME: 'Ibrahim Al-Shamsi', 'LOGIN ID': '60011',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family E: OPS No Login Record -> ABSENT_NS_NC + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600012', NAME: 'Latifa Al-Falasi', 'LOGIN ID': '60012',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family E: Officer+ No Login Record -> ABSENT_NS_NC + EMAIL_STAFF_CC_MANAGER',
    },

    // ---- Family F: single punch vs insufficient CMS coverage ----
    {
      'SIGN IN DATE': '2026-08-30 00:00:00', SECTION: 'ECS', 'PF NO': '600013', NAME: 'Khalfan Al-Mansoori', 'LOGIN ID': '60013',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family F: full-attendance bracket day (establishes wide CMS coverage for this LOGIN ID)',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600013', NAME: 'Khalfan Al-Mansoori', 'LOGIN ID': '60013',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family F: genuine single punch (login only; no logout). CMS coverage for this LOGIN ID spans 30/08-01/09; well beyond +/-4h -> coverage sufficient -> genuinely ABSENT_SEGMENT + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600013', NAME: 'Khalfan Al-Mansoori', 'LOGIN ID': '60013',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family F: full-attendance bracket day',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'CARE', 'PF NO': '600014', NAME: 'Sultan Al-Dhaheri', 'LOGIN ID': '60014',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family F: full-attendance bracket day (Officer+ variant)',
    },
    {
      'SIGN IN DATE': '2026-09-02 00:00:00', SECTION: 'CARE', 'PF NO': '600014', NAME: 'Sultan Al-Dhaheri', 'LOGIN ID': '60014',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family F: genuine single punch; Officer+ -> ABSENT_SEGMENT + EMAIL_STAFF_CC_MANAGER',
    },
    {
      'SIGN IN DATE': '2026-09-03 00:00:00', SECTION: 'CARE', 'PF NO': '600014', NAME: 'Sultan Al-Dhaheri', 'LOGIN ID': '60014',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family F: full-attendance bracket day',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600015', NAME: 'Ahmed Al-Rumaithi', 'LOGIN ID': '60015',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '08:03', 'SIGIN OUT': '', 'LATE START': '-3', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family F: isolated single-punch day; no CMS data for this LOGIN ID on any other day -> can never reach the +/-4h coverage radius -> held INSUFFICIENT_CMS_COVERAGE; never auto-Absent (contrast with 600013/600014)',
    },

    // ---- Family G: Cover Not Attended ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600016', NAME: 'Fatma Al-Ali', 'LOGIN ID': '60016',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family G: pre-existing COVER 16:00-16:09 unattended -> OPS band1 (5-9m); Absent; NA communication',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600016', NAME: 'Fatma Al-Ali', 'LOGIN ID': '60016',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family G: pre-existing COVER 16:00-16:12 unattended -> OPS band2 (10m+); Absent + EMAIL_OPS',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600017', NAME: 'Obaid Al-Marri', 'LOGIN ID': '60017',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family G: pre-existing COVER 16:00-16:15 unattended -> Officer+ band1 (6-19m); Absent; NA',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600017', NAME: 'Obaid Al-Marri', 'LOGIN ID': '60017',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family G: pre-existing COVER 16:00-16:25 unattended -> Officer+ band2 (20m+); Absent + EMAIL_STAFF_CC_MANAGER',
    },

    // ---- Family H: RLS added to OT with no adjustment ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600018', NAME: 'Reem Al-Suwaidi', 'LOGIN ID': '60018',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 17:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'RLS:16:00 - 17:00( -60 Minutes) : OT1 fully cancelled by identical-window RLS -> Rule 8 ADJUST_OT_RLS: OT1 60m recoded to SHIFT 60m (never a 00:00 OT row); NA',
    },

    // ---- Family J: Flex (2 new, added to the 2 kept above) ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '600019', NAME: 'Alia Al-Nuaimi', 'LOGIN ID': '60019',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '10:00', 'SIGIN OUT': '18:00', 'LATE START': '-180', 'LEFT EARLY': '180', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family J: Flex arrival exactly at the 10:00 cutoff (inclusive boundary) -> Branch A; shift-update only; no penalty',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'PRESTIGE', 'PF NO': '600020', NAME: 'Waleed Al-Otaiba', 'LOGIN ID': '60020',
      DUTY1: '14:00 - 22:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '14:00', 'SIGIN OUT': '22:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family J: Flex tag but scheduled 14:00-22:00; outside flexExpectedSchedStartWindow (07:00-10:00) -- standard rules run instead even with perfect attendance -- forced held FLEX_SCHEDULE_OUTSIDE_WINDOW',
    },

    // ---- Family K: NURSNG/release schedule-integrity edge cases ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600021', NAME: 'Naser Al-Blooshi', 'LOGIN ID': '60021',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: leading RLS 08:00-08:15 derives effectiveStart 08:15; arrival exact match (LATE START vs raw start still -15 -- the Cognos comparison column is always raw; independent of the release-adjusted verdict)',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '600021', NAME: 'Naser Al-Blooshi', 'LOGIN ID': '60021',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '14:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: duration-only trailing RLS (no timestamps; DURATION implied by removal window) still derives effective end 14:00 correctly',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600022', NAME: 'Amal Al-Qubaisi', 'LOGIN ID': '60022',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: RLS 10:00-11:00 sits MID-shift -> must be held (MID_SHIFT_REMOVAL_SEGMENT); never silently subtracted -- no fabricated absence',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600023', NAME: 'Badr Al-Ameri', 'LOGIN ID': '60023',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '14:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: overlapping RLS 14:00-15:00 + NURSNG 14:00-15:00 on the SAME window must union to 60m removed (net 420m); not double-subtract to 360m -- check TAA_SCH_HOURS_RECOMPUTED reads 420',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600024', NAME: 'Ghalia Al-Marzooqi', 'LOGIN ID': '60024',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '15:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: bare RLS (no DURATION; no timestamps) = full-day removal -> takes the whole scheduled day (480m here); soft hold FULL_DAY_REMOVAL_ON_SCHEDULED_DAY for reviewer release (2026-09-21)',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '600024', NAME: 'Ghalia Al-Marzooqi', 'LOGIN ID': '60024',
      DUTY1: '09:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:00',
      'SIGIN IN': '09:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '-60', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: timestamped trailing RLS 16:00-17:00 (60m) beside a duration-only trailing NURSNG (30m; no timestamps) in the same group -> held AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600025', NAME: 'Marya Al-Shehhi', 'LOGIN ID': '60025',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K: RLS timestamped 20:00-21:00; hours after shift end with no adjacency -> held REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600026', NAME: 'Homaid Al-Nuaimi', 'LOGIN ID': '60026',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family K/W: SHIFT DURATION field (400) contradicts its own 480-min START/STOP span -> held SEGMENT_STOP_DURATION_DISAGREE',
    },

    // ---- Family L: OT1 vs OT2 (new) ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600027', NAME: 'Sara Al-Yousef', 'LOGIN ID': '60027',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 18:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '10:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '18:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family L/P: OT1 tail-extension; fully attended; Cognos OT1 ships blank -> TAA fills from ASPECT recompute (COGNOS_BLANK fill-if-blank demo)',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600028', NAME: 'Majid Al-Kaabi', 'LOGIN ID': '60028',
      DUTY1: '', OT1: '', 'DUTY-2': '08:00 - 16:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family L/M: standalone OT2 on P/H-LV day; zero attendance -> No Login Record fires -> ABSENT_NS_NC; OT2 converts to SHIFT in the correction output',
    },

    // ---- Family M: Absent + OT conversion from a Late-Login trigger ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600029', NAME: 'Yasmin Al-Zaabi', 'LOGIN ID': '60029',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '16:00 - 18:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:55',
      'SIGIN IN': '09:05', 'SIGIN OUT': '18:00', 'LATE START': '-65', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family M: 65m late trips the OPS Late Login Absent cliff even though OT1 was scheduled and worked -- OT1 converts to SHIFT exactly once (distinct trigger path from Family L 600028\'s no-show conversion)',
    },

    // ---- Family N: Absent excludes leftover timed penalties ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600030', NAME: 'Sumaya Al-Mansoori', 'LOGIN ID': '60030',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:46',
      'SIGIN IN': '09:07', 'SIGIN OUT': '15:53', 'LATE START': '-67', 'LEFT EARLY': '-7', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family N: 67m late (Late Login Absent cliff) AND 7m early (Early Logout band) both fire on the same day -- final output must show only ABSENT; no leftover LATE/Log_off/COVER rows (mirrors golden H02/H03 cases)',
    },

    // ---- Family O: Leave-day integrity gate ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600031', NAME: 'Aisha Al-Rumaithi', 'LOGIN ID': '60031',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480',
      REMARK: 'Family O: ANNUAL day; real CMS login is 20 min (< 60 threshold) -> noise; No Action',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '600031', NAME: 'Aisha Al-Rumaithi', 'LOGIN ID': '60031',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family O: OFF day; real CMS login is 15 min (< 60 threshold) -> noise; No Action. Proves the leave-day gate applies to OFF even though OFF is not itself a "leave type"',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600032', NAME: 'Khalid Al-Hosani', 'LOGIN ID': '60032',
      DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '0:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '480',
      REMARK: 'Family O: ANNUAL day; real CMS login is a continuous 90 min (>= 60 threshold) -> converted to ABSENT (LEAVE_DAY_LOGIN_ANOMALY); reviewer-releasable; not forced-held',
    },

    // ---- Family P: Cognos comparison verdicts ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600033', NAME: 'Noora Al-Ketbi', 'LOGIN ID': '60033',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family P: clean MATCH baseline -- every recomputed column agrees with Cognos exactly',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600034', NAME: 'Thani Al-Shamsi', 'LOGIN ID': '60034',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '07:09', 'SIGIN OUT': '15:10', 'LATE START': '-9', 'LEFT EARLY': '10', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family P: the real Cognos calculation-failure shape -- genuine ~8h01m span from real SIGIN IN/OUT timestamps (Cognos itself correctly derived LATE START/LEFT EARLY from them) but SIGNIN DURATION printed as literal 00:00 -> genuine MISMATCH_FOUND hold; matches the documented 19-row real defect',
    },

    // ---- Family Q: Sentinel value detection (new; Sara above is the 8h/-480 baseline) ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600035', NAME: 'Fahad Al-Marri', 'LOGIN ID': '60035',
      DUTY1: '08:00 - 17:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '9:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-540', 'LEFT EARLY': '-540', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '540',
      REMARK: 'Family Q: 9h shift sentinel (-540); in the fixed cognosSentinelValues list',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600036', NAME: 'Munira Al-Kaabi', 'LOGIN ID': '60036',
      DUTY1: '08:00 - 18:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '10:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-600', 'LEFT EARLY': '-600', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '600',
      REMARK: 'Family Q: 10h shift sentinel (-600); NOT in the fixed [-480;-540] list -- only resolves via the structural value===-LEAVE HR check; proving the fix is not just a longer hardcoded list',
    },

    // ---- Family R: punch attribution across consecutive night shifts ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600037', NAME: 'Sami Al-Balushi', 'LOGIN ID': '60037',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:02',
      'SIGIN IN': '22:58', 'SIGIN OUT': '07:00', 'LATE START': '2', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family R: night1 of a back-to-back pair -- closing punch (28/08 07:00) must not double as night2\'s opening punch',
    },
    {
      'SIGN IN DATE': '2026-08-28 00:00:00', SECTION: 'ECS', 'PF NO': '600037', NAME: 'Sami Al-Balushi', 'LOGIN ID': '60037',
      DUTY1: '23:00 - 07:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:55',
      'SIGIN IN': '23:07', 'SIGIN OUT': '07:02', 'LATE START': '-7', 'LEFT EARLY': '2', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family R: night2; 7m late arrival -> Late+Cover; proves the time-window join correctly separated this from night1\'s close',
    },

    // ---- Family S: dedicated hold-reason showcase ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ACCESS CARD', 'PF NO': '600038', NAME: 'Rania Al-Falasi', 'LOGIN ID': '',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '-480', 'LEFT EARLY': '-480', 'LEAVE TYPE': 'U-ABSENT', 'LEAVE HR': '480',
      REMARK: 'Family S: blank Cognos LOGIN ID -> held MISSING_CMS_JOIN_KEY; never auto-Absent (real-data ACCESS CARD pattern)',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600039', NAME: 'Nawal Al-Dhaheri', 'LOGIN ID': '60039',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family S: ASPECT carries a fabricated SEG_CODE (ZXTEST) not in the Segment Glossary -> held UNCLASSIFIED_SEGMENT_CODE',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600040', NAME: 'Obaid Al-Falasi', 'LOGIN ID': '60040',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '00:00',
      'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family S: Cognos row present for this employee/date but no ASPECT segment exists at all (identity row still present) -> COGNOS_DATA_GAP / COGNOS_DATA_GAP_SEGMENT_NOT_REFLECTED',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600041', NAME: 'Hessa Al-Nuaimi', 'LOGIN ID': '60041',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': 'ANNUAL', 'LEAVE HR': '0',
      REMARK: 'Family S: both an ANNUAL and a SHIFT segment on the same employee-day -> held MIXED_LEAVE_AND_WORK_SEGMENTS; reviewer-releasable (not forced)',
    },

    // ---- Family T: Cover placement algorithm ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600042', NAME: 'Marwa Al-Ali', 'LOGIN ID': '60042',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:43',
      'SIGIN IN': '08:17', 'SIGIN OUT': '16:00', 'LATE START': '-17', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: incident (17m late) -> cover placed on next working day 01/09; which must land at that day\'s TRUE last-segment stop (16:00; after its own OT1 block); not the SHIFT\'s own 15:00 stop -- PRD Worked Example A',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600042', NAME: 'Marwa Al-Ali', 'LOGIN ID': '60042',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '15:00 - 16:00', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '9:00',
      'SIGIN IN': '07:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: target day; carries a second (OT1) block after the base SHIFT -- attended clean',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600043', NAME: 'Ali Al-Kaabi', 'LOGIN ID': '60043',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:54',
      'SIGIN IN': '08:06', 'SIGIN OUT': '16:00', 'LATE START': '-6', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: incident (6m late; OPS band floor) -> new 6m cover must stack immediately after the target day\'s existing pre-placed COVER (ends 15:12) -> new cover 15:12-15:18 -- PRD Worked Example B (stacking)',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600043', NAME: 'Ali Al-Kaabi', 'LOGIN ID': '60043',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: target day; already carries a pre-existing COVER 15:00-15:12 as if placed by a prior run',
    },
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600044', NAME: 'Saeed Al-Shehhi', 'LOGIN ID': '60044',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:45',
      'SIGIN IN': '08:15', 'SIGIN OUT': '16:00', 'LATE START': '-15', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family T: incident Thursday 27/08 (15m late); zero forward-looking ASPECT data at all -> default fallback nextWeekMonday: mondayOfIncidentWeek=24/08; +7 = Monday 31/08/2026; cover at 08:00-08:15 with the fixed fallback memo note',
    },

    // ---- Family U: headcount mapping gate showcase ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600045', NAME: 'Turki Al-Marri', 'LOGIN ID': '60045',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:55',
      'SIGIN IN': '08:05', 'SIGIN OUT': '16:00', 'LATE START': '-5', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family U: Cognos claims real attendance but this LOGIN ID has zero CMS punches anywhere -- standard No-Login-Record rule marks ABSENT_NS_NC; contradicting Cognos; the only 2 employees incrementing cognosClaimsAttendanceButNoCmsCount',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'DIGITAL', 'PF NO': '600046', NAME: 'Alyazia Al-Nuaimi', 'LOGIN ID': '60046',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '7:58',
      'SIGIN IN': '08:02', 'SIGIN OUT': '16:00', 'LATE START': '-2', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family U: Officer+ variant of the headcount-mapping-gap showcase',
    },

    // ---- Family V: email / Outlook recipient resolution priority chain ----
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600047', NAME: 'John Smith', 'LOGIN ID': '60047',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:55',
      'SIGIN IN': '09:05', 'SIGIN OUT': '16:00', 'LATE START': '-65', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family V: no username; corporate-domain EMP_EMAIL_ADR -> used as-is',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600048', NAME: 'Khalid Hassan', 'LOGIN ID': '60048',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:55',
      'SIGIN IN': '09:05', 'SIGIN OUT': '16:00', 'LATE START': '-65', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family V: no username; personal-domain EMP_EMAIL_ADR -> must fall through to NAME-based resolution with [VERIFY RECIPIENT]; never misresolve',
    },
    {
      'SIGN IN DATE': '2026-08-31 00:00:00', SECTION: 'ECS', 'PF NO': '600049', NAME: 'Maitha Al-Suwaidi', 'LOGIN ID': '60049',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:55',
      'SIGIN IN': '09:05', 'SIGIN OUT': '16:00', 'LATE START': '-65', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family V: neither username nor email present -> NAME-based fallback; [VERIFY RECIPIENT]',
    },
    {
      'SIGN IN DATE': '2026-09-01 00:00:00', SECTION: 'ECS', 'PF NO': '600050', NAME: 'Hamdan Al-Mazrouei', 'LOGIN ID': '60050',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '6:55',
      'SIGIN IN': '09:05', 'SIGIN OUT': '16:00', 'LATE START': '-65', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family V: terminated employee (EMP_TERM_DATE populated) -> resolution short-circuits before the chain even runs -- blank To: + [TERMINATED - VERIFY]',
    },

    // ---- Family W: duplicate segment resilience ----
    {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': '600051', NAME: 'Rawya Al-Kindi', 'LOGIN ID': '60051',
      DUTY1: '08:00 - 16:00', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '8:0', 'SIGNIN DURATION': '8:00',
      'SIGIN IN': '08:00', 'SIGIN OUT': '16:00', 'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0',
      REMARK: 'Family W: two byte-identical SHIFT rows in ASPECT for this employee-day -- net scheduled minutes must stay 480; not double to 960',
    },
  ];
}

export function getSampleAspectSegments(): AspectSegment[] {
  return [
    // ---- Original 10 (kept, unchanged) ----
    { EMP_ID: '90135621', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 19:00:00', STOP_MOMENT: '28/08/2026 03:00:00', DURATION: 480 },
    { EMP_ID: '4507957', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 23:00:00', STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 },
    { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'P/H-LV' },
    { EMP_ID: '4507957', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OT2', START_MOMENT: '28/08/2026 23:00:00', STOP_MOMENT: '29/08/2026 07:00:00', DURATION: 480 },
    { EMP_ID: '4507957', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 23:00:00', STOP_MOMENT: '30/08/2026 07:00:00', DURATION: 480 },
    { EMP_ID: '4500116', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '4500116', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 60 },
    { EMP_ID: '4500483', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 09:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 480 },
    { EMP_ID: '4500483', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 17:00:00', DURATION: 60 },
    { EMP_ID: '455876', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '455877', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '455877', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 07:00:00', STOP_MOMENT: '29/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '4508901', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '4508901', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 08:00:00', STOP_MOMENT: '29/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '4508902', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '4508903', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 08:00:00', STOP_MOMENT: '28/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '4508903', NOM_DATE: '29/08/2026', START_DATE: '29/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '29/08/2026 08:00:00', STOP_MOMENT: '29/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '4508904', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'ANNUAL' },

    // ---- Family A: Late Login ----
    { EMP_ID: '600001', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600001', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600002', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600002', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },

    // ---- Family B: Early Login ----
    { EMP_ID: '600003', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600004', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },

    // ---- Family C: Early Logout ----
    { EMP_ID: '600005', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600005', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600006', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600006', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600007', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600007', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'NURSNG', START_MOMENT: '01/09/2026 15:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 60 },

    // ---- Family D: Late Logout ----
    { EMP_ID: '600008', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600009', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    // Confirmed policy: effective-end measured, not raw end -- not a data bug
    { EMP_ID: '600010', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600010', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 60 },

    // ---- Family E: No Login Record ----
    { EMP_ID: '600011', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600012', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },

    // ---- Family F: single punch vs insufficient CMS coverage ----
    { EMP_ID: '600013', NOM_DATE: '30/08/2026', START_DATE: '30/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '30/08/2026 08:00:00', STOP_MOMENT: '30/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600013', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600013', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600014', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600014', NOM_DATE: '02/09/2026', START_DATE: '02/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '02/09/2026 08:00:00', STOP_MOMENT: '02/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600014', NOM_DATE: '03/09/2026', START_DATE: '03/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '03/09/2026 08:00:00', STOP_MOMENT: '03/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600015', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },

    // ---- Family G: Cover Not Attended (pre-existing COVER segments simulate a prior run's output) ----
    { EMP_ID: '600016', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600016', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'COVER', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 16:09:00', DURATION: 9 },
    { EMP_ID: '600016', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600016', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'COVER', START_MOMENT: '01/09/2026 16:00:00', STOP_MOMENT: '01/09/2026 16:12:00', DURATION: 12 },
    { EMP_ID: '600017', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600017', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'COVER', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 16:15:00', DURATION: 15 },
    { EMP_ID: '600017', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600017', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'COVER', START_MOMENT: '01/09/2026 16:00:00', STOP_MOMENT: '01/09/2026 16:25:00', DURATION: 25 },

    // ---- Family H: RLS added to OT ----
    { EMP_ID: '600018', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600018', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'OT1', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },
    { EMP_ID: '600018', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'RLS', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 60 },

    // ---- Family J: Flex ----
    { EMP_ID: '600019', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 07:00:00', STOP_MOMENT: '31/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600020', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 14:00:00', STOP_MOMENT: '31/08/2026 22:00:00', DURATION: 480 },

    // ---- Family K: NURSNG/release schedule-integrity edge cases ----
    { EMP_ID: '600021', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600021', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 08:15:00', DURATION: 15 },
    { EMP_ID: '600021', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 07:00:00', STOP_MOMENT: '28/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600021', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RLS', START_MOMENT: '28/08/2026 14:00:00', STOP_MOMENT: '28/08/2026 15:00:00' },
    { EMP_ID: '600022', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600022', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 10:00:00', STOP_MOMENT: '27/08/2026 11:00:00', DURATION: 60 },
    { EMP_ID: '600023', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600023', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 60 },
    { EMP_ID: '600023', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'NURSNG', START_MOMENT: '27/08/2026 14:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 60 },
    { EMP_ID: '600024', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600024', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS' },
    { EMP_ID: '600024', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 09:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 480 },
    { EMP_ID: '600024', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'RLS', START_MOMENT: '28/08/2026 16:00:00', STOP_MOMENT: '28/08/2026 17:00:00', DURATION: 60 },
    { EMP_ID: '600024', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'NURSNG', DURATION: 30 },
    { EMP_ID: '600025', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600025', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'RLS', START_MOMENT: '27/08/2026 20:00:00', STOP_MOMENT: '27/08/2026 21:00:00', DURATION: 60 },
    { EMP_ID: '600026', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 400 },

    // ---- Family L: OT1 vs OT2 ----
    { EMP_ID: '600027', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600027', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT1', START_MOMENT: '27/08/2026 16:00:00', STOP_MOMENT: '27/08/2026 18:00:00', DURATION: 120 },
    { EMP_ID: '600028', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'P/H-LV' },
    { EMP_ID: '600028', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'OT2', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },

    // ---- Family M: Absent + OT co-occurrence from Late Login ----
    { EMP_ID: '600029', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600029', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'OT1', START_MOMENT: '31/08/2026 16:00:00', STOP_MOMENT: '31/08/2026 18:00:00', DURATION: 120 },

    // ---- Family N: Absent excludes leftover timed penalties ----
    { EMP_ID: '600030', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },

    // ---- Family O: Leave-day integrity gate ----
    { EMP_ID: '600031', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    { EMP_ID: '600031', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'OFF' },
    { EMP_ID: '600032', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },

    // ---- Family P: Cognos comparison verdicts ----
    { EMP_ID: '600033', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600034', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 07:00:00', STOP_MOMENT: '27/08/2026 15:00:00', DURATION: 480 },

    // ---- Family Q: Sentinel value detection ----
    { EMP_ID: '600035', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 17:00:00', DURATION: 540 },
    { EMP_ID: '600036', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 18:00:00', DURATION: 600 },

    // ---- Family R: consecutive night shifts ----
    { EMP_ID: '600037', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 23:00:00', STOP_MOMENT: '28/08/2026 07:00:00', DURATION: 480 },
    { EMP_ID: '600037', NOM_DATE: '28/08/2026', START_DATE: '28/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '28/08/2026 23:00:00', STOP_MOMENT: '29/08/2026 07:00:00', DURATION: 480 },

    // ---- Family S: dedicated hold-reason showcase ----
    { EMP_ID: '600038', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600039', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600039', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ZXTEST', START_MOMENT: '27/08/2026 15:00:00', STOP_MOMENT: '27/08/2026 15:30:00', DURATION: 30 },
    // 600040 deliberately has NO AspectSegment row at all (COGNOS_DATA_GAP demo)
    { EMP_ID: '600041', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'ANNUAL' },
    { EMP_ID: '600041', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },

    // ---- Family T: Cover placement algorithm ----
    { EMP_ID: '600042', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600042', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 07:00:00', STOP_MOMENT: '01/09/2026 15:00:00', DURATION: 480 },
    { EMP_ID: '600042', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'OT1', START_MOMENT: '01/09/2026 15:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 60 },
    { EMP_ID: '600043', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600043', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600043', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'COVER', START_MOMENT: '01/09/2026 15:00:00', STOP_MOMENT: '01/09/2026 15:12:00', DURATION: 12 },
    { EMP_ID: '600044', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },

    // ---- Family U: headcount mapping gate showcase ----
    { EMP_ID: '600045', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600046', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },

    // ---- Family V: email / Outlook recipient resolution ----
    { EMP_ID: '600047', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600048', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600049', NOM_DATE: '31/08/2026', START_DATE: '31/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '31/08/2026 08:00:00', STOP_MOMENT: '31/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600050', NOM_DATE: '01/09/2026', START_DATE: '01/09/2026', SEG_CODE: 'SHIFT', START_MOMENT: '01/09/2026 08:00:00', STOP_MOMENT: '01/09/2026 16:00:00', DURATION: 480 },

    // ---- Family W: duplicate segment resilience ----
    { EMP_ID: '600051', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
    { EMP_ID: '600051', NOM_DATE: '27/08/2026', START_DATE: '27/08/2026', SEG_CODE: 'SHIFT', START_MOMENT: '27/08/2026 08:00:00', STOP_MOMENT: '27/08/2026 16:00:00', DURATION: 480 },
  ];
}

export function getSampleAspectIdentities(): AspectIdentity[] {
  return [
    // ---- Original 10 (kept, unchanged) ----
    { EMP_ID: '90135621', EMP_LAST_NAME: 'Said Al-Falasi', EMP_SORT_NAME: 'SAID AL-FALASI', EMP_EXTRA_2: 'sfalasi', EMP_EMAIL_ADR: 'sfalasi@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '4507957', EMP_LAST_NAME: 'Rashid Al-Nuaimi', EMP_SORT_NAME: 'RASHID AL-NUAIMI, OFCR', EMP_EXTRA_2: 'rnuaimi', EMP_EMAIL_ADR: 'rnuaimi@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '4500116', EMP_LAST_NAME: 'Eman Eltayeb', EMP_SORT_NAME: 'EMAN ELTAYEB', EMP_EXTRA_2: 'eeltayeb', EMP_EMAIL_ADR: 'eeltayeb@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '4500483', EMP_LAST_NAME: 'Minas Alabbas', EMP_SORT_NAME: 'MINAS ALABBAS, ES OFCR', EMP_EXTRA_2: 'malabbas', EMP_EMAIL_ADR: 'malabbas@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '455876', EMP_LAST_NAME: 'Fatima Al-Marzouqi', EMP_SORT_NAME: 'FATIMA AL-MARZOUQI - FLX', EMP_EXTRA_2: 'fmarzouqi', EMP_EMAIL_ADR: 'fmarzouqi@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '455877', EMP_LAST_NAME: 'Mariam Al-Kaabi', EMP_SORT_NAME: 'MARIAM AL-KAABI - FELX', EMP_EXTRA_2: 'mkaabi', EMP_EMAIL_ADR: 'mkaabi@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '4508901', EMP_LAST_NAME: 'Hassan Al-Zahiri', EMP_SORT_NAME: 'HASSAN AL-ZAHIRI', EMP_EXTRA_2: 'hzahiri', EMP_EMAIL_ADR: 'hzahiri@thecontactcentre.ae', EMP_EXTRA_4: 'OPS' },
    { EMP_ID: '4508902', EMP_LAST_NAME: 'Sara Al-Blooshi', EMP_SORT_NAME: 'SARA AL-BLOOSHI', EMP_EXTRA_2: 'sblooshi', EMP_EMAIL_ADR: 'sblooshi@thecontactcentre.ae', EMP_EXTRA_4: 'OPS' },
    { EMP_ID: '4508903', EMP_LAST_NAME: 'Khaled Mansoori', EMP_SORT_NAME: 'KHALED MANSOORI', EMP_EXTRA_2: 'kmansoori', EMP_EMAIL_ADR: 'kmansoori@thecontactcentre.ae', EMP_EXTRA_4: 'SALES' },
    { EMP_ID: '4508904', EMP_LAST_NAME: 'Amina Al-Hammadi', EMP_SORT_NAME: 'AMINA AL-HAMMADI', EMP_EXTRA_2: 'ahammadi', EMP_EMAIL_ADR: 'ahammadi@thecontactcentre.ae', EMP_EXTRA_4: 'OPS' },

    // ---- New employees (usernames suffixed with EMP_ID's last 2 digits for guaranteed uniqueness) ----
    { EMP_ID: '600001', EMP_LAST_NAME: 'Yousef Al-Marri', EMP_SORT_NAME: 'YOUSEF AL-MARRI', EMP_EXTRA_2: 'ymarri01', EMP_EMAIL_ADR: 'ymarri01@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600002', EMP_LAST_NAME: 'Nasser Al-Marri', EMP_SORT_NAME: 'NASSER AL-MARRI, SUPERVISOR', EMP_EXTRA_2: 'nalmarri02', EMP_EMAIL_ADR: 'nasser.private@gmail.com', EMP_EXTRA_4: 'DIGITAL' },
    { EMP_ID: '600003', EMP_LAST_NAME: 'Mona Al-Suwaidi', EMP_SORT_NAME: 'MONA AL-SUWAIDI', EMP_EXTRA_2: 'msuwaidi03', EMP_EMAIL_ADR: 'msuwaidi03@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600004', EMP_LAST_NAME: 'Faisal Al-Ketbi', EMP_SORT_NAME: 'FAISAL AL-KETBI, ANALYST', EMP_EXTRA_2: 'fketbi04', EMP_EMAIL_ADR: 'fketbi04@thecontactcentre.ae', EMP_EXTRA_4: 'CARE' },
    { EMP_ID: '600005', EMP_LAST_NAME: 'Layla Al-Hashimi', EMP_SORT_NAME: 'LAYLA AL-HASHIMI', EMP_EXTRA_2: 'lhashimi05', EMP_EMAIL_ADR: 'lhashimi05@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600006', EMP_LAST_NAME: 'Marwan Al-Qassimi', EMP_SORT_NAME: 'MARWAN AL-QASSIMI, COORDINATOR', EMP_EXTRA_2: 'mqassimi06', EMP_EMAIL_ADR: 'mqassimi06@thecontactcentre.ae', EMP_EXTRA_4: 'DIGITAL' },
    { EMP_ID: '600007', EMP_LAST_NAME: 'Huda Al-Zaabi', EMP_SORT_NAME: 'HUDA AL-ZAABI', EMP_EXTRA_2: 'hzaabi07', EMP_EMAIL_ADR: 'hzaabi07@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600008', EMP_LAST_NAME: 'Rashed Al-Mheiri', EMP_SORT_NAME: 'RASHED AL-MHEIRI', EMP_EXTRA_2: 'rmheiri08', EMP_EMAIL_ADR: 'rmheiri08@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600009', EMP_LAST_NAME: 'Salim Al-Nuaimi', EMP_SORT_NAME: 'SALIM AL-NUAIMI, OFCR', EMP_EXTRA_2: 'salnuaimi09', EMP_EMAIL_ADR: 'salnuaimi09@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '600010', EMP_LAST_NAME: 'Aysha Al-Kaabi', EMP_SORT_NAME: 'AYSHA AL-KAABI', EMP_EXTRA_2: 'akaabi10', EMP_EMAIL_ADR: 'akaabi10@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600011', EMP_LAST_NAME: 'Ibrahim Al-Shamsi', EMP_SORT_NAME: 'IBRAHIM AL-SHAMSI', EMP_EXTRA_2: 'ishamsi11', EMP_EMAIL_ADR: 'ishamsi11@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600012', EMP_LAST_NAME: 'Latifa Al-Falasi', EMP_SORT_NAME: 'LATIFA AL-FALASI, SPECIALIST', EMP_EXTRA_2: 'lfalasi12', EMP_EMAIL_ADR: 'lfalasi12@thecontactcentre.ae', EMP_EXTRA_4: 'DIGITAL' },
    { EMP_ID: '600013', EMP_LAST_NAME: 'Khalfan Al-Mansoori', EMP_SORT_NAME: 'KHALFAN AL-MANSOORI', EMP_EXTRA_2: 'kmansoori13', EMP_EMAIL_ADR: 'kmansoori13@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600014', EMP_LAST_NAME: 'Sultan Al-Dhaheri', EMP_SORT_NAME: 'SULTAN AL-DHAHERI, COORDINATOR', EMP_EXTRA_2: 'sdhaheri14', EMP_EMAIL_ADR: 'sdhaheri14@thecontactcentre.ae', EMP_EXTRA_4: 'CARE' },
    { EMP_ID: '600015', EMP_LAST_NAME: 'Ahmed Al-Rumaithi', EMP_SORT_NAME: 'AHMED AL-RUMAITHI', EMP_EXTRA_2: 'arumaithi15', EMP_EMAIL_ADR: 'arumaithi15@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600016', EMP_LAST_NAME: 'Fatma Al-Ali', EMP_SORT_NAME: 'FATMA AL-ALI', EMP_EXTRA_2: 'fali16', EMP_EMAIL_ADR: 'fali16@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600017', EMP_LAST_NAME: 'Obaid Al-Marri', EMP_SORT_NAME: 'OBAID AL-MARRI, SUPERVISOR', EMP_EXTRA_2: 'omarri17', EMP_EMAIL_ADR: 'omarri17@thecontactcentre.ae', EMP_EXTRA_4: 'DIGITAL' },
    { EMP_ID: '600018', EMP_LAST_NAME: 'Reem Al-Suwaidi', EMP_SORT_NAME: 'REEM AL-SUWAIDI', EMP_EXTRA_2: 'rsuwaidi18', EMP_EMAIL_ADR: 'rsuwaidi18@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600019', EMP_LAST_NAME: 'Alia Al-Nuaimi', EMP_SORT_NAME: 'ALIA AL-NUAIMI - FLIX', EMP_EXTRA_2: 'analnuaimi19', EMP_EMAIL_ADR: 'analnuaimi19@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '600020', EMP_LAST_NAME: 'Waleed Al-Otaiba', EMP_SORT_NAME: 'WALEED AL-OTAIBA - FLEX', EMP_EXTRA_2: 'wotaiba20', EMP_EMAIL_ADR: 'wotaiba20@thecontactcentre.ae', EMP_EXTRA_4: 'PRESTIGE' },
    { EMP_ID: '600021', EMP_LAST_NAME: 'Naser Al-Blooshi', EMP_SORT_NAME: 'NASER AL-BLOOSHI', EMP_EXTRA_2: 'nblooshi21', EMP_EMAIL_ADR: 'nblooshi21@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600022', EMP_LAST_NAME: 'Amal Al-Qubaisi', EMP_SORT_NAME: 'AMAL AL-QUBAISI', EMP_EXTRA_2: 'aqubaisi22', EMP_EMAIL_ADR: 'aqubaisi22@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600023', EMP_LAST_NAME: 'Badr Al-Ameri', EMP_SORT_NAME: 'BADR AL-AMERI', EMP_EXTRA_2: 'bameri23', EMP_EMAIL_ADR: 'bameri23@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600024', EMP_LAST_NAME: 'Ghalia Al-Marzooqi', EMP_SORT_NAME: 'GHALIA AL-MARZOOQI', EMP_EXTRA_2: 'gmarzooqi24', EMP_EMAIL_ADR: 'gmarzooqi24@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600025', EMP_LAST_NAME: 'Marya Al-Shehhi', EMP_SORT_NAME: 'MARYA AL-SHEHHI', EMP_EXTRA_2: 'mshehhi25', EMP_EMAIL_ADR: 'mshehhi25@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600026', EMP_LAST_NAME: 'Homaid Al-Nuaimi', EMP_SORT_NAME: 'HOMAID AL-NUAIMI', EMP_EXTRA_2: 'hnuaimi26', EMP_EMAIL_ADR: 'hnuaimi26@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600027', EMP_LAST_NAME: 'Sara Al-Yousef', EMP_SORT_NAME: 'SARA AL-YOUSEF', EMP_EXTRA_2: 'salyousef27', EMP_EMAIL_ADR: 'salyousef27@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600028', EMP_LAST_NAME: 'Majid Al-Kaabi', EMP_SORT_NAME: 'MAJID AL-KAABI', EMP_EXTRA_2: 'mkaabi28', EMP_EMAIL_ADR: 'mkaabi28@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600029', EMP_LAST_NAME: 'Yasmin Al-Zaabi', EMP_SORT_NAME: 'YASMIN AL-ZAABI', EMP_EXTRA_2: 'yzaabi29', EMP_EMAIL_ADR: 'yzaabi29@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600030', EMP_LAST_NAME: 'Sumaya Al-Mansoori', EMP_SORT_NAME: 'SUMAYA AL-MANSOORI', EMP_EXTRA_2: 'smansoori30', EMP_EMAIL_ADR: 'smansoori30@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600031', EMP_LAST_NAME: 'Aisha Al-Rumaithi', EMP_SORT_NAME: 'AISHA AL-RUMAITHI', EMP_EXTRA_2: 'arumaithi31', EMP_EMAIL_ADR: 'arumaithi31@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600032', EMP_LAST_NAME: 'Khalid Al-Hosani', EMP_SORT_NAME: 'KHALID AL-HOSANI', EMP_EXTRA_2: 'khosani32', EMP_EMAIL_ADR: 'khosani32@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600033', EMP_LAST_NAME: 'Noora Al-Ketbi', EMP_SORT_NAME: 'NOORA AL-KETBI', EMP_EXTRA_2: 'nketbi33', EMP_EMAIL_ADR: 'nketbi33@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600034', EMP_LAST_NAME: 'Thani Al-Shamsi', EMP_SORT_NAME: 'THANI AL-SHAMSI', EMP_EXTRA_2: 'talshamsi34', EMP_EMAIL_ADR: 'talshamsi34@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600035', EMP_LAST_NAME: 'Fahad Al-Marri', EMP_SORT_NAME: 'FAHAD AL-MARRI', EMP_EXTRA_2: 'fmarri35', EMP_EMAIL_ADR: 'fmarri35@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600036', EMP_LAST_NAME: 'Munira Al-Kaabi', EMP_SORT_NAME: 'MUNIRA AL-KAABI', EMP_EXTRA_2: 'mkaabi36', EMP_EMAIL_ADR: 'mkaabi36@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600037', EMP_LAST_NAME: 'Sami Al-Balushi', EMP_SORT_NAME: 'SAMI AL-BALUSHI', EMP_EXTRA_2: 'sbalushi37', EMP_EMAIL_ADR: 'sbalushi37@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600038', EMP_LAST_NAME: 'Rania Al-Falasi', EMP_SORT_NAME: 'RANIA AL-FALASI', EMP_EXTRA_2: 'ralfalasi38', EMP_EMAIL_ADR: 'ralfalasi38@thecontactcentre.ae', EMP_EXTRA_4: 'ACCESS CARD' },
    { EMP_ID: '600039', EMP_LAST_NAME: 'Nawal Al-Dhaheri', EMP_SORT_NAME: 'NAWAL AL-DHAHERI', EMP_EXTRA_2: 'ndhaheri39', EMP_EMAIL_ADR: 'ndhaheri39@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600040', EMP_LAST_NAME: 'Obaid Al-Falasi', EMP_SORT_NAME: 'OBAID AL-FALASI', EMP_EXTRA_2: 'oalfalasi40', EMP_EMAIL_ADR: 'oalfalasi40@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600041', EMP_LAST_NAME: 'Hessa Al-Nuaimi', EMP_SORT_NAME: 'HESSA AL-NUAIMI', EMP_EXTRA_2: 'hnuaimi41', EMP_EMAIL_ADR: 'hnuaimi41@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600042', EMP_LAST_NAME: 'Marwa Al-Ali', EMP_SORT_NAME: 'MARWA AL-ALI', EMP_EXTRA_2: 'mali42', EMP_EMAIL_ADR: 'mali42@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600043', EMP_LAST_NAME: 'Ali Al-Kaabi', EMP_SORT_NAME: 'ALI AL-KAABI', EMP_EXTRA_2: 'akaabi43', EMP_EMAIL_ADR: 'akaabi43@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600044', EMP_LAST_NAME: 'Saeed Al-Shehhi', EMP_SORT_NAME: 'SAEED AL-SHEHHI', EMP_EXTRA_2: 'sshehhi44', EMP_EMAIL_ADR: 'sshehhi44@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600045', EMP_LAST_NAME: 'Turki Al-Marri', EMP_SORT_NAME: 'TURKI AL-MARRI', EMP_EXTRA_2: 'talmarri45', EMP_EMAIL_ADR: 'talmarri45@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600046', EMP_LAST_NAME: 'Alyazia Al-Nuaimi', EMP_SORT_NAME: 'ALYAZIA AL-NUAIMI, SUPERVISOR', EMP_EXTRA_2: 'aalnuaimi46', EMP_EMAIL_ADR: 'aalnuaimi46@thecontactcentre.ae', EMP_EXTRA_4: 'DIGITAL' },
    { EMP_ID: '600047', EMP_LAST_NAME: 'John Smith', EMP_SORT_NAME: 'JOHN SMITH, OFCR', EMP_EXTRA_2: '', EMP_EMAIL_ADR: 'jsmith@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600048', EMP_LAST_NAME: 'Khalid Hassan', EMP_SORT_NAME: 'KHALID HASSAN, ANALYST', EMP_EXTRA_2: '', EMP_EMAIL_ADR: 'k.hassan@hotmail.com', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600049', EMP_LAST_NAME: 'Maitha Al-Suwaidi', EMP_SORT_NAME: 'MAITHA AL-SUWAIDI, SPECIALIST', EMP_EXTRA_2: '', EMP_EMAIL_ADR: '', EMP_EXTRA_4: 'ECS' },
    { EMP_ID: '600050', EMP_LAST_NAME: 'Hamdan Al-Mazrouei', EMP_SORT_NAME: 'HAMDAN AL-MAZROUEI, COORDINATOR', EMP_EXTRA_2: 'hmazrouei50', EMP_EMAIL_ADR: 'hmazrouei50@thecontactcentre.ae', EMP_EXTRA_4: 'ECS', EMP_TERM_DATE: '15/08/2026', EMP_ACTIVE_FLAG: 'F' },
    { EMP_ID: '600051', EMP_LAST_NAME: 'Rawya Al-Kindi', EMP_SORT_NAME: 'RAWYA AL-KINDI', EMP_EXTRA_2: 'rkindi51', EMP_EMAIL_ADR: 'rkindi51@thecontactcentre.ae', EMP_EXTRA_4: 'ECS' },
  ];
}

export function getSampleCmsPunches(): CMSPunch[] {
  const parse = (dStr: string) => parseDateTimeString(dStr)!;

  return [
    // ---- Original 10 (kept, unchanged) ----
    { Date: '27/08/2026', LoginID: '11451', LoginDateTime: parse('27/08/2026 18:57:00'), LogoutDateTime: parse('27/08/2026 18:57:04') },
    { Date: '28/08/2026', LoginID: '11451', LoginDateTime: parse('28/08/2026 03:00:00'), LogoutDateTime: parse('28/08/2026 03:00:05') },
    { Date: '27/08/2026', LoginID: '11452', LoginDateTime: parse('27/08/2026 23:08:00'), LogoutDateTime: parse('27/08/2026 23:08:05') },
    { Date: '28/08/2026', LoginID: '11452', LoginDateTime: parse('28/08/2026 07:00:00'), LogoutDateTime: parse('28/08/2026 07:00:05') },
    { Date: '28/08/2026', LoginID: '11452', LoginDateTime: parse('28/08/2026 23:00:00'), LogoutDateTime: parse('28/08/2026 23:00:05') },
    { Date: '29/08/2026', LoginID: '11452', LoginDateTime: parse('29/08/2026 07:00:00'), LogoutDateTime: parse('29/08/2026 07:00:05') },
    // Family L: 29/08 night SHIFT arrival/departure (relabelled 3rd Cognos row needs matching evidence)
    { Date: '29/08/2026', LoginID: '11452', LoginDateTime: parse('29/08/2026 23:00:00'), LogoutDateTime: parse('29/08/2026 23:00:05') },
    { Date: '30/08/2026', LoginID: '11452', LoginDateTime: parse('30/08/2026 07:00:00'), LogoutDateTime: parse('30/08/2026 07:00:05') },
    { Date: '27/08/2026', LoginID: '67356', LoginDateTime: parse('27/08/2026 07:00:00'), LogoutDateTime: parse('27/08/2026 07:00:03') },
    { Date: '27/08/2026', LoginID: '67356', LoginDateTime: parse('27/08/2026 14:13:00'), LogoutDateTime: parse('27/08/2026 14:13:03') },
    { Date: '27/08/2026', LoginID: '67645', LoginDateTime: parse('27/08/2026 09:00:00'), LogoutDateTime: parse('27/08/2026 09:00:03') },
    { Date: '27/08/2026', LoginID: '67645', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },
    { Date: '28/08/2026', LoginID: '68858', LoginDateTime: parse('28/08/2026 08:12:00'), LogoutDateTime: parse('28/08/2026 08:12:03') },
    { Date: '28/08/2026', LoginID: '68858', LoginDateTime: parse('28/08/2026 16:15:00'), LogoutDateTime: parse('28/08/2026 16:15:03') },
    { Date: '28/08/2026', LoginID: '68859', LoginDateTime: parse('28/08/2026 10:01:00'), LogoutDateTime: parse('28/08/2026 10:01:03') },
    { Date: '28/08/2026', LoginID: '68859', LoginDateTime: parse('28/08/2026 18:01:00'), LogoutDateTime: parse('28/08/2026 18:01:03') },
    { Date: '28/08/2026', LoginID: '67890', LoginDateTime: parse('28/08/2026 08:15:00'), LogoutDateTime: parse('28/08/2026 08:15:03') },
    { Date: '28/08/2026', LoginID: '67890', LoginDateTime: parse('28/08/2026 16:00:00'), LogoutDateTime: parse('28/08/2026 16:00:03') },
    { Date: '28/08/2026', LoginID: '67892', LoginDateTime: parse('28/08/2026 09:06:00'), LogoutDateTime: parse('28/08/2026 09:06:03') },
    { Date: '28/08/2026', LoginID: '67892', LoginDateTime: parse('28/08/2026 16:00:00'), LogoutDateTime: parse('28/08/2026 16:00:03') },

    // ---- Family A ----
    { Date: '31/08/2026', LoginID: '60001', LoginDateTime: parse('31/08/2026 08:17:00'), LogoutDateTime: parse('31/08/2026 08:17:03') },
    { Date: '31/08/2026', LoginID: '60001', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60001', LoginDateTime: parse('01/09/2026 09:02:00'), LogoutDateTime: parse('01/09/2026 09:02:03') },
    { Date: '01/09/2026', LoginID: '60001', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60002', LoginDateTime: parse('31/08/2026 08:11:00'), LogoutDateTime: parse('31/08/2026 08:11:03') },
    { Date: '31/08/2026', LoginID: '60002', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60002', LoginDateTime: parse('01/09/2026 09:01:00'), LogoutDateTime: parse('01/09/2026 09:01:03') },
    { Date: '01/09/2026', LoginID: '60002', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },

    // ---- Family B ----
    { Date: '31/08/2026', LoginID: '60003', LoginDateTime: parse('31/08/2026 07:40:00'), LogoutDateTime: parse('31/08/2026 07:40:03') },
    { Date: '31/08/2026', LoginID: '60003', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60004', LoginDateTime: parse('31/08/2026 07:05:00'), LogoutDateTime: parse('31/08/2026 07:05:03') },
    { Date: '31/08/2026', LoginID: '60004', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },

    // ---- Family C ----
    { Date: '31/08/2026', LoginID: '60005', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60005', LoginDateTime: parse('31/08/2026 15:53:00'), LogoutDateTime: parse('31/08/2026 15:53:03') },
    { Date: '01/09/2026', LoginID: '60005', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60005', LoginDateTime: parse('01/09/2026 15:45:00'), LogoutDateTime: parse('01/09/2026 15:45:03') },
    { Date: '31/08/2026', LoginID: '60006', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60006', LoginDateTime: parse('31/08/2026 15:47:00'), LogoutDateTime: parse('31/08/2026 15:47:03') },
    { Date: '01/09/2026', LoginID: '60006', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60006', LoginDateTime: parse('01/09/2026 15:35:00'), LogoutDateTime: parse('01/09/2026 15:35:03') },
    { Date: '01/09/2026', LoginID: '60007', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60007', LoginDateTime: parse('01/09/2026 14:52:00'), LogoutDateTime: parse('01/09/2026 14:52:03') },

    // ---- Family D ----
    { Date: '31/08/2026', LoginID: '60008', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60008', LoginDateTime: parse('31/08/2026 17:05:00'), LogoutDateTime: parse('31/08/2026 17:05:03') },
    { Date: '01/09/2026', LoginID: '60009', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60009', LoginDateTime: parse('01/09/2026 17:03:00'), LogoutDateTime: parse('01/09/2026 17:03:03') },
    { Date: '27/08/2026', LoginID: '60010', LoginDateTime: parse('27/08/2026 07:00:00'), LogoutDateTime: parse('27/08/2026 07:00:03') },
    { Date: '27/08/2026', LoginID: '60010', LoginDateTime: parse('27/08/2026 15:00:00'), LogoutDateTime: parse('27/08/2026 15:00:03') },

    // ---- Family E: No Login Record -- 600011/600012 deliberately have zero CMS punches ----

    // ---- Family F ----
    { Date: '30/08/2026', LoginID: '60013', LoginDateTime: parse('30/08/2026 08:00:00'), LogoutDateTime: parse('30/08/2026 08:00:03') },
    { Date: '30/08/2026', LoginID: '60013', LoginDateTime: parse('30/08/2026 16:00:00'), LogoutDateTime: parse('30/08/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60013', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60013', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60013', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60014', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60014', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '02/09/2026', LoginID: '60014', LoginDateTime: parse('02/09/2026 08:00:00'), LogoutDateTime: parse('02/09/2026 08:00:03') },
    { Date: '03/09/2026', LoginID: '60014', LoginDateTime: parse('03/09/2026 08:00:00'), LogoutDateTime: parse('03/09/2026 08:00:03') },
    { Date: '03/09/2026', LoginID: '60014', LoginDateTime: parse('03/09/2026 16:00:00'), LogoutDateTime: parse('03/09/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60015', LoginDateTime: parse('31/08/2026 08:03:00'), LogoutDateTime: parse('31/08/2026 08:03:03') },

    // ---- Family G ----
    { Date: '31/08/2026', LoginID: '60016', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60016', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60016', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60016', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60017', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60017', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60017', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60017', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },

    // ---- Family H ----
    { Date: '31/08/2026', LoginID: '60018', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60018', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },

    // ---- Family J ----
    { Date: '31/08/2026', LoginID: '60019', LoginDateTime: parse('31/08/2026 10:00:00'), LogoutDateTime: parse('31/08/2026 10:00:03') },
    { Date: '31/08/2026', LoginID: '60019', LoginDateTime: parse('31/08/2026 18:00:00'), LogoutDateTime: parse('31/08/2026 18:00:03') },
    { Date: '31/08/2026', LoginID: '60020', LoginDateTime: parse('31/08/2026 14:00:00'), LogoutDateTime: parse('31/08/2026 14:00:03') },
    { Date: '31/08/2026', LoginID: '60020', LoginDateTime: parse('31/08/2026 22:00:00'), LogoutDateTime: parse('31/08/2026 22:00:03') },

    // ---- Family K ----
    { Date: '27/08/2026', LoginID: '60021', LoginDateTime: parse('27/08/2026 08:15:00'), LogoutDateTime: parse('27/08/2026 08:15:03') },
    { Date: '27/08/2026', LoginID: '60021', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },
    { Date: '28/08/2026', LoginID: '60021', LoginDateTime: parse('28/08/2026 07:00:00'), LogoutDateTime: parse('28/08/2026 07:00:03') },
    { Date: '28/08/2026', LoginID: '60021', LoginDateTime: parse('28/08/2026 14:00:00'), LogoutDateTime: parse('28/08/2026 14:00:03') },
    { Date: '27/08/2026', LoginID: '60022', LoginDateTime: parse('27/08/2026 07:00:00'), LogoutDateTime: parse('27/08/2026 07:00:03') },
    { Date: '27/08/2026', LoginID: '60022', LoginDateTime: parse('27/08/2026 15:00:00'), LogoutDateTime: parse('27/08/2026 15:00:03') },
    { Date: '27/08/2026', LoginID: '60023', LoginDateTime: parse('27/08/2026 07:00:00'), LogoutDateTime: parse('27/08/2026 07:00:03') },
    { Date: '27/08/2026', LoginID: '60023', LoginDateTime: parse('27/08/2026 14:00:00'), LogoutDateTime: parse('27/08/2026 14:00:03') },
    { Date: '27/08/2026', LoginID: '60024', LoginDateTime: parse('27/08/2026 07:00:00'), LogoutDateTime: parse('27/08/2026 07:00:03') },
    { Date: '27/08/2026', LoginID: '60024', LoginDateTime: parse('27/08/2026 15:00:00'), LogoutDateTime: parse('27/08/2026 15:00:03') },
    { Date: '28/08/2026', LoginID: '60024', LoginDateTime: parse('28/08/2026 09:00:00'), LogoutDateTime: parse('28/08/2026 09:00:03') },
    { Date: '28/08/2026', LoginID: '60024', LoginDateTime: parse('28/08/2026 16:00:00'), LogoutDateTime: parse('28/08/2026 16:00:03') },
    { Date: '27/08/2026', LoginID: '60025', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60025', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },
    { Date: '27/08/2026', LoginID: '60026', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60026', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },

    // ---- Family L ----
    { Date: '27/08/2026', LoginID: '60027', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60027', LoginDateTime: parse('27/08/2026 18:00:00'), LogoutDateTime: parse('27/08/2026 18:00:03') },
    // 600028: standalone OT2 no-show -- deliberately zero CMS punches

    // ---- Family M ----
    { Date: '31/08/2026', LoginID: '60029', LoginDateTime: parse('31/08/2026 09:05:00'), LogoutDateTime: parse('31/08/2026 09:05:03') },
    { Date: '31/08/2026', LoginID: '60029', LoginDateTime: parse('31/08/2026 18:00:00'), LogoutDateTime: parse('31/08/2026 18:00:03') },

    // ---- Family N ----
    { Date: '31/08/2026', LoginID: '60030', LoginDateTime: parse('31/08/2026 09:07:00'), LogoutDateTime: parse('31/08/2026 09:07:03') },
    { Date: '31/08/2026', LoginID: '60030', LoginDateTime: parse('31/08/2026 15:53:00'), LogoutDateTime: parse('31/08/2026 15:53:03') },

    // ---- Family O ----
    { Date: '27/08/2026', LoginID: '60031', LoginDateTime: parse('27/08/2026 09:00:00'), LogoutDateTime: parse('27/08/2026 09:00:03') },
    { Date: '27/08/2026', LoginID: '60031', LoginDateTime: parse('27/08/2026 09:20:00'), LogoutDateTime: parse('27/08/2026 09:20:03') },
    { Date: '28/08/2026', LoginID: '60031', LoginDateTime: parse('28/08/2026 09:00:00'), LogoutDateTime: parse('28/08/2026 09:00:03') },
    { Date: '28/08/2026', LoginID: '60031', LoginDateTime: parse('28/08/2026 09:15:00'), LogoutDateTime: parse('28/08/2026 09:15:03') },
    { Date: '27/08/2026', LoginID: '60032', LoginDateTime: parse('27/08/2026 09:00:00'), LogoutDateTime: parse('27/08/2026 09:00:03') },
    { Date: '27/08/2026', LoginID: '60032', LoginDateTime: parse('27/08/2026 10:30:00'), LogoutDateTime: parse('27/08/2026 10:30:03') },

    // ---- Family P ----
    { Date: '31/08/2026', LoginID: '60033', LoginDateTime: parse('31/08/2026 08:00:00'), LogoutDateTime: parse('31/08/2026 08:00:03') },
    { Date: '31/08/2026', LoginID: '60033', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '27/08/2026', LoginID: '60034', LoginDateTime: parse('27/08/2026 07:09:00'), LogoutDateTime: parse('27/08/2026 07:09:03') },
    { Date: '27/08/2026', LoginID: '60034', LoginDateTime: parse('27/08/2026 15:10:00'), LogoutDateTime: parse('27/08/2026 15:10:03') },

    // ---- Family Q: sentinel absence -- 600035/600036 deliberately have zero CMS punches ----

    // ---- Family R ----
    { Date: '27/08/2026', LoginID: '60037', LoginDateTime: parse('27/08/2026 22:58:00'), LogoutDateTime: parse('27/08/2026 22:58:03') },
    { Date: '28/08/2026', LoginID: '60037', LoginDateTime: parse('28/08/2026 07:00:00'), LogoutDateTime: parse('28/08/2026 07:00:03') },
    { Date: '28/08/2026', LoginID: '60037', LoginDateTime: parse('28/08/2026 23:07:00'), LogoutDateTime: parse('28/08/2026 23:07:03') },
    { Date: '29/08/2026', LoginID: '60037', LoginDateTime: parse('29/08/2026 07:02:00'), LogoutDateTime: parse('29/08/2026 07:02:03') },

    // ---- Family S ----
    // 600038: blank Cognos LOGIN ID, no join key possible -- no CMS punches
    { Date: '27/08/2026', LoginID: '60039', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60039', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },
    // 600040: no ASPECT segment / no attendance claimed -- no CMS punches
    { Date: '27/08/2026', LoginID: '60041', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60041', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },

    // ---- Family T ----
    { Date: '31/08/2026', LoginID: '60042', LoginDateTime: parse('31/08/2026 08:17:00'), LogoutDateTime: parse('31/08/2026 08:17:03') },
    { Date: '31/08/2026', LoginID: '60042', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60042', LoginDateTime: parse('01/09/2026 07:00:00'), LogoutDateTime: parse('01/09/2026 07:00:03') },
    { Date: '01/09/2026', LoginID: '60042', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60043', LoginDateTime: parse('31/08/2026 08:06:00'), LogoutDateTime: parse('31/08/2026 08:06:03') },
    { Date: '31/08/2026', LoginID: '60043', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60043', LoginDateTime: parse('01/09/2026 08:00:00'), LogoutDateTime: parse('01/09/2026 08:00:03') },
    { Date: '01/09/2026', LoginID: '60043', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '27/08/2026', LoginID: '60044', LoginDateTime: parse('27/08/2026 08:15:00'), LogoutDateTime: parse('27/08/2026 08:15:03') },
    { Date: '27/08/2026', LoginID: '60044', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },

    // ---- Family U: headcount mapping gate -- 600045/600046 deliberately have zero CMS punches ----

    // ---- Family V ----
    { Date: '31/08/2026', LoginID: '60047', LoginDateTime: parse('31/08/2026 09:05:00'), LogoutDateTime: parse('31/08/2026 09:05:03') },
    { Date: '31/08/2026', LoginID: '60047', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60048', LoginDateTime: parse('01/09/2026 09:05:00'), LogoutDateTime: parse('01/09/2026 09:05:03') },
    { Date: '01/09/2026', LoginID: '60048', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },
    { Date: '31/08/2026', LoginID: '60049', LoginDateTime: parse('31/08/2026 09:05:00'), LogoutDateTime: parse('31/08/2026 09:05:03') },
    { Date: '31/08/2026', LoginID: '60049', LoginDateTime: parse('31/08/2026 16:00:00'), LogoutDateTime: parse('31/08/2026 16:00:03') },
    { Date: '01/09/2026', LoginID: '60050', LoginDateTime: parse('01/09/2026 09:05:00'), LogoutDateTime: parse('01/09/2026 09:05:03') },
    { Date: '01/09/2026', LoginID: '60050', LoginDateTime: parse('01/09/2026 16:00:00'), LogoutDateTime: parse('01/09/2026 16:00:03') },

    // ---- Family W ----
    { Date: '27/08/2026', LoginID: '60051', LoginDateTime: parse('27/08/2026 08:00:00'), LogoutDateTime: parse('27/08/2026 08:00:03') },
    { Date: '27/08/2026', LoginID: '60051', LoginDateTime: parse('27/08/2026 16:00:00'), LogoutDateTime: parse('27/08/2026 16:00:03') },
  ];
}
