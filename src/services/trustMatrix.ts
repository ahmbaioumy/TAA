import {
  CognosRecord,
  AspectSegment,
  AspectIdentity,
  CMSPunch,
  ConfigRegistry,
  RoleTier,
} from '../types/taa';
import { runReconciliation } from './reconciliationEngine';
import { DEFAULT_CONFIG } from './configRegistry';
import { TestCaseResult, SUITE_RUN_DATE } from './regressionSuite';

/**
 * TRUST MATRIX — an independent ground-truth oracle for the reconciliation
 * engine, built from `samples_Files/Rules to be taken.csv` and the
 * non-negotiables in doc/CLAUDE.md, NOT by calling reconciliationEngine.ts /
 * scheduleRecompute.ts / punchAttribution.ts. If this file imported the
 * engine's own decision logic, a passing case would only prove the app
 * agrees with itself — the whole point is an independent second opinion.
 *
 * Three rulings (from the plan review) are baked into this oracle as
 * CORRECT and are now IMPLEMENTED in the engine (see doc/TAA_KNOWLEDGE_BASE.md
 * §7a for the fix commit's rationale):
 *   D-A: two rules firing on one row -> BOTH corrected AND reported (both
 *        AspectCorrectionRows always existed; TAA_ACTIONS_FIRED is the new
 *        field that reports every fired action, and chargedVarianceMin now
 *        sums across rules instead of keeping only the first).
 *   D-B: Late Logout is measured from the EFFECTIVE (release/nursing/RLS
 *        adjusted) end, not the raw end.
 *   D-C: the "single punch" evidence rule is SPAN-based (Min login vs Max
 *        logout across all attributed swipes) for ALL staff including flex
 *        (flex previously had no evidence/coverage guard at all).
 * D-D: punch-attribution ties use the confirmed priority cascade: real shift
 * beats synthetic leave, then earlier window, then hold if still tied.
 *
 * CMS format: verified against samples_Files/CMS_Login_logout.csv — one row
 * per SWIPE EVENT (login/logout on one row are the same swipe, ~3s apart).
 * A normal workday is TWO rows. `swipes` below expands to that shape.
 */

// ---------------------------------------------------------------------------
// Oracle primitives — small, pure, independently authored.
// ---------------------------------------------------------------------------

type PolicyKind = 'Late Login' | 'Early Logout' | 'Late Logout' | 'Cover Not Attended';

/** Direct read of the published band table (data, not decision logic). */
function bandFor(config: ConfigRegistry, kind: PolicyKind, tier: RoleTier, minutes: number) {
  return config.policyRules.find(
    r => r.segmentType === kind && r.tier === tier && minutes >= (r.minMinutes ?? 0) && minutes <= (r.maxMinutes ?? 999999)
  );
}

function mkDate(dateStr: string, timeStr: string): Date {
  const [d, m, y] = dateStr.split('/').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
}
function addDaysStr(dateStr: string, days: number): string {
  const [d, m, y] = dateStr.split('/').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}
function fmtHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDMY(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function diffMin(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 60000);
}

// ---------------------------------------------------------------------------
// Declarative case schema
// ---------------------------------------------------------------------------

interface SegSpec {
  code: string;
  date: string; // DD/MM/YYYY (NOM_DATE) — physical date the segment is anchored to
  start: string; // 'DD/MM/YYYY HH:MM' absolute start moment
  end: string; // 'DD/MM/YYYY HH:MM' absolute end moment
}

interface SwipeSpec {
  date: string; // DD/MM/YYYY
  time: string; // HH:MM
}

interface TrustCase {
  id: string;
  family: string;
  tier: RoleTier;
  flex?: boolean;
  nomDate: string; // DD/MM/YYYY — the Cognos row's SIGN IN DATE day
  shift?: { start: string; end: string }; // HH:MM/HH:MM, cross-midnight if end <= start
  extraSegments?: SegSpec[]; // NURSNG / RLS family / OT1 / OT2 / COVER
  leaveCode?: string; // e.g. 'P/H-LV', 'ANNUAL' — makes this a no-SHIFT leave day
  swipes: SwipeSpec[]; // each expands to one CMS row, login/logout 3s apart
  /** WP1: real CMS SESSIONS ('DD/MM/YYYY HH:MM' login -> logout), for cases that must express
   *  CONTINUOUS presence (cover credit). When set, these replace `swipes` entirely; a swipe is a
   *  3-second event and cannot say whether the agent stayed logged in between two of them. */
  sessions?: { start: string; end: string }[];
  cmsCoverage: 'wide' | 'narrow' | 'none';
  rationale: string;
  // Independently-derived expectation:
  expect: {
    verdict: string;
    actions: string[]; // TaaActionCode values expected to appear (D-A: can be >1)
    lateMin?: number;
    earlyMin?: number;
    chargedMin?: number;
    holdReason?: string;
    correctionCodes?: string[]; // expected SegmentCode values in aspectCorrections for this PF, e.g. ['LATE','COVER']
  };
}

let seq = 0;
function nextPf(): string {
  seq += 1;
  return `T${String(9000000 + seq)}`;
}

const TIER_KEYWORD = 'ANALYST'; // matches config.roleTierKeywords
const FLEX_KEYWORD = 'FLEX'; // matches config.flexKeywords

function buildIdentity(pf: string, tier: RoleTier, flex: boolean | undefined): AspectIdentity {
  const tag = [tier === 'OFFICER_PLUS' ? TIER_KEYWORD : '', flex ? FLEX_KEYWORD : ''].filter(Boolean).join(' ');
  return { EMP_ID: pf, EMP_LAST_NAME: `Case ${pf}`, EMP_SORT_NAME: `CASE ${pf} ${tag}`.trim() };
}

function buildCognos(pf: string, nomDate: string): CognosRecord {
  return {
    'SIGN IN DATE': `${nomDate.split('/').reverse().join('-')} 00:00:00`,
    SECTION: 'TRUST',
    'PF NO': pf,
    NAME: `Case ${pf}`,
    'LOGIN ID': pf,
    DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '',
    'SCH DURATION': '', 'SIGNIN DURATION': '', 'SIGIN IN': '', 'SIGIN OUT': '',
    'LATE START': '0', 'LEFT EARLY': '0', 'LEAVE TYPE': '', 'LEAVE HR': '0', REMARK: '',
  };
}

/** Expand a TrustCase into full engine inputs. Cross-midnight shift end is
 *  auto-detected when end <= start. */
