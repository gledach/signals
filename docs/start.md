# START — Get Signal running on your machine

Follow this even if you've never used git, a terminal, or Node.js before.
It takes ~15 minutes end to end.

**Platform:** steps below are for Windows. If you're on Mac/Linux, the
commands are the same — you'll use Terminal (Mac) or any terminal app
(Linux) instead of PowerShell.

---

## What you need to start

Nothing. Signal runs on a local database file with no account and no API key —
Steps 1-5 plus `npm run db:migrate` give you a populated dashboard.

Keys only unlock more. Ask Aleksandar for whichever you need:

```
OPENROUTER_API_KEY=sk-or-v1-...   # LLM classification, battlecards, analyst briefs
TAVILY_API_KEY=tvly-...           # mention discovery beyond RSS
TURSO_DATABASE_URL=libsql://...   # only if you want the hosted DB instead of the local file
TURSO_AUTH_TOKEN=eyJ...
```

Without `OPENROUTER_API_KEY` the keyword classifier runs instead of the LLM and
`npm run refresh` / `npm run research` won't work. Everything else still does.
`npm run doctor` (Step 8) tells you exactly what each missing key blocks.

Optional later: Google Alerts via Gmail (local only) needs a GCP OAuth client —
see [docs/gmail.md](./gmail.md). Not required for the first dashboard.

Keep whatever he sends open in another window — you'll paste it into a file in
Step 6. **Don't share these keys with anyone or commit them to git.**

> **You don't need a Turso account.** The default database is a plain file at
> `data/signals.db`, created by `npm run db:migrate` in Step 7. If Aleksandar
> wants you on the shared hosted database instead, he'll send you a
> `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` pair — paste those into `.env` in
> Step 6 and everything else works the same.

---

## Step 1 — Install Node.js

Node.js runs the Signal scripts.

1. Go to <https://nodejs.org/>
2. Download the **LTS** version (big green button, left side)
3. Run the installer, accept all defaults, click through to finish
4. Restart your computer (Windows needs this so the terminal can find Node)

**Verify it worked:** open PowerShell (press `Win` key, type `powershell`, hit
Enter) and type:

```powershell
node --version
```

You should see something like `v22.11.0`. If you see "command not found",
restart the computer and try again.

---

## Step 2 — Install Git

Git lets you download the project and later pull updates.

1. Go to <https://git-scm.com/download/win>
2. Download the 64-bit installer
3. Run the installer. Accept all defaults — **don't change any settings**.
   The defaults are correct.

**Verify it worked:** in PowerShell:

```powershell
git --version
```

You should see something like `git version 2.47.0`.

---

## Step 3 — Pick a folder for the project

You want a folder that's easy to find. I recommend:

```powershell
cd C:\
mkdir sites
cd sites
mkdir d
cd d
```

(If `C:\sites\d` already exists, just `cd C:\sites\d`.)

Whatever folder you choose, remember the full path — you'll come back to it
later when you want to run Signal.

---

## Step 4 — Download the project

In the same PowerShell window:

```powershell
git clone https://github.com/apsolut/apsolut-signal.git
cd apsolut-signal
```

If git asks you to log in to GitHub, use your GitHub account. If you don't
have one, create one at <https://github.com/> first (free).

---

## Step 5 — Install the project's dependencies

Inside the `apsolut-signal` folder:

```powershell
npm install
```

This downloads about 72 MB of packages into a `node_modules/` folder.
Takes 2–5 minutes. You'll see a wall of text — that's normal. As long as it
finishes without a red "ERR!" line at the end, you're good.

---

## Step 6 — Set up `.env`

Copy the example file to a real one:

```powershell
copy .env.example .env
```

Open the new `.env` file in Notepad (or any editor):

```powershell
notepad .env
```

Leave the two `TURSO_` lines alone unless Aleksandar sent you hosted database
credentials — the shipped values point at a local file that works out of the box.
Replace the `sk-or-v1-...` and `tvly-...` placeholders with real keys if you have
them, or delete those lines. Save and close Notepad.

**Double-check:** make sure every line looks like `KEY=value` with no spaces
around the `=` and no quotes around the value.

---

## Step 7 — Create the database

```powershell
npm run db:migrate
```

