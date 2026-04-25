(function () {
  'use strict';

  const MSG_TYPE    = '__SENTINEL__';
  const REPLAY_TYPE = '__SENTINEL_REPLAY__';
  const STORE_MAX   = 200;

  // ── Replay store ───────────────────────────────────────────────────────────
  // Keeps the original args/Error objects so they can be re-emitted to the
  // real console (with proper clickable source links) when the user asks.

  var _origError = console.error;
  var _origWarn  = console.warn;
  var _store     = new Map();
  var _nextId    = 0;
  var _suppress  = false;

  function storeValue(value) {
    var id = _nextId++;
    _store.set(id, value);
    if (_store.size > STORE_MAX) {
      _store.delete(_store.keys().next().value);
    }
    return id;
  }

  function post(payload) {
    try {
      window.postMessage(Object.assign({ type: MSG_TYPE }, payload), '*');
    } catch (_) {}
  }

  function serialize(args) {
    return args.map(function (a) {
      try {
        if (a instanceof Error) return a.message;
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      } catch (_) {
        return '[unserializable]';
      }
    }).join(' ');
  }

  // ── Console ────────────────────────────────────────────────────────────────

  ['error', 'warn'].forEach(function (level) {
    var original = level === 'error' ? _origError : _origWarn;
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { original.apply(console, args); } catch (_) {}
      if (_suppress) return;
      var storeId = storeValue(args);
      post({
        kind: 'console',
        level: level,
        message: serialize(args),
        stack: new Error().stack || null,
        storeId: storeId,
        timestamp: Date.now()
      });
    };
  });

  // ── Uncaught errors ────────────────────────────────────────────────────────

  window.addEventListener('error', function (event) {
    if (_suppress) return;
    var storeId = storeValue(event.error ? [event.error] : [event.message || 'Unknown error']);
    post({
      kind: 'uncaught',
      level: 'error',
      message: event.message || 'Unknown error',
      filename: event.filename || null,
      lineno: event.lineno || null,
      stack: event.error ? event.error.stack : null,
      storeId: storeId,
      timestamp: Date.now()
    });
  }, true);

  // ── Unhandled promise rejections ───────────────────────────────────────────

  window.addEventListener('unhandledrejection', function (event) {
    if (_suppress) return;
    var reason = event.reason;
    var storeId = storeValue(reason != null ? [reason] : ['Unhandled rejection']);
    post({
      kind: 'rejection',
      level: 'error',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : null,
      storeId: storeId,
      timestamp: Date.now()
    });
  }, true);

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._en_method = String(method).toUpperCase();
    this._en_url = String(url);
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener('loadend', function () {
      if (xhr.status === 0 || xhr.status >= 400) {
        post({
          kind: 'network',
          method: xhr._en_method || 'GET',
          url: xhr._en_url || '',
          status: xhr.status,
          statusText: xhr.status === 0 ? 'Network Error' : (xhr.statusText || ''),
          timestamp: Date.now()
        });
      }
    });
    return _send.apply(this, arguments);
  };

  // ── Fetch ──────────────────────────────────────────────────────────────────

  if (typeof window.fetch === 'function') {
    var _fetch = window.fetch;

    window.fetch = function (input, init) {
      var url, method;
      try {
        url = typeof input === 'string' ? input
          : (input instanceof URL) ? input.href
          : (input && input.url) ? input.url : String(input);
        method = (init && init.method)
          || (input && typeof input === 'object' && input.method)
          || 'GET';
        method = String(method).toUpperCase();
      } catch (_) {
        url = '';
        method = 'GET';
      }

      return _fetch.apply(this, arguments).then(
        function (response) {
          if (!response.ok) {
            post({
              kind: 'network',
              method: method,
              url: url,
              status: response.status,
              statusText: response.statusText || '',
              timestamp: Date.now()
            });
          }
          return response;
        },
        function (err) {
          post({
            kind: 'network',
            method: method,
            url: url,
            status: 0,
            statusText: err ? err.message : 'Network Error',
            timestamp: Date.now()
          });
          throw err;
        }
      );
    };
  }

  // ── Replay listener ────────────────────────────────────────────────────────
  // overlay.js sends this message when the user clicks "Log to Console".
  // We replay the original args through the real console method so DevTools
  // shows a proper, clickable stack entry.

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== REPLAY_TYPE) return;
    var args = _store.get(event.data.storeId);
    if (!args) return;
    _suppress = true;
    try {
      _origError.apply(console, args);
    } finally {
      _suppress = false;
    }
  });

})();
