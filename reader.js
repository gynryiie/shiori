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

function _openReaderDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nhentai-image-cache', 4);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (e.oldVersion < 3) {
        if (db.objectStoreNames.contains('images')) db.deleteObjectStore('images');
        const s = db.createObjectStore('images', { keyPath: 'url' });
        s.createIndex('mediaId',   'mediaId',   { unique: false });
        s.createIndex('galleryId', 'galleryId', { unique: false });
      }
      if (!db.objectStoreNames.contains('metadata'))
        db.createObjectStore('metadata', { keyPath: 'galleryId' });
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

  // Fetch page list directly from IDB — no service-worker round-trip needed.
  let rawPages = await new Promise((resolve, reject) => {
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  }).catch(() => []);

  // Fallback: full scan when index is unpopulated (older records).
  if (rawPages.length === 0) {
    rawPages = await new Promise((resolve, reject) => {
      const tx  = _readerDb.transaction('images', 'readonly');
      const req = tx.objectStore('images').getAll();
      req.onsuccess = () => resolve((req.result || []).filter(r => String(r.galleryId) === gid));
      req.onerror   = () => reject(req.error);
    }).catch(() => []);
  }

  if (rawPages.length === 0) { showEmpty(); return; }

  pages = rawPages
    .map(r => {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url };
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
    onlineBtn.title   = `Open on ${siteName}`;
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

  scrubber.max   = pages.length;
  scrubber.value = 1;

  buildThumbs();
  setMode('strip', true); // init without animation
  goTo(1);
}

function showEmpty() {
  loadingScreen.style.display = 'none';
  emptyScreen.classList.add('show');
}

// ── Navigation ──
async function goTo(n) {
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
  readerPinBtn.title = p ? 'Unpin header' : 'Pin header';
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
  // disconnect old observer
  if (stripObserver) { stripObserver.disconnect(); stripObserver = null; }
  stripView.innerHTML = '';

  pages.forEach((p, i) => {
    const img = document.createElement('img');
    img.className    = 'page-img';
    img.loading      = 'lazy';
    img.dataset.page = i + 1;
    fetchPageDataUrl(p).then(url => { img.src = url; });
    stripView.appendChild(img);
  });

  // Track current page while scrolling
  rebuildStripObserver();
}

// ── Mode switching ──
function setMode(m, skipAnim) {
  if (stripObserver && m !== 'strip') { stripObserver.disconnect(); stripObserver = null; }

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
      const next = Math.max(1, Math.min(pages.length, currentPage + (fwd ? 1 : -1)));
      const t = stripView.querySelector(`[data-page="${next}"]`);
      if (t) t.scrollIntoView({ behavior: 'smooth' });
    }
    if (e.key === 'Home') { e.preventDefault(); window.scrollTo(0, 0); }
    if (e.key === 'End')  { e.preventDefault(); window.scrollTo(0, document.body.scrollHeight); }
  } else {
    if (fwd) { e.preventDefault(); goTo(currentPage + step); }
    if (bck) { e.preventDefault(); goTo(currentPage - step); }
    if (e.key === 'Home') goTo(1);
    if (e.key === 'End')  goTo(pages.length);
  }
  if (e.key === 't' || e.key === 'T') setThumbsOpen(!thumbsOpen);
  if (e.key === '1') setMode('single');
  if (e.key === '2') setMode('double');
  if (e.key === '3') setMode('strip');
});

init();
