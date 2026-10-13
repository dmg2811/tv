/* Consulta periódica del manifiesto (playlist.json).
 *
 *  - Cada consulta usa un parámetro anti-caché: los CDN de hosting estático guardan ~10 min.
 *  - Una versión nueva solo se entrega al motor si pasa la validación y (si es posible) si sus medios
 *    nuevos existen: HEAD 2xx y tamaño coincidente. Si algo falla se conserva la programación actual
 *    y se reintenta en la siguiente consulta.
 *  - La verificación HEAD solo se hace para medios del MISMO origen que el manifiesto (HEAD
 *    cruzado sin CORS fallaría aunque el archivo exista, p. ej. con mediaBase en otro alojamiento). */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  function Updater(engine, cfg, playlistAbs) {
    this.engine = engine;
    this.cfg = cfg;
    this.playlistAbs = playlistAbs;
    this.sinceMs = 0;
    this.inflight = false;
    this.waiters = [];
    this.verified = {};
    this.failures = 0;
    this.lastCheckAt = 0;
    this.lastOkAt = 0;
    this.lastError = '';
    this.lastReject = '';
  }

  Updater.prototype.intervalMs = function () {
    var pl = this.engine.playlist;
    if (!pl) {
      /* sin programación todavía: reintentos rápidos con tope */
      return Math.min(5000 * Math.pow(2, Math.min(this.failures, 4)), this.baseMs());
    }
    return this.baseMs();
  };

  Updater.prototype.baseMs = function () {
    var pl = this.engine.playlist;
    var sec = 60;
    if (this.cfg.pollSec !== null) { sec = this.cfg.pollSec; } else if (pl && pl.pollSec !== null) { sec = pl.pollSec; }
    return sec * 1000;
  };

  Updater.prototype.tick = function (dt) {
    if (this.inflight) { return; }
    this.sinceMs += dt;
    if (this.sinceMs >= this.intervalMs()) { this.check(null); }
  };

  /* cb(ok) se llama al terminar la consulta (también si ya había una en curso). */
  Updater.prototype.check = function (cb) {
    var self = this;
    if (cb) { this.waiters.push(cb); }
    if (this.inflight) { return; }
    this.inflight = true;
    this.sinceMs = 0;
    this.lastCheckAt = util.now();

    function finish(ok) {
      var list = self.waiters;
      var i;
      self.inflight = false;
      self.sinceMs = 0;
      self.waiters = [];
      for (i = 0; i < list.length; i++) {
        try { list[i](ok); } catch (e) { SP.log.error('callback de updater: ' + e); }
      }
    }

    SP.net.getJson(this.playlistAbs, { timeoutMs: 15000 }, function (err, raw) {
      var res, pl;
      if (err) {
        self.noteFailure('descarga del manifiesto: ' + err.message);
        finish(false);
        return;
      }
      res = SP.playlist.normalize(raw, self.playlistAbs, { imageSec: self.cfg.defaultImageSec });
      if (!res.ok) {
        self.noteFailure('manifiesto inválido: ' + res.error);
        finish(false);
        return;
      }
      pl = res.playlist;
      pl.raw = raw;
      self.failures = 0;
      self.lastOkAt = util.now();
      self.lastError = '';
      if (res.warnings.length) { SP.log.warn('manifiesto con avisos: ' + res.warnings.join('; ')); }

      if (SP.playlist.compare(pl, self.engine.playlist) <= 0 ||
          (self.engine.pending && SP.playlist.compare(pl, self.engine.pending) <= 0)) {
        finish(true);
        return;
      }
      /* Una lista SIN elementos nunca reemplaza a una programación que ya está en marcha (el administrador tampoco la publica;
       * esto es la segunda barrera). Con la pantalla ya vacía no hay nada que proteger y se acepta. */
      if (pl.items.length === 0 && (self.engine.items.length > 0 || (self.engine.pending && self.engine.pending.items.length > 0))) {
        self.lastReject = SP.playlist.label(pl) + ': lista vacía (se conserva la programación actual)';
        self.noteFailure('actualización rechazada (' + self.lastReject + ')');
        finish(false);
        return;
      }
      self.verify(pl, function (ok, reason) {
        if (!ok) {
          self.lastReject = SP.playlist.label(pl) + ': ' + reason;
          self.noteFailure('actualización rechazada (' + self.lastReject + ')');
          finish(false);
          return;
        }
        self.lastReject = '';
        self.engine.queueUpdate(pl);
        finish(true);
      });
    });
  };

  Updater.prototype.noteFailure = function (msg) {
    this.failures++;
    this.lastError = msg;
    /* No inundar el registro: primer fallo y luego cada 10. */
    if (this.failures === 1 || this.failures % 10 === 0) { SP.log.warn(msg + ' [x' + this.failures + ']'); }
  };

  /* Comprueba (secuencialmente) los medios nuevos de `pl`. cb(ok, motivo). */
  Updater.prototype.verify = function (pl, cb) {
    var self = this;
    var known = {};
    var todo = [];
    var i, j, it, urls, u;
    var origin = util.originOf(this.playlistAbs);
    var cur = this.engine.items || [];

    /* Sin programación vigente (arranque en frío) no hay nada que proteger: se aplica directamente. */
    if (!this.cfg.verify || !this.engine.playlist) { cb(true); return; }
    for (i = 0; i < cur.length; i++) { known[cur[i].url] = true; }

    for (i = 0; i < pl.items.length; i++) {
      it = pl.items[i];
      urls = [{ url: it.url, size: it.size }];
      if (it.fallback) { urls.push({ url: it.fallback.url, size: null }); }
      for (j = 0; j < urls.length; j++) {
        u = urls[j];
        if (known[u.url] || this.verified[u.url]) { continue; }
        if (util.originOf(u.url) !== origin) { continue; } /* otro origen: no verificable con XHR */
        known[u.url] = true;
        todo.push(u);
      }
    }

    (function step(n) {
      var cur2;
      if (n >= todo.length) { cb(true); return; }
      cur2 = todo[n];
      SP.net.head(cur2.url, 10000, function (err, res) {
        if (err) { cb(false, 'no disponible: ' + cur2.url + ' (' + err.message + ')'); return; }
        if (cur2.size && isFinite(res.contentLength) && res.contentLength !== cur2.size) {
          cb(false, 'tamaño distinto en ' + cur2.url + ' (' + res.contentLength + ' != ' + cur2.size + ')');
          return;
        }
        self.verified[cur2.url] = true;
        step(n + 1);
      });
    })(0);
  };

  Updater.prototype.getState = function () {
    return {
      inflight: this.inflight,
      failures: this.failures,
      lastCheckAt: this.lastCheckAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      lastReject: this.lastReject,
      intervalMs: this.intervalMs()
    };
  };

  SP.Updater = Updater;
})(window);
