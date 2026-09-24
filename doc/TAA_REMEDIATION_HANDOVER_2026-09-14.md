# TAA Remediation Handover — 2026-09-14

No Git history exists for this project, so this document is the substitute for a diff/PR: what
was found, what changed, what was deliberately left as a decision item, and the evidence that
nothing else moved.

## Post-remediation independent audit (same day) — 4 corrections applied

The remediation above was then independently audited against the pre-change backup (a real
before/after diff, since there is no Git history) rather than against its own summary or its own
passing tests. That audit found four defects, all now fixed and covered by new regression cases in
`auditFixes.test.ts`. The decisive technique was diffing the **old engine vs the new engine over
the bundled sample dataset** — something no suite in `npm run test` does, since every suite uses
its own synthetic fixtures:

| # | Defect found | Fix applied |
|---|---|---|
| 1 | `AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS` was added to `FORCED_HOLD_REASONS` (non-overridable) AND fired on a COVER nested inside a SHIFT — the shape in the project's own sample data (employee 600043, 01/09/2026). Proven: such a day with a genuine 20-minute late arrival calculated `LATE` + `COVER` corrections and then withheld both from the export **with no reviewer tick able to release them**. | The check now skips COVER-vs-shift/OT pairs (that combination is the documented hours formula, `netScheduledMinutes = DUTY1 + OT + COVER − releases`, and Rule 7 exists to check covers against the attended span); only same-kind overlaps (COVER×COVER, or SHIFT/OT×SHIFT/OT) are flagged. The reason was also **removed from `FORCED_HOLD_REASONS`** — it is a scheduling-judgement call like `MIXED_LEAVE_AND_WORK_SEGMENTS`, and the rule has never been validated against a real production export. |
| 2 | The soft `DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS` hold sat **above** the forced `AMBIGUOUS_PUNCH_ATTRIBUTION` in the cascade (its own comment wrongly claimed it sat below every forced hold). Proven: identical inputs produced the forced hold normally, but the releasable one when a malformed DURATION co-occurred — defeating the lock. | Moved below every forced hold (now immediately before the generic `MISMATCH_FOUND`), comment corrected to state the constraint and why. |
| 3 | A policy-band overlap locked the whole run but reported `INVALID_CONFIG_TIME` — *"A Config Registry clock value is invalid… fix it to a valid HH:MM"* — sending the user to hunt a field that was never wrong. Caused by `buildInvalidConfigOutput` mapping only `kind === 'value'`, so the new `'band'` kind fell through to the clock message. | Mapping inverted: only an all-`'time'` issue set reports `INVALID_CONFIG_TIME`; everything else reports `INVALID_CONFIG_VALUE`. The specific band message already reached the row trace via `ruleFired` and still does. |
| 4 | The proximity clip fixed the pay figure but left the reported `nursingMinutes` unclipped, breaking the KB-documented `raw − release − nursing − otInternal = net` reconciliation by the clipped amount. | The trailing accumulators now use the clipped minutes whenever the clip actually moved the boundary (and only then, so an explicit DURATION that disagrees with its own timestamps still reports exactly as before — that is its own separate `SEGMENT_STOP_DURATION_DISAGREE` hold). |

**Net behavioural change vs. the pre-remediation engine, measured on the bundled sample data:**
5 rows newly held (all `MISMATCH_FOUND`, all reviewer-releasable), `heldForReviewCount` 17 → 22,
and exactly 2 lines removed from the exported ASPECT correction CSV — employee 600018's Rule 8
OT/RLS adjustment pair, now gated behind one reviewer tick by the `TAA_COGNOS_AGREE=false` rule
the audit spec mandated. Nothing is silently lost; nothing is permanently locked.

The original handover text below under-reported this: it named only the two zero-correction rows
(Eman Eltayeb, Minas Alabbas) and did not disclose that a third row carrying two real pay
corrections was also newly gated.

## Backup

