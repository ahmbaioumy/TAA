import { AspectSegment, AspectIdentity, CognosRecord, CMSPunch, CognosDropRule } from '../types/taa';

/**
 * RFC-4180 Quote-aware CSV / TSV parser state machine
 * Handles commas or tabs inside quotes, escaped quotes (""), and multiline entries.
 */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  // If delimiter not provided, auto-detect comma vs tab
  if (!delimiter) {
    const firstLine = text.split('\n')[0] || '';
    delimiter = firstLine.includes('\t') ? '\t' : ',';
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Push trailing field/row if present
  if (currentField.length > 0 || inQuotes) {
    currentRow.push(currentField);
  }
  if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === '')) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Decode ArrayBuffer as UTF-16 LE (with or without BOM) or fallback to UTF-8
 */
export function decodeFileBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  // Check UTF-16 LE BOM (0xFF, 0xFE)
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    const decoder = new TextDecoder('utf-16le');
    return decoder.decode(buffer);
  }

  // Check UTF-16 BE BOM (0xFE, 0xFF)
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const decoder = new TextDecoder('utf-16be');
    return decoder.decode(buffer);
  }

  // Defect fix: previously relied on the BOM alone — a BOM-less UTF-16 export
  // silently decoded as UTF-8 mojibake (every field becomes garbage keys,
  // not an error). Heuristic fallback: sample the first ~512 bytes; genuine
  // UTF-16 ASCII-range text has ~half its bytes as 0x00, consistently at
  // either all-even or all-odd offsets. Plain UTF-8 essentially never does.
  const sampleLen = Math.min(bytes.length, 512) & ~1; // even length
  if (sampleLen >= 32) {
    let zerosAtEven = 0;
    let zerosAtOdd = 0;
    for (let i = 0; i < sampleLen; i++) {
      if (bytes[i] === 0x00) {
        if (i % 2 === 0) zerosAtEven++; else zerosAtOdd++;
      }
    }
    const halfSample = sampleLen / 2;
    if (zerosAtOdd / halfSample > 0.35 && zerosAtEven / halfSample < 0.05) {
      return new TextDecoder('utf-16le').decode(buffer);
    }
    if (zerosAtEven / halfSample > 0.35 && zerosAtOdd / halfSample < 0.05) {
      return new TextDecoder('utf-16be').decode(buffer);
    }
  }

  // Fallback to UTF-8
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
    return utf8Decoder.decode(buffer);
  } catch (e) {
    const latinDecoder = new TextDecoder('iso-8859-1');
    return latinDecoder.decode(buffer);
  }
}

/**
 * Extract just the raw header row from a delimited file, for the
 * column-mapping UI — auto-detects comma vs tab like parseDelimitedText.
 */
export function extractHeaders(content: string): string[] {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length === 0) return [];
  return rawRows[0].map(h => h.trim()).filter(h => h.length > 0);
}

function wildcardToRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}

/**
 * Applies §6.6 per-column wildcard drop rules to an already-parsed Cognos
 * record set. Shared by parseCognosReport (upload/remap) and any caller that
 * needs to re-filter records already held in memory without re-parsing raw
 * file text (e.g. the bundled sample dataset, which has no raw text to
 * re-parse). See parseCognosReport's doc comment for full rule semantics.
 */
export function applyCognosDropRules(records: CognosRecord[], dropPatterns: CognosDropRule[] = []): CognosRecord[] {
  const dropRules = dropPatterns
    .filter(rule => rule && rule.column && Array.isArray(rule.values) && rule.values.length > 0)
    .map(rule => ({
      column: rule.column.trim(),
      regexes: rule.values.map(v => v.trim()).filter(v => v.length > 0).map(wildcardToRegex),
    }));

  if (dropRules.length === 0) return records;

  return records.filter(record => {
    const isDropped = dropRules.some(rule => {
      const value = String((record as any)[rule.column] || '');
      return rule.regexes.some(re => re.test(value));
    });
    return !isDropped;
  });
}

/**
 * Parse Cognos Discrepancy Report (UTF-16 LE Tab-delimited or CSV)
 * Preserves verbatim 18 column names including typos (e.g. SIGIN IN / SIGIN OUT)
 *
 * @param dropPatterns Optional, user-editable, default-empty per-column wildcard
 * rules (e.g. { column: "PF NO", values: ["UAE*"] }, { column: "SECTION",
 * values: ["ACCESS CARD*"] }) matched case-insensitively against that raw
 * Cognos column. A row is dropped if ANY rule's column value matches ANY of
 * that rule's wildcard values (OR within a rule, OR across rules) — the same
 * semantics as the legacy per-column AutoFilter+delete. Config-driven and OFF
 * by default — the tool never silently drops rows unless the user has
 * explicitly configured a rule (§6.6 non-negotiable).
 * @param columnMapping Optional user-supplied {canonicalField: actualRawHeader}
 * overrides from the Column Mapping UI, for files whose headers have drifted
 * from the documented names. The original raw-header keys are always kept on
 * the record too (needed for the byte-preserving annotated Cognos output) —
 * mapped canonical keys are added alongside, not instead of, the raw ones.
 */
