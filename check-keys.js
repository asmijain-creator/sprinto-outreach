// Checks the .env settings and API keys without printing any secret values.
// Run with: node check-keys.js
const fs = require('fs');

const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const PUBLIC = ['EMAIL_TO', 'EMAIL_FROM', 'SENDER_NAME', 'SENDER_TITLE', 'REVIEW_MODE', 'GEMINI_MODEL', 'SUPABASE_URL'];
for (const [key, value] of Object.entries(env)) {
  let status;
  if (!value) status = 'BLANK';
  else if (PUBLIC.includes(key)) status = value;
  else status = `set (${value.length} chars${/["'\s]/.test(value) ? ', has quotes or spaces' : ''})`;
  console.log(key.padEnd(22), status);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(name, 'request failed:', e.name);
  }
}

(async () => {
  await check('Supabase', async () => {
    const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
    if (!url || !env.SUPABASE_SECRET_KEY) return console.log('Supabase not set up: saving to data/companies.json');
    const r = await fetch(`${url}/rest/v1/companies?select=domain`, { headers: { apikey: env.SUPABASE_SECRET_KEY } });
    const j = await r.json().catch(() => []);
    console.log('Supabase HTTP', r.status, 'companies:', Array.isArray(j) ? j.length : 'n/a');
  });

  await check('Hunter', async () => {
    const r = await fetch('https://api.hunter.io/v2/account?api_key=' + encodeURIComponent(env.HUNTER_API_KEY || ''));
    const j = await r.json().catch(() => ({}));
    const searches = j.data && j.data.requests && j.data.requests.searches;
    console.log('Hunter HTTP', r.status, 'searches:', JSON.stringify(searches || null));
  });

  await check('Gemini', async () => {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY || '' },
    });
    const j = await r.json().catch(() => ({}));
    console.log('Gemini HTTP', r.status);
    if (j.models) {
      const usable = j.models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
      console.log(usable.map((m) => m.name.replace('models/', '')).join(', '));
    }
  });

  await check('Resend', async () => {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: 'Bearer ' + (env.RESEND_API_KEY || '') },
    });
    const j = await r.json().catch(() => ({}));
    console.log('Resend HTTP', r.status, 'name:', j.name || '', 'domains:', Array.isArray(j.data) ? j.data.length : 'n/a');
  });
})();
