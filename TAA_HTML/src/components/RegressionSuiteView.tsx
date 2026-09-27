import React, { useState } from 'react';
import { Play, CheckCircle2, XCircle, Shield, AlertTriangle, ChevronDown, ChevronUp, RefreshCw, Check } from 'lucide-react';
import { runAllRegressionTests, TestCaseResult } from '../services/regressionSuite';
import { runTrustMatrixTests } from '../services/trustMatrix';
import { diffPolicyRulesFromDefaults } from '../services/configRegistry';
import { ConfigRegistry } from '../types/taa';

interface RegressionSuiteViewProps {
  config: ConfigRegistry;
}

type SuiteTab = 'regression' | 'trust';

export function RegressionSuiteView({ config }: RegressionSuiteViewProps) {
  // Defect fix: previously always ran against DEFAULT_CONFIG, so a user who
  // tuned their own thresholds saw a green "100% Compliant" badge for a
  // ruleset they were not actually running. Now runs against the LIVE config.
  const [results, setResults] = useState<TestCaseResult[]>(() => runAllRegressionTests(config));
  const [trustResults, setTrustResults] = useState<TestCaseResult[]>(() => runTrustMatrixTests(config));
  const [activeTab, setActiveTab] = useState<SuiteTab>('regression');
  const [isRunning, setIsRunning] = useState(false);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);

  const activeResults = activeTab === 'regression' ? results : trustResults;
  const passedCount = activeResults.filter(r => r.passed).length;
  const totalCount = activeResults.length;
  const passRate = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

  const trustPassedCount = trustResults.filter(r => r.passed).length;
  const trustFamilies = Array.from(new Set(trustResults.map(r => r.category)));
  const policyDrift = diffPolicyRulesFromDefaults(config.policyRules);
  const failingCount = totalCount - passedCount;

  const handleRunAll = () => {
    setIsRunning(true);
    setTimeout(() => {
      setResults(runAllRegressionTests(config));
      setTrustResults(runTrustMatrixTests(config));
      setIsRunning(false);
    }, 200);
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-bold text-slate-900">Regression Suite — {totalCount} Cases (§6.6)</h3>
                <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold font-mono border border-emerald-200 uppercase tracking-wider">
                  {passedCount}/{totalCount} Passed (100% Target)
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Automated verification of core payroll scenarios: Defect 1 (Nursing carve-outs), Defect 2 (Night shifts), §4.6b Leave Integrity, §4.8 Flex Staff 10:00 cutoff, and §4.11 Sequential Cover Placement.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={handleRunAll}
          disabled={isRunning}
          className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center space-x-2 shadow-sm shadow-emerald-200 transition-all"
        >
          {isRunning ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Running Suite...</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              <span>Run All {totalCount} Tests</span>
            </>
          )}
        </button>
      </div>

      {/* Suite Tabs */}
      <div className="flex items-center space-x-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('regression')}
          className={`px-4 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'regression' ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50' : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Regression Suite ({results.length})
        </button>
        <button
          onClick={() => setActiveTab('trust')}
          className={`px-4 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${
            activeTab === 'trust' ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50' : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Trust Matrix ({trustPassedCount}/{trustResults.length} — {trustFamilies.length} families)
        </button>
      </div>

      {activeTab === 'trust' && (
        <div className="bg-indigo-50/60 border border-indigo-200 rounded-2xl p-4 text-xs text-indigo-900 space-y-1">
          <p className="font-bold">Independent trust source — not derived from the engine's own code.</p>
          <p>Expected verdicts are hand-derived from <code className="font-mono">Rules to be taken.csv</code> and doc/CLAUDE.md's non-negotiables. D-A (both rules on one row must both be charged and reported), D-B (Late Logout measured from the release/nursing-adjusted effective end), D-C (single-punch evidence is span-based for all staff, including flex), and D-D (deterministic punch-attribution tie-break with unresolved ties held) are fixed and asserted — see doc/TAA_KNOWLEDGE_BASE.md §7a.</p>
        </div>
      )}

      {activeTab === 'regression' && failingCount > 0 && policyDrift.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900 space-y-2">
          <p className="font-bold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            This suite ran against your customized policy config, not the shipped defaults — some failures below may be intentional policy changes, not engine defects.
          </p>
          <p>Each of the {results.length} cases asserts against the default band table (e.g. Late Login OPS flips to Absent at exactly 61 minutes). {policyDrift.length} field{policyDrift.length === 1 ? '' : 's'} in your live config differ from that default:</p>
          <ul className="list-disc list-inside space-y-0.5 font-mono">
            {policyDrift.map((d, i) => (
              <li key={i}>{d.segmentType} ({d.tier}) — {d.field}: default "{d.defaultValue}" → live "{d.liveValue}" [{d.ruleId}]</li>
            ))}
          </ul>
        </div>
      )}

      {/* Pass Rate Progress Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500 font-medium">Payroll Compliance Verification Status:</span>
          <span className="font-mono font-bold text-emerald-600 text-sm">{passRate}% Complete ({passedCount}/{totalCount})</span>
        </div>
        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${passRate}%` }}
          />
        </div>
      </div>

      {/* Test Cases List */}
      <div className="space-y-3">
        {activeResults.map(tc => (
          <div
            key={tc.id}
            className={`border rounded-2xl transition-all overflow-hidden shadow-xs ${
              tc.passed
                ? 'bg-white border-slate-200 hover:border-slate-300'
                : 'bg-rose-50/50 border-rose-200'
            }`}
          >
            <div
              onClick={() => setExpandedCaseId(expandedCaseId === tc.id ? null : tc.id)}
              className="p-5 flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center space-x-3.5">
                <div className="shrink-0">
                  {tc.passed ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-rose-600" />
                  )}
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-mono text-xs text-indigo-600 font-bold">{tc.id}</span>
                    <span className="text-sm font-bold text-slate-900">{tc.name}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-mono font-semibold uppercase tracking-wider border border-slate-200">
                      {tc.category}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{tc.inputDescription}</p>
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <span className={`text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                  tc.passed ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                }`}>
                  {tc.passed ? 'PASSED' : 'FAILED'}
                </span>
                {expandedCaseId === tc.id ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </div>
            </div>

            {/* Expandable Trace Details */}
            {expandedCaseId === tc.id && (
              <div className="px-6 pb-6 pt-3 border-t border-slate-100 bg-slate-50/80 text-xs space-y-3.5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Flawed Cognos Verdict */}
                  <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs space-y-1">
                    <span className="text-[10px] text-rose-600 font-bold uppercase tracking-wider block mb-1">
                      Flawed Cognos Verdict
                    </span>
                    <div className="font-mono text-xs text-slate-700">
                      {tc.cognosFlawedVerdict}
                    </div>
                  </div>

                  {/* Expected TAA Verdict */}
                  <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs space-y-1">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block mb-1">
                      Expected Recomputed Verdict
                    </span>
                    <div className="font-mono text-xs text-slate-800">
                      Verdict: <strong>{tc.expectedVerdict}</strong>
                    </div>
                    <div className="font-mono text-xs text-slate-500">
                      Action: {tc.expectedAction}
                    </div>
                  </div>

                  {/* Actual TAA Result */}
                  <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs space-y-1">
                    <span className="text-[10px] text-emerald-700 font-bold uppercase tracking-wider block mb-1">
                      Actual Recomputed Result
                    </span>
                    <div className="font-mono text-xs text-indigo-700 font-bold">
                      Verdict: <strong>{tc.actualVerdict}</strong>
                    </div>
                    <div className="font-mono text-xs text-indigo-600">
                      Action: {tc.actualAction}
                    </div>
                  </div>
                </div>

                {/* Payroll Risk / Rationale */}
                <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs text-slate-700 space-y-1">
                  <div className="text-[10px] text-amber-800 font-bold uppercase tracking-wider">
                    Payroll Risk Mitigation Rationale:
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{tc.payrollImpact}</p>
                </div>

                {/* Calculation Trace Log */}
                {tc.calculationTrace && tc.calculationTrace.length > 0 && (
                  <div className="p-4 bg-slate-900 text-slate-200 rounded-xl border border-slate-800 space-y-1 font-mono text-[11px] shadow-inner">
                    <div className="text-slate-400 font-sans font-bold mb-1 text-xs">Calculation Trace:</div>
                    {tc.calculationTrace.map((line, idx) => (
                      <div key={idx} className="text-slate-300">{line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
