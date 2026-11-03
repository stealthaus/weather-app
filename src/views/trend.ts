import type { Plugin } from 'chart.js';
import { computeTrend, loadEnsemble, type ModelChoice, type RainThreshold, type RawEnsemble, type TrendDay } from '../api/ensemble';
import { baseFont, Chart, palette } from '../lib/chart';
import { deg, escapeHtml, num, shortDate, weekday } from '../lib/format';
import type { Place } from '../lib/places';
import { attribution, showError, skeleton } from '../lib/ui';

/** From this day index on (day 10) only ranges are shown, no single values. */
const TENDENCY_FROM = 9;

const PREF_MODEL = 'wx.trend.model';
const PREF_THRESHOLD = 'wx.trend.threshold';

function pref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function setPref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/** Shades the "tendency" zone, optionally with a label. */
const tendencyZone = (label: boolean): Plugin<'line' | 'bar'> => ({
  id: 'tendencyZone',
  beforeDatasetsDraw(chart) {
    const x = chart.scales.x;
    const n = chart.data.labels?.length ?? 0;
    if (n <= TENDENCY_FROM) return;
    const { top, bottom, right } = chart.chartArea;
    const step = (x.getPixelForValue(1) - x.getPixelForValue(0)) || 0;
    const left = x.getPixelForValue(TENDENCY_FROM) - step / 2;
    const c = palette();
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = c.uncertain;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = c.text3;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.stroke();
    if (label) {
      ctx.fillStyle = c.text2;
      ctx.font = `600 10px ${c.font}`;
      ctx.textBaseline = 'top';
      ctx.fillText('TENDENZ', left + 4, top + 3);
    }
    ctx.restore();
  },
});

/** Draws P10–P90 whiskers on top of the precipitation median bars. */
function whiskers(days: TrendDay[]): Plugin<'bar'> {
  return {
    id: 'whiskers',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const y = chart.scales.y;
      const c = palette();
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = c.text2;
      ctx.lineWidth = 1.2;
      meta.data.forEach((bar, i) => {
        const d = days[i];
        if (!d || d.precip.p90 < 0.1) return;
        const x = bar.x;
        const y1 = y.getPixelForValue(d.precip.p10);
        const y2 = y.getPixelForValue(d.precip.p90);
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.moveTo(x - 3, y2);
        ctx.lineTo(x + 3, y2);
        ctx.moveTo(x - 3, y1);
        ctx.lineTo(x + 3, y1);
        ctx.stroke();
      });
      ctx.restore();
    },
  };
}

function labels(days: TrendDay[]) {
  return days.map((d) => [weekday(d.date), `${Number(d.date.slice(8))}.`]);
}

// Fixed axis widths keep the day columns of both charts aligned.
const AXIS_W = 46;
const fixWidth = (scale: { width: number }) => {
  scale.width = AXIS_W;
};

function tempChart(canvas: HTMLCanvasElement, days: TrendDay[]) {
  const c = palette();
  const dashed = (ctx: { p0DataIndex: number }) => (ctx.p0DataIndex >= TENDENCY_FROM - 1 ? [4, 4] : undefined);
  const line = (data: number[], color: string) => ({
    type: 'line' as const,
    data,
    borderColor: color,
    borderWidth: 2.2,
    pointRadius: 2.5,
    pointBackgroundColor: color,
    tension: 0.3,
    fill: false,
    segment: { borderDash: dashed },
  });
  const edge = (data: number[], fill: string | false, bg: string) => ({
    type: 'line' as const,
    data,
    borderWidth: 0,
    pointRadius: 0,
    tension: 0.3,
    fill,
    backgroundColor: bg,
  });
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels(days),
      datasets: [
        edge(days.map((d) => d.tmax.p10), false, c.warmBand),
        edge(days.map((d) => d.tmax.p90), '-1', c.warmBand),
        line(days.map((d) => d.tmax.p50), c.warm),
        edge(days.map((d) => d.tmin.p10), false, c.coldBand),
        edge(days.map((d) => d.tmin.p90), '-1', c.coldBand),
        line(days.map((d) => d.tmin.p50), c.cold),
      ],
    },
    plugins: [tendencyZone(true) as Plugin<'line'>],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          filter: (item) => item.datasetIndex === 2,
          callbacks: {
            title: (items) => {
              const d = days[items[0].dataIndex];
              return `${weekday(d.date)} ${shortDate(d.date)}`;
            },
            label: (item) => {
              const d = days[item.dataIndex];
              const exact = item.dataIndex < TENDENCY_FROM;
              return [
                ` Max ${exact ? deg(d.tmax.p50) + ' ' : ''}(${deg(d.tmax.p10)} bis ${deg(d.tmax.p90)})`,
                ` Min ${exact ? deg(d.tmin.p50) + ' ' : ''}(${deg(d.tmin.p10)} bis ${deg(d.tmin.p90)})`,
              ];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: c.text }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 } } },
        y: { grid: { color: c.rule }, border: { display: false }, ticks: { maxTicksLimit: 6, callback: (v) => `${v}°` }, grace: '5%', afterFit: fixWidth },
      },
      layout: { padding: { right: AXIS_W } },
    },
  });
}

