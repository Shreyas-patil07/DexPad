'use strict';

// ─── Mode detection ───────────────────────────────────────────────────────────
const MODE     = new URLSearchParams(window.location.search).get('mode') ?? 'control';
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
let cards     = [];   // card data array (source of truth)
let saveTimer = null; // debounce handle

// ResizeObserver map: card.id → ResizeObserver instance
// Tracked so we can disconnect them before re-rendering (prevents zombie callbacks)
const resizeObservers = new Map();

// Drag state
let drag = null; // { card, el, startX, startY, origX, origY }

// ─── Unique ID ────────────────────────────────────────────────────────────────
function uid() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── New card template ────────────────────────────────────────────────────────
function newCard(type) {
  const col = cards.length % 2;
  const row = Math.floor(cards.length / 2);
  return {
    id:     uid(),
    type,
    title:  type === 'note' ? 'New note' : type === 'todo' ? 'New task' : 'New link',
    body:   type === 'note' ? '' : '',
    url:    type === 'link' ? 'https://' : '',
    done:   false,
    x:      20 + col * 340,
    y:      20 + row * 220,
    width:  300,
    height: type === 'note' ? 200 : 165
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

// Debounce: wait 600ms after the last edit before writing to disk.
// This stops hammering the main process on every keystroke.
function scheduleSave() {
  if (WALLPAPER) return; // wallpaper window is read-only
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  try {
    // saveCards returns the normalised array; merge values in-place so we
    // don't trigger a re-render and lose the user's cursor / focus position.
    const saved = await window.dexpad.saveCards(cards);
    for (const s of saved) {
      const local = cards.find((c) => c.id === s.id);
      if (local) Object.assign(local, s);
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

function deleteCard(id) {
  disconnectObserver(id);
  cards = cards.filter((c) => c.id !== id);
  scheduleSave();
  render();
}

// ─── ResizeObserver management ────────────────────────────────────────────────

function connectObserver(el, card) {
  if (WALLPAPER || typeof ResizeObserver === 'undefined') return;
  disconnectObserver(card.id); // clean up any existing observer first

  const ro = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    const w = Math.max(220, Math.min(520, Math.round(width)));
    const h = Math.max(140, Math.min(520, Math.round(height)));
    if (card.width !== w || card.height !== h) {
      card.width  = w;
      card.height = h;
      scheduleSave();
    }
  });
  ro.observe(el);
  resizeObservers.set(card.id, ro);
}

function disconnectObserver(cardId) {
  const ro = resizeObservers.get(cardId);
  if (ro) { ro.disconnect(); resizeObservers.delete(cardId); }
}

function disconnectAllObservers() {
  for (const ro of resizeObservers.values()) ro.disconnect();
  resizeObservers.clear();
}

// ─── Card DOM construction ────────────────────────────────────────────────────

function buildCard(card) {
  // ── Wrapper ──
  const el = document.createElement('article');
  el.className   = 'card';
  el.dataset.id  = card.id;
  el.style.left  = `${card.x}px`;
  el.style.top   = `${card.y}px`;
  el.style.width = `${card.width}px`;
  if (!WALLPAPER) el.style.height = `${card.height}px`;

  // ── Header ──
  const head = document.createElement('div');
  head.className = 'card-head';

  const typeLabel = document.createElement('span');
  typeLabel.className   = 'card-type';
  typeLabel.textContent = card.type;
  head.appendChild(typeLabel);

  if (!WALLPAPER) {
    const delBtn = document.createElement('button');
    delBtn.className  = 'card-delete';
    delBtn.type       = 'button';
    delBtn.title      = 'Delete card';
    delBtn.setAttribute('aria-label', 'Delete this card');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCard(card.id);
    });
    head.appendChild(delBtn);

    // Drag: only start if click lands on the header itself (not a child button)
    head.addEventListener('mousedown', (e) => startDrag(e, card, el));
  }

  el.appendChild(head);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'card-body';

  if (card.type === 'todo') {
    const row = document.createElement('label');
    row.className = 'todo-row';

    const checkbox = document.createElement('input');
    checkbox.type    = 'checkbox';
    checkbox.checked = card.done;
    checkbox.disabled = WALLPAPER;
    checkbox.addEventListener('change', () => patchCard(card.id, { done: checkbox.checked }));

    const titleIn = buildInput('text', card.title, 'title-input', 'Task description');
    titleIn.addEventListener('input', () => patchCard(card.id, { title: titleIn.value }));

    row.append(checkbox, titleIn);
    body.appendChild(row);

  } else {
    const titleIn = buildInput('text', card.title, 'title-input',
      card.type === 'note' ? 'Note title' : 'Link title'
    );
    titleIn.addEventListener('input', () => patchCard(card.id, { title: titleIn.value }));
    body.appendChild(titleIn);

    if (card.type === 'note') {
      const textarea = document.createElement('textarea');
      textarea.className   = 'body-input';
      textarea.value       = card.body;
      textarea.placeholder = 'Start writing…';
      textarea.disabled    = WALLPAPER;
      textarea.addEventListener('input', () => patchCard(card.id, { body: textarea.value }));
      body.appendChild(textarea);

    } else { // link
      const urlIn = buildInput('url', card.url, 'url-input', 'https://example.com');
      urlIn.addEventListener('input', () => {
        patchCard(card.id, { url: urlIn.value });
        // Update anchor in-place without re-rendering the whole card
        const anchor = el.querySelector('.link-open');
        if (anchor) {
          anchor.href   = urlIn.value;
          anchor.hidden = !isValidUrl(urlIn.value);
        }
      });
      body.appendChild(urlIn);

      const anchor = document.createElement('a');
      anchor.className   = 'link-open';
      anchor.href        = card.url;
      anchor.textContent = 'Open link ↗';
      anchor.hidden      = !isValidUrl(card.url);
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        window.dexpad.openUrl(card.url).catch(console.error);
      });
      body.appendChild(anchor);
    }
  }

  el.appendChild(body);

  // Observe size changes so the stored dimensions stay accurate
  connectObserver(el, card);
  return el;
}

