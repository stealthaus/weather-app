# Wetter

Persönliche Wetter-App fürs iPhone als Progressive Web App. Sie läuft komplett im Browser, braucht kein Backend und keine API-Keys und wird kostenlos auf GitHub Pages gehostet.

**Ansichten**

- **Jetzt:** aktuelle Messung der nächsten DWD-Station, 48-Stunden-Verlauf und 10-Tage-Übersicht (DWD MOSMIX über Bright Sky)
- **Radar:** DWD-Radarkomposit der letzten Stunde plus 2 Stunden Nowcast als Animation
- **14 Tage:** Ensemble-Trend (ECMWF IFS, optional zusätzlich ICON-EPS) mit Median und 10–90-%-Band für Höchst- und Tiefstwert, Regenwahrscheinlichkeit und Niederschlagsspanne. Ab Tag 10 zeigt die App nur noch Spannen.

## Datenquellen

| Zweck | Quelle | Endpunkt |
| --- | --- | --- |
| Aktuelles Wetter, Vorhersage | [Bright Sky](https://brightsky.dev) (DWD MOSMIX und SYNOP) | `api.brightsky.dev/current_weather`, `/weather` |
| Regenradar | [DWD GeoServer](https://maps.dwd.de) (WMS) | Layer `dwd:Radar_wn-product_1x1km_ger` |
| 14-Tage-Ensemble | [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) | Modelle `ecmwf_ifs025` (51 Läufe), `icon_seamless_eps` |
| Ortssuche | Open-Meteo Geocoding | `geocoding-api.open-meteo.com/v1/search` |
| Name des aktuellen Standorts | OpenStreetMap Nominatim | `nominatim.openstreetmap.org/reverse` |
| Grundkarte | OpenStreetMap-Kacheln | `tile.openstreetmap.org` |

Alle Anfragen gehen direkt vom Gerät an die Dienste. Die Daten des DWD stehen unter CC BY 4.0, die von Open-Meteo ebenfalls.

## Entwicklung

Voraussetzung ist Node.js 18 oder neuer.

```bash
npm install
npm run dev
```

Der Dev-Server läuft auf http://localhost:5173. Für einen Test auf dem iPhone im selben WLAN startest du ihn mit `npm run dev -- --host` und öffnest die angezeigte Netzwerk-Adresse in Safari. Geolocation funktioniert dort nur über HTTPS, also erst nach dem Deployment.

```bash
npm run build     # Typecheck und Produktions-Build nach dist/
npm run preview   # Build lokal ansehen (inklusive Service Worker)
npm run icons     # App-Icons neu erzeugen (braucht Python mit Pillow)
```

## Deployment auf GitHub Pages

1. Repository auf GitHub anlegen und den Code auf `main` pushen.
2. Unter **Settings → Pages → Build and deployment** als Source **GitHub Actions** wählen.
3. Jeder Push auf `main` baut die App über `.github/workflows/deploy.yml` und veröffentlicht sie unter `https://<benutzer>.github.io/<repo>/`.

Die App verwendet relative Pfade (`base: './'`), daher funktioniert sie unter jedem Repo-Namen ohne Anpassung.

## Installation auf dem iPhone

1. Die Pages-URL in **Safari** öffnen.
2. Auf **Teilen** tippen (Quadrat mit Pfeil) und **Zum Home-Bildschirm** wählen.
3. Die App startet danach im Vollbild ohne Safari-Leisten.

Für „Aktueller Standort“ fragt iOS beim ersten Mal nach der Erlaubnis. Falls du sie abgelehnt hast: **Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites**.

Nach einem Update lädt die App die neue Version beim nächsten Start. Falls sie hängt, die App einmal ganz schließen und neu öffnen.

## Aufbau

```
src/
  api/        Bright Sky, Open-Meteo (Ensemble, Geocoding), DWD-Radar
  lib/        Formatierung, Statistik (Perzentile), Icons, Orte (localStorage), Chart.js-Setup
  views/      home.ts, radar.ts, trend.ts
  sheet.ts    Ortssuche, Favoriten, Verlauf
  main.ts     Hash-Router, Service-Worker-Registrierung
public/
  sw.js       Service Worker: App-Shell-Cache, letzte Daten offline
  manifest.webmanifest, icons/
```

### So wird der Trend berechnet

Für jeden Tag nimmt die App die Tageshöchst- und Tiefstwerte aller Ensemble-Läufe und berechnet daraus Median, 10. und 90. Perzentil. Die Regenwahrscheinlichkeit ist der Anteil der Läufe mit mindestens 0,1 mm (oder 1 mm, umschaltbar) Tagesniederschlag. Mit „+ ICON-EPS“ werden für die ersten rund 7 Tage die Läufe beider Modelle zusammengelegt.
