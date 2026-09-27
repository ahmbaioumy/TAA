import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { PolicyBandIssue } from '../services/configRegistry';

interface BandIssuesModalProps {
  isOpen: boolean;
  onClose: () => void;
  issues: PolicyBandIssue[];
}

export function BandIssuesModal({ isOpen, onClose, issues }: BandIssuesModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-amber-300 bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <h3 className="text-sm font-bold text-amber-950">Band Table Issues</h3>
              <p className="mt-1 text-xs text-amber-800">
                {issues.length} problem{issues.length === 1 ? '' : 's'} found — fix before running payroll corrections
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} title="Close" className="rounded p-1 text-amber-700 hover:bg-amber-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1.5 overflow-y-auto p-5 text-xs">
          {issues.map((issue, i) => (
            <div key={i} className={issue.severity === 'ERROR' ? 'text-rose-800' : 'text-amber-800'}>
              <strong>{issue.severity}</strong> · {issue.segmentType} ({issue.tier}): {issue.message}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
