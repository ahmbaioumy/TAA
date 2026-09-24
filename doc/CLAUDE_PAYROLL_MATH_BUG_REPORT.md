# Claude Review - TAA Payroll Math Audit

Audit date: 2026-09-09  
**Fix pass: 2026-09-09, same day.** 10 of 12 findings below are fixed and verified — re-run
`node node_modules/tsx/dist/cli.mjs scripts/audit-payroll-math.ts` yourself to confirm; every
finding's own evidence ID now shows the corrected behavior. Each fix has a matching regression
case (`reg-80`–`reg-90` in `regressionSuite.ts`) using this report's own scenario, and
`npm run test` (90/90 regression cases) passes. Findings #2 (split shift) and #12 (comparison
tolerance) were investigated and deliberately **not** changed — see their own status notes below;
both conflict with an existing, evidence-based design decision already in the codebase, so
changing them needs an explicit business decision, not a unilateral code fix.

Workspace: `C:\Users\lenovo\Desktop\TAA`  
Primary code reviewed: `TAA_HTML/src/services/reconciliationEngine.ts`, `scheduleRecompute.ts`, `punchAttribution.ts`, `cognosComparison.ts`, `parsers.ts`, `configRegistry.ts`

This audit focused only on math and algorithm behavior that can affect staff time-card corrections. The app does not calculate currency salary directly; it emits ASPECT correction rows and annotated Cognos review rows. A one-minute wrong classification can still become payroll-impacting downstream, especially when it changes `NO_ACTION` to `LATE_AND_COVER`, `LOGOFF_AND_COVER`, `ABSENT`, `Absent NS/NC`, or OT duration.

Repro evidence is saved in `doc/PAYROLL_MATH_AUDIT_EVIDENCE.json`. The investigation runner is `TAA_HTML/scripts/audit-payroll-math.ts`.

