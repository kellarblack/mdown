#!/usr/bin/env python3
"""Build a preview of index.html with the old hero block replaced by the candidate."""
import re, pathlib, sys

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
HERE = pathlib.Path(__file__).parent

MARKUP_OLD = '''      <span class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <!-- the arrow is its own group so it can travel into the tray: the
               mark reads as something being downloaded, not as a shape fading -->
          <g class="mark-arrow"><path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/></g>
          <path class="mark-tray" d="M4 19h16"/>
        </svg>
      </span>
      <span class="hero-word"><span class="hero-type"><span class="hero-word-m">m</span><span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span></span>'''

MARKUP_NEW = '''      <span class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 16 28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <!-- the arrow is its own group so it can travel into the tray: the
               mark reads as something being downloaded, not as a shape fading -->
          <g class="mark-arrow"><path d="M8 8.6v14.8"/><path d="m2.8 18.2 5.2 5.2 5.2-5.2"/></g>
          <path class="mark-tray" d="M0 28h16"/>
        </svg>
      </span>
      <span class="hero-word">mdown<span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>'''

CSS_NEW = pathlib.Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else ""

css = (ROOT / "assets/app.css").read_text()
start = css.index("/* one flow: the arrow rises")
end = css.index(".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }") + len(".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }")
css2 = css[:start] + CSS_NEW + css[end:]
(HERE / "app.css").write_text(css2)

html = (ROOT / "index.html").read_text()
html = html.replace(MARKUP_OLD, MARKUP_NEW)
assert MARKUP_NEW in html, "markup replace failed"
html = re.sub(r'(href|src)="assets/', r'\1="/assets/', html)
html = html.replace('href="manifest.webmanifest"', 'href="/manifest.webmanifest"')
html = html.replace('href="/assets/app.css?v=273"', 'href="app.css"')
(HERE / "preview.html").write_text(html)
print("ok", len(css), "->", len(css2))