Full pre-change copy at `C:\Users\lenovo\Desktop\TAA_backup_2026-09-13\` — `TAA_HTML/` (source),
`doc/`, `samples_Files/`, root `TAA_Workspace.html`, `TAA_Launch.bat`. Verified: file count in
`TAA_HTML/src` matches the live tree exactly (42/42) at backup time.

## Audit summary

17 of the audit's 20 seeded defects were confirmed exactly as described, with file/line evidence
independently reproduced (not taken on the seed list's word). 1 was overstated (not currently
reachable — downgraded to a regression-guard test, no behavior change). 2 were confirmed but
narrower than worded (reworded to match evidence before fixing). A follow-up investigation of 6
previously-unverified edge cases found 1 new confirmed defect (overlapping additions), confirmed
2 already behave correctly, and left 2 as explicit decision items (see below) rather than
inventing a policy for zero-occurrence data. One documentation contradiction not in the original
seed list was found and fixed (VBA companion referenced as current in `TAA_KNOWLEDGE_BASE.md`
after `PRD.md` already documented its removal), plus a second one found while fixing the first
(a stale "compare-then-pick" mailbox-resolution description across 5 spots in `PRD.md`,
contradicting §4.7's own corrected text) and a third (the Scenario Guide's "cannot disagree with
a live run" claim, which was false — see Fix J below).

**Release verdict: ship.** All 18 code fixes are implemented, tested, and verified in a real
browser against the regenerated standalone build. Zero regressions across the full existing test
suite (145/145 trust matrix, 123/123 regression, 40/40 validation pack). The 2 items intentionally
not fixed are both safely fail-closed today (hold, not a silent wrong answer) and are documented
decision items requiring a business call, not an engineering gap.

## Change manifest (by file)

### `TAA_HTML/src/App.tsx`
- Added `evaluateCanCalculate()` — single shared eligibility gate (filesReady + verification-ok +
  headcount-ok) used by `canCalculate`, `handleLoadSampleData`'s auto-run, and `handleSaveConfig`.
  The latter two previously each re-implemented a weaker inline copy that omitted headcount.
- Added `invalidateOutput()` (`setOutput(null)` + reset `activeTab` off `'results'` if selected),
  called from `handleApplyColumnMapping` and wired into `UploadZone`'s new `onDataChanged` prop —
  any upload, remap, or config change now immediately invalidates prior results/downloads.
- `handleImportConfigFile` now runs `validateConfigForRun` before accepting an imported config
  (previously bypassed `ConfigRegistryView`'s own Save-button validation entirely).

### `TAA_HTML/src/components/UploadZone.tsx`
- New `onDataChanged: () => void` prop, called on every successful file parse / CMS batch import.

### `TAA_HTML/src/services/configRegistry.ts`
- `ConfigValidationIssue` gained an optional `severity`/`'band'` kind.
- `validateConfigForRun` now also merges `validatePolicyBands`'s ERROR-severity issues, and flags
  any policy rule whose `action` isn't in the new `IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE` map for
  its `segmentType`.
- New `IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE` / `implementedActionsForSegmentType()` — single source
  of truth for which `TaaActionCode` values each rule type's engine code actually dispatches on.
- New default field `cognosAgreeOverrideExceptions: []`.

### `TAA_HTML/src/components/ConfigRegistryView.tsx`
- The rule-action `<select>` now renders only `implementedActionsForSegmentType(rule.segmentType)`
  instead of every `TaaActionCode` for every row (previously 6 options always, none of them
  `MANUAL_REVIEW_REQUIRED` even for "No Login Record", which does implement it).

### `TAA_HTML/src/services/punchAttribution.ts`
- `assessHeadcountMapping`: the `sufficient` threshold comparison now uses the unrounded
  `aspectRawPercent`/`cmsRawPercent`/`lowestRawPercent`; the rounded values are kept for display
  only.

### `TAA_HTML/src/services/scheduleRecompute.ts`
- `netScheduledMinutes` clamped to `Math.max(0, …)`; new `negativeNetScheduleMinutes` flag.
- `ot1Minutes`/`ot2Minutes` now sum the already-deduped `additionSegments`, not the raw
  `ot1Segments`/`ot2Segments` arrays.
- Addition dedup key now uses `normalizedMomentKey()` (parsed instant) instead of the raw
  START_MOMENT/STOP_MOMENT strings.
- Proximity-tolerance-classified LEADING/TRAILING removals now clip their pushed interval to
  `rawStart`/`rawEnd` instead of the removal's own (possibly overrunning) timestamps.
- `ambiguousOverlappingRemovalSegments` now also fires for 2+ duration-only removals in the same
  group with no timestamped removal present at all (previously only duration-only-beside-
  timestamped).
- New `ambiguousOverlappingAdditionSegments` — flags genuinely overlapping (non-identical)
  ADDITION segments.
- New `malformedDurationRepairedSegments` — flags a segment whose `DURATION_TEXT_MALFORMED` flag
  is set and which resolved via `TIMESTAMPS`.
- `DayScheduleRecompute` interface extended with the 3 new fields above.

### `TAA_HTML/src/services/parsers.ts`
- `parseAspectSegments` now sets `DURATION_TEXT_MALFORMED` (non-blank DURATION text that failed
  the whole-number check) distinctly from a genuinely blank DURATION cell.

### `TAA_HTML/src/services/reconciliationEngine.ts`
- Hold cascade extended: `CONFLICTING_IDENTITY_RECORD`, `AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS`,
  `NEGATIVE_NET_SCHEDULE_MINUTES`, `DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS` (soft).
- Identity map construction now detects and flags disagreeing duplicate `EMP_ID` rows instead of
  silently letting the last one win (kept: the first).
- `TAA_COGNOS_AGREE` forced-false-with-no-real-mismatch (`DEFECT_1_RELEASE_IGNORED`) now holds
  (`MISMATCH_FOUND`) unless `disagreeReason` is in `config.cognosAgreeOverrideExceptions`.
- New `resolveConversionRowDuration()` helper, used by `convertOtSegmentsToShift` and
  `convertShiftSegmentsToOt2` — derives `Segmentduration` from timestamps when DURATION is null,
  instead of leaving it blank.
- Late Login / Early Logout branches now hold (`INVALID_CONFIG_VALUE`) on an action their code
  doesn't implement, instead of silently charging variance with zero correction output.
- `resolveNoLoginDecision`/`NoLoginDecision`, `flexLateBandFires`, `isFlexScheduleWithinExpectedWindow`
  exported (the first two were previously private/inline) for the Scenario Guide to share.
- The Branch-B flex `bandFires` inline expression replaced with a call to the new
  `flexLateBandFires()`.

### `TAA_HTML/src/services/scenarioGuide.ts`
- The no-punch (`input.punchCount === 0`) branch now calls the shared `resolveNoLoginDecision`
  instead of its own hardcoded ABSENT_NS_NC-only reimplementation.
- Added the schedule-window gate (`isFlexScheduleWithinExpectedWindow`) before entering the
  flex-cutoff branch — a simulated flex employee whose schedule falls outside the window now
  falls through to the standard path, matching a real run, instead of always applying flex math.
- The flex late-arrival branch now computes (and surfaces in the trace) `flexLateBandFires`,
  matching the real engine's Branch B exactly (verdict/action still always report Late — bandFires
  only gates whether the LATE+cover correction ROWS are written, not the reported verdict).

### `TAA_HTML/src/components/ResultsView.tsx`
- `counts` now also tracks `heldWithinCategory` per category; each of the 5 category tabs shows a
  "· N held" qualifier when applicable.
- Mismatch-count label: "column mismatch(es)" → "row(s) with a column mismatch".
- "Total Audited" / "Late & Cover" / "Marked Absent" card subtext clarified as employee-day-rows
  vs. correction-action-occurrences respectively.

### `TAA_HTML/src/components/RegressionSuiteView.tsx`
- Hardcoded "77 cases" text now reads `{results.length}` (was already stale at 123).

### `TAA_HTML/src/types/taa.ts`
- `HoldReasonCode` +4: `NEGATIVE_NET_SCHEDULE_MINUTES`, `AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS`,
  `CONFLICTING_IDENTITY_RECORD`, `DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS`.
- `AspectSegment.DURATION_TEXT_MALFORMED?: boolean` added.
- `ConfigRegistry.cognosAgreeOverrideExceptions: string[]` added.

### `TAA_HTML/src/services/holdReasons.ts`
- `FORCED_HOLD_REASONS` +3 (`NEGATIVE_NET_SCHEDULE_MINUTES`, `AMBIGUOUS_OVERLAPPING_ADDITION_
  SEGMENTS`, `CONFLICTING_IDENTITY_RECORD`) — `DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS` is
  deliberately NOT forced (soft/reviewer-releasable).

### `TAA_HTML/src/services/configExportImport.test.ts`
- `ALL_CONFIG_KEYS` exhaustiveness map updated with `cognosAgreeOverrideExceptions` (TypeScript's
  own compile-time guard caught the omission).

### New: `TAA_HTML/src/services/auditFixes.test.ts`
- Regression coverage for every fix above (see Test Evidence). Wired into `package.json` as
  `test:audit-fixes`, part of `npm run test`.

### Documentation
- `doc/PRD.md`: corrected 5 stale "compare-then-pick" mailbox-resolution references (§4.7 itself
  was already correct; only its cross-references elsewhere had drifted) — including one
  "RESOLVED" decision-log entry (item 9) that stated the exact opposite of the shipped behavior;
  corrected the partial-leave "defined in dictionary" claim; corrected the Scenario Guide
  "cannot disagree with a live run" overclaim.
- `doc/TAA_KNOWLEDGE_BASE.md`: added a historical/superseded banner over the §6a VBA/CMS-
  automation architecture bullets (entirely removed by §7g, never marked superseded); corrected
  the §7e VBA-companion "source of truth" caveat to note both files were deleted the next day;
  corrected the intro's "VBA/Outlook companion" email description; added new §7m documenting this
  entire pass.
- `doc/CLAUDE.md`: added a Non-negotiables entry for the new shared-gate/hold invariants.

## Decision register (client/vendor sign-off needed — not fixed blind)

| # | Item | Current (safe) behavior | What needs a decision |
|---|---|---|---|
| 1 | Partial leave codes (`ANNL-5/6/7`, `Sick-4/9`, "Public Holiday 4/9") | Unclassified in the segment glossary → falls to `UNCLASSIFIED_SEGMENT_CODE`, held, never guessed | Zero real occurrences in any sample data — classifying them needs a real example to validate against, or an explicit business rule for their hours-effect |
| 2 | Split-shift / genuinely-gapped shifts | `perBlockGapThresholdMinutes` is comparison-only; unresolved shapes are flagged (`scheduleShapeUnresolved`), never guessed; matches the project's own prior "challengeable but not to be changed without new evidence" stance | No real genuinely-gapped-shift sample exists yet to validate a per-block penalty model against |
| 3 | Public-holiday miscoding, residual gap | `PUBLIC_HOLIDAY_SHIFT_MISCODED` correctly covers its narrow case (P/H-LV day scheduled as plain SHIFT); cannot detect real-holiday OT2 with no leave segment at all, or a holiday miscoded under an unrelated leave code | Needs an external public-holiday calendar input — the tool has no source for "which calendar dates are holidays" today |
| 4 | Rule-action dropdown scope | Restricted to what the engine implements (the safe, reversible default) | Confirm with the client whether any of the now-excluded combinations (e.g. `ADJUST_OT_RLS` for Late Login) are actually needed — if so, that's new engine logic, not a dropdown change |

## Test evidence (commands run 2026-09-14, `TAA_HTML/`)

```
npm run lint               → tsc --noEmit, 0 errors
npm run test:features      → Feature completion tests passed.
npm run test:trust-matrix  → Trust Matrix: 145/145 passed (145 cases defined)
npm run test:regression-suite → Regression Suite: 123/123 passed (123 cases defined)
npm run test:xlsx-writer   → xlsxWriter tests passed.
npm run test:schedule-blocks → Schedule-recompute block tests passed.
npm run test:config-export → Config export/import round-trip tests passed.
npm run test:validation40  → 40/40 passed, 0 failed.
npm run test:audit-fixes   → Audit remediation regression tests passed. (NEW — 18 assertions
                              across every confirmed fix)
