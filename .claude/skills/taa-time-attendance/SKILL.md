---
name: taa-time-attendance
description: Contact-centre time & attendance reconciliation expertise for the TAA project — CMS punch-event model, the mandatory time-window (not date-keyed) join to avoid false absences, Cognos discrepancy-report quirks and column semantics, the validated variance formulas, the effective-vs-raw shift window, and the authoritative Rules to be taken.xlsx taxonomy. Use whenever reconciling ASPECT schedules against CMS logins/Cognos discrepancy reports, computing LATE START / LEFT EARLY / late / early-leave / absence verdicts, joining CMS_Login_logout.csv, parsing Cognos_DescrepencyReport.csv, applying attendance rules by role tier, or deciding what the two output files (ASPECT correction file vs annotated Cognos report) must contain.
---

# Contact-centre T&A reconciliation — TAA project

**This is a payroll system.** Every rule below is a pay error if wrong: false absence = unpaid worked shift; false "left early" = wrongful deduction from someone present; dropped overtime = unpaid premium-rate work. Always resolve ambiguity toward *not* costing the employee money without evidence.

## The two outputs — never conflate them
1. **ASPECT correction file** — segments to upload so ASPECT matches ground truth (format/trailing-comma rule in `aspect-workforce-management` skill).
2. **Annotated Cognos report** — every original Cognos row reproduced **byte-identical**, plus appended columns with recomputed values and a flag+reason per disagreement. Must be visibly a derived analysis: distinct filename (e.g. `Cognos_Annotated_<date>`), a banner/marker column on every row. **Changes nothing automatically** — Cognos is management's trusted report; the tool never edits it, only raises exceptions against it (config-driven which disagreements are worth flagging).

## Cognos file — parsing quirks
- `encoding='utf-16'`, `delimiter='\t'`. 502 clean rows, dated 27/08/2026.
- Contains pasted email threads inside quoted fields — use a real CSV/TSV reader, never naive line-splitting.
- 18 columns, **typos are in the real file, keep them verbatim**: `SIGN IN DATE, SECTION, PF NO, NAME, LOGIN ID, DUTY1, OT1, DUTY-2, OT-2, SCH DURATION, SIGNIN DURATION, SIGIN IN, SIGIN OUT, LATE START, LEFT EARLY, LEAVE TYPE, LEAVE HR, REMARK` (`SIGIN IN`/`SIGIN OUT`, not `SIGN`).
- `SCH DURATION` is `H:M` text (e.g. `8:27` = 507 min).
- Join keys: `PF NO` → ASPECT `EMP_ID` (trim padding); `LOGIN ID` → CMS `Login ID`.

### DUTY1 / DUTY-2 / OT1 / OT-2 semantics
- `DUTY1` = the shift. **When a staff member has two shifts, the second is in `DUTY-2`** (user-confirmed) — this is Cognos's equivalent of an ASPECT second SHIFT segment.
- `DUTY1` populated on 500/502; `DUTY-2` on 50 (10%); **`OT1`/`OT-2` populated on 0 rows — overtime never arrives from Cognos**, must always be sourced from ASPECT OT1/OT2 segments before evaluation.
- `DUTY-2` length distribution: 60min×36, 120×10, 90×2, 30×2. Gap from DUTY1 end: 0min×16, 60min×34 — **no other gap value occurs**.
- 23/50 second-shifts are entirely cancelled by a release covering the identical window (e.g. `DUTY-2 16:00–17:00` + `RLS 16:00–17:00` → nets to zero) — these are Rule #8 cases (adjust OT duration by RLS, no separate action).

### REMARK field grammar
Codes: `RLS:`, `UN_RLS:`, `NURSNG:`, `COVER:`, `LATE:` (counts across 502 rows: COVER 125, RLS 47, LATE 24, NURSNG 16, UN_RLS 9).
Form: `CODE:HH:MM - HH:MM( ±N Minutes) : <free text>`, several concatenated with no separator. Free-text tags: `Auto Modify`, `Auto-break-update`, `OT release`, `RTM`, `Exceed break For <date>`, plus whole pasted email threads.
**The `( ±N Minutes)` figure is already net of any COVER in the same row — do not subtract COVER twice.**

## Attendance evaluation model — whole-day span, not per block
Evidence: agents work straight through gaps rather than clocking out/in between blocks — *Said ElDib*, `DUTY1 07:00–15:00` + `DUTY-2 16:00–17:00`, logged in **07:04**, out **16:07**: one continuous presence spanning the 15:00–16:00 gap. Every observed gap ≤60 min.
Per-block evaluation must exist as a **config option** with a configurable gap threshold to flag genuinely far-apart shifts for per-block treatment — no such case exists in the sample, this path is **untested**.

