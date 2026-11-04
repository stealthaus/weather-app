/**
 * Fixed temperature colour scale (°C), independent of the forecast's own min/max:
 * blue in single digits, yellow around 11°, reddish from 15° on.
 */
const STOPS: [number, [number, number, number]][] = [
  [-15, [123, 92, 199]], // violet
  [-5, [58, 100, 200]],
  [0, [47, 123, 216]], // blue
  [7, [75, 163, 227]], // light blue
  [11, [240, 194, 74]], // yellow
  [14, [236, 128, 58]], // orange
  [18, [222, 72, 56]], // red
  [27, [176, 34, 58]], // deep red
];

export function tempRgb(t: number): [number, number, number] {
  if (t <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (t <= t1) {
      const [t0, c0] = STOPS[i - 1];
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function tempColor(t: number): string {
  return `rgb(${tempRgb(t).join(' ')})`;
}

/** CSS gradient for a bar spanning lo..hi °C, with the scale's stops at their true positions. */
export function tempGradient(lo: number, hi: number): string {
  if (hi - lo < 0.5) return tempColor((lo + hi) / 2);
  const pos = (t: number) => `${(((t - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const inner = STOPS.filter(([t]) => t > lo && t < hi).map(([t]) => `${tempColor(t)} ${pos(t)}`);
  return `linear-gradient(90deg, ${[tempColor(lo), ...inner, tempColor(hi)].join(', ')})`;
}
