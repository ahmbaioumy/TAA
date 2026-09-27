import { useMemo, useState } from 'react';
import { HelpCircle, Wand2, ListChecks, BookMarked, Search, Mail } from 'lucide-react';
import { ConfigRegistry, RoleTier, CommunicationRule } from '../types/taa';
import { buildScenarioCatalog, simulateScenario, ScenarioSimInput, DataGapReason, COMMUNICATION_DESCRIPTIONS } from '../services/scenarioGuide';

interface ScenarioGuideViewProps {
  config: ConfigRegistry;
}

const DEFAULT_SIM_INPUT: ScenarioSimInput = {
  tier: 'OPS',
  isFlex: false,
  isLeaveDay: false,
  leaveDayPunchMinutes: 0,
  alreadyMarkedAbsent: false,
  absenceMarkerPunchMinutes: 0,
  hasAspectSchedule: true,
  dataGapReason: 'noSegments',
  punchCount: 2,
  attendanceSpanMinutes: 480,
  coverageSufficient: true,
  rawStartTime: '08:00',
  actualFirstLoginTime: '08:00',
  lateMin: 0,
  earlyMin: 0,
  lateLogoutMin: 0,
  coverShortfallMin: 0,
  rlsOverlapMin: 0,
};

const inputClass = 'px-2.5 py-1.5 rounded-md bg-slate-50 border border-slate-200 text-slate-800 focus:outline-none focus:border-indigo-500 text-xs w-full';
const labelClass = 'block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1';

function CommBadge({ communication }: { communication: CommunicationRule }) {
  if (communication === 'NA') return null;
  return (
    <span
      title={COMMUNICATION_DESCRIPTIONS[communication]}
      className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 align-middle"
    >
      <Mail className="w-2.5 h-2.5" /> {communication === 'EMAIL_OPS' ? 'OPS notified' : 'Staff + manager notified'}
    </span>
  );
}

