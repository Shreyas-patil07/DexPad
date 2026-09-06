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

// Win32 handles are pointer-sized integers. Electron exposes its HWND as a
// Buffer containing that value, while Koffi 2.x callback pointers are BigInts.
// Use intptr_t consistently at the FFI boundary so all HWNDs have the same ABI.
const HWND = 'intptr_t';
const DPI_AWARENESS_CONTEXT = 'intptr_t';

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
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int32', [HWND, HWND, 'int32', 'int32', 'int32', 'uint32']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int32', [HWND, 'void *']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', [HWND, 'int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', [HWND, 'uint32', 'uint8', 'uint32']);
const GetWindowDpiAwarenessContext = user32.func('__stdcall', 'GetWindowDpiAwarenessContext', DPI_AWARENESS_CONTEXT, [HWND]);
const GetThreadDpiAwarenessContext = user32.func('__stdcall', 'GetThreadDpiAwarenessContext', DPI_AWARENESS_CONTEXT, []);
const SetThreadDpiAwarenessContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', DPI_AWARENESS_CONTEXT, [DPI_AWARENESS_CONTEXT]);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const SetLastError = kernel32.func('__stdcall', 'SetLastError', 'void', ['uint32']);
const EnumWindowsCallback = koffi.proto('__stdcall', 'EnumWindowsCallback', 'int32', [HWND, 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsCallback), 'intptr_t']);

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
const HWND_BOTTOM = 1n;
const HWND_TOP = 0n;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOOWNERZORDER = 0x0200;
const SW_SHOWNOACTIVATE = 4;
const SMTO_ABORTIFHUNG = 0x0002;

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
  try {
    return Number(GetLastError());
  } catch (_) {
    return -1;
  }
}

function electronHwnd(win) {
  const handle = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    throw new Error('Electron returned an invalid native window handle buffer.');
  }
  const value = hwndToBigInt(handle);
  debug('electronHwnd:', { bytes: handle.length, hwnd: hwndLabel(value) });
  if (value === 0n) throw new Error('Electron returned a null native window handle.');
  return value;
}

function className(hwnd) {
  if (isNull(hwnd)) return '';
  const buffer = Buffer.alloc(256);
  const length = GetClassNameW(hwnd, buffer, 128);
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
}

function findChildByClass(parent, childAfter, wantedClass) {
  return FindWindowExW(parent, childAfter, wantedClass, null);
}

function safeWindowStyle(hwnd, index) {
  try {
    return Number(GetWindowLongPtrW(hwnd, index)) >>> 0;
  } catch (_) {
    return 0;
  }
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
    style: `0x${safeWindowStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`,
    exStyle: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });
}

function spawnWorkerW(progman) {
  const probes = [[0x0D, 0x01], [0x0D, 0x00], [0x00, 0x00]];
  for (const [wParam, lParam] of probes) {
    try {
      const out = Buffer.alloc(8);
      SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_ABORTIFHUNG, 2000, out);
    } catch (err) {
      debugError('spawnWorkerW', err);
    }
  }
}

function findShellViewOwner() {
  let owner = 0n;
  const cb = koffi.register((hwnd) => {
    const shellView = findChildByClass(hwnd, 0n, 'SHELLDLL_DefView');
    if (!isNull(shellView)) {
      owner = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));
  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }
  return owner;
}

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) throw new Error('Progman not found — is Explorer running?');

  inspectWindow('Progman', progman);
  spawnWorkerW(progman);

  const shellViewOwner = findShellViewOwner();
  if (isNull(shellViewOwner)) throw new Error('SHELLDLL_DefView not found.');
  inspectWindow('SHELLDLL_DefView owner', shellViewOwner);
  inspectWindow('SHELLDLL_DefView', findChildByClass(shellViewOwner, 0n, 'SHELLDLL_DefView'));

  const candidates = [];
  const cb = koffi.register((hwnd) => {
    if (className(hwnd) !== 'WorkerW') return 1;
    candidates.push({
      hwnd,
      childShell: findChildByClass(hwnd, 0n, 'SHELLDLL_DefView'),
      parent: GetParent(hwnd),
      style: safeWindowStyle(hwnd, GWL_STYLE),
      exStyle: safeWindowStyle(hwnd, GWL_EXSTYLE)
    });
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }

  const suitable = candidates.find((candidate) => isNull(candidate.childShell));
  if (!suitable) throw new Error(`No suitable WorkerW found. candidates=${candidates.length}`);

  debug('findWorkerW: SELECTED', hwndLabel(suitable.hwnd));
  inspectWindow('Selected WorkerW', suitable.hwnd);
  return suitable.hwnd;
}

