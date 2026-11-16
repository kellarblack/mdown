#!/bin/zsh
# usage: metrics.sh <page-dir> <port> <width> <height>
set -e
DIR="$1"; PORT="$2"; W="$3"; H="$4"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 - "$DIR" <<'PY'
import sys, pathlib, re
src = pathlib.Path(sys.argv[1]) / "index.html"
s = src.read_text()
s = re.sub(r'href="(\./)?assets/app\.css[^"]*"', 'href="app.css"', s)
probe = """
<script>
window.addEventListener('load', function () {
  function rect(sel) { var e = document.querySelector(sel); if (!e) return null;
    var b = e.getBoundingClientRect();
    return {x:+b.x.toFixed(2), y:+b.y.toFixed(2), w:+b.width.toFixed(2), h:+b.height.toFixed(2),
            bottom:+b.bottom.toFixed(2), right:+b.right.toFixed(2)}; }
  var word = document.querySelector('.hero-word');
  var cs = getComputedStyle(word);
  var c = document.createElement('canvas').getContext('2d');
  c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  var m = c.measureText('mdown');
  var fs = parseFloat(cs.fontSize), lh = parseFloat(getComputedStyle(document.querySelector('.hero-logo')).lineHeight);
  var A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
  var wb = word.getBoundingClientRect();
  var baseline = wb.top + (lh - (A + D)) / 2 + A;
  var inkAsc = m.actualBoundingBoxAscent;
  var mark = document.querySelector('.hero-mark svg');
  var arrow = document.querySelector('.mark-arrow');
  var tray = document.querySelectorAll('.hero-mark svg > path')[0];
  var ab = arrow.getBBox ? arrow.getBBox() : null;
  var svgBox = mark.getBoundingClientRect();
  var scale = svgBox.width / 24;
  var out = {
    vw: innerWidth, vh: innerHeight,
    h1: rect('.hero-logo'), markBox: rect('.hero-mark svg'), word: rect('.hero-word'),
    dot: rect('.hero-dot'), tld: rect('.hero-tld'),
    font: {family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, ls: cs.letterSpacing, lh: lh},
    metrics: {A:+A.toFixed(2), D:+D.toFixed(2), baselineY:+baseline.toFixed(2), inkAsc:+inkAsc.toFixed(2)},
    inkTopY: +(baseline - inkAsc).toFixed(2),
    trayY: +(svgBox.top + 19 * scale).toFixed(2),
    arrowTopY: +(svgBox.top + (3 - 0.9) * scale).toFixed(2),
    svgScale: +scale.toFixed(3),
    wordInk: {leftInkPad: 'n/a'}
  };
  var pre = document.createElement('pre'); pre.id = 'probe';
  pre.textContent = JSON.stringify(out); document.documentElement.appendChild(pre);
});
</script>
"""
s = s.replace("</body>", probe + "</body>")
(src.parent / "probe.html").write_text(s)
PY
"$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=2500 \
  --window-size="$W,$H" --dump-dom "http://127.0.0.1:$PORT/probe.html" 2>/dev/null \
  | python3 -c "import sys,re,json; m=re.search(r'<pre id=\"probe\">(.*?)</pre>', sys.stdin.read(), re.S); print(json.dumps(json.loads(m.group(1)), indent=1) if m else 'NO PROBE')"
