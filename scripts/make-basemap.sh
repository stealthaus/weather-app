#!/usr/bin/env bash
# Builds the vector basemap of the radar view:
#   src/assets/basemap.json         world (1:50m) + detailed frame around Germany (1:10m) + city names
#   src/assets/basemap-kreise.json  district borders, loaded from zoom 8
#   src/assets/gemeinden/*.json     municipality borders and names in 1° tiles, loaded from zoom 10
# Sources: Natural Earth (public domain); VG250-EW © GeoBasis-DE / BKG, dl-de/by-2-0.
# Usage: npm run basemap   (needs curl, unzip, python3 and network access; mapshaper comes via npx)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src/assets/basemap.json"
OUT_KREISE="$ROOT/src/assets/basemap-kreise.json"
OUT_TILES="$ROOT/src/assets/gemeinden"
VG250=https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/aktuell/vg250-ew_12-31.utm32s.shape.ebenen.zip
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
DETAIL=-6,41,26,61        # 1:10m frame around the DWD radar domain (1.46–18.73 E, 45.68–56.22 N)
SIMPLIFY="interval=120"   # metres; ~3 px at zoom 12
MS="npx -y mapshaper@0.6.102"

for f in 10m_land 10m_coastline 10m_lakes 10m_admin_0_boundary_lines_land 10m_admin_1_states_provinces_lines \
  10m_populated_places_simple 50m_land 50m_coastline 50m_lakes 50m_admin_0_boundary_lines_land; do
  curl -sfL -o "$WORK/$f.geojson" "$NE/ne_$f.geojson"
done
curl -sfL -o "$WORK/vg250.zip" "$VG250"
unzip -q -j "$WORK/vg250.zip" '*/VG250_GEM.*' '*/VG250_KRS.*' '*/VG250_PK.*' -d "$WORK/vg250"

cd "$WORK"
detail() { $MS "$1.geojson" -clip bbox=$DETAIL "${@:3}" -filter-fields -o "$2.json" format=geojson precision=0.001; }
detail 10m_land land -simplify $SIMPLIFY keep-shapes -filter-slivers min-area=2km2
detail 10m_coastline coast -simplify $SIMPLIFY
detail 10m_lakes lakes -filter 'scalerank <= 8' -simplify $SIMPLIFY keep-shapes
detail 10m_admin_0_boundary_lines_land borders -simplify $SIMPLIFY
detail 10m_admin_1_states_provinces_lines states -filter 'ADM0_A3 == "DEU"' -simplify $SIMPLIFY

# The rest of the world, coarser; the DETAIL frame is cut out of it.
world() { $MS "$1.geojson" -erase bbox=$DETAIL "${@:3}" -filter-fields -o "$2.json" format=geojson precision=0.01; }
world 50m_land o_land -simplify interval=1000 keep-shapes -filter-slivers min-area=20km2
world 50m_coastline o_coast -simplify interval=1000
world 50m_lakes o_lakes -simplify interval=1000 keep-shapes
world 50m_admin_0_boundary_lines_land o_borders -simplify interval=1000

# Only shared borders (innerlines): the national border and the coast come from Natural Earth. GF 4 = land.
$MS vg250/VG250_GEM.shp -filter 'GF == 4' -proj wgs84 -simplify interval=60 -innerlines -o gem_lines.json format=geojson
$MS vg250/VG250_KRS.shp -filter 'GF == 4' -proj wgs84 -simplify interval=100 -innerlines -o krs_lines.json format=geojson
$MS vg250/VG250_GEM.shp -filter 'GF == 4' -each 'delete BEGINN; delete WSK' -o gem_attr.json format=json
$MS vg250/VG250_PK.shp -each 'delete BEGINN' -o gem_points.json format=json

rm -rf "$OUT_TILES" "$ROOT/src/assets/basemap-urban.json"
mkdir -p "$OUT_TILES"
python3 -I - "$WORK" "$OUT" "$OUT_KREISE" "$OUT_TILES" "$DETAIL" <<'PY'
import json, math, sys
work, out, out_kreise, out_tiles, detail = sys.argv[1:6]

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
    'St.  Petersburg': 'Sankt Petersburg', 'St. Petersburg': 'Sankt Petersburg', 'Copenhagen': 'Kopenhagen',
    'Gothenburg': 'Göteborg', 'Seville': 'Sevilla', 'Genoa': 'Genua', 'Tripoli': 'Tripolis', 'Tehran': 'Teheran', 'Baghdad': 'Bagdad',
    'Beirut': 'Beirut', 'Aleppo': 'Aleppo', 'Damascus': 'Damaskus', 'Cairo': 'Kairo',
    'Beijing': 'Peking', 'Tokyo': 'Tokio', 'Mexico City': 'Mexiko-Stadt', 'New Delhi': 'Neu-Delhi',
    'Washington, D.C.': 'Washington', 'Singapore': 'Singapur', 'Hong Kong': 'Hongkong', 'Havana': 'Havanna',
    'Cape Town': 'Kapstadt', 'Riyadh': 'Riad', 'Ho Chi Minh City': 'Ho-Chi-Minh-Stadt', 'Mecca': 'Mekka',
    'Bogota': 'Bogotá', 'Taipei': 'Taipeh', 'Rabat': 'Rabat', 'Addis Ababa': 'Addis Abeba',
}

