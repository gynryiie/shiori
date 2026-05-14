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

// ── Changelog — parsed from CHANGELOG.md at runtime ───────────────────────

(async () => {
  try {
    const text = await fetch(chrome.runtime.getURL('CHANGELOG.md')).then(r => r.text());
    const body = document.getElementById('changelogBody');

    const entries = [];
    let cur = null, curSection = null;

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('## ')) {
        if (cur) entries.push(cur);
        const m = line.match(/^## (.+?) — (.+)$/);
        cur = { version: m ? m[1] : line.slice(3), date: m ? m[2].trim() : '', sections: [], plain: [] };
        curSection = null;
      } else if (line.startsWith('### ')) {
        curSection = { title: line.slice(4), items: [] };
        cur?.sections.push(curSection);
      } else if (line.startsWith('- ') && curSection) {
        curSection.items.push(line.slice(2));
      } else if (line && !line.startsWith('#') && cur && !curSection) {
        cur.plain.push(line);
      }
    }
    if (cur) entries.push(cur);

    body.innerHTML = entries.map(e => `
      <div class="cl-entry">
        <div class="cl-version">${e.version} <span class="cl-date">${e.date}</span></div>
        ${e.sections.map(s => `
          <div class="cl-section">${s.title}</div>
          <ul class="cl-list">${s.items.map(i => `<li>${i}</li>`).join('')}</ul>
        `).join('')}
        ${e.plain.length ? `<ul class="cl-list">${e.plain.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
      </div>
    `).join('');
  } catch {
    // Silently skip if CHANGELOG.md is missing
  }
})();

