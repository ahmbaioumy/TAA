import assert from 'node:assert/strict';
import { runTrustMatrixTests, getTrustMatrixCaseCount } from './trustMatrix';

const results = runTrustMatrixTests();
const caseCount = getTrustMatrixCaseCount();

assert.equal(results.length, caseCount, 'runTrustMatrixTests() must return one result per case');

const failed = results.filter(r => !r.passed);
const passed = results.filter(r => r.passed);

if (failed.length > 0) {
  console.log('Trust Matrix failures (engine vs. independent oracle):');
  failed.forEach(r => {
    console.log(`- ${r.id} | ${r.category}`);
    console.log(`    rationale: ${r.payrollImpact}`);
    console.log(`    expected : ${r.expectedVerdict} | action: ${r.expectedAction}`);
    console.log(`    actual   : ${r.actualVerdict} | action: ${r.actualAction}`);
  });
}

console.log(`Trust Matrix: ${passed.length}/${results.length} passed (${caseCount} cases defined)`);

assert.equal(failed.length, 0, `${failed.length} trust matrix case(s) diverge from the independent oracle — see failures above`);
