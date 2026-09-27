import { AspectSegment, ConfigRegistry, GlossaryEntry, RemovalPosition, RemovalTraceEntry } from '../types/taa';
import { parseDateTimeString, truncateToMinute } from './parsers';

export interface ScheduleBlock {
  start: Date;
  end: Date;
}

export interface DayScheduleRecompute {
  rawStart: Date | null;
  rawEnd: Date | null;
  effectiveStart: Date | null;
  effectiveEnd: Date | null;
  netScheduledMinutes: number;
  leadingReleaseMinutes: number;
  trailingReleaseMinutes: number;
  releaseMinutes: number; // leading + trailing + mid-shift (deducted, window unmoved) + full-day, for reporting
  /** Minutes taken off netScheduledMinutes by full-day (duration-less, timestamp-less)
   * removals — the day's whole remaining schedule. Already included in releaseMinutes. */
  fullDayRemovalMinutes: number;
  nursingMinutes: number;
  /** Minutes subtracted from netScheduledMinutes by OT_INTERNAL removals (a release
   * fully contained inside OT1/OT2) — union-safe against leading/trailing, so
   * raw additions - releaseMinutes - nursingMinutes - otInternalRemovalMinutes always
   * reconciles exactly to netScheduledMinutes. Reported separately from releaseMinutes
   * because it never moves effectiveStart/effectiveEnd the way a leading/trailing
   * release does — see otInternalRemovalSegments below. */
  otInternalRemovalMinutes: number;
  ot1Minutes: number;
  ot2Minutes: number;
  /** The single contiguous OT1/OT2 time window for the day, ONLY when every OT1 (resp.
   * OT2) addition segment that day merges into exactly one block (perBlockGapThresholdMinutes).
   * Null when there is no OT1/OT2 that day OR when it splits into 2+ non-contiguous
   * windows — never a guessed/combined range. Comparison-display only, same as
   * duty1Block/duty2Block: ot1Minutes/ot2Minutes (the sum) is what actually drives
   * TAA_OT1/TAA_OT2 and pay. */
  ot1Block: ScheduleBlock | null;
  ot2Block: ScheduleBlock | null;
  duty1Block: ScheduleBlock | null;
  duty2Block: ScheduleBlock | null;
  /** Every distinct non-OT addition block (SHIFT/COVER/custom ADDITION) found on this
   * day, chronologically, after merging within perBlockGapThresholdMinutes.
   * Comparison-only (§4.9), same as duty1Block/duty2Block — never drives
   * netScheduledMinutes/rawStart/rawEnd/the verdict. */
  nonOtBlocks: ScheduleBlock[];
  /** Same, but only OT1/OT2 additions. */
  otBlocks: ScheduleBlock[];
  /** True when duty1Block/duty2Block could not be assigned deterministically from an
   * unmodeled schedule shape (3+ non-OT blocks, a genuine second shift co-occurring
   * with real OT, or OT itself splitting into more than one block) — duty2Block is
   * left null rather than guessed. The comparison layer will naturally MISMATCH
   * against whatever Cognos shows in DUTY-2 in that case; this flag exists so the
   * row's trace can say why, even on the rarer occasion Cognos's own DUTY-2 happens
   * to be blank too and the comparison alone would miss it. */
  scheduleShapeUnresolved: boolean;
  isLeaveDay: boolean;
  /** Segments matching config.nonWorkingDaySegmentCodes — the codes driving isLeaveDay.
   * A superset of the day's identified leave segments (also includes non-leave
   * non-working codes such as OFF). See isCodeInConfiguredSet. */
  nonWorkingSegments: AspectSegment[];
  unclassifiedCodes: string[];
  outOfWindowRemovalSegments: AspectSegment[];
  /** A REMOVAL that carves out of the MIDDLE of the shift (touching neither raw end, and not
   * chained to a removal that does). Its minutes ARE deducted from netScheduledMinutes and
   * reported in releaseMinutes, but it never moves effectiveStart/effectiveEnd — moving the
   * END would manufacture an early/late-logout finding out of nothing. Informational for
   * the audit trail; it no longer holds the row. */
  midShiftRemovalSegments: AspectSegment[];
  /** A REMOVAL fully contained inside the OT1/OT2 window(s) — e.g. an RLS overlapping
   * overtime. The MID-shift risk (fabricating an early/late-logout by moving an
   * attendance anchor) does not apply here, since neither effectiveStart nor
   * effectiveEnd sits inside overtime to move. This reduces netScheduledMinutes (the
   * hours actually required that day) but never the effective window, and is left for
   * Rule 8 (RLS-over-OT, evaluateRlsOtAdjustment) to correct the OT duration — so the
   * row is never held for this reason alone. */
  otInternalRemovalSegments: AspectSegment[];
  /** A REMOVAL whose minutes cannot be resolved (e.g. only one of START/STOP present).
   * A fully bare removal is NOT in this list any more — it is a full-day removal (see
   * fullDayRemovalSegments). Unknown removals contribute nothing and hold the row. */
  unknownDurationRemovalSegments: AspectSegment[];
  /** Segments whose DURATION disagrees with (STOP_MOMENT - START_MOMENT). Both numbers
   * feed the maths (hours from DURATION, window from timestamps) so a disagreement means
   * one of the two verdicts is wrong; a human decides which. */
  durationDisagreementSegments: AspectSegment[];
  /** Segments with malformed, incomplete, reversed, or internally inconsistent dates/times. */
  invalidDateTimeSegments: AspectSegment[];
  /** R5 fix: a removal with only a DURATION (no usable START/STOP timestamps) sitting in
   * the same LEADING or TRAILING group as a timestamped removal — there's no way to tell
   * whether it overlaps the timestamped one(s), so netScheduledMinutes may still be
   * double-subtracting an overlap. Every segment in the affected group; never guessed. */
  ambiguousOverlappingRemovalSegments: AspectSegment[];
  /** Two or more ADDITION segments (e.g. two different COVER rows) that genuinely
   * overlap in time — distinct from the byte-identical-duplicate dedup above, which
   * only catches an exact re-imported copy of the same row. A real overlap between
   * two DIFFERENT addition rows was previously summed into netScheduledMinutes with
   * no check at all; every segment in an overlapping pair is flagged here instead. */
  ambiguousOverlappingAdditionSegments: AspectSegment[];
  /** True when the raw removal/addition arithmetic below would have produced a
   * negative netScheduledMinutes (e.g. a 480-minute shift minus a 600-minute
   * duration-only removal) — the returned netScheduledMinutes is clamped to 0
   * rather than reporting a negative paid-hours total, and the row is held via
   * NEGATIVE_NET_SCHEDULE_MINUTES instead of silently flooring with no trace. */
  negativeNetScheduleMinutes: boolean;
  /** A segment whose DURATION cell was malformed text (not simply blank) and was
   * silently repaired from its own START_MOMENT/STOP_MOMENT — see the type comment
   * on AspectSegment.DURATION_TEXT_MALFORMED. */
  malformedDurationRepairedSegments: AspectSegment[];
  /** Per-removal audit trail: position, minutes, and where those minutes came from. */
  removalTrace: RemovalTraceEntry[];
  shiftSegments: AspectSegment[];
  ot1Segments: AspectSegment[];
  ot2Segments: AspectSegment[];
  coverSegments: AspectSegment[];
  additionSegments: AspectSegment[];
  removalSegments: AspectSegment[];
  /** Full-day ADDITION segments (no DURATION, no timestamps, not SHIFT/OT1/OT2/COVER). They
   * equal the day's own schedule (contributing nothing extra) or, with no schedule, the
   * config default. Deliberately NOT in additionSegments: they carry no window. */
  fullDayAdditionSegments: AspectSegment[];
  /** Full-day REMOVAL segments (no DURATION, no timestamps): each takes the day's whole
   * remaining schedule. Deliberately NOT in removalSegments (nothing to position). */
  fullDayRemovalSegments: AspectSegment[];
}

const PROXIMITY_TOLERANCE_MINUTES_DEFAULT = 2;

/** Total minutes covered by a set of intervals, counting overlapping time once.
 * Used to fix F04: two removal segments covering the same physical hour (e.g. an
 * RLS and a NURSNG both 16:00-17:00) must remove 60 minutes from paid hours, not 120. */
