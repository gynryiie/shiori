// content.js — injected at document_start so the gallery prefetch begins
// before the HTML parser renders any images.

let cacheEnabled = true;
const pendingCache = new Set();

function canonicalNhentaiUrl(url) {
  return url.replace(/^https:\/\/i\d+\.nhentai\.net\//, 'https://i.nhentai.net/');
}

// Wake the service worker immediately so it's ready before any images need lookup.
chrome.runtime.sendMessage({ type: 'PING' }, () => { chrome.runtime.lastError; });

chrome.storage.local.get(['cacheEnabled'], (r) => {
  cacheEnabled = r.cacheEnabled !== false;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.cacheEnabled !== undefined) cacheEnabled = changes.cacheEnabled.newValue;
});

function isNhentaiImageUrl(url) {
  return /https:\/\/i\d*\.nhentai\.net\/galleries\/\d+\/.+\.(webp|jpg|jpeg|png|gif)/i.test(url);
}

function parseNhentaiUrl(url) {
  // CDN URL: https://i2.nhentai.net/galleries/{mediaId}/{page}.webp
  const m = url.match(/https:\/\/i\d*\.nhentai\.net\/galleries\/(\d+)\/(.+)\.(webp|jpg|jpeg|png|gif)/i);
  if (!m) return null;
  return { mediaId: m[1], page: m[2], ext: m[3] };
}

function getGalleryId() {
  const m = window.location.href.match(/nhentai\.net\/g\/(\d+)\//);
  return m ? m[1] : null;
}

function getGalleryIdFromTopUrl() {
  try {
    if (window.top !== window.self) {
      const topHref = document.referrer || '';
      const m = topHref.match(/nhentai\.net\/g\/(\d+)\//);
      return m ? m[1] : null;
    }
  } catch(e) {}
  return null;
}

// ── Page cache ──
// pageNum → dataUrl map. Populated by the initial GET_GALLERY_PAGES prefetch,
// batch-lookup results, and window-prefetch responses so that navigating to any
// recently-visited or nearby page uses the synchronous fast path.
const _pageCache = new Map();
let _pageCacheGid = null;
const _prefetchRequested = new Set(); // tracks "gid:pageNum" pairs already requested

function prefetchGalleryPages(galleryId) {
  if (_pageCacheGid === galleryId) return;
  _pageCacheGid = galleryId;
  _pageCache.clear();
  _prefetchRequested.clear();
  chrome.runtime.sendMessage({ type: 'GET_GALLERY_PAGES', galleryId }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    for (const page of (resp.pages || [])) {
      if (page.dataUrl) _pageCache.set(page.pageNum, page.dataUrl);
    }
    // Sweep images that loaded from CDN before the prefetch arrived.
    if (_pageCache.size > 0 && document.body) {
      document.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (!src || !isNhentaiImageUrl(src)) return;
        const info = parseNhentaiUrl(src);
        if (!info) return;
        const pageNum = parseInt(info.page);
        if (!isNaN(pageNum) && _pageCache.has(pageNum)) img.src = _pageCache.get(pageNum);
      });
    }
  });
}

