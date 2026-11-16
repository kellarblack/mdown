import pathlib

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
SCRATCH = ROOT / ".arena/run-20261116-125725-s386339/scratch/a009"
html = (ROOT / "index.html").read_text()
html = html.replace('href="assets/', 'href="/assets/').replace('src="assets/', 'src="/assets/')

OLD_HERO_START = '    <h1 class="hero-logo">'
OLD_HERO_END = '    </h1>'
i = html.index(OLD_HERO_START)
j = html.index(OLD_HERO_END, i) + len(OLD_HERO_END)
OLD_HERO = html[i:j]

NEW_HERO = '''    <h1 class="hero-logo">
      <span class="hero-mark" aria-hidden="true">
        <!-- the arrow is its own group so it can travel down into the tray;
             the extra 3 units of height at the top of the box are its runway -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <g class="mark-arrow"><path d="M12 4.25V16"/><path d="M6.4 10.4l5.6 5.6 5.6-5.6"/></g>
          <path class="mark-tray" d="M1.25 18.75v4h21.5v-4"/>
        </svg>
      </span><span class="hero-word">mdown<span class="hero-word-dot">.</span><span class="hero-word-sub">cc</span></span><span class="sr-only"> — a media downloader for video and audio</span>
    </h1>'''

NEW_CSS = r'''
.hero-logo {
  --logo: clamp(1.75rem, 4.2vw, 2.4rem);
  display: flex; align-items: baseline; justify-content: center;
  gap: 0.22em;
  margin: 0 auto clamp(18px, 3vh, 28px);
  font-size: var(--logo);
  color: var(--text);
}
.hero-mark { display: inline-block; flex: none; line-height: 0; width: auto; height: auto; }
.hero-mark svg { display: inline; vertical-align: baseline; width: 0.86em; height: 0.86em; }
.hero-word {
  font-family: var(--mono); font-weight: 500; font-size: 1em; line-height: 1;
  letter-spacing: 0; white-space: nowrap;
}
.hero-word-dot { color: var(--accent); margin-inline: -0.125em; }
.hero-word-sub {
  font-size: 0.7em; font-weight: 400; color: var(--text-2);
  letter-spacing: 0.035em; margin-left: 0.06em;
}
.hero-logo { animation: hero-ink 620ms var(--ease) both; }
.mark-arrow { animation: arrow-seat 620ms var(--ease) both; }
@keyframes hero-ink { from { opacity: 0; } to { opacity: 1; } }
@keyframes arrow-seat {
  from { transform: translateY(-3px); }
  to   { transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-logo, .mark-arrow { animation: none; }
}
'''

MEASURE = """<pre id="__m" hidden></pre>
<script>
addEventListener('load', () => {
  const r = (el) => el.getBoundingClientRect();
  const word = document.querySelector('.hero-word');
  const svg = document.querySelector('.hero-mark svg');
  const logo = document.querySelector('.hero-logo');
  const comp = document.querySelector('.composer');
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
  word.appendChild(probe);
  const base = r(probe).bottom;
  probe.remove();
  const cs = getComputedStyle(word);
  // animation geometry: pin the arrow at t=0 and t=end
  const arrow = document.querySelector('.mark-arrow');
  const anims = document.getAnimations().filter(a => a.animationName === 'arrow-seat');
  let a0 = null, a1 = null;
  if (anims.length) {
    anims[0].pause(); anims[0].currentTime = 0;
    a0 = +r(arrow).top.toFixed(2);
    anims[0].currentTime = 620;
    a1 = +r(arrow).top.toFixed(2);
  }
  const out = {
    vw: innerWidth, font: cs.fontSize,
    baseline: +base.toFixed(2),
    trayVsBaseline: +(r(svg).bottom - base).toFixed(2),
    markBox: +r(svg).width.toFixed(2),
    markInk: +((24 - 3) / 24 * r(svg).height).toFixed(2),
    gapPx: +(r(word).left - r(svg).right).toFixed(2),
    logoH: +r(logo).height.toFixed(2), composerTop: +r(comp).top.toFixed(2),
    lockupW: +(r(word).right - r(svg).left).toFixed(2),
    overflowX: document.documentElement.scrollWidth - innerWidth,
    arrowStartTop: a0, arrowEndTop: a1,
    arrowHeadroom: a0 === null ? null : +(a1 - a0).toFixed(2),
    arrowInBoxAtStart: a0 === null ? null : +(a0 - r(svg).top).toFixed(2),
    name: logo.textContent.replace(/\\s+/g, ' ').trim(),
    theme: document.documentElement.dataset.theme || '(none)',
  };
  document.getElementById('__m').textContent = JSON.stringify(out);
});
</script>
"""

(SCRATCH / "page-old.html").write_text(html.replace("</body>", MEASURE + "\n</body>"))
new = html.replace(OLD_HERO, NEW_HERO).replace("</head>", f"<style>{NEW_CSS}</style>\n</head>")
(SCRATCH / "page-new.html").write_text(new.replace("</body>", MEASURE + "\n</body>"))
print("ok", len(OLD_HERO))