function rainChart(canvas: HTMLCanvasElement, days: TrendDay[], threshold: RainThreshold) {
  const c = palette();
  const maxMm = Math.max(4, ...days.map((d) => d.precip.p90));
  return new Chart(canvas, {
    data: {
      labels: labels(days),
      datasets: [
        {
          type: 'bar',
          data: days.map((d) => d.precip.p50),
          backgroundColor: days.map((_, i) => (i >= TENDENCY_FROM ? c.rainSoft : c.rain)),
          barPercentage: 0.55,
          yAxisID: 'y',
        },
        {
          type: 'line',
          data: days.map((d) => Math.round(d.rainProb * 100)),
          borderColor: c.text2,
          borderWidth: 1.5,
          pointRadius: 2.5,
          pointBackgroundColor: c.text2,
          stepped: false,
          tension: 0.25,
          yAxisID: 'p',
        },
      ],
    },
    plugins: [tendencyZone(false) as Plugin<'bar'>, whiskers(days)],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (items) => {
              const d = days[items[0].dataIndex];
              return `${weekday(d.date)} ${shortDate(d.date)}`;
            },
            label: (item) => {
              const d = days[item.dataIndex];
              return [
                ` Regen ≥ ${num(threshold, threshold < 1 ? 1 : 0)} mm: ${Math.round(d.rainProb * 100)} % der Läufe`,
                ` Menge: ${num(d.precip.p50, 1)} mm (${num(d.precip.p10, 1)} bis ${num(d.precip.p90, 1)})`,
              ];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: c.text }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 } } },
        y: { min: 0, suggestedMax: maxMm, grid: { color: c.rule }, border: { display: false }, ticks: { maxTicksLimit: 4, callback: (v) => `${v} mm` }, afterFit: fixWidth },
        p: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { stepSize: 50, callback: (v) => `${v} %` }, afterFit: fixWidth },
      },
    },
  });
}

function confidence(d: TrendDay) {
  const spread = Math.max(d.tmax.p90 - d.tmax.p10, d.tmin.p90 - d.tmin.p10);
  const level = spread <= 3 ? 3 : spread <= 6 ? 2 : 1;
  const text = ['', 'gering', 'mittel', 'hoch'][level];
  return `<span class="conf" title="Sicherheit ${text}" aria-label="Sicherheit ${text}">${[1, 2, 3].map((i) => `<b class="${i <= level ? 'on' : ''}"></b>`).join('')}</span>`;
}

