import { EmailActionItem } from '../types/taa';
import { buildZip } from './zipWriter';

// Builds a downloadable .eml file that Outlook opens as a complete, editable,
// UNSENT draft (X-Unsent: 1) — the entire point of this module. Nothing here
// ever sends anything; there is no code path that could.
//
// Why .eml instead of mailto: — a mailto: URL breaks past ~2000 characters.
// An EMAIL_STAFF_CC_MANAGER notice fits (≈1000 chars), but an EMAIL_OPS
// digest pooling a real Section's cases runs 5,000-20,000 characters. A
// downloaded file has no such ceiling, and it is still just a Blob download —
// the one file operation available with zero folder permission, working
// identically whether the page was opened via http:// or a file:// double-click.

const CRLF = '\r\n';

function sanitizeHeaderValue(value: string): string {
  return (value || '')
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// RFC 2047 "encoded word" — required because every template's disclaimer line
// uses an em dash, and a name may be transliterated Arabic. A header emitted
// as raw UTF-8 bytes is technically invalid RFC 822 and some mail parsers
// mangle it; base64-encoded-word is unambiguous everywhere.
function encodeHeaderText(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const base64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(value)))
    : Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${base64}?=`;
}

// Base64-encodes the body (never quoted-printable, which has its own
// soft-line-break escaping rules that are easy to get subtly wrong) and wraps
// it at the RFC 2045 line-length limit of 76 characters.
function encodeBodyBase64(value: string): string {
  const withCrlf = value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const base64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(withCrlf)))
    : Buffer.from(withCrlf, 'utf-8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) {
    lines.push(base64.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

export interface EmlContent {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

export function buildEmlFile({ to, cc, subject, body }: EmlContent): string {
  const safeTo = sanitizeHeaderValue(to);
  const safeCc = cc ? sanitizeHeaderValue(cc) : '';
  const safeSubject = sanitizeHeaderValue(subject);
  const headers = [
    'MIME-Version: 1.0',
    // Makes Outlook open this as an editable compose window instead of the
    // read-only "received message" view — the entire mechanism this module
    // exists for.
    'X-Unsent: 1',
  ];
  if (safeTo) headers.push(`To: ${safeTo}`);
  if (safeCc) headers.push(`CC: ${safeCc}`);
  headers.push(`Subject: ${encodeHeaderText(safeSubject)}`);
  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push('Content-Transfer-Encoding: base64');

  return headers.join(CRLF) + CRLF + CRLF + encodeBodyBase64(body);
}

const ACTION_LABEL_BY_TEMPLATE_KEY: Record<string, string> = {
  late_login_absence: 'LateLoginAbsence',
  early_logout_absence: 'EarlyLogoutAbsence',
  late_logout_absence: 'LateLogoutAbsence',
  no_login_ns_nc: 'NoLoginNSNC',
  single_punch_absence: 'SinglePunchAbsence',
  cover_not_attended: 'CoverNotAttended',
  generic: 'Notice',
  ops_digest: 'OpsDigest',
};

// DD/MM/YYYY -> DDMMYYYY. Any other shape (unparseable date) is passed
// through with its separators stripped, rather than failing the download —
// a slightly-off filename is a cosmetic issue, refusing to produce the draft
// is not.
function compactDate(nominateDate: string): string {
  return (nominateDate || '').replace(/[^0-9]/g, '') || 'UNKNOWN';
}

// Strips everything but letters/digits and collapses runs to a single "-", so
// a Section like "COLL & RET" becomes "COLL-RET" — safe on every filesystem
// and still readable at a glance in the Downloads folder.
function sanitizeForFileName(value: string): string {
  return (value || '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'UNKNOWN';
}

// Action_PFxxxx_DDMMYYYY.eml (or Action_SECTION_DDMMYYYY.eml for a pooled OPS
// digest, which has no single employee). This is the user-facing identifier —
// how a person tells drafts apart in their Downloads folder — so it carries
// the case, the person (or section), and the date, never an opaque id.
export function buildEmlFileName(action: EmailActionItem): string {
  const actionLabel = ACTION_LABEL_BY_TEMPLATE_KEY[action.template_key] || 'Notice';
  const isDigest = action.template_key === 'ops_digest';
  const subject = isDigest
    ? sanitizeForFileName(action.section || action.name)
    : `PF${sanitizeForFileName(action.emp_id)}`;
  return `${actionLabel}_${subject}_${compactDate(action.nominate_date)}.eml`;
}

// Collisions (same action/person/date drafted twice in one batch) get a
// numeric suffix so every file in a single Bulk Draft call is guaranteed
// unique — nothing here reads the filename back, so a repeat across separate
// batches getting the browser's own " (1)" suffix is harmless.
export function buildUniqueEmlFileNames(actions: EmailActionItem[]): string[] {
  const seen = new Map<string, number>();
  return actions.map(action => {
    const base = buildEmlFileName(action);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    if (count === 1) return base;
    return base.replace(/\.eml$/, `_${count}.eml`);
  });
}

// The one addressing rule every draft download uses: a pooled OPS digest goes
// to its Section mailbox; everything else to its resolved `to`, which is blank
// when no recipient could be resolved (the draft still downloads, flagged).
export function resolveEmlRecipient(action: EmailActionItem): string {
  return action.ops_mailbox || action.to || '';
}

export function buildEmlForAction(action: EmailActionItem): string {
  return buildEmlFile({ to: resolveEmlRecipient(action), cc: action.cc, subject: action.subject, body: action.body });
}

// Whether a batch of `count` drafts downloads as ONE .zip instead of `count`
// separate .eml downloads (config.emailZipEnabled / emailZipThreshold). A
// burst of automatic downloads trips the browser's "download multiple files"
// prompt from the 2nd file on, which operators read as suspicious.
export function shouldBundleEmlZip(count: number, enabled: boolean, threshold: number): boolean {
  return enabled && count > 0 && count >= Math.max(1, threshold);
}

// One stored-method .zip holding each action's .eml, under the same unique
// file names a separate download would use.
export function buildEmlZip(actions: EmailActionItem[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = buildUniqueEmlFileNames(actions);
  return buildZip(actions.map((action, i) => ({ name: names[i], data: encoder.encode(buildEmlForAction(action)) })));
}

// TAA_Email_Drafts_<stamp>_<N>.zip — the stamp is the caller's run date stamp.
export function buildEmlZipFileName(stamp: string, count: number): string {
  return `TAA_Email_Drafts_${stamp}_${count}.zip`;
}
