'use strict';

const id = (s) => document.getElementById(s);

async function load() {
  try {
    const state = await window.dexpad.getState();
    id('chk-startup').checked = !!state.startup;
    id('chk-wallpaper').checked = !!state.wallpaperMode;
    setStatus('Ready');
  } catch (err) {
    console.error('[DexPad] Failed to load settings:', err);
    setStatus('Failed to load settings');
  }
}

id('btn-save').addEventListener('click', async () => {
  setStatus('Saving…');
  const button = id('btn-save');
  if (button) button.disabled = true;
  try {
    const startup = !!id('chk-startup').checked;
    const wallpaperMode = !!id('chk-wallpaper').checked;
    await window.dexpad.setStartup(startup);
    const state = await window.dexpad.setWallpaperMode(wallpaperMode);
    // Native wallpaper attachment can fail and intentionally fall back to
    // control mode. Reflect the authoritative main-process state in the UI.
    if (state && typeof state.wallpaperMode === 'boolean') {
      id('chk-wallpaper').checked = state.wallpaperMode;
    }
    setStatus(state?.wallpaperMode === false && wallpaperMode ? 'Wallpaper unavailable' : 'Saved ✓');
    setTimeout(() => setStatus('Ready'), 2000);
  } catch (err) {
    console.error('[DexPad] Failed to save settings:', err);
    setStatus('Failed to save');
  } finally {
    if (button) button.disabled = false;
  }
});

id('btn-open').addEventListener('click', async () => {
  try {
    await window.dexpad.openWorkspace();
  } catch (err) {
    console.error('[DexPad] Failed to open workspace:', err);
  }
});

function setStatus(text) {
  const el = id('status');
  if (el) el.textContent = text;
}

load();
