'use strict';

// ─── Mode detection ───────────────────────────────────────────────────────────
const MODE      = new URLSearchParams(window.location.search).get('mode') ?? 'control';
const WALLPAPER = MODE === 'wallpaper';

if (WALLPAPER) {
  document.body.classList.add('wallpaper');
  const label = document.getElementById('mode-label');
  if (label) label.textContent = 'Desktop widget';
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('canvas');
const emptyState = document.getElementById('empty-state');
const controls   = document.getElementById('controls');

// ─── App state ────────────────────────────────────────────────────────────────
let cards     = [];
let saveTimer = null;

// ResizeObserver map — tracked so we can disconnect before removing elements
const roMap = new Map();

// Drag state
let drag = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isValidUrl(str) {
  if (typeof str !== 'string' || !str.trim()) return false;
  try {
    const p = new URL(str);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function getMaxZIndex() {
  return cards.reduce((max, c) => Math.max(max, Number(c.zIndex) || 1), 1);
}

function bringToFront(card, el) {
  if (WALLPAPER) return;
  const maxZ = getMaxZIndex() + 1;
  if (card.zIndex !== maxZ) {
    card.zIndex = maxZ;
    if (el) el.style.zIndex = String(maxZ);
    scheduleSave();
  }
}

// ─── New card defaults ────────────────────────────────────────────────────────
function newCard(type) {
  const col = cards.length % 2;
  const row = Math.floor(cards.length / 2);
  return {
    id: uid(),
    type,
    title: type === 'note' ? 'New note' : type === 'todo' ? 'New task' : 'New link',
    body: '',
    url: type === 'link' ? 'https://' : '',
    done: false,
    x: 20 + col * 340,
    y: 20 + row * 220,
    width: 300,
    height: type === 'note' ? 200 : 165,
    zIndex: getMaxZIndex() + 1
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────
// 300ms debounce for text input; immediate flush for structure changes
function scheduleSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

async function flushSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const saved = await window.dexpad.saveCards(cards);
    if (Array.isArray(saved)) {
      for (const s of saved) {
        const local = cards.find((c) => c.id === s.id);
        if (local) Object.assign(local, s);
      }
    }
  } catch (err) {
    console.error('[DexPad] Save failed:', err);
  }
}

// ─── Card data helpers ────────────────────────────────────────────────────────
function patchCard(id, patch) {
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  Object.assign(card, patch);
  scheduleSave();
}

// ─── ResizeObserver ───────────────────────────────────────────────────────────
function connectRO(el, card) {
  if (WALLPAPER || typeof ResizeObserver === 'undefined') return;
  disconnectRO(card.id);
  const ro = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    const w = Math.max(220, Math.min(520, Math.round(width)));
    const h = Math.max(140, Math.min(520, Math.round(height)));
    if (card.width !== w || card.height !== h) {
      card.width = w; card.height = h;
      scheduleSave();
    }
  });
  ro.observe(el);
  roMap.set(card.id, ro);
}

function disconnectRO(id) {
  const ro = roMap.get(id);
  if (ro) { ro.disconnect(); roMap.delete(id); }
}

function disconnectAllRO() {
  for (const ro of roMap.values()) ro.disconnect();
  roMap.clear();
}

// ─── Build a card element (called only once per card lifetime) ────────────────
function buildCard(card) {
  const el = document.createElement('article');
  el.className  = 'card';
  el.dataset.id = card.id;
  positionCard(el, card);

  // Elevate card to front when clicked or focused
  el.addEventListener('mousedown', () => bringToFront(card, el));

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'card-head';

  const typeLabel = document.createElement('span');
  typeLabel.className   = 'card-type';
  typeLabel.textContent = card.type;
  head.appendChild(typeLabel);

  if (!WALLPAPER) {
    const delBtn = document.createElement('button');
    delBtn.className = 'card-delete';
    delBtn.type      = 'button';
    delBtn.title     = 'Delete card';
    delBtn.setAttribute('aria-label', 'Delete this card');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectRO(card.id);
      el.classList.add('card--removing');
      el.addEventListener('animationend', () => {
        el.remove();
        cards = cards.filter((c) => c.id !== card.id);
        updateEmptyState();
        flushSave(); // Immediate persist on delete
      }, { once: true });
    });
    head.appendChild(delBtn);
    head.addEventListener('mousedown', (e) => startDrag(e, card, el));
  }
  el.appendChild(head);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'card-body';

  if (card.type === 'todo') {
    const row = document.createElement('label');
    row.className = 'todo-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = card.done; cb.disabled = WALLPAPER;
    cb.dataset.field = 'done';
    cb.addEventListener('change', () => {
      patchCard(card.id, { done: cb.checked });
      flushSave(); // Immediate persist on todo toggle
    });

    const titleIn = makeInput('text', card.title, 'title-input', 'Task description', 'title');
    titleIn.addEventListener('input', () => patchCard(card.id, { title: titleIn.value }));

    row.append(cb, titleIn);
    body.appendChild(row);
  } else {
    const titleIn = makeInput('text', card.title, 'title-input',
      card.type === 'note' ? 'Note title' : 'Link title', 'title');
    titleIn.addEventListener('input', () => patchCard(card.id, { title: titleIn.value }));
    body.appendChild(titleIn);

    if (card.type === 'note') {
      const ta = document.createElement('textarea');
      ta.className   = 'body-input';
      ta.value       = card.body;
      ta.placeholder = 'Start writing…';
      ta.disabled    = WALLPAPER;
      ta.dataset.field = 'body';
      ta.addEventListener('input', () => patchCard(card.id, { body: ta.value }));
      ta.addEventListener('blur', () => flushSave());
      body.appendChild(ta);
    } else {
      const urlIn = makeInput('url', card.url, 'url-input', 'https://example.com', 'url');
      urlIn.addEventListener('input', () => {
        patchCard(card.id, { url: urlIn.value });
        // Update anchor without re-render
        const a = el.querySelector('.link-open');
        if (a) { a.href = urlIn.value; a.hidden = !isValidUrl(urlIn.value); }
      });
      body.appendChild(urlIn);

      const a = document.createElement('a');
      a.className   = 'link-open';
      a.href        = card.url;
      a.textContent = 'Open link ↗';
      a.hidden      = !isValidUrl(card.url);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.dexpad.openUrl(card.url).catch(console.error);
      });
      body.appendChild(a);
    }
  }

  el.appendChild(body);
  connectRO(el, card);
  return el;
}

