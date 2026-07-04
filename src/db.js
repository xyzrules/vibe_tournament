const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tournaments (
  league_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  image TEXT,
  season_id INTEGER,
  season_year TEXT,
  last_synced INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  match_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  season_id INTEGER,
  kickoff_unix INTEGER NOT NULL,
  status TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_logo TEXT,
  away_logo TEXT,
  home_score INTEGER,
  away_score INTEGER,
  game_week INTEGER,
  post_synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league_id, kickoff_unix);
CREATE TABLE IF NOT EXISTS predictions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  match_id INTEGER NOT NULL,
  pick TEXT NOT NULL CHECK (pick IN ('home','draw','away')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE TABLE IF NOT EXISTS odds (
  match_id INTEGER PRIMARY KEY,
  event_id INTEGER,
  fetched_at INTEGER,
  fetched_by TEXT,
  no_match INTEGER NOT NULL DEFAULT 0,
  dk_home REAL, dk_draw REAL, dk_away REAL,
  xb_home REAL, xb_draw REAL, xb_away REAL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function createDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec(SCHEMA);
  return db;
}

module.exports = { createDb };
