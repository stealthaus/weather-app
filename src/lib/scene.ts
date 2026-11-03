// Synthwave picture behind the current temperature: a striped sun or moon over a neon grid,
// with clouds, rain, lightning, snow or fog depending on the weather icon.

type Scene = 'clear' | 'partly' | 'cloudy' | 'rain' | 'thunder' | 'snow' | 'fog';

const SCENE_OF: Record<string, Scene> = {
  'clear-day': 'clear',
  'clear-night': 'clear',
  'partly-cloudy-day': 'partly',
  'partly-cloudy-night': 'partly',
  cloudy: 'cloudy',
  wind: 'cloudy',
  rain: 'rain',
  sleet: 'rain',
  hail: 'rain',
  thunderstorm: 'thunder',
  snow: 'snow',
  fog: 'fog',
};

const W = 375;
const H = 300;
const CX = W / 2;
const CY = 197;
const R = 115;
const HORIZON = 290;
const CLOUD = 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.6 9.2 4.7 4.7 0 0 0 7 18.5z';
const PINK = '#ff2fd6';
const CYAN = '#2de2e6';
const VIOLET = '#8f7bff';

/** Deterministic pseudo-random numbers, so rain and snow don't jump between renders. */
function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

const f = (n: number, d = 0) => n.toFixed(d);

function disc(grad: string): string {
  return `<g clip-path="url(#sc-hz)" mask="url(#sc-stripes)"><circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#${grad})"/></g>`;
}

function sun(opacity = 1): string {
  return `<g opacity="${opacity}"><circle cx="${CX}" cy="${CY}" r="${R + 10}" fill="url(#sc-sun)" opacity=".55" filter="url(#sc-blur)" clip-path="url(#sc-hz)"/>${disc('sc-sun')}</g>`;
}

function moon(opacity = 1): string {
  return `<g opacity="${opacity}"><circle cx="${CX}" cy="${CY}" r="${R + 10}" fill="${VIOLET}" opacity=".35" filter="url(#sc-blur)" clip-path="url(#sc-hz)"/><g mask="url(#sc-crescent)">${disc('sc-moon')}</g></g>`;
}

function cloud(x: number, y: number, s: number, color: string, slow = false): string {
  return `<g class="drift${slow ? ' slow' : ''}"><path d="${CLOUD}" transform="translate(${x} ${y}) scale(${s})" fill="#14052c" fill-opacity=".93" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" filter="url(#sc-glow)"/></g>`;
}

function rain(r: () => number): string {
  return Array.from({ length: 38 }, () => {
    const x = r() * (W + 20) - 10;
    const y = 150 + r() * 110;
    return `<line class="drop" x1="${f(x)}" y1="${f(y)}" x2="${f(x - 4)}" y2="${f(y + 16)}" style="animation-duration:${f(0.6 + r() * 0.4, 2)}s;animation-delay:-${f(r(), 2)}s"/>`;
  }).join('');
}

function snow(r: () => number): string {
  return Array.from(
    { length: 46 },
    () =>
      `<circle class="flake" cx="${f(r() * W)}" cy="${f(140 + r() * 120)}" r="${f(1.2 + r() * 2, 1)}" style="animation-duration:${f(3 + r() * 3, 1)}s;animation-delay:-${f(r() * 5, 1)}s"/>`,
  ).join('');
}

function stars(r: () => number): string {
  return Array.from(
    { length: 26 },
    () => `<circle class="twinkle" cx="${f(r() * W)}" cy="${f(r() * 230)}" r="${f(0.6 + r() * 1.2, 1)}" fill="#fff" style="animation-delay:-${f(r() * 3, 1)}s"/>`,
  ).join('');
}

function bolt(points: string, late = false): string {
  return `<polyline class="zap${late ? ' late' : ''}" points="${points}" fill="none" stroke="#fff6a8" stroke-width="3.5" filter="url(#sc-bolt)"/>`;
}

function fog(): string {
  return [176, 204, 230, 254, 276]
    .map((y, i) => `<rect class="fogband" x="-60" y="${y}" width="${W + 120}" height="${12 + (i % 2) * 6}" rx="9" fill="url(#sc-fog)" style="animation-delay:-${f(i * 2.3, 1)}s"/>`)
    .join('');
}

