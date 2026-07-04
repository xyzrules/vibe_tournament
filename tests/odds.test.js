const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { getOdds, refreshOdds, secondsUntilRefresh, LOCK_SECONDS } = require('../src/odds');

const KICKOFF = 1780000000;

function seedMatch(db) {
  db.prepare(`
    INSERT INTO matches (match_id, league_id, kickoff_unix, status, home_team, away_team)
    VALUES (10, 50, ?, 'incomplete', 'Canada', 'Morocco')
  `).run(KICKOFF);
}

function fakeOa({ events, payload, fail } = {}) {
  const oa = { requestCount: 0 };
  oa.searchEvents = async () => {
    oa.requestCount++;
    if (fail) throw new Error('boom');
    return events ?? [{ id: 777, home: 'Canada', away: 'Morocco', date: new Date(KICKOFF * 1000).toISOString() }];
  };
  oa.odds = async () => {
    oa.requestCount++;
    if (fail) throw new Error('boom');
    return (
      payload ?? {
        id: 777,
        bookmakers: {
          DraftKings: [{ name: 'ML', odds: [{ home: '5.4', draw: '3.5', away: '1.8' }] }],
          '1xbet': [
            { name: 'Double Chance', odds: [{ '1X': '2.0' }] },
            { name: 'ML', odds: [{ home: '5.42', draw: '3.51', away: '1.83' }] },
          ],
        },
      }
    );
  };
  return oa;
}

test('first refresh resolves the event, stores odds, records who pressed', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  const oa = fakeOa();
  const r = await refreshOdds(db, oa, 10, 'alice', KICKOFF - 5000);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.odds.event_id, 777);
  assert.strictEqual(r.odds.fetched_by, 'alice');
  assert.strictEqual(r.odds.dk_home, 5.4);
  assert.strictEqual(r.odds.xb_away, 1.83);
  assert.strictEqual(oa.requestCount, 2); // search + odds
});

test('second refresh within 5 minutes is locked and makes zero API calls', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  const oa = fakeOa();
  await refreshOdds(db, oa, 10, 'alice', 1000000);
  const calls = oa.requestCount;
  const r = await refreshOdds(db, oa, 10, 'bob', 1000000 + LOCK_SECONDS - 1);
  assert.strictEqual(r.status, 'locked');
  assert.strictEqual(r.odds.fetched_by, 'alice');
  assert.strictEqual(oa.requestCount, calls);
  assert.strictEqual(secondsUntilRefresh(r.odds, 1000000 + LOCK_SECONDS - 1), 1);
});

test('after the lock expires a refresh refetches (reusing cached event id)', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  const oa = fakeOa();
  await refreshOdds(db, oa, 10, 'alice', 1000000);
  const r = await refreshOdds(db, oa, 10, 'bob', 1000000 + LOCK_SECONDS);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.odds.fetched_by, 'bob');
  assert.strictEqual(oa.requestCount, 3); // search+odds, then odds only
});

test('no matching event → persisted no_match, still lock-limited', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  const oa = fakeOa({ events: [] });
  const r1 = await refreshOdds(db, oa, 10, 'alice', 1000000);
  assert.strictEqual(r1.status, 'no_match');
  assert.strictEqual(getOdds(db, 10).no_match, 1);
  const r2 = await refreshOdds(db, oa, 10, 'bob', 1000001);
  assert.strictEqual(r2.status, 'locked');
  assert.strictEqual(oa.requestCount, 1);
});

test('API failure preserves previously stored odds', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  await refreshOdds(db, fakeOa(), 10, 'alice', 1000000);
  const bad = fakeOa({ fail: true });
  const r = await refreshOdds(db, bad, 10, 'bob', 1000000 + LOCK_SECONDS + 1);
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.odds.dk_home, 5.4);
  assert.strictEqual(getOdds(db, 10).fetched_by, 'alice');
});

test('missing bookmaker leaves its columns null', async () => {
  const db = createDb(':memory:');
  seedMatch(db);
  const oa = fakeOa({
    payload: {
      id: 777,
      bookmakers: { DraftKings: [{ name: 'ML', odds: [{ home: '2.0', draw: '3.0', away: '4.0' }] }] },
    },
  });
  const r = await refreshOdds(db, oa, 10, 'alice', 1000000);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.odds.dk_home, 2.0);
  assert.strictEqual(r.odds.xb_home, null);
});

test('unknown match id', async () => {
  const db = createDb(':memory:');
  const r = await refreshOdds(db, fakeOa(), 999, 'alice', 1);
  assert.strictEqual(r.status, 'not_found');
});
