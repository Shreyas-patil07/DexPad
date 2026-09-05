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
const canvas       = document.getElementById('canvas');
const world        = document.getElementById('world') || canvas;
const emptyState   = document.getElementById('empty-state');
const controls     = document.getElementById('controls');
const zoomHud      = document.getElementById('zoom-hud');
const zoomLevel    = document.getElementById('zoom-level');
const btnZoomIn    = document.getElementById('btn-zoom-in');
const btnZoomOut   = document.getElementById('btn-zoom-out');
const btnZoomReset = document.getElementById('btn-zoom-reset');

// ─── Camera (Infinite Canvas Engine) ──────────────────────────────────────────
const camera = {
  x: 0,
  y: 0,
  zoom: 1
};

function applyCamera() {
  if (WALLPAPER) return;
  if (world) {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  }
  if (canvas) {
    canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
    canvas.style.backgroundSize = `${28 * camera.zoom}px ${28 * camera.zoom}px`;
  }
  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(camera.zoom * 100)}%`;
  }
}

function setZoom(newZoom, anchorX = null, anchorY = null) {
  if (WALLPAPER) return;
  const clamped = Math.max(0.3, Math.min(2.5, newZoom));
  if (Math.abs(clamped - camera.zoom) < 0.001) return;

  const rect = canvas.getBoundingClientRect();
  const ax = anchorX !== null ? anchorX : rect.width / 2;
  const ay = anchorY !== null ? anchorY : rect.height / 2;

  // Preserve the world point directly under (ax, ay) during scaling
  camera.x = ax - (ax - camera.x) * (clamped / camera.zoom);
  camera.y = ay - (ay - camera.y) * (clamped / camera.zoom);
  camera.zoom = clamped;
  applyCamera();
}

function resetCamera() {
  camera.x = 0;
  camera.y = 0;
  camera.zoom = 1;
  applyCamera();
}

// ─── Selection State ──────────────────────────────────────────────────────────
const selectedIds = new Set();

function selectCard(id, multi = false) {
  if (WALLPAPER) return;
  if (!multi) selectedIds.clear();
  selectedIds.add(id);
  updateSelectionStyles();
}

function toggleSelectCard(id) {
  if (WALLPAPER) return;
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  updateSelectionStyles();
}

function clearSelection() {
  if (WALLPAPER || selectedIds.size === 0) return;
  selectedIds.clear();
  updateSelectionStyles();
}

function updateSelectionStyles() {
  if (WALLPAPER) return;
  for (const el of world.querySelectorAll('.card[data-id]')) {
    if (selectedIds.has(el.dataset.id)) {
      el.classList.add('card--selected');
    } else {
      el.classList.remove('card--selected');
    }
  }
}

// ─── App state ────────────────────────────────────────────────────────────────
let cards     = [];
let saveTimer = null;

// ResizeObserver map — tracked so we can disconnect before removing elements
const roMap = new Map();

// Drag and Pan state
let drag = null;
let panState = null;
let isSpacePressed = false;

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  // Default spawn near camera center in world coordinates
  const spawnX = Math.max(20, Math.round((-camera.x + 80) / camera.zoom + col * 340));
  const spawnY = Math.max(20, Math.round((-camera.y + 80) / camera.zoom + row * 220));

  return {
    id: uid(),
    type,
    title: type === 'note' ? 'New note' : type === 'todo' ? 'New task' : 'New link',
    body: '',
    url: type === 'link' ? 'https://' : '',
    done: false,
    x: spawnX,
    y: spawnY,
    width: 300,
    height: type === 'note' ? 200 : 165,
    zIndex: getMaxZIndex() + 1,
    color: 'default',
    pinned: false,
    tags: []
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────
// 300ms debounce for text input; immediate flush for structure changes
let isSaving = false;
let savePending = false;

function scheduleSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

async function flushSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (isSaving) {
    savePending = true;
    return;
  }
  isSaving = true;
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
  } finally {
    isSaving = false;
    if (savePending) {
      savePending = false;
      flushSave();
    }
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
    const w = Math.max(220, Math.min(720, Math.round(width)));
    const h = Math.max(140, Math.min(720, Math.round(height)));
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

// ─── Build a card element ─────────────────────────────────────────────────────
function buildCard(card) {
  const el = document.createElement('article');
  el.className  = 'card';
  el.dataset.id = card.id;
  positionCard(el, card);

  if (selectedIds.has(card.id)) el.classList.add('card--selected');

  // Elevate card to front and handle selection
  el.addEventListener('mousedown', (e) => {
    bringToFront(card, el);
    if (!WALLPAPER && !e.target.closest('button,input,textarea,a')) {
      if (e.shiftKey) {
        toggleSelectCard(card.id);
      } else if (!selectedIds.has(card.id)) {
        selectCard(card.id, false);
      }
    }
  });

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
      selectedIds.delete(card.id);
      el.classList.add('card--removing');
      el.addEventListener('animationend', () => {
        el.remove();
        cards = cards.filter((c) => c.id !== card.id);
        updateEmptyState();
        flushSave();
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
      flushSave();
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
function reconcile() {
  const domMap = new Map();
  for (const el of world.querySelectorAll('.card[data-id]')) {
    domMap.set(el.dataset.id, el);
  }

  const liveIds = new Set(cards.map((c) => c.id));

  // Remove cards deleted externally
  for (const [id, el] of domMap) {
    if (!liveIds.has(id)) {
      disconnectRO(id);
      selectedIds.delete(id);
      el.remove();
      domMap.delete(id);
    }
  }

  // Update or insert each card
  for (const card of cards) {
    const existing = domMap.get(card.id);
    if (existing) {
      if (!drag || drag.card.id !== card.id) {
        positionCard(existing, card);
      }
      syncInputs(existing, card);
    } else {
      const el = buildCard(card);
      el.classList.add('card--entering');
      world.appendChild(el);
    }
  }

  updateSelectionStyles();
  updateEmptyState();
}

function syncInputs(el, card) {
  for (const input of el.querySelectorAll('[data-field]')) {
    if (input === document.activeElement) continue;
    const field = input.dataset.field;
    if (field === 'done') {
      if (input.checked !== card.done) input.checked = card.done;
    } else {
      const val = String(card[field] ?? '');
      if (input.value !== val) input.value = val;
    }
  }
  const anchor = el.querySelector('.link-open');
  if (anchor) {
    if (anchor.href !== card.url) anchor.href = card.url;
    anchor.hidden = !isValidUrl(card.url);
  }
}

// ─── Full render ──────────────────────────────────────────────────────────────
function fullRender() {
  disconnectAllRO();
  world.replaceChildren(...cards.map(buildCard));
  updateSelectionStyles();
  updateEmptyState();
  applyCamera();
}

function updateEmptyState() {
  if (emptyState) emptyState.hidden = WALLPAPER || cards.length > 0;
  if (controls)   controls.hidden   = WALLPAPER;
  if (zoomHud)    zoomHud.hidden    = WALLPAPER;
}

// ─── Drag & Multi-Select Drag ─────────────────────────────────────────────────
function startDrag(e, card, el) {
  if (e.button !== 0 || WALLPAPER || isSpacePressed) return;
  if (e.target.closest('button,input,textarea,a,label')) return;
  e.preventDefault();
  bringToFront(card, el);

  if (e.shiftKey) {
    toggleSelectCard(card.id);
  } else if (!selectedIds.has(card.id)) {
    selectCard(card.id, false);
  }

  // Snapshot initial coordinates for all selected cards to support batch drag
  const movingCards = selectedIds.has(card.id)
    ? cards.filter((c) => selectedIds.has(c.id))
    : [card];

  const snapshots = movingCards.map((c) => ({
    card: c,
    el: world.querySelector(`.card[data-id="${c.id}"]`),
    origX: c.x,
    origY: c.y
  })).filter((s) => s.el);

  drag = {
    card,
    el,
    startX: e.clientX,
    startY: e.clientY,
    snapshots
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp,     { once: true });
  window.addEventListener('blur',      onCancel, { once: true });
}

function onMove(e) {
  if (!drag) return;
  // Apply inverse camera zoom so cursor drag stays precisely 1:1 on infinite canvas
  const dx = (e.clientX - drag.startX) / camera.zoom;
  const dy = (e.clientY - drag.startY) / camera.zoom;

  for (const item of drag.snapshots) {
    item.card.x = Math.max(0, Math.round(item.origX + dx));
    item.card.y = Math.max(0, Math.round(item.origY + dy));
    item.el.style.left = `${item.card.x}px`;
    item.el.style.top  = `${item.card.y}px`;
  }
}

function onUp() {
  if (!drag) return;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('blur',      onCancel);
  flushSave();
  drag = null;
}

function onCancel() {
  if (!drag) return;
  for (const item of drag.snapshots) {
    item.card.x = item.origX;
    item.card.y = item.origY;
    item.el.style.left = `${item.origX}px`;
    item.el.style.top  = `${item.origY}px`;
  }
  window.removeEventListener('mousemove', onMove);
  drag = null;
}

// ─── Canvas Panning & Keyboard Shortcuts ──────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    isSpacePressed = true;
    if (!WALLPAPER && canvas) canvas.style.cursor = 'grab';
  }
  // Ctrl + 0: reset zoom
  if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    resetCamera();
  }
  // Ctrl + = or Ctrl + +: zoom in
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    setZoom(camera.zoom * 1.15);
  }
  // Ctrl + -: zoom out
  if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    setZoom(camera.zoom / 1.15);
  }
  // Delete or Backspace to delete selected cards
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    for (const id of Array.from(selectedIds)) {
      disconnectRO(id);
      const el = world.querySelector(`.card[data-id="${id}"]`);
      if (el) el.remove();
    }
    cards = cards.filter((c) => !selectedIds.has(c.id));
    selectedIds.clear();
    updateEmptyState();
    flushSave();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    isSpacePressed = false;
    if (!WALLPAPER && canvas && !panState) canvas.style.cursor = 'default';
  }
});

if (canvas && !WALLPAPER) {
  canvas.addEventListener('mousedown', (e) => {
    const isCanvasBg = e.target === canvas || e.target === world;
    // Middle-click OR Spacebar drag OR left click on empty canvas
    if (e.button === 1 || (e.button === 0 && (isSpacePressed || isCanvasBg))) {
      if (isCanvasBg && !isSpacePressed && e.button === 0) {
        clearSelection();
      }
      e.preventDefault();
      canvas.classList.add('is-panning');
      panState = {
        startX: e.clientX,
        startY: e.clientY,
        origCamX: camera.x,
        origCamY: camera.y
      };
      window.addEventListener('mousemove', onPanMove);
      window.addEventListener('mouseup',   onPanUp,   { once: true });
    }
  });

  canvas.addEventListener('wheel', (e) => {
    if (WALLPAPER) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom on Ctrl+Wheel or direct background scroll
    if (e.ctrlKey || e.target === canvas || e.target === world) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      setZoom(camera.zoom * factor, mouseX, mouseY);
    }
  }, { passive: false });
}

function onPanMove(e) {
  if (!panState) return;
  camera.x = Math.round(panState.origCamX + e.clientX - panState.startX);
  camera.y = Math.round(panState.origCamY + e.clientY - panState.startY);
  applyCamera();
}

function onPanUp() {
  if (!panState) return;
  window.removeEventListener('mousemove', onPanMove);
  canvas.classList.remove('is-panning');
  canvas.style.cursor = isSpacePressed ? 'grab' : 'default';
  panState = null;
}

// Zoom HUD buttons
if (btnZoomIn) btnZoomIn.addEventListener('click', () => setZoom(camera.zoom * 1.2));
if (btnZoomOut) btnZoomOut.addEventListener('click', () => setZoom(camera.zoom / 1.2));
if (btnZoomReset) btnZoomReset.addEventListener('click', resetCamera);

// ─── Toolbar events ───────────────────────────────────────────────────────────
if (controls && !WALLPAPER) {
  controls.addEventListener('click', (e) => {
    const type = e.target.dataset.add;
    if (type) {
      const card = newCard(type);
      cards.push(card);
      const el = buildCard(card);
      el.classList.add('card--entering');
      world.appendChild(el);
      selectCard(card.id, false);
      updateEmptyState();
      flushSave();
    }
    if (e.target.id === 'btn-save') flushSave();
  });
}

// Flush saves before window unloads
window.addEventListener('beforeunload', () => {
  flushSave();
});

// ─── Main process state push ──────────────────────────────────────────────────
window.dexpad.onStateUpdated((state) => {
  if (!state || !Array.isArray(state.cards)) return;
  cards = state.cards;
  reconcile();
});

// ─── Initial boot ─────────────────────────────────────────────────────────────
window.dexpad.getState()
  .then((state) => {
    cards = Array.isArray(state.cards) ? state.cards : [];
    fullRender();
  })
  .catch((err) => {
    console.error('[DexPad] Failed to load state:', err);
  });
