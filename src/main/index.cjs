const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const Store = require('electron-store');
const { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom } = require('./win32-wallpaper.cjs');

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
  const state = { startup: store.get('startup'), wallpaperMode: store.get('wallpaperMode'), cards: getCards() };
  for (const window of [workspaceWindow, desktopWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('dexpad:state-updated', state);
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
    movable: false,
    focusable: true,
    skipTaskbar: false,
    backgroundColor: '#0b0d10',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/preload.cjs')
    }
  });
  workspaceWindow.loadFile(workspaceFile, { search: 'mode=control' }).catch((error) => {
    console.error('[DexPad] Failed to load local workspace:', error);
  });
  workspaceWindow.once('ready-to-show', () => {
    workspaceWindow.setBounds(getPanelBounds());
    workspaceWindow.show();
    workspaceWindow.focus();
  });
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

function showDesktopWallpaper() {
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  try {
    const bounds = getWallpaperBounds();
    desktopWindow.setBounds(bounds);
    attachToDesktop(desktopWindow, bounds);
    setClickThrough(desktopWindow, true);
    desktopWindow.setIgnoreMouseEvents(true);
    desktopWindow.showInactive();
    sendToBottom(desktopWindow);
  } catch (error) {
    console.error('[DexPad] WorkerW attachment failed:', error);
  }
}

function createDesktopWindow() {
  if (process.platform !== 'win32') return null;
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
  desktopWindow.loadFile(workspaceFile, { search: 'mode=wallpaper' }).catch((error) => {
    console.warn('[DexPad] Failed to load local wallpaper:', error);
  });
  desktopWindow.webContents.on('did-finish-load', showDesktopWallpaper);
  desktopWindow.once('ready-to-show', showDesktopWallpaper);
  desktopWindow.on('closed', () => { desktopWindow = null; });
  return desktopWindow;
}

function destroyDesktopWindow() {
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  try { detachFromDesktop(desktopWindow); } catch (error) { console.warn(error); }
  desktopWindow.destroy();
  desktopWindow = null;
}

function refreshWallpaper() {
  if (!store.get('wallpaperMode') || process.platform !== 'win32') return false;
  if (!desktopWindow || desktopWindow.isDestroyed()) {
    createDesktopWindow();
    return true;
  }
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
    const window = createWorkspaceWindow();
    window.setBounds(getPanelBounds());
    window.show();
    window.focus();
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
  publishState();
  rebuildTrayMenu();
}

function createTray() {
  if (tray) return tray;

  let icon = nativeImage.createEmpty();
  const iconPath = path.join(__dirname, '../renderer/icon.ico');
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch (error) {
    console.warn('[DexPad] Tray icon unavailable, using default icon:', error.message);
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
  destroyDesktopWindow();
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.destroy();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  app.quit();
}

ipcMain.handle('dexpad:get-state', () => ({
  startup: store.get('startup'),
  wallpaperMode: store.get('wallpaperMode'),
  cards: getCards()
}));

ipcMain.handle('dexpad:save-cards', (_event, cards) => saveCards(cards));

ipcMain.handle('dexpad:set-state', (_event, state) => {
  if (typeof state?.startup === 'boolean') setStartup(state.startup);
  if (typeof state?.wallpaperMode === 'boolean') setWallpaperMode(state.wallpaperMode);
  publishState();
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

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return quitApp();
  setStartup(store.get('startup'));
  globalShortcut.register('CommandOrControl+Alt+D', () => setControlWindowOpen(true));
  createTray();

  if (store.get('wallpaperMode')) createDesktopWindow();
  else createWorkspaceWindow();

  const refresh = () => {
    if (store.get('wallpaperMode')) refreshWallpaper();
    else if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.setBounds(getPanelBounds());
  };
  screen.on('display-metrics-changed', refresh);
  screen.on('display-added', refresh);
  screen.on('display-removed', refresh);
});

app.on('second-instance', () => setControlWindowOpen(true));
app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
});
