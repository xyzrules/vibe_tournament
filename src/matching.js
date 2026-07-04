// Aligns footballdata.io matches with odds-api.io events. The two services
// spell team names differently ("Sunderland AFC" vs "Sunderland"), so we
// compare normalized token sets and require kickoff times to be close.

const NOISE_TOKENS = new Set(['fc', 'afc', 'cf', 'cfc', 'sc', 'ac', 'club', 'cd', 'if', 'bk', 'sk']);
const ALIASES = new Map([
  ['utd', 'united'],
  ['man', 'manchester'],
]);

function normalizeTeam(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents left by NFD
    .replace(/[^a-z0-9 ]+/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ALIASES.get(t) || t)
    .filter((t) => !NOISE_TOKENS.has(t));
  return [...new Set(tokens)].sort().join(' ');
}

function teamsMatch(a, b) {
  const ta = new Set(normalizeTeam(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTeam(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return false;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  if (inter === 0) return false;
  if (inter === ta.size || inter === tb.size) return true; // one contains the other
  const union = new Set([...ta, ...tb]).size;
  return inter / union >= 0.6;
}

// match: row from our matches table ({home_team, away_team, kickoff_unix}).
// events: array of odds-api events ({id, home, away, date}).
// Returns the single confident candidate, or null (none found OR ambiguous).
function findEvent(match, events, toleranceSec = 3 * 3600) {
  const candidates = (events || []).filter((ev) => {
    const evTime = Math.floor(new Date(ev.date).getTime() / 1000);
    if (!Number.isFinite(evTime)) return false;
    return (
      Math.abs(evTime - match.kickoff_unix) <= toleranceSec &&
      teamsMatch(match.home_team, ev.home) &&
      teamsMatch(match.away_team, ev.away)
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = { normalizeTeam, teamsMatch, findEvent };
