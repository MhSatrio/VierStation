// Turn a place NAME (suburb, city, province, country – or a GenBank geo_loc_name) into coordinates + a precision class.
//   1. coordinates in the text → exact
//   2. only a country → bundled country centre (no network)
//   3. otherwise OpenStreetMap Nominatim (one request per second, cached, identifies VierStation; results © OpenStreetMap contributors, ODbL)
// Precision is derived from what Nominatim says the match IS (its place_rank), never guessed from how long the text is.
import { getJson } from '../integrations/http.ts';
import type { PrecisionId } from '../../shared/geo.ts';
import { countryPlace, parseGeoLocName, parseLatLon } from './places.ts';
import type { Place } from './places.ts';

export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** Nominatim place_rank: 4 country, 8 state, 12 county, 16 city, 18-19 town/village, 20-22 suburb, 25-26 neighbourhood/road, 30 building. */
export function precisionFromRank(rank: number): PrecisionId {
  if (rank >= 27) return 'site';
  if (rank >= 20) return 'suburb';
  if (rank >= 13) return 'city';
  if (rank >= 5) return 'province';
  return 'country';
}

async function nominatim(q: string, signal?: AbortSignal): Promise<Place | null> {
  const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '1', 'accept-language': 'en' })}`;
  const r = await getJson<any[]>(url, { ttl: 30 * 24 * 3600, signal });
  const h = r?.[0]; if (!h) return null;
  const lat = Number(h.lat), lon = Number(h.lon); if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, precision: precisionFromRank(Number(h.place_rank ?? 0)), displayName: String(h.display_name ?? q).slice(0, 300), source: 'OpenStreetMap Nominatim' };
}

export interface GeocodeResult { place: Place | null; tried: string[]; note?: string }
/**
 * `text` may be free text ("Ubud, Bali, Indonesia"), a GenBank geo_loc_name ("Indonesia: Bali, Ubud"), or coordinates.
 * If the full name is not found, coarser parts are tried; the returned precision then reflects the coarser match, and `note` says so.
 */
export async function geocodeText(text: string, signal?: AbortSignal): Promise<GeocodeResult> {
  const t = String(text ?? '').trim(); const tried: string[] = [];
  if (!t) return { place: null, tried };
  const ll = parseLatLon(t);
  if (ll) return { place: { ...ll, precision: 'exact', displayName: `${ll.lat}, ${ll.lon}`, source: 'coordinates entered or recorded' }, tried };
  // most specific part first: "Ubud, Bali, Indonesia" as typed; GenBank "Indonesia: Bali, Ubud" is turned around to the same order
  let parts: string[];
  if (t.includes(':')) { const g = parseGeoLocName(t); parts = [...g.parts.slice().reverse(), g.country].filter(Boolean); }
  else parts = t.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1) { const cp = countryPlace(parts[0]); if (cp) return { place: cp, tried }; } // only a country: no network call needed
  for (let n = parts.length; n >= 1; n--) { // try the whole name first, then drop the most specific part each round
    const query = parts.slice(parts.length - n).join(', ');
    if (tried.includes(query)) continue;
    tried.push(query);
    const place = await nominatim(query, signal);
    if (place) return { place, tried, note: n < parts.length ? `“${t}” was not found as a whole; the match is for “${query}”, so the precision is lower.` : undefined };
  }
  const country = parts[parts.length - 1];
  const cp = country ? countryPlace(country) : null;
  return { place: cp, tried, note: cp ? `Only the country “${country}” could be found; the pin is at its centre.` : undefined };
}
