#!/usr/bin/env python3
"""Build a copy of the real page with the new lockup, for measurement + screenshots."""
import re, pathlib

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
OUT = pathlib.Path(__file__).resolve().parent

NEW_CSS = """/* hero: the lockup --------------------------------------------------------
   One font-size drives the whole lockup: the name, the mark, the gap and the
   dot are all in em, so it scales as a single object and needs no second
   breakpoint. The mark is baseline-aligned, which puts its tray on the same
   line as the feet of the letters. */
.hero { width: 100%; }

.hero-logo {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.34em;
  margin: 0 auto clamp(18px, 3vh, 28px);
  font-family: var(--mono);
  font-size: clamp(1.9rem, 5vw, 2.5rem);
  font-weight: 500;
  letter-spacing: -0.035em;
  line-height: 1;
  color: var(--text);
}

/* the mark: an arrow and the tray it lands in, drawn at one weight. The box is
   trimmed to the drawing and its bottom edge is the tray's underside, so the
   mark stands on the baseline instead of floating beside the word. */
.hero-mark {
  flex: none;
  padding-top: 0.17em;   /* the arrow's flight path, kept inside the lockup */
  color: var(--text);
}
.hero-mark svg {
  display: block;
  width: 0.83em;         /* 15.6 / 18.8 — the viewBox's own ratio */
  height: 1.06em;
  overflow: visible;     /* the arrow starts above its resting place */
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;     /* in the drawing's units: 1.1 of 18.8, ~2.2px */
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* the name: one run of type, split only where it moves */
.hero-word { display: inline-block; }
.hero-word-m { display: inline; }
.hero-word-down { display: inline-block; }

/* the dot is the joint between the name and the tld. It gets a 0.14em slot of
   its own instead of a whole 0.6em mono cell, and it is drawn rather than
   typed: a period is a square in Menlo and round in SF Mono, so at this size
   the glyph decides the shape of the mark. */
.hero-word-dot {
  display: inline-block;
  position: relative;
  width: 0.14em;
  height: 0.3em;
  overflow: hidden;      /* baseline = bottom edge; the glyph itself is hidden */
  margin: 0 0.075em 0 0.07em;
  color: transparent;
}
.hero-word-dot::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 0;             /* the baseline */
  width: 0.15em;
  height: 0.15em;
  margin-left: -0.075em;
  border-radius: 50%;
  background: var(--accent);
}

/* the tld: a step down in size and one in colour, on the same baseline */
.hero-word-sub {
  font-size: 0.8em;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text-2);
}

/* one gesture: the arrow drops into the tray and the half of the name it hangs
   over falls with it — same distance, same curve, same 760ms, no delay. The
   curve is the site's own (--ease), the one the mode switch rides. */
@keyframes hero-arrow-drop {
  from { transform: translateY(-2.8px); }   /* the drawing's own units */
  to   { transform: translateY(0); }
}
@keyframes hero-word-drop {
  from { transform: translateY(-0.16em); }
  to   { transform: translateY(0); }
}
.mark-arrow     { animation: hero-arrow-drop 760ms var(--ease) backwards; }
.hero-word-down { animation: hero-word-drop  760ms var(--ease) backwards; }

@media (prefers-reduced-motion: reduce) {
  .mark-arrow, .hero-word-down { animation: none; }
}"""

NEW_HTML = """<h1 class="hero-logo">
      <span class="hero-mark" aria-hidden="true">
        <svg viewBox="4.2 2.2 15.6 18.8">
          <!-- the arrow is its own group so it can travel into the tray -->
          <g class="mark-arrow"><path d="M12 2.8V14"/><path d="m7.4 9.4 4.6 4.6 4.6-4.6"/></g>
          <path class="mark-tray" d="M4.8 14.6v3.2a2.6 2.6 0 0 0 2.6 2.6h9.2a2.6 2.6 0 0 0 2.6-2.6v-3.2"/>
        </svg>
      </span>
      <span class="hero-word"><span class="hero-word-m">m</span><span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>
      <span class="sr-only"> — a media downloader for video and audio</span>
    </h1>"""

css = (ROOT / "assets/app.css").read_text()
start = css.index(".hero { width: 100%; }")
end = css.index(".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }") + len(
    ".hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }")
assert start < end
css_new = css[:start] + NEW_CSS + css[end:]

html = (ROOT / "index.html").read_text()
m = re.search(r'<h1 class="hero-logo">.*?</h1>', html, re.S)
assert m
html_new = html[:m.start()] + NEW_HTML + html[m.end():]
# resolve assets against the real preview server
html_new = html_new.replace('<meta charset="utf-8">',
                            '<meta charset="utf-8">\n<base href="http://127.0.0.1:4331/">', 1)
# inline the patched stylesheet, drop the link to the disk one
html_new = re.sub(r'<link rel="stylesheet" href="assets/app.css[^"]*">',
                  '<style>\n' + css_new + '\n</style>', html_new, count=1)
assert '<style>' in html_new

(OUT / "index-new.html").write_text(html_new)

# same page with the hero frozen at t=0 (to inspect the entrance's first frame)
frozen = html_new.replace("</head>", """<style>
  .mark-arrow, .hero-word-down { animation-play-state: paused !important; animation-delay: -1ms !important; }
</style></head>""", 1)
(OUT / "index-new-t0.html").write_text(frozen)

# same page mid-flight
mid = html_new.replace("</head>", """<style>
  .mark-arrow, .hero-word-down { animation-play-state: paused !important; animation-delay: -300ms !important; }
</style></head>""", 1)
(OUT / "index-new-t300.html").write_text(mid)

# light theme
(OUT / "index-new-light.html").write_text(html_new.replace('data-theme="dark"', 'data-theme="light"', 1))

# a font that is not the mono stack (fallback / other machine)
(OUT / "index-new-courier.html").write_text(
    html_new.replace("</head>", "<style>:root{--mono:Courier,'Courier New',monospace}</style></head>", 1))

print("built: index-new, t0, t300, light, courier")
