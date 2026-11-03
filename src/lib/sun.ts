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
