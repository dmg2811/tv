/* Registro circular en memoria (acotado) para depuración y diagnóstico. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var MAX = 120;
  var entries = [];
  var echo = false;

  SP.log = {
    setEcho: function (on) { echo = !!on; },

    add: function (level, msg) {
      var entry = { t: new Date().getTime(), level: level, msg: String(msg) };
      entries.push(entry);
      if (entries.length > MAX) { entries.shift(); }
      if (echo && global.console && global.console.log) {
        global.console.log('[SP:' + level + '] ' + entry.msg);
      }
      return entry;
    },

    info: function (msg) { return SP.log.add('info', msg); },
    warn: function (msg) { return SP.log.add('warn', msg); },
    error: function (msg) { return SP.log.add('error', msg); },

    entries: function () { return entries.slice(0); },

    /* Últimas n entradas ya formateadas (para el HUD). */
    tail: function (n) {
      var out = [];
      var i, e, d;
      for (i = Math.max(0, entries.length - n); i < entries.length; i++) {
        e = entries[i];
        d = new Date(e.t);
        out.push(SP.util.pad2(d.getHours()) + ':' + SP.util.pad2(d.getMinutes()) + ':' + SP.util.pad2(d.getSeconds()) + ' ' + e.level.charAt(0).toUpperCase() + ' ' + e.msg);
      }
      return out;
    },

    count: function (level) {
      var n = 0;
      var i;
      for (i = 0; i < entries.length; i++) {
        if (entries[i].level === level) { n++; }
      }
      return n;
    }
  };
})(window);
