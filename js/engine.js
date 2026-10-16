/* Motor de reproducción: lista continua, avance automático, vigilancia y recuperación.
 *
 * Modos (mode):   boot | active | empty | recovering
 * Fases de un elemento (phase):  loading -> playing -> done    (retry: espera entre reintentos)
 *
 * Reglas de estabilidad:
 *  - UN solo reloj maestro (lo llama main.js cada tickMs); este módulo no crea temporizadores.
 *  - Tiempo acumulado con dt acotado: un salto del reloj del sistema no altera las duraciones.
 *  - Un fallo se reintenta `retries` veces; luego se muestra el respaldo (si existe) o se salta.
 *  - Si TODOS los elementos fallan seguidos -> modo recovering con esperas crecientes (backoff).
 *  - Las programaciones nuevas se aplican solo entre elementos, nunca a mitad de uno.
 *  - Un video se reproduce en su versión YA GIRADA (270 o 90) dentro de la caja 16:9 sin giro CSS cuando la pantalla gira 90/270
 *    y el manifiesto la trae; si no la trae, se reproduce el video normal girado con CSS (comportamiento anterior). */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  var VIDEO_EVENTS = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'ended', 'error', 'pause'];

  function Engine(renderer, cfg, hooks) {
    this.renderer = renderer;
    this.cfg = cfg;
    this.hooks = hooks || {};
    this.mode = 'boot';
    this.playlist = null;
    this.items = [];
    this.pending = null;
    this.index = -1;
    this.current = null;
    this.paused = false;
    this.soundWanted = !!SP.store.get('sound', false) || !!cfg.wantSound;
    this.gesture = false;
    this.needsGesture = false;
    this.consecutiveFailures = 0;
    this.backoffIdx = 0;
    this.recoverMs = 0;
    this.recoverDelayMs = 0;
    this.recoverBusy = false;
    this.lastCountdown = -1;
    this.seq = 0;
    this.stats = { started: 0, failed: 0, skipped: 0, retries: 0, stalls: 0, updatesApplied: 0, fallbacks: 0, recoveries: 0 };
  }

  Engine.prototype.init = function () {
    var self = this;
    var v = this.renderer.video;
    var i;
    for (i = 0; i < VIDEO_EVENTS.length; i++) {
      (function (name) {
        util.on(v, name, function () { self.videoEvent(name); });
      })(VIDEO_EVENTS[i]);
    }
  };

  /* ------------------------------------------------------------------ estado */
  Engine.prototype.getState = function () {
    var e = this.current;
    var v = this.renderer.video;
    var state = this.mode;
    if (this.mode === 'active') {
      state = this.paused ? 'paused' : (e && e.phase === 'playing' ? 'playing' : 'loading');
    }
    return {
      mode: this.mode,
      state: state,
      paused: this.paused,
      index: this.index,
      count: this.items.length,
      itemId: e ? e.item.id : null,
      kind: e ? e.kind : null,
      isFallback: !!(e && e.isFallback),
      videoVariant: e && e.kind === 'video' ? e.variant : 0,
      videoInBox: e && e.kind === 'video' ? !!e.box : false,
      videoUrl: e && e.kind === 'video' ? e.url : null,
      phase: e ? e.phase : null,
      attempt: e ? e.attempt : 0,
      elapsedMs: e ? Math.round(e.elapsedMs) : 0,
      durationMs: e && e.kind === 'image' ? e.durationMs : 0,
      videoTime: e && e.kind === 'video' ? v.currentTime : 0,
      version: SP.playlist.label(this.playlist),
      versionNum: this.playlist ? this.playlist.version : null,
      pendingVersion: this.pending ? SP.playlist.label(this.pending) : null,
      consecutiveFailures: this.consecutiveFailures,
      soundOn: this.soundWanted && this.gesture,
      soundWanted: this.soundWanted,
      needsGesture: this.needsGesture,
      recoverInMs: this.mode === 'recovering' ? Math.max(0, this.recoverDelayMs - this.recoverMs) : 0,
      stats: util.extend({}, this.stats)
    };
  };

  Engine.prototype.urlFor = function (entry) {
    /* Solo en reintentos se altera la URL, para saltarse una respuesta mala guardada en caché. */
    return entry.attempt > 0 ? util.addQuery(entry.url, '_r', entry.attempt) : entry.url;
  };

  /* ------------------------------------------------------------- programación */
  Engine.prototype.installPlaylist = function (pl, anchorId) {
    var i;
    this.playlist = pl;
    this.items = pl.items;
    this.index = -1;
    if (anchorId) {
      for (i = 0; i < pl.items.length; i++) {
        if (pl.items[i].id === anchorId) { this.index = i; break; }
      }
    }
    this.stats.updatesApplied++;
    SP.log.info('programación aplicada ' + SP.playlist.label(pl) + ' (' + pl.items.length + ' elementos)');
    if (this.hooks.onApplied) { this.hooks.onApplied(pl); }
    if (pl.playerBuild && this.hooks.reloadForBuild) {
      return !!this.hooks.reloadForBuild(pl.playerBuild);
    }
    return false;
  };

  /* Arranque: instala la programación y reproduce desde el primer elemento. */
  Engine.prototype.begin = function (pl) {
    this.pending = null;
    if (this.installPlaylist(pl, null)) { return; }
    if (!this.items.length) { this.enterEmpty(); } else { this.go(0); }
  };

  /* Programación descargada y validada por el updater. Se aplica entre elementos. */
  Engine.prototype.queueUpdate = function (pl) {
    if (SP.playlist.compare(pl, this.playlist) <= 0) { return false; }
    if (this.pending && SP.playlist.compare(pl, this.pending) <= 0) { return false; }
    if (pl.items.length === 0 && (this.items.length > 0 || (this.pending && this.pending.items.length > 0))) {
      SP.log.warn('lista vacía rechazada ' + SP.playlist.label(pl) + ': se conserva la programación actual');
      return false;
    }
    this.pending = pl;
    SP.log.info('programación en espera ' + SP.playlist.label(pl));
    if (this.mode === 'empty' || this.mode === 'recovering' || this.mode === 'boot') {
      this.begin(this.pending);
    }
    return true;
  };

  /* Aplica la pendiente si existe. Devuelve true si se inició una recarga de página. */
  Engine.prototype.applyPending = function (anchorId) {
    var pl = this.pending;
    var reload;
    if (!pl) { return false; }
    this.pending = null;
    reload = this.installPlaylist(pl, anchorId);
    if (reload) { return true; }
    if (!this.items.length) { this.enterEmpty(); }
    return false;
  };

  /* ---------------------------------------------------------------- navegación */
  Engine.prototype.go = function (index) {
    var n = this.items.length;
    var item;
    this.endCurrent();
    if (!n) { this.enterEmpty(); return; }
    this.mode = 'active';
    this.index = ((index % n) + n) % n;
    item = this.items[this.index];
    this.startEntry(this.entryFor(item));
  };

  /* Qué archivo reproducir de un video según el giro actual de la pantalla.
   *  · giro 90/270 y el manifiesto trae esa versión → el archivo YA GIRADO, en la caja 16:9 sin giro CSS.
   *  · en cualquier otro caso → el video normal (vertical), en el escenario girado con CSS (comportamiento anterior). */
  Engine.prototype.videoPlan = function (item) {
    var rot = this.renderer.rotation;
    var v = item.variants;
    if (SP.rotation.usesPreRotated(rot) && v && v[rot]) { return { url: v[rot].url, box: true, variant: rot }; }
    return { url: item.url, box: false, variant: 0 };
  };

  Engine.prototype.entryFor = function (item) {
    var plan = item.type === 'video' ? this.videoPlan(item) : null;
    return {
      item: item,
      kind: item.type,
      url: plan ? plan.url : item.url,
      box: plan ? plan.box : false,
      variant: plan ? plan.variant : 0,
      durationMs: item.type === 'image' ? item.durationSec * 1000 : 0,
      isFallback: false,
      attempt: 0
    };
  };

  /* El usuario giró la pantalla (GIRAR 180°). Las imágenes solo se redibujan; un video en curso se reinicia en la versión
   * que corresponde al nuevo giro. Devuelve true si se reinició. */
  Engine.prototype.rotationChanged = function () {
    var e = this.current;
    var plan;
    if (this.mode !== 'active' || !e || e.kind !== 'video' || e.isFallback || e.phase === 'done') { return false; }
    plan = this.videoPlan(e.item);
    if (plan.url === e.url && plan.box === e.box) { return false; }
    SP.log.info('giro de pantalla: se reinicia ' + e.item.id + ' con ' + (plan.box ? 'su versión de ' + plan.variant + '°' : 'el video normal'));
    this.renderer.unloadVideo();
    this.startEntry(this.entryFor(e.item));
    return true;
  };

  /* Fin natural de un elemento. */
  Engine.prototype.advance = function () {
    var anchor = this.current ? this.current.item.id : null;
    this.endCurrent();
    if (this.pending && this.applyPending(anchor)) { return; }
    if (this.mode !== 'active') { return; }
    this.go(this.index + 1);
  };

  Engine.prototype.manualMove = function (dir) {
    var anchor;
    if (this.mode !== 'active') { return; }
    anchor = this.current ? this.current.item.id : null;
    this.endCurrent();
    if (this.pending) {
      if (this.applyPending(anchor)) { return; }
      if (this.mode !== 'active') { return; }
      if (this.index === -1 && dir < 0) { this.index = 0; }
    }
    this.go(this.index + dir);
  };

  Engine.prototype.next = function () { this.manualMove(1); };
  Engine.prototype.prev = function () { this.manualMove(-1); };

  Engine.prototype.endCurrent = function () {
    var e = this.current;
    if (!e) { return; }
    e.phase = 'done';
    if (e.kind === 'video') { this.renderer.unloadVideo(); }
    this.current = null;
  };

  /* ---------------------------------------------------------------- elementos */
  Engine.prototype.startEntry = function (entry) {
    var self = this;
    entry.seq = ++this.seq;
    entry.phase = 'loading';
    entry.loadMs = 0;
    entry.retryMs = 0;
    entry.elapsedMs = 0;
    entry.progressMs = 0;
    entry.lastCt = -1;
    entry.stallCount = 0;
    this.current = entry;

    if (entry.kind === 'image') {
      this.renderer.showImage(this.urlFor(entry), function (err) {
        if (self.current !== entry || entry.phase !== 'loading') { return; }
        if (err) { self.entryFailed(entry, 'image-error'); } else { self.entryStarted(entry, false); }
      });
    } else {
      this.renderer.loadVideo(this.urlFor(entry), !(this.soundWanted && this.gesture), !!entry.box);
    }
  };

  Engine.prototype.entryStarted = function (entry, pausedStart) {
    if (this.current !== entry || entry.phase !== 'loading') { return; }
    entry.phase = 'playing';
    entry.elapsedMs = 0;
    entry.progressMs = 0;
    this.consecutiveFailures = 0;
    this.backoffIdx = 0;
    this.stats.started++;
    if (entry.kind === 'video') { this.renderer.showVideo(); }
    this.renderer.message(null);
    this.preloadNext();
    /* pausedStart: video cargado con la reproducción en pausa; se muestra el primer cuadro y
     * play() se llamará al reanudar. */
  };

  Engine.prototype.preloadNext = function () {
    var n = this.items.length;
    var nxt;
    if (this.cfg.preload !== 'image' || n < 2) { this.renderer.releasePreload(); return; }
    nxt = this.items[(this.index + 1) % n];
    if (nxt.type === 'image') { this.renderer.preloadImage(nxt.url); } else { this.renderer.releasePreload(); }
  };

  Engine.prototype.entryFailed = function (entry, reason) {
    if (this.current !== entry || entry.phase === 'done' || entry.phase === 'retry') { return; }
    this.stats.failed++;
    SP.log.warn('fallo en ' + entry.item.id + (entry.isFallback ? ' (respaldo)' : '') + ': ' + reason + ' [intento ' + (entry.attempt + 1) + ']');
    if (entry.attempt < this.cfg.retries && reason !== 'autoplay-blocked') {
      entry.attempt++;
      entry.phase = 'retry';
      entry.retryMs = 0;
      this.stats.retries++;
      if (entry.kind === 'video') { this.renderer.unloadVideo(); }
      return;
    }
    this.giveUp(entry, reason);
  };

  Engine.prototype.giveUp = function (entry, reason) {
    var fb;
    entry.phase = 'done';
    this.consecutiveFailures++;
    if (entry.kind === 'video') { this.renderer.unloadVideo(); }
    if (!entry.isFallback && entry.item.fallback) {
      fb = entry.item.fallback;
      this.stats.fallbacks++;
      SP.log.info('mostrando respaldo de ' + entry.item.id + ' (' + reason + ')');
      this.startEntry({
        item: entry.item,
        kind: 'image',
        url: fb.url,
        durationMs: fb.durationSec * 1000,
        isFallback: true,
        attempt: 0
      });
      return;
    }
    this.stats.skipped++;
    if (this.consecutiveFailures >= Math.max(1, this.items.length)) {
      this.enterRecovery();
      return;
    }
    this.advance();
  };

  /* ------------------------------------------------------------------- vacío */
  Engine.prototype.enterEmpty = function () {
    this.endCurrent();
    this.mode = 'empty';
    this.renderer.clearStage();
    this.renderer.message('Sin contenido para mostrar');
  };

  /* -------------------------------------------------------------- recuperación */
  Engine.prototype.enterRecovery = function () {
    var list = this.cfg.backoffMs;
    this.endCurrent();
    this.mode = 'recovering';
    this.stats.recoveries++;
    this.recoverDelayMs = list[Math.min(this.backoffIdx, list.length - 1)];
    this.backoffIdx++;
    this.recoverMs = 0;
    this.recoverBusy = false;
    this.lastCountdown = -1;
    this.renderer.clearStage();
    this.updateRecoveryMessage();
    SP.log.warn('todos los elementos fallaron: reintento en ' + Math.round(this.recoverDelayMs / 1000) + ' s');
  };

  Engine.prototype.updateRecoveryMessage = function () {
    var left = Math.ceil(Math.max(0, this.recoverDelayMs - this.recoverMs) / 1000);
    if (left === this.lastCountdown) { return; }
    this.lastCountdown = left;
    this.renderer.message('No se pudo reproducir el contenido.\nReintentando en ' + left + ' s…');
  };

  Engine.prototype.attemptRecovery = function () {
    var self = this;
    if (this.recoverBusy) { return; }
    this.recoverBusy = true;
    this.renderer.message('Reintentando…');
    function resume() {
      self.recoverBusy = false;
      if (self.mode !== 'recovering') { return; } /* una programación nueva ya reinició todo */
      self.consecutiveFailures = 0;
      if (!self.items.length) { self.enterEmpty(); } else { self.go(0); }
    }
    if (this.hooks.requestReload) { this.hooks.requestReload(resume); } else { resume(); }
  };

  /* ------------------------------------------------------------------ reloj */
  Engine.prototype.tick = function (dt) {
    var e = this.current;

    if (this.mode === 'recovering') {
      if (!this.recoverBusy) {
        this.recoverMs += dt;
        if (this.recoverMs >= this.recoverDelayMs) { this.attemptRecovery(); } else { this.updateRecoveryMessage(); }
      }
      return;
    }
    if (this.mode !== 'active' || !e) { return; }

    if (e.phase === 'loading') {
      e.loadMs += dt;
      if (e.loadMs >= this.cfg.loadTimeoutMs) { this.entryFailed(e, 'load-timeout'); }
    } else if (e.phase === 'retry') {
      e.retryMs += dt;
      if (e.retryMs >= this.cfg.retryDelayMs) { this.startEntry(e); }
    } else if (e.phase === 'playing' && !this.paused) {
      if (e.kind === 'image') {
        e.elapsedMs += dt;
        if (e.elapsedMs >= e.durationMs) { this.advance(); }
      } else {
        this.watchVideo(e, dt);
      }
    }
  };

  Engine.prototype.watchVideo = function (e, dt) {
    var v = this.renderer.video;
    var ct = v.currentTime;
    var dur = v.duration;
    var finite = typeof dur === 'number' && isFinite(dur) && dur > 0;
    var limit;

    e.elapsedMs += dt;
    if (ct !== e.lastCt) {
      e.lastCt = ct;
      e.progressMs = 0;
    } else {
      e.progressMs += dt;
    }

    /* Algunas TV no disparan "ended": se detecta por posición final + sin avance. */
    if (v.ended || (finite && ct >= dur - 0.15 && e.progressMs > 1500)) {
      this.advance();
      return;
    }
    if (e.progressMs >= this.cfg.stallMs) {
      e.stallCount++;
      this.stats.stalls++;
      if (e.stallCount === 1) {
        e.progressMs = 0;
        SP.log.warn('video sin avance, reintentando play()');
        this.tryPlay(e);
      } else {
        this.entryFailed(e, 'stall');
      }
      return;
    }
    limit = finite ? dur * 2000 + 15000 : 600000;
    if (e.elapsedMs > limit) {
      SP.log.warn('video excedió el tiempo esperado, avanzando');
      this.advance();
    }
  };

  /* ------------------------------------------------------------ eventos de video */
  Engine.prototype.videoEvent = function (name) {
    var e = this.current;
    var v = this.renderer.video;
    if (!e || e.kind !== 'video' || e.phase === 'done' || e.phase === 'retry') { return; }
    if (this.renderer.unloading || !this.renderer.hasVideoSrc()) { return; }

    switch (name) {
      case 'loadeddata':
      case 'canplay':
        if (e.phase === 'loading') {
          if (this.paused) { this.entryStarted(e, true); } else { this.tryPlay(e); }
        }
        break;
      case 'playing':
        if (e.phase === 'loading') { this.entryStarted(e, false); }
        break;
      case 'timeupdate':
        if (e.phase === 'loading' && v.currentTime > 0) { this.entryStarted(e, false); }
        break;
      case 'ended':
        if (e.phase === 'loading') { this.entryStarted(e, false); }
        this.advance();
        break;
      case 'error':
        if (v.error) { this.entryFailed(e, 'media-error-' + v.error.code); }
        break;
      case 'pause':
        /* Pausa que no pedimos (SO de la TV, pérdida de foco): reanudar. */
        if (e.phase === 'playing' && !this.paused && !v.ended && !(isFinite(v.duration) && v.currentTime >= v.duration - 0.2)) {
          this.tryPlay(e);
        }
        break;
      default: break;
    }
  };

  Engine.prototype.tryPlay = function (e) {
    var self = this;
    var p;
    try {
      p = this.renderer.video.play();
    } catch (err) {
      this.onPlayRejected(e, err);
      return;
    }
    if (p && typeof p.then === 'function') {
      p.then(function () { /* éxito: el evento "playing" confirma el inicio */ }, function (err2) {
        self.onPlayRejected(e, err2);
      });
    }
  };

  Engine.prototype.onPlayRejected = function (e, err) {
    var name = err && err.name ? err.name : 'Error';
    var v = this.renderer.video;
    if (this.current !== e || e.phase === 'done' || e.phase === 'retry') { return; }
    if (name === 'AbortError') { return; } /* interrumpido por una carga nueva o una pausa */

    if (name === 'NotAllowedError') {
      if (!v.muted) {
        /* El navegador no aceptó sonido sin interacción: volver a mudo y reintentar. */
        SP.log.warn('sonido bloqueado por el navegador; reproduciendo en mudo');
        this.soundWanted = false;
        v.muted = true;
        this.renderer.hint('El navegador bloqueó el sonido');
        this.tryPlay(e);
        return;
      }
      this.needsGesture = true;
      this.renderer.hint('Presione OK para activar el video');
      this.entryFailed(e, 'autoplay-blocked');
      return;
    }
    this.entryFailed(e, 'play-' + name);
  };

  /* ------------------------------------------------------------ pausa y sonido */
  Engine.prototype.pause = function () {
    var e = this.current;
    if (this.paused) { return; }
    this.paused = true;
    if (e && e.kind === 'video' && e.phase === 'playing') {
      try { this.renderer.video.pause(); } catch (err) { /* nada */ }
    }
  };

  Engine.prototype.resume = function () {
    var e = this.current;
    if (!this.paused) { return; }
    this.paused = false;
    if (e && e.kind === 'video' && e.phase === 'playing') {
      e.progressMs = 0;
      this.tryPlay(e);
    }
  };

  Engine.prototype.togglePause = function () {
    if (this.paused) { this.resume(); } else { this.pause(); }
  };

  Engine.prototype.applyMute = function () {
    var want = !(this.soundWanted && this.gesture);
    var v = this.renderer.video;
    if (v.muted !== want) { v.muted = want; }
    v.defaultMuted = want;
  };

  Engine.prototype.toggleSound = function () {
    this.gesture = true;
    this.soundWanted = !this.soundWanted;
    SP.store.set('sound', this.soundWanted);
    this.renderer.hint(null);
    this.applyMute();
  };

  /* Cualquier tecla/clic/toque: desbloquea autoplay y aplica el sonido guardado. */
  Engine.prototype.onUserGesture = function () {
    var first = !this.gesture;
    this.gesture = true;
    if (first && this.soundWanted) { this.applyMute(); }
    if (this.needsGesture) {
      this.needsGesture = false;
      this.renderer.hint(null);
      /* si todo estaba fallando por autoplay, no esperar el siguiente reintento */
      if (this.mode === 'recovering') { this.recoverMs = this.recoverDelayMs; }
    }
  };

  /* La página volvió a primer plano (o recuperó el foco): reanudar el video que el SO pudo haber pausado o cuyo
   * play() se abortó mientras la página estaba oculta (AbortError; "loadeddata" ya no se repetirá). */
  Engine.prototype.ensurePlaying = function () {
    var e = this.current;
    var v = this.renderer.video;
    if (!e || e.kind !== 'video' || this.paused) { return; }
    if (e.phase === 'playing' && v.paused) {
      this.tryPlay(e);
    } else if (e.phase === 'loading' && v.readyState >= 2) {
      this.tryPlay(e);
    }
  };

  SP.Engine = Engine;
})(window);
