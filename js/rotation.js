/* Geometría de la pantalla: rotación del reproductor completo + "escenario" 9:16.
 *
 * Idea: el contenido SIEMPRE se dibuja en un escenario 9:16 (los archivos ya vienen
 * normalizados a 9:16 con barras negras), así no se depende de object-fit.
 * La rotación gira el contenedor entero; para 90/270 se intercambian ancho y alto
 * lógicos para que, una vez girado, ocupe exactamente la pantalla física sin recortes.
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

    /* Una pantalla horizontal (ancho >= alto) solo aprovecha el escenario 9:16 con 90 o 270; una vertical,
     * con 0 o 180. Los otros dos ángulos dejan una franja del 32 % de la pantalla: son válidos por URL,
     * pero nunca se ofrecen al alternar con el botón ROTAR. */
    fitAngles: function (vw, vh) {
      return vw >= vh ? [90, 270] : [0, 180];
    },

    /* Rotación cuando nadie ha configurado nada: el giro que ya aprovecha toda la pantalla.
     * TV horizontal montada en vertical -> 90. Si la propia TV ya gira la imagen (navegador vertical) -> 0. */
    defaultFor: function (vw, vh) {
      return vw >= vh ? 90 : 0;
    },

    /* Siguiente ángulo "útil" para el botón ROTAR: alterna entre los dos que llenan la pantalla.
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
