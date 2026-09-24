# TAA validation scenario pack

Generated from the live project rules and source code on 11 September 2026. This pack contains 20 combined business-rule cases and 20 application/algorithm cases. Defaults assumed unless a case states an override.

## Exact answer to the supplied nursing example

For an OPS agent scheduled 07:00–15:00 with NURSNG 14:00–15:00, the effective end becomes 14:00. A 15:20 logout is therefore 80 minutes after the effective end. Rule 4 (Late Logout, 60+ minutes) produces ABSENT_SEGMENT and EMAIL_OPS. If Cognos still reports an 8-hour schedule, SCH DURATION must mismatch the recomputed 7 hours and the correction stays held until review. See BR-01.

## Current default boundaries

- 6–60 min => LATE_AND_COVER; 61+ => ABSENT
- 11–60 min => LATE_AND_COVER; 61+ => ABSENT
- 5–9 min => LOGOFF_AND_COVER; 10+ => ABSENT
- 6–20 min => LOGOFF_AND_COVER; 21+ => ABSENT
- 60+ min after effective end => ABSENT
- Cover not attended OPS: 5–9 min => action without email; 10+ => action + EMAIL_OPS
- Cover not attended Officer+: 6–19 min => action without email; 20+ => action + EMAIL_STAFF_CC_MANAGER
- Leave-day attendance anomaly: 60+ minutes
- Flex: cutoff 10:00; nearest 30-minute rounding; valid scheduled-start window 07:00–10:00
- Comparison tolerance: 1 minute
- Correction insert code: 00; change pair codes: 10 then 11

## How Claude should use this pack

For each case, build the smallest fixture that exactly represents the listed ASPECT, CMS, Cognos, identity, and configuration inputs. Run the real parser and reconciliation path where possible. Assert the derived TAA columns, column comparison statuses, hold/inclusion state, correction CSV rows, and email routing separately. Do not treat a matching final action as a pass if the audit fields, dates, durations, or CSV wire format differ. Record the actual result, Pass/Fail, and bug reference in the workbook or combined CSV.

## 20 combined business-rule scenarios

### BR-01 — Nursing carve-out followed by very late departure

- Priority: Critical
- Rules/functions: R_4 Late Logout + NURSNG removal + effective-end anchor + Cognos recompute
- Employee/date: OPS; PF 7000001; Login 90001; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 07:00–15:00 (480m); NURSNG 11/09 14:00–15:00 (60m)
- CMS: Login 11/09 07:00; Logout 11/09 15:20
- Cognos: DUTY1=07:00-15:00; SCH DURATION=08:00; SIGIN IN=07:00; SIGIN OUT=15:20; LEFT EARLY based on raw end (not effective end)
- Config: Defaults
- Expected recomputation: Net schedule=420m (07:00–14:00 effective). Actual span=500m. Late login=0. Late logout=80m measured from 14:00, not 20m from 15:00.
- Expected resolution: R_4 fires at 80m => ABSENT_SEGMENT. This is the answer to the example: logout at 15:20 is 80m after the nursing-adjusted end.
- Expected TAA columns: TAA_TIER=OPS; TAA_SCH_HOURS_RECOMPUTED=420; TAA_EFFECTIVE_START=07:00; TAA_EFFECTIVE_END=14:00; TAA_LATE_MIN=0; TAA_EARLY_MIN=0; TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=ABSENT_SEGMENT
- Cognos comparison: SCH DURATION 08:00 vs 07:00 => MISMATCH. DUTY1 can remain a raw-window match. TAA_COGNOS_AGREE=FALSE; mismatch includes SCH DURATION.
- Category/hold/inclusion: MARKED_ABSENT; hold=MISMATCH_FOUND; includeInOutput=FALSE until reviewer approval
- Expected correction CSV: After approval: | 00,7000001,ABSENT,11/09/2026,,,,"TAA Late Logout 80m past release-adjusted end",
- Communication: EMAIL_OPS, routed by Cognos SECTION; missing section mailbox must hold email drafting, never reroute to staff.
- Pass criteria: Uses 14:00 effective end; produces one absence marker; keeps row out of correction CSV while mismatch is unapproved.
- Bug signature: Only 20m late is calculated; nursing ignored; No Action returned; populated Cognos schedule overwritten; correction exported before approval.

### BR-02 — Cross-midnight late arrival and early departure with two covers

- Priority: Critical
- Rules/functions: R_1 Late Login + R_3 Early Logout + cross-midnight attribution + multi-action audit + cover stacking
- Employee/date: OPS; PF 7000002; Login 90002; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 19:00–12/09 03:00; Next working SHIFT NOM_DATE 13/09 19:00–14/09 03:00
- CMS: Login 11/09 19:08; Logout 12/09 02:53
- Cognos: DUTY1=19:00-03:00; SIGIN IN=19:08; SIGIN OUT=02:53; legacy report may mark U-ABSENT due next-day logout
- Config: Defaults
- Expected recomputation: Late=8m; early=7m; actual punches belong to 11/09 schedule despite logout date 12/09. Charged variance=15m.
- Expected resolution: R_1 and R_3 both fire. Same severity means later departure action is final: TAA_ACTION=LOGOFF_AND_COVER. TAA_ACTIONS_FIRED must retain LATE_AND_COVER; LOGOFF_AND_COVER.
- Expected TAA columns: TAA_CMS_IN=11/09/2026 19:08; TAA_CMS_OUT=12/09/2026 02:53; TAA_LATE_MIN=8; TAA_EARLY_MIN=7; TAA_VERDICT=EARLY_LOGOUT; TAA_ACTION=LOGOFF_AND_COVER; category=LATE_AND_COVER_ADDED
- Cognos comparison: Cognos time-of-day fields may match, but false U-ABSENT must be exposed through TAA_VERDICT/TAA_DISAGREE_REASON. No false missing-punch result.
- Category/hold/inclusion: LATE_AND_COVER_ADDED; no hold when comparisons are otherwise within tolerance; include=TRUE
- Expected correction CSV: 00,7000002,LATE,11/09/2026,11/09/2026,19:00,00:08,"TAA Late Login 8m", | 00,7000002,Log_off,11/09/2026,12/09/2026,02:53,00:07,"TAA Early Logout 7m", | Two COVER rows owned by NOM_DATE 13/09; physical date 14/09; starts 03:00 then 03:08; durations 00:08 and 00:07.
- Communication: NA for both OPS band-1 rules.
- Pass criteria: Both actions and all four timed corrections exist; covers do not overlap; SegmentDate rolls to 14/09 while nominateDate stays 13/09.
- Bug signature: Logout joined to 12/09 row; one rule suppresses the other; charged variance=7 or 8 only; both covers start 03:00.

### BR-03 — Officer night shift with trailing RLS, late login, and 60-minute late logout

- Priority: Critical
- Rules/functions: R_1 Officer band + R_4 boundary + RLS effective end + absent strips timed penalties
- Employee/date: OFFICER_PLUS; PF 7000003; Login 90003; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 23:00–12/09 07:00; RLS 12/09 06:00–07:00
- CMS: Login 11/09 23:11; Logout 12/09 07:00
- Cognos: DUTY1=23:00-07:00; SCH DURATION=08:00; SIGIN IN=23:11; SIGIN OUT=07:00
- Config: Defaults
- Expected recomputation: Effective end=06:00; net=420m. Late login=11m. Late logout=60m exactly.
- Expected resolution: R_1 initially fires LATE_AND_COVER; R_4 fires at inclusive 60m and wins as ABSENT. Final-day cleanup removes LATE and COVER rows but preserves both fired actions in audit.
- Expected TAA columns: TAA_TIER=OFFICER_PLUS; TAA_LATE_MIN=11; TAA_EFFECTIVE_END=06:00; TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=LATE_AND_COVER; ABSENT_SEGMENT
- Cognos comparison: SCH DURATION mismatch 08:00 vs 07:00; cross-midnight CMS timestamps shown in full TAA columns.
- Category/hold/inclusion: MARKED_ABSENT; likely MISMATCH_FOUND until approval; include=FALSE
- Expected correction CSV: Only ABSENT remains after approval. No LATE/COVER row: | 00,7000003,ABSENT,11/09/2026,,,,"TAA Late Logout 60m past release-adjusted end",
- Communication: EMAIL_STAFF_CC_MANAGER. Missing manager is allowed (no CC); terminated employee blocks drafting.
- Pass criteria: 60 is treated as in-band; no double-hit timed corrections survive absence.
- Bug signature: Threshold coded >60; raw 07:00 used as end; late and cover remain beside ABSENT.

