// reader.js — offline gallery reader

const SITES = {
  'nhentai.net': { name: 'nhentai',    galleryUrl: 'https://nhentai.net/g/{id}/{page}/',          idRegex: /\/g\/(\d+)/ },
  'hitomi.la':   { name: 'Hitomi.la',  galleryUrl: 'https://hitomi.la/reader/{id}.html#{page}',   idRegex: /\/reader\/(\d+)\.html/ },
};

function siteGalleryUrl(key, gid, page) {
  const site = SITES[key];
  if (!site) return '';
  return site.galleryUrl.replace('{id}', gid).replace('{page}', page);
}

const READER_PIN_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17H19V15L17 13V8L18 7V5H6V7L7 8V13L5 15V17Z"/></svg>';
const READER_UNPIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v4l-2 2H19"/><path d="M7 7H6V5h8"/></svg>';

const SVG_STRIP  = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h18"/><rect width="18" height="12" x="3" y="6" rx="2"/><path d="M3 22h18"/></svg>';
const SVG_PAGE   = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3v18"/><rect width="12" height="18" x="6" y="3" rx="2"/><path d="M22 3v18"/></svg>';
const SVG_DOUBLE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>';

const params    = new URLSearchParams(location.search);
const galleryId = params.get('g');

let pages       = [];
let currentPage = 1;
let mode        = 'strip'; // 'single' | 'double' | 'strip'
let thumbsOpen    = false;
let scrubVisible  = true;
let lastPageMode  = 'single';
let stripObserver = null;

// Per-page dataUrl cache — avoids re-fetching on navigation or mode switch
const _dataUrlCache = new Map();
let _readerDb = null;
let _stripGen  = 0; // bumped on every buildStrip call to cancel stale loads

function _openReaderDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nhentai-image-cache', 6);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      const s = db.createObjectStore('images', { keyPath: 'url' });
      s.createIndex('mediaId',   'mediaId',   { unique: false });
      s.createIndex('galleryId', 'galleryId', { unique: false });
      db.createObjectStore('metadata',  { keyPath: 'galleryId' });
      db.createObjectStore('galleries', { keyPath: 'galleryId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function fetchPageDataUrl(page) {
  if (_dataUrlCache.has(page.url)) return _dataUrlCache.get(page.url);
  if (!_readerDb) return '';
  const record = await new Promise((resolve, reject) => {
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(page.url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  }).catch(() => null);
  const dataUrl = record ? record.dataUrl : '';
  _dataUrlCache.set(page.url, dataUrl);
  return dataUrl;
}

// ── Elements ──
const loadingScreen = document.getElementById('loadingScreen');
const loadingText   = document.getElementById('loadingText');
const emptyScreen   = document.getElementById('emptyScreen');
const topbar        = document.getElementById('topbar');
const bottombar     = document.getElementById('bottombar');
const viewport      = document.getElementById('viewport');
const singleView    = document.getElementById('singleView');
const doubleView    = document.getElementById('doubleView');
const stripView     = document.getElementById('stripView');
const thumbStrip    = document.getElementById('thumbStrip');
const mainImg       = document.getElementById('mainImg');
const imgLeft       = document.getElementById('imgLeft');
const imgRight      = document.getElementById('imgRight');
const scrubber      = document.getElementById('scrubber');
const scrubWrap     = document.getElementById('scrubWrap');
const scrubToggle   = document.getElementById('scrubToggle');
const scrubberLabel = document.getElementById('scrubberLabel');
const pageCounter   = document.getElementById('pageCounter');
const btnLayoutToggle  = document.getElementById('btnLayoutToggle');
const btnPageSubToggle = document.getElementById('btnPageSubToggle');
const thumbBtn      = document.getElementById('thumbBtn');
const keybindBtn    = document.getElementById('keybindBtn');
const keybindModal  = document.getElementById('keybindModal');
const readerPinBtn  = document.getElementById('readerPinBtn');
const tbGallery     = document.getElementById('tbGallery');
const onlineBtn     = document.getElementById('onlineBtn');
const clickPrev     = document.getElementById('clickPrev');
const clickNext     = document.getElementById('clickNext');
const dClickPrev    = document.getElementById('dClickPrev');
const dClickNext    = document.getElementById('dClickNext');
const scrollTopBtn  = document.getElementById('scrollTopBtn');

// ── Reliable message with retry (wakes sleeping service worker) ──
function sendMsg(msg, retries = 5) {
  return new Promise((resolve) => {
    let attempts = 0;
    function attempt() {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          if (++attempts < retries) { setTimeout(attempt, 300); }
          else { resolve(null); }
          return;
        }
        resolve(resp);
      });
    }
    attempt();
  });
}

