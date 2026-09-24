# Claude implementation prompt — TAA action integrity (100% payroll)

Copy everything below the line into a Claude session that will implement against the TAA repo. This file is the spec. Do not invent softer rules.

---

## Role

You are implementing payroll-critical fixes in the TAA Time & Attendance reconciliation app (Vite/React/TS under `TAA_HTML/`, also shipped as `TAA_Workspace.html`).

**This is a payroll system.** Wrong action = we pay more hours or the agent loses hours. Target: **100% action integrity** — every recommended ASPECT correction must match `Rules to be taken.xlsx` / CSV, be complete (no half-pairs), and be reviewable when Cognos disagrees.

## Read first (mandatory)

1. `doc/PRD.md` §4.1–4.12 (rules, flex, cover placement, OT→SHIFT, recompute-then-compare)
2. `doc/CLAUDE.md` (non-negotiables)
3. `doc/TAA_KNOWLEDGE_BASE.md` (verified facts / known defects)
4. `.claude/skills/taa-time-attendance/SKILL.md`
5. `.claude/skills/aspect-workforce-management/SKILL.md`
6. `samples_Files/Rules to be taken.csv` — **authoritative**; never implement deprecated `doc/Rules.txt`

Primary code:
- `TAA_HTML/src/services/reconciliationEngine.ts`
- `TAA_HTML/src/services/scheduleRecompute.ts`
- `TAA_HTML/src/services/punchAttribution.ts`
- `TAA_HTML/src/services/cognosComparison.ts`
- `TAA_HTML/src/services/configRegistry.ts`
- `TAA_HTML/src/services/holdReasons.ts`
- `TAA_HTML/src/components/ResultsView.tsx`
- `TAA_HTML/src/services/regressionSuite.ts`
- `TAA_HTML/src/services/trustMatrix.ts`

---

## Locked product rule (user-confirmed)

1. **Validate Cognos first** (recompute-then-compare; annotate disagreements).
2. Engine still **computes the full recommended ASPECT correction** from ASPECT schedule + CMS punches + config rules.
3. When Cognos disagrees (`MISMATCH_FOUND`), the row stays **Held**.
4. **TAA staff choose Include or not** — never auto-export a disagreement into the ASPECT CSV.
5. **Never show a half-action**: LATE without COVER, Log_off without COVER, or a scheduled no-login day with no Absent NS/NC recommendation when Rule 5 applies.

```
Cognos row → recompute ASPECT+CMS → compare vs Cognos → complete recommended corrections
  → hold for staff → staff Include? → ASPECT CSV
  → always write annotated Cognos (with recommendation visible)
```

---

## Current defects (verified against live code, then re-verified independently three times — see status per item)

Every claim below was checked directly against `reconciliationEngine.ts` line-by-line before
being accepted, not taken on a prior draft's word. **Only D2 can reach the exported ASPECT
correction CSV.** D1 and D4 are real but review-only. D3 was already correct — do not "fix" it.

### D2 — Absent + leftover timed penalties (pay double-hit) — **MUST FIX, reaches the CSV — FIXED 2026-09-09**

Late Login and Early Logout are **independent `if` blocks**, not `else if`. `applyMoreSevere` only updates the reported verdict/action — it does **not** remove already-pushed corrections.

Example: Late ≥61 → pushes `ABSENT`; Early out 5–9 → still pushes `Log_off` + `COVER`. Same day can get **ABSENT + Log_off + COVER**.

`dedupeAspectCorrections` only collapses duplicate Absent markers — it does **not** strip LATE/Log_off/COVER beside ABSENT.

**Export condition, worth stating explicitly:** a row only exports when it has **no hold of any kind**, and the dominant gate is `MISMATCH_FOUND` (set whenever `comparisonResult.mismatchColumns.length > 0`). So this defect fires precisely when **Cognos agrees** with TAA's own recompute — the clean, uncontested rows nobody opens for review. It is the quiet common path, not an edge case, which is what makes it the one must-fix-for-pay item here.

**Fix (implemented):** if the winning payroll action for the employee-day is `ABSENT` or `Absent NS/NC`, strip LATE, Log_off, and COVER from recommended corrections, once all rules for the day have fired. Keep OT→SHIFT conversion once (`convertOtOnce`). **The non-obvious part:** each COVER reserves a slot in `placedCoversThisRun` the moment it's placed — stripping the row without releasing that reservation would push the *next* cover for the same employee/target-day later, a new pay error in a different row. The fix carries a `coverReservationByRow` WeakMap so a stripped COVER releases its exact reservation entry.

