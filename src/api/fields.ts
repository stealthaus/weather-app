// Hourly model fields (clouds, temperature, wind) for the radar map, from Open-Meteo.
// Open-Meteo has no gridded endpoint, so the map asks for the points of a regular lattice
// in one multi-location request. Every location counts as one API call (limit: 600 per
// minute), so the lattice is coarse (lib/field smooths it), points are cached, the lattices
// of neighbouring zoom levels share their points, and requests keep to a budget per minute.

import { getJson, HttpError } from '../lib/http';

export type FieldKind = 'clouds' | 'temp' | 'wind';

const HOUR_MS = 60 * 60 * 1000;
const PAST_HOURS = 2;
/** Covers the radar's longest time axis (to the end of the third day after today). */
const FORECAST_HOURS = 100;
/** Cached points are refreshed after this; the models run every 1–3 hours. */
const MAX_AGE_MS = 45 * 60 * 1000;
/** Locations per request; keeps the URL short. */
const CHUNK = 200;
/** Locations per rolling minute; Open-Meteo allows 600, the rest is headroom for the other views. */
const BUDGET = 450;
/** Small requests (the coarse preview after zooming out) may use part of that headroom. */
const SMALL = 40;
const SMALL_BUDGET = 560;
const MINUTE_MS = 60 * 1000;
/** Finest lattice spacing in degrees (ICON-EU has ~0.06°, so finer only adds API calls). */
const MIN_SPACING = 1 / 16;

interface Series {
  /** Start of the first hour (ms). */
  t0: number;
  clouds: Float32Array;
  temp: Float32Array;
  /** km/h */
  speed: Float32Array;
  /** Wind vector in km/h, pointing where the wind blows to (u east, v north). */
  u: Float32Array;
  v: Float32Array;
  loaded: number;
}

interface OmPoint {
  hourly: {
    time: number[];
    cloud_cover: (number | null)[];
    temperature_2m: (number | null)[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
  };
}

/** Lives across mounts of the radar view, so switching tabs costs no new API calls. */
const points = new Map<string, Series>();
const pointKey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
/** Points of requests still running, so a newer view waits for them instead of asking again. */
const pending = new Map<string, Promise<unknown>>();
/** Locations requested in the last minute. */
const spent: { t: number; n: number }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `n` more locations fit into the budget of the last minute; false if cancelled meanwhile. */
async function budget(n: number, signal: { cancelled: boolean }): Promise<boolean> {
  for (;;) {
    if (signal.cancelled) return false;
    const now = Date.now();
    while (spent.length && now - spent[0].t > MINUTE_MS) spent.shift();
    const used = spent.reduce((a, s) => a + s.n, 0);
    if (!spent.length || used + n <= (n <= SMALL ? SMALL_BUDGET : BUDGET)) {
      spent.push({ t: now, n });
      return true;
    }
    await sleep(Math.min(5000, spent[0].t + MINUTE_MS - now + 200));
  }
}

/** Hourly values on a regular lat/lon lattice, indexed [hour][row][col], rows from south to north. */
export interface FieldGrid {
  south: number;
  west: number;
  /** Lattice spacing in degrees (same for lat and lon). */
  step: number;
  nx: number;
  ny: number;
  t0: number;
  hours: number;
  clouds: Float32Array;
  temp: Float32Array;
  speed: Float32Array;
  u: Float32Array;
  v: Float32Array;
}

/**
 * Lattice spacing for a zoom level, a power of two in degrees: one point about every 80 screen pixels,
 * zoomed far out every 110 px (whole continents in view, where details matter less than loading fast).
 */
export function latticeStep(zoom: number): number {
  const deg = ((zoom <= 5 ? 110 : 80) * 360) / (256 * 2 ** zoom);
  return Math.max(MIN_SPACING, 2 ** Math.round(Math.log2(deg)));
}

function toSeries(p: OmPoint): Series {
  const h = p.hourly;
  const n = h.time.length;
  const f = (a: (number | null)[]) => Float32Array.from({ length: n }, (_, i) => a[i] ?? NaN);
  const speed = f(h.wind_speed_10m);
  const dir = f(h.wind_direction_10m);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Meteorological direction is where the wind comes from.
    const r = (dir[i] * Math.PI) / 180;
    u[i] = -speed[i] * Math.sin(r);
    v[i] = -speed[i] * Math.cos(r);
  }
  return { t0: h.time[0] * 1000, clouds: f(h.cloud_cover), temp: f(h.temperature_2m), speed, u, v, loaded: Date.now() };
}

