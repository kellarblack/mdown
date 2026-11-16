import io,re
css = open('real/assets/app.css', encoding='utf-8').read()
html = open('real/index.html', encoding='utf-8').read()

NEW_CSS = '''/* ---------- hero lockup ----------
   One object, one em. The lockup sets its own type size here and every other
   number below is a multiple of it, so the mark, the gap and the tracking
   scale together at every width. There is no second clamp to keep in sync and
   nothing re-tuned at a breakpoint.
   The row aligns on the *baseline*, so the mark and the letters stand on the
   same line instead of being centred against each other. */
.hero-logo {
  display: flex; align-items: baseline; justify-content: center;
  gap: 0.3em;
  margin: 0 auto clamp(18px, 3vh, 28px);
  font-family: var(--mono);
  font-size: clamp(1.75rem, 4.2vw, 2.4rem);
  line-height: 1;            /* the lockup is exactly as tall as its type */
  color: var(--text);
}

/* The mark is a square sized straight off the type: 0.72em puts its foot on the
   baseline and its top just under the ascenders. Its artwork is drawn flush to
   the edges of that square (the viewBox is the ink box), so the square is all
   drawing and no padding. Stroke 2 on the 30-unit grid renders ~1.84px at the
   default size and stays proportional as the type shrinks. */
.hero-mark {
  flex: none;
  width: 0.72em; height: 0.72em;
}
.hero-mark svg {
  display: block; width: 100%; height: 100%;
  /* the arrow starts above the mark's box during its entrance; without this
     the svg viewport would cut it off. It paints inside the h1's own line box,
     never outside the lockup, and only while the gesture runs. */
  overflow: visible;
}

.hero-word {
  font-weight: 500;
  letter-spacing: -0.02em;   /* the same tracking .brand-text uses in the topbar */
  white-space: nowrap;       /* the lockup is one line at every width */
}
.hero-word-down { display: inline-block; }  /* only so it can carry a transform */
/* The dot is the accent, so the period is the one mark of colour on the page.
   In a monospaced cell the period sits left of centre, so its air is already
   tighter on the left than on the right; this gives back the difference and
   nothing else, which leaves the two gaps either side of it equal. */
.hero-word-dot { color: var(--accent); margin-right: -0.06em; }
/* the tld belongs to the name, not to a footnote: same size, same tracking,
   one step down in tone — the way .brand-sub sets it in the topbar */
.hero-word-tld { color: var(--text-3); }

/* Entrance: the arrow falls into the tray and "down" falls with it — the same
   distance (0.12em each: 5 of the mark's 30 units is 0.12em of its 0.72em),
   the same curve, the same 760ms, the word 60ms behind so it follows the
   arrow. Transform only, so it costs no layout and no text repaint, and the
   curve has no overshoot anywhere along it. */
.hero-logo { --hero-drop: 760ms; }
.mark-arrow { animation: hero-arrow var(--hero-drop) var(--ease) both; }
@keyframes hero-arrow {
  from { transform: translateY(-5px); }   /* 5 of 30 units = 0.12em */
  to   { transform: translateY(0); }
}
.hero-word-down { animation: hero-word var(--hero-drop) var(--ease) 60ms both; }
@keyframes hero-word {
  from { transform: translateY(-0.12em); }
  to   { transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .mark-arrow, .hero-word-down { animation: none; }
}
'''

start = css.index('/* one flow: the arrow rises')
end   = css.index('.hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }') + len('.hero-logo { margin-bottom: clamp(18px, 3vh, 28px); }')
css = css[:start] + NEW_CSS.rstrip('\n') + css[end:]

NEW_HTML = '''<h1 class="hero-logo">
      <span class="hero-mark" aria-hidden="true">
        <svg viewBox="1 1 30 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <!-- the arrow is its own group so it can travel into the tray: the
               mark reads as something being downloaded, not as a shape fading -->
          <g class="mark-arrow"><path d="M16 2v17"/><path d="m10.5 13.5 5.5 5.5 5.5-5.5"/></g>
          <path d="M2 20v7a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3v-7"/>
        </svg>
      </span>
      <span class="hero-word">m<span class="hero-word-down">down</span><span class="hero-word-dot">.</span><span class="hero-word-tld">cc</span></span>
      <span class="sr-only"> — a media downloader for video and audio</span>
    </h1>'''
hs = html.index('<h1 class="hero-logo">')
he = html.index('</h1>', hs) + len('</h1>')
html = html[:hs] + NEW_HTML + html[he:]

open('real/assets/app.css','w',encoding='utf-8').write(css)
open('real/index.html','w',encoding='utf-8').write(html)
print('patched')
