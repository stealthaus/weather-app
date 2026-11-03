// Line icons for Bright Sky's `icon` values. Stroke uses currentColor; sun and rain get accent colors.
const sun = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>';
const moon = '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>';
const cloud = '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.6 9.2 4.7 4.7 0 0 0 7 18.5z"/>';
const smallSun = '<g class="sun"><circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.4M1.8 8h1.4M3.6 3.6l1 1M12.4 3.6l-1 1"/></g>';
const smallMoon = '<g class="sun"><path d="M11 7.6A4 4 0 0 1 5.6 2.4a4.2 4.2 0 1 0 5.4 5.2z"/></g>';
const cloudBack = '<path d="M9 17.5h9a3.6 3.6 0 0 0 .5-7.1 4.9 4.9 0 0 0-9.3-1.2A4.2 4.2 0 0 0 9 17.5z" fill="var(--bg)"/>';
const cloudUp = '<path d="M7 15h10.5a3.6 3.6 0 0 0 .55-7.15A5 5 0 0 0 7.6 6.6 4.2 4.2 0 0 0 7 15z"/>';
const drops = '<g class="rain"><path d="M8.5 17.5l-1 3M12.5 17.5l-1 3M16.5 17.5l-1 3"/></g>';
const flakes = '<g class="snow"><path d="M8 18.5v3M6.7 19.3l2.6 1.4M6.7 20.7l2.6-1.4M15 18.5v3M13.7 19.3l2.6 1.4M13.7 20.7l2.6-1.4"/></g>';
const sleet = '<g class="rain"><path d="M8.5 17.5l-1 3"/></g><g class="snow"><path d="M14 18.5v3M12.7 19.3l2.6 1.4M12.7 20.7l2.6-1.4"/></g>';
const hail = '<g class="rain"><circle cx="8.5" cy="19.5" r="1"/><circle cx="12.5" cy="20.5" r="1"/><circle cx="16.5" cy="19.5" r="1"/></g>';
const bolt = '<path class="bolt" d="M12.5 15.5l-2 3.5h3l-2 3.5"/>';
const fog = '<path d="M4 9h16M3 12.5h18M5 16h14M7 19.5h10"/>';
const wind = '<path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.5 2.5 0 1 1-2.5 2.5M3 17h8"/>';

const SHAPES: Record<string, string> = {
  'clear-day': `<g class="sun">${sun}</g>`,
  'clear-night': moon,
  'partly-cloudy-day': smallSun + cloudBack + '<path d="M9 17.5h9a3.6 3.6 0 0 0 .5-7.1 4.9 4.9 0 0 0-9.3-1.2A4.2 4.2 0 0 0 9 17.5z"/>',
  'partly-cloudy-night': smallMoon + cloudBack + '<path d="M9 17.5h9a3.6 3.6 0 0 0 .5-7.1 4.9 4.9 0 0 0-9.3-1.2A4.2 4.2 0 0 0 9 17.5z"/>',
  cloudy: cloud,
  fog,
  wind,
  rain: cloudUp + drops,
  sleet: cloudUp + sleet,
  snow: cloudUp + flakes,
  hail: cloudUp + hail,
  thunderstorm: cloudUp + bolt,
};

export function wxIcon(icon: string | null | undefined, cls = 'wx'): string {
  const body = SHAPES[icon ?? ''] ?? cloud;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const LABELS: Record<string, string> = {
  'clear-day': 'Klar',
  'clear-night': 'Klar',
  'partly-cloudy-day': 'Teils bewölkt',
  'partly-cloudy-night': 'Teils bewölkt',
  cloudy: 'Bedeckt',
  fog: 'Nebel',
  wind: 'Windig',
  rain: 'Regen',
  sleet: 'Schneeregen',
  snow: 'Schnee',
  hail: 'Hagel',
  thunderstorm: 'Gewitter',
};

export function wxLabel(icon: string | null | undefined, precipMm?: number | null): string {
  const base = LABELS[icon ?? ''] ?? 'Unbekannt';
  if (icon === 'rain' && precipMm != null) {
    if (precipMm < 0.5) return 'Leichter Regen';
    if (precipMm >= 4) return 'Starker Regen';
  }
  return base;
}

/** Severity used to pick a representative icon for a whole day. */
export const ICON_RANK: Record<string, number> = {
  thunderstorm: 9,
  hail: 8,
  snow: 7,
  sleet: 6,
  rain: 5,
  fog: 3,
  wind: 3,
  cloudy: 2,
  'partly-cloudy-day': 1,
  'partly-cloudy-night': 1,
  'clear-day': 0,
  'clear-night': 0,
};
