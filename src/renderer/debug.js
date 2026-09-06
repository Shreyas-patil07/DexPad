(() => {
  'use strict';

  const startedAt = performance.now();
  const entries = [];
  const MAX = 1000;
  let overlay = null;
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function safe(value) {
    try {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return `${value}n`;
      if (value === undefined) return '<undefined>';
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return String(value);
    }
  }

  function write(level, event, data) {
    const row = {
      t: Math.round(performance.now() - startedAt),
      level,
      event,
      data: safe(data)
    };
    entries.push(row);
    if (entries.length > MAX) entries.shift();
    const method = level === 'error' ? originalConsole.error : level === 'warn' ? originalConsole.warn : originalConsole.log;
    method(`[DexPad][Diag][+${row.t}ms] ${event}`, row.data);
    refreshOverlay();
  }

  // Capture console output produced by the application itself, including errors caught by init().
  console.error = (...args) => {
    originalConsole.error(...args);
    write('error', 'console.error', args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    write('warn', 'console.warn', args);
  };
  console.log = (...args) => {
    originalConsole.log(...args);
    // Do not duplicate our own diagnostic lines.
    if (typeof args[0] === 'string' && args[0].startsWith('[DexPad][Diag]')) return;
    write('info', 'console.log', args);
  };

  window.DexDebug = {
    log(event, data) { write('info', event, data); },
    warn(event, data) { write('warn', event, data); },
    error(event, data) { write('error', event, data); },
    getEntries() { return entries.slice(); },
    clear() { entries.length = 0; refreshOverlay(); },
    exportText() {
      const text = entries.map(x => JSON.stringify(x)).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dexpad-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    show() { showOverlay(); },
    hide() { hideOverlay(); }
  };

  window.addEventListener('error', event => write('error', 'window.error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error
  }));

  window.addEventListener('unhandledrejection', event => write('error', 'unhandledrejection', event.reason));

  window.addEventListener('load', () => {
    const required = [
      'app','canvas','world','connections','profile-tabs','btn-add','btn-templates','btn-import','btn-export','btn-save',
      'btn-undo','btn-redo','btn-search','btn-command','btn-group-selected','btn-pin-selected','btn-connect',
      'btn-delete-selected','btn-zoom-in','btn-zoom-out','btn-zoom-reset','search-overlay','command-overlay','import-input'
    ];
    const missing = required.filter(id => !document.getElementById(id));
    write(missing.length ? 'error' : 'info', 'dom.selfTest', {
      mode: new URLSearchParams(location.search).get('mode') || 'control',
      missing,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      registry: Array.isArray(window.DexBlockRegistry?.types?.()) ? window.DexBlockRegistry.types() : '<not-loaded>',
      dexpadApi: window.dexpad ? Object.keys(window.dexpad) : null
    });
  }, { once: true });

  // Every exposed IPC function gets a timing/error trace without changing its API.
  function wrapDexpad() {
    if (!window.dexpad || window.dexpad.__dexDebugWrapped) return;
    for (const [name, fn] of Object.entries(window.dexpad)) {
      if (typeof fn !== 'function' || name === 'onStateUpdated') continue;
      window.dexpad[name] = (...args) => {
        const t0 = performance.now();
        write('info', `ipc.${name}.start`, args);
        let result;
        try {
          result = fn(...args);
        } catch (err) {
          write('error', `ipc.${name}.throw`, { args, error: err });
          throw err;
        }
        if (result && typeof result.then === 'function') {
          return result.then(value => {
            write('info', `ipc.${name}.ok`, { ms: Math.round(performance.now() - t0), result: value });
            return value;
          }, err => {
            write('error', `ipc.${name}.reject`, { ms: Math.round(performance.now() - t0), error: err });
            throw err;
          });
        }
        write('info', `ipc.${name}.return`, { ms: Math.round(performance.now() - t0), result });
        return result;
      };
    }
    Object.defineProperty(window.dexpad, '__dexDebugWrapped', { value: true });
    write('info', 'ipc.wrapped', Object.keys(window.dexpad));
  }

  wrapDexpad();

  // Trace meaningful UI targets, but do not log typed text/content.
  document.addEventListener('click', event => {
    const target = event.target?.closest?.('button,[data-add],.profile-tab,.side-item,.card-action,a');
    if (!target) return;
    write('info', 'ui.click', {
      id: target.id || null,
      text: String(target.textContent || '').trim().slice(0, 80),
      addType: target.dataset?.add || null,
      filter: target.dataset?.filter || null,
      cardId: target.closest?.('.card')?.dataset?.id || null
    });
  }, true);

  document.addEventListener('mousedown', event => {
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest('.card-head') || target === document.getElementById('canvas')) {
      write('info', 'ui.mousedown', {
        button: event.button,
        shift: event.shiftKey,
        target: target.closest('.card')?.dataset?.id || target.id || target.tagName
      });
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      showOverlay();
    }
  }, true);

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'dex-debug-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '8px', zIndex: '99999', display: 'none',
      background: 'rgba(5,7,10,.97)', color: '#dce6f2', border: '1px solid rgba(255,255,255,.15)',
      borderRadius: '12px', font: '12px/1.4 Consolas,monospace', overflow: 'hidden',
      boxShadow: '0 24px 100px rgba(0,0,0,.75)'
    });

    const header = document.createElement('div');
    Object.assign(header.style, { height: '46px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', borderBottom: '1px solid rgba(255,255,255,.1)' });
    const title = document.createElement('strong');
    title.textContent = 'DexPad Diagnostics';
    title.style.flex = '1';
    const status = document.createElement('span');
    status.id = 'dex-debug-status';
    status.style.color = '#8da3bb';
    for (const [label, fn] of [['Clear', () => window.DexDebug.clear()], ['Export log', () => window.DexDebug.exportText()], ['Close', hideOverlay]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, { background: '#161c24', color: '#dce6f2', border: '1px solid rgba(255,255,255,.1)', borderRadius: '7px', padding: '6px 9px', cursor: 'pointer' });
      b.onclick = fn;
      header.appendChild(b);
    }
    header.insertBefore(title, header.firstChild);
    header.insertBefore(status, header.children[1]);

    const pre = document.createElement('pre');
    pre.id = 'dex-debug-log';
    Object.assign(pre.style, { margin: 0, padding: '12px', height: 'calc(100% - 46px)', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
    overlay.append(header, pre);
    document.body.appendChild(overlay);
    return overlay;
  }

  function refreshOverlay() {
    if (!overlay || overlay.style.display === 'none') return;
    const pre = overlay.querySelector('#dex-debug-log');
    const status = overlay.querySelector('#dex-debug-status');
    if (pre) pre.textContent = entries.map(e => `[${String(e.t).padStart(5, ' ')}ms] ${e.level.toUpperCase()} ${e.event}\n  ${JSON.stringify(e.data)}`).join('\n');
    if (status) status.textContent = `${entries.length} events`;
    pre?.scrollTo(0, pre.scrollHeight);
  }

  function showOverlay() { ensureOverlay().style.display = 'block'; refreshOverlay(); }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }

  setTimeout(() => write('info', 'debug.ready', { href: location.href }), 0);
})();
