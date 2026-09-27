/**
 * Hold Policy (doc/PRD.md §Hold Policy) — the single module the Hold Policy tab and
 * applyHoldPolicy both read. classifyHold is THE single classifier (category, actionGroup,
 * ruleKeys[]) used by both the UI's "N rows last run" counts and the actual release pass,
 * so the two can never disagree about which rows a given tick releases.
 *
 * Everything except the exports below is private to this file:
 *  - classifyHold(row)        -> HoldCell | 'LOCKED' | null (null = row isn't held)
 *  - applyHoldPolicy(output, config) -> pure ReconciliationOutput
 *  - holdPolicyLayout()       -> data the UI renders, nothing else
 *  - sanitizeHoldPolicy(raw)  -> HoldPolicy
 *  - isResultStale(output, policy) -> boolean
 *
 * Only ever TYPE-imports reconciliationEngine.ts (erased at compile time, so it cannot form a
 * runtime configRegistry.ts -> holdPolicy.ts -> reconciliationEngine.ts -> configRegistry.ts
 * cycle even though configRegistry.ts's importConfigFromJson calls sanitizeHoldPolicy from
 * here). HOLD_REASON_TEXT and FORCED_HOLD_REASONS both live in holdReasons.ts (a leaf module,
 * no engine/config dependency) for the same reason — classifyHold/holdPolicyLayout never need
 * a real value import from the engine.
 */
import {
  ConfigRegistry,
  HoldPolicy,
  HoldReasonCode,
  PolicyGroup,
  ReconciliationRow,
  RoleTier,
  ROLE_TIERS,
  TaaActionCode,
} from '../types/taa';
import type { ReconciliationOutput } from './reconciliationEngine';
import { FORCED_HOLD_REASONS, HOLD_REASON_TEXT, isForcedHoldReason } from './holdReasons';

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

/** Hold Policy tab category — every RoleTier plus FLEX (row.TAA_TIER already folds
 * isFlex ahead of tier; FLEX always overrides OPS/OFFICER_PLUS). */
export type StaffCategory = RoleTier | 'FLEX';
export const STAFF_CATEGORIES: readonly StaffCategory[] = [...ROLE_TIERS, 'FLEX'];

/** The 6 action groups the Hold Policy tab's columns are built from. Adding a new
 * TaaActionCode? Wire it into ACTION_POLICY_GROUP below (compile error if you don't). */
export type ActionGroup = 'NO_ACTION' | 'LATE_COVER' | 'LOGOFF_COVER' | 'ABSENT' | 'SHIFT_UPDATE' | 'OT';
export const ACTION_GROUPS: readonly ActionGroup[] = ['NO_ACTION', 'LATE_COVER', 'LOGOFF_COVER', 'ABSENT', 'SHIFT_UPDATE', 'OT'];

/** Action groups whose released rows send ASPECT corrections (the `$` marker in the UI —
 * pay-affecting cells behave exactly like No action: no confirm dialog, see plan decision
 * 2026-09-24). NO_ACTION never sends a correction by definition. */
export const PAY_AFFECTING_ACTION_GROUPS: ReadonlySet<ActionGroup> = new Set(['LATE_COVER', 'LOGOFF_COVER', 'ABSENT', 'SHIFT_UPDATE', 'OT']);

// Adding a value to TaaActionCode? This map must cover it (compile error otherwise) — see
// the comment at TaaActionCode in src/types/taa.ts.
const ACTION_POLICY_GROUP: Record<TaaActionCode, ActionGroup | 'OTHER'> = {
  NO_ACTION: 'NO_ACTION',
  LATE_AND_COVER: 'LATE_COVER',
  LOGOFF_AND_COVER: 'LOGOFF_COVER',
  ABSENT_SEGMENT: 'ABSENT',
  ABSENT_NS_NC: 'ABSENT',
  ADJUST_OT_RLS: 'OT',
  OT_TO_SHIFT: 'OT',
  SHIFT_UPDATE_FLEX: 'SHIFT_UPDATE',
  SHIFT_UPDATE_AND_LATE_COVER_FLEX: 'SHIFT_UPDATE',
  // Never a column — always held regardless of policy (see classifyHold's LOCKED check).
  MANUAL_REVIEW_REQUIRED: 'OTHER',
};