def min_zoom(p):
    pop = p['pop_max']
    if pop >= 5_000_000 or (p['adm0cap'] and pop >= 2_000_000): return 2
    if pop >= 2_000_000 or (p['adm0cap'] and pop >= 500_000): return 3
    if pop >= 1_000_000 or p['adm0cap']: return 4
    if pop >= 1_000_000 or p['adm0cap']: return 5
    if pop >= 700_000: return 6
    if pop >= 250_000: return 7
    if pop >= 120_000: return 8
    if pop >= 60_000: return 9
    return 10

def de_zoom(ewz):
    if ewz >= 1_000_000: return 5
    if ewz >= 500_000: return 6
    if ewz >= 200_000: return 7
    if ewz >= 100_000: return 8
    if ewz >= 50_000: return 9
    if ewz >= 10_000: return 10
    return 11

def inside(box, lon, lat):
    w, s, e, n = map(float, box.split(','))
    return w < lon < e and s < lat < n

places = []
for f in json.load(open(f'{work}/10m_populated_places_simple.geojson'))['features']:
    p = f['properties']
    lon, lat = f['geometry']['coordinates']
    if p['adm0_a3'] == 'DEU':
        continue  # German towns come from VG250 below
    # Outside the detail frame only the bigger cities: there the map is only seen zoomed out.
    if inside(detail, lon, lat):
        if p['pop_max'] < 30_000: continue
    elif min_zoom(p) > 4:
        continue
    places.append([DE.get(p['name'], p['name']), round(lat, 3), round(lon, 3), min_zoom(p), p['pop_max']])

# German municipalities (VG250): the bigger ones go into the main file, the rest into the tiles.
ewz = {a['AGS']: a['EWZ'] for a in json.load(open(f'{work}/gem_attr.json'))}
SHORT = {'Frankfurt am Main': 'Frankfurt'}
TILE = 1.0  # degrees
def tile_of(lon, lat):
    return math.floor(lon / TILE), math.floor(lat / TILE)
tiles = {}
def tile(key):
    return tiles.setdefault(key, {'g': [], 'p': []})
for pt in json.load(open(f'{work}/gem_points.json')):
    e = ewz.get(pt['AGS'], 0)
    if not e:
        continue
    q = [SHORT.get(pt['GEN'], pt['GEN']), round(pt['LAT_DEZ'], 4), round(pt['LON_DEZ'], 4), de_zoom(e), e]
    if pt['GEN'] == 'Berlin':
        q[3] = 3  # capital, like the other capitals of its size
    if q[3] <= 9:
        places.append(q)
    else:
        tile(tile_of(q[2], q[1]))['p'].append(q)

# Most important first: label placement goes in this order.
def ordered(ps):
    return [q[:4] for q in sorted(ps, key=lambda q: (q[3], -q[4]))]
places = ordered(places)

# Lines as integer deltas in 1e-4 degrees (~10 m): [x0, y0, dx1, dy1, …]; far smaller than GeoJSON.
def lines(name):
    for g in geoms(name):
        parts = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
        for c in parts:
            pts = [(round(x * 1e4), round(y * 1e4)) for x, y, *_ in c]
            flat, px, py = [], 0, 0
            for x, y in pts:
                if flat and x == px and y == py:
                    continue
                flat += [x - px, y - py]
                px, py = x, y
            if len(flat) >= 4:
                yield flat, pts

with open(out_kreise, 'w') as fh:
    json.dump([f for f, _ in lines('krs_lines')], fh, separators=(',', ':'))

# Every border line goes into each tile its bounding box touches; the id lets the app draw it once.
for i, (flat, pts) in enumerate(lines('gem_lines')):
    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    (x0, y0), (x1, y1) = tile_of(min(xs) / 1e4, min(ys) / 1e4), tile_of(max(xs) / 1e4, max(ys) / 1e4)
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            tile((tx, ty))['g'].append([i] + flat)
for (tx, ty), t in tiles.items():
    t['p'] = ordered(t['p'])
    with open(f'{out_tiles}/{tx}_{ty}.json', 'w') as fh:
        json.dump(t, fh, separators=(',', ':'), ensure_ascii=False)
print(f'{len(tiles)} tiles')

# Natural Earth layers in the same delta encoding, scale = units per degree:
# {'s': scale, 'l': [line, …]} for lines, {'s': scale, 'p': [[ring, …], …]} for polygons.
def encode(name, scale):
    def enc(c):
        flat, px, py = [], 0, 0
        for x, y, *_ in c:
            X, Y = round(x * scale), round(y * scale)
            if flat and X == px and Y == py:
                continue
            flat += [X - px, Y - py]
            px, py = X, Y
        return flat
    ls, ps = [], []
    for g in geoms(name):
        t, c = g['type'], g['coordinates']
        if t == 'LineString': ls.append(enc(c))
        elif t == 'MultiLineString': ls += [enc(x) for x in c]
        elif t == 'Polygon': ps.append([enc(r) for r in c])
        elif t == 'MultiPolygon': ps += [[enc(r) for r in poly] for poly in c]
    return {'s': scale, 'p': ps} if ps else {'s': scale, 'l': [l for l in ls if len(l) >= 4]}

data = {
    'world': {k: encode(f'o_{k}', 100) for k in ('land', 'coast', 'lakes', 'borders')},
    **{k: encode(k, 1000) for k in ('land', 'coast', 'lakes', 'borders', 'states')},
    'places': places,
}
with open(out, 'w') as fh:
    json.dump(data, fh, separators=(',', ':'), ensure_ascii=False)
PY
