import { HoldReasonCode, AuditHoldReasonCode } from '../types/taa';

// Moved from reconciliationEngine.ts (2026-09-24, Hold Policy tab) so this module — and
// src/services/holdPolicy.ts, which builds every Hold Policy tab row from this record's
// keys — never needs to import the engine itself (that would create configRegistry.ts ->
// holdPolicy.ts -> reconciliationEngine.ts -> configRegistry.ts import cycle, since
// configRegistry.ts's import sanitisation calls holdPolicy.ts's sanitizeHoldPolicy).
// reconciliationEngine.ts imports this back unchanged — same object, same behavior.
// Typed Record<HoldReasonCode, string> — exhaustive, so a new HoldReasonCode value fails
// the TypeScript build here until a label is added, and holdPolicy.test.ts additionally
// fails at runtime with a pointer message (see doc/PRD.md §Hold Policy).
export const HOLD_REASON_TEXT: Record<HoldReasonCode, string> = {
  MISMATCH_FOUND: 'One or more recomputed columns disagree with Cognos — review before including in the ASPECT correction file.',
  COGNOS_DATA_GAP: 'No ASPECT schedule found for this employee on this date — nothing to recompute against.',
  UNCLASSIFIED_SEGMENT_CODE: 'This day contains a SEG_CODE not yet classified in the Segment Glossary — classify it and recalculate.',
  INSUFFICIENT_CMS_COVERAGE: 'The CMS export does not reach far enough to confirm this employee-day’s attendance — upload a wider CMS export or confirm manually.',
  UNPARSEABLE_SIGN_IN_DATE: 'Cognos SIGN IN DATE could not be parsed — this row needs manual review, not an automatic correction.',
  MISSING_CMS_JOIN_KEY: 'Cognos LOGIN ID is blank for this row — it cannot be joined to any CMS punch. This is missing evidence, not proof of absence; verify manually.',
  AMBIGUOUS_PUNCH_ATTRIBUTION: 'A CMS punch near this employee-day was equally claimable by another shift/leave window and the tie could not be resolved automatically — verify which day the punch actually belongs to.',
  REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW: 'A release/nursing (or other REMOVAL) segment falls outside this day\'s SHIFT/OT window — correct its START/STOP in ASPECT and recalculate.',
  // No longer emitted: a mid-shift release now deducts its minutes from scheduled hours without moving the window. Kept so saved results that carry this code still render.
  MID_SHIFT_REMOVAL_SEGMENT: 'A release/nursing segment sits in the MIDDLE of this shift, not at either end. Subtracting it from the shift end would invent an early/late-logout finding, so no variance was measured — confirm where the release really belongs and recalculate.',
  REMOVAL_SEGMENT_DURATION_UNKNOWN: 'A release/nursing segment on this day has neither a DURATION nor usable START/STOP timestamps, so how much time it removes is unknown. It was counted as zero rather than guessed — fill in the segment in ASPECT and recalculate.',
  FULL_DAY_REMOVAL_ON_SCHEDULED_DAY: 'A full-day removal segment (no duration, no times) took this day\'s whole scheduled duration off the hours (scheduled hours now 0, shift window collapsed). If the agent actually worked, the attendance charges on this row rest on a fully released day — check ASPECT and CMS, then release via reviewer approval; never a forced hold.',
  SEGMENT_STOP_DURATION_DISAGREE: 'A segment DURATION disagrees with its own START/STOP timestamps. The paid-hours total comes from DURATION and the attendance window comes from the timestamps, so one of the two numbers on this row is wrong — fix the segment in ASPECT and recalculate.',
  AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION: 'A release/nursing segment with only a DURATION (no usable START/STOP timestamps) sits alongside a timestamped release/nursing segment on the same end of this shift. There is no way to tell whether they cover the same physical time or genuinely different time, so the scheduled minutes on this row may be wrong — add real timestamps to the duration-only segment in ASPECT and recalculate.',
  NO_LOGIN_MANUAL_REVIEW_CONFIGURED: 'The "No Login Record" policy rule is configured to MANUAL_REVIEW_REQUIRED for this tier — held for a human to confirm rather than auto-marked absent, exactly as configured.',
  CONTESTED_SINGLE_PUNCH: 'This day was left with too few CMS punches to judge because a neighbouring shift claimed a punch that could equally have belonged here. That is an attribution judgement, not evidence of absence — confirm manually before marking anyone absent.',
  INVALID_ASPECT_DATETIME: 'One or more ASPECT segments has a malformed, incomplete, reversed, or contradictory date/time. Correct the source schedule and recalculate before any payroll correction is exported.',
  INVALID_CONFIG_TIME: 'A Config Registry clock value is invalid. Correct it to a valid HH:MM wall-clock value and recalculate before exporting payroll corrections.',
  INVALID_CONFIG_VALUE: 'A Config Registry numeric or code value is unsafe for payroll math. Correct the highlighted setting and recalculate before exporting payroll corrections.',
  FLEX_SCHEDULE_OUTSIDE_WINDOW: 'This flex-tagged employee\'s ASPECT-scheduled start falls outside the configured flex window (default 07:00-10:00) — the flex cutoff algorithm assumes a morning start and would charge a full-day variance against a shift it was never designed for. Standard attendance rules ran instead; confirm the schedule or flex tag manually before exporting.',
  MIXED_LEAVE_AND_WORK_SEGMENTS: 'This day carries both an identified leave segment and a worked (Addition) segment — review before including in the ASPECT correction file. Calculations ran normally; releasable via reviewer approval, never a forced hold.',
  PUBLIC_HOLIDAY_SHIFT_MISCODED: 'This public-holiday-leave day (a configured Public-Holiday Overtime Leave Code) carries a SHIFT segment instead of the expected OT2 holiday-overtime segment. TAA already generated the SHIFT-to-OT2 correction below — review it, then approve via the checkbox to include it in the ASPECT correction file.',
  NEGATIVE_NET_SCHEDULE_MINUTES: 'A removal (or combination of removals) on this day subtracts more minutes than the shift/OT additions provide, which would report a negative scheduled-minutes total. The figure was floored to 0 rather than exported as negative — correct the conflicting segment(s) in ASPECT and recalculate.',
  AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS: 'Two same-kind ADDITION segments (two COVER rows, or two SHIFT/OT rows) genuinely overlap in time on this day, so the scheduled minutes may be double-counting the overlap. A COVER sitting inside a shift is normal and is not flagged. Check the roster — if the overlap is genuine, approve via the checkbox to include this row; otherwise correct the segments in ASPECT and recalculate.',
  CONFLICTING_IDENTITY_RECORD: 'More than one Identity Master row shares this employee\'s EMP_ID with disagreeing details. The first record was kept rather than silently taking the last — correct the duplicate in the Identity Master file and recalculate.',
  DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS: 'A segment on this day had a non-blank but malformed DURATION value (not a valid whole number of minutes) — the duration shown was derived from the segment\'s own START/STOP timestamps instead. The computed number is very likely correct, but the source ASPECT data still needs fixing; releasable via reviewer approval, never a forced hold.',
  STILL_CLOCKED_IN: 'A CMS punch for this login has no logout recorded (the export\'s open-logout sentinel) — this employee was still clocked in when the CMS export was generated. Attendance cannot be computed until a later export supplies a real logout; never guessed as "now" or any other time.',
  // No longer emitted (2026-09-27): an already-absent day with CMS attendance is now NO_ACTION, not held. Kept so saved results that carry this code still render.
  ABSENT_MARKED_BUT_ATTENDED: 'ASPECT already tags this employee-day as absent (a configured existing-absence-marker code), but CMS shows attendance at or above the leave-login threshold. TAA never auto-reverses a recorded absence — confirm with the source documentation before correcting ASPECT.',
  TECHNICAL_SEGMENT_COVERS_VARIANCE: 'Every variance this row charged (late login, early logout, late logout, or an unattended cover window) falls inside a configured technical segment (e.g. TECH/TECH2) on this day, within the configured tolerance — the correction below is already built but held rather than exported, since technical time is paid. Releasable via reviewer approval, never a forced hold.',
};

