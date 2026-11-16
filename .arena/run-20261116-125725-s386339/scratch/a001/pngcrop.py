#!/usr/bin/env python3
"""crop a PNG: pngcrop.py in.png out.png x y w h   (pure stdlib)"""
import struct, sys, zlib


def read(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    i, idat, hdr = 8, b'', None
    while i < len(d):
        ln = struct.unpack('>I', d[i:i + 4])[0]
        typ = d[i + 4:i + 8]
        body = d[i + 8:i + 8 + ln]
        if typ == b'IHDR':
            hdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
        i += 12 + ln
    w, h, depth, ctype, comp, filt, il = hdr
    assert depth == 8 and il == 0 and ctype in (2, 6), hdr
    nch = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if f == 1:
            for x in range(nch, stride):
                line[x] = (line[x] + line[x - nch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                c = prev[x - nch] if x >= nch else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, nch, out


def write(path, w, h, nch, px):
    ctype = 2 if nch == 3 else 6
    stride = w * nch
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


if __name__ == '__main__':
    src, dst, x, y, cw, ch = sys.argv[1], sys.argv[2], *[int(v) for v in sys.argv[3:7]]
    w, h, nch, px = read(src)
    x = max(0, x); y = max(0, y)
    cwd = min(cw, w - x); chd = min(ch, h - y)
    stride = w * nch
    out = bytearray()
    for yy in range(y, y + chd):
        out += px[yy * stride + x * nch: yy * stride + (x + cwd) * nch]
    write(dst, cwd, chd, nch, out)
    print('%dx%d -> %dx%d @%d,%d' % (w, h, cwd, chd, x, y))
