'use strict';

if (process.platform !== 'win32') throw new Error('DexPad wallpaper mode is Windows-only.');

const koffi = require('koffi');
const DEBUG = process.env.DEXPAD_WALLPAPER_DEBUG !== '0';
const startedAt = Date.now();
const log = (...a) => { if (DEBUG) console.log(`[DexPad][Wallpaper][+${String(Date.now()-startedAt).padStart(6,' ')}ms]`, ...a); };
const logError = (label,e) => console.error(`[DexPad][Wallpaper][ERROR] ${label}`,e?.stack||e?.message||e);

const HWND='intptr_t';
const u=koffi.load('user32.dll');
const k=koffi.load('kernel32.dll');
const FindWindowW=u.func('__stdcall','FindWindowW',HWND,['str16','str16']);
const FindWindowExW=u.func('__stdcall','FindWindowExW',HWND,[HWND,HWND,'str16','str16']);
const SetParent=u.func('__stdcall','SetParent',HWND,[HWND,HWND]);
const GetParent=u.func('__stdcall','GetParent',HWND,[HWND]);
const IsWindow=u.func('__stdcall','IsWindow','int32',[HWND]);
const IsWindowVisible=u.func('__stdcall','IsWindowVisible','int32',[HWND]);
const GetClassNameW=u.func('__stdcall','GetClassNameW','int32',[HWND,'void *','int32']);
const GetWindowLongPtrW=u.func('__stdcall','GetWindowLongPtrW','intptr_t',[HWND,'int32']);
const SetWindowLongPtrW=u.func('__stdcall','SetWindowLongPtrW','intptr_t',[HWND,'int32','intptr_t']);
const GetWindowRect=u.func('__stdcall','GetWindowRect','int32',[HWND,'void *']);
const SetWindowPos=u.func('__stdcall','SetWindowPos','int32',[HWND,HWND,'int32','int32','int32','int32','uint32']);
const ShowWindow=u.func('__stdcall','ShowWindow','int32',[HWND,'int32']);
const SetLayeredWindowAttributes=u.func('__stdcall','SetLayeredWindowAttributes','int32',[HWND,'uint32','uint8','uint32']);
const GetLastError=k.func('__stdcall','GetLastError','uint32',[]);
const SetLastError=k.func('__stdcall','SetLastError','void',['uint32']);
const SendMessageTimeoutW=u.func('__stdcall','SendMessageTimeoutW','intptr_t',[HWND,'uint32','uintptr_t','intptr_t','uint32','uint32','void *']);
const EnumProc=koffi.proto('__stdcall','DexPadWallpaperEnumProc','int32',[HWND,'intptr_t']);
const EnumWindows=u.func('__stdcall','EnumWindows','int32',[koffi.pointer(EnumProc),'intptr_t']);

const GWL_STYLE=-16, GWL_EXSTYLE=-20;
const WS_CHILD=0x40000000, WS_POPUP=0x80000000, WS_VISIBLE=0x10000000, WS_CLIPSIBLINGS=0x04000000;
const WS_EX_TOOLWINDOW=0x00000080, WS_EX_NOACTIVATE=0x08000000, WS_EX_APPWINDOW=0x00040000, WS_EX_TRANSPARENT=0x00000020, WS_EX_LAYERED=0x00080000, WS_EX_NOREDIRECTIONBITMAP=0x00200000;
const LWA_ALPHA=0x2, HWND_TOP=0n, HWND_BOTTOM=1n;
const SWP_NOMOVE=0x0002, SWP_NOSIZE=0x0001, SWP_NOZORDER=0x0004, SWP_NOACTIVATE=0x0010, SWP_NOSENDCHANGING=0x0400, SWP_SHOWWINDOW=0x0040, SWP_FRAMECHANGED=0x0020, SWP_NOOWNERZORDER=0x0200;
const SW_SHOWNOACTIVATE=4, SMTO_NORMAL=0;

