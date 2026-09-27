import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { VerificationFailedCheck } from '../types/taa';
import {
  VERIFICATION_OVERRIDE_MIN_REASON_LENGTH,
  VERIFICATION_OVERRIDE_PHRASE,
  isVerificationOverrideValid,
} from '../services/verificationAudit';

interface VerificationOverrideModalProps {
  failedChecks: VerificationFailedCheck[];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function VerificationOverrideModal({ failedChecks, onCancel, onConfirm }: VerificationOverrideModalProps) {
  const [phrase, setPhrase] = useState('');
  const [reason, setReason] = useState('');
  const canConfirm = isVerificationOverrideValid(phrase, reason);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-rose-300 bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-rose-200 bg-rose-50 px-5 py-4">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-700" />
            <div>
              <h3 className="text-sm font-bold text-rose-950">Payroll verification override</h3>
              <p className="mt-1 text-xs text-rose-800">Calculation checks are failing. This acknowledgement is recorded with the payroll output.</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} title="Close" className="rounded p-1 text-rose-700 hover:bg-rose-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          <div className="max-h-52 overflow-y-auto rounded border border-slate-200">
            {failedChecks.map(check => (
              <div key={`${check.suite}-${check.id}`} className="border-b border-slate-100 px-3 py-2 text-xs last:border-b-0">
                <div className="font-semibold text-slate-900">{check.suite === 'regression' ? 'Regression' : 'Trust Matrix'} · {check.id} · {check.name}</div>
                <div className="mt-1 text-slate-600">Expected: {check.expected}</div>
                <div className="text-rose-700">Actual: {check.actual}</div>
              </div>
            ))}
          </div>

          <label className="block text-xs font-semibold text-slate-800">
            Reason for proceeding
            <textarea
              value={reason}
              onChange={event => setReason(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-normal focus:border-rose-500 focus:outline-none"
              placeholder={`Required, at least ${VERIFICATION_OVERRIDE_MIN_REASON_LENGTH} characters`}
            />
          </label>

          <label className="block text-xs font-semibold text-slate-800">
            Type <span className="font-mono text-rose-800">{VERIFICATION_OVERRIDE_PHRASE}</span>
            <input
              value={phrase}
              onChange={event => setPhrase(event.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono font-normal focus:border-rose-500 focus:outline-none"
              autoComplete="off"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button type="button" onClick={onCancel} className="rounded border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100">Cancel</button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(reason.trim())}
            className="rounded bg-rose-700 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Authorize this calculation
          </button>
        </div>
      </div>
    </div>
  );
}
