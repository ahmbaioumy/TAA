import { CMSPunch, ConfigRegistry, CognosRecord, AspectSegment, AspectIdentity } from '../types/taa';
import { startOfDay, normalizeDateKey, formatDateDDMMYYYY } from './parsers';
import { cognosClaimsAttendance } from './cognosComparison';
import { effectiveCmsCoverageGraceMinutes } from './configRegistry';

/**
 * A scheduled window a set of CMS punches can be attributed to — one per
 * Cognos row that has a raw ASPECT-derived start/end (real shift day) or a
 * synthetic full-day window (leave day, §4.6b). Windows are keyed uniquely
 * per Cognos row so two different rows never share attributed punches.
 */
export interface ScheduledWindow {
  key: string; // unique per Cognos row
  loginId: string;
  rawStart: Date;
  rawEnd: Date;
  isSynthetic: boolean; // true for leave-day full-day windows
  /** Upper bound the search/coverage logic below actually treats as "the shift's own
   * end", instead of always using rawEnd. Required — every caller must set it (rawEnd
   * by default) so this is never silently forgotten for a new window type. A flex agent
   * scheduled 07:00-15:00 may legally start at the cutoff and work to 18:00; the punch
   * search and coverage checks must reach that legally-clamped end, not just rawEnd, or
   * a genuine late logout is missed under a narrow search window (see
   * reconciliationEngine.ts Pass 1, which sets this for in-window flex rows). Synthetic
   * leave-day windows always set it equal to rawEnd — unchanged behaviour. */
  attributionEnd: Date;
}

export interface AttributionResult {
  punchesByWindowKey: Map<string, CMSPunch[]>;
  coverageSufficientByWindowKey: Map<string, boolean>;
  unclaimedPunches: CMSPunch[];
  /** Windows built from a Cognos row whose LOGIN ID was blank — structurally impossible to join
   * to any CMS punch. A blank join key is an inability to verify, never evidence of absence, so
   * these must be held for review rather than falling through to the no-punches-found branch. */
  missingJoinKeyWindowKeys: Set<string>;
  /** Windows involved in a punch-attribution tie that could not be resolved by either priority
   * rule (real shift beats a synthetic leave-day window; earlier start breaks a remaining tie) —
   * e.g. two windows with identical type AND identical start time. The punch is still assigned
   * deterministically so evaluation can proceed, but every window in the tied group is flagged so
   * a reviewer checks it rather than trusting the guess silently. */
  ambiguousAttributionWindowKeys: Set<string>;
  /** Windows that could legitimately have claimed a punch but lost it to a nearer window.
   * Attribution assigns each punch to exactly one window, so a neighbouring shift taking a
   * boundary punch can leave this window holding a single punch — which the verdict logic
   * reads as Rule 6 "no login or no logout" and turns into an unpaid ABSENT. That would make
   * an attribution judgement call, not evidence, the reason someone loses a day's pay. Rows
   * flagged here are held for review instead whenever their punch count is too low to judge. */
  contestedWindowKeys: Set<string>;
  /** true when the CMS export holds at least one punch anywhere for this window's Login ID
   * (even if none fell inside the search window). Distinguishes "this Login ID has genuinely
   * no CMS record at all" from "a punch exists but not here" for the comparison layer — see
   * cognosComparison.ts's timeOfDayColumn, which must not report a Cognos SIGIN IN/SIGIN OUT
   * value as MISMATCH when the underlying evidence to compare against was never captured in
   * the first place. */
  hasAnyCmsDataByWindowKey: Map<string, boolean>;
  /** true when the export covers this window's own [rawStart, attributionEnd] span (not just
   * the search-radius-padded coverage check above) — true when there is no CMS data at all for
   * this login, matching coverageSufficientByWindowKey's convention. Distinguishes "the export
   * genuinely stops before this shift ends" (a coverage gap that can hide a real late-shift
   * logout) from "the shift is fully inside covered days" for the multi-punch truncated-export
   * gate in reconciliationEngine.ts. */
  shiftSpanCoveredByWindowKey: Map<string, boolean>;
}

