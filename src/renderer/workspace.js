'use strict';

const MODE = new URLSearchParams(window.location.search).get('mode') || 'control';
const WALLPAPER = MODE === 'wallpaper';
if (WALLPAPER) document.body.classList.add('wallpaper');

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const world = $('world');
const connectionsSvg = $('connections');
const selectionToolbar = $('selection-toolbar');
const emptyState = $('empty-state');
const zoomLevel = $('zoom-level');

let cards = [];
let connections = [];
let activeFilter = 'all';
let searchQuery = '';
let saveTimer = null;
let isSaving = false;
let savePending = false;
let dragging = null;
let pan = null;
let spaceDown = false;
let drawFrame = 0;
let history = [];
let future = [];
let historyStamp = 0;
const selectedIds = new Set();
const resizeObservers = new Map();

const camera = { x: 0, y: 0, zoom: 1 };
const uid = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const clone = value => JSON.parse(JSON.stringify(value));

function snapshot() { return { cards: clone(cards), connections: clone(connections) }; }
function recordHistory(force = false) {
  const now = Date.now();
  if (!force && now - historyStamp < 700) return;
  history.push(snapshot());
  if (history.length > 100) history.shift();
  future = [];
  historyStamp = now;
  updateHistoryButtons();
}

function restoreSnapshot(snap) {
  cards = clone(snap?.cards || []);
  connections = clone(snap?.connections || []);
  selectedIds.clear();
  reconcile();
  flushSave();
}

function undo() {
  if (WALLPAPER || !history.length) return;
  future.push(snapshot());
  restoreSnapshot(history.pop());
}

function redo() {
  if (WALLPAPER || !future.length) return;
  history.push(snapshot());
  restoreSnapshot(future.pop());
}

function updateHistoryButtons() {
  const undoBtn = $('btn-undo');
  const redoBtn = $('btn-redo');
  if (undoBtn) undoBtn.disabled = WALLPAPER || !history.length;
  if (redoBtn) redoBtn.disabled = WALLPAPER || !future.length;
}

function applyCamera() {
  if (!WALLPAPER && world) {
    world.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;
    canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
    canvas.style.backgroundSize = `${28 * camera.zoom}px ${28 * camera.zoom}px`;
    if (zoomLevel) zoomLevel.textContent = `${Math.round(camera.zoom * 100)}%`;
  }
  scheduleDrawConnections();
}

function setZoom(value, anchorX = canvas.clientWidth / 2, anchorY = canvas.clientHeight / 2) {
  if (WALLPAPER) return;
  const next = Math.max(0.3, Math.min(2.5, Number(value) || 1));
  if (Math.abs(next - camera.zoom) < 0.001) return;
  const ratio = next / camera.zoom;
  camera.x = anchorX - (anchorX - camera.x) * ratio;
  camera.y = anchorY - (anchorY - camera.y) * ratio;
  camera.zoom = next;
  applyCamera();
}

function resetCamera() {
  if (WALLPAPER) return;
  camera.x = 0; camera.y = 0; camera.zoom = 1;
  applyCamera();
}

function clearSelection() {
  selectedIds.clear();
  updateSelection();
}

function toggleSelection(id, multi = false) {
  if (WALLPAPER) return;
  if (!multi) selectedIds.clear();
  if (selectedIds.has(id) && multi) selectedIds.delete(id);
  else selectedIds.add(id);
  updateSelection();
}

function updateSelection() {
  for (const el of world.querySelectorAll('.card[data-id]')) {
    el.classList.toggle('card--selected', selectedIds.has(el.dataset.id));
  }
  const toolbar = selectionToolbar;
  if (toolbar) toolbar.hidden = WALLPAPER || selectedIds.size === 0;
  const count = $('selection-count');
  if (count) count.textContent = `${selectedIds.size} selected`;
}

function maxZ() { return cards.reduce((m, c) => Math.max(m, Number(c.zIndex) || 1), 1); }

function patchCard(id, patch) {
  if (WALLPAPER) return;
  const card = cards.find(c => c.id === id);
  if (!card || card.locked) return;
  recordHistory();
  Object.assign(card, patch);
  scheduleSave();
  const el = findCardElement(id);
  if (el) {
    positionCard(el, card);
    syncInputs(el, card);
  }
  scheduleDrawConnections();
}

function scheduleSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

async function flushSave() {
  if (WALLPAPER) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (isSaving) { savePending = true; return; }
  isSaving = true;
  try {
    const saved = await window.dexpad.saveWorkspace({ cards, connections });
    if (saved && Array.isArray(saved.cards)) {
      const ids = new Set(saved.cards.map(c => c.id));
      cards = saved.cards;
      connections = Array.isArray(saved.connections) ? saved.connections : connections.filter(c => ids.has(c.a) && ids.has(c.b));
      selectedIds.clear();
      reconcile();
    }
    setSaveStatus('Saved');
  } catch (err) {
    console.error('[DexPad] Save failed:', err);
    setSaveStatus('Save failed');
  } finally {
    isSaving = false;
    if (savePending) { savePending = false; flushSave(); }
  }
}

function setSaveStatus(status) {
  const button = $('btn-save');
  if (!button) return;
  button.textContent = status === 'Saved' ? 'Saved ✓' : status;
  clearTimeout(button._timer);
  button._timer = setTimeout(() => { button.textContent = 'Save'; }, 1200);
}

function validateImageSource(src) {
  if (typeof src !== 'string' || !src.trim()) return false;
  return src.startsWith('data:image/') || (() => {
    try { const u = new URL(src); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (_) { return false; }
  })();
}

function makeCard(type) {
  const supported = ['note','todo','link','markdown','image','file','column','group','board'];
  if (!supported.includes(type)) type = 'note';
  const col = cards.length % 3;
  const row = Math.floor(cards.length / 3);
  const x = Math.max(20, Math.round((-camera.x + 90) / camera.zoom + col * 330));
  const y = Math.max(20, Math.round((-camera.y + 90) / camera.zoom + row * 210));
  return {
    id: uid('block'), type, color: 'default', pinned: false, locked: false, collapsed: false,
    tags: [],
    title: type === 'todo' ? 'New task' : type === 'link' ? 'New link' : type === 'markdown' ? 'New markdown' : type === 'image' ? 'New image' : type === 'file' ? 'New file' : type === 'column' ? 'New column' : type === 'group' ? 'New group' : type === 'board' ? 'New board' : 'New note',
    body: '', url: type === 'link' ? 'https://' : '', markdown: '', src: '', path: '', description: '', done: false,
    children: [], x, y, width: type === 'column' ? 280 : 300, height: type === 'note' || type === 'markdown' ? 210 : 170, zIndex: maxZ() + 1
  };
}

function addCard(type, at = null) {
  if (WALLPAPER) return;
  recordHistory(true);
  const card = makeCard(type);
  if (at) {
    const rect = canvas.getBoundingClientRect();
    card.x = Math.max(0, Math.round((at.x - rect.left - camera.x) / camera.zoom));
    card.y = Math.max(0, Math.round((at.y - rect.top - camera.y) / camera.zoom));
  }
  cards.push(card);
  selectedIds.clear(); selectedIds.add(card.id);
  reconcile();
  flushSave();
  closeTransientMenus();
}

function deleteIds(ids) {
  if (WALLPAPER || !ids?.size) return;
  recordHistory(true);
  cards = cards.filter(c => !ids.has(c.id));
  connections = connections.filter(c => !ids.has(c.a) && !ids.has(c.b));
  for (const id of ids) selectedIds.delete(id);
  reconcile();
  flushSave();
}

function togglePin(ids) {
  if (WALLPAPER || !ids?.size) return;
  recordHistory(true);
  for (const card of cards) if (ids.has(card.id) && !card.locked) card.pinned = !card.pinned;
  reconcile();
  flushSave();
}

function toggleLock(id) {
  if (WALLPAPER) return;
  const card = cards.find(c => c.id === id);
  if (!card) return;
  recordHistory(true);
  card.locked = !card.locked;
  reconcile();
  flushSave();
}

function groupSelected() {
  if (WALLPAPER || selectedIds.size < 2) return toast('Select at least two blocks');
  recordHistory(true);
  const items = cards.filter(c => selectedIds.has(c.id));
  const x = Math.max(20, Math.min(...items.map(c => c.x)) - 28);
  const y = Math.max(20, Math.min(...items.map(c => c.y)) - 50);
  const right = Math.max(...items.map(c => c.x + c.width));
  const bottom = Math.max(...items.map(c => c.y + c.height));
  const group = makeCard('group');
  group.title = 'Group';
  group.x = x; group.y = y;
  group.width = Math.max(300, right - x + 28);
  group.height = Math.max(190, bottom - y + 62);
  group.children = items.map(c => c.id);
  group.zIndex = Math.max(1, Math.min(...items.map(c => Number(c.zIndex) || 1)) - 1);
  cards.push(group);
  selectedIds.clear(); selectedIds.add(group.id);
  reconcile();
  flushSave();
}

function connectSelected() {
  if (WALLPAPER || selectedIds.size !== 2) return toast('Select exactly two blocks');
  const [a, b] = [...selectedIds];
  if (a === b) return;
  if (connections.some(c => (c.a === a && c.b === b) || (c.a === b && c.b === a))) return toast('Already connected');
  recordHistory(true);
  connections.push({ id: uid('connection'), a, b, label: '' });
  scheduleDrawConnections();
  flushSave();
  toast('Connected');
}

function openBoard(id) {
  const board = cards.find(c => c.id === id);
  if (!board) return;
  toast(`Board “${board.title || 'Untitled'}” is ready for nested content.`);
}

function isValidUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch (_) { return false; }
}

