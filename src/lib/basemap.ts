import L from 'leaflet';
import kreiseUrl from '../assets/basemap-kreise.json?url';
import basemapUrl from '../assets/basemap.json?url';

/**
 * Calm vector basemap for the radar: dark sea, slightly lighter land, clear country borders and only a
 * few city names. Zoomed in, district and municipality borders and the names of smaller towns appear.
 * Built by scripts/make-basemap.sh from Natural Earth and VG250 (© GeoBasis-DE / BKG).
 *
 * Line colors are kept neutral (lavender/grey) on purpose: cyan, violet, pink and yellow belong to the rain.
 */

/** [name, lat, lon, minZoom] */
type Place = [string, number, number, number];
/** Line or polygon ring as integer deltas: [x0, y0, dx1, dy1, …] in 1/scale degrees. */
type Line = number[];
/** One map layer: lines (`l`) or polygons (`p`, a list of rings each), `s` units per degree. */
interface Encoded {
  s: number;
  l?: Line[];
  p?: Line[][];
}
type Layers = Record<'land' | 'coast' | 'lakes' | 'borders', Encoded>;
interface BasemapData extends Layers {
  /** Coarse rest of the world outside the detailed frame around Germany. */
  world: Layers;
  states: Encoded;
  /** Most important first. */
  places: Place[];
}
interface GemeindeTile {
  /** [id, ...line]; a line crossing tiles is in each of them, the id prevents drawing it twice. */
  g: number[][];
  p: Place[];
}

/** The whole world; Web Mercator ends at ±85°. */
export const MAP_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);
const KREISE_ZOOM = 8;
const GEMEINDEN_ZOOM = 10;
/** Tile size of the municipality data in degrees (TILE in the build script). */
const TILE = 1;

const tileUrls = new Map(
  Object.entries(import.meta.glob<string>('../assets/gemeinden/*.json', { query: '?url', import: 'default', eager: true })).map(
    ([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -5), url],
  ),
);

export const BASEMAP_ATTRIBUTION =
  'Karte: <a href="https://www.naturalearthdata.com">Natural Earth</a>, © <a href="https://www.bkg.bund.de">GeoBasis-DE / BKG</a> (2026)';

