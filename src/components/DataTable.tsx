import React, { useEffect, useMemo, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateDDMMYYYY, formatTimeHHMM } from '../services/parsers';

interface DataTableProps<T extends object> {
  rows: T[];
  columns: (keyof T & string)[];
  emptyLabel?: string;
}

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

// Defect fix: previously rendered Date cells with toLocaleString(), which
// follows the browser's locale (e.g. MM/DD/YYYY in en-US) — silently
// contradicting the DD/MM/YYYY HH:MM format required everywhere else in the
// app for uploaded CMS data.
function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return `${formatDateDDMMYYYY(value)} ${formatTimeHHMM(value)}`;
  return String(value);
}

// Generic, reusable table with a per-column substring filter row under the
// header — used to let users validate raw uploaded rows before they flow
// into reconciliation, not tied to any one source's shape. Paginated so a
// large upload never mounts thousands of rows into the DOM at once.
export function DataTable<T extends object>({ rows, columns, emptyLabel }: DataTableProps<T>) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);

  const filteredRows = useMemo(() => {
    const activeFilters = Object.entries(filters).filter(([, v]: [string, string]) => v.trim() !== '');
    if (activeFilters.length === 0) return rows;
    return rows.filter(row =>
      activeFilters.every(([col, val]: [string, string]) =>
        formatCell((row as Record<string, unknown>)[col]).toLowerCase().includes(val.toLowerCase())
      )
    );
  }, [rows, filters]);

  // Filtering or changing page size can leave `page` pointing past the new
  // (smaller) result set — snap back to page 1 rather than showing a blank page.
  useEffect(() => {
    setPage(1);
  }, [filters, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const pagedRows = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, clampedPage, pageSize]);

  const hasActiveFilters = Object.values(filters).some((v: string) => v.trim() !== '');

  if (rows.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-xs text-slate-400 shadow-xs">
        {emptyLabel || 'No rows — upload a file to see data here.'}
      </div>
    );
  }

  const rangeStart = filteredRows.length === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(clampedPage * pageSize, filteredRows.length);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
        <span>
          Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {filteredRows.length.toLocaleString()} rows
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
              className="px-1.5 py-1 rounded-md bg-white border border-slate-200 text-[11px] font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            >
              {PAGE_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          {hasActiveFilters && (
            <button
              onClick={() => setFilters({})}
              className="flex items-center space-x-1 text-indigo-600 hover:text-indigo-800 font-semibold"
            >
              <X className="w-3 h-3" />
              <span>Clear filters</span>
            </button>
          )}
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-2xl overflow-auto shadow-xs max-h-[70vh]">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-bold text-[11px] sticky top-0 z-10">
            <tr className="border-b border-slate-200">
              {columns.map(col => (
                <th key={col} className="px-3 py-2 whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50">
              {columns.map(col => (
                <th key={col} className="px-2 py-1.5">
                  <input
                    type="text"
                    value={filters[col] || ''}
                    onChange={e => setFilters(prev => ({ ...prev, [col]: e.target.value }))}
                    placeholder="Filter…"
                    className="w-full min-w-[90px] px-2 py-1 rounded-md bg-white border border-slate-200 text-[11px] font-normal normal-case text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pagedRows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50/80">
                {columns.map(col => (
                  <td key={col} className="px-3 py-1.5 whitespace-nowrap text-slate-700">
                    {formatCell((row as Record<string, unknown>)[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2 text-[11px] text-slate-500 font-medium">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={clampedPage <= 1}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-all"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>Prev</span>
        </button>
        <span>
          Page {clampedPage} of {pageCount}
        </span>
        <button
          onClick={() => setPage(p => Math.min(pageCount, p + 1))}
          disabled={clampedPage >= pageCount}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-all"
        >
          <span>Next</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