npm run build               → vite build succeeded (dist/ regenerated)
node assemble-standalone.cjs → TAA_Workspace.html regenerated (953,957 bytes)
```

**Real-browser smoke test** (served `TAA_Workspace.html` via local static server, not the dev
build): app loads with zero console errors; "Load Sample Data" auto-calculates end-to-end;
Results view renders the new summary-card labels and per-category "· N held" qualifiers
correctly; two real `DEFECT_1_RELEASE_IGNORED` sample rows (Eman Eltayeb, Minas Alabbas) are now
visibly held (`Held: MISMATCH_FOUND`) where they previously auto-included; Config Registry's
Late Login/Early Logout/No Login Record dropdowns render exactly the restricted, correct option
sets (confirmed `MANUAL_REVIEW_REQUIRED` is now selectable for No Login Record); Scenario Guide
tab loads and simulates without error; both CSV export buttons produce no console errors.

## What did not change

`TAA_Workspace.html` was never hand-edited — only regenerated from the rebuilt `TAA_HTML/src` via
the documented `npm run build` + `node assemble-standalone.cjs` pipeline. No new runtime
dependency was added (`package.json`'s `dependencies` list is unchanged). No automatic email
sending was added or enabled. No populated Cognos source value is ever overwritten (unaffected by
this pass). The 6 previously-unverified edge cases outside this pass's scope (`P/H-LV`+`OT2`,
public-holiday miscoding, "10"/"11" duration, overlapping additions, partial leave, split-shift)
were all investigated as part of this pass — see the Audit Summary and Decision Register above —
none were left unexamined.
