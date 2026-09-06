'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { CURRENT_SCHEMA_VERSION, MAX_CONNECTIONS, MAX_TAGS, VALID_BLOCK_TYPES, isValidUrl, normalizeCard, normalizeConnections, migrateState } = require('../src/main/card-schema.cjs');

describe('schema v5', () => {
  test('accepts every block type and asserts schema version 5', () => {
    for (const type of VALID_BLOCK_TYPES) assert.strictEqual(normalizeCard({ type }).type, type);
    assert.strictEqual(CURRENT_SCHEMA_VERSION, 5);
  });
  test('normalizes metadata, content, and enforces tag limit', () => {
    const manyTags = Array.from({ length: 80 }, (_, i) => `tag-${i}`);
    const c = normalizeCard({ type:'markdown', color:'purple', pinned:true, locked:true, collapsed:true, tags: manyTags, markdown:'# x', description:'x'.repeat(6000) });
    assert.strictEqual(c.type, 'markdown');
    assert.strictEqual(c.color, 'purple');
    assert.strictEqual(c.tags.length, MAX_TAGS);
    assert.strictEqual(c.markdown, '# x');
    assert.strictEqual(c.description.length, 5000);
    assert.strictEqual(c.content.markdown, '# x');
  });
});

describe('urls and connections', () => {
  test('only http(s) URLs are accepted', () => {
    for (const value of ['https://example.com','http://localhost:3000']) assert.strictEqual(isValidUrl(value), true);
    for (const value of ['javascript:alert(1)','file:///x','data:text/plain,x','nope',null,123]) assert.strictEqual(isValidUrl(value), false);
  });
  test('invalid and duplicate connections are removed in O(N)', () => {
    const cards = [normalizeCard({id:'a'}), normalizeCard({id:'b'})];
    const result = normalizeConnections([{a:'a',b:'b'},{a:'b',b:'a'},{a:'a',b:'a'},{a:'a',b:'x'}], cards);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].a, 'a');
    assert.strictEqual(result[0].b, 'b');
  });
});

describe('migration', () => {
  test('migrates legacy state to schema version 5', () => {
    const s = migrateState({ cards:[{id:'1',type:'todo',title:'Task'}], startup:true, wallpaperMode:false });
    assert.strictEqual(s.schemaVersion, 5);
    assert.strictEqual(s.cards[0].title, 'Task');
    assert.deepStrictEqual(s.connections, []);
  });
  test('migrates v4 connections to schema version 5', () => {
    const s = migrateState({ schemaVersion:4, cards:[{id:'a'},{id:'b'}], connections:[{a:'a',b:'b'},{a:'b',b:'a'}] });
    assert.strictEqual(s.schemaVersion, 5);
    assert.strictEqual(s.connections.length, 1);
  });
});
