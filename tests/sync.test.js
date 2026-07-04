const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { parseFdDate, chooseSeason, syncAll, tick, DAY } = require('../src/sync');

const T = (s) => parseFdDate(s);
const NOW_MID_SEASON = T('2026-01-10 12:00:00');

function season(id, year, first, last, count = 10) {
  return {
    season_id: id,
    year,
    summary: { first_match_date: first, last_match_date: last, match_count: count },
  };
}

test('chooseSeason picks the season containing today', () => {
  const seasons = [
    season(2, 20262027, '2026-08-21 19:00:00', '2027-05-26 15:00:00'),
    season(1, 20252026, '2025-08-15 19:00:00', '2026-05-24 15:00:00'),
    season(0, 20242025, '2024-08-16 19:00:00', '2025-05-25 15:00:00'),
  ];
  assert.strictEqual(chooseSeason(seasons, NOW_MID_SEASON).season_id, 1);
});

test('chooseSeason between seasons prefers the nearest upcoming one', () => {
  const seasons = [
    season(2, 20262027, '2026-08-21 19:00:00', '2027-05-26 15:00:00'),
    season(1, 20252026, '2025-08-15 19:00:00', '2026-05-24 15:00:00'),
  ];
  assert.strictEqual(chooseSeason(seasons, T('2026-07-04 12:00:00')).season_id, 2);
});

test('chooseSeason falls back to most recent past season, skips empty seasons', () => {
  const seasons = [
    season(9, 2030, '2030-01-01 12:00:00', '2030-02-01 12:00:00', 0), // empty
    season(1, 2022, '2022-11-20 12:00:00', '2022-12-18 12:00:00'),
    season(2, 2026, '2026-06-11 12:00:00', '2026-07-19 12:00:00'),
  ];
  assert.strictEqual(chooseSeason(seasons, T('2027-01-01 00:00:00')).season_id, 2);
  assert.strictEqual(chooseSeason([], 0), null);
});

function fakeFd() {
  const fd = { requestCount: 0, calls: [] };
  fd.matchesBySeason = {
    100: [
      {
        match_id: 1,
        date_unix: NOW_MID_SEASON - 3600, // kicked off 1h ago; post-sync due at +3h
        status: 'incomplete',
        home_team: { team_id: 1, team_name: 'Canada', team_logo: 'c.png' },
        away_team: { team_id: 2, team_name: 'Morocco', team_logo: 'm.png' },
        score: null,
        game_week: 3,
      },
      {
        match_id: 2,
        date_unix: NOW_MID_SEASON + DAY,
        status: 'incomplete',
        home_team: { team_id: 3, team_name: 'France' },
        away_team: { team_id: 4, team_name: 'Brazil' },
        game_week: 3,
      },
    ],
  };
  fd.leagues = async () => {
    fd.requestCount++;
    fd.calls.push('leagues');
    return [{ league_id: 50, league_name: 'World Cup', country: 'International', league_image: 'wc.png' }];
  };
  fd.seasons = async (leagueId) => {
    fd.requestCount++;
    fd.calls.push(`seasons:${leagueId}`);
    return {
      seasons: [season(100, 2026, '2025-12-20 12:00:00', '2026-02-10 12:00:00')],
    };
  };
  fd.seasonMatchesPage = async (seasonId, page = 1) => {
    fd.requestCount++;
    fd.calls.push(`matches:${seasonId}:${page}`);
    const all = fd.matchesBySeason[seasonId] || [];
    const per = 100;
    return {
      matches: all.slice((page - 1) * per, page * per),
      totalPages: Math.max(1, Math.ceil(all.length / per)),
    };
  };
  return fd;
}

test('syncAll stores tournaments and matches', async () => {
  const db = createDb(':memory:');
  const fd = fakeFd();
  await syncAll(db, fd, NOW_MID_SEASON);
  const t = db.prepare('SELECT * FROM tournaments').get();
  assert.strictEqual(t.league_id, 50);
  assert.strictEqual(t.season_id, 100);
  const ms = db.prepare('SELECT * FROM matches ORDER BY match_id').all();
  assert.strictEqual(ms.length, 2);
  assert.strictEqual(ms[0].home_team, 'Canada');
  assert.strictEqual(ms[0].home_score, null); // not complete yet
});

test('syncAll fetches every page of a large season', async () => {
  const db = createDb(':memory:');
  const fd = fakeFd();
  fd.matchesBySeason[100] = Array.from({ length: 250 }, (_, i) => ({
    match_id: i + 1,
    date_unix: NOW_MID_SEASON + i * 3600,
    status: 'incomplete',
    home_team: { team_id: 1, team_name: `Home ${i}` },
    away_team: { team_id: 2, team_name: `Away ${i}` },
  }));
  await syncAll(db, fd, NOW_MID_SEASON);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 250);
  assert.strictEqual(fd.calls.filter((c) => c.startsWith('matches:100:')).length, 3); // 3 pages
});

test('tick runs the daily sync once per 24h', async () => {
  const db = createDb(':memory:');
  const fd = fakeFd();
  await tick(db, fd, NOW_MID_SEASON);
  const after = fd.requestCount;
  await tick(db, fd, NOW_MID_SEASON + 600); // 10 min later: no-op
  assert.strictEqual(fd.requestCount, after);
  await tick(db, fd, NOW_MID_SEASON + DAY + 1);
  assert.ok(fd.requestCount > after);
});

test('tick post-match sync fetches once and only once per match', async () => {
  const db = createDb(':memory:');
  const fd = fakeFd();
  const seasonFetches = () => fd.calls.filter((c) => c.startsWith('matches:100:')).length;
  await tick(db, fd, NOW_MID_SEASON); // daily sync seeds; match 1 not due yet
  assert.strictEqual(seasonFetches(), 1);
  await tick(db, fd, NOW_MID_SEASON + 3600); // still not due (kickoff + 3h in the future)
  assert.strictEqual(seasonFetches(), 1);
  // due now (kickoff was 1h before NOW, so due at NOW + 2h) → exactly one extra fetch
  await tick(db, fd, NOW_MID_SEASON + 2 * 3600 + 60);
  assert.strictEqual(seasonFetches(), 2);
  // still incomplete, but post_synced=1 now → no further fetches
  await tick(db, fd, NOW_MID_SEASON + 2 * 3600 + 120);
  assert.strictEqual(seasonFetches(), 2);
  assert.strictEqual(db.prepare('SELECT post_synced FROM matches WHERE match_id = 1').get().post_synced, 1);
});

test('post-match sync picks up final scores', async () => {
  const db = createDb(':memory:');
  const fd = fakeFd();
  await tick(db, fd, NOW_MID_SEASON); // seeds while match 1 is unfinished
  assert.strictEqual(db.prepare('SELECT status FROM matches WHERE match_id = 1').get().status, 'incomplete');
  fd.matchesBySeason[100][0].status = 'complete';
  fd.matchesBySeason[100][0].score = { home: 1, away: 3 };
  await tick(db, fd, NOW_MID_SEASON + 2 * 3600 + 60); // post-match one-shot picks it up
  const m = db.prepare('SELECT * FROM matches WHERE match_id = 1').get();
  assert.strictEqual(m.status, 'complete');
  assert.strictEqual(m.home_score, 1);
  assert.strictEqual(m.away_score, 3);
});
