import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RADAR_DOMAIN, radarFrames, radarImageUrl, type RadarFrame } from '../api/radar';
import { contourCodes, LEVEL_COLORS, MODEL_PALETTE, paintCodes, RADAR_PALETTE } from '../lib/contour';
import { hhmm } from '../lib/format';
import type { Place } from '../lib/places';

const LEVEL_NAMES = ['LEICHT', 'MÄSSIG', 'STARK', 'HAGEL'];
const PAST_MIN = 60;
const STEPS = [5, 15, 30, 60] as const;
type Step = (typeof STEPS)[number];
/** How far ahead each step reaches. Beyond the 2 h nowcast, hourly model frames take over. */
const HORIZON_MIN: Record<Step, number> = { 5: 120, 15: 120, 30: 6 * 60, 60: 12 * 60 };
const stepLabel = (s: Step) => (s < 60 ? `${s}M` : `${s / 60}H`);
/** Same speed for every step; finer steps just take longer to play through. */
const FRAME_MS = 500;
const PREF_STEP = 'wx.radar.step';
/** The DWD GeoServer is slow (0.5–2 s per image); more parallel requests only queue up. */
const PARALLEL = 4;
/** Extra margin around the viewport, so small pans need no reload. */
const PAD = 0.2;
/** Caps image size on large screens (server time and memory grow with the pixel count). */
const MAX_PIXELS = 1_000_000;

const DOMAIN = L.latLngBounds([RADAR_DOMAIN.south, RADAR_DOMAIN.west], [RADAR_DOMAIN.north, RADAR_DOMAIN.east]);

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

