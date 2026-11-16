#!/usr/bin/env python3
"""Copy a preview page, inject a layout probe, dump measurements via headless Chrome."""
import json
import re
import subprocess
import sys
import pathlib

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = r"""
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
  var out = {
    h1: r('.hero-logo'), mark: r('.hero-mark'), svg: r('.hero-mark svg'),
    word: r('.hero-word'), type: r('.hero-type'),
    dot: r('.hero-word-dot'), sub: r('.hero-word-sub'), m: r('.hero-word-m'), down: r('.hero-word-down'),
    hero: r('.hero'), composer: r('.composer'), vw: innerWidth, vh: innerHeight,
    h1center: (function(){ var b=document.querySelector('.hero-logo').getBoundingClientRect(); return +(b.x+b.width/2).toFixed(2); })()
  };
  var pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = JSON.stringify(out);
  document.documentElement.appendChild(pre);
})();
</script>
"""
