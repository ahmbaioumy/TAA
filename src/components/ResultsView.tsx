import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Search,
  Filter,
  Download,
  CheckCircle2,
  AlertTriangle,
  Clock,
  UserX,
  Layers,
  ArrowRight,
  Info,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  ShieldCheck,
  Zap,
  Mail,
  Mails,
  Sheet,
  X,
} from 'lucide-react';
import { ReconciliationRow, TaaResultCategory, AspectCorrectionRow, EmailActionItem, ColumnComparisonStatus, ConfigRegistry, VerificationOverrideAudit, ReviewStatus } from '../types/taa';
import { isForcedHoldReason } from '../services/holdReasons';
import { nextReviewStatus, countNotReviewed, reviewStatusLabel } from '../services/reviewStatus';
import { isCodeInConfiguredSet } from '../services/scheduleRecompute';
import { buildIndividualOverride, findSectionMailbox, planEmailDraftActions } from '../services/emailDrafts';
import { buildEmlFile, buildUniqueEmlFileNames } from '../services/emlBuilder';
import { serializeVerificationOverrideAudit, verificationFailedCheckSummary } from '../services/verificationAudit';
import { buildResultsWorkbookSheets, rowHasLateCoverCorrection, rowHasShiftChangeCorrection, rowIsMustCheck, describeDisagreement } from '../services/reconciliationEngine';
import { buildXlsxWorkbook } from '../services/xlsxWriter';
import { formatMinutesToHHMM } from '../services/parsers';

interface ResultsViewProps {
  rows: ReconciliationRow[];
  aspectCorrectionsCsv: string;
  annotatedCognosCsv: string;
  emailActions: EmailActionItem[];
  emailActionsJson: string;
  config: ConfigRegistry;
  verificationAudit?: VerificationOverrideAudit;
  summary: {
    totalRecords: number;
    shiftChangedCount: number;
    lateCoverCount: number;
    markedAbsentCount: number;
    noActionCount: number;
    cognosDataGapCount: number;
    disagreementsResolvedCount: number;
    overtimeRowsCount: number;
    flexRowsCount: number;
    otConvertedCount: number;
    otRlsAdjustedCount?: number;
    heldForReviewCount?: number;
    mismatchCount?: number;
    mustCheckCount?: number;
  };
  onToggleInclude?: (rowId: string, nextIncluded: boolean) => void;
  onToggleIncludeAll?: (rowIds: string[], nextIncluded: boolean) => void;
  onSetReviewStatus?: (rowId: string, status: ReviewStatus) => void;
  /** Hold Policy (doc/PRD.md §Hold Policy) — true when the saved policy differs from the one
   * actually used to produce this output (isResultStale, src/services/holdPolicy.ts). Disables
   * the 3 export buttons (Re-calculate first) and shows the amber stale banner. */
  isStale?: boolean;
  onRecalculate?: () => void;
}

const COMPARISON_STATUS_STYLE: Record<ColumnComparisonStatus, string> = {
  MATCH: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MISMATCH: 'bg-rose-50 text-rose-700 border-rose-200',
  COGNOS_BLANK: 'bg-sky-50 text-sky-700 border-sky-200',
  NOT_COMPARABLE: 'bg-slate-50 text-slate-500 border-slate-200',
};

