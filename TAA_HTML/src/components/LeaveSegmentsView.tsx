import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Save, Trash2 } from 'lucide-react';
import { CognosLeaveTypeMapping, ConfigRegistry } from '../types/taa';

interface LeaveSegmentsViewProps {
  config: ConfigRegistry;
  discoveredCodes: string[];
  discoveredCognosLeaveTypes: string[];
  onSaveConfig: (updated: ConfigRegistry) => void;
  onDirtyChange: (dirty: boolean) => void;
}

const norm = (s: string) => (s || '').trim().toUpperCase();

export function LeaveSegmentsView({
  config,
  discoveredCodes,
  discoveredCognosLeaveTypes,
  onSaveConfig,
  onDirtyChange,
}: LeaveSegmentsViewProps) {
  const [nonWorkingCodes, setNonWorkingCodes] = useState<string[]>(config.nonWorkingDaySegmentCodes);
  const [leaveCodes, setLeaveCodes] = useState<string[]>(config.leaveSegmentCodes);
  const [mappings, setMappings] = useState<CognosLeaveTypeMapping[]>(config.cognosLeaveTypeMappings);
  const [compareScheduleColumnsOnLeaveDays, setCompareScheduleColumnsOnLeaveDays] = useState<boolean>(config.compareScheduleColumnsOnLeaveDays);
  const [leaveCodesWithoutDuration, setLeaveCodesWithoutDuration] = useState<string[]>(config.leaveCodesWithoutDuration);
  const [genericLeaveContainerCodes, setGenericLeaveContainerCodes] = useState<string[]>(config.genericLeaveContainerCodes);
  const [cognosLeaveTypeVerdictValues, setCognosLeaveTypeVerdictValues] = useState<string[]>(config.cognosLeaveTypeVerdictValues);
  const [newMappingCognos, setNewMappingCognos] = useState('');
  const [newMappingTargets, setNewMappingTargets] = useState<string[]>([]);
  const [mappingError, setMappingError] = useState('');

  // Re-seed the draft whenever the saved config changes underneath us (e.g. import).
  useEffect(() => {
    setNonWorkingCodes(config.nonWorkingDaySegmentCodes);
    setLeaveCodes(config.leaveSegmentCodes);
    setMappings(config.cognosLeaveTypeMappings);
    setCompareScheduleColumnsOnLeaveDays(config.compareScheduleColumnsOnLeaveDays);
    setLeaveCodesWithoutDuration(config.leaveCodesWithoutDuration);
    setGenericLeaveContainerCodes(config.genericLeaveContainerCodes);
    setCognosLeaveTypeVerdictValues(config.cognosLeaveTypeVerdictValues);
  }, [
    config.nonWorkingDaySegmentCodes,
    config.leaveSegmentCodes,
    config.cognosLeaveTypeMappings,
    config.compareScheduleColumnsOnLeaveDays,
    config.leaveCodesWithoutDuration,
    config.genericLeaveContainerCodes,
    config.cognosLeaveTypeVerdictValues,
  ]);

  const isDirty = useMemo(() => {
    const arraysDiffer = (a: string[], b: string[]) =>
      a.length !== b.length || a.slice().sort().join('|') !== b.slice().sort().join('|');
    const mappingsDiffer = JSON.stringify(mappings) !== JSON.stringify(config.cognosLeaveTypeMappings);
    return arraysDiffer(nonWorkingCodes, config.nonWorkingDaySegmentCodes)
      || arraysDiffer(leaveCodes, config.leaveSegmentCodes)
      || mappingsDiffer
      || compareScheduleColumnsOnLeaveDays !== config.compareScheduleColumnsOnLeaveDays
      || arraysDiffer(leaveCodesWithoutDuration, config.leaveCodesWithoutDuration)
      || arraysDiffer(genericLeaveContainerCodes, config.genericLeaveContainerCodes)
      || arraysDiffer(cognosLeaveTypeVerdictValues, config.cognosLeaveTypeVerdictValues);
  }, [
    nonWorkingCodes,
    leaveCodes,
    mappings,
    compareScheduleColumnsOnLeaveDays,
    leaveCodesWithoutDuration,
    genericLeaveContainerCodes,
    cognosLeaveTypeVerdictValues,
    config,
  ]);

  useEffect(() => { onDirtyChange(isDirty); }, [isDirty, onDirtyChange]);

  // Every discovered code, every already-configured glossary code, and every code already
  // in either leave list — never silently hide a code that's actually in play.
  const allCodes = useMemo(() => {
    return Array.from(new Set([
      ...discoveredCodes,
      ...Object.keys(config.segmentGlossary),
      ...nonWorkingCodes,
      ...leaveCodes,
    ])).sort();
  }, [discoveredCodes, config.segmentGlossary, nonWorkingCodes, leaveCodes]);

  const isNonWorking = (code: string) => nonWorkingCodes.some(c => norm(c) === norm(code));
  const isLeave = (code: string) => leaveCodes.some(c => norm(c) === norm(code));
  const hasHoursClassification = (code: string) =>
    Object.keys(config.segmentGlossary).some(k => norm(k) === norm(code));

  const toggleNonWorking = (code: string) => {
    setNonWorkingCodes(prev => isNonWorking(code)
      ? prev.filter(c => norm(c) !== norm(code))
      : [...prev, norm(code)]);
    // Removing non-working status also removes leave status — a leave code must always
    // gate attendance (leaveSegmentCodes is a subset of nonWorkingDaySegmentCodes).
    if (isNonWorking(code) && isLeave(code)) {
      setLeaveCodes(prev => prev.filter(c => norm(c) !== norm(code)));
    }
  };

  const toggleLeave = (code: string) => {
    const nowLeave = !isLeave(code);
    setLeaveCodes(prev => nowLeave ? [...prev, norm(code)] : prev.filter(c => norm(c) !== norm(code)));
    // Marking a code as leave always also marks it non-working — leave is a proper
    // subset (every leave day excludes attendance; OFF is the reverse case: non-working
    // but not leave).
    if (nowLeave && !isNonWorking(code)) {
      setNonWorkingCodes(prev => [...prev, norm(code)]);
    }
  };

  const unclassifiedLeaveCodes = leaveCodes.filter(c => !hasHoursClassification(c));

  const handleAddMapping = () => {
    const cognosLeaveType = newMappingCognos.trim();
    if (!cognosLeaveType) {
      setMappingError('Cognos LEAVE TYPE value must not be blank.');
      return;
    }
    if (mappings.some(m => norm(m.cognosLeaveType) === norm(cognosLeaveType))) {
      setMappingError(`A mapping for "${cognosLeaveType}" already exists — edit or remove it instead.`);
      return;
    }
    if (newMappingTargets.length === 0) {
      setMappingError('Select at least one target ASPECT leave code.');
      return;
    }
    const notLeave = newMappingTargets.filter(c => !isLeave(c));
    if (notLeave.length > 0) {
      setMappingError(`${notLeave.join(', ')} must be marked as Leave before it can be a mapping target.`);
      return;
    }
    setMappings(prev => [...prev, { cognosLeaveType, aspectSegmentCodes: newMappingTargets }]);
    setNewMappingCognos('');
    setNewMappingTargets([]);
    setMappingError('');
  };

  const removeMapping = (cognosLeaveType: string) => {
    setMappings(prev => prev.filter(m => norm(m.cognosLeaveType) !== norm(cognosLeaveType)));
  };

  const handleSave = () => {
    onSaveConfig({
      ...config,
      nonWorkingDaySegmentCodes: nonWorkingCodes,
      leaveSegmentCodes: leaveCodes,
      cognosLeaveTypeMappings: mappings,
      compareScheduleColumnsOnLeaveDays,
      leaveCodesWithoutDuration,
      genericLeaveContainerCodes,
      cognosLeaveTypeVerdictValues,
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-900">Leave Segments</h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              Which ASPECT codes are leave, which non-working codes (e.g. a scheduled day off) merely stop
              the attendance gate, and how Cognos's LEAVE TYPE spellings map onto them. Separate from the
              Segment Glossary's Addition/Removal/No-Effect hours role.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all cursor-pointer ${
              isDirty
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-200'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            }`}
          >
            <Save className="w-4 h-4" />
            <span>Save & Apply</span>
          </button>
        </div>

        {unclassifiedLeaveCodes.length > 0 && (
          <div className="flex items-start space-x-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {unclassifiedLeaveCodes.join(', ')} {unclassifiedLeaveCodes.length === 1 ? 'has' : 'have'} no schedule-hours
              classification in the Segment Glossary — reconciliation is blocked until classified there (Addition, Removal,
              or No Effect).
            </span>
          </div>
        )}

        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200 text-[10px]">
              <tr>
                <th className="py-3 px-4">Segment Code</th>
                <th className="py-3 px-4">Hours Role</th>
                <th className="py-3 px-4 text-center">Non-Working (Excludes Attendance)</th>
                <th className="py-3 px-4 text-center">Leave</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {allCodes.map(code => {
                const classified = hasHoursClassification(code);
                const role = config.segmentGlossary[code]?.role
                  ?? Object.entries(config.segmentGlossary).find(([k]) => norm(k) === norm(code))?.[1]?.role;
                return (
                  <tr key={code} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-4 font-bold text-slate-900">{code}</td>
                    <td className="py-2.5 px-4 font-sans text-[11px]">
                      {classified ? (
                        <span className="text-slate-500">{role === 'ADDITION' ? '+ Addition' : role === 'REMOVAL' ? '− Removal' : 'No Effect (0)'}</span>
                      ) : (
                        <span className="text-rose-600 font-semibold">Unclassified</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={isNonWorking(code)}
                        onChange={() => toggleNonWorking(code)}
                        className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0 cursor-pointer"
                      />
                    </td>
                    <td className="py-2.5 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={isLeave(code)}
                        onChange={() => toggleLeave(code)}
                        className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0 cursor-pointer"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">Cognos LEAVE TYPE Mappings</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            A Cognos value matching an identified ASPECT leave code exactly always matches — a mapping is only
            needed for a genuine spelling difference (e.g. Cognos "U-ABSENT" meaning ASPECT "UNCERTIFIEDSICK" /
            "HOSPTLZD"). An unmapped, unmatched Cognos value is reported as a mismatch.
          </p>
        </div>

        <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
          {mappings.length === 0 && (
            <div className="py-4 px-4 text-xs text-slate-400">No mappings configured.</div>
          )}
          {mappings.map(m => (
            <div key={m.cognosLeaveType} className="flex items-center justify-between py-2.5 px-4 text-xs">
              <div className="flex items-center space-x-2">
                <span className="font-mono font-bold text-slate-900">{m.cognosLeaveType}</span>
                <span className="text-slate-400">→</span>
                <span className="font-mono text-slate-700">{m.aspectSegmentCodes.join(', ')}</span>
              </div>
              <button
                onClick={() => removeMapping(m.cognosLeaveType)}
                className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition-colors cursor-pointer"
                title="Remove mapping"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="pt-2 border-t border-slate-200 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              list="discovered-cognos-leave-types"
              placeholder="Cognos LEAVE TYPE value (e.g. U-ABSENT)"
              value={newMappingCognos}
              onChange={(e) => { setNewMappingCognos(e.target.value); setMappingError(''); }}
              className="flex-1 min-w-[220px] px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-indigo-500 font-mono shadow-2xs"
            />
            <datalist id="discovered-cognos-leave-types">
              {discoveredCognosLeaveTypes.map(v => <option key={v} value={v} />)}
            </datalist>
          </div>
          <div className="flex flex-wrap gap-2">
            {leaveCodes.length === 0 && (
              <span className="text-[11px] text-slate-400">Mark at least one code as Leave above to choose a target.</span>
            )}
            {leaveCodes.map(code => (
              <label key={code} className="flex items-center space-x-1.5 text-[11px] font-mono px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newMappingTargets.includes(code)}
                  onChange={() => setNewMappingTargets(prev =>
                    prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code])}
                  className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0"
                />
                <span>{code}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between">
            {mappingError && <span className="text-[11px] font-semibold text-rose-600">{mappingError}</span>}
            <button
              onClick={handleAddMapping}
              className="ml-auto px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center space-x-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Mapping</span>
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">Leave-Day Comparison Behavior</h3>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
            How schedule columns, structural full-day codes, and Cognos's own verdict/false-absence values are treated
            when comparing a leave day.
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-800 font-semibold">
          <input
            type="checkbox"
            checked={compareScheduleColumnsOnLeaveDays}
            onChange={(e) => setCompareScheduleColumnsOnLeaveDays(e.target.checked)}
            className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0 cursor-pointer"
          />
          Compare Schedule Columns (DUTY1/DUTY-2/SCH DURATION) on Leave Days
        </label>
        <p className="text-[11px] text-slate-500 -mt-2">
          Default OFF &mdash; on a leave day, ASPECT has no roster to attend, so comparing these columns against Cognos is a
          guaranteed false mismatch. LEAVE TYPE/LEAVE HR are always compared regardless.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-2">
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
            <label className="block text-slate-800 font-semibold">Leave Codes Without Duration:</label>
            <div className="flex flex-wrap gap-2">
              {leaveCodes.length === 0 && (
                <span className="text-[11px] text-slate-400">Mark at least one code as Leave above to choose here.</span>
              )}
              {leaveCodes.map(code => (
                <label key={code} className="flex items-center space-x-1.5 text-[11px] font-mono px-2.5 py-1 rounded-lg border border-slate-200 bg-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={leaveCodesWithoutDuration.some(c => norm(c) === norm(code))}
                    onChange={() => setLeaveCodesWithoutDuration(prev =>
                      prev.some(c => norm(c) === norm(code)) ? prev.filter(c => norm(c) !== norm(code)) : [...prev, norm(code)])}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0"
                  />
                  <span>{code}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              Structural full-day leave codes with no real ASPECT duration (e.g. ANNUAL, P, H-LV) &mdash; their summed
              duration is never compared against Cognos LEAVE HR.
            </p>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
            <label className="block text-slate-800 font-semibold">Generic Leave Container Codes:</label>
            <div className="flex flex-wrap gap-2">
              {leaveCodes.length === 0 && (
                <span className="text-[11px] text-slate-400">Mark at least one code as Leave above to choose here.</span>
              )}
              {leaveCodes.map(code => (
                <label key={code} className="flex items-center space-x-1.5 text-[11px] font-mono px-2.5 py-1 rounded-lg border border-slate-200 bg-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={genericLeaveContainerCodes.some(c => norm(c) === norm(code))}
                    onChange={() => setGenericLeaveContainerCodes(prev =>
                      prev.some(c => norm(c) === norm(code)) ? prev.filter(c => norm(c) !== norm(code)) : [...prev, norm(code)])}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-0"
                  />
                  <span>{code}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              Codes describing "on leave" without a reason (e.g. LEAVE) &mdash; when an employee-day also carries a more
              specific leave code, the specific code wins over a generic one for TAA_VERDICT/LEAVE TYPE purposes.
            </p>
          </div>
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2 text-xs">
          <label className="block text-slate-800 font-semibold">Cognos Leave-Type Verdict Values (Comma-Separated):</label>
          <textarea
            rows={2}
            placeholder="U-ABSENT"
            value={cognosLeaveTypeVerdictValues.join(', ')}
            onChange={(e) => setCognosLeaveTypeVerdictValues(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs shadow-2xs focus:outline-none focus:border-indigo-500"
          />
          <p className="text-[11px] text-slate-500">
            Cognos LEAVE TYPE values that are Cognos's own verdict/false-absence output, not a competing leave code &mdash;
            when Cognos shows one of these AND ASPECT shows a genuine leave code, LEAVE TYPE is reported NOT_COMPARABLE
            instead of MISMATCH.
          </p>
        </div>
      </div>
    </div>
  );
}
