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
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', ['void *', 'int32']);

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
const HWND_BOTTOM = 1;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSENDCHANGING = 0x0400;
const SWP_SHOWWINDOW = 0x0040;
const SW_SHOWNOACTIVATE = 4;
const SMTO_NORMAL = 0;

function bufferToHwnd(buf) {
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function sendSpawnWorkerMessage(progman) {
  // Explorer has used several variants of the undocumented desktop-worker
  // message across Windows generations. Sending the modern Win11 form first,
  // followed by the classic variants, is harmless when the worker already
  // exists and makes startup resilient to shell-version differences.
  const variants = [
    [0xD, 0x1],
    [0xD, 0x0],
    [0x0, 0x0]
  ];

  for (const [wParam, lParam] of variants) {
    const result = Buffer.alloc(8);
    try {
      SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_NORMAL, 1000, result);
    } catch {
      // Continue with the next shell-compatible variant.
    }
  }
}

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (!progman) throw new Error('Progman window not found.');

  sendSpawnWorkerMessage(progman);

  let shellViewParent = null;
  const cb = koffi.register((hwnd) => {
    const defView = FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null);
    if (defView) {
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
    // Explorer can be between shell-init states during login/resume. In that
    // case, inspect Progman's direct children before giving up.
    const directWorker = FindWindowExW(progman, null, 'WorkerW', null);
    if (directWorker) return directWorker;
    throw new Error('SHELLDLL_DefView parent not found.');
  }

  // Classic Explorer layout: the wallpaper WorkerW is the next top-level
  // WorkerW after the top-level window hosting SHELLDLL_DefView.
  const siblingWorker = FindWindowExW(null, shellViewParent, 'WorkerW', null);
  if (siblingWorker) return siblingWorker;

  // Modern Windows 11 can host WorkerW directly below Progman instead of as a
  // top-level sibling. Prefer an empty WorkerW (one with no DefView child).
  let candidate = null;
  const childCb = koffi.register((hwnd) => {
    const defView = FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null);
    if (!defView) {
      candidate = hwnd;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumWindowsCallback));

  try {
    // First inspect Progman's children because this covers the current Win11
    // shell layout without accidentally selecting unrelated WorkerW windows.
    let childAfter = null;
    while (true) {
      const next = FindWindowExW(progman, childAfter, 'WorkerW', null);
      if (!next) break;
      const defView = FindWindowExW(next, null, 'SHELLDLL_DefView', null);
      if (!defView) {
        candidate = next;
        break;
      }
      childAfter = next;
    }

    if (candidate) return candidate;

    // Final shell-compatible fallback: enumerate top-level WorkerW windows and
    // select one that does not itself host the desktop icon view.
    EnumWindows(childCb, 0);
  } finally {
    koffi.unregister(childCb);
  }

  if (candidate) return candidate;
  throw new Error('No suitable WorkerW desktop host found.');
}

function prepareNativeWindow(browserWindow) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const nextExStyle = (exStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  return hwnd;
}

function attachToDesktop(browserWindow, bounds) {
  const hwnd = prepareNativeWindow(browserWindow);
  const workerW = findWorkerW();
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS);
  SetParent(hwnd, workerW);

  SetWindowPos(
    hwnd,
    null,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW
  );

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
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (exStyle & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW);
}

function setClickThrough(browserWindow, enabled) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const nextExStyle = enabled ? exStyle | WS_EX_TRANSPARENT : exStyle & ~WS_EX_TRANSPARENT;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
}

function sendToBottom(browserWindow) {
  const hwnd = bufferToHwnd(browserWindow.getNativeWindowHandle());
  SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
}

module.exports = {
  attachToDesktop,
  detachFromDesktop,
  setClickThrough,
  sendToBottom
};