/** MISMATCH_FOUND is split into column-group RuleKeys instead of one row (design review,
 * plan §Data model). A mismatching column whose ColumnComparison.policyGroup is 'OTHER'
 * (an unmapped/future compared column) folds into MISMATCH_FOUND:OTHER, an auto "Other
 * column" row (Future-proofing table) — never silently dropped from the tab. */
export type MismatchRuleKey = `MISMATCH_FOUND:${PolicyGroup | 'NO_COLUMN'}`;
export type RuleKey = HoldReasonCode | MismatchRuleKey;

export interface HoldCell {
  category: StaffCategory;
  actionGroup: ActionGroup;
  /** RuleKey(s) this held row needs released to be released. A MISMATCH_FOUND row lists
   * one entry per distinct mismatching column group; every other reason lists exactly one
   * (its own HoldReasonCode). ALL must be released (every ruleKey ticked off) for the row
   * to release — "a row stays held if another column also disagrees" (mock UI copy). */
  ruleKeys: RuleKey[];
}

// ---------------------------------------------------------------------------------------
// Cell id <-> fingerprint
// ---------------------------------------------------------------------------------------

/** `"<StaffCategory>|<RuleKey>|<ActionGroup>"` — the one id shape used everywhere
 * (HoldPolicy.released, the UI's checkbox `data-` attributes, the fingerprint). */
export function cellId(category: StaffCategory, ruleKey: string, actionGroup: ActionGroup): string {
  return `${category}|${ruleKey}|${actionGroup}`;
}

export function parseCellId(id: string): { category: string; ruleKey: string; actionGroup: string } | null {
  const parts = id.split('|');
  if (parts.length !== 3) return null;
  const [category, ruleKey, actionGroup] = parts;
  return { category, ruleKey, actionGroup };
}

/** Deterministic fingerprint of a HoldPolicy — sorted, de-duplicated, JSON-joined released
 * ids. Two policies with the same released set (any order/duplicates) fingerprint equal. */
export function fingerprintHoldPolicy(policy: HoldPolicy): string {
  return JSON.stringify([...new Set(policy.released)].sort());
}

// ---------------------------------------------------------------------------------------
// sanitizeHoldPolicy
// ---------------------------------------------------------------------------------------

export const DEFAULT_HOLD_POLICY: HoldPolicy = { released: [] };

const VALID_ACTION_GROUPS = new Set<string>(ACTION_GROUPS);
const VALID_CATEGORIES = new Set<string>(STAFF_CATEGORIES);

/** Is `ruleKey` (a bare HoldReasonCode, or a MISMATCH_FOUND:<group> key) locked — pointing
 * at a forced/evidence reason, or at MANUAL_REVIEW_REQUIRED (never a column, always held)?
 * MISMATCH_FOUND:<group> keys are never locked (MISMATCH_FOUND itself is not in
 * FORCED_HOLD_REASONS — every one of its column groups is a business judgement call). */
function isLockedRuleKey(ruleKey: string): boolean {
  if (ruleKey.startsWith('MISMATCH_FOUND:')) return false;
  if (ruleKey === 'MANUAL_REVIEW_REQUIRED') return true;
  return isForcedHoldReason(ruleKey as HoldReasonCode);
}

/**
 * Filters a raw (possibly tampered, possibly from an older export) HoldPolicy down to ids
 * that are structurally valid AND not locked. Unknown-but-well-formed ids (e.g. a reason
 * that has since been removed) are left in place, "kept harmless" per the Future-proofing
 * table — they simply never match any row classifyHold produces.
 */
export function sanitizeHoldPolicy(raw: unknown): HoldPolicy {
  const releasedRaw = raw && typeof raw === 'object' && Array.isArray((raw as { released?: unknown }).released)
    ? (raw as { released: unknown[] }).released
    : [];
  const released = releasedRaw
    .filter((id): id is string => typeof id === 'string')
    .filter(id => {
      const parsed = parseCellId(id);
      if (!parsed) return false;
      if (!VALID_CATEGORIES.has(parsed.category)) return false;
      if (!VALID_ACTION_GROUPS.has(parsed.actionGroup)) return false;
      if (isLockedRuleKey(parsed.ruleKey)) return false;
      return true;
    });
  return { released: [...new Set(released)] };
}

// ---------------------------------------------------------------------------------------
// classifyHold — THE single classifier
// ---------------------------------------------------------------------------------------

