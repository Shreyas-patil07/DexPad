'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  MAX_PROFILES,
  makeProfileId,
  uniqueProfileName,
  normalizeProfileList
} = require('../src/main/profile-schema.cjs');
const {
  normalizeCard,
  normalizeCardGraph,
  normalizeConnections
} = require('../src/main/card-schema.cjs');

describe('profile-switch save race prevention', () => {
  test('saves targeted to Profile A are not written to Profile B when active profile changes', async () => {
    // Simulate main process state
    let profiles = [
      { id: 'profile-a', name: 'Profile A', cards: [], connections: [] },
      { id: 'profile-b', name: 'Profile B', cards: [], connections: [] }
    ];
    let activeProfileId = 'profile-a';
    let saveQueue = Promise.resolve();

    function saveWorkspace(payload, targetProfileId = null) {
      const boundId = payload?.profileId || targetProfileId || activeProfileId;
      const operation = saveQueue.then(async () => {
        // simulate async I/O delay
        await new Promise(r => setTimeout(r, 10));
        const normalizedCards = normalizeCardGraph(
          (payload?.cards || []).map((c, i) => normalizeCard(c, i)).filter(Boolean)
        );
        const normalizedConnections = normalizeConnections(payload?.connections, normalizedCards);
        const p = profiles.find(x => x.id === boundId);
        if (!p) return;
        p.cards = normalizedCards;
        p.connections = normalizedConnections;
      });
      saveQueue = operation;
      return operation;
    }

    function switchProfile(id) {
      const op = saveQueue.then(() => {
        activeProfileId = id;
      });
      saveQueue = op;
      return op;
    }

    // Step 1: User on Profile A triggers a save with Card A
    const savePromise = saveWorkspace({
      cards: [{ id: 'card-a1', type: 'note', title: 'Important Notes A' }],
      connections: [],
      profileId: 'profile-a'
    });

    // Step 2: User immediately switches to Profile B before the save completes
    const switchPromise = switchProfile('profile-b');

    // Step 3: Wait for both operations
    await Promise.all([savePromise, switchPromise]);

    // Verification:
    // Profile A must have Card A
    assert.strictEqual(profiles[0].cards.length, 1);
    assert.strictEqual(profiles[0].cards[0].id, 'card-a1');
    assert.strictEqual(profiles[0].cards[0].title, 'Important Notes A');

    // Profile B must be empty (NOT corrupted with Card A)
    assert.strictEqual(profiles[1].cards.length, 0);
    assert.strictEqual(activeProfileId, 'profile-b');
  });

  test('uniqueProfileName generates unique names case-insensitively', () => {
    const existing = ['Work', 'Personal', 'Projects'];
    assert.strictEqual(uniqueProfileName('work', existing), 'work 2');
    assert.strictEqual(uniqueProfileName('WORK', existing), 'WORK 2');
    assert.strictEqual(uniqueProfileName('College', existing), 'College');
  });

  test('normalizeProfileList caps at MAX_PROFILES', () => {
    const excessive = Array.from({ length: 150 }, (_, i) => ({
      id: `p-${i}`,
      name: `Profile ${i}`,
      cards: []
    }));
    const result = normalizeProfileList(
      excessive,
      normalizeCardGraph,
      normalizeConnections,
      { cards: [], connections: [] }
    );
    assert.strictEqual(result.length, MAX_PROFILES);
  });
});
