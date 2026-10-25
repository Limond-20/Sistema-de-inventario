/*! offline-assets — hace que Tesseract.js use SOLO archivos locales (carpeta /vendor/tesseract),
 *  de modo que el OCR funcione sin internet. No requiere cambios en los componentes que llaman
 *  a Tesseract.recognize(...). Cargar justo DESPUÉS de vendor/tesseract/tesseract.min.js. */
(function (g) {
  'use strict';
  var base = new URL('vendor/tesseract/', (g.document && g.document.baseURI) || g.location.href).href;
  var local = { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/', gzip: true };
  function withLocal(opts) { return Object.assign({}, local, opts || {}); }
  var T = g.Tesseract;
  if (!T || T.__offline) return;
  var recognize = T.recognize.bind(T);
  T.recognize = function (image, langs, opts) { return recognize(image, langs, withLocal(opts)); };
  if (typeof T.createWorker === 'function') {
    var createWorker = T.createWorker.bind(T);
    T.createWorker = function (langs, oem, opts, config) { return createWorker(langs, oem, withLocal(opts), config); };
  }
  T.__offline = true;
})(window);