function bi(v){
  if(v==null)return 0n;
  if(typeof v==='bigint')return v;
  if(typeof v==='number')return BigInt(v);
  if(Buffer.isBuffer(v)){ if(v.length>=8)return v.readBigUInt64LE(0); if(v.length>=4)return BigInt(v.readUInt32LE(0)); }
  return 0n;
}
function label(v){const n=bi(v);return n===0n?'NULL':`0x${n.toString(16).toUpperCase()}`;}
function isNull(v){return bi(v)===0n;}
function err(){try{return Number(GetLastError());}catch(_){return -1;}}
function style(hwnd,idx){try{return Number(GetWindowLongPtrW(hwnd,idx))>>>0;}catch(_){return 0;}}
function cls(hwnd){if(isNull(hwnd))return '';const b=Buffer.alloc(256);const n=GetClassNameW(hwnd,b,128);return n>0?b.toString('utf16le',0,n*2):'';}
function child(parent,after,wanted){return FindWindowExW(parent,after,wanted,null);}
function rect(hwnd){const b=Buffer.alloc(16);SetLastError(0);if(!GetWindowRect(hwnd,b))throw new Error(`GetWindowRect failed for ${label(hwnd)} win32=${err()}`);const l=b.readInt32LE(0),t=b.readInt32LE(4),r=b.readInt32LE(8),bt=b.readInt32LE(12);return {left:l,top:t,right:r,bottom:bt,width:r-l,height:bt-t};}
function inspect(name,hwnd){if(isNull(hwnd)){log(name,{hwnd:'NULL'});return;}const p=GetParent(hwnd);log(name,{hwnd:label(hwnd),class:cls(hwnd),parent:label(p),parentClass:isNull(p)?'':cls(p),isWindow:IsWindow(hwnd),visible:IsWindowVisible(hwnd),style:`0x${style(hwnd,GWL_STYLE).toString(16).toUpperCase()}`,exStyle:`0x${style(hwnd,GWL_EXSTYLE).toString(16).toUpperCase()}`});}
function enumTopLevel(pred){const out=[];const cb=koffi.register(hwnd=>{try{if(pred(hwnd))out.push(hwnd);}catch(e){logError('EnumWindows predicate',e);}return 1;},koffi.pointer(EnumProc));try{EnumWindows(cb,0n);}finally{koffi.unregister(cb);}return out;}

function spawnWorkerW(progman){
  const out=Buffer.alloc(8);SetLastError(0);const result=SendMessageTimeoutW(progman,0x052C,0x0D,0x01,SMTO_NORMAL,2000,out);const e=err();
  log('spawnWorkerW',{result,immediateLastError:e,out:out.toString('hex')});
}
function findShellViewOwner(){const owners=enumTopLevel(hwnd=>!isNull(child(hwnd,0n,'SHELLDLL_DefView')));return owners[0]||0n;}
function findClassicWorkerW(){const candidates=[];for(const hwnd of enumTopLevel(hwnd=>cls(hwnd)==='WorkerW')){const parent=GetParent(hwnd),shell=child(hwnd,0n,'SHELLDLL_DefView');candidates.push({hwnd,parent,shell});}log('classic WorkerW candidates',candidates.map(x=>({hwnd:label(x.hwnd),parent:label(x.parent),childShell:label(x.shell)})));return candidates.find(x=>isNull(x.parent)&&isNull(x.shell))?.hwnd||0n;}

function findDesktopTarget(){
  const progman=FindWindowW('Progman',null);if(isNull(progman)||IsWindow(progman)===0)throw new Error('Progman not found — is Explorer running?');
  spawnWorkerW(progman);
  const shellOwner=findShellViewOwner();if(isNull(shellOwner))throw new Error('SHELLDLL_DefView owner not found.');
  const shell=child(shellOwner,0n,'SHELLDLL_DefView');
  const ex=style(progman,GWL_EXSTYLE);const raised=(ex&WS_EX_NOREDIRECTIONBITMAP)!==0;
  const childWorkerW=child(progman,0n,'WorkerW');
  log('desktop topology',{progman:label(progman),progmanClass:cls(progman),progmanExStyle:`0x${ex.toString(16).toUpperCase()}`,raisedDesktop:raised,shellOwner:label(shellOwner),shellView:label(shell),childWorkerW:label(childWorkerW),childWorkerWParent:isNull(childWorkerW)?'NULL':label(GetParent(childWorkerW))});
  if(isNull(shell))throw new Error('SHELLDLL_DefView not found.');
  if(raised){
    // Modern Windows 11 raised-desktop path: attach our layered child directly to Progman.
    // The existing WorkerW is informational/z-order context; it is not the parent target.
    return {kind:'raised',parent:progman,zAfter:shell,workerW:childWorkerW,progman,shell};
  }
  const worker=findClassicWorkerW();if(isNull(worker))throw new Error('No classic top-level WorkerW found.');
  return {kind:'classic',parent:worker,zAfter:HWND_TOP,workerW:worker,progman,shell};
}

