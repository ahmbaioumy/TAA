import React, { useMemo, useRef } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, Sparkles, SlidersHorizontal, BookOpen, Layers, Loader2, RefreshCw } from 'lucide-react';
import { decodeFileBuffer, parseCognosReport, parseAspectSegments, parseAspectIdentity, validateCmsFile, dedupeCmsPunches, extractDistinctSegmentCodes, detectDateFormatAmbiguity, parseDateTimeString, formatDateDDMMYYYY } from '../services/parsers';
import { CognosRecord, AspectSegment, AspectIdentity, CMSPunch, ConfigRegistry } from '../types/taa';

// Phase 1 fix: the card used to show only the EXPECTED filename template even
// once a different real file was loaded (e.g. "MTD_Seg.csv" uploaded into the
// "ASPECT_Schdule_Segments.csv"-labelled slot still showed the template) — a
// stale or swapped-in file was visually indistinguishable from the right one.
// Once a slot is populated, show what was actually loaded instead.
function formatDateRangeLabel(dates: Date[]): string | null {
  if (dates.length === 0) return null;
  let min = dates[0];
  let max = dates[0];
  for (const d of dates) {
    if (d.getTime() < min.getTime()) min = d;
    if (d.getTime() > max.getTime()) max = d;
  }
  const minStr = formatDateDDMMYYYY(min);
  const maxStr = formatDateDDMMYYYY(max);
  return minStr === maxStr ? minStr : `${minStr}–${maxStr}`;
}

export type CmsAutoStatus = 'idle' | 'running' | 'failed';

interface UploadZoneProps {
  cognosRecords: CognosRecord[];
  setCognosRecords: (records: CognosRecord[]) => void;
  aspectSegments: AspectSegment[];
  setAspectSegments: (segments: AspectSegment[]) => void;
  aspectIdentities: AspectIdentity[];
  setAspectIdentities: (identities: AspectIdentity[]) => void;
  cmsPunches: CMSPunch[];
  setCmsPunches: (punches: CMSPunch[]) => void;
  onOpenGlossary: () => void;
  onOpenColumnMapper: (fileType: 'aspect' | 'cognos' | 'cms' | 'identity') => void;
  discoveredCodesCount: number;
  // Count of discoveredCodesCount's codes that have no glossary entry at all
  // — the class of code the engine holds rows for (UNCLASSIFIED_SEGMENT_CODE).
  unclassifiedCodesCount: number;
  config: ConfigRegistry;
  onFileTextCaptured: (type: 'aspect' | 'cognos' | 'cms' | 'identity', text: string, fileName: string) => void;
  // Phase 1: actual uploaded filename per slot (captured by onFileTextCaptured,
  // stored in App.tsx) — shown once a slot is populated so a stale/wrong file
  // is visually distinguishable from the correct one at a glance.
  inputFileNames: { cognos: string; aspect: string; identity: string; cms: string };
  // Called whenever a fresh upload or remap is about to replace previously
  // parsed data — invalidates any calculated results/downloads still on
  // screen so a stale output never survives a changed input.
  onDataChanged: () => void;
  // CMS is automated once a project folder is connected — these drive the
  // 4th card's status display instead of a manual drop zone. When
  // cmsAutomationActive is false, the card falls back to manual upload
  // exactly as before (non-Chromium browser, or no folder granted).
  cmsAutomationActive: boolean;
  cmsAutoStatus: CmsAutoStatus;
  onRunCmsExportNow: () => void;
}

