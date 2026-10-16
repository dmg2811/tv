/* Geometría de la pantalla: rotación del reproductor completo + "escenario" 9:16.
 *
 * Las IMÁGENES se dibujan en un escenario 9:16 que gira con CSS: para 90/270 se intercambian ancho y alto
 * lógicos para que, una vez girado, ocupe exactamente la pantalla física sin recortes.
 * Los VIDEOS no giran con CSS (el plano de video por hardware de muchas Smart TV ignora el giro y estira el cuadro):
 * en 90/270 se reproduce un archivo YA GIRADO de 1280x720 dentro de una caja 16:9 sin transformación (`fillBox`).
 * Todo se calcula en píxeles a partir del tamaño de la ventana (no vw/vh). */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};

  function even(n) {
    return Math.max(2, Math.floor(n / 2) * 2);
  }

  SP.rotation = {
    ANGLES: [0, 90, 180, 270],

    /* Cualquier entrada -> 0 | 90 | 180 | 270 (múltiplos de 90, módulo 360). */
    normalize: function (value) {
      var n = parseInt(value, 10);
      if (!isFinite(n)) { return 0; }
      n = Math.round(n / 90) * 90;
      n = ((n % 360) + 360) % 360;
      return n;
    },

    next: function (deg) {
      return (SP.rotation.normalize(deg) + 90) % 360;
    },

    /* Una pantalla horizontal (ancho >= alto) solo aprovecha el escenario 9:16 con 270 o 90; una vertical,
     * con 0 o 180. Los otros dos ángulos dejan una franja del 32 % de la pantalla: son válidos por URL,
     * pero nunca se ofrecen al alternar con el botón GIRAR 180°. El primero es el predeterminado. */
    fitAngles: function (vw, vh) {
      return vw >= vh ? [270, 90] : [0, 180];
    },

    /* Rotación cuando nadie ha configurado nada: el giro que ya aprovecha toda la pantalla.
     * TV horizontal montada en vertical -> 270. Si la propia TV ya gira la imagen (navegador vertical) -> 0. */
    defaultFor: function (vw, vh) {
      return vw >= vh ? 270 : 0;
    },

    /* Reproductores anteriores que, sin nada guardado, mostraban la pantalla HORIZONTAL a 90° (ángulo automático). Solo uno: 5a1978f0ad (14-oct).
     * El primero (771d75ffd4) mostraba 0°; los de prueba (2fe066e704, 2fc733c499, ca3aa9cf36) no reproducían la programación. */
    LEGACY_AUTO90_BUILDS: ['5a1978f0ad'],

    /* Ángulo (90) que ESTA TV mostraba con el reproductor anterior sin haber guardado ninguna preferencia, o null si no hay PRUEBA de ello.
     * Solo se llama en la primera ejecución de este reproductor en la TV, cuando no hay preferencia guardada ni ?rotate=.
     *   saved    lo que el reproductor anterior dejó en 'lastPlaylist' ({ url, raw }); raw.playerBuild = build que anunciaba el último manifiesto que aplicó.
     *   ownBuild el build de ESTE reproductor (SP_BUILD).
     *   viaBuild el parámetro `_b` de la URL: los reproductores anteriores en marcha, al aplicar un manifiesto que anuncia otro build, lo guardan en
     *            'lastPlaylist' y recargan la página con ?_b=<build nuevo>.
     * Hay prueba en dos casos y solo con pantalla horizontal (ahí el automático anterior era 90°; en una vertical era 0°, igual que el predeterminado actual):
     *   (1) DATO GUARDADO: el último manifiesto aplicado anunciaba un build de LEGACY_AUTO90_BUILDS (TV que se reinició y ya no tiene el reproductor en marcha).
     *   (2) ACTUALIZACIÓN AUTOMÁTICA: lo que hay guardado anuncia ESTE build y la URL trae _b=<este build>: me cargó un reproductor anterior con motor en marcha, que
     *       acababa de sobrescribir 'lastPlaylist' con el manifiesto nuevo (la prueba (1) ya no existe). Desde el 14-oct 10:23 el único reproductor anterior con motor
     *       que puede seguir en marcha es 5a1978f0ad: el 771d75ffd4 pasa a 5a1978f0ad en su primer sondeo (el manifiesto v0.6 anuncia ese build).
     * Cualquier otra cosa (sin datos, datos raros, otro build, sin _b) → null: no se supone nada. */
    inheritedAngle: function (vw, vh, saved, ownBuild, viaBuild) {
      var raw, build, i, list;
      if (!(typeof vw === 'number' && typeof vh === 'number' && vw >= vh)) { return null; }
      raw = saved && typeof saved === 'object' ? saved.raw : null;
      if (!raw || typeof raw !== 'object') { return null; }
      build = raw.playerBuild;
      if (typeof build !== 'string' || build === '') { return null; }
      list = SP.rotation.LEGACY_AUTO90_BUILDS;
      for (i = 0; i < list.length; i++) {
        if (list[i] === build) { return 90; }
      }
      if (typeof ownBuild === 'string' && ownBuild !== '' && build === ownBuild && viaBuild === ownBuild) { return 90; }
      return null;
    },

    /* ¿Con este giro los videos usan el archivo YA GIRADO (sin giro CSS)? Solo con 90 y 270. */
    usesPreRotated: function (deg) {
      var d = SP.rotation.normalize(deg);
      return d === 90 || d === 270;
    },

    /* Siguiente ángulo "útil" para el botón GIRAR 180°: alterna entre los dos que llenan la pantalla.
     * Si el actual no es uno de ellos (p. ej. 0 por URL en una pantalla horizontal), salta al primero. */
    nextFit: function (deg, vw, vh) {
      var fit = SP.rotation.fitAngles(vw, vh);
      var d = SP.rotation.normalize(deg);
      if (d === fit[0]) { return fit[1]; }
      if (d === fit[1]) { return fit[0]; }
      return fit[0];
    },

    /* "9:16" | "9/16" | 0.5625 -> número (ancho/alto). Valor inválido -> 9/16. */
    parseAspect: function (value) {
      var m, a;
      if (typeof value === 'number' && value > 0.1 && value < 10) { return value; }
      m = /^\s*(\d+(?:\.\d+)?)\s*[:\/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value || ''));
      if (m) {
        a = parseFloat(m[1]) / parseFloat(m[2]);
        if (a > 0.1 && a < 10) { return a; }
      }
      return 9 / 16;
    },

    /* vw, vh: tamaño de la ventana física en px. deg: rotación. aspect: ancho/alto del escenario.
     * Devuelve las medidas del contenedor lógico (girado alrededor de su centro) y del escenario. */
    layout: function (vw, vh, deg, aspect) {
      var rot = SP.rotation.normalize(deg);
      var a = SP.rotation.parseAspect(aspect);
      var swap = rot === 90 || rot === 270;
      var lw = even(swap ? vh : vw);
      var lh = even(swap ? vw : vh);
      var sw, sh;

      /* Escenario: el mayor rectángulo de proporción `a` que cabe en el contenedor lógico. */
      sh = lh;
      sw = sh * a;
      if (sw > lw) {
        sw = lw;
        sh = sw / a;
      }
      sw = even(sw);
      sh = even(sh);
      /* El redondeo a par puede dejar 1-3 px sin cubrir (p. ej. 1366x768 -> 1364x768): se ajusta al borde,
       * una deformación de menos de 0,3 % que no se aprecia y evita las franjas negras. */
      if (lh - sh >= 0 && lh - sh <= 3) { sh = lh; }
      if (lw - sw >= 0 && lw - sw <= 3) { sw = lw; }

      return {
        rotation: rot,
        logicalW: lw,
        logicalH: lh,
        left: Math.round((vw - lw) / 2),
        top: Math.round((vh - lh) / 2),
        stageW: sw,
        stageH: sh,
        stageLeft: Math.round((lw - sw) / 2),
        stageTop: Math.round((lh - sh) / 2),
        /* tamaño de letra base: legible a distancia de TV, proporcional al lado corto */
        fontPx: Math.max(14, Math.round(Math.min(lw, lh) / 38))
      };
    },

    /* Mayor rectángulo de proporción `aspect` (por defecto 16:9) que cabe en la ventana, centrado y en píxeles.
     * Sirve para videos YA GIRADOS (archivo horizontal): se dibujan sin rotación CSS ocupando toda la pantalla,
     * y como la caja ya tiene la proporción exacta del archivo, no se estira aunque la TV ignore object-fit. */
    fillBox: function (vw, vh, aspect) {
      var a = SP.rotation.parseAspect(aspect === undefined ? 16 / 9 : aspect);
      var w = vw;
      var h = vw / a;
      if (h > vh) {
        h = vh;
        w = vh * a;
      }
      w = Math.floor(w);
      h = Math.floor(h);
      if (vw - w <= 3) { w = vw; }
      if (vh - h <= 3) { h = vh; }
      return { left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2), width: w, height: h };
    },

    /* Caja (en px, respecto a la ventana física) que ocupa el escenario una vez girado.
     * Sirve para comprobar que nada queda fuera de pantalla. */
    physicalStageBox: function (vw, vh, deg, aspect) {
      var l = SP.rotation.layout(vw, vh, deg, aspect);
      var swap = l.rotation === 90 || l.rotation === 270;
      var w = swap ? l.stageH : l.stageW;
      var h = swap ? l.stageW : l.stageH;
      return {
        left: Math.round((vw - w) / 2),
        top: Math.round((vh - h) / 2),
        width: w,
        height: h
      };
    }
  };
})(window);
