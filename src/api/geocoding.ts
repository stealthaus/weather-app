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

const MAX_FOREIGN = 4;

async function openMeteo(query: string, count: number, signal?: AbortSignal, countryCode?: string): Promise<GeoResult[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${count}&language=de&format=json` +
    (countryCode ? `&countryCode=${countryCode}` : '');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (${res.status})`);
  return ((await res.json()) as { results?: GeoResult[] }).results ?? [];
}

function toPlace(r: GeoResult): Place {
  return {
    id: `geo:${r.id}`,
    name: r.name,
    detail: [r.postcodes?.[0], r.admin2 && r.admin2 !== r.name ? r.admin2 : null, r.admin1, r.country_code !== 'DE' ? r.country : null]
      .filter(Boolean)
      .join(', '),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone,
  };
}

/** German postcodes via Nominatim; Open-Meteo only knows US-style ZIP codes. */
async function postcode(code: string, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?postalcode=${code}&country=de&format=jsonv2&addressdetails=1&limit=5&accept-language=de`,
    { signal },
  );
  if (!res.ok) throw new Error(`Ortssuche fehlgeschlagen (${res.status})`);
  const list = (await res.json()) as { place_id: number; lat: string; lon: string; address: Record<string, string> }[];
  return list.map((r) => {
    const a = r.address;
    const town = a.city || a.town || a.village || a.municipality || '';
    return {
      id: `plz:${code}:${r.place_id}`,
      name: `${code} ${town}`.trim(),
      detail: [a.suburb || a.city_district, a.state].filter(Boolean).join(', '),
      lat: Number(Number(r.lat).toFixed(4)),
      lon: Number(Number(r.lon).toFixed(4)),
      timezone: 'Europe/Berlin',
    };
  });
}

/** German places first, then a few matches from elsewhere. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  if (/^\d{5}$/.test(query)) return postcode(query, signal);
  const [de, world] = await Promise.all([openMeteo(query, 8, signal, 'DE'), openMeteo(query, 10, signal)]);
  const seen = new Set(de.map((r) => r.id));
  const foreign = world.filter((r) => r.country_code !== 'DE' && !seen.has(r.id)).slice(0, MAX_FOREIGN);
  return [...de, ...foreign].map(toPlace);
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
