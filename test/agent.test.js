// Runs the real LangGraph agent with stand-in tools and a scripted reader, so no
// email, calendar, CRM or model is touched.
const test = require('node:test');
const assert = require('node:assert');

// Point the database at a closed port, so a test can never reach real data.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SECRET_KEY = 'test-only';
const { runAgent, checkSilence, handBack, startThread } = require('../src/agent');
const { isBookable, upcomingSlots, localParts } = require('../src/tools');

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
    send_email: { run: async (i) => { w.calls.push('send_email'); maybeFail('send_email'); w.emails.push(i.subject); return { id: 'e' }; } },
    check_calendar: { run: async ({ time, now }) => { w.calls.push('check_calendar'); maybeFail('check_calendar'); return { result: !isBookable(new Date(time), now) || w.booked.has(time) ? 'busy' : 'free' }; } },
    propose_time: { run: async ({ times }) => { w.calls.push('propose_time'); maybeFail('propose_time'); w.emails.push(`propose ${times.length}`); return { id: 'p', times }; } },
    book_meeting: { run: async ({ time }) => { w.calls.push('book_meeting'); maybeFail('book_meeting'); if (w.booked.has(time)) throw Object.assign(new Error('taken'), { status: 409 }); w.booked.add(time); return { id: 1 }; } },
    update_crm: { run: async ({ event }) => { w.calls.push('update_crm'); maybeFail('update_crm'); w.crm.push(event); return { id: 1 }; } },
  };
  return w;
}

const reader = (r) => async () => ({ requested_times: [], summary: 'test', ...r });
const deps = (w, r) => ({ tools: w.tools, classify: reader(r), now: () => NOW, save: async (c) => c });
const state = (c) => c.agent.state;

test('an interested reply checks the calendar and proposes two free times', async () => {
  const w = world();
  const c = await runAgent(company, { reply_text: 'Sounds good, happy to chat' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  const s = state(c);
  assert.strictEqual(s.reply_status, 'interested');
  assert.strictEqual(s.calendar_checked, true);
  assert.strictEqual(s.times_proposed.length, 2);
  assert.strictEqual(s.meeting_status, 'pending_confirmation');
  assert.deepStrictEqual(w.emails, ['propose 2']);
  assert.ok(s.times_proposed.every((t) => isBookable(new Date(t), NOW)));
});

test('busy slots are skipped when proposing', async () => {
  const first = upcomingSlots(NOW)[0];
  const w = world({ busy: [first] });
  const c = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  assert.ok(!state(c).times_proposed.includes(first));
});

test('confirming a proposed time books it, confirms by email and logs it', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  const c = await runAgent(proposed, { reply_text: 'The first one works' }, deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }));
  const s = state(c);
  assert.strictEqual(s.meeting_status, 'confirmed');
  assert.strictEqual(s.booked_time, state(proposed).times_proposed[0]);
  assert.strictEqual(s.crm_logged, true);
  assert.deepStrictEqual(w.crm, ['meeting_booked']);
  assert.ok(w.emails.some((e) => /Confirmed/.test(e)));
  await assert.rejects(runAgent(c, { reply_text: 'again' }, deps(w, { intent: 'interested' })), /already finished/);
});

test('a counter-proposal loops back, offers their time first, and the second one escalates', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
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
  assert.ok(w.emails.some((e) => e.startsWith('[Escalation]')));
  assert.ok(w.crm.includes('escalated'));
});

test('a decline is logged to the CRM and ends the thread', async () => {
  const w = world();
  const c = await runAgent(company, { reply_text: 'Not for us' }, deps(w, { reply_status: 'not_interested', intent: 'decline' }));
  assert.strictEqual(state(c).reply_status, 'not_interested');
  assert.deepStrictEqual(w.crm, ['not_interested']);
  assert.ok(!w.calls.includes('check_calendar'));
});

test('an unclear reply goes to a person, and a hand-back lets the agent resume', async () => {
  const w = world();
  const c = await runAgent(company, { reply_text: 'Do you support FedRAMP?' }, deps(w, { reply_status: 'interested', intent: 'unclear' }));
  assert.strictEqual(state(c).escalated, true);
  await assert.rejects(runAgent(c, { reply_text: 'ok' }, deps(w, { intent: 'interested' })), /Hand it back/);

  const resumed = await handBack(c, 'Answered their question', NOW, async (x) => x);
  assert.strictEqual(state(resumed).escalated, false);
  const r = await runAgent(resumed, { reply_text: 'Thanks, lets meet' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  assert.strictEqual(state(r).meeting_status, 'pending_confirmation');
});

test('silence for 48 hours escalates, but not before, and old threads are left alone', async () => {
  const w = world();
  const quiet = { tools: w.tools, save: async (c) => c };
  assert.strictEqual(await checkSilence(company, new Date('2026-11-18T07:00:00Z'), quiet), null);

  const fresh = startThread({ ...company, email: { ...company.email, sentAt: '2026-11-16T12:00:00Z' } });
  assert.strictEqual(await checkSilence(fresh, NOW, quiet), null);
  const old = await checkSilence(startThread(company), new Date('2026-11-18T07:00:00Z'), quiet);
  assert.strictEqual(state(old).escalated, true);
  assert.match(state(old).escalation_reason, /48 hours/);
});

test('retry table: a calendar timeout is retried three times, then escalated', async () => {
  const w = world({ fail: { check_calendar: { times: 3 } } });
  const c = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  assert.strictEqual(w.calls.filter((x) => x === 'check_calendar').length, 3);
  assert.strictEqual(state(c).escalated, true);
});

test('retry table: a transient calendar blip is retried and the run carries on', async () => {
  const w = world({ fail: { check_calendar: { times: 1 } } });
  const c = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  assert.strictEqual(state(c).meeting_status, 'pending_confirmation');
  assert.ok(state(c).log.some((e) => e.kind === 'error'));
});

test('retry table: a taken slot aborts book_meeting immediately, without retrying', async () => {
  const w = world();
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  const tools = { ...w.tools, book_meeting: { run: async () => { w.calls.push('book_meeting'); throw Object.assign(new Error('taken'), { status: 409 }); } } };
  const c = await runAgent(proposed, { reply_text: 'first' }, { ...deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }), tools });
  assert.strictEqual(w.calls.filter((x) => x === 'book_meeting').length, 1);
  assert.strictEqual(state(c).outcome, 'booking_failed');
  assert.notStrictEqual(state(c).meeting_status, 'confirmed');
});

test('retry table: a failed confirmation email is skipped and the CRM is still updated', async () => {
  const w = world({ fail: { send_email: { times: 3 } } });
  const proposed = await runAgent(company, { reply_text: 'yes' }, deps(w, { reply_status: 'interested', intent: 'interested' }));
  const c = await runAgent(proposed, { reply_text: 'first' }, deps(w, { reply_status: 'interested', intent: 'confirm', chosen_option: 1 }));
  assert.strictEqual(state(c).meeting_status, 'confirmed');
  assert.strictEqual(state(c).crm_logged, true);
});

test('the calendar only offers working hours, on weekdays, within 30 days', () => {
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