This applies every file in `sql/` and, on a first run against an empty database,
loads the shipped demo signals so the dashboard isn't a blank page. It is
idempotent — running it again is safe. Demo rows are removable later with
`npm run demo:clear`.

Then check the store round-trips:

```powershell
npm run db:test
```

You should see output ending with:

```
[test-store] ALL CHECKS PASSED ✓
```

If it errors instead, run `npm run doctor` (next step) — it names which database
you're actually talking to.

---

## Step 8 — Check what works

```powershell
npm run doctor
```

One screen: which database you're on, how many signals are in it, how fresh they
are, and — for every key you didn't set — what it blocks. `ok` and `warn` lines
are fine; only `FAIL` needs action. Run this first whenever something looks off.

---

## Step 9 — Open the dashboard

```powershell
npm run view
```

Open your browser to <http://localhost:5180>. You should see the Signal
dashboard with the demo signals, the sidebar, and empty battlecard panels.
Battlecards are generated, not shipped — `battlecards/*.md` is gitignored, so a
fresh clone has none. If you have an `OPENROUTER_API_KEY`, fill them in with
`npm run refresh` (~$1, a few minutes); without one, the rest of the dashboard
still works. `npm run research -- --company=lovable` needs that battlecard to
exist first — run `npm run bootstrap -- --company=lovable` if it complains.
**Leave this PowerShell window open** — closing it shuts the dashboard down.

To stop the server later: press `Ctrl+C` in the PowerShell window.

---

## You're done 🎉

---

# Daily use

Once a day (or whenever you want fresh signals), open a **new** PowerShell
window, navigate to the project, and run:

```powershell
cd C:\sites\d\apsolut-signal
npm run fetch           # pulls new RSS signals (~1 minute)
npm run correlate       # rebuilds convergences (~10 seconds)
```

Then flip back to your browser tab — the dashboard re-fetches every 2 minutes
while the tab is visible. To pull immediately, press `.` or click the refresh
icon in the header.

To generate fresh battlecards from the latest signals (do this weekly):

```powershell
npm run refresh
```

---

# Common commands

| Command | What it does |
|---|---|
| `npm run view` | Open the dashboard at http://localhost:5180 |
| `npm run fetch` | Pull fresh RSS signals (once every 30 min max) |
| `npm run correlate` | Rebuild cross-signal convergences |
| `npm run refresh` | Re-generate all battlecards (weekly; ~$1 of LLM spend) |
| `npm run brief` | 200-word morning brief from the analyst persona |
| `npm run scan` | Top 5 signals across last 14 days |
| `npm run research -- --company=lovable` | Deep research via Opus (~$0.50) |
| `npm run help` | Full cheat-sheet |

---

# Getting updates later

When Aleksandar pushes new changes, pull them:

```powershell
cd C:\sites\d\apsolut-signal
git pull
npm install      # only if dependencies changed; safe to always run
```

---

# If something breaks

1. **"command not found: npm"** — Step 1 didn't finish. Restart your
   computer, re-verify with `node --version`.
2. **"git: command not found"** — Step 2 didn't finish. Same fix.
3. **`npm install` fails with TLS / certificate errors** — you're behind a
   corporate proxy. Ask Aleksandar; there's a workaround documented in
   [howto.md](./howto.md#corporate-tls--self-signed-certificate-errors).
4. **Dashboard loads but shows no data** — you skipped Step 7. Run
   `npm run db:migrate`, then `npm run doctor`, which prints how many signals
   are in the database and which database it is actually talking to. If you're
   on the hosted database and doctor says the store is empty, re-check the
   `TURSO_` lines in `.env`.
5. **Port 5180 already in use** — another process is using it. Close other
   terminals running `npm run view`, or restart your computer.

Anything else: copy the error message and send it to Aleksandar.

---

# Where to go next

- **[../README.md](../README.md)** — 5-minute overview of what Signal is and does
- **[howto.md](./howto.md)** — task-oriented reference for every feature
- **[roadmap.md](./roadmap.md)** — the roadmap, with detailed plans in [plans/](./plans/)
- **[nextsteps.md](./nextsteps.md)** — the architectural direction (Signal as
  brain, not just news dashboard)
- **[mcp.md](./mcp.md)** — how an AI agent queries Signal directly
