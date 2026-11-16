#!/bin/zsh
# usage: probe.sh <page-dir> <port> <width> <height>
set -e
DIR="$1"; PORT="$2"; W="$3"; H="$4"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 - "$DIR" <<'PY'
import sys, pathlib, re
src = pathlib.Path(sys.argv[1]) / "index.html"
s = src.read_text()
s = s.replace('href="./app.css', 'href="app.css').replace('href="assets/app.css', 'href="app.css')
probe = """
<script>
(function () {
  function r(sel) {
    var e = document.querySelector(sel);
    if (!e) return null;
    var b = e.getBoundingClientRect();
    var cs = getComputedStyle(e);
    return {x:+b.x.toFixed(2), y:+b.y.toFixed(2), w:+b.width.toFixed(2), h:+b.height.toFixed(2),
            fs:cs.fontSize, ls:cs.letterSpacing, fw:cs.fontWeight, col:cs.color};
  }
  var h = document.querySelector('.hero-logo');
  var hb = h.getBoundingClientRect();
  var out = {
    vw: innerWidth, vh: innerHeight,
    h1: r('.hero-logo'), mark: r('.hero-mark'), svg: r('.hero-mark svg'),
    word: r('.hero-word'), type: r('.hero-type'),
    dot: r('.hero-word-dot'), sub: r('.hero-word-sub'),
    hero: r('.hero'), composer: r('.composer'),
    h1center: +(hb.x + hb.width/2).toFixed(2),
    pagecenter: +(innerWidth/2).toFixed(2)
  };
  var pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = JSON.stringify(out);
  document.documentElement.appendChild(pre);
})();
</script>
"""
s = s.replace("</body>", probe + "</body>")
(src.parent / "probe.html").write_text(s)
PY
"$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=2500 \
  --force-device-scale-factor=2 --window-size="$W,$H" --dump-dom "http://127.0.0.1:$PORT/probe.html" 2>/dev/null \
  | python3 -c "import sys,re,json; m=re.search(r'<pre id=\"probe\">(.*?)</pre>', sys.stdin.read(), re.S); print(json.dumps(json.loads(m.group(1)), indent=1) if m else 'NO PROBE')"
