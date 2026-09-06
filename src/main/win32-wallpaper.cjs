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

// Keep every HWND/context at the FFI boundary as a pointer-sized integer.
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
const GetAwarenessFromDpiAwarenessContext = user32.func('__stdcall', 'GetAwarenessFromDpiAwarenessContext', 'int32', [DPI_AWARENESS_CONTEXT]);
const GetDpiForWindow = user32.func('__stdcall', 'GetDpiForWindow', 'uint32', [HWND]);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [HWND, 'void *']);
const GetCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', []);
const GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const SetLastError = kernel32.func('__stdcall', 'SetLastError', 'void', ['uint32']);

// Register the EnumWindows callback prototype once at module scope to prevent Koffi duplicate type registration errors across retries
const EnumWindowsProc = koffi.proto('__stdcall', 'EnumWindowsProc', 'int32', [HWND, 'intptr_t']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsProc), 'intptr_t']);

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

function inspectDpi(label, hwnd) {
  if (isNull(hwnd)) {
    debug(`${label}: DPI`, { hwnd: 'NULL' });
    return;
  }

  try {
    const context = GetWindowDpiAwarenessContext(hwnd);
    const awareness = GetAwarenessFromDpiAwarenessContext(context);
    const dpi = GetDpiForWindow(hwnd);
    let pid = 0;
    const pidBuffer = Buffer.alloc(4);
    const tid = GetWindowThreadProcessId(hwnd, pidBuffer);
    pid = pidBuffer.readUInt32LE(0);

    debug(`${label}: DPI`, {
      hwnd: hwndLabel(hwnd),
      dpi,
      dpiAwarenessContext: hwndLabel(context),
      dpiAwareness: awareness,
      threadId: tid,
      processId: pid
    });
  } catch (err) {
    debugError(`${label}: DPI inspection failed`, err);
  }
}

function inspectProcessContext(label) {
  try {
    const context = GetThreadDpiAwarenessContext();
    const awareness = GetAwarenessFromDpiAwarenessContext(context);
    debug(`${label}: thread DPI`, {
      processId: Number(GetCurrentProcessId()),
      threadId: Number(GetCurrentThreadId()),
      context: hwndLabel(context),
      awareness
    });
  } catch (err) {
    debugError(`${label}: thread DPI inspection failed`, err);
  }
}

function inspectWindow(label, hwnd) {
  if (isNull(hwnd)) {
    debug(label, { hwnd: 'NULL' });
    return;
  }
  const parent = GetParent(hwnd);
  const parentClass = isNull(parent) ? '' : className(parent);
  debug(label, {
    hwnd: hwndLabel(hwnd),
    class: className(hwnd),
    parent: hwndLabel(parent),
    parentClass,
    isWindow: IsWindow(hwnd),
    style: `0x${safeWindowStyle(hwnd, GWL_STYLE).toString(16).toUpperCase()}`,
    exStyle: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });
  inspectDpi(label, hwnd);
}

function spawnWorkerW(progman) {
  const probes = [[0x0D, 0x01], [0x0D, 0x00], [0x00, 0x00]];
  for (const [wParam, lParam] of probes) {
    try {
      const out = Buffer.alloc(8);
      SetLastError(0);
      const result = SendMessageTimeoutW(progman, 0x052C, wParam, lParam, SMTO_ABORTIFHUNG, 2000, out);
      const error = win32Error();
      debug('spawnWorkerW: probe', {
        wParam: `0x${wParam.toString(16)}`,
        lParam: `0x${lParam.toString(16)}`,
        result,
        lastErrorImmediatelyAfterCall: error,
        out: out.toString('hex')
      });
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
  }, koffi.pointer(EnumWindowsProc));
  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }
  return owner;
}

function findWorkerW() {
  debug('findWorkerW: BEGIN');

  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) throw new Error('Progman not found — is Explorer running?');

  inspectWindow('Progman', progman);
  spawnWorkerW(progman);

  const shellViewOwner = findShellViewOwner();
  if (isNull(shellViewOwner)) throw new Error('SHELLDLL_DefView not found.');

  inspectWindow('SHELLDLL_DefView owner', shellViewOwner);
  const shellView = findChildByClass(shellViewOwner, 0n, 'SHELLDLL_DefView');
  inspectWindow('SHELLDLL_DefView', shellView);

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
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }

  debug('findWorkerW: candidates', candidates.map((candidate) => ({
    hwnd: hwndLabel(candidate.hwnd),
    parent: hwndLabel(candidate.parent),
    childShell: hwndLabel(candidate.childShell),
    style: `0x${candidate.style.toString(16).toUpperCase()}`,
    exStyle: `0x${candidate.exStyle.toString(16).toUpperCase()}`
  })));

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

