(function () {
  'use strict';

  const MSG_TYPE    = '__SENTINEL__';
  const REPLAY_TYPE = '__SENTINEL_REPLAY__';
  const STORE_MAX   = 200;
  const BODY_MAX    = 50000;

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

  function parseRawHeaders(raw) {
    if (!raw) return null;
    var result = {};
    raw.trim().split('\r\n').forEach(function (line) {
      var idx = line.indexOf(':');
      if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return Object.keys(result).length ? result : null;
  }

  function headersToObj(headers) {
    if (!headers) return null;
    var result = {};
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach(function (v, k) { result[k] = v; });
      } else if (typeof headers === 'object') {
        Object.assign(result, headers);
      }
    } catch (_) {}
    return Object.keys(result).length ? result : null;
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

  var _xhrOpen   = XMLHttpRequest.prototype.open;
  var _xhrSend   = XMLHttpRequest.prototype.send;
  var _xhrSetHdr = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._en_method     = String(method).toUpperCase();
    this._en_url        = String(url);
    this._en_reqHeaders = {};
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this._en_reqHeaders) this._en_reqHeaders = {};
    this._en_reqHeaders[String(name)] = String(value);
    return _xhrSetHdr.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    xhr._en_stack = new Error().stack || null;
    try {
      if (body != null && body !== '') {
        xhr._en_reqBody = typeof body === 'string' ? body.slice(0, BODY_MAX) : '[non-text body]';
      } else {
        xhr._en_reqBody = null;
      }
    } catch (_) { xhr._en_reqBody = null; }

    xhr.addEventListener('loadend', function () {
      if (xhr.status === 0 || xhr.status >= 400) {
        var resBody = null;
        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            resBody = xhr.responseText ? xhr.responseText.slice(0, BODY_MAX) : null;
          }
        } catch (_) {}

        post({
          kind:       'network',
          method:     xhr._en_method     || 'GET',
          url:        xhr._en_url        || '',
          status:     xhr.status,
          statusText: xhr.status === 0 ? 'Network Error' : (xhr.statusText || ''),
          reqHeaders: xhr._en_reqHeaders && Object.keys(xhr._en_reqHeaders).length ? xhr._en_reqHeaders : null,
          reqBody:    xhr._en_reqBody    || null,
          resHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
          resBody:    resBody,
          stack:      xhr._en_stack      || null,
          timestamp:  Date.now()
        });
      }
    });
    return _xhrSend.apply(this, arguments);
  };

  // ── Fetch ──────────────────────────────────────────────────────────────────

  if (typeof window.fetch === 'function') {
    var _fetch = window.fetch;

    window.fetch = function (input, init) {
      var url, method, reqHeaders, reqBody;
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

      try {
        var rawHdrs = (init && init.headers) || (input && typeof input === 'object' && input.headers);
        reqHeaders = headersToObj(rawHdrs);
      } catch (_) { reqHeaders = null; }

      try {
        var rawBody = (init && init.body) || (input && typeof input === 'object' && input.body);
        reqBody = rawBody != null
          ? (typeof rawBody === 'string' ? rawBody.slice(0, BODY_MAX) : '[non-text body]')
          : null;
      } catch (_) { reqBody = null; }

      var callStack = new Error().stack || null;

      return _fetch.apply(this, arguments).then(
        function (response) {
          if (!response.ok) {
            var resHeaders = headersToObj(response.headers);
            var ts = Date.now();
            response.clone().text().then(function (body) {
              post({
                kind:       'network',
                method:     method,
                url:        url,
                status:     response.status,
                statusText: response.statusText || '',
                reqHeaders: reqHeaders,
                reqBody:    reqBody,
                resHeaders: resHeaders,
                resBody:    body ? body.slice(0, BODY_MAX) : null,
                stack:      callStack,
                timestamp:  ts
              });
            }).catch(function () {
              post({
                kind:       'network',
                method:     method,
                url:        url,
                status:     response.status,
                statusText: response.statusText || '',
                reqHeaders: reqHeaders,
                reqBody:    reqBody,
                resHeaders: resHeaders,
                resBody:    null,
                stack:      callStack,
                timestamp:  ts
              });
            });
          }
          return response;
        },
        function (err) {
          post({
            kind:       'network',
            method:     method,
            url:        url,
            status:     0,
            statusText: err ? err.message : 'Network Error',
            reqHeaders: reqHeaders,
            reqBody:    reqBody,
            resHeaders: null,
            resBody:    null,
            stack:      callStack,
            timestamp:  Date.now()
          });
          throw err;
        }
      );
    };
  }

  // ── Replay listener ────────────────────────────────────────────────────────

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
