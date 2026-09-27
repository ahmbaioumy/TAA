import React, { useState } from 'react';
import { X, Check, SlidersHorizontal, AlertCircle, ArrowRight } from 'lucide-react';

interface ColumnMappingModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileType: 'aspect' | 'cognos' | 'cms' | 'identity';
  detectedHeaders: string[];
  initialMapping?: Record<string, string>;
  onApplyMapping: (mapping: Record<string, string>) => void;
}

// Exported so the Field Reference page (FieldReferenceView.tsx) can list the
// exact same column set this modal offers — one source of truth, so the two
// views can never drift apart.
export const EXPECTED_COLUMNS: Record<string, { key: string; label: string; required: boolean }[]> = {
  aspect: [
    { key: 'EMP_ID', label: 'Employee ID (PF NO)', required: true },
    { key: 'NOM_DATE', label: 'Nominate Date (Schedule Day)', required: true },
    { key: 'SEG_CODE', label: 'Segment Code (SHIFT, RLS, etc.)', required: true },
    { key: 'START_MOMENT', label: 'Start Moment (Datetime/Date)', required: false },
    { key: 'STOP_MOMENT', label: 'Stop Moment (Datetime/Date)', required: false },
    { key: 'DURATION', label: 'Duration (Minutes)', required: false },
    { key: 'START_DATE', label: 'Segment Start Date', required: false },
  ],
  cognos: [
    { key: 'PF NO', label: 'Employee PF Number', required: true },
    { key: 'LOGIN ID', label: 'CMS Login ID', required: true },
    { key: 'SIGN IN DATE', label: 'Report Sign In Date', required: true },
    { key: 'DUTY1', label: 'Scheduled Duty 1 (HH:MM - HH:MM)', required: true },
    { key: 'NAME', label: 'Employee Name', required: false },
    { key: 'SECTION', label: 'Section / Department', required: false },
    { key: 'OT1', label: 'Overtime 1 Duration (H:MM)', required: false },
    { key: 'DUTY-2', label: 'Scheduled Duty 2 (Split Shift, HH:MM - HH:MM)', required: false },
    { key: 'OT-2', label: 'Overtime 2 Duration (H:MM)', required: false },
    { key: 'SCH DURATION', label: 'Scheduled Duration (H:M)', required: false },
    { key: 'SIGNIN DURATION', label: 'Cognos Staffed Duration (H:MM)', required: false },
    { key: 'SIGIN IN', label: 'Cognos First Login (HH:MM)', required: false },
    { key: 'SIGIN OUT', label: 'Cognos Last Logout (HH:MM)', required: false },
    { key: 'LATE START', label: 'Cognos Late Start Variance', required: false },
    { key: 'LEFT EARLY', label: 'Cognos Left Early Variance', required: false },
    { key: 'LEAVE TYPE', label: 'Leave Type Recorded', required: false },
    { key: 'LEAVE HR', label: 'Leave Hours (H:MM)', required: false },
    { key: 'REMARK', label: 'Remark / Carve-outs (RLS, NURSNG)', required: false },
  ],
  cms: [
    { key: 'Login ID', label: 'CMS Login ID (Col 2)', required: true },
    { key: 'Date', label: 'Date (Col 1)', required: true },
    { key: 'Login Time', label: 'Login Full Datetime (Col 5)', required: true },
    { key: 'Logout Time', label: 'Logout Full Datetime (Col 6)', required: true },
  ],
  identity: [
    { key: 'EMP_ID', label: 'Employee ID (Trimmed)', required: true },
    { key: 'EMP_LAST_NAME', label: 'Full / Last Name', required: true },
    { key: 'EMP_EXTRA_2', label: 'Corporate Alias (Exchange Username)', required: true },
    { key: 'EMP_EMAIL_ADR', label: 'Email Address (Fallback)', required: false },
    { key: 'EMP_SORT_NAME', label: 'Sort Name (Role Tier & Flex Scan)', required: false },
    { key: 'EMP_SHORT_NAME', label: 'Short Name (Role Tier & Flex Scan)', required: false },
    { key: 'EMP_FIRST_NAME', label: 'First Name (Role Tier & Flex Scan)', required: false },
    { key: 'EMP_EXTRA_4', label: 'Department / Section', required: false },
    { key: 'EMP_TERM_DATE', label: 'Termination Date', required: false },
    { key: 'EMP_ACTIVE_FLAG', label: 'Active Flag ("F" = Terminated)', required: false },
  ],
};

export type ExpectedColumn = { key: string; label: string; required: boolean };

