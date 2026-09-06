'use strict';

const CURRENT_SCHEMA_VERSION = 3;

const VALID_BLOCK_TYPES = [
  'note', 'todo', 'link', 'markdown', 'image', 'file', 'column', 'group', 'board'
];
const VALID_COLORS = ['default', 'blue', 'green', 'amber', 'rose', 'purple'];

function isValidUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeCard(card, i = 0, defaultZ = 1) {
  if (!card || typeof card !== 'object') return null;

  const type = VALID_BLOCK_TYPES.includes(card.type) ? card.type : 'note';
  const color = VALID_COLORS.includes(card.color) ? card.color : 'default';
  const rawZ = Number(card.zIndex);
  const zIndex = Number.isInteger(rawZ) && rawZ >= 1 ? rawZ : Math.max(1, defaultZ + i);
  const rawContent = card.content && typeof card.content === 'object' ? card.content : {};

  const text = (primary, nested, max) => {
    const value = typeof primary === 'string' ? primary : typeof nested === 'string' ? nested : '';
    return value.slice(0, max);
  };

  const title = text(card.title, rawContent.title, 200);
  const body = text(card.body, rawContent.body, 10000);
  const url = text(card.url, rawContent.url, 2000);
  const markdown = text(card.markdown, rawContent.markdown, 20000);
  const src = text(card.src, rawContent.src, 200000);
  const path = text(card.path, rawContent.path, 4000);
  const description = text(card.description, rawContent.description, 5000);
  const done = typeof card.done === 'boolean' ? card.done : Boolean(rawContent.done);
  const collapsed = Boolean(card.collapsed);
  const locked = Boolean(card.locked);
  const pinned = Boolean(card.pinned);

  const tags = Array.isArray(card.tags)
    ? [...new Set(card.tags
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().slice(0, 30)))]
    : [];

  const children = Array.isArray(card.children)
    ? card.children.filter((id) => typeof id === 'string').slice(0, 500)
    : [];

  return {
    id: typeof card.id === 'string' && card.id.trim()
      ? card.id.trim()
      : `block-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    color,
    pinned,
    locked,
    collapsed,
    tags,
    title,
    body,
    url,
    done,
    markdown,
    src,
    path,
    description,
    children,
    content: {
      title,
      body,
      url,
      done,
      markdown,
      src,
      path,
      description
    },
    x: Number.isFinite(card.x) ? Math.max(0, Math.round(card.x)) : 20 + (i % 2) * 340,
    y: Number.isFinite(card.y) ? Math.max(0, Math.round(card.y)) : 20 + Math.floor(i / 2) * 220,
    width: Number.isFinite(card.width) ? Math.max(220, Math.min(900, Math.round(card.width))) : 300,
    height: Number.isFinite(card.height) ? Math.max(140, Math.min(900, Math.round(card.height))) : 180,
    zIndex
  };
}

function migrateState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const version = Number(state.schemaVersion) || 0;

  let cards = Array.isArray(state.cards)
    ? state.cards.map((c, i) => normalizeCard(c, i)).filter(Boolean)
    : [];

  if (version < 1) {
    cards = cards.map((c, i) => ({ ...c, zIndex: c.zIndex || (i + 1) }));
  }

  if (version < 2) {
    cards = cards.map((c, i) => normalizeCard(c, i));
  }

  if (version < 3) {
    cards = cards.map((c, i) => normalizeCard({
      ...c,
      locked: false,
      collapsed: false,
      children: c.children || []
    }, i));
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    startup: Boolean(state.startup),
    wallpaperMode: typeof state.wallpaperMode === 'boolean' ? state.wallpaperMode : true,
    cards
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  VALID_BLOCK_TYPES,
  VALID_COLORS,
  isValidUrl,
  normalizeCard,
  migrateState
};
