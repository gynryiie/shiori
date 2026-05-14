const SITES = {
  'nhentai.net': { name: 'nhentai',   galleryUrl: 'https://nhentai.net/g/{id}/{page}/',         canDownload: true,  idRegex: /\/g\/(\d+)/ },
  'hitomi.la':   { name: 'Hitomi.la', galleryUrl: 'https://hitomi.la/reader/{id}.html#{page}',  canDownload: false, idRegex: /\/reader\/(\d+)\.html/ },
};

function siteGalleryUrl(key, galleryId, page) {
  const site = SITES[key];
  if (!site) return '';
  return site.galleryUrl.replace('{id}', galleryId).replace('{page}', page);
}

// Returns { siteKey, galleryId } parsed from a full URL or bare hostname.
function parseSiteUrl(input) {
  if (!input) return { siteKey: '', galleryId: null };
  const s = input.trim();
  let hostname = '';
  try {
    const url = new URL(s.includes('://') ? s : 'https://' + s);
    hostname = url.hostname.replace(/^www\./, '');
  } catch {
    hostname = s.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
  const site = SITES[hostname];
  const galleryId = site?.idRegex ? (s.match(site.idRegex)?.[1] ?? null) : null;
  return { siteKey: hostname, galleryId };
}

function normalizeSiteKey(input) {
  const { siteKey } = parseSiteUrl(input);
  return siteKey;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

let allGalleries = [];
let filtered     = [];
let currentPage  = 1;
const PAGE_SIZE  = 30;

// ── Card rendering ──

function buildCardTags(tags) {
  if (!tags || tags.length === 0) return '<div class="card-tags"></div>';
  const artists = tags.filter(t => t.type === 'artist');
  const regular = tags.filter(t => t.type === 'tag');
  const chips = [
    ...artists.map(t => `<span class="card-tag artist" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...regular.map(t => `<span class="card-tag" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
  ];
  return `<div class="card-tags">${chips.join('')}</div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderGrid(galleries) {
  const grid = document.getElementById('grid');

  if (galleries.length === 0) {
    grid.innerHTML = '<div class="empty">No galleries found.<br>Browse nhentai to start caching images.</div>';
    return;
  }

  grid.innerHTML = '';
  for (const g of galleries) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.galleryId = g.id;

    const thumbInner = g.cover
      ? `<img class="card-thumb" src="${g.cover}" alt="">`
      : `<div class="card-thumb-placeholder">📁</div>`;

    const titleHtml = g.title
      ? `<div class="card-title" data-original="${escHtml(g.title)}">${escHtml(g.title)}</div>`
      : '';

    const cachedCount = g.count;
    const totalCount = g.numPages ? ` / ${g.numPages}` : '';
    const metaLine = `${cachedCount}${totalCount} pages · ${formatSize(g.size)}`;

    const tagHtml = buildCardTags(g.tags);

    const canDownload  = SITES[g.source]?.canDownload === true;
    const isComplete   = g.numPages > 0 && g.count >= g.numPages;
    const showDl       = canDownload && !isComplete;
    const visitUrl     = siteGalleryUrl(g.source, g.id, 1);
    const siteName     = g.source ? (SITES[g.source]?.name || g.source) : '';
    const openTitle    = visitUrl
      ? `${siteName}: ${visitUrl}\n(shift-click to edit source)`
      : 'Set source site';
    const dlTitle      = g.numPages ? `Download all ${g.numPages} pages` : 'Fetch metadata & download all';

    const actionsHtml = `
      <div class="card-actions">
        <button class="card-btn card-btn-dl" data-id="${g.id}" title="${dlTitle}" style="${showDl ? '' : 'display:none'}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/></svg></button>
        <button class="card-btn card-btn-open" data-id="${g.id}" title="${openTitle}">${g.source ? `<img src="https://www.google.com/s2/favicons?domain=${g.source}&sz=16" style="width:12px;height:12px;pointer-events:none;" onerror="this.outerHTML='<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'11\\' height=\\'11\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><path d=\\'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\\'/><path d=\\'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\\'/></svg>'">` : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'}</button>
        <button class="card-btn card-btn-export" data-id="${g.id}" title="Export gallery"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="m15 13-3 3-3-3"/></svg></button>
        <button class="card-btn card-btn-del" data-id="${g.id}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;

    const bodyHtml = `
      <div class="card-body">
        <div class="card-id-row">
          <div class="card-id" data-original="${g.id}">#${g.id}</div>
          ${actionsHtml}
        </div>
        ${titleHtml}
        <div class="card-meta">${metaLine}</div>
        ${tagHtml}
      </div>`;

    const overlayBodyHtml = `
      <div class="card-body">
        <div class="card-id-row">
          <div class="card-id" data-original="${g.id}">#${g.id}</div>
          ${actionsHtml}
        </div>
        ${titleHtml}
        <div class="card-meta">${metaLine}</div>
        ${tagHtml}
        <div class="card-progress" id="prog-${g.id}">
          <div class="card-prog-track"><div class="card-prog-fill" id="progfill-${g.id}"></div></div>
          <span class="card-prog-label" id="proglabel-${g.id}"></span>
        </div>
      </div>`;

    card.innerHTML = `
      <a class="card-thumb-wrap" href="reader.html?g=${g.id}">
        ${thumbInner}
      </a>
      <div class="card-content">
        ${bodyHtml}
      </div>
      <div class="card-hover-overlay">
        <a class="card-thumb-wrap" href="reader.html?g=${g.id}">
          ${thumbInner}
        </a>
        ${overlayBodyHtml}
      </div>
    `;

    card.querySelectorAll('.card-btn-del').forEach(b => b.addEventListener('click', async (e) => {
      if (!e.shiftKey && !confirm(`Delete all cached images for gallery #${g.id}?`)) return;
      await sendMsg({ type: 'DELETE_GALLERY', galleryId: g.id });
      allGalleries = allGalleries.filter(x => x.id !== g.id);
      applyFilters();
      updateHeaderStats();
      chrome.storage.local.remove('libraryCache');
    }));

    const exportSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="m15 13-3 3-3-3"/></svg>';
    card.querySelectorAll('.card-btn-export').forEach(b => b.addEventListener('click', async () => {
      const btns = card.querySelectorAll('.card-btn-export');
      if ([...btns].some(x => x.disabled)) return;
      btns.forEach(x => { x.disabled = true; x.innerHTML = '…'; });
      try {
        await exportGalleryZip(g.id);
      } catch (err) {
        alert('Export failed: ' + err.message);
      } finally {
        card.querySelectorAll('.card-btn-export').forEach(x => { x.disabled = false; x.innerHTML = exportSvg; });
      }
    }));

    card.querySelectorAll('.card-btn-dl').forEach(b => b.addEventListener('click', async () => {
      const btns = card.querySelectorAll('.card-btn-dl');
      if ([...btns].some(x => x.disabled)) return;
      btns.forEach(x => { x.disabled = true; x.innerHTML = '…'; });

      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);

      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = 'Fetching metadata…';

      await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: g.id });
    }));

    card.querySelectorAll('.card-btn-open').forEach(b => b.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const curVisitUrl = siteGalleryUrl(g.source, g.id, 1);
      if (!curVisitUrl || e.shiftKey) {
        const prefill = curVisitUrl || (g.source ? siteGalleryUrl(g.source, g.id, 1) : '');
        const input = prompt('Source URL or site (e.g. https://nhentai.net/g/610529/1/):', prefill);
        if (input === null) return;

        const { siteKey, galleryId: remoteId } = parseSiteUrl(input);
        const newGalleryId = remoteId && remoteId !== g.id ? remoteId : null;

        const resp = await sendMsg({
          type: 'SET_SOURCE', galleryId: g.id, source: siteKey,
          ...(newGalleryId ? { newGalleryId } : {})
        });
        if (!resp?.ok) return;

        const finalId   = resp.newGalleryId || g.id;
        const visitUrl  = siteGalleryUrl(siteKey, finalId, 1);
        const siteName  = siteKey ? (SITES[siteKey]?.name || siteKey) : '';
        g.source = siteKey;
        if (newGalleryId) g.id = finalId;

        btn.style.opacity = visitUrl ? '' : '0.4';
        btn.title = visitUrl
          ? `${siteName}: ${visitUrl}\n(shift-click to edit source)`
          : 'Set source site';

        // Force a full re-render so title/tags/cover from the metadata fetch appear immediately.
        loadAll(true, true);
      } else {
        window.open(curVisitUrl, '_blank');
      }
    }));

    grid.appendChild(card);
  }

  if (safeMode) applyGibberishToGrid();
}

