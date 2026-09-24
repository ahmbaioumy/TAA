import fs from "node:fs/promises";
import path from "node:path";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = path.resolve("artifacts");

const defaults = {
  lateOps: "6–60 min => LATE_AND_COVER; 61+ => ABSENT",
  lateOfficer: "11–60 min => LATE_AND_COVER; 61+ => ABSENT",
  earlyOps: "5–9 min => LOGOFF_AND_COVER; 10+ => ABSENT",
  earlyOfficer: "6–20 min => LOGOFF_AND_COVER; 21+ => ABSENT",
  lateLogout: "60+ min after effective end => ABSENT",
  coverOps: "5–9 min => action without email; 10+ => action + EMAIL_OPS",
  coverOfficer: "6–19 min => action without email; 20+ => action + EMAIL_STAFF_CC_MANAGER",
};

const commonHeaders = [
  "Case ID", "Priority", "Scenario name", "Rules / functions under test", "Employee and date",
  "ASPECT schedule input", "CMS input", "Cognos input / claim", "Config override",
  "Expected recomputation", "Expected rule resolution", "Expected key TAA columns",
  "Expected Cognos comparison", "Expected category / hold / inclusion", "Expected ASPECT correction CSV rows",
  "Expected communication", "Pass criteria", "Likely bug signature", "Actual result", "Pass / Fail", "Bug ID / notes",
];

