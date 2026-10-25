/*! lan-sync-bridge — enlace REAL PC <-> celular para el canal 'abarrotes_lan_sync'.
 *
 * Las pantallas usan BroadcastChannel('abarrotes_lan_sync'), que solo comunica pestañas del mismo
 * navegador en el mismo aparato. Este archivo lo reemplaza, sin tocar los componentes, por un
 * WebSocket contra el servidor local (local-server/), de modo que el celular y la PC se hablen por
 * la red del negocio. Si el servidor no está (por ejemplo con `ng serve`), todo sigue funcionando
 * como antes con BroadcastChannel nativo.
 *
 * Estados (LanSync.status): idle | unavailable | connecting | open | closed | unauthorized
 * API: LanSync.on('status'|'peers', fn) · .off · .connect() · .disconnect() · .snapshot()
 *      eventos de ventana: 'lansync:status' y 'lansync:peers' (detail = snapshot)
 */
(function (global) {
  'use strict';
  if (global.__lanSyncInstalled) return;
  global.__lanSyncInstalled = true;

  var CHANNEL = 'abarrotes_lan_sync';
  var TOKEN_KEY = 'lansync_token';
  var NativeBC = global.BroadcastChannel;
  var loc = global.location || {};
  var isPhone = /movil/i.test(loc.pathname || '');
  var role = isPhone ? 'phone' : 'pc';

  var state = { status: 'idle', pc: false, phones: 0, id: null };
  var listeners = { status: [], peers: [] };
  var channels = [];
  var ws = null, retry = 0, retryTimer = null, hbTimer = null, lastRx = 0, stopped = false, token = null, probing = false;

  function snapshot() {
    return { status: state.status, role: role, pc: state.pc, phones: state.phones, id: state.id, connected: state.status === 'open' };
  }
  function emit(type) {
    var snap = snapshot();
    (listeners[type] || []).slice().forEach(function (f) { try { f(snap); } catch (e) {} });
    try {
      if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('lansync:' + type, { detail: snap }));
      }
    } catch (e) {}
  }
  function setStatus(s) {
    if (state.status === s) return;
    state.status = s;
    emit('status');
  }

  function readToken() {
    var t = null;
    var m = /[?&]t=([^&#]+)/.exec(loc.search || '');
    try {
      if (m) {
        t = decodeURIComponent(m[1]);
        try { global.localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
        try { global.history.replaceState(null, '', (loc.pathname || '/') + (loc.hash || '')); } catch (e) {} // quita el código de la barra
      } else {
        try { t = global.localStorage.getItem(TOKEN_KEY); } catch (e) {}
      }
    } catch (e) {}
    return t;
  }

  function wsUrl() {
    return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + '/ws' + (isPhone ? '?role=phone' : '');
  }
  function isOpen() { return state.status === 'open' && ws && ws.readyState === 1; }
  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function deliver(name, data) {
    channels.slice().forEach(function (ch) { if (ch.name === name) ch._deliver(data); });
  }

  function onServer(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { state.id = m.id; retry = 0; setStatus('open'); }
    else if (m.t === 'presence') { state.pc = !!m.pc; state.phones = m.phones | 0; emit('peers'); }
    else if (m.t === 'msg') { deliver(m.ch, m.data); }
    else if (m.t === 'error' && global.console) { global.console.warn('[LanSync] servidor:', m.reason); }
  }

  function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
  function startHeartbeat() {
    stopHeartbeat();
    var ticks = 0;
    hbTimer = setInterval(function () {
      ticks++;
      if (Date.now() - lastRx > 50000) { try { ws.close(); } catch (e) {} return; }
      if (ticks % 2 === 0) { try { send({ t: 'ping' }); } catch (e) {} }
    }, 10000);
    if (hbTimer && typeof hbTimer.unref === 'function') {
      try { hbTimer.unref(); } catch (e) {}
    }
  }
  function scheduleRetry() {
    if (stopped || retryTimer) return;
    var delay = Math.min(15000, 1000 * Math.pow(2, retry++)) + Math.floor(Math.random() * 400);
    retryTimer = setTimeout(function () { retryTimer = null; open(); }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') {
      try { retryTimer.unref(); } catch (e) {}
    }
  }

  function open() {
    if (stopped || ws || typeof global.WebSocket === 'undefined' || !loc.host) return;
    setStatus('connecting');
    var sock;
    try { sock = new global.WebSocket(wsUrl()); } catch (e) { setStatus('closed'); scheduleRetry(); return; }
    ws = sock;
    sock.onopen = function () {
      lastRx = Date.now();
      if (token) { try { send({ t: 'auth', token: token }); } catch (e) {} }
      startHeartbeat();
    };
    sock.onmessage = function (ev) {
      lastRx = Date.now();
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onServer(m);
    };
    sock.onclose = function (ev) {
      if (ws !== sock) return;
      ws = null; stopHeartbeat();
      var had = state.pc || state.phones;
      state.pc = false; state.phones = 0; state.id = null;
      if (ev && ev.code === 4401) { setStatus('unauthorized'); if (had) emit('peers'); return; }
      setStatus('closed');
      if (had) emit('peers');
      scheduleRetry();
    };
    sock.onerror = function () {};
  }

  // Solo intenta el WebSocket si en este mismo sitio hay un servidor de la tienda.
  function start() {
    if (stopped || ws || probing || !loc.host) return;
    token = readToken();
    if (typeof global.fetch !== 'function') { open(); return; }
    probing = true;
    global.fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { probing = false; if (j && j.ok) open(); else setStatus('unavailable'); })
      .catch(function () { probing = false; setStatus('unavailable'); });
  }

  // ------------------------- Canal compatible con BroadcastChannel -------------------------
  function LanChannel(name) {
    var self = this;
    this.name = String(name);
    this.onmessage = null;
    this.onmessageerror = null;
    this._listeners = [];
    this._closed = false;
    this._native = null;
    if (NativeBC) {
      try {
        this._native = new NativeBC(this.name);
        this._native.onmessage = function (ev) { if (!isOpen()) self._deliver(ev.data); };
      } catch (e) {}
    }
    channels.push(this);
  }
  LanChannel.prototype.postMessage = function (data) {
    if (this._closed) throw new Error('InvalidStateError: el canal está cerrado');
    if (isOpen()) {
      try { if (send({ t: 'msg', ch: this.name, data: data })) return; } catch (e) {}
    }
    if (this._native) this._native.postMessage(data);
  };
  LanChannel.prototype._deliver = function (data) {
    var ev = typeof global.MessageEvent === 'function' ? new global.MessageEvent('message', { data: data }) : { type: 'message', data: data };
    if (typeof this.onmessage === 'function') { try { this.onmessage(ev); } catch (e) { if (global.console) global.console.error(e); } }
    this._listeners.slice().forEach(function (f) { try { f(ev); } catch (e) { if (global.console) global.console.error(e); } });
  };
  LanChannel.prototype.addEventListener = function (type, fn) { if (type === 'message' && typeof fn === 'function') this._listeners.push(fn); };
  LanChannel.prototype.removeEventListener = function (type, fn) { this._listeners = this._listeners.filter(function (f) { return f !== fn; }); };
  LanChannel.prototype.close = function () {
    this._closed = true;
    channels = channels.filter(function (c) { return c !== this; }, this);
    if (this._native) { try { this._native.close(); } catch (e) {} }
  };

  function BroadcastChannelShim(name) {
    if (String(name) !== CHANNEL) {
      if (!NativeBC) throw new Error('BroadcastChannel no está disponible en este navegador');
      return new NativeBC(name);
    }
    return new LanChannel(name);
  }
  BroadcastChannelShim.prototype = LanChannel.prototype;
  global.BroadcastChannel = BroadcastChannelShim;

  // ------------------------- Subida de Evidencia Fotográfica -------------------------
  function detectContentType(data) {
    var bytes = null;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      bytes = data;
    } else if (data instanceof Uint8Array) {
      bytes = data;
    }
    if (bytes && bytes.length >= 4) {
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
      if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    }
    return 'image/jpeg';
  }

  function processImageForUpload(file) {
    if (typeof global.document === 'undefined' || !global.document.createElement) {
      return Promise.resolve({
        body: file,
        contentType: detectContentType(file)
      });
    }

    var maxSide = 1200;

    function renderToCanvas(source, w, h) {
      if (w > maxSide || h > maxSide) {
        if (w >= h) {
          h = Math.round(h * (maxSide / w));
          w = maxSide;
        } else {
          w = Math.round(w * (maxSide / h));
          h = maxSide;
        }
      }
      var canvas = global.document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve({ body: blob, contentType: 'image/jpeg' });
          else reject(new Error('Fallo al comprimir imagen en canvas'));
        }, 'image/jpeg', 0.8);
      });
    }

    if (typeof global.createImageBitmap === 'function') {
      return global.createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(function (bmp) {
          return renderToCanvas(bmp, bmp.width, bmp.height).then(function (res) {
            if (typeof bmp.close === 'function') bmp.close();
            return res;
          });
        })
        .catch(function () {
          return fallbackWithImageTag(file);
        });
    }

    return fallbackWithImageTag(file);

    function fallbackWithImageTag(f) {
      return new Promise(function (resolve, reject) {
        if (typeof global.Image === 'undefined' || typeof global.URL === 'undefined' || !global.URL.createObjectURL) {
          return resolve({ body: f, contentType: 'image/jpeg' });
        }
        var img = new global.Image();
        var url = global.URL.createObjectURL(f);
        img.onload = function () {
          global.URL.revokeObjectURL(url);
          renderToCanvas(img, img.width || img.naturalWidth || maxSide, img.height || img.naturalHeight || maxSide)
            .then(resolve)
            .catch(reject);
        };
        img.onerror = function () {
          global.URL.revokeObjectURL(url);
          reject(new Error('Error al cargar la imagen para compresión'));
        };
        img.src = url;
      });
    }
  }

  function uploadEvidence(file) {
    if (state.status === 'unavailable') {
      return Promise.reject(new Error('Servidor local no disponible (modo sin servidor)'));
    }

    return processImageForUpload(file).then(function (processed) {
      var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
      var timeoutId = null;
      if (controller) {
        timeoutId = global.setTimeout(function () {
          controller.abort();
        }, 20000);
      }

      var headers = {
        'Content-Type': processed.contentType || 'image/jpeg'
      };
      if (token) {
        headers['X-Lansync-Token'] = token;
      }

      var uploadUrl = (loc.protocol === 'https:' ? 'https:' : 'http:') + '//' + loc.host + '/api/evidencia';

      return global.fetch(uploadUrl, {
        method: 'POST',
        headers: headers,
        body: processed.body,
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          if (timeoutId) global.clearTimeout(timeoutId);
          if (!res.ok) {
            return res.text().then(function (txt) {
              throw new Error('Error al subir evidencia (' + res.status + '): ' + txt);
            });
          }
          return res.json();
        })
        .catch(function (err) {
          if (timeoutId) global.clearTimeout(timeoutId);
          if (err && err.name === 'AbortError') {
            throw new Error('Tiempo de espera agotado al subir la evidencia (20 s)');
          }
          throw err;
        });
    });
  }

  // ------------------------- API pública -------------------------
  global.LanSync = {
    role: role,
    get status() { return state.status; },
    get connected() { return state.status === 'open'; },
    get pc() { return state.pc; },
    get phones() { return state.phones; },
    snapshot: snapshot,
    uploadEvidence: uploadEvidence,
    on: function (type, fn) { if (listeners[type] && typeof fn === 'function') listeners[type].push(fn); },
    off: function (type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter(function (f) { return f !== fn; }); },
    connect: function () { stopped = false; retry = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } if (!ws) { state.status === 'open' || setStatus('idle'); start(); } },
    disconnect: function () { stopped = true; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } if (ws) { try { ws.close(); } catch (e) {} } }
  };

  // Al volver a usar el celular (pantalla encendida, Wi-Fi recuperado) se reconecta de inmediato.
  function wake() {
    if (stopped || ws || state.status === 'unavailable' || state.status === 'unauthorized' || state.status === 'idle') return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retry = 0; open();
  }
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', wake);
    global.addEventListener('pageshow', wake);
  }
  if (global.document && typeof global.document.addEventListener === 'function') {
    global.document.addEventListener('visibilitychange', function () { if (global.document.visibilityState === 'visible') wake(); });
  }

  // Indicador de depuración: añade ?lanDebug=1 a la dirección.
  if (/[?&]lanDebug=1/.test(loc.search || '') && global.document) {
    var pill = null;
    var paint = function (s) {
      if (!pill) {
        pill = global.document.createElement('div');
        pill.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:6px 10px;border-radius:999px;font:12px/1.2 system-ui;background:#0f172a;color:#fff;opacity:.9';
        (global.document.body || global.document.documentElement).appendChild(pill);
      }
      pill.textContent = 'LAN ' + s.status + ' · PC:' + (s.pc ? 'sí' : 'no') + ' · celulares:' + s.phones;
    };
    LanSync.on('status', paint); LanSync.on('peers', paint);
    global.setTimeout(function () { paint(snapshot()); }, 0);
  }

  start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
