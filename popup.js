function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById('statusBar');
  bar.textContent = msg;
  bar.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

function clipOverflowingTags(container) {
  const bound = container.getBoundingClientRect().right;
  let hiding = false;
  for (const tag of container.children) {
    if (hiding) { tag.style.display = 'none'; continue; }
    if (tag.getBoundingClientRect().right > bound) {
      tag.style.display = 'none';
      hiding = true;
    }
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTagsHtml(tags) {
  if (!tags || tags.length === 0) return '';
  const artists = tags.filter(t => t.type === 'artist');
  const regular = tags.filter(t => t.type === 'tag');
  const ordered = [...artists, ...regular].slice(0, 5);
  const chips = ordered.map(t =>
    `<span class="gallery-tag${t.type === 'artist' ? ' artist' : ''}">${escHtml(t.name)}</span>`
  );
  return `<div class="gallery-tags">${chips.join('')}</div>`;
}

const DEL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

// Accepts either the new array format (GET_ALL_GALLERIES) or the legacy object
// format that may be stored in popupCache from an older version.
function _renderGalleryList(data) {
  let galleriesArr;
  if (Array.isArray(data.galleries)) {
    galleriesArr = data.galleries;
  } else {
    galleriesArr = Object.entries(data.galleries || {})
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
  }

  const totalGalleries = data.totalGalleries !== undefined
    ? data.totalGalleries
    : galleriesArr.length;

  document.getElementById('totalImages').textContent    = data.totalImages ?? '—';
  document.getElementById('totalGalleries').textContent = totalGalleries  || '—';
  document.getElementById('totalSize').textContent      = data.totalSize ? formatSize(data.totalSize) : '—';

  const list = document.getElementById('galleryList');
  const top5 = galleriesArr.slice(0, 5);

  if (!top5.length) {
    list.innerHTML = '<div class="empty-state">No images cached yet.<br>Browse nhentai to start caching.</div>';
    return;
  }

  list.innerHTML = '';

  for (const gallery of top5) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.dataset.gid = gallery.id;

    const thumbHtml = gallery.cover
      ? `<div class="thumb-wrap"><img class="thumb" src="${gallery.cover}" alt=""></div>`
      : `<div class="thumb-wrap"><div class="thumb-placeholder">📁</div></div>`;

    const titleHtml = gallery.title
      ? `<div class="gallery-title">${escHtml(gallery.title)}</div>`
      : '';

    const tagsHtml  = buildTagsHtml(gallery.tags);
    const readerUrl = chrome.runtime.getURL(`reader.html`) + `?g=${gallery.id}`;

    item.innerHTML = `
      <a class="gallery-link" href="${readerUrl}" target="_blank">
        ${thumbHtml}
        <div class="gallery-info">
          <div class="gallery-id">#${gallery.id}</div>
          ${titleHtml}
          ${tagsHtml}
          <div class="gallery-meta">${gallery.count} imgs · ${formatSize(gallery.size)}</div>
        </div>
      </a>
      <button class="delete-btn" data-id="${gallery.id}" title="Delete">${DEL_ICON}</button>
    `;
    list.appendChild(item);
  }

  if (totalGalleries > 5) {
    const more = document.createElement('div');
    more.className = 'more-hint';
    more.textContent = `+${totalGalleries - 5} more — view all`;
    more.style.cursor = 'pointer';
    more.addEventListener('click', openLibrary);
    list.appendChild(more);
  }

  requestAnimationFrame(() => {
    list.querySelectorAll('.gallery-tags').forEach(clipOverflowingTags);
  });

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (!e.shiftKey && !confirm(`Delete all cached images for gallery #${id}?`)) return;
      btn.innerHTML = '…';
      btn.disabled = true;
      await sendMsg({ type: 'DELETE_GALLERY', galleryId: id });
      setStatus(`Gallery #${id} removed.`);
      await loadStats(true);
    });
  });
}

async function loadStats(skipCache = false) {
  if (!skipCache) {
    const stored = await new Promise(r => chrome.storage.local.get(['popupCache'], r));
    if (stored.popupCache) _renderGalleryList(stored.popupCache);
  }

  const data = await sendMsg({ type: 'GET_ALL_GALLERIES' });
  if (!data) {
    if (!document.querySelector('.gallery-item')) {
      document.getElementById('galleryList').innerHTML =
        '<div class="empty-state">Error reading cache.</div>';
    }
    return;
  }

  const allGalleries   = data.galleries || [];
  const totalGalleries = allGalleries.length;

  _renderGalleryList({ ...data, galleries: allGalleries, totalGalleries });

  chrome.storage.local.set({
    popupCache: {
      totalImages: data.totalImages,
      totalSize:   data.totalSize,
      totalGalleries,
      galleries:   allGalleries.slice(0, 5),
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'libraryVersion' in changes) loadStats(true);
});

function openLibrary() {
  const url = chrome.runtime.getURL('library.html');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.update(tabs[0].id, { url });
    else chrome.tabs.create({ url });
  });
}

const toggle = document.getElementById('enableToggle');
chrome.storage.local.get(['cacheEnabled'], (r) => { toggle.checked = r.cacheEnabled !== false; });
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ cacheEnabled: toggle.checked });
  setStatus(toggle.checked ? 'Caching enabled.' : 'Caching paused.');
});


document.getElementById('refreshBtn').addEventListener('click', async (e) => {
  if (e.ctrlKey) { chrome.runtime.reload(); return; }
  setStatus('Refreshing…');
  await loadStats(true);
  setStatus('Updated.');
});

document.getElementById('viewAllBtn').addEventListener('click', openLibrary);

document.getElementById('uploadCbzBtn').addEventListener('click', () => {
  const url = chrome.runtime.getURL('library.html') + '?import=1';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.update(tabs[0].id, { url });
    else chrome.tabs.create({ url });
  });
});
document.getElementById('logoBtn').addEventListener('click', openLibrary);

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('locationBtn').addEventListener('click', () => {
  const panel = document.getElementById('locationPanel');
  if (!panel.classList.contains('show')) {
    const extId = chrome.runtime.id;
    document.getElementById('locationPath').textContent =
      `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\IndexedDB\\chrome-extension_${extId}_0.indexeddb.leveldb`;
  }
  panel.classList.toggle('show');
});

document.getElementById('copyPathBtn').addEventListener('click', () => {
  const path = document.getElementById('locationPath').textContent;
  navigator.clipboard.writeText(path).then(() => {
    const btn = document.getElementById('copyPathBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
});

loadStats();