/**
 * Distance from a timestamp to a raw interval: 0 if inside, otherwise the
 * distance to the nearer edge. Used to resolve which of two overlapping
 * search windows (e.g. a night shift's tail vs. the next day's own shift) a
 * punch nearest belongs to — Phase 1 "single-claim" guard.
 */
function distanceToInterval(t: number, start: number, end: number): number {
  if (t >= start && t <= end) return 0;
  return Math.min(Math.abs(t - start), Math.abs(t - end));
}

interface DayCoverage { start: number; end: number; }

/**
 * F3a fix: coverage must be judged against what the WHOLE CMS export actually
 * contains, not one login's own punch timestamps — an employee who simply
 * stopped punching early is indistinguishable, when measured per-login, from
 * an export that stops early (68 real rows on a fully-covered day were held
 * this way before the fix). Every calendar date present anywhere in the
 * export is treated as fully covered (00:00-24:00) EXCEPT the single latest
 * date, which is covered only up to the latest punch timestamp observed
 * anywhere in the export that day — CMS exports are generated as complete
 * daily files except for the current, possibly mid-shift, day.
 */
function buildExportDayCoverage(allPunches: CMSPunch[]): Map<number, DayCoverage> {
  const maxTsByDayStart = new Map<number, number>();
  allPunches.forEach(p => {
    // F4: a still-clocked-in punch (LogoutDateTime null) still proves the
    // export reaches its LoginDateTime — just not any further via this row.
    const timestamps = [p.LoginDateTime, p.LogoutDateTime].filter((d): d is Date => d !== null);
    timestamps.forEach(dt => {
      const dayStart = startOfDay(dt).getTime();
      const ts = dt.getTime();
      const prev = maxTsByDayStart.get(dayStart);
      if (prev === undefined || ts > prev) maxTsByDayStart.set(dayStart, ts);
    });
  });
  const dayStarts = Array.from(maxTsByDayStart.keys());
  if (dayStarts.length === 0) return new Map();
  const latestDayStart = Math.max(...dayStarts);
  const coverage = new Map<number, DayCoverage>();
  const oneDayMs = 24 * 60 * 60 * 1000;
  dayStarts.forEach(dayStart => {
    coverage.set(dayStart, dayStart === latestDayStart
      ? { start: dayStart, end: maxTsByDayStart.get(dayStart)! }
      : { start: dayStart, end: dayStart + oneDayMs });
  });
  return coverage;
}

/** Walks [rangeStart, rangeEnd) one calendar day at a time, requiring the export's
 * own coverage to reach at least as far as each day's portion of the range. */
function isRangeCoveredByExport(coverage: Map<number, DayCoverage>, rangeStart: number, rangeEnd: number): boolean {
  const oneDayMs = 24 * 60 * 60 * 1000;
  let cursor = rangeStart;
  while (cursor < rangeEnd) {
    const dayStart = startOfDay(new Date(cursor)).getTime();
    const dayEnd = dayStart + oneDayMs;
    const cov = coverage.get(dayStart);
    if (!cov) return false;
    const segmentEnd = Math.min(rangeEnd, dayEnd);
    if (cov.end < segmentEnd) return false;
    cursor = dayEnd;
  }
  return true;
}

/**
 * Global one-pass punch attribution (Phase 1). Every punch is assigned to at
 * most one scheduled window — the nearest one whose search range contains it
 * — so a night shift's closing punch can never simultaneously feed the next
 * day's window (the false-absence/false-late-logout defect this replaces).
 *
 * Punches are grouped by CMS Login ID; windows are also matched by Login ID
 * (the mandatory CMS join key — never ASPECT's EMP_EXTRA_3).
 */