function defs(): string {
  // Sun stripes get thicker gaps towards the horizon.
  let stripes = '';
  for (let i = 0, y = CY + 4; y < HORIZON; i++) {
    const bar = Math.max(4, 13 - i * 1.6);
    stripes += `<rect y="${f(y, 1)}" width="${W}" height="${f(bar, 1)}" fill="#fff"/>`;
    y += bar + 2 + i * 1.5;
  }
  return `<defs>
    <linearGradient id="sc-sun" x1="0" y1="0" x2="0" y2="1"><stop offset=".05" stop-color="#ffe45e"/><stop offset=".45" stop-color="#ff9a3d"/><stop offset=".85" stop-color="#ff2e88"/></linearGradient>
    <linearGradient id="sc-moon" x1="0" y1="0" x2="0" y2="1"><stop offset=".05" stop-color="#e3fcff"/><stop offset=".5" stop-color="#9b8cff"/><stop offset=".9" stop-color="#ff5fd2"/></linearGradient>
    <linearGradient id="sc-fog" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff9de6" stop-opacity="0"/><stop offset=".5" stop-color="#ffc4f1" stop-opacity=".55"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></linearGradient>
    <clipPath id="sc-hz"><rect width="${W}" height="${HORIZON}"/></clipPath>
    <mask id="sc-stripes" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${CY + 4}" fill="#fff"/>${stripes}</mask>
    <mask id="sc-crescent" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><circle cx="${CX + 62}" cy="${CY - 40}" r="${R - 8}" fill="#000"/></mask>
    <filter id="sc-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="sc-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="sc-bolt" x="-100%" y="-30%" width="300%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feFlood flood-color="#f9c80e"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
}

/**
 * Background layers for the "now" block. `night` comes from the sun's position, since
 * Bright Sky only marks clear and partly cloudy icons as night.
 */
export function heroScene(icon: string | null | undefined, night: boolean): string {
  const scene = SCENE_OF[icon ?? ''] ?? 'cloudy';
  const isNight = night || !!icon?.endsWith('-night');
  const r = rng(scene.length * 97 + 13);
  const body = isNight ? moon : sun;
  // Behind clouds the disc only shimmers through; at night it disappears.
  const dim = (o: number) => (isNight ? '' : sun(o));
  const pictures: Record<Scene, () => string> = {
    clear: () => (isNight ? stars(r) : '') + body(),
    partly: () => (isNight ? stars(r) : '') + body() + cloud(4, 72, 5.5, isNight ? VIOLET : CYAN, true) + cloud(150, 118, 9.5, isNight ? CYAN : PINK),
    cloudy: () => dim(0.18) + cloud(-30, 70, 9, CYAN, true) + cloud(150, 60, 8, PINK) + cloud(40, 130, 10, PINK, true),
    rain: () =>
      dim(0.12) +
      `<g stroke="${CYAN}" stroke-width="2" stroke-linecap="round" filter="url(#sc-glow)">${rain(r)}</g>` +
      cloud(-20, 60, 9, CYAN, true) +
      cloud(140, 50, 9.5, PINK),
    thunder: () =>
      `<rect class="flash" width="${W}" height="${H}" fill="#d9b3ff"/>` +
      `<g stroke="${CYAN}" stroke-width="1.6" stroke-linecap="round" opacity=".7">${rain(r)}</g>` +
      cloud(-20, 50, 9.5, VIOLET, true) +
      cloud(140, 40, 10, PINK) +
      bolt('276,212 256,250 274,249 250,292') +
      bolt('92,214 80,242 94,241 78,276', true),
    snow: () => dim(0.12) + `<g fill="#fff" filter="url(#sc-glow)">${snow(r)}</g>` + cloud(-20, 60, 9, CYAN, true) + cloud(140, 50, 9.5, '#c7f9ff'),
    fog: () => body(isNight ? 0.4 : 0.55) + fog(),
  };
  const sky = scene === 'clear' || scene === 'partly' ? (isNight ? 'night' : 'day') : 'dark';
  return `<div class="hero-bg sky-${sky}" aria-hidden="true">
    <svg class="scene" viewBox="0 0 ${W} ${H}">${defs()}${pictures[scene]()}</svg>
    <div class="floorwrap"><div class="floor"></div></div>
  </div>`;
}
