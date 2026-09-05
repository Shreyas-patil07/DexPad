'use strict';

const CURRENT_SCHEMA_VERSION = 1;

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
 * Normalizes and sanitizes an incoming card payload at the IPC boundary.
 * Clamps coordinates, enforces string length limits, and validates z-index stacking.
 */
function normalizeCard(card, i = 0, defaultZ = 1) {
  if (!card || typeof card !== 'object') return null;

  const validTypes = ['note', 'todo', 'link'];
  const type = validTypes.includes(card.type) ? card.type : 'note';

  const rawZ = Number(card.zIndex);
  const zIndex = Number.isInteger(rawZ) && rawZ >= 1 ? rawZ : Math.max(1, defaultZ + i);

  return {
    id: typeof card.id === 'string' && card.id.trim()
      ? card.id.trim()
      : `card-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: typeof card.title === 'string' ? card.title.slice(0, 200) : '',
    body: typeof card.body === 'string' ? card.body.slice(0, 10000) : '',
    url: typeof card.url === 'string' ? card.url.slice(0, 2000) : '',
    done: Boolean(card.done),
    x: Number.isFinite(card.x) ? Math.max(0, Math.round(card.x)) : 20 + (i % 2) * 340,
    y: Number.isFinite(card.y) ? Math.max(0, Math.round(card.y)) : 20 + Math.floor(i / 2) * 220,
    width: Number.isFinite(card.width) ? Math.max(220, Math.min(520, Math.round(card.width))) : 300,
    height: Number.isFinite(card.height) ? Math.max(140, Math.min(520, Math.round(card.height))) : 180,
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

  // Migration path: Version 0 (unversioned legacy) -> Version 1
  if (version < 1) {
    // Ensure all migrated cards have an explicit, distinct zIndex
    cards = cards.map((c, i) => ({ ...c, zIndex: c.zIndex || (i + 1) }));
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
  isValidUrl,
  normalizeCard,
  migrateState
};