/**
 * Classifies a row's held state for the Hold Policy tab:
 *  - null    -> row isn't held (holdReason falsy) — not a Hold Policy concern at all.
 *  - 'LOCKED' -> forced/evidence hold or MANUAL_REVIEW_REQUIRED — never releasable by policy.
 *  - HoldCell -> category/actionGroup/ruleKeys a policy tick can release.
 */
export function classifyHold(row: ReconciliationRow): HoldCell | 'LOCKED' | null {
  if (!row.holdReason) return null;
  if (isForcedHoldReason(row.holdReason) || row.TAA_ACTION === 'MANUAL_REVIEW_REQUIRED') return 'LOCKED';

  const category: StaffCategory = row.TAA_TIER; // 'OPS' | 'OFFICER_PLUS' | 'FLEX' — already folded
  const actionGroup = ACTION_POLICY_GROUP[row.TAA_ACTION];
  if (actionGroup === 'OTHER') return 'LOCKED'; // no column for this action — never releasable

  let ruleKeys: RuleKey[];
  if (row.holdReason === 'MISMATCH_FOUND') {
    const groups = new Set<PolicyGroup>();
    for (const c of row.columnComparisons) {
      if (c.status === 'MISMATCH') groups.add(c.policyGroup ?? 'OTHER');
    }
    ruleKeys = groups.size > 0
      ? [...groups].map((g): MismatchRuleKey => `MISMATCH_FOUND:${g}`)
      : ['MISMATCH_FOUND:NO_COLUMN'];
  } else {
    // UNSEEN_PUNCH_OUTCOME (AuditHoldReasonCode) is forced (isForcedHoldReason handles it
    // above) so never reaches here; every other value is a real HoldReasonCode.
    ruleKeys = [row.holdReason as HoldReasonCode];
  }

  return { category, actionGroup, ruleKeys };
}

// ---------------------------------------------------------------------------------------
// applyHoldPolicy
// ---------------------------------------------------------------------------------------

/**
 * Pure: releases a held row only if EVERY ruleKey classifyHold(row) reports is in
 * policy.released for that row's (category, actionGroup). Never touches verdict/action/
 * corrections — only holdReason/holdReasonText/includeInOutput/includeDecisionSource and
 * details.holdPolicyRelease. Rebuilds the 4 downstream exports + summary counts via
 * outputRebuild.ts / rowIsMustCheck ONLY when at least one row actually released (no-op
 * fast path when policy.released is empty or nothing in it matches this run).
 */
export interface ApplyHoldPolicyDeps {
  /** outputRebuild.ts's rebuildOutputs — injected rather than value-imported so this file
   * (and configRegistry.ts's import of sanitizeHoldPolicy from it) can never form a runtime
   * configRegistry.ts -> holdPolicy.ts -> outputRebuild.ts -> reconciliationEngine.ts ->
   * configRegistry.ts import cycle. pipeline.ts wires the real functions in. */
  rebuildOutputs: (
    rows: ReconciliationRow[],
    emailActions: ReconciliationOutput['emailActions'],
    config: ConfigRegistry,
    verificationAudit: ReconciliationOutput['verificationAudit'],
  ) => {
    aspectCorrections: ReconciliationOutput['aspectCorrections'];
    aspectCorrectionsCsv: string;
    emailActionsJson: string;
    annotatedCognosCsv: string;
    annotatedCognosTsv: string;
  };
  /** reconciliationEngine.ts's rowIsMustCheck, same reason. */
  rowIsMustCheck: (row: ReconciliationRow) => boolean;
}

