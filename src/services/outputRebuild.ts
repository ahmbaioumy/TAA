/**
 * Shared, non-engine export rebuilder — the single place any reviewer-facing state change
 * (manual include/exclude toggle, unseen-punch REASON hold) regenerates the four downstream
 * exports from. Never touches reconciliationEngine.ts / punchAttribution.ts /
 * scheduleRecompute.ts; only calls their exported functions, and — because
 * generateEmailActionsJson's own eligible-row-id computation
 * (reconciliationEngine.ts:2356-2360, `eligibleRowIdSet`) is not exported — replicates that one
 * line here so the "REASON row's email is held" rule can be applied without an engine edit.
 *
 * With an empty heldRowIds set, every string this produces is byte-identical to what the
 * engine's own generateAspectCorrectionsCsv/generateAnnotatedCognosFile/generateEmailActionsJson
 * would produce for the same rows (see regressionSuite.ts unseen-13).
 */
import { AspectCorrectionRow, ConfigRegistry, EmailActionItem, ReconciliationRow, VerificationOverrideAudit } from '../types/taa';
import {
  generateAspectCorrectionsCsv,
  generateAnnotatedCognosFile,
} from './reconciliationEngine';
import { computeEmailStatusByRowId, planEmailDraftActions } from './emailDrafts';
import { isForcedHoldReason } from './holdReasons';

export interface RebuiltOutputs {
  aspectCorrections: AspectCorrectionRow[];
  aspectCorrectionsCsv: string;
  emailActionsJson: string;
  annotatedCognosCsv: string;
  annotatedCognosTsv: string;
}

// Mirrors reconciliationEngine.ts:2356-2360 exactly (kept in sync by comment reference — the
// engine does not export this helper). Rows cleared for the reviewed outputs.
function eligibleRowIdSet(rows: ReconciliationRow[] | undefined): ReadonlySet<string> | null {
  return rows
    ? new Set(rows.filter(r => r.includeInOutput && !isForcedHoldReason(r.holdReason)).map(r => r.id))
    : null;
}

// Mirrors reconciliationEngine.ts's generateEmailActionsJson (:2362-2368) exactly, with one
// addition: a 4th param, the unseen-punch REASON-held row ids, threaded into
// computeEmailStatusByRowId's optional 5th argument. Omitting heldRowIds (or passing an empty
// set) reproduces the engine's own output byte-for-byte.
function rebuildEmailActionsJson(
  emailActions: EmailActionItem[],
  rows: ReconciliationRow[] | undefined,
  config: ConfigRegistry,
  heldRowIds: ReadonlySet<string>,
): string {
  const { eligible } = computeEmailStatusByRowId(
    emailActions, eligibleRowIdSet(rows), config.sectionMailboxMap, config.emailTemplates,
    heldRowIds.size > 0 ? heldRowIds : undefined,
  );
  const { finalActions } = planEmailDraftActions(eligible, config.sectionMailboxMap, config.emailTemplates);
  return JSON.stringify(finalActions, null, 2);
}

// Quote-aware, full-text, record-boundary-safe parser for the annotated Cognos CSV/TSV the
// engine writes. A naive text.split('\n') is UNSAFE here: the source Cognos REMARK column (and
// any other free-text field) can carry a genuinely embedded newline inside its own quoted cell
// (real data — see parsers.ts's "multiline REMARK" handling), and the engine's own escapeCell
// never strips or re-encodes that raw '\n' before wrapping the cell in quotes. Only a '\n'
// OUTSIDE an open quote is a real record boundary. Returns each record's field values (already
// unescaped: surrounding quotes stripped, doubled "" collapsed to ") plus its [start, end) byte
// span in the original text (end excludes the record-terminating '\n', mirroring how
// generateAnnotatedCognosFile itself builds `lines` before `lines.join('\n')` — no trailing
// newline on the last record).
interface DelimitedRecord { fields: string[]; start: number; end: number }
function parseDelimitedRecords(text: string, delimiter: string): DelimitedRecord[] {
  const records: DelimitedRecord[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let recordStart = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (c === delimiter) { fields.push(field); field = ''; i += 1; continue; }
    if (c === '\n') {
      fields.push(field);
      records.push({ fields, start: recordStart, end: i });
      field = ''; fields = []; i += 1; recordStart = i; continue;
    }
    field += c; i += 1;
  }
  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push({ fields, start: recordStart, end: n });
  }
  return records;
}

