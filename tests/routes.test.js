const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { createAppServer } = require('../src/routes');

const KICKOFF = 2000000;

function setup(t, { now = 1000000 } = {}) {
  const db = createDb(':memory:');
  db.prepare(`
    INSERT INTO tournaments (league_id, name, country, season_id, season_year)
    VALUES (50, 'World Cup', 'International', 618, '2026')
  `).run();
  db.prepare(`
    INSERT INTO matches (match_id, league_id, kickoff_unix, status, home_team, away_team)
    VALUES (10, 50, ?, 'incomplete', 'Canada', 'Morocco')
  `).run(KICKOFF);

  const oa = {
    requestCount: 0,
    searchEvents: async () => {
      oa.requestCount++;
      return [{ id: 777, home: 'Canada', away: 'Morocco', date: new Date(KICKOFF * 1000).toISOString() }];
    },
    odds: async () => {
      oa.requestCount++;
      return { bookmakers: { DraftKings: [{ name: 'ML', odds: [{ home: '2', draw: '3', away: '4' }] }] } };
    },
  };

  const clock = { now };
  const server = createAppServer({ db, oa, publicDir: __dirname, nowFn: () => clock.now });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(() => server.close());
      resolve({ db, oa, clock, base });
    });
  });
}

async function api(base, method, pathname, { body, cookie } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, body: await res.json(), setCookie };
}

function sidFrom(setCookie) {
  const c = (setCookie || []).find((x) => x.startsWith('sid='));
  return c ? c.split(';')[0] : null;
}

test('signup sets session cookie; /api/me works with it', async (t) => {
  const { base } = await setup(t);
  const r = await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  assert.strictEqual(r.status, 200);
  const sid = sidFrom(r.setCookie);
  assert.ok(sid, 'session cookie set');
  const me = await api(base, 'GET', '/api/me', { cookie: sid });
  assert.strictEqual(me.body.user.username, 'alice');
});

test('duplicate signup → 409, bad login → 401, protected route → 401', async (t) => {
  const { base } = await setup(t);
  await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  const dup = await api(base, 'POST', '/api/signup', { body: { username: 'ALICE', password: 'pass1234' } });
  assert.strictEqual(dup.status, 409);
  const bad = await api(base, 'POST', '/api/login', { body: { username: 'alice', password: 'nope' } });
  assert.strictEqual(bad.status, 401);
  const anon = await api(base, 'GET', '/api/tournaments/50/matches');
  assert.strictEqual(anon.status, 401);
});

test('prediction flow: set, change, locked after kickoff', async (t) => {
  const { base, clock } = await setup(t);
  const s = await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  const sid = sidFrom(s.setCookie);

  const put = await api(base, 'PUT', '/api/matches/10/prediction', { body: { pick: 'home' }, cookie: sid });
  assert.strictEqual(put.status, 200);

  const list = await api(base, 'GET', '/api/tournaments/50/matches', { cookie: sid });
  assert.strictEqual(list.body.matches[0].my_pick, 'home');

  clock.now = KICKOFF; // kickoff reached
  const late = await api(base, 'PUT', '/api/matches/10/prediction', { body: { pick: 'away' }, cookie: sid });
  assert.strictEqual(late.status, 403);

  const bad = await api(base, 'PUT', '/api/matches/10/prediction', { body: { pick: 'banana' }, cookie: sid });
  assert.strictEqual(bad.status, 400);
});

test('odds refresh honours the 5-minute lock over HTTP', async (t) => {
  const { base, clock, oa } = await setup(t);
  const s = await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  const sid = sidFrom(s.setCookie);

  const r1 = await api(base, 'POST', '/api/matches/10/odds/refresh', { cookie: sid });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.status, 'ok');
  assert.strictEqual(r1.body.odds.dk_home, 2);

  clock.now += 60;
  const r2 = await api(base, 'POST', '/api/matches/10/odds/refresh', { cookie: sid });
  assert.strictEqual(r2.status, 429);
  assert.strictEqual(r2.body.status, 'locked');
  assert.strictEqual(r2.body.odds_refresh_in, 240);
  assert.strictEqual(oa.requestCount, 2);

  const g = await api(base, 'GET', '/api/matches/10/odds', { cookie: sid });
  assert.strictEqual(g.body.odds.fetched_by, 'alice');
});

test('tournaments list is public; match detail requires auth and includes odds', async (t) => {
  const { base } = await setup(t);
  const lt = await api(base, 'GET', '/api/tournaments');
  assert.strictEqual(lt.status, 200);
  assert.strictEqual(lt.body.tournaments[0].name, 'World Cup');
  assert.strictEqual(lt.body.tournaments[0].match_count, 1);

  const s = await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  const d = await api(base, 'GET', '/api/matches/10', { cookie: sidFrom(s.setCookie) });
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.match.home_team, 'Canada');
  assert.strictEqual(d.body.odds, null);
  const missing = await api(base, 'GET', '/api/matches/404404', { cookie: sidFrom(s.setCookie) });
  assert.strictEqual(missing.status, 404);
});

test('logout clears the session', async (t) => {
  const { base } = await setup(t);
  const s = await api(base, 'POST', '/api/signup', { body: { username: 'alice', password: 'pass1234' } });
  const sid = sidFrom(s.setCookie);
  await api(base, 'POST', '/api/logout', { cookie: sid });
  const me = await api(base, 'GET', '/api/me', { cookie: sid });
  assert.strictEqual(me.status, 401);
});
