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

## The structure

| Path | What it does |
|---|---|
| `config/icp.js` | The ICP: every qualifier, its sources and its "sufficient when" rule |
| `src/verdict.js` | The qualification decision, as plain code |
| `src/shortlist.js`, `src/research.js`, `src/outreach.js` | Find companies, research them, find the PoC, draft and send |
| `src/app.js` | The API |
| `api/` | One Vercel function per API route |
| `public/index.html` | The review page |
