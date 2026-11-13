// Sample locations stored on DNA/RNA records, and the points the map shows.
import { q } from '../db.ts';
import { fieldByKey } from '../schema.ts';
import { getRaw, updateRecord } from '../records.ts';
import { ensureLabFields } from '../seqlab/store.ts';
import { visibleTableIds } from '../access.ts';
import { PRECISIONS, precisionByLabel, precisionById } from '../../shared/geo.ts';
import type { GeoPoint, PrecisionId } from '../../shared/geo.ts';
import type { Place } from './places.ts';

export interface GeoFields { location?: string; lat?: string; lon?: string; locPrecision?: string; locSource?: string; name?: string; accession?: string }
export function geoFieldIds(tableId: string): GeoFields {
  const o: GeoFields = {};
  for (const k of ['location', 'lat', 'lon', 'locPrecision', 'locSource', 'name', 'accession'] as const) o[k] = fieldByKey(tableId, k)?.id;
  return o;
}
/** Coordinates that VierStation did not derive itself (typed by a person, or no source stated) are never overwritten by a lookup unless forced. */
export const isUserEntered = (src: unknown) => !/^(OpenStreetMap Nominatim|country centre|GenBank)/i.test(String(src ?? '').trim());

/** Store a place on a record. Coordinates, precision class and where they came from are kept, so the map can always say how reliable a pin is. */
export function setLocation(recordId: string, place: Place, o: { userId: string | null; location?: string; sourceNote?: string }) {
  const rec = getRaw(recordId); if (!rec) throw new Error('Record not found');
  ensureLabFields(rec.tableId);
  const f = geoFieldIds(rec.tableId);
  const input: Record<string, unknown> = {};
  if (f.lat) input[f.lat] = Math.round(place.lat * 1e6) / 1e6;
  if (f.lon) input[f.lon] = Math.round(place.lon * 1e6) / 1e6;
  if (f.locPrecision) input[f.locPrecision] = precisionById(place.precision).label;
  if (f.locSource) input[f.locSource] = `${place.source}${o.sourceNote ? ` – ${o.sourceNote}` : ''}`;
  if (f.location && o.location !== undefined && !String(rec.data[f.location] ?? '').trim()) input[f.location] = o.location;
  updateRecord(recordId, input, { userId: o.userId, createChoices: true, origin: { jobId: 'geo', depth: 3 } });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const choiceName = (tableId: string, fieldId: string | undefined, v: unknown): string => {
  if (!fieldId) return '';
  const f = fieldByKey(tableId, 'locPrecision'); const id = Array.isArray(v) ? v[0] : v;
  return String(f?.options?.choices?.find((c: { id: string; name: string }) => c.id === id)?.name ?? id ?? '');
};

/** All DNA/RNA records the user can see that carry coordinates (points) or only a place name (unlocated). */
export function geoPoints(userId: string, workspaceId: string, projectId: string | null) {
  const visible = new Set(visibleTableIds(userId, workspaceId));
  const tables = q.all<{ id: string; name: string }>("SELECT id, name FROM tables WHERE workspace_id=? AND kind IN ('dna','rna')" + (projectId ? ' AND project_id=?' : ''), ...(projectId ? [workspaceId, projectId] : [workspaceId])).filter((t) => visible.has(t.id));
  const points: GeoPoint[] = [], unlocated: { id: string; name: string; location: string }[] = []; let withoutLocation = 0, total = 0;
  for (const t of tables) {
    const f = geoFieldIds(t.id);
    for (const r of q.all<{ id: string; data: string }>('SELECT id, data FROM records WHERE table_id=?', t.id)) {
      total++;
      let d: Record<string, unknown> = {}; try { d = JSON.parse(r.data); } catch { /* skip */ }
      const lat = f.lat ? num(d[f.lat]) : null, lon = f.lon ? num(d[f.lon]) : null;
      const name = String((f.name ? d[f.name] : '') || r.id), location = String((f.location ? d[f.location] : '') ?? '').trim();
      if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const label = choiceName(t.id, f.locPrecision, f.locPrecision ? d[f.locPrecision] : null);
        const pr = precisionByLabel(label)?.id ?? 'unknown'; // a coordinate pair without a stated precision is shown as UNKNOWN (white) rather than assumed exact
        points.push({ id: r.id, recordId: r.id, name, lat, lon, precision: pr, location, source: String((f.locSource ? d[f.locSource] : '') ?? ''), kind: 'record', accession: String((f.accession ? d[f.accession] : '') ?? '') || null });
      } else if (location) unlocated.push({ id: r.id, name, location });
      else withoutLocation++;
    }
  }
  return { points, unlocated, withoutLocation, total, scale: PRECISIONS };
}


/** The map point of ONE record (null when it has no coordinates). */
export function recordPoint(recordId: string, kind: GeoPoint['kind'] = 'record'): GeoPoint | null {
  const r = getRaw(recordId); if (!r) return null;
  const f = geoFieldIds(r.tableId); if (!f.lat || !f.lon) return null;
  const lat = num(r.data[f.lat]), lon = num(r.data[f.lon]); if (lat === null || lon === null) return null;
  const label = choiceName(r.tableId, f.locPrecision, f.locPrecision ? r.data[f.locPrecision] : null);
  return { id: kind === 'query' ? 'query' : recordId, recordId, name: String((f.name ? r.data[f.name] : '') || recordId), lat, lon, precision: precisionByLabel(label)?.id ?? 'unknown', location: String((f.location ? r.data[f.location] : '') ?? ''), source: String((f.locSource ? r.data[f.locSource] : '') ?? ''), kind, accession: String((f.accession ? r.data[f.accession] : '') ?? '') || null };
}
export type { PrecisionId };
