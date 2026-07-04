const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');

test('createDb applies schema and enforces case-insensitive unique usernames', () => {
  const db = createDb(':memory:');
  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)'
  );
  insert.run('Alice', 'x', 1);
  assert.throws(() => insert.run('alice', 'y', 2), /UNIQUE/i);
  const row = db.prepare('SELECT username FROM users').get();
  assert.strictEqual(row.username, 'Alice');
});

test('predictions only accept valid picks', () => {
  const db = createDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1,?,?,?)').run('a', 'x', 1);
  const ins = db.prepare('INSERT INTO predictions (user_id, match_id, pick, updated_at) VALUES (?,?,?,?)');
  ins.run(1, 10, 'home', 1);
  assert.throws(() => ins.run(1, 11, 'banana', 1), /CHECK/i);
});
