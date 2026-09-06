(() => {
  'use strict';
  const Registry = {
    map: new Map(),
    register(type, renderer) { this.map.set(type, renderer); return renderer; },
    get(type) { return this.map.get(type) || this.map.get('note'); },
    types() { return [...this.map.keys()]; }
  };
  function textInput(ctx, value, field, placeholder, className='block-input') {
    const el = document.createElement('input'); el.type='text'; el.className=className; el.placeholder=placeholder; el.value=value||''; el.disabled=ctx.wallpaper||ctx.card.locked; el.dataset.field=field; el.addEventListener('input',()=>ctx.patch({[field]:el.value})); el.addEventListener('blur',ctx.flush); return el;
  }
  function textarea(ctx, value, field='body', placeholder='Start writing…') {
    const el=document.createElement('textarea'); el.className='block-textarea'; el.placeholder=placeholder; el.value=value||''; el.disabled=ctx.wallpaper||ctx.card.locked; el.dataset.field=field; el.addEventListener('input',()=>ctx.patch({[field]:el.value})); el.addEventListener('blur',ctx.flush); return el;
  }
  Registry.register('note',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Note title')); body.appendChild(textarea(ctx,ctx.card.body)); });
  Registry.register('todo',(body,ctx)=>{ const row=document.createElement('div'); row.className='todo-editor'; const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=!!ctx.card.done; cb.disabled=ctx.wallpaper||ctx.card.locked; cb.addEventListener('change',()=>{ctx.patch({done:cb.checked});ctx.flush();}); row.appendChild(cb); row.appendChild(textInput(ctx,ctx.card.title,'title','Task description')); body.appendChild(row); });
  Registry.register('link',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Link title')); body.appendChild(textInput(ctx,ctx.card.url,'url','https://example.com')); if(ctx.card.url&&ctx.isValidUrl(ctx.card.url)){ const a=document.createElement('button'); a.type='button';a.className='link-preview';a.textContent='Open link ↗';a.disabled=ctx.wallpaper;a.addEventListener('click',()=>ctx.openUrl(ctx.card.url));body.appendChild(a);} });
  Registry.register('markdown',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Markdown title')); const editor=textarea(ctx,ctx.card.markdown||ctx.card.body,'markdown','Write Markdown…'); editor.rows=7; body.appendChild(editor); const preview=document.createElement('div'); preview.className='markdown-preview'; preview.textContent=(ctx.card.markdown||ctx.card.body||'').replace(/^#+\s*/gm,'').replace(/[*_`]/g,''); body.appendChild(preview); });
  Registry.register('image',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Image title')); if(ctx.card.src){ const img=document.createElement('img');img.className='block-image';img.src=ctx.card.src;img.alt=ctx.card.title||'Image';img.onerror=()=>img.remove();body.appendChild(img);} else { const hint=document.createElement('div');hint.className='block-placeholder';hint.textContent='Paste an image URL or data URI.';body.appendChild(hint);} body.appendChild(textInput(ctx,ctx.card.src,'src','https://… or data:image/…')); });
  Registry.register('file',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','File title')); const path=document.createElement('div');path.className='file-path';path.textContent=ctx.card.path||'No file selected';body.appendChild(path);body.appendChild(textInput(ctx,ctx.card.path,'path','C:\\path\\to\\file')); });
  Registry.register('column',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Column title')); const c=document.createElement('div');c.className='column-count';c.textContent=`${(ctx.card.children||[]).length} items`;body.appendChild(c); });
  Registry.register('group',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Group name')); const c=document.createElement('div');c.className='column-count';c.textContent=`${(ctx.card.children||[]).length} items`;body.appendChild(c); });
  Registry.register('board',(body,ctx)=>{ body.appendChild(textInput(ctx,ctx.card.title,'title','Board name')); const b=document.createElement('button');b.type='button';b.className='link-preview';b.textContent='Open board →';b.disabled=ctx.wallpaper;b.addEventListener('click',()=>ctx.openBoard(ctx.card.id));body.appendChild(b); });
  window.DexBlockRegistry=Registry;
})();
