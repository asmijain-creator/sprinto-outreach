// Runs the API as it runs on Vercel, against a stand-in for Supabase. Nothing here
// reaches a real service, and only actions that make no outside calls are exercised.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const rows = new Map();
const requests = [];
const database = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, apikey: req.headers.apikey, prefer: req.headers.prefer });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      const row = JSON.parse(body);
      rows.set(row.domain, row);
      res.statusCode = 201;
      return res.end();
    }
    const match = req.url.match(/domain=eq\.([^&]+)/);
    const found = match ? [rows.get(decodeURIComponent(match[1]))].filter(Boolean) : [...rows.values()];
    res.end(JSON.stringify(found));
  });
});

let app;
let base;
let lib;

test.before(async () => {
  await new Promise((r) => database.listen(0, '127.0.0.1', r));
  process.env.VERCEL = '1';
  process.env.SUPABASE_URL = `http://127.0.0.1:${database.address().port}/`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.EMAIL_TO = 'me@example.com';
  lib = require('../src/lib');
  const { route } = require('../src/app');
  const routes = { '/api/state': route('state'), '/api/action': route('action') };
  app = http.createServer((req, res) => routes[req.url](req, res));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(() => {
  app.close();
  database.close();
});

const post = (body, headers = {}) => fetch(`${base}/api/action`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
  body: JSON.stringify(body),
});

test('saving and loading uses the companies table with the secret key', async () => {
  await lib.saveCompany({ domain: 'acme.com', name: 'Acme', status: 'shortlisted' });
  const save = requests.find((r) => r.method === 'POST');
  assert.strictEqual(save.url, '/rest/v1/companies?on_conflict=domain');
  assert.strictEqual(save.apikey, 'test-secret');
  assert.match(save.prefer, /resolution=merge-duplicates/);

  assert.strictEqual((await lib.loadCompany('acme.com')).name, 'Acme');
  assert.strictEqual(await lib.loadCompany('missing.com'), undefined);
  assert.deepStrictEqual(Object.keys(await lib.loadCompanies()), ['acme.com']);
});

test('the page can read the data and run an action without logging in', async () => {
  const state = await fetch(`${base}/api/state`);
  assert.strictEqual(state.status, 200);
  assert.ok((await state.json()).companies['acme.com']);

  assert.strictEqual((await post({ action: 'decide', domain: 'acme.com', decision: 'reject' })).status, 200);
  assert.strictEqual((await lib.loadCompany('acme.com')).status, 'rejected');
});

test('other sites cannot trigger actions from a browser', async () => {
  assert.strictEqual((await post({ action: 'rejectEmail', domain: 'acme.com' }, { Origin: 'https://evil.example' })).status, 403);
});

test('unknown actions, unknown companies and wrong methods are refused', async () => {
  assert.strictEqual((await post({ action: 'constructor' })).status, 400);
  assert.strictEqual((await post({ action: 'decide', domain: 'missing.com', decision: 'reject' })).status, 500);
  assert.strictEqual((await fetch(`${base}/api/action`)).status, 405);
});
