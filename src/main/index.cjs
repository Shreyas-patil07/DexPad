'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const Store = require('electron-store');
const { CURRENT_SCHEMA_VERSION, isValidUrl, normalizeCard, normalizeCardGraph, normalizeConnections, migrateState } = require('./card-schema.cjs');
const { MAX_PROFILES, MAX_PROFILE_NAME, makeProfileId, cleanProfileName, uniqueProfileName, normalizeProfileList } = require('./profile-schema.cjs');

let wallpaperApi = null;
if (process.platform === 'win32') {
  try { wallpaperApi = require('./win32-wallpaper.cjs'); }
  catch (err) { console.error('[DexPad] Failed to load native wallpaper module:', err); }
}
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const store = new Store({ name:'dexpad', defaults:{ schemaVersion:CURRENT_SCHEMA_VERSION, startup:false, wallpaperMode:true, profiles:[], activeProfileId:null } });
const legacyState = migrateState(store.store);

let profiles = normalizeProfileList(store.get('profiles'), normalizeCardGraph, normalizeConnections, legacyState);
let activeProfileId = typeof store.get('activeProfileId') === 'string' && profiles.some(p=>p.id===store.get('activeProfileId')) ? store.get('activeProfileId') : profiles[0].id;
store.set('profiles', profiles);
store.set('activeProfileId', activeProfileId);
store.set('schemaVersion', CURRENT_SCHEMA_VERSION);

let wallpaperApiReady = true;
let workspaceWin = null, desktopWin = null, settingsWin = null, tray = null, quitting = false;
const RENDERER = path.join(__dirname, '../renderer');
const WORKSPACE_HTML = path.join(RENDERER, 'workspace.html');
const PRELOAD = path.join(RENDERER, '../preload/preload.cjs');

function getActiveProfile() { return profiles.find(p=>p.id===activeProfileId) || profiles[0]; }
function getControlDisplay() {
  try { const pt = screen.getCursorScreenPoint(); return screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay(); }
  catch (_) { return screen.getPrimaryDisplay(); }
}
function getWallpaperDisplay() { return screen.getPrimaryDisplay(); }
function controlBounds(d = null) {
  const display = d || getControlDisplay(), wa = display.workArea;
  const w = Math.min(740, Math.round(wa.width * .42)), h = Math.min(780, Math.round(wa.height * .88));
  return { x:wa.x + wa.width - w, y:wa.y + Math.round((wa.height - h)/2), width:w, height:h };
}
function wallpaperPanelBounds(d = null) {
  const display = d || getWallpaperDisplay();
  const w = Math.min(740, Math.round(display.bounds.width * .42)), h = Math.min(780, Math.round(display.bounds.height * .88));
  return { x:display.bounds.x + display.bounds.width - w, y:display.bounds.y + Math.round((display.bounds.height - h)/2), width:w, height:h };
}
function wallpaperNativePosition(_display, dipBounds) {
  const p = screen.dipToScreenPoint({x:dipBounds.x, y:dipBounds.y});
  return {x:Math.round(p.x), y:Math.round(p.y), width:dipBounds.width, height:dipBounds.height};
}
function getCards() { const p=getActiveProfile(); return normalizeCardGraph(p?.cards || []); }
function getConnections() { const p=getActiveProfile(); return normalizeConnections(p?.connections, getCards()); }
function profileSummary() { return profiles.map(p=>({id:p.id,name:p.name})); }
function currentState() { return {schemaVersion:CURRENT_SCHEMA_VERSION,startup:Boolean(store.get('startup')),wallpaperMode:typeof store.get('wallpaperMode')==='boolean'?store.get('wallpaperMode'):true,profiles:profileSummary(),activeProfileId,cards:getCards(),connections:getConnections()}; }
function persistProfiles() { store.set('profiles', profiles); store.set('activeProfileId', activeProfileId); }
function publishState(excludeSender = null) {
  if (quitting) return;
  const state = currentState();
  for (const win of [workspaceWin,desktopWin]) {
    if (!win || win.isDestroyed() || (excludeSender && win.webContents === excludeSender)) continue;
    try { win.webContents.send('dexpad:state-updated', state); } catch (err) { console.warn('[DexPad] Failed to publish state:', err.message); }
  }
}

