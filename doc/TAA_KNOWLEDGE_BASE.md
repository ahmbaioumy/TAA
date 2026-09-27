# TAA Knowledge Base — Schedule vs Actual Reconciliation

**Purpose.** This is the durable technical and business reference for the Time & Attendance Automation (TAA) project. It consolidates the PRD, the validated research plan, and direct inspection of every supplied project source. It is intended to let a future contributor understand the data contract and safety constraints before changing any reconciliation logic.

**Last inspected:** 2026-09-06  
**Input rule:** all source files are read-only inputs. Payroll-impacting decisions must be traceable to source data, configurable policy, and this document's stated assumptions.

## 1. System intent and safety boundary

TAA independently reconciles ASPECT scheduled work against Avaya CMS attendance punches, using Cognos only as the management report to annotate and compare. The intended outputs are:

1. An ASPECT-upload correction CSV.
2. A clearly-labelled, annotated *copy* of the Cognos report.
3. Draft emails, created entirely in the browser as downloadable `.eml` files (no VBA/Outlook companion — removed §7g, 2026-09-08); emails must be displayed as drafts only, never sent automatically.

This is a payroll process. A false absence, unadjusted release, or dropped overtime segment can produce an incorrect deduction or missed payment. The tool must therefore never silently accept Cognos values, rewrite a Cognos source, merge normal and public-holiday overtime, or apply an unconfigured rule.

## 2. Authority, confidence, and current scope

| Level | Source | What it governs |
|---|---|---|
| Authoritative policy | `Rules to be taken.xlsx` | The eight attendance-rule categories, tier thresholds, actions, and communication requirements. |
| Authoritative schedule/identity data | `ASPECT_Schdule_Segments.csv`, `ASPECT_ExtraFiled.csv`, `ASPECT_segment_Definition.xlsx` | Scheduled segments, staff identity/role signals, valid segment codes. |
| Actual attendance evidence | `CMS_Login_logout.csv` | Punch timestamps. The current file is only a 39-row sample for Login ID `68858`; it is not sufficient to reconcile all Cognos records. |
| Management report to compare, not trust | `Cognos_DescrepencyReport.csv` | Original discrepancy rows and existing Cognos calculations. Preserve exactly in any annotated export. |
| Design/research evidence | `PRD.md`, `c-users-lenovo-desktop-taa-aspect-csv-f-fuzzy-turtle.md` | Validated findings, expected architecture, defects, regression cases, and known open questions. |
| Legacy implementation reference | `Automation.xlsm` | Staging and CMS-export approach only. Its date-keyed CMS aggregation is known unsafe for overnight shifts. |
| Deprecated reference | `Rules.txt` | Historical/coarser wording; do not implement from it. |

### Snapshot coverage limitation

The supplied schedule export is for **28/08/2026**; Cognos is for **27/08/2026**; and the CMS sample covers Login ID `68858` from 02/08/2026 to 28/08/2026. Directly joining these files would create false conclusions. The schemas, formulas, and key transformations are validated; a production run needs same-period ASPECT schedule data and a CMS export for the Cognos Login IDs.

## 3. Relational model and join rules

```text
Cognos (PF NO, LOGIN ID, report date)
  ├─ trim(PF NO) → ASPECT schedule (EMP_ID, NOM_DATE) → schedule windows / OT / releases
  ├─ trim(PF NO) → identity master (EMP_ID) → role tier / mailbox alias / validation
  └─ LOGIN ID → CMS (Login ID, full timestamps) → actual first login / last logout

Segment schedule row ── RANK → Segment dictionary Rank → code description/validation
Policy matrix ── tier + event + duration → configured corrective action and communication
```

### Non-negotiable join rules

- Trim `EMP_ID` and Cognos `PF NO` before every employee join. The schedule export has fixed-width padded IDs; 753 identity IDs are also padded.
- Join CMS **directly** using Cognos `LOGIN ID`, not `ASPECT_ExtraFiled.csv.EMP_EXTRA_3`. The PRD records 76 mismatches for that badge field.
- Join CMS by a configurable **timestamp window** around the entire scheduled span, never by calendar date. For cross-midnight work, the final punch normally belongs to the next date.
- Group ASPECT employee-days by `(trim(EMP_ID), NOM_DATE)`. `NOM_DATE` is the day the shift starts; `START_DATE` is an individual segment's calendar day.
- Keep OT1 (normal overtime) and OT2 (public-holiday overtime) separate through all calculations and output fields.

### Directly verified joins

- 502/502 Cognos PF IDs occur in the 2,199-row identity master after trimming.
- 502/502 Cognos PF IDs occur in the 1,389 scheduled employee IDs after trimming.
- Schedule IDs are a subset of identity IDs.
- Five Cognos rows have no Login ID; these cannot receive CMS evidence without a separately governed exception path.

## 4. File-by-file data contract

### `ASPECT_Schdule_Segments.csv` — schedule segments master

- **Observed grain/size:** 4,683 quoted-CSV rows; 1,389 `(EMP_ID, NOM_DATE)` employee-days; 46 segment codes; one `NOM_DATE`, 28/08/2026.
- **Parse:** UTF-8 quoted CSV (fallback Latin-1); do not split lines or commas manually because `MEMO` can contain quoted multiline emails.
- **Key fields:** `EMP_ID` (trimmed join key), `NOM_DATE` (employee-day key), `SEG_CODE`, `START_MOMENT`, `STOP_MOMENT`, `DURATION`, and `RANK`.
- **Verbatim on-disk column order** (the groupings below are by purpose, not file order — anyone parsing positionally must use this): `PRI_INDEX, EMP_SK, EMP_ID, EMP_LAST_NAME, EMP_FIRST_NAME, EMP_SORT_NAME, EMP_SHORT_NAME, EMP_SENIORITY, EMP_EFF_HIRE_DATE, NOM_DATE, START_DATE, SEG_CODE, START_MOMENT, STOP_MOMENT, DURATION, MEMO, RANK, EMP_CLASS_1, EMP_CLASS_1_DESCR`.
- **Identity/display fields:** `EMP_LAST_NAME`, `EMP_FIRST_NAME`, `EMP_SORT_NAME`, `EMP_SHORT_NAME`, `EMP_SENIORITY`, `EMP_EFF_HIRE_DATE`.
- **Reference-only fields:** `PRI_INDEX`, `EMP_SK`, `EMP_CLASS_1`, `EMP_CLASS_1_DESCR`, `START_DATE`, `MEMO`.
- **Timestamp rules:** a bare date in `START_MOMENT`/`STOP_MOMENT` means midnight, not a missing timestamp. `START_DATE` differs from `NOM_DATE` on 116 rows because post-midnight segments occur on the next calendar date. Empty timestamps occur for structural/full-day entries and must not be invented.
- **Observed structure:** 663 `SHIFT`, 192 `OT1`, 9 `OT2`, 86 `COVER`, and 4 `NURSNG` entries. Three employee-days contain multiple `SHIFT` rows. Nine days have no `SHIFT` but do have overtime—these must still be evaluated.

| Column group | Exact columns | Use |
|---|---|---|
| Record/reference | `PRI_INDEX`, `EMP_SK`, `RANK` | Traceability and segment-dictionary link; not an employee join key. |
| Employee | `EMP_ID`, `EMP_LAST_NAME`, `EMP_FIRST_NAME`, `EMP_SORT_NAME`, `EMP_SHORT_NAME`, `EMP_SENIORITY`, `EMP_EFF_HIRE_DATE` | Join, display, and role-tier scan. `EMP_FIRST_NAME` often contains role tags rather than a literal first name. |
| Schedule | `NOM_DATE`, `START_DATE`, `SEG_CODE`, `START_MOMENT`, `STOP_MOMENT`, `DURATION` | Reconciliation window, schedule classification, and duration. |
| Notes/classification | `MEMO`, `EMP_CLASS_1`, `EMP_CLASS_1_DESCR` | Free text / currently non-decisive metadata. |

### `ASPECT_ExtraFiled.csv` — identity master

- **Observed grain/size:** 2,199 employees, one row per employee, 21 columns. This is the real identity-master file. An outdated `ASPECT_ExtraFiled2.csv` name (an earlier, 19-column schema) still appears in several project skill docs; the research plan flags this as an open item to reconcile rather than asserting it itself, and `PRD.md` is the document that resolves it — confirming `ASPECT_ExtraFiled.csv` (21 columns) as correct.
- **Parse:** UTF-8 quoted CSV (fallback Latin-1); `EMP_MEMO` is multiline text.
- **Primary key:** trim `EMP_ID`.
- **Tier inputs:** scan `EMP_SORT_NAME` and `EMP_SHORT_NAME` case-insensitively for configurable non-OPS keywords such as `OFCR`, `OFFICER`, `ANALYST`, `SPECIALIST`, `COORDINATOR`, and `SUPERVISOR`. Default to OPS only when no configured keyword matches; do not derive tier from Cognos `SECTION`.
- **Mail resolution:** `EMP_EXTRA_2` is the preferred corporate alias (1,625 populated); `EMP_EMAIL_ADR` is fallback-only because it has incomplete, malformed, and non-corporate values (1,255 populated). **Mandatory normalization (user-directed): strip everything from `@` onward on both fields before resolving — only the username is ever used, never the domain.** `local(v) = v.split('@')[0] if '@' in v else v`. Verified: where both fields are populated (973 rows), `local(EMP_EMAIL_ADR) == EMP_EXTRA_2` on 959/973 (98.6%); the 14 mismatches are personal-domain addresses (hotmail/eim.ae) whose local part is unrelated to the corporate alias and still need the name-based fallback. `EMP_TERM_DATE` and `EMP_ACTIVE_FLAG` are safeguards before drafting email.
- **Do not use:** `EMP_SK` is not reliable as a key; `EMP_EXTRA_3` is a legacy badge/reference field, not the CMS login join.

| Column group | Exact columns | Use |
|---|---|---|
| Identity | `PRI_INDEX`, `EMP_SK`, `EMP_ID`, `EMP_LAST_NAME`, `EMP_FIRST_NAME`, `EMP_SORT_NAME`, `EMP_SHORT_NAME`, `EMP_SENIORITY`, `EMP_EFF_HIRE_DATE` | Employee resolution and tier scan. |
| Employment validation | `EMP_TERM_DATE`, `EMP_ACTIVE_FLAG`, `EMP_TIME_ZONE`, `START_DATE` | Guard email/action output; `START_DATE` is snapshot metadata, not a schedule date. |
| Contact/department support | `EMP_EMAIL_ADR`, `EMP_MEMO`, `EMP_EXTRA_1`, `EMP_EXTRA_2`, `EMP_EXTRA_3`, `EMP_EXTRA_4` | Outlook alias first; controlled fallback/contact validation; `EMP_EXTRA_4` only corroborates classification. |
| Constants | `EMP_CLASS_1`, `EMP_CLASS_1_DESCR` | Non-decisive in this snapshot. |

### `Cognos_DescrepencyReport.csv` — management discrepancy report

- **Observed grain/size:** 502 UTF-16 LE/tab-delimited rows dated 27/08/2026.
- **Parse:** UTF-16 with a real tab-delimited CSV reader. `REMARK` may contain multiline text. Preserve the original 18 columns and header spelling exactly; the report is never overwritten.
- **Keys:** `PF NO` joins ASPECT after trim; `LOGIN ID` joins CMS directly. `LOGIN ID` is blank in five rows.
- **Schedule content:** `DUTY1` has 500 populated rows, 34 cross midnight; `DUTY-2` has 50 populated rows. `OT1` and `OT-2` are empty in all 502 rows and must be sourced from ASPECT if required for evaluation.
- **Important headers:** retain the source typos `SIGIN IN` and `SIGIN OUT` verbatim.

| Column group | Exact columns | Use |
|---|---|---|
| Report identity | `SIGN IN DATE`, `SECTION`, `PF NO`, `NAME`, `LOGIN ID` | Date/context/display and source joins. `SECTION` is not a reliable role tier. |
| Reported schedule | `DUTY1`, `OT1`, `DUTY-2`, `OT-2`, `SCH DURATION` | Cognos's view of planned blocks; complete it from ASPECT for comparison. |
| Reported attendance/variance | `SIGNIN DURATION`, `SIGIN IN`, `SIGIN OUT`, `LATE START`, `LEFT EARLY` | Audit values only; recompute from CMS and effective schedule. |
| Existing state and notes | `LEAVE TYPE`, `LEAVE HR`, `REMARK` | Existing management label and unstructured adjustment evidence. |

### `CMS_Login_logout.csv` — actual attendance punches

- **Observed structure:** line 1 is report title; line 2 is agent metadata (`Agent:,Ahmed G_30050`); line 3 is the header; 39 data rows follow.
- **Actual columns:** `Date`, `Login ID`, `Login Time`, `Logout Time`, `Login Time`, `Logout Time`. The duplicate names require positional parsing: columns 5 and 6 are full datetimes and are the authoritative timestamp fields; columns 3 and 4 are time-only display values.
- **Observed scope:** all current rows use Login ID `68858`. The sampled full timestamp span is 02/08/2026 12:14:22 through 28/08/2026 04:24:02.
- **Interpretation:** each record is a discrete login/logout event, not a work session. Derive `actualFirstLogin = min(window punches)` and `actualLastLogout = max(window punches)` for a configured schedule window.

### `ASPECT_segment_Definition.xlsx` — segment dictionary

- **Observed workbook:** sheet `segment`, 296 rows including header, 295 definitions, six columns: `Rank`, `Code`, `Description`, `Default Duration`, `Updated By`, `Updated On`.
- **Use:** validate and explain segment codes; join `ASPECT_Schdule_Segments.RANK` to `Rank` when needed.
- **Critical trap:** 256 of 295 codes have `Default Duration = 01:00:00`, including `SHIFT`, `OT1`, `OT2`, `COVER`, releases, late/log-off, and absent codes. It is a configuration placeholder—not a real scheduled duration. Always use source segment timestamps and `DURATION`.
- **Verified action codes:** `LATE`, `STRLAT`, `LFTERL`, `ABSENT`, and `Absent NS/NC` exist. `OT1` means regular overtime; `OT2` means public-holiday overtime.
- **Absent + OT co-occurrence (PRD §4.6c, replace-pair decision 2026-09-15):** when Absent (`ABSENT` or `Absent NS/NC`) is added for a day, any `OT1`/`OT2` segments scheduled that same day are explicitly retired and replaced with `SHIFT` via a `shiftUpdateOriginalCode`/`shiftUpdateNewCode` (`10`/`11`) pair — row `10` carries the segment exactly as it exists (`OT1`/`OT2`, original start/duration), row `11` carries the same start/duration with the code swapped to `otToShiftConversionCode` (default `SHIFT`). Never a bare insert alongside the original OT row. Auto-included in the export (no reviewer hold — the day already pays zero). Prevents overtime premium pay from passing through, and prevents ASPECT from carrying two conflicting segments for the same window. Rule 8 (the RLS/OT adjustment pair) is skipped entirely on an Absent day so it never drafts a second, conflicting pair against the same OT segment.

### `Rules to be taken.xlsx` — authoritative policy matrix

- **Observed workbook:** `Sheet1`, 23 total rows (row 3 is a fully blank spacer row between tier groups, so **21 rows are actually populated**), six columns, with merged cells representing category/tier groups.
- **Columns:** `SN`, `Segmnet Type `, `Section `, `Duration `, `TAA Action `, `Communication to OPS` (verbatim from source, including the "Segmnet" typo and trailing spaces on columns B–E).
- **Implementation rule:** normalise the merged presentation into an editable configuration table. Do not hard-code the ranges, actions, tier keywords, or email decisions.
- **Policy categories:** Late Login; Early login; Early logout; Late Logout; No Login Record; No login or no logout; Cover not attended; RLS segment added to OT with no adjustment (source cell text is verbatim `"RLS segmnet added to OT  with no adjustmnet "` — double space and typos; use that literal string if matching programmatically against the workbook).

### `Automation.xlsm` — legacy staging macro

- **Observed workbook:** contains `xl/vbaProject.bin`; workbook sheets include `Run`, `Cognos`, `ref`, `CMS`, `Aspect`, `Staff`, and `Temp`.
- **Useful precedent:** file-picker staging, cleaning/filter concepts, CMS Supervisor export, OT lookup, and the `HasFlexCode` style of keyword scan.
- **Do not copy its reconciliation:** the documented macro takes `MINIFS`/`MAXIFS` CMS values by date. This is the cross-midnight false-absence defect. It also uses broad error suppression in the CMS automation path.
- **Role in future system:** reference only. The standalone HTML reconciliation engine owns business rules; any VBA companion is limited to Outlook recipient/manager resolution and showing email drafts.

### Supporting text files

