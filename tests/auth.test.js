const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { signup, login, logout, userForToken, SESSION_TTL } = require('../src/auth');

test('signup + login round-trip', () => {
  const db = createDb(':memory:');
  const s = signup(db, 'alice', 'pass1234', 1000);
  assert.strictEqual(s.user.username, 'alice');
  assert.strictEqual(userForToken(db, s.token, 1001).username, 'alice');

  const l = login(db, 'alice', 'pass1234', 2000);
  assert.strictEqual(l.user.id, s.user.id);
  assert.notStrictEqual(l.token, s.token);
});

test('wrong password and unknown user are rejected identically', () => {
  const db = createDb(':memory:');
  signup(db, 'bob', 'secret99', 1000);
  assert.throws(() => login(db, 'bob', 'wrong', 1001), /invalid credentials/);
  assert.throws(() => login(db, 'nobody', 'wrong', 1001), /invalid credentials/);
});

test('duplicate usernames rejected (case-insensitive)', () => {
  const db = createDb(':memory:');
  signup(db, 'Carol', 'pass1234', 1000);
  assert.throws(() => signup(db, 'carol', 'pass1234', 1001), /taken/);
});

test('validation rules', () => {
  const db = createDb(':memory:');
  assert.throws(() => signup(db, 'ab', 'pass1234', 1), /username/);
  assert.throws(() => signup(db, 'has space', 'pass1234', 1), /username/);
  assert.throws(() => signup(db, 'okname', 'abc', 1), /password/);
});

test('sessions expire and logout kills them', () => {
  const db = createDb(':memory:');
  const { token } = signup(db, 'dave', 'pass1234', 1000);
  assert.ok(userForToken(db, token, 1000 + SESSION_TTL - 1));
  assert.strictEqual(userForToken(db, token, 1000 + SESSION_TTL + 1), null);
  logout(db, token);
  assert.strictEqual(userForToken(db, token, 1001), null);
  assert.strictEqual(userForToken(db, null, 1001), null);
});
