# Match Prediction Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/Express + SQLite site where friends predict soccer results per tournament, with real fixtures from footballdata.io and DraftKings/1xbet odds from odds-api.io.

**Architecture:** Single Express process serving a static vanilla-JS frontend and a JSON API. SQLite (better-sqlite3) holds users, sessions, cached matches, predictions, and odds. An in-process scheduler tick (every 5 min) performs the daily sync and one-shot post-match syncs. Odds are fetched only on user demand behind a 5-minute lock.

**Tech Stack:** Node 18+ (native fetch), express, better-sqlite3, cookie-parser, dotenv, node:test.

## Global Constraints

- Secrets only via `.env` (`FOOTBALLDATA_API_KEY`, `ODDS_API_KEY`, optional `PORT` default 3000). `.env`, `source.txt`, `data/` are gitignored.
- footballdata.io: base `https://footballdata.io/api/v1`, header `Authorization: Bearer <key>`, budget ≤1000 req/month → only scheduler calls it.
- odds-api.io: base `https://api.odds-api.io/v3`, `?apiKey=` query param; bookmakers exactly `DraftKings` and `1xbet`; only the `ML` market is used.
- All timestamps stored as unix seconds UTC; frontend renders local time.
- Predictions: `home` | `draw` | `away`, rejected server-side at/after kickoff. 1 point per correct pick.
- Other users' picks hidden until kickoff.
- Tests: `node --test tests/` with in-memory SQLite; no network in tests.

## File Structure

```
package.json          deps + scripts (start, test)
server.js             entry: load config, open DB, mount routes, start scheduler + listen
src/config.js         env loading/validation
src/db.js             createDb(path) -> better-sqlite3 handle with schema applied
src/footballdata.js   fdLeagues(), fdSeasons(leagueId), fdSeasonMatches(seasonId)
src/oddsapi.js        oaSearchEvents(query), oaOdds(eventId)
src/matching.js       normalizeTeam(name), teamsMatch(a,b), findEvent(match, events)
src/sync.js           chooseSeason(seasons, now), syncAll(db, api, now), tick(db, api, now)
src/game.js           winnerOf(match), upsertPrediction(...), matchDetail(...), rankings(...), history(...)
src/odds.js           getOdds(db, matchId), refreshOdds(db, api, matchId, userId, now) with 5-min lock
src/auth.js           signup(...), login(...), logout(...), requireUser middleware
src/routes.js         buildRouter(db, deps) wiring the HTTP API
public/index.html     SPA shell
public/app.js         hash router + views
public/style.css      styling
tests/*.test.js       one file per src module (matching, sync, game, odds, auth, routes)
```

---

