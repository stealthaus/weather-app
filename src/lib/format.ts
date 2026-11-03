const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** "2026-11-03T16:00:00+01:00" -> 16 (hour in the location's local time). */
export function localHour(iso: string): number {
  return Number(iso.slice(11, 13));
}

/** "2026-11-03..." -> "2026-11-03" (local date as delivered by the API). */
export function localDate(iso: string): string {
  return iso.slice(0, 10);
}

function dateParts(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function weekday(ymd: string, todayYmd?: string): string {
  if (todayYmd && ymd === todayYmd) return 'Heute';
  return WD[dateParts(ymd).getUTCDay()];
}

export function shortDate(ymd: string): string {
  const d = dateParts(ymd);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
}

export function deg(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const r = Number(v.toFixed(digits));
  return `${(Object.is(r, -0) ? 0 : r).toLocaleString('de-DE', { minimumFractionDigits: digits })}°`;
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function hhmm(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone });
}

const DIRS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
export function windDir(deg: number | null | undefined): string {
  if (deg == null) return '';
  return DIRS[Math.round(deg / 45) % 8];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "KOELN (BOTAN.GART.)" -> "Koeln (Botan.Gart.)" */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(/.-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
