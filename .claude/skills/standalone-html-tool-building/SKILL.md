---
name: standalone-html-tool-building
description: How to build the TAA reconciliation tool as a single standalone HTML/JS file with zero dependencies, zero server, zero build step — File API import, localStorage + JSON config export/import, a config-driven rule engine with no hardcoded thresholds, CSV generation (including ASPECT's trailing-comma requirement), and the browser-sandbox boundaries that force CMS and Outlook access out of the HTML tool. Use whenever writing or reviewing the TAA HTML tool's code, deciding what belongs in the browser vs the VBA companion, or porting the legacy Automation.xlsm staging logic into JS.
---

# Standalone zero-dependency HTML/JS tool building

## Non-negotiable constraints
- **Single `.html` file.** No npm, no bundler, no CDN script tags, no server. Inline all CSS/JS.
- **Every rule parameter is user-editable** — every threshold from `Rules to be taken.xlsx` (late/early/absent minute boundaries, tier keywords, grace window, gap threshold) lives in an on-page config table, never as a magic number in code.
- Persist config in `localStorage`, with explicit **export/import as JSON** so config can travel between machines and be version-controlled outside the browser.

## What the browser sandbox forces out of this tool
The browser cannot reach Avaya CMS Supervisor (COM) or Outlook (COM) — both need native automation the sandbox blocks. This is the reason for the file-handoff architecture:
- **CMS data** arrives via the same manual export the legacy macro pulled (`Historical\Designer\Agent Login & Logout` report → CSV), imported here through a `<input type="file">` picker. The HTML tool never tries to drive Avaya CMS Supervisor itself.
- **Email** is out of scope for the HTML tool entirely. It exports an **actions list** (who, tier, verdict, minutes, recommended action, recipient/CC per the rules table) as a file; a separate VBA companion (see `outlook-vba-email-companion` skill) reads that file and creates Outlook drafts. Neither side embeds the other's logic — the boundary is a plain file, not a shared library or shared process.

## Import layer (File API)
- Read files with `FileReader` / `input.files[0]`, never assume a filesystem path.
- ASPECT CSVs: UTF-8 with latin-1 fallback, standard quoted CSV — write a real CSV parser (state machine handling quotes/commas/newlines inside quoted fields), never `split(',')` or `split('\n')` — both ASPECT exports and the Cognos report contain pasted email threads inside quoted fields that break naive splitting.
- Cognos report: **UTF-16, tab-delimited**. Decode as UTF-16 (`TextDecoder('utf-16le')`, check for BOM) before tokenizing on tabs.
- `.xlsx` files (`ASPECT_segment_Definition.xlsx`, `Rules to be taken.xlsx`): these are zip/OOXML. In-browser, read the file as an `ArrayBuffer`, unzip with a small in-browser zip reader (no external library — OOXML zip entries are just DEFLATE; a from-scratch minimal inflate or the browser's `DecompressionStream('deflate-raw')` works), then parse `xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml` as XML via `DOMParser`. Same technique the legacy Python validation used with `zipfile`/`xml.etree`, ported to browser-native APIs.

## Rule engine — generic evaluator, not a chain of if/else per rule
Model the 8 rule categories × 2 tiers from `Rules to be taken.xlsx` as data: an array of `{category, tier, minMinutes, maxMinutes, action, communication}` rows, editable in a table in the UI, persisted to localStorage/JSON. The evaluator looks up the matching row by `(category, tier, minutes)` rather than branching in code. This is what makes "every rule parameter user-editable" actually true — adding/changing a threshold is a data edit, not a code change.

Also make these config, not constants, since they are explicitly open items:
- CMS join grace window (minutes before/after shift a punch still counts).
- Per-block vs whole-day attendance evaluation mode, and the gap threshold that switches to per-block (config option; untested path per `taa-time-attendance` skill, but must not crash if triggered).
- The bucket membership of the Informational and Full-day-leave segment-code lists (business calls, not yet confirmed — see `aspect-workforce-management` skill).

## Output writers
Two distinct outputs (do not let one leak into the other's file):
1. **ASPECT correction CSV** — header `Code,ID,SegmentCode,nominateDate,SegmentDate,SegmentStarttime,Segmentduration,Memo,` — **note the trailing comma on the header AND every data row**; build rows by joining fields with `,` then appending one more `,`. Generate via `Blob` + `URL.createObjectURL` + a synthetic `<a download>` click (standard client-side download, no server).
2. **Annotated Cognos report** — reproduce every original Cognos column **byte-identical** (do not reformat/retype them), append new columns for recomputed values and a flag+reason. Filename must be visibly derived, e.g. `Cognos_Annotated_<date>.csv`, plus a marker column/banner on every row. This file must never overwrite or be mistaken for the real Cognos export — changes nothing in Cognos itself.
3. **Draft-email actions list** — a third file (JSON or CSV) consumed only by the VBA companion; not a mail-sending mechanism itself.

## Legacy staging logic to port (from `Automation.xlsm` module `Run`, as spec not code)
Reusable: file-picker import pattern, row-cleaning filters (drop rows where a column starts with `ACCESS CARD*` or `UAE*`), the `HasFlexCode` keyword-scan technique (port to JS as a case-insensitive substring scan over concatenated name fields — see `segment-code-classification` skill).
**Do not port:** the date-keyed CMS join (MINIFS/MAXIFS on `CMS.Date = nominateDate`) — that is Defect 2, the cross-midnight false-absence bug. Implement the time-window join instead (`taa-time-attendance` skill). Also do not port the swallowed-error `On Error Resume Next` pattern — surface parse/join failures visibly in the UI instead of silently continuing.
