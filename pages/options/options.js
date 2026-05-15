// options.js — Settings page controller

function showStatus(id, msg, type, durationMs = 2500) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'status-msg hidden'; }, durationMs);
}

function updateKeyBadge(hasKey) {
  const badge = document.getElementById('keyBadge');
  badge.style.display = 'inline-flex';
  if (hasKey) {
    badge.className = 'key-status-badge set';
    badge.textContent = '✓ API key saved';
  } else {
    badge.className = 'key-status-badge unset';
    badge.textContent = '⚠ No API key set';
  }
}

// ── Load saved values ──────────────────────────────────────────────────────

chrome.storage.local.get(['apiKey', 'cacheEnabled'], (r) => {
  const hasKey = !!r.apiKey;
  if (hasKey) {
    document.getElementById('apiKeyInput').value = r.apiKey;
  }
  updateKeyBadge(hasKey);
  document.getElementById('cacheToggle').checked = r.cacheEnabled !== false;
});

// ── Reveal / hide key ──────────────────────────────────────────────────────

const revealBtn = document.getElementById('revealBtn');
const apiKeyInput = document.getElementById('apiKeyInput');

revealBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  revealBtn.textContent = isPassword ? 'Hide' : 'Show';
});

// ── Save API key ───────────────────────────────────────────────────────────

document.getElementById('saveKeyBtn').addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus('keyStatus', 'Enter a key before saving.', 'err');
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    updateKeyBadge(true);
    showStatus('keyStatus', 'API key saved.', 'ok');
    // ensure input stays masked after save
    apiKeyInput.type = 'password';
    revealBtn.textContent = 'Show';
  });
});

// ── Remove API key ─────────────────────────────────────────────────────────

document.getElementById('clearKeyBtn').addEventListener('click', () => {
  if (!confirm('Remove the saved API key?')) return;
  chrome.storage.local.remove('apiKey', () => {
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
    revealBtn.textContent = 'Show';
    updateKeyBadge(false);
    showStatus('keyStatus', 'API key removed.', 'ok');
  });
});

// ── Clear all cache ────────────────────────────────────────────────────────

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm('Clear ALL cached galleries and images?\n\nThis cannot be undone.')) return;
  if (!confirm('Second confirmation: permanently delete everything?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_ALL' }, () => {
    chrome.storage.local.remove('libraryCache');
    showStatus('clearAllStatus', 'Cache cleared.', 'ok');
  });
});

// ── Save behaviour settings ────────────────────────────────────────────────

document.getElementById('saveBehaviorBtn').addEventListener('click', () => {
  const enabled = document.getElementById('cacheToggle').checked;
  chrome.storage.local.set({ cacheEnabled: enabled }, () => {
    showStatus('behaviorStatus', 'Settings saved.', 'ok');
  });
});

// ── Library Backup ────────────────────────────────────────────────────────

const _BK_DB_NAME    = 'nhentai-image-cache';
const _BK_DB_VERSION = 7;
const _BK_META       = 'metadata';
const _BK_GAL        = 'galleries';

function _bkOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_BK_DB_NAME, _BK_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const n of Array.from(db.objectStoreNames)) db.deleteObjectStore(n);
      const s = db.createObjectStore('images', { keyPath: 'url' });
      s.createIndex('mediaId',   'mediaId',   { unique: false });
      s.createIndex('galleryId', 'galleryId', { unique: false });
      db.createObjectStore(_BK_META, { keyPath: 'galleryId' });
      db.createObjectStore(_BK_GAL,  { keyPath: 'galleryId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _bkPut(db, store, record) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function exportLibraryBackup() {
  const db      = await _bkOpenDB();
  const allMeta = await new Promise((resolve, reject) => {
    const tx  = db.transaction(_BK_META, 'readonly');
    const req = tx.objectStore(_BK_META).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  const payload = allMeta.map(({ pageExts, ...rest }) => rest);
  const blob    = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = `shiori-backup-${new Date().toISOString().slice(0, 10)}.shi`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showStatus('backupStatus', `Exported ${payload.length} galleries.`, 'ok');
}

document.getElementById('exportBackupBtn').addEventListener('click', () =>
  exportLibraryBackup().catch(err => showStatus('backupStatus', 'Export failed: ' + err.message, 'err'))
);

// ── Storage Writes ────────────────────────────────────────────────────────

function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function updateWritesDisplay(bytes) {
  document.getElementById('totalWritesCount').textContent = formatBytes(bytes || 0);
}

chrome.storage.local.get(['totalWrittenBytes'], r => updateWritesDisplay(r.totalWrittenBytes));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'totalWrittenBytes' in changes)
    updateWritesDisplay(changes.totalWrittenBytes.newValue);
});

document.getElementById('resetWritesBtn').addEventListener('click', () => {
  if (!confirm('Reset the lifetime write counter to zero?')) return;
  chrome.storage.local.set({ totalWrittenBytes: 0 }, () => {
    updateWritesDisplay(0);
    showStatus('writesStatus', 'Counter reset.', 'ok');
  });
});

// ── About modal ───────────────────────────────────────────────────────────

const aboutModal = document.getElementById('aboutModal');
const aboutBtn   = document.getElementById('aboutBtn');
const aboutClose = document.getElementById('aboutClose');

function setAboutOpen(open) {
  aboutModal.classList.toggle('show', open);
}

aboutBtn.addEventListener('click', () => setAboutOpen(true));
aboutClose.addEventListener('click', () => setAboutOpen(false));
aboutModal.addEventListener('click', (e) => { if (!e.target.closest('#aboutBox')) setAboutOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setAboutOpen(false); });

// Version from manifest — single source of truth, always in sync.
document.getElementById('aboutVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// Render CHANGELOG.md using marked, with a custom renderer to split version/date in h2.
marked.use({
  gfm: true,
  renderer: {
    heading({ text, depth }) {
      if (depth === 1) return '';
      if (depth === 2) {
        const m = text.match(/^(.+?) — (.+)$/);
        if (m) return `<h2><span class="cl-ver">${m[1]}</span><span class="cl-date">${m[2]}</span></h2>\n`;
        return `<h2>${text}</h2>\n`;
      }
      return false;
    }
  }
});

(async () => {
  try {
    const text = await fetch(chrome.runtime.getURL('CHANGELOG.md')).then(r => r.text());
    document.getElementById('aboutChangelog').innerHTML = marked.parse(text);
  } catch {
    document.getElementById('aboutChangelog').innerHTML =
      '<p style="font-size:11px;color:var(--muted)">Changelog unavailable.</p>';
  }
})();

