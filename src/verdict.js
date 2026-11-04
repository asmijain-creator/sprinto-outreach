// The qualification decision. This is plain code, not the model, so the same
// answers always give the same verdict and every verdict can be explained.
const { EMPLOYEES } = require('../config/icp');

const reject = (code, reason, flags) => ({ verdict: 'reject', code, reason, flags });
const qualify = (code, reason, flags) => ({ verdict: 'qualify', code, reason, flags });

// Returns a decision, or null if the next question still needs answering.
// An undefined answer means "not asked yet"; 'unknown' means the sources ran out.
function decide(a) {
  const flags = [];

  if (a.saas === undefined) return null;
  if (a.saas === 'not_b2b_saas') return reject('not_saas', 'Not a B2B SaaS company.', flags);
  if (a.saas === 'unknown') return reject('insufficient_evidence', 'Could not confirm it is B2B SaaS.', flags);

  if (a.employees === undefined) return null;
  if (a.employees === 'unknown') return reject('insufficient_evidence', 'Could not find an employee count.', flags);
  if (a.employees < EMPLOYEES.rejectBelow) return reject('too_small', `About ${a.employees} employees, under ${EMPLOYEES.rejectBelow}.`, flags);
  if (a.employees > EMPLOYEES.rejectAbove) return reject('too_large', `About ${a.employees} employees, over ${EMPLOYEES.rejectAbove}.`, flags);
  if (a.employees < EMPLOYEES.targetMin || a.employees > EMPLOYEES.targetMax) flags.push(`Employee count is borderline (${a.employees}).`);

  if (a.certified === undefined) return null;
  if (a.certified === 'holds_needed') return reject('already_certified', 'Already holds the frameworks its buyers need.', flags);
  if (a.certified === 'uses_competitor') return reject('uses_competitor', 'Visibly uses a competing compliance platform.', flags);
  if (a.certified === 'unknown') return reject('insufficient_evidence', 'Could not rule out that it is already certified.', flags);
  if (a.certified === 'missing_framework') {
    if (a.frameworkGap === undefined) return null;
    if (a.frameworkGap !== 'yes') return reject('already_certified', 'Holds a certification, and found no evidence that it needs another.', flags);
  }

  if (a.funding === undefined) return null;
  if (a.funding === 'too_early') return reject('too_early', 'Pre-seed or seed stage.', flags);
  if (a.funding === 'too_late') return reject('too_late', 'Series D or later, public or acquired.', flags);
  if (a.funding === 'unknown') flags.push('Funding stage is unknown.');

  if (a.preparing === undefined) return null;
  if (a.preparing === 'yes') return qualify('preparing_for_audit', 'Evidence that it is preparing for a compliance audit.', flags);

  if (a.clients === undefined) return null;
  if (a.clients === 'yes') return qualify('enterprise_pressure', 'Has enterprise clients or an enterprise tier, without the certification they expect.', flags);

  return reject('no_trigger', 'Fits the profile, but found no sign of an audit or enterprise pressure.', flags);
}

module.exports = { decide };
