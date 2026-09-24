# TAA — Time & Attendance Automation

Reconciles ASPECT schedules against CMS actual login/logout, using the Cognos discrepancy
report as the report to compare against — never to trust blindly and never to modify.
Outputs an ASPECT correction file and draft (never auto-sent) emails.

**This is a payroll system.** Scheduled-vs-attended hours drive pay. Every bug below is a
pay error, not an administrative one.

## Mandatory after every full delivery (this project only)
Once an approved plan, task package, or agent's assigned work is **fully complete** — not
after each individual edit or step within it:
1. Update `PRD.md` so it still accurately describes current requirements/behavior.
2. Update `TAA_KNOWLEDGE_BASE.md` with any newly verified facts, defects, or corrections.
3. Update this `CLAUDE.md` (Non-negotiables/Conventions/etc.) if the change affects what it
   documents.
4. Rebuild the standalone file so it never drifts from `TAA_HTML/src`:
   ```
   cd TAA_HTML && npm run build
   ```
   then re-run the inlining step (documented in the comment at the top of
   `TAA_Workspace.html`) to regenerate `TAA_Workspace.html` from the fresh `dist/` output.
5. **Open the regenerated `TAA_Workspace.html` in a real browser and confirm it actually
   renders** before reporting the rebuild done. A successful `vite build`/assemble script
   run is not proof the standalone file works — see `TAA_KNOWLEDGE_BASE.md` §7 for a case
   where a naive text-splice in the assemble script silently produced an unclosed HTML
   comment that swallowed the entire document, and only opening the file surfaced it.

This fires once per completed delivery — the finish line for a plan, package, or agent's
task — not per intermediate action inside it. Don't run it after every small edit while
still mid-task; do run it before reporting that delivery done.

## Mandatory: read before doing anything else
Every agent/session working in this repo must ground itself in these 3 files first — do not
rely on exploring the codebase or guessing instead:
1. `PRD.md` — what to build (requirements, column dictionaries, join-key architecture, output specs)
2. `TAA_KNOWLEDGE_BASE.md` — durable, independently verified reference facts
3. `c-users-lenovo-desktop-taa-aspect-csv-f-fuzzy-turtle.md` — why (research trail, proofs, defect history)

These take priority over inferring behavior from code/data exploration alone.

## Where the detail lives
The 3 mandatory files above, in more detail:
- `PRD.md` — the product requirements: full column dictionaries, join-key architecture,
  output specs, architecture. Read this first for "what to build."
- `TAA_KNOWLEDGE_BASE.md` — consolidated durable reference; independently verified accurate.
- `c-users-lenovo-desktop-taa-aspect-csv-f-fuzzy-turtle.md` (research plan, mirrored to
  `~/.claude/plans/`) — the validated research trail: proofs, worked examples, defect
  discovery, regression cases. Read this for "why."
- 5 skills, project-scoped at `.claude/skills/<name>/SKILL.md` inside this folder:
  `aspect-workforce-management`, `taa-time-attendance`, `standalone-html-tool-building`,
  `segment-code-classification`, `outlook-vba-email-companion`.

