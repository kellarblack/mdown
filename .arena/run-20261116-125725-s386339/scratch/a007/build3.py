#!/usr/bin/env python3
"""Build preview.html / old.html from the committed (baseline) files + the candidate hero."""
import re, pathlib, subprocess, sys

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
HERE = pathlib.Path(__file__).parent

def git_show(path):
    return subprocess.run(["git", "show", f"HEAD:{path}"], cwd=ROOT,
                          capture_output=True, text=True, check=True).stdout

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
        <svg viewBox="0 0 14.4 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <!-- the arrow is its own group so it can travel into the tray: the
               mark reads as something being downloaded, not as a shape fading -->
          <g class="mark-arrow"><path d="M7.2 8.6v16.6"/><path d="m2.2 20.2 5 5 5-5"/></g>
          <path class="mark-tray" d="M0 28h14.4"/>
        </svg>
      </span>
      <span class="hero-word">mdown<span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>'''

CSS_NEW = pathlib.Path(sys.argv[1]).read_text()

def unrel(h):
    h = re.sub(r'(href|src)="assets/', r'\1="/assets/', h)
    h = h.replace('href="manifest.webmanifest"', 'href="/manifest.webmanifest"')
    return h

base_css = git_show("assets/app.css")
start = base_css.index("/* one flow: the arrow rises")
endm = ".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }"
end = base_css.index(endm) + len(endm)
new_css = base_css[:start] + CSS_NEW + base_css[end:]

base_html = git_show("index.html")
probe = '<script src="measure.js"></script>\n</body>'

old_html = unrel(base_html).replace("</body>", probe, 1)
(HERE / "old.html").write_text(old_html)

new_html = unrel(base_html.replace(MARKUP_OLD, MARKUP_NEW))
assert MARKUP_NEW in new_html, "markup replace failed"
new_html = re.sub(r'href="[^"]*app\.css[^"]*"', 'href="app.css"', new_html)
(HERE / "preview.html").write_text(new_html.replace("</body>", probe, 1))
(HERE / "app.css").write_text(new_css)
assert "hero-word-down" not in new_css and "hero-type" not in new_css
print("ok css", len(base_css), "->", len(new_css))