### BR-04 — Absent day with OT1, OT2 and RLS overlapping both overtime types

- Priority: Critical
- Rules/functions: R_1 61-minute boundary + absent OT-to-SHIFT replace pair (R_8 skipped on an Absent day) + OT1/OT2 separation
- Employee/date: OPS; PF 7000004; Login 90004; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; OT1 15:00–17:00; OT2 17:00–19:00; RLS 16:00–18:00
- CMS: Login 08:01; Logout 19:00
- Cognos: DUTY1=07:00-15:00; DUTY-2 blank; OT1 blank; OT-2 blank; SCH DURATION=08:00
- Config: Defaults
- Expected recomputation: Late=61m => absent. OT1=120m and OT2=120m remain distinct (hours math still nets the RLS-in-OT overlap: 480+120+120-120=600). Since the day is Absent, §4.6c retires each OT segment at its FULL original 120m duration, regardless of the RLS overlap — Rule 8's own RLS-netted adjustment is skipped entirely to avoid drafting a second, conflicting pair.
- Expected resolution: ABSENT is primary. §4.6c independently retires each scheduled OT segment via its own 10/11 replace pair (full duration, SegmentCode swapped to SHIFT) because the day is absent — Rule 8 (ADJUST_OT_RLS) never fires on this day, so there is only one pair per OT segment, not two conflicting ones.
- Expected TAA columns: TAA_OT1=120; TAA_OT2=120; TAA_LATE_MIN=61; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED includes ABSENT_SEGMENT and OT_TO_SHIFT (never ADJUST_OT_RLS); TAA_VERDICT=ABSENT
- Cognos comparison: Blank OT1/OT-2 filled with recomputed values; DUTY-2 reflects OT window according to shape rules; SCH DURATION comparison uses recomputed net, not Cognos 08:00.
- Category/hold/inclusion: MARKED_ABSENT; hold if any comparison mismatch; include only after approval
- Expected correction CSV: One ABSENT row; for each OT: Code 10 (original OT1/OT2, full 02:00) then Code 11 (SegmentCode=SHIFT, same 02:00, never RLS-netted) — 5 rows total. No plain Code 00 SHIFT insert. OT1 and OT2 must never merge.
- Communication: EMAIL_OPS from late-login absence.
- Pass criteria: No OT type is lost; all dates normalize; each pair is ordered 10 then 11 at the FULL original duration; one day-level ABSENT only; exactly 5 correction rows.
- Bug signature: OT1+OT2 summed; RLS-netted duration leaks into the retire pair instead of the full original; duplicate/conflicting 10/11 pairs from Rule 8 firing alongside §4.6c; duplicate ABSENT; timed late/cover survives; conversion changes times.

### BR-05 — Late login plus unattended existing cover escalates to absence

- Priority: Critical
- Rules/functions: R_1 + R_7 + COVER excluded from attendance window + most-severe-wins + absent cleanup
- Employee/date: OPS; PF 7000005; Login 90005; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; Existing COVER 15:00–15:12
- CMS: Login 07:06; Logout 15:00
- Cognos: DUTY1=07:00-15:00; SIGIN IN=07:06; SIGIN OUT=15:00
- Config: coverNotAttendedAction=markAbsent (default); coverExtendsAttendanceWindow=false
- Expected recomputation: Late login=6m. Existing cover attendance overlap=0, shortfall=12m. Cover does not change effective end.
- Expected resolution: R_1 band1 fires; R_7 OPS 10+ fires and escalates to ABSENT + EMAIL_OPS. Final cleanup removes LATE and all newly placed COVER rows.
- Expected TAA columns: TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=LATE_AND_COVER; ABSENT_SEGMENT; TAA_LATE_MIN=6; charged variance trace=18m; verdict=ABSENT
- Cognos comparison: Cognos may show only 6m late; TAA disagreement reason must explain unattended cover escalation.
- Category/hold/inclusion: MARKED_ABSENT; include based on mismatch approval
- Expected correction CSV: Exactly one ABSENT marker for 11/09. No LATE, Log_off, or COVER output rows.
- Communication: EMAIL_OPS because Rule 7 shortfall is 12m.
- Pass criteria: Rule 7 is evaluated even though Rule 1 already fired; absence de-duplicates and strips timed penalties.
- Bug signature: Existing cover extends end to 15:12 causing duplicate early logout; two ABSENT rows; late cover remains.

### BR-06 — Partially attended officer cover is moved and stacked after existing cover

- Priority: High
- Rules/functions: R_7 Officer boundary + moveCoverForward + full-cover move + target-day stacking
- Employee/date: OFFICER_PLUS; PF 7000006; Login 90006; incident 11/09/2026
- ASPECT: 11/09 SHIFT 07:00–15:00 + COVER 15:00–15:10; 12/09 SHIFT 07:00–15:00 + existing COVER 15:00–15:12
- CMS: Login 07:00; Logout 15:04 (attends 4m of 10m cover)
- Cognos: Attendance otherwise on time; no cover-specific Cognos column
- Config: coverNotAttendedAction=moveCoverForward
- Expected recomputation: Cover duration=10m; attended overlap=4m; shortfall=6m. Officer band begins at 6. Re-placement moves the entire 10m cover, not only 6m.
- Expected resolution: R_7 fires as LATE_AND_COVER behavior. New cover stacks at 15:12 after target day's existing cover.
- Expected TAA columns: TAA_ACTION=LATE_AND_COVER; TAA_ACTIONS_FIRED=LATE_AND_COVER; TAA_RESULT_CATEGORY=LATE_AND_COVER_ADDED; TAA_EARLY_MIN=0
- Cognos comparison: No fabricated early logout from the original cover. Cognos agreement can remain TRUE if core columns match.
- Category/hold/inclusion: LATE_AND_COVER_ADDED; no hold; include=TRUE
- Expected correction CSV: 00,7000006,COVER,12/09/2026,12/09/2026,15:12,00:10,"TAA Cover Not Attended: moved forward (was 11/09/2026 15:00)",
- Communication: NA for Officer 6–19m cover shortfall.
- Pass criteria: Start is 15:12, duration is original 00:10, not shortfall 00:06.
- Bug signature: Placed at 15:00; overlaps target cover; moves only 6m; emails officer despite lower band.

### BR-07 — Flex shift change plus early logout after the shifted end

