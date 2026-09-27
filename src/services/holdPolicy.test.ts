// holdPolicy.test.ts — src/services/holdPolicy.ts (doc/PRD.md §Hold Policy). Headless
// (Node/tsx), synthetic rows only — no engine run needed for most cases (design review
// point 4). The real-week end-to-end proof lives in scripts/held-breakdown.ts's --policy
// flag (npm run test:hold-policy only exercises this module's own contract).
import assert from 'node:assert/strict';
import {
  ACTION_GROUPS,
  applyHoldPolicy,
  cellId,
  classifyHold,
  DEFAULT_HOLD_POLICY,
  fingerprintHoldPolicy,
  holdPolicyLayout,
  isResultStale,
  sanitizeHoldPolicy,
  STAFF_CATEGORIES,
} from './holdPolicy';
import { rebuildOutputs } from './outputRebuild';
import { generateAspectCorrectionsCsv, rowIsMustCheck, ReconciliationOutput } from './reconciliationEngine';
import { FORCED_HOLD_REASONS, HOLD_REASON_TEXT } from './holdReasons';
import { DEFAULT_CONFIG } from './configRegistry';
import {
  AspectCorrectionRow,
  ConfigRegistry,
  HoldReasonCode,
  ReconciliationRow,
  ROLE_TIERS,
  TaaActionCode,
} from '../types/taa';

if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

const HELPERS = { rebuildOutputs, rowIsMustCheck };

// --- Synthetic row factory --------------------------------------------------------------

let rowCounter = 0;
function makeCorrection(segmentCode: string): AspectCorrectionRow {
  return {
    Code: '0', ID: 'EMP1', SegmentCode: segmentCode, nominateDate: '24/09/2026',
    SegmentDate: '24/09/2026', SegmentStarttime: '08:00', Segmentduration: '', Memo: '',
  };
}

function makeRow(overrides: Partial<ReconciliationRow> & { generatedCorrections?: AspectCorrectionRow[] } = {}): ReconciliationRow {
  rowCounter += 1;
  const { generatedCorrections, ...rowOverrides } = overrides;
  const base: ReconciliationRow = {
    id: `rec-test-${rowCounter}`,
    originalCognos: {
      'SIGN IN DATE': '24/09/2026', SECTION: 'TEST', 'PF NO': `EMP${rowCounter}`, NAME: 'Test Employee',
      'LOGIN ID': `login${rowCounter}`, DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '',
      'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '',
      'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    },
    TAA_MARKER: 'DERIVED_ANALYSIS_DO_NOT_REPLACE_OFFICIAL_REPORT',
    TAA_TIER: 'OPS',
    TAA_OT1: '', TAA_OT2: '',
    TAA_SCH_HOURS_RECOMPUTED: 0, TAA_SCH_HOURS_FORMATTED: '0:00',
    TAA_EFFECTIVE_START: '', TAA_EFFECTIVE_END: '', TAA_CMS_IN: '', TAA_CMS_OUT: '',
    TAA_LATE_MIN: 0, TAA_EARLY_MIN: 0,
    TAA_VERDICT: 'Test verdict',
    TAA_ACTION: 'NO_ACTION',
    TAA_ACTIONS_FIRED: 'NO_ACTION',
    TAA_RESULT_CATEGORY: 'NO_ACTION_REQUIRED',
    TAA_COGNOS_AGREE: false,
    TAA_DISAGREE_REASON: '',
    TAA_USERNAME: 'test.user', TAA_SECTION: 'TEST', TAA_SECTION_SOURCE: 'NONE',
    TAA_ASPECT_SECTION: '', TAA_SECTION_MISMATCH: false, TAA_IS_TERMINATED: false,
    columnComparisons: [],
    TAA_MISMATCH_COUNT: 0, TAA_MISMATCH_COLUMNS: '', TAA_FILLED_COLUMNS: '',
    TAA_LEAVE_TYPE_RECOMPUTED: '', TAA_LEAVE_TYPE_STATUS: 'NOT_COMPARABLE', TAA_LEAVE_TYPE_MATCH_BASIS: 'NONE',
    includeInOutput: false,
    includeDecisionSource: 'auto',
    reviewCompleted: false,
    reviewStatus: 'NOT_TOUCHED',
    holdReason: undefined,
    holdReasonText: undefined,
    coverFallbackNote: '',
    details: {
      isFlex: false, isLeaveDay: false, hasOvertime: false, punchCount: 0,
      releaseMinutes: 0, nursingMinutes: 0, otInternalRemovalMinutes: 0, chargedVarianceMinutes: 0,
      aspectSegments: [], punches: [], generatedCorrections: generatedCorrections || [],
      sectionSource: 'NONE', cognosSection: '', aspectIdentitySection: '', sectionMismatch: false,
    },
  };
  return { ...base, ...rowOverrides, details: { ...base.details, ...(rowOverrides.details || {}) } };
}

function makeOutput(rows: ReconciliationRow[]): ReconciliationOutput {
  return {
    rows,
    aspectCorrections: rows.flatMap(r => r.details.generatedCorrections),
    aspectCorrectionsCsv: generateAspectCorrectionsCsv(rows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections)),
    annotatedCognosCsv: '', annotatedCognosTsv: '',
    emailActions: [], emailActionsJson: '[]',
    summary: {
      totalRecords: rows.length, shiftChangedCount: 0, lateCoverCount: 0, markedAbsentCount: 0,
      noActionCount: 0, cognosDataGapCount: 0, disagreementsResolvedCount: 0, overtimeRowsCount: 0,
      flexRowsCount: 0, otConvertedCount: 0, otRlsAdjustedCount: 0,
      heldForReviewCount: rows.filter(r => !!r.holdReason).length,
      mismatchCount: 0, mustCheckCount: rows.filter(rowIsMustCheck).length,
    },
  };
}

