'use strict';

const MODE = new URLSearchParams(window.location.search).get('mode') || 'control';
const WALLPAPER = MODE === 'wallpaper';
if (WALLPAPER) document.body.classList.add('wallpaper');

const $ = id => document.getElementById(id);
const canvas = $('canvas'); const world = $('world'); const connectionsSvg = $('connections'); const selectionToolbar = $('selection-toolbar'); const emptyState = $('empty-state'); const zoomLevel = $('zoom-level');
let cards=[]; let connections=[]; let activeFilter='all'; let searchQuery=''; let saveTimer=null; let isSaving=false; let savePending=false; let activeSavePromise=null; let pendingSavePromise=null; let pendingSaveResolve=null; let dragging=null; let pan=null; let spaceDown=false; let drawFrame=0; let history=[]; let future=[]; let historyStamp=0;
const selectedIds=new Set(); const resizeObservers=new Map(); const camera={x:0,y:0,zoom:1}; const uid=p=>`${p}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`; const clone=v=>JSON.parse(JSON.stringify(v));
function snapshot(){return{cards:clone(cards),connections:clone(connections)}}
function recordHistory(force=false){const now=Date.now();if(!force&&now-historyStamp<700)return;history.push(snapshot());if(history.length>100)history.shift();future=[];historyStamp=now;updateHistoryButtons()}
function restoreSnapshot(s){cards=clone(s?.cards||[]);connections=clone(s?.connections||[]);selectedIds.clear();reconcile();flushSave()}
function undo(){if(WALLPAPER||!history.length)return;future.push(snapshot());restoreSnapshot(history.pop())}
function redo(){if(WALLPAPER||!future.length)return;history.push(snapshot());restoreSnapshot(future.pop())}
function updateHistoryButtons(){const u=$('btn-undo'),r=$('btn-redo');if(u)u.disabled=WALLPAPER||!history.length;if(r)r.disabled=WALLPAPER||!future.length}
function applyCamera(){if(!WALLPAPER&&world){world.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;canvas.style.backgroundPosition=`${camera.x}px ${camera.y}px`;canvas.style.backgroundSize=`${28*camera.zoom}px ${28*camera.zoom}px`;if(zoomLevel)zoomLevel.textContent=`${Math.round(camera.zoom*100)}%`}scheduleDrawConnections()}
function setZoom(value,ax=canvas.clientWidth/2,ay=canvas.clientHeight/2){if(WALLPAPER)return;const next=Math.max(.3,Math.min(2.5,Number(value)||1));if(Math.abs(next-camera.zoom)<.001)return;const ratio=next/camera.zoom;camera.x=ax-(ax-camera.x)*ratio;camera.y=ay-(ay-camera.y)*ratio;camera.zoom=next;applyCamera()}
function resetCamera(){if(WALLPAPER)return;camera.x=0;camera.y=0;camera.zoom=1;applyCamera()}
function clearSelection(){selectedIds.clear();updateSelection()}
function toggleSelection(id,multi=false){if(WALLPAPER)return;if(!multi)selectedIds.clear();if(selectedIds.has(id)&&multi)selectedIds.delete(id);else selectedIds.add(id);updateSelection()}
function updateSelection(){world?.querySelectorAll('.card[data-id]').forEach(el=>el.classList.toggle('card--selected',selectedIds.has(el.dataset.id)));if(selectionToolbar)selectionToolbar.hidden=WALLPAPER||selectedIds.size===0;const c=$('selection-count');if(c)c.textContent=`${selectedIds.size} selected`}
function maxZ(){return cards.reduce((m,c)=>Math.max(m,Number(c.zIndex)||1),1)}
function patchCard(id,patch){if(WALLPAPER)return;const c=cards.find(x=>x.id===id);if(!c||c.locked)return;recordHistory();Object.assign(c,patch);scheduleSave();const el=findCardElement(id);if(el){positionCard(el,c);syncInputs(el,c)}scheduleDrawConnections()}
function scheduleSave(){if(WALLPAPER)return;clearTimeout(saveTimer);saveTimer=setTimeout(flushSave,300)}
function flushSave(){
  if(WALLPAPER)return Promise.resolve();
  clearTimeout(saveTimer);saveTimer=null;
  if(isSaving){
    savePending=true;
    if(!pendingSavePromise){
      pendingSavePromise=new Promise(res=>{pendingSaveResolve=res;});
    }
    return pendingSavePromise;
  }
  isSaving=true;
  const currentProfileId=window.DexProfiles?.getActiveId?.()||null;
  activeSavePromise=window.dexpad.saveWorkspace({cards,connections,profileId:currentProfileId}).then(()=>{
    setSaveStatus('Saved');
  }).catch(err=>{
    console.error('[DexPad] Save failed:',err);
    setSaveStatus('Save failed');
  }).finally(()=>{
    isSaving=false;
    activeSavePromise=null;
    if(savePending){
      savePending=false;
      const res=pendingSaveResolve;
      pendingSavePromise=null;
      pendingSaveResolve=null;
      flushSave().then(res);
    }
  });
  return activeSavePromise;
}
window.flushSave=flushSave;
function setSaveStatus(s){const b=$('btn-save');if(!b)return;b.textContent=s==='Saved'?'Saved ✓':s;clearTimeout(b._timer);b._timer=setTimeout(()=>b.textContent='Save',1200)}
function validateImageSource(src){if(typeof src!=='string'||!src.trim())return false;if(src.startsWith('data:image/'))return true;try{const u=new URL(src);return u.protocol==='http:'||u.protocol==='https:'}catch(_){return false}}
function makeCard(type){const supported=['note','todo','link','markdown','image','file','column','group','board'];if(!supported.includes(type))type='note';const col=cards.length%3,row=Math.floor(cards.length/3),x=Math.max(20,Math.round((-camera.x+90)/camera.zoom+col*330)),y=Math.max(20,Math.round((-camera.y+90)/camera.zoom+row*210));return{id:uid('block'),type,color:'default',pinned:false,locked:false,collapsed:false,tags:[],title:type==='todo'?'New task':type==='link'?'New link':type==='markdown'?'New markdown':type==='image'?'New image':type==='file'?'New file':type==='column'?'New column':type==='group'?'New group':type==='board'?'New board':'New note',body:'',url:type==='link'?'https://':'',markdown:'',src:'',path:'',description:'',done:false,children:[],x,y,width:type==='column'?280:300,height:type==='note'||type==='markdown'?210:170,zIndex:maxZ()+1}}
function addCard(type,at=null){if(WALLPAPER)return;recordHistory(true);const c=makeCard(type);if(at){const r=canvas.getBoundingClientRect();c.x=Math.max(0,Math.round((at.x-r.left-camera.x)/camera.zoom));c.y=Math.max(0,Math.round((at.y-r.top-camera.y)/camera.zoom))}cards.push(c);selectedIds.clear();selectedIds.add(c.id);reconcile();flushSave();closeTransientMenus()}
function deleteIds(ids){if(WALLPAPER||!ids?.size)return;recordHistory(true);cards=cards.filter(c=>!ids.has(c.id));connections=connections.filter(c=>!ids.has(c.a)&&!ids.has(c.b));
  // note: scrub deleted ids from group/column children arrays to prevent dangling references
  cards.forEach(c=>{if(Array.isArray(c.children)&&c.children.length)c.children=c.children.filter(id=>!ids.has(id))});
  ids.forEach(id=>selectedIds.delete(id));reconcile();flushSave()}