function makeInput(type, value, className, placeholder, field) {
  const el = document.createElement('input');
  el.type = type; el.className = className;
  el.value = value; el.placeholder = placeholder;
  el.disabled = WALLPAPER;
  if (field) el.dataset.field = field;
  el.addEventListener('blur', () => flushSave());
  return el;
}

function positionCard(el, card) {
  el.style.left    = `${card.x}px`;
  el.style.top     = `${card.y}px`;
  el.style.width   = `${card.width}px`;
  el.style.zIndex  = String(card.zIndex || 1);
  if (!WALLPAPER) el.style.height = `${card.height}px`;
}

// ─── Reconciler ───────────────────────────────────────────────────────────────
// Updates the DOM to match `cards` WITHOUT destroying existing elements.
// This prevents animation replay, focus loss, and visual glitching.
function reconcile() {
  // Index current DOM cards
  const domMap = new Map();
  for (const el of canvas.querySelectorAll('.card[data-id]')) {
    domMap.set(el.dataset.id, el);
  }

  const liveIds = new Set(cards.map((c) => c.id));

  // Remove cards that were deleted externally
  for (const [id, el] of domMap) {
    if (!liveIds.has(id)) {
      disconnectRO(id);
      el.remove();
      domMap.delete(id);
    }
  }

  // Update or insert each card
  for (const card of cards) {
    const existing = domMap.get(card.id);
    if (existing) {
      // Update position/size in-place (skip during active drag)
      if (!drag || drag.card.id !== card.id) {
        positionCard(existing, card);
      }
      // Patch input values ONLY for inputs that don't have focus
      // (never overwrite what the user is currently typing)
      syncInputs(existing, card);
    } else {
      // New card — build it and give it the entry animation
      const el = buildCard(card);
      el.classList.add('card--entering');
      canvas.appendChild(el);
    }
  }

  updateEmptyState();
}

