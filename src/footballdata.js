// Client for footballdata.io (fixtures & results).
// Free plan budget is 1000 requests/month, so ONLY the sync scheduler may
// call this — never per-page-view code.

const BASE = 'https://footballdata.io/api/v1';

function makeFdClient({ key, fetchFn = fetch }) {
  const client = { requestCount: 0 };

  async function get(pathname) {
    client.requestCount += 1;
    const res = await fetchFn(`${BASE}${pathname}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`footballdata.io HTTP ${res.status}`);
    const body = await res.json();
    if (body && body.success === false) {
      throw new Error(`footballdata.io error: ${body.message || 'unknown'}`);
    }
    return body;
  }

  client.leagues = async () => (await get('/leagues')).data;
  client.seasons = async (leagueId) => (await get(`/leagues/${leagueId}/seasons`)).data;
  // The matches endpoint paginates (max 100 per page); returns one page plus
  // the page count so the sync engine can loop.
  client.seasonMatchesPage = async (seasonId, page = 1) => {
    const body = await get(`/seasons/${seasonId}/matches?limit=100&page=${page}`);
    const matches = (body.data && body.data.matches) || [];
    const pg = body.meta && body.meta.pagination;
    return { matches, totalPages: (pg && pg.total_pages) || 1 };
  };
  return client;
}

module.exports = { makeFdClient };
