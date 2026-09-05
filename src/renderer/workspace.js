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
let resizeObserver = null;

if (wallpaper) {
  document.body.classList.add('wallpaper');
  modeLabel.textContent = 'Desktop wallpaper';
}

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

function scheduleSave() {
  if (wallpaper) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

async function save() {
  if (wallpaper) return;
  clearTimeout(saveTimer);
  try {
    cards = await window.dexpad.saveCards(cards);
    render();
  } catch (error) {
    console.error('[DexPad] Failed to save workspace:', error);
  }
}

function updateCard(id, patch) {
  const card = cards.find((item) => item.id === id);
  if (!card) return;
  Object.assign(card, patch);
  scheduleSave();
}

function observeResize(element, card) {
  if (wallpaper || typeof ResizeObserver !== 'function') return;
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
}

function createCardElement(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.style.left = `${card.x}px`;
  el.style.top = `${card.y}px`;
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;

  const head = document.createElement('div');
  head.className = 'card-head';
  const type = document.createElement('span');
  type.className = 'type';
  type.textContent = card.type;
  head.appendChild(type);

  if (!wallpaper) {
    const del = document.createElement('button');
    del.className = 'delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      cards = cards.filter((item) => item.id !== card.id);
      scheduleSave();
      render();
    });
    head.appendChild(del);
    head.addEventListener('mousedown', (event) => startDrag(event, card, el));
  }
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'card-body';

  if (card.type === 'todo') {
    const row = document.createElement('label');
    row.className = 'todo-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = card.done;
    check.disabled = wallpaper;
    check.addEventListener('change', () => updateCard(card.id, { done: check.checked }));
    const title = document.createElement('input');
    title.className = 'title-input';
    title.value = card.title;
    title.disabled = wallpaper;
    title.addEventListener('input', () => updateCard(card.id, { title: title.value }));
    row.append(check, title);
    body.appendChild(row);
  } else {
    const title = document.createElement('input');
    title.className = 'title-input';
    title.value = card.title;
    title.disabled = wallpaper;
    title.addEventListener('input', () => updateCard(card.id, { title: title.value }));
    body.appendChild(title);

    if (card.type === 'note') {
      const text = document.createElement('textarea');
      text.className = 'body-input';
      text.value = card.body;
      text.disabled = wallpaper;
      text.addEventListener('input', () => updateCard(card.id, { body: text.value }));
      body.appendChild(text);
    } else {
      const url = document.createElement('input');
      url.className = 'url-input';
      url.value = card.url;
      url.disabled = wallpaper;
      url.addEventListener('input', () => updateCard(card.id, { url: url.value }));
      body.appendChild(url);
      if (/^https?:\/\//i.test(card.url)) {
        const open = document.createElement('a');
        open.className = 'link-open';
        open.href = card.url;
        open.textContent = 'Open link ↗';
        open.addEventListener('click', (event) => {
          event.preventDefault();
          window.dexpad.openUrl(card.url).catch(console.error);
        });
        body.appendChild(open);
      }
    }
  }

  el.appendChild(body);
  observeResize(el, card);
  return el;
}

function startDrag(event, card, element) {
  if (event.button !== 0 || wallpaper) return;
  if (event.target.closest('button,input,textarea,a')) return;
  drag = { card, element, startX: event.clientX, startY: event.clientY, x: card.x, y: card.y };
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag, { once: true });
}

function moveDrag(event) {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  drag.card.x = Math.max(0, Math.round(drag.x + dx));
  drag.card.y = Math.max(0, Math.round(drag.y + dy));
  drag.element.style.left = `${drag.card.x}px`;
  drag.element.style.top = `${drag.card.y}px`;
}

function endDrag() {
  if (!drag) return;
  window.removeEventListener('mousemove', moveDrag);
  scheduleSave();
  drag = null;
}

function render() {
  canvas.replaceChildren();
  empty.hidden = wallpaper || cards.length > 0;
  controls.hidden = wallpaper;
  for (const card of cards) canvas.appendChild(createCardElement(card));
}

for (const button of controls.querySelectorAll('[data-add]')) {
  button.addEventListener('click', () => {
    cards.push(newCard(button.dataset.add));
    render();
    scheduleSave();
  });
}

$('save').addEventListener('click', save);

window.dexpad.onStateUpdated((state) => {
  if (!state || !Array.isArray(state.cards)) return;
  cards = state.cards;
  render();
});

window.dexpad.getState().then((state) => {
  cards = Array.isArray(state.cards) ? state.cards : [];
  render();
}).catch((error) => {
  console.error('[DexPad] Failed to load local workspace:', error);
});
