import React, { useMemo, useState } from 'react';
import { Save, RotateCcw, RefreshCw, Info } from 'lucide-react';
import { ConfigRegistry, ReconciliationRow } from '../types/taa';
import {
  ActionGroup,
  StaffCategory,
  cellId,
  classifyHold,
  holdPolicyLayout,
} from '../services/holdPolicy';

interface HoldPolicyViewProps {
  config: ConfigRegistry;
  /** Rows from the last run (for the "N rows last run" hover counts) — null before any
   * calculation has happened, in which case every count shows 0/"No rows last run". */
  rows: ReconciliationRow[] | null;
  isStale: boolean;
  onSave: (released: string[]) => void;
  onRecalculate: () => void;
}

/** Would `row` release under a candidate `released` set — same rule applyHoldPolicy uses
 * (every ruleKey classifyHold reports must be released), used here ONLY for the live
 * preview counts (never mutates anything). */
function wouldRelease(row: ReconciliationRow, released: ReadonlySet<string>): boolean {
  const cell = classifyHold(row);
  if (cell === null || cell === 'LOCKED') return false;
  return cell.ruleKeys.every(k => released.has(cellId(cell.category, k, cell.actionGroup)));
}

export function HoldPolicyView({ config, rows, isStale, onSave, onRecalculate }: HoldPolicyViewProps) {
  const layout = useMemo(() => holdPolicyLayout(), []);
  const savedReleased = config.holdPolicy?.released || [];
  const [draft, setDraft] = useState<Set<string>>(() => new Set(savedReleased));
  const [tab, setTab] = useState<StaffCategory>(layout.tabs[0]?.category || 'OPS');
  const [showLocked, setShowLocked] = useState(false);

  const heldRows = useMemo(() => (rows || []).filter(r => !!r.holdReason), [rows]);
  const heldByCategory = useMemo(() => {
    const m = new Map<StaffCategory, number>();
    for (const r of heldRows) m.set(r.TAA_TIER, (m.get(r.TAA_TIER) || 0) + 1);
    return m;
  }, [heldRows]);

  const heldAfterDraft = useMemo(() => heldRows.filter(r => !wouldRelease(r, draft)).length, [heldRows, draft]);

  const savedSet = useMemo(() => new Set(savedReleased), [savedReleased]);
  const isUnsaved = useMemo(() => {
    if (draft.size !== savedSet.size) return true;
    for (const id of draft) if (!savedSet.has(id)) return true;
    return false;
  }, [draft, savedSet]);

  const cellCount = (category: StaffCategory, ruleKey: string, action: ActionGroup): number =>
    heldRows.filter(r => {
      const c = classifyHold(r);
      return c !== null && c !== 'LOCKED' && c.category === category && c.actionGroup === action && c.ruleKeys.includes(ruleKey as any);
    }).length;

  const cellReleasedCount = (category: StaffCategory, ruleKey: string, action: ActionGroup): number =>
    heldRows.filter(r => {
      const c = classifyHold(r);
      return c !== null && c !== 'LOCKED' && c.category === category && c.actionGroup === action && c.ruleKeys.includes(ruleKey as any) && wouldRelease(r, draft);
    }).length;

  const toggleCell = (ruleKey: string, action: ActionGroup, nextHeld: boolean) => {
    setDraft(prev => {
      const next = new Set(prev);
      const id = cellId(tab, ruleKey, action);
      if (nextHeld) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleColumn = (action: ActionGroup, nextHeld: boolean) => {
    setDraft(prev => {
      const next = new Set(prev);
      for (const row of layout.rows) {
        const id = cellId(tab, row.ruleKey, action);
        if (nextHeld) next.delete(id); else next.add(id);
      }
      return next;
    });
  };

  const columnState = (action: ActionGroup): 'all-held' | 'all-released' | 'mixed' => {
    let held = 0;
    for (const row of layout.rows) {
      // `draft` lists RELEASED cells — a cell is held when it is NOT in the set.
      if (!draft.has(cellId(tab, row.ruleKey, action))) held += 1;
    }
    if (held === 0) return 'all-released';
    if (held === layout.rows.length) return 'all-held';
    return 'mixed';
  };

  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, typeof layout.rows>();
    for (const row of layout.rows) {
      if (!byGroup.has(row.group)) { byGroup.set(row.group, []); order.push(row.group); }
      byGroup.get(row.group)!.push(row);
    }
    return order.map(g => [g, byGroup.get(g)!] as const);
  }, [layout.rows]);

  const totalRows = rows ? rows.length : 0;
  const pct = totalRows > 0 ? Math.round((heldAfterDraft * 100) / totalRows) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-slate-900 flex items-center gap-1.5">
            Hold Policy
            <span
              className="inline-flex items-center justify-center w-4.5 h-4.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold cursor-help"
              title="Ticked = hold for review. Untick to let those rows go straight to the output. New hold reasons appear here automatically, ticked. A Cognos-mismatch row is released only if every disagreeing column is unticked; late/early gaps equal to a shift move count under Shift. $ = action sends corrections to ASPECT (no extra prompt; released rows are marked in Results)."
            >
              <Info className="w-3 h-3" />
            </span>
          </h1>
          <span className="text-xs text-slate-500">
            Held <strong className="text-slate-800">{heldRows.length}</strong> &rarr;{' '}
            <strong className="text-emerald-700">{heldAfterDraft}</strong> ({pct}%)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSave([...draft])}
            title={isUnsaved ? 'Unsaved changes — click to save' : 'Saved'}
            className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-all ${
              isUnsaved
                ? 'border-rose-300 bg-rose-50 text-rose-600 animate-pulse'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
            }`}
          >
            <Save className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setDraft(new Set())}
            title="Reset: hold everything"
            className="flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-100"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onRecalculate}
            title={isStale ? 'Policy changed after the last calculation — click to re-calculate. Exports are disabled until then.' : 'Results match the saved policy'}
            className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-all ${
              isStale
                ? 'border-rose-300 bg-rose-50 text-rose-600 animate-pulse'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
            }`}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-1.5">
        {layout.tabs.map(t => (
          <button
            key={t.category}
            type="button"
            onClick={() => setTab(t.category)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
              tab === t.category
                ? 'bg-indigo-50 text-indigo-600 border-indigo-200'
                : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label} <span className="ml-1 font-medium opacity-70">{heldByCategory.get(t.category) || 0}</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse min-w-[720px]">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="text-left px-3 py-2 w-64">Hold reason</th>
                {layout.columns.map(col => {
                  const state = columnState(col.action);
                  return (
                    <th key={col.action} className="px-2 py-2 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <input
                          type="checkbox"
                          checked={state !== 'all-released'}
                          ref={el => { if (el) el.indeterminate = state === 'mixed'; }}
                          onChange={e => toggleColumn(col.action, e.target.checked)}
                          title={`Tick / untick the whole ${col.label} column`}
                          className="w-4 h-4 accent-indigo-600 cursor-pointer"
                        />
                        <span>{col.label} {col.payAffecting && <span className="text-amber-600">$</span>}</span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {groups.map(([groupName, groupRows]) => (
                <React.Fragment key={groupName}>
                  <tr className="bg-slate-50">
                    <td colSpan={layout.columns.length + 1} className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      {groupName}
                    </td>
                  </tr>
                  {groupRows.map(row => (
                    <tr key={row.ruleKey} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-700 cursor-help" title={row.description}>
                        {row.label}
                      </td>
                      {layout.columns.map(col => {
                        const held = !draft.has(cellId(tab, row.ruleKey, col.action));
                        const n = cellCount(tab, row.ruleKey, col.action);
                        const relN = cellReleasedCount(tab, row.ruleKey, col.action);
                        const tip = n === 0
                          ? 'No rows last run'
                          : held
                            ? `${n} row(s) held last run`
                            : `${relN} of ${n} row(s) released (a row stays held if another column also disagrees)`;
                        return (
                          <td key={col.action} className={`px-2 py-2 text-center ${!held && relN > 0 ? 'bg-emerald-50' : ''}`}>
                            <span className="relative inline-flex" title={`${row.label} · ${col.label}: ${tip}`}>
                              <input
                                type="checkbox"
                                checked={held}
                                onChange={e => toggleCell(row.ruleKey, col.action, e.target.checked)}
                                className="w-4 h-4 accent-indigo-600 cursor-pointer"
                              />
                              {n > 0 && (
                                <span className={`absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full ${!held && relN > 0 ? 'bg-emerald-500' : 'bg-indigo-500'}`} />
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <details open={showLocked} onToggle={e => setShowLocked((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-500">
            &#128274; Always held &mdash; {layout.locked.length} evidence reason(s)
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full text-xs">
              <tbody>
                {layout.locked.map(l => (
                  <tr key={l.reason} className="border-b border-slate-50">
                    <td className="px-3 py-2 text-slate-400 font-medium cursor-help" title={l.description}>
                      &#128274; {l.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}