export function parseCognosReport(content: string, dropPatterns: CognosDropRule[] = [], columnMapping?: Record<string, string>): CognosRecord[] {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length < 2) return [];

  const headers = rawRows[0].map(h => h.trim());
  const records: CognosRecord[] = [];

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length === 0 || (row.length === 1 && !row[0].trim())) continue;

    const record: any = {};
    headers.forEach((h, idx) => {
      record[h] = row[idx] !== undefined ? row[idx].trim() : '';
    });

    // Apply column-mapping overrides: alias each canonical field to whatever
    // raw header the user pointed it at, without discarding the original
    // raw-header keys (still needed for the byte-preserving annotated output).
    if (columnMapping) {
      Object.entries(columnMapping).forEach(([canonicalKey, rawHeader]) => {
        if (rawHeader && record[rawHeader] !== undefined) {
          record[canonicalKey] = record[rawHeader];
        }
      });
    }

    // Clean PF NO
    if (record['PF NO']) {
      record['PF NO'] = record['PF NO'].trim();
    }
    // Clean LOGIN ID
    if (record['LOGIN ID']) {
      record['LOGIN ID'] = record['LOGIN ID'].trim();
    }

    records.push(record as CognosRecord);
  }

  return applyCognosDropRules(records, dropPatterns);
}

/**
 * Parse ASPECT Schedule Segments CSV
 * Handles space-padded EMP_ID, bare dates in START/STOP moments, multiline MEMOs
 *
 * @param columnMapping Optional {canonicalField: actualRawHeader} overrides
 * from the Column Mapping UI, for a file whose headers have drifted from the
 * documented names.
 */
export function parseAspectSegments(content: string, columnMapping?: Record<string, string>): AspectSegment[] {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length < 2) return [];

  const headers = rawRows[0].map(h => h.trim());
  const segments: AspectSegment[] = [];

  // Map header positions — a user-supplied mapping takes priority over the
  // canonical name, so a renamed/reordered header can still be located.
  const getCol = (row: string[], name: string): string => {
    const mappedHeader = columnMapping?.[name];
    const idx = mappedHeader ? headers.indexOf(mappedHeader) : headers.indexOf(name);
    return idx !== -1 && row[idx] !== undefined ? row[idx].trim() : '';
  };

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length === 0 || (row.length === 1 && !row[0].trim())) continue;

    const empId = getCol(row, 'EMP_ID').trim();
    const nomDate = getCol(row, 'NOM_DATE');
    const segCode = getCol(row, 'SEG_CODE').toUpperCase();

    if (!empId || !segCode) continue;

    let startMoment = getCol(row, 'START_MOMENT');
    let stopMoment = getCol(row, 'STOP_MOMENT');

    // Bare date handling: 28/08/2026 -> 28/08/2026 00:00:00
    if (startMoment && !startMoment.includes(':')) {
      startMoment = `${startMoment} 00:00:00`;
    }
    if (stopMoment && !stopMoment.includes(':')) {
      stopMoment = `${stopMoment} 00:00:00`;
    }

    // F13 fix: parseInt silently truncates instead of rejecting — "480.9" and
    // "480garbage" both used to parse cleanly to 480 (a malformed value
    // becoming an indistinguishable, correct-looking payroll minute count,
    // with no hold and no way for a reviewer to ever notice), while
    // "not-a-number" fell through the isNaN check below to `undefined`
    // (treated as merely missing, not as invalid data entirely). DURATION is
    // strictly a non-negative whole number of minutes in every real ASPECT
    // export; anything else is rejected to undefined here rather than
    // silently coerced — the same downstream fallback that already handles a
    // genuinely missing DURATION (derive from timestamps, or hold if there
    // are none) now also handles a malformed one, instead of trusting it.
    const durationStr = getCol(row, 'DURATION').trim();
    const duration = durationStr && /^\d+$/.test(durationStr) ? parseInt(durationStr, 10) : undefined;
    // Distinct from a genuinely blank cell — this DURATION was rejected above
    // (F13 fix), not simply absent. See DURATION_TEXT_MALFORMED's type comment.
    const durationTextMalformed = durationStr.length > 0 && duration === undefined;
    const rankStr = getCol(row, 'RANK');
    const rank = rankStr ? parseInt(rankStr, 10) : undefined;

    segments.push({
      PRI_INDEX: parseInt(getCol(row, 'PRI_INDEX') || '0', 10),
      EMP_SK: getCol(row, 'EMP_SK'),
      EMP_ID: empId,
      EMP_LAST_NAME: getCol(row, 'EMP_LAST_NAME'),
      EMP_FIRST_NAME: getCol(row, 'EMP_FIRST_NAME'),
      EMP_SORT_NAME: getCol(row, 'EMP_SORT_NAME'),
      EMP_SHORT_NAME: getCol(row, 'EMP_SHORT_NAME'),
      EMP_SENIORITY: getCol(row, 'EMP_SENIORITY'),
      EMP_EFF_HIRE_DATE: getCol(row, 'EMP_EFF_HIRE_DATE'),
      NOM_DATE: nomDate,
      START_DATE: getCol(row, 'START_DATE') || nomDate,
      SEG_CODE: segCode,
      START_MOMENT: startMoment,
      STOP_MOMENT: stopMoment,
      DURATION: duration,
      DURATION_TEXT_MALFORMED: durationTextMalformed,
      // Phase 4: MEMO deliberately not retained (never read by reconciliation
      // logic — see AspectSegment's MEMO removal below) — large pasted-email
      // blobs in real exports (verified: 924 rows in a 10.3MB file) otherwise
      // stay in memory for the whole session for no purpose. The multi-line
      // quoted-field CSV parsing that produces `row` here is untouched; only
      // this field's value is discarded.
      RANK: isNaN(rank as number) ? undefined : rank,
      EMP_CLASS_1: getCol(row, 'EMP_CLASS_1'),
      EMP_CLASS_1_DESCR: getCol(row, 'EMP_CLASS_1_DESCR'),
    });
  }

  return segments;
}

