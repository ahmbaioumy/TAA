/** Investigation only: independent boundary checks and reproducible defect probes.
 * Run from TAA_HTML: node node_modules/tsx/dist/cli.mjs scripts/audit-payroll-math.ts
 * Does not change app code, source inputs, configuration, or payroll data.
 */
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/services/configRegistry';
import { runReconciliation } from '../src/services/reconciliationEngine';
import { runAllRegressionTests } from '../src/services/regressionSuite';
import { parseDateTimeString, formatDateDDMMYYYY, formatTimeHHMM, formatMinutesToHHMM, parseAspectSegments } from '../src/services/parsers';
import type { AspectSegment, CMSPunch, CognosRecord, ConfigRegistry } from '../src/types/taa';

const dt = (s: string) => { const d = parseDateTimeString(s); assert.ok(d, s); return d; };
const day = '08/09/2026';
const config = (): ConfigRegistry => structuredClone(DEFAULT_CONFIG);
const segment = (code: string, start: string, end: string, nom = day, emp = 'AUDIT') : AspectSegment => ({
  EMP_ID: emp, EMP_LAST_NAME: 'Synthetic Audit Staff', NOM_DATE: nom, START_DATE: formatDateDDMMYYYY(dt(start)),
  SEG_CODE: code, START_MOMENT: start, STOP_MOMENT: end,
  DURATION: Math.round((dt(end).getTime() - dt(start).getTime()) / 60000),
});
const shift = (nom = day) => segment('SHIFT', `${nom} 09:00`, `${nom} 17:00`, nom);
const punch = (instant: string, login = 'AUDIT_LOGIN'): CMSPunch => ({Date: formatDateDDMMYYYY(dt(instant)), LoginID: login, LoginDateTime: dt(instant), LogoutDateTime: dt(instant)});
const cognos = (nom = day, extra: Partial<CognosRecord> = {}): CognosRecord => ({
  'SIGN IN DATE': nom, SECTION: 'AUDIT', 'PF NO': 'AUDIT', NAME: 'Synthetic Audit Staff', 'LOGIN ID': 'AUDIT_LOGIN',
  DUTY1: '', OT1: '', 'DUTY-2': '', 'OT-2': '', 'SCH DURATION': '', 'SIGNIN DURATION': '',
  'SIGIN IN': '', 'SIGIN OUT': '', 'LATE START': '', 'LEFT EARLY': '', 'LEAVE TYPE': '', 'LEAVE HR': '', REMARK: '', ...extra,
});
function run(segments: AspectSegment[], punches: CMSPunch[], cfg = config(), role = 'CSR', records = [cognos()]) {
  return runReconciliation({ processingDate: new Date(),cognosRecords: records, aspectSegments: segments,
    aspectIdentities: [{EMP_ID: 'AUDIT', EMP_LAST_NAME: 'Synthetic Audit Staff', EMP_SORT_NAME: `Synthetic Audit Staff ${role}`}], cmsPunches: punches, config: cfg});
}
function summary(out: ReturnType<typeof run>) {
  return out.rows.map(r => ({id:r.id, verdict:r.TAA_VERDICT, action:r.TAA_ACTION, included:r.includeInOutput, hold:r.holdReason,
    late:r.TAA_LATE_MIN, early:r.TAA_EARLY_MIN, net:r.TAA_SCH_HOURS_RECOMPUTED, start:r.TAA_EFFECTIVE_START, end:r.TAA_EFFECTIVE_END,
    charged:r.details.chargedVarianceMinutes, measurements:r.details.varianceTrace?.measurements,
    corrections:r.details.generatedCorrections, comparisons:r.columnComparisons}));
}
const evidence: {id:string, expected:string, observed:unknown}[] = [];
function record(id:string, expected:string, observed:unknown) { evidence.push({id,expected,observed}); }

