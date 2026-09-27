/**
 * Unseen-punch audit — runs AFTER runReconciliation, as a pure post-processing step over its
 * output. It never modifies reconciliationEngine.ts / punchAttribution.ts / scheduleRecompute.ts
 * (those files are byte-identical to before this feature); it only calls their exported
 * functions and, where the engine's own internal window-building logic is needed for a
 * candidate search that covers ASPECT dates the engine itself never builds windows for (every
 * ASPECT day, not just Cognos rows), that logic is replicated here read-only, per
 * reconciliationEngine.ts:560-588 (kept in sync by comment reference, not by import — the
 * engine has no exported "build one window" helper to call instead).
 *
 * See plans/just-think-with-me-greedy-jellyfish.md for the full design.
 */
import {
  AspectCorrectionRow,
  AspectIdentity,
  AspectSegment,
  CMSPunch,
  CognosRecord,
  ConfigRegistry,
  EmailActionItem,
  ReconciliationRow,
} from '../types/taa';
import {
  ReconciliationInput,
  ReconciliationOutput,
  runReconciliation,
  isFlexStaff,
  isFlexScheduleWithinExpectedWindow,
  rowIsMustCheck,
} from './reconciliationEngine';
import { recomputeDaySchedule } from './scheduleRecompute';
import { attributePunches, ScheduledWindow } from './punchAttribution';
import { parseDateTimeString, formatDateDDMMYYYY, formatTimeHHMM, normalizeDateKey, addDays } from './parsers';
import { rebuildOutputs } from './outputRebuild';
import { applyEmailTemplate } from './emailDrafts';

/** One ASPECT-derived scheduled window used only by this audit's candidate search — the
 * superset of reconciliationEngine.ts's own `windows` array (Pass 1), built for EVERY
 * EMP_ID x NOM_DATE combination present in the ASPECT export, not just the Cognos rows in
 * this run. Extends ScheduledWindow (punchAttribution.ts) so it can be fed straight into
 * attributePunches unchanged. */
interface AuditWindow extends ScheduledWindow {
  pfNo: string;
  nomDateStr: string; // DD/MM/YYYY, canonical (normalizeDateKey)
}

/** Mirrors reconciliationEngine.ts Pass 1 (lines ~556-588): recompute one EMP_ID/day from its
 * ASPECT segments, and build the same real-shift or synthetic-leave-day window shape,
 * including the flex attributionEnd extension. Returns null for a genuine data gap (no
 * resolvable window at all) — same as the engine building no window for that row. */
function buildAuditWindow(
  pfNo: string,
  nomDateStr: string,
  loginId: string,
  segs: AspectSegment[],
  identity: AspectIdentity | undefined,
  config: ConfigRegistry,
): AuditWindow | null {
  const recompute = recomputeDaySchedule(segs, config);
  if (recompute.rawStart && recompute.rawEnd) {
    let attributionEnd = recompute.rawEnd;
    if (isFlexStaff(identity, config) && isFlexScheduleWithinExpectedWindow(recompute.rawStart, config)) {
      const cutoffTimeStr = config.flexCutoffTime || '10:00';
      const [ch, cm] = cutoffTimeStr.split(':').map(Number);
      const cutoffOnRawStartDay = new Date(
        recompute.rawStart.getFullYear(), recompute.rawStart.getMonth(), recompute.rawStart.getDate(), ch, cm, 0
      );
      const pushMs = Math.max(0, cutoffOnRawStartDay.getTime() - recompute.rawStart.getTime());
      attributionEnd = new Date(recompute.rawEnd.getTime() + pushMs);
    }
    return {
      key: `audit-${pfNo}-${nomDateStr}`, pfNo, nomDateStr, loginId,
      rawStart: recompute.rawStart, rawEnd: recompute.rawEnd, attributionEnd, isSynthetic: false,
    };
  }
  if (recompute.isLeaveDay) {
    const dayParsed = parseDateTimeString(nomDateStr);
    if (!dayParsed) return null;
    const dayStart = new Date(dayParsed.getFullYear(), dayParsed.getMonth(), dayParsed.getDate(), 0, 0, 0);
    const rawEnd = addDays(dayStart, 1);
    return {
      key: `audit-${pfNo}-${nomDateStr}`, pfNo, nomDateStr, loginId,
      rawStart: dayStart, rawEnd, attributionEnd: rawEnd, isSynthetic: true,
    };
  }
  return null; // genuine data gap for this employee-day — no window, same as the engine.
}