/**
 * Holds caused by missing, ambiguous, or internally contradictory evidence.
 * These rows can only be released by correcting the source data and rerunning;
 * a UI toggle must never put them into the payroll correction CSV.
 */
export const FORCED_HOLD_REASONS: ReadonlySet<HoldReasonCode> = new Set<HoldReasonCode>([
  'COGNOS_DATA_GAP',
  'UNCLASSIFIED_SEGMENT_CODE',
  'INSUFFICIENT_CMS_COVERAGE',
  'UNPARSEABLE_SIGN_IN_DATE',
  'MISSING_CMS_JOIN_KEY',
  'AMBIGUOUS_PUNCH_ATTRIBUTION',
  'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW',
  'MID_SHIFT_REMOVAL_SEGMENT',
  'REMOVAL_SEGMENT_DURATION_UNKNOWN',
  'SEGMENT_STOP_DURATION_DISAGREE',
  'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION',
  'NO_LOGIN_MANUAL_REVIEW_CONFIGURED',
  'CONTESTED_SINGLE_PUNCH',
  'INVALID_ASPECT_DATETIME',
  'INVALID_CONFIG_TIME',
  'INVALID_CONFIG_VALUE',
  'FLEX_SCHEDULE_OUTSIDE_WINDOW',
  'NEGATIVE_NET_SCHEDULE_MINUTES',
  'CONFLICTING_IDENTITY_RECORD',
  'STILL_CLOCKED_IN',
  // ASPECT already marks this day absent, but CMS shows real attendance. Removing a
  // recorded absence restores a day's pay — that decision belongs to a reviewer with
  // the source documents, never an automatic release into the payroll CSV.
  'ABSENT_MARKED_BUT_ATTENDED',
  // NOT forced, deliberately: AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS. Overlapping
  // additions are a scheduling-judgement call (like MIXED_LEAVE_AND_WORK_SEGMENTS /
  // PUBLIC_HOLIDAY_SHIFT_MISCODED), not missing or self-contradictory evidence, and
  // the rule has never been validated against a real production export — every
  // COVER in the real sample sits outside its shift window, so the overlapping
  // shapes it fires on are untested. A reviewer who has checked the roster must be
  // able to release the row; locking it would strand that day's real corrections
  // with no path to export them.
  // NOT forced, deliberately: TECHNICAL_SEGMENT_COVERS_VARIANCE (WP5/B5/B15). The
  // engine already built the LATE/Log_off/COVER/ABSENT correction(s) on this row —
  // there is no missing or contradictory evidence, only a business judgement about
  // whether a technical-outage claim genuinely excuses the variance. A reviewer who
  // checked the technical segment against the incident must be able to release the
  // row into the payroll CSV; locking it would make the whole feature a silent no-op.
]);

export function isForcedHoldReason(reason: HoldReasonCode | AuditHoldReasonCode | string | null | undefined): boolean {
  // UNSEEN_PUNCH_OUTCOME (unseenPunchAudit.ts) is force-held for the same reason as the rest
  // of this set: the audit's what-if re-run changed the VERDICT/ACTION itself, so a reviewer
  // with the source data — not a UI toggle — must decide before it reaches payroll.
  if (reason === 'UNSEEN_PUNCH_OUTCOME') return true;
  return !!reason && FORCED_HOLD_REASONS.has(reason as HoldReasonCode);
}
