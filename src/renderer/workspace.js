const params = new URLSearchParams(window.location.search);
const wallpaper = params.get('mode') === 'wallpaper';
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const empty = $('empty');
const controls = $('controls');
const modeLabel = $('mode-label');

let cards = [];
let saveTimer = null;
let drag = null;

// Track all active ResizeObservers by card id so we can disconnect
// them before re-rendering, preventing zombie observer callbacks.
const observers = new Map();

if (wallpaper) {
  document.body.classList.add('wallpaper');
  if (modeLabel) modeLabel.textContent = 'Desktop wallpaper';
}

// ── Utilities ──────────────────────────────────────────────────────────────

function uid() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function newCard(type) {
  const index = cards.length;
  return {
    id: uid(),
    type,
    title: type === 'note' ? 'New note' : type === 'todo' ? 'New task' : 'New link',
    body: type === 'note' ? 'Write something…' : '',
    url: type === 'link' ? 'https://' : '',
    done: false,
    x: 40 + (index % 3) * 300,
    y: 40 + Math.floor(index / 3) * 220,
    width: 280,
    height: type === 'note' ? 190 : 160
  };
}

// ── Persistence ────────────────────────────────────────────────────────────

// Debounce saves: wait 600 ms after the last change before writing to disk.
// This prevents hammering the main process on every keystroke.
function scheduleSave() {
  if (wallpaper) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save() {
  if (wallpaper) return;
  clearTimeout(saveTimer);
  try {
    // saveCards returns the server-normalised card array; update in place
    // without re-rendering so the user never loses focus on a text input.
    const saved = await window.dexpad.saveCards(cards);
    // Merge server-normalised values back without touching the DOM
    for (const serverCard of saved) {
      const local = cards.find((c) => c.id === serverCard.id);
      if (local) Object.assign(local, serverCard);
    }
  } catch (err) {
    console.error('[DexPad] Failed to save workspace:', err);
  }
}

// ── Card data helpers ──────────────────────────────────────────────────────

function updateCard(id, patch) {
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  Object.assign(card, patch);
  scheduleSave();
}

// ── Resize observation ─────────────────────────────────────────────────────

function attachResizeObserver(element, card) {
  if (wallpaper || typeof ResizeObserver !== 'function') return;

  // Disconnect any existing observer for this card to avoid leaks
  detachResizeObserver(card.id);

  const observer = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    const width = Math.max(220, Math.min(520, Math.round(rect.width)));
    const height = Math.max(140, Math.min(520, Math.round(rect.height)));
    if (card.width !== width || card.height !== height) {
      card.width = width;
      card.height = height;
      scheduleSave();
    }
  });
  observer.observe(element);
  observers.set(card.id, observer);
}

function detachResizeObserver(cardId) {
  const existing = observers.get(cardId);
  if (existing) {
    existing.disconnect();
    observers.delete(cardId);
  }
}

function disconnectAllObservers() {
  for (const observer of observers.values()) observer.disconnect();
  observers.clear();
}

// ── DOM: card building ─────────────────────────────────────────────────────

