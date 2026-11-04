#!/usr/bin/env bash
# Builds src/assets/basemap.json – the vector basemap of the radar view – from Natural Earth (public domain).
# Usage: npm run basemap   (needs curl, python3 and network access; mapshaper comes via npx)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src/assets/basemap.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
BBOX=-6,41,26,61          # generous frame around the DWD radar domain (1.46–18.73 E, 45.68–56.22 N)
SIMPLIFY="interval=120"   # metres; ~3 px at zoom 12
MS="npx -y mapshaper@0.6.102"

for f in land coastline lakes admin_0_boundary_lines_land admin_1_states_provinces_lines populated_places_simple; do
  curl -sfL -o "$WORK/$f.geojson" "$NE/ne_10m_$f.geojson"
done

cd "$WORK"
$MS land.geojson -clip bbox=$BBOX -simplify $SIMPLIFY keep-shapes -filter-slivers min-area=2km2 -filter-fields -o land.json format=geojson precision=0.001
$MS coastline.geojson -clip bbox=$BBOX -simplify $SIMPLIFY -filter-fields -o coast.json format=geojson precision=0.001
$MS lakes.geojson -clip bbox=$BBOX -filter 'scalerank <= 8' -simplify $SIMPLIFY keep-shapes -filter-fields -o lakes.json format=geojson precision=0.001
$MS admin_0_boundary_lines_land.geojson -clip bbox=$BBOX -simplify $SIMPLIFY -filter-fields -o borders.json format=geojson precision=0.001
$MS admin_1_states_provinces_lines.geojson -filter 'ADM0_A3 == "DEU"' -clip bbox=$BBOX -simplify $SIMPLIFY -filter-fields -o states.json format=geojson precision=0.001

python3 -I - "$WORK" "$OUT" <<'PY'
import json, sys
work, out = sys.argv[1], sys.argv[2]

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
    'Luxembourg': 'Luxemburg', 'Pizen': 'Pilsen', 'Århus': 'Aarhus', 'Rome': 'Rom',
}

def min_zoom(p):
    pop = p['pop_max']
    if pop >= 1_000_000 or p['adm0cap']: return 5
    if pop >= 700_000: return 6
    if pop >= 250_000: return 7
    if pop >= 120_000: return 8
    if pop >= 60_000: return 9
    return 10

places = []
for f in json.load(open(f'{work}/populated_places_simple.geojson'))['features']:
    p = f['properties']
    lon, lat = f['geometry']['coordinates']
    if not (-6 < lon < 26 and 41 < lat < 61) or p['pop_max'] < 30_000:
        continue
    places.append([DE.get(p['name'], p['name']), round(lat, 3), round(lon, 3), min_zoom(p), p['pop_max']])
# Most important first: label placement goes in this order.
places.sort(key=lambda q: (q[3], -q[4]))
places = [q[:4] for q in places]

data = {
    'land': geoms('land'), 'coast': geoms('coast'), 'lakes': geoms('lakes'),
    'borders': geoms('borders'), 'states': geoms('states'), 'places': places,
}
with open(out, 'w') as fh:
    json.dump(data, fh, separators=(',', ':'), ensure_ascii=False)
print(f'{out}: {sum(len(v) for v in data.values())} features')
PY