/**
 * How an expected field ends up resolved against a real uploaded file.
 *
 * 'EXPLICIT' — the user picked this header in the Map UI, and it really exists
 *              in the uploaded file.
 * 'AUTO'     — no explicit choice, but the parsers' own fallback finds it: both
 *              getCol() (parsers.ts, ASPECT/Identity) and the Cognos aliasing
 *              look the canonical name up directly in the header row, so an
 *              un-mapped field is normally still working. This is why "mapped"
 *              can never be read off `columnMappings` alone — an empty mapping
 *              object means almost everything resolves, not that nothing does.
 * 'UNRESOLVED' — nothing in the file matches. For a required field that is a
 *              real problem; for an optional one it just means that column is
 *              absent.
 */
export type FieldResolution =
  | { status: 'EXPLICIT'; header: string }
  | { status: 'AUTO'; header: string }
  | { status: 'UNRESOLVED'; header: null };

/**
 * Single source of truth for "which uploaded column does this field read from?",
 * shared by the Map modal and the Field Reference page so the two can never
 * disagree about what counts as mapped.
 *
 * Note an explicit mapping only counts when the header it names is actually
 * present in the file. A mapping left over from a previously-uploaded file
 * would otherwise look mapped here while resolving to nothing in the parser
 * (`headers.indexOf(mappedHeader)` === -1) — and would slip past the modal's
 * required-field guard.
 */
export function resolveMappedHeader(
  expected: Pick<ExpectedColumn, 'key' | 'label'>,
  detectedHeaders: string[],
  explicitMapping?: Record<string, string>
): FieldResolution {
  const explicit = explicitMapping?.[expected.key];
  if (explicit && detectedHeaders.some(h => h.trim() === explicit.trim())) {
    return { status: 'EXPLICIT', header: explicit };
  }
  const auto = detectedHeaders.find(
    h => h.trim().toLowerCase() === expected.key.toLowerCase()
      || h.trim().toLowerCase() === expected.label.toLowerCase()
  );
  return auto ? { status: 'AUTO', header: auto } : { status: 'UNRESOLVED', header: null };
}

// Wrapper/content split so hooks are never conditional (App.tsx currently
// only mounts this component while isOpen, but the component must not rely
// on that — see DiscoveryGlossaryModal for the pattern and the reason).
export function ColumnMappingModal(props: ColumnMappingModalProps) {
  if (!props.isOpen) return null;
  return <ColumnMappingModalContent {...props} />;
}

function ColumnMappingModalContent({
  onClose,
  fileType,
  detectedHeaders,
  initialMapping,
  onApplyMapping,
}: ColumnMappingModalProps) {
  const expectedList = EXPECTED_COLUMNS[fileType] || [];
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    expectedList.forEach(exp => {
      // Reopening after a prior Apply keeps what was chosen last time; otherwise
      // the canonical-name auto-match applies. Shared with the Field Reference
      // page via resolveMappedHeader so both agree on what "mapped" means.
      initial[exp.key] = resolveMappedHeader(exp, detectedHeaders, initialMapping).header || '';
    });
    return initial;
  });

  const missingRequired = expectedList.filter(exp => exp.required && !mapping[exp.key]);

  const handleSelect = (expectedKey: string, sourceCol: string) => {
    setMapping(prev => ({
      ...prev,
      [expectedKey]: sourceCol,
    }));
  };

  const handleSave = () => {
    if (missingRequired.length > 0) return;
    onApplyMapping(mapping);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 uppercase tracking-wider">
                Column Mapping: {fileType.toUpperCase()} File
              </h3>
              <p className="text-xs text-slate-500">Match expected data fields to headers detected in uploaded file</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {expectedList.map(exp => (
            <div key={exp.key} className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div className="w-1/2">
                <div className="flex items-center space-x-1.5">
                  <span className="font-mono text-xs font-bold text-slate-900">{exp.key}</span>
                  {exp.required && (
                    <span className="text-[10px] text-rose-600 font-sans font-semibold">*Required</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500">{exp.label}</p>
              </div>

              <div className="flex items-center space-x-2 w-1/2 justify-end">
                <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <select
                  value={mapping[exp.key] || ''}
                  onChange={(e) => handleSelect(exp.key, e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 shadow-2xs font-medium"
                >
                  <option value="">-- Select Uploaded Column --</option>
                  {detectedHeaders.map(h => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {missingRequired.length > 0
              ? `Missing required: ${missingRequired.map(m => m.key).join(', ')}`
              : 'Applying will re-parse the uploaded file with this mapping.'}
          </span>
          <div className="flex items-center space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={missingRequired.length > 0}
              className={`px-5 py-2 rounded-lg text-xs font-semibold shadow-sm transition-all ${
                missingRequired.length > 0
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-200'
              }`}
            >
              Apply Mapping
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
