// Commands:
//   node run.js review                  Open the review page (the normal way to use this)
//   node run.js shortlist 10            Find companies from free sources
//   node run.js add a.com b.io          Add your own domains
//   node run.js research                Research everything shortlisted
//   node run.js auto [a.com b.io]       Run end to end with no reviews (needs REVIEW_MODE=false)
const { env, loadCompanies, loadCompany, saveCompany } = require('./src/lib');
const { buildShortlist, addDomains } = require('./src/shortlist');
const { researchCompany } = require('./src/research');
const { findPoc, draftEmail, sendEmail } = require('./src/outreach');
const { start } = require('./src/app');
const { startThread } = require('./src/agent');

const log = (msg) => console.log(msg);
const WAITING = ['shortlisted', 'researching'];

async function researchShortlisted() {
  const waiting = Object.values(await loadCompanies()).filter((c) => WAITING.includes(c.status));
  for (const c of waiting) {
    const done = await researchCompany(c, log);
    log(`=> ${c.domain}: ${done.recommendation.verdict} (${done.recommendation.code}), ${done.tries} tries`);
  }
}

async function auto(domains) {
  if (env.REVIEW_MODE !== 'false') throw new Error('Reviews are on. Set REVIEW_MODE=false in .env to use auto.');
  // With no domains given, auto finds its own. Only this run's companies are touched.
  // Companies left waiting by an interrupted run are picked up too.
  const leftover = domains.length ? [] : Object.values(await loadCompanies()).filter((c) => WAITING.includes(c.status));
  const batch = domains.length ? await addDomains(domains) : leftover.length ? [] : await buildShortlist(10, log);
  const targets = [...new Set([...batch, ...leftover].map((c) => c.domain))];
  for (const domain of targets) {
    const done = await researchCompany(await loadCompany(domain), log);
    log(`=> ${domain}: ${done.recommendation.verdict} (${done.recommendation.code}), ${done.tries} tries`);
  }
  for (const domain of targets) {
    const c = await loadCompany(domain);
    if (c.recommendation.verdict !== 'qualify') {
      await saveCompany({ ...c, decision: 'rejected', status: 'rejected' });
      continue;
    }
    try {
      let company = await findPoc(await saveCompany({ ...c, decision: 'approved', status: 'approved' }));
      if (!company.poc) {
        log(`=> ${c.domain}: no PoC found`);
        continue;
      }
      company = await draftEmail(company);
      if (company.email.issues.length) {
        log(`=> ${c.domain}: draft failed its checks, not sent: ${company.email.issues.join(' ')}`);
        continue;
      }
      await saveCompany(startThread(await sendEmail(company)));
      log(`=> ${c.domain}: sent to ${env.EMAIL_TO}`);
    } catch (e) {
      log(`=> ${c.domain}: outreach failed: ${e.message}`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  review: async () => start(),
  shortlist: async () => log((await buildShortlist(Number(args[0]) || 10, log)).map((c) => `${c.domain} (${c.source})`).join('\n')),
  add: async () => log((await addDomains(args)).map((c) => c.domain).join('\n')),
  research: researchShortlisted,
  auto: () => auto(args),
};

if (!Object.prototype.hasOwnProperty.call(commands, command)) {
  console.log('Use one of: review, shortlist, add, research, auto');
  process.exit(1);
}
commands[command]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
