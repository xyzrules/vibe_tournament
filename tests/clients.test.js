const test = require('node:test');
const assert = require('node:assert');
const { makeFdClient } = require('../src/footballdata');
const { makeOaClient } = require('../src/oddsapi');

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift() || { status: 200, body: {} };
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('fd client sends Bearer auth and unwraps data', async () => {
  const fetchFn = fakeFetch([{ body: { success: true, data: [{ league_id: 15 }] } }]);
  const fd = makeFdClient({ key: 'k123', fetchFn });
  const leagues = await fd.leagues();
  assert.deepStrictEqual(leagues, [{ league_id: 15 }]);
  assert.strictEqual(fetchFn.calls[0].url, 'https://footballdata.io/api/v1/leagues');
  assert.strictEqual(fetchFn.calls[0].opts.headers.Authorization, 'Bearer k123');
  assert.strictEqual(fd.requestCount, 1);
});

test('fd seasonMatchesPage paginates with limit=100 and surfaces total_pages', async () => {
  const fetchFn = fakeFetch([
    {
      body: {
        success: true,
        data: { matches: [{ match_id: 1 }] },
        meta: { pagination: { page: 2, limit: 100, total: 380, total_pages: 4 } },
      },
    },
  ]);
  const fd = makeFdClient({ key: 'k', fetchFn });
  const r = await fd.seasonMatchesPage(105, 2);
  assert.strictEqual(fetchFn.calls[0].url, 'https://footballdata.io/api/v1/seasons/105/matches?limit=100&page=2');
  assert.deepStrictEqual(r.matches, [{ match_id: 1 }]);
  assert.strictEqual(r.totalPages, 4);
});

test('fd client throws on HTTP error and API-level failure', async () => {
  const fd1 = makeFdClient({ key: 'k', fetchFn: fakeFetch([{ status: 500, body: {} }]) });
  await assert.rejects(() => fd1.leagues(), /HTTP 500/);
  const fd2 = makeFdClient({ key: 'k', fetchFn: fakeFetch([{ body: { success: false, message: 'nope' } }]) });
  await assert.rejects(() => fd2.seasons(15), /nope/);
});

test('oa client passes apiKey, sport and bookmakers as query params', async () => {
  const fetchFn = fakeFetch([
    { body: [{ id: 1 }] },
    { body: { id: 1, bookmakers: {} } },
  ]);
  const oa = makeOaClient({ key: 'secret', fetchFn });
  const events = await oa.searchEvents('Canada');
  assert.deepStrictEqual(events, [{ id: 1 }]);
  const u1 = new URL(fetchFn.calls[0].url);
  assert.strictEqual(u1.origin + u1.pathname, 'https://api.odds-api.io/v3/events/search');
  assert.strictEqual(u1.searchParams.get('query'), 'Canada');
  assert.strictEqual(u1.searchParams.get('sport'), 'football');
  assert.strictEqual(u1.searchParams.get('apiKey'), 'secret');

  await oa.odds(42);
  const u2 = new URL(fetchFn.calls[1].url);
  assert.strictEqual(u2.searchParams.get('eventId'), '42');
  assert.strictEqual(u2.searchParams.get('bookmakers'), 'DraftKings,1xbet');
  assert.strictEqual(oa.requestCount, 2);
});

test('oa searchEvents tolerates enveloped responses', async () => {
  const oa = makeOaClient({ key: 'k', fetchFn: fakeFetch([{ body: { data: [{ id: 7 }] } }]) });
  assert.deepStrictEqual(await oa.searchEvents('x'), [{ id: 7 }]);
});
