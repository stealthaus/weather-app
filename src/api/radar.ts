export const RADAR_WMS = 'https://maps.dwd.de/geoserver/dwd/wms';
export const RADAR_LAYER = 'dwd:Radar_wn-product_1x1km_ger';
/** ICON-EU precipitation of the past hour (~7 km grid), continues the forecast after the 2 h nowcast. */
export const MODEL_LAYER = 'dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H';
// Layer-scoped capabilities are ~40 KB instead of ~1 MB for the whole workspace.
const CAPABILITIES = 'https://maps.dwd.de/geoserver/dwd/Radar_wn-product_1x1km_ger/wms?service=WMS&version=1.3.0&request=GetCapabilities';
const NOWCAST_MS = 2 * 60 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Geographic extent of the layer (from GetCapabilities); outside of it the WMS only returns transparency. */
export const RADAR_DOMAIN = { south: 45.68, west: 1.46, north: 56.22, east: 18.73 };

export interface RadarFrame {
  time: Date;
  forecast: boolean;
  /** Model forecast (hourly ICON-EU) instead of radar measurement or nowcast. */
  model: boolean;
  layer: string;
}

/** dBZ colour scale of the DWD layer (from GetLegendGraphic), mapped to neon contour levels in lib/contour. */
export const DBZ_COLORS = ['#99FFFF', '#33FFFF', '#00CACA', '#009934', '#4DBF1A', '#99CC00', '#CCE600', '#FFFF00', '#FFC400', '#FF8900', '#FF0000', '#B40000', '#4848FF', '#0000CA', '#990099', '#FF33FF'];

/** mm/h colour scale (LAWA) of the ICON-EU layer: 0.1, 2, 5, 10, 15, 20, 25, 30, 40, 60, 80, 100, 130, 160 mm. */
export const MODEL_COLORS = ['#C0C0C0', '#FEFEC0', '#FEFE5B', '#CFF200', '#A0D625', '#36C969', '#00D7D7', '#00A6DD', '#0000FE', '#9730C2', '#D926C7', '#FE0000', '#A00000', '#606060'];

async function capabilitiesEnd(): Promise<number> {
  const res = await fetch(`${CAPABILITIES}&_=${Date.now()}-${Math.random()}`);
  if (!res.ok) throw new Error(String(res.status));
  const m = (await res.text()).match(/<Dimension name="time"[^>]*>[^<]*\/([0-9T:.\-]+Z)\/PT5M/);
  if (!m) throw new Error('no time dimension');
  return new Date(m[1]).getTime();
}

/**
 * Reads the layer's time dimension ("start/end/PT5M"). The end is the last nowcast step,
 * the latest measurement is two hours before that. The DWD GeoServer sits behind a load
 * balancer whose nodes are not always in sync, so ask a few times and keep the newest.
 */
async function latestTimes(): Promise<{ analysis: Date; end: Date }> {
  const ends = await Promise.allSettled([capabilitiesEnd(), capabilitiesEnd(), capabilitiesEnd()]);
  const end = Math.max(...ends.map((r) => (r.status === 'fulfilled' ? r.value : 0)));
  if (end < Date.now() - 3 * 60 * 60 * 1000) throw new Error('radar data outdated');
  return { end: new Date(end), analysis: new Date(end - NOWCAST_MS) };
}

/** One GetMap image for an EPSG:3857 bounding box [minX, minY, maxX, maxY] in metres. */
export function radarImageUrl(layer: string, time: Date, bbox: number[], width: number, height: number): string {
  const p = new URLSearchParams({
    service: 'WMS',
    request: 'GetMap',
    version: '1.3.0',
    layers: layer,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:3857',
    bbox: bbox.map((v) => v.toFixed(1)).join(','),
    width: String(width),
    height: String(height),
    time: time.toISOString(),
  });
  return `${RADAR_WMS}?${p}`;
}

/**
 * Frames from `pastMin` before the latest measurement up to the end of the nowcast (+2 h).
 * If `horizonMin` reaches further, hourly model frames follow up to that point.
 */
export async function radarFrames(pastMin = 60, stepMin = 15, horizonMin = 120): Promise<RadarFrame[]> {
  let analysis: Date;
  let end: Date;
  try {
    ({ analysis, end } = await latestTimes());
  } catch {
    // Fallback: assume the newest measurement is ~10 minutes old, no nowcast.
    analysis = new Date(Math.floor((Date.now() - 10 * 60 * 1000) / STEP_MS) * STEP_MS);
    end = analysis;
  }
  const step = stepMin * 60 * 1000;
  const frames: RadarFrame[] = [];
  // Anchor on the analysis time so "now" is always one of the frames.
  for (let t = analysis.getTime() - pastMin * 60 * 1000; t <= end.getTime(); t += step) {
    frames.push({ time: new Date(t), forecast: t > analysis.getTime(), model: false, layer: RADAR_LAYER });
  }
  const horizon = analysis.getTime() + horizonMin * 60 * 1000;
  for (let t = Math.floor(end.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS; t <= horizon; t += HOUR_MS) {
    frames.push({ time: new Date(t), forecast: true, model: true, layer: MODEL_LAYER });
  }
  return frames;
}
