/* Kèo máu frontend (GitHub Pages build).
   Talks to a Google Apps Script Web App: every call is a POST with a
   text/plain JSON body {action, token, ...}. Errors arrive as {error, code}. */
(() => {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  let user = null;
  let countdownTimer = null;

  const MODE_LABEL = {
    '1x2': 'Win / Draw / Loss (knockout: Win / Loss)',
    wl: 'Win / Loss (who advances)',
    handicap: 'Goal handicap',
  };

  // ---- API layer -------------------------------------------------------

  function apiUrl() {
    const url = (window.VIBE_CONFIG || {}).API_URL || '';
    if (!url || url.indexOf('PASTE_') === 0) {
      app.innerHTML = `<div class="card center"><p>⚠️ The site isn't connected to its backend yet.<br>
        Edit <code>docs/config.js</code> and paste your Apps Script Web App URL (see README).</p></div>`;
      throw new Error('API_URL not configured');
    }
    return url;
  }

  async function api(action, payload = {}) {
    const body = { action, token: localStorage.getItem('vibe_token') || undefined, ...payload };
    let res;
    try {
      res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('network error — is the Apps Script URL correct?'), { code: 0 });
    }
    const data = await res.json();
    if (data && data.error) {
      throw Object.assign(new Error(data.error), { code: data.code || 500, data });
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

  function busy(message = 'Loading…') {
    app.innerHTML = `<p class="muted center">${message}</p>`;
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

  function fmtLine(hdp) {
    if (hdp == null) return '';
    const n = Number(hdp);
    return n > 0 ? `+${n}` : `${n}`;
  }

  function agoMin(unixThen, unixNow) {
    return Math.max(0, Math.round((unixNow - unixThen) / 60));
  }

  // "2 – 2 (pens 3–5)" / "(AET)"
  function extraScore(m) {
    if (m.pen_home != null && m.pen_away != null) return ` <span class="muted small">(pens ${m.pen_home}–${m.pen_away})</span>`;
    if (Number(m.aet)) return ' <span class="muted small">(AET)</span>';
    return '';
  }

  function outcomeBadge(outcome, points) {
    if (outcome === 'correct') return `<span class="badge correct">✓ +${points}</span>`;
    if (outcome === 'wrong') return '<span class="badge wrong">✗ 0</span>';
    if (outcome === 'push') return '<span class="badge">push</span>';
    if (outcome === 'void') return '<span class="badge">void</span>';
    return '';
  }

  function pickLabel(m, pick, hdp) {
    if (pick === 'draw') return 'Draw';
    const team = pick === 'home' ? m.home_team : m.away_team;
    if (hdp != null) {
      const line = pick === 'home' ? Number(hdp) : -Number(hdp);
      return `${team} ${fmtLine(line)}`;
    }
    return team;
  }

  function renderNav() {
    nav.innerHTML = user
      ? `${user.is_admin ? '<a class="btn" href="#/admin">⚙ Admin</a>' : ''}
         <span class="user">👤 ${esc(user.username)}</span> <button id="logoutBtn">Log out</button>`
      : '';
    const b = document.getElementById('logoutBtn');
    if (b) b.onclick = async () => {
      try { await api('logout'); } catch { /* token already dead is fine */ }
      localStorage.removeItem('vibe_token');
      user = null;
      renderNav();
      location.hash = '#/login';
    };
  }

  function requireLogin() {
    if (!user) { location.hash = '#/login'; return true; }
    return false;
  }

  // ---- auth view ---------------------------------------------------------

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
      submit.disabled = true;
      try {
        const r = await api(mode, {
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        });
        localStorage.setItem('vibe_token', r.token);
        user = r.user;
        renderNav();
        location.hash = '#/';
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    };
  }

  // ---- tournaments -------------------------------------------------------

  async function viewTournaments() {
    if (requireLogin()) return;
    busy('Loading tournaments…');
    const { tournaments } = await api('tournaments');
    if (!tournaments.length) {
      app.innerHTML = `<div class="card center"><p>No tournaments are visible right now.</p></div>`;
      return;
    }
    app.innerHTML = `
      <h2>Tournaments</h2>
      <div class="grid">
        ${tournaments.map((t) => `
          <a class="card tournament-card ${Number(t.visible) ? '' : 'dimmed'}" href="#/t/${t.league_id}">
            ${t.image ? `<img src="${esc(t.image)}" alt="" />` : ''}
            <div>
              <h3>${esc(t.name)} ${Number(t.visible) ? '' : '<span class="badge">hidden</span>'}</h3>
              <span class="muted small">${esc(t.country || '')} · ${t.match_count} matches · ${MODE_LABEL[t.guess_mode] || t.guess_mode}</span>
            </div>
          </a>`).join('')}
      </div>`;
  }

  // ---- match rows / grouping by round -------------------------------------

  function matchRow(m, now) {
    const finished = m.status === 'complete';
    const started = now >= m.kickoff_unix;
    let pickBadge = '';
    if (m.my_pick) {
      pickBadge = m.my_outcome
        ? outcomeBadge(m.my_outcome, m.my_points)
        : `<span class="badge pick">pick: ${esc(pickLabel(m, m.my_pick, m.my_hdp))}</span>`;
    } else if (!started) {
      pickBadge = '<span class="badge">no pick yet</span>';
    }
    const ptsBadge = m.points !== 1 ? `<span class="badge">${m.points} pts</span>` : '';
    return `
      <a class="match-row" href="#/m/${m.match_id}">
        <div class="teams">
          <span class="team">${m.home_logo ? `<img src="${esc(m.home_logo)}" alt="">` : ''}${esc(m.home_team)}
            ${m.adv === 'home' && finished ? '▸' : ''}
            ${finished ? `<span class="score">${m.home_score}</span>` : ''}</span>
          <span class="team">${m.away_logo ? `<img src="${esc(m.away_logo)}" alt="">` : ''}${esc(m.away_team)}
            ${m.adv === 'away' && finished ? '▸' : ''}
            ${finished ? `<span class="score">${m.away_score}</span>` : ''}</span>
        </div>
        ${finished ? extraScore(m) : ''}
        ${ptsBadge}
        ${pickBadge}
        <span class="when">${finished ? 'FT' : started ? 'in play / awaiting result' : fmtDate(m.kickoff_unix)}</span>
      </a>`;
  }

  // Group a match list under round / matchday headers, in kickoff order.
  function groupedRows(matches, now) {
    let html = '';
    let lastHeader = null;
    for (const m of matches) {
      const header = m.is_group && Number(m.game_week) > 0
        ? `${m.round_name === 'Season' ? 'Matchday' : m.round_name + ' · Matchday'} ${m.game_week}`
        : (m.round_name || 'Matches');
      if (header !== lastHeader) {
        html += `<h3 class="section-title">${esc(header)}</h3>`;
        lastHeader = header;
      }
      html += matchRow(m, now);
    }
    return html;
  }

  // ---- standings / groups (computed from group-stage results) -------------

  function computeTables(matches, rounds) {
    const groupRoundIds = new Set(rounds.filter((r) => r.is_group).map((r) => String(r.round_id)));
    const gm = matches.filter((m) => groupRoundIds.has(String(m.round_id)));
    if (!gm.length) return [];
    // connected components over teams (a group = teams that play each other)
    const parent = {};
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const m of gm) {
      parent[m.home_team] ??= m.home_team;
      parent[m.away_team] ??= m.away_team;
      parent[find(m.home_team)] = find(m.away_team);
    }
    const comps = {};
    for (const m of gm) {
      const key = find(m.home_team);
      (comps[key] ??= { teams: new Map(), first: m.kickoff_unix, matches: [] });
      comps[key].first = Math.min(comps[key].first, m.kickoff_unix);
      comps[key].matches.push(m);
    }
    const tables = Object.values(comps).map((c) => {
      const row = (team, logo) => c.teams.get(team) ||
        c.teams.set(team, { team, logo, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }).get(team);
      for (const m of c.matches) {
        const h = row(m.home_team, m.home_logo);
        const a = row(m.away_team, m.away_logo);
        if (m.status !== 'complete' || m.home_score == null) continue;
        h.p++; a.p++;
        h.gf += m.home_score; h.ga += m.away_score;
        a.gf += m.away_score; a.ga += m.home_score;
        if (m.home_score > m.away_score) { h.w++; a.l++; h.pts += 3; }
        else if (m.home_score < m.away_score) { a.w++; h.l++; a.pts += 3; }
        else { h.d++; a.d++; h.pts++; a.pts++; }
      }
      const rows = [...c.teams.values()].sort(
        (x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.team.localeCompare(y.team)
      );
      return { first: c.first, rows };
    });
    tables.sort((a, b) => a.first - b.first);
    return tables;
  }

  function tableHtml(rows) {
    return `<table>
      <tr><th></th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th>
      <th class="num">L</th><th class="num">GF</th><th class="num">GA</th><th class="num">GD</th><th class="num">Pts</th></tr>
      ${rows.map((r, i) => `
        <tr><td>${i + 1}</td>
        <td><span class="team">${r.logo ? `<img src="${esc(r.logo)}" alt="" style="width:16px;height:16px;object-fit:contain">` : ''} ${esc(r.team)}</span></td>
        <td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td>
        <td class="num">${r.gf}</td><td class="num">${r.ga}</td><td class="num">${r.gf - r.ga}</td>
        <td class="num"><b>${r.pts}</b></td></tr>`).join('')}
    </table>`;
  }

  function knockoutHtml(matches, rounds, now) {
    const ko = rounds.filter((r) => !r.is_group);
    if (!ko.length) return '<p class="muted center">No knockout rounds (yet).</p>';
    return ko.map((r) => {
      const ms = matches.filter((m) => String(m.round_id) === String(r.round_id));
      return `<h3 class="section-title">${esc(r.name)} ${r.points !== 1 ? `<span class="badge">${r.points} pts per match</span>` : ''}</h3>
        ${ms.map((m) => matchRow(m, now)).join('')}`;
    }).join('');
  }

  // ---- tournament view -----------------------------------------------------

  async function viewTournament(leagueId, tab) {
    if (requireLogin()) return;
    tab = tab || 'fixtures';
    busy('Loading matches…');
    const { tournament, rounds, matches, now } = await api('matches', { league_id: Number(leagueId) });
    const hasKnockout = rounds.some((r) => !r.is_group);
    const hasGroups = rounds.some((r) => r.is_group);
    const tabs = ['fixtures', 'results'];
    if (hasGroups) tabs.push('table');
    if (hasKnockout) tabs.push('knockout');
    tabs.push('rankings', 'history');
    const tabName = { fixtures: 'Fixtures', results: 'Results', table: 'Table', knockout: 'Knockout', rankings: 'Rankings', history: 'History' };
    if (!tabs.includes(tab)) tab = 'fixtures';
    let content = '';

    if (tab === 'fixtures') {
      const upcoming = matches.filter((m) => m.status !== 'complete');
      content = upcoming.length ? groupedRows(upcoming, now) : '<p class="muted center">No upcoming fixtures.</p>';
    } else if (tab === 'results') {
      const done = matches.filter((m) => m.status === 'complete').reverse();
      content = done.length ? groupedRows(done, now) : '<p class="muted center">No results yet.</p>';
    } else if (tab === 'table') {
      const tables = computeTables(matches, rounds);
      content = tables.length
        ? tables.map((t, i) => `${tables.length > 1 ? `<h3 class="section-title">Group ${i + 1}</h3>` : ''}${tableHtml(t.rows)}`).join('')
        : '<p class="muted center">No table available.</p>';
    } else if (tab === 'knockout') {
      content = knockoutHtml(matches, rounds, now);
    } else if (tab === 'rankings') {
      const { rankings, max_points } = await api('rankings', { league_id: Number(leagueId) });
      const maxLine = max_points != null
        ? `<p class="muted small center">Highest obtainable score for this tournament: <b>${max_points}</b> points
           (every match predicted correctly).</p>`
        : '';
      content = maxLine + (rankings.length
        ? `<table><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num">Correct</th><th class="num">Predicted</th></tr>
           ${rankings.map((r, i) => `
             <tr><td>${i + 1}</td><td>${esc(r.username)}${user && r.username === user.username ? ' <span class="badge pick">you</span>' : ''}</td>
             <td class="num"><b>${r.points}</b> <span class="muted small">/ ${max_points}</span></td><td class="num">${r.correct}</td><td class="num">${r.predicted}</td></tr>`).join('')}
           </table>`
        : '<p class="muted center">Nobody has scored points yet.</p>');
    } else if (tab === 'history') {
      const { history } = await api('history', { league_id: Number(leagueId) });
      content = history.length
        ? history.map((m) => matchRow(m, now)).join('')
        : '<p class="muted center">You have not predicted any matches in this tournament yet.</p>';
    }

    app.innerHTML = `
      <h2>${esc(tournament.name)} <span class="muted small">${esc(tournament.season_year || '')} · ${MODE_LABEL[tournament.guess_mode]}</span></h2>
      <div class="tabs">
        ${tabs.map((t) => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${tabName[t]}</button>`).join('')}
      </div>
      <div class="card" style="padding:0.4rem 0.8rem">${content}</div>`;
    app.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { location.hash = `#/t/${leagueId}/${b.dataset.tab}`; };
    });
  }

  // ---- match view ------------------------------------------------------------

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

  function pickButtonsHtml(m, mode) {
    if (mode === 'handicap' && m.hdp == null) {
      return '<p class="muted center">The admin has not set the handicap line for this match yet — picks open once it\'s set.</p>';
    }
    let options;
    if (mode === '1x2') {
      options = [
        ['home', `${esc(m.home_team)} wins`],
        ['draw', 'Draw'],
        ['away', `${esc(m.away_team)} wins`],
      ];
    } else if (mode === 'wl') {
      options = [
        ['home', `${esc(m.home_team)} advances`],
        ['away', `${esc(m.away_team)} advances`],
      ];
    } else {
      options = [
        ['home', `${esc(m.home_team)} ${fmtLine(m.hdp)}`],
        ['away', `${esc(m.away_team)} ${fmtLine(-m.hdp)}`],
      ];
    }
    return `<div class="pick-buttons">
        ${options.map(([p, label]) => `
          <button data-pick="${p}" class="${m.my_pick === p ? 'selected' : ''}">${label}</button>`).join('')}
      </div>
      <p class="muted small center">You can change your pick until kickoff. This match is worth <b>${m.points}</b> point${m.points === 1 ? '' : 's'}.</p>`;
  }

  async function viewMatch(matchId) {
    if (requireLogin()) return;
    busy('Loading match…');
    const data = await api('match', { match_id: Number(matchId) });
    const m = data.match;
    // knockout matches in 1x2 tournaments are picked win/loss (who advances)
    const mode = m.mode || data.tournament.guess_mode;
    const finished = m.status === 'complete';

    const picksList = m.picks
      ? `<h3 class="section-title">Everyone's picks</h3>
         ${m.picks.length ? `<table><tr><th>Player</th><th>Pick</th><th></th></tr>
           ${m.picks.map((p) => `
             <tr><td>${esc(p.username)}</td><td>${esc(pickLabel(m, p.pick, p.hdp))}</td>
             <td>${p.outcome ? outcomeBadge(p.outcome, p.points) : ''}</td></tr>`).join('')}
           </table>` : '<p class="muted">Nobody predicted this match.</p>'}`
      : '';

    const advNote = finished && m.adv && m.result === 'draw'
      ? `<p class="center"><b>${esc(m.adv === 'home' ? m.home_team : m.away_team)}</b> advance${m.pen_home != null ? ` on penalties (${m.pen_home}–${m.pen_away})` : Number(m.aet) ? ' after extra time' : ''}.</p>`
      : '';

    app.innerHTML = `
      <p><a class="muted" href="#/t/${m.league_id}">← back to tournament</a></p>
      <div class="card">
        <p class="center muted small">${esc(m.round_name || '')}${mode === 'handicap' && m.hdp != null ? ` · line ${fmtLine(m.hdp)}` : ''} · worth ${m.points} pt${m.points === 1 ? '' : 's'}</p>
        <div class="match-head">
          <div class="side">${m.home_logo ? `<img src="${esc(m.home_logo)}" alt="">` : ''}<b>${esc(m.home_team)}</b></div>
          <div class="vs">${finished ? `${m.home_score} : ${m.away_score}` : 'vs'}</div>
          <div class="side">${m.away_logo ? `<img src="${esc(m.away_logo)}" alt="">` : ''}<b>${esc(m.away_team)}</b></div>
        </div>
        <p class="center muted">${finished ? extraScore(m) + ' ' : ''}${fmtDate(m.kickoff_unix)}${finished ? ' · full time' : m.locked ? ' · in play / awaiting result' : ''}</p>
        ${user.is_admin && m.locked ? '<p class="center"><button id="admFetchResult">⟳ Fetch result now (admin)</button></p>' : ''}
        ${advNote}
        ${finished && m.my_pick ? `<p class="center">Your pick: <b>${esc(pickLabel(m, m.my_pick, m.my_hdp))}</b> ${outcomeBadge(m.my_outcome, m.my_points)}</p>` : ''}
        ${m.locked ? '' : pickButtonsHtml(m, mode)}
      </div>

      <div class="card" id="oddsCard">
        <h3 class="section-title" style="margin-top:0">Odds (match winner)</h3>
        <div id="oddsBody"></div>
      </div>
      ${picksList ? `<div class="card">${picksList}</div>` : ''}`;

    app.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api('predict', { match_id: Number(matchId), pick: b.dataset.pick });
          toast('Pick saved', true);
          viewMatch(matchId);
        } catch (err) { toast(err.message); }
      };
    });

    const fetchBtn = document.getElementById('admFetchResult');
    if (fetchBtn) fetchBtn.onclick = async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = '⟳ Fetching…';
      try {
        const r = await api('admin_sync', { league_id: Number(m.league_id), match_id: Number(matchId) });
        const fresh = r.match;
        toast(fresh && fresh.status === 'complete'
          ? `Result: ${fresh.home_team} ${fresh.home_score}–${fresh.away_score} ${fresh.away_team}`
          : 'Synced — no final result from the data provider yet.', true);
        viewMatch(matchId);
      } catch (err) {
        toast(err.message);
        fetchBtn.disabled = false;
        fetchBtn.textContent = '⟳ Fetch result now (admin)';
      }
    };

    renderOdds(matchId, data.odds, data.odds_refresh_in, data.now);
  }

  function renderOdds(matchId, odds, refreshIn, serverNow) {
    const body = document.getElementById('oddsBody');
    if (!body) return;
    clearInterval(countdownTimer);

    const fetched = !!odds && !Number(odds.no_match) && odds.fetched_at;
    const info = odds && odds.fetched_at
      ? `<p class="muted small">Updated ${agoMin(odds.fetched_at, serverNow)} min ago by ${esc(odds.fetched_by || '?')}.</p>`
      : '<p class="muted small">No odds fetched yet — be the first to press refresh.</p>';
    const table = fetched ? oddsTable(odds) : '';
    const noMatch = odds && Number(odds.no_match)
      ? '<p class="muted">No matching betting event was found for this match — odds unavailable.</p>'
      : '';

    const adminPicker = user && user.is_admin ? `
      <details class="link-odds" ${odds && Number(odds.no_match) ? 'open' : ''}>
        <summary class="muted small">Link the betting event by hand (admin)</summary>
        <p class="muted small">When "Refresh odds" can't find this match (the two data providers sometimes
        name teams differently), list what the odds service is running and pick the right event —
        its odds are used from then on, including future refreshes.</p>
        <button id="oddsSearch">List candidate events</button>
        <div id="oddsCandidates"></div>
      </details>` : '';

    body.innerHTML = `${table}${noMatch}${info}
      <button id="oddsRefresh">Refresh odds</button>
      <span class="muted small" id="oddsCountdown"></span>
      ${adminPicker}`;

    const btn = document.getElementById('oddsRefresh');
    const cd = document.getElementById('oddsCountdown');
    let remaining = refreshIn || 0;

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
      cd.textContent = ' fetching…';
      try {
        const r = await api('odds_refresh', { match_id: Number(matchId) });
        if (r.status === 'locked') toast('Someone refreshed recently — odds are locked for a few minutes.');
        else if (r.status === 'no_match') toast('No matching betting event found.');
        else if (r.status === 'error') toast('Odds service error: ' + (r.error || 'unknown'));
        else toast('Odds updated.', true);
        renderOdds(matchId, r.odds, r.odds_refresh_in, Math.floor(Date.now() / 1000));
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        cd.textContent = '';
      }
    };

    const searchBtn = document.getElementById('oddsSearch');
    if (searchBtn) searchBtn.onclick = async () => {
      const box = document.getElementById('oddsCandidates');
      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching…';
      try {
        const { candidates } = await api('admin_odds_search', { match_id: Number(matchId) });
        searchBtn.textContent = 'List candidate events';
        searchBtn.disabled = false;
        if (!candidates.length) {
          box.innerHTML = '<p class="muted small">The odds service returned no events for either team or this tournament.</p>';
          return;
        }
        box.innerHTML = `
          <table>
            <tr><th>Event</th><th>Kickoff</th><th>League</th><th></th></tr>
            ${candidates.map((c) => `
              <tr>
                <td>${esc(c.home || '?')} – ${esc(c.away || '?')}</td>
                <td class="muted small">${c.date ? fmtDate(c.date) : '?'}</td>
                <td class="muted small">${esc(c.league || '')}</td>
                <td><button class="odds-use" data-event="${esc(String(c.event_id))}">Use</button></td>
              </tr>`).join('')}
          </table>`;
        box.querySelectorAll('.odds-use').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            b.textContent = 'Linking…';
            try {
              const r = await api('admin_odds_link', { match_id: Number(matchId), event_id: b.dataset.event });
              toast('Event linked — odds fetched.', true);
              renderOdds(matchId, r.odds, r.odds_refresh_in, Math.floor(Date.now() / 1000));
            } catch (err) {
              toast(err.message);
              b.disabled = false;
              b.textContent = 'Use';
            }
          };
        });
      } catch (err) {
        toast(err.message);
        searchBtn.disabled = false;
        searchBtn.textContent = 'List candidate events';
      }
    };
  }

  // ---- admin views -----------------------------------------------------------

  function usageCardHtml(usage) {
    const fd = (usage && usage.fd) || {};
    const oa = (usage && usage.oa) || {};
    const fdLine = fd.used != null
      ? `<b>${fd.used}</b>${fd.limit != null ? ` / ${fd.limit}` : ''} requests used this month${fd.plan ? ` · ${esc(String(fd.plan))} plan` : ''}
         <span class="muted small">(reported by the API, ${fd.checked_at ? `as of ${fmtDate(fd.checked_at)}` : 'time unknown'})</span>`
      : `<span class="muted">no usage reported yet — press check below${fd.calls ? `; this script has made ${fd.calls} calls this month` : ''}</span>`;
    const oaLine = `<b>${oa.calls || 0}</b> calls made by this script this month
      <span class="muted small">(the provider has no usage endpoint; its limit is 5,000 requests/hour, so it's never the bottleneck)</span>`;
    return `
      <h3 style="margin-top:0">API usage</h3>
      <p><b>footballdata.io</b> <span class="muted small">fixtures &amp; results — 1000 requests/month on the free plan</span><br>${fdLine}</p>
      <p><b>odds-api.io</b> <span class="muted small">odds &amp; penalties</span><br>${oaLine}</p>
      <button id="usageCheck">⟳ Check usage now</button>
      <span class="muted small">asks footballdata.io for the current numbers</span>`;
  }

  async function viewAdmin() {
    if (requireLogin()) return;
    if (!user.is_admin) { location.hash = '#/'; return; }
    busy('Loading admin…');
    const { tournaments, usage } = await api('admin_overview');
    app.innerHTML = `
      <h2>⚙ Admin</h2>
      <p class="muted small">Changes apply immediately for everyone. Hidden tournaments/matches disappear
      from players' views but keep their data.</p>
      <div class="card" id="usageCard">${usageCardHtml(usage)}</div>
      ${tournaments.map((t) => `
        <div class="card" data-league="${t.league_id}">
          <h3 style="margin-top:0">${esc(t.name)} <span class="muted small">${esc(t.season_year || '')} · ${t.match_count} matches</span></h3>
          <div class="admin-grid">
            <label><input type="checkbox" class="adm-visible" ${Number(t.visible) ? 'checked' : ''}/> visible to players</label>
            <label>Guess mode:
              <select class="adm-mode">
                <option value="1x2" ${t.guess_mode === '1x2' ? 'selected' : ''}>Win / Draw / Loss (knockout rounds auto Win / Loss)</option>
                <option value="wl" ${t.guess_mode === 'wl' ? 'selected' : ''}>Win / Loss everywhere (who advances)</option>
                <option value="handicap" ${t.guess_mode === 'handicap' ? 'selected' : ''}>Goal handicap</option>
              </select>
            </label>
            <label>Default points per match:
              <input type="number" class="adm-points" min="0" step="0.5" value="${t.default_points}" style="width:5rem"/>
            </label>
          </div>
          ${t.rounds.length > 1 ? `
            <h4 class="section-title">Points per round</h4>
            <table>${t.rounds.map((r) => `
              <tr><td>${esc(r.name)}</td><td class="muted small">${r.count} matches</td>
              <td class="num"><input type="number" class="adm-round" data-round="${r.round_id}" min="0" step="0.5"
                value="${(t.round_points || {})[String(r.round_id)] ?? ''}" placeholder="${t.default_points}" style="width:5rem"/></td></tr>`).join('')}
            </table>
            <p class="muted small">Empty = use the default points.</p>` : ''}
          <div style="display:flex; gap:0.6rem; margin-top:0.7rem; align-items:center; flex-wrap:wrap">
            <button class="primary adm-save">Save</button>
            <a class="btn" href="#/admin/t/${t.league_id}">Manage matches →</a>
            <button class="adm-sync">⟳ Sync fixtures &amp; results now</button>
            <span class="muted small">${t.last_synced ? `last synced ${fmtDate(t.last_synced)}` : 'never synced'}</span>
          </div>
        </div>`).join('')}`;

    const bindUsageCheck = () => {
      const btn = document.getElementById('usageCheck');
      if (!btn) return;
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '⟳ Checking…';
        try {
          const r = await api('admin_usage');
          document.getElementById('usageCard').innerHTML = usageCardHtml(r.usage);
          bindUsageCheck();
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = '⟳ Check usage now';
        }
      };
    };
    bindUsageCheck();

    app.querySelectorAll('.adm-sync').forEach((btn) => {
      btn.onclick = async () => {
        const card = btn.closest('[data-league]');
        btn.disabled = true;
        btn.textContent = '⟳ Syncing…';
        try {
          await api('admin_sync', { league_id: Number(card.dataset.league) });
          toast('Fixtures & results synced.', true);
          viewAdmin();
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = '⟳ Sync fixtures & results now';
        }
      };
    });

    app.querySelectorAll('.adm-save').forEach((btn) => {
      btn.onclick = async () => {
        const card = btn.closest('[data-league]');
        const round_points = {};
        card.querySelectorAll('.adm-round').forEach((inp) => {
          if (inp.value !== '') round_points[inp.dataset.round] = Number(inp.value);
        });
        btn.disabled = true;
        try {
          await api('admin_tournament', {
            league_id: Number(card.dataset.league),
            visible: card.querySelector('.adm-visible').checked ? 1 : 0,
            guess_mode: card.querySelector('.adm-mode').value,
            default_points: Number(card.querySelector('.adm-points').value),
            round_points,
          });
          toast('Saved.', true);
        } catch (err) { toast(err.message); } finally { btn.disabled = false; }
      };
    });
  }

  async function viewAdminMatches(leagueId) {
    if (requireLogin()) return;
    if (!user.is_admin) { location.hash = '#/'; return; }
    busy('Loading matches…');
    const { tournament, matches, now } = await api('matches', { league_id: Number(leagueId) });
    const isHandicap = tournament.guess_mode === 'handicap';
    app.innerHTML = `
      <p><a class="muted" href="#/admin">← back to admin</a></p>
      <h2>${esc(tournament.name)} — matches</h2>
      <p class="muted small">Untick "show" to hide a match from players.${isHandicap ? ' Set the handicap line (e.g. -0.5 means the home team gives half a goal); players can only pick once a line is set.' : ''}</p>
      <p><button id="admSyncNow">⟳ Sync fixtures &amp; results now</button>
        <span class="muted small">${tournament.last_synced ? `last synced ${fmtDate(tournament.last_synced)}` : 'never synced'}</span></p>
      <div class="card" style="padding:0.4rem 0.8rem">
        <table>
          <tr><th>show</th><th>Match</th><th>Kickoff</th><th>Status</th>${isHandicap ? '<th>Line (home)</th>' : ''}<th></th></tr>
          ${matches.map((m) => `
            <tr data-match="${m.match_id}">
              <td><input type="checkbox" class="adm-show" ${Number(m.hidden) ? '' : 'checked'}/></td>
              <td>${esc(m.home_team)} – ${esc(m.away_team)}
                  ${m.status === 'complete' ? `<span class="score">${m.home_score}-${m.away_score}</span>${extraScore(m)}` : ''}</td>
              <td class="muted small">${fmtDate(m.kickoff_unix)}</td>
              <td class="muted small">${esc(m.round_name || '')}${now >= m.kickoff_unix ? ' · locked' : ''}</td>
              ${isHandicap ? `<td><input type="number" class="adm-hdp" step="0.25" value="${m.hdp ?? ''}" placeholder="—" style="width:5rem"/></td>` : ''}
              <td>${m.status !== 'complete' && now >= m.kickoff_unix
                ? '<button class="adm-fetch" title="Fetch this match’s result now">⟳ result</button>' : ''}</td>
            </tr>`).join('')}
        </table>
      </div>`;

    const save = async (tr, payload) => {
      try {
        await api('admin_match', { match_id: Number(tr.dataset.match), ...payload });
        toast('Saved.', true);
      } catch (err) { toast(err.message); }
    };
    app.querySelectorAll('.adm-show').forEach((inp) => {
      inp.onchange = () => save(inp.closest('tr'), { hidden: inp.checked ? 0 : 1 });
    });
    app.querySelectorAll('.adm-hdp').forEach((inp) => {
      inp.onchange = () => save(inp.closest('tr'), { hdp: inp.value === '' ? null : Number(inp.value) });
    });

    const syncTournament = async (btn, match_id) => {
      btn.disabled = true;
      try {
        const r = await api('admin_sync', {
          league_id: Number(leagueId),
          ...(match_id != null ? { match_id } : {}),
        });
        const fresh = r.match;
        if (match_id != null) {
          toast(fresh && fresh.status === 'complete'
            ? `Result: ${fresh.home_team} ${fresh.home_score}–${fresh.away_score} ${fresh.away_team}`
            : 'Synced — no final result from the data provider yet.', true);
        } else {
          toast('Fixtures & results synced.', true);
        }
        viewAdminMatches(leagueId);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
    document.getElementById('admSyncNow').onclick = (e) => syncTournament(e.target);
    app.querySelectorAll('.adm-fetch').forEach((btn) => {
      btn.onclick = () => syncTournament(btn, Number(btn.closest('tr').dataset.match));
    });
  }

  // ---- router -----------------------------------------------------------------

  async function route() {
    clearInterval(countdownTimer);
    const hash = location.hash || '#/';
    const parts = hash.slice(2).split('/').filter(Boolean);
    try {
      if (hash === '#/login') return viewLogin();
      if (parts.length === 0) return await viewTournaments();
      if (parts[0] === 'admin' && parts[1] === 't' && parts[2]) return await viewAdminMatches(parts[2]);
      if (parts[0] === 'admin') return await viewAdmin();
      if (parts[0] === 't' && parts[1]) return await viewTournament(parts[1], parts[2]);
      if (parts[0] === 'm' && parts[1]) return await viewMatch(parts[1]);
      location.hash = '#/';
    } catch (err) {
      if (err.code === 401) {
        localStorage.removeItem('vibe_token');
        user = null;
        renderNav();
        location.hash = '#/login';
        return;
      }
      app.innerHTML = `<div class="card center"><p>Something went wrong: ${esc(err.message)}</p></div>`;
    }
  }

  window.addEventListener('hashchange', route);

  (async () => {
    if (localStorage.getItem('vibe_token')) {
      try {
        const r = await api('me');
        user = r.user;
      } catch {
        localStorage.removeItem('vibe_token');
      }
    }
    renderNav();
    route();
  })();
})();
