import { reverseName, searchPlaces } from './api/geocoding';
import { escapeHtml } from './lib/format';
import { places, type Place } from './lib/places';

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" stroke-linejoin="round"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';

export function locateMe(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Standortbestimmung wird nicht unterstützt.'));
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(4));
        const lon = Number(pos.coords.longitude.toFixed(4));
        const name = (await reverseName(lat, lon)) ?? 'Aktueller Standort';
        resolve({ id: 'geo:current', name, detail: 'Aktueller Standort', lat, lon, geo: true });
      },
      (err) =>
        reject(new Error(err.code === err.PERMISSION_DENIED ? 'Standortzugriff wurde nicht erlaubt. Du kannst ihn in den iOS-Einstellungen unter Datenschutz → Ortungsdienste → Safari-Websites freigeben.' : 'Standort konnte nicht bestimmt werden.')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

export function openPlaceSheet(opts: { dismissable?: boolean } = {}) {
  const dismissable = opts.dismissable ?? true;
  const root = document.getElementById('sheet-root')!;
  root.innerHTML = `
    <div class="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Ort wählen">
        <div class="sheet-grip"></div>
        <div class="sheet-head">
          <input type="search" placeholder="Stadt oder PLZ suchen" autocomplete="off" enterkeyhint="search" aria-label="Ort suchen" />
          ${dismissable ? '<button type="button" data-close>Fertig</button>' : ''}
        </div>
        <div class="sheet-body">
          <button type="button" class="geo-btn">${PIN}<span>Aktueller Standort</span></button>
          <div class="geo-msg small muted"></div>
          <div class="results"></div>
        </div>
      </div>
    </div>`;
  const backdrop = root.querySelector<HTMLElement>('.sheet-backdrop')!;
  const input = root.querySelector<HTMLInputElement>('input')!;
  const results = root.querySelector<HTMLElement>('.results')!;
  const geoBtn = root.querySelector<HTMLButtonElement>('.geo-btn')!;
  const geoMsg = root.querySelector<HTMLElement>('.geo-msg')!;

  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismissable && close();
  document.addEventListener('keydown', onKey);
  if (dismissable) {
    backdrop.addEventListener('click', (e) => e.target === backdrop && close());
    root.querySelector('[data-close]')!.addEventListener('click', close);
  }

  const choose = (p: Place) => {
    places.set(p);
    close();
  };

  const item = (p: Place, kind: 'result' | 'fav' | 'recent') => `
    <li class="loc-item" data-id="${escapeHtml(p.id)}">
      <button type="button" data-pick><span class="n">${escapeHtml(p.name)}</span>${p.detail ? `<span class="s">${escapeHtml(p.detail)}</span>` : ''}</button>
      ${kind === 'recent' ? `<button type="button" class="icon-btn" data-remove aria-label="Aus Verlauf entfernen">${CROSS}</button>` : ''}
      <button type="button" class="icon-btn ${places.isFavorite(p.id) ? 'on' : ''}" data-fav aria-label="Favorit" aria-pressed="${places.isFavorite(p.id)}">${STAR}</button>
    </li>`;

  let shown: Place[] = [];
  const renderList = (groups: [string, Place[], 'result' | 'fav' | 'recent'][]) => {
    shown = groups.flatMap((g) => g[1]);
    results.innerHTML = groups
      .filter(([, list]) => list.length)
      .map(([title, list, kind]) => `<p class="label">${title}</p><ul class="loc-list">${list.map((p) => item(p, kind)).join('')}</ul>`)
      .join('');
  };
  const renderSaved = () => {
    renderList([
      ['Favoriten', places.favorites, 'fav'],
      ['Zuletzt verwendet', places.recent, 'recent'],
    ]);
    if (!places.favorites.length && !places.recent.length) {
      results.innerHTML = '<p class="small muted" style="margin-top:14px">Suche nach einem Ort oder nutze deinen aktuellen Standort. Mit dem Stern speicherst du Favoriten.</p>';
    }
  };

  results.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>('.loc-item');
    if (!li) return;
    const p = shown.find((s) => s.id === li.dataset.id);
    if (!p) return;
    if (target.closest('[data-pick]')) choose(p);
    else if (target.closest('[data-fav]')) {
      places.toggleFavorite(p);
      input.value.trim() ? runSearch() : renderSaved();
    } else if (target.closest('[data-remove]')) {
      places.removeRecent(p.id);
      renderSaved();
    }
  });

  let ctrl: AbortController | null = null;
  let timer = 0;
  const runSearch = async () => {
    const q = input.value.trim();
    ctrl?.abort();
    if (q.length < 2) return renderSaved();
    ctrl = new AbortController();
    try {
      const list = await searchPlaces(q, ctrl.signal);
      if (!list.length) results.innerHTML = '<p class="small muted" style="margin-top:14px">Kein Ort gefunden.</p>';
      else renderList([['Suchergebnisse', list, 'result']]);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      results.innerHTML = `<p class="small" style="margin-top:14px;color:var(--danger)">Ortssuche nicht erreichbar. Prüfe deine Verbindung.</p>`;
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(runSearch, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      runSearch();
    }
  });

  geoBtn.addEventListener('click', async () => {
    geoMsg.textContent = 'Standort wird bestimmt …';
    try {
      choose(await locateMe());
    } catch (e) {
      geoMsg.textContent = (e as Error).message;
    }
  });

  renderSaved();
  if (dismissable) setTimeout(() => input.focus(), 50);
}
