/* Superficie de reproducción: escenario girado, 2 capas <img> y UN solo <video>.
 *
 * Consumo mínimo de memoria:
 *  - Un único elemento <video> reutilizado (las TV suelen tener un solo decodificador por hardware).
 *    Al terminar se libera con removeAttribute('src') + load().
 *  - Dos <img> alternados: la visible y la que se está cargando. La anterior se vacía tras el cambio.
 *  - Precarga limitada a UNA imagen siguiente; los videos nunca se precargan en paralelo. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;

  function byId(id) {
    return global.document.getElementById(id);
  }

  function clearImg(img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }

  function Renderer() {
    this.screen = byId('screen');
    this.ui = byId('ui');            /* capa de controles/mensajes: hermana de #screen, con su propia geometría */
    this.stage = byId('stage');
    this.msgEl = byId('msg');
    this.hintEl = byId('hint');
    this.hudEl = byId('hud');
    this.video = byId('vid');
    this.imgs = [byId('imgA'), byId('imgB')];
    this.front = 0;            /* índice de la <img> visible */
    this.preloaded = null;     /* { url, img } */
    this.imageToken = 0;
    this.rotation = 0;
    this.autoRotation = false; /* true = nadie la configuró: se elige según el tamaño de la ventana */
    this.uiRotate = null;      /* null = la capa de controles gira igual que el escenario */
    this.viewportOverride = null; /* { w, h } forzado por ?viewport= */
    this.aspect = 9 / 16;
    this.geometry = null;
    this.uiGeometry = null;
    this.lastViewport = '';
    this.videoUrl = '';
  }

  Renderer.prototype.init = function () {
    clearImg(this.imgs[0]);
    clearImg(this.imgs[1]);
    this.video.style.visibility = 'hidden';
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.setAttribute('muted', '');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.preload = 'auto';
    this.video.controls = false;
    this.layout();
  };

  /* ---- geometría ---- */
  Renderer.prototype.setRotation = function (deg) {
    this.autoRotation = false;
    this.rotation = SP.rotation.normalize(deg);
    this.layout();
    return this.rotation;
  };

  /* Rotación automática: sigue al tamaño de la ventana (90 en pantalla horizontal, 0 en vertical). */
  Renderer.prototype.setAutoRotation = function () {
    this.autoRotation = true;
    this.layout();
    return this.rotation;
  };

  Renderer.prototype.setAspect = function (aspect) {
    this.aspect = SP.rotation.parseAspect(aspect);
    this.layout();
  };

  Renderer.prototype.viewportSize = function () {
    var de = global.document.documentElement;
    if (this.viewportOverride) { return { w: this.viewportOverride.w, h: this.viewportOverride.h }; }
    return {
      w: global.innerWidth || de.clientWidth || 1280,
      h: global.innerHeight || de.clientHeight || 720
    };
  };

  Renderer.prototype.layout = function () {
    var vp = this.viewportSize();
    var g, gu, uiRot;
    if (this.autoRotation) { this.rotation = SP.rotation.defaultFor(vp.w, vp.h); }
    g = SP.rotation.layout(vp.w, vp.h, this.rotation, this.aspect);
    util.setStyle(this.screen, {
      width: g.logicalW + 'px',
      height: g.logicalH + 'px',
      left: g.left + 'px',
      top: g.top + 'px',
      fontSize: g.fontPx + 'px'
    });
    util.setTransform(this.screen, 'rotate(' + g.rotation + 'deg)');
    util.setStyle(this.stage, {
      width: g.stageW + 'px',
      height: g.stageH + 'px',
      left: g.stageLeft + 'px',
      top: g.stageTop + 'px'
    });
    /* Capa de controles: misma geometría que el escenario salvo que ?uirotate= pida otra. Va FUERA de #screen
     * para que sus botones no dependan de lo que haga la TV con el plano de video. */
    uiRot = this.uiRotate !== null ? this.uiRotate : this.rotation;
    gu = uiRot === this.rotation ? g : SP.rotation.layout(vp.w, vp.h, uiRot, this.aspect);
    util.setStyle(this.ui, {
      width: gu.logicalW + 'px',
      height: gu.logicalH + 'px',
      left: gu.left + 'px',
      top: gu.top + 'px',
      fontSize: gu.fontPx + 'px'
    });
    util.setTransform(this.ui, 'rotate(' + gu.rotation + 'deg)');
    this.geometry = g;
    this.uiGeometry = gu;
    this.lastViewport = vp.w + 'x' + vp.h;
    return g;
  };

  /* ---- imágenes ---- */
  Renderer.prototype.showImage = function (url, cb) {
    var self = this;
    var token = ++this.imageToken;
    var backIdx = 1 - this.front;
    var back = this.imgs[backIdx];
    var finished = false;

    function finish(err) {
      if (finished || token !== self.imageToken) { return; }
      finished = true;
      back.onload = null;
      back.onerror = null;
      if (err) {
        cb(err);
        return;
      }
      back.style.visibility = 'visible';
      clearImg(self.imgs[self.front]);
      self.front = backIdx;
      self.video.style.visibility = 'hidden';
      cb(null);
    }

    clearImg(back);
    back.onload = function () { finish(null); };
    back.onerror = function () { finish({ type: 'image-error', message: 'no se pudo cargar la imagen' }); };
    back.src = url;
    /* La precarga solo calienta el caché del navegador: se libera DESPUÉS de pedir la imagen real,
     * para no perder la entrada de caché en memoria antes de que la capa visible la use. */
    this.releasePreload();
  };

  /* Precarga UNA imagen (el siguiente elemento) y libera la anterior precarga. */
  Renderer.prototype.preloadImage = function (url) {
    var img;
    if (this.preloaded && this.preloaded.url === url) { return; }
    this.releasePreload();
    img = new global.Image();
    img.onerror = function () { /* se manejará cuando toque mostrarla */ };
    img.src = url;
    this.preloaded = { url: url, img: img };
  };

  Renderer.prototype.releasePreload = function () {
    if (this.preloaded) {
      this.preloaded.img.onload = null;
      this.preloaded.img.onerror = null;
      this.preloaded.img.removeAttribute('src');
      this.preloaded = null;
    }
  };

  /* ---- video ---- */
  Renderer.prototype.loadVideo = function (url, muted) {
    var v = this.video;
    this.videoUrl = url;
    v.muted = !!muted;
    v.defaultMuted = !!muted;
    v.style.visibility = 'hidden';
    v.setAttribute('src', url);
    v.load();
  };

  Renderer.prototype.showVideo = function () {
    var i;
    this.video.style.visibility = 'visible';
    /* la imagen anterior ya no se necesita */
    for (i = 0; i < this.imgs.length; i++) { clearImg(this.imgs[i]); }
  };

  /* Libera el decodificador y la memoria del video. */
  Renderer.prototype.unloadVideo = function () {
    var v = this.video;
    this.videoUrl = '';
    this.unloading = true;
    try { v.pause(); } catch (e) { /* nada */ }
    v.style.visibility = 'hidden';
    v.removeAttribute('src');
    try { v.load(); } catch (e2) { /* nada */ }
    this.unloading = false;
  };

  Renderer.prototype.hasVideoSrc = function () {
    return !!this.video.getAttribute('src');
  };

  /* Deja el escenario en negro y libera imágenes, video y precarga. */
  Renderer.prototype.clearStage = function () {
    this.imageToken++;
    this.releasePreload();
    clearImg(this.imgs[0]);
    clearImg(this.imgs[1]);
    this.unloadVideo();
  };

  /* ---- superposiciones ---- */
  Renderer.prototype.message = function (text) {
    util.setText(this.msgEl, text || '');
    util.setClass(this.msgEl, 'on', !!text);
  };

  Renderer.prototype.hint = function (text) {
    util.setText(this.hintEl, text || '');
    util.setClass(this.hintEl, 'on', !!text);
  };

  Renderer.prototype.hud = function (text) {
    if (text === null) {
      util.setClass(this.hudEl, 'on', false);
      return;
    }
    util.setText(this.hudEl, text);
    util.setClass(this.hudEl, 'on', true);
  };

  SP.Renderer = Renderer;
})(window);
