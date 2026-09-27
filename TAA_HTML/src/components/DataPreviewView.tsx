import React, { useState } from 'react';
import { CognosRecord, AspectSegment, AspectIdentity, CMSPunch } from '../types/taa';
import { DataTable } from './DataTable';

interface DataPreviewViewProps {
  cognosRecords: CognosRecord[];
  aspectSegments: AspectSegment[];
  aspectIdentities: AspectIdentity[];
  cmsPunches: CMSPunch[];
}

const COGNOS_COLUMNS: (keyof CognosRecord & string)[] = [
  'SIGN IN DATE', 'SECTION', 'PF NO', 'NAME', 'LOGIN ID', 'DUTY1', 'OT1', 'DUTY-2', 'OT-2',
  'SCH DURATION', 'SIGNIN DURATION', 'SIGIN IN', 'SIGIN OUT', 'LATE START', 'LEFT EARLY',
  'LEAVE TYPE', 'LEAVE HR', 'REMARK',
];

const ASPECT_SEGMENT_COLUMNS: (keyof AspectSegment & string)[] = [
  'PRI_INDEX', 'EMP_SK', 'EMP_ID', 'EMP_LAST_NAME', 'EMP_FIRST_NAME', 'EMP_SORT_NAME',
  'EMP_SHORT_NAME', 'EMP_SENIORITY', 'EMP_EFF_HIRE_DATE', 'NOM_DATE', 'START_DATE', 'SEG_CODE',
  'START_MOMENT', 'STOP_MOMENT', 'DURATION', 'RANK', 'EMP_CLASS_1', 'EMP_CLASS_1_DESCR',
];

const ASPECT_IDENTITY_COLUMNS: (keyof AspectIdentity & string)[] = [
  'PRI_INDEX', 'EMP_SK', 'EMP_ID', 'EMP_LAST_NAME', 'EMP_FIRST_NAME', 'EMP_SORT_NAME',
  'EMP_SHORT_NAME', 'EMP_SENIORITY', 'EMP_EFF_HIRE_DATE', 'EMP_TERM_DATE', 'EMP_ACTIVE_FLAG',
  'EMP_TIME_ZONE', 'EMP_EMAIL_ADR', 'EMP_MEMO', 'EMP_CLASS_1', 'EMP_CLASS_1_DESCR', 'EMP_EXTRA_1',
  'EMP_EXTRA_2', 'EMP_EXTRA_3', 'EMP_EXTRA_4', 'START_DATE',
];

const CMS_COLUMNS: (keyof CMSPunch & string)[] = [
  'Date', 'LoginID', 'LoginTimeStr', 'LogoutTimeStr', 'LoginDateTime', 'LogoutDateTime',
];

type SourceTab = 'cognos' | 'aspectSegments' | 'aspectIdentities' | 'cms';

export function DataPreviewView({ cognosRecords, aspectSegments, aspectIdentities, cmsPunches }: DataPreviewViewProps) {
  const [sourceTab, setSourceTab] = useState<SourceTab>('cognos');

  const pills: { key: SourceTab; label: string; count: number }[] = [
    { key: 'cognos', label: 'Cognos', count: cognosRecords.length },
    { key: 'aspectSegments', label: 'ASPECT Segments', count: aspectSegments.length },
    { key: 'aspectIdentities', label: 'ASPECT ExtraFiled2', count: aspectIdentities.length },
    { key: 'cms', label: 'CMS (merged)', count: cmsPunches.length },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Uploaded Data</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Validate each uploaded source as-parsed. CMS reflects all uploaded files merged with duplicates removed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-slate-100/90 border border-slate-200/80 text-xs w-fit">
        {pills.map(p => (
          <button
            key={p.key}
            onClick={() => setSourceTab(p.key)}
            className={`px-3.5 py-1.5 rounded-lg font-semibold transition-all ${
              sourceTab === p.key
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            }`}
          >
            {p.label} <span className="text-slate-400 font-mono">· {p.count.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {sourceTab === 'cognos' && (
        <DataTable rows={cognosRecords} columns={COGNOS_COLUMNS} emptyLabel="No Cognos file uploaded yet." />
      )}
      {sourceTab === 'aspectSegments' && (
        <DataTable rows={aspectSegments} columns={ASPECT_SEGMENT_COLUMNS} emptyLabel="No ASPECT schedule-segment file uploaded yet." />
      )}
      {sourceTab === 'aspectIdentities' && (
        <DataTable rows={aspectIdentities} columns={ASPECT_IDENTITY_COLUMNS} emptyLabel="No ASPECT ExtraFiled2 file uploaded yet." />
      )}
      {sourceTab === 'cms' && (
        <DataTable rows={cmsPunches} columns={CMS_COLUMNS} emptyLabel="No CMS file uploaded yet." />
      )}
    </div>
  );
}
