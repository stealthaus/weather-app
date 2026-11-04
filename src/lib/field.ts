// Paints an hourly model field (clouds, temperature, wind) into a canvas image:
// bilinear between lattice points, linear between hours, with glowing isolines
// in the same neon look as the rain contours.

import type { FieldGrid, FieldKind } from '../api/fields';
import { tempRgb } from './tempscale';

const HOUR_MS = 60 * 60 * 1000;
type RGB = [number, number, number];

/** Isotherms every 2 °C. */
const TEMP_STEP = 2;
/** Wind isolines (km/h): roughly Beaufort 2–9. */
export const WIND_LEVELS = [10, 20, 30, 40, 50, 60, 75, 90, 110];

const WIND_STOPS: [number, RGB][] = [
  [0, [60, 70, 170]],
  [15, [45, 226, 230]], // cyan
  [30, [143, 123, 255]], // violet
  [50, [255, 47, 214]], // pink
  [75, [249, 200, 14]], // yellow
  [100, [255, 255, 255]],
];

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (v <= v1) {
      const [v0, c0] = stops[i - 1];
      const f = (v - v0) / (v1 - v0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as RGB;
    }
  }
  return stops[stops.length - 1][1];
}

export const windRgb = (kmh: number) => ramp(WIND_STOPS, kmh);
const CLOUD_RGB: RGB = [228, 220, 255];

/** Colour lookup table, so painting does not build a colour per pixel. Returns the RGB offset for a value. */
interface Lut {
  rgb: Uint8Array;
  at: (v: number) => number;
}
function lut(fn: (v: number) => RGB, lo: number, hi: number, perUnit: number): Lut {
  const n = Math.round((hi - lo) * perUnit) + 1;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set(fn(lo + i / perUnit), i * 3);
  return { rgb, at: (v) => Math.min(n - 1, Math.max(0, Math.round((v - lo) * perUnit))) * 3 };
}
const TEMP_LUT = lut(tempRgb, -50, 50, 4);
const WIND_LUT = lut(windRgb, 0, 200, 2);