### Task 1: Scaffold + config + DB schema

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `.env`, `src/config.js`, `src/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Produces: `createDb(path)` → better-sqlite3 Database with tables: `users(id, username UNIQUE COLLATE NOCASE, password_hash, created_at)`, `sessions(token PK, user_id, expires_at)`, `tournaments(league_id PK, name, country, image, season_id, season_year)`, `matches(match_id PK, league_id, season_id, kickoff_unix, status, home_team, away_team, home_logo, away_logo, home_score, away_score, game_week, post_synced DEFAULT 0)`, `predictions(user_id, match_id, pick, updated_at, PK(user_id,match_id))`, `odds(match_id PK, event_id, fetched_at, fetched_by, dk_home, dk_draw, dk_away, xb_home, xb_draw, xb_away, no_match DEFAULT 0)`, `meta(key PK, value)`.
- Produces: `config` object `{fdKey, oaKey, port}`; throws if keys missing.

- [ ] Step 1: `npm init -y`; install `express better-sqlite3 cookie-parser dotenv`; set `"scripts": {"start":"node server.js","test":"node --test tests/"}`.
- [ ] Step 2: `.gitignore` with `node_modules/`, `.env`, `data/`, `source.txt`. `.env.example` with both key names blank. `.env` with the real keys from `source.txt`.
- [ ] Step 3: Failing test `tests/db.test.js`: `createDb(':memory:')` allows inserting a user and rejects a duplicate username differing only by case.
- [ ] Step 4: Implement `src/db.js` (schema via `exec`, WAL for file DBs) and `src/config.js`. Run `node --test tests/` → PASS.

### Task 2: Team matching (`src/matching.js`)

**Files:** Create `src/matching.js`; Test `tests/matching.test.js`.

**Interfaces:**
- Produces: `normalizeTeam(name)` → canonical token string (lowercase, accents stripped, punctuation removed, noise tokens `fc afc cf sc ac club cd deportivo real?` NO — keep `real`; drop only generic suffixes `fc afc cf sc ac cfc club utd->united`).
- Produces: `teamsMatch(a, b)` → boolean (exact normalized equality OR one token-set contains the other OR Jaccard overlap ≥ 0.6).
- Produces: `findEvent(match, events, toleranceSec=10800)` → the single event where `teamsMatch(home,home) && teamsMatch(away,away)` and `|event.date - kickoff| ≤ tolerance`, else `null` (also `null` on ambiguity).

- [ ] Step 1: Failing tests: `normalizeTeam('Tottenham Hotspur FC') === 'hotspur tottenham'`-style canonicalization; `teamsMatch('Man City','Manchester City')` true via token containment is NOT required — use realistic pairs: `('Atlético Madrid','Atletico Madrid')` true, `('Manchester City','Manchester United')` false, `('Sunderland AFC','Sunderland')` true; `findEvent` picks the right event by teams+time, returns null when times differ by >3h or both events match.
- [ ] Step 2: Implement; run tests → PASS.

### Task 3: API clients (`src/footballdata.js`, `src/oddsapi.js`)

**Files:** Create both; Test `tests/clients.test.js` (inject a fake `fetchFn`).

**Interfaces:**
- Produces: `makeFdClient({key, fetchFn})` → `{leagues(), seasons(leagueId), seasonMatches(seasonId)}` returning the `data` payloads; throws `Error('fd <status>')` on non-200 or `success:false`.
- Produces: `makeOaClient({key, fetchFn})` → `{searchEvents(query)}` (GET `/events/search?query=&sport=football`), `{odds(eventId)}` (GET `/odds?eventId=&bookmakers=DraftKings,1xbet`). `odds()` returns the raw JSON object.
- Both clients count requests (`client.requestCount`) for observability.

- [ ] Step 1: Failing tests with fake fetch asserting URL + auth header/param construction and error propagation.
- [ ] Step 2: Implement; tests PASS.

### Task 4: Sync engine (`src/sync.js`)

**Files:** Create `src/sync.js`; Test `tests/sync.test.js` (fake fd client, in-memory DB, fixed `now`).

**Interfaces:**
- Consumes: `createDb`, fd client from Task 3.
- Produces: `chooseSeason(seasons, nowUnix)` → season whose `[first_match_date, last_match_date+3d]` contains now; else nearest future; else most recent past.
- Produces: `syncLeague(db, fd, leagueId, now)` → picks season, upserts tournament + all matches (maps `status==='complete'` → scores stored, else null scores).
- Produces: `syncAll(db, fd, now)` → syncs the 5 free leagues from `/leagues`; sets `meta.last_full_sync`.
- Produces: `tick(db, fd, now)` → runs `syncAll` if `last_full_sync` older than 24h; then for any league having matches with `kickoff+10800 < now AND status != 'complete' AND post_synced=0`, re-runs `syncLeague` once and marks those matches `post_synced=1`.

- [ ] Step 1: Failing tests: season selection (mid-season, between-seasons, pre-season cases); daily gating (tick twice, second no-op); post-match one-shot (unfinished match 3h old triggers exactly one league refetch, and only once).
- [ ] Step 2: Implement; tests PASS.

### Task 5: Auth (`src/auth.js`)

**Files:** Create `src/auth.js`; Test `tests/auth.test.js`.

**Interfaces:**
- Produces: `signup(db, username, password)` → `{token, user}`; validates username `/^[a-zA-Z0-9_]{3,20}$/`, password ≥ 4 chars; scrypt hash `salt:hex`. Duplicate → `Error('username taken')`.
- Produces: `login(db, username, password)` → `{token, user}` or `Error('invalid credentials')` (timing-safe compare).
- Produces: `logout(db, token)`; `userForToken(db, token)` → user row or null (checks expiry, 30 days).

- [ ] Step 1: Failing tests: signup+login round-trip, wrong password rejected, duplicate rejected, expired session null.
- [ ] Step 2: Implement with `node:crypto` scrypt; tests PASS.

### Task 6: Game logic (`src/game.js`)

**Files:** Create `src/game.js`; Test `tests/game.test.js`.

**Interfaces:**
- Produces: `winnerOf(match)` → `'home'|'draw'|'away'|null` (null unless `status==='complete'` and scores present).
- Produces: `setPrediction(db, userId, matchId, pick, now)` → upserts; throws `Error('match locked')` if `now >= kickoff_unix`; `Error('bad pick')` on invalid value; `Error('not found')`.
- Produces: `listMatches(db, leagueId, userId)` → matches ordered by kickoff with `my_pick`.
- Produces: `matchDetail(db, matchId, userId, now)` → match + `my_pick` + (if `now >= kickoff`) `picks: [{username, pick, correct}]`.
- Produces: `rankings(db, leagueId)` → `[{username, points, predicted, correct}]` sorted points desc, accuracy desc, username asc.
- Produces: `history(db, leagueId, userId)` → finished predicted matches with pick/result/points.

- [ ] Step 1: Failing tests: lock at exact kickoff; pick change before kickoff allowed; picks hidden pre-kickoff / shown after; rankings order incl. tiebreaks; history points.
- [ ] Step 2: Implement; tests PASS.

### Task 7: Odds with 5-minute lock (`src/odds.js`)

**Files:** Create `src/odds.js`; Test `tests/odds.test.js` (fake oa client).

**Interfaces:**
- Consumes: `findEvent` (Task 2), oa client (Task 3).
- Produces: `getOdds(db, matchId)` → stored row or null.
- Produces: `refreshOdds(db, oa, matchId, username, now)` → `{status:'ok'|'locked'|'no_match'|'error', odds}`. Rules: if a row exists and `now - fetched_at < 300` → `locked` with stored odds (no API call). Otherwise: resolve `event_id` (stored one, else `searchEvents(home_team)` + `findEvent`); if none → persist `no_match=1` row (fetched_at=now so retries also honour the lock) → `no_match`. Else call `odds(eventId)`, extract each bookmaker's `ML` market first row (`home,draw,away` parsed as floats), store with `fetched_at=now, fetched_by=username`. Missing bookmaker → its columns null. Upstream throw → `error` + previous odds preserved.

- [ ] Step 1: Failing tests: first refresh stores + returns ok; second within 300s → `locked`, zero API calls (assert `requestCount` unchanged); after 300s refetches; unmatched match → `no_match` persisted; API error keeps old odds.
- [ ] Step 2: Implement; tests PASS.

### Task 8: HTTP routes (`src/routes.js`, `server.js`)

**Files:** Create `src/routes.js`, `server.js`; Test `tests/routes.test.js` (supertest-style via `fetch` against an ephemeral listener, fake clients).

**Interfaces:**
- Consumes: everything above.
- Produces: JSON API per spec: `POST /api/signup|login|logout`, `GET /api/me`, `GET /api/tournaments`, `GET /api/tournaments/:id/matches|rankings|history`, `GET /api/matches/:id`, `PUT /api/matches/:id/prediction`, `GET /api/matches/:id/odds`, `POST /api/matches/:id/odds/refresh`. Session cookie `sid` httpOnly SameSite=Lax. Errors as `{error}` + status (401 unauth, 403 locked match, 429 odds lock, 404, 400). Static `public/` served; `server.js` runs `tick` on boot (async, non-fatal) and `setInterval(tick, 5min)`.

- [ ] Step 1: Failing route tests: signup sets cookie; unauth’d prediction → 401; prediction after kickoff → 403; odds refresh honours 429; tournaments list round-trip.
- [ ] Step 2: Implement; tests PASS. `npm test` fully green.

### Task 9: Frontend (`public/`)

**Files:** Create `public/index.html`, `public/app.js`, `public/style.css`.

**Interfaces:** Consumes the JSON API exactly as produced in Task 8.

- [ ] Step 1: Hash-routed views: `#/login` (login+signup with the casual-password notice), `#/` tournaments grid, `#/t/:id` tabs Fixtures/Results/Rankings/History, `#/m/:id` match page (pick buttons pre-kickoff with selected state; odds panel showing DK + 1xbet ML odds, "updated X min ago by Y", refresh button disabled while locked with countdown; post-match: score, everyone's picks, correct highlighted).
- [ ] Step 2: Manual verify against live server with real keys: browse WC 2026, place a pick on a pending match, refresh odds twice (second must report the lock), check rankings/history render.

### Task 10: README + verification

**Files:** Create `README.md`.

- [ ] Step 1: README: what it is, screenshots optional, setup (clone → `npm i` → copy `.env.example`→`.env` + keys → `npm start`), deploy notes (Render/Railway/Fly need a persistent disk for `data/`; keys as env vars), scoring rules, API-budget note.
- [ ] Step 2: Full `npm test` + live smoke test (signup → predict → odds → history). Fix anything found.
