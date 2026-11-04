import L from 'leaflet';
import basemapUrl from '../assets/basemap.json?url';

/**
 * Calm vector basemap for the radar: dark sea, slightly lighter land, clear country borders and only a
 * few city names. Built from Natural Earth by scripts/make-basemap.sh.
 *
 * Line colors are kept neutral (lavender/grey) on purpose: cyan, violet, pink and yellow belong to the rain.
 */

type Geometry = { type: string; coordinates: unknown };
interface BasemapData {
  land: Geometry[];
  coast: Geometry[];
  lakes: Geometry[];
  borders: Geometry[];
  states: Geometry[];
  /** [name, lat, lon, minZoom], most important first */
  places: [string, number, number, number][];
}

/** The view stays inside this frame, so the cut edges of the data (BBOX in the build script) are never visible. */
export const MAP_BOUNDS = L.latLngBounds([42, -5], [60, 25]);

let data: Promise<BasemapData> | null = null;
function loadData(): Promise<BasemapData> {
  data ??= fetch(basemapUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`basemap ${r.status}`);
      return r.json() as Promise<BasemapData>;
    })
    .catch((err) => {
      data = null;
      throw err;
    });
  return data;
}

const STYLE = {
  land: { stroke: false, fill: true, fillColor: '#1c0d40', fillOpacity: 1 },
  lakes: { stroke: false, fill: true, fillColor: '#020b26', fillOpacity: 1 },
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
  map.createPane('base').style.zIndex = '150';
  map.createPane('labels').style.zIndex = '430';
  map.getPane('labels')!.style.pointerEvents = 'none';

  const renderer = L.canvas({ pane: 'base', padding: 0.3 });
  const labels = new PlaceLabels(L.latLng(location), { pane: 'labels' }).addTo(map);

  let removed = false;
  map.once('unload', () => (removed = true));
  loadData()
    .then((d) => {
      if (removed) return;
      const layer = (geoms: Geometry[], style: L.PathOptions) =>
        L.geoJSON(geoms as unknown as GeoJSON.GeoJsonObject, { style, renderer, interactive: false } as L.GeoJSONOptions).addTo(map);
      layer(d.land, STYLE.land);
      layer(d.lakes, STYLE.lakes);
      layer(d.states, STYLE.states);
      layer(d.coast, STYLE.coast);
      layer(d.borders, STYLE.bordersGlow);
      layer(d.borders, STYLE.borders);
      labels.setPlaces(d.places);
    })
    .catch(() => {
      /* without a basemap the radar still works on the plain background */
    });
}

/** Lowest zoom at which the view still fits into MAP_BOUNDS (depends on the screen size). */
export function fitMinZoom(map: L.Map): number {
  return Math.max(5, map.getBoundsZoom(MAP_BOUNDS, true));
}
