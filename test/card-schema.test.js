'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  CURRENT_SCHEMA_VERSION,
  VALID_BLOCK_TYPES,
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
    const norm = normalizeCard({ id:'test-1', type:'note', title:'Hello', x:-50, y:-100, width:100, height:1200 });
    assert.strictEqual(norm.x, 0);
    assert.strictEqual(norm.y, 0);
    assert.strictEqual(norm.width, 220);
    assert.strictEqual(norm.height, 900);
  });

  test('sanitizes strings and types', () => {
    const norm = normalizeCard({ type:'unknown_type', title:'A'.repeat(300), body:'B'.repeat(12000), url:'https://example.com' });
    assert.strictEqual(norm.type, 'note');
    assert.strictEqual(norm.title.length, 200);
    assert.strictEqual(norm.body.length, 10000);
  });

  test('accepts the full spatial block type set', () => {
    for (const type of VALID_BLOCK_TYPES) assert.strictEqual(normalizeCard({ id:`${type}-1`, type }).type, type);
    assert.deepStrictEqual(VALID_BLOCK_TYPES, ['note','todo','link','markdown','image','file','column','group','board']);
  });

  test('preserves or assigns valid zIndex', () => {
    assert.strictEqual(normalizeCard({ id:'z1', zIndex:42 }).zIndex, 42);
    assert.strictEqual(normalizeCard({ id:'z2' }, 3, 10).zIndex, 13);
  });

  test('normalizes visual metadata and extended content', () => {
    const block = normalizeCard({ id:'block-1', type:'markdown', color:'purple', pinned:true, locked:true, tags:[' productivity ','personal','personal'], content:{ title:'Specs', markdown:'# Architecture' } });
    assert.strictEqual(block.type, 'markdown');
    assert.strictEqual(block.color, 'purple');
    assert.strictEqual(block.pinned, true);
    assert.strictEqual(block.locked, true);
    assert.deepStrictEqual(block.tags, ['productivity','personal']);
    assert.strictEqual(block.title, 'Specs');
    assert.strictEqual(block.content.markdown, '# Architecture');
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
  test('migrates legacy state to the current schema', () => {
    const migrated = migrateState({ startup:true, wallpaperMode:false, cards:[{id:'c1',title:'Task 1',type:'todo'},{id:'c2',title:'Task 2',type:'note'}] });
    assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(migrated.schemaVersion, 3);
    assert.strictEqual(migrated.startup, true);
    assert.strictEqual(migrated.wallpaperMode, false);
    assert.strictEqual(migrated.cards.length, 2);
    assert.strictEqual(migrated.cards[0].zIndex, 1);
    assert.strictEqual(migrated.cards[1].zIndex, 2);
    assert.deepStrictEqual(migrated.cards[0].tags, []);
    assert.strictEqual(migrated.cards[0].locked, false);
  });

  test('migrates schema version 2 to version 3 cleanly', () => {
    const migrated = migrateState({ schemaVersion:2, startup:false, wallpaperMode:true, cards:[{id:'b1',type:'group',title:'Group',zIndex:5}] });
    assert.strictEqual(migrated.schemaVersion, 3);
    assert.strictEqual(migrated.cards[0].zIndex, 5);
    assert.strictEqual(migrated.cards[0].collapsed, false);
  });

  test('handles empty or malformed state safely', () => {
    const migrated = migrateState(null);
    assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.strictEqual(migrated.startup, false);
    assert.strictEqual(migrated.wallpaperMode, true);
    assert.deepStrictEqual(migrated.cards, []);
  });
});