export function applyHoldPolicy(
  output: ReconciliationOutput,
  config: ConfigRegistry,
  deps: ApplyHoldPolicyDeps,
): ReconciliationOutput {
  const policy = config.holdPolicy || DEFAULT_HOLD_POLICY;
  const releasedSet = new Set(policy.released);
  const fingerprint = fingerprintHoldPolicy(policy);

  let anyReleased = false;
  const rows = output.rows.map((row): ReconciliationRow => {
    const cell = classifyHold(row);
    if (cell === null || cell === 'LOCKED') return row;
    const allReleased = cell.ruleKeys.every(k => releasedSet.has(cellId(cell.category, k, cell.actionGroup)));
    if (!allReleased) return row;
    anyReleased = true;
    const priorReason = row.holdReason as string;
    return {
      ...row,
      holdReason: undefined,
      holdReasonText: undefined,
      includeInOutput: true,
      includeDecisionSource: 'policy',
      details: {
        ...row.details,
        holdPolicyRelease: {
          reason: priorReason,
          category: cell.category,
          actionGroup: cell.actionGroup,
          columnGroups: cell.ruleKeys,
        },
      },
    };
  });

  if (!anyReleased) {
    return { ...output, rows, holdPolicyFingerprint: fingerprint };
  }

  const rebuilt = deps.rebuildOutputs(rows, output.emailActions, config, output.verificationAudit);
  const heldForReviewCount = rows.filter(r => !!r.holdReason).length;
  const mustCheckCount = rows.filter(deps.rowIsMustCheck).length;

  return {
    ...output,
    rows,
    aspectCorrections: rebuilt.aspectCorrections,
    aspectCorrectionsCsv: rebuilt.aspectCorrectionsCsv,
    emailActionsJson: rebuilt.emailActionsJson,
    annotatedCognosCsv: rebuilt.annotatedCognosCsv,
    annotatedCognosTsv: rebuilt.annotatedCognosTsv,
    summary: { ...output.summary, heldForReviewCount, mustCheckCount },
    holdPolicyFingerprint: fingerprint,
  };
}

/** True when `policy` (the currently saved policy) differs from the one actually applied
 * to produce `output` — i.e. results/exports are stale and need Re-calculate. An output
 * that never went through applyHoldPolicy (holdPolicyFingerprint undefined) is treated as
 * stale against any non-empty policy, and NOT stale against the all-hold default — matches
 * "edited BEFORE calculating -> next Calculate simply applies it" (plan §UI). */
export function isResultStale(output: { holdPolicyFingerprint?: string } | null | undefined, policy: HoldPolicy): boolean {
  const used = output?.holdPolicyFingerprint;
  const current = fingerprintHoldPolicy(policy);
  if (used === undefined) return current !== fingerprintHoldPolicy(DEFAULT_HOLD_POLICY);
  return used !== current;
}

// ---------------------------------------------------------------------------------------
// holdPolicyLayout — everything the UI renders, nothing else
// ---------------------------------------------------------------------------------------

export interface HoldPolicyActionColumn {
  action: ActionGroup;
  label: string;
  payAffecting: boolean;
}

export interface HoldPolicyRow {
  ruleKey: RuleKey;
  label: string;
  description: string;
  group: string; // display group heading, e.g. "Cognos mismatch" / "Schedule judgement"
}

export interface HoldPolicyLockedRow {
  reason: string;
  description: string;
}

export interface HoldPolicyLayout {
  tabs: { category: StaffCategory; label: string }[];
  columns: HoldPolicyActionColumn[];
  rows: HoldPolicyRow[];
  locked: HoldPolicyLockedRow[];
}

const CATEGORY_LABELS: Record<StaffCategory, string> = { OPS: 'OPS', OFFICER_PLUS: 'Officer+', FLEX: 'Flex' };
const ACTION_LABELS: Record<ActionGroup, string> = {
  NO_ACTION: 'No action',
  LATE_COVER: 'Late + cover',
  LOGOFF_COVER: 'Log-off + cover',
  ABSENT: 'Absent',
  SHIFT_UPDATE: 'Shift update',
  OT: 'OT',
};

/** Short label for a Cognos-mismatch column-group RuleKey. */
const MISMATCH_GROUP_LABEL: Record<PolicyGroup | 'NO_COLUMN', string> = {
  SHIFT: 'Shift',
  LATE_EARLY: 'Late / early',
  SCHEDULE: 'Scheduled hours',
  SIGN_IN: 'Sign-in',
  LEAVE: 'Leave',
  NO_COLUMN: 'Cognos flag only',
  OTHER: 'Other column',
};
const MISMATCH_GROUP_DESCRIPTION: Record<PolicyGroup | 'NO_COLUMN', string> = {
  SHIFT: 'DUTY1 / DUTY-2: Cognos roster differs from the ASPECT shift (late/early gaps equal to the move are included)',
  LATE_EARLY: 'LATE START / LEFT EARLY minutes differ, not explained by a shift move',
  SCHEDULE: 'SCH DURATION / OT1 / OT-2: cover, release or OT counted differently',
  SIGN_IN: 'SIGNIN DURATION / SIGN IN / SIGN OUT differ from CMS',
  LEAVE: 'LEAVE TYPE / LEAVE HR differ from ASPECT',
  NO_COLUMN: 'Known Cognos issue flagged without a disagreeing column',
  OTHER: 'A newly compared Cognos column not yet grouped — treated as its own row until mapped',
};

