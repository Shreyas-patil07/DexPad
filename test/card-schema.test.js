'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  CURRENT_SCHEMA_VERSION,
  isValidUrl,
  normalizeCard,
  migrateState
} = require('../src/main/card-schema.cjs');

describe('Card Schema Validation (normalizeCard)', () => {
  test('handles null or non-object card gracefully', () => {
    assert.strictEqual(normalizeCard(null), null);
    assert.strictEqual(normalizeCard(undefined), null);
    assert.strictEqual(normalizeCard('not an object'), null);
  });

  test('enforces boundaries for dimensions and position', () => {
    const raw = {
      id: 'test-1',
      type: 'note',
      title: 'Hello',
      x: -50,
      y: -100,
      width: 100, // min is 220
      height: 900 // max is 520
    };
    const norm = normalizeCard(raw);
    assert.strictEqual(norm.x, 0, 'Negative x clamped to 0');
    assert.strictEqual(norm.y, 0, 'Negative y clamped to 0');
    assert.strictEqual(norm.width, 220, 'Width clamped to min 220');
    assert.strictEqual(norm.height, 520, 'Height clamped to max 520');
  });

  test('sanitizes strings and types', () => {
    const raw = {
      type: 'unknown_type',
      title: 'A'.repeat(300),
      body: 'B'.repeat(12000),
      url: 'https://example.com'
    };
    const norm = normalizeCard(raw);
    assert.strictEqual(norm.type, 'note', 'Invalid type defaults to note');
    assert.strictEqual(norm.title.length, 200, 'Title sliced to 200 chars');
    assert.strictEqual(norm.body.length, 10000, 'Body sliced to 10000 chars');
  });

  test('preserves or assigns valid zIndex', () => {
    const cardWithZ = normalizeCard({ id: 'z1', zIndex: 42 });
    assert.strictEqual(cardWithZ.zIndex, 42);

    const cardWithoutZ = normalizeCard({ id: 'z2' }, 3, 10);
    assert.strictEqual(cardWithoutZ.zIndex, 13);
  });
});

describe('URL Semantic Verification (isValidUrl)', () => {
  test('accepts valid http and https URLs', () => {
    assert.strictEqual(isValidUrl('https://google.com'), true);
    assert.strictEqual(isValidUrl('http://localhost:3000/api'), true);
    assert.strictEqual(isValidUrl('https://sub.domain.org/path?q=1'), true);
  });

  test('rejects dangerous or non-http protocols', () => {
    assert.strictEqual(isValidUrl('javascript:alert(1)'), false);
    assert.strictEqual(isValidUrl('file:///C:/Windows/system32'), false);
    assert.strictEqual(isValidUrl('data:text/html,<script>'), false);
    assert.strictEqual(isValidUrl('not a url'), false);
    assert.strictEqual(isValidUrl(123), false);
    assert.strictEqual(isValidUrl(null), false);
  });
});

describe('State Migration (migrateState)', () => {
  test('migrates unversioned legacy state to schema version 1', () => {
    const legacy = {
      startup: true,
      wallpaperMode: false,
      cards: [
        { id: 'c1', title: 'Task 1', type: 'todo' },
        { id: 'c2', title: 'Task 2', type: 'note' }
      ]
    };
    const migrated = migrateState(legacy);
    assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(migrated.startup, true);
    assert.strictEqual(migrated.wallpaperMode, false);
    assert.strictEqual(migrated.cards.length, 2);
    assert.strictEqual(migrated.cards[0].zIndex, 1);
    assert.strictEqual(migrated.cards[1].zIndex, 2);
  });

  test('handles empty or malformed state safely', () => {
    const migrated = migrateState(null);
    assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(migrated.startup, false);
    assert.strictEqual(migrated.wallpaperMode, true);
    assert.deepStrictEqual(migrated.cards, []);
  });
});
