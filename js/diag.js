/* Diagnóstico de Smart TV. ES5. Mide lo que decide la compatibilidad real del reproductor:
 * motor del navegador, códecs, autoplay, rotación con video, teclas del control remoto,
 * red y caché HTTP de video. Los resultados se pueden enviar al servidor LAN (POST /__report). */
(function (global) {
  'use strict';

  var doc = global.document;
  var nav = global.navigator;
  var SP = global.SP;
  var util = SP.util;
  var ASSET = 'diag-assets/diag-720x1280.mp4';
  /* '1' (6 s, ~1 MB) no tiene botón: lo usan las pruebas automatizadas para no esperar minutos. */
  var CACHE_FILES = { '1': 'diag-assets/cache-1mb.mp4', '3': 'diag-assets/cache-3mb.mp4', '20': 'diag-assets/cache-20mb.mp4' };

  var report = { diagVersion: 1, startedAt: new Date().toISOString(), page: {}, sections: {}, extras: {} };
  var tables = {};
  var interacted = false;
  var hasLanServer = false;
  var lastCacheUrl = '';

  function $(id) { return doc.getElementById(id); }
  function now() { return util.now(); }

  /* ------------------------------------------------------------------ tablas */
  function section(id, title) {
    var h = doc.createElement('h2');
    var t = doc.createElement('table');
    var tb = doc.createElement('tbody');
    util.setText(h, title);
    t.appendChild(tb);
    $('content').appendChild(h);
    $('content').appendChild(t);
    tables[id] = tb;
    report.sections[id] = {};
  }

  /* status: ok | fail | warn | info | run */
  function row(sec, key, label, status, detail) {
    var tb = tables[sec];
    var tr = null;
    var i, kids, td;
    kids = tb.childNodes;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute('data-k') === key) { tr = kids[i]; break; }
    }
    if (!tr) {
      tr = doc.createElement('tr');
      tr.setAttribute('data-k', key);
      for (i = 0; i < 3; i++) {
        td = doc.createElement('td');
        td.className = i === 0 ? 'k' : (i === 1 ? 's' : 'd');
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    util.setText(tr.childNodes[0], label);
    util.setText(tr.childNodes[1], { ok: 'OK', fail: 'FALLA', warn: 'AVISO', info: 'INFO', run: '...' }[status] || status);
    tr.childNodes[1].className = 's ' + status;
    util.setText(tr.childNodes[2], detail === undefined || detail === null ? '' : String(detail));
    report.sections[sec][key] = { label: label, status: status, detail: detail === undefined ? '' : String(detail) };
  }

  function guard(sec, key, label, fn) {
    try { fn(); } catch (e) { row(sec, key, label, 'fail', 'error en la prueba: ' + (e && e.message ? e.message : e)); }
  }

  /* ------------------------------------------------------------- utilidades XHR */
  function xhr(method, url, opts, cb) {
    var x = new global.XMLHttpRequest();
    var t0 = now();
    var finished = false;
    var timer;
    opts = opts || {};
    function done(err, res) {
      if (finished) { return; }
      finished = true;
      global.clearTimeout(timer);
      cb(err, res);
    }
    try {
      x.open(method, url, true);
      if (opts.binary) { try { x.responseType = 'arraybuffer'; } catch (e0) { /* sin soporte */ } }
      if (opts.json) { x.setRequestHeader('Content-Type', 'application/json'); }
    } catch (e) { cb({ message: String(e.message || e) }); return; }
    x.onreadystatechange = function () {
      var len = 0;
      if (x.readyState !== 4) { return; }
      if (opts.binary && x.response && x.response.byteLength !== undefined) { len = x.response.byteLength; } else if (x.responseText) { len = x.responseText.length; }
      done(x.status >= 200 && x.status < 300 ? null : { status: x.status, message: 'HTTP ' + x.status }, { status: x.status, ms: now() - t0, bytes: len, text: opts.binary ? '' : x.responseText });
    };
    timer = global.setTimeout(function () { try { x.abort(); } catch (e2) { /* nada */ } done({ message: 'timeout' }); }, opts.timeoutMs || 20000);
    try { x.send(opts.body || null); } catch (e3) { done({ message: String(e3.message || e3) }); }
  }

  function abs(rel) { return util.resolveUrl(global.location.href, rel); }
  function pathOf(rel) { return abs(rel).replace(/^[a-z]+:\/\/[^\/]+/i, '').split('?')[0]; }
  function fmtMs(ms) { return ms === undefined ? 'n/d' : ms + ' ms'; }

  /* -------------------------------------------------- A. identificación */
  function detectPlatform(ua) {
    var m;
    if (/Tizen/i.test(ua)) { m = /Tizen[ \/]([\d.]+)/i.exec(ua); return 'Samsung Tizen' + (m ? ' ' + m[1] : ''); }
    if (/Web0S|webOS|NetCast/i.test(ua)) { return 'LG webOS / NetCast'; }
    if (/VIDAA|HiSense/i.test(ua)) { return 'Hisense VIDAA'; }
    if (/AFT[A-Z]|Silk/i.test(ua)) { return 'Amazon Fire TV'; }
    if (/Roku/i.test(ua)) { return 'Roku'; }
    if (/Android/i.test(ua) && /TV|BRAVIA|SHIELD|Chromecast|MiBOX|MIBOX|AFT/i.test(ua)) { return 'Android TV / Google TV'; }
    if (/Android/i.test(ua)) { return 'Android (no se identifica como TV)'; }
    if (/SmartTV|SMART-TV|TV Safari|Titan|Opera TV|HbbTV/i.test(ua)) { return 'Smart TV genérica'; }
    if (/Windows|Macintosh|X11|Linux/i.test(ua)) { return 'Equipo de escritorio'; }
    return 'No identificada';
  }

  function chromeVersion(ua) {
    var m = /Chrome\/(\d+)/.exec(ua);
    return m ? parseInt(m[1], 10) : null;
  }

  function runIdentification(cb) {
    var ua = nav.userAgent || '';
    var cv = chromeVersion(ua);
    var wk = /AppleWebKit\/([\d.]+)/.exec(ua);
    var verdict;
    guard('ident', 'ua', 'User-Agent', function () { row('ident', 'ua', 'User-Agent', 'info', ua); });
    guard('ident', 'plat', 'Plataforma detectada', function () { row('ident', 'plat', 'Plataforma detectada', 'info', detectPlatform(ua)); });
    guard('ident', 'engine', 'Motor del navegador', function () {
      if (cv !== null) {
        verdict = cv >= 80 ? 'ok' : (cv >= 56 ? 'warn' : 'warn');
        row('ident', 'engine', 'Motor del navegador', verdict, 'Chromium ' + cv + (cv < 56 ? ' (antiguo: el reproductor ES5 debería funcionar; la prueba real es obligatoria)' : (cv < 80 ? ' (aceptable)' : ' (moderno)')));
      } else {
        row('ident', 'engine', 'Motor del navegador', 'info', wk ? 'WebKit ' + wk[1] : 'no identificado');
      }
    });
    guard('ident', 'screen', 'Pantalla', function () {
      row('ident', 'screen', 'Pantalla / ventana', 'info', 'screen ' + global.screen.width + 'x' + global.screen.height + ' · ventana ' + global.innerWidth + 'x' + global.innerHeight + ' · dpr ' + (global.devicePixelRatio || 1));
    });
    guard('ident', 'orient', 'Orientación de la pantalla', function () {
      var vw = global.innerWidth;
      var vh = global.innerHeight;
      var de = doc.documentElement;
      var so = global.screen && global.screen.orientation ? global.screen.orientation : null;
      var mq = global.matchMedia ? global.matchMedia('(orientation: portrait)').matches : null;
      var fit = SP.rotation.fitAngles(vw, vh);
      var info = {
        innerWidth: vw, innerHeight: vh, clientWidth: de.clientWidth, clientHeight: de.clientHeight,
        outerWidth: global.outerWidth, outerHeight: global.outerHeight,
        screenWidth: global.screen.width, screenHeight: global.screen.height,
        availWidth: global.screen.availWidth, availHeight: global.screen.availHeight,
        dpr: global.devicePixelRatio || 1,
        screenOrientation: so ? (so.type + ' ' + so.angle + '°') : 'n/d',
        mediaPortrait: mq,
        navegadorInforma: vw >= vh ? 'HORIZONTAL' : 'VERTICAL',
        rotacionAutomatica: SP.rotation.defaultFor(vw, vh),
        angulosUtiles: fit
      };
      report.extras.orientation = info;
      row('ident', 'orient', 'Orientación de la pantalla', 'info',
        'el navegador informa ' + info.navegadorInforma + ' (ventana ' + vw + 'x' + vh + ', pantalla ' + info.screenWidth + 'x' + info.screenHeight +
        ', media portrait: ' + (mq === null ? 'n/d' : (mq ? 'sí' : 'no')) + ', screen.orientation: ' + info.screenOrientation + ') · el reproductor arrancaría en ' +
        info.rotacionAutomatica + '° y GIRAR 180° alternaría ' + fit[0] + '°/' + fit[1] + '°');
    });
    guard('ident', 'time', 'Fecha y hora de la TV', function () {
      row('ident', 'time', 'Fecha y hora de la TV', 'info', new Date().toString());
    });
    guard('ident', 'page', 'Página', function () {
      report.page = { href: global.location.href, protocol: global.location.protocol, secureContext: !!global.isSecureContext };
      row('ident', 'page', 'Página', 'info', global.location.protocol + '//' + global.location.host + (global.isSecureContext ? ' (contexto seguro)' : ' (NO es contexto seguro: sin Service Worker/Cache API)'));
    });
    guard('ident', 'vis', 'Visibilidad de la página', function () {
      row('ident', 'vis', 'Visibilidad de la página', doc.hidden ? 'warn' : 'info', (doc.visibilityState || (doc.hidden ? 'hidden' : 'visible')) + (doc.hidden ? ' (la página está oculta: el navegador puede abortar la reproducción)' : ''));
    });
    guard('ident', 'hw', 'Recursos', function () {
      row('ident', 'hw', 'Núcleos / memoria declarada', 'info', (nav.hardwareConcurrency || 'n/d') + ' núcleos · ' + (nav.deviceMemory ? nav.deviceMemory + ' GB' : 'memoria n/d'));
    });
    report.extras.userAgent = ua;
    report.extras.chromeVersion = cv;
    report.extras.platform = detectPlatform(ua);
    cb();
  }

  /* ---------------------------------------------- B. capacidades JS / CSS */
  function canEval(code) {
    try { new Function(code); return true; } catch (e) { return false; }
  }

  function runFeatures(cb) {
    var s = doc.createElement('div').style;
    var de = doc.documentElement;
    var list = [
      ['json', 'JSON', true, function () { return typeof global.JSON === 'object' && !!global.JSON.parse; }],
      ['xhr', 'XMLHttpRequest', true, function () { return typeof global.XMLHttpRequest === 'function' || typeof global.XMLHttpRequest === 'object'; }],
      ['addevt', 'addEventListener', true, function () { return !!global.addEventListener; }],
      ['video', 'Elemento <video> + play()', true, function () { var v = doc.createElement('video'); return !!v.canPlayType && typeof v.play === 'function'; }],
      ['transform', 'CSS transform (rotación)', true, function () { return 'transform' in s || 'webkitTransform' in s; }],
      ['localstorage', 'localStorage (escribir y leer)', false, function () { global.localStorage.setItem('sp.diag', '1'); var ok = global.localStorage.getItem('sp.diag') === '1'; global.localStorage.removeItem('sp.diag'); return ok; }],
      ['sessionstorage', 'sessionStorage', false, function () { return !!global.sessionStorage; }],
      ['vwvh', 'Unidades vw/vh', false, function () { var d = doc.createElement('div'); d.style.cssText = 'position:absolute;visibility:hidden;width:50vw;height:1px'; doc.body.appendChild(d); var w = d.offsetWidth; doc.body.removeChild(d); return Math.abs(w - global.innerWidth / 2) <= 3; }],
      ['objectfit', 'CSS object-fit', false, function () { return 'objectFit' in s; }],
      ['calc', 'CSS calc()', false, function () { s.width = 'calc(10px + 10px)'; var ok = s.width !== ''; s.width = ''; return ok; }],
      ['raf', 'requestAnimationFrame', false, function () { return typeof global.requestAnimationFrame === 'function'; }],
      ['fullscreen', 'API de pantalla completa', false, function () { return !!(de.requestFullscreen || de.webkitRequestFullscreen || de.webkitRequestFullScreen || de.mozRequestFullScreen || de.msRequestFullscreen); }],
      ['orientation', 'Screen Orientation API (no se usa)', false, function () { return !!(global.screen && global.screen.orientation); }],
      ['wakelock', 'Wake Lock API', false, function () { return !!nav.wakeLock; }],
      ['visibility', 'Page Visibility', false, function () { return typeof doc.hidden !== 'undefined'; }],
      ['fetch', 'fetch (el reproductor NO lo usa)', false, function () { return typeof global.fetch === 'function'; }],
      ['promise', 'Promise (el reproductor NO lo usa)', false, function () { return typeof global.Promise === 'function'; }],
      ['es2015', 'Sintaxis ES2015 (el reproductor NO la usa)', false, function () { return canEval('const a=()=>`x`;return a()'); }],
      ['mediasource', 'MediaSource', false, function () { return !!(global.MediaSource || global.WebKitMediaSource); }],
      ['restiming', 'Resource Timing', false, function () { return !!(global.performance && global.performance.getEntriesByType); }],
      ['perfmemory', 'performance.memory', false, function () { return !!(global.performance && global.performance.memory); }]
    ];
    var i, f;
    for (i = 0; i < list.length; i++) {
      f = list[i];
      (function (item) {
        guard('feat', item[0], item[1], function () {
          var r = item[3]();
          row('feat', item[0], item[1], r ? 'ok' : (item[2] ? 'fail' : 'info'), r ? 'disponible' : (item[2] ? 'NO disponible: el reproductor lo necesita' : 'no disponible'));
        });
      })(f);
    }
    cb();
  }

  /* ----------------------------------------------------------- C. códecs */
  function runCodecs(cb) {
    var v = doc.createElement('video');
    var list = [
      ['h264main31', 'H.264 Main 3.1 (producción)', 'video/mp4; codecs="avc1.4D401F"', true],
      ['h264main31aac', 'H.264 Main 3.1 + AAC-LC (producción)', 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', true],
      ['aac', 'AAC-LC', 'audio/mp4; codecs="mp4a.40.2"', false],
      ['h264base30', 'H.264 Baseline 3.0', 'video/mp4; codecs="avc1.42E01E"', false],
      ['h264high31', 'H.264 High 3.1', 'video/mp4; codecs="avc1.64001F"', false],
      ['h264high40', 'H.264 High 4.0', 'video/mp4; codecs="avc1.640028"', false],
      ['hevc', 'HEVC / H.265', 'video/mp4; codecs="hvc1.1.6.L93.B0"', false],
      ['vp9', 'VP9 (WebM)', 'video/webm; codecs="vp9"', false],
      ['av1', 'AV1', 'video/mp4; codecs="av01.0.05M.08"', false]
    ];
    var i;
    for (i = 0; i < list.length; i++) {
      (function (item) {
        guard('codec', item[0], item[1], function () {
          var r = v.canPlayType(item[2]);
          row('codec', item[0], item[1], r ? 'ok' : (item[3] ? 'fail' : 'info'), r ? 'canPlayType = "' + r + '"' : (item[3] ? 'canPlayType vacío: formato de producción NO soportado' : 'no soportado'));
        });
      })(list[i]);
    }
    guard('codec', 'mse', 'MediaSource.isTypeSupported (Main 3.1)', function () {
      var ms = global.MediaSource || global.WebKitMediaSource;
      if (!ms || !ms.isTypeSupported) { row('codec', 'mse', 'MediaSource.isTypeSupported (Main 3.1)', 'info', 'MediaSource no disponible'); return; }
      row('codec', 'mse', 'MediaSource.isTypeSupported (Main 3.1)', ms.isTypeSupported('video/mp4; codecs="avc1.4D401F, mp4a.40.2"') ? 'ok' : 'info', String(ms.isTypeSupported('video/mp4; codecs="avc1.4D401F, mp4a.40.2"')));
    });
    guard('codec', 'mcap', 'MediaCapabilities (720x1280, 30 fps, 1,5 Mbps)', function () {
      if (!nav.mediaCapabilities || !nav.mediaCapabilities.decodingInfo) { row('codec', 'mcap', 'MediaCapabilities (720x1280, 30 fps, 1,5 Mbps)', 'info', 'API no disponible'); return; }
      nav.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: 'video/mp4; codecs="avc1.4D401F"', width: 720, height: 1280, bitrate: 1500000, framerate: 30 } }).then(function (r) {
        row('codec', 'mcap', 'MediaCapabilities (720x1280, 30 fps, 1,5 Mbps)', r.supported ? 'ok' : 'warn', 'soportado=' + r.supported + ' fluido=' + r.smooth + ' eficiente=' + r.powerEfficient);
      }, function (e) { row('codec', 'mcap', 'MediaCapabilities (720x1280, 30 fps, 1,5 Mbps)', 'info', 'error: ' + e); });
    });
    cb();
  }

  /* -------------------------------------------- D. reproducción / autoplay */
  /* Reproduce un video real y mide tiempos de eventos, fotogramas y errores. */
  function probeVideo(url, opts, cb) {
    var v = doc.createElement('video');
    var res = { events: [], ms: {} };
    var t0 = now();
    var finished = false;
    var poll, killer, p, names, i;

    v.muted = !!opts.muted;
    if (opts.muted) { v.setAttribute('muted', ''); }
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';

    function stamp(name) { if (res.ms[name] === undefined) { res.ms[name] = now() - t0; } }

    function finish(ok, why) {
      var q;
      if (finished) { return; }
      finished = true;
      global.clearInterval(poll);
      global.clearTimeout(killer);
      res.ok = ok;
      res.why = why;
      res.width = v.videoWidth;
      res.height = v.videoHeight;
      res.duration = v.duration;
      res.currentTime = v.currentTime;
      res.errorCode = v.error ? v.error.code : null;
      try {
        if (v.getVideoPlaybackQuality) {
          q = v.getVideoPlaybackQuality();
          res.frames = q.totalVideoFrames;
          res.dropped = q.droppedVideoFrames;
        } else if (v.webkitDecodedFrameCount !== undefined) {
          res.frames = v.webkitDecodedFrameCount;
          res.dropped = v.webkitDroppedFrameCount;
        }
      } catch (e) { /* nada */ }
      try { v.pause(); } catch (e2) { /* nada */ }
      v.removeAttribute('src');
      try { v.load(); } catch (e3) { /* nada */ }
      if (v.parentNode) { v.parentNode.removeChild(v); }
      cb(res);
    }

    names = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'ended', 'error', 'stalled', 'waiting'];
    for (i = 0; i < names.length; i++) {
      (function (name) {
        util.on(v, name, function () {
          if (res.events.length < 60) { res.events.push(name); }
          stamp(name);
          if (name === 'error') { finish(false, 'error'); }
          if (name === 'ended' && opts.untilEnded) { finish(true, 'ended'); }
        });
      })(names[i]);
    }

    poll = global.setInterval(function () {
      if (finished) { return; }
      if (!opts.untilEnded && res.ms.playing !== undefined && v.currentTime > 0.4) { finish(true, 'playing'); return; }
      if (opts.onProgress) { opts.onProgress(v.currentTime, v.duration); }
    }, 400);
    killer = global.setTimeout(function () { finish(false, 'timeout'); }, opts.timeoutMs || 15000);

    $('videoBox').appendChild(v);
    v.src = url;
    try {
      p = v.play();
      if (p && typeof p.then === 'function') {
        p.then(function () { res.playPromise = 'resuelta'; stamp('playResolved'); }, function (e) {
          res.playPromise = 'rechazada';
          res.playError = e && e.name ? e.name : 'Error';
          finish(false, 'play-rejected');
        });
      } else {
        res.playPromise = 'play() no devuelve promesa (navegador antiguo)';
      }
    } catch (e4) {
      res.playPromise = 'excepción';
      res.playError = e4 && e4.name ? e4.name : 'Error';
      finish(false, 'play-throw');
    }
  }

  function describeProbe(r) {
    var parts = [];
    if (r.width) { parts.push('video ' + r.width + 'x' + r.height); }
    parts.push('metadata ' + fmtMs(r.ms.loadedmetadata) + ' · canplay ' + fmtMs(r.ms.canplay) + ' · playing ' + fmtMs(r.ms.playing));
    if (r.frames !== undefined) { parts.push('fotogramas ' + r.frames + ' (perdidos ' + r.dropped + ')'); }
    if (r.playPromise) { parts.push('play(): ' + r.playPromise + (r.playError ? ' (' + r.playError + ')' : '')); }
    if (r.errorCode) { parts.push('MediaError ' + r.errorCode); }
    return parts.join(' · ');
  }

  function runAutoplayAuto(cb) {
    var before = interacted;
    row('play', 'auto-muted', 'Autoplay en MUDO sin gesto', 'run', 'probando…');
    row('play', 'auto-sound', 'Autoplay CON SONIDO sin gesto', 'run', 'esperando…');
    global.setTimeout(function () {
      probeVideo(abs(ASSET) + '?a=' + now(), { muted: true, timeoutMs: 12000 }, function (r) {
        report.extras.autoplayMuted = { ok: r.ok, why: r.why, playError: r.playError || null, ms: r.ms };
        row('play', 'auto-muted', 'Autoplay en MUDO sin gesto' + (before ? ' (hubo interacción previa)' : ''), r.ok ? 'ok' : (r.playError === 'AbortError' ? 'warn' : 'fail'),
          r.ok ? describeProbe(r) : (r.playError === 'AbortError' ? 'play() ABORTADO (la página no estaba visible o se recargó): repita las pruebas con la página en primer plano. ' : 'NO arrancó (' + r.why + '): ') + (r.ok ? '' : describeProbe(r)));
        probeVideo(abs(ASSET) + '?b=' + now(), { muted: false, timeoutMs: 12000 }, function (r2) {
          var blocked = !r2.ok && r2.playError === 'NotAllowedError';
          report.extras.autoplaySound = { ok: r2.ok, blocked: blocked, playError: r2.playError || null };
          row('play', 'auto-sound', 'Autoplay CON SONIDO sin gesto' + (before ? ' (hubo interacción previa)' : ''), r2.ok ? 'info' : (blocked ? 'info' : 'warn'),
            r2.ok ? 'PERMITIDO (el reproductor igual arranca en mudo por diseño)' : (blocked ? 'bloqueado por el navegador (normal): el sonido requiere pulsar OK una vez' : 'falló (' + r2.why + '): ' + describeProbe(r2)));
          cb();
        });
      });
    }, 300);
  }

  function runPlaybackManual() {
    row('play', 'manual', 'Reproducción completa del video de prueba', 'run', 'reproduciendo (3 s)…');
    probeVideo(abs(ASSET) + '?m=' + now(), { muted: true, untilEnded: true, timeoutMs: 15000 }, function (r) {
      var dropRatio = r.frames ? r.dropped / r.frames : 0;
      report.extras.playback = { ok: r.ok, frames: r.frames, dropped: r.dropped, ms: r.ms };
      row('play', 'manual', 'Reproducción completa del video de prueba', r.ok ? (dropRatio > 0.1 ? 'warn' : 'ok') : 'fail', describeProbe(r) + (dropRatio > 0.1 ? ' · MUCHOS fotogramas perdidos' : ''));
      refreshReport();
    });
  }

  function runSoundManual() {
    row('play', 'sound', 'Prueba de sonido (con gesto)', 'run', 'reproduciendo con sonido…');
    probeVideo(abs(ASSET) + '?s=' + now(), { muted: false, untilEnded: true, timeoutMs: 15000 }, function (r) {
      if (!r.ok) {
        row('play', 'sound', 'Prueba de sonido (con gesto)', 'fail', 'no se pudo reproducir con sonido: ' + describeProbe(r));
        refreshReport();
        return;
      }
      row('play', 'sound', 'Prueba de sonido (con gesto)', 'run', 'reprodujo; ¿se oyó un tono?');
      $('soundAsk').style.display = 'inline';
    });
  }

  /* ------------------------------------------------------ E. rotación */
  var rot = { angles: [0, 90, 180, 270], idx: 0, open: false, verdict: {}, geo: {} };

  function layoutRot() {
    var vw = global.innerWidth;
    var vh = global.innerHeight;
    var deg = rot.angles[rot.idx];
    var g = SP.rotation.layout(vw, vh, deg, '9:16');
    var screenEl = $('rotScreen');
    var stage = $('rotStage');
    var rect, exp, okGeo;
    util.setStyle(screenEl, { width: g.logicalW + 'px', height: g.logicalH + 'px', left: g.left + 'px', top: g.top + 'px', fontSize: g.fontPx + 'px' });
    util.setTransform(screenEl, 'rotate(' + g.rotation + 'deg)');
    util.setStyle(stage, { width: g.stageW + 'px', height: g.stageH + 'px', left: g.stageLeft + 'px', top: g.stageTop + 'px' });
    rect = stage.getBoundingClientRect();
    exp = SP.rotation.physicalStageBox(vw, vh, deg, '9:16');
    okGeo = Math.abs(rect.left - exp.left) <= 3 && Math.abs(rect.top - exp.top) <= 3 && Math.abs(rect.width - exp.width) <= 3 && Math.abs(rect.height - exp.height) <= 3;
    rot.geo[deg] = okGeo;
    util.setText($('rotInfo'), 'Ángulo ' + deg + '° (útiles en esta pantalla: ' + SP.rotation.fitAngles(vw, vh).join('° y ') + '°) · geometría ' + (okGeo ? 'OK' : 'DIFIERE de lo esperado') + ' · ¿el ARRIBA del video coincide con el rótulo rojo ARRIBA? ' + (rot.verdict[deg] === 'ok' ? '[marcado: SÍ]' : (rot.verdict[deg] === 'fail' ? '[marcado: NO]' : '[sin responder]')));
    updateRotRows();
  }

  function updateRotRows() {
    var i, deg, geo, v, status, detail;
    for (i = 0; i < rot.angles.length; i++) {
      deg = rot.angles[i];
      geo = rot.geo[deg];
      v = rot.verdict[deg];
      if (geo === undefined && v === undefined) { continue; }
      status = (geo === false || v === 'fail') ? 'fail' : (v === 'ok' && geo ? 'ok' : 'warn');
      detail = 'geometría: ' + (geo === undefined ? 'sin probar' : (geo ? 'OK' : 'DIFIERE')) + ' · video girado igual que el texto: ' + (v === 'ok' ? 'SÍ' : (v === 'fail' ? 'NO (el plano de video no sigue la transformación CSS)' : 'sin responder'));
      row('rot', 'a' + deg, 'Rotación ' + deg + '°', status, detail);
    }
    report.extras.rotation = { geo: rot.geo, verdict: rot.verdict };
  }

  function openRot() {
    var v = $('rotVideo');
    rot.open = true;
    $('rot').style.display = 'block';
    v.muted = true;
    v.loop = true;
    v.src = abs(ASSET) + '?r=' + now();
    try { var p = v.play(); if (p && p.then) { p.then(null, function () { /* sin autoplay */ }); } } catch (e) { /* nada */ }
    layoutRot();
  }

  function closeRot() {
    var v = $('rotVideo');
    rot.open = false;
    $('rot').style.display = 'none';
    try { v.pause(); } catch (e) { /* nada */ }
    v.removeAttribute('src');
    try { v.load(); } catch (e2) { /* nada */ }
    refreshReport();
  }

  function rotKey(code) {
    if (code === 37) { rot.idx = (rot.idx + 3) % 4; layoutRot(); return true; }
    if (code === 39) { rot.idx = (rot.idx + 1) % 4; layoutRot(); return true; }
    if (code === 13) { rot.verdict[rot.angles[rot.idx]] = 'ok'; layoutRot(); return true; }
    if (code === 40) { rot.verdict[rot.angles[rot.idx]] = 'fail'; layoutRot(); return true; }
    if (code === 27 || code === 8 || code === 10009 || code === 461) { closeRot(); return true; }
    return false;
  }

  /* ------------------------------------------------- F. control remoto */
  var KEYNAMES = {
    13: 'OK / Enter', 37: 'Flecha izquierda', 38: 'Flecha arriba', 39: 'Flecha derecha', 40: 'Flecha abajo',
    27: 'Esc', 8: 'Retroceso', 461: 'Atrás (webOS)', 10009: 'Atrás (Tizen)', 415: 'Play', 19: 'Pausa', 413: 'Stop',
    417: 'Avance rápido', 412: 'Retroceso rápido', 10252: 'Play/Pausa (Tizen)', 403: 'Rojo', 404: 'Verde', 405: 'Amarillo', 406: 'Azul',
    179: 'Play/Pausa (Android)', 176: 'Siguiente (Android)', 177: 'Anterior (Android)', 178: 'Stop (Android)', 32: 'Espacio'
  };
  var EXPECTED = [
    ['ok', 'OK / Enter', [13]], ['left', 'Izquierda', [37]], ['right', 'Derecha', [39]], ['up', 'Arriba', [38]], ['down', 'Abajo', [40]],
    ['back', 'Atrás', [10009, 461, 27, 8]], ['play', 'Play', [415]], ['pause', 'Pausa', [19]], ['stop', 'Stop', [413]],
    ['ff', 'Avance rápido', [417]], ['rw', 'Retroceso rápido', [412]],
    ['red', 'Rojo', [403]], ['green', 'Verde', [404]], ['yellow', 'Amarillo', [405]], ['blue', 'Azul', [406]]
  ];
  var seenKeys = {};
  var pointer = { mouse: false, click: false, wheel: false, touch: false };

  function initKeys() {
    var i;
    for (i = 0; i < EXPECTED.length; i++) {
      row('keys', EXPECTED[i][0], 'Tecla: ' + EXPECTED[i][1], 'run', 'pendiente (códigos esperados: ' + EXPECTED[i][2].join(', ') + ')');
    }
    row('keys', 'pointer', 'Puntero / ratón / táctil', 'run', 'mueva el puntero o toque la pantalla');
    util.on(doc, 'keydown', onKeyDown);
    util.on(doc, 'mousemove', function () { notePointer('mouse'); });
    util.on(doc, 'click', function () { interacted = true; notePointer('click'); });
    util.on(doc, 'wheel', function () { notePointer('wheel'); });
    util.on(doc, 'touchstart', function () { interacted = true; notePointer('touch'); });
  }

  function notePointer(kind) {
    var names;
    if (pointer[kind]) { return; }
    pointer[kind] = true;
    names = [];
    if (pointer.mouse) { names.push('movimiento'); }
    if (pointer.click) { names.push('clic'); }
    if (pointer.wheel) { names.push('rueda'); }
    if (pointer.touch) { names.push('toque'); }
    row('keys', 'pointer', 'Puntero / ratón / táctil', 'ok', 'detectado: ' + names.join(', '));
    report.extras.pointer = pointer;
  }

  function onKeyDown(e) {
    var code = e.keyCode || e.which;
    var i, j, hit, key;
    interacted = true;
    util.setText($('keyLast'), 'keyCode=' + code + '  key="' + (e.key === undefined ? '' : e.key) + '"  code="' + (e.code === undefined ? '' : e.code) + '"  which=' + e.which + '  repeat=' + (e.repeat ? 'sí' : 'no'));
    if (rot.open && rotKey(code)) {
      if (e.preventDefault) { e.preventDefault(); }
      return;
    }
    key = String(code);
    seenKeys[key] = (seenKeys[key] || 0) + 1;
    hit = false;
    for (i = 0; i < EXPECTED.length; i++) {
      for (j = 0; j < EXPECTED[i][2].length; j++) {
        if (EXPECTED[i][2][j] === code) {
          row('keys', EXPECTED[i][0], 'Tecla: ' + EXPECTED[i][1], 'ok', 'detectada (keyCode ' + code + ', key "' + (e.key === undefined ? '' : e.key) + '")');
          hit = true;
        }
      }
    }
    if (!hit) {
      row('keys', 'k' + code, 'Otra tecla: keyCode ' + code, 'info', (KEYNAMES[code] ? KEYNAMES[code] + ' · ' : '') + 'key "' + (e.key === undefined ? '' : e.key) + '" code "' + (e.code === undefined ? '' : e.code) + '"');
    }
    report.extras.keysSeen = seenKeys;
  }

  /* ---------------------------------------------- G. red, almacenamiento y caché */
  function runNetwork(cb) {
    var times = [];
    var url = abs('diagnostico.html');
    var i = 0;

    row('net', 'online', 'navigator.onLine', nav.onLine === false ? 'fail' : 'ok', String(nav.onLine));
    if (nav.connection) {
      row('net', 'conn', 'navigator.connection', 'info', 'tipo ' + (nav.connection.effectiveType || 'n/d') + ' · downlink ' + (nav.connection.downlink || 'n/d') + ' Mbps · rtt ' + (nav.connection.rtt || 'n/d') + ' ms');
    }
    row('net', 'rtt', 'Latencia al servidor (5 HEAD)', 'run', 'midiendo…');

    function nextRtt() {
      if (i >= 5) {
        times.sort(function (a, b) { return a - b; });
        row('net', 'rtt', 'Latencia al servidor (5 HEAD)', times.length ? 'ok' : 'fail', times.length ? 'mín ' + times[0] + ' ms · mediana ' + times[Math.floor(times.length / 2)] + ' ms · máx ' + times[times.length - 1] + ' ms' : 'sin respuesta');
        speed();
        return;
      }
      i++;
      xhr('HEAD', util.addQuery(url, '_', now() + '.' + i), { timeoutMs: 8000 }, function (err, res) {
        if (!err) { times.push(res.ms); }
        nextRtt();
      });
    }

    function speed() {
      row('net', 'speed', 'Velocidad de descarga (3 MB)', 'run', 'midiendo…');
      xhr('GET', abs('__speed?bytes=3000000&_=' + now()), { binary: true, timeoutMs: 30000 }, function (err, res) {
        var mbps;
        if (err) {
          row('net', 'speed', 'Velocidad de descarga (3 MB)', 'info', 'no medible aquí (' + err.message + '): requiere el servidor LAN');
          ping();
          return;
        }
        mbps = (res.bytes * 8) / (res.ms / 1000) / 1000000;
        report.extras.downloadMbps = Math.round(mbps * 10) / 10;
        row('net', 'speed', 'Velocidad de descarga (3 MB)', mbps >= 4.5 ? 'ok' : 'warn', mbps.toFixed(1) + ' Mbps (' + res.ms + ' ms). Un video de 1,5 Mbps necesita al menos ~4,5 Mbps de margen.');
        ping();
      });
    }

    function ping() {
      xhr('GET', abs('__ping?_=' + now()), { timeoutMs: 5000 }, function (err) {
        hasLanServer = !err;
        row('net', 'lan', 'Servidor de pruebas LAN', hasLanServer ? 'ok' : 'info', hasLanServer ? 'detectado: la prueba de caché usará contadores del servidor' : 'no detectado (alojamiento estático): la prueba de caché solo mostrará tiempos');
        cb();
      });
    }

    nextRtt();
  }

  function runStorage(cb) {
    guard('store', 'sw', 'Service Worker', function () {
      var has = !!nav.serviceWorker;
      row('store', 'sw', 'Service Worker', has && global.isSecureContext ? 'ok' : 'info', has ? (global.isSecureContext ? 'disponible' : 'API presente pero requiere HTTPS: no probable por HTTP en la LAN') : 'no disponible');
    });
    guard('store', 'cacheapi', 'Cache API', function () {
      var c;
      if (!global.caches) { row('store', 'cacheapi', 'Cache API', 'info', 'no disponible' + (global.isSecureContext ? '' : ' (requiere HTTPS)')); return; }
      global.caches.open('sp-diag').then(function (cache) {
        c = cache;
        return c.put('/sp-diag-test', new global.Response('x'));
      }).then(function () { return c.match('/sp-diag-test'); }).then(function (m) {
        row('store', 'cacheapi', 'Cache API (escribir y leer)', m ? 'ok' : 'warn', m ? 'funciona' : 'no devolvió lo guardado');
        return global.caches.delete('sp-diag');
      }).then(null, function (e) { row('store', 'cacheapi', 'Cache API', 'warn', 'error: ' + (e && e.message ? e.message : e)); });
    });
    guard('store', 'idb', 'IndexedDB', function () { row('store', 'idb', 'IndexedDB', 'info', global.indexedDB ? 'disponible' : 'no disponible'); });
    guard('store', 'quota', 'Cuota de almacenamiento', function () {
      if (!nav.storage || !nav.storage.estimate) { row('store', 'quota', 'Cuota de almacenamiento', 'info', 'navigator.storage.estimate no disponible'); return; }
      nav.storage.estimate().then(function (e) {
        report.extras.storageEstimate = { quota: e.quota, usage: e.usage };
        row('store', 'quota', 'Cuota de almacenamiento', 'info', 'cuota ' + Math.round((e.quota || 0) / 1048576) + ' MB · en uso ' + Math.round((e.usage || 0) / 1048576) + ' MB');
      }, function () { row('store', 'quota', 'Cuota de almacenamiento', 'info', 'no disponible'); });
    });
    cb();
  }

  function serverStats(rel, cb) {
    var path = pathOf(rel);
    xhr('GET', abs('__stats?path=' + encodeURIComponent(path) + '&_=' + now()), { timeoutMs: 6000 }, function (err, res) {
      var d;
      if (err) { cb(null); return; }
      try { d = JSON.parse(res.text); } catch (e) { d = null; }
      cb(d);
    });
  }

  /* Veredicto de la prueba de caché. Función pura (se prueba con casos sintéticos).
   * info.pass1/pass2.bytes = bytes que el servidor entregó en cada pasada (null si no hay contadores);
   * r1/r2 = resultado de reproducir cada pasada (ok, why, ms). */
  function judgeCache(info, r1, r2) {
    var b1 = info.pass1.bytes;
    var b2 = info.pass2.bytes;
    if (!r1.ok || !r2.ok) {
      return { status: 'fail', verdict: 'no se pudo reproducir el video (' + (r1.ok ? 'pasada 2' : 'pasada 1') + ': ' + (r1.ok ? r2.why : r1.why) + ')' };
    }
    if (b1 === null || b2 === null) {
      return { status: 'info', verdict: 'sin contadores del servidor. Tiempos hasta canplay: pasada 1 = ' + fmtMs(r1.ms.canplay) + ', pasada 2 = ' + fmtMs(r2.ms.canplay) + ' (mucho menor en la 2ª suele indicar caché).' };
    }
    if (b2 === 0) {
      return { status: 'ok', verdict: 'CACHEADO: en la 2ª pasada la TV no pidió nada al servidor (pasada 1: ' + Math.round(b1 / 1024) + ' KB).' };
    }
    if (b2 < b1 * 0.2) {
      return { status: 'warn', verdict: 'CACHE PARCIAL: 2ª pasada pidió ' + Math.round(b2 / 1024) + ' KB de ' + Math.round(b1 / 1024) + ' KB.' };
    }
    return { status: 'fail', verdict: 'NO CACHEA: la 2ª pasada volvió a descargar ' + Math.round(b2 / 1024) + ' KB (pasada 1: ' + Math.round(b1 / 1024) + ' KB). Con 20 TV el consumo de GitHub Pages sería inviable.' };
  }

  function runCacheTest(key) {
    var rel = CACHE_FILES[key];
    var label = 'Caché HTTP de video (' + key + ' MB)';
    var url = rel + '?run=' + now();
    var info = { size: key, pass1: {}, pass2: {} };
    row('cache', 'test' + key, label, 'run', 'comprobando que el archivo existe…');
    lastCacheUrl = abs(url);

    xhr('HEAD', abs(url), { timeoutMs: 8000 }, function (err) {
      if (err) {
        row('cache', 'test' + key, label, 'fail', 'el archivo no está disponible aquí (' + err.message + '). Ejecute esta prueba contra el servidor LAN: npm run lan');
        return;
      }
      serverStats(rel, function (s0) {
        runPass(1, s0, function (s1, r1) {
          info.pass1 = { ms: r1.ms, ok: r1.ok, bytes: s1 && s0 ? s1.bytes - s0.bytes : null, hits: s1 && s0 ? s1.hits - s0.hits : null };
          global.setTimeout(function () {
            runPass(2, s1, function (s2, r2) {
              var judged;
              info.pass2 = { ms: r2.ms, ok: r2.ok, bytes: s2 && s1 ? s2.bytes - s1.bytes : null, hits: s2 && s1 ? s2.hits - s1.hits : null };
              judged = judgeCache(info, r1, r2);
              var status = judged.status;
              var verdict = judged.verdict;
              info.verdict = verdict;
              report.extras['cache' + key] = info;
              row('cache', 'test' + key, label, status, verdict);
              refreshReport();
            });
          }, 1500);
        });
      });
    });

    function runPass(n, before, next) {
      row('cache', 'test' + key, label, 'run', 'pasada ' + n + ' de 2…');
      probeVideo(abs(url), {
        muted: true,
        untilEnded: true,
        timeoutMs: (key === '20' ? 60 : 15) * 3000 + 30000,
        onProgress: function (t, d) { row('cache', 'test' + key, label, 'run', 'pasada ' + n + ' de 2: ' + Math.round(t) + '/' + Math.round(d || 0) + ' s'); }
      }, function (r) {
        serverStats(rel, function (after) { next(after, r); });
      });
    }
  }

  function runCacheReplay() {
    if (!lastCacheUrl) {
      row('cache', 'replay', 'Reproducción con el servidor caído', 'warn', 'primero ejecute una prueba de caché (3 MB o 20 MB)');
      return;
    }
    row('cache', 'replay', 'Reproducción con el servidor caído', 'run', 'reproduciendo…');
    probeVideo(lastCacheUrl, { muted: true, timeoutMs: 20000 }, function (r) {
      report.extras.replay = { ok: r.ok, why: r.why, ms: r.ms };
      row('cache', 'replay', 'Reproducción con el servidor caído', r.ok ? 'ok' : 'fail',
        r.ok ? 'REPRODUJO sin servidor: el video salió del caché de la TV. La reproducción sin conexión es posible para lo ya visto. (' + describeProbe(r) + ')' : 'NO reprodujo (' + r.why + '): la TV no conserva el video sin servidor. ' + describeProbe(r));
      refreshReport();
    });
  }

  /* --------------------------------------------------------------- informe */
  function counts() {
    var c = { ok: 0, fail: 0, warn: 0 };
    var sec, key, st;
    for (sec in report.sections) {
      if (!Object.prototype.hasOwnProperty.call(report.sections, sec)) { continue; }
      for (key in report.sections[sec]) {
        if (!Object.prototype.hasOwnProperty.call(report.sections[sec], key)) { continue; }
        st = report.sections[sec][key].status;
        if (c[st] !== undefined) { c[st]++; }
      }
    }
    return c;
  }

  function refreshReport() {
    var c = counts();
    var ex = report.extras;
    var parts = [];
    var f = report.sections.codec && report.sections.codec.h264main31aac;
    parts.push((ex.platform || '?') + (ex.chromeVersion ? ' · Chromium ' + ex.chromeVersion : ''));
    parts.push(c.ok + ' OK / ' + c.fail + ' fallas / ' + c.warn + ' avisos');
    if (f) { parts.push('H.264 Main 3.1+AAC: ' + f.status); }
    if (ex.autoplayMuted) { parts.push('autoplay mudo: ' + (ex.autoplayMuted.ok ? 'sí' : 'NO')); }
    if (ex.cache3) { parts.push('caché 3 MB: ' + ex.cache3.verdict); }
    if (ex.cache20) { parts.push('caché 20 MB: ' + ex.cache20.verdict); }
    report.summary = parts.join(' | ');
    report.generatedAt = new Date().toISOString();
    util.setText($('reportText'), report.summary + '\n\n' + JSON.stringify(report.sections, null, 1).slice(0, 2500) + '\n…');
    return report.summary;
  }

  function sendReport() {
    var out = $('sendResult');
    refreshReport();
    util.setText(out, 'enviando…');
    xhr('POST', abs('__report'), { json: true, body: JSON.stringify(report), timeoutMs: 10000 }, function (err, res) {
      var d;
      if (err) { util.setText(out, 'No se pudo enviar (' + err.message + '). ¿Está abierto el servidor LAN? (npm run lan)'); out.className = 'fail'; return; }
      try { d = JSON.parse(res.text); } catch (e) { d = {}; }
      util.setText(out, 'Enviado: dev/reports/' + (d.file || ''));
      out.className = 'ok';
    });
  }

  /* ------------------------------------------------------------- arranque */
  function series(fns, done) {
    var i = 0;
    function next() {
      if (i >= fns.length) { if (done) { done(); } return; }
      var fn = fns[i++];
      try { fn(next); } catch (e) { row('ident', 'err' + i, 'Error interno', 'fail', String(e && e.message || e)); next(); }
    }
    next();
  }

  function runAll() {
    $('sendResult').innerHTML = '';
    series([runIdentification, runFeatures, runCodecs, runStorage, runNetwork, runAutoplayAuto], function () {
      refreshReport();
    });
  }

  function init() {
    section('ident', 'A. Identificación');
    section('feat', 'B. Capacidades del navegador');
    section('codec', 'C. Códecs de video y audio');
    section('play', 'D. Reproducción y autoplay');
    section('rot', 'E. Rotación de pantalla con video');
    section('keys', 'F. Control remoto y puntero');
    section('net', 'G. Red');
    section('store', 'H. Almacenamiento, Service Worker y Cache API');
    section('cache', 'I. Caché HTTP de video');

    initKeys();
    util.on($('btnAll'), 'click', runAll);
    util.on($('btnSend'), 'click', sendReport);
    util.on($('btnPlay'), 'click', runPlaybackManual);
    util.on($('btnSound'), 'click', runSoundManual);
    util.on($('soundYes'), 'click', function () { $('soundAsk').style.display = 'none'; row('play', 'sound', 'Prueba de sonido (con gesto)', 'ok', 'el usuario confirmó que se oyó el tono'); refreshReport(); });
    util.on($('soundNo'), 'click', function () { $('soundAsk').style.display = 'none'; row('play', 'sound', 'Prueba de sonido (con gesto)', 'fail', 'reprodujo pero NO se oyó (revise volumen/silencio de la TV)'); refreshReport(); });
    util.on($('btnRot'), 'click', openRot);
    util.on($('rotPrev'), 'click', function () { rotKey(37); });
    util.on($('rotNext'), 'click', function () { rotKey(39); });
    util.on($('rotYes'), 'click', function () { rotKey(13); });
    util.on($('rotNo'), 'click', function () { rotKey(40); });
    util.on($('rotClose'), 'click', closeRot);
    util.on(global, 'resize', function () { if (rot.open) { layoutRot(); } });
    util.on($('btnCache3'), 'click', function () { runCacheTest('3'); });
    util.on($('btnCache20'), 'click', function () { runCacheTest('20'); });
    util.on($('btnReplay'), 'click', runCacheReplay);

    runAll();
  }

  SP.diag = { report: report, refreshReport: refreshReport, probeVideo: probeVideo, runCacheTest: runCacheTest, sendReport: sendReport, judgeCache: judgeCache };

  if (doc.readyState === 'loading') { util.on(doc, 'DOMContentLoaded', init); } else { init(); }
})(window);
