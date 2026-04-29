(function () {
  'use strict';

  const MSG_TYPE    = '__SENTINEL__';
  const REPLAY_TYPE = '__SENTINEL_REPLAY__';
  const DEDUP_MS    = 500;

  const ICON16 = chrome.runtime.getURL('icons/icon16.png');
  const ICON_IMG = '<img class="sicon-logo" src="' + ICON16 + '" alt="">';

  const EYE_SLASH =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 8c1.5-3 3.8-4.5 6-4.5s4.5 1.5 6 4.5c-1.5 3-3.8 4.5-6 4.5S3.5 11 2 8z"/>' +
    '<circle cx="8" cy="8" r="1.8"/>' +
    '<line x1="2.5" y1="2.5" x2="13.5" y2="13.5"/>' +
    '</svg>';

  const BELL =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 2a5 5 0 0 1 5 5v2.5l1.5 2H1.5L3 9.5V7a5 5 0 0 1 5-5z"/>' +
    '<path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/>' +
    '</svg>';

  const GEAR =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="8" cy="8" r="2.5"/>' +
    '<path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>' +
    '</svg>';

  const DEFAULTS = {
    enabled: true,
    showConsoleErrors: true,
    showConsoleWarns: false,
    showNetwork: true,
    networkMinStatus: 0,
    clearOnNav: false,
    maxEntries: 100,
    watchCooldownSecs: 30
  };

  // ── State ──────────────────────────────────────────────────────────────────

  let settings    = Object.assign({}, DEFAULTS);
  let ignoreRules = [];
  let watchRules  = [];
  let entries  = [];
  let nextId   = 0;
  let isExpanded = false;
  let hasUnseen  = false;
  let domReady   = false;

  let watchToastTimes = {};

  let host    = null;
  let shadow  = null;
  let badgeEl = null;
  let panelEl = null;
  let listEl  = null;
  let modalEl     = null;
  let modalBodyEl = null;
  let currentModalEntry = null;
  let settingsModalEl = null;
  let activeSettingsTab = 'settings';
  let toastEl    = null;
  let toastTimer = null;
  let toastEntry = null;

  // ── Settings ───────────────────────────────────────────────────────────────

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === '__SENTINEL_OPEN_SETTINGS__') showSettingsModal();
    });
  } catch (_) {}

  try {
    chrome.storage.sync.get(DEFAULTS, function (result) {
      settings = Object.assign({}, DEFAULTS, result);
      if (domReady) render();
    });
    chrome.storage.sync.get({ ignoreRules: [] }, function (result) {
      ignoreRules = result.ignoreRules || [];
    });
    chrome.storage.sync.get({ watchRules: [] }, function (result) {
      watchRules = result.watchRules || [];
    });
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.ignoreRules) {
        ignoreRules = changes.ignoreRules.newValue || [];
        if (domReady) renderList();
        if (settingsModalEl && settingsModalEl.style.display !== 'none') renderSettingsModal();
        return;
      }
      if (changes.watchRules) {
        watchRules = changes.watchRules.newValue || [];
        if (domReady) renderList();
        if (settingsModalEl && settingsModalEl.style.display !== 'none') renderSettingsModal();
        return;
      }
      Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
      if (domReady) render();
      if (settingsModalEl && settingsModalEl.style.display !== 'none') renderSettingsModal();
    });
  } catch (_) {}

  // ── Event filtering ────────────────────────────────────────────────────────

  function shouldCapture(ev) {
    if (!settings.enabled) return false;
    if (ev.kind === 'console' || ev.kind === 'uncaught' || ev.kind === 'rejection') {
      return ev.level === 'warn' ? settings.showConsoleWarns : settings.showConsoleErrors;
    }
    if (ev.kind === 'network') {
      if (!settings.showNetwork) return false;
      const min = settings.networkMinStatus || 0;
      if (min === 500 && ev.status < 500 && ev.status !== 0) return false;
      if (min === 400 && ev.status < 400 && ev.status !== 0) return false;
      return true;
    }
    return true;
  }

  // ── Ignore rules ───────────────────────────────────────────────────────────

  function matchesIgnoreRule(e) {
    for (var i = 0; i < ignoreRules.length; i++) {
      var r = ignoreRules[i];
      if (r.kind === 'network' && e.kind === 'network') {
        if (urlPath(e.url || '') === r.urlPath && r.status === e.status) return true;
      } else if (r.kind === 'console' &&
                 (e.kind === 'console' || e.kind === 'uncaught' || e.kind === 'rejection')) {
        if ((e.message || '').toLowerCase().indexOf(r.messageContains) !== -1) return true;
      }
    }
    return false;
  }

  function ignoreEntry(e) {
    var rule = e.kind === 'network'
      ? { id: genRuleId(), kind: 'network', urlPath: urlPath(e.url || ''), status: e.status, createdAt: Date.now() }
      : { id: genRuleId(), kind: 'console', messageContains: (e.message || '').slice(0, 80).trim().toLowerCase(), createdAt: Date.now() };
    ignoreRules = ignoreRules.concat([rule]);
    try { chrome.storage.sync.set({ ignoreRules: ignoreRules }); } catch (_) {}

    // Remove any watch rule that would fire for this entry
    const filtered = watchRules.filter(function (r) {
      if (r.kind === 'network' && e.kind === 'network') {
        return !(urlPath(e.url || '') === r.urlPath && r.status === e.status);
      }
      if (r.kind === 'console' && (e.kind === 'console' || e.kind === 'uncaught' || e.kind === 'rejection')) {
        return (e.message || '').toLowerCase().indexOf(r.messageContains) === -1;
      }
      return true;
    });
    if (filtered.length !== watchRules.length) {
      watchRules = filtered;
      try { chrome.storage.sync.set({ watchRules: watchRules }); } catch (_) {}
    }

    renderList();
    renderBadge();
  }

  function genRuleId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Watch rules ────────────────────────────────────────────────────────────

  function findWatchRule(e) {
    for (var i = 0; i < watchRules.length; i++) {
      var r = watchRules[i];
      if (r.kind === 'network' && e.kind === 'network') {
        if (urlPath(e.url || '') === r.urlPath && r.status === e.status) return r;
      } else if (r.kind === 'console' &&
                 (e.kind === 'console' || e.kind === 'uncaught' || e.kind === 'rejection')) {
        if ((e.message || '').toLowerCase().indexOf(r.messageContains) !== -1) return r;
      }
    }
    return null;
  }

  function matchesWatchRule(e) { return findWatchRule(e) !== null; }

  function watchEntry(e) {
    var rule = e.kind === 'network'
      ? { id: genRuleId(), kind: 'network', urlPath: urlPath(e.url || ''), status: e.status, createdAt: Date.now() }
      : { id: genRuleId(), kind: 'console', messageContains: (e.message || '').slice(0, 80).trim().toLowerCase(), createdAt: Date.now() };
    watchRules = watchRules.concat([rule]);
    try { chrome.storage.sync.set({ watchRules: watchRules }); } catch (_) {}
    renderList();
  }

  // ── Entry management ───────────────────────────────────────────────────────

  function withinCooldown(rule) {
    if (!settings.watchCooldownSecs) return false;
    return Date.now() - (watchToastTimes[rule.id] || 0) < settings.watchCooldownSecs * 1000;
  }

  function fireWatchToast(e) {
    const rule = findWatchRule(e);
    if (!rule || withinCooldown(rule)) return;
    watchToastTimes[rule.id] = Date.now();
    showToast(e);
  }

  function addEntry(ev) {
    if (!shouldCapture(ev)) return;
    const watchRule = findWatchRule(ev);
    const willWatch = watchRule !== null;

    // Watched + within cooldown → suppress entirely
    if (willWatch && withinCooldown(watchRule)) return;

    if (!willWatch && matchesIgnoreRule(ev)) return;

    const last = entries[entries.length - 1];
    if (last && last.kind === ev.kind && last.message === ev.message &&
        (ev.timestamp - last.timestamp) < DEDUP_MS) {
      last.count++;
      last.timestamp = ev.timestamp;
      if (domReady) renderList();
      if (willWatch) fireWatchToast(last);
      return;
    }

    entries.push({
      id:         nextId++,
      kind:       ev.kind,
      level:      ev.level || 'error',
      message:    ev.message || '',
      url:        ev.url        || null,
      method:     ev.method     || null,
      status:     ev.status     != null ? ev.status : null,
      statusText: ev.statusText || null,
      filename:   ev.filename   || null,
      lineno:     ev.lineno     || null,
      stack:      ev.stack      || null,
      storeId:    ev.storeId    != null ? ev.storeId : null,
      reqHeaders: ev.reqHeaders || null,
      reqBody:    ev.reqBody    || null,
      resHeaders: ev.resHeaders || null,
      resBody:    ev.resBody    || null,
      timestamp:  ev.timestamp  || Date.now(),
      count:      1
    });

    if (entries.length > (settings.maxEntries || 100)) entries.shift();
    if (!isExpanded) hasUnseen = true;
    if (domReady) render();
    if (willWatch) {
      watchToastTimes[watchRule.id] = Date.now();
      showToast(entries[entries.length - 1]);
    }
  }

  // ── Message listener ───────────────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== MSG_TYPE) return;
    addEntry(event.data);
  });

  // ── SPA navigation ─────────────────────────────────────────────────────────

  ['popstate', 'hashchange'].forEach(function (evt) {
    window.addEventListener(evt, function () {
      if (settings.clearOnNav) { entries = []; if (domReady) render(); }
    });
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    renderBadge();
    if (isExpanded) renderList();
  }

  function renderBadge() {
    if (!badgeEl) return;
    if (isExpanded) { badgeEl.style.display = 'none'; return; }
    let errors = 0, warns = 0, network = 0;
    entries.forEach(function (e) {
      if (matchesIgnoreRule(e)) return;
      if (e.kind === 'network') network++;
      else if (e.level === 'warn') warns++;
      else errors++;
    });
    const visible = errors + warns + network;
    if (!settings.enabled || visible === 0) { badgeEl.style.display = 'none'; return; }
    badgeEl.style.display = '';
    badgeEl.classList.toggle('unseen', hasUnseen);
    badgeEl.innerHTML = ICON_IMG + '<span class="bcount">' + visible + '</span>';
  }

  function renderList() {
    if (!listEl) return;
    const visible = entries.slice().reverse().filter(function (e) { return !matchesIgnoreRule(e); });
    if (visible.length === 0) {
      listEl.innerHTML = '<div class="empty">No errors captured yet</div>';
      return;
    }
    listEl.innerHTML = visible.map(renderEntry).join('');
  }

  // ── Entry rendering ────────────────────────────────────────────────────────

  function renderEntry(e) {
    const cls       = entryClass(e);
    const hasDetail = hasExpandableDetail(e);
    const chevron   = hasDetail ? '<span class="chevron">▸</span>' : '';
    const countHtml = e.count > 1 ? '<span class="count">×' + e.count + '</span>' : '';
    const time      = formatTime(e.timestamp);

    let bodyHtml;
    if (e.kind === 'network') {
      const status  = e.status === 0 ? 'ERR' : String(e.status);
      const path    = escHtml(truncate(urlPath(e.url || ''), 80));
      bodyHtml =
        '<span class="eicon" title="Failed network request">⬡</span>' +
        '<span class="emethod">' + escHtml(e.method || 'REQ') + '</span>' +
        '<span class="estatus ' + statusClass(e.status) + '">' + status + '</span>' +
        '<span class="epath">' + path + '</span>';
    } else {
      bodyHtml =
        '<span class="eicon" title="' + entryTooltip(e) + '">' + entryIcon(e) + '</span>' +
        '<span class="emsg">' + escHtml(truncate(e.message || '', 90)) + '</span>';
    }

    const ignoreBtn = '<button class="pbtn entry-btn ignore-btn" data-action="ignore" data-id="' + e.id + '" title="Ignore this error">' + EYE_SLASH + '</button>';
    const isWatched = matchesWatchRule(e);
    const watchBtn  = '<button class="pbtn entry-btn watch-btn' + (isWatched ? ' watching' : '') +
      '" data-action="watch" data-id="' + e.id + '" title="' + (isWatched ? 'Already watching' : 'Watch this error') + '">' + BELL + '</button>';
    return '<div class="entry ' + cls + (hasDetail ? ' expandable' : '') + '" data-id="' + e.id + '">' +
      '<div class="emain">' + chevron + bodyHtml + countHtml + watchBtn + ignoreBtn + '<span class="etime">' + time + '</span></div>' +
    '</div>';
  }

  function urlPath(url) {
    try { return new URL(url).pathname; } catch (_) { return url; }
  }

  function statusClass(status) {
    if (status === 0)                     return 'serr';
    if (status >= 500 && status <= 599)   return 's5xx';
    if (status >= 400 && status <= 499)   return 's4xx';
    return 'sother';
  }

  function hasExpandableDetail(e) {
    if (e.kind === 'network') return true;
    return !!(e.stack || e.filename || e.message);
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function showModal(e) {
    currentModalEntry = e;
    const titleEl = modalEl.querySelector('.modal-title');
    if (titleEl) titleEl.innerHTML = ICON_IMG + escHtml(modalTitle(e));
    const replayBtn = modalEl.querySelector('[data-action="replay"]');
    if (replayBtn) replayBtn.style.display = e.storeId != null ? '' : 'none';
    if (replayBtn) replayBtn.setAttribute('data-store-id', e.storeId != null ? e.storeId : '');
    modalBodyEl.innerHTML = buildModalHtml(e);
    Object.assign(host.style, { bottom: '0', right: '0', left: '0', top: '0' });
    modalEl.style.display = '';
  }

  function hideModal() {
    currentModalEntry = null;
    modalEl.style.display = 'none';
    Object.assign(host.style, { bottom: '16px', right: '16px', left: '', top: '' });
  }

  function showSettingsModal() {
    activeSettingsTab = 'settings';
    settingsModalEl.querySelectorAll('.stab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === 'settings');
    });
    settingsModalEl.querySelectorAll('.stab-panel').forEach(function (p) {
      p.style.display = p.id === 'stab-settings' ? '' : 'none';
    });
    renderSettingsModal();
    Object.assign(host.style, { bottom: '0', right: '0', left: '0', top: '0' });
    settingsModalEl.style.display = '';
  }

  function hideSettingsModal() {
    settingsModalEl.style.display = 'none';
    Object.assign(host.style, { bottom: '16px', right: '16px', left: '', top: '' });
  }

  function renderSettingsModal() {
    var cbs = settingsModalEl.querySelectorAll('input[data-setting]');
    cbs.forEach(function (cb) {
      var key = cb.getAttribute('data-setting');
      cb.checked = !!settings[key];
    });
    var sels = settingsModalEl.querySelectorAll('select[data-setting]');
    sels.forEach(function (sel) {
      var key = sel.getAttribute('data-setting');
      sel.value = String(settings[key] != null ? settings[key] : '');
    });
    var threshRow = settingsModalEl.querySelector('.srow[data-depends="showNetwork"]');
    if (threshRow) threshRow.classList.toggle('sdisabled', !settings.showNetwork);

    var ignoreContainer = settingsModalEl.querySelector('#smodal-ignore-rules');
    if (ignoreContainer) {
      if (ignoreRules.length === 0) {
        ignoreContainer.innerHTML = '<div class="srules-empty">No ignore rules</div>';
      } else {
        ignoreContainer.innerHTML = ignoreRules.map(function (r) {
          var icon = r.kind === 'network' ? '⬡' : '●';
          var cls  = r.kind === 'network' ? 'net' : 'cons';
          var desc = r.kind === 'network'
            ? r.urlPath + (r.status != null ? ' [' + r.status + ']' : '')
            : '"' + r.messageContains + '"';
          return '<div class="srule-row">' +
            '<span class="srule-icon ' + cls + '">' + icon + '</span>' +
            '<span class="srule-desc" title="' + escAttr(desc) + '">' + escHtml(desc) + '</span>' +
            '<button class="pbtn srule-del" data-action="del-ignore-rule" data-rule-id="' + escAttr(r.id) + '">Delete</button>' +
          '</div>';
        }).join('');
      }
    }

    var watchContainer = settingsModalEl.querySelector('#smodal-watch-rules');
    if (watchContainer) {
      if (watchRules.length === 0) {
        watchContainer.innerHTML = '<div class="srules-empty">No watch rules</div>';
      } else {
        watchContainer.innerHTML = watchRules.map(function (r) {
          var icon = r.kind === 'network' ? '⬡' : '●';
          var desc = r.kind === 'network'
            ? r.urlPath + (r.status != null ? ' [' + r.status + ']' : '')
            : '"' + r.messageContains + '"';
          return '<div class="srule-row">' +
            '<span class="srule-icon watch">' + icon + '</span>' +
            '<span class="srule-desc" title="' + escAttr(desc) + '">' + escHtml(desc) + '</span>' +
            '<button class="pbtn srule-del" data-action="del-watch-rule" data-watch-rule-id="' + escAttr(r.id) + '">Delete</button>' +
          '</div>';
        }).join('');
      }
    }
  }

  function dismissToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
    toastEntry = null;
  }

  function showToast(e) {
    dismissToast();
    toastEntry = e;
    const cls      = entryClass(e);
    const iconHtml = '<span class="toast-icon">' + (e.kind === 'network' ? '⬡' : entryIcon(e)) + '</span>';
    const msgText  = e.kind === 'network'
      ? (e.method || 'REQ') + ' ' + truncate(urlPath(e.url || ''), 48)
      : truncate(e.message || '', 60);
    toastEl = document.createElement('div');
    toastEl.className = 'sentinel-toast ' + cls;
    toastEl.innerHTML =
      '<div class="toast-body">' +
        iconHtml +
        '<span class="toast-msg">' + escHtml(msgText) + '</span>' +
        '<div class="toast-actions">' +
          '<button class="pbtn" data-action="view-toast">View</button>' +
          '<button class="pbtn pbtn-close" data-action="dismiss-toast">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="toast-progress"><div class="toast-progress-bar"></div></div>';
    toastEl.addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-action]');
      if (btn) handleAction(btn);
    });
    shadow.appendChild(toastEl);
    requestAnimationFrame(function () {
      const bar = toastEl && toastEl.querySelector('.toast-progress-bar');
      if (bar) bar.style.width = '0%';
    });
    toastTimer = setTimeout(dismissToast, 6000);
  }

  function modalTitle(e) {
    if (e.kind === 'network') return (e.method || 'GET') + ' ' + truncate(e.url || '', 70);
    if (e.kind === 'uncaught') return 'Uncaught Error';
    if (e.kind === 'rejection') return 'Unhandled Rejection';
    return e.level === 'warn' ? 'Console Warning' : 'Console Error';
  }

  function buildModalHtml(e) {
    var sections = [];
    if (e.kind === 'network') {
      sections.push(modalSection('Request', escHtml((e.method || 'GET') + ' ' + (e.url || ''))));
      if (e.reqHeaders) sections.push(modalSection('Request Headers', formatHeaders(e.reqHeaders)));
      if (e.reqBody)    sections.push(modalSection('Request Body',    formatBody(e.reqBody)));
      const statusStr = (e.status === 0 ? 'Network Error' : String(e.status)) +
                        (e.statusText ? ' ' + e.statusText : '');
      sections.push(modalSection('Response', escHtml(statusStr)));
      if (e.resHeaders) sections.push(modalSection('Response Headers', formatHeaders(e.resHeaders)));
      if (e.resBody)    sections.push(modalSection('Response Body',    formatBody(e.resBody)));
      if (e.stack)      sections.push(modalSection('Call Stack',       escHtml(e.stack)));
    } else {
      sections.push(modalSection('Message', escHtml(e.message || '')));
      if (e.stack) {
        sections.push(modalSection('Stack Trace', escHtml(e.stack)));
      } else if (e.filename && e.lineno) {
        sections.push(modalSection('Location', escHtml(e.filename + ':' + e.lineno)));
      }
    }
    return sections.join('');
  }

  function modalSection(title, contentHtml) {
    return '<div class="msec">' +
      '<div class="msec-title">' + escHtml(title) + '</div>' +
      '<pre class="msec-body">' + contentHtml + '</pre>' +
    '</div>';
  }

  function formatHeaders(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return escHtml(Object.keys(obj).map(function (k) {
      return k + ': ' + obj[k];
    }).join('\n'));
  }

  function formatBody(body) {
    if (!body) return '';
    var str = String(body);
    try {
      return escHtml(JSON.stringify(JSON.parse(str), null, 2));
    } catch (_) {
      return escHtml(str);
    }
  }

  function buildModalText(e) {
    if (!e) return '';
    var lines = [];
    if (e.kind === 'network') {
      lines.push('REQUEST: ' + (e.method || 'GET') + ' ' + (e.url || ''));
      if (e.reqHeaders) {
        lines.push('\nREQUEST HEADERS:');
        Object.keys(e.reqHeaders).forEach(function (k) { lines.push(k + ': ' + e.reqHeaders[k]); });
      }
      if (e.reqBody) { lines.push('\nREQUEST BODY:'); lines.push(e.reqBody); }
      lines.push('\nRESPONSE: ' + (e.status === 0 ? 'Network Error' : e.status) +
                 (e.statusText ? ' ' + e.statusText : ''));
      if (e.resHeaders) {
        lines.push('\nRESPONSE HEADERS:');
        Object.keys(e.resHeaders).forEach(function (k) { lines.push(k + ': ' + e.resHeaders[k]); });
      }
      if (e.resBody)  { lines.push('\nRESPONSE BODY:');  lines.push(e.resBody); }
      if (e.stack)    { lines.push('\nCALL STACK:');     lines.push(e.stack); }
    } else {
      lines.push('MESSAGE: ' + (e.message || ''));
      if (e.stack) { lines.push('\nSTACK:'); lines.push(e.stack); }
      else if (e.filename) lines.push('LOCATION: ' + e.filename + ':' + e.lineno);
    }
    return lines.join('\n');
  }

  // ── Action handling ────────────────────────────────────────────────────────

  function handleAction(btn) {
    const action = btn.getAttribute('data-action');

    if (action === 'replay') {
      const storeId = parseInt(btn.getAttribute('data-store-id'), 10);
      window.postMessage({ type: REPLAY_TYPE, storeId: storeId }, '*');
      feedback(btn, '✓ Logged');
    }

    if (action === 'copy-modal') {
      const text = buildModalText(currentModalEntry);
      try {
        navigator.clipboard.writeText(text).then(function () {
          feedback(btn, '✓ Copied');
        });
      } catch (_) {
        feedback(btn, '✗ Error');
      }
    }

    if (action === 'close-modal') {
      hideModal();
    }

    if (action === 'ignore') {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      const e = entries.find(function (x) { return x.id === id; });
      if (e) ignoreEntry(e);
    }

    if (action === 'ignore-modal') {
      if (currentModalEntry) { ignoreEntry(currentModalEntry); hideModal(); }
    }

    if (action === 'watch') {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      const e = entries.find(function (x) { return x.id === id; });
      if (e) watchEntry(e);
    }

    if (action === 'watch-modal') {
      if (currentModalEntry) watchEntry(currentModalEntry);
    }

    if (action === 'view-toast') {
      if (toastEntry) { const e = toastEntry; dismissToast(); showModal(e); }
    }

    if (action === 'dismiss-toast') {
      dismissToast();
    }

    if (action === 'open-settings') {
      showSettingsModal();
    }

    if (action === 'close-settings') {
      hideSettingsModal();
    }

    if (action === 'del-ignore-rule') {
      const ruleId = btn.getAttribute('data-rule-id');
      ignoreRules = ignoreRules.filter(function (r) { return r.id !== ruleId; });
      try { chrome.storage.sync.set({ ignoreRules: ignoreRules }); } catch (_) {}
      renderList();
      renderBadge();
      renderSettingsModal();
    }

    if (action === 'del-watch-rule') {
      const ruleId = btn.getAttribute('data-watch-rule-id');
      watchRules = watchRules.filter(function (r) { return r.id !== ruleId; });
      try { chrome.storage.sync.set({ watchRules: watchRules }); } catch (_) {}
      renderList();
      renderSettingsModal();
    }
  }

  function feedback(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = orig;
      btn.disabled = false;
    }, 2000);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function formatTime(ts) {
    try { return new Date(ts).toTimeString().slice(0, 8); } catch (_) { return ''; }
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // ── CSS ────────────────────────────────────────────────────────────────────

  const CSS = `
:host {
  all: initial;
  display: block;
  font-family: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
}
* { box-sizing: border-box; }

.root {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none;
}

/* ── Badge ── */
.badge {
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: center;
  background: rgba(14,14,18,0.90);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 20px;
  padding: 5px 11px;
  color: #d0d0d8;
  font-size: 11px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  user-select: none;
  transition: transform 0.1s, background 0.15s;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
}
.badge:hover { background: rgba(24,24,30,0.96); transform: scale(1.05); }
.badge.unseen {
  background: rgba(160,25,25,0.92);
  border-color: rgba(255,80,80,0.3);
  box-shadow: 0 2px 16px rgba(255,50,50,0.45);
  animation: badge-pulse 2s ease-in-out infinite;
}
@keyframes badge-pulse {
  0%, 100% { box-shadow: 0 2px 16px rgba(255,50,50,0.45); }
  50%       { box-shadow: 0 2px 26px rgba(255,50,50,0.75); }
}
.bcount { color: #d0d0d8; font-size: 12px; font-weight: 600; }
.badge.unseen .bcount { color: #fff; }

/* ── Panel ── */
.panel {
  pointer-events: auto;
  position: relative;
  background: rgba(13,13,17,0.95);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 8px;
  width: 460px;
  min-width: 300px;
  max-width: calc(100vw - 32px);
  max-height: 420px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #d0d0d8;
}
.resize-handle {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 5px;
  cursor: ew-resize;
  z-index: 1;
}
.resize-handle:hover, .resize-handle.dragging { background: rgba(170,102,255,0.25); }

.pheader {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: rgba(255,255,255,0.035);
  border-bottom: 1px solid rgba(255,255,255,0.07);
  flex-shrink: 0;
}
.ptitle {
  flex: 1;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #606070;
}
.pbtn {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.09);
  color: #808090;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: background 0.1s, color 0.1s;
}
.pbtn:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #d0d0d8; }
.pbtn:disabled { opacity: 0.5; cursor: default; }
.pbtn-close { padding: 1px 7px; font-size: 14px; }

.plist {
  overflow-y: auto;
  flex: 1;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.15) transparent;
}
.plist::-webkit-scrollbar { width: 4px; }
.plist::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

/* ── Entries ── */
@keyframes radar-sweep {
  from { transform: translateX(-100%); }
  to   { transform: translateX(350%); }
}
.panel::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 25%;
  height: 2px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(170,102,255,0.8), transparent);
  animation: radar-sweep 3s ease-in-out infinite alternate;
  z-index: 2;
}
.entry {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.035);
}
.entry.expandable { cursor: pointer; }
.entry.expandable:hover { background: rgba(255,255,255,0.02); }

.emain {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}
.chevron { font-size: 9px; color: #505060; flex-shrink: 0; width: 10px; }
.eicon   { font-size: 9px; flex-shrink: 0; }
.entry.err .eicon  { color: #ff5555; }
.entry.warn .eicon { color: #ffaa33; }
.entry.net .eicon  { color: #aa66ff; }
.entry.rej .eicon  { color: #ff7777; }

.emsg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.entry.err .emsg  { color: #ff8080; }
.entry.warn .emsg { color: #ffcc66; }
.entry.rej .emsg  { color: #ff9999; }

.emethod { font-size: 10px; color: #606070; flex-shrink: 0; font-weight: 700; letter-spacing: 0.5px; }
.estatus { font-size: 11px; font-weight: 700; flex-shrink: 0; min-width: 26px; }
.estatus.serr  { color: #ff5555; }
.estatus.s5xx  { color: #ff5555; }
.estatus.s4xx  { color: #ffaa33; }
.estatus.sother { color: #55cc88; }
.epath { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: #9988cc; }

.count { font-size: 10px; color: #505060; flex-shrink: 0; }
.etime { font-size: 10px; color: #454555; flex-shrink: 0; }

.entry-btn {
  opacity: 0;
  padding: 2px 5px;
  line-height: 0;
  background: transparent;
  border-color: transparent;
  color: #505060;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  transition: opacity 0.1s, color 0.1s;
  pointer-events: none;
}
.entry:hover .entry-btn { opacity: 1; pointer-events: auto; }
.entry:hover .ignore-btn:hover { color: #ff5555; background: rgba(255,85,85,0.1); border-color: rgba(255,85,85,0.2); }
.entry:hover .watch-btn:hover  { color: #ffaa33; background: rgba(255,170,51,0.1); border-color: rgba(255,170,51,0.2); }
.watch-btn.watching { opacity: 1; color: #ffaa33; pointer-events: auto; }

.empty {
  padding: 18px;
  text-align: center;
  color: #404050;
  font-size: 11px;
}

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483647;
  pointer-events: auto;
}
.modal {
  background: #0d0d11;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  width: 680px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,0.8);
  overflow: hidden;
  color: #d0d0d8;
}
.modal-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
  background: rgba(255,255,255,0.03);
}
.modal-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #606070;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sicon-logo { width: 14px; height: 14px; flex-shrink: 0; display: block; }
.modal-body {
  overflow-y: auto;
  flex: 1;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.15) transparent;
}
.modal-body::-webkit-scrollbar { width: 4px; }
.modal-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
.msec-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #505060;
  margin-bottom: 4px;
}
.msec-body {
  margin: 0;
  font-size: 11px;
  color: #c0c0d0;
  background: rgba(0,0,0,0.3);
  border-radius: 4px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
  font-family: inherit;
}
.msec-body::-webkit-scrollbar { width: 3px; }
.msec-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

/* ── Toast ── */
@keyframes toast-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.sentinel-toast {
  position: fixed;
  bottom: 80px; right: 16px;
  z-index: 2147483647;
  width: 340px; max-width: calc(100vw - 32px);
  background: rgba(13,13,17,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  overflow: hidden;
  pointer-events: auto;
  animation: toast-in 0.2s ease;
}
.sentinel-toast.err  { border-left: 3px solid #ff5555; }
.sentinel-toast.warn { border-left: 3px solid #ffaa33; }
.sentinel-toast.net  { border-left: 3px solid #aa66ff; }
.sentinel-toast.rej  { border-left: 3px solid #ff9999; }
.toast-body { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.toast-icon { font-size: 11px; flex-shrink: 0; }
.sentinel-toast.err  .toast-icon { color: #ff5555; }
.sentinel-toast.warn .toast-icon { color: #ffaa33; }
.sentinel-toast.net  .toast-icon { color: #aa66ff; }
.sentinel-toast.rej  .toast-icon { color: #ff9999; }
.toast-msg { flex: 1; font-size: 11px; color: #d0d0d8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast-actions { display: flex; gap: 4px; flex-shrink: 0; }
.toast-progress { height: 2px; background: rgba(255,255,255,0.08); }
.toast-progress-bar { height: 100%; width: 100%; transition: width 6s linear; }
.sentinel-toast.err  .toast-progress-bar { background: #ff5555; }
.sentinel-toast.warn .toast-progress-bar { background: #ffaa33; }
.sentinel-toast.net  .toast-progress-bar { background: #aa66ff; }
.sentinel-toast.rej  .toast-progress-bar { background: #ff9999; }

/* ── Settings Modal ── */
.smodal { width: 520px; }
.smodal-body { padding: 14px 16px; gap: 14px; }
.ssec-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #505060;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.srow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 12px;
  color: #c0c0d0;
  gap: 12px;
}
.srow > span { flex: 1; }
.srow em { display: block; font-style: normal; font-size: 10px; color: #505060; }
.srow.sdisabled { opacity: 0.4; pointer-events: none; }
.sswitch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}
.sswitch input { opacity: 0; width: 0; height: 0; position: absolute; }
.sslider {
  display: block;
  width: 32px;
  height: 18px;
  background: rgba(255,255,255,0.1);
  border-radius: 9px;
  position: relative;
  transition: background 0.2s;
}
.sslider::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  background: #888;
  border-radius: 50%;
  top: 3px;
  left: 3px;
  transition: transform 0.2s, background 0.2s;
}
.sswitch input:checked + .sslider { background: rgba(170,102,255,0.5); }
.sswitch input:checked + .sslider::before { transform: translateX(14px); background: #aa66ff; }
.sselect {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: #d0d0d8;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  font-family: inherit;
  flex-shrink: 0;
}
.sselect:focus { border-color: rgba(170,102,255,0.5); }
.srule-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.srule-row:last-child { border-bottom: none; }
.srule-icon { font-size: 10px; flex-shrink: 0; width: 14px; text-align: center; }
.srule-icon.net   { color: #aa66ff; }
.srule-icon.cons  { color: #ff8080; }
.srule-icon.watch { color: #ffaa33; }
.srule-desc { flex: 1; font-size: 11px; color: #909098; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srule-del { flex-shrink: 0; }
.srules-empty { font-size: 11px; color: #404050; padding: 4px 0; }
.pbtn-icon { padding: 2px 5px; line-height: 0; display: inline-flex; align-items: center; }

/* ── Settings Tabs ── */
.stabs {
  display: flex;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.02);
  flex-shrink: 0;
}
.stab {
  flex: 1;
  padding: 7px 0;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #505060;
  font-size: 11px;
  font-family: inherit;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.stab:hover { color: #9090a0; }
.stab.active { color: #aa66ff; border-bottom-color: #aa66ff; }
`;

  // ── DOM Setup ──────────────────────────────────────────────────────────────

  function buildUI() {
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;

    const root = document.createElement('div');
    root.className = 'root';

    // Badge
    badgeEl = document.createElement('div');
    badgeEl.className = 'badge';
    badgeEl.title = 'Sentinel — click to expand';
    badgeEl.style.display = 'none';
    badgeEl.addEventListener('click', function () {
      isExpanded = true;
      hasUnseen  = false;
      panelEl.style.display = '';
      badgeEl.style.display = 'none';
      renderList();
    });

    // Panel
    panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'pheader';
    header.innerHTML =
      ICON_IMG + '<span class="ptitle">Sentinel</span>' +
      '<button class="pbtn pbtn-icon" id="en-settings" title="Settings">' + GEAR + '</button>' +
      '<button class="pbtn" id="en-clear">Clear</button>' +
      '<button class="pbtn pbtn-close" id="en-close">×</button>';

    listEl = document.createElement('div');
    listEl.className = 'plist';

    header.querySelector('#en-settings').addEventListener('click', function () {
      showSettingsModal();
    });
    header.querySelector('#en-clear').addEventListener('click', function () {
      entries = [];
      renderList();
      renderBadge();
    });
    header.querySelector('#en-close').addEventListener('click', function () {
      isExpanded = false;
      panelEl.style.display = 'none';
      renderBadge();
    });

    // Left-edge resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    panelEl.appendChild(resizeHandle);

    let resizing = false, resizeStartX = 0, resizeStartW = 0;
    resizeHandle.addEventListener('mousedown', function (e) {
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartW = panelEl.offsetWidth;
      resizeHandle.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!resizing) return;
      const delta = resizeStartX - e.clientX;
      const w = Math.min(Math.max(resizeStartW + delta, 300), window.innerWidth - 32);
      panelEl.style.width = w + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!resizing) return;
      resizing = false;
      resizeHandle.classList.remove('dragging');
    });

    listEl.addEventListener('click', function (event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;
      const btn = t.closest('[data-action]');
      if (btn) { handleAction(btn); return; }
      const entryEl = t.closest('.entry[data-id]');
      if (entryEl) {
        const id = parseInt(entryEl.getAttribute('data-id'), 10);
        const e = entries.find(function (x) { return x.id === id; });
        if (e && hasExpandableDetail(e)) showModal(e);
      }
    });

    panelEl.appendChild(header);
    panelEl.appendChild(listEl);
    root.appendChild(badgeEl);
    root.appendChild(panelEl);

    // Modal
    modalEl = document.createElement('div');
    modalEl.className = 'modal-overlay';
    modalEl.style.display = 'none';
    modalEl.innerHTML =
      '<div class="modal">' +
        '<div class="modal-header">' +
          '<span class="modal-title"></span>' +
          '<button class="pbtn" data-action="replay" style="display:none">↗ Log to Console</button>' +
          '<button class="pbtn" data-action="watch-modal">Watch</button>' +
          '<button class="pbtn" data-action="ignore-modal">Ignore</button>' +
          '<button class="pbtn" data-action="copy-modal">Copy All</button>' +
          '<button class="pbtn pbtn-close" data-action="close-modal">×</button>' +
        '</div>' +
        '<div class="modal-body"></div>' +
      '</div>';

    modalBodyEl = modalEl.querySelector('.modal-body');

    modalEl.addEventListener('click', function (event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;
      const btn = t.closest('[data-action]');
      if (btn) { event.stopPropagation(); handleAction(btn); return; }
      if (event.target === modalEl) hideModal();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (settingsModalEl && settingsModalEl.style.display !== 'none') { hideSettingsModal(); return; }
        if (modalEl.style.display !== 'none') hideModal();
      }
    });

    // Settings Modal
    settingsModalEl = document.createElement('div');
    settingsModalEl.className = 'modal-overlay';
    settingsModalEl.style.display = 'none';
    settingsModalEl.innerHTML =
      '<div class="modal smodal">' +
        '<div class="modal-header">' +
          '<span class="modal-title">' + ICON_IMG + 'Settings</span>' +
          '<label class="sswitch" title="Enable / disable Sentinel">' +
            '<input type="checkbox" data-setting="enabled"><span class="sslider"></span>' +
          '</label>' +
          '<button class="pbtn pbtn-close" data-action="close-settings">×</button>' +
        '</div>' +
        '<div class="stabs">' +
          '<button class="stab active" data-tab="settings">Settings</button>' +
          '<button class="stab" data-tab="rules">Rules</button>' +
        '</div>' +
        '<div id="stab-settings" class="stab-panel modal-body smodal-body">' +
          '<div class="ssec">' +
            '<div class="ssec-title">Console</div>' +
            '<div class="srow"><span>Errors <em>console.error, uncaught, rejections</em></span>' +
              '<label class="sswitch"><input type="checkbox" data-setting="showConsoleErrors"><span class="sslider"></span></label></div>' +
            '<div class="srow"><span>Warnings <em>console.warn</em></span>' +
              '<label class="sswitch"><input type="checkbox" data-setting="showConsoleWarns"><span class="sslider"></span></label></div>' +
          '</div>' +
          '<div class="ssec">' +
            '<div class="ssec-title">Network</div>' +
            '<div class="srow"><span>Show failed requests</span>' +
              '<label class="sswitch"><input type="checkbox" data-setting="showNetwork"><span class="sslider"></span></label></div>' +
            '<div class="srow" data-depends="showNetwork"><span>Minimum status</span>' +
              '<select class="sselect" data-setting="networkMinStatus">' +
                '<option value="0">All failures (0, 4xx, 5xx)</option>' +
                '<option value="400">4xx and 5xx only</option>' +
                '<option value="500">5xx only</option>' +
              '</select></div>' +
          '</div>' +
          '<div class="ssec">' +
            '<div class="ssec-title">Behaviour</div>' +
            '<div class="srow"><span>Clear on navigation</span>' +
              '<label class="sswitch"><input type="checkbox" data-setting="clearOnNav"><span class="sslider"></span></label></div>' +
          '</div>' +
          '<div class="ssec">' +
            '<div class="ssec-title">Watch</div>' +
            '<div class="srow"><span>Toast cooldown <em>suppress repeats within window</em></span>' +
              '<select class="sselect" data-setting="watchCooldownSecs">' +
                '<option value="0">Off — always notify</option>' +
                '<option value="15">15 seconds</option>' +
                '<option value="30">30 seconds</option>' +
                '<option value="60">1 minute</option>' +
                '<option value="300">5 minutes</option>' +
              '</select></div>' +
          '</div>' +
        '</div>' +
        '<div id="stab-rules" class="stab-panel modal-body smodal-body" style="display:none">' +
          '<div class="ssec">' +
            '<div class="ssec-title">Ignore Rules</div>' +
            '<div id="smodal-ignore-rules"></div>' +
          '</div>' +
          '<div class="ssec">' +
            '<div class="ssec-title">Watch Rules</div>' +
            '<div id="smodal-watch-rules"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    settingsModalEl.addEventListener('click', function (event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;
      const btn = t.closest('[data-action]');
      if (btn) { event.stopPropagation(); handleAction(btn); return; }
      const tab = t.closest('[data-tab]');
      if (tab) {
        activeSettingsTab = tab.getAttribute('data-tab');
        settingsModalEl.querySelectorAll('.stab').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-tab') === activeSettingsTab);
        });
        settingsModalEl.querySelectorAll('.stab-panel').forEach(function (p) {
          p.style.display = p.id === 'stab-' + activeSettingsTab ? '' : 'none';
        });
        return;
      }
      if (event.target === settingsModalEl) hideSettingsModal();
    });
    settingsModalEl.addEventListener('change', function (event) {
      const input = event.target;
      const key = input.getAttribute('data-setting');
      if (!key) return;
      const value = input.type === 'checkbox' ? input.checked : Number(input.value);
      settings[key] = value;
      try { const patch = {}; patch[key] = value; chrome.storage.sync.set(patch); } catch (_) {}
      if (key === 'showNetwork') {
        const threshRow = settingsModalEl.querySelector('.srow[data-depends="showNetwork"]');
        if (threshRow) threshRow.classList.toggle('sdisabled', !value);
      }
    });

    shadow.appendChild(styleEl);
    shadow.appendChild(root);
    shadow.appendChild(modalEl);
    shadow.appendChild(settingsModalEl);
  }

  function init() {
    host = document.createElement('div');
    host.setAttribute('id', 'sentinel-shadow-host');
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      pointerEvents: 'none'
    });

    (document.documentElement || document.body).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    buildUI();
    domReady = true;
    render();
  }

  function entryClass(e) {
    if (e.kind === 'network') return 'net';
    if (e.level === 'warn')   return 'warn';
    if (e.kind === 'rejection') return 'rej';
    return 'err';
  }

  function entryIcon(e) {
    if (e.kind === 'network') return '⬡';
    if (e.level === 'warn')   return '⚠';
    return '●';
  }

  function entryTooltip(e) {
    if (e.kind === 'uncaught')   return 'Uncaught error';
    if (e.kind === 'rejection')  return 'Unhandled promise rejection';
    if (e.level === 'warn')      return 'Console warning';
    return 'Console error';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
