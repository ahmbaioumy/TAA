import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Mail, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { ConfigRegistry, EmailTemplateKey, EmployeeManagerRule, SectionMailboxRule } from '../types/taa';
import {
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  EMAIL_TEMPLATE_PLACEHOLDERS_BY_KEY,
  DEFAULT_EMAIL_TEMPLATES,
  normalizeEmailTemplates,
} from '../services/emailDrafts';
import { normalizeSectionMailboxMap, parseSectionMailboxCsv, normalizeEmployeeManagerMap, parseEmployeeManagerCsv } from '../services/configRegistry';
import { decodeFileBuffer } from '../services/parsers';

// A Section is duplicated when two rows normalize to the same key (trimmed,
// case-insensitive) — see poolEmailOpsActionsBySection in emailDrafts.ts,
// which keys its mailbox lookup the same way. Two rows for "Prestige" and
// "PRESTIGE " would otherwise silently collapse to whichever one the pooling
// Map processed last, with no indication to the user which mailbox actually
// applies. Blank Section fields (a freshly added, not-yet-typed row) are
// never flagged as duplicates of each other.
// Every {{token}} a template uses that is not a placeholder this template key
// supports. renderTemplateText resolves the supported ones and silently leaves
// the rest as literal braces, so without this the only feedback an operator got
// was seeing "{{manager}}" in a real Outlook subject line after the fact.
// Matched with the same regex renderTemplateText uses, so the two can't drift.
function getUnknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    if (!allowed.includes(match[1])) found.add(match[1]);
  }
  return Array.from(found);
}