let saveQueue = Promise.resolve();
// note: captures targetProfileId at request time to prevent cross-profile save race conditions
function saveWorkspace(rawCards, rawConnections, excludeSender = null, targetProfileId = null) {
  let cardsInput = rawCards;
  let connectionsInput = rawConnections;
  let boundProfileId = targetProfileId;

  if (rawCards && typeof rawCards === 'object' && !Array.isArray(rawCards) && Array.isArray(rawCards.cards)) {
    cardsInput = rawCards.cards;
    connectionsInput = rawCards.connections;
    boundProfileId = rawCards.profileId || boundProfileId;
  }

  const profileIdToSave = boundProfileId || activeProfileId;

  const operation = saveQueue.then(() => {
    const normalizedCards = normalizeCardGraph(Array.isArray(cardsInput) ? cardsInput.map((c,i)=>normalizeCard(c,i)).filter(Boolean) : []);
    const normalizedConnections = normalizeConnections(connectionsInput, normalizedCards);
    const p = profiles.find(x => x.id === profileIdToSave);
    if (!p) {
      console.warn('[DexPad] Save ignored: target profile not found:', profileIdToSave);
      return { cards: normalizedCards, connections: normalizedConnections };
    }
    p.cards = normalizedCards;
    p.connections = normalizedConnections;
    persistProfiles();
    publishState(excludeSender);
    return { cards: normalizedCards, connections: normalizedConnections };
  });
  saveQueue = operation.catch(err => console.error('[DexPad] saveWorkspace error:', err));
  return operation;
}

// note: joins saveQueue so any in-flight async save (from the debounced
// scheduleSave path) lands BEFORE this write, not after. The sync payload
// holds the renderer's most-current state so it must be the tail of the queue.
// The caller (ipcMain.on sendSync handler) sets event.returnValue inside the
// .then(), which blocks the renderer's sendSync until the queue drains.
// This is intentional — a brief hold on close beats silent data clobber.
function saveWorkspaceSync(payload) {
  const profileIdToSave = payload?.profileId || activeProfileId;
  // capture profileId at call time (same pattern as saveWorkspace) so a
  // concurrent profile switch can't redirect this write mid-queue.
  const operation = saveQueue.then(() => {
    const p = profiles.find(x => x.id === profileIdToSave);
    if (!p) return;
    const normalizedCards = normalizeCardGraph(Array.isArray(payload?.cards) ? payload.cards.map((c,i)=>normalizeCard(c,i)).filter(Boolean) : []);
    const normalizedConnections = normalizeConnections(payload?.connections, normalizedCards);
    p.cards = normalizedCards;
    p.connections = normalizedConnections;
    persistProfiles();
  });
  saveQueue = operation.catch(err => console.error('[DexPad] saveWorkspaceSync error:', err));
  return operation;
}

function applyStartup(enabled){ store.set('startup',enabled); app.setLoginItemSettings({openAtLogin:enabled,args:['--hidden']}); }

function switchProfile(id) {
  if (!profiles.some(p=>p.id===id)) throw new Error('Profile not found.');
  // note: drain saveQueue so pending saves land in the outgoing profile before activeProfileId changes
  const op = saveQueue.then(() => {
    activeProfileId = id;
    persistProfiles();
    publishState();
    return currentState();
  });
  saveQueue = op.catch(err => console.error('[DexPad] switchProfile error:', err));
  return op;
}

function createProfile(name) {
  if (profiles.length >= MAX_PROFILES) {
    throw new Error(`Maximum profile limit (${MAX_PROFILES}) reached.`);
  }
  const clean = uniqueProfileName(name, profiles.map(p => p.name), profiles.length + 1);
  const newId = makeProfileId(new Set(profiles.map(p => p.id)));
  const p = { id: newId, name: clean, cards: [], connections: [] };

  const op = saveQueue.then(() => {
    profiles.push(p);
    activeProfileId = p.id;
    persistProfiles();
    publishState();
    return currentState();
  });
  saveQueue = op.catch(err => console.error('[DexPad] createProfile error:', err));
  return op;
}

function renameProfile(id, name) {
  const p = profiles.find(profile => profile.id === id);
  if (!p) throw new Error('Profile not found.');
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new Error('Profile name cannot be empty.');
  const clean = uniqueProfileName(trimmed, profiles.filter(x => x.id !== id).map(x => x.name));
  p.name = clean;
  persistProfiles();
  publishState();
  return currentState();
}
function showControlWindow(){
  if(workspaceWin&&!workspaceWin.isDestroyed()){if(!workspaceWin.isVisible())workspaceWin.show();workspaceWin.focus();return workspaceWin;}
  return createControlWindow();
}
function createControlWindow(){
  workspaceWin=new BrowserWindow({...controlBounds(),show:false,frame:true,resizable:true,movable:true,minimizable:true,maximizable:false,focusable:true,skipTaskbar:false,title:'DexPad',backgroundColor:'#090b0e',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});
  workspaceWin.setMenuBarVisibility(false); workspaceWin.loadFile(WORKSPACE_HTML,{search:'mode=control'}).catch(e=>console.error('[DexPad] Failed to load workspace:',e.message));
  workspaceWin.once('ready-to-show',()=>{workspaceWin.show();workspaceWin.focus();}); workspaceWin.on('closed',()=>{workspaceWin=null;}); return workspaceWin;
}

