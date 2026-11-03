"""Renders the app icons (synthwave sun with a chrome temperature over a grid) into public/icons/.
Requires Pillow and the Orbitron font from node_modules (npm install)."""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S = 1024
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
FONT = ROOT / "node_modules" / "@fontsource" / "orbitron" / "files" / "orbitron-latin-900-normal.woff"

SKY = [(0.0, "#0b0221"), (0.45, "#2b0b55"), (0.8, "#6b1468"), (1.0, "#ff3d8b")]
SUN = [(0.0, "#ffe45e"), (0.5, "#ff9a3d"), (1.0, "#ff2e88")]
PINK = (255, 47, 214)
# Same chrome as the temperature on the home screen.
CHROME = [(0.0, "#ffffff"), (0.44, "#bfe9ff"), (0.5, "#3a1d7a"), (0.56, "#ff7bd5"), (1.0, "#fff3fb")]


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gradient(stops, t):
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(rgb(c0), rgb(c1)))
    return rgb(stops[-1][1])


def render(maskable=False, small=False):
    """`maskable` keeps the motif inside the safe zone; `small` uses fewer, thicker lines for the favicon."""
    horizon = int(S * 0.68)
    img = Image.new("RGB", (S, S), "#150530")
    d = ImageDraw.Draw(img)
    for y in range(horizon):
        d.line([(0, y), (S, y)], fill=gradient(SKY, y / horizon))

    # Sun: vertical gradient, cut into stripes below its centre, clipped at the horizon.
    r = int(S * (0.25 if maskable else 0.31))
    cx, cy = S // 2, horizon - int(r * 0.72)
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

    # Chrome "17°" on the sun, so the icon reads as weather. Letters are spaced by hand,
    # since Orbitron's "1" and "7" touch at this weight.
    text, tw = "17°", S * (0.56 if maskable else 0.84 if small else 0.7)
    stroke = int(S * (0.03 if small else 0.016))
    font = ImageFont.truetype(str(FONT), 400)
    gap = font.size * 0.1
    width = sum(font.getlength(ch) for ch in text) + gap * (len(text) - 1)
    font = ImageFont.truetype(str(FONT), int(400 * tw / width))
    gap = font.size * 0.1
    fill, outline = Image.new("L", (S, S), 0), Image.new("L", (S, S), 0)
    x = 0
    for ch in text:
        ImageDraw.Draw(fill).text((x, S / 2), ch, font=font, anchor="ls", fill=255)
        ImageDraw.Draw(outline).text((x, S / 2), ch, font=font, anchor="ls", fill=255, stroke_width=stroke, stroke_fill=255)
        x += font.getlength(ch) + gap
    l, t, rr, b = fill.getbbox()
    dx, dy = int(cx - (l + rr) / 2), int(cy - r * 0.08 - (t + b) / 2)
    fill, outline = ImageChops.offset(fill, dx, dy), ImageChops.offset(outline, dx, dy)
    img.paste(Image.new("RGB", (S, S), PINK), (0, 0), outline.filter(ImageFilter.GaussianBlur(stroke * 2.5)))
    img.paste(Image.new("RGB", (S, S), "#1a0533"), (0, 0), outline)
    top, bottom = fill.getbbox()[1], fill.getbbox()[3]
    chrome = Image.new("RGB", (S, S))
    cd = ImageDraw.Draw(chrome)
    for y in range(top, bottom):
        cd.line([(0, y), (S, y)], fill=gradient(CHROME, (y - top) / (bottom - top)))
    img.paste(chrome, (0, 0), fill)
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
