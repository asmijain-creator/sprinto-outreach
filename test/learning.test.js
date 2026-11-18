const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SECRET_KEY = 'test-only';
const { editSignal, rankLearnings, learningsPrompt } = require('../src/learning');
const { checkDraft } = require('../src/outreach');

test('signal: only a real edit counts, not spacing', () => {
  const draft = { subject: 'Hi', body: 'Hi Sam,\n\nShort note.' };
  assert.strictEqual(editSignal(draft, { subject: 'Hi', body: 'Hi Sam,  \n\nShort note.' }).changed, false);
  assert.deepStrictEqual(editSignal(draft, { subject: 'Hello', body: draft.body }), { changed: true, subjectChanged: true, bodyChanged: false });
  assert.strictEqual(editSignal(undefined, draft).changed, false);
});

test('retrieve: same trigger first, then same industry, then most recent, never the same company', () => {
  const company = { domain: 'acme.com', recommendation: { code: 'enterprise_pressure' }, answers: { industry: 'regulated' } };
  const rows = [
    { id: 1, domain: 'a.com', trigger_code: 'preparing_for_audit', industry: 'not_regulated' },
    { id: 2, domain: 'b.com', trigger_code: 'preparing_for_audit', industry: 'regulated' },
    { id: 3, domain: 'acme.com', trigger_code: 'enterprise_pressure', industry: 'regulated' },
    { id: 4, domain: 'c.com', trigger_code: 'enterprise_pressure', industry: 'not_regulated' },
    { id: 5, domain: 'd.com', trigger_code: 'enterprise_pressure', industry: 'regulated' },
  ];
  assert.deepStrictEqual(rankLearnings(rows, company).map((r) => r.id), [5, 4, 2]);
});

test('apply: lessons go into the prompt with what changed', () => {
  assert.strictEqual(learningsPrompt([]), '');
  const text = learningsPrompt([{ lesson: 'Open with their own launch.', changes: { hook: { changed: true, note: 'Used the launch' }, angle: { changed: false, note: '' }, cta: { changed: true, note: 'Softer ask' } } }]);
  assert.match(text, /Open with their own launch\. \(hook: Used the launch; cta: Softer ask\)/);
});

test('Sequence 1: the cold email may not name a day or time', () => {
  const company = { poc: { firstName: 'Sam' }, answers: {} };
  const evidence = [{ url: 'https://acme.com/', usable_as_hook: true, quote: 'SOC 2 in progress', value: null }];
  const draft = (body) => ({ subject: 'Hi', body: `Hi Sam,\n\n${body}`, hook_source_url: 'https://acme.com/', pain_points: [{}, {}] });
  assert.ok(checkDraft(draft('Free for a call on Tuesday?'), company, evidence).some((i) => /day or time/.test(i)));
  assert.ok(checkDraft(draft('Could we talk at 3pm?'), company, evidence).some((i) => /day or time/.test(i)));
  assert.deepStrictEqual(checkDraft(draft('Your site says SOC 2 is in progress. Open to a short call?'), company, evidence), []);
});