function prepareWindow(hwnd) {
  const before = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const next = (before | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  if (!SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)) {
    throw new Error(`SetLayeredWindowAttributes failed. win32Error=${win32Error()}`);
  }
}

function setChildStyle(hwnd) {
  const before = safeWindowStyle(hwnd, GWL_STYLE);
  const next = (before & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
  SetWindowLongPtrW(hwnd, GWL_STYLE, next);
  debug('setChildStyle', {
    hwnd: hwndLabel(hwnd),
    before: `0x${before.toString(16).toUpperCase()}`,
    next: `0x${next.toString(16).toUpperCase()}`,
    actual: `0x${safeWindowStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`
  });
}

function sameHwnd(left, right) {
  return hwndToBigInt(left) === hwndToBigInt(right);
}

function attachWithDpiContext(hwnd, workerW) {
  const workerContext = GetWindowDpiAwarenessContext(workerW);
  const currentContext = GetThreadDpiAwarenessContext();

  debug('attachWithDpiContext: contexts', {
    workerW: hwndLabel(workerW),
    workerContext: hwndLabel(workerContext),
    currentThreadContext: hwndLabel(currentContext)
  });

  let switched = false;
  if (!isNull(workerContext) && !sameHwnd(workerContext, currentContext)) {
    SetLastError(0);
    const previousContext = SetThreadDpiAwarenessContext(workerContext);
    const switchError = win32Error();
    debug('attachWithDpiContext: switched thread context', {
      previous: hwndLabel(previousContext),
      target: hwndLabel(workerContext),
      lastError: switchError
    });
    switched = !isNull(previousContext);
  }

  try {
    SetLastError(0);
    const previousParent = SetParent(hwnd, workerW);
    const setParentError = win32Error();
    const actualParent = GetParent(hwnd);

    debug('attachWithDpiContext: SetParent', {
      previousParent: hwndLabel(previousParent),
      requestedParent: hwndLabel(workerW),
      actualParent: hwndLabel(actualParent),
      actualParentClass: isNull(actualParent) ? '' : className(actualParent),
      win32Error: setParentError
    });

    return {
      previousParent,
      actualParent,
      setParentError
    };
  } finally {
    if (switched) {
      SetThreadDpiAwarenessContext(currentContext);
    }
  }
}

function attachToDesktop(browserWindow, bounds) {
  debug('attachToDesktop: BEGIN', { bounds });
  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Cannot attach a destroyed BrowserWindow.');
  }

  const hwnd = electronHwnd(browserWindow);
  const workerW = findWorkerW();
  if (isNull(workerW) || IsWindow(workerW) === 0) {
    throw new Error(`Selected WorkerW is invalid: ${hwndLabel(workerW)}`);
  }

  const initialRect = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, initialRect)) {
    throw new Error(`GetWindowRect(Electron) failed. win32Error=${win32Error()}`);
  }

  const left = initialRect.readInt32LE(0);
  const top = initialRect.readInt32LE(4);
  const right = initialRect.readInt32LE(8);
  const bottom = initialRect.readInt32LE(12);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) throw new Error('Electron window has invalid native dimensions.');

  prepareWindow(hwnd);
  setChildStyle(hwnd);

  debug('attachToDesktop: BEFORE SetParent', {
    hwnd: hwndLabel(hwnd),
    workerW: hwndLabel(workerW),
    hwndClass: className(hwnd),
    workerClass: className(workerW),
    hwndParent: hwndLabel(GetParent(hwnd)),
  });

  const { actualParent, setParentError } = attachWithDpiContext(hwnd, workerW);

  if (!sameHwnd(actualParent, workerW)) {
    throw new Error(
      `SetParent failed — requested=${hwndLabel(workerW)} actual=${hwndLabel(actualParent)} ` +
      `class=${isNull(actualParent) ? 'NULL' : className(actualParent)} win32Error=${setParentError}`
    );
  }

  const workerRect = Buffer.alloc(16);
  if (!GetWindowRect(workerW, workerRect)) {
    throw new Error(`GetWindowRect(WorkerW) failed. win32Error=${win32Error()}`);
  }

  const workerLeft = workerRect.readInt32LE(0);
  const workerTop = workerRect.readInt32LE(4);
  const targetX = Math.round((bounds?.x || 0) - workerLeft);
  const targetY = Math.round((bounds?.y || 0) - workerTop);
  const posFlags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOOWNERZORDER;

  if (!SetWindowPos(hwnd, HWND_TOP, targetX, targetY, width, height, posFlags)) {
    throw new Error(`SetWindowPos failed while positioning wallpaper panel. win32Error=${win32Error()}`);
  }

  if (!SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)) {
    throw new Error(`SetLayeredWindowAttributes(final) failed. win32Error=${win32Error()}`);
  }

  ShowWindow(hwnd, SW_SHOWNOACTIVATE);

  const finalParent = GetParent(hwnd);
  if (!sameHwnd(finalParent, workerW)) {
    throw new Error(
      `Wallpaper parent changed unexpectedly — expected=${hwndLabel(workerW)} actual=${hwndLabel(finalParent)}`
    );
  }

  inspectWindow('Electron FINAL after attach', hwnd);
  debug('attachToDesktop: SUCCESS');
  return true;
}

