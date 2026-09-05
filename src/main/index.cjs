const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Store = require('electron-store');
const { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom } = require('./win32-wallpaper.cjs');

const store = new Store({
  name: 'dexpad',
  defaults: {
    ideonUrl: process.env.IDEON_URL || 'http://localhost:3000',
    startup: true,
    wallpaperMode: true,
    interactive: false,
    authSecret: null
  }
});

let workspaceWindow = null;
let settingsWindow = null;
let tray = null;
let ideonServer = null;
let desktopWindow = null;
let shuttingDown = false;

function getIdeonRoot() {
  const candidates = [
    process.env.IDEON_ROOT,
    path.resolve(__dirname, '../../vendor/ideon'),
    path.join(process.resourcesPath, 'ideon')
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'dist', 'server.cjs')));
}

function getAuthSecret() {
  const existing = store.get('authSecret');
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const secret = crypto.randomBytes(32).toString('base64url');
  store.set('authSecret', secret);
  return secret;
}

function createWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.show();
    workspaceWindow.focus();
    return workspaceWindow;
  }
  workspaceWindow = new BrowserWindow({
    width: 1400, height: 900, show: false, backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  workspaceWindow.loadURL(store.get('ideonUrl'));
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
    width: 520, height: 520, resizable: false, title: 'DexPad Settings',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.cjs'), contextIsolation: true, sandbox: true }
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('DexPad');
  tray.on('double-click', createWorkspaceWindow);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const wallpaper = store.get('wallpaperMode');
  const interactive = store.get('interactive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DexPad', click: createWorkspaceWindow },
    { type: 'separator' },
    { label: 'Desktop Wallpaper', type: 'checkbox', checked: wallpaper, click: () => setWallpaperMode(!wallpaper) },
    { label: 'Interactive Mode', type: 'checkbox', checked: interactive, click: () => setInteractiveMode(!interactive) },
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quit DexPad', click: quitApp }
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
  if (process.platform !== 'win32') return null;
  const bounds = getDesktopBounds();
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    desktopWindow.setBounds(bounds);
    sendToBottom(desktopWindow);
    return desktopWindow;
  }
  desktopWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, show: false, backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  desktopWindow.setMenu(null);
  desktopWindow.loadURL(store.get('ideonUrl'));
  desktopWindow.once('ready-to-show', () => {
    try {
      attachToDesktop(desktopWindow, bounds);
      setClickThrough(desktopWindow, !store.get('interactive'));
      desktopWindow.showInactive();
    } catch (error) {
      console.error('[DexPad] WorkerW attachment failed:', error);
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
  if (enabled) createDesktopWindow(); else destroyDesktopWindow();
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
  if (process.env.IDEON_URL) return;
  const serverDir = getIdeonRoot();
  if (!serverDir) {
    console.warn('[DexPad] No built Ideon server found. Run npm run bootstrap:ideon or set IDEON_URL.');
    return;
  }
  const serverFile = path.join(serverDir, 'dist', 'server.cjs');
  const nodeCommand = process.env.NODE_EXECUTABLE || process.execPath;
  const childEnv = {
    ...process.env,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || 'true',
    AUTH_SECRET: process.env.AUTH_SECRET || getAuthSecret(),
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192'
  };

  // In Electron, process.execPath is electron.exe rather than node.exe.
  // Explicitly put spawned Electron children into Node mode so the Ideon CJS
  // server is executed by Electron's embedded Node runtime instead of being
  // interpreted as another Electron application.
  if (!process.env.NODE_EXECUTABLE) {
    childEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  ideonServer = spawn(nodeCommand, [serverFile], {
    cwd: serverDir,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true
  });
  ideonServer.on('exit', (code, signal) => {
    ideonServer = null;
    if (!shuttingDown && (code || signal)) {
      console.error(`[DexPad] Ideon server exited with code ${code} signal ${signal || 'none'}`);
    }
  });
  ideonServer.on('error', (error) => {
    ideonServer = null;
    if (!shuttingDown) console.error('[DexPad] Failed to start Ideon server:', error);
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
  ideonUrl: store.get('ideonUrl'), startup: store.get('startup'),
  wallpaperMode: store.get('wallpaperMode'), interactive: store.get('interactive')
}));

ipcMain.handle('dexpad:set-state', (_event, state) => {
  if (typeof state?.ideonUrl === 'string' && state.ideonUrl.trim()) store.set('ideonUrl', state.ideonUrl.trim());
  if (typeof state?.startup === 'boolean') setStartup(state.startup);
  if (typeof state?.wallpaperMode === 'boolean') setWallpaperMode(state.wallpaperMode);
  if (typeof state?.interactive === 'boolean') setInteractiveMode(state.interactive);
  return { ideonUrl: store.get('ideonUrl'), startup: store.get('startup'), wallpaperMode: store.get('wallpaperMode'), interactive: store.get('interactive') };
});

ipcMain.handle('dexpad:open-workspace', () => { createWorkspaceWindow(); return true; });
ipcMain.handle('dexpad:open-url', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed.');
  return shell.openExternal(url);
});

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return quitApp();
  setStartup(store.get('startup'));
  globalShortcut.register('CommandOrControl+Alt+D', () => setInteractiveMode(!store.get('interactive')));
  createTray();
  startIdeonServer();
  if (store.get('wallpaperMode')) createDesktopWindow();
  else if (!process.argv.includes('--hidden')) createWorkspaceWindow();
  const refresh = () => { if (store.get('wallpaperMode')) createDesktopWindow(); };
  screen.on('display-metrics-changed', refresh);
  screen.on('display-added', refresh);
  screen.on('display-removed', refresh);
});

app.on('second-instance', createWorkspaceWindow);
app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  if (ideonServer) ideonServer.kill();
});
