// The review page's API: your two checkpoints. The same routes run on your computer
// and on Vercel. Each request does one short job, and the page runs longer jobs in steps.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, env, loadCompanies, loadCompany, saveCompany } = require('./lib');
const { buildShortlist } = require('./shortlist');
const { researchStep, nextQuestion } = require('./research');
const { findPoc, draftEmail, sendEmail } = require('./outreach');

const PORT = Number(env.PORT || 3000);
const HOSTED = Boolean(env.VERCEL);

const get = async (domain) => {
  const company = await loadCompany(domain);
  if (!company) throw new Error('Unknown company.');
  return company;
};

const findAndDraft = async (domain) => {
  const company = await findPoc(await get(domain));
  if (company.poc) await draftEmail(company);
};

const ACTIONS = {
  shortlist: ({ limit }) => buildShortlist(Math.min(Number(limit) || 10, 50)).then((added) => ({ added: added.length })),
  researchMore: async ({ domain }) => {
    const { progress, ...company } = await get(domain);
    await saveCompany({ ...company, status: 'researching' });
  },
  researchStep: async ({ domain }) => {
    const company = await get(domain);
    if (!['shortlisted', 'researching'].includes(company.status)) return { done: true };
    const saved = await researchStep(company);
    if (saved.status !== 'researching') return { done: true };
    return { done: false, next: nextQuestion(saved.progress.answers).q.label };
  },
  decide: async ({ domain, decision }) => {
    const company = await get(domain);
    if (decision === 'reject') return saveCompany({ ...company, decision: 'rejected', status: 'rejected' });
    await saveCompany({ ...company, decision: 'approved', status: 'approved' });
    await findAndDraft(domain);
  },
  // Finishes a qualified company whose PoC search or draft was interrupted.
  continueOutreach: async ({ domain }) => {
    const company = await get(domain);
    if (['approved', 'poc_found'].includes(company.status)) await findAndDraft(domain);
  },
  manualPoc: async ({ domain, firstName, lastName, title }) => {
    if (!firstName || !title) throw new Error('First name and title are required.');
    const poc = { firstName, lastName: lastName || '', title, email: null, source: 'Entered by you', reason: 'Chosen by you.' };
    await draftEmail(await saveCompany({ ...(await get(domain)), poc, status: 'poc_found' }));
  },
  redraft: async ({ domain, feedback }) => draftEmail(await get(domain), feedback),
  rejectEmail: async ({ domain }) => {
    const company = await get(domain);
    await saveCompany({ ...company, status: 'email_rejected', email: { ...company.email, status: 'rejected' } });
  },
  send: async ({ domain, subject, body }) => {
    if (!subject || !body) throw new Error('The email needs a subject and a body.');
    const company = await get(domain);
    await sendEmail(await saveCompany({ ...company, email: { ...company.email, subject, body, status: 'approved' } }));
  },
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Too large.'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid request.'));
      }
    });
    req.on('error', reject);
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// Only this page may trigger actions, not other sites open in your browser.
function sameOrigin(req) {
  let origin;
  try {
    origin = new URL(req.headers.origin).host;
  } catch {
    return false;
  }
  if (HOSTED) return origin === (req.headers['x-forwarded-host'] || req.headers.host);
  return origin === `localhost:${PORT}` || origin === `127.0.0.1:${PORT}`;
}

const handlers = {
  state: async (req, res) => {
    const companies = await loadCompanies();
    json(res, 200, { companies, emailTo: env.EMAIL_TO, reviewMode: env.REVIEW_MODE !== 'false' });
  },
  action: async (req, res) => {
    const { action, ...args } = await readBody(req);
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return json(res, 400, { error: 'Unknown action.' });
    const result = await ACTIONS[action](args);
    json(res, 200, { ok: true, ...(action === 'researchStep' || action === 'shortlist' ? result : {}) });
  },
};

const METHODS = { state: 'GET', action: 'POST' };

// One Vercel function per route, or one route on the local server.
const route = (name) => async (req, res) => {
  try {
    if (req.method !== METHODS[name]) return json(res, 405, { error: 'Not allowed.' });
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Not allowed.' });
    await handlers[name](req, res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
};

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
  }
  const name = pathname.replace(/^\/api\//, '');
  if (pathname.startsWith('/api/') && Object.prototype.hasOwnProperty.call(handlers, name)) return route(name)(req, res);
  json(res, 404, { error: 'Not found.' });
});

function start() {
  server.listen(PORT, '127.0.0.1', () => console.log(`Review page: http://localhost:${PORT}`));
}

module.exports = { start, route, server };