function detachFromDesktop(browserWindow) {
  debug('detachFromDesktop: BEGIN');
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const hwnd = electronHwnd(browserWindow);
  const style = safeWindowStyle(hwnd, GWL_STYLE);

  if (style & WS_CHILD) {
    const nextStyle = (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE;
    SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle);
    SetParent(hwnd, 0n);
  }

  const exStyle = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const nextExStyle = (exStyle & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);

  inspectWindow('Electron AFTER detach', hwnd);
  debug('detachFromDesktop: END');
}

function setClickThrough(browserWindow, enabled) {
  debug('setClickThrough: BEGIN', { enabled });
  const hwnd = electronHwnd(browserWindow);
  const exStyle = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const nextExStyle = enabled
    ? exStyle | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
    : (exStyle & ~WS_EX_TRANSPARENT & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW;

  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  browserWindow.setIgnoreMouseEvents(enabled);
  SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  inspectWindow('Electron AFTER click-through', hwnd);
  debug('setClickThrough: END');
}

function sendToBottom(browserWindow) {
  debug('sendToBottom: BEGIN');
  const hwnd = electronHwnd(browserWindow);
  if (!SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING)) {
    throw new Error(`SetWindowPos(bottom) failed. win32Error=${win32Error()}`);
  }
  debug('sendToBottom: END');
}

function isWindowAttached(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  try {
    const hwnd = electronHwnd(browserWindow);
    const parent = GetParent(hwnd);
    return !isNull(parent) && IsWindow(parent) !== 0 && className(parent) === 'WorkerW';
  } catch (err) {
    debugError('isWindowAttached: inspection failed', err);
    return false;
  }
}

module.exports = {
  attachToDesktop,
  detachFromDesktop,
  setClickThrough,
  sendToBottom,
  isWindowAttached
};
