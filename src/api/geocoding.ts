import { getJson } from '../lib/http';
import type { Place } from '../lib/places';

interface GeoResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  postcodes?: string[];
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=de&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as { results?: GeoResult[] };
  return (data.results ?? []).map((r) => ({
    id: `geo:${r.id}`,
    name: r.name,
    detail: [r.postcodes?.[0], r.admin2 && r.admin2 !== r.name ? r.admin2 : null, r.admin1, r.country_code !== 'DE' ? r.country : null]
      .filter(Boolean)
      .join(', '),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone,
  }));
}

/** Best-effort place name for coordinates (OpenStreetMap Nominatim). */
export async function reverseName(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await getJson<{ address?: Record<string, string> }>(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&zoom=12&accept-language=de`,
      6000,
    );
    const a = r.address ?? {};
    return a.city || a.town || a.village || a.municipality || a.suburb || a.county || null;
  } catch {
    return null;
  }
}
