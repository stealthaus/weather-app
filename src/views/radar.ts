import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DBZ_COLORS, RADAR_LAYER, RADAR_WMS, radarFrames, type RadarFrame } from '../api/radar';
import { hhmm } from '../lib/format';
import type { Place } from '../lib/places';

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
const FRAME_MS = 700;

export function mountRadar(el: HTMLElement, place: Place): () => void {
  el.innerHTML = `
    <div class="radar-wrap">
      <div id="map" aria-label="Regenradar-Karte"></div>
      <div class="radar-progress" hidden></div>
      <div class="radar-panel">
        <div class="radar-row">
          <button type="button" class="play" aria-label="Animation abspielen">${PLAY}</button>
          <input type="range" min="0" max="0" value="0" step="1" aria-label="Zeitpunkt" />
          <span class="radar-time">–</span>
        </div>
        <div class="radar-sub"><span class="radar-kind">Lädt Zeitschritte …</span><span>DWD-Radar · Nowcast bis +2 h</span></div>
        <div class="dbz">${DBZ_COLORS.map((c) => `<span style="background:${c}"></span>`).join('')}</div>
        <div class="dbz-labels"><span>leicht</span><span>mäßig</span><span>stark</span><span>Hagel möglich</span></div>
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
  L.marker([place.lat, place.lon], {
    icon: L.divIcon({ className: '', html: '<div class="loc-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);

  const panel = {
    play: el.querySelector<HTMLButtonElement>('.play')!,
    range: el.querySelector<HTMLInputElement>('input[type=range]')!,
    time: el.querySelector<HTMLElement>('.radar-time')!,
    kind: el.querySelector<HTMLElement>('.radar-kind')!,
    progress: el.querySelector<HTMLElement>('.radar-progress')!,
  };

  let frames: RadarFrame[] = [];
  let layers: L.TileLayer.WMS[] = [];
  let index = 0;
  let timer = 0;
  let alive = true;

  const makeLayer = (f: RadarFrame) => {
    const layer = L.tileLayer.wms(RADAR_WMS, {
      layers: RADAR_LAYER,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      tileSize: 512,
      zoomOffset: 0,
      opacity: 0,
      // @ts-expect-error extra WMS parameter
      time: f.time.toISOString(),
    });
    // Some DWD backend nodes lag behind and answer with an XML error; retry a few times.
    layer.on('tileerror', (e: L.TileErrorEvent) => {
      const img = e.tile as HTMLImageElement & { _retries?: number };
      img._retries = (img._retries ?? 0) + 1;
      if (img._retries > 3) return;
      setTimeout(() => (img.src = `${img.src.replace(/&_r=\d+/, '')}&_r=${Date.now()}`), 300 * img._retries);
    });
    return layer;
  };

  const show = (i: number) => {
    index = i;
    layers.forEach((l, j) => l.setOpacity(j === i ? 0.75 : 0));
    const f = frames[i];
    panel.range.value = String(i);
    panel.time.textContent = hhmm(f.time);
    const nowIdx = frames.findIndex((fr) => fr.forecast) - 1;
    const diff = Math.round((f.time.getTime() - frames[nowIdx >= 0 ? nowIdx : frames.length - 1].time.getTime()) / 60000);
    panel.kind.innerHTML = f.forecast ? `<span class="fc">Vorhersage +${diff} min</span>` : diff === 0 ? 'Letzte Messung' : `Messung ${diff} min`;
  };

  const stop = () => {
    clearInterval(timer);
    timer = 0;
    panel.play.innerHTML = PLAY;
    panel.play.setAttribute('aria-label', 'Animation abspielen');
  };
  const play = () => {
    if (!frames.length) return;
    panel.play.innerHTML = PAUSE;
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
    layers = frames.map(makeLayer);
    let pending = layers.length;
    panel.progress.hidden = false;
    panel.progress.textContent = `Radar lädt … 0/${pending}`;
    layers.forEach((l) => {
      l.once('load', () => {
        pending--;
        panel.progress.textContent = `Radar lädt … ${layers.length - pending}/${layers.length}`;
        if (pending <= 0) panel.progress.hidden = true;
      });
      l.addTo(map);
    });
    setTimeout(() => (panel.progress.hidden = true), 15000);
    panel.range.max = String(frames.length - 1);
    const nowIdx = Math.max(0, frames.findIndex((f) => f.forecast) - 1);
    show(frames.some((f) => f.forecast) ? nowIdx : frames.length - 1);
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