/** CSS gradient for the legend of a field. */
export function legendGradient(kind: FieldKind): string {
  const css = (c: RGB, a = 1) => `rgba(${c.join(',')},${a})`;
  if (kind === 'clouds') return `linear-gradient(90deg, ${css(CLOUD_RGB, 0)}, ${css(CLOUD_RGB, 0.35)}, ${css(CLOUD_RGB, 0.9)})`;
  const [lo, hi, rgb]: [number, number, (v: number) => RGB] = kind === 'temp' ? [-10, 30, tempRgb] : [0, 100, windRgb];
  const stops = Array.from({ length: 11 }, (_, i) => `${css(rgb(lo + ((hi - lo) * i) / 10))} ${i * 10}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** Fractional hour index of `t` in the grid, clamped to its range. */
function hourPos(g: FieldGrid, t: number): [number, number, number] {
  const f = Math.min(g.hours - 1, Math.max(0, (t - g.t0) / HOUR_MS));
  const h0 = Math.floor(f);
  return [h0, Math.min(g.hours - 1, h0 + 1), f - h0];
}

/** One variable on the lattice at time `t`. */
function slice(g: FieldGrid, arr: Float32Array, t: number): Float32Array {
  const [h0, h1, a] = hourPos(g, t);
  const n = g.nx * g.ny;
  const out = new Float32Array(n);
  const o0 = h0 * n;
  const o1 = h1 * n;
  for (let k = 0; k < n; k++) out[k] = arr[o0 + k] * (1 - a) + arr[o1 + k] * a;
  return out;
}

/** Bilinear value at a fractional lattice position; NaN outside the grid or next to a missing point. */
function bilinear(s: Float32Array, nx: number, ny: number, fx: number, fy: number): number {
  if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return NaN;
  const x0 = Math.min(nx - 2, Math.floor(fx));
  const y0 = Math.min(ny - 2, Math.floor(fy));
  const ax = fx - x0;
  const ay = fy - y0;
  const k = y0 * nx + x0;
  const top = s[k] * (1 - ax) + s[k + 1] * ax;
  const bottom = s[k + nx] * (1 - ax) + s[k + nx + 1] * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Value at a place and time, plus the direction the wind blows to (degrees from north) for wind. */
export function sampleField(g: FieldGrid, kind: FieldKind, lat: number, lon: number, t: number): { value: number; to?: number } {
  const fx = (lon - g.west) / g.step;
  const fy = (lat - g.south) / g.step;
  const at = (arr: Float32Array) => {
    const [h0, h1, a] = hourPos(g, t);
    const n = g.nx * g.ny;
    const v0 = bilinear(arr.subarray(h0 * n, h0 * n + n), g.nx, g.ny, fx, fy);
    const v1 = bilinear(arr.subarray(h1 * n, h1 * n + n), g.nx, g.ny, fx, fy);
    return v0 * (1 - a) + v1 * a;
  };
  if (kind === 'clouds') return { value: at(g.clouds) };
  if (kind === 'temp') return { value: at(g.temp) };
  const u = at(g.u);
  const v = at(g.v);
  return { value: at(g.speed), to: (Math.atan2(u, v) * 180) / Math.PI };
}

/**
 * Paints the field at time `t` into `out`. `rowLat` and `colLon` give the latitude of every image
 * row and the longitude of every column (the image is in Web Mercator).
 */
export function renderField(g: FieldGrid, kind: FieldKind, t: number, rowLat: Float64Array, colLon: Float64Array, out: ImageData): void {
  const { width: w, height: h, data } = out;
  const s = slice(g, kind === 'clouds' ? g.clouds : kind === 'temp' ? g.temp : g.speed, t);
  const n = w * h;
  const val = new Float32Array(n);
  const fxs = Float64Array.from(colLon, (lon) => (lon - g.west) / g.step);
  for (let y = 0; y < h; y++) {
    const fy = (rowLat[y] - g.south) / g.step;
    const row = y * w;
    for (let x = 0; x < w; x++) val[row + x] = bilinear(s, g.nx, g.ny, fxs[x], fy);
  }

  // Band per pixel for the isolines; -1 = no data.
  const band = new Int16Array(n).fill(-1);
  if (kind !== 'clouds') {
    for (let k = 0; k < n; k++) {
      const v = val[k];
      if (Number.isNaN(v)) continue;
      if (kind === 'temp') band[k] = Math.floor(v / TEMP_STEP) + 1000;
      else {
        let b = 0;
        while (b < WIND_LEVELS.length && v >= WIND_LEVELS[b]) b++;
        band[k] = b;
      }
    }
  }
  // Line on the higher side of a band change, faint glow on the pixels next to it.
  const line = new Uint8Array(n);
  if (kind !== 'clouds') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        const b = band[k];
        if (b < 0) continue;
        const lower = (j: number) => band[j] >= 0 && band[j] < b;
        if ((x > 0 && lower(k - 1)) || (x < w - 1 && lower(k + 1)) || (y > 0 && lower(k - w)) || (y < h - 1 && lower(k + w))) line[k] = 2;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (line[k]) continue;
        if ((x > 0 && line[k - 1] === 2) || (x < w - 1 && line[k + 1] === 2) || (y > 0 && line[k - w] === 2) || (y < h - 1 && line[k + w] === 2)) line[k] = 1;
      }
    }
  }

  for (let k = 0, o = 0; k < n; k++, o += 4) {
    const v = val[k];
    if (Number.isNaN(v)) {
      data[o + 3] = 0;
      continue;
    }
    let r: number;
    let gr: number;
    let b: number;
    let a: number;
    if (kind === 'clouds') {
      [r, gr, b] = CLOUD_RGB;
      a = 200 * Math.pow(Math.min(100, Math.max(0, v)) / 100, 1.6);
    } else {
      const l = kind === 'temp' ? TEMP_LUT : WIND_LUT;
      const i = l.at(v);
      r = l.rgb[i];
      gr = l.rgb[i + 1];
      b = l.rgb[i + 2];
      a = kind === 'temp' ? 92 : 24 + 96 * Math.min(1, v / 50);
      // The freezing line stands out in white.
      if (kind === 'temp' && line[k] === 2 && band[k] === 1000) r = gr = b = 255;
    }
    if (line[k] === 2) a = 235;
    else if (line[k] === 1) a = Math.max(a, 130);
    data[o] = r;
    data[o + 1] = gr;
    data[o + 2] = b;
    data[o + 3] = a;
  }
}
