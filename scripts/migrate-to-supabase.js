// Copies data/companies.json into Supabase once. Safe to run again: it overwrites
// matching companies with your local copy and deletes nothing.
// Run with: node scripts/migrate-to-supabase.js
const fs = require('fs');
const path = require('path');
const { ROOT, env, loadCompanies, saveCompany } = require('../src/lib');

(async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.');
  const companies = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'companies.json'), 'utf8')));
  for (const company of companies) await saveCompany(company);
  const stored = await loadCompanies();
  console.log(`Copied ${companies.length} companies. Supabase now holds ${Object.keys(stored).length}.`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