- Priority: Critical
- Rules/functions: Flex branch A + 30-minute rounding + shift update 10/11 pair + R_3 downstream
- Employee/date: OPS FLEX; PF 7000007; Login 90007; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; Next working SHIFT 12/09 07:00–15:00
- CMS: Login 08:12; Logout 15:52
- Cognos: DUTY1=07:00-15:00; SIGIN IN=08:12; SIGIN OUT=15:52; may report 72m late to original start
- Config: cutoff=10:00; nearest 30m; expected start window 07:00–10:00
- Expected recomputation: 08:12 rounds to 08:00. Shift becomes 08:00–16:00 with 480m preserved. Logout is 8m early relative to shifted end.
- Expected resolution: Flex shift update fires, then R_3 OPS 5–9 fires. Later equal/higher category wins final LOGOFF_AND_COVER while actions audit retains SHIFT_UPDATE_FLEX and LOGOFF_AND_COVER.
- Expected TAA columns: TAA_TIER=FLEX; TAA_EFFECTIVE_START=08:00; TAA_EFFECTIVE_END=16:00; TAA_LATE_MIN=0; TAA_EARLY_MIN=8; TAA_ACTION=LOGOFF_AND_COVER; TAA_ACTIONS_FIRED=SHIFT_UPDATE_FLEX; LOGOFF_AND_COVER
- Cognos comparison: Cognos original duty remains untouched and likely mismatches recomputed effective timing; TAA columns show the shifted truth.
- Category/hold/inclusion: LATE_AND_COVER_ADDED; MISMATCH_FOUND until review if Cognos does not reflect new shift
- Expected correction CSV: 10 original SHIFT 07:00 08:00 OrginalShift | 11 updated SHIFT 08:00 08:00 updatedshift | 00 Log_off at 15:52 for 00:08 | 00 COVER on next working day for 00:08
- Communication: NA for OPS early-logout lower band.
- Pass criteria: Duration remains 8h; departure checks shifted 16:00; all four rows survive unless a stronger absence fires.
- Bug signature: Flex suppresses departure rules; rounds to 08:30; shifts end to 15:00; omits 10/11 pair.

### BR-08 — Flex one minute past cutoff plus early logout absence

- Priority: Critical
- Rules/functions: Flex branch B + cutoff variance bypass + R_3 10-minute boundary + absent cleanup
- Employee/date: OPS FLEX; PF 7000008; Login 90008; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; Next workday available
- CMS: Login 10:01; Logout 17:50
- Cognos: May calculate 181m late against 07:00 and treat absent for lateness
- Config: flexBypassesMinuteBands=true; cutoff=10:00
- Expected recomputation: Shift clamped to 10:00–18:00. Flex late variance=1m (not 181m). Early logout=10m from shifted end.
- Expected resolution: Flex late creates shift update + 1m cover. R_3 OPS at 10m escalates to ABSENT. Final cleanup removes flex LATE/COVER and Log_off/COVER, but keeps shift-update pair and ABSENT.
- Expected TAA columns: TAA_TIER=FLEX; TAA_EFFECTIVE_START=10:00; TAA_EFFECTIVE_END=18:00; TAA_LATE_MIN=1; TAA_EARLY_MIN=10; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=SHIFT_UPDATE_AND_LATE_COVER_FLEX; ABSENT_SEGMENT
- Cognos comparison: TAA exposes 1m flex cutoff variance and 10m early departure; Cognos's 181m is not adopted.
- Category/hold/inclusion: MARKED_ABSENT; likely mismatch hold
- Expected correction CSV: Code 10/11 shift pair (07:00 original; 10:00 updated; 08:00 duration) + one Code 00 ABSENT. No LATE, Log_off, or COVER rows.
- Communication: EMAIL_OPS from early-logout absence; flex late itself is silent.
- Pass criteria: Full flex logic and departure severity combine without double docking.
- Bug signature: 181m charged; flex late alone marks absent; shift pair stripped; leftover cover exported.

### BR-09 — Flex-tagged night shift outside approved flex window

- Priority: Critical
- Rules/functions: Flex safety gate + standard attendance fallback + forced hold
- Employee/date: OPS FLEX; PF 7000009; Login 90009; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 19:00–12/09 03:00
- CMS: Login 19:05; Logout 03:05 next day
- Cognos: DUTY1=19:00-03:00; punches accurate
- Config: flexExpectedSchedStartWindow=07:00–10:00
- Expected recomputation: Flex cutoff algorithm is unsafe for this schedule and must be skipped. Standard OPS late=5m => below R_1 threshold.
- Expected resolution: Operational verdict can be PRESENT/NO_ACTION, but forced hold FLEX_SCHEDULE_OUTSIDE_WINDOW prevents automatic release.
- Expected TAA columns: TAA_TIER=FLEX; TAA_LATE_MIN=5; TAA_ACTION=NO_ACTION or manual-review presentation; holdReason=FLEX_SCHEDULE_OUTSIDE_WINDOW
- Cognos comparison: Core schedule/punch comparisons can match; hold is independent of Cognos agreement.
- Category/hold/inclusion: NO_ACTION_REQUIRED plus locked forced hold; include=FALSE and reviewer cannot release forced hold
- Expected correction CSV: Header only; no correction rows.
- Communication: NA
- Pass criteria: Never clamps night shift to 10:00; cannot be included through normal approval toggle.
- Bug signature: Shift changed to 10:00; false absence; forced hold is user-releasable.

### BR-10 — Split shift with a long unpaid gap and sparse second-block evidence

- Priority: High
- Rules/functions: Whole-day first/last attendance + DUTY1/DUTY-2 construction + comparison-only block gap
- Employee/date: OPS; PF 7000010; Login 90010; NOM_DATE 11/09/2026
- ASPECT: SHIFT1 07:00–11:00; SHIFT2 13:00–17:00
- CMS: Session A 07:00–11:00; Session B 16:55–17:00
- Cognos: DUTY1=07:00-11:00; DUTY-2=13:00-17:00; SIGNIN DURATION may total staffed sessions rather than 10h span
- Config: perBlockGapThresholdMinutes=60
- Expected recomputation: Gap=120m => two non-OT blocks. Attendance penalties use first login 07:00 and last logout 17:00 only. Net schedule=480m; span=600m.
- Expected resolution: No late/early rule fires even though most of second block lacks session coverage. This is current whole-day design, not per-block enforcement.
- Expected TAA columns: TAA_LATE_MIN=0; TAA_EARLY_MIN=0; TAA_VERDICT=PRESENT; TAA_ACTION=NO_ACTION; TAA_RESULT_CATEGORY=NO_ACTION_REQUIRED
- Cognos comparison: DUTY1 and DUTY-2 MATCH. SIGNIN DURATION may be NOT_COMPARABLE when Cognos staffed time differs from TAA first-to-last span.
- Category/hold/inclusion: NO_ACTION_REQUIRED; no hold if remaining comparisons agree
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: No invented per-block absence. Trace clearly states whole-day anchors.
- Bug signature: Second block marked absent; two rows produced; two shift blocks collapsed into 07:00–17:00 DUTY1.

### BR-11 — Leave day with 59-minute login just below anomaly threshold

- Priority: High
- Rules/functions: Leave-day integrity gate + exact threshold lower edge + leave comparison suppression
- Employee/date: OPS; PF 7000011; Login 90011; NOM_DATE 11/09/2026
- ASPECT: ANNUAL full-day structural segment; no SHIFT/OT
- CMS: Login 10:00; Logout 10:59
- Cognos: DUTY1=07:00-15:00 entitlement; SCH DURATION=08:00; LEAVE TYPE=ANNUAL; LEAVE HR=08:00; SIGNIN blank
- Config: leaveLoginThresholdMinutes=60; compareScheduleColumnsOnLeaveDays=false
- Expected recomputation: Leave-day span=59m, below threshold.
- Expected resolution: LEAVE_EXCLUDED; normal late/early/no-show rules never run.
- Expected TAA columns: TAA_VERDICT=LEAVE_EXCLUDED; TAA_ACTION=NO_ACTION; TAA_RESULT_CATEGORY=NO_ACTION_REQUIRED; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; status=MATCH; basis=EXACT
- Cognos comparison: DUTY1, DUTY-2, SCH DURATION => NOT_COMPARABLE. LEAVE TYPE matches. Structural ANNUAL LEAVE HR is not fabricated from default 480 if configured durationless.
- Category/hold/inclusion: NO_ACTION_REQUIRED; include=TRUE but zero correction rows
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: 59 does not trigger anomaly or absence; Cognos roster entitlement does not create false mismatch.
- Bug signature: Uses >=59/off-by-one; no-login rule fires; leave schedule columns mismatch.

