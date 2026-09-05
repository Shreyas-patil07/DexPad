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
    await window.dexpad.setState({
      startup:      id('chk-startup').checked,
      wallpaperMode: id('chk-wallpaper').checked
    });
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