const business = [
  {
    id:"BR-01", priority:"Critical", name:"Nursing carve-out followed by very late departure",
    rules:"R_4 Late Logout + NURSNG removal + effective-end anchor + Cognos recompute",
    employee:"OPS; PF 7000001; Login 90001; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 07:00–15:00 (480m)\nNURSNG 11/09 14:00–15:00 (60m)",
    cms:"Login 11/09 07:00\nLogout 11/09 15:20",
    cognos:"DUTY1=07:00-15:00; SCH DURATION=08:00; SIGIN IN=07:00; SIGIN OUT=15:20; LEFT EARLY based on raw end (not effective end)",
    config:"Defaults",
    calc:"Net schedule=420m (07:00–14:00 effective). Actual span=500m. Late login=0. Late logout=80m measured from 14:00, not 20m from 15:00.",
    resolution:"R_4 fires at 80m => ABSENT_SEGMENT. This is the answer to the example: logout at 15:20 is 80m after the nursing-adjusted end.",
    taa:"TAA_TIER=OPS; TAA_SCH_HOURS_RECOMPUTED=420; TAA_EFFECTIVE_START=07:00; TAA_EFFECTIVE_END=14:00; TAA_LATE_MIN=0; TAA_EARLY_MIN=0; TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=ABSENT_SEGMENT",
    compare:"SCH DURATION 08:00 vs 07:00 => MISMATCH. DUTY1 can remain a raw-window match. TAA_COGNOS_AGREE=FALSE; mismatch includes SCH DURATION.",
    category:"MARKED_ABSENT; hold=MISMATCH_FOUND; includeInOutput=FALSE until reviewer approval",
    csv:"After approval:\n00,7000001,ABSENT,11/09/2026,,,,\"TAA Late Logout 80m past release-adjusted end\",",
    email:"EMAIL_OPS, routed by Cognos SECTION; missing section mailbox must hold email drafting, never reroute to staff.",
    pass:"Uses 14:00 effective end; produces one absence marker; keeps row out of correction CSV while mismatch is unapproved.",
    bug:"Only 20m late is calculated; nursing ignored; No Action returned; populated Cognos schedule overwritten; correction exported before approval."
  },
  {
    id:"BR-02", priority:"Critical", name:"Cross-midnight late arrival and early departure with two covers",
    rules:"R_1 Late Login + R_3 Early Logout + cross-midnight attribution + multi-action audit + cover stacking",
    employee:"OPS; PF 7000002; Login 90002; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 19:00–12/09 03:00\nNext working SHIFT NOM_DATE 13/09 19:00–14/09 03:00",
    cms:"Login 11/09 19:08\nLogout 12/09 02:53",
    cognos:"DUTY1=19:00-03:00; SIGIN IN=19:08; SIGIN OUT=02:53; legacy report may mark U-ABSENT due next-day logout",
    config:"Defaults",
    calc:"Late=8m; early=7m; actual punches belong to 11/09 schedule despite logout date 12/09. Charged variance=15m.",
    resolution:"R_1 and R_3 both fire. Same severity means later departure action is final: TAA_ACTION=LOGOFF_AND_COVER. TAA_ACTIONS_FIRED must retain LATE_AND_COVER; LOGOFF_AND_COVER.",
    taa:"TAA_CMS_IN=11/09/2026 19:08; TAA_CMS_OUT=12/09/2026 02:53; TAA_LATE_MIN=8; TAA_EARLY_MIN=7; TAA_VERDICT=EARLY_LOGOUT; TAA_ACTION=LOGOFF_AND_COVER; category=LATE_AND_COVER_ADDED",
    compare:"Cognos time-of-day fields may match, but false U-ABSENT must be exposed through TAA_VERDICT/TAA_DISAGREE_REASON. No false missing-punch result.",
    category:"LATE_AND_COVER_ADDED; no hold when comparisons are otherwise within tolerance; include=TRUE",
    csv:"00,7000002,LATE,11/09/2026,11/09/2026,19:00,00:08,\"TAA Late Login 8m\",\n00,7000002,Log_off,11/09/2026,12/09/2026,02:53,00:07,\"TAA Early Logout 7m\",\nTwo COVER rows owned by NOM_DATE 13/09; physical date 14/09; starts 03:00 then 03:08; durations 00:08 and 00:07.",
    email:"NA for both OPS band-1 rules.",
    pass:"Both actions and all four timed corrections exist; covers do not overlap; SegmentDate rolls to 14/09 while nominateDate stays 13/09.",
    bug:"Logout joined to 12/09 row; one rule suppresses the other; charged variance=7 or 8 only; both covers start 03:00."
  },
  {
    id:"BR-03", priority:"Critical", name:"Officer night shift with trailing RLS, late login, and 60-minute late logout",
    rules:"R_1 Officer band + R_4 boundary + RLS effective end + absent strips timed penalties",
    employee:"OFFICER_PLUS; PF 7000003; Login 90003; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 23:00–12/09 07:00\nRLS 12/09 06:00–07:00",
    cms:"Login 11/09 23:11\nLogout 12/09 07:00",
    cognos:"DUTY1=23:00-07:00; SCH DURATION=08:00; SIGIN IN=23:11; SIGIN OUT=07:00",
    config:"Defaults",
    calc:"Effective end=06:00; net=420m. Late login=11m. Late logout=60m exactly.",
    resolution:"R_1 initially fires LATE_AND_COVER; R_4 fires at inclusive 60m and wins as ABSENT. Final-day cleanup removes LATE and COVER rows but preserves both fired actions in audit.",
    taa:"TAA_TIER=OFFICER_PLUS; TAA_LATE_MIN=11; TAA_EFFECTIVE_END=06:00; TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=LATE_AND_COVER; ABSENT_SEGMENT",
    compare:"SCH DURATION mismatch 08:00 vs 07:00; cross-midnight CMS timestamps shown in full TAA columns.",
    category:"MARKED_ABSENT; likely MISMATCH_FOUND until approval; include=FALSE",
    csv:"Only ABSENT remains after approval. No LATE/COVER row:\n00,7000003,ABSENT,11/09/2026,,,,\"TAA Late Logout 60m past release-adjusted end\",",
    email:"EMAIL_STAFF_CC_MANAGER. Missing manager is allowed (no CC); terminated employee blocks drafting.",
    pass:"60 is treated as in-band; no double-hit timed corrections survive absence.",
    bug:"Threshold coded >60; raw 07:00 used as end; late and cover remain beside ABSENT."
  },
  {
    id:"BR-04", priority:"Critical", name:"Absent day with OT1, OT2 and RLS overlapping both overtime types",
    rules:"R_1 61-minute boundary + absent OT-to-SHIFT replace pair (R_8 skipped on an Absent day) + OT1/OT2 separation",
    employee:"OPS; PF 7000004; Login 90004; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nOT1 15:00–17:00\nOT2 17:00–19:00\nRLS 16:00–18:00",
    cms:"Login 08:01\nLogout 19:00",
    cognos:"DUTY1=07:00-15:00; DUTY-2 blank; OT1 blank; OT-2 blank; SCH DURATION=08:00",
    config:"Defaults",
    calc:"Late=61m => absent. OT1=120m and OT2=120m remain distinct (hours math still nets the RLS-in-OT overlap: 480+120+120-120=600). Since the day is Absent, §4.6c retires each OT segment at its FULL original 120m duration, regardless of the RLS overlap — Rule 8's own RLS-netted adjustment is skipped entirely to avoid drafting a second, conflicting pair.",
    resolution:"ABSENT is primary. §4.6c independently retires each scheduled OT segment via its own 10/11 replace pair (full duration, SegmentCode swapped to SHIFT) because the day is absent — Rule 8 (ADJUST_OT_RLS) never fires on this day, so there is only one pair per OT segment, not two conflicting ones.",
    taa:"TAA_OT1=120; TAA_OT2=120; TAA_LATE_MIN=61; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED includes ABSENT_SEGMENT and OT_TO_SHIFT (never ADJUST_OT_RLS); TAA_VERDICT=ABSENT",
    compare:"Blank OT1/OT-2 filled with recomputed values; DUTY-2 reflects OT window according to shape rules; SCH DURATION comparison uses recomputed net, not Cognos 08:00.",
    category:"MARKED_ABSENT; hold if any comparison mismatch; include only after approval",
    csv:"One ABSENT row; for each OT: Code 10 (original OT1/OT2, full 02:00) then Code 11 (SegmentCode=SHIFT, same 02:00, never RLS-netted) — 5 rows total. No plain Code 00 SHIFT insert. OT1 and OT2 must never merge.",
    email:"EMAIL_OPS from late-login absence.",
    pass:"No OT type is lost; all dates normalize; each pair is ordered 10 then 11 at the FULL original duration; one day-level ABSENT only; exactly 5 correction rows.",
    bug:"OT1+OT2 summed; RLS-netted duration leaks into the retire pair instead of the full original; duplicate/conflicting 10/11 pairs from Rule 8 firing alongside §4.6c; duplicate ABSENT; timed late/cover survives; conversion changes times."
  },
  {
    id:"BR-05", priority:"Critical", name:"Late login plus unattended existing cover escalates to absence",
    rules:"R_1 + R_7 + COVER excluded from attendance window + most-severe-wins + absent cleanup",
    employee:"OPS; PF 7000005; Login 90005; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nExisting COVER 15:00–15:12",
    cms:"Login 07:06\nLogout 15:00",
    cognos:"DUTY1=07:00-15:00; SIGIN IN=07:06; SIGIN OUT=15:00",
    config:"coverNotAttendedAction=markAbsent (default); coverExtendsAttendanceWindow=false",
    calc:"Late login=6m. Existing cover attendance overlap=0, shortfall=12m. Cover does not change effective end.",
    resolution:"R_1 band1 fires; R_7 OPS 10+ fires and escalates to ABSENT + EMAIL_OPS. Final cleanup removes LATE and all newly placed COVER rows.",
    taa:"TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=LATE_AND_COVER; ABSENT_SEGMENT; TAA_LATE_MIN=6; charged variance trace=18m; verdict=ABSENT",
    compare:"Cognos may show only 6m late; TAA disagreement reason must explain unattended cover escalation.",
    category:"MARKED_ABSENT; include based on mismatch approval",
    csv:"Exactly one ABSENT marker for 11/09. No LATE, Log_off, or COVER output rows.",
    email:"EMAIL_OPS because Rule 7 shortfall is 12m.",
    pass:"Rule 7 is evaluated even though Rule 1 already fired; absence de-duplicates and strips timed penalties.",
    bug:"Existing cover extends end to 15:12 causing duplicate early logout; two ABSENT rows; late cover remains."
  },
  {
    id:"BR-06", priority:"High", name:"Partially attended officer cover is moved and stacked after existing cover",
    rules:"R_7 Officer boundary + moveCoverForward + full-cover move + target-day stacking",
    employee:"OFFICER_PLUS; PF 7000006; Login 90006; incident 11/09/2026",
    aspect:"11/09 SHIFT 07:00–15:00 + COVER 15:00–15:10\n12/09 SHIFT 07:00–15:00 + existing COVER 15:00–15:12",
    cms:"Login 07:00\nLogout 15:04 (attends 4m of 10m cover)",
    cognos:"Attendance otherwise on time; no cover-specific Cognos column",
    config:"coverNotAttendedAction=moveCoverForward",
    calc:"Cover duration=10m; attended overlap=4m; shortfall=6m. Officer band begins at 6. Re-placement moves the entire 10m cover, not only 6m.",
    resolution:"R_7 fires as LATE_AND_COVER behavior. New cover stacks at 15:12 after target day's existing cover.",
    taa:"TAA_ACTION=LATE_AND_COVER; TAA_ACTIONS_FIRED=LATE_AND_COVER; TAA_RESULT_CATEGORY=LATE_AND_COVER_ADDED; TAA_EARLY_MIN=0",
    compare:"No fabricated early logout from the original cover. Cognos agreement can remain TRUE if core columns match.",
    category:"LATE_AND_COVER_ADDED; no hold; include=TRUE",
    csv:"00,7000006,COVER,12/09/2026,12/09/2026,15:12,00:10,\"TAA Cover Not Attended: moved forward (was 11/09/2026 15:00)\",",
    email:"NA for Officer 6–19m cover shortfall.",
    pass:"Start is 15:12, duration is original 00:10, not shortfall 00:06.",
    bug:"Placed at 15:00; overlaps target cover; moves only 6m; emails officer despite lower band."
  },
  {
    id:"BR-07", priority:"Critical", name:"Flex shift change plus early logout after the shifted end",
    rules:"Flex branch A + 30-minute rounding + shift update 10/11 pair + R_3 downstream",
    employee:"OPS FLEX; PF 7000007; Login 90007; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nNext working SHIFT 12/09 07:00–15:00",
    cms:"Login 08:12\nLogout 15:52",
    cognos:"DUTY1=07:00-15:00; SIGIN IN=08:12; SIGIN OUT=15:52; may report 72m late to original start",
    config:"cutoff=10:00; nearest 30m; expected start window 07:00–10:00",
    calc:"08:12 rounds to 08:00. Shift becomes 08:00–16:00 with 480m preserved. Logout is 8m early relative to shifted end.",
    resolution:"Flex shift update fires, then R_3 OPS 5–9 fires. Later equal/higher category wins final LOGOFF_AND_COVER while actions audit retains SHIFT_UPDATE_FLEX and LOGOFF_AND_COVER.",
    taa:"TAA_TIER=FLEX; TAA_EFFECTIVE_START=08:00; TAA_EFFECTIVE_END=16:00; TAA_LATE_MIN=0; TAA_EARLY_MIN=8; TAA_ACTION=LOGOFF_AND_COVER; TAA_ACTIONS_FIRED=SHIFT_UPDATE_FLEX; LOGOFF_AND_COVER",
    compare:"Cognos original duty remains untouched and likely mismatches recomputed effective timing; TAA columns show the shifted truth.",
    category:"LATE_AND_COVER_ADDED; MISMATCH_FOUND until review if Cognos does not reflect new shift",
    csv:"10 original SHIFT 07:00 08:00 OrginalShift\n11 updated SHIFT 08:00 08:00 updatedshift\n00 Log_off at 15:52 for 00:08\n00 COVER on next working day for 00:08",
    email:"NA for OPS early-logout lower band.",
    pass:"Duration remains 8h; departure checks shifted 16:00; all four rows survive unless a stronger absence fires.",
    bug:"Flex suppresses departure rules; rounds to 08:30; shifts end to 15:00; omits 10/11 pair."
  },
  {
    id:"BR-08", priority:"Critical", name:"Flex one minute past cutoff plus early logout absence",
    rules:"Flex branch B + cutoff variance bypass + R_3 10-minute boundary + absent cleanup",
    employee:"OPS FLEX; PF 7000008; Login 90008; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nNext workday available",
    cms:"Login 10:01\nLogout 17:50",
    cognos:"May calculate 181m late against 07:00 and treat absent for lateness",
    config:"flexBypassesMinuteBands=true; cutoff=10:00",
    calc:"Shift clamped to 10:00–18:00. Flex late variance=1m (not 181m). Early logout=10m from shifted end.",
    resolution:"Flex late creates shift update + 1m cover. R_3 OPS at 10m escalates to ABSENT. Final cleanup removes flex LATE/COVER and Log_off/COVER, but keeps shift-update pair and ABSENT.",
    taa:"TAA_TIER=FLEX; TAA_EFFECTIVE_START=10:00; TAA_EFFECTIVE_END=18:00; TAA_LATE_MIN=1; TAA_EARLY_MIN=10; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=SHIFT_UPDATE_AND_LATE_COVER_FLEX; ABSENT_SEGMENT",
    compare:"TAA exposes 1m flex cutoff variance and 10m early departure; Cognos's 181m is not adopted.",
    category:"MARKED_ABSENT; likely mismatch hold",
    csv:"Code 10/11 shift pair (07:00 original; 10:00 updated; 08:00 duration) + one Code 00 ABSENT. No LATE, Log_off, or COVER rows.",
    email:"EMAIL_OPS from early-logout absence; flex late itself is silent.",
    pass:"Full flex logic and departure severity combine without double docking.",
    bug:"181m charged; flex late alone marks absent; shift pair stripped; leftover cover exported."
  },
  {
    id:"BR-09", priority:"Critical", name:"Flex-tagged night shift outside approved flex window",
    rules:"Flex safety gate + standard attendance fallback + forced hold",
    employee:"OPS FLEX; PF 7000009; Login 90009; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 19:00–12/09 03:00",
    cms:"Login 19:05\nLogout 03:05 next day",
    cognos:"DUTY1=19:00-03:00; punches accurate",
    config:"flexExpectedSchedStartWindow=07:00–10:00",
    calc:"Flex cutoff algorithm is unsafe for this schedule and must be skipped. Standard OPS late=5m => below R_1 threshold.",
    resolution:"Operational verdict can be PRESENT/NO_ACTION, but forced hold FLEX_SCHEDULE_OUTSIDE_WINDOW prevents automatic release.",
    taa:"TAA_TIER=FLEX; TAA_LATE_MIN=5; TAA_ACTION=NO_ACTION or manual-review presentation; holdReason=FLEX_SCHEDULE_OUTSIDE_WINDOW",
    compare:"Core schedule/punch comparisons can match; hold is independent of Cognos agreement.",
    category:"NO_ACTION_REQUIRED plus locked forced hold; include=FALSE and reviewer cannot release forced hold",
    csv:"Header only; no correction rows.",
    email:"NA",
    pass:"Never clamps night shift to 10:00; cannot be included through normal approval toggle.",
    bug:"Shift changed to 10:00; false absence; forced hold is user-releasable."
  },
  {
    id:"BR-10", priority:"High", name:"Split shift with a long unpaid gap and sparse second-block evidence",
    rules:"Whole-day first/last attendance + DUTY1/DUTY-2 construction + comparison-only block gap",
    employee:"OPS; PF 7000010; Login 90010; NOM_DATE 11/09/2026",
    aspect:"SHIFT1 07:00–11:00\nSHIFT2 13:00–17:00",
    cms:"Session A 07:00–11:00\nSession B 16:55–17:00",
    cognos:"DUTY1=07:00-11:00; DUTY-2=13:00-17:00; SIGNIN DURATION may total staffed sessions rather than 10h span",
    config:"perBlockGapThresholdMinutes=60",
    calc:"Gap=120m => two non-OT blocks. Attendance penalties use first login 07:00 and last logout 17:00 only. Net schedule=480m; span=600m.",
    resolution:"No late/early rule fires even though most of second block lacks session coverage. This is current whole-day design, not per-block enforcement.",
    taa:"TAA_LATE_MIN=0; TAA_EARLY_MIN=0; TAA_VERDICT=PRESENT; TAA_ACTION=NO_ACTION; TAA_RESULT_CATEGORY=NO_ACTION_REQUIRED",
    compare:"DUTY1 and DUTY-2 MATCH. SIGNIN DURATION may be NOT_COMPARABLE when Cognos staffed time differs from TAA first-to-last span.",
    category:"NO_ACTION_REQUIRED; no hold if remaining comparisons agree",
    csv:"Header only.",
    email:"NA",
    pass:"No invented per-block absence. Trace clearly states whole-day anchors.",
    bug:"Second block marked absent; two rows produced; two shift blocks collapsed into 07:00–17:00 DUTY1."
  },
  {
    id:"BR-11", priority:"High", name:"Leave day with 59-minute login just below anomaly threshold",
    rules:"Leave-day integrity gate + exact threshold lower edge + leave comparison suppression",
    employee:"OPS; PF 7000011; Login 90011; NOM_DATE 11/09/2026",
    aspect:"ANNUAL full-day structural segment; no SHIFT/OT",
    cms:"Login 10:00\nLogout 10:59",
    cognos:"DUTY1=07:00-15:00 entitlement; SCH DURATION=08:00; LEAVE TYPE=ANNUAL; LEAVE HR=08:00; SIGNIN blank",
    config:"leaveLoginThresholdMinutes=60; compareScheduleColumnsOnLeaveDays=false",
    calc:"Leave-day span=59m, below threshold.",
    resolution:"LEAVE_EXCLUDED; normal late/early/no-show rules never run.",
    taa:"TAA_VERDICT=LEAVE_EXCLUDED; TAA_ACTION=NO_ACTION; TAA_RESULT_CATEGORY=NO_ACTION_REQUIRED; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; status=MATCH; basis=EXACT",
    compare:"DUTY1, DUTY-2, SCH DURATION => NOT_COMPARABLE. LEAVE TYPE matches. Structural ANNUAL LEAVE HR is not fabricated from default 480 if configured durationless.",
    category:"NO_ACTION_REQUIRED; include=TRUE but zero correction rows",
    csv:"Header only.",
    email:"NA",
    pass:"59 does not trigger anomaly or absence; Cognos roster entitlement does not create false mismatch.",
    bug:"Uses >=59/off-by-one; no-login rule fires; leave schedule columns mismatch."
  },
  {
    id:"BR-12", priority:"Critical", name:"Leave day with exactly 60 minutes of attendance",
    rules:"Leave-day anomaly boundary + absence correction + leave evidence preserved",
    employee:"OFFICER_PLUS; PF 7000012; Login 90012; NOM_DATE 11/09/2026",
    aspect:"ANNUAL full-day structural segment; no SHIFT/OT",
    cms:"Login 10:00\nLogout 11:00",
    cognos:"LEAVE TYPE=ANNUAL; LEAVE HR=08:00; SIGIN IN/OUT blank",
    config:"leaveLoginThresholdMinutes=60",
    calc:"Span=60m exactly, so anomaly threshold is met.",
    resolution:"ABSENT_SEGMENT with anomaly memo. Attendance rules remain gated; communication borrows R_6 tier setting.",
    taa:"TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=ABSENT_SEGMENT; TAA_RESULT_CATEGORY=MARKED_ABSENT; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL",
    compare:"LEAVE TYPE can still MATCH ANNUAL while CMS-related Cognos fields disagree/blank. Any MISMATCH_FOUND holds output; COGNOS_BLANK alone is tracked, not automatically a mismatch.",
    category:"MARKED_ABSENT; inclusion depends on comparison hold; with mismatch => FALSE",
    csv:"When eligible: 00,7000012,ABSENT,11/09/2026,,,,\"TAA Anomaly: Attendance recorded on scheduled leave day\",",
    email:"EMAIL_STAFF_CC_MANAGER (from R_6 Officer communication).",
    pass:"Boundary is inclusive; leave type evidence is not erased by anomaly verdict.",
    bug:"60 treated as allowed; switches leave type to ABSENT; applies normal lateness."
  },
  {
    id:"BR-13", priority:"Critical", name:"Public-holiday OT2 day with no login",
    rules:"OT-only attendance gate + R_5 no show + OT2 preservation + absent OT-to-SHIFT replace pair",
    employee:"OPS; PF 7000013; Login 90013; NOM_DATE 11/09/2026",
    aspect:"P/H-LV structural row\nOT2 11/09 23:00–12/09 07:00",
    cms:"No punches; CMS coverage otherwise sufficient",
    cognos:"DUTY1 entitlement; OT-2 blank; SIGNIN DURATION=00:00; SIGIN IN/OUT blank; may show U-ABSENT",
    config:"Defaults",
    calc:"Presence of OT2 routes day through attendance rules rather than leave exclusion. OT2=480m.",
    resolution:"R_5 => ABSENT_NS_NC. OT2 is explicitly retired and replaced with SHIFT via a 10/11 pair in the correction output, original start/date/duration preserved on both rows.",
    taa:"TAA_OT2=480; TAA_VERDICT=NO_SHOW; TAA_ACTION=ABSENT_NS_NC; TAA_ACTIONS_FIRED=ABSENT_NS_NC, OT_TO_SHIFT; category=MARKED_ABSENT",
    compare:"OT-2 blank is filled 08:00; zero/blank attendance fields treated as no-attendance placeholders; no false CMS mismatch when evidence is absent as claimed.",
    category:"MARKED_ABSENT; hold only for real mismatches; include=TRUE if comparisons agree",
    csv:"00,7000013,Absent NS/NC,11/09/2026,,,,\"TAA Full Shift Absence NS/NC\",\n10,7000013,OT2,11/09/2026,11/09/2026,23:00,08:00,\"TAA Absent Day: original OT2 segment being replaced by SHIFT\",\n11,7000013,SHIFT,11/09/2026,11/09/2026,23:00,08:00,\"TAA Absent Day: OT2 segment converted to SHIFT\",",
    email:"EMAIL_OPS",
    pass:"OT2 is evaluated, filled, and explicitly retired via a 10/11 pair (never a bare insert); never dropped because P/H-LV exists.",
    bug:"Leave gate skips row; OT2 omitted/merged into OT1; conversion date becomes 12/09; OT2 left in ASPECT alongside a new SHIFT insert instead of being retired."
  },
  {
    id:"BR-14", priority:"Critical", name:"Cross-midnight single swipe with sufficient CMS coverage",
    rules:"R_6 one punch + cross-midnight schedule + sufficient-coverage distinction",
    employee:"OFFICER_PLUS; PF 7000014; Login 90014; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 23:00–12/09 07:00",
    cms:"One record where LoginDateTime=LogoutDateTime=11/09 23:08; export includes required day before/after",
    cognos:"SIGIN IN=23:08; SIGIN OUT=23:08; SIGNIN DURATION=00:00",
    config:"minAttendanceSpanMinutes=1",
    calc:"Punch count/thin span is insufficient evidence, but file coverage is sufficient, so this is a real incomplete pair rather than a coverage hold.",
    resolution:"R_6 => ABSENT_SEGMENT, not INSUFFICIENT_CMS_COVERAGE.",
    taa:"TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_RESULT_CATEGORY=MARKED_ABSENT; hold determined by comparisons",
    compare:"SIGNIN DURATION 00:00 vs recomputed 0 is NOT_COMPARABLE staffed-vs-span, not the real-span defect. Time fields can MATCH.",
    category:"MARKED_ABSENT; include if no mismatch",
    csv:"00,7000014,ABSENT,11/09/2026,,,,\"TAA Incomplete Punch Pair Absence\",",
    email:"EMAIL_STAFF_CC_MANAGER",
    pass:"Coverage state changes the branch; no cross-midnight false no-show.",
    bug:"Held as insufficient coverage despite complete file; treated as present because in=out."
  },
  {
    id:"BR-15", priority:"Critical", name:"Cognos LOGIN ID blank while schedule exists",
    rules:"Missing CMS join-key forced hold + no auto-absence",
    employee:"OPS; PF 7000015; LOGIN ID blank; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00",
    cms:"A punch exists for an unlinked login but cannot be safely matched by name or ASPECT EMP_EXTRA_3",
    cognos:"PF NO and name populated; LOGIN ID blank; report may claim absence",
    config:"Defaults",
    calc:"Schedule recomputes, but CMS join is impossible by authoritative key.",
    resolution:"MANUAL_REVIEW_REQUIRED; never infer login ID or mark absent.",
    taa:"TAA_ACTION=MANUAL_REVIEW_REQUIRED; TAA_RESULT_CATEGORY=COGNOS_DATA_GAP; holdReason=MISSING_CMS_JOIN_KEY; TAA_CMS_IN/OUT blank",
    compare:"CMS-dependent columns become NOT_COMPARABLE; schedule columns may still compare.",
    category:"COGNOS_DATA_GAP; locked forced hold; include=FALSE",
    csv:"Header only.",
    email:"NA",
    pass:"Name, PF, and EMP_EXTRA_3 cannot bypass missing login ID.",
    bug:"Wrong employee punch joined; auto ABSENT_NS_NC; forced hold omitted."
  },
  {
    id:"BR-16", priority:"Critical", name:"Night shift with one swipe and incomplete next-day CMS coverage",
    rules:"Insufficient CMS coverage safety gate + cross-midnight file extent",
    employee:"OPS; PF 7000016; Login 90016; NOM_DATE 11/09/2026",
    aspect:"SHIFT 11/09 23:00–12/09 07:00",
    cms:"Only login 11/09 23:02; uploaded file ends 11/09 23:59 and lacks 12/09 coverage",
    cognos:"May show no attendance or one swipe",
    config:"required coverage before=1 day; after=1 day; search radius=4h",
    calc:"Thin evidence plus incomplete coverage means absence cannot be trusted.",
    resolution:"MANUAL_REVIEW_REQUIRED with INSUFFICIENT_CMS_COVERAGE, before R_5/R_6.",
    taa:"TAA_ACTION=MANUAL_REVIEW_REQUIRED; TAA_RESULT_CATEGORY=COGNOS_DATA_GAP; holdReason=INSUFFICIENT_CMS_COVERAGE",
    compare:"CMS fields may be NOT_COMPARABLE; lack of evidence is not reported as confirmed disagreement.",
    category:"COGNOS_DATA_GAP; forced hold; include=FALSE",
    csv:"Header only.",
    email:"NA",
    pass:"Adding next-day file coverage with still only one swipe changes branch to R_6 absence; without it, row stays held.",
    bug:"Auto-absence from truncated export; coverage check ignores calendar extent."
  },
  {
    id:"BR-17", priority:"Critical", name:"Overlapping nursing and RLS reduce one physical hour only",
    rules:"Removal interval union + effective end + net-hours integrity",
    employee:"OPS; PF 7000017; Login 90017; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nNURSNG 14:00–15:00\nRLS 14:30–15:00",
    cms:"Login 07:00\nLogout 14:00",
    cognos:"SCH DURATION=07:00; SIGIN IN=07:00; SIGIN OUT=14:00",
    config:"Defaults",
    calc:"Union of removals is 14:00–15:00 = 60m, not 90m. Net=420m; effective end=14:00; nursing trace may be 60 but total removal is unioned.",
    resolution:"Present; no early logout and no late logout.",
    taa:"TAA_SCH_HOURS_RECOMPUTED=420; TAA_EFFECTIVE_END=14:00; TAA_EARLY_MIN=0; TAA_ACTION=NO_ACTION; category=NO_ACTION_REQUIRED",
    compare:"SCH DURATION 07:00 MATCH; punches MATCH.",
    category:"NO_ACTION_REQUIRED; no hold; include=TRUE with no correction rows",
    csv:"Header only.",
    email:"NA",
    pass:"Raw additions 480 - unioned removal 60 = 420; trace totals reconcile.",
    bug:"Net=390; effective end=13:30; false late logout/absence."
  },
  {
    id:"BR-18", priority:"Critical", name:"Duration-only release mixed with timestamped trailing release",
    rules:"Ambiguous overlap safety hold + duration trust order",
    employee:"OPS; PF 7000018; Login 90018; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nRLS 14:00–15:00\nRLS-2H with DURATION=120 but no timestamps",
    cms:"Login 07:00\nLogout 14:00",
    cognos:"Any otherwise plausible schedule values",
    config:"Defaults",
    calc:"Duration-only removal has no interval, so overlap with 14:00–15:00 cannot be proven or excluded. Guessing would risk subtracting 2h or 3h.",
    resolution:"Hold AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION. Do not auto-correct or label the duration-only row INVALID_ASPECT_DATETIME merely because timestamps are absent.",
    taa:"TAA_ACTION=MANUAL_REVIEW_REQUIRED; holdReason=AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION; category=COGNOS_DATA_GAP or held presentation",
    compare:"Comparisons are secondary; forced integrity hold blocks output even if Cognos happens to agree.",
    category:"Forced hold; include=FALSE",
    csv:"Header only.",
    email:"NA",
    pass:"Specific ambiguity reason is surfaced; no invented effective end.",
    bug:"Subtracts 180m; ignores duration-only segment; incorrectly uses INVALID_ASPECT_DATETIME."
  },
  {
    id:"BR-19", priority:"Critical", name:"Mid-shift release must not be moved to shift end",
    rules:"Removal position classification + payroll-safe hold",
    employee:"OFFICER_PLUS; PF 7000019; Login 90019; NOM_DATE 11/09/2026",
    aspect:"SHIFT 07:00–15:00\nRLS 10:00–11:00",
    cms:"Login 07:00\nLogout 15:00",
    cognos:"SCH DURATION=07:00 or 08:00; exact value should not authorize guessing",
    config:"releaseProximityToleranceMinutes=2",
    calc:"RLS lies in the middle, touching neither start nor end. It can reduce net paid minutes but cannot safely move an attendance anchor.",
    resolution:"MANUAL_REVIEW_REQUIRED; hold MID_SHIFT_REMOVAL_SEGMENT. No early/late departure action.",
    taa:"holdReason=MID_SHIFT_REMOVAL_SEGMENT; include=FALSE; generatedCorrections empty",
    compare:"Mismatches may also exist, but hold reason must identify the source schedule ambiguity.",
    category:"Forced hold; include=FALSE",
    csv:"Header only.",
    email:"NA",
    pass:"Does not fabricate effective end 14:00 or effective start 08:00.",
    bug:"Treats RLS as trailing and marks 60m late logout; silently subtracts from wrong edge."
  },
  {
    id:"BR-20", priority:"Critical", name:"Mixed leave and worked shift with a valid punch pair",
    rules:"Leave taxonomy independent of hours role + mixed leave/work review hold + reviewer override",
    employee:"OPS; PF 7000020; Login 90020; NOM_DATE 11/09/2026",
    aspect:"ANNUAL structural leave row\nSHIFT 07:00–15:00",
    cms:"Login 07:00\nLogout 15:00",
    cognos:"LEAVE TYPE=ANNUAL; DUTY1=07:00-15:00; SIGNIN data populated",
    config:"ANNUAL in leaveSegmentCodes and nonWorkingDaySegmentCodes",
    calc:"Worked addition exists, so normal calculations can run; leave evidence also exists. These states conflict and require human confirmation.",
    resolution:"PRESENT/NO_ACTION from attendance math, but hold MIXED_LEAVE_AND_WORK_SEGMENTS. This hold is reviewer-releasable, unlike forced data-integrity holds.",
    taa:"TAA_VERDICT=PRESENT; TAA_ACTION=NO_ACTION; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; holdReason=MIXED_LEAVE_AND_WORK_SEGMENTS; include=FALSE initially",
    compare:"LEAVE TYPE may MATCH while other columns also match; hold exists independently of column mismatch.",
    category:"NO_ACTION_REQUIRED plus held; reviewer may explicitly include, but there are no corrections unless another rule fired",
    csv:"Header only in this exact input. Approval changes inclusion state/audit, not invent a correction.",
    email:"NA",
    pass:"Both work and leave evidence remain visible; reviewer override is audited.",
    bug:"Leave gate silently excludes worked shift; leave code ignored; forced hold cannot be reviewed; approval creates fake row."
  },
];

