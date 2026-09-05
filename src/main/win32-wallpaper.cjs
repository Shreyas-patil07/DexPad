'use strict';

if (process.platform !== 'win32') {
  throw new Error('DexPad wallpaper mode is Windows-only.');
}

const koffi = require('koffi');

// ─── Win32 API bindings ───────────────────────────────────────────────────────

const user32 = koffi.load('user32.dll');

const FindWindowW       = user32.func('__stdcall', 'FindWindowW',       'void *',   ['str16', 'str16']);
const FindWindowExW     = user32.func('__stdcall', 'FindWindowExW',     'void *',   ['void *', 'void *', 'str16', 'str16']);
const SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', ['void *', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'void *']);
const SetParent         = user32.func('__stdcall', 'SetParent',         'void *',   ['void *', 'void *']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', ['void *', 'int32', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['void *', 'int32']);
const SetWindowPos      = user32.func('__stdcall', 'SetWindowPos',      'int32',    ['void *', 'void *', 'int32', 'int32', 'int32', 'int32', 'uint32']);
const GetWindowRect     = user32.func('__stdcall', 'GetWindowRect',     'int32',    ['void *', 'void *']);
const ShowWindow        = user32.func('__stdcall', 'ShowWindow',        'int32',    ['void *', 'int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', ['void *', 'uint32', 'uint8', 'uint32']);
const BringWindowToTop  = user32.func('__stdcall', 'BringWindowToTop',  'int32',    ['void *']);
const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'int32', ['void *']);

const EnumWindowsCallback = koffi.proto('__stdcall', 'EnumWindowsCallback', 'int32', ['void *', 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsCallback), 'intptr_t']);

// ─── Win32 constants ──────────────────────────────────────────────────────────

const GWL_STYLE         = -16;
const GWL_EXSTYLE       = -20;
const WS_CHILD          = 0x40000000;
const WS_POPUP          = 0x80000000;
const WS_VISIBLE        = 0x10000000;
const WS_CLIPSIBLINGS   = 0x04000000;
const WS_EX_TOOLWINDOW  = 0x00000080;
const WS_EX_NOACTIVATE  = 0x08000000;
const WS_EX_APPWINDOW   = 0x00040000;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED     = 0x00080000;
const LWA_ALPHA         = 0x00000002;
const HWND_BOTTOM       = 1;
const HWND_TOP          = 0;
const SWP_NOMOVE        = 0x0002;
const SWP_NOSIZE        = 0x0001;
const SWP_NOACTIVATE    = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_SHOWWINDOW    = 0x0040;
const SWP_FRAMECHANGED  = 0x0020;
const SW_SHOWNOACTIVATE = 4;
const SW_SHOWNORMAL     = 1;
const SMTO_NORMAL       = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract an HWND value as a JS number from whatever koffi returns. */
function hwndToNum(handle) {
  if (!handle) return 0;
  if (typeof handle === 'number') return handle;
  if (Buffer.isBuffer(handle)) {
    return handle.length >= 8
      ? Number(handle.readBigUInt64LE(0))
      : handle.readUInt32LE(0);
  }
  return 0;
}

/**
 * koffi can return a NULL HWND as JS null OR as a zero-filled Buffer
 * depending on the API and calling convention. This handles both.
 */
function isNull(handle) {
  return hwndToNum(handle) === 0;
}

/** Get a window's HWND number from an Electron BrowserWindow. */
function electronHwnd(win) {
  return hwndToNum(win.getNativeWindowHandle());
}

// ─── WorkerW discovery ────────────────────────────────────────────────────────

/**
 * Send the undocumented 0x052C message to Progman to make Explorer create
 * the WorkerW layer that sits between the wallpaper and the desktop icons.
 * Win11 uses wParam=0x0D, older versions use 0x00.
 */