// ── Window prefetch — DO NOT REMOVE ──
// Problem this solves: nhentai's reader changes img.src via JavaScript (not
// static HTML), which our MutationObserver intercepts. The sync fast path
// (img.src = _pageCache.get(pageNum)) must already have the data URL in memory
// at that exact moment — there is no time to do an async IDB lookup because
// the browser initiates the CDN disk-cache fetch (~3 ms) faster than any
// async round-trip to the service worker (~10 ms). If _pageCache is cold,
// the CDN image renders for one frame before being replaced (visible flash).
//
// The fix: the moment the user lands on page N, fire a GET_PAGES_WINDOW
// request for N±5 pages. By the time the user navigates to N+1 or N+2 (even
// at fast-clicking speed), those data URLs are already in _pageCache and the
// sync path fires synchronously in the MutationObserver callback — before the
// browser ever initiates a CDN request for those pages.
//
// Batch-lookup results are also stored in _pageCache (see flushLookups) so
// that any page visited for the first time (async path) becomes a sync-path
// hit on every subsequent visit, including going back.
//
// If you change the window size or deduplication logic, make sure the window
// is always pre-populated BEFORE the user can navigate there — the entire
// point is that _pageCache must be warm at the moment MutationObserver fires.
function prefetchPageWindow(galleryId, centerPage) {
  const start = Math.max(1, centerPage - 5);
  const end = centerPage + 5;

  // Collect only pages not already in _pageCache or previously requested.
  // On sequential navigation each step adds just 1-2 pages at the leading edge.
  const needed = [];
  for (let p = start; p <= end; p++) {
    const key = `${galleryId}:${p}`;
    if (!_pageCache.has(p) && !_prefetchRequested.has(key)) {
      needed.push(p);
      _prefetchRequested.add(key);
    }
  }
  if (needed.length === 0) return;

  // needed is always contiguous in practice; use its min/max as the range.
  const reqStart = needed[0];
  const reqEnd   = needed[needed.length - 1];
  chrome.runtime.sendMessage(
    { type: 'GET_PAGES_WINDOW', galleryId, startPage: reqStart, endPage: reqEnd },
    (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      for (const page of (resp.pages || [])) {
        if (page.dataUrl) _pageCache.set(page.pageNum, page.dataUrl);
      }
    }
  );
}

// Fire prefetch immediately — window.location is available at document_start.
const _earlyGid = getGalleryId();
if (_earlyGid) prefetchGalleryPages(_earlyGid);

// ── Batch image lookup ──
// All handleImage calls within one microtask tick are collected and resolved
// with a single GET_IMAGES_BATCH message — one IDB transaction instead of N.
const _pendingLookups = [];
let _lookupScheduled = false;

function scheduleLookup(img, src, info, galleryId) {
  _pendingLookups.push({ img, src, info, galleryId });
  if (!_lookupScheduled) {
    _lookupScheduled = true;
    queueMicrotask(flushLookups); // microtask beats setTimeout(0) by ~10 ms
  }
}

async function flushLookups() {
  _lookupScheduled = false;
  if (!_pendingLookups.length) return;
  const batch = _pendingLookups.splice(0);

  // Group by galleryId — one IDB query per gallery.
  const byGallery = new Map();
  for (const item of batch) {
    if (!byGallery.has(item.galleryId)) byGallery.set(item.galleryId, []);
    byGallery.get(item.galleryId).push(item);
  }

  for (const [galleryId, items] of byGallery) {
    const queries = items.map(it => ({
      url: canonicalNhentaiUrl(it.src),
      pageNum: parseInt(it.info.page)
    }));

    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'GET_IMAGES_BATCH', galleryId, queries },
        r => { chrome.runtime.lastError; resolve(r || { results: {} }); }
      );
    });

    const results = (resp && resp.results) || {};

    for (const item of items) {
      const key = canonicalNhentaiUrl(item.src);
      if (results[key]) {
        const pageNum = parseInt(item.info.page);
        // Store in _pageCache so back/forward navigation uses the sync fast path.
        if (!isNaN(pageNum)) _pageCache.set(pageNum, results[key]);
        item.img.src = results[key];
      } else {
        const doCache = () => requestCache(item.src, item.info.mediaId, galleryId);
        if (item.img.complete && item.img.naturalWidth > 0) {
          doCache();
        } else {
          item.img.addEventListener('load', doCache, { once: true });
          item.img.addEventListener('error', () => { item.img.dataset.nhDone = ''; }, { once: true });
        }
      }
    }
  }
}

function requestCache(url, mediaId, galleryId) {
  const canonUrl = canonicalNhentaiUrl(url);
  if (pendingCache.has(canonUrl)) return;
  pendingCache.add(canonUrl);
  chrome.runtime.sendMessage({ type: 'CACHE_IMAGE', url, mediaId, galleryId }, () => {
    chrome.runtime.lastError;
    pendingCache.delete(canonUrl);
  });
}

function handleImage(img) {
  if (!cacheEnabled) return;
  if (img.dataset.nhDone === '1') return;

  const src = img.getAttribute('src');
  if (!src || !isNhentaiImageUrl(src)) return;

  img.dataset.nhDone = '1';
  const info = parseNhentaiUrl(src);
  if (!info) return;

  const galleryId = getGalleryId() || getGalleryIdFromTopUrl() || info.mediaId;

  // SPA navigation: refresh page cache for new gallery.
  if (galleryId && galleryId !== _pageCacheGid) prefetchGalleryPages(galleryId);

  const pageNum = parseInt(info.page);

  // Fire window prefetch immediately — BEFORE checking _pageCache or scheduling
  // the async lookup. This is intentional: we want ±5 pages in _pageCache as
  // early as possible so subsequent navigations hit the sync fast path.
  // Moving this call to after the cache check or into flushLookups would
  // re-introduce the CDN-image-appears-first flash on fast forward navigation.
  if (!isNaN(pageNum)) prefetchPageWindow(galleryId, pageNum);

  // Synchronous fast path: data URL already in cache.
  if (!isNaN(pageNum) && _pageCacheGid === galleryId && _pageCache.has(pageNum)) {
    img.src = _pageCache.get(pageNum);
    return;
  }

  // Async fallback: batch IDB lookup via service worker.
  scheduleLookup(img, src, info, galleryId);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IMAGE_CACHED_DONE' && msg.url && msg.dataUrl) {
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && canonicalNhentaiUrl(src) === msg.url) img.src = msg.dataUrl;
    });
  }
  if (msg.type === 'METADATA_SAVED') {
    showSavedToast(msg.galleryId, msg.title, msg.tags, msg.numPages, msg.cover);
  }
});

function escHtmlToast(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showSavedToast(galleryId, title, tags, numPages, cover) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });

  const thumbHtml = cover
    ? `<img class="thumb" src="${cover}" alt="">`
    : `<div class="thumb-ph">📁</div>`;

  const tagsArr = Array.isArray(tags) ? tags : [];
  const artists = tagsArr.filter(t => t.type === 'artist');
  const regular = tagsArr.filter(t => t.type === 'tag');
  const tagChips = [
    ...artists.map(t => `<span class="tag artist">${escHtmlToast(t.name)}</span>`),
    ...regular.map(t => `<span class="tag">${escHtmlToast(t.name)}</span>`),
  ].join('');

  shadow.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
      .toast {
        pointer-events: auto;
        font-family: 'JetBrains Mono', monospace;
        background: #16161a;
        border: 1px solid #2a2a30;
        border-left: 3px solid #06d6a0;
        border-radius: 8px;
        overflow: hidden;
        width: 310px;
        color: #e8e8f0;
        box-shadow: 0 8px 32px rgba(0,0,0,0.7);
        animation: shi-in 0.2s ease;
      }
      @keyframes shi-in {
        from { opacity: 0; transform: translateY(-10px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .toast.out { animation: shi-out 0.25s ease forwards; }
      @keyframes shi-out {
        to { opacity: 0; transform: translateY(-10px) scale(0.96); }
      }
      .header {
        display: flex; align-items: center; gap: 7px;
        padding: 10px 12px 9px;
        border-bottom: 1px solid #2a2a30;
        background: #111114;
      }
      .icon {
        width: 18px; height: 18px; background: #ff6b6b; border-radius: 4px;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; flex-shrink: 0;
      }
      .brand  { font-size: 11px; font-weight: 700; color: #ff6b6b; }
      .sep    { font-size: 11px; color: #3a3a44; }
      .status { font-size: 10px; font-weight: 600; color: #06d6a0; }
      .body {
        display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
      }
      .thumb-wrap {
        width: 44px; aspect-ratio: 2/3; flex-shrink: 0;
        border-radius: 4px; overflow: hidden;
        border: 1px solid #2a2a30; background: #0d0d0f;
      }
      .thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
      .thumb-ph {
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        color: #6b6b80; font-size: 16px;
      }
      .info { min-width: 0; flex: 1; overflow: hidden; text-align: left; }
      .gid   { font-size: 11px; font-weight: 700; color: #ffd166; text-align: left; }
      .title {
        font-size: 10px; color: #e8e8f0; opacity: 0.85; line-height: 1.35;
        margin-top: 3px; overflow: hidden;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .tags {
        display: flex; gap: 3px; margin-top: 5px;
        overflow: hidden; flex-wrap: nowrap;
      }
      .tag {
        font-size: 8px; padding: 1px 5px; line-height: 1.4;
        background: #1e1e28; border: 1px solid #2a2a30;
        border-radius: 3px; color: #6b6b80;
        white-space: nowrap; flex-shrink: 0;
      }
      .tag.artist { color: #ffd166; border-color: #3a3a20; }
      .meta { font-size: 9px; color: #6b6b80; margin-top: 5px; }
      .hi   { color: #ffd166; }
    </style>
    <div class="toast">
      <div class="header">
        <div class="icon">💾</div>
        <span class="brand">Shiori</span>
        <span class="sep">/</span>
        <span class="status">library saved</span>
      </div>
      <div class="body">
        <div class="thumb-wrap">${thumbHtml}</div>
        <div class="info">
          <div class="gid">#${escHtmlToast(galleryId)}</div>
          <div class="title">${escHtmlToast(title)}</div>
          <div class="tags">${tagChips}</div>
          <div class="meta"><span class="hi">${tagsArr.length}</span> tags · <span class="hi">${numPages}</span> pages</div>
        </div>
      </div>
    </div>`;

  document.documentElement.appendChild(host);

  requestAnimationFrame(() => {
    const tagsEl = shadow.querySelector('.tags');
    if (!tagsEl) return;
    const bound = tagsEl.getBoundingClientRect().right;
    let hiding = false;
    for (const tag of tagsEl.children) {
      if (hiding) { tag.style.display = 'none'; continue; }
      if (tag.getBoundingClientRect().right > bound) {
        tag.style.display = 'none';
        hiding = true;
      }
    }
  });

  const toast = shadow.querySelector('.toast');
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => host.remove(), 300);
  }, 4500);
}

function processImages(root) {
  (root.querySelectorAll ? root : document).querySelectorAll('img').forEach(handleImage);
}

const observer = new MutationObserver((mutations) => {
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'IMG') handleImage(node);
      else processImages(node);
    }
    if (mut.type === 'attributes' && mut.target.tagName === 'IMG') {
      mut.target.dataset.nhDone = '';
      handleImage(mut.target);
    }
  }
});

// At document_start document.body doesn't exist yet. Start the observer and
// process existing images once the body is available (DOMContentLoaded).
function initObserver() {
  observer.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src'],
  });
  processImages(document.body);
}

if (document.body) {
  initObserver();
} else {
  document.addEventListener('DOMContentLoaded', initObserver, { once: true });
}

function extractPageMeta() {
  // Title: strip " - nhentai" / "| nhentai" site suffix from the page title
  let title = document.title.replace(/\s*[|–—\-]\s*(nhentai\.net|nhentai)\s*$/i, '').trim();

  // Try common nhentai gallery heading selectors for a more accurate title
  const titleEl = document.querySelector('#info h1, .gallery-info h1, h1.title, article h1');
  if (titleEl && titleEl.textContent.trim()) title = titleEl.textContent.trim();

  // Count page thumbnails visible on the gallery index page
  const numPages = document.querySelectorAll('.gallerythumb, .gallery-thumbnail, .thumb').length;

  return { title, numPages };
}

if (window.self === window.top) {
  // FETCH_METADATA requires DOM content — send after DOMContentLoaded.
  const sendMeta = () => {
    const _gid = getGalleryId();
    if (_gid) {
      chrome.runtime.sendMessage(
        { type: 'FETCH_METADATA', galleryId: _gid, pageMeta: extractPageMeta() },
        () => { chrome.runtime.lastError; }
      );
    }
  };
  if (document.readyState !== 'loading') {
    sendMeta();
  } else {
    document.addEventListener('DOMContentLoaded', sendMeta, { once: true });
  }
}
