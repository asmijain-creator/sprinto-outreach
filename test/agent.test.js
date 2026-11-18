// Runs the real LangGraph agent with stand-in tools and a scripted reader, so no
// email, calendar, CRM or model is touched.
const test = require('node:test');
const assert = require('node:assert');

// Point the database at a closed port, so a test can never reach real data.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SECRET_KEY = 'test-only';
const { runAgent, checkSilence, handBack, startThread } = require('../src/agent');
const { isBookable, upcomingSlots, localParts, inviteEmail } = require('../src/tools');

// Tuesday 17 November 2026, 11:30 in India.
const NOW = new Date('2026-11-17T06:00:00Z');
const company = {
  domain: 'acme.com',
  name: 'Acme',
  poc: { firstName: 'Sam', lastName: 'Lee', title: 'CTO' },
  email: { status: 'sent', sentAt: '2026-11-16T06:00:00Z' },
};

function world({ busy = [], fail = {} } = {}) {
  const w = { booked: new Set(busy), emails: [], crm: [], calls: [] };
  const maybeFail = (name) => {
    const f = fail[name];
    if (!f || f.times-- <= 0) return;
    throw Object.assign(new Error(`${name} broke`), { status: f.status });
  };
  w.tools = {
    send_email: { run: async (i) => { w.calls.push('send_email'); maybeFail(/Times for/.test(i.subject) ? 'propose' : 'send_email'); w.emails.push(i); return { id: 'e' }; } },
    check_calendar: { run: async ({ time, now }) => { w.calls.push('check_calendar'); maybeFail('check_calendar'); return { result: !isBookable(new Date(time), now) || w.booked.has(time) ? 'busy' : 'free' }; } },
    book_meeting: { run: async ({ time }) => { w.calls.push('book_meeting'); maybeFail('book_meeting'); if (w.booked.has(time)) throw Object.assign(new Error('taken'), { status: 409 }); w.booked.add(time); return { id: 1 }; } },
    update_crm: { run: async ({ event }) => { w.calls.push('update_crm'); maybeFail('update_crm'); w.crm.push(event); return { id: 1 }; } },
  };
  w.subjects = () => w.emails.map((e) => e.subject);
  return w;
}

const reader = (r) => async () => ({ requested_times: [], summary: 'test', ...r });
const deps = (w, r) => ({ tools: w.tools, classify: reader(r), now: () => NOW, save: async (c) => c });
const state = (c) => c.agent.state;
const interested = { reply_status: 'interested', intent: 'interested' };
const six = (cp) => [cp.reply_status, cp.calendar_checked, cp.times_proposed.length, cp.reply_round, cp.meeting_status, cp.crm_logged];

test('an interested reply checks the calendar, then send_email proposes two free times', async () => {
  const w = world();
  const s = state(await runAgent(company, { reply_text: 'Sounds good, happy to chat' }, deps(w, interested)));
  assert.strictEqual(s.reply_status, 'interested');
  assert.strictEqual(s.calendar_checked, true);
  assert.strictEqual(s.times_proposed.length, 2);
  assert.strictEqual(s.meeting_status, 'pending_confirmation');
  assert.strictEqual(w.emails.length, 1);
  assert.match(w.emails[0].subject, /Times for a quick call/);
  assert.ok(s.times_proposed.every((t) => isBookable(new Date(t), NOW)));
});

test('busy slots are skipped when proposing', async () => {
  const first = upcomingSlots(NOW)[0];
  const w = world({ busy: [first] });
  assert.ok(!state(await runAgent(company, { reply_text: 'yes' }, deps(w, interested))).times_proposed.includes(first));
});

