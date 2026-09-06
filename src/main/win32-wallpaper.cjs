'use strict';

if (process.platform !== 'win32') {
  throw new Error('DexPad wallpaper mode is Windows-only.');
}

const koffi = require('koffi');

const DEBUG = process.env.DEXPAD_WALLPAPER_DEBUG !== '0';
const startedAt = Date.now();

function debug(...args) {
  if (!DEBUG) return;
  const elapsed = String(Date.now() - startedAt).padStart(6, ' ');
  console.log(`[DexPad][Wallpaper][+${elapsed}ms]`, ...args);
}

function debugError(label, err) {
  console.error(`[DexPad][Wallpaper][ERROR] ${label}`, err?.stack || err?.message || err);
}

const HWND = 'intptr_t';
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'int32', [HWND]);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int32', [HWND, 'void *', 'int32']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [HWND, 'int32', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int32']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int32', [HWND, HWND, 'int32', 'int32', 'int32', 'uint32']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int32', [HWND, 'void *']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', [HWND, 'int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', [HWND, 'uint32', 'uint8', 'uint32']);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const SetLastError = kernel32.func('__stdcall', 'SetLastError', 'void', ['uint32']);

const EnumWindowsProc = koffi.proto('__stdcall', 'DexPadEnumWindowsProc', 'int32', [HWND, 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsProc), 'intptr_t']);
const SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', [HWND, 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'void *']);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const LWA_ALPHA = 0x00000002;
const HWND_BOTTOM = 1n;
const HWND_TOP = 0n;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOOWNERZORDER = 0x0200;
const SW_SHOWNOACTIVATE = 4;
const SMTO_NORMAL = 0x0000;

function hwndToBigInt(handle) {
  if (handle == null) return 0n;
  if (typeof handle === 'bigint') return handle;
  if (typeof handle === 'number') return BigInt(handle);
  if (Buffer.isBuffer(handle)) {
    if (handle.length >= 8) return handle.readBigUInt64LE(0);
    if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
  }
  return 0n;
}

function hwndLabel(handle) {
  const value = hwndToBigInt(handle);
  return value === 0n ? 'NULL' : `0x${value.toString(16).toUpperCase()}`;
}

function isNull(handle) {
  return hwndToBigInt(handle) === 0n;
}

function win32Error() {
  try { return Number(GetLastError()); } catch (_) { return -1; }
}

function className(hwnd) {
  if (isNull(hwnd)) return '';
  const buffer = Buffer.alloc(256);
  const length = GetClassNameW(hwnd, buffer, 128);
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
}

function getStyle(hwnd, index) {
  try { return Number(GetWindowLongPtrW(hwnd, index)) >>> 0; } catch (_) { return 0; }
}

function findChildByClass(parent, after, wantedClass) {
  return FindWindowExW(parent, after, wantedClass, null);
}