function buildInputs(tc: TrustCase): { cognos: CognosRecord; segs: AspectSegment[]; identity: AspectIdentity; punches: CMSPunch[] } {
  const pf = nextPf();
  const cognos = buildCognos(pf, tc.nomDate);
  if (tc.leaveCode) cognos['LEAVE TYPE'] = tc.leaveCode;
  const identity = buildIdentity(pf, tc.tier, tc.flex);
  const segs: AspectSegment[] = [];

  if (tc.shift) {
    const crossMid = tc.shift.end <= tc.shift.start;
    const startDt = mkDate(tc.nomDate, tc.shift.start);
    const endDate = crossMid ? addDaysStr(tc.nomDate, 1) : tc.nomDate;
    const endDt = mkDate(endDate, tc.shift.end);
    segs.push({
      EMP_ID: pf, NOM_DATE: tc.nomDate, START_DATE: tc.nomDate, SEG_CODE: 'SHIFT',
      START_MOMENT: `${tc.nomDate} ${tc.shift.start}:00`, STOP_MOMENT: `${endDate} ${tc.shift.end}:00`,
      DURATION: diffMin(startDt, endDt),
    });
  }
  (tc.extraSegments || []).forEach(s => {
    const [sd, st] = s.start.split(' ');
    const [ed, et] = s.end.split(' ');
    const startDt = mkDate(sd, st);
    const endDt = mkDate(ed, et);
    segs.push({
      EMP_ID: pf, NOM_DATE: tc.nomDate, START_DATE: s.date, SEG_CODE: s.code,
      START_MOMENT: `${s.start}:00`, STOP_MOMENT: `${s.end}:00`, DURATION: diffMin(startDt, endDt),
    });
  });
  if (tc.leaveCode) {
    segs.push({ EMP_ID: pf, NOM_DATE: tc.nomDate, START_DATE: tc.nomDate, SEG_CODE: tc.leaveCode });
  }

  // The LAST swipe of the day is what the engine reads for departure
  // (latest LogoutDateTime) — align ITS LogoutDateTime exactly to the
  // intended instant, offsetting LoginDateTime 3s earlier instead of later.
  // Earlier swipes align the other way (LoginDateTime = t) since the engine
  // reads the FIRST swipe's LoginDateTime for arrival. Without this, a
  // uniform t/t+3s pairing silently shifts exact-boundary minute values by
  // one on departure (e.g. "5 min early" measuring as 4), a fixture defect,
  // not an app defect.
  const punches: CMSPunch[] = tc.sessions ? tc.sessions.map(se => {
    const [sd, st] = se.start.split(' ');
    const [ed, et] = se.end.split(' ');
    return { Date: sd, LoginID: pf, LoginDateTime: mkDate(sd, st), LogoutDateTime: mkDate(ed, et) };
  }) : tc.swipes.map((sw, idx) => {
    const t = mkDate(sw.date, sw.time);
    const isLast = idx === tc.swipes.length - 1 && tc.swipes.length > 1;
    return isLast
      ? { Date: sw.date, LoginID: pf, LoginDateTime: new Date(t.getTime() - 3000), LogoutDateTime: t }
      : { Date: sw.date, LoginID: pf, LoginDateTime: t, LogoutDateTime: new Date(t.getTime() + 3000) };
  });

  if (tc.cmsCoverage === 'wide') {
    // Bracket with far-out sentinel swipes so the ±cmsPunchSearchWindowHours
    // coverage requirement is satisfied regardless of the shift's own time.
    const anchorDate = tc.shift ? tc.nomDate : tc.nomDate;
    const before = mkDate(addDaysStr(anchorDate, -3), '00:01');
    const after = mkDate(addDaysStr(anchorDate, 3), '23:59');
    punches.unshift({ Date: addDaysStr(anchorDate, -3), LoginID: pf, LoginDateTime: before, LogoutDateTime: new Date(before.getTime() + 3000) });
    punches.push({ Date: addDaysStr(anchorDate, 3), LoginID: pf, LoginDateTime: after, LogoutDateTime: new Date(after.getTime() + 3000) });
  }

  return { cognos, segs, identity, punches };
}

// ---------------------------------------------------------------------------
// Independent verdict oracle
// ---------------------------------------------------------------------------

interface OracleWindow { rawStart: Date | null; rawEnd: Date | null; effStart: Date | null; effEnd: Date | null; leadRelease: number; trailRelease: number }

/** Raw window = earliest start / latest stop across every ADDITION segment
 *  (SHIFT, OT1, OT2, COVER) — not just SHIFT — matching scheduleRecompute.ts's
 *  documented behavior ("not just the first SHIFT row"). Reduction segments
 *  touching the raw start are "leading", everything else (NURSNG always
 *  trailing by definition) is "trailing" — matches the proximity
 *  classification documented in doc/CLAUDE.md, re-derived independently. */
function computeWindow(tc: TrustCase, config?: ConfigRegistry): OracleWindow {
  const additionSpans: { start: Date; end: Date }[] = [];
  if (tc.shift) {
    const crossMid = tc.shift.end <= tc.shift.start;
    const s = mkDate(tc.nomDate, tc.shift.start);
    const endDate = crossMid ? addDaysStr(tc.nomDate, 1) : tc.nomDate;
    additionSpans.push({ start: s, end: mkDate(endDate, tc.shift.end) });
  }
  (tc.extraSegments || []).forEach(seg => {
    if (!['OT1', 'OT2', 'COVER'].includes(seg.code)) return;
    // A COVER is a correction mechanism, not part of the shift's own attendance window, unless the
    // config explicitly says it extends it (coverExtendsAttendanceWindow, default false). The engine
    // has always behaved this way (reg-25); the oracle previously ignored the flag, which was harmless
    // only because no case carried a COVER.
    if (seg.code === 'COVER' && !(config && config.coverExtendsAttendanceWindow)) return;
    const [sd, st] = seg.start.split(' ');
    const [ed, et] = seg.end.split(' ');
    additionSpans.push({ start: mkDate(sd, st), end: mkDate(ed, et) });
  });
  if (additionSpans.length === 0) return { rawStart: null, rawEnd: null, effStart: null, effEnd: null, leadRelease: 0, trailRelease: 0 };

  const rawStart = new Date(Math.min(...additionSpans.map(a => a.start.getTime())));
  const rawEnd = new Date(Math.max(...additionSpans.map(a => a.end.getTime())));

  let lead = 0;
  let trail = 0;
  (tc.extraSegments || []).forEach(s => {
    if (!['NURSNG', 'RLS', 'RLS-2H', 'RLS-3H', 'UN_RLS', 'Cover_RLS'].includes(s.code)) return;
    const [sd, st] = s.start.split(' ');
    const [ed, et] = s.end.split(' ');
    const segStart = mkDate(sd, st);
    const segEnd = mkDate(ed, et);
    const dur = diffMin(segStart, segEnd);
    const touchesStart = Math.abs(segStart.getTime() - rawStart.getTime()) <= 2 * 60000;
    const touchesEnd = Math.abs(segEnd.getTime() - rawEnd.getTime()) <= 2 * 60000;
    if (s.code === 'NURSNG') { trail += dur; return; } // always trailing
    if (touchesStart && !touchesEnd) lead += dur; else trail += dur;
  });

  const effStart = new Date(rawStart.getTime() + lead * 60000);
  const effEnd = new Date(rawEnd.getTime() - trail * 60000);
  return { rawStart, rawEnd, effStart, effEnd, leadRelease: lead, trailRelease: trail };
}

