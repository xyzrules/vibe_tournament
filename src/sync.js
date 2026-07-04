// Keeps the local matches cache in step with footballdata.io while staying
// far under the 1000 requests/month budget:
//   - one full sync per 24h (leagues + seasons + matches ≈ 11 requests)
//   - one extra season re-fetch ~3h after a match should have finished,
//     at most once per match (post_synced flag)

const DAY = 86400;
const POST_MATCH_DELAY = 3 * 3600;

// footballdata dates look like "2026-08-21 19:00:00" (UTC).
function parseFdDate(s) {
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Pick which season of a league the site should show right now:
// the season whose window (with 3 days of slack) contains today, else the
// nearest upcoming one, else the most recently finished one.
function chooseSeason(seasons, nowUnix) {
  const usable = (seasons || [])
    .map((s) => ({
      season: s,
      first: s.summary ? parseFdDate(s.summary.first_match_date) : null,
      last: s.summary ? parseFdDate(s.summary.last_match_date) : null,
      count: s.summary ? s.summary.match_count : 0,
    }))
    .filter((s) => s.first != null && s.last != null && s.count > 0);
  if (!usable.length) return null;

  const active = usable.filter((s) => s.first - 3 * DAY <= nowUnix && nowUnix <= s.last + 3 * DAY);
  if (active.length) return active.sort((a, b) => b.first - a.first)[0].season;
  const future = usable.filter((s) => s.first > nowUnix);
  if (future.length) return future.sort((a, b) => a.first - b.first)[0].season;
  return usable.sort((a, b) => b.last - a.last)[0].season;
}

const MAX_PAGES = 10; // safety valve: 10 pages = 1000 matches per season

async function syncSeasonMatches(db, fd, leagueId, seasonId) {
  const matches = [];
  let page = 1;
  let totalPages = 1;
  do {
    const r = await fd.seasonMatchesPage(seasonId, page);
    matches.push(...r.matches);
    totalPages = Math.min(r.totalPages || 1, MAX_PAGES);
    page += 1;
  } while (page <= totalPages);
  const stmt = db.prepare(`
    INSERT INTO matches (match_id, league_id, season_id, kickoff_unix, status,
      home_team, away_team, home_logo, away_logo, home_score, away_score, game_week)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_id) DO UPDATE SET
      kickoff_unix = excluded.kickoff_unix,
      status = excluded.status,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      game_week = excluded.game_week
  `);
  for (const m of matches) {
    if (!m || m.match_id == null || !m.home_team || !m.away_team) continue;
    const kickoff = m.date_unix ?? parseFdDate(m.match_date);
    if (kickoff == null) continue;
    const complete = m.status === 'complete';
    stmt.run(
      m.match_id,
      leagueId,
      seasonId,
      kickoff,
      m.status ?? null,
      m.home_team.team_name,
      m.away_team.team_name,
      m.home_team.team_logo ?? null,
      m.away_team.team_logo ?? null,
      complete && m.score ? m.score.home : null,
      complete && m.score ? m.score.away : null,
      m.game_week ?? null
    );
  }
}

async function syncLeague(db, fd, leagueInfo, now) {
  const data = await fd.seasons(leagueInfo.league_id);
  const seasons = Array.isArray(data) ? data : (data && data.seasons) || [];
  const season = chooseSeason(seasons, now);
  if (!season) return;
  db.prepare(`
    INSERT INTO tournaments (league_id, name, country, image, season_id, season_year, last_synced)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(league_id) DO UPDATE SET
      name = excluded.name, country = excluded.country, image = excluded.image,
      season_id = excluded.season_id, season_year = excluded.season_year,
      last_synced = excluded.last_synced
  `).run(
    leagueInfo.league_id,
    leagueInfo.league_name,
    leagueInfo.country ?? null,
    leagueInfo.league_image ?? null,
    season.season_id,
    String(season.year),
    now
  );
  await syncSeasonMatches(db, fd, leagueInfo.league_id, season.season_id);
}

async function syncAll(db, fd, now) {
  const leagues = await fd.leagues();
  for (const lg of leagues || []) {
    try {
      await syncLeague(db, fd, lg, now);
    } catch (err) {
      console.error(`sync failed for league ${lg && lg.league_id}:`, err.message);
    }
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_full_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(now));
}

async function tick(db, fd, now = Math.floor(Date.now() / 1000)) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'last_full_sync'").get();
  const last = row ? Number(row.value) : null;
  if (last == null || now - last >= DAY) {
    await syncAll(db, fd, now);
  }

  // One-shot re-fetch for leagues with matches that should be finished.
  const due = db
    .prepare(`
      SELECT DISTINCT league_id FROM matches
      WHERE post_synced = 0
        AND COALESCE(status, '') != 'complete'
        AND kickoff_unix + ? <= ?
    `)
    .all(POST_MATCH_DELAY, now);
  for (const { league_id } of due) {
    const t = db.prepare('SELECT season_id FROM tournaments WHERE league_id = ?').get(league_id);
    if (!t || t.season_id == null) continue;
    try {
      await syncSeasonMatches(db, fd, league_id, t.season_id);
    } catch (err) {
      console.error(`post-match sync failed for league ${league_id}:`, err.message);
      continue; // keep post_synced = 0 so the next tick retries
    }
    db.prepare(`
      UPDATE matches SET post_synced = 1
      WHERE league_id = ? AND COALESCE(status, '') != 'complete' AND kickoff_unix + ? <= ?
    `).run(league_id, POST_MATCH_DELAY, now);
  }
}

module.exports = { parseFdDate, chooseSeason, syncSeasonMatches, syncLeague, syncAll, tick, DAY, POST_MATCH_DELAY };
