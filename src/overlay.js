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

  let shadow  = null;
  let badgeEl = null;
  let panelEl = null;
  let listEl  = null;

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
      timestamp:  ev.timestamp  || Date.now(),
      count:      1,
      expanded:   false
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
    const cls      = entryClass(e);
    const icon     = entryIcon(e);
    const label    = entryLabel(e);
    const countHtml = e.count > 1 ? '<span class="count">×' + e.count + '</span>' : '';
    const time     = formatTime(e.timestamp);
    const hasDetail = hasExpandableDetail(e);
    const chevron  = hasDetail
      ? '<span class="chevron">' + (e.expanded ? '▾' : '▸') + '</span>'
      : '';

    let detailHtml = '';
    if (e.expanded) {
      detailHtml = '<div class="detail">' + buildDetailHtml(e) + '</div>';
    }

    return '<div class="entry ' + cls + (hasDetail ? ' expandable' : '') +
           (e.expanded ? ' open' : '') + '" data-id="' + e.id + '">' +
      '<div class="emain">' +
        chevron +
        '<span class="eicon">' + icon + '</span>' +
        '<span class="emsg">' + escHtml(label) + '</span>' +
        countHtml +
        '<span class="etime">' + time + '</span>' +
      '</div>' +
      detailHtml +
    '</div>';
  }

  function hasExpandableDetail(e) {
    if (e.kind === 'network') return !!(e.url || e.statusText);
    return !!(e.stack || e.filename);
  }

  function buildDetailHtml(e) {
    if (e.kind === 'network') {
      const fullUrl   = escHtml(e.url || '');
      const statusTxt = e.statusText ? '<div class="dmeta">' + escHtml(e.statusText) + '</div>' : '';
      const copyBtn   = e.url
        ? '<button class="abtn" data-action="copy-url" data-url="' + escAttr(e.url) + '">Copy URL</button>'
        : '';
      return '<div class="durl">' + fullUrl + '</div>' + statusTxt +
             (copyBtn ? '<div class="dactions">' + copyBtn + '</div>' : '');
    }

    // Console / uncaught / rejection
    let stackHtml = '';
    if (e.stack) {
      stackHtml = '<pre class="dstack">' + escHtml(e.stack) + '</pre>';
    } else if (e.filename && e.lineno) {
      stackHtml = '<div class="dmeta">' + escHtml(e.filename) + ':' + e.lineno + '</div>';
    }

    const replayBtn = e.storeId != null
      ? '<button class="abtn" data-action="replay" data-store-id="' + e.storeId + '">↗ Log to Console</button>'
      : '';

    return stackHtml + (replayBtn ? '<div class="dactions">' + replayBtn + '</div>' : '');
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

  // ── Action handling ────────────────────────────────────────────────────────

  function handleAction(btn) {
    const action = btn.getAttribute('data-action');

    if (action === 'replay') {
      const storeId = parseInt(btn.getAttribute('data-store-id'), 10);
      window.postMessage({ type: REPLAY_TYPE, storeId: storeId }, '*');
      feedback(btn, '✓ Logged');
    }

    if (action === 'copy-url') {
      const url = btn.getAttribute('data-url');
      try {
        navigator.clipboard.writeText(url).then(function () {
          feedback(btn, '✓ Copied');
        });
      } catch (_) {
        feedback(btn, '✗ Error');
      }
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
.pbtn:hover { background: rgba(255,255,255,0.12); color: #d0d0d8; }
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
.entry.open { background: rgba(255,255,255,0.025); }

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

/* ── Expanded detail ── */
.detail {
  margin-top: 4px;
  padding: 6px 8px 6px 25px;
  background: rgba(0,0,0,0.2);
  border-radius: 4px;
}

.dstack {
  margin: 0;
  font-size: 10px;
  color: #555568;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
}
.dstack::-webkit-scrollbar { width: 3px; }
.dstack::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.durl {
  font-size: 10px;
  color: #7777aa;
  word-break: break-all;
}
.dmeta {
  margin-top: 2px;
  font-size: 10px;
  color: #505060;
}

.dactions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.abtn {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.10);
  color: #9090a8;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: background 0.1s, color 0.1s;
}
.abtn:hover:not(:disabled) { background: rgba(255,255,255,0.14); color: #d0d0e8; }
.abtn:disabled { opacity: 0.5; cursor: default; }

.empty {
  padding: 18px;
  text-align: center;
  color: #404050;
  font-size: 11px;
}
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

    // Single delegated handler — no re-attachment needed after re-renders
    listEl.addEventListener('click', function (event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return;

      // Action button click (copy URL, replay)
      const btn = t.closest('[data-action]');
      if (btn) {
        event.stopPropagation();
        handleAction(btn);
        return;
      }

      // Entry row click = toggle expand
      const entryEl = t.closest('.entry[data-id]');
      if (entryEl) {
        const id = parseInt(entryEl.getAttribute('data-id'), 10);
        const e = entries.find(function (x) { return x.id === id; });
        if (e && hasExpandableDetail(e)) {
          e.expanded = !e.expanded;
          renderList();
        }
      }
    });

    panelEl.appendChild(header);
    panelEl.appendChild(listEl);
    root.appendChild(badgeEl);
    root.appendChild(panelEl);
    shadow.appendChild(styleEl);
    shadow.appendChild(root);
  }

  function init() {
    const host = document.createElement('div');
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