function configWithReleased(released: string[]): ConfigRegistry {
  return { ...DEFAULT_CONFIG, holdPolicy: { released } };
}

// --- 1. Default policy is a no-op ---------------------------------------------------------

{
  const held = makeRow({ holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS', TAA_ACTION: 'ABSENT_SEGMENT', TAA_TIER: 'OPS' });
  const output = makeOutput([held]);
  const config = configWithReleased(DEFAULT_HOLD_POLICY.released);
  const result = applyHoldPolicy(output, config, HELPERS);
  assert.equal(result.rows[0].holdReason, 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'default policy { released: [] } must hold every row exactly as input');
  assert.equal(result.rows[0].includeInOutput, false);
  console.log('PASS: default policy is a no-op');
}

// --- 2. Flex MISMATCH_FOUND:SHIFT NO_ACTION release, partial mismatch stays held, OPS stays held ---

{
  const flexShiftOnly = makeRow({
    TAA_TIER: 'FLEX', TAA_ACTION: 'NO_ACTION', holdReason: 'MISMATCH_FOUND',
    columnComparisons: [{ column: 'DUTY1', cognosRaw: '', recomputedRaw: '', status: 'MISMATCH', policyGroup: 'SHIFT' }],
  });
  const flexShiftAndSignIn = makeRow({
    TAA_TIER: 'FLEX', TAA_ACTION: 'NO_ACTION', holdReason: 'MISMATCH_FOUND',
    columnComparisons: [
      { column: 'DUTY1', cognosRaw: '', recomputedRaw: '', status: 'MISMATCH', policyGroup: 'SHIFT' },
      { column: 'SIGIN IN', cognosRaw: '', recomputedRaw: '', status: 'MISMATCH', policyGroup: 'SIGN_IN' },
    ],
  });
  const opsShiftOnly = makeRow({
    TAA_TIER: 'OPS', TAA_ACTION: 'NO_ACTION', holdReason: 'MISMATCH_FOUND',
    columnComparisons: [{ column: 'DUTY1', cognosRaw: '', recomputedRaw: '', status: 'MISMATCH', policyGroup: 'SHIFT' }],
  });
  const config = configWithReleased([cellId('FLEX', 'MISMATCH_FOUND:SHIFT', 'NO_ACTION')]);
  const output = makeOutput([flexShiftOnly, flexShiftAndSignIn, opsShiftOnly]);
  const result = applyHoldPolicy(output, config, HELPERS);
  assert.equal(result.rows[0].holdReason, undefined, 'flex shift-only mismatch row must release');
  assert.equal(result.rows[0].includeDecisionSource, 'policy');
  assert.equal(result.rows[1].holdReason, 'MISMATCH_FOUND', 'flex row with SHIFT + SIGN_IN mismatch must stay held (SIGN_IN group not released)');
  assert.equal(result.rows[2].holdReason, 'MISMATCH_FOUND', 'OPS row with the same shape must stay held (category not released)');
  console.log('PASS: Flex MISMATCH_FOUND:SHIFT|NO_ACTION release is column-group- and category-scoped');
}

// --- 3. Locked/forced reason id in released list -> still held (classifyHold ignores it) ---

{
  const row = makeRow({ TAA_TIER: 'OPS', TAA_ACTION: 'NO_ACTION', holdReason: 'MISSING_CMS_JOIN_KEY' });
  assert.ok(FORCED_HOLD_REASONS.has('MISSING_CMS_JOIN_KEY'), 'test assumption: MISSING_CMS_JOIN_KEY is forced');
  const config = configWithReleased([cellId('OPS', 'MISSING_CMS_JOIN_KEY', 'NO_ACTION')]);
  const result = applyHoldPolicy(makeOutput([row]), config, HELPERS);
  assert.equal(result.rows[0].holdReason, 'MISSING_CMS_JOIN_KEY', 'a forced/evidence reason must stay held even with a matching released id (tampered import)');
  assert.equal(classifyHold(row), 'LOCKED');
  console.log('PASS: forced/evidence reason ignores a tampered released id');
}

// --- 4. MANUAL_REVIEW_REQUIRED action -> always held ---------------------------------------

{
  const row = makeRow({ TAA_TIER: 'OPS', TAA_ACTION: 'MANUAL_REVIEW_REQUIRED', holdReason: 'COGNOS_DATA_GAP' });
  const config = configWithReleased([cellId('OPS', 'COGNOS_DATA_GAP', 'NO_ACTION')]);
  const result = applyHoldPolicy(makeOutput([row]), config, HELPERS);
  assert.equal(result.rows[0].holdReason, 'COGNOS_DATA_GAP', 'MANUAL_REVIEW_REQUIRED action rows must never release');
  console.log('PASS: MANUAL_REVIEW_REQUIRED action is always held');
}

// --- 5. UNSEEN_PUNCH_OUTCOME (audit-only AuditHoldReasonCode) -> always held ----------------

{
  const row = makeRow({ TAA_TIER: 'OPS', TAA_ACTION: 'NO_ACTION', holdReason: 'UNSEEN_PUNCH_OUTCOME' as any });
  const config = configWithReleased([cellId('OPS', 'UNSEEN_PUNCH_OUTCOME', 'NO_ACTION')]);
  const result = applyHoldPolicy(makeOutput([row]), config, HELPERS);
  assert.equal(result.rows[0].holdReason, 'UNSEEN_PUNCH_OUTCOME', 'UNSEEN_PUNCH_OUTCOME must stay held regardless of policy');
  console.log('PASS: UNSEEN_PUNCH_OUTCOME (unseen-punch audit) is always held');
}

// --- 6. Released rows: verdict/action/corrections identical; CSV now includes the correction ---

{
  const row = makeRow({
    TAA_TIER: 'OPS', TAA_ACTION: 'ABSENT_SEGMENT', holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS',
    TAA_VERDICT: 'Absent NS/NC', TAA_ACTIONS_FIRED: 'ABSENT_SEGMENT',
    generatedCorrections: [makeCorrection('ABSENT')],
  } as any);
  const config = configWithReleased([cellId('OPS', 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'ABSENT')]);
  const before = makeOutput([row]);
  const result = applyHoldPolicy(before, config, HELPERS);
  const releasedRow = result.rows[0];
  assert.equal(releasedRow.holdReason, undefined);
  assert.equal(releasedRow.TAA_VERDICT, row.TAA_VERDICT, 'verdict must be untouched by release');
  assert.equal(releasedRow.TAA_ACTION, row.TAA_ACTION, 'action must be untouched by release');
  assert.deepEqual(releasedRow.details.generatedCorrections, row.details.generatedCorrections, 'corrections must be untouched by release');
  assert.ok(result.aspectCorrectionsCsv.includes('ABSENT'), 'ASPECT correction CSV must now include the released row\'s correction');
  assert.ok(!before.aspectCorrectionsCsv.includes('ABSENT'), 'sanity: the correction was NOT in the CSV before release');
  assert.deepEqual(releasedRow.details.holdPolicyRelease, {
    reason: 'MIXED_LEAVE_AND_WORK_SEGMENTS', category: 'OPS', actionGroup: 'ABSENT', columnGroups: ['MIXED_LEAVE_AND_WORK_SEGMENTS'],
  });
  console.log('PASS: released row keeps verdict/action/corrections; CSV now includes it');
}

// --- 7. sanitizeHoldPolicy structural checks ------------------------------------------------

{
  const sanitized = sanitizeHoldPolicy({
    released: [
      cellId('OPS', 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'ABSENT'),
      cellId('OPS', 'MISSING_CMS_JOIN_KEY', 'NO_ACTION'), // locked
      cellId('FLEX', 'MANUAL_REVIEW_REQUIRED', 'NO_ACTION'), // locked
      'bad-id',
      42,
    ],
  });
  assert.deepEqual(sanitized.released, [cellId('OPS', 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'ABSENT')]);
  assert.deepEqual(sanitizeHoldPolicy(null).released, []);
  assert.deepEqual(sanitizeHoldPolicy(undefined).released, []);
  console.log('PASS: sanitizeHoldPolicy strips locked/malformed ids');
}

// --- 8. Stale logic ---------------------------------------------------------------------

{
  const held = makeRow({ TAA_TIER: 'OPS', TAA_ACTION: 'ABSENT_SEGMENT', holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS' });
  const policyA = { released: [cellId('OPS', 'MIXED_LEAVE_AND_WORK_SEGMENTS', 'ABSENT')] };
  const policyB = { released: [] as string[] };
  const config = { ...DEFAULT_CONFIG, holdPolicy: policyA };
  const ran = applyHoldPolicy(makeOutput([held]), config, HELPERS);
  assert.equal(ran.holdPolicyFingerprint, fingerprintHoldPolicy(policyA));
  assert.equal(isResultStale(ran, policyA), false, 'fingerprint equal -> not stale');
  assert.equal(isResultStale(ran, policyB), true, 'a different saved policy after the run -> stale');
  assert.equal(isResultStale(ran, policyA), false, 'reverting back to the used policy -> not stale again');
  const recalculated = applyHoldPolicy(makeOutput([held]), { ...DEFAULT_CONFIG, holdPolicy: policyB }, HELPERS);
  assert.equal(recalculated.holdPolicyFingerprint, fingerprintHoldPolicy(policyB));
  assert.equal(isResultStale(recalculated, policyB), false, 're-calculating with the new policy -> not stale, carries the new fingerprint');
  console.log('PASS: stale-result fingerprint logic');
}

// --- 9. Registry covers every HoldReasonCode (runtime + the Record<...> compile guard) ------

{
  const layout = holdPolicyLayout();
  const rowReasonKeys = new Set(layout.rows.map(r => r.ruleKey));
  const lockedReasonKeys = new Set(layout.locked.map(l => l.reason));
  for (const code of Object.keys(HOLD_REASON_TEXT) as HoldReasonCode[]) {
    if (code === 'MISMATCH_FOUND') {
      assert.ok([...rowReasonKeys].some(k => String(k).startsWith('MISMATCH_FOUND:')), 'MISMATCH_FOUND must appear as column-group rows');
      continue;
    }
    const inRows = rowReasonKeys.has(code);
    const inLocked = lockedReasonKeys.has(code);
    assert.ok(inRows || inLocked, `HoldReasonCode '${code}' has no Hold Policy tab row or locked entry — see src/services/holdPolicy.ts (holdPolicyLayout)`);
  }
  console.log('PASS: every HoldReasonCode renders in the Hold Policy tab (row or locked)');
}

// --- 10. RoleTier exhaustiveness (runtime-checkable proof — see the "fake RoleTier" step) ---

{
  const layout = holdPolicyLayout();
  for (const tier of ROLE_TIERS) {
    const tab = layout.tabs.find(t => t.category === tier);
    assert.ok(
      tab && typeof tab.label === 'string' && tab.label.length > 0,
      `New RoleTier '${tier}' has no Hold Policy tab — see src/services/holdPolicy.ts (STAFF_CATEGORIES / CATEGORY_LABELS)`,
    );
  }
  assert.equal(STAFF_CATEGORIES.length, ROLE_TIERS.length + 1, 'STAFF_CATEGORIES must be every RoleTier plus FLEX, nothing hand-maintained');
  console.log('PASS: every ROLE_TIERS value has a Hold Policy tab');
}

// --- 11. ActionGroup columns cover every TaaActionCode's group (compile-enforced by
//         ACTION_POLICY_GROUP: Record<TaaActionCode, ...> in holdPolicy.ts) ------------------

{
  const codes: TaaActionCode[] = [
    'NO_ACTION', 'LATE_AND_COVER', 'ABSENT_SEGMENT', 'ABSENT_NS_NC', 'LOGOFF_AND_COVER',
    'ADJUST_OT_RLS', 'OT_TO_SHIFT', 'SHIFT_UPDATE_FLEX', 'SHIFT_UPDATE_AND_LATE_COVER_FLEX', 'MANUAL_REVIEW_REQUIRED',
  ];
  for (const code of codes) {
    const row = makeRow({ TAA_TIER: 'OPS', TAA_ACTION: code, holdReason: 'MIXED_LEAVE_AND_WORK_SEGMENTS' });
    const cell = classifyHold(row);
    if (code === 'MANUAL_REVIEW_REQUIRED') {
      assert.equal(cell, 'LOCKED');
    } else {
      assert.ok(cell && cell !== 'LOCKED' && ACTION_GROUPS.includes(cell.actionGroup), `TaaActionCode '${code}' has no Hold Policy action-group column — see holdPolicy.ts's ACTION_POLICY_GROUP`);
    }
  }
  console.log('PASS: every TaaActionCode maps to a known Hold Policy action-group column');
}

// --- 12. MULTI_DAY_CMS_SESSION (2026-09-27) is locked: listed under Locked, never a policy row,
// and a row carrying it stays held even with EVERY cell of every tab released (tampered import).

{
  const layout = holdPolicyLayout();
  assert.ok(layout.locked.some(l => l.reason === 'MULTI_DAY_CMS_SESSION'), 'MULTI_DAY_CMS_SESSION must render in the Locked list');
  assert.ok(!layout.rows.some(r => r.ruleKey === 'MULTI_DAY_CMS_SESSION'), 'MULTI_DAY_CMS_SESSION must never be a releasable policy row');
  const everyCell = STAFF_CATEGORIES.flatMap(c => ACTION_GROUPS.map(g => cellId(c, 'MULTI_DAY_CMS_SESSION', g)));
  for (const TAA_ACTION of ['MANUAL_REVIEW_REQUIRED', 'NO_ACTION'] as TaaActionCode[]) {
    const row = makeRow({ TAA_TIER: 'OPS', TAA_ACTION, holdReason: 'MULTI_DAY_CMS_SESSION' });
    assert.equal(classifyHold(row), 'LOCKED');
    const result = applyHoldPolicy(makeOutput([row]), configWithReleased(everyCell), HELPERS);
    assert.equal(result.rows[0].holdReason, 'MULTI_DAY_CMS_SESSION', `MULTI_DAY_CMS_SESSION (${TAA_ACTION}) must stay held with every cell released`);
  }
  assert.deepEqual(sanitizeHoldPolicy({ released: everyCell }), { released: [] }, 'sanitizeHoldPolicy strips every MULTI_DAY_CMS_SESSION id');
  console.log('PASS: MULTI_DAY_CMS_SESSION is locked in the Hold Policy tab and cannot be released');
}

console.log('Hold Policy tests passed.');
