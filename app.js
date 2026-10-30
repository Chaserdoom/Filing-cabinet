(() => {
  const $ = sel => document.querySelector(sel);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const COLORS = ['#c0392b', '#d68910', '#b7950b', '#229954', '#2471a3', '#7d3c98', '#5d6d7e'];

  const state = {
    items: new Map(),   // id -> item (blobs included)
    current: null,      // id of the open drawer/folder
    query: '',
    sort: 'name',
  };

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = n => n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const children = id => [...state.items.values()].filter(i => i.parentId === id);
  const drawers = () => [...state.items.values()].filter(i => i.kind === 'drawer').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

  function path(id) {
    const out = [];
    let it = state.items.get(id);
    while (it) { out.unshift(it); it = state.items.get(it.parentId); }
    return out;
  }

  function descendants(id) {
    const out = [];
    const walk = pid => children(pid).forEach(c => { out.push(c); walk(c.id); });
    walk(id);
    return out;
  }

  function docIcon(doc) {
    const m = doc.mime || '';
    if (doc.text != null && !doc.blob) return '📝';
    if (m.startsWith('image/')) return '🖼️';
    if (m === 'application/pdf') return '📕';
    if (m.startsWith('video/')) return '🎞️';
    if (m.startsWith('audio/')) return '🎵';
    if (/sheet|excel|csv/.test(m)) return '📊';
    if (/word|document|rtf/.test(m)) return '📘';
    if (/zip|compressed|tar/.test(m)) return '🗜️';
    if (m.startsWith('text/')) return '📄';
    return '📎';
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  async function save(item) {
    item.updatedAt = Date.now();
    state.items.set(item.id, item);
    try { await DB.put(item); } catch { /* storage blocked: keep it in memory */ }
  }

  // ---------- dialog ----------
  function ask(title, bodyHtml, okLabel = 'Save') {
    const dlg = $('#dialog');
    $('#dialogTitle').textContent = title;
    $('#dialogBody').innerHTML = bodyHtml;
    $('#dialogOk').textContent = okLabel;
    $('#dialogOk').classList.toggle('danger', okLabel === 'Delete');
    dlg.returnValue = '';
    dlg.showModal();
    const first = dlg.querySelector('#dialogBody input, #dialogBody textarea, #dialogBody select');
    if (first) { first.focus(); first.select?.(); }
    return new Promise(resolve => {
      dlg.addEventListener('close', () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        const data = {};
        dlg.querySelectorAll('#dialogBody [name]').forEach(el => {
          if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
          else data[el.name] = el.value;
        });
        resolve(data);
      }, { once: true });
    });
  }

  const colorPicker = selected => `<div class="swatches">${COLORS.map(c =>
    `<label><input type="radio" name="color" value="${c}" ${c === selected ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>`;

  // ---------- actions ----------
  async function newDrawer() {
    const d = await ask('New drawer', `<label>Label<input name="name" required maxlength="60" placeholder="e.g. Taxes, Medical, Home"></label>${colorPicker(COLORS[drawers().length % COLORS.length])}`, 'Create');
    if (!d || !d.name.trim()) return;
    const item = { id: uid(), kind: 'drawer', parentId: null, name: d.name.trim(), color: d.color, order: Date.now(), createdAt: Date.now() };
    await save(item);
    open(item.id);
  }

  async function newFolder() {
    if (!state.current) return;
    const d = await ask('New folder', `<label>Folder name<input name="name" required maxlength="80"></label>${colorPicker('#d68910')}`, 'Create');
    if (!d || !d.name.trim()) return;
    await save({ id: uid(), kind: 'folder', parentId: state.current, name: d.name.trim(), color: d.color, createdAt: Date.now() });
    render();
  }

  async function newNote() {
    if (!state.current) return;
    const d = await ask('New note', `<label>Title<input name="name" required maxlength="120"></label><label>Note<textarea name="text" rows="10"></textarea></label><label>Tags <small class="muted">(comma separated)</small><input name="tags"></label>`, 'Create');
    if (!d || !d.name.trim()) return;
    await save({ id: uid(), kind: 'doc', parentId: state.current, name: d.name.trim(), text: d.text, mime: 'text/plain', size: new Blob([d.text]).size, tags: parseTags(d.tags), note: '', createdAt: Date.now() });
    render();
  }

  const parseTags = s => [...new Set((s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];

  async function addFiles(fileList, parentId = state.current) {
    if (!parentId) { toast('Open a drawer first'); return; }
    const files = [...fileList];
    if (!files.length) return;
    for (const f of files) {
      await save({ id: uid(), kind: 'doc', parentId, name: f.name, mime: f.type || 'application/octet-stream', size: f.size, blob: f, tags: [], note: '', createdAt: Date.now() });
    }
    toast(`Filed ${files.length} item${files.length > 1 ? 's' : ''}`);
    render();
  }

  async function rename(item) {
    const isContainer = item.kind !== 'doc';
    const d = await ask(`Edit ${item.kind}`, `<label>Name<input name="name" required value="${esc(item.name)}"></label>${isContainer ? colorPicker(item.color) : ''}`);
    if (!d || !d.name.trim()) return;
    item.name = d.name.trim();
    if (d.color) item.color = d.color;
    await save(item);
    render();
  }

  async function editDoc(doc) {
    const textField = doc.text != null && !doc.blob ? `<label>Note<textarea name="text" rows="10">${esc(doc.text)}</textarea></label>` : '';
    const d = await ask('Details', `<label>Name<input name="name" required value="${esc(doc.name)}"></label>${textField}<label>Tags <small class="muted">(comma separated)</small><input name="tags" value="${esc((doc.tags || []).join(', '))}"></label>${doc.blob ? `<label>Notes<textarea name="note" rows="4">${esc(doc.note)}</textarea></label>` : ''}`);
    if (!d || !d.name.trim()) return;
    doc.name = d.name.trim();
    doc.tags = parseTags(d.tags);
    if (d.text != null) { doc.text = d.text; doc.size = new Blob([d.text]).size; }
    if (d.note != null) doc.note = d.note;
    await save(doc);
    render();
  }

  async function move(item) {
    const banned = new Set([item.id, ...descendants(item.id).map(i => i.id)]);
    const options = [];
    const walk = (pid, depth) => children(pid).filter(c => c.kind !== 'doc').sort((a, b) => a.name.localeCompare(b.name)).forEach(c => {
      if (banned.has(c.id)) return;
      options.push(`<option value="${c.id}" ${c.id === item.parentId ? 'selected' : ''}>${'&nbsp;&nbsp;&nbsp;'.repeat(depth)}${c.kind === 'drawer' ? '🗄️' : '📁'} ${esc(c.name)}</option>`);
      walk(c.id, depth + 1);
    });
    drawers().forEach(d => {
      if (banned.has(d.id)) return;
      options.push(`<option value="${d.id}" ${d.id === item.parentId ? 'selected' : ''}>🗄️ ${esc(d.name)}</option>`);
      walk(d.id, 1);
    });
    const d = await ask(`Move “${item.name}”`, `<label>Move to<select name="to">${options.join('')}</select></label>`, 'Move');
    if (!d || !d.to || d.to === item.parentId) return;
    item.parentId = d.to;
    await save(item);
    toast(`Moved to ${state.items.get(d.to).name}`);
    render();
  }

  async function remove(item) {
    const inner = descendants(item.id);
    const extra = inner.length ? ` and the ${inner.length} item${inner.length > 1 ? 's' : ''} inside it` : '';
    const d = await ask('Delete?', `<p>Permanently delete <strong>${esc(item.name)}</strong>${extra}? This can't be undone.</p>`, 'Delete');
    if (!d) return;
    const ids = [item.id, ...inner.map(i => i.id)];
    try { await DB.remove(ids); } catch { /* storage blocked */ }
    ids.forEach(id => state.items.delete(id));
    if (ids.includes(state.current)) state.current = item.parentId || drawers()[0]?.id || null;
    render();
  }

  // Inside a claude.ai page, downloads go through the viewer's save prompt;
  // in a normal browser tab a plain link click works.
  async function saveFile(filename, blob) {
    const downloads = window.claude?.use ? await window.claude.use('downloads') : null;
    if (downloads) {
      try { await downloads.save({ filename, data: blob }); }
      catch (err) {
        if (err?.code === 'rejected_extension') toast('This file type can’t be downloaded here');
        else if (err?.code !== 'declined') toast('Download isn’t available here');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function download(doc) {
    if (doc.blob) saveFile(doc.name, doc.blob);
    else saveFile(`${doc.name}.txt`, new Blob([doc.text ?? ''], { type: 'text/plain' }));
  }

  // ---------- viewer ----------
  let viewerUrl;
  async function view(doc) {
    const v = $('#viewer');
    const body = $('#viewerBody');
    $('#viewerTitle').textContent = doc.name;
    $('#viewerMeta').textContent = [fmtSize(doc.size), `Added ${fmtDate(doc.createdAt)}`, path(doc.parentId).map(p => p.name).join(' › ')].filter(Boolean).join(' · ');
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
    const m = doc.mime || '';
    let html;
    if (doc.text != null && !doc.blob) {
      html = `<pre class="note-view">${esc(doc.text) || '<span class="muted">(empty note)</span>'}</pre>`;
    } else {
      viewerUrl = URL.createObjectURL(doc.blob);
      if (m.startsWith('image/')) html = `<img src="${viewerUrl}" alt="${esc(doc.name)}">`;
      else if (m === 'application/pdf') html = `<iframe src="${viewerUrl}" title="${esc(doc.name)}"></iframe>`;
      else if (m.startsWith('video/')) html = `<video src="${viewerUrl}" controls></video>`;
      else if (m.startsWith('audio/')) html = `<audio src="${viewerUrl}" controls></audio>`;
      else if (m.startsWith('text/') || /json|xml|javascript/.test(m)) html = `<pre class="note-view">${esc(await doc.blob.text())}</pre>`;
      else html = `<div class="empty"><div class="big">${docIcon(doc)}</div><p>No preview for this file type.</p><button class="btn primary" data-dl>Download</button></div>`;
    }
    const tags = (doc.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    const note = doc.blob && doc.note ? `<p class="doc-note">${esc(doc.note)}</p>` : '';
    body.innerHTML = (tags || note ? `<div class="viewer-info">${tags}${note}</div>` : '') + html;
    body.querySelector('[data-dl]')?.addEventListener('click', () => download(doc));
    $('#viewerDownload').onclick = () => download(doc);
    $('#viewerEdit').onclick = async () => { v.close(); await editDoc(doc); };
    if (!v.open) v.showModal();
  }

  // ---------- rendering ----------
  function open(id) {
    state.current = id;
    state.query = '';
    $('#search').value = '';
    document.body.classList.remove('show-cabinet');
    render();
  }

  function renderDrawers() {
    const activeDrawer = path(state.current)[0]?.id;
    $('#drawerList').innerHTML = drawers().map(d => {
      const count = descendants(d.id).filter(i => i.kind === 'doc').length;
      return `<li><button class="drawer ${d.id === activeDrawer ? 'active' : ''}" data-open="${d.id}" data-drop="${d.id}">
        <span class="label-holder" style="--c:${d.color}"><span class="label">${esc(d.name)}</span></span>
        <span class="handle"></span>
        <span class="count">${count}</span>
      </button></li>`;
    }).join('');
  }

  function renderBreadcrumbs() {
    if (state.query) { $('#breadcrumbs').innerHTML = `<span>Search results for “${esc(state.query)}”</span>`; return; }
    $('#breadcrumbs').innerHTML = path(state.current).map((p, i, arr) =>
      i === arr.length - 1 ? `<span>${esc(p.name)}</span>` : `<button class="link" data-open="${p.id}">${esc(p.name)}</button><span class="sep">›</span>`).join('');
  }

  function renderToolbar() {
    const tb = $('#toolbar');
    if (state.query || !state.current) { tb.innerHTML = ''; return; }
    const cur = state.items.get(state.current);
    tb.innerHTML = `
      <button class="btn primary" data-act="upload">⬆ Add files</button>
      <button class="btn" data-act="folder">📁 New folder</button>
      <button class="btn" data-act="note">📝 New note</button>
      <span class="spacer"></span>
      <select id="sortSel" aria-label="Sort by">
        <option value="name">Name</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="size">Size</option>
      </select>
      <button class="icon-btn" data-menu="${cur.id}" title="${cur.kind} options">⋯</button>`;
    $('#sortSel').value = state.sort;
  }

  function sortItems(list) {
    const s = state.sort;
    return list.sort((a, b) =>
      s === 'newest' ? b.createdAt - a.createdAt :
      s === 'oldest' ? a.createdAt - b.createdAt :
      s === 'size' ? (b.size || 0) - (a.size || 0) :
      a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  const folderCard = f => {
    const n = descendants(f.id).filter(i => i.kind === 'doc').length;
    return `<div class="folder" data-open="${f.id}" data-drop="${f.id}" draggable="true" data-drag="${f.id}" tabindex="0" style="--c:${f.color || '#d68910'}">
      <div class="folder-tab"></div>
      <div class="folder-body"><div class="folder-name">${esc(f.name)}</div><div class="muted">${n} file${n === 1 ? '' : 's'}</div></div>
      <button class="icon-btn more" data-menu="${f.id}" aria-label="Folder options">⋯</button>
    </div>`;
  };

  const docRow = (d, showPath) => `<div class="doc" data-view="${d.id}" draggable="true" data-drag="${d.id}" tabindex="0">
      <span class="doc-icon">${docIcon(d)}</span>
      <span class="doc-main">
        <span class="doc-name">${esc(d.name)}</span>
        <span class="muted small">${showPath ? esc(path(d.parentId).map(p => p.name).join(' › ')) + ' · ' : ''}${fmtSize(d.size)} · ${fmtDate(d.createdAt)}</span>
      </span>
      <span class="doc-tags">${(d.tags || []).map(t => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</span>
      <button class="icon-btn more" data-menu="${d.id}" aria-label="File options">⋯</button>
    </div>`;

  function renderContent() {
    const c = $('#content');
    if (state.query) {
      const q = state.query.toLowerCase();
      const hits = [...state.items.values()].filter(i => i.kind !== 'drawer' && (
        i.name.toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.includes(q)) ||
        (i.note || '').toLowerCase().includes(q) ||
        (i.text || '').toLowerCase().includes(q)));
      const folders = sortItems(hits.filter(h => h.kind === 'folder'));
      const docs = sortItems(hits.filter(h => h.kind === 'doc'));
      c.innerHTML = hits.length
        ? `${folders.length ? `<div class="folders">${folders.map(folderCard).join('')}</div>` : ''}<div class="docs">${docs.map(d => docRow(d, true)).join('')}</div>`
        : `<div class="empty"><div class="big">🔍</div><p>Nothing matches “${esc(state.query)}”.</p></div>`;
      return;
    }
    if (!state.current) {
      c.innerHTML = `<div class="empty"><div class="big">🗄️</div><h2>Your cabinet is empty</h2><p>Start by adding a drawer — something like “Taxes”, “Medical”, or “Home”.</p><button class="btn primary" data-act="drawer">+ New drawer</button></div>`;
      return;
    }
    const kids = children(state.current);
    const folders = sortItems(kids.filter(k => k.kind === 'folder'));
    const docs = sortItems(kids.filter(k => k.kind === 'doc'));
    if (!kids.length) {
      c.innerHTML = `<div class="empty"><div class="big">📂</div><p>This ${state.items.get(state.current).kind} is empty.</p><p class="muted">Drag files here, or use the buttons above.</p></div>`;
      return;
    }
    c.innerHTML = `${folders.length ? `<div class="folders">${folders.map(folderCard).join('')}</div>` : ''}${docs.length ? `<div class="docs">${docs.map(d => docRow(d, false)).join('')}</div>` : ''}`;
  }

  function render() {
    if (state.current && !state.items.has(state.current)) state.current = drawers()[0]?.id || null;
    renderDrawers();
    renderBreadcrumbs();
    renderToolbar();
    renderContent();
  }

  // ---------- item menu ----------
  function showMenu(item, anchor) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const entries = item.kind === 'doc'
      ? [['Open', () => view(item)], ['Details & tags', () => editDoc(item)], ['Download', () => download(item)], ['Move…', () => move(item)], ['Delete', () => remove(item), 'danger']]
      : [['Rename / color', () => rename(item)], ...(item.kind === 'folder' ? [['Move…', () => move(item)]] : []), ['Delete', () => remove(item), 'danger']];
    entries.forEach(([label, fn, cls]) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => { closeMenu(); fn(); };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  }
  const closeMenu = () => document.querySelectorAll('.menu').forEach(m => m.remove());

  // ---------- backup ----------
  const blobToDataUrl = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });

  async function exportAll() {
    const items = [];
    for (const it of state.items.values()) {
      const copy = { ...it };
      if (it.blob) copy.blob = await blobToDataUrl(it.blob);
      items.push(copy);
    }
    const blob = new Blob([JSON.stringify({ app: 'filing-cabinet', version: 1, exportedAt: new Date().toISOString(), items })], { type: 'application/json' });
    saveFile(`filing-cabinet-backup-${new Date().toISOString().slice(0, 10)}.json`, blob);
  }

  async function importAll(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a valid backup'); return; }
    if (data?.app !== 'filing-cabinet' || !Array.isArray(data.items)) { toast('That file isn’t a Filing Cabinet backup'); return; }
    const items = await Promise.all(data.items.map(async it => (
      typeof it.blob === 'string' ? { ...it, blob: await (await fetch(it.blob)).blob() } : it)));
    try { await DB.putMany(items); } catch { /* storage blocked */ }
    items.forEach(it => state.items.set(it.id, it));
    toast(`Restored ${items.length} items`);
    if (!state.current) state.current = drawers()[0]?.id || null;
    render();
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t.closest('.menu')) closeMenu();
    if (!t.closest('#cabinet, #menuBtn')) document.body.classList.remove('show-cabinet');
    const menuBtn = t.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); showMenu(state.items.get(menuBtn.dataset.menu), menuBtn); return; }
    const tag = t.closest('[data-tag]');
    if (tag) { e.stopPropagation(); $('#search').value = tag.dataset.tag; state.query = tag.dataset.tag; render(); return; }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'upload') return $('#fileInput').click();
    if (act === 'folder') return newFolder();
    if (act === 'note') return newNote();
    if (act === 'drawer') return newDrawer();
    const openEl = t.closest('[data-open]');
    if (openEl) return open(openEl.dataset.open);
    const viewEl = t.closest('[data-view]');
    if (viewEl) return view(state.items.get(viewEl.dataset.view));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
    if (e.key === 'Enter' && e.target.matches('.folder, .doc')) e.target.click();
    if (e.key === '/' && !e.target.matches('input, textarea')) { e.preventDefault(); $('#search').focus(); }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'sortSel') { state.sort = e.target.value; renderContent(); }
  });

  $('#dialogCancel').onclick = () => $('#dialog').close('cancel');
  $('#addDrawerBtn').onclick = newDrawer;
  $('#menuBtn').onclick = () => document.body.classList.toggle('show-cabinet');
  $('#fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#search').oninput = e => { state.query = e.target.value.trim(); render(); };
  $('#exportBtn').onclick = exportAll;
  $('#importInput').onchange = e => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };
  $('#viewerClose').onclick = () => $('#viewer').close();
  $('#viewer').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  // Drag & drop: files from the desktop, or items onto folders/drawers.
  let dragId = null;
  let dragDepth = 0;
  document.addEventListener('dragstart', e => {
    const el = e.target.closest?.('[data-drag]');
    if (!el) return;
    dragId = el.dataset.drag;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  document.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over')); });
  document.addEventListener('dragenter', e => {
    if (!dragId && e.dataTransfer.types.includes('Files') && state.current) { dragDepth++; $('#dropHint').hidden = false; }
  });
  document.addEventListener('dragleave', e => {
    if (!dragId && e.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; }
  });
  document.addEventListener('dragover', e => {
    const target = e.target.closest?.('[data-drop]');
    document.querySelectorAll('.drop-over').forEach(x => x !== target && x.classList.remove('drop-over'));
    if (target && target.dataset.drop !== dragId) target.classList.add('drop-over');
    if (target || e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
    const targetId = e.target.closest?.('[data-drop]')?.dataset.drop;
    if (dragId) {
      const item = state.items.get(dragId);
      const banned = new Set([dragId, ...descendants(dragId).map(i => i.id)]);
      if (item && targetId && !banned.has(targetId) && targetId !== item.parentId) {
        item.parentId = targetId;
        await save(item);
        toast(`Moved to ${state.items.get(targetId).name}`);
        render();
      }
      dragId = null;
    } else if (e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files, targetId || state.current);
    }
  });

  // ---------- boot ----------
  (async () => {
    try {
      (await DB.all()).forEach(it => state.items.set(it.id, it));
    } catch {
      toast('This browser is blocking storage, so files won’t be kept after you close the page');
    }
    state.current = drawers()[0]?.id || null;
    render();
  })();
})();