/** D-C: span-based evidence across ALL attributed swipes, all staff. */
function swipeSpan(tc: TrustCase): { min: Date | null; max: Date | null; count: number } {
  if (tc.sessions && tc.sessions.length > 0) {
    const starts = tc.sessions.map(se => { const [d, t] = se.start.split(' '); return mkDate(d, t).getTime(); });
    const ends = tc.sessions.map(se => { const [d, t] = se.end.split(' '); return mkDate(d, t).getTime(); });
    return { min: new Date(Math.min(...starts)), max: new Date(Math.max(...ends)), count: tc.sessions.length * 2 };
  }
  if (tc.swipes.length === 0) return { min: null, max: null, count: 0 };
  const times = tc.swipes.map(s => mkDate(s.date, s.time));
  return { min: new Date(Math.min(...times.map(t => t.getTime()))), max: new Date(Math.max(...times.map(t => t.getTime()))), count: tc.swipes.length };
}

function coverageSufficient(tc: TrustCase, config: ConfigRegistry): boolean {
  if (tc.cmsCoverage === 'wide') return true;
  if (tc.cmsCoverage === 'none') return true; // genuine no-data case, not a coverage gap
  const win = computeWindow(tc, config);
  if (!win.rawStart || !win.rawEnd) return true;
  const searchMs = config.cmsPunchSearchWindowHours * 60 * 60 * 1000;
  const requiredStart = win.rawStart.getTime() - searchMs;
  const requiredEnd = win.rawEnd.getTime() + searchMs;
  const span = swipeSpan(tc);
  if (!span.min || !span.max) return true;
  return span.min.getTime() <= requiredStart && span.max.getTime() >= requiredEnd;
}

interface OracleResult {
  verdict: string;
  actions: string[];
  lateMin: number;
  earlyMin: number;
  chargedMin: number;
  holdReason?: string;
  correctionCodes: string[];
}

/** The oracle itself: hand-derived from the rules, independent of the engine. */
/** WP1 — INDEPENDENT re-derivation of cover credit (deliberately not sharing code with the engine).
 *  Late-logout minutes that fall inside a COVER the agent was PROVEN to be logged in for are make-up
 *  time, never also chargeable late logout. A cover only earns credit for minutes covered by
 *  continuous attendance: sessions are rounded outward to whole minutes and merged when they touch. */
