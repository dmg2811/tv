/* Controles en pantalla + teclado/control remoto.
 *
 * Los botones NO reciben foco del navegador (tabindex=-1, mousedown cancelado): el resaltado y la
 * activación los maneja este módulo, para evitar dobles activaciones (keydown + click sintético).
 *
 * Teclas (keyCode, porque `key` no existe en muchas TV):
 *   Con controles ocultos:  ← anterior   → siguiente   OK/Enter: mostrar controles
 *                           Espacio / Play / Pause: pausa-reanudar
 *   Con controles visibles: ← → mueven el resaltado   OK/Enter: activa   ↓ / Atrás: ocultar
 *   Teclas multimedia y de color funcionan siempre (ver KEYS). Los códigos reales de cada TV
 *   se confirman con diagnostico.html. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  var KEYS = {
    ENTER: 13, SPACE: 32, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    ESC: 27, BACKSPACE: 8,
    BACK_TIZEN: 10009, BACK_WEBOS: 461,
    PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, PLAYPAUSE_TIZEN: 10252,
    MEDIA_PLAYPAUSE: 179, MEDIA_STOP: 178, MEDIA_NEXT: 176, MEDIA_PREV: 177,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    N_M: 77, N_F: 70, N_R: 82, N_D: 68
  };

  function Controls(engine, renderer, cfg) {
    this.engine = engine;
    this.renderer = renderer;
    this.cfg = cfg;
    this.root = global.document.getElementById('controls');
    this.buttons = {};
    this.order = ['prev', 'pause', 'next', 'rotate', 'fullscreen', 'sound'];
    this.focusIdx = 1;
    this.visible = false;
    this.enabled = !cfg || cfg.controls !== false;   /* ?controls=0: los botones nunca se muestran */
    this.hideAtMs = 0;
    this.bootAt = util.now();
    this.lastX = null;
    this.lastY = null;
    this.onRotate = null;
    this.onToggleHud = null;
    this.onGesture = null;
  }

  Controls.prototype.fullscreenApi = function () {
    var de = global.document.documentElement;
    return {
      request: de.requestFullscreen || de.webkitRequestFullscreen || de.webkitRequestFullScreen || de.mozRequestFullScreen || de.msRequestFullscreen || null,
      exit: global.document.exitFullscreen || global.document.webkitExitFullscreen || global.document.webkitCancelFullScreen || global.document.mozCancelFullScreen || global.document.msExitFullscreen || null
    };
  };

  Controls.prototype.isFullscreen = function () {
    var d = global.document;
    return !!(d.fullscreenElement || d.webkitFullscreenElement || d.webkitCurrentFullScreenElement || d.mozFullScreenElement || d.msFullscreenElement);
  };

  Controls.prototype.init = function () {
    var self = this;
    var i, name, el;

    for (i = 0; i < this.order.length; i++) {
      name = this.order[i];
      el = global.document.getElementById('btn-' + name);
      this.buttons[name] = el;
      (function (n, button) {
        util.on(button, 'mousedown', function (e) { if (e.preventDefault) { e.preventDefault(); } });
        util.on(button, 'click', function () {
          self.touch();
          self.activate(n);
        });
      })(name, el);
    }

    /* Sin API de pantalla completa (muchas TV): el botón se oculta. */
    if (!this.fullscreenApi().request) {
      this.buttons.fullscreen.style.display = 'none';
      this.order.splice(util.indexOf(this.order, 'fullscreen'), 1);
    }
    if (this.focusIdx >= this.order.length) { this.focusIdx = 0; }

    util.on(global.document, 'keydown', function (e) { self.onKey(e || global.event); });
    util.on(global.document, 'mousemove', function (e) { self.onPointerMove(e || global.event); });
    util.on(global.document, 'touchstart', function () { self.onPointer(true); });
    util.on(global.document, 'click', function () { if (self.onGesture) { self.onGesture(); } });
    this.refresh();
  };

  /* Movimiento del puntero: solo cuenta si es REAL. Muchas TV disparan "mousemove" sintéticos (al cambiar el
   * diseño, al ocultar el cursor...) con las mismas coordenadas, o con una vibración de un píxel: con eso los
   * botones aparecerían solos y no se irían nunca. Se exige un desplazamiento de al menos 6 px. El primer
   * evento tras arrancar solo fija la referencia. */
  Controls.prototype.onPointerMove = function (e) {
    var x = e ? e.clientX : undefined;
    var y = e ? e.clientY : undefined;
    var dx, dy;
    if (typeof x !== 'number' || typeof y !== 'number') { this.onPointer(); return; }
    if (this.lastX === null) {
      this.lastX = x;
      this.lastY = y;
      if (util.now() - this.bootAt < 2500) { return; }
    }
    dx = x - this.lastX;
    dy = y - this.lastY;
    if (dx * dx + dy * dy < 36) { return; }
    this.lastX = x;
    this.lastY = y;
    this.onPointer();
  };

  /* Movimiento real del puntero (magic remote, mouse) o toque: muestra los controles y el cursor. */
  Controls.prototype.onPointer = function (fromTouch) {
    if (this.onGesture && fromTouch) { this.onGesture(); }
    if (!this.enabled) { return; }
    util.removeClass(global.document.body, 'hide-cursor');
    this.show();
  };

  Controls.prototype.show = function () {
    if (!this.enabled) { return; }
    this.visible = true;
    this.touch();
    util.addClass(this.root, 'on');
    this.refresh();
  };

  Controls.prototype.hide = function () {
    this.visible = false;
    util.removeClass(this.root, 'on');
    util.addClass(global.document.body, 'hide-cursor');
  };

  Controls.prototype.touch = function () {
    this.hideAtMs = util.now() + this.cfg.hideMs;
  };

  /* Llamado por el reloj maestro: oculta tras la inactividad. */
  Controls.prototype.tick = function (nowMs) {
    if (this.visible && nowMs >= this.hideAtMs) { this.hide(); }
  };

  /* GIRAR 180° alterna solo entre los dos ángulos que llenan la pantalla (270 <-> 90 en una pantalla horizontal,
   * 0 <-> 180 en una vertical); los demás se pueden fijar por URL. */
  Controls.prototype.nextRotation = function () {
    var vp = this.renderer.viewportSize();
    return SP.rotation.nextFit(this.renderer.rotation, vp.w, vp.h);
  };

  Controls.prototype.refresh = function () {
    var st = this.engine.getState();
    var name, i, focused;
    util.setText(this.buttons.pause, st.paused ? 'REANUDAR' : 'PAUSA');
    util.setText(this.buttons.sound, 'SONIDO: ' + (st.soundOn ? 'SÍ' : 'NO'));
    util.setText(this.buttons.rotate, 'GIRAR 180°');
    util.setText(this.buttons.fullscreen, this.isFullscreen() ? 'SALIR PANT. COMPLETA' : 'PANTALLA COMPLETA');
    for (i = 0; i < this.order.length; i++) {
      name = this.order[i];
      focused = this.visible && i === this.focusIdx;
      util.setClass(this.buttons[name], 'focus', focused);
    }
  };

  Controls.prototype.activate = function (name) {
    var api, self = this;
    switch (name) {
      case 'prev': this.engine.prev(); break;
      case 'next': this.engine.next(); break;
      case 'pause': this.engine.togglePause(); break;
      case 'sound': this.engine.toggleSound(); break;
      case 'rotate':
        if (this.onRotate) { this.onRotate(this.nextRotation()); }
        break;
      case 'fullscreen':
        api = this.fullscreenApi();
        try {
          if (this.isFullscreen()) {
            if (api.exit) { api.exit.call(global.document); }
          } else if (api.request) {
            api.request.call(global.document.documentElement);
          }
        } catch (e) {
          SP.log.warn('pantalla completa rechazada: ' + e);
        }
        /* el estado cambia de forma asíncrona */
        global.setTimeout(function () { self.refresh(); }, 300);
        break;
      default: break;
    }
    this.refresh();
  };

  Controls.prototype.onKey = function (e) {
    var code = e.keyCode || e.which;
    var handled = true;
    var engine = this.engine;
    var step;

    if (this.onGesture) { this.onGesture(); }

    /* Teclas multimedia / color: siempre activas. */
    switch (code) {
      case KEYS.PLAY: engine.resume(); break;
      case KEYS.PAUSE: engine.pause(); break;
      case KEYS.PLAYPAUSE_TIZEN:
      case KEYS.MEDIA_PLAYPAUSE: engine.togglePause(); break;
      case KEYS.FF:
      case KEYS.MEDIA_NEXT: engine.next(); break;
      case KEYS.RW:
      case KEYS.MEDIA_PREV: engine.prev(); break;
      case KEYS.RED:
      case KEYS.N_R: if (this.onRotate) { this.onRotate(this.nextRotation()); } break;
      case KEYS.GREEN:
      case KEYS.N_M: engine.toggleSound(); break;
      case KEYS.YELLOW:
      case KEYS.N_F: this.activate('fullscreen'); break;
      case KEYS.BLUE:
      case KEYS.N_D: if (this.onToggleHud) { this.onToggleHud(); } break;
      default: handled = false; break;
    }
    if (handled) {
      this.refresh();
      this.prevent(e);
      return;
    }

    handled = true;
    if (this.visible) {
      this.touch();
      switch (code) {
        case KEYS.LEFT:
        case KEYS.RIGHT:
          step = code === KEYS.LEFT ? -1 : 1;
          this.focusIdx = (this.focusIdx + step + this.order.length) % this.order.length;
          this.refresh();
          break;
        case KEYS.ENTER:
          this.activate(this.order[this.focusIdx]);
          break;
        case KEYS.DOWN:
        case KEYS.ESC:
        case KEYS.BACKSPACE:
        case KEYS.BACK_TIZEN:
        case KEYS.BACK_WEBOS:
          this.hide();
          break;
        default: handled = false; break;
      }
    } else {
      switch (code) {
        case KEYS.LEFT: engine.prev(); break;
        case KEYS.RIGHT: engine.next(); break;
        case KEYS.SPACE: engine.togglePause(); break;
        case KEYS.ENTER:
        case KEYS.UP:
          if (!this.enabled) { handled = false; break; }
          this.focusIdx = util.indexOf(this.order, 'pause');
          this.show();
          break;
        default: handled = false; break;
      }
    }
    if (handled) { this.prevent(e); }
  };

  Controls.prototype.prevent = function (e) {
    if (e.preventDefault) { e.preventDefault(); } else { e.returnValue = false; }
  };

  Controls.KEYS = KEYS;
  SP.Controls = Controls;
})(window);