### D1 — Late / Log_off without COVER in `generatedCorrections` — **should-fix for review, cannot reach the CSV**

In `reconciliationEngine.ts`, Late+Cover and Log_off+Cover **push LATE or Log_off first**, then call `placeCoverSegment`. If COVER placement returns `null` (target-day integrity: duration disagreement, invalid datetime, mid-shift / out-of-window removal), COVER is omitted, a hold reason is set, but LATE/Log_off **remains** in `rowCorrections`.

**Why this cannot become a pay error, confirmed by three independent gates:** every `placeCoverSegment` failure routes through `describeCoverPlacementFailure`, whose every possible return value is a member of `FORCED_HOLD_REASONS` (`holdReasons.ts`). `holdReason` is seeded from `forcedHoldReason` before any overridable hold is considered, so it can never fall through to the reviewer-overridable `MISMATCH_FOUND`. Include is then blocked at both the view layer (`ResultsView.tsx`'s checkbox `disabled={isForcedHoldReason(...)}` and the row-detail toggle) and the state layer (`App.tsx`'s `handleToggleInclude`/`handleToggleIncludeAll`, which refuse to flip `includeInOutput` for a forced-hold row even if the UI check were bypassed). Email drafting is separately gated on `includeInOutput && !isForcedHoldReason(...)`. So the claim that a held row's exported CSV "may look empty… looks like no late and no cover" does not hold — held rows are excluded from the CSV by `includeInOutput` regardless of what `generatedCorrections` contains.

**The actual defect:** it violates payroll invariant 3 below ("hold keeps the full recommendation") — a locked row's on-screen recommendation can show a half-action, which a reviewer could misread as the intended correction even though it can never be exported as-is. Worth fixing for reviewability; not payroll-urgent.

**Real call sites — four, not five** (one claimed site is a false positive, see below):
- Flex Branch B late+cover (~960)
- Standard Late Login (~1150)
- Standard Early Logout (~1204)
- Shared `evaluateEarlyAndLateLogout` (~2018) — already the most complete of the four: on failure it downgrades the action to `MANUAL_REVIEW_REQUIRED` and names the block reason in `ruleFired`, the template the other three sites should follow. It still leaves Log_off in `rowCorrections` (review-only, since the row is locked).

**False positive, drop from the list:** `buildCoverNotAttendedOutcomes`'s `moveCoverForward` branch does **not** push a standalone LATE/Log_off before calling `placeCoverSegment` — on failure it returns `correction: null`, orphaning nothing.

Cover fallback (`sameDay` / `nextDirectDay` / `nextWeekMonday`) already handles "no next working day uploaded". `null` from placement is **unsafe target day**, not missing future data — must not leave LATE hanging in the on-screen recommendation.

### D3 — "No absent for non-login" — **already correct in live code, do not change**

Independently verified against every row below; do not "fix" this as if a branch were missing. Use it as a regression-test target instead.

| Situation | Correct behavior | Verified at |
|---|---|---|
| Populated LOGIN ID, zero CMS punches, scheduled SHIFT/OT | Recommend `Absent NS/NC` (Rule 5) | `resolveNoLoginDecision`'s default branch |
| Same + Cognos column mismatch | Recommend Absent NS/NC, **Hold**, staff Include | `MISMATCH_FOUND` gate, overridable |
| Blank LOGIN ID | Forced hold `MISSING_CMS_JOIN_KEY` — **no** Absent (missing join key ≠ absence) | GATE 0, `missingJoinKey` branch |
| CMS coverage insufficient | Forced hold `INSUFFICIENT_CMS_COVERAGE` — **no** invented Absent | `insufficientEvidence && insufficientCoverage` branch |
| Leave/OFF, no SHIFT/OT, no login | §4.6b — **no** Absent unless login ≥ `leaveLoginThresholdMinutes` | Leave-day integrity gate |
| Cognos date vs ASPECT NOM_DATE no overlap | `COGNOS_DATA_GAP` — day not evaluable | `!rawStartDt \|\| !rawEndDt` branch |
| Below band late (OPS 1–5, Officer 1–10) | `NO_ACTION` — not a missed Late+Cover | Policy rule bands, no gap below the lowest band |

### D4 — Held vs Included category conflation — **should-fix for review, UI counts only**

`ResultsView` counts `TAA_RESULT_CATEGORY` (e.g. `LATE_AND_COVER_ADDED`) regardless of `holdReason` / `includeInOutput` — the two counters are not mutually exclusive, so a held Late+Cover row increments both `LATE_AND_COVER_ADDED` and `HELD`, and the tab counts can sum above `rows.length`. Held Late+Cover looks like already-actioned Late+Cover.

