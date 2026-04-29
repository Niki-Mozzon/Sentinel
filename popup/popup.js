'use strict';

const DEFAULTS = {
  enabled: true,
  showConsoleErrors: true,
  showConsoleWarns: false,
  showNetwork: true,
  networkMinStatus: 0,
  clearOnNav: false,
  watchCooldownSecs: 30
};

const ids = ['enabled', 'showConsoleErrors', 'showConsoleWarns', 'showNetwork', 'networkMinStatus', 'clearOnNav', 'watchCooldownSecs'];

function el(id) { return document.getElementById(id); }

function applySettings(settings) {
  ids.forEach(id => {
    const input = el(id);
    if (!input) return;
    if (input.type === 'checkbox') {
      input.checked = settings[id];
    } else {
      input.value = settings[id];
    }
  });
  updateThresholdVisibility(settings.showNetwork);
}

function updateThresholdVisibility(showNetwork) {
  const row = el('row-threshold');
  if (row) row.style.opacity = showNetwork ? '1' : '0.4';
}

function save(key, value) {
  const patch = {};
  patch[key] = value;
  chrome.storage.sync.set(patch);
}

chrome.storage.sync.get(DEFAULTS, applySettings);

// ── Ignore rules ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRules(rules) {
  const listEl = document.getElementById('rules-list');
  if (!listEl) return;
  if (!rules || rules.length === 0) {
    listEl.innerHTML = '<div class="rules-empty">No ignore rules</div>';
    return;
  }
  listEl.innerHTML = rules.map(function (r) {
    const icon = r.kind === 'network' ? '⬡' : '●';
    const cls  = r.kind === 'network' ? 'net' : 'cons';
    const desc = r.kind === 'network'
      ? r.urlPath + (r.status != null ? ' [' + r.status + ']' : '')
      : '"' + r.messageContains + '"';
    return '<div class="rule-row">' +
      '<span class="rule-icon ' + cls + '">' + icon + '</span>' +
      '<span class="rule-desc" title="' + esc(desc) + '">' + esc(desc) + '</span>' +
      '<button class="rule-del" data-rule-id="' + esc(r.id) + '">Delete</button>' +
    '</div>';
  }).join('');
}

chrome.storage.sync.get({ ignoreRules: [] }, function (r) { renderRules(r.ignoreRules); });

chrome.storage.onChanged.addListener(function (changes) {
  if (changes.ignoreRules) renderRules(changes.ignoreRules.newValue || []);
});

const rulesListEl = document.getElementById('rules-list');
if (rulesListEl) {
  rulesListEl.addEventListener('click', function (event) {
    const btn = event.target.closest('.rule-del');
    if (!btn) return;
    const id = btn.getAttribute('data-rule-id');
    chrome.storage.sync.get({ ignoreRules: [] }, function (r) {
      chrome.storage.sync.set({ ignoreRules: (r.ignoreRules || []).filter(function (x) { return x.id !== id; }) });
    });
  });
}

ids.forEach(id => {
  const input = el(id);
  if (!input) return;
  input.addEventListener('change', () => {
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    save(id, value);
    if (id === 'showNetwork') updateThresholdVisibility(value);
  });
});

// ── Watch rules ───────────────────────────────────────────────────────────────

function renderWatchRules(rules) {
  const listEl = document.getElementById('watch-rules-list');
  if (!listEl) return;
  if (!rules || rules.length === 0) {
    listEl.innerHTML = '<div class="rules-empty">No watch rules</div>';
    return;
  }
  listEl.innerHTML = rules.map(function (r) {
    const icon = r.kind === 'network' ? '⬡' : '●';
    const cls  = r.kind === 'network' ? 'net' : 'cons';
    const desc = r.kind === 'network'
      ? r.urlPath + (r.status != null ? ' [' + r.status + ']' : '')
      : '"' + r.messageContains + '"';
    return '<div class="rule-row">' +
      '<span class="rule-icon watch-rule-icon ' + cls + '">' + icon + '</span>' +
      '<span class="rule-desc" title="' + esc(desc) + '">' + esc(desc) + '</span>' +
      '<button class="rule-del" data-watch-rule-id="' + esc(r.id) + '">Delete</button>' +
    '</div>';
  }).join('');
}

chrome.storage.sync.get({ watchRules: [] }, function (r) { renderWatchRules(r.watchRules); });

chrome.storage.onChanged.addListener(function (changes) {
  if (changes.watchRules) renderWatchRules(changes.watchRules.newValue || []);
});

const watchRulesListEl = document.getElementById('watch-rules-list');
if (watchRulesListEl) {
  watchRulesListEl.addEventListener('click', function (event) {
    const btn = event.target.closest('.rule-del[data-watch-rule-id]');
    if (!btn) return;
    const id = btn.getAttribute('data-watch-rule-id');
    chrome.storage.sync.get({ watchRules: [] }, function (r) {
      chrome.storage.sync.set({ watchRules: (r.watchRules || []).filter(function (x) { return x.id !== id; }) });
    });
  });
}
