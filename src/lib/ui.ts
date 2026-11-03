import { escapeHtml } from './format';

export function skeleton(h: number, w = '100%', mt = 10): string {
  return `<div class="skeleton" style="height:${h}px;width:${w};margin-top:${mt}px"></div>`;
}

/** Renders an error box with a retry button into `el`. */
export function showError(el: HTMLElement, what: string, err: unknown, retry: () => void) {
  const msg = err instanceof Error ? err.message : String(err);
  el.innerHTML = `<div class="error" role="alert"><strong>${escapeHtml(what)} konnte nicht geladen werden.</strong><br>${escapeHtml(msg)}<br><button type="button">Erneut versuchen</button></div>`;
  el.querySelector('button')!.addEventListener('click', retry);
}

export function attribution(parts: ('dwd' | 'brightsky' | 'openmeteo')[]): string {
  const map = {
    dwd: 'Daten: <a href="https://www.dwd.de" target="_blank" rel="noopener">Deutscher Wetterdienst</a> (CC BY 4.0)',
    brightsky: 'über <a href="https://brightsky.dev" target="_blank" rel="noopener">Bright Sky</a>',
    openmeteo: 'Ensemble: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), Modelle ECMWF IFS ENS und DWD ICON-EPS',
  };
  return `<footer class="attribution">${parts.map((p) => map[p]).join(' · ')}</footer>`;
}