**Fix:** visually and in counts distinguish Held (recommended, not in CSV) from Included (in ASPECT CSV). No payroll impact — the CSV itself is unaffected; this is purely what staff see while reviewing.

---

## Payroll invariants (must hold after your change)

1. **Atomic pairs.** `LATE_AND_COVER` and `LOGOFF_AND_COVER` are one transaction: `generatedCorrections` contains **both** rows or **neither**. If COVER cannot be placed safely, do not leave LATE/Log_off alone. Hold with an explicit incomplete-pair reason. If the only problem is missing future ASPECT, use existing §4.11 Step 5 fallback and still emit the complete pair (with fallback Memo / `TAA_COVER_FALLBACK_NOTE`).

2. **[FIXED 2026-09-09] Absent excludes timed penalties.** Winning `ABSENT` / `Absent NS/NC` ⇒ no LATE, Log_off, or COVER on that employee-day. Still convert OT1/OT2 → `SHIFT` (`otToShiftConversionCode`) at most once.

3. **Hold keeps the full recommendation.** On a Held row, `generatedCorrections` must be exactly what would upload if staff Include. Never empty the recommendation just because Cognos mismatched.

4. **Staff Include is the disagreement gate.** `MISMATCH_FOUND` remains overridable (not in `FORCED_HOLD_REASONS`). Do not auto-export. Forced holds stay locked for missing/contradictory evidence. Show why — never invent Absent.

5. **Rule 5 vs Rule 6 vs leave.** SHIFT or OT + zero punches + populated LOGIN ID → `Absent NS/NC`. Single punch / thin span with sufficient CMS coverage → `ABSENT`. Leave/OFF without SHIFT/OT → no Absent unless login ≥ `leaveLoginThresholdMinutes`.

6. **Full variance.** Charge measured minutes, never `measured − threshold`. Cover duration = charged late/early minutes.

7. **Effective window.** Late / early / late-logout vs release-nursing-adjusted start/end. Cognos raw `LATE START` / `LEFT EARLY` are for annotation only.

8. **ASPECT row shape.** Trailing comma on every CSV line; `00` inserts; `10`/`11` change pairs; COVER `nominateDate` = target schedule `NOM_DATE`; `SegmentDate` = physical start; Absent markers empty time/duration.

---

## UI / Include workflow

In `ResultsView.tsx` (and annotated Cognos as needed):

- Held row: show **Recommended ASPECT rows** checklist (SegmentCode, nominateDate, SegmentDate, start, duration, Memo).
- Explicit recommendation states (add to types if needed):
  - `COMPLETE_READY_TO_INCLUDE`
  - `INCOMPLETE_BLOCKED`
  - `NO_ACTION`
  - `FORCED_HOLD_NO_RECOMMENDATION`
- Include remains the existing override for `MISMATCH_FOUND` only.
- If recommendation is `INCOMPLETE_BLOCKED`, **disable Include** until pair is complete or source data is fixed.
- Category counts / badges: Held Late+Cover must not look like Included Late+Cover.

Label copy: **Recommended action (not in ASPECT CSV until Include)**.

---

## Scenario catalog — each must become a golden test

Assert for every case: `TAA_VERDICT`, `TAA_ACTION`, `TAA_ACTIONS_FIRED`, **every recommended SegmentCode** (and durations), hold vs include, communication rule. Extend `regressionSuite.ts` and/or `trustMatrix.ts`. Keep Calculate gate on green regression + trust matrix.

### Everyday (must never regress)