function togglePin(ids){if(WALLPAPER||!ids?.size)return;recordHistory(true);cards.forEach(c=>{if(ids.has(c.id)&&!c.locked)c.pinned=!c.pinned});reconcile();flushSave()}
function toggleLock(id){if(WALLPAPER)return;const c=cards.find(x=>x.id===id);if(!c)return;recordHistory(true);c.locked=!c.locked;reconcile();flushSave()}
function groupSelected(){if(WALLPAPER||selectedIds.size<2)return toast('Select at least two blocks');recordHistory(true);const items=cards.filter(c=>selectedIds.has(c.id));const x=Math.max(20,Math.min(...items.map(c=>c.x))-28),y=Math.max(20,Math.min(...items.map(c=>c.y))-50),right=Math.max(...items.map(c=>c.x+c.width)),bottom=Math.max(...items.map(c=>c.y+c.height)),g=makeCard('group');g.title='Group';g.x=x;g.y=y;g.width=Math.max(300,right-x+28);g.height=Math.max(190,bottom-y+62);g.children=items.map(c=>c.id);g.zIndex=Math.max(1,Math.min(...items.map(c=>Number(c.zIndex)||1))-1);cards.push(g);selectedIds.clear();selectedIds.add(g.id);reconcile();flushSave()}
function connectSelected(){if(WALLPAPER||selectedIds.size!==2)return toast('Select exactly two blocks');const[a,b]=[...selectedIds];if(a===b)return;if(connections.some(c=>(c.a===a&&c.b===b)||(c.a===b&&c.b===a)))return toast('Already connected');recordHistory(true);connections.push({id:uid('connection'),a,b,label:''});scheduleDrawConnections();flushSave();toast('Connected')}
function openBoard(id){const b=cards.find(c=>c.id===id);if(b)toast(`Board “${b.title||'Untitled'}” is ready for nested content.`)}
function isValidUrl(v){try{const u=new URL(String(v));return u.protocol==='http:'||u.protocol==='https:'}catch(_){return false}}
function openUrl(v){if(isValidUrl(v))window.dexpad.openUrl(v).catch(e=>console.error('[DexPad] openUrl failed:',e))}
function findCardElement(id){try{return world.querySelector(`[data-id="${CSS.escape(id)}"]`)}catch(_){return[...world.querySelectorAll('.card[data-id]')].find(e=>e.dataset.id===id)||null}}
const cardElements = new Map();

