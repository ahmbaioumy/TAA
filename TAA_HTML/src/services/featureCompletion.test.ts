import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG, normalizeSectionMailboxMap, importConfigFromJson } from './configRegistry';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  applyEmailTemplate,
  buildIndividualOverride,
  computeEmailStatusByRowId,
  findSectionMailbox,
  normalizeEmailTemplates,
  planEmailDraftActions,
  poolEmailOpsActionsBySection,
  renderOpsDigestTable,
  shortenFindingLabel,
} from './emailDrafts';
import { buildResultsWorkbookSheets, describeDisagreement, generateAnnotatedCognosFile, generateAspectCorrectionsCsv, generateEmailActionsJson, runReconciliation, LATE_COVER_SEGMENT_CODES } from './reconciliationEngine';
import { isForcedHoldReason, FORCED_HOLD_REASONS } from './holdReasons';
import { SUITE_RUN_DATE } from './regressionSuite';
import { getSampleAspectIdentities, getSampleAspectSegments, getSampleCmsPunches, getSampleCognosRecords } from './sampleData';
import {
  decodeFileBuffer,
  parseCognosReport,
  parseAspectSegments,
  parseAspectIdentity,
  validateCmsFile,
  dedupeCmsPunches,
} from './parsers';
import { ConfigRegistry, EmailActionItem, HoldReasonCode, ReconciliationRow, ReviewStatus, VerificationOverrideAudit } from '../types/taa';
import { resolveSamplesDir, listCmsFiles, findCognosFile, samplesAvailable } from '../../scripts/sampleFiles';
import { nextReviewStatus, reviewStatusAfterIncludeToggle, initialReviewStatus, applyInitialReviewStatus, countNotReviewed, reviewStatusLabel } from './reviewStatus';
import {
  VERIFICATION_OVERRIDE_PHRASE,
  isVerificationOverrideValid,
  serializeVerificationOverrideAudit,
} from './verificationAudit';

const action: EmailActionItem = {
  row_id: 'rec-1-4500001',
  base_row_id: 'rec-1-4500001',
  template_key: 'late_login_absence',
  emp_id: '4500001',
  name: 'Test User',
  nominate_date: '06/09/2026',
  role_tier: 'OPS',
  category: 'Late Login',
  variance_minutes: 61,
  taa_action: 'ABSENT_SEGMENT',
  communication_rule: 'EMAIL_STAFF_CC_MANAGER',
  extra_2_alias: 'test.user',
  email_adr: 'test.user@example.test',
  resolved_username: 'test.user',
  login_id: '12345',
  section: 'TEST',
  subject: '',
  body: '',
  to: 'test.user@thecontactcentre.ae',
};

// generic carries its own case-detail placeholders (sourced from the engine's
// row-level extras, not EmailActionItem fields) — a NO_ACTION_REQUIRED row's
// finding/taa_action are legitimately blank, so this fills in what the engine
// would actually supply (see reconciliationEngine.ts's applyEmailTemplate call).
const genericCaseDetailExtras = {
  sch_hours: '8:00', effective_start: '07:00', effective_end: '15:00',
  cms_in: '07:02', cms_out: '15:05', late_min: '0', early_min: '0',
  verdict: 'PRESENT', result_category: 'NO_ACTION_REQUIRED', actions_fired: 'None',
};

for (const key of EMAIL_TEMPLATE_KEYS) {
  // ops_digest describes a whole pooled group, not one case — it needs the
  // extras poolEmailOpsActionsBySection supplies (count, case_table), which
  // a plain per-case action never carries.
  const extras = key === 'ops_digest' ? { count: '1', case_table: 'Name | Emp ID\nTest User | 4500001' }
    : key === 'generic' ? genericCaseDetailExtras
    : undefined;
  const rendered = applyEmailTemplate({ ...action, template_key: key }, DEFAULT_EMAIL_TEMPLATES, extras);
  assert.ok(rendered.subject.length > 0, `${key} subject should render`);
  assert.ok(rendered.body.length > 0, `${key} body should render`);
  assert.deepEqual(rendered.template_warnings, [], `${key} should resolve every default placeholder`);
}

// The generic template must actually show the ad-hoc case detail, not just
// resolve without warnings — this is what makes a no-action-required row's
// draft useful once a human decides to send it.
{
  const adHocAction: EmailActionItem = {
    ...action, template_key: 'generic', communication_rule: 'NA',
    taa_action: 'NO_ACTION', category: 'No downstream early/late-logout issue', variance_minutes: 0,
  };
  const rendered = applyEmailTemplate(adHocAction, DEFAULT_EMAIL_TEMPLATES, genericCaseDetailExtras);
  assert.deepEqual(rendered.template_warnings, [], 'generic case-detail placeholders must all resolve');
  for (const value of Object.values(genericCaseDetailExtras)) {
    assert.ok(rendered.body.includes(value), `generic body should include ${value}`);
  }
}

const fallback = applyEmailTemplate({ ...action, template_key: 'missing' as never }, {} as never);
assert.ok(fallback.subject.includes('Test User'));
const unresolved = applyEmailTemplate(
  action,
  { ...DEFAULT_EMAIL_TEMPLATES, late_login_absence: { subject: '{{unknown}}', body: 'Hello {{name}}' } },
);
assert.deepEqual(unresolved.template_warnings, ['Unresolved template placeholder: {{unknown}}']);

// ops_digest needs its group-level extras (count/case_table) — rendering it
// like a plain per-case action must flag the missing tokens, not silently
// emit a broken digest.
const digestWithoutExtras = applyEmailTemplate({ ...action, template_key: 'ops_digest' }, DEFAULT_EMAIL_TEMPLATES);
assert.ok(digestWithoutExtras.template_warnings.length > 0, 'ops_digest without extras should warn');
assert.ok(
  digestWithoutExtras.template_warnings.some(w => w.includes('count')) &&
    digestWithoutExtras.template_warnings.some(w => w.includes('case_table')),
  'ops_digest warnings should name the missing count/case_table tokens',
);

// Unknown template_key must fall back to the exact generic-rendered content,
// not just "contains the name somewhere".
const genericRendered = applyEmailTemplate({ ...action, template_key: 'generic' }, DEFAULT_EMAIL_TEMPLATES);
const unknownKeyFallback = applyEmailTemplate({ ...action, template_key: 'missing' as never }, DEFAULT_EMAIL_TEMPLATES);
assert.equal(unknownKeyFallback.subject, genericRendered.subject, 'unknown template_key should render exactly like generic');
assert.equal(unknownKeyFallback.body, genericRendered.body, 'unknown template_key should render exactly like generic');

// normalizeEmailTemplates: {} must fall back to the shipped defaults for
// every key/field, a partial override must touch only what was supplied,
// and a malformed field must fall back rather than crash or store garbage.
const normalizedEmpty = normalizeEmailTemplates({});
assert.deepEqual(normalizedEmpty, DEFAULT_EMAIL_TEMPLATES, 'empty input should normalize to the shipped defaults');

const normalizedPartial = normalizeEmailTemplates({
  generic: { subject: 'Custom subject only' },
});
assert.equal(normalizedPartial.generic.subject, 'Custom subject only');
assert.equal(normalizedPartial.generic.body, DEFAULT_EMAIL_TEMPLATES.generic.body, 'unsupplied body should fall back to default');
assert.deepEqual(normalizedPartial.late_login_absence, DEFAULT_EMAIL_TEMPLATES.late_login_absence, 'untouched keys must stay at their defaults');

const normalizedMalformed = normalizeEmailTemplates({
  generic: { subject: 12345 as unknown as string, body: null as unknown as string },
});
assert.deepEqual(normalizedMalformed.generic, DEFAULT_EMAIL_TEMPLATES.generic, 'non-string fields should fall back to defaults, not crash or store garbage');

assert.equal(isVerificationOverrideValid(VERIFICATION_OVERRIDE_PHRASE, 'Approved by payroll lead'), true);
assert.equal(isVerificationOverrideValid(VERIFICATION_OVERRIDE_PHRASE.toLowerCase(), 'Approved by payroll lead'), false);
assert.equal(isVerificationOverrideValid(VERIFICATION_OVERRIDE_PHRASE, 'short'), false);

const audit: VerificationOverrideAudit = {
  acknowledged_at: '2026-09-06T12:00:00.000Z',
  acknowledgement_phrase: VERIFICATION_OVERRIDE_PHRASE,
  reason: 'Approved by payroll lead',
  regression_passed: 62,
  regression_total: 63,
  trust_matrix_passed: 145,
  trust_matrix_total: 145,
  failed_checks: [{ suite: 'regression', id: 'reg-x', name: 'Test failure', expected: 'PASS', actual: 'FAIL' }],
  inputs: {
    cognos: { name: 'cognos.csv', record_count: 1 },
    aspect_segments: { name: 'aspect.csv', record_count: 1 },
    aspect_identity: { name: 'identity.csv', record_count: 1 },
    cms: { name: 'cms.csv', record_count: 2 },
  },
};
assert.equal(JSON.parse(serializeVerificationOverrideAudit(audit)).reason, audit.reason);

const output = runReconciliation({ processingDate: SUITE_RUN_DATE,
  cognosRecords: getSampleCognosRecords(),
  aspectSegments: getSampleAspectSegments(),
  aspectIdentities: getSampleAspectIdentities(),
  cmsPunches: getSampleCmsPunches(),
  config: DEFAULT_CONFIG,
  verificationAudit: audit,
});
const annotated = generateAnnotatedCognosFile(output.rows, ',', DEFAULT_CONFIG, audit, output.emailActions);
assert.ok(annotated.split('\n')[0].includes('TAA_VERIFICATION_OVERRIDE_REASON'));
assert.ok(annotated.includes('Approved by payroll lead'));