function unionedIntervalMinutes(intervals: { start: Date; end: Date }[]): number {
  const sorted = intervals
    .map(i => ({ start: i.start.getTime(), end: i.end.getTime() }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return 0;
  let total = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= curEnd) {
      if (sorted[i].end > curEnd) curEnd = sorted[i].end;
    } else {
      total += Math.floor((curEnd - curStart) / 60000);
      curStart = sorted[i].start;
      curEnd = sorted[i].end;
    }
  }
  total += Math.floor((curEnd - curStart) / 60000);
  return total;
}

const truncToMinuteOrNull = (d: Date | null): Date | null => (d ? truncateToMinute(d) : null);

/**
 * Case-insensitive segment-glossary lookup. Defect fix: parseAspectSegments
 * uppercases every SEG_CODE on import, but 13 of the default glossary's own
 * keys (Cover_RLS, TRN Planned, Prestige Arb, ...) are mixed-case — so a
 * real ASPECT export's "COVER_RLS" could never match the glossary's
 * "Cover_RLS" entry, and that REMOVAL's minutes were silently never
 * subtracted from the shift (261 of 1389 real employee-days were held
 * UNCLASSIFIED_SEGMENT_CODE for exactly this reason). Route every glossary
 * read through this instead of indexing the Record directly.
 */
export function lookupGlossary(
  glossary: Record<string, GlossaryEntry>,
  code: string,
): GlossaryEntry | undefined {
  if (!code) return undefined;
  const direct = glossary[code];
  if (direct) return direct;
  const upper = code.trim().toUpperCase();
  for (const key of Object.keys(glossary)) {
    if (key.toUpperCase() === upper) return glossary[key];
  }
  return undefined;
}

/**
 * Single shared test for "is this SEG_CODE configured as a member of this code
 * set" (trimmed, case-insensitive) — the one place both the full-day gate
 * (nonWorkingDaySegmentCodes) and leave identification (leaveSegmentCodes) check
 * membership, so a newly configured code (e.g. HOSPTLZD) can never trigger one
 * list's behaviour but not the other's through a second, independent filter.
 */
export function isCodeInConfiguredSet(code: string, codes: string[]): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  return codes.some(c => c.trim().toUpperCase() === upper);
}

/**
 * Is this segment a real working block — the kind that makes its day a valid
 * "next working day" target for a cover? Glossary-driven: an ADDITION-role code
 * (SHIFT/OT1/OT2 by default, plus any site-added working code), minus COVER itself
 * (a correction, not a working day), write-only output codes, and any code the
 * site lists in nonWorkingDaySegmentCodes. An unclassified code is never a working
 * block (§6.4: never guess a role).
 */
export function isWorkingDaySegment(s: AspectSegment, config: ConfigRegistry): boolean {
  const code = (s.SEG_CODE || '').trim().toUpperCase();
  if (!code || code === 'COVER') return false;
  const entry = lookupGlossary(config.segmentGlossary, code);
  if (!entry || entry.role !== 'ADDITION' || entry.isWriteOnlyAction) return false;
  return !isCodeInConfiguredSet(code, config.nonWorkingDaySegmentCodes || []);
}

/**
 * Single source of truth for a segment's minute contribution — the thin wrapper every
 * existing call site uses. See resolveSegmentMinutes() below for the trust order and for
 * how a full-day (duration-less, timestamp-less) segment is resolved. Callers that know the
 * day's schedule use resolveSegmentMinutes() directly and pass it in.
 */
export function segmentDurationMinutes(
  s: AspectSegment,
  glossary: Record<string, GlossaryEntry>,
  defaultFullDayMinutes: number,
): number {
  return resolveSegmentMinutes(s, glossary, defaultFullDayMinutes).minutes;
}

/** Schedule-defining ADDITION codes: without timestamps they cannot define the day's window,
 * so a bare one is bad data (held INVALID_ASPECT_DATETIME), never a "full-day" segment. */
const SCHEDULE_DEFINING_CODES = new Set(['SHIFT', 'OT1', 'OT2', 'COVER']);

/**
 * A "full-day" segment: ADDITION/REMOVAL role, no DURATION and neither START_MOMENT nor
 * STOP_MOMENT (both cells blank). Its duration is the day's own schedule, not a per-code
 * guess — see resolveSegmentMinutes. A bare schedule-defining ADDITION (SHIFT/OT1/OT2/COVER)
 * is never full-day; it stays invalid data.
 */
export function isFullDayBareSegment(s: AspectSegment, glossary: Record<string, GlossaryEntry>): boolean {
  if (s.DURATION != null) return false;
  if ((s.START_MOMENT || '').trim() || (s.STOP_MOMENT || '').trim()) return false;
  const role = lookupGlossary(glossary, s.SEG_CODE)?.role;
  if (role === 'REMOVAL') return true;
  return role === 'ADDITION' && !SCHEDULE_DEFINING_CODES.has((s.SEG_CODE || '').trim().toUpperCase());
}

/**
 * Resolve a segment's minute contribution AND say where the number came from.
 *
 * Order of trust:
 *   1. an explicit DURATION (including a deliberate 0);
 *   2. the segment's own START_MOMENT/STOP_MOMENT span;
 *   3. for a full-day segment (ADDITION or REMOVAL with no DURATION and no timestamps):
 *      the day's own scheduled duration (`scheduledDayMinutes`, SHIFT + OT + COVER) when
 *      the day has one, otherwise the configured full-day default.
 *
 * Any other REMOVAL without a usable number (e.g. only one of START/STOP) returns 'UNKNOWN'
 * with zero minutes — never a guess. Callers that do not know the day's schedule omit
 * `scheduledDayMinutes` and get the configured default for a full-day segment.
 */
export function resolveSegmentMinutes(
  s: AspectSegment,
  glossary: Record<string, GlossaryEntry>,
  defaultFullDayMinutes: number,
  scheduledDayMinutes: number | null = null,
): { minutes: number; source: RemovalTraceEntry['minutesSource']; timestampMinutes: number | null } {
  const start = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
  const stop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
  const timestampMinutes =
    start && stop && stop.getTime() >= start.getTime()
      ? Math.round((truncateToMinute(stop).getTime() - truncateToMinute(start).getTime()) / 60000)
      : null;

  if (s.DURATION != null) return { minutes: s.DURATION, source: 'DURATION', timestampMinutes };
  if (timestampMinutes !== null) return { minutes: timestampMinutes, source: 'TIMESTAMPS', timestampMinutes };

  const role = lookupGlossary(glossary, s.SEG_CODE)?.role;
  if (isFullDayBareSegment(s, glossary)) {
    return scheduledDayMinutes != null && scheduledDayMinutes > 0
      ? { minutes: scheduledDayMinutes, source: 'FULL_DAY_SCHEDULE', timestampMinutes }
      : { minutes: defaultFullDayMinutes, source: 'FULL_DAY_DEFAULT', timestampMinutes };
  }
  // An ADDITION with a partial/odd timestamp shape keeps the long-standing default; it is
  // separately held as invalid data when its timestamps are malformed.
  if (role === 'ADDITION') return { minutes: defaultFullDayMinutes, source: 'FULL_DAY_DEFAULT', timestampMinutes };
  return { minutes: 0, source: 'UNKNOWN', timestampMinutes };
}

/**
 * Recompute a single employee-day's schedule ENTIRELY from ASPECT segment
 * data (Phase 2). Cognos's DUTY1/DUTY-2/SCH DURATION are never read here —
 * they are comparison TARGETS elsewhere (cognosComparison.ts), never inputs,
 * per the "never trust Cognos" non-negotiable. This also fixes the prior
 * window-building defect where only the FIRST SHIFT segment and OT2-only
 * days were considered, silently ignoring OT1 tails and any additional
 * SHIFT rows.
 */
