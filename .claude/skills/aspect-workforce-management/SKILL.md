---
name: aspect-workforce-management
description: ASPECT Workforce Management desktop system's schedule-segment data model, upload CSV format, and segment-code dictionary, validated against TAA's real ASPECT export files. Use whenever reading, joining, or writing ASPECT segment data (ASPECT_Schdule_Segments.csv, ASPECT_ExtraFiled2.csv, ASPECT_segment_Definition.xlsx, ASPECT_CSV_format.txt), reasoning about NOM_DATE vs START_DATE, computing scheduled hours from segments, classifying segment codes into buckets (schedule-defining / adds / reduces / informational / leave / write-only), or building the ASPECT correction-file writer. Also use for the legacy Automation.xlsm macro's staging logic when porting or referencing it.
---

# ASPECT Workforce Management — segment model

## Row shape (both ASPECT CSVs, 19 columns)
`PRI_INDEX, EMP_SK, EMP_ID, EMP_LAST_NAME, EMP_FIRST_NAME, EMP_SORT_NAME, EMP_SHORT_NAME, EMP_SENIORITY, EMP_EFF_HIRE_DATE, NOM_DATE, START_DATE, SEG_CODE, START_MOMENT, STOP_MOMENT, DURATION, MEMO, RANK, EMP_CLASS_1, EMP_CLASS_1_DESCR`