function getDuplicateSectionKeys(rules: SectionMailboxRule[]): Set<string> {
  const counts = new Map<string, number>();
  rules.forEach(r => {
    const key = r.section.trim().toUpperCase();
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const duplicates = new Set<string>();
  counts.forEach((count, key) => { if (count > 1) duplicates.add(key); });
  return duplicates;
}

interface EmailConfigWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConfigRegistry;
  onSaveConfig: (updated: ConfigRegistry) => void;
}

const STEP_COUNT = 3;
const STEP_TITLES = ['Section → Mailbox Routing', 'Manager CC Mapping', 'Email Templates'];

export function EmailConfigWizardModal({ isOpen, onClose, config, onSaveConfig }: EmailConfigWizardModalProps) {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<ConfigRegistry>(config);

  // Re-seed the draft from the latest saved config every time the wizard is
  // (re)opened, and always start at step 1 — otherwise a second open would
  // resume mid-way through a previously cancelled run.
  useEffect(() => {
    if (isOpen) {
      setDraft({ ...config, emailTemplates: normalizeEmailTemplates(config.emailTemplates) });
      setStep(1);
    }
  }, [isOpen, config]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const duplicateSectionKeys = getDuplicateSectionKeys(draft.sectionMailboxMap);
  const hasDuplicateSections = duplicateSectionKeys.size > 0;

  const templateWarnings = EMAIL_TEMPLATE_KEYS.reduce((acc, key) => {
    const allowed = EMAIL_TEMPLATE_PLACEHOLDERS_BY_KEY[key];
    const template = draft.emailTemplates[key];
    const subjectUnknown = getUnknownPlaceholders(template.subject, allowed);
    const bodyUnknown = getUnknownPlaceholders(template.body, allowed);
    const messages: string[] = [];
    if (subjectUnknown.length > 0) messages.push(`Subject uses unknown placeholder(s): ${subjectUnknown.map(p => `{{${p}}}`).join(', ')}.`);
    if (bodyUnknown.length > 0) messages.push(`Body uses unknown placeholder(s): ${bodyUnknown.map(p => `{{${p}}}`).join(', ')}.`);
    acc[key] = messages;
    return acc;
  }, {} as Record<EmailTemplateKey, string[]>);
  // Unknown placeholders are a warning, not a hard block: an operator may be
  // mid-typing a valid token. Duplicate Sections stay a hard block because they
  // silently change which mailbox a case is addressed to.
  const hasTemplateWarnings = EMAIL_TEMPLATE_KEYS.some(key => templateWarnings[key].length > 0);

  const handleUpdateTemplate = (key: EmailTemplateKey, patch: Partial<{ subject: string; body: string }>) => {
    setDraft(prev => ({
      ...prev,
      emailTemplates: { ...prev.emailTemplates, [key]: { ...prev.emailTemplates[key], ...patch } },
    }));
  };

  const handleResetTemplate = (key: EmailTemplateKey) => {
    setDraft(prev => ({ ...prev, emailTemplates: { ...prev.emailTemplates, [key]: DEFAULT_EMAIL_TEMPLATES[key] } }));
  };

  const handleAddSectionMailboxRule = () => {
    setDraft(prev => ({ ...prev, sectionMailboxMap: [...prev.sectionMailboxMap, { section: '', mailbox: '' }] }));
  };
  const handleUpdateSectionMailboxRule = (index: number, updates: Partial<SectionMailboxRule>) => {
    setDraft(prev => ({
      ...prev,
      sectionMailboxMap: prev.sectionMailboxMap.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    }));
  };
  const handleRemoveSectionMailboxRule = (index: number) => {
    setDraft(prev => ({ ...prev, sectionMailboxMap: prev.sectionMailboxMap.filter((_, i) => i !== index) }));
  };
  const handleImportSectionMailboxCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const imported = parseSectionMailboxCsv(text);
        // Imported rows are appended after the existing ones, and
        // normalizeSectionMailboxMap collapses by trimmed/upper-cased
        // Section key keeping the LAST value for a given key — so a CSV
        // row always overwrites an existing manual mapping for the same
        // Section (matching what a re-import is expected to do), and two
        // rows for the same Section already collapse to one instead of
        // producing a duplicate.
        setDraft(prev => ({
          ...prev,
          sectionMailboxMap: normalizeSectionMailboxMap([...prev.sectionMailboxMap, ...imported]),
        }));
      } catch (err) {
        alert(`Invalid Section/Mailbox CSV: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  // Employee -> Manager CC mapping (§4.7, step 2) — optional, so unlike the
  // Section mailbox map above there is no duplicate-key hard block here; a
  // row simply upserts by EmpId. Decoded via decodeFileBuffer, not
  // readAsText, since an export produced the way ASPECT identity is (UTF-16)
  // would otherwise silently decode as mojibake.
  const handleAddEmployeeManagerRule = () => {
    setDraft(prev => ({ ...prev, employeeManagerMap: [...prev.employeeManagerMap, { empId: '', managerEmail: '' }] }));
  };
  const handleUpdateEmployeeManagerRule = (index: number, updates: Partial<EmployeeManagerRule>) => {
    setDraft(prev => ({
      ...prev,
      employeeManagerMap: prev.employeeManagerMap.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    }));
  };
  const handleRemoveEmployeeManagerRule = (index: number) => {
    setDraft(prev => ({ ...prev, employeeManagerMap: prev.employeeManagerMap.filter((_, i) => i !== index) }));
  };
  const handleImportEmployeeManagerCsv = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const text = decodeFileBuffer(buffer);
      const imported = parseEmployeeManagerCsv(text);
      setDraft(prev => ({
        ...prev,
        employeeManagerMap: normalizeEmployeeManagerMap([...prev.employeeManagerMap, ...imported]),
      }));
    } catch (err) {
      alert(`Invalid EmpId/ManagerEmail CSV: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleFinish = () => {
    if (hasDuplicateSections) return;
    // Defense-in-depth: collapse any duplicate/blank Section rows before
    // saving, even though the Save & Finish button is already disabled
    // while duplicates are visible in the UI. employeeManagerMap has no
    // duplicate-key hard block (it's optional, upsert-by-EmpId is enough),
    // but still gets the same blank-row/whitespace cleanup on save.
    onSaveConfig({
      ...draft,
      sectionMailboxMap: normalizeSectionMailboxMap(draft.sectionMailboxMap),
      defaultOpsMailbox: draft.defaultOpsMailbox.trim(),
      employeeManagerMap: normalizeEmployeeManagerMap(draft.employeeManagerMap),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-sky-300 bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-sky-200 bg-sky-50 px-5 py-4">
          <div className="flex gap-3">
            <Mail className="mt-0.5 h-5 w-5 shrink-0 text-sky-700" />
            <div>
              <h3 className="text-sm font-bold text-sky-950">Setup Email Config</h3>
              <p className="mt-1 text-xs text-sky-800">
                Step {step} of {STEP_COUNT} — {STEP_TITLES[step - 1]}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} title="Close" className="rounded p-1 text-sky-700 hover:bg-sky-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step progress dots */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
          {STEP_TITLES.map((title, index) => {
            const num = index + 1;
            const isActive = num === step;
            const isDone = num < step;
            return (
              <div key={title} className="flex items-center gap-2">
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                    isActive
                      ? 'bg-sky-600 text-white'
                      : isDone
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : num}
                </div>
                <span className={`text-[11px] font-semibold ${isActive ? 'text-slate-900' : 'text-slate-400'}`}>{title}</span>
                {num < STEP_COUNT && <div className="h-px w-6 bg-slate-200" />}
              </div>
            );
          })}
        </div>

        <div className="space-y-4 overflow-y-auto p-5 text-xs">
          {step === 1 && (
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <p className="text-[11px] text-slate-500">
                  EMAIL_OPS cases are pooled by Section into one digest email per Section's mailbox. A Section with no mapping here goes to the default OPS mailbox below; if that is blank, its cases are held (never re-routed to the employee).
                </p>
                <label className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all cursor-pointer shrink-0">
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
              </div>

              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-700">Default OPS mailbox</span>
                <span className="block text-[10px] text-slate-500 mb-1">Used for any Section with no mapping below — its digest is still one email per Section per day. Leave blank to hold unmapped Sections instead.</span>
                <input
                  type="text"
                  value={draft.defaultOpsMailbox}
                  placeholder="e.g. ops@thecontactcentre.ae"
                  onChange={(e) => setDraft(prev => ({ ...prev, defaultOpsMailbox: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500"
                />
              </label>

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
                    {draft.sectionMailboxMap.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-3 px-3.5 text-slate-400 font-sans">
                          No Section mailboxes configured yet.
                        </td>
                      </tr>
                    )}
                    {draft.sectionMailboxMap.map((rule, index) => {
                      const isDuplicate = rule.section.trim() !== '' && duplicateSectionKeys.has(rule.section.trim().toUpperCase());
                      return (
                        <tr key={index} className={`hover:bg-slate-50/70 transition-colors ${isDuplicate ? 'bg-rose-50/60' : ''}`}>
                          <td className="py-2 px-3.5">
                            <input
                              type="text"
                              value={rule.section}
                              placeholder="e.g. PRESTIGE"
                              onChange={(e) => handleUpdateSectionMailboxRule(index, { section: e.target.value })}
                              className={`w-full px-2.5 py-1.5 rounded-lg bg-white border text-slate-900 font-mono text-xs shadow-2xs focus:outline-none ${
                                isDuplicate ? 'border-rose-400 focus:border-rose-500' : 'border-slate-200 focus:border-sky-500'
                              }`}
                            />
                            {isDuplicate && (
                              <p className="mt-1 flex items-center gap-1 text-[10px] text-rose-600">
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                Duplicate Section — only one mapping will apply.
                              </p>
                            )}
                          </td>
                          <td className="py-2 px-3.5">
                            <input
                              type="text"
                              value={rule.mailbox}
                              placeholder="prestigeagents@thecontactcenter.ae"
                              onChange={(e) => handleUpdateSectionMailboxRule(index, { mailbox: e.target.value })}
                              className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500"
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
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {hasDuplicateSections && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Each Section can only be mapped once (case and spacing don't count as different). Resolve the
                    highlighted row(s) before continuing — Next/Save is disabled until then.
                  </span>
                </div>
              )}

              <button
                type="button"
                onClick={handleAddSectionMailboxRule}
                className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center space-x-1.5 border border-indigo-200 shadow-2xs transition-all"
              >
                <Plus className="w-3 h-3" />
                <span>Add mapping</span>
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <p className="text-[11px] text-slate-500">
                  Fills the CC line on EMAIL_STAFF_CC_MANAGER drafts. No manager data exists in any uploaded file (Cognos, ASPECT) — this is the only way to supply it now. Optional: an employee with no mapping here simply drafts with no CC, never an error.
                </p>
                <label className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200 shadow-2xs transition-all cursor-pointer shrink-0">
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
                    {draft.employeeManagerMap.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-3 px-3.5 text-slate-400 font-sans">
                          No manager mappings configured yet.
                        </td>
                      </tr>
                    )}
                    {draft.employeeManagerMap.map((rule, index) => (
                      <tr key={index} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2 px-3.5">
                          <input
                            type="text"
                            value={rule.empId}
                            placeholder="e.g. 4500116"
                            onChange={(e) => handleUpdateEmployeeManagerRule(index, { empId: e.target.value })}
                            className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500"
                          />
                        </td>
                        <td className="py-2 px-3.5">
                          <input
                            type="text"
                            value={rule.managerEmail}
                            placeholder="manager@thecontactcentre.ae"
                            onChange={(e) => handleUpdateEmployeeManagerRule(index, { managerEmail: e.target.value })}
                            className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500"
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
                type="button"
                onClick={handleAddEmployeeManagerRule}
                className="px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center space-x-1.5 border border-indigo-200 shadow-2xs transition-all"
              >
                <Plus className="w-3 h-3" />
                <span>Add mapping</span>
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {EMAIL_TEMPLATE_KEYS.map(key => (
                <div key={key} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <h5 className="text-xs font-bold text-slate-900">{EMAIL_TEMPLATE_LABELS[key]}</h5>
                    <button
                      onClick={() => handleResetTemplate(key)}
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
                    value={draft.emailTemplates[key].subject}
                    onChange={(e) => handleUpdateTemplate(key, { subject: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs shadow-2xs focus:outline-none focus:border-sky-500"
                  />
                  <textarea
                    rows={7}
                    value={draft.emailTemplates[key].body}
                    onChange={(e) => handleUpdateTemplate(key, { body: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-mono leading-relaxed shadow-2xs focus:outline-none focus:border-sky-500"
                  />
                  {/* An unknown placeholder is not an error anywhere downstream:
                      renderTemplateText leaves the literal {{token}} in place and
                      records a warning that nothing used to read, so the raw
                      braces shipped straight into the Outlook subject line. */}
                  {templateWarnings[key].length > 0 && (
                    <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-800">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        {templateWarnings[key].join(' ')} These will appear literally in the drafted email — use one of the placeholders listed above.
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose} className="rounded border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100">
              Cancel
            </button>
            {hasTemplateWarnings && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Some templates use unknown placeholders — see step 3.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep(prev => prev - 1)}
                className="rounded border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Back
              </button>
            )}
            {step < STEP_COUNT ? (
              <button
                type="button"
                onClick={() => setStep(prev => prev + 1)}
                disabled={hasDuplicateSections}
                title={hasDuplicateSections ? 'Resolve the duplicate Section mapping(s) first.' : undefined}
                className="rounded bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:hover:bg-slate-300"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinish}
                disabled={hasDuplicateSections}
                title={hasDuplicateSections ? 'Resolve the duplicate Section mapping(s) first.' : undefined}
                className="rounded bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:hover:bg-slate-300"
              >
                Save & Finish
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
