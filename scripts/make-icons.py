"""Renders the app icons (synthwave sun with a neon cloud over a grid) into public/icons/. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

SKY = [(0.0, "#0b0221"), (0.45, "#2b0b55"), (0.8, "#6b1468"), (1.0, "#ff3d8b")]
SUN = [(0.0, "#ffe45e"), (0.5, "#ff9a3d"), (1.0, "#ff2e88")]
PINK = (255, 47, 214)
CYAN = (45, 226, 230)
# Cloud as a box of width 1: base bar plus three bumps, (x, y, r) in cloud widths.
BUMPS = [(0.28, 0.36, 0.2), (0.56, 0.25, 0.25), (0.81, 0.4, 0.16)]


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gradient(stops, t):
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(rgb(c0), rgb(c1)))
    return rgb(stops[-1][1])


def cloud_mask(x0, y0, cw, grow=0):
    """Cloud silhouette `cw` pixels wide with its top-left at (x0, y0), widened by `grow` pixels."""
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([x0 - grow, y0 + 0.32 * cw - grow, x0 + cw + grow, y0 + 0.56 * cw + grow], radius=0.11 * cw + grow, fill=255)
    for bx, by, br in BUMPS:
        cx, cy, r = x0 + bx * cw, y0 + by * cw, br * cw + grow
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    return m


def render(maskable=False, small=False):
    """`maskable` keeps the motif inside the safe zone; `small` uses fewer, thicker lines for the favicon."""
    horizon = int(S * 0.68)
    img = Image.new("RGB", (S, S), "#150530")
    d = ImageDraw.Draw(img)
    for y in range(horizon):
        d.line([(0, y), (S, y)], fill=gradient(SKY, y / horizon))

    # Sun: vertical gradient, cut into stripes below its centre, clipped at the horizon.
    r = int(S * (0.25 if maskable else 0.31))
    cx, cy = int(S * (0.42 if maskable else 0.38)), horizon - int(r * 0.72)
    sun = Image.new("RGB", (S, S))
    sd = ImageDraw.Draw(sun)
    for y in range(cy - r, cy + r):
        sd.line([(0, y), (S, y)], fill=gradient(SUN, (y - cy + r) / (2 * r)))
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    y, i = cy + int(r * 0.08), 0
    bar, gap0, grow = (r * 0.2, r * 0.12, r * 0.04) if small else (r * 0.09, r * 0.025, r * 0.022)
    while y < horizon:
        gap = gap0 + i * grow
        md.rectangle([0, y + bar, S, y + bar + gap], fill=0)
        y, i = y + bar + gap, i + 1
    md.rectangle([0, horizon, S, S], fill=0)
    glow = mask.filter(ImageFilter.GaussianBlur(S * 0.05))
    img.paste(Image.new("RGB", (S, S), (255, 60, 140)), (0, 0), glow.point(lambda v: v * 0.6))
    img.paste(sun, (0, 0), mask)

    # Perspective grid on the floor, drawn once blurred for the glow and once crisp.
    lines = Image.new("L", (S, S), 0)
    ld = ImageDraw.Draw(lines)
    w = int(S * (0.016 if small else 0.008))
    rows, cols = (3, 5) if small else (7, 15)
    for k in range(rows + 1):
        yy = horizon + (S - horizon) * (k / rows) ** 1.8
        ld.line([(0, yy), (S, yy)], fill=255, width=w)
    for k in range(cols + 1):
        x = -S + 3 * S * k / cols
        ld.line([(S / 2 + (x - S / 2) * 0.12, horizon), (x, S)], fill=255, width=w)
    ld.line([(0, horizon), (S, horizon)], fill=255, width=w)
    halo = lines.filter(ImageFilter.GaussianBlur(w * 1.5))
    img.paste(Image.new("RGB", (S, S), PINK), (0, 0), ImageChops.lighter(halo, lines))

    # Neon cloud in front of the sun, so the icon reads as weather.
    cw = S * (0.42 if maskable else 0.52)
    x0, y0 = cx - r * 0.05, cy - cw * 0.2
    stroke = S * (0.045 if small else 0.022)
    outer = cloud_mask(x0, y0, cw, stroke)
    img.paste(Image.new("RGB", (S, S), CYAN), (0, 0), outer.filter(ImageFilter.GaussianBlur(stroke * 1.6)))
    img.paste(Image.new("RGB", (S, S), CYAN), (0, 0), outer)
    img.paste(Image.new("RGB", (S, S), "#14052c"), (0, 0), cloud_mask(x0, y0, cw))
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    base = render()
    for size, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
        base.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    render(maskable=True).resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)
    render(small=True).resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)


if __name__ == "__main__":
    main()
