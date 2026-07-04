# Match Prediction Site — Design Spec

Date: 2026-07-04
Source requirements: `design.txt` (user-provided, pre-approved)

## Purpose

A website where friends predict soccer match results (home / draw / away) per
tournament, then track their history and rankings. Real fixtures and results
come from footballdata.io; betting odds come from odds-api.io (DraftKings and
1xbet only). The repo is uploadable to GitHub with API keys kept out of the
code.

## Stack

- **Backend:** Node.js 22.5+ (24 recommended), zero npm dependencies: the
  built-in `node:http` server and a small hand-rolled router. Single
  process, no build step, nothing to install.
- **Database:** SQLite via the built-in `node:sqlite`, file at `data/app.db`
  (gitignored). This replaces the user's spreadsheet idea: it is a single
  file, needs no external service, and is queryable. Users, predictions,
  cached matches, and odds all live here.
- **Frontend:** static `public/` folder (vanilla HTML/CSS/JS, hash-routed
  single page). No framework, no bundler.
- **Secrets:** `.env` file loaded at startup (`FOOTBALLDATA_API_KEY`,
  `ODDS_API_KEY`, `PORT`). `.env` and `source.txt` are gitignored;
  `.env.example` documents the shape.
- **Tests:** built-in `node:test` runner, in-memory SQLite, API clients
  stubbed.

## External APIs (verified 2026-07-04)

### footballdata.io — fixtures & results

- Base `https://footballdata.io/api/v1`, header `Authorization: Bearer <key>`.
- Free plan: 5 leagues (Premier League 15, La Liga 10, UCL 45, UEL 46,
  World Cup 50), 1000 requests/month. These 5 leagues ARE the tournaments.
- `GET /leagues` → `{league_id, league_name, country, league_image}`.
- `GET /leagues/{id}/seasons` → seasons with `season_id`, `year`,
  `is_current`, and first/last match dates.
- `GET /seasons/{id}/matches` → matches with `match_id`, `match_date`
  (UTC string) + `date_unix`, `status` (`complete` when finished),
  `home_team`/`away_team` (`team_id`, `team_name`, `team_logo`),
  `score.home`/`score.away`, `game_week`.

### odds-api.io — odds

- Base `https://api.odds-api.io/v3`, key as `?apiKey=` query param.
  5000 req/hour.
- `GET /events/search?query=…&sport=football` and
  `GET /events?sport=football&league={slug}` → events with `id`, `home`,
  `away`, `date` (ISO), `status`.
- `GET /odds?eventId={id}&bookmakers=DraftKings,1xbet` → per-bookmaker
  market list; the `ML` market's first odds row is `{home, draw, away}`
  (decimal odds as strings). Exact bookmaker keys: `DraftKings`, `1xbet`.

## Data refresh strategy (requirement 3)

A scheduler tick runs in-process every 5 minutes:

1. **Daily sync** — if the last full sync was >24h ago: for each of the 5
   tournaments, resolve the season to show (see below) and fetch its
   matches (≈6 requests/day ≈ 180/month, inside the 1000/month cap).
2. **Post-match sync** — any match whose kickoff was more than 3h ago and
   whose status is not `complete` triggers ONE re-fetch of its league's
   season matches. Matches sharing a league+window are covered by the same
   fetch. Each match records `post_synced = 1` after the attempt so it is
   fetched only once; if the result still isn't in, the next daily sync
   picks it up.
3. **Bootstrap** — on first start with an empty DB, a full sync runs
   immediately.

Season selection: from `/leagues/{id}/seasons` pick the season marked
current whose date range contains today; if none contains today, the one
with the nearest upcoming `first_match_date`; else the most recently ended.
(The API sets `is_current` loosely on several seasons, so date ranges
decide.)

## Odds behaviour (requirements 4–5)

- Odds are fetched on demand when a user presses **Refresh odds** on a
  match page — never automatically.
- **5-minute lock:** the stored odds row keeps `fetched_at` and the
  username that pressed refresh. A refresh is rejected (HTTP 429 + stored
  odds returned) unless 5 minutes have passed since `fetched_at`. Everyone
  sees the same stored odds plus "updated N min ago by X".
- **Match alignment:** the two APIs have different IDs and team spellings.
  To find the odds-api event for a footballdata match: search odds-api by
  home-team name, then require BOTH normalized team names to match
  (lowercase, accents stripped, noise tokens like FC/CF/AFC removed,
  token-overlap comparison) AND kickoff times within ±3 hours. The matched
  `event_id` is cached on the odds row. If no confident match exists, the
  match shows "odds unavailable" (per requirement 5) — no wrong odds ever.
- Only the `ML` (match winner) market from `DraftKings` and `1xbet` is
  stored and displayed.

## Auth (requirement 2)

- Username + password, stored in SQLite. Passwords hashed with
  `crypto.scrypt` (built-in). Sessions are random tokens in an httpOnly
  cookie, stored server-side, 30-day expiry.
- The signup page carries the required notice: accounts are casual — do
  not reuse a password from anywhere else.

## Game rules

- A prediction is one of `home` / `draw` / `away`, editable until kickoff,
  locked at kickoff (server-enforced).
- Scoring: 1 point per correct outcome.
- Other users' picks for a match are hidden until kickoff, visible after.
- Rankings per tournament: total points desc, then accuracy desc, then
  username. History per user per tournament: every predicted match with
  pick, result, and points.

## Pages

1. **Login / Signup**
2. **Tournaments** — the 5 leagues with logos.
3. **Tournament view** — tabs: Fixtures (upcoming, with your pick badge),
   Results (finished), Rankings, My history.
4. **Match view** — teams, kickoff (local time), pick buttons before
   kickoff; odds panel (stored odds + refresh button honouring the lock);
   after the match: final score, your points, and everyone's picks.

## HTTP API (all JSON, under /api)

- `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/tournaments`
- `GET /api/tournaments/:leagueId/matches` — fixtures + results, with the
  caller's picks
- `GET /api/tournaments/:leagueId/rankings`
- `GET /api/tournaments/:leagueId/history` — caller's history
- `GET /api/matches/:matchId` — detail; includes all picks if kicked off
- `PUT /api/matches/:matchId/prediction` — body `{pick}`; 403 after kickoff
- `GET /api/matches/:matchId/odds` — stored odds
- `POST /api/matches/:matchId/odds/refresh` — honours 5-minute lock

## Error handling

- Upstream API failures never crash the app: syncs log and retry on the
  next tick; odds refresh returns the last stored odds with an error note.
- All /api routes return `{error}` JSON with proper status codes; the
  frontend surfaces them as toasts.

## Deployment (requirement 6)

- Repo pushed to GitHub without secrets. README explains: clone,
  `npm install`, copy `.env.example` → `.env`, paste keys, `npm start`.
- Works on any Node host with a persistent disk (Render, Railway, Fly, a
  home box). SQLite file lives in `data/`.

## Out of scope (YAGNI)

Live scores, live odds streams, other odds markets, password reset, email,
admin UI, multiple concurrent seasons per tournament.