export function attributePunches(
  windows: ScheduledWindow[],
  punchesByLoginId: Map<string, CMSPunch[]>,
  config: ConfigRegistry
): AttributionResult {
  const searchMs = config.cmsPunchSearchWindowHours * 60 * 60 * 1000;
  const punchesByWindowKey = new Map<string, CMSPunch[]>();
  const claimedPunchRefs = new Set<CMSPunch>();
  const allAssignedPunches = new Set<CMSPunch>();
  const ambiguousAttributionWindowKeys = new Set<string>();
  const contestedWindowKeys = new Set<string>();

  // A blank LOGIN ID cannot be joined to any CMS punch at all — flag it up
  // front rather than letting it silently fall through to "no punches found"
  // (which the verdict logic would otherwise treat as evidence of absence).
  const missingJoinKeyWindowKeys = new Set<string>();
  windows.forEach(w => {
    if (!w.loginId) missingJoinKeyWindowKeys.add(w.key);
  });

  // Group windows by loginId so each login's punches are only ever compared
  // against that login's own windows.
  const windowsByLogin = new Map<string, ScheduledWindow[]>();
  windows.forEach(w => {
    if (!w.loginId) return;
    if (!windowsByLogin.has(w.loginId)) windowsByLogin.set(w.loginId, []);
    windowsByLogin.get(w.loginId)!.push(w);
  });

  windowsByLogin.forEach((loginWindows, loginId) => {
    const punches = punchesByLoginId.get(loginId) || [];
    // Every punch event (login+logout timestamps ~seconds apart) is
    // evaluated as two candidate instants — its login time and its logout
    // time — since either may be the one that actually falls inside a
    // window's search range near a boundary.
    punches.forEach(p => {
      // F4: a still-clocked-in punch (LogoutDateTime null) can still be
      // attributed to a window via its LoginDateTime alone.
      const candidates = [p.LoginDateTime, p.LogoutDateTime]
        .filter((d): d is Date => d !== null)
        .map(d => d.getTime());

      // Best distance achieved by each window that has at least one
      // candidate instant inside its search range.
      const distanceByWindow = new Map<ScheduledWindow, number>();
      for (const w of loginWindows) {
        // A synthetic leave-day window is a whole-calendar-day placeholder, not a real
        // shift. A punch that LOGGED IN before that day began belongs to the previous
        // day's shift; the ±search tolerance exists to catch a shift's own late
        // logout, so it must never let an earlier day's session be charged to a leave
        // day (real case: a 09:29–20:34 session on 17/09 was attributed to an ANNUAL
        // leave day on 18/09 and produced a false "login on leave day" ABSENT).
        if (w.isSynthetic && p.LoginDateTime.getTime() < w.rawStart.getTime()) continue;
        const rangeStart = w.rawStart.getTime() - searchMs;
        const rangeEnd = w.attributionEnd.getTime() + searchMs;
        let best = Infinity;
        for (const t of candidates) {
          if (t < rangeStart || t > rangeEnd) continue;
          const dist = distanceToInterval(t, w.rawStart.getTime(), w.attributionEnd.getTime());
          if (dist < best) best = dist;
        }
        if (best !== Infinity) distanceByWindow.set(w, best);
      }
      if (distanceByWindow.size === 0) return;

      const minDistance = Math.min(...distanceByWindow.values());
      const tied = Array.from(distanceByWindow.entries())
        .filter(([, d]) => d === minDistance)
        .map(([w]) => w);

      let winner: ScheduledWindow;
      if (tied.length === 1) {
        winner = tied[0];
      } else {
        // Tie-break 1: a real scheduled shift beats a synthetic leave-day
        // placeholder — a punch equally close to a genuine shift and a
        // leave-day full-day window belongs to the shift.
        const realShifts = tied.filter(w => !w.isSynthetic);
        const pool = realShifts.length > 0 ? realShifts : tied;
        if (pool.length === 1) {
          winner = pool[0];
        } else {
          // Tie-break 2: remaining ties go to the earlier-starting window.
          const sorted = [...pool].sort((a, b) => a.rawStart.getTime() - b.rawStart.getTime());
          winner = sorted[0];
          // Tie-break 3: if the start time is ALSO identical, this is a
          // genuine unresolved ambiguity (never observed in real data, but
          // must not silently guess) — assign deterministically so
          // evaluation can proceed, but flag every tied window for review.
          const stillTied = sorted.filter(w => w.rawStart.getTime() === winner.rawStart.getTime());
          if (stillTied.length > 1) {
            stillTied.forEach(w => ambiguousAttributionWindowKeys.add(w.key));
          }
        }
      }

      // Every window that could have claimed this punch but did not is now potentially
      // short of evidence through no fault of the employee — record it.
      if (distanceByWindow.size > 1) {
        distanceByWindow.forEach((_d, w) => {
          if (w !== winner) contestedWindowKeys.add(w.key);
        });
      }

      if (!punchesByWindowKey.has(winner.key)) punchesByWindowKey.set(winner.key, []);
      punchesByWindowKey.get(winner.key)!.push(p);
      claimedPunchRefs.add(p);
      allAssignedPunches.add(p);
    });
  });

  const unclaimedPunches: CMSPunch[] = [];
  punchesByLoginId.forEach(punches => {
    punches.forEach(p => {
      if (!claimedPunchRefs.has(p)) unclaimedPunches.push(p);
    });
  });

  // CMS coverage: does the EXPORT actually extend to cover the days this
  // shift's own window needs? A cross-midnight shift on the last day of a
  // CMS export needs data into the next day that may simply not exist yet —
  // that is a coverage gap, not evidence of absence (defect: a lone matched
  // punch used to be treated as automatic proof of a missing counterpart).
  //
  // F3 fix (confirmed live in production data before this change): coverage
  // must be judged against the export's own extent (buildExportDayCoverage,
  // built from every punch in the export), not one login's own punch
  // timestamps — an employee who stopped punching early is indistinguishable
  // from an export that stops early when measured per-login (68 real rows on
  // a fully-covered day were wrongly held this way). The required window is
  // the shift's own [rawStart, rawEnd] plus the coverage grace, which always
  // equals the SAME radius attribution itself searches
  // (cmsPunchSearchWindowHours * 60 — see effectiveCmsCoverageGraceMinutes in
  // configRegistry.ts; user decision: one linked setting, not two). On a
  // partial/latest-day export, attribution still searches the full
  // ±searchHours radius for a companion punch, so proving only the shift's
  // own bounds are covered (while the real search radius reaches past the
  // export's actual cutoff) would let an uncaptured companion punch silently
  // resolve as absence instead of a coverage hold — hence grace == radius.
  const allPunchesFlat: CMSPunch[] = [];
  punchesByLoginId.forEach(punches => allPunchesFlat.push(...punches));
  const exportCoverage = buildExportDayCoverage(allPunchesFlat);
  const graceMs = effectiveCmsCoverageGraceMinutes(config) * 60 * 1000;
  const coverageSufficientByWindowKey = new Map<string, boolean>();
  const hasAnyCmsDataByWindowKey = new Map<string, boolean>();
  const shiftSpanCoveredByWindowKey = new Map<string, boolean>();
  windowsByLogin.forEach((loginWindows, loginId) => {
    const punches = punchesByLoginId.get(loginId) || [];
    const hasAnyData = punches.length > 0;
    loginWindows.forEach(w => hasAnyCmsDataByWindowKey.set(w.key, hasAnyData));

    loginWindows.forEach(w => {
      if (!hasAnyData) {
        // No CMS data for this login at all — a genuine "no login record"
        // case, not a coverage gap; let the normal No-Login rule handle it.
        coverageSufficientByWindowKey.set(w.key, true);
        shiftSpanCoveredByWindowKey.set(w.key, true);
        return;
      }
      const requiredStart = w.rawStart.getTime() - graceMs;
      const requiredEnd = w.attributionEnd.getTime() + graceMs;
      coverageSufficientByWindowKey.set(w.key, isRangeCoveredByExport(exportCoverage, requiredStart, requiredEnd));
      shiftSpanCoveredByWindowKey.set(w.key, isRangeCoveredByExport(exportCoverage, w.rawStart.getTime(), w.attributionEnd.getTime()));
    });
  });

  return {
    punchesByWindowKey,
    coverageSufficientByWindowKey,
    unclaimedPunches,
    missingJoinKeyWindowKeys,
    ambiguousAttributionWindowKeys,
    contestedWindowKeys,
    hasAnyCmsDataByWindowKey,
    shiftSpanCoveredByWindowKey,
  };
}

