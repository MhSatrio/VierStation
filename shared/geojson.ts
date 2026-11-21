// GeoJSON exchange with QGIS and other GIS tools: sample points out (Point features with every other column as properties) and in
// (Point features become a table of rows that the normal import dialog maps to fields). Pure: no database, no files.

export interface GeoPointRow { lat: number; lon: number; properties: Record<string, unknown> }

/** Valid WGS84 coordinates: latitude -90..90, longitude -180..180. */
export const validLatLon = (lat: unknown, lon: unknown): boolean =>
  typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** The two coordinate columns of a table: by key (lat / lon) or by a plain name (Latitude, Lat, Longitude, Lon, Lng, Long). */
export function findLatLonFields<T extends { id: string; name: string; key?: string | null }>(fields: T[]): { lat: T; lon: T } | null {
  const lat = fields.find((f) => f.key === 'lat') ?? fields.find((f) => /^(lat|latitude)$/i.test(f.name.trim()));
  const lon = fields.find((f) => f.key === 'lon') ?? fields.find((f) => /^(lon|lng|long|longitude)$/i.test(f.name.trim()));
  return lat && lon && lat.id !== lon.id ? { lat, lon } : null;
}

/** A FeatureCollection of Point features. GeoJSON order is [longitude, latitude]. Rows without valid coordinates are left out and counted. */
export function buildGeoJson(rows: GeoPointRow[], name = 'samples'): { json: string; points: number; skipped: number } {
  const features = [];
  let skipped = 0;
  for (const r of rows) {
    if (!validLatLon(r.lat, r.lon)) { skipped++; continue; }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: r.properties });
  }
  const fc = { type: 'FeatureCollection', name, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features };
  return { json: JSON.stringify(fc, null, 2), points: features.length, skipped };
}

export interface GeoGrid { grid: string[][]; points: number; skipped: number }

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Reads a GeoJSON text (FeatureCollection, one Feature, or one Point geometry) into a header row plus one row per Point feature,
 * the shape the CSV import dialog already handles: "Latitude" and "Longitude" first, then every property as its own column.
 * Lines, polygons and features without usable coordinates are skipped and counted. Throws a readable Error when it is not GeoJSON.
 */
export function geojsonToGrid(source: string): GeoGrid {
  let doc: any;
  try { doc = JSON.parse(source.replace(/^﻿/, '')); } catch { throw new Error('This is not valid GeoJSON (the file could not be read as JSON).'); }
  const feats: any[] = doc?.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features : doc?.type === 'Feature' ? [doc] : doc?.type === 'Point' ? [{ type: 'Feature', geometry: doc, properties: {} }] : [];
  if (!feats.length) throw new Error('This GeoJSON has no features.');
  const points: GeoPointRow[] = []; let skipped = 0;
  for (const f of feats) {
    const g = f?.geometry; const c = g?.type === 'Point' ? g.coordinates : null;
    if (!Array.isArray(c) || !validLatLon(Number(c[1]), Number(c[0]))) { skipped++; continue; }
    points.push({ lat: Number(c[1]), lon: Number(c[0]), properties: f.properties && typeof f.properties === 'object' ? f.properties : {} });
  }
  if (!points.length) throw new Error('This GeoJSON has no Point features with valid coordinates (lines and polygons are not imported).');
  const keys: string[] = [];
  for (const p of points) for (const k of Object.keys(p.properties)) if (!keys.includes(k) && !/^(lat|latitude|lon|lng|longitude)$/i.test(k)) keys.push(k);
  const grid: string[][] = [['Latitude', 'Longitude', ...keys]];
  for (const p of points) grid.push([String(p.lat), String(p.lon), ...keys.map((k) => text(p.properties[k]))]);
  return { grid, points: points.length, skipped };
}
