# ASPECT format & cross-midnight knowledge (mined from breakOptimization/HTML version)

**Source:** `C:\Users\lenovo\Desktop\breakOptimization\HTML version` — a standalone JS port
(`optimizer-engine.js`, 4321 lines) of a VBA break-optimizer that reads real ASPECT/WFM
schedule exports and writes ASPECT correction CSVs. Cross-referenced with its `PRD.md`,
`project_context.md`, unit self-tests, and real production sample output
(`Updated_Breaks_20260817_180128.csv`).

**Why this file exists:** that codebase independently implements cross-midnight shift
arithmetic and an ASPECT correction-CSV writer, validated against real data. It is a
**different tool with a different column schema** than TAA's actual ASPECT files — see
Caveats (§7) before reusing anything literally. What's reusable is the *pattern*: how to
detect a wrap, how to keep "nominal shift day" separate from "physical calendar day", and
the output CSV conventions.

---

## 1. ASPECT/WFM input column dictionary

Required columns (verbatim header strings, validated at load time — throws if missing):

```
ID, Code, Nominal Date, Start Time of Day, Stop Time of Day, Duration, Rank
```

Optional absolute-datetime columns: `Start`, `Stop`.

| Column | Meaning |
|---|---|
| `ID` | Employee ID. Normalized: whitespace/tabs/NBSP collapsed, all spaces removed (`trimID`). |
| `Code` | Segment/activity code (e.g. `Prestige Arb` = shift, `PRY-BK` = prayer, `break1`-`break4`, `EFTAR`, `PRG_break`, or site-custom codes like `BREAK3`/`BREAK4`). |
| `Rank` | Integer ordering of segments within a shift. |
| `Nominal Date` | The **shift day** the segment is nominally attributed to — an Excel date serial. This stays anchored to the shift's start day even for segments that physically fall after midnight. |
| `Start Time of Day` / `Stop Time of Day` | Excel time-of-day fractions (0–1), i.e. fraction of a 24h day. |
| `Duration` | Fraction-of-day number. If ≤ 0 in the source, it's derived as `StopTOD - StartTOD` (wrap-adjusted). |
| `Start` / `Stop` (optional) | Absolute Excel serial datetimes (date+time combined). When absent, overnight segment "location dates" fall back to being derived from Nominal Date + shift start. |

All dates/times are **Excel-serial fractional-day numbers** (epoch `1899-12-30`), not
ISO/real timestamps. No genuine timezone handling exists anywhere — UTC is used internally
only to dodge JS `Date` DST bugs, never to represent a real timezone offset.

---

## 2. Cross-midnight ("overnight") detection & arithmetic

This is the core transferable knowledge. Concepts, then the formulas.

### Concept: wrap = stop-time-of-day is numerically before start-time-of-day
A shift "wraps" midnight when its end time-of-day is less than its start time-of-day (pure
TOD comparison), or — when absolute datetime serials are available — when the stop serial
lands beyond the start serial's day boundary.

### Concept: Nominal Date ≠ physical calendar date
For a wrapping shift, segments occurring after midnight are still tagged with the **same
Nominal Date** as the shift's start day (this is the "shift day" anchor), but their
**physical/calendar location date is shift-day + 1**. A segment is "post-midnight" when its
own start time-of-day is *less than* the shift's start time-of-day (only possible/meaningful
when the shift itself wraps).

### Formulas (JS, from `optimizer-engine.js`)

Wrap detection:
```js
function shiftWraps(shiftStart, shiftStop) {
  return normalizeTOD(shiftStop) < normalizeTOD(shiftStart);
}

function shiftWrapsAbsolute(shiftStartAbs, shiftStopAbs) {
  if (shiftStartAbs <= 0 || shiftStopAbs <= 0) {
    return shiftWraps(normalizeTOD(shiftStartAbs), normalizeTOD(shiftStopAbs));
  }
  if (shiftStopAbs <= shiftStartAbs) {
    return shiftWraps(normalizeTOD(shiftStartAbs), normalizeTOD(shiftStopAbs));
  }
  return shiftStopAbs > Math.floor(shiftStartAbs) + 1;
}
```

Is a given segment "after midnight" relative to its shift:
```js
function segmentIsPostMidnight(shiftStart, shiftStop, tod) {
  if (!shiftWraps(shiftStart, shiftStop)) return false;
  return normalizeTOD(tod) < normalizeTOD(shiftStart);
}

function segmentIsPostMidnightAbsolute(shiftStartAbs, shiftStopAbs, segStartAbs) {
  if (shiftStartAbs <= 0 || shiftStopAbs <= 0 || segStartAbs <= 0) return false;
  if (!shiftWrapsAbsolute(shiftStartAbs, shiftStopAbs)) return false;
  return Math.floor(segStartAbs) > Math.floor(shiftStartAbs);
}
```

