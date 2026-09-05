'use strict';

const id = (s) => document.getElementById(s);

async function load() {
  try {
    const state = await window.dexpad.getState();

    id('chk-startup').checked  = state.startup;
    id('chk-wallpaper').checked = state.wallpaperMode;

    setStatus('Ready');
  } catch (err) {
    console.error('[DexPad] Failed to load settings:', err);
    setStatus('Failed to load settings');
  }
}

id('btn-save').addEventListener('click', async () => {
  setStatus('Saving…');
  try {
    const startup = id('chk-startup').checked;
    const wallpaperMode = id('chk-wallpaper').checked;
    await Promise.all([
      window.dexpad.setStartup ? window.dexpad.setStartup(startup) : window.dexpad.setState({ startup }),
      window.dexpad.setWallpaperMode ? window.dexpad.setWallpaperMode(wallpaperMode) : window.dexpad.setState({ wallpaperMode })
    ]);
    setStatus('Saved ✓');
    setTimeout(() => setStatus('Ready'), 2000);
  } catch (err) {
    console.error('[DexPad] Failed to save settings:', err);
    setStatus('Failed to save');
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