const ATTACH_MAX=6, ATTACH_DELAY=1000; let attachTries=0, attachBusy=false, attachTimer=null, explorerWatchTimer=null, isWallpaperAttached=false;
function attachWallpaper(){if(!desktopWin||desktopWin.isDestroyed()||!wallpaperApi||attachBusy)return;if(attachTimer){clearTimeout(attachTimer);attachTimer=null;}attachBusy=true;doAttach();}
function doAttach(){
  if(!desktopWin||desktopWin.isDestroyed()){attachBusy=false;attachTries=0;return;}
  try{
    const display=getWallpaperDisplay(),bounds=wallpaperPanelBounds(display),nativeBounds=wallpaperNativePosition(display,bounds);
    desktopWin.setBounds(bounds); wallpaperApi.attachToDesktop(desktopWin,nativeBounds); wallpaperApi.setClickThrough(desktopWin,true); desktopWin.setIgnoreMouseEvents(true); desktopWin.showInactive(); wallpaperApi.sendToBottom(desktopWin);
    attachTries=0;attachBusy=false;attachTimer=null;isWallpaperAttached=true;console.log('[DexPad] Wallpaper panel attached to desktop.');
  }catch(err){
    if(attachTries<ATTACH_MAX){attachTries++;console.warn(`[DexPad] Wallpaper attach attempt ${attachTries}/${ATTACH_MAX} failed: ${err.message}`);attachTimer=setTimeout(doAttach,ATTACH_DELAY);return;}
    console.error('[DexPad] Wallpaper attach gave up. Falling back to control panel.',err.message);attachTries=0;attachBusy=false;attachTimer=null;isWallpaperAttached=false;store.set('wallpaperMode',false);destroyDesktopWindow();rebuildTray();publishState();showControlWindow();
  }
}
function createDesktopWindow(){
  if(process.platform!=='win32'||!wallpaperApi){store.set('wallpaperMode',false);showControlWindow();return null;}
  if(desktopWin&&!desktopWin.isDestroyed()){attachWallpaper();return desktopWin;}
  desktopWin=new BrowserWindow({...wallpaperPanelBounds(),show:false,frame:false,transparent:true,resizable:false,movable:false,focusable:false,skipTaskbar:true,hasShadow:false,backgroundColor:'#00000000',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});
  desktopWin.setMenu(null);desktopWin.setIgnoreMouseEvents(true);desktopWin.loadFile(WORKSPACE_HTML,{search:'mode=wallpaper'}).catch(e=>console.warn('[DexPad] Failed to load wallpaper view:',e.message));
  desktopWin.webContents.once('did-finish-load',()=>{attachTimer=setTimeout(attachWallpaper,150);});desktopWin.on('closed',()=>{desktopWin=null;});return desktopWin;
}
function destroyDesktopWindow(){if(attachTimer){clearTimeout(attachTimer);attachTimer=null;}attachBusy=false;attachTries=0;isWallpaperAttached=false;if(!desktopWin||desktopWin.isDestroyed())return;if(wallpaperApi){try{wallpaperApi.detachFromDesktop(desktopWin);}catch(_){}}desktopWin.destroy();desktopWin=null;}
function refreshWallpaper(){if(!store.get('wallpaperMode')||process.platform!=='win32')return false;if(!desktopWin||desktopWin.isDestroyed()){createDesktopWindow();return true;}publishState();attachWallpaper();return true;}
function startExplorerWatch(){if(explorerWatchTimer)clearInterval(explorerWatchTimer);explorerWatchTimer=setInterval(()=>{if(quitting||!store.get('wallpaperMode'))return;if(isWallpaperAttached&&!attachBusy&&desktopWin&&!desktopWin.isDestroyed()&&wallpaperApi&&!wallpaperApi.isWindowAttached(desktopWin)){console.warn('[DexPad] Desktop attachment lost. Re-attaching…');isWallpaperAttached=false;attachWallpaper();}},4000);}
function setWallpaperMode(enabled){store.set('wallpaperMode',enabled);if(enabled){if(!desktopWin||desktopWin.isDestroyed())createDesktopWindow();if(workspaceWin&&!workspaceWin.isDestroyed())workspaceWin.hide();}else{destroyDesktopWindow();showControlWindow();}publishState();rebuildTray();}
function buildTrayIcon(){for(const p of[path.join(__dirname,'../../assets/icon.png'),path.join(__dirname,'../assets/icon.png'),path.join(__dirname,'../../assets/icon.ico')]){try{const img=nativeImage.createFromPath(p);if(!img.isEmpty())return img;}catch(_){}}return nativeImage.createEmpty();}
function createTray(){if(tray)return;tray=new Tray(buildTrayIcon());tray.setToolTip('DexPad — right-click for options');tray.on('click',()=>showControlWindow());rebuildTray();}
function rebuildTray(){if(!tray)return;const wallpaper=Boolean(store.get('wallpaperMode'));tray.setContextMenu(Menu.buildFromTemplate([{label:'Open DexPad',click:()=>showControlWindow()},{label:'Refresh Wallpaper',click:()=>refreshWallpaper()},{type:'separator'},{label:'Desktop Wallpaper',type:'checkbox',checked:wallpaper,click:()=>setWallpaperMode(!wallpaper)},{label:'Settings',click:()=>showSettingsWindow()},{type:'separator'},{label:'Quit DexPad',click:()=>quitApp()}]));}
function showSettingsWindow(){if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.show();settingsWin.focus();return;}settingsWin=new BrowserWindow({width:520,height:440,resizable:false,minimizable:false,title:'DexPad Settings',backgroundColor:'#090b0e',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});settingsWin.setMenuBarVisibility(false);settingsWin.loadFile(path.join(RENDERER,'settings.html'));settingsWin.on('closed',()=>{settingsWin=null;});}
function quitApp(){quitting=true;if(explorerWatchTimer){clearInterval(explorerWatchTimer);explorerWatchTimer=null;}if(attachTimer){clearTimeout(attachTimer);attachTimer=null;}globalShortcut.unregisterAll();destroyDesktopWindow();workspaceWin?.destroy();settingsWin?.destroy();tray?.destroy();app.quit();}