### BR-12 — Leave day with exactly 60 minutes of attendance

- Priority: Critical
- Rules/functions: Leave-day anomaly boundary + absence correction + leave evidence preserved
- Employee/date: OFFICER_PLUS; PF 7000012; Login 90012; NOM_DATE 11/09/2026
- ASPECT: ANNUAL full-day structural segment; no SHIFT/OT
- CMS: Login 10:00; Logout 11:00
- Cognos: LEAVE TYPE=ANNUAL; LEAVE HR=08:00; SIGIN IN/OUT blank
- Config: leaveLoginThresholdMinutes=60
- Expected recomputation: Span=60m exactly, so anomaly threshold is met.
- Expected resolution: ABSENT_SEGMENT with anomaly memo. Attendance rules remain gated; communication borrows R_6 tier setting.
- Expected TAA columns: TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_ACTIONS_FIRED=ABSENT_SEGMENT; TAA_RESULT_CATEGORY=MARKED_ABSENT; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL
- Cognos comparison: LEAVE TYPE can still MATCH ANNUAL while CMS-related Cognos fields disagree/blank. Any MISMATCH_FOUND holds output; COGNOS_BLANK alone is tracked, not automatically a mismatch.
- Category/hold/inclusion: MARKED_ABSENT; inclusion depends on comparison hold; with mismatch => FALSE
- Expected correction CSV: When eligible: 00,7000012,ABSENT,11/09/2026,,,,"TAA Anomaly: Attendance recorded on scheduled leave day",
- Communication: EMAIL_STAFF_CC_MANAGER (from R_6 Officer communication).
- Pass criteria: Boundary is inclusive; leave type evidence is not erased by anomaly verdict.
- Bug signature: 60 treated as allowed; switches leave type to ABSENT; applies normal lateness.

### BR-13 — Public-holiday OT2 day with no login

- Priority: Critical
- Rules/functions: OT-only attendance gate + R_5 no show + OT2 preservation + absent OT-to-SHIFT replace pair
- Employee/date: OPS; PF 7000013; Login 90013; NOM_DATE 11/09/2026
- ASPECT: P/H-LV structural row; OT2 11/09 23:00–12/09 07:00
- CMS: No punches; CMS coverage otherwise sufficient
- Cognos: DUTY1 entitlement; OT-2 blank; SIGNIN DURATION=00:00; SIGIN IN/OUT blank; may show U-ABSENT
- Config: Defaults
- Expected recomputation: Presence of OT2 routes day through attendance rules rather than leave exclusion. OT2=480m.
- Expected resolution: R_5 => ABSENT_NS_NC. OT2 is explicitly retired and replaced with SHIFT via a 10/11 pair in the correction output, original start/date/duration preserved on both rows.
- Expected TAA columns: TAA_OT2=480; TAA_VERDICT=NO_SHOW; TAA_ACTION=ABSENT_NS_NC; TAA_ACTIONS_FIRED=ABSENT_NS_NC, OT_TO_SHIFT; category=MARKED_ABSENT
- Cognos comparison: OT-2 blank is filled 08:00; zero/blank attendance fields treated as no-attendance placeholders; no false CMS mismatch when evidence is absent as claimed.
- Category/hold/inclusion: MARKED_ABSENT; hold only for real mismatches; include=TRUE if comparisons agree
- Expected correction CSV: 00,7000013,Absent NS/NC,11/09/2026,,,,"TAA Full Shift Absence NS/NC", | 10,7000013,OT2,11/09/2026,11/09/2026,23:00,08:00,"TAA Absent Day: original OT2 segment being replaced by SHIFT", | 11,7000013,SHIFT,11/09/2026,11/09/2026,23:00,08:00,"TAA Absent Day: OT2 segment converted to SHIFT",
- Communication: EMAIL_OPS
- Pass criteria: OT2 is evaluated, filled, and explicitly retired via a 10/11 pair (never a bare insert); never dropped because P/H-LV exists.
- Bug signature: Leave gate skips row; OT2 omitted/merged into OT1; conversion date becomes 12/09; OT2 left in ASPECT alongside a new SHIFT insert instead of being retired.

### BR-14 — Cross-midnight single swipe with sufficient CMS coverage

- Priority: Critical
- Rules/functions: R_6 one punch + cross-midnight schedule + sufficient-coverage distinction
- Employee/date: OFFICER_PLUS; PF 7000014; Login 90014; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 23:00–12/09 07:00
- CMS: One record where LoginDateTime=LogoutDateTime=11/09 23:08; export includes required day before/after
- Cognos: SIGIN IN=23:08; SIGIN OUT=23:08; SIGNIN DURATION=00:00
- Config: minAttendanceSpanMinutes=1
- Expected recomputation: Punch count/thin span is insufficient evidence, but file coverage is sufficient, so this is a real incomplete pair rather than a coverage hold.
- Expected resolution: R_6 => ABSENT_SEGMENT, not INSUFFICIENT_CMS_COVERAGE.
- Expected TAA columns: TAA_VERDICT=ABSENT; TAA_ACTION=ABSENT_SEGMENT; TAA_RESULT_CATEGORY=MARKED_ABSENT; hold determined by comparisons
- Cognos comparison: SIGNIN DURATION 00:00 vs recomputed 0 is NOT_COMPARABLE staffed-vs-span, not the real-span defect. Time fields can MATCH.
- Category/hold/inclusion: MARKED_ABSENT; include if no mismatch
- Expected correction CSV: 00,7000014,ABSENT,11/09/2026,,,,"TAA Incomplete Punch Pair Absence",
- Communication: EMAIL_STAFF_CC_MANAGER
- Pass criteria: Coverage state changes the branch; no cross-midnight false no-show.
- Bug signature: Held as insufficient coverage despite complete file; treated as present because in=out.

### BR-15 — Cognos LOGIN ID blank while schedule exists

- Priority: Critical
- Rules/functions: Missing CMS join-key forced hold + no auto-absence
- Employee/date: OPS; PF 7000015; LOGIN ID blank; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00
- CMS: A punch exists for an unlinked login but cannot be safely matched by name or ASPECT EMP_EXTRA_3
- Cognos: PF NO and name populated; LOGIN ID blank; report may claim absence
- Config: Defaults
- Expected recomputation: Schedule recomputes, but CMS join is impossible by authoritative key.
- Expected resolution: MANUAL_REVIEW_REQUIRED; never infer login ID or mark absent.
- Expected TAA columns: TAA_ACTION=MANUAL_REVIEW_REQUIRED; TAA_RESULT_CATEGORY=COGNOS_DATA_GAP; holdReason=MISSING_CMS_JOIN_KEY; TAA_CMS_IN/OUT blank
- Cognos comparison: CMS-dependent columns become NOT_COMPARABLE; schedule columns may still compare.
- Category/hold/inclusion: COGNOS_DATA_GAP; locked forced hold; include=FALSE
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: Name, PF, and EMP_EXTRA_3 cannot bypass missing login ID.
- Bug signature: Wrong employee punch joined; auto ABSENT_NS_NC; forced hold omitted.

### BR-16 — Night shift with one swipe and incomplete next-day CMS coverage

