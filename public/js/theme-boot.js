// Runs synchronously in <head> so the saved theme applies before first paint.
(function () {
  try {
    var t = localStorage.getItem('vx-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: follow the OS */ }
})();
