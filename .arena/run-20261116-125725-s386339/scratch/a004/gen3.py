#!/usr/bin/env python3
"""Close-ups: just the lockup at 2.5x, old vs new, plus the entrance's first frame."""
import pathlib

OUT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown/.arena/run-20261116-125725-s386339/scratch/a004")

new = (OUT / "new.html").read_text()
h1_new = new[new.index('    <h1 class="hero-logo">'):new.index("</h1>") + 5]
hero_css = new[new.index("/* ---------- hero lockup"):]
hero_css = hero_css[:hero_css.index("</style>")]
old = (OUT / "old.html").read_text()
h1_old = old[old.index('    <h1 class="hero-logo">'):old.index("</h1>") + 5]

PAGE = """<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/assets/app.css">
<style>
  html, body { background: var(--bg); }
  body { margin: 0; padding: 30px 0; }
  .stage { display: flex; justify-content: center; zoom: 2.5; }
  .ruler { position: fixed; left: 0; right: 0; height: 0; border-top: 1px dashed rgba(255,255,255,.22); }
</style>
<style>%s</style>
<style>%s</style>
</head>
<body><div class="stage">%s</div></body></html>
"""

FROZEN = ".hero-logo,.mark-arrow,.hero-word-down{animation-play-state:paused!important}"

for name, h1, css, frozen in (
    ("closeup-old", h1_old, "", ""),
    ("closeup-new", h1_new, hero_css, ""),
    ("closeup-old-start", h1_old, "", FROZEN),
    ("closeup-new-start", h1_new, hero_css, FROZEN),
):
    (OUT / f"{name}.html").write_text(PAGE % (css, frozen, h1))
print("ok")
