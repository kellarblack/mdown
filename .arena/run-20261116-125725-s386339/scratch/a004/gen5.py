#!/usr/bin/env python3
"""Final candidates: bigger, lighter mark; four spacing/suffix variants.
   Rows: 1 gap .30 / cc 1em @text-2
         2 gap .34 / cc 1em @text-2
         3 gap .34 / cc .82em @text-2
         4 gap .34 / cc 1em @text-3
   mark = .84em box, stroke .95 (the shipped mark's size, half the weight)"""
import pathlib

OUT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown/.arena/run-20261116-125725-s386339/scratch/a004")

new = (OUT / "new.html").read_text()
h1_new = new[new.index('    <h1 class="hero-logo">'):new.index("</h1>") + 5]
hero_css = new[new.index("/* ---------- hero lockup"):]
hero_css = hero_css[:hero_css.index("</style>")]
hero_css = hero_css.replace("width: 0.75em; height: 0.75em", "width: 0.84em; height: 0.84em")
hero_css = hero_css.replace('stroke-width="1"', 'stroke-width="0.95"')

BASE = ".hero-mark{width:.84em;height:.84em} .hero-mark svg{stroke-width:.95}"
V = [
    ("r1", "gap left", ".hero-logo{gap:.30em}"),
    ("r2", "gap .34", ".hero-logo{gap:.34em}"),
    ("r3", "cc .82em", ".hero-logo{gap:.34em} .hero-word-sub{font-size:.82em}"),
    ("r4", "cc text-3", ".hero-logo{gap:.34em} .hero-word-sub{color:var(--text-3)}"),
]

rows = ['<div class="row r0">' + h1_new + "</div>"]
css = [".r0 " + BASE]
for cls, _, rule in V:
    rows.append(f'<div class="row {cls}">{h1_new}</div>')
    css.append(".%s %s .%s %s" % (cls, BASE, cls, rule))

PAGE = """<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/assets/app.css">
<style>
  html, body { background: var(--bg); margin: 0; }
  .sheet { zoom: 2.2; }
  .row { display: flex; justify-content: center; padding: 22px 0; }
  .row + .row { border-top: 1px solid rgba(255,255,255,.05); }
  .row .hero-logo { animation: none !important; margin: 0 !important; }
  .row .mark-arrow, .row .hero-word-down { animation: none !important; }
</style>
<style>%s</style>
<style>%s</style>
</head>
<body><div class="row-note"></div><div class="sheet">%s</div></body></html>
"""

(OUT / "final.html").write_text(PAGE % (hero_css, "\n".join(css), "".join(rows)))
print("ok")
