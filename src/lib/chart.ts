import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { cssVar } from './format';

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, CategoryScale, LinearScale, Filler, Tooltip);

/** Colours resolved from CSS variables so charts follow light/dark mode. */
export function palette() {
  return {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    rule: cssVar('--rule'),
    warm: cssVar('--warm'),
    warmBand: cssVar('--warm-band'),
    cold: cssVar('--cold'),
    coldBand: cssVar('--cold-band'),
    rain: cssVar('--rain'),
    rainSoft: cssVar('--rain-soft'),
    sun: cssVar('--sun'),
    sunSoft: cssVar('--sun-soft'),
    uncertain: cssVar('--uncertain'),
    surface: cssVar('--surface'),
    font: cssVar('--font'),
  };
}

export function baseFont() {
  Chart.defaults.font.family = cssVar('--font');
  Chart.defaults.font.size = 11;
  Chart.defaults.color = cssVar('--text-2');
}

export { Chart };
