// Offline place knowledge: the bundled country outlines (Natural Earth, public domain) give country centres without any network call;
// plus parsers for the two GenBank location qualifiers (/lat_lon and /geo_loc_name) and for coordinates typed by people.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrecisionId } from '../../shared/geo.ts';

export interface Country { name: string; short: string; iso2: string | null; iso3: string; continent: string; c: [number, number]; bbox: [number, number, number, number]; polys: number[][][][] }
let cache: { source: string; countries: Country[] } | null = null;
export function world() {
  if (!cache) cache = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'world-110m.json'), 'utf8'));
  return cache!;
}
export const worldJson = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'world-110m.json'), 'utf8');

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ALIASES: Record<string, string> = {
  usa: 'united states of america', us: 'united states of america', 'u s a': 'united states of america', 'united states': 'united states of america', america: 'united states of america',
  uk: 'united kingdom', 'great britain': 'united kingdom',
  russia: 'russian federation', 'south korea': 'republic of korea', korea: 'republic of korea', 'republic of korea': 'republic of korea', 'north korea': 'dem rep korea',
  'viet nam': 'vietnam', laos: 'lao pdr', 'ivory coast': 'cote d ivoire', czechia: 'czech republic', burma: 'myanmar', 'east timor': 'timor leste', 'timor leste': 'timor leste',
  turkiye: 'turkey', brunei: 'brunei darussalam', macedonia: 'north macedonia', swaziland: 'eswatini', palestine: 'palestine', taiwan: 'taiwan',
  'democratic republic of the congo': 'dem rep congo', drc: 'dem rep congo', 'republic of the congo': 'congo', 'the netherlands': 'netherlands', holland: 'netherlands', uae: 'united arab emirates',
};
let index: Map<string, Country> | null = null;
function countryIndex() {
  if (index) return index;
  index = new Map();
  for (const c of world().countries) for (const k of [c.name, c.short, c.iso2 ?? '', c.iso3]) if (k) index.set(norm(k), c);
  return index;
}
/** A country by name, common alias or ISO code (offline). */
export function findCountry(name: string): Country | null {
  const n = norm(name); if (!n) return null;
  const idx = countryIndex();
  const direct = idx.get(n) ?? idx.get(ALIASES[n] ?? '');
  if (direct) return direct;
  // "democratic republic of the congo" style long names: try the alias on a shortened key
  for (const [k, v] of Object.entries(ALIASES)) if (n === k) return idx.get(v) ?? null;
  return null;
}
/** Country containing a point (used to sanity-check coordinates against a stated country). */
export function countryAt(lon: number, lat: number): Country | null {
  const inRing = (r: number[][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c; } return c; };
  for (const c of world().countries) {
    if (lon < c.bbox[0] || lon > c.bbox[2] || lat < c.bbox[1] || lat > c.bbox[3]) continue;
    for (const poly of c.polys) if (inRing(poly[0]) && !poly.slice(1).some(inRing)) return c;
  }
  return null;
}

/** GenBank /lat_lon: "38.52 N 122.99 W"; also plain "-6.2, 106.8" typed by people. */
export function parseLatLon(s: string): { lat: number; lon: number } | null {
  const t = String(s ?? '').trim(); if (!t) return null;
  let m = /(-?\d+(?:\.\d+)?)\s*°?\s*([NS])[\s,;]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])/i.exec(t);
  let lat: number, lon: number;
  if (m) { lat = Number(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1); lon = Number(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1); }
  else { m = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(t); if (!m) return null; lat = Number(m[1]); lon = Number(m[2]); }
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
/** GenBank /geo_loc_name: "Country: region, locality" (also old /country). */
export function parseGeoLocName(s: string): { country: string; parts: string[] } {
  const [country, rest] = String(s ?? '').split(/:(.*)/s);
  return { country: (country ?? '').trim(), parts: (rest ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
}
export interface Place { lat: number; lon: number; precision: PrecisionId; displayName: string; source: string }
/** Country-level place without any network call. */
export function countryPlace(name: string): Place | null {
  const c = findCountry(name); if (!c) return null;
  return { lat: c.c[1], lon: c.c[0], precision: 'country', displayName: c.name, source: 'country centre (Natural Earth, bundled)' };
}
