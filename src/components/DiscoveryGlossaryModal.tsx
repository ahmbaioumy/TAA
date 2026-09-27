import React, { useState } from 'react';
import { X, Plus, Check, HelpCircle, Shield, ArrowRight, Save, RotateCcw, AlertTriangle, Search } from 'lucide-react';
import { ConfigRegistry, GlossaryEntry, SegmentHoursRole } from '../types/taa';
import { lookupGlossary } from '../services/scheduleRecompute';

type GlossaryTab = SegmentHoursRole | 'UNCLASSIFIED';

interface DiscoveryGlossaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigRegistry;
  onSaveConfig: (updated: ConfigRegistry) => void;
  discoveredCodes: string[];
}

// Wrapper/content split so hooks are never conditional: the wrapper's early
// return means the content component — and its hooks — only mounts while
// open, which is also what re-seeds draft state fresh on every open.
export function DiscoveryGlossaryModal(props: DiscoveryGlossaryModalProps) {
  if (!props.isOpen) return null;
  return <DiscoveryGlossaryModalContent {...props} />;
}

function DiscoveryGlossaryModalContent({
  onClose,
  config,
  onSaveConfig,
  discoveredCodes,
}: DiscoveryGlossaryModalProps) {
  const [glossary, setGlossary] = useState<Record<string, GlossaryEntry>>({ ...config.segmentGlossary });
  const [newCodeName, setNewCodeName] = useState('');
  const [duplicateError, setDuplicateError] = useState('');
  // Phase 7: filtered-tab view (Addition / Removal / No Effect) over the same
  // flat glossary map — a pure view change, since a code can only ever have
  // one role (Record<string, GlossaryEntry> keyed by code already makes
  // two-bucket membership structurally impossible).
  // 'UNCLASSIFIED' is a UI-only 4th bucket — a discovered code with no key at
  // all in the glossary, not a real GlossaryEntry.role the engine understands.
  // Default straight onto it when the current upload has anything unresolved,
  // so opening this modal leads with the actionable work.
  const [activeRoleTab, setActiveRoleTab] = useState<GlossaryTab>(() =>
    discoveredCodes.some(code => !lookupGlossary(config.segmentGlossary, code)) ? 'UNCLASSIFIED' : 'ADDITION'
  );
  const [showSecondaryFlags, setShowSecondaryFlags] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');
  // Defect fix: this modal previously always unioned discovered codes with
  // EVERY key already in the shipped default glossary (~30 codes), so it was
  // never actually the lean "only what's real for this data" surface PRD
  // §4.14 describes — it just showed a smaller static dictionary. Default to
  // showing only codes genuinely discovered in the current upload; the full
  // configured list is one click away, not forced.
  const [showAllConfigured, setShowAllConfigured] = useState(discoveredCodes.length === 0);

  const allCodes = Array.from(
    new Set(showAllConfigured ? [...discoveredCodes, ...Object.keys(glossary)] : discoveredCodes)
  ).sort();

  // A code is only "classified" once it has a real glossary entry — falling
  // back to NO_EFFECT here (as this used to) makes an untouched code
  // indistinguishable from one the user deliberately marked zero-effect,
  // which is exactly the class of code the engine holds rows for. Routed
  // through the engine's own lookupGlossary so this view can never disagree
  // with what actually drives the recompute.
  const isUnclassified = (code: string) => !lookupGlossary(glossary, code);
  const codeDisplayRole = (code: string): GlossaryTab =>
    isUnclassified(code) ? 'UNCLASSIFIED' : (glossary[code]?.role || 'NO_EFFECT');

  const searchFilteredCodes = codeSearch.trim()
    ? allCodes.filter(code => code.toLowerCase().includes(codeSearch.trim().toLowerCase()))
    : allCodes;
  const filteredCodes = searchFilteredCodes.filter(code => codeDisplayRole(code) === activeRoleTab);

  const handleRoleChange = (code: string, role: SegmentHoursRole) => {
    setGlossary(prev => ({
      ...prev,
      [code]: {
        ...(prev[code] || { code }),
        role,
      },
    }));
  };

  const handleSecondaryFlagToggle = (code: string, field: 'isWriteOnlyAction') => {
    setGlossary(prev => ({
      ...prev,
      [code]: {
        ...(prev[code] || { code, role: 'NO_EFFECT' }),
        [field]: !prev[code]?.[field],
      },
    }));
  };

  // Leave identity/gating is no longer edited here — moved to the dedicated Leave
  // Segments page (config.nonWorkingDaySegmentCodes / leaveSegmentCodes). This reads
  // that authoritative source, not the deprecated per-entry isLeaveGateExclusion flag.
  const isNonWorking = (code: string) =>
    config.nonWorkingDaySegmentCodes.some(c => c.trim().toUpperCase() === code.trim().toUpperCase());

  const handleAddCustomCode = (e: React.FormEvent) => {
    e.preventDefault();
    // Guards a type, not a real UI path: the form that calls this is hidden
    // whenever activeRoleTab is 'UNCLASSIFIED' (see the form's render guard),
    // since "Unclassified" isn't a role a new code can be assigned into.
    if (activeRoleTab === 'UNCLASSIFIED') return;
    const clean = newCodeName.trim().toUpperCase();
    if (!clean) return;
    if (glossary[clean] || discoveredCodes.includes(clean)) {
      setDuplicateError(`Code "${clean}" already exists.`);
      return;
    }
    setGlossary(prev => ({
      ...prev,
      [clean]: {
        code: clean,
        role: activeRoleTab,
        description: 'User-added custom segment code',
      },
    }));
    setShowAllConfigured(true);
    setNewCodeName('');
    setDuplicateError('');
  };

  const handleSave = () => {
    onSaveConfig({
      ...config,
      segmentGlossary: glossary,
    });
    onClose();
  };

  // Calculate live sample additions / removals count
  const additionsList = allCodes.filter(c => glossary[c]?.role === 'ADDITION');
  const removalsList = allCodes.filter(c => glossary[c]?.role === 'REMOVAL');
  const unclassifiedList = allCodes.filter(isUnclassified);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-white">
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-lg font-bold text-slate-900">Discovery-Driven Segment Glossary (§4.14)</h3>
              <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold font-mono border border-indigo-200 uppercase tracking-wider">
                {allCodes.length} Codes
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Classify each segment code into <strong>Addition (+)</strong>, <strong>Removal (-)</strong>, or <strong>No Effect (0)</strong> to drive the scheduled-hours calculation.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Live Formula Preview Card */}
        <div className="p-4 bg-slate-50 border-b border-slate-200 text-xs">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-slate-600 font-semibold">Recomputed Net Scheduled Hours Formula:</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAllConfigured(!showAllConfigured)}
                className="text-slate-500 hover:text-slate-700 font-semibold cursor-pointer"
              >
                {showAllConfigured
                  ? `Show Only This Upload's ${discoveredCodes.length} Code(s)`
                  : `Show All ${Object.keys(glossary).length} Configured Codes`}
              </button>
              <button
                onClick={() => setShowSecondaryFlags(!showSecondaryFlags)}
                className="text-indigo-600 hover:text-indigo-700 font-semibold cursor-pointer"
              >
                {showSecondaryFlags ? 'Hide Advanced Flags' : 'Show Advanced Flags (Write-Only)'}
              </button>
            </div>
          </div>
          <div className="mt-2 p-3 rounded-xl bg-white border border-slate-200 font-mono text-[13px] flex items-center space-x-2 text-slate-800 overflow-x-auto shadow-2xs">
            <span className="text-indigo-600 font-bold">NetSchMinutes</span>
            <span className="text-slate-400">=</span>
            <span className="text-emerald-700 font-semibold">Σ({additionsList.slice(0, 4).join(', ')}{additionsList.length > 4 ? ` +${additionsList.length - 4}` : ''})</span>
            <span className="text-slate-400">−</span>
            <span className="text-rose-700 font-semibold">Σ({removalsList.slice(0, 4).join(', ')}{removalsList.length > 4 ? ` +${removalsList.length - 4}` : ''})</span>
          </div>
        </div>

        {/* Code Classification Table */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 transform -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter by seg code..."
              value={codeSearch}
              onChange={(e) => setCodeSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 shadow-xs"
            />
          </div>

          {/* Add Custom Code Form — deliberately above the tabs: the code lands
              directly in whichever tab is currently active (no separate role
              picker), so "which bucket am I adding to" is never ambiguous.
              Hidden on the Unclassified tab: that tab is a read-out of what
              this upload actually contains, not a place to author new codes
              — "Unclassified" isn't a role you can assign a new code to. */}
          {activeRoleTab !== 'UNCLASSIFIED' && (
            <div className="pb-1">
              <form onSubmit={handleAddCustomCode} className="flex items-center space-x-3">
                <input
                  type="text"
                  placeholder={`Add unlisted Code to "${activeRoleTab === 'ADDITION' ? 'Addition' : activeRoleTab === 'REMOVAL' ? 'Removal' : 'No Effect'}" (e.g. TRN-SPECIAL)`}
                  value={newCodeName}
                  onChange={(e) => {
                    setNewCodeName(e.target.value);
                    setDuplicateError('');
                  }}
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-indigo-500 uppercase font-mono shadow-2xs font-medium"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center space-x-1 transition-colors shadow-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Code</span>
                </button>
              </form>
              {duplicateError && (
                <p className="mt-2 text-[11px] font-semibold text-rose-600">{duplicateError}</p>
              )}
            </div>
          )}

          {/* Phase 7: Addition / Removal / No Effect / Unclassified filtered
              tabs — same pill-button pattern as ResultsView's category tabs,
              applied to this flat glossary map. Each tab shows only codes
              whose display role matches; a code exists in exactly one tab. */}
          <div className="flex items-center gap-1.5 border-b border-slate-200 pb-0">
            {([
              ['UNCLASSIFIED', `⚠ Unclassified (${unclassifiedList.length})`, 'red'],
              ['ADDITION', `+ Addition (${additionsList.length})`, 'emerald'],
              ['REMOVAL', `− Removal (${removalsList.length})`, 'rose'],
              ['NO_EFFECT', `No Effect (${allCodes.length - additionsList.length - removalsList.length - unclassifiedList.length})`, 'slate'],
            ] as const).map(([tabRole, label, color]) => (
              <button
                key={tabRole}
                type="button"
                onClick={() => setActiveRoleTab(tabRole)}
                className={`px-3 py-1.5 rounded-t-lg text-xs font-semibold transition-all cursor-pointer border border-b-0 -mb-px ${
                  activeRoleTab === tabRole
                    ? color === 'emerald'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : color === 'rose'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : color === 'red'
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                    : color === 'red' && unclassifiedList.length > 0
                      ? 'bg-transparent text-red-600 border-transparent hover:text-red-700 hover:bg-red-50'
                      : 'bg-transparent text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-12 text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 pb-2 border-b border-slate-200">
            <div className="col-span-4">Segment Code</div>
            <div className="col-span-5">Hours Calculation Role</div>
            <div className="col-span-3 text-right">Status / Flags</div>
          </div>

          {filteredCodes.length === 0 && (
            <div className="py-6 text-center text-xs text-slate-400">No matching codes in this tab.</div>
          )}

          <div className="divide-y divide-slate-100">
            {filteredCodes.map(code => {
              // Deliberately no NO_EFFECT fallback here: an unclassified code
              // has no entry at all, and none of the three role buttons below
              // should render as pre-selected for it — that's the visible
              // difference between "untouched" and "explicitly No Effect".
              const entry = glossary[code];
              const isDiscovered = discoveredCodes.includes(code);

              return (
                <div key={code} className="py-2.5 px-3 grid grid-cols-12 items-center hover:bg-slate-50 rounded-xl transition-colors">
                  <div className="col-span-4 flex items-center space-x-2">
                    <span className="font-mono text-sm font-bold text-slate-900">{code}</span>
                    {isDiscovered && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 font-sans font-semibold border border-sky-200">
                        In Upload
                      </span>
                    )}
                  </div>

                  {/* Role Selector 3-way toggle */}
                  <div className="col-span-5 flex items-center space-x-1.5">
                    <button
                      type="button"
                      onClick={() => handleRoleChange(code, 'ADDITION')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        entry?.role === 'ADDITION'
                          ? 'bg-emerald-600 text-white shadow-xs'
                          : 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 border border-slate-200'
                      }`}
                    >
                      + Addition
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRoleChange(code, 'REMOVAL')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        entry?.role === 'REMOVAL'
                          ? 'bg-rose-600 text-white shadow-xs'
                          : 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 border border-slate-200'
                      }`}
                    >
                      − Removal
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRoleChange(code, 'NO_EFFECT')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        entry?.role === 'NO_EFFECT'
                          ? 'bg-slate-700 text-white shadow-xs'
                          : 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 border border-slate-200'
                      }`}
                    >
                      No Effect (0)
                    </button>
                  </div>

                  {/* Secondary Flags */}
                  <div className="col-span-3 flex items-center justify-end space-x-2 text-xs">
                    {isNonWorking(code) && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 font-sans font-semibold"
                        title="Managed on the Leave Segments page — read-only here"
                      >
                        Non-Working
                      </span>
                    )}
                    {showSecondaryFlags ? (
                      <label className="flex items-center space-x-1 text-[11px] text-slate-700 cursor-pointer font-medium">
                        <input
                          type="checkbox"
                          checked={!!entry?.isWriteOnlyAction}
                          onChange={() => handleSecondaryFlagToggle(code, 'isWriteOnlyAction')}
                          className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0"
                        />
                        <span>Write-Only</span>
                      </label>
                    ) : (
                      <span className="text-slate-500 font-mono text-[11px]">
                        {entry?.isWriteOnlyAction ? 'Write-Only' : ''}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            One glossary answer drives net scheduled hours, leave-gates, and bucket rules.
          </span>
          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center space-x-1.5 shadow-sm shadow-indigo-200 transition-all cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>Save & Apply Classifications</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
