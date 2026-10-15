// Runs before the body paints. Theme and type size have to be right on the
// first frame, or a dark room gets a white flash and then a correction.
(function () {
  try {
    var theme = localStorage.getItem('chapterize-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    var scale = localStorage.getItem('chapterize-scale');
    if (scale === '0.94' || scale === '1' || scale === '1.12' || scale === '1.28') {
      document.documentElement.style.setProperty('--scale', scale);
    }
  } catch (e) {
    // Private mode can refuse storage. The book still opens.
  }
})();
