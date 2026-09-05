const $ = (id) => document.getElementById(id);

async function load() {
  const state = await window.dexpad.getState();
  $('startup').checked = state.startup;
  $('wallpaper').checked = state.wallpaperMode;
  $('status').textContent = 'Ready';
}

$('save').addEventListener('click', async () => {
  $('status').textContent = 'Saving…';
  try {
    await window.dexpad.setState({
      startup: $('startup').checked,
      wallpaperMode: $('wallpaper').checked
    });
    $('status').textContent = 'Saved';
  } catch (error) {
    console.error(error);
    $('status').textContent = 'Failed to save';
  }
});

$('open').addEventListener('click', async () => {
  await window.dexpad.openWorkspace();
});

load().catch((error) => {
  console.error(error);
  $('status').textContent = 'Failed to load settings';
});
