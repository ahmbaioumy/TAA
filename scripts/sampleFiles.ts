// Shared sample-file discovery helper for the scripts/ diagnostics and
// src/services/featureCompletion.test.ts's real-sample block.
//
// samples_Files/ is replaced wholesale between data sets (a new week of CMS_*.csv,
// a re-cased Cognos file, etc. — see launch-readiness.md Step 2) and every one of
// these tools previously hard-coded the exact filenames of one specific week
// (CMS_17092026.csv..CMS_21092026.csv, 'Cognos.csv') plus that week's exact
// parsed-row/punch counts. That made every tool fail the moment samples_Files/
// was swapped for a new week, even though nothing about the tools themselves
// needed to change. This module makes "which files are the current sample set"
// a single, data-set-independent lookup: glob every CMS_*.csv (sorted so the
// load order is deterministic and reproducible), and find the Cognos report
// case-insensitively (the real files have shipped as both 'Cognos.csv' and
// 'cognos.csv').
//
// samples_Files/ is READ-ONLY to every caller of this module — it only reads
// directory listings, never writes.

import * as fs from 'fs';
import * as path from 'path';

/** Resolves the samples directory: --samples=<dir> from argv if present,
 * otherwise the conventional '../samples_Files' relative to CWD (every script
 * in this directory is run from TAA_HTML/, per replay-real.ts's own comment on
 * why it uses process.cwd() rather than __dirname under this package's ESM
 * module scope). */
export function resolveSamplesDir(argv: string[] = process.argv.slice(2)): string {
  for (const arg of argv) {
    const m = /^--samples=(.*)$/.exec(arg);
    if (m) return path.resolve(m[1]);
  }
  return path.resolve(process.cwd(), '..', 'samples_Files');
}

/** Every CMS_*.csv in samplesDir, sorted by filename so the load order (and
 * therefore dedupeCmsPunches's punch-count arithmetic) is deterministic across
 * runs and across operating systems' own directory-listing order. Filenames
 * happen to embed DDMMYYYY (CMS_23092026.csv), so a plain string sort is also
 * date order for same-year files — not relied upon, just a side benefit. */
export function listCmsFiles(samplesDir: string): string[] {
  const entries = fs.readdirSync(samplesDir);
  return entries
    .filter(f => /^CMS_.*\.csv$/i.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map(f => path.join(samplesDir, f));
}

/** The Cognos report file, matched case-insensitively ('Cognos.csv' or
 * 'cognos.csv' — both have shipped as the real filename). Throws with a clear,
 * actionable message rather than silently resolving to a path that doesn't
 * exist, since every caller previously hard-coded the exact case and a
 * case-swap is exactly the kind of "quietly changed samples_Files/" this
 * module exists to survive. */
export function findCognosFile(samplesDir: string): string {
  const entries = fs.readdirSync(samplesDir);
  const match = entries.find(f => /^cognos\.csv$/i.test(f));
  if (!match) {
    throw new Error(
      `FATAL: no Cognos report file found in ${samplesDir} (looked for cognos.csv, case-insensitive). ` +
      `Found: ${entries.join(', ')}`
    );
  }
  return path.join(samplesDir, match);
}

/** True iff samplesDir exists and contains at least one CMS_*.csv and a Cognos
 * report — the minimum a real-sample run needs. Used by callers (e.g.
 * featureCompletion.test.ts) that must skip with a clear message rather than
 * fail when samples_Files/ is genuinely absent (e.g. a fresh checkout without
 * the read-only sample data). */
export function samplesAvailable(samplesDir: string): boolean {
  if (!fs.existsSync(samplesDir)) return false;
  try {
    const hasCms = listCmsFiles(samplesDir).length > 0;
    findCognosFile(samplesDir);
    return hasCms;
  } catch {
    return false;
  }
}
