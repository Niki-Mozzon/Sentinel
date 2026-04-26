(function () {
  'use strict';

  const MSG_TYPE    = '__SENTINEL__';
  const REPLAY_TYPE = '__SENTINEL_REPLAY__';
  const DEDUP_MS    = 500;

  const ICON16 = chrome.runtime.getURL('icons/icon16.png');
  const ICON_IMG = '<img class="sicon-logo" src="' + ICON16 + '" alt="">';

  const DEFAULTS = {
    enabled: true,
    showConsoleErrors: true,
    showConsoleWarns: false,
    showNetwork: true,
    networkMinStatus: 0,
    clearOnNav: false,
    maxEntries: 100
  };

  // ── State ──────────────────────────────────────────────────────────────────

  let settings    = Object.assign({}, DEFAULTS);
  let ignoreRules = [];
  let entries  = [];
  let nextId   = 0;
  let isExpanded = false;
  let domReady   = false;

  let host    = null;
  let shadow  = null;
  let badgeEl = null;
  let panelEl = null;
  let listEl  = null;
  let modalEl     = null;
  let modalBodyEl = null;
  let currentModalEntry = null;

  // ── Settings ───────────────────────────────────────────────────────────────

  try {
    chrome.storage.sync.get(DEFAULTS, function (result) {
      settings = Object.assign({}, DEFAULTS, result);
      if (domReady) render();
    });
    chrome.storage.sync.get({ ignoreRules: [] }, function (result) {
      ignoreRules = result.ignoreRules || [];
    });
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.ignoreRules) {
        ignoreRules = changes.ignoreRules.newValue || [];
        if (domReady) renderList();
        return;
      }
      Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
      if (domReady) render();
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
    renderList();
    renderBadge();
  }

  function genRuleId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Entry management ───────────────────────────────────────────────────────

  function addEntry(ev) {
    if (!shouldCapture(ev)) return;
    if (matchesIgnoreRule(ev)) return;

    const last = entries[entries.length - 1];
    if (last && last.kind === ev.kind && last.message === ev.message &&
        (ev.timestamp - last.timestamp) < DEDUP_MS) {
      last.count++;
      last.timestamp = ev.timestamp;
      if (domReady) renderList();
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
    if (domReady) render();
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
        '<span class="eicon">⬡</span>' +
        '<span class="emethod">' + escHtml(e.method || 'REQ') + '</span>' +
        '<span class="estatus ' + statusClass(e.status) + '">' + status + '</span>' +
        '<span class="epath">' + path + '</span>';
    } else {
      bodyHtml =
        '<span class="eicon">' + entryIcon(e) + '</span>' +
        '<span class="emsg">' + escHtml(truncate(e.message || '', 90)) + '</span>';
    }

    const ignoreBtn = '<button class="pbtn ignore-btn" data-action="ignore" data-id="' + e.id + '" title="Ignore this error">×</button>';
    return '<div class="entry ' + cls + (hasDetail ? ' expandable' : '') + '" data-id="' + e.id + '">' +
      '<div class="emain">' + chevron + bodyHtml + countHtml + ignoreBtn + '<span class="etime">' + time + '</span></div>' +
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
.bcount { color: #d0d0d8; font-size: 12px; font-weight: 600; }

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

.ignore-btn {
  opacity: 0;
  padding: 0 5px;
  font-size: 13px;
  line-height: 1;
  background: transparent;
  border-color: transparent;
  color: #505060;
  flex-shrink: 0;
  transition: opacity 0.1s, color 0.1s;
  pointer-events: none;
}
.entry:hover .ignore-btn { opacity: 1; pointer-events: auto; }
.entry:hover .ignore-btn:hover { color: #ff5555; background: rgba(255,85,85,0.1); border-color: rgba(255,85,85,0.2); }

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
      '<button class="pbtn" id="en-clear">Clear</button>' +
      '<button class="pbtn pbtn-close" id="en-close">×</button>';

    listEl = document.createElement('div');
    listEl.className = 'plist';

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

    shadow.appendChild(styleEl);
    shadow.appendChild(root);
    shadow.appendChild(modalEl);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