test('the six fields fill in at every checkpoint, as in the lecture table', async () => {
  const w = world();
  const started = startThread(company);
  const proposed = await runAgent(started, { reply_text: 'yes' }, deps(w, interested));
  const wanted = upcomingSlots(NOW).find((t) => !state(proposed).times_proposed.includes(t));
  const { date, hour } = localParts(new Date(wanted));
  const countered = await runAgent(proposed, { reply_text: 'later?' }, deps(w, { reply_status: 'interested', intent: 'counter', requested_times: [`${date}T${String(hour).padStart(2, '0')}:00`] }));
  const booked = await runAgent(countered, { reply_text: 'first' }, deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }));

  const table = state(booked).checkpoints.map((cp) => [cp.label, ...six(cp)]);
  assert.deepStrictEqual(table, [
    ['After send email', 'no_reply', false, 0, 0, 'unscheduled', false],
    ['After prospect replies "interested"', 'interested', false, 0, 0, 'unscheduled', false],
    ['After check calendar', 'interested', true, 0, 0, 'unscheduled', false],
    ['After send email, proposing times', 'interested', true, 2, 0, 'pending_confirmation', false],
    ['If prospect counter-proposes (loop back to check calendar)', 'interested', false, 2, 1, 'pending_confirmation', false],
    ['After check calendar', 'interested', true, 2, 1, 'pending_confirmation', false],
    ['After send email, proposing times', 'interested', true, 2, 1, 'pending_confirmation', false],
    ['After prospect confirms a time', 'interested', true, 2, 1, 'pending_confirmation', false],
    ['After check calendar', 'interested', true, 2, 1, 'pending_confirmation', false],
    ['After book meeting', 'interested', true, 2, 1, 'confirmed', false],
    ['After update CRM', 'interested', true, 2, 1, 'confirmed', true],
  ]);
});

test('confirming a time books it, sends a calendar invite and writes the CRM', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  const s = state(await runAgent(proposed, { reply_text: 'The first one works' }, deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 })));
  assert.strictEqual(s.meeting_status, 'confirmed');
  assert.strictEqual(s.booked_time, state(proposed).times_proposed[0]);
  assert.strictEqual(s.crm_logged, true);
  assert.deepStrictEqual(w.crm, ['meeting_booked']);
  const invite = w.emails.find((e) => /Invitation/.test(e.subject));
  assert.ok(invite && invite.attachments[0].filename === 'invite.ics');
  const finished = { ...proposed, agent: { state: s } };
  await assert.rejects(runAgent(finished, { reply_text: 'again' }, deps(w, interested)), /already finished/);
});

test('the invite is a valid calendar event at the booked time', () => {
  const invite = inviteEmail(company, '2026-11-18T09:30:00.000Z', 'Sprinto x Acme');
  const ics = Buffer.from(invite.attachments[0].content, 'base64').toString();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20261118T093000Z/);
  assert.match(ics, /DTEND:20261118T100000Z/);
  assert.match(ics, /SUMMARY:Sprinto x Acme/);
});

test('a counter-proposal offers their time first, and the second one hands off', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  const wanted = upcomingSlots(NOW).find((t) => !state(proposed).times_proposed.includes(t));
  const { date, hour, minute } = localParts(new Date(wanted));
  const local = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const countered = await runAgent(proposed, { reply_text: 'Neither, how about later?' }, deps(w, { reply_status: 'interested', intent: 'counter', requested_times: [local] }));
  const s = state(countered);
  assert.strictEqual(s.reply_round, 1);
  assert.strictEqual(s.times_proposed[0], wanted);
  assert.ok(state(proposed).times_proposed.every((t) => s.rejected_times.includes(t) && !s.times_proposed.includes(t)));

  const again = await runAgent(countered, { reply_text: 'Still no' }, deps(w, { reply_status: 'interested', intent: 'counter', requested_times: [] }));
  assert.strictEqual(state(again).escalated, true);
  assert.strictEqual(state(again).reply_round, 2);
  assert.ok(w.subjects().some((x) => x.startsWith('[Escalation]')));
  assert.deepStrictEqual(w.crm, []);
});

test('Sequence 1: not interested simply ends, with no calendar or CRM call', async () => {
  const w = world();
  const s = state(await runAgent(company, { reply_text: 'Not for us' }, deps(w, { reply_status: 'not_interested', intent: 'decline' })));
  assert.strictEqual(s.reply_status, 'not_interested');
  assert.deepStrictEqual(w.calls, []);
  assert.strictEqual(s.crm_logged, false);
});

test('an unclear reply goes to the Growth Lead, and a hand-back lets the agent resume', async () => {
  const w = world();
  const c = await runAgent(company, { reply_text: 'Do you support FedRAMP?' }, deps(w, { reply_status: 'interested', intent: 'unclear' }));
  assert.strictEqual(state(c).escalated, true);
  await assert.rejects(runAgent(c, { reply_text: 'ok' }, deps(w, interested)), /Hand it back/);

  const resumed = await handBack(c, 'Answered their question', NOW, async (x) => x);
  assert.strictEqual(state(resumed).escalated, false);
  assert.strictEqual(state(await runAgent(resumed, { reply_text: 'Thanks, lets meet' }, deps(w, interested))).meeting_status, 'pending_confirmation');
});