function table(days: TrendDay[]) {
  const today = days[0]?.date;
  const rows = days
    .map((d, i) => {
      const exact = i < TENDENCY_FROM;
      const t = (b: TrendDay['tmax'], cls: string) =>
        exact
          ? `<span class="${cls}">${deg(b.p50)}</span><br><span class="small muted">${deg(b.p10)}…${deg(b.p90)}</span>`
          : `<span class="${cls}">${deg(b.p10)}…${deg(b.p90)}</span>`;
      return `<tr class="${exact ? '' : 'unsure'}">
        <td><strong>${weekday(d.date, today)}</strong> <span class="small muted">${shortDate(d.date)}</span></td>
        <td class="num">${t(d.tmax, 'warm')}</td>
        <td class="num">${t(d.tmin, 'cold')}</td>
        <td class="num">${Math.round(d.rainProb * 100)} %</td>
        <td class="num">${confidence(d)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="trend-table">
    <thead><tr><th>Tag</th><th class="num">Max</th><th class="num">Min</th><th class="num">Regen</th><th class="num">Sicherh.</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function mountTrend(el: HTMLElement, place: Place): () => void {
  let charts: Chart[] = [];
  let alive = true;
  let raw: RawEnsemble | null = null;
  let model = pref<ModelChoice>(PREF_MODEL, 'ecmwf');
  let threshold = Number(pref(PREF_THRESHOLD, '0.1')) as RainThreshold;

  el.innerHTML = `
    <div class="trend-intro">
      <h1>14-Tage-Trend</h1>
      <p>Alle Läufe des Ensembles für ${escapeHtml(place.name)}. Die Linie ist der Median, das Band zeigt, wo 80 % der Läufe liegen. Je breiter das Band, desto unsicherer die Vorhersage.</p>
    </div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Modell">
        <button type="button" data-model="ecmwf">ECMWF</button>
        <button type="button" data-model="ecmwf+icon">+ ICON-EPS</button>
      </div>
      <div class="seg" role="group" aria-label="Regenschwelle">
        <button type="button" data-th="0.1">≥ 0,1 mm</button>
        <button type="button" data-th="1">≥ 1 mm</button>
      </div>
    </div>
    <div id="trend-body"></div>`;
  const body = el.querySelector<HTMLElement>('#trend-body')!;

  const syncButtons = () => {
    el.querySelectorAll<HTMLButtonElement>('[data-model]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === model)));
    el.querySelectorAll<HTMLButtonElement>('[data-th]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.th) === threshold)));
  };

  const render = () => {
    charts.forEach((c) => c.destroy());
    charts = [];
    if (!raw) return;
    const days = computeTrend(raw, threshold);
    if (!days.length) {
      body.innerHTML = '<div class="error">Für diesen Ort liefert das Ensemble keine Daten.</div>';
      return;
    }
    const members = days[0].members;
    body.innerHTML = `
      <section class="block">
        <div class="block-head"><p class="label">Temperatur · Höchst- und Tiefstwert</p></div>
        <div class="chart-box" style="height:250px"><canvas role="img" aria-label="Tageshöchst- und Tiefsttemperatur mit Unsicherheitsband"></canvas></div>
        <div class="legend">
          <span><i style="background:var(--warm)"></i>Max (Median)</span>
          <span><i style="background:var(--warm-band)"></i>Max 10–90 %</span>
          <span><i style="background:var(--cold)"></i>Min (Median)</span>
          <span><i style="background:var(--cold-band)"></i>Min 10–90 %</span>
        </div>
      </section>
      <section class="block">
        <div class="block-head"><p class="label">Niederschlag</p></div>
        <div class="chart-box" style="height:160px"><canvas role="img" aria-label="Regenwahrscheinlichkeit und Niederschlagsmenge"></canvas></div>
        <div class="legend">
          <span><i style="background:var(--rain)"></i>Menge (Median), Strich = 10–90 %</span>
          <span><i style="background:var(--text-2);height:2px"></i>Regenwahrscheinlichkeit</span>
        </div>
      </section>
      <section class="block">
        <div class="block-head"><p class="label">Tageswerte</p><span class="small muted">Median, darunter Spanne</span></div>
        ${table(days)}
        <p class="note">Ab Tag ${TENDENCY_FROM + 1} zeigt die App nur noch Spannen: Einzelwerte wären dort scheinbar genauer, als die Modelle rechnen können. „Regen“ ist der Anteil der ${members} Läufe mit mindestens ${num(threshold, threshold < 1 ? 1 : 0)} mm am Tag.${raw.icon ? ' ICON-EPS reicht nur etwa 7 Tage, danach rechnet nur ECMWF.' : ''}</p>
      </section>
      ${attribution(['openmeteo'])}`;
    const [tc, rc] = body.querySelectorAll('canvas');
    baseFont();
    charts.push(tempChart(tc, days), rainChart(rc, days, threshold));
  };

  const load = async () => {
    body.innerHTML = `${skeleton(250, '100%', 18)}${skeleton(160, '100%', 24)}${skeleton(300, '100%', 24)}`;
    try {
      const r = await loadEnsemble(place.lat, place.lon, model === 'ecmwf+icon');
      if (!alive) return;
      raw = r;
      render();
    } catch (e) {
      if (alive) showError(body, 'Der Ensemble-Trend', e, load);
    }
  };

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.model && b.dataset.model !== model) {
      model = b.dataset.model as ModelChoice;
      setPref(PREF_MODEL, model);
      syncButtons();
      load();
    } else if (b.dataset.th && Number(b.dataset.th) !== threshold) {
      threshold = Number(b.dataset.th) as RainThreshold;
      setPref(PREF_THRESHOLD, String(threshold));
      syncButtons();
      render();
    }
  });

  syncButtons();
  load();
  return () => {
    alive = false;
    charts.forEach((c) => c.destroy());
  };
}
