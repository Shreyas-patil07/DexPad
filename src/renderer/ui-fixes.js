(() => {
  'use strict';

  const addMenu = document.getElementById('add-menu');
  const addButton = document.getElementById('btn-add');
  if (!addMenu || !addButton) return;

  document.addEventListener('click', event => {
    if (addMenu.hidden) return;
    if (event.target === addButton || addMenu.contains(event.target)) return;
    addMenu.hidden = true;
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') addMenu.hidden = true;
  });

  addButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
  }, true);

  addMenu.addEventListener('click', event => {
    if (event.target.closest('[data-add]')) addMenu.hidden = true;
  });
})();
