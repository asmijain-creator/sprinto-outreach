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

## The reply agent (after "Send")

Once a cold email is sent, the reply agent takes over. It's built on [LangGraph](https://github.com/langchain-ai/langgraphjs), following the five decisions from *Agents as Actors with Tools* (MESA, Term 2, L6). The prospect never receives the email, so on the page you paste what they would reply, under Emails, Sent, Reply agent.

**1. Tools and descriptions** (`src/tools.js`). Each tool's description is a field in code that says what it does, when to use it, when not to, and what it returns.

| Tool | What it does |
|---|---|
| `send_email` | Sends a confirmation, or a hand-off to the Growth Lead. Always to `EMAIL_TO` only. |
| `check_calendar` | Checks one time on Sprinto's sales calendar: free, busy, or no-calendar-access |
| `propose_time` | Emails the prospect free times, using `send_email` |
| `book_meeting` | Books a confirmed time. The calendar refuses double bookings. |
| `update_crm` | Logs the outcome: meeting booked, not interested, or handed to a person |

The calendar and CRM are the Supabase tables `meetings` and `crm_log`. The calendar offers weekdays at 11:00 and 15:00 India time, up to 30 days out.

**2. State schema** (`src/agent.js`). One state object, fixed before the agent runs: `reply_status`, `calendar_checked`, `times_proposed`, `reply_round`, `meeting_status`, `crm_logged`, plus the reply, the times asked for or turned down, and the timeline. It's saved with each company, so every run, and every person, picks up where the last left off.

**3. Edges.** A reply goes to `handle_reply`, where Gemini turns it into fields. The edges then decide what runs next:
- **Interested:** `check_calendar`, then `propose_time`, then wait for the reply.
- **Confirms a time:** `check_calendar`, then `book_meeting`, then the confirmation email, then `update_crm`.
- **Suggests another time:** `reply_round` goes up and the earlier times are ruled out, then back to `check_calendar`. Their time is offered first if it's free. At 2 rounds, `escalate`.
- **Declines:** `update_crm`.
- **Unclear, such as a question:** `escalate`.
- **No reply within 48 hours:** `escalate`, checked by the daily cron.

`escalate` emails the Growth Lead (at `EMAIL_TO`) and logs to the CRM. The Growth Lead can hand the thread back from the page, and the agent resumes from the saved state.

**4. Retry table** (`config/agent.js`). Each failure is transient (a timeout, a rate limit or a server error) or permanent. A transient one is retried up to 3 times.

| Tool | Transient | Permanent | Why |
|---|---|---|---|
| `send_email` | Retry, then skip | Skip | Nothing later depends on it |
| `check_calendar` | Retry, then escalate | Escalate | Proposals depend on it, and a person can check instead |
| `propose_time` | Retry, then escalate | Escalate | The prospect is waiting, and a person can send times |
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
| `src/agent.js`, `src/tools.js`, `config/agent.js` | The reply agent: graph, tools and rules |
| `src/app.js` | The API |
| `api/` | One Vercel function per API route |
| `public/index.html` | The review page |
