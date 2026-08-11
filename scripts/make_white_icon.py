"""Turn the lotus line-art into a square, white, transparent PNG icon."""

import sys
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2]
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
MARGIN_RATIO = float(sys.argv[4]) if len(sys.argv) > 4 else 0.12

img = Image.open(SRC).convert("RGBA")
px = img.load()
w, h = img.size

# Recolor: white background -> transparent, colored line art -> white.
# Alpha is driven by how far a pixel is from white (luminance), which keeps the
# anti-aliased edges smooth.
# Contrast curve so the line cores become fully opaque white while the
# anti-aliased edges keep a smooth ramp.
LO, HI = 12.0, 130.0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        raw = 255 - lum
        alpha = int(round(max(0.0, min(1.0, (raw - LO) / (HI - LO))) * 255))
        px[x, y] = (255, 255, 255, alpha)

# Crop to the visible artwork.
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

# Center on a square, transparent canvas with a margin.
cw, ch = img.size
inner = int(SIZE * (1 - 2 * MARGIN_RATIO))
scale = min(inner / cw, inner / ch)
new_w, new_h = max(1, round(cw * scale)), max(1, round(ch * scale))
img = img.resize((new_w, new_h), Image.LANCZOS)

canvas = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
canvas.paste(img, ((SIZE - new_w) // 2, (SIZE - new_h) // 2), img)
canvas.save(OUT)
print(f"wrote {OUT} ({SIZE}x{SIZE})")