function spawnWorkerW(progman) {
  for (const [wp, lp] of [[0x0D, 0x01], [0x0D, 0x00], [0x00, 0x00]]) {
    try {
      const res = Buffer.alloc(8);
      SendMessageTimeoutW(progman, 0x052C, wp, lp, SMTO_NORMAL, 1500, res);
    } catch (_) { /* try next variant */ }
  }
}

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) throw new Error('Progman not found — is Explorer running?');

  spawnWorkerW(progman);

  // ── Win11 raised-desktop path ─────────────────────────────────────────────
  // WorkerW is a direct child of Progman (without SHELLDLL_DefView inside it).
  let child = null;
  while (true) {
    const next = FindWindowExW(progman, child, 'WorkerW', null);
    if (isNull(next)) break;
    if (isNull(FindWindowExW(next, null, 'SHELLDLL_DefView', null))) {
      return next; // found: WorkerW without SHELLDLL_DefView
    }
    child = next;
  }

  // ── Classic shell path ────────────────────────────────────────────────────
  // Locate the WorkerW that CONTAINS SHELLDLL_DefView, then find the sibling
  // WorkerW that comes after it in z-order — that is our embedding target.
  let shellParent = null;
  const cb = koffi.register((hwnd) => {
    if (!isNull(FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null))) {
      shellParent = hwnd;
      return 0; // stop enumeration
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }

  if (!shellParent) throw new Error('SHELLDLL_DefView not found.');

  // The correct WorkerW is the next sibling after shellParent in the z-order
  const sibling = FindWindowExW(null, shellParent, 'WorkerW', null);
  if (!isNull(sibling)) return sibling;

  throw new Error('No suitable WorkerW found for desktop embedding.');
}

// ─── Window preparation ───────────────────────────────────────────────────────

function prepareWindow(hwnd) {
  // Set WS_EX_LAYERED so we can control opacity / transparency via Win32 APIs
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(
    hwnd, GWL_EXSTYLE,
    (ex | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT
  );
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a panel-sized BrowserWindow into the desktop WorkerW layer.
 *
 * `bounds` must be in screen (physical pixel) coordinates.
 * Because the window is already the size of the DexPad panel, we just
 * position it at the right edge — no CSS cropping, no full-screen overlay.
 */
function attachToDesktop(browserWindow, bounds) {
  const hwnd    = electronHwnd(browserWindow);
  const workerW = findWorkerW();

  prepareWindow(hwnd);

  // Switch to WS_CHILD so SetParent works correctly
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  SetWindowLongPtrW(hwnd, GWL_STYLE,
    (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS
  );

  if (isNull(SetParent(hwnd, workerW))) {
    throw new Error('SetParent failed — cannot attach to WorkerW.');
  }

  // WorkerW child coordinates are relative to WorkerW's client origin
  const rect = Buffer.alloc(16);
  if (!GetWindowRect(workerW, rect)) throw new Error('GetWindowRect(WorkerW) failed.');

  const wLeft = rect.readInt32LE(0);
  const wTop  = rect.readInt32LE(4);

  SetWindowPos(hwnd, HWND_TOP,
    Math.round(bounds.x - wLeft),
    Math.round(bounds.y - wTop),
    bounds.width, bounds.height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED
  );

  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return true;
}

/**
 * Remove the window from WorkerW and restore it as a normal top-level window.
 */
function detachFromDesktop(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const hwnd  = electronHwnd(browserWindow);
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  if (style & WS_CHILD) {
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE);
    SetParent(hwnd, null);
  }
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
    (ex & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW
  );
}

/**
 * Toggle click-through: when enabled, mouse events pass through the window
 * to the desktop icons underneath.
 */
function setClickThrough(browserWindow, enabled) {
  const hwnd = electronHwnd(browserWindow);
  const ex   = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
    enabled
      ? ex | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
      : (ex & ~WS_EX_TRANSPARENT & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW
  );
  browserWindow.setIgnoreMouseEvents(enabled);
  // Notify Windows that the ex-style changed without moving/resizing
  SetWindowPos(hwnd, null, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED
  );
}

/**
 * Push the window to the bottom of the z-order so desktop icons remain on top.
 */
function sendToBottom(browserWindow) {
  const hwnd = electronHwnd(browserWindow);
  SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING
  );
}

module.exports = { attachToDesktop, detachFromDesktop, setClickThrough, sendToBottom };
