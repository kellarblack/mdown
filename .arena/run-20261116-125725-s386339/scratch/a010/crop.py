#!/usr/bin/env python3
"""Crop a PNG region and write it back as a greyscale PNG (stdlib only)."""
import sys, zlib, struct
sys.path.insert(0, "/Users/kellarblack/Documents/Default Project/mdown/.arena/run-20261116-125725-s386339/scratch/a010")
from png_ink import read_png


def write_png(path, rows):
    h = len(rows); w = len(rows[0])
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    open(path, "wb").write(png)


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    x0, x1, y0, y1 = map(int, sys.argv[3:7])
    lum, w, h = read_png(src)
    rows = [[lum[y * w + x] for x in range(x0, min(x1, w))] for y in range(y0, min(y1, h))]
    write_png(out, rows)
    print(out, len(rows[0]), "x", len(rows))