/**
 * Parse ASPECT ExtraFiled (Identity Master)
 * Trims EMP_ID, extracts EMP_EXTRA_2, EMP_EMAIL_ADR, role tiers
 *
 * @param columnMapping Optional {canonicalField: actualRawHeader} overrides
 * from the Column Mapping UI.
 */
export function parseAspectIdentity(content: string, columnMapping?: Record<string, string>): AspectIdentity[] {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length < 2) return [];

  const headers = rawRows[0].map(h => h.trim());
  const identities: AspectIdentity[] = [];

  const getCol = (row: string[], name: string): string => {
    const mappedHeader = columnMapping?.[name];
    const idx = mappedHeader ? headers.indexOf(mappedHeader) : headers.indexOf(name);
    return idx !== -1 && row[idx] !== undefined ? row[idx].trim() : '';
  };

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length === 0 || (row.length === 1 && !row[0].trim())) continue;

    const empId = getCol(row, 'EMP_ID').trim();
    if (!empId) continue;

    identities.push({
      PRI_INDEX: parseInt(getCol(row, 'PRI_INDEX') || '0', 10),
      EMP_SK: getCol(row, 'EMP_SK'),
      EMP_ID: empId,
      EMP_LAST_NAME: getCol(row, 'EMP_LAST_NAME'),
      EMP_FIRST_NAME: getCol(row, 'EMP_FIRST_NAME'),
      EMP_SORT_NAME: getCol(row, 'EMP_SORT_NAME'),
      EMP_SHORT_NAME: getCol(row, 'EMP_SHORT_NAME'),
      EMP_SENIORITY: getCol(row, 'EMP_SENIORITY'),
      EMP_EFF_HIRE_DATE: getCol(row, 'EMP_EFF_HIRE_DATE'),
      EMP_TERM_DATE: getCol(row, 'EMP_TERM_DATE'),
      // Defect fix: previously defaulted a missing/header-drifted column to
      // 'T' (Active) — fail-open, so a renamed column would silently
      // reactivate terminated staff. Leave it empty when absent; isTerminated
      // still correctly falls back to EMP_TERM_DATE (see resolveOutlookRecipient).
      EMP_ACTIVE_FLAG: getCol(row, 'EMP_ACTIVE_FLAG'),
      EMP_TIME_ZONE: getCol(row, 'EMP_TIME_ZONE'),
      EMP_EMAIL_ADR: getCol(row, 'EMP_EMAIL_ADR'),
      EMP_MEMO: getCol(row, 'EMP_MEMO'),
      EMP_EXTRA_1: getCol(row, 'EMP_EXTRA_1'),
      EMP_EXTRA_2: getCol(row, 'EMP_EXTRA_2'),
      EMP_EXTRA_3: getCol(row, 'EMP_EXTRA_3'),
      EMP_EXTRA_4: getCol(row, 'EMP_EXTRA_4'),
      START_DATE: getCol(row, 'START_DATE'),
    });
  }

  return identities;
}

/**
 * Look for the CMS header row (usually row index 2, with "Date" in first
 * cell); defaults to row index 3 if no such row is found in the first 10.
 */
