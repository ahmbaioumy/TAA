import React, { useEffect, useState } from 'react';
import { normalizeEmailZipThreshold } from '../services/configRegistry';

interface EmailZipSettingsProps {
  enabled: boolean;
  threshold: number;
  onChange: (next: { emailZipEnabled: boolean; emailZipThreshold: number }) => void;
}

// Shared by the Email Config wizard and the Config Registry so the two can't
// drift. The threshold is edited as text and normalized (whole number >= 1) on
// every valid keystroke and on blur — normalizing a transiently blank field
// mid-typing would snap it back to the default under the operator's cursor.
export function EmailZipSettings({ enabled, threshold, onChange }: EmailZipSettingsProps) {
  const [thresholdText, setThresholdText] = useState(String(threshold));
  useEffect(() => { setThresholdText(String(threshold)); }, [threshold]);

  return (
    <div className="block rounded-lg border border-slate-200 bg-white px-3 py-2.5 space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ emailZipEnabled: e.target.checked, emailZipThreshold: threshold })}
          className="h-3.5 w-3.5 accent-sky-600"
        />
        <span className="text-[11px] font-semibold text-slate-700">Bundle drafts into a single .zip</span>
      </label>
      <label className={`flex items-center gap-2 ${enabled ? '' : 'opacity-50'}`}>
        <span className="text-[11px] text-slate-600">when the batch has at least</span>
        <input
          type="number"
          min={1}
          step={1}
          disabled={!enabled}
          value={thresholdText}
          onChange={(e) => {
            setThresholdText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 1) {
              onChange({ emailZipEnabled: enabled, emailZipThreshold: normalizeEmailZipThreshold(n) });
            }
          }}
          onBlur={() => {
            const next = normalizeEmailZipThreshold(thresholdText);
            setThresholdText(String(next));
            onChange({ emailZipEnabled: enabled, emailZipThreshold: next });
          }}
          className="w-16 px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-sky-500 disabled:bg-slate-50"
        />
        <span className="text-[11px] text-slate-600">drafts</span>
      </label>
      <span className="block text-[10px] text-slate-500">
        On: a Draft Emails batch at or above this count downloads as one .zip of .eml files — avoids the browser's "download multiple files" prompt. Extract it, then double-click each .eml. Off: every draft downloads as its own .eml file.
      </span>
    </div>
  );
}
