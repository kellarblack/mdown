#!/usr/bin/env python3
"""Rebuild index-new.html with the final numbers, plus a measurement build."""
import re, pathlib, json

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
OUT = pathlib.Path(__file__).resolve().parent

NEW_CSS = (OUT / "new-hero.css").read_text()
NEW_HTML = (OUT / "new-hero.html").read_text()

css = (ROOT / "assets/app.css").read_text()
start = css.index(".hero { width: 100%; }")
endtok = ".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }"
end = css.index(endtok) + len(endtok)
css_new = css[:start] + NEW_CSS + css[end:]

html = (ROOT / "index.html").read_text()
m = re.search(r'<h1 class="hero-logo">.*?</h1>', html, re.S)
html_new = html[:m.start()] + NEW_HTML + html[m.end():]
html_new = html_new.replace('<meta charset="utf-8">',
                            '<meta charset="utf-8">\n<base href="http://127.0.0.1:4331/">', 1)
html_new = re.sub(r'<link rel="stylesheet" href="assets/app.css[^"]*">',
                  '<style>\n' + css_new + '\n</style>', html_new, count=1)
assert '<base href' in html_new and 'hero-arrow-drop' in html_new

(OUT / "index-new.html").write_text(html_new)

for name, delay in (("t0", "-1ms"), ("t300", "-300ms"), ("t760", "-759ms")):
    (OUT / f"index-new-{name}.html").write_text(html_new.replace("</head>", f"""<style>
  .mark-arrow, .hero-word-down {{ animation-play-state: paused !important; animation-delay: {delay} !important; }}
</style></head>""", 1))

(OUT / "index-new-light.html").write_text(
    html_new.replace('data-theme="dark"', 'data-theme="light"', 1))
(OUT / "index-new-courier.html").write_text(
    html_new.replace("</head>", "<style>:root{--mono:Courier,'Courier New',monospace}</style></head>", 1))

PROBE = """
<script>
setTimeout(function () { try {
  const logo = document.querySelector('.hero-logo');
  const mark = document.querySelector('.hero-mark svg');
  const word = document.querySelector('.hero-word');
  const dot  = document.querySelector('.hero-word-dot');
  const down = document.querySelector('.hero-word-down');
  const comp = document.querySelector('.composer');
  const cs = getComputedStyle(logo);
  // an empty inline-block's baseline is its bottom margin edge -> that is the text baseline
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:.5em;vertical-align:baseline';
  word.appendChild(probe);
  const b = probe.getBoundingClientRect().bottom;
  const r = (el) => { const q = el.getBoundingClientRect();
    return {l:+q.left.toFixed(2), t:+q.top.toFixed(2), r:+q.right.toFixed(2), b:+q.bottom.toFixed(2), w:+q.width.toFixed(2), h:+q.height.toFixed(2)}; };
  const fs = parseFloat(cs.fontSize);
  const out = {
    viewport: {w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth},
    fontSize: +fs.toFixed(2),
    baselineY: +b.toFixed(2),
    mark: r(mark), word: r(word), dot: r(dot), down: r(down), logo: r(logo), composer: r(comp),
    px: {
      markBottomMinusBaseline: +(r(mark).b - b).toFixed(2),
      dotBottomMinusBaseline: +(r(dot).b - b).toFixed(2),
      markHeight: r(mark).h, markWidth: r(mark).w,
      capEstimate_px: +(fs * 0.72).toFixed(2),
      markGap: +(r(word).l - r(mark).r).toFixed(2),
      logoHeight: r(logo).h,
      wordWidth: r(word).w,
      overflowX: document.documentElement.scrollWidth - innerWidth,
    },
    line: cs.lineHeight + ' / letter-spacing ' + cs.letterSpacing,
    wordWraps: r(word).h > fs * 1.5,
    arrowTransform: getComputedStyle(document.querySelector('.mark-arrow')).transform,
    downTransform: getComputedStyle(down).transform,
  };
  probe.remove();
  const pre = document.createElement('pre');
  pre.id = 'probe-out';
  pre.textContent = JSON.stringify(out, null, 1);
  document.body.appendChild(pre);
} catch (e) {
  const pre = document.createElement('pre');
  pre.id = 'probe-out';
  pre.textContent = 'ERR ' + e.message;
  document.body.appendChild(pre);
} }, 400);
</script>
"""

(OUT / "index-probe.html").write_text(
    html_new.replace("</body>", PROBE + "</body>", 1))
print("built")
