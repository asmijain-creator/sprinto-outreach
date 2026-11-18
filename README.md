# Sprinto cold outreach

Finds SaaS companies, researches them against Sprinto's ICP, finds the right contact and drafts a personalised email. You review each company and each email on a web page before anything sends. Every email goes only to the address in `EMAIL_TO`, never to the contact.

## Run it on your computer

```bash
cp .env.example .env
node run.js review
```

Fill in `.env`, then open http://localhost:3000. Check your keys with `node check-keys.js`, and run the tests with `npm test`.

Other commands: `node run.js shortlist 10`, `node run.js add a.com b.io`, `node run.js research`, and `node run.js auto` (end to end with no reviews, needs `REVIEW_MODE=false`).

## Deploy to Vercel

1. **Supabase secret key.** In the Supabase dashboard, open Project Settings, then API Keys, and create a secret key. Put it in `.env` as `SUPABASE_SECRET_KEY`.
2. **Copy your existing data.** Run `node check-keys.js`, then `node scripts/migrate-to-supabase.js`.
3. **Import the project.** In Vercel, choose Add New, then Project, and import this GitHub repository. Leave the build settings as they are.
4. **Add the settings.** In the project's Environment Variables, add:
   - `HUNTER_API_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`
   - `EMAIL_TO`, `EMAIL_FROM`, `SENDER_NAME`, and `SENDER_TITLE` if you use it
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
5. **Deploy** and open the site.

## How it works when hosted

- **Saved data** lives in the Supabase `companies` table. Row level security with no policies means only the server's secret key can read it.
- **Long jobs** run in steps. The page asks the server to answer one research question at a time, so no request runs long. Keep the tab open while a job runs. If it stops, press Research shortlisted to continue from the same question.
- **Staying awake.** Supabase's free plan pauses databases that go unused. Vercel calls `/api/keepalive` once a day (`crons` in `vercel.json`) to read one row and prevent that. If the site ever shows "fetch failed", open the Supabase project and click Restore.
- **There is no login.** Anyone with the link can see all the data, including contact names and emails, and can run every action, which uses your API credits and can send emails to `EMAIL_TO`. Share the link only with people you trust.

## The whole workflow

Following *Where We Left Sprinto* (MESA, Term 2):

1. **Define ICP** (`config/icp.js`), then **Shortlist companies** from free sources.
2. **Per-company loop:** deep research from free sources and web scraping, then **Find PoC and email** with Hunter.io, then **Research PoC** (`src/poc.js`). That's the person's role, stated priorities and recent updates, from web search. Each update keeps its source and date, so it can be the email's hook only if it's under 12 months old.
3. **Draft email**, then **human review and edit** on the page, then **Send**.
4. **Feedback loop** (`src/learning.js`), which improves future emails:
   - **Act:** the system drafts the email.
   - **Signal:** the difference between that draft and the email you actually sent.
   - **Capture:** what changed, such as the hook, the angle or the call to action, and a lesson.
   - **Store:** the before and after pair, in the Supabase table `email_edits`.
   - **Retrieve:** up to 3 past lessons, from companies that qualified the same way first, then the same industry.
   - **Apply:** those lessons go into the next draft's prompt.

   The page lists every lesson, and shows which ones each draft applied.
5. **Everything after Send:** the reply agent below.

## The reply agent (after "Send")

Once a cold email is sent, the reply agent takes over. It's built on [LangGraph](https://github.com/langchain-ai/langgraphjs), following *Everything After "Send"* and the five decisions from *Agents as Actors with Tools* (MESA, Term 2, L6). The prospect never receives the email, so on the page you paste what they would reply, under Emails, Sent, Reply agent.

- **Sequence 1, Send & Wait:**
  - **Interested:** moves on to Sequence 2.
  - **Not interested:** ends.
  - **No reply:** ends.

  The cold email itself names no days or times, and the checks reject one that does.
- **Sequence 2, Schedule the Call:**
  1. `check_calendar` gets the Growth Lead's free slots.
  2. `send_email` replies with specific times.
  3. What comes back:
     - **Confirms a time:** `book_meeting` books it and sends the calendar invite, then `update_crm` writes the outcome back.
     - **Counter-proposes:** loops back to `check_calendar` and new times. A second counter-proposal hands off to the Growth Lead.
     - **Goes silent:** past the 48-hour follow-up window, it hands off to the Growth Lead, checked by the daily cron.

