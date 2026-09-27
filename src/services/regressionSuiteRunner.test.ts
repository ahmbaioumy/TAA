import assert from 'node:assert/strict';
import { runAllRegressionTests } from './regressionSuite';

// Headless runner for regressionSuite.ts, mirroring trustMatrixRunner.test.ts.
// Before this file existed, the 77 regression cases (reg-1..reg-77) only ever
// executed inside the browser's Regression Suite tab — `npm run test` never
// touched them, even though App.tsx gates Calculate on them passing. This
// closes that CI gap.
const results = runAllRegressionTests();

const failed = results.filter(r => !r.passed);
const passed = results.filter(r => r.passed);

if (failed.length > 0) {
  console.log('Regression Suite failures (engine vs. hand-derived expected verdict):');
  failed.forEach(r => {
    console.log(`- ${r.id} | ${r.name}`);
    console.log(`    expected : ${r.expectedVerdict} | action: ${r.expectedAction}`);
    console.log(`    actual   : ${r.actualVerdict} | action: ${r.actualAction}`);
  });
}

console.log(`Regression Suite: ${passed.length}/${results.length} passed (${results.length} cases defined)`);

assert.equal(failed.length, 0, `${failed.length} regression case(s) failed — see failures above`);
