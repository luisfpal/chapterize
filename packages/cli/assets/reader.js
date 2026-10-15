/**
 * Preferences belong to the eyes, and the reading place belongs to the book.
 * Both are also carried on the link. A page opened from the iPhone Files app
 * does not share localStorage with the next file — each file is its own
 * origin — so a tap that dropped the query would reset the type size.
 * Sizes must match SIZES in src/html.ts. The head script whitelists the same
 * numbers and reads the same query keys before paint.
 */
var ChapterizeReader = (function () {
  'use strict';

  var sizes = [17, 19, 21, 24, 28];

  function nextTheme(current, prefersDark) {
    // The first tap has to change the page. If the phone is already dark,
    // "system" is dark, so the next stop is light — and the reverse.
    var order = prefersDark ? ['system', 'light', 'dark'] : ['system', 'dark', 'light'];
    var i = order.indexOf(current);
    if (i < 0) i = 0;
    return order[(i + 1) % order.length];
  }

  function stepSize(current, delta) {
    var i = sizes.indexOf(current);
    if (i < 0) i = sizes.indexOf(19);
    var n = i + delta;
    if (n < 0) n = 0;
    if (n > sizes.length - 1) n = sizes.length - 1;
    return sizes[n];
  }

  // startX near the left edge is the browser's back gesture. Taking it would
  // turn a swipe-back into a chapter change.
  function swipe(dx, dy, startX) {
    if (startX < 28) return null;
    if (Math.abs(dx) < 64) return null;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
    return dx < 0 ? 'next' : 'prev';
  }

  function prefsFromSearch(search, storedTheme, storedSize) {
    var q = new URLSearchParams(search || '');
    var theme = q.get('theme');
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') theme = storedTheme;
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') theme = 'system';
    var size = Number(q.get('size'));
    if (sizes.indexOf(size) < 0) size = Number(storedSize);
    if (sizes.indexOf(size) < 0) size = 19;
    return { theme: theme, size: size };
  }

  // Hash-only and absolute links are left alone. A footnote is a hash, and
  // adding a query to it would reload the chapter.
  function withPrefs(href, theme, size) {
    if (!href || href.charAt(0) === '#' || href.slice(0, 2) === '//' || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return href;
    }
    var hash = '';
    var body = href;
    var hashAt = href.indexOf('#');
    if (hashAt >= 0) {
      hash = href.slice(hashAt);
      body = href.slice(0, hashAt);
    }
    var qAt = body.indexOf('?');
    var path = qAt >= 0 ? body.slice(0, qAt) : body;
    var params = new URLSearchParams(qAt >= 0 ? body.slice(qAt + 1) : '');
    params.set('theme', theme);
    params.set('size', String(size));
    var query = params.toString();
    return path + (query ? '?' + query : '') + hash;
  }

  // `at` is a bundle path we generated. Anything else is ignored, because
  // this string is written into a link.
  function placeFromSearch(search) {
    var q = new URLSearchParams(search || '');
    var file = q.get('at');
    if (!file || !/^chapters\/[a-z0-9-]+\.html$/.test(file)) file = null;
    var y = Number(q.get('y'));
    if (!isFinite(y) || y < 0) y = 0;
    return { file: file, y: y };
  }

  function boot() {
    var root = document.documentElement;
    var body = document.body;
    var book = body.getAttribute('data-book') || 'book';
    var themeKey = 'chapterize-theme';
    var sizeKey = 'chapterize-size';
    var posKey = 'chapterize-pos:' + book;

    function read(key) {
      try { return localStorage.getItem(key); }
      catch (e) { return null; } // private mode: the page still reads
    }
    function write(key, value) {
      try { localStorage.setItem(key, value); }
      catch (e) { /* preferences are optional */ }
    }

    var chosen = prefsFromSearch(location.search, read(themeKey), read(sizeKey));
    var theme = chosen.theme;
    var size = chosen.size;
    if (location.search.indexOf('theme=') >= 0) write(themeKey, theme);
    if (location.search.indexOf('size=') >= 0) write(sizeKey, String(size));

    function effectiveDark() {
      return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    function apply() {
      if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
      else root.removeAttribute('data-theme');
      root.style.fontSize = size + 'px';
      var color = effectiveDark() ? '#16151a' : '#faf9f7';
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.setAttribute('content', color);
      });
      var smaller = document.querySelector('[data-action="smaller"]');
      var larger = document.querySelector('[data-action="larger"]');
      var themeBtn = document.querySelector('[data-action="theme"]');
      if (smaller) smaller.disabled = size === sizes[0];
      if (larger) larger.disabled = size === sizes[sizes.length - 1];
      if (themeBtn) {
        var label = theme === 'system' ? 'Appearance, matching the phone' : 'Appearance, ' + theme;
        themeBtn.setAttribute('aria-label', label);
      }
    }
    apply();

    document.addEventListener('click', function (event) {
      var node = event.target;
      var btn = null;
      while (node && node !== document) {
        if (node.getAttribute && node.getAttribute('data-action')) { btn = node; break; }
        node = node.parentNode;
      }
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'theme') {
        theme = nextTheme(theme, window.matchMedia('(prefers-color-scheme: dark)').matches);
        write(themeKey, theme);
      } else if (action === 'smaller') {
        size = stepSize(size, -1);
        write(sizeKey, String(size));
      } else if (action === 'larger') {
        size = stepSize(size, 1);
        write(sizeKey, String(size));
      } else return;
      apply();
      decorate(indexHref());
    });

    function go(href) { if (href) window.location.href = withPrefs(href, theme, size); }

    function indexHref() {
      var file = body.getAttribute('data-file');
      if (!file) return null;
      var y = Math.max(0, Math.round(window.scrollY || 0));
      return '../index.html?at=' + encodeURIComponent(file) + '&y=' + y;
    }

    function decorate(extra) {
      var links = document.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var node = links[i];
        var raw = node.getAttribute('data-raw-href');
        if (!raw) {
          raw = node.getAttribute('href') || '';
          node.setAttribute('data-raw-href', raw);
        }
        if (!raw || raw.charAt(0) === '#') continue;
        var href = raw;
        if (extra && node.classList && (node.classList.contains('booklink') || node.classList.contains('pos'))) {
          href = extra;
        }
        node.setAttribute('href', withPrefs(href, theme, size));
      }
    }

    document.addEventListener('keydown', function (event) {
      var tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'n' || event.key === 'ArrowRight') {
        if (event.key === 'ArrowRight') event.preventDefault();
        go(body.getAttribute('data-next'));
      } else if (event.key === 'p' || event.key === 'ArrowLeft') {
        if (event.key === 'ArrowLeft') event.preventDefault();
        go(body.getAttribute('data-prev'));
      } else if (event.key === '-' || event.key === '_') {
        size = stepSize(size, -1);
        write(sizeKey, String(size));
        apply();
        decorate(indexHref());
      } else if (event.key === '+' || event.key === '=') {
        size = stepSize(size, 1);
        write(sizeKey, String(size));
        apply();
        decorate(indexHref());
      }
    });

    var startX = 0;
    var startY = 0;
    var tracking = false;
    document.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) { tracking = false; return; }
      var t = event.target;
      if (t && t.closest && t.closest('a, button, pre')) { tracking = false; return; }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    document.addEventListener('touchend', function (event) {
      if (!tracking) return;
      tracking = false;
      var touch = event.changedTouches[0];
      if (!touch) return;
      var selected = window.getSelection && String(window.getSelection());
      if (selected) return;
      var dir = swipe(touch.clientX - startX, touch.clientY - startY, startX);
      if (dir === 'next') go(body.getAttribute('data-next'));
      else if (dir === 'prev') go(body.getAttribute('data-prev'));
    }, { passive: true });
    document.addEventListener('touchcancel', function () { tracking = false; });

    function writePos() {
      var file = body.getAttribute('data-file');
      if (!file) return;
      write(posKey, JSON.stringify({ file: file, y: window.scrollY }));
    }
    function readPos() {
      var raw = read(posKey);
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.file !== 'string' || typeof parsed.y !== 'number') return null;
        return parsed;
      } catch (e) { return null; }
    }

    var queried = placeFromSearch(location.search);

    if (body.getAttribute('data-page') === 'chapter') {
      var here = readPos();
      var file = body.getAttribute('data-file');
      var y = queried.y;
      if (!(y > 0) && here && here.file === file) y = here.y;
      if (y > 0) requestAnimationFrame(function () { window.scrollTo(0, y); });
      writePos();
      var lastY = window.scrollY;
      var saveTimer = 0;
      window.addEventListener('scroll', function () {
        var y = window.scrollY;
        if (y < 8) body.classList.remove('chrome-hidden');
        else if (y > lastY + 8) body.classList.add('chrome-hidden');
        else if (y < lastY - 8) body.classList.remove('chrome-hidden');
        lastY = y;
        var range = document.documentElement.scrollHeight - window.innerHeight;
        var bar = document.getElementById('progress');
        if (bar) bar.style.width = (range > 0 ? (100 * y / range) : 0) + '%';
        var back = indexHref();
        if (back) {
          var backs = document.querySelectorAll('a.booklink, a.pos');
          for (var b = 0; b < backs.length; b++) backs[b].setAttribute('href', withPrefs(back, theme, size));
        }
        if (!saveTimer) {
          saveTimer = setTimeout(function () { saveTimer = 0; writePos(); }, 400);
        }
      }, { passive: true });
      window.addEventListener('pagehide', writePos);
    }

    decorate(indexHref());

    if (body.getAttribute('data-page') === 'index') {
      var saved = readPos();
      var picked = queried.file;
      var pickedY = queried.file ? queried.y : 0;
      if (!picked && saved && /^chapters\/[a-z0-9-]+\.html$/.test(saved.file)) {
        picked = saved.file;
        pickedY = saved.y;
      }
      if (picked) {
        var link = document.querySelector('a.row[href="' + picked + '"]');
        if (!link) link = document.querySelector('a.row[data-raw-href="' + picked + '"]');
        if (link) {
          link.setAttribute('aria-current', 'true');
          var box = document.getElementById('continue');
          var name = link.querySelector('.name');
          if (box && name) {
            var a = document.createElement('a');
            var target = picked + (pickedY > 0 ? '?y=' + Math.round(pickedY) : '');
            a.href = withPrefs(target, theme, size);
            a.className = 'continue';
            a.textContent = 'Continue · ' + name.textContent;
            box.appendChild(a);
          }
        }
      }
    }
  }

  return {
    nextTheme: nextTheme,
    stepSize: stepSize,
    swipe: swipe,
    prefsFromSearch: prefsFromSearch,
    withPrefs: withPrefs,
    placeFromSearch: placeFromSearch,
    sizes: sizes,
    boot: boot
  };
})();

if (typeof document !== 'undefined') ChapterizeReader.boot();