// Update input values in an existing card element without disturbing focus
function syncInputs(el, card) {
  for (const input of el.querySelectorAll('[data-field]')) {
    if (input === document.activeElement) continue; // never disturb the focused input
    const field = input.dataset.field;
    if (field === 'done') {
      if (input.checked !== card.done) input.checked = card.done;
    } else {
      const val = String(card[field] ?? '');
      if (input.value !== val) input.value = val;
    }
  }
  // Sync link anchor
  const anchor = el.querySelector('.link-open');
  if (anchor) {
    if (anchor.href !== card.url) anchor.href = card.url;
    anchor.hidden = !isValidUrl(card.url);
  }
}

// ─── Full render (used for initial load only) ─────────────────────────────────
function fullRender() {
  disconnectAllRO();
  canvas.replaceChildren(...cards.map(buildCard));
  updateEmptyState();
}

function updateEmptyState() {
  if (emptyState) emptyState.hidden = WALLPAPER || cards.length > 0;
  if (controls)   controls.hidden   = WALLPAPER;
}

// ─── Drag ─────────────────────────────────────────────────────────────────────
function startDrag(e, card, el) {
  if (e.button !== 0 || WALLPAPER) return;
  if (e.target.closest('button,input,textarea,a,label')) return;
  e.preventDefault();
  bringToFront(card, el);
  drag = { card, el, startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp,     { once: true });
  window.addEventListener('blur',      onCancel, { once: true });
}

function onMove(e) {
  if (!drag) return;
  drag.card.x = Math.max(0, Math.round(drag.origX + e.clientX - drag.startX));
  drag.card.y = Math.max(0, Math.round(drag.origY + e.clientY - drag.startY));
  drag.el.style.left = `${drag.card.x}px`;
  drag.el.style.top  = `${drag.card.y}px`;
}

function onUp() {
  if (!drag) return;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('blur',      onCancel);
  flushSave(); // Persist final coordinates immediately upon drop
  drag = null;
}

function onCancel() {
  if (!drag) return;
  drag.card.x = drag.origX; drag.card.y = drag.origY;
  drag.el.style.left = `${drag.origX}px`;
  drag.el.style.top  = `${drag.origY}px`;
  window.removeEventListener('mousemove', onMove);
  drag = null;
}

// ─── Toolbar events ───────────────────────────────────────────────────────────
if (controls && !WALLPAPER) {
  controls.addEventListener('click', (e) => {
    const type = e.target.dataset.add;
    if (type) {
      const card = newCard(type);
      cards.push(card);
      // Append just the new card — don't re-render everything
      const el = buildCard(card);
      el.classList.add('card--entering');
      canvas.appendChild(el);
      updateEmptyState();
      flushSave(); // Immediate persist on new card creation
    }
    if (e.target.id === 'btn-save') flushSave();
  });
}

// Ensure unsaved input buffers are flushed before window unloads
window.addEventListener('beforeunload', () => {
  flushSave();
});

// ─── Main process state push ──────────────────────────────────────────────────
// Uses reconcile() — NOT fullRender() — so existing cards are never destroyed
window.dexpad.onStateUpdated((state) => {
  if (!state || !Array.isArray(state.cards)) return;
  cards = state.cards;
  reconcile(); // ← key: in-place update, no DOM wipe
});

// ─── Initial boot ─────────────────────────────────────────────────────────────
window.dexpad.getState()
  .then((state) => {
    cards = Array.isArray(state.cards) ? state.cards : [];
    fullRender(); // One-time full render on startup
  })
  .catch((err) => {
    console.error('[DexPad] Failed to load state:', err);
  });
