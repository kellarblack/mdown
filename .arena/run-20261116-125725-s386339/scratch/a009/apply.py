"""End-to-end check of the delivered blocks: splice them into real copies of
index.html / app.css exactly as the answer says, then measure."""
import re, pathlib

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
SCRATCH = ROOT / ".arena/run-20261116-125725-s386339/scratch/a009"
ANSWER = ROOT / ".arena/run-20261116-125725-s386339/r0/a009.md"

md = ANSWER.read_text()
html_block = re.search(r"```html\n(.*?)```", md, re.S).group(1)
css_block = re.search(r"```css\n(.*?)```", md, re.S).group(1)
assert "footer-meta" not in css_block, "stray rule in the CSS block"

# --- index.html -------------------------------------------------------------
html = (ROOT / "index.html").read_text()
start = html.index('    <h1 class="hero-logo">')
end = html.index("    </h1>", start) + len("    </h1>")
html_new = html[:start] + html_block.rstrip("\n") + html[end:]
assert html_new != html

# --- app.css ----------------------------------------------------------------
css = (ROOT / "assets/app.css").read_text()
lines = css.splitlines(keepends=True)
# the block: from '.hero { width: 100%; }' to the second '.hero-logo { margin-bottom'
i = next(n for n, l in enumerate(lines) if l.startswith(".hero { width: 100%; }"))
j = next(n for n, l in enumerate(lines) if l.startswith(".hero-logo { margin-bottom:"))
assert lines[j + 1].strip() == "" and lines[j + 2].startswith(".meta-line"), (j, lines[j+1], lines[j+2])
print("block lines (1-based):", i + 1, "-", j + 1)
spliced = "".join(lines[:i]) + css_block.strip() + "\n" + "".join(lines[j + 1:])
# nothing outside the hero block may differ
print("removed:", repr("".join(lines[i:j + 1]))[:80], "...", j - i + 1, "lines")

# --- assemble a testable page ----------------------------------------------
import re as _re
html_new, n = _re.subn(r'href="(?:/)?assets/app\.css[^"]*"', 'href="./app-md.css"', html_new)
print("css links rewritten:", n)
html_new = html_new.replace('href="assets/', 'href="/assets/').replace('src="assets/', 'src="/assets/')

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
  const arrow = document.querySelector('.mark-arrow');
  const a = document.getAnimations().filter(x => x.animationName === 'arrow-seat');
  let start = null, end = null;
  if (a.length) { a[0].pause(); a[0].currentTime = 0; start = r(arrow).top; a[0].currentTime = 620; end = r(arrow).top; }
  document.getElementById('__m').textContent = JSON.stringify({
    vw: innerWidth, font: cs.fontSize,
    trayVsBaseline: +(r(svg).bottom - base).toFixed(2),
    markBox: +r(svg).width.toFixed(2),
    markInk: +((24 - 3) / 24 * r(svg).height).toFixed(2),
    gapPx: +(r(word).left - r(svg).right).toFixed(2),
    logoH: +r(logo).height.toFixed(2), composerTop: +r(comp).top.toFixed(2),
    lockupW: +(r(word).right - r(svg).left).toFixed(2),
    overflowX: document.documentElement.scrollWidth - innerWidth,
    travel: start === null ? null : +(end - start).toFixed(2),
    strokeInkTopAtStart: start === null ? null : +(start - r(svg).top).toFixed(2),
    dotColor: getComputedStyle(document.querySelector('.hero-word-dot')).color,
    subColor: getComputedStyle(document.querySelector('.hero-word-sub')).color,
    name: logo.textContent.replace(/\\s+/g, ' ').trim(),
  });
});
</script>
"""

(SCRATCH / "app-md.css").write_text(spliced)
(SCRATCH / "page-md.html").write_text(html_new.replace("</body>", MEASURE + "\n</body>"))
print("wrote app-md.css + page-md.html")
