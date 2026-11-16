#!/usr/bin/env python3
"""Decode a PNG with the stdlib and report ink rows/columns. No deps."""
import sys, zlib, struct


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            assert depth == 8 and interlace == 0, (depth, interlace)
            nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * nch
    out = bytearray(w * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            raise ValueError("filter %d" % f)
        prev = line
        # luminance from the first channel is enough on a dark monochrome page
        for x in range(w):
            out[y * w + x] = line[x * nch]
    return out, w, h


def ink(lum, w, h, x0, x1, y0, y1, thr=28):
    rows, cols = [], []
    for y in range(y0, min(y1, h)):
        n = sum(1 for x in range(x0, min(x1, w)) if lum[y * w + x] > thr)
        if n:
            rows.append((y, n))
    for x in range(x0, min(x1, w)):
        n = sum(1 for y in range(y0, min(y1, h)) if lum[y * w + x] > thr)
        if n:
            cols.append(x)
    return rows, cols


if __name__ == "__main__":
    path, x0, x1, y0, y1 = sys.argv[1], *map(int, sys.argv[2:6])
    scale = float(sys.argv[6]) if len(sys.argv) > 6 else 2.0
    lum, w, h = read_png(path)
    rows, cols = ink(lum, w, h, x0, x1, y0, y1)
    if not rows:
        print("no ink in region")
        raise SystemExit
    print("image %dx%d  region x%d-%d y%d-%d  scale %.0fx" % (w, h, x0, x1, y0, y1, scale))
    print("ink rows (css px): top %.1f  bottom %.1f  height %.1f"
          % (rows[0][0] / scale, (rows[-1][0] + 1) / scale, (rows[-1][0] + 1 - rows[0][0]) / scale))
    print("ink cols (css px): left %.1f  right %.1f  width %.1f"
          % (cols[0] / scale, (cols[-1] + 1) / scale, (cols[-1] + 1 - cols[0]) / scale))
    print("row profile (y_css: pixels):")
    for y, n in rows:
        print("  %6.1f  %3d  %s" % (y / scale, n, "#" * min(n, 120)))
