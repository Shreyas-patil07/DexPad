const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, Menu, Tray } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Store = require('electron-store');
const {
  attachToDesktop,
  detachFromDesktop,
  setClickThrough,
  sendToBottom
} = require('./win32-wallpaper.cjs');

const store = new Store({
  name: 'dexpad',
  defaults: {
    ideonUrl: process.env.IDEON_URL || 'http://localhost:3000',
    startup: true,
    wallpaperMode: true,
    interactive: false
  }
});

let workspaceWindow = null;
let settingsWindow = null;
let tray = null;
let ideonServer = null;
let desktopWindow = null;
let shuttingDown = false;

const isDev = !app.isPackaged;

function getIdeonUrl() {
  return store.get('ideonUrl');
}

function createWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.show();
    workspaceWindow.focus();
    return workspaceWindow;
  }

  workspaceWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  });

  workspaceWindow.loadURL(getIdeonUrl());
  workspaceWindow.once('ready-to-show', () => workspaceWindow.show());
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 520,
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

function createTray() {
  if (tray) return;

  tray = new Tray(path.join(__dirname, '../renderer/dexpad-tray.png'));
  tray.setToolTip('DexPad');
  tray.on('double-click', () => createWorkspaceWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const wallpaper = store.get('wallpaperMode');
  const interactive = store.get('interactive');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DexPad', click: () => createWorkspaceWindow() },
    { type: 'separator' },
    {
      label: 'Desktop Wallpaper',
      type: 'checkbox',
      checked: wallpaper,
      click: () => setWallpaperMode(!wallpaper)
    },
    {
      label: 'Interactive Mode',
      type: 'checkbox',
      checked: interactive,
      click: () => setInteractiveMode(!interactive)
    },
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit DexPad', click: () => quitApp() }
  ]));
}

function getDesktopBounds() {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map(d => d.bounds.x));
  const top = Math.min(...displays.map(d => d.bounds.y));
  const right = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function createDesktopWindow() {
  if (process.platform !== 'win32') return;

  const bounds = getDesktopBounds();

  if (desktopWindow && !desktopWindow.isDestroyed()) {
    desktopWindow.setBounds(bounds);
    sendToBottom(desktopWindow);
    return desktopWindow;
  }

  desktopWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  });

  desktopWindow.setMenu(null);
  desktopWindow.loadURL(getIdeonUrl());
  desktopWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[DexPad] Ideon load failed: ${code} ${description}`);
  });

  desktopWindow.once('ready-to-show', () => {
    try {
      attachToDesktop(desktopWindow, bounds);
      setClickThrough(desktopWindow, !store.get('interactive'));
      desktopWindow.showInactive();
    } catch (error) {
      console.error('[DexPad] Failed to attach to WorkerW:', error);
    }
  });

  desktopWindow.on('closed', () => { desktopWindow = null; });
  return desktopWindow;
}

function destroyDesktopWindow() {
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  try { detachFromDesktop(desktopWindow); } catch (error) { console.warn(error); }
  desktopWindow.destroy();
  desktopWindow = null;
}

function setWallpaperMode(enabled) {
  store.set('wallpaperMode', enabled);
  if (enabled) createDesktopWindow();
  else destroyDesktopWindow();
  rebuildTrayMenu();
}

function setInteractiveMode(enabled) {
  store.set('interactive', enabled);
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    setClickThrough(desktopWindow, !enabled);
    if (!enabled) sendToBottom(desktopWindow);
  }
  rebuildTrayMenu();
}

function setStartup(enabled) {
  store.set('startup', enabled);
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

function startIdeonServer() {
  const serverDir = process.env.IDEON_ROOT;
  if (!serverDir) return;

  const serverFile = path.join(serverDir, 'dist', 'server.cjs');
  const fs = require('node:fs');
  if (!fs.existsSync(serverFile)) {
    console.warn(`[DexPad] Ideon server not built: ${serverFile}`);
    return;
  }

  ideonServer = spawn(process.execPath, [serverFile], {
    cwd: serverDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=8192' },
    stdio: 'inherit',
    windowsHide: true
  });

  ideonServer.on('exit', (code) => {
    ideonServer = null;
    if (!shuttingDown && code) console.error(`[DexPad] Ideon server exited with code ${code}`);
  });
}

function quitApp() {
  shuttingDown = true;
  destroyDesktopWindow();
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.destroy();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  if (ideonServer) ideonServer.kill();
  app.quit();
}

ipcMain.handle('dexpad:get-state', () => ({
  ideonUrl: getIdeonUrl(),
  startup: store.get('startup'),
  wallpaperMode: store.get('wallpaperMode'),
  interactive: store.get('interactive')
}));

ipcMain.handle('dexpad:set-state', (_event, state) => {
  if (typeof state.ideonUrl === 'string' && state.ideonUrl.trim()) store.set('ideonUrl', state.ideonUrl.trim());
  if (typeof state.startup === 'boolean') setStartup(state.startup);
  if (typeof state.wallpaperMode === 'boolean') setWallpaperMode(state.wallpaperMode);
  if (typeof state.interactive === 'boolean') setInteractiveMode(state.interactive);
  return {
    ideonUrl: getIdeonUrl(),
    startup: store.get('startup'),
    wallpaperMode: store.get('wallpaperMode'),
    interactive: store.get('interactive')
  };
});

ipcMain.handle('dexpad:open-workspace', () => {
  createWorkspaceWindow();
  return true;
});

ipcMain.handle('dexpad:open-url', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return quitApp();

  setStartup(store.get('startup'));
  globalShortcut.register('CommandOrControl+Alt+D', () => {
    setInteractiveMode(!store.get('interactive'));
  });

  createTray();
  startIdeonServer();

  if (process.argv.includes('--hidden') || store.get('wallpaperMode')) {
    if (store.get('wallpaperMode')) createDesktopWindow();
  } else {
    createWorkspaceWindow();
  }

  screen.on('display-metrics-changed', () => {
    if (store.get('wallpaperMode')) createDesktopWindow();
  });
  screen.on('display-added', () => {
    if (store.get('wallpaperMode')) createDesktopWindow();
  });
  screen.on('display-removed', () => {
    if (store.get('wallpaperMode')) createDesktopWindow();
  });
});

app.on('second-instance', () => createWorkspaceWindow());
app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  if (ideonServer) ideonServer.kill();
});
