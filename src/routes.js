// HTTP layer: a small hand-rolled router on node:http (no framework needed)
// serving the JSON API under /api and static files from public/.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('./auth');
const game = require('./game');
const oddsMod = require('./odds');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const ERROR_STATUS = [
  [/invalid credentials/, 401],
  [/match locked/, 403],
  [/not found/, 404],
  [/taken/, 409],
  [/bad pick|username|password|JSON|too large/, 400],
];
function statusForError(message) {
  for (const [re, code] of ERROR_STATUS) if (re.test(message)) return code;
  return 500;
}

function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function createAppServer({ db, oa, publicDir, nowFn = () => Math.floor(Date.now() / 1000) }) {
  const routes = [];
  const add = (method, pattern, opts, handler) =>
    routes.push({ method, parts: pattern.split('/').filter(Boolean), ...opts, handler });

  function matchRoute(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
        else if (r.parts[i] !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  // ---- API routes ----------------------------------------------------

  add('POST', '/api/signup', {}, async (ctx) => {
    const { username, password } = ctx.body;
    const { token, user } = auth.signup(db, username, password, ctx.now);
    ctx.setCookie(sessionCookie(token, auth.SESSION_TTL));
    return { user };
  });

  add('POST', '/api/login', {}, async (ctx) => {
    const { username, password } = ctx.body;
    const { token, user } = auth.login(db, username, password, ctx.now);
    ctx.setCookie(sessionCookie(token, auth.SESSION_TTL));
    return { user };
  });

  add('POST', '/api/logout', {}, async (ctx) => {
    auth.logout(db, ctx.cookies.sid);
    ctx.setCookie(sessionCookie('', 0));
    return { ok: true };
  });

  add('GET', '/api/me', { requireAuth: true }, async (ctx) => ({ user: ctx.user }));

  add('GET', '/api/tournaments', {}, async () => ({
    tournaments: db
      .prepare(`
        SELECT t.*,
          (SELECT COUNT(*) FROM matches m WHERE m.league_id = t.league_id) AS match_count
        FROM tournaments t ORDER BY t.name
      `)
      .all(),
  }));

  add('GET', '/api/tournaments/:id/matches', { requireAuth: true }, async (ctx) => {
    const leagueId = Number(ctx.params.id);
    const tournament = db.prepare('SELECT * FROM tournaments WHERE league_id = ?').get(leagueId);
    if (!tournament) throw new Error('not found');
    return { tournament, matches: game.listMatches(db, leagueId, ctx.user.id), now: ctx.now };
  });

  add('GET', '/api/tournaments/:id/rankings', { requireAuth: true }, async (ctx) => ({
    rankings: game.rankings(db, Number(ctx.params.id)),
  }));

  add('GET', '/api/tournaments/:id/history', { requireAuth: true }, async (ctx) => ({
    history: game.history(db, Number(ctx.params.id), ctx.user.id),
  }));

  add('GET', '/api/matches/:id', { requireAuth: true }, async (ctx) => {
    const detail = game.matchDetail(db, Number(ctx.params.id), ctx.user.id, ctx.now);
    if (!detail) throw new Error('not found');
    const odds = oddsMod.getOdds(db, Number(ctx.params.id));
    return {
      match: detail,
      odds,
      odds_refresh_in: oddsMod.secondsUntilRefresh(odds, ctx.now),
      now: ctx.now,
    };
  });

  add('PUT', '/api/matches/:id/prediction', { requireAuth: true }, async (ctx) => {
    game.setPrediction(db, ctx.user.id, Number(ctx.params.id), ctx.body.pick, ctx.now);
    return { ok: true, pick: ctx.body.pick };
  });

  add('GET', '/api/matches/:id/odds', { requireAuth: true }, async (ctx) => {
    const odds = oddsMod.getOdds(db, Number(ctx.params.id));
    return { odds, odds_refresh_in: oddsMod.secondsUntilRefresh(odds, ctx.now) };
  });

  add('POST', '/api/matches/:id/odds/refresh', { requireAuth: true }, async (ctx) => {
    const r = await oddsMod.refreshOdds(db, oa, Number(ctx.params.id), ctx.user.username, ctx.now);
    if (r.status === 'not_found') throw new Error('not found');
    const payload = {
      status: r.status,
      odds: r.odds,
      odds_refresh_in: oddsMod.secondsUntilRefresh(r.odds, ctx.now),
    };
    if (r.status === 'locked') { ctx.statusCode = 429; }
    if (r.status === 'error') { ctx.statusCode = 502; payload.error = r.error; }
    return payload;
  });

  // ---- server --------------------------------------------------------

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(path.normalize(publicDir))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, res);
      res.writeHead(405).end();
      return;
    }

    const found = matchRoute(req.method, pathname);
    const send = (code, obj, cookies) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
      res.writeHead(code, headers);
      res.end(JSON.stringify(obj));
    };
    if (!found) return send(404, { error: 'not found' });

    const ctx = {
      params: found.params,
      cookies: parseCookies(req.headers.cookie),
      now: nowFn(),
      statusCode: 200,
      _cookies: [],
      setCookie(c) { this._cookies.push(c); },
      query: url.searchParams,
    };
    try {
      ctx.user = auth.userForToken(db, ctx.cookies.sid, ctx.now);
      if (found.route.requireAuth && !ctx.user) return send(401, { error: 'login required' });
      ctx.body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
      const result = await found.route.handler(ctx);
      send(ctx.statusCode, result, ctx._cookies);
    } catch (err) {
      send(statusForError(err.message), { error: err.message }, ctx._cookies);
    }
  });

  return server;
}

module.exports = { createAppServer };
