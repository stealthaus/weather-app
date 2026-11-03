"""Renders the app icons (ensemble band motif) into public/icons/. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def smooth(points, steps=12):
    """Catmull-Rom spline through points for soft curves."""
    out = []
    pts = [points[0]] + points + [points[-1]]
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for t in [j / steps for j in range(steps)]:
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
                for k in range(2)))
    out.append(points[-1])
    return out


def band(draw, xs, mid, spread, fill_band, fill_line, width):
    upper = smooth([(x, m - s) for x, m, s in zip(xs, mid, spread)])
    lower = smooth([(x, m + s) for x, m, s in zip(xs, mid, spread)])
    draw.polygon(upper + lower[::-1], fill=fill_band)
    draw.line(smooth(list(zip(xs, mid))), fill=fill_line, width=width, joint="curve")


def render(maskable=False):
    img = Image.new("RGB", (S, S), "#f6f5f1")
    d = ImageDraw.Draw(img, "RGBA")
    pad = 230 if maskable else 150
    xs = [pad + i * (S - 2 * pad) / 6 for i in range(7)]
    k = (S - 2 * pad) / 724
    sp = [12, 16, 22, 34, 50, 70, 92]
    band(d, xs, [430 + v * k for v in (0, -20, 10, -30, -10, -40, -30)], [s * k for s in sp], (240, 153, 123, 120), "#b8431f", int(26 * k))
    band(d, xs, [650 + v * k for v in (0, 10, -10, 5, -15, 0, -10)], [s * k for s in sp], (133, 183, 235, 140), "#185fa5", int(26 * k))
    d.line([(pad, S - pad + 40 * k), (S - pad, S - pad + 40 * k)], fill="#1c1c1a", width=int(14 * k))
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    base = render()
    for size, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
        base.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    render(maskable=True).resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)


if __name__ == "__main__":
    main()
