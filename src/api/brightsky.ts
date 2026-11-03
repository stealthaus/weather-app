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
  condition: string | null;
  icon: string | null;
}

export async function currentWeather(lat: number, lon: number, tz: string) {
  return getJson<{ weather: CurrentWeather; sources: Source[] }>(
    `${BASE}/current_weather?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`,
  );
}

/** Hourly MOSMIX forecast (plus recent observations) for the next ~10 days. */
export async function forecast(lat: number, lon: number, tz: string) {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000);
  const to = new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000);
  const res = await getJson<{ weather: HourlyWeather[]; sources: Source[] }>(
    `${BASE}/weather?lat=${lat}&lon=${lon}&date=${from.toISOString()}&last_date=${to.toISOString()}&tz=${encodeURIComponent(tz)}`,
  );
  // Keep forecast rows only so all hours come from the same MOSMIX station.
  const fc = new Set(res.sources.filter((s) => s.observation_type === 'forecast').map((s) => s.id));
  return { weather: res.weather.filter((w) => fc.has(w.source_id)), sources: res.sources };
}
