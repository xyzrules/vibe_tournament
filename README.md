# ⚽ Kèo máu — Setup

How to get the site running. You need: a Google account, a GitHub account,
and API keys for [footballdata.io](https://footballdata.io) (fixtures &
results) and [odds-api.io](https://odds-api.io) (match odds).

## Setup — GitHub Pages + Google Sheet (recommended, free)

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

### 3. Secure the admin account

A user `admin` (password `admin`) is created automatically and gets the
⚙ Admin page on the site. **Before sharing the link**, change the password:
delete the admin row in the sheet's `Users` tab and sign up `admin` again
with a better password.

### Notes on this setup

- The Apps Script URL is public but useless without playing by the rules —
  all game logic (kickoff locks, odds locks, hidden picks) is enforced in
  the script, not the browser.
- Anyone who signs up can play. If someone misbehaves, delete their row in
  the sheet's `Users` tab.
- Responses take ~1–2 seconds (that's Apps Script); fine for a friend group.
- To update the backend later: paste the new `Code.gs`, run `setup` once
  (adds any new columns), then **Deploy → Manage deployments → edit →
  New version**. The URL stays the same.
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
