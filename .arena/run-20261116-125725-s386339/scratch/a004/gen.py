#!/usr/bin/env python3
"""Build two throwaway preview pages from the real mdown index.html:
   old.html = the page as shipped (with the hero CSS the user is unhappy with)
   new.html = the same page with the proposed hero markup + CSS pasted in
Asset URLs are made root-absolute so the copies can live under .arena/.
"""
import re, pathlib

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
OUT = ROOT / ".arena/run-20261116-125725-s386339/scratch/a004"

NEW_H1 = '''    <h1 class="hero-logo">
      <span class="hero-mark" aria-hidden="true">
        <!-- the brand's own mark, cropped to its ink: the arrow is a group so it
             can travel into the tray, the tray is one rule on the word's baseline -->
        <svg viewBox="3.5 2.5 17 17" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <g class="mark-arrow"><path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/></g>
          <path class="mark-tray" d="M4 19h16"/>
        </svg>
      </span>
      <span class="hero-word">m<span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span>
      <span class="sr-only"> — a media downloader for video and audio</span>
    </h1>'''

NEW_CSS = '''<style>
/* ---------- hero lockup ---------- */
/* One type size for the whole lockup; every other measurement is em, so the
   mark, the gap and the word keep their proportions at any width. */
.hero { width: 100%; }
.hero-logo {
  display: flex; align-items: baseline; justify-content: center;
  flex-wrap: nowrap; gap: 0.38em;
  font-size: clamp(1.75rem, 4.2vw, 2.4rem);
  margin: 0 auto clamp(18px, 3vh, 28px);
  color: var(--text);
  animation: hero-in 260ms var(--ease) both;
}
@keyframes hero-in { from { opacity: 0; } to { opacity: 1; } }

.hero-mark {
  flex: none; width: 0.75em; height: 0.75em;
  color: var(--text);
}
.hero-mark svg { display: block; width: 100%; height: 100%; overflow: visible; }

.mark-arrow { animation: mark-drop 600ms var(--ease) both; }
@keyframes mark-drop {
  from { transform: translate3d(0, -3.25px, 0); }
  to   { transform: translate3d(0, 0, 0); }
}

.hero-word {
  font-family: var(--mono); font-weight: 500; font-size: 1em;
  line-height: 1; letter-spacing: -0.03em; white-space: nowrap;
}
.hero-word-down { display: inline-block; animation: word-drop 600ms var(--ease) both; }
@keyframes word-drop {
  from { transform: translate3d(0, -0.135em, 0); }
  to   { transform: translate3d(0, 0, 0); }
}
.hero-word-dot { color: var(--accent); margin: 0 -0.12em 0 -0.09em; }
.hero-word-sub { font-weight: 400; color: var(--text-2); }

@media (prefers-reduced-motion: reduce) {
  .hero-logo, .mark-arrow, .hero-word-down { animation: none; }
}
</style>
'''

src = (ROOT / "index.html").read_text()
src = src.replace('="assets/', '="/assets/')

# old page: unchanged markup/css
(OUT / "old.html").write_text(src)

# new page: swap the h1 block, append the new css block
start = src.index('    <h1 class="hero-logo">')
end = src.index('</h1>', start) + len('</h1>')
new = src[:start] + NEW_H1 + src[end:]
new = new.replace('</head>', NEW_CSS + '</head>')
(OUT / "new.html").write_text(new)
print("wrote old.html new.html")
