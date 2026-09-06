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

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HDESK = koffi.alias('HDESK', HANDLE);

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const FindWindowW = user32.func('__stdcall', 'FindWindowW', HWND, ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
const SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', [HWND, 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'void *']);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const GetParent = user32.func('__stdcall', 'GetParent', HWND, [HWND]);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'int32', [HWND]);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int32', [HWND, 'void *', 'int32']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', [HWND, 'int32', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', [HWND, 'int32']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int32', [HWND, HWND, 'int32', 'int32', 'int32', 'int32', 'uint32']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int32', [HWND, 'void *']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', [HWND, 'int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', [HWND, 'uint32', 'uint8', 'uint32']);
const OpenDesktopA = user32.func('__stdcall', 'OpenDesktopA', HDESK, ['str', 'uint32', 'bool', 'uint32']);
const SetThreadDesktop = user32.func('__stdcall', 'SetThreadDesktop', 'bool', [HDESK]);
const CloseDesktop = user32.func('__stdcall', 'CloseDesktop', 'bool', [HDESK]);
const EnumWindowsCallback = koffi.proto('__stdcall', 'EnumWindowsCallback', 'int32', [HWND, 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsCallback), 'intptr_t']);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);

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
const LWA_ALPHA = 0x00000002;
const HWND_BOTTOM = 1;
const HWND_TOP = 0;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;
const SW_SHOWNOACTIVATE = 4;
const SW_HIDE = 0;
const SMTO_ABORTIFHUNG = 0x0002;

function hwndToBigInt(handle) {
  if (handle == null) return 0n;
  if (typeof handle === 'bigint') return handle;
  if (typeof handle === 'number') return BigInt(handle);
  if (Buffer.isBuffer(handle)) return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  try { return BigInt(koffi.address(handle)); } catch (_) { return 0n; }
}

function hwndLabel(handle) {
  const value = hwndToBigInt(handle);
  return value ? `0x${value.toString(16).toUpperCase()}` : 'NULL';
}

function isNull(handle) { return hwndToBigInt(handle) === 0n; }

function win32Error() {
  try { return Number(GetLastError()); } catch (_) { return -1; }
}

function electronHwnd(win) {
  debug('electronHwnd: reading native window handle');
  const handle = win.getNativeWindowHandle();
  debug('electronHwnd: raw handle bytes', handle?.length || 0);
  if (!handle || !handle.length) throw new Error('Electron returned an empty native window handle.');
  const value = hwndToBigInt(handle);
  debug('electronHwnd: resolved', hwndLabel(value));
  if (!value) throw new Error('Electron returned an invalid native window handle.');
  return value;
}

function className(hwnd) {
  if (isNull(hwnd)) return '';
  const buffer = Buffer.alloc(256);
  const length = GetClassNameW(hwnd, buffer, 128);
  const result = length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
  debug('className:', hwndLabel(hwnd), '=>', JSON.stringify(result), 'lastError=', win32Error());
  return result;
}

function findChildByClass(parent, childAfter, classNameValue) {
  const result = FindWindowExW(parent, childAfter, classNameValue, null);
  debug('FindWindowExW:', `parent=${hwndLabel(parent)}`, `after=${hwndLabel(childAfter)}`, `class=${classNameValue}`, `=> ${hwndLabel(result)}`);
  return result;
}

function safeWindowStyle(hwnd, index) {
  try {
    const value = Number(GetWindowLongPtrW(hwnd, index));
    return value >>> 0;
  } catch (_) {
    return 0;
  }
}

function inspectWindow(label, hwnd) {
  if (isNull(hwnd)) {
    debug(label, 'HWND=NULL');
    return;
  }
  const parent = GetParent(hwnd);
  debug(label, {
    hwnd: hwndLabel(hwnd),
    class: className(hwnd),
    parent: hwndLabel(parent),
    parentClass: isNull(parent) ? '' : className(parent),
    isWindow: IsWindow(hwnd),
    style: `0x${safeWindowStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`,
    exStyle: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });
}

