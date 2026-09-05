'use strict';

const CURRENT_SCHEMA_VERSION = 2;

const VALID_BLOCK_TYPES = ['note', 'todo', 'link', 'markdown', 'group'];
const VALID_COLORS = ['default', 'blue', 'green', 'amber', 'rose', 'purple'];

/**
 * Validates external URLs using semantic URL parsing rather than basic regex.
 * Only http: and https: protocols are permitted to avoid arbitrary protocol execution.
 */
function isValidUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Normalizes and sanitizes an incoming block payload at the IPC boundary.
 * Clamps coordinates, enforces string length limits, validates z-index stacking,
 * and normalizes the extensible content structure.
 */
function normalizeCard(card, i = 0, defaultZ = 1) {
  if (!card || typeof card !== 'object') return null;

  const type = VALID_BLOCK_TYPES.includes(card.type) ? card.type : 'note';
  const color = VALID_COLORS.includes(card.color) ? card.color : 'default';

  const rawZ = Number(card.zIndex);
  const zIndex = Number.isInteger(rawZ) && rawZ >= 1 ? rawZ : Math.max(1, defaultZ + i);

  // Extract content from either nested content object or top-level properties (backwards compatible)
  const rawContent = card.content && typeof card.content === 'object' ? card.content : {};
  const title = typeof card.title === 'string'
    ? card.title.slice(0, 200)
    : typeof rawContent.title === 'string'
      ? rawContent.title.slice(0, 200)
      : '';
  const body = typeof card.body === 'string'
    ? card.body.slice(0, 10000)
    : typeof rawContent.body === 'string'
      ? rawContent.body.slice(0, 10000)
      : '';
  const url = typeof card.url === 'string'
    ? card.url.slice(0, 2000)
    : typeof rawContent.url === 'string'
      ? rawContent.url.slice(0, 2000)
      : '';
  const done = typeof card.done === 'boolean'
    ? card.done
    : Boolean(rawContent.done);
  const markdown = typeof rawContent.markdown === 'string'
    ? rawContent.markdown.slice(0, 20000)
    : '';

  const tags = Array.isArray(card.tags)
    ? card.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 30))
    : [];

  return {
    id: typeof card.id === 'string' && card.id.trim()
      ? card.id.trim()
      : `block-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    color,
    pinned: Boolean(card.pinned),
    tags,
    title,
    body,
    url,
    done,
    content: {
      title,
      body,
      url,
      done,
      markdown
    },
    x: Number.isFinite(card.x) ? Math.max(0, Math.round(card.x)) : 20 + (i % 2) * 340,
    y: Number.isFinite(card.y) ? Math.max(0, Math.round(card.y)) : 20 + Math.floor(i / 2) * 220,
    width: Number.isFinite(card.width) ? Math.max(220, Math.min(720, Math.round(card.width))) : 300,
    height: Number.isFinite(card.height) ? Math.max(140, Math.min(720, Math.round(card.height))) : 180,
    zIndex
  };
}

/**
 * Migrates persistent storage data safely across schema versions.
 */
function migrateState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const version = Number(state.schemaVersion) || 0;

  let cards = Array.isArray(state.cards)
    ? state.cards.map((c, i) => normalizeCard(c, i)).filter(Boolean)
    : [];

  // Migration path: Version 0 -> Version 1: Ensure explicit zIndex
  if (version < 1) {
    cards = cards.map((c, i) => ({ ...c, zIndex: c.zIndex || (i + 1) }));
  }

  // Migration path: Version 1 -> Version 2: Ensure tags, color, pinned, and content structure
  if (version < 2) {
    cards = cards.map((c, i) => normalizeCard(c, i));
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
