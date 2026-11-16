import re, sys, pathlib
root = pathlib.Path("/Users/kellarblack/Documents/Default Project/mdown")
src = (root / "index.html").read_text()
out = src
out = re.sub(r'(href|src)="assets/', r'\1="/assets/', out)
out = out.replace('href="manifest.webmanifest"', 'href="/manifest.webmanifest"')
# inject extra css + body class for variants
extra = pathlib.Path(sys.argv[2]).read_text() if len(sys.argv) > 2 and sys.argv[2] != '-' else ""
if extra:
    out = out.replace("</head>", "<style>\n" + extra + "\n</style>\n</head>", 1)
pathlib.Path(sys.argv[1]).write_text(out)
print("wrote", sys.argv[1], len(out))
