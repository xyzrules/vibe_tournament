# ⚽ Kèo máu

Predict soccer match results with your friends. Pick a tournament, browse the
fixtures, call who wins before kickoff, then watch the rankings as real
results come in.

- **Tournaments:** Premier League, La Liga, Champions League, Europa League,
  World Cup (the leagues included in the footballdata.io free plan).
- **Real data:** fixtures & results from [footballdata.io](https://footballdata.io),
  match-winner odds from [odds-api.io](https://odds-api.io) (DraftKings + 1xbet).
- **Free hosting:** the website runs on GitHub Pages; the database is a
  **private Google Sheet** of yours, driven by a free Google Apps Script that
  acts as the server (it also hides the API keys and runs the daily sync).

## How the game works

- Everyone signs up with a username + password (casual accounts — the signup
  page warns people not to reuse a real password; only salted hashes are
  stored, never plaintext).
- Predictions are changeable until kickoff, locked at kickoff. A correct pick
  earns that match's points (set by the admin; can differ per round).
- Three guess modes, set per tournament by the admin:
  - **Win / Draw / Loss** — classic 1X2 on the regulation result.
  - **Win / Loss** — pick who advances; penalties and extra time count
    (shootout scores come from the odds service and are shown as
    `1–1 (pens 4–2)`).
  - **Goal handicap** — the admin sets a line per match (e.g. `-0.5`); you
    pick a side against the line you saw, landing exactly on the line is a
    push (0 points).
- Other players' picks stay hidden until kickoff, then everyone can see who
  picked what on the match page.
- Per-tournament tabs: **Fixtures** and **Results** grouped by round /
  matchday, **Table** (league table, or group tables computed from group
  results), **Knockout** (rounds in order — see who advances to face whom),
  **Rankings**, **History**.
- **Odds:** never auto-fetched. Any user can press *Refresh odds* on a match;
  the result is stored and shared with everyone, and further refreshes are
  locked for 5 minutes (the page shows who refreshed and when). If the odds
  service has no confidently-matching event, the match shows "odds
  unavailable" rather than wrong odds.
- **Fixture syncing** is stingy with the API budget (1000 requests/month on
  the free plan): one full sync per day, plus a single re-fetch ~3 hours
  after a match should have finished to pick up the result.

## Admin

A user `admin` (password `admin`) is created automatically — log in with it
to get the ⚙ Admin page:

- show/hide whole tournaments or individual matches,
- set the guess mode per tournament,
- set default points per match and different points per round (e.g. World
  Cup group games 1 pt, quarter-finals 3 pts),
- set the handicap line per match (players can't pick until a line is set).

Changing the guess mode never re-scores old picks — each pick is scored
under the mode that was active when it was made. Change the admin password
by deleting the admin row in the sheet's `Users` tab and signing up `admin`
again with a better password (do that before sharing the link).

## Setup — GitHub Pages + Google Sheet (recommended, free)

You need: a Google account, a GitHub account, and your two API keys.

### 1. Create the Google Sheet backend

1. Go to [sheets.new](https://sheets.new) and create a blank spreadsheet
   (name it anything, e.g. "Vibe Tournament DB"). **Don't share it** — it
   stays private; your friends never need to see it.
2. In the sheet: **Extensions → Apps Script**. Delete the default code and
   paste the entire contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. In the Apps Script editor, open **Project Settings (⚙) → Script
   Properties → Add script property**, and add both:
   - `FOOTBALLDATA_API_KEY` = your footballdata.io key
   - `ODDS_API_KEY` = your odds-api.io key

   (Keys live only here — never in the GitHub repo.)
4. Back in the editor, select the `setup` function in the toolbar dropdown
   and press **Run**. Grant the permissions it asks for. This creates the
   database tabs, schedules an hourly sync, and downloads the fixtures
   (takes ~30 seconds; watch the tabs fill up in your sheet).
5. **Deploy → New deployment → (⚙) Web app**, with:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**

   Press Deploy and **copy the Web app URL** (ends in `/exec`).

### 2. Publish the website on GitHub Pages

1. Edit [`docs/config.js`](docs/config.js) and paste your Web app URL:

   ```js
   window.VIBE_CONFIG = { API_URL: 'https://script.google.com/macros/s/…/exec' };
   ```

2. Push this repository to GitHub.
3. In the GitHub repo: **Settings → Pages → Build and deployment**, set
   *Source* to **Deploy from a branch**, branch **main**, folder **/docs**.
4. After a minute your site is live at
   `https://<your-username>.github.io/<repo-name>/` — share that link with
   your friends.

### Notes on this setup

- The Apps Script URL is public but useless without playing by the rules —
  all game logic (kickoff locks, odds locks, hidden picks) is enforced in
  the script, not the browser.
- Anyone who signs up can play. If someone misbehaves, delete their row in
  the sheet's `Users` tab.
- Responses take ~1–2 seconds (that's Apps Script); fine for a friend group.
- To update the backend later: paste the new `Code.gs`, then
  **Deploy → Manage deployments → edit → New version**. The URL stays the same.
- Your sheet **is** the database — you can watch predictions arrive live,
  and Google keeps version history (File → Version history) as backup.

## Testing the site locally

```bash
node serve-docs.js
```

serves the website at <http://localhost:8080> against your real Apps Script
backend — exactly what GitHub Pages will serve.

## Alternative: run it yourself with Node (no Google)

There's a standalone implementation in this repo too — SQLite database in
`data/app.db`, zero npm dependencies. Note: it has the original feature set
(no admin page, guess modes, or penalty display); the Apps Script version
above is the primary one.

```bash
cp .env.example .env     # paste your API keys into .env
node server.js           # needs Node 22.5+ (24 recommended)
```

Open <http://localhost:3000>. Tests: `npm test`.

Use this for local development, or deploy it to any Node host with a
persistent disk (Railway, Fly.io, Render, a Raspberry Pi).

## Project layout

```text
apps-script/Code.gs   Google Apps Script backend (Sheet = database)
docs/                 static website for GitHub Pages (points at Apps Script)
docs/config.js        ← paste your Web app URL here
server.js + src/      standalone Node implementation (optional alternative)
public/               frontend for the Node implementation
tests/                node --test suite for the Node implementation
docs/superpowers/     design spec + implementation plan
```
