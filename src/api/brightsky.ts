import { getJson } from '../lib/http';

const BASE = 'https://api.brightsky.dev';

export interface Source {
  id: number;
  observation_type: 'forecast' | 'synop' | 'current' | 'historical';
  station_name: string;
  distance: number;
}

export interface CurrentWeather {
  timestamp: string;
  temperature: number | null;
  condition: string | null;
  icon: string | null;
  cloud_cover: number | null;
  dew_point: number | null;
  relative_humidity: number | null;
  pressure_msl: number | null;
  precipitation_60: number | null;
  wind_speed_10: number | null;
  wind_direction_10: number | null;
  wind_gust_speed_10: number | null;
  visibility: number | null;
  sunshine_60: number | null;
  source_id: number;
}

export interface HourlyWeather {
  timestamp: string;
  source_id: number;
  temperature: number | null;
  precipitation: number | null;
  precipitation_probability: number | null;
  wind_speed: number | null;
  wind_gust_speed: number | null;
  cloud_cover: number | null;
  /** Minutes of sunshine in the hour ending at `timestamp`. */
  sunshine: number | null;
  condition: string | null;
  icon: string | null;
}

export async function currentWeather(lat: number, lon: number, tz: string) {
  return getJson<{ weather: CurrentWeather; sources: Source[] }>(
    `${BASE}/current_weather?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`,
  );
}

/**
 * Hourly weather from local midnight today for ~10 days: station observations for the
 * hours already past, DWD MOSMIX forecast for the rest (Bright Sky merges both).
 */
export async function forecast(lat: number, lon: number, tz: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const to = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString();
  const res = await getJson<{ weather: HourlyWeather[]; sources: Source[] }>(
    `${BASE}/weather?lat=${lat}&lon=${lon}&date=${today}&last_date=${to}&tz=${encodeURIComponent(tz)}`,
  );
  const seen = new Set<string>();
  const weather = res.weather.filter((w) => !seen.has(w.timestamp) && seen.add(w.timestamp));
  return { weather, sources: res.sources };
}