// Expectations deliberately authored independently of the configured rule table.
let boundaryChecks = 0;
for (const tier of ['CSR','OFFICER']) {
  for (const event of ['late','early','lateout']) {
    for (let minutes=0;minutes<=121;minutes++) {
      const start = dt(`${day} 09:00`), end = dt(`${day} 17:00`);
      if(event==='late') start.setMinutes(start.getMinutes()+minutes);
      if(event==='early') end.setMinutes(end.getMinutes()-minutes);
      if(event==='lateout') end.setMinutes(end.getMinutes()+minutes);
      // Coverage punch: unrelated login, timestamped past the schedule's own end (17:00) plus
      // the default cmsPunchSearchWindowHours grace (5h -> 22:00), so the CMS export's own
      // extent genuinely covers this shift (punchAttribution.ts coverageSufficientByWindowKey)
      // and the row is judged on the boundary condition itself, not held on
      // INSUFFICIENT_CMS_COVERAGE / MANUAL_REVIEW_REQUIRED.
      const p = [punch(`${day} ${formatTimeHHMM(start)}`),punch(`${day} ${formatTimeHHMM(end)}`),punch(`${day} 22:05`,'COVERAGE_ONLY')];
      const row=run([shift()],p,config(),tier).rows[0];
      const lower=tier==='CSR'?6:11, earlyLower=tier==='CSR'?5:6, earlyAbsent=tier==='CSR'?10:21;
      const expected=event==='late'?(minutes>=61?'ABSENT_SEGMENT':minutes>=lower?'LATE_AND_COVER':'NO_ACTION'):
        event==='early'?(minutes>=earlyAbsent?'ABSENT_SEGMENT':minutes>=earlyLower?'LOGOFF_AND_COVER':'NO_ACTION'):
        minutes>=60?'ABSENT_SEGMENT':'NO_ACTION';
      assert.equal(row.TAA_ACTION,expected,`${tier} ${event} ${minutes}`);
      if(expected==='LATE_AND_COVER'||expected==='LOGOFF_AND_COVER') {
        assert.equal(row.details.generatedCorrections.find(c=>c.SegmentCode==='COVER')?.Segmentduration,formatMinutesToHHMM(minutes));
      }
      boundaryChecks++;
    }
  }
}
record('BOUNDARIES', 'All 732 whole-minute standard-rule cases and full cover durations match independent policy expectations.', {passed:boundaryChecks});

// Reproducible probes record actual behavior; they do not make a bug count look like a passing test suite.
const tomorrow='09/09/2026';
const existing=segment('COVER',`${tomorrow} 17:00`,`${tomorrow} 17:12`,tomorrow);
record('F01_EXISTING_COVER', 'New 6-minute cover starts 17:12 after the existing cover.', summary(run([shift(),shift(tomorrow),existing],[punch(`${day} 09:06`),punch(`${day} 17:00`)])));

record('F02_SPLIT_SHIFT', 'The 16:00 second block must detect the 18:00 arrival or be held as unsupported.', summary(run([
  segment('SHIFT',`${day} 09:00`,`${day} 12:00`),segment('SHIFT',`${day} 16:00`,`${day} 19:00`)],
  ['09:00','12:00','18:00','19:00'].map(t=>punch(`${day} ${t}`)))));

record('F03_MISSING_AGENT', 'An export containing only another Login ID cannot prove this employee was absent.', summary(run([shift()],[punch(`${day} 09:00`,'OTHER'),punch(`${day} 17:00`,'OTHER')])));

const rls=segment('RLS',`${day} 16:00`,`${day} 17:00`);
const nursing=segment('NURSNG',`${day} 16:00`,`${day} 17:00`);
record('F04_OVERLAP_TRAILING','Two removals of the same physical hour should remove 60 minutes once, or require review; 420 minutes remain.',summary(run([shift(),rls,nursing],[punch(`${day} 09:00`),punch(`${day} 16:00`)])));
record('F04_OVERLAP_LEADING','The same leading hour removed twice must not move required arrival from 10:00 to 11:00.',summary(run([shift(),segment('RLS',`${day} 09:00`,`${day} 10:00`),segment('NURSNG',`${day} 09:00`,`${day} 10:00`)],[punch(`${day} 11:00`),punch(`${day} 17:00`)])));

