const koffi = require('koffi');

if (process.platform !== 'win32') {
  throw new Error('DexPad desktop wallpaper mode is currently Windows-only.');
}

const user32 = koffi.load('user32.dll');

const FindWindowW = user32.func('__stdcall', 'FindWindowW', 'void *', ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', 'void *', ['void *', 'void *', 'str16', 'str16']);
const SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', [
  'void *', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'void *'
]);
const EnumWindowsCallback = koffi.proto('__stdcall', 'EnumWindowsCallback', 'int32', ['void *', 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsCallback), 'intptr_t']);
const SetParent = user32.func('__stdcall', 'SetParent', 'void *', ['void *', 'void *']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', ['void *', 'int32', 'intptr_t']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['void *', 'int32']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int32', [
  'void *', 'void *', 'int32', 'int32', 'int32', 'int32', 'uint32'
]);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int32', ['void *', 'void *']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', ['void *', 'int32']);
const SetLayeredWindowAttributes = user32.func('__stdcall', 'SetLayeredWindowAttributes', 'int32', [
  'void *', 'uint32', 'uint8', 'uint32'
]);
const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'int32', ['void *']);
const BringWindowToTop = user32.func('__stdcall', 'BringWindowToTop', 'int32', ['void *']);

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
const SW_SHOWNORMAL = 1;
const SW_SHOWNOACTIVATE = 4;
const SMTO_NORMAL = 0;

function bufferToHwnd(buf) {
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

// koffi returns NULL HWNDs as a zero-filled Buffer, not as JS null.
// This helper correctly treats a zero buffer (or number 0) as falsy.
function isNullHwnd(hwnd) {
  if (!hwnd) return true;
  if (typeof hwnd === 'number') return hwnd === 0;
  if (Buffer.isBuffer(hwnd)) {
    for (const byte of hwnd) if (byte !== 0) return false;
    return true;
  }
  return false;
}

function sendSpawnWorkerMessage(progman) {
  // Win11's raised-desktop shell responds to 0x0D/0x01 by creating the
  // wallpaper WorkerW child under Progman. Keep the older variants as fallbacks.
  const variants = [[0xD, 0x1], [0xD, 0x0], [0x0, 0x0]];
  for (const [wParam, lParam] of variants) {
    const result = Buffer.alloc(8);
    try {
      SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_NORMAL, 1000, result);
    } catch {
      // Continue with the next Explorer-compatible variant.
    }
  }
}

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (isNullHwnd(progman)) throw new Error('Progman window not found.');
  sendSpawnWorkerMessage(progman);

  // Windows 11 raised-desktop: the wallpaper WorkerW is a direct child of
  // Progman and is z-ordered underneath SHELLDLL_DefView.
  let directWorker = null;
  let childAfter = null;
  while (true) {
    const next = FindWindowExW(progman, childAfter, 'WorkerW', null);
    if (isNullHwnd(next)) break;
    if (isNullHwnd(FindWindowExW(next, null, 'SHELLDLL_DefView', null))) {
      directWorker = next;
      break;
    }
    childAfter = next;
  }
  if (directWorker) return directWorker;

  // Classic shell layout: locate the top-level window hosting SHELLDLL_DefView
  // and use the following WorkerW sibling.
  let shellViewParent = null;
  const cb = koffi.register((hwnd) => {
    if (!isNullHwnd(FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null))) {
      shellViewParent = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  if (!shellViewParent) {
    throw new Error('SHELLDLL_DefView parent not found.');
  }

  const siblingWorker = FindWindowExW(null, shellViewParent, 'WorkerW', null);
  if (!isNullHwnd(siblingWorker)) return siblingWorker;

  let candidate = null;
  const fallbackCb = koffi.register((hwnd) => {
    if (isNullHwnd(FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null))) {
      candidate = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try {
    EnumWindows(fallbackCb, 0);
  } finally {
    koffi.unregister(fallbackCb);
  }

  if (candidate) return candidate;
  throw new Error('No suitable WorkerW desktop host found.');
}

function prepareNativeWindow(browserWindow) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const nextExStyle =
    (exStyle | WS_EX_TOOLWINDOW | WS_EX_LAYERED) &
    ~WS_EX_APPWINDOW &
    ~WS_EX_NOACTIVATE &
    ~WS_EX_TRANSPARENT;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  return hwnd;
}

function activateWindow(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(
    hwnd,
    GWL_EXSTYLE,
    (exStyle & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW
  );
  ShowWindow(hwnd, SW_SHOWNORMAL);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  browserWindow.focus();
}

function attachToDesktop(browserWindow, bounds) {
  const hwnd = prepareNativeWindow(browserWindow);
  const workerW = findWorkerW();
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  SetWindowLongPtrW(
    hwnd,
    GWL_STYLE,
    (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS
  );

  if (!SetParent(hwnd, workerW)) {
    throw new Error('SetParent failed while attaching DexPad to WorkerW.');
  }

  // WorkerW child coordinates are relative to the Worker's client origin.
  const parentRect = Buffer.alloc(16);
  if (!GetWindowRect(workerW, parentRect)) {
    throw new Error('Failed to query WorkerW screen rectangle.');
  }

  const parentLeft = parentRect.readInt32LE(0);
  const parentTop = parentRect.readInt32LE(4);
  const relativeX = Math.round(bounds.x - parentLeft);
  const relativeY = Math.round(bounds.y - parentTop);

  SetWindowPos(
    hwnd,
    HWND_TOP,
    relativeX,
    relativeY,
    bounds.width,
    bounds.height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW
  );

  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return true;
}

function detachFromDesktop(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  if (style & WS_CHILD) {
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE);
    SetParent(hwnd, null);
  }
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(
    hwnd,
    GWL_EXSTYLE,
    (exStyle & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW
  );
}

function setClickThrough(browserWindow, enabled) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const nextExStyle = enabled
    ? exStyle | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
    : (exStyle & ~WS_EX_TRANSPARENT & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  browserWindow.setIgnoreMouseEvents(enabled);
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
}

function sendToBottom(browserWindow) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  SetWindowPos(
    hwnd,
    HWND_BOTTOM,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING
  );
}

module.exports = {
  attachToDesktop,
  detachFromDesktop,
  setClickThrough,
  sendToBottom,
  activateWindow
};