- Priority: Critical
- Rules/functions: Insufficient CMS coverage safety gate + cross-midnight file extent
- Employee/date: OPS; PF 7000016; Login 90016; NOM_DATE 11/09/2026
- ASPECT: SHIFT 11/09 23:00–12/09 07:00
- CMS: Only login 11/09 23:02; uploaded file ends 11/09 23:59 and lacks 12/09 coverage
- Cognos: May show no attendance or one swipe
- Config: required coverage before=1 day; after=1 day; search radius=4h
- Expected recomputation: Thin evidence plus incomplete coverage means absence cannot be trusted.
- Expected resolution: MANUAL_REVIEW_REQUIRED with INSUFFICIENT_CMS_COVERAGE, before R_5/R_6.
- Expected TAA columns: TAA_ACTION=MANUAL_REVIEW_REQUIRED; TAA_RESULT_CATEGORY=COGNOS_DATA_GAP; holdReason=INSUFFICIENT_CMS_COVERAGE
- Cognos comparison: CMS fields may be NOT_COMPARABLE; lack of evidence is not reported as confirmed disagreement.
- Category/hold/inclusion: COGNOS_DATA_GAP; forced hold; include=FALSE
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: Adding next-day file coverage with still only one swipe changes branch to R_6 absence; without it, row stays held.
- Bug signature: Auto-absence from truncated export; coverage check ignores calendar extent.

### BR-17 — Overlapping nursing and RLS reduce one physical hour only

- Priority: Critical
- Rules/functions: Removal interval union + effective end + net-hours integrity
- Employee/date: OPS; PF 7000017; Login 90017; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; NURSNG 14:00–15:00; RLS 14:30–15:00
- CMS: Login 07:00; Logout 14:00
- Cognos: SCH DURATION=07:00; SIGIN IN=07:00; SIGIN OUT=14:00
- Config: Defaults
- Expected recomputation: Union of removals is 14:00–15:00 = 60m, not 90m. Net=420m; effective end=14:00; nursing trace may be 60 but total removal is unioned.
- Expected resolution: Present; no early logout and no late logout.
- Expected TAA columns: TAA_SCH_HOURS_RECOMPUTED=420; TAA_EFFECTIVE_END=14:00; TAA_EARLY_MIN=0; TAA_ACTION=NO_ACTION; category=NO_ACTION_REQUIRED
- Cognos comparison: SCH DURATION 07:00 MATCH; punches MATCH.
- Category/hold/inclusion: NO_ACTION_REQUIRED; no hold; include=TRUE with no correction rows
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: Raw additions 480 - unioned removal 60 = 420; trace totals reconcile.
- Bug signature: Net=390; effective end=13:30; false late logout/absence.

### BR-18 — Duration-only release mixed with timestamped trailing release

- Priority: Critical
- Rules/functions: Ambiguous overlap safety hold + duration trust order
- Employee/date: OPS; PF 7000018; Login 90018; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; RLS 14:00–15:00; RLS-2H with DURATION=120 but no timestamps
- CMS: Login 07:00; Logout 14:00
- Cognos: Any otherwise plausible schedule values
- Config: Defaults
- Expected recomputation: Duration-only removal has no interval, so overlap with 14:00–15:00 cannot be proven or excluded. Guessing would risk subtracting 2h or 3h.
- Expected resolution: Hold AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION. Do not auto-correct or label the duration-only row INVALID_ASPECT_DATETIME merely because timestamps are absent.
- Contract (resolved 2026-09-11): TAA_ACTION reports the business action the rules calculated; holdReason and includeInOutput report workflow safety separately. This hold is discovered only AFTER the normal attendance path already ran (no lateness fired here), so it must not overwrite that computed action — unlike a PRE-calculation failure (e.g. MISSING_CMS_JOIN_KEY, INVALID_ASPECT_DATETIME), where no trustworthy action exists at all and MANUAL_REVIEW_REQUIRED is correct. See reg-51/reg-53/reg-56 in regressionSuite.ts, which assert NO_ACTION for this same class of post-calculation schedule-integrity hold.
- Expected TAA columns: TAA_ACTION=NO_ACTION (no attendance rule fired; the hold is carried by holdReason/includeInOutput, not by TAA_ACTION); holdReason=AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION; category=COGNOS_DATA_GAP or held presentation
- Cognos comparison: Comparisons are secondary; forced integrity hold blocks output even if Cognos happens to agree.
- Category/hold/inclusion: Forced hold; include=FALSE
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: Specific ambiguity reason is surfaced; no invented effective end.
- Bug signature: Subtracts 180m; ignores duration-only segment; incorrectly uses INVALID_ASPECT_DATETIME.

### BR-19 — Mid-shift release must not be moved to shift end

- Priority: Critical
- Rules/functions: Removal position classification + payroll-safe hold
- Employee/date: OFFICER_PLUS; PF 7000019; Login 90019; NOM_DATE 11/09/2026
- ASPECT: SHIFT 07:00–15:00; RLS 10:00–11:00
- CMS: Login 07:00; Logout 15:00
- Cognos: SCH DURATION=07:00 or 08:00; exact value should not authorize guessing
- Config: releaseProximityToleranceMinutes=2
- Expected recomputation: RLS lies in the middle, touching neither start nor end. It can reduce net paid minutes but cannot safely move an attendance anchor.
- Expected resolution: NO_ACTION (no lateness/early-departure rule fires); hold MID_SHIFT_REMOVAL_SEGMENT flags the row for review, per the TAA_ACTION/holdReason contract (see BR-18).
- Expected TAA columns: TAA_ACTION=NO_ACTION; holdReason=MID_SHIFT_REMOVAL_SEGMENT; include=FALSE; generatedCorrections empty
- Cognos comparison: Mismatches may also exist, but hold reason must identify the source schedule ambiguity.
- Category/hold/inclusion: Forced hold; include=FALSE
- Expected correction CSV: Header only.
- Communication: NA
- Pass criteria: Does not fabricate effective end 14:00 or effective start 08:00.
- Bug signature: Treats RLS as trailing and marks 60m late logout; silently subtracts from wrong edge.

### BR-20 — Mixed leave and worked shift with a valid punch pair

- Priority: Critical
- Rules/functions: Leave taxonomy independent of hours role + mixed leave/work review hold + reviewer override
- Employee/date: OPS; PF 7000020; Login 90020; NOM_DATE 11/09/2026
- ASPECT: ANNUAL structural leave row; SHIFT 07:00–15:00
- CMS: Login 07:00; Logout 15:00
- Cognos: LEAVE TYPE=ANNUAL; DUTY1=07:00-15:00; SIGNIN data populated
- Config: ANNUAL in leaveSegmentCodes and nonWorkingDaySegmentCodes
- Expected recomputation: Worked addition exists, so normal calculations can run; leave evidence also exists. These states conflict and require human confirmation.
- Expected resolution: PRESENT/NO_ACTION from attendance math, but hold MIXED_LEAVE_AND_WORK_SEGMENTS. This hold is reviewer-releasable, unlike forced data-integrity holds.
- Expected TAA columns: TAA_VERDICT=PRESENT; TAA_ACTION=NO_ACTION; TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; holdReason=MIXED_LEAVE_AND_WORK_SEGMENTS; include=FALSE initially
- Cognos comparison: LEAVE TYPE may MATCH while other columns also match; hold exists independently of column mismatch.
- Category/hold/inclusion: NO_ACTION_REQUIRED plus held; reviewer may explicitly include, but there are no corrections unless another rule fired
- Expected correction CSV: Header only in this exact input. Approval changes inclusion state/audit, not invent a correction.
- Communication: NA
- Pass criteria: Both work and leave evidence remain visible; reviewer override is audited.
- Bug signature: Leave gate silently excludes worked shift; leave code ignored; forced hold cannot be reviewed; approval creates fake row.

## 20 application and algorithm scenarios

### AL-01 — UTF-16 tab-delimited Cognos parser preserves multiline REMARK

