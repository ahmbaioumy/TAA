import { Sparkles, Play, RefreshCw, CheckCircle2, HelpCircle, Wand2 } from 'lucide-react';

interface HeaderProps {
  activeTab: 'dashboard' | 'dataPreview' | 'results' | 'glossary' | 'leaveSegments' | 'config' | 'holdPolicy' | 'regression' | 'scenarios' | 'fieldReference';
  setActiveTab: (tab: 'dashboard' | 'dataPreview' | 'results' | 'glossary' | 'leaveSegments' | 'config' | 'holdPolicy' | 'regression' | 'scenarios' | 'fieldReference') => void;
  onLoadSampleData: () => void;
  onRunReconciliation: () => void;
  onOpenEmailWizard: () => void;
  hasCalculated: boolean;
  canCalculate: boolean;
  isCalculating: boolean;
  totalRecordsCount: number;
  disabledReason?: string;
  /** Hold Policy (doc/PRD.md §Hold Policy) — true when the saved policy differs from the one
   * used to produce the current output. Highlights Calculate as "Re-calculate needed". */
  isStale?: boolean;
}

export function Header({
  activeTab,
  setActiveTab,
  onLoadSampleData,
  onRunReconciliation,
  onOpenEmailWizard,
  hasCalculated,
  canCalculate,
  isCalculating,
  disabledReason,
  totalRecordsCount,
  isStale,
}: HeaderProps) {
  return (
    <header className="bg-white border-b border-slate-200 text-slate-900 sticky top-0 z-40 shadow-xs">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20 gap-3">
          {/* Mobile/tablet nav fallback — the sidebar is desktop-only (lg+),
              so below that breakpoint this select is the only way to reach
              any of the 6 sections. */}
          <select
            className="lg:hidden text-xs font-semibold border border-slate-200 rounded-lg px-2.5 py-2 bg-white text-slate-700 shadow-xs focus:outline-none focus:border-indigo-500 min-w-0"
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as typeof activeTab)}
            aria-label="Navigate to section"
          >
            <option value="dashboard">Upload & Reconcile</option>
            <option value="dataPreview">Uploaded Data</option>
            <option value="results">5-Category Results{hasCalculated ? ` (${totalRecordsCount})` : ''}</option>
            <option value="glossary">Segment Glossary</option>
            <option value="leaveSegments">Leave Segments</option>
            <option value="regression">Regression Suite</option>
            <option value="config">Config Registry</option>
            <option value="holdPolicy">Hold Policy{isStale ? ' (Re-calculate needed)' : ''}</option>
            <option value="fieldReference">Field Reference</option>
            <option value="scenarios">Scenario Guide</option>
          </select>

          <div className="hidden lg:block flex-1" />

          {/* Right-hand button cluster */}
          <div className="flex items-center gap-3">
            {/* Setup group — Regression Suite, kept visually separate from
                Config (which lives in the sidebar) and from the primary
                action CTAs. */}
            <div className="hidden sm:flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-xl p-1">
              <span className="pl-2 pr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 select-none">
                Setup
              </span>
              <button
                onClick={() => setActiveTab('regression')}
                title="Regression Suite"
                className={`p-2 rounded-lg transition-all ${
                  activeTab === 'regression'
                    ? 'bg-white text-emerald-600 shadow-xs border border-slate-200/80'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-white/70'
                }`}
              >
                <CheckCircle2 className="w-4 h-4" />
              </button>
              <button
                onClick={onOpenEmailWizard}
                title="Setup Email Config"
                className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-white/70 transition-all"
              >
                <Wand2 className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => setActiveTab('scenarios')}
              title="Scenario Guide — every case the app can encounter, and what it does"
              className={`p-2 rounded-lg border transition-all ${
                activeTab === 'scenarios'
                  ? 'bg-indigo-50 text-indigo-600 border-indigo-200'
                  : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200/70 hover:text-slate-800'
              }`}
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onLoadSampleData}
              className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 border border-slate-200 transition-all shadow-xs text-xs font-semibold"
              title="Load Sample Data — full test dataset with night shifts, flex staff, nursing hours, and holiday overtime (this is demo data, not a reset)"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>Sample Data</span>
            </button>
            <button
              onClick={onLoadSampleData}
              className="sm:hidden p-2 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 border border-slate-200 transition-all shadow-xs"
              title="Load Sample Data — full test dataset with night shifts, flex staff, nursing hours, and holiday overtime (this is demo data, not a reset)"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            </button>

            <button
              onClick={onRunReconciliation}
              disabled={!canCalculate || isCalculating}
              title={!canCalculate && disabledReason ? disabledReason : undefined}
              className={`px-5 py-2 rounded-lg text-xs font-semibold flex items-center space-x-2 transition-all ${
                canCalculate && !isCalculating
                  ? isStale
                    ? 'bg-rose-600 text-white hover:bg-rose-500 shadow-sm shadow-rose-200 animate-pulse'
                    : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
              }`}
            >
              {isCalculating ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Reconciling...</span>
                </>
              ) : canCalculate && isStale ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Re-calculate needed</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Reconcile (Calculate)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
