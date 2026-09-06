'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normalizeCardGraph, normalizeConnections } = require('../src/main/card-schema.cjs');
const { cleanProfileName, uniqueProfileName, normalizeProfileList } = require('../src/main/profile-schema.cjs');

describe('profile hardening', () => {
  test('trims and bounds profile names', () => {
    assert.strictEqual(cleanProfileName('  Work  '), 'Work');
    assert.strictEqual(cleanProfileName(''), 'Profile');
    assert.strictEqual(cleanProfileName('x'.repeat(200)).length, 80);
  });

  test('allocates case-insensitive unique profile names', () => {
    assert.strictEqual(uniqueProfileName('Work', ['work'], 2), 'Work 2');
    assert.strictEqual(uniqueProfileName('Work', ['work', 'work 2'], 2), 'Work 3');
  });

  test('repairs duplicate profile IDs and invalid profile records', () => {
    const ids = ['generated-1', 'generated-2'];
    const profiles = normalizeProfileList(
      [
        { id: 'same', name: 'One', cards: [], connections: [] },
        { id: 'same', name: 'ONE', cards: [], connections: [] },
        null
      ],
      normalizeCardGraph,
      normalizeConnections,
      { cards: [], connections: [] },
      () => ids.shift()
    );
    assert.strictEqual(profiles.length, 2);
    assert.notStrictEqual(profiles[0].id, profiles[1].id);
    assert.deepStrictEqual(profiles.map(p => p.name), ['One', 'ONE 2']);
  });

  test('preserves valid graph data while dropping invalid connections', () => {
    const profiles = normalizeProfileList(
      [{ id: 'p', name: 'Project', cards: [{ id: 'a' }, { id: 'b' }], connections: [{ a: 'a', b: 'b' }, { a: 'a', b: 'missing' }] }],
      normalizeCardGraph,
      normalizeConnections,
      { cards: [], connections: [] },
      () => 'generated'
    );
    assert.strictEqual(profiles[0].cards.length, 2);
    assert.strictEqual(profiles[0].connections.length, 1);
  });
});