/**
 * Dataset-level advisory (not a per-row gate): warns before Calculate when
 * the CMS export doesn't actually reach every Cognos-reported calendar date,
 * so the user sees it before some rows fall back to per-row
 * INSUFFICIENT_CMS_COVERAGE holds.
 *
 * F3 fix: this used to require a flat N-day buffer (cmsRequiredCoverageDays
 * Before/After) beyond the WHOLE report's date range regardless of whether
 * any shift on those dates actually needed it — the exact over-broad trigger
 * the real per-row gate (attributePunches, above) was built to avoid. Now it
 * reuses that same export-coverage model per Cognos date, and reports which
 * specific dates and how many rows are affected instead of a blanket
 * file-level message.
 */
export function assessCmsCoverage(
  cognosDates: Date[],
  cmsPunches: CMSPunch[],
  _config: ConfigRegistry
): { sufficient: boolean; message: string } {
  if (cognosDates.length === 0 || cmsPunches.length === 0) {
    return { sufficient: cmsPunches.length > 0, message: cmsPunches.length === 0 ? 'No CMS punches uploaded yet.' : '' };
  }
  const exportCoverage = buildExportDayCoverage(cmsPunches);
  const oneDayMs = 24 * 60 * 60 * 1000;
  const distinctDayStarts = Array.from(new Set(cognosDates.map(d => startOfDay(d).getTime()))).sort((a, b) => a - b);
  const uncoveredDayStarts = distinctDayStarts.filter(dayStart => (
    !isRangeCoveredByExport(exportCoverage, dayStart, dayStart + oneDayMs)
  ));
  if (uncoveredDayStarts.length === 0) return { sufficient: true, message: '' };

  const uncoveredSet = new Set(uncoveredDayStarts);
  const affectedRowCount = cognosDates.filter(d => uncoveredSet.has(startOfDay(d).getTime())).length;
  const dateList = uncoveredDayStarts.map(ms => formatDateDDMMYYYY(new Date(ms))).join(', ');
  const message = `CMS export does not fully cover ${uncoveredDayStarts.length} Cognos date(s) (${dateList}) — ${affectedRowCount} row(s) affected. A shift on those dates may be held for review (INSUFFICIENT_CMS_COVERAGE) instead of auto-resolved.`;
  return { sufficient: false, message };
}

