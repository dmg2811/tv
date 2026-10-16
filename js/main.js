/* Arranque del reproductor: une los módulos y mantiene el ÚNICO reloj maestro. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  function absoluteUrl(url) {
    var a = global.document.createElement('a');
    a.href = url;
    return a.href;
  }

  function start() {
    var cfg = SP.config.build(global.location.search);
    var renderer = new SP.Renderer();
    /* La orientación de esta TV se recuerda en localStorage y, por si la TV lo vacía, también en una cookie. */
    var storedRot = SP.store.getDurable('rotation', null);
    var rotationLocked = cfg.rotate !== null || storedRot !== null;
    var rotationSource = cfg.rotate !== null ? 'url' : (storedRot !== null ? 'guardada' : 'automática');
    var playlistAbs = absoluteUrl(cfg.playlistUrl);
    var vpStart, inherited = null;
    var engine, controls, updater, hudOn, lastHudAt = 0, lastLayoutAt = 0, bootMsgShown = false, bootedAt = util.now();
    var hooks, last, saved, res;

    SP.log.setEcho(cfg.debug);
    renderer.viewportOverride = cfg.viewport;
    renderer.uiRotate = cfg.uiRotate;
    /* PRIMERA ejecución de este reproductor en esta TV: si no había ninguna preferencia guardada pero hay PRUEBA de que el reproductor anterior la mostraba
     * con su ángulo automático de 90° (ver SP.rotation.inheritedAngle: dato guardado, o actualización automática desde el reproductor anterior en marcha),
     * se conserva ese 90° y se guarda: la TV no cambia de orientación sin que nadie lo haya pedido. La decisión se toma UNA sola vez (marca 'orientationChecked'), antes de que este reproductor escriba nada en 'lastPlaylist':
     * si no, lo que él mismo guarde (p. ej. un manifiesto que aún anuncie el build anterior) pasaría por «prueba». Con ?rotate= en la URL no se asigna nada. */
    if (!SP.store.get('orientationChecked', false)) {
      SP.store.set('orientationChecked', true);
      if (storedRot === null && cfg.rotate === null) {
        vpStart = renderer.viewportSize();
        inherited = SP.rotation.inheritedAngle(vpStart.w, vpStart.h, SP.store.get('lastPlaylist', null), global.SP_BUILD || '', util.parseQuery(global.location.search)._b || null);
        if (inherited !== null) {
          SP.store.setDurable('rotation', inherited);
          storedRot = inherited;
          rotationLocked = true;
          rotationSource = 'heredada';
          SP.log.info('orientación ' + inherited + '° heredada del reproductor anterior (esta TV la mostraba con el ángulo automático)');
        }
      }
    }
    /* Prioridad: ?rotate= de la URL > elección guardada con GIRAR 180° > valor por defecto del manifiesto >
     * automática (270 en pantalla horizontal, que es una TV instalada en vertical; 0 en pantalla vertical). */
    if (cfg.rotate !== null) {
      renderer.rotation = cfg.rotate;
    } else if (storedRot !== null) {
      renderer.rotation = SP.rotation.normalize(storedRot);
    } else {
      renderer.autoRotation = true;
    }
    renderer.init();
    renderer.message('Cargando…');

    function applyRotation(deg) {
      var r = renderer.setRotation(deg);
      rotationLocked = true;
      rotationSource = 'guardada';
      SP.store.setDurable('rotation', r);
      if (engine) { engine.rotationChanged(); }
      if (controls) { controls.refresh(); }
      SP.log.info('rotación ' + r + '°');
    }

    hooks = {
      onApplied: function (pl) {
        renderer.setAspect(pl.aspect);
        if (!rotationLocked && pl.rotation !== null) { renderer.setRotation(pl.rotation); rotationSource = 'manifiesto'; }
        if (pl.raw) { SP.store.set('lastPlaylist', { url: playlistAbs, raw: pl.raw }); }
      },

      /* Si el manifiesto indica otra versión del reproductor, recargar (entre elementos).
       * Protección anti-bucle: tras recargar, la URL lleva _b=<build>; si aun así seguimos en una
       * versión distinta (index.html viejo en caché), no se vuelve a recargar para ese mismo build. */
      reloadForBuild: function (build) {
        var q = util.parseQuery(global.location.search);
        if (!build || build === global.SP_BUILD) { return false; }
        if (q._b === build) {
          SP.log.warn('el build ' + build + ' no se aplicó tras recargar; se omite');
          return false;
        }
        SP.log.info('nueva versión del reproductor (' + global.SP_BUILD + ' -> ' + build + '), recargando');
        SP.app.reloadTo(util.addQuery(global.location.href, '_b', build));
        return true;
      },

      requestReload: function (cb) {
        updater.check(function () { cb(); });
      }
    };

    engine = new SP.Engine(renderer, cfg, hooks);
    engine.init();
    controls = new SP.Controls(engine, renderer, cfg);
    controls.onRotate = applyRotation;
    controls.onGesture = function () { engine.onUserGesture(); };
    controls.onToggleHud = function () {
      hudOn = !hudOn;
      if (!hudOn) {
        renderer.hud(null);
      } else {
        lastHudAt = util.now();
        renderer.hud(buildHud(lastHudAt));
      }
    };
    controls.init();
    updater = new SP.Updater(engine, cfg, playlistAbs);
    hudOn = cfg.debug;

    SP.app = {
      cfg: cfg,
      renderer: renderer,
      engine: engine,
      controls: controls,
      updater: updater,
      rotate: applyRotation,
      reloadTo: function (url) { global.location.replace(url); },
      state: function () {
        return {
          engine: engine.getState(),
          updater: updater.getState(),
          rotation: renderer.rotation,
          rotationSource: rotationSource,
          geometry: renderer.geometry,
          storePersistent: SP.store.isPersistent(),
          build: global.SP_BUILD || ''
        };
      }
    };

    /* Último manifiesto válido guardado: solo la LISTA. Que los medios se reproduzcan sin red
     * depende del caché del navegador y es una capacidad que se verifica en diagnostico.html. */
    saved = SP.store.get('lastPlaylist', null);
    if (saved && saved.url === playlistAbs && saved.raw) {
      res = SP.playlist.normalize(saved.raw, playlistAbs, { imageSec: cfg.defaultImageSec });
      if (res.ok) {
        res.playlist.raw = saved.raw;
        res.playlist.playerBuild = ''; /* el build guardado es de otra sesión: no provocar recargas */
        SP.log.info('arrancando con la última programación guardada ' + SP.playlist.label(res.playlist));
        engine.begin(res.playlist);
      }
    }
    updater.check(null);

    /* ---- reloj maestro ---- */
    last = util.now();
    global.setInterval(function () {
      var now = util.now();
      var dt = util.clamp(now - last, 0, 1000);
      last = now;
      engine.tick(dt);
      controls.tick(now);
      updater.tick(dt);

      /* Algunas TV no disparan "resize" (cambio de modo, pantalla completa): se comprueba el tamaño cada segundo. */
      if (now - lastLayoutAt >= 1000) {
        lastLayoutAt = now;
        var vp = renderer.viewportSize();
        if (vp.w + 'x' + vp.h !== renderer.lastViewport) {
          renderer.layout();
          controls.refresh();
        }
      }
      /* Sin programación todavía y sin poder descargarla: decir algo en vez de "Cargando…" eterno. */
      if (engine.mode === 'boot' && !bootMsgShown && updater.failures >= 2) {
        bootMsgShown = true;
        renderer.message('No se pudo obtener la programación.\nReintentando…');
      }
      if (hudOn && now - lastHudAt >= 500) {
        lastHudAt = now;
        renderer.hud(buildHud(now));
      }
    }, cfg.tickMs);

    function buildHud(now) {
      var s = engine.getState();
      var u = updater.getState();
      var lines = [];
      var mem = global.performance && global.performance.memory ? Math.round(global.performance.memory.usedJSHeapSize / 1048576) + ' MB' : 'n/d';
      lines.push('build ' + (global.SP_BUILD || '?') + (cfg.tv ? '  tv=' + cfg.tv : '') + '  up ' + util.formatDuration(now - bootedAt));
      lines.push('estado ' + s.state + '  ' + (s.index + 1) + '/' + s.count + '  ' + (s.itemId || '-') + ' [' + (s.kind || '-') + (s.isFallback ? ' respaldo' : '') + ' ' + (s.phase || '-') + ']');
      lines.push(s.kind === 'video' ? ('video ' + s.videoTime.toFixed(1) + ' s') : ('imagen ' + Math.round(s.elapsedMs / 1000) + '/' + Math.round(s.durationMs / 1000) + ' s'));
      lines.push('lista ' + s.version + (s.pendingVersion ? ' (pend ' + s.pendingVersion + ')' : '') + '  fallos seguidos ' + s.consecutiveFailures);
      lines.push('upd: ' + (u.lastOkAt ? Math.round((now - u.lastOkAt) / 1000) + ' s' : 'nunca') + '  err x' + u.failures + (u.lastReject ? '  rechazo: ' + u.lastReject : ''));
      lines.push('rot ' + renderer.rotation + ' (' + rotationSource + ')' + (s.kind === 'video' ? ' video ' + (s.videoInBox ? 'v' + s.videoVariant + '° caja16:9' : 'normal+CSS') : '') + '  sonido ' + (s.soundOn ? 'sí' : 'no') + '  almacén ' + (SP.store.isPersistent() ? 'persistente' : 'memoria') + '  red ' + (global.navigator.onLine === false ? 'OFFLINE' : 'ok') + '  mem ' + mem);
      lines.push('ok:' + s.stats.started + ' fallo:' + s.stats.failed + ' salto:' + s.stats.skipped + ' reint:' + s.stats.retries + ' atasco:' + s.stats.stalls + ' respaldo:' + s.stats.fallbacks + ' recup:' + s.stats.recoveries + ' upd:' + s.stats.updatesApplied);
      return lines.concat(SP.log.tail(5)).join('\n');
    }

    /* ---- eventos del entorno ---- */
    util.on(global, 'resize', function () { renderer.layout(); controls.refresh(); });
    util.on(global, 'orientationchange', function () { renderer.layout(); });
    util.on(global, 'online', function () { SP.log.info('red: en línea'); updater.sinceMs = updater.intervalMs(); });
    util.on(global, 'offline', function () { SP.log.warn('red: sin conexión'); });
    util.on(global.document, 'visibilitychange', function () {
      if (!global.document.hidden) { engine.ensurePlaying(); }
    });
    util.on(global, 'pageshow', function () { engine.ensurePlaying(); });
    util.on(global, 'error', function (ev) {
      SP.log.error('error JS: ' + (ev && ev.message ? ev.message : 'desconocido') + (ev && ev.lineno ? ' @' + ev.lineno : ''));
    });
    util.on(global, 'unhandledrejection', function (ev) {
      SP.log.error('promesa rechazada: ' + (ev && ev.reason && ev.reason.message ? ev.reason.message : String(ev && ev.reason)));
    });

    /* El cursor solo aparece al mover el puntero. */
    util.addClass(global.document.body, 'hide-cursor');
  }

  /* Evita arrancar dos veces si el script se incluye de nuevo. */
  if (!SP.started) {
    SP.started = true;
    if (global.document.readyState === 'loading') {
      util.on(global.document, 'DOMContentLoaded', start);
    } else {
      start();
    }
  }
})(window);
