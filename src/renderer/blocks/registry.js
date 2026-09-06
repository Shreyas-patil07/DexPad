(() => {
  'use strict';

  const Registry = {
    map: new Map(),
    register(type, renderer) { this.map.set(type, renderer); return renderer; },
    get(type) { return this.map.get(type) || this.map.get('note'); },
    types() { return [...this.map.keys()]; }
  };

  function input(ctx, value, field, placeholder, type = 'text') {
    const el = document.createElement('input');
    el.type = type;
    el.className = 'block-input';
    el.placeholder = placeholder;
    el.value = value ?? '';
    el.disabled = !!ctx.disabled;
    el.dataset.field = field;
    el.addEventListener('input', () => ctx.patch({ [field]: el.value }));
    el.addEventListener('blur', ctx.flush);
    return el;
  }

  function area(ctx, value, field, placeholder) {
    const el = document.createElement('textarea');
    el.className = 'block-textarea';
    el.placeholder = placeholder;
    el.value = value ?? '';
    el.disabled = !!ctx.disabled;
    el.dataset.field = field;
    el.addEventListener('input', () => ctx.patch({ [field]: el.value }));
    el.addEventListener('blur', ctx.flush);
    return el;
  }

  Registry.register('note', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Note title'));
    body.append(area(ctx, ctx.card.body, 'body', 'Start writing…'));
  });

  Registry.register('todo', (body, ctx) => {
    const row = document.createElement('div');
    row.className = 'todo-editor';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!ctx.card.done;
    cb.disabled = !!ctx.disabled;
    cb.dataset.field = 'done';
    cb.addEventListener('change', () => { ctx.patch({ done: cb.checked }); ctx.flush(); });
    row.append(cb, input(ctx, ctx.card.title, 'title', 'Task description'));
    body.append(row);
  });

  Registry.register('link', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Link title'));
    body.append(input(ctx, ctx.card.url, 'url', 'https://example.com', 'url'));
    if (ctx.card.url && ctx.isValidUrl(ctx.card.url)) {
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'link-preview'; open.textContent = 'Open link ↗';
      open.disabled = !!ctx.wallpaper;
      open.addEventListener('click', () => ctx.openUrl(ctx.card.url));
      body.append(open);
    }
  });

  Registry.register('markdown', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Markdown title'));
    const editor = area(ctx, ctx.card.markdown || ctx.card.body, 'markdown', 'Write Markdown…');
    body.append(editor);
    const preview = document.createElement('div');
    preview.className = 'markdown-preview';
    preview.textContent = (ctx.card.markdown || ctx.card.body || '')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/[\*_`]/g, '');
    body.append(preview);
  });

  Registry.register('image', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Image title'));
    if (ctx.card.src && ctx.validateImageSource(ctx.card.src)) {
      const img = document.createElement('img');
      img.className = 'block-image';
      img.src = ctx.card.src;
      img.alt = ctx.card.title || 'Image';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.replaceWith(document.createTextNode('Image could not be loaded.')); };
      body.append(img);
    } else {
      const hint = document.createElement('div');
      hint.className = 'block-placeholder';
      hint.textContent = 'Paste an HTTP(S) image URL or data URI below.';
      body.append(hint);
    }
    body.append(input(ctx, ctx.card.src, 'src', 'https://… or data:image/…'));
  });

  Registry.register('file', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'File title'));
    const path = document.createElement('div');
    path.className = 'file-path';
    path.textContent = ctx.card.path || 'No file selected';
    body.append(path, input(ctx, ctx.card.path, 'path', 'C:\\path\\to\\file'));
  });

  Registry.register('column', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Column title'));
    const count = document.createElement('div');
    count.className = 'column-count';
    count.textContent = `${(ctx.card.children || []).length} items`;
    body.append(count);
  });

  Registry.register('group', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Group name'));
    const count = document.createElement('div');
    count.className = 'column-count';
    count.textContent = `${(ctx.card.children || []).length} items`;
    body.append(count);
  });

  Registry.register('board', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Board name'));
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'link-preview'; open.textContent = 'Open board →';
    open.disabled = !!ctx.disabled;
    open.addEventListener('click', () => ctx.openBoard(ctx.card.id));
    body.append(open);
  });

  window.DexBlockRegistry = Registry;
})();
