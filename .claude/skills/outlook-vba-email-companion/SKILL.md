---
name: outlook-vba-email-companion
description: Building the TAA Outlook/VBA email companion — the only non-HTML piece of the TAA tool, resolving agent and manager mailboxes via Outlook COM and creating draft (never sent) emails from the HTML tool's actions-list handoff file. Use whenever writing or reviewing VBA that automates Outlook, resolves a username to a mailbox/manager, creates MailItem drafts, or designs the file handoff between the HTML reconciliation tool and this companion.
---

# Outlook/VBA email companion

## Scope and boundary
This is the **only non-HTML component** of the TAA tool, and it exists solely because the browser sandbox cannot read Outlook (see `standalone-html-tool-building` skill). It does no rule evaluation, no reconciliation logic — it only:
1. Reads the actions-list file exported by the HTML tool (who, tier, verdict, minutes, action, recipient rule — e.g. "Email OPS" vs "Email staff, CC manager" from the Rules table).
2. Resolves each person to a mailbox (and manager, when CC is required) via Outlook COM.
3. Creates a draft email and calls `.Display`, never `.Send`.

**The handoff is a plain file** (JSON/CSV) — this side must never embed rule thresholds or reconciliation logic, and the HTML side must never embed Outlook/mailbox logic. If a rule changes, only the HTML tool's config changes; this component is untouched.

## Outlook COM automation basics
```vba
Dim olApp As Object, olNS As Object, olRecip As Object, olMail As Object
Set olApp = CreateObject("Outlook.Application")   ' or GetObject if already running
Set olNS = olApp.GetNamespace("MAPI")
```
- Resolve a username/name to a mailbox: `olNS.CreateRecipient(name)` then `.Resolve` — check the boolean return before use, ambiguous/unresolved names fail silently otherwise.
- Get the manager: once resolved, `recip.AddressEntry.GetExchangeUser().GetExchangeUserManager()` returns the manager's `ExchangeUser` (Exchange/on-prem AD only — fails on non-Exchange accounts, see failure modes below).
- Create a draft, never send:
```vba
Set olMail = olApp.CreateItem(0)   ' olMailItem
olMail.To = resolvedAgentAddress
olMail.CC = resolvedManagerAddress   ' only when the rule says CC manager
olMail.Subject = "..."
olMail.Body = "..."
olMail.Display          ' shows the draft to a human — NEVER .Send
```
Emails are **draft-only by explicit project requirement** — a human always sends. Never call `.Send` or `.Save`-then-auto-send anywhere in this component.

## Which ASPECT field resolves against Outlook — resolved
Source is **`ASPECT_ExtraFiled2.csv`** (the identity master, 2,199 employees — not `ASPECT_ExtraFiled.csv`, which is superseded for identity, see `aspect-workforce-management` skill). User-confirmed resolution order, each attempt independent so one bad value falls through instead of failing the row:

1. **`EMP_EMAIL_ADR`** first — populated on 1,255/2,199 (57%). Attempt `CreateRecipient(EMP_EMAIL_ADR).Resolve` directly. **Caveat: a meaningful sampled share of these are personal addresses** (hotmail/gmail/yahoo), not corporate `@thecontactcentre.ae` — expect `.Resolve` to fail or resolve outside Exchange for these; that is an expected, non-fatal case, not a bug (see failure modes below), and the manager lookup (`GetExchangeUserManager`) will not work off a non-Exchange resolve.
2. **`EMP_EXTRA_2`** second (fallback) — populated on 1,625/2,199 (74%), corporate-alias-shaped (e.g. `aalali`, `ashamsi`). Try `CreateRecipient(EMP_EXTRA_2)` (bare alias, and/or `EMP_EXTRA_2@thecontactcentre.ae` if bare alias doesn't resolve).
3. **Name-based resolve** last resort — `EMP_FIRST_NAME`/`EMP_LAST_NAME` via `CreateRecipient`, only if both above fail. Log unresolved names for manual follow-up rather than guessing.

**Pre-check before drafting:** consult `EMP_TERM_DATE` and `EMP_ACTIVE_FLAG` on the identity record before attempting resolution — a populated `EMP_TERM_DATE` (2/2,199 in the current snapshot) should skip or clearly flag the draft rather than silently emailing a terminated employee.

## Failure modes to handle explicitly (do not let these fail silently — this is a known legacy-macro anti-pattern, see `aspect-workforce-management` skill's note on `On Error Resume Next`)
- **User not found / ambiguous resolve** — `CreateRecipient(...).Resolve` returns `False`; skip the draft, log the name to a visible error list, do not guess an address.
- **Primary field is a personal address, not corporate** — `EMP_EMAIL_ADR` resolving to a non-Exchange/external address is an expected, non-fatal outcome for ~a third of populated values (hotmail/gmail/yahoo). Treat it as "fall through to `EMP_EXTRA_2`," not as an error to surface — only log if all three resolution attempts fail.
- **No manager set on the AD/Exchange entry** — `GetExchangeUserManager()` returns `Nothing`; for a "CC manager" action, still create the draft to the agent, flag the missing CC visibly rather than silently omitting it or failing the whole batch.
- **Outlook not running** — `CreateObject("Outlook.Application")` will launch it, but the first call can be slow or hit a security prompt; do not assume it's instant, and surface a clear message if the COM call errors out instead of hanging.
- **Security prompts** — Outlook's "a program is trying to access email addresses" prompt can appear per-recipient-resolve on some configurations; document this for the user rather than trying to code around it (there is no reliable code-side suppression without an admin policy change, which is out of scope).
- Batch behavior: one unresolvable recipient must not abort the whole run — process the actions list as independent rows, collect failures, report them together at the end.
