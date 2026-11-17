// The reply agent's rules. Like the ICP, these are decided before the agent ever
// runs and never improvised mid-run.

// Sprinto's sales calendar. Proposals are two slots a day, in India time.
const CALENDAR = {
  timeZone: 'Asia/Kolkata',
  utcOffset: '+05:30',
  workDays: [1, 2, 3, 4, 5],
  openHour: 10,
  closeHour: 17,
  slotMinutes: 30,
  proposalHours: [11, 15],
  // Slots further out than this aren't bookable yet.
  horizonDays: 30,
  timesPerProposal: 2,
};

// Two counter-proposals without a confirmed time hands the thread to a human.
const MAX_REPLY_ROUNDS = 2;
// No reply this long after the agent's last email also hands it to a human.
const SILENCE_HOURS = 48;
// Who gets escalations. All emails still go only to EMAIL_TO.
const ESCALATE_TO = 'Growth Lead';
// How many times a transient failure is retried before the table's fallback applies.
const MAX_ATTEMPTS = 3;

// The retry table: for each tool, what a failure leads to. Every cell comes from
// two questions: would trying again plausibly help (transient or permanent), and
// does anything after this step depend on it?
const RETRY_TABLE = {
  send_email: {
    transient: 'retry_then_skip',
    permanent: 'skip',
    why: 'Confirmations and notes: nothing later depends on them, so a lost one is logged and skipped.',
  },
  check_calendar: {
    transient: 'retry_then_escalate',
    permanent: 'escalate',
    why: 'propose_time and book_meeting depend on it, and a person can check the calendar instead.',
  },
  propose_time: {
    transient: 'retry_then_escalate',
    permanent: 'escalate',
    why: 'The prospect is waiting for times, and a person can send them instead.',
  },
  book_meeting: {
    transient: 'retry_then_abort',
    permanent: 'abort',
    why: 'Nothing can stand in for a booking, and a taken slot will not free itself, so the run stops.',
  },
  update_crm: {
    transient: 'retry_then_escalate',
    permanent: 'escalate',
    why: 'A person can log the outcome by hand if the CRM refuses it.',
  },
};

module.exports = { CALENDAR, MAX_REPLY_ROUNDS, SILENCE_HOURS, ESCALATE_TO, MAX_ATTEMPTS, RETRY_TABLE };