## RESOLVED — Outlook mailbox resolution logic (user-confirmed; superseded 2026-09-09)
**Not a compare-then-pick model** — an earlier draft of this note (and of `PRD.md` §4.7)
described comparing `local(EMP_EXTRA_2)` vs `local(EMP_EMAIL_ADR)` and tiebreaking to
`EMP_EXTRA_2` on a mismatch. That was found to be a latent correctness bug: it implied
`EMP_EMAIL_ADR` could still be used as a fallback source even on rows where it and
`EMP_EXTRA_2` disagree, which is exactly the case where `EMP_EMAIL_ADR`'s local part is
unrelated to the real employee (a personal-domain address like `al_wafa@hotmail.com`). The
shipped logic (`emailDrafts.ts`'s `resolveEmailRecipient`,
`reconciliationEngine.ts`'s `resolveOutlookRecipient`) is a strict **priority chain**, not a
comparison, in this order:
1. `local(EMP_EXTRA_2)` (the corporate username) — if non-empty, **always wins**, full stop.
   `EMP_EMAIL_ADR` is never even consulted while a username exists.
2. No username, but `EMP_EMAIL_ADR` sits on a corporate domain (`emailCorporateDomains`) →
   use it as-is.
3. Neither → fall through to name-based resolution (`EMP_LAST_NAME` / Cognos `NAME`), which
   forces a human to confirm the recipient in Outlook's Check Names.

Verified basis: once stripped, the two fields agree on 98.6% of rows where both are
populated (959/973) — the domain was never carrying real information for resolution
purposes. The 1.4% mismatches are personal-domain rows; the priority chain above routes
these correctly to `EMP_EXTRA_2` without ever letting the personal-domain local part be
tried. See `PRD.md` §4.7 for the full resolution chain including name fallback and
manager-CC lookup.

## Non-negotiables
- **Any input, mapping, or configuration mutation immediately invalidates prior results and
  downloads** (`App.tsx`'s `invalidateOutput()`), and every automatic-calculation path (manual
  Calculate, config Save, sample-data auto-run) shares one eligibility gate
  (`evaluateCanCalculate()`) — never a per-path re-implementation that can silently omit a check
  (past defect: Save and the sample auto-run each skipped the headcount check entirely). A
  policy-rule's configured action must be one `IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE`
  (`configRegistry.ts`) says the engine actually dispatches on for its segment type — enforced in
  the Config Registry dropdown, `validateConfigForRun` (ERROR, blocks Save/import/a run), and as
  a last-resort engine-level hold. `netScheduledMinutes` is clamped to 0 and held
  (`NEGATIVE_NET_SCHEDULE_MINUTES`) rather than ever reported negative. `TAA_COGNOS_AGREE=false`
  is held unless the row's `disagreeReason` is explicitly listed in
  `config.cognosAgreeOverrideExceptions` (empty by default). A duplicate `EMP_ID` in the Identity
  Master with disagreeing details holds every row for that employee rather than silently keeping
  whichever record came last. See `TAA_KNOWLEDGE_BASE.md` §7m for the full 2026-09-14 audit pass
  these came from.
- Never modify the Cognos report; annotate a clearly-labelled, byte-identical-original copy.
  **Narrowed exception (user-directed, implemented):** a column Cognos structurally leaves
  blank by design (`OT1`/`OT-2` — 0/502 populated in every observed export) may be
  **fill-if-blank**: written only when the source cell is empty, never when it already holds a
  value. Config `cognosBlankFillColumns` (default `['OT1','OT-2']`). Every filled cell is
  listed in the annotated export's `TAA_FILLED_COLUMNS` column so a reviewer can always tell
  Cognos's own output from what TAA supplied. The rule stays "never overwrite a populated
  Cognos value" — only "never touch Cognos at all" was relaxed.
- **The engine is recompute-then-compare with an explicit per-column verdict** (implemented,
  not just designed): `scheduleRecompute.ts` rebuilds each employee-day's schedule from ASPECT
  segments alone (Cognos `DUTY1`/`DUTY-2`/`SCH DURATION` are never inputs); `punchAttribution.ts`
  globally assigns every CMS punch to exactly one employee-day within a configurable
  `±cmsPunchSearchWindowHours` radius, so a night shift's closing punch can never double as the
  next shift's opening punch; `cognosComparison.ts` produces a MATCH/MISMATCH/COGNOS_BLANK/
  NOT_COMPARABLE verdict for 12 Cognos columns (schedule, calculated, and leave columns). A row
  with any MISMATCH, an unclassified segment code, insufficient CMS coverage, or an unparseable
  date is held out of the ASPECT correction CSV (`includeInOutput = false`). **The releasable vs.
  forced split is defined once, in `src/services/holdReasons.ts`'s `FORCED_HOLD_REASONS` — do not
  restate it as a fixed list here or anywhere else; it has already grown twice.** The principle:
  a hold where the engine already built a complete, self-consistent correction and only needs a
  human business judgement is reviewer-overridable (`MISMATCH_FOUND` and now several others); a
  hold caused by missing, ambiguous, contradictory, or invalid evidence is locked until the source
  is corrected and the run is recalculated. A releasable reason must never be written into the
  `forcedHoldReason` local seeded ahead of the row-loop's hold cascade — that would let a row
  carrying a genuinely locked condition report the releasable reason instead and become
  exportable.
- A lone or missing CMS punch is not automatic proof of absence. If the CMS export's own data
  for that Login ID does not reach `±cmsPunchSearchWindowHours` around the scheduled window, the
  row is held as `INSUFFICIENT_CMS_COVERAGE` instead of being marked Absent — distinguishes a
  real single-punch incident (Rule 6 still fires) from an export that simply doesn't reach far
  enough (see `TAA_KNOWLEDGE_BASE.md` §7 for the regression cases proving both sides).
- Join CMS by **time window**, never by calendar date — cross-midnight shifts lose their
  closing punch otherwise, producing false absences.
- **The Cognos↔ASPECT join key is normalized on both sides, never a raw string compare.**
  `parsers.ts`'s `normalizeDateKey()` (parse then re-format to `DD/MM/YYYY`) is used for both
  Cognos `SIGN IN DATE` and ASPECT `NOM_DATE` before they're compared — an un-padded ASPECT
  date (`1/9/2026`) must still join to a zero-padded Cognos date (`01/09/2026`). Real sample
  files can genuinely cover different calendar days on the two exports (verified: the shipped
  samples are one day apart) — `punchAttribution.ts`'s `assessDateOverlap()` surfaces this as a
  non-blocking advisory in the upload UI before Calculate; it never gates the run, since the
  per-row `COGNOS_DATA_GAP` hold already does the real gating.
- **The segment glossary is looked up case-insensitively** (`scheduleRecompute.ts`'s
  `lookupGlossary()`) — `parseAspectSegments` always uppercases `SEG_CODE`, so every glossary
  key is also stored uppercase (`DEFAULT_SEGMENT_GLOSSARY`); an older saved/imported config's
  mixed-case keys are normalized on load. A code that fails to match the glossary is genuinely
  unclassified, never a casing accident.
- **A flex tag alone is not enough to run the §4.8 algorithm** — it also requires the
  ASPECT-scheduled start to fall inside `config.flexExpectedSchedStartWindow` (default
  07:00-10:00), checked by `isFlexScheduleWithinExpectedWindow()`. A flex employee on a shift
  outside that window (afternoon/night) runs the standard attendance rules instead and is held
  as `FLEX_SCHEDULE_OUTSIDE_WINDOW` — the algorithm's absolute 10:00 cutoff must never be applied
  to a shift it wasn't designed for; measured against perfect attendance, the un-gated version
  fabricated a full-day Absent and a 4-hour cover.
- **Every ASPECT correction row's `SegmentDate` is the PHYSICAL calendar date the event
  actually happened on** (doc/aspect.md §2's field-4/field-5 distinction), derived from the same
  `Date` the row's `SegmentStarttime` came from via `formatSegmentDate()` — never the shift's
  nominal day. A cross-midnight early-logout or a stacked cover can land on the day AFTER the
  nominal day; hardcoding the nominal day there was silently 24 hours off.
- **`nominateDate` is the `NOM_DATE` of the schedule a correction row BELONGS TO, not the day
  the incident happened on.** Same-day actions (LATE, Log_off, ABSENT, shift-update pairs) use
  the incident schedule's own `NOM_DATE` because they never move to a different schedule. A
  placed `COVER` is the one exception: it belongs to the RESOLVED TARGET working schedule
  (`resolveCoverTargetDay()`'s `targetDateStr`), so its `nominateDate` must be the target day's
  `NOM_DATE`, never the original late/early incident's `NOM_DATE` — the incident date stays in
  `Memo` for traceability. `nominateDate` and `SegmentDate` answer different questions and can
  legitimately differ by a calendar day for an overnight target schedule; never conflate them.
- **`DUTY1`/`DUTY-2` are split by segment ROLE, not by a time gap between segments.**
  `scheduleRecompute.ts` builds `duty1Block` from every non-OT addition (SHIFT, COVER, any
  custom code) and `duty2Block` from OT1/OT2 additions alone, each internally merged within
  `perBlockGapThresholdMinutes`. Verified on every real employee-day carrying both a SHIFT and
  OT1/OT2: the OT segment always starts the instant the shift ends (0-minute gap), so a
  gap-based merge can never separate them — `duty2Block` was permanently null on every real
  overtime day.
- **A CMS Login ID with genuinely no record anywhere in the export is missing evidence, not a
  disagreement.** `cognosComparison.ts`'s time-of-day and CMS-derived minute columns (`SIGIN
  IN`/`SIGIN OUT`/`LATE START`/`LEFT EARLY`/`SIGNIN DURATION`) return `NOT_COMPARABLE`, not
  `MISMATCH`, when `ComparisonContext.hasAnyCmsData` is false — sourced from
  `punchAttribution.ts`'s own already-computed "any data for this login" signal, not
  re-derived. A login that DOES have CMS data but nothing fell inside this window's search
  radius still reports a genuine `MISMATCH`.
- **`LEAVE TYPE` selection, when a day carries several ASPECT leave codes:** prefer whichever
  code Cognos itself named (only when it's genuinely among the day's real ASPECT codes — never
  fabricates agreement), then prefer a specific reason code over a generic container
  (`config.genericLeaveContainerCodes`, default `['LEAVE']`). And when BOTH sides report an
  absence-verdict value (`config.cognosLeaveTypeVerdictValues`, e.g. Cognos `U-ABSENT` vs TAA
  `Absent NS/NC`) that is agreement (`MATCH`), not a code mismatch — different vocabularies for
  the same conclusion.
- **`SCH DURATION` is compared against `duty1Block`'s own span (falling back to `duty1Block` +
  `duty2Block` only on a standalone-OT day with no base shift at all)** — never
  `netScheduledMinutes`, which is release/nursing-adjusted and OT-inclusive; Cognos's own figure
  is neither. Real Cognos data is not perfectly self-consistent even between near-identical rows,
  so no formula reproduces every row — this is the closest reliable approximation, measured
  against real samples, not a guarantee. Does not change `TAA_SCH_HOURS_RECOMPUTED`
  (`netScheduledMinutes` — the correct pay figure — unchanged).
- **An uploaded date column where EVERY parsed date has day ≤ 12 is flagged** (advisory only,
  never blocks) — `parsers.ts`'s `detectDateFormatAmbiguity()` — since such a file is equally
  consistent with a US-style `MM/DD/YYYY` export that would otherwise parse with no error at
  all, just silently wrong (day and month transposed).
- **All payroll dates/times are strict local wall-clock values.** Accept only documented
  `DD/MM/YYYY[ HH:MM[:SS]]` and `YYYY-MM-DD[ HH:MM[:SS]]` forms; validate the actual calendar
  and clock ranges; never use native locale-dependent `Date` fallback. Bare ASPECT dates mean
  midnight. Reject invalid/contradictory CMS files, and lock malformed ASPECT schedule evidence
  as `INVALID_ASPECT_DATETIME` or invalid Config Registry clocks as `INVALID_CONFIG_TIME` so
  neither can reach a correction CSV.
- **A blank Cognos `LOGIN ID` is held for review, never auto-Absent** (`MISSING_CMS_JOIN_KEY`) —
  it is missing evidence, not evidence of absence. A populated `LOGIN ID` with genuinely no CMS
  record still applies the normal No-Login-Record rule.
- **Punch-attribution ties are resolved by priority, never by file order:** a real scheduled
  shift window beats a synthetic leave-day window; a remaining tie goes to the earlier-starting
  window; anything still tied is held for review (`AMBIGUOUS_PUNCH_ATTRIBUTION`) rather than
  guessed. Prevents a single ambiguous punch near a shift/leave boundary from producing two false
  absences depending purely on Cognos row order.
- **Cognos's `LATE START`/`LEFT EARLY` sentinel is structural, not a fixed value list:** it is
  always `-LEAVE HR`, so detect it as `value === -LEAVE HR` (or no `SIGIN IN`/`SIGIN OUT` at all)
  in addition to the configured `cognosSentinelValues` list — a fixed list alone silently misses
  any shift length outside the observed 8h/9h sample (e.g. a 10-hour day's `-600`).
- **Leave-day comparison, three parts:** (1) `DUTY1`/`DUTY-2`/`SCH DURATION` are NOT_COMPARABLE
  on a leave day — Cognos prints the paid-leave roster entitlement, not a shift ASPECT ever
  schedules. (2) `LEAVE HR` is only comparable when ASPECT recorded a REAL duration for the leave
  segment — codes that are structural full-day-by-design entries with no timestamps (`ANNUAL`,
  `P/H-LV`, `OFF` — config `leaveCodesWithoutDuration`) are never compared against a fabricated
  zero. (3) `LEAVE TYPE` treats Cognos's own verdict/false-absence values (`U-ABSENT`,
  `Absent NS/NC`, `ABSENT` — config `cognosLeaveTypeVerdictValues`) as NOT_COMPARABLE against a
  genuine ASPECT leave code, never as a competing code to flag as MISMATCH.
- **`COVER` never extends the attendance window** (config `coverExtendsAttendanceWindow`,
  default false) — it still counts toward `netScheduledMinutes`, but an unattended cover placed
  after shift end must not push `effectiveEnd` later and get charged as both an early-logout AND
  a separate cover-not-attended finding for the same day.
- **Two gates, not one skip-gate** (PRD §4.6, KB §5.2 step 3): a no-SHIFT/no-OT day is never
  fully skipped — it routes to a leave-day integrity check that still inspects CMS logins
  (≥60 min login on a leave day → convert to Absent + note). Never skip a no-SHIFT day that
  carries `OT2` — it silently drops paid public-holiday overtime.
- Measure lateness/early-leave against the **release-adjusted (effective)** window, not the
  raw scheduled window — except flex staff, who get a shift-update first (see below).
- **Flex staff (PRD §4.8): the cutoff is an ABSOLUTE wall-clock `10:00`, not a relative
  buffer from scheduled start.** Within cutoff: shift-update only, no penalty. Past cutoff,
  even by 1 minute: shift-update AND Late+Cover, measured from the cutoff, full amount
  charged, no minute-bands. Exact ASPECT CSV pair format is in PRD §4.8 — do not deviate.
- **Charge the FULL measured variance once any rule fires, never `measured − threshold`**
  (PRD §4.10) — 6 min late is a 6-minute Late segment, not 1.
- **Cover placement (PRD §4.11) is not "next day at shift start"** — a **newly assigned** cover
  is placed on the next working day strictly after **the later of** the incident date and
  `processingDate + coverMinimumDaysAfterRunDate` (the run-date floor, default 1 day — applies to
  every fallback mode below too), after the LAST segment of that day (which may not be the
  SHIFT), and covers stack sequentially. Requires forward-looking ASPECT data to work correctly.
  **When that forward-looking data hasn't been uploaded yet (the everyday case, not an edge
  case) — `coverFallbackWhenNoWorkingDayFound` (§4.11 Step 5) picks one of 3 options: `sameDay`
  (reuses the exact same-day placement logic, no new time logic), `nextDirectDay` (+1
  calendar day), or `nextWeekMonday`** (default — Monday of the ISO week after the
  incident's own week, so days-out varies by weekday). The last two use
  `coverFallbackDefaultTime` (default `08:00`); `sameDay` ignores it. Every cover placed
  this way carries a fixed note in both outputs (`Memo` suffix + `TAA_COVER_FALLBACK_NOTE`
  export column) so it's never indistinguishable from one placed against real schedule
  data — a wrong guess here is a pay error, so the ambiguity must stay visible.
  **Exception:** when `coverSameDayWhenAlreadyCovered` is on and the agent provably worked the
  full cover window continuously on the incident day itself, the cover is credited on that
  **same day** instead of any of the above — never applies to a newly assigned cover, only to one
  genuinely already worked. `processingDate` is the run's own clock at run time (never
  reproducible across re-runs — do not assert a cover date is stable) and is **required** on
  `ReconciliationInput`, run context only — it must never reach `ConfigRegistry` or an exported
  `Config.json`.
- **`TAA_REVIEW_COMPLETED` (a reviewer's checkbox) always exports the stored flag, never the
  checkbox's on-screen rendered state.** A clean row with no hold is auto-included and its
  checkbox therefore renders ticked with no human involved — a fresh run must still export
  `FALSE` for it, or the column is worthless.
- **"Must Check" and the Shift Changed tab/sheet are duplicate membership views, not
  categories.** A row's `TAA_RESULT_CATEGORY` never changes because of them, and neither view is
  ever added into `counts.ALL` or any other running total — a row can appear in several views at
  once while its own category badge stays fixed (PRD §4.16).
- **`TECHNICAL_SEGMENT_COVERS_VARIANCE` is a releasable hold** (see the note above): it fires
  only when **every** variance interval that actually charged a penalty on the row is covered by
  the row's configured technical segments to within tolerance, and it must always sit below every
  forced code in the hold cascade — never seeded into `forcedHoldReason`.
- `OT1` (normal overtime) and `OT2` (public-holiday overtime) are **different pay rates** —
  never merge them.
- **Absent + OT co-occurrence (PRD §4.6c, replace-pair decision 2026-09-15):** any day marked
  Absent must also **retire and replace** that day's `OT1`/`OT2` segments with `SHIFT` via a
  `shiftUpdateOriginalCode`/`shiftUpdateNewCode` (`10`/`11`) pair — never a bare insert
  alongside the original OT row, and never leave OT premium pay on an Absent day. Applies at
  every Absent-emission point, flex and non-flex alike; config-editable via
  `otToShiftConversionCode` (default `SHIFT`). Auto-included in the export, no reviewer hold —
  the day already pays zero regardless of which code the segment carries. **The replace pair
  must fire at most once per employee-day**, even though multiple independent rules (e.g.
  Late Login and Early Logout, or Rule 7 alongside either) can each mark the same day Absent
  in one pass — a duplicated/re-changed segment in the real ASPECT upload gets the whole
  batch rejected, so this is enforced with a per-row idempotency guard at the point of
  emission (`reconciliationEngine.ts`'s `convertOtOnce()`), not left to the
  `dedupeAspectCorrections` cleanup pass alone. **Rule 8 (the RLS/OT adjustment pair) is
  skipped entirely on an Absent day** — §4.6c's pair already retires the OT segment at full
  duration regardless of any RLS overlap, so letting Rule 8 also fire would draft a second,
  conflicting `10`/`11` pair against the same segment. See BR-04 (40-scenario pack).
- **Public-holiday SHIFT miscoding (PRD §4.6e, 2026-09-12) — the mirror of the `P/H-LV`+`OT2`
  exemption (BR-13, below in "40-scenario validation pack"; KB §7k), reversed:** a day whose
  leave segments are ALL a configured
  `publicHolidayOvertimeLeaveCodes` entry (default `P/H-LV`) but whose worked segments are ALL
  `SHIFT` (staff mistakenly scheduled as a normal shift instead of holiday overtime) auto-drafts
  a `shiftUpdateOriginalCode`/`shiftUpdateNewCode` (`10`/`11`) pair converting the SHIFT segment
  to `OT2` (config `shiftToOt2ConversionCode`, default `OT2`) — same `10`-locates/`11`-replaces
  mechanism as the flex shift-time-change pair (§4.8) and Rule 8's OT/RLS pair, just with
  `SegmentCode` as the changed field instead of time. Unlike the OT2 exemption, this does **not**
  skip the hold — it still fires `MIXED_LEAVE_AND_WORK_SEGMENTS`'s sibling, a new non-forced
  `PUBLIC_HOLIDAY_SHIFT_MISCODED` hold, since converting SHIFT to OT2 *adds* overtime-pay
  eligibility and needs one reviewer approval before export. **Re-run guard (2026-09-15):**
  skipped entirely when the day's ASPECT segments already carry an `ABSENT`/`Absent NS/NC`
  marker (left behind once §4.6c's own correction has been uploaded back into ASPECT) — without
  it, re-running TAA against an already-corrected date would propose converting the corrected
  SHIFT back to OT2, undoing §4.6c's fix. See KB §7l.
- **Absent excludes leftover timed penalties (PRD §4.6d, fixed 2026-09-09).** Late Login and
  Early Logout are independent `if` blocks, not `else if` — a day can trip both, and a
  less-severe rule's LATE/Log_off/COVER can already be pushed before a more-severe rule on the
  same day escalates the reported verdict to Absent. `applyMoreSevere*` only updates the
  reported verdict, it never retracts an already-pushed correction row, so before this fix the
  exported CSV could carry `ABSENT` **and** `Log_off` **and** `COVER` for the same
  employee-day — a real double pay-hit, and one that fired specifically on rows where Cognos
  agrees with TAA's recompute (the `MISMATCH_FOUND` hold never engages there), i.e. the clean
  rows nobody reviews. Fixed with a post-verdict strip: once the day's final `resultCategory` is
  `MARKED_ABSENT`, every `LATE`/`Log_off`/`COVER` correction is removed before
  `generatedCorrections` is assigned; `firedActionCodes`/`TAA_ACTIONS_FIRED` are untouched so the
  audit trail still shows every rule that fired. **A stripped COVER must release its reservation**
  in `placedCoversThisRun` (`coverReservationByRow` WeakMap) — cover placement claims a slot the
  instant it's created, and leaving that claimed after deleting the row would silently delay the
  next cover placed against the same employee/target-day, a new pay error in a different row.
  See `TAA_KNOWLEDGE_BASE.md` §7j for the full writeup, including why this was the only one of
  four claimed action-integrity defects (`doc/CLAUDE_ACTION_INTEGRITY_PROMPT.md`) that could
  reach the exported CSV — the other three (LATE/Log_off orphaned on cover-placement failure,
  the "no absent for non-login" gate table, Held-vs-Included UI category counts) were confirmed
  either already correct or review-only, and are not fixed by this entry.
- **The strip above is now OPTIONAL — `retainLateCoverOnAbsent` config toggle, default `false`
  (user-confirmed policy decision, 2026-09-17), not a reversal of the fix.** When `true`, the
  strip is skipped uniformly across every path that runs it (standard Late Login/Early Logout/
  Late Logout, both flex branches, Rule 7) — the day's `LATE`/`Log_off`/`COVER` correction(s)
  export alongside its `ABSENT` marker, and the cover reservation they claimed is correctly NOT
  released. Auto-includes exactly like a normal Absent row, no extra reviewer hold, when on —
  turning this on removes the double-pay-hit protection the strip exists for, uniformly, with no
  per-row check, so it stays opt-in. Paired with a separate change this made necessary: an
  `EmailActionItem` is now built per FIRED ACTION, not per row (`row_id` becomes
  `` `${baseRowId}#${actionCode}` `` whenever a row fires more than one distinct action) — with
  the shipped rule set this changes nothing observable (every Late+Cover/Logoff+Cover band is
  `NA`, every Absent band carries the real email), but a retained day genuinely fires two
  communicated findings and each needs its own draft. Every consumer that maps an action back to
  its row reads **`EmailActionItem.base_row_id`** — an explicit required field set at
  construction. **Never recover a row by splitting `row_id` on `'#'`**: `rowId` is
  `` `rec-${rowIndex}-${pfNo}` `` and a PF NO can itself contain a `#` (real occurrence:
  `PF NO = "PT #"` in `samples_Files/Cognos.csv` row 388), which truncates the key, fails the
  lookup, and silently un-emails that row — found and fixed by the 2026-09-17 audit, pinned by
  `hash-id-integrity-01`. Four `-retained` mirror cases (`H02-retained`/`H03-retained`/
  `reservation-integrity-01-retained`/`E25-retained`) assert the opposite outcome from
  `H02`/`H03`/`reservation-integrity-01`/`E25` with the toggle on. See KB §7j's follow-up note
  for the full writeup, including a correction to `reservation-integrity-01`'s own original
  claim (its two incidents never actually shared a reservation target in the first place — the
  test's PASS is real, just for a narrower reason than documented), and why sanitizing `#` out
  of the PF column at upload time was rejected as a fix in the wrong layer.
- **Never silently rewrite a source ID field to make downstream string handling easier.** PF NO
  is the payroll join key across Cognos ↔ ASPECT ↔ identity; mutating it at parse time to dodge
  a separator collision changes what rows join to, breaks the "never silently mutate a source
  value" rule the config-gated fill-if-blank exception exists to respect, and does not even
  rescue the offending row (`"PT #"` → `"PT"` is still junk, now disguised as a plausible PF NO).
  Carry the structure you need in its own field instead. Junk/repeated-header rows inside an
  export deserve a **visible** upload-time advisory (like `assessDateOverlap` /
  `detectDateFormatAmbiguity`), never a silent strip — still open, not implemented.
- ASPECT upload CSV rows (header and data) end with a **trailing comma**. User-confirmed insert
  code is exactly **`00`**; change pairs remain `10` then `11`.
- **The core pipeline is recompute-then-compare (PRD §4.13), not flag-final-disagreements.**
  Recompute every relevant Cognos column independently first; the annotated report shows
  recomputed-vs-original side by side. Results UI has 5 categories, not one flat table.
- **Zero hardcode is an auditable requirement (PRD §6.4), not an aspiration.** Every rule
  threshold, keyword list, flex/rounding parameter, segment glossary role, drop
  pattern, and code literal lives in one enumerated Config Registry, editable via the UI
  (`ConfigRegistryView.tsx`, 4 sub-tabs: Policy Rules Matrix, Flex Staff Policy, Keyword
  Classification & Cognos Drop Patterns, Cover & Join Parameters), with export/import/reset.
  A live `validatePolicyBands()` linter (`configRegistry.ts`) flags overlapping, inverted, or
  gapped minute-bands in the editable rule table so a bad edit can't silently misfire. A
  business-rule literal found in JS/VBA source is a defect.
- **Segment config is discovery-driven, not a static 295-code walkthrough (PRD §4.14).**
  On ASPECT upload, extract the distinct `SEG_CODE`s present and prompt a one-time glossary
  classification per code: **Addition / Removal / No Effect**, pre-filled from evidence
  (`SHIFT`/`COVER`→Addition, `RLS`-family/`NURSNG`→Removal) but never forced. User can add
  codes not in this upload and edit any classification later. One glossary answer per code
  drives the hours formula, the bucket table, and (via an optional secondary flag) the
  write-only behavior — not separate setup screens per concern. The leave-day gate is a
  separate mechanism: `config.nonWorkingDaySegmentCodes` (gate) / `config.leaveSegmentCodes`
  (leave identity), edited on the dedicated Leave Segments page — see `PRD.md` §Leave Segments.
- **Cognos import never silently drops rows** — drop patterns (e.g. `ACCESS CARD*`/`UAE*`)
  are config, default off, never a hardcoded filter.
- **Column-mapping UI required** on all 4 required uploads (Cognos/ASPECT/ASPECT
  ExtraFiled/CMS) for header drift — except CMS, which uses fixed column positions.
- **Uploads are non-blocking; only Calculate is gated (PRD §6.1).** Upload order is Cognos →
  ASPECT Segments → ASPECT ExtraFiled (Identity Master, now a required/gating upload, no
  longer optional) — any order accepted, gating is on completeness not sequence. Do not make
  the user wait for the CMS export before doing anything else. "Calculate" is disabled until
  all 4 files are present.
- **Calculate is also gated on both the regression suite and independent trust matrix passing
  against the live config** (`App.tsx` evaluates `allRegressionPassed && allTrustMatrixPassed`).
  A user can explicitly override with "I've Reviewed — Proceed Anyway"; the override resets
  whenever the config changes. This is a real production gate, not just a verification tab —
  don't remove or weaken it without a business decision.
- **CMS auto-export via folder automation was removed (2026-09-08).** CMS punches are a plain
  manual upload, same as the other 3 files. `ProjectFolderGate.tsx` and `services/projectFolder.ts`
  are deleted.
- **The entire Excel VBA Companion — both `RunCMSExport` and `RunEmailDrafts` — was removed
  (2026-09-08), same day.** Explicit user decision: the app must have zero Excel/VBA dependency.
  `TAA_VBA_Companion.bas`, `TAA_VBA_Companion.xlsm`, and `TAA_CMS_Automation/TAA_CMS_Launcher.vbs`
  are deleted from the repo, along with `VbaCompanionView.tsx`, `PreconditionWarning.tsx`,
  `vbaGenerator.ts`, and the VBA Companion tab/header icon. **Do not reintroduce any Excel/VBA/COM
  automation, browser-side or otherwise.** CMS export is manual-upload-only; email drafting is
  `.eml`-download-only (see below) with no fallback macro anymore.
- Join CMS via Cognos `LOGIN ID` directly — never via `ASPECT_ExtraFiled.csv`'s
  `EMP_EXTRA_3` (mismatches ~15% of the time).
- Emails are **draft-only**; a human sends. Never `.Send`, anywhere in this path.
- **The `taa-email:` VBA bridge was REMOVED (2026-09-08) — Excel is no longer part of drafting
  an email.** Clicking a mail icon or Bulk Draft downloads a ready-to-open `.eml` per action
  directly (`services/emlBuilder.ts`; `X-Unsent: 1` is what makes Outlook open it as an editable
  draft). No protocol, no registry, no folder, no polling — a plain browser download, identical
  whether opened via `http://localhost` or by double-clicking the HTML directly.
  `TAA_Email_Launcher.vbs` and `Install_TAA_Protocol.bat` are deleted. Recipient resolution moved
  into the browser too (§4.7 in the PRD): username wins whenever one exists, a corporate-domain
  email is used as-is otherwise, and a plain staff name is the last resort (Outlook's Check Names
  then makes a human confirm it) — **never strip a username out of a personal-domain address**,
  that can silently resolve onto a different employee. Manager CC comes from an optional
  user-uploaded `employeeManagerMap` (no mapping = no CC, never an error), since no source file
  has manager data. `RunEmailDraftRequest` and its request/status-only helpers, and later (2026-09-08,
  same day) `RunEmailDrafts` itself, are deleted — there is no Excel fallback anymore.
  **`TAA_Launch.bat` is no longer required anywhere in the normal
  flow** — it remains available only for anyone who wants to see the server console for
  troubleshooting.

## Ground truth / testing
- **Current authoritative count (2026-09-17):** `npm run test` → 145/145 regression
  (`regressionSuiteRunner.test.ts`), 145/145 trust matrix, 41/41 40-scenario pack. The
  "123 cases"/"currently 145/145 and 123/123" figures in the paragraph immediately below are a
  stale snapshot from an earlier pass (this file's own historical narrative was not kept
  perfectly in sync with every later addition); trust the `npm run test` output over any
  specific number quoted in prose here. The 5 most recent additions are `H02-retained`/
  `H03-retained`/`reservation-integrity-01-retained`/`E25-retained` (the `retainLateCoverOnAbsent`
  toggle) and `hash-id-integrity-01` (a PF NO containing `#` must still map its email actions
  back to its row) — see the Non-negotiables entries above and KB §7j's follow-up.
- `TAA_HTML/src/services/regressionSuite.ts` (123 cases, `reg-1`–`reg-119` plus `H02`/`H03`/
  `reservation-integrity-01`/`E25`) and
  `TAA_HTML/src/services/trustMatrix.ts` (145 cases) are two independent test sources, both
  wired into the "Regression Suite" nav item's UI (`RegressionSuiteView.tsx`) as separate
  tabs, currently 145/145 and 123/123 — grown from an original 26 (17 pre-existing + 9 added
  for the §7b real-sample-data audit) by a further batch of band-boundary, schedule-integrity,
  and strict input/output cases (`reg-27`–`reg-63`): Late-Login/Early-Logout/Late-Logout minute-band edges per tier,
  release-positioning edge cases (blank-duration, overlapping trailing releases, DURATION-vs-
  timestamp contradictions), and the Rule-7/idempotency-guard cases; `reg-64`–`reg-66`, added
  during the §7d real-byte-parsing audit, which — unlike every other case here — decode/parse
  trimmed but byte-faithful excerpts of the real `samples_Files/` exports
  (`sampleFileFixtures.ts`) through the actual parsers instead of constructing
  `AspectSegment`/`CognosRecord`/`CMSPunch` objects directly, exercising exactly the layer that
  let the §7d defects (case-sensitive glossary, un-normalized join key) go undetected through
  three prior audits; and `reg-67`–`reg-77`, added during the pre-UAT handoff audit (2026-09-09)
  to close specific coverage gaps found by re-deriving variance math by hand: Cover-Not-Attended
  variance/email propagation, flex Branch B downstream email creation, OPS email routing
  authority (Cognos `SECTION` vs ASPECT `EMP_EXTRA_4`), invalid-config fail-closed behavior,
  flex SHIFT+OT span preservation, overlapping-release union math, Rule 8's OT/RLS union,
  cover-timestamp truncation, mid-shift-removal net-hours integrity, and an early-login
  single-punch edge case. The same audit also found Rule 2 (Early Login, both tiers ->
  No Action) had **no code path at all** — `reconciliationEngine.ts` never computed an
  "arrived early" figure or called `lookupRule('Early Login', ...)`, so editing that row in
  the Config Registry UI had no observable effect anywhere, a real gap against the
  zero-hardcode audit requirement even though the No-Action outcome itself was always
  correct. Fixed the same day: the engine now computes `earlyLoginMin` and looks the rule up
  (new `EARLY_LOGIN` trace-measurement label, `types/taa.ts`), guarded identically to every
  other rule so behavior is unchanged unless the config itself is edited; `reg-78`/`reg-79`
  pin this for OPS and Officer+. **As of the same audit, `regressionSuite.ts` also runs
  headlessly** via `npm run test:regression-suite` (`regressionSuiteRunner.test.ts`, mirroring
  `trustMatrixRunner.test.ts`) and is now part of `npm run test` — previously it only executed
  inside the browser tab, so a green `npm run test` was never actual proof this suite (and thus
  the Calculate gate, which requires it) was passing. The same 2026-09-09 audit pass also found
  and fixed 10 further confirmed payroll-math defects (`reg-80`–`reg-90`) — see
  `doc/CLAUDE_PAYROLL_MATH_BUG_REPORT.md` for the full list and status of each; two findings
  (split-shift per-block evaluation, comparison-tolerance threshold-awareness) were investigated
  and deliberately left unchanged because they conflict with an existing, evidence-based design
  decision and need an explicit business call, not a unilateral fix. New hold reason
  `CMS_EXPORT_SCOPE_GAP` (`types/taa.ts`, `holdReasons.ts`): a CMS dataset with punches for other
  Login IDs but genuinely none for this one is held for review, not auto-marked absent — a
  fully-empty CMS dataset is unaffected and still applies Rule 5 normally (`reg-19`). **Removed
  2026-09-09, user-confirmed:** this guard assumed a CMS export could be scoped/filtered to the
  wrong agent list. The user rejected that premise for their process — CMS is generated for the
  full staff with no filtration, and every Absent verdict is already communicated to the agent for
  dispute, so the app must not manufacture doubt about its own input when Cognos and CMS already
  agree on zero login. Both branches in `reconciliationEngine.ts` (flex ~line 760, standard
  ~line 1070 before removal) now fall through unconditionally to the same `resolveNoLoginDecision`
  path as a fully-empty CMS dataset — "zero CMS punches for this login" is one standard rule for
  every row, with no per-row guess about export scope. `MISSING_LOGIN_ID`/`CMS_EXPORT_SCOPE_GAP`
  is removed from `HoldReasonCode` (`types/taa.ts`) and `holdReasons.ts`'s forced-hold set (the
  `MISSING_LOGIN_ID` *verdict* itself is retained — it is independently used by the unrelated
  GATE 0 blank-`LOGIN ID` check). In its place, an upload-time **headcount mapping check**
  (`assessHeadcountMapping`, `punchAttribution.ts`) surfaces the same risk once, visibly, instead
  of guessing per row: every rate is anchored on the Cognos worklist (the report TAA validates and
  actions), never a symmetric three-way overlap, since ASPECT and CMS are only evidence sources
  for Cognos rows. The CMS denominator excludes employees Cognos itself already reports as having
  no attendance (`cognosClaimsAttendance`, new export in `cognosComparison.ts`, deliberately
  separate from the narrower `noRecordedAttendance` used by `isCognosSentinel`/`compareCognosRow`
  so payroll-facing sentinel detection is untouched) — counting Cognos-declared no-shows as
  "missing CMS evidence" would understate coverage and fake the number. The one critical,
  always-visible figure (`cognosClaimsAttendanceButNoCmsCount`, rendered in red in `App.tsx`
  regardless of the toggle below) is Cognos employees who claim attendance but have zero CMS
  records — the only case where the new standard rule actually contradicts what Cognos reports.
  Two new config fields (`ConfigRegistry`, `types/taa.ts`): `validateUploadedHeadcount` (bool,
  default `true`) and `minHeadcountMappingPercent` (number 0–100, default `70`) — when the toggle
  is on, Calculate is blocked (pending an explicit "I have checked the uploads" acknowledgement,
  mirroring the existing payroll-verification-override pattern) if the lower of the Cognos→ASPECT
  or Cognos→CMS mapping percentage falls below the minimum; when off, the check is skipped
  entirely. `reg-66`/`reg-81` were updated to the new standard-Absent expectation; `reg-102`/
  `reg-103` cover the mapping gate itself and the denominator-honesty/critical-count logic.
  **Fixed same day, later pass (2026-09-09):** in the real
  `samples_Files/Cognos_DescrepencyReport.csv`, 19 rows carry `SIGNIN DURATION = 00:00` alongside
  a real sign-in and sign-out hours apart (e.g. `07:00-15:00`, in `07:09`, out `15:10`, LATE `-9`,
  LEFT EARLY `10`) — Cognos computed LATE START/LEFT EARLY from those same timestamps but failed
  to fill the duration. Independently re-parsed the real file to confirm the exact distribution:
  **192** rows (not the 182 first estimated) are the legitimate "never signed in" placeholder
  (`00:00` + blank SIGIN IN/OUT + a leave/absence code), 4 are a genuine single swipe (SIGIN
  IN == SIGIN OUT), and the column is 502/502 populated — there is no separate blank-vs-`00:00`
  inconsistency to track. `cognosComparison.ts`'s SIGNIN DURATION downgrade (§Non-negotiables
  above) is now narrowed: it still downgrades a MATCH to NOT_COMPARABLE unconditionally (covers
  the 4 single-swipe rows) and still downgrades a nonzero-Cognos MISMATCH (the real
  staffed-vs-span gap, unaffected), but a MISMATCH where Cognos's own parsed value is exactly 0
  now surfaces as a genuine MISMATCH with a note naming it a Cognos duration-calculation failure,
  never downgraded. **This is a real, user-approved output-behaviour change, not display-only**:
  such a row now sets `holdReason = 'MISMATCH_FOUND'` (`reconciliationEngine.ts`), which withholds
  it from the ASPECT correction CSV until a reviewer overrides it — SIGNIN DURATION is documented
  Informational/QA-only (`PRD.md`) but the engine's mismatch-hold gate does not special-case it.
  Detection is recompute-based (Cognos value 0 AND the CMS-derived span disagrees), a deliberate
  choice over a narrower "Cognos's own SIGIN IN != SIGIN OUT" check — the accepted consequence is
  that a Cognos row whose own SIGIN IN/SIGIN OUT happen to agree can still report MISMATCH if CMS
  evidence contradicts it (pinned by `reg-107`, not a bug). `reg-104`–`reg-107` cover the defect
  shape, the leave-placeholder shape (unchanged), the single-swipe shape (unchanged), and that
  accepted consequence. Rule 7
  (Cover Not Attended) and Rule 8 (RLS added to OT with no adjustment) now also run for flex
  staff, extracted into shared `evaluateCoverNotAttended`/`evaluateRlsOtAdjustment` functions
  called from both the flex and standard branches.
  **Re-audit of that same fix pass, same day (2026-09-09):** the 10 claimed fixes above were
  independently re-verified against the live source (not taken on the report's own word) — all
  10 confirmed genuinely present and correct. The re-audit found 6 further defects (`reg-91`–
  `reg-96`), 3 that the fix pass itself introduced by copy-pasting Rule 7/8's correction-emission
  logic across the flex/standard branches instead of sharing it, and 3 pre-existing gaps the fix
  pass didn't reach — see `PRD.md` §9c for the full writeup. In brief: (1) Rule 8's OT/RLS pair
  and the Absent-day OT→SHIFT conversion now derive `SegmentDate` from the segment's own parsed
  `START_MOMENT` via `formatSegmentDate()`, never the raw un-normalized ASPECT `START_DATE` text
  (was reaching the exported CSV un-normalized at 3 sites, tripled from the pre-audit 2 by the
  duplication above); (2) Rule 7/8 emission is now built once (`buildCoverNotAttendedOutcomes`/
  `buildRlsOtAdjustmentOutcomes`) and applied identically at every call site, and Rule 8's
  adjustment now increments its own `otRlsAdjustedCount` summary field instead of the unrelated
  OT→SHIFT-on-absent-day counter; (3) `placeCoverSegment`'s target-day check now also rejects
  `INVALID_ASPECT_DATETIME`, the one source-day integrity signal it was missing; (4) a
  duration-only removal beside a timestamped one in the same leading/trailing group is held
  (new hold reason `AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION`) rather than risking an undetected
  overlap, and the reported `leadingReleaseMinutes`/`trailingReleaseMinutes` now match the same
  unioned totals `netScheduledMinutes` actually subtracted (previously still the raw pre-union
  sum); finding this also surfaced and fixed an unrelated pre-existing bug where a duration-only
  removal with a *real* `DURATION` was wrongly flagged `INVALID_ASPECT_DATETIME` instead of being
  processed normally, since `invalidDateTimeSegments`' exemption required the duration to ALSO be
  null; (5) every configured "No Login Record" action now has a distinct, correct effect —
  `MANUAL_REVIEW_REQUIRED` holds (new hold reason `NO_LOGIN_MANUAL_REVIEW_CONFIGURED`) and any
  other unsupported action holds as `INVALID_CONFIG_VALUE`, instead of silently defaulting to
  `ABSENT_NS_NC` for anything except `NO_ACTION`, via a shared `resolveNoLoginDecision()`; (6) the
  `F09_CONFIG_OT` audit probe in `scripts/audit-payroll-math.ts` filtered on the wrong
  `segmentType` string and was corrected — `doc/PAYROLL_MATH_AUDIT_EVIDENCE.json` was stale for
  that one evidence ID even after the real fix landed. `trustMatrix.ts`'s
  expected verdicts are hand-derived from `Rules to be taken.csv` and this file's non-negotiables
  — never by calling the engine's own decision code (`reconciliationEngine.ts`/
  `scheduleRecompute.ts`/`punchAttribution.ts`), so a passing case is an independent check, not
  self-agreement. See `TAA_KNOWLEDGE_BASE.md` §7a for 3 confirmed defects it found and that are
  now FIXED (multi-rule rows report every fired rule via the new `TAA_ACTIONS_FIRED` field, not
  just the most-severe `TAA_ACTION`; Late Logout measures from the release/nursing-adjusted
  effective end, not the raw end; single-punch evidence is span-based for all staff including
  flex) and §7b for 6 more confirmed defects found by auditing against the REAL sample files
  (not just synthetic fixtures) and now FIXED: blank Cognos `LOGIN ID` held for review instead of
  auto-Absent; the Cognos sentinel guard (`-LEAVE HR`) now applies to `LATE START` as well as
  `LEFT EARLY`, and is detected structurally rather than off a fixed value list; `DUTY1`/`DUTY-2`/
  `SCH DURATION` are suppressed as NOT_COMPARABLE on a leave day (Cognos prints the paid-leave
  roster entitlement, not a shift ASPECT ever schedules); `LEAVE HR` is only compared when ASPECT
  actually recorded a real duration (full-day-by-design codes like ANNUAL/P/H-LV/OFF are never
  compared against a fabricated zero); `COVER` no longer extends the attendance window (so an
  unattended trailing cover is charged once, not as both an early-logout and a cover-not-attended
  finding); and the punch-attribution tie-break (formerly D-D, first-Cognos-row-wins) now
  prioritizes a real scheduled shift over a synthetic leave-day window, then the earlier-starting
  window, holding for review only if a tie still remains unresolved after both rules.
- The two further findings from that real-data audit are fixed: specific leave codes win over
  generic `LEAVE` for comparison (`reg-61`), and no-attendance `SIGNIN DURATION="00:00"` is
  structural rather than a false mismatch (`reg-58`). See KB §7b–§7c.
- **Headless test scripts (2026-09-07, extended 2026-09-09):** `trustMatrix.ts` previously only
  ran inside the browser UI. `TAA_HTML/src/services/trustMatrixRunner.test.ts` runs it headlessly
  via `npm run test:trust-matrix` (calls the real `runTrustMatrixTests()` export, never
  duplicates its cases) — currently 145/145 against the live engine, confirming no drift.
  `regressionSuite.ts` had the same gap until 2026-09-09 (77 cases with no CI runner, only the
  browser tab); `regressionSuiteRunner.test.ts` now closes it the same way, via `npm run
  test:regression-suite` — currently 123/123 (77 plus `reg-78`/`reg-79` for Early Login,
  `reg-80`–`reg-90` for the payroll-math audit fixes, `reg-91`–`reg-96` for the same-day
  re-audit of that fix pass, `reg-102`/`reg-103` for the headcount mapping gate,
  `reg-104`–`reg-107` for the SIGNIN DURATION zero-duration defect fix, all added the same
  day — see the notes above — and, later the same day, `H02`/`H03`/`reservation-integrity-01`/
  `E25` for the D2 action-integrity fix, KB §7j; `reg-108` (MIXED_LEAVE_AND_WORK_SEGMENTS
  fires but is reviewer-releasable, ordered ahead of generic MISMATCH_FOUND), `reg-109`
  (the Cognos LEAVE TYPE MAPPED basis is load-bearing, not decorative), `reg-110`
  (`compareScheduleColumnsOnLeaveDays` toggle actually changes DUTY1 comparison on a leave
  day), `reg-111`–`reg-113` (2026-09-11, the OT_INTERNAL removal-position fix below), and
  `reg-114`–`reg-116` (2026-09-12, the public-holiday-overtime exemption and its two
  boundary guards — KB §7k), `reg-117`–`reg-119` (2026-09-12, the Public-Holiday SHIFT
  Miscoding mirror rule — the positive case plus two boundary guards — KB §7l), and `reg-127`
  (2026-09-15, the §4.6e re-run guard — KB §7l)).
  `npm run test`
  chains `test:features`,
  `test:trust-matrix`, `test:regression-suite`, `test:xlsx-writer`, `test:schedule-blocks`,
  `test:config-export`, and `test:validation40` (the 40-scenario pack below) in one command.
  Run this before every build alongside the existing manual UI check.

### OT_INTERNAL removal classification (2026-09-11)
A release/RLS segment fully contained inside OT1/OT2 (e.g. an RLS spanning part of OT1 and
part of OT2, with no SHIFT overlap) is classified `OT_INTERNAL`, not `MID` — full containment
against the raw OT1/OT2 intervals is required; a release that straddles the shift/OT boundary,
or falls in a gap between two non-contiguous OT blocks, still classifies `MID` and is held.
Unlike `MID`, `OT_INTERNAL` is never a forced hold and DOES reduce `netScheduledMinutes` (the
overlap genuinely isn't required attendance — Rule 8 emits the matching OT-duration correction
on a present day; on an Absent day, §4.6c's replace pair retires the OT segment instead and
Rule 8 is skipped, per the 2026-09-15 replace-pair decision), but — like `MID` — it never moves
`effectiveStart`/`effectiveEnd`. The exact
incremental minutes removed are exposed as `DayScheduleRecompute.otInternalRemovalMinutes` /
`details.otInternalRemovalMinutes`, shown in the UI as "OT-Internal Deductions" alongside
"Release Deductions"/"Nursing Deductions" so `raw additions - releaseMinutes - nursingMinutes -
otInternalRemovalMinutes = netScheduledMinutes` stays reconcilable by hand. See
`scheduleRecompute.ts`'s `otInternalRemovalMinutesReported`/`otIntervals`, and `reg-111`–`113`.

### TAA_ACTION vs. holdReason contract (resolved 2026-09-11)
`TAA_ACTION` reports the business action the attendance rules calculated; `holdReason` and
`includeInOutput` report workflow safety separately and must never be inferred from
`TAA_ACTION` alone. A hold discovered only AFTER the normal attendance path already ran (a
POST-calculation schedule-integrity finding — `MID_SHIFT_REMOVAL_SEGMENT`,
`AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION`, `REMOVAL_SEGMENT_DURATION_UNKNOWN`,
`SEGMENT_STOP_DURATION_DISAGREE`, `REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW`,
`UNCLASSIFIED_SEGMENT_CODE`, `AMBIGUOUS_PUNCH_ATTRIBUTION`) does NOT overwrite an
already-computed `TAA_ACTION` — if no lateness/early-departure rule fired, `NO_ACTION` is
correct even though the row is held. A PRE-calculation failure, where no trustworthy action
exists at all (`MISSING_CMS_JOIN_KEY`, `INSUFFICIENT_CMS_COVERAGE`, `INVALID_ASPECT_DATETIME`,
`INVALID_CONFIG_TIME`, `CONTESTED_SINGLE_PUNCH`, `UNPARSEABLE_SIGN_IN_DATE`,
`NO_LOGIN_MANUAL_REVIEW_CONFIGURED`), still forces `MANUAL_REVIEW_REQUIRED`. See
`reg-51`/`reg-53`/`reg-56` and the 40-scenario pack's BR-18/BR-19.

### Full-day segments (decision 2026-09-21)
A segment with role ADDITION/REMOVAL and no DURATION and no START/STOP is a **full-day segment**
(`isFullDayBareSegment`, `scheduleRecompute.ts`). Its duration is the day's own scheduled
duration (SHIFT + OT1/OT2 + COVER, before removals — `scheduledDayMinutes`);
`defaultFullDaySegmentDurationMinutes` is only the fallback when the day has no schedule.
A full-day REMOVAL takes what is left after all timed removals (net 0, effective window collapses,
reported in `releaseMinutes`/`fullDayRemovalMinutes`, trace position `FULL_DAY`) and raises the soft,
reviewer-releasable `FULL_DAY_REMOVAL_ON_SCHEDULED_DAY` hold — it never trips
UNKNOWN/OUT_OF_WINDOW/NEGATIVE/AMBIGUOUS. A full-day ADDITION never double counts (adds only the
default, once, on a day with no schedule) and lives in `fullDayAdditionSegments`, not
`additionSegments`. Bare SHIFT/OT1/OT2/COVER stay `INVALID_ASPECT_DATETIME`. `NO_EFFECT` codes
(ANNUAL etc.) are untouched until reclassified in the Segment Glossary; LEAVE HR is still never
defaulted. This reverses the older "bare release is held, never defaulted" rule (`reg-53`, `reg-140`).

A day fully released this way is **never a valid cover target**: `resolveDayCoverAnchor` blocks it on
`fullDayRemovalMinutes > 0`, so it takes the documented `skippedDay` + fallback path with the reason in
the Memo. It still passes `isWorkingDaySegment` (its SHIFT row is still present), and the gate that used
to block the shape (`REMOVAL_SEGMENT_DURATION_UNKNOWN`) can no longer fire for a bare removal — without
this gate a cover landed on the released day with no hold, and the next run would raise
cover-not-attended and escalate it to an absence. Pinned by `reg-141`.

### 40-scenario validation pack
`artifacts/TAA_40_Validation_Scenarios.md`/`.csv`/`.xlsx` are 20 combined business-rule (BR-01
to BR-20) plus 20 parser/algorithm (AL-01 to AL-20) hand-written scenarios, run against the
real engine (not simulated) via `TAA_HTML/scripts/validate40.ts` (`npm run test:validation40`
from `TAA_HTML/`). Current result: **40/40**. `BR-13` (a day with only `P/H-LV` + `OT2`, a
public-holiday-overtime day, no `SHIFT`) was found tripping `MIXED_LEAVE_AND_WORK_SEGMENTS`
and held out of the exported correction CSV, contradicting `doc/PRD.md`'s own Non-Negotiables
table (the "Holiday Overtime (PF 4507957 on 28/08)" row: "Evaluated & Paid as Public Holiday
OT2", not held). Resolved 2026-09-12 with a deliberately narrow exemption — `P/H-LV`+`OT2`
only, not any leave code, not OT1, not "no SHIFT" broadly — see KB §7k for the rule and
`regressionSuite.ts` `reg-114`–`reg-116` for the fix plus its two boundary guards.
- **Email/VBA handoff contract testing was removed (2026-09-08)** along with the rest of the VBA
  Companion: `emailVbaContract.test.ts` and `TAA_HTML/scripts/check-vba-parity.mjs` are deleted,
  since there is no `.bas`/`.xlsm` left to cross-check `emailDrafts.ts` against. The defect that
  test suite once caught (a `TAA_JsonValue` escaping-order bug in the now-deleted VBA source) is
  historical only — see KB for the full writeup if it's ever needed again.
- **Section→Mailbox duplicate guard (2026-09-07):** the Email Config wizard's Section→Mailbox
  step (`EmailConfigWizardModal.tsx`) now detects duplicate Section entries live — case-insensitive,
  trimmed, matching the same normalization `poolEmailOpsActionsBySection` uses to key its lookup
  Map (`emailDrafts.ts`) — and highlights every colliding row in red with an inline warning,
  disabling Next/Save & Finish until resolved. `normalizeSectionMailboxMap()` in
  `configRegistry.ts` (now exported, previously private) is the single normalize/dedupe
  implementation reused by CSV import (`handleImportSectionMailboxCsv`, now collapsing via the
  same helper instead of a bespoke inline merge) and by `handleFinish` as a defense-in-depth
  collapse before saving, so a duplicate can't reach `localStorage` regardless of entry path
  (manual typing or bulk CSV import).
- **Email content wording (2026-09-07):** the subject/opening/closing lines in
  `DEFAULT_EMAIL_TEMPLATES` (`emailDrafts.ts`) were updated with proposed replacement text per
  KB item 9 / PRD §8 item 12 — flagged in a comment above the constant as **pending explicit user
  sign-off**, not a finalized decision. The structural field block (Finding/Action taken/variance/
  login/section lines) is unchanged.

## Parsing gotchas
- `Cognos_DescrepencyReport.csv` is UTF-16, tab-delimited.
- All CSVs contain pasted email threads inside quoted fields — use a real CSV reader.
- `EMP_ID` is space-padded in ASPECT exports — trim before joining.
- A bare date with no time in `START_MOMENT`/`STOP_MOMENT` means midnight (00:00:00), not
  missing data.
- `ASPECT_ExtraFiled.csv` is the 21-column identity/email master (2,199 employees) — not to
  be confused with `ASPECT_Schdule_Segments.csv`'s 19-column schedule schema.
- `RLS`/`RLS-2H`/`RLS-3H`/`UN_RLS`/`COVER_RLS` currently have **zero occurrences** as real
  ASPECT segments — they exist only as free text inside Cognos `REMARK`. Only `NURSNG` is a
  directly observed ASPECT example of a trailing hour-reducing segment.

## Conventions
- `Rules to be taken.xlsx` is authoritative. `Rules.txt` is deprecated — do not implement
  from it.
- Primary deliverable is a standalone zero-dependency HTML/JS tool: `TAA_Workspace.html`
  (repo root), built from `TAA_HTML/src` — see the rebuild rule above. Never hand-edit
  `TAA_Workspace.html` directly; edit `TAA_HTML/src` and rebuild. There is no Excel/VBA
  companion anymore (removed 2026-09-08) — Outlook mailbox/manager resolution and draft
  creation happen entirely in the browser (`emailDrafts.ts`, `emlBuilder.ts`).
- **Any change that adds, removes, or modifies a user-configurable parameter must be wired
  end-to-end before it's considered done** — not just made to compile: (1) the field in
  `ConfigRegistry` (`types/taa.ts`); (2) its default in `DEFAULT_CONFIG`
  (`configRegistry.ts`); (3) its entry in `ALL_CONFIG_KEYS` in
  `configExportImport.test.ts` (TypeScript refuses to compile otherwise — this is what
  already guarantees the field round-trips through Export/Import Config JSON); (4) a real,
  editable control in the settings UI (`ConfigRegistryView.tsx`'s matching sub-tab, or
  `LeaveSegmentsView.tsx` for leave-specific fields) — a field only reachable by hand-editing
  an exported JSON is not usable by a real user. Before reporting such a change complete,
  verify the full round trip: set the value in the UI, Save, Export, re-Import, confirm the
  same value reappears in the UI. (2026-09-11 audit found 12 fields that were live in the
  engine and round-tripped through Export/Import but had never been given a UI control — all
  12 were added to `ConfigRegistryView.tsx`/`LeaveSegmentsView.tsx` the same day.)