## Validated formulas (±1 min against real data)
```
Cognos's own (uncorrected) formulas:
LATE START = rawScheduledStart − actualFirstLogin        (negative ⇒ late)
LEFT EARLY = actualLastLogout − endOfLastScheduledBlock   (DUTY-2/OT-2 end if present, else DUTY1 end)
```
Anchoring `LEFT EARLY` on DUTY1's end instead of the true last block produces a systematic **−120 min** error — always anchor on the **second/last** scheduled block.

## Defect 1 — Cognos ignores its own release adjustment (41/502 rows, 8.2%, false "left early")
Cognos measures against the **raw** window, not the release-adjusted one. Correct formulas:
```
effectiveEnd    = endOfLastScheduledBlock − trailing release/nursing
effectiveStart  = rawScheduledStart + leading release      (not observed in sample — untested branch)
lateMinutes       = actualFirstLogin − effectiveStart       (>0 ⇒ late)
earlyLeaveMinutes = effectiveEnd − actualLastLogout          (>0 ⇒ left early)
```
Releases always carve from the **back** of the shift (4/4 co-occurrences: `release.stop == shift.stop`). Zero front, zero mid-shift observed.

Confirmed cases (must produce **no action**, not Cognos's flagged variance):
- Eman Eltayeb: 07:00–15:00, NURSNG 14:00–15:00, out 14:13 → Cognos says `−47`; truth: 13 min **past** effective end, no action.
- Minas Alabbas: 09:00–17:00, NURSNG 16:00–17:00, out 16:00 exactly → Cognos says `−60`; truth: zero variance.
- Aya Sayed Rabiee, Mohamed Hassan Ibrahim, Ahmed Rashad: same pattern via RLS on DUTY-2, each falsely `−60`.

## Defect 2 — date-keyed CMS join falsely marks night-shift staff ABSENT (most damaging bug)
CMS rows are **discrete punch events, not sessions**: each row's login/logout timestamps differ by ≤6 sec, roughly 2 punches/day (near start, near end).
The legacy join filters `CMS.Date = nominateDate`. For a shift crossing midnight, the closing punch lands on the **next** calendar date and is invisible to a date-keyed join.

Real consequences:
| PF | Shift | In | Out | Cognos LEFT EARLY | Verdict given |
|---|---|---|---|---|---|
| 4507957 | 23:00–07:00 | 23:08 | 23:08 | −472 | **U-ABSENT** (wrong) |
| 90135621 | 19:00–03:00 | 18:57 | 18:57 | −503 | **U-ABSENT** (wrong — arrived 3 min early) |

34/502 rows (6.8%) are cross-midnight and structurally exposed. **Required fix — join by time window, never by calendar date:**
```
punches = CMS rows where punchDateTime ∈ [shiftStart − grace, shiftEnd + grace]   // grace is a config param, open item
actualFirstLogin = min(punches);  actualLastLogout = max(punches)
```
Cognos itself is inconsistent on this (`UAE07437` 22:59→06:09 captured correctly for one night shift, missed for others) — reason enough to always recompute from raw CMS instead of trusting the report.

## CMS file (`CMS_Login_logout.csv`) — layout
Line 1 title, line 2 `Agent:,<name>_<id>`, line 3 header, then data rows. Dates `DD/MM/YYYY`.
6 columns with **duplicate labels**: `Date, Login ID, Login Time, Logout Time, Login Time, Logout Time` — cols 3–4 are `HH:MM` time-only, **cols 5–6 are full datetime `DD/MM/YYYY HH:MM:SS` — use cols 5–6**, never the time-only pair, or cross-midnight punches lose their date.

## Role tier (needed before applying rules — see tier table below)
Keyword-scan `EMP_SORT_NAME`/`EMP_SHORT_NAME` from **`ASPECT_ExtraFiled2.csv`** (the identity master, 2,199 unique employees — not `ASPECT_ExtraFiled.csv`, superseded), case-insensitive, same technique as `HasFlexCode`. Hits: `OFCR` 51, `ANALYST` 50, `OFFICER` 24, `SPECIALIST` 5, `COORDINATOR` 4, `SUPERVISOR` 1. **~94% (2,064/2,199) match nothing → default OPS/CSR/Agent tier.**
**Never use Cognos `SECTION` for tier** — it's a department name, casing/abbreviations inconsistent (`ES-SMB OFCR` vs ASPECT's `OFFICER`), disagrees with ASPECT on 36 employees. Full keyword-scan detail lives in `segment-code-classification` skill.

## Authoritative rules — `Rules to be taken.xlsx` (Rules.txt is DEPRECATED, do not implement it)
Two tiers: **OPS** (CSR/Agent, ~91%) and **Officer/Coordinator/Analyst/Specialist**.