function openUrl(value) {
  if (isValidUrl(value)) window.dexpad.openUrl(value).catch(err => console.error('[DexPad] openUrl failed:', err));
}

function findCardElement(id) {
  try { return world.querySelector(`[data-id="${CSS.escape(id)}"]`); }
  catch (_) { return [...world.querySelectorAll('.card[data-id]')].find(el => el.dataset.id === id) || null; }
}

function positionCard(el, card) {
  el.style.left = `${card.x}px`;
  el.style.top = `${card.y}px`;
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;
  el.style.zIndex = String(card.zIndex || 1);
  el.dataset.color = card.color || 'default';
  el.dataset.pinned = String(!!card.pinned);
  el.dataset.locked = String(!!card.locked);
}

function syncInputs(el, card) {
  for (const control of el.querySelectorAll('[data-field]')) {
    if (control === document.activeElement) continue;
    const field = control.dataset.field;
    if (control.type === 'checkbox') control.checked = Boolean(card[field]);
    else control.value = String(card[field] ?? '');
  }
  const preview = el.querySelector('.markdown-preview');
  if (preview) preview.textContent = (card.markdown || card.body || '').replace(/^#{1,6}\s*/gm, '').replace(/[\*_`]/g, '');
  const image = el.querySelector('.block-image');
  if (image && image.src !== card.src && validateImageSource(card.src)) image.src = card.src;
  const path = el.querySelector('.file-path');
  if (path) path.textContent = card.path || 'No file selected';
}

function observeResize(el, card) {
  if (WALLPAPER || typeof ResizeObserver === 'undefined') return;
  const previous = resizeObservers.get(card.id);
  if (previous) previous.disconnect();
  const ro = new ResizeObserver(([entry]) => {
    if (!entry || dragging?.multi?.some(item => item.c.id === card.id)) return;
    const width = Math.max(220, Math.min(900, Math.round(entry.contentRect.width)));
    const height = Math.max(140, Math.min(900, Math.round(entry.contentRect.height)));
    if (card.width !== width || card.height !== height) {
      recordHistory();
      card.width = width;
      card.height = height;
      scheduleSave();
    }
  });
  ro.observe(el);
  resizeObservers.set(card.id, ro);
}

function disconnectAllObservers() {
  for (const ro of resizeObservers.values()) ro.disconnect();
  resizeObservers.clear();
}

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.dataset.type = card.type;
  positionCard(el, card);
  el.classList.toggle('card--selected', selectedIds.has(card.id));

  const head = document.createElement('div');
  head.className = 'card-head';
  const type = document.createElement('span');
  type.className = 'card-type';
  type.textContent = card.type;
  head.appendChild(type);

  if (!WALLPAPER) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const defs = [
      ['☆', card.pinned ? 'Unpin' : 'Pin', () => togglePin(new Set([card.id]))],
      [card.locked ? '🔒' : '↗', card.locked ? 'Unlock' : 'Bring to front', () => card.locked ? toggleLock(card.id) : bringToFront(card.id)],
      ['×', 'Delete', () => deleteIds(new Set([card.id]))]
    ];
    for (const [label, titleText, fn] of defs) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = `card-action${label === '×' ? ' danger' : ''}`;
      btn.textContent = label; btn.title = titleText;
      btn.addEventListener('click', e => { e.stopPropagation(); fn(); });
      actions.appendChild(btn);
    }
    head.appendChild(actions);
    head.addEventListener('mousedown', e => startDrag(e, card));
  }
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'card-body';
  const renderer = window.DexBlockRegistry?.get(card.type);
  if (renderer) {
    renderer(body, {
      card,
      wallpaper: WALLPAPER,
      disabled: WALLPAPER || card.locked,
      patch: patch => patchCard(card.id, patch),
      flush: flushSave,
      isValidUrl,
      openUrl,
      openBoard
    });
  }

  if (card.description) {
    const desc = document.createElement('div');
    desc.className = 'block-placeholder';
    desc.textContent = card.description;
    body.append(desc);
  }

  if (Array.isArray(card.tags) && card.tags.length) {
    const meta = document.createElement('div');
    meta.className = 'block-meta';
    for (const tag of card.tags) {
      const item = document.createElement('span');
      item.textContent = `#${tag}`;
      meta.appendChild(item);
    }
    if (card.pinned) { const star = document.createElement('span'); star.textContent = '★'; meta.appendChild(star); }
    body.append(meta);
  }

  el.appendChild(body);
  observeResize(el, card);
  el.addEventListener('mousedown', e => {
    if (WALLPAPER) return;
    if (e.target.closest('button,input,textarea,a')) return;
    toggleSelection(card.id, e.shiftKey);
  });
  return el;
}

