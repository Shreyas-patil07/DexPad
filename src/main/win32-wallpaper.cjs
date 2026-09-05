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

function findWorkerW() {
  const progman = FindWindowW('Progman', null);
  if (!progman) throw new Error('Progman window not found.');

  const result = Buffer.alloc(8);
  SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, result);

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

  if (!shellViewParent) throw new Error('SHELLDLL_DefView parent not found.');

  const workerW = FindWindowExW(null, shellViewParent, 'WorkerW', null);
  if (!workerW) throw new Error('Empty WorkerW not found.');
  return workerW;
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
