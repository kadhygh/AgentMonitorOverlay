# AppIcon.png (1024, opaque) from studio/design/icon/tools/studio.svg: python make-icon.py iosApp/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import sys
from PIL import Image, ImageDraw
SS = 4; N = 1024 * SS
img = Image.new('RGB', (N, N), (0xf3, 0xf1, 0xec))
d = ImageDraw.Draw(img)
k = 864 / 464 * SS; off = 80 * SS
def P(x, y): return ((x - 24) * k + off, (y - 24) * k + off)
def quad(a, c, b, n=24):
    return [((1-t)**2*a[0] + 2*(1-t)*t*c[0] + t*t*b[0], (1-t)**2*a[1] + 2*(1-t)*t*c[1] + t*t*b[1]) for t in [i/n for i in range(n+1)]]
corners = [
  [(80,168),(80,96)] + quad((80,96),(80,80),(96,80))[1:] + [(168,80)],
  [(344,80),(416,80)] + quad((416,80),(432,80),(432,96))[1:] + [(432,168)],
  [(432,344),(432,416)] + quad((432,416),(432,432),(416,432))[1:] + [(344,432)],
  [(168,432),(96,432)] + quad((96,432),(80,432),(80,416))[1:] + [(80,344)],
]
def stroke(pts, width, color):
    # A round brush stamped along the path: clean joints and round caps at any angle.
    r = width * k / 2; q = [P(*p) for p in pts]
    for (ax, ay), (bx, by) in zip(q, q[1:]):
        n = max(1, int(((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 / 2))
        for i in range(n + 1):
            x = ax + (bx - ax) * i / n; y = ay + (by - ay) * i / n
            d.ellipse((x - r, y - r, x + r, y + r), fill=color)
# The 0.9-opacity ivory halo is invisible on a light background; only the ink.
for c in corners: stroke(c, 28, (0x22, 0x20, 0x1c))
x0, y0 = P(140, 140); x1, y1 = P(372, 372)
d.rounded_rectangle((x0, y0, x1, y1), radius=62 * k, fill=(0x2f, 0x5a, 0x92))
def G(x, y): return (256 + x * 0.78, 256 + y * 0.78)
for cx in (-52, 52):
    x, y = P(*G(cx, -22)); r = 32.3 * 0.78 * k
    d.ellipse((x - r, y - r, x + r, y + r), fill=(0xfb, 0xfa, 0xf7))
stroke([G(*p) for p in quad((-62, 46), (0, 92), (62, 46))], 34 * 0.78, (0xfb, 0xfa, 0xf7))
img.resize((1024, 1024), Image.LANCZOS).save(sys.argv[1])
