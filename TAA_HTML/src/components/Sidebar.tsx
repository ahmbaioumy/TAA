import React from 'react';
import {
  Shield,
  UploadCloud,
  Table2,
  BarChart3,
  BookOpen,
  CalendarOff,
  Sliders,
  Upload,
  Download,
  Trash2,
  ShieldAlert,
  PanelLeftClose,
  PanelLeftOpen,
  FileSearch,
  ListChecks,
} from 'lucide-react';

type Tab = 'dashboard' | 'dataPreview' | 'results' | 'glossary' | 'leaveSegments' | 'config' | 'holdPolicy' | 'regression' | 'scenarios' | 'fieldReference';

interface SidebarProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  hasCalculated: boolean;
  totalRecordsCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onExportConfig: () => void;
  onImportConfigFile: (file: File) => void;
  onResetApp: () => void;
  onHardReset: () => void;
  /** Hold Policy (doc/PRD.md §Hold Policy) — true when the saved policy differs from the one
   * used to produce the current output (isResultStale). Shows a small red dot on the nav item. */
  isStale?: boolean;
}

export function Sidebar({
  activeTab,
  setActiveTab,
  hasCalculated,
  totalRecordsCount,
  isCollapsed,
  onToggleCollapsed,
  onExportConfig,
  onImportConfigFile,
  onResetApp,
  onHardReset,
  isStale,
}: SidebarProps) {
  const navBtnClass = (tab: Tab) =>
    `w-full flex items-center rounded-lg text-xs font-medium transition-all ${
      isCollapsed ? 'justify-center px-0 py-2.5' : 'space-x-2.5 px-3 py-2.5'
    } ${
      activeTab === tab
        ? 'bg-indigo-50 text-indigo-600 font-bold border border-indigo-200/70'
        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent'
    }`;

  const iconBtnClass =
    'flex items-center justify-center rounded-lg p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-slate-200 shadow-xs transition-all cursor-pointer';

  const handleImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImportConfigFile(file);
    e.target.value = '';
  };

  return (
    <aside
      className={`hidden lg:flex flex-col shrink-0 sticky top-0 h-screen bg-white border-r border-slate-200 transition-all ${
        isCollapsed ? 'w-[72px]' : 'w-60'
      }`}
    >
      {/* Brand + collapse toggle */}
      <div className={`flex items-center h-20 border-b border-slate-200 ${isCollapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
        <div
          className={`flex items-center cursor-pointer ${isCollapsed ? '' : 'space-x-2.5'}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-sm shadow-indigo-200">
            <Shield className="w-4.5 h-4.5 text-white" />
          </div>
          {!isCollapsed && (
            <span className="font-bold text-sm tracking-tight text-slate-900 leading-tight">
              TAA Workspace
            </span>
          )}
        </div>
        {!isCollapsed && (
          <button
            onClick={onToggleCollapsed}
            title="Collapse sidebar"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all cursor-pointer"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>
      {isCollapsed && (
        <button
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          className="flex items-center justify-center py-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 border-b border-slate-200 transition-all cursor-pointer"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {/* Main workflow nav */}
      <nav className={`flex flex-col gap-1 pt-4 ${isCollapsed ? 'px-2' : 'px-3'}`}>
        <button onClick={() => setActiveTab('dashboard')} className={navBtnClass('dashboard')} title="Upload & Reconcile">
          <UploadCloud className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Upload & Reconcile</span>}
        </button>
        <button onClick={() => setActiveTab('dataPreview')} className={navBtnClass('dataPreview')} title="Uploaded Data">
          <Table2 className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Uploaded Data</span>}
        </button>
        <button onClick={() => setActiveTab('results')} className={navBtnClass('results')} title="5-Category Results">
          <BarChart3 className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span className="flex-1 text-left">Results</span>}
          {hasCalculated && (
            <span className={`px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-600 text-white font-mono font-bold ${isCollapsed ? 'absolute translate-x-3 -translate-y-3' : ''}`}>
              {totalRecordsCount}
            </span>
          )}
        </button>
      </nav>

      <div className="flex-1" />

      {/* Secondary nav */}
      <nav className={`flex flex-col gap-1 pb-3 ${isCollapsed ? 'px-2' : 'px-3'}`}>
        <button onClick={() => setActiveTab('glossary')} className={navBtnClass('glossary')} title="Segment Glossary">
          <BookOpen className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Segment Glossary</span>}
        </button>
        <button onClick={() => setActiveTab('leaveSegments')} className={navBtnClass('leaveSegments')} title="Leave Segments">
          <CalendarOff className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Leave Segments</span>}
        </button>
        <button onClick={() => setActiveTab('config')} className={navBtnClass('config')} title="Config Registry">
          <Sliders className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Config Registry</span>}
        </button>
        <button onClick={() => setActiveTab('holdPolicy')} className={navBtnClass('holdPolicy')} title="Hold Policy">
          <ListChecks className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span className="flex-1 text-left">Hold Policy</span>}
          {isStale && <span className={`w-2 h-2 rounded-full bg-rose-500 ${isCollapsed ? 'absolute translate-x-3 -translate-y-3' : ''}`} />}
        </button>
        <button onClick={() => setActiveTab('fieldReference')} className={navBtnClass('fieldReference')} title="Field Reference">
          <FileSearch className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span>Field Reference</span>}
        </button>
      </nav>

      {/* Quick config actions + app reset */}
      <div className={`flex items-center gap-1.5 py-3 border-t border-slate-200 ${isCollapsed ? 'flex-col px-2' : 'px-3'}`}>
        <label className={iconBtnClass} title="Import Config (JSON)">
          <Upload className="w-3.5 h-3.5" />
          <input type="file" accept=".json" className="hidden" onChange={handleImportChange} />
        </label>
        <button onClick={onExportConfig} className={iconBtnClass} title="Export Config (JSON)">
          <Download className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onResetApp}
          className={`${iconBtnClass} text-rose-500 hover:text-rose-700 hover:bg-rose-50 border-rose-200`}
          title="Reset App (clears loaded files & results)"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onHardReset}
          className={`${iconBtnClass} text-amber-600 hover:text-amber-800 hover:bg-amber-50 border-amber-300`}
          title="Hard Reset (also clears saved Config Registry customizations & UI preferences — full factory reset)"
        >
          <ShieldAlert className="w-3.5 h-3.5" />
        </button>
      </div>
    </aside>
  );
}