export interface DateOverlapAssessment {
  /** true when every distinct Cognos SIGN IN DATE has at least one ASPECT NOM_DATE to join
   * against. Advisory only — never gates Calculate; the per-row COGNOS_DATA_GAP hold already
   * does the actual gating. This exists purely so a 0-match run (both files loaded, both
   * non-empty, but simply covering different calendar days) is never silent. */
  sufficient: boolean;
  message: string;
  cognosDateCount: number;
  aspectDateCount: number;
  reconciledDateCount: number;
  /** Distinct DD/MM/YYYY dates present in the Cognos report with no ASPECT segment on that day. */
  cognosOnlyDates: string[];
  /** Distinct DD/MM/YYYY dates present in the ASPECT export with no Cognos row on that day. */
  aspectOnlyDates: string[];
}

/**
 * Dataset-level advisory (not a per-row gate): warns BEFORE Calculate when the uploaded Cognos
 * report and ASPECT schedule export cover different calendar days — the single most common way
 * this tool silently produces zero output (every row resolves to COGNOS_DATA_GAP, nothing warns
 * the user). Mirrors assessCmsCoverage's shape and call pattern. Both sides are normalized
 * through normalizeDateKey so a raw-string formatting difference (e.g. ASPECT's un-padded
 * "1/9/2026" vs Cognos's "01/09/2026") is never mistaken for a genuine date mismatch — the
 * per-row join in reconciliationEngine.ts uses the same normalization, so this report and the
 * actual run can never disagree about what counts as "the same day."
 */
