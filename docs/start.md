# START — Get Signal running on your machine

Follow this even if you've never used git, a terminal, or Node.js before.
It takes ~15 minutes end to end.

**Platform:** steps below are for Windows. If you're on Mac/Linux, the
commands are the same — you'll use Terminal (Mac) or any terminal app
(Linux) instead of PowerShell.

---

## What you need from Aleksandar (before starting)

Send you a single message containing:

```
OPENROUTER_API_KEY=sk-or-v1-...
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=eyJ...
TAVILY_API_KEY=tvly-...
```

Keep this message open in another window — you'll paste these values into a
file in Step 6. **Don't share these keys with anyone or commit them to git.**

> **You don't need to create a Turso database yourself.** Aleksandar has
> already provisioned one and both of you will use the same shared database.
> The `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` above are the credentials
> for that shared database. Just paste them into `.env` in Step 6.

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
git clone <REPO_URL> Signal
cd Signal
```

Aleksandar will send you the exact URL — it'll look like
`https://github.com/<username>/Signal.git` or similar.

If git asks you to log in to GitHub, use your GitHub account. If you don't
have one, create one at <https://github.com/> first (free).

---

## Step 5 — Install the project's dependencies

Inside the `Signal` folder:

```powershell
npm install
```

This downloads about 72 MB of packages into a `node_modules/` folder.
Takes 2–5 minutes. You'll see a wall of text — that's normal. As long as it
finishes without a red "ERR!" line at the end, you're good.

---

## Step 6 — Add the API keys

Copy the example file to a real one:

```powershell
copy .env.example .env
```

Open the new `.env` file in Notepad (or any editor):

```powershell
notepad .env
```

Scroll to the top and paste the values from Aleksandar's message. You're
replacing the `sk-or-v1-...` / `libsql://...` / `eyJ...` / `tvly-...`
placeholders with the real values. Save and close Notepad.

**Double-check:** make sure every line looks like `KEY=value` with no spaces
around the `=` and no quotes around the value.

---

## Step 7 — Verify the database connection works

```powershell
npm run db:test
```

You should see output ending with:

```
[test-store] ALL CHECKS PASSED ✓
```

If you see "TURSO_DATABASE_URL is not set" or a network error, re-check
Step 6 — the most common mistake is a typo or stray quote in `.env`.

---

## Step 8 — Open the dashboard

```powershell
npm run view
```

Open your browser to <http://localhost:5180>. You should see the Signal
dashboard with signals, battlecards, and the sidebar. **Leave this
PowerShell window open** — closing it shuts the dashboard down.

To stop the server later: press `Ctrl+C` in the PowerShell window.

---

## You're done 🎉

---

# Daily use

Once a day (or whenever you want fresh signals), open a **new** PowerShell
window, navigate to the project, and run:

```powershell
cd C:\sites\d\Signal
npm run fetch           # pulls new RSS signals (~1 minute)
npm run correlate       # rebuilds convergences (~10 seconds)
```

Then flip back to your browser tab — dashboard auto-refreshes every 30s.

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
cd C:\sites\d\Signal
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
   [HOWTO.md](./HOWTO.md#corporate-tls--self-signed-certificate-errors).
4. **Dashboard loads but shows no data** — the database credentials in
   `.env` are wrong. Re-do Step 6, then `npm run db:test`.
5. **Port 5180 already in use** — another process is using it. Close other
   terminals running `npm run view`, or restart your computer.

Anything else: copy the error message and send it to Aleksandar.

---

# Where to go next

- **[README.md](./README.md)** — 5-minute overview of what Signal is and does
- **[HOWTO.md](./HOWTO.md)** — task-oriented reference for every feature
- **[PLAN.md](./PLAN.md)** — the roadmap of what we might build next
- **[NEXTSTEPS.md](./NEXTSTEPS.md)** — the architectural direction (Signal as
  brain, not just news dashboard)
