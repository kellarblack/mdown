#!/usr/bin/env python3
"""Build lockup cards for shooting: python3 card.py <hero-markup-file> <out.html> [css]"""
import pathlib
import sys

here = pathlib.Path(__file__).parent
markup = pathlib.Path(sys.argv[1]).read_text().strip()
out = pathlib.Path(sys.argv[2])
tpl = (here / "card.tpl.html").read_text()
page = tpl.replace("<!--HERO-->", markup)
if len(sys.argv) > 3:
    page = page.replace('href="app.css"', 'href="%s"' % sys.argv[3])
out.write_text(page)
print("wrote", out)
