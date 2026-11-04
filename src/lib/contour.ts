// Turns a DWD radar image (16-step dBZ rainbow) into neon contour bands:
// four intensity levels, each drawn as a faint fill with a glowing outline.

import { DBZ_COLORS } from '../api/radar';

/** Neon colour per level (1 = leicht … 4 = Hagel möglich). */
export const LEVEL_COLORS = ['#2de2e6', '#8f7bff', '#ff2fd6', '#f9c80e'];
/** Index of the first DBZ_COLORS entry of each level: <23.5, <37, <55, ≥55 dBZ. */
const LEVEL_START = [0, 5, 8, 12];
const NO_DATA = 255;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const NEON = LEVEL_COLORS.map(rgb);
const PALETTE = [...DBZ_COLORS, '#000000'].map((hex, i) => ({
  rgb: rgb(hex),
  level: LEVEL_START.filter((s) => i >= s).length,
}));

// Resampled images may contain slightly off colours; the coverage outline (#fb00ff) must not match.
const MAX_DIST2 = 40 * 40;
const cache = new Map<number, number>();

function classify(r: number, g: number, b: number, a: number): number {
  if (a < 128) return 0;
  // "No data" outside the radar coverage is a half-transparent grey.
  if (a < 250 && Math.abs(r - 125) < 8 && Math.abs(g - 125) < 8 && Math.abs(b - 125) < 8) return NO_DATA;
  const key = (r << 16) | (g << 8) | b;
  let level = cache.get(key);
  if (level === undefined) {
    level = 0;
    let best = MAX_DIST2;
    for (const p of PALETTE) {
      const d = (p.rgb[0] - r) ** 2 + (p.rgb[1] - g) ** 2 + (p.rgb[2] - b) ** 2;
      if (d < best) {
        best = d;
        level = p.level;
      }
    }
    cache.set(key, level);
  }
  return level;
}

/** 3×3 maximum filter, done as two 1-D passes. */
function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      tmp[k] = Math.max(src[k], x > 0 ? src[k - 1] : 0, x < w - 1 ? src[k + 1] : 0);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      out[k] = Math.max(tmp[k], y > 0 ? tmp[k - w] : 0, y < h - 1 ? tmp[k + w] : 0);
    }
  }
  return out;
}

// Each pixel is stored as one byte ("code") so that many frames fit in memory:
// 0 = transparent, 1 = outside radar coverage, then four looks per level (fill, outer glow, inner glow, edge).
const OUTSIDE = 1;
const FILL = 0;
const GLOW2 = 1;
const GLOW1 = 2;
const EDGE = 3;
const code = (level: number, look: number) => 2 + (level - 1) * 4 + look;

/** RGBA per code. */
const LUT = new Uint8ClampedArray(256 * 4);
LUT.set([5, 1, 18, 110], OUTSIDE * 4); // darkens the map a little
NEON.forEach((c, i) => {
  const level = i + 1;
  const fill = 30 + 14 * level;
  [fill, Math.max(55, fill), 140, 255].forEach((alpha, look) => LUT.set([...c, alpha], code(level, look) * 4));
});

/** Classifies a DWD radar image into contour codes (one byte per pixel). */
export function contourCodes(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lv = new Uint8Array(n);
  for (let k = 0; k < n; k++) lv[k] = classify(data[k * 4], data[k * 4 + 1], data[k * 4 + 2], data[k * 4 + 3]);

  // An edge pixel belongs to a level and touches a lower one. Image borders are not edges.
  const below = (k: number, l: number) => (lv[k] === NO_DATA ? 0 : lv[k]) < l;
  const edge = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const l = lv[k];
      if (!l || l === NO_DATA) continue;
      if ((x > 0 && below(k - 1, l)) || (x < w - 1 && below(k + 1, l)) || (y > 0 && below(k - w, l)) || (y < h - 1 && below(k + w, l))) edge[k] = l;
    }
  }
  const glow1 = dilate(edge, w, h);
  const glow2 = dilate(glow1, w, h);

  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const l = lv[k];
    const level = l === NO_DATA ? 0 : l;
    if (edge[k]) out[k] = code(edge[k], EDGE);
    else if (glow1[k] && glow1[k] >= level) out[k] = code(glow1[k], GLOW1);
    else if (glow2[k] && glow2[k] >= level) out[k] = code(glow2[k], GLOW2);
    else if (level) out[k] = code(level, FILL);
    else if (l === NO_DATA) out[k] = OUTSIDE;
  }
  return out;
}

/** Paints contour codes into an ImageData of the same size. */
export function paintCodes(codes: Uint8Array, img: ImageData): void {
  const d = img.data;
  for (let k = 0, o = 0; k < codes.length; k++, o += 4) {
    const c = codes[k] * 4;
    d[o] = LUT[c];
    d[o + 1] = LUT[c + 1];
    d[o + 2] = LUT[c + 2];
    d[o + 3] = LUT[c + 3];
  }
}
