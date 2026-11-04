import L from 'leaflet';
import urbanUrl from '../assets/basemap-urban.json?url';
import basemapUrl from '../assets/basemap.json?url';

/**
 * Calm vector basemap for the radar: dark sea, slightly lighter land, clear country borders and only a
 * few city names. Zoomed in, built-up areas show the outlines of the cities.
 * Built from Natural Earth by scripts/make-basemap.sh.
 *
 * Line colors are kept neutral (lavender/grey) on purpose: cyan, violet, pink and yellow belong to the rain.
 */

type Geometry = { type: string; coordinates: unknown };
interface BasemapData {
  /** Coarse Europe outside the detailed frame, for zooming out. */
  overview: { land: Geometry[]; coast: Geometry[]; lakes: Geometry[]; borders: Geometry[] };
  land: Geometry[];
  coast: Geometry[];
  lakes: Geometry[];
  borders: Geometry[];
  states: Geometry[];
  /** [name, lat, lon, minZoom], most important first */
  places: [string, number, number, number][];
}

/** The view stays inside this frame, so the cut edges of the data (OVERVIEW in the build script) are never visible. */
export const MAP_BOUNDS = L.latLngBounds([31, -29], [71, 49]);
/** City outlines from this zoom on. */
const URBAN_ZOOM = 9;

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

const STYLE = {
  land: { stroke: false, fill: true, fillColor: '#1c0d40', fillOpacity: 1 },
  lakes: { stroke: false, fill: true, fillColor: '#020b26', fillOpacity: 1 },
  urban: { color: '#9583dd', weight: 0.8, opacity: 0.45, fill: true, fillColor: '#2c1858', fillOpacity: 0.9 },
  coast: { color: '#7d6cc4', weight: 1, opacity: 0.6 },
  states: { color: '#9a86d6', weight: 0.8, opacity: 0.35, dashArray: '3 4' },
  bordersGlow: { color: '#cdbdff', weight: 6, opacity: 0.08 },
  borders: { color: '#cdbdff', weight: 1.3, opacity: 0.7 },
} satisfies Record<string, L.PathOptions>;

/** City names with zoom-dependent density and collision culling, drawn above the rain. */
class PlaceLabels extends L.Layer {
  private box?: HTMLElement;
  private places: BasemapData['places'] = [];

  constructor(private keepFree: L.LatLng, options?: L.LayerOptions) {
    super(options);
  }

  setPlaces(p: BasemapData['places']) {
    this.places = p;
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
    for (const [name, lat, lon, minZoom] of this.places) {
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
    this.box.innerHTML = html.join('');
    this.box.classList.remove('hidden');
  }
}

/** Adds the basemap below the radar and the city names above it. Data loads in the background. */
export function addBasemap(map: L.Map, location: L.LatLngExpression): void {
  // Separate canvases keep the order: areas, then city outlines, then lines.
  const pane = (name: string, z: number) => {
    map.createPane(name).style.zIndex = String(z);
    return L.canvas({ pane: name, padding: 0.3 });
  };
  const areas = pane('base-areas', 150);
  const urban = pane('base-urban', 151);
  const lines = pane('base-lines', 152);
  map.createPane('labels').style.zIndex = '430';
  map.getPane('labels')!.style.pointerEvents = 'none';

  const labels = new PlaceLabels(L.latLng(location), { pane: 'labels' }).addTo(map);
  const layer = (geoms: Geometry[], style: L.PathOptions, renderer: L.Renderer) =>
    L.geoJSON(geoms as unknown as GeoJSON.GeoJsonObject, { style, renderer, interactive: false } as L.GeoJSONOptions);

  let removed = false;
  map.once('unload', () => (removed = true));
  loadJson<BasemapData>(basemapUrl)
    .then((d) => {
      if (removed) return;
      const o = d.overview;
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

  // City outlines only when zoomed in; the data is loaded the first time it is needed.
  let urbanLayer: L.GeoJSON | null = null;
  const toggleUrban = () => {
    const want = map.getZoom() >= URBAN_ZOOM;
    if (want && !urbanLayer) {
      loadJson<Geometry[]>(urbanUrl)
        .then((g) => {
          if (removed || urbanLayer) return;
          urbanLayer = layer(g, STYLE.urban, urban);
          toggleUrban();
        })
        .catch(() => {});
    } else if (urbanLayer) {
      if (want) map.addLayer(urbanLayer);
      else map.removeLayer(urbanLayer);
    }
  };
  map.on('zoomend', toggleUrban);
  map.whenReady(toggleUrban);
}

/** Lowest zoom at which the view still fits into MAP_BOUNDS (depends on the screen size). */
export function fitMinZoom(map: L.Map): number {
  return Math.max(4, map.getBoundsZoom(MAP_BOUNDS, true));
}