function savedStep(): Step {
  try {
    const v = Number(localStorage.getItem(PREF_STEP));
    return (STEPS as readonly number[]).includes(v) ? (v as Step) : 15;
  } catch {
    return 15;
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

export function mountRadar(el: HTMLElement, place: Place): () => void {
  const day = new Date()
    .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
    .replace(',', '')
    .toUpperCase();
  let step = savedStep();
  el.innerHTML = `
    <div class="radar-wrap">
      <div id="map" aria-label="Regenradar-Karte"></div>
      <div class="radar-scan" aria-hidden="true"></div>
      <div class="radar-loading" role="progressbar" aria-label="Radar lädt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span class="radar-loading-label">TRACKING</span>
        <span class="radar-loading-pct">0%</span>
        <span class="radar-loading-bar"><i></i></span>
      </div>
      <div class="osd osd-mode" aria-live="polite">LÄDT …</div>
      <div class="osd osd-clock"><span class="radar-time">–:–</span><small>${day}</small></div>
      <div class="osd radar-progress" hidden></div>
      <div class="radar-steps" role="group" aria-label="Zeitschritt">
        ${STEPS.map((s) => `<button type="button" data-step="${s}" aria-pressed="${s === step}" aria-label="${s < 60 ? `${s} Minuten` : `${s / 60} Stunde`}">${stepLabel(s)}</button>`).join('')}
      </div>
      <div class="radar-panel">
        <div class="radar-row">
          <button type="button" class="vhs-key" aria-label="Animation abspielen">▶</button>
          <div class="tape">
            <div class="tape-bars" aria-hidden="true"></div>
            <input type="range" min="0" max="0" value="0" step="1" aria-label="Zeitpunkt" />
          </div>
          <span class="tape-counter"> 0:00</span>
        </div>
        <div class="radar-legend">${LEVEL_NAMES.map((n, i) => `<span style="color:${LEVEL_COLORS[i]}"><i></i>${n}</span>`).join('')}</div>
      </div>
    </div>`;

  const map = L.map(el.querySelector<HTMLElement>('#map')!, {
    zoomControl: false,
    attributionControl: true,
    minZoom: 5,
    maxZoom: 12,
  }).setView([place.lat, place.lon], 8);
  map.attributionControl.setPrefix(false);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'basemap',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Radar © <a href="https://www.dwd.de">DWD</a>',
  }).addTo(map);
  new GridLines({ tileSize: 128, zIndex: 2 }).addTo(map);
  L.marker([place.lat, place.lon], {
    icon: L.divIcon({ className: '', html: '<div class="loc-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);

  // A single canvas shows the current frame. SVGOverlay positions any element like an image
  // (including zoom animation), so it can carry the canvas.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  const overlay = L.svgOverlay(canvas as unknown as SVGElement, DOMAIN, { interactive: false }).addTo(map);
  // Scratch canvas to read the pixels of a downloaded image.
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

  const panel = {
    play: el.querySelector<HTMLButtonElement>('.vhs-key')!,
    range: el.querySelector<HTMLInputElement>('input[type=range]')!,
    bars: el.querySelector<HTMLElement>('.tape-bars')!,
    counter: el.querySelector<HTMLElement>('.tape-counter')!,
    time: el.querySelector<HTMLElement>('.radar-time')!,
    mode: el.querySelector<HTMLElement>('.osd-mode')!,
    progress: el.querySelector<HTMLElement>('.radar-progress')!,
    loading: el.querySelector<HTMLElement>('.radar-loading')!,
    loadingPct: el.querySelector<HTMLElement>('.radar-loading-pct')!,
    loadingBar: el.querySelector<HTMLElement>('.radar-loading-bar i')!,
    steps: el.querySelector<HTMLElement>('.radar-steps')!,
  };

  let frames: RadarFrame[] = [];
  /** Loaded frames by layer and time, so switching the step reuses what is already there. */
  const cache = new Map<string, FrameData>();
  const key = (f: RadarFrame) => `${f.layer}|${f.time.getTime()}`;
  let nowIdx = 0;
  let index = 0;
  let timer = 0;
  let alive = true;
  let view: View | null = null;
  let shown: { view: View; img: ImageData } | null = null;
  /** Incremented on every reload; older downloads see the mismatch and stop. */
  let generation = 0;
  const inflight = new Set<HTMLImageElement>();

  // ---- drawing --------------------------------------------------------------

  const paint = () => {
    const d = frames[index] && cache.get(key(frames[index]));
    if (!d) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (shown?.view !== d.view) {
      canvas.width = d.view.w;
      canvas.height = d.view.h;
      overlay.setBounds(d.view.bounds);
      shown = { view: d.view, img: ctx.createImageData(d.view.w, d.view.h) };
    }
    paintCodes(d.codes, shown.img);
    ctx.putImageData(shown.img, 0, 0);
  };

  const show = (i: number) => {
    index = i;
    paint();
    const f = frames[i];
    const diff = Math.round((f.time.getTime() - frames[nowIdx].time.getTime()) / 60000);
    panel.range.value = String(i);
    const kind = f.model ? 'Modellvorhersage' : f.forecast ? 'Vorhersage' : diff === 0 ? 'letzte Messung' : 'Messung';
    panel.range.setAttribute('aria-valuetext', `${hhmm(f.time)}, ${kind}${diff ? ` ${counter(diff).trim()} h` : ''}`);
    panel.time.textContent = hhmm(f.time);
    panel.counter.textContent = counter(diff);
    panel.mode.textContent = f.model ? '▶▶ MODELL' : f.forecast ? '▶▶ PROGNOSE' : diff === 0 ? '● LIVE' : '◀ ARCHIV';
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
    panel.progress.hidden = finished || bigLoader;
  };

  /** Area to load for the current map view, clipped to the radar domain; null if nothing is visible. */
  const neededView = (): View | null => {
    const zoom = map.getZoom();
    const size = map.getSize();
    const pb = map.getPixelBounds();
    const pad = size.multiplyBy(PAD);
    const dmin = map.project(DOMAIN.getNorthWest(), zoom);
    const dmax = map.project(DOMAIN.getSouthEast(), zoom);
    const clip = (min: L.Point, max: L.Point) => {
      const a = L.point(Math.floor(Math.max(min.x, dmin.x)), Math.floor(Math.max(min.y, dmin.y)));
      const b = L.point(Math.ceil(Math.min(max.x, dmax.x)), Math.ceil(Math.min(max.y, dmax.y)));
      return b.x - a.x >= 8 && b.y - a.y >= 8 ? L.bounds(a, b) : null;
    };
    const visible = clip(pb.min!, pb.max!);
    if (!visible) return null;
    // The current images still cover the screen: keep them.
    if (view && view.zoom === zoom && view.px.contains(visible)) return view;
    const px = clip(pb.min!.subtract(pad), pb.max!.add(pad))!;
    const w0 = px.max!.x - px.min!.x;
    const h0 = px.max!.y - px.min!.y;
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w0 * h0)));
    return {
      zoom,
      px,
      bounds: L.latLngBounds(map.unproject(px.min!, zoom), map.unproject(px.max!, zoom)),
      w: Math.round(w0 * scale),
      h: Math.round(h0 * scale),
    };
  };

  const fetchFrame = async (f: RadarFrame, v: View, gen: number) => {
    const sw = L.CRS.EPSG3857.project(v.bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(v.bounds.getNorthEast());
    const url = radarImageUrl(f.layer, f.time, [sw.x, sw.y, ne.x, ne.y], v.w, v.h);
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
        cache.set(key(f), { view: v, codes: contourCodes(sctx.getImageData(0, 0, v.w, v.h), f.model ? MODEL_PALETTE : RADAR_PALETTE) });
        return;
      } catch {
        await sleep(400 * (attempt + 1));
      }
    }
  };

  /** Loads every frame that has no data for the current view yet. */
  const sync = () => {
    if (!alive || !frames.length) return;
    const v = neededView();
    if (!v) return progress(1, 1);
    view = v;
    const todo = frames.filter((f) => cache.get(key(f))?.view !== v);
    if (!todo.length) return progress(1, 1);

    const gen = ++generation;
    inflight.forEach((img) => (img.src = ''));
    inflight.clear();
    // The visible frame first, then in time order.
    const current = frames[index];
    todo.sort((a, b) => (a === current ? -1 : b === current ? 1 : a.time.getTime() - b.time.getTime()));
    bigLoader = !cache.has(key(current));
    const total = todo.length;
    let done = 0;
    progress(0, total);

    const worker = async () => {
      for (let f = todo.shift(); f && gen === generation; f = todo.shift()) {
        await fetchFrame(f, v, gen);
        if (gen !== generation || !alive) return;
        done++;
        if (f === frames[index]) paint();
        progress(done, total);
      }
    };
    for (let i = 0; i < PARALLEL; i++) worker();
  };

  let syncTimer = 0;
  const scheduleSync = () => {
    clearTimeout(syncTimer);
    syncTimer = window.setTimeout(sync, 250);
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
    }, FRAME_MS);
  };

  panel.play.addEventListener('click', () => (timer ? stop() : play()));
  panel.range.addEventListener('input', () => {
    stop();
    show(Number(panel.range.value));
  });

  // ---- frames and step ------------------------------------------------------

  let framesRequest = 0;
  const loadFrames = async () => {
    const req = ++framesRequest;
    const wasPlaying = !!timer;
    stop();
    const prevTime = frames[index]?.time.getTime();
    const next = await radarFrames(PAST_MIN, step, HORIZON_MIN[step]);
    if (!alive || req !== framesRequest) return;
    frames = next;
    const keys = new Set(frames.map(key));
    for (const k of cache.keys()) if (!keys.has(k)) cache.delete(k);
    nowIdx = frames.some((f) => f.forecast) ? Math.max(0, frames.findIndex((f) => f.forecast) - 1) : frames.length - 1;
    panel.bars.innerHTML = frames.map((f, i) => `<i class="${f.model ? 'fc md' : f.forecast ? 'fc' : ''}${i === nowIdx ? ' now' : ''}"></i>`).join('');
    panel.bars.classList.toggle('dense', frames.length > 20);
    panel.range.max = String(frames.length - 1);
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
    try {
      localStorage.setItem(PREF_STEP, String(s));
    } catch {
      /* ignore */
    }
    panel.steps.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    loadFrames();
  });

  loadFrames();

  // Leaflet needs a size recalculation once the flex layout has settled.
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(el.querySelector('#map')!);

  return () => {
    alive = false;
    generation++;
    inflight.forEach((img) => (img.src = ''));
    inflight.clear();
    clearTimeout(syncTimer);
    stop();
    ro.disconnect();
    map.remove();
    cache.clear();
  };
}
