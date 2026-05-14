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

