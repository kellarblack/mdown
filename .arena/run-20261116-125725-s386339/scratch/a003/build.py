#!/usr/bin/env python3
"""Swap the hero block (markup + css) in the preview copies.

usage: build.py <variant> <css-file>
"""
import pathlib
import re
import sys

here = pathlib.Path(__file__).parent
variant = here / (sys.argv[1] + ".html")
css_new = pathlib.Path(sys.argv[2]).read_text().strip()

# markup
for d in ("new",):
    p = here / d / "index.html"
    s = p.read_text()
    s = re.sub(r'<h1 class="hero-logo">.*?</h1>', variant.read_text().strip(), s, flags=re.S)
    p.write_text(s)
    print("markup ->", p)

# css
p = here / "new" / "app.css"
s = p.read_text()
start = s.index(".hero { width: 100%; }")
end = s.index(".meta-line {")
s = s[:start] + css_new + "\n\n" + s[end:]
p.write_text(s)
print("css ->", p)