function trySetParent(hwnd, workerW) {
  inspectProcessContext('BEFORE SetParent');
  inspectDpi('Electron BEFORE SetParent', hwnd);
  inspectDpi('WorkerW BEFORE SetParent', workerW);

  const beforeParent = GetParent(hwnd);
  const beforeStyle = safeWindowStyle(hwnd, GWL_STYLE);
  const beforeExStyle = safeWindowStyle(hwnd, GWL_EXSTYLE);

  // SetLastError must happen immediately before the API call, and GetLastError
  // must happen immediately after it. Any GetParent/class lookup can overwrite it.
  SetLastError(0);
  let previousParent;
  try {
    previousParent = SetParent(hwnd, workerW);
  } catch (err) {
    debugError('SetParent native invocation threw', err);
    return {
      threw: true,
      error: err,
      beforeParent,
      previousParent: null,
      actualParent: GetParent(hwnd)
    };
  }
  const immediateLastError = win32Error();

  // Only now is it safe to perform additional inspection calls.
  const actualParent = GetParent(hwnd);
  const actualParentClass = isNull(actualParent) ? '' : className(actualParent);
  const afterStyle = safeWindowStyle(hwnd, GWL_STYLE);
  const afterExStyle = safeWindowStyle(hwnd, GWL_EXSTYLE);

  debug('SET_PARENT_EXACT_RESULT', {
    child: hwndLabel(hwnd),
    requestedParent: hwndLabel(workerW),
    previousParent: hwndLabel(previousParent),
    actualParent: hwndLabel(actualParent),
    actualParentClass,
    immediateLastError,
    previousParentWasNull: isNull(previousParent),
    actualParentMatchesRequested: sameHwnd(actualParent, workerW),
    childWasValidBefore: IsWindow(hwnd) !== 0,
    parentWasValidBefore: IsWindow(workerW) !== 0,
    childStyleBefore: `0x${beforeStyle.toString(16).toUpperCase()}`,
    childStyleAfter: `0x${afterStyle.toString(16).toUpperCase()}`,
    childExStyleBefore: `0x${beforeExStyle.toString(16).toUpperCase()}`,
    childExStyleAfter: `0x${afterExStyle.toString(16).toUpperCase()}`
  });

  return {
    threw: false,
    previousParent,
    actualParent,
    actualParentClass,
    immediateLastError,
    beforeParent,
    beforeStyle,
    beforeExStyle,
    afterStyle,
    afterExStyle
  };
}