function findCmsHeaderRowIndex(rawRows: string[][]): number {
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    if (rawRows[i][0] && rawRows[i][0].toLowerCase().includes('date')) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse CMS Login/Logout Punches
 * Positional parsing:
 * Col 1: Date (DD/MM/YYYY)
 * Col 2: Login ID
 * Col 3: Login Time (time only)
 * Col 4: Logout Time (time only)
 * Col 5: Login Time (Full Datetime DD/MM/YYYY HH:MM:SS)
 * Col 6: Logout Time (Full Datetime DD/MM/YYYY HH:MM:SS)
 */
/** F4 fix: distinguishes "no logout recorded yet because the employee is still
 * clocked in at report-generation time" (literal "0", or blank) from a
 * genuinely malformed Logout Time value. NEVER matches "00:00", which is a
 * legitimate cross-midnight logout (disambiguated by the Logout Time (Full)
 * datetime column landing on the next calendar day) — collapsing that into
 * "still clocked in" would corrupt every real cross-midnight record. */
function isOpenLogoutSentinel(raw: string): boolean {
  const v = (raw || '').trim();
  return v === '' || v === '0';
}

/** One CMS row's login + logout state, resolved ONCE and shared by validateCmsFile and
 * parseCmsPunches so the two can never disagree (2026-09-27). Each timestamp is resolved on its
 * own: the full datetime column when it holds a value, else Date + the time-only column — so a
 * blank optional field never discards the other field's seconds (a blank Logout Time (Full) used
 * to make the parser drop BOTH full timestamps and re-read the login as HH:MM:00). Logout state:
 * - both logout fields blank/"0" -> OPEN (still clocked in; the F4 sentinel);
 * - one field "0" while the other holds a logout -> CONTRADICTORY (never guessed either way);
 * - otherwise CLOSED: the populated full datetime, else Date + time (moved to the next day when it
 *   would fall before the login — a cross-midnight shift; "00:00" is a time, never a sentinel). */
type CmsRowState =
  | { kind: 'OK'; login: Date; logout: Date | null }
  | { kind: 'CONTRADICTORY'; reason: string }
  | { kind: 'UNPARSEABLE' };
function resolveCmsRow(row: string[]): CmsRowState {
  const dateStr = (row[0] || '').trim();
  const loginFull = (row[4] || '').trim();
  const loginClock = (row[2] || '').trim();
  const login = loginFull ? parseDateTimeString(loginFull) : (loginClock ? parseDateTimeString(`${dateStr} ${loginClock}`) : null);
  if (!login) return { kind: 'UNPARSEABLE' };
  const logoutClock = (row[3] || '').trim();
  const logoutFull = (row[5] || '').trim();
  const clockOpen = isOpenLogoutSentinel(logoutClock);
  const fullOpen = isOpenLogoutSentinel(logoutFull);
  if (clockOpen && fullOpen) return { kind: 'OK', login, logout: null };
  if ((logoutClock === '0' && !fullOpen) || (logoutFull === '0' && !clockOpen)) {
    return { kind: 'CONTRADICTORY', reason: `logout is "0" (still clocked in) in one column but "${logoutClock === '0' ? logoutFull : logoutClock}" in the other` };
  }
  if (!fullOpen) {
    const logout = parseDateTimeString(logoutFull);
    return logout ? { kind: 'OK', login, logout } : { kind: 'UNPARSEABLE' };
  }
  const sameDay = parseDateTimeString(`${dateStr} ${logoutClock}`);
  if (!sameDay) return { kind: 'UNPARSEABLE' };
  const logout = sameDay.getTime() < login.getTime() ? new Date(sameDay.getTime() + 86400000) : sameDay;
  return { kind: 'OK', login, logout };
}

export function parseCmsPunches(content: string): CMSPunch[] {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length < 4) return [];

  const headerIndex = findCmsHeaderRowIndex(rawRows);
  const startRow = headerIndex !== -1 ? headerIndex + 1 : 3;
  const punches: CMSPunch[] = [];

  for (let i = startRow; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length < 2 || !row[0].trim()) continue;

    const dateStr = row[0].trim();
    const loginId = row[1].trim();
    const state = resolveCmsRow(row);
    // CONTRADICTORY / UNPARSEABLE rows produce no punch; validateCmsFile rejects the file with
    // the specific reason (and its row-count check backstops any other path).
    if (!loginId || state.kind !== 'OK') continue;
    const stillClockedIn = state.logout === null;
    punches.push({
      Date: dateStr,
      LoginID: loginId,
      LoginTimeStr: row[2] ? row[2].trim() : formatTimeHHMM(state.login),
      LogoutTimeStr: row[3] ? row[3].trim() : (state.logout ? formatTimeHHMM(state.logout) : ''),
      LoginDateTime: state.login,
      LogoutDateTime: state.logout,
      stillClockedIn: stillClockedIn || undefined,
    });
  }

  return punches;
}

