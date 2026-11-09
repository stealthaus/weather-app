import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fieldGrid, latticeSize, latticeStep, type FieldGrid, type FieldKind } from '../api/fields';
import { GLOBAL_LAYER, globalTime, RADAR_DOMAIN, radarFrames, radarImageUrl, type RadarFrame } from '../api/radar';
import { addBasemap, BASEMAP_ATTRIBUTION, fitMinZoom, MAP_BOUNDS } from '../lib/basemap';
import { contourCodes, coverageMask, GLOBAL_PALETTE, LEVEL_COLORS, MODEL_PALETTE, paintCodes, RADAR_PALETTE, SNOW_COLOR, type Palette, type SnowCells } from '../lib/contour';
import { legendGradient, renderField, sampleField, snowMask } from '../lib/field';
import { hhmm } from '../lib/format';
import { HttpError } from '../lib/http';
import type { Place } from '../lib/places';

const LEVEL_NAMES = ['LEICHT', 'MÄSSIG', 'STARK', 'HAGEL'];
const PAST_MIN = 60;
const STEPS = [5, 15, 30, 60] as const;
type Step = (typeof STEPS)[number];
const HOUR_MS = 60 * 60 * 1000;
/**
 * Last frame time for each step. Beyond the 2 h nowcast, hourly model frames take over;
 * the hourly step reaches to the end of the third day after today.
 */
const HORIZON: Record<Step, (analysis: Date) => number> = {
  5: (a) => a.getTime() + 2 * HOUR_MS,
  15: (a) => a.getTime() + 2 * HOUR_MS,
  30: (a) => a.getTime() + 6 * HOUR_MS,
  60: (a) => {
    const end = new Date(a);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 4);
    return end.getTime() - HOUR_MS;
  },
};
const stepLabel = (s: Step) => (s < 60 ? `${s}M` : `${s / 60}H`);

type Kind = 'rain' | FieldKind;
const KINDS: { kind: Kind; label: string; name: string }[] = [
  { kind: 'rain', label: 'REGEN', name: 'Regen' },
  { kind: 'clouds', label: 'WOLKEN', name: 'Wolken' },
  { kind: 'temp', label: 'TEMP', name: 'Temperatur' },
  { kind: 'wind', label: 'WIND', name: 'Wind' },
];
const FIELD_LEGEND: Record<FieldKind, [string, string]> = {
  clouds: ['0 %', '100 %'],
  temp: ['−10°', '30°'],
  wind: ['0', '100 KM/H'],
};

/** Long time axes play faster, so three days take about 25 seconds. */
const frameMs = (n: number) => (n > 40 ? 300 : 500);
const PREF_STEP = 'wx.radar.step';
const PREF_KIND = 'wx.radar.kind';
/** The DWD GeoServer is slow (0.5–2 s per image); more parallel requests only queue up. */
const PARALLEL = 4;
/** Extra margin around the viewport, so small pans need no reload. */
const PAD = 0.2;
/** Caps image size on large screens (server time and memory grow with the pixel count). */
const MAX_PIXELS = 1_000_000;
/** ICON-EU has a ~7 km grid: fewer pixels look the same and the DWD answers about twice as fast. */
const MODEL_MAX_PIXELS = 300_000;
/** The ICON global grid is ~28 km, so its images can be coarser. */
const GLOBAL_MAX_PIXELS = 400_000;
/** Model images change with every new run (ICON-EU every 3 h), so kept ones are loaded again after this. */
const MODEL_MAX_AGE_MS = HOUR_MS;
/** Model fields are smooth: about half the CSS resolution on a phone, so a frame paints in a few ms. */
const FIELD_MAX_PIXELS = 150_000;
/** Open-Meteo counts every lattice point as one API call (600 per minute). */
const MAX_FIELD_POINTS = 250;
/** Snow or rain is decided per block of 2^SNOW_SHIFT × 2^SNOW_SHIFT image pixels (the model is far coarser). */
const SNOW_SHIFT = 2;
/** Distance of the value labels on the map in screen pixels. */
const LABEL_DX = 84;
const LABEL_DY = 76;

const DOMAIN = L.latLngBounds([RADAR_DOMAIN.south, RADAR_DOMAIN.west], [RADAR_DOMAIN.north, RADAR_DOMAIN.east]);
const WORLD = L.latLngBounds([-85, -180], [85, 180]);

/** Area and resolution of one set of radar images. */
interface View {
  zoom: number;
  /** Covered area in layer pixels at `zoom`. */
  px: L.Bounds;
  bounds: L.LatLngBounds;
  w: number;
  h: number;
}

/** A loaded frame, one contour code per pixel (see lib/contour). */
interface FrameData {
  view: View;
  codes: Uint8Array;
  /** After this the frame is loaded again (model runs); Infinity for measurements and nowcasts. */
  expires: number;
}