function attachToDesktop(browserWindow, bounds) {
  debug('============================================================');
  debug('attachToDesktop: BEGIN', { bounds });

  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Cannot attach a destroyed BrowserWindow.');
  }

  const hwnd = electronHwnd(browserWindow);
  inspectWindow('Electron BEFORE attach', hwnd);

  const workerW = findWorkerW();
  if (isNull(workerW) || IsWindow(workerW) === 0) {
    throw new Error(`Selected WorkerW is invalid: ${hwndLabel(workerW)}`);
  }

  const initialRect = Buffer.alloc(16);
  SetLastError(0);
  if (!GetWindowRect(hwnd, initialRect)) {
    throw new Error(`GetWindowRect(Electron) failed. win32Error=${win32Error()}`);
  }

  const left = initialRect.readInt32LE(0);
  const top = initialRect.readInt32LE(4);
  const right = initialRect.readInt32LE(8);
  const bottom = initialRect.readInt32LE(12);
  const width = right - left;
  const height = bottom - top;

  debug('Electron initial RECT', { left, top, right, bottom, width, height });
  inspectProcessContext('BEFORE prepareWindow');

  if (width <= 0 || height <= 0) {
    throw new Error('Electron window has invalid native dimensions.');
  }

  prepareWindow(hwnd);
  setChildStyle(hwnd);

  const setParentResult = trySetParent(hwnd, workerW);

  if (setParentResult.threw) {
    throw setParentResult.error;
  }

  if (!sameHwnd(setParentResult.actualParent, workerW)) {
    debug('ATTACH VERIFICATION FAILED', {
      requestedParent: hwndLabel(workerW),
      actualParent: hwndLabel(setParentResult.actualParent),
      actualParentClass: setParentResult.actualParentClass,
      immediateSetParentLastError: setParentResult.immediateLastError
    });
    throw new Error(
      `SetParent failed — requested=${hwndLabel(workerW)} actual=${hwndLabel(setParentResult.actualParent)} ` +
      `class=${setParentResult.actualParentClass || 'NULL'} immediateWin32Error=${setParentResult.immediateLastError}`
    );
  }

  const workerRect = Buffer.alloc(16);
  SetLastError(0);
  if (!GetWindowRect(workerW, workerRect)) {
    throw new Error(`GetWindowRect(WorkerW) failed. win32Error=${win32Error()}`);
  }

  const workerLeft = workerRect.readInt32LE(0);
  const workerTop = workerRect.readInt32LE(4);
  const targetX = Math.round((bounds?.x || 0) - workerLeft);
  const targetY = Math.round((bounds?.y || 0) - workerTop);

  const posFlags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOOWNERZORDER;
  SetLastError(0);
  const posResult = SetWindowPos(hwnd, HWND_TOP, targetX, targetY, width, height, posFlags);
  const posError = win32Error();
  debug('SetWindowPos exact result', {
    result: posResult,
    immediateLastError: posError,
    targetX,
    targetY,
    width,
    height
  });
  if (!posResult) {
    throw new Error(`SetWindowPos failed while positioning wallpaper panel. win32Error=${posError}`);
  }

  SetLastError(0);
  const layeredResult = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  const layeredError = win32Error();
  debug('SetLayeredWindowAttributes exact result', {
    result: layeredResult,
    immediateLastError: layeredError
  });
  if (!layeredResult) {
    throw new Error(`SetLayeredWindowAttributes(final) failed. win32Error=${layeredError}`);
  }

  SetLastError(0);
  const showResult = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  const showError = win32Error();
  debug('ShowWindow exact result', {
    result: showResult,
    immediateLastError: showError
  });

  const finalParent = GetParent(hwnd);
  inspectProcessContext('FINAL');
  inspectWindow('Electron FINAL after attach', hwnd);

  if (!sameHwnd(finalParent, workerW)) {
    throw new Error(
      `Wallpaper parent changed unexpectedly — expected=${hwndLabel(workerW)} actual=${hwndLabel(finalParent)}`
    );
  }

  debug('attachToDesktop: SUCCESS');
  debug('============================================================');
  return true;
}

function detachFromDesktop(browserWindow) {
  debug('detachFromDesktop: BEGIN');
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const hwnd = electronHwnd(browserWindow);
  inspectWindow('Electron BEFORE detach', hwnd);

  const style = safeWindowStyle(hwnd, GWL_STYLE);
  if (style & WS_CHILD) {
    const nextStyle = (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE;
    SetLastError(0);
    SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle);
    const styleError = win32Error();
    debug('detach: restore style', { nextStyle: `0x${nextStyle.toString(16).toUpperCase()}`, immediateLastError: styleError });

    SetLastError(0);
    const previousParent = SetParent(hwnd, 0n);
    const detachError = win32Error();
    debug('detach: SetParent(NULL) exact result', {
      previousParent: hwndLabel(previousParent),
      immediateLastError: detachError,
      actualParent: hwndLabel(GetParent(hwnd))
    });
  }

  const exStyle = safeWindowStyle(hwnd, GWL_EXSTYLE);
  const nextExStyle = (exStyle & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE & ~WS_EX_TRANSPARENT) | WS_EX_APPWINDOW;
  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  const exError = win32Error();
  debug('detach: restore exStyle', { nextExStyle: `0x${nextExStyle.toString(16).toUpperCase()}`, immediateLastError: exError });

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

  SetLastError(0);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, nextExStyle);
  const styleError = win32Error();
  debug('setClickThrough: SetWindowLongPtrW exact result', {
    enabled,
    immediateLastError: styleError,
    actual: `0x${safeWindowStyle(hwnd, GWL_EXSTYLE).toString(16).toUpperCase()}`
  });

  browserWindow.setIgnoreMouseEvents(enabled);
  SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  inspectWindow('Electron AFTER click-through', hwnd);
  debug('setClickThrough: END');
}

function sendToBottom(browserWindow) {
  debug('sendToBottom: BEGIN');
  const hwnd = electronHwnd(browserWindow);
  SetLastError(0);
  const result = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
  const error = win32Error();
  debug('sendToBottom: SetWindowPos exact result', { result, immediateLastError: error });
  if (!result) throw new Error(`SetWindowPos(bottom) failed. win32Error=${error}`);
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