export function assessDateOverlap(
  cognosRecords: CognosRecord[],
  aspectSegments: AspectSegment[],
): DateOverlapAssessment {
  const cognosDates = new Set<string>();
  cognosRecords.forEach(r => {
    const key = normalizeDateKey(r['SIGN IN DATE']);
    if (key) cognosDates.add(key);
  });
  const aspectDates = new Set<string>();
  aspectSegments.forEach(s => {
    const key = normalizeDateKey(s.NOM_DATE);
    if (key) aspectDates.add(key);
  });

  if (cognosDates.size === 0 || aspectDates.size === 0) {
    return {
      sufficient: true, message: '',
      cognosDateCount: cognosDates.size, aspectDateCount: aspectDates.size, reconciledDateCount: 0,
      cognosOnlyDates: [], aspectOnlyDates: [],
    };
  }

  const cognosOnlyDates = Array.from(cognosDates).filter(d => !aspectDates.has(d)).sort();
  const aspectOnlyDates = Array.from(aspectDates).filter(d => !cognosDates.has(d)).sort();
  const reconciledDateCount = cognosDates.size - cognosOnlyDates.length;
  const sufficient = cognosOnlyDates.length === 0;

  const preview = (dates: string[]) => dates.slice(0, 8).join(', ') + (dates.length > 8 ? `, +${dates.length - 8} more` : '');
  const message = sufficient
    ? ''
    : `The Cognos report and ASPECT schedule export cover different dates: ${cognosOnlyDates.length} of ${cognosDates.size} Cognos date(s) have NO matching ASPECT schedule (${preview(cognosOnlyDates)}). Every Cognos row on those dates will resolve to COGNOS_DATA_GAP and produce zero corrections. Confirm both exports were pulled for the same operational day(s) before running Calculate.`;

  return { sufficient, message, cognosDateCount: cognosDates.size, aspectDateCount: aspectDates.size, reconciledDateCount, cognosOnlyDates, aspectOnlyDates };
}

/** One affected employee in a HeadcountMappingAssessment preview list. */
export interface HeadcountEmployeePreview {
  pfNo: string;
  loginId: string;
  name: string;
}

export interface HeadcountMappingAssessment {
  /** !config.validateUploadedHeadcount always yields true. Otherwise true iff
   * lowestPercent >= config.minHeadcountMappingPercent. */
  sufficient: boolean;

  cognosEmployeeCount: number; // distinct non-blank PF NO
  cognosRowCount: number;

  withAspectEvidenceCount: number; // distinct Cognos PF NO also present as an ASPECT EMP_ID
  aspectPercent: number; // withAspectEvidenceCount / cognosEmployeeCount, 0-100
  aspectOnlyCount: number; // ASPECT EMP_IDs with no matching Cognos PF NO — ignored, diagnostic only
  missingAspectPreview: HeadcountEmployeePreview[]; // capped 8 (+N more folded into count only)

  /** Cognos employees Cognos itself already reports as having no attendance
   * (cognosClaimsAttendance === false for every one of their rows) — expected
   * to be absent from CMS by design, and excluded from the CMS denominator so
   * the CMS percentage is never understated. */
  cognosDeclaresNoAttendanceCount: number;
  /** Cognos employees with a blank LOGIN ID on every row — unjoinable to CMS by
   * definition (GATE 0 / MISSING_CMS_JOIN_KEY), also excluded from the CMS denominator. */
  cognosBlankLoginIdCount: number;
  /** cognosEmployeeCount minus the two exclusions above — the CMS denominator. */
  cmsExpectedEmployeeCount: number;
  withCmsEvidenceCount: number; // of cmsExpectedEmployeeCount, has >=1 CMS punch under their LOGIN ID
  cmsPercent: number; // withCmsEvidenceCount / cmsExpectedEmployeeCount, 0-100 (100 if denominator is 0)
  cmsOnlyCount: number; // CMS LoginIDs with no matching Cognos LOGIN ID — ignored, diagnostic only

  lowestPercent: number; // min(aspectPercent, cmsPercent) — the value the gate tests

