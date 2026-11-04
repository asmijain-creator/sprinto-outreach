const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('../src/verdict');

const fit = { saas: 'b2b_saas', employees: 80, certified: 'not_certified', funding: 'series_a_c' };

test('waits for the next question until an answer ends it', () => {
  assert.strictEqual(decide({}), null);
  assert.strictEqual(decide({ saas: 'b2b_saas' }), null);
  assert.strictEqual(decide(fit), null);
  assert.strictEqual(decide({ ...fit, preparing: 'no' }), null);
});

test('short-circuit rejects stop on the first failing answer', () => {
  assert.strictEqual(decide({ saas: 'not_b2b_saas' }).code, 'not_saas');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 10 }).code, 'too_small');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 500 }).code, 'too_large');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 80, certified: 'holds_needed' }).code, 'already_certified');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 80, certified: 'uses_competitor' }).code, 'uses_competitor');
  assert.strictEqual(decide({ ...fit, funding: 'too_early' }).code, 'too_early');
  assert.strictEqual(decide({ ...fit, funding: 'too_late' }).code, 'too_late');
});

test('unknown on a gate or the disqualifier rejects as insufficient evidence', () => {
  assert.strictEqual(decide({ saas: 'unknown' }).code, 'insufficient_evidence');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 'unknown' }).code, 'insufficient_evidence');
  assert.strictEqual(decide({ saas: 'b2b_saas', employees: 80, certified: 'unknown' }).code, 'insufficient_evidence');
});

test('unknown funding continues with a flag', () => {
  const d = decide({ ...fit, funding: 'unknown', preparing: 'yes' });
  assert.strictEqual(d.verdict, 'qualify');
  assert.ok(d.flags.some((f) => f.includes('Funding')));
});

test('borderline headcount continues with a flag', () => {
  const d = decide({ ...fit, employees: 320, preparing: 'yes' });
  assert.strictEqual(d.verdict, 'qualify');
  assert.ok(d.flags.some((f) => f.includes('borderline')));
});

test('either trigger qualifies; one yes is enough', () => {
  assert.strictEqual(decide({ ...fit, preparing: 'yes' }).code, 'preparing_for_audit');
  assert.strictEqual(decide({ ...fit, preparing: 'no', clients: 'yes' }).code, 'enterprise_pressure');
  assert.strictEqual(decide({ ...fit, preparing: 'unknown', clients: 'yes' }).code, 'enterprise_pressure');
});

test('a company missing a framework qualifies only with evidence of the need', () => {
  const gap = { ...fit, certified: 'missing_framework' };
  assert.strictEqual(decide(gap), null);
  assert.strictEqual(decide({ ...gap, frameworkGap: 'unknown', clients: 'yes' }).code, 'already_certified');
  assert.strictEqual(decide({ ...gap, frameworkGap: 'yes', preparing: 'yes' }).verdict, 'qualify');
});

test('no trigger rejects, including when both are unknown', () => {
  assert.strictEqual(decide({ ...fit, preparing: 'no', clients: 'no' }).code, 'no_trigger');
  assert.strictEqual(decide({ ...fit, preparing: 'unknown', clients: 'unknown' }).code, 'no_trigger');
});
