import { getJson } from '../lib/http';
import { finite, median, percentile } from '../lib/stats';

export type ModelChoice = 'ecmwf' | 'ecmwf+icon';
export type RainThreshold = 0.1 | 1;

interface EnsembleDaily {
  daily: Record<string, (number | null)[]> & { time: string[] };
}

export interface Band {
  p10: number;
  p50: number;
  p90: number;
}

export interface TrendDay {
  date: string;
  members: number;
  tmax: Band;
  tmin: Band;
  precip: Band;
  /** Share of members (0..1) with daily precipitation above the threshold. */
  rainProb: number;
}

const VARS = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'] as const;

function url(model: string, lat: number, lon: number, days: number) {
  return (
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&daily=${VARS.join(',')}&models=${model}&forecast_days=${days}&timezone=auto`
  );
}

/** Collects, per day, the values of every ensemble member for one variable. */
function membersByDay(d: EnsembleDaily, variable: string): Map<string, number[]> {
  const keys = Object.keys(d.daily).filter((k) => k === variable || k.startsWith(`${variable}_member`));
  const out = new Map<string, number[]>();
  d.daily.time.forEach((date, i) => {
    out.set(date, finite(keys.map((k) => d.daily[k][i])));
  });
  return out;
}

export interface RawEnsemble {
  ecmwf: EnsembleDaily;
  icon: EnsembleDaily | null;
}

export async function loadEnsemble(lat: number, lon: number, withIcon: boolean): Promise<RawEnsemble> {
  const [ecmwf, icon] = await Promise.all([
    getJson<EnsembleDaily>(url('ecmwf_ifs025', lat, lon, 15), 25000),
    withIcon ? getJson<EnsembleDaily>(url('icon_seamless_eps', lat, lon, 8), 25000).catch(() => null) : Promise.resolve(null),
  ]);
  return { ecmwf, icon };
}

function band(values: number[]): Band {
  return { p10: percentile(values, 0.1), p50: median(values), p90: percentile(values, 0.9) };
}

export function computeTrend(raw: RawEnsemble, threshold: RainThreshold): TrendDay[] {
  const sources = [raw.ecmwf, ...(raw.icon ? [raw.icon] : [])];
  const perVar = VARS.map((v) => sources.map((s) => membersByDay(s, v)));
  const days: TrendDay[] = [];
  for (const date of raw.ecmwf.daily.time) {
    const [tmax, tmin, precip] = perVar.map((maps) => maps.flatMap((m) => m.get(date) ?? []));
    if (tmax.length < 5 || tmin.length < 5) continue; // incomplete last day
    days.push({
      date,
      members: tmax.length,
      tmax: band(tmax),
      tmin: band(tmin),
      precip: band(precip),
      rainProb: precip.length ? precip.filter((p) => p >= threshold).length / precip.length : NaN,
    });
  }
  return days;
}
