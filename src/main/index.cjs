const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const Store = require('electron-store');

// note: win32-wallpaper.cjs throws at module-load time on non-Windows,
// so we only require it when we're actually on win32.
let wallpaperApi = null;
if (process.platform === 'win32') {
  try {
    wallpaperApi = require('./win32-wallpaper.cjs');
  } catch (err) {
    console.error('[DexPad] Failed to load native wallpaper module:', err);
  }
}

// --- Single-instance lock must be acquired BEFORE app.whenReady() ---
// If a second instance starts, forward to the first and exit early.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const store = new Store({
  name: 'dexpad',
  defaults: {
    startup: true,
    wallpaperMode: true,
    cards: []
  }
});

let workspaceWindow = null;
let settingsWindow = null;
let tray = null;
let desktopWindow = null;
let shuttingDown = false;

const workspaceFile = path.join(__dirname, '../renderer/workspace.html');

function getPrimaryWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

function getPanelBounds() {
  const workArea = getPrimaryWorkArea();
  const width = Math.min(720, Math.round(workArea.width * 0.42));
  const height = Math.min(760, Math.round(workArea.height * 0.82));
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  };
}

// Wallpaper is a full-display transparent host. The renderer draws the
// visible DexPad panel inside it so the rest of the user's desktop is never cropped.
function getWallpaperBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function normalizeCard(card, index = 0) {
  if (!card || typeof card !== 'object') return null;
  const type = ['note', 'todo', 'link'].includes(card.type) ? card.type : 'note';
  return {
    id: typeof card.id === 'string' && card.id ? card.id : `card-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: typeof card.title === 'string' ? card.title.slice(0, 200) : '',
    body: typeof card.body === 'string' ? card.body.slice(0, 10000) : '',
    url: typeof card.url === 'string' ? card.url.slice(0, 2000) : '',
    done: Boolean(card.done),
    x: Number.isFinite(card.x) ? Math.max(0, Math.round(card.x)) : 40 + (index % 3) * 300,
    y: Number.isFinite(card.y) ? Math.max(0, Math.round(card.y)) : 40 + Math.floor(index / 3) * 220,
    width: Number.isFinite(card.width) ? Math.max(220, Math.min(520, Math.round(card.width))) : 280,
    height: Number.isFinite(card.height) ? Math.max(140, Math.min(520, Math.round(card.height))) : 180
  };
}

function getCards() {
  const cards = store.get('cards');
  return Array.isArray(cards) ? cards.map(normalizeCard).filter(Boolean) : [];
}

function publishState() {
  if (shuttingDown) return;
  const state = { startup: store.get('startup'), wallpaperMode: store.get('wallpaperMode'), cards: getCards() };
  for (const win of [workspaceWindow, desktopWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('dexpad:state-updated', state);
    }
  }
}

function saveCards(cards) {
  const normalized = Array.isArray(cards)
    ? cards.map(normalizeCard).filter(Boolean)
    : [];
  store.set('cards', normalized);
  publishState();
  return normalized;
}

function setStartup(enabled) {
  store.set('startup', enabled);
  // note: openAtLogin registers DexPad to launch at Windows sign-in
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

function createWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.setBounds(getPanelBounds());
    workspaceWindow.show();
    workspaceWindow.focus();
    return workspaceWindow;
  }

  const bounds = getPanelBounds();
  workspaceWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: true,
    resizable: true,
    // Allow the user to reposition the panel window freely
    movable: true,
    focusable: true,
    skipTaskbar: false,
    backgroundColor: '#0b0d10',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/preload.cjs')
    }
  });
  workspaceWindow.loadFile(workspaceFile, { search: 'mode=control' }).catch((err) => {
    console.error('[DexPad] Failed to load workspace:', err);
  });
  workspaceWindow.once('ready-to-show', () => {
    workspaceWindow.setBounds(getPanelBounds());
    workspaceWindow.show();
    workspaceWindow.focus();
  });
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

// Retry up to MAX_ATTACH_RETRIES times if Progman hasn't initialised yet.
// attachInProgress prevents concurrent retries when both did-finish-load
// and ready-to-show fire near-simultaneously.
const MAX_ATTACH_RETRIES = 5;
const ATTACH_RETRY_MS = 800;
let attachRetries = 0;
let attachInProgress = false;

function showDesktopWallpaper() {
  if (!desktopWindow || desktopWindow.isDestroyed() || !wallpaperApi) return;
  if (attachInProgress) return; // another retry chain is already running
  attachInProgress = true;
  _tryAttach();
}

function _tryAttach() {
  if (!desktopWindow || desktopWindow.isDestroyed()) {
    attachInProgress = false;
    attachRetries = 0;
    return;
  }
  try {
    const bounds = getWallpaperBounds();
    desktopWindow.setBounds(bounds);
    wallpaperApi.attachToDesktop(desktopWindow, bounds);
    wallpaperApi.setClickThrough(desktopWindow, true);
    desktopWindow.setIgnoreMouseEvents(true);
    desktopWindow.showInactive();
    wallpaperApi.sendToBottom(desktopWindow);
    attachRetries = 0;
    attachInProgress = false;
  } catch (err) {
    if (attachRetries < MAX_ATTACH_RETRIES) {
      attachRetries++;
      console.warn(`[DexPad] WorkerW attach failed (attempt ${attachRetries}/${MAX_ATTACH_RETRIES}), retrying in ${ATTACH_RETRY_MS}ms…`);
      setTimeout(_tryAttach, ATTACH_RETRY_MS);
    } else {
      // All retries exhausted — wallpaper mode can't attach to WorkerW in
      // this session. Disable wallpaper mode and open the normal panel window
      // so the user always has a visible UI to work with.
      console.error('[DexPad] WorkerW attachment permanently failed. Falling back to control window.', err);
      attachRetries = 0;
      attachInProgress = false;
      store.set('wallpaperMode', false);
      destroyDesktopWindow();
      rebuildTrayMenu();
      setControlWindowOpen(true);
    }
  }
}

function createDesktopWindow() {
  if (process.platform !== 'win32' || !wallpaperApi) return null;
  const bounds = getWallpaperBounds();
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    desktopWindow.setBounds(bounds);
    showDesktopWallpaper();
    return desktopWindow;
  }

  desktopWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/preload.cjs')
    }
  });
  desktopWindow.setMenu(null);
  desktopWindow.setIgnoreMouseEvents(true);
  desktopWindow.loadFile(workspaceFile, { search: 'mode=wallpaper' }).catch((err) => {
    console.warn('[DexPad] Failed to load wallpaper view:', err);
  });
  // Attach to WorkerW both on did-finish-load and ready-to-show for reliability
  desktopWindow.webContents.on('did-finish-load', showDesktopWallpaper);
  desktopWindow.once('ready-to-show', showDesktopWallpaper);
  desktopWindow.on('closed', () => { desktopWindow = null; });
  return desktopWindow;
}

function destroyDesktopWindow() {
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  if (wallpaperApi) {
    try { wallpaperApi.detachFromDesktop(desktopWindow); } catch (err) { console.warn('[DexPad] detach warning:', err); }
  }
  desktopWindow.destroy();
  desktopWindow = null;
}

function refreshWallpaper() {
  if (!store.get('wallpaperMode') || process.platform !== 'win32') return false;
  if (!desktopWindow || desktopWindow.isDestroyed()) {
    createDesktopWindow();
    return true;
  }
  // Push the current state to the existing wallpaper window
  desktopWindow.webContents.send('dexpad:state-updated', {
    startup: store.get('startup'),
    wallpaperMode: store.get('wallpaperMode'),
    cards: getCards()
  });
  showDesktopWallpaper();
  return true;
}

function setControlWindowOpen(enabled) {
  if (enabled) {
    const win = createWorkspaceWindow();
    win.setBounds(getPanelBounds());
    win.show();
    win.focus();
  } else if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.hide();
  }
}

function setWallpaperMode(enabled) {
  store.set('wallpaperMode', enabled);
  if (enabled) {
    if (!desktopWindow || desktopWindow.isDestroyed()) createDesktopWindow();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.hide();
  } else {
    destroyDesktopWindow();
    setControlWindowOpen(true);
  }
  // publishState() is called here — subscribers see the new wallpaperMode value
  publishState();
  rebuildTrayMenu();
}

function createTray() {
  if (tray) return tray;

  let icon = nativeImage.createEmpty();
  const iconPath = path.join(__dirname, '../renderer/icon.ico');
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch (err) {
    console.warn('[DexPad] Tray icon unavailable, using empty icon:', err.message);
  }

  tray = new Tray(icon);
  tray.setToolTip('DexPad');
  tray.on('click', () => setControlWindowOpen(true));
  rebuildTrayMenu();
  return tray;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const wallpaper = store.get('wallpaperMode');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DexPad', click: () => setControlWindowOpen(true) },
    { label: 'Refresh Wallpaper', click: refreshWallpaper },
    { type: 'separator' },
    { label: 'Desktop Wallpaper', type: 'checkbox', checked: wallpaper, click: () => setWallpaperMode(!wallpaper) },
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quit DexPad', click: quitApp }
  ]));
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    title: 'DexPad Settings',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

function quitApp() {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  destroyDesktopWindow();
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.destroy();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  app.quit();
}

// --- IPC handlers ---

ipcMain.handle('dexpad:get-state', () => ({
  startup: store.get('startup'),
  wallpaperMode: store.get('wallpaperMode'),
  cards: getCards()
}));

ipcMain.handle('dexpad:save-cards', (_event, cards) => saveCards(cards));

ipcMain.handle('dexpad:set-state', (_event, state) => {
  if (typeof state?.startup === 'boolean') setStartup(state.startup);
  if (typeof state?.wallpaperMode === 'boolean') setWallpaperMode(state.wallpaperMode);
  return {
    startup: store.get('startup'),
    wallpaperMode: store.get('wallpaperMode'),
    cards: getCards()
  };
});

ipcMain.handle('dexpad:open-workspace', () => {
  setControlWindowOpen(true);
  return true;
});

ipcMain.handle('dexpad:refresh-wallpaper', () => refreshWallpaper());

ipcMain.handle('dexpad:open-url', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Only http(s) URLs are allowed.');
  }
  return shell.openExternal(url);
});

// --- App lifecycle ---

app.whenReady().then(() => {
  setStartup(store.get('startup'));
  // note: Ctrl+Alt+D (or Cmd+Alt+D on Mac) opens the workspace panel
  globalShortcut.register('CommandOrControl+Alt+D', () => setControlWindowOpen(true));
  createTray();

  if (store.get('wallpaperMode')) createDesktopWindow();
  else createWorkspaceWindow();

  // Re-position windows whenever display configuration changes
  const refresh = () => {
    if (shuttingDown) return;
    if (store.get('wallpaperMode')) refreshWallpaper();
    else if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.setBounds(getPanelBounds());
  };
  screen.on('display-metrics-changed', refresh);
  screen.on('display-added', refresh);
  screen.on('display-removed', refresh);
});

// Bring existing window to front when a second instance tries to launch
app.on('second-instance', () => setControlWindowOpen(true));

// Prevent Electron from quitting when the last window is closed — we live in the tray
app.on('window-all-closed', (event) => event.preventDefault());

app.on('before-quit', () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
});
