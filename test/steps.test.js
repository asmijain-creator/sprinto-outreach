const test = require('node:test');
const assert = require('node:assert');
const { nextQuestion } = require('../src/research');

const fit = { saas: 'b2b_saas', employees: 80, certified: 'not_certified', funding: 'series_a_c' };

test('questions come one at a time, in the short-circuit order', () => {
  assert.strictEqual(nextQuestion({}).key, 'saas');
  assert.strictEqual(nextQuestion({ saas: 'b2b_saas' }).key, 'employees');
  assert.strictEqual(nextQuestion(fit).key, 'preparing');
});

test('the framework question is only asked when one is missing', () => {
  assert.strictEqual(nextQuestion({ saas: 'b2b_saas', employees: 80 }).key, 'certified');
  assert.strictEqual(nextQuestion({ ...fit, certified: 'missing_framework', funding: undefined }).key, 'frameworkGap');
  assert.strictEqual(nextQuestion(fit).key, 'preparing');
});

test('a reject ends the assessment immediately', () => {
  assert.strictEqual(nextQuestion({ saas: 'not_b2b_saas' }), null);
  assert.strictEqual(nextQuestion({ saas: 'b2b_saas', employees: 5 }), null);
});

test('a qualified company then answers clients and the supporting signals', () => {
  const qualified = { ...fit, preparing: 'yes' };
  assert.strictEqual(nextQuestion(qualified).key, 'clients');
  assert.strictEqual(nextQuestion({ ...qualified, clients: 'no' }).key, 'clientCount');
  assert.strictEqual(nextQuestion({ ...qualified, clients: 'no', clientCount: 'unknown', industry: 'unknown', cloud: 'unknown' }), null);
});