// ── Init ──
async function init() {
  if (!galleryId) { showEmpty(); return; }

  tbGallery.textContent = `#${galleryId}`;
  onlineBtn.style.display = 'none';
  document.title        = `Shiori — #${galleryId}`;

  loadingText.textContent = 'Opening database…';
  try { _readerDb = await _openReaderDb(); }
  catch (e) { showEmpty(); return; }

  loadingText.textContent = 'Loading cached pages…';
  const gid = String(galleryId);

  // Fetch page list directly from IDB using key-only cursor — no dataUrls loaded.
  const rawUrls = await new Promise((resolve, reject) => {
    const urls = [];
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').index('galleryId').openKeyCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { urls.push(cursor.primaryKey); cursor.continue(); } else resolve(urls);
    };
    req.onerror = () => reject(req.error);
  }).catch(() => []);

  if (rawUrls.length === 0) { showEmpty(); return; }

  pages = rawUrls
    .map(url => {
      const m = url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url };
    })
    .sort((a, b) => a.pageNum - b.pageNum);

  loadingScreen.style.display = 'none';

  // Fetch metadata for title display (best-effort).
  const meta = await new Promise((resolve) => {
    const tx  = _readerDb.transaction('metadata', 'readonly');
    const req = tx.objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  }).catch(() => null);

  const visitUrl = meta?.source ? siteGalleryUrl(meta.source, galleryId, 1) : '';
  const siteName = meta?.source ? (SITES[meta.source]?.name || meta.source) : '';

  if (visitUrl) {
    onlineBtn.href    = visitUrl;
    onlineBtn.dataset.tip = `Open on ${siteName}`;
    onlineBtn.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${meta.source}&sz=16" style="width:14px;height:14px;vertical-align:middle;pointer-events:none;" onerror="this.outerHTML='↗'">`;
    onlineBtn.style.display = '';
    tbGallery.href   = visitUrl;
    tbGallery.target = '_blank';
    const emptyLink = document.getElementById('emptyLink');
    emptyLink.href        = visitUrl;
    emptyLink.textContent = `Open on ${siteName} →`;
    emptyLink.style.display = '';
  } else {
    document.getElementById('emptyLink').style.display = 'none';
  }

  if (meta && (meta.titlePretty || meta.titleEnglish)) {
    const titleEl = document.getElementById('tbTitle');
    if (titleEl) {
      titleEl.textContent = meta.titlePretty || meta.titleEnglish;
      if (visitUrl) { titleEl.href = visitUrl; titleEl.target = '_blank'; }
    }
  }

  if (pages.length === 0) { showEmpty(); return; }

  scrubber.max   = pages.length;
  scrubber.value = 1;

  buildThumbs();
  const saved = await chrome.storage.local.get(['readerMode', 'readerLastPageMode']);
  if (saved.readerLastPageMode) lastPageMode = saved.readerLastPageMode;
  setMode(saved.readerMode || 'strip', true);
  goTo(1);
}

function showEmpty() {
  loadingScreen.style.display = 'none';
  emptyScreen.classList.add('show');
}

// ── Navigation ──
async function goTo(n) {
  if (!pages.length) return;
  n = Math.max(1, Math.min(pages.length, n));
  currentPage = n;

  // Update navigation UI immediately; image loads asynchronously below
  scrubber.value = n;
  updateCounter();
  highlightThumb(n - 1);
  scrollThumbIntoView(n - 1);

  if (mode === 'single') {
    window.scrollTo(0, 0);
    mainImg.src = '';
    const dataUrl = await fetchPageDataUrl(pages[n - 1]);
    if (currentPage !== n) return;
    mainImg.src = dataUrl;
  } else if (mode === 'double') {
    window.scrollTo(0, 0);
    imgLeft.src = ''; imgRight.src = '';
    const lPage = pages[n - 1];
    const rPage = n < pages.length ? pages[n] : null;
    imgRight.style.display = rPage ? 'block' : 'none';
    const [lUrl, rUrl] = await Promise.all([
      fetchPageDataUrl(lPage),
      rPage ? fetchPageDataUrl(rPage) : Promise.resolve('')
    ]);
    if (currentPage !== n) return;
    imgLeft.src  = lUrl;
    imgRight.src = rUrl;
  }
  // strip: images loaded in buildStrip(); scroll handled separately
}

function updateCounter() {
  const label = `${currentPage} / ${pages.length}`;
  pageCounter.textContent   = label;
  scrubberLabel.textContent = label;
}

function highlightThumb(idx) {
  document.querySelectorAll('.thumb-item').forEach((t, i) => t.classList.toggle('active', i === idx));
}