export function ScenarioGuideView({ config }: ScenarioGuideViewProps) {
  const [sim, setSim] = useState<ScenarioSimInput>(DEFAULT_SIM_INPUT);
  const [filter, setFilter] = useState('');

  const update = (patch: Partial<ScenarioSimInput>) => setSim(prev => ({ ...prev, ...patch }));

  // Recomputed fresh from the live config every time — never cached, never authored text.
  const groups = useMemo(() => buildScenarioCatalog(config), [config]);
  const result = useMemo(() => simulateScenario(sim, config), [sim, config]);

  const filterLower = filter.trim().toLowerCase();
  const filteredGroups = filterLower
    ? groups
        .map(g => ({ ...g, lines: g.lines.filter(l => `${l.caseText} ${l.resultText} ${g.title}`.toLowerCase().includes(filterLower)) }))
        .filter(g => g.lines.length > 0)
    : groups;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 flex items-center gap-3 shadow-xs">
        <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
          <HelpCircle className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-base font-bold text-slate-900">Scenario Guide</h3>
          <p className="text-xs text-slate-500 mt-1">
            Every case the app can encounter, in plain English, generated live from your current Config Registry settings — plus a simulator to check any one scenario directly.
          </p>
        </div>
      </div>

      {/* Simulator */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex items-center space-x-2">
          <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100">
            <Wand2 className="w-4.5 h-4.5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-900">Check a Scenario</h4>
            <p className="text-xs text-slate-500 mt-0.5">Plug in an assumption — the result updates instantly using the live rules.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className={labelClass}>Role Tier</label>
            <select className={inputClass} value={sim.tier} onChange={e => update({ tier: e.target.value as RoleTier })}>
              <option value="OPS">Ops staff</option>
              <option value="OFFICER_PLUS">Officer+</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Flex staff?</label>
            <select className={inputClass} value={sim.isFlex ? 'yes' : 'no'} onChange={e => update({ isFlex: e.target.value === 'yes' })}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Scheduled Leave Day?</label>
            <select className={inputClass} value={sim.isLeaveDay ? 'yes' : 'no'} onChange={e => update({ isLeaveDay: e.target.value === 'yes' })}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          {!sim.isLeaveDay && (
            <div>
              <label className={labelClass}>Already marked absent in ASPECT?</label>
              <select className={inputClass} value={sim.alreadyMarkedAbsent ? 'yes' : 'no'} onChange={e => update({ alreadyMarkedAbsent: e.target.value === 'yes' })}>
                <option value="no">No</option>
                <option value="yes">Yes (ABSENT / Absent NS/NC segment present)</option>
              </select>
            </div>
          )}
          {!sim.isLeaveDay && !sim.alreadyMarkedAbsent && (
            <div>
              <label className={labelClass}>ASPECT schedule exists?</label>
              <select className={inputClass} value={sim.hasAspectSchedule ? 'yes' : 'no'} onChange={e => update({ hasAspectSchedule: e.target.value === 'yes' })}>
                <option value="yes">Yes</option>
                <option value="no">No (data gap)</option>
              </select>
            </div>
          )}
        </div>

        {!sim.isLeaveDay && sim.alreadyMarkedAbsent && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
            <div>
              <label className={labelClass}>CMS login span on the already-absent day (min)</label>
              <input type="number" min={0} className={inputClass} value={sim.absenceMarkerPunchMinutes ?? 0} onChange={e => update({ absenceMarkerPunchMinutes: Number(e.target.value) })} />
            </div>
          </div>
        )}

        {sim.isLeaveDay && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
            <div>
              <label className={labelClass}>CMS login span on leave day (min)</label>
              <input type="number" className={inputClass} value={sim.leaveDayPunchMinutes ?? 0} onChange={e => update({ leaveDayPunchMinutes: Number(e.target.value) })} />
            </div>
          </div>
        )}

        {!sim.isLeaveDay && !sim.alreadyMarkedAbsent && !sim.hasAspectSchedule && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
            <div>
              <label className={labelClass}>Why no schedule?</label>
              <select className={inputClass} value={sim.dataGapReason} onChange={e => update({ dataGapReason: e.target.value as DataGapReason })}>
                <option value="noSegments">No ASPECT data at all</option>
                <option value="dateMismatch">Has segments, but not this date</option>
                <option value="unparseable">Cognos Sign In Date unparseable</option>
              </select>
            </div>
          </div>
        )}

        {!sim.isLeaveDay && !sim.alreadyMarkedAbsent && sim.hasAspectSchedule && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
              <div>
                <label className={labelClass}>CMS punches found</label>
                <input type="number" min={0} className={inputClass} value={sim.punchCount} onChange={e => update({ punchCount: Number(e.target.value) })} />
              </div>
              {sim.punchCount >= 2 && (
                <div>
                  <label className={labelClass}>Attendance span (min)</label>
                  <input type="number" className={inputClass} value={sim.attendanceSpanMinutes ?? 0} onChange={e => update({ attendanceSpanMinutes: Number(e.target.value) })} />
                </div>
              )}
              <div>
                <label className={labelClass}>CMS export coverage sufficient?</label>
                <select className={inputClass} value={sim.coverageSufficient ? 'yes' : 'no'} onChange={e => update({ coverageSufficient: e.target.value === 'yes' })}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>

            {sim.punchCount >= 2 && sim.isFlex && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
                <div>
                  <label className={labelClass}>Scheduled start (HH:MM)</label>
                  <input className={inputClass} value={sim.rawStartTime} onChange={e => update({ rawStartTime: e.target.value })} placeholder="08:00" />
                </div>
                <div>
                  <label className={labelClass}>Actual first login (HH:MM)</label>
                  <input className={inputClass} value={sim.actualFirstLoginTime} onChange={e => update({ actualFirstLoginTime: e.target.value })} placeholder="10:15" />
                </div>
                <div>
                  <label className={labelClass}>Early logout (min, 0 = none)</label>
                  <input type="number" className={inputClass} value={sim.earlyMin ?? 0} onChange={e => update({ earlyMin: Number(e.target.value) })} />
                </div>
                <div>
                  <label className={labelClass}>Late logout (min, 0 = none)</label>
                  <input type="number" className={inputClass} value={sim.lateLogoutMin ?? 0} onChange={e => update({ lateLogoutMin: Number(e.target.value) })} />
                </div>
              </div>
            )}

            {sim.punchCount >= 2 && !sim.isFlex && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
                <div>
                  <label className={labelClass}>Late arrival (min, 0 = none)</label>
                  <input type="number" className={inputClass} value={sim.lateMin ?? 0} onChange={e => update({ lateMin: Number(e.target.value) })} />
                </div>
                <div>
                  <label className={labelClass}>Early logout (min, 0 = none)</label>
                  <input type="number" className={inputClass} value={sim.earlyMin ?? 0} onChange={e => update({ earlyMin: Number(e.target.value) })} />
                </div>
                <div>
                  <label className={labelClass}>Late logout (min, 0 = none)</label>
                  <input type="number" className={inputClass} value={sim.lateLogoutMin ?? 0} onChange={e => update({ lateLogoutMin: Number(e.target.value) })} />
                  <p className="text-[9px] text-slate-400 mt-0.5">Only checked when Early logout is 0.</p>
                </div>
                <div>
                  <label className={labelClass}>Cover Not Attended (min)</label>
                  <input type="number" className={inputClass} value={sim.coverShortfallMin ?? 0} onChange={e => update({ coverShortfallMin: Number(e.target.value) })} />
                </div>
                <div>
                  <label className={labelClass}>OT/RLS overlap (min)</label>
                  <input type="number" className={inputClass} value={sim.rlsOverlapMin ?? 0} onChange={e => update({ rlsOverlapMin: Number(e.target.value) })} />
                </div>
              </div>
            )}
          </>
        )}

        {/* Result */}
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600">Result</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white border border-indigo-200 text-indigo-700">{result.verdict}</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white border border-indigo-200 text-indigo-700">{result.action}</span>
            <CommBadge communication={result.communication} />
            <a href={`#rule-${result.refCode}`} className="ml-auto text-[10px] font-bold text-indigo-600 hover:text-indigo-800 underline underline-offset-2">
              See {result.refCode} in Rule Reference ↓
            </a>
          </div>
          <p className="text-xs text-slate-800 font-medium">{result.actionText}</p>
          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer select-none font-semibold text-slate-600">Why (step by step)</summary>
            <ol className="mt-1.5 space-y-1 list-decimal list-inside">
              {result.trace.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </details>
        </div>
      </div>

      {/* Scenario list */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <div className="p-2 rounded-xl bg-sky-50 text-sky-600 border border-sky-100">
              <ListChecks className="w-4.5 h-4.5" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900">All Scenarios</h4>
              <p className="text-xs text-slate-500 mt-0.5">Hardest / most config-sensitive cases first, then the simple minute-band rules.</p>
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              className={`${inputClass} pl-8`}
              placeholder="Filter by tier, keyword..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-5">
          {filteredGroups.map(group => (
            <div key={group.refCode}>
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                    group.complexity === 'complex' ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}
                >
                  {group.complexity === 'complex' ? 'Multi-factor' : 'Direct'}
                </span>
                <h5 className="text-xs font-bold text-slate-800">{group.title}</h5>
              </div>
              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                {group.lines.map(line => (
                  <div key={line.id} className="flex items-start justify-between gap-4 py-2.5 px-3.5 hover:bg-slate-50/70 transition-colors">
                    <p className="text-xs text-slate-700 leading-relaxed">
                      <span className="font-semibold text-slate-900">{line.caseText}</span>
                      <span className="mx-1.5 text-indigo-400 font-bold">&gt;&gt;</span>
                      <span>{line.resultText}</span>
                      <CommBadge communication={line.communication} />
                    </p>
                    <a
                      href={`#rule-${group.refCode}`}
                      title="Jump to the full rule detail"
                      className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors"
                    >
                      {group.refCode} ↗
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {filteredGroups.length === 0 && <p className="text-xs text-slate-400 text-center py-6">No scenarios match "{filter}".</p>}
        </div>
      </div>

      {/* Rule Reference appendix */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-6">
        <div className="flex items-center space-x-2">
          <div className="p-2 rounded-xl bg-slate-100 text-slate-600 border border-slate-200">
            <BookMarked className="w-4.5 h-4.5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-900">Rule Reference</h4>
            <p className="text-xs text-slate-500 mt-0.5">The full technical detail behind every R_n code above, read live from Config Registry.</p>
          </div>
        </div>

        {groups.map(group => (
          <div key={group.refCode} id={`rule-${group.refCode}`} className="pt-4 border-t border-slate-100 scroll-mt-20">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">{group.refCode}</span>
              <h5 className="text-xs font-bold text-slate-900">{group.title}</h5>
            </div>
            <p className="text-[11px] text-slate-500 mb-2.5">{group.summary}</p>

            {group.referenceRows && group.referenceRows.length > 0 && (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[9px]">
                    <tr>
                      <th className="py-2 px-3">Tier</th>
                      <th className="py-2 px-3">Band</th>
                      <th className="py-2 px-3">Action Code</th>
                      <th className="py-2 px-3">Communication</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {group.referenceRows.map((row, i) => (
                      <tr key={i}>
                        <td className="py-1.5 px-3">
                          <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-sans font-semibold border ${row.tier === 'OFFICER_PLUS' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {row.tier}
                          </span>
                        </td>
                        <td className="py-1.5 px-3 text-slate-700">{row.band}</td>
                        <td className="py-1.5 px-3 text-slate-700">{row.action}</td>
                        <td className="py-1.5 px-3 text-slate-700">{row.communication}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {group.configFields && group.configFields.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {group.configFields.map(f => (
                  <span key={f.field} className="px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-[10px] font-mono text-slate-600">
                    <span className="text-slate-400">{f.field} = </span>
                    <span className="font-bold text-slate-800">{f.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