| ID | Scenario | Expected recommendation |
|---|---|---|
| E01 | On time | No correction |
| E02 | Early login | No correction (Rule 2) |
| E03 | OPS late 5 | NO_ACTION |
| E04 | OPS late 6 | LATE + COVER, duration 00:06 each |
| E05 | OPS late 60 | LATE + COVER, 00:60 |
| E06 | OPS late 61 | ABSENT only (no LATE/COVER) |
| E07 | Officer late 10 | NO_ACTION |
| E08 | Officer late 11 / 60 | LATE + COVER |
| E09 | Officer late 61 | ABSENT only |
| E10 | OPS early-out 4 | NO_ACTION |
| E11 | OPS early-out 5–9 | Log_off + COVER |
| E12 | OPS early-out 10+ | ABSENT only |
| E13 | Officer early-out 5 / 6–20 / 21+ | bands as Rules CSV |
| E14 | Late logout 59 vs 60 from **effective** end | cliff at 60 → ABSENT |
| E15 | No login, LOGIN ID set, SHIFT/OT | Absent NS/NC + email per tier |
| E16 | Single punch, coverage OK | ABSENT + email |
| E17 | Cover not attended bands | Absent + email bands per Rules |
| E18 | RLS overlaps OT | OT 10 then 11 reduced duration (skip NURSNG in Rule 8) |
| E19 | Flex ≤10:00, start moved | shift 10/11 only if snapped start differs |
| E20 | Flex 10:01+ | clamp shift to 10:00 + LATE+COVER from cutoff (bands bypassed) |
| E21 | Night PF 4507957 in 23:08 | 8 min LATE+COVER, not U-ABSENT |
| E22 | Night PF 90135621 in 18:57 | PRESENT |
| E23 | Eman / Minas NURSNG trailing | no early-leave action |
| E24 | P/H-LV + OT2, no SHIFT | evaluate; never skip OT2 |
| E25 | Absent day with OT | OT→SHIFT once |
| E26 | Cover next working day after last segment; stack; fallback Memo | as PRD §4.11 |

### Hard / compound (payroll breakers)

| ID | Scenario | Expected recommendation |
|---|---|---|
| H01 | Late 20 + early-out 7 (OPS) | LATE + COVER **and** Log_off + COVER; two stacked covers; full minutes |
| H02 | Late 61 + early-out 7 | **one ABSENT only** — no LATE, Log_off, COVER |
| H03 | Late 20 + early-out 15 (OPS) | Absent wins (early-out cliff); no leftover LATE/COVER |
| H04 | Flex past cutoff + early-out Absent | Absent + OT conversion; document whether shift 10/11 kept; **drop** Late+Cover |
| H05 | Cover on overnight target + trailing NURSNG | nominateDate vs SegmentDate split (see reg-97) |
| H06 | Cover target day duration-disagree | never LATE-only; incomplete hold **or** next safe day / fallback with complete pair |
| H07 | No login + Cognos U-ABSENT agree | Absent NS/NC; Include allowed if no forced hold |
| H08 | No login + Cognos shows sign-in (mismatch) | **Hold**; still recommend Absent NS/NC from CMS; staff Include |
| H09 | No login on ANNUAL/OFF | no Absent |
| H10 | Login ≥60 on leave day | Absent anomaly |
| H11 | DUTY-2 + 60m gap, one CMS span (Said ElDib) | whole-day evaluation |
| H12 | DUTY-2 cancelled by identical-window RLS | Rule 8, not second absence |
| H13 | Overlapping RLS + NURSNG | subtract once from net |
| H14 | Night close punch next calendar date (CMS cols 5–6) | present, not Rule 5 |
| H15 | CMS truncated / insufficient coverage | forced hold; **do not** invent Absent |
| H16 | Blank LOGIN ID | forced hold; no Absent |
| H17 | Flex tag on 14:00–22:00 | standard bands + `FLEX_SCHEDULE_OUTSIDE_WINDOW`; no 10:00 cutoff |
| H18 | Unattended COVER + same-day late | severity merge; `coverExtendsAttendanceWindow=false` |
| H19 | Duplicate SHIFT rows | hours once |
| H20 | Seconds on schedule timestamps | cannot shave a late minute |

**Do not silently change:** split SHIFT 09–12 and 16–19 with first/last punches around the day still uses **whole-day** attendance (PRD §4.9). Restate in comments/tests; per-block needs an explicit business reopen.

---

## Implementation steps (ordered — priority reflects D2-first, confirmed the only pay-path defect)

