import React, { useMemo, useState } from 'react';
import { FileText, Layers, BookOpen, CheckCircle2, XCircle, RefreshCw, Play } from 'lucide-react';
import { EXPECTED_COLUMNS, resolveMappedHeader } from './ColumnMappingModal';
import { extractHeaders, describeCmsHeaderStatus } from '../services/parsers';

export type MappableFileType = 'cognos' | 'aspect' | 'identity' | 'cms';
/** CMS is position-based and has no name mapping — see FILE_SECTIONS below. */
export type RemappableFileType = Exclude<MappableFileType, 'cms'>;

interface FieldReferenceViewProps {
  rawFileTexts: Partial<Record<MappableFileType, string>>;
  columnMappings: Partial<Record<RemappableFileType, Record<string, string>>>;
  inputFileNames: Record<MappableFileType, string>;
  rowCounts: Record<MappableFileType, number>;
  onApplyMapping: (fileType: RemappableFileType, mapping: Record<string, string>) => void;
  onApplyMappingAndRecalculate: (fileType: RemappableFileType, mapping: Record<string, string>) => void;
  canCalculate: boolean;
  isCalculating: boolean;
}

// Generated from the exact same EXPECTED_COLUMNS object the Map modal uses, so
// this page can never show a field the Map UI doesn't also let you remap.
const FILE_SECTIONS: {
  type: MappableFileType;
  title: string;
  shortLabel: string;
  filename: string;
  note: string;
  remappable: boolean;
}[] = [
  {
    type: 'cognos',
    title: '1. Cognos Report',
    shortLabel: 'Cognos',
    filename: 'Cognos_DescrepencyReport.csv',
    note: 'UTF-16 LE, tab-delimited. Remappable here or via the Map button on the upload card.',
    remappable: true,
  },
  {
    type: 'aspect',
    title: '2. ASPECT Segments',
    shortLabel: 'ASPECT Segments',
    filename: 'ASPECT_Schdule_Segments.csv',
    note: 'Shifts, leaves, releases — one row per schedule segment. Remappable here or via the Map button.',
    remappable: true,
  },
  {
    type: 'identity',
    title: '3. ASPECT ExtraFiled (Identity)',
    shortLabel: 'ASPECT ExtraFiled',
    filename: 'ASPECT_ExtraFiled.csv',
    note: '21-column Exchange Aliases export, one row per employee. Remappable here or via the Map button.',
    remappable: true,
  },
  {
    type: 'cms',
    title: '4. Avaya CMS Punches',
    shortLabel: 'Avaya CMS',
    filename: 'CMS_Login_logout.csv',
    note: 'Columns are matched by fixed POSITION, not by name, and cannot be remapped in this app — the real export\'s header row repeats "Login Time"/"Logout Time" for two different columns, which makes a name-based remap ambiguous. A layout mismatch can only be fixed by re-exporting in the exact column order below.',
    remappable: false,
  },
];

const ICONS: Record<MappableFileType, React.ComponentType<{ className?: string }>> = {
  cognos: FileText,
  aspect: FileText,
  identity: Layers,
  cms: FileText,
};

function StatusPill({ ok, required, text }: { ok: boolean; required: boolean; text: string }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        {text}
      </span>
    );
  }
  // An absent OPTIONAL column is a normal, valid state — only a missing
  // REQUIRED column is an error, so it must not be coloured like one.
  return required ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700">
      <XCircle className="w-3.5 h-3.5 shrink-0" />
      {text}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400">
      <XCircle className="w-3.5 h-3.5 shrink-0" />
      {text}
    </span>
  );
}

