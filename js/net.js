/* Red mínima con XMLHttpRequest (fetch no existe en TV antiguas). Estilo callback.
 * Cada petición llama a su callback EXACTAMENTE una vez, con timeout propio. */
(function (global) {
  'use strict';

  var SP = global.SP = global.SP || {};
  var util = SP.util;
  var seq = 0;

  function createXhr() {
    return new global.XMLHttpRequest();
  }

  function request(method, url, opts, cb) {
    var xhr, timer, finished = false;
    opts = opts || {};

    function done(err, res) {
      if (finished) { return; }
      finished = true;
      if (timer) { global.clearTimeout(timer); timer = null; }
      xhr.onreadystatechange = null;
      cb(err, res);
    }

    try {
      xhr = createXhr();
      xhr.open(method, url, true);
      if (opts.noCacheHeader) {
        xhr.setRequestHeader('Cache-Control', 'no-cache');
      }
    } catch (e) {
      cb({ type: 'exception', message: String(e && e.message || e) });
      return { abort: function () {} };
    }

    xhr.onreadystatechange = function () {
      var status, text;
      if (xhr.readyState !== 4) { return; }
      status = xhr.status;
      if (status >= 200 && status < 300) {
        text = method === 'HEAD' ? '' : xhr.responseText;
        done(null, {
          status: status,
          text: text,
          contentLength: parseInt(xhr.getResponseHeader('Content-Length'), 10)
        });
      } else {
        done({ type: status === 0 ? 'network' : 'http', status: status, message: status === 0 ? 'sin respuesta' : 'HTTP ' + status });
      }
    };

    timer = global.setTimeout(function () {
      try { xhr.abort(); } catch (e) { /* nada */ }
      done({ type: 'timeout', status: 0, message: 'timeout' });
    }, opts.timeoutMs || 15000);

    try {
      xhr.send(null);
    } catch (e2) {
      done({ type: 'exception', message: String(e2 && e2.message || e2) });
    }

    return {
      abort: function () {
        if (finished) { return; }
        try { xhr.abort(); } catch (e3) { /* nada */ }
        done({ type: 'abort', status: 0, message: 'abortado' });
      }
    };
  }

  SP.net = {
    /* GET JSON con parámetro anti-caché (los CDN de hosting estático cachean ~10 min). */
    getJson: function (url, opts, cb) {
      var u = url;
      opts = opts || {};
      if (opts.bust !== false) {
        seq++;
        u = util.addQuery(url, '_', util.now() + '.' + seq);
      }
      return request('GET', u, {
        timeoutMs: opts.timeoutMs,
        noCacheHeader: opts.noCacheHeader !== false && !util.originOf(url)
      }, function (err, res) {
        var text, data;
        if (err) { cb(err); return; }
        text = String(res.text || '');
        if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); } /* quita BOM */
        try {
          data = JSON.parse(text);
        } catch (e) {
          cb({ type: 'parse', status: res.status, message: 'JSON inválido' });
          return;
        }
        cb(null, data);
      });
    },

    /* HEAD: comprueba que un medio existe y (si se informa) su tamaño. */
    head: function (url, timeoutMs, cb) {
      return request('HEAD', url, { timeoutMs: timeoutMs || 10000 }, cb);
    }
  };
})(window);