function inspectWindow(label, hwnd) {
  if (isNull(hwnd)) {
    debug(label, { hwnd: 'NULL' });
    return;
  }
  const parent = GetParent(hwnd);
  debug(label, {
    hwnd: hwndLabel(hwnd),
    class: className(hwnd),
    parent: hwndLabel(parent),
    parentClass: isNull(parent) ? '' : className(parent),
    isWindow: IsWindow(hwnd),
    style: `0x${getStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`,
    exStyle: `0x${getStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });
}

function getRect(hwnd) {
  const rect = Buffer.alloc(16);
  SetLastError(0);
  if (!GetWindowRect(hwnd, rect)) {
    throw new Error(`GetWindowRect failed for ${hwndLabel(hwnd)}. win32Error=${win32Error()}`);
  }
  const left = rect.readInt32LE(0);
  const top = rect.readInt32LE(4);
  const right = rect.readInt32LE(8);
  const bottom = rect.readInt32LE(12);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function spawnWorkerW(progman) {
  try {
    const out = Buffer.alloc(8);
    SetLastError(0);
    const result = SendMessageTimeoutW(progman, 0x052C, 0x0D, 0x01, SMTO_NORMAL, 2000, out);
    debug('spawnWorkerW: probe', {
      result,
      lastErrorImmediatelyAfterCall: win32Error(),
      out: out.toString('hex')
    });
  } catch (err) {
    debugError('spawnWorkerW', err);
  }
}

function findShellViewOwner() {
  let owner = 0n;
  const callback = koffi.register((hwnd) => {
    if (!isNull(findChildByClass(hwnd, 0n, 'SHELLDLL_DefView'))) {
      owner = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(callback, 0n); }
  finally { koffi.unregister(callback); }
  return owner;
}

function findTopLevelWorkerW() {
  let selected = 0n;
  const candidates = [];
  const callback = koffi.register((hwnd) => {
    if (className(hwnd) !== 'WorkerW') return 1;
    const childShell = findChildByClass(hwnd, 0n, 'SHELLDLL_DefView');
    const parent = GetParent(hwnd);
    candidates.push({ hwnd, parent, childShell, style: getStyle(hwnd, GWL_STYLE), exStyle: getStyle(hwnd, GWL_EXSTYLE) });
    if (isNull(childShell) && isNull(selected)) selected = hwnd;
    return 1;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(callback, 0n); }
  finally { koffi.unregister(callback); }

  debug('top-level WorkerW candidates', candidates.map(c => ({
    hwnd: hwndLabel(c.hwnd),
    parent: hwndLabel(c.parent),
    childShell: hwndLabel(c.childShell),
    style: `0x${c.style.toString(16).toUpperCase()}`,
    exStyle: `0x${c.exStyle.toString(16).toUpperCase()}`
  })));
  return selected;
}

function findDesktopTarget() {
  debug('findDesktopTarget: BEGIN');
  const progman = FindWindowW('Progman', null);
  if (isNull(progman) || IsWindow(progman) === 0) throw new Error('Progman not found — is Explorer running?');

  inspectWindow('Progman', progman);
  spawnWorkerW(progman);

  const shellViewOwner = findShellViewOwner();
  if (isNull(shellViewOwner)) throw new Error('SHELLDLL_DefView owner not found.');
  const shellView = findChildByClass(shellViewOwner, 0n, 'SHELLDLL_DefView');
  inspectWindow('SHELLDLL_DefView owner', shellViewOwner);
  inspectWindow('SHELLDLL_DefView', shellView);

  const progmanExStyle = getStyle(progman, GWL_EXSTYLE);
  const raisedDesktop = (progmanExStyle & WS_EX_NOREDIRECTIONBITMAP) !== 0;

  if (raisedDesktop) {
    const childWorkerW = findChildByClass(progman, 0n, 'WorkerW');
    debug('findDesktopTarget: RAISED_DESKTOP', {
      progman: hwndLabel(progman),
      progmanExStyle: `0x${progmanExStyle.toString(16).toUpperCase()}`,
      shellViewOwner: hwndLabel(shellViewOwner),
      shellView: hwndLabel(shellView),
      childWorkerW: hwndLabel(childWorkerW)
    });
    if (isNull(shellView)) throw new Error('Raised desktop detected but SHELLDLL_DefView is missing.');
    return { kind: 'raised', parent: progman, zAfter: shellView, workerW: childWorkerW, progman, shellView };
  }

  const workerW = findTopLevelWorkerW();
  if (isNull(workerW)) throw new Error('No suitable top-level WorkerW found.');
  debug('findDesktopTarget: CLASSIC', { progman: hwndLabel(progman), workerW: hwndLabel(workerW) });
  return { kind: 'classic', parent: workerW, zAfter: HWND_TOP, workerW, progman, shellView };
}

function prepareWindow(hwnd) {
  const before = getStyle(hwnd, GWL_EXSTYLE);
  const next = (before | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW;
  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  const error = win32Error();
  debug('prepareWindow: exStyle', { before: `0x${before.toString(16).toUpperCase()}`, next: `0x${next.toString(16).toUpperCase()}`, actual: `0x${getStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`, immediateLastError: error });
  SetLastError(0);
  const layered = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  const layeredError = win32Error();
  debug('prepareWindow: layered', { result: layered, immediateLastError: layeredError });
  if (!layered) throw new Error(`SetLayeredWindowAttributes failed. win32Error=${layeredError}`);
}

function setChildStyle(hwnd) {
  const before = getStyle(hwnd, GWL_STYLE);
  const next = ((before & (~WS_POPUP >>> 0)) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS) >>> 0;
  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_STYLE, next);
  const error = win32Error();
  const actual = getStyle(hwnd, GWL_STYLE);
  debug('setChildStyle', { before: `0x${before.toString(16).toUpperCase()}`, next: `0x${next.toString(16).toUpperCase()}`, actual: `0x${actual.toString(16).toUpperCase()}`, immediateLastError: error });
  if (actual !== next) throw new Error(`Failed to set WS_CHILD style. expected=0x${next.toString(16)} actual=0x${actual.toString(16)} win32Error=${error}`);
}

function trySetParent(hwnd, target) {
  const beforeParent = GetParent(hwnd);
  const beforeStyle = getStyle(hwnd, GWL_STYLE);
  const beforeExStyle = getStyle(hwnd, GWL_EXSTYLE);

  SetLastError(0);
  const previousParent = SetParent(hwnd, target.parent);
  const immediateLastError = win32Error();
  const actualParent = GetParent(hwnd);
  const actualParentClass = isNull(actualParent) ? '' : className(actualParent);

  debug('SET_PARENT_EXACT_RESULT', {
    mode: target.kind,
    child: hwndLabel(hwnd),
    requestedParent: hwndLabel(target.parent),
    previousParent: hwndLabel(previousParent),
    actualParent: hwndLabel(actualParent),
    actualParentClass,
    immediateLastError,
    childWasValidBefore: IsWindow(hwnd) !== 0,
    parentWasValidBefore: IsWindow(target.parent) !== 0,
    childStyleBefore: `0x${beforeStyle.toString(16).toUpperCase()}`,
    childStyleAfter: `0x${getStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`,
    childExStyleBefore: `0x${beforeExStyle.toString(16).toUpperCase()}`,
    childExStyleAfter: `0x${getStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });

  if (isNull(actualParent) || hwndToBigInt(actualParent) !== hwndToBigInt(target.parent)) {
    throw new Error(`SetParent failed — mode=${target.kind} requested=${hwndLabel(target.parent)} actual=${hwndLabel(actualParent)} class=${actualParentClass || 'NULL'} immediateWin32Error=${immediateLastError}`);
  }

  debug('SetParent SUCCESS', { mode: target.kind, beforeParent: hwndLabel(beforeParent), parent: hwndLabel(actualParent) });
  return { previousParent, actualParent, immediateLastError };
}

function attachToDesktop(browserWindow, bounds) {
  debug('============================================================');
  debug('attachToDesktop: BEGIN', { bounds });
  if (!browserWindow || browserWindow.isDestroyed()) throw new Error('Cannot attach a destroyed BrowserWindow.');

  const hwndBuffer = browserWindow.getNativeWindowHandle();
  const hwnd = hwndToBigInt(hwndBuffer);
  if (isNull(hwnd)) throw new Error('Electron returned a null native window handle.');
  debug('Electron HWND', { bytes: hwndBuffer.length, hwnd: hwndLabel(hwnd) });
  inspectWindow('Electron BEFORE attach', hwnd);

  const target = findDesktopTarget();
  const electronRect = getRect(hwnd);
  debug('Electron initial RECT', electronRect);

  prepareWindow(hwnd);
  setChildStyle(hwnd);
  trySetParent(hwnd, target);

  const parentRect = getRect(target.parent);
  const targetX = Math.round((bounds?.x || 0) - parentRect.left);
  const targetY = Math.round((bounds?.y || 0) - parentRect.top);
  const insertAfter = target.zAfter || HWND_TOP;
  const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOOWNERZORDER;

  SetLastError(0);
  const posResult = SetWindowPos(hwnd, insertAfter, targetX, targetY, electronRect.width, electronRect.height, flags);
  const posError = win32Error();
  debug('SetWindowPos exact result', {
    mode: target.kind,
    result: posResult,
    immediateLastError: posError,
    insertAfter: hwndLabel(insertAfter),
    parent: hwndLabel(target.parent),
    targetX,
    targetY,
    width: electronRect.width,
    height: electronRect.height
  });
  if (!posResult) throw new Error(`SetWindowPos failed. win32Error=${posError}`);

  SetLastError(0);
  const showResult = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  const showError = win32Error();
  debug('ShowWindow exact result', { result: showResult, immediateLastError: showError });

  inspectWindow('Electron FINAL after attach', hwnd);
  const finalParent = GetParent(hwnd);
  if (isNull(finalParent) || hwndToBigInt(finalParent) !== hwndToBigInt(target.parent)) {
    throw new Error(`Wallpaper parent changed unexpectedly — expected=${hwndLabel(target.parent)} actual=${hwndLabel(finalParent)}`);
  }

  debug('attachToDesktop: SUCCESS', { mode: target.kind, parent: hwndLabel(target.parent), workerW: hwndLabel(target.workerW), shellView: hwndLabel(target.shellView) });
  debug('============================================================');
  return true;
}

function detachFromDesktop(browserWindow) {
  debug('detachFromDesktop: BEGIN');
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const hwnd = hwndToBigInt(browserWindow.getNativeWindowHandle());
  inspectWindow('Electron BEFORE detach', hwnd);

  const style = getStyle(hwnd, GWL_STYLE);
  if (style & WS_CHILD) {
    const nextStyle = ((style & (~WS_CHILD >>> 0)) | WS_POPUP | WS_VISIBLE) >>> 0;
    SetLastError(0);
    SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle);
    const styleError = win32Error();
    SetLastError(0);
    const previousParent = SetParent(hwnd, 0n);
    const detachError = win32Error();
    debug('detach: SetParent(NULL)', { previousParent: hwndLabel(previousParent), immediateLastError: detachError, actualParent: hwndLabel(GetParent(hwnd)), restoredStyle: `0x${nextStyle.toString(16).toUpperCase()}`, styleWriteLastError: styleError });
  }

  const exStyle = getStyle(hwnd, GWL_EXSTYLE);
  const nextExStyle = ((exStyle & (~WS_EX_TOOLWINDOW >>> 0) & (~WS_EX_NOACTIVATE >>> 0) & (~WS_EX_TRANSPARENT >>> 0)) | WS_EX_APPWINDOW) >>> 0;
  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  const exError = win32Error();
  debug('detach: restore exStyle', { nextExStyle: `0x${nextExStyle.toString(16).toUpperCase()}`, immediateLastError: exError });
  SetLastError(0);
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  debug('Electron AFTER detach', { parent: hwndLabel(GetParent(hwnd)), style: `0x${getStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`, exStyle: `0x${getStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`, win32Error: win32Error() });
  debug('detachFromDesktop: END');
}

function setClickThrough(browserWindow, enabled) {
  debug('setClickThrough: BEGIN', { enabled });
  const hwnd = hwndToBigInt(browserWindow.getNativeWindowHandle());
  const exStyle = getStyle(hwnd, GWL_EXSTYLE);
  const nextExStyle = enabled
    ? ((exStyle | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) >>> 0)
    : (((exStyle & (~WS_EX_TRANSPARENT >>> 0) & (~WS_EX_NOACTIVATE >>> 0)) | WS_EX_APPWINDOW) >>> 0);

  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  const styleError = win32Error();
  browserWindow.setIgnoreMouseEvents(enabled);

  // Do not change Z-order here. In raised-desktop mode the parent is Progman
  // and the required order is maintained separately by sendToBottom().
  SetLastError(0);
  const posResult = SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED);
  const posError = win32Error();
  debug('setClickThrough', { enabled, style: `0x${nextExStyle.toString(16).toUpperCase()}`, actual: `0x${getStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`, styleLastError: styleError, setWindowPosResult: posResult, setWindowPosLastError: posError });
}

function sendToBottom(browserWindow) {
  const hwnd = hwndToBigInt(browserWindow.getNativeWindowHandle());
  const parent = GetParent(hwnd);
  if (!isNull(parent)) {
    const progman = FindWindowW('Progman', null);
    const progmanExStyle = isNull(progman) ? 0 : getStyle(progman, GWL_EXSTYLE);
    const raisedDesktop = (progmanExStyle & WS_EX_NOREDIRECTIONBITMAP) !== 0;
    const shellOwner = !isNull(progman) ? findShellViewOwner() : 0n;
    const shellView = !isNull(shellOwner) ? findChildByClass(shellOwner, 0n, 'SHELLDLL_DefView') : 0n;

    if (raisedDesktop && !isNull(progman) && hwndToBigInt(parent) === hwndToBigInt(progman) && !isNull(shellView)) {
      SetLastError(0);
      const result = SetWindowPos(hwnd, shellView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
      const error = win32Error();
      debug('sendToBottom: raised-desktop reinsert after SHELLDLL_DefView', { result, immediateLastError: error, hwnd: hwndLabel(hwnd), parent: hwndLabel(parent), shellView: hwndLabel(shellView) });
      if (!result) throw new Error(`SetWindowPos(raised desktop Z-order) failed. win32Error=${error}`);
      return;
    }
  }

  SetLastError(0);
  const result = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
  const error = win32Error();
  debug('sendToBottom: classic', { result, immediateLastError: error, hwnd: hwndLabel(hwnd) });
  if (!result) throw new Error(`SetWindowPos(bottom) failed. win32Error=${error}`);
}

function isWindowAttached(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  try {
    const hwnd = hwndToBigInt(browserWindow.getNativeWindowHandle());
    const parent = GetParent(hwnd);
    return !isNull(parent) && IsWindow(parent) !== 0;
  } catch (err) {
    debugError('isWindowAttached', err);
    return false;
  }
}

module.exports = { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom, isWindowAttached };
