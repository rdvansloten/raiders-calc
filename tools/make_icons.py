#!/usr/bin/env python3
"""Build favicon/app icons from pixel art.
Pure stdlib (zlib/struct) - no PIL required.
"""
import struct, sys, zlib
from math import gcd
from pathlib import Path

SAND = (0xF2, 0xE8, 0xD5, 0xFF)
root = Path(__file__).resolve().parent.parent
icons = root / "icons"


def decode_png(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, palette, trns = 8, b"", None, None
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8, f"unsupported bit depth {depth}"
        elif typ == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif typ == b"tRNS":
            trns = list(chunk)
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = w * ch
    px, prev = [], bytearray(stride)
    pos = 0
    for _ in range(h):
        f = raw[pos]; line = bytearray(raw[pos + 1:pos + 1 + stride]); pos += 1 + stride
        for i in range(stride):
            a = line[i - ch] if i >= ch else 0
            b = prev[i]
            c = prev[i - ch] if i >= ch else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else b if pb <= pc else c
                line[i] = (line[i] + pr) & 255
        prev = line
        row = []
        for x in range(w):
            v = line[x * ch:(x + 1) * ch]
            if ctype == 6: row.append(tuple(v))
            elif ctype == 2: row.append((v[0], v[1], v[2], 255))
            elif ctype == 0: row.append((v[0], v[0], v[0], 255))
            elif ctype == 4: row.append((v[0], v[0], v[0], v[1]))
            else:
                r, g, b2 = palette[v[0]]
                a2 = trns[v[0]] if trns and v[0] < len(trns) else 255
                row.append((r, g, b2, a2))
        px.append(row)
    return w, h, px


def encode_png(w, h, px, path):
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
    def chunk(typ, body):
        return struct.pack(">I", len(body)) + typ + body + \
               struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n" + \
        chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(out)
    print(f"wrote {path} ({len(out)} bytes)", file=sys.stderr)


def cell_size(w, h, px):
    """Pixel art is a coarse grid; find the cell size (gcd of same-color runs)."""
    g = 0
    for row in px:
        run, last = 1, row[0]
        for p in row[1:]:
            if p == last: run += 1
            else: g = gcd(g, run); run, last = 1, p
        g = gcd(g, run)
    for x in range(w):
        run, last = 1, px[0][x]
        for y in range(1, h):
            if px[y][x] == last: run += 1
            else: g = gcd(g, run); run, last = 1, px[y][x]
        g = gcd(g, run)
    return gcd(gcd(g, w), h) or 1


def to_svg(w, h, px, path):
    cs = cell_size(w, h, px)
    gw, gh = w // cs, h // cs
    rects = []
    for gy in range(gh):
        gx = 0
        while gx < gw:
            p = px[gy * cs][gx * cs]
            if p[3] == 0: gx += 1; continue
            x0 = gx
            while gx < gw and px[gy * cs][gx * cs] == p: gx += 1
            fill = f"#{p[0]:02X}{p[1]:02X}{p[2]:02X}"
            op = "" if p[3] == 255 else f' fill-opacity="{p[3]/255:.3f}"'
            rects.append(f'<rect x="{x0}" y="{gy}" width="{gx - x0}" height="1" fill="{fill}"{op}/>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {gw} {gh}" '
           f'shape-rendering="crispEdges">\n' + "\n".join(rects) + "\n</svg>\n")
    path.write_text(svg)
    print(f"wrote {path} ({len(svg)} bytes, {gw}x{gh} grid, cell {cs}px)", file=sys.stderr)


def compose(w, h, px, size, content, bg, path):
    """Nearest-neighbor scale to `content` height, center on size x size canvas."""
    scale = content / h
    cw = round(w * scale)
    canvas = [[bg] * size for _ in range(size)]
    ox, oy = (size - cw) // 2, (size - content) // 2
    for y in range(content):
        sy = min(h - 1, int(y / scale))
        for x in range(cw):
            p = px[sy][min(w - 1, int(x / scale))]
            if p[3] > 0:
                canvas[oy + y][ox + x] = p if p[3] == 255 or bg[3] == 0 else tuple(
                    (p[i] * p[3] + bg[i] * (255 - p[3])) // 255 for i in range(3)) + (255,)
    encode_png(size, size, canvas, path)


w, h, px = decode_png(icons / "squid-big.png")
to_svg(w, h, px, icons / "squid.svg")
compose(w, h, px, 32, 30, (0, 0, 0, 0), icons / "favicon-32.png")
compose(w, h, px, 180, 132, SAND, icons / "apple-touch-icon.png")
compose(w, h, px, 192, 140, SAND, icons / "icon-192.png")
compose(w, h, px, 512, 376, SAND, icons / "icon-512.png")