  /** THE CRITICAL NUMBER: Cognos employees who claim attendance (cognosClaimsAttendance
   * true on at least one row) but have zero CMS punches under their LOGIN ID. These
   * will be auto-marked Absent NS/NC, directly contradicting what Cognos itself reports —
   * unlike cognosDeclaresNoAttendanceCount, which agrees with Cognos and is not a risk. */
  cognosClaimsAttendanceButNoCmsCount: number;
  cognosClaimsAttendanceButNoCmsRowCount: number;
  cognosClaimsAttendanceButNoCmsPreview: HeadcountEmployeePreview[]; // capped 8
}

const previewList = (items: HeadcountEmployeePreview[]): HeadcountEmployeePreview[] => items.slice(0, 8);

/**
 * Upload-time headcount mapping check — replaces the removed F03 per-row
 * CMS_EXPORT_SCOPE_GAP guard (2026-09-09, user-confirmed: CMS is a full-staff
 * export with no per-agent filtering, so "zero CMS punches" is now one
 * standard rule for every row, per reconciliationEngine.ts). Instead of a
 * hidden per-row guess, this makes the risk visible once at upload time:
 * every rate is anchored on the Cognos worklist (the report TAA validates and
 * actions), never a symmetric three-way overlap, since ASPECT and CMS are
 * only evidence sources for Cognos rows, not subjects of their own.
 */