/** Fixed, positional CMS export schema — column names/order and per-column data type. */
const CMS_EXPECTED_HEADER = ['date', 'login id', 'login time', 'logout time', 'login time', 'logout time'];
const CMS_COL_TYPES: Array<'date' | 'id' | 'time' | 'datetime'> =
  ['date', 'id', 'time', 'time', 'datetime', 'datetime'];

function cmsColLabel(colIndex: number): string {
  return ['Date', 'Login ID', 'Login Time', 'Logout Time', 'Login Time (Full)', 'Logout Time (Full)'][colIndex] || `Column ${colIndex + 1}`;
}

export type CmsFileValidation =
  | { ok: true; punches: CMSPunch[] }
  | { ok: false; reason: string };

export interface CmsColumnStatus {
  position: number;
  expectedLabel: string;
  actualHeader: string | null;
  ok: boolean;
}

/**
 * Per-position header status for an uploaded CMS file, for the Field Reference
 * page's read-only CMS tab.
 *
 * CMS is matched by fixed POSITION, not by name (the real export's header row
 * repeats "Login Time"/"Logout Time" for two different columns), so there is no
 * remap UI for it — but the user still needs to see *which* position is wrong
 * when a layout changes. Built on the same CMS_EXPECTED_HEADER /
 * findCmsHeaderRowIndex the validator uses, so the page can never report a
 * layout the validator would reject, or vice versa.
 *
 * Returns null when no header row can be located at all (the file is not a CMS
 * export, or is empty) — the caller shows the "not uploaded / unreadable" state
 * rather than painting every position as a failure.
 */
export function describeCmsHeaderStatus(content: string): CmsColumnStatus[] | null {
  const rawRows = parseDelimitedText(content);
  if (rawRows.length === 0) return null;
  const headerIndex = findCmsHeaderRowIndex(rawRows);
  if (headerIndex === -1) return null;
  const header = rawRows[headerIndex].map(c => c.trim());
  return CMS_EXPECTED_HEADER.map((expected, position) => {
    const actual = header[position] ?? null;
    return {
      position,
      expectedLabel: cmsColLabel(position),
      actualHeader: actual,
      ok: actual !== null && actual.toLowerCase() === expected,
    };
  });
}

/**
 * Validate one uploaded CMS file against the fixed, predefined CMS export
 * schema (column names, column order, and per-column data type) before it is
 * allowed to contribute punches to a merge. Used to reject a multi-file
 * upload as a whole if any single file doesn't match — see UploadZone.
 */
