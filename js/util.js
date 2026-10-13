/* Utilidades base del reproductor. ES5 estricto: sin let/const/flechas/Promise/fetch. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util = {};
  var hasOwn = Object.prototype.hasOwnProperty;

  util.now = function () {
    return new Date().getTime();
  };

  util.isArray = Array.isArray || function (v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  };

  util.isNumber = function (v) {
    return typeof v === 'number' && isFinite(v);
  };

  util.clamp = function (v, min, max) {
    return v < min ? min : (v > max ? max : v);
  };

  util.bind = function (fn, ctx) {
    return function () {
      return fn.apply(ctx, arguments);
    };
  };

  util.extend = function (target) {
    var i, key, src;
    for (i = 1; i < arguments.length; i++) {
      src = arguments[i];
      if (!src) { continue; }
      for (key in src) {
        if (hasOwn.call(src, key)) { target[key] = src[key]; }
      }
    }
    return target;
  };

  util.indexOf = function (arr, value) {
    var i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] === value) { return i; }
    }
    return -1;
  };

  /* "a=1&b=2" -> { a: "1", b: "2" }. Acepta el "?" inicial. */
  util.parseQuery = function (search) {
    var out = {};
    var str = String(search || '').replace(/^[?#]/, '');
    var parts, i, pair, key, val;
    if (!str) { return out; }
    parts = str.split('&');
    for (i = 0; i < parts.length; i++) {
      if (!parts[i]) { continue; }
      pair = parts[i].split('=');
      try {
        key = decodeURIComponent(pair[0].replace(/\+/g, ' '));
        val = pair.length > 1 ? decodeURIComponent(pair.slice(1).join('=').replace(/\+/g, ' ')) : '';
      } catch (e) {
        continue;
      }
      out[key] = val;
    }
    return out;
  };

  /* Añade o reemplaza un parámetro de query conservando el #hash. */
  util.addQuery = function (url, key, value) {
    var hash = '';
    var hashAt = url.indexOf('#');
    var qAt, base, query, re, pair;
    if (hashAt >= 0) {
      hash = url.slice(hashAt);
      url = url.slice(0, hashAt);
    }
    pair = encodeURIComponent(key) + '=' + encodeURIComponent(value);
    qAt = url.indexOf('?');
    if (qAt < 0) { return url + '?' + pair + hash; }
    base = url.slice(0, qAt);
    query = url.slice(qAt + 1);
    re = new RegExp('(^|&)' + encodeURIComponent(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*');
    if (re.test(query)) {
      query = query.replace(re, '$1' + pair);
    } else {
      query = query ? query + '&' + pair : pair;
    }
    return base + '?' + query + hash;
  };

  /* Origen "esquema://host:puerto" de una URL absoluta; '' si es relativa. */
  util.originOf = function (url) {
    var m = /^([a-z][a-z0-9+.\-]*:)\/\/([^\/?#]*)/i.exec(String(url || ''));
    return m ? (m[1].toLowerCase() + '//' + m[2].toLowerCase()) : '';
  };

  util.isAbsoluteUrl = function (url) {
    return /^([a-z][a-z0-9+.\-]*:)?\/\//i.test(String(url || '')) || /^(data|blob):/i.test(String(url || ''));
  };

  /* Resuelve `rel` contra `base` (URL absoluta) sin usar el constructor URL (no existe en TV antiguas). */
  util.resolveUrl = function (base, rel) {
    var m, scheme, origin, path, dir, segs, out, i, query, hashAt, qAt, tail;
    rel = String(rel == null ? '' : rel);
    base = String(base || '');
    if (/^([a-z][a-z0-9+.\-]*:)\/\//i.test(rel) || /^(data|blob):/i.test(rel)) { return rel; }
    m = /^([a-z][a-z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)/i.exec(base);
    if (!m) { return rel; }
    scheme = m[1];
    origin = scheme + '//' + m[2];
    path = m[3] || '/';
    if (rel.slice(0, 2) === '//') { return scheme + rel; }
    if (rel === '') { return origin + path; }
    if (rel.charAt(0) === '?' || rel.charAt(0) === '#') { return origin + path + rel; }

    hashAt = rel.indexOf('#');
    tail = '';
    if (hashAt >= 0) { tail = rel.slice(hashAt); rel = rel.slice(0, hashAt); }
    qAt = rel.indexOf('?');
    query = '';
    if (qAt >= 0) { query = rel.slice(qAt); rel = rel.slice(0, qAt); }

    if (rel.charAt(0) === '/') {
      dir = rel;
    } else {
      dir = path.slice(0, path.lastIndexOf('/') + 1) + rel;
    }
    segs = dir.split('/');
    out = [];
    for (i = 0; i < segs.length; i++) {
      if (segs[i] === '.') {
        if (i === segs.length - 1) { out.push(''); }
        continue;
      }
      if (segs[i] === '..') {
        if (out.length > 1) { out.pop(); }
        if (i === segs.length - 1) { out.push(''); }
        continue;
      }
      out.push(segs[i]);
    }
    return origin + out.join('/') + query + tail;
  };

  /* --- DOM mínimo (className en vez de classList para máxima compatibilidad) --- */
  util.hasClass = function (el, name) {
    return (' ' + el.className + ' ').indexOf(' ' + name + ' ') >= 0;
  };
  util.addClass = function (el, name) {
    if (!util.hasClass(el, name)) { el.className = (el.className ? el.className + ' ' : '') + name; }
  };
  util.removeClass = function (el, name) {
    el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, '');
  };
  util.setClass = function (el, name, on) {
    if (on) { util.addClass(el, name); } else { util.removeClass(el, name); }
  };
  util.setText = function (el, text) {
    if (!el) { return; }
    if ('textContent' in el) { el.textContent = text; } else { el.innerText = text; }
  };
  util.on = function (el, type, fn) {
    if (el.addEventListener) { el.addEventListener(type, fn, false); } else if (el.attachEvent) { el.attachEvent('on' + type, fn); }
  };
  util.setStyle = function (el, props) {
    var key;
    for (key in props) {
      if (hasOwn.call(props, key)) { el.style[key] = props[key]; }
    }
  };
  /* Aplica transform con y sin prefijo. */
  util.setTransform = function (el, value) {
    el.style.webkitTransform = value;
    el.style.msTransform = value;
    el.style.transform = value;
  };

  util.pad2 = function (n) {
    return n < 10 ? '0' + n : String(n);
  };

  util.formatDuration = function (ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return (h ? h + ':' : '') + util.pad2(m) + ':' + util.pad2(s);
  };
})(window);
