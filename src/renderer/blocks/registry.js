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
    el.disabled = Boolean(ctx.disabled || ctx.wallpaper);
    el.dataset.field = field;
    el.addEventListener('input', () => ctx.patch({ [field]: el.value }));
    el.addEventListener('blur', () => { if (typeof ctx.flush === 'function') ctx.flush(); });
    return el;
  }

  function area(ctx, value, field, placeholder) {
    const el = document.createElement('textarea');
    el.className = 'block-textarea';
    el.placeholder = placeholder;
    el.value = value ?? '';
    el.disabled = Boolean(ctx.disabled || ctx.wallpaper);
    el.dataset.field = field;
    el.addEventListener('input', () => ctx.patch({ [field]: el.value }));
    el.addEventListener('blur', () => { if (typeof ctx.flush === 'function') ctx.flush(); });
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
    cb.disabled = Boolean(ctx.disabled || ctx.wallpaper);
    cb.dataset.field = 'done';
    cb.addEventListener('change', () => {
      ctx.patch({ done: cb.checked });
      if (typeof ctx.flush === 'function') ctx.flush();
    });
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

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const lines = raw.split(/\r?\n/);
    const htmlLines = lines.map(line => {
      // headings
      const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const text = escapeHtml(hMatch[2]);
        return `<h${level} style="font-size:${1.4 - level * 0.12}em;margin:4px 0;font-weight:700;">${text}</h${level}>`;
      }
      // blockquote
      if (line.startsWith('> ')) {
        return `<blockquote style="border-left:2px solid #76a8ff;padding-left:8px;color:#9da9b8;margin:4px 0;">${escapeHtml(line.slice(2))}</blockquote>`;
      }
      // list item
      if (/^\s*[-*]\s+/.test(line)) {
        const itemText = line.replace(/^\s*[-*]\s+/, '');
        return `<li style="margin-left:14px;">${formatInlineMarkdown(itemText)}</li>`;
      }
      // code block single-line
      if (line.startsWith('```') && line.endsWith('```') && line.length > 6) {
        return `<code style="background:#151b24;padding:2px 4px;border-radius:4px;font-family:monospace;">${escapeHtml(line.slice(3, -3))}</code>`;
      }
      // standard paragraph
      return line.trim() ? `<p style="margin:2px 0;">${formatInlineMarkdown(line)}</p>` : '<br/>';
    });
    return htmlLines.join('');
  }

  function formatInlineMarkdown(text) {
    let s = escapeHtml(text);
    // inline code `code`
    s = s.replace(/`([^`]+)`/g, '<code style="background:#171d26;padding:1px 4px;border-radius:4px;font-family:monospace;font-size:0.9em;">$1</code>');
    // bold **bold**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic *italic*
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s;
  }

  Registry.renderMarkdown = renderMarkdown;

  Registry.register('markdown', (body, ctx) => {
    body.append(input(ctx, ctx.card.title, 'title', 'Markdown title'));
    const editor = area(ctx, ctx.card.markdown || ctx.card.body, 'markdown', 'Write Markdown…');
    body.append(editor);
    const preview = document.createElement('div');
    preview.className = 'markdown-preview';
    preview.innerHTML = renderMarkdown(ctx.card.markdown || ctx.card.body || '');
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
    open.disabled = Boolean(ctx.disabled || ctx.wallpaper);
    open.addEventListener('click', () => { if (typeof ctx.openBoard === 'function') ctx.openBoard(ctx.card.id); });
    body.append(open);
  });

  window.DexBlockRegistry = Registry;
})();
