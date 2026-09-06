'use strict';

if (process.platform !== 'win32') {
  throw new Error('DexPad wallpaper mode is Windows-only.');
}

const koffi = require('koffi');

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HDESK = koffi.alias('HDESK', HANDLE);

const user32 = koffi.load('user32.dll');
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
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', ['int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', [HWND, 'uint32', 'uint8', 'uint32']);
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
function isNull(handle) { return hwndToBigInt(handle) === 0n; }
function electronHwnd(win) {
  const handle = win.getNativeWindowHandle();
  if (!handle || !handle.length) throw new Error('Electron returned an empty native window handle.');
  const value = hwndToBigInt(handle);
  if (!value) throw new Error('Electron returned an invalid native window handle.');
  return value;
}
function className(hwnd) {
  const buffer = Buffer.alloc(128);
  const length = GetClassNameW(hwnd, buffer, 64);
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
}
function findChildByClass(parent, childAfter, classNameValue) {
  return FindWindowExW(parent, childAfter, classNameValue, null);
}

function spawnWorkerW(progman) {
  // 0x052C is the Explorer message used by desktop-widget/wallpaper
  // implementations to ask Progman to create the WorkerW desktop layer.
  const probes = [[0x0D, 0x01], [0x0D, 0x00], [0x00, 0x00]];
  for (const [wParam, lParam] of probes) {
    try {
      SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_ABORTIFHUNG, 2000, Buffer.alloc(8));
    } catch (_) {}
  }
}

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) throw new Error('Progman not found — is Explorer running?');

  spawnWorkerW(progman);

  // Canonical discovery:
  // 1. Find the top-level window that owns SHELLDLL_DefView (the desktop view).
  // 2. Find the WorkerW immediately after that shell window.
  // Modern Windows commonly keeps these as sibling top-level windows rather
  // than as a WorkerW directly parented to Progman.
  let shellViewOwner = null;
  const cb = koffi.register((hwnd) => {
    const shellView = findChildByClass(hwnd, null, 'SHELLDLL_DefView');
    if (!isNull(shellView)) {
      shellViewOwner = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  if (isNull(shellViewOwner)) throw new Error('SHELLDLL_DefView not found.');

  let workerW = findChildByClass(null, shellViewOwner, 'WorkerW');
  if (!isNull(workerW)) return workerW;

  // Some Explorer builds produce an extra WorkerW after the shell owner only
  // after the Progman message has settled. Re-enumerate top-level windows as a
  // narrow fallback and select the first WorkerW without SHELLDLL_DefView.
  const candidates = [];
  const cb2 = koffi.register((hwnd) => {
    if (className(hwnd) !== 'WorkerW') return 1;
    if (!isNull(findChildByClass(hwnd, null, 'SHELLDLL_DefView'))) return 1;
    candidates.push(hwnd);
    return 1;
  }, koffi.pointer(EnumWindowsCallback));
  try { EnumWindows(cb2, 0); } finally { koffi.unregister(cb2); }

  workerW = candidates[0] || null;
  if (!isNull(workerW)) return workerW;

  throw new Error('No suitable WorkerW found for desktop embedding.');
}

function prepareWindow(hwnd) {
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW);
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
}

function attachToDesktop(browserWindow, bounds) {
  if (!browserWindow || browserWindow.isDestroyed()) throw new Error('Cannot attach a destroyed BrowserWindow.');
  const hwnd = electronHwnd(browserWindow);
  const workerW = findWorkerW();

  const initialRect = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, initialRect)) throw new Error('GetWindowRect(Electron window) failed.');
  const currentWidth = initialRect.readInt32LE(8) - initialRect.readInt32LE(0);
  const currentHeight = initialRect.readInt32LE(12) - initialRect.readInt32LE(4);
  if (currentWidth <= 0 || currentHeight <= 0) throw new Error('Electron window has invalid native dimensions.');

  prepareWindow(hwnd);
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS);

  SetParent(hwnd, workerW);
  const actualParent = GetParent(hwnd);
  if (isNull(actualParent) || IsWindow(actualParent) === 0 || className(actualParent) !== 'WorkerW') {
    throw new Error('SetParent failed — window is not attached to a WorkerW.');
  }

  const rect = Buffer.alloc(16);
  if (!GetWindowRect(workerW, rect)) throw new Error('GetWindowRect(WorkerW) failed.');
  const wLeft = rect.readInt32LE(0);
  const wTop = rect.readInt32LE(4);

  if (!SetWindowPos(hwnd, HWND_TOP, Math.round(bounds.x - wLeft), Math.round(bounds.y - wTop), currentWidth, currentHeight, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED)) {
    throw new Error('SetWindowPos failed while positioning wallpaper panel.');
  }
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return true;
}

function detachFromDesktop(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const hwnd = electronHwnd(browserWindow);
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  if (style & WS_CHILD) {
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE);
    SetParent(hwnd, null);
  }
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW);
}

function setClickThrough(browserWindow, enabled) {
  const hwnd = electronHwnd(browserWindow);
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, enabled ? ex | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE : (ex & ~WS_EX_TRANSPARENT & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW);
  browserWindow.setIgnoreMouseEvents(enabled);
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}
function sendToBottom(browserWindow) {
  SetWindowPos(electronHwnd(browserWindow), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
}
function isWindowAttached(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  try {
    const hwnd = electronHwnd(browserWindow);
    const parent = GetParent(hwnd);
    return !isNull(parent) && IsWindow(parent) !== 0 && className(parent) === 'WorkerW';
  } catch (_) { return false; }
}

module.exports = { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom, isWindowAttached };