| # | Type | Tier | Duration | Action | Communication |
|---|---|---|---|---|---|
| 1 | Late Login | OPS | 6–60 min | Late + cover next day | NA |
| | | OPS | 61+ min | Absent | Email OPS |
| | | Officer+ | 11–60 min | Late + cover next day | NA |
| | | Officer+ | 61+ min | Absent | Email staff, CC manager |
| 2 | Early login | both | — | No action | — |
| 3 | Early logout | OPS | 5–9 min | Log off + cover next day | NA |
| | | OPS | 10+ min | Absent | Email OPS |
| | | Officer+ | 6–20 min | Log off + cover next day | NA |
| | | Officer+ | 21+ min | Absent | Email staff, CC manager |
| 4 | Late Logout | OPS | 1hr+ | Absent | Email OPS |
| | | Officer+ | 1hr+ | Absent | Email staff, CC manager |
| 5 | No Login Record | OPS | NA | Absent NS/NC | Email OPS |
| | | Officer+ | NA | Absent NS/NC | Email staff, CC manager |
| 6 | No login or no logout | OPS | NA | Absent | Email OPS |
| | | Officer+ | NA | Absent | Email staff, CC manager |
| 7 | Cover not attended | OPS | 5–9 min | Absent | (blank) |
| | | OPS | 10+ min | Absent | Email OPS |
| | | Officer+ | 6–19 min | Absent | (blank) |
| | | Officer+ | 20+ min | Absent | Email staff, CC manager |
| 8 | RLS added to OT with no adjustment | both | NA | Adjust OT duration by RLS | NA |

Timing placement (user-stated): **late → same day; cover → next working day after the shift; absent → same day.** The COVER correction's `nominateDate` belongs to that target working day's own `NOM_DATE` — never the incident day's `NOM_DATE` — while `SegmentDate` stays the cover's own physical start day (which can be one calendar day after the target `NOM_DATE` for an overnight target schedule).

**Cover fallback when the next working day's ASPECT data is missing** (config `coverFallbackWhenNoWorkingDayFound`, fires only when no future SHIFT/OT1/OT2 segment exists for the employee — i.e. nothing has been uploaded for the days after the incident yet):
- `sameDay` — collapses cover onto the incident day itself, reusing the exact same end-of-last-segment placement logic as a normal target day (no new time logic).
- `nextDirectDay` — literal incident date + 1 calendar day, no weekend-skipping (there's no data to confirm working-day status). Start time = `coverFallbackDefaultTime`, default **08:00**.
- `nextWeekMonday` **(default option)** — the Monday that starts the ISO calendar week *after* the incident's own week (`mondayOfIncidentWeek + 7 days`; days-out varies by weekday, e.g. a Sunday incident lands only 1 day later). Start time = `coverFallbackDefaultTime`, default **08:00**.

Whenever this fallback fires, the output carries a fixed note (`TAA_COVER_FALLBACK_NOTE` column in the annotated Cognos export, and a suffix on the ASPECT correction row's `Memo`) identifying that the cover was placed without ASPECT data and which option/time was used — never silently indistinguishable from a cover placed against real schedule data.
Every threshold, tier keyword, and action above must be config-editable, never hardcoded.

## The no-shift exclusion gate (full detail in `aspect-workforce-management`; restated because it directly drives evaluation here)
```
evaluate the day IF   a SHIFT exists  OR  any OT segment (OT1/OT2) exists
skip the day    ONLY IF  no SHIFT and no OT
```
Both directions are severe: too inclusive → staff marked absent on a day off; too exclusive → public-holiday OT2 silently dropped from pay.

## Regression cases the corrected tool must reproduce
- Eman Eltayeb (NURSNG trailing, out 14:13) → no action, not "47 min early".
- Minas Alabbas (NURSNG trailing, out 16:00) → no action, not "60 min early".
- PF 90135621 (19:00–03:00, in 18:57) → on time, present, not U-ABSENT.
- PF 4507957 (23:00–07:00, in 23:08) → 8 min late → Late+Cover, not U-ABSENT.
- A `P/H-LV`/`OFF` day, no CMS login, no OT → excluded, never marked absent.
- PF 4507957 on 28/08 (`P/H-LV` + `OT2 23:00→07:00`, no SHIFT, bare-date stop) → evaluated and paid as public-holiday OT, never skipped.
- OT2 must surface as public-holiday OT, never merged with OT1 (different pay rates).
- Cognos OT1/OT-2 always empty → must be backfilled from ASPECT before evaluation.

## Hold Policy tab — extending
Any new `RoleTier`, `HoldReasonCode`, `TaaActionCode`, or compared Cognos column must be wired
into the Hold Policy tab (`src/services/holdPolicy.ts`) — checklist: `doc/PRD.md` §Hold Policy
"Extending". A missing one fails `holdPolicy.test.ts` with a pointer message before it ships.

## Data caveats (state in any PRD/report)
ASPECT sample = single day 28/08/2026 (a public holiday); Cognos sample = 27/08/2026. The two do not overlap — no same-person-same-day cross-file check was possible; formula validation was done entirely within Cognos rows. ASPECT mix is unrepresentative because of the holiday (467 `P/H-LV`, only 660 shifts of 1,389) — don't treat these proportions as normal. Untested paths: leading (front-of-shift) releases, genuinely gapped split shifts, partial/half-day leave codes.