function positionCard(el,c){el.style.left=`${c.x}px`;el.style.top=`${c.y}px`;el.style.width=`${c.width}px`;el.style.height=`${c.height}px`;el.style.zIndex=String(c.zIndex||1);el.dataset.color=c.color||'default';el.dataset.pinned=String(!!c.pinned);el.dataset.locked=String(!!c.locked)}
function syncInputs(el,c){
  el.querySelectorAll('[data-field]').forEach(control=>{
    if(control===document.activeElement)return;
    const f=control.dataset.field;
    if(control.type==='checkbox')control.checked=Boolean(c[f]);
    else control.value=String(c[f]??'');
  });
  const p=el.querySelector('.markdown-preview');
  if(p){
    const renderFn=window.DexBlockRegistry?.renderMarkdown;
    p.innerHTML=typeof renderFn==='function'?renderFn(c.markdown||c.body||''):String(c.markdown||c.body||'');
  }
  const image=el.querySelector('.block-image');
  if(image&&image.src!==c.src&&validateImageSource(c.src))image.src=c.src;
  const path=el.querySelector('.file-path');
  if(path)path.textContent=c.path||'No file selected';
}
function observeResize(el,c){
  if(WALLPAPER||typeof ResizeObserver==='undefined')return;
  if(resizeObservers.has(c.id))return;
  const ro=new ResizeObserver(([entry])=>{
    if(!entry||dragging?.multi?.some(i=>i.c.id===c.id))return;
    const w=Math.max(220,Math.min(900,Math.round(entry.contentRect.width))),h=Math.max(140,Math.min(900,Math.round(entry.contentRect.height)));
    if(c.width!==w||c.height!==h){
      recordHistory();
      c.width=w;
      c.height=h;
      scheduleSave();
    }
  });
  ro.observe(el);
  resizeObservers.set(c.id,ro);
}
function disconnectObserver(id){
  const ro=resizeObservers.get(id);
  if(ro){ro.disconnect();resizeObservers.delete(id);}
}
function disconnectAllObservers(){resizeObservers.forEach(ro=>ro.disconnect());resizeObservers.clear()}
function buildCard(c){
  const el=document.createElement('article');
  el.className='card';
  el.dataset.id=c.id;
  el.dataset.type=c.type;
  positionCard(el,c);
  el.classList.toggle('card--selected',selectedIds.has(c.id));
  const head=document.createElement('div');
  head.className='card-head';
  const type=document.createElement('span');
  type.className='card-type';
  type.textContent=c.type;
  head.appendChild(type);
  if(!WALLPAPER){
    const actions=document.createElement('div');
    actions.className='card-actions';
    [['☆',c.pinned?'Unpin':'Pin',()=>togglePin(new Set([c.id]))],[c.locked?'🔒':'↗',c.locked?'Unlock':'Bring to front',()=>c.locked?toggleLock(c.id):bringToFront(c.id)],['×','Delete',()=>deleteIds(new Set([c.id]))]].forEach(([label,title,fn])=>{
      const b=document.createElement('button');
      b.type='button';
      b.className=`card-action${label==='×'?' danger':''}`;
      b.textContent=label;
      b.title=title;
      b.addEventListener('click',e=>{e.stopPropagation();fn()});
      actions.appendChild(b);
    });
    head.appendChild(actions);
    head.addEventListener('mousedown',e=>startDrag(e,c));
  }
  el.appendChild(head);
  const body=document.createElement('div');
  body.className='card-body';
  const renderer=window.DexBlockRegistry?.get(c.type);
  if(renderer){
    renderer(body,{
      card:c,
      wallpaper:WALLPAPER,
      disabled:WALLPAPER,
      patch:patchCard,
      openUrl,
      openBoard,
      flush:flushSave,
      isValidUrl,
      validateImageSource
    });
  }else{
    const p=document.createElement('div');
    p.className='block-placeholder';
    p.textContent='Unsupported block type';
    body.appendChild(p);
  }
  el.appendChild(body);
  el.addEventListener('mousedown',e=>{
    if(e.target.closest('input,textarea,button,a,select'))return;
    toggleSelection(c.id,e.shiftKey);
  });
  if(!WALLPAPER)observeResize(el,c);
  return el;
}
function matches(c){
  const f=activeFilter,q=searchQuery.toLowerCase();
  let ok=f==='all'||(f==='favorite'&&c.pinned)||(f==='other'&&!['note','todo','link'].includes(c.type))||c.type===f;
  if(!ok)return false;
  if(!q)return true;
  return[c.title,c.body,c.markdown,c.url,c.path,c.description,c.type,(c.tags||[]).join(' ')].some(v=>String(v||'').toLowerCase().includes(q));
}
// note: incremental DOM reconciliation diffs against cardElements to avoid full DOM destruction/rebuilding
function reconcile(){
  const visible=cards.filter(matches);
  const visibleIds=new Set(visible.map(c=>c.id));

  // remove cards no longer visible
  for(const [id, el] of cardElements.entries()){
    if(!visibleIds.has(id)){
      disconnectObserver(id);
      el.remove();
      cardElements.delete(id);
    }
  }

  // update existing or append new cards
  for(const c of visible){
    let el=cardElements.get(c.id);
    if(el){
      positionCard(el,c);
      syncInputs(el,c);
      el.classList.toggle('card--selected',selectedIds.has(c.id));
    }else{
      el=buildCard(c);
      cardElements.set(c.id,el);
      world.appendChild(el);
    }
  }

  updateSelection();
  updateCounts();
  emptyState.hidden=cards.length!==0;
  scheduleDrawConnections();
  updateHistoryButtons();
}
function updateCounts(){const counts={all:cards.length,note:0,todo:0,link:0,other:0,favorite:0};cards.forEach(c=>{if(counts[c.type]!=null)counts[c.type]++;if(!['note','todo','link'].includes(c.type))counts.other++;if(c.pinned)counts.favorite++});Object.entries(counts).forEach(([k,v])=>{const el=$(`count-${k}`);if(el)el.textContent=v})}
function bringToFront(id){const c=cards.find(x=>x.id===id);if(!c||c.locked)return;recordHistory(true);c.zIndex=maxZ()+1;positionCard(findCardElement(id),c);scheduleSave();scheduleDrawConnections()}
function startDrag(e,c){if(WALLPAPER||c.locked||e.button!==0)return;e.preventDefault();const multi=selectedIds.has(c.id)?cards.filter(x=>selectedIds.has(x.id)): [c];if(!selectedIds.has(c.id))toggleSelection(c.id,e.shiftKey);dragging={startX:e.clientX,startY:e.clientY,multi:multi.map(x=>({c:x,x:x.x,y:x.y}))};recordHistory(true);document.addEventListener('mousemove',onDrag);document.addEventListener('mouseup',endDrag,{once:true})}
function onDrag(e){if(!dragging)return;const dx=(e.clientX-dragging.startX)/camera.zoom,dy=(e.clientY-dragging.startY)/camera.zoom;dragging.multi.forEach(i=>{i.c.x=Math.max(0,Math.round(i.x+dx));i.c.y=Math.max(0,Math.round(i.y+dy));const el=findCardElement(i.c.id);if(el)positionCard(el,i.c)});scheduleDrawConnections()}
function endDrag(){if(!dragging)return;dragging=null;document.removeEventListener('mousemove',onDrag);scheduleSave();flushSave()}
function startPan(e){if(WALLPAPER||(e.button!==1&&!(spaceDown&&e.button===0)))return;e.preventDefault();pan={x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y};canvas.classList.add('is-panning');document.addEventListener('mousemove',onPan);document.addEventListener('mouseup',endPan,{once:true})}
function onPan(e){if(!pan)return;camera.x=pan.cx+(e.clientX-pan.x);camera.y=pan.cy+(e.clientY-pan.y);applyCamera()}
function endPan(){pan=null;canvas.classList.remove('is-panning');document.removeEventListener('mousemove',onPan)}
function scheduleDrawConnections(){if(drawFrame||!connectionsSvg||WALLPAPER)return;drawFrame=requestAnimationFrame(()=>{drawFrame=0;drawConnections()})}
function drawConnections(){if(!connectionsSvg)return;connectionsSvg.replaceChildren();if(WALLPAPER)return;const cardMap=new Map(cards.map(c=>[c.id,c]));connections.forEach(c=>{const a=cardMap.get(c.a),b=cardMap.get(c.b);if(!a||!b||!matches(a)||!matches(b))return;const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',(a.x+a.width/2)*camera.zoom+camera.x);line.setAttribute('y1',(a.y+a.height/2)*camera.zoom+camera.y);line.setAttribute('x2',(b.x+b.width/2)*camera.zoom+camera.x);line.setAttribute('y2',(b.y+b.height/2)*camera.zoom+camera.y);line.setAttribute('stroke','rgba(118,168,255,.45)');line.setAttribute('stroke-width','2');line.setAttribute('stroke-linecap','round');connectionsSvg.appendChild(line)})}
function closeOverlay(id){const el=$(id);if(el){el.hidden=true;el.querySelector('input')?.blur()}}
function closeTransientMenus(){const m=$('add-menu');if(m)m.hidden=true;$('templates-menu')?.remove()}
function openOverlay(id){const el=$(id);if(!el)return;el.hidden=false;const input=el.querySelector('input');if(input){input.value='';if(id==='search-overlay')searchQuery='';else renderCommands();requestAnimationFrame(()=>input.focus())}}
function toast(message){let el=$('toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';document.body.appendChild(el)}el.textContent=message;el.classList.add('show');clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove('show'),1500)}
function renderSearch(){const root=$('search-results');if(!root)return;searchQuery=($('search-input')?.value||'').trim();root.replaceChildren();cards.filter(matches).slice(0,50).forEach(c=>{const row=document.createElement('div');row.className='result-row';const left=document.createElement('div');const strong=document.createElement('strong');strong.textContent=c.title||c.type;const small=document.createElement('small');small.textContent=(c.body||c.markdown||c.url||c.path||'').slice(0,100);left.append(strong,small);const typ=document.createElement('span');typ.className='result-type';typ.textContent=c.type;row.append(left,typ);row.addEventListener('click',()=>{selectedIds.clear();selectedIds.add(c.id);closeOverlay('search-overlay');activeFilter='all';searchQuery='';camera.x=Math.round(canvas.clientWidth/2-(c.x+c.width/2)*camera.zoom);camera.y=Math.round(canvas.clientHeight/2-(c.y+c.height/2)*camera.zoom);reconcile()});root.appendChild(row)})}
const commands=[['Add note','Create a note','note'],['Add task','Create a task','todo'],['Add link','Create a link','link'],['Add markdown','Create Markdown','markdown'],['Add image','Create an image block','image'],['Add file','Create a file block','file'],['Add column','Create a column','column'],['Add group','Group blocks','group'],['Add board','Create a board','board'],['Group selected','Group the current selection','group-selected'],['Pin selected','Toggle pin','pin'],['Connect selected','Connect exactly two blocks','connect'],['Export workspace','Export JSON','export'],['Import workspace','Import JSON','import'],['Undo','Undo','undo'],['Redo','Redo','redo'],['Reset view','Reset canvas','reset']];
function renderCommands(){const root=$('command-results');if(!root)return;const q=($('command-input')?.value||'').trim().toLowerCase();root.replaceChildren();commands.filter(c=>!q||c[0].toLowerCase().includes(q)).forEach(c=>{const row=document.createElement('div');row.className='result-row';const left=document.createElement('div');const strong=document.createElement('strong');strong.textContent=c[0];const small=document.createElement('small');small.textContent=c[1];left.append(strong,small);row.appendChild(left);row.addEventListener('click',()=>runCommand(c[2]));root.appendChild(row)})}
function runCommand(command){closeOverlay('command-overlay');if(command==='undo')return undo();if(command==='redo')return redo();if(command==='reset')return resetCamera();if(command==='export')return exportWorkspace();if(command==='import')return $('import-input')?.click();if(command==='group-selected')return groupSelected();if(command==='pin')return togglePin(selectedIds);if(command==='connect')return connectSelected();addCard(command)}
function exportWorkspace(){const activeId=window.DexProfiles?.getActiveId?.()||'workspace';const data=JSON.stringify({schemaVersion:5,profileId:activeId,cards,connections},null,2),url=URL.createObjectURL(new Blob([data],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`dexpad-${activeId}-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);toast('Workspace exported')}
function importWorkspace(file){if(!file||WALLPAPER)return;const reader=new FileReader();reader.onload=async()=>{try{const d=JSON.parse(String(reader.result));if(!d||!Array.isArray(d.cards)||d.cards.length>5000)throw new Error('Invalid workspace file');recordHistory(true);const currentProfileId=window.DexProfiles?.getActiveId?.()||null;const saved=await window.dexpad.saveWorkspace({cards:d.cards,connections:Array.isArray(d.connections)?d.connections:[],profileId:currentProfileId});cards=Array.isArray(saved?.cards)?saved.cards:[];connections=Array.isArray(saved?.connections)?saved.connections:[];selectedIds.clear();reconcile();toast('Workspace imported')}catch(err){console.error('[DexPad] Import failed:',err);toast('Import failed')}};reader.readAsText(file)}
function applyTemplate(name){if(WALLPAPER)return;recordHistory(true);cards=[];connections=[];if(name==='project'){[['column','Ideas'],['column','In progress'],['column','Done'],['note','Project brief'],['todo','First task'],['link','Reference']].forEach(([type,title],i)=>{const c=makeCard(type);c.title=title;c.x=70+(i%3)*320;c.y=70+Math.floor(i/3)*220;cards.push(c)})}else if(name==='weekly'){['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach((day,i)=>{const c=makeCard('todo');c.title=day;c.x=80+(i%3)*330;c.y=80+Math.floor(i/3)*200;cards.push(c)})}selectedIds.clear();reconcile();flushSave();toast('Template applied')}
function showTemplates(){const existing=$('templates-menu');if(existing){existing.remove();return}const anchor=$('btn-templates');if(!anchor)return;const menu=document.createElement('div');menu.id='templates-menu';menu.className='floating-menu';menu.style.right='0';menu.style.top='38px';const a=document.createElement('button');a.textContent='Project board';a.onclick=()=>{applyTemplate('project');menu.remove()};const b=document.createElement('button');b.textContent='Weekly planner';b.onclick=()=>{applyTemplate('weekly');menu.remove()};menu.append(a,b);anchor.parentElement?.appendChild(menu)}
$('btn-add')?.addEventListener('click',e=>{e.stopPropagation();const m=$('add-menu');if(m)m.hidden=!m.hidden});
document.querySelectorAll('[data-add]').forEach(b=>b.addEventListener('click',()=>{addCard(b.dataset.add);closeTransientMenus()}));
$('btn-templates')?.addEventListener('click',e=>{e.stopPropagation();showTemplates()});
$('btn-save')?.addEventListener('click',flushSave);$('btn-undo')?.addEventListener('click',undo);$('btn-redo')?.addEventListener('click',redo);$('btn-search')?.addEventListener('click',()=>openOverlay('search-overlay'));$('btn-command')?.addEventListener('click',()=>openOverlay('command-overlay'));$('btn-delete-selected')?.addEventListener('click',()=>deleteIds(new Set(selectedIds)));$('btn-group-selected')?.addEventListener('click',groupSelected);$('btn-pin-selected')?.addEventListener('click',()=>togglePin(selectedIds));$('btn-connect')?.addEventListener('click',connectSelected);$('btn-export')?.addEventListener('click',exportWorkspace);$('btn-import')?.addEventListener('click',()=>$('import-input')?.click());$('import-input')?.addEventListener('change',e=>{if(e.target.files?.[0])importWorkspace(e.target.files[0]);e.target.value=''});$('btn-zoom-in')?.addEventListener('click',()=>setZoom(camera.zoom+.15));$('btn-zoom-out')?.addEventListener('click',()=>setZoom(camera.zoom-.15));$('btn-zoom-reset')?.addEventListener('click',resetCamera);
document.querySelectorAll('.side-item').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.side-item').forEach(x=>x.classList.remove('active'));b.classList.add('active');activeFilter=b.dataset.filter||'all';searchQuery='';selectedIds.clear();reconcile()}));$('search-input')?.addEventListener('input',renderSearch);$('command-input')?.addEventListener('input',renderCommands);document.querySelectorAll('[data-close-overlay]').forEach(b=>b.addEventListener('click',()=>closeOverlay(b.dataset.closeOverlay)));$('search-overlay')?.addEventListener('click',e=>{if(e.target===$('search-overlay'))closeOverlay('search-overlay')});$('command-overlay')?.addEventListener('click',e=>{if(e.target===$('command-overlay'))closeOverlay('command-overlay')});canvas?.addEventListener('mousedown',e=>{if(e.target===canvas)clearSelection();startPan(e)});canvas?.addEventListener('wheel',e=>{if(WALLPAPER)return;e.preventDefault();const r=canvas.getBoundingClientRect();setZoom(camera.zoom*(e.deltaY<0?1.08:.92),e.clientX-r.left,e.clientY-r.top)},{passive:false});window.addEventListener('resize',scheduleDrawConnections);

// note: global outside-click dismissal for floating menus
document.addEventListener('click',e=>{
  const addMenu=$('add-menu');
  const addBtn=$('btn-add');
  if(addMenu&&!addMenu.hidden&&e.target!==addBtn&&!addMenu.contains(e.target)){
    addMenu.hidden=true;
  }
  const tMenu=$('templates-menu');
  const tBtn=$('btn-templates');
  if(tMenu&&e.target!==tBtn&&!tMenu.contains(e.target)){
    tMenu.remove();
  }
});

document.addEventListener('keydown',e=>{const editing=e.target.matches?.('input,textarea,select');if(e.key==='Escape'){closeOverlay('search-overlay');closeOverlay('command-overlay');closeTransientMenus();return}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&!WALLPAPER){e.preventDefault();flushSave()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!editing){e.preventDefault();e.shiftKey?redo():undo()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'&&!editing){e.preventDefault();redo()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();openOverlay('search-overlay')}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openOverlay('command-overlay')}if(e.code==='Space'&&!editing){spaceDown=true;e.preventDefault()}if((e.key==='Delete'||e.key==='Backspace')&&!editing&&!WALLPAPER)deleteIds(new Set(selectedIds))});document.addEventListener('keyup',e=>{if(e.code==='Space')spaceDown=false});window.addEventListener('beforeunload',()=>{if(!WALLPAPER&&typeof window.dexpad?.saveWorkspaceSync==='function'){const currentProfileId=window.DexProfiles?.getActiveId?.()||null;window.dexpad.saveWorkspaceSync({cards,connections,profileId:currentProfileId})}});
async function init(){try{const state=await window.dexpad.getState();cards=Array.isArray(state?.cards)?state.cards:[];connections=Array.isArray(state?.connections)?state.connections:[];reconcile();if(typeof window.dexpad.onStateUpdated==='function')window.dexpad.onStateUpdated(state=>{if(!state||!Array.isArray(state.cards))return;cards=state.cards;connections=Array.isArray(state.connections)?state.connections:[];selectedIds.clear();reconcile()})}catch(err){console.error('[DexPad] init failed:',err);toast('Unable to load workspace')}updateHistoryButtons()}
init();