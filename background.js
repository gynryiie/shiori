// background.js — Service worker

const DB_NAME = 'nhentai-image-cache';
const DB_VERSION = 6;
const STORE = 'images';
const META_STORE = 'metadata';
const GALLERY_STORE = 'galleries';
const EXT_MAP = { j: 'jpg', p: 'png', w: 'webp', g: 'gif' };

// ── Site registry ──
// Each entry defines the gallery URL template and whether CBZ download is supported.
// {id} = gallery ID, {page} = 1-based page number.
const SITES = {
  'nhentai.net': { name: 'nhentai',   galleryUrl: 'https://nhentai.net/g/{id}/{page}/',         canDownload: true,  idRegex: /\/g\/(\d+)/ },
  'hitomi.la':   { name: 'Hitomi.la', galleryUrl: 'https://hitomi.la/reader/{id}.html#{page}',  canDownload: false, idRegex: /\/reader\/(\d+)\.html/ },
};

function siteGalleryUrl(key, galleryId, page) {
  const site = SITES[key];
  if (!site) return '';
  return site.galleryUrl.replace('{id}', galleryId).replace('{page}', page);
}

function normalizeSiteKey(input) {
  if (!input) return '';
  const s = input.trim();
  try {
    const url = new URL(s.includes('://') ? s : 'https://' + s);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return s.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

// Normalize all nhentai CDN variants (i2, i7, …) to a single canonical host so
// the same logical page always maps to the same DB key regardless of which CDN
// edge served it during manual browsing vs. batch download.
function canonicalNhentaiUrl(url) {
  return url.replace(/^https:\/\/i\d+\.nhentai\.net\//, 'https://i.nhentai.net/');
}

// For locally imported CBZs there is no real CDN URL, so we mint a stable
// synthetic key that will never collide with a real nhentai URL.
function localPageUrl(galleryId, pageNum, ext) {
  return `local://nhentai/${galleryId}/${pageNum}.${ext}`;
}

let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      const s = db.createObjectStore(STORE, { keyPath: 'url' });
      s.createIndex('mediaId', 'mediaId', { unique: false });
      s.createIndex('galleryId', 'galleryId', { unique: false });
      db.createObjectStore(META_STORE, { keyPath: 'galleryId' });
      db.createObjectStore(GALLERY_STORE, { keyPath: 'galleryId' });
    };
    req.onsuccess = () => {
      _db = req.result;
      // If another context upgrades the DB (e.g. extension update), close and
      // clear the cache so the next call opens a fresh upgraded connection.
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(canonicalNhentaiUrl(url));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(url, dataUrl, mediaId, galleryId) {
  const db = await openDB();
  const gid = String(galleryId || mediaId);
  const canonUrl = url.startsWith('local://') ? url : canonicalNhentaiUrl(url);
  const size = Math.round(dataUrl.length * 0.75);
  const cachedAt = Date.now();
  const pm = canonUrl.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
  const pageNum = pm ? parseInt(pm[1]) : 9999;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    tx.objectStore(STORE).put({ url: canonUrl, dataUrl, mediaId: String(mediaId), galleryId: gid, cachedAt, size });

    const galReq = tx.objectStore(GALLERY_STORE).get(gid);
    galReq.onsuccess = () => {
      const cur = galReq.result;
      let entry;
      if (cur) {
        entry = { ...cur, count: cur.count + 1, size: cur.size + size, latestAt: Math.max(cur.latestAt || 0, cachedAt) };
        if (pageNum < (cur.coverPage ?? 9999)) { entry.cover = dataUrl; entry.coverPage = pageNum; }
      } else {
        entry = { galleryId: gid, count: 1, size, latestAt: cachedAt, cover: pageNum < 9999 ? dataUrl : null, coverPage: pageNum };
      }
      tx.objectStore(GALLERY_STORE).put(entry);
    };
  });
}

// ── Metadata store helpers ──

async function metaGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function metaPut(meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const req = tx.objectStore(META_STORE).put(meta);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function metaGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function metaDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const req = tx.objectStore(META_STORE).delete(String(galleryId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Gallery stats store helpers ──

async function galleryGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function galleryPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const req = tx.objectStore(GALLERY_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function galleryDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const req = tx.objectStore(GALLERY_STORE).delete(String(galleryId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function galleryGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Rebuilds the gallery entry by scanning actual image records.
// Used after dedup when the in-memory count/size/cover may be stale.
async function rebuildGalleryEntry(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  if (records.length === 0) { await galleryDelete(gid); return; }
  let count = 0, size = 0, latestAt = 0, cover = null, coverPage = 9999;
  for (const r of records) {
    count++;
    size += r.size || 0;
    latestAt = Math.max(latestAt, r.cachedAt || 0);
    const pm = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
    const pn = pm ? parseInt(pm[1]) : 9999;
    if (pn < coverPage) { coverPage = pn; cover = r.dataUrl; }
  }
  await galleryPut({ galleryId: gid, count, size, latestAt, cover, coverPage });
}

// ── Metadata fetch from nhentai API ──

async function fetchAndStoreMetadata(galleryId, apiKey = null) {
  const existing = await metaGet(galleryId);
  if (existing && !existing.isLocalImport && !existing.isStub) return existing;

  try {
    const headers = { 'Referer': 'https://nhentai.net/' };
    if (apiKey) headers['Authorization'] = `Key ${apiKey}`;
    const resp = await fetch(`https://nhentai.net/api/v2/galleries/${galleryId}`, { headers });
    if (!resp.ok) return existing || null;
    const data = await resp.json();

    const meta = {
      galleryId: String(data.id),
      mediaId: String(data.media_id),
      titleEnglish: data.title?.english || '',
      titleJapanese: data.title?.japanese || '',
      titlePretty: data.title?.pretty || '',
      tags: (data.tags || []).map(t => ({ id: t.id, type: t.type, name: t.name, url: t.url })),
      numPages: data.num_pages,
      numFavorites: data.num_favorites,
      uploadDate: data.upload_date,
      pageExts: (data.pages || []).map(p => p.path?.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'),
      fetchedAt: Date.now(),
      isLocalImport: existing != null && existing.isLocalImport === true,
      source: existing?.source ?? 'nhentai.net'
    };

    await metaPut(meta);
    return meta;
  } catch (e) {
    console.error('[shiori] metadata fetch error:', galleryId, e.message);
    return existing || null;
  }
}

// ── Image caching ──

// Returns the first record for this gallery whose URL ends in /{pageNum}.{ext},
// regardless of URL scheme (handles local:// vs CDN mismatch after CBZ import).
// Returns the full record for a specific page number within a gallery.
// Used only by GET_IMAGE for cross-scheme URL resolution (local:// vs CDN).
async function dbGetByGalleryPage(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(null); return; }
      const m = cursor.value.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m && parseInt(m[1]) === pageNum) { resolve(cursor.value); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Checks page existence using key-only cursor — no dataUrls loaded.
async function pageExistsForGallery(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(false); return; }
      const m = cursor.primaryKey.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m && parseInt(m[1]) === pageNum) { resolve(true); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function fetchAndCache(url, mediaId, galleryId, tabId) {
  const canonUrl = canonicalNhentaiUrl(url);

  // Fast path: exact URL already in cache.
  if (await dbGet(canonUrl)) return null;

  // Slow path: check by page number to catch cross-scheme matches
  // (e.g. gallery imported via CBZ uses local:// URLs; browsing via CDN sends different URL).
  if (galleryId) {
    const pm = canonUrl.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
    if (pm && await pageExistsForGallery(String(galleryId), parseInt(pm[1]))) {
      return null;
    }
  }

  try {
    const response = await fetch(url, {
      headers: { 'Referer': 'https://nhentai.net/' }
    });
    if (!response.ok) return null;

    const blob = await response.blob();
    const dataUrl = await blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize)
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      return `data:${blob.type};base64,` + btoa(binary);
    });

    await dbPut(canonUrl, dataUrl, mediaId, galleryId);

    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'IMAGE_CACHED_DONE', url: canonUrl, dataUrl }).catch(() => {});
    }
    return dataUrl;
  } catch (e) {
    console.error('[shiori] cache error:', e.message);
    return null;
  }
}

// ── Bulk download all pages of a gallery (CBZ via nhentai API v2) ──

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

async function inflateRaw(compressedBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(compressedBytes);
  writer.close();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of chunks) { out.set(chunk, off); off += chunk.length; }
  return out;
}

async function unzipCbz(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Locate End of Central Directory record
  let eocdOffset = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset  = view.getUint32(eocdOffset + 16, true);

  const results = [];
  let pos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const method      = view.getUint16(pos + 10, true);
    const compSize    = view.getUint32(pos + 20, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const filename    = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (filename.endsWith('/')) continue; // directory entry

    const lfhNameLen  = view.getUint16(localOffset + 26, true);
    const lfhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart   = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const compData    = bytes.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = await inflateRaw(compData);
    } else {
      continue; // unsupported compression
    }

    results.push({ filename, data });
  }

  return results;
}

// ── Shared CBZ-to-DB writer (used by both download and local import) ──
//
// For downloaded galleries:  urlBuilder = (pageNum, ext) => real CDN URL
// For local imports:         urlBuilder = (pageNum, ext) => localPageUrl(gid, pageNum, ext)

async function storeCbzEntries(imageEntries, mediaId, galleryId, urlBuilder, sendProgress, skipExisting = false) {
  const gid = String(galleryId);
  const total = imageEntries.length;

  let existingPageNums = new Set();
  if (skipExisting) {
    const db = await openDB();
    existingPageNums = await new Promise((resolve, reject) => {
      const pages = new Set();
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(gid));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(pages); return; }
        const m = cursor.primaryKey.match(/\/(\d+)\.(webp|jpe?g|png|gif)$/i);
        if (m) pages.add(parseInt(m[1]));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } else {
    await deleteGalleryImages(gid);
  }

  sendProgress({ done: 0, total, skipped: 0, status: 'started' });

  let done = 0, skipped = 0;
  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const m = entry.filename.match(/\.(jpe?g|png|webp|gif)$/i);
    if (!m) continue;
    const pageNum = i + 1;  // 1-based sort-order index — works for any filename scheme

    if (skipExisting && existingPageNums.has(pageNum)) {
      skipped++;
      sendProgress({ done, total, skipped, status: 'progress' });
      continue;
    }

    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg'
               : ext === 'png' ? 'image/png'
               : ext === 'webp' ? 'image/webp'
               : 'image/gif';
    const url = urlBuilder(pageNum, ext);
    const dataUrl = `data:${mime};base64,` + uint8ToBase64(entry.data);

    await dbPut(url, dataUrl, mediaId, gid);
    done++;
    sendProgress({ done, total, skipped, status: 'progress' });
  }

  sendProgress({ done, total, skipped, status: 'done' });
}

async function deleteGalleryImages(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else { tx.objectStore(GALLERY_STORE).delete(gid); }
    };
  });
}

// Moves all image records and the metadata entry from oldGid to newGid.
async function rekeyGallery(oldGid, newGid) {
  if (oldGid === newGid) return;
  const db = await openDB();

  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(oldGid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  if (records.length > 0) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const rec of records) { store.delete(rec.url); store.put({ ...rec, galleryId: newGid }); }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  const oldGallery = await galleryGet(oldGid);
  if (oldGallery) {
    await galleryDelete(oldGid);
    await galleryPut({ ...oldGallery, galleryId: newGid });
  }

  const oldMeta = await metaGet(oldGid);
  if (oldMeta) {
    await metaDelete(oldGid);
    await metaPut({ ...oldMeta, galleryId: newGid });
  }
}

// ── Domain-aware dispatch helpers ──
// Add a branch here when supporting a new source site.

async function fetchMetadataForGallery(galleryId, source, apiKey) {
  if (source === 'nhentai.net') return fetchAndStoreMetadata(galleryId, apiKey);
  return null;
}

async function downloadGallery(galleryId, source) {
  if (source === 'nhentai.net') {
    const { apiKey } = await new Promise(r => chrome.storage.local.get(['apiKey'], r));
    if (!apiKey) throw new Error('No API key set — add one in Settings (⚙).');
    return downloadAndCacheCbz(galleryId, apiKey);
  }
  throw new Error(`Download not supported for ${SITES[source]?.name || source || 'unknown source'}.`);
}

async function downloadAndCacheCbz(galleryId, apiKey) {
  const gid = String(galleryId);
  const sendProgress = (payload) =>
    chrome.runtime.sendMessage({ type: 'CACHE_PROGRESS', galleryId: gid, ...payload }).catch(() => {});
  const sendError = (error) => sendProgress({ status: 'error', error });

  // Update metadata (title, tags, mediaId, etc.) from the API.
  await fetchAndStoreMetadata(gid, apiKey);

  // Request signed CBZ download URL from nhentai API v2
  let dlResp;
  try {
    dlResp = await fetch(`https://nhentai.net/api/v2/galleries/${gid}/download?format=cbz`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${apiKey}`, 'Referer': 'https://nhentai.net/' }
    });
  } catch (e) {
    return sendError('Network error contacting nhentai API.');
  }

  if (!dlResp.ok) {
    return sendError(
      dlResp.status === 401 ? 'Invalid API key — check Settings (⚙).' :
      dlResp.status === 429 ? 'Rate limited — please wait and try again.' :
      dlResp.status === 503 ? 'nhentai service unavailable — try again later.' :
      `API error ${dlResp.status}`
    );
  }

  let dlData;
  try { dlData = await dlResp.json(); } catch (e) { return sendError('Malformed API response.'); }

  const signedUrl = dlData.url;
  if (!signedUrl) return sendError('No download URL in API response.');

  // Some API responses include the file size — use it when present so the
  // progress bar is deterministic even if the CDN omits Content-Length.
  const apiKnownSize = dlData.size || dlData.file_size || dlData.filesize || 0;

  // Fetch the CBZ archive from the signed URL, streaming progress back to UI
  let cbzBuffer;
  try {
    const cbzResp = await fetch(signedUrl);
    if (!cbzResp.ok) return sendError(`CBZ download failed: ${cbzResp.status}`);
    const contentLength = parseInt(cbzResp.headers.get('content-length') || '0');
    const totalSize = apiKnownSize || contentLength;
    let downloaded = 0;
    sendProgress({ status: 'downloading', downloaded: 0, total: totalSize });
    const reader = cbzResp.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      sendProgress({ status: 'downloading', downloaded, total: totalSize });
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) { merged.set(chunk, off); off += chunk.length; }
    cbzBuffer = merged.buffer;
  } catch (e) {
    return sendError('Failed to fetch CBZ file.');
  }

  // Parse ZIP entries
  sendProgress({ status: 'extracting' });
  let entries;
  try { entries = await unzipCbz(cbzBuffer); } catch (e) { return sendError('Failed to parse CBZ: ' + e.message); }

  const imageEntries = sortImageEntries(entries);
  if (imageEntries.length === 0) return sendError('No images found in CBZ.');

  const dlMeta = await metaGet(gid);
  const mediaId = dlMeta?.mediaId || gid;

  // Downloaded galleries use real CDN URLs so they interop with the cache interceptor.
  const urlBuilder = (pageNum, ext) =>
    `https://i.nhentai.net/galleries/${mediaId}/${pageNum}.${ext}`;

  await storeCbzEntries(imageEntries, mediaId, gid, urlBuilder, sendProgress, true);

  // No longer a local import once fully downloaded from source.
  const finalMeta = await metaGet(gid);
  if (finalMeta?.isLocalImport) await metaPut({ ...finalMeta, isLocalImport: false });
}

// ── Local CBZ import ──
//
// Imports a user-supplied ArrayBuffer as a gallery.  galleryId is caller-chosen
// (e.g. derived from the filename).  No API key required.

async function importLocalCbz(galleryId, title, cbzBuffer) {
  const gid = String(galleryId);
  const sendProgress = (payload) =>
    chrome.runtime.sendMessage({ type: 'CACHE_PROGRESS', galleryId: gid, ...payload }).catch(() => {});
  const sendError = (error) => sendProgress({ status: 'error', error });

  let entries;
  try { entries = await unzipCbz(cbzBuffer); } catch (e) {
    return sendError('Failed to parse CBZ: ' + e.message);
  }

  const imageEntries = sortImageEntries(entries);
  if (imageEntries.length === 0) return sendError('No images found in CBZ.');

  // Store minimal metadata so the library UI can render this gallery.
  await metaPut({
    galleryId: gid,
    mediaId: gid,           // No real mediaId for local imports.
    titleEnglish: title || gid,
    titleJapanese: '',
    titlePretty: title || gid,
    tags: [],
    numPages: 0,
    numFavorites: 0,
    uploadDate: Math.floor(Date.now() / 1000),
    pageExts: imageEntries.map(e => {
      const m = e.filename.match(/\.(jpe?g|png|webp|gif)$/i);
      const ext = m?.[1]?.toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext || 'jpg';
    }),
    fetchedAt: Date.now(),
    isLocalImport: true,
    source: ''
  });

  // Local imports use synthetic local:// URLs — no CDN dependency.
  const urlBuilder = (pageNum, ext) => localPageUrl(gid, pageNum, ext);

  await storeCbzEntries(imageEntries, gid, gid, urlBuilder, sendProgress);

  // Fire-and-forget: enrich the stub metadata with real title/tags from the API.
  chrome.storage.local.get(['apiKey'], ({ apiKey }) => {
    fetchAndStoreMetadata(gid, apiKey || null).catch(console.error);
  });
}

// Sort image entries numerically by the leading integer in their filename.
function sortImageEntries(entries) {
  return entries
    .filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.filename))
    .sort((a, b) => {
      const na = parseInt(a.filename.match(/(\d+)/)?.[1] || '0');
      const nb = parseInt(b.filename.match(/(\d+)/)?.[1] || '0');
      return na - nb;
    });
}

const cachingInProgress = new Set();
const metaFetchPending  = new Set(); // prevents duplicate metadata fetches per SW lifetime
const _dedupedGalleries = new Set(); // prevents redundant dedup scans per SW session

// Called from within the CACHE_IMAGE handler where the SW is provably alive
// (return true + sender callback keep the port — and therefore the SW — open).
// Only fetches once per gallery; subsequent calls return immediately.
async function ensureMetadataForGallery(galleryId, tabId) {
  const gid = String(galleryId);
  if (metaFetchPending.has(gid)) return;
  const existing = await metaGet(gid).catch(() => null);
  if (existing && !existing.isStub) return;
  metaFetchPending.add(gid);
  try {
    const { apiKey } = await new Promise(r => chrome.storage.local.get(['apiKey'], r));
    const meta = await fetchAndStoreMetadata(gid, apiKey || null);
    if (meta && meta.tags && meta.tags.length > 0) {
      // Signal all open popup/library pages that the library changed.
      chrome.storage.local.set({ libraryVersion: Date.now() });

      if (tabId) {
        const galEntry = await galleryGet(gid).catch(() => null);
        chrome.tabs.sendMessage(tabId, {
          type: 'METADATA_SAVED',
          galleryId: gid,
          title: meta.titlePretty || meta.titleEnglish || '',
          tags: meta.tags,
          numPages: meta.numPages || 0,
          cover: galEntry?.cover || null,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[shiori] ensureMetadata error:', gid, e.message);
  } finally {
    metaFetchPending.delete(gid);
  }
}

async function cacheAllPages(galleryId) {
  const gid = String(galleryId);
  if (cachingInProgress.has(gid)) return;
  cachingInProgress.add(gid);
  const sendErr = (error) =>
    chrome.runtime.sendMessage({ type: 'CACHE_PROGRESS', galleryId: gid, status: 'error', error }).catch(() => {});
  try {
    const meta   = await metaGet(gid);
    const source = meta?.source || '';
    if (!SITES[source]?.canDownload) {
      sendErr(`Download not supported for ${SITES[source]?.name || source || 'unknown source'}.`);
      return;
    }
    await downloadGallery(gid, source);
  } catch (e) {
    sendErr(e.message);
  } finally {
    cachingInProgress.delete(gid);
  }
}

// ── Message router ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return; // synchronous — channel closes after this, response already sent
  }
  if (msg.type === 'GET_IMAGES_BATCH') {
    (async () => {
      const galleryId = String(msg.galleryId || '');
      const queries   = msg.queries || []; // [{ url, pageNum }]
      const results   = {};
      if (!galleryId || !queries.length) { sendResponse({ results }); return; }

      const db = await openDB();

      // One IDB query fetches all records for the gallery at once.
      const records = await new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(galleryId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });

      // Build URL and page-number lookup maps from the fetched records.
      const byUrl  = new Map(records.map(r => [r.url, r.dataUrl]));
      const byPage = new Map();
      for (const r of records) {
        const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
        if (m) byPage.set(parseInt(m[1]), r.dataUrl);
      }

      for (const { url, pageNum } of queries) {
        const dataUrl = byUrl.get(url) ?? (!isNaN(pageNum) ? byPage.get(pageNum) : undefined);
        if (dataUrl) results[url] = dataUrl;
      }

      sendResponse({ results });
    })().catch(() => sendResponse({ results: {} }));
    return true;
  }
  if (msg.type === 'GET_IMAGE') {
    (async () => {
      const canonUrl = canonicalNhentaiUrl(msg.url);
      let record = await dbGet(canonUrl);
      if (!record && msg.galleryId) {
        const pm = canonUrl.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
        if (pm) record = await dbGetByGalleryPage(msg.galleryId, parseInt(pm[1]));
      }
      sendResponse({ dataUrl: record ? record.dataUrl : null });
    })().catch(() => sendResponse({ dataUrl: null }));
    return true;
  }
  if (msg.type === 'CACHE_IMAGE') {
    // ensureMetadataForGallery runs here where the SW is guaranteed alive:
    // CACHE_IMAGE uses return true + the sender has a callback, so both ends
    // of the port stay open until sendResponse is called.
    (async () => {
      await fetchAndCache(msg.url, msg.mediaId, msg.galleryId, sender.tab?.id);
      if (msg.galleryId) await ensureMetadataForGallery(msg.galleryId, sender.tab?.id);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'FETCH_METADATA') {
    // Saves a page-extracted stub (title, numPages from DOM) as a fallback for
    // when ensureMetadata's API call fails (e.g. no API key, network error).
    sendResponse({ ok: true });
    const gid = msg.galleryId;
    const pageMeta = msg.pageMeta || null;
    if (pageMeta) {
      (async () => {
        const existing = await metaGet(gid).catch(() => null);
        if (!existing || existing.isStub) {
          await metaPut({
            galleryId: String(gid),
            mediaId: String(gid),
            titleEnglish: pageMeta.title || '',
            titleJapanese: '',
            titlePretty: pageMeta.title || '',
            tags: [],
            numPages: pageMeta.numPages || 0,
            numFavorites: 0,
            uploadDate: Math.floor(Date.now() / 1000),
            pageExts: [],
            fetchedAt: Date.now(),
            isLocalImport: false,
            isStub: true
          }).catch(console.error);
        }
      })().catch(console.error);
    }
    return false;
  }
  if (msg.type === 'GET_METADATA') {
    metaGet(msg.galleryId).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.type === 'CACHE_ALL_PAGES') {
    cacheAllPages(msg.galleryId).catch(console.error);
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (msg.type === 'IMPORT_LOCAL_CBZ') {
    // msg.galleryId  — caller-chosen ID (e.g. filename stem)
    // msg.title      — human-readable title
    // msg.buffer     — ArrayBuffer of the CBZ file
    importLocalCbz(msg.galleryId, msg.title, msg.buffer)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SET_SOURCE') {
    (async () => {
      const oldGid = String(msg.galleryId);
      const newGid = msg.newGalleryId ? String(msg.newGalleryId) : oldGid;

      if (newGid !== oldGid) await rekeyGallery(oldGid, newGid);

      const meta = await metaGet(newGid);
      if (!meta) { sendResponse({ ok: false }); return; }
      await metaPut({ ...meta, source: msg.source });

      // Fetch metadata before responding so the card refresh sees complete data.
      if (msg.source) {
        const { apiKey } = await new Promise(r => chrome.storage.local.get(['apiKey'], r));
        await fetchMetadataForGallery(newGid, msg.source, apiKey).catch(console.error);
      }

      sendResponse({ ok: true, newGalleryId: newGid });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'GET_STATS') {
    getStats().then(sendResponse).catch(() => sendResponse({ totalImages: 0, totalSize: 0, galleries: {} }));
    return true;
  }
  if (msg.type === 'GET_ALL_GALLERIES') {
    getAllGalleries().then(sendResponse).catch(() => sendResponse({ galleries: [] }));
    return true;
  }
  if (msg.type === 'GET_GALLERY_PAGES') {
    getGalleryPages(msg.galleryId).then(sendResponse).catch(() => sendResponse({ pages: [] }));
    return true;
  }
  if (msg.type === 'GET_PAGES_WINDOW') {
    getGalleryPageRange(msg.galleryId, msg.startPage, msg.endPage)
      .then(sendResponse).catch(() => sendResponse({ pages: [] }));
    return true;
  }
  if (msg.type === 'DELETE_GALLERY') {
    deleteGallery(msg.galleryId).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'CLEAR_ALL') {
    clearAll().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ── Stats / gallery helpers ──

async function getStats() {
  const entries = await galleryGetAll();
  const galleries = {};
  let totalImages = 0, totalSize = 0;
  for (const e of entries) {
    galleries[e.galleryId] = { count: e.count, size: e.size, latestAt: e.latestAt, cover: e.cover };
    totalImages += e.count;
    totalSize += e.size;
  }
  return { totalImages, totalSize, galleries };
}

// Remove CDN-URL duplicates for pages that are already stored under a local://
// URL. Runs before stat collection so counts stay accurate.
async function deduplicateGalleryImages(galleryId) {
  const gid = String(galleryId);
  if (_dedupedGalleries.has(gid)) return; // already clean in this SW session
  const db = await openDB();

  // Collect only URLs via key-only cursor — no dataUrls loaded.
  const urlsByPage = new Map();
  await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(); return; }
      const url = cursor.primaryKey;
      const m   = url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m) {
        const pn = parseInt(m[1]);
        if (!urlsByPage.has(pn)) urlsByPage.set(pn, []);
        urlsByPage.get(pn).push(url);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  // For any page that has both a local:// record and a CDN record, delete the CDN one
  const urlsToDelete = [];
  for (const urls of urlsByPage.values()) {
    if (urls.length <= 1) continue;
    if (urls.some(u => u.startsWith('local://'))) {
      for (const u of urls) {
        if (!u.startsWith('local://')) urlsToDelete.push(u);
      }
    }
  }

  if (urlsToDelete.length === 0) {
    _dedupedGalleries.add(gid); // no duplicates — no need to check again this session
    return;
  }

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const url of urlsToDelete) store.delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await rebuildGalleryEntry(gid);
  _dedupedGalleries.add(gid);
}

async function getAllGalleries() {
  const allMeta = await metaGetAll();

  // Purge any CDN duplicates that crept in while browsing a locally-imported gallery
  const localImports = allMeta.filter(m => m.isLocalImport);
  if (localImports.length > 0) {
    await Promise.all(localImports.map(m => deduplicateGalleryImages(m.galleryId)));
  }

  const stats = await getStats();
  const metaMap = {};
  for (const m of allMeta) metaMap[m.galleryId] = m;

  const galleries = Object.entries(stats.galleries)
    .sort((a, b) => (b[1].latestAt || 0) - (a[1].latestAt || 0))
    .map(([id, info]) => {
      const m = metaMap[id];
      return {
        id, ...info,
        ...(m ? {
          title: m.titlePretty || m.titleEnglish || '',
          titleEnglish: m.titleEnglish || '',
          numPages: m.numPages,
          tags: m.tags,
          mediaId: m.mediaId,
          pageExts: m.pageExts,
          isLocalImport: m.isLocalImport || false,
          source: m.source ?? ''
        } : {})
      };
    });
  return { galleries, totalImages: stats.totalImages, totalSize: stats.totalSize };
}

async function deleteGallery(galleryId) {
  // deleteGalleryImages already String()-wraps; pass through raw value is fine.
  await deleteGalleryImages(galleryId);
  await metaDelete(galleryId);
}

async function clearAll() {
  const db = await openDB();
  await Promise.all([STORE, META_STORE, GALLERY_STORE].map(storeName =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })
  ));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ cacheEnabled: true });
});

// ── Action icon greyscale when caching is disabled ──

async function _buildGreyscaleImageData(size) {
  const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < data.data.length; i += 4) {
    const g = Math.round(0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2]);
    data.data[i] = data.data[i + 1] = data.data[i + 2] = g;
  }
  return data;
}

