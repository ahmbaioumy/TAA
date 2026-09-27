// Phase 5+ — pure helpers for the UI-only tri-state review marker (ReconciliationRow.reviewStatus).
// Never touches includeInOutput/reviewCompleted/includeDecisionSource, which drive exports.
import { ReconciliationRow, ReviewStatus } from '../types/taa';

/** Held rows (holdReason truthy) start NOT_TOUCHED — they need a human look.
 * Everything else (including no-correction rows) starts REVIEWED — nothing to
 * check. Call this ONCE, after every hold-setting pass for a run has finished
 * (engine + unseenPunchAudit + any later audit), so a hold added by a late
 * pass still starts its row unreviewed. Never call this on a rebuild triggered
 * by a user action (include toggle / status click) — that would wipe marks. */
export function initialReviewStatus(row: Pick<ReconciliationRow, 'holdReason'>): ReviewStatus {
  return row.holdReason ? 'NOT_TOUCHED' : 'REVIEWED';
}

/** Applies initialReviewStatus to every row of a freshly-finalised run. */
export function applyInitialReviewStatus<T extends ReconciliationRow>(rows: T[]): T[] {
  return rows.map(r => ({ ...r, reviewStatus: initialReviewStatus(r) }));
}

/** Cycles the marker: NOT_TOUCHED → PENDING → REVIEWED → NOT_TOUCHED. */
export function nextReviewStatus(s: ReviewStatus): ReviewStatus {
  if (s === 'NOT_TOUCHED') return 'PENDING';
  if (s === 'PENDING') return 'REVIEWED';
  return 'NOT_TOUCHED';
}

/** Ticking the include checkbox (nextChecked === true) always marks the row REVIEWED,
 * regardless of its current status. Unticking never changes the marker — a reviewer who
 * excludes a row hasn't un-reviewed it. */
export function reviewStatusAfterIncludeToggle(current: ReviewStatus, nextChecked: boolean): ReviewStatus {
  if (nextChecked) return 'REVIEWED';
  return current;
}

/** How many of a given row set still need a look: not yet marked REVIEWED.
 * Feeds the "N left" qualifier on the Held for Review / Must Check chips. */
export function countNotReviewed(rows: Pick<ReconciliationRow, 'reviewStatus'>[]): number {
  return rows.filter(r => r.reviewStatus !== 'REVIEWED').length;
}

export function reviewStatusLabel(s: ReviewStatus): string {
  if (s === 'NOT_TOUCHED') return 'Not touched';
  if (s === 'PENDING') return 'Pending';
  return 'Reviewed';
}
