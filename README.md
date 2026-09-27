# TAA — Time & Attendance Automation (source)

React/TypeScript source for the TAA reconciliation tool. It reconciles ASPECT schedules
against CMS actual login/logout, using the Cognos discrepancy report as the report to
compare against — never to trust blindly and never to modify. Outputs an ASPECT correction
file and draft (never auto-sent) emails.

This is **source only** — the shipped deliverable is a standalone, zero-dependency
`TAA_Workspace.html` at the repo root, assembled from this project's build output. Never
hand-edit `TAA_Workspace.html` directly; edit the files under `src/` and rebuild.

See `../doc/CLAUDE.md`, `../doc/PRD.md`, and `../doc/TAA_KNOWLEDGE_BASE.md` for the full
requirements, architecture, and non-negotiable business rules before changing anything here.

## Run locally (dev server)

```
npm install
npm run dev
```

## Rebuild the standalone file

```
npm run build
node assemble-standalone.cjs
```

This regenerates `TAA_Workspace.html` (repo root) from the fresh `dist/` output. Always open the
regenerated file in a real browser afterward — a successful build alone doesn't prove the
assembled standalone file renders (see `TAA_KNOWLEDGE_BASE.md` §7 for a case where it silently
didn't).
