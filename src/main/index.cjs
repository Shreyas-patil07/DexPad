'use strict';

const {
  app, BrowserWindow, globalShortcut, ipcMain,
  screen, Menu, Tray, nativeImage, shell
} = require('electron');
const path = require('node:path');
const Store = require('electron-store');
const { CURRENT_SCHEMA_VERSION, isValidUrl, normalizeCard, migrateState } = require('./card-schema.cjs');

let wallpaperApi = null;
if (process.platform === 'win32') {
  try { wallpaperApi = require('./win32-wallpaper.cjs'); }
  catch (err) { console.error('[DexPad] Failed to load native wallpaper module:', err.message); }
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const store = new Store({
  name: 'dexpad',
  defaults: { schemaVersion: CURRENT_SCHEMA_VERSION, startup: false, wallpaperMode: true, cards: [] }
});
const migrated = migrateState(store.store);
if (store.get('schemaVersion') !== CURRENT_SCHEMA_VERSION) {
  store.set('schemaVersion', CURRENT_SCHEMA_VERSION);
  store.set('cards', migrated.cards);
}

let workspaceWin=null, desktopWin=null, settingsWin=null, tray=null, quitting=false;
const RENDERER=path.join(__dirname,'../renderer');
const WORKSPACE_HTML=path.join(RENDERER,'workspace.html');
const PRELOAD=path.join(__dirname,'../preload/preload.cjs');

function getTargetDisplay(){try{const pt=screen.getCursorScreenPoint();const d=screen.getDisplayNearestPoint(pt);if(d)return d}catch(_){}return screen.getPrimaryDisplay()}
function controlBounds(targetDisplay=null){const d=targetDisplay||getTargetDisplay(),wa=d.workArea,w=Math.min(740,Math.round(wa.width*.42)),h=Math.min(780,Math.round(wa.height*.88));return{x:wa.x+wa.width-w,y:wa.y+Math.round((wa.height-h)/2),width:w,height:h}}
function wallpaperPanelBounds(targetDisplay=null){const d=targetDisplay||screen.getPrimaryDisplay(),w=Math.min(740,Math.round(d.bounds.width*.42)),h=Math.min(780,Math.round(d.bounds.height*.88));return{x:d.bounds.x+d.bounds.width-w,y:d.bounds.y+Math.round((d.bounds.height-h)/2),width:w,height:h}}
function wallpaperNativePosition(display,dipBounds){const p=screen.dipToScreenPoint({x:dipBounds.x,y:dipBounds.y});return{x:Math.round(p.x),y:Math.round(p.y),width:dipBounds.width,height:dipBounds.height}}
function getCards(){const raw=store.get('cards');return Array.isArray(raw)?raw.map((c,i)=>normalizeCard(c,i)).filter(Boolean):[]}
function currentState(){return{schemaVersion:store.get('schemaVersion')||CURRENT_SCHEMA_VERSION,startup:Boolean(store.get('startup')),wallpaperMode:typeof store.get('wallpaperMode')==='boolean'?store.get('wallpaperMode'):true,cards:getCards()}}
function publishState(excludeSender=null){if(quitting)return;const state=currentState();for(const win of[workspaceWin,desktopWin])if(win&&!win.isDestroyed()&&(!excludeSender||win.webContents!==excludeSender))win.webContents.send('dexpad:state-updated',state)}

let saveQueue=Promise.resolve();
function saveCards(cards,excludeSender=null){
  const operation=saveQueue.then(()=>{
    const normalized=Array.isArray(cards)?cards.map((c,i)=>normalizeCard(c,i)).filter(Boolean):[];
    store.set('cards',normalized);
    publishState(excludeSender);
    return normalized;
  });
  saveQueue=operation.catch(err=>{
    console.error('[DexPad] saveCards error in queue:',err);
    throw err;
  });
  return operation;
}
function applyStartup(enabled){store.set('startup',enabled);app.setLoginItemSettings({openAtLogin:enabled,args:['--hidden']})}
function showControlWindow(){if(workspaceWin&&!workspaceWin.isDestroyed()){if(!workspaceWin.isVisible())workspaceWin.show();workspaceWin.focus();return workspaceWin}return createControlWindow()}
function createControlWindow(){const bounds=controlBounds();workspaceWin=new BrowserWindow({...bounds,show:false,frame:true,resizable:true,movable:true,minimizable:true,maximizable:false,focusable:true,skipTaskbar:false,title:'DexPad',backgroundColor:'#090b0e',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});workspaceWin.setMenuBarVisibility(false);workspaceWin.loadFile(WORKSPACE_HTML,{search:'mode=control'}).catch(e=>console.error('[DexPad] Failed to load workspace:',e.message));workspaceWin.once('ready-to-show',()=>{workspaceWin.show();workspaceWin.focus()});workspaceWin.on('closed',()=>{workspaceWin=null});return workspaceWin}

const ATTACH_MAX=6,ATTACH_DELAY=1000;let attachTries=0,attachBusy=false,attachTimer=null,explorerWatchTimer=null;
function attachWallpaper(){if(!desktopWin||desktopWin.isDestroyed()||!wallpaperApi||attachBusy)return;if(attachTimer){clearTimeout(attachTimer);attachTimer=null}attachBusy=true;_doAttach()}
function _doAttach(){if(!desktopWin||desktopWin.isDestroyed()){attachBusy=false;attachTries=0;return}try{const display=getTargetDisplay(),bounds=wallpaperPanelBounds(display),nativeBounds=wallpaperNativePosition(display,bounds);desktopWin.setBounds(bounds);wallpaperApi.attachToDesktop(desktopWin,nativeBounds);wallpaperApi.setClickThrough(desktopWin,true);desktopWin.setIgnoreMouseEvents(true);desktopWin.showInactive();wallpaperApi.sendToBottom(desktopWin);attachTries=0;attachBusy=false;attachTimer=null;console.log('[DexPad] Wallpaper panel attached to desktop.')}catch(err){if(attachTries<ATTACH_MAX){attachTries++;console.warn(`[DexPad] Wallpaper attach attempt ${attachTries}/${ATTACH_MAX} failed, retrying…`);attachTimer=setTimeout(_doAttach,ATTACH_DELAY)}else{console.error('[DexPad] Wallpaper attach gave up. Falling back to control panel.',err.message);attachTries=0;attachBusy=false;attachTimer=null;store.set('wallpaperMode',false);destroyDesktopWindow();rebuildTray();showControlWindow()}}}
function createDesktopWindow(){if(process.platform!=='win32'||!wallpaperApi){store.set('wallpaperMode',false);showControlWindow();return null}if(desktopWin&&!desktopWin.isDestroyed()){attachWallpaper();return desktopWin}const bounds=wallpaperPanelBounds();desktopWin=new BrowserWindow({...bounds,show:false,frame:false,transparent:true,resizable:false,movable:false,focusable:false,skipTaskbar:true,hasShadow:false,backgroundColor:'#00000000',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});desktopWin.setMenu(null);desktopWin.setIgnoreMouseEvents(true);desktopWin.loadFile(WORKSPACE_HTML,{search:'mode=wallpaper'}).catch(e=>console.warn('[DexPad] Failed to load wallpaper view:',e.message));desktopWin.webContents.once('did-finish-load',()=>{attachTimer=setTimeout(attachWallpaper,150)});desktopWin.on('closed',()=>{desktopWin=null});return desktopWin}
function destroyDesktopWindow(){if(attachTimer){clearTimeout(attachTimer);attachTimer=null}attachBusy=false;attachTries=0;if(!desktopWin||desktopWin.isDestroyed())return;if(wallpaperApi){try{wallpaperApi.detachFromDesktop(desktopWin)}catch(_) {}}desktopWin.destroy();desktopWin=null}
function refreshWallpaper(){if(!store.get('wallpaperMode')||process.platform!=='win32')return false;if(!desktopWin||desktopWin.isDestroyed()){createDesktopWindow();return true}publishState();attachWallpaper();return true}
function startExplorerWatch(){if(explorerWatchTimer)clearInterval(explorerWatchTimer);explorerWatchTimer=setInterval(()=>{if(quitting||!store.get('wallpaperMode'))return;if(desktopWin&&!desktopWin.isDestroyed()&&wallpaperApi&&!wallpaperApi.isWindowAttached(desktopWin)){console.warn('[DexPad] Desktop attachment lost (Explorer restarted). Re-attaching…');attachWallpaper()}},4000)}
function setWallpaperMode(enabled){store.set('wallpaperMode',enabled);if(enabled){if(!desktopWin||desktopWin.isDestroyed())createDesktopWindow();if(workspaceWin&&!workspaceWin.isDestroyed())workspaceWin.hide()}else{destroyDesktopWindow();showControlWindow()}publishState();rebuildTray()}
function buildTrayIcon(){for(const p of[path.join(__dirname,'../../assets/icon.png'),path.join(__dirname,'../assets/icon.png'),path.join(__dirname,'../../assets/icon.ico'),path.join(RENDERER,'icon.png'),path.join(RENDERER,'icon.ico')]){try{const img=nativeImage.createFromPath(p);if(!img.isEmpty())return img}catch(_) {}}return nativeImage.createEmpty()}
function createTray(){if(tray)return;tray=new Tray(buildTrayIcon());tray.setToolTip('DexPad — right-click for options');tray.on('click',()=>showControlWindow());rebuildTray()}
function rebuildTray(){if(!tray)return;const wallpaper=store.get('wallpaperMode');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open DexPad',click:()=>showControlWindow()},{label:'Refresh Wallpaper',click:()=>refreshWallpaper()},{type:'separator'},{label:'Desktop Wallpaper',type:'checkbox',checked:wallpaper,click:()=>setWallpaperMode(!wallpaper)},{label:'Settings',click:()=>showSettingsWindow()},{type:'separator'},{label:'Quit DexPad',click:()=>quitApp()}]))}
function showSettingsWindow(){if(settingsWin&&!settingsWin.isDestroyed()){settingsWin.show();settingsWin.focus();return}settingsWin=new BrowserWindow({width:520,height:440,resizable:false,minimizable:false,title:'DexPad Settings',backgroundColor:'#090b0e',webPreferences:{contextIsolation:true,sandbox:true,preload:PRELOAD}});settingsWin.setMenuBarVisibility(false);settingsWin.loadFile(path.join(RENDERER,'settings.html'));settingsWin.on('closed',()=>{settingsWin=null})}
function quitApp(){quitting=true;if(explorerWatchTimer){clearInterval(explorerWatchTimer);explorerWatchTimer=null}if(attachTimer){clearTimeout(attachTimer);attachTimer=null}globalShortcut.unregisterAll();destroyDesktopWindow();workspaceWin?.destroy();settingsWin?.destroy();tray?.destroy();app.quit()}

ipcMain.handle('dexpad:get-state',()=>currentState());
ipcMain.handle('dexpad:save-cards',(event,rawCards)=>saveCards(rawCards,event.sender));
ipcMain.handle('dexpad:set-startup',(_,enabled)=>{if(typeof enabled==='boolean'){applyStartup(enabled);publishState()}return currentState()});
ipcMain.handle('dexpad:set-wallpaper-mode',(_,enabled)=>{if(typeof enabled==='boolean')setWallpaperMode(enabled);return currentState()});
ipcMain.handle('dexpad:set-state',(_,state)=>{if(typeof state?.startup==='boolean')applyStartup(state.startup);if(typeof state?.wallpaperMode==='boolean')setWallpaperMode(state.wallpaperMode);return currentState()});
ipcMain.handle('dexpad:refresh-wallpaper',()=>refreshWallpaper());
ipcMain.handle('dexpad:open-workspace',()=>{showControlWindow();return true});
ipcMain.handle('dexpad:open-url',(_,url)=>{if(!isValidUrl(url))throw new Error('Only http(s) URLs are permitted.');return shell.openExternal(url)});

app.whenReady().then(()=>{applyStartup(store.get('startup'));const registered=globalShortcut.register('CommandOrControl+Alt+D',()=>showControlWindow());if(!registered)console.warn('[DexPad] Warning: Global shortcut CommandOrControl+Alt+D could not be registered.');createTray();startExplorerWatch();const hidden=process.argv.includes('--hidden');if(store.get('wallpaperMode')){createDesktopWindow();if(!hidden)showControlWindow()}else if(!hidden)showControlWindow();screen.on('display-metrics-changed',onDisplayChange);screen.on('display-added',onDisplayChange);screen.on('display-removed',onDisplayChange)});
function onDisplayChange(){if(quitting)return;if(store.get('wallpaperMode'))refreshWallpaper()}
app.on('second-instance',()=>showControlWindow());app.on('window-all-closed',e=>e.preventDefault());app.on('before-quit',()=>{quitting=true;globalShortcut.unregisterAll()});