function createCardElement(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.style.left = `${card.x}px`;
  el.style.top = `${card.y}px`;
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;

  // ── Card header ──
  const head = document.createElement('div');
  head.className = 'card-head';

  const typeLabel = document.createElement('span');
  typeLabel.className = 'type';
  typeLabel.textContent = card.type;
  head.appendChild(typeLabel);

  if (!wallpaper) {
    const del = document.createElement('button');
    del.className = 'delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete card';
    del.setAttribute('aria-label', 'Delete card');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      detachResizeObserver(card.id);
      cards = cards.filter((c) => c.id !== card.id);
      scheduleSave();
      render();
    });
    head.appendChild(del);

    // Start drag only when clicking the header itself, not its buttons/inputs
    head.addEventListener('mousedown', (e) => startDrag(e, card, el));
  }
  el.appendChild(head);

  // ── Card body ──
  const body = document.createElement('div');
  body.className = 'card-body';

  if (card.type === 'todo') {
    const row = document.createElement('label');
    row.className = 'todo-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = card.done;
    check.disabled = wallpaper;
    // note: `change` fires after the browser has applied the new checked value
    check.addEventListener('change', () => updateCard(card.id, { done: check.checked }));

    const titleInput = document.createElement('input');
    titleInput.className = 'title-input';
    titleInput.value = card.title;
    titleInput.placeholder = 'Task title';
    titleInput.disabled = wallpaper;
    titleInput.addEventListener('input', () => updateCard(card.id, { title: titleInput.value }));

    row.append(check, titleInput);
    body.appendChild(row);
  } else {
    const titleInput = document.createElement('input');
    titleInput.className = 'title-input';
    titleInput.value = card.title;
    titleInput.placeholder = card.type === 'note' ? 'Title' : 'Link title';
    titleInput.disabled = wallpaper;
    titleInput.addEventListener('input', () => updateCard(card.id, { title: titleInput.value }));
    body.appendChild(titleInput);

    if (card.type === 'note') {
      const text = document.createElement('textarea');
      text.className = 'body-input';
      text.value = card.body;
      text.placeholder = 'Write something…';
      text.disabled = wallpaper;
      text.addEventListener('input', () => updateCard(card.id, { body: text.value }));
      body.appendChild(text);
    } else {
      // link card
      const urlInput = document.createElement('input');
      urlInput.className = 'url-input';
      urlInput.type = 'url';
      urlInput.value = card.url;
      urlInput.placeholder = 'https://example.com';
      urlInput.disabled = wallpaper;
      urlInput.addEventListener('input', () => {
        updateCard(card.id, { url: urlInput.value });
        // Update the open-link anchor live without re-rendering the full card
        const anchor = el.querySelector('.link-open');
        if (anchor) {
          anchor.href = urlInput.value;
          anchor.hidden = !/^https?:\/\//i.test(urlInput.value);
        }
      });
      body.appendChild(urlInput);

      const openAnchor = document.createElement('a');
      openAnchor.className = 'link-open';
      openAnchor.href = card.url;
      openAnchor.textContent = 'Open link ↗';
      openAnchor.hidden = !/^https?:\/\//i.test(card.url);
      openAnchor.addEventListener('click', (e) => {
        e.preventDefault();
        window.dexpad.openUrl(card.url).catch(console.error);
      });
      body.appendChild(openAnchor);
    }
  }

  el.appendChild(body);
  attachResizeObserver(el, card);
  return el;
}

// ── Drag ───────────────────────────────────────────────────────────────────

function startDrag(e, card, element) {
  if (e.button !== 0 || wallpaper) return;
  // Don't initiate a drag when clicking interactive children
  if (e.target.closest('button,input,textarea,a')) return;
  drag = { card, element, startX: e.clientX, startY: e.clientY, x: card.x, y: card.y };
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag, { once: true });
  // Cancel drag if the window loses focus (e.g. Alt+Tab) so we don't get stuck
  window.addEventListener('blur', cancelDrag, { once: true });
}

function moveDrag(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  drag.card.x = Math.max(0, Math.round(drag.x + dx));
  drag.card.y = Math.max(0, Math.round(drag.y + dy));
  drag.element.style.left = `${drag.card.x}px`;
  drag.element.style.top = `${drag.card.y}px`;
}

function endDrag() {
  if (!drag) return;
  window.removeEventListener('mousemove', moveDrag);
  window.removeEventListener('blur', cancelDrag);
  scheduleSave();
  drag = null;
}

function cancelDrag() {
  if (!drag) return;
  // Snap back to the position before the drag started
  drag.card.x = drag.x;
  drag.card.y = drag.y;
  drag.element.style.left = `${drag.x}px`;
  drag.element.style.top = `${drag.y}px`;
  window.removeEventListener('mousemove', moveDrag);
  drag = null;
}

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  // Disconnect all observers before wiping the DOM to prevent zombie callbacks
  disconnectAllObservers();
  canvas.replaceChildren(...cards.map(createCardElement));
  if (empty) empty.hidden = wallpaper || cards.length > 0;
  if (controls) controls.hidden = wallpaper;
}

// ── Event wiring ───────────────────────────────────────────────────────────

if (controls) {
  for (const button of controls.querySelectorAll('[data-add]')) {
    button.addEventListener('click', () => {
      cards.push(newCard(button.dataset.add));
      render();
      scheduleSave();
    });
  }
}

const saveButton = $('save');
if (saveButton) {
  saveButton.addEventListener('click', save);
}

// Listen for state pushes from the main process (e.g. when another window saves)
window.dexpad.onStateUpdated((state) => {
  if (!state || !Array.isArray(state.cards)) return;
  cards = state.cards;
  render();
});

// Initial load
window.dexpad.getState().then((state) => {
  cards = Array.isArray(state.cards) ? state.cards : [];
  render();
}).catch((err) => {
  console.error('[DexPad] Failed to load workspace state:', err);
});