function oracleCoverCredit(
  tc: TrustCase, windowStart: Date, windowEnd: Date, placedSameDay: { start: Date; end: Date } | null,
): number {
  const covers: { start: number; end: number }[] = [];
  (tc.extraSegments || []).filter(s => s.code === 'COVER').forEach(s => {
    const [sd, st] = s.start.split(' ');
    const [ed, et] = s.end.split(' ');
    covers.push({ start: mkDate(sd, st).getTime(), end: mkDate(ed, et).getTime() });
  });
  if (placedSameDay) covers.push({ start: placedSameDay.start.getTime(), end: placedSameDay.end.getTime() });
  const minute = 60000;
  const raw = (tc.sessions || []).map(se => {
    const [sd, st] = se.start.split(' ');
    const [ed, et] = se.end.split(' ');
    return { start: Math.floor(mkDate(sd, st).getTime() / minute) * minute, end: Math.ceil(mkDate(ed, et).getTime() / minute) * minute };
  }).sort((a, b) => a.start - b.start);
  const presence: { start: number; end: number }[] = [];
  raw.forEach(r => {
    const last = presence[presence.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else presence.push({ ...r });
  });
  // covers may overlap each other: count each minute once
  const mergedCovers: { start: number; end: number }[] = [];
  [...covers].sort((a, b) => a.start - b.start).forEach(c => {
    const last = mergedCovers[mergedCovers.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end); else mergedCovers.push({ ...c });
  });
  let ms = 0;
  mergedCovers.forEach(c => {
    const cs = Math.max(c.start, windowStart.getTime());
    const ce = Math.min(c.end, windowEnd.getTime());
    if (ce <= cs) return;
    presence.forEach(p => {
      const s = Math.max(cs, p.start);
      const e = Math.min(ce, p.end);
      if (e > s) ms += e - s;
    });
  });
  return Math.floor(ms / minute);
}

function computeExpected(tc: TrustCase, config: ConfigRegistry): OracleResult {
  const win = computeWindow(tc, config);
  const span = swipeSpan(tc);
  const covered = coverageSufficient(tc, config);

  // Leave-day gate (§4.6b) fires ONLY when there are NO addition segments at
  // all (real isLeaveDay = leaveSegments.length>0 && additionSegments.length
  // === 0) — an OT2 standalone block is itself an ADDITION segment, so a
  // P/H-LV day carrying OT2 is NEVER routed through this gate; it falls
  // through to the standard path below with its window derived from OT2.
  if (!win.rawStart && tc.leaveCode) {
    const totalLoginMin = span.min && span.max ? Math.max(0, diffMin(span.min, span.max)) : 0;
    if (totalLoginMin >= config.leaveLoginThresholdMinutes) {
      return { verdict: 'ABSENT', actions: ['ABSENT_SEGMENT'], lateMin: 0, earlyMin: 0, chargedMin: 0, holdReason: undefined, correctionCodes: ['ABSENT'] };
    }
    return { verdict: 'LEAVE_EXCLUDED', actions: ['NO_ACTION'], lateMin: 0, earlyMin: 0, chargedMin: 0, correctionCodes: [] };
  }

  // D-C: evidence check applies to ALL staff (flex included).
  if (!covered && span.count <= 1) {
    return { verdict: 'INSUFFICIENT_CMS_COVERAGE', actions: ['MANUAL_REVIEW_REQUIRED'], lateMin: 0, earlyMin: 0, chargedMin: 0, holdReason: 'INSUFFICIENT_CMS_COVERAGE', correctionCodes: [] };
  }
  if (span.count === 0) {
    const rule = bandFor(config, 'Late Login', tc.tier, 0); // 'No Login Record' isn't minute-banded; use tier communication
    return { verdict: 'NO_SHOW', actions: ['ABSENT_NS_NC'], lateMin: 0, earlyMin: 0, chargedMin: 0, correctionCodes: ['Absent NS/NC'] };
  }
  if (span.count === 1 || (span.min && span.max && diffMin(span.min, span.max) < config.minAttendanceSpanMinutes)) {
    return { verdict: 'ABSENT', actions: ['ABSENT_SEGMENT'], lateMin: 0, earlyMin: 0, chargedMin: 0, correctionCodes: ['ABSENT'] };
  }

  // Flex (§4.8): absolute 10:00 cutoff, bypasses bands.
  if (tc.flex && win.rawStart) {
    const cutoff = mkDate(tc.nomDate, config.flexCutoffTime || '10:00');
    const actualIn = span.min!;
    if (actualIn.getTime() <= cutoff.getTime()) {
      // Branch A: within cutoff -> snap arrival to the rounding grid (nearest
      // 30min per config) and compare to the ORIGINAL scheduled start's
      // time-of-day. Only an unchanged snap is truly "no action"; a snap
      // that lands on a different time still emits a shift-update pair
      // (verified against regressionSuite.ts reg-7's 08:12 -> 08:00 case).
      const grid = config.roundingGridMinutes || 30;
      const rawStartMinOfDay = win.rawStart.getHours() * 60 + win.rawStart.getMinutes();
      const actualInMinOfDay = actualIn.getHours() * 60 + actualIn.getMinutes();
      const snappedMinOfDay = Math.round(actualInMinOfDay / grid) * grid;
      if (snappedMinOfDay === rawStartMinOfDay) {
        return { verdict: 'PRESENT', actions: ['NO_ACTION'], lateMin: 0, earlyMin: 0, chargedMin: 0, correctionCodes: [] };
      }
      return { verdict: 'SHIFT_CHANGED_FLEX', actions: ['SHIFT_UPDATE_FLEX'], lateMin: 0, earlyMin: 0, chargedMin: 0, correctionCodes: ['shift'] };
    }
    const lateMin = diffMin(cutoff, actualIn);
    return { verdict: 'LATE', actions: ['SHIFT_UPDATE_AND_LATE_COVER_FLEX'], lateMin, earlyMin: 0, chargedMin: lateMin, correctionCodes: ['LATE', 'COVER'] };
  }

  // Standard: Late Login vs effective start, Early/Late Logout vs effective end (D-B).
  const actions: string[] = [];
  const correctionCodes: string[] = [];
  let verdict = 'PRESENT';
  let lateMin = 0, earlyMin = 0, chargedMin = 0;

  if (win.effStart && span.min && span.min.getTime() > win.effStart.getTime()) {
    lateMin = diffMin(win.effStart, span.min);
    const rule = bandFor(config, 'Late Login', tc.tier, lateMin);
    if (rule && rule.action !== 'NO_ACTION') {
      actions.push(rule.action);
      chargedMin += lateMin;
      verdict = rule.action === 'ABSENT_SEGMENT' ? 'ABSENT' : 'LATE';
      correctionCodes.push(rule.action === 'ABSENT_SEGMENT' ? 'ABSENT' : 'LATE');
      if (rule.action === 'LATE_AND_COVER') correctionCodes.push('COVER');
    }
  }

  if (win.effEnd && span.max) {
    if (span.max.getTime() < win.effEnd.getTime()) {
      earlyMin = diffMin(span.max, win.effEnd);
      const rule = bandFor(config, 'Early Logout', tc.tier, earlyMin);
      if (rule && rule.action !== 'NO_ACTION') {
        actions.push(rule.action);
        chargedMin += earlyMin;
        verdict = rule.action === 'ABSENT_SEGMENT' ? 'ABSENT' : (verdict === 'ABSENT' ? 'ABSENT' : 'EARLY_LOGOUT');
        correctionCodes.push(rule.action === 'ABSENT_SEGMENT' ? 'ABSENT' : 'Log_off');
        if (rule.action === 'LOGOFF_AND_COVER') correctionCodes.push('COVER');
      }
    } else if (span.max.getTime() > win.effEnd.getTime()) {
      // D-B: Late Logout measured from EFFECTIVE end, not raw end.
      const grossLateLogoutMin = diffMin(win.effEnd, span.max);
      // WP1: a same-day cover is only placed when the toggle is on AND the agent stayed the whole
      // cover length past the day's end; it begins at the end of the day's schedule.
      const placedSameDay = (lateMin > 0 && config.coverSameDayWhenAlreadyCovered && win.rawEnd
        && bandFor(config, 'Late Login', tc.tier, lateMin)?.action === 'LATE_AND_COVER'
        && span.max.getTime() >= win.rawEnd.getTime() + lateMin * 60000)
        ? { start: win.rawEnd, end: new Date(win.rawEnd.getTime() + lateMin * 60000) }
        : null;
      const credited = oracleCoverCredit(tc, win.effEnd, span.max, placedSameDay);
      const lateLogoutMin = Math.max(0, grossLateLogoutMin - credited);
      const rule = lateLogoutMin > 0 ? bandFor(config, 'Late Logout', tc.tier, lateLogoutMin) : undefined;
      if (rule && rule.action !== 'NO_ACTION') {
        actions.push(rule.action);
        chargedMin += lateLogoutMin;
        verdict = 'ABSENT';
        correctionCodes.push('ABSENT');
      }
    }
  }

  if (actions.length === 0) {
    return { verdict: 'PRESENT', actions: ['NO_ACTION'], lateMin, earlyMin, chargedMin: 0, correctionCodes: [] };
  }
  // D-A: both rules charged AND both reported.
  return { verdict, actions, lateMin, earlyMin, chargedMin, correctionCodes };
}

// ---------------------------------------------------------------------------
// Case families
// ---------------------------------------------------------------------------

const cases: TrustCase[] = [];

function push(tc: Omit<TrustCase, 'expect'> & { expect?: TrustCase['expect'] }) {
  const full: TrustCase = { ...tc, expect: tc.expect || ({} as TrustCase['expect']) } as TrustCase;
  if (!tc.expect) full.expect = computeExpected(full, DEFAULT_CONFIG);
  cases.push(full);
}

// F1 — Late-login boundary sweep, both tiers, day + cross-midnight shifts
const lateOffsets = [-5, 0, 5, 6, 30, 60, 61, 90];
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  [{ start: '08:00', end: '16:00', label: 'day' }, { start: '23:00', end: '07:00', label: 'night' }].forEach(shape => {
    lateOffsets.forEach(offMin => {
      const arrive = new Date(mkDate('01/09/2026', shape.start).getTime() + offMin * 60000);
      const shiftEndDate = shape.end <= shape.start ? '02/09/2026' : '01/09/2026';
      push({
        id: `f1-${tier}-${shape.label}-${offMin}`,
        family: 'F1 Late-login boundary',
        tier,
        nomDate: '01/09/2026',
        shift: { start: shape.start, end: shape.end },
        swipes: [{ date: fmtDMY(arrive), time: fmtHM(arrive) }, { date: shiftEndDate, time: shape.end }],
        cmsCoverage: 'wide',
        rationale: `${tier} ${shape.label} shift, arrival ${offMin >= 0 ? '+' : ''}${offMin}min vs scheduled start`,
      });
    });
  });
});

