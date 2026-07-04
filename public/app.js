/* Vibe Tournament frontend: tiny hash-routed SPA over the JSON API. */
(() => {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  let user = null;
  let countdownTimer = null;

  // ---- helpers --------------------------------------------------------

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || `request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, ok = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('ok', ok);
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(unix) {
    return new Date(unix * 1000).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function agoMin(unixThen, unixNow) {
    return Math.max(0, Math.round((unixNow - unixThen) / 60));
  }

  function renderNav() {
    nav.innerHTML = user
      ? `<span class="user">👤 ${esc(user.username)}</span> <button id="logoutBtn">Log out</button>`
      : '';
    const b = document.getElementById('logoutBtn');
    if (b) b.onclick = async () => { await api('POST', '/api/logout'); user = null; location.hash = '#/login'; };
  }

  function requireLogin() {
    if (!user) { location.hash = '#/login'; return true; }
    return false;
  }

  // ---- views ----------------------------------------------------------

  function viewLogin() {
    app.innerHTML = `
      <div class="card auth-card">
        <h2 id="authTitle">Log in</h2>
        <form id="authForm">
          <input id="username" placeholder="username" autocomplete="username" required />
          <input id="password" type="password" placeholder="password" autocomplete="current-password" required />
          <div class="notice" id="signupNotice" style="display:none">
            Heads up: this is a casual site between friends — accounts are stored
            with only basic security. <b>Don't reuse a password you use anywhere else.</b>
          </div>
          <button class="primary" type="submit" id="authSubmit">Log in</button>
          <button type="button" id="authToggle">No account? Sign up</button>
        </form>
      </div>`;
    let mode = 'login';
    const title = document.getElementById('authTitle');
    const submit = document.getElementById('authSubmit');
    const notice = document.getElementById('signupNotice');
    document.getElementById('authToggle').onclick = (e) => {
      mode = mode === 'login' ? 'signup' : 'login';
      title.textContent = mode === 'login' ? 'Log in' : 'Create account';
      submit.textContent = mode === 'login' ? 'Log in' : 'Sign up';
      notice.style.display = mode === 'signup' ? 'block' : 'none';
      e.target.textContent = mode === 'login' ? 'No account? Sign up' : 'Have an account? Log in';
    };
    document.getElementById('authForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const body = {
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        };
        const r = await api('POST', `/api/${mode}`, body);
        user = r.user;
        renderNav();
        location.hash = '#/';
      } catch (err) { toast(err.message); }
    };
  }

  async function viewTournaments() {
    if (requireLogin()) return;
    const { tournaments } = await api('GET', '/api/tournaments');
    if (!tournaments.length) {
      app.innerHTML = `<div class="card center"><p>No tournaments yet — the first data sync may still be running. Refresh in a minute.</p></div>`;
      return;
    }
    app.innerHTML = `
      <h2>Tournaments</h2>
      <div class="grid">
        ${tournaments.map((t) => `
          <a class="card tournament-card" href="#/t/${t.league_id}">
            ${t.image ? `<img src="${esc(t.image)}" alt="" />` : ''}
            <div>
              <h3>${esc(t.name)}</h3>
              <span class="muted small">${esc(t.country || '')} · ${t.match_count} matches</span>
            </div>
          </a>`).join('')}
      </div>`;
  }

  function matchRow(m, now) {
    const finished = m.status === 'complete';
    const started = now >= m.kickoff_unix;
    const pickBadge = m.my_pick
      ? finished && m.result
        ? `<span class="badge ${m.my_pick === m.result ? 'correct' : 'wrong'}">${m.my_pick === m.result ? '✓' : '✗'} ${esc(m.my_pick)}</span>`
        : `<span class="badge pick">pick: ${esc(m.my_pick)}</span>`
      : started ? '' : `<span class="badge">no pick yet</span>`;
    return `
      <a class="match-row" href="#/m/${m.match_id}">
        <div class="teams">
          <span class="team">${m.home_logo ? `<img src="${esc(m.home_logo)}" alt="">` : ''}${esc(m.home_team)}
            ${finished ? `<span class="score">${m.home_score}</span>` : ''}</span>
          <span class="team">${m.away_logo ? `<img src="${esc(m.away_logo)}" alt="">` : ''}${esc(m.away_team)}
            ${finished ? `<span class="score">${m.away_score}</span>` : ''}</span>
        </div>
        ${pickBadge}
        <span class="when">${finished ? 'FT' : started ? 'in play / awaiting result' : fmtDate(m.kickoff_unix)}</span>
      </a>`;
  }

  async function viewTournament(leagueId, tab) {
    if (requireLogin()) return;
    tab = tab || 'fixtures';
    const { tournament, matches, now } = await api('GET', `/api/tournaments/${leagueId}/matches`);
    const tabs = ['fixtures', 'results', 'rankings', 'history'];
    let content = '';

    if (tab === 'fixtures') {
      const upcoming = matches.filter((m) => m.status !== 'complete');
      content = upcoming.length
        ? upcoming.map((m) => matchRow(m, now)).join('')
        : '<p class="muted center">No upcoming fixtures.</p>';
    } else if (tab === 'results') {
      const done = matches.filter((m) => m.status === 'complete').reverse();
      content = done.length
        ? done.map((m) => matchRow(m, now)).join('')
        : '<p class="muted center">No results yet.</p>';
    } else if (tab === 'rankings') {
      const { rankings } = await api('GET', `/api/tournaments/${leagueId}/rankings`);
      content = rankings.length
        ? `<table><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num">Correct</th><th class="num">Predicted</th></tr>
           ${rankings.map((r, i) => `
             <tr><td>${i + 1}</td><td>${esc(r.username)}${user && r.username === user.username ? ' <span class="badge pick">you</span>' : ''}</td>
             <td class="num"><b>${r.points}</b></td><td class="num">${r.correct}</td><td class="num">${r.predicted}</td></tr>`).join('')}
           </table>`
        : '<p class="muted center">Nobody has scored points yet.</p>';
    } else if (tab === 'history') {
      const { history } = await api('GET', `/api/tournaments/${leagueId}/history`);
      content = history.length
        ? history.map((m) => matchRow(m, now)).join('')
        : '<p class="muted center">You have not predicted any matches in this tournament yet.</p>';
    }

    app.innerHTML = `
      <h2>${esc(tournament.name)} <span class="muted small">${esc(tournament.season_year || '')}</span></h2>
      <div class="tabs">
        ${tabs.map((t) => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      <div class="card" style="padding:0.4rem">${content}</div>`;
    app.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { location.hash = `#/t/${leagueId}/${b.dataset.tab}`; };
    });
  }

  function oddsTable(odds) {
    const row = (label, h, d, a) =>
      `<tr><td>${label}</td><td class="num">${h ?? '—'}</td><td class="num">${d ?? '—'}</td><td class="num">${a ?? '—'}</td></tr>`;
    return `
      <table>
        <tr><th>Bookmaker</th><th class="num">1 (home)</th><th class="num">X (draw)</th><th class="num">2 (away)</th></tr>
        ${row('DraftKings', odds.dk_home, odds.dk_draw, odds.dk_away)}
        ${row('1xbet', odds.xb_home, odds.xb_draw, odds.xb_away)}
      </table>`;
  }

  async function viewMatch(matchId) {
    if (requireLogin()) return;
    const data = await api('GET', `/api/matches/${matchId}`);
    const m = data.match;
    const finished = m.status === 'complete';

    const pickButtons = m.locked
      ? ''
      : `<div class="pick-buttons">
          ${['home', 'draw', 'away'].map((p) => `
            <button data-pick="${p}" class="${m.my_pick === p ? 'selected' : ''}">
              ${p === 'home' ? esc(m.home_team) + ' wins' : p === 'draw' ? 'Draw' : esc(m.away_team) + ' wins'}
            </button>`).join('')}
        </div>
        <p class="muted small center">You can change your pick until kickoff.</p>`;

    const picksList = m.picks
      ? `<h3 class="section-title">Everyone's picks</h3>
         ${m.picks.length ? `<table><tr><th>Player</th><th>Pick</th><th></th></tr>
           ${m.picks.map((p) => `
             <tr><td>${esc(p.username)}</td><td>${esc(p.pick)}</td>
             <td>${p.correct === null ? '' : p.correct ? '<span class="badge correct">✓ correct</span>' : '<span class="badge wrong">✗</span>'}</td></tr>`).join('')}
           </table>` : '<p class="muted">Nobody predicted this match.</p>'}`
      : '';

    app.innerHTML = `
      <p><a class="muted" href="#/t/${m.league_id}">← back to tournament</a></p>
      <div class="card">
        <div class="match-head">
          <div class="side">${m.home_logo ? `<img src="${esc(m.home_logo)}" alt="">` : ''}<b>${esc(m.home_team)}</b></div>
          <div class="vs">${finished ? `${m.home_score} : ${m.away_score}` : 'vs'}</div>
          <div class="side">${m.away_logo ? `<img src="${esc(m.away_logo)}" alt="">` : ''}<b>${esc(m.away_team)}</b></div>
        </div>
        <p class="center muted">${fmtDate(m.kickoff_unix)}${finished ? ' · full time' : m.locked ? ' · in play / awaiting result' : ''}</p>
        ${finished && m.my_pick ? `<p class="center">Your pick: <b>${esc(m.my_pick)}</b> ${m.my_pick === m.result ? '<span class="badge correct">✓ +1 point</span>' : '<span class="badge wrong">✗ 0 points</span>'}</p>` : ''}
        ${pickButtons}
      </div>

      <div class="card" id="oddsCard">
        <h3 class="section-title" style="margin-top:0">Odds (match winner)</h3>
        <div id="oddsBody"></div>
      </div>
      ${picksList ? `<div class="card">${picksList}</div>` : ''}`;

    app.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api('PUT', `/api/matches/${matchId}/prediction`, { pick: b.dataset.pick });
          toast('Pick saved: ' + b.dataset.pick, true);
          viewMatch(matchId);
        } catch (err) { toast(err.message); }
      };
    });

    renderOdds(matchId, data.odds, data.odds_refresh_in, data.now);
  }

  function renderOdds(matchId, odds, refreshIn, serverNow) {
    const body = document.getElementById('oddsBody');
    if (!body) return;
    clearInterval(countdownTimer);

    const info = odds && odds.fetched_at
      ? `<p class="muted small">Updated ${agoMin(odds.fetched_at, serverNow)} min ago by ${esc(odds.fetched_by || '?')}.</p>`
      : '<p class="muted small">No odds fetched yet — be the first to press refresh.</p>';
    const table = odds && !odds.no_match && odds.fetched_at ? oddsTable(odds) : '';
    const noMatch = odds && odds.no_match
      ? '<p class="muted">No matching betting event was found for this match — odds unavailable.</p>'
      : '';

    body.innerHTML = `${table}${noMatch}${info}
      <button id="oddsRefresh">Refresh odds</button>
      <span class="muted small" id="oddsCountdown"></span>`;

    const btn = document.getElementById('oddsRefresh');
    const cd = document.getElementById('oddsCountdown');
    let remaining = refreshIn;

    const applyLockState = () => {
      if (remaining > 0) {
        btn.disabled = true;
        cd.textContent = ` next refresh available in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
      } else {
        btn.disabled = false;
        cd.textContent = '';
        clearInterval(countdownTimer);
      }
    };
    applyLockState();
    if (remaining > 0) {
      countdownTimer = setInterval(() => { remaining -= 1; applyLockState(); }, 1000);
    }

    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/matches/${matchId}/odds/refresh`);
        toast(r.status === 'no_match' ? 'No matching betting event found.' : 'Odds updated.', r.status !== 'no_match');
        renderOdds(matchId, r.odds, r.odds_refresh_in, Math.floor(Date.now() / 1000));
      } catch (err) {
        if (err.status === 429 && err.data) {
          toast('Someone refreshed recently — odds are locked for a few minutes.');
          renderOdds(matchId, err.data.odds, err.data.odds_refresh_in, Math.floor(Date.now() / 1000));
        } else {
          toast(err.message);
          btn.disabled = false;
        }
      }
    };
  }

  // ---- router ---------------------------------------------------------

  async function route() {
    clearInterval(countdownTimer);
    const hash = location.hash || '#/';
    const parts = hash.slice(2).split('/').filter(Boolean);
    try {
      if (hash === '#/login') return viewLogin();
      if (parts.length === 0) return await viewTournaments();
      if (parts[0] === 't' && parts[1]) return await viewTournament(parts[1], parts[2]);
      if (parts[0] === 'm' && parts[1]) return await viewMatch(parts[1]);
      location.hash = '#/';
    } catch (err) {
      if (err.status === 401) { user = null; renderNav(); location.hash = '#/login'; return; }
      app.innerHTML = `<div class="card center"><p>Something went wrong: ${esc(err.message)}</p></div>`;
    }
  }

  window.addEventListener('hashchange', route);

  (async () => {
    try {
      const r = await api('GET', '/api/me');
      user = r.user;
    } catch { user = null; }
    renderNav();
    route();
  })();
})();