**1. Tools and descriptions** (`src/tools.js`). Each tool's description is a field in code that says what it does, when to use it, when not to, and what it returns. The `check_calendar` description follows the lecture's worked answer.

| Tool | What it does |
|---|---|
| `send_email` | Proposes times, sends the calendar invite (an `.ics` file), or hands off to the Growth Lead. Always to `EMAIL_TO` only. |
| `check_calendar` | Checks whether a specific date and time is free on the Growth Lead's calendar: free, busy, or no-calendar-access |
| `book_meeting` | Creates the meeting. The calendar refuses double bookings. |
| `update_crm` | Writes the booked meeting back to the CRM |

The calendar and CRM are the Supabase tables `meetings` and `crm_log`. The calendar offers weekdays at 11:00 and 15:00 India time, up to 30 days out.

**2. State schema** (`src/agent.js`). One state object, fixed before the agent runs: `reply_status`, `calendar_checked`, `times_proposed`, `reply_round`, `meeting_status`, `crm_logged`, plus the reply, the times asked for or turned down, and the timeline. It's saved with each company, so every run, and every person, picks up where the last left off. The six fields are also recorded after every step. The page shows them as *The State Object, At Every Checkpoint*, with each change highlighted.

**3. Edges.** A reply goes to `handle_reply`, where Gemini turns it into fields. The edges then decide what runs next:
- **Interested:** `check_calendar`, then `send_email` with times, then wait.
- **Confirms a time:** `check_calendar`, then `book_meeting`, then the calendar invite, then `update_crm`.
- **Counter-proposes:** `reply_round` goes up, `calendar_checked` resets, and the earlier times are ruled out. Then back to `check_calendar`, and their time is offered first if it's free. At 2 rounds, `escalate`.
- **Not interested:** end.
- **Unclear, such as a question:** `escalate`.

`escalate` emails the Growth Lead (at `EMAIL_TO`). The Growth Lead can hand the thread back from the page, and the agent resumes from the saved state.

**4. Retry table** (`config/agent.js`). Each failure is transient (a timeout, a rate limit or a server error) or permanent. A transient one is retried up to 3 times. `send_email` has two rows, because proposing times matters more than an invite or a note.

| Tool | Transient | Permanent | Why |
|---|---|---|---|
| `send_email` (invite, hand-off) | Retry, then skip | Skip | Nothing later depends on it |
| `send_email` (propose times) | Retry, then escalate | Escalate | The prospect is waiting, and a person can send times |
| `check_calendar` | Retry, then escalate | Escalate | Proposals depend on it, and a person can check instead |
| `book_meeting` | Retry, then abort | Abort | Nothing can stand in for a booking |
| `update_crm` | Retry, then escalate | Escalate | A person can log it by hand |

**5. Framework.** The confirm, counter-propose and silence branches loop back on themselves and depend on each other's state, with a retry cap and a human hand-off. That is the complex-loop case the lecture reserves for a framework, so the agent uses LangGraph. The cold-email pipeline before it stays hand-built, because it's a simple sequence.

**Someone else's tool.** In a real deployment `update_crm` would come from a CRM vendor, through an API or an MCP server, with a description and failure behaviour you inherit rather than write. Here it's a stand-in, so the retry table above is ours. Inheriting a vendor tool would mean re-checking its description against the four rules, and its failures against the table.

## The structure

| Path | What it does |
|---|---|
| `config/icp.js` | The ICP: every qualifier, its sources and its "sufficient when" rule |
| `src/verdict.js` | The qualification decision, as plain code |
| `src/shortlist.js`, `src/research.js`, `src/outreach.js` | Find companies, research them, find the PoC, draft and send |
| `src/poc.js` | Research PoC: role, priorities and recent updates |
| `src/learning.js` | The feedback loop that learns from your edits |
| `src/agent.js`, `src/tools.js`, `config/agent.js` | The reply agent: graph, tools and rules |
| `src/app.js` | The API |
| `api/` | One Vercel function per API route |
| `public/index.html` | The review page |