function buildInput(type, value, className, placeholder) {
  const el = document.createElement('input');
  el.type        = type;
  el.className   = className;
  el.value       = value;
  el.placeholder = placeholder;
  el.disabled    = WALLPAPER;
  return el;
}

function isValidUrl(str) {
  return typeof str === 'string' && /^https?:\/\//i.test(str);
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function startDrag(e, card, el) {
  // Only left button; ignore clicks on interactive children
  if (e.button !== 0 || WALLPAPER) return;
  if (e.target.closest('button,input,textarea,a,label')) return;

  e.preventDefault();
  drag = { card, el, startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };

  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup',   onDragEnd, { once: true });
  // Cancel drag cleanly if the window loses focus mid-drag (e.g. Alt+Tab)
  window.addEventListener('blur',      onDragCancel, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  drag.card.x = Math.max(0, Math.round(drag.origX + e.clientX - drag.startX));
  drag.card.y = Math.max(0, Math.round(drag.origY + e.clientY - drag.startY));
  drag.el.style.left = `${drag.card.x}px`;
  drag.el.style.top  = `${drag.card.y}px`;
}

function onDragEnd() {
  if (!drag) return;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('blur',      onDragCancel);
  scheduleSave();
  drag = null;
}

function onDragCancel() {
  if (!drag) return;
  // Snap back to original position
  drag.card.x = drag.origX;
  drag.card.y = drag.origY;
  drag.el.style.left = `${drag.origX}px`;
  drag.el.style.top  = `${drag.origY}px`;
  window.removeEventListener('mousemove', onDragMove);
  drag = null;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  // Disconnect all ResizeObservers BEFORE clearing the DOM — prevents zombie callbacks
  disconnectAllObservers();

  canvas.replaceChildren(...cards.map(buildCard));

  if (emptyState) emptyState.hidden = WALLPAPER || cards.length > 0;
  if (controls)   controls.hidden   = WALLPAPER;
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Toolbar: add card buttons
if (controls && !WALLPAPER) {
  controls.addEventListener('click', (e) => {
    const type = e.target.dataset.add;
    if (type) {
      cards.push(newCard(type));
      render();
      scheduleSave();
    }
    if (e.target.id === 'btn-save') flushSave();
  });
}

// State pushed from main process (e.g. another window saves, wallpaper refresh)
window.dexpad.onStateUpdated((state) => {
  if (!state || !Array.isArray(state.cards)) return;
  cards = state.cards;
  render();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.dexpad.getState()
  .then((state) => {
    cards = Array.isArray(state.cards) ? state.cards : [];
    render();
  })
  .catch((err) => {
    console.error('[DexPad] Failed to load state:', err);
  });
