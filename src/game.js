// Prediction rules, scoring, rankings and history.
// Scoring: 1 point per correct outcome (home/draw/away).

const PICKS = new Set(['home', 'draw', 'away']);

function winnerOf(match) {
  if (!match || match.status !== 'complete') return null;
  if (match.home_score == null || match.away_score == null) return null;
  if (match.home_score > match.away_score) return 'home';
  if (match.home_score < match.away_score) return 'away';
  return 'draw';
}

function setPrediction(db, userId, matchId, pick, now = Math.floor(Date.now() / 1000)) {
  if (!PICKS.has(pick)) throw new Error('bad pick');
  const match = db.prepare('SELECT match_id, kickoff_unix FROM matches WHERE match_id = ?').get(matchId);
  if (!match) throw new Error('not found');
  if (now >= match.kickoff_unix) throw new Error('match locked');
  db.prepare(`
    INSERT INTO predictions (user_id, match_id, pick, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET pick = excluded.pick, updated_at = excluded.updated_at
  `).run(userId, matchId, pick, now);
}

function listMatches(db, leagueId, userId) {
  return db
    .prepare(`
      SELECT m.*, p.pick AS my_pick FROM matches m
      LEFT JOIN predictions p ON p.match_id = m.match_id AND p.user_id = ?
      WHERE m.league_id = ? ORDER BY m.kickoff_unix, m.match_id
    `)
    .all(userId, leagueId)
    .map((m) => ({ ...m, result: winnerOf(m) }));
}

// Other users' picks stay hidden until kickoff.
function matchDetail(db, matchId, userId, now = Math.floor(Date.now() / 1000)) {
  const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
  if (!match) return null;
  const mine = db
    .prepare('SELECT pick FROM predictions WHERE user_id = ? AND match_id = ?')
    .get(userId, matchId);
  const result = winnerOf(match);
  const detail = {
    ...match,
    my_pick: mine ? mine.pick : null,
    result,
    locked: now >= match.kickoff_unix,
  };
  if (detail.locked) {
    detail.picks = db
      .prepare(`
        SELECT u.username, p.pick FROM predictions p
        JOIN users u ON u.id = p.user_id
        WHERE p.match_id = ? ORDER BY u.username COLLATE NOCASE
      `)
      .all(matchId)
      .map((r) => ({ ...r, correct: result ? r.pick === result : null }));
  }
  return detail;
}

function rankings(db, leagueId) {
  const rows = db
    .prepare(`
      SELECT u.username, p.pick, m.status, m.home_score, m.away_score
      FROM predictions p
      JOIN users u ON u.id = p.user_id
      JOIN matches m ON m.match_id = p.match_id
      WHERE m.league_id = ?
    `)
    .all(leagueId);
  const byUser = new Map();
  for (const r of rows) {
    const e = byUser.get(r.username) || { username: r.username, points: 0, predicted: 0, correct: 0 };
    const result = winnerOf(r);
    if (result) {
      e.predicted += 1;
      if (r.pick === result) {
        e.correct += 1;
        e.points += 1;
      }
    }
    byUser.set(r.username, e);
  }
  const acc = (e) => (e.predicted ? e.correct / e.predicted : 0);
  return [...byUser.values()].sort(
    (a, b) => b.points - a.points || acc(b) - acc(a) || a.username.localeCompare(b.username)
  );
}

function history(db, leagueId, userId) {
  return db
    .prepare(`
      SELECT m.*, p.pick AS my_pick FROM predictions p
      JOIN matches m ON m.match_id = p.match_id
      WHERE p.user_id = ? AND m.league_id = ?
      ORDER BY m.kickoff_unix DESC, m.match_id DESC
    `)
    .all(userId, leagueId)
    .map((m) => {
      const result = winnerOf(m);
      return { ...m, result, points: result ? (m.my_pick === result ? 1 : 0) : null };
    });
}

module.exports = { winnerOf, setPrediction, listMatches, matchDetail, rankings, history };