// The Excel export's 9 sheets must partition/overlap the sample dataset
// exactly like ResultsView.tsx's on-screen tabs do — an independent copy of
// the same predicates here guards against the two drifting apart. "2. Late +
// Cover" is correction-based, not category-based (config.retainLateCoverOnAbsent
// off here, but the predicate is the general one): a row can appear in both
// "2. Late + Cover" and "3. Absent" if it still carries an actual LATE/
// Log_off/COVER correction row on a day that resolved to MARKED_ABSENT.
// D15/WP4: "1. Shift Changed" is correction-based too, same shape — the flex
// Branch B rewrite lands its row in LATE_AND_COVER_ADDED but still carries a
// real 'shift' 10/11 pair. D19/WP4: "Must Check" is a 9th, duplicate sheet
// (updated from 8 — see the count assertion below).
{
  const workbookSheets = buildResultsWorkbookSheets(output.rows, output.emailActions);
  const dataRowCount = (sheetName: string) => {
    const sheet = workbookSheets.find(s => s.name === sheetName);
    assert.ok(sheet, `expected a sheet named "${sheetName}"`);
    return sheet!.rows.length - 1; // minus header row
  };
  const hasLateCoverCorrection = (r: ReconciliationRow) =>
    r.details.generatedCorrections.some(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER');
  const hasShiftChangeCorrection = (r: ReconciliationRow) =>
    r.details.generatedCorrections.some(c => c.SegmentCode === 'shift');
  const ABSENT_MARKER_CODES_LOCAL = new Set(['ABSENT', 'Absent NS/NC']);
  const isMustCheck = (r: ReconciliationRow) =>
    isForcedHoldReason(r.holdReason)
    || (!!r.holdReason && r.details.generatedCorrections.some(c =>
      ABSENT_MARKER_CODES_LOCAL.has(c.SegmentCode) || c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off' || c.SegmentCode === 'COVER'));
  assert.equal(workbookSheets.length, 9, 'expected exactly 9 sheets: All + 5 categories + Held for Review + OT Updates + Must Check');
  assert.equal(dataRowCount('All'), output.rows.length, '"All" sheet must contain every row');
  assert.equal(dataRowCount('1. Shift Changed'), output.rows.filter(r => r.TAA_RESULT_CATEGORY === 'SHIFT_CHANGED' || hasShiftChangeCorrection(r)).length);
  assert.equal(dataRowCount('2. Late + Cover'), output.rows.filter(hasLateCoverCorrection).length);
  assert.equal(dataRowCount('3. Absent'), output.rows.filter(r => r.TAA_RESULT_CATEGORY === 'MARKED_ABSENT').length);
  assert.equal(dataRowCount('4. No Action'), output.rows.filter(r => r.TAA_RESULT_CATEGORY === 'NO_ACTION_REQUIRED').length);
  assert.equal(dataRowCount('5. Data Gap'), output.rows.filter(r => r.TAA_RESULT_CATEGORY === 'COGNOS_DATA_GAP').length);
  assert.equal(dataRowCount('Held for Review'), output.rows.filter(r => !!r.holdReason).length);
  assert.equal(dataRowCount('OT Updates'), output.rows.filter(r => r.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS') || r.TAA_ACTIONS_FIRED.includes('OT_TO_SHIFT')).length);
  assert.equal(dataRowCount('Must Check'), output.rows.filter(isMustCheck).length);
  // Guard the split (trap 2 from the plan): the sample dataset must actually
  // exercise both Must Check clauses, or this assertion would pass even if
  // the forced-hold clause were silently dropped from the real predicate.
  const mustCheckForced = output.rows.filter(r => isForcedHoldReason(r.holdReason));
  const mustCheckBlocked = output.rows.filter(r => !isForcedHoldReason(r.holdReason) && isMustCheck(r));
  assert.ok(mustCheckForced.length > 0, 'guard: sample dataset must contain at least one forced-hold row with no corrections');
  assert.ok(mustCheckBlocked.length > 0, 'guard: sample dataset must contain at least one held row proposing a pay-affecting correction');
  assert.ok(mustCheckForced.some(r => r.details.generatedCorrections.length === 0), 'guard: at least one forced-hold row must have zero corrections (trap 2)');
}

// The two email-audit columns must be present and populated end to end. The
// sample dataset produces at least one EMAIL_OPS case and DEFAULT_CONFIG ships no
// Section mailboxes, so that case is held — and Output 2 is where that fact has to live.
{
  const header = annotated.split('\n')[0].split(',');
  assert.ok(header.includes('TAA_COMMUNICATION_RULE'), 'Output 2 must carry the fired communication rule');
  assert.ok(header.includes('TAA_EMAIL_STATUS'), 'Output 2 must carry the email outcome');
  assert.ok(header.includes('TAA_SECTION_SOURCE'), 'Output 2 must show whether OPS routing Section came from Cognos or ASPECT fallback');
  assert.ok(header.includes('TAA_ASPECT_SECTION'), 'Output 2 must preserve the ASPECT identity Section for routing audit');
  assert.ok(header.includes('TAA_SECTION_MISMATCH'), 'Output 2 must flag Cognos-vs-ASPECT Section disagreements');

  // The 18 preserved Cognos columns must still lead the file, untouched.
  assert.deepEqual(
    header.slice(0, 18),
    ['SIGN IN DATE', 'SECTION', 'PF NO', 'NAME', 'LOGIN ID', 'DUTY1', 'OT1', 'DUTY-2', 'OT-2',
     'SCH DURATION', 'SIGNIN DURATION', 'SIGIN IN', 'SIGIN OUT', 'LATE START', 'LEFT EARLY', 'LEAVE TYPE', 'LEAVE HR', 'REMARK'],
    'adding email columns must not disturb the preserved Cognos block',
  );

  const statusIdx = header.indexOf('TAA_EMAIL_STATUS');
  const ruleIdx = header.indexOf('TAA_COMMUNICATION_RULE');
  const dataRows = annotated.split('\n').slice(1).map(l => l.split(','));
  const statuses = dataRows.map(c => c[statusIdx]);
  assert.equal(statuses.length, output.rows.length, 'every reconciled row gets an email status');
  assert.ok(statuses.every(s => s && s !== 'UNKNOWN'), 'no row may report UNKNOWN once emailActions are supplied');
  assert.ok(
    statuses.includes('HELD_NO_OPS_MAILBOX'),
    'the sample dataset holds one OPS case with the shipped empty mailbox map — Output 2 must say so',
  );
  const heldRow = dataRows.find(c => c[statusIdx] === 'HELD_NO_OPS_MAILBOX')!;
  assert.equal(heldRow[ruleIdx], 'EMAIL_OPS', 'the held row must record which rule required the email');
  assert.ok(
    dataRows.filter(c => c[statusIdx] === 'NOT_REQUIRED').every(c => c[ruleIdx] === 'NA'),
    'rows needing no email report NA, not a stale rule',
  );

  // Omitting emailActions must degrade honestly rather than claim NOT_REQUIRED.
  const withoutEmail = generateAnnotatedCognosFile(output.rows, ',', DEFAULT_CONFIG, audit);
  const withoutHeader = withoutEmail.split('\n')[0].split(',');
  const withoutIdx = withoutHeader.indexOf('TAA_EMAIL_STATUS');
  assert.ok(
    withoutEmail.split('\n').slice(1).every(l => l.split(',')[withoutIdx] === 'UNKNOWN'),
    'without email context the column must read UNKNOWN, never a fabricated NOT_REQUIRED',
  );
}
// Every row carries AT LEAST one EmailActionItem — the mail icon must be
// available for every case, including NO_ACTION_REQUIRED ones, so a TAA agent
// can send an ad-hoc notice. Rows where no policy rule fired keep
// communication_rule 'NA' (template_key 'generic'), which is what keeps them
// out of Bulk Draft / the Actions JSON (see planEmailDraftActions'
// EMAIL_OPS/EMAIL_STAFF_CC_MANAGER-only filter). Not a strict 1:1 any more: a
// row that fires more than one distinct action (e.g. a Late Login finding AND
// a separate Early Logout finding, neither escalating to Absent) gets one
// EmailActionItem PER action, each with its own template/communication/
// variance — see the "one email per fired action" block in
// reconciliationEngine.ts. The sample dataset has exactly one such row.
assert.ok(output.emailActions.length >= output.rows.length, 'every row must carry at least one email action, required or ad-hoc');
assert.equal(output.emailActions.length, output.rows.length + 1, 'sample dataset: exactly one row fires two distinct actions and so carries two email actions');
assert.ok(output.emailActions.some(item => item.communication_rule !== 'NA'), 'the sample dataset must still produce at least one policy-required action');
const aspectCsv = generateAspectCorrectionsCsv(output.rows.filter(row => row.includeInOutput).flatMap(row => row.details.generatedCorrections));
assert.ok(aspectCsv.split('\n').every(line => line.endsWith(',')), 'ASPECT header and rows must retain trailing commas');

// The email gate is the fired Communication Rule and nothing else. There used
// to be a second, hardcoded condition in reconciliationEngine.ts requiring the
// action to be ABSENT_SEGMENT / ABSENT_NS_NC / LATE_AND_COVER, which silently
// overrode config in violation of "never hard-code the email decisions".
// Removing it changed no behaviour because every shipped emailing rule already
// lands on one of those actions — this pins that, so if a future rule edit
// points an EMAIL_* rule at a different action, this test documents the fact
// rather than the email vanishing without explanation.
const REMOVED_HARDCODED_EMAIL_ACTIONS = new Set(['ABSENT_SEGMENT', 'ABSENT_NS_NC', 'LATE_AND_COVER']);
const emailingRules = DEFAULT_CONFIG.policyRules.filter(r => r.communication !== 'NA');
assert.ok(emailingRules.length > 0, 'the shipped rule table must contain at least one emailing rule');
assert.deepEqual(
  emailingRules.filter(r => !REMOVED_HARDCODED_EMAIL_ACTIONS.has(r.action)).map(r => `${r.segmentType}/${r.tier}/${r.action}`),
  [],
  'removing the hardcoded action gate must not change behaviour for the shipped rule set',
);

// Section-based OPS mailbox pooling
const prestigeA: EmailActionItem = { ...action, row_id: 'p1', base_row_id: 'p1', emp_id: '111', name: 'Prestige One', section: 'Prestige', communication_rule: 'EMAIL_OPS', nominate_date: '06/09/2026' };
const prestigeB: EmailActionItem = {
  ...action, row_id: 'p2', base_row_id: 'p2', emp_id: '222', name: 'Prestige Two', section: 'Prestige', communication_rule: 'EMAIL_OPS', nominate_date: '06/09/2026',
  is_terminated: true,
  body: `${action.body}\n\nActions fired (all, this row): LATE_LOGIN; EARLY_LOGOUT`,
};
const usmbUnmapped: EmailActionItem = { ...action, row_id: 'u1', base_row_id: 'u1', emp_id: '333', name: 'USMB One', section: 'USMB', communication_rule: 'EMAIL_OPS', nominate_date: '06/09/2026' };
const staffUnaffected: EmailActionItem = { ...action, row_id: 's1', base_row_id: 's1', emp_id: '444', name: 'Staff One', section: 'Prestige', communication_rule: 'EMAIL_STAFF_CC_MANAGER' };

const { pooled, held } = poolEmailOpsActionsBySection(
  [prestigeA, prestigeB, usmbUnmapped, staffUnaffected],
  [{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }],
  DEFAULT_EMAIL_TEMPLATES,
);
assert.equal(pooled.length, 1, 'both Prestige cases should pool into one digest');
assert.equal(pooled[0].communication_rule, 'EMAIL_OPS');
assert.equal(pooled[0].ops_mailbox, 'prestigeagents@thecontactcenter.ae');
assert.deepEqual(pooled[0].template_warnings, [], 'digest must resolve count/case_table with no unresolved placeholders');
assert.ok(pooled[0].body.includes('Prestige One') && pooled[0].body.includes('Prestige Two'), 'digest body should list both pooled cases');
assert.ok(pooled[0].body.includes('TERMINATED'), 'digest table must surface the terminated flag, not silently drop it');
assert.ok(pooled[0].body.includes('LATE_LOGIN; EARLY_LOGOUT'), 'digest must preserve the multi-finding note');
// The unmapped Section is HELD, not redirected. Redirecting used to rewrite it
// to EMAIL_STAFF_CC_MANAGER, which inverted the §4.1 routing decision: that
// rule chose OPS precisely so the employee and their line manager would not be
// recipients, and sectionMailboxMap ships empty, so the shipped default turned
// every OPS-only case into a disciplinary notice addressed to the employee.
assert.equal(held.length, 1, 'the unmapped USMB case must be held, not drafted');
assert.equal(held[0].communication_rule, 'EMAIL_OPS', 'a held case must keep its original rule — never be rewritten to staff+manager');
assert.equal(held[0].emp_id, '333');

// buildIndividualOverride still exists for the single-row icon, but it is now
// only reachable behind an explicit operator confirmation (see handleRowDraft
// in ResultsView.tsx) — never applied automatically during bulk drafting.
const overridden = buildIndividualOverride({ ...prestigeA, communication_rule: 'EMAIL_OPS' }, [
  { empId: prestigeA.emp_id, managerEmail: 'manager@thecontactcentre.ae' },
]);
assert.equal(overridden.communication_rule, 'EMAIL_STAFF_CC_MANAGER', 'an explicit single-row override must force staff+manager routing');
assert.equal(overridden.subject, prestigeA.subject, 'forcing the rule must not alter already-baked content');
assert.equal(overridden.cc, 'manager@thecontactcentre.ae', 'an override must also resolve the CC from the supplied manager map');

const overriddenNoMapping = buildIndividualOverride({ ...prestigeA, communication_rule: 'EMAIL_OPS' }, []);
assert.equal(overriddenNoMapping.cc, undefined, 'no manager mapping must leave cc unset, not an error');

assert.ok(renderOpsDigestTable([prestigeA]).includes('Prestige One'));

// Empty input must not throw and must return empty groups, not undefined.
const emptyPool = poolEmailOpsActionsBySection([], [{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }], DEFAULT_EMAIL_TEMPLATES);
assert.deepEqual(emptyPool, { pooled: [], held: [] });

// Same section, two different nominate_date values must form two separate
// digest groups (the section||date compound key), never merged across days.
const prestigeDay2: EmailActionItem = { ...prestigeA, row_id: 'p3', base_row_id: 'p3', emp_id: '555', name: 'Prestige Three', nominate_date: '07/09/2026' };
const { pooled: pooledAcrossDays } = poolEmailOpsActionsBySection(
  [prestigeA, prestigeDay2],
  [{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }],
  DEFAULT_EMAIL_TEMPLATES,
);
assert.equal(pooledAcrossDays.length, 2, 'same section on two different dates must produce two separate digests');

// A near-miss section string with no exact (case-insensitive) mailbox rule
// must be held, not silently dropped and not matched to an unrelated rule.
const nearMissSection: EmailActionItem = { ...action, row_id: 'n1', base_row_id: 'n1', emp_id: '666', name: 'Near Miss', section: 'Prestige Team', communication_rule: 'EMAIL_OPS', nominate_date: '06/09/2026' };
const { pooled: nearMissPooled, held: nearMissHeld } = poolEmailOpsActionsBySection(
  [nearMissSection],
  [{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }],
  DEFAULT_EMAIL_TEMPLATES,
);
assert.equal(nearMissPooled.length, 0, 'a near-miss section name must not match an unrelated mailbox rule');
assert.equal(nearMissHeld.length, 1, 'a near-miss section name must be held');
assert.equal(nearMissHeld[0].emp_id, '666');
assert.equal(nearMissHeld[0].communication_rule, 'EMAIL_OPS');

// findSectionMailbox must key Sections exactly the way pooling does, since the
// single-row draft path uses it to decide whether an override is even needed.
assert.equal(
  findSectionMailbox([{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }], ' prestige '),
  'prestigeagents@thecontactcenter.ae',
);
assert.equal(findSectionMailbox([{ section: 'PRESTIGE', mailbox: 'x@y.test' }], 'Prestige Team'), undefined);
assert.equal(findSectionMailbox([], 'Prestige'), undefined);

// shortenFindingLabel: the digest table and staff-facing {{finding}} must get a
// short label, while the full rule trace stays available via {{category}}.
assert.equal(
  shortenFindingLabel('Late Logout (OPS): 43m past the release-adjusted end 17:00 (rostered end 16:45) -> Mark Absent'),
  'Late Logout',
);
assert.equal(shortenFindingLabel('Cover Not Attended'), 'Cover Not Attended');
assert.equal(shortenFindingLabel(''), '');
// Nothing recognisable to strip — pass through rather than truncate to junk.
assert.equal(shortenFindingLabel('   '), '   '.trim() === '' ? '' : '   ');

// The digest table must stay narrow (short label in the column) while the full
// trace survives in the case-detail block below it.
const verboseCase: EmailActionItem = {
  ...prestigeA,
  category: 'Late Logout (OPS): 43m past the release-adjusted end 17:00 (rostered end 16:45) -> Mark Absent',
};
const verboseTable = renderOpsDigestTable([verboseCase]);
const headerRow = verboseTable.split('\n')[0];
assert.ok(headerRow.length < 90, `digest header row must stay narrow, got ${headerRow.length} chars`);
assert.ok(verboseTable.includes('Case detail:'), 'the full rule trace must be preserved below the table');
assert.ok(verboseTable.includes('release-adjusted end 17:00'), 'the full rule trace must not be lost');

// planEmailDraftActions / generateEmailActionsJson — the single shared routing
// plan used by both the in-app Bulk Draft button and the downloadable Email
// Actions JSON (audited defect: the download used to ship the raw, unpooled
// emailActions and could produce an EMAIL_OPS action with a blank
// ops_mailbox — see emailDrafts.ts's resolution logic, which creates no draft
// when that field is empty). This matters especially for the standalone
// file:// build, where Bulk Draft is disabled without folder access and the
// download is the only email route.
const configWithMailbox: ConfigRegistry = {
  ...DEFAULT_CONFIG,
  sectionMailboxMap: [{ section: 'PRESTIGE', mailbox: 'prestigeagents@thecontactcenter.ae' }],
};

const plan = planEmailDraftActions(
  [prestigeA, prestigeB, usmbUnmapped, staffUnaffected],
  configWithMailbox.sectionMailboxMap,
  configWithMailbox.emailTemplates,
);
assert.equal(plan.staffActions.length, 1);
assert.equal(plan.pooled.length, 1);
assert.equal(plan.held.length, 1);
assert.deepEqual(plan.heldSections, ['USMB']);
assert.equal(plan.finalActions.length, 2, 'staff + one pooled digest; the held case is excluded, not re-routed');
assert.ok(
  !plan.finalActions.some(a => a.row_id === 'u1'),
  'a held case must never appear in finalActions'
);
assert.ok(
  plan.finalActions.every(a => a.communication_rule !== 'EMAIL_OPS' || !!a.ops_mailbox),
  'no EMAIL_OPS action may reach the final plan without an ops_mailbox'
);

// With no mailboxes configured at all — the shipped DEFAULT_CONFIG state — every
// EMAIL_OPS case must be held. Nothing may silently reach the employee.
const planNoMailboxes = planEmailDraftActions(
  [prestigeA, prestigeB, usmbUnmapped, staffUnaffected],
  DEFAULT_CONFIG.sectionMailboxMap,
  DEFAULT_CONFIG.emailTemplates,
);
assert.deepEqual(DEFAULT_CONFIG.sectionMailboxMap, [], 'guard: this assertion assumes the shipped default is an empty map');
assert.equal(planNoMailboxes.held.length, 3, 'all three EMAIL_OPS cases must be held when no mailbox is configured');
assert.equal(planNoMailboxes.finalActions.length, 1, 'only the EMAIL_STAFF_CC_MANAGER case may be drafted');
assert.equal(planNoMailboxes.finalActions[0].communication_rule, 'EMAIL_STAFF_CC_MANAGER');

const excludedOpsAction: EmailActionItem = {
  ...action, row_id: 'excluded1', base_row_id: 'excluded1', emp_id: '777', section: 'Prestige', communication_rule: 'EMAIL_OPS', nominate_date: '06/09/2026',
};
const rowsForJson = [
  { id: 'p1', includeInOutput: true, holdReason: undefined },
  { id: 'p2', includeInOutput: true, holdReason: undefined },
  { id: 'u1', includeInOutput: true, holdReason: undefined },
  { id: 's1', includeInOutput: true, holdReason: undefined },
  { id: 'excluded1', includeInOutput: false, holdReason: undefined },
] as unknown as ReconciliationRow[];

// TAA_EMAIL_STATUS — a held case is deliberately absent from the actions JSON,
// so Output 2 is the ONLY artifact that can record it happened. Without this the
// hold is a silent non-delivery: nothing downloadable says an email was required.
{
  const emailRows = [
    { id: 'p1', includeInOutput: true, holdReason: undefined },
    { id: 'u1', includeInOutput: true, holdReason: undefined },
    { id: 's1', includeInOutput: true, holdReason: undefined },
    { id: 'excluded1', includeInOutput: false, holdReason: undefined },
    { id: 'noemail1', includeInOutput: true, holdReason: undefined },
  ] as unknown as ReconciliationRow[];
  const emailActionsForStatus = [prestigeA, usmbUnmapped, staffUnaffected, excludedOpsAction];

  const { statusByRowId } = computeEmailStatusByRowId(
    emailActionsForStatus,
    new Set(emailRows.filter(r => r.includeInOutput).map(r => r.id)),
    configWithMailbox.sectionMailboxMap,
    configWithMailbox.emailTemplates,
  );
  assert.equal(statusByRowId.get('p1'), 'DRAFTED_OPS_DIGEST', 'a pooled OPS case reports the digest it went into');
  assert.equal(statusByRowId.get('u1'), 'HELD_NO_OPS_MAILBOX', 'the held case must be recorded, not silently absent');
  assert.equal(statusByRowId.get('s1'), 'DRAFTED_INDIVIDUAL');
  assert.equal(statusByRowId.get('excluded1'), 'EXCLUDED_FROM_OUTPUT', 'a withheld row is a different fact from "no email required"');
  assert.equal(statusByRowId.get('noemail1'), undefined, 'a row that fired no emailing rule has no entry (renders NOT_REQUIRED)');

  // With no mailboxes configured — the shipped default — nothing is drafted and
  // every OPS case must still be accounted for.
  const { statusByRowId: noMailboxStatus } = computeEmailStatusByRowId(
    emailActionsForStatus,
    new Set(emailRows.filter(r => r.includeInOutput).map(r => r.id)),
    DEFAULT_CONFIG.sectionMailboxMap,
    DEFAULT_CONFIG.emailTemplates,
  );
  assert.equal(noMailboxStatus.get('p1'), 'HELD_NO_OPS_MAILBOX');
  assert.equal(noMailboxStatus.get('u1'), 'HELD_NO_OPS_MAILBOX');
  assert.equal(noMailboxStatus.get('s1'), 'DRAFTED_INDIVIDUAL', 'staff cases are unaffected by OPS mailbox config');
}

const downloaded = JSON.parse(generateEmailActionsJson(
  [prestigeA, prestigeB, usmbUnmapped, staffUnaffected, excludedOpsAction],
  rowsForJson,
  configWithMailbox,
)) as EmailActionItem[];
assert.equal(downloaded.length, 2, 'excluded row must not appear, the two mapped OPS cases pool into one digest, and the unmapped OPS case is held');
assert.ok(
  downloaded.every(a => a.communication_rule !== 'EMAIL_OPS' || !!a.ops_mailbox),
  'downloaded JSON must never contain an EMAIL_OPS action with a blank ops_mailbox'
);
// The downloaded actions file is the ONLY email route in the file:// standalone
// build, where Bulk Draft is disabled without folder access — so a held case
// must be absent here too, not quietly re-routed on the way to disk.
assert.ok(
  !downloaded.some(a => a.row_id === 'u1'),
  'a held case must not reach the downloadable actions JSON either'
);
assert.deepEqual(
  downloaded.map(a => a.row_id).sort(),
  plan.finalActions.map(a => a.row_id).sort(),
  'downloaded JSON and the Bulk Draft plan must route the same final action set'
);

// normalizeSectionMailboxMap must collapse case/whitespace-only variants of
// the same Section into one row (last value wins), never persist two rows
// for what the pooling logic (poolEmailOpsActionsBySection) treats as the
// same key — this is the safety net behind the Email Config wizard's
// duplicate-Section guard, exercised for both manual-entry-shaped input and
// a CSV-import-shaped merge (existing rows + freshly imported rows).
const dedupedManual = normalizeSectionMailboxMap([
  { section: 'Prestige', mailbox: 'old@example.test' },
  { section: ' PRESTIGE ', mailbox: 'new@example.test' },
  { section: 'USMB', mailbox: 'usmb@example.test' },
]);
assert.equal(dedupedManual.length, 2, 'case/whitespace-only Section duplicates must collapse to one row');
const prestigeRow = dedupedManual.find(r => r.section === 'PRESTIGE');
assert.ok(prestigeRow, 'the collapsed row must use the normalized (trimmed, upper-cased) Section key');
assert.equal(prestigeRow?.mailbox, 'new@example.test', 'the later row must win when Sections collide');

const dedupedImportMerge = normalizeSectionMailboxMap([
  { section: 'PRESTIGE', mailbox: 'existing@example.test' },
  { section: 'prestige', mailbox: 'imported@example.test' }, // simulates a re-import of the same section
]);
assert.equal(dedupedImportMerge.length, 1);
assert.equal(dedupedImportMerge[0].mailbox, 'imported@example.test', 'a re-imported CSV row must overwrite the existing mapping for the same Section, not duplicate it');

assert.deepEqual(normalizeSectionMailboxMap([{ section: 'NOMAILBOX', mailbox: '' }]), [], 'a row with no mailbox must be dropped, not saved as an incomplete duplicate risk');
assert.deepEqual(normalizeSectionMailboxMap([{ section: '', mailbox: 'noone@example.test' }]), [], 'a row with no Section must be dropped');

// ===== WP3 (2026-09-22) — review completion state (D12) and the honest
// Known-Cognos-issue label (D11/D13) =====

// Mirrors App.tsx's handleToggleInclude exactly (B10: one checkbox records
// two different things depending on whether the row has corrections to send
// to payroll). Pinned here so the contract is tested even though the handler
// itself lives in a React component this engine-focused test file does not import.
function applyReviewToggle(rows: ReconciliationRow[], rowId: string, nextChecked: boolean): ReconciliationRow[] {
  return rows.map(r => {
    if (r.id !== rowId || isForcedHoldReason(r.holdReason)) return r;
    const hasCorrections = r.details.generatedCorrections.length > 0;
    return {
      ...r,
      reviewCompleted: nextChecked,
      includeInOutput: hasCorrections ? nextChecked : false,
      includeDecisionSource: 'user' as const,
      reviewStatus: reviewStatusAfterIncludeToggle(r.reviewStatus, nextChecked),
    };
  });
}

// Naive split(',') breaks on cells the exporter correctly quoted because
// their own text contains a comma (e.g. free-text REMARK values in the
// sample dataset) — a handful of existing assertions above get away with it
// because they only check a few rows' worth. Checking EVERY row's column
// value (test 1 below) needs an actual quote-aware split.
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

// 1. A fresh run exports TAA_REVIEW_COMPLETED=FALSE for every row, including
// clean auto-included ones (trap 1) — includeInOutput=true must never be
// mistaken for "a human reviewed this".
{
  assert.ok(
    output.rows.some(r => !r.holdReason && r.includeInOutput),
    'guard: sample dataset must contain at least one clean auto-included row to prove trap 1',
  );
  assert.ok(output.rows.every(r => r.reviewCompleted === false), 'every row must start unreviewed on a fresh run');
  const freshAnnotated = generateAnnotatedCognosFile(output.rows, ',', DEFAULT_CONFIG, undefined, output.emailActions);
  const freshHeader = parseCsvLine(freshAnnotated.split('\n')[0]);
  const reviewIdx = freshHeader.indexOf('TAA_REVIEW_COMPLETED');
  assert.ok(reviewIdx >= 0, 'annotated export must carry TAA_REVIEW_COMPLETED');
  const freshDataRows = freshAnnotated.split('\n').slice(1);
  assert.equal(freshDataRows.length, output.rows.length, 'guard: one exported line per row');
  assert.ok(
    freshDataRows.every(l => parseCsvLine(l)[reviewIdx] === 'FALSE'),
    'a fresh run must export FALSE for every row, including auto-included clean ones (trap 1)',
  );
}

// 2/3/4. Toggle semantics (B10, trap 2) and the byte-identical CSV proof.
{
  const someCorrections = output.rows.find(r => r.details.generatedCorrections.length > 0);
  assert.ok(someCorrections, 'guard: sample dataset must contain at least one row with generated corrections');

  const noCorrectionsHeldRow = {
    ...output.rows[0],
    id: 'wp3-held-no-corrections',
    holdReason: 'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY',
    holdReasonText: 'test fixture',
    includeInOutput: false,
    reviewCompleted: false,
    details: { ...output.rows[0].details, generatedCorrections: [] },
  } as ReconciliationRow;
  const actionableRow = {
    ...output.rows[0],
    id: 'wp3-actionable',
    holdReason: undefined,
    holdReasonText: undefined,
    includeInOutput: false,
    reviewCompleted: false,
    details: { ...output.rows[0].details, generatedCorrections: someCorrections!.details.generatedCorrections },
  } as ReconciliationRow;

  const baseRows = [noCorrectionsHeldRow, actionableRow];
  const baseCsv = generateAspectCorrectionsCsv(baseRows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  assert.equal(baseCsv, '', 'guard: neither fixture row starts included');

  // 2. Ticking a held row with NO corrections: reviewed only, CSV unchanged.
  const afterTickHeld = applyReviewToggle(baseRows, 'wp3-held-no-corrections', true);
  const tickedHeld = afterTickHeld.find(r => r.id === 'wp3-held-no-corrections')!;
  assert.equal(tickedHeld.reviewCompleted, true, 'ticking a no-corrections row must record reviewed');
  assert.equal(tickedHeld.includeInOutput, false, 'ticking a no-corrections row must never set includeInOutput (trap 2)');
  const csvAfterTickHeld = generateAspectCorrectionsCsv(afterTickHeld.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  assert.equal(csvAfterTickHeld, baseCsv, 'ticking a no-corrections row must leave the ASPECT CSV byte-identical');

  // 3. Ticking an actionable row: reviewed AND included.
  const afterTickActionable = applyReviewToggle(afterTickHeld, 'wp3-actionable', true);
  const tickedActionable = afterTickActionable.find(r => r.id === 'wp3-actionable')!;
  assert.equal(tickedActionable.reviewCompleted, true, 'ticking an actionable row must record reviewed');
  assert.equal(tickedActionable.includeInOutput, true, 'ticking an actionable row must include it in the payroll output');
  const csvAfterTickActionable = generateAspectCorrectionsCsv(afterTickActionable.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  assert.ok(csvAfterTickActionable.length > 0 && csvAfterTickActionable !== baseCsv, 'ticking the actionable row must add its corrections to the CSV');

  // 4. Un-ticking restores pending and removes the corrections again.
  const afterUntick = applyReviewToggle(afterTickActionable, 'wp3-actionable', false);
  const untickedActionable = afterUntick.find(r => r.id === 'wp3-actionable')!;
  assert.equal(untickedActionable.reviewCompleted, false, 'un-ticking must clear reviewed');
  assert.equal(untickedActionable.includeInOutput, false, 'un-ticking must clear includeInOutput');
  const csvAfterUntick = generateAspectCorrectionsCsv(afterUntick.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  assert.equal(csvAfterUntick, baseCsv, 'un-ticking the actionable row must restore the original (empty) CSV');
}

// 5. describeDisagreement: exactly the three B11 reasons read "Known Cognos
// issue"; everything else names the mismatched columns.
{
  const baseDisagreeRow = { ...output.rows[0], TAA_MISMATCH_COLUMNS: 'LATE START; LEFT EARLY' } as ReconciliationRow;
  for (const reason of ['DEFECT_1_RELEASE_IGNORED', 'DEFECT_2_NIGHT_SHIFT_PUNCH_LOST', 'COGNOS_FALSE_ABSENCE']) {
    assert.equal(
      describeDisagreement({ ...baseDisagreeRow, TAA_DISAGREE_REASON: reason } as ReconciliationRow),
      'Known Cognos issue',
      `${reason} must read as a known Cognos issue`,
    );
  }
  assert.equal(
    describeDisagreement({ ...baseDisagreeRow, TAA_DISAGREE_REASON: 'MATCH' } as ReconciliationRow),
    'Cognos mismatch: LATE START; LEFT EARLY',
    'a plain column mismatch must name the columns, not claim a diagnosed defect',
  );
}

// 6. A forced-hold row stays locked even when it also carries known-issue
// metadata — eligibility is isForcedHoldReason(holdReason) alone.
{
  const forcedRow = {
    ...output.rows[0],
    id: 'wp3-forced',
    holdReason: 'STILL_CLOCKED_IN',
    TAA_DISAGREE_REASON: 'DEFECT_1_RELEASE_IGNORED',
    TAA_COGNOS_AGREE: false,
    includeInOutput: false,
    reviewCompleted: false,
  } as ReconciliationRow;
  assert.ok(isForcedHoldReason(forcedRow.holdReason), 'guard: STILL_CLOCKED_IN must remain a forced hold');
  const afterAttempt = applyReviewToggle([forcedRow], 'wp3-forced', true);
  const stillForced = afterAttempt.find(r => r.id === 'wp3-forced')!;
  assert.equal(stillForced.reviewCompleted, false, 'a forced-hold row must not become reviewable via the toggle');
  assert.equal(stillForced.includeInOutput, false, 'a forced-hold row must never be included, known-issue metadata or not');
}

// ===== Review status (UI-only tri-state marker, §reviewStatus) =====
// Never persisted, never exported — only asserted here via the pure helpers
// in reviewStatus.ts and by replicating App.tsx's handler wiring above
// (applyReviewToggle), since the React component itself isn't imported here.
// App.tsx applies applyInitialReviewStatus once, in runReconciliationWithAudit,
// AFTER every hold-setting pass (engine + unseenPunchAudit) — `output` here is
// raw runReconciliation() output (engine-init NOT_TOUCHED on every row), so
// tests below apply the helper explicitly to model that final step.

// 1. Held rows (holdReason truthy) start NOT_TOUCHED; non-held rows — including
// a no-correction row — start REVIEWED. Applied once per fresh run only.
{
  assert.ok(output.rows.length > 0, 'guard: sample run must produce rows');
  const heldRow = output.rows.find(r => !!r.holdReason);
  assert.ok(heldRow, 'guard: sample dataset must contain at least one held row');
  const nonHeldRow = output.rows.find(r => !r.holdReason);
  assert.ok(nonHeldRow, 'guard: sample dataset must contain at least one non-held row');
  const nonHeldNoCorrectionRow = output.rows.find(r => !r.holdReason && r.details.generatedCorrections.length === 0);
  assert.ok(nonHeldNoCorrectionRow, 'guard: sample dataset must contain a non-held row with no corrections');

  const finalRows = applyInitialReviewStatus(output.rows);
  assert.equal(finalRows.find(r => r.id === heldRow!.id)!.reviewStatus, 'NOT_TOUCHED', 'a held row must start NOT_TOUCHED');
  assert.equal(finalRows.find(r => r.id === nonHeldRow!.id)!.reviewStatus, 'REVIEWED', 'a non-held row must start REVIEWED');
  assert.equal(
    finalRows.find(r => r.id === nonHeldNoCorrectionRow!.id)!.reviewStatus,
    'REVIEWED',
    'a non-held no-correction row must also start REVIEWED',
  );
  assert.equal(initialReviewStatus({ holdReason: 'STILL_CLOCKED_IN' }), 'NOT_TOUCHED');
  assert.equal(initialReviewStatus({ holdReason: undefined }), 'REVIEWED');
}

// 1b. A row held only by a LATE pass (e.g. unseenPunchAudit.ts, added after the
// engine's own holds) must still start NOT_TOUCHED — applyInitialReviewStatus
// is pure and reads whatever holdReason is on the row at the moment it runs,
// so it doesn't matter which pass set it, only that it runs after all of them.
{
  const lateHeldRow = { ...output.rows[0], holdReason: 'UNSEEN_PUNCH_OUTCOME' } as ReconciliationRow;
  assert.equal(applyInitialReviewStatus([lateHeldRow])[0].reviewStatus, 'NOT_TOUCHED', 'a row held by a late pass must start NOT_TOUCHED');
}

// 2. Cycle order: NOT_TOUCHED -> PENDING -> REVIEWED -> NOT_TOUCHED.
{
  assert.equal(nextReviewStatus('NOT_TOUCHED'), 'PENDING');
  assert.equal(nextReviewStatus('PENDING'), 'REVIEWED');
  assert.equal(nextReviewStatus('REVIEWED'), 'NOT_TOUCHED');
}

// 3. Ticking include always forces REVIEWED, from either starting status; unticking
// never changes the marker.
{
  assert.equal(reviewStatusAfterIncludeToggle('NOT_TOUCHED', true), 'REVIEWED', 'ticking from NOT_TOUCHED must land on REVIEWED');
  assert.equal(reviewStatusAfterIncludeToggle('PENDING', true), 'REVIEWED', 'ticking from PENDING must land on REVIEWED');
  assert.equal(reviewStatusAfterIncludeToggle('REVIEWED', true), 'REVIEWED', 'ticking an already-reviewed row is a no-op');
  assert.equal(reviewStatusAfterIncludeToggle('PENDING', false), 'PENDING', 'un-ticking must leave the marker unchanged');
  assert.equal(reviewStatusAfterIncludeToggle('REVIEWED', false), 'REVIEWED', 'un-ticking must leave the marker unchanged even when already REVIEWED');
}

// 4. applyReviewToggle (the App.tsx handler contract) wires the same rule end to end.
{
  const startRow = { ...output.rows[0], id: 'review-status-toggle', reviewStatus: 'PENDING' as ReviewStatus } as ReconciliationRow;
  const afterTick = applyReviewToggle([startRow], 'review-status-toggle', true);
  assert.equal(afterTick[0].reviewStatus, 'REVIEWED', 'ticking include on a PENDING row must set reviewStatus REVIEWED');
  const afterUntick = applyReviewToggle(afterTick, 'review-status-toggle', false);
  assert.equal(afterUntick[0].reviewStatus, 'REVIEWED', 'un-ticking include must leave reviewStatus REVIEWED unchanged');
}

// 5. countNotReviewed (feeds the "N left" qualifier on the Held/Must Check
// chips — ResultsView.tsx computes HELD_LEFT/MUST_CHECK_LEFT with this) and
// the label helper.
{
  assert.equal(
    countNotReviewed([{ reviewStatus: 'NOT_TOUCHED' }, { reviewStatus: 'PENDING' }, { reviewStatus: 'REVIEWED' }]),
    2,
    'NOT_TOUCHED and PENDING both count as not-yet-reviewed',
  );
  assert.equal(countNotReviewed([{ reviewStatus: 'REVIEWED' }, { reviewStatus: 'REVIEWED' }]), 0);
  assert.equal(countNotReviewed([]), 0);
  assert.equal(reviewStatusLabel('NOT_TOUCHED'), 'Not touched');
  assert.equal(reviewStatusLabel('PENDING'), 'Pending');
  assert.equal(reviewStatusLabel('REVIEWED'), 'Reviewed');
}

// 5b. applyReviewToggle / handleSetReviewStatus never reset OTHER rows' markers
// — only the targeted row's status changes.
{
  const rowA = { ...output.rows[0], id: 'review-scope-a', reviewStatus: 'NOT_TOUCHED' as ReviewStatus, holdReason: 'STILL_CLOCKED_IN' } as ReconciliationRow;
  const rowB = { ...output.rows[0], id: 'review-scope-b', reviewStatus: 'PENDING' as ReviewStatus, holdReason: undefined, includeInOutput: false } as ReconciliationRow;
  const afterToggleB = applyReviewToggle([rowA, rowB], 'review-scope-b', true);
  assert.equal(afterToggleB.find(r => r.id === 'review-scope-a')!.reviewStatus, 'NOT_TOUCHED', 'toggling row B must not touch row A\'s marker');
  assert.equal(afterToggleB.find(r => r.id === 'review-scope-b')!.reviewStatus, 'REVIEWED', 'toggled row itself must update');
}

// 6. reviewStatus is UI-only: every export it could touch must be byte-identical
// regardless of its value, for both a corrections-bearing row and a clean one.
{
  const variants: ReviewStatus[] = ['NOT_TOUCHED', 'PENDING', 'REVIEWED'];
  const rowsFor = (status: ReviewStatus) => output.rows.map(r => ({ ...r, reviewStatus: status }));
  const [notTouchedRows, pendingRows, reviewedRows] = variants.map(rowsFor);

  const csvFor = (rows: ReconciliationRow[]) =>
    generateAspectCorrectionsCsv(rows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));
  assert.equal(csvFor(pendingRows), csvFor(notTouchedRows), 'ASPECT correction CSV must not vary with reviewStatus');
  assert.equal(csvFor(reviewedRows), csvFor(notTouchedRows), 'ASPECT correction CSV must not vary with reviewStatus');

  const annotatedFor = (rows: ReconciliationRow[]) =>
    generateAnnotatedCognosFile(rows, ',', DEFAULT_CONFIG, undefined, output.emailActions);
  assert.equal(annotatedFor(pendingRows), annotatedFor(notTouchedRows), 'annotated Cognos export must not vary with reviewStatus');
  assert.equal(annotatedFor(reviewedRows), annotatedFor(notTouchedRows), 'annotated Cognos export must not vary with reviewStatus');

  const emailJsonFor = (rows: ReconciliationRow[]) =>
    generateEmailActionsJson(output.emailActions, rows, DEFAULT_CONFIG);
  assert.equal(emailJsonFor(pendingRows), emailJsonFor(notTouchedRows), 'email actions JSON must not vary with reviewStatus');
  assert.equal(emailJsonFor(reviewedRows), emailJsonFor(notTouchedRows), 'email actions JSON must not vary with reviewStatus');
}

// ===== WP4 (2026-09-22) — reporting truth: derived counters (D14/D16),
// correction-based Shift Changed membership (D15), and Must Check (D19) =====

// 1. cognosDataGapCount must equal the number of rows whose category is
// COGNOS_DATA_GAP — proved as a live invariant against the real sample-run
// output (which reaches the category through several different gates, not
// just the old single-increment "no schedule" one). This is the structural
// guard; the mutation test (see the WP4 report) is the proof the fix bites.
assert.equal(
  output.summary.cognosDataGapCount,
  output.rows.filter(r => r.TAA_RESULT_CATEGORY === 'COGNOS_DATA_GAP').length,
  'cognosDataGapCount must equal the number of rows actually in the COGNOS_DATA_GAP category (D14)',
);

// 2. lateCoverCount (D16) — see 'reg-159' in regressionSuite.ts for the
// dedicated moveCoverForward scenario (a single COVER-only action, no
// accompanying LATE correction, which is exactly the shape the old counter
// missed). Sanity-checked here against the sample run: it must never be
// negative and must never exceed the total LATE/Log_off/COVER corrections
// actually emitted (each lateCoverCount++ site emits 1 or 2 corrections, so
// equality is not expected, but the counter can never overshoot the rows it
// is meant to describe).
assert.ok(output.summary.lateCoverCount >= 0, 'lateCoverCount must never be negative');
assert.ok(
  output.summary.lateCoverCount <= output.rows.flatMap(r => r.details.generatedCorrections).filter(c => LATE_COVER_SEGMENT_CODES.has(c.SegmentCode)).length,
  'lateCoverCount (one increment per fired action) must never exceed the total LATE/Log_off/COVER corrections actually emitted',
);

// 3/4. Shift Changed membership (D15) — correction-based, keyed on the exact
// SegmentCode 'shift' (lowercase), not the OT-conversion pairs that reuse the
// same "10"/"11" Codes with a different SegmentCode.
{
  const shiftPairCorrections = [
    { Code: '10', ID: '999', SegmentCode: 'shift', nominateDate: '01/09/2026', SegmentDate: '01/09/2026', SegmentStarttime: '09:00', Segmentduration: '08:00', Memo: 'TAA Original shift' },
    { Code: '11', ID: '999', SegmentCode: 'shift', nominateDate: '01/09/2026', SegmentDate: '01/09/2026', SegmentStarttime: '09:15', Segmentduration: '08:00', Memo: 'TAA Updated shift' },
  ];
  const otConversionCorrections = [
    { Code: '10', ID: '888', SegmentCode: 'OT1', nominateDate: '01/09/2026', SegmentDate: '01/09/2026', SegmentStarttime: '17:00', Segmentduration: '01:00', Memo: 'TAA Original OT1' },
    { Code: '11', ID: '888', SegmentCode: 'SHIFT', nominateDate: '01/09/2026', SegmentDate: '01/09/2026', SegmentStarttime: '17:00', Segmentduration: '01:00', Memo: 'TAA OT1 converted to SHIFT' },
  ];
  // 3. A row carrying a genuine 'shift' pair, but whose final category is
  // MARKED_ABSENT (the flex Branch B shape) — must appear in BOTH sheets.
  const shiftChangedAbsentRow = {
    ...output.rows[0],
    id: 'wp4-shift-absent',
    originalCognos: { ...output.rows[0].originalCognos, 'PF NO': 'WP4-SHIFT-ABSENT', NAME: 'WP4 Shift Absent Test' },
    TAA_RESULT_CATEGORY: 'MARKED_ABSENT',
    TAA_ACTIONS_FIRED: 'LATE_AND_COVER',
    holdReason: undefined,
    details: { ...output.rows[0].details, generatedCorrections: shiftPairCorrections },
  } as ReconciliationRow;
  // 4. A row carrying only an OT-conversion pair (uppercase 'SHIFT'/'OT1')
  // must NOT be pulled into Shift Changed.
  const otConversionRow = {
    ...output.rows[0],
    id: 'wp4-ot-conversion',
    originalCognos: { ...output.rows[0].originalCognos, 'PF NO': 'WP4-OT-CONVERSION', NAME: 'WP4 OT Conversion Test' },
    TAA_RESULT_CATEGORY: 'NO_ACTION_REQUIRED',
    TAA_ACTIONS_FIRED: 'ADJUST_OT_RLS',
    holdReason: undefined,
    details: { ...output.rows[0].details, generatedCorrections: otConversionCorrections },
  } as ReconciliationRow;

  const testRows = [...output.rows, shiftChangedAbsentRow, otConversionRow];
  const sheets = buildResultsWorkbookSheets(testRows, output.emailActions);
  const shiftChangedIds = new Set(sheets.find(s => s.name === '1. Shift Changed')!.rows.slice(1).map(r => r[2] + '|' + r[3]));
  const absentIds = new Set(sheets.find(s => s.name === '3. Absent')!.rows.slice(1).map(r => r[2] + '|' + r[3]));
  const employeeDateKey = (r: ReconciliationRow) => `${r.originalCognos['NAME'] || 'Staff'}\nPF: ${r.originalCognos['PF NO'] || ''} • CMS: ${r.originalCognos['LOGIN ID'] || ''} • Sec: ${r.originalCognos['SECTION'] || ''}|${(r.originalCognos['SIGN IN DATE'] || '').split(' ')[0]}`;

  assert.ok(shiftChangedIds.has(employeeDateKey(shiftChangedAbsentRow)), 'a MARKED_ABSENT row with a genuine shift pair must appear in "1. Shift Changed" (D15)');
  assert.ok(absentIds.has(employeeDateKey(shiftChangedAbsentRow)), 'the same row must still appear in "3. Absent" — Must Check/Shift Changed are duplicate views, never a move');
  assert.ok(!shiftChangedIds.has(employeeDateKey(otConversionRow)), 'an OT-conversion 10/11 pair (SegmentCode OT1/SHIFT) must NOT be pulled into "1. Shift Changed" (D15 trap 1)');
}

// 5/6. Must Check membership (D19/B7/B12) — both clauses, exercised
// independently so a predicate missing either one is caught.
{
  // 5. Forced-hold row with ZERO corrections (trap 2: the shape D19 exists
  // for — ABSENT_MARKED_BUT_ATTENDED/STILL_CLOCKED_IN stop before any
  // correction is built).
  const forcedNoCorrections = {
    ...output.rows[0],
    id: 'wp4-forced-empty',
    originalCognos: { ...output.rows[0].originalCognos, 'PF NO': 'WP4-FORCED-EMPTY', NAME: 'WP4 Forced Empty Test' },
    holdReason: 'STILL_CLOCKED_IN',
    details: { ...output.rows[0].details, generatedCorrections: [] },
  } as ReconciliationRow;
  // 6. Held (soft), non-forced row proposing a pay-affecting correction
  // (blocked penalty) — must qualify.
  const heldBlockedPenalty = {
    ...output.rows[0],
    id: 'wp4-held-blocked',
    originalCognos: { ...output.rows[0].originalCognos, 'PF NO': 'WP4-HELD-BLOCKED', NAME: 'WP4 Held Blocked Test' },
    holdReason: 'MISMATCH_FOUND',
    details: {
      ...output.rows[0].details,
      generatedCorrections: [
        { Code: '00', ID: '777', SegmentCode: 'ABSENT', nominateDate: '01/09/2026', SegmentDate: '', SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Absent' },
      ],
    },
  } as ReconciliationRow;
  // Control: an identical proposed correction, but with NO hold — must be
  // excluded (nothing is actually blocked; it will reach payroll normally).
  const unheldSamePenalty = {
    ...output.rows[0],
    id: 'wp4-unheld-control',
    originalCognos: { ...output.rows[0].originalCognos, 'PF NO': 'WP4-UNHELD-CONTROL', NAME: 'WP4 Unheld Control Test' },
    holdReason: undefined,
    details: {
      ...output.rows[0].details,
      generatedCorrections: [
        { Code: '00', ID: '666', SegmentCode: 'ABSENT', nominateDate: '01/09/2026', SegmentDate: '', SegmentStarttime: '', Segmentduration: '', Memo: 'TAA Absent' },
      ],
    },
  } as ReconciliationRow;

  const sheets = buildResultsWorkbookSheets([forcedNoCorrections, heldBlockedPenalty, unheldSamePenalty], []);
  const mustCheckIds = new Set(sheets.find(s => s.name === 'Must Check')!.rows.slice(1).map(r => r[2] + '|' + r[3]));
  const key = (r: ReconciliationRow) => `${r.originalCognos['NAME'] || 'Staff'}\nPF: ${r.originalCognos['PF NO'] || ''} • CMS: ${r.originalCognos['LOGIN ID'] || ''} • Sec: ${r.originalCognos['SECTION'] || ''}|${(r.originalCognos['SIGN IN DATE'] || '').split(' ')[0]}`;

  assert.ok(mustCheckIds.has(key(forcedNoCorrections)), 'a forced-hold row with zero corrections must appear in Must Check (trap 2)');
  assert.ok(mustCheckIds.has(key(heldBlockedPenalty)), 'a held row proposing a blocked absence marker must appear in Must Check');
  assert.ok(!mustCheckIds.has(key(unheldSamePenalty)), 'an identical, unheld row must NOT appear in Must Check — nothing is actually blocked');
}

// ===== WP8/A4 (2026-09-22) — mechanising the five invariants that were
// previously true only "by inspection" (Appendix B, plan
// c-users-lenovo-desktop-taa-audit-output-declarative-kazoo.md). =====

// Invariant 7 — forced/releasable hold-code split integrity. holdReasons.ts
// states itself as the sole source of truth; this pins the exact 21/7 split,
// that the two sets never overlap, and — via the compile-time exhaustiveness
// guard right below this block — that no HoldReasonCode can ever be added to
// the union without landing in one of the two sets. An "orphan" code (neither
// forced nor releasable) would silently behave as releasable everywhere
// isForcedHoldReason() is the payroll-lock gate, which is exactly the defect
// this guards against.
const RELEASABLE_HOLD_REASONS_INV7: HoldReasonCode[] = [
  'MISMATCH_FOUND',
  'MIXED_LEAVE_AND_WORK_SEGMENTS',
  'PUBLIC_HOLIDAY_SHIFT_MISCODED',
  'AMBIGUOUS_OVERLAPPING_ADDITION_SEGMENTS',
  'DURATION_TEXT_REPAIRED_FROM_TIMESTAMPS',
  'FULL_DAY_REMOVAL_ON_SCHEDULED_DAY',
  'TECHNICAL_SEGMENT_COVERS_VARIANCE',
];
{
  assert.equal(FORCED_HOLD_REASONS.size, 21, 'FORCED_HOLD_REASONS must stay at exactly 21 codes (invariant 7)');
  assert.equal(RELEASABLE_HOLD_REASONS_INV7.length, 7, 'the releasable set must stay at exactly 7 codes (invariant 7)');

  for (const code of RELEASABLE_HOLD_REASONS_INV7) {
    assert.ok(!FORCED_HOLD_REASONS.has(code), `${code} must not also be in FORCED_HOLD_REASONS — no overlap`);
    assert.ok(!isForcedHoldReason(code), `${code} must resolve as releasable via isForcedHoldReason`);
  }
  const releasableSetInv7 = new Set<string>(RELEASABLE_HOLD_REASONS_INV7);
  for (const code of FORCED_HOLD_REASONS) {
    assert.ok(!releasableSetInv7.has(code), `${code} must not also be releasable — no overlap`);
    assert.ok(isForcedHoldReason(code), `${code} must resolve as forced via isForcedHoldReason`);
  }

  const allHoldReasonCodesInv7 = [...Array.from(FORCED_HOLD_REASONS), ...RELEASABLE_HOLD_REASONS_INV7];
  assert.equal(allHoldReasonCodesInv7.length, 28, 'forced (21) + releasable (7) must equal the full HoldReasonCode union (28) — zero orphans');
  assert.equal(new Set(allHoldReasonCodesInv7).size, 28, 'no code may be counted twice across the two sets');
}
// Compile-time-only exhaustiveness guard (enforced by `npm run lint`, i.e.
// `tsc --noEmit`, not at runtime): the bracketed, non-distributive `extends`
// check below only resolves to `true` if EVERY member of the HoldReasonCode
// union is present in RELEASABLE_HOLD_REASONS_INV7 union'd with
// FORCED_HOLD_REASONS's own runtime membership (represented here by
// listing FORCED_HOLD_REASONS's codes literally, kept identical to
// holdReasons.ts by the runtime assert.equal(..., 21) above). If
// types/taa.ts ever adds a new HoldReasonCode member without also adding it
// to one of the two lists, this line stops compiling — an orphan can never
// silently ship.
type ForcedHoldReasonCodesInv7 =
  | 'COGNOS_DATA_GAP' | 'UNCLASSIFIED_SEGMENT_CODE' | 'INSUFFICIENT_CMS_COVERAGE'
  | 'UNPARSEABLE_SIGN_IN_DATE' | 'MISSING_CMS_JOIN_KEY' | 'AMBIGUOUS_PUNCH_ATTRIBUTION'
  | 'REMOVAL_SEGMENT_OUTSIDE_SHIFT_WINDOW' | 'MID_SHIFT_REMOVAL_SEGMENT'
  | 'REMOVAL_SEGMENT_DURATION_UNKNOWN' | 'SEGMENT_STOP_DURATION_DISAGREE'
  | 'AMBIGUOUS_OVERLAPPING_REMOVAL_DURATION' | 'NO_LOGIN_MANUAL_REVIEW_CONFIGURED'
  | 'CONTESTED_SINGLE_PUNCH' | 'INVALID_ASPECT_DATETIME' | 'INVALID_CONFIG_TIME'
  | 'INVALID_CONFIG_VALUE' | 'FLEX_SCHEDULE_OUTSIDE_WINDOW' | 'NEGATIVE_NET_SCHEDULE_MINUTES'
  | 'CONFLICTING_IDENTITY_RECORD' | 'STILL_CLOCKED_IN' | 'ABSENT_MARKED_BUT_ATTENDED';
type AllListedHoldReasonCodesInv7 = ForcedHoldReasonCodesInv7 | (typeof RELEASABLE_HOLD_REASONS_INV7)[number];
type _Inv7ExhaustivenessGuard = [HoldReasonCode] extends [AllListedHoldReasonCodesInv7] ? true : never;
const _inv7ExhaustivenessGuard: _Inv7ExhaustivenessGuard = true;
void _inv7ExhaustivenessGuard;

// Invariant 1 — no hardcoded bands. The only honest test is behavioural:
// mutate a band boundary in a deep-cloned config and prove the engine's
// fired/not-fired boundary moves with it, never touching DEFAULT_CONFIG or
// samples_Files/Config.json. Uses a minimal one-row fixture in the same shape
// regressionSuite.ts's own `boundary()` helper builds (fixed 07:00-15:00
// shift, OPS tier).
{
  const D = '27/08/2026';
  const OPS_ID = '9800001';
  const makeDtInv1 = (dateStr: string, timeStr: string) => {
    const [d, m, y] = dateStr.split('/').map(Number);
    const [hh, mm, ss] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, ss || 0);
  };
  const buildOneRowFixture = (loginTime: string, logoutTime: string) => {
    const cognos = {
      'SIGN IN DATE': '2026-08-27 00:00:00', SECTION: 'ECS', 'PF NO': OPS_ID,
      NAME: 'Inv1 OPS', 'LOGIN ID': '98001',
      DUTY1: '07:00 - 15:00', OT1: '', 'DUTY-2': '', 'OT-2': '',
      'SCH DURATION': '8:0', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
      'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '',
    };
    const shift = {
      EMP_ID: OPS_ID, NOM_DATE: D, START_DATE: D, SEG_CODE: 'SHIFT',
      START_MOMENT: D + ' 07:00:00', STOP_MOMENT: D + ' 15:00:00', DURATION: 480,
    };
    const identities = [{ EMP_ID: OPS_ID, EMP_LAST_NAME: 'Inv1', EMP_EXTRA_2: 'inv1ops', EMP_SORT_NAME: 'INV1 OPS AGENT' }];
    const punches = [
      { Date: D, LoginID: '98001', LoginDateTime: makeDtInv1(D, loginTime), LogoutDateTime: makeDtInv1(D, loginTime) },
      { Date: D, LoginID: '98001', LoginDateTime: makeDtInv1(D, logoutTime), LogoutDateTime: makeDtInv1(D, logoutTime) },
      // WP8: an unrelated login punching late that same day — keeps this single-row fixture's
      // day from reading as a truncated export (the new truncated-export coverage gate in
      // reconciliationEngine.ts judges coverage against the WHOLE export, not just this login;
      // a real multi-employee CMS file always has someone else punching later in the day).
      { Date: D, LoginID: 'sentinel-export-open', LoginDateTime: makeDtInv1(D, '23:30:00'), LogoutDateTime: makeDtInv1(D, '23:30:03') },
    ];
    return { cognosRecords: [cognos], aspectSegments: [shift], aspectIdentities: identities, cmsPunches: punches };
  };

  // (a) OPS Late Login band 1: shipped minMinutes=6. Shift OPS band-1 min to
  // 8 in a deep-cloned config; a 7-minute lateness (which fires LATE_AND_COVER
  // against the shipped 6-min band) must fire nothing under the mutated band.
  {
    const lateFixture = buildOneRowFixture('07:07:00', '15:00:00'); // 7 min late, on-time out
    const underShipped = runReconciliation({ processingDate: SUITE_RUN_DATE, ...lateFixture, config: DEFAULT_CONFIG });
    assert.equal(underShipped.rows[0].TAA_ACTION, 'LATE_AND_COVER', 'guard: 7 min late must fire LATE_AND_COVER under the shipped OPS band (min 6)');

    const mutatedLateConfig: ConfigRegistry = {
      ...DEFAULT_CONFIG,
      policyRules: DEFAULT_CONFIG.policyRules.map(r =>
        (r.id === 'rule-late-ops-band1') ? { ...r, minMinutes: 8 } : r),
    };
    assert.ok(
      mutatedLateConfig.policyRules.some(r => r.id === 'rule-late-ops-band1' && r.minMinutes === 8),
      'guard: the OPS Late Login band-1 rule must actually exist and be mutated to minMinutes=8',
    );
    const underMutated = runReconciliation({ processingDate: SUITE_RUN_DATE, ...lateFixture, config: mutatedLateConfig });
    assert.equal(
      underMutated.rows[0].TAA_ACTION, 'NO_ACTION',
      'invariant 1: a 7-minute lateness must stop firing once the config band boundary moves to 8 — the boundary must live in config, not code',
    );
  }

  // (b) OPS Early Logout band 1: shipped minMinutes=5. Shift OPS band-1 min
  // to 7 in a deep-cloned config; a 6-minute early logout (which fires
  // LOGOFF_AND_COVER against the shipped 5-min band) must fire nothing under
  // the mutated band.
  {
    const earlyFixture = buildOneRowFixture('07:00:00', '14:54:00'); // on time in, 6 min early out
    const underShipped = runReconciliation({ processingDate: SUITE_RUN_DATE, ...earlyFixture, config: DEFAULT_CONFIG });
    assert.equal(underShipped.rows[0].TAA_ACTION, 'LOGOFF_AND_COVER', 'guard: 6 min early logout must fire LOGOFF_AND_COVER under the shipped OPS band (min 5)');

    const mutatedEarlyConfig: ConfigRegistry = {
      ...DEFAULT_CONFIG,
      policyRules: DEFAULT_CONFIG.policyRules.map(r =>
        (r.id === 'rule-earlyout-ops-band1') ? { ...r, minMinutes: 7 } : r),
    };
    assert.ok(
      mutatedEarlyConfig.policyRules.some(r => r.id === 'rule-earlyout-ops-band1' && r.minMinutes === 7),
      'guard: the OPS Early Logout band-1 rule must actually exist and be mutated to minMinutes=7',
    );
    const underMutated = runReconciliation({ processingDate: SUITE_RUN_DATE, ...earlyFixture, config: mutatedEarlyConfig });
    assert.equal(
      underMutated.rows[0].TAA_ACTION, 'NO_ACTION',
      'invariant 1: a 6-minute early logout must stop firing once the config band boundary moves to 7 — the boundary must live in config, not code',
    );
  }

  // DEFAULT_CONFIG itself must never be mutated by the above — guard the guard.
  assert.equal(DEFAULT_CONFIG.policyRules.find(r => r.id === 'rule-late-ops-band1')?.minMinutes, 6, 'guard: DEFAULT_CONFIG must be untouched after the invariant-1 mutation tests');
  assert.equal(DEFAULT_CONFIG.policyRules.find(r => r.id === 'rule-earlyout-ops-band1')?.minMinutes, 5, 'guard: DEFAULT_CONFIG must be untouched after the invariant-1 mutation tests');
}

// Invariant 11 — no new persistence service. Structural assertion over the
// actual src/ tree (not the plan's a-priori list, which named
// reconciliationEngine.ts — checked against live source, that module carries
// no localStorage/indexedDB/sessionStorage reference at all; the true set is
// configRegistry.ts (config persistence) and App.tsx (a single cosmetic
// sidebar-collapsed UI preference, not review state or a new persistence
// mechanism), plus this file's own real-data replay stub added below for
// invariants 4/5 (Node has no localStorage; the stub is test-only setup, not
// product code). Any other module referencing browser storage is a finding,
// not silently accepted.
{
  const PERSISTENCE_PATTERN = /\b(localStorage|indexedDB|sessionStorage)\b/;
  const ALLOWED_PERSISTENCE_FILES = new Set([
    path.join('src', 'services', 'configRegistry.ts'),
    path.join('src', 'App.tsx'),
    path.join('src', 'services', 'configExportImport.test.ts'), // Node-side localStorage stub for headless testing only
    path.join('src', 'services', 'featureCompletion.test.ts'), // this file's own real-replay localStorage stub
    path.join('src', 'services', 'holdPolicy.test.ts'), // Node-side localStorage stub for headless testing only (importConfigFromJson)
  ]);
  const srcRoot = path.resolve(process.cwd(), 'src');
  const foundFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf-8');
      if (PERSISTENCE_PATTERN.test(content)) foundFiles.push(path.relative(process.cwd(), full));
    }
  };
  walk(srcRoot);
  assert.ok(foundFiles.length > 0, 'guard: at least configRegistry.ts must reference localStorage, or this structural check is vacuous');
  const unexpected = foundFiles.filter(f => !ALLOWED_PERSISTENCE_FILES.has(f));
  assert.deepEqual(unexpected, [], `invariant 11: localStorage/indexedDB/sessionStorage usage must stay confined to the known modules — found unexpected usage in: ${unexpected.join(', ')}`);
}

// Invariants 4 & 5 — checked against the full real-data replay (the same
// committed, data-set-independent load path as scripts/replay-real.ts — see
// scripts/sampleFiles.ts, launch-readiness.md Step 2), not a single hand-built
// fixture. Skips with a clear message, rather than failing, when samples_Files/
// is genuinely absent (e.g. a fresh checkout without the read-only sample data).
const SAMPLES_DIR = resolveSamplesDir([]);
if (!samplesAvailable(SAMPLES_DIR)) {
  console.log(`SKIPPED real-sample invariants 4 & 5: samples_Files/ not found or incomplete at ${SAMPLES_DIR}.`);
} else {
  if (typeof (globalThis as any).localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  const decode = (p: string): string => {
    const buf = fs.readFileSync(p);
    return decodeFileBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  };
  const realConfig = importConfigFromJson(fs.readFileSync(path.join(SAMPLES_DIR, 'Config.json'), 'utf-8'));
  const realCognos = parseCognosReport(decode(findCognosFile(SAMPLES_DIR)), realConfig.cognosDropPatterns);
  const realAspectSegments = parseAspectSegments(decode(path.join(SAMPLES_DIR, 'MTD_Seg.csv')));
  const realAspectIdentities = parseAspectIdentity(decode(path.join(SAMPLES_DIR, 'employeeinfo.csv')));
  let realCmsRaw: ReturnType<typeof dedupeCmsPunches> = [];
  let realCmsRawTotal = 0;
  for (const f of listCmsFiles(SAMPLES_DIR)) {
    const res = validateCmsFile(decode(f), path.basename(f));
    if ('reason' in res) throw new Error(`real CMS fixture ${f} failed to validate: ${res.reason}`);
    realCmsRawTotal += res.punches.length;
    realCmsRaw = realCmsRaw.concat(res.punches);
  }
  const realCms = dedupeCmsPunches(realCmsRaw);

  // Invariants derived from the files themselves (launch-readiness.md Step 2), not
  // pinned to one specific week's counts — nothing is silently dropped between
  // "parsed" and "raw across files".
  assert.ok(realCognos.length > 0, 'guard: real replay must actually parse at least one Cognos row, or invariants 4/5 are untested');
  assert.ok(realCmsRawTotal > 0, 'guard: real replay must actually parse at least one raw CMS punch, or invariants 4/5 are untested');
  assert.ok(realCms.length <= realCmsRawTotal, 'guard: dedupeCmsPunches must only ever remove or keep punches, never add');

  // Processing date must land on/after the newest Cognos row date for the run to be
  // meaningful — 24/09/2026 is the documented primary run date for the current sample
  // set (launch-readiness.md facts). Not itself an invariant on the DATA, just the
  // fixed, reproducible anchor this replay always uses (same reasoning as
  // scripts/replay-real.ts's required --date argument).
  const realOut = runReconciliation({
    processingDate: new Date(2026, 8, 24), // 24/09/2026
    cognosRecords: realCognos, aspectSegments: realAspectSegments, aspectIdentities: realAspectIdentities,
    cmsPunches: realCms, config: realConfig,
  });
  assert.ok(realOut.rows.length > 0, 'guard: real replay must produce at least one row, or invariants 4/5 are untested');
  assert.ok(realOut.rows.length <= realCognos.length, 'guard: every row must trace back to a parsed Cognos record');

  // Only the corrections that actually reach the payroll CSV — the same
  // filter generateAspectCorrectionsCsv's real callers apply (App.tsx /
  // the existing aspectCsv assertion above) — held rows never export.
  const emittedCorrections = realOut.rows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections);

  // Invariant 5 — 10/11 pairs stay adjacent and complete; never export half a
  // pair. Scanned off the actual generated ASPECT CSV (post-dedupe, the exact
  // bytes that would be uploaded to ASPECT), using the file's own
  // quote-aware parseCsvLine so a Memo containing a comma cannot desync the
  // column read.
  {
    const realCsv = generateAspectCorrectionsCsv(emittedCorrections);
    const csvRows = realCsv.split('\n').filter(l => l.length > 0).map(parseCsvLine);
    assert.ok(csvRows.some(r => r[0] === '10'), 'guard: the real dataset must actually emit at least one Code:10 row, or invariant 5 is untested');
    let pairCount = 0;
    for (let i = 0; i < csvRows.length; i++) {
      const r = csvRows[i];
      if (r[0] === '10') {
        const next = csvRows[i + 1];
        assert.ok(
          next && next[0] === '11' && next[1] === r[1] && next[3] === r[3],
          `invariant 5: Code:10 row (ID ${r[1]}, date ${r[3]}) at CSV line ${i} must be immediately followed by its Code:11 partner for the same employee/date`,
        );
        pairCount++;
      } else if (r[0] === '11') {
        const prev = csvRows[i - 1];
        assert.ok(
          prev && prev[0] === '10' && prev[1] === r[1] && prev[3] === r[3],
          `invariant 5: Code:11 row (ID ${r[1]}, date ${r[3]}) at CSV line ${i} must be immediately preceded by its Code:10 partner for the same employee/date`,
        );
      }
    }
    assert.ok(pairCount > 0, 'guard: at least one complete 10/11 pair must have been checked');
    // MUTATION-TEST OUTCOME (manual, not run automatically — see the WP8/A4
    // report): dedupeAspectCorrections() in reconciliationEngine.ts was
    // temporarily edited (marked with an inline temporary-mutation comment,
    // since removed) to drop every Code:11 row before returning. Re-running
    // this test against that mutation failed exactly the assertion above
    // (orphaned Code:10 row with no Code:11 partner). The mutation was then
    // reverted byte-for-byte and this test passes again — see the WP8/A4
    // report for the before/after diff and the empty temporary-marker grep.
  }

  // Invariant 4 — every emitted LATE/Log_off correction keeps an equal-
  // duration COVER. Matched per ROW (r.details.generatedCorrections), NOT per
  // employee+nominateDate — confirmed against a real failing case
  // (rec-48-4507957, 18/09/2026) that a cover for a 9-minute LATE can land on
  // a nominateDate/SegmentDate a week later (coverFallbackWhenNoWorkingDayFound /
  // the run-date floor — see Appendix A case 4), so the LATE and its COVER
  // share a row but never share a nominateDate. Duration multiplicities are
  // still respected (not just "some cover exists"), so two timed actions of
  // different lengths on the same row cannot silently share one cover.
  {
    const timedActions = emittedCorrections.filter(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off');
    assert.ok(timedActions.length > 0, 'guard: the real dataset must actually emit LATE/Log_off corrections, or invariant 4 is untested');

    for (const row of realOut.rows) {
      if (!row.includeInOutput) continue;
      const rowCorrections = row.details.generatedCorrections;
      const timed = rowCorrections.filter(c => c.SegmentCode === 'LATE' || c.SegmentCode === 'Log_off');
      if (timed.length === 0) continue;
      const covers = rowCorrections.filter(c => c.SegmentCode === 'COVER');
      const coverDurationCounts = new Map<string, number>();
      for (const c of covers) coverDurationCounts.set(c.Segmentduration, (coverDurationCounts.get(c.Segmentduration) || 0) + 1);
      for (const t of timed) {
        const remaining = coverDurationCounts.get(t.Segmentduration) || 0;
        assert.ok(
          remaining > 0,
          `invariant 4: row ${row.id} ${t.SegmentCode} (duration ${t.Segmentduration}) has no matching-duration COVER on the same row among [${covers.map(c => c.Segmentduration).join(', ') || 'none'}]`,
        );
        coverDurationCounts.set(t.Segmentduration, remaining - 1);
      }
    }
  }

  // samples_Files/ must stay read-only for this audit — this block only ever
  // reads from SAMPLES_DIR via fs.readFileSync above, never fs.writeFileSync.
} // end samplesAvailable(SAMPLES_DIR) else-branch

console.log('Feature completion tests passed.');
