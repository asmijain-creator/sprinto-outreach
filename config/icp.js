// Sprinto's ICP: every qualifier, its source list and its "sufficient when" rule.
// Change the rules here. The order of REQUIRED is the short-circuit order.

const page = (path, match) => ({ type: 'page', path, match });
const search = (...queries) => ({ type: 'search', queries });

const HOME = page('/', null);
const PRICING = page('/pricing', /pricing|plans/i);
const SECURITY = page('/security', /security/i);
const TRUST = page('/trust', /trust/i);
const CAREERS = page('/careers', /careers|jobs|join-us|work-with-us/i);
const CUSTOMERS = page('/customers', /customers|case-stud|success-stor/i);
const ABOUT = page('/about', /about/i);

const EMPLOYEES = {
  rejectBelow: 15,
  rejectAbove: 350,
  targetMin: 20,
  targetMax: 300,
};

const REQUIRED = {
  saas: {
    label: 'SaaS',
    ask: 'Is this company a B2B software-as-a-service business?',
    answers: ['b2b_saas', 'not_b2b_saas'],
    sufficientWhen: 'The content shows what the product does and who it is sold to. Consumer products, agencies, services firms and marketplaces are not_b2b_saas.',
    sources: [HOME, PRICING, page('/product', /product|platform/i), ABOUT, search('{name} {domain} what does the company do')],
  },
  employees: {
    label: 'Employee count',
    ask: 'How many employees does this company have? Put the number in employee_count, using the midpoint for a range.',
    answers: ['known'],
    sufficientWhen: 'One source states a number or range, ideally from the last 12 months.',
    sources: [
      search('{name} {domain} number of employees company size', '{name} LinkedIn company size employees'),
      ABOUT,
      CAREERS,
      search('{name} Crunchbase employee count'),
    ],
  },
  certified: {
    label: 'Already certified',
    ask: 'What compliance certifications does this company hold, and does it use a compliance automation vendor?',
    answers: ['holds_needed', 'missing_framework', 'uses_competitor', 'not_certified'],
    sufficientWhen: [
      'Only answer if the content explicitly says so.',
      'holds_needed: holds SOC 2 Type II or ISO 27001 with no obvious gap.',
      'missing_framework: holds one framework but clearly sells to EU, UK or regulated buyers who need another.',
      'uses_competitor: visibly uses Vanta, Drata or Secureframe, for example a powered-by trust page.',
      'not_certified: explicitly says it is not certified yet or that certification is in progress.',
      'If the content does not mention certification, answer not_stated.',
    ].join(' '),
    absenceAnswer: 'not_certified',
    sources: [
      SECURITY,
      TRUST,
      HOME,
      page('/docs', /docs|help|support/i),
      page('/dpa', /dpa|data-processing/i),
      search('{name} {domain} SOC 2 ISO 27001 certified', '{name} security compliance trust center'),
    ],
  },
  // Holding one framework only leaves room for Sprinto if buyers want another.
  frameworkGap: {
    label: 'Buyers need another framework',
    ask: 'Is there evidence that this company needs a compliance framework it does not hold yet? Put the framework in value.',
    answers: ['yes'],
    onlyIf: (answers) => answers.certified === 'missing_framework',
    requiresValue: true,
    sufficientWhen: 'yes only if the content names the framework and shows that buyers ask for it or the company is working toward it, for example a security page, sales page, job post or customer requirement. Selling to large companies or listing other frameworks is not enough. Otherwise answer not_stated.',
    sources: [SECURITY, TRUST, CAREERS, search('{name} {domain} customers require compliance framework roadmap ISO 27001 HIPAA')],
  },
  funding: {
    label: 'Funding stage',
    ask: 'What is the latest funding stage of this company?',
    answers: ['series_a_c', 'bootstrapped', 'too_early', 'too_late'],
    sufficientWhen: 'A dated announcement or funding profile names the latest round, or a source says it is bootstrapped. too_early means pre-seed or seed. too_late means Series D or later, public or acquired.',
    sources: [
      search('{name} {domain} funding round raised Series'),
      page('/press', /press|news|newsroom/i),
      search('{name} Crunchbase funding stage'),
      search('{name} investors portfolio company'),
    ],
  },
  preparing: {
    label: 'Preparing for audit',
    ask: 'Is this company preparing for a compliance audit right now?',
    answers: ['yes'],
    sufficientWhen: 'yes only if a job post mentions achieving SOC 2 or ISO 27001, the site says SOC 2 is in progress, or it is hiring its first security, GRC or compliance person. Otherwise answer not_stated.',
    absenceAnswer: 'no',
    sources: [
      CAREERS,
      SECURITY,
      search('{name} {domain} job posting SOC 2 ISO 27001 compliance', '{name} hiring security engineer GRC compliance'),
      page('/blog', /blog/i),
      page('/changelog', /changelog|release-notes|whats-new/i),
      search('{name} SOC 2 audit in progress'),
    ],
  },
  clients: {
    label: 'Size of clients',
    ask: 'Does this company have enterprise clients, or an enterprise tier?',
    answers: ['yes', 'no'],
    sufficientWhen: 'yes if a named client has over 1,000 employees or is in a regulated sector, or pricing shows an enterprise tier. Logos or names of widely known large companies count, and you may use general knowledge of how large a named client is; quote its name as evidence. no if named clients are clearly all small. Otherwise answer not_stated.',
    absenceAnswer: 'no',
    sources: [CUSTOMERS, HOME, page('/case-studies', /case-stud|success-stor/i), PRICING, search('{name} {domain} enterprise customer announcement')],
  },
};

