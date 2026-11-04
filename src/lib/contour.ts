// Turns a DWD radar tile (16-step dBZ rainbow) into neon contour bands:
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

// Resampled tiles may contain slightly off colours; the coverage outline (#fb00ff) must not match.
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

/** Rewrites the tile's pixels in place. */
export function contourTile(img: ImageData): void {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lv = new Uint8Array(n);
  for (let k = 0; k < n; k++) lv[k] = classify(data[k * 4], data[k * 4 + 1], data[k * 4 + 2], data[k * 4 + 3]);

  // An edge pixel belongs to a level and touches a lower one. Tile borders are not edges.
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

  for (let k = 0; k < n; k++) {
    const l = lv[k];
    let level = 0;
    let alpha = 0;
    if (l && l !== NO_DATA) {
      level = l;
      alpha = 30 + 14 * l;
    }
    if (edge[k]) {
      level = edge[k];
      alpha = 255;
    } else if (glow1[k] && glow1[k] >= level) {
      level = glow1[k];
      alpha = Math.max(alpha, 140);
    } else if (glow2[k] && glow2[k] >= level) {
      level = glow2[k];
      alpha = Math.max(alpha, 55);
    }
    const o = k * 4;
    if (level) {
      const c = NEON[level - 1];
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = alpha;
    } else if (l === NO_DATA) {
      // Outside the radar coverage: darken the map a little.
      data[o] = 5;
      data[o + 1] = 1;
      data[o + 2] = 18;
      data[o + 3] = 110;
    } else {
      data[o + 3] = 0;
    }
  }
}