/** One image to download. */
interface Job {
  key: string;
  layer: string;
  time: Date;
  view: View;
  palette: Palette;
  expires: number;
}

/** A canvas on the map that shows one loaded frame. */
interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  overlay: L.SVGOverlay;
  shown: { view: View; img: ImageData } | null;
}

/** Faint neon grid that moves with the map. */
class GridLines extends L.GridLayer {
  createTile(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'grid-tile';
    return d;
  }
}

/** "−0:40", " 0:00", "+1:20" */
function counter(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? '−' : min > 0 ? '+' : ' '}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/** "DO 05.11." */
const dayLabel = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', '').toUpperCase();
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function saved<T>(key: string, valid: readonly T[], parse: (v: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw == null ? fallback : parse(raw);
    return valid.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function loadImage(url: string, inflight: Set<HTMLImageElement>): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      inflight.delete(img);
      resolve(img);
    };
    img.onerror = () => {
      inflight.delete(img);
      reject(new Error('radar image failed'));
    };
    inflight.add(img);
    img.src = url;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Loaded frames by layer and time, kept across mounts of the view: switching tabs and back costs
 * no new downloads (the DWD needs 0.5–2 s per image). Nowcast keys contain their analysis time,
 * so a newer measurement replaces them; model frames expire.
 */
const cache = new Map<string, FrameData>();
/** Areas the cached frames were loaded for (radar, ICON-EU, ICON global); kept with the cache. */
const views: { radar: View | null; model: View | null; world: View | null } = { radar: null, model: null, world: null };

export function mountRadar(el: HTMLElement, place: Place): () => void {
  let step = saved<Step>(PREF_STEP, STEPS, Number as (v: string) => Step, 15);
  let kind = saved<Kind>(
    PREF_KIND,
    KINDS.map((k) => k.kind),
    (v) => v as Kind,
    'rain',
  );
  el.innerHTML = `
    <div class="radar-wrap">
      <div id="map"></div>
      <div class="radar-scan" aria-hidden="true"></div>
      <div class="radar-loading" role="progressbar" aria-label="Karte lädt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span class="radar-loading-label">TRACKING</span>
        <span class="radar-loading-pct">0%</span>
        <span class="radar-loading-bar"><i></i></span>
      </div>
      <div class="osd osd-mode" aria-live="polite">LÄDT …</div>
      <div class="osd osd-clock"><span class="radar-time">–:–</span><small class="radar-day">${dayLabel(new Date())}</small></div>
      <div class="osd radar-progress" hidden></div>
      <div class="radar-notice" role="status" hidden></div>
      <div class="radar-steps" role="group" aria-label="Zeitschritt">
        ${STEPS.map((s) => `<button type="button" data-step="${s}" aria-pressed="${s === step}" aria-label="${s < 60 ? `${s} Minuten` : `${s / 60} Stunde`}">${stepLabel(s)}</button>`).join('')}
      </div>
      <div class="radar-panel">
        <div class="radar-kinds" role="group" aria-label="Kartenebene">
          ${KINDS.map((k) => `<button type="button" data-kind="${k.kind}" aria-pressed="${k.kind === kind}" aria-label="${k.name}">${k.label}</button>`).join('')}
        </div>
        <div class="radar-row">
          <button type="button" class="vhs-key" aria-label="Animation abspielen">▶</button>
          <div class="tape">
            <div class="tape-bars" aria-hidden="true"></div>
            <input type="range" min="0" max="0" value="0" step="1" aria-label="Zeitpunkt" />
            <div class="tape-days" role="group" aria-label="Tag wählen"></div>
          </div>
          <span class="tape-counter"> 0:00</span>
        </div>
        <div class="radar-legend"></div>
      </div>
    </div>`;

  const map = L.map(el.querySelector<HTMLElement>('#map')!, {
    zoomControl: false,
    attributionControl: true,
    minZoom: 2,
    maxZoom: 11,
    maxBounds: MAP_BOUNDS,
    maxBoundsViscosity: 1,
    // At the zoom limit just stop; the bounce back looked like the map zooming in by itself.
    bounceAtZoomLimits: false,
  }).setView([place.lat, place.lon], 8);
  map.attributionControl.setPrefix(false);
  // The field layers show no DWD data, so each layer names only its own source.
  const RAIN_ATTRIBUTION = `${BASEMAP_ATTRIBUTION} · Radar © <a href="https://www.dwd.de">DWD</a> · Schnee © <a href="https://open-meteo.com">Open-Meteo</a>`;
  const FIELD_ATTRIBUTION = `${BASEMAP_ATTRIBUTION} · Modell © <a href="https://open-meteo.com">Open-Meteo</a>`;

  addBasemap(map, [place.lat, place.lon]);
  new GridLines({ tileSize: 128, zIndex: 2 }).addTo(map);
  // Value labels of the model fields sit below the location dot.
  const labels = L.layerGroup().addTo(map);
  L.marker([place.lat, place.lon], {
    icon: L.divIcon({ className: '', html: '<div class="loc-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
  }).addTo(map);

  // Two canvases show the current rain frame: ICON global below (whole world, coarse) and the radar or
  // ICON-EU frame above (radar domain). A third one shows the model fields. SVGOverlay positions any
  // element like an image (including zoom animation), so it can carry a canvas.
  const layer = (): Layer => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const overlay = L.svgOverlay(canvas as unknown as SVGElement, DOMAIN, { interactive: false }).addTo(map);
    return { canvas, ctx: canvas.getContext('2d')!, overlay, shown: null };
  };
  const world = layer();
  const fine = layer();
  const field = layer();
  // Where the fine frame has data; cut out of the global layer so the rain is not shown twice.
  const mask = document.createElement('canvas');
  const mctx = mask.getContext('2d')!;
  let maskImg: ImageData | null = null;
  // Scratch canvas to read the pixels of a downloaded image.
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

  const panel = {
    play: el.querySelector<HTMLButtonElement>('.vhs-key')!,
    range: el.querySelector<HTMLInputElement>('input[type=range]')!,
    bars: el.querySelector<HTMLElement>('.tape-bars')!,
    days: el.querySelector<HTMLElement>('.tape-days')!,
    row: el.querySelector<HTMLElement>('.radar-row')!,
    counter: el.querySelector<HTMLElement>('.tape-counter')!,
    time: el.querySelector<HTMLElement>('.radar-time')!,
    day: el.querySelector<HTMLElement>('.radar-day')!,
    mode: el.querySelector<HTMLElement>('.osd-mode')!,
    progress: el.querySelector<HTMLElement>('.radar-progress')!,
    loading: el.querySelector<HTMLElement>('.radar-loading')!,
    loadingPct: el.querySelector<HTMLElement>('.radar-loading-pct')!,
    loadingBar: el.querySelector<HTMLElement>('.radar-loading-bar i')!,
    steps: el.querySelector<HTMLElement>('.radar-steps')!,
    kinds: el.querySelector<HTMLElement>('.radar-kinds')!,
    legend: el.querySelector<HTMLElement>('.radar-legend')!,
    map: el.querySelector<HTMLElement>('#map')!,
    notice: el.querySelector<HTMLElement>('.radar-notice')!,
  };

  let frames: RadarFrame[] = [];
  const key = (f: RadarFrame) => `${f.layer}|${f.time.getTime()}|${f.issued}`;
  const worldKey = (f: RadarFrame) => `${GLOBAL_LAYER}|${globalTime(f.time).getTime()}`;
  let nowIdx = 0;
  let index = 0;
  let timer = 0;
  let alive = true;
  /** Incremented on every reload; older downloads see the mismatch and stop. */
  let generation = 0;
  const inflight = new Set<HTMLImageElement>();

  /** Model fields: canvas area, latitude/longitude per canvas row/column, and the newest loaded grid. */
  let fieldView: View | null = null;
  let fieldAxes: { rowLat: Float64Array; colLon: Float64Array } | null = null;
  let grid: FieldGrid | null = null;
  let fieldRequest: { cancelled: boolean } | null = null;
  let fieldLabels: { el: HTMLElement; lat: number; lon: number }[] = [];
  /** Open-Meteo's hourly/daily limit was reached for the current grid: until when (0: not). */
  let gridLimited = 0;
  let limitTimer = 0;

  /** Big notice while the limit blocks the model fields; loads again by itself once it is over. */
  const showLimit = () => {
    clearTimeout(limitTimer);
    const on = kind !== 'rain' && gridLimited > Date.now();
    panel.notice.hidden = !on;
    if (!on) return;
    const some = !!grid && grid.temp.some((v) => !Number.isNaN(v));
    panel.notice.innerHTML =
      '<b>OPEN-METEO-LIMIT</b>' +
      `<span>Wolken, Temperatur und Wind wieder ab ${hhmm(new Date(gridLimited))}.</span>` +
      `<span>${some ? 'Zu sehen ist, was im Gerät gespeichert ist. ' : ''}Regen läuft weiter.</span>`;
    limitTimer = window.setTimeout(() => {
      gridLimited = 0;
      showLimit();
      sync();
    }, gridLimited - Date.now() + 1000);
  };

  // ---- drawing --------------------------------------------------------------

  /** Latitude of every row and longitude of every column when a view is drawn `w` × `h` large. */
  const axes = (v: View, w: number, h: number) => {
    const rowLat = new Float64Array(h);
    const colLon = new Float64Array(w);
    const sx = (v.px.max!.x - v.px.min!.x) / w;
    const sy = (v.px.max!.y - v.px.min!.y) / h;
    for (let y = 0; y < h; y++) rowLat[y] = map.unproject([v.px.min!.x, v.px.min!.y + (y + 0.5) * sy], v.zoom).lat;
    for (let x = 0; x < w; x++) colLon[x] = map.unproject([v.px.min!.x + (x + 0.5) * sx, v.px.min!.y], v.zoom).lng;
    return { rowLat, colLon };
  };
  const snowAxes = new WeakMap<View, { rowLat: Float64Array; colLon: Float64Array }>();

  /** Snow cells for a rain view at time `t` from the model grid; null if there is no snow (or no grid). */
  const snowCells = (v: View, t: number): SnowCells | null => {
    if (!grid) return null;
    let a = snowAxes.get(v);
    if (!a) {
      a = axes(v, Math.ceil(v.w / 2 ** SNOW_SHIFT), Math.ceil(v.h / 2 ** SNOW_SHIFT));
      snowAxes.set(v, a);
    }
    const cells = new Uint8Array(a.rowLat.length * a.colLon.length);
    snowMask(grid, t, a.rowLat, a.colLon, cells);
    return cells.includes(1) ? { cells, w: a.colLon.length, shift: SNOW_SHIFT } : null;
  };

  const clear = (l: Layer) => l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);

  /** Sizes a layer's canvas for a view. */
  const fit = (l: Layer, v: View): ImageData => {
    if (l.shown?.view !== v) {
      l.canvas.width = v.w;
      l.canvas.height = v.h;
      l.overlay.setBounds(v.bounds);
      l.shown = { view: v, img: l.ctx.createImageData(v.w, v.h) };
    }
    return l.shown.img;
  };

  /** Draws a loaded frame into a layer (snow in its own colours); false if there is nothing to draw. */
  const draw = (l: Layer, d: FrameData | undefined, t: number): boolean => {
    if (!d) {
      clear(l);
      return false;
    }
    const img = fit(l, d.view);
    paintCodes(d.codes, img, snowCells(d.view, t));
    l.ctx.putImageData(img, 0, 0);
    return true;
  };

  const paintRain = (f: RadarFrame) => {
    const d = f.layer ? cache.get(key(f)) : undefined;
    const g = cache.get(worldKey(f));
    const t = f.time.getTime();
    draw(fine, d, t);
    if (!draw(world, g, t) || !g || !d || d.view.zoom !== g.view.zoom) return;
    const { w, h, px } = d.view;
    if (mask.width !== w || mask.height !== h || !maskImg) {
      mask.width = w;
      mask.height = h;
      maskImg = mctx.createImageData(w, h);
    }
    coverageMask(d.codes, w, h, f.model, maskImg);
    mctx.putImageData(maskImg, 0, 0);
    const gp = g.view.px;
    const sx = g.view.w / (gp.max!.x - gp.min!.x);
    const sy = g.view.h / (gp.max!.y - gp.min!.y);
    const c = world.ctx;
    c.globalCompositeOperation = 'destination-out';
    c.imageSmoothingEnabled = false;
    c.drawImage(mask, (px.min!.x - gp.min!.x) * sx, (px.min!.y - gp.min!.y) * sy, (px.max!.x - px.min!.x) * sx, (px.max!.y - px.min!.y) * sy);
    c.globalCompositeOperation = 'source-over';
  };

  const paintField = (k: FieldKind, f: RadarFrame) => {
    if (!grid || !fieldView || !fieldAxes) return clear(field);
    const img = fit(field, fieldView);
    const t = f.time.getTime();
    renderField(grid, k, t, fieldAxes.rowLat, fieldAxes.colLon, img);
    field.ctx.putImageData(img, 0, 0);
    for (const l of fieldLabels) {
      const s = sampleField(grid, k, l.lat, l.lon, t);
      if (Number.isNaN(s.value)) l.el.textContent = '';
      else if (k === 'temp') l.el.textContent = `${Math.round(s.value)}°`;
      else l.el.innerHTML = `<b style="transform:rotate(${Math.round(s.to ?? 0)}deg)">↑</b>${Math.round(s.value)}`;
    }
  };

  const paint = () => {
    const f = frames[index];
    if (!f) return;
    if (kind === 'rain') {
      clear(field);
      paintRain(f);
    } else {
      clear(world);
      clear(fine);
      paintField(kind, f);
    }
  };

  const show = (i: number) => {
    index = i;
    paint();
    const f = frames[i];
    const diff = Math.round((f.time.getTime() - frames[nowIdx].time.getTime()) / 60000);
    panel.range.value = String(i);
    const rain = kind === 'rain';
    const what = rain ? (f.model ? 'Modellvorhersage' : f.forecast ? 'Vorhersage' : diff === 0 ? 'letzte Messung' : 'Messung') : 'Modell';
    panel.range.setAttribute('aria-valuetext', `${dayLabel(f.time)} ${hhmm(f.time)}, ${what}${diff ? ` ${counter(diff).trim()} h` : ''}`);
    panel.time.textContent = hhmm(f.time);
    panel.day.textContent = dayLabel(f.time);
    panel.counter.textContent = counter(diff);
    panel.mode.textContent = rain
      ? f.model
        ? '▶▶ MODELL'
        : f.forecast
          ? '▶▶ PROGNOSE'
          : diff === 0
            ? '● LIVE'
            : '◀ ARCHIV'
      : diff > 0
        ? '▶▶ MODELL'
        : diff === 0
          ? '● JETZT'
          : '◀ MODELL';
    panel.mode.classList.toggle('fc', f.forecast);
    [...panel.bars.children].forEach((b, j) => b.classList.toggle('played', j <= i));
  };

  // ---- loading --------------------------------------------------------------

  /** Big loading screen while the visible frame has no data yet, otherwise a small corner hint. */
  let bigLoader = true;
  const progress = (done: number, total: number) => {
    const pct = total ? Math.round((done / total) * 100) : 100;
    const finished = done >= total;
    panel.loadingPct.textContent = `${pct}%`;
    panel.loadingBar.style.width = `${pct}%`;
    panel.loading.setAttribute('aria-valuenow', String(pct));
    panel.loading.classList.toggle('off', finished || !bigLoader);
    panel.progress.textContent = `TRACKING ${pct}%`;
    panel.progress.classList.remove('err');
    panel.progress.hidden = finished || bigLoader;
  };

  /** Area to load for the current map view, clipped to `area`; null if nothing of it is visible. */
  const neededView = (area: L.LatLngBounds, current: View | null, maxPixels: number): View | null => {
    const zoom = map.getZoom();
    const size = map.getSize();
    const pb = map.getPixelBounds();
    const pad = size.multiplyBy(PAD);
    const dmin = map.project(area.getNorthWest(), zoom);
    const dmax = map.project(area.getSouthEast(), zoom);
    const clip = (min: L.Point, max: L.Point) => {
      const a = L.point(Math.floor(Math.max(min.x, dmin.x)), Math.floor(Math.max(min.y, dmin.y)));
      const b = L.point(Math.ceil(Math.min(max.x, dmax.x)), Math.ceil(Math.min(max.y, dmax.y)));
      return b.x - a.x >= 8 && b.y - a.y >= 8 ? L.bounds(a, b) : null;
    };
    const visible = clip(pb.min!, pb.max!);
    if (!visible) return null;
    // The current images still cover the screen: keep them.
    if (current && current.zoom === zoom && current.px.contains(visible)) return current;
    const px = clip(pb.min!.subtract(pad), pb.max!.add(pad))!;
    const w0 = px.max!.x - px.min!.x;
    const h0 = px.max!.y - px.min!.y;
    const scale = Math.min(1, Math.sqrt(maxPixels / (w0 * h0)));
    return {
      zoom,
      px,
      bounds: L.latLngBounds(map.unproject(px.min!, zoom), map.unproject(px.max!, zoom)),
      w: Math.round(w0 * scale),
      h: Math.round(h0 * scale),
    };
  };

  const fetchFrame = async (job: Job, gen: number) => {
    const v = job.view;
    const sw = L.CRS.EPSG3857.project(v.bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(v.bounds.getNorthEast());
    const url = radarImageUrl(job.layer, job.time, [sw.x, sw.y, ne.x, ne.y], v.w, v.h);
    // Some DWD backend nodes lag behind and answer with an XML error; retry a few times.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (gen !== generation) return;
      try {
        const img = await loadImage(attempt ? `${url}&_r=${Date.now()}` : url, inflight);
        if (gen !== generation) return;
        if (scratch.width !== v.w || scratch.height !== v.h) {
          scratch.width = v.w;
          scratch.height = v.h;
        } else {
          sctx.clearRect(0, 0, v.w, v.h);
        }
        sctx.drawImage(img, 0, 0);
        cache.set(job.key, { view: v, codes: contourCodes(sctx.getImageData(0, 0, v.w, v.h), job.palette), expires: job.expires });
        return;
      } catch {
        await sleep(400 * (attempt + 1));
      }
    }
  };

  /** Stops all radar downloads (on reload, or when switching to a model field). */
  const cancelRain = () => {
    generation++;
    inflight.forEach((img) => (img.src = ''));
    inflight.clear();
  };

  /** Loads every radar/ICON-EU frame and every ICON global image that has no data for the current view yet. */
  const syncRain = () => {
    const v = neededView(DOMAIN, views.radar, MAX_PIXELS);
    const mv = neededView(DOMAIN, views.model, MODEL_MAX_PIXELS);
    const wv = neededView(WORLD, views.world, GLOBAL_MAX_PIXELS);
    if (v) views.radar = v;
    if (mv) views.model = mv;
    if (wv) views.world = wv;
    const modelExpires = Date.now() + MODEL_MAX_AGE_MS;
    const jobs: Job[] = [];
    if (v && mv) {
      for (const f of frames) {
        const fv = f.model ? mv : v;
        if (f.layer && cache.get(key(f))?.view !== fv) {
          jobs.push({ key: key(f), layer: f.layer, time: f.time, view: fv, palette: f.model ? MODEL_PALETTE : RADAR_PALETTE, expires: f.model ? modelExpires : Infinity });
        }
      }
    }
    if (wv) {
      const seen = new Set<string>();
      for (const f of frames) {
        const k = worldKey(f);
        if (seen.has(k)) continue;
        seen.add(k);
        if (cache.get(k)?.view !== wv) jobs.push({ key: k, layer: GLOBAL_LAYER, time: globalTime(f.time), view: wv, palette: GLOBAL_PALETTE, expires: modelExpires });
      }
    }
    if (!jobs.length) return progress(1, 1);

    cancelRain();
    const gen = generation;
    // What the visible frame needs first, then in time order.
    const current = frames[index];
    const now = new Set([key(current), worldKey(current)]);
    jobs.sort((a, b) => Number(now.has(b.key)) - Number(now.has(a.key)) || a.time.getTime() - b.time.getTime());
    bigLoader = !cache.has(v && current.layer ? key(current) : worldKey(current));
    const total = jobs.length;
    let done = 0;
    progress(0, total);

    const worker = async () => {
      for (let job = jobs.shift(); job && gen === generation; job = jobs.shift()) {
        await fetchFrame(job, gen);
        if (gen !== generation || !alive) return;
        done++;
        if (job.key === key(frames[index]) || job.key === worldKey(frames[index])) {
          paint();
          // The visible frame is there; the rest (up to three days of frames) loads in the corner.
          bigLoader = false;
        }
        progress(done, total);
      }
    };
    for (let i = 0; i < PARALLEL; i++) worker();
  };

  /** Value labels on a screen-aligned lattice over the visible map. */
  const placeLabels = () => {
    labels.clearLayers();
    fieldLabels = [];
    if (kind !== 'temp' && kind !== 'wind') return;
    const size = map.getSize();
    for (let row = 0, y = LABEL_DY / 2; y < size.y; row++, y += LABEL_DY) {
      for (let x = (row % 2 ? LABEL_DX : LABEL_DX / 2) / 2 + 8; x < size.x; x += LABEL_DX) {
        const ll = map.containerPointToLatLng([x, y]);
        const el = document.createElement('span');
        el.className = 'field-label';
        labels.addLayer(L.marker(ll, { icon: L.divIcon({ className: 'field-label-icon', html: el, iconSize: [0, 0] }), interactive: false, keyboard: false }));
        fieldLabels.push({ el, lat: ll.lat, lon: ll.lng });
      }
    }
  };

  /**
   * Loads the model field for the current view (one request for all hours and all fields). The rain
   * layer needs it too, to tell snow from rain; there it loads quietly, without loader or messages.
   */
  const syncField = async () => {
    const loud = kind !== 'rain';
    const v = neededView(WORLD, fieldView, FIELD_MAX_PIXELS);
    if (!v) return;
    if (v !== fieldView) {
      fieldView = v;
      fieldAxes = axes(v, v.w, v.h);
    }
    placeLabels();
    paint();

    const b = v.bounds;
    const area = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    let s = latticeStep(v.zoom);
    while (latticeSize(area, s) > MAX_FIELD_POINTS) s *= 2;
    const covers = (g: FieldGrid | null, step: number) =>
      !!g &&
      g.step <= step &&
      g.south <= area.south &&
      g.west <= area.west &&
      g.south + (g.ny - 1) * g.step >= area.north &&
      g.west + (g.nx - 1) * g.step >= area.east &&
      Date.now() - g.t0 < 3 * HOUR_MS &&
      // A grid from the limit period may have gaps; looking again costs nothing while it lasts.
      !(g === grid && gridLimited);
    // The loaded grid already covers this area at this or a finer spacing.
    if (covers(grid, s)) return loud ? progress(1, 1) : undefined;
    if (fieldRequest) fieldRequest.cancelled = true;
    const req = { cancelled: false };
    fieldRequest = req;
    if (loud) bigLoader = !grid;
    // After zooming out, first a lattice four times coarser (a sixteenth of the points, all of them
    // part of the fine lattice too, so nothing is asked twice): the whole screen has a field at
    // once, even if the fine lattice has to wait for Open-Meteo's per-minute limit.
    // Not worth it when the current grid already fills most of the screen (a small pan).
    const coarse = s * 4;
    const filled = (g: FieldGrid | null) => {
      if (!g) return 0;
      const w = Math.min(area.east, g.west + (g.nx - 1) * g.step) - Math.max(area.west, g.west);
      const h = Math.min(area.north, g.south + (g.ny - 1) * g.step) - Math.max(area.south, g.south);
      return w > 0 && h > 0 ? (w * h) / ((area.east - area.west) * (area.north - area.south)) : 0;
    };
    const phases = covers(grid, coarse) || filled(grid) > 0.6 ? [s] : [coarse, s];
    try {
      for (let i = 0; i < phases.length; i++) {
        if (loud) progress(i, phases.length);
        const r = await fieldGrid(area, phases[i], req);
        if (!alive || req.cancelled || !r) return;
        grid = r.grid;
        gridLimited = r.limited;
        if (loud) bigLoader = false;
        paint();
        if (r.limited) break;
      }
      if (loud) progress(1, 1);
      showLimit();
    } catch (e) {
      // Without the model the rain layer just shows everything as rain.
      if (!alive || req.cancelled || !loud) return;
      progress(1, 1);
      panel.progress.textContent = e instanceof HttpError && e.status === 429 ? 'LIMIT – SPÄTER' : 'KEIN SIGNAL';
      panel.progress.classList.add('err');
      panel.progress.hidden = false;
    } finally {
      if (fieldRequest === req) fieldRequest = null;
    }
  };

  const sync = () => {
    if (!alive || !frames.length) return;
    if (kind === 'rain') syncRain();
    syncField();
  };

  let syncTimer = 0;
  let fieldTimer = 0;
  const scheduleSync = () => {
    clearTimeout(syncTimer);
    clearTimeout(fieldTimer);
    if (kind === 'rain') syncTimer = window.setTimeout(() => alive && frames.length && syncRain(), 250);
    // Model fields wait a little longer, so zooming through several levels asks only for the last one.
    fieldTimer = window.setTimeout(() => alive && frames.length && syncField(), 800);
  };
  map.on('moveend resize', scheduleSync);

  // ---- playback -------------------------------------------------------------

  const stop = () => {
    clearInterval(timer);
    timer = 0;
    panel.play.textContent = '▶';
    panel.play.setAttribute('aria-label', 'Animation abspielen');
  };
  const play = () => {
    if (!frames.length) return;
    // Plays once up to the end of the forecast and stops there; from the end it starts over.
    if (index >= frames.length - 1) show(0);
    panel.play.textContent = '❚❚';
    panel.play.setAttribute('aria-label', 'Animation anhalten');
    timer = window.setInterval(() => {
      show(index + 1);
      if (index >= frames.length - 1) stop();
    }, frameMs(frames.length));
  };

  panel.play.addEventListener('click', () => (timer ? stop() : play()));
  // Keyboard and screen readers use the range input.
  panel.range.addEventListener('input', () => {
    stop();
    show(Number(panel.range.value));
  });
  // Finger and mouse: tap anywhere on the tape or slide along it. iOS only moves a range input when
  // its (here invisible) thumb is hit, so the tape reads the pointer itself.
  const tape = el.querySelector<HTMLElement>('.tape')!;
  const scrub = (e: PointerEvent) => {
    const r = panel.bars.getBoundingClientRect();
    if (!frames.length || !r.width) return;
    const i = Math.max(0, Math.min(frames.length - 1, Math.floor(((e.clientX - r.left) / r.width) * frames.length)));
    if (i !== index) show(i);
  };
  tape.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.tape-days') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    stop();
    tape.setPointerCapture(e.pointerId);
    tape.classList.add('scrubbing');
    scrub(e);
  });
  tape.addEventListener('pointermove', (e) => {
    if (tape.hasPointerCapture(e.pointerId)) scrub(e);
  });
  const release = () => tape.classList.remove('scrubbing');
  tape.addEventListener('pointerup', release);
  tape.addEventListener('pointercancel', release);

  // ---- frames, step and layer -----------------------------------------------

  /** Day marks under the tape: tap one to jump to noon of that day (today: to now). */
  const renderDays = () => {
    const starts: number[] = [];
    frames.forEach((f, i) => {
      if (!i || dayKey(f.time) !== dayKey(frames[i - 1].time)) starts.push(i);
    });
    if (starts.length < 2) {
      panel.days.innerHTML = '';
      panel.row.classList.remove('has-days');
      return;
    }
    const today = dayKey(new Date());
    const n = frames.length;
    panel.days.innerHTML = starts
      .map((s, j) => {
        const end = starts[j + 1] ?? n;
        const d = frames[s].time;
        const isToday = dayKey(d) === today;
        // Too narrow for a label (e.g. only the last hour of today): just the tick.
        const label = (end - s) / n < 0.12 ? '' : isToday ? 'HEUTE' : dayLabel(d).slice(0, 2);
        return `<button type="button" data-day="${s}" style="left:${(s / n) * 100}%;width:${((end - s) / n) * 100}%" aria-label="${isToday ? 'Heute' : d.toLocaleDateString('de-DE', { weekday: 'long' })}">${label}</button>`;
      })
      .join('');
    panel.row.classList.add('has-days');
  };

  panel.days.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-day]');
    if (!btn) return;
    const start = Number(btn.dataset.day);
    const day = dayKey(frames[start].time);
    let target = start;
    if (day === dayKey(frames[nowIdx].time)) target = nowIdx;
    else {
      // Noon, or the frame closest to it.
      let best = Infinity;
      for (let i = start; i < frames.length && dayKey(frames[i].time) === day; i++) {
        const t = frames[i].time;
        const d = Math.abs(t.getHours() * 60 + t.getMinutes() - 12 * 60);
        if (d < best) {
          best = d;
          target = i;
        }
      }
    }
    stop();
    show(target);
  });

  let framesRequest = 0;
  const loadFrames = async () => {
    const req = ++framesRequest;
    const wasPlaying = !!timer;
    stop();
    const prevTime = frames[index]?.time.getTime();
    const next = await radarFrames(PAST_MIN, step, HORIZON[step]);
    if (!alive || req !== framesRequest) return;
    frames = next;
    const keys = new Set([...frames.map(key), ...frames.map(worldKey)]);
    const t = Date.now();
    for (const [k, d] of cache) if (!keys.has(k) || d.expires < t) cache.delete(k);
    nowIdx = frames.some((f) => f.forecast) ? Math.max(0, frames.findIndex((f) => f.forecast) - 1) : frames.length - 1;
    panel.bars.innerHTML = frames.map((f, i) => `<i class="${f.model ? 'fc md' : f.forecast ? 'fc' : ''}${i === nowIdx ? ' now' : ''}"></i>`).join('');
    panel.bars.classList.toggle('dense', frames.length > 20);
    panel.range.max = String(frames.length - 1);
    renderDays();
    // Stay at the same time when switching the step, if that time still exists.
    const keep = frames.findIndex((f) => f.time.getTime() === prevTime);
    index = keep >= 0 ? keep : nowIdx;
    sync();
    show(index);
    if (wasPlaying) play();
  };

  panel.steps.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-step]');
    if (!btn) return;
    const s = Number(btn.dataset.step) as Step;
    if (s === step) return;
    step = s;
    store(PREF_STEP, String(s));
    panel.steps.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    loadFrames();
  });

  let attribution = '';
  const setAttribution = (text: string) => {
    if (text === attribution) return;
    if (attribution) map.attributionControl.removeAttribution(attribution);
    map.attributionControl.addAttribution(text);
    attribution = text;
  };

  /** Legend, map label and attribution of the current layer. */
  const applyKind = () => {
    const k = KINDS.find((x) => x.kind === kind)!;
    panel.kinds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    panel.map.setAttribute('aria-label', `Karte: ${k.name}`);
    if (kind === 'rain') {
      panel.legend.className = 'radar-legend';
      panel.legend.innerHTML =
        LEVEL_NAMES.map((n, i) => `<span style="color:${LEVEL_COLORS[i]}"><i></i>${n}</span>`).join('') + `<span style="color:${SNOW_COLOR}"><i></i>SCHNEE</span>`;
      setAttribution(RAIN_ATTRIBUTION);
    } else {
      const [lo, hi] = FIELD_LEGEND[kind];
      panel.legend.className = 'radar-legend field';
      panel.legend.innerHTML = `<span>${lo}</span><i style="background:${legendGradient(kind)}"></i><span>${hi}</span>`;
      setAttribution(FIELD_ATTRIBUTION);
    }
  };

  panel.kinds.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
    if (!btn) return;
    const k = btn.dataset.kind as Kind;
    if (k === kind) return;
    kind = k;
    store(PREF_KIND, k);
    applyKind();
    if (kind === 'rain') {
      if (fieldRequest) fieldRequest.cancelled = true;
      labels.clearLayers();
      fieldLabels = [];
    } else cancelRain();
    showLimit();
    // Cancelled rain frames are missing from the cache, so the next rain sync queues them again.
    progress(1, 1);
    sync();
    show(index);
  });

  applyKind();
  loadFrames();

  // Leaflet needs a size recalculation once the flex layout has settled.
  const ro = new ResizeObserver(() => {
    map.invalidateSize();
    map.setMinZoom(fitMinZoom(map));
  });
  ro.observe(panel.map);

  return () => {
    alive = false;
    clearTimeout(limitTimer);
    cancelRain();
    if (fieldRequest) fieldRequest.cancelled = true;
    clearTimeout(syncTimer);
    clearTimeout(fieldTimer);
    stop();
    ro.disconnect();
    map.remove();
  };
}
