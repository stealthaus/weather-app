import { getJson } from '../lib/http';
import { finite, median, percentile } from '../lib/stats';
import { daylightHours } from '../lib/sun';

export type ModelChoice = 'ecmwf' | 'ecmwf+icon';
export type RainThreshold = 0.1 | 1;

type Series = Record<string, (number | null)[]> & { time: string[] };

interface EnsembleDaily {
  daily: Series;
  hourly: Series;
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
  /** Sunshine as share (0..1) of the day length; null if no member covers the whole day. */
  sun: Band | null;
}

const VARS = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'] as const;

function url(model: string, lat: number, lon: number, days: number) {
  return (
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&daily=${VARS.join(',')}&hourly=sunshine_duration&models=${model}&forecast_days=${days}&timezone=auto`
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

/**
 * Sunshine hours per day and member, summed from hourly values. The daily
 * `sunshine_duration` of the ECMWF ensemble is too coarse (mostly a flat 3 h).
 */
function sunshineByDay(d: EnsembleDaily): Map<string, number[]> {
  const keys = Object.keys(d.hourly).filter((k) => k.startsWith('sunshine_duration'));
  const sums = new Map<string, number[][]>();
  d.hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    if (!sums.has(date)) sums.set(date, keys.map(() => []));
    keys.forEach((k, m) => {
      const v = d.hourly[k][i];
      if (v != null) sums.get(date)![m].push(v);
    });
  });
  const out = new Map<string, number[]>();
  sums.forEach((perMember, date) => {
    out.set(
      date,
      perMember.filter((vals) => vals.length === 24).map((vals) => vals.reduce((a, b) => a + b, 0) / 3600),
    );
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

export function computeTrend(raw: RawEnsemble, threshold: RainThreshold, lat: number): TrendDay[] {
  const sources = [raw.ecmwf, ...(raw.icon ? [raw.icon] : [])];
  const perVar = VARS.map((v) => sources.map((s) => membersByDay(s, v)));
  const sunMaps = sources.map(sunshineByDay);
  const days: TrendDay[] = [];
  for (const date of raw.ecmwf.daily.time) {
    const [tmax, tmin, precip] = perVar.map((maps) => maps.flatMap((m) => m.get(date) ?? []));
    if (tmax.length < 5 || tmin.length < 5) continue; // incomplete last day
    const dayHours = daylightHours(lat, date);
    const sun = sunMaps.flatMap((m) => m.get(date) ?? []).map((h) => (dayHours > 0 ? Math.min(1, h / dayHours) : 0));
    days.push({
      date,
      members: tmax.length,
      tmax: band(tmax),
      tmin: band(tmin),
      precip: band(precip),
      rainProb: precip.length ? precip.filter((p) => p >= threshold).length / precip.length : NaN,
      sun: sun.length >= 5 ? band(sun) : null,
    });
  }
  return days;
}