export function FieldReferenceView({
  rawFileTexts,
  columnMappings,
  inputFileNames,
  rowCounts,
  onApplyMapping,
  onApplyMappingAndRecalculate,
  canCalculate,
  isCalculating,
}: FieldReferenceViewProps) {
  const [activeType, setActiveType] = useState<MappableFileType>('cognos');
  // Draft edits live here until the user saves, so switching tabs mid-edit
  // never silently applies a half-finished remap.
  const [draft, setDraft] = useState<Partial<Record<RemappableFileType, Record<string, string>>>>({});

  const section = FILE_SECTIONS.find(s => s.type === activeType)!;
  const Icon = ICONS[activeType];
  const rawText = rawFileTexts[activeType];
  const uploaded = !!rawText;
  const columns = EXPECTED_COLUMNS[activeType] || [];

  const detectedHeaders = useMemo(
    // extractHeaders reads row 0 only, which is wrong for CMS exports (they
    // carry preamble rows above the header) — CMS uses describeCmsHeaderStatus.
    () => (rawText && activeType !== 'cms' ? extractHeaders(rawText) : []),
    [rawText, activeType]
  );

  const cmsStatus = useMemo(
    () => (rawText && activeType === 'cms' ? describeCmsHeaderStatus(rawText) : null),
    [rawText, activeType]
  );

  const remappable = section.remappable ? (activeType as RemappableFileType) : null;
  const savedMapping = remappable ? columnMappings[remappable] : undefined;
  const draftMapping = remappable ? draft[remappable] : undefined;
  // Draft overlays the saved mapping so an untouched field keeps resolving the
  // way it does today (explicitly or by canonical-name fallback).
  const effectiveMapping = draftMapping ?? savedMapping;
  const isDirty = !!draftMapping;

  const resolutions = useMemo(
    () => columns.map(col => ({ col, res: resolveMappedHeader(col, detectedHeaders, effectiveMapping) })),
    [columns, detectedHeaders, effectiveMapping]
  );

  const resolvedCount = resolutions.filter(r => r.res.status !== 'UNRESOLVED').length;
  const missingRequired = resolutions.filter(r => r.col.required && r.res.status === 'UNRESOLVED');

  const handleSelect = (fileType: RemappableFileType, key: string, header: string) => {
    setDraft(prev => {
      // Seed the draft from what is currently resolved, not from the (often
      // empty) saved mapping — otherwise saving one field would blank every
      // field that was resolving by canonical-name fallback.
      const base = prev[fileType] ?? Object.fromEntries(
        resolutions.map(r => [r.col.key, r.res.header || ''])
      );
      return { ...prev, [fileType]: { ...base, [key]: header } };
    });
  };

  const clearDraft = (fileType: RemappableFileType) =>
    setDraft(prev => {
      const next = { ...prev };
      delete next[fileType];
      return next;
    });

  const handleSave = (fileType: RemappableFileType, recalculate: boolean) => {
    const mapping = draft[fileType];
    if (!mapping) return;
    if (recalculate) onApplyMappingAndRecalculate(fileType, mapping);
    else onApplyMapping(fileType, mapping);
    clearDraft(fileType);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-indigo-600" />
          Field Reference &amp; Mapping
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Every column each source file maps to, checked against what you actually uploaded. A green tick
          means the app found that column; remap anything it didn&rsquo;t find, then save and recalculate.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-slate-100/90 border border-slate-200/80 text-xs w-fit">
        {FILE_SECTIONS.map(s => {
          const has = !!rawFileTexts[s.type];
          return (
            <button
              key={s.type}
              onClick={() => setActiveType(s.type)}
              className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all ${
                activeType === s.type
                  ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              {s.shortLabel}{' '}
              <span className="text-slate-400 font-mono">
                · {has ? rowCounts[s.type].toLocaleString() : '—'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-slate-50 text-slate-600 border border-slate-100">
              <Icon className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">{section.title}</h3>
              <code className="text-[11px] font-mono text-slate-500">
                {uploaded ? inputFileNames[activeType] : section.filename}
              </code>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {uploaded && section.remappable && (
              <span
                className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border uppercase tracking-wider ${
                  missingRequired.length > 0
                    ? 'text-rose-700 bg-rose-50 border-rose-200'
                    : 'text-emerald-700 bg-emerald-100 border-emerald-200'
                }`}
              >
                {resolvedCount}/{columns.length} mapped
              </span>
            )}
            {!section.remappable && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 uppercase tracking-wider">
                Position-based
              </span>
            )}
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-2 mb-4">{section.note}</p>

        {!uploaded && (
          <div className="mb-4 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5">
            Not uploaded yet — the columns below are what this file is expected to contain. Upload it on
            the Upload &amp; Reconcile tab to see which of them were actually found.
          </div>
        )}

        {uploaded && section.remappable && missingRequired.length > 0 && (
          <div className="mb-4 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">
            <strong>{missingRequired.length} required column(s) not found</strong> in the uploaded file:{' '}
            {missingRequired.map(r => r.col.key).join(', ')}. Pick the matching column from the file below.
          </div>
        )}

        {uploaded && activeType === 'cms' && !cmsStatus && (
          <div className="mb-4 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">
            No CMS header row could be located in the uploaded file — it does not look like a CMS export.
          </div>
        )}

        <div className="overflow-x-auto">
          {activeType === 'cms' ? (
            // Read-only, position-based. Shows the real header text found at each
            // position so a layout change is diagnosable without a remap UI.
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400 uppercase tracking-wider text-[10px] border-b border-slate-100">
                  <th className="py-1.5 pr-4 font-semibold">Position</th>
                  <th className="py-1.5 pr-4 font-semibold">Expected Column</th>
                  <th className="py-1.5 pr-4 font-semibold">Found In Your File</th>
                  <th className="py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {(cmsStatus
                  ? cmsStatus.map(s => ({
                      position: s.position,
                      expectedLabel: s.expectedLabel,
                      actualHeader: s.actualHeader,
                      ok: s.ok,
                    }))
                  : ['Date', 'Login ID', 'Login Time', 'Logout Time', 'Login Time (Full)', 'Logout Time (Full)'].map(
                      (expectedLabel, position) => ({ position, expectedLabel, actualHeader: null, ok: false })
                    )
                ).map(row => (
                  <tr key={row.position} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-4 font-mono text-slate-400">Col {row.position + 1}</td>
                    <td className="py-1.5 pr-4 font-mono text-slate-700">{row.expectedLabel}</td>
                    <td className="py-1.5 pr-4 font-mono text-slate-600">
                      {row.actualHeader ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-1.5">
                      {uploaded && cmsStatus ? (
                        <StatusPill ok={row.ok} required text={row.ok ? 'Matches' : 'Wrong column'} />
                      ) : (
                        <span className="text-[11px] text-slate-400">Not uploaded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400 uppercase tracking-wider text-[10px] border-b border-slate-100">
                  <th className="py-1.5 pr-4 font-semibold">Column</th>
                  <th className="py-1.5 pr-4 font-semibold">Purpose</th>
                  <th className="py-1.5 pr-4 font-semibold">Mapped To</th>
                  <th className="py-1.5 pr-4 font-semibold">Status</th>
                  <th className="py-1.5 font-semibold">Required</th>
                </tr>
              </thead>
              <tbody>
                {resolutions.map(({ col, res }) => (
                  <tr key={col.key} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-4 font-mono text-slate-700 align-middle">{col.key}</td>
                    <td className="py-1.5 pr-4 text-slate-600 align-middle">{col.label}</td>
                    <td className="py-1.5 pr-4 align-middle">
                      {uploaded && remappable ? (
                        <select
                          value={res.header || ''}
                          onChange={e => handleSelect(remappable, col.key, e.target.value)}
                          className={`w-full min-w-[9rem] max-w-[16rem] px-2 py-1 rounded-lg bg-white border text-[11px] font-mono shadow-2xs focus:outline-none focus:border-indigo-500 ${
                            res.status === 'UNRESOLVED' && col.required
                              ? 'border-rose-300 text-rose-700'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="">— not mapped —</option>
                          {detectedHeaders.map(h => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-300 font-mono">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-4 align-middle">
                      {uploaded ? (
                        <StatusPill
                          ok={res.status !== 'UNRESOLVED'}
                          required={col.required}
                          text={
                            res.status === 'EXPLICIT'
                              ? 'Mapped'
                              : res.status === 'AUTO'
                                ? 'Auto-matched'
                                : 'Not found'
                          }
                        />
                      ) : (
                        <span className="text-[11px] text-slate-400">Not uploaded</span>
                      )}
                    </td>
                    <td className="py-1.5 align-middle">
                      {col.required ? (
                        <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
                          Required
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">Optional</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {uploaded && remappable && isDirty && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-600">
              Unsaved mapping changes.{' '}
              {missingRequired.length > 0 && (
                <span className="text-rose-700 font-semibold">
                  {missingRequired.length} required column(s) still unmapped — save is blocked.
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => clearDraft(remappable)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              >
                Discard
              </button>
              <button
                onClick={() => handleSave(remappable, false)}
                disabled={missingRequired.length > 0}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Save mapping
              </button>
              <button
                onClick={() => handleSave(remappable, true)}
                disabled={missingRequired.length > 0 || !canCalculate || isCalculating}
                title={!canCalculate ? 'All four files must be uploaded before recalculating' : undefined}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {isCalculating ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Save &amp; Recalculate
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
