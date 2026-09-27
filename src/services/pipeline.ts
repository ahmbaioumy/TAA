/**
 * Single wiring point for the full reconciliation chain: engine -> unseen-punch audit ->
 * Hold Policy -> initial review status. Moved out of App.tsx (2026-09-24, Hold Policy tab)
 * so App.tsx and scripts/held-breakdown.ts — which used to each re-implement this chain
 * separately — can never drift out of order with each other again.
 *
 * Order matters (design review, plan §Data model):
 *  1. runReconciliation        — the engine itself, untouched.
 *  2. runUnseenPunchAudit      — may re-hold a row the engine released (UNSEEN_PUNCH_OUTCOME);
 *                                 must run BEFORE the policy so its forced re-holds win.
 *  3. applyHoldPolicy          — releases only rows the user has pre-approved; never touches
 *                                 verdict/action/corrections.
 *  4. applyInitialReviewStatus — sets each row's starting reviewStatus LAST, so a hold added
 *                                 by the audit or released by the policy still starts correctly
 *                                 (NOT_TOUCHED either way — this only sets the initial marker).
 *
 * rebuildOutputs (outputRebuild.ts) — used by handleToggleInclude/handleToggleIncludeAll for a
 * reviewer's manual include/exclude edit — NEVER re-applies the policy (see App.tsx's own
 * comment on that rule): a manual toggle after Calculate must not silently re-run Hold Policy.
 *
 * Regression suite / trust matrix call runReconciliation directly (never this function) — the
 * user's Hold Policy must never affect either verification suite (see holdPolicy.ts's own
 * "no pre-flight lock-out" note).
 */
import { runReconciliation, ReconciliationInput, ReconciliationOutput, rowIsMustCheck } from './reconciliationEngine';
import { runUnseenPunchAudit } from './unseenPunchAudit';
import { applyInitialReviewStatus } from './reviewStatus';
import { applyHoldPolicy } from './holdPolicy';
import { rebuildOutputs } from './outputRebuild';

export function runReconciliationWithAudit(input: ReconciliationInput): ReconciliationOutput {
  const base = runReconciliation(input);
  const audited = runUnseenPunchAudit(input, base);
  const policied = applyHoldPolicy(audited, input.config, { rebuildOutputs, rowIsMustCheck });
  return { ...policied, rows: applyInitialReviewStatus(policied.rows) };
}
