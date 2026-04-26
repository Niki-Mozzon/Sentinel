(function () {
  'use strict';

  const MSG_TYPE    = '__SENTINEL__';
  const REPLAY_TYPE = '__SENTINEL_REPLAY__';
  const DEDUP_MS    = 500;

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

  let settings = Object.assign({}, DEFAULTS);
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
    chrome.storage.onChanged.addListener(function (changes) {
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

  // ── Entry management ───────────────────────────────────────────────────────

  function addEntry(ev) {
    if (!shouldCapture(ev)) return;

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
      if (e.kind === 'network') network++;
      else if (e.level === 'warn') warns++;
      else errors++;
    });
    if (!settings.enabled || entries.length === 0) { badgeEl.style.display = 'none'; return; }
    badgeEl.style.display = '';
    const parts = [];
    if (errors  > 0) parts.push('<span class="be">● ' + errors  + '</span>');
    if (warns   > 0) parts.push('<span class="bw">⚠ ' + warns   + '</span>');
    if (network > 0) parts.push('<span class="bn">⬡ ' + network + '</span>');
    badgeEl.innerHTML = parts.join('');
  }

  function renderList() {
    if (!listEl) return;
    if (entries.length === 0) {
      listEl.innerHTML = '<div class="empty">No errors captured yet</div>';
      return;
    }
    listEl.innerHTML = entries.slice().reverse().map(renderEntry).join('');
  }

  // ── Entry rendering ────────────────────────────────────────────────────────

  function renderEntry(e) {
    const cls        = entryClass(e);
    const icon       = entryIcon(e);
    const label      = entryLabel(e);
    const countHtml  = e.count > 1 ? '<span class="count">×' + e.count + '</span>' : '';
    const time       = formatTime(e.timestamp);
    const hasDetail  = hasExpandableDetail(e);
    const chevron    = hasDetail ? '<span class="chevron">▸</span>' : '';

    return '<div class="entry ' + cls + (hasDetail ? ' expandable' : '') + '" data-id="' + e.id + '">' +
      '<div class="emain">' +
        chevron +
        '<span class="eicon">' + icon + '</span>' +
        '<span class="emsg">' + escHtml(label) + '</span>' +
        countHtml +
        '<span class="etime">' + time + '</span>' +
      '</div>' +
    '</div>';
  }

  function hasExpandableDetail(e) {
    if (e.kind === 'network') return true;
    return !!(e.stack || e.filename || e.message);
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function showModal(e) {
    currentModalEntry = e;
    const titleEl = modalEl.querySelector('.modal-title');
    if (titleEl) titleEl.textContent = modalTitle(e);
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
.be { color: #ff5555; }
.bw { color: #ffaa33; }
.bn { color: #aa66ff; }

/* ── Panel ── */
.panel {
  pointer-events: auto;
  background: rgba(13,13,17,0.95);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 8px;
  width: 460px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: #d0d0d8;
}

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
.entry.net .emsg  { color: #cc99ff; }
.entry.rej .emsg  { color: #ff9999; }

.count { font-size: 10px; color: #505060; flex-shrink: 0; }
.etime { font-size: 10px; color: #454555; flex-shrink: 0; }

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
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #606070;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
      '<span class="ptitle">Sentinel</span>' +
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

    listEl.addEventListener('click', function (event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;
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

  function entryLabel(e) {
    if (e.kind === 'network') {
      const status = e.status === 0 ? 'ERR' : e.status;
      return (e.method || 'REQ') + ' ' + truncate(e.url || '', 55) + ' · ' + status;
    }
    return truncate(e.message || '', 90);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