function reconcile() {
  disconnectAllObservers();
  const visible = cards.filter(matches);
  world.replaceChildren(...visible.map(buildCard));
  for (const id of [...selectedIds]) if (!cards.some(c => c.id === id)) selectedIds.delete(id);
  updateSelection();
  updateCounts();
  if (emptyState) emptyState.hidden = WALLPAPER || cards.length > 0;
  applyCamera();
}

function matches(card) {
  if (activeFilter === 'favorite' && !card.pinned) return false;
  if (activeFilter !== 'all' && activeFilter !== 'favorite' && activeFilter !== 'other' && card.type !== activeFilter) return false;
  if (activeFilter === 'other' && ['note','todo','link'].includes(card.type)) return false;
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [card.title, card.body, card.url, card.markdown, card.src, card.path, card.description, ...(card.tags || [])]
    .some(value => String(value || '').toLowerCase().includes(q));
}

function updateCounts() {
  const all = cards.length;
  if ($('count-all')) $('count-all').textContent = all;
  if ($('count-note')) $('count-note').textContent = cards.filter(c => c.type === 'note').length;
  if ($('count-todo')) $('count-todo').textContent = cards.filter(c => c.type === 'todo').length;
  if ($('count-link')) $('count-link').textContent = cards.filter(c => c.type === 'link').length;
  if ($('count-favorite')) $('count-favorite').textContent = cards.filter(c => c.pinned).length;
  if ($('count-other')) $('count-other').textContent = cards.filter(c => !['note','todo','link'].includes(c.type)).length;
  updateHistoryButtons();
}

function bringToFront(id) {
  const card = cards.find(c => c.id === id);
  if (!card || card.locked || WALLPAPER) return;
  recordHistory(true);
  card.zIndex = maxZ() + 1;
  reconcileCard(id);
  flushSave();
}

function reconcileCard(id) {
  const card = cards.find(c => c.id === id);
  const el = findCardElement(id);
  if (!card || !el) { reconcile(); return; }
  positionCard(el, card);
  syncInputs(el, card);
  el.dataset.pinned = String(!!card.pinned);
  el.dataset.locked = String(!!card.locked);
  updateSelection();
  scheduleDrawConnections();
}