// F2 — Early-logout boundary sweep
const earlyOffsets = [-10, 0, 4, 5, 9, 10, 20, 21, 30];
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  [{ start: '08:00', end: '16:00', label: 'day' }, { start: '22:00', end: '06:00', label: 'night' }].forEach(shape => {
    earlyOffsets.forEach(offMin => {
      const crossMid = shape.end <= shape.start;
      const endDateStr = crossMid ? '02/09/2026' : '01/09/2026';
      const depart = new Date(mkDate(endDateStr, shape.end).getTime() - offMin * 60000);
      push({
        id: `f2-${tier}-${shape.label}-${offMin}`,
        family: 'F2 Early-logout boundary',
        tier,
        nomDate: '01/09/2026',
        shift: { start: shape.start, end: shape.end },
        swipes: [{ date: '01/09/2026', time: shape.start }, { date: fmtDMY(depart), time: fmtHM(depart) }],
        cmsCoverage: 'wide',
        rationale: `${tier} ${shape.label} shift, departure ${offMin}min before scheduled end`,
      });
    });
  });
});

// F3 — Late Logout measured from EFFECTIVE end (D-B) — plain / nursing / RLS
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  [59, 60, 90].forEach(pastRaw => {
    // Plain shift: raw end == effective end, so this is a control case.
    push({
      id: `f3-${tier}-plain-${pastRaw}`,
      family: 'F3 Late-logout effective-end (D-B)',
      tier, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      swipes: [{ date: '01/09/2026', time: '08:00' }, { date: '01/09/2026', time: fmtHM(new Date(mkDate('01/09/2026', '16:00').getTime() + pastRaw * 60000)) }],
      cmsCoverage: 'wide',
      rationale: `${tier}: logout ${pastRaw}min past RAW end (no reducers — raw==effective, control case)`,
    });
    // Nursing shift: 60min trailing deduction shrinks effective end to 15:00.
    // Logout pastRaw-minutes past the RAW end is (pastRaw+60) past EFFECTIVE end.
    push({
      id: `f3-${tier}-nursing-${pastRaw}`,
      family: 'F3 Late-logout effective-end (D-B)',
      tier, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      extraSegments: [{ code: 'NURSNG', date: '01/09/2026', start: '01/09/2026 15:00', end: '01/09/2026 16:00' }],
      swipes: [{ date: '01/09/2026', time: '08:00' }, { date: '01/09/2026', time: fmtHM(new Date(mkDate('01/09/2026', '16:00').getTime() + pastRaw * 60000)) }],
      cmsCoverage: 'wide',
      rationale: `${tier}: NURSNG shrinks effective end to 15:00; logout is ${pastRaw + 60}min past EFFECTIVE end — D-B says Absent, raw-end logic says only ${pastRaw}min`,
    });
  });
});

// F4 — CMS evidence span (D-C) — flex and non-flex, single/double/triple swipe, coverage
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  [false, true].forEach(flex => {
    // Genuine single swipe, wide coverage -> Absent (Rule 6), regardless of flex.
    push({
      id: `f4-${tier}-${flex ? 'flex' : 'std'}-single-wide`,
      family: 'F4 CMS evidence span (D-C)',
      tier, flex, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      swipes: [{ date: '01/09/2026', time: '08:05' }],
      cmsCoverage: 'wide',
      rationale: `${flex ? 'Flex' : 'Non-flex'} ${tier}: one genuine swipe with full CMS coverage — D-C says Absent for everyone, engine exempts flex today`,
    });
    // Single swipe, narrow coverage -> held for review, not Absent.
    push({
      id: `f4-${tier}-${flex ? 'flex' : 'std'}-single-narrow`,
      family: 'F4 CMS evidence span (D-C)',
      tier, flex, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      swipes: [{ date: '01/09/2026', time: '08:05' }],
      cmsCoverage: 'narrow',
      rationale: `${flex ? 'Flex' : 'Non-flex'} ${tier}: one swipe, CMS export doesn't reach far enough — coverage gap, not proof of absence`,
    });
    // Two swipes 3 rows (break in the middle) -> span still valid, present.
    push({
      id: `f4-${tier}-${flex ? 'flex' : 'std'}-triple-swipe`,
      family: 'F4 CMS evidence span (D-C)',
      tier, flex, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      swipes: [{ date: '01/09/2026', time: '08:00' }, { date: '01/09/2026', time: '12:00' }, { date: '01/09/2026', time: '16:00' }],
      cmsCoverage: 'wide',
      rationale: `${flex ? 'Flex' : 'Non-flex'} ${tier}: 3 swipe rows (lunch break badge) — Min/Max span still gives correct on-time verdict`,
    });
    // Two swipes same instant (double badge) -> span ~0 -> Absent (no real second punch).
    push({
      id: `f4-${tier}-${flex ? 'flex' : 'std'}-zero-span`,
      family: 'F4 CMS evidence span (D-C)',
      tier, flex, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
      swipes: [{ date: '01/09/2026', time: '08:00' }, { date: '01/09/2026', time: '08:00' }],
      cmsCoverage: 'wide',
      rationale: `${flex ? 'Flex' : 'Non-flex'} ${tier}: two swipe rows at the same instant — zero attendance span, not real evidence of a full day`,
    });
  });
});