1. **[DONE 2026-09-09] Absent wins cleanup** — after all rules fire (standard + flex), if final category is `MARKED_ABSENT` / action is ABSENT / Absent NS/NC, remove LATE, Log_off, COVER from `rowCorrections` before assigning `generatedCorrections`. Keep OT→SHIFT. Also releases the stripped COVER's `placedCoversThisRun` reservation (`coverReservationByRow` WeakMap) so a different row's later cover placement isn't silently delayed.
2. **[DONE 2026-09-09] Golden tests** for the D2 fix: H02, H03 (mirror-image severity conflicts), a reservation-integrity case, E25 (confirms the strip doesn't regress OT→SHIFT). `npm run test` green (111/111 regression, 145/145 trust matrix).
3. *(not yet done — should-fix-for-review, not payroll-urgent)* **Atomic LATE/Log_off + COVER** in `reconciliationEngine.ts` at the 4 real sites — both rows or neither; new hold reason if needed for incomplete pair; never orphan LATE on screen. Do not touch `buildCoverNotAttendedOutcomes`'s `moveCoverForward` branch — it already orphans nothing.
4. *(not yet done)* **Recommendation completeness flag** on each row for UI gating of Include.
5. *(not yet done)* **ResultsView** — recommended checklist; Held vs Included distinction (D4); disable Include when incomplete.
6. *(not yet done)* **Golden tests** for H01, H06, H08, plus incomplete-pair-holds-with-neither-row, then the rest of the catalog.
7. **Docs finish-line** (only after all code above is done, or now to close out D2 alone): update `doc/PRD.md`, `doc/TAA_KNOWLEDGE_BASE.md`, `doc/CLAUDE.md`; rebuild `TAA_Workspace.html` per CLAUDE.md; open standalone HTML in a browser and confirm it renders.

---

## What you must not do

- Do not implement `doc/Rules.txt`
- Do not date-key CMS joins
- Do not emit STRLAT / LFTERL (use `LATE` / `Log_off`)
- Do not auto-send email (drafts / `.eml` only)
- Do not skip OT2 public-holiday days
- Do not subtract COVER twice from REMARK net figures
- Do not use Cognos `SECTION` for role tier
- Do not auto-Include on `MISMATCH_FOUND`
- Do not invent Absent on blank LOGIN ID or insufficient CMS coverage
- Do not leave LATE/Log_off in corrections when Absent is the winning action

---

## Done criteria

- [x] **D2 (must-fix-for-pay):** No path can put LATE/Log_off/COVER beside ABSENT / Absent NS/NC for the same employee-day. Fixed 2026-09-09 — post-verdict strip in `reconciliationEngine.ts`, with reservation release (`coverReservationByRow`) so a stripped COVER doesn't delay the next cover placed for the same employee/target-day. Golden tests H02, H03, E25, and a reservation-integrity case added to `regressionSuite.ts`; `npm run test` green (111/111 regression, 145/145 trust matrix).
- [ ] **D1 (should-fix-for-review, not payroll-urgent):** No path can put LATE or Log_off into the on-screen recommendation without a matching COVER of the same duration (or the row is incomplete-blocked with **neither**). Confirmed this cannot reach the exported CSV today (forced-hold precedence + Include gating at both the view and state layers) — fixing it improves what a reviewer sees on a locked row, it does not close a payroll gap.
- [x] Held mismatch rows still carry the full recommended correction set (unaffected by the D2 fix — the strip runs regardless of hold state, exactly like every other correction-emission rule).
- [ ] **D4 (should-fix-for-review, UI counts only):** visually and in counts distinguish Held (recommended, not in CSV) from Included (in ASPECT CSV).
- [x] Rule 5 / 6 / leave gates match the table above — verified already correct, no change made.
- [x] D2's golden tests pass; full `npm run test` passes.
- [ ] D1/D4 golden tests (H01, H06, H08, atomic-pair incomplete-hold cases) — not yet added; do when D1/D4 are implemented.
- [ ] Docs + `TAA_Workspace.html` rebuilt and browser-checked per CLAUDE.md — pending, do after D1/D4 land (or now, to close out D2 alone — see `doc/CLAUDE.md`'s mandatory-after-delivery rule).

---

## Paste-ready short prompt (optional kickoff, updated for what remains)

```
D2 (Absent excludes leftover timed penalties) is implemented and tested — see
doc/CLAUDE_ACTION_INTEGRITY_PROMPT.md's D2 section for what changed. What remains is D1
(atomic LATE/Log_off + COVER pairs) and D4 (Held vs Included UI counts) — both are
should-fix-for-review, confirmed NOT payroll-urgent: D1's orphaned LATE/Log_off cannot
reach the exported CSV (forced-hold precedence blocks it at the state layer, not just
the UI), so this is about not showing reviewers a half-action on a locked row, not
closing a pay gap.

Fix reconciliationEngine.ts (atomic pairs at the 4 real call sites — Flex Branch B ~960,
standard Late Login ~1150, standard Early Logout ~1204, evaluateEarlyAndLateLogout
~2018 — do NOT touch buildCoverNotAttendedOutcomes's moveCoverForward branch, it
already orphans nothing), then ResultsView (recommended checklist + Held vs Included +
Include gated on complete). Add golden tests for H01, H06, H08, plus an
incomplete-pair-holds-with-neither-row case, then the rest of the catalog.
Read PRD §4.1–4.12, CLAUDE.md, Rules to be taken.csv first.
npm run test must stay green; then update PRD/KB/CLAUDE.md and rebuild TAA_Workspace.html.
```