| File | Meaning |
|---|---|
| `ASPECT_CSV_format.txt` | Output header: `Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo,`. Every emitted header and data line must end with the final comma. User-confirmed `Code` semantics: `00`=insert a new segment (LATE/COVER/ABSENT/Log_off, plus Rule 8's released-time SHIFT rows and leftover OT pieces — replaces the old `101` placeholder); `10` then `11`=original/updated change pair (§4.8 flex shift update, Rule 8 OT/RLS adjustment, §4.6c Absent-day OT→SHIFT replace since 2026-09-15, §4.6e SHIFT→OT2 replace). `Segmentduration` is `HH:MM` for every row, not just the flex pair. `Memo` is always double-quoted regardless of content. |
| `Rules.txt` | Deprecated early rules. It lacks the detailed tier-specific early-logout and communication matrix. |
| `PRD.md` | Current product requirements and complete source field dictionary. |
| `c-users-lenovo-desktop-taa-aspect-csv-f-fuzzy-turtle.md` | Research/validation plan. The project design record and regression source; it agrees with the PRD on the core safety controls. |

## 5. Reconciliation model

### 5.1 Segment classification

**⚠️ How this config actually gets set (user-corrected): discovery-driven, not a static walkthrough of the full 295-code dictionary.** On ASPECT upload, the tool extracts the distinct `SEG_CODE` values actually present and prompts a one-time glossary classification per code — **Addition / Removal / No Effect** — with pre-fills offered (not forced) from the evidence below (`SHIFT`/`COVER`→Addition, `RLS`-family/`NURSNG`→Removal). User can add codes not in the current upload and edit any classification later. One glossary answer per code drives both the hours formula and (via an optional, normally-hidden secondary flag) the leave-gate/write-only behaviors — not four separate config screens for the same code. See PRD §4.14.

The buckets below are the evidence and rationale behind those defaults — configurable data, not code branches:

| Bucket | Codes / treatment | Effect |
|---|---|---|
| Schedule-defining | `SHIFT`, `OT1`, `OT2` | Establish work windows. Preserve OT1 vs OT2 type/rate. |
| Adds | `COVER` | Adds scheduled time; it is an input segment as well as a possible output action. |
| Reduces | `RLS`, `RLS-2H`, `RLS-3H`, `UN_RLS`, `Cover_RLS`, `NURSNG` | Reduce the applicable effective window using actual timestamps/durations. |
| Informational | Breaks and operational tags such as `BREAK1`–`BREAK4`, `CMT`, `BRFNG`, `RTM`, `ECS` | No direct scheduled-hours effect unless configuration explicitly changes it. |
| Full-day exclusions | `P/H-LV`, `OFF`, `LEAVE`, `ANNUAL`, `PLN_SK`, `MTN-LV`, `REGN`, `SUSPND`, `SICK`, etc. | Route to the leave-day integrity check (§5.2 step 3) if there is no SHIFT and no OT — not a blanket exclude; a substantial login (≥60 min) still converts to Absent. Confirm bucket list with the business owner. |
| Partial leave | `ANNL-5/6/7`, `Sick-4/9`, `Public Holiday 4/9` | Reduce time; supported generically but unobserved in the schedule sample. |
| Write-only corrections | `LATE`, `STRLAT`, `LFTERL`, `ABSENT`, `Absent NS/NC` | Emit only as decided actions, not as evidence of planned work. |

### 5.2 Evaluation algorithm — RECOMPUTE-THEN-COMPARE, not flag-final-disagreements

**This supersedes any simpler "annotate = flag verdict disagreements" reading of step 9 below.** The pipeline recomputes every relevant Cognos-equivalent column independently first, then compares column-by-column, and only then decides on an action. Full order:

1. Parse each source with its real encoding/delimiter and normalise employee ID whitespace.
2. Group schedule segments by employee and `NOM_DATE`.
3. **Two gates, not one** (correcting an earlier self-contradictory single-gate design): the **attendance-rule gate** routes a day to normal Late/Early/Cover/No-login rules only if a `SHIFT` or any `OT` segment exists. A day with neither routes instead to the **leave-day integrity check**: fetch CMS logins anyway (via the time-window join, never date-keyed); no login → excluded, no action, even if Cognos flags it; login ≥ 60 min (config `leaveLoginThresholdMinutes`) → convert the leave segment to Absent + note, flagged for review; below 60 min → no action. A day is never fully "skipped" — it always routes through one gate or the other. Applies to any full-day-leave code generically (`ANNUAL`, `P/H-LV`, `OFF`, `LEAVE`, `SICK`, etc.), not just `ANNUAL`.
4. Build raw work span from scheduled blocks plus OT/COVER according to the **user-configurable segment-hours formula** (per-code additive/subtractive/excluded — not a fixed formula with only thresholds editable; default `(SHIFT+COVER)−(NURSNG+RLS-family)`). Carry cross-midnight endpoints into the next day.
5. Apply releases/nursing/partial leave to form an **effective** start/end window. Lateness and early leave use the effective, not raw, boundary — **except for flex staff past their cutoff, where the shift itself gets updated first (see §5.4)**.
6. Fetch CMS events for the Cognos `LOGIN ID` within `[scheduledStart − grace, scheduledEnd + grace]`. The grace interval is a configurable business decision, **CLOSED at a 4h default** (`cmsPunchSearchWindowHours`) — see §8 item 2.
7. Derive first/last actual attendance from the selected event timestamps. Do not use the source's time-only fields or Cognos's `SIGIN` values as truth.
8. Calculate rule events, resolve policy by role tier and minute band, and generate corrective segments/draft-email actions from config. **Charge the FULL measured variance once a band fires, never `measured − threshold`** (5 min late = no action; 6 min late = a 6-minute Late segment, not 1 minute).
9. **Independently recompute** every relevant Cognos-equivalent column (net scheduled hours, effective start/end, late/early minutes) from raw ASPECT+CMS data — never read Cognos's own numbers as ground truth — then append them **alongside** Cognos's originals in the annotated copy, column by column, so a reviewer can see exactly why a discrepancy is real, resolved, or a Cognos data gap (segment missing from Cognos entirely — a distinct flag from "Cognos calculated it wrong"). Preserve original Cognos columns byte-identical.

### 5.3 Core formulas

```text
netScheduledMinutes
  = DUTY1 + OT1 + DUTY-2 + OT-2 + COVER − release/nursing deductions

effectiveStart = rawScheduledStart + leading reductions
effectiveEnd   = final scheduled endpoint − trailing reductions

lateMinutes       = actualFirstLogin − effectiveStart
earlyLeaveMinutes = effectiveEnd − actualLastLogout
```

Positive `lateMinutes` and `earlyLeaveMinutes` identify late arrival and early departure respectively. The existing Cognos columns use the inverse variance sign convention and have been validated as operating on raw schedule boundaries; do not reuse them as decision inputs.

### 5.4 Flex staff — absolute cutoff, not a relative buffer

77/2,199 employees (3.5%) are flex-tagged (same `FLX`/`FLIX`/`FLEX`/`FELX` keyword scan). Flex staff are always scheduled 07:00–10:00; the cutoff is the **absolute wall-clock `10:00`** (config `flexCutoffTime`), not "3 hours after scheduled start" — those coincide only for a 07:00 shift, which is why the distinction is easy to miss.
- **Arrival ≤ 10:00:** no Late/Cover/Absent. If the arrival (rounded to nearest 30 min, config) differs from scheduled start, write a shift-update pair to ASPECT (duration preserved, only start shifts).
- **Arrival > 10:00, even by 1 min:** two actions — (a) shift-update, clamped to `10:00` (not rounded, since rounding could place the new start after the actual arrival), (b) Late+Cover measured **from the cutoff**, full amount charged, no minute-bands (a flex employee arriving 10:01 gets 1 minute Late+Cover, not 181).
- Once updated, all downstream rules (early/late logout, cover, no-login) apply normally against the NEW shifted end time.
- Exact CSV pair format: `10,455876,shift,01/08/2026,01/08/2026,07:00,08:00,"OrginalShift",` then `11,455876,shift,01/08/2026,01/08/2026,08:00,08:00,"updatedshift",` — `Segmentduration` here is `HH:MM`, unlike the raw-minutes `DURATION` column elsewhere. Codes `10`/`11` and the memo text are config, flagged low-confidence (not independently verified against ASPECT docs).

### 5.5 Cover placement algorithm

1. Target day = next **available working day strictly after the later of** (a) the incident date
   and (b) `processingDate + coverMinimumDaysAfterRunDate` (the run-date floor, default 1 day,
   applied to every fallback mode below too — see §7n, WP2/D5). Because `processingDate` is the
   run's own system clock (B8), a newly assigned cover's target date is **not reproducible**
   across two runs of the same input on different days — never assert that it is. **Exception:**
   when `coverSameDayWhenAlreadyCovered` is on and the agent provably worked the full cover window
   continuously on the incident day itself, the cover is credited on that **same day** instead —
   this applies only to a genuinely already-worked window, never to a newly assigned one (§7n,
   WP1/D4, WP2 B3).
2. Placement time = end of the **LAST segment on that day** (not necessarily the SHIFT's own end — walk every segment, take the max stop time).
3. Covers **stack** sequentially within a run — a second cover due the same day starts where the first one ends.
4. Duration = the full variance being compensated (no rounding/capping).
5. Fallback if no working day found ahead (i.e. the next working day's ASPECT data hasn't been uploaded yet): config `coverFallbackWhenNoWorkingDayFound`, 3 options — `sameDay` (collapse onto the incident day itself, reusing the same end-of-last-segment placement logic unchanged), `nextDirectDay` (literal incident date +1 calendar day, start time = `coverFallbackDefaultTime`, default `08:00`), `nextWeekMonday` **(default)** (Monday of the ISO calendar week after the incident's own week — `mondayOfIncidentWeek + 7 days`, so days-out varies by weekday: Mon incident → +7, Sun incident → +1 — start time = `coverFallbackDefaultTime`, default `08:00`). Every cover placed via this fallback carries a fixed note in the output (`TAA_COVER_FALLBACK_NOTE` column in the annotated Cognos export, plus a `Memo` suffix on the ASPECT correction row) identifying it as placed without ASPECT data and which option fired — this is the everyday case in a live cycle (next-day data routinely isn't uploaded yet when a late/cover case must be resolved), not a rare edge case.
6. **Requires forward-looking ASPECT data** — the sample export is single-day, which cannot exercise this algorithm's normal path; production input must span forward from the incident date.
7. Cover-not-attended (Rule 7) has a second permissible outcome beyond `markAbsent`: config `coverNotAttendedAction = moveCoverForward` re-runs this same algorithm. Detection relies on Covers round-tripping back into the next ASPECT import as real `COVER` segments — the tool's runs are therefore stateful across time, not a pure single-shot transform.

## 6. Policy matrix (configure from the workbook)

| Event | OPS | Officer / Coordinator / Analyst / Specialist |
|---|---|---|
| Late login | 6–60 min: Late + next-working-day Cover; 61+ min: Absent + OPS email | 11–60 min: Late + next-working-day Cover; 61+ min: Absent + staff email, CC manager |
| Early login | No action | No action |
| Early logout | 5–9 min: Log off + next-working-day Cover; 10+ min: Absent + OPS email | 6–20 min: Log off + next-working-day Cover; 21+ min: Absent + staff email, CC manager |
| Late logout | 60+ min: Absent + OPS email | 60+ min: Absent + staff email, CC manager |
| No login record | Absent NS/NC + OPS email | Absent NS/NC + staff email, CC manager |
| Missing login or logout | Absent + OPS email | Absent + staff email, CC manager |
| Cover not attended | 5–9 min: Absent; 10+ min: Absent + OPS email | 6–19 min: Absent; 20+ min: Absent + staff email, CC manager |
| Release attached to OT without adjustment | Adjust OT by the release | Same |

**Placement convention:** late and absence actions apply to the schedule day; cover is placed per
the §5.5 algorithm — a working day after the run-date floor for a newly assigned cover, or the
incident day itself for a proven already-worked cover (§5.5's exception, §7n). The "Late login" /
"Early logout" rows in the table above ("next-working-day Cover") describe only the default,
no-exception case; the grace window and final bucket membership remain business-owned
configuration decisions.

## 6a. Architecture requirements (workflow, VBA scope, config discipline)

> **HISTORICAL — superseded by §7g (2026-09-08), corrected 2026-09-14 audit.** The
> CMS-folder-automation and VBA-companion bullets below (the folder-polling/custom-protocol
> flow, `RunCMSExport`, `TAA_VBA_Companion.bas`/`.xlsm`, "One VBA source of truth") describe an
> architecture that was **entirely removed** the same day this section describes it — see §7g,
> "Entire VBA Companion removed." `doc/PRD.md` already reflects the removal ("VBA Companion:
> REMOVED"); this section was never updated to match, so a reader could easily miss that these
> specific bullets no longer apply. CMS is a plain manual upload (`UploadZone.tsx`); there is no
> VBA companion, `.bas` file, or CMS folder automation anywhere in the current app. The general,
> non-VBA-specific principles here (non-blocking upload order, column-mapping UI, zero-hardcode
> Config Registry) remain accurate and unaffected.

- **Workflow order — uploads are non-blocking, only Calculate is gated (user-corrected).** CMS export must never force the user to wait idle before doing anything else. Calculate requires all 4 inputs and both payroll suites. A failing-suite override is guarded by an exact typed phrase and mandatory reason, bound to the current config/inputs, and exported in the audit trail. After review, email-required rows can open Outlook drafts individually or in bulk; the manual actions-JSON + `RunEmailDrafts` path remains available.
- **CMS auto-export via folder automation (§6.1a, PRD), Chromium only, additive to the manual flow.** Once Cognos + ASPECT Segments + ASPECT ExtraFiled are uploaded, and the user has granted access to a local "Time Card" project folder (File System Access API — `showDirectoryPicker()`), the tool mirrors those 3 files into `Cognos/`/`ASPECT/` subfolders, fires a registered `taa-cms:run` custom protocol (one-time-per-machine setup via `CMS/Install_TAA_Protocol.bat`, no admin rights) that launches `TAA_CMS_Launcher.vbs` → runs `RunCMSExport` headlessly, then polls `CMS/` for the output file and auto-loads it — no manual Excel step, no manual CMS upload. **Confirmed via research:** the File System Access API is unreliable from `file://` pages (Chromium origin-keying) — `TAA_Launch.bat` (root, zero-dependency PowerShell `HttpListener`) serves the tool over `http://localhost` instead; folder permission does not persist across browser sessions (expect one "Reconnect" click per session); there is no folder-watch event, so CMS pickup is a config-driven poll (`cmsFolderPollIntervalMs`/`cmsFolderPollTimeoutMinutes`), falling back to manual CMS upload on timeout. Custom protocol registration via `HKCU\Software\Classes\<scheme>` needs no admin rights and is documented/working (Windows standard mechanism). Everything here is optional — Firefox/Safari and any environment without a granted folder use the original, unchanged fully-manual 4-upload flow.
- **`RunCMSExport` derives CMS_AGENTS/CMS_DATES from the Cognos report by default (§6.3.1a, PRD).** Reads the just-uploaded Cognos file from `..\Cognos\` (UTF-16 LE tab-delimited), locates `LOGIN ID` (col 5) and `SIGN IN DATE` (col 1, format `YYYY-MM-DD HH:MM:SS`) by header name, collects distinct login IDs and date min/max. `CMS_AGENTS_SOURCE = CONFIG_MANUAL` on the Config sheet restores the prior static-value behavior unchanged. The derived date format sent to CMS Supervisor (`cmsDateFormatPattern`) is **unverified against the live system** — same confidence caveat as other unverified config defaults.
- **Column-mapping UI required** on the 4 required uploads (Cognos, ASPECT Segments, ASPECT ExtraFiled, CMS) — dropdown per expected field → detected column, so a renamed/reordered source header doesn't hard-break parsing. CMS is the one exception: it uses fixed column positions, not header names, so no mapping UI applies there.
- **VBA companion = one workbook with CMS and email entry points.** `RunCMSExport` owns CMS automation; legacy `RunEmailDrafts` accepts a manually selected actions JSON; `RunEmailDraftRequest` consumes the browser request and atomically returns status JSON. Excel is hidden and always restored. Outlook messages call `.Display` only. Missing manager CC opens an employee-only draft with a warning and review count; missing staff/OPS recipients create no draft and return a review message.
- **Cognos import: no silent drops.** The legacy `ACCESS CARD*`/`UAE*` filter is no longer hardcoded/silent — it's an optional config preset (default: empty, drop nothing). Anything not matched by a user-enabled drop rule is imported and either resolved or flagged as an exception, never discarded quietly.
- **Config Registry — zero hardcode is an auditable requirement.** Every tunable (rule thresholds, tier/flex keyword lists, flex cutoff/rounding, the segment-hours formula's per-code roles, CMS grace window, drop-pattern list, leave-login threshold, memo templates, shift-update action codes, cover fallback/not-attended policy, working-day calendar, per-source parse settings) lives in one enumerated table, editable through the UI (`ConfigRegistryView.tsx`) with no code change. A live `validatePolicyBands()` (`configRegistry.ts`) linter flags overlapping, inverted, or gapped minute-bands in the editable Policy Rules Matrix. Acceptance test: a reviewer finding a business-rule literal in JS/VBA source is a blocking defect.
- **One VBA source of truth.** The in-app generator imports the root `TAA_VBA_Companion.bas` as raw text and only specializes the OPS-mailbox fallback, so the downloadable module and embedded workbook no longer drift.
- **Settings export/import/reset:** the Config panel must support exporting the full config to JSON, importing it back, and a confirmed reset-to-defaults (states what will be cleared before firing).

## 7. Confirmed defects and regression protections

| Risk | Required protection |
|---|---|
| Cognos evaluates early departure against raw end time | Apply trailing release/nursing before comparison; otherwise 41/502 Cognos rows were found falsely early. |
| Date-keyed CMS aggregation loses overnight logout | Use timestamp-window matching across midnight; never filter CMS solely to `NOM_DATE`. |
| No-SHIFT gate drops public-holiday overtime | Route no-SHIFT/no-OT days through the leave-day integrity check (§5.2 step 3), never a blanket skip. Nine observed no-SHIFT/OT days prove this path is required. |
| Cognos OT columns are all blank | Populate/reconcile OT from ASPECT before evaluation. |
| Duty-2 is ignored | Treat the final scheduled block as the raw end; 50 report rows contain `DUTY-2`. |
| CMS sample/readers use duplicate time column names | Use positional full-datetime columns 5–6. |
| CSV parsing breaks on memo/email text | Use quote-aware CSV parsers for all CSV inputs. |
| ASPECT upload rejected | Retain the trailing comma on every output line; `Segmentduration` uses `HH:MM` for every row (not just flex pairs); `Code=00` for every insert action, `Code=10`/`11` for the change pair (never the old `101` placeholder); `Memo` always double-quoted. |
| Standalone build renders a blank page | `assemble-standalone.cjs`'s prior approach re-parsed its own previous `TAA_Workspace.html` output to find the `<style>`/`<script>` splice points via naive `indexOf`, which matched literal `<style>` text inside the head comment's own prose instead of the real tag — this silently produced a head comment with no closing `-->`, and an unclosed HTML comment swallows the rest of the document (style/script/body) as comment text, so nothing renders. Fixed by generating the file from a fixed, correctly-closed head/tail template instead of re-parsing prior output. Always open the regenerated `TAA_Workspace.html` in a real browser after rebuilding — a successful `vite build` does not prove the assembled standalone file renders. |
| Banded rule charges `measured − threshold` instead of the full variance | Charge the full measured amount once a band fires (§5.2 step 8) — 6 min late is a 6-minute Late segment, not 1. |
| Flex cutoff implemented as a relative buffer instead of absolute `10:00` | Only the absolute reading is correct (§5.4) — a relative reading only happens to match for a 07:00 shift. |
| Cover placed at the SHIFT's own end instead of the day's last segment | Walk every segment on the target day, place at the max stop time (§5.5 step 2) — covers can stack past a second block or an existing cover. |
| Silent Cognos row drops (`ACCESS CARD*`/`UAE*`) | Config-gated, default off — never a hardcoded filter (§6a). |
| CMS-not-logged-in failing silently | `RunCMSExport` must fail loudly with a clear message, not an empty file (§6a). |
| "Add unlisted Code" in the Discovery-Driven Segment Glossary modal appeared to silently fail | `allCodes` was computed as `discoveredCodes` only whenever `showAllConfigured` was `false` (its default state once an upload has discovered codes) — a hand-typed code lands in `glossary` state but was excluded from the rendered list entirely. Fixed in `DiscoveryGlossaryModal.tsx`: adding a code now also sets `showAllConfigured` to `true` so it renders immediately, and the same handler now rejects a case-insensitive duplicate with an inline warning instead of silently accepting/dropping it. Also added a seg-code substring filter box above the table for glossaries with many codes (PRD §4.14 point 9). |
| No column-by-column Cognos comparison — `TAA_COGNOS_AGREE` was inferred from 3 ad hoc heuristics, never an actual recompute-vs-original diff | Added `cognosComparison.ts`: 12 Cognos columns (`DUTY1`, `DUTY-2`, `OT1`, `OT-2`, `SCH DURATION`, `SIGNIN DURATION`, `SIGIN IN`, `SIGIN OUT`, `LATE START`, `LEFT EARLY`, `LEAVE TYPE`, `LEAVE HR`) each get an explicit `MATCH`/`MISMATCH`/`COGNOS_BLANK`/`NOT_COMPARABLE` status against the independently recomputed value, tolerance-configurable (`comparisonToleranceMinutes`). Any `MISMATCH` holds the row out of the ASPECT correction CSV until a reviewer approves it. |
| Schedule window built only from the FIRST `SHIFT` segment; `OT1` never extended it; multiple `SHIFT` rows ignored | `scheduleRecompute.ts` rebuilds `rawStart`/`rawEnd` as `min(start)`/`max(stop)` across every glossary-`ADDITION` segment (SHIFT, OT1, OT2, COVER, ...), entirely from ASPECT — Cognos `DUTY1`/`DUTY-2` are comparison targets only, never inputs. An agent who skips a scheduled OT1 tail is now flagged. |
| CMS logout capture used a hardcoded 8-hour tail after scheduled end, which could swallow the NEXT shift's login punch on a night shift | `punchAttribution.ts`: symmetric `±cmsPunchSearchWindowHours` (config, default 4h) search radius; every punch is assigned to exactly one employee-day — the nearest scheduled window by distance — so two adjacent night shifts can never share or lose a punch (regression `reg-14`). |
| A single matched CMS punch (or none) was treated as automatic proof of absence, even at the literal edge of a CMS export's date range | Added a per-window CMS-coverage check: if the export's own min/max punch timestamps for that Login ID don't reach `±cmsPunchSearchWindowHours` around the scheduled window, the row is held as `INSUFFICIENT_CMS_COVERAGE` (`MANUAL_REVIEW_REQUIRED`) instead of `ABSENT_SEGMENT`. A genuine single punch with full surrounding coverage still correctly fires Rule 6 (regressions `reg-15`, `reg-16`). |
| Leave-day CMS check (§4.6b) was date-keyed (calendar-day filter), the exact anti-pattern the cross-midnight non-negotiable forbids | Leave days now get a synthetic full-day scheduled window that goes through the same time-window punch attribution as a real shift. |
| Email communication rule was re-derived from `action` + `tier` alone (`getCommunicationRuleForAction`), picking the FIRST matching policy row even though the same action (`ABSENT_SEGMENT`) appears in 4 different rules with different routing | The rule that actually fired is now captured directly at its firing site and carried through to the email action — no re-derivation, no ambiguity. |
| Rule 7 (Cover Not Attended) and Rule 8 (RLS added to OT with no adjustment) were defined in config but never evaluated by the engine | Both implemented: Rule 7 checks each day's `COVER` segments against the day's attended span and fires the configured `markAbsent`/`moveCoverForward` outcome; Rule 8 detects an OT segment overlapping a release segment and emits an original/adjusted duration pair. |
| Flex branch A's downstream early-logout check used hardcoded thresholds and pushed no correction rows (UI said "Absent", output CSV had nothing); flex branch B ran no downstream check at all, so a late-arriving flex employee could leave early free | `evaluateEarlyAndLateLogout()` is now a single shared helper used by both flex branches (after their respective shift-update clamp) and the standard path — real Config Registry rule lookup, real correction rows, every time. |
| `convertOtSegmentsToShift` (Absent+OT co-occurrence, §4.6c) wrote the OT correction's `SegmentDate` as the shift's `NOM_DATE` even when the OT segment's own physical day (`START_DATE`) differs (post-midnight OT tail) | Uses `seg.START_DATE` — the segment's own physical calendar day — per `doc/aspect.md` §2's field-4-vs-field-5 distinction. |
| `parseHHMMToMinutes('')` returned `0`, not "no value" — a blank Cognos `OT1`/`OT-2`/`SIGNIN DURATION` cell was compared as if it held a real `0:00`, producing a false `MISMATCH` and silently defeating the fill-if-blank rule | `parseBlankableHHMM()` in `cognosComparison.ts` returns `null` for an empty/whitespace cell; only a genuinely populated cell is parsed as a number. |
| D-A: a row with two fired rules (e.g. late login + early logout) reported only the last-evaluated rule in `TAA_ACTION`, and the emailed variance kept only the first rule's minutes | `chargedVarianceMin` sums across all fired minute-band rules; new `TAA_ACTIONS_FIRED` field/CSV column/email line lists every action fired, alongside the existing most-severe `TAA_ACTION`. See §7a. |
| D-B: Late Logout measured against the raw shift end instead of the release/nursing/RLS-adjusted effective end that Early Logout already used | Late Logout now measures from `effectiveEndDt`. See §7a. |
| D-C: flex staff had no CMS-evidence guard at all — a single genuine swipe was evaluated as a normal arrival instead of Absent | Flex now runs the same span-based evidence/coverage guard as standard staff before Branch A/B. See §7a. |
| A blank Cognos `LOGIN ID` (5 real rows) fell through to the no-punches branch and was auto-marked `ABSENT_NS_NC` | New hold reason `MISSING_CMS_JOIN_KEY` — a missing join key is missing evidence, not evidence of absence. A populated ID with genuinely no CMS record still applies Rule 5 normally (user-confirmed). See §7b. |
| Cognos's `LATE START`/`LEFT EARLY` sentinel guard applied to `LEFT EARLY` only — `LATE START` compared the sentinel (e.g. `-480`) as a real variance, falsely `MISMATCH`ing 168/502 real rows | Sentinel detection applied to both columns, and made structural (`value === -LEAVE HR`, or no `SIGIN IN`/`SIGIN OUT` at all) rather than a fixed `[-480,-540]` list, which silently missed any other shift length. See §7b. |
| Leave-day `DUTY1`/`DUTY-2`/`SCH DURATION` were compared against Cognos's paid-leave roster print, a guaranteed false mismatch on every leave day (~168 real rows, ~3 flags each) | Suppressed as `NOT_COMPARABLE` on a leave day (config `compareScheduleColumnsOnLeaveDays`, default off); `LEAVE TYPE`/`LEAVE HR` still compared — those are the genuine pay-affecting checks. See §7b. |
| `LEAVE HR` compared Cognos's full-day entitlement against ASPECT's always-zero summed duration for full-day-by-design leave codes (`ANNUAL`/`P/H-LV`/`OFF` — no real `DURATION` in ASPECT by design), which would have reported a fake pay gap on all 107+ real ANNUAL rows | Three-state comparison: only comparable when ASPECT recorded a REAL duration (config `leaveCodesWithoutDuration` lists the full-day-by-design codes). A leave code that DOES carry a real duration (e.g. `LEAVE`) is still compared normally — a genuine half-day mismatch is real pay. See §7b. |
| `COVER` extended `rawEnd`/`effectiveEnd` like any other addition segment — an unattended cover placed after shift end was charged once as Early Logout AND again as Cover Not Attended, emitting two `ABSENT` correction rows for one day | `COVER` excluded from the attendance-window derivation by default (config `coverExtendsAttendanceWindow`) while still counting toward `netScheduledMinutes`. A CSV-level dedupe also collapses any remaining identical day-level ABSENT markers as a backstop. See §7b. |
| D-D: punch-attribution ties broke by Cognos row order (first-registered window wins) — a night shift's closing punch could be lost to a next-day leave-day placeholder purely because of file order, producing two false absences from one tie | Priority cascade: a real scheduled shift beats a synthetic leave-day window; a remaining tie goes to the earlier-starting window; anything still tied is held for review (`AMBIGUOUS_PUNCH_ATTRIBUTION`) instead of guessed. See §7b. |
| Rule 7 (Cover Not Attended)'s `markAbsent` branch pushed the `ABSENT` correction row but never called `convertOtSegmentsToShift` (§4.6c) — every other Absent-emission point converts that day's `OT1`/`OT2` to `SHIFT`, but a cover-not-attended Absent left OT premium pay untouched on a day the employee was just marked absent | `reconciliationEngine.ts`'s Rule 7 block now calls `convertOtSegmentsToShift` from its `markAbsent` branch, same as every other Absent branch. PRD §4.6c's trigger list updated to name Rule 7 explicitly. Regression `reg-27`. |
| Adding Rule 7 to §4.6c surfaced a broader, pre-existing risk: on a standard (non-flex) row, Late Login and Early/Late Logout are independent `if` statements (not an if/else chain — KB line ~296), so both can fire Absent on the same row, and now Rule 7 is a third independent site — each call to `convertOtSegmentsToShift` for the same OT segment pushes a byte-identical `SHIFT` correction row. The final downloadable CSV was already protected by `dedupeAspectCorrections`, but that is a cleanup pass over the merged output, not a guarantee at the point of emission — and a duplicated/re-changed segment in a real ASPECT upload gets the **whole batch rejected**, so relying on cleanup alone was rejected as insufficient | Added a per-employee-day idempotency guard: each loop iteration (one Cognos row = one employee-day) now declares its own `otConvertedThisRow` flag and a `convertOtOnce()` closure; all 11 call sites (including Rule 7) go through it, so the underlying conversion can structurally run at most once per employee-day regardless of how many Absent rules fire or in what order. `dedupeAspectCorrections` is kept as a defense-in-depth backstop, not removed. Regression `reg-28` proves both findings (Late Login AND Early Logout) are still independently reported while the OT segment converts exactly once. |
| The Cognos↔ASPECT join key was a raw string compare on the ASPECT side — the real sample files (one day apart) produced 502/502 `COGNOS_DATA_GAP` with zero corrections and no warning; the segment glossary's case-sensitive lookup held 261/1,389 real employee-days as `UNCLASSIFIED_SEGMENT_CODE`; the §5.4 flex algorithm ran unconditionally regardless of scheduled start; `DUTY1`/`DUTY-2` were split by time gap instead of role, so `duty2Block` was permanently null on every real overtime day; and 5 Cognos comparison columns reported `MISMATCH` for a Login ID with no CMS record at all anywhere in the export | 10 defects (D1-D4, D6-D10) found and fixed by compiling the engine and running it against the real `samples_Files/` exports directly rather than reading code — full detail, measured before/after numbers, and 2 investigated-but-not-fixed findings (evidence disproved the original hypothesis in both) in §7d. |

High-value regression cases documented in the research plan include Eman Eltayeb and Minas Alabbas (trailing NURSNG should yield no early-leave action), PF `90135621` (overnight early arrival should be present), PF `4507957` (23:08 login on a 23:00 start is eight minutes late, correctly Late+Cover, not U-ABSENT; a separate 28/08 OT2 record must not be skipped by the no-SHIFT gate), a flex employee arriving 10:01 past the cutoff (1-minute Late+Cover, shift clamped to 10:00, not 181 minutes late), and Cognos's own worked example (Sch shown as 8:00 vs. login 7:40, but a 30-min RLS deduction means the true net scheduled figure is 7:30 — the corrected number, not Cognos's, must drive the verdict).

### 7a. Trust matrix — independent ground-truth validation (`trustMatrix.ts`)

`TAA_HTML/src/services/trustMatrix.ts` is a second, independent test source alongside
`regressionSuite.ts`: ~145 declarative cases spanning Shift/OT/RLS/Late/Cover/Nursing
combinations, with expected verdicts hand-derived from `Rules to be taken.csv` and this
document's non-negotiables — never by calling the engine's own decision code, so a passing
case is a real second opinion, not self-agreement. Runs in-app as the "Trust Matrix" tab next
to the existing Regression Suite (`RegressionSuiteView.tsx`).

Three rulings (user-confirmed) were fixed in `reconciliationEngine.ts`:

| Risk (confirmed, FIXED) | Fix applied |
|---|---|
| Two policy rules firing on one Cognos row (e.g. late login AND early logout) — engine emitted both corrections but `TAA_ACTION` reported only the last-evaluated rule and email `variance_minutes` kept only the first, under-reporting the row | Both rules are corrected AND both reported. `chargedVarianceMin` now sums across every fired minute-band rule (Late Login + Early/Late Logout) instead of keeping only the first. New `TAA_ACTIONS_FIRED` field (`ReconciliationRow`, also in the annotated CSV and the email body when >1 action fired) lists every distinct action code that fired the row, alongside the existing single most-severe `TAA_ACTION`. Trust matrix family F12; verified live (`f12-OPS-late-and-early`: `charged=22m` = 10+12, `Corrections emitted: LATE, COVER, ABSENT`). |
| Late Logout (≥60min → Absent) was measured against the RAW shift end (`reconciliationEngine.ts` used `rawEndDt`) while Late/Early Logout correctly used the release/nursing-adjusted EFFECTIVE end | Late Logout now measures from `effectiveEndDt`, same as Early Logout — NURSNG/RLS/RLS-2H/RLS-3H/UN_RLS/Cover_RLS all reduce the shift the same way. A shift 07:00–15:00 with NURSNG 14:00–15:00 truly ends at 14:00; logging out at 15:01 is now correctly 61min past the real end. Trust matrix family F3, 145/145. |
| CMS evidence ("single punch" / Rule 6) was punch-COUNT based (`matchingPunches.length <= 1`) and the flex branch skipped this check entirely — a flex employee with one genuine swipe was evaluated as a normal arrival instead of Absent | Flex now runs the same evidence/coverage guard as the standard path (`insufficientEvidence`/`insufficientCoverage`, already span-based via Min-login/Max-logout) before evaluating Branch A/B — inserted ahead of the existing zero-punch check, with a new genuine-single-punch branch mirroring the standard path's Rule 6. Confirmed against the real CMS export format: `CMS_Login_logout.csv` is one row per SWIPE EVENT (login/logout on a row are the same badge tap, ~3s apart) — a normal day is two rows. `regressionSuite.ts` cases `reg-7`/`reg-8` (flex) were also corrected from an unrealistic single spanning CMS row to two realistic swipe rows, since they only passed before by relying on the now-removed flex exemption. Trust matrix family F4, 145/145. |

A fourth finding, `f10-leaveday-after-nightshift-tiebreak` (D-D), had no ruling and was not fixed
as of §7a: `punchAttribution.ts`'s window-assignment loop used strict `<` on distance, so a tie
was won by whichever Cognos row appeared first in the input — order-dependent. **Now resolved,
see §7b** — user-confirmed ruling: a real scheduled shift beats a synthetic leave-day window on a
tie; a remaining tie goes to the earlier-starting window; anything still tied is held for review.

### 7b. Real-sample-data audit (2026-09-02; completed 2026-09-06)

A follow-up audit validated the engine against the actual files in `samples_Files/` (not just
`regressionSuite.ts`/`trustMatrix.ts` synthetic fixtures), specifically the CMS-vs-Cognos join,
cross-midnight handling, and the Cognos comparison layer. Confirmed correct: CMS parsing (cols
5–6), the cross-midnight time-window join itself, the `Σ ADDITION − Σ REMOVAL` scheduled-hours
formula (including the 17 team/queue tags carrying full-shift-length durations, correctly
`NO_EFFECT`), the effective-window late/early/late-logout math, and full-variance charging. Six
real defects found and fixed (table in §7, user-confirmed rulings before implementation):
`MISSING_CMS_JOIN_KEY` hold for blank Login ID; the sentinel guard extended to `LATE START` and
made structural (`-LEAVE HR`); leave-day `DUTY1`/`DUTY-2`/`SCH DURATION` suppression; the
`LEAVE HR` three-state comparison (`leaveCodesWithoutDuration`); `COVER` excluded from the
attendance window (`coverExtendsAttendanceWindow`) plus an ASPECT-correction-CSV dedupe backstop;
and the D-D punch-attribution priority tie-break. All 9 new regression cases (`reg-18`–`reg-26`,
built from the real row patterns) pass, and the pre-existing 17 regression + 145 trust-matrix
cases show no regression (26/26 and 145/145) as of this audit.

**Current state (2026-09-06):** the suite now includes `reg-1`–`reg-63`. Cases `reg-59`–`reg-63`
cover strict calendar/time parsing, semantic CMS validation, specific leave-code selection,
locked invalid ASPECT datetime evidence, and the exact `Code=00`/trailing-comma/held-row CSV
contract. Current totals: **63/63** regression + **145/145** trust matrix.

Verifying against the real files directly (not just fixtures) surfaced two further findings;
both are now fixed:

1. **`LEAVE TYPE` can report a false code mismatch when ASPECT carries two competing leave
   segments for the same day** — e.g. a generic `LEAVE` segment (with real times/duration)
   alongside a specific reason code like `ANNUAL`. At the time this was found, `reconciliationEngine.ts`'s
   `empSegs.find(s => ...isLeaveGateExclusion)` picked whichever was listed first in the ASPECT
   file, which may not be the code Cognos reports, producing an avoidable MISMATCH even though
   both sides agree the day is genuinely on leave. Measured on the real data (via a temporary
   date-aligned copy of `ASPECT_Schdule_Segments.csv`, since the shipped Cognos/ASPECT samples
   are dated one day apart and never share a real employee-day): 90 of 304 genuine leave-day rows
   are affected. The engine now prefers a non-generic leave code over literal `LEAVE`; `reg-61`
   verifies `ANNUAL` is selected and matches Cognos. **Since superseded:** the engine no longer
   uses `.find()`/`isLeaveGateExclusion` at all — it now does
   `empSegs.filter(s => isCodeInConfiguredSet(s.SEG_CODE, config.leaveSegmentCodes))`
   (`reconciliationEngine.ts:1355`), a full filtered set keyed off the dedicated
   `config.leaveSegmentCodes` array, with the per-code flag retired. See `PRD.md` §Leave Segments.
2. **`SIGNIN DURATION` treats Cognos's `"00:00"` as a real zero**, not as a possible
   no-attendance placeholder — `parseBlankableHHMM('00:00')` returns `0`, which then compares as
   MISMATCH against a `null` recompute whenever there are no CMS punches for that row at all. It is
   now treated as structural no-attendance when both Cognos punch fields are blank; `reg-58`
   verifies `NOT_COMPARABLE` instead of a false mismatch.

### 7c. Payroll date/time and correction-CSV audit (2026-09-06)

- `parseDateTimeString()` accepts only documented local `DD/MM/YYYY` and `YYYY-MM-DD` forms with optional time, validates the real calendar and `00:00:00`–`23:59:59` ranges, and has no native locale fallback. Bare ASPECT dates still mean midnight.
- CMS validation now checks semantic dates/times, reconciles time-only columns with the full datetimes, rejects reversed punches, and rejects the complete file if any data row cannot produce a punch.
- ASPECT schedule-defining additions/removals with malformed, incomplete, reversed, or start-date-conflicting timestamps are locked as `INVALID_ASPECT_DATETIME`. Completely bare removals (no duration, no timestamps) are NOT invalid: since 2026-09-21 they are full-day segments — duration = the day's own scheduled duration (SHIFT+OT+COVER), config default 480 only when the day has no schedule; deducts the remaining schedule and raises the soft `FULL_DAY_REMOVAL_ON_SCHEDULED_DAY` hold (this reverses the earlier "held, never defaulted" rule, `reg-53`). A bare non-schedule-defining addition is treated the same way but never adds on top of an existing schedule.
- All forced holds are defined once and enforced in the engine, row toggle, bulk toggle, and Results UI. Invalid Config Registry clocks use `INVALID_CONFIG_TIME`; only `MISMATCH_FOUND` remains reviewer-overridable.
- Calculate now evaluates both the regression suite and the independent trust matrix. The trust oracle's leading-release endpoint test was corrected; all 145 cases pass.
- Real-file verification: 4,683 ASPECT rows contain zero invalid schedule datetime values; the 39-row CMS sample passes strict validation. The 502 Cognos rows remain correctly locked as `COGNOS_DATA_GAP` because Cognos is dated 27/08/2026 while ASPECT starts 28/08/2026. The resulting ASPECT CSV contains only the exact trailing-comma header.

### 7d. Upload→match→calculate re-audit (2026-09-07)

A 4th audit — this time by compiling the real engine (`esbuild` bundle of `TAA_HTML/src/services/*`)
and running it under Node directly against the real files in `samples_Files/`, rather than reading
code — found the §7c "correctly locked as `COGNOS_DATA_GAP`" state above was itself the headline
defect: **the real files produce 502/502 `COGNOS_DATA_GAP` rows with zero corrections and no
warning to the user**, because ASPECT's `NOM_DATE` join key was a raw string compare while
Cognos's side was already normalized. Forcing the two dates to align in a test copy surfaced 9
more real defects behind it. All are fixed except two investigated and deliberately left alone
(with the evidence for why); numbers below are measured, not estimated.

| # | Defect (confirmed) | Fix applied |
|---|---|---|
| D1 | ASPECT `NOM_DATE` joined via `seg.NOM_DATE.trim()`, a raw string, while Cognos `SIGN IN DATE` was already normalized through `parseDateTimeString`→`formatDateDDMMYYYY` — an un-padded ASPECT date (`1/9/2026`) could never match a zero-padded Cognos date (`01/09/2026`), and nothing warned when the two files simply covered different days | `parsers.ts`'s new `normalizeDateKey()` used on both sides of every join/lookup site (`segmentGroups`, `placeCoverSegment`'s target-day lookup). New `punchAttribution.ts`'s `assessDateOverlap()` surfaces a non-blocking advisory in the upload UI before Calculate, naming every Cognos-only/ASPECT-only date — verified: the real files ARE one day apart (Cognos 27/08/2026, ASPECT 28/08/2026), and this is now visible instead of silent. |
| D2 | Segment-glossary lookup was case-sensitive (`glossary[s.SEG_CODE]`) but `parseAspectSegments` uppercases every `SEG_CODE` on import; 13 of `DEFAULT_SEGMENT_GLOSSARY`'s own keys were mixed-case (`Cover_RLS`, `TRN Planned`, `Prestige Arb`, ...) — 11 of them occur in the real ASPECT export, holding 261 of 1,389 real employee-days as `UNCLASSIFIED_SEGMENT_CODE` for no reason, and `Cover_RLS`'s REMOVAL role could never fire against real `COVER_RLS` rows | New `lookupGlossary()` in `scheduleRecompute.ts` (case-insensitive, used at all 8 glossary-read sites); all 13 default keys uppercased; a user's saved/imported config's glossary keys are normalized the same way on load (`normalizeSegmentGlossaryKeys`) so an older exported config still collapses onto the current keys instead of duplicating them. Verified: 0 unclassified codes and `COVER_RLS`'s release correctly subtracted (effective end moves from 16:00 to 15:30 in the reproduction case). |
| D3 | The §5.4 flex algorithm (absolute 10:00 cutoff) ran for ANY flex-tagged employee regardless of their actual scheduled start — a flex agent on an afternoon/night shift with perfect attendance was measured against the 10:00 cutoff as if hours late | New `isFlexScheduleWithinExpectedWindow()` gates entry to the flex branch on `config.flexExpectedSchedStartWindow` (default 07:00-10:00); outside it, standard attendance rules apply and the row is held `FLEX_SCHEDULE_OUTSIDE_WINDOW` for a human to confirm the tag/schedule. Verified: flex, shift 14:00-22:00, arrival/departure exactly on time — was `ABSENT` with a fabricated 480-minute charge and a 4-hour COVER; now `PRESENT`, 0 charged, held for confirmation rather than corrected silently. |
| D4 | 8 correction-emission sites hardcoded ASPECT `SegmentDate` to the shift's nominal day even when the row's own `SegmentStarttime` came from a cross-midnight instant (doc/aspect.md §2's field-4/field-5 distinction requires the PHYSICAL day) | New `formatSegmentDate()` derives `SegmentDate` from the same `Date` the row's `SegmentStarttime` came from, applied to `Log_off`/`LATE`/the flex shift-update pair (both branches)/`COVER`. Verified: a shift 19:00→03:00 with an 02:52 early logout previously wrote `SegmentDate` as the day BEFORE the logout (24h off); now correct. `COVER`'s date is now the cover's own start instant, not the target day's `NOM_DATE` bucket key (a night-shift target day or a stacked cover can push the actual start past midnight). |
| D6 | `DUTY1`/`DUTY-2` were split by merging ADDITION segments on a TIME GAP (`perBlockGapThresholdMinutes`, default 60) rather than by role — verified on every one of the 192 real employee-days carrying both a SHIFT and OT1/OT2: the OT segment always starts the INSTANT the shift ends (0-minute gap in all 192), so the gap merge could never separate them; `duty2Block` was permanently `null` on any real overtime day | `scheduleRecompute.ts` now builds `duty1Block` from every non-OT addition and `duty2Block` from OT1/OT2 alone, each still internally merged within the gap threshold (now strict `<`, not `<=`). Verified: all 192/192 real SHIFT+OT days now correctly split; `DUTY1` mismatch count against real Cognos data dropped 121→77. |
| D7 | `cognosComparison.ts`'s CMS-derived columns (`SIGIN IN`/`SIGIN OUT`/`LATE START`/`LEFT EARLY`/`SIGNIN DURATION`) reported `MISMATCH` whenever the recompute had no value — including when the CMS export holds NO record at all for that Login ID (missing evidence, not a disagreement). This was the single largest source of false mismatches: ~309-310 of 502 real rows on each of the 5 columns | `ComparisonContext.hasAnyCmsData`, sourced from `punchAttribution.ts`'s own already-computed "any data for this login" signal (not re-derived), threaded into all 5 comparison sites; each returns `NOT_COMPARABLE` instead of `MISMATCH` when true. A login that DOES have data but nothing fell inside the window's search radius still reports a genuine `MISMATCH`. Verified: real-data mismatches on these 5 columns collapsed from ~310 each to 1 each; clean (unheld) rows rose from 122 to 303 of 502 in the reproduction run. |
| D8 | §7b's leave-code fix (`prefer a non-generic code over LEAVE`) still picked whichever specific code came FIRST in ASPECT row order when a day carried more than one — verified: 108 real employee-days carry >1 leave code; `ANNUAL vs P/H-LV`/`ANNUAL vs OFF` accounted for 28 further false mismatches | Two-step preference in `reconciliationEngine.ts`: (1) if Cognos's own `LEAVE TYPE` value genuinely IS one of the day's real ASPECT leave codes, report that one (never fabricates agreement — only fires when it's really present); (2) otherwise prefer a specific code over `config.genericLeaveContainerCodes` (default `['LEAVE']`, config-driven per §6.4 zero-hardcode, replacing the old hardcoded `!== 'LEAVE'` check). |
| D9 | `LEAVE TYPE` reported `MISMATCH` when BOTH sides were absence-verdict values with different spellings (e.g. Cognos `U-ABSENT` vs TAA `Absent NS/NC`) — the existing verdict-suppression guard required the recomputed side to be a GENUINE leave code, so two verdict values fell through to an exact string compare and never matched | New branch: both sides in `config.cognosLeaveTypeVerdictValues` → `MATCH` (same conclusion, different vocabulary). Verified: 30 real rows affected (`U-ABSENT`/`Absent NS/NC` 21, `ABSENT`/`Absent NS/NC` 8, 1 other). |
| D10 | `SCH DURATION` was compared against `netScheduledMinutes` — release/nursing-ADJUSTED and OT-INCLUDED — but Cognos's own figure is neither; measured exact-match rate against 198 real non-leave rows was only 84/198 | Compared against `duty1Block`'s own span (the base, non-OT scheduled span from the D6 blocks), falling back to `duty1Block + duty2Block` only when `duty1Block` is empty (a standalone-OT day with no base shift at all — Cognos's figure then necessarily reflects the OT hours instead). Raises the match rate to 103 exact + 11 within the 1-minute tolerance (114/198) — the best of every formula measured (duty1-only alone: 102; duty1+duty2 always: 83, an earlier attempt at this fix that measurably regressed 3 real NURSNG-carrying employee-days before being corrected; `netScheduledMinutes` minus OT: 102). Real Cognos SCH DURATION is not perfectly self-consistent even between near-identical rows — 3 of the 4 real NURSNG-carrying employee-days show a release-adjusted figure, the 4th shows raw — so no formula reproduces every row; this is the closest reliable approximation, not a guarantee. Does not change `TAA_SCH_HOURS_RECOMPUTED` (still `netScheduledMinutes`, the correct pay figure). |
| — (14) | An uploaded date column where every parsed date has day ≤12 is silently consistent with a swapped US-style `MM/DD/YYYY` export — such a file parses with no error, just transposed | New `detectDateFormatAmbiguity()` in `parsers.ts`, checked at upload for both ASPECT `NOM_DATE` and Cognos `SIGN IN DATE`; advisory only, never blocks. |

Two findings from the same audit were investigated and deliberately NOT fixed — evidence
contradicted the original hypothesis in both cases:

- **D5 (odd CMS punch count ≠ missing evidence).** The original hypothesis — an odd count of
  CMS punch-events attributed to a window means one login/logout genuinely has no counterpart —
  is disproven by `trustMatrix.ts`'s own `f4-*-triple-swipe` family (4 existing cases), which
  deliberately tests a 3-swipe "lunch break badge" day (arrive, one midday swipe, depart) and
  expects `PRESENT`, with the documented rationale "Min/Max span still gives correct on-time
  verdict." A gate on odd counts broke all 4 of those cases. The original reproduction case (3
  punches on an 8-17:00 shift, read as a 240-minute early logout) was genuinely thin evidence,
  but an EVEN-count case with the same missing-swipe problem would misread identically — parity
  is not a reliable signal either way. No fix applied; the min/max evidence model is correct as
  designed.
- **D11 (`SIGNIN DURATION` span vs. sum-of-sessions).** The original ~37/310-agreement measurement
  was entirely confounded by D7 (no-CMS-data cases dominating the "mismatch" count) — after
  fixing D7, the real sample (one CMS-linked agent, all simple in/out pairs, no lunch-break gaps)
  shows 0 remaining `SIGNIN DURATION` mismatches, so there is no real-data evidence left to
  validate a "sum of sessions" formula against. `SIGNIN DURATION` is also explicitly documented
  (§8, item 2) as QA-only — it never drives `TAA_VERDICT` or pay. Implementing an untested
  session-pairing algorithm risked the same kind of regression D5 nearly caused, for a
  non-pay-affecting column with no real-data need. Left as a min/max span, unchanged.

Real-file verification totals after this audit's fixes: `assessDateOverlap` correctly reports the
real files' 1-day mismatch; on a date-aligned test copy, `MISMATCH_FOUND` holds fell 460→169 of
502 and clean (unheld) rows rose 35→328 — both from the same 502-row real dataset used throughout
§7b/§7c, not a different sample. Regression suite grew to `reg-1`–`reg-66` (`reg-64`–`reg-66`
decode/parse trimmed byte-faithful excerpts of the real `samples_Files/` exports through the
actual parsers — see `sampleFileFixtures.ts` — rather than constructing objects directly, closing
the coverage gap that let D1/D2 survive three prior audits); trust matrix remains 145/145.

### 7e. Email/VBA handoff contract audit (2026-09-07)

The trust matrix (145 cases) and regression suite (66 cases) were confirmed 100% passing against
the live engine — no drift, nothing to triage. Both were also made runnable headlessly for the
first time (`npm run test:trust-matrix`; `regressionSuite.ts` still lacks one, see §8). Separately,
a new cross-file contract test (`emailVbaContract.test.ts`) checking the JS side of the email JSON
handoff (`emailDrafts.ts`) against the VBA companion's own validators (`TAA_VBA_Companion.bas`)
found one real, previously untested defect:

| # | Defect (confirmed) | Fix applied |
|---|---|---|
| D12 | `TAA_JsonValue`'s unescape sequence applied `\\` → `\` LAST instead of first, so a literal backslash immediately followed by `t`/`n`/`r`/`"` in a JSON string value (e.g. a Windows path `C:\temp`, common in `section`/`body`/`name` fields) was misread as one of those control escapes — silently corrupting the text written into the real Outlook draft. No error was raised; the wrong character just appeared. | Swap `\\` to a `Chr(1)` sentinel (never appears in real JSON text) before the `\"`/`\r`/`\n`/`\t` rules run, then restore the sentinel to `\` last. Verified via `emailVbaContract.test.ts`'s round-trip test on a body containing a backslash, quote, tab, newline, and braces together; the test file also keeps a "sanity check" assertion proving the pre-fix ordering fails on the same input, as a regression guard against reintroducing the bug. |

`TAA_ParseActionObjects`'s brace-depth object scanner was also audited (does a stray `{`/`}`/`[`/`]`
inside a text field desync it?) and found robust — pinned as a regression test, not a bug fix.
Filename/request-ID validators (`TAA_IsSafeEmailFileName`/`TAA_IsSafeRequestId` vs.
`isSafeEmailDraftFileName`) were confirmed in agreement across a shared fixture table, including
against the real `DEFAULT_CONFIG` values.

A full engine-vs-domain-rules re-audit (reading `scheduleRecompute.ts`'s contiguous-block builder
against the confirmed domain rule "when a staff member has two shifts, the second is in DUTY-2")
found one more defect directly downstream of D6's own fix, reproduced by direct execution before
being fixed:

| # | Defect (confirmed) | Fix applied |
|---|---|---|
| D13 | D6 split `duty1Block`/`duty2Block` by role (non-OT vs. OT1/OT2) to stop OT swallowing the shift block, but `mergeIntoBlock` built the correct per-group `blocks[]` array and then collapsed it to `{start: blocks[0].start, end: blocks[last].end}` regardless of `perBlockGapThresholdMinutes` — so (a) the config knob was dead: any gap, however large, was silently absorbed into one span, and (b) a genuine SECOND SHIFT segment (not OT) fell into the same non-OT group as the first and was swallowed by the same collapse, corrupting both DUTY1 (bloated to span the gap) and DUTY-2 (left blank) on any real two-shift day. Reproduced: DUTY1 `07:00-15:00` + DUTY-2 `16:00-17:00` in ASPECT recomputed as DUTY1 `07:00-17:00` (MISMATCH), DUTY-2 empty (MISMATCH) — and since Cognos's own SCH DURATION (D10) is independently documented as not perfectly self-consistent, a wrong-but-coincidentally-matching pair was not provably impossible, risking a silent false MATCH rather than the safe hold. | `mergeIntoBlock` renamed `mergeIntoBlocks`, now returns every distinct block instead of collapsing them — the A4 half of the fix. Assignment then covers exactly the domain-confirmed shapes: 1 non-OT block with ≤1 OT block behaves as before (duty1=shift, duty2=OT); 2 non-OT blocks with 0 OT blocks assigns duty1=earlier, duty2=later (the genuine second-shift case, A2). Any other shape (3+ non-OT blocks; a real second shift co-occurring with real OT; OT itself splitting into >1 block) is left with `duty2Block = null` and a new `scheduleShapeUnresolved` flag rather than guessed — the existing `MISMATCH_FOUND` hold mechanism already catches whatever Cognos disagrees with, with the flag threaded into the row trace so the reviewer knows why. Verified as comparison-only: a byte-identical before/after diff of every payroll-affecting field (`rawStart`/`rawEnd`/`effectiveStart`/`effectiveEnd`/`netScheduledMinutes`/verdict/action/the ASPECT correction CSV) over the full sample dataset confirmed nothing pay-affecting moved — `duty1Block`/`duty2Block` never feed those, only Output 2's DUTY1/DUTY-2/SCH DURATION comparison columns. New coverage in `scheduleRecomputeBlocks.test.ts` for every shape above. D10's SCH DURATION formula, tuned against the sample (which has no confirmed genuine two-shift day), now sees a correctly-bounded `duty1Block` on such days and should be re-verified against real two-shift rows when available — flagged in `cognosComparison.ts`, not re-tuned here. |

**Caveat (historical — moot since §7g):** at the time of this 2026-09-07 fix, `TAA_VBA_Companion.bas`
was the source of truth (imported by `vbaGenerator.ts`), but `TAA_VBA_Companion.xlsm` carried its
own copy of the module, so this fix wasn't live for users until re-imported into the workbook.
**Both files, and the entire VBA Companion, were deleted the next day (§7g, 2026-09-08)** — there
is nothing left to re-import, and this caveat no longer applies to anything in the current app.

### 7e. CMS auto-export removed; email bridge no longer needs a folder grant (2026-09-08)

**Superseded by [7f](#7f-taa-email-vba-bridge-removed-entirely-eml-download-replaces-it-2026-09-08)
later the same day.** The design below (download the request JSON, fire `taa-email:`, Excel
runs `RunEmailDraftRequest`) is what shipped first; the "Not verified" flag at the bottom of
this entry — whether the protocol launches from `file://` — is what triggered the next
conversation, and the answer turned out to be simpler than expected: the protocol was never
even *registered* on the test machine, and once that was fixed, the user's real objection
wasn't the protocol launch at all, it was Excel visibly opening and closing for every draft.
That objection is what 7f actually resolves. Kept below for the historical reasoning, not as
current behavior.

User-requested simplification of the whole local-launch flow — the original ask was "why do I
need to run `TAA_Launch.bat` before the app," which traced back to two features both depending
on a browser folder grant that only works reliably from `http://localhost`, never from a plain
double-clicked `TAA_Workspace.html`:

1. **CMS auto-export removed entirely.** The user now runs CMS export via their own automation
   outside the app. `ProjectFolderGate.tsx` and `services/projectFolder.ts` are deleted; the
   dashboard's CMS-auto-trigger `useEffect`, `handleRunCmsExportNow`, and the folder-mirroring of
   uploaded Cognos/ASPECT/Identity files (which only existed to feed `RunCMSExport`'s
   `CMS_AGENTS_SOURCE=COGNOS_AUTO` derivation) are gone from `App.tsx`. CMS punches are now
   always a plain manual upload — `UploadZone.tsx` needed **no code change**, since it already
   had a manual-upload fallback for whenever `cmsAutomationActive` was false.
2. **The email draft bridge (`taa-email:`) no longer requires any folder.** The two bugs found
   while implementing this: (a) the browser wrote into the *granted* folder while
   `RunEmailDraftRequest` read from `ThisWorkbook.Path` — the two only ever agreed by
   coincidence, never by design; (b) with CMS gone, the folder had no other reason to exist.
   Fix: `ResultsView.tsx`'s `launchEmailDraftRequest` now downloads the request JSON (the only
   file operation available with zero permission) as `TAA_Email_Draft_Request_<request_id>.json`
   — unique per click, so the browser never appends " (1)" and the companion never reads a stale
   file — then fires `taa-email:run?...` exactly as before. `TAA_Email_Launcher.vbs` resolves the
   user's real Downloads folder via the "User Shell Folders" registry key (not a
   `%USERPROFILE%\Downloads` guess, which is wrong on OneDrive-redirected profiles) and passes it
   to `RunEmailDraftRequest` as a new optional 4th `folderPath` argument, used instead of
   `TAA_EmailFolderPath()` when supplied. The browser no longer polls for a result —
   `RunEmailDraftRequest` now shows a `MsgBox` unconditionally (matching legacy `RunEmailDrafts`'s
   wording), which is the only feedback channel for this path. `status.json` is still written
   next to the request as an audit artifact; nothing reads it back.

**Net effect: `TAA_Launch.bat` is no longer required anywhere in the normal flow.**
Double-clicking `TAA_Workspace.html` directly is sufficient: pick the 4 files (CMS now always
manual), Calculate, click a row's mail icon or Bulk Draft — Outlook opens the drafts, Excel shows
the result. The `.bat` remains available only for anyone who wants to watch the server console.

**Verified:** full test suite green (`test:features`, `test:email-vba-contract` — extended with a
request_id-suffixed-filename fixture, `test:trust-matrix` 145/145, `test:schedule-blocks`),
`tsc --noEmit` clean, build+assemble succeeds, and the assembled `TAA_Workspace.html` was loaded
in a browser and walked end to end: no CMS Auto-Export card renders anywhere, the mail
icon/Bulk Draft button carry no folder-related disabled reason, and the Config Registry's Email
Drafts panel no longer shows the now-meaningless fixed-filename fields.

**Not verified — flagged, not silently assumed:** `window.location.href = 'taa-email:...'` fired
from a page opened via `file://` (as opposed to `http://localhost`, which is how every previous
test of this protocol happened) could not be tested in this environment — there is no real
Windows/Outlook/registry available here. Confirm on the real machine before relying on this;
Chrome's handling of external-protocol launches from `file://` origins has been stricter in some
versions. If blocked, the documented fallback (download "Email Actions JSON", run `RunEmailDrafts`
manually) already works today and needs no code change.

### 7f. `taa-email:` VBA bridge removed entirely; `.eml` download replaces it (2026-09-08)

**Root cause of 7e's "Not verified" item, found by actually checking:** `reg query
HKCU\Software\Classes\taa-email` on the test machine returned nothing — the protocol was never
registered (`Install_TAA_Protocol.bat` ships in the repo but had never been run). That fully
explained the mail icon doing nothing; it was never a `file://`-vs-`http://` Chrome quirk.

**But that fix didn't address the user's actual complaint once stated plainly:** *"i need a
smart, simple way to send the emails through outlook without open and close the excel or click
the .vbs or .bat file — this is confusing, what about the user?"* Investigation (grepping the
real `.bas`) confirmed Excel had never been load-bearing for this path: `RunEmailDraftRequest`
read no worksheet data, only three `Config`-sheet values each with a hardcoded fallback
(`EMAIL_MAX_DISPLAY_COUNT`, legacy `OPS_MAILBOX`, `EMAIL_CORPORATE_DOMAINS`), and its own audit
log was thrown away anyway (`wb.Close False` in the launcher). Outlook was the only genuinely
required piece — GAL lookup for a bare alias, `GetExchangeUserManager` for the CC.

**Constraint that shaped the redesign:** the user then set a hard requirement — *"keep the click
and deal only within the HTML file, not outside this."* That rules out Excel, VBScript,
PowerShell, and any registered protocol handler; the only remaining browser capability with zero
permission is a plain file download.

**What that costs, measured against the real sample data before committing to it:**
- A `mailto:` link breaks past ~2,000 characters. Individual staff notices fit (~1,000 chars
  encoded); real OPS Section digests do not — measured 5,000–20,000 characters for 5–50 pooled
  cases, and the app's own `EMAIL_MAX_DISPLAY_COUNT` config existing at all is evidence that
  digest volume was always expected to be large. **Resolved by downloading a `.eml` file
  instead** (`services/emlBuilder.ts`) — no size ceiling, and `X-Unsent: 1` makes Outlook open it
  as a normal editable draft on double-click, not a read-only received message.
- No file in the dataset contains manager/supervisor information — not Cognos, not either ASPECT
  identity file. Exchange's `GetExchangeUserManager` was the only source, and a browser cannot
  reach Exchange. **Resolved by making it optional, uploaded data**: `employeeManagerMap`
  (Config Registry + Email Config Wizard, CSV import/export, same pattern as the existing
  `sectionMailboxMap`), keyed on `emp_id`. No mapping for an employee simply means no CC on that
  draft — never an error, never a held/review flag. User's explicit instruction: *"if manager
  found put instead the cc if not then no cc."*
- Without Exchange, the browser cannot verify an address resolves — it can only apply the same
  trust rules VBA used to, with no confirmation signal. Real risk in the data: 30% of
  `EMP_EMAIL_ADR` values sit on personal domains (`al_wafa@hotmail.com`) whose local part
  belongs to a *different* employee's real alias (`ashamsi`) — stripping and using it can
  silently address a disciplinary notice to the wrong person. **User's explicit priority order,
  stated after an initial name-first draft was rejected:** *"if u have a username it must be
  username don't take the full name, if u don't have the username then in this case only u may
  take the full staff name."* Implemented as three strict rules in
  `emailDrafts.ts`'s `resolveEmailRecipient`: (1) a username (`EMP_EXTRA_2`) always wins —
  `<username>@<corporate domain>`; (2) no username but a corporate-domain `EMP_EMAIL_ADR` — used
  as-is; (3) neither — the full Cognos `NAME`, subject prefixed `[VERIFY RECIPIENT]`, so
  Outlook's Check Names forces a human to confirm who this actually is. A name is safe there
  specifically *because* Outlook won't resolve it silently; a wrong alias is dangerous
  specifically because it does. This also fixed a latent bug in the pre-existing
  `resolveOutlookRecipient`, which used to fall back to `EMP_LAST_NAME` even when a real username
  was available in a different field order than intended — same failure class, present before
  this change too.

**Filename scheme, per explicit user request** (so files are identifiable at a glance in
Downloads, unlike the old opaque `request_id`-suffixed names): `Action_PFxxxx_DDMMYYYY.eml`,
e.g. `LateLoginAbsence_PF8768787_08102026.eml`; a pooled OPS digest has no single employee, so it
uses the Section instead: `OpsDigest_COLL-RET_27082026.eml` (sanitized — `&`/spaces collapse to
`-`). Collisions within one batch get a numeric suffix.

**Deleted outright:** `TAA_CMS_Automation/TAA_Email_Launcher.vbs`, `Install_TAA_Protocol.bat`;
`RunEmailDraftRequest` and its request/status-only helpers (`TAA_ConsumeRequestFile`,
`TAA_WriteEmailStatus`, `TAA_JsonStringArray`, `TAA_JsonEscape`, `TAA_WriteUtf8Atomic`,
`TAA_IsSafeEmailFileName`, `TAA_IsSafeRequestId`, `TAA_EmailFolderPath`) from
`TAA_VBA_Companion.bas`; `createEmailDraftRequest`/`serializeEmailDraftRequest`/
`buildEmailDraftProtocolUrl`/`isSafeEmailDraftFileName`/`parseEmailDraftStatus` and the
`EmailDraftRequest`/`EmailDraftStatus` types from the TS side. **Kept, unchanged, still fully
working:** `RunEmailDrafts` (Alt+F8 manual fallback, its own file picker, its own independent
Exchange-GAL resolution — strictly more capable than the browser path since it can actually
verify a resolve) and `RunCMSExport` (unrelated to any of this).

**Verified this time, in the actual running browser, not just unit tests:** built, assembled,
served locally, sample data loaded and calculated. Installed a `URL.createObjectURL` spy and
clicked a real row's mail icon (an `EMAIL_OPS` case routed to a configured Section mailbox) —
captured the exact downloaded file content:
```
MIME-Version: 1.0
X-Unsent: 1
To: ops-team@thecontactcentre.ae
Subject: TAA Attendance Review Notice: No login NS/NC - Sara Al-Blooshi - 28/08/2026
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

<body — decoded and confirmed byte-correct, em dash included>
```
Also confirmed via the same live session: the Config Registry's new Employee → Manager CC card
and the Email Config Wizard's step 2 render correctly and persist through `localStorage`; the
manager mapping and Section mailbox rows added in one session survived a full page reload.
`npm run lint` clean, all 4 test suites pass (`emailVbaContract.test.ts` rewritten — retired
sections deleted, new coverage added for `resolveEmailRecipient`/`isCorporateEmailDomain`/
`findManagerEmail`/`buildEmlFile`/`buildEmlFileName` against the real data scenarios above; the
still-relevant VBA JSON-extractor/brace-scanner coverage for `RunEmailDrafts` was kept, just
repointed at bare-array JSON instead of the retired request envelope).

**Not independently re-verified — inherits the caveat from 7e, now moot for the primary path:**
whether `.eml` files carry a Mark-of-the-Web zone marker that makes Outlook warn or open one
read-only is untested here (no real Windows/Outlook available in this sandbox). Test early on
the real machine; the one-time per-file "Unblock" in the file's Properties dialog is the
workaround if it bites. Separately, `.eml` must be associated with Outlook (not Windows Mail or
another client) for double-click to work as intended.

## 7g. Entire VBA Companion removed — RunCMSExport and RunEmailDrafts both retired (2026-09-08, later same day)

**What changed:** the user, while investigating why a CMS precondition banner still appeared
after the §7-era CMS folder-automation removal, decided to retire `RunCMSExport` (CMS data is now
a manual "Import CMS Data" upload, no Excel dependency). Following on from that, the user asked
why the app depends on Excel at all — since §7f had already made `.eml` download the sole primary
email path, with `RunEmailDrafts` demoted to "manual fallback only." Decision: remove the entire
VBA Companion, both macros, not just `RunCMSExport`.

**Deleted outright:** `TAA_VBA_Companion.bas`, `TAA_VBA_Companion.xlsm`,
`TAA_CMS_Automation/TAA_CMS_Launcher.vbs` (repo root); `TAA_HTML/src/components/VbaCompanionView.tsx`,
`PreconditionWarning.tsx`; `TAA_HTML/src/services/vbaGenerator.ts`,
`emailVbaContract.test.ts`; `TAA_HTML/scripts/check-vba-parity.mjs`; the `declare module
'*.bas?raw'` block in `vite-env.d.ts`; the `'vba'` tab (type union, header icon, mobile dropdown
option, envelope icon) from `App.tsx`/`Header.tsx`/`Sidebar.tsx`; the "3. Email Actions JSON"
download button and its `FileCode` icon import from `ResultsView.tsx`; the `test:email-vba-contract`,
`check:vba-parity`, and `prebuild` npm scripts from `package.json`.

**Kept, unchanged:** the `.eml` Bulk Draft path (`emlBuilder.ts`, `emailDrafts.ts`); CMS manual
upload (`UploadZone.tsx` — needed no code change, `cmsAutomationActive` was already hardcoded
`false`); `generateEmailActionsJson`/`ReconciliationOutput.emailActionsJson` in
`reconciliationEngine.ts` (now purely internal — drives Bulk Draft and a regression-suite
correctness check, no longer exposed as a download); the `emailActionsCount` summary caption in
`ResultsView.tsx` (reads the same internal value, just not the deleted button).

**Config schema (not deleted, annotated RETIRED):** `types/taa.ts` and `configRegistry.ts` —
`projectFolderSubfolderNames`, `cognosFolderFileName`, `aspectSegmentsFolderFileName`,
`aspectIdentityFolderFileName`, `cmsOutputFileName`, `cmsFolderPollIntervalMs`,
`cmsFolderPollTimeoutMinutes`, `cmsPreservedFilePatterns`, `cmsProtocolScheme`,
`cmsVbsLauncherFileName`, `cmsAgentListDelimiter`, `cmsDateFormatPattern` — kept only so an older
exported config JSON still imports without error, matching the pattern already used for the
`emailDraft*` fields in §7e.

**Why:** explicit user decision — the app must have zero Excel/VBA dependency. The one genuine
capability lost (already accepted when §7f shipped): Exchange GAL-verified address/manager
resolution. There is no fallback left if the `.eml` path is ever blocked by an Outlook
file-association issue or Mark-of-the-Web warning — accepted trade-off, not an oversight.

**Verified:** `npm run lint` clean (`tsc --noEmit`), `npm run test` green (`test:features`,
`test:trust-matrix`, `test:schedule-blocks` — trust matrix 145/145), `npm run build` +
`node assemble-standalone.cjs` succeed. Walked the real running app (dev server, sample data,
Reconcile): dashboard has no amber CMS precondition banner; header/mobile-nav have no VBA
Companion entry point; Results page shows exactly 2 download buttons (ASPECT Correction CSV,
Annotated Cognos CSV) plus Draft Emails, no Email Actions JSON button, and the "N email
action(s)" caption still renders correctly.

## 7h. Pre-UAT payroll-math audit (2026-09-09) and its same-day re-audit

`doc/CLAUDE_PAYROLL_MATH_BUG_REPORT.md` audited `reconciliationEngine.ts`, `scheduleRecompute.ts`,
`punchAttribution.ts`, `cognosComparison.ts`, `parsers.ts`, and `configRegistry.ts` for math and
algorithm defects affecting staff time-card corrections. 12 findings; 10 fixed same day
(`reg-80`–`reg-90`), 2 deliberately left unchanged as business decisions (split-shift per-block
evaluation vs. the closed whole-day PRD §4.9 decision; comparison-tolerance threshold-awareness,
which doesn't affect the ASPECT correction file either way since charged minutes come from the
engine's own recompute, never `cognosComparison.ts`'s tolerance).

The fix pass was then independently re-verified against the live source rather than taken on its
own word — this is the correct way to treat any audit report in this repo, including this one.
**All 10 claimed fixes were confirmed genuinely present and correct.** The re-audit found 6
further defects (`reg-91`–`reg-96`), 3 that the fix pass itself introduced (copy-pasting Rule 7/8's
correction-emission logic across the flex/standard branches instead of sharing it) and 3
pre-existing gaps the fix pass didn't reach:

- **R1 — raw, un-normalized `START_DATE` reaching the exported `SegmentDate`.** `parsers.ts`
  stores ASPECT `START_DATE` exactly as the export wrote it (e.g. un-padded `1/9/2026`, no
  `normalizeDateKey`). Rule 8's OT/RLS correction pair and the Absent-day OT→SHIFT conversion
  both read it directly — the same class of defect the `normalizeDateKey` join-key fix already
  closed elsewhere, just at two different emission sites. Both now derive `SegmentDate` from the
  segment's own parsed `START_MOMENT` via `formatSegmentDate()`, the same helper every other
  correction-emission site in `reconciliationEngine.ts` already uses. Pinned by `reg-91`/`reg-92`.
- **R2/R3 — Rule 7 (Cover Not Attended) and Rule 8 (RLS/OT adjustment) correction-emission logic
  duplicated three times** (flex Branch A, flex Branch B, standard) — only the finding-evaluation
  math (`evaluateCoverNotAttended`/`evaluateRlsOtAdjustment`) had actually been shared by the fix
  pass. This is exactly how R1 reached 3 sites instead of 1, and how Rule 8's adjustment came to
  increment `otConvertedCount` (the OT→SHIFT-on-absent-day counter) instead of its own metric —
  three live copies of the same business logic is how a fix applied to one copy silently doesn't
  apply to the other two. Extracted into shared `buildCoverNotAttendedOutcomes`/
  `buildRlsOtAdjustmentOutcomes` builders (pure functions returning an outcome descriptor) that
  every call site now applies via an identical short loop — the loop itself has no business logic
  left in it, so it can't drift. Added a separate `otRlsAdjustedCount` summary field (new tile in
  `ResultsView.tsx`) so Rule 8 adjustments are never conflated with Absent-day conversions again.
- **R4 — target-day cover placement checked 4 of the 5 source-day integrity signals, not
  `INVALID_ASPECT_DATETIME`.** `resolveCoverTargetDay()` rejected a target day with an
  out-of-window removal, a mid-shift removal, an unknown-duration removal, or a duration
  disagreement — but not a malformed/incomplete timestamp (e.g. a SHIFT with `START_MOMENT` but no
  `STOP_MOMENT`). That specific shape fell through every check, and cover placement silently
  rerouted to the next-day fallback instead of holding the row. Added the missing check; pinned by
  `reg-93`.
- **R5 — the F04 union fix (`reg-82`) left two residuals, and surfaced an unrelated pre-existing
  bug.** (a) A removal with only a `DURATION` and no timestamps has no interval to union against a
  timestamped removal in the same leading/trailing group, so an overlap between the two could
  still go undetected. New hold reason `AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION` catches this
  instead of guessing (`reg-94`). Building this test surfaced a **separate, pre-existing defect**
  in `scheduleRecompute.ts`'s `invalidDateTimeSegments` filter: its exemption for a timestamp-less
  REMOVAL required `seg.DURATION == null` — so a duration-only removal with a *real* `DURATION`
  (the normal, documented case per `resolveSegmentMinutes`' own trust order: "1. an explicit
  DURATION... 2. timestamps... 3. FULL_DAY_DEFAULT for ADDITION only") was being wrongly flagged
  `INVALID_ASPECT_DATETIME` instead of processed normally from its own DURATION. Narrowed the
  exemption to cover any timestamp-less removal regardless of duration — a removal with neither
  duration nor timestamps still resolves to zero minutes and is separately held as
  `REMOVAL_SEGMENT_DURATION_UNKNOWN`, unchanged. (b) The reported `leadingReleaseMinutes`/
  `trailingReleaseMinutes` stayed raw per-segment sums even after `netScheduledMinutes` started
  subtracting the unioned total (the F04 fix itself) — a reviewer computing `raw − release = net`
  by hand on an overlapping-removal row got the wrong answer. Both now report the same unioned
  totals net actually used; `nursingMinutes` keeps its own raw sum and `trailingReleaseMinutes` is
  the remainder after it. Pinned by `reg-95` (also updates `scheduleRecomputeBlocks.test.ts`'s
  existing overlapping-leading-release assertion from 120 to the correct unioned 60).
- **R6 — the F09 fix only special-cased `NO_ACTION`.** `ConfigRegistryView.tsx` renders every
  `TaaActionCode` as selectable for "No Login Record", but the fix pass only honoured
  `action === 'NO_ACTION'`; any other configured value (e.g. `LATE_AND_COVER`, which has no punch
  to measure a variance from and so cannot actually execute for a no-login case) still silently
  fell back to hardcoded `ABSENT_NS_NC` — an administrator picking that value saw no indication
  their choice was ignored, the exact "config lies" failure mode the original F09 finding was
  about. New shared `resolveNoLoginDecision()` (used by both the flex and standard branches):
  `MANUAL_REVIEW_REQUIRED` now holds instead of auto-absenting (new hold reason
  `NO_LOGIN_MANUAL_REVIEW_CONFIGURED`); any other unsupported action holds as
  `INVALID_CONFIG_VALUE` instead of being silently coerced into the default. Pinned by `reg-96`.
- **R7 — the `F09_CONFIG_OT` audit probe itself was broken.** `scripts/audit-payroll-math.ts`
  filtered on `segmentType === 'RLS added to OT with no adjustment'`, which does not match the
  Config Registry's actual key (`'RLS segment added to OT with no adjustment'`) — the probe's own
  filter was a no-op, so `doc/PAYROLL_MATH_AUDIT_EVIDENCE.json` kept showing the pre-fix OT
  correction pair for that evidence ID even after the real F09 fix landed elsewhere. The original
  report disclosed this caveat itself. Corrected the string; regenerating the evidence file now
  shows `F09_CONFIG_OT`'s corrections genuinely suppressed (`"corrections":[]`).

**Verified:** all 6 confirmed via the browser's live Regression Suite tab (96/96 PASSED, screenshot
walkthrough of reg-91 through reg-96) in addition to the headless runner; `npm run test` green
(96/96 regression, 145/145 trust matrix); `node node_modules/typescript/bin/tsc --noEmit` clean;
`scripts/audit-payroll-math.ts` re-run clean (732/732 boundary checks, 96/96 embedded
regressions); `npm run build` + `node assemble-standalone.cjs` succeed, and the regenerated
`TAA_Workspace.html` was opened in a real browser (via a local static server, since `file://` is
blocked) and walked through Upload & Reconcile, Config Registry, and the Regression Suite tab —
no console errors, all 96 cases show PASSED live in the UI, matching the headless runner exactly.

## 7i. COVER `nominateDate` filed against the incident schedule instead of the target schedule (2026-09-09)

`placeCoverSegment()` (`reconciliationEngine.ts`) resolves the correct target working
schedule via `resolveCoverTargetDay()` — its `targetDateStr` is exactly the target
schedule's own `NOM_DATE` — but then discarded it when building the correction row,
writing `nominateDate: incidentNomDateStr` (the ORIGINAL late/early incident's `NOM_DATE`)
instead. ASPECT keys a segment to its owning schedule by `NOM_DATE` — `resolveCoverTargetDay`
itself filters target-day segments by `NOM_DATE` for exactly this reason — so every emitted
COVER row was filed against the wrong schedule day: the incident's day, not the working day
the cover actually compensates. `SegmentDate` (the physical start date, from
`formatSegmentDate(coverStartDt)`) was never affected — this is a `nominateDate`-only defect.

Fixed: `nominateDate: targetDateStr`. This also correctly covers the synthesized-fallback
path (§4.11 Step 5), since `resolveCoverTargetDay()` returns that fallback date through the
same `targetDateStr` field. The incident date remains in `Memo` (`TAA Cover for
<incident NOM_DATE> Late/Variance`) for traceability. Same-day actions (LATE, Log_off,
ABSENT, shift-update pairs) were never affected — they correctly use the incident's own
`NOM_DATE` for `nominateDate` because they don't move to a different schedule day.

Existing cover-placement regressions (`reg-10`, `reg-29`, `reg-31`, `reg-80`) asserted
`SegmentDate`/start time/duration but never `nominateDate` — that omission is exactly how
this defect shipped and stayed hidden through 96 passing regression cases. All four now also
assert `cover.nominateDate === <target day>`. New regression `reg-97` pins a case where the
target schedule is an overnight shift (target `NOM_DATE` 20/09/2026, physical cover start
21/09/2026 01:00) so `nominateDate` and `SegmentDate` are asserted as two different, correct
dates in the same row. Verified: `npm run lint` clean, `npm test` green (97/97 regression,
145/145 trust matrix unaffected), `npm run build` + `node assemble-standalone.cjs` succeed,
regenerated `TAA_Workspace.html` opened in a real browser and confirmed rendering with the
Regression Suite tab all-green.

## 7j. Absent excludes leftover timed penalties — the only action-integrity defect that reached the CSV (2026-09-09)

An externally drafted spec (`doc/CLAUDE_ACTION_INTEGRITY_PROMPT.md`) claimed four action-
integrity defects (D1–D4). Each was independently re-verified against live source three times
(not taken on the draft's word) before any code changed. Only **D2** could reach the exported
ASPECT correction CSV; the other three were real but review-only or already correct — see the
doc itself for the full per-claim writeup, including which call sites and gates were checked.

**The defect:** Late Login and Early Logout run as independent `if` blocks in
`reconciliationEngine.ts` (standard branch, and separately in each flex branch), not a single
either/or decision. A day can trip both — e.g. OPS late ≥61m (Absent floor) and early-out 5–9m
(Late+Cover band) — and each pushes its own correction rows the instant its own band fires.
`applyMoreSevere`/`applyMoreSevereFlex`/`applyMoreSevereFlexB` only update the *reported*
verdict/action via a severity comparison (`RESULT_CATEGORY_SEVERITY`); they never retract
corrections a less-severe rule already pushed. `dedupeAspectCorrections` only collapses
duplicate `ABSENT`/`Absent NS/NC` markers, never a timed-penalty row sitting beside one. Result:
the exported CSV could carry `ABSENT` **and** `Log_off` **and** `COVER` for one employee-day —
a full-day pay deduction and a cover charge for the same shift.

**Why this was the urgent one and not the others:** export requires the row to carry no hold of
any kind, and the standard hold gate (`MISMATCH_FOUND`) only fires when Cognos and TAA's own
recompute *disagree*. So this defect fired precisely on the rows where Cognos agrees — the
clean, uncontested rows nobody opens for manual review. Not an edge case; the quiet common path.

**Fix:** once every rule for the employee-day has fired (both flex branches and the standard
branch), if the row's final `resultCategory` is `MARKED_ABSENT`, strip every correction whose
`SegmentCode` is `LATE`, `Log_off`, or `COVER` before it reaches `generatedCorrections`.
`firedActionCodes`/`TAA_ACTIONS_FIRED` are untouched — every rule that genuinely fired is still
visible for audit, only the correction rows are removed. §4.6c's OT→SHIFT replace pair
(`convertOtOnce()`) is unaffected, since it has its own independent idempotency guard.

**The reservation trap** — the part a naive strip gets wrong: `placeCoverSegment` reserves a
slot in a per-run tracker (keyed `` `${empId}|${targetDateStr}` ``) the instant a COVER row is
built, so a second cover for the same employee/target-day starts after the first one ends.
Deleting a stripped COVER row without releasing that reservation leaves the slot permanently
claimed by a row that no longer exists — silently delaying the *next* cover placed against the
same target day, a brand-new pay error introduced in a *different* row while fixing this one.
Fixed with a `coverReservationByRow` WeakMap (same object-identity pattern as the existing
`coverFallbackByRow` from §7i) so a stripped COVER releases the exact reservation entry it
claimed, and a `lateCoverCountedRows` WeakSet so the `lateCoverCount` run-summary statistic is
only decremented for a COVER that was actually counted (Rule 7's `moveCoverForward` cover is
never counted there, so a blind per-stripped-row decrement would have under-counted).

**Explicitly not changed:** the flex shift `10`/`11` schedule-update pair (§4.8) is retained
even when the day ends Absent — it is a complete, independent schedule correction, not a timed
penalty, and this fix's invariant is specifically "no LATE, Log_off, or COVER". Whether that
pair should also be dropped on an Absent-ending flex day is an open business question, not
decided by this fix (see `doc/CLAUDE_ACTION_INTEGRITY_PROMPT.md`'s H04 scenario).

**Golden tests** (`regressionSuite.ts`): `H02` (Late Login's Absent wins over Early Logout's
already-pushed Late+Cover), `H03` (the mirror — Early Logout's Absent wins over Late Login's
already-pushed Late+Cover), `reservation-integrity-01` (two incidents for the same employee
sharing a cover-fallback target day; proves the first's stripped COVER doesn't delay the
second's real one), `E25` (Absent + scheduled OT — confirms the strip is scoped to exactly
`LATE`/`Log_off`/`COVER` and never touches the OT→SHIFT conversion). Verified: `npx tsc --noEmit`
clean, `npm run test` green (111/111 regression, up from 107; 145/145 trust matrix unaffected).

**Correction to `reservation-integrity-01`'s own claim above (2026-09-17, found while adding its
`-retained` mirror below):** instrumented this exact fixture directly — with employee 7000110
scheduled on both 31/08 and 01/09, day 1's (31/08) cover target does NOT resolve via the
nextWeekMonday fallback the test's setup comment describes; `resolveCoverTargetDay` finds day
2's own 01/09 SHIFT as a real "future working segment" and targets IT directly (16:00, day 2's
own shift end), never reaching the fallback branch at all. Day 2's own incident independently
falls back to nextWeekMonday (07/09) since nothing follows it. The two covers were never
contending for the same reservation slot in this fixture, retained or stripped — the test's PASS
is real (day 2 genuinely lands at the un-shifted 08:00 anchor) but for a narrower reason than
claimed: releasing day 1's reservation is provably harmless here because there was never a
collision to cause harm in the first place. General principle, worth recording since it wasn't
obvious going in: with N chronologically-ordered SHIFT/OT segments for one employee, "the next
working day" always resolves to the IMMEDIATELY NEXT segment's date — every earlier incident
targets the next one directly, never a shared fallback, and only the chronologically LAST
incident on the employee's books can ever hit the nextWeekMonday/nextDirectDay fallback at all.
Two incidents for the same employee can only genuinely collide on the same reservation slot via
same-row stacking (two rules firing on one incident day, both targeting the same next day) —
not via two separate incident rows each independently falling back. Doesn't invalidate the
test's own release-vs-leak assertion; narrows what it actually proves.

**Follow-up (2026-09-17): `retainLateCoverOnAbsent` config toggle makes this fix optional.**
User-confirmed policy decision, NOT a reversal of the finding above — the double-pay-hit this
fix exists to prevent is real and still the default. Default `false` (today's behavior,
unchanged); when `true`, the strip is skipped uniformly across every path that runs it (standard
Late Login/Early Logout/Late Logout, both flex branches, Rule 7), the day's LATE/Log_off/COVER
correction(s) export alongside its ABSENT marker, and the reservation they claimed is correctly
NOT released. Auto-includes with no extra reviewer hold when on — a deliberate choice: the
toggle removes this section's whole protection, uniformly, with no per-row check, so it stays
opt-in and defaults off. Paired with a separate, independently-motivated change: `EmailActionItem`s
are now one per FIRED ACTION rather than one per row (`row_id` becomes
`` `${baseRowId}#${actionCode}` `` whenever a row fires more than one distinct action) — otherwise
a retained day's second action would have no way to draft its own email; see PRD.md §5 Output 3.
Four `-retained` mirror cases added: `H02-retained`, `H03-retained`,
`reservation-integrity-01-retained` (now correctly framed per the correction above — proves a
retained COVER keeps its real, correctly-resolved target-day placement and that a fully
independent row's own placement is uncorrupted by it, not a cross-row delay that was never
achievable in this fixture), `E25-retained` (confirms the OT→SHIFT replace pair is completely
unaffected by the toggle, since this row never had a Late/Cover correction to begin with).
`npm run test` green, 144/144 regression (up from 140), 145/145 trust matrix unaffected.

**Audit of that change, same session (2026-09-17) — two defects found and fixed, `npm run test`
now 145/145 regression:**

1. **An ID field containing `#` silently un-emailed its own row.** The per-action email split
   encodes multi-action items as `` `${rowId}#${actionCode}` ``, and every consumer originally
   recovered the row with `row_id.split('#')[0]`. `rowId` is `` `rec-${rowIndex}-${pfNo}` ``, and
   a PF NO can itself contain a `#` — **not hypothetical: `samples_Files/Cognos.csv` row 388
   carries `PF NO = "PT #"`** (a repeated header block inside the export, `NAME = "Username"`).
   Verified by direct instrumentation: `row.id = "rec-0-PT #"`, `split('#')[0] = "rec-0-PT "`,
   which matches nothing. Consequences on such a row: the mail icon disappears,
   `TAA_EMAIL_STATUS` reports a false `EXCLUDED_FROM_OUTPUT`, and any row carrying a real
   emailing rule would be dropped from Bulk Draft entirely — the exact silent-drop class the
   per-action split existed to prevent, reintroduced by its own plumbing. **Fix:** `EmailActionItem`
   now carries an explicit **`base_row_id`** field set at construction; all five consumers
   (`ResultsView.tsx` grouping + Bulk-Draft eligibility, `computeEmailStatusByRowId`,
   `TAA_COMMUNICATION_RULE`, the Excel export's Email column) read that field and **never split
   `row_id`**. Making the field required means `tsc` refuses to compile any new construction site
   that forgets it. Pinned by `hash-id-integrity-01`, which asserts both that `base_row_id`
   resolves AND that the old `split('#')` approach would have failed on the same fixture.
   *Rejected alternative:* stripping `#` from the PF column at upload/parse time. PF NO is the
   payroll join key — silently rewriting it to fix a separator problem in the email layer is a
   fix in the wrong layer, violates "never silently mutate a source value" (cf. the deliberately
   config-gated, audit-columned fill-if-blank exception), doesn't actually rescue that row
   (`"PT #"` → `"PT"` is still junk, just disguised as a plausible PF NO), and leaves the class
   open for whatever separator is chosen next.
2. **Leave-day anomaly reported two different variances.** Setting the per-action email variance
   surfaced that the §4.6b leave-day-login-anomaly branch never set `chargedVarianceMin`, so the
   row and the annotated export reported `0` while the new per-action email reported the real
   `totalPunchMinutes` (e.g. 480). **Fix (user-decided):** the branch now sets
   `chargedVarianceMin = totalPunchMinutes`, so row, annotated export and email all agree — the
   minutes worked on a leave day are precisely that finding's measured variance, and reporting
   them as `0` was under-reporting it all along.

**Still open, deliberately not done in this pass:** junk/repeated-header rows (the `PT #` /
`Username` shape) still flow into calculation as bogus employee-days. The right treatment is a
*visible* upload-time advisory, matching `assessDateOverlap`/`detectDateFormatAmbiguity` — never
a silent strip. Not implemented; flagged for a business decision.

**Deferred (should-fix-for-review, confirmed not payroll-urgent):** D1 (LATE/Log_off pushed
before `placeCoverSegment`, orphaned on placement failure) cannot reach the CSV — every failure
path sets a *forced* hold (`describeCoverPlacementFailure`'s every return value is in
`FORCED_HOLD_REASONS`), and Include is blocked at both the view (`ResultsView.tsx`) and state
(`App.tsx`'s `handleToggleInclude`/`handleToggleIncludeAll`) layers. D4 (`ResultsView`'s category
counts don't exclude held rows) is UI-counts-only. Neither was changed in this pass. D3 (the
"no absent for non-login" gate table) was checked and found already correct in live code — not
a defect, left unchanged.

## 7k. OT_INTERNAL removal classification; TAA_ACTION/holdReason contract resolved (2026-09-11)

**Found:** a release (RLS) segment fully contained inside OT1/OT2 (e.g. spanning part of OT1
and part of OT2, no SHIFT overlap) was classified `MID` by the removal-position test in
`scheduleRecompute.ts` (it touches neither the day's raw start nor raw end), which is a
FORCED hold (`MID_SHIFT_REMOVAL_SEGMENT`) — so the entire day's corrections (an Absent marker,
Rule 8's OT-duration adjustment pairs) were silently excluded from the exported ASPECT
correction CSV, with no reviewer override possible. This contradicts Rule 8's own documented
purpose (`Rules to be taken.csv` row 8, `doc/PRD.md`'s Rule 8 table row): the tool already has
a dedicated, correct mechanism for exactly this overlap.

**Fix:** a fourth removal position, `OT_INTERNAL`, added in `scheduleRecompute.ts` — a removal
whose interval is FULLY contained in the union of the day's OT1/OT2 intervals (strict
containment; no proximity tolerance) is `OT_INTERNAL`, not `MID`. It is never a forced hold and
DOES reduce `netScheduledMinutes` (the overlap genuinely isn't required attendance — per the
user's explicit decision, "8h shift + 2h OT + 2h OT - 2h RLS = 10h, by design"), but — exactly
like `MID` — it never moves `effectiveStart`/`effectiveEnd`, so the anchor-fabrication risk the
`MID` guard exists to prevent (§ removal-position comment in `scheduleRecompute.ts`) still
cannot occur. A release that straddles the shift/OT boundary, or sits in a gap between two
non-contiguous OT blocks, still classifies `MID` and is still held — guarded by `reg-112`/
`reg-113`. The exact incremental minutes removed are exposed as
`DayScheduleRecompute.otInternalRemovalMinutes` (also on `details`/`VarianceTrace`), shown in
the UI as "OT-Internal Deductions" beside "Release Deductions"/"Nursing Deductions" so
`raw additions - releaseMinutes - nursingMinutes - otInternalRemovalMinutes =
netScheduledMinutes` stays reconcilable by hand (`reg-111` asserts this equation, not just the
net total). See `reg-111`–`113`, `TAA_HTML/scripts/validate40.ts` BR-04.

**Contract resolved:** `TAA_ACTION` reports the calculated business action; `holdReason`/
`includeInOutput` report workflow safety separately and are never inferred from `TAA_ACTION`.
This was ambiguous going in — the 40-scenario validation pack (BR-18) expected
`MANUAL_REVIEW_REQUIRED` on any hold, while `reg-51`/`reg-53`/`reg-56` (pre-existing,
unchanged) assert `NO_ACTION` for the same class of POST-calculation schedule-integrity hold.
Resolved in favor of the regression suite's existing behavior — a hold discovered only after
the normal attendance path already ran does not overwrite an already-computed action — and the
validation pack's own oracle (BR-18, BR-19) was corrected to match. A PRE-calculation failure
(no trustworthy action exists at all — `MISSING_CMS_JOIN_KEY`, `INVALID_ASPECT_DATETIME`, etc.)
is unaffected and still forces `MANUAL_REVIEW_REQUIRED`.

**Found and fixed (2026-09-12):** while strengthening `BR-13`'s test coverage, a day with only
`P/H-LV` + `OT2` (a public-holiday-overtime day, no `SHIFT`) was found to trip
`MIXED_LEAVE_AND_WORK_SEGMENTS` (`leaveSegmentsForDay.length > 0 && additionSegments.length >
0`, since `P/H-LV` is in `leaveSegmentCodes`) and get held out of the export — reviewer-
releasable, not forced, but nothing released it automatically. This directly contradicted
`doc/PRD.md`'s own Non-Negotiables table (the "Holiday Overtime (PF 4507957 on 28/08)" row,
a real historical case), which documents the correct behavior as "Evaluated & Paid as Public
Holiday OT2" with no hold. `reg-108` (the existing MIXED_LEAVE_AND_WORK_SEGMENTS regression
case) does not cover this — its fixture is a genuine SHIFT+ANNUAL conflict, a different,
correctly-ambiguous pattern.

**Fix (user decision 2026-09-12, deliberately narrow):** `reconciliationEngine.ts` now exempts
the hold when every leave segment on the day matches a configured
`config.publicHolidayOvertimeLeaveCodes` entry (default `['P/H-LV']`) AND every worked
(Addition) segment on the day is `OT2`. A real `SHIFT`, `OT1`, `COVER`, or any leave code not
in the list still trips the hold exactly as before — this is not "any leave + any OT" or "no
SHIFT", it is specifically the documented public-holiday-overtime shape. Guarded by three new
regression cases: `reg-114` (`P/H-LV`+`OT2`, the fix — no hold, `includeInOutput=true`),
`reg-115` (`ANNUAL`+`OT2` — still held, proves the exemption is leave-code-specific), and
`reg-116` (`P/H-LV`+`OT1` — still held, proves it is OT2-specific). `reg-108`/`BR-20` (real
`SHIFT`+leave conflicts) and `reg-66` (a pure leave day with no Addition segment) were
re-verified unaffected. `TAA_HTML/scripts/validate40.ts`'s `BR-13` case now passes
(`npm run test:validation40`: 40/40) — its fixture, like `reg-114`, has clean Cognos data with
nothing else to disagree on, so the row genuinely reaches `includeInOutput=true` with no hold.

**Found while verifying the fix against real data — a second, separate, NOT fixed defect:**
the two real sample rows with this exact shape (`sampleData.ts`: PF 4507957 on 28/08, PF
600028 on 27/08) do NOT reach the exported CSV even after this fix — `MIXED_LEAVE_AND_WORK_
SEGMENTS` correctly stops firing, but `MISMATCH_FOUND` takes over instead. Root cause:
`compareCognosRow`'s `suppressScheduleColumns` gate (`cognosComparison.ts`) only activates
when `ctx.isLeaveDay` is true, and `isLeaveDay` requires `additionSegments.length === 0`
(`scheduleRecompute.ts:639`) — a `P/H-LV`+`OT2` day fails that (`OT2` is an Addition segment),
so `DUTY-2`/`SCH DURATION` are compared normally against a recomputed SHIFT block that does
not exist (there is no `SHIFT` on this day), and Cognos's genuine entitlement values (e.g.
`DUTY-2: 23:00 - 07:00`, `SCH DURATION: 8:0`) mismatch against blank/zero. This is a real,
pre-existing gap in the schedule-column-suppression logic, independent of the
`MIXED_LEAVE_AND_WORK_SEGMENTS` fix above, out of this session's approved scope (the user
authorized only the narrow `P/H-LV`+`OT2` hold exemption), and NOT fixed here — flagged for a
follow-up decision on whether `isLeaveDay`/`suppressScheduleColumns` should also cover an
OT2-only worked day.

## 7l. Public-Holiday SHIFT Miscoding — the mirror of the §7k OT2 exemption (2026-09-12)

**Context:** the §7k `P/H-LV`+`OT2` exemption (immediately above) only recognizes the case where
staff genuinely worked the documented public-holiday-overtime shape. The mirror case — staff
scheduled as a normal `SHIFT` on a `P/H-LV` day, by mistake, instead of `OT2` — was not covered
by that fix: it still correctly trips `MIXED_LEAVE_AND_WORK_SEGMENTS` (a real leave/work
conflict), but with no drafted correction, so a reviewer had to notice the miscoding and
hand-author the SHIFT→OT2 fix from scratch every time.

**Fix (user decision 2026-09-12):** `reconciliationEngine.ts`'s new `isPublicHolidayShiftMiscodedDay`
check mirrors §7k's condition with the addition-segment side inverted — same leave-code test
(`config.publicHolidayOvertimeLeaveCodes`, default `P/H-LV`), but requires every worked
(Addition) segment to be `SHIFT` instead of `OT2`. When it fires, `convertShiftSegmentsToOt2`
drafts a `shiftUpdateOriginalCode`/`shiftUpdateNewCode` (`10`/`11`) pair per SHIFT segment —
row `10` is the original `SHIFT` segment exactly as it exists, row `11` is the same
`SegmentDate`/`SegmentStarttime`/`Segmentduration` with `SegmentCode` replaced by
`config.shiftToOt2ConversionCode` (default `OT2`). Unlike §7k's exemption, the row is **not**
released automatically — new hold reason `PUBLIC_HOLIDAY_SHIFT_MISCODED` (non-forced,
checkbox-releasable, `holdReasons.ts`) keeps it held for one reviewer approval, since converting
SHIFT to OT2 *adds* overtime-pay eligibility rather than removing it (the opposite direction
from §4.6c's OT→SHIFT replace pair, which stays auto-included since its conversion always lands
on a day already marked Absent and gets no pay regardless — both rules use the identical 10/11
replace shape now; only the hold differs).

**Re-run guard (decision 2026-09-15):** this rule is skipped entirely when the day's ASPECT
segments already carry an `ABSENT`/`Absent NS/NC` marker — the signature left behind once
§4.6c's own 10/11 correction has been uploaded back into ASPECT. Without this guard, a P/H-LV
day corrected by §4.6c (OT2 replaced by SHIFT because the employee didn't attend) would, on the
next TAA run against that same corrected ASPECT export, look identical to this rule's positive
case (P/H-LV + SHIFT-only) and get drafted a SHIFT→OT2 pair — silently proposing to undo the
Absent-day fix every time the date is reconciled again. Guarded by `reg-127`.

**Mechanism note — not a new risk category.** An earlier draft of this entry (and of the plan
that produced it) treated the `SegmentCode`-changing `10`/`11` pair as a novel, higher-risk
pattern because every prior `10`/`11` site in this codebase (the flex shift-time-change pair,
§4.8; Rule 8's OT/RLS adjustment pair) only changes time/duration across the pair, never the
code. User correction: that's not a distinct mechanism — ASPECT's `10`/`11` replace is generic
(row `10` locates the record as it exists, row `11` supplies the replacement values); which
field carries the delta doesn't change how the replace works. The general vendor-confirmation
status of `10`/`11` itself is unchanged from §8 item 8 below (accepted as the working
definition, not independently vendor-documented) — that applies equally to every `10`/`11` site,
not specifically to this one.

**Guarded by regression cases:** `reg-117` (`P/H-LV`+`SHIFT`-only — the positive case:
drafts the `10`/`11` pair into `generatedCorrections`, holds `PUBLIC_HOLIDAY_SHIFT_MISCODED`,
`includeInOutput=false`, pair absent from the rendered `aspectCorrectionsCsv` until approved),
`reg-118` (`P/H-LV`+`SHIFT`+`OT2` mixed — collides with neither this rule nor the §7k exemption,
falls through to plain `MIXED_LEAVE_AND_WORK_SEGMENTS` with no conversion drafted), `reg-119`
(`ANNUAL`+`SHIFT`-only — proves the rule is leave-code-specific, not "any leave code with a
SHIFT segment"), and `reg-127` (2026-09-15 — the same `P/H-LV`+`SHIFT` shape as `reg-117`, but
with an `ABSENT NS/NC` marker already present, proving the re-run guard suppresses the
SHIFT→OT2 draft). See `doc/PRD.md` §4.6e for the full rule writeup and config knob
(`shiftToOt2ConversionCode`, default `OT2`).

## 7m. Adversarial audit remediation pass (2026-09-14)

An independent adversarial audit against a seeded list of suspected defects confirmed 17 of them
real (file/line evidence reproduced independently, not taken on the seed list's word), found 1
more during a follow-up investigation of 6 previously-unverified edge cases, and confirmed 2
edge cases already behave correctly. All were fixed the same day; full details, evidence, and
test coverage are in `doc/TAA_REMEDIATION_HANDOVER_2026-09-14.md`. Summary:

- **Stale output / gate bypass:** any upload, remap, or config change now immediately invalidates
  prior results (`App.tsx`'s `invalidateOutput()`), and Save/sample-auto-run now share the exact
  same eligibility gate as manual Calculate (`evaluateCanCalculate()`) instead of each
  re-implementing a weaker copy that silently omitted the headcount check.
- **Headcount threshold:** `assessHeadcountMapping` now compares the unrounded percentage against
  the minimum, so a true 69.5% cannot pass a 70% floor just because it displays as "70%".
- **Policy-band overlaps:** `validatePolicyBands`'s ERROR-severity issues are now merged into
  `validateConfigForRun`, which blocks Save, config import, AND `runReconciliation` itself
  (already fail-closed there) — no longer visual-only.
- **Rule-action dropdown vs. engine:** `IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE`
  (`configRegistry.ts`) is now the single source of truth for which `TaaActionCode` values each
  policy-rule segment type actually dispatches on — the dropdown is restricted to it, an
  unimplemented combination is a blocking `validateConfigForRun` ERROR, and Late Login/Early
  Logout additionally hold (`INVALID_CONFIG_VALUE`) rather than silently charging variance with
  zero correction output if a stale config ever carries one anyway. `MANUAL_REVIEW_REQUIRED` —
  already implemented for "No Login Record" — is now actually selectable.
- **Schedule arithmetic** (`scheduleRecompute.ts`): `netScheduledMinutes` is clamped to 0 and
  flagged (new hold `NEGATIVE_NET_SCHEDULE_MINUTES`) instead of reporting negative; `TAA_OT1`/
  `TAA_OT2` now sum the already-deduped addition list instead of the raw one (fixed a duplicate-
  OT double-count); the addition-dedup key is normalized through the date parser instead of a raw
  string compare (fixed date-format-blind duplicate detection); proximity-tolerance-classified
  removals now clip their subtracted interval to the true `rawStart`/`rawEnd` boundary; the
  duration-only-removal ambiguity check now also covers 2+ duration-only removals with no
  timestamped removal in the group at all; a new check flags two genuinely-overlapping (not
  byte-identical) ADDITION segments (new hold `AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS`).
- **Generated correction rows:** `convertOtSegmentsToShift`/`convertShiftSegmentsToOt2` (the
  Absent+OT conversion and the public-holiday "10"/"11" replacement pair) now derive
  `Segmentduration` from timestamps when DURATION is null, instead of leaving it blank when a
  real duration is computable. A DURATION cell that was malformed text (not simply blank) and
  got silently repaired from timestamps now surfaces a new soft, reviewer-releasable hold
  (`DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS`) instead of being indistinguishable from a clean one.
- **`TAA_COGNOS_AGREE`:** the legacy `DEFECT_1_RELEASE_IGNORED` diagnosis can force
  `cognosAgree` to `false` independent of `comparisonResult.mismatchColumns` — inclusion now
  keys off that overridden value too, held unless the row's `disagreeReason` is in the new,
  empty-by-default `config.cognosAgreeOverrideExceptions` allowlist.
- **Identity conflicts:** a duplicate `EMP_ID` in the Identity Master with disagreeing details now
  keeps the first record and holds every row for that employee (new hold
  `CONFLICTING_IDENTITY_RECORD`) instead of silently letting `Map.set` take the last one.
- **Summary/UI clarity (`ResultsView.tsx`):** the mismatch-count card now reads "row(s) with a
  column mismatch" instead of "column mismatch(es)"; the Late & Cover / Marked Absent cards are
  labeled as correction-action counts (a row can contribute to more than one), not employee-day
  counts; every category tab now shows a "· N held" qualifier when some of that category's rows
  are also held for review, so Held-vs-Included is visible at the tab level, not just per-row.
- **Scenario Guide vs. engine:** `simulateScenario` now calls the exact same
  `resolveNoLoginDecision`/`flexLateBandFires`/`isFlexScheduleWithinExpectedWindow` functions the
  real engine uses for the no-login decision, the flex minute-band bypass, and the flex
  schedule-window gate — previously independent reimplementations that had already drifted (the
  window gate wasn't modeled at all; the band-bypass check was entirely missing).
- **Confirmed already correct, no fix needed:** `P/H-LV`+`OT2` days are evaluated and paid, never
  merged with OT1; `PUBLIC_HOLIDAY_SHIFT_MISCODED` correctly covers its narrow intended case; the
  LATE/Log_off+COVER partial-state risk on cover-placement failure cannot currently reach export
  (forced-hold gating blocks it) — pinned with a regression-guard test rather than changed.
- **Left as an explicit decision item, not fixed blind:** partial-leave codes (`ANNL-5/6/7`,
  `Sick-4/9`, "Public Holiday 4/9") remain unclassified (falls to the safe `UNCLASSIFIED_
  SEGMENT_CODE` hold) — zero real occurrences means there's no data to validate a classification
  against; a real public holiday worked with no leave segment coded, or coded under an unrelated
  leave code, cannot be detected without an external holiday calendar the tool doesn't have.
- New regression coverage: `TAA_HTML/src/services/auditFixes.test.ts` (`npm run
  test:audit-fixes`, part of `npm run test`).

**Independent re-audit of this same pass, same day — 4 corrections.** The pass above was then
diffed against the pre-change backup and, critically, the **old engine was run against the new
engine over the bundled sample dataset** — a check no suite in `npm run test` performs, since
every suite uses its own synthetic fixtures. Four defects surfaced that a fully green suite had
hidden:

1. **`AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS` was both non-overridable and wrong.** It was added
   to `FORCED_HOLD_REASONS` and fired on a COVER nested inside a SHIFT — the shape carried by the
   bundled sample data itself (employee 600043, 01/09/2026: SHIFT 08:00–16:00 + COVER
   15:00–15:12). On such a day with a real late arrival it calculated `LATE` + `COVER` corrections
   and then withheld both from the export with no reviewer path to release them. **A COVER inside
   a shift is routine**, not ambiguous: the hours formula is `DUTY1 + OT + COVER − releases`,
   `coverExtendsAttendanceWindow` (default false) exists precisely so a cover adds minutes without
   moving the attendance window, and Rule 7 exists to test a cover against the attended span. The
   check now flags only **same-kind** overlaps (COVER×COVER, or SHIFT/OT×SHIFT/OT), and the reason
   is **deliberately not forced** — it is a scheduling-judgement call like
   `MIXED_LEAVE_AND_WORK_SEGMENTS`, and it has never been validated against a real production
   export (all 86 real COVER occurrences sit outside their shift window, so the overlapping shapes
   it fires on remain untested).
2. **A soft hold was pre-empting a forced one.** `DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS` sat
   above `AMBIGUOUS_PUNCH_ATTRIBUTION` in the cascade, so a row carrying both conditions reported
   the releasable reason instead of the locked one and became tickable into the payroll CSV.
   Moved below every forced hold. **General rule for this cascade: a hold that is not in
   `FORCED_HOLD_REASONS` must never be evaluated before one that is.**
3. **A band overlap reported the wrong diagnostic.** `buildInvalidConfigOutput` mapped only
   `kind === 'value'`, so the newly-added `'band'` kind fell through to `INVALID_CONFIG_TIME`
   ("fix it to a valid HH:MM wall-clock value") — pointing the user at a field that was never
   wrong. Only an all-`'time'` issue set now reports `INVALID_CONFIG_TIME`.
4. **The proximity clip broke the reconciliation invariant.** It corrected the pay figure but left
   the reported `nursingMinutes` unclipped, so `raw − release − nursing − otInternal = net` no
   longer balanced on exactly the rows the clip fixed. The trailing accumulators now use the
   clipped minutes, but only when the clip actually moved the boundary — leaving an explicit
   DURATION that disagrees with its own timestamps reporting as before, since that is its own
   separate `SEGMENT_STOP_DURATION_DISAGREE` hold.

Measured net effect of the whole pass on the bundled sample data: 5 rows newly held (all
`MISMATCH_FOUND`, all reviewer-releasable), `heldForReviewCount` 17 → 22, and 2 lines removed from
the exported correction CSV (employee 600018's Rule 8 OT/RLS pair, now gated behind one reviewer
tick by the `TAA_COGNOS_AGREE=false` rule). **Lesson for future passes: a green
`npm run test` proves the fixes work; it does not prove they cause no harm. Diff engine output
over the sample dataset before and after any change to a hold, a gate, or the hours formula.**

## 7n. Payroll-output audit and five-package remediation (2026-09-20 → 2026-09-22)

An independent recomputation of all 709 real employee-day rows (CMS 17–21/09) from raw
ASPECT/CMS/Cognos data, cross-checked by a second adversarial audit, agreed with the engine on
**276 of 291** clean days — the 15 differences were Rule 7 (Cover Not Attended) firing legitimately,
not a defect. **The engine was confirmed to already be mostly correct and was not refactored**;
every fix below is surgical. 19 defects (**D1–D19**) were verified against the live source and real
data and fixed across five work packages, each gated on the ASPECT correction CSV staying
byte-identical to the previous package's baseline except where the package's own defects say a row
must change. Business rulings made along the way are recorded as **B1–B15** below; they are owner
decisions, not implementation choices, and should not be revisited without a new decision.

**WP1 — Absence-emission correctness.** D1/D2: a same-day or ASPECT-resident COVER segment the
agent actually worked was still being charged again as late-logout minutes, sometimes pushing a
day past the 60-minute absence threshold on time already repaid — cover credit now subtracts any
overlapping COVER (any incident, not just the one that placed it) before the band is applied. D3:
a punch belonging to the *prior* day's shift, picked up by the cross-day search window, was
marking a scheduled leave day absent — the search no longer attributes a punch across a leave-day
boundary. D6: a leave segment coexisting with a SHIFT segment on the same day was routed into the
absence path instead of the leave path. D7: a bare full-day removal (no real shift) collapsed the
effective window to zero length, and the zero-length window was then scored as hundreds of minutes
late/absent instead of being recognised as having nothing to measure. D8: two physical absence
triggers on one day built two ABSENT markers, and CSV deduplication silently kept one memo and
dropped the other's reason — corrections are now built once per employee-day with a combined
memo. **Real-row proof:** `rec-93`/`rec-275` stopped losing minutes to double-charged cover;
`rec-202` (a cross-day leave-day punch) left the CSV; the 27 leave+SHIFT rows and 38 zero-window
training rows stopped recommending an absence.

**WP2 — Cover placement integrity.** D5: a newly assigned cover was anchored to the incident date
with no floor, so on real data it could land in the *past* (`rec-436`, incident and cover both
21/09) — a new run-date floor (`coverMinimumDaysAfterRunDate`, default 1 day, applied to every
fallback mode too) guarantees a newly assigned cover is never dated on or before
`processingDate + coverMinimumDaysAfterRunDate`, however old the incident. D4: same-day cover
credit tested only that the window fell inside `[firstLogin, lastLogout]`, so a mid-window logout
gap (`rec-282`, out 16:47–18:40) was invisible — credit now requires a single continuous presence
block spanning the whole cover window (`presenceBlocks`), and any window that fails moves forward
instead of being credited. B3: a removal anywhere in the day used to block same-day cover
entirely — it now blocks only when the removal overlaps the cover window itself, or is a trailing
release at shift end; an unrelated removal elsewhere in the day no longer blocks. D9: re-uploading
an already-corrected day (`rec-285`) added a second COVER on top of the one ASPECT already
held — the idempotency check now also recognises a matching cover already on the *resolved target
day*, gated on the penalty marker also being recorded, while never suppressing a cover for a
genuinely distinct second incident on the same day (verified: two incidents on one day still yield
two covers, before and after a re-upload — **the owner's explicit B9 red line**). D10: the flex
early-logout branch bypassed same-day placement entirely; it now uses the same
try-same-day-then-fallback shape as every other cover site.

**WP3 — Review semantics.** D11: the "Fixed Defect" badge fired on **every** Cognos column
mismatch (~800+ rows), not the genuinely diagnosed defects — `describeDisagreement()` now reads
"Known Cognos issue" only for the three diagnosed reasons (B11: `DEFECT_1_RELEASE_IGNORED`,
`DEFECT_2_NIGHT_SHIFT_PUNCH_LOST`, `COGNOS_FALSE_ABSENCE`) and "Cognos mismatch: `<columns>`"
otherwise, from one helper shared by the on-screen badge and the export so they can never
disagree. D12: a held row with no exportable corrections had no way to be marked as examined — one
checkbox (B10) now records *reviewed* on a no-corrections row and *reviewed and include* on an
actionable one; `TAA_REVIEW_COMPLETED` exports the **stored** flag, never the checkbox's rendered
state, so a clean auto-included row (ticked with no human involved) still reads `FALSE` on a fresh
run. D13: the known-Cognos-issue state is now review metadata, not a category and not an
auto-release — `cognosAgreeOverrideExceptions` remains the only way to actually bypass a hold for
a named reason.

**WP4 — Reporting truth.** D14: `cognosDataGapCount` incremented at 1 of the 12 code paths that
can set a row's category to `COGNOS_DATA_GAP`, reading 0 against a true category count of 6 on
real data — it is now derived from the finished rows (`rows.filter(r => r.TAA_RESULT_CATEGORY ===
'COGNOS_DATA_GAP').length`), which cannot diverge from the category again. D15: the Shift Changed
tab/sheet filtered on category alone and showed 22 of 40 real shift changes — membership is now
correction-based (a `SegmentCode === 'shift'`, lowercase, pair), the same superset pattern
category-2 already used; uppercase `'SHIFT'` (an OT-conversion code) is deliberately excluded. D16:
several cards' numbers didn't measure what their labels claimed (Late & Cover card 23 vs its own
tab's 61; a "Defect 1 & 2 Protected" sub-label that actually counted every column mismatch) — cards
now state their unit and, where relevant, show the held-within-category breakdown the tabs already
carried. D18: the PRD's and the four default policy rules' cover-timing wording said only "next
day", contradicting the same-day-credit exception (WP1) and the run-date floor (WP2) — corrected;
see §5.5 below, which carried the same defect. D19 (B7/B12): six rows the engine genuinely cannot
act on (locked behind a forced hold, zero corrections built) and 49 rows proposing a real
absence/penalty correction but currently blocked by a hold were both invisible, buried among 366
total holds — a new "Must Check" duplicate view (§4.16 of `PRD.md`) surfaces exactly this
55-row union (6 + 49) without moving any row out of its own category or changing any
`includeInOutput`/`holdReason`.

**WP5 — Technical-segment hold (D17).** Technical outage time (`TECH`/`TECH2`) had been
classified `REMOVAL`, so it silently moved the effective shift window and any resulting lateness
was invisible — no action and no hold, so nobody knew a decision had even been made. The owner
ruled technical time **paid** (B5): reclassify the codes `NO_EFFECT`. That alone would create a
new problem — a real penalty charged for a fault that wasn't the agent's — so a new hold,
`TECHNICAL_SEGMENT_COVERS_VARIANCE`, was added: when a row's configured technical segments
(`technicalSegmentCodes`, default `['TECH','TECH2']`, no code hardcoded anywhere) fully cover
**every** variance interval that actually charged a penalty on that row — late login (standard and
flex), early logout, late logout, and an unattended Cover Not Attended window — to within a
configurable tolerance, the row holds under this new code instead of exporting (B14: the
correction is still **built**, exactly as it would be without the hold — releasing the row
restores the same penalty a genuine incident would have produced). A row with more than one fired
variance holds only when **every** one is covered (B15); partial coverage still exports, with the
overlap noted in the trace. On the real 709-row sample, this package is measured **inert**: 0 rows
changed, because the real `Config.json` still classifies `TECH`/`TECH2` as `REMOVAL` — the
reclassification is an owner action, not an implementation step (see below).

**The forced/releasable hold split, current state.** `src/services/holdReasons.ts`'s
`FORCED_HOLD_REASONS` set is the single source of truth — do not restate it as a list anywhere
else, including here; it has already changed twice. As of WP5 there are **21 forced** codes
(missing/ambiguous/contradictory evidence — locked until the source data is corrected) and **7
releasable** codes (`MISMATCH_FOUND`, `MIXED_LEAVE_AND_WORK_SEGMENTS`,
`PUBLIC_HOLIDAY_SHIFT_MISCODED`, `AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS`,
`DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS`, `FULL_DAY_REMOVAL_ON_SCHEDULED_DAY`,
`TECHNICAL_SEGMENT_COVERS_VARIANCE`) — the engine has already built a complete, self-consistent
correction and the hold exists purely for a human business judgement. A releasable code must never
be written into the `forcedHoldReason` local, which is seeded ahead of the row-loop's hold cascade
and outranks every forced code — doing so would make a row carrying a genuinely locked condition
report the releasable reason instead and become exportable.

**The asymmetric-evidence principle (B6) — deliberate, not an inconsistency.** WP1's cover credit
and Rule 7's Cover Not Attended inspect the same kind of interval with opposite intent — one
credits presence, the other penalizes absence — and use **different** evidence standards on
purpose, both erring away from acting without proof: crediting a cover requires proof of
*continuous* presence across the whole window (`presenceBlocks`, WP1/D4); Rule 7 keeps its
original first-login-to-last-logout **span** measure unchanged. If a future change makes these two
share one presence check, it will silently tighten Rule 7 and can only manufacture new absences —
that would be a regression of this decision, not a bug fix.

**Business decisions (owner, 2026-09-21 → 2026-09-22).**

| # | Decision |
|---|---|
| B1 | 60 remaining minutes after cover credit = ABSENT (the configured band, unchanged) — a pure double-counting fix, no band change. |
| B2 | A newly assigned COVER starts on a working day strictly after the run date, minimum offset configurable (default 1 day). |
| B3 | Same-day cover eligibility: a removal elsewhere in the day no longer blocks credit unless it overlaps the cover window or is a trailing release at shift end. Full interval only — never split. |
| B4/B13 | Cards report action counts, tabs report row counts (reaffirmed) — the two may legitimately differ, but every card must state its unit. |
| B5 | Technical time is paid (`TECH`/`TECH2` → `NO_EFFECT`, owner's config change). A configured technical segment covering a whole variance interval holds that action under a new reviewer-releasable code, tolerance configurable (default 0), never keyed to literal code names. |
| B6 | Asymmetric presence evidence: cover credit requires continuous presence; Rule 7 keeps its existing span measure. Neither current Cover-Not-Attended outcome changes. |
| B7/B12 | New "Must Check" view lists all rows a human must look at: the forced-hold rows the engine cannot act on at all, **and** the held rows proposing a real pay-affecting correction. A row keeps its own category as well — duplication, never a move. |
| B8 | The run date is the system clock at run time — cover dates are not reproducible across re-runs; never assert reproducibility of a cover date. |
| B9 | A re-uploaded incident is not repaid twice, but two distinct incidents on one day always yield two covers — never suppress a cover for a distinct incident. |
| B10 | One review checkbox, not two: a no-corrections row records *reviewed*; an actionable row records *reviewed and include*. Accepted limitation: "reviewed and deliberately excluded" is not representable. |
| B11 | "Known Cognos issue" means exactly three disagree reasons (`DEFECT_1_RELEASE_IGNORED`, `DEFECT_2_NIGHT_SHIFT_PUNCH_LOST`, `COGNOS_FALSE_ABSENCE`); everything else reads "Cognos mismatch: `<columns>`". |
| B14 | The technical hold builds the correction, then holds the row — the correction is never deleted, only withheld from the CSV, so releasing the row restores the real penalty. |
| B15 | The technical hold fires only when every fired variance on the row is technically covered; a no-login/no-punch absence is excluded (no variance interval exists to test). |

**Two process defects worth preserving as a standing warning**, both caught during this
programme and both avoidable: **(1)** writing a `.ts` source file from a Python script in text
mode on Windows silently converts it LF→CRLF, producing a multi-thousand-line phantom diff with
zero real content change — this happened twice (WP4 and WP5), was caught each time only by an
explicit CR-byte audit, and was fixed by normalising back to LF in binary mode. Always use the
Edit tool, or binary-mode writes with explicit `\n`, for any `src/`/`scripts/` file. **(2)** WP4
edited `doc/PRD.md` without backing it up first, leaving that file with no byte-diff to audit —
every file touched in a work package must be backed up before the first edit, documentation
included, exactly as the source-code backup rule already required.

**Both owner config actions were applied on 2026-09-22**, directly to `samples_Files/Config.json`
at the owner's explicit direction (not through the app's own Save/Export, though validated through
the app's real `importConfigFromJson` + `validateConfigForRun`, which returned zero errors —
equivalent to what an in-app import would have produced): (1) `TECH`/`TECH2` reclassified
`REMOVAL` → `NO_EFFECT` in the Segment Glossary; (2) the four affected policy rules' Action Text
updated to the corrected "next eligible working day (or same day, if already covered)" wording.

**Measured effect of the reclassification, real 709-row replay:** exactly **one** row
(`rec-414-40112849`) moved from a held `MISMATCH_FOUND` to clean/no-action — the reclassification
made its recomputed values agree with Cognos — taking `heldForReviewCount` 366 → 365 and
`mismatchCount`/`disagreementsResolvedCount` 290 → 289. The ASPECT correction CSV stayed
**byte-identical** (that row carried no correction either way), and `mustCheckCount` stayed at 55.

**Zero rows held under `TECHNICAL_SEGMENT_COVERS_VARIANCE` on this sample — verified as a genuine
data property, not a defect.** All four links were checked directly: the config resolved
`technicalSegmentCodes: ["TECH","TECH2"]` correctly (the file itself carried neither key at the
time; the `{...DEFAULT_CONFIG, ...parsed}` merge supplied it — both keys have since been added
explicitly, see WP7 below); all 59 real `TECH`/`TECH2` rows in `MTD_Seg.csv` have populated,
correctly-ordered timestamps that `coverIntervalsFromSegments` parses without skipping; the
decision block reads `empSegs`, the raw pre-`recomputeDaySchedule` segment array, which still
carries `NO_EFFECT` segments. The actual cause: **`Cognos.csv` covers only 18–20/09**, so the two
best-shaped real technical segments (`4507922` and `40121833`, both shift-start-aligned, both
17/09) can never produce a row at all — Cognos drives the row set. Of the technical employee-days
that do fall inside the 18–20/09 window, none happened to coincide with a fired chargeable
variance on real data. This is luck, not design (roughly 1–2 overlaps would be statistically
expected): **the feature is expected to fire in a wider production date range, having until WP7
never once been exercised against a real `TECH` segment** — see WP7 below.

## 7o. WP7 — technical hold proven against real `MTD_Seg.csv` data (2026-09-22)

`reg-160`–`reg-169` (WP5) are all hand-built fixtures. `reg-170`/`reg-171` close that gap: the
ASPECT segments are copied **verbatim** from `MTD_Seg.csv` — real `EMP_ID 4508183`, real
`NOM_DATE 18/09/2026`, real `SHIFT 14:00–22:00` and real `TECH 14:00–14:12` (`DURATION 12`,
memo "PC issues"). Only the login/logout **times** are constructed, since the real employee was
on time that day (confirmed: the real replay's row for this employee-day reads "Attendance within
acceptable thresholds") and produced no variance for the hold to act on. `reg-170` moves the login
to 14:12 — exactly the real `TECH` segment's own end — producing a 12-minute late-login variance
that the real segment covers exactly: `holdReason = TECHNICAL_SEGMENT_COVERS_VARIANCE`,
`includeInOutput = false`, with `LATE` and its equal-duration `COVER` still present in
`generatedCorrections` (B14). `reg-171` is the control: the same real segments with the real
on-time login, reproducing the actual no-variance outcome and proving `reg-170` isn't passing for
the wrong reason (e.g. a predicate that holds unconditionally whenever *any* technical segment is
present).

**Deliberately dropped from the fixture, and why:** the real employee-day also carries a duplicate
`TECH2` at the same 14:00–14:12 window, two more `TECH`/`TECH2` pairs later in the shift, three
`BREAK` segments, an `ES & SMB` segment matching the shift span, and a real `COVER` at
22:00–22:03 (memo "Exceed break For 16-Sep" — an unrelated incident). The duplicate/later
technical segments and the `BREAK`/`ES & SMB` segments are harmless if included (they only extend
coverage outside the tested interval) and were omitted for clarity. The `COVER` segment was
omitted for a real reason: left in, its 3 unattended minutes (if the constructed logout is exactly
22:00) would fire a *second* variance — Cover Not Attended — that the `TECH` segments do not
cover, which would fail B15's "every fired variance must be covered" test and stop the row from
holding at all, defeating the point of the case.

Mutation-tested: hardcoding the config lookup out breaks `reg-170` (along with five other WP5
cases); relaxing the coverage test from `every` to `any` leaves `reg-170` passing (it has only one
variance) while breaking `reg-165` (WP5's two-variance case) — confirming the two cases exercise
different code paths. Suite: **185 → 187, zero re-pins.** `samples_Files/Config.json` also gained
explicit `technicalSegmentCodes`/`technicalSegmentToleranceMinutes` entries (previously supplied
only by the `DEFAULT_CONFIG` merge) — a replay before and after confirms zero behaviour change.
`TAA_Workspace.html` was **not** rebuilt for this package: `samples_Files/` is never bundled into
it (confirmed §6's build audit) and no `src/` runtime behaviour changed.

## 7p. Hold Policy tab — per staff category × action pre-approval (2026-09-24)

Verified facts, real 23/09-week (24/09/2026 processing date, 218 rows, 94 held/43.1% under
`releaseProvenSafeHolds=true`):
- Default policy (`{ released: [] }`) is byte-identical to no policy at all — `held-breakdown.ts`
  with and without an explicit `--policy` flag both report 94 held, 0 verdict/action/
  actionsFired/late/early/correction diffs.
- Unticking `FLEX|MISMATCH_FOUND:SHIFT|NO_ACTION` and `FLEX|MISMATCH_FOUND:SHIFT|SHIFT_UPDATE`
  drops held to **61** (28.0%), releasing 33 rows, **0** pay-affecting diffs (verdict, action,
  actionsFired, late/early minutes, and generated corrections all identical before/after —
  `applyHoldPolicy` only ever clears `holdReason`/flips `includeInOutput`).
- Shift folding (`cognosComparison.ts`'s `policyGroup` + the `DUTY1`-move comparison): 52 of 53
  flex `MISMATCH_FOUND` rows carrying a `DUTY1` mismatch fold their `LATE START`/`LEFT EARLY`
  gap into the `SHIFT` group; flex `LATE_EARLY` (as its own disagreement, not shift-caused)
  drops to 1 real row on this week's data.
- `HOLD_REASON_TEXT` (the exhaustive `Record<HoldReasonCode, string>` the Hold Policy tab's
  rows are built from) moved from `reconciliationEngine.ts` to `holdReasons.ts` — a pure
  relocation (re-exported, same object, same text) done specifically so `holdPolicy.ts` (and
  transitively `configRegistry.ts`, which imports its `sanitizeHoldPolicy` for JSON import)
  never has a runtime dependency on the engine, avoiding a `configRegistry.ts → holdPolicy.ts →
  reconciliationEngine.ts → configRegistry.ts` import cycle. `applyHoldPolicy` itself only
  type-imports `ReconciliationOutput` from `reconciliationEngine.ts` (erased at compile time)
  and receives `rebuildOutputs`/`rowIsMustCheck` as injected `deps` from `pipeline.ts`, for the
  same reason.
- `runReconciliationWithAudit` (engine → unseen-punch audit → Hold Policy → initial review
  status) moved out of `App.tsx` into `src/services/pipeline.ts` — previously `App.tsx` and
  `scripts/held-breakdown.ts` each re-implemented a slightly different chain (the script's
  `--compare-gates` path skipped the audit and any policy entirely); both now call the one
  function, so `--policy`/`--with-audit`/`--gates` on `held-breakdown.ts` exercise the exact
  same ordering the UI does.
- Proof step performed and reverted: temporarily adding a fake value to `ROLE_TIERS`
  (`src/types/taa.ts`) makes `npm run test:hold-policy` fail with `New RoleTier
  'FAKE_TIER_PROOF_STEP' has no Hold Policy tab — see src/services/holdPolicy.ts
  (STAFF_CATEGORIES / CATEGORY_LABELS)`, confirming the exhaustiveness guard actually fires
  (not just compiles) before the change was reverted.
- Regression suite (231/231) and trust matrix (157/157) both call `runReconciliation` directly
  (never `pipeline.ts`), confirmed unaffected by this change — `npm test` was re-run green
  end-to-end after the feature landed.

## 7q. Held-review reduction: flex base roster + whole make-up COVER (2026-09-27)

Trigger: PF 4500508 on 23/09 was held `MISMATCH_FOUND` although every TAA figure was right.
ASPECT: FLEX, SHIFT 10:00-18:00, LATE 10:00-10:40, COVER 18:00-18:40; CMS swipes 10:40 / 20:42
(staffed 00:00 = Cognos SIGNIN DURATION 00:00, MATCH). Cognos: DUTY1 07:00-15:00 (the flex BASE
roster), SCH DURATION 8:00 (no COVER), LATE START -220 (against 07:00). TAA's ABSENT_SEGMENT is
correct per Rule 4 (logout 122m past the 18:40 COVER end, even after the COVER).

Two kill-switch-gated (`releaseProvenSafeHolds`) rules, measured on the real 23/09 sample
(`cognos.csv` 406 rows, `MTD_Seg.csv`, `CMS_23092026.csv` + `CMS_24092026.csv`, default config):
held **166 → 118**, `MISMATCH_FOUND` **80 → 32**, **0** verdict/action/actionsFired/net/late/
early/correction diffs across all 406 rows, 0 newly held.
1. **Flex roster translation** (`cognosComparison.ts`, `flexRosterShiftMin`). Only when the flex
   algorithm ran (`ctx.isFlex` = tagged AND inside the expected start window) and Cognos DUTY1 vs
   ASPECT DUTY1 is a pure move (same length ±tol): DUTY1 → NOT_COMPARABLE, and LATE START /
   LEFT EARLY → NOT_COMPARABLE only when their signed gap equals that move (±tol, direction
   checked). Any other gap stays MISMATCH and still holds. Non-flex roster moves are untouched
   (7 such rows on 23/09 stay held — several look like untagged flex staff, `90142xxx`).
2. **Gate B whole make-up COVER** (`reconciliationEngine.ts`, `gapIsWholeCover`). The late-
   make-up exclusion no longer applies when the SCH DURATION gap equals the day's entire COVER
   (±tol) — both readings then name the same minutes. The existing band-neutrality test
   (Late Logout / Cover Not Attended with vs without the gap) must still pass. Partial gaps keep
   the old exclusion (`reg-186`).

With the user's real `Config.json` (drops `UAE*` PFs → 218 rows, classifies every code above,
pre-releases every `*|MISMATCH_FOUND:*|NO_ACTION` combination): held **41 → 21**, **0**
calculation diffs, 0 newly held; released 20 = ABSENT_SEGMENT 9, SHIFT_UPDATE_FLEX 4,
LOGOFF_AND_COVER 4, LATE_AND_COVER 3 (all FLEX roster or whole-COVER rows). Of the 12
`MISMATCH_FOUND` left, 4 (PF 4500647, 4506601, 4507179, 4500116) show Cognos SCH DURATION exactly
60m BELOW ASPECT with no release segment in ASPECT, and TAA marks each ABSENT for a 50-60m early
logout — if Cognos's shorter day is right the absence is wrong, so these are genuine pay-affecting
disagreements and correctly stay held (likely a release/permission recorded outside ASPECT).

Tests: `reg-180`..`reg-186` (positive + negative twins, kill switch); suite 231 → 238.
`scheduleRecomputeBlocks.test.ts` note assertion updated for the whole-COVER wording, plus a
partial-gap case keeping the old note. Remaining 23/09 holds: 68 `UNCLASSIFIED_SEGMENT_CODE`
(glossary gaps — a business classification decision, not a calculation), 32 `MISMATCH_FOUND`
(mostly non-flex LATE_EARLY / SCHEDULE disagreements with pay-affecting actions).

## 7r. Already-actioned LATE / Log_off, wrong-basis release, off-grid RLS (2026-09-27)

1. **Already-actioned rule (business decision).** A LATE (or Log_off) already in ASPECT on the
   incident's NOM day means TAA takes no further action for that finding: no marker, no COVER
   (`findAlreadyRecordedIncident`, now a day-level code match). Before: an exact start+duration
   match skipped only the marker and still added the COVER; a LATE of different minutes (8m vs
   TAA 10m) exported a *second* LATE plus a COVER. Row: verdict kept, `TAA_ACTION = NO_ACTION`
   (flex: `SHIFT_UPDATE_FLEX`, shift pair only), no charged variance, trace names both figures.
   ABSENT band untouched. Side effect: a held row of this shape now falls in the `NO_ACTION`
   Hold Policy action group. `reg-142`/`reg-143` rewritten, `reg-187`/`reg-188` added.

2. **Same-basis LEFT EARLY release (Astra P1).** Both automatic LEFT EARLY releases — the
   positive same-band downgrade (`cognosComparison.ts`) and Gate A's negative branch — used a
   basis the policy never charges on: the first compared the two RAW figures to the Late Logout
   band, the second clamped Cognos to an early-logout count. With a trailing release this
   auto-exported an ABSENT that Cognos's own figure would not fire: RLS 14:30-15:00, logout
   15:31, Cognos 29 vs TAA 31 = 59m vs 61m past the release-adjusted end (no action vs ABSENT);
   likewise RLS 14:00-15:00, logout 15:01, Cognos -1 vs +1. Now one evaluator built by the engine
   from its own anchors (`ComparisonContext.logoutPolicy`: release-adjusted end, early anchor,
   attended-COVER credit — tried at full and at reduced credit when Cognos's logout is earlier —,
   tier, live Early/Late Logout rules) decides both, plus `defect1AutoExempt`, via
   `logoutOutcomeMatchesTaa`; it must also reproduce TAA's own outcome or nothing is released.
   `lateLogoutBandIndex` (pooled every tier's minMinutes, ignored maxMinutes/gaps) removed.
   Pairs on the same side still release (20 vs 22, 70 vs 72). Gate B's note now names the cover
   action when a COVER shortfall exists (it printed the Late Logout action, e.g. "NO_ACTION" on a
   Cover-Not-Attended ABSENT). `reg-189`; `auditFixes.test.ts` (c2) added and (e) fixed — it built
   "15:65", an unparseable time, so it had never compared a straddling pair.

3. **Release grid flag (business rule).** Releases are booked on a 30-minute grid (:00/:30 —
   never 14:35 or 15:22). A `releaseGridCodes` segment (default RLS, RLS-2H, RLS-3H, UN_RLS,
   Cover_RLS) off the `releaseGridMinutes` grid (default 30, 0 = off) sets `releaseGridNote` /
   export column `TAA_RELEASE_GRID_NOTE` and a trace line; `TAA_DISAGREE_REASON` becomes
   `RELEASE_OFF_GRID` only when still `MATCH`. Never a hold, never rounded (guessing ASPECT's
   intent would change paid minutes). Config Registry has both fields. `reg-190`.

4. **Cognos's logout, not its derived LEFT EARLY, + Rule 7 (GPT B / Astra P4).** The same-basis
   evaluator now reads WHEN Cognos says the agent left from its own `SIGIN OUT` (placed on the
   day nearest the CMS logout), because LEFT EARLY is derived from an anchor Cognos never exports
   — sometimes the raw end, sometimes the end of a COVER its SCH includes (PF 27519: Cognos 1 =
   16:01 - COVER end 16:00; TAA raw-end figure 61). SIGIN OUT is trusted alone only when it is
   consistent with LEFT EARLY against the raw end or a contiguous trailing COVER end (±tol);
   when Cognos contradicts itself (SIGIN OUT 15:31 but LEFT EARLY 29 on a 15:00 end), both
   readings must reach TAA's outcome. The outcome now also includes Rule 7 (Cover Not Attended,
   via the engine's own `evaluateCoverNotAttended`): Cognos out 15:00 vs CMS 15:10 with a
   15:00-15:10 COVER is ABSENT on Cognos's reading → held. Net effect: the 27519-shape false
   hold is released without any "net of COVER" special case and without using TAA-generated
   COVERs as evidence of Cognos's basis; PF 40101858-style gross-basis rows are unaffected
   (their LEFT EARLY already matched; SCH DURATION still decides). Real-data effect (27519,
   28596, 28646, 4036626, 16850, 90119785) must be confirmed with a local replay — 90119785
   would export its (separately matching) late-arrival ABSENT once released. `reg-189` (g)(h)(i).

5. **COVER allocation from the final include set (Astra P3).** Next-working-day COVERs were
   stacked on their target day in Cognos input order, and a HELD row's COVER kept its slot: an
   included row's COVER was exported 10m later behind an unexported reservation, the result
   depended on input row order, and unticking a row in review left the gap (`rebuildOutputs` only
   filtered). Now each such COVER carries `coverSlot` metadata (never exported) and
   `reallocateCoverSlots` re-stacks every employee|target-day group: included rows first, then
   held/unticked rows as provisional slots, each by incident date → PF → input order. It runs at
   the end of `runReconciliation`, after the Hold Policy in `pipeline.ts`, and on every Include
   toggle in `App.tsx`; approving a held row later re-stacks without overlap. A group that also
   holds a same-day cover (credited against proven attendance) is left exactly as placed.
   `reg-191`.

## 8. Open decisions before production implementation

Walked with the user; 9 of 10 resolved (1 stays open pending user-supplied text):

1. **CLOSED.** Informational/leave bucket memberships: architecturally resolved by design
   (discovery-driven glossary, §4.14 — new codes get a one-time classification prompt at upload,
   never a forced static preset). Additionally, 17 real ASPECT `SEG_CODE`s found unclassified
   against the real sample data (`Prestige Arb` 159 rows, `101-EGS` 100, `ES & SMB` 63,
   `RET/CAN-EGS` 36, `USMB-EGS` 34, `ECS` 32, `Prestige-EGS` 25, `OB-Sales` 20, `FLUP` 20,
   `e&Money Ajm` 16, `DOZ_RET_AR` 14, `Early Stage` 12, `High Consp` 9, `Bill Rev` 7,
   `e&money-EGS` 7, `O_ADHR` 5, `Collection Back Office` 3) — each carries a full shift-length
   duration overlapping the SAME window as the employee's own `SHIFT` segment, i.e. team/queue/
   campaign tags, not real worked time. Pre-classified `NO_EFFECT` in `DEFAULT_SEGMENT_GLOSSARY`
   (`configRegistry.ts`) so these 562+ segment occurrences stop needlessly triggering
   `UNCLASSIFIED_SEGMENT_CODE` holds.
2. **CLOSED.** CMS time-window grace interval: keep the 4h default (`cmsPunchSearchWindowHours`)
   — no evidence it's wrong; editable via Config Registry UI without a code change if real
   exports later show otherwise.
3. **CLOSED.** Working-day/weekend calendar: the ASPECT-driven approach (cover placement only
   targets days that actually carry ASPECT segments, so days off are naturally skipped since
   ASPECT has nothing scheduled there) is sufficient — no separate calendar needed.
4. **CLOSED.** Outlook lookup priority: traced the full chain — HTML side picks `EMP_EXTRA_2`
   over `EMP_EMAIL_ADR` on tiebreak (98.6% agreement, user-validated); VBA side
   (`vbaGenerator.ts`'s `TAA_ResolveAddress`) then resolves that against the real Exchange GAL
   via `CreateRecipient`/`Resolve`, tries `EMP_EMAIL_ADR` next, then falls back to the display
   name; for `EMAIL_STAFF_CC_MANAGER` it calls `GetExchangeUserManager` (`TAA_ResolveManagerAddress`)
   and appends an "audit warning: manager CC could not be resolved" line to the draft body
   instead of blocking if no manager is found. No gap found — user confirmed close.
4a. **CLOSED.** Punch-attribution tie-break (D-D): a real scheduled shift beats a synthetic
   leave-day window; a remaining tie goes to the earlier-starting window; anything still tied is
   held for review rather than guessed. See §7b.
5. **CLOSED (operational policy).** Identity master refresh cadence: re-upload
   `ASPECT_ExtraFiled.csv` at the start of every reconciliation run (uploads are already
   non-blocking/any-order, §6.1, so this costs nothing extra) — an operating habit, not a code
   change.
6. **CLOSED (deferred, unchanged).** Partial leave / split-shift live examples: `samples_Files`
   has zero real occurrences of `ANNL-5/6/7`, `Sick-4/9`, or genuinely separated split shifts —
   stays "modeled but untested" until real data appears; not blocking anything else.
7. **CLOSED.** Matching-date inputs / forward ASPECT coverage: `assessCmsCoverage()`
   (`punchAttribution.ts`) was fully implemented but was DEAD CODE — never called from any UI
   component, so its warning never reached a user. Wired into `App.tsx`'s dashboard as a
   non-blocking amber advisory banner shown pre-Calculate when the uploaded CMS export's date
   range doesn't fully cover the Cognos report's own range. Advisory only — the real per-row gate
   remains the existing `INSUFFICIENT_CMS_COVERAGE` hold produced by `runReconciliation` itself.
   The "require the ASPECT export to span forward" half of this item has no equivalent
   pre-Calculate check yet — not addressed this pass.
8. **CLOSED (accepted working definition).** ASPECT action codes `10`/`11`: already used
   consistently as original/updated in every flex shift-update pair, matching the user's own
   original example — accepted as the working definition absent contradicting vendor
   documentation.
9. **OPEN — placeholder wording PROPOSED (2026-09-07), pending user approval.** Email
   body/content for the VBA-drafted messages: user wants specific replacement text for the
   subject line, opening/intro line, and closing/disclaimer line (structure otherwise confirmed
   fine). As of this pass, `DEFAULT_EMAIL_TEMPLATES` in `emailDrafts.ts` carries proposed text for
   those three pieces (marked in a comment above the constant as a draft, not final): subject
   `TAA Attendance Review Notice: {finding} — {name} — {date}`; opening line `This is an automated
   Time & Attendance (TAA) review notice regarding {name} (PF {id}) for {date}. Please review the
   details below.`; closing line `This message is an automatically generated DRAFT only — no
   email has been sent. Please verify all details against the official Cognos discrepancy report
   before editing or sending. Generated by the TAA Time & Attendance reconciliation tool.` The
   structural block (`Finding: {rule}`, `Action taken: {action}`, optional `Actions fired: {list}`
   per §7a D-A, the TERMINATED audit warning) is unchanged. **Not CLOSED** — this text still needs
   explicit sign-off or edits from the user before it's anything but a placeholder.
10. **CLOSED.** Flex-tagged employee whose scheduled start falls outside the expected
    07:00–10:00 window: the flex cutoff algorithm is skipped; standard attendance rules run
    instead, and the row is forced-held `FLEX_SCHEDULE_OUTSIDE_WINDOW` so a human confirms the
    flex tag or the schedule before any correction is exported. A soft warning alone is not
    enough — the absolute 10:00 cutoff must never run against an afternoon/night shift.

## 8a. Recompute-then-compare engine architecture (implemented)

The reconciliation engine (`TAA_HTML/src/services/`) is split into four cooperating modules,
run in this order by `reconciliationEngine.ts`:

1. **`scheduleRecompute.ts`** — per `(EMP_ID, NOM_DATE)`, rebuilds the raw/effective schedule
   window, net scheduled minutes, and Duty1/Duty2 blocks **entirely from ASPECT segments**
   (glossary-driven Addition/Removal roles). Cognos is never read here.
2. **`punchAttribution.ts`** — a single global pass assigns every CMS punch to at most one
   scheduled window (nearest-window-wins by distance), and separately determines whether the
   CMS export's own data reaches far enough around that window to trust a 0/1-punch result.
3. **`cognosComparison.ts`** — recomputes and compares 12 Cognos columns against the values
   from steps 1–2, producing an explicit per-column status plus a fill-if-blank list.
4. **`reconciliationEngine.ts`** — orchestrates 1–3, applies the attendance-rule policy matrix,
   Rules 7/8, flex branches, cover placement, and the include/hold review gate; writes all 3
   outputs.

`regressionSuite.ts` carried 17 cases (13 original + 4 added for this rebuild: consecutive
night-shift punch attribution, insufficient-CMS-coverage hold, the negative case proving Rule 6
still fires with full coverage, and fill-if-blank never overwriting a populated cell) — all
passing as of this rebuild. Since grown to 63 cases (`reg-1`–`reg-63`) — see §7b's
"Current state" note.

## 9. Implementation checklist

**Status as of 2026-09-06** — this checklist was originally written pre-implementation and left
entirely unchecked despite §7/§8a documenting most of it as done; it's now reconciled against
the actual codebase so the two don't contradict each other.

- [x] Treat `Rules to be taken.xlsx` as the policy source; transform it into visible, editable config. (`configRegistry.ts`'s `INITIAL_POLICY_RULES`, `ConfigRegistryView.tsx` Policy Rules Matrix tab.)
- [ ] Enforce source-file fingerprint/date/scope checks before a run. Not implemented — no fingerprint/date/scope validation exists on upload.
- [ ] Fail visibly if CMS coverage does not include required Cognos Login IDs or the schedule window. Partially done: `assessCmsCoverage()` (`punchAttribution.ts`) is wired into `App.tsx` as a non-blocking amber advisory banner (§8 item 7), not a hard fail — the per-row `INSUFFICIENT_CMS_COVERAGE` hold is the real gate. The "require the ASPECT export to span forward" half has no pre-Calculate check at all.
- [x] Preserve Cognos bytes/columns and write analysis only to appended, clearly labelled fields — recomputed values sit beside Cognos's originals column-by-column, not just a final agree/disagree flag. (`cognosComparison.ts` + `generateAnnotatedCognosFile()`.)
- [x] Keep normal OT1 and public-holiday OT2 separate in calculations, output, and reporting.
- [ ] Record inputs, config version, joins, exceptions, and generated actions in an auditable run log. Not implemented as a standalone run log — per-row `calculationTrace`/`VarianceTrace` exist, but nothing aggregates a full run's inputs/config-version/joins/exceptions together.
- [x] Create email drafts only after a human reviews the actions list. Eligible Results rows can invoke the `taa-email:` request bridge individually or in bulk; the legacy manual JSON path remains available. Both paths only create `.Display` drafts.
- [x] Implement the two-gate day evaluation (attendance-rule gate + leave-day integrity check) — never a single "skip if no SHIFT/OT" gate.
- [x] Implement flex staff as the absolute-10:00-cutoff, two-action (shift-update + Late/Cover), full-variance-charged branch — not a relative buffer.
- [x] Implement the cover-placement algorithm exactly (last-segment-of-day placement, stacking, configurable fallback) — not "next day at shift start."
- [x] Charge the full measured variance on every banded rule, never `measured − threshold`.
- [x] Column-mapping UI on all 4 required uploads (grew from 3 once ASPECT ExtraFiled/Identity Master became a required, gating upload — §6a); Cognos import with zero silent drops (config-gated only). (`ColumnMappingModal.tsx`.)
- [x] VBA companion as one workbook, two macros, Excel-hidden with guaranteed state restore on error; `RunCMSExport` fails loudly on a missing CMS login, never silently.
- [x] Config Registry covering every tunable listed in §6a, with export/import/reset in the UI. (`ConfigRegistryView.tsx` + `configRegistry.ts`.)
- [x] 5-category results UI (Shift changed / Late+Cover / Absent / No action required / Cognos data gap), visually distinguishing the last two from each other, plus a "Held for Review" category for MISMATCH/hold rows. (`ResultsView.tsx`.)
