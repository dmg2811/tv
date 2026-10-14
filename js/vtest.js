/* TEMPORAL — Prueba de formatos de video en una TV horizontal montada en vertical.
 *
 * Se abre SOLA al entrar a la URL pública (cualquier *.github.io) sin parámetros; en cualquier otro sitio (pruebas
 * locales, vista previa del administrador, servidor de la red local) hace falta ?prueba=video (&modo=1|2|3) o pulsar 1, 2
 * o 3 en el reproductor normal. ?normal=1 abre siempre el reproductor normal. En modo de prueba NO se carga la
 * programación (ni el motor ni el actualizador); solo se vigila si se publica OTRO build del reproductor para recargarse:
 * se reproduce en bucle un único video de ejemplo en uno de tres formatos:
 *
 *   1  NORMAL    720x1280 (vertical) con giro CSS: es lo que hace hoy el reproductor.
 *   2  GIRADO    1280x720 con los píxeles girados 270 grados, SIN giro CSS, ocupando todo el viewport (16:9).
 *   3  GIRADO    1280x720 con los píxeles girados 90 grados, SIN giro CSS, ocupando todo el viewport (16:9).
 *   4  ANUNCIO REAL «ultra» (original vertical 1080x1920) convertido a 1280x720 girado 270 grados, mismo método que el 2.
 *
 * Para volver al funcionamiento normal: tecla 0 (o botón SALIR) o Atrás (abre ?normal=1), o restaurar el reproductor.
 * Para borrar esta prueba del todo: ver docs/PRUEBA-VIDEO-GIRADO.md. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  var DIR = 'prueba-video/';
  var MODES = {
    1: { file: 'video-a-720x1280.mp4', short: 'NORMAL', name: 'NORMAL 720x1280 con giro CSS (como hoy)', css: true },
    2: { file: 'video-a-r270.mp4', short: 'GIRADO 270°', name: 'GIRADO 270° 1280x720 sin giro CSS', css: false },
    3: { file: 'video-a-r90.mp4', short: 'GIRADO 90°', name: 'GIRADO 90° 1280x720 sin giro CSS', css: false },
    4: { file: 'ultra-r270.mp4', short: 'ANUNCIO REAL 270°', name: 'ANUNCIO REAL «ultra» GIRADO 270° 1280x720 sin giro CSS', css: false }
  };
  var KEY_MODE = { 49: 1, 50: 2, 51: 3, 52: 4, 97: 1, 98: 2, 99: 3, 100: 4 };
  var EXIT_KEYS = { 48: 1, 96: 1, 27: 1, 8: 1, 10009: 1, 461: 1 };

  function byId(id) {
    return global.document.getElementById(id);
  }

  /* Reconstruye la URL de esta página quitando/añadiendo parámetros. */
  function rebuild(drop, add) {
    var q = util.parseQuery(global.location.search);
    var parts = [];
    var k;
    for (k in q) {
      if (Object.prototype.hasOwnProperty.call(q, k) && !drop[k]) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k])); }
    }
    for (k in add) {
      if (Object.prototype.hasOwnProperty.call(add, k)) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(add[k])); }
    }
    return global.location.pathname + (parts.length ? '?' + parts.join('&') : '');
  }

  SP.vtest = {
    MODES: MODES,

    /* Tecla 1/2/3 -> modo (0 si no es ninguna). */
    modeForKey: function (code) {
      return KEY_MODE[code] || 0;
    },

    /* Desde el reproductor normal: recarga en modo de prueba. */
    open: function (mode) {
      global.location.replace(rebuild({ prueba: 1, modo: 1, normal: 1 }, { prueba: 'video', modo: mode }));
    },

    exit: function () {
      global.location.replace(rebuild({ prueba: 1, modo: 1, normal: 1 }, { normal: 1 }));
    },

    /* ¿Esta página es la URL pública de GitHub Pages? (la prueba se abre sola solo allí). */
    isPublicHost: function () {
      return /(^|\.)github\.io$/i.test(global.location.hostname || '');
    },

    /* ¿Hay que abrir la prueba? Parámetro explícito > ?normal=1 > URL pública sin parámetros. */
    wanted: function (cfg) {
      if (cfg.prueba) { return true; }
      if (cfg.normal) { return false; }
      return this.isPublicHost();
    },

    start: function (cfg, renderer) {
      var self = this;
      var screenEl = byId('screen');
      var tbox = byId('tbox');
      var tvid = global.document.createElement('video');    /* solo existe en la prueba: uso normal = un único <video> */
      var panel = byId('vtest');
      var cssVid = renderer.video;
      var buttons = { 1: byId('vt-1'), 2: byId('vt-2'), 3: byId('vt-3'), 4: byId('vt-4'), rot: byId('vt-rot'), exit: byId('vt-0') };
      var order = ['1', '2', '3', '4', 'rot', 'exit'];
      var state = { mode: 0, focus: 0, hideAt: 0, sticky: true, lastX: null, lastY: null, bootAt: util.now(), box: null, reloadChecks: 0 };
      var i;

      tvid.id = 'tvid';
      tvid.setAttribute('muted', '');
      tvid.setAttribute('playsinline', '');
      tvid.setAttribute('webkit-playsinline', '');
      tvid.preload = 'auto';
      tbox.appendChild(tvid);

      function activeVideo() {
        return MODES[state.mode] && MODES[state.mode].css ? cssVid : tvid;
      }

      function layoutBox() {
        var vp = renderer.viewportSize();
        var b = SP.rotation.fillBox(vp.w, vp.h, 16 / 9);
        state.box = b;
        util.setStyle(tbox, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
      }

      function relayout() {
        renderer.layout();
        layoutBox();
      }

      function stopAll() {
        renderer.unloadVideo();
        try { tvid.pause(); } catch (e) { /* nada */ }
        tvid.removeAttribute('src');
        try { tvid.load(); } catch (e2) { /* nada */ }
      }

      function refreshButtons() {
        var k, el;
        for (i = 0; i < order.length; i++) {
          k = order[i];
          el = buttons[k];
          util.setClass(el, 'sel', String(state.mode) === k);
        }
        for (i = 0; i < order.length; i++) {
          util.setClass(buttons[order[i]], 'focus', i === state.focus);
        }
        util.setText(buttons.rot, 'ROTAR PANTALLA ' + renderer.rotation + '°');
      }

      /* Al abrir, los botones quedan FIJOS hasta la primera interacción; después se ocultan solos a los 8 s. */
      function showPanel(fromUser) {
        util.setClass(panel, 'on', true);
        if (fromUser) { state.sticky = false; }
        state.hideAt = util.now() + 8000;
        util.removeClass(global.document.body, 'hide-cursor');
      }

      function setMode(n, fromUser) {
        var m = MODES[n];
        var url;
        if (!m) { return; }
        stopAll();
        state.mode = n;
        state.focus = n - 1;
        url = DIR + m.file;
        if (m.css) {
          /* igual que producción: el <video> vive dentro del escenario que gira con CSS */
          tbox.style.display = 'none';
          screenEl.style.display = 'block';
          cssVid.loop = true;
          renderer.loadVideo(url, true);
          try { var p1 = cssVid.play(); if (p1 && p1.then) { p1.then(null, function () { /* sin autoplay */ }); } } catch (e) { /* nada */ }
        } else {
          /* video YA girado: sin giro CSS, caja 16:9 que ocupa todo el viewport */
          screenEl.style.display = 'none';
          tbox.style.display = 'block';
          layoutBox();
          tvid.loop = true;
          tvid.muted = true;
          tvid.setAttribute('src', url);
          try { tvid.load(); } catch (e3) { /* nada */ }
          try { var p2 = tvid.play(); if (p2 && p2.then) { p2.then(null, function () { /* sin autoplay */ }); } } catch (e4) { /* nada */ }
        }
        refreshButtons();
        showPanel(fromUser);
        SP.log.info('prueba de video: modo ' + n + ' ' + m.name);
      }

      function hud() {
        var v = activeVideo();
        var m = MODES[state.mode];
        var vp = renderer.viewportSize();
        var q = null;
        var lines = [];
        try { q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; } catch (e) { q = null; }
        lines.push('PRUEBA DE VIDEO · modo ' + state.mode + ' · ' + m.name);
        lines.push('archivo ' + m.file + ' · el video mide ' + (v.videoWidth || '?') + 'x' + (v.videoHeight || '?'));
        lines.push('ventana ' + vp.w + 'x' + vp.h + ' · dpr ' + (global.devicePixelRatio || 1) + ' · giro de pantalla (CSS) ' + renderer.rotation + '°');
        lines.push(m.css ? 'caja del video: escenario 9:16 girado por CSS' : 'caja del video (px): ' + state.box.left + ',' + state.box.top + ' ' + state.box.width + 'x' + state.box.height + ' · sin giro CSS');
        lines.push('t ' + (v.currentTime || 0).toFixed(1) + ' s · ' + (v.paused ? 'EN PAUSA' : 'reproduciendo') + (q ? ' · cuadros perdidos ' + q.droppedVideoFrames + '/' + q.totalVideoFrames : ''));
        renderer.hud(lines.join('\n'));
      }

      function rotate() {
        var vp = renderer.viewportSize();
        var r = renderer.setRotation(SP.rotation.nextFit(renderer.rotation, vp.w, vp.h));
        SP.store.set('rotation', r);
        layoutBox();
        refreshButtons();
        showPanel(true);
      }

      function activate(k) {
        if (k === 'exit') { self.exit(); return; }
        if (k === 'rot') { rotate(); return; }
        setMode(parseInt(k, 10), true);
      }

      renderer.message(null);
      layoutBox();

      for (i = 0; i < order.length; i++) {
        (function (k) {
          var el = buttons[k];
          util.on(el, 'mousedown', function (e) { if (e.preventDefault) { e.preventDefault(); } });
          util.on(el, 'click', function () { showPanel(true); activate(k); });
        })(order[i]);
      }

      util.on(global.document, 'keydown', function (e) {
        var code;
        e = e || global.event;
        code = e.keyCode || e.which;
        if (KEY_MODE[code]) { setMode(KEY_MODE[code], true); self.prevent(e); return; }
        if (EXIT_KEYS[code]) { self.exit(); self.prevent(e); return; }
        if (code === 82 || code === 403) { rotate(); self.prevent(e); return; }
        if (code === 37 || code === 39) {
          state.focus = (state.focus + (code === 37 ? -1 : 1) + order.length) % order.length;
          refreshButtons();
          showPanel(true);
          self.prevent(e);
          return;
        }
        if (code === 13) {
          if (panel.className.indexOf('on') >= 0) { showPanel(true); activate(order[state.focus]); } else { showPanel(true); }
          self.prevent(e);
          return;
        }
        showPanel(true);
      });

      util.on(global.document, 'mousemove', function (e) {
        var x, y, dx, dy;
        e = e || global.event;
        x = e.clientX;
        y = e.clientY;
        if (typeof x === 'number' && typeof y === 'number') {
          if (state.lastX === null) { state.lastX = x; state.lastY = y; if (util.now() - state.bootAt < 2500) { return; } }
          dx = x - state.lastX;
          dy = y - state.lastY;
          if (dx * dx + dy * dy < 36) { return; }
          state.lastX = x;
          state.lastY = y;
        }
        showPanel(true);
      });
      util.on(global.document, 'touchstart', function () { showPanel(true); });
      util.on(global, 'resize', relayout);

      /* La imagen del video aparece cuando hay datos: en modo 1 el <video> del escenario empieza oculto. */
      util.on(cssVid, 'playing', function () { if (MODES[state.mode].css) { renderer.showVideo(); } });
      util.on(cssVid, 'loadeddata', function () { if (MODES[state.mode].css) { renderer.showVideo(); } });

      global.setInterval(function () {
        var now = util.now();
        var vp = renderer.viewportSize();
        if (vp.w + 'x' + vp.h !== renderer.lastViewport) { relayout(); }
        if (!state.sticky && panel.className.indexOf('on') >= 0 && now >= state.hideAt) {
          util.setClass(panel, 'on', false);
          util.addClass(global.document.body, 'hide-cursor');
        }
        hud();
      }, 500);

      /* En modo de prueba no hay actualizador: se vigila si se publica OTRO build (p. ej. al restaurar el reproductor
       * normal) leyendo index.html, y entonces se recarga UNA vez por build detectado (sin bucles). */
      function checkBuild() {
        var xhr;
        var mine = global.SP_BUILD || '';
        try {
          xhr = new global.XMLHttpRequest();
          xhr.open('GET', global.location.pathname + '?vc=' + util.now(), true);
          xhr.onreadystatechange = function () {
            var m, seen;
            if (xhr.readyState !== 4 || xhr.status !== 200) { return; }
            m = /SP_BUILD\s*=\s*'([^']*)'/.exec(xhr.responseText || '');
            state.reloadChecks += 1;
            if (!m || !m[1] || m[1] === mine) { return; }
            seen = SP.store.get('vtestReload', null);
            if (seen === m[1]) { return; }
            SP.store.set('vtestReload', m[1]);
            SP.log.info('prueba de video: hay un build nuevo (' + mine + ' -> ' + m[1] + '), recargando');
            global.location.reload();
          };
          xhr.send(null);
        } catch (e) { /* sin red: se reintenta en la siguiente vuelta */ }
      }
      global.setInterval(checkBuild, cfg.vcheckMs || 60000);

      SP.app = {
        cfg: cfg,
        renderer: renderer,
        vtest: state,
        setMode: setMode,
        state: function () {
          var v = activeVideo();
          return { prueba: true, mode: state.mode, rotation: renderer.rotation, geometry: renderer.geometry, box: state.box, videoWidth: v.videoWidth, videoHeight: v.videoHeight, currentTime: v.currentTime, paused: v.paused, build: global.SP_BUILD || '' };
        }
      };

      util.addClass(global.document.body, 'hide-cursor');
      setMode(cfg.modo || 1);
      hud();
    },

    prevent: function (e) {
      if (e.preventDefault) { e.preventDefault(); } else { e.returnValue = false; }
    }
  };
})(window);
