#!/usr/bin/env python3
"""ink boxes for a png: measure.py file.png [thresh] [maxgap]"""
import sys
from pngcrop import read

path = sys.argv[1]
thr = int(sys.argv[2]) if len(sys.argv) > 2 else 40
gap = int(sys.argv[3]) if len(sys.argv) > 3 else 14
w, h, nch, px = read(path)
cols = {}
for y in range(h):
    row = y * w * nch
    for x in range(w):
        i = row + x * nch
        if px[i] > thr or px[i + 1] > thr or px[i + 2] > thr:
            c = cols.get(x)
            if c is None:
                cols[x] = [y, y]
            else:
                if y < c[0]:
                    c[0] = y
                if y > c[1]:
                    c[1] = y
if not cols:
    print('no ink')
    raise SystemExit
xs = sorted(cols)
runs = []
start = prev = xs[0]
for x in xs[1:]:
    if x - prev > gap:
        runs.append((start, prev))
        start = x
    prev = x
runs.append((start, prev))
print('%dx%d  thresh=%d gap=%d' % (w, h, thr, gap))
for a, b in runs:
    top = min(cols[x][0] for x in range(a, b + 1) if x in cols)
    bot = max(cols[x][1] for x in range(a, b + 1) if x in cols)
    print('  x %4d..%-4d  w=%-4d  y %4d..%-4d  h=%d' % (a, b, b - a + 1, top, bot, bot - top + 1))
