#!/usr/bin/env python3
"""Inline app.css into one page inside an assembled site.

A landing page pays a round trip for a blocking stylesheet before it can paint
anything. The tip page is small, is usually a first visit, and has no other page
to share that cache with, so it ships the CSS inside the HTML: one request, one
parse, and the page paints with the markup it already has.

    python3 tools/inline_css.py _site donate.html

Only the assembled `_site` is touched; the source page keeps its <link> so local
preview and the tests behave normally.
"""

import pathlib
import re
import sys


def main() -> int:
    site = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_site")
    page_name = sys.argv[2] if len(sys.argv) > 2 else "donate.html"
    page = site / page_name
    css_file = site / "assets" / "app.css"

    if not page.exists() or not css_file.exists():
        print("inline_css: missing %s or %s" % (page, css_file))
        return 1

    html = page.read_text(encoding="utf-8")
    css = css_file.read_text(encoding="utf-8")
    pattern = re.compile(r'<link rel="stylesheet" href="assets/app\.css\?v=\d+">')
    new, count = pattern.subn("<style>" + css + "</style>", html, count=1)
    if count != 1:
        print("inline_css: no stylesheet link in %s" % page_name)
        return 1

    page.write_text(new, encoding="utf-8")
    print("inline_css: %s now carries %d bytes of CSS" % (page_name, len(css)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