// Same rule as the engine's own escapeCell (reconciliationEngine.ts:3908-3913). Only ever
// invoked here to re-serialize a record whose TAA_EMAIL_STATUS field is being patched — the
// content-only decision (add a leading apostrophe / wrap in quotes) is deterministic, so
// reconstructing an UNCHANGED field through this always reproduces the original bytes exactly
// (verified by regressionSuite.ts's unseen-13 parity case and the real-data check in the design
// doc's verification step 3, where every non-held row's line is confirmed untouched).
function escapeCell(val: string, delimiter: string): string {
  let str = val;
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// Post-patches ONLY the TAA_EMAIL_STATUS cell of rows in heldRowIds, to whatever
// computeEmailStatusByRowId(..., heldRowIds) would have written there — i.e. exactly what the
// engine itself would produce if generateAnnotatedCognosFile had the held set. Every OTHER
// record's text is copied byte-for-byte from the original (never re-serialized), so a held row's
// untouched cells, and every non-held row entirely, can never drift from the engine's own output.
// Rows are 1:1, in order, with the data records the engine writes (one record per `rows[]`
// entry, no filtering — see generateAnnotatedCognosFile's `rows.forEach`), so this maps records
// to rows positionally rather than re-deriving a key from the row text.
function patchAnnotatedEmailStatus(
  csvOrTsv: string,
  rows: ReconciliationRow[],
  delimiter: string,
  statusByBaseRowId: Map<string, string>,
  heldRowIds: ReadonlySet<string>,
): string {
  if (!csvOrTsv || heldRowIds.size === 0) return csvOrTsv;
  const records = parseDelimitedRecords(csvOrTsv, delimiter);
  if (records.length < 2) return csvOrTsv;
  const statusColIdx = records[0].fields.indexOf('TAA_EMAIL_STATUS');
  if (statusColIdx === -1) return csvOrTsv;

  const parts: string[] = [csvOrTsv.slice(records[0].start, records[0].end)];
  for (let i = 0; i < rows.length; i += 1) {
    const recordIdx = i + 1; // header occupies records[0]
    if (recordIdx >= records.length) break;
    const record = records[recordIdx];
    const row = rows[i];
    let lineText = csvOrTsv.slice(record.start, record.end);
    if (heldRowIds.has(row.id) && statusColIdx < record.fields.length) {
      const refStatus = statusByBaseRowId.get(row.id);
      if (refStatus && record.fields[statusColIdx] !== refStatus) {
        const patchedFields = record.fields.slice();
        patchedFields[statusColIdx] = refStatus;
        lineText = patchedFields.map(f => escapeCell(f, delimiter)).join(delimiter);
      }
    }
    parts.push(lineText);
  }
  // Any records beyond rows.length (should never happen — one record per row) are appended
  // untouched, so this can never silently drop trailing data.
  for (let recordIdx = rows.length + 1; recordIdx < records.length; recordIdx += 1) {
    parts.push(csvOrTsv.slice(records[recordIdx].start, records[recordIdx].end));
  }
  return parts.join('\n');
}

/**
 * Rebuilds all four reviewer-facing exports from the current row set. Used by every place that
 * changes includeInOutput/reviewCompleted (App.tsx's handleToggleInclude/handleToggleIncludeAll)
 * and by the unseen-punch audit's REASON hold (unseenPunchAudit.ts), so a manual review action
 * can never silently drop an unseen-punch email hold.
 *
 * heldRowIds: ReconciliationRow.id values whose row stays in output (includeInOutput can still
 * be true) but whose EMAIL must be held anyway (unseenPunchFlag === 'REASON'). Passing an empty
 * set reproduces the engine's own generateEmailActionsJson/generateAnnotatedCognosFile output
 * exactly (see regressionSuite.ts unseen-13).
 */
export function rebuildOutputs(
  rows: ReconciliationRow[],
  emailActions: EmailActionItem[],
  config: ConfigRegistry,
  verificationAudit: VerificationOverrideAudit | undefined,
): RebuiltOutputs {
  const heldRowIds = new Set(rows.filter(r => r.unseenPunchFlag === 'REASON').map(r => r.id));

  // Unfiltered, one-per-row-in-order — mirrors reconciliationEngine.ts's own `allCorrections`
  // (its ReconciliationOutput.aspectCorrections), which is independent of includeInOutput; only
  // the CSV itself is filtered to included rows (generateAspectCorrectionsCsv's own contract,
  // matching App.tsx's existing handleToggleInclude/handleToggleIncludeAll usage).
  const aspectCorrections = rows.flatMap(r => r.details.generatedCorrections);
  const aspectCorrectionsCsv = generateAspectCorrectionsCsv(rows.filter(r => r.includeInOutput).flatMap(r => r.details.generatedCorrections));

  const emailActionsJson = rebuildEmailActionsJson(emailActions, rows, config, heldRowIds);

  let annotatedCognosCsv = generateAnnotatedCognosFile(rows, ',', config, verificationAudit, emailActions);
  let annotatedCognosTsv = generateAnnotatedCognosFile(rows, '\t', config, verificationAudit, emailActions);

  if (heldRowIds.size > 0) {
    const { statusByBaseRowId } = computeEmailStatusByRowId(
      emailActions, eligibleRowIdSet(rows), config.sectionMailboxMap, config.emailTemplates, heldRowIds,
    );
    annotatedCognosCsv = patchAnnotatedEmailStatus(annotatedCognosCsv, rows, ',', statusByBaseRowId, heldRowIds);
    annotatedCognosTsv = patchAnnotatedEmailStatus(annotatedCognosTsv, rows, '\t', statusByBaseRowId, heldRowIds);
  }

  return { aspectCorrections, aspectCorrectionsCsv, emailActionsJson, annotatedCognosCsv, annotatedCognosTsv };
}
