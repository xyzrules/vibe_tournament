const path = require('node:path');

// Loads .env (if present) and validates required keys. Keys can also come
// from real environment variables (useful on hosting platforms).
function loadConfig(rootDir = path.join(__dirname, '..')) {
  try {
    process.loadEnvFile(path.join(rootDir, '.env'));
  } catch {
    // no .env file — rely on the process environment
  }
  const fdKey = process.env.FOOTBALLDATA_API_KEY;
  const oaKey = process.env.ODDS_API_KEY;
  if (!fdKey || !oaKey) {
    throw new Error(
      'Missing FOOTBALLDATA_API_KEY or ODDS_API_KEY. Copy .env.example to .env and fill in your keys.'
    );
  }
  return { fdKey, oaKey, port: Number(process.env.PORT) || 3000 };
}

module.exports = { loadConfig };