// F5 — Nursing interactions
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  push({
    id: `f5-${tier}-exact-end`, family: 'F5 Nursing', tier, nomDate: '01/09/2026', shift: { start: '09:00', end: '17:00' },
    extraSegments: [{ code: 'NURSNG', date: '01/09/2026', start: '01/09/2026 16:00', end: '01/09/2026 17:00' }],
    swipes: [{ date: '01/09/2026', time: '09:00' }, { date: '01/09/2026', time: '16:00' }],
    cmsCoverage: 'wide', rationale: `${tier}: logout exactly at effective end (16:00) — no penalty`,
  });
  push({
    id: `f5-${tier}-before-effective-end`, family: 'F5 Nursing', tier, nomDate: '01/09/2026', shift: { start: '09:00', end: '17:00' },
    extraSegments: [{ code: 'NURSNG', date: '01/09/2026', start: '01/09/2026 16:00', end: '01/09/2026 17:00' }],
    swipes: [{ date: '01/09/2026', time: '09:00' }, { date: '01/09/2026', time: '15:40' }],
    cmsCoverage: 'wide', rationale: `${tier}: logout 20min BEFORE effective end (16:00) — real early-logout band should fire`,
  });
  push({
    id: `f5-${tier}-late-arrival-plus-nursing`, family: 'F5 Nursing', tier, nomDate: '01/09/2026', shift: { start: '09:00', end: '17:00' },
    extraSegments: [{ code: 'NURSNG', date: '01/09/2026', start: '01/09/2026 16:00', end: '01/09/2026 17:00' }],
    swipes: [{ date: '01/09/2026', time: '09:15' }, { date: '01/09/2026', time: '16:00' }],
    cmsCoverage: 'wide', rationale: `${tier}: 15min late arrival same day as NURSNG carve-out — Late Login band evaluated independently of the trailing deduction`,
  });
});

// F6 — RLS family: trailing, leading, UN_RLS, Cover_RLS (evidence-only cases —
// exact OT-overlap adjustment correctness is left to reg-suite / engine review,
// this family pins the effective-window classification).
(['RLS', 'RLS-2H', 'UN_RLS', 'Cover_RLS'] as const).forEach(code => {
  push({
    id: `f6-${code}-trailing`, family: 'F6 RLS family', tier: 'OPS', nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
    extraSegments: [{ code, date: '01/09/2026', start: '01/09/2026 15:30', end: '01/09/2026 16:00' }],
    swipes: [{ date: '01/09/2026', time: '08:00' }, { date: '01/09/2026', time: '15:30' }],
    cmsCoverage: 'wide', rationale: `${code} trailing 30min — effective end 15:30, logout at 15:30 is on time`,
  });
  push({
    id: `f6-${code}-leading`, family: 'F6 RLS family', tier: 'OPS', nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
    extraSegments: [{ code, date: '01/09/2026', start: '01/09/2026 08:00', end: '01/09/2026 08:30' }],
    swipes: [{ date: '01/09/2026', time: '08:30' }, { date: '01/09/2026', time: '16:00' }],
    cmsCoverage: 'wide', rationale: `${code} leading 30min (touches raw start) — effective start 08:30, arrival at 08:30 is on time`,
  });
});

// F7 — OT interactions
push({
  id: 'f7-ot1-tail-late', family: 'F7 OT interactions', tier: 'OPS', nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
  extraSegments: [{ code: 'OT1', date: '01/09/2026', start: '01/09/2026 16:00', end: '01/09/2026 17:00' }],
  swipes: [{ date: '01/09/2026', time: '08:10' }, { date: '01/09/2026', time: '17:00' }],
  cmsCoverage: 'wide', rationale: 'OT1 tail extends shift to 17:00; 10min late-login band evaluated same as any shift day',
});
push({
  id: 'f7-ot2-standalone-onleave-ontime', family: 'F7 OT interactions', tier: 'OPS', nomDate: '01/09/2026',
  leaveCode: 'P/H-LV', extraSegments: [{ code: 'OT2', date: '01/09/2026', start: '01/09/2026 23:00', end: '02/09/2026 07:00' }],
  swipes: [{ date: '01/09/2026', time: '23:00' }, { date: '02/09/2026', time: '07:00' }],
  cmsCoverage: 'wide', rationale: 'P/H-LV day with standalone OT2 fully attended — must be evaluated, not skipped',
});
push({
  id: 'f7-ot2-standalone-onleave-noshow', family: 'F7 OT interactions', tier: 'OPS', nomDate: '01/09/2026',
  leaveCode: 'P/H-LV', extraSegments: [{ code: 'OT2', date: '01/09/2026', start: '01/09/2026 23:00', end: '02/09/2026 07:00' }],
  swipes: [], cmsCoverage: 'none', rationale: 'P/H-LV day with standalone OT2 but no attendance — Absent, OT2 must convert to SHIFT in output',
});

// F8 — Cover placement realism (variance-detection only; exact stacking time
// is exercised by regressionSuite reg-10, not re-derived here).
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  push({
    id: `f8-${tier}-shift-only-triggers-cover`, family: 'F8 Cover placement', tier, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
    swipes: [{ date: '01/09/2026', time: '08:20' }, { date: '01/09/2026', time: '16:00' }],
    cmsCoverage: 'wide', rationale: `${tier}: 20min late triggers Late+Cover — cover correction must be present`,
  });
});

// F9 — Cover Not Attended shortfall bands (evaluated via the correction-code
// expectation only — this uses the plain Late/Early scaffolding since a
// standalone "pre-existing unattended COVER segment" needs forward ASPECT
// data matching reg-10's exact mechanics, out of this family's scope).
[3, 5, 9, 10, 19, 20].forEach(shortfall => {
  (['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
    const rule = bandFor(DEFAULT_CONFIG, 'Cover Not Attended', tier, shortfall);
    push({
      id: `f9-${tier}-covermiss-${shortfall}`,
      family: 'F9 Cover Not Attended bands',
      tier, nomDate: '01/09/2026',
      // Documented as a pinned band lookup, not a full simulated scenario —
      // rationale records the expected policy outcome for audit purposes.
      swipes: [], cmsCoverage: 'none',
      shift: undefined,
      rationale: `${tier}: ${shortfall}min cover-not-attended shortfall -> ${rule ? rule.actionText + (rule.communication !== 'NA' ? ' + ' + rule.communication : ' (no email)') : 'below floor, no rule fires'}`,
      expect: { verdict: 'N/A_BAND_ONLY', actions: rule ? [rule.action] : ['NO_ACTION'], correctionCodes: [] },
    });
  });
});