- Priority: Critical
- Rules/functions: Cognos parser; original-column preservation
- Employee/date: One row with PF 007001 and a two-line REMARK
- ASPECT: Matching simple SHIFT
- CMS: Matching punches
- Cognos: UTF-16 LE bytes; real tabs; REMARK contains comma, quote and embedded newline
- Config: Defaults
- Expected recomputation: Parser returns exactly one logical record with all 18 source headers, including misspellings SIGIN IN/SIGIN OUT.
- Expected resolution: Reconciliation runs once; multiline text stays in originalCognos.REMARK.
- Expected TAA columns: All derived TAA fields append after the 18 originals.
- Cognos comparison: No column shift. Original values compare from the correct headers.
- Category/hold/inclusion: Normal based on attendance
- Expected correction CSV: Annotated output quotes REMARK correctly. ASPECT correction output is independent.
- Communication: Based only on rule result
- Pass criteria: Round-trip read of annotated file reproduces the exact 18 original cell values except permitted fill-if-blank fields.
- Bug signature: Two rows created; columns shift after newline; UTF-16 mojibake; SIGIN fields missing.

### AL-02 — CMS duplicate header names use full timestamp columns by position

- Priority: Critical
- Rules/functions: CMS parser; cross-midnight datetime authority
- Employee/date: Login 90022; night shift 23:00–07:00
- ASPECT: SHIFT 11/09 23:00–12/09 07:00
- CMS: Columns 3/4 contain time-only 23:05 and 07:02; duplicate columns 5/6 contain full 11/09 23:05 and 12/09 07:02
- Cognos: SIGIN IN=23:05; SIGIN OUT=07:02
- Config: Defaults
- Expected recomputation: LoginDateTime and LogoutDateTime come from positional full-datetime columns 5/6.
- Expected resolution: Punch is attributed to 11/09 schedule and spans midnight.
- Expected TAA columns: TAA_CMS_IN includes 11/09; TAA_CMS_OUT includes 12/09; no false early logout.
- Cognos comparison: Time-of-day may match; full TAA timestamps resolve the date ambiguity.
- Category/hold/inclusion: NO_ACTION_REQUIRED if within thresholds
- Expected correction CSV: Header only
- Communication: NA
- Pass criteria: Logout is 12/09 07:02, never 11/09 07:02 or a negative session.
- Bug signature: Uses first duplicate header occurrence; negative duration; false no-show.

### AL-03 — Whitespace-padded employee identifiers join without losing leading zeroes

- Priority: Critical
- Rules/functions: PF/EMP_ID normalization; identity join
- Employee/date: Cognos PF='007001'; ASPECT EMP_ID='  007001   '; Login=90023
- ASPECT: Padded EMP_ID, valid SHIFT
- CMS: Valid pair for 90023
- Cognos: PF NO stored as text '007001'
- Config: Defaults
- Expected recomputation: Trim whitespace only. Do not numeric-cast or drop leading zeroes.
- Expected resolution: Schedule and identity resolve to same employee.
- Expected TAA columns: TAA_USERNAME and tier come from matched identity; no data gap.
- Cognos comparison: Normal comparisons
- Category/hold/inclusion: Attendance-derived, not COGNOS_DATA_GAP
- Expected correction CSV: ID field remains 007001 in any correction
- Communication: Correct employee only
- Pass criteria: Exactly one joined row and no collision with employee 7001.
- Bug signature: ID becomes 7001; schedule missing; wrong identity/email.

### AL-04 — Unpadded NOM_DATE and START_DATE normalize consistently

- Priority: High
- Rules/functions: Date-key normalization; physical SegmentDate normalization
- Employee/date: PF 7000024
- ASPECT: NOM_DATE='1/9/2026'; START_DATE='1/9/2026'; SHIFT 01/09 07:00–15:00
- CMS: 01/09 07:06–15:00
- Cognos: SIGN IN DATE='01/09/2026'
- Config: Defaults
- Expected recomputation: Both dates normalize to 01/09/2026 before grouping/joining.
- Expected resolution: Late 6m rule can fire normally.
- Expected TAA columns: No COGNOS_ASPECT_DATE_MISMATCH
- Cognos comparison: Correct row compared
- Category/hold/inclusion: LATE_AND_COVER_ADDED
- Expected correction CSV: Every nominateDate/SegmentDate is zero-padded DD/MM/YYYY
- Communication: NA
- Pass criteria: No raw 1/9/2026 reaches output.
- Bug signature: False data gap; mixed date formats in CSV.

### AL-05 — Headcount mapping gate excludes declared no-shows from CMS denominator

- Priority: Critical
- Rules/functions: Upload validation; assessHeadcountMapping
- Employee/date: 10 Cognos staff: 4 claim attendance, 6 have blank punches/00:00 placeholders
- ASPECT: All 10 map to ASPECT
- CMS: 3 of the 4 attendance-claiming login IDs map; none of the 6 declared no-shows map
- Cognos: 6 rows have blank SIGIN IN/OUT and structural SIGNIN DURATION 00:00; 4 have at least one attendance signal
- Config: validateUploadedHeadcount=true; minimum=70%
- Expected recomputation: Cognos→CMS denominator is 4, mapped=3 => 75%, not 3/10=30%. Critical missing count=1.
- Expected resolution: Calculate is allowed at 75% (assuming ASPECT mapping >=70), while the one missing attendance claimant remains visible.
- Expected TAA columns: Upload gate summary reports 75% and count 1
- Cognos comparison: Per-row handling occurs only after gate
- Category/hold/inclusion: N/A upload gate
- Expected correction CSV: No output before Calculate
- Communication: NA
- Pass criteria: Declared no-shows do not depress denominator; SIGIN OUT-only and duration-only claims count as attendance claims.
- Bug signature: Reports 30%; ignores SIGIN OUT-only claimant; gate blocks incorrectly.

### AL-06 — One punch near two adjacent schedules is attributed once

- Priority: Critical
- Rules/functions: Global punch attribution; no double claim; tie cascade
- Employee/date: Same Login 90026 has day shift 07:00–15:00 and next schedule 19:00–03:00
- ASPECT: Two real scheduled windows for same login on adjacent employee-days
- CMS: Punch 18:57 plus valid overnight logout 03:02; day-shift pair already ends 15:00
- Cognos: Two rows
- Config: search radius=4h
- Expected recomputation: 18:57 is inside overnight raw window and near day window tail; real in-window fit and distance assign it to overnight only.
- Expected resolution: Night row present/early arrival; day row keeps its own punches. No punch appears in both details.punches arrays.
- Expected TAA columns: Each CMS record has one owner; no false day late logout and no night no-show
- Cognos comparison: Both rows compare independently
- Category/hold/inclusion: Per-row normal
- Expected correction CSV: No duplicate corrections from shared punch
- Communication: NA
- Pass criteria: Sum of attributed punch IDs across rows contains no duplicates.
- Bug signature: 18:57 claimed twice; earlier row steals next shift login.

### AL-07 — Irreducible punch-attribution tie is held

- Priority: Critical
- Rules/functions: Ambiguous attribution safety hold
- Employee/date: Same login mistakenly scheduled in two identical real windows
- ASPECT: Two Cognos rows/windows both 11/09 07:00–15:00 for login 90027
- CMS: Single pair 07:05–15:00
- Cognos: Both claim attendance
- Config: Defaults
- Expected recomputation: Both candidates have equal real-window priority, start, distance and fit.
- Expected resolution: Do not arbitrarily assign. Affected thin-evidence row(s) surface AMBIGUOUS_PUNCH_ATTRIBUTION or CONTESTED_SINGLE_PUNCH and are held.
- Expected TAA columns: hold reason records ambiguity; no automatic absence
- Cognos comparison: CMS-dependent comparisons not trusted
- Category/hold/inclusion: COGNOS_DATA_GAP/held
- Expected correction CSV: Header only for held rows
- Communication: NA
- Pass criteria: Deterministic hold rather than array-order winner.
- Bug signature: First row wins silently; second marked absent.