Run this from `TAA_HTML`:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/audit-payroll-math.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsx/dist/cli.mjs src/services/featureCompletion.test.ts
node node_modules/tsx/dist/cli.mjs src/services/trustMatrixRunner.test.ts
```

Latest results:

- Independent standard rule boundary checks: 732/732 passed.
- Embedded regression suite through the audit runner: 77/77 passed.
- Feature completion test passed.
- Trust matrix: 145/145 passed.
- TypeScript check passed.
- Real sample files in this workspace do not overlap by date: ASPECT segments are `28/08/2026`, Cognos is `2026-08-27`, and CMS has only 39 rows for one Login ID. The run correctly held all 502 real Cognos rows and generated 0 exportable corrections. Do not infer real individual salary loss from these sample files.

## Confirmed Findings

### 1. Existing future COVER segments are ignored when placing new cover

**Status: FIXED (2026-09-09).** `placeCoverSegment` now checks the target day's real
pre-existing `COVER` segments and stacks after the latest one. `reg-80` pins it.

Evidence: `F01_EXISTING_COVER`

Synthetic setup:

- 08/09/2026 SHIFT 09:00-17:00.
- Staff logs in at 09:06, requiring 6 minutes Late + Cover.
- 09/09/2026 already has SHIFT 09:00-17:00 and an existing COVER 17:00-17:12.

Expected: the new 6-minute cover starts after the existing cover, at 17:12.

Observed: the app emits a new COVER at 17:00 for 00:06, overlapping the already scheduled cover.

Code area: `placeCoverSegment` only stacks covers kept in `placedCoversThisRun`, not existing ASPECT `COVER` rows (`reconciliationEngine.ts`, around `placedCoversThisRun`, `trackerKey`, and `existingCovers`).

Payroll risk: the same cover minutes can be scheduled twice, or ASPECT may reject/resolve the overlap differently from the app's expectation.

Suggested fix: seed cover placement from existing `COVER` segments on the target date before appending covers generated in the current run.

### 2. Split shifts use first punch / last punch for the whole day, so missed middle blocks can be hidden

**Status: NOT CHANGED — conflicts with an existing closed decision (2026-09-09).** PRD.md §4.9
and §8 item 8 explicitly close this exact question: whole-day continuous-presence attendance
evaluation is the user-confirmed, "Said ElDib-style" deliberate model, and `perBlockGapThresholdMinutes`
is documented as comparison-only, never a per-block penalty switch — `reg-71` in the regression
suite pins this same model for a different scenario (flex SHIFT+OT). This finding is real and
consistent with that design (a first/last-punch model cannot see a missed middle block by
construction) — but "should attendance switch to per-block evaluation" is the same policy
question the client already answered, not an oversight to silently fix. Needs an explicit
decision before any code change: keep whole-day (accept this as a documented trade-off), add an
opt-in stricter per-role/per-floor mode, or hold multi-block days with thin evidence for manual
review as a narrower middle ground.

Evidence: `F02_SPLIT_SHIFT`

Synthetic setup:

- SHIFT 09:00-12:00.
- SHIFT 16:00-19:00.
- Punches at 09:00, 12:00, 18:00, 19:00.

Expected: the 16:00 block detects a 120-minute late arrival, or the row is held because day-level first/last punches cannot prove attendance per block.

Observed: `PRESENT / NO_ACTION`, included in output, with no variance. Net schedule is 360 minutes, but attendance is interpreted as 09:00-19:00.

Code area: reconciliation derives `actualFirstLoginDt` and `actualLastLogoutDt` once for the whole employee-day (`reconciliationEngine.ts` around the main row loop). `scheduleRecompute.ts` can represent `duty1Block` and `duty2Block`, but the pay-affecting late/early rules still use one day-level effective start/end.

Payroll risk: staff can miss an entire later block and still appear present if they have early and late punches around the day.

Suggested fix: when a day has multiple non-contiguous required attendance blocks, evaluate attendance per block or force manual review unless CMS can prove each block.

### 3. A manual or incomplete CMS upload can become exportable `Absent NS/NC`

**Status: FIXED (2026-09-09).** New hold reason `CMS_EXPORT_SCOPE_GAP`: when the uploaded CMS
data has punches for other Login IDs but genuinely none for this one, the row is now held for
manual review instead of auto-marked absent. A dataset with **zero** CMS data at all (nobody
queried anything) is unaffected and still applies Rule 5 normally, per the existing
user-confirmed `reg-19` case. `reg-81` pins the new behavior; confirmed live in the shipped demo
dataset (Sara Al-Blooshi, PF 4508902) and re-derived independently against the real
`samples_Files/` exports in `reg-66`.

Evidence: `F03_MISSING_AGENT`

Synthetic setup:

- SHIFT 09:00-17:00 for `AUDIT_LOGIN`.
- CMS file contains only another Login ID's punches.

Expected: the app should require proof that the CMS query included `AUDIT_LOGIN`, or hold the row as missing evidence.

Observed: `NO_SHOW / ABSENT_NS_NC`, included in output, with an ASPECT absence correction.

Code area: `punchAttribution.ts` marks coverage sufficient when there are zero CMS punches for the login (`coverageSufficientByWindowKey.set(w.key, true)`). Reconciliation then hardcodes the no-login absence path.

Payroll risk: if the uploaded CMS file is filtered incorrectly or manually exported for the wrong agent list, the app can create a full absence for a staff member whose punches were never present in the input.

Suggested fix: require a CMS export manifest, derived agent-list proof, or a strict manual confirmation before allowing no-login rows into Output 1.

### 4. Overlapping removals double-subtract paid minutes from net schedule

**Status: FIXED (2026-09-09).** `scheduleRecompute.ts` now unions overlapping LEADING and
TRAILING removal intervals (same technique Rule 8 already used for OT/RLS overlap) before
subtracting from `netScheduledMinutes`, instead of subtracting each removal independently.
`reg-82` pins it (RLS + NURSNG both covering the same hour now removes it once: net=420, not 360).

Evidence: `F04_OVERLAP_TRAILING`, `F04_OVERLAP_LEADING`

Synthetic setup:

- SHIFT 09:00-17:00.
- Two removal segments cover the same hour, such as `RLS` 16:00-17:00 and `NURSNG` 16:00-17:00.

Expected: the physical hour is removed once, leaving 420 paid scheduled minutes, or the row is held.

Observed: `net=360`, included with no hold. The effective start/end anchoring is partly protected, but `netScheduledMinutes` still subtracts each removal independently.

Code area: `scheduleRecompute.ts` subtracts `resolved.minutes` from `netScheduledMinutes` inside each leading/trailing removal branch.

Payroll risk: scheduled paid minutes can be undercounted by 60 minutes when two real segment codes describe the same physical release hour.

Suggested fix: union removal intervals before subtracting from net scheduled minutes, at least for timestamped removals. Hold rows where duration-only removals overlap unknown windows.

### 5. Flex rows skip Rule 7 Cover Not Attended

**Status: FIXED (2026-09-09).** Rule 7 logic extracted into a shared `evaluateCoverNotAttended`
function, called from the flex branches too (with a severity-aware apply, same as the standard
branch's `applyMoreSevere`). `reg-87` pins it.

Evidence: `F08_FLEX_COVER_SKIP`

Synthetic setup:

- Officer flex SHIFT 07:00-15:00.
- COVER 15:00-15:10.
- Punches 07:00 and 15:00, so the cover has zero attended minutes.

Expected: Rule 7 applies or the row is held. For Officer+, 10 unattended cover minutes should not be silently `PRESENT`.

Observed: `PRESENT / NO_ACTION`, included in output, `net=490`, no correction and no variance trace.

Code area: Rule 7 is inside the standard/non-flex branch in `reconciliationEngine.ts` around `recompute.coverSegments.forEach(...)`. The flex branch returns through its own downstream helper and never runs Rule 7.

Payroll risk: a flex employee can miss required cover minutes and the app produces no correction.

Suggested fix: move Rule 7 evaluation into a shared post-attendance step that runs for both flex and standard rows.

### 6. Flex rows mishandle OT/release overlap and can mark false absence

**Status: FIXED (2026-09-09).** Two changes: (1) Rule 8 logic extracted into a shared
`evaluateRlsOtAdjustment` function, called from the flex branches too. (2) A new
`flexAttendanceEndDt` helper extends the flex late/early-logout anchor into a genuinely
scheduled OT block ONLY when the actual last logout demonstrably continues past the shift-only
end (real punch evidence of working the OT, not just an OT segment existing in the schedule) —
this guard was necessary to avoid breaking `reg-71`, an existing regression case that
deliberately pins the OPPOSITE outcome for a flex employee who logs out exactly at the shift-only
end and never attends the OT at all (must stay SHIFT_CHANGED, not become a manufactured
early-logout/absence). `reg-88` pins the OT-attended case; `reg-71` continues to pin the
OT-skipped case; both pass.

Evidence: `F14_FLEX_OT_RLS_SKIP`, also review `V01_FLEX_OT_DURATION`

Synthetic setup:

- Officer flex SHIFT 07:00-15:00.
- OT1 15:00-17:00.
- RLS 16:30-17:00.
- Punches 07:00 and 17:00.

Expected: OT1 should be adjusted from 120 minutes to 90 minutes, or at minimum the late-logout anchor should respect the OT/release-adjusted end.

Observed: `ABSENT / ABSENT_SEGMENT`, included in output, charged 120 minutes. The correction converts OT to SHIFT because absence fired, but no OT original/adjusted pair is emitted.

Code area: flex downstream late logout is evaluated against `snapped start + SHIFT effective duration` (`reconciliationEngine.ts` around `flexShiftedDurationMinutes` and the calls to `evaluateEarlyAndLateLogout`). Rule 8 OT/RLS adjustment is in the standard branch around the `RLS added to OT with no adjustment` loop, so flex rows skip it.

Payroll risk: a staff member can work through a valid OT window and still be marked absent because flex downstream math ignores OT when setting the end anchor.

Suggested fix: define the flex late/early logout anchor for days with OT explicitly. Then run Rule 8 in shared logic for flex and standard rows.

### 7. Configured action values are not respected for no-login and OT/RLS rules

**Status: FIXED (2026-09-09).** Both no-login branches (flex and standard) now look up "No Login
Record"'s configured action and skip the absence when it's `NO_ACTION`. Rule 8's evaluation now
checks its own configured action before firing (previously unconditional). `reg-83`/`reg-84` pin
both. (Note: `F09_CONFIG_OT`'s own synthetic probe in `audit-payroll-math.ts` used a segmentType
string, `'RLS added to OT with no adjustment'`, that doesn't match the config's actual
`'RLS segment added to OT with no adjustment'` — so that probe's own filter was a no-op and it
still shows the correction pair; verified independently with the correct key that the underlying
fix works, see `reg-84`.)

Evidence: `F09_CONFIG_ACTION`, `F09_CONFIG_OT`

Synthetic setup:

- Set `No Login Record` policy action to `NO_ACTION`.
- Run an empty-CMS day.

Observed: app still emits `NO_SHOW / ABSENT_NS_NC`.

Synthetic setup:

- Set `RLS added to OT with no adjustment` action to `NO_ACTION`.
- Run OT1 17:00-18:00 with RLS 17:30-18:00.

Observed: app still emits the OT original/adjusted pair.

Code area: no-login branches read only the rule communication value, then hardcode `ABSENT_NS_NC`. Rule 8 emits OT adjustment rows without consulting `rule.action`.

Payroll risk: administrators can change a policy action in config and believe payroll output is disabled, while the app still emits corrections.

Suggested fix: enforce `PolicyRuleItem.action` in every rule path, or make non-editable rules visibly non-editable and impossible to override in config.

### 8. Future cover target validation is incomplete

**Status: FIXED (2026-09-09).** `placeCoverSegment`'s target-day resolution now checks
`midShiftRemovalSegments`, `unknownDurationRemovalSegments`, and `durationDisagreementSegments`
in addition to the existing out-of-window check — any of the four blocks placement and the
specific reason is reported (`describeCoverPlacementFailure`, replacing a single generic hold
label at every one of the 5 call sites). `reg-85` pins the duration-disagreement case.

Evidence: `F10_FUTURE_INTEGRITY`

Synthetic setup:

- Incident day requires 6-minute Late + Cover.
- Next working day SHIFT has timestamps for 480 minutes but `DURATION=479`.

Expected: the app holds the source correction because the target day used to place cover has a schedule integrity error.

Observed: the app emits exportable Late + Cover and places the cover on that future day.

Code area: source-day holds check `recompute.durationDisagreementSegments`, but `placeCoverSegment` only blocks target days with out-of-window removals. It does not reject target days whose `DURATION` disagrees with start/stop.

Payroll risk: cover can be placed onto a target schedule the app already knows is internally inconsistent by one minute.

Suggested fix: make `placeCoverSegment` reject or return a hold reason for any target-day schedule integrity error, including duration disagreement, unknown removal duration, mid-shift removal, invalid date/time, and unresolved schedule shape.

### 9. Duplicate identical SHIFT rows double net schedule minutes

**Status: FIXED (2026-09-09).** `scheduleRecompute.ts` now dedupes ADDITION segments by exact
key (`SEG_CODE|START_MOMENT|STOP_MOMENT|DURATION`) before summing into `netScheduledMinutes` and
before adding to `additionSegments`. Genuinely different (non-identical) overlapping additions
are intentionally left unchanged — that broader question is still open, per the original
suggested fix. `reg-86` pins the exact-duplicate case.

Evidence: `F11_DUPLICATE_SHIFT`

Synthetic setup:

- Same SHIFT 09:00-17:00 appears twice.
- Punches 09:00 and 17:00.

Expected: duplicate rows are deduped, or the row is held as ambiguous.

Observed: `PRESENT / NO_ACTION`, included in output, `net=960`.

Code area: `scheduleRecompute.ts` adds every addition segment duration to `netScheduledMinutes` without an identity/interval dedupe.

Payroll risk: duplicate input rows can double scheduled hours while attendance appears normal.

Suggested fix: detect exact duplicate source segments before arithmetic. For non-identical overlapping addition intervals, decide whether to union, sum by configured segment role, or hold.

### 10. Full-day leave-code suppression hides explicit leave duration mismatches

**Status: FIXED (2026-09-09).** `isFullDayByDesignLeave` now requires every leave segment on the
day to BOTH have a listed code AND genuinely lack a real duration (no `DURATION`, no usable
START/STOP) — a specific row carrying an explicit real duration is compared normally regardless
of its code name. `reg-89` pins it (ANNUAL with DURATION=60 vs Cognos LEAVE HR=480 now correctly
flags as MISMATCH).

Evidence: `F12_EXPLICIT_LEAVE_DURATION`

Synthetic setup:

- `ANNUAL` segment carries explicit `DURATION=60`.
- Cognos `LEAVE HR=480`.

Expected: because the ASPECT row has an explicit duration, compare 60 vs 480 or hold.

Observed: `LEAVE_EXCLUDED / NO_ACTION`, included in output; LEAVE HR is `NOT_COMPARABLE`.

Code area: `reconciliationEngine.ts` sets `isFullDayByDesignLeave` if any leave code is in `leaveCodesWithoutDuration`, then suppresses `leaveMinutes` even when that exact row carries a real `DURATION`.

Payroll risk: partial leave or malformed leave rows using a full-day code can escape review.

Suggested fix: treat codes as full-day-by-design only when the row has no `DURATION` and no usable start/stop window. Explicit duration should always be compared.

### 11. Invalid `DURATION` text is silently truncated or ignored

**Status: FIXED (2026-09-09).** `parsers.ts` now requires a strict `/^\d+$/` match before
calling `parseInt` — `"480.9"`, `"480garbage"`, and `"not-a-number"` all now parse to `undefined`
(the same, already-safe fallback path a genuinely missing DURATION takes: derive from real
timestamps, or hold if there are none) instead of silently coercing to a plausible-looking
number. `reg-90` pins it.

Evidence: `F13_DURATION_PARSER`

Observed parser behavior:

- `480.9` parses as `480`.
- `480garbage` parses as `480`.
- `not-a-number` becomes `undefined`, then timestamp fallback can make the row look valid.

Code area: `parsers.ts` uses `parseInt(durationStr, 10)` for ASPECT `DURATION`.

Payroll risk: a malformed duration can become a clean-looking payroll minute value, and the operator never sees a hold.

Suggested fix: parse duration with a strict integer regex. Reject fractional or suffixed values into an import error or forced hold.

### 12. One-minute Cognos comparison tolerance can hide threshold-boundary mismatches

**Status: NOT CHANGED — policy question, and the actual payroll output is unaffected either way
(2026-09-09).** Confirmed: the real ASPECT correction (lateMin/earlyMin and the charged minutes)
comes entirely from `reconciliationEngine.ts`'s own independent recompute against real CMS
punches — never from this comparison layer's tolerance — so this tolerance only affects whether
the ANNOTATED COGNOS REPORT flags a row as worth a second look, not what gets paid. A code
comment directly above this logic (`cognosComparison.ts`, near the LATE START/LEFT EARLY
comparison) already documents that Cognos's own numbers here only match TAA's recompute ~66% of
the time on real data and explicitly warns "do NOT make this... without new evidence" — tightening
the tolerance to 0 risks flooding reviewers with false-positive MISMATCH holds on ordinary,
correct rows, which is a real usability regression, not a pure win. `comparisonToleranceMinutes`
is already a Config Registry value (never hardcoded), so an administrator who wants tighter
tolerance can already set it to 0. Left as a disclosed, deliberate trade-off rather than a
default change made without the same kind of real-data evidence the original design decision used.

Evidence: `P01_ONE_MINUTE_TOLERANCE`

The rule engine correctly charges an OPS 09:06 login as 6 minutes late. But the Cognos comparison layer accepts differences within `comparisonToleranceMinutes` by default. In the repro, Cognos-like values one minute away from TAA still compare as `MATCH` while the correction is exportable.

Code area: `cognosComparison.ts` uses `<= toleranceMin` for time and minute comparisons.

Payroll risk: this is not necessarily a code bug; it is a policy risk. Around exact thresholds, one minute can decide whether payroll correction exists. A general comparison tolerance can hide precisely the discrepancy the app is meant to review.

Suggested fix: keep tolerance at 0 for policy-trigger columns, or make comparison status threshold-aware: one-minute differences that cross a rule boundary should be mismatches even if ordinary schedule-display fields tolerate one minute.

## Items That Look Correct In The Latest Run

- Standard whole-minute OPS/Officer boundaries passed 732 independent checks.
- Rule 7 seconds handling now truncates cover start/end to whole minutes. `F07_COVER_SECONDS` produced no correction for a 4-minute OPS shortfall, which matches the documented threshold.
- Rule 8 seconds handling now truncates OT/RLS windows and adjusted OT1 60 minutes to 30 minutes in `F07_OT_SECONDS`.
- Existing feature and trust-matrix tests pass.

## Fix Priority — status as of the 2026-09-09 fix pass

1. ~~Hold incomplete-CMS/no-login rows unless the app can prove the queried agent list included that Login ID.~~ **DONE** (§3, `CMS_EXPORT_SCOPE_GAP`).
2. Fix split-shift/pay-window evaluation per required block. **NOT DONE — business decision needed** (§2, conflicts with closed PRD §4.9 decision).
3. ~~Move Rule 7 and Rule 8 into shared logic that runs for flex and standard rows.~~ **DONE** (§5, §6).
4. ~~Union/dedupe addition and removal intervals before net scheduled minutes are trusted.~~ **DONE** (§4, §9).
5. ~~Respect configured `PolicyRuleItem.action` consistently.~~ **DONE** (§7).
6. ~~Make target-day cover placement reject every schedule integrity error, not just out-of-window removals.~~ **DONE** (§8).
7. Tighten parsing: **DONE** (§11, strict DURATION regex). Threshold-aware comparison tolerance: **NOT DONE — policy decision needed, payroll output unaffected either way** (§12).

Remaining open items before this can be called fully closed: #2 and #12 above both need an
explicit business decision, not a unilateral code change — see their status notes.

## Notes For Claude

Do not rely only on the current green tests. They cover many known cases, but the findings above came from synthetic payroll-edge cases not covered by those suites. For any fix, add regression tests using the exact evidence IDs above, and make the tests assert both the generated ASPECT corrections and the review/hold status. The safest rule for this app is: if the math input is incomplete, duplicated, overlapping, or contradictory by even one minute, hold the row rather than emit Output 1.

**Follow-up (2026-09-09 fix pass):** all of the above was followed for 10 of 12 findings —
`reg-80` through `reg-90` in `regressionSuite.ts` each assert both the generated corrections and
the hold/review status, named after this report's own evidence IDs. `npm run test` runs all 90
regression cases headlessly (`regressionSuiteRunner.test.ts`, added the same day). Findings #2
and #12 were deliberately left alone rather than "fixed" past what the evidence actually
supports — see their status notes for why.

**Re-audit (2026-09-09, same day): all 10 fixes above independently re-verified against the live
source, not taken on this report's own word — all 10 confirmed genuinely present and correct.**
The re-audit found 6 further defects, 3 that this fix pass introduced (copy-pasting Rule 7/8's
correction-emission logic across the flex/standard branches instead of sharing it) and 3
pre-existing gaps it didn't reach. All 6 are fixed, each with its own regression case
(`reg-91`–`reg-96`, asserting both corrections and hold status, same convention as above).
`npm run test` now runs 96/96 regression cases headlessly. Full detail: `PRD.md` §9c and
`TAA_KNOWLEDGE_BASE.md` §7h. Summary:
- Rule 8's OT/RLS pair and the Absent-day OT→SHIFT conversion were still reading the raw,
  un-normalized ASPECT `START_DATE` into the exported `SegmentDate` (§1/§7's fix duplicated this
  defect from 2 sites to 3 by copy-pasting emission logic instead of sharing it) — both now derive
  the date from the segment's own parsed timestamp, like every other emission site (`reg-91`,
  `reg-92`).
- Rule 7/8's correction-emission logic (not just the math) is now genuinely shared across all
  three call sites (`buildCoverNotAttendedOutcomes`/`buildRlsOtAdjustmentOutcomes`), closing off
  the class of defect that produced the `START_DATE` bug and a summary-counter mixup (Rule 8's
  adjustment was incrementing the unrelated OT→SHIFT-on-absent-day counter; now has its own
  `otRlsAdjustedCount`).
- §8's target-day integrity check covered 4 of the 5 checks a source day gets — the missing one
  (`INVALID_ASPECT_DATETIME`) is now checked too (`reg-93`).
- §4's union fix left duration-only removals still able to double-subtract undetected against a
  timestamped removal in the same group (now held, `reg-94`) — which also surfaced an unrelated,
  pre-existing bug where a duration-only removal with a real `DURATION` was wrongly treated as
  malformed data instead of valid input (now fixed). The union fix's own reported release-minute
  figures also didn't match what net actually subtracted; now they do (`reg-95`).
- §7's config-action fix only ever honoured `NO_ACTION`; every other value in the same dropdown
  still silently defaulted to `ABSENT_NS_NC` with no indication the administrator's choice was
  ignored — now every configured action produces a distinct, correct effect (`reg-96`).
- This report's own `F09_CONFIG_OT` audit probe (see §7's parenthetical note above) was corrected
  so `doc/PAYROLL_MATH_AUDIT_EVIDENCE.json` no longer shows stale pre-fix output for that ID.