test('silence: no reply to the cold email ends Sequence 1, with no hand-off', async () => {
  const w = world();
  const quiet = { tools: w.tools, save: async (c) => c };
  assert.strictEqual(await checkSilence(startThread(company), new Date('2026-11-25T07:00:00Z'), quiet), null);
  assert.strictEqual(await checkSilence(company, new Date('2026-11-25T07:00:00Z'), quiet), null);
  assert.deepStrictEqual(w.calls, []);
});

test('silence: past the 48-hour window after times were proposed goes to the Growth Lead', async () => {
  const w = world();
  const quiet = { tools: w.tools, save: async (c) => c };
  const proposed = await runAgent(startThread(company), { reply_text: 'yes' }, deps(w, interested));
  assert.strictEqual(await checkSilence(proposed, new Date(NOW.getTime() + 47 * 3600e3), quiet), null);
  const s = state(await checkSilence(proposed, new Date(NOW.getTime() + 49 * 3600e3), quiet));
  assert.strictEqual(s.escalated, true);
  assert.match(s.escalation_reason, /48-hour follow-up window/);
});

test('retry table: a calendar timeout is retried three times, then handed off', async () => {
  const w = world({ fail: { check_calendar: { times: 3 } } });
  const c = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  assert.strictEqual(w.calls.filter((x) => x === 'check_calendar').length, 3);
  assert.strictEqual(state(c).escalated, true);
});

test('retry table: a transient calendar blip is retried and the run carries on', async () => {
  const w = world({ fail: { check_calendar: { times: 1 } } });
  const c = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  assert.strictEqual(state(c).meeting_status, 'pending_confirmation');
  assert.ok(state(c).log.some((e) => e.kind === 'error'));
});

test('retry table: proposing times uses its own row, so a failure hands off instead of skipping', async () => {
  const w = world({ fail: { propose: { times: 3 } } });
  const s = state(await runAgent(company, { reply_text: 'yes' }, deps(w, interested)));
  assert.strictEqual(s.escalated, true);
  assert.notStrictEqual(s.meeting_status, 'pending_confirmation');
  assert.ok(s.log.some((e) => /send_email \(propose times\)/.test(e.text)));
});

test('retry table: a taken slot aborts book_meeting immediately, without retrying', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  const tools = { ...w.tools, book_meeting: { run: async () => { w.calls.push('book_meeting'); throw Object.assign(new Error('taken'), { status: 409 }); } } };
  const c = await runAgent(proposed, { reply_text: 'first' }, { ...deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }), tools });
  assert.strictEqual(w.calls.filter((x) => x === 'book_meeting').length, 1);
  assert.strictEqual(state(c).outcome, 'booking_failed');
  assert.notStrictEqual(state(c).meeting_status, 'confirmed');
});

test('retry table: a failed invite email is skipped and the CRM is still written', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, interested));
  const failing = world({ fail: { send_email: { times: 3 } } });
  const c = await runAgent(proposed, { reply_text: 'first' }, deps(failing, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }));
  assert.strictEqual(state(c).meeting_status, 'confirmed');
  assert.strictEqual(state(c).crm_logged, true);
});

test("the calendar only offers the Growth Lead's working hours, on weekdays, within 30 days", () => {
  const slots = upcomingSlots(NOW, 100);
  assert.ok(slots.length > 20);
  for (const s of slots) {
    const p = localParts(new Date(s));
    assert.ok([1, 2, 3, 4, 5].includes(p.weekday));
    assert.ok([11, 15].includes(p.hour));
  }
  assert.strictEqual(isBookable(new Date('2026-11-21T05:30:00Z'), NOW), false); // Saturday
  assert.strictEqual(isBookable(new Date('2026-11-18T13:00:00Z'), NOW), false); // 18:30 India time
  assert.strictEqual(isBookable(new Date('2027-01-20T05:30:00Z'), NOW), false); // beyond 30 days
  assert.strictEqual(isBookable(new Date('2026-11-18T05:30:00Z'), NOW), true); // Wed 11:00
});