const SUPPORTING = {
  clientCount: {
    label: 'Number of clients',
    ask: 'How many customers does this company claim or show?',
    answers: ['known'],
    sufficientWhen: 'The content states a count, or at least 3 named customers are visible. Put the count or the names in value.',
    sources: [HOME, CUSTOMERS, ABOUT, search('{name} number of customers')],
  },
  industry: {
    label: 'Industry',
    ask: 'Which industries does this company sell into, and does that include finance, healthcare or another regulated sector?',
    answers: ['regulated', 'not_regulated'],
    sufficientWhen: 'At least one named client, case study or solutions page shows the sector. Put the sector in value.',
    sources: [CUSTOMERS, page('/solutions', /solutions|industries/i), page('/case-studies', /case-stud/i), search('{name} customers industries')],
  },
  cloud: {
    label: 'Cloud stack',
    ask: 'Which cloud provider does this company run on?',
    answers: ['aws', 'azure', 'gcp', 'other'],
    sufficientWhen: 'A subprocessors page, privacy policy or job post names the provider.',
    sources: [
      page('/subprocessors', /sub-?processors/i),
      page('/privacy', /privacy/i),
      search('{name} engineering job AWS Azure GCP'),
      page('/engineering', /engineering/i),
    ],
  },
};

// Stops a runaway loop. The source lists should finish well before this.
const MAX_TRIES_PER_COMPANY = 40;

// An email's hook can't come from anything older than this.
const HOOK_MAX_AGE_MONTHS = 12;

// Who to contact, by employee count. Earlier entries are preferred.
const CONTACT_ROLES = {
  security: /\b(ciso|chief (information )?security|head of (information |product )?security|(vp|vice president|director)\b.*\bsecurity|security lead|grc|head of compliance|compliance (lead|manager))\b/i,
  cto: /\b(cto|chief technology|technical co-?founder)\b/i,
  vpEng: /\b((vp|vice president)\b.*\bengineering|head of engineering)\b/i,
  ceo: /\b(ceo|chief executive|co-?founder|founder)\b/i,
};

const contactOrder = (employees) => {
  if (employees !== null && employees < 50) return ['cto', 'ceo'];
  if (employees !== null && employees > 150) return ['security', 'cto'];
  return ['security', 'cto', 'vpEng'];
};

// Companies that sell compliance automation are never prospects.
const EXCLUDED_DOMAINS = ['sprinto.com', 'vanta.com', 'drata.com', 'secureframe.com'];

module.exports = { EMPLOYEES, REQUIRED, SUPPORTING, MAX_TRIES_PER_COMPANY, HOOK_MAX_AGE_MONTHS, CONTACT_ROLES, contactOrder, EXCLUDED_DOMAINS };
