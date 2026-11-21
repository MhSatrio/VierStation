import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeoJson, findLatLonFields, geojsonToGrid, validLatLon } from '../shared/geojson.ts';

test('coordinates are validated: latitude within 90, longitude within 180, numbers only', () => {
  assert.equal(validLatLon(-8.65, 115.2), true);
  assert.equal(validLatLon(91, 0), false);
  assert.equal(validLatLon(0, 181), false);
  assert.equal(validLatLon('1', 2), false);
  assert.equal(validLatLon(NaN, 2), false);
});

test('the coordinate columns are found by key or by a plain name, and never the same column twice', () => {
  const f = (id: string, name: string, key?: string) => ({ id, name, key: key ?? null });
  assert.deepEqual(findLatLonFields([f('a', 'Name'), f('b', 'Latitude'), f('c', 'Longitude')]) && 1, 1);
  assert.equal(findLatLonFields([f('b', 'Anything', 'lat'), f('c', 'Else', 'lon')])?.lat.id, 'b');
  assert.equal(findLatLonFields([f('x', 'Lng'), f('y', 'lat')])?.lon.id, 'x');
  assert.equal(findLatLonFields([f('a', 'Name'), f('b', 'Latitude')]), null);
});

test('GeoJSON out: Point features in [longitude, latitude] order; rows without valid coordinates are left out and counted', () => {
  const r = buildGeoJson([
    { lat: -8.65, lon: 115.2, properties: { Name: 'Site A', Species: 'Bacillus subtilis' } },
    { lat: 999, lon: 0, properties: { Name: 'bad' } },
    { lat: NaN, lon: NaN, properties: { Name: 'none' } },
  ], 'samples');
  const doc = JSON.parse(r.json);
  assert.equal(doc.type, 'FeatureCollection');
  assert.equal(doc.features.length, 1); assert.equal(r.points, 1); assert.equal(r.skipped, 2);
  assert.deepEqual(doc.features[0].geometry, { type: 'Point', coordinates: [115.2, -8.65] });
  assert.equal(doc.features[0].properties.Species, 'Bacillus subtilis');
});

test('GeoJSON in: a FeatureCollection becomes a header row plus one row per point, properties as columns', () => {
  const src = JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [115.2, -8.65] }, properties: { site: 'A', depth: 3, tags: ['x', 'y'] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [100, 1] }, properties: { site: 'B', note: 'n' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { site: 'line' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [500, 1] }, properties: { site: 'bad' } },
  ] });
  const g = geojsonToGrid(src);
  assert.deepEqual(g.grid[0], ['Latitude', 'Longitude', 'site', 'depth', 'tags', 'note']);
  assert.deepEqual(g.grid[1], ['-8.65', '115.2', 'A', '3', '["x","y"]', '']);
  assert.deepEqual(g.grid[2], ['1', '100', 'B', '', '', 'n']);
  assert.equal(g.points, 2); assert.equal(g.skipped, 2);
});

test('GeoJSON in: a single Feature or Point works, a property called Latitude is not duplicated, and bad input says why', () => {
  assert.equal(geojsonToGrid(JSON.stringify({ type: 'Point', coordinates: [10, 20] })).grid[1][0], '20');
  const one = geojsonToGrid(JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 20] }, properties: { Latitude: 'x', name: 'n' } }));
  assert.deepEqual(one.grid[0], ['Latitude', 'Longitude', 'name']);
  assert.throws(() => geojsonToGrid('not json'), /not valid GeoJSON/);
  assert.throws(() => geojsonToGrid('{"type":"FeatureCollection","features":[]}'), /no features/);
  assert.throws(() => geojsonToGrid(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} }] })), /no Point features/);
});
