(() => {
  'use strict';

  const tabs = document.getElementById('profile-tabs');
  if (!tabs || !window.dexpad) return;

  async function renameProfile(profile) {
    const next = prompt('Rename profile', profile.name);
    if (next === null) return;
    const name = next.trim();
    if (!name) return;
    if (name === profile.name) return;
    try {
      await window.dexpad.renameProfile(profile.id, name);
    } catch (err) {
      console.error('[DexPad] Profile rename failed:', err);
      alert(err?.message || 'Unable to rename profile.');
    }
  }

  function render(state) {
    if (!Array.isArray(state?.profiles)) return;
    tabs.replaceChildren();
    state.profiles.forEach(profile => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-tab';
      button.textContent = profile.name;
      button.title = `Switch to ${profile.name} · Double-click or right-click to rename`;
      button.dataset.profileId = profile.id;
      button.classList.toggle('active', profile.id === state.activeProfileId);
      button.addEventListener('click', async () => {
        if (profile.id === state.activeProfileId) return;
        try {
          if (typeof window.flushSave === 'function') await window.flushSave();
          await window.dexpad.switchProfile(profile.id);
          window.location.reload();
        } catch (err) {
          console.error('[DexPad] Profile switch failed:', err);
        }
      });
      button.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
        renameProfile(profile);
      });
      button.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        renameProfile(profile);
      });
      tabs.appendChild(button);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'profile-add';
    add.textContent = '+';
    add.title = 'Create a new profile';
    add.setAttribute('aria-label', 'Create a new profile');
    add.addEventListener('click', async () => {
      const next = prompt('Profile name', `Profile ${state.profiles.length + 1}`);
      if (next === null) return;
      try {
        await window.dexpad.createProfile(next.trim() || `Profile ${state.profiles.length + 1}`);
        window.location.reload();
      } catch (err) {
        console.error('[DexPad] Profile creation failed:', err);
      }
    });
    tabs.appendChild(add);
  }

  window.dexpad.onStateUpdated(render);
  window.dexpad.getState().then(render).catch(err => console.error('[DexPad] Profile state failed:', err));
})();
