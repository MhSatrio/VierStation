// How precisely a sample's collection place is known. Used by the server (what to store) and the client (pin colour, legend).
// Colour = VierApparatus blue shifted in darkness: DARK navy = very specific / nearly exact; the more WHITE, the more uncertain (e.g. only a country is known).
export type PrecisionId = 'exact' | 'site' | 'suburb' | 'city' | 'province' | 'country' | 'unknown';
export interface PrecisionInfo { id: PrecisionId; label: string; /** typical positional uncertainty in km (radius) – a guide, not a measurement */ radiusKm: number; color: string; text: string }
export const PRECISIONS: PrecisionInfo[] = [
  { id: 'exact', label: 'Exact (GPS point)', radiusKm: 0.05, color: '#14295A', text: 'Coordinates were recorded for the sample (GPS or a lat/lon in the database record).' },
  { id: 'site', label: 'Site / locality', radiusKm: 1, color: '#24427F', text: 'A named site, street or small locality (about 1 km).' },
  { id: 'suburb', label: 'Suburb / district', radiusKm: 5, color: '#35599F', text: 'A suburb, district or neighbourhood (about 5 km).' },
  { id: 'city', label: 'City / town', radiusKm: 25, color: '#4570B6', text: 'A city, town or village (about 25 km).' },
  { id: 'province', label: 'Province / state', radiusKm: 200, color: '#86A9D9', text: 'A province, state or region (about 200 km).' },
  { id: 'country', label: 'Country', radiusKm: 1000, color: '#CAEBFB', text: 'Only the country is known: the pin sits at the country’s centre, not at the sample.' },
  { id: 'unknown', label: 'Unknown', radiusKm: 5000, color: '#EEF7FD', text: 'No usable location.' },
];
export const precisionById = (id: string): PrecisionInfo => PRECISIONS.find((p) => p.id === id) ?? PRECISIONS[PRECISIONS.length - 1];
export const precisionByLabel = (label: string): PrecisionInfo | undefined => PRECISIONS.find((p) => p.label.toLowerCase() === String(label).toLowerCase());
export interface GeoPoint {
  id: string; recordId?: string; name: string; lat: number; lon: number; precision: PrecisionId; location: string; source: string;
  kind: 'record' | 'reference' | 'query'; accession?: string | null; organism?: string | null; note?: string;
}