function scrollThumbIntoView(idx) {
  const t = thumbStrip.children[idx];
  if (t) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// ── Thumbnails ──
function buildThumbs() {
  thumbStrip.innerHTML = '';
  pages.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'thumb-item' + (i === 0 ? ' active' : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    fetchPageDataUrl(p).then(url => { img.src = url; });
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;
    div.appendChild(img);
    div.appendChild(num);
    div.addEventListener('click', () => {
      if (mode === 'strip') {
        // scroll strip to that image
        const target = stripView.querySelector(`[data-page="${i + 1}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
        currentPage = i + 1;
        updateCounter();
        scrubber.value = i + 1;
        highlightThumb(i);
      } else {
        goTo(i + 1);
      }
      if (mode !== 'strip') setThumbsOpen(false);
    });
    thumbStrip.appendChild(div);
  });
}

function setThumbsOpen(open) {
  thumbsOpen = open;
  thumbStrip.classList.toggle('open', open);
  thumbBtn.classList.toggle('active', open);
}

function setKeybindOpen(open) {
  keybindModal.classList.toggle('show', open);
  keybindBtn.classList.toggle('active', open);
}

// ── Header pin ──
let readerPinned = localStorage.getItem('shiori-reader-pin') === '1'; // default: unpinned

function applyScrollLayout() {
  document.documentElement.classList.add('reader-scroll');
  document.body.classList.add('reader-scroll');
  document.body.classList.toggle('reader-unpinned', !readerPinned);
}

function applyReaderPin(p) {
  readerPinned = p;
  readerPinBtn.innerHTML = p ? READER_PIN_SVG : READER_UNPIN_SVG;
  readerPinBtn.dataset.tip = p ? 'Unpin header' : 'Pin header';
  localStorage.setItem('shiori-reader-pin', p ? '1' : '0');
  applyScrollLayout();
}
applyReaderPin(readerPinned);

// ── Strip view ──
function rebuildStripObserver() {
  if (stripObserver) { stripObserver.disconnect(); stripObserver = null; }
  stripObserver = new IntersectionObserver((entries) => {
    let topPage = null;
    entries.forEach(e => {
      if (e.isIntersecting) {
        const pg = parseInt(e.target.dataset.page);
        if (topPage === null || pg < topPage) topPage = pg;
      }
    });
    if (topPage !== null && topPage !== currentPage) {
      currentPage    = topPage;
      scrubber.value = topPage;
      updateCounter();
      highlightThumb(topPage - 1);
    }
  }, { threshold: 0.4, root: null });
  stripView.querySelectorAll('.page-img').forEach(img => stripObserver.observe(img));
}

function buildStrip() {
  if (stripObserver) { stripObserver.disconnect(); stripObserver = null; }
  stripView.innerHTML = '';
  const gen = ++_stripGen;

  // Append all elements first so DOM order is fixed before any async work.
  pages.forEach((p, i) => {
    const img = document.createElement('img');
    img.className    = 'page-img';
    img.dataset.page = i + 1;
    stripView.appendChild(img);
  });

  rebuildStripObserver();

  // Load srcs sequentially top-to-bottom to avoid layout shifts from
  // parallel fetches resolving in arbitrary order.
  (async () => {
    for (let i = 0; i < pages.length; i++) {
      if (_stripGen !== gen) return;
      const url = await fetchPageDataUrl(pages[i]);
      if (_stripGen !== gen) return;
      const img = stripView.querySelector(`[data-page="${i + 1}"]`);
      if (img) img.src = url;
    }
  })();
}

// ── Mode switching ──
function setMode(m, skipAnim) {
  if (stripObserver && m !== 'strip') { stripObserver.disconnect(); stripObserver = null; }
  if (m !== 'strip') scrollTopBtn.classList.remove('visible');

  mode = m;
  applyScrollLayout();

  // Show/hide views
  singleView.classList.toggle('active', m === 'single');
  doubleView.classList.toggle('active', m === 'double');
  stripView.classList.toggle('active',  m === 'strip');

  // Bottom bar: show in single/double, hide in strip
  const showBar = m !== 'strip';
  bottombar.classList.toggle('hidden', !showBar);
  document.body.classList.toggle('bar-hidden', !showBar);

  // Update layout toggle + single/double sub-toggle
  const isPage = m !== 'strip';
  if (isPage) lastPageMode = m;
  chrome.storage.local.set({ readerMode: m, readerLastPageMode: lastPageMode });
  btnLayoutToggle.innerHTML = isPage ? SVG_PAGE : SVG_STRIP;
  btnLayoutToggle.classList.add('active');
  btnPageSubToggle.style.display = isPage ? '' : 'none';
  btnPageSubToggle.innerHTML = m === 'double' ? SVG_DOUBLE : SVG_PAGE;
  btnPageSubToggle.classList.toggle('active', m === 'double');

  if (m === 'strip') {
    buildStrip();
    // Scroll to current page
    if (!skipAnim) {
      setTimeout(() => {
        if (currentPage === 1) { window.scrollTo(0, 0); return; }
        const t = stripView.querySelector(`[data-page="${currentPage}"]`);
        if (t) t.scrollIntoView();
      }, 50);
    }
  } else {
    goTo(currentPage);
  }
}

// ── Scrubber toggle ──
function setScrubVisible(v) {
  scrubVisible = v;
  scrubWrap.classList.toggle('hidden', !v);
  scrubToggle.classList.toggle('active', !v);
}

// ── Events ──
// Single click zones
clickPrev.addEventListener('click', () => goTo(currentPage - 1));
clickNext.addEventListener('click', () => goTo(currentPage + 1));

// Double click zones
dClickPrev.addEventListener('click', () => goTo(currentPage - 2));
dClickNext.addEventListener('click', () => goTo(currentPage + 2));

// Scrubber
scrubber.addEventListener('input', () => {
  const n = parseInt(scrubber.value);
  if (mode === 'strip') {
    const t = stripView.querySelector(`[data-page="${n}"]`);
    if (t) t.scrollIntoView({ behavior: 'smooth' });
    currentPage = n;
    updateCounter();
    highlightThumb(n - 1);
  } else {
    goTo(n);
  }
});

// Scrubber toggle
scrubToggle.addEventListener('click', () => setScrubVisible(!scrubVisible));

// Mode buttons
btnLayoutToggle.addEventListener('click', () => setMode(mode === 'strip' ? lastPageMode : 'strip'));
btnPageSubToggle.addEventListener('click', () => setMode(mode === 'double' ? 'single' : 'double'));

// Scroll-to-top button
scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', () => {
  scrollTopBtn.classList.toggle('visible', mode === 'strip' && window.scrollY > 400);
}, { passive: true });

// Thumbs
thumbBtn.addEventListener('click', () => setThumbsOpen(!thumbsOpen));

// Keybind modal
keybindBtn.addEventListener('click', () => setKeybindOpen(!keybindModal.classList.contains('show')));
keybindModal.addEventListener('click', (e) => {
  if (!e.target.closest('#keybindBox')) setKeybindOpen(false);
});

readerPinBtn.addEventListener('click', () => applyReaderPin(!readerPinned));

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.target === scrubber) return;

  if (e.key === 'Escape' && keybindModal.classList.contains('show')) {
    setKeybindOpen(false);
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    setKeybindOpen(!keybindModal.classList.contains('show'));
    return;
  }

  const step = mode === 'double' ? 2 : 1;
  const fwd  = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 's' || e.key === 'S' || e.key === 'd' || e.key === 'D';
  const bck  = e.key === 'ArrowLeft'  || e.key === 'ArrowUp'   || e.key === 'w' || e.key === 'W' || e.key === 'a' || e.key === 'A';

  if (mode === 'strip') {
    if (fwd || bck) {
      e.preventDefault();
      if (e.shiftKey) {
        if (fwd) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else     window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        const next = Math.max(1, Math.min(pages.length, currentPage + (fwd ? 1 : -1)));
        const t = stripView.querySelector(`[data-page="${next}"]`);
        if (t) t.scrollIntoView({ behavior: 'smooth' });
      }
    }
    if (e.key === 'Home') { e.preventDefault(); window.scrollTo(0, 0); }
    if (e.key === 'End')  { e.preventDefault(); window.scrollTo(0, document.body.scrollHeight); }
  } else {
    if (fwd) { e.preventDefault(); e.shiftKey ? goTo(pages.length) : goTo(currentPage + step); }
    if (bck) { e.preventDefault(); e.shiftKey ? goTo(1) : goTo(currentPage - step); }
    if (e.key === 'Home') goTo(1);
    if (e.key === 'End')  goTo(pages.length);
  }
  if (e.key === 't' || e.key === 'T') setThumbsOpen(!thumbsOpen);
  if (e.key === '1') setMode('single');
  if (e.key === '2') setMode('double');
  if (e.key === '3') setMode('strip');
});

const _tip = document.getElementById('tip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  if (el) {
    _tip.textContent = el.dataset.tip;
    _tip.style.display = 'block';
    const _tipW = _tip.offsetWidth;
    _tip.style.left = Math.min(e.clientX + 14, window.innerWidth - _tipW - 10) + 'px';
    _tip.style.top  = (e.clientY + 16) + 'px';
  } else {
    _tip.style.display = 'none';
  }
});

init();
