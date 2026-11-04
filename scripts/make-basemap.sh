#!/usr/bin/env bash
# Builds the vector basemap of the radar view from Natural Earth (public domain):
#   src/assets/basemap.json        Europe overview (1:50m) + detailed frame around Germany (1:10m) + city names
#   src/assets/basemap-urban.json  built-up areas (city outlines), loaded only when zoomed in
# Usage: npm run basemap   (needs curl, python3 and network access; mapshaper comes via npx)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src/assets/basemap.json"
OUT_URBAN="$ROOT/src/assets/basemap-urban.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
DETAIL=-6,41,26,61        # 1:10m frame around the DWD radar domain (1.46–18.73 E, 45.68–56.22 N)
OVERVIEW=-30,30,50,72     # 1:50m Europe for zooming out; the DETAIL frame is cut out of it
URBAN=1,45.4,19.2,56.5    # city outlines only where the radar is
SIMPLIFY="interval=120"   # metres; ~3 px at zoom 12
MS="npx -y mapshaper@0.6.102"

for f in 10m_land 10m_coastline 10m_lakes 10m_admin_0_boundary_lines_land 10m_admin_1_states_provinces_lines \
  10m_populated_places_simple 10m_urban_areas 50m_land 50m_coastline 50m_lakes 50m_admin_0_boundary_lines_land; do
  curl -sfL -o "$WORK/$f.geojson" "$NE/ne_$f.geojson"
done

cd "$WORK"
detail() { $MS "$1.geojson" -clip bbox=$DETAIL "${@:3}" -filter-fields -o "$2.json" format=geojson precision=0.001; }
detail 10m_land land -simplify $SIMPLIFY keep-shapes -filter-slivers min-area=2km2
detail 10m_coastline coast -simplify $SIMPLIFY
detail 10m_lakes lakes -filter 'scalerank <= 8' -simplify $SIMPLIFY keep-shapes
detail 10m_admin_0_boundary_lines_land borders -simplify $SIMPLIFY
detail 10m_admin_1_states_provinces_lines states -filter 'ADM0_A3 == "DEU"' -simplify $SIMPLIFY

overview() { $MS "$1.geojson" -clip bbox=$OVERVIEW -erase bbox=$DETAIL "${@:3}" -filter-fields -o "$2.json" format=geojson precision=0.01; }
overview 50m_land o_land -simplify interval=800 keep-shapes
overview 50m_coastline o_coast -simplify interval=800
overview 50m_lakes o_lakes -simplify interval=800 keep-shapes
overview 50m_admin_0_boundary_lines_land o_borders -simplify interval=800

$MS 10m_urban_areas.geojson -clip bbox=$URBAN -filter-islands min-area=3km2 remove-empty -simplify interval=150 keep-shapes \
  -filter-fields -o urban.json format=geojson precision=0.001

python3 -I - "$WORK" "$OUT" "$OUT_URBAN" <<'PY'
import json, sys
work, out, out_urban = sys.argv[1:4]

def geoms(name):
    d = json.load(open(f'{work}/{name}.json'))
    # Without attributes mapshaper writes a GeometryCollection instead of a FeatureCollection.
    gs = d['geometries'] if 'geometries' in d else [f['geometry'] for f in d['features']]
    return [g for g in gs if g]

# German exonyms for the foreign cities that get a label.
DE = {
    'Munich': 'München', 'Cologne': 'Köln', 'Hanover': 'Hannover', 'Vienna': 'Wien', 'Brussels': 'Brüssel',
    'Prague': 'Prag', 'Milan': 'Mailand', 'Geneva': 'Genf', 'København': 'Kopenhagen', 'The Hague': 'Den Haag',
    'Warsaw': 'Warschau', 'Venice': 'Venedig', 'Liège': 'Lüttich', 'Strasbourg': 'Straßburg',
    'Luxembourg': 'Luxemburg', 'Pizen': 'Pilsen', 'Århus': 'Aarhus', 'Rome': 'Rom', 'Lisbon': 'Lissabon',
    'Moscow': 'Moskau', 'Kiev': 'Kiew', 'Kyiv': 'Kiew', 'Athens': 'Athen', 'Bucharest': 'Bukarest',
    'Belgrade': 'Belgrad', 'Naples': 'Neapel', 'Florence': 'Florenz', 'Algiers': 'Algier', 'Nicosia': 'Nikosia',
    'St. Petersburg': 'Sankt Petersburg', 'Saint Petersburg': 'Sankt Petersburg', 'Copenhagen': 'Kopenhagen',
    'Gothenburg': 'Göteborg', 'Seville': 'Sevilla', 'Genoa': 'Genua', 'Tripoli': 'Tripolis',
}

def min_zoom(p):
    pop = p['pop_max']
    if pop >= 2_000_000 or (p['adm0cap'] and pop >= 1_000_000): return 4
    if pop >= 1_000_000 or p['adm0cap']: return 5
    if pop >= 700_000: return 6
    if pop >= 250_000: return 7
    if pop >= 120_000: return 8
    if pop >= 60_000: return 9
    return 10

def inside(box, lon, lat):
    w, s, e, n = map(float, box.split(','))
    return w < lon < e and s < lat < n

places = []
for f in json.load(open(f'{work}/10m_populated_places_simple.geojson'))['features']:
    p = f['properties']
    lon, lat = f['geometry']['coordinates']
    # Outside the detail frame only the bigger cities: there the map is only seen zoomed out.
    if inside('-6,41,26,61', lon, lat):
        if p['pop_max'] < 30_000: continue
    elif not inside('-30,30,50,72', lon, lat) or min_zoom(p) > 6:
        continue
    places.append([DE.get(p['name'], p['name']), round(lat, 3), round(lon, 3), min_zoom(p), p['pop_max']])
# Most important first: label placement goes in this order.
places.sort(key=lambda q: (q[3], -q[4]))
places = [q[:4] for q in places]

data = {
    'overview': {'land': geoms('o_land'), 'coast': geoms('o_coast'), 'lakes': geoms('o_lakes'), 'borders': geoms('o_borders')},
    'land': geoms('land'), 'coast': geoms('coast'), 'lakes': geoms('lakes'),
    'borders': geoms('borders'), 'states': geoms('states'), 'places': places,
}
for path, d in ((out, data), (out_urban, geoms('urban'))):
    with open(path, 'w') as fh:
        json.dump(d, fh, separators=(',', ':'), ensure_ascii=False)
    print(path)
PY