Calendar "location" date for a segment (nominal-day vs nominal-day+1):
```js
function segmentLocationSerial(anchorSerial, shiftStart, shiftStop, segStartTOD) {
  if (segmentIsPostMidnight(shiftStart, shiftStop, segStartTOD)) {
    return Math.floor(anchorSerial) + 1;
  }
  return Math.floor(anchorSerial);
}
```

Shift duration across a wrap (adds a day's worth when wrapped):
```js
function shiftLengthMinutes(shiftStart, shiftStop) {
  var s = normalizeTOD(shiftStart);
  var e = normalizeTOD(shiftStop);
  if (!shiftWraps(shiftStart, shiftStop)) return (e - s) * 1440;
  return (1 - s + e) * 1440;
}
// With absolute serials it's simply (stop - start) * 1440 — no wrap-case branching needed,
// since the date is already baked into the serial.
```

Anchoring a bare time-of-day to the shift's actual calendar day (adds a day when the TOD is
on the far side of midnight from shift start):
```js
function activityAbsFromShift(shiftStartAbs, shiftStopAbs, tod) {
  var t = normalizeTOD(tod);
  if (shiftStartAbs <= 0) return t;
  var baseDay = Math.floor(shiftStartAbs);
  if (shiftWrapsAbsolute(shiftStartAbs, shiftStopAbs)) {
    if (t < normalizeTOD(shiftStartAbs) - EPS) {
      return baseDay + 1 + t;
    }
  }
  return baseDay + t;
}
```

Wrap-symmetric interval overlap (checks the pair at three day alignments — today, +1, −1 —
so overlap detection works without needing absolute serials):
```js
function intervalsOverlap(aStart, aStop, bStart, bStop) {
  var as_ = normalizeTOD(aStart), ae = normalizeTOD(aStop);
  var bs = normalizeTOD(bStart), be = normalizeTOD(bStop);
  if (ae <= as_) ae += 1;
  if (be <= bs) be += 1;
  return halfOpenOverlap(as_, ae, bs, be) ||
    halfOpenOverlap(as_, ae, bs + 1, be + 1) ||
    halfOpenOverlap(as_, ae, bs - 1, be - 1);
}
```

Legal-window check across a wrap flips the range test from AND to OR:
```js
function slotInLegalWindow(slot, minSlot, maxSlot, wraps, slotsPerDay) {
  if (slot < 0 || slot >= slotsPerDay) return false;
  if (!wraps) return slot >= minSlot && slot <= maxSlot;
  return slot >= minSlot || slot <= maxSlot;
}
```

### Real production example
From `Updated_Breaks_20260817_180128.csv` (rows 10–11), same shift, same break, moved:
```
10,90120666,BREAK3,21/08/2026,22/08/2026,00:20,00:15,"Auto-break-update",
11,90120666,BREAK3,21/08/2026,21/08/2026,23:45,00:15,"Auto-break-update",
```
Field 4 (Nominal/shift date) is `21/08/2026` in **both** rows. Field 5 (calendar location
date) differs: originally `22/08/2026 00:20` (after midnight), moved to `21/08/2026 23:45`
(before midnight, same shift). This is the concrete proof that "shift day" and "physical
calendar day" are tracked as two separate values, not collapsed into one date field.

### Self-test fixtures confirming the intent
```js
assertTrue(shiftWraps(0.9, 0.2), 'ShiftWraps overnight');
assertTrue(shiftContainsTOD(0.9, 0.2, 0.95), 'ShiftContains overnight late');
assertTrue(Math.abs(shiftLengthMinutes(0.9, 0.2) - 432) < 0.5, 'ShiftLengthMinutes overnight 22:00-04:48-ish');
assertTrue(formatDateSerial(Math.floor(absOut)) === '17/08/2026', 'Field5 overnight 01:00 calendar day');
```

---

## 3. Time parsing / rounding conventions

- Excel-serial epoch (`1899-12-30`) for every date/time value; no real timezone offsets applied anywhere.
- Duration precedence: uploaded `Duration` column wins if `> 0`; otherwise derive `StopTOD - StartTOD` (wrap-adjusted).
- Output "Duration" field is treated as immutable — moving a segment's start/stop never changes its recorded duration.
- Time grid: default 5-minute slots; times are floored to the slot grid (`todToSlot`/`slotToTOD`). Off-grid times (e.g. `23:02`) are treated as invalid.
- Display rounding: `Math.round` used when converting time-of-day fractions to minutes for display/violation records.
- Numeric parsing tolerates comma decimal separators (`23,5` → `23.5`).
- Accepted date string formats: `dd/mm/yyyy` or `dd-mm-yyyy` only (regex-matched) — no other formats, no timezone suffix ever parsed.

