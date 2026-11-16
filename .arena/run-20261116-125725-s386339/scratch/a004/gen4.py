#!/usr/bin/env python3
"""Variant sheet: the lockup, static (animations off), at 2.2x.
   Rows top to bottom: 1 shipped, 2 mark .75em, 3 mark .82em,
   4 cc .8em, 5 cc --text-3, 6 gap .30em."""
import pathlib

OUT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown/.arena/run-20261116-125725-s386339/scratch/a004")

new = (OUT / "new.html").read_text()
h1_new = new[new.index('    <h1 class="hero-logo">'):new.index("</h1>") + 5]
hero_css = new[new.index("/* ---------- hero lockup"):]
hero_css = hero_css[:hero_css.index("</style>")]
old = (OUT / "old.html").read_text()
h1_old = old[old.index('    <h1 class="hero-logo">'):old.index("</h1>") + 5]

V = [
    ("r2", ".hero-mark{width:.75em;height:.75em}"),
    ("r3", ".hero-mark{width:.82em;height:.82em}"),
    ("r4", ".hero-word-sub{font-size:.8em}"),
    ("r5", ".hero-word-sub{color:var(--text-3)}"),
    ("r6", ".hero-logo{gap:.30em}"),
]

rows = ['<div class="row r1">' + h1_old + "</div>"]
css = []
for cls, rule in V:
    rows.append(f'<div class="row {cls}">{h1_new}</div>')
    css.append(".%s %s" % (cls, rule))

PAGE = """<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/assets/app.css">
<style>
  html, body { background: var(--bg); margin: 0; }
  .sheet { zoom: 2.2; }
  .row { display: flex; justify-content: center; padding: 20px 0; }
  .row + .row { border-top: 1px solid rgba(255,255,255,.05); }
  .row .hero-logo { margin: 0 !important; animation: none !important; }
  .row .mark-arrow, .row .hero-word-down { animation: none !important; }
</style>
<style>%s</style>
<style>%s</style>
</head>
<body><div class="sheet">%s</div></body></html>
"""

(OUT / "variants.html").write_text(PAGE % (hero_css, "\n".join(css), "".join(rows)))
print("ok")