export function assessHeadcountMapping(
  cognosRecords: CognosRecord[],
  aspectIdentities: AspectIdentity[],
  cmsPunches: CMSPunch[],
  config: ConfigRegistry
): HeadcountMappingAssessment {
  const empty: HeadcountMappingAssessment = {
    sufficient: true,
    cognosEmployeeCount: 0, cognosRowCount: 0,
    withAspectEvidenceCount: 0, aspectPercent: 100, aspectOnlyCount: 0, missingAspectPreview: [],
    cognosDeclaresNoAttendanceCount: 0, cognosBlankLoginIdCount: 0,
    cmsExpectedEmployeeCount: 0, withCmsEvidenceCount: 0, cmsPercent: 100, cmsOnlyCount: 0,
    lowestPercent: 100,
    cognosClaimsAttendanceButNoCmsCount: 0, cognosClaimsAttendanceButNoCmsRowCount: 0,
    cognosClaimsAttendanceButNoCmsPreview: [],
  };
  if (cognosRecords.length === 0) return empty;

  // One aggregate per employee (PF NO): a Cognos row's own LOGIN ID and
  // whether ANY of that employee's rows claims attendance. Cognos is per
  // employee-day, but this is a headcount (per-employee) check.
  interface EmpAgg { name: string; loginId: string; hasBlankLoginId: boolean; claimsAttendance: boolean; rowCount: number }
  const byPfNo = new Map<string, EmpAgg>();
  cognosRecords.forEach(r => {
    const pfNo = (r['PF NO'] || '').trim();
    if (!pfNo) return;
    const loginId = (r['LOGIN ID'] || '').trim();
    const claims = cognosClaimsAttendance(r);
    const existing = byPfNo.get(pfNo);
    if (existing) {
      existing.rowCount += 1;
      existing.claimsAttendance = existing.claimsAttendance || claims;
      if (loginId) { existing.loginId = loginId; existing.hasBlankLoginId = false; }
    } else {
      byPfNo.set(pfNo, {
        name: (r['NAME'] || '').trim(),
        loginId,
        hasBlankLoginId: !loginId,
        claimsAttendance: claims,
        rowCount: 1,
      });
    }
  });

  const cognosEmployeeCount = byPfNo.size;
  const cognosRowCount = cognosRecords.length;

  // ---- ASPECT coverage: Cognos PF NO <-> ASPECT EMP_ID (reconciliationEngine.ts's join key).
  const aspectIds = new Set<string>();
  aspectIdentities.forEach(id => { if (id.EMP_ID) aspectIds.add(id.EMP_ID.trim()); });

  let withAspectEvidenceCount = 0;
  const missingAspect: HeadcountEmployeePreview[] = [];
  byPfNo.forEach((agg, pfNo) => {
    if (aspectIds.has(pfNo)) {
      withAspectEvidenceCount++;
    } else {
      missingAspect.push({ pfNo, loginId: agg.loginId, name: agg.name });
    }
  });
  const aspectOnlyCount = Array.from(aspectIds).filter(id => !byPfNo.has(id)).length;
  // Keep the unrounded fraction for the threshold comparison below — rounding
  // first (e.g. a true 69.5% -> displayed 70%) could pass a 70% minimum that
  // the real, unrounded coverage does not meet. aspectPercent stays rounded
  // for display only.
  const aspectRawPercent = cognosEmployeeCount === 0 ? 100 : (withAspectEvidenceCount / cognosEmployeeCount) * 100;
  const aspectPercent = Math.round(aspectRawPercent);

  // ---- CMS coverage: Cognos LOGIN ID <-> CMS LoginID (reconciliationEngine.ts's join key).
  const cmsLoginIdsWithPunches = new Set<string>();
  cmsPunches.forEach(p => { if (p.LoginID) cmsLoginIdsWithPunches.add(p.LoginID.trim()); });

  let cognosDeclaresNoAttendanceCount = 0;
  let cognosBlankLoginIdCount = 0;
  let withCmsEvidenceCount = 0;
  let cmsExpectedEmployeeCount = 0;
  let cognosClaimsAttendanceButNoCmsCount = 0;
  let cognosClaimsAttendanceButNoCmsRowCount = 0;
  const claimsButNoCmsPreviewAll: HeadcountEmployeePreview[] = [];

  byPfNo.forEach((agg, pfNo) => {
    if (agg.hasBlankLoginId) { cognosBlankLoginIdCount++; return; }
    if (!agg.claimsAttendance) { cognosDeclaresNoAttendanceCount++; return; }
    // Only employees Cognos claims attendance for, with a real LOGIN ID, count
    // toward the CMS denominator — a Cognos-declared no-show is expected to be
    // absent from CMS by design, not a coverage gap.
    cmsExpectedEmployeeCount++;
    if (cmsLoginIdsWithPunches.has(agg.loginId)) {
      withCmsEvidenceCount++;
    } else {
      cognosClaimsAttendanceButNoCmsCount++;
      cognosClaimsAttendanceButNoCmsRowCount += agg.rowCount;
      claimsButNoCmsPreviewAll.push({ pfNo, loginId: agg.loginId, name: agg.name });
    }
  });

  const cmsRawPercent = cmsExpectedEmployeeCount === 0 ? 100 : (withCmsEvidenceCount / cmsExpectedEmployeeCount) * 100;
  const cmsPercent = Math.round(cmsRawPercent);
  const cmsOnlyCount = Array.from(cmsLoginIdsWithPunches).filter(id => {
    // "outside the Cognos worklist" means no employee's LOGIN ID matches this
    // CMS id at all — check every aggregate's loginId, not just the expected subset.
    for (const agg of byPfNo.values()) { if (agg.loginId === id) return false; }
    return true;
  }).length;

  // Threshold comparison uses the unrounded raw percents (see aspectRawPercent
  // above) — a genuine 69.5% must not pass a 70% minimum just because it
  // displays as "70%". lowestPercent itself stays the rounded, displayed value.
  const lowestRawPercent = Math.min(aspectRawPercent, cmsRawPercent);
  const lowestPercent = Math.min(aspectPercent, cmsPercent);
  const sufficient = !config.validateUploadedHeadcount || lowestRawPercent >= config.minHeadcountMappingPercent;

  return {
    sufficient,
    cognosEmployeeCount, cognosRowCount,
    withAspectEvidenceCount, aspectPercent, aspectOnlyCount, missingAspectPreview: previewList(missingAspect),
    cognosDeclaresNoAttendanceCount, cognosBlankLoginIdCount,
    cmsExpectedEmployeeCount, withCmsEvidenceCount, cmsPercent, cmsOnlyCount,
    lowestPercent,
    cognosClaimsAttendanceButNoCmsCount, cognosClaimsAttendanceButNoCmsRowCount,
    cognosClaimsAttendanceButNoCmsPreview: previewList(claimsButNoCmsPreviewAll),
  };
}