// ── Progress updates from background ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CACHE_PROGRESS') return;

  const { galleryId, done, total, skipped, status, error } = msg;
  const fillEl  = document.getElementById(`progfill-${galleryId}`);
  const labelEl = document.getElementById(`proglabel-${galleryId}`);
  const progEl  = document.getElementById(`prog-${galleryId}`);
  const card    = document.querySelector(`[data-gallery-id="${galleryId}"]`);
  const dlBtns  = card ? [...card.querySelectorAll('.card-btn-dl')] : [];

  if (status === 'error') {
    if (labelEl) labelEl.textContent = `Error: ${error || 'unknown'}`;
    dlBtns.forEach(b => { b.disabled = false; b.textContent = '↓'; });
    return;
  }

  if (status === 'downloading') {
    const { downloaded, total: dlTotal } = msg;
    if (fillEl) {
      if (dlTotal > 0) {
        fillEl.classList.remove('indeterminate');
        // Reserve last 10% for extract phase
        fillEl.style.width = Math.min(90, Math.round((downloaded / dlTotal) * 90)) + '%';
      } else {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '';
      }
    }
    if (labelEl) {
      const mb      = (downloaded / 1048576).toFixed(1);
      const totalMb = dlTotal > 0 ? ` / ${(dlTotal / 1048576).toFixed(1)}` : '';
      labelEl.textContent = `↓ ${mb}${totalMb} MB`;
    }
    return;
  }

  if (status === 'extracting') {
    if (fillEl) { fillEl.classList.remove('indeterminate'); fillEl.style.width = '100%'; }
    if (labelEl) labelEl.textContent = 'Extracting…';
    return;
  }

  if (status === 'started') {
    if (fillEl) fillEl.style.width = '0%';
    if (labelEl) labelEl.textContent = `0 / ${total}`;
    return;
  }

  if (status === 'progress' || status === 'done') {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (fillEl) {
      fillEl.style.width = pct + '%';
      if (status === 'done') fillEl.classList.add('done');
    }
    const skippedNote = skipped > 0 ? ` (${skipped} already cached)` : '';
    if (labelEl) labelEl.textContent = status === 'done'
      ? `Done — ${done}/${total} pages${skippedNote}`
      : `${done} / ${total}${skippedNote}`;
  }

  if (status === 'done') {
    dlBtns.forEach(b => { b.disabled = false; b.textContent = '✓'; b.classList.add('done'); });
    if (progEl) progEl.closest('.card-body')?.classList.remove('downloading');
    setTimeout(() => loadAll(), 1500);
  }
});