function startDrag(e, card) {
  if (WALLPAPER || card.locked || e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  if (!selectedIds.has(card.id)) { selectedIds.clear(); selectedIds.add(card.id); updateSelection(); }
  recordHistory(true);
  dragging = {
    startX: e.clientX,
    startY: e.clientY,
    multi: [...selectedIds].map(id => {
      const c = cards.find(x => x.id === id);
      return c ? { c, x: c.x, y: c.y } : null;
    }).filter(Boolean)
  };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag, { once: true });
}

function onDrag(e) {
  if (!dragging) return;
  const dx = (e.clientX - dragging.startX) / camera.zoom;
  const dy = (e.clientY - dragging.startY) / camera.zoom;
  for (const item of dragging.multi) {
    item.c.x = Math.max(0, Math.round(item.x + dx));
    item.c.y = Math.max(0, Math.round(item.y + dy));
    const el = findCardElement(item.c.id);
    if (el) positionCard(el, item.c);
  }
  scheduleDrawConnections();
}

function endDrag() {
  if (!dragging) return;
  dragging = null;
  document.removeEventListener('mousemove', onDrag);
  scheduleSave();
  flushSave();
}

function startPan(e) {
  if (WALLPAPER || (e.button !== 1 && !(spaceDown && e.button === 0))) return;
  e.preventDefault();
  pan = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y };
  canvas.classList.add('is-panning');
  document.addEventListener('mousemove', onPan);
  document.addEventListener('mouseup', endPan, { once: true });
}

function onPan(e) {
  if (!pan) return;
  camera.x = pan.cx + (e.clientX - pan.x);
  camera.y = pan.cy + (e.clientY - pan.y);
  applyCamera();
}

function endPan() {
  pan = null;
  canvas.classList.remove('is-panning');
  document.removeEventListener('mousemove', onPan);
}

function scheduleDrawConnections() {
  if (drawFrame || !connectionsSvg || WALLPAPER) return;
  drawFrame = requestAnimationFrame(() => { drawFrame = 0; drawConnections(); });
}

function drawConnections() {
  if (!connectionsSvg) return;
  connectionsSvg.replaceChildren();
  if (WALLPAPER) return;
  for (const connection of connections) {
    const a = cards.find(c => c.id === connection.a);
    const b = cards.find(c => c.id === connection.b);
    if (!a || !b || !matches(a) || !matches(b)) continue;
    const x1 = (a.x + a.width / 2) * camera.zoom + camera.x;
    const y1 = (a.y + a.height / 2) * camera.zoom + camera.y;
    const x2 = (b.x + b.width / 2) * camera.zoom + camera.x;
    const y2 = (b.y + b.height / 2) * camera.zoom + camera.y;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'rgba(118,168,255,.45)');
    line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-linecap', 'round');
    connectionsSvg.appendChild(line);
  }
}

function closeOverlay(id) { const el = $(id); if (el) el.hidden = true; }
function closeTransientMenus() { const menu = $('add-menu'); if (menu) menu.hidden = true; const templates = $('templates-menu'); if (templates) templates.remove(); }
function openOverlay(id) { const el = $(id); if (!el) return; el.hidden = false; const input = el.querySelector('input'); if (input) { input.value = ''; input.focus(); if (id === 'search-overlay') searchQuery = ''; else if (id === 'command-overlay') renderCommands(); } }
function toast(message) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message; el.classList.add('show');
  clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 1500);
}

function renderSearch() {
  const root = $('search-results');
  if (!root) return;
  searchQuery = ($('search-input')?.value || '').trim();
  root.replaceChildren();
  cards.filter(matches).slice(0, 50).forEach(card => {
    const row = document.createElement('div'); row.className = 'result-row';
    const left = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = card.title || card.type;
    const small = document.createElement('small'); small.textContent = (card.body || card.markdown || card.url || card.path || '').slice(0, 100);
    left.append(strong, small);
    const typ = document.createElement('span'); typ.className = 'result-type'; typ.textContent = card.type;
    row.append(left, typ);
    row.addEventListener('click', () => {
      selectedIds.clear(); selectedIds.add(card.id);
      closeOverlay('search-overlay');
      activeFilter = 'all'; searchQuery = '';
      camera.x = Math.round(canvas.clientWidth / 2 - (card.x + card.width / 2) * camera.zoom);
      camera.y = Math.round(canvas.clientHeight / 2 - (card.y + card.height / 2) * camera.zoom);
      reconcile();
    });
    root.appendChild(row);
  });
}