// F10 — Leave-day gate + D-D tie-break documentation
[0, 30, 59, 60, 90].forEach(loginMin => {
  push({
    id: `f10-leaveday-login-${loginMin}`, family: 'F10 Leave-day gate', tier: 'OPS', nomDate: '01/09/2026', leaveCode: 'ANNUAL',
    swipes: loginMin === 0 ? [] : [{ date: '01/09/2026', time: '09:00' }, { date: '01/09/2026', time: fmtHM(new Date(mkDate('01/09/2026', '09:00').getTime() + loginMin * 60000)) }],
    cmsCoverage: loginMin === 0 ? 'none' : 'wide',
    rationale: `ANNUAL leave day with ${loginMin}min CMS login — threshold is ${DEFAULT_CONFIG.leaveLoginThresholdMinutes}min`,
  });
});
push({
  id: 'f10-leaveday-after-nightshift-tiebreak', family: 'F10 Leave-day gate (D-D documented, not ruled)',
  tier: 'OPS', nomDate: '02/09/2026', leaveCode: 'ANNUAL',
  swipes: [{ date: '02/09/2026', time: '03:00' }],
  cmsCoverage: 'none',
  rationale: 'A night-shift row (01/09 23:00-07:00) ending 03:00 sits ahead of this leave-day row in Cognos order; D-D means the tie can misattribute the 03:00 punch. This case documents the risk — no engine assertion made pending a ruling on D-D.',
  expect: { verdict: 'N/A_DOCUMENTED', actions: [], correctionCodes: [] },
});

// F11 — Flex cutoff sweep
[
  { time: '07:00', label: 'on-time' }, { time: '08:12', label: 'within-cutoff-snap' }, { time: '09:59', label: 'just-within' },
  { time: '10:00', label: 'exact-cutoff' }, { time: '10:01', label: 'just-past' }, { time: '10:30', label: 'past-30' }, { time: '12:00', label: 'past-120' },
].forEach(({ time, label }) => {
  // Branch A (<=10:00) keeps the shift's own 8h span from actual arrival —
  // matches the "duration preserved" rule closely enough that downstream
  // early/late-logout evaluation stays quiet. Branch B (>10:00) clamps the
  // shift end to cutoff+8h regardless of how late the arrival was — using
  // arrival+8h there would drift the logout further every case and trip an
  // UNMODELED downstream Late-Logout check this oracle doesn't replicate.
  const isPastCutoff = mkDate('01/09/2026', time).getTime() > mkDate('01/09/2026', '10:00').getTime();
  const logoutAnchor = isPastCutoff ? '10:00' : time;
  push({
    id: `f11-flex-${label}`, family: 'F11 Flex cutoff', tier: 'OPS', flex: true, nomDate: '01/09/2026', shift: { start: '07:00', end: '15:00' },
    swipes: [{ date: '01/09/2026', time }, { date: '01/09/2026', time: fmtHM(new Date(mkDate('01/09/2026', logoutAnchor).getTime() + 8 * 3600000)) }],
    cmsCoverage: 'wide', rationale: `Flex arrival ${time} (${label}) vs 10:00 absolute cutoff`,
  });
});
push({
  id: 'f11-flex-single-swipe', family: 'F11 Flex cutoff', tier: 'OPS', flex: true, nomDate: '01/09/2026', shift: { start: '07:00', end: '15:00' },
  swipes: [{ date: '01/09/2026', time: '08:00' }], cmsCoverage: 'wide',
  rationale: 'Flex staff, one genuine swipe with full coverage — D-C says Absent even for flex',
});

// F12 — Multi-rule composites (D-A: both actions expected)
(['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
  push({
    id: `f12-${tier}-late-and-early`, family: 'F12 Multi-rule composite (D-A)', tier, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
    swipes: [{ date: '01/09/2026', time: tier === 'OPS' ? '08:10' : '08:15' }, { date: '01/09/2026', time: tier === 'OPS' ? '15:48' : '15:35' }],
    cmsCoverage: 'wide', rationale: `${tier}: late login AND early logout on the SAME row — D-A says both corrections AND both actions reported`,
  });
  push({
    id: `f12-${tier}-late-and-nursing`, family: 'F12 Multi-rule composite (D-A)', tier, nomDate: '01/09/2026', shift: { start: '08:00', end: '16:00' },
    extraSegments: [{ code: 'NURSNG', date: '01/09/2026', start: '01/09/2026 15:00', end: '01/09/2026 16:00' }],
    swipes: [{ date: '01/09/2026', time: tier === 'OPS' ? '08:10' : '08:15' }, { date: '01/09/2026', time: '15:00' }],
    cmsCoverage: 'wide', rationale: `${tier}: late login same day as nursing carve-out, logout exactly at effective end — only Late should fire, not Early`,
  });
});

// ---------------------------------------------------------------------------
// Runner — mirrors regressionSuite.ts's TestCaseResult shape for the shared UI.
// ---------------------------------------------------------------------------