// ── Filters / sort ──

function applyFilters() {
  const terms = document.getElementById('searchBox').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sort  = document.getElementById('sortSelect').value;

  filtered = [...allGalleries];
  if (terms.length) {
    filtered = filtered.filter(g => terms.every(term => {
      if (g.id.includes(term)) return true;
      if (g.title && g.title.toLowerCase().includes(term)) return true;
      if (g.tags && g.tags.some(t => t.name.toLowerCase().includes(term))) return true;
      return false;
    }));
  }

  filtered.sort((a, b) => {
    if (sort === 'recent') return (b.latestAt || 0) - (a.latestAt || 0);
    if (sort === 'size')   return b.size - a.size;
    if (sort === 'count')  return b.count - a.count;
    if (sort === 'id')     return parseInt(b.id) - parseInt(a.id);
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageSlice = filtered.slice(start, start + PAGE_SIZE);

  renderGrid(pageSlice);
  renderPagination(currentPage, totalPages);
}

function renderPagination(page, totalPages) {
  const el = document.getElementById('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const nums = _pageNumbers(page, totalPages);
  let html = `<button class="page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>←</button>`;
  for (const n of nums) {
    if (n === null) {
      html += `<span class="page-ellipsis">…</span>`;
    } else {
      html += `<button class="page-btn${n === page ? ' active' : ''}" data-page="${n}">${n}</button>`;
    }
  }
  html += `<button class="page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>→</button>`;

  el.innerHTML = html;
  el.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page);
      applyFilters();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// Returns page numbers to show, with null for ellipsis gaps.
function _pageNumbers(current, total) {
  const show = new Set([1, total]);
  for (let i = Math.max(1, current - 1); i <= Math.min(total, current + 1); i++) show.add(i);
  const sorted = [...show].sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) result.push(null);
    result.push(p);
    prev = p;
  }
  return result;
}

function updateHeaderStats() {
  const totalImages = allGalleries.reduce((s, g) => s + g.count, 0);
  const totalSize   = allGalleries.reduce((s, g) => s + g.size, 0);
  document.getElementById('hTotalGalleries').textContent = allGalleries.length;
  document.getElementById('hTotalImages').textContent    = totalImages;
  document.getElementById('hTotalSize').textContent      = formatSize(totalSize);
}

async function loadAll(skipCache = false, forceRefresh = false) {
  // Render stale data from storage instantly while the SW wakes up.
  if (!skipCache) {
    const stored = await new Promise(r => chrome.storage.local.get(['libraryCache'], r));
    if (stored.libraryCache && stored.libraryCache.galleries && stored.libraryCache.galleries.length > 0) {
      allGalleries = stored.libraryCache.galleries; // no covers yet
      updateHeaderStats();
      applyFilters();
    }
  }

  const data = await sendMsg({ type: 'GET_ALL_GALLERIES' });
  if (!data) {
    if (allGalleries.length === 0) {
      document.getElementById('grid').innerHTML = '<div class="empty">Error loading cache.</div>';
    }
    return;
  }

  // Check whether the gallery set — or any gallery's stats — changed.
  const prevIds  = new Set(allGalleries.map(g => g.id));
  const freshIds = new Set(data.galleries.map(g => g.id));
  const sameSet  = !forceRefresh &&
                   prevIds.size > 0 && prevIds.size === freshIds.size &&
                   [...prevIds].every(id => freshIds.has(id)) &&
                   data.galleries.every(g => {
                     const prev = allGalleries.find(p => p.id === g.id);
                     return prev && prev.count === g.count && prev.size === g.size;
                   });

  allGalleries = data.galleries;
  updateHeaderStats();

  if (sameSet) {
    // Same galleries: patch covers in-place so there's no scroll reset or flash.
    _patchCovers(data.galleries);
  } else {
    // Gallery list changed (or forced) — full re-render.
    applyFilters();
  }

  chrome.storage.local.set({
    libraryCache: { galleries: data.galleries, totalImages: data.totalImages, totalSize: data.totalSize }
  });
}

// Swap cover images into already-rendered gallery cards without touching the rest
// of the DOM. Avoids scroll reset and card rebuild when only covers changed.
function _patchCovers(galleries) {
  for (const g of galleries) {
    if (!g.cover) continue;
    const card = document.querySelector(`.card[data-gallery-id="${g.id}"]`);
    if (!card) continue;
    const wrap = card.querySelector('.card-thumb-wrap');
    if (!wrap) continue;
    const existing = wrap.querySelector('.card-thumb');
    if (existing) {
      existing.src = g.cover;
    } else {
      wrap.innerHTML = `<img class="card-thumb" src="${g.cover}" alt="">`;
    }
  }
}

// ── Local CBZ import (processed in-page; no large-buffer IPC to background) ──

const _DB_NAME    = 'nhentai-image-cache';
const _DB_VERSION = 4;
const _STORE      = 'images';
const _META_STORE = 'metadata';

function _openImportDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_DB_NAME, _DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (e.oldVersion < 3) {
        if (db.objectStoreNames.contains(_STORE)) db.deleteObjectStore(_STORE);
        const s = db.createObjectStore(_STORE, { keyPath: 'url' });
        s.createIndex('mediaId',   'mediaId',   { unique: false });
        s.createIndex('galleryId', 'galleryId', { unique: false });
      }
      if (!db.objectStoreNames.contains(_META_STORE))
        db.createObjectStore(_META_STORE, { keyPath: 'galleryId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _u8ToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

async function _inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const w  = ds.writable.getWriter();
  const r  = ds.readable.getReader();
  w.write(data); w.close();
  const chunks = [];
  for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function _unzip(buffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) throw new Error('Not a valid ZIP');
  const count = view.getUint16(eocd + 10, true);
  const cdOff = view.getUint32(eocd + 16, true);
  const out = [];
  let pos = cdOff;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const cSize  = view.getUint32(pos + 20, true);
    const nLen   = view.getUint16(pos + 28, true);
    const xLen   = view.getUint16(pos + 30, true);
    const cLen   = view.getUint16(pos + 32, true);
    const lOff   = view.getUint32(pos + 42, true);
    const name   = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nLen));
    pos += 46 + nLen + xLen + cLen;
    if (name.endsWith('/')) continue;
    const lfhNLen = view.getUint16(lOff + 26, true);
    const lfhXLen = view.getUint16(lOff + 28, true);
    const start   = lOff + 30 + lfhNLen + lfhXLen;
    const comp    = bytes.slice(start, start + cSize);
    let data;
    if      (method === 0) data = comp;
    else if (method === 8) data = await _inflateRaw(comp);
    else continue;
    out.push({ filename: name, data });
  }
  return out;
}

