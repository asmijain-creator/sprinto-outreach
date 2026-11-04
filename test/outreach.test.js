const test = require('node:test');
const assert = require('node:assert');
const { isFreshHook, checkDraft } = require('../src/outreach');
const { verifiedDate, findCitation } = require('../src/research');
const { findPublishedDate } = require('../src/lib');

const today = new Date('2026-11-04');
const page = 'https://acme.com/customers';

test('hook age: dated sources must be under 12 months old', () => {
  assert.strictEqual(isFreshHook({ kind: 'search', url: page, sourceDate: '2026-03-10' }, today), true);
  assert.strictEqual(isFreshHook({ kind: 'search', url: page, sourceDate: '2025-06-01' }, today), false);
  assert.strictEqual(isFreshHook({ kind: 'page', url: page, sourceDate: '2024' }, today), false);
  assert.strictEqual(isFreshHook({ kind: 'page', url: page, sourceDate: '2027-01-01' }, today), false);
});

test('hook age: a year alone counts from its start, so it must be provably recent', () => {
  assert.strictEqual(isFreshHook({ kind: 'page', url: page, sourceDate: '2025' }, today), false);
  assert.strictEqual(isFreshHook({ kind: 'page', url: page, sourceDate: '2026' }, today), true);
});

test('hook age: undated is only fine for live pages, not searches or articles', () => {
  assert.strictEqual(isFreshHook({ kind: 'page', url: page }, today), true);
  assert.strictEqual(isFreshHook({ kind: 'search', url: page }, today), false);
  assert.strictEqual(isFreshHook({ kind: 'page', url: 'https://acme.com/blog/launch' }, today), false);
});

test('a date is only kept if its words are in the source', () => {
  const text = 'Published on March 10, 2026 by the team.';
  assert.strictEqual(verifiedDate({ source_date: '2026-03-10', source_date_quote: 'March 10, 2026' }, text), '2026-03-10');
  assert.strictEqual(verifiedDate({ source_date: '2026-03-10', source_date_quote: 'April 1, 2026' }, text), null);
  assert.strictEqual(verifiedDate({ source_date: '2026-03-10', source_date_quote: 'March 10' }, text), null);
  assert.strictEqual(verifiedDate({ source_date: 'recently', source_date_quote: 'March 10, 2026' }, text), null);
  assert.strictEqual(verifiedDate({}, text), null);
});

test('a search quote links to the source cited for its sentence, not the first one', () => {
  const supports = [
    { text: 'Acme raised a Series A in 2023.', uris: ['https://a.example/series-a'] },
    { text: 'Acme raised a **Series B** in 2026.', uris: ['https://b.example/series-b', 'https://c.example'] },
    { text: 'Acme has 30 staff.', uris: [] },
  ];
  assert.strictEqual(findCitation(supports, 'raised a Series B'), 'https://b.example/series-b');
  assert.strictEqual(findCitation(supports, 'Acme has 30 staff.'), null);
  assert.strictEqual(findCitation(supports, 'never written'), null);
  assert.strictEqual(findCitation(undefined, 'anything'), null);
});

test('a page date comes from its metadata first, then its visible text', () => {
  assert.strictEqual(findPublishedDate('<meta property="article:published_time" content="2024-05-02T10:00:00Z">', 'March 1, 2026'), '2024-05-02');
  assert.strictEqual(findPublishedDate('<meta content="2024-05-02" property="article:published_time">', ''), '2024-05-02');
  assert.strictEqual(findPublishedDate('{"datePublished": "2023-01-09"}', ''), '2023-01-09');
  assert.strictEqual(findPublishedDate('<time datetime="2025-07-04">', ''), '2025-07-04');
  assert.strictEqual(findPublishedDate('', 'By the team on Sept 3rd, 2024 in News'), '2024-09-03');
  assert.strictEqual(findPublishedDate('', 'Copyright 2026'), null);
});

const company = { poc: { firstName: 'Sam' }, answers: {} };
const evidence = [
  { url: page, usable_as_hook: true, quote: 'SOC 2 in progress', value: null },
  { url: 'https://old.example.com/post', usable_as_hook: false, quote: 'launched Enterprise', value: null },
];
const draft = (body, hook = page) => ({
  subject: 'Your SOC 2 audit',
  body: `Hi Sam,\n\n${body}`,
  hook_source_url: hook,
  pain_points: [{}, {}],
});
const issues = (body, hook, c = company) => checkDraft(draft(body, hook), c, evidence);

test('a supported draft passes', () => {
  assert.deepStrictEqual(issues('Your site says SOC 2 is in progress. It looks like enterprise buyers may be asking for it. Open to a short call?'), []);
});

test('a hook from a stale source is flagged', () => {
  assert.ok(issues('Saw the Enterprise launch. Open to a short call?', 'https://old.example.com/post').some((i) => i.includes('12 months')));
});

test('promises about results are flagged', () => {
  for (const claim of ['Sprinto helps you breeze through reviews.', 'We can get you certified in 4 weeks.', 'We make audits faster.', 'We guarantee a clean audit.']) {
    assert.ok(issues(claim).some((i) => i.includes('Promises')), claim);
  }
});

test('a guessed need is flagged unless worded as a possibility', () => {
  assert.ok(issues('Your buyers need ISO 27001.').some((i) => i.includes('guess')));
  assert.ok(issues('ISO 27001 is the next step for Acme.').some((i) => i.includes('guess')));
  assert.deepStrictEqual(issues('Your buyers may need ISO 27001.'), []);
  assert.deepStrictEqual(issues('Sprinto automates ISO 27001.'), []);
});

test('a need is allowed when the research shows the framework gap', () => {
  const gap = { ...company, answers: { frameworkGap: 'yes' } };
  const shown = [{ url: page, usable_as_hook: true, quote: 'customers ask for ISO 27001', value: 'ISO 27001' }];
  assert.deepStrictEqual(checkDraft(draft('Your buyers need ISO 27001.'), gap, shown), []);
});
