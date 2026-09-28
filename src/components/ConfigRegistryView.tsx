import React, { useState } from 'react';
import {
  Sliders,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Info,
  Mail,
} from 'lucide-react';
import { ConfigRegistry, PolicyRuleItem, RoleTier, TaaActionCode, CommunicationRule, CognosDropRule, EmailTemplateKey, SectionMailboxRule, EmployeeManagerRule } from '../types/taa';
import { resetConfigRegistry, validatePolicyBands, parseSectionMailboxCsv, exportSectionMailboxCsv, parseEmployeeManagerCsv, exportEmployeeManagerCsv, validateConfigForRun, implementedActionsForSegmentType, effectiveCmsCoverageGraceMinutes } from '../services/configRegistry';
import { decodeFileBuffer } from '../services/parsers';
import { EmailZipSettings } from './EmailZipSettings';
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATE_LABELS, EMAIL_TEMPLATE_PLACEHOLDERS_BY_KEY } from '../services/emailDrafts';
import { BandIssuesModal } from './BandIssuesModal';

interface ConfigRegistryViewProps {
  config: ConfigRegistry;
  onSaveConfig: (updated: ConfigRegistry) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function ConfigRegistryView({ config, onSaveConfig, onDirtyChange }: ConfigRegistryViewProps) {
  const [localConfig, setLocalConfig] = useState<ConfigRegistry>({ ...config });
  const [activeSubTab, setActiveSubTab] = useState<'policy' | 'flex' | 'keywords' | 'covers' | 'emails'>('policy');
  const [showResetModal, setShowResetModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isBandIssuesModalOpen, setIsBandIssuesModalOpen] = useState(false);
  const configValidationIssues = React.useMemo(() => validateConfigForRun(localConfig), [localConfig]);

  // Defect fix: edits here were previously lost silently if the user switched
  // tabs before clicking Save (this component unmounts on tab-away and
  // re-initializes from the `config` prop next time). Report dirty state up
  // so App.tsx can warn before discarding.
  React.useEffect(() => {
    onDirtyChange?.(JSON.stringify(localConfig) !== JSON.stringify(config));
  }, [localConfig, config]);
  React.useEffect(() => {
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleSave = () => {
    if (configValidationIssues.length > 0) {
      showToast('Fix unsafe configuration values before saving.');
      return;
    }
    onSaveConfig(localConfig);
    showToast('Configuration successfully saved to local registry!');
  };

  const handleConfirmReset = () => {
    const fresh = resetConfigRegistry();
    setLocalConfig(fresh);
    onSaveConfig(fresh);
    setShowResetModal(false);
    showToast('Reset to default shipped configurations');
  };

  // Rule item updater
  const handleUpdateRule = (ruleId: string, updates: Partial<PolicyRuleItem>) => {
    setLocalConfig(prev => ({
      ...prev,
      policyRules: prev.policyRules.map(r => (r.id === ruleId ? { ...r, ...updates } : r)),
    }));
  };

  // Cognos drop-rule (§6.6) row helpers — each row is an independent
  // {column, values[]} pair; a Cognos row is dropped if ANY row's column
  // matches ANY of that row's wildcard values.
  const handleAddCognosDropRule = (rule: CognosDropRule = { column: '', values: [] }) => {
    setLocalConfig(prev => ({ ...prev, cognosDropPatterns: [...prev.cognosDropPatterns, rule] }));
  };
  const handleUpdateCognosDropRule = (index: number, updates: Partial<CognosDropRule>) => {
    setLocalConfig(prev => ({
      ...prev,
      cognosDropPatterns: prev.cognosDropPatterns.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    }));
  };
  const handleRemoveCognosDropRule = (index: number) => {
    setLocalConfig(prev => ({
      ...prev,
      cognosDropPatterns: prev.cognosDropPatterns.filter((_, i) => i !== index),
    }));
  };

  // Section -> OPS mailbox routing rows — mirrors the cognosDropPatterns
  // add/update/remove pattern above.
  const handleAddSectionMailboxRule = (rule: SectionMailboxRule = { section: '', mailbox: '' }) => {
    setLocalConfig(prev => ({ ...prev, sectionMailboxMap: [...prev.sectionMailboxMap, rule] }));
  };
  const handleUpdateSectionMailboxRule = (index: number, updates: Partial<SectionMailboxRule>) => {
    setLocalConfig(prev => ({
      ...prev,
      sectionMailboxMap: prev.sectionMailboxMap.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    }));
  };
  const handleRemoveSectionMailboxRule = (index: number) => {
    setLocalConfig(prev => ({
      ...prev,
      sectionMailboxMap: prev.sectionMailboxMap.filter((_, i) => i !== index),
    }));
  };
  // CSV import upserts by Section (case-insensitive/trimmed): existing
  // sections get their mailbox updated, new sections get appended. Manual
  // row deletion in the table above is how stale entries get removed.
  const handleImportSectionMailboxCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const imported = parseSectionMailboxCsv(text);
        setLocalConfig(prev => {
          const bySection = new Map(prev.sectionMailboxMap.map(r => [r.section.trim().toUpperCase(), r.mailbox]));
          imported.forEach(r => bySection.set(r.section, r.mailbox));
          return { ...prev, sectionMailboxMap: Array.from(bySection.entries()).map(([section, mailbox]) => ({ section, mailbox })) };
        });
        showToast(`Imported ${imported.length} section mailbox mapping(s)`);
      } catch (err) {
        alert(`Invalid Section/Mailbox CSV: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };
  const handleExportSectionMailboxCsv = () => {
    const csv = exportSectionMailboxCsv(localConfig.sectionMailboxMap);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TAA_Section_Mailbox_Map.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Employee -> Manager mailbox rows (§4.7 CC) — same add/update/remove/CSV
  // pattern as the Section -> OPS Mailbox rows above. Optional: an employee
  // with no row here simply drafts with no CC, never an error.
  const handleAddEmployeeManagerRule = (rule: EmployeeManagerRule = { empId: '', managerEmail: '' }) => {
    setLocalConfig(prev => ({ ...prev, employeeManagerMap: [...prev.employeeManagerMap, rule] }));
  };
  const handleUpdateEmployeeManagerRule = (index: number, updates: Partial<EmployeeManagerRule>) => {
    setLocalConfig(prev => ({
      ...prev,
      employeeManagerMap: prev.employeeManagerMap.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    }));
  };
  const handleRemoveEmployeeManagerRule = (index: number) => {
    setLocalConfig(prev => ({
      ...prev,
      employeeManagerMap: prev.employeeManagerMap.filter((_, i) => i !== index),
    }));
  };
  // Decoded via decodeFileBuffer (BOM/heuristic UTF-16 detection), not
  // FileReader.readAsText — an export produced the same way the ASPECT
  // identity file is (UTF-16) would otherwise silently decode as mojibake.
  const handleImportEmployeeManagerCsv = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const text = decodeFileBuffer(buffer);
      const imported = parseEmployeeManagerCsv(text);
      setLocalConfig(prev => {
        const byEmpId = new Map(prev.employeeManagerMap.map(r => [r.empId.trim(), r.managerEmail]));
        imported.forEach(r => byEmpId.set(r.empId, r.managerEmail));
        return { ...prev, employeeManagerMap: Array.from(byEmpId.entries()).map(([empId, managerEmail]) => ({ empId, managerEmail })) };
      });
      showToast(`Imported ${imported.length} employee/manager mapping(s)`);
    } catch (err) {
      alert(`Invalid EmpId/ManagerEmail CSV: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const handleExportEmployeeManagerCsv = () => {
    const csv = exportEmployeeManagerCsv(localConfig.employeeManagerMap);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TAA_Employee_Manager_Map.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUpdateEmailTemplate = (key: EmailTemplateKey, updates: Partial<{ subject: string; body: string }>) => {
    setLocalConfig(prev => ({
      ...prev,
      emailTemplates: {
        ...prev.emailTemplates,
        [key]: {
          ...prev.emailTemplates[key],
          ...updates,
        },
      },
    }));
  };

  const handleResetEmailTemplate = (key: EmailTemplateKey) => {
    setLocalConfig(prev => ({
      ...prev,
      emailTemplates: {
        ...prev.emailTemplates,
        [key]: DEFAULT_EMAIL_TEMPLATES[key],
      },
    }));
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification — sits above the bottom-right action cluster */}
      {toastMessage && (
        <div className="fixed bottom-24 right-6 z-50 bg-indigo-600 text-white px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold flex items-center space-x-2 border border-indigo-400">
          <CheckCircle2 className="w-4 h-4" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs">
        <div className="flex items-center space-x-2">
          <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-base font-bold text-slate-900">Central Config Registry (§6.4)</h3>
              <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold font-mono border border-indigo-200 uppercase tracking-wider">
                Zero Hardcode Engine
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Every rule threshold, keyword list, flex parameter, and drop pattern is auditable and configurable through this panel.
            </p>
          </div>
        </div>
      </div>

      {configValidationIssues.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 shadow-xs text-xs text-rose-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-bold text-rose-900">Unsafe configuration values</div>
              <div className="mt-1 space-y-1 font-mono text-[11px]">
                {configValidationIssues.map(issue => (
                  <div key={`${issue.kind}-${issue.field}`}>{issue.field}: {issue.message}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating action cluster — Reset/Save, icon-only with hover
          tooltips, fixed to the bottom-right so Save stays reachable
          without scrolling back up on the longer sub-tabs below. Import/
          Export live in the left sidebar only now (same underlying
          exportConfigToJson/importConfigFromJson, operating on the full
          config — duplicating them here just clutters the page). */}
      <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
        <button
          onClick={() => setShowResetModal(true)}
          title="Reset Defaults"
          className="p-3 rounded-full bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 shadow-lg transition-all"
        >
          <RotateCcw className="w-4 h-4" />
        </button>

        <button
          onClick={handleSave}
          disabled={configValidationIssues.length > 0}
          title={configValidationIssues.length > 0 ? 'Fix unsafe values before saving' : 'Save Changes'}
          className="p-3.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-200 transition-all disabled:bg-slate-300 disabled:shadow-none disabled:cursor-not-allowed"
        >
          <Save className="w-4 h-4" />
        </button>
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center space-x-2 border-b border-slate-200 text-xs pb-px">
        <button
          onClick={() => setActiveSubTab('policy')}
          className={`px-4 py-2.5 font-medium border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'policy'
              ? 'border-indigo-600 text-indigo-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-900'
          }`}
        >
          1. Policy Rules Matrix (§4.1)
        </button>
        <button
          onClick={() => setActiveSubTab('flex')}
          className={`px-4 py-2.5 font-medium border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'flex'
              ? 'border-indigo-600 text-indigo-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-900'
          }`}
        >
          2. Flex Staff Policy (§4.8)
        </button>
        <button
          onClick={() => setActiveSubTab('keywords')}
          className={`px-4 py-2.5 font-medium border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'keywords'
              ? 'border-indigo-600 text-indigo-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-900'
          }`}
        >
          3. Keyword Classification & Filters (§4.2)
        </button>
        <button
          onClick={() => setActiveSubTab('covers')}
          className={`px-4 py-2.5 font-medium border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'covers'
              ? 'border-indigo-600 text-indigo-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-900'
          }`}
        >
          4. Cover & Join Parameters (§4.11)
        </button>
        <button
          onClick={() => setActiveSubTab('emails')}
          className={`px-4 py-2.5 font-medium border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'emails'
              ? 'border-indigo-600 text-indigo-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-900'
          }`}
        >
          5. Email Drafts
        </button>
      </div>

      {/* Sub-Tab 1: Policy Rules Matrix */}
      {activeSubTab === 'policy' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-900">8 Rule Categories × 2 Role Tiers</h4>
            <span className="text-xs text-slate-500">
              Source: <code className="text-indigo-600 font-mono bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">Rules to be taken.xlsx</code> (Authoritative)
            </span>
          </div>

          {/* Band-table validation. lookupPolicyRule() returns the FIRST band whose range
              contains the measured minutes, so two overlapping bands resolve by typing
              order — which can silently hand someone an ABSENT where the table says
              "late + cover". These bands are editable, so they are checked every render. */}
          {(() => {
            const bandIssues = validatePolicyBands(localConfig.policyRules);
            if (bandIssues.length === 0) {
              return (
                <div className="mb-4 text-xs rounded-xl border border-emerald-200 bg-emerald-50/70 text-emerald-800 px-3.5 py-2.5">
                  Band check passed — no overlapping, inverted, or uncovered minute ranges. Every measured
                  variance maps to exactly one band.
                </div>
              );
            }
            return (
              <>
                <button
                  type="button"
                  onClick={() => setIsBandIssuesModalOpen(true)}
                  className="mb-4 w-full text-left text-xs rounded-xl border border-amber-300 bg-amber-50/80 px-3.5 py-2.5 hover:bg-amber-100/80"
                >
                  <div className="font-bold text-amber-900">
                    {bandIssues.length} problem{bandIssues.length === 1 ? '' : 's'} found in the band table — fix before running payroll corrections
                  </div>
                  <div className="mt-0.5 text-amber-700">Click to view details</div>
                </button>
                <BandIssuesModal
                  isOpen={isBandIssuesModalOpen}
                  onClose={() => setIsBandIssuesModalOpen(false)}
                  issues={bandIssues}
                />
              </>
            );
          })()}

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
                <tr>
                  <th className="py-3 px-3.5">Rule Type</th>
                  <th className="py-3 px-3.5">Role Tier</th>
                  <th className="py-3 px-3.5">Min Min</th>
                  <th className="py-3 px-3.5">Max Min</th>
                  <th className="py-3 px-3.5">TAA Action Code</th>
                  <th className="py-3 px-3.5">Communication Rule</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {localConfig.policyRules.map((rule) => (
                  <tr key={rule.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-3.5 text-slate-800 font-sans font-medium">{rule.segmentType}</td>
                    <td className="py-2.5 px-3.5">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-sans font-semibold border ${
                        rule.tier === 'OFFICER_PLUS' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}>
                        {rule.tier}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5">
                      <input
                        type="number"
                        value={rule.minMinutes !== undefined ? rule.minMinutes : ''}
                        onChange={(e) => handleUpdateRule(rule.id, { minMinutes: parseInt(e.target.value, 10) || 0 })}
                        className="w-16 px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-slate-800 focus:outline-none focus:border-indigo-500 text-xs"
                      />
                    </td>
                    <td className="py-2.5 px-3.5">
                      <input
                        type="number"
                        value={rule.maxMinutes !== undefined ? rule.maxMinutes : ''}
                        onChange={(e) => handleUpdateRule(rule.id, { maxMinutes: parseInt(e.target.value, 10) || 99999 })}
                        className="w-20 px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-slate-800 focus:outline-none focus:border-indigo-500 text-xs"
                      />
                    </td>
                    <td className="py-2.5 px-3.5">
                      <select
                        value={rule.action}
                        onChange={(e) => handleUpdateRule(rule.id, { action: e.target.value as TaaActionCode })}
                        className="px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-slate-800 focus:outline-none focus:border-indigo-500 text-xs"
                        title="Only actions this segment type's engine code actually dispatches on are offered — see IMPLEMENTED_ACTIONS_BY_SEGMENT_TYPE."
                      >
                        {/* Restricted to what reconciliationEngine.ts actually implements for this
                            rule's segmentType (past defect: any of the 9 TaaActionCode values was
                            selectable for every rule, and an unimplemented one silently charged
                            variance with zero correction output). */}
                        {implementedActionsForSegmentType(rule.segmentType).map(action => (
                          <option key={action} value={action}>{action}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2.5 px-3.5">
                      <select
                        value={rule.communication}
                        onChange={(e) => handleUpdateRule(rule.id, { communication: e.target.value as CommunicationRule })}
                        className="px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-slate-800 focus:outline-none focus:border-indigo-500 text-xs"
                      >
                        <option value="NA">NA (No Email)</option>
                        <option value="EMAIL_OPS">EMAIL_OPS</option>
                        <option value="EMAIL_STAFF_CC_MANAGER">EMAIL_STAFF_CC_MANAGER</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sub-Tab 2: Flex Parameters */}
      {activeSubTab === 'flex' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div>
            <h4 className="text-sm font-bold text-slate-900">Flex Staff Policy Configuration (§4.8)</h4>
            <p className="text-xs text-slate-500 mt-1">
              Governs the absolute 10:00 wall-clock cutoff, shift update pairs, and over-cutoff full-variance charging.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Absolute Wall-Clock Cutoff Time:
              </label>
              <input
                type="time"
                step={60}
                value={localConfig.flexCutoffTime}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, flexCutoffTime: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Flex staff arriving after this wall-clock time trigger both a Shift Update (clamped to cutoff) and Late+Cover.
              </p>
            </div>

            <div className="bg-amber-50 p-4 rounded-xl border border-amber-300 space-y-2.5">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.reducedOfficeHoursEnabled}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, reducedOfficeHoursEnabled: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Reduced Office Hours (Flex, one weekday)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">Day of week</label>
                  <select
                    value={localConfig.reducedOfficeHoursDayOfWeek}
                    onChange={(e) => setLocalConfig(prev => ({ ...prev, reducedOfficeHoursDayOfWeek: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
                  >
                <option value="0">Sunday</option>
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">Required office hours</label>
                  <input
                    type="number"
                    min={0.5}
                    max={24}
                    step={0.5}
                    value={localConfig.reducedOfficeHoursRequiredMinutes / 60}
                    onChange={(e) => setLocalConfig(prev => ({ ...prev, reducedOfficeHoursRequiredMinutes: Math.round((Number(e.target.value) || 0) * 60) }))}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Flex staff whose shift starts inside the Flex window only need this many hours of
                CMS login on the selected day, counted from their actual login. The rest is worked
                from home, so no early-logout is raised for it. Late logout still applies against
                the normal shift end. This day is never used for make-up cover for Flex staff.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Rounding Grid & Direction (Minutes):
              </label>
              <div className="flex space-x-2">
                <input
                  type="number"
                  value={localConfig.roundingGridMinutes}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, roundingGridMinutes: parseInt(e.target.value, 10) || 30 }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <select
                  value={localConfig.roundingDirection}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, roundingDirection: e.target.value as any }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="nearest">Nearest (07:12 &rarr; 07:00, 07:18 &rarr; 07:30)</option>
                  <option value="up">Round Up</option>
                  <option value="down">Round Down</option>
                </select>
              </div>
              <p className="text-[11px] text-slate-500">
                Snaps arrival time before writing the updated shift record.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Segment-Update Rounding Grid & Direction (Rule 8: RLS added to OT):
              </label>
              <div className="flex space-x-2">
                <input
                  type="number"
                  value={localConfig.segmentUpdateRoundingGridMinutes}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, segmentUpdateRoundingGridMinutes: parseInt(e.target.value, 10) || 30 }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <select
                  value={localConfig.segmentUpdateRoundingDirection}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, segmentUpdateRoundingDirection: e.target.value as any }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="nearest">Nearest</option>
                  <option value="up">Round Up</option>
                  <option value="down">Round Down</option>
                </select>
              </div>
              <p className="text-[11px] text-slate-500">
                Widens (Round Up) or narrows (Round Down) each release's own start/end to this
                grid before it is cut out of the OT segment, so the remaining OT and the
                converted SHIFT time always add up with no gap or overlap. Separate from the
                Rounding Grid above, which only snaps flex late-arrival — Late/Cover never round.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Shift-Update Pair Action Codes (ASPECT CSV):
              </label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  placeholder="Original (10)"
                  value={localConfig.shiftUpdateOriginalCode}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, shiftUpdateOriginalCode: e.target.value }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Updated (11)"
                  value={localConfig.shiftUpdateNewCode}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, shiftUpdateNewCode: e.target.value }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Code 10 marks original shift superseded; Code 11 marks replacement shift in HH:MM duration.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Memo Text Templates:
              </label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={localConfig.originalShiftMemo}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, originalShiftMemo: e.target.value }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  value={localConfig.updatedShiftMemo}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, updatedShiftMemo: e.target.value }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="block text-slate-800 font-semibold">
                Expected Scheduled Start Window:
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  step={60}
                  value={localConfig.flexExpectedSchedStartWindow.start}
                  onChange={(e) => setLocalConfig(prev => ({
                    ...prev,
                    flexExpectedSchedStartWindow: { ...prev.flexExpectedSchedStartWindow, start: e.target.value },
                  }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <span className="text-slate-400">&ndash;</span>
                <input
                  type="time"
                  step={60}
                  value={localConfig.flexExpectedSchedStartWindow.end}
                  onChange={(e) => setLocalConfig(prev => ({
                    ...prev,
                    flexExpectedSchedStartWindow: { ...prev.flexExpectedSchedStartWindow, end: e.target.value },
                  }))}
                  className="w-1/2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Normal scheduled-start window for flex staff (default 07:00&ndash;10:00), used alongside the absolute cutoff above.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.flexBypassesMinuteBands}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, flexBypassesMinuteBands: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Flex Bypasses Minute Bands
              </label>
              <p className="text-[11px] text-slate-500">
                When ON, flex staff over the absolute cutoff are charged full variance directly instead of through the Policy Rules Matrix minute bands.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.flexOutsideWindowTreatAsOps}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, flexOutsideWindowTreatAsOps: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Flex Outside Window &rarr; Label as OPS
              </label>
              <p className="text-[11px] text-slate-500">
                When ON, a flex-tagged employee whose ASPECT-scheduled start falls outside the window above is labeled OPS (not FLEX) in the output and email drafts. Their row is still held for manual review (FLEX_SCHEDULE_OUTSIDE_WINDOW) either way &mdash; this only fixes the tier label.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 3: Keywords & Filters */}
      {activeSubTab === 'keywords' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div>
            <h4 className="text-sm font-bold text-slate-900">Keyword Scans & Drop Patterns (§4.2 & §6.6)</h4>
            <p className="text-xs text-slate-500 mt-1">
              Role tier derivation keywords, flex staff identification keywords, and Cognos row-drop presets.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Non-OPS Role Tier Keywords */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Non-OPS Role Tier Keywords (Comma-Separated):
              </label>
              <textarea
                rows={3}
                value={localConfig.roleTierKeywords.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  roleTierKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Staff whose EMP_SORT_NAME or EMP_SHORT_NAME matches these keywords are classified as OFFICER_PLUS.
              </p>
            </div>

            {/* Flex Keywords */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Flex Staff Detection Keywords (Comma-Separated):
              </label>
              <textarea
                rows={3}
                value={localConfig.flexKeywords.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  flexKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Identifies flex-rostered employees eligible for the absolute 10:00 cutoff window.
              </p>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-200 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h4 className="text-sm font-bold text-slate-900">Cognos Report Filteration (§6.6)</h4>
                <p className="text-[11px] text-slate-500 mt-1">
                  Off by default — no row is ever dropped silently. Add a rule to exclude Cognos rows
                  where a column (PF NO, SECTION, LEAVE TYPE, or any other column) matches a wildcard
                  value (e.g. <code className="font-mono">UAE*</code>) before validation/calculation runs.
                  Multiple rules combine with OR — a row is dropped if any rule matches.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleAddCognosDropRule({ column: 'PF NO', values: ['UAE*'] })}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all"
                >
                  + Suggested: PF NO starts with UAE*
                </button>
                <button
                  onClick={() => handleAddCognosDropRule({ column: 'SECTION', values: ['ACCESS CARD*'] })}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all"
                >
                  + Suggested: SECTION starts with ACCESS CARD*
                </button>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
                  <tr>
                    <th className="py-3 px-3.5 w-48">Column</th>
                    <th className="py-3 px-3.5">Values to exclude (comma or newline separated, wildcard *)</th>
                    <th className="py-3 px-3.5 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {localConfig.cognosDropPatterns.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-3 px-3.5 text-slate-400 font-sans">
                        No drop rules configured — every Cognos row is imported and evaluated.
                      </td>
                    </tr>
                  )}
                  {localConfig.cognosDropPatterns.map((rule, index) => (
                    <tr key={index} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2 px-3.5 align-top">
                        <input
                          type="text"
                          value={rule.column}
                          placeholder="e.g. PF NO"
                          list="cognos-drop-rule-columns"
                          onChange={(e) => handleUpdateCognosDropRule(index, { column: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5 align-top">
                        <textarea
                          rows={1}
                          value={rule.values.join(', ')}
                          placeholder="e.g. UAE*, xyxz*"
                          onChange={(e) => handleUpdateCognosDropRule(index, {
                            values: e.target.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean),
                          })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5 align-top">
                        <button
                          onClick={() => handleRemoveCognosDropRule(index)}
                          className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 transition-all"
                          title="Remove rule"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="cognos-drop-rule-columns">
                <option value="PF NO" />
                <option value="SECTION" />
                <option value="NAME" />
                <option value="LOGIN ID" />
                <option value="LEAVE TYPE" />
                <option value="REMARK" />
              </datalist>
            </div>

            <button
              onClick={() => handleAddCognosDropRule()}
              className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center space-x-1.5 border border-indigo-200 shadow-2xs transition-all"
            >
              <Plus className="w-3 h-3" />
              <span>Add filter</span>
            </button>
          </div>
        </div>
      )}

      {/* Sub-Tab 4: Covers & Join Parameters */}
      {activeSubTab === 'covers' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div>
            <h4 className="text-sm font-bold text-slate-900">Cover Placement & Join Thresholds (§4.11)</h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                CMS Punch Search Window (&plusmn; Hours):
              </label>
              <input
                type="number"
                min={1}
                value={localConfig.cmsPunchSearchWindowHours}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, cmsPunchSearchWindowHours: parseInt(e.target.value, 10) || 5 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Punches are attributed within [shiftStart - N h, shiftEnd + N h]. Each punch is claimed by exactly one employee-day — the nearest window — so consecutive night shifts can never double-count a punch. Also sets the CMS Coverage Grace.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Unseen Punch Audit — Max Reach (Hours):
              </label>
              <input
                type="number"
                min={1}
                value={localConfig.unseenPunchMaxReachHours}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, unseenPunchMaxReachHours: parseInt(e.target.value, 10) || 8 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                After Calculate, a separate audit looks for punches beyond the search window above that could change a result. A candidate punch more than this many hours past its owning shift's own edge is dropped as a backstop rather than investigated. Default 8.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Unseen Punch Audit — Improper Login/Logout Memo Text:
              </label>
              <input
                type="text"
                value={localConfig.improperPunchMemoText}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, improperPunchMemoText: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                A row the unseen-punch audit flags (REASON or OUTCOME) has a punch outside the search window, so the engine's specific reason may be wrong. Every such row's ASPECT correction Memo (except a flex shift-update pair's Original/Updated Shift marker) is replaced with this exact text — never the specific reason — and its email uses the neutral "Improper login/logout" template. Must not be blank or contain a newline.
              </p>
            </div>

            {/* Grace no longer has its own value (user decision: one linked setting,
                not two) — it always equals cmsPunchSearchWindowHours * 60 via
                effectiveCmsCoverageGraceMinutes. Shown read-only, styled like the
                other retired/derived inputs below, so it can't drift out of sync. */}
            <div className="bg-slate-100 p-4 rounded-xl border border-slate-200 space-y-2 opacity-60">
              <label className="block text-slate-500 font-semibold flex items-center gap-2">
                CMS Coverage Grace (Minutes) — linked to search window:
                <span className="text-[9px] font-bold text-slate-600 bg-slate-200 px-2 py-0.5 rounded-full border border-slate-300 uppercase tracking-wider">
                  Derived
                </span>
              </label>
              <input
                type="number"
                disabled
                value={effectiveCmsCoverageGraceMinutes(localConfig)}
                readOnly
                className="w-full px-3 py-2 rounded-lg bg-slate-200 border border-slate-300 text-slate-500 font-mono shadow-2xs cursor-not-allowed"
              />
              <p className="text-[11px] text-slate-500">
                Always equals the CMS Punch Search Window &times; 60. Change the search window to change it. How far past the shift&rsquo;s own start/end the <strong>export</strong> must reach before &ldquo;no companion punch found&rdquo; is trusted as real absence rather than a coverage gap. Every date in the export counts as fully covered except its latest date, which counts only up to the last punch on it.
              </p>
            </div>

            {/* Deprecated by the coverage fix: the rule is now measured against the
                export's own extent (see cmsCoverageGraceMinutes above and
                punchAttribution.ts's buildExportDayCoverage), not a flat day-buffer
                around the report's date range. Kept visible and disabled rather than
                deleted so the change is self-explanatory to anyone who knew these
                knobs — an editable control that does nothing is worse than an absent
                one, and a silently vanished one is worse than both. */}
            <div className="bg-slate-100 p-4 rounded-xl border border-slate-200 space-y-2 opacity-60">
              <label className="block text-slate-500 font-semibold flex items-center gap-2">
                Required CMS Coverage (Days Before / After):
                <span className="text-[9px] font-bold text-slate-600 bg-slate-200 px-2 py-0.5 rounded-full border border-slate-300 uppercase tracking-wider">
                  No longer used
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  disabled
                  value={localConfig.cmsRequiredCoverageDaysBefore}
                  readOnly
                  className="w-full px-3 py-2 rounded-lg bg-slate-200 border border-slate-300 text-slate-500 font-mono shadow-2xs cursor-not-allowed"
                />
                <span className="text-slate-400">/</span>
                <input
                  type="number"
                  disabled
                  value={localConfig.cmsRequiredCoverageDaysAfter}
                  readOnly
                  className="w-full px-3 py-2 rounded-lg bg-slate-200 border border-slate-300 text-slate-500 font-mono shadow-2xs cursor-not-allowed"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Retired. Coverage used to require a flat day-buffer around the whole report&rsquo;s date range, which held ordinary same-day shifts on dates the export fully covered. It is now measured against what the export actually contains &mdash; use <strong>CMS Coverage Grace (Minutes)</strong> above instead. These two values are kept only so saved and exported configs stay readable; changing them has no effect.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.validateUploadedHeadcount}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, validateUploadedHeadcount: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Validate Uploaded HC
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-600">Minimum mapping %:</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  disabled={!localConfig.validateUploadedHeadcount}
                  value={localConfig.minHeadcountMappingPercent}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, minHeadcountMappingPercent: parseInt(e.target.value, 10) || 0 }))}
                  className="w-24 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
              </div>
              <p className="text-[11px] text-slate-500">
                When ON, Calculate is blocked (pending explicit acknowledgement) if the lowest of the Cognos-to-ASPECT or Cognos-to-CMS ID mapping percentage falls below this minimum — the uploaded CMS export may be scoped to the wrong agent list. When OFF, this check is skipped entirely: no warning, no gate.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Leave-Day Login Threshold (§4.6b, Minutes):
              </label>
              <input
                type="number"
                value={localConfig.leaveLoginThresholdMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, leaveLoginThresholdMinutes: parseInt(e.target.value, 10) || 60 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Login &ge; 60 min on a scheduled leave day converts to Absent + Manual Review flag.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Default Full-Day Segment Duration (No DURATION value, Minutes):
              </label>
              <input
                type="number"
                value={localConfig.defaultFullDaySegmentDurationMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, defaultFullDaySegmentDurationMinutes: parseInt(e.target.value, 10) || 480 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Fallback for a full-day segment (classified Addition or Removal in the Segment Glossary, with no DURATION and no START/STOP times). Such a segment normally equals that day's own scheduled duration (SHIFT + OT + COVER); this value is used only when the day has no schedule. An explicit DURATION (even 0) is never overridden. Default 480 (8h).
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Column Comparison Tolerance (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.comparisonToleranceMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, comparisonToleranceMinutes: parseInt(e.target.value, 10) || 1 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                A recomputed column within this many minutes of Cognos's own value counts as MATCH, not MISMATCH.
              </p>
            </div>

            <div className="bg-amber-50 p-4 rounded-xl border border-amber-300 space-y-2">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.releaseProvenSafeHolds}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, releaseProvenSafeHolds: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Automatically Release Proven-Safe Holds:
              </label>
              <p className="text-[11px] text-slate-500">
                Automatically release holds that are proven safe (Cognos differences that can't change the action, and
                no-attendance leave days). Turn off to hold them for manual review as before.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                DUTY1 / DUTY-2 Gap Threshold (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.perBlockGapThresholdMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, perBlockGapThresholdMinutes: parseInt(e.target.value, 10) || 60 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Comparison only: merges nearby overtime (OT1/OT2) and other non-SHIFT blocks for the DUTY1 / DUTY-2 column compare. Two SHIFT segments are never merged — each SHIFT is its own duty, as in Cognos. Attendance is always first-login vs last-logout against the whole-day window — this knob does not switch per-block late/early penalties.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Cognos Blank-Fill Columns:
              </label>
              <input
                type="text"
                placeholder="OT1, OT-2"
                value={localConfig.cognosBlankFillColumns.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, cognosBlankFillColumns: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Columns that are structurally blank in Cognos by design — TAA fills them with the recomputed value ONLY when the source cell is empty; a populated cell is never overwritten.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Absent + OT Conversion Code (§4.6c):
              </label>
              <input
                type="text"
                placeholder="SHIFT"
                value={localConfig.otToShiftConversionCode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, otToShiftConversionCode: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                SegmentCode written for the "11" row of the replace pair when a day's OT1/OT2 segments are retired and replaced with a shift segment because that day was marked Absent. Auto-included in the export — no reviewer hold, since the day already pays zero regardless of which code the segment carries.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Public-Holiday SHIFT-to-OT2 Conversion Code:
              </label>
              <input
                type="text"
                placeholder="OT2"
                value={localConfig.shiftToOt2ConversionCode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, shiftToOt2ConversionCode: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                SegmentCode written when a SHIFT segment on a public-holiday-leave day (default leave code P/H-LV) is converted because staff was mistakenly scheduled as a normal shift instead of holiday overtime. The row stays held for reviewer approval — never auto-included in the export.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Cover Fallback When No Working Day Found Ahead:
              </label>
              <select
                value={localConfig.coverFallbackWhenNoWorkingDayFound}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, coverFallbackWhenNoWorkingDayFound: e.target.value as any }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
              >
                <option value="sameDay">Same Day (end of incident day's own schedule)</option>
                <option value="nextDirectDay">Next Calendar Day (+1 Day, unconfirmed working day)</option>
                <option value="nextWeekMonday">Next-Week Monday (default)</option>
              </select>
              <p className="text-[11px] text-slate-500">
                Fires only when ASPECT data for a future working day hasn't been uploaded yet — never when a real future working day exists in the data. "Same Day" reuses the exact end-of-last-segment placement logic anchored to the incident day itself and ignores the default time below. Every cover placed through this fallback is marked in the output (Memo suffix + TAA_COVER_FALLBACK_NOTE column) so it's never mistaken for one placed against real schedule data.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Cover Fallback Default Time:
              </label>
              <input
                type="time"
                value={localConfig.coverFallbackDefaultTime}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, coverFallbackDefaultTime: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Cover start time used by "Next Calendar Day" and "Next-Week Monday" fallbacks only. Not used by "Same Day".
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Cover Not Attended Policy (§4.12):
              </label>
              <select
                value={localConfig.coverNotAttendedAction}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, coverNotAttendedAction: e.target.value as any }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
              >
                <option value="markAbsent">Mark Absent (Rule 7 default)</option>
                <option value="moveCoverForward">Move Cover Forward (Re-place Cover)</option>
              </select>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.coverSameDayWhenAlreadyCovered}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, coverSameDayWhenAlreadyCovered: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Place Cover Same-Day When Agent Already Covered It
              </label>
              <p className="text-[11px] text-slate-500">
                Off by default &mdash; the next-working-day search above always runs unchanged. When ON, a Late Login or Early Logout cover first checks whether the agent was already logged in for the full cover duration on the incident day itself (stayed past schedule end after arriving late, or arrived before schedule start ahead of leaving early). If that whole window sits inside the agent's own first-login&ndash;last-logout span that day, the cover is placed there instead of searching ahead. If not, the existing next-working-day search / fallback logic runs exactly as it does today. A day that carries any release, nursing or other removal segment never takes a same-day cover &mdash; it always uses the next-working-day scenario.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Minimum Days After Run Date (Cover Placement):
              </label>
              <input
                type="number"
                value={localConfig.coverMinimumDaysAfterRunDate}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, coverMinimumDaysAfterRunDate: parseInt(e.target.value, 10) || 0 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                A newly assigned cover (never a proven same-day-worked one &mdash; see the toggle above) must land on a working day at least this many days after today, not merely after the incident date. Default 1.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Technical Segment Codes (Comma-Separated):
              </label>
              <input
                type="text"
                placeholder="TECH, TECH2"
                value={localConfig.technicalSegmentCodes.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  technicalSegmentCodes: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <label className="block text-slate-800 font-semibold pt-1">
                Technical Segment Tolerance (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.technicalSegmentToleranceMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, technicalSegmentToleranceMinutes: parseInt(e.target.value, 10) || 0 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                When every variance interval a row actually fired an action for (late login, early logout, late logout, or an unattended cover window) sits inside these segments' own windows &mdash; within the tolerance below &mdash; the row is held for review instead of exporting the penalty; the correction is still built, just not sent to payroll until a reviewer releases it. These codes must also be classified NO_EFFECT in the Segment Glossary, or their window still moves and no variance exists to hold. Partial coverage still exports, with the shortfall noted in the trace.
              </p>
              <label className="flex items-center gap-2 text-slate-800 font-semibold pt-1">
                <input
                  type="checkbox"
                  checked={localConfig.technicalSegmentsExcuseLateLogin}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, technicalSegmentsExcuseLateLogin: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Technical Segments Excuse Late Login
              </label>
              <p className="text-[11px] text-slate-500">
                On: late-login minutes inside a technical segment are never charged (same as an authorised late) &mdash; no LATE, no COVER, no hold; only minutes after the technical segment go through the Late Login bands. Off: a fully covered late is built and held for review as above.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Late Segment Code:
              </label>
              <input
                type="text"
                placeholder="LATE"
                value={localConfig.lateSegmentCode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, lateSegmentCode: e.target.value.trim() }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <label className="block text-slate-800 font-semibold pt-1">
                Authorised Late Segment Codes (Comma-Separated):
              </label>
              <input
                type="text"
                placeholder="LATE-A"
                value={localConfig.authorisedLateSegmentCodes.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  authorisedLateSegmentCodes: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                A late approved in ASPECT (e.g. during an incident). Late-login minutes inside these segments are treated as already actioned and never charged; if the agent arrived after the authorised window ends, only the extra minutes are charged (LATE + COVER starting where the authorised window ends).
              </p>
              <label className="block text-slate-800 font-semibold pt-1">
                Segments Adjusted Around a TAA Late (Comma-Separated):
              </label>
              <input
                type="text"
                placeholder="BRFNG"
                value={localConfig.lateOverlapAdjustSegmentCodes.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  lateOverlapAdjustSegmentCodes: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                When TAA adds a LATE that overlaps one of these segments: fully covered by the LATE &rarr; deleted; longer than the LATE &rarr; trimmed to start where the LATE ends (original/new update pair). Never applied to a late already recorded in ASPECT; dropped with the LATE if the day becomes Absent.
              </p>
              <label className="block text-slate-800 font-semibold pt-1">
                ASPECT Delete Action Code:
              </label>
              <input
                type="text"
                placeholder="20"
                value={localConfig.aspectDeleteActionCode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, aspectDeleteActionCode: e.target.value.trim() }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <label className="block text-slate-800 font-semibold pt-1">
                Delete Memo / Trim Memo:
              </label>
              <input
                type="text"
                value={localConfig.lateOverlapDeleteMemo}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, lateOverlapDeleteMemo: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <input
                type="text"
                value={localConfig.lateOverlapTrimMemo}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, lateOverlapTrimMemo: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Release Grid (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.releaseGridMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, releaseGridMinutes: parseInt(e.target.value, 10) || 0 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <label className="block text-slate-800 font-semibold pt-1">
                Release Grid Codes (Comma-Separated):
              </label>
              <input
                type="text"
                placeholder="RLS, RLS-2H, RLS-3H, UN_RLS, Cover_RLS"
                value={localConfig.releaseGridCodes.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  releaseGridCodes: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Releases are booked on this grid (30 = :00 or :30 only). A release off the grid (e.g. 14:35) is flagged on the row (RELEASE_OFF_GRID) for a reviewer to check in ASPECT &mdash; never held and never rounded: the day is calculated with the release exactly as recorded. 0 turns the check off.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Release Proximity Tolerance (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.releaseProximityToleranceMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, releaseProximityToleranceMinutes: parseInt(e.target.value, 10) || 0 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Window (minutes) either side of a release boundary used to classify a leading/trailing release.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Minimum Attendance Span (Minutes):
              </label>
              <input
                type="number"
                value={localConfig.minAttendanceSpanMinutes}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, minAttendanceSpanMinutes: parseInt(e.target.value, 10) || 0 }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Below this many minutes, a login/logout pair is treated as no real attendance evidence rather than a genuine shift.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                Cognos Sentinel Values (Minutes, Comma-Separated):
              </label>
              <input
                type="text"
                placeholder="-480, -540"
                value={localConfig.cognosSentinelValues.join(', ')}
                onChange={(e) => setLocalConfig(prev => ({
                  ...prev,
                  cognosSentinelValues: e.target.value.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n)),
                }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <select
                value={localConfig.cognosSentinelDetectionMode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, cognosSentinelDetectionMode: e.target.value as any }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 shadow-2xs focus:outline-none focus:border-indigo-500"
              >
                <option value="valueList">Value List Only</option>
                <option value="negatedLeaveHr">Negated LEAVE HR Only</option>
                <option value="both">Both (default)</option>
              </select>
              <p className="text-[11px] text-slate-500">
                Cognos "N/A" placeholder values, not real variances. Detection mode controls whether a sentinel is recognized by this fixed value list, the structural -LEAVE HR rule, or either.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.coverExtendsAttendanceWindow}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, coverExtendsAttendanceWindow: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Cover Extends Attendance Window
              </label>
              <p className="text-[11px] text-slate-500">
                When ON, a placed COVER extends the shift's raw start/end window. Default OFF &mdash; COVER still counts toward scheduled hours either way.
              </p>
            </div>

            <div className="bg-amber-50 p-4 rounded-xl border border-amber-300 space-y-2">
              <label className="flex items-center gap-2 text-slate-800 font-semibold">
                <input
                  type="checkbox"
                  checked={localConfig.retainLateCoverOnAbsent}
                  onChange={(e) => setLocalConfig(prev => ({ ...prev, retainLateCoverOnAbsent: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                Retain Late/Logoff+Cover on Absent Days
              </label>
              <p className="text-[11px] text-slate-500">
                Default OFF: when a day is marked Absent (a more severe rule outranking an
                already-fired Late+Cover or Logoff+Cover finding on the same day), the LATE/
                Log_off/COVER correction is stripped before export so the day isn't docked a full
                day's pay AND charged a Late+Cover. Turning this ON exports both together for
                every such day, uniformly, with no reviewer hold &mdash; a deliberate policy choice
                that removes that protection. Only enable this if payroll genuinely wants an
                Absent day to also carry a Late+Cover charge.
              </p>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
              <label className="block text-slate-800 font-semibold">
                ASPECT Normal Action Code:
              </label>
              <input
                type="text"
                placeholder="00"
                value={localConfig.aspectNormalActionCode}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, aspectNormalActionCode: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                Action code used when inserting a new segment into the ASPECT correction output.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 5: Email Draft Templates */}
      {activeSubTab === 'emails' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Mail className="w-4 h-4 text-sky-600" />
                Outlook Draft Templates
              </h4>
              <p className="text-xs text-slate-500 mt-1">
                Plain-text subjects and bodies used by the Results page email icons and bulk draft button.
              </p>
            </div>
          </div>

          {/* Section -> OPS Mailbox routing. EMAIL_OPS cases are pooled per
              Section into one digest email addressed to that Section's
              mailbox; a Section with no row here goes to defaultOpsMailbox, or (if
              that is blank) has its cases HELD - reported but not drafted, never re-routed to the employee. */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h5 className="text-xs font-bold text-slate-900">Section &rarr; OPS Mailbox Routing</h5>
                <p className="text-[11px] text-slate-500 mt-1">
                  EMAIL_OPS cases are pooled by Section into one digest email per Section's mailbox. A Section with no mapping here goes to the default OPS mailbox; if that is blank, its cases are held back and reported — they are never re-routed to the employee, because the rule that fired chose OPS specifically to keep the employee and their line manager off the recipient list.
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <label className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all cursor-pointer">
                  Import CSV
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImportSectionMailboxCsv(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  onClick={handleExportSectionMailboxCsv}
                  className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <label className="block">
              <span className="block text-[11px] font-semibold text-slate-700">Default OPS mailbox</span>
              <span className="block text-[10px] text-slate-500 mb-1">Used for any Section with no mapping below — its digest is still one email per Section per day. Leave blank to hold unmapped Sections instead.</span>
              <input
                type="text"
                value={localConfig.defaultOpsMailbox}
                placeholder="e.g. ops@thecontactcentre.ae"
                onChange={(e) => setLocalConfig(prev => ({ ...prev, defaultOpsMailbox: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500"
              />
            </label>

            <EmailZipSettings
              enabled={localConfig.emailZipEnabled}
              threshold={localConfig.emailZipThreshold}
              onChange={(next) => setLocalConfig(prev => ({ ...prev, ...next }))}
            />

            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
                  <tr>
                    <th className="py-2.5 px-3.5">Section</th>
                    <th className="py-2.5 px-3.5">Mailbox</th>
                    <th className="py-2.5 px-3.5 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {localConfig.sectionMailboxMap.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-3 px-3.5 text-slate-400 font-sans">
                        No Section mailboxes configured — every EMAIL_OPS case goes to the default OPS mailbox (or is held if that is blank).
                      </td>
                    </tr>
                  )}
                  {localConfig.sectionMailboxMap.map((rule, index) => (
                    <tr key={index} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2 px-3.5">
                        <input
                          type="text"
                          value={rule.section}
                          placeholder="e.g. PRESTIGE"
                          onChange={(e) => handleUpdateSectionMailboxRule(index, { section: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5">
                        <input
                          type="text"
                          value={rule.mailbox}
                          placeholder="prestigeagents@thecontactcenter.ae"
                          onChange={(e) => handleUpdateSectionMailboxRule(index, { mailbox: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5">
                        <button
                          onClick={() => handleRemoveSectionMailboxRule(index)}
                          className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 transition-all"
                          title="Remove mapping"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              onClick={() => handleAddSectionMailboxRule()}
              className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center space-x-1.5 border border-indigo-200 shadow-2xs transition-all"
            >
              <Plus className="w-3 h-3" />
              <span>Add mapping</span>
            </button>
          </div>

          {/* Employee -> Manager CC mapping (§4.7). Optional and additive: no
              row for an employee simply means the draft opens with no CC —
              never an error, never a review flag. There is no manager data in
              any source file (Cognos, ASPECT), so this is the only way to
              fill the CC line now that there is no Exchange lookup in the loop. */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h5 className="text-xs font-bold text-slate-900">Employee &rarr; Manager CC Mapping (Optional)</h5>
                <p className="text-[11px] text-slate-500 mt-1">
                  Fills the CC line on EMAIL_STAFF_CC_MANAGER drafts. No manager data exists in any uploaded file — this must be supplied here. An employee with no mapping simply drafts with no CC.
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <label className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all cursor-pointer">
                  Import CSV
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImportEmployeeManagerCsv(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  onClick={handleExportEmployeeManagerCsv}
                  className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
                  <tr>
                    <th className="py-2.5 px-3.5">Emp ID (PF No)</th>
                    <th className="py-2.5 px-3.5">Manager Email</th>
                    <th className="py-2.5 px-3.5 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {localConfig.employeeManagerMap.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-3 px-3.5 text-slate-400 font-sans">
                        No manager mappings configured — every draft opens with no CC.
                      </td>
                    </tr>
                  )}
                  {localConfig.employeeManagerMap.map((rule, index) => (
                    <tr key={index} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2 px-3.5">
                        <input
                          type="text"
                          value={rule.empId}
                          placeholder="e.g. 4500116"
                          onChange={(e) => handleUpdateEmployeeManagerRule(index, { empId: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5">
                        <input
                          type="text"
                          value={rule.managerEmail}
                          placeholder="manager@thecontactcentre.ae"
                          onChange={(e) => handleUpdateEmployeeManagerRule(index, { managerEmail: e.target.value })}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                        />
                      </td>
                      <td className="py-2 px-3.5">
                        <button
                          onClick={() => handleRemoveEmployeeManagerRule(index)}
                          className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 transition-all"
                          title="Remove mapping"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              onClick={() => handleAddEmployeeManagerRule()}
              className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center space-x-1.5 border border-indigo-200 shadow-2xs transition-all"
            >
              <Plus className="w-3 h-3" />
              <span>Add mapping</span>
            </button>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2 text-xs">
            <label className="block text-slate-800 font-semibold">Corporate Email Domain(s):</label>
            <input
              type="text"
              value={localConfig.emailCorporateDomains.join(', ')}
              onChange={(e) => setLocalConfig(prev => ({
                ...prev,
                emailCorporateDomains: e.target.value.split(',').map(d => d.trim()).filter(Boolean),
              }))}
              placeholder="thecontactcentre.ae"
              className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono shadow-2xs focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500">
              Comma-separated. When a staff record has no username, a corporate-domain email address is used as its recipient as-is; any other domain (e.g. a personal Gmail/Hotmail address) is never used this way, since its local part can belong to someone else entirely — that row falls back to the staff name instead, so Outlook makes a human confirm it.
            </p>
          </div>

          <div className="space-y-4">
            {EMAIL_TEMPLATE_KEYS.map(key => (
              <div key={key} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h5 className="text-xs font-bold text-slate-900">{EMAIL_TEMPLATE_LABELS[key]}</h5>
                  <button
                    onClick={() => handleResetEmailTemplate(key)}
                    title="Reset this template"
                    className="p-1.5 rounded-lg text-slate-500 hover:text-rose-700 hover:bg-rose-50 transition-all"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-slate-500">
                  Placeholders:{' '}
                  {EMAIL_TEMPLATE_PLACEHOLDERS_BY_KEY[key].map(p => (
                    <code key={p} className="inline-block mr-1 mb-1 px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700">
                      {`{{${p}}}`}
                    </code>
                  ))}
                </div>
                <input
                  type="text"
                  value={localConfig.emailTemplates[key].subject}
                  onChange={(e) => handleUpdateEmailTemplate(key, { subject: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
                />
                <textarea
                  rows={7}
                  value={localConfig.emailTemplates[key].body}
                  onChange={(e) => handleUpdateEmailTemplate(key, { body: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-mono leading-relaxed shadow-2xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmed Reset Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-rose-600">
              <div className="p-2 rounded-xl bg-rose-50 border border-rose-100">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h4 className="text-base font-bold text-slate-900">Confirm Full Configuration Reset</h4>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will restore all rule thresholds, keywords, flex parameters, and segment glossaries to their original shipped defaults from <code className="text-indigo-600 bg-indigo-50 px-1 py-0.5 rounded font-mono">Rules to be taken.xlsx</code>.
            </p>
            <div className="flex items-center justify-end space-x-3 pt-3">
              <button
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReset}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-sm shadow-rose-200 transition-all"
              >
                Yes, Reset All Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
