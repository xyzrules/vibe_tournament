const path = require('node:path');
const { loadConfig } = require('./src/config');
const { createDb } = require('./src/db');
const { makeFdClient } = require('./src/footballdata');
const { makeOaClient } = require('./src/oddsapi');
const { tick } = require('./src/sync');
const { createAppServer } = require('./src/routes');

const config = loadConfig();
const db = createDb(path.join(__dirname, 'data', 'app.db'));
const fd = makeFdClient({ key: config.fdKey });
const oa = makeOaClient({ key: config.oaKey });

const server = createAppServer({ db, oa, publicDir: path.join(__dirname, 'public') });

async function runTick() {
  try {
    await tick(db, fd);
  } catch (err) {
    console.error('sync tick failed:', err.message);
  }
}

server.listen(config.port, () => {
  console.log(`vibe tournament running on http://localhost:${config.port}`);
  runTick(); // bootstrap sync on start (no-op if fresh enough)
  setInterval(runTick, 5 * 60 * 1000);
});
