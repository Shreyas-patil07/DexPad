(() => {
  'use strict';

  const tabs = document.getElementById('profile-tabs');
  if (!tabs || !window.dexpad) return;

  let currentState = null;
  let switching = false;
  let creating = false;

  async function renameProfile(profile) {
    const next = prompt('Rename profile', profile.name);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === profile.name) return;
    try {
      const state = await window.dexpad.renameProfile(profile.id, name);
      currentState = state;
      render(state);
    } catch (err) {
      console.error('[DexPad] Profile rename failed:', err);
      alert(err?.message || 'Unable to rename profile.');
    }
  }

  async function switchProfile(profile) {
    if (switching || !currentState || profile.id === currentState.activeProfileId) return;
    switching = true;
    try {
      if (typeof window.flushSave === 'function') await window.flushSave();
      const state = await window.dexpad.switchProfile(profile.id);
      currentState = state;
      render(state);
    } catch (err) {
      console.error('[DexPad] Profile switch failed:', err);
      alert(err?.message || 'Unable to switch profile.');
    } finally {
      switching = false;
    }
  }

  function render(state) {
    if (!Array.isArray(state?.profiles)) return;
    currentState = state;
    tabs.replaceChildren();

    state.profiles.forEach(profile => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-tab';
      button.textContent = profile.name;
      button.title = `Switch to ${profile.name} · Double-click or right-click to rename`;
      button.dataset.profileId = profile.id;
      button.classList.toggle('active', profile.id === state.activeProfileId);
      button.disabled = switching;
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void switchProfile(profile);
      });
      button.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        void renameProfile(profile);
      });
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        void renameProfile(profile);
      });
      tabs.appendChild(button);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'profile-add';
    add.textContent = '+';
    add.title = 'Create a new profile';
    add.setAttribute('aria-label', 'Create a new profile');
    add.disabled = creating;
    add.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (creating) return;
      const next = prompt('Profile name', `Profile ${state.profiles.length + 1}`);
      if (next === null) return;
      creating = true;
      add.disabled = true;
      try {
        if (typeof window.flushSave === 'function') await window.flushSave();
        const result = await window.dexpad.createProfile(next.trim() || `Profile ${state.profiles.length + 1}`);
        currentState = result;
        render(result);
      } catch (err) {
        console.error('[DexPad] Profile creation failed:', err);
        alert(err?.message || 'Unable to create profile.');
      } finally {
        creating = false;
      }
    });
    tabs.appendChild(add);
  }

  window.dexpad.onStateUpdated(render);
  window.dexpad.getState().then(render).catch(err => console.error('[DexPad] Profile state failed:', err));
})();
