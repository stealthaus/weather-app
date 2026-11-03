import './style.css';
import { places, type Place } from './lib/places';
import { openPlaceSheet } from './sheet';
import { mountHome } from './views/home';
import { mountRadar } from './views/radar';
import { mountTrend } from './views/trend';

type Route = 'home' | 'radar' | 'trend';
const VIEWS: Record<Route, (el: HTMLElement, p: Place) => () => void> = {
  home: mountHome,
  radar: mountRadar,
  trend: mountTrend,
};
const STALE_MS = 10 * 60 * 1000;

const view = document.getElementById('view')!;
const placeName = document.getElementById('place-name')!;
const meta = document.getElementById('topbar-meta')!;
let cleanup: (() => void) | null = null;
let mountedAt = 0;

function route(): Route {
  const r = location.hash.replace(/^#\/?/, '');
  return r === 'radar' || r === 'trend' ? r : 'home';
}

function render() {
  cleanup?.();
  cleanup = null;
  const r = route();
  document.querySelectorAll<HTMLAnchorElement>('.tabbar a').forEach((a) => {
    const active = a.dataset.route === r;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  view.classList.toggle('full', r === 'radar');
  const p = places.current;
  placeName.textContent = p?.name ?? 'Ort wählen';
  meta.textContent = new Date().toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  if (!p) {
    view.innerHTML = `<div class="empty"><h2>Wo soll's hingehen?</h2><p>Wähle einen Ort oder nutze deinen aktuellen Standort.</p><button class="btn" type="button">Ort wählen</button></div>`;
    view.querySelector('button')!.addEventListener('click', () => openPlaceSheet());
    return;
  }
  window.scrollTo(0, 0);
  cleanup = VIEWS[r](view, p);
  mountedAt = Date.now();
}

document.getElementById('place-btn')!.addEventListener('click', () => openPlaceSheet());
window.addEventListener('hashchange', render);
places.onChange(render);

// Reload data when the app comes back to the foreground after a while.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - mountedAt > STALE_MS) render();
});

render();
if (!places.current) openPlaceSheet({ dismissable: false });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* offline support is optional */
  });
}
