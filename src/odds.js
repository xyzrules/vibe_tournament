// On-demand odds with a 5-minute lock: whoever presses "refresh" first sets
// the odds for everyone; further refreshes are rejected until the lock
// expires. Odds never auto-refresh.

const { findEvent } = require('./matching');

const LOCK_SECONDS = 300;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function getOdds(db, matchId) {
  return db.prepare('SELECT * FROM odds WHERE match_id = ?').get(matchId) || null;
}

function secondsUntilRefresh(odds, now) {
  if (!odds || odds.fetched_at == null) return 0;
  return Math.max(0, LOCK_SECONDS - (now - odds.fetched_at));
}

// Extract the moneyline (ML) odds for one bookmaker from an odds-api payload.
function extractMl(payload, bookmaker) {
  const markets = payload && payload.bookmakers && payload.bookmakers[bookmaker];
  if (!Array.isArray(markets)) return null;
  const ml = markets.find((m) => m && m.name === 'ML');
  const row = ml && Array.isArray(ml.odds) ? ml.odds[0] : null;
  if (!row) return null;
  return { home: num(row.home), draw: num(row.draw), away: num(row.away) };
}

async function refreshOdds(db, oa, matchId, username, now = Math.floor(Date.now() / 1000)) {
  const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
  if (!match) return { status: 'not_found', odds: null };

  const existing = getOdds(db, matchId);
  if (existing && secondsUntilRefresh(existing, now) > 0) {
    return { status: 'locked', odds: existing };
  }

  try {
    let eventId = existing ? existing.event_id : null;
    if (eventId == null) {
      const events = await oa.searchEvents(match.home_team);
      const ev = findEvent(match, events);
      if (!ev) {
        // Remember the failed lookup (with timestamp, so retries also honour
        // the 5-minute lock) — the event may appear later.
        db.prepare(`
          INSERT INTO odds (match_id, fetched_at, fetched_by, no_match) VALUES (?,?,?,1)
          ON CONFLICT(match_id) DO UPDATE SET
            fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by, no_match = 1
        `).run(matchId, now, username);
        return { status: 'no_match', odds: getOdds(db, matchId) };
      }
      eventId = ev.id;
    }

    const payload = await oa.odds(eventId);
    const dk = extractMl(payload, 'DraftKings');
    const xb = extractMl(payload, '1xbet');
    db.prepare(`
      INSERT INTO odds (match_id, event_id, fetched_at, fetched_by, no_match,
        dk_home, dk_draw, dk_away, xb_home, xb_draw, xb_away)
      VALUES (?,?,?,?,0,?,?,?,?,?,?)
      ON CONFLICT(match_id) DO UPDATE SET
        event_id = excluded.event_id, fetched_at = excluded.fetched_at,
        fetched_by = excluded.fetched_by, no_match = 0,
        dk_home = excluded.dk_home, dk_draw = excluded.dk_draw, dk_away = excluded.dk_away,
        xb_home = excluded.xb_home, xb_draw = excluded.xb_draw, xb_away = excluded.xb_away
    `).run(
      matchId,
      eventId,
      now,
      username,
      dk ? dk.home : null, dk ? dk.draw : null, dk ? dk.away : null,
      xb ? xb.home : null, xb ? xb.draw : null, xb ? xb.away : null
    );
    return { status: 'ok', odds: getOdds(db, matchId) };
  } catch (err) {
    return { status: 'error', error: err.message, odds: existing };
  }
}

module.exports = { getOdds, refreshOdds, secondsUntilRefresh, extractMl, LOCK_SECONDS };
