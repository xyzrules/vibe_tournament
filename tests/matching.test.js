const test = require('node:test');
const assert = require('node:assert');
const { normalizeTeam, teamsMatch, findEvent } = require('../src/matching');

test('normalizeTeam strips accents, punctuation and noise tokens', () => {
  assert.strictEqual(normalizeTeam('Atlético Madrid'), normalizeTeam('Atletico Madrid'));
  assert.strictEqual(normalizeTeam('Sunderland AFC'), normalizeTeam('Sunderland'));
  assert.strictEqual(normalizeTeam('Manchester Utd'), normalizeTeam('Manchester United'));
});

test('teamsMatch accepts real-world variants and rejects different teams', () => {
  assert.ok(teamsMatch('Tottenham Hotspur FC', 'Tottenham Hotspur'));
  assert.ok(teamsMatch('Atlético Madrid', 'Atletico Madrid'));
  assert.ok(teamsMatch('Sunderland AFC', 'Sunderland'));
  assert.ok(!teamsMatch('Manchester City', 'Manchester United'));
  assert.ok(!teamsMatch('Everton', 'Liverpool'));
  assert.ok(!teamsMatch('', 'Liverpool'));
});

const baseMatch = {
  home_team: 'Canada',
  away_team: 'Morocco',
  kickoff_unix: Math.floor(Date.parse('2026-07-04T17:00:00Z') / 1000),
};

test('findEvent picks the event matching both teams and kickoff time', () => {
  const events = [
    { id: 1, home: 'Canada', away: 'Morocco', date: '2026-07-04T17:00:00Z' },
    { id: 2, home: 'Canada', away: 'Egypt', date: '2026-07-04T17:00:00Z' },
    { id: 3, home: 'Canada', away: 'Morocco', date: '2026-07-10T17:00:00Z' },
  ];
  assert.strictEqual(findEvent(baseMatch, events).id, 1);
});

test('findEvent returns null when kickoff differs by more than tolerance', () => {
  const events = [{ id: 1, home: 'Canada', away: 'Morocco', date: '2026-07-04T21:30:00Z' }];
  assert.strictEqual(findEvent(baseMatch, events), null);
});

test('findEvent returns null on ambiguity or no candidates', () => {
  const dup = [
    { id: 1, home: 'Canada', away: 'Morocco', date: '2026-07-04T17:00:00Z' },
    { id: 2, home: 'Canada', away: 'Morocco', date: '2026-07-04T18:00:00Z' },
  ];
  assert.strictEqual(findEvent(baseMatch, dup), null);
  assert.strictEqual(findEvent(baseMatch, []), null);
  assert.strictEqual(findEvent(baseMatch, [{ id: 9, home: 'Canada', away: 'Morocco', date: 'garbage' }]), null);
});
