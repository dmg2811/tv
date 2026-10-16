/* Validación y normalización del manifiesto playlist.json.
 *
 * Esquema (schemaVersion 1):
 *   { schemaVersion:1, epoch:0, version:12, publishedAt:"ISO", playerBuild:"abc123",
 *     mediaBase:"media/",                         // relativa al manifiesto, o URL absoluta (otro alojamiento)
 *     settings:{ defaultImageSeconds:10, pollSeconds:60, rotation:0, stageAspect:"9:16",
 *                fallback:{ url:"respaldo.jpg", durationSec:5 } },
 *     items:[ { id, type:"image"|"video", url, durationSec?, order?, status?:"active",
 *              size?, fallback?:{ url, durationSec? },
 *              variants?:{ r270:{ url, size? }, r90:{ url, size? } } } ] }
 *
 * `variants` (solo videos): las dos versiones YA GIRADAS (1280x720) para TV horizontales montadas en vertical. Un reproductor
 * antiguo las ignora y sigue usando `url`. Un video puede traer solo una; la otra se tratará como ausente.
 *
 * Reglas: (epoch, version) decide qué manifiesto es más nuevo. Un manifiesto inválido se
 * rechaza entero; un elemento inválido se descarta y se informa, el resto sigue. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;
  var SUPPORTED_SCHEMA = 1;

  function isInt(v) {
    return util.isNumber(v) && Math.floor(v) === v;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  /* mediaBase relativo se resuelve contra la URL del manifiesto; la URL de cada medio contra mediaBase. */
  function mediaUrl(playlistAbs, mediaBase, url) {
    var base;
    if (util.isAbsoluteUrl(url)) { return util.resolveUrl(playlistAbs, url); }
    base = mediaBase ? util.resolveUrl(playlistAbs, mediaBase) : playlistAbs;
    if (mediaBase && base.charAt(base.length - 1) !== '/') { base += '/'; }
    return util.resolveUrl(base, url);
  }

  function normalizeFallback(raw, playlistAbs, mediaBase, defaultSec) {
    var sec;
    if (!raw || typeof raw !== 'object' || !str(raw.url)) { return null; }
    sec = util.isNumber(raw.durationSec) ? raw.durationSec : defaultSec;
    return {
      url: mediaUrl(playlistAbs, mediaBase, raw.url),
      durationSec: util.clamp(sec, 1, 3600)
    };
  }

  /* variants del manifiesto -> { 270:{url,size}, 90:{url,size} } o null si no hay ninguna válida. */
  function normalizeVariants(raw, playlistAbs, mediaBase, id, warnings) {
    var out = {};
    var any = false;
    var keys = ['r270', 'r90'];
    var i, v, url;
    if (raw === undefined || raw === null) { return null; }
    if (typeof raw !== 'object' || util.isArray(raw)) {
      warnings.push(id + ': variants no es un objeto (se ignora)');
      return null;
    }
    for (i = 0; i < keys.length; i++) {
      v = raw[keys[i]];
      if (v === undefined || v === null) { continue; }
      url = typeof v === 'string' ? v : str(v.url);
      if (!url) {
        warnings.push(id + ': variante ' + keys[i] + ' sin url (se ignora)');
        continue;
      }
      out[keys[i].substring(1)] = {
        url: mediaUrl(playlistAbs, mediaBase, url),
        size: typeof v === 'object' && util.isNumber(v.size) && v.size > 0 ? v.size : null
      };
      any = true;
    }
    return any ? out : null;
  }

  SP.playlist = {
    SUPPORTED_SCHEMA: SUPPORTED_SCHEMA,

    /* raw: objeto ya parseado. playlistAbs: URL absoluta de donde se descargó.
     * Devuelve { ok:true, playlist, warnings:[] } o { ok:false, error }. */
    normalize: function (raw, playlistAbs, defaults) {
      var warnings = [];
      var settings, mediaBase, defaultSec, items, seen, out, i, it, id, type, url, dur, order, entry, fallbackDefault;

      defaults = defaults || {};
      if (!raw || typeof raw !== 'object' || util.isArray(raw)) {
        return { ok: false, error: 'el manifiesto no es un objeto' };
      }
      if (raw.schemaVersion !== undefined && (!isInt(raw.schemaVersion) || raw.schemaVersion > SUPPORTED_SCHEMA)) {
        return { ok: false, error: 'schemaVersion no soportado: ' + raw.schemaVersion };
      }
      if (!isInt(raw.version) || raw.version < 0) {
        return { ok: false, error: 'version inválida' };
      }
      if (!util.isArray(raw.items)) {
        return { ok: false, error: 'items no es una lista' };
      }

      settings = (raw.settings && typeof raw.settings === 'object') ? raw.settings : {};
      mediaBase = str(raw.mediaBase);
      defaultSec = util.isNumber(settings.defaultImageSeconds) ? settings.defaultImageSeconds : (defaults.imageSec || 10);
      defaultSec = util.clamp(defaultSec, 1, 3600);
      fallbackDefault = normalizeFallback(settings.fallback, playlistAbs, mediaBase, 5);

      seen = {};
      out = [];
      items = raw.items;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (!it || typeof it !== 'object') { warnings.push('item ' + i + ': no es un objeto'); continue; }
        if (it.status !== undefined && it.status !== 'active') { continue; } /* oculto/retirado: no se reproduce */
        id = str(it.id) || ('item-' + i);
        type = str(it.type);
        url = str(it.url);
        if (type !== 'image' && type !== 'video') { warnings.push(id + ': tipo desconocido "' + type + '"'); continue; }
        if (!url) { warnings.push(id + ': sin url'); continue; }
        if (seen[id]) { warnings.push(id + ': id duplicado'); continue; }
        seen[id] = true;

        dur = null;
        if (type === 'image') {
          dur = util.clamp(util.isNumber(it.durationSec) ? it.durationSec : defaultSec, 1, 3600);
        }
        order = util.isNumber(it.order) ? it.order : i;
        entry = {
          id: id,
          type: type,
          url: mediaUrl(playlistAbs, mediaBase, url),
          durationSec: dur,
          order: order,
          pos: i,
          size: util.isNumber(it.size) && it.size > 0 ? it.size : null,
          fallback: type === 'video' ? (normalizeFallback(it.fallback, playlistAbs, mediaBase, 5) || fallbackDefault) : null,
          variants: type === 'video' ? normalizeVariants(it.variants, playlistAbs, mediaBase, id, warnings) : null
        };
        out.push(entry);
      }

      out.sort(function (a, b) {
        return a.order !== b.order ? a.order - b.order : a.pos - b.pos;
      });

      return {
        ok: true,
        warnings: warnings,
        playlist: {
          epoch: isInt(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0,
          version: raw.version,
          publishedAt: str(raw.publishedAt),
          playerBuild: str(raw.playerBuild),
          rotation: settings.rotation !== undefined ? SP.rotation.normalize(settings.rotation) : null,
          aspect: SP.rotation.parseAspect(settings.stageAspect),
          pollSec: util.isNumber(settings.pollSeconds) ? util.clamp(settings.pollSeconds, 15, 3600) : null,
          items: out
        }
      };
    },

    /* >0 si a es más nuevo que b; 0 si igual; <0 si más viejo. null se trata como "nada". */
    compare: function (a, b) {
      if (!a && !b) { return 0; }
      if (!a) { return -1; }
      if (!b) { return 1; }
      if (a.epoch !== b.epoch) { return a.epoch - b.epoch; }
      return a.version - b.version;
    },

    label: function (pl) {
      return pl ? ('e' + pl.epoch + '.v' + pl.version) : '-';
    },

    /* Huella del contenido reproducible (para detectar si realmente cambió algo). */
    signature: function (pl) {
      var parts = [];
      var i, it;
      if (!pl) { return ''; }
      for (i = 0; i < pl.items.length; i++) {
        it = pl.items[i];
        parts.push(it.id + '|' + it.url + '|' + it.durationSec + '|' + (it.fallback ? it.fallback.url : '') + '|' +
          (it.variants ? (it.variants[270] ? it.variants[270].url : '') + '|' + (it.variants[90] ? it.variants[90].url : '') : ''));
      }
      return parts.join(';');
    }
  };
})(window);