export function recomputeDaySchedule(segments: AspectSegment[], config: ConfigRegistry): DayScheduleRecompute {
  const glossary = config.segmentGlossary;
  // Defect fix: the previous `|| PROXIMITY_TOLERANCE_MS_DEFAULT` tail silently
  // discarded a configured 0 (a legal value meaning "exact match only"),
  // because 0ms is falsy — turning it back into the 2-minute default.
  const proximityMs = (config.releaseProximityToleranceMinutes ?? PROXIMITY_TOLERANCE_MINUTES_DEFAULT) * 60 * 1000;

  const shiftSegments = segments.filter(s => s.SEG_CODE === 'SHIFT');
  const ot1Segments = segments.filter(s => s.SEG_CODE === 'OT1');
  const ot2Segments = segments.filter(s => s.SEG_CODE === 'OT2');
  const coverSegments = segments.filter(s => s.SEG_CODE === 'COVER');

  const unclassifiedCodes: string[] = [];
  const additionSegments: AspectSegment[] = [];
  const removalSegments: AspectSegment[] = [];

  const defaultFullDayMinutes = config.defaultFullDaySegmentDurationMinutes ?? 480;

  const invalidDateTimeSegments = segments.filter(seg => {
    const nomDate = parseDateTimeString(seg.NOM_DATE || '');
    const startDate = seg.START_DATE ? parseDateTimeString(seg.START_DATE) : null;
    const startText = (seg.START_MOMENT || '').trim();
    const stopText = (seg.STOP_MOMENT || '').trim();
    const start = startText ? parseDateTimeString(startText) : null;
    const stop = stopText ? parseDateTimeString(stopText) : null;
    const role = lookupGlossary(glossary, seg.SEG_CODE)?.role;

    if (!nomDate) return true;
    if (seg.START_DATE && !startDate) return true;
    if ((startText && !start) || (stopText && !stop)) return true;
    if (start && stop && stop.getTime() < start.getTime()) return true;
    // R5 fix: a REMOVAL with no timestamps at all is not malformed data — it's the
    // "bare release row" resolveSegmentMinutes' own trust order explicitly supports as
    // its FIRST-priority case (an explicit DURATION, timestamps second). The exemption
    // previously required DURATION to ALSO be null, so a duration-only removal (real
    // DURATION, genuinely no START/STOP — the common, documented case) was wrongly
    // flagged INVALID_ASPECT_DATETIME instead of being processed normally from its own
    // DURATION. A removal with neither DURATION nor timestamps still resolves to zero
    // minutes downstream (resolveSegmentMinutes' 'UNKNOWN' source) and is separately
    // held as REMOVAL_SEGMENT_DURATION_UNKNOWN — this exemption only needs to keep a
    // timestamp-less removal out of the "malformed date/time" bucket, never decide
    // whether its minutes are known.
    if (role === 'REMOVAL' && !startText && !stopText) return false;
    // A full-day ADDITION (non-schedule-defining code, no DURATION, no timestamps) is the
    // same "bare row" shape — its duration comes from the day's schedule / config default.
    if (isFullDayBareSegment(seg, glossary)) return false;
    if ((role === 'ADDITION' || role === 'REMOVAL') && (!start || !stop)) return true;
    if (startDate && start && (
      startDate.getFullYear() !== start.getFullYear() ||
      startDate.getMonth() !== start.getMonth() ||
      startDate.getDate() !== start.getDate()
    )) return true;
    return false;
  });

  // F11 fix: an ADDITION segment appearing twice with byte-identical timing
  // (same code, same START_MOMENT/STOP_MOMENT/DURATION — a re-imported or
  // duplicated ASPECT row, never a real second shift, since nobody works the
  // same code at the same instant twice) used to have its minutes summed
  // into netScheduledMinutes once per occurrence, silently doubling paid
  // hours. Genuinely different (non-identical) overlapping additions are
  // NOT deduped here — that is a real scheduling question this fix does not
  // attempt to resolve on its own.
  // Normalize a date/time field to its parsed instant (ms since epoch) rather than
  // the raw string for the dedup key below — two semantically identical segments
  // written in different accepted date formats (e.g. "29/08/2026 16:00" and
  // "2026-08-29 16:00") previously produced different raw-string keys and evaded
  // duplicate detection entirely. Falls back to the trimmed raw string only when
  // it doesn't parse at all, so an unparseable value still contributes SOMETHING
  // stable to the key rather than collapsing every unparseable segment together.
  const normalizedMomentKey = (raw: string | undefined): string => {
    if (!raw) return '';
    const parsed = parseDateTimeString(raw);
    return parsed ? String(parsed.getTime()) : raw.trim();
  };

  const additionDupeKey = (s: AspectSegment) =>
    `${s.SEG_CODE}|${normalizedMomentKey(s.START_MOMENT)}|${normalizedMomentKey(s.STOP_MOMENT)}|${s.DURATION ?? ''}`;

  // The day's scheduled duration (SHIFT + OT + COVER, before any removal): every deduped
  // ADDITION whose minutes come from a real DURATION or its own timestamps. This is what a
  // full-day (bare) segment takes as its own duration — the config default is only the
  // fallback when the day has no such schedule.
  let scheduledDayMinutes = 0;
  const seenBasisKeys = new Set<string>();
  segments.forEach(s => {
    if (lookupGlossary(glossary, s.SEG_CODE)?.role !== 'ADDITION' || isFullDayBareSegment(s, glossary)) return;
    const key = additionDupeKey(s);
    if (seenBasisKeys.has(key)) return;
    seenBasisKeys.add(key);
    const resolved = resolveSegmentMinutes(s, glossary, defaultFullDayMinutes);
    if (resolved.source === 'DURATION' || resolved.source === 'TIMESTAMPS') scheduledDayMinutes += resolved.minutes;
  });

  const seenAdditionKeys = new Set<string>();
  const fullDayAdditionSegments: AspectSegment[] = [];
  const fullDayRemovalSegments: AspectSegment[] = [];
  // Minutes a full-day ADDITION actually contributed (only ever on a day with no schedule of
  // its own). Counted as part of the day's schedule for full-day REMOVAL purposes below — see
  // fullDayRemovalBasis.
  let fullDayAdditionMinutes = 0;
  let netScheduledMinutes = 0;
  segments.forEach(s => {
    const entry = lookupGlossary(glossary, s.SEG_CODE);
    if (!entry) {
      if (!unclassifiedCodes.includes(s.SEG_CODE)) unclassifiedCodes.push(s.SEG_CODE);
      return; // never guess a role for an unclassified code (§6.4 zero-hardcode)
    }
    if (entry.role === 'ADDITION') {
      const dupeKey = additionDupeKey(s);
      if (seenAdditionKeys.has(dupeKey)) return;
      seenAdditionKeys.add(dupeKey);
      if (isFullDayBareSegment(s, glossary)) {
        // A full-day ADDITION equals the day's schedule, which the real SHIFT/OT/COVER rows
        // already count — adding it again would double the day. It contributes only when the
        // day has no schedule of its own (config default). Kept out of additionSegments: it
        // has no window, and must not make a leave day look like a worked day.
        fullDayAdditionSegments.push(s);
        if (scheduledDayMinutes === 0 && fullDayAdditionSegments.length === 1) {
          fullDayAdditionMinutes = defaultFullDayMinutes;
          netScheduledMinutes += defaultFullDayMinutes;
        }
        return;
      }
      netScheduledMinutes += segmentDurationMinutes(s, glossary, defaultFullDayMinutes);
      additionSegments.push(s);
    } else if (entry.role === 'REMOVAL') {
      // Hours are subtracted only after a removal is positioned (LEADING, TRAILING,
      // MID or OT_INTERNAL). An OUT_OF_WINDOW removal is held, not guessed — subtracting
      // it here would dock paid minutes on a row the ASPECT export already blocks.
      // A full-day (bare) removal is not positioned at all: it takes whatever is left of
      // the day's schedule once every timed removal has been applied (see below).
      if (isFullDayBareSegment(s, glossary)) fullDayRemovalSegments.push(s);
      else removalSegments.push(s);
    }
  });

  // A DURATION cell that was non-blank but malformed (rejected to undefined by the
  // F13 parser fix) silently repairs from START_MOMENT/STOP_MOMENT via
  // resolveSegmentMinutes' normal trust order below, with nothing to show it
  // happened — indistinguishable from a segment that always had a clean duration.
  // Surface it as a soft, reviewer-releasable signal rather than a forced hold: the
  // repaired number is exactly what the engine would compute anyway for a blank-
  // DURATION segment with real timestamps, but the source data still needs fixing.
  const malformedDurationRepairedSegments = segments.filter(s => {
    if (!s.DURATION_TEXT_MALFORMED) return false;
    const role = lookupGlossary(glossary, s.SEG_CODE)?.role;
    if (role !== 'ADDITION' && role !== 'REMOVAL') return false;
    return resolveSegmentMinutes(s, glossary, defaultFullDayMinutes).source === 'TIMESTAMPS';
  });

  // Two or more DIFFERENT ADDITION segments genuinely overlapping in time (e.g.
  // two distinct COVER rows covering the same window) are summed into
  // netScheduledMinutes above with no check at all — the F11 dedup right above
  // only catches a byte-identical re-imported duplicate of the SAME row. Flag
  // every segment in an overlapping pair rather than silently paying for the
  // overlap twice. A strict interval intersection (start < otherEnd AND
  // otherStart < end) means two segments merely touching — SHIFT ending exactly
  // when OT1 starts, the normal 0-minute-gap case — is never flagged.
  const additionIntervalsForOverlapCheck = additionSegments
    .map(s => {
      const start = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
      const stop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
      if (!start || !stop) return null;
      const st = truncateToMinute(start);
      const en = truncateToMinute(stop);
      if (en.getTime() <= st.getTime()) return null;
      return { start: st, end: en, seg: s };
    })
    .filter((x): x is { start: Date; end: Date; seg: AspectSegment } => x !== null);

  // A COVER nested inside a SHIFT is NOT an ambiguous overlap — it is the normal,
  // documented shape this engine already models: COVER adds minutes
  // (netScheduledMinutes = DUTY1 + OT + COVER − releases) while deliberately never
  // extending the attendance window (config.coverExtendsAttendanceWindow, default
  // false), and Rule 7 exists specifically to check a COVER against the attended
  // span. The bundled sample dataset carries exactly this shape (a 12-minute COVER
  // inside an 08:00-16:00 shift). Flagging it would withhold that day's real
  // corrections over a scheduling pattern the rest of the app treats as routine.
  // Only same-kind overlaps are genuinely ambiguous: two COVERs claiming the same
  // minutes, or two schedule-defining segments (SHIFT/OT) doing so.
  const isCoverSegment = (s: AspectSegment) => (s.SEG_CODE || '').trim().toUpperCase() === 'COVER';
  const ambiguousOverlappingAdditionSegments: AspectSegment[] = (() => {
    const flagged = new Set<AspectSegment>();
    for (let i = 0; i < additionIntervalsForOverlapCheck.length; i++) {
      for (let j = i + 1; j < additionIntervalsForOverlapCheck.length; j++) {
        const a = additionIntervalsForOverlapCheck[i];
        const b = additionIntervalsForOverlapCheck[j];
        if (isCoverSegment(a.seg) !== isCoverSegment(b.seg)) continue; // COVER vs shift/OT — routine
        if (a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()) {
          flagged.add(a.seg);
          flagged.add(b.seg);
        }
      }
    }
    return Array.from(flagged);
  })();

  // Raw window = earliest start / latest stop across every ADDITION segment
  // that carries real timestamps (SHIFT, OT1, OT2, or any code the glossary
  // marks Addition) — not just the first SHIFT row. COVER is excluded by
  // default (config.coverExtendsAttendanceWindow): it is a correction
  // mechanism, not part of the shift's own attendance window — an
  // unattended cover placed after shift end must not push effectiveEnd
  // later and get charged as both an early-logout AND a separate
  // cover-not-attended finding for the same day. COVER still counts toward
  // netScheduledMinutes above either way — the hours formula needs it.
  const windowAdditionSegments = config.coverExtendsAttendanceWindow
    ? additionSegments
    : additionSegments.filter(s => s.SEG_CODE !== 'COVER');
  let rawStart: Date | null = null;
  let rawEnd: Date | null = null;
  // Every schedule-derived instant is truncated to the whole minute, exactly as CMS punches
  // already are. diffInMinutes() FLOORS, so a schedule timestamp carrying :30 seconds would
  // turn a true 6-minute lateness into 5 — below the OPS band, no action, an under-charge
  // that hides a real variance. Truncating both sides makes every subtraction exact.
  windowAdditionSegments.forEach(s => {
    if (s.START_MOMENT) {
      const parsed = parseDateTimeString(s.START_MOMENT);
      const d = parsed ? truncateToMinute(parsed) : null;
      if (d && (!rawStart || d.getTime() < rawStart.getTime())) rawStart = d;
    }
    if (s.STOP_MOMENT) {
      const parsed = parseDateTimeString(s.STOP_MOMENT);
      const d = parsed ? truncateToMinute(parsed) : null;
      if (d && (!rawEnd || d.getTime() > rawEnd.getTime())) rawEnd = d;
    }
  });

  // ---- REMOVAL positioning (release / nursing carve-outs).
  //
  // The previous test asked whether a removal's STOP touched rawStart (leading) or whether
  // its START touched rawEnd (trailing), and sent everything else to trailing by default.
  // Checked against the real ASPECT export, NEITHER test ever matched: all four removal
  // segments in the sample reached the right answer only through the default branch. The
  // detection was dead code, which means a release sitting in the MIDDLE of a shift was
  // silently subtracted from the END — moving effectiveEnd earlier and manufacturing an
  // early-logout or late-logout finding out of nothing.
  //
  // Corrected classification, by containment:
  //   OUT_OF_WINDOW  starts before rawStart or stops after rawEnd — nothing valid to carve
  //   TRAILING       stops at rawEnd (checked first: a removal spanning the whole shift is
  //                  trailing, and collapses effectiveEnd back to rawStart)
  //   LEADING        starts at rawStart
  //   MID            anything else — never guessed, the row is held for a human
  const proximityToleranceMinutes = config.releaseProximityToleranceMinutes ?? PROXIMITY_TOLERANCE_MINUTES_DEFAULT;
  // Raw OT1/OT2 intervals (unmerged — this needs exact per-segment containment, not the
  // gap-merged `otBlocks` built later for DUTY-2 comparison purposes) — used below to
  // recognize a removal that falls entirely inside overtime rather than the shift itself.
  const otIntervals: { start: Date; end: Date }[] = [];
  [...ot1Segments, ...ot2Segments].forEach(s => {
    const start = s.START_MOMENT ? parseDateTimeString(s.START_MOMENT) : null;
    const stop = s.STOP_MOMENT ? parseDateTimeString(s.STOP_MOMENT) : null;
    if (start && stop) {
      const st = truncateToMinute(start);
      const en = truncateToMinute(stop);
      if (en.getTime() > st.getTime()) otIntervals.push({ start: st, end: en });
    }
  });
  const removalTrace: RemovalTraceEntry[] = [];
  const midShiftRemovalSegments: AspectSegment[] = [];
  const otInternalRemovalSegments: AspectSegment[] = [];
  const otInternalRemovalIntervals: { start: Date; end: Date }[] = [];
  const unknownDurationRemovalSegments: AspectSegment[] = [];
  const outOfWindowRemovalSegments: AspectSegment[] = [];
  const trailingRemovalStarts: Date[] = [];
  const leadingRemovalStops: Date[] = [];

  let leadingReleaseMinutes = 0;
  let trailingReleaseMinutes = 0;
  let nursingMinutes = 0;

  // F04 fix: netScheduledMinutes previously subtracted resolved.minutes once
  // PER removal segment, so two removals covering the SAME physical hour
  // (e.g. RLS 16:00-17:00 and NURSNG 16:00-17:00, both TRAILING) removed it
  // twice — undercounting paid minutes by the overlap, the same double-count
  // effectiveStart/effectiveEnd below were already protected against (they
  // anchor on the latest/earliest boundary, never sum). Removals with a real
  // timestamped interval are collected here and unioned before subtracting;
  // a removal with only a DURATION and no usable timestamps has no interval
  // to union against, so it still subtracts its own minutes directly (no
  // way to detect overlap without a position).
  const leadingRemovalIntervals: { start: Date; end: Date }[] = [];
  let leadingRemovalMinutesWithoutInterval = 0;
  const trailingRemovalIntervals: { start: Date; end: Date }[] = [];
  let trailingRemovalMinutesWithoutInterval = 0;
  // R5 fix: a removal with only a DURATION and no usable timestamps has no interval to
  // union against overlapping timestamped removals in the same LEADING/TRAILING group —
  // its own minutes still subtract directly (line below), which is correct when it truly
  // doesn't overlap the others, but silently wrong (the old F04 double-subtract bug, just
  // narrower) when it does. There's no way to tell from a duration-only row alone, so
  // track which segments are which per group and hold the row instead of guessing.
  const leadingSegsWithInterval: AspectSegment[] = [];
  const leadingSegsWithoutInterval: AspectSegment[] = [];
  const trailingSegsWithInterval: AspectSegment[] = [];
  const trailingSegsWithoutInterval: AspectSegment[] = [];

  // Chained removals. A release touching neither raw end is NOT mid-shift if it runs
  // back-to-back with (or overlaps) a removal that IS anchored to that end: RLS 12:00-15:00
  // + NURSNG 15:00-16:00 on an 08:00-16:00 shift is one 12:00-16:00 trailing block, and the
  // agent is simply not required from 12:00. Testing each removal against the raw ends
  // alone labelled the RLS "MID", left the effective end at 15:00, and would report a
  // false Early Logout for an agent who left at 12:00 exactly as released. Grow the
  // trailing (leading) block outward from the raw end (start) until no removal joins it.
  const chainedTrailing = new Set<AspectSegment>();
  const chainedLeading = new Set<AspectSegment>();
  if (rawStart && rawEnd) {
    const rawStartMs = (rawStart as Date).getTime();
    const rawEndMs = (rawEnd as Date).getTime();
    const candidates = removalSegments.flatMap(seg => {
      const ps = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
      const pe = seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null;
      if (!ps || !pe) return [];
      const start = truncateToMinute(ps).getTime();
      const stop = truncateToMinute(pe).getTime();
      if (stop <= start || start < rawStartMs - proximityMs || stop > rawEndMs + proximityMs) return [];
      return [{ seg, start, stop }];
    });
    const isDirectTrailing = (c: { start: number; stop: number }) => Math.abs(c.stop - rawEndMs) <= proximityMs;
    const isDirectLeading = (c: { start: number; stop: number }) => !isDirectTrailing(c) && Math.abs(c.start - rawStartMs) <= proximityMs;
    let trailingFrontier = candidates.filter(isDirectTrailing).reduce((min, c) => Math.min(min, c.start), Infinity);
    let leadingFrontier = candidates.filter(isDirectLeading).reduce((max, c) => Math.max(max, c.stop), -Infinity);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of candidates) {
        if (isDirectTrailing(c) || isDirectLeading(c) || chainedTrailing.has(c.seg) || chainedLeading.has(c.seg)) continue;
        if (c.stop >= trailingFrontier - proximityMs && c.start < trailingFrontier) {
          chainedTrailing.add(c.seg);
          trailingFrontier = c.start;
          grew = true;
        } else if (c.start <= leadingFrontier + proximityMs && c.stop > leadingFrontier) {
          chainedLeading.add(c.seg);
          leadingFrontier = c.stop;
          grew = true;
        }
      }
    }
  }

  // Removals that sit genuinely in the middle of the shift. They never move the
  // attendance window (subtracting from the END would invent an early/late logout) but the
  // minutes released are real, so they ARE deducted from scheduled hours — only the part
  // overlapping scheduled addition time, so a release in an unscheduled gap docks nothing.
  const midRemovalIntervals: { start: Date; end: Date }[] = [];
  const clipToAdditions = (start: Date, end: Date): { start: Date; end: Date }[] => {
    const clipped: { start: Date; end: Date }[] = [];
    additionIntervalsForOverlapCheck.forEach(a => {
      const s = a.start.getTime() > start.getTime() ? a.start : start;
      const e = a.end.getTime() < end.getTime() ? a.end : end;
      if (e.getTime() > s.getTime()) clipped.push({ start: s, end: e });
    });
    return clipped;
  };

  removalSegments.forEach(seg => {
    const parsedStart = seg.START_MOMENT ? parseDateTimeString(seg.START_MOMENT) : null;
    const parsedStop = seg.STOP_MOMENT ? parseDateTimeString(seg.STOP_MOMENT) : null;
    const segStart = parsedStart ? truncateToMinute(parsedStart) : null;
    const segStop = parsedStop ? truncateToMinute(parsedStop) : null;

    const resolved = resolveSegmentMinutes(seg, glossary, defaultFullDayMinutes);
    if (resolved.source === 'UNKNOWN') unknownDurationRemovalSegments.push(seg);

    let position: RemovalPosition;
    if (!segStart || !segStop || !rawStart || !rawEnd) {
      // No timestamps to position it with (a bare release row), or no ADDITION window at
      // all. A removal with no window to carve from is out-of-window; a removal with a
      // window but no timestamps keeps the long-standing "releases carve from the back"
      // assumption, which every observed release obeys.
      if (!rawStart || !rawEnd) {
        position = 'OUT_OF_WINDOW';
        outOfWindowRemovalSegments.push(seg);
      } else {
        position = 'TRAILING';
      }
    } else if (segStart.getTime() < (rawStart as Date).getTime() - proximityMs || segStop.getTime() > (rawEnd as Date).getTime() + proximityMs) {
      position = 'OUT_OF_WINDOW';
      outOfWindowRemovalSegments.push(seg);
    } else if (Math.abs(segStop.getTime() - (rawEnd as Date).getTime()) <= proximityMs) {
      position = 'TRAILING';
      trailingRemovalStarts.push(segStart);
    } else if (Math.abs(segStart.getTime() - (rawStart as Date).getTime()) <= proximityMs) {
      position = 'LEADING';
    } else if (chainedTrailing.has(seg)) {
      position = 'TRAILING';
      trailingRemovalStarts.push(segStart);
    } else if (chainedLeading.has(seg)) {
      position = 'LEADING';
    } else if (
      otIntervals.length > 0
      && unionedIntervalMinutes([...otIntervals, { start: segStart, end: segStop }]) === unionedIntervalMinutes(otIntervals)
    ) {
      // Fully contained inside OT1/OT2 — adds nothing beyond the OT union, so it never
      // straddles into the shift or into a gap between OT blocks. Rule 8 (RLS-over-OT)
      // already corrects the OT duration for this; this only needs to reduce the day's
      // reported scheduled hours, never move an attendance anchor.
      position = 'OT_INTERNAL';
      otInternalRemovalSegments.push(seg);
      otInternalRemovalIntervals.push({ start: segStart, end: segStop });
    } else {
      position = 'MID';
      midShiftRemovalSegments.push(seg);
      midRemovalIntervals.push(...clipToAdditions(segStart, segStop));
    }

    // Only a removal that actually sits inside the window may move the effective window.
    // An OUT_OF_WINDOW or MID one contributes nothing here — the row is held instead, so
    // the numbers a reviewer sees are never a guess dressed up as a measurement.
    if (position === 'LEADING') {
      leadingReleaseMinutes += resolved.minutes;
      if (segStop) leadingRemovalStops.push(segStop);
      if (segStart && segStop) {
        // The proximity tolerance lets a removal's own START sit up to
        // proximityMs BEFORE rawStart and still classify as LEADING (export
        // timing slop). Subtracting the removal's own START in that case would
        // carve minutes that were never part of the scheduled window at all —
        // clip the subtracted interval's start to rawStart itself.
        const clippedStart = rawStart && segStart.getTime() < (rawStart as Date).getTime() ? (rawStart as Date) : segStart;
        leadingRemovalIntervals.push({ start: clippedStart, end: segStop });
        leadingSegsWithInterval.push(seg);
      } else {
        leadingRemovalMinutesWithoutInterval += resolved.minutes;
        leadingSegsWithoutInterval.push(seg);
      }
    } else if (position === 'TRAILING') {
      // Clip FIRST, then account. The nursing/release accumulators must report the
      // same minutes the union subtraction actually removes below — reporting the
      // unclipped figure while subtracting the clipped one breaks the documented
      // `raw additions − release − nursing − otInternal = netScheduledMinutes`
      // reconciliation on exactly the rows this clip corrects.
      let trailingMinutes = resolved.minutes;
      if (segStart && segStop) {
        // Symmetric clip: a removal's own STOP may sit up to proximityMs AFTER
        // rawEnd and still classify as TRAILING — clip the subtracted
        // interval's end to rawEnd so the overrun is never carved from paid
        // minutes that were outside the scheduled window in the first place.
        const clippedStop = rawEnd && segStop.getTime() > (rawEnd as Date).getTime() ? (rawEnd as Date) : segStop;
        if (clippedStop.getTime() !== segStop.getTime()) {
          // Only when the clip actually moved the boundary: otherwise keep
          // resolved.minutes untouched, so an explicit DURATION that disagrees with
          // its own timestamps still reports exactly as before (that disagreement
          // is its own separate, deliberate SEGMENT_STOP_DURATION_DISAGREE hold).
          trailingMinutes = Math.max(0, Math.round((clippedStop.getTime() - segStart.getTime()) / 60000));
        }
        trailingRemovalIntervals.push({ start: segStart, end: clippedStop });
        trailingSegsWithInterval.push(seg);
      } else {
        trailingRemovalMinutesWithoutInterval += resolved.minutes;
        trailingSegsWithoutInterval.push(seg);
      }
      if (seg.SEG_CODE === 'NURSNG') nursingMinutes += trailingMinutes;
      else trailingReleaseMinutes += trailingMinutes;
    }

    const disagreement =
      resolved.source === 'DURATION' && resolved.timestampMinutes !== null && resolved.timestampMinutes !== resolved.minutes
        ? resolved.timestampMinutes - resolved.minutes
        : undefined;

    removalTrace.push({
      segCode: seg.SEG_CODE,
      start: seg.START_MOMENT || '',
      stop: seg.STOP_MOMENT || '',
      position,
      minutes: position === 'LEADING' || position === 'TRAILING' || position === 'OT_INTERNAL'
        ? resolved.minutes
        : position === 'MID' && segStart && segStop
          ? unionedIntervalMinutes(clipToAdditions(segStart, segStop))
          : 0,
      minutesSource: resolved.source,
      durationDisagreementMinutes: disagreement,
    });
  });

  netScheduledMinutes -= unionedIntervalMinutes(leadingRemovalIntervals) + leadingRemovalMinutesWithoutInterval;
  netScheduledMinutes -= unionedIntervalMinutes(trailingRemovalIntervals) + trailingRemovalMinutesWithoutInterval;
  // OT_INTERNAL removals (a release fully inside OT1/OT2) also reduce paid hours — but
  // subtract only the INCREMENTAL minutes on top of leading+trailing, so a release that
  // happens to already overlap a leading/trailing interval is never double-counted.
  // (User decision 2026-09-11: "8h shift + 2h OT + 2h OT - 2h RLS = 10h", by design.)
  // This incremental value is itself union-safe by construction (it IS the marginal
  // amount actually subtracted below) and is returned as otInternalRemovalMinutes so
  // the audit trail can reconcile raw additions - leading - trailing - nursing -
  // OT-internal = netScheduledMinutes exactly (bug fix 2026-09-11: this used to be an
  // inline expression never exposed, so "Release Deductions"/"Nursing Deductions" in
  // the UI didn't add up to the recomputed net for an OT-internal removal).
  const leadingTrailingIntervals = [...leadingRemovalIntervals, ...trailingRemovalIntervals];
  const otInternalRemovalMinutesReported = unionedIntervalMinutes([...leadingTrailingIntervals, ...otInternalRemovalIntervals])
    - unionedIntervalMinutes(leadingTrailingIntervals);
  netScheduledMinutes -= otInternalRemovalMinutesReported;
  // MID removals: incremental minutes on top of everything already subtracted, so a mid
  // release overlapping a leading/trailing/OT-internal one is never counted twice. The
  // window (effectiveStart/effectiveEnd) is deliberately NOT moved by these.
  const priorRemovalIntervals = [...leadingTrailingIntervals, ...otInternalRemovalIntervals];
  const midRemovalMinutesReported = unionedIntervalMinutes([...priorRemovalIntervals, ...midRemovalIntervals])
    - unionedIntervalMinutes(priorRemovalIntervals);
  netScheduledMinutes -= midRemovalMinutesReported;

  // Full-day (bare) removals: the segment covers the whole scheduled day, so it removes
  // whatever is still left after every timed removal above — never more, so it cannot
  // overshoot into a negative total, and it needs no window position (no OUT_OF_WINDOW /
  // ambiguity holds: "everything" overlaps by definition). A day with no schedule has
  // nothing to remove from: it removes 0 and reports the config default as its source.
  //
  // The basis counts a full-day ADDITION's own contribution too, not just the timed
  // SHIFT/OT/COVER rows. On a day whose ONLY scheduled minutes come from a full-day addition
  // (one leave code classed Addition, another classed Removal, both bare), the removal would
  // otherwise see "no schedule", remove nothing, and leave the day paid a full 8 hours while
  // netScheduledMinutes itself clearly said the day WAS scheduled — the two halves of the same
  // day's arithmetic disagreeing. Adding a real timed schedule makes fullDayAdditionMinutes 0
  // (the addition contributes nothing there), so this changes nothing for every other shape.
  const fullDayRemovalBasis = scheduledDayMinutes + fullDayAdditionMinutes;
  let fullDayRemovalMinutesReported = 0;
  fullDayRemovalSegments.forEach(seg => {
    const resolved = resolveSegmentMinutes(seg, glossary, defaultFullDayMinutes, fullDayRemovalBasis);
    const removed = resolved.source === 'FULL_DAY_SCHEDULE' ? Math.max(0, netScheduledMinutes) : 0;
    netScheduledMinutes -= removed;
    fullDayRemovalMinutesReported += removed;
    removalTrace.push({
      segCode: seg.SEG_CODE,
      start: '',
      stop: '',
      position: 'FULL_DAY',
      minutes: removed,
      minutesSource: resolved.source,
    });
  });

  // A removal (or combination of removals) exceeding the shift's own addition
  // minutes — e.g. a 480-minute shift minus a 600-minute duration-only release
  // — previously reported a negative netScheduledMinutes with no integrity
  // check at all. Clamp to 0 and flag it instead of silently reporting (or
  // exporting) a negative paid-hours total; the row is held via
  // NEGATIVE_NET_SCHEDULE_MINUTES in the engine rather than trusting the clamp.
  const negativeNetScheduleMinutes = netScheduledMinutes < 0;
  netScheduledMinutes = Math.max(0, netScheduledMinutes);

  // R5 fix: a duration-only removal coexisting with a timestamped removal in the SAME
  // leading/trailing group is exactly the "unknown windows overlapping" case the F04 fix's
  // own suggested fix said to hold rather than guess — there's no way to tell from a bare
  // duration whether it overlaps the timestamped removal(s) beside it. Flag every segment
  // in an affected group so the row is held instead of trusting a number that may still be
  // double-subtracting an overlap.
  // Also ambiguous even with NO timestamped removal in the group at all: two or
  // more duration-only removals (no timestamps on any of them) landing in the
  // same leading/trailing group have no way to detect whether THEY overlap each
  // other either — the original R5 fix only covered a duration-only removal
  // sitting beside a timestamped one, and silently summed 2+ duration-only
  // removals together with no ambiguity check.
  const ambiguousOverlappingRemovalSegments: AspectSegment[] = [
    ...((leadingSegsWithInterval.length > 0 && leadingSegsWithoutInterval.length > 0) || leadingSegsWithoutInterval.length > 1
      ? [...leadingSegsWithInterval, ...leadingSegsWithoutInterval] : []),
    ...((trailingSegsWithInterval.length > 0 && trailingSegsWithoutInterval.length > 0) || trailingSegsWithoutInterval.length > 1
      ? [...trailingSegsWithInterval, ...trailingSegsWithoutInterval] : []),
  ];

  let effectiveStart: Date | null = rawStart ? new Date((rawStart as Date).getTime()) : null;
  let effectiveEnd: Date | null = rawEnd ? new Date((rawEnd as Date).getTime()) : null;
  if (effectiveStart && leadingRemovalStops.length > 0) {
    // Latest leading STOP, not summed minutes — two overlapping morning RLS
    // rows must not push the start twice and over-charge Late.
    const latestLeadingStop = leadingRemovalStops.reduce((max, d) => (d.getTime() > max.getTime() ? d : max), leadingRemovalStops[0]);
    effectiveStart = new Date(latestLeadingStop.getTime());
  } else if (effectiveStart && leadingReleaseMinutes > 0) {
    effectiveStart = new Date(effectiveStart.getTime() + leadingReleaseMinutes * 60 * 1000);
  }
  if (effectiveEnd && trailingRemovalStarts.length > 0) {
    // Anchor on the EARLIEST trailing removal's own START, not on rawEnd minus summed
    // minutes. Summing double-counts two overlapping releases (e.g. RLS 14:00-15:00 and
    // NURSNG 14:00-15:00 would remove 120 minutes from an 8-hour shift instead of 60), and
    // it silently drifts whenever a segment's DURATION field disagrees with its own
    // timestamps. The instant the agent stops being required is a fact in the data; the
    // subtraction was an inference.
    const earliestTrailingStart = trailingRemovalStarts.reduce((min, d) => (d.getTime() < min.getTime() ? d : min), trailingRemovalStarts[0]);
    effectiveEnd = new Date(earliestTrailingStart.getTime());
  } else if (effectiveEnd && (trailingReleaseMinutes > 0 || nursingMinutes > 0)) {
    // Fallback for a trailing removal with no usable timestamps — the legacy arithmetic.
    effectiveEnd = new Date(effectiveEnd.getTime() - (trailingReleaseMinutes + nursingMinutes) * 60 * 1000);
  }
  // A full-day removal that took the day's schedule means the agent is not required at all:
  // the window collapses exactly as it does for an explicit whole-day release.
  if (fullDayRemovalMinutesReported > 0 && effectiveStart && effectiveEnd) {
    effectiveEnd = new Date(effectiveStart.getTime());
  }
  // A removal can never push the effective end before the shift even starts.
  if (effectiveEnd && effectiveStart && effectiveEnd.getTime() < effectiveStart.getTime()) {
    effectiveEnd = new Date(effectiveStart.getTime());
  }

  // Schedule-integrity check: when a segment carries a DURATION *and* both timestamps, the
  // two must agree. They feed different halves of the maths — DURATION drives the paid
  // hours total, the timestamps drive the attendance window — so a disagreement means one
  // of the two verdicts on this row is wrong. This also protects the bare-date STOP_MOMENT
  // case (59 of 663 SHIFT rows write "29/08/2026" with no time for a shift ending at
  // midnight): it is read as 00:00, which is right only while START + DURATION agrees.
  const durationDisagreementSegments: AspectSegment[] = segments.filter(seg => {
    const role = lookupGlossary(glossary, seg.SEG_CODE)?.role;
    if (role !== 'ADDITION' && role !== 'REMOVAL') return false; // NO_EFFECT tags never move a number
    if (seg.DURATION == null) return false;
    const resolved = resolveSegmentMinutes(seg, glossary, defaultFullDayMinutes);
    return resolved.timestampMinutes !== null && resolved.timestampMinutes !== seg.DURATION;
  });

  // Contiguous work blocks (§4.9), for comparison against Cognos's own DUTY1/DUTY-2 columns
  // ONLY — netScheduledMinutes/rawStart/rawEnd above already drive every pay-affecting
  // verdict and do not depend on these blocks.
  //
  // Defect fix: this previously merged ALL addition segments chronologically by TIME GAP
  // alone (Block 0 -> Duty1, everything else -> Duty2), regardless of segment role. Verified
  // against every real employee-day carrying both a SHIFT and OT1/OT2 (192/192): the OT
  // segment always starts the INSTANT the shift ends (0-minute gap), so the gap-based merge
  // collapsed every one of them into a single block — duty2Block was permanently null for
  // any day with real overtime. OT1/OT2 are different pay rates (CLAUDE.md Non-negotiables:
  // "never merge them") and Cognos's own DUTY-2 column exists specifically to carry a second
  // duty window. Split by ROLE instead: OT1/OT2 additions always form Duty2; every other
  // addition (SHIFT, COVER, any custom ADDITION code) forms Duty1. perBlockGapThresholdMinutes
  // still merges multiple segments WITHIN each group (e.g. two SHIFT rows on a genuine
  // split-shift day) — strictly less than the threshold, not <=, so a gap sitting exactly on
  // the boundary is treated as a real split rather than silently merged.
  const sortedAdditions = [...windowAdditionSegments]
    .map(s => ({
      s,
      start: s.START_MOMENT ? truncToMinuteOrNull(parseDateTimeString(s.START_MOMENT)) : null,
      stop: s.STOP_MOMENT ? truncToMinuteOrNull(parseDateTimeString(s.STOP_MOMENT)) : null,
    }))
    .filter(x => x.start && x.stop)
    .sort((a, b) => (a.start as Date).getTime() - (b.start as Date).getTime());

  const gapMs = (config.perBlockGapThresholdMinutes ?? 60) * 60 * 1000;
  // Defect fix (A4): this used to build the correct blocks[] array below and then
  // immediately throw it away — collapsing to {start: blocks[0].start, end:
  // blocks[last].end}, one span covering the gap regardless of the threshold. A
  // split shift 07:00-11:00 / 18:00-22:00 (a 7-hour gap) became one 15-hour block no
  // matter what perBlockGapThresholdMinutes was configured to. Return every distinct
  // merged block — the caller decides how to use them, never collapsed here.
  //
  // A SHIFT segment is never merged into a block that already holds another SHIFT, whatever
  // the gap. Cognos lists every SHIFT segment as its own duty (DUTY1, then DUTY-2), so two
  // back-to-back shifts (08:00-16:00 then 16:00-17:00, a 0-minute gap that the threshold
  // used to swallow) are two blocks, not one 08:00-17:00 block. Verified on the real data: on
  // the 17-21 Sept files all 29 two-shift days have a 0-minute gap, 0 of 29 matched Cognos
  // DUTY1/DUTY-2 when merged and 29 of 29 match kept apart. OT1/OT2 and non-SHIFT additions
  // still merge by the threshold (a contiguous OT1+OT2 must stay one OT block).
  const mergeIntoBlocks = (entries: { start: Date; stop: Date; isShift?: boolean }[]): ScheduleBlock[] => {
    const blocks: ScheduleBlock[] = [];
    const blockHasShift: boolean[] = [];
    entries.forEach(({ start, stop, isShift }) => {
      const last = blocks[blocks.length - 1];
      const lastIdx = blocks.length - 1;
      const mergeable = last
        && start.getTime() - last.end.getTime() < gapMs
        && !(isShift && blockHasShift[lastIdx]);
      if (last && mergeable) {
        if (stop.getTime() > last.end.getTime()) last.end = stop;
        if (isShift) blockHasShift[lastIdx] = true;
      } else {
        blocks.push({ start, end: stop });
        blockHasShift.push(!!isShift);
      }
    });
    return blocks;
  };

  const OT_CODES = new Set(['OT1', 'OT2']);
  const duty1Entries = sortedAdditions.filter(x => !OT_CODES.has(x.s.SEG_CODE)).map(x => ({ start: x.start as Date, stop: x.stop as Date, isShift: x.s.SEG_CODE === 'SHIFT' }));
  const duty2Entries = sortedAdditions.filter(x => OT_CODES.has(x.s.SEG_CODE)).map(x => ({ start: x.start as Date, stop: x.stop as Date }));
  const nonOtBlocks = mergeIntoBlocks(duty1Entries);
  const otBlocks = mergeIntoBlocks(duty2Entries);

  // Defect fix (A2): duty2Block was only ever built from OT1/OT2 — a genuine second
  // SHIFT segment (the domain rule: "when a staff member has two shifts, the second
  // is in DUTY-2", Cognos's own equivalent of an ASPECT second SHIFT segment) fell
  // into duty1Entries above and was swallowed by the A4 collapse. Only the three
  // shapes the domain notes actually confirm are resolved automatically:
  //   - 1 non-OT block, <=1 OT block: the normal case (OT starts the instant the
  //     shift ends, a 0-minute gap, so OT1+OT2 almost always merge into exactly one
  //     otBlocks entry) — duty1Block = the shift, duty2Block = the OT.
  //   - 2 non-OT blocks, 0 OT blocks: a genuine second shift with a real gap >=
  //     perBlockGapThresholdMinutes — duty1Block = earlier, duty2Block = later,
  //     matching Cognos's own DUTY-2 semantics.
  //   - 0 non-OT blocks, 1 OT block: a standalone-OT day (public-holiday OT2 with
  //     no base SHIFT, the real PF 4507957 shape) — duty1Block stays null (there is
  //     no base shift to report), duty2Block = the OT. Without this branch,
  //     duty1Block AND duty2Block were both null on exactly the day the D10 SCH
  //     DURATION fallback (cognosComparison.ts) exists to handle — "add duty2 back
  //     in when duty1 is empty" was dead code, producing a false SCH
  //     DURATION/DUTY-2 MISMATCH on every standalone-OT row. Comparison-only, as
  //     documented below — no pay figure reads duty1Block/duty2Block.
  // Any other shape (3+ non-OT blocks; a real second shift AND real OT the same day;
  // OT itself splitting into more than one block) is unmodeled — exactly the domain
  // notes' "genuinely gapped split shifts... untested" caveat. duty2Block is left
  // null rather than guessing which block wins the one slot: never fabricate a
  // comparison value. Each of the three resolved shapes above is fully determined —
  // there is nothing to guess between — so adding the third shape is a deliberate,
  // bounded widening of exactly that one case, not a loosening of the "never guess"
  // rule; every other unmodeled shape (nonOtBlocks.length > 1, or otBlocks.length > 1)
  // still falls through to scheduleShapeUnresolved unchanged.
  let duty1Block: ScheduleBlock | null = nonOtBlocks[0] || null;
  let duty2Block: ScheduleBlock | null = null;
  let scheduleShapeUnresolved = false;
  if (nonOtBlocks.length === 1 && otBlocks.length <= 1) {
    duty2Block = otBlocks[0] || null;
  } else if (nonOtBlocks.length === 2 && otBlocks.length === 0) {
    duty2Block = nonOtBlocks[1];
  } else if (nonOtBlocks.length === 0 && otBlocks.length === 1) {
    duty2Block = otBlocks[0];
  } else if (nonOtBlocks.length > 1 || otBlocks.length > 1) {
    scheduleShapeUnresolved = true;
  }

  // Sum from the already-deduped `additionSegments` (see the F11 dedup above),
  // never the raw ot1Segments/ot2Segments filters from the top of this function —
  // those still contain a byte-identical duplicate OT row that additionSegments
  // (and therefore netScheduledMinutes) already excludes. Reducing over the raw
  // arrays double-counted an identical duplicate OT1/OT2 row into TAA_OT1/TAA_OT2
  // even though netScheduledMinutes itself was already correct.
  const ot1Minutes = additionSegments.filter(s => s.SEG_CODE === 'OT1').reduce((acc, s) => acc + segmentDurationMinutes(s, glossary, defaultFullDayMinutes), 0);
  const ot2Minutes = additionSegments.filter(s => s.SEG_CODE === 'OT2').reduce((acc, s) => acc + segmentDurationMinutes(s, glossary, defaultFullDayMinutes), 0);

  // ot1Block/ot2Block: the single contiguous window for OT1 (resp. OT2), display-only
  // (never drives ot1Minutes/ot2Minutes/TAA_OT1/TAA_OT2/pay — those stay the sum above).
  // Built the same way as nonOtBlocks/otBlocks (dedup via additionSegments, same
  // perBlockGapThresholdMinutes merge) so "one segment" and "one block" agree. Left
  // null — never a guessed combined range — when a day carries 2+ non-contiguous
  // OT1 (resp. OT2) windows.
  const singleOtBlock = (code: 'OT1' | 'OT2'): ScheduleBlock | null => {
    const entries = additionSegments
      .filter(s => s.SEG_CODE === code)
      .map(s => ({
        start: s.START_MOMENT ? truncToMinuteOrNull(parseDateTimeString(s.START_MOMENT)) : null,
        stop: s.STOP_MOMENT ? truncToMinuteOrNull(parseDateTimeString(s.STOP_MOMENT)) : null,
      }))
      .filter((x): x is { start: Date; stop: Date } => !!x.start && !!x.stop)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const blocks = mergeIntoBlocks(entries);
    return blocks.length === 1 ? blocks[0] : null;
  };
  const ot1Block = singleOtBlock('OT1');
  const ot2Block = singleOtBlock('OT2');

  // Full-day gate (§4.6b): driven by ConfigRegistry.nonWorkingDaySegmentCodes, not the
  // deprecated per-glossary-entry isLeaveGateExclusion flag — see isCodeInConfiguredSet.
  // This is a superset of the day's identified LEAVE codes (also includes OFF, which is
  // not leave but must still stop the day being judged for attendance).
  const nonWorkingSegments = segments.filter(s => isCodeInConfiguredSet(s.SEG_CODE, config.nonWorkingDaySegmentCodes || []));
  const isLeaveDay = nonWorkingSegments.length > 0 && additionSegments.length === 0;

  // R5 fix (part 2): report the SAME unioned totals netScheduledMinutes actually
  // subtracted above, not the raw per-segment sum. Two overlapping leading/trailing
  // removals used to report their minutes added together (e.g. RLS 60m + UN_RLS 60m
  // fully overlapping = "120m" reported) even though only 60 minutes were ever removed
  // from netScheduledMinutes — a reviewer reconciling `net = raw − release` by hand got
  // the wrong answer on exactly the rows the union fix was for. When a group has no
  // timestamped removals at all (the legacy duration-only fallback), the union of zero
  // intervals is 0, so this collapses to the same duration-only sum as before —
  // behavior is unchanged for every non-overlapping / no-timestamp case.
  const leadingReleaseMinutesReported = unionedIntervalMinutes(leadingRemovalIntervals) + leadingRemovalMinutesWithoutInterval;
  const trailingUnionedTotal = unionedIntervalMinutes(trailingRemovalIntervals) + trailingRemovalMinutesWithoutInterval;
  // nursingMinutes keeps its own raw sum (real data carries at most one NURSNG segment
  // per day per the KB) and trailingReleaseMinutes is the remainder of the unioned
  // trailing total after it — clamped at 0 for the rare case a NURSNG segment is fully
  // subsumed by another trailing removal's interval.
  const trailingReleaseMinutesReported = Math.max(0, trailingUnionedTotal - nursingMinutes);

  return {
    rawStart,
    rawEnd,
    effectiveStart,
    effectiveEnd,
    netScheduledMinutes,
    leadingReleaseMinutes: leadingReleaseMinutesReported,
    trailingReleaseMinutes: trailingReleaseMinutesReported,
    releaseMinutes: leadingReleaseMinutesReported + trailingReleaseMinutesReported + midRemovalMinutesReported + fullDayRemovalMinutesReported,
    fullDayRemovalMinutes: fullDayRemovalMinutesReported,
    otInternalRemovalMinutes: otInternalRemovalMinutesReported,
    nursingMinutes,
    ot1Minutes,
    ot2Minutes,
    ot1Block,
    ot2Block,
    duty1Block,
    duty2Block,
    nonOtBlocks,
    otBlocks,
    scheduleShapeUnresolved,
    isLeaveDay,
    nonWorkingSegments,
    unclassifiedCodes,
    outOfWindowRemovalSegments,
    midShiftRemovalSegments,
    otInternalRemovalSegments,
    unknownDurationRemovalSegments,
    durationDisagreementSegments,
    invalidDateTimeSegments,
    ambiguousOverlappingRemovalSegments,
    ambiguousOverlappingAdditionSegments,
    negativeNetScheduleMinutes,
    malformedDurationRepairedSegments,
    removalTrace,
    shiftSegments,
    ot1Segments,
    ot2Segments,
    coverSegments,
    additionSegments,
    removalSegments,
    fullDayAdditionSegments,
    fullDayRemovalSegments,
  };
}