// UI-only tri-state review marker (§reviewStatus) — a tiny circle icon per
// status, click-to-cycle. Deliberately not gated by isForced/onToggleInclude:
// it tracks the reviewer's own progress, not the export gate, so it must stay
// clickable even on a locked/forced-hold row.
function ReviewStatusButton({
  status,
  onClick,
}: {
  status: ReviewStatus;
  onClick: (e: React.MouseEvent) => void;
}) {
  const label = reviewStatusLabel(status);
  const title = `Review status: ${label} — click to change`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="review-ctl inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-slate-100"
    >
      {status === 'NOT_TOUCHED' && (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-slate-400" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      {status === 'PENDING' && (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-blue-500">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M8 1.5A6.5 6.5 0 0 1 8 14.5V1.5Z" fill="currentColor" className="text-blue-600" />
        </svg>
      )}
      {status === 'REVIEWED' && (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-emerald-600">
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path d="M4.8 8.2 6.9 10.3 11.2 5.7" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

const DRAFT_STATUS_STYLE = {
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};

export function ResultsView({
  rows,
  aspectCorrectionsCsv,
  annotatedCognosCsv,
  emailActions,
  emailActionsJson,
  config,
  verificationAudit,
  summary,
  onToggleInclude,
  onToggleIncludeAll,
  onSetReviewStatus,
  isStale,
  onRecalculate,
}: ResultsViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  // Derived (not stored) so the trace always reflects the live row — e.g. the
  // "Include in ASPECT correction CSV" checkbox inside the trace previously
  // read a stale snapshot and didn't move when toggled, because the row was
  // captured by value at selection time instead of looked up by id.
  const selectedRow = useMemo(
    () => (selectedRowId ? rows.find(r => r.id === selectedRowId) ?? null : null),
    [rows, selectedRowId]
  );

  useEffect(() => {
    if (!selectedRowId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedRowId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedRowId]);

  // Category counts. buildResultsWorkbookSheets (reconciliationEngine.ts)
  // copies these same predicates for the Excel export's sheets — keep both
  // in sync.
  const counts = useMemo(() => {
    const c = {
      ALL: rows.length,
      SHIFT_CHANGED: 0,
      LATE_AND_COVER_ADDED: 0,
      MARKED_ABSENT: 0,
      NO_ACTION_REQUIRED: 0,
      COGNOS_DATA_GAP: 0,
      HELD: 0,
      HELD_LEFT: 0,
      OT_UPDATES: 0,
      MUST_CHECK: 0,
      MUST_CHECK_LEFT: 0,
      UNSEEN_PUNCH: 0,
    };
    // A held row intentionally still carries its own TAA_RESULT_CATEGORY (both
    // the category sheet and the "Held for Review" sheet list it in the export)
    // — track how many of each category's rows are ALSO held so the tab label
    // can say so, rather than a category count silently including rows nobody
    // has actually approved for inclusion yet.
    const heldWithinCategory: Record<TaaResultCategory, number> = {
      SHIFT_CHANGED: 0,
      LATE_AND_COVER_ADDED: 0,
      MARKED_ABSENT: 0,
      NO_ACTION_REQUIRED: 0,
      COGNOS_DATA_GAP: 0,
    };
    rows.forEach(r => {
      if (c[r.TAA_RESULT_CATEGORY] !== undefined) {
        c[r.TAA_RESULT_CATEGORY]++;
        if (r.holdReason) heldWithinCategory[r.TAA_RESULT_CATEGORY]++;
      }
      // Late + Cover is correction-based, not just category-based: with
      // config.retainLateCoverOnAbsent on, a row's final category is
      // MARKED_ABSENT (already counted above) but it also carries a real
      // Late/Logoff+Cover correction — count it here too so the tab a cover
      // reviewer opens actually shows it. Guarded so a row whose category IS
      // already LATE_AND_COVER_ADDED isn't counted twice.
      if (r.TAA_RESULT_CATEGORY !== 'LATE_AND_COVER_ADDED' && rowHasLateCoverCorrection(r)) {
        c.LATE_AND_COVER_ADDED++;
        if (r.holdReason) heldWithinCategory.LATE_AND_COVER_ADDED++;
      }
      // D15 fix: Shift Changed is correction-based too, same shape as Late +
      // Cover above — a flex Branch B row lands in LATE_AND_COVER_ADDED (its
      // arrival is genuinely late) but still rewrites the shift time and
      // carries a real 'shift' 10/11 pair, so it belongs here too.
      if (r.TAA_RESULT_CATEGORY !== 'SHIFT_CHANGED' && rowHasShiftChangeCorrection(r)) {
        c.SHIFT_CHANGED++;
        if (r.holdReason) heldWithinCategory.SHIFT_CHANGED++;
      }
      if (r.holdReason) c.HELD++;
      if (r.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS') || r.TAA_ACTIONS_FIRED.includes('OT_TO_SHIFT')) c.OT_UPDATES++;
      // D19/B7/B12 — Must Check is a duplicate view (evidence to check, never
      // its own category), so it counts separately and is never subtracted
      // from any category or held total above.
      if (rowIsMustCheck(r)) c.MUST_CHECK++;
      // Unseen-punch audit (src/services/unseenPunchAudit.ts) — a separate
      // review-worthy view, same shape as Must Check: counts independently,
      // never subtracted from any category/held total above.
      if (r.unseenPunchFlag) c.UNSEEN_PUNCH++;
    });
    // "N left" qualifiers on the Held/Must Check chips (§reviewStatus, UI-only,
    // never exported) — how many of that chip's own rows aren't REVIEWED yet.
    c.HELD_LEFT = countNotReviewed(rows.filter(r => !!r.holdReason));
    c.MUST_CHECK_LEFT = countNotReviewed(rows.filter(rowIsMustCheck));
    return { ...c, heldWithinCategory };
  }, [rows]);

  // Appends a "· N held" qualifier to a category tab count when some of that
  // category's rows are also held for review — see heldWithinCategory above.
  const categoryCountLabel = (count: number, held: number): string =>
    held > 0 ? `${count} · ${held} held` : `${count}`;

  // Filtered rows
  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (selectedCategory === 'HELD') {
        if (!r.holdReason) return false;
      } else if (selectedCategory === 'OT_UPDATES') {
        if (!r.TAA_ACTIONS_FIRED.includes('ADJUST_OT_RLS') && !r.TAA_ACTIONS_FIRED.includes('OT_TO_SHIFT')) return false;
      } else if (selectedCategory === 'MUST_CHECK') {
        if (!rowIsMustCheck(r)) return false;
      } else if (selectedCategory === 'UNSEEN_PUNCH') {
        if (!r.unseenPunchFlag) return false;
      } else if (selectedCategory === 'LATE_AND_COVER_ADDED') {
        if (r.TAA_RESULT_CATEGORY !== 'LATE_AND_COVER_ADDED' && !rowHasLateCoverCorrection(r)) return false;
      } else if (selectedCategory === 'SHIFT_CHANGED') {
        if (r.TAA_RESULT_CATEGORY !== 'SHIFT_CHANGED' && !rowHasShiftChangeCorrection(r)) return false;
      } else if (selectedCategory !== 'ALL' && r.TAA_RESULT_CATEGORY !== selectedCategory) {
        return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const pf = (r.originalCognos['PF NO'] || '').toLowerCase();
        const name = (r.originalCognos['NAME'] || '').toLowerCase();
        const login = (r.originalCognos['LOGIN ID'] || '').toLowerCase();
        const verdict = r.TAA_VERDICT.toLowerCase();
        const user = r.TAA_USERNAME.toLowerCase();
        return pf.includes(q) || name.includes(q) || login.includes(q) || verdict.includes(q) || user.includes(q);
      }
      return true;
    });
  }, [rows, selectedCategory, searchQuery]);

  // Select-all (Include column header checkbox) — only rows that can actually
  // be toggled (i.e. not on a forced hold) count toward the bulk action.
  const eligibleVisibleRows = useMemo(
    () => filteredRows.filter(r => !isForcedHoldReason(r.holdReason)),
    [filteredRows]
  );
  // WP3 (B10) — one checkbox per row means two different things depending on
  // whether the row has corrections to send to payroll: for an actionable
  // row it is includeInOutput; for a no-correction row it is reviewCompleted.
  // Reused for the tick state, the select-all "all ticked" check and the
  // select-all header's own indeterminate state.
  const rowCheckedState = (r: ReconciliationRow): boolean =>
    r.details.generatedCorrections.length > 0 ? r.includeInOutput : r.reviewCompleted;
  const allVisibleIncluded = eligibleVisibleRows.length > 0 && eligibleVisibleRows.every(rowCheckedState);
  const someVisibleIncluded = eligibleVisibleRows.some(rowCheckedState);
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allVisibleIncluded && someVisibleIncluded;
    }
  }, [allVisibleIncluded, someVisibleIncluded]);

  const [draftStatus, setDraftStatus] = useState<{ tone: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);

  const rowById = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  // Grouped, not last-wins: a row firing more than one action (e.g. Late+Cover
  // AND a separate Absent finding) now gets one EmailActionItem PER action.
  // Grouped by base_row_id, the row each action explicitly belongs to — never
  // by splitting row_id on '#', which silently truncates when a PF NO itself
  // contains one (real occurrence: `PF NO = "PT #"`).
  const emailActionsByRow = useMemo(() => {
    const map = new Map<string, EmailActionItem[]>();
    emailActions.forEach(action => {
      const existing = map.get(action.base_row_id);
      if (existing) existing.push(action); else map.set(action.base_row_id, [action]);
    });
    return map;
  }, [emailActions]);
  const eligibleDraftActions = useMemo(
    () => emailActions.filter(action => {
      // Ad-hoc/optional cases (no policy rule fired — communication_rule stays
      // 'NA') never belong in Bulk Draft's count: they exist so a single row
      // can be drafted manually via the per-row icon, not to be pooled or
      // counted as "required" cases covered.
      if (action.communication_rule === 'NA') return false;
      // Looked up by base_row_id — the row this action explicitly belongs to.
      // Never split row_id on '#': a PF NO can contain one, which truncates the
      // key, fails the lookup, and silently drops that row's email from Bulk
      // Draft — the exact failure this whole per-action split exists to avoid.
      const row = rowById.get(action.base_row_id);
      // Unseen-punch audit REASON flag (unseenPunchAudit.ts): the ASPECT row
      // stays in output, but a punch outside the search window means the
      // reason shown to the employee may be wrong — only the email is held.
      // (An OUTCOME flag is already excluded above via includeInOutput.)
      return !!row && row.includeInOutput && !isForcedHoldReason(row.holdReason) && row.unseenPunchFlag !== 'REASON';
    }),
    [emailActions, rowById]
  );
  const unseenPunchHeldCount = useMemo(
    () => emailActions.filter(action => {
      if (action.communication_rule === 'NA') return false;
      const row = rowById.get(action.base_row_id);
      return !!row && row.includeInOutput && !isForcedHoldReason(row.holdReason) && row.unseenPunchFlag === 'REASON';
    }).length,
    [emailActions, rowById]
  );
  // Bulk drafting plan: staff/manager cases always stay individual;
  // EMAIL_OPS cases pool by Section into one digest email per mapped mailbox;
  // EMAIL_OPS cases in an unmapped Section are HELD — reported below, not
  // drafted, and never re-routed to the employee. The single-row "draft this
  // one" icon can still override an individual case, but only behind an
  // explicit confirmation (see handleRowDraft).
  const bulkDraftPlan = useMemo(
    () => planEmailDraftActions(eligibleDraftActions, config.sectionMailboxMap, config.emailTemplates),
    [eligibleDraftActions, config.sectionMailboxMap, config.emailTemplates]
  );

  const getDraftDisabledReason = (row: ReconciliationRow, action?: EmailActionItem): string => {
    if (!action) return 'No email required by policy';
    if (isForcedHoldReason(row.holdReason)) return row.holdReasonText || 'This row is locked for review';
    if (!row.includeInOutput) return 'Row is excluded from reviewed outputs';
    if (row.unseenPunchFlag === 'REASON') return row.unseenPunchNote || 'Email held — a punch outside the search window may change the reason shown (HELD_UNSEEN_PUNCH)';
    if (isDrafting) return 'Still downloading the previous draft(s)';
    return '';
  };

  // Download helper. A plain browser download is the ONLY file operation
  // available to a page opened by double-clicking the HTML directly: there is
  // no folder-write permission to ask for outside http(s), so this must never
  // depend on one.
  const downloadFile = (content: string | Uint8Array, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Downloads one ready-to-open .eml per action — no protocol, no folder
  // grant, no external process. Double-clicking a downloaded file opens it in
  // Outlook as a complete, editable, UNSENT draft (see emlBuilder.ts). A
  // pooled OPS digest addresses to its Section mailbox (ops_mailbox); every
  // other action addresses to its resolved `to` (§4.7), which is blank when
  // the row is TERMINATED or had no resolvable recipient — those still
  // download, so nothing is silently skipped, but the count below flags them
  // for manual addressing.
  //
  // Downloads are staggered a little: Chrome can block/prompt on a burst of
  // several automatic downloads fired in the same tick.
  const launchEmailDrafts = (actions: EmailActionItem[]) => {
    if (actions.length === 0 || isDrafting) return;
    const fileNames = buildUniqueEmlFileNames(actions);
    let needsRecipientCount = 0;
    setIsDrafting(true);
    actions.forEach((action, i) => {
      const to = action.ops_mailbox || action.to || '';
      if (!to) needsRecipientCount++;
      const content = buildEmlFile({ to, cc: action.cc, subject: action.subject, body: action.body });
      window.setTimeout(() => downloadFile(content, fileNames[i], 'message/rfc822'), i * 120);
    });
    window.setTimeout(() => setIsDrafting(false), actions.length * 120 + 200);
    const draftedCount = actions.length - needsRecipientCount;
    setDraftStatus({
      tone: needsRecipientCount > 0 ? 'warning' : 'success',
      text: `${actions.length} draft${actions.length === 1 ? '' : 's'} downloaded — ${draftedCount} addressed` +
        (needsRecipientCount > 0 ? `, ${needsRecipientCount} need${needsRecipientCount === 1 ? 's' : ''} a recipient filled in` : '') +
        '. Double-click each .eml file to open it in Outlook — nothing is sent automatically.',
    });
  };

  const handleBulkDraft = () => {
    const { finalActions, staffActions, held, heldSections, pooled } = bulkDraftPlan;
    if (finalActions.length === 0 || isDrafting) return;
    const coveredCases = eligibleDraftActions.length - held.length;
    const heldLine = held.length > 0
      ? `\n\nHELD, NOT DRAFTED: ${held.length} OPS case(s) in Section(s) [${heldSections.join(', ')}] — no OPS mailbox is configured for them. ` +
        'They are not being sent to the employee. Add the mailbox in the Email Config wizard and run Bulk Draft again.'
      : '';
    // HELD_UNSEEN_PUNCH (emailDrafts.ts) — REASON-flagged rows (unseenPunchAudit.ts) never
    // reach eligibleDraftActions at all (filtered out above), so they're reported separately
    // here rather than folding into the OPS-mailbox held count above, which means something
    // different (a routing gap, not a reason that may be wrong).
    const unseenPunchLine = unseenPunchHeldCount > 0
      ? `\n\nHELD, NOT DRAFTED: ${unseenPunchHeldCount} case(s) — a CMS punch outside the search window was found that may change the reason shown. Review the row's Unseen Punch note before drafting.`
      : '';
    const ok = window.confirm(
      `Download ${finalActions.length} draft(s): ${staffActions.length} individual + ${pooled.length} section group email(s) covering ${coveredCases} case(s).` +
      heldLine +
      unseenPunchLine +
      '\n\nEach downloads as a .eml file — double-click one to open it in Outlook for review. No email will be sent automatically.'
    );
    if (!ok) return;
    launchEmailDrafts(finalActions);
  };

  // Single-row draft. An EMAIL_OPS row goes to its Section mailbox when one is
  // configured. When none is, drafting it individually means overriding the
  // Communication Rule that actually fired — §4.1 routed this case to OPS
  // specifically so the employee and their line manager would not receive it —
  // so that override now requires an explicit yes instead of happening
  // silently behind the mail icon.
  const handleRowDraft = (action: EmailActionItem) => {
    if (action.communication_rule !== 'EMAIL_OPS') {
      launchEmailDrafts([action]);
      return;
    }
    const mailbox = findSectionMailbox(config.sectionMailboxMap, action.section);
    if (mailbox) {
      launchEmailDrafts([{ ...action, ops_mailbox: mailbox }]);
      return;
    }
    const ok = window.confirm(
      `This case's rule is EMAIL_OPS — it is meant to go to the OPS mailbox for Section "${action.section || '(none)'}", not to the employee.\n\n` +
      'No mailbox is configured for that Section. Drafting it here will address it to the EMPLOYEE and CC their line manager instead, which overrides the rule that fired.\n\n' +
      'Override and draft to the employee anyway?'
    );
    if (!ok) return;
    launchEmailDrafts([buildIndividualOverride(action, config.employeeManagerMap)]);
  };

  // A row can now carry more than one EmailActionItem (one per fired action —
  // e.g. a Late+Cover finding AND a separate Absent finding on the same day).
  // Draft each in turn, reusing handleRowDraft's own per-action EMAIL_OPS
  // override confirmation — sequential, so a row with an EMAIL_OPS action
  // alongside an NA one still asks before overriding just that one.
  const handleRowDraftAll = (actions: EmailActionItem[]) => {
    actions.forEach(a => handleRowDraft(a));
  };

  // Defect fix: output filenames were previously hardcoded with the sample
  // dataset's date (e.g. "_28082026") regardless of when the run actually
  // happened — every real run silently overwrote the same filename.
  const todayStamp = useMemo(() => {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0') + d.getFullYear();
  }, []);

  // Multi-sheet Excel export — always the full dataset (rows/emailActions
  // props), never filteredRows/searchQuery/selectedCategory: this button
  // must export every category tab regardless of what's currently on screen.
  const handleExportXlsx = () => {
    const sheets = buildResultsWorkbookSheets(rows, emailActions);
    const bytes = buildXlsxWorkbook(sheets);
    downloadFile(bytes, `TAA_Results_${todayStamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };

  // Defect fix: download buttons previously gave no row-count/size
  // confirmation visible in the UI itself (only in a non-visible `title`
  // tooltip).
  // Phase 5 fix: the CSV is now headerless (data rows only), so every
  // non-blank line IS a correction row — no header line to subtract.
  const aspectCorrectionsRowCount = useMemo(
    () => aspectCorrectionsCsv.split('\n').filter(l => l.trim().length > 0).length,
    [aspectCorrectionsCsv]
  );
  const emailActionsCount = useMemo(() => {
    try {
      return (JSON.parse(emailActionsJson) as unknown[]).length;
    } catch {
      return 0;
    }
  }, [emailActionsJson]);

  const getCategoryBadge = (category: TaaResultCategory) => {
    switch (category) {
      case 'SHIFT_CHANGED':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-50 text-purple-700 border border-purple-200">
            <Zap className="w-3 h-3 mr-1 text-purple-600" />
            1. Shift Changed (Flex)
          </span>
        );
      case 'LATE_AND_COVER_ADDED':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3 h-3 mr-1 text-amber-600" />
            2. Late + Cover Added
          </span>
        );
      case 'MARKED_ABSENT':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <UserX className="w-3 h-3 mr-1 text-rose-600" />
            3. Marked Absent
          </span>
        );
      case 'NO_ACTION_REQUIRED':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-600" />
            4. No Action Required (Resolved)
          </span>
        );
      case 'COGNOS_DATA_GAP':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
            <Info className="w-3 h-3 mr-1 text-slate-600" />
            5. Cognos Data Gap
          </span>
        );
    }
  };

  const policyReleasedCount = useMemo(() => rows.filter(r => !!r.details.holdPolicyRelease).length, [rows]);

  return (
    <div className="space-y-6">
      {isStale && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950">
          <div className="font-semibold">
            Hold policy changed after this calculation — results and exports are out of date. Re-calculate to apply.
          </div>
          {onRecalculate && (
            <button
              type="button"
              onClick={onRecalculate}
              className="rounded border border-amber-400 bg-white px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100"
            >
              Re-calculate
            </button>
          )}
        </div>
      )}
      {verificationAudit && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950">
          <div>
            <div className="font-bold">Payroll verification override used</div>
            <div className="mt-1">{verificationAudit.reason}</div>
            <div className="mt-1 font-mono text-[11px] text-amber-800">
              {verificationAudit.acknowledged_at} · {verificationFailedCheckSummary(verificationAudit)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => downloadFile(serializeVerificationOverrideAudit(verificationAudit), `TAA_Verification_Override_${todayStamp}.json`, 'application/json')}
            className="flex items-center gap-1.5 rounded border border-amber-300 bg-white px-3 py-2 font-semibold text-amber-900 hover:bg-amber-100"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Override Audit JSON</span>
          </button>
        </div>
      )}
      {/* Top Stats Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Total Audited</span>
          <div className="text-2xl font-bold text-slate-900 mt-1 font-mono">{summary.totalRecords}</div>
          <span className="text-[11px] text-slate-500 font-medium">Employee-Day Rows (this card only)</span>
        </div>

        <div className="bg-white border border-purple-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Shift Changed</span>
          <div className="text-2xl font-bold text-purple-700 mt-1 font-mono">{summary.shiftChangedCount}</div>
          <span className="text-[11px] text-purple-600/80 font-medium">Flex Roster Updates</span>
        </div>

        <div className="bg-white border border-amber-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">Late & Cover</span>
          <div className="text-2xl font-bold text-amber-700 mt-1 font-mono">{summary.lateCoverCount}</div>
          <span className="text-[11px] text-amber-600/80 font-medium">Correction Actions (a row can add more than one) — {counts.LATE_AND_COVER_ADDED} rows in its tab</span>
        </div>

        <div className="bg-white border border-rose-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-rose-600 font-bold uppercase tracking-wider">Marked Absent</span>
          <div className="text-2xl font-bold text-rose-700 mt-1 font-mono">{summary.markedAbsentCount}</div>
          <span className="text-[11px] text-rose-600/80 font-medium">Correction Actions — Penalties / No-Shows</span>
        </div>

        <div className="bg-white border border-emerald-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">Resolved / Clean</span>
          <div className="text-2xl font-bold text-emerald-700 mt-1 font-mono">{summary.noActionCount}</div>
          <span className="text-[11px] text-emerald-600/80 font-medium">
            False Positives Cleared{counts.heldWithinCategory.NO_ACTION_REQUIRED > 0 ? ` — ${counts.heldWithinCategory.NO_ACTION_REQUIRED} of these are still held` : ''}
          </span>
        </div>

        <div className="bg-white border border-indigo-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-wider">Cognos Fixes</span>
          <div className="text-2xl font-bold text-indigo-700 mt-1 font-mono">{summary.disagreementsResolvedCount}</div>
          {/* D16/WP3-carryover fix: this counts every Cognos column mismatch,
              not specifically the diagnosed Defect 1/2 cases — "Defect 1 & 2
              Protected" overclaimed what the number actually measures. */}
          <span className="text-[11px] text-indigo-600/80 font-medium">Every Cognos Column Mismatch Found</span>
        </div>

        <div className="bg-white border border-orange-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-orange-600 font-bold uppercase tracking-wider">OT &rarr; Shift</span>
          <div className="text-2xl font-bold text-orange-700 mt-1 font-mono">{summary.otConvertedCount}</div>
          <span className="text-[11px] text-orange-600/80 font-medium">OT Segments Converted (§4.6c)</span>
        </div>

        <div className="bg-white border border-amber-200 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">OT Adjusted (RLS)</span>
          <div className="text-2xl font-bold text-amber-700 mt-1 font-mono">{summary.otRlsAdjustedCount ?? 0}</div>
          <span className="text-[11px] text-amber-600/80 font-medium">Rule 8: OT duration reduced by release overlap</span>
        </div>

        <div className="bg-white border border-orange-300 rounded-2xl p-4 shadow-xs">
          <span className="text-[10px] text-orange-700 font-bold uppercase tracking-wider">Held for Review</span>
          <div className="text-2xl font-bold text-orange-800 mt-1 font-mono">{summary.heldForReviewCount ?? 0}</div>
          {/* D16 fix: this is NOT "of which N have a mismatch" — heldForReviewCount
              and mismatchCount are two separate metrics with different trigger
              sets (~20 hold reasons vs. one specific comparison), so mismatchCount
              can exceed a naive reading of "part of the total above". Worded as
              its own fact, not a subset. */}
          <span className="text-[11px] text-orange-700/80 font-medium">Includes {summary.mismatchCount ?? 0} row(s) separately flagged with a column mismatch</span>
        </div>
      </div>

      {policyReleasedCount > 0 && (
        <div>
          <span
            className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"
            title="Rows the Hold Policy tab released this run — see each row's trace for the reason/category/action that released it"
          >
            Released by policy ({policyReleasedCount})
          </span>
        </div>
      )}

      {/* Export Action Bar (§5 Outputs 1, 2, 3) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <h4 className="text-sm font-bold text-slate-900">Export Reconciled Deliverables</h4>
            <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold uppercase tracking-wider border border-indigo-200/60">
              Audit Standard
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Strictly segregated payroll-compliant outputs with byte-identical Cognos preservation & trailing-comma ASPECT CSVs
          </p>
        </div>

        <div className="flex flex-col items-end space-y-1.5">
        <div className="flex items-center space-x-2.5">
          <button
            onClick={() => downloadFile(aspectCorrectionsCsv, `ASPECT_Corrections_${todayStamp}.csv`, 'text/csv')}
            disabled={isStale}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center space-x-1.5 shadow-sm shadow-indigo-200 transition-all disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none disabled:cursor-not-allowed"
            title={isStale ? 'Re-calculate first — the hold policy changed since this output was produced' : 'Download Output 1: ASPECT Correction CSV format with trailing commas'}
          >
            <Download className="w-3.5 h-3.5" />
            <span>1. ASPECT Correction CSV</span>
          </button>

          <button
            onClick={() => downloadFile(annotatedCognosCsv, `Cognos_Annotated_${todayStamp}.csv`, 'text/csv')}
            disabled={isStale}
            className="px-3.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 text-xs font-semibold flex items-center space-x-1.5 border border-slate-200 transition-all shadow-xs disabled:text-slate-300 disabled:cursor-not-allowed"
            title={isStale ? 'Re-calculate first — the hold policy changed since this output was produced' : 'Download Output 2: Annotated Cognos Report with TAA analysis and verification audit columns'}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-sky-600" />
            <span>2. Annotated Cognos CSV</span>
          </button>

          {/* The count is the number of drafts that will actually open, not the
              number of eligible cases — held OPS cases produce no draft, and a
              button reading "Draft Emails (1)" next to a banner saying nothing
              will be drafted is a contradiction the operator has to resolve. */}
          <button
            onClick={handleBulkDraft}
            disabled={bulkDraftPlan.finalActions.length === 0 || isDrafting || isStale}
            className="px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center space-x-1.5 border border-sky-500 transition-all shadow-sm shadow-sky-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:shadow-none disabled:cursor-not-allowed"
            title={
              isStale
                ? 'Re-calculate first — the hold policy changed since this output was produced'
                : isDrafting
                ? 'Still downloading the previous draft(s)'
                : bulkDraftPlan.finalActions.length === 0
                  ? bulkDraftPlan.held.length > 0
                    ? `All ${bulkDraftPlan.held.length} eligible OPS case(s) are held — Section(s) [${bulkDraftPlan.heldSections.join(', ')}] have no OPS mailbox configured`
                    : 'No reviewed email-required rows are eligible for drafting'
                  : `Download ${bulkDraftPlan.finalActions.length} Outlook draft(s) as .eml files${bulkDraftPlan.held.length > 0 ? `; ${bulkDraftPlan.held.length} OPS case(s) held` : ''}${unseenPunchHeldCount > 0 ? `; ${unseenPunchHeldCount} unseen-punch case(s) held` : ''}`
            }
          >
            <Mails className="w-3.5 h-3.5" />
            <span>Draft Emails ({bulkDraftPlan.finalActions.length})</span>
          </button>
        </div>
        <span className="text-[11px] text-slate-400 font-medium">
          {aspectCorrectionsRowCount} correction row(s) • {rows.length} annotated row(s) • {emailActionsCount} email action(s)
        </span>
        {draftStatus && (
          <span className={`max-w-xl text-[11px] font-medium border rounded-lg px-2.5 py-1 ${DRAFT_STATUS_STYLE[draftStatus.tone]}`}>
            {draftStatus.text}
          </span>
        )}
        {bulkDraftPlan.held.length > 0 && (
          <span className="max-w-xl flex items-start gap-1.5 text-[11px] font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>{bulkDraftPlan.held.length} OPS case(s) will not be drafted.</strong> Section(s) [{bulkDraftPlan.heldSections.join(', ')}] have no OPS mailbox configured. These are held rather than sent to the employee — add the mailbox in the Email Config wizard, then run Bulk Draft again.
            </span>
          </span>
        )}
        {unseenPunchHeldCount > 0 && (
          <span className="max-w-xl flex items-start gap-1.5 text-[11px] font-medium text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-2.5 py-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>{unseenPunchHeldCount} case(s) will not be drafted (HELD_UNSEEN_PUNCH).</strong> A CMS punch outside the search window was found that may change the reason shown to the employee — see the Unseen Punch filter and each row's note.
            </span>
          </span>
        )}
        </div>
      </div>

      {/* 5-Category Filter Tabs & Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Category Pill Filters */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-slate-100/90 border border-slate-200/80 text-xs">
          <button
            onClick={() => setSelectedCategory('ALL')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'ALL'
                ? 'bg-white text-slate-900 font-bold shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            }`}
          >
            All ({counts.ALL})
          </button>
          <button
            onClick={() => setSelectedCategory('SHIFT_CHANGED')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'SHIFT_CHANGED'
                ? 'bg-purple-600 text-white font-bold shadow-xs'
                : 'text-purple-700 hover:bg-purple-50'
            }`}
          >
            1. Shift Changed ({categoryCountLabel(counts.SHIFT_CHANGED, counts.heldWithinCategory.SHIFT_CHANGED)})
          </button>
          <button
            onClick={() => setSelectedCategory('LATE_AND_COVER_ADDED')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'LATE_AND_COVER_ADDED'
                ? 'bg-amber-600 text-white font-bold shadow-xs'
                : 'text-amber-700 hover:bg-amber-50'
            }`}
          >
            2. Late + Cover ({categoryCountLabel(counts.LATE_AND_COVER_ADDED, counts.heldWithinCategory.LATE_AND_COVER_ADDED)})
          </button>
          <button
            onClick={() => setSelectedCategory('MARKED_ABSENT')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'MARKED_ABSENT'
                ? 'bg-rose-600 text-white font-bold shadow-xs'
                : 'text-rose-700 hover:bg-rose-50'
            }`}
          >
            3. Absent ({categoryCountLabel(counts.MARKED_ABSENT, counts.heldWithinCategory.MARKED_ABSENT)})
          </button>
          <button
            onClick={() => setSelectedCategory('NO_ACTION_REQUIRED')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'NO_ACTION_REQUIRED'
                ? 'bg-emerald-600 text-white font-bold shadow-xs'
                : 'text-emerald-700 hover:bg-emerald-50'
            }`}
          >
            4. No Action ({categoryCountLabel(counts.NO_ACTION_REQUIRED, counts.heldWithinCategory.NO_ACTION_REQUIRED)})
          </button>
          <button
            onClick={() => setSelectedCategory('COGNOS_DATA_GAP')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'COGNOS_DATA_GAP'
                ? 'bg-slate-700 text-white font-bold shadow-xs'
                : 'text-slate-700 hover:bg-slate-200/50'
            }`}
          >
            5. Data Gap ({categoryCountLabel(counts.COGNOS_DATA_GAP, counts.heldWithinCategory.COGNOS_DATA_GAP)})
          </button>
          <button
            onClick={() => setSelectedCategory('HELD')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'HELD'
                ? 'bg-orange-600 text-white font-bold shadow-xs'
                : 'text-orange-700 hover:bg-orange-50'
            }`}
          >
            Held for Review ({counts.HELD} · {counts.HELD_LEFT} left)
          </button>
          <button
            onClick={() => setSelectedCategory('OT_UPDATES')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'OT_UPDATES'
                ? 'bg-red-700 text-white font-bold shadow-xs'
                : 'text-red-700 hover:bg-red-50'
            }`}
          >
            OT Updates ({counts.OT_UPDATES})
          </button>
          <button
            onClick={() => setSelectedCategory('MUST_CHECK')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'MUST_CHECK'
                ? 'bg-rose-700 text-white font-bold shadow-xs'
                : 'text-rose-800 hover:bg-rose-50'
            }`}
            title="Rows a human must look at: forced holds the engine cannot act on, plus held rows proposing a penalty or cover that pay is riding on"
          >
            Must Check ({counts.MUST_CHECK} · {counts.MUST_CHECK_LEFT} left)
          </button>
          <button
            onClick={() => setSelectedCategory('UNSEEN_PUNCH')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              selectedCategory === 'UNSEEN_PUNCH'
                ? 'bg-purple-700 text-white font-bold shadow-xs'
                : 'text-purple-800 hover:bg-purple-50'
            }`}
            title="A CMS punch outside the search window (unseen by the engine) was found that changes this row's reason or outcome — see unseenPunchNote on the row"
          >
            Unseen Punch ({counts.UNSEEN_PUNCH})
          </button>
        </div>

        {/* Search Field + Excel Export */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 transform -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search PF, Name, Login ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 pl-9 pr-3 rounded-lg bg-white border border-slate-200 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 shadow-xs"
            />
          </div>
          <button
            type="button"
            onClick={handleExportXlsx}
            title="Export to Excel — every category tab as a multi-sheet .xlsx, ignores the current search/filter, always includes every row"
            className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-all"
          >
            <Sheet className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Reconciliation Table (Side-by-Side Comparison §4.13) */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-bold text-[11px] border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-1 text-center w-8" title="Review status">
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 mx-auto text-slate-400" fill="none">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </th>
                <th className="py-3.5 px-3 text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span>Include</span>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleIncluded}
                      disabled={eligibleVisibleRows.length === 0 || !onToggleIncludeAll}
                      onChange={(e) =>
                        onToggleIncludeAll &&
                        onToggleIncludeAll(eligibleVisibleRows.map(r => r.id), e.target.checked)
                      }
                      title={allVisibleIncluded ? 'Exclude all shown rows' : 'Include all shown rows'}
                      className="w-3.5 h-3.5 accent-indigo-600 disabled:opacity-40 normal-case"
                    />
                  </div>
                </th>
                <th className="py-3.5 px-3 text-center">Email</th>
                <th className="py-3.5 px-4">Employee</th>
                <th className="py-3.5 px-3">Date</th>
                <th className="py-3.5 px-3">Role Tier</th>
                <th className="py-3.5 px-3">Category</th>
                <th className="py-3.5 px-3">Cognos Original (Raw)</th>
                <th className="py-3.5 px-3">Recomputed (True TAA)</th>
                <th className="py-3.5 px-3">Actual Punches</th>
                <th className="py-3.5 px-3">Final Action</th>
                <th className="py-3.5 px-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-slate-400 font-medium">
                    No discrepancy records match your filter criteria.
                  </td>
                </tr>
              ) : (
                filteredRows.map(row => {
                  const orig = row.originalCognos;
                  const isDisagree = !row.TAA_COGNOS_AGREE;
                  const isForced = isForcedHoldReason(row.holdReason);
                  const emailActionsForRow = emailActionsByRow.get(row.id) || [];
                  const emailAction = emailActionsForRow[0];
                  const draftDisabledReason = getDraftDisabledReason(row, emailAction);
                  const allNaForRow = emailActionsForRow.length > 0 && emailActionsForRow.every(a => a.communication_rule === 'NA');

                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedRowId(selectedRowId === row.id ? null : row.id)}
                      className={`hover:bg-slate-50/80 cursor-pointer transition-colors ${
                        selectedRowId === row.id ? 'bg-indigo-50/60' : ''
                      } ${row.holdReason ? 'bg-orange-50/40' : ''} ${
                        row.holdReason && row.reviewStatus === 'REVIEWED' ? '[&>td:not(.review-ctl)]:opacity-60' : ''
                      }`}
                    >
                      {/* Review status marker (UI-only, §reviewStatus) — never exported */}
                      <td className="review-ctl py-3.5 px-1 text-center" onClick={(e) => e.stopPropagation()}>
                        <ReviewStatusButton
                          status={row.reviewStatus}
                          onClick={() => onSetReviewStatus && onSetReviewStatus(row.id, nextReviewStatus(row.reviewStatus))}
                        />
                      </td>
                      {/* Include-in-output checkbox (Phase 5 review gate) */}
                      <td className="review-ctl py-3.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={rowCheckedState(row)}
                          disabled={isForced || !onToggleInclude}
                          onChange={(e) => onToggleInclude && onToggleInclude(row.id, e.target.checked)}
                          title={row.holdReasonText || (
                            row.details.generatedCorrections.length > 0
                              ? (row.includeInOutput ? 'Included in ASPECT correction CSV' : 'Excluded from ASPECT correction CSV')
                              : (row.reviewCompleted ? 'Reviewed — no corrections to send' : 'Not yet reviewed')
                          )}
                          className="w-3.5 h-3.5 accent-indigo-600 disabled:opacity-40"
                        />
                      </td>
                      {/* Outlook draft shortcut */}
                      <td className="py-3.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        {emailAction ? (
                          <button
                            type="button"
                            disabled={!!draftDisabledReason || isDrafting}
                            onClick={() => handleRowDraftAll(emailActionsForRow)}
                            title={draftDisabledReason || (
                              emailActionsForRow.length > 1
                                ? `${emailActionsForRow.length} actions fired on this row — download an Outlook draft (.eml) for each`
                                : emailAction.communication_rule === 'EMAIL_OPS'
                                ? `Download an Outlook draft (.eml) to the OPS mailbox for Section "${emailAction.section || '(none)'}"`
                                : emailAction.communication_rule === 'NA'
                                ? 'Not required by policy — download an ad-hoc case notice (.eml) with the full row detail'
                                : 'Download this case as an Outlook draft (.eml)'
                            )}
                            className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-all disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed ${
                              allNaForRow
                                ? 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100'
                                : 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
                            }`}
                          >
                            <Mail className="w-4 h-4" />
                            {emailActionsForRow.length > 1 && (
                              <span className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-indigo-600 text-white text-[9px] leading-[14px] text-center font-bold">
                                {emailActionsForRow.length}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-slate-300 font-mono">-</span>
                        )}
                      </td>
                      {/* Employee Identity */}
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-900">{orig['NAME'] || 'Staff'}</div>
                        <div className="font-mono text-[11px] text-slate-500 flex items-center space-x-2 mt-0.5">
                          <span>PF: {orig['PF NO']}</span>
                          <span>•</span>
                          <span>CMS: {orig['LOGIN ID']}</span>
                          <span>•</span>
                          <span>Sec: {orig['SECTION']}</span>
                        </div>
                      </td>

                      {/* Date */}
                      <td className="py-3.5 px-3 font-mono text-slate-600">
                        {(orig['SIGN IN DATE'] || '').split(' ')[0]}
                      </td>

                      {/* Role Tier */}
                      <td className="py-3.5 px-3">
                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider ${
                          row.TAA_TIER === 'FLEX'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : row.TAA_TIER === 'OFFICER_PLUS'
                            ? 'bg-sky-50 text-sky-700 border border-sky-200'
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        }`}>
                          {row.TAA_TIER}
                        </span>
                      </td>

                      {/* 5-Category Badge + Hold indicator */}
                      <td className="py-3.5 px-3 space-y-1">
                        {getCategoryBadge(row.TAA_RESULT_CATEGORY)}
                        {row.holdReason && (
                          <div
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-50 text-orange-700 border border-orange-200"
                            title={row.holdReason}
                          >
                            <AlertTriangle className="w-3 h-3 mr-1 text-orange-600" />
                            {isForcedHoldReason(row.holdReason) ? 'Locked' : 'Held'}: {row.holdReasonText}
                          </div>
                        )}
                      </td>

                      {/* Cognos Original View */}
                      <td className="py-3.5 px-3">
                        <div className="text-slate-700 font-mono font-medium">
                          Sch: {orig['SCH DURATION'] || orig['DUTY1']}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                          Late: {orig['LATE START']}m | Early: {orig['LEFT EARLY']}m
                        </div>
                        {/* D19 — Must-Check-only corroborating evidence, so a stuck
                            badge relay (e.g. a 48h span with an "Improper logout"
                            remark) reads visibly differently from a genuine docked
                            day. No new column — this reuses the existing cell. */}
                        {selectedCategory === 'MUST_CHECK' && (orig['SIGNIN DURATION'] || orig['REMARK']) && (
                          <div className="text-[11px] text-amber-700 font-mono mt-0.5 border-t border-slate-100 pt-0.5">
                            {orig['SIGNIN DURATION'] && <div>Signin Duration: {orig['SIGNIN DURATION']}</div>}
                            {orig['REMARK'] && <div className="truncate max-w-[220px]" title={orig['REMARK']}>Remark: {orig['REMARK']}</div>}
                          </div>
                        )}
                      </td>

                      {/* True TAA Recomputed View */}
                      <td className="py-3.5 px-3">
                        <div className="font-mono text-indigo-700 font-bold">
                          Net: {row.TAA_SCH_HOURS_FORMATTED} ({row.TAA_EFFECTIVE_START}–{row.TAA_EFFECTIVE_END})
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono flex items-center space-x-1 mt-0.5">
                          <span>Late: {row.TAA_LATE_MIN}m</span>
                          <span>|</span>
                          <span>Early: {row.TAA_EARLY_MIN}m</span>
                          {isDisagree && (
                            <span className="text-amber-800 text-[10px] bg-amber-100 border border-amber-200 px-1.5 py-0.2 rounded ml-1 font-sans font-bold">
                              {describeDisagreement(row)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Actual Punches */}
                      <td className="py-3.5 px-3 font-mono text-slate-700">
                        {row.TAA_CMS_IN ? (
                          <div>
                            <div className="font-medium">In: {row.TAA_CMS_IN}</div>
                            <div className="text-slate-400 text-[11px]">Out: {row.TAA_CMS_OUT || 'None'}</div>
                          </div>
                        ) : (
                          <span className="text-rose-600 font-bold text-[11px]">No Punches</span>
                        )}
                      </td>

                      {/* Final Action Code */}
                      <td className="py-3.5 px-3">
                        <span className="font-bold text-slate-900">
                          {row.TAA_ACTION}
                        </span>
                        <div className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                          {row.TAA_USERNAME ? `@${row.TAA_USERNAME}` : ''}
                          {row.TAA_IS_TERMINATED && (
                            <span
                              className="px-1.5 py-0.5 rounded-full text-[9px] font-sans font-bold bg-rose-100 text-rose-700 border border-rose-200 uppercase tracking-wider"
                              title="This employee record is flagged TERMINATED (§4.7) — verify before acting on any drafted email."
                            >
                              Terminated
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Details Indicator */}
                      <td className="py-3.5 px-3 text-right">
                        <span className="text-indigo-600 font-bold hover:underline text-xs">
                          {selectedRowId === row.id ? 'Hide' : 'Trace'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row Calculation Trace — modal overlay so the table underneath keeps
          its scroll position and active filter when the trace is closed. */}
      {selectedRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedRowId(null); }}
        >
          <div className="bg-slate-50 border border-slate-200 rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 p-6 bg-white">
              <div>
                <h4 className="text-base font-bold text-slate-900 flex items-center space-x-2">
                  <span>Calculation Trace: {selectedRow.originalCognos['NAME']}</span>
                  <span className="font-mono text-xs text-indigo-600 font-normal">
                    (PF: {selectedRow.originalCognos['PF NO']} | CMS: {selectedRow.originalCognos['LOGIN ID']} | Date: {(selectedRow.originalCognos['SIGN IN DATE'] || '').split(' ')[0]})
                  </span>
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  Rule Triggered: <strong className="text-slate-800">{selectedRow.details.ruleFired}</strong>
                </p>
              </div>
              <button
                onClick={() => setSelectedRowId(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-6 space-y-4">

          {/* Column-by-Column Recompute-then-Compare (Phase 3 core deliverable) */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                1. Column-by-Column Validation vs. Cognos ({selectedRow.TAA_MISMATCH_COUNT} mismatch{selectedRow.TAA_MISMATCH_COUNT === 1 ? '' : 'es'})
              </h5>
              <div className="flex items-center gap-3">
                <ReviewStatusButton
                  status={selectedRow.reviewStatus}
                  onClick={() => onSetReviewStatus && onSetReviewStatus(selectedRow.id, nextReviewStatus(selectedRow.reviewStatus))}
                />
                <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedRow.includeInOutput}
                    disabled={isForcedHoldReason(selectedRow.holdReason) || !onToggleInclude}
                    onChange={(e) => onToggleInclude && onToggleInclude(selectedRow.id, e.target.checked)}
                    className="w-3.5 h-3.5 accent-indigo-600 disabled:opacity-40"
                  />
                  Include in ASPECT correction CSV
                </label>
              </div>
            </div>
            {selectedRow.holdReasonText && (
              <div className="text-[11px] text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 font-medium">
                {selectedRow.holdReasonText}
              </div>
            )}
            {selectedRow.unseenPunchNote && (
              <div className="text-[11px] text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 font-medium">
                <strong>Unseen punch ({selectedRow.unseenPunchFlag}):</strong> {selectedRow.unseenPunchNote}
              </div>
            )}
            {selectedRow.details.holdPolicyRelease && (
              <div className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 font-medium">
                Released by your hold policy: {selectedRow.details.holdPolicyRelease.reason} · {selectedRow.details.holdPolicyRelease.category} · {selectedRow.details.holdPolicyRelease.actionGroup}
              </div>
            )}
            {!selectedRow.holdReason && selectedRow.columnComparisons.some(c => c.status === 'MISMATCH') && (
              <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 font-medium">
                Not held: every mismatch below is proven not to change the action.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-slate-400 uppercase tracking-wider text-[10px] font-bold">
                    <th className="text-left py-1.5 pr-3">Column</th>
                    <th className="text-left py-1.5 pr-3">Cognos Original</th>
                    <th className="text-left py-1.5 pr-3">TAA Recomputed</th>
                    <th className="text-left py-1.5 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedRow.columnComparisons.map((c, i) => (
                    <React.Fragment key={i}>
                      <tr>
                        <td className="py-1.5 pr-3 font-mono font-semibold text-slate-700">{c.column}</td>
                        <td className="py-1.5 pr-3 font-mono text-slate-600">{c.cognosRaw || '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-slate-600">{c.recomputedRaw || '—'}</td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${COMPARISON_STATUS_STYLE[c.status]}`} title={c.note}>
                            {c.status}
                          </span>
                        </td>
                      </tr>
                      {c.note && (
                        <tr>
                          <td colSpan={4} className="pb-1.5 pr-3 pt-0 text-[10px] text-slate-500 whitespace-normal break-words">
                            {c.note}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            {/* Column 1: Schedule Windows */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-2">
              <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                2. Schedule & Effective Windows
              </h5>
              <div className="space-y-1 font-mono text-slate-600 text-[11px]">
                <div>
                  Raw Shift: {selectedRow.details.rawShiftStart || 'None'} - {selectedRow.details.rawShiftEnd || 'None'}
                  {selectedRow.details.rawShiftStartFull && selectedRow.details.rawShiftEndFull && (
                    <span className="text-slate-400"> ({selectedRow.details.rawShiftStartFull} - {selectedRow.details.rawShiftEndFull})</span>
                  )}
                </div>
                <div>Release Deductions: {selectedRow.details.releaseMinutes}m</div>
                <div>Nursing Deductions: {selectedRow.details.nursingMinutes}m</div>
                {selectedRow.details.otInternalRemovalMinutes > 0 && (
                  <div>OT-Internal Deductions: {selectedRow.details.otInternalRemovalMinutes}m (release inside overtime, corrected by Rule 8)</div>
                )}
                {(() => {
                  const marker = selectedRow.details.aspectSegments.find(s => isCodeInConfiguredSet(s.SEG_CODE, config.existingAbsenceMarkerCodes || []));
                  return marker ? (
                    <div className="text-rose-700 font-bold">
                      ASPECT already tags this day: {marker.SEG_CODE}
                      <span className="font-normal text-slate-500"> (day-level marker, no start/stop — so it has no time entry in this section)</span>
                    </div>
                  ) : null;
                })()}
                <div className="text-indigo-600 font-bold">
                  Effective Start: {selectedRow.TAA_EFFECTIVE_START || '00:00'}
                </div>
                <div className="text-indigo-600 font-bold">
                  Effective End: {selectedRow.TAA_EFFECTIVE_END || '00:00'}
                </div>
                <div className="font-semibold text-slate-800">Recomputed Net Sch: {selectedRow.TAA_SCH_HOURS_RECOMPUTED}m ({selectedRow.TAA_SCH_HOURS_FORMATTED})</div>
              </div>
            </div>

            {/* Column 2: Actual Punches */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-2">
              <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                3. Actual CMS Attendance
              </h5>
              <div className="space-y-1 font-mono text-slate-600 text-[11px]">
                <div>
                  First Login: {selectedRow.TAA_CMS_IN || 'No login'}
                  {selectedRow.details.cmsFirstLoginFull && (
                    <span className="text-slate-400"> ({selectedRow.details.cmsFirstLoginFull})</span>
                  )}
                </div>
                <div>
                  Last Logout: {selectedRow.TAA_CMS_OUT || 'No logout'}
                  {selectedRow.details.cmsLastLogoutFull && (
                    <span className="text-slate-400"> ({selectedRow.details.cmsLastLogoutFull})</span>
                  )}
                </div>
                <div>Total Punches in Window: {selectedRow.details.punchCount}</div>
                <div className="text-amber-700 font-semibold">Measured Late: {selectedRow.TAA_LATE_MIN} min</div>
                <div className="text-amber-700 font-semibold">Measured Early Leave: {selectedRow.TAA_EARLY_MIN} min</div>
                <div className="text-emerald-700 font-bold">
                  Charged Variance: {selectedRow.details.chargedVarianceMinutes} min
                </div>
              </div>
            </div>

            {/* Column 3: Generated Actions */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-2">
              <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px]">
                4. Emitted Actions (§5 Deliverables)
              </h5>
              <div className="space-y-1.5 font-mono text-slate-600 text-[11px]">
                <div>Verdict: <strong className="text-slate-900">{selectedRow.TAA_VERDICT}</strong></div>
                <div>Action: <strong className="text-indigo-700">{selectedRow.TAA_ACTION}</strong></div>
                {selectedRow.TAA_ACTIONS_FIRED && selectedRow.TAA_ACTIONS_FIRED.includes(';') && (
                  <div>All actions fired this row: <strong className="text-amber-700">{selectedRow.TAA_ACTIONS_FIRED}</strong></div>
                )}
                <div>
                  Resolved Username: <strong className="text-sky-700">@{selectedRow.TAA_USERNAME || 'None'}</strong>
                  {selectedRow.TAA_IS_TERMINATED && (
                    <strong className="ml-2 text-rose-700">— TERMINATED, verify before sending</strong>
                  )}
                </div>
                <div>
                  Email Section: <strong className="text-sky-700">{selectedRow.TAA_SECTION || 'None'}</strong>
                  <span className="text-slate-400"> ({selectedRow.TAA_SECTION_SOURCE})</span>
                </div>
                {selectedRow.details.sectionMismatch && (
                  <div className="text-amber-700">
                    Cognos SECTION "{selectedRow.details.cognosSection}" differs from ASPECT EMP_EXTRA_4 "{selectedRow.details.aspectIdentitySection}".
                  </div>
                )}
                {selectedRow.details.configValidationIssues && selectedRow.details.configValidationIssues.length > 0 && (
                  <div className="text-rose-700">
                    Config issues: <strong>{selectedRow.details.configValidationIssues.join(' | ')}</strong>
                  </div>
                )}
                <div>Cognos Disagree: {selectedRow.TAA_DISAGREE_REASON}</div>
                {selectedRow.details.generatedCorrections.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 text-[11px]">
                    <div className="text-slate-500 mb-1 font-sans font-bold">Generated Corrections:</div>
                    {selectedRow.details.generatedCorrections.map((c, i) => (
                      <div key={i} className="text-indigo-700 bg-indigo-50/60 border border-indigo-100 p-1.5 rounded mb-1">
                        Code {c.Code}: {c.SegmentCode} — schedule (nominateDate) {c.nominateDate || '—'} • starts (SegmentDate) {c.SegmentDate || '—'} {c.SegmentStarttime} ({c.Segmentduration})
                      </div>
                    ))}
                  </div>
                )}
                {/* Scoped to the §4.6f verdicts, NOT merely "a marker exists and nothing was
                    emitted". Gates ABOVE §4.6f (missing CMS join key, still clocked in,
                    invalid ASPECT date/time, leave-day exclusion) also produce zero
                    corrections and can sit on a day that happens to carry a marker — there
                    the empty output is NOT explained by the absence tag, and claiming it was
                    "deliberate" would tell a reviewer to move on from a row that is actually
                    held for missing or contradictory evidence. */}
                {selectedRow.details.generatedCorrections.length === 0
                  && (selectedRow.TAA_VERDICT === 'ABSENCE_ALREADY_RECORDED' || selectedRow.TAA_VERDICT === 'ABSENCE_CONTRADICTED_BY_CMS') && (
                  <div className="pt-2 border-t border-slate-100 text-[11px] font-sans text-slate-500">
                    {selectedRow.TAA_VERDICT === 'ABSENCE_CONTRADICTED_BY_CMS'
                      ? 'No correction generated — deliberately. The day is tagged absent in ASPECT but CMS shows attendance; TAA never reverses a recorded absence on its own, so this row is held for a human to decide.'
                      : 'No correction generated — deliberately. The day is already tagged absent in ASPECT, so TAA writes no second absence segment and drafts no notice.'}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Variance audit trail — the arithmetic behind the verdict, spelled out.
              A verdict that costs someone a day's pay must be reproducible by hand from
              what is on screen, without anyone reading the code. */}
          {selectedRow.details.varianceTrace && (
            <div className="mt-4 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
              <h5 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] mb-2">
                5. Variance Audit Trail — how each minute count was measured
              </h5>

              <div className="font-mono text-[11px] text-slate-600 space-y-1 mb-3">
                <div>
                  Rostered window: <strong className="text-slate-800">{selectedRow.details.varianceTrace.rawStart || '—'} → {selectedRow.details.varianceTrace.rawEnd || '—'}</strong>
                </div>
                <div>
                  Effective window (what attendance is judged against):{' '}
                  <strong className="text-indigo-700">{selectedRow.details.varianceTrace.effectiveStart || '—'} → {selectedRow.details.varianceTrace.effectiveEnd || '—'}</strong>
                </div>
                <div>
                  CMS attendance: <strong className="text-slate-800">{selectedRow.details.varianceTrace.actualFirstLogin || 'no login'} → {selectedRow.details.varianceTrace.actualLastLogout || 'no logout'}</strong>
                  {' '}({selectedRow.details.varianceTrace.attendanceSpanMinutes}m span across {selectedRow.details.varianceTrace.punchCount} punch{selectedRow.details.varianceTrace.punchCount === 1 ? '' : 'es'})
                </div>
                {/* Phase 9 (informational only, user-confirmed UI-only scope): the CMS
                    staffed (summed login->logout) time, shown as a distinct quantity next
                    to the span above — never a replacement for it, never fed into any
                    verdict or export. A near-zero staffed time next to an hours-long span
                    means this login's CMS rows are instantaneous swipe events carrying no
                    session length, not evidence the employee barely worked. */}
                {selectedRow.details.varianceTrace.staffedMinutes !== null && (
                  <div>
                    CMS staffed (login→logout summed) time:{' '}
                    <strong className="text-slate-800">{formatMinutesToHHMM(selectedRow.details.varianceTrace.staffedMinutes)}</strong>
                    {selectedRow.details.varianceTrace.staffedMinutes <= 5 && selectedRow.details.varianceTrace.attendanceSpanMinutes > 60 && (
                      <span className="text-amber-600">
                        {' '}— this login's CMS rows look like instantaneous swipe events (no real session length), not a short shift.
                      </span>
                    )}
                  </div>
                )}
              </div>

              {selectedRow.details.varianceTrace.removals.length > 0 && (
                <div className="mb-3">
                  <div className="text-slate-500 mb-1 font-bold text-[11px]">Release / nursing segments and where each one sits:</div>
                  <div className="space-y-1">
                    {selectedRow.details.varianceTrace.removals.map((rm, i) => (
                      <div
                        key={i}
                        className={`font-mono text-[11px] p-1.5 rounded border ${
                          rm.position === 'TRAILING' || rm.position === 'LEADING' || rm.position === 'OT_INTERNAL' || rm.position === 'MID' || rm.position === 'FULL_DAY'
                            ? 'bg-slate-50 border-slate-200 text-slate-700'
                            : 'bg-rose-50 border-rose-200 text-rose-800'
                        }`}
                      >
                        <strong>{rm.segCode}</strong> {rm.start || '(no start)'} → {rm.stop || '(no stop)'} ·{' '}
                        <strong>{rm.position}</strong> · removes {rm.minutes}m (from {rm.minutesSource === 'DURATION' ? 'its DURATION field' : rm.minutesSource === 'TIMESTAMPS' ? 'its own timestamps' : rm.minutesSource === 'FULL_DAY_SCHEDULE' ? "the day's scheduled duration (full-day segment)" : rm.minutesSource === 'FULL_DAY_DEFAULT' ? 'the full-day default — no schedule that day, nothing to deduct' : 'nothing — unknown'})
                        {rm.position === 'MID' && ' — mid-shift: deducted from scheduled hours, but the shift start/end were not moved, so this row is not held.'}
                        {rm.position === 'OUT_OF_WINDOW' && ' — falls outside the shift/OT window; this row is held.'}
                        {rm.position === 'OT_INTERNAL' && ' — inside the overtime block; deducted from scheduled hours and corrected by Rule 8, so this row is not held.'}
                        {rm.durationDisagreementMinutes !== undefined && (
                          <span className="block text-rose-700">
                            DURATION disagrees with its own timestamps by {rm.durationDisagreementMinutes}m — one of the two is wrong.
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedRow.details.varianceTrace.measurements.length > 0 ? (
                <div>
                  <div className="text-slate-500 mb-1 font-bold text-[11px]">Measured variances:</div>
                  <div className="space-y-1">
                    {selectedRow.details.varianceTrace.measurements.map((m, i) => (
                      <div key={i} className="font-mono text-[11px] bg-amber-50/60 border border-amber-100 p-1.5 rounded text-slate-700">
                        <strong className="text-amber-800">{m.label.replace(/_/g, ' ')}: {m.minutes} min</strong>
                        <span className="block">measured from {m.anchorLabel} @ {m.anchorTime || '—'}, compared to {m.comparedTo || '—'}</span>
                        <span className="block">
                          band: {m.bandDescription ? `${m.bandDescription} → ${m.bandAction}` : 'no band matched — no action'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="font-mono text-[11px] text-slate-500">No variance was measured on this row.</div>
              )}
            </div>
          )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
