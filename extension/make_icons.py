#!/usr/bin/env python3
"""
Generate simple placeholder icons for ScrollSense.
Run once: python3 make_icons.py
"""
import os, struct, zlib

def make_png(size, bg=(99, 102, 241), fg=(255,255,255)):
    """Create a minimal solid-color PNG with a simple 'S' mark."""
    w = h = size
    # Raw pixel data: RGBA
    pixels = []
    cx, cy = w // 2, h // 2
    r = w * 0.38

    for y in range(h):
        row = []
        for x in range(w):
            dx, dy = x - cx, y - cy
            dist = (dx*dx + dy*dy) ** 0.5
            if dist <= r:
                row += list(bg) + [255]
            else:
                row += [0, 0, 0, 0]
        pixels.append(bytes([0] + row))  # filter byte

    raw = b"".join(pixels)

    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", c)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )

os.makedirs("icons", exist_ok=True)
for size in [16, 48, 128]:
    with open(f"icons/icon{size}.png", "wb") as f:
        f.write(make_png(size))
    print(f"Created icons/icon{size}.png")

print("Icons generated successfully.")