const commands = [
  ['Add note','Create a note','note'],['Add task','Create a task','todo'],['Add link','Create a link','link'],['Add markdown','Create Markdown','markdown'],
  ['Add image','Create an image block','image'],['Add file','Create a file block','file'],['Add column','Create a column','column'],['Add group','Group blocks','group'],['Add board','Create a board','board'],
  ['Group selected','Group the current selection','group-selected'],['Pin selected','Toggle pin','pin'],['Connect selected','Connect exactly two blocks','connect'],['Export workspace','Export JSON','export'],['Import workspace','Import JSON','import'],['Undo','Undo','undo'],['Redo','Redo','redo'],['Reset view','Reset canvas','reset']
];

function renderCommands() {
  const root = $('command-results');
  if (!root) return;
  const q = ($('command-input')?.value || '').trim().toLowerCase();
  root.replaceChildren();
  commands.filter(c => !q || c[0].toLowerCase().includes(q)).forEach(c => {
    const row = document.createElement('div'); row.className = 'result-row';
    const left = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = c[0];
    const small = document.createElement('small'); small.textContent = c[1]; left.append(strong, small); row.appendChild(left);
    row.addEventListener('click', () => runCommand(c[2])); root.appendChild(row);
  });
}

function runCommand(command) {
  closeOverlay('command-overlay');
  if (command === 'undo') return undo();
  if (command === 'redo') return redo();
  if (command === 'reset') return resetCamera();
  if (command === 'export') return exportWorkspace();
  if (command === 'import') return $('import-input')?.click();
  if (command === 'group-selected') return groupSelected();
  if (command === 'pin') return togglePin(selectedIds);
  if (command === 'connect') return connectSelected();
  addCard(command);
}

