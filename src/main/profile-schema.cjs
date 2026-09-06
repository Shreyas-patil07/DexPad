'use strict';

const MAX_PROFILES = 100;
const MAX_PROFILE_NAME = 80;

function makeProfileId(existing = new Set()) {
  let id;
  do {
    id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.has(id));
  return id;
}

function cleanProfileName(value, fallback = 'Profile') {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_PROFILE_NAME) : '';
  return name || fallback;
}

function uniqueProfileName(requested, existingNames, fallbackIndex = 1) {
  const used = new Set(existingNames.map(name => String(name).trim().toLocaleLowerCase()));
  const base = cleanProfileName(requested, `Profile ${fallbackIndex}`);
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let i = 2; i <= MAX_PROFILES + 1; i += 1) {
    const candidate = `${base.slice(0, Math.max(1, MAX_PROFILE_NAME - String(i).length - 1))} ${i}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base.slice(0, MAX_PROFILE_NAME - 9)} ${Date.now()}`.slice(0, MAX_PROFILE_NAME);
}

function normalizeProfileList(rawProfiles, normalizeGraph, normalizeLinks, legacyState, idFactory = makeProfileId) {
  const source = Array.isArray(rawProfiles) ? rawProfiles.slice(0, MAX_PROFILES) : [];
  const ids = new Set();
  const names = [];
  const profiles = [];

  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    if (!raw || typeof raw !== 'object') continue;

    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : idFactory(ids);
    if (ids.has(id)) id = idFactory(ids);
    ids.add(id);

    const name = uniqueProfileName(raw.name, names, i + 1);
    names.push(name);
    const cards = normalizeGraph(Array.isArray(raw.cards) ? raw.cards : []);
    profiles.push({
      id,
      name,
      cards,
      connections: normalizeLinks(raw.connections, cards)
    });
  }

  if (profiles.length) return profiles;

  const cards = normalizeGraph(Array.isArray(legacyState?.cards) ? legacyState.cards : []);
  return [{
    id: idFactory(ids),
    name: 'Profile 1',
    cards,
    connections: normalizeLinks(legacyState?.connections, cards)
  }];
}

module.exports = { MAX_PROFILES, MAX_PROFILE_NAME, makeProfileId, cleanProfileName, uniqueProfileName, normalizeProfileList };