const requests = new Map<string, Promise<unknown>>();
function loadJson<T>(url: string): Promise<T> {
  let req = requests.get(url);
  if (!req) {
    req = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`basemap ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        requests.delete(url);
        throw err;
      });
    requests.set(url, req);
  }
  return req as Promise<T>;
}

function decode(line: Line, scale: number, start = 0): L.LatLngTuple[] {
  const out: L.LatLngTuple[] = [];
  let x = 0;
  let y = 0;
  for (let i = start; i < line.length; i += 2) {
    x += line[i];
    y += line[i + 1];
    out.push([y / scale, x / scale]);
  }
  return out;
}

/** Scale of the admin border data (Gemeinden, Kreise). */
const ADMIN_SCALE = 1e4;

const STYLE = {
  land: { stroke: false, fill: true, fillColor: '#1c0d40', fillOpacity: 1 },
  lakes: { stroke: false, fill: true, fillColor: '#020b26', fillOpacity: 1 },
  gemeinden: { color: '#9a86d6', weight: 0.7, opacity: 0.32 },
  kreise: { color: '#a796e0', weight: 0.9, opacity: 0.42 },
  coast: { color: '#7d6cc4', weight: 1, opacity: 0.6 },
  states: { color: '#b4a3ec', weight: 1, opacity: 0.5, dashArray: '4 4' },
  bordersGlow: { color: '#cdbdff', weight: 6, opacity: 0.08 },
  borders: { color: '#cdbdff', weight: 1.3, opacity: 0.7 },
} satisfies Record<string, L.PathOptions>;

/** City names with zoom-dependent density and collision culling, drawn above the rain. */
class PlaceLabels extends L.Layer {
  private box?: HTMLElement;
  private places: Place[] = [];
  private extra: Place[] = [];

  constructor(private keepFree: L.LatLng, options?: L.LayerOptions) {
    super(options);
  }

  setPlaces(p: Place[]) {
    this.places = p;
    this.redraw();
  }

  /** Smaller towns from the municipality tiles; all of them rank after the main places. */
  addPlaces(p: Place[]) {
    this.extra = this.extra.concat(p).sort((a, b) => a[3] - b[3]);
    this.redraw();
  }

  onAdd(map: L.Map) {
    this.box = L.DomUtil.create('div', 'place-labels', this.getPane());
    map.on('zoomstart', this.hide, this).on('moveend', this.redraw, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map) {
    map.off('zoomstart', this.hide, this).off('moveend', this.redraw, this);
    this.box?.remove();
    return this;
  }

  private hide() {
    this.box?.classList.add('hidden');
  }

  private redraw() {
    const map = this._map;
    if (!map || !this.box) return;
    const zoom = map.getZoom();
    const area = map.getPixelBounds().pad(0.15);
    const origin = map.getPixelOrigin();
    // Occupied screen boxes [x1, y1, x2, y2]; the own location dot is kept free.
    const dot = map.project(this.keepFree, zoom);
    const taken: number[][] = [[dot.x - 12, dot.y - 12, dot.x + 12, dot.y + 12]];
    const html: string[] = [];
    for (const list of [this.places, this.extra]) {
      for (const [name, lat, lon, minZoom] of list) {
        if (minZoom > zoom) continue;
        const p = map.project([lat, lon], zoom);
        if (!area.contains(p)) continue;
        const major = minZoom <= Math.max(5, zoom - 3);
        const w = name.length * (major ? 7.6 : 6.6) + 12;
        const b = [p.x - 4, p.y - 9, p.x + w, p.y + 9];
        if (taken.some((t) => b[0] < t[2] + 6 && b[2] + 6 > t[0] && b[1] < t[3] + 4 && b[3] + 4 > t[1])) continue;
        taken.push(b);
        const x = Math.round(p.x - origin.x);
        const y = Math.round(p.y - origin.y);
        html.push(`<span class="map-place${major ? ' major' : ''}" style="transform:translate(${x}px,${y}px)">${name}</span>`);
      }
    }
    this.box.innerHTML = html.join('');
    this.box.classList.remove('hidden');
  }
}

/** Adds the basemap below the radar and the city names above it. Data loads in the background. */
export function addBasemap(map: L.Map, location: L.LatLngExpression): void {
  // Separate canvases keep the order: areas, then admin borders, then the main lines.
  const pane = (name: string, z: number) => {
    map.createPane(name).style.zIndex = String(z);
    return L.canvas({ pane: name, padding: 0.3 });
  };
  const areas = pane('base-areas', 150);
  const admin = pane('base-admin', 151);
  const lines = pane('base-lines', 152);
  map.createPane('labels').style.zIndex = '430';
  map.getPane('labels')!.style.pointerEvents = 'none';

  const labels = new PlaceLabels(L.latLng(location), { pane: 'labels' }).addTo(map);
  const layer = (e: Encoded, style: L.PathOptions, renderer: L.Renderer) => {
    const options = { ...style, renderer, interactive: false };
    return e.p
      ? L.polygon(e.p.map((rings) => rings.map((r) => decode(r, e.s))), options)
      : L.polyline((e.l ?? []).map((l) => decode(l, e.s)), options);
  };
  const polylines = (ls: L.LatLngTuple[][], style: L.PathOptions) =>
    L.polyline(ls, { ...style, renderer: admin, interactive: false });

  let removed = false;
  map.once('unload', () => (removed = true));
  loadJson<BasemapData>(basemapUrl)
    .then((d) => {
      if (removed) return;
      const o = d.world;
      for (const [geoms, style, renderer] of [
        [o.land, STYLE.land, areas],
        [d.land, STYLE.land, areas],
        [o.lakes, STYLE.lakes, areas],
        [d.lakes, STYLE.lakes, areas],
        [d.states, STYLE.states, lines],
        [o.coast, STYLE.coast, lines],
        [d.coast, STYLE.coast, lines],
        [o.borders, STYLE.bordersGlow, lines],
        [d.borders, STYLE.bordersGlow, lines],
        [o.borders, STYLE.borders, lines],
        [d.borders, STYLE.borders, lines],
      ] as const) {
        layer(geoms, style, renderer).addTo(map);
      }
      labels.setPlaces(d.places);
    })
    .catch(() => {
      /* without a basemap the radar still works on the plain background */
    });

  // District borders from KREISE_ZOOM, one file loaded the first time it is needed.
  let kreise: L.Polyline | null = null;
  // Municipality borders and town names from GEMEINDEN_ZOOM, loaded per tile for the visible area.
  const gemeinden = L.layerGroup();
  const loadedTiles = new Set<string>();
  const drawnLines = new Set<number>();

  const loadTiles = () => {
    const b = map.getBounds().pad(0.2);
    for (let tx = Math.floor(b.getWest() / TILE); tx <= Math.floor(b.getEast() / TILE); tx++) {
      for (let ty = Math.floor(b.getSouth() / TILE); ty <= Math.floor(b.getNorth() / TILE); ty++) {
        const key = `${tx}_${ty}`;
        const url = tileUrls.get(key);
        if (!url || loadedTiles.has(key)) continue;
        loadedTiles.add(key);
        loadJson<GemeindeTile>(url)
          .then((t) => {
            if (removed) return;
            const ls: L.LatLngTuple[][] = [];
            for (const g of t.g) {
              if (drawnLines.has(g[0])) continue;
              drawnLines.add(g[0]);
              ls.push(decode(g, ADMIN_SCALE, 1));
            }
            if (ls.length) gemeinden.addLayer(polylines(ls, STYLE.gemeinden));
            labels.addPlaces(t.p);
          })
          .catch(() => loadedTiles.delete(key));
      }
    }
  };

  const update = () => {
    const zoom = map.getZoom();
    if (zoom >= KREISE_ZOOM && !kreise) {
      loadJson<Line[]>(kreiseUrl)
        .then((ls) => {
          if (removed || kreise) return;
          kreise = polylines(ls.map((l) => decode(l, ADMIN_SCALE)), STYLE.kreise);
          update();
        })
        .catch(() => {});
    }
    if (kreise) {
      if (zoom >= KREISE_ZOOM) map.addLayer(kreise);
      else map.removeLayer(kreise);
    }
    if (zoom >= GEMEINDEN_ZOOM) {
      map.addLayer(gemeinden);
      loadTiles();
    } else {
      map.removeLayer(gemeinden);
    }
  };
  map.on('moveend', update);
  map.whenReady(update);
}

/** Lowest zoom at which the view still fits into MAP_BOUNDS (depends on the screen size). */
export function fitMinZoom(map: L.Map): number {
  return Math.max(2, map.getBoundsZoom(MAP_BOUNDS, true));
}
