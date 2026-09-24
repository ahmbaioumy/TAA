---
name: segment-code-classification
description: The HasFlexCode-style case-insensitive keyword-scan technique used across TAA for detecting Flex codes and role tier from ASPECT name fields, and how to generalize it to a config-editable keyword-list classifier. Use whenever detecting a flag/category from free-text ASPECT fields (EMP_SORT_NAME, EMP_SHORT_NAME) by keyword, extending role-tier detection, or building any classifier that must stay data-driven rather than hardcoded.
---

# Keyword-scan classification (HasFlexCode technique)

## The technique
Legacy `HasFlexCode` (VBA, `Automation.xlsm`): case-insensitive substring scan over concatenated name fields, checking for any of a keyword list (`FLX`, `FLIX`, `FLEX`, `FELX` — note the intentional misspelling variants, real data contains typos). Returns yes/no (or the matched category) per employee.

Generalize as: `classify(concat(field1, field2, ...).toUpperCase(), keywordList) → firstMatchingCategory | default`. Keyword lists are **config, not code** — an editable table so new abbreviations/typos can be added without a rebuild.

## Applied to role tier (the concrete, validated use)
Scan `EMP_SORT_NAME` + `EMP_SHORT_NAME` from **`ASPECT_ExtraFiled2.csv`** (the identity master — 21-column schema, 2,199 unique employees, one row each; source of truth for these fields), case-insensitive, deduped by `EMP_ID`. Note: an earlier version of this skill pointed at `ASPECT_ExtraFiled.csv`, a different (19-column, segment-shaped) file the user has since flagged as wrong for this purpose — `ASPECT_ExtraFiled.csv` is superseded, do not use it for identity/tier.

Keyword → tier hits across 2,199 unique employees:
| Keyword | Hits |
|---|---|
| `OFCR` | 51 |
| `ANALYST` | 50 |
| `OFFICER` | 24 |
| `SPECIALIST` | 5 |
| `COORDINATOR` | 4 |
| `SUPERVISOR` | 1 |
| `TL` / `TEAM LEAD` | 0 |

**2,064 employees (93.9%) match nothing → default to OPS/CSR/Agent tier.** This default matters: it's the tier that drives the OPS-column thresholds in the Rules table (`taa-time-attendance` skill), so getting the default right affects the majority of evaluations. (Consistent with the ~91% found on the smaller, older file — the wider employee master reinforces the same default rather than contradicting it.)

**Corroborating signal:** `ASPECT_ExtraFiled2.csv` also carries `EMP_EXTRA_4`, a department/role tag (`ACCESS CARD`, `ES OFCR`, `ECS`, ...) populated on 1,317/2,199 employees. Treat it as a secondary check on the keyword-scan result, not a primary source — it's sparser and its exact taxonomy vs. the `EMP_SORT_NAME` keywords is not yet mapped. `ACCESS CARD`-tagged rows are worth flagging separately: they likely correspond to contractor/no-mailbox accounts (matches the legacy macro's `ACCESS CARD*` row-drop rule) but this is not yet a confirmed exclusion rule.

Sample raw values the scan runs against (messy real data, illustrates why substring-scan beats exact-match):
- `TARA ANGELEE TAMPOC,ES OFCR,67645 -40H`
- `MAHMOUD SAAD MOUSSA,11205|ANALYST|RPA||FELX|40H`
- `AHMED MOHAMED MOHAMED ALI,11325,EMINDS-40H -ES OFFICER`

## Why Cognos `SECTION` cannot substitute for this
`SECTION` is a department name, not a role tier: casing and abbreviations are inconsistent (`ES-SMB OFCR` vs ASPECT's `OFFICER`), and it disagrees with ASPECT's derived tier on 36 employees. Always derive tier from the ASPECT keyword scan, never from Cognos `SECTION`.

## Extending the pattern
Any future flag that's really "does this free-text field contain one of a known set of tokens" (e.g. a new department code, a new leave-type abbreviation) should reuse this same scan-plus-config-keyword-list shape rather than growing new bespoke string logic. Keep keyword lists in the same editable config surface as the rule-engine thresholds (`standalone-html-tool-building` skill) so a business-side change is a data edit.
