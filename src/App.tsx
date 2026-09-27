import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { UploadZone } from './components/UploadZone';
import { ResultsView } from './components/ResultsView';
import { DiscoveryGlossaryModal } from './components/DiscoveryGlossaryModal';
import { ColumnMappingModal } from './components/ColumnMappingModal';
import { ConfigRegistryView } from './components/ConfigRegistryView';
import { HoldPolicyView } from './components/HoldPolicyView';
import { LeaveSegmentsView } from './components/LeaveSegmentsView';
import { RegressionSuiteView } from './components/RegressionSuiteView';
import { ScenarioGuideView } from './components/ScenarioGuideView';
import { DataPreviewView } from './components/DataPreviewView';
import { FieldReferenceView } from './components/FieldReferenceView';
import { VerificationOverrideModal } from './components/VerificationOverrideModal';
import { EmailConfigWizardModal } from './components/EmailConfigWizardModal';

import { CognosRecord, AspectSegment, AspectIdentity, CMSPunch, ConfigRegistry, GlossaryEntry, VerificationFailedCheck, VerificationOverrideAudit, ReviewStatus } from './types/taa';
import { reviewStatusAfterIncludeToggle } from './services/reviewStatus';
import { loadConfigRegistry, saveConfigRegistry, resetConfigRegistry, exportConfigToJson, importConfigFromJson, validateConfigForRun } from './services/configRegistry';
import { ReconciliationInput, ReconciliationOutput, reallocateCoverSlots } from './services/reconciliationEngine';
import { rebuildOutputs } from './services/outputRebuild';
import { runReconciliationWithAudit } from './services/pipeline';
import { holdPolicyLayout, isResultStale } from './services/holdPolicy';
import { runAllRegressionTests } from './services/regressionSuite';
import { runTrustMatrixTests } from './services/trustMatrix';
import { isForcedHoldReason } from './services/holdReasons';
import { extractDistinctSegmentCodes, extractHeaders, parseAspectSegments, parseCognosReport, parseAspectIdentity, parseDateTimeString, applyCognosDropRules } from './services/parsers';
import { lookupGlossary } from './services/scheduleRecompute';
import { assessCmsCoverage, assessDateOverlap, assessHeadcountMapping } from './services/punchAttribution';
import { VERIFICATION_OVERRIDE_PHRASE } from './services/verificationAudit';
import {
  getSampleCognosRecords,
  getSampleAspectSegments,
  getSampleAspectIdentities,
  getSampleCmsPunches,
} from './services/sampleData';

// Single source of truth for "is it safe to compute/keep output" — every path
// that can trigger or retain a calculation (manual Calculate, config save,
// sample-data auto-run) must go through this, or a headcount/verification
// condition silently drifts out of sync between them (past defect: Save and
// the sample auto-run each re-implemented a WEAKER inline copy of this check
// that omitted headcount entirely).
function evaluateCanCalculate(params: {
  filesReady: boolean;
  verificationOk: boolean;
  headcountOk: boolean;
}): boolean {
  return params.filesReady && params.verificationOk && params.headcountOk;
}

// runReconciliationWithAudit (engine -> unseen-punch audit -> Hold Policy -> initial review
// status) now lives in src/services/pipeline.ts — the single wiring point App.tsx and
// scripts/held-breakdown.ts both call, so the chain's order can never drift between them.

/** The four parsed inputs a run needs — passed explicitly so a caller that has
 *  just re-parsed one of them never races its own setState. See runWith. */
interface ReconciliationDatasets {
  cognosRecords: CognosRecord[];
  aspectSegments: AspectSegment[];
  cmsPunches: CMSPunch[];
  aspectIdentities: AspectIdentity[];
}

