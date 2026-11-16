#!/usr/bin/env python3
"""Before-page probe (for honest before/after numbers) + a mobile frame harness."""
import re, pathlib

ROOT = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
OUT = pathlib.Path(__file__).resolve().parent

PROBE = (OUT / "build2.py").read_text().split('PROBE = """', 1)[1].split('"""', 1)[0]

css = (ROOT / "assets/app.css").read_text()
html = (ROOT / "index.html").read_text()
html = html.replace('<meta charset="utf-8">',
                    '<meta charset="utf-8">\n<base href="http://127.0.0.1:4331/">', 1)
html = re.sub(r'<link rel="stylesheet" href="assets/app.css[^"]*">',
              '<style>\n' + css + '\n</style>', html, count=1)
(OUT / "index-before-probe.html").write_text(html.replace("</body>", PROBE + "</body>", 1))

FRAMES = """<!doctype html><html><head><meta charset="utf-8"><title>frames</title>
<style>body{margin:0;background:#111;color:#ddd;font:11px monospace}iframe{border:0;display:block}
.wrap{display:inline-block;vertical-align:top;margin:0 8px}</style></head><body>
<pre id="log">…</pre>
<script>
const SRC = new URLSearchParams(location.search).get('src') || 'index-probe.html';
const WIDTHS = (new URLSearchParams(location.search).get('w') || '320,360,390').split(',').map(Number);
const slots = [];
for (const w of WIDTHS) {
  const box = document.createElement('div');
  box.className = 'wrap';
  const f = document.createElement('iframe');
  f.width = w; f.height = 720; f.src = SRC;
  box.appendChild(f);
  document.body.insertBefore(box, document.getElementById('log'));
  slots.push([w, f]);
}
const out = {};
const t0 = Date.now();
const tick = setInterval(() => {
  let done = 0;
  for (const [w, f] of slots) {
    try {
      const pre = f.contentDocument && f.contentDocument.getElementById('probe-out');
      if (pre) { out[w] = JSON.parse(pre.textContent); done++; }
    } catch (e) { out[w] = 'ERR ' + e.message; done++; }
  }
  if (done === slots.length || Date.now() - t0 > 12000) {
    clearInterval(tick);
    document.getElementById('log').textContent = JSON.stringify(out, null, 1);
  }
}, 200);
</script></body></html>"""
(OUT / "frames.html").write_text(FRAMES)
print("built before-probe + frames")
