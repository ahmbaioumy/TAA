# TAA — root pointer

Read `doc/CLAUDE.md` first — this file only exists so a new agent session starting at the
repo root (which does not auto-load `doc/CLAUDE.md`) still sees the project's rules.

## Hold Policy extension rule
Any new `RoleTier`, `HoldReasonCode`, `TaaActionCode`, or compared Cognos column must be wired
into the Hold Policy tab (`TAA_HTML/src/services/holdPolicy.ts`) — checklist: `doc/PRD.md`
§Hold Policy "Extending". A missing one fails `holdPolicy.test.ts` with a pointer message
before it can ship silently.