const algorithm = [
  {id:"AL-01",priority:"Critical",name:"UTF-16 tab-delimited Cognos parser preserves multiline REMARK",rules:"Cognos parser; original-column preservation",employee:"One row with PF 007001 and a two-line REMARK",aspect:"Matching simple SHIFT",cms:"Matching punches",cognos:"UTF-16 LE bytes; real tabs; REMARK contains comma, quote and embedded newline",config:"Defaults",calc:"Parser returns exactly one logical record with all 18 source headers, including misspellings SIGIN IN/SIGIN OUT.",resolution:"Reconciliation runs once; multiline text stays in originalCognos.REMARK.",taa:"All derived TAA fields append after the 18 originals.",compare:"No column shift. Original values compare from the correct headers.",category:"Normal based on attendance",csv:"Annotated output quotes REMARK correctly. ASPECT correction output is independent.",email:"Based only on rule result",pass:"Round-trip read of annotated file reproduces the exact 18 original cell values except permitted fill-if-blank fields.",bug:"Two rows created; columns shift after newline; UTF-16 mojibake; SIGIN fields missing."},
  {id:"AL-02",priority:"Critical",name:"CMS duplicate header names use full timestamp columns by position",rules:"CMS parser; cross-midnight datetime authority",employee:"Login 90022; night shift 23:00–07:00",aspect:"SHIFT 11/09 23:00–12/09 07:00",cms:"Columns 3/4 contain time-only 23:05 and 07:02; duplicate columns 5/6 contain full 11/09 23:05 and 12/09 07:02",cognos:"SIGIN IN=23:05; SIGIN OUT=07:02",config:"Defaults",calc:"LoginDateTime and LogoutDateTime come from positional full-datetime columns 5/6.",resolution:"Punch is attributed to 11/09 schedule and spans midnight.",taa:"TAA_CMS_IN includes 11/09; TAA_CMS_OUT includes 12/09; no false early logout.",compare:"Time-of-day may match; full TAA timestamps resolve the date ambiguity.",category:"NO_ACTION_REQUIRED if within thresholds",csv:"Header only",email:"NA",pass:"Logout is 12/09 07:02, never 11/09 07:02 or a negative session.",bug:"Uses first duplicate header occurrence; negative duration; false no-show."},
  {id:"AL-03",priority:"Critical",name:"Whitespace-padded employee identifiers join without losing leading zeroes",rules:"PF/EMP_ID normalization; identity join",employee:"Cognos PF='007001'; ASPECT EMP_ID='  007001   '; Login=90023",aspect:"Padded EMP_ID, valid SHIFT",cms:"Valid pair for 90023",cognos:"PF NO stored as text '007001'",config:"Defaults",calc:"Trim whitespace only. Do not numeric-cast or drop leading zeroes.",resolution:"Schedule and identity resolve to same employee.",taa:"TAA_USERNAME and tier come from matched identity; no data gap.",compare:"Normal comparisons",category:"Attendance-derived, not COGNOS_DATA_GAP",csv:"ID field remains 007001 in any correction",email:"Correct employee only",pass:"Exactly one joined row and no collision with employee 7001.",bug:"ID becomes 7001; schedule missing; wrong identity/email."},
  {id:"AL-04",priority:"High",name:"Unpadded NOM_DATE and START_DATE normalize consistently",rules:"Date-key normalization; physical SegmentDate normalization",employee:"PF 7000024",aspect:"NOM_DATE='1/9/2026'; START_DATE='1/9/2026'; SHIFT 01/09 07:00–15:00",cms:"01/09 07:06–15:00",cognos:"SIGN IN DATE='01/09/2026'",config:"Defaults",calc:"Both dates normalize to 01/09/2026 before grouping/joining.",resolution:"Late 6m rule can fire normally.",taa:"No COGNOS_ASPECT_DATE_MISMATCH",compare:"Correct row compared",category:"LATE_AND_COVER_ADDED",csv:"Every nominateDate/SegmentDate is zero-padded DD/MM/YYYY",email:"NA",pass:"No raw 1/9/2026 reaches output.",bug:"False data gap; mixed date formats in CSV."},
  {id:"AL-05",priority:"Critical",name:"Headcount mapping gate excludes declared no-shows from CMS denominator",rules:"Upload validation; assessHeadcountMapping",employee:"10 Cognos staff: 4 claim attendance, 6 have blank punches/00:00 placeholders",aspect:"All 10 map to ASPECT",cms:"3 of the 4 attendance-claiming login IDs map; none of the 6 declared no-shows map",cognos:"6 rows have blank SIGIN IN/OUT and structural SIGNIN DURATION 00:00; 4 have at least one attendance signal",config:"validateUploadedHeadcount=true; minimum=70%",calc:"Cognos→CMS denominator is 4, mapped=3 => 75%, not 3/10=30%. Critical missing count=1.",resolution:"Calculate is allowed at 75% (assuming ASPECT mapping >=70), while the one missing attendance claimant remains visible.",taa:"Upload gate summary reports 75% and count 1",compare:"Per-row handling occurs only after gate",category:"N/A upload gate",csv:"No output before Calculate",email:"NA",pass:"Declared no-shows do not depress denominator; SIGIN OUT-only and duration-only claims count as attendance claims.",bug:"Reports 30%; ignores SIGIN OUT-only claimant; gate blocks incorrectly."},
  {id:"AL-06",priority:"Critical",name:"One punch near two adjacent schedules is attributed once",rules:"Global punch attribution; no double claim; tie cascade",employee:"Same Login 90026 has day shift 07:00–15:00 and next schedule 19:00–03:00",aspect:"Two real scheduled windows for same login on adjacent employee-days",cms:"Punch 18:57 plus valid overnight logout 03:02; day-shift pair already ends 15:00",cognos:"Two rows",config:"search radius=4h",calc:"18:57 is inside overnight raw window and near day window tail; real in-window fit and distance assign it to overnight only.",resolution:"Night row present/early arrival; day row keeps its own punches. No punch appears in both details.punches arrays.",taa:"Each CMS record has one owner; no false day late logout and no night no-show",compare:"Both rows compare independently",category:"Per-row normal",csv:"No duplicate corrections from shared punch",email:"NA",pass:"Sum of attributed punch IDs across rows contains no duplicates.",bug:"18:57 claimed twice; earlier row steals next shift login."},
  {id:"AL-07",priority:"Critical",name:"Irreducible punch-attribution tie is held",rules:"Ambiguous attribution safety hold",employee:"Same login mistakenly scheduled in two identical real windows",aspect:"Two Cognos rows/windows both 11/09 07:00–15:00 for login 90027",cms:"Single pair 07:05–15:00",cognos:"Both claim attendance",config:"Defaults",calc:"Both candidates have equal real-window priority, start, distance and fit.",resolution:"Do not arbitrarily assign. Affected thin-evidence row(s) surface AMBIGUOUS_PUNCH_ATTRIBUTION or CONTESTED_SINGLE_PUNCH and are held.",taa:"hold reason records ambiguity; no automatic absence",compare:"CMS-dependent comparisons not trusted",category:"COGNOS_DATA_GAP/held",csv:"Header only for held rows",email:"NA",pass:"Deterministic hold rather than array-order winner.",bug:"First row wins silently; second marked absent."},
  {id:"AL-08",priority:"High",name:"Bare date timestamp means midnight and cross-midnight stop rolls correctly",rules:"Datetime parser; midnight semantics",employee:"PF 7000028",aspect:"SHIFT START_MOMENT='11/09/2026 20:00'; STOP_MOMENT='12/09/2026' (bare date midnight)",cms:"20:00–00:00",cognos:"DUTY1=20:00-00:00",config:"Defaults",calc:"Bare date parses as 12/09 00:00, not null. Duration=240m.",resolution:"Normal attendance evaluation",taa:"TAA_EFFECTIVE_END=00:00 with full date in trace; schedule=240",compare:"DUTY1 matches across midnight",category:"NO_ACTION_REQUIRED",csv:"Any physical SegmentDate at midnight is 12/09/2026",email:"NA",pass:"No 24-hour or zero-hour distortion.",bug:"Bare date treated missing; invalid datetime hold; stop rolled to 13/09."},
  {id:"AL-09",priority:"Critical",name:"Incomplete ASPECT timestamp locks the row",rules:"Input integrity; INVALID_ASPECT_DATETIME",employee:"PF 7000029",aspect:"SHIFT has START_MOMENT 11/09 07:00 but blank STOP_MOMENT and DURATION",cms:"Valid 07:00–15:00 pair",cognos:"Looks perfectly normal",config:"Defaults",calc:"Schedule anchors/duration cannot be trusted.",resolution:"Forced MANUAL_REVIEW_REQUIRED before attendance rules.",taa:"holdReason=INVALID_ASPECT_DATETIME; TAA_ACTION=MANUAL_REVIEW_REQUIRED",compare:"Cognos appearance cannot clear source defect",category:"COGNOS_DATA_GAP/locked hold; include=FALSE",csv:"Header only",email:"NA",pass:"Reviewer cannot release forced hold through normal inclusion toggle.",bug:"Invents 8h/default end; marks present or absent."},
  {id:"AL-10",priority:"Critical",name:"Byte-identical ASPECT duplicate does not double paid minutes",rules:"Segment de-duplication; hours formula",employee:"PF 7000030",aspect:"Two identical SHIFT rows, same PRI_INDEX/content, both 07:00–15:00",cms:"07:00–15:00",cognos:"SCH DURATION=08:00",config:"Defaults",calc:"Logical schedule remains 480m, not 960m.",resolution:"Present; no correction",taa:"TAA_SCH_HOURS_RECOMPUTED=480",compare:"SCH DURATION MATCH",category:"NO_ACTION_REQUIRED",csv:"Header only",email:"NA",pass:"Duplicate warning/handling is deterministic and no hours double-count.",bug:"TAA schedule=16:00; false mismatch."},
  {id:"AL-11",priority:"High",name:"Comparison tolerance boundary is inclusive at one minute",rules:"Column comparison tolerance",employee:"PF 7000031",aspect:"SHIFT 07:00–15:00; punches 07:01–15:00",cms:"Authoritative 07:01 and 15:00",cognos:"Subcase A SIGIN IN=07:00; subcase B SIGIN IN=06:59 while recompute is 07:01",config:"comparisonToleranceMinutes=1",calc:"Subcase A difference=1 => MATCH. Subcase B circular clock difference=2 => MISMATCH.",resolution:"Attendance action is independent of comparison result.",taa:"A mismatch count unchanged; B mismatch count increments and includes SIGIN IN",compare:"Exactly 1 is accepted; 2 is rejected",category:"A no mismatch hold; B hold=MISMATCH_FOUND",csv:"B corrections excluded until approval",email:"Attendance-driven",pass:"No off-by-one and time-of-day comparison handles midnight circularly.",bug:"1 mismatches or 2 matches."},
  {id:"AL-12",priority:"Critical",name:"Fill blank OT columns only and never overwrite populated Cognos",rules:"cognosBlankFillColumns; OT1/OT2 distinction",employee:"PF 7000032",aspect:"OT1=60m; OT2=120m",cms:"Valid pair",cognos:"OT1 blank; OT-2='01:30' populated but wrong",config:"blank-fill columns OT1 and OT-2",calc:"Recompute OT1=01:00; OT2=02:00.",resolution:"Annotated original OT1 cell is filled 01:00 and listed in TAA_FILLED_COLUMNS. Populated OT-2 stays 01:30 and compares MISMATCH against 02:00.",taa:"TAA_OT1=60; TAA_OT2=120; TAA_FILLED_COLUMNS=OT1; mismatch columns includes OT-2",compare:"OT1=COGNOS_BLANK/fill; OT-2=MISMATCH",category:"hold=MISMATCH_FOUND",csv:"Unrelated correction rows held until approval",email:"Rule-driven",pass:"Original populated OT-2 is byte/value preserved.",bug:"Overwrites OT-2 with 02:00; fails to fill OT1; merges OT totals."},
  {id:"AL-13",priority:"High",name:"Dynamic Cognos sentinel equals negative leave hours",rules:"Sentinel detection; no-attendance placeholders",employee:"PF 7000033 on 10-hour leave",aspect:"Leave code with evidenced 600m entitlement",cms:"No punches",cognos:"LEAVE HR=10:00; LATE START=-600; LEFT EARLY=-600; SIGIN IN/OUT blank",config:"cognosSentinelDetectionMode=both",calc:"-600 equals negative leave minutes even though not in fixed [-480,-540] list.",resolution:"Both variances are NOT_COMPARABLE sentinels, not real 600m late/early values.",taa:"TAA_MISMATCH_COLUMNS excludes LATE START and LEFT EARLY solely for sentinels",compare:"NOT_COMPARABLE with sentinel note",category:"Leave-day result",csv:"No false penalties",email:"NA",pass:"Structural rule handles any leave duration.",bug:"Only fixed list checked; 600m absence action created."},
  {id:"AL-14",priority:"Critical",name:"Cognos 00:00 duration distinguishes placeholder from calculation failure",rules:"SIGNIN DURATION exception logic",employee:"Two subcases, same 07:00–15:00 shift",aspect:"Valid SHIFT",cms:"A: 07:09–15:10 real 481m span. B: no CMS and Cognos punches blank.",cognos:"Both SIGNIN DURATION=00:00. A also has SIGIN IN=07:09 and SIGIN OUT=15:10. B has both blank.",config:"Defaults",calc:"A: 0 vs 481 with real Cognos timestamps => genuine MISMATCH. B: structural no-attendance placeholder => NOT_COMPARABLE.",resolution:"A held MISMATCH_FOUND; B proceeds to no-login rule based on CMS coverage.",taa:"A mismatch includes SIGNIN DURATION with calculation-failure note. B does not.",compare:"Same text value, different status based on supporting evidence",category:"A held; B attendance-rule category",csv:"A corrections gated; B no-show correction only if rule fires",email:"B per R_5",pass:"Context, not string alone, determines meaning.",bug:"Both downgraded; both mismatched; A defect hidden."},
  {id:"AL-15",priority:"High",name:"Specific leave code wins over generic container and mapping is explicit",rules:"Leave selection; exact/mapped basis",employee:"PF 7000035",aspect:"LEAVE + ANNUAL on same non-work day",cms:"No punches",cognos:"LEAVE TYPE=Annual Leave (different spelling)",config:"generic container=LEAVE; mapping Annual Leave -> ANNUAL",calc:"Specific identified leave is ANNUAL; mapping connects Cognos value.",resolution:"Leave excluded; recomputed leave type ANNUAL.",taa:"TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; STATUS=MATCH; BASIS=MAPPED",compare:"No false LEAVE-vs-Annual Leave mismatch",category:"NO_ACTION_REQUIRED",csv:"Header only",email:"NA",pass:"Removing the mapping changes status to MISMATCH; generic LEAVE never wins while ANNUAL exists.",bug:"Picks LEAVE; claims EXACT; mapping ignored."},
  {id:"AL-16",priority:"High",name:"Schedule block gap at threshold remains split",rules:"perBlockGapThreshold strict boundary; schedule-shape mapping",employee:"PF 7000036",aspect:"Subcase A SHIFT 07:00–11:00 and 11:59–15:59 (59m gap). Subcase B second starts 12:00 (60m gap).",cms:"First-to-last attendance covers both",cognos:"A expects one DUTY1; B expects DUTY1 and DUTY-2",config:"perBlockGapThresholdMinutes=60",calc:"A gap <60 merges. B gap exactly 60 does not merge.",resolution:"Attendance verdict unchanged; only comparison blocks differ.",taa:"A duty1 07:00–15:59; B duty1 07:00–11:00 and duty2 12:00–16:00",compare:"Appropriate Cognos columns MATCH per subcase",category:"NO_ACTION_REQUIRED",csv:"Header only",email:"NA",pass:"Uses strict less-than, not less-than-or-equal.",bug:"Both merge; both split; attendance penalties start evaluating each block."},
  {id:"AL-17",priority:"Critical",name:"ASPECT CSV writer enforces exact wire format and escaping",rules:"Correction CSV serialization; de-duplication",employee:"Synthetic correction ID 7000037",aspect:"N/A",cms:"N/A",cognos:"N/A",config:"aspectNormalActionCode=00",calc:"Create one correction with SegmentCode='Absent NS/NC' and Memo='Reason, says \"review\"'. Add an exact duplicate.",resolution:"Writer emits one data row after de-duplication.",taa:"N/A",compare:"N/A",category:"N/A writer test",csv:"Header exactly Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo, and ends with comma. SegmentCode with spaces quoted. Memo always quoted and inner quotes doubled. Code stays 00. Blank absence time/duration remain blank.",email:"N/A",pass:"Every line, including header/data, has final comma; duplicate collapses; Segmentduration elsewhere is HH:MM.",bug:"Code becomes 0; missing trailing comma; Memo unquoted; duplicate row; 60 instead of 01:00."},
  {id:"AL-18",priority:"Critical",name:"Annotated Cognos output blocks spreadsheet formula injection without corrupting ASPECT CSV",rules:"Annotated export escaping; writer separation",employee:"NAME='=HYPERLINK(\"bad\")'; PF valid",aspect:"Correction Memo begins '=review'",cms:"Valid",cognos:"A source text cell begins =, +, -, or @",config:"Defaults",calc:"Annotated Cognos escapeCell prefixes apostrophe to dangerous leading characters. ASPECT writer does not add apostrophe because that would corrupt the machine import; Memo is quoted instead.",resolution:"Safe human-opened report and exact machine CSV semantics.",taa:"Original source text remains recognizable; marker and derived fields append",compare:"No execution on open",category:"Attendance-derived",csv:"Annotated cell starts apostrophe. ASPECT Memo is \"=review\", not \"'=review\".",email:"No effect",pass:"Security behavior differs intentionally by output type.",bug:"Excel executes formula; or apostrophe leaks into ASPECT upload."},
  {id:"AL-19",priority:"Critical",name:"Mismatch approval gates correction output and records override",rules:"Review workflow; forced vs releasable holds; annotated audit",employee:"PF 7000039 with a valid 6m late correction",aspect:"SHIFT 07:00–15:00 + future workday",cms:"07:06–15:00",cognos:"SIGIN IN incorrectly 07:20 so comparison mismatches",config:"Defaults",calc:"Attendance says 6m late; comparison says Cognos mismatch.",resolution:"Row correction exists internally but includeInOutput=FALSE and is excluded from ASPECT file until explicit user approval. Approval sets decision source=user and verification/audit metadata where applicable.",taa:"holdReason=MISMATCH_FOUND; TAA_INCLUDED_IN_OUTPUT changes FALSE->TRUE only after approval; mismatch details remain",compare:"Mismatch is never erased by approval",category:"LATE_AND_COVER_ADDED plus Held tab",csv:"Before: header only. After approval: LATE + COVER rows.",email:"Email eligibility follows approved/eligible workflow; no premature draft",pass:"Approval releases only releasable hold. Repeat with INVALID_ASPECT_DATETIME and confirm approval cannot release it.",bug:"Correction exported immediately; approval clears evidence; forced hold released."},
  {id:"AL-20",priority:"Critical",name:"Cover fallback is explicit and preserves ownership versus physical date",rules:"Cover placement fallback; nominateDate/SegmentDate contract; fallback note",employee:"PF 7000040; incident 11/09/2026 requires 8m cover",aspect:"Only incident SHIFT 07:00–15:00 is uploaded; no future SHIFT/OT",cms:"Late 8m with complete evidence",cognos:"Matches except late variance",config:"Subcase A fallback=nextWeekMonday default time 08:00. Subcase B fallback=sameDay.",calc:"No future working day exists in uploaded ASPECT scope. A targets Monday 14/09 08:00. B anchors after last incident-day segment at 15:00.",resolution:"Cover is generated with deterministic fallback note; never presented as a normal schedule-backed placement.",taa:"TAA_COVER_FALLBACK_NOTE populated with chosen option; action LATE_AND_COVER",compare:"Fallback does not change original Cognos columns",category:"LATE_AND_COVER_ADDED; inclusion per comparisons",csv:"A nominateDate=14/09/2026, SegmentDate=14/09/2026, start=08:00, duration=00:08. B nominateDate=11/09/2026, SegmentDate=11/09/2026, start=15:00. Memo names fallback.",email:"NA",pass:"Changing fallback option changes only documented placement; no silent next-day guess.",bug:"Cover disappears; uses 12/09 regardless config; memo loses fallback note; nominateDate stays incident date in A."},
];

