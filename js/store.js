/* Almacenamiento local tolerante a fallos. Nunca lanza excepciones.
 * Si localStorage no existe o falla (modo privado, cuota, TV sin soporte), usa memoria:
 * el reproductor sigue funcionando, solo que sin persistencia. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var PREFIX = 'sp.';
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
    }
  };
})(window);
