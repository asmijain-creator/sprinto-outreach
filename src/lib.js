// Shared helpers: settings, company store, Gemini and page fetching.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'companies.json');

// On your computer settings come from .env. On Vercel they come from the project settings.
function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  Object.assign(env, process.env);
  env.GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-3.8-flash';
  return env;
}
const env = loadEnv();

// Companies are saved in Supabase once its settings are filled in, otherwise in
// data/companies.json. Vercel can't keep files, so there Supabase is required.
const useSupabase = () => Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);

async function supabase(query, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/companies${query}`, {
    ...options,
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function loadFile() {
  if (env.VERCEL) throw new Error('Supabase is not set up. Add SUPABASE_URL and SUPABASE_SECRET_KEY in Vercel.');
  if (!fs.existsSync(STORE)) return {};
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

async function loadCompanies() {
  if (!useSupabase()) return loadFile();
  const rows = await supabase('?select=domain,data&order=domain');
  return Object.fromEntries(rows.map((r) => [r.domain, r.data]));
}

async function loadCompany(domain) {
  if (!useSupabase()) return loadFile()[domain];
  const rows = await supabase(`?select=data&domain=eq.${encodeURIComponent(domain)}`);
  return rows.length ? rows[0].data : undefined;
}

async function saveCompany(company) {
  const saved = { ...company, updatedAt: new Date().toISOString() };
  if (useSupabase()) {
    await supabase('?on_conflict=domain', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ domain: saved.domain, data: saved, updated_at: saved.updatedAt }),
    });
    return saved;
  }
  const all = loadFile();
  all[saved.domain] = saved;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = `${STORE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  replaceFile(tmp, STORE);
  return saved;
}

// On Windows the rename fails briefly while another process is reading the
// file, such as the open review page, so retry for a few seconds.
function replaceFile(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt === 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raised when Gemini is out of quota, so a run stops instead of recording
// a false "insufficient evidence" against the company.
class GeminiError extends Error {}

// Raised when Gemini refuses or garbles one piece of content. Only that source
// is lost, so research moves on to the next one.
class GeminiUnusable extends GeminiError {}

let lastCall = 0;
async function gemini({ prompt, schema, search = false }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  if (search) body.tools = [{ google_search: {} }];
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const gap = Number(env.GEMINI_MIN_GAP_MS || 1000) - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      if (attempt === 6) throw new GeminiError(`Gemini unreachable: ${e.name}`);
      await sleep(attempt * 5000);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const data = await res.json().catch(() => ({}));
      const retry = (data.error && data.error.details || []).find((d) => d.retryDelay);
      const wait = retry ? parseFloat(retry.retryDelay) * 1000 + 1000 : attempt * 10000;
      if (attempt === 6 || wait > 120000) throw new GeminiError(`Gemini ${res.status}: ${data.error ? data.error.message : 'no details'}`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GeminiError(`Gemini ${res.status}: ${data.error ? data.error.message : 'no details'}`);
    }

    const data = await res.json();
    if (!(data.candidates || []).length) {
      const reason = data.promptFeedback ? data.promptFeedback.blockReason || JSON.stringify(data.promptFeedback) : 'no reason given';
      throw new GeminiUnusable(`Gemini returned nothing (${reason})`);
    }
    const candidate = data.candidates[0];
    const text = ((candidate.content && candidate.content.parts) || []).map((p) => p.text || '').join('');
    const grounding = candidate.groundingMetadata || {};
    const web = (grounding.groundingChunks || []).map((c) => c.web);
    const chunks = web.filter(Boolean);
    // Which source Gemini cited for each sentence it wrote.
    const supports = (grounding.groundingSupports || []).map((s) => ({
      text: (s.segment && s.segment.text) || '',
      uris: (s.groundingChunkIndices || []).map((i) => web[i] && web[i].uri).filter(Boolean),
    }));
    if (!schema) return { text, chunks, supports };
    try {
      return { json: JSON.parse(text), chunks, supports };
    } catch {
      if (attempt === 6) throw new GeminiUnusable(`Gemini returned invalid JSON repeatedly (finish reason ${candidate.finishReason}, ${text.length} chars, ending: ${text.slice(-120)})`);
    }
  }
  throw new GeminiError('Gemini failed.');
}

const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function normalizeDomain(input) {
  const d = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return DOMAIN_RE.test(d) ? d : null;
}

function isPublicHttpUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && DOMAIN_RE.test(u.hostname) && !u.hostname.endsWith('.localhost') && !u.hostname.endsWith('.test');
  } catch {
    return false;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-' };

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z0-9#]+);/gi, (m, e) => (ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)/gi)) {
    try {
      links.add(new URL(m[1], baseUrl).href);
    } catch {}
  }
  return [...links];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The page's publish date: its metadata if it has any, otherwise the first full
// date in its text, which on an article is normally the byline.
function findPublishedDate(html, text) {
  const meta = html.match(/article:published_time["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i)
    || html.match(/content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]*article:published_time/i)
    || html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/)
    || html.match(/<time[^>]*\bdatetime=["'](\d{4}-\d{2}-\d{2})/i);
  if (meta) return meta[1];
  const visible = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/i);
  if (!visible) return null;
  return new Date(Date.UTC(Number(visible[3]), MONTHS.indexOf(visible[1].toLowerCase()), Number(visible[2]))).toISOString().slice(0, 10);
}

// status: ok | missing (no such page) | failed (blocked, timed out, or too little
// text, which is usually a JavaScript-only page). Only "failed" leaves the answer unknown.
async function fetchPage(url) {
  if (!isPublicHttpUrl(url)) return { status: 'failed', url, reason: 'invalid address' };
  let reason = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', Accept: 'text/html' },
      });
      if (res.status === 404 || res.status === 410) return { status: 'missing', url };
      if (res.status === 401 || res.status === 403) return { status: 'failed', url, reason: `blocked (${res.status})` };
      if (!res.ok) {
        reason = `HTTP ${res.status}`;
        continue;
      }
      const html = await res.text();
      const text = htmlToText(html);
      if (text.length < 200) return { status: 'failed', url: res.url, reason: 'too little text' };
      return { status: 'ok', url: res.url, text: text.slice(0, 30000), links: extractLinks(html, res.url), publishedAt: findPublishedDate(html, text) };
    } catch (e) {
      reason = e.name;
    }
  }
  return { status: 'failed', url, reason };
}

module.exports = { ROOT, env, loadCompanies, loadCompany, saveCompany, gemini, GeminiError, GeminiUnusable, fetchPage, findPublishedDate, normalizeDomain, isPublicHttpUrl, sleep };