function rowFor(x) {
  return [x.id,x.priority,x.name,x.rules,x.employee,x.aspect,x.cms,x.cognos,x.config,x.calc,x.resolution,x.taa,x.compare,x.category,x.csv,x.email,x.pass,x.bug,"","",""];
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

function buildCsv() {
  const rows = [commonHeaders, ...business.map(rowFor), ...algorithm.map(rowFor)];
  return rows.map(r => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function buildMarkdown() {
  const intro = `# TAA validation scenario pack\n\nGenerated from the live project rules and source code on 11 September 2026. This pack contains 20 combined business-rule cases and 20 application/algorithm cases. Defaults assumed unless a case states an override.\n\n## Exact answer to the supplied nursing example\n\nFor an OPS agent scheduled 07:00–15:00 with NURSNG 14:00–15:00, the effective end becomes 14:00. A 15:20 logout is therefore 80 minutes after the effective end. Rule 4 (Late Logout, 60+ minutes) produces ABSENT_SEGMENT and EMAIL_OPS. If Cognos still reports an 8-hour schedule, SCH DURATION must mismatch the recomputed 7 hours and the correction stays held until review. See BR-01.\n\n## Current default boundaries\n\n- ${defaults.lateOps}\n- ${defaults.lateOfficer}\n- ${defaults.earlyOps}\n- ${defaults.earlyOfficer}\n- ${defaults.lateLogout}\n- Cover not attended OPS: ${defaults.coverOps}\n- Cover not attended Officer+: ${defaults.coverOfficer}\n- Leave-day attendance anomaly: 60+ minutes\n- Flex: cutoff 10:00; nearest 30-minute rounding; valid scheduled-start window 07:00–10:00\n- Comparison tolerance: 1 minute\n- Correction insert code: 00; change pair codes: 10 then 11\n\n## How Claude should use this pack\n\nFor each case, build the smallest fixture that exactly represents the listed ASPECT, CMS, Cognos, identity, and configuration inputs. Run the real parser and reconciliation path where possible. Assert the derived TAA columns, column comparison statuses, hold/inclusion state, correction CSV rows, and email routing separately. Do not treat a matching final action as a pass if the audit fields, dates, durations, or CSV wire format differ. Record the actual result, Pass/Fail, and bug reference in the workbook or combined CSV.\n\n`;
  const section = (title, rows) => {
    let s = `## ${title}\n\n`;
    for (const x of rows) {
      s += `### ${x.id} — ${x.name}\n\n`;
      s += `- Priority: ${x.priority}\n- Rules/functions: ${x.rules}\n- Employee/date: ${x.employee}\n- ASPECT: ${x.aspect.replace(/\n/g,'; ')}\n- CMS: ${x.cms.replace(/\n/g,'; ')}\n- Cognos: ${x.cognos.replace(/\n/g,'; ')}\n- Config: ${x.config}\n- Expected recomputation: ${x.calc}\n- Expected resolution: ${x.resolution}\n- Expected TAA columns: ${x.taa}\n- Cognos comparison: ${x.compare}\n- Category/hold/inclusion: ${x.category}\n- Expected correction CSV: ${x.csv.replace(/\n/g,' | ')}\n- Communication: ${x.email}\n- Pass criteria: ${x.pass}\n- Bug signature: ${x.bug}\n\n`;
    }
    return s;
  };
  return intro + section("20 combined business-rule scenarios", business) + section("20 application and algorithm scenarios", algorithm);
}

const workbook = Workbook.create();
const overview = workbook.worksheets.add("Overview");
const rulesSheet = workbook.worksheets.add("Rule scenarios");
const algoSheet = workbook.worksheets.add("Algorithm scenarios");
const contractSheet = workbook.worksheets.add("Output contract");
const matrixSheet = workbook.worksheets.add("Rule matrix");

for (const s of [overview,rulesSheet,algoSheet,contractSheet,matrixSheet]) s.showGridLines = false;

overview.getRange("A2:H2").merge();
overview.getRange("A2").values = [["TAA validation scenario pack"]];
overview.getRange("A2:H2").format.font = {name:"Arial",size:16,bold:true,color:"#172033"};
overview.getRange("A3:H3").merge();
overview.getRange("A3").values = [["40 cases covering combined attendance rules, Cognos comparison, holds, and output serialization"]];
overview.getRange("A3:H3").format.font = {name:"Arial",size:10,italic:true,color:"#5B6472"};
overview.getRange("A5:D9").values = [
  ["Suite","Cases","Critical","High"],
  ["Combined business rules",business.length,business.filter(x=>x.priority==="Critical").length,business.filter(x=>x.priority==="High").length],
  ["Application / algorithm",algorithm.length,algorithm.filter(x=>x.priority==="Critical").length,algorithm.filter(x=>x.priority==="High").length],
  ["Total",business.length+algorithm.length,[...business,...algorithm].filter(x=>x.priority==="Critical").length,[...business,...algorithm].filter(x=>x.priority==="High").length],
  ["Required result fields",3,"Actual result","Pass / Fail + Bug ID"],
];
overview.getRange("A5:D5").format = {fill:"#243B53",font:{name:"Arial",size:10,bold:true,color:"#FFFFFF"},horizontalAlignment:"center"};
overview.getRange("A6:D9").format.font = {name:"Arial",size:10,color:"#172033"};
overview.getRange("A11:H11").merge();
overview.getRange("A11").values = [["Decision for the supplied nursing example"]];
overview.getRange("A11:H11").format = {fill:"#DCEBFF",font:{name:"Arial",size:11,bold:true,color:"#123A63"}};
overview.getRange("A12:H15").merge();
overview.getRange("A12").values = [["OPS agent, SHIFT 07:00–15:00, NURSNG 14:00–15:00, logout 15:20: effective end is 14:00. The logout is 80 minutes late from the effective end, so Rule 4 fires: ABSENT_SEGMENT and EMAIL_OPS. If Cognos still shows SCH DURATION 08:00, the app recomputes 07:00, flags a mismatch, and holds the correction until review. See BR-01."]];
overview.getRange("A12:H15").format = {fill:"#FFF5D6",font:{name:"Arial",size:11,color:"#5B3A00"},wrapText:true,verticalAlignment:"center"};
overview.getRange("A17:H17").merge();
overview.getRange("A17").values = [["Execution method"]];
overview.getRange("A17:H17").format = {fill:"#E8EEF5",font:{name:"Arial",size:11,bold:true,color:"#172033"}};
overview.getRange("A18:H22").merge();
overview.getRange("A18").values = [["Create the smallest fixture for each case and run the real parsers plus reconciliation engine. Assert calculations, TAA fields, Cognos comparison statuses, hold/inclusion state, correction CSV wire format, and communication separately. A case fails if any required audit field is wrong even when the final action happens to match. Record results in the final three columns."]];
overview.getRange("A18:H22").format = {font:{name:"Arial",size:10,color:"#172033"},wrapText:true,verticalAlignment:"top"};
overview.getRange("A2:H22").format.verticalAlignment = "center";
overview.getRange("A:H").format.columnWidth = 15;
overview.getRange("A:A").format.columnWidth = 29;
overview.getRange("A2:H22").format.borders = {bottom:{style:"thin",color:"#D6DEE8"}};

function populateScenarioSheet(sheet, rows, tableName) {
  sheet.getRange("A1:U1").merge();
  sheet.getRange("A1").values = [[tableName === "BusinessRuleCases" ? "20 combined business-rule scenarios" : "20 application and algorithm scenarios"]];
  sheet.getRange("A1:U1").format = {font:{name:"Arial",size:15,bold:true,color:"#172033"}};
  sheet.getRange("A3:U3").values = [commonHeaders];
  sheet.getRange(`A4:U${rows.length+3}`).values = rows.map(rowFor);
  const used = sheet.getRange(`A3:U${rows.length+3}`);
  used.format.font = {name:"Arial",size:9,color:"#172033"};
  used.format.verticalAlignment = "top";
  used.format.wrapText = true;
  sheet.getRange("A3:U3").format = {fill:"#243B53",font:{name:"Arial",size:9,bold:true,color:"#FFFFFF"},horizontalAlignment:"center",verticalAlignment:"center",wrapText:true};
  sheet.getRange(`A4:A${rows.length+3}`).format = {fill:"#E8EEF5",font:{name:"Arial",size:9,bold:true,color:"#123A63"},horizontalAlignment:"center",verticalAlignment:"top"};
  sheet.getRange(`B4:B${rows.length+3}`).conditionalFormats.add("containsText",{text:"Critical",format:{fill:"#FDE2E1",font:{bold:true,color:"#A61B1B"}}});
  sheet.getRange(`B4:B${rows.length+3}`).conditionalFormats.add("containsText",{text:"High",format:{fill:"#FFF3CD",font:{bold:true,color:"#7A4E00"}}});
  sheet.getRange(`S4:U${rows.length+3}`).format.fill = "#FFF8D8";
  used.format.borders = {insideHorizontal:{style:"thin",color:"#D6DEE8"},bottom:{style:"thin",color:"#D6DEE8"}};
  sheet.freezePanes.freezeRows(3);
  sheet.freezePanes.freezeColumns(3);
  const widths = [10,10,28,31,24,34,29,34,27,38,38,42,37,31,45,28,37,35,28,12,24];
  widths.forEach((w,i)=>sheet.getRangeByIndexes(0,i,rows.length+3,1).format.columnWidth=w);
  sheet.getRange("1:1").format.rowHeight = 26;
  sheet.getRange("3:3").format.rowHeight = 48;
  for(let r=4;r<=rows.length+3;r++) sheet.getRange(`${r}:${r}`).format.rowHeight = 126;
  const table = sheet.tables.add(`A3:U${rows.length+3}`,true,tableName);
  table.style = "TableStyleMedium2";
}

populateScenarioSheet(rulesSheet,business,"BusinessRuleCases");
populateScenarioSheet(algoSheet,algorithm,"AlgorithmCases");

contractSheet.getRange("A2:G2").merge();
contractSheet.getRange("A2").values = [["Output assertions"]];
contractSheet.getRange("A2:G2").format.font = {name:"Arial",size:15,bold:true,color:"#172033"};
contractSheet.getRange("A4:G4").values = [["Output","Required columns / format","Mutation rule","Hold behavior","Cross-midnight rule","Security rule","Failure examples"]];
contractSheet.getRange("A5:G8").values = [
  ["Annotated Cognos CSV/TSV","Original 18 columns, then 38 TAA audit columns","Only configured blank-fill columns may be populated when source cell is blank; populated source values never overwritten","Every row retained; mismatch and holds explicitly appended","SIGIN time-of-day can be ambiguous; TAA_CMS_IN/OUT must carry full dates","Leading = + - @ text is apostrophe-prefixed","Dropped Cognos row; changed source OT-2; missing TAA hold fields"],
  ["ASPECT correction CSV","Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo,","Only eligible generated corrections; each line has final comma; Memo always quoted","Held rows excluded until allowed approval; forced holds never released","nominateDate owns schedule; SegmentDate is physical event date","No spreadsheet apostrophe injection into machine fields; Memo quoting protects commas/quotes","Code 0 instead of 00; wrong physical date; no trailing comma"],
  ["Results workbook/UI","Five categories plus Held-for-review view","Shows Cognos raw, recomputed truth, punches, final action, details","A row may appear in category and Held view","Full timestamps visible in trace","Text only; no hidden action","Only final action shown; actions-fired audit missing"],
  ["Email draft records","Communication rule and durable status per row","Drafts only; never auto-send","Missing OPS section mailbox holds draft; never reroutes to staff","Nominate date remains incident schedule date","Corporate alias rules and terminated safeguards apply","Email sent automatically; personal-domain local-part used"],
];
contractSheet.getRange("A4:G4").format = {fill:"#243B53",font:{name:"Arial",size:10,bold:true,color:"#FFFFFF"},horizontalAlignment:"center",wrapText:true};
contractSheet.getRange("A5:G8").format = {font:{name:"Arial",size:10,color:"#172033"},wrapText:true,verticalAlignment:"top"};
contractSheet.getRange("A4:G8").format.borders = {insideHorizontal:{style:"thin",color:"#D6DEE8"},bottom:{style:"thin",color:"#D6DEE8"}};
for(let i=0;i<7;i++) contractSheet.getRangeByIndexes(0,i,8,1).format.columnWidth=[23,41,40,36,34,35,36][i];
for(let r=5;r<=8;r++) contractSheet.getRange(`${r}:${r}`).format.rowHeight=88;
contractSheet.freezePanes.freezeRows(4);

matrixSheet.getRange("A2:F2").merge();
matrixSheet.getRange("A2").values = [["Current default rule matrix"]];
matrixSheet.getRange("A2:F2").format.font = {name:"Arial",size:15,bold:true,color:"#172033"};
matrixSheet.getRange("A4:F4").values = [["Rule","Tier","Minute band","Action","Communication","Important implementation detail"]];
matrixSheet.getRange("A5:F20").values = [
  ["R_1 Late Login","OPS","0–5","NO_ACTION","NA","When a band fires, charge the full measured variance"],
  ["R_1 Late Login","OPS","6–60","LATE_AND_COVER","NA","Cover goes to next working schedule"],
  ["R_1 Late Login","OPS","61+","ABSENT_SEGMENT","EMAIL_OPS","OT1/OT2 convert to SHIFT on absent day"],
  ["R_1 Late Login","Officer+","0–10","NO_ACTION","NA","Tier from ASPECT identity keywords"],
  ["R_1 Late Login","Officer+","11–60","LATE_AND_COVER","NA","Full variance charged"],
  ["R_1 Late Login","Officer+","61+","ABSENT_SEGMENT","EMAIL_STAFF_CC_MANAGER","Manager CC optional; terminated safeguard applies"],
  ["R_3 Early Logout","OPS","0–4","NO_ACTION","NA","Measured from effective end"],
  ["R_3 Early Logout","OPS","5–9","LOGOFF_AND_COVER","NA","Full variance charged"],
  ["R_3 Early Logout","OPS","10+","ABSENT_SEGMENT","EMAIL_OPS","Timed penalties stripped when absent"],
  ["R_3 Early Logout","Officer+","0–5","NO_ACTION","NA","Measured from effective end"],
  ["R_3 Early Logout","Officer+","6–20","LOGOFF_AND_COVER","NA","Full variance charged"],
  ["R_3 Early Logout","Officer+","21+","ABSENT_SEGMENT","EMAIL_STAFF_CC_MANAGER","Timed penalties stripped when absent"],
  ["R_4 Late Logout","Both","60+","ABSENT_SEGMENT","Tier-specific","Measured from release/nursing-adjusted effective end"],
  ["R_5 No Login","Both","Any","ABSENT_NS_NC","Tier-specific","Only after coverage and join-key safety gates"],
  ["R_6 One Punch","Both","Any","ABSENT_SEGMENT","Tier-specific","Thin evidence + sufficient coverage"],
  ["R_7 Cover Not Attended","Tier-specific","OPS 5+/Officer 6+","markAbsent or moveForward","Band-specific","Outcome controlled by separate config"],
];
matrixSheet.getRange("A22:F26").values = [
  ["Other","Default","Value","Purpose","Output effect","Risk"],
  ["R_8 RLS overlaps OT","All","Any overlap","Adjust each OT independently","10/11 pair","Never merge OT1 and OT2"],
  ["Leave anomaly","All","60+ minutes","Convert anomalous leave-day attendance to ABSENT","00 ABSENT","59 must remain excluded"],
  ["Flex","Tagged","Cutoff 10:00; nearest 30m","Shift update or cutoff late+cover","10/11 pair plus possible timed rows","Outside 07:00–10:00 start window is forced-held"],
  ["Comparison","All","Tolerance 1 minute","Recompute then compare","Mismatch hold","Approval must not erase mismatch evidence"],
];
for(const rg of ["A4:F4","A22:F22"]) matrixSheet.getRange(rg).format={fill:"#243B53",font:{name:"Arial",size:10,bold:true,color:"#FFFFFF"},horizontalAlignment:"center",wrapText:true};
matrixSheet.getRange("A5:F26").format={font:{name:"Arial",size:10,color:"#172033"},wrapText:true,verticalAlignment:"top"};
matrixSheet.getRange("A4:F26").format.borders={insideHorizontal:{style:"thin",color:"#D6DEE8"},bottom:{style:"thin",color:"#D6DEE8"}};
[22,16,19,28,28,45].forEach((w,i)=>matrixSheet.getRangeByIndexes(0,i,26,1).format.columnWidth=w);
matrixSheet.freezePanes.freezeRows(4);

workbook.recalculate();

const overviewCheck = await workbook.inspect({kind:"table",range:"Overview!A2:H22",include:"values,formulas",tableMaxRows:25,tableMaxCols:8});
console.log(overviewCheck.ndjson);
const rulesCheck = await workbook.inspect({kind:"table",range:"Rule scenarios!A3:U5",include:"values,formulas",tableMaxRows:5,tableMaxCols:21});
console.log(rulesCheck.ndjson);
const errorCheck = await workbook.inspect({kind:"match",searchTerm:"#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",options:{useRegex:true,maxResults:100},summary:"final formula error scan"});
console.log(errorCheck.ndjson);

for (const [sheetName,range,file] of [
  ["Overview","A1:H22","preview_overview.png"],
  ["Rule scenarios","A1:U7","preview_rule_scenarios.png"],
  ["Algorithm scenarios","A1:U7","preview_algorithm_scenarios.png"],
  ["Output contract","A1:G8","preview_output_contract.png"],
  ["Rule matrix","A1:F26","preview_rule_matrix.png"],
]) {
  const image = await workbook.render({sheetName,range,scale:1,format:"png"});
  await fs.writeFile(path.join(outputDir,file),new Uint8Array(await image.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(path.join(outputDir,"TAA_40_Validation_Scenarios.xlsx"));
await fs.writeFile(path.join(outputDir,"TAA_40_Validation_Scenarios.csv"),buildCsv(),"utf8");
await fs.writeFile(path.join(outputDir,"TAA_40_Validation_Scenarios.md"),buildMarkdown(),"utf8");

console.log(JSON.stringify({xlsx:path.join(outputDir,"TAA_40_Validation_Scenarios.xlsx"),csv:path.join(outputDir,"TAA_40_Validation_Scenarios.csv"),md:path.join(outputDir,"TAA_40_Validation_Scenarios.md"),business:business.length,algorithm:algorithm.length},null,2));
