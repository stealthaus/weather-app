export interface Place {
  id: string;
  name: string;
  detail?: string;
  lat: number;
  lon: number;
  timezone?: string;
  /** true for "Aktueller Standort" */
  geo?: boolean;
}

const KEY_CURRENT = 'wx.current';
const KEY_FAV = 'wx.favorites';
const KEY_RECENT = 'wx.recent';
const MAX_RECENT = 8;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) – app still works for this session */
  }
}

type Listener = (p: Place | null) => void;
const listeners = new Set<Listener>();
let current: Place | null = read<Place | null>(KEY_CURRENT, null);

export const places = {
  get current() {
    return current;
  },
  set(p: Place) {
    current = p;
    write(KEY_CURRENT, p);
    if (!p.geo) {
      const recent = places.recent.filter((r) => r.id !== p.id);
      write(KEY_RECENT, [p, ...recent].slice(0, MAX_RECENT));
    }
    listeners.forEach((l) => l(p));
  },
  onChange(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get favorites(): Place[] {
    return read<Place[]>(KEY_FAV, []);
  },
  get recent(): Place[] {
    const fav = new Set(places.favorites.map((f) => f.id));
    return read<Place[]>(KEY_RECENT, []).filter((r) => !fav.has(r.id));
  },
  isFavorite(id: string) {
    return places.favorites.some((f) => f.id === id);
  },
  toggleFavorite(p: Place) {
    const fav = places.favorites;
    write(KEY_FAV, places.isFavorite(p.id) ? fav.filter((f) => f.id !== p.id) : [...fav, { ...p, geo: false }]);
  },
  removeRecent(id: string) {
    write(KEY_RECENT, read<Place[]>(KEY_RECENT, []).filter((r) => r.id !== id));
  },
};
