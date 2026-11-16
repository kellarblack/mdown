(function () {
  function R(e) { const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2) }; }
  function probe() {
    const d = document;
    const logo = d.querySelector('.hero-logo');
    const mark = d.querySelector('.hero-mark');
    const svg = d.querySelector('.hero-mark svg');
    const word = d.querySelector('.hero-word');
    const dot = d.querySelector('.hero-word-dot');
    const sub = d.querySelector('.hero-word-sub');
    const comp = d.querySelector('.composer');
    const p = d.createElement('span');
    p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    logo.appendChild(p);
    const base = R(p).b; p.remove();
    const cs = getComputedStyle(logo);
    const mb = R(mark); const sb = R(svg);
    return {
      vw: innerWidth,
      heroFontSize: +parseFloat(cs.fontSize).toFixed(2),
      align: cs.alignItems,
      lockupH: +R(logo).h.toFixed(2),
      lockupW: +R(logo).w.toFixed(2),
      baselineY: +base.toFixed(2),
      markBox: [mb.w, mb.h],
      svgBox: [sb.w, sb.h],
      svgBottomMinusBaseline: +(sb.b - base).toFixed(2),
      gapMarkToWord: +(R(word).x - mb.x - mb.w).toFixed(2),
      wordW: +R(word).w.toFixed(2),
      dotCell: [R(dot).w, R(dot).h],
      subFontSize: +parseFloat(getComputedStyle(sub).fontSize).toFixed(2),
      subColor: getComputedStyle(sub).color,
      composerTop: +R(comp).t.toFixed(2),
      composerW: +R(comp).w.toFixed(2),
      scrollW: d.documentElement.scrollWidth,
      overflowX: d.documentElement.scrollWidth > innerWidth,
      markStroke: getComputedStyle(svg).strokeWidth,
      arrowAnim: getComputedStyle(svg.querySelector('.mark-arrow')).animationName
    };
  }
  window.__probe = probe;
  addEventListener('load', function () {
    setTimeout(function () {
      const pre = document.createElement('pre');
      pre.id = 'probeout';
      pre.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9999;color:#0f0;background:#000;font:10px monospace;margin:0';
      pre.textContent = 'PROBE ' + JSON.stringify(probe());
      document.body.appendChild(pre);
    }, 200);
  });
})();