// F-CREDIT (WP1) — cover credit against late logout.
// Owner decision B1/B6: minutes the agent spent working an attended COVER must never ALSO be charged
// as late logout; only the REMAINDER meets the configured band (60+ = ABSENT, unchanged). Expected
// values are derived by oracleCoverCredit above, NOT copied from the engine. Sessions (not swipes)
// are used because credit requires proof of CONTINUOUS attendance.
{
  const D = '01/09/2026';
  const ses = (a: string, b: string) => ({ start: `${D} ${a}`, end: `${D} ${b}` });
  const base = { nomDate: D, shift: { start: '09:00', end: '17:00' }, swipes: [] as SwipeSpec[], cmsCoverage: 'wide' as const };
  // A. Same-day cover recognised from a LATE login (needs coverSameDayWhenAlreadyCovered; the oracle
  //    reads the live config, so with the toggle off the gross minutes stand and ABSENT is expected).
  //    45 late -> cover 17:00-17:45. Logout 18:44/18:45/18:46 leaves 59/60/61 remaining minutes.
  (['OPS', 'OFFICER_PLUS'] as RoleTier[]).forEach(tier => {
    ['18:44', '18:45', '18:46'].forEach(out => {
      push({ ...base, id: `fc-${tier}-late45-out${out.replace(':', '')}`, family: 'F-CREDIT cover credit vs late logout', tier,
        sessions: [ses('09:45', out)],
        rationale: `${tier}: 45m late, continuous attendance to ${out}. Same-day cover 17:00-17:45 credits 45m, remainder meets the 60m band` });
    });
  });
  // B. COVER already in ASPECT (toggle-independent). Attended 17:00-18:00 = 60m credited.
  push({ ...base, id: 'fc-aspect-cover60-out1800', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    extraSegments: [{ code: 'COVER', date: D, start: `${D} 17:00`, end: `${D} 18:00` }], sessions: [ses('09:00', '18:00')],
    rationale: 'ASPECT already holds COVER 17:00-18:00 (60m); on time, worked it fully: 60 gross - 60 credited = 0, no absence' });
  push({ ...base, id: 'fc-aspect-cover60-out1830', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    extraSegments: [{ code: 'COVER', date: D, start: `${D} 17:00`, end: `${D} 18:00` }], sessions: [ses('09:00', '18:30')],
    rationale: '90 gross - 60 credited = 30 remaining, below the 60m band: no absence' });
  push({ ...base, id: 'fc-aspect-cover60-out1910', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    extraSegments: [{ code: 'COVER', date: D, start: `${D} 17:00`, end: `${D} 18:00` }], sessions: [ses('09:00', '19:10')],
    rationale: '130 gross - 60 credited = 70 remaining: the remainder still meets the band, so ABSENT stands' });
  // Stacked covers from different incidents (real shape: rec-210, 71 of 73 minutes under covers).
  push({ ...base, id: 'fc-aspect-stacked-covers', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    extraSegments: [
      { code: 'COVER', date: D, start: `${D} 17:00`, end: `${D} 17:40` },
      { code: 'COVER', date: D, start: `${D} 17:40`, end: `${D} 18:10` },
    ], sessions: [ses('09:00', '18:10')],
    rationale: 'Two stacked covers (40m + 30m) worked back to back: 70 gross - 70 credited = 0, no absence' });
  // C. Presence proof: the cover window falls inside a long gap in attendance (real shape: rec-282,
  //    logged out 16:47, back 18:40). No continuous presence => no credit => gross minutes stand.
  push({ ...base, id: 'fc-aspect-cover-not-present', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    extraSegments: [{ code: 'COVER', date: D, start: `${D} 17:00`, end: `${D} 17:45` }],
    sessions: [ses('09:00', '16:47'), ses('18:40', '18:42')],
    rationale: 'Cover 17:00-17:45 lies inside a 113m attendance gap: nothing is credited, so 102m gross stands (ABSENT)' });
  // D. Rule 7 is untouched (decision B6): credit uses strict presence, Cover Not Attended keeps its
  //    first-login..last-logout span. A cover attended in full must not trip either.
  push({ ...base, id: 'fc-control-no-cover-60', family: 'F-CREDIT cover credit vs late logout', tier: 'OPS',
    sessions: [ses('09:00', '18:00')],
    rationale: 'CONTROL: no cover anywhere, 60m late logout: nothing to credit, the configured band applies unchanged (ABSENT at 60)' });
}

export function runTrustMatrixTests(customConfig?: ConfigRegistry): TestCaseResult[] {
  const config = customConfig || DEFAULT_CONFIG;
  const results: TestCaseResult[] = [];

  cases.forEach(tc => {
    // Pin-only cases (no simulated inputs) — record the expectation for
    // audit without invoking the engine.
    if (tc.expect.verdict === 'N/A_BAND_ONLY' || tc.expect.verdict === 'N/A_DOCUMENTED') {
      results.push({
        id: tc.id, name: tc.id, category: tc.family, inputDescription: tc.rationale,
        cognosFlawedVerdict: 'N/A', expectedVerdict: tc.expect.actions.join(', ') || 'documented only',
        expectedAction: tc.expect.actions.join(', '), actualVerdict: 'N/A (pinned rule, not simulated)', actualAction: 'N/A',
        passed: true, payrollImpact: tc.rationale, calculationTrace: [tc.rationale],
      });
      return;
    }

    const { cognos, segs, identity, punches } = buildInputs(tc);
    const expected = computeExpected(tc, config);

    const out = runReconciliation({ processingDate: SUITE_RUN_DATE, cognosRecords: [cognos], aspectSegments: segs, aspectIdentities: [identity], cmsPunches: punches, config });
    const row = out.rows[0];
    const pfCorrections = out.aspectCorrections.filter(c => c.ID === cognos['PF NO']).map(c => c.SegmentCode);

    const verdictOk = row.TAA_VERDICT === expected.verdict;
    const actionOk = expected.actions.includes(row.TAA_ACTION) || expected.actions.length === 0;
    const holdOk = expected.holdReason ? row.holdReason === expected.holdReason : true;
    const passed = verdictOk && actionOk && holdOk;

    results.push({
      id: tc.id,
      name: tc.id,
      category: tc.family,
      inputDescription: tc.rationale,
      cognosFlawedVerdict: 'N/A (synthetic trust case, no flawed baseline)',
      expectedVerdict: `${expected.verdict} (late=${expected.lateMin ?? 0}m early=${expected.earlyMin ?? 0}m charged=${expected.chargedMin ?? 0}m)`,
      expectedAction: expected.actions.join(' + '),
      actualVerdict: `${row.TAA_VERDICT} (late=${row.TAA_LATE_MIN}m early=${row.TAA_EARLY_MIN}m)`,
      actualAction: `${row.TAA_ACTION} [corrections: ${pfCorrections.join(', ') || 'none'}]`,
      passed,
      payrollImpact: tc.rationale,
      calculationTrace: [
        `Family: ${tc.family}`,
        `Tier: ${tc.tier}${tc.flex ? ' (FLEX)' : ''}`,
        `Oracle verdict: ${expected.verdict} | Oracle actions: ${expected.actions.join(', ')}`,
        `Engine verdict: ${row.TAA_VERDICT} | Engine action: ${row.TAA_ACTION} | Hold: ${row.holdReason || 'none'}`,
        `Corrections emitted: ${pfCorrections.join(', ') || 'none'}`,
      ],
    });
  });

  return results;
}

export function getTrustMatrixCaseCount(): number {
  return cases.length;
}