/** Non-mismatch reasons shown under the "Schedule judgement" heading (releasable, not
 * forced) — every other non-locked HoldReasonCode falls back to "Other" so a brand-new
 * reason still renders instead of disappearing. */
const SCHEDULE_JUDGEMENT_REASONS: HoldReasonCode[] = [
  'MIXED_LEAVE_AND_WORK_SEGMENTS',
  'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY',
  'PUBLIC_HOLIDAY_SHIFT_MISCODED',
  'TECHNICAL_SEGMENT_COVERS_VARIANCE',
  'AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS',
  'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS',
];

/** Plain-language short label per HoldReasonCode — falls back to the bare code so a new
 * reason still renders even before anyone adds a friendly label here. */
const HOLD_REASON_SHORT_LABEL: Partial<Record<HoldReasonCode, string>> = {
  MIXED_LEAVE_AND_WORK_SEGMENTS: 'Leave + work same day',
  FULL_DAY_REMOVAL_ON_SCHEDULED_DAY: 'Full-day removal',
  PUBLIC_HOLIDAY_SHIFT_MISCODED: 'P/H shift mis-coded',
  TECHNICAL_SEGMENT_COVERS_VARIANCE: 'Technical time',
  AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS: 'Overlapping additions',
  DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS: 'Repaired duration',
};

const MISMATCH_GROUP_ORDER: (PolicyGroup | 'NO_COLUMN')[] = ['SHIFT', 'LATE_EARLY', 'SCHEDULE', 'SIGN_IN', 'LEAVE', 'NO_COLUMN', 'OTHER'];

/** Builds the layout the Hold Policy tab renders — rows/columns/tabs/locked list — derived
 * from ROLE_TIERS, HOLD_REASON_TEXT and ACTION_POLICY_GROUP, never hand-maintained (see
 * doc/PRD.md §Hold Policy's Future-proofing table). */
export function holdPolicyLayout(): HoldPolicyLayout {
  const tabs = STAFF_CATEGORIES.map(category => ({ category, label: CATEGORY_LABELS[category] }));
  const columns: HoldPolicyActionColumn[] = ACTION_GROUPS.map(action => ({
    action,
    label: ACTION_LABELS[action],
    payAffecting: PAY_AFFECTING_ACTION_GROUPS.has(action),
  }));

  const rows: HoldPolicyRow[] = [];
  for (const group of MISMATCH_GROUP_ORDER) {
    rows.push({
      ruleKey: `MISMATCH_FOUND:${group}`,
      label: MISMATCH_GROUP_LABEL[group],
      description: MISMATCH_GROUP_DESCRIPTION[group],
      group: 'Cognos mismatch',
    });
  }
  for (const reasonCode of Object.keys(HOLD_REASON_TEXT) as HoldReasonCode[]) {
    if (reasonCode === 'MISMATCH_FOUND') continue; // handled above as column groups
    if (isForcedHoldReason(reasonCode)) continue; // rendered in `locked` instead
    const known = SCHEDULE_JUDGEMENT_REASONS.includes(reasonCode);
    rows.push({
      ruleKey: reasonCode,
      label: HOLD_REASON_SHORT_LABEL[reasonCode] || reasonCode,
      description: HOLD_REASON_TEXT[reasonCode],
      group: known ? 'Schedule judgement' : 'Other',
    });
  }

  const locked: HoldPolicyLockedRow[] = [
    ...Object.keys(HOLD_REASON_TEXT)
      .filter((code): code is HoldReasonCode => isForcedHoldReason(code as HoldReasonCode))
      .map(code => ({ reason: code, description: HOLD_REASON_TEXT[code] })),
    { reason: 'UNSEEN_PUNCH_OUTCOME', description: 'A login just outside the search window would change the result — see the unseen-punch audit.' },
    { reason: 'MANUAL_REVIEW_REQUIRED', description: 'Any row whose action is manual review — never a Hold Policy column.' },
  ];

  return { tabs, columns, rows, locked };
}

// Re-export for FORCED_HOLD_REASONS-aware callers that only need the set, not this whole module.
export { FORCED_HOLD_REASONS };
