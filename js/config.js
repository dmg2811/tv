/* Configuración del reproductor: valores por defecto + parámetros de la URL.
 *
 * Parámetros (todos opcionales; los tiempos son en SEGUNDOS):
 *   playlist=URL     manifiesto (por defecto playlist.json junto a index.html)
 *   rotate=0|90|180|270   rotación de pantalla de ESTA tv (gana sobre lo guardado)
 *   mute=0|1         sonido solicitado al arrancar (requiere gesto del usuario)
 *   poll=N           intervalo de consulta del manifiesto (por defecto 60)
 *   loadTimeout=N    tiempo máximo para empezar a reproducir un elemento (20)
 *   stall=N          tiempo sin avance de video antes de considerarlo trabado (10)
 *   retries=N        reintentos por elemento antes de saltarlo (1)
 *   retryDelay=N     espera entre reintentos (1)
 *   hide=N           segundos hasta ocultar los controles (5)
 *   backoff=a,b,c    esperas de recuperación cuando todo falla (10,20,40,60,120,300)
 *   preload=image|none   precarga del siguiente elemento (image)
 *   verify=0|1       comprobar con HEAD los medios nuevos antes de aplicar (1)
 *   debug=1          muestra el HUD de depuración
 *   tv=NOMBRE        etiqueta libre, aparece en el HUD
 */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  function num(q, key, def, min, max) {
    var v = parseFloat(q[key]);
    if (!isFinite(v)) { return def; }
    return util.clamp(v, min, max);
  }

  function list(q, key, def) {
    var parts, out, i, v;
    if (!q[key]) { return def; }
    parts = String(q[key]).split(',');
    out = [];
    for (i = 0; i < parts.length; i++) {
      v = parseFloat(parts[i]);
      if (isFinite(v) && v > 0) { out.push(v); }
    }
    return out.length ? out : def;
  }

  SP.config = {
    defaults: {
      playlistUrl: 'playlist.json',
      pollSec: 60,
      loadTimeoutSec: 20,
      stallSec: 10,
      retries: 1,
      retryDelaySec: 1,
      hideSec: 5,
      backoffSec: [10, 20, 40, 60, 120, 300],
      defaultImageSec: 10,
      preload: 'image',
      verify: true,
      tickMs: 250
    },

    /* `search` es location.search; se puede pasar otro para pruebas. */
    build: function (search) {
      var q = util.parseQuery(search);
      var d = SP.config.defaults;
      var rotate = null;
      if (q.rotate !== undefined && q.rotate !== '') {
        rotate = SP.rotation ? SP.rotation.normalize(q.rotate) : parseInt(q.rotate, 10) || 0;
      }
      return {
        playlistUrl: q.playlist || d.playlistUrl,
        pollSec: isFinite(parseFloat(q.poll)) ? num(q, 'poll', d.pollSec, 0.5, 3600) : null,
        loadTimeoutMs: num(q, 'loadTimeout', d.loadTimeoutSec, 0.5, 300) * 1000,
        stallMs: num(q, 'stall', d.stallSec, 0.5, 300) * 1000,
        retries: Math.floor(num(q, 'retries', d.retries, 0, 5)),
        retryDelayMs: num(q, 'retryDelay', d.retryDelaySec, 0, 60) * 1000,
        hideMs: num(q, 'hide', d.hideSec, 0.5, 120) * 1000,
        backoffMs: (function () {
          var l = list(q, 'backoff', d.backoffSec);
          var out = [];
          var i;
          for (i = 0; i < l.length; i++) { out.push(l[i] * 1000); }
          return out;
        })(),
        defaultImageSec: d.defaultImageSec,
        preload: q.preload === 'none' ? 'none' : d.preload,
        verify: q.verify === '0' ? false : d.verify,
        debug: q.debug === '1',
        tv: q.tv || '',
        rotate: rotate,
        wantSound: q.mute === '0',
        tickMs: d.tickMs
      };
    }
  };
})(window);
