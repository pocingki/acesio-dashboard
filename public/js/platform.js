// Menandai html[data-os] sebelum halaman digambar. Setara Platform.OS di aplikasi native.
(function () {
  var ua = navigator.userAgent || '';
  var touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  var os = /iPad|iPhone|iPod/.test(ua) || touchMac ? 'ios' : (/Android/i.test(ua) ? 'android' : 'other');
  document.documentElement.setAttribute('data-os', os);
})();
