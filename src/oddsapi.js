// Client for odds-api.io (DraftKings + 1xbet moneyline odds only).

const BASE = 'https://api.odds-api.io/v3';
const BOOKMAKERS = 'DraftKings,1xbet';

function makeOaClient({ key, fetchFn = fetch }) {
  const client = { requestCount: 0 };

  async function get(pathname, params) {
    client.requestCount += 1;
    const url = new URL(`${BASE}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apiKey', key);
    const res = await fetchFn(url.toString());
    if (!res.ok) throw new Error(`odds-api.io HTTP ${res.status}`);
    return res.json();
  }

  // Returns an array of events regardless of envelope shape.
  client.searchEvents = async (query) => {
    const body = await get('/events/search', { query, sport: 'football' });
    if (Array.isArray(body)) return body;
    return body && Array.isArray(body.data) ? body.data : [];
  };

  client.odds = (eventId) => get('/odds', { eventId, bookmakers: BOOKMAKERS });
  return client;
}

module.exports = { makeOaClient, BOOKMAKERS };