function prepare(hwnd){
  const before=style(hwnd,GWL_EXSTYLE),next=((before|WS_EX_TOOLWINDOW|WS_EX_LAYERED)&~WS_EX_APPWINDOW)>>>0;
  SetLastError(0);SetWindowLongPtrW(hwnd,GWL_EXSTYLE,next);const se=err();
  SetLastError(0);const lr=SetLayeredWindowAttributes(hwnd,0,255,LWA_ALPHA);const le=err();
  log('prepare',{before:`0x${before.toString(16).toUpperCase()}`,next:`0x${next.toString(16).toUpperCase()}`,actual:`0x${style(hwnd,GWL_EXSTYLE).toString(16).toUpperCase()}`,styleLastError:se,layeredResult:lr,layeredLastError:le});
  if(!lr)throw new Error(`SetLayeredWindowAttributes failed win32=${le}`);
}
function makeChild(hwnd){
  const before=style(hwnd,GWL_STYLE);const next=((before&0x7FFFFFFF)|WS_CHILD|WS_VISIBLE|WS_CLIPSIBLINGS)>>>0;
  SetLastError(0);SetWindowLongPtrW(hwnd,GWL_STYLE,next);const e=err();const actual=style(hwnd,GWL_STYLE);
  log('makeChild',{before:`0x${before.toString(16).toUpperCase()}`,next:`0x${next.toString(16).toUpperCase()}`,actual:`0x${actual.toString(16).toUpperCase()}`,lastError:e});
  if(actual!==next)throw new Error(`Failed to set WS_CHILD style expected=0x${next.toString(16)} actual=0x${actual.toString(16)} win32=${e}`);
}
function setParentChecked(hwnd,target){
  const before=GetParent(hwnd);SetLastError(0);let previous;
  try{previous=SetParent(hwnd,target.parent);}catch(e){logError('SetParent threw',e);throw e;}
  const immediate=err();const actual=GetParent(hwnd);const actualClass=isNull(actual)?'':cls(actual);
  log('SetParent',{mode:target.kind,child:label(hwnd),requested:label(target.parent),previous:label(previous),actual:label(actual),actualClass,immediateLastError:immediate});
  if(bi(actual)!==bi(target.parent))throw new Error(`SetParent failed mode=${target.kind} requested=${label(target.parent)} actual=${label(actual)} class=${actualClass||'NULL'} win32=${immediate}`);
  return previous;
}
function attachToDesktop(browserWindow,bounds){
  log('============================================================');log('attachToDesktop: BEGIN',{bounds});
  if(!browserWindow||browserWindow.isDestroyed())throw new Error('Cannot attach a destroyed BrowserWindow.');
  const raw=browserWindow.getNativeWindowHandle();const hwnd=bi(raw);if(isNull(hwnd))throw new Error('Electron returned a null native window handle.');
  log('Electron HWND',{bytes:raw?.length||0,hwnd:label(hwnd)});inspect('Electron BEFORE attach',hwnd);
  const target=findDesktopTarget();const er=rect(hwnd);if(er.width<=0||er.height<=0)throw new Error(`Invalid Electron native size ${er.width}x${er.height}`);log('Electron RECT',er);
  prepare(hwnd);makeChild(hwnd);setParentChecked(hwnd,target);
  const pr=rect(target.parent);const x=Math.round((bounds?.x||0)-pr.left),y=Math.round((bounds?.y||0)-pr.top);const after=target.zAfter||HWND_TOP;
  SetLastError(0);const pos=SetWindowPos(hwnd,after,x,y,er.width,er.height,SWP_NOACTIVATE|SWP_SHOWWINDOW|SWP_FRAMECHANGED|SWP_NOOWNERZORDER);const pe=err();
  log('SetWindowPos',{mode:target.kind,result:pos,immediateLastError:pe,insertAfter:label(after),insertAfterClass:isNull(after)?'':cls(after),parent:label(target.parent),parentRect:pr,x,y,width:er.width,height:er.height});
  if(!pos)throw new Error(`SetWindowPos failed win32=${pe}`);
  SetLastError(0);const show=ShowWindow(hwnd,SW_SHOWNOACTIVATE);const she=err();log('ShowWindow',{result:show,immediateLastError:she});
  const final=GetParent(hwnd);inspect('Electron FINAL after attach',hwnd);
  if(bi(final)!==bi(target.parent))throw new Error(`Wallpaper parent changed unexpectedly expected=${label(target.parent)} actual=${label(final)}`);
  log('attachToDesktop: SUCCESS',{mode:target.kind,parent:label(target.parent),workerW:label(target.workerW),shellView:label(target.shell)});log('============================================================');
  return true;
}
function detachFromDesktop(browserWindow){
  log('detachFromDesktop: BEGIN');if(!browserWindow||browserWindow.isDestroyed())return;const hwnd=bi(browserWindow.getNativeWindowHandle());if(isNull(hwnd))return;const s=style(hwnd,GWL_STYLE);
  if(s&WS_CHILD){const next=((s&0x7FFFFFFF)|WS_POPUP|WS_VISIBLE)>>>0;SetLastError(0);SetWindowLongPtrW(hwnd,GWL_STYLE,next);const se=err();SetLastError(0);const old=SetParent(hwnd,0n);const pe=err();log('detach SetParent(NULL)',{previous:label(old),actual:label(GetParent(hwnd)),styleLastError:se,parentLastError:pe});}
  const ex=style(hwnd,GWL_EXSTYLE),nextEx=((ex&(~WS_EX_TOOLWINDOW)&(~WS_EX_NOACTIVATE)&(~WS_EX_TRANSPARENT))|WS_EX_APPWINDOW)>>>0;SetLastError(0);SetWindowLongPtrW(hwnd,GWL_EXSTYLE,nextEx);log('detach exStyle',{actual:`0x${style(hwnd,GWL_EXSTYLE).toString(16).toUpperCase()}`,lastError:err()});log('detachFromDesktop: END');
}
function setClickThrough(browserWindow,enabled){
  const hwnd=bi(browserWindow.getNativeWindowHandle()),ex=style(hwnd,GWL_EXSTYLE);const next=enabled?((ex|WS_EX_TRANSPARENT|WS_EX_NOACTIVATE)>>>0):(((ex&~WS_EX_TRANSPARENT&~WS_EX_NOACTIVATE)|WS_EX_APPWINDOW)>>>0);
  SetLastError(0);SetWindowLongPtrW(hwnd,GWL_EXSTYLE,next);const se=err();browserWindow.setIgnoreMouseEvents(enabled);SetLastError(0);const pos=SetWindowPos(hwnd,0n,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOZORDER|SWP_FRAMECHANGED);const pe=err();log('setClickThrough',{enabled,actual:`0x${style(hwnd,GWL_EXSTYLE).toString(16).toUpperCase()}`,styleLastError:se,setWindowPosResult:pos,setWindowPosLastError:pe});if(!pos)throw new Error(`SetWindowPos(click-through) failed win32=${pe}`);
}
function sendToBottom(browserWindow){
  const hwnd=bi(browserWindow.getNativeWindowHandle()),parent=GetParent(hwnd),progman=FindWindowW('Progman',null),raised=!isNull(progman)&&(style(progman,GWL_EXSTYLE)&WS_EX_NOREDIRECTIONBITMAP)!==0;
  if(raised&&!isNull(parent)&&!isNull(progman)&&bi(parent)===bi(progman)){const shellOwner=findShellViewOwner(),shell=!isNull(shellOwner)?child(shellOwner,0n,'SHELLDLL_DefView'):0n;if(!isNull(shell)){SetLastError(0);const r=SetWindowPos(hwnd,shell,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER);const e=err();log('sendToBottom raised',{result:r,lastError:e,parent:label(parent),shell:label(shell)});if(!r)throw new Error(`Raised Z-order failed win32=${e}`);return;}}
  SetLastError(0);const r=SetWindowPos(hwnd,HWND_BOTTOM,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOSENDCHANGING);const e=err();log('sendToBottom classic',{result:r,lastError:e});if(!r)throw new Error(`SetWindowPos(bottom) failed win32=${e}`);
}
function isWindowAttached(browserWindow){
  if(!browserWindow||browserWindow.isDestroyed())return false;
  try{const hwnd=bi(browserWindow.getNativeWindowHandle()),parent=GetParent(hwnd),progman=FindWindowW('Progman',null);if(isNull(parent)||IsWindow(parent)===0)return false;const raised=!isNull(progman)&&(style(progman,GWL_EXSTYLE)&WS_EX_NOREDIRECTIONBITMAP)!==0;return raised?bi(parent)===bi(progman):cls(parent)==='WorkerW';}catch(e){logError('isWindowAttached',e);return false;}
}
module.exports={attachToDesktop,detachFromDesktop,setClickThrough,sendToBottom,isWindowAttached};