### AL-08 — Bare date timestamp means midnight and cross-midnight stop rolls correctly

- Priority: High
- Rules/functions: Datetime parser; midnight semantics
- Employee/date: PF 7000028
- ASPECT: SHIFT START_MOMENT='11/09/2026 20:00'; STOP_MOMENT='12/09/2026' (bare date midnight)
- CMS: 20:00–00:00
- Cognos: DUTY1=20:00-00:00
- Config: Defaults
- Expected recomputation: Bare date parses as 12/09 00:00, not null. Duration=240m.
- Expected resolution: Normal attendance evaluation
- Expected TAA columns: TAA_EFFECTIVE_END=00:00 with full date in trace; schedule=240
- Cognos comparison: DUTY1 matches across midnight
- Category/hold/inclusion: NO_ACTION_REQUIRED
- Expected correction CSV: Any physical SegmentDate at midnight is 12/09/2026
- Communication: NA
- Pass criteria: No 24-hour or zero-hour distortion.
- Bug signature: Bare date treated missing; invalid datetime hold; stop rolled to 13/09.

### AL-09 — Incomplete ASPECT timestamp locks the row

- Priority: Critical
- Rules/functions: Input integrity; INVALID_ASPECT_DATETIME
- Employee/date: PF 7000029
- ASPECT: SHIFT has START_MOMENT 11/09 07:00 but blank STOP_MOMENT and DURATION
- CMS: Valid 07:00–15:00 pair
- Cognos: Looks perfectly normal
- Config: Defaults
- Expected recomputation: Schedule anchors/duration cannot be trusted.
- Expected resolution: Forced MANUAL_REVIEW_REQUIRED before attendance rules.
- Expected TAA columns: holdReason=INVALID_ASPECT_DATETIME; TAA_ACTION=MANUAL_REVIEW_REQUIRED
- Cognos comparison: Cognos appearance cannot clear source defect
- Category/hold/inclusion: COGNOS_DATA_GAP/locked hold; include=FALSE
- Expected correction CSV: Header only
- Communication: NA
- Pass criteria: Reviewer cannot release forced hold through normal inclusion toggle.
- Bug signature: Invents 8h/default end; marks present or absent.

### AL-10 — Byte-identical ASPECT duplicate does not double paid minutes

- Priority: Critical
- Rules/functions: Segment de-duplication; hours formula
- Employee/date: PF 7000030
- ASPECT: Two identical SHIFT rows, same PRI_INDEX/content, both 07:00–15:00
- CMS: 07:00–15:00
- Cognos: SCH DURATION=08:00
- Config: Defaults
- Expected recomputation: Logical schedule remains 480m, not 960m.
- Expected resolution: Present; no correction
- Expected TAA columns: TAA_SCH_HOURS_RECOMPUTED=480
- Cognos comparison: SCH DURATION MATCH
- Category/hold/inclusion: NO_ACTION_REQUIRED
- Expected correction CSV: Header only
- Communication: NA
- Pass criteria: Duplicate warning/handling is deterministic and no hours double-count.
- Bug signature: TAA schedule=16:00; false mismatch.

### AL-11 — Comparison tolerance boundary is inclusive at one minute

- Priority: High
- Rules/functions: Column comparison tolerance
- Employee/date: PF 7000031
- ASPECT: SHIFT 07:00–15:00; punches 07:01–15:00
- CMS: Authoritative 07:01 and 15:00
- Cognos: Subcase A SIGIN IN=07:00; subcase B SIGIN IN=06:59 while recompute is 07:01
- Config: comparisonToleranceMinutes=1
- Expected recomputation: Subcase A difference=1 => MATCH. Subcase B circular clock difference=2 => MISMATCH.
- Expected resolution: Attendance action is independent of comparison result.
- Expected TAA columns: A mismatch count unchanged; B mismatch count increments and includes SIGIN IN
- Cognos comparison: Exactly 1 is accepted; 2 is rejected
- Category/hold/inclusion: A no mismatch hold; B hold=MISMATCH_FOUND
- Expected correction CSV: B corrections excluded until approval
- Communication: Attendance-driven
- Pass criteria: No off-by-one and time-of-day comparison handles midnight circularly.
- Bug signature: 1 mismatches or 2 matches.

### AL-12 — Fill blank OT columns only and never overwrite populated Cognos

- Priority: Critical
- Rules/functions: cognosBlankFillColumns; OT1/OT2 distinction
- Employee/date: PF 7000032
- ASPECT: OT1=60m; OT2=120m
- CMS: Valid pair
- Cognos: OT1 blank; OT-2='01:30' populated but wrong
- Config: blank-fill columns OT1 and OT-2
- Expected recomputation: Recompute OT1=01:00; OT2=02:00.
- Expected resolution: Annotated original OT1 cell is filled 01:00 and listed in TAA_FILLED_COLUMNS. Populated OT-2 stays 01:30 and compares MISMATCH against 02:00.
- Expected TAA columns: TAA_OT1=60; TAA_OT2=120; TAA_FILLED_COLUMNS=OT1; mismatch columns includes OT-2
- Cognos comparison: OT1=COGNOS_BLANK/fill; OT-2=MISMATCH
- Category/hold/inclusion: hold=MISMATCH_FOUND
- Expected correction CSV: Unrelated correction rows held until approval
- Communication: Rule-driven
- Pass criteria: Original populated OT-2 is byte/value preserved.
- Bug signature: Overwrites OT-2 with 02:00; fails to fill OT1; merges OT totals.

### AL-13 — Dynamic Cognos sentinel equals negative leave hours

- Priority: High
- Rules/functions: Sentinel detection; no-attendance placeholders
- Employee/date: PF 7000033 on 10-hour leave
- ASPECT: Leave code with evidenced 600m entitlement
- CMS: No punches
- Cognos: LEAVE HR=10:00; LATE START=-600; LEFT EARLY=-600; SIGIN IN/OUT blank
- Config: cognosSentinelDetectionMode=both
- Expected recomputation: -600 equals negative leave minutes even though not in fixed [-480,-540] list.
- Expected resolution: Both variances are NOT_COMPARABLE sentinels, not real 600m late/early values.
- Expected TAA columns: TAA_MISMATCH_COLUMNS excludes LATE START and LEFT EARLY solely for sentinels
- Cognos comparison: NOT_COMPARABLE with sentinel note
- Category/hold/inclusion: Leave-day result
- Expected correction CSV: No false penalties
- Communication: NA
- Pass criteria: Structural rule handles any leave duration.
- Bug signature: Only fixed list checked; 600m absence action created.

### AL-14 — Cognos 00:00 duration distinguishes placeholder from calculation failure

- Priority: Critical
- Rules/functions: SIGNIN DURATION exception logic
- Employee/date: Two subcases, same 07:00–15:00 shift
- ASPECT: Valid SHIFT
- CMS: A: 07:09–15:10 real 481m span. B: no CMS and Cognos punches blank.
- Cognos: Both SIGNIN DURATION=00:00. A also has SIGIN IN=07:09 and SIGIN OUT=15:10. B has both blank.
- Config: Defaults
- Expected recomputation: A: 0 vs 481 with real Cognos timestamps => genuine MISMATCH. B: structural no-attendance placeholder => NOT_COMPARABLE.
- Expected resolution: A held MISMATCH_FOUND; B proceeds to no-login rule based on CMS coverage.
- Expected TAA columns: A mismatch includes SIGNIN DURATION with calculation-failure note. B does not.
- Cognos comparison: Same text value, different status based on supporting evidence
- Category/hold/inclusion: A held; B attendance-rule category
- Expected correction CSV: A corrections gated; B no-show correction only if rule fires
- Communication: B per R_5
- Pass criteria: Context, not string alone, determines meaning.
- Bug signature: Both downgraded; both mismatched; A defect hidden.

