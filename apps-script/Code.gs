/**
 * Kèo máu — Google Apps Script backend.
 *
 * Lives inside a private Google Sheet (Extensions → Apps Script). The sheet
 * is the database; this script is the API server + fixture sync scheduler.
 * The website (static, on GitHub Pages) talks to this script's Web App URL.
 *
 * SETUP (see README.md in the repo for the full walkthrough):
 *  1. Create a blank Google Sheet (keep it private — only you).
 *  2. Extensions → Apps Script, replace the default code with this file.
 *  3. Project Settings → Script Properties → add:
 *       FOOTBALLDATA_API_KEY = your footballdata.io key
 *       ODDS_API_KEY         = your odds-api.io key
 *  4. In the editor, run the `setup` function once and grant permissions.
 *  5. Deploy → New deployment → Web app (Execute as: Me · Access: Anyone).
 *     Copy the Web App URL into docs/config.js of the website repo.
 *
 * UPDATING an existing deployment: paste the new code, run `setup` once
 * (adds any new columns / the admin account), then Deploy → Manage
 * deployments → ✏ → Version: New version. The URL stays the same.
 *
 * ADMIN: a user `admin` (password `admin`) is created automatically and
 * gets the Admin page on the site: show/hide tournaments and matches, set
 * the guess mode per tournament (1x2 / win-loss / handicap — in 1x2
 * tournaments knockout rounds automatically switch to win/loss, since
 * someone always advances), points per match and per round, force an
 * immediate fixtures/results sync, and link the betting event by hand when
 * the odds service can't find the match.
 * CHANGE THE ADMIN PASSWORD after first login by editing the Users tab
 * (or just keep the sheet private and trust friends).
 */

// ---------------------------------------------------------------------------
// Constants & sheet layout
// ---------------------------------------------------------------------------

var FD_BASE = 'https://footballdata.io/api/v1';
var OA_BASE = 'https://api.odds-api.io/v3';
var ODDS_LOCK_SECONDS = 300;      // 5-minute shared odds lock
var POST_MATCH_DELAY = 3 * 3600;  // re-fetch results ~3h after kickoff
var DAY = 86400;
var SESSION_TTL = 30 * DAY;
var MAX_PAGES = 10;
var ENRICH_PER_TICK = 8;          // max penalty lookups per tick
var GUESS_MODES = ['1x2', 'wl', 'handicap'];

var TABS = {
  Users: ['username', 'salt', 'hash', 'created_at'],
  Sessions: ['token', 'username', 'expires_at'],
  Tournaments: ['league_id', 'name', 'country', 'image', 'season_id', 'season_year', 'last_synced',
                'visible', 'guess_mode', 'default_points', 'round_points'],
  Matches: ['match_id', 'league_id', 'season_id', 'kickoff_unix', 'status', 'home_team', 'away_team',
            'home_logo', 'away_logo', 'home_score', 'away_score', 'game_week', 'post_synced',
            'round_id', 'pen_home', 'pen_away', 'adv_winner', 'aet', 'hidden', 'hdp'],
  Predictions: ['username', 'match_id', 'pick', 'updated_at', 'hdp', 'mode'],
  Odds: ['match_id', 'event_id', 'fetched_at', 'fetched_by', 'no_match',
         'dk_home', 'dk_draw', 'dk_away', 'xb_home', 'xb_draw', 'xb_away'],
  Meta: ['key', 'value'],
};

// Fields the admin edits / enrichment fills — preserved across fixture syncs.
var MATCH_KEEP_FIELDS = ['post_synced', 'pen_home', 'pen_away', 'adv_winner', 'aet', 'hidden', 'hdp'];

// ---------------------------------------------------------------------------
// One-time setup + triggers
// ---------------------------------------------------------------------------

function setup() {
  ensureTabs_();
  ensureAdmin_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyHours(1).create();
  tick();
}

function ensureTabs_() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = TABS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > Object.keys(TABS).length) ss.deleteSheet(def);
}

function ensureAdmin_() {
  var exists = readTab_('Users').some(function (u) {
    return String(u.username).toLowerCase() === 'admin';
  });
  if (!exists) {
    var salt = Utilities.getUuid();
    appendRow_('Users', { username: 'admin', salt: salt, hash: hashPassword_('admin', salt), created_at: now_() });
  }
}

// ---------------------------------------------------------------------------
// Tiny "ORM": each tab read as an array of objects, written back in batch
// ---------------------------------------------------------------------------

function readTab_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  var values = sheet.getDataRange().getValues();
  var headers = TABS[name];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === '' && values[i][1] === '') continue;
    var obj = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j] === '' ? null : values[i][j];
    rows.push(obj);
  }
  return rows;
}

function appendRow_(name, obj) {
  var headers = TABS[name];
  SpreadsheetApp.getActive().getSheetByName(name).appendRow(
    headers.map(function (h) { return obj[h] == null ? '' : obj[h]; })
  );
}

function updateRow_(name, rowNumber, obj) {
  var headers = TABS[name];
  SpreadsheetApp.getActive().getSheetByName(name)
    .getRange(rowNumber, 1, 1, headers.length)
    .setValues([headers.map(function (h) { return obj[h] == null ? '' : obj[h]; })]);
}

function replaceTab_(name, objects) {
  var headers = TABS[name];
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  var data = objects.map(function (o) {
    return headers.map(function (h) { return o[h] == null ? '' : o[h]; });
  });
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  if (data.length) sheet.getRange(2, 1, data.length, headers.length).setValues(data);
}

function metaGet_(key) {
  var row = readTab_('Meta').filter(function (r) { return r.key === key; })[0];
  return row ? row.value : null;
}

function metaSet_(key, value) {
  var row = readTab_('Meta').filter(function (r) { return r.key === key; })[0];
  if (row) updateRow_('Meta', row._row, { key: key, value: value });
  else appendRow_('Meta', { key: key, value: value });
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, service: 'keo-mau' });
}