/** One request; after "too many requests" it waits and tries again. */
async function fetchChunk(chunk: [number, number][], signal: { cancelled: boolean }): Promise<void> {
  // Coarse lattices reach past the poles and the date line (e.g. −192°); Open-Meteo only takes ±90 / ±180.
  const lat = (v: number) => Math.max(-90, Math.min(90, v));
  const lon = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${chunk.map((p) => lat(p[0])).join(',')}&longitude=${chunk.map((p) => lon(p[1])).join(',')}` +
    '&hourly=cloud_cover,temperature_2m,wind_speed_10m,wind_direction_10m' +
    `&past_hours=${PAST_HOURS}&forecast_hours=${FORECAST_HOURS}&timeformat=unixtime&timezone=GMT`;
  for (let attempt = 0; ; attempt++) {
    if (!(await budget(chunk.length, signal))) return;
    try {
      const res = await getJson<OmPoint | OmPoint[]>(url, 30000);
      const arr = Array.isArray(res) ? res : [res];
      arr.forEach((p, j) => points.set(pointKey(...chunk[j]), toSeries(p)));
      return;
    } catch (e) {
      // Only the per-minute limit is worth waiting for; the hourly and daily ones are not.
      if (!(e instanceof HttpError && e.status === 429) || /hourly|daily/i.test(e.message) || attempt >= 3) throw e;
      // Someone else (another tab, another view) used up the minute: count it as full and wait.
      spent.push({ t: Date.now(), n: BUDGET });
      await sleep(15000 * (attempt + 1));
    }
  }
}

async function fetchPoints(list: [number, number][], signal: { cancelled: boolean }): Promise<void> {
  for (let i = 0; i < list.length && !signal.cancelled; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const req = fetchChunk(chunk, signal);
    for (const p of chunk) pending.set(pointKey(...p), req);
    try {
      await req;
    } finally {
      for (const p of chunk) if (pending.get(pointKey(...p)) === req) pending.delete(pointKey(...p));
    }
  }
}

/**
 * Loads the lattice points (spacing `step`) covering `area` and assembles them into a grid.
 * Only points that are not cached (or too old) are requested.
 */
export async function fieldGrid(
  area: { south: number; west: number; north: number; east: number },
  step: number,
  signal: { cancelled: boolean },
): Promise<FieldGrid | null> {
  // Not clamped to the map's ±85°, so every lattice stays aligned with the finer ones.
  const s0 = Math.floor(area.south / step) * step;
  const n0 = Math.ceil(area.north / step) * step;
  const w0 = Math.floor(area.west / step) * step;
  const e0 = Math.ceil(area.east / step) * step;
  const nx = Math.round((e0 - w0) / step) + 1;
  const ny = Math.round((n0 - s0) / step) + 1;
  const now = Date.now();
  // Second round: points a cancelled older request left out while this one waited for it.
  for (let round = 0; round < 2; round++) {
    const missing: [number, number][] = [];
    const running = new Set<Promise<unknown>>();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const lat = s0 + y * step;
        const lon = w0 + x * step;
        const k = pointKey(lat, lon);
        const p = points.get(k);
        const r = pending.get(k);
        if (r) running.add(r);
        else if (!p || now - p.loaded > MAX_AGE_MS) missing.push([lat, lon]);
      }
    }
    if (!missing.length && !running.size) break;
    await Promise.all([fetchPoints(missing, signal), Promise.allSettled(running)]);
    if (signal.cancelled) return null;
  }

  // Align every point on the newest common start hour.
  const t0 = Math.floor(now / HOUR_MS) * HOUR_MS - PAST_HOURS * HOUR_MS;
  const hours = PAST_HOURS + FORECAST_HOURS;
  const size = nx * ny;
  const grid: FieldGrid = {
    south: s0,
    west: w0,
    step,
    nx,
    ny,
    t0,
    hours,
    clouds: new Float32Array(hours * size).fill(NaN),
    temp: new Float32Array(hours * size).fill(NaN),
    speed: new Float32Array(hours * size).fill(NaN),
    u: new Float32Array(hours * size).fill(NaN),
    v: new Float32Array(hours * size).fill(NaN),
  };
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = points.get(pointKey(s0 + y * step, w0 + x * step));
      if (!p) continue;
      const shift = Math.round((t0 - p.t0) / HOUR_MS);
      const k = y * nx + x;
      for (let h = 0; h < hours; h++) {
        const i = h + shift;
        if (i < 0 || i >= p.temp.length) continue;
        const o = h * size + k;
        grid.clouds[o] = p.clouds[i];
        grid.temp[o] = p.temp[i];
        grid.speed[o] = p.speed[i];
        grid.u[o] = p.u[i];
        grid.v[o] = p.v[i];
      }
    }
  }
  return grid;
}

/** Number of lattice points an area needs at a spacing (to pick a coarser one on big screens). */
export function latticeSize(area: { south: number; west: number; north: number; east: number }, step: number): number {
  const nx = Math.ceil(area.east / step) - Math.floor(area.west / step) + 1;
  const ny = Math.ceil(area.north / step) - Math.floor(area.south / step) + 1;
  return nx * ny;
}
