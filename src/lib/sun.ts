const RAD = Math.PI / 180;

/**
 * Length of the day in hours (sunrise to sunset, sun centre at -0.833° for refraction)
 * for a local date "YYYY-MM-DD". Accurate to a few minutes, enough for a percentage.
 */
export function daylightHours(lat: number, ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const dayOfYear = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  // NOAA approximation of the solar declination
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = lat * RAD;
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
  if (cosH <= -1) return 24; // midnight sun
  if (cosH >= 1) return 0; // polar night
  return (2 * Math.acos(cosH)) / RAD / 15;
}

export interface DaySun {
  hours: number;
  dayHours: number;
  /** Sunshine hours / day length, 0..1 */
  share: number;
}

/**
 * Sums hourly sunshine minutes (Bright Sky / MOSMIX) per local date and relates them
 * to the day length. Days with fewer than 20 hourly values are left out as incomplete.
 */
export function sunshineByDay(hours: { timestamp: string; sunshine: number | null }[], lat: number): Map<string, DaySun> {
  const minutes = new Map<string, number[]>();
  for (const h of hours) {
    if (h.sunshine == null) continue;
    const date = h.timestamp.slice(0, 10);
    if (!minutes.has(date)) minutes.set(date, []);
    minutes.get(date)!.push(h.sunshine);
  }
  const out = new Map<string, DaySun>();
  minutes.forEach((list, date) => {
    if (list.length < 20) return;
    const sunHours = list.reduce((a, b) => a + b, 0) / 60;
    const dayHours = daylightHours(lat, date);
    out.set(date, { hours: sunHours, dayHours, share: dayHours > 0 ? Math.min(1, sunHours / dayHours) : 0 });
  });
  return out;
}

/** Whether the sun is up at `lon`/`lat` at time `at` (solar noon from longitude, ± a quarter hour). */
export function isDaytime(lat: number, lon: number, at = new Date()): boolean {
  const dayHours = daylightHours(lat, at.toISOString().slice(0, 10));
  const utcHours = at.getUTCHours() + at.getUTCMinutes() / 60;
  const fromNoon = ((utcHours - (12 - lon / 15) + 36) % 24) - 12;
  return Math.abs(fromNoon) < dayHours / 2;
}
