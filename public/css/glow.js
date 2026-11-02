/* Glow kit — scroll reveals, count-ups, rotating words and card spotlight. No dependencies. */
(function () {
  if (window.__gx) return; window.__gx = true;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function show(el) { el.classList.add('gx-in'); }
  function count(el) {
    if (el.__gxDone) return; el.__gxDone = true;
    var to = parseFloat(el.getAttribute('data-count')), dec = +(el.getAttribute('data-dec') || 0);
    if (reduced) { el.textContent = to.toFixed(dec); return; }
    var t0 = performance.now();
    (function tick(now) { var p = Math.min(1, (now - t0) / 1600); el.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(dec); if (p < 1) requestAnimationFrame(tick); })(t0);
  }
  var io = !reduced && 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.hasAttribute('data-count') ? count(e.target) : show(e.target); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) : null;
  function scan() {
    document.querySelectorAll('.gx-reveal:not(.gx-in), [data-count]').forEach(function (el) {
      if (el.__gxSeen) return; el.__gxSeen = true;
      if (!io) { el.hasAttribute('data-count') ? count(el) : show(el); } else io.observe(el);
    });
  }
  function sweep() {
    var lim = window.innerHeight;
    document.querySelectorAll('.gx-reveal:not(.gx-in)').forEach(function (el) { if (el.getBoundingClientRect().top < lim) show(el); });
    document.querySelectorAll('[data-count]').forEach(function (el) { if (el.getBoundingClientRect().top < lim) count(el); });
  }
  var raf = 0;
  function onScroll() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; sweep(); }); }
  function cycle() {
    document.querySelectorAll('[data-cycle]').forEach(function (el) {
      if (el.__gxCycle) return; el.__gxCycle = true;
      var words = JSON.parse(el.getAttribute('data-cycle')), i = 0;
      if (reduced || words.length < 2) return;
      setInterval(function () {
        i = (i + 1) % words.length;
        var w = document.createElement('em'); w.className = 'gx-word';
        var s = document.createElement('span'); s.className = 'gx-shimmer'; s.textContent = words[i];
        w.appendChild(s); el.replaceChildren(w);
      }, 2400);
    });
  }
  function init() {
    scan(); cycle(); setTimeout(sweep, 300);
    new MutationObserver(function () { scan(); cycle(); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('pointermove', function (e) {
      var c = e.target && e.target.closest && e.target.closest('.gx-spot'); if (!c) return;
      var r = c.getBoundingClientRect(); c.style.setProperty('--mx', e.clientX - r.left + 'px'); c.style.setProperty('--my', e.clientY - r.top + 'px');
    }, { passive: true });
    if (location.hash) {
      var id = decodeURIComponent(location.hash.slice(1)), n = 0;
      var t = setInterval(function () { var el = document.getElementById(id); if (el || ++n > 40) { clearInterval(t); if (el) { el.scrollIntoView(); setTimeout(function () { el.scrollIntoView(); }, 450); } } }, 50);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