const flexShift=segment('SHIFT',`${day} 07:00`,`${day} 15:00`);
record('V01_FLEX_OT_DURATION','Regression guard: flex shift update must identify the original 8-hour SHIFT, not replace a fabricated 10-hour SHIFT while keeping the 2-hour OT.',summary(run([flexShift,segment('OT1',`${day} 15:00`,`${day} 17:00`)],[punch(`${day} 08:00`),punch(`${day} 18:00`)],config(),'OFFICER FLEX')));
record('F06_FLEX_AUDIT','Flex arrival 08:00 moves end to 16:00; logout 15:54 is 6 minutes early, and the audit must display the same anchor/minutes.',summary(run([flexShift],[punch(`${day} 08:00`),punch(`${day} 15:54`)],config(),'OFFICER FLEX')));

const secondsCover=segment('COVER',`${day} 17:00:59`,`${day} 17:05:59`);
record('F07_COVER_SECONDS','Under the documented minute-only contract, cover 17:00-17:05 with logout 17:01 has a 4-minute shortfall, below the OPS band.',summary(run([shift(),secondsCover],[punch(`${day} 09:00`),punch(`${day} 17:01:02`)])));
const secondsRls=segment('RLS',`${day} 17:30:59`,`${day} 18:00`); secondsRls.DURATION=30;
record('F07_OT_SECONDS','Under minute-only arithmetic, 60-minute OT minus release 17:30-18:00 leaves 30 minutes.',summary(run([shift(),segment('OT1',`${day} 17:00`,`${day} 18:00`),secondsRls],[punch(`${day} 09:00`),punch(`${day} 17:30`)])));

record('F08_FLEX_COVER_SKIP','Flex rows must still run Cover Not Attended: 10 scheduled cover minutes with zero attended minutes should not be exported as PRESENT.',summary(run([
  flexShift,
  segment('COVER',`${day} 15:00`,`${day} 15:10`),
],[punch(`${day} 07:00`),punch(`${day} 15:00`)],config(),'OFFICER FLEX')));

record('F14_FLEX_OT_RLS_SKIP','Flex rows must still adjust OT when a release overlaps OT: OT1 15:00-17:00 with RLS 16:30-17:00 should emit an adjusted 90-minute OT pair.',summary(run([
  flexShift,
  segment('OT1',`${day} 15:00`,`${day} 17:00`),
  segment('RLS',`${day} 16:30`,`${day} 17:00`),
],[punch(`${day} 07:00`),punch(`${day} 17:00`)],config(),'OFFICER FLEX')));

const noLoginCfg=config();
noLoginCfg.policyRules=noLoginCfg.policyRules.map(r=>r.segmentType==='No Login Record'?{...r,action:'NO_ACTION'}:r);
record('F09_CONFIG_ACTION','Setting No Login Record to NO_ACTION must not emit an absence.',summary(run([shift()],[],noLoginCfg)));
// R7 fix: this probe's own filter previously used 'RLS added to OT with no adjustment',
// which does not match the Config Registry's actual segmentType string
// ('RLS segment added to OT with no adjustment', configRegistry.ts) — the filter was a
// no-op and this evidence ID kept showing the pre-fix output even after the underlying
// F09 fix landed. Corrected to the real key so this probe actually exercises the fix.
const noOtCfg=config(); noOtCfg.policyRules=noOtCfg.policyRules.map(r=>r.segmentType==='RLS segment added to OT with no adjustment'?{...r,action:'NO_ACTION'}:r);
record('F09_CONFIG_OT','Disabling the OT/RLS action must suppress its correction pair.',summary(run([shift(),segment('OT1',`${day} 17:00`,`${day} 18:00`),segment('RLS',`${day} 17:30`,`${day} 18:00`)],[punch(`${day} 09:00`),punch(`${day} 17:30`)],noOtCfg)));