ipcMain.handle('dexpad:get-state',()=>currentState());
ipcMain.handle('dexpad:save-workspace',(event,payload)=>saveWorkspace(payload?.cards,payload?.connections,event.sender,payload?.profileId));
// note: sendSync blocks the renderer until event.returnValue is set; we set it
// inside .then() so the renderer waits for the saveQueue to drain before the
// window is allowed to close. This is the fix for the quit-save race (Bug #2).
ipcMain.on('dexpad:save-workspace-sync',(event,payload)=>{
  saveWorkspaceSync(payload)
    .then(()=>{event.returnValue=true;})
    .catch(err=>{console.error('[DexPad] sync save failed:',err);event.returnValue=false;});
});
ipcMain.handle('dexpad:get-profiles',()=>({profiles:profileSummary(),activeProfileId}));
ipcMain.handle('dexpad:switch-profile',(_,id)=>switchProfile(id));
ipcMain.handle('dexpad:create-profile',(_,name)=>createProfile(name));
ipcMain.handle('dexpad:rename-profile',(_,id,name)=>renameProfile(id,name));
ipcMain.handle('dexpad:set-startup',(_,enabled)=>{if(typeof enabled==='boolean'){applyStartup(enabled);publishState();}return currentState();});
ipcMain.handle('dexpad:set-wallpaper-mode',(_,enabled)=>{if(typeof enabled==='boolean')setWallpaperMode(enabled);return currentState();});
ipcMain.handle('dexpad:set-state',(_,state)=>{if(typeof state?.startup==='boolean')applyStartup(state.startup);if(typeof state?.wallpaperMode==='boolean')setWallpaperMode(state.wallpaperMode);return currentState();});
ipcMain.handle('dexpad:refresh-wallpaper',()=>refreshWallpaper());
ipcMain.handle('dexpad:open-workspace',()=>{showControlWindow();return true;});
ipcMain.handle('dexpad:open-url',(_,url)=>{if(!isValidUrl(url))throw new Error('Only http(s) URLs are permitted.');return shell.openExternal(url);});

app.whenReady().then(()=>{
  applyStartup(Boolean(store.get('startup')));
  const registered=globalShortcut.register('CommandOrControl+Alt+D',()=>showControlWindow());
  if(!registered)console.warn('[DexPad] Global shortcut CommandOrControl+Alt+D could not be registered.');
  createTray();startExplorerWatch();
  const hidden=process.argv.includes('--hidden');
  if(store.get('wallpaperMode')){createDesktopWindow();if(!hidden)showControlWindow();}else if(!hidden)showControlWindow();
  screen.on('display-metrics-changed',onDisplayChange);screen.on('display-added',onDisplayChange);screen.on('display-removed',onDisplayChange);
});
function onDisplayChange(){if(!quitting&&store.get('wallpaperMode'))refreshWallpaper();}
app.on('second-instance',()=>showControlWindow());app.on('activate',()=>showControlWindow());app.on('window-all-closed',event=>event.preventDefault());app.on('before-quit',()=>{quitting=true;globalShortcut.unregisterAll();});