// All API calls are POSTs with a text/plain JSON body: {action, token, ...}
// (text/plain avoids browser CORS preflight, which Apps Script can't answer).
// Errors come back as {error, code} — HTTP status is always 200 here.
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'invalid JSON body', code: 400 });
  }
  var actions = {
    signup: apiSignup_, login: apiLogin_, logout: apiLogout_, me: apiMe_,
    tournaments: apiTournaments_, matches: apiMatches_, rankings: apiRankings_,
    history: apiHistory_, match: apiMatchDetail_, predict: apiPredict_,
    odds_refresh: apiOddsRefresh_,
    admin_overview: apiAdminOverview_, admin_tournament: apiAdminTournament_,
    admin_match: apiAdminMatch_, admin_sync: apiAdminSync_,
    admin_odds_search: apiAdminOddsSearch_, admin_odds_link: apiAdminOddsLink_,
    admin_usage: apiAdminUsage_,
  };
  var handler = actions[body.action];
  if (!handler) return json_({ error: 'unknown action', code: 404 });
  try {
    return json_(handler(body));
  } catch (err) {
    var msg = String(err && err.message || err);
    var code = /login required|invalid credentials/.test(msg) ? 401
      : /admin only/.test(msg) ? 403
      : /locked/.test(msg) ? 403
      : /not found/.test(msg) ? 404
      : /taken/.test(msg) ? 409
      : /username|password|pick|JSON|line|mode|points|event/.test(msg) ? 400 : 500;
    return json_({ error: msg, code: code });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function now_() { return Math.floor(Date.now() / 1000); }

// ---------------------------------------------------------------------------
// Auth (casual accounts: salted SHA-256, plaintext is never stored)
// ---------------------------------------------------------------------------

function hashPassword_(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function requireUser_(body) {
  var token = body.token;
  if (!token) throw new Error('login required');
  var now = now_();
  var s = readTab_('Sessions').filter(function (r) {
    return r.token === token && Number(r.expires_at) > now;
  })[0];
  if (!s) throw new Error('login required');
  return s.username;
}

function requireAdmin_(body) {
  var username = requireUser_(body);
  if (String(username).toLowerCase() !== 'admin') throw new Error('admin only');
  return username;
}

function isAdmin_(username) {
  return String(username).toLowerCase() === 'admin';
}

function createSession_(username) {
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  appendRow_('Sessions', { token: token, username: username, expires_at: now_() + SESSION_TTL });
  return token;
}

function apiSignup_(body) {
  var username = String(body.username || '');
  var password = String(body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error('username must be 3-20 characters: letters, numbers, underscore');
  }
  if (password.length < 4) throw new Error('password must be at least 4 characters');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var exists = readTab_('Users').some(function (u) {
      return String(u.username).toLowerCase() === username.toLowerCase();
    });
    if (exists) throw new Error('username taken');
    var salt = Utilities.getUuid();
    appendRow_('Users', { username: username, salt: salt, hash: hashPassword_(password, salt), created_at: now_() });
  } finally {
    lock.releaseLock();
  }
  return { user: { username: username, is_admin: isAdmin_(username) }, token: createSession_(username) };
}

function apiLogin_(body) {
  var username = String(body.username || '');
  var u = readTab_('Users').filter(function (r) {
    return String(r.username).toLowerCase() === username.toLowerCase();
  })[0];
  if (!u || hashPassword_(String(body.password || ''), u.salt) !== u.hash) {
    throw new Error('invalid credentials');
  }
  return { user: { username: u.username, is_admin: isAdmin_(u.username) }, token: createSession_(u.username) };
}

function apiLogout_(body) {
  var s = readTab_('Sessions').filter(function (r) { return r.token === body.token; })[0];
  if (s) SpreadsheetApp.getActive().getSheetByName('Sessions').deleteRow(s._row);
  return { ok: true };
}

function apiMe_(body) {
  var username = requireUser_(body);
  return { user: { username: username, is_admin: isAdmin_(username) } };
}

// ---------------------------------------------------------------------------
// Rounds: footballdata gives only round_id + game_week, so names are derived.
// Group/league rounds have game_week > 0; knockout rounds are named by size.
// ---------------------------------------------------------------------------

var KO_NAMES = { 32: 'Round of 64', 16: 'Round of 32', 8: 'Round of 16', 4: 'Quarter-finals', 2: 'Semi-finals' };

function roundsInfo_(matches) {
  var byRound = {};
  matches.forEach(function (m) {
    var key = String(m.round_id == null ? 'none' : m.round_id);
    var r = byRound[key];
    if (!r) r = byRound[key] = { round_id: m.round_id, first: Number(m.kickoff_unix), count: 0, is_group: false };
    r.count += 1;
    r.first = Math.min(r.first, Number(m.kickoff_unix));
    if (Number(m.game_week) > 0) r.is_group = true;
  });
  var rounds = Object.keys(byRound).map(function (k) { return byRound[k]; });
  rounds.sort(function (a, b) { return a.first - b.first; });
  var koSeen = rounds.filter(function (r) { return !r.is_group; });
  var singles = koSeen.filter(function (r) { return r.count === 1; });
  rounds.forEach(function (r, i) {
    if (r.is_group) {
      r.name = rounds.some(function (x) { return !x.is_group; }) ? 'Group stage' : 'Season';
    } else if (KO_NAMES[r.count]) {
      r.name = KO_NAMES[r.count];
    } else if (r.count === 1) {
      // two 1-match rounds: the earlier is the third-place play-off
      r.name = singles.length > 1 && r === singles[0] ? 'Third place play-off' : 'Final';
    } else {
      r.name = 'Round ' + (i + 1);
    }
  });
  return rounds;
}

function roundsByIdMap_(rounds) {
  var map = {};
  rounds.forEach(function (r) { map[String(r.round_id)] = r; });
  return map;
}

// ---------------------------------------------------------------------------
// Scoring — three guess modes, points per match/round set by the admin.
// ---------------------------------------------------------------------------

function winnerOf_(m) {
  if (!m || m.status !== 'complete' || m.home_score == null || m.away_score == null) return null;
  if (Number(m.home_score) > Number(m.away_score)) return 'home';
  if (Number(m.home_score) < Number(m.away_score)) return 'away';
  return 'draw';
}

function tournamentMode_(t) {
  var mode = t && t.guess_mode;
  return GUESS_MODES.indexOf(mode) >= 0 ? mode : '1x2';
}

function matchPoints_(m, t) {
  var rp = {};
  try { rp = JSON.parse((t && t.round_points) || '{}') || {}; } catch (e) { rp = {}; }
  var v = rp[String(m.round_id)];
  if (v != null && v !== '' && isFinite(Number(v))) return Number(v);
  var d = t && t.default_points;
  return d != null && isFinite(Number(d)) && d !== '' ? Number(d) : 1;
}

// Advancing team for win/loss mode: enrichment result if we have it,
// otherwise the regulation winner when decisive.
function advWinnerOf_(m) {
  if (m.adv_winner === 'home' || m.adv_winner === 'away') return m.adv_winner;
  var ft = winnerOf_(m);
  if (ft === 'home' || ft === 'away') return ft;
  return null;
}

// Mode that applies to one match when picking. Knockout matches can't end in
// a draw — someone always advances — so 1x2 tournaments (e.g. the World Cup)
// use 1x2 for the group stage and win/loss for the elimination rounds.
function effectiveMode_(t, isGroup) {
  var mode = tournamentMode_(t);
  if (mode === '1x2' && !isGroup) return 'wl';
  return mode;
}

// Mode a pick is scored under: the mode stored with the pick (the admin
// changing the tournament mode never re-scores old picks), except that
// knockout matches are always settled win/loss — a regulation draw there is
// decided by extra time / penalties, never left as "draw".
function scoringMode_(m, t, pred) {
  var stored = pred && GUESS_MODES.indexOf(pred.mode) >= 0 ? pred.mode : null;
  var mode = stored || tournamentMode_(t);
  if (mode === 'handicap') return 'handicap';
  return m.is_group ? mode : 'wl';
}

/**
 * Scores one prediction. Requires m to be decorated (is_group set). Returns:
 *   {outcome: 'correct'|'wrong'|'push'|'void'|null, points: number|null}
 * null outcome = not settled yet. 'push' (handicap landed exactly on the
 * line) and 'void' (no winner is determinable for a win/loss pick, or the
 * pick was made under rules where the outcome can't be judged) award 0
 * and don't count against accuracy.
 */
function scorePrediction_(m, t, pred) {
  var mode = scoringMode_(m, t, pred);
  var pts = matchPoints_(m, t);
  if (m.status !== 'complete' || m.home_score == null || m.away_score == null) {
    return { outcome: null, points: null };
  }
  if (mode === 'handicap') {
    var line = pred.hdp != null && pred.hdp !== '' ? Number(pred.hdp) : (m.hdp != null ? Number(m.hdp) : null);
    if (line == null || !isFinite(line)) return { outcome: 'void', points: 0 };
    var diff = Number(m.home_score) - Number(m.away_score) + line;
    if (diff === 0) return { outcome: 'push', points: 0 };
    var winner = diff > 0 ? 'home' : 'away';
    return pred.pick === winner ? { outcome: 'correct', points: pts } : { outcome: 'wrong', points: 0 };
  }
  if (mode === 'wl') {
    // A draw pick predates the win/loss rules for this match — void it
    // rather than judging it under rules that changed after the pick.
    if (pred.pick === 'draw') return { outcome: 'void', points: 0 };
    if (m.is_group) {
      // Group matches have no advancing team; the FT result settles the
      // pick, and a draw voids it (draw was not a pickable answer).
      var ft = winnerOf_(m);
      if (ft === 'draw') return { outcome: 'void', points: 0 };
      return pred.pick === ft ? { outcome: 'correct', points: pts } : { outcome: 'wrong', points: 0 };
    }
    var adv = advWinnerOf_(m);
    if (!adv) {
      // FT draw: wait for the penalties/extra-time lookup. 'none' means the
      // last lookup found no decider — shown as void, retried next tick.
      if (m.adv_winner === 'none') return { outcome: 'void', points: 0 };
      return { outcome: null, points: null };
    }
    return pred.pick === adv ? { outcome: 'correct', points: pts } : { outcome: 'wrong', points: 0 };
  }
  // 1x2 (group/league matches): regulation result, draws are a valid pick
  var result = winnerOf_(m);
  return pred.pick === result ? { outcome: 'correct', points: pts } : { outcome: 'wrong', points: 0 };
}

// ---------------------------------------------------------------------------
// Game API
// ---------------------------------------------------------------------------

function getTournament_(leagueId) {
  return readTab_('Tournaments').filter(function (r) { return Number(r.league_id) === Number(leagueId); })[0] || null;
}

function tournamentPublic_(t) {
  var out = JSON.parse(JSON.stringify(t));
  delete out._row;
  out.visible = t.visible == null ? 1 : Number(t.visible);
  out.guess_mode = tournamentMode_(t);
  out.default_points = t.default_points == null || t.default_points === '' ? 1 : Number(t.default_points);
  try { out.round_points = JSON.parse(t.round_points || '{}') || {}; } catch (e) { out.round_points = {}; }
  return out;
}

function apiTournaments_(body) {
  var username = null;
  try { username = requireUser_(body); } catch (e) { /* list is public */ }
  var admin = username && isAdmin_(username);
  var counts = {};
  readTab_('Matches').forEach(function (m) {
    if (Number(m.hidden)) return;
    counts[m.league_id] = (counts[m.league_id] || 0) + 1;
  });
  var ts = readTab_('Tournaments')
    .filter(function (t) { return admin || t.visible == null || Number(t.visible) === 1; })
    .map(function (t) {
      var out = tournamentPublic_(t);
      out.match_count = counts[t.league_id] || 0;
      return out;
    });
  ts.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { tournaments: ts };
}

function leagueMatches_(leagueId) {
  return readTab_('Matches').filter(function (m) { return Number(m.league_id) === Number(leagueId); })
    .sort(function (a, b) { return a.kickoff_unix - b.kickoff_unix || a.match_id - b.match_id; });
}

function decorateMatch_(m, t, roundMap) {
  var r = roundMap[String(m.round_id)];
  m.round_name = r ? r.name : null;
  m.is_group = r ? r.is_group : true;
  m.mode = effectiveMode_(t, m.is_group);
  m.points = matchPoints_(m, t);
  m.result = winnerOf_(m);
  m.adv = advWinnerOf_(m);
  m.hidden = Number(m.hidden) || 0;
  return m;
}

function apiMatches_(body) {
  var username = requireUser_(body);
  var admin = isAdmin_(username);
  var t = getTournament_(body.league_id);
  if (!t || (!admin && t.visible != null && Number(t.visible) === 0)) throw new Error('not found');
  var mine = {};
  readTab_('Predictions').forEach(function (p) {
    if (p.username === username) mine[p.match_id] = p;
  });
  var all = leagueMatches_(body.league_id);
  var rounds = roundsInfo_(all);
  var roundMap = roundsByIdMap_(rounds);
  var tPub = tournamentPublic_(t);
  var matches = all
    .filter(function (m) { return admin || !Number(m.hidden); })
    .map(function (m) {
      decorateMatch_(m, t, roundMap);
      var p = mine[m.match_id];
      m.my_pick = p ? p.pick : null;
      m.my_hdp = p && p.hdp != null && p.hdp !== '' ? Number(p.hdp) : null;
      if (p) {
        var s = scorePrediction_(m, t, p);
        m.my_outcome = s.outcome;
        m.my_points = s.points;
      }
      delete m._row;
      return m;
    });
  rounds.forEach(function (r) { r.points = matchPoints_({ round_id: r.round_id }, t); });
  return { tournament: tPub, rounds: rounds, matches: matches, now: now_() };
}

function apiMatchDetail_(body) {
  var username = requireUser_(body);
  var admin = isAdmin_(username);
  var now = now_();
  var m = readTab_('Matches').filter(function (r) { return Number(r.match_id) === Number(body.match_id); })[0];
  if (!m || (!admin && Number(m.hidden))) throw new Error('not found');
  var t = getTournament_(m.league_id) || {};
  var all = leagueMatches_(m.league_id);
  var roundMap = roundsByIdMap_(roundsInfo_(all));
  decorateMatch_(m, t, roundMap);

  var preds = readTab_('Predictions').filter(function (p) { return Number(p.match_id) === Number(m.match_id); });
  var minePred = preds.filter(function (p) { return p.username === username; })[0];
  delete m._row;
  m.my_pick = minePred ? minePred.pick : null;
  m.my_hdp = minePred && minePred.hdp != null && minePred.hdp !== '' ? Number(minePred.hdp) : null;
  if (minePred) {
    var sc = scorePrediction_(m, t, minePred);
    m.my_outcome = sc.outcome;
    m.my_points = sc.points;
  }
  m.locked = now >= Number(m.kickoff_unix);
  if (m.locked) {
    m.picks = preds.map(function (p) {
      var s = scorePrediction_(m, t, p);
      return {
        username: p.username,
        pick: p.pick,
        hdp: p.hdp != null && p.hdp !== '' ? Number(p.hdp) : null,
        outcome: s.outcome,
        points: s.points,
      };
    }).sort(function (a, b) { return a.username.toLowerCase().localeCompare(b.username.toLowerCase()); });
  }
  var odds = getOddsRow_(m.match_id);
  return {
    match: m,
    tournament: tournamentPublic_(t),
    odds: odds,
    odds_refresh_in: oddsRefreshIn_(odds, now),
    now: now,
  };
}

function apiPredict_(body) {
  var username = requireUser_(body);
  var pick = body.pick;
  var allMatches = readTab_('Matches');
  var m = allMatches.filter(function (r) { return Number(r.match_id) === Number(body.match_id); })[0];
  if (!m || (!isAdmin_(username) && Number(m.hidden))) throw new Error('not found');
  var t = getTournament_(m.league_id) || {};
  var leagueAll = allMatches.filter(function (r) { return Number(r.league_id) === Number(m.league_id); });
  var round = roundsByIdMap_(roundsInfo_(leagueAll))[String(m.round_id)];
  var mode = effectiveMode_(t, round ? round.is_group : true);
  var allowed = mode === '1x2' ? ['home', 'draw', 'away'] : ['home', 'away'];
  if (allowed.indexOf(pick) < 0) throw new Error('bad pick');
  if (mode === 'handicap' && (m.hdp == null || m.hdp === '' || !isFinite(Number(m.hdp)))) {
    throw new Error('no handicap line set for this match yet');
  }
  var now = now_();
  if (now >= Number(m.kickoff_unix)) throw new Error('match locked');
  var existing = readTab_('Predictions').filter(function (p) {
    return p.username === username && Number(p.match_id) === Number(body.match_id);
  })[0];
  var row = {
    username: username,
    match_id: Number(body.match_id),
    pick: pick,
    updated_at: now,
    hdp: mode === 'handicap' ? Number(m.hdp) : null,
    mode: mode,
  };
  if (existing) updateRow_('Predictions', existing._row, row);
  else appendRow_('Predictions', row);
  return { ok: true, pick: pick, hdp: row.hdp };
}

function apiRankings_(body) {
  requireUser_(body);
  var t = getTournament_(body.league_id);
  if (!t) throw new Error('not found');
  var byId = {};
  var all = leagueMatches_(body.league_id);
  var roundMap = roundsByIdMap_(roundsInfo_(all));
  all.forEach(function (m) {
    if (Number(m.hidden)) return;
    decorateMatch_(m, t, roundMap);
    byId[m.match_id] = m;
  });
  var byUser = {};
  readTab_('Predictions').forEach(function (p) {
    var m = byId[p.match_id];
    if (!m) return;
    var e = byUser[p.username] || { username: p.username, points: 0, predicted: 0, correct: 0 };
    var s = scorePrediction_(m, t, p);
    if (s.outcome === 'correct' || s.outcome === 'wrong' || s.outcome === 'push') {
      e.predicted += 1;
      if (s.outcome === 'correct') { e.correct += 1; e.points += s.points; }
    }
    byUser[p.username] = e;
  });
  var acc = function (e) { return e.predicted ? e.correct / e.predicted : 0; };
  var list = Object.keys(byUser).map(function (k) { return byUser[k]; });
  list.sort(function (a, b) {
    return b.points - a.points || acc(b) - acc(a) || a.username.localeCompare(b.username);
  });
  // highest score obtainable: every visible match predicted correctly
  var max_points = 0;
  Object.keys(byId).forEach(function (k) { max_points += byId[k].points; });
  return { rankings: list, max_points: max_points };
}

function apiHistory_(body) {
  var username = requireUser_(body);
  var t = getTournament_(body.league_id);
  if (!t) throw new Error('not found');
  var all = leagueMatches_(body.league_id);
  var roundMap = roundsByIdMap_(roundsInfo_(all));
  var byId = {};
  all.forEach(function (m) {
    if (Number(m.hidden)) return;
    decorateMatch_(m, t, roundMap);
    byId[m.match_id] = m;
  });
  var rows = [];
  readTab_('Predictions').forEach(function (p) {
    if (p.username !== username || !byId[p.match_id]) return;
    var m = byId[p.match_id];
    var copy = JSON.parse(JSON.stringify(m));
    delete copy._row;
    copy.my_pick = p.pick;
    copy.my_hdp = p.hdp != null && p.hdp !== '' ? Number(p.hdp) : null;
    var s = scorePrediction_(m, t, p);
    copy.my_outcome = s.outcome;
    copy.my_points = s.points;
    rows.push(copy);
  });
  rows.sort(function (a, b) { return b.kickoff_unix - a.kickoff_unix || b.match_id - a.match_id; });
  return { history: rows };
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

function apiAdminOverview_(body) {
  requireAdmin_(body);
  var counts = {};
  var matchesAll = readTab_('Matches');
  matchesAll.forEach(function (m) { counts[m.league_id] = (counts[m.league_id] || 0) + 1; });
  var ts = readTab_('Tournaments').map(function (t) {
    var out = tournamentPublic_(t);
    out.match_count = counts[t.league_id] || 0;
    var mine = matchesAll.filter(function (m) { return Number(m.league_id) === Number(t.league_id); });
    out.rounds = roundsInfo_(mine).map(function (r) {
      r.points = matchPoints_({ round_id: r.round_id }, t);
      return r;
    });
    return out;
  });
  ts.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { tournaments: ts, usage: usageInfo_() };
}

// Live API-budget check: /account/usage is footballdata.io's dedicated (free)
// usage endpoint; if it's ever unavailable, fall back to the cheapest real
// call — every response carries the same usage meta.
function apiAdminUsage_(body) {
  requireAdmin_(body);
  try {
    fdGet_('/account/usage');
  } catch (err) {
    fdGet_('/leagues');
  }
  return { ok: true, usage: usageInfo_() };
}

function apiAdminTournament_(body) {
  requireAdmin_(body);
  var t = getTournament_(body.league_id);
  if (!t) throw new Error('not found');
  if (body.visible != null) t.visible = Number(body.visible) ? 1 : 0;
  if (body.guess_mode != null) {
    if (GUESS_MODES.indexOf(body.guess_mode) < 0) throw new Error('bad mode');
    t.guess_mode = body.guess_mode;
  }
  if (body.default_points != null) {
    var dp = Number(body.default_points);
    if (!isFinite(dp) || dp < 0) throw new Error('bad points');
    t.default_points = dp;
  }
  if (body.round_points != null) {
    if (typeof body.round_points !== 'object') throw new Error('bad points');
    var clean = {};
    Object.keys(body.round_points).forEach(function (k) {
      var v = Number(body.round_points[k]);
      if (isFinite(v) && v >= 0) clean[k] = v;
    });
    t.round_points = JSON.stringify(clean);
  }
  updateRow_('Tournaments', t._row, t);
  return { ok: true, tournament: tournamentPublic_(t) };
}

function apiAdminMatch_(body) {
  requireAdmin_(body);
  var m = readTab_('Matches').filter(function (r) { return Number(r.match_id) === Number(body.match_id); })[0];
  if (!m) throw new Error('not found');
  if (body.hidden != null) m.hidden = Number(body.hidden) ? 1 : 0;
  if (body.hdp !== undefined) {
    if (body.hdp === null || body.hdp === '') {
      m.hdp = null;
    } else {
      var line = Number(body.hdp);
      if (!isFinite(line)) throw new Error('bad handicap line');
      m.hdp = line;
    }
  }
  updateRow_('Matches', m._row, m);
  return { ok: true };
}

// Admin "sync now": re-fetch the tournament's fixtures & results immediately
// instead of waiting for the hourly tick. With a match_id it also runs the
// penalties/advancing-team lookup for that match when it applies.
function apiAdminSync_(body) {
  requireAdmin_(body);
  var t = getTournament_(body.league_id);
  if (!t || t.season_id == null) throw new Error('not found');
  var now = now_();
  syncSeasonMatches_(Number(t.league_id), t.season_id);
  t.last_synced = now;
  updateRow_('Tournaments', t._row, t);

  var match = null;
  if (body.match_id != null) {
    var all = leagueMatches_(t.league_id);
    var roundMap = roundsByIdMap_(roundsInfo_(all));
    var m = all.filter(function (r) { return Number(r.match_id) === Number(body.match_id); })[0];
    if (!m) throw new Error('not found');
    if (needsEnrich_(m, roundMap)) {
      try {
        enrichMatch_(m);
      } catch (err) {
        console.error('pen enrichment failed for match ' + m.match_id + ': ' + err);
      }
    }
    decorateMatch_(m, t, roundMap);
    delete m._row;
    match = m;
  }
  return { ok: true, last_synced: now, match: match };
}

// Admin event picker: when "Refresh odds" can't match a betting event
// (footballdata ↔ odds-api naming differences), the admin browses what the
// odds service is actually running — events matching either team name, plus
// the whole odds-api league when its name matches the tournament — and picks
// the right event to link to the match.
function apiAdminOddsSearch_(body) {
  requireAdmin_(body);
  var m = readTab_('Matches').filter(function (r) { return Number(r.match_id) === Number(body.match_id); })[0];
  if (!m) throw new Error('not found');
  var t = getTournament_(m.league_id);

  var seen = {};
  var events = [];
  var errors = [];
  var collect = function (list) {
    (list || []).forEach(function (ev) {
      if (!ev || ev.id == null || seen[ev.id]) return;
      seen[ev.id] = 1;
      events.push(ev);
    });
  };
  [m.home_team, m.away_team].forEach(function (q) {
    try {
      collect(oaSearchEvents_(q));
    } catch (err) {
      errors.push(String(err && err.message || err));
    }
  });
  try {
    var slug = t ? oaFindLeagueSlug_(t.name, t.country) : null;
    if (slug) collect(oaLeagueEvents_(slug));
  } catch (err) {
    errors.push(String(err && err.message || err));
  }
  if (!events.length && errors.length) throw new Error(errors[0]);

  var kickoff = Number(m.kickoff_unix);
  var candidates = events.map(function (ev) {
    var ts = Math.floor(new Date(ev.date).getTime() / 1000);
    return {
      event_id: ev.id,
      home: ev.home || null,
      away: ev.away || null,
      date: isFinite(ts) ? ts : null,
      league: ev.league && ev.league.name ? ev.league.name : (typeof ev.league === 'string' ? ev.league : null),
    };
  });
  candidates.sort(function (a, b) {
    var da = a.date == null ? Infinity : Math.abs(a.date - kickoff);
    var db = b.date == null ? Infinity : Math.abs(b.date - kickoff);
    return da - db;
  });
  return {
    candidates: candidates.slice(0, 30),
    match: { match_id: Number(m.match_id), home_team: m.home_team, away_team: m.away_team, kickoff_unix: kickoff },
  };
}

// Links a hand-picked odds-api event to the match and fetches its odds right
// away. The stored event_id makes every future "Refresh odds" use it too.
function apiAdminOddsLink_(body) {
  var username = requireAdmin_(body);
  var matchId = Number(body.match_id);
  var m = readTab_('Matches').filter(function (r) { return Number(r.match_id) === matchId; })[0];
  if (!m) throw new Error('not found');
  if (body.event_id == null || body.event_id === '') throw new Error('missing event id');
  var payload = oaOdds_(body.event_id);
  var dk = extractMl_(payload, 'DraftKings');
  var xb = extractMl_(payload, '1xbet');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var existing = readTab_('Odds').filter(function (r) { return Number(r.match_id) === matchId; })[0];
    var row = {
      match_id: matchId, event_id: body.event_id, fetched_at: now_(), fetched_by: username, no_match: 0,
      dk_home: dk && dk.home, dk_draw: dk && dk.draw, dk_away: dk && dk.away,
      xb_home: xb && xb.home, xb_draw: xb && xb.draw, xb_away: xb && xb.away,
    };
    if (existing) updateRow_('Odds', existing._row, row);
    else appendRow_('Odds', row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, odds: getOddsRow_(matchId), odds_refresh_in: ODDS_LOCK_SECONDS };
}

// ---------------------------------------------------------------------------
// Odds with the shared 5-minute lock
// ---------------------------------------------------------------------------

function getOddsRow_(matchId) {
  var row = readTab_('Odds').filter(function (r) { return Number(r.match_id) === Number(matchId); })[0] || null;
  if (row) delete row._row;
  return row;
}

function oddsRefreshIn_(odds, now) {
  if (!odds || odds.fetched_at == null) return 0;
  return Math.max(0, ODDS_LOCK_SECONDS - (now - Number(odds.fetched_at)));
}

function apiOddsRefresh_(body) {
  var username = requireUser_(body);
  var matchId = Number(body.match_id);
  var m = readTab_('Matches').filter(function (r) { return Number(r.match_id) === matchId; })[0];
  if (!m) throw new Error('not found');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = now_();
    var existingRow = readTab_('Odds').filter(function (r) { return Number(r.match_id) === matchId; })[0];
    var existing = existingRow ? JSON.parse(JSON.stringify(existingRow)) : null;
    if (existing && oddsRefreshIn_(existing, now) > 0) {
      delete existing._row;
      return { status: 'locked', odds: existing, odds_refresh_in: oddsRefreshIn_(existing, now) };
    }

    var saveRow = function (obj) {
      if (existingRow) updateRow_('Odds', existingRow._row, obj);
      else appendRow_('Odds', obj);
    };

    try {
      var eventId = existing ? existing.event_id : null;
      if (!eventId) {
        var events = oaSearchEvents_(m.home_team);
        var ev = findEvent_(m, events);
        if (!ev) {
          saveRow({ match_id: matchId, event_id: null, fetched_at: now, fetched_by: username, no_match: 1 });
          return { status: 'no_match', odds: getOddsRow_(matchId), odds_refresh_in: ODDS_LOCK_SECONDS };
        }
        eventId = ev.id;
      }
      var payload = oaOdds_(eventId);
      var dk = extractMl_(payload, 'DraftKings');
      var xb = extractMl_(payload, '1xbet');
      saveRow({
        match_id: matchId, event_id: eventId, fetched_at: now, fetched_by: username, no_match: 0,
        dk_home: dk && dk.home, dk_draw: dk && dk.draw, dk_away: dk && dk.away,
        xb_home: xb && xb.home, xb_draw: xb && xb.draw, xb_away: xb && xb.away,
      });
      return { status: 'ok', odds: getOddsRow_(matchId), odds_refresh_in: ODDS_LOCK_SECONDS };
    } catch (err) {
      if (existing) delete existing._row;
      return { status: 'error', error: String(err && err.message || err), odds: existing, odds_refresh_in: 0 };
    }
  } finally {
    lock.releaseLock();
  }
}

function num_(v) {
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function extractMl_(payload, bookmaker) {
  var markets = payload && payload.bookmakers && payload.bookmakers[bookmaker];
  if (!markets || !markets.length) return null;
  var ml = markets.filter(function (mk) { return mk && mk.name === 'ML'; })[0];
  var row = ml && ml.odds && ml.odds[0];
  if (!row) return null;
  return { home: num_(row.home), draw: num_(row.draw), away: num_(row.away) };
}

// ---------------------------------------------------------------------------
// Team matching (footballdata ↔ odds-api)
// ---------------------------------------------------------------------------

var NOISE_TOKENS = { fc: 1, afc: 1, cf: 1, cfc: 1, sc: 1, ac: 1, club: 1, cd: 1, 'if': 1, bk: 1, sk: 1 };
var ALIASES = { utd: 'united', man: 'manchester' };

function normalizeTokens_(name) {
  var s = String(name || '').toLowerCase();
  s = s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  var seen = {};
  var out = [];
  s.split(/\s+/).forEach(function (t) {
    if (!t) return;
    t = ALIASES[t] || t;
    if (NOISE_TOKENS[t] || seen[t]) return;
    seen[t] = 1;
    out.push(t);
  });
  return out;
}

function teamsMatch_(a, b) {
  var ta = normalizeTokens_(a), tb = normalizeTokens_(b);
  if (!ta.length || !tb.length) return false;
  var setB = {};
  tb.forEach(function (t) { setB[t] = 1; });
  var inter = ta.filter(function (t) { return setB[t]; }).length;
  if (inter === 0) return false;
  if (inter === ta.length || inter === tb.length) return true;
  var union = {};
  ta.concat(tb).forEach(function (t) { union[t] = 1; });
  return inter / Object.keys(union).length >= 0.6;
}

function findEvent_(match, events) {
  var tolerance = 3 * 3600;
  var candidates = (events || []).filter(function (ev) {
    var t = Math.floor(new Date(ev.date).getTime() / 1000);
    if (!isFinite(t)) return false;
    return Math.abs(t - Number(match.kickoff_unix)) <= tolerance &&
      teamsMatch_(match.home_team, ev.home) && teamsMatch_(match.away_team, ev.away);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// External API clients (keys live in Script Properties, never in the repo)
// ---------------------------------------------------------------------------

function prop_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Script property ' + key + ' is not set');
  return v;
}

// --- API usage tracking (shown on the Admin page) --------------------------
// footballdata.io reports plan/requests_used/requests_limit in the `meta` of
// every response — we store the latest snapshot. odds-api.io has no usage
// endpoint, so for it (and as a fallback) we count this script's own calls,
// reset each calendar month.

function ym_() {
  var d = new Date();
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

function readUsage_(key) {
  try { return JSON.parse(metaGet_(key) || 'null') || {}; } catch (e) { return {}; }
}

function bumpUsage_(key, apiMeta) {
  var u = readUsage_(key);
  var month = ym_();
  if (u.month !== month) { u.month = month; u.calls = 0; }
  u.calls = (u.calls || 0) + 1;
  if (apiMeta && apiMeta.requests_used != null) {
    u.plan = apiMeta.plan || u.plan || null;
    u.used = Number(apiMeta.requests_used);
    u.limit = apiMeta.requests_limit != null ? Number(apiMeta.requests_limit) : (u.limit != null ? u.limit : null);
    u.checked_at = now_();
  }
  metaSet_(key, JSON.stringify(u));
}

function usageInfo_() {
  return { fd: readUsage_('fd_usage'), oa: readUsage_('oa_usage'), month: ym_() };
}

function fdGet_(pathname) {
  var res = UrlFetchApp.fetch(FD_BASE + pathname, {
    headers: { Authorization: 'Bearer ' + prop_('FOOTBALLDATA_API_KEY') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    bumpUsage_('fd_usage', null);
    throw new Error('footballdata.io HTTP ' + res.getResponseCode());
  }
  var body = JSON.parse(res.getContentText());
  bumpUsage_('fd_usage', body && body.meta);
  if (body && body.success === false) throw new Error('footballdata.io error: ' + (body.message || 'unknown'));
  return body;
}

function oaGet_(pathname, params) {
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var res = UrlFetchApp.fetch(OA_BASE + pathname + '?' + qs + '&apiKey=' + encodeURIComponent(prop_('ODDS_API_KEY')), {
    muteHttpExceptions: true,
  });
  bumpUsage_('oa_usage', null);
  if (res.getResponseCode() !== 200) throw new Error('odds-api.io HTTP ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}

function oaSearchEvents_(query) {
  var body = oaGet_('/events/search', { query: query, sport: 'football' });
  if (Object.prototype.toString.call(body) === '[object Array]') return body;
  return (body && body.data) || [];
}

function oaOdds_(eventId) {
  return oaGet_('/odds', { eventId: eventId, bookmakers: 'DraftKings,1xbet' });
}

// Single event by id (used to read period scores off the linked event).
function oaEvent_(eventId) {
  var body = oaGet_('/events/' + encodeURIComponent(eventId), {});
  var ev = body && body.data != null ? body.data : body;
  if (Object.prototype.toString.call(ev) === '[object Array]') ev = ev[0];
  return ev && ev.id != null ? ev : null;
}

// odds-api league slug for a tournament, e.g. "England - Premier League" →
// england-premier-league. Matched on country + name tokens; null when the
// name is ambiguous (several countries run a "Premier League").
function oaFindLeagueSlug_(tournamentName, country) {
  var body = oaGet_('/leagues', { sport: 'football' });
  var leagues = Object.prototype.toString.call(body) === '[object Array]' ? body : (body && body.data) || [];
  var wanted = (country ? country + ' ' : '') + String(tournamentName || '');
  var hits = leagues.filter(function (lg) {
    return lg && lg.slug && teamsMatch_(wanted, lg.name);
  });
  return hits.length === 1 ? hits[0].slug : null;
}

function oaLeagueEvents_(slug) {
  var body = oaGet_('/events', { sport: 'football', league: slug });
  if (Object.prototype.toString.call(body) === '[object Array]') return body;
  return (body && body.data) || [];
}

// ---------------------------------------------------------------------------
// Fixture sync
// ---------------------------------------------------------------------------

function parseFdDate_(s) {
  var t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return isFinite(t) ? Math.floor(t / 1000) : null;
}

function chooseSeason_(seasons, nowUnix) {
  var usable = (seasons || []).map(function (s) {
    return {
      season: s,
      first: s.summary ? parseFdDate_(s.summary.first_match_date) : null,
      last: s.summary ? parseFdDate_(s.summary.last_match_date) : null,
      count: s.summary ? s.summary.match_count : 0,
    };
  }).filter(function (s) { return s.first != null && s.last != null && s.count > 0; });
  if (!usable.length) return null;
  var active = usable.filter(function (s) { return s.first - 3 * DAY <= nowUnix && nowUnix <= s.last + 3 * DAY; });
  if (active.length) return active.sort(function (a, b) { return b.first - a.first; })[0].season;
  var future = usable.filter(function (s) { return s.first > nowUnix; });
  if (future.length) return future.sort(function (a, b) { return a.first - b.first; })[0].season;
  return usable.sort(function (a, b) { return b.last - a.last; })[0].season;
}

function fetchSeasonMatches_(seasonId) {
  var all = [];
  var page = 1, totalPages = 1;
  do {
    var body = fdGet_('/seasons/' + seasonId + '/matches?limit=100&page=' + page);
    all = all.concat((body.data && body.data.matches) || []);
    var pg = body.meta && body.meta.pagination;
    totalPages = Math.min((pg && pg.total_pages) || 1, MAX_PAGES);
    page += 1;
  } while (page <= totalPages);
  return all;
}

// Rebuilds the rows of one league inside the Matches tab, preserving admin
// edits and enrichment fields (Matches holds no other user data).
function syncSeasonMatches_(leagueId, seasonId) {
  var fetched = fetchSeasonMatches_(seasonId);
  var existing = readTab_('Matches');
  var keep = {};
  existing.forEach(function (m) {
    if (Number(m.league_id) === Number(leagueId)) {
      var kept = {};
      MATCH_KEEP_FIELDS.forEach(function (f) { kept[f] = m[f]; });
      keep[m.match_id] = kept;
    }
  });
  var others = existing.filter(function (m) { return Number(m.league_id) !== Number(leagueId); });
  others.forEach(function (m) { delete m._row; });
  var rows = [];
  fetched.forEach(function (m) {
    if (!m || m.match_id == null || !m.home_team || !m.away_team) return;
    var kickoff = m.date_unix != null ? m.date_unix : parseFdDate_(m.match_date);
    if (kickoff == null) return;
    var complete = m.status === 'complete';
    var row = {
      match_id: m.match_id,
      league_id: leagueId,
      season_id: seasonId,
      kickoff_unix: kickoff,
      status: m.status || null,
      home_team: m.home_team.team_name,
      away_team: m.away_team.team_name,
      home_logo: m.home_team.team_logo || null,
      away_logo: m.away_team.team_logo || null,
      home_score: complete && m.score ? m.score.home : null,
      away_score: complete && m.score ? m.score.away : null,
      game_week: m.game_week != null ? m.game_week : null,
      round_id: m.round_id != null ? m.round_id : null,
      post_synced: 0,
    };
    var kept = keep[m.match_id];
    if (kept) MATCH_KEEP_FIELDS.forEach(function (f) { if (kept[f] != null) row[f] = kept[f]; });
    rows.push(row);
  });
  replaceTab_('Matches', others.concat(rows));
}

function syncLeague_(leagueInfo, now) {
  var body = fdGet_('/leagues/' + leagueInfo.league_id + '/seasons');
  var seasons = (body.data && body.data.seasons) || [];
  var season = chooseSeason_(seasons, now);
  if (!season) return;
  var existing = getTournament_(leagueInfo.league_id);
  var row = {
    league_id: leagueInfo.league_id,
    name: leagueInfo.league_name,
    country: leagueInfo.country || null,
    image: leagueInfo.league_image || null,
    season_id: season.season_id,
    season_year: String(season.year),
    last_synced: now,
    // admin-owned settings: keep existing values, default new tournaments
    visible: existing && existing.visible != null ? existing.visible : 1,
    guess_mode: existing && existing.guess_mode ? existing.guess_mode : '1x2',
    default_points: existing && existing.default_points != null ? existing.default_points : 1,
    round_points: existing && existing.round_points ? existing.round_points : '{}',
  };
  if (existing) updateRow_('Tournaments', existing._row, row);
  else appendRow_('Tournaments', row);
  syncSeasonMatches_(leagueInfo.league_id, season.season_id);
}

function syncAll_(now) {
  var leagues = fdGet_('/leagues').data || [];
  leagues.forEach(function (lg) {
    try {
      syncLeague_(lg, now);
    } catch (err) {
      console.error('sync failed for league ' + lg.league_id + ': ' + err);
    }
  });
  metaSet_('last_full_sync', String(now));
}

// ---------------------------------------------------------------------------
// Penalty / extra-time enrichment: footballdata has no shootout data, but
// odds-api events carry period scores (ft / ot / ap = penalty shootout) and
// a final score. For knockout matches that finished level in regulation we
// look the event up and store who actually advanced — the shootout tally
// decides when there was one. Lookups retry each tick until a winner is known.
// ---------------------------------------------------------------------------

// True for knockout matches that finished level in regulation and whose
// advancing team is still unknown. adv_winner = 'none' means the last lookup
// found no decider (e.g. the betting site hadn't posted the shootout yet) —
// those are retried until a winner appears.
function needsEnrich_(m, roundMap) {
  var r = roundMap[String(m.round_id)];
  if (!r || r.is_group) return false;
  if (m.status !== 'complete' || m.home_score == null) return false;
  if (Number(m.home_score) !== Number(m.away_score)) return false; // decided in regulation
  return !m.adv_winner || m.adv_winner === 'none';
}

// Pure decision: given an odds-api event `scores` object, who advanced?
// Penalties decide the winner whenever a shootout happened; otherwise the
// event's final (extra-time-inclusive) score does. 'none' = still level.
function advFromScores_(sc) {
  var periods = (sc && sc.periods) || {};
  var out = { adv_winner: 'none', aet: 0, pen_home: null, pen_away: null };
  if (periods.ot) out.aet = 1;
  if (periods.ap && periods.ap.home != null && periods.ap.away != null) {
    out.pen_home = Number(periods.ap.home);
    out.pen_away = Number(periods.ap.away);
  }
  if (out.pen_home != null && out.pen_home !== out.pen_away) {
    out.adv_winner = out.pen_home > out.pen_away ? 'home' : 'away';
  } else if (Number(sc.home) > Number(sc.away)) {
    out.adv_winner = 'home';
  } else if (Number(sc.home) < Number(sc.away)) {
    out.adv_winner = 'away';
  }
  return out;
}

// One odds-api lookup: stores who advanced + penalties / AET on the match
// row, combining footballdata's result with the betting site's period scores.
// Prefers the betting event already linked to the match (by "Refresh odds" or
// by the admin's hand-pick), falling back to a name search.
function enrichMatch_(m) {
  var ev = null;
  var oddsRow = getOddsRow_(m.match_id);
  if (oddsRow && oddsRow.event_id) {
    try { ev = oaEvent_(oddsRow.event_id); } catch (err) { ev = null; }
  }
  if (!ev) {
    var events = oaSearchEvents_(m.home_team);
    ev = findEvent_(m, events);
  }
  // No event or no scores yet: leave adv_winner unset so the next tick retries.
  if (!ev || !ev.scores) return;

  var update = advFromScores_(ev.scores);
  m.adv_winner = update.adv_winner;
  m.aet = update.aet;
  m.pen_home = update.pen_home;
  m.pen_away = update.pen_away;
  updateRow_('Matches', m._row, m);
}

function enrichKnockouts_() {
  var tournaments = readTab_('Tournaments').filter(function (t) {
    return t.visible == null || Number(t.visible) === 1;
  });
  var budget = ENRICH_PER_TICK;
  tournaments.forEach(function (t) {
    if (budget <= 0) return;
    var all = leagueMatches_(t.league_id);
    var roundMap = roundsByIdMap_(roundsInfo_(all));
    all.forEach(function (m) {
      if (budget <= 0) return;
      if (!needsEnrich_(m, roundMap)) return;
      budget -= 1;
      try {
        enrichMatch_(m);
      } catch (err) {
        console.error('pen enrichment failed for match ' + m.match_id + ': ' + err);
      }
    });
  });
}

// Runs hourly via trigger (created by setup()).
function tick() {
  ensureTabs_();
  ensureAdmin_();
  var now = now_();
  var last = Number(metaGet_('last_full_sync') || 0);
  if (!last || now - last >= DAY) syncAll_(now);

  // one-shot post-match re-fetch per league with overdue unfinished matches
  var matches = readTab_('Matches');
  var dueLeagues = {};
  matches.forEach(function (m) {
    if (!Number(m.post_synced) && String(m.status) !== 'complete' &&
        Number(m.kickoff_unix) + POST_MATCH_DELAY <= now) {
      dueLeagues[m.league_id] = true;
    }
  });
  var tournaments = readTab_('Tournaments');
  Object.keys(dueLeagues).forEach(function (leagueId) {
    var t = tournaments.filter(function (r) { return Number(r.league_id) === Number(leagueId); })[0];
    if (!t || t.season_id == null) return;
    try {
      syncSeasonMatches_(Number(leagueId), t.season_id);
    } catch (err) {
      console.error('post-match sync failed for league ' + leagueId + ': ' + err);
      return; // stays post_synced=0, retried next tick
    }
    var fresh = readTab_('Matches');
    fresh.forEach(function (m) {
      if (Number(m.league_id) === Number(leagueId) && !Number(m.post_synced) &&
          String(m.status) !== 'complete' && Number(m.kickoff_unix) + POST_MATCH_DELAY <= now) {
        m.post_synced = 1;
        updateRow_('Matches', m._row, m);
      }
    });
  });

  // penalties / advancing team for knockout draws
  try {
    enrichKnockouts_();
  } catch (err) {
    console.error('enrichment failed: ' + err);
  }

  // prune expired sessions while we're here
  var sessions = readTab_('Sessions');
  for (var i = sessions.length - 1; i >= 0; i--) {
    if (Number(sessions[i].expires_at) <= now) {
      SpreadsheetApp.getActive().getSheetByName('Sessions').deleteRow(sessions[i]._row);
    }
  }
}
