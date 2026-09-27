import { VerificationOverrideAudit } from '../types/taa';

export const VERIFICATION_OVERRIDE_PHRASE = 'PROCEED WITH FAILED CHECKS' as const;
export const VERIFICATION_OVERRIDE_MIN_REASON_LENGTH = 10;

export function isVerificationOverrideValid(phrase: string, reason: string): boolean {
  return phrase === VERIFICATION_OVERRIDE_PHRASE && reason.trim().length >= VERIFICATION_OVERRIDE_MIN_REASON_LENGTH;
}

export function verificationFailedCheckSummary(audit?: VerificationOverrideAudit): string {
  if (!audit || audit.failed_checks.length === 0) return '';
  return audit.failed_checks.map(check => `${check.suite}:${check.id}`).join('; ');
}

export function serializeVerificationOverrideAudit(audit: VerificationOverrideAudit): string {
  return JSON.stringify(audit, null, 2);
}
