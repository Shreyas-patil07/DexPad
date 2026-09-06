'use strict';

const CURRENT_SCHEMA_VERSION = 5;
const MAX_CARDS = 5000;
const MAX_CONNECTIONS = 5000;
const MAX_TAGS = 50;
const VALID_BLOCK_TYPES = ['note','todo','link','markdown','image','file','column','group','board'];
const VALID_COLORS = ['default','blue','green','amber','rose','purple'];

function isValidUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
  catch (_) { return false; }
}
function text(primary, nested, max) {
  const value = typeof primary === 'string' ? primary : typeof nested === 'string' ? nested : '';
  return value.slice(0, max);
}
function normalizeCard(card, i = 0, defaultZ = 1) {
  if (!card || typeof card !== 'object') return null;
  const rawContent = card.content && typeof card.content === 'object' ? card.content : {};
  const type = VALID_BLOCK_TYPES.includes(card.type) ? card.type : 'note';
  const color = VALID_COLORS.includes(card.color) ? card.color : 'default';
  const rawZ = Number(card.zIndex);
  const zIndex = Number.isInteger(rawZ) && rawZ >= 1 ? rawZ : Math.max(1, defaultZ + i);
  const tags = Array.isArray(card.tags)
    ? [...new Set(card.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0,30)))].slice(0, MAX_TAGS)
    : [];
  const children = Array.isArray(card.children) ? [...new Set(card.children.filter(id => typeof id === 'string' && id.trim()))].slice(0,500) : [];
  const parentId = typeof card.parentId === 'string' && card.parentId.trim() ? card.parentId.trim() : null;

  const rawUrl = text(card.url, rawContent.url, 2000);
  const url = !rawUrl || isValidUrl(rawUrl) ? rawUrl : '';

  const normalized = {
    id: typeof card.id === 'string' && card.id.trim() ? card.id.trim() : `block-${Date.now()}-${i}-${Math.random().toString(36).slice(2,8)}`,
    parentId, type, color, pinned: Boolean(card.pinned), locked: Boolean(card.locked), collapsed: Boolean(card.collapsed), tags,
    title: text(card.title, rawContent.title, 200), body: text(card.body, rawContent.body, 10000), url,
    done: typeof card.done === 'boolean' ? card.done : Boolean(rawContent.done),
    markdown: text(card.markdown, rawContent.markdown, 20000), src: text(card.src, rawContent.src, 200000),
    path: text(card.path, rawContent.path, 4000), description: text(card.description, rawContent.description, 5000), children,
    x: Number.isFinite(card.x) ? Math.max(0, Math.round(card.x)) : 20 + (i % 2) * 340,
    y: Number.isFinite(card.y) ? Math.max(0, Math.round(card.y)) : 20 + Math.floor(i / 2) * 220,
    width: Number.isFinite(card.width) ? Math.max(220, Math.min(900, Math.round(card.width))) : 300,
    height: Number.isFinite(card.height) ? Math.max(140, Math.min(900, Math.round(card.height))) : 180,
    zIndex
  };
  normalized.content = { title: normalized.title, body: normalized.body, url: normalized.url, done: normalized.done, markdown: normalized.markdown, src: normalized.src, path: normalized.path, description: normalized.description };
  return normalized;
}
// note: deduplicates duplicate card IDs and caps graph size at MAX_CARDS (5000)
function normalizeCardGraph(cards) {
  const rawList = Array.isArray(cards) ? cards.filter(Boolean) : [];
  const seenIds = new Set();
  const deduplicated = [];

  for (let i = 0; i < rawList.length && deduplicated.length < MAX_CARDS; i += 1) {
    const raw = rawList[i];
    let cardId = raw.id;
    if (seenIds.has(cardId)) {
      cardId = `${cardId}-${Date.now().toString(36)}-${i}`;
    }
    seenIds.add(cardId);
    deduplicated.push({ ...raw, id: cardId });
  }

  const validIds = new Set(deduplicated.map(c => c.id));
  return deduplicated.map(card => {
    const cleanParentId = card.parentId && validIds.has(card.parentId) && card.parentId !== card.id ? card.parentId : null;
    return {
      ...card,
      parentId: cleanParentId,
      children: Array.isArray(card.children) ? card.children.filter(id => id !== card.id && validIds.has(id)).slice(0, 500) : []
    };
  });
}
// note: uses Set with canonical sorted edge keys to guarantee O(N) deduplication
function normalizeConnections(connections, cards) {
  const valid = new Set(cards.map(c => c.id));
  if (!Array.isArray(connections)) return [];
  const seen = new Set();
  const result = [];
  for (let i = 0; i < connections.length && result.length < MAX_CONNECTIONS; i += 1) {
    const c = connections[i];
    if (!c || typeof c !== 'object') continue;
    const a = typeof c.a === 'string' ? c.a.trim() : '';
    const b = typeof c.b === 'string' ? c.b.trim() : '';
    if (!a || !b || a === b || !valid.has(a) || !valid.has(b)) continue;
    const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    result.push({
      id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `connection-${Date.now()}-${i}`,
      a,
      b,
      label: typeof c.label === 'string' ? c.label.slice(0,200) : ''
    });
  }
  return result;
}
function migrateState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const cards = normalizeCardGraph(Array.isArray(state.cards) ? state.cards.map((c,i) => normalizeCard(c,i)).filter(Boolean) : []);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    startup: Boolean(state.startup),
    wallpaperMode: typeof state.wallpaperMode === 'boolean' ? state.wallpaperMode : true,
    cards,
    connections: normalizeConnections(state.connections, cards)
  };
}
module.exports = { CURRENT_SCHEMA_VERSION, MAX_CARDS, MAX_CONNECTIONS, MAX_TAGS, VALID_BLOCK_TYPES, VALID_COLORS, isValidUrl, normalizeCard, normalizeCardGraph, normalizeConnections, migrateState };