function spawnWorkerW(progman) {
  debug('spawnWorkerW: BEGIN', hwndLabel(progman));
  const probes = [[0x0D, 0x01], [0x0D, 0x00], [0x00, 0x00]];
  for (const [wParam, lParam] of probes) {
    const out = Buffer.alloc(8);
    try {
      const result = SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_ABORTIFHUNG, 2000, out);
      debug('spawnWorkerW: SendMessageTimeoutW', {
        wParam: `0x${wParam.toString(16)}`,
        lParam: `0x${lParam.toString(16)}`,
        result,
        lastError: win32Error(),
        out: out.toString('hex')
      });
    } catch (err) {
      debugError('spawnWorkerW: SendMessageTimeoutW threw', err);
    }
  }
  debug('spawnWorkerW: END');
}

function enumerateTopLevelWindows(reason) {
  debug(`enumerateTopLevelWindows: BEGIN (${reason})`);
  const windows = [];
  const cb = koffi.register((hwnd) => {
    const cls = className(hwnd);
    const parent = GetParent(hwnd);
    if (cls === 'WorkerW' || cls === 'Progman' || cls === 'SHELLDLL_DefView' || cls === 'WorkerW') {
      windows.push({ hwnd, className: cls, parent: hwndLabel(parent) });
      debug('TOPLEVEL candidate:', { hwnd: hwndLabel(hwnd), className: cls, parent: hwndLabel(parent) });
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));
  let result = 0;
  try { result = EnumWindows(cb, 0); }
  finally { koffi.unregister(cb); }
  debug(`enumerateTopLevelWindows: END result=${result}, matching=${windows.length}`);
  return windows;
}

function findShellViewOwner() {
  debug('findShellViewOwner: BEGIN');
  let owner = null;
  const cb = koffi.register((hwnd) => {
    const cls = className(hwnd);
    const shellView = findChildByClass(hwnd, null, 'SHELLDLL_DefView');
    debug('EnumWindows:', { hwnd: hwndLabel(hwnd), className: cls, shellView: hwndLabel(shellView) });
    if (!isNull(shellView)) {
      owner = hwnd;
      debug('findShellViewOwner: FOUND owner', hwndLabel(owner), 'class=', cls, 'shellView=', hwndLabel(shellView));
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));
  let result = 0;
  try { result = EnumWindows(cb, 0); }
  finally { koffi.unregister(cb); }
  debug('findShellViewOwner: END', { enumResult: result, owner: hwndLabel(owner) });
  return owner;
}

function findWorkerW() {
  debug('============================================================');
  debug('findWorkerW: BEGIN');

  let progman = FindWindowW('Progman', null);
  debug('FindWindowW(Progman):', hwndLabel(progman), 'lastError=', win32Error());
  inspectWindow('Progman', progman);

  if (isNull(progman)) throw new Error('Progman not found — is Explorer running?');

  spawnWorkerW(progman);
  debug('findWorkerW: hierarchy immediately after spawn');
  enumerateTopLevelWindows('after spawn');

  const shellViewOwner = findShellViewOwner();
  if (isNull(shellViewOwner)) {
    debug('findWorkerW: no SHELLDLL_DefView owner');
    throw new Error('SHELLDLL_DefView not found.');
  }
  inspectWindow('SHELLDLL_DefView owner', shellViewOwner);

  const shellView = findChildByClass(shellViewOwner, null, 'SHELLDLL_DefView');
  debug('findWorkerW: shell view child=', hwndLabel(shellView));
  inspectWindow('SHELLDLL_DefView', shellView);

  const candidates = [];
  const cb = koffi.register((hwnd) => {
    const cls = className(hwnd);
    if (cls !== 'WorkerW') return 1;

    const childShell = findChildByClass(hwnd, null, 'SHELLDLL_DefView');
    const parent = GetParent(hwnd);
    const entry = {
      hwnd,
      hwndText: hwndLabel(hwnd),
      parent: hwndLabel(parent),
      parentClass: isNull(parent) ? '' : className(parent),
      childShell: hwndLabel(childShell),
      style: safeWindowStyle(hwnd, GWL_STYLE),
      exStyle: safeWindowStyle(hwnd, GWL_EXSTYLE)
    };
    candidates.push(entry);
    debug('WorkerW candidate:', entry);
    return 1;
  }, koffi.pointer(EnumWindowsCallback));
  try { EnumWindows(cb, 0); }
  finally { koffi.unregister(cb); }

  debug('findWorkerW: total WorkerW candidates=', candidates.length);

  const suitable = candidates.find(x => isNull(x.childShell));
  if (suitable) {
    debug('findWorkerW: SELECTED WorkerW', suitable.hwndText);
    inspectWindow('SELECTED WorkerW', suitable.hwnd);
    debug('findWorkerW: END success');
    debug('============================================================');
    return suitable.hwnd;
  }

  debug('findWorkerW: no WorkerW without SHELLDLL_DefView found');
  debug('findWorkerW: full candidates=', candidates.map(x => ({
    hwnd: x.hwndText,
    parent: x.parent,
    parentClass: x.parentClass,
    childShell: x.childShell,
    style: `0x${x.style.toString(16).toUpperCase()}`,
    exStyle: `0x${x.exStyle.toString(16).toUpperCase()}`
  })));

  throw new Error('No suitable WorkerW found for desktop embedding.');
}

function prepareWindow(hwnd) {
  debug('prepareWindow: BEGIN', hwndLabel(hwnd));
  const before = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const next = (before | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW;
  debug('prepareWindow: exStyle', {
    before: `0x${before.toString(16).toUpperCase()}`,
    next: `0x${next.toString(16).toUpperCase()}`
  });
  const previous = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  const errAfterStyle = win32Error();
  debug('prepareWindow: SetWindowLongPtrW', {
    previous: `0x${Number(previous).toString(16).toUpperCase()}`,
    lastError: errAfterStyle,
    actual: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });
  const layered = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  const errAfterLayered = win32Error();
  debug('prepareWindow: SetLayeredWindowAttributes', { result: layered, lastError: errAfterLayered });
  debug('prepareWindow: END');
}

function attachToDesktop(browserWindow, bounds) {
  debug('################################################################');
  debug('attachToDesktop: BEGIN', {
    bounds,
    windowDestroyed: browserWindow?.isDestroyed?.(),
  });

  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Cannot attach a destroyed BrowserWindow.');
  }

  const hwnd = electronHwnd(browserWindow);
  debug('attachToDesktop: Electron HWND=', hwndLabel(hwnd));
  inspectWindow('Electron BEFORE attach', hwnd);

  let workerW;
  try {
    workerW = findWorkerW();
  } catch (err) {
    debugError('attachToDesktop: findWorkerW failed', err);
    throw err;
  }

  debug('attachToDesktop: selected WorkerW=', hwndLabel(workerW));
  inspectWindow('WorkerW BEFORE SetParent', workerW);

  const initialRect = Buffer.alloc(16);
  const rectResult = GetWindowRect(hwnd, initialRect);
  const rectError = win32Error();
  debug('attachToDesktop: GetWindowRect(Electron)', { result: rectResult, lastError: rectError });
  if (!rectResult) throw new Error('GetWindowRect(Electron window) failed.');

  const currentLeft = initialRect.readInt32LE(0);
  const currentTop = initialRect.readInt32LE(4);
  const currentRight = initialRect.readInt32LE(8);
  const currentBottom = initialRect.readInt32LE(12);
  const currentWidth = currentRight - currentLeft;
  const currentHeight = currentBottom - currentTop;
  debug('attachToDesktop: Electron native RECT=', {
    left: currentLeft,
    top: currentTop,
    right: currentRight,
    bottom: currentBottom,
    width: currentWidth,
    height: currentHeight
  });
  if (currentWidth <= 0 || currentHeight <= 0) throw new Error('Electron window has invalid native dimensions.');

  prepareWindow(hwnd);

  const styleBefore = safeWindowStyle(hwnd, GWL_STYLE);
  const styleNext = (styleBefore & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
  debug('attachToDesktop: changing style', {
    before: `0x${styleBefore.toString(16).toUpperCase()}`,
    next: `0x${styleNext.toString(16).toUpperCase()}`
  });
  const oldStyle = SetWindowLongPtrW(hwnd, GWL_STYLE, styleNext);
  const styleError = win32Error();
  debug('attachToDesktop: SetWindowLongPtrW(STYLE)', {
    oldStyle: `0x${Number(oldStyle).toString(16).toUpperCase()}`,
    lastError: styleError,
    actual: `0x${safeWindowStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`
  });

  debug('attachToDesktop: BEFORE SetParent');
  inspectWindow('Electron RIGHT BEFORE SetParent', hwnd);

  let previousParent = null;
  try {
    previousParent = SetParent(hwnd, workerW);
  } catch (err) {
    debugError('attachToDesktop: SetParent THREW', err);
    throw err;
  }
  const setParentError = win32Error();
  debug('attachToDesktop: SetParent returned', {
    previousParent: hwndLabel(previousParent),
    requestedParent: hwndLabel(workerW),
    lastError: setParentError
  });

  const actualParent = GetParent(hwnd);
  const parentError = win32Error();
  const actualParentClass = isNull(actualParent) ? '' : className(actualParent);
  debug('attachToDesktop: AFTER SetParent', {
    requestedParent: hwndLabel(workerW),
    actualParent: hwndLabel(actualParent),
    actualParentClass,
    parentIsWindow: IsWindow(actualParent),
    lastError: parentError
  });
  inspectWindow('Electron AFTER SetParent', hwnd);

  if (isNull(actualParent) || IsWindow(actualParent) === 0 || actualParentClass !== 'WorkerW') {
    debug('attachToDesktop: ATTACH VERIFICATION FAILED', {
      requestedParent: hwndLabel(workerW),
      actualParent: hwndLabel(actualParent),
      actualParentClass,
      setParentError
    });
    debug('attachToDesktop: re-enumerating hierarchy after failed SetParent');
    enumerateTopLevelWindows('after failed SetParent');
    throw new Error(`SetParent failed — requested=${hwndLabel(workerW)} actual=${hwndLabel(actualParent)} class=${actualParentClass || 'NULL'} win32Error=${setParentError}`);
  }

  const workerRect = Buffer.alloc(16);
  const workerRectResult = GetWindowRect(workerW, workerRect);
  const workerRectError = win32Error();
  debug('attachToDesktop: GetWindowRect(WorkerW)', { result: workerRectResult, lastError: workerRectError });
  if (!workerRectResult) throw new Error('GetWindowRect(WorkerW) failed.');

  const wLeft = workerRect.readInt32LE(0);
  const wTop = workerRect.readInt32LE(4);
  const wRight = workerRect.readInt32LE(8);
  const wBottom = workerRect.readInt32LE(12);
  debug('attachToDesktop: WorkerW RECT=', { left: wLeft, top: wTop, right: wRight, bottom: wBottom, width: wRight - wLeft, height: wBottom - wTop });

  const targetX = Math.round(bounds.x - wLeft);
  const targetY = Math.round(bounds.y - wTop);
  debug('attachToDesktop: SetWindowPos target=', { targetX, targetY, width: currentWidth, height: currentHeight, bounds });

  const posFlags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED;
  const posResult = SetWindowPos(hwnd, HWND_TOP, targetX, targetY, currentWidth, currentHeight, posFlags);
  const posError = win32Error();
  debug('attachToDesktop: SetWindowPos', { result: posResult, lastError: posError, flags: `0x${posFlags.toString(16)}` });
  if (!posResult) throw new Error(`SetWindowPos failed while positioning wallpaper panel. win32Error=${posError}`);

  const layeredAgain = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  const layeredError = win32Error();
  debug('attachToDesktop: SetLayeredWindowAttributes(final)', { result: layeredAgain, lastError: layeredError });

  const showResult = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  const showError = win32Error();
  debug('attachToDesktop: ShowWindow', { result: showResult, lastError: showError, command: SW_SHOWNOACTIVATE });

  inspectWindow('Electron FINAL after attach', hwnd);
  debug('attachToDesktop: SUCCESS');
  debug('################################################################');
  return true;
}

function detachFromDesktop(browserWindow) {
  debug('detachFromDesktop: BEGIN');
  if (!browserWindow || browserWindow.isDestroyed()) {
    debug('detachFromDesktop: nothing to do');
    return;
  }
  const hwnd = electronHwnd(browserWindow);
  inspectWindow('Electron BEFORE detach', hwnd);

  const style = safeWindowStyle(hwnd, GWL_STYLE);
  debug('detachFromDesktop: style=', `0x${style.toString(16).toUpperCase()}`);
  if (style & WS_CHILD) {
    const nextStyle = (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE;
    const previous = SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle);
    const styleError = win32Error();
    debug('detachFromDesktop: restore style', { previous: `0x${Number(previous).toString(16).toUpperCase()}`, next: `0x${nextStyle.toString(16).toUpperCase()}`, lastError: styleError });

    const previousParent = SetParent(hwnd, null);
    const parentError = win32Error();
    debug('detachFromDesktop: SetParent(NULL)', { previousParent: hwndLabel(previousParent), lastError: parentError });
  }

  const ex = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const nextEx = (ex & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW;
  const previousEx = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextEx);
  const exError = win32Error();
  debug('detachFromDesktop: restore exStyle', { previous: `0x${Number(previousEx).toString(16).toUpperCase()}`, next: `0x${nextEx.toString(16).toUpperCase()}`, lastError: exError });
  inspectWindow('Electron AFTER detach', hwnd);
  debug('detachFromDesktop: END');
}

function setClickThrough(browserWindow, enabled) {
  debug('setClickThrough: BEGIN', { enabled });
  const hwnd = electronHwnd(browserWindow);
  const ex = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const nextEx = enabled
    ? ex | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
    : (ex & ~WS_EX_TRANSPARENT & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW;
  debug('setClickThrough: exStyle', {
    before: `0x${ex.toString(16).toUpperCase()}`,
    next: `0x${nextEx.toString(16).toUpperCase()}`
  });

  const previous = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextEx);
  const styleError = win32Error();
  debug('setClickThrough: SetWindowLongPtrW', { previous: `0x${Number(previous).toString(16).toUpperCase()}`, lastError: styleError, actual: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}` });

  browserWindow.setIgnoreMouseEvents(enabled);
  debug('setClickThrough: BrowserWindow.setIgnoreMouseEvents complete');

  const result = SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  const posError = win32Error();
  debug('setClickThrough: SetWindowPos(FRAMECHANGED)', { result, lastError: posError });
  inspectWindow('Electron AFTER click-through', hwnd);
  debug('setClickThrough: END');
}

function sendToBottom(browserWindow) {
  debug('sendToBottom: BEGIN');
  const hwnd = electronHwnd(browserWindow);
  const result = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
  const error = win32Error();
  debug('sendToBottom: SetWindowPos', { hwnd: hwndLabel(hwnd), result, lastError: error });
  inspectWindow('Electron AFTER sendToBottom', hwnd);
  debug('sendToBottom: END');
}

function isWindowAttached(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    debug('isWindowAttached: false (window missing/destroyed)');
    return false;
  }
  try {
    const hwnd = electronHwnd(browserWindow);
    const parent = GetParent(hwnd);
    const attached = !isNull(parent) && IsWindow(parent) !== 0 && className(parent) === 'WorkerW';
    debug('isWindowAttached:', { hwnd: hwndLabel(hwnd), parent: hwndLabel(parent), parentClass: isNull(parent) ? '' : className(parent), attached });
    return attached;
  } catch (err) {
    debugError('isWindowAttached: inspection failed', err);
    return false;
  }
}

module.exports = { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom, isWindowAttached };