export function UploadZone({
  cognosRecords,
  setCognosRecords,
  aspectSegments,
  setAspectSegments,
  aspectIdentities,
  setAspectIdentities,
  cmsPunches,
  setCmsPunches,
  onOpenGlossary,
  onOpenColumnMapper,
  discoveredCodesCount,
  unclassifiedCodesCount,
  config,
  onFileTextCaptured,
  onDataChanged,
  cmsAutomationActive,
  cmsAutoStatus,
  onRunCmsExportNow,
  inputFileNames,
}: UploadZoneProps) {
  const aspectInputRef = useRef<HTMLInputElement>(null);
  const cognosInputRef = useRef<HTMLInputElement>(null);

  // Phase 1: date range detected in each populated file, from the fields
  // already parsed for that type — same source values assessDateOverlap /
  // assessCmsCoverage already derive elsewhere, just surfaced here per-card.
  const cognosDateRange = useMemo(() => formatDateRangeLabel(
    cognosRecords.map(r => parseDateTimeString(r['SIGN IN DATE'])).filter((d): d is Date => d !== null)
  ), [cognosRecords]);
  const aspectDateRange = useMemo(() => formatDateRangeLabel(
    aspectSegments.map(s => parseDateTimeString(s.NOM_DATE)).filter((d): d is Date => d !== null)
  ), [aspectSegments]);
  const cmsDateRange = useMemo(() => formatDateRangeLabel(
    cmsPunches.map(p => p.LoginDateTime)
  ), [cmsPunches]);
  const cmsInputRef = useRef<HTMLInputElement>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);

  // Defect fix: the "Map" button used to only appear once a file had already
  // parsed successfully — making it unreachable on the exact header-drift
  // case it exists to fix. It's now reachable as soon as ANY file has been
  // uploaded for that slot, parsed or not.
  const [hasUploadedRaw, setHasUploadedRaw] = React.useState<Record<'aspect' | 'cognos' | 'cms' | 'identity', boolean>>({
    aspect: false,
    cognos: false,
    cms: false,
    identity: false,
  });

  const handleFileUpload = async (
    file: File,
    type: 'aspect' | 'cognos' | 'identity'
  ) => {
    try {
      const buffer = await file.arrayBuffer();
      const decodedText = decodeFileBuffer(buffer);
      onFileTextCaptured(type, decodedText, file.name);
      onDataChanged();
      setHasUploadedRaw(prev => ({ ...prev, [type]: true }));
      // A file with real content but only a header line (or nothing) parses
      // to a legitimately empty result; more than ~2 non-blank lines that
      // still yields 0 rows means every row was silently rejected — almost
      // always a renamed/reordered header. Surface it instead of leaving the
      // upload card sitting at "Required" with no explanation.
      const nonBlankLineCount = decodedText.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0).length;
      const likelyHeaderDrift = nonBlankLineCount > 2;

      if (type === 'aspect') {
        const segs = parseAspectSegments(decodedText);
        setAspectSegments(segs);
        if (segs.length === 0 && likelyHeaderDrift) {
          alert(`"${file.name}" has ${nonBlankLineCount} rows but none could be matched to the expected ASPECT columns (EMP_ID, NOM_DATE, SEG_CODE). This usually means a column header was renamed or reordered. Opening the column mapper so you can fix it.`);
          onOpenColumnMapper('aspect');
        } else if (detectDateFormatAmbiguity(segs.map(s => s.NOM_DATE))) {
          // Advisory only, never blocks — every NOM_DATE parsed but every one has a day <=12,
          // so this file's dates are equally consistent with MM/DD/YYYY. If the export is
          // actually US-locale, every date is silently transposed with no parse error at all.
          alert(`"${file.name}": every NOM_DATE has a day of month <= 12, which is also consistent with a US-style MM/DD/YYYY export. This file is being read as DD/MM/YYYY. If the export tool used a different locale, every date here would be silently wrong (day and month swapped) — worth a quick check against the source.`);
        }
      } else if (type === 'cognos') {
        const records = parseCognosReport(decodedText, config.cognosDropPatterns);
        setCognosRecords(records);
        if (records.length === 0 && likelyHeaderDrift) {
          alert(`"${file.name}" has ${nonBlankLineCount} rows but none could be parsed as Cognos records. Check that this is the UTF-16 tab-delimited discrepancy report, or that no expected column header was renamed.`);
          onOpenColumnMapper('cognos');
        } else if (detectDateFormatAmbiguity(records.map(r => r['SIGN IN DATE']))) {
          alert(`"${file.name}": every SIGN IN DATE has a day of month <= 12, which is also consistent with a US-style MM/DD/YYYY export. This file is being read as DD/MM/YYYY. If the export tool used a different locale, every date here would be silently wrong (day and month swapped) — worth a quick check against the source.`);
        }
      } else if (type === 'identity') {
        const identities = parseAspectIdentity(decodedText);
        setAspectIdentities(identities);
        if (identities.length === 0 && likelyHeaderDrift) {
          alert(`"${file.name}" has ${nonBlankLineCount} rows but none could be matched to the expected identity columns (EMP_ID). This usually means a column header was renamed or reordered.`);
          onOpenColumnMapper('identity');
        }
      }
    } catch (err) {
      console.error(`Failed to parse ${type} file`, err);
      alert(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // CMS supports multi-file upload: every selected/dropped file must match
  // the fixed CMS export schema (column names, order, and per-column data
  // type — see validateCmsFile) or the ENTIRE batch is rejected with no
  // change to cmsPunches. Files that all pass are merged with whatever CMS
  // punches are already loaded (accumulate, not replace) and deduped.
  const handleCmsFilesUpload = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const decodedByFile: { name: string; text: string }[] = [];
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        decodedByFile.push({ name: file.name, text: decodeFileBuffer(buffer) });
      }
      // Last file's text feeds the column mapper preview/raw-text capture,
      // matching the single-file behavior other cards use.
      onFileTextCaptured('cms', decodedByFile[decodedByFile.length - 1].text, decodedByFile.map(file => file.name).join('; '));
      setHasUploadedRaw(prev => ({ ...prev, cms: true }));

      const batchPunches: CMSPunch[] = [];
      for (const { name, text } of decodedByFile) {
        const result = validateCmsFile(text, name);
        if ('reason' in result) {
          alert(result.reason);
          return; // reject the whole batch — no state changes
        }
        batchPunches.push(...result.punches);
      }

      onDataChanged();
      setCmsPunches(dedupeCmsPunches([...cmsPunches, ...batchPunches]));
    } catch (err) {
      console.error('Failed to parse CMS file(s)', err);
      alert(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDrop = (e: React.DragEvent, type: 'aspect' | 'cognos' | 'cms' | 'identity') => {
    e.preventDefault();
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    if (type === 'cms') {
      handleCmsFilesUpload(Array.from(e.dataTransfer.files));
    } else {
      handleFileUpload(e.dataTransfer.files[0], type);
    }
  };

  // Phase 8: guided upload sequence — CMS, ASPECT Segments, ASPECT ExtraFiled
  // (Identity), Cognos. A step is locked (upload disabled, greyed) only while
  // it is itself still empty AND some earlier step is also still empty; once
  // a step has data it is never locked again (clicking a filled card always
  // re-opens its picker to replace just that slot, unchanged from today's
  // behavior — this is how the MTD_Seg.csv correction earlier in this
  // project's history worked without touching any other slot). A bulk load
  // (Load Sample Data, Config Registry import) that fills all 4 at once
  // bypasses the chain entirely: every step already has data, so nothing is
  // ever locked — this is a guided-manual-upload aid, not a data gate.
  const STEP_LENGTHS = [cmsPunches.length, aspectSegments.length, aspectIdentities.length, cognosRecords.length];
  const STEP_NAMES = ['Avaya CMS Punches', 'ASPECT Segments', 'ASPECT ExtraFiled (Identity)', 'Cognos Report'];
  const isStepLocked = (stepIndex: number) =>
    STEP_LENGTHS[stepIndex] === 0 && STEP_LENGTHS.slice(0, stepIndex).some(n => n === 0);

  return (
    <div className="space-y-6">
      {/* File Upload Grid — Phase 8 guided order: CMS, ASPECT Segments,
          ASPECT ExtraFiled (Identity), Cognos. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Avaya CMS Punches — automated once a project folder is
            connected (§6.1a); falls back to manual upload otherwise. Always
            step 0: nothing is ever locked ahead of it. */}
        <div
          onDragOver={(e) => cmsAutomationActive || e.preventDefault()}
          onDrop={(e) => !cmsAutomationActive && handleDrop(e, 'cms')}
          onClick={() => !cmsAutomationActive && cmsInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 transition-all duration-200 flex flex-col justify-between ${
            cmsAutomationActive ? 'cursor-default' : 'cursor-pointer'
          } ${
            cmsPunches.length > 0
              ? 'border-emerald-400 bg-emerald-50/40 hover:bg-emerald-50/60 shadow-xs'
              : cmsAutoStatus === 'running'
                ? 'border-indigo-300 bg-indigo-50/40 shadow-xs'
                : cmsAutoStatus === 'failed'
                  ? 'border-rose-300 bg-rose-50/40 shadow-xs'
                  : 'border-slate-200 bg-white hover:border-indigo-500 hover:bg-slate-50/50 shadow-xs'
          }`}
        >
          <input
            ref={cmsInputRef}
            type="file"
            accept=".csv,.txt"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && e.target.files.length > 0 && handleCmsFilesUpload(Array.from(e.target.files))}
          />
          <div>
            <div className="flex items-start justify-between">
              <div className="p-3 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 shadow-xs">
                {cmsAutoStatus === 'running' && cmsPunches.length === 0 ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
              </div>
              {cmsPunches.length > 0 ? (
                <span className="flex items-center text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2.5 py-0.5 rounded-full border border-emerald-200 uppercase tracking-wider">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {cmsPunches.length} punches
                </span>
              ) : cmsAutomationActive && cmsAutoStatus === 'running' ? (
                <span className="text-[10px] font-bold text-indigo-600 bg-indigo-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-indigo-200">
                  Running…
                </span>
              ) : cmsAutomationActive && cmsAutoStatus === 'failed' ? (
                <span className="text-[10px] font-bold text-rose-700 bg-rose-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-rose-200">
                  Failed — Manual
                </span>
              ) : (
                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Required
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-slate-900 mt-4 flex items-center gap-1.5">
              1. Avaya CMS Punches
            </h3>
            {cmsPunches.length > 0 ? (
              <p className="text-xs text-slate-500 mt-1 truncate" title={inputFileNames.cms}>
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">{inputFileNames.cms || 'unnamed file'}</code>
                {' · '}{cmsPunches.length} punches{cmsDateRange ? ` · ${cmsDateRange}` : ''}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">CMS_Login_logout.csv</code> (Time-window join)
              </p>
            )}
          </div>

          <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            {cmsAutomationActive && cmsPunches.length === 0 ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRunCmsExportNow(); }}
                disabled={cmsAutoStatus === 'running'}
                className="text-indigo-600 hover:text-indigo-700 font-bold flex items-center space-x-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{cmsAutoStatus === 'failed' ? 'Retry CMS Export' : 'Run CMS Export Now'}</span>
              </button>
            ) : (
              <span className="text-slate-400 font-medium">
                {cmsAutomationActive ? 'Auto-loaded' : cmsPunches.length > 0 ? 'Drop CSV(s) or Click to Replace' : 'Drop CSV(s) or Click'}
              </span>
            )}
            {/* No "Map" button here: CMS uses fixed column POSITIONS per the
                documented export format, not header names — the real file's
                own header row repeats "Login Time"/"Logout Time" for two
                different columns, so a name-based remap would be ambiguous.
                A layout mismatch is reported via the alert on 0 rows instead. */}
          </div>
        </div>

        {/* 2. ASPECT Segments — step 1: locked until CMS (step 0) has data. */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { if (isStepLocked(1)) { e.preventDefault(); return; } handleDrop(e, 'aspect'); }}
          onClick={() => !isStepLocked(1) && aspectInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 transition-all duration-200 flex flex-col justify-between ${
            isStepLocked(1)
              ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
              : aspectSegments.length > 0
                ? 'border-emerald-400 bg-emerald-50/40 hover:bg-emerald-50/60 shadow-xs cursor-pointer'
                : 'border-slate-200 bg-white hover:border-indigo-500 hover:bg-slate-50/50 shadow-xs cursor-pointer'
          }`}
        >
          <input
            ref={aspectInputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0], 'aspect')}
          />
          <div>
            <div className="flex items-start justify-between">
              <div className="p-3 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100 shadow-xs">
                <FileText className="w-5 h-5" />
              </div>
              {aspectSegments.length > 0 ? (
                <span className="flex items-center text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2.5 py-0.5 rounded-full border border-emerald-200 uppercase tracking-wider">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {aspectSegments.length} rows
                </span>
              ) : isStepLocked(1) ? (
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Locked
                </span>
              ) : (
                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Required
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-slate-900 mt-4 flex items-center gap-1.5">
              2. ASPECT Segments
            </h3>
            {aspectSegments.length > 0 ? (
              <p className="text-xs text-slate-500 mt-1 truncate" title={inputFileNames.aspect}>
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">{inputFileNames.aspect || 'unnamed file'}</code>
                {' · '}{aspectSegments.length} rows{aspectDateRange ? ` · ${aspectDateRange}` : ''}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">ASPECT_Schdule_Segments.csv</code> (Shifts, leaves, releases)
              </p>
            )}
          </div>

          <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400 font-medium">
              {isStepLocked(1) ? `Upload ${STEP_NAMES[0]} first` : aspectSegments.length > 0 ? 'Drop CSV or Click to Replace' : 'Drop CSV or Click'}
            </span>
            {hasUploadedRaw.aspect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenColumnMapper('aspect');
                }}
                className="text-indigo-600 hover:text-indigo-700 font-bold flex items-center space-x-1"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>Map</span>
              </button>
            )}
          </div>
        </div>

        {/* 3. Identity Master (ASPECT ExtraFiled) — step 2: locked until CMS
            and ASPECT Segments (steps 0-1) both have data. */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { if (isStepLocked(2)) { e.preventDefault(); return; } handleDrop(e, 'identity'); }}
          onClick={() => !isStepLocked(2) && identityInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 transition-all duration-200 flex flex-col justify-between ${
            isStepLocked(2)
              ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
              : aspectIdentities.length > 0
                ? 'border-emerald-400 bg-emerald-50/40 hover:bg-emerald-50/60 shadow-xs cursor-pointer'
                : 'border-slate-200 bg-white hover:border-indigo-500 hover:bg-slate-50/50 shadow-xs cursor-pointer'
          }`}
        >
          <input
            ref={identityInputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0], 'identity')}
          />
          <div>
            <div className="flex items-start justify-between">
              <div className="p-3 rounded-xl bg-purple-50 text-purple-600 border border-purple-100 shadow-xs">
                <Layers className="w-5 h-5" />
              </div>
              {aspectIdentities.length > 0 ? (
                <span className="flex items-center text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2.5 py-0.5 rounded-full border border-emerald-200 uppercase tracking-wider">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {aspectIdentities.length} staff
                </span>
              ) : isStepLocked(2) ? (
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Locked
                </span>
              ) : (
                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Required
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-slate-900 mt-4 flex items-center gap-1.5">
              3. ASPECT ExtraFiled (Identity)
            </h3>
            {aspectIdentities.length > 0 ? (
              <p className="text-xs text-slate-500 mt-1 truncate" title={inputFileNames.identity}>
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">{inputFileNames.identity || 'unnamed file'}</code>
                {' · '}{aspectIdentities.length} staff
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">ASPECT_ExtraFiled.csv</code> (21-col Exchange Aliases)
              </p>
            )}
          </div>

          <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400 font-medium">
              {isStepLocked(2) ? `Upload ${STEP_NAMES.slice(0, 2).join(' and ')} first` : aspectIdentities.length > 0 ? 'Drop CSV or Click to Replace' : 'Drop CSV or Click'}
            </span>
            {hasUploadedRaw.identity && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenColumnMapper('identity');
                }}
                className="text-purple-600 hover:text-purple-700 font-bold flex items-center space-x-1"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>Map</span>
              </button>
            )}
          </div>
        </div>

        {/* 4. Cognos Discrepancy Report — step 3: locked until steps 0-2 all
            have data. */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { if (isStepLocked(3)) { e.preventDefault(); return; } handleDrop(e, 'cognos'); }}
          onClick={() => !isStepLocked(3) && cognosInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 transition-all duration-200 flex flex-col justify-between ${
            isStepLocked(3)
              ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
              : cognosRecords.length > 0
                ? 'border-emerald-400 bg-emerald-50/40 hover:bg-emerald-50/60 shadow-xs cursor-pointer'
                : 'border-slate-200 bg-white hover:border-indigo-500 hover:bg-slate-50/50 shadow-xs cursor-pointer'
          }`}
        >
          <input
            ref={cognosInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0], 'cognos')}
          />
          <div>
            <div className="flex items-start justify-between">
              <div className="p-3 rounded-xl bg-sky-50 text-sky-600 border border-sky-100 shadow-xs">
                <FileText className="w-5 h-5" />
              </div>
              {cognosRecords.length > 0 ? (
                <span className="flex items-center text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2.5 py-0.5 rounded-full border border-emerald-200 uppercase tracking-wider">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                  {cognosRecords.length} rows
                </span>
              ) : isStepLocked(3) ? (
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Locked
                </span>
              ) : (
                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-slate-200">
                  Required
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-slate-900 mt-4 flex items-center gap-1.5">
              4. Cognos Report
            </h3>
            {cognosRecords.length > 0 ? (
              <p className="text-xs text-slate-500 mt-1 truncate" title={inputFileNames.cognos}>
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">{inputFileNames.cognos || 'unnamed file'}</code>
                {' · '}{cognosRecords.length} rows{cognosDateRange ? ` · ${cognosDateRange}` : ''}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                <code className="text-slate-700 font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">Cognos_DescrepencyReport.csv</code> (UTF-16 LE Tab)
              </p>
            )}
          </div>

          <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400 font-medium">
              {isStepLocked(3) ? `Upload ${STEP_NAMES.slice(0, 3).join(', ')} first` : cognosRecords.length > 0 ? 'Drop CSV/TSV or Click to Replace' : 'Drop CSV/TSV or Click'}
            </span>
            {hasUploadedRaw.cognos && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenColumnMapper('cognos');
                }}
                className="text-sky-600 hover:text-sky-700 font-bold flex items-center space-x-1"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>Map</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Discovery Segment Glossary Banner */}
      {aspectSegments.length > 0 && (
        <div className="bg-indigo-50/70 border border-indigo-200/80 rounded-2xl p-5 flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-3.5">
            <div className="p-2.5 rounded-xl bg-indigo-600 text-white shadow-xs shadow-indigo-200">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900">Discovery-Driven Segment Glossary</h4>
              <p className="text-xs text-slate-600 mt-0.5">
                {discoveredCodesCount} distinct segment codes detected in current ASPECT upload. Classified into Addition (+), Removal (-), or No Effect.
              </p>
              {unclassifiedCodesCount > 0 && (
                <p className="text-xs font-bold text-red-600 mt-1">
                  {unclassifiedCodesCount} unclassified segment code{unclassifiedCodesCount === 1 ? '' : 's'} in this upload — classify {unclassifiedCodesCount === 1 ? 'it' : 'them'} to unlock held days.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenGlossary}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center space-x-1.5 shadow-sm shadow-indigo-200 transition-all"
          >
            <span>Review Classifications</span>
          </button>
        </div>
      )}
    </div>
  );
}