export function validateCmsFile(content: string, fileName: string): CmsFileValidation {
  const nonBlankLineCount = content.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0).length;
  const rawRows = parseDelimitedText(content);
  if (nonBlankLineCount === 0 || rawRows.length < 4) {
    return { ok: false, reason: `"${fileName}" is empty or has no data rows.` };
  }

  // Phase 6: CMS has no Map/remap button by design (its real header row
  // repeats "Login Time"/"Logout Time" for two different columns, making a
  // name-based remap ambiguous — see the comment in UploadZone.tsx). A layout
  // mismatch can only be fixed by re-exporting the file in the fixed column
  // order below, so every rejection reason here says so explicitly.
  const cmsRemapNote = 'CMS export columns are matched by fixed POSITION, not by name, and cannot be remapped in this app — re-export with columns in exactly this order: Date, Login ID, Login Time, Logout Time, Login Time (Full Datetime), Logout Time (Full Datetime).';
  const headerIndex = findCmsHeaderRowIndex(rawRows);
  if (headerIndex === -1) {
    return { ok: false, reason: `"${fileName}" has no recognizable header row (expected a "Date" column). ${cmsRemapNote}` };
  }

  const header = rawRows[headerIndex].map(c => c.trim().toLowerCase());
  if (header.length !== CMS_EXPECTED_HEADER.length) {
    return { ok: false, reason: `"${fileName}" has ${header.length} columns, expected ${CMS_EXPECTED_HEADER.length}. ${cmsRemapNote}` };
  }
  for (let c = 0; c < CMS_EXPECTED_HEADER.length; c++) {
    if (header[c] !== CMS_EXPECTED_HEADER[c]) {
      return {
        ok: false,
        reason: `"${fileName}" column ${c + 1} is "${rawRows[headerIndex][c]?.trim() || ''}", expected "${cmsColLabel(c)}". ${cmsRemapNote}`,
      };
    }
  }

  let dataRowCount = 0;
  for (let r = headerIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (row.length < 2 || !row[0].trim()) continue; // blank trailing row, skip
    dataRowCount++;

    // F4 fix: a literal "0" (or blank) Logout Time / Logout Time (Full) means
    // the employee was still clocked in when the export was generated — a
    // real, expected state, not a malformed row. Both logout columns are
    // excused from the normal per-column validation below for this row; every
    // other column (Date, Login ID, Login Time, Login Time (Full)) stays
    // exactly as strict as before, so a genuinely malformed file is still
    // rejected. Never matches "00:00" — see isOpenLogoutSentinel.
    // Shared with parseCmsPunches (resolveCmsRow): open only when BOTH logout fields are blank/"0";
    // a "0" beside a populated logout is contradictory evidence and rejects the file.
    const rowState = resolveCmsRow(row);
    if (rowState.kind === 'CONTRADICTORY') {
      return { ok: false, reason: `"${fileName}" row ${r + 1}: ${rowState.reason} — contradictory CMS logout, re-export the file.` };
    }
    const stillClockedIn = rowState.kind === 'OK' && rowState.logout === null;

    for (let c = 0; c < CMS_COL_TYPES.length; c++) {
      // A logout column holding the open sentinel is excused from type validation (F4); on a
      // CLOSED row the time-only Logout Time may be blank when Logout Time (Full) carries it.
      if ((c === 3 || c === 5) && isOpenLogoutSentinel(row[c] || '')) continue;
      const raw = row[c];
      const value = raw ? raw.trim() : '';
      const type = CMS_COL_TYPES[c];
      // The two full-datetime columns may be blank when the parser can
      // reconstruct login/logout from Date + the time-only columns instead.
      if (!value) {
        if (type === 'datetime') continue;
        return { ok: false, reason: `"${fileName}" row ${r + 1}: "${cmsColLabel(c)}" is missing a value.` };
      }
      const valid =
        type === 'date' ? /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value) && parseDateTimeString(value) !== null :
        type === 'id' ? value.length > 0 :
        type === 'time' ? parseClockTimeString(value) !== null :
        /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(:\d{2})?$/.test(value) && parseDateTimeString(value) !== null;
      if (!valid) {
        return { ok: false, reason: `"${fileName}" row ${r + 1}: "${cmsColLabel(c)}" value "${value}" is not a valid ${type === 'date' ? 'date (DD/MM/YYYY)' : type === 'time' ? 'time (HH:MM)' : type === 'datetime' ? 'datetime (DD/MM/YYYY HH:MM:SS)' : type}.` };
      }
    }

    const dateText = row[0].trim();
    const loginClock = row[2].trim();
    const rowDate = parseDateTimeString(dateText)!;
    const loginClockParsed = parseClockTimeString(loginClock)!;
    const canonicalLoginClock = `${String(loginClockParsed.hours).padStart(2, '0')}:${String(loginClockParsed.minutes).padStart(2, '0')}`;
    const loginFull = row[4]?.trim() ? parseDateTimeString(row[4].trim()) : parseDateTimeString(`${dateText} ${loginClock}`);
    if (!loginFull) {
      return { ok: false, reason: `"${fileName}" row ${r + 1}: login timestamp could not be resolved without guessing.` };
    }
    if (row[4]?.trim() && (formatDateDDMMYYYY(loginFull) !== formatDateDDMMYYYY(rowDate) || formatTimeHHMM(loginFull) !== canonicalLoginClock)) {
      return { ok: false, reason: `"${fileName}" row ${r + 1}: Login Time conflicts with Login Time (Full).` };
    }

    if (!stillClockedIn) {
      if (rowState.kind !== 'OK' || !rowState.logout) {
        return { ok: false, reason: `"${fileName}" row ${r + 1}: logout timestamp could not be resolved without guessing.` };
      }
      const logoutClock = (row[3] || '').trim();
      const nextDate = new Date(rowDate.getFullYear(), rowDate.getMonth(), rowDate.getDate() + 1);
      const logoutFull = rowState.logout;
      const logoutDateMatchesRow = formatDateDDMMYYYY(logoutFull) === formatDateDDMMYYYY(rowDate);
      const logoutDateIsNextDay = formatDateDDMMYYYY(logoutFull) === formatDateDDMMYYYY(nextDate);
      if (!logoutDateMatchesRow && !logoutDateIsNextDay) {
        return { ok: false, reason: `"${fileName}" row ${r + 1}: Logout Time (Full) is not on the row's date or the next day.` };
      }
      // Both logout fields populated -> they must name the same minute.
      if (logoutClock && row[5]?.trim()) {
        const logoutClockParsed = parseClockTimeString(logoutClock)!;
        const canonicalLogoutClock = `${String(logoutClockParsed.hours).padStart(2, '0')}:${String(logoutClockParsed.minutes).padStart(2, '0')}`;
        if (formatTimeHHMM(logoutFull) !== canonicalLogoutClock) {
          return { ok: false, reason: `"${fileName}" row ${r + 1}: Logout Time conflicts with Logout Time (Full).` };
        }
      }
      if (logoutFull.getTime() < loginFull.getTime()) {
        return { ok: false, reason: `"${fileName}" row ${r + 1}: logout datetime is earlier than login datetime.` };
      }
    }
  }

  const punches = parseCmsPunches(content);
  if (punches.length !== dataRowCount) {
    return { ok: false, reason: `"${fileName}" contains ${dataRowCount} data row(s), but only ${punches.length} produced complete login/logout punches.` };
  }
  return { ok: true, punches };
}

