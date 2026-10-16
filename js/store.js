/* Almacenamiento local tolerante a fallos. Nunca lanza excepciones.
 * Si localStorage no existe o falla (modo privado, cuota, TV sin soporte), usa memoria:
 * el reproductor sigue funcionando, solo que sin persistencia.
 *
 * Los datos que la TV NO puede olvidar (la orientación en que está instalada) se guardan además en una cookie
 * (setDurable / getDurable): varias Smart TV vacían localStorage al reiniciarse pero conservan las cookies, y al revés. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var PREFIX = 'sp.';
  var COOKIE_PREFIX = 'sp_';
  var COOKIE_DAYS = 3650;
  var memory = {};
  var persistent = false;

  function probe() {
    var key = PREFIX + '__probe';
    try {
      if (!global.localStorage) { return false; }
      global.localStorage.setItem(key, '1');
      var ok = global.localStorage.getItem(key) === '1';
      global.localStorage.removeItem(key);
      return ok;
    } catch (e) {
      return false;
    }
  }

  persistent = probe();

  /* La cookie se limita a la carpeta del reproductor (p. ej. /tv/) para no mezclarse con otros sitios del mismo dominio. */
  function cookiePath() {
    var p = '/';
    try { p = (global.location && global.location.pathname) || '/'; } catch (e) { p = '/'; }
    p = p.replace(/[^\/]*$/, '');
    return p || '/';
  }

  function cookieGet(key) {
    var name = COOKIE_PREFIX + key + '=';
    var parts, i, c;
    try {
      parts = String(global.document.cookie || '').split(';');
      for (i = 0; i < parts.length; i++) {
        c = parts[i].replace(/^\s+/, '');
        if (c.indexOf(name) === 0) { return decodeURIComponent(c.substring(name.length)); }
      }
    } catch (e) { /* cookies bloqueadas */ }
    return null;
  }

  function cookieSet(key, text) {
    var exp = new Date(new Date().getTime() + COOKIE_DAYS * 86400000);
    try {
      global.document.cookie = COOKIE_PREFIX + key + '=' + encodeURIComponent(text) + '; expires=' + exp.toUTCString() + '; path=' + cookiePath() + '; SameSite=Lax';
      return cookieGet(key) === text;
    } catch (e) {
      return false;
    }
  }

  SP.store = {
    /* true si los datos sobreviven a un reinicio de la página. */
    isPersistent: function () { return persistent; },

    get: function (key, fallback) {
      var raw = null;
      if (persistent) {
        try { raw = global.localStorage.getItem(PREFIX + key); } catch (e) { raw = null; }
      } else if (Object.prototype.hasOwnProperty.call(memory, key)) {
        raw = memory[key];
      }
      if (raw === null || raw === undefined) { return fallback; }
      try { return JSON.parse(raw); } catch (e2) { return fallback; }
    },

    set: function (key, value) {
      var raw;
      try { raw = JSON.stringify(value); } catch (e) { return false; }
      if (persistent) {
        try {
          global.localStorage.setItem(PREFIX + key, raw);
          return true;
        } catch (e2) {
          persistent = false; /* cuota agotada o bloqueado: degradar a memoria */
        }
      }
      memory[key] = raw;
      return false;
    },

    remove: function (key) {
      delete memory[key];
      if (persistent) {
        try { global.localStorage.removeItem(PREFIX + key); } catch (e) { /* nada */ }
      }
      try { global.document.cookie = COOKIE_PREFIX + key + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + cookiePath(); } catch (e3) { /* nada */ }
    },

    /* Guarda en localStorage Y en una cookie (solo valores simples). Devuelve true si al menos uno quedó guardado de forma duradera. */
    setDurable: function (key, value) {
      var okLocal = this.set(key, value);
      var okCookie = cookieSet(key, JSON.stringify(value));
      return okLocal || okCookie;
    },

    /* Lee localStorage; si no está (la TV lo vació), la cookie, y entonces lo vuelve a escribir. Si solo está en
     * localStorage, repone la cookie. Nunca lanza. */
    getDurable: function (key, fallback) {
      var missing = {};
      var v = this.get(key, missing);
      var c;
      if (v !== missing) {
        if (cookieGet(key) === null) { cookieSet(key, JSON.stringify(v)); }
        return v;
      }
      c = cookieGet(key);
      if (c === null) { return fallback; }
      try { v = JSON.parse(c); } catch (e) { return fallback; }
      this.set(key, v);
      return v;
    }
  };
})(window);
