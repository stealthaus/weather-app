import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RADAR_LAYER, RADAR_WMS, radarFrames, type RadarFrame } from '../api/radar';
import { contourTile, LEVEL_COLORS } from '../lib/contour';
import { hhmm } from '../lib/format';
import type { Place } from '../lib/places';

const FRAME_MS = 700;
const LEVEL_NAMES = ['LEICHT', 'MÄSSIG', 'STARK', 'HAGEL'];

/** WMS layer whose tiles are redrawn as neon contours instead of the DWD colour scale. */
class ContourLayer extends L.TileLayer.WMS {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas');
    const size = this.getTileSize();
    canvas.width = size.x;
    canvas.height = size.y;
    const url = this.getTileUrl(coords);
    let tries = 0;
    const load = () => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, size.x, size.y);
          const data = ctx.getImageData(0, 0, size.x, size.y);
          contourTile(data);
          ctx.putImageData(data, 0, 0);
          done(undefined, canvas);
        } catch (e) {
          done(e as Error, canvas);
        }
      };
      // Some DWD backend nodes lag behind and answer with an XML error; retry a few times.
      img.onerror = () => {
        if (++tries > 3) return done(new Error('radar tile failed'), canvas);
        setTimeout(load, 300 * tries);
      };
      img.src = tries ? `${url}&_r=${Date.now()}` : url;
    };
    load();
    return canvas;
  }
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

export function mountRadar(el: HTMLElement, place: Place): () => void {
  const day = new Date()
    .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
    .replace(',', '')
    .toUpperCase();
  el.innerHTML = `
    <div class="radar-wrap">
      <div id="map" aria-label="Regenradar-Karte"></div>
      <div class="radar-scan" aria-hidden="true"></div>
      <div class="osd osd-mode" aria-live="polite">LÄDT …</div>
      <div class="osd osd-clock"><span class="radar-time">–:–</span><small>${day}</small></div>
      <div class="osd radar-progress" hidden></div>
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

  const panel = {
    play: el.querySelector<HTMLButtonElement>('.vhs-key')!,
    range: el.querySelector<HTMLInputElement>('input[type=range]')!,
    bars: el.querySelector<HTMLElement>('.tape-bars')!,
    counter: el.querySelector<HTMLElement>('.tape-counter')!,
    time: el.querySelector<HTMLElement>('.radar-time')!,
    mode: el.querySelector<HTMLElement>('.osd-mode')!,
    progress: el.querySelector<HTMLElement>('.radar-progress')!,
  };

  let frames: RadarFrame[] = [];
  let layers: ContourLayer[] = [];
  let nowIdx = 0;
  let index = 0;
  let timer = 0;
  let alive = true;

  const makeLayer = (f: RadarFrame) =>
    new ContourLayer(RADAR_WMS, {
      layers: RADAR_LAYER,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      tileSize: 512,
      zoomOffset: 0,
      opacity: 0,
      zIndex: 3,
      // @ts-expect-error extra WMS parameter
      time: f.time.toISOString(),
    });

  const show = (i: number) => {
    index = i;
    layers.forEach((l, j) => l.setOpacity(j === i ? 1 : 0));
    const f = frames[i];
    const diff = Math.round((f.time.getTime() - frames[nowIdx].time.getTime()) / 60000);
    panel.range.value = String(i);
    panel.range.setAttribute('aria-valuetext', `${hhmm(f.time)}, ${f.forecast ? `Vorhersage +${diff} min` : diff === 0 ? 'letzte Messung' : `Messung ${diff} min`}`);
    panel.time.textContent = hhmm(f.time);
    panel.counter.textContent = counter(diff);
    panel.mode.textContent = f.forecast ? '▶▶ PROGNOSE' : diff === 0 ? '● LIVE' : '◀ ARCHIV';
    panel.mode.classList.toggle('fc', f.forecast);
    [...panel.bars.children].forEach((b, j) => b.classList.toggle('played', j <= i));
  };

  const stop = () => {
    clearInterval(timer);
    timer = 0;
    panel.play.textContent = '▶';
    panel.play.setAttribute('aria-label', 'Animation abspielen');
  };
  const play = () => {
    if (!frames.length) return;
    panel.play.textContent = '❚❚';
    panel.play.setAttribute('aria-label', 'Animation anhalten');
    timer = window.setInterval(() => show((index + 1) % frames.length), FRAME_MS);
  };

  panel.play.addEventListener('click', () => (timer ? stop() : play()));
  panel.range.addEventListener('input', () => {
    stop();
    show(Number(panel.range.value));
  });

  (async () => {
    frames = await radarFrames(60, 10);
    if (!alive) return;
    nowIdx = frames.some((f) => f.forecast) ? Math.max(0, frames.findIndex((f) => f.forecast) - 1) : frames.length - 1;
    panel.bars.innerHTML = frames.map((f, i) => `<i class="${f.forecast ? 'fc' : ''}${i === nowIdx ? ' now' : ''}"></i>`).join('');
    layers = frames.map(makeLayer);
    let pending = layers.length;
    panel.progress.hidden = false;
    panel.progress.textContent = `TRACKING 0/${pending}`;
    layers.forEach((l) => {
      l.once('load', () => {
        pending--;
        panel.progress.textContent = `TRACKING ${layers.length - pending}/${layers.length}`;
        if (pending <= 0) panel.progress.hidden = true;
      });
      l.addTo(map);
    });
    setTimeout(() => (panel.progress.hidden = true), 15000);
    panel.range.max = String(frames.length - 1);
    show(nowIdx);
  })();

  // Leaflet needs a size recalculation once the flex layout has settled.
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(el.querySelector('#map')!);

  return () => {
    alive = false;
    stop();
    ro.disconnect();
    map.remove();
  };
}