/** Merge multiple CMS punch batches, dropping exact duplicates by login/logout identity. */
export function dedupeCmsPunches(punches: CMSPunch[]): CMSPunch[] {
  const seen = new Set<string>();
  const result: CMSPunch[] = [];
  for (const p of punches) {
    const key = `${p.LoginID}|${p.LoginDateTime.getTime()}|${p.LogoutDateTime ? p.LogoutDateTime.getTime() : 'OPEN'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

/**
 * Extract distinct segment codes present in uploaded ASPECT data
 */
export function extractDistinctSegmentCodes(segments: AspectSegment[]): string[] {
  const set = new Set<string>();
  segments.forEach(s => {
    if (s.SEG_CODE) {
      set.add(s.SEG_CODE.trim().toUpperCase());
    }
  });
  return Array.from(set).sort();
}

/**
 * Parse Datetime string in formats:
 * - DD/MM/YYYY HH:MM:SS
 * - DD/MM/YYYY HH:MM
 * - YYYY-MM-DD HH:MM:SS
 * - DD/MM/YYYY
 * - YYYY-MM-DD
 */
export function parseDateTimeString(str: string): Date | null {
  if (!str) return null;
  const trimmed = str.trim();

  const buildValidatedLocalDate = (
    year: number,
    monthOneBased: number,
    day: number,
    hours: number,
    minutes: number,
    seconds: number,
  ): Date | null => {
    if (year < 1000 || year > 9999 || monthOneBased < 1 || monthOneBased > 12 || day < 1 || day > 31) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null;
    const result = new Date(year, monthOneBased - 1, day, hours, minutes, seconds, 0);
    if (
      result.getFullYear() !== year ||
      result.getMonth() !== monthOneBased - 1 ||
      result.getDate() !== day ||
      result.getHours() !== hours ||
      result.getMinutes() !== minutes ||
      result.getSeconds() !== seconds
    ) return null;
    return result;
  };

  // Check YYYY-MM-DD HH:MM:SS
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    const hours = isoMatch[4] ? parseInt(isoMatch[4], 10) : 0;
    const mins = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
    const secs = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
    return buildValidatedLocalDate(year, month, day, hours, mins, secs);
  }

  // Check DD/MM/YYYY HH:MM:SS
  const ddmmyyyyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (ddmmyyyyMatch) {
    const day = parseInt(ddmmyyyyMatch[1], 10);
    const month = parseInt(ddmmyyyyMatch[2], 10);
    const year = parseInt(ddmmyyyyMatch[3], 10);
    const hours = ddmmyyyyMatch[4] ? parseInt(ddmmyyyyMatch[4], 10) : 0;
    const mins = ddmmyyyyMatch[5] ? parseInt(ddmmyyyyMatch[5], 10) : 0;
    const secs = ddmmyyyyMatch[6] ? parseInt(ddmmyyyyMatch[6], 10) : 0;
    return buildValidatedLocalDate(year, month, day, hours, mins, secs);
  }

  return null;
}

/**
 * Advisory-only check (never blocks an upload): warns when EVERY date in a sample is
 * consistent with BOTH DD/MM/YYYY (what parseDateTimeString always assumes) and MM/DD/YYYY
 * (a common alternate export locale). Ambiguity exists exactly when a date's DAY field (as
 * parsed under the DD/MM/YYYY assumption) is <=12 — swap day and month and the result is
 * STILL a structurally valid date, so a genuinely MM/DD/YYYY file parses with no error at
 * all, just silently wrong (every date's day and month transposed). The moment any date has
 * a day field >12, the file can only be DD/MM/YYYY (no swap would be valid), so this returns
 * false the instant real evidence rules the ambiguity out — a large/varied file needs only
 * one such date, e.g. the 13th of any month, to clear the warning.
 */
export function detectDateFormatAmbiguity(dateStrings: string[]): boolean {
  let sawAny = false;
  for (const raw of dateStrings) {
    const parsed = parseDateTimeString(raw);
    if (!parsed) continue;
    sawAny = true;
    if (parsed.getDate() > 12) return false;
  }
  return sawAny;
}

/** Parse a local wall-clock value. Hours are 00-23 and minutes are 00-59. */
export function parseClockTimeString(str: string): { hours: number; minutes: number } | null {
  if (!str) return null;
  const match = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

export function formatTimeHHMM(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function formatDateDDMMYYYY(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Canonical DD/MM/YYYY join key for a date string from EITHER side of the
 * Cognos/ASPECT join. Defect fix: the ASPECT side previously joined on the
 * raw NOM_DATE string (e.g. "1/9/2026", un-padded) while the Cognos side was
 * always normalized through parseDateTimeString -> formatDateDDMMYYYY (e.g.
 * "01/09/2026") — two representations of the same calendar day that never
 * string-equal each other. Route every join-key/lookup-key site through this
 * instead of comparing raw ASPECT date strings directly. Returns null (never
 * silently falls back to the raw string) when the value cannot be parsed, so
 * an unparseable date surfaces as a genuine gap rather than a silent miss.
 */
export function normalizeDateKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = parseDateTimeString(raw);
  return parsed ? formatDateDDMMYYYY(parsed) : null;
}

// Actual CMS login/logout moments (Min Login / Max Logout) must be treated as
// DD/MM/YYYY HH:MM only — seconds must never influence a late/early minute
// count. Truncate at the source so every downstream diffInMinutes/getTime()
// comparison sees a whole-minute value.
export function truncateToMinute(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0);
}

export function diffInMinutes(earlyDate: Date, laterDate: Date): number {
  // Defect fix: Math.round previously turned e.g. 5m31s into 6, crossing a
  // minute-threshold that PRD's worked examples say should not fire yet
  // (5 minutes late is explicitly "no action"). Floor whole elapsed minutes
  // instead, consistent with "charge the full MEASURED variance" (§4.10) —
  // measured means completed minutes, not rounded-up ones.
  return Math.floor((laterDate.getTime() - earlyDate.getTime()) / (1000 * 60));
}

export function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Monday that starts the ISO calendar week AFTER d's own week (Mon-Sun weeks).
 * Deliberately not a fixed "+7 minimum" — days-out varies by weekday, since this
 * is "next calendar week's Monday," not "at least a week from now":
 *   Mon +7, Tue +6, Wed +5, Thu +4, Fri +3, Sat +2, Sun +1.
 * The Sunday case landing only 1 day out is intentional (user-confirmed), not a bug.
 */
export function nextWeekMonday(d: Date): Date {
  const dow = d.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const mondayOfThisWeek = addDays(d, -daysSinceMonday);
  return startOfDay(addDays(mondayOfThisWeek, 7));
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60 * 1000);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * Format minutes into "HH:MM" (ASPECT correction-file duration format).
 */
export function formatMinutesToHHMM(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Parse "HH:MM" (optionally signed) into total minutes.
 */
export function parseHHMMToMinutes(hhmm: string): number {
  if (!hhmm) return 0;
  const match = hhmm.trim().match(/^(-)?(\d+):(\d{1,2})$/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const h = parseInt(match[2], 10);
  const m = parseInt(match[3], 10);
  if (m > 59) return 0;
  return sign * (h * 60 + m);
}

/**
 * Parse Cognos's own "SCH DURATION" format, H:M where minutes are NOT
 * zero-padded — "8:4" means 8h 04m = 484 minutes, not 8h 40m. Distinct from
 * parseHHMMToMinutes, which treats the field after the colon as already a
 * valid two-digit minute component.
 */
export function parseCognosHMinutes(hm: string): number | null {
  if (!hm) return null;
  const match = hm.trim().match(/^(-)?(\d+):(\d{1,2})$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const h = parseInt(match[2], 10);
  const m = parseInt(match[3], 10);
  if (m > 59) return null;
  return sign * (h * 60 + m);
}

/**
 * Snap time to rounding grid on LOCAL wall-clock minutes-since-midnight, not
 * absolute epoch — snapping on epoch only lines up with the wall clock when
 * the browser's UTC offset happens to be a multiple of the grid.
 */
export function snapTimeToGrid(date: Date, gridMinutes: number, direction: 'nearest' | 'up' | 'down'): Date {
  const minutesSinceMidnight = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  let snappedMinutes: number;

  if (direction === 'up') {
    snappedMinutes = Math.ceil(minutesSinceMidnight / gridMinutes) * gridMinutes;
  } else if (direction === 'down') {
    snappedMinutes = Math.floor(minutesSinceMidnight / gridMinutes) * gridMinutes;
  } else {
    snappedMinutes = Math.round(minutesSinceMidnight / gridMinutes) * gridMinutes;
  }

  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  result.setMinutes(snappedMinutes);
  return result;
}