/** Every EMP_ID x NOM_DATE window the ASPECT export supports, for logins that appear in this
 * run's Cognos rows (G1: "keep only punches whose owner is a Cognos row in this run" starts
 * here — an ASPECT day for a person entirely absent from this Cognos run has no loginId to
 * resolve, so it is skipped). This is the neighbour-window set candidate detection uses to
 * decide which shift/leave-day an unclaimed punch actually belongs to. */
function buildAllAspectWindows(
  aspectSegments: AspectSegment[],
  pfNoToLoginId: Map<string, string>,
  identityMap: Map<string, AspectIdentity>,
  config: ConfigRegistry,
): AuditWindow[] {
  const groups = new Map<string, AspectSegment[]>();
  aspectSegments.forEach(seg => {
    const pfNo = (seg.EMP_ID || '').trim();
    const dateKey = normalizeDateKey(seg.NOM_DATE);
    if (!pfNo || !dateKey) return;
    const key = `${pfNo}|${dateKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(seg);
  });
  const windows: AuditWindow[] = [];
  groups.forEach((segs, key) => {
    const sep = key.indexOf('|');
    const pfNo = key.slice(0, sep);
    const nomDateStr = key.slice(sep + 1);
    const loginId = pfNoToLoginId.get(pfNo);
    if (!loginId) return;
    const w = buildAuditWindow(pfNo, nomDateStr, loginId, segs, identityMap.get(pfNo), config);
    if (w) windows.push(w);
  });
  return windows;
}

/** Distance from timestamp t to interval [start, end] — 0 if inside, else distance to the
 * nearer edge. Mirrors punchAttribution.ts's distanceToInterval (kept private there). */
function distanceToInterval(t: number, start: number, end: number): number {
  if (t >= start && t <= end) return 0;
  return Math.min(Math.abs(t - start), Math.abs(t - end));
}

/** G1 owner rule: the nearest ASPECT window of this punch's own login, WITHOUT the live
 * ±cmsPunchSearchWindowHours radius gate (unclaimed punches are by definition already outside
 * every window's radius) — this only decides ownership among the person's own days. Mirrors
 * punchAttribution.ts's tie-break order (real shift beats synthetic leave day, then earlier
 * start) and its leave-day rule: a synthetic full-day window never takes a punch whose login
 * time is before that day started (punchAttribution.ts ~190-194). */
function nearestWindow(punch: CMSPunch, windows: AuditWindow[]): { window: AuditWindow; distanceMs: number } | null {
  const candidates = [punch.LoginDateTime, punch.LogoutDateTime]
    .filter((d): d is Date => d !== null)
    .map(d => d.getTime());
  let bestDist = Infinity;
  let tied: AuditWindow[] = [];
  for (const w of windows) {
    if (w.isSynthetic && punch.LoginDateTime.getTime() < w.rawStart.getTime()) continue;
    let localBest = Infinity;
    for (const t of candidates) {
      const d = distanceToInterval(t, w.rawStart.getTime(), w.attributionEnd.getTime());
      if (d < localBest) localBest = d;
    }
    if (localBest === Infinity) continue;
    if (localBest < bestDist) { bestDist = localBest; tied = [w]; }
    else if (localBest === bestDist) tied.push(w);
  }
  if (tied.length === 0) return null;
  if (tied.length === 1) return { window: tied[0], distanceMs: bestDist };
  const realShifts = tied.filter(w => !w.isSynthetic);
  const pool = realShifts.length > 0 ? realShifts : tied;
  const sorted = [...pool].sort((a, b) => a.rawStart.getTime() - b.rawStart.getTime());
  return { window: sorted[0], distanceMs: bestDist };
}

/** Mirrors reconciliationEngine.ts Pass 1 exactly, scoped to one person's Cognos rows (used
 * both for the what-if re-run's own input construction context and for the G2 steal check,
 * which needs the SAME window shapes the engine would build for this person, independent of
 * search radius — only attributePunches's radius changes between the base and what-if checks). */
function buildCognosRowWindows(
  cognosSubset: CognosRecord[],
  aspectSegments: AspectSegment[],
  identityMap: Map<string, AspectIdentity>,
  config: ConfigRegistry,
): ScheduledWindow[] {
  const segmentGroups = new Map<string, AspectSegment[]>();
  aspectSegments.forEach(seg => {
    const dateKey = normalizeDateKey(seg.NOM_DATE);
    const key = `${(seg.EMP_ID || '').trim()}|${dateKey}`;
    if (!segmentGroups.has(key)) segmentGroups.set(key, []);
    segmentGroups.get(key)!.push(seg);
  });
  const windows: ScheduledWindow[] = [];
  cognosSubset.forEach((cognos, idx) => {
    const pfNo = (cognos['PF NO'] || '').trim();
    const loginId = (cognos['LOGIN ID'] || '').trim();
    const signInParsed = parseDateTimeString((cognos['SIGN IN DATE'] || '').trim());
    if (!signInParsed) return;
    const nomDateStr = formatDateDDMMYYYY(signInParsed);
    const segs = segmentGroups.get(`${pfNo}|${nomDateStr}`) || [];
    const w = buildAuditWindow(pfNo, nomDateStr, loginId, segs, identityMap.get(pfNo), config);
    if (w) windows.push({ ...w, key: `cg-${idx}` });
  });
  return windows;
}

/** True for an isolated punch under 60s (login/logout essentially the same instant) — flagged
 * like any other candidate (user decision: a stray swipe is not filtered out), just annotated
 * "possible stray swipe" in the note. */
function isStraySwipe(punch: CMSPunch): boolean {
  if (!punch.LogoutDateTime) return false;
  return Math.abs(punch.LogoutDateTime.getTime() - punch.LoginDateTime.getTime()) < 60_000;
}

// Memo is a free-text audit-trail comment (often embedding the same measured-minutes narrative
// as details.ruleFired), never a field ASPECT itself imports/acts on — Code/SegmentCode/
// nominateDate/SegmentDate/SegmentStarttime/Segmentduration are the payroll-relevant fields. A
// correction that is byte-identical on every field EXCEPT Memo is the same correction with a
// different explanation, i.e. a REASON difference, not an OUTCOME one (confirmed against real
// data: 67457/18-09 differs only in Memo — "Early Logout 489m" vs "Late Logout 478m" — with
// every other field, and TAA_VERDICT/TAA_ACTION, identical).
function correctionsEqual(a: ReconciliationRow['details']['generatedCorrections'], b: ReconciliationRow['details']['generatedCorrections']): boolean {
  const strip = (rows: ReconciliationRow['details']['generatedCorrections']) =>
    rows.map(({ Memo, ...rest }) => rest);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Step 2's comparison rule, exported standalone so it's directly unit-testable against
 * synthetic before/after rows (see regressionSuite.ts's unseen-* REASON/OUTCOME cases) without
 * needing to coerce the full engine into a specific rare rule-firing state: TAA_VERDICT,
 * TAA_ACTION, or the ASPECT corrections differing is an OUTCOME difference; details.ruleFired
 * differing alone is a REASON difference; identical on all four is null (case 7 — not flagged).
 */
export function classifyUnseenPunchDiff(
  baseRow: Pick<ReconciliationRow, 'TAA_VERDICT' | 'TAA_ACTION' | 'details'>,
  whatIfRow: Pick<ReconciliationRow, 'TAA_VERDICT' | 'TAA_ACTION' | 'details'>,
): 'REASON' | 'OUTCOME' | null {
  const outcomeChanged =
    baseRow.TAA_VERDICT !== whatIfRow.TAA_VERDICT ||
    baseRow.TAA_ACTION !== whatIfRow.TAA_ACTION ||
    !correctionsEqual(baseRow.details.generatedCorrections, whatIfRow.details.generatedCorrections);
  if (outcomeChanged) return 'OUTCOME';
  if (baseRow.details.ruleFired !== whatIfRow.details.ruleFired) return 'REASON';
  return null;
}

/**
 * Flagged-row memo neutralization (user decision, supersedes the earlier "both reasons" memo):
 * the engine's specific reason (Early/Late Logout, Late Login…) may be wrong whenever a punch
 * sits outside the search window, so REASON- and OUTCOME-flagged rows never surface a possibly
 * wrong reason to staff — every correction's Memo that CARRIES A REASON is replaced with the
 * neutral configured text. A memo "carries a reason" whenever it is anything other than the two
 * flex shift-update pair markers (config.originalShiftMemo / config.updatedShiftMemo) — those are
 * not narratives about why a correction fired, only a label for which of the pair is the original
 * vs. the updated segment, so they stay untouched. Every other Memo the engine writes (Late
 * Login/Logout Xm, Absent NS/NC, Cover Not Attended, OT/RLS narratives, …) is a reason narrative
 * and is replaced. The base ASPECT action/times/codes (everything except Memo) are always left
 * exactly as the engine produced them.
 */
function correctionCarriesReason(correction: AspectCorrectionRow, config: ConfigRegistry): boolean {
  return correction.Memo !== config.originalShiftMemo && correction.Memo !== config.updatedShiftMemo;
}

function neutralizeReasonMemos(corrections: AspectCorrectionRow[], config: ConfigRegistry): AspectCorrectionRow[] {
  return corrections.map(c => (correctionCarriesReason(c, config) ? { ...c, Memo: config.improperPunchMemoText } : c));
}

/**
 * Flagged-row email retemplating (user decision): a REASON/OUTCOME row's outbound email must
 * never state a possibly-wrong specific reason either, so its template_key is forced to
 * 'improper_login_logout' and subject/body are re-rendered from that neutral template using the
 * SAME non-engine renderer (emailDrafts.ts's applyEmailTemplate) the engine itself calls — the
 * engine pre-renders subject/body at build time (reconciliationEngine.ts ~2148), so this is a
 * pure post-processing re-render, never an engine edit. The three decorations the engine layers
 * on AFTER its own applyEmailTemplate call (reconciliationEngine.ts ~2177-2211) — the terminated
 * warning, the "[VERIFY RECIPIENT]" subject prefix, and the multi-action "Actions fired" body
 * suffix — are reapplied here from the action's own already-resolved fields (is_terminated, and
 * the original subject/body text), so none of that recipient-safety or multi-action detail is
 * lost by re-rendering.
 */
function reTemplateForFlaggedRow(action: EmailActionItem, config: ConfigRegistry): EmailActionItem {
  const rendered = applyEmailTemplate({ ...action, template_key: 'improper_login_logout' }, config.emailTemplates);
  let subject = rendered.subject;
  let body = rendered.body;
  if (action.is_terminated) {
    subject = `[TERMINATED - VERIFY] ${subject}`;
    body += '\n\nAUDIT WARNING: this employee record is flagged TERMINATED - verify before acting on this notice.';
  } else if (action.subject.startsWith('[VERIFY RECIPIENT] ')) {
    subject = `[VERIFY RECIPIENT] ${subject}`;
  }
  const actionsFiredMatch = action.body.match(/\n\nActions fired \(all, this row\): ([\s\S]+)$/);
  if (actionsFiredMatch) {
    body += `\n\nActions fired (all, this row): ${actionsFiredMatch[1]}`;
  }
  return { ...rendered, subject, body };
}

/**
 * Runs after runReconciliation. Pure function: never mutates `input` or `baseOutput` — returns
 * a new ReconciliationOutput with unseen-punch flags applied. See module header / the plan doc
 * for the full 3-step design (candidates, what-if, flags).
 */
export function runUnseenPunchAudit(input: ReconciliationInput, baseOutput: ReconciliationOutput): ReconciliationOutput {
  const { cognosRecords, aspectSegments, aspectIdentities, cmsPunches, config, processingDate, verificationAudit } = input;
  if (cognosRecords.length === 0 || baseOutput.rows.length === 0) return baseOutput;

  const identityMap = new Map<string, AspectIdentity>();
  aspectIdentities.forEach(id => {
    if (!id.EMP_ID) return;
    const key = id.EMP_ID.trim();
    if (!identityMap.has(key)) identityMap.set(key, id);
  });

  const pfNoToLoginId = new Map<string, string>();
  cognosRecords.forEach(r => {
    const pfNo = (r['PF NO'] || '').trim();
    const loginId = (r['LOGIN ID'] || '').trim();
    if (pfNo && loginId && !pfNoToLoginId.has(pfNo)) pfNoToLoginId.set(pfNo, loginId);
  });

  // ---- Step 1: candidates ----
  const allAspectWindows = buildAllAspectWindows(aspectSegments, pfNoToLoginId, identityMap, config);
  const windowsByLogin = new Map<string, AuditWindow[]>();
  allAspectWindows.forEach(w => {
    if (!windowsByLogin.has(w.loginId)) windowsByLogin.set(w.loginId, []);
    windowsByLogin.get(w.loginId)!.push(w);
  });

  const punchesByLoginId = new Map<string, CMSPunch[]>();
  cmsPunches.forEach(p => {
    const key = p.LoginID.trim();
    if (!punchesByLoginId.has(key)) punchesByLoginId.set(key, []);
    punchesByLoginId.get(key)!.push(p);
  });

  // Every punch the LIVE search window (config.cmsPunchSearchWindowHours) leaves unclaimed by
  // ANY ASPECT-derived window (not just Cognos-row windows) is a candidate before G1/G4 below.
  const attribution = attributePunches(allAspectWindows, punchesByLoginId, config);

  // Cognos row lookup by pfNo+nomDateStr, index-aligned with baseOutput.rows (same loop order
  // as reconciliationEngine.ts's own Pass 2 — see reconciliationEngine.ts:614).
  const rowIndexByPfNoDate = new Map<string, number>();
  const pfNoByRow: string[] = [];
  cognosRecords.forEach((cognos, rowIndex) => {
    const pfNo = (cognos['PF NO'] || '').trim();
    pfNoByRow[rowIndex] = pfNo;
    const signInParsed = parseDateTimeString((cognos['SIGN IN DATE'] || '').trim());
    if (!signInParsed) return;
    const nomDateStr = formatDateDDMMYYYY(signInParsed);
    const key = `${pfNo}|${nomDateStr}`;
    if (!rowIndexByPfNoDate.has(key)) rowIndexByPfNoDate.set(key, rowIndex);
  });

  const maxReachMs = Math.max(1, config.unseenPunchMaxReachHours) * 60 * 60 * 1000;
  const candidatesByRow = new Map<number, { punch: CMSPunch; distanceMs: number; stray: boolean }[]>();

  attribution.unclaimedPunches.forEach(punch => {
    const loginId = punch.LoginID.trim();
    const windows = windowsByLogin.get(loginId);
    if (!windows || windows.length === 0) return;
    const owner = nearestWindow(punch, windows);
    if (!owner) return;
    // G4: reach cap — drop candidates beyond the owner window's own edge + max reach.
    if (owner.distanceMs > maxReachMs) return;
    // G1 (final clause): only proceed if the owner window is an actual Cognos row this run.
    const rowIndex = rowIndexByPfNoDate.get(`${owner.window.pfNo}|${owner.window.nomDateStr}`);
    if (rowIndex === undefined) return;
    if (!candidatesByRow.has(rowIndex)) candidatesByRow.set(rowIndex, []);
    candidatesByRow.get(rowIndex)!.push({ punch, distanceMs: owner.distanceMs, stray: isStraySwipe(punch) });
  });

  if (candidatesByRow.size === 0) return baseOutput;

  // ---- Step 2 & 3: what-if re-run per candidate row, then flags ----
  const flagByRowIndex = new Map<number, {
    flag: 'REASON' | 'OUTCOME'; note: string;
    whatIfCorrections?: AspectCorrectionRow[]; punchTimeHHMM?: string;
  }>();

  candidatesByRow.forEach((punches, rowIndex) => {
    const pfNo = pfNoByRow[rowIndex];
    const baseRow = baseOutput.rows[rowIndex];
    if (!baseRow) return;

    const maxDistanceMs = Math.max(...punches.map(p => p.distanceMs));
    const neededHours = Math.max(config.cmsPunchSearchWindowHours + 1, Math.ceil(maxDistanceMs / (60 * 60 * 1000)));

    const cognosSubset = cognosRecords.filter(r => (r['PF NO'] || '').trim() === pfNo);
    const aspectSegmentsSubset = aspectSegments.filter(s => (s.EMP_ID || '').trim() === pfNo);
    const aspectIdentitiesSubset = aspectIdentities.filter(i => (i.EMP_ID || '').trim() === pfNo);
    const targetCognos = cognosRecords[rowIndex];

    // G2 steal check — same window shapes (W), different search radius (base config vs the
    // widened what-if config), using attributePunches directly rather than engine internals.
    const personWindows = buildCognosRowWindows(cognosSubset, aspectSegmentsSubset, identityMap, config);
    const loginId = pfNoToLoginId.get(pfNo) || '';
    const personPunches = punchesByLoginId.get(loginId) || [];
    const personPunchesByLogin = new Map<string, CMSPunch[]>([[loginId, personPunches]]);
    const baseAttribution = attributePunches(personWindows, personPunchesByLogin, config);
    const whatIfConfig: ConfigRegistry = { ...config, cmsPunchSearchWindowHours: neededHours };
    const whatIfAttribution = attributePunches(personWindows, personPunchesByLogin, whatIfConfig);

    const baseWindowByPunch = new Map<CMSPunch, string>();
    baseAttribution.punchesByWindowKey.forEach((ps, key) => ps.forEach(p => baseWindowByPunch.set(p, key)));
    let stolen = false;
    whatIfAttribution.punchesByWindowKey.forEach((ps, key) => ps.forEach(p => {
      const baseKey = baseWindowByPunch.get(p);
      if (baseKey && baseKey !== key) stolen = true;
    }));
    if (stolen) return; // G2: discard, no flag.

    const whatIfInput: ReconciliationInput = {
      cognosRecords: cognosSubset,
      aspectSegments: aspectSegmentsSubset,
      aspectIdentities: aspectIdentitiesSubset,
      cmsPunches, // full export — coverage needs the whole file.
      config: whatIfConfig,
      processingDate,
      verificationAudit,
    };
    const whatIfOutput = runReconciliation(whatIfInput);
    // reconciliationEngine.ts copies each Cognos row (`originalCognos: { ...cognos }`), so
    // reference equality never matches — match on PF NO + the raw SIGN IN DATE string instead,
    // the same pair reconciliationEngine.ts itself uses to key a row (pfNo/nomDateStr, Pass 1).
    const whatIfRow = whatIfOutput.rows.find(r =>
      (r.originalCognos['PF NO'] || '').trim() === pfNo &&
      r.originalCognos['SIGN IN DATE'] === targetCognos['SIGN IN DATE']
    );
    if (!whatIfRow) return;

    const classification = classifyUnseenPunchDiff(baseRow, whatIfRow);
    if (!classification) return; // nothing changes — not flagged (case 7).

    const farthest = punches.reduce((a, b) => (b.distanceMs > a.distanceMs ? b : a));
    const distHours = (farthest.distanceMs / (60 * 60 * 1000)).toFixed(2);
    const punchTimeDesc = farthest.punch.LogoutDateTime
      ? `${formatTimeHHMM(farthest.punch.LoginDateTime)}-${formatTimeHHMM(farthest.punch.LogoutDateTime)}`
      : `${formatTimeHHMM(farthest.punch.LoginDateTime)} (still clocked in)`;
    const strayNote = punches.some(p => p.stray) ? ' [possible stray swipe]' : '';
    const note =
      `Punch ${punchTimeDesc} found ${distHours}h outside the ±${config.cmsPunchSearchWindowHours}h search window. ` +
      `Engine: ${baseRow.details.ruleFired || baseRow.TAA_VERDICT}. With it: ${whatIfRow.details.ruleFired || whatIfRow.TAA_VERDICT}.${strayNote}`;

    flagByRowIndex.set(rowIndex, {
      flag: classification,
      note,
      whatIfCorrections: whatIfRow.details.generatedCorrections,
      punchTimeHHMM: formatTimeHHMM(farthest.punch.LoginDateTime),
    });
  });

  if (flagByRowIndex.size === 0) return baseOutput;

  const rows: ReconciliationRow[] = baseOutput.rows.map((row, idx) => {
    const flag = flagByRowIndex.get(idx);
    if (!flag) return row;
    // Both REASON and OUTCOME: the base ASPECT action/times/codes are unchanged — only each
    // reason-carrying correction's Memo is replaced with the neutral configured text (see
    // neutralizeReasonMemos). OUTCOME's own corrections are neutralized too (not the what-if
    // ones), so if a reviewer later approves this row (includeInOutput flipped true via
    // rebuildOutputs) the neutral memo — not the specific reason — is what goes out.
    const neutralizedCorrections = neutralizeReasonMemos(row.details.generatedCorrections, config);
    if (flag.flag === 'OUTCOME') {
      return {
        ...row,
        holdReason: 'UNSEEN_PUNCH_OUTCOME',
        holdReasonText: `${flag.note} (locked — cannot be included until resolved)`,
        includeInOutput: false,
        includeDecisionSource: 'auto',
        unseenPunchFlag: 'OUTCOME',
        unseenPunchNote: flag.note,
        details: { ...row.details, generatedCorrections: neutralizedCorrections },
      };
    }
    // REASON: normally the row's own email is separately held by rebuildOutputs
    // (unseenPunchFlag === 'REASON'), never by touching includeInOutput/holdReason here.
    //
    // Phase 5 exception (2026-09-24, closes a real gap case 5 of the audit-fixes tests
    // exposed): a row the engine's own noAttendanceAllAgree gate released (details.
    // noAttendanceGateReleased — a dedicated marker, never inferred from ruleFired text)
    // required CMS, Cognos and ASPECT to ALL agree nobody worked. An out-of-window punch
    // found here — REASON or OUTCOME, it does not matter which classification the verdict/
    // action/corrections diff happens to produce — is itself evidence that agreement no
    // longer holds, regardless of whether the punch alone would have flipped the verdict.
    // So this ALWAYS re-holds the row under its original soft reason, even on a bare REASON
    // classification that would otherwise leave the row released. OUTCOME already re-holds it
    // (more strongly, under the forced UNSEEN_PUNCH_OUTCOME) via the branch above and takes
    // priority — this branch only ever runs for REASON.
    if (row.details.noAttendanceGateReleased) {
      const restoredHoldReason = row.details.noAttendanceGateReleased.holdReason;
      const note = `${flag.note} Re-held: a CMS punch outside the search window contradicts the no-attendance release.`;
      return {
        ...row,
        holdReason: restoredHoldReason,
        holdReasonText: note,
        includeInOutput: false,
        includeDecisionSource: 'auto',
        unseenPunchFlag: 'REASON',
        unseenPunchNote: note,
        details: { ...row.details, generatedCorrections: neutralizedCorrections },
      };
    }
    return {
      ...row,
      unseenPunchFlag: 'REASON',
      unseenPunchNote: flag.note,
      details: { ...row.details, generatedCorrections: neutralizedCorrections },
    };
  });

  // Every flagged row's outbound email is also forced onto the neutral 'improper_login_logout'
  // template (re-rendered here via emailDrafts.ts's own renderer — never the engine) — REASON
  // stays held until released, OUTCOME stays excluded until approved, but whenever either goes
  // out it carries the neutral text, never the specific (possibly wrong) reason.
  const flaggedRowIds = new Set(rows.filter(r => !!r.unseenPunchFlag).map(r => r.id));
  const emailActions = flaggedRowIds.size > 0
    ? baseOutput.emailActions.map(a => (flaggedRowIds.has(a.base_row_id) ? reTemplateForFlaggedRow(a, config) : a))
    : baseOutput.emailActions;

  // Rebuild the downstream exports through the same shared builder App.tsx's review-toggle
  // handlers use (rebuildOutputs), so both an OUTCOME flag's includeInOutput=false and a REASON
  // flag's email hold propagate into every output identically to a manual un-tick.
  const { aspectCorrections, aspectCorrectionsCsv, annotatedCognosCsv, annotatedCognosTsv, emailActionsJson } =
    rebuildOutputs(rows, emailActions, config, baseOutput.verificationAudit);

  const heldForReviewCount = rows.filter(r => !!r.holdReason).length;
  const mustCheckCount = rows.filter(rowIsMustCheck).length;

  return {
    ...baseOutput,
    rows,
    emailActions,
    aspectCorrections,
    aspectCorrectionsCsv,
    annotatedCognosCsv,
    annotatedCognosTsv,
    emailActionsJson,
    summary: {
      ...baseOutput.summary,
      heldForReviewCount,
      mustCheckCount,
    },
  };
}