### AL-15 — Specific leave code wins over generic container and mapping is explicit

- Priority: High
- Rules/functions: Leave selection; exact/mapped basis
- Employee/date: PF 7000035
- ASPECT: LEAVE + ANNUAL on same non-work day
- CMS: No punches
- Cognos: LEAVE TYPE=Annual Leave (different spelling)
- Config: generic container=LEAVE; mapping Annual Leave -> ANNUAL
- Expected recomputation: Specific identified leave is ANNUAL; mapping connects Cognos value.
- Expected resolution: Leave excluded; recomputed leave type ANNUAL.
- Expected TAA columns: TAA_LEAVE_TYPE_RECOMPUTED=ANNUAL; STATUS=MATCH; BASIS=MAPPED
- Cognos comparison: No false LEAVE-vs-Annual Leave mismatch
- Category/hold/inclusion: NO_ACTION_REQUIRED
- Expected correction CSV: Header only
- Communication: NA
- Pass criteria: Removing the mapping changes status to MISMATCH; generic LEAVE never wins while ANNUAL exists.
- Bug signature: Picks LEAVE; claims EXACT; mapping ignored.

### AL-16 — Schedule block gap at threshold remains split

- Priority: High
- Rules/functions: perBlockGapThreshold strict boundary; schedule-shape mapping
- Employee/date: PF 7000036
- ASPECT: Subcase A SHIFT 07:00–11:00 and 11:59–15:59 (59m gap). Subcase B second starts 12:00 (60m gap).
- CMS: First-to-last attendance covers both
- Cognos: A expects one DUTY1; B expects DUTY1 and DUTY-2
- Config: perBlockGapThresholdMinutes=60
- Expected recomputation: A gap <60 merges. B gap exactly 60 does not merge.
- Expected resolution: Attendance verdict unchanged; only comparison blocks differ.
- Expected TAA columns: A duty1 07:00–15:59; B duty1 07:00–11:00 and duty2 12:00–16:00
- Cognos comparison: Appropriate Cognos columns MATCH per subcase
- Category/hold/inclusion: NO_ACTION_REQUIRED
- Expected correction CSV: Header only
- Communication: NA
- Pass criteria: Uses strict less-than, not less-than-or-equal.
- Bug signature: Both merge; both split; attendance penalties start evaluating each block.

### AL-17 — ASPECT CSV writer enforces exact wire format and escaping

- Priority: Critical
- Rules/functions: Correction CSV serialization; de-duplication
- Employee/date: Synthetic correction ID 7000037
- ASPECT: N/A
- CMS: N/A
- Cognos: N/A
- Config: aspectNormalActionCode=00
- Expected recomputation: Create one correction with SegmentCode='Absent NS/NC' and Memo='Reason, says "review"'. Add an exact duplicate.
- Expected resolution: Writer emits one data row after de-duplication.
- Expected TAA columns: N/A
- Cognos comparison: N/A
- Category/hold/inclusion: N/A writer test
- Expected correction CSV: Header exactly Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo, and ends with comma. SegmentCode with spaces quoted. Memo always quoted and inner quotes doubled. Code stays 00. Blank absence time/duration remain blank.
- Communication: N/A
- Pass criteria: Every line, including header/data, has final comma; duplicate collapses; Segmentduration elsewhere is HH:MM.
- Bug signature: Code becomes 0; missing trailing comma; Memo unquoted; duplicate row; 60 instead of 01:00.

### AL-18 — Annotated Cognos output blocks spreadsheet formula injection without corrupting ASPECT CSV

- Priority: Critical
- Rules/functions: Annotated export escaping; writer separation
- Employee/date: NAME='=HYPERLINK("bad")'; PF valid
- ASPECT: Correction Memo begins '=review'
- CMS: Valid
- Cognos: A source text cell begins =, +, -, or @
- Config: Defaults
- Expected recomputation: Annotated Cognos escapeCell prefixes apostrophe to dangerous leading characters. ASPECT writer does not add apostrophe because that would corrupt the machine import; Memo is quoted instead.
- Expected resolution: Safe human-opened report and exact machine CSV semantics.
- Expected TAA columns: Original source text remains recognizable; marker and derived fields append
- Cognos comparison: No execution on open
- Category/hold/inclusion: Attendance-derived
- Expected correction CSV: Annotated cell starts apostrophe. ASPECT Memo is "=review", not "'=review".
- Communication: No effect
- Pass criteria: Security behavior differs intentionally by output type.
- Bug signature: Excel executes formula; or apostrophe leaks into ASPECT upload.

### AL-19 — Mismatch approval gates correction output and records override

- Priority: Critical
- Rules/functions: Review workflow; forced vs releasable holds; annotated audit
- Employee/date: PF 7000039 with a valid 6m late correction
- ASPECT: SHIFT 07:00–15:00 + future workday
- CMS: 07:06–15:00
- Cognos: SIGIN IN incorrectly 07:20 so comparison mismatches
- Config: Defaults
- Expected recomputation: Attendance says 6m late; comparison says Cognos mismatch.
- Expected resolution: Row correction exists internally but includeInOutput=FALSE and is excluded from ASPECT file until explicit user approval. Approval sets decision source=user and verification/audit metadata where applicable.
- Expected TAA columns: holdReason=MISMATCH_FOUND; TAA_INCLUDED_IN_OUTPUT changes FALSE->TRUE only after approval; mismatch details remain
- Cognos comparison: Mismatch is never erased by approval
- Category/hold/inclusion: LATE_AND_COVER_ADDED plus Held tab
- Expected correction CSV: Before: header only. After approval: LATE + COVER rows.
- Communication: Email eligibility follows approved/eligible workflow; no premature draft
- Pass criteria: Approval releases only releasable hold. Repeat with INVALID_ASPECT_DATETIME and confirm approval cannot release it.
- Bug signature: Correction exported immediately; approval clears evidence; forced hold released.

### AL-20 — Cover fallback is explicit and preserves ownership versus physical date

- Priority: Critical
- Rules/functions: Cover placement fallback; nominateDate/SegmentDate contract; fallback note
- Employee/date: PF 7000040; incident 11/09/2026 requires 8m cover
- ASPECT: Only incident SHIFT 07:00–15:00 is uploaded; no future SHIFT/OT
- CMS: Late 8m with complete evidence
- Cognos: Matches except late variance
- Config: Subcase A fallback=nextWeekMonday default time 08:00. Subcase B fallback=sameDay.
- Expected recomputation: No future working day exists in uploaded ASPECT scope. A targets Monday 14/09 08:00. B anchors after last incident-day segment at 15:00.
- Expected resolution: Cover is generated with deterministic fallback note; never presented as a normal schedule-backed placement.
- Expected TAA columns: TAA_COVER_FALLBACK_NOTE populated with chosen option; action LATE_AND_COVER
- Cognos comparison: Fallback does not change original Cognos columns
- Category/hold/inclusion: LATE_AND_COVER_ADDED; inclusion per comparisons
- Expected correction CSV: A nominateDate=14/09/2026, SegmentDate=14/09/2026, start=08:00, duration=00:08. B nominateDate=11/09/2026, SegmentDate=11/09/2026, start=15:00. Memo names fallback.
- Communication: NA
- Pass criteria: Changing fallback option changes only documented placement; no silent next-day guess.
- Bug signature: Cover disappears; uses 12/09 regardless config; memo loses fallback note; nominateDate stays incident date in A.

