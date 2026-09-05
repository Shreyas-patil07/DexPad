const $ = (id) => document.getElementById(id);

async function load() {
  try {
    const state = await window.dexpad.getState();
    const startupEl = $('startup');
    const wallpaperEl = $('wallpaper');
    startupEl.checked = state.startup;
    wallpaperEl.checked = state.wallpaperMode;
    // Keep aria-checked in sync for screen readers
    startupEl.setAttribute('aria-checked', String(state.startup));
    wallpaperEl.setAttribute('aria-checked', String(state.wallpaperMode));
    $('status').textContent = 'Ready';
  } catch (err) {
    console.error('[DexPad] Failed to load settings:', err);
    $('status').textContent = 'Failed to load settings';
  }
}

// Keep aria-checked in sync as the user toggles checkboxes
for (const id of ['startup', 'wallpaper']) {
  $(id)?.addEventListener('change', (e) => {
    e.target.setAttribute('aria-checked', String(e.target.checked));
  });
}

$('save').addEventListener('click', async () => {
  $('status').textContent = 'Saving…';
  try {
    await window.dexpad.setState({
      startup: $('startup').checked,
      wallpaperMode: $('wallpaper').checked
    });
    $('status').textContent = 'Saved ✓';
    // Clear confirmation text after 2 seconds
    setTimeout(() => { $('status').textContent = 'Ready'; }, 2000);
  } catch (err) {
    console.error('[DexPad] Failed to save settings:', err);
    $('status').textContent = 'Failed to save';
  }
});

$('open').addEventListener('click', async () => {
  try {
    await window.dexpad.openWorkspace();
  } catch (err) {
    console.error('[DexPad] Failed to open workspace:', err);
  }
});

load();
