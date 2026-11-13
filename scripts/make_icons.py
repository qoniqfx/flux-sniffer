"""Generates extension/icons/{16,32,48,128}.png : a striped straw over a white line, on the Tally dark surface."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
S = 1024

BG, RED, WHITE = (14, 12, 13, 255), (214, 30, 38, 255), (250, 250, 250, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.24), fill=BG)

# the "line"
d.rounded_rectangle((int(S * .14), int(S * .70), int(S * .78), int(S * .79)), radius=int(S * .045), fill=WHITE)

# the straw: striped diagonal tube from top-right down to the line
x0, y0, x1, y1 = S * .82, S * .16, S * .34, S * .68
w = S * .15
n = 6
for i in range(n):
    a, b = i / n, (i + 1) / n
    p = (x0 + (x1 - x0) * a, y0 + (y1 - y0) * a)
    q = (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)
    ang = math.atan2(q[1] - p[1], q[0] - p[0]) + math.pi / 2
    dx, dy = math.cos(ang) * w / 2, math.sin(ang) * w / 2
    d.polygon([(p[0] - dx, p[1] - dy), (p[0] + dx, p[1] + dy), (q[0] + dx, q[1] + dy), (q[0] - dx, q[1] - dy)], fill=RED if i % 2 == 0 else WHITE)

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"{size}.png")
print("icons ->", OUT)