record('F10_FUTURE_INTEGRITY','A future target with a 1-minute DURATION/STOP disagreement must not be used to generate exportable cover.',summary(run([shift(),{...shift(tomorrow),DURATION:479}],[punch(`${day} 09:06`),punch(`${day} 17:00`)])));
record('F11_DUPLICATE_SHIFT','Duplicating an identical source SHIFT must be idempotent or held; cannot silently double 480 to 960 minutes.',summary(run([shift(),shift()],[punch(`${day} 09:00`),punch(`${day} 17:00`)])));

record('P01_ONE_MINUTE_TOLERANCE','Quantify the configured one-minute comparison tolerance separately from rule arithmetic.',summary(run([shift()],[punch(`${day} 09:06`),punch(`${day} 17:00`)],config(),'CSR',[cognos(day,{'SIGIN IN':'09:05','SIGIN OUT':'17:00','LATE START':'-5','SCH DURATION':'08:01'})])));
record('F12_EXPLICIT_LEAVE_DURATION','An ANNUAL segment carrying explicit 60-minute duration should be checked against LEAVE HR=480, not suppressed by code name.',summary(run([{EMP_ID:'AUDIT',EMP_LAST_NAME:'Synthetic Audit Staff',NOM_DATE:day,START_DATE:day,SEG_CODE:'ANNUAL',DURATION:60}],[],config(),'CSR',[cognos(day,{'LEAVE TYPE':'ANNUAL','LEAVE HR':'480'})])));

const basicCsv='EMP_ID,EMP_LAST_NAME,NOM_DATE,START_DATE,SEG_CODE,START_MOMENT,STOP_MOMENT,DURATION\nAUDIT,Synthetic Audit Staff,08/09/2026,08/09/2026,SHIFT,08/09/2026 09:00,08/09/2026 17:00,';
record('F13_DURATION_PARSER','Invalid/fractional duration text must be rejected explicitly, not silently truncated or treated as a missing field.', ['480.9','480garbage','not-a-number'].map(raw=>({raw,parsed:parseAspectSegments(basicCsv+raw)[0].DURATION,result:summary(run(parseAspectSegments(basicCsv+raw),[punch(`${day} 09:00`),punch(`${day} 17:00`)]))})));

const regressions=runAllRegressionTests();
record('EXISTING_REGRESSION_SUITE','All embedded regression cases should pass.',{passed:regressions.filter(r=>r.passed).length,total:regressions.length,failures:regressions.filter(r=>!r.passed)});

// REAL_SAMPLE_SCOPE (reading real samples_Files/ data) previously lived here.
// It is superseded by scripts/replay-real.ts (WP8 track A3), which replays the
// full real dataset through the documented upload path with hard assertions
// (709 rows, 38,308 punches) and a committed baseline — a stronger, dedicated
// proof than this script's ad-hoc scope probe. Removed here rather than
// repointed at the current filenames, to avoid two divergent real-data proofs.
// Run: npm run test:replay-real -- --date=DD/MM/YYYY --out=<dir>

const docPath = existsSync('doc') ? 'doc/PAYROLL_MATH_AUDIT_EVIDENCE.json' : '../doc/PAYROLL_MATH_AUDIT_EVIDENCE.json';
writeFileSync(docPath,JSON.stringify({auditDate:'2026-09-09',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,boundaryChecks,evidence},null,2));
console.log(`Independent standard boundary checks: ${boundaryChecks}/${boundaryChecks} passed.`);
console.log(`Embedded regressions: ${regressions.filter(r=>r.passed).length}/${regressions.length} passed.`);
for(const e of evidence) console.log(`${e.id}: ${JSON.stringify(e.observed).slice(0,520)}`);
console.log('Full synthetic evidence saved to doc/PAYROLL_MATH_AUDIT_EVIDENCE.json.');
