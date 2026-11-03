import { currentWeather, forecast, type CurrentWeather, type HourlyWeather, type Source } from '../api/brightsky';
import { baseFont, Chart, palette } from '../lib/chart';
import { deg, escapeHtml, localDate, localHour, num, shortDate, titleCase, weekday, windDir } from '../lib/format';
import { ICON_RANK, wxIcon, wxLabel } from '../lib/icons';
import type { Place } from '../lib/places';
import { daylightHours } from '../lib/sun';
import { attribution, showError, skeleton } from '../lib/ui';

interface DaySummary {
  date: string;
  min: number;
  max: number;
  icon: string | null;
  precip: number;
  prob: number | null;
  /** Hours of sunshine, length of the day and their ratio (0..1); null if the day is incomplete. */
  sunHours: number | null;
  dayHours: number;
  sunShare: number | null;
}

function summarizeDays(hours: HourlyWeather[], lat: number): DaySummary[] {
  const byDate = new Map<string, HourlyWeather[]>();
  for (const h of hours) {
    const d = localDate(h.timestamp);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(h);
  }
  const days: DaySummary[] = [];
  byDate.forEach((list, date) => {
    const temps = list.map((h) => h.temperature).filter((t): t is number => t != null);
    if (temps.length < 6) return;
    const daytime = list.filter((h) => localHour(h.timestamp) >= 8 && localHour(h.timestamp) <= 20);
    const pool = daytime.length >= 3 ? daytime : list;
    const counts = new Map<string, number>();
    pool.forEach((h) => h.icon && counts.set(h.icon, (counts.get(h.icon) ?? 0) + 1));
    // Most severe icon that lasts at least 3 hours, else the most frequent one.
    const ranked = [...counts.entries()].sort((a, b) => (ICON_RANK[b[0]] ?? 0) - (ICON_RANK[a[0]] ?? 0));
    const severe = ranked.find(([, c]) => c >= 3);
    const frequent = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const probs = list.map((h) => h.precipitation_probability).filter((p): p is number => p != null);
    const sun = list.map((h) => h.sunshine).filter((m): m is number => m != null);
    const sunHours = sun.length >= 20 ? sun.reduce((a, b) => a + b, 0) / 60 : null;
    const dayHours = daylightHours(lat, date);
    days.push({
      date,
      min: Math.min(...temps),
      max: Math.max(...temps),
      icon: (severe ?? frequent)?.[0]?.replace('-night', '-day') ?? null,
      precip: list.reduce((s, h) => s + (h.precipitation ?? 0), 0),
      prob: probs.length ? Math.max(...probs) : null,
      sunHours,
      dayHours,
      sunShare: sunHours != null && dayHours > 0 ? Math.min(1, sunHours / dayHours) : null,
    });
  });
  return days;
}

function nowBlock(cur: CurrentWeather | null, first: HourlyWeather, today: DaySummary | undefined, station: Source | undefined, place: Place) {
  const temp = cur?.temperature ?? first.temperature;
  const icon = cur?.icon ?? first.icon;
  const precip = cur?.precipitation_60 ?? first.precipitation;
  const facts: [string, string][] = [];
  const wind = cur?.wind_speed_10 ?? first.wind_speed;
  const gust = cur?.wind_gust_speed_10 ?? first.wind_gust_speed;
  if (wind != null) facts.push(['Wind', `${num(wind)} km/h ${windDir(cur?.wind_direction_10)}`]);
  if (gust != null) facts.push(['Böen', `${num(gust)} km/h`]);
  if (today?.sunShare != null) {
    facts.push(['Sonne heute', `${num(today.sunHours, 1)} von ${num(today.dayHours, 1)} h · ${Math.round(today.sunShare * 100)} %`]);
  }
  if (cur?.relative_humidity != null) facts.push(['Feuchte', `${num(cur.relative_humidity)} %`]);
  if (cur?.pressure_msl != null) facts.push(['Luftdruck', `${num(cur.pressure_msl)} hPa`]);
  if (precip != null) facts.push(['Niederschlag 1 h', `${num(precip, 1)} mm`]);
  const cloud = cur?.cloud_cover ?? first.cloud_cover;
  if (cloud != null) facts.push(['Bewölkung', `${num(cloud)} %`]);
  if (cur?.dew_point != null) facts.push(['Taupunkt', deg(cur.dew_point, 1)]);
  if (cur?.visibility != null) facts.push(['Sicht', `${num(cur.visibility / 1000)} km`]);

  const [whole, frac] = (temp != null ? temp.toFixed(1) : '–').split('.');
  return `
    <section class="now">
      <div class="now-row">
        <div>
          <div class="now-temp">${whole === '-0' ? '0' : whole}${frac ? `<sup>,${frac}°</sup>` : ''}</div>
          <div class="now-cond">${wxLabel(icon, precip)}</div>
          ${today ? `<div class="now-hl">H ${deg(Math.max(today.max, temp ?? -99))} · T ${deg(Math.min(today.min, temp ?? 99))}${today.prob != null ? ` · Regen bis ${today.prob} %` : ''}</div>` : ''}
        </div>
        ${wxIcon(icon, 'now-icon')}
      </div>
      <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <p class="source-note">${
        cur && station
          ? `Messung ${escapeHtml(titleCase(station.station_name))} (${num(station.distance / 1000)} km entfernt), ${cur.timestamp.slice(11, 16)} Uhr`
          : `Kein Messwert in der Nähe von ${escapeHtml(place.name)} – Werte aus der Vorhersage.`
      }</p>
    </section>`;
}