- `EMP_ID` is **space-padded** (`"4508184   "`) — always `.trim()` before joining to Cognos `PF NO` or CMS `Login ID`.
- `ASPECT_Schdule_Segments.csv`: 4,683 clean 19-field rows → 1,389 `(EMP_ID × NOM_DATE)` groups. **Segment data only — unrelated to employee identity.**
- `ASPECT_ExtraFiled.csv`: same 19-column schema as `ASPECT_Schdule_Segments.csv` — **superseded for identity purposes.** An earlier version of this skill wrongly treated it as the username/section/team source; the user corrected this. Use `ASPECT_ExtraFiled2.csv` instead (below) for identity/email/tier. No evidence the old file is still needed for anything else once `ASPECT_ExtraFiled2.csv` covers a superset of its employees (its 1,389 `EMP_ID`s are all contained in the newer file's 2,199).
- **`ASPECT_ExtraFiled2.csv` — the actual identity/email master**, a different 21-column schema, one row per employee, 2,199 unique `EMP_ID`:
  `PRI_INDEX, EMP_SK, EMP_ID, EMP_LAST_NAME, EMP_FIRST_NAME, EMP_SORT_NAME, EMP_SHORT_NAME, EMP_SENIORITY, EMP_EFF_HIRE_DATE, EMP_TERM_DATE, EMP_ACTIVE_FLAG, EMP_TIME_ZONE, EMP_EMAIL_ADR, EMP_MEMO, EMP_CLASS_1, EMP_CLASS_1_DESCR, EMP_EXTRA_1, EMP_EXTRA_2, EMP_EXTRA_3, EMP_EXTRA_4, START_DATE`
  - **Source of truth for username/section/team** and for the role-tier keyword scan (see `segment-code-classification` skill). Do not use Cognos `SECTION` for tier — it disagrees with ASPECT on 36 employees and casing/abbreviation is inconsistent.
  - `EMP_ACTIVE_FLAG` = `T` on all 2,199 rows in the current snapshot (not discriminating today; respect it as a config-driven filter for future snapshots where it may vary). `EMP_TERM_DATE` populated on only 2 rows.
  - `EMP_EMAIL_ADR` populated on 1,255/2,199 (57%) — a meaningful sampled share are **personal** addresses (hotmail/gmail/yahoo), not corporate `@thecontactcentre.ae`. Still the first Outlook-resolution attempt per user instruction (full detail: `outlook-vba-email-companion` skill).
  - `EMP_EXTRA_2` populated on 1,625/2,199 (74%) — corporate-alias-shaped username (e.g. `aalali`, `ashamsi`); second resolution attempt.
  - `EMP_EXTRA_3` populated on 1,613/2,199 — a numeric ID (badge/ext), not yet mapped to a known field.
  - `EMP_EXTRA_4` populated on 1,317/2,199 — a department/role tag (`ACCESS CARD`, `ES OFCR`, `ECS`, ...), a corroborating (not primary) signal for tier. `ACCESS CARD`-tagged rows likely correspond to contractor/no-mailbox accounts — matches the legacy macro's `ACCESS CARD*` row-drop rule; flagged as a possible future exclusion, **not yet a confirmed rule**.
  - `EMP_MEMO` is unstructured but often rich — pasted email threads (same parsing trap as elsewhere) plus semi-structured fragments like `Grade:5; JobTitle:CSR; Nationality:UAE`, old/new PF mappings, nursing-leave history dates. Treat as informational/reference text only — not a structured field to parse in v1.
- Parse both `ASPECT_Schdule_Segments.csv` and `ASPECT_ExtraFiled2.csv` with a real CSV reader (quoted fields can contain pasted email threads or embedded commas — naive comma/line splitting silently garbles both files); keep only 19-field rows from the segment file.

## Dates — the part that is easy to get wrong
- **`NOM_DATE` = the schedule day**, pinned to the day the shift **starts**, even when it ends after midnight. Always key work off `NOM_DATE`, never off the calendar date a sub-segment happens to fall on.
- **`START_DATE`** is the calendar day a *sub-segment itself* starts — it diverges from `NOM_DATE` for post-midnight breaks/OT (232/9,362 rows ≈ 2.5%). Use `START_DATE` only for locating that segment's own timestamp, never for grouping the employee-day.
- **A bare date with no time = 00:00:00** (1,826/9,362 rows ≈ 19.5%). Confirmed arithmetically: `START_MOMENT + DURATION` lands exactly on that midnight. Treat it as a real midnight timestamp, not missing data — do not null it out or skip the row.
- `SHIFT.DURATION` always equals `STOP_MOMENT − START_MOMENT` (0 mismatches across the sample) — trustworthy, safe to use directly.

## Segment-code buckets (the editable Config table)

| Bucket | Effect | Codes | Notes |
|---|---|---|---|
| Schedule-defining | sets the window | `SHIFT` (primary), `OT1`, `OT2` | OT always starts at/after `SHIFT.stop` (192/192), never overlapping |
| Adds time | `+` | `COVER` | an **input**, not output-only: 86 occurrences, always alongside a SHIFT, always outside the shift window |
| Reduces time | `−` | `RLS`, `RLS-2H`, `RLS-3H`, `UN_RLS`, `Cover_RLS`, `NURSNG` | nested inside SHIFT, always trailing (carve from the back — 4/4 co-occurrences have `release.stop == shift.stop`; zero front, zero mid-shift observed) |
| Informational | none | `CMT`, `Prestige Arb`, `Prestige-EGS`, `ES & SMB`, `101-EGS`, `ECS`, `USMB-EGS`, `RET/CAN-EGS`, `OB-Sales`, `BRFNG`, `PRY-BK`, `High Consp`, `DOZ_RET_AR`, `FLUP`, `BREAK1–4` | **needs user business-call confirmation before build** |
| Full-day leave → exclude day | day skipped (unless OT present, see gate below) | `P/H-LV`, `OFF`, `LEAVE`, `ANNUAL`, `PLN_SK`, `MTN-LV`, `EMG-LV`, `TRMNTD`, `REGN`, `SUSPND`, `SICK` + dictionary leave codes | **needs user business-call confirmation before build** |
| Partial leave | `−` | `ANNL-5/6/7`, `Sick-4/9`, `Public Holiday 4/9` | defined in dictionary, **zero occurrences in sample — untested** |
| Write-only (output only, never input) | — | `LATE`, `STRLAT`, `LFTERL`, `ABSENT` / `Absent NS/NC` | 0 occurrences of LATE/STRLAT/LFTERL as ASPECT input, confirmed. `ABSENT` has **no time window** (empty start/stop/duration) — emit as a day-level marker, never a timed segment |

A second SHIFT in ASPECT (rare, 3 groups, contiguous e.g. 17:00–01:00 then 01:00–03:00) corresponds to Cognos's `DUTY-2` column (50/502 rows, 10%). ASPECT shows far fewer second-SHIFT segments than Cognos shows `DUTY-2` — a `DUTY-2` in Cognos with no matching ASPECT SHIFT is itself a discrepancy to flag in the annotated report.

## The no-shift exclusion gate (cuts both ways — see also `taa-time-attendance` skill)
729/1,389 employee-days have no SHIFT (`P/H-LV` 467, `OFF` 136, `LEAVE` 108, `ANNUAL` 99, + others). A naive "no SHIFT ⇒ skip" gate silently drops the 9 `OT2` employee-days (public-holiday overtime, 480–600 min each, pattern `P/H-LV` + `RTM` + `OT2`), which is unpaid overtime — a payroll bug, not a cosmetic one.

```
evaluate the day IF   a SHIFT exists  OR  any OT segment (OT1/OT2) exists
skip the day    ONLY IF  no SHIFT and no OT
```

## netScheduledMinutes formula — validated ±1 min on 500/500 rows
```
netScheduledMinutes = DUTY1 + OT1 + DUTY-2 + OT-2 + COVER − Σ(release/nursing deductions)
```
465 exact, 35 off by exactly −1 min (seconds rounding). The parenthesised remark figure (e.g. `RLS:17:00 - 18:00( -54 Minutes)`) is **already net of COVER** — do not subtract COVER twice.

Worked proofs: Kirollous 480+120−93=507=`8:27`. Said ElDib 480+60−53=487=`8:7`. Ahmed Hesham 480+COVER 4=484=`8:4`.

## OT1 vs OT2 — never merge, different pay rates
- `OT1` = normal overtime. Measured: 192 employee-days, **every one alongside a SHIFT**, starts at/after `SHIFT.stop`.
- `OT2` = public-holiday overtime. Measured: 9 employee-days, **every single one has NO SHIFT**, pattern is `P/H-LV` + `RTM` + `OT2` as a full 480–600 min working day.
- Cognos never carries OT — `OT1`/`OT-2` columns are empty on all 502 rows. Always populate them from the ASPECT segment sheet before evaluation (this is what the legacy macro's XLOOKUP into columns G/I did).

## Segment-code dictionary (`ASPECT_segment_Definition.xlsx`, 295 codes)
Parse as OOXML zip: `zipfile` + `xml.etree` over `xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml`, no external library needed.

**Trap: `Default Duration` is a placeholder (1h) for most codes, including all release/nursing codes** (`RLS`, `RLS-2H`, `RLS-3H`, `UN_RLS`, `Cover_RLS`, `NURSNG`) — it is never real duration. Always compute duration from that row's own `START_MOMENT`/`STOP_MOMENT`, never from the dictionary's `Default Duration`.

## Upload CSV format (`ASPECT_CSV_format.txt`)
Header: `Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo,`

`nominateDate` is the `NOM_DATE` of the schedule the row BELONGS TO, not necessarily the incident day — a placed `COVER` row's `nominateDate` is the resolved TARGET working schedule's own `NOM_DATE`, while `SegmentDate` is the cover's own physical start date (may be one day later for an overnight target).

**Every row — header and data alike — ends with a trailing comma** (a trailing empty field). This is shown explicitly in the reference file. The writer must emit it or ASPECT rejects the upload. This is the ASPECT correction-file output (output #1 of the two required outputs; the annotated Cognos report is output #2 and must never be confused with this one — see `taa-time-attendance` skill).

### `Code` column semantics (user-confirmed 2026-09-15)
| Code | Meaning |
|---|---|
| `00` | Add / insert a new segment |
| `10` + `11` | Change/replace **pair** — `10` carries the original segment's own values, `11` carries the replacement. Both rows usually share the same `SegmentStarttime`, but the start CAN differ between them — e.g. the flex shift-update pair, or Rule 8's OT/RLS split when the surviving OT piece moves to a new start (see `taa-time-attendance` skill); `SegmentCode`, `Segmentduration`, and/or `SegmentStarttime` may all change between the two rows. |
| `20` | Delete an existing segment — the row repeats the SAME identifying details (SegmentCode/nominateDate/SegmentDate/SegmentStarttime/Segmentduration) as the segment being removed, e.g. `20,450087,OT1,01/08/2026,01/08/2026,14:00,01:00,"OT1 segment to be delete",` |

**ASPECT rejects a `10`/`11` replacement row that carries `00:00` duration** — a change/replace pair's new value must never be a bare zero. Where a correction would otherwise reduce a segment to nothing, either re-type it (change its `SegmentCode`, same duration) rather than zeroing it, or use a `20` delete instead — never emit a zero-duration change row.

Code `20` has no call site in the current engine (`TAA_HTML/src/services/reconciliationEngine.ts`) as of 2026-09-15 — recorded here as confirmed ASPECT knowledge for future rules, not yet consumed by any rule.

## Legacy macro staging (`Automation.xlsm`, module `Run`) — reusable parts
Sheets: `Run` (trigger), `Cognos`, `ref` (config), `CMS`, `Aspect`, `Staff` (unused), `Temp` (scratch).
Reusable staging logic: file-picker import → drop rows where Cognos col B starts `ACCESS CARD*` or col C starts `UAE*` → clean → the `HasFlexCode` keyword-scan technique (see `segment-code-classification` skill) → XLOOKUP of ASPECT OT1/OT2 into Cognos → CMS import via Avaya CMS Supervisor COM.
**Known defects — do not port:** `Folderexist` return value is inverted and ignored; `On Error Resume Next` wraps the whole CMS COM block, swallowing failures silently; sheet names referenced in inconsistent case; and critically, **the MINIFS/MAXIFS CMS join is date-keyed, not time-window-keyed — this is Defect 2, the cross-midnight false-absence bug** (full detail in `taa-time-attendance` skill). Do not reuse that join logic.
