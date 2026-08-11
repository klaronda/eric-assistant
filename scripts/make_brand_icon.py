"""Recolor a light-on-black isotype to a solid color on a square background.

Usage: python3 make_brand_icon.py SRC OUT [SIZE] [MARGIN] [FG_HEX] [BG_HEX]
"""

import sys
from PIL import Image


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


SRC = sys.argv[1]
OUT = sys.argv[2]
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
MARGIN_RATIO = float(sys.argv[4]) if len(sys.argv) > 4 else 0.12
FG = hex_rgb(sys.argv[5]) if len(sys.argv) > 5 else (0x27, 0x41, 0x44)
BG = hex_rgb(sys.argv[6]) if len(sys.argv) > 6 else (0xFA, 0xFA, 0xFA)

img = Image.open(SRC).convert("RGBA")
px = img.load()
w, h = img.size

# The shape is bright on a black background, so brightness is the mask.
# Contrast curve keeps the shape body fully opaque while smoothing edges.
LO, HI = 3.0, 60.0
for y in range(h):
    for x in range(w):
        r, g, b, _ = px[x, y]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        alpha = int(round(max(0.0, min(1.0, (lum - LO) / (HI - LO))) * 255))
        px[x, y] = (FG[0], FG[1], FG[2], alpha)

bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

# Scale to fit inside a square with margin, centered.
cw, ch = img.size
inner = int(SIZE * (1 - 2 * MARGIN_RATIO))
scale = min(inner / cw, inner / ch)
new_w, new_h = max(1, round(cw * scale)), max(1, round(ch * scale))
img = img.resize((new_w, new_h), Image.LANCZOS)

canvas = Image.new("RGBA", (SIZE, SIZE), (BG[0], BG[1], BG[2], 255))
canvas.alpha_composite(img, ((SIZE - new_w) // 2, (SIZE - new_h) // 2))
canvas.convert("RGB").save(OUT)
print(f"wrote {OUT} ({SIZE}x{SIZE}) fg={FG} bg={BG}")