function hourStrip(hours: HourlyWeather[]) {
  return hours
    .map((h, i) => {
      const hr = localHour(h.timestamp);
      const label = i === 0 ? 'Jetzt' : hr === 0 ? weekday(localDate(h.timestamp)) : `${String(hr).padStart(2, '0')}`;
      const p = h.precipitation_probability;
      return `<div class="hour ${hr === 0 && i > 0 ? 'day-start' : ''}">
        <span class="h">${label}</span>${wxIcon(h.icon)}<span class="t">${deg(h.temperature)}</span>
        <span class="p">${p != null && p >= 10 ? `${p} %` : ''}</span></div>`;
    })
    .join('');
}

function dayList(days: DaySummary[], today: string) {
  const lo = Math.min(...days.map((d) => d.min));
  const hi = Math.max(...days.map((d) => d.max));
  const span = Math.max(1, hi - lo);
  return `<ul class="days">${days
    .map(
      (d) => `<li class="day">
        <span class="dname">${weekday(d.date, today)}<small>${shortDate(d.date)}</small></span>
        ${wxIcon(d.icon)}
        <span class="ds" title="${d.sunHours != null ? `${num(d.sunHours, 1)} von ${num(d.dayHours, 1)} Stunden Sonne` : ''}">${d.sunShare != null ? `${Math.round(d.sunShare * 100)} %` : ''}</span>
        <span class="dp">${d.prob != null && d.prob >= 20 ? `${d.prob} %` : ''}</span>
        <span class="range"><span class="lo">${deg(d.min)}</span>
          <span class="range-bar"><span style="left:${((d.min - lo) / span) * 100}%;right:${((hi - d.max) / span) * 100}%"></span></span>
          <span class="hi">${deg(d.max)}</span></span>
      </li>`,
    )
    .join('')}</ul>`;
}

function hourlyChart(canvas: HTMLCanvasElement, hours: HourlyWeather[]) {
  baseFont();
  const c = palette();
  const labels = hours.map((h, i) => (i === 0 ? 'Jetzt' : `${localHour(h.timestamp)}`));
  const maxPrecip = Math.max(2, ...hours.map((h) => h.precipitation ?? 0));
  return new Chart(canvas, {
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: 'Temperatur',
          data: hours.map((h) => h.temperature),
          borderColor: c.warm,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          yAxisID: 'y',
        },
        {
          type: 'bar',
          label: 'Niederschlag',
          data: hours.map((h) => h.precipitation ?? 0),
          backgroundColor: c.rain,
          barPercentage: 1,
          categoryPercentage: 0.8,
          yAxisID: 'p',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => (ctx.datasetIndex === 0 ? ` ${deg(ctx.parsed.y, 1)}` : ` ${num(ctx.parsed.y, 1)} mm`),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: c.text },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 },
        },
        y: {
          position: 'left',
          grid: { color: c.rule },
          border: { display: false },
          ticks: { maxTicksLimit: 5, callback: (v) => `${v}°` },
          grace: '10%',
        },
        p: {
          position: 'right',
          min: 0,
          max: maxPrecip * 2.2,
          grid: { display: false },
          border: { display: false },
          ticks: { display: false },
        },
      },
    },
  });
}

export function mountHome(el: HTMLElement, place: Place): () => void {
  const charts: Chart[] = [];
  let alive = true;
  const tz = place.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const load = async () => {
    el.innerHTML = `${skeleton(64, '45%', 22)}${skeleton(18, '35%')}${skeleton(80)}${skeleton(150, '100%', 28)}${skeleton(70)}${skeleton(260, '100%', 28)}`;
    try {
      const [fc, cur] = await Promise.all([
        forecast(place.lat, place.lon, tz),
        currentWeather(place.lat, place.lon, tz).catch(() => null),
      ]);
      if (!alive) return;
      const nowMs = Date.now() - 30 * 60 * 1000;
      const upcoming = fc.weather.filter((h) => new Date(h.timestamp).getTime() >= nowMs);
      if (!upcoming.length) throw new Error('Für diesen Ort liegt keine Vorhersage vor.');
      const next48 = upcoming.slice(0, 48);
      const todayYmd = localDate(upcoming[0].timestamp);
      const days = summarizeDays(fc.weather, place.lat).slice(0, 10);
      const station = cur?.sources.find((s) => s.id === cur.weather.source_id);
      const fcStation = fc.sources.find((s) => s.observation_type === 'forecast');

      el.innerHTML = `
        ${nowBlock(cur?.weather ?? null, upcoming[0], days.find((d) => d.date === todayYmd), station, place)}
        <section class="block">
          <div class="block-head"><p class="label">Nächste 48 Stunden</p><span class="small muted">Temperatur · Niederschlag</span></div>
          <div class="chart-box" style="height:150px"><canvas aria-label="Temperatur und Niederschlag der nächsten 48 Stunden" role="img"></canvas></div>
          <div class="hours">${hourStrip(next48)}</div>
        </section>
        <section class="block">
          <div class="block-head"><p class="label">Nächste Tage · DWD MOSMIX</p><a href="#/trend">14-Tage-Trend →</a></div>
          <div class="day-legend"><span class="sun-key">Sonne</span> Anteil der Tageslänge · <span class="rain-key">Regen</span> höchste Stundenwahrscheinlichkeit</div>
          ${dayList(days, todayYmd)}
        </section>
        ${attribution(['dwd', 'brightsky'])}
        <p class="small muted" style="font-size:11px;margin-top:4px">Vorhersagepunkt: ${fcStation ? escapeHtml(titleCase(fcStation.station_name)) + ` (${num(fcStation.distance / 1000)} km)` : '–'}</p>`;
      charts.push(hourlyChart(el.querySelector('canvas')!, next48));
    } catch (e) {
      if (alive) showError(el, 'Die Vorhersage', e, load);
    }
  };
  load();
  return () => {
    alive = false;
    charts.forEach((c) => c.destroy());
  };
}