function _getExistingPageNums(db, gid) {
  return new Promise((resolve, reject) => {
    const pages = new Set();
    const tx  = db.transaction(_STORE, 'readonly');
    const req = tx.objectStore(_STORE).index('galleryId')
                  .openCursor(IDBKeyRange.only(String(gid)));
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) {
        const m = cur.value.url.match(/\/(\d+)\.\w+$/);
        if (m) pages.add(parseInt(m[1]));
        cur.continue();
      } else resolve(pages);
    };
    req.onerror = () => reject(req.error);
  });
}

async function _clearGalleryImages(db, gid) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(_STORE, 'readwrite');
    const req = tx.objectStore(_STORE).index('galleryId')
                  .openCursor(IDBKeyRange.only(String(gid)));
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { cur.delete(); cur.continue(); } else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

function _idbPut(db, store, record) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}



function triggerImport() {
  document.getElementById('cbzFileInput').click();
}

document.getElementById('uploadCbzBtn').addEventListener('click', triggerImport);

async function importSingleFile(file, gid) {
  const nameNoExt = file.name.replace(/\.[^.]+$/, '');

  if (!allGalleries.find(g => g.id === gid)) {
    allGalleries.unshift({ id: gid, title: nameNoExt, count: 0, size: 0, latestAt: Date.now() });
    applyFilters();
  }

  const progEl  = document.getElementById(`prog-${gid}`);
  const fillEl  = document.getElementById(`progfill-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const card    = document.querySelector(`[data-gallery-id="${gid}"]`);
  const dlBtn   = card ? card.querySelector('.card-btn-dl') : null;

  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };
  const setFill  = (pct) => { if (fillEl)  fillEl.style.width = pct + '%'; };
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel('Reading file…');
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (err) { setLabel('Error: could not read file.'); return; }

  setLabel('Parsing ZIP…');
  let entries;
  try { entries = await _unzip(buffer); }
  catch (err) { setLabel('Error: ' + err.message); return; }

  const imgs = entries
    .filter(en => /\.(jpe?g|png|webp|gif)$/i.test(en.filename))
    .sort((a, b) => {
      const na = parseInt(a.filename.match(/(\d+)/)?.[1] || '0');
      const nb = parseInt(b.filename.match(/(\d+)/)?.[1] || '0');
      return na - nb;
    });

  if (imgs.length === 0) { setLabel('Error: no images found in CBZ.'); return; }

  const total    = imgs.length;
  const pageExts = imgs.map(en => en.filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg');

  setLabel('Opening cache DB…');
  let db;
  try { db = await _openImportDB(); }
  catch (err) { setLabel('Error: could not open DB.'); return; }

  await _idbPut(db, _META_STORE, {
    galleryId: gid,
    titleEnglish: nameNoExt, titleJapanese: '', titlePretty: nameNoExt,
    tags: [], numPages: 0, numFavorites: 0,
    uploadDate: Math.floor(Date.now() / 1000),
    pageExts, fetchedAt: Date.now(), isLocalImport: true, source: ''
  });

  const existingPages = await _getExistingPageNums(db, gid);
  setFill(0); setLabel(`0 / ${total}`);

  let done = 0, skipped = 0, coverPatched = false;
  for (let i = 0; i < imgs.length; i++) {
    const en = imgs[i];
    const m = en.filename.match(/\.(jpe?g|png|webp|gif)$/i);
    if (!m) continue;
    const pageNum = i + 1;
    if (existingPages.has(pageNum)) { skipped++; done++; setFill(Math.round((done / total) * 100)); continue; }
    const ext     = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const mime    = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png'
                  : ext === 'webp' ? 'image/webp' : 'image/gif';
    const url     = `local://${gid}/${pageNum}.${ext}`;
    const dataUrl = `data:${mime};base64,` + _u8ToB64(en.data);
    await _idbPut(db, _STORE, {
      url, dataUrl, galleryId: gid,
      cachedAt: Date.now(), size: Math.round(dataUrl.length * 0.75)
    });
    if (!coverPatched) {
      coverPatched = true;
      const gEntry = allGalleries.find(g => g.id === gid);
      if (gEntry) gEntry.cover = dataUrl;
      _patchCovers([{ id: gid, cover: dataUrl }]);
    }
    done++;
    setFill(Math.round((done / total) * 100));
    setLabel(`${done} / ${total}`);
  }

  if (fillEl) fillEl.classList.add('done');
  if (dlBtn)  { dlBtn.disabled = false; dlBtn.innerHTML = '✓'; dlBtn.classList.add('done'); }
  const imported = done - skipped;
  setLabel(skipped > 0 ? `Done — ${imported} imported, ${skipped} already cached` : `Done — ${imported}/${total} pages`);
  chrome.runtime.sendMessage({ type: 'FETCH_METADATA', galleryId: gid });
}