---

## 4. Output ASPECT correction CSV format

Each row has exactly 8 comma-joined fields **plus a trailing comma**:

```js
function joinCSVFields(fields) {
  return fields.join(',') + ',';
}
```

| # | Field | Notes |
|---|-------|---|
| 1 | RecordType | `10` = original state, `11` = new/corrected state |
| 2 | EmpID | Normalized employee ID |
| 3 | Code | Activity/segment code |
| 4 | Date | Nominal/shift-day date key, `dd/mm/yyyy` — unchanged between the `10` and `11` rows for the same move |
| 5 | SegmentDate | Physical calendar location date, `dd/mm/yyyy` — can differ from field 4 for overnight segments |
| 6 | Time | `HH:MM` |
| 7 | Duration | `HH:MM`, immutable — same value on both the `10` and `11` rows |
| 8 | Tag | Quoted free-text tag, e.g. `"Auto-break-update"` |

**Two lines per changed segment**: a `10` row (original start/stop) and an `11` row (new
start/stop) are both emitted. Only segments whose start or stop actually changed are
written — no change means no CSV rows. If nothing changed, the CSV has zero content lines.

Tag resolution logic (which literal string goes in field 8): prayer-follow moves get one
tag, risk-relief-driven moves get another, everything else gets the configured default
(`"Auto-break-update"`). Tags are just descriptive metadata on the correction row, not
structural.

Filename pattern: `Updated_Breaks_YYYYMMDD_HHMMSS.csv`.

**Relevance to TAA:** this independently confirms the same "trailing comma after every
ASPECT upload row" convention already codified in TAA's own non-negotiables
(`CLAUDE.md`: "ASPECT upload CSV rows (header and data) end with a trailing comma"). Two
unrelated codebases writing to ASPECT import both need it — treat it as a hard ASPECT
platform requirement, not a one-off quirk of either tool.

---

## 5. Segment-code classification pattern

Segments are bucketed into exactly 3 categories, driven by **configurable code lists**
rather than a hardcoded switch statement:

```js
act.IsShift = codesMatch(code, ruleParams.ShiftActivityCode);   // e.g. "Prestige Arb"
act.IsPrayer = codesMatch(code, ruleParams.PrayerActivityCode); // e.g. "PRY-BK"
act.IsNormalBreak = !act.IsShift && !act.IsPrayer;               // everything else on the whitelist
```

A separate whitelist filter drops any row whose `Code` isn't Shift, Prayer, or in the
configured break-code list (`BreakActivityCodes`, default `['break1','break2','break3',
'break4','EFTAR','PRG_break']`, but expected to be edited per deployment — real production
data shows custom codes like `BREAK3`, `BREAK4`, `BREAK_PRE`, `BREAK_MID`, `BREAK_POST`,
`BREAK_N1`, `BREAK_A`).

**Relevance to TAA:** structurally this is the same idea as TAA's own zero-hardcode segment
glossary (PRD §4.14) — classify each observed code once via config, never via a literal
list buried in code. Confirms that a small number of semantic buckets (there: Shift /
Prayer / Break; in TAA: Addition / Removal / No Effect) driven by editable config is the
right general shape for this kind of classifier.

---

## 6. Caveats — this is NOT TAA's ASPECT schema

Do not copy column names or field positions literally into TAA code. This project's ASPECT
files use different headers than TAA's actual ASPECT exports:

| This project (`HTML version`) | TAA's actual ASPECT files |
|---|---|
| `ID`, `Code`, `Nominal Date`, `Start Time of Day`, `Stop Time of Day`, `Duration`, `Rank` | `EMP_ID`, `SEG_CODE`, `NOM_DATE`, `START_DATE`/`START_MOMENT`, `STOP_DATE`/`STOP_MOMENT`, etc. — see TAA's own `PRD.md` and `aspect-workforce-management` skill for the real dictionary (`ASPECT_Schdule_Segments.csv`, `ASPECT_ExtraFiled2.csv`) |
| Excel-serial fractional-day numbers | TAA parses ASPECT dates as documented in `PRD.md`/`TAA_KNOWLEDGE_BASE.md` |

What transfers is the **pattern**, not the literal implementation:
- how to detect and reason about a midnight-crossing shift (wrap detection, nominal-day vs
  calendar-day separation, duration-across-wrap arithmetic)
- the trailing-comma ASPECT upload CSV convention
- config-driven (not hardcoded) segment-code classification

Always cross-check against TAA's own `PRD.md`, `TAA_KNOWLEDGE_BASE.md`, and the
`aspect-workforce-management` skill before implementing — those remain authoritative for
TAA's actual data model and non-negotiables (e.g. TAA's own rule: **join CMS by time
window, never by calendar date**, which is a stricter, TAA-specific requirement not present
in this source project).
