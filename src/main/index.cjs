const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Store = require('electron-store');
const { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom, activateWindow } = require('./win32-wallpaper.cjs');

const store = new Store({
  name: 'dexpad',
  defaults: {
    ideonUrl: process.env.IDEON_URL || 'http://localhost:3000',
    startup: true,
    wallpaperMode: true,
    interactive: true,
    interactionConfigVersion: 2,
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

function getNodeExecutable() {
  if (process.env.NODE_EXECUTABLE && fs.existsSync(process.env.NODE_EXECUTABLE)) return process.env.NODE_EXECUTABLE;
  if (process.env.NODE && fs.existsSync(process.env.NODE)) return process.env.NODE;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : null
    ].filter(Boolean);
    const systemNode = candidates.find((candidate) => fs.existsSync(candidate));
    if (systemNode) return systemNode;
  }
  return 'node';
}

function migrateInteractionConfig() {
  const version = Number(store.get('interactionConfigVersion') || 0);
  if (version < 2) {
    // Older builds persisted interactive=false while experimenting with the
    // WorkerW wallpaper surface. Start the upgraded build in an actually
    // interactive state; the user can still toggle it off from the tray or
    // Ctrl+Alt+D for click-through wallpaper mode.
    store.set('interactive', true);
    store.set('interactionConfigVersion', 2);
  }
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
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = Math.min(960, Math.round(workArea.width * 0.52));
  const height = Math.min(820, Math.round(workArea.height * 0.84));
  const margin = Math.max(24, Math.round(workArea.width * 0.02));
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  };
}

function applyWindowInputMode() {
  if (!desktopWindow || desktopWindow.isDestroyed()) return;
  const interactive = store.get('interactive');

  if (interactive) {
    try {
      detachFromDesktop(desktopWindow);
    } catch (error) {
      console.warn('[DexPad] Failed to detach interactive window:', error);
    }

    desktopWindow.setIgnoreMouseEvents(false);
    desktopWindow.setFocusable(true);
    desktopWindow.setAlwaysOnTop(true, 'floating');
    setClickThrough(desktopWindow, false);
    desktopWindow.show();
    desktopWindow.focus();
    activateWindow(desktopWindow);
    return;
  }

  desktopWindow.setAlwaysOnTop(false);
  setClickThrough(desktopWindow, true);
  desktopWindow.setIgnoreMouseEvents(true);
  try {
    attachToDesktop(desktopWindow, getDesktopBounds());
  } catch (error) {
    console.error('[DexPad] WorkerW attachment failed:', error);
    return;
  }
  desktopWindow.showInactive();
  sendToBottom(desktopWindow);
}

function createDesktopWindow() {
  if (process.platform !== 'win32') return null;
  const bounds = getDesktopBounds();
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    desktopWindow.setBounds(bounds);
    applyWindowInputMode();
    return desktopWindow;
  }

  desktopWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, resizable: false, movable: false, focusable: true,
    skipTaskbar: true, show: false, backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  desktopWindow.setMenu(null);
  desktopWindow.loadURL(store.get('ideonUrl'));
  desktopWindow.once('ready-to-show', () => {
    try {
      applyWindowInputMode();
    } catch (error) {
      console.error('[DexPad] Failed to configure desktop window:', error);
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
    desktopWindow.setBounds(getDesktopBounds());
    applyWindowInputMode();
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
  const nodeCommand = getNodeExecutable();
  const childEnv = {
    ...process.env,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || 'true',
    AUTH_SECRET: process.env.AUTH_SECRET || getAuthSecret(),
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192'
  };
  console.log(`[DexPad] Starting Ideon with Node: ${nodeCommand}`);
  ideonServer = spawn(nodeCommand, [serverFile], { cwd: serverDir, env: childEnv, stdio: 'inherit', windowsHide: true });
  ideonServer.on('spawn', () => console.log('[DexPad] Ideon server process started.'));
  ideonServer.on('exit', (code, signal) => {
    ideonServer = null;
    if (!shuttingDown && (code || signal)) console.error(`[DexPad] Ideon server exited with code ${code} signal ${signal || 'none'}`);
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
  return {
    ideonUrl: store.get('ideonUrl'), startup: store.get('startup'),
    wallpaperMode: store.get('wallpaperMode'), interactive: store.get('interactive')
  };
});

ipcMain.handle('dexpad:open-workspace', () => { createWorkspaceWindow(); return true; });
ipcMain.handle('dexpad:open-url', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed.');
  return shell.openExternal(url);
});

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) return quitApp();
  migrateInteractionConfig();
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
