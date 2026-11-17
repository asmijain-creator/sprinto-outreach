// The reply agent's five tools. Each description is a real field the agent's
// prompt is built from, so it follows the four rules: what the tool does, when
// to use it, when not to, and what it returns.
const { CALENDAR } = require('../config/agent');
const { env, db, useSupabase } = require('./lib');
const { deliver } = require('./outreach');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The weekday, date and time of a moment, in the calendar's time zone.
function localParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: CALENDAR.timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

// "2026-11-20T11:00" in the calendar's time zone, as a moment.
const atLocal = (localDateTime) => new Date(`${localDateTime}:00${CALENDAR.utcOffset}`);

const formatSlot = (iso) =>
  `${new Intl.DateTimeFormat('en-GB', { timeZone: CALENDAR.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))} IST`;

// Within working hours, on a slot boundary, and inside the bookable window.
function isBookable(date, now) {
  if (Number.isNaN(date.getTime())) return false;
  if (date.getTime() < now.getTime() + HOUR || date.getTime() > now.getTime() + CALENDAR.horizonDays * DAY) return false;
  const { weekday, hour, minute } = localParts(date);
  const endsBy = hour * 60 + minute + CALENDAR.slotMinutes <= CALENDAR.closeHour * 60;
  return CALENDAR.workDays.includes(weekday) && hour >= CALENDAR.openHour && endsBy && minute % CALENDAR.slotMinutes === 0;
}

// The next proposal slots, in order, from the day after `now`.
function upcomingSlots(now, limit = 20) {
  const slots = [];
  for (let day = 1; day <= CALENDAR.horizonDays && slots.length < limit; day++) {
    const { date } = localParts(new Date(now.getTime() + day * DAY));
    for (const hour of CALENDAR.proposalHours) {
      const slot = atLocal(`${date}T${String(hour).padStart(2, '0')}:00`);
      if (isBookable(slot, now)) slots.push(slot.toISOString());
    }
  }
  return slots;
}

const signature = () => [env.SENDER_NAME, env.SENDER_TITLE].filter(Boolean).join('\n');
// Every email is addressed in its subject to the person it is written for, but sent only to EMAIL_TO.
const forPoc = (company, subject) => `To ${company.poc.firstName} ${company.poc.lastName} at ${company.name}: ${subject}`;

const TOOLS = {
  send_email: {
    description:
      'Sends one plain-text email, always to the EMAIL_TO address only, never to the prospect directly. ' +
      'Use to confirm a booked meeting or to hand a thread to the Growth Lead. ' +
      'Do not use to propose meeting times, which is what propose_time is for, and do not use to send the first cold email. ' +
      'Returns: the email id from Resend.',
    run: async ({ subject, body, key }) => ({ id: (await deliver(subject, body, key)).id }),
  },

  check_calendar: {
    description:
      "Checks whether one specific date and time is free on Sprinto's sales calendar. " +
      'Use when a prospect is interested and times need proposing, or when a prospect confirms or suggests a time. ' +
      `Do not use to list all upcoming meetings, and do not use for times more than ${CALENDAR.horizonDays} days out, which aren't bookable yet. ` +
      'Returns: free / busy / no-calendar-access.',
    run: async ({ time, now = new Date() }) => {
      if (!useSupabase()) return { result: 'no-calendar-access' };
      const date = new Date(time);
      if (!isBookable(date, now)) return { result: 'busy' };
      const rows = await db('meetings', `?select=id&starts_at=eq.${encodeURIComponent(date.toISOString())}`);
      return { result: rows.length ? 'busy' : 'free' };
    },
  },

  propose_time: {
    description:
      'Emails the prospect a short list of free meeting times. ' +
      'Use only after check_calendar has returned free for every time being proposed. ' +
      'Do not use to confirm a booking, and do not use with times the prospect has already turned down. ' +
      'Returns: the email id and the times that were proposed.',
    run: async ({ company, times, counter }) => {
      const intro = counter
        ? "Thanks for suggesting another time. Here's what's open on our side."
        : "Thanks for getting back to me. I'd be glad to walk you through how Sprinto would handle this.";
      const body = [
        `Hi ${company.poc.firstName},`,
        '',
        intro,
        '',
        'Would one of these work for a 30-minute call?',
        ...times.map((t) => `- ${formatSlot(t)}`),
        '',
        'Just reply with the one that suits you.',
        '',
        signature(),
      ].join('\n');
      const { id } = await deliver(forPoc(company, 'Times for a quick call'), body, `${company.domain}-propose-${times.join(',')}`);
      return { id, times };
    },
  },

  book_meeting: {
    description:
      "Books one meeting on Sprinto's sales calendar. " +
      'Use only when the prospect has confirmed a specific time and check_calendar has just returned free for it. ' +
      'Do not use for a time the prospect has not confirmed, and do not use to move or cancel a meeting. ' +
      'Returns: the booked meeting, or fails if the slot has been taken.',
    run: async ({ domain, time, title }) => {
      const [row] = await db('meetings', '', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ domain, starts_at: new Date(time).toISOString(), title }),
      });
      return { id: row.id, startsAt: row.starts_at };
    },
  },

  update_crm: {
    description:
      "Writes one event to the prospect's CRM history. " +
      'Use once a thread reaches an outcome: a meeting booked, the prospect declined, or the thread was handed to a person. ' +
      'Do not use to record every message, and do not use before the outcome is known. ' +
      'Returns: the id of the logged event.',
    run: async ({ domain, event, details }) => {
      const [row] = await db('crm_log', '', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ domain, event, details }),
      });
      return { id: row.id };
    },
  },
};

module.exports = { TOOLS, formatSlot, isBookable, upcomingSlots, localParts, atLocal, forPoc, signature };