function exportWorkspace() {
  const data = JSON.stringify({ schemaVersion: 4, cards, connections }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `dexpad-workspace-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 500);
  toast('Workspace exported');
}

function importWorkspace(file) {
  if (!file || WALLPAPER) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!data || !Array.isArray(data.cards) || data.cards.length > 5000) throw new Error('Invalid workspace file');
      recordHistory(true);
      const saved = await window.dexpad.saveWorkspace({ cards: data.cards, connections: Array.isArray(data.connections) ? data.connections : [] });
      cards = Array.isArray(saved?.cards) ? saved.cards : [];
      connections = Array.isArray(saved?.connections) ? saved.connections : [];
      selectedIds.clear();
      reconcile();
      toast('Workspace imported');
    } catch (err) {
      console.error('[DexPad] Import failed:', err);
      toast('Import failed');
    }
  };
  reader.readAsText(file);
}

function applyTemplate(name) {
  if (WALLPAPER) return;
  recordHistory(true);
  cards = [];
  connections = [];
  if (name === 'project') {
    const specs = [['column','Ideas'],['column','In progress'],['column','Done'],['note','Project brief'],['todo','First task'],['link','Reference']];
    specs.forEach(([type,title], i) => { const c = makeCard(type); c.title = title; c.x = 70 + (i % 3) * 320; c.y = 70 + Math.floor(i / 3) * 220; cards.push(c); });
  } else if (name === 'weekly') {
    ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach((day,i) => { const c = makeCard('todo'); c.title = day; c.x = 80 + (i % 3) * 330; c.y = 80 + Math.floor(i / 3) * 200; cards.push(c); });
  }
  selectedIds.clear(); reconcile(); flushSave(); toast('Template applied');
}

function showTemplates() {
  const existing = $('templates-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div'); menu.id = 'templates-menu'; menu.className = 'floating-menu';
  const a = document.createElement('button'); a.textContent = 'Project board'; a.onclick = () => { applyTemplate('project'); menu.remove(); };
  const b = document.createElement('button'); b.textContent = 'Weekly planner'; b.onclick = () => { applyTemplate('weekly'); menu.remove(); };
  menu.append(a,b);
  $('btn-templates')?.parentElement?.appendChild(menu);
}

$('btn-add')?.addEventListener('click', () => { const m = $('add-menu'); if (m) m.hidden = !m.hidden; });
document.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addCard(button.dataset.add)));
$('btn-templates')?.addEventListener('click', showTemplates);
$('btn-save')?.addEventListener('click', flushSave);
$('btn-undo')?.addEventListener('click', undo);
$('btn-redo')?.addEventListener('click', redo);
$('btn-search')?.addEventListener('click', () => openOverlay('search-overlay'));
$('btn-command')?.addEventListener('click', () => openOverlay('command-overlay'));
$('btn-delete-selected')?.addEventListener('click', () => deleteIds(new Set(selectedIds)));
$('btn-group-selected')?.addEventListener('click', groupSelected);
$('btn-pin-selected')?.addEventListener('click', () => togglePin(selectedIds));
$('btn-connect')?.addEventListener('click', connectSelected);
$('btn-export')?.addEventListener('click', exportWorkspace);
$('btn-import')?.addEventListener('click', () => $('import-input')?.click());
$('import-input')?.addEventListener('change', e => { if (e.target.files?.[0]) importWorkspace(e.target.files[0]); e.target.value = ''; });
$('btn-zoom-in')?.addEventListener('click', () => setZoom(camera.zoom + 0.15));
$('btn-zoom-out')?.addEventListener('click', () => setZoom(camera.zoom - 0.15));
$('btn-zoom-reset')?.addEventListener('click', resetCamera);

document.querySelectorAll('.side-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.side-item').forEach(x => x.classList.remove('active'));
  button.classList.add('active');
  activeFilter = button.dataset.filter || 'all';
  searchQuery = '';
  selectedIds.clear();
  reconcile();
}));

$('search-input')?.addEventListener('input', renderSearch);
$('command-input')?.addEventListener('input', renderCommands);
$('search-overlay')?.addEventListener('click', e => { if (e.target === $('search-overlay')) closeOverlay('search-overlay'); });
$('command-overlay')?.addEventListener('click', e => { if (e.target === $('command-overlay')) closeOverlay('command-overlay'); });

canvas?.addEventListener('mousedown', e => {
  if (e.target === canvas) clearSelection();
  startPan(e);
});
canvas?.addEventListener('wheel', e => {
  if (WALLPAPER) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  setZoom(camera.zoom * (e.deltaY < 0 ? 1.08 : 0.92), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

window.addEventListener('resize', scheduleDrawConnections);

document.addEventListener('keydown', e => {
  const editing = e.target.matches('input,textarea,select');
  if (e.code === 'Space' && !editing) { spaceDown = true; e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !WALLPAPER) { e.preventDefault(); flushSave(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !editing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !editing) { e.preventDefault(); redo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openOverlay('search-overlay'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openOverlay('command-overlay'); }
  if (e.key === 'Escape') { closeOverlay('search-overlay'); closeOverlay('command-overlay'); closeTransientMenus(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !editing && !WALLPAPER) deleteIds(new Set(selectedIds));
});

document.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

window.addEventListener('beforeunload', () => {
  if (!WALLPAPER && typeof window.dexpad?.saveWorkspaceSync === 'function') {
    window.dexpad.saveWorkspaceSync({ cards, connections });
  }
});

async function init() {
  try {
    const state = await window.dexpad.getState();
    cards = Array.isArray(state?.cards) ? state.cards : [];
    connections = Array.isArray(state?.connections) ? state.connections : [];
    reconcile();
    if (typeof window.dexpad.onStateUpdated === 'function') {
      window.dexpad.onStateUpdated(state => {
        if (!state || !Array.isArray(state.cards)) return;
        cards = state.cards;
        connections = Array.isArray(state.connections) ? state.connections : [];
        reconcile();
      });
    }
  } catch (err) {
    console.error('[DexPad] init failed:', err);
    toast('Unable to load workspace');
  }
  updateHistoryButtons();
}

init();
