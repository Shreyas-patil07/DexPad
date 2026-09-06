'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { CURRENT_SCHEMA_VERSION, VALID_BLOCK_TYPES, isValidUrl, normalizeCard, normalizeConnections, migrateState } = require('../src/main/card-schema.cjs');

describe('schema v4', () => {
  test('accepts every block type', () => {
    for (const type of VALID_BLOCK_TYPES) assert.strictEqual(normalizeCard({ type }).type, type);
    assert.strictEqual(CURRENT_SCHEMA_VERSION, 4);
  });
  test('normalizes metadata and content', () => {
    const c = normalizeCard({ type:'markdown', color:'purple', pinned:true, locked:true, collapsed:true, tags:[' a ','a','b'], markdown:'# x', description:'x'.repeat(6000) });
    assert.strictEqual(c.type, 'markdown');
    assert.strictEqual(c.color, 'purple');
    assert.deepStrictEqual(c.tags, ['a','b']);
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
  test('invalid and duplicate connections are removed', () => {
    const cards = [normalizeCard({id:'a'}), normalizeCard({id:'b'})];
    const result = normalizeConnections([{a:'a',b:'b'},{a:'b',b:'a'},{a:'a',b:'a'},{a:'a',b:'x'}], cards);
    assert.strictEqual(result.length, 1);
  });
});

describe('migration', () => {
  test('migrates legacy state to current schema', () => {
    const s = migrateState({ cards:[{id:'1',type:'todo',title:'Task'}], startup:true, wallpaperMode:false });
    assert.strictEqual(s.schemaVersion, 4);
    assert.strictEqual(s.cards[0].title, 'Task');
    assert.deepStrictEqual(s.connections, []);
  });
  test('migrates v3 connections', () => {
    const s = migrateState({ schemaVersion:3, cards:[{id:'a'},{id:'b'}], connections:[{a:'a',b:'b'},{a:'b',b:'a'}] });
    assert.strictEqual(s.schemaVersion, 4);
    assert.strictEqual(s.connections.length, 1);
  });
});
