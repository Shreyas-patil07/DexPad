'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normalizeCard, normalizeCardGraph, normalizeConnections } = require('../src/main/card-schema.cjs');

describe('quit-save race prevention (Bug #2)', () => {
  // Mirror the main-process saveWorkspace / saveWorkspaceSync structure after the fix.
  // Both functions now join saveQueue, so the sync write always lands last.
  function makeMainState() {
    const profiles = [
      { id: 'profile-a', name: 'Profile A', cards: [], connections: [] }
    ];
    let saveQueue = Promise.resolve();

    function saveWorkspace(payload) {
      const profileId = payload?.profileId || 'profile-a';
      const operation = saveQueue.then(async () => {
        // simulate a real async I/O delay (debounced flush in flight)
        await new Promise(r => setTimeout(r, 20));
        const cards = normalizeCardGraph(
          (payload?.cards || []).map((c, i) => normalizeCard(c, i)).filter(Boolean)
        );
        const p = profiles.find(x => x.id === profileId);
        if (!p) return;
        p.cards = cards;
      });
      saveQueue = operation.catch(() => {});
      return operation;
    }

    function saveWorkspaceSync(payload) {
      const profileId = payload?.profileId || 'profile-a';
      // note: chains onto saveQueue so any in-flight async save lands first.
      // This is the fix. Without it, saveWorkspaceSync writes to p.cards
      // immediately and the slower async save overwrites it afterward.
      const operation = saveQueue.then(() => {
        const cards = normalizeCardGraph(
          (payload?.cards || []).map((c, i) => normalizeCard(c, i)).filter(Boolean)
        );
        const p = profiles.find(x => x.id === profileId);
        if (!p) return;
        p.cards = cards;
      });
      saveQueue = operation.catch(() => {});
      return operation;
    }

    return { profiles, saveWorkspace, saveWorkspaceSync };
  }

  test('sync save (beforeunload) wins over an in-flight async save', async () => {
    const { profiles, saveWorkspace, saveWorkspaceSync } = makeMainState();

    // Step 1: debounced save fires with older data (card title = 'v1')
    const asyncSave = saveWorkspace({
      profileId: 'profile-a',
      cards: [{ id: 'card-1', type: 'note', title: 'v1 — older debounced state' }],
      connections: []
    });

    // Step 2: user closes the window before the async save resolves.
    // beforeunload fires saveWorkspaceSync with newer data (card title = 'v2').
    const syncSave = saveWorkspaceSync({
      profileId: 'profile-a',
      cards: [{ id: 'card-1', type: 'note', title: 'v2 — latest state on close' }],
      connections: []
    });

    await Promise.all([asyncSave, syncSave]);

    // The sync save must win — it holds the most-current renderer state.
    assert.strictEqual(profiles[0].cards.length, 1, 'profile should have exactly one card');
    assert.strictEqual(
      profiles[0].cards[0].title,
      'v2 — latest state on close',
      'sync save (newest data) must be the final write, not clobbered by async save'
    );
  });

  test('async save completes correctly when no sync save races it', async () => {
    const { profiles, saveWorkspace } = makeMainState();

    await saveWorkspace({
      profileId: 'profile-a',
      cards: [{ id: 'card-2', type: 'note', title: 'Solo async save' }],
      connections: []
    });

    assert.strictEqual(profiles[0].cards.length, 1);
    assert.strictEqual(profiles[0].cards[0].title, 'Solo async save');
  });

  test('multiple queued sync saves land in order', async () => {
    const { profiles, saveWorkspaceSync } = makeMainState();

    const s1 = saveWorkspaceSync({
      profileId: 'profile-a',
      cards: [{ id: 'card-3', type: 'note', title: 'First sync' }],
      connections: []
    });
    const s2 = saveWorkspaceSync({
      profileId: 'profile-a',
      cards: [{ id: 'card-3', type: 'note', title: 'Second sync' }],
      connections: []
    });

    await Promise.all([s1, s2]);

    assert.strictEqual(profiles[0].cards[0].title, 'Second sync', 'later sync save must win');
  });
});
