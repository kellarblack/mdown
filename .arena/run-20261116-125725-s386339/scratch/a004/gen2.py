#!/usr/bin/env python3
"""Add a measurement harness to old.html/new.html and build close-up pages."""
import pathlib, re

OUT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown/.arena/run-20261116-125725-s386339/scratch/a004")

MEASURE = r'''
<script>
(function () {
  const out = {};
  const px = (n) => Math.round(n * 100) / 100;
  const r = (el) => el ? el.getBoundingClientRect() : null;
  const h1 = document.querySelector(".hero-logo");
  const word = document.querySelector(".hero-word");
  const svg = document.querySelector(".hero-mark svg");
  const composer = document.querySelector(".composer");

  // baseline probe: an empty inline-block sits with its bottom edge on the baseline
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline";
  word.appendChild(probe);
  const baseline = r(probe).top;
  probe.remove();

  const cs = getComputedStyle(word);
  const c = document.createElement("canvas").getContext("2d");
  c.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  const mD = c.measureText("d");
  const mM = c.measureText("m");
  const mW = c.measureText("mdown.cc");

  out.h1 = { w: px(r(h1).width), h: px(r(h1).height), top: px(r(h1).top), left: px(r(h1).left) };
  out.word = { lineHeight: cs.lineHeight, fontSize: cs.fontSize, font: cs.fontFamily.split(",")[0],
               tracking: cs.letterSpacing, width: px(r(word).width) };
  out.svg = { top: px(r(svg).top), bottom: px(r(svg).bottom), w: px(r(svg).width), h: px(r(svg).height) };
  out.baseline = px(baseline);
  out.markOverBaseline = px(baseline - r(svg).bottom);   // 0 = tray bottom sits on the baseline
  out.markAboveBaseline = px(baseline - r(svg).top);
  out.ascender_d = px(mD.actualBoundingBoxAscent);
  out.markVsAscender = px((baseline - r(svg).top) - mD.actualBoundingBoxAscent);
  out.strokePx = px(parseFloat(getComputedStyle(svg).strokeWidth) * r(svg).height / parseFloat(svg.getAttribute("viewBox").split(/\s+/)[3]));
  out.overflow = getComputedStyle(svg).overflow;
  out.h1fits = { scrollWidth: h1.scrollWidth, clientWidth: h1.clientWidth };
  out.composerTop = px(r(composer).top);
  out.docH = document.documentElement.scrollHeight;

  // where does the arrow render at t=0 of its entrance?
  const g = document.querySelector(".mark-arrow");
  const anims = g.getAnimations();
  if (anims.length) {
    const a = anims[0];
    a.pause();
    a.currentTime = 0;
    const gr = r(g);
    out.arrowAtStart = { top: px(gr.top), bottom: px(gr.bottom) };
    out.arrowClippedAbove = px((r(svg).top - gr.top) > 0.01 ? r(svg).top - gr.top : 0);
    out.arrowStartTransform = getComputedStyle(g).transform;
    a.currentTime = a.effect.getTiming().duration;
    const gr2 = r(g);
    out.arrowAtEnd = { top: px(gr2.top), bottom: px(gr2.bottom) };
    out.arrowTravelPx = px(gr2.top - gr.top);
  }

  const pre = document.createElement("pre");
  pre.id = "measure";
  pre.textContent = "MEASURE " + JSON.stringify(out, null, 1);
  document.body.appendChild(pre);
})();
</script>
'''

for name in ("old", "new"):
    p = OUT / f"{name}.html"
    s = p.read_text()
    s = s.replace("</body>", MEASURE + "</body>")
    (OUT / f"{name}-m.html").write_text(s)

# ---- close-ups: just the lockup, at 2.5x, on the page background ----
index = (OUT / "new.html").read_text()
h1_new = index[index.index('    <h1 class="hero-logo">'):index.index("</h1>") + 5]
old = (OUT / "old.html").read_text()
h1_old = old[old.index('    <h1 class="hero-logo">'):old.index("</h1>") + 5]
newcss = index[index.index("<style>"):index.index("</style>") + 8]

PAGE = '''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/assets/app.css">
<style>
  html, body {{ background: var(--bg); }}
  body {{ margin: 0; padding: 40px 0; }}
  .stage {{ display: flex; justify-content: center; align-items: center; zoom: 2.5; }}
  .stage2 {{ position: absolute; left: 0; right: 0; {extra} }}
</style>
{extra_css}
</head>
<body><div class="stage">{h1}</div>{more}</body></html>
'''

# frozen at the animation's first frame: proves where the arrow starts
FROZEN = '''<style>.hero-logo,.mark-arrow,.hero-word-down{animation-play-state:paused!important}</style>'''

for name, h1, extra_css, extra in (
    ("closeup-old", h1_old, "", ""),
    ("closeup-new", h1_new, newcss, ""),
    ("closeup-old-start", h1_old, FROZEN, ""),
    ("closeup-new-start", h1_new, newcss + FROZEN, ""),
):
    (OUT / f"{name}.html").write_text(PAGE.format(h1=h1, extra_css=extra_css, extra=extra, more=""))

print("ok")