document.getElementById('cbzFileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  const base = Date.now();
  for (let i = 0; i < files.length; i++) {
    await importSingleFile(files[i], String(base + i));
  }
  loadAll(true);
});

// ── Debug ZIP export ──

const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _zipCreate(files) {
  const enc = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = _crc32(file.data);
    const size = file.data.length;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);    // method: store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    const cde = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cde.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);   // method: store
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cde.set(nameBytes, 46);

    parts.push(lfh, file.data);
    centralDir.push(cde);
    offset += 30 + nameBytes.length + size;
  }

  const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = parts.reduce((s, p) => s + p.length, 0) + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...centralDir, eocd]) { out.set(p, pos); pos += p.length; }
  return out;
}

async function exportGalleryZip(galleryId) {
  const gid = String(galleryId);
  const db = await _openImportDB();

  const meta = await new Promise((resolve, reject) => {
    const tx = db.transaction(_META_STORE, 'readonly');
    const req = tx.objectStore(_META_STORE).get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  const imageRecords = await new Promise((resolve, reject) => {
    const tx = db.transaction(_STORE, 'readonly');
    const req = tx.objectStore(_STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  imageRecords.sort((a, b) => {
    const pa = parseInt(a.url.match(/\/(\d+)\.\w+$/)?.[1] || '9999');
    const pb = parseInt(b.url.match(/\/(\d+)\.\w+$/)?.[1] || '9999');
    return pa - pb;
  });

  const enc = new TextEncoder();
  const files = [];

  // Full metadata record as stored in DB
  files.push({
    name: 'metadata.json',
    data: enc.encode(JSON.stringify(meta, null, 2))
  });

  // Image index: all DB fields except the dataUrl blobs themselves
  files.push({
    name: 'image_records.json',
    data: enc.encode(JSON.stringify(imageRecords.map(r => ({
      url: r.url,
      mediaId: r.mediaId,
      galleryId: r.galleryId,
      cachedAt: r.cachedAt,
      cachedAtISO: r.cachedAt ? new Date(r.cachedAt).toISOString() : null,
      size: r.size
    })), null, 2))
  });

  // Actual image files
  for (const rec of imageRecords) {
    const m = rec.url.match(/\/(\d+)\.(\w+)$/);
    if (!m || !rec.dataUrl) continue;
    const pageNum = m[1].padStart(4, '0');
    const ext = m[2].toLowerCase();
    const b64 = rec.dataUrl.split(',')[1];
    if (!b64) continue;
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    files.push({ name: `images/${pageNum}.${ext}`, data: bytes });
  }

  const zipBytes = _zipCreate(files);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gallery-${gid}-debug.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Auto-trigger import when opened via the popup "Import" button
if (new URLSearchParams(window.location.search).get('import') === '1') {
  window.addEventListener('load', () => triggerImport(), { once: true });
}

const searchBox   = document.getElementById('searchBox');
const searchClear = document.getElementById('searchClear');

function updateClearBtn() {
  searchClear.classList.toggle('visible', searchBox.value.length > 0);
}

searchBox.addEventListener('input', () => { currentPage = 1; applyFilters(); updateClearBtn(); });
searchClear.addEventListener('click', () => {
  searchBox.value = '';
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  searchBox.focus();
});
document.getElementById('sortSelect').addEventListener('change', () => { currentPage = 1; applyFilters(); });

document.getElementById('grid').addEventListener('click', (e) => {
  const tag = e.target.closest('.card-tag');
  if (!tag) return;
  e.preventDefault();
  e.stopPropagation();
  const name = (tag.dataset.original || tag.textContent).trim();
  const box  = document.getElementById('searchBox');
  const cur  = box.value.trim();
  box.value  = cur ? `${cur} ${name}` : name;
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  box.focus();
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  window.location.href = chrome.runtime.getURL('options.html');
});

// ── Safe Mode ──

const GIBBERISH_POOL = [
  'xelorp','blathnar','quixum','frobzle','wumble','cranlop','dribnak',
  'snorvel','durple','grixon','zibble','wonkle','frumple','drabix',
  'squibble','grompf','twarble','blintz','clongle','frixum','snargle',
  'wobzle','plinkle','glorble','snortle','grumple','blixon','trixon',
  'yarvok','splumf','crelbix','quznak','throble','wibzor','drangle',
  'snorbel','glumfix','twonkle','brixum','florkel','plorbix','snurgal',
  'wramble','draxon','kribzle','glorpan','snuffwix','blavrok','quorple',
];

function randomGibberish(original) {
  const len = original.length;
  const close = GIBBERISH_POOL.filter(w => Math.abs(w.length - len) <= 2);
  const pool  = close.length > 0 ? close : GIBBERISH_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

let safeMode = localStorage.getItem('shiori-safe-mode') === '1';

function applyGibberishToGrid() {
  document.querySelectorAll('.card-tag[data-original]').forEach(tag => {
    tag.textContent = randomGibberish(tag.dataset.original);
  });
  document.querySelectorAll('.card-title[data-original]').forEach(el => {
    el.textContent = el.dataset.original.split(/\s+/).map(w => randomGibberish(w)).join(' ');
  });
  document.querySelectorAll('.card-id[data-original]').forEach(el => {
    el.textContent = '#' + el.dataset.original.replace(/\d/g, () => Math.floor(Math.random() * 10));
  });
}

function restoreTagsInGrid() {
  document.querySelectorAll('.card-tag[data-original]').forEach(tag => {
    tag.textContent = tag.dataset.original;
  });
  document.querySelectorAll('.card-title[data-original]').forEach(el => {
    el.textContent = el.dataset.original;
  });
  document.querySelectorAll('.card-id[data-original]').forEach(el => {
    el.textContent = '#' + el.dataset.original;
  });
}

function setSafeMode(enabled) {
  safeMode = enabled;
  localStorage.setItem('shiori-safe-mode', enabled ? '1' : '0');
  document.body.classList.toggle('safe-mode', enabled);
  const btn = document.getElementById('safeBtn');
  if (enabled) {
    btn.classList.add('active');
    btn.title = 'Disable Safe Mode';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    applyGibberishToGrid();
  } else {
    btn.classList.remove('active');
    btn.title = 'Enable Safe Mode (blur content for sharing)';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    restoreTagsInGrid();
  }
}

document.getElementById('safeBtn').addEventListener('click', () => setSafeMode(!safeMode));

// ── Header pin toggle ──
const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
const UNPIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/></svg>';

(function () {
  const pinBtn = document.getElementById('pinBtn');
  const header = document.querySelector('header');
  let pinned = localStorage.getItem('shiori-header-pin') !== '0';

  function applyPin(p) {
    pinned = p;
    header.style.position = p ? 'sticky' : 'relative';
    pinBtn.title = p ? 'Unpin header' : 'Pin header';
    pinBtn.innerHTML = p ? PIN_SVG : UNPIN_SVG;
    localStorage.setItem('shiori-header-pin', p ? '1' : '0');
  }

  applyPin(pinned);
  pinBtn.addEventListener('click', () => applyPin(!pinned));
}());

const burgerBtn = document.getElementById('burgerBtn');
const collapsibleGroup = document.getElementById('collapsibleGroup');
burgerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  collapsibleGroup.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#collapsibleGroup') && !e.target.closest('#burgerBtn'))
    collapsibleGroup.classList.remove('open');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'libraryVersion' in changes) loadAll(true, true);
});

if (safeMode) setSafeMode(true);

// Collapsing card stays above resting cards; actively hovered card beats any collapsing card
// that is below it, but yields to a collapsing card that is above it (still retracting).
(function () {
  const grid = document.getElementById('grid');
  const cardOf = el => el?.closest('.card');

  grid.addEventListener('mouseout', (e) => {
    const from = cardOf(e.target), to = cardOf(e.relatedTarget);
    if (!from || from === to) return;
    // Moving toward a card later in DOM (right or down) → leaving card must stay on top
    // during collapse so its overlay finishes retracting before the entering card wins.
    const goingForward = to && !!(from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING);
    from.style.zIndex = goingForward ? '20' : '10';
    clearTimeout(from._zt);
    from._zt = setTimeout(() => { from.style.zIndex = ''; }, 250);
  });

  grid.addEventListener('mouseover', (e) => {
    const from = cardOf(e.relatedTarget), to = cardOf(e.target);
    if (!to || from === to) return;
    clearTimeout(to._zt);
    to.style.zIndex = '';
  });
}());

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  const fwd = e.key === 'ArrowRight' || e.key === 's' || e.key === 'S' || e.key === 'd' || e.key === 'D';
  const bck = e.key === 'ArrowLeft'  || e.key === 'w' || e.key === 'W' || e.key === 'a' || e.key === 'A';
  if (!fwd && !bck) return;
  e.preventDefault();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const next = Math.max(1, Math.min(totalPages, currentPage + (fwd ? 1 : -1)));
  if (next === currentPage) return;
  currentPage = next;
  applyFilters();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

loadAll();
