// Username/password auth. Deliberately simple per the requirements (casual
// accounts), but passwords are still scrypt-hashed and compares are
// timing-safe — we never store plaintext.

const crypto = require('node:crypto');

const SESSION_TTL = 30 * 86400; // 30 days
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function createSession(db, userId, now) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(
    token,
    userId,
    now + SESSION_TTL
  );
  return token;
}

function signup(db, username, password, now = Math.floor(Date.now() / 1000)) {
  if (!USERNAME_RE.test(username || '')) {
    throw new Error('username must be 3-20 characters: letters, numbers, underscore');
  }
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('password must be at least 4 characters');
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw new Error('username taken');
  }
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
    .run(username, hashPassword(password), now);
  const user = { id: Number(info.lastInsertRowid), username };
  return { token: createSession(db, user.id, now), user };
}

function login(db, username, password, now = Math.floor(Date.now() / 1000)) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    throw new Error('invalid credentials');
  }
  return { token: createSession(db, row.id, now), user: { id: row.id, username: row.username } };
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userForToken(db, token, now = Math.floor(Date.now() / 1000)) {
  if (!token) return null;
  return (
    db
      .prepare(`
        SELECT u.id, u.username FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?
      `)
      .get(token, now) || null
  );
}

module.exports = { signup, login, logout, userForToken, SESSION_TTL };
