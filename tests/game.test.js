const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { winnerOf, setPrediction, listMatches, matchDetail, rankings, history } = require('../src/game');

function seed(db) {
  const addUser = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)');
  addUser.run(1, 'alice', 'x', 1);
  addUser.run(2, 'bob', 'x', 1);
  const addMatch = db.prepare(`
    INSERT INTO matches (match_id, league_id, kickoff_unix, status, home_team, away_team, home_score, away_score)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  addMatch.run(10, 50, 1000, 'complete', 'Canada', 'Morocco', 2, 1); // home won
  addMatch.run(11, 50, 2000, 'complete', 'France', 'Brazil', 0, 0); // draw
  addMatch.run(12, 50, 9000, 'incomplete', 'Spain', 'Ghana', null, null); // future
  addMatch.run(13, 99, 1000, 'complete', 'Lyon', 'Nice', 0, 1); // other league
}

test('winnerOf', () => {
  assert.strictEqual(winnerOf({ status: 'complete', home_score: 2, away_score: 1 }), 'home');
  assert.strictEqual(winnerOf({ status: 'complete', home_score: 0, away_score: 0 }), 'draw');
  assert.strictEqual(winnerOf({ status: 'complete', home_score: 0, away_score: 3 }), 'away');
  assert.strictEqual(winnerOf({ status: 'incomplete', home_score: 1, away_score: 0 }), null);
  assert.strictEqual(winnerOf({ status: 'complete', home_score: null, away_score: 0 }), null);
});

test('setPrediction enforces lock at kickoff and validates input', () => {
  const db = createDb(':memory:');
  seed(db);
  setPrediction(db, 1, 12, 'home', 8000);
  setPrediction(db, 1, 12, 'draw', 8500); // change of mind allowed pre-kickoff
  assert.strictEqual(db.prepare('SELECT pick FROM predictions WHERE user_id=1 AND match_id=12').get().pick, 'draw');
  assert.throws(() => setPrediction(db, 1, 12, 'home', 9000), /locked/); // exactly at kickoff
  assert.throws(() => setPrediction(db, 1, 12, 'banana', 8000), /bad pick/);
  assert.throws(() => setPrediction(db, 1, 999, 'home', 8000), /not found/);
});

test('matchDetail hides other picks before kickoff, shows them after', () => {
  const db = createDb(':memory:');
  seed(db);
  setPrediction(db, 1, 12, 'home', 8000);
  setPrediction(db, 2, 12, 'away', 8000);
  const before = matchDetail(db, 12, 1, 8500);
  assert.strictEqual(before.locked, false);
  assert.strictEqual(before.picks, undefined);
  assert.strictEqual(before.my_pick, 'home');
  const after = matchDetail(db, 12, 1, 9001);
  assert.strictEqual(after.locked, true);
  assert.deepStrictEqual(
    after.picks.map((p) => p.username),
    ['alice', 'bob']
  );
});

test('rankings: points, tiebreak by accuracy, then name; scoped to league', () => {
  const db = createDb(':memory:');
  seed(db);
  // alice: 2 predictions, 1 correct. bob: 1 prediction, 1 correct.
  db.prepare('INSERT INTO predictions VALUES (1, 10, ?, 1)').run('home'); // correct
  db.prepare('INSERT INTO predictions VALUES (1, 11, ?, 1)').run('home'); // wrong
  db.prepare('INSERT INTO predictions VALUES (2, 11, ?, 1)').run('draw'); // correct
  db.prepare('INSERT INTO predictions VALUES (2, 13, ?, 1)').run('away'); // other league, ignored
  const r = rankings(db, 50);
  assert.deepStrictEqual(
    r.map((x) => [x.username, x.points, x.predicted, x.correct]),
    [
      ['bob', 1, 1, 1], // same points, higher accuracy
      ['alice', 1, 2, 1],
    ]
  );
});

test('history returns predicted matches with points, unsettled as null', () => {
  const db = createDb(':memory:');
  seed(db);
  db.prepare('INSERT INTO predictions VALUES (1, 10, ?, 1)').run('away'); // wrong
  db.prepare('INSERT INTO predictions VALUES (1, 12, ?, 1)').run('home'); // future
  const h = history(db, 50, 1);
  assert.deepStrictEqual(
    h.map((x) => [x.match_id, x.points]),
    [
      [12, null],
      [10, 0],
    ]
  );
});

test('listMatches includes my pick and result', () => {
  const db = createDb(':memory:');
  seed(db);
  db.prepare('INSERT INTO predictions VALUES (1, 10, ?, 1)').run('home');
  const ms = listMatches(db, 50, 1);
  assert.strictEqual(ms.length, 3);
  assert.strictEqual(ms[0].my_pick, 'home');
  assert.strictEqual(ms[0].result, 'home');
  assert.strictEqual(ms[2].my_pick, null);
});