export default function App() {
  const [activeTab, setActiveTabRaw] = useState<'dashboard' | 'dataPreview' | 'results' | 'glossary' | 'leaveSegments' | 'config' | 'holdPolicy' | 'regression' | 'scenarios' | 'fieldReference'>('dashboard');
  const [isConfigDirty, setIsConfigDirty] = useState(false);
  const [isEmailWizardOpen, setIsEmailWizardOpen] = useState(false);

  // Defect fix: navigating away from the Config Registry tab with unsaved
  // edits previously discarded them with no warning (the view unmounts on
  // tab switch and re-inits from the config prop). Confirm before leaving.
  const setActiveTab = (tab: 'dashboard' | 'dataPreview' | 'results' | 'glossary' | 'leaveSegments' | 'config' | 'holdPolicy' | 'regression' | 'scenarios' | 'fieldReference') => {
    if ((activeTab === 'config' || activeTab === 'leaveSegments') && tab !== activeTab && isConfigDirty) {
      if (!window.confirm('You have unsaved changes. Leave without saving?')) {
        return;
      }
    }
    setActiveTabRaw(tab);
  };

  // Input Data States
  const [cognosRecords, setCognosRecords] = useState<CognosRecord[]>([]);
  const [aspectSegments, setAspectSegments] = useState<AspectSegment[]>([]);
  const [aspectIdentities, setAspectIdentities] = useState<AspectIdentity[]>([]);
  const [cmsPunches, setCmsPunches] = useState<CMSPunch[]>([]);
  const [inputFileNames, setInputFileNames] = useState({
    cognos: '',
    aspect: '',
    identity: '',
    cms: '',
  });

  // Config & Output States
  const [config, setConfig] = useState<ConfigRegistry>(() => loadConfigRegistry());
  const [output, setOutput] = useState<ReconciliationOutput | null>(null);

  // Hold Policy (doc/PRD.md §Hold Policy) — true once a calculation exists AND the saved
  // policy differs from the one that produced it (isResultStale compares fingerprints).
  // Derived, never stored: editing the policy back to what was used clears this
  // automatically, and a fresh Calculate always produces a matching fingerprint.
  const isHoldPolicyStale = !!output && isResultStale(output, config.holdPolicy);

  // Hold Policy tab's Save — deliberately does NOT recalculate or clear uploaded files
  // (unlike handleSaveConfig, Config Registry's own Save). Editing the policy after a
  // calculation only marks the existing output stale (isHoldPolicyStale above); the user
  // clicks Re-calculate (same handleRunReconciliation as Calculate) to apply it.
  const handleSaveHoldPolicy = (released: string[]) => {
    const updated: ConfigRegistry = { ...config, holdPolicy: { released } };
    setConfig(updated);
    saveConfigRegistry(updated);
  };

  // Phase 5 review workflow: a user can flip a MISMATCH_FOUND row's inclusion
  // decision (force-held rows — data gap, unclassified code, insufficient CMS
  // coverage, unparseable date — stay locked; the UI disables their checkbox).
  // The ASPECT correction CSV and annotated Cognos export are regenerated
  // from the updated set so the exported file always matches what's on screen.
  // WP3 (B10) — one checkbox records two different things depending on
  // whether the row has anything to send to payroll. A no-corrections row
  // can only be marked reviewed; it must never be made to imply a payroll
  // export. An actionable row's tick means both at once. Un-ticking always
  // clears both, so a row can be put back to "not reviewed / not included".
  const handleToggleInclude = (rowId: string, nextChecked: boolean) => {
    setOutput(prev => {
      if (!prev) return prev;
      const toggled = prev.rows.map(r => {
        if (r.id !== rowId || isForcedHoldReason(r.holdReason)) return r;
        const hasCorrections = r.details.generatedCorrections.length > 0;
        return {
          ...r,
          reviewCompleted: nextChecked,
          includeInOutput: hasCorrections ? nextChecked : false,
          includeDecisionSource: 'user' as const,
          reviewStatus: reviewStatusAfterIncludeToggle(r.reviewStatus, nextChecked),
        };
      });
      // Include changed -> re-stack COVER slots from the new include set (reallocateCoverSlots), so
      // an unticked row's COVER no longer pushes an exported one later, and a newly ticked one
      // slots in by incident date without overlapping.
      const rows = reallocateCoverSlots(toggled);
      const { aspectCorrections, aspectCorrectionsCsv, annotatedCognosCsv, annotatedCognosTsv, emailActionsJson } =
        rebuildOutputs(rows, prev.emailActions, config, prev.verificationAudit);
      return { ...prev, rows, aspectCorrections, aspectCorrectionsCsv, annotatedCognosCsv, annotatedCognosTsv, emailActionsJson };
    });
  };

  // UI-only tri-state review marker (§reviewStatus) — advances/sets a single row's
  // marker directly. Not part of any export, so unlike handleToggleInclude this never
  // calls rebuildOutputs, and it deliberately ignores the forced-hold lock: a reviewer
  // can mark a locked row PENDING/REVIEWED for their own tracking even though its
  // includeInOutput checkbox stays disabled.
  const handleSetReviewStatus = (rowId: string, status: ReviewStatus) => {
    setOutput(prev => {
      if (!prev) return prev;
      const rows = prev.rows.map(r => (r.id === rowId ? { ...r, reviewStatus: status } : r));
      return { ...prev, rows };
    });
  };

  // Bulk version of handleToggleInclude for the Include column's "select all"
  // header checkbox — applies to a caller-supplied set of row ids (the
  // currently visible/eligible rows) in one state update.
  const handleToggleIncludeAll = (rowIds: string[], nextChecked: boolean) => {
    setOutput(prev => {
      if (!prev) return prev;
      const idSet = new Set(rowIds);
      const toggled = prev.rows.map(r => {
        if (!idSet.has(r.id) || isForcedHoldReason(r.holdReason)) return r;
        const hasCorrections = r.details.generatedCorrections.length > 0;
        return {
          ...r,
          reviewCompleted: nextChecked,
          includeInOutput: hasCorrections ? nextChecked : false,
          includeDecisionSource: 'user' as const,
        };
      });
      // Include changed -> re-stack COVER slots from the new include set (reallocateCoverSlots), so
      // an unticked row's COVER no longer pushes an exported one later, and a newly ticked one
      // slots in by incident date without overlapping.
      const rows = reallocateCoverSlots(toggled);
      const { aspectCorrections, aspectCorrectionsCsv, annotatedCognosCsv, annotatedCognosTsv, emailActionsJson } =
        rebuildOutputs(rows, prev.emailActions, config, prev.verificationAudit);
      return { ...prev, rows, aspectCorrections, aspectCorrectionsCsv, annotatedCognosCsv, annotatedCognosTsv, emailActionsJson };
    });
  };
  const [isCalculating, setIsCalculating] = useState(false);

  // Modals
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  // Phase 7: same Addition/Removal/No Effect filtered-tab view as the Review
  // Classifications modal, applied to this read-only sidebar summary.
  const [glossarySummaryTab, setGlossarySummaryTab] = useState<'ADDITION' | 'REMOVAL' | 'NO_EFFECT' | 'UNCLASSIFIED'>('ADDITION');
  const [columnMapperFileType, setColumnMapperFileType] = useState<'aspect' | 'cognos' | 'cms' | 'identity' | null>(null);

  // Raw decoded file text kept per upload so the column mapper can re-parse
  // with a user-supplied mapping instead of only working off already-parsed
  // (and therefore already-successful) output.
  const [rawFileTexts, setRawFileTexts] = useState<Partial<Record<'aspect' | 'cognos' | 'cms' | 'identity', string>>>({});
  // Unfiltered source for the bundled sample Cognos dataset — set only when
  // sample data is loaded, cleared on a real Cognos upload or app reset. There
  // is no raw file text for sample records (they're a hardcoded array, not
  // parsed), so this is what handleSaveConfig re-filters from when a §6.6
  // rule changes while sample data is loaded — see handleLoadSampleData.
  const [sampleCognosSource, setSampleCognosSource] = useState<CognosRecord[] | null>(null);
  const [columnMappings, setColumnMappings] = useState<Partial<Record<'aspect' | 'cognos' | 'identity', Record<string, string>>>>({});

  // CMS auto-export (browser-triggered, folder-watched) has been removed —
  // the user now runs CMS export via their own automation outside the app.
  // CMS punches are a plain manual upload here, exactly like the other 3
  // files (UploadZone already falls back to its manual drop/click behaviour
  // whenever cmsAutomationActive is false).
  const handleFileTextCaptured = (type: 'aspect' | 'cognos' | 'cms' | 'identity', text: string, fileName: string) => {
    setRawFileTexts(prev => ({ ...prev, [type]: text }));
    setInputFileNames(prev => ({ ...prev, [type]: fileName }));
    if (type === 'cognos') {
      setSampleCognosSource(null);
    }
  };

  /**
   * Re-parse one uploaded file under a new column mapping.
   *
   * Returns the freshly parsed dataset so a caller that wants to recalculate
   * immediately can run against it rather than against state that has not
   * committed yet (see runWith / handleApplyMappingAndRecalculate). Returns
   * null when there is nothing to re-parse.
   */
  const handleApplyColumnMapping = (
    fileType: 'aspect' | 'cognos' | 'cms' | 'identity',
    mapping: Record<string, string>
  ): Partial<ReconciliationDatasets> | null => {
    const text = rawFileTexts[fileType];
    if (!text) return null;
    invalidateOutput();
    if (fileType === 'aspect') {
      const parsed = parseAspectSegments(text, mapping);
      setColumnMappings(prev => ({ ...prev, aspect: mapping }));
      setAspectSegments(parsed);
      return { aspectSegments: parsed };
    }
    if (fileType === 'cognos') {
      const parsed = parseCognosReport(text, config.cognosDropPatterns, mapping);
      setColumnMappings(prev => ({ ...prev, cognos: mapping }));
      setCognosRecords(parsed);
      return { cognosRecords: parsed };
    }
    if (fileType === 'identity') {
      const parsed = parseAspectIdentity(text, mapping);
      setColumnMappings(prev => ({ ...prev, identity: mapping }));
      setAspectIdentities(parsed);
      return { aspectIdentities: parsed };
    }
    // 'cms' uses fixed column positions per the documented CMS export format
    // (its own header row repeats "Login Time"/"Logout Time" for two
    // different columns, so name-based remapping is ambiguous there) — no
    // remap action for it.
    return null;
  };

  /** Remap + recalculate in one action, from the Field Reference page. */
  const handleApplyMappingAndRecalculate = (
    fileType: 'aspect' | 'cognos' | 'identity',
    mapping: Record<string, string>
  ) => {
    const reparsed = handleApplyColumnMapping(fileType, mapping);
    if (!reparsed || !canCalculate) return;
    runWith({ cognosRecords, aspectSegments, cmsPunches, aspectIdentities, ...reparsed });
  };

  // Discovered segment codes in current ASPECT file
  const discoveredCodes = useMemo(() => {
    return extractDistinctSegmentCodes(aspectSegments);
  }, [aspectSegments]);

  // Discovered codes with no glossary entry at all — the exact class of code
  // the engine holds rows for (UNCLASSIFIED_SEGMENT_CODE). Computed once here
  // so the Input Center's red count and the standalone Glossary page's
  // Unclassified tab can never disagree with each other or with the engine.
  const unclassifiedDiscoveredCodes = useMemo(() => {
    return discoveredCodes.filter(code => !lookupGlossary(config.segmentGlossary, code));
  }, [discoveredCodes, config.segmentGlossary]);

  // Distinct Cognos LEAVE TYPE values in the current upload, for the Leave Segments page's
  // mapping picker — same discovery-driven pattern as discoveredCodes above.
  const discoveredCognosLeaveTypes = useMemo(() => {
    return Array.from(new Set(
      cognosRecords.map(r => (r['LEAVE TYPE'] || '').trim()).filter(Boolean)
    )).sort();
  }, [cognosRecords]);

  // Check if minimum required files are loaded (Cognos, ASPECT, Identity, CMS)
  const filesReady = useMemo(() => {
    return aspectSegments.length > 0 && cognosRecords.length > 0 && aspectIdentities.length > 0 && cmsPunches.length > 0;
  }, [aspectSegments, cognosRecords, aspectIdentities, cmsPunches]);

  // §8 item 7 defect fix: assessCmsCoverage() was fully implemented but never
  // called from any UI component, so its dataset-level warning (CMS export
  // doesn't span far enough around the Cognos report's own date range) never
  // reached a user before Calculate. Advisory only — does not affect
  // canCalculate; the real per-row gate is the existing INSUFFICIENT_CMS_
  // COVERAGE hold produced by runReconciliation itself.
  const cmsCoverageAssessment = useMemo(() => {
    if (cognosRecords.length === 0 || cmsPunches.length === 0) return { sufficient: true, message: '' };
    const cognosDates = cognosRecords
      .map(c => parseDateTimeString(c['SIGN IN DATE']))
      .filter((d): d is Date => d !== null);
    return assessCmsCoverage(cognosDates, cmsPunches, config);
  }, [cognosRecords, cmsPunches, config]);

  // Defect fix: the Cognos<->ASPECT join key is a calendar-date match (Cognos
  // SIGN IN DATE vs ASPECT NOM_DATE), and nothing previously told the user
  // BEFORE Calculate when the two uploaded exports simply cover different
  // days — every row would silently resolve to COGNOS_DATA_GAP with zero
  // corrections and zero explanation. Advisory only, same pattern as
  // cmsCoverageAssessment above; does not affect canCalculate.
  const dateOverlapAssessment = useMemo(() => {
    if (cognosRecords.length === 0 || aspectSegments.length === 0) return { sufficient: true, message: '' };
    return assessDateOverlap(cognosRecords, aspectSegments);
  }, [cognosRecords, aspectSegments]);

  // F03 removal (2026-09-09, user-confirmed): the per-row CMS_EXPORT_SCOPE_GAP
  // guard in reconciliationEngine.ts was replaced by this upload-time
  // headcount mapping check — every rate anchored on the Cognos worklist,
  // never a symmetric three-way overlap, since ASPECT and CMS are only
  // evidence sources for Cognos rows. Unlike cmsCoverageAssessment/
  // dateOverlapAssessment above, this renders even when sufficient — it is a
  // statistic the user should always see, not only a failure warning — and,
  // when config.validateUploadedHeadcount is on, gates canCalculate below.
  const headcountMapping = useMemo(() => {
    if (cognosRecords.length === 0) return null;
    return assessHeadcountMapping(cognosRecords, aspectIdentities, cmsPunches, config);
  }, [cognosRecords, aspectIdentities, cmsPunches, config]);

  const [headcountAcknowledged, setHeadcountAcknowledged] = useState(false);

  // Both suites gate payroll. Any override is bound to the exact config and
  // input datasets and carries an explicit, exported acknowledgement.
  // previously the suite's "100% Target" / "Payroll Compliance Verification"
  // framing implied a gate but never actually blocked Calculate, and it always
  // checked DEFAULT_CONFIG rather than the config the user is about to run.
  const regressionResults = useMemo(() => runAllRegressionTests(config), [config]);
  const trustMatrixResults = useMemo(() => runTrustMatrixTests(config), [config]);
  const allRegressionPassed = useMemo(() => regressionResults.every(r => r.passed), [regressionResults]);
  const allTrustMatrixPassed = useMemo(() => trustMatrixResults.every(r => r.passed), [trustMatrixResults]);
  const allVerificationPassed = allRegressionPassed && allTrustMatrixPassed;
  const failedVerificationCount = regressionResults.filter(r => !r.passed).length + trustMatrixResults.filter(r => !r.passed).length;
  const failedVerificationChecks = useMemo<VerificationFailedCheck[]>(() => [
    ...regressionResults.filter(result => !result.passed).map(result => ({
      suite: 'regression' as const,
      id: result.id,
      name: result.name,
      expected: `${result.expectedVerdict} / ${result.expectedAction}`,
      actual: `${result.actualVerdict} / ${result.actualAction}`,
    })),
    ...trustMatrixResults.filter(result => !result.passed).map(result => ({
      suite: 'trust_matrix' as const,
      id: result.id,
      name: result.name,
      expected: `${result.expectedVerdict} / ${result.expectedAction}`,
      actual: `${result.actualVerdict} / ${result.actualAction}`,
    })),
  ], [regressionResults, trustMatrixResults]);
  const [verificationOverrideAudit, setVerificationOverrideAudit] = useState<VerificationOverrideAudit | null>(null);
  const [isVerificationOverrideOpen, setIsVerificationOverrideOpen] = useState(false);
  useEffect(() => {
    setVerificationOverrideAudit(null);
    setIsVerificationOverrideOpen(false);
    setHeadcountAcknowledged(false);
  }, [config, cognosRecords, aspectSegments, aspectIdentities, cmsPunches]);

  const headcountSufficient = !headcountMapping || headcountMapping.sufficient;

  const canCalculate = evaluateCanCalculate({
    filesReady,
    verificationOk: allVerificationPassed || !!verificationOverrideAudit,
    headcountOk: headcountSufficient || headcountAcknowledged,
  });

  // Shared invalidation: any input, mapping, or configuration mutation must
  // immediately invalidate prior results and downloads, and never leave the
  // user staring at a now-empty Results tab.
  const invalidateOutput = () => {
    setOutput(null);
    setActiveTabRaw(prev => (prev === 'results' ? 'dashboard' : prev));
  };

  const calculateDisabledReason = !filesReady
    ? `Waiting on: ${[
        cmsPunches.length === 0 && 'CMS export',
        aspectSegments.length === 0 && 'ASPECT segments',
        aspectIdentities.length === 0 && 'Identity Master (ASPECT ExtraFiled)',
        cognosRecords.length === 0 && 'Cognos report',
      ].filter(Boolean).join(', ')}`
    : !allVerificationPassed && !verificationOverrideAudit
      ? `${failedVerificationCount} payroll verification test(s) failing — review both suites on the Regression Suite tab`
      : !headcountSufficient && !headcountAcknowledged
        ? `Headcount mapping is below the ${config.minHeadcountMappingPercent}% minimum — acknowledge the warning below to proceed`
        : undefined;

  /**
   * The single calculate path.
   *
   * Datasets are passed in explicitly rather than read off state inside the
   * timeout: a caller that has just re-parsed a file (a mapping change) would
   * otherwise run against the pre-parse values, because the setState from that
   * same tick has not committed yet. handleLoadSampleData and handleSaveConfig
   * already pass freshly-built values for the same reason.
   */
  const runWith = (datasets: ReconciliationDatasets) => {
    setIsCalculating(true);

    setTimeout(() => {
      try {
        const res = runReconciliationWithAudit({
          ...datasets,
          config,
          // B8/WP2: the run date is the system clock at the moment reconciliation
          // actually runs, so newly assigned covers always land in the future.
          processingDate: new Date(),
          verificationAudit: verificationOverrideAudit || undefined,
        });
        setOutput(res);
        setActiveTab('results');
      } catch (err) {
        console.error('Reconciliation error:', err);
        alert(`Reconciliation Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsCalculating(false);
      }
    }, 150);
  };

  const handleRunReconciliation = () => {
    if (!canCalculate) return;
    runWith({ cognosRecords, aspectSegments, cmsPunches, aspectIdentities });
  };

  const handleLoadSampleData = () => {
    // Defect fix: this previously overwrote any manually-uploaded files with
    // no confirmation, and gave no indication anything had changed beyond
    // the auto-switch to Results.
    if (filesReady || output) {
      if (!window.confirm('This replaces your currently uploaded files and any calculated results with the bundled demo dataset. Continue?')) {
        return;
      }
    }
    // Sample records are a hardcoded array (sampleData.ts), not parsed from raw
    // file text, so there's no rawFileTexts entry to re-parse later — apply
    // §6.6 drop rules here at load time, same as the upload path would, and
    // stash the unfiltered source so handleSaveConfig can re-filter it if a
    // rule changes afterward. Also clear any stale real-file Cognos state
    // (rawFileTexts/columnMappings) so a later config save doesn't re-parse a
    // previously-uploaded real file instead of the sample data now on screen.
    const rawSampleCognos = getSampleCognosRecords();
    const sCognos = applyCognosDropRules(rawSampleCognos, config.cognosDropPatterns);
    const sAspect = getSampleAspectSegments();
    const sIdentities = getSampleAspectIdentities();
    const sCMS = getSampleCmsPunches();

    setSampleCognosSource(rawSampleCognos);
    setRawFileTexts(prev => ({ ...prev, cognos: undefined }));
    setColumnMappings(prev => ({ ...prev, cognos: undefined }));
    setCognosRecords(sCognos);
    setAspectSegments(sAspect);
    setAspectIdentities(sIdentities);
    setCmsPunches(sCMS);
    setInputFileNames({
      cognos: 'Bundled sample Cognos',
      aspect: 'Bundled sample ASPECT segments',
      identity: 'Bundled sample ASPECT identity',
      cms: 'Bundled sample CMS punches',
    });

    // Auto-calculate on sample load must pass the SAME eligibility gate as a
    // manual Calculate — including headcount, not just the two test suites
    // (past defect: this path silently skipped the headcount check entirely).
    // canCalculate can't be read directly here: it's derived from cognosRecords/
    // aspectIdentities/etc. state that hasn't re-rendered yet in this same tick,
    // so every sub-condition is recomputed from the freshly-generated sample data.
    const filesReadyForSample = sCognos.length > 0 && sAspect.length > 0 && sIdentities.length > 0 && sCMS.length > 0;
    const regressionPassed = runAllRegressionTests(config).every(result => result.passed);
    const trustPassed = runTrustMatrixTests(config).every(result => result.passed);
    const headcountMappingForSample = sCognos.length > 0
      ? assessHeadcountMapping(sCognos, sIdentities, sCMS, config)
      : null;
    const headcountOkForSample = !headcountMappingForSample || headcountMappingForSample.sufficient;
    const canAutoCalculate = evaluateCanCalculate({
      filesReady: filesReadyForSample,
      verificationOk: regressionPassed && trustPassed,
      headcountOk: headcountOkForSample,
    });
    if (canAutoCalculate) {
      setIsCalculating(true);
      setTimeout(() => {
        const res = runReconciliationWithAudit({
          cognosRecords: sCognos,
          aspectSegments: sAspect,
          cmsPunches: sCMS,
          aspectIdentities: sIdentities,
          config,
          processingDate: new Date(),
        });
        setOutput(res);
        setIsCalculating(false);
        setActiveTab('results');
      }, 200);
    } else {
      invalidateOutput();
    }
  };

  const handleSaveConfig = (updated: ConfigRegistry) => {
    setConfig(updated);
    saveConfigRegistry(updated);

    // §6.6 Cognos drop rules are applied only inside parseCognosReport(), which
    // runs at upload/remap time — never automatically on config save. Without
    // this re-derivation, a rule added AFTER the Cognos file (or sample data)
    // was already loaded would silently never take effect until a manual
    // re-upload/reload (past defect). Real uploads re-parse from raw text;
    // sample data (no raw text — see sampleCognosSource) re-filters from its
    // stashed unfiltered source instead.
    let freshCognosRecords = cognosRecords;
    if (rawFileTexts.cognos) {
      freshCognosRecords = parseCognosReport(rawFileTexts.cognos, updated.cognosDropPatterns, columnMappings.cognos);
      setCognosRecords(freshCognosRecords);
    } else if (sampleCognosSource) {
      freshCognosRecords = applyCognosDropRules(sampleCognosSource, updated.cognosDropPatterns);
      setCognosRecords(freshCognosRecords);
    }

    // If data is already loaded, re-run calculation with updated rules — must
    // pass the SAME eligibility gate as a manual Calculate (past defect: this
    // path checked only the two test suites and silently skipped headcount).
    // filesReady must be recomputed from freshCognosRecords rather than read
    // from the filesReady memo, which still reflects the pre-reparse count and
    // hasn't re-rendered in this tick (e.g. a rule that drops every row would
    // otherwise leave a stale-true filesReady and let reconciliation run empty).
    const filesReadyAfterReparse =
      freshCognosRecords.length > 0 && aspectSegments.length > 0 && aspectIdentities.length > 0 && cmsPunches.length > 0;
    const updatedRegressionPassed = runAllRegressionTests(updated).every(result => result.passed);
    const updatedTrustPassed = runTrustMatrixTests(updated).every(result => result.passed);
    const updatedHeadcountMapping = freshCognosRecords.length > 0
      ? assessHeadcountMapping(freshCognosRecords, aspectIdentities, cmsPunches, updated)
      : null;
    const updatedHeadcountOk = !updatedHeadcountMapping || updatedHeadcountMapping.sufficient;
    const canAutoRecalculate = evaluateCanCalculate({
      filesReady: filesReadyAfterReparse,
      verificationOk: updatedRegressionPassed && updatedTrustPassed,
      headcountOk: updatedHeadcountOk,
    });
    if (canAutoRecalculate) {
      const res = runReconciliationWithAudit({
        cognosRecords: freshCognosRecords,
        aspectSegments,
        cmsPunches,
        aspectIdentities,
        config: updated,
        processingDate: new Date(),
      });
      setOutput(res);
    } else {
      invalidateOutput();
    }
  };

  const handleAuthorizeVerificationOverride = (reason: string) => {
    setVerificationOverrideAudit({
      acknowledged_at: new Date().toISOString(),
      acknowledgement_phrase: VERIFICATION_OVERRIDE_PHRASE,
      reason,
      regression_passed: regressionResults.filter(result => result.passed).length,
      regression_total: regressionResults.length,
      trust_matrix_passed: trustMatrixResults.filter(result => result.passed).length,
      trust_matrix_total: trustMatrixResults.length,
      failed_checks: failedVerificationChecks,
      inputs: {
        cognos: { name: inputFileNames.cognos || 'Cognos report', record_count: cognosRecords.length },
        aspect_segments: { name: inputFileNames.aspect || 'ASPECT segments', record_count: aspectSegments.length },
        aspect_identity: { name: inputFileNames.identity || 'ASPECT identity', record_count: aspectIdentities.length },
        cms: { name: inputFileNames.cms || 'CMS export', record_count: cmsPunches.length },
      },
    });
    setIsVerificationOverrideOpen(false);
  };

  // Sidebar collapse preference — persisted independently of the config
  // registry JSON so it's purely a UI convenience, not exported/imported
  // with the rest of the config.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('taa_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const handleToggleSidebarCollapsed = () => {
    setIsSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('taa_sidebar_collapsed', String(next));
      } catch (e) {
        console.error('Failed to persist sidebar collapse state', e);
      }
      return next;
    });
  };

  // Sidebar quick actions — mirror ConfigRegistryView's own Import/Export
  // JSON buttons so config can be exported/imported without opening the
  // Config Registry tab.
  const handleExportConfig = () => {
    const json = exportConfigToJson(config);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TAA_Config_Registry_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportConfigFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const imported = importConfigFromJson(text);
        // Imported config bypasses ConfigRegistryView's own Save button (and
        // the validation gate wired to it) entirely — run the same
        // fail-closed check here so an invalid or band-overlapping imported
        // config can't slip in through this second path.
        const issues = validateConfigForRun(imported);
        if (issues.length > 0) {
          alert(`Imported config rejected — ${issues.length} validation issue(s) must be fixed first:\n${issues.map(i => `• ${i.field}: ${i.message}`).join('\n')}`);
          return;
        }
        handleSaveConfig(imported);
      } catch (err) {
        alert(`Invalid config JSON file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  // Whole-app reset — clears loaded files/results only, distinct from
  // Config Registry's own "Reset Defaults" which resets the config JSON.
  const clearUploadedDataAndResults = () => {
    setCognosRecords([]);
    setAspectSegments([]);
    setAspectIdentities([]);
    setCmsPunches([]);
    setOutput(null);
    setRawFileTexts({});
    setColumnMappings({});
    setSampleCognosSource(null);
    setInputFileNames({ cognos: '', aspect: '', identity: '', cms: '' });
    setActiveTabRaw('dashboard');
  };

  const handleResetApp = () => {
    if (!window.confirm('This clears all uploaded files and calculated results and returns to a fresh session. Continue?')) {
      return;
    }
    clearUploadedDataAndResults();
  };

  // Hard Reset — everything Reset App clears, plus the two localStorage keys
  // this app ever persists (Config Registry rules, sidebar-collapsed
  // preference), for a genuine factory reset. Distinct from Config
  // Registry's own "Reset Defaults" (ConfigRegistryView), which only touches
  // config and leaves uploaded data/results alone.
  const handleHardReset = () => {
    if (!window.confirm('This clears all uploaded files, calculated results, your saved Config Registry customizations, and UI preferences — returning the app to a completely fresh install. This cannot be undone. Continue?')) {
      return;
    }
    clearUploadedDataAndResults();
    const fresh = resetConfigRegistry();
    setConfig(fresh);
    setIsConfigDirty(false);
    setIsSidebarCollapsed(false);
    try {
      localStorage.removeItem('taa_sidebar_collapsed');
    } catch (e) {
      console.error('Failed to clear sidebar preference from localStorage', e);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 flex font-sans selection:bg-indigo-500 selection:text-white">
      {/* Left Sidebar — main workflow nav + Glossary/Config + config
          import/export/reset. Desktop only (lg+); mobile falls back to the
          <select> nav in Header. */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        hasCalculated={!!output}
        totalRecordsCount={output?.rows.length || 0}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapsed={handleToggleSidebarCollapsed}
        onExportConfig={handleExportConfig}
        onImportConfigFile={handleImportConfigFile}
        onResetApp={handleResetApp}
        onHardReset={handleHardReset}
        isStale={isHoldPolicyStale}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <Header
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onLoadSampleData={handleLoadSampleData}
          onRunReconciliation={handleRunReconciliation}
          onOpenEmailWizard={() => setIsEmailWizardOpen(true)}
          hasCalculated={!!output}
          canCalculate={canCalculate}
          isCalculating={isCalculating}
          totalRecordsCount={output?.rows.length || 0}
          disabledReason={calculateDisabledReason}
          isStale={isHoldPolicyStale}
        />

        {/* Main Container */}
        <main className="flex-1 w-full px-4 sm:px-6 lg:px-8 py-6">
        {/* Active Tab Views */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {isHoldPolicyStale && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                <div className="font-semibold">
                  Hold policy changed after this calculation — results and exports are out of date. Re-calculate to apply.
                </div>
                <button
                  type="button"
                  onClick={handleRunReconciliation}
                  className="rounded border border-amber-400 bg-white px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Re-calculate
                </button>
              </div>
            )}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900 tracking-tight">
                  Time & Attendance Input Center
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Upload daily schedule exports and punch logs for automated Recompute-Then-Compare reconciliation.
                </p>
              </div>

              <UploadZone
                cognosRecords={cognosRecords}
                setCognosRecords={setCognosRecords}
                aspectSegments={aspectSegments}
                setAspectSegments={setAspectSegments}
                aspectIdentities={aspectIdentities}
                setAspectIdentities={setAspectIdentities}
                cmsPunches={cmsPunches}
                setCmsPunches={setCmsPunches}
                onOpenGlossary={() => setIsGlossaryOpen(true)}
                onOpenColumnMapper={(type) => setColumnMapperFileType(type)}
                discoveredCodesCount={discoveredCodes.length}
                unclassifiedCodesCount={unclassifiedDiscoveredCodes.length}
                config={config}
                onFileTextCaptured={handleFileTextCaptured}
                onDataChanged={invalidateOutput}
                inputFileNames={inputFileNames}
                cmsAutomationActive={false}
                cmsAutoStatus="idle"
                onRunCmsExportNow={() => {}}
              />

              {/* Missing-files status — defect fix: previously the dashboard
                  showed nothing at all when Calculate was disabled, with no
                  indication of which file(s) were still needed. */}
              {!filesReady && (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600">
                  Waiting on:{' '}
                  {[
                    cmsPunches.length === 0 && 'CMS export',
                    aspectSegments.length === 0 && 'ASPECT segments',
                    aspectIdentities.length === 0 && 'Identity Master (ASPECT ExtraFiled)',
                    cognosRecords.length === 0 && 'Cognos report',
                  ].filter(Boolean).join(', ')}
                  {' '}— Calculate stays disabled until all 4 are loaded (any order).
                </div>
              )}

              {/* Cognos<->ASPECT date-overlap advisory — surfaces BEFORE Calculate
                  when the two uploaded exports cover different calendar days, the
                  most common reason a run silently produces zero corrections. */}
              {!dateOverlapAssessment.sufficient && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
                  <span className="font-bold">Date mismatch warning:</span> {dateOverlapAssessment.message}
                </div>
              )}

              {/* CMS dataset-coverage advisory — §8 item 7 defect fix: this
                  check existed but was never wired to any UI, so a user had
                  no warning before Calculate that their CMS export doesn't
                  reach far enough around the Cognos report's date range for
                  cross-midnight rows near the edges to auto-resolve. */}
              {filesReady && !cmsCoverageAssessment.sufficient && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
                  <span className="font-bold">CMS export coverage warning:</span> {cmsCoverageAssessment.message}
                </div>
              )}

              {/* Headcount mapping — replaces the removed per-row F03
                  CMS_EXPORT_SCOPE_GAP guard. Every rate is anchored on the
                  Cognos worklist (the report TAA validates and actions);
                  ASPECT and CMS are evidence sources for it, never subjects
                  of their own symmetric overlap. Renders whenever a Cognos
                  file is loaded, sufficient or not — it's a statistic, not
                  only a failure warning. The critical count (Cognos claims
                  attendance, CMS has zero records) always renders when > 0,
                  regardless of the validateUploadedHeadcount toggle — the
                  toggle governs whether Calculate is BLOCKED, never whether
                  this figure is shown. */}
              {headcountMapping && (
                <div className="space-y-3">
                  {headcountMapping.cognosClaimsAttendanceButNoCmsCount > 0 ? (
                    <div className="bg-rose-50 border border-rose-300 rounded-2xl p-4">
                      <p className="text-sm font-bold text-rose-700">
                        🔴 {headcountMapping.cognosClaimsAttendanceButNoCmsCount} Cognos login{headcountMapping.cognosClaimsAttendanceButNoCmsCount === 1 ? '' : 's'} report{headcountMapping.cognosClaimsAttendanceButNoCmsCount === 1 ? 's' : ''} a SIGN IN, SIGN OUT or SIGNIN DURATION but {headcountMapping.cognosClaimsAttendanceButNoCmsCount === 1 ? 'has' : 'have'} ZERO CMS records ({headcountMapping.cognosClaimsAttendanceButNoCmsRowCount} row{headcountMapping.cognosClaimsAttendanceButNoCmsRowCount === 1 ? '' : 's'}) — {headcountMapping.cognosClaimsAttendanceButNoCmsCount === 1 ? 'this employee' : 'these employees'} will be marked Absent NS/NC, contradicting Cognos.
                      </p>
                      {headcountMapping.cognosClaimsAttendanceButNoCmsPreview.length > 0 && (
                        <p className="text-[11px] text-rose-600 mt-1.5">
                          {headcountMapping.cognosClaimsAttendanceButNoCmsPreview.map(e => `${e.name || e.pfNo} (PF ${e.pfNo}, Login ${e.loginId || '—'})`).join(', ')}
                          {headcountMapping.cognosClaimsAttendanceButNoCmsCount > headcountMapping.cognosClaimsAttendanceButNoCmsPreview.length
                            ? `, +${headcountMapping.cognosClaimsAttendanceButNoCmsCount - headcountMapping.cognosClaimsAttendanceButNoCmsPreview.length} more`
                            : ''}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3 text-xs text-emerald-800">
                      ✓ No Cognos login with reported attendance is missing a CMS record.
                    </div>
                  )}

                  <div className={`rounded-2xl p-4 text-xs border ${headcountMapping.sufficient ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                    <p>
                      <span className="font-bold">Cognos worklist:</span> {headcountMapping.cognosEmployeeCount} employees / {headcountMapping.cognosRowCount} rows
                      {' · '}<span className="font-bold">Schedule evidence (ASPECT):</span> {headcountMapping.withAspectEvidenceCount} of {headcountMapping.cognosEmployeeCount} ({headcountMapping.aspectPercent}%)
                      {' · '}<span className="font-bold">Punch evidence (CMS):</span> {headcountMapping.withCmsEvidenceCount} of {headcountMapping.cmsExpectedEmployeeCount} expected ({headcountMapping.cmsPercent}%)
                    </p>
                    <p className="mt-1">
                      Lowest coverage: <span className="font-bold">{headcountMapping.lowestPercent}%</span>
                      {!headcountMapping.sufficient && ` — below the ${config.minHeadcountMappingPercent}% minimum.`}
                    </p>
                    <p className="mt-1 text-[11px] opacity-80">
                      Missing from ASPECT: {headcountMapping.cognosEmployeeCount - headcountMapping.withAspectEvidenceCount}
                      {' · '}Cognos reports zero login: {headcountMapping.cognosDeclaresNoAttendanceCount} (expected absent from CMS)
                      {' · '}Blank LOGIN ID: {headcountMapping.cognosBlankLoginIdCount} (unjoinable, held by GATE 0)
                      {' · '}Outside the Cognos worklist and ignored: {headcountMapping.aspectOnlyCount} ASPECT-only, {headcountMapping.cmsOnlyCount} CMS-only
                    </p>
                  </div>

                  {!headcountMapping.sufficient && config.validateUploadedHeadcount && !headcountAcknowledged && (
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between gap-4 shadow-xs">
                      <div>
                        <h4 className="text-sm font-bold text-amber-900">
                          Headcount mapping is below the {config.minHeadcountMappingPercent}% minimum — Calculate is blocked
                        </h4>
                        <p className="text-xs text-amber-700 mt-0.5">
                          Review the coverage numbers above before proceeding. Turn off "Validate Uploaded HC" in the Config Registry to disable this check entirely.
                        </p>
                      </div>
                      <button
                        onClick={() => setHeadcountAcknowledged(true)}
                        className="px-4 py-2.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold transition-all shrink-0"
                      >
                        I have checked the uploads — proceed
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Both independent payroll suites participate in the production gate. */}
              {filesReady && !allVerificationPassed && !verificationOverrideAudit && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between gap-4 shadow-xs">
                  <div>
                    <h4 className="text-sm font-bold text-amber-900">
                      Payroll verification has failing cases — Calculate is blocked
                    </h4>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {failedVerificationCount} check(s) fail across the {regressionResults.length}-case regression suite and {trustMatrixResults.length}-case independent trust matrix against your CURRENT Config Registry settings.
                      Review both suites before running live reconciliation.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setActiveTab('regression')}
                      className="px-4 py-2.5 rounded-lg bg-white border border-amber-300 text-amber-800 text-xs font-semibold hover:bg-amber-100 transition-all"
                    >
                      View Failures
                    </button>
                    <button
                      onClick={() => setIsVerificationOverrideOpen(true)}
                      className="px-4 py-2.5 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-semibold transition-all"
                    >
                      Request Guarded Override
                    </button>
                  </div>
                </div>
              )}

              {/* Ready to Reconcile CTA */}
              {canCalculate && (
                <div className="bg-indigo-50/80 border border-indigo-200 rounded-2xl p-5 flex items-center justify-between shadow-xs">
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">All Required Files Loaded</h4>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Ready to recompute {cognosRecords.length} Cognos records against {aspectSegments.length} schedule segments and {cmsPunches.length} CMS punches.
                      {!allVerificationPassed && (
                        <span className="text-amber-700 font-semibold"> Proceeding with {failedVerificationCount} unresolved payroll verification failure(s).</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={handleRunReconciliation}
                    disabled={isCalculating}
                    className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm shadow-indigo-200 transition-all flex items-center space-x-2 cursor-pointer"
                  >
                    <span>Run Payroll Reconciliation</span>
                  </button>
                </div>
              )}
            </div>

            {/* If calculation results already exist, show quick preview */}
            {output && (
              <div className="pt-4">
                <ResultsView
                  rows={output.rows}
                  aspectCorrectionsCsv={output.aspectCorrectionsCsv}
                  annotatedCognosCsv={output.annotatedCognosCsv}
                  emailActions={output.emailActions}
                  emailActionsJson={output.emailActionsJson}
                  config={config}
                  verificationAudit={output.verificationAudit}
                  summary={output.summary}
                  onToggleInclude={handleToggleInclude}
                  onToggleIncludeAll={handleToggleIncludeAll}
                  onSetReviewStatus={handleSetReviewStatus}
                  isStale={isHoldPolicyStale}
                  onRecalculate={handleRunReconciliation}
                />
              </div>
            )}
          </div>
        )}

        {activeTab === 'dataPreview' && (
          <DataPreviewView
            cognosRecords={cognosRecords}
            aspectSegments={aspectSegments}
            aspectIdentities={aspectIdentities}
            cmsPunches={cmsPunches}
          />
        )}

        {activeTab === 'results' && (
          <div>
            {output ? (
              <ResultsView
                rows={output.rows}
                aspectCorrectionsCsv={output.aspectCorrectionsCsv}
                annotatedCognosCsv={output.annotatedCognosCsv}
                emailActions={output.emailActions}
                emailActionsJson={output.emailActionsJson}
                config={config}
                verificationAudit={output.verificationAudit}
                summary={output.summary}
                onToggleInclude={handleToggleInclude}
                onToggleIncludeAll={handleToggleIncludeAll}
                onSetReviewStatus={handleSetReviewStatus}
                isStale={isHoldPolicyStale}
                onRecalculate={handleRunReconciliation}
              />
            ) : (
              <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center space-y-4 shadow-xs">
                <p className="text-slate-500 text-sm font-medium">
                  No reconciliation has been executed yet.
                </p>
                <div className="flex items-center justify-center space-x-3">
                  <button
                    onClick={handleLoadSampleData}
                    className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm shadow-indigo-200 transition-all cursor-pointer"
                  >
                    Load Sample Test Data
                  </button>
                  <button
                    onClick={() => setActiveTab('dashboard')}
                    className="px-4 py-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-all cursor-pointer"
                  >
                    Upload Files
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'glossary' && (
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900">Segment Glossary Classification (§4.14)</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Defines whether each schedule segment code adds hours (+), subtracts hours (-), or has zero effect (0).
                    Leave identity and the non-working day gate are configured separately on the{' '}
                    <button onClick={() => setActiveTab('leaveSegments')} className="text-indigo-600 hover:text-indigo-700 font-semibold underline cursor-pointer">
                      Leave Segments
                    </button> page.
                  </p>
                </div>
                <button
                  onClick={() => setIsGlossaryOpen(true)}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm shadow-indigo-200 transition-all cursor-pointer"
                >
                  Edit Classifications
                </button>
              </div>

              {/* Phase 7: same Addition/Removal/No Effect/Unclassified filtered
                  tabs as the Review Classifications modal. Addition/Removal/
                  No Effect read config.segmentGlossary directly; Unclassified
                  reads unclassifiedDiscoveredCodes (computed once in App.tsx
                  from the current ASPECT upload) since those codes by
                  definition have no entry in segmentGlossary to iterate. */}
              {(() => {
                const allEntries = Object.entries(config.segmentGlossary) as [string, GlossaryEntry][];
                const countFor = (role: 'ADDITION' | 'REMOVAL' | 'NO_EFFECT') =>
                  allEntries.filter(([, entry]) => (entry.role || 'NO_EFFECT') === role).length;
                return (
                  <div className="flex items-center gap-1.5 border-b border-slate-200">
                    {([
                      ['UNCLASSIFIED', `⚠ Unclassified (${unclassifiedDiscoveredCodes.length})`, 'red'],
                      ['ADDITION', `+ Addition (${countFor('ADDITION')})`, 'emerald'],
                      ['REMOVAL', `− Removal (${countFor('REMOVAL')})`, 'rose'],
                      ['NO_EFFECT', `No Effect (${countFor('NO_EFFECT')})`, 'slate'],
                    ] as const).map(([tabRole, label, color]) => (
                      <button
                        key={tabRole}
                        type="button"
                        onClick={() => setGlossarySummaryTab(tabRole)}
                        className={`px-3 py-1.5 rounded-t-lg text-xs font-semibold transition-all cursor-pointer border border-b-0 -mb-px ${
                          glossarySummaryTab === tabRole
                            ? color === 'emerald'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : color === 'rose'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : color === 'red'
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                            : color === 'red' && unclassifiedDiscoveredCodes.length > 0
                              ? 'bg-transparent text-red-600 border-transparent hover:text-red-700 hover:bg-red-50'
                              : 'bg-transparent text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                );
              })()}

              {/* Table of glossary entries in the active tab */}
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
                    <tr>
                      <th className="py-3 px-4">Segment Code</th>
                      <th className="py-3 px-4">Hours Calculation Role</th>
                      <th className="py-3 px-4">Non-Working Day Flag</th>
                      <th className="py-3 px-4">Write-Only Action Flag</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(() => {
                      // Unclassified rows have no GlossaryEntry by definition — entry is
                      // undefined for them, rendered as a distinct red badge below rather
                      // than folded into the No Effect styling.
                      const rows: { code: string; entry: GlossaryEntry | undefined }[] =
                        glossarySummaryTab === 'UNCLASSIFIED'
                          ? unclassifiedDiscoveredCodes.map(code => ({ code, entry: undefined }))
                          : Object.entries(config.segmentGlossary)
                              .filter(([, entry]: [string, GlossaryEntry]) => (entry.role || 'NO_EFFECT') === glossarySummaryTab)
                              .map(([code, entry]: [string, GlossaryEntry]) => ({ code, entry }));

                      if (rows.length === 0) {
                        return (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-xs text-slate-400 font-sans">
                              No matching codes in this tab.
                            </td>
                          </tr>
                        );
                      }

                      return rows.map(({ code, entry }) => (
                        <tr key={code} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-3 px-4 font-bold text-slate-900">{code}</td>
                          <td className="py-3 px-4">
                            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold border ${
                              !entry
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : entry.role === 'ADDITION'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : entry.role === 'REMOVAL'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}>
                              {!entry ? '⚠ Unclassified' : entry.role === 'ADDITION' ? '+ Addition' : entry.role === 'REMOVAL' ? '− Removal' : 'No Effect (0)'}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-sans text-xs">
                            {config.nonWorkingDaySegmentCodes.some(c => c.trim().toUpperCase() === code.trim().toUpperCase()) ? (
                              <span className="text-amber-700 font-semibold">Yes (Excludes Absences)</span>
                            ) : (
                              <span className="text-slate-400">No</span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-sans text-xs">
                            {entry?.isWriteOnlyAction ? (
                              <span className="text-sky-700 font-semibold">Yes (Output Action Only)</span>
                            ) : (
                              <span className="text-slate-400">No</span>
                            )}
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'leaveSegments' && (
          <LeaveSegmentsView
            config={config}
            discoveredCodes={discoveredCodes}
            discoveredCognosLeaveTypes={discoveredCognosLeaveTypes}
            onSaveConfig={handleSaveConfig}
            onDirtyChange={setIsConfigDirty}
          />
        )}

        {activeTab === 'config' && (
          <ConfigRegistryView config={config} onSaveConfig={handleSaveConfig} onDirtyChange={setIsConfigDirty} />
        )}

        {activeTab === 'holdPolicy' && (
          <div className="space-y-4">
            {isHoldPolicyStale && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950">
                <div className="font-semibold">
                  Hold policy changed after this calculation — results and exports are out of date. Re-calculate to apply.
                </div>
                <button
                  type="button"
                  onClick={handleRunReconciliation}
                  className="rounded border border-amber-400 bg-white px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Re-calculate
                </button>
              </div>
            )}
            <HoldPolicyView
              config={config}
              rows={output ? output.rows : null}
              isStale={isHoldPolicyStale}
              onSave={handleSaveHoldPolicy}
              onRecalculate={handleRunReconciliation}
            />
          </div>
        )}

        {activeTab === 'regression' && (
          <RegressionSuiteView config={config} />
        )}

        {activeTab === 'scenarios' && (
          <ScenarioGuideView config={config} />
        )}

        {activeTab === 'fieldReference' && (
          <FieldReferenceView
            rawFileTexts={rawFileTexts}
            columnMappings={columnMappings}
            inputFileNames={inputFileNames}
            rowCounts={{
              cognos: cognosRecords.length,
              aspect: aspectSegments.length,
              identity: aspectIdentities.length,
              cms: cmsPunches.length,
            }}
            onApplyMapping={handleApplyColumnMapping}
            onApplyMappingAndRecalculate={handleApplyMappingAndRecalculate}
            canCalculate={canCalculate}
            isCalculating={isCalculating}
          />
        )}
        </main>
      </div>

      {/* Email Config Setup Wizard */}
      <EmailConfigWizardModal
        isOpen={isEmailWizardOpen}
        onClose={() => setIsEmailWizardOpen(false)}
        config={config}
        onSaveConfig={handleSaveConfig}
      />

      {/* Discovery Glossary Modal */}
      <DiscoveryGlossaryModal
        isOpen={isGlossaryOpen}
        onClose={() => setIsGlossaryOpen(false)}
        config={config}
        onSaveConfig={handleSaveConfig}
        discoveredCodes={discoveredCodes}
      />

      {/* Column Mapping Modal — reads the REAL raw headers from the uploaded
          file (not canonical field names) and, on Apply, actually re-parses
          the stored raw text with the chosen mapping. */}
      {columnMapperFileType && (
        <ColumnMappingModal
          isOpen={!!columnMapperFileType}
          onClose={() => setColumnMapperFileType(null)}
          fileType={columnMapperFileType}
          detectedHeaders={
            rawFileTexts[columnMapperFileType]
              ? extractHeaders(rawFileTexts[columnMapperFileType]!)
              : []
          }
          initialMapping={columnMapperFileType === 'cms' ? undefined : columnMappings[columnMapperFileType]}
          onApplyMapping={(mapping) => handleApplyColumnMapping(columnMapperFileType, mapping)}
        />
      )}
      {isVerificationOverrideOpen && (
        <VerificationOverrideModal
          failedChecks={failedVerificationChecks}
          onCancel={() => setIsVerificationOverrideOpen(false)}
          onConfirm={handleAuthorizeVerificationOverride}
        />
      )}
    </div>
  );
}