async function updateActionIcon(enabled) {
  if (enabled) {
    chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
    return;
  }
  const [d16, d48] = await Promise.all([_buildGreyscaleImageData(16), _buildGreyscaleImageData(48)]);
  chrome.action.setIcon({ imageData: { 16: d16, 48: d48 } });
}

// Apply correct icon on every service-worker wake-up.
chrome.storage.local.get(['cacheEnabled'], ({ cacheEnabled }) => {
  updateActionIcon(cacheEnabled !== false).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'cacheEnabled' in changes)
    updateActionIcon(changes.cacheEnabled.newValue !== false).catch(() => {});
});

async function _fetchGalleryRecords(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function getGalleryPages(galleryId) {
  const records = await _fetchGalleryRecords(galleryId);

  const pages = records
    .map(r => {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, dataUrl: r.dataUrl };
    })
    .sort((a, b) => a.pageNum - b.pageNum);

  // Include data URLs for leading pages up to an 8 MB cap. Pages beyond the cap
  // fall back to the async batch-lookup path or window-prefetch in content.js.
  const CAP = 8 * 1024 * 1024;
  let total = 0;
  for (const p of pages) {
    if (p.dataUrl && total + p.dataUrl.length <= CAP) {
      total += p.dataUrl.length;
    } else {
      p.dataUrl = undefined;
    }
  }

  return { pages };
}

// Returns data URLs for a specific page-number window.
// Keeps individual messages small (typically 5 pages ≈ 2–8 MB).
async function getGalleryPageRange(galleryId, startPage, endPage) {
  const records = await _fetchGalleryRecords(galleryId);

  const pages = records
    .map(r => {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, dataUrl: r.dataUrl };
    })
    .filter(p => p.pageNum >= startPage && p.pageNum <= endPage)
    .sort((a, b) => a.pageNum - b.pageNum);

  return { pages };
}