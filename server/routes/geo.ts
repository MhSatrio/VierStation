// Sample locations and the map: world outline, points of the user's DNA records, place-name lookup, and the lab's reference-sequence places.
import { route, str, oneOf } from '../http.ts';
import { q } from '../db.ts';
import { bad } from '../util.ts';
import { requireProject, requireRecord } from '../access.ts';
import { enqueue } from '../jobs.ts';
import { ensureLabFields, latestOp } from '../seqlab/store.ts';
import { worldJson } from '../geo/places.ts';
import { geocodeText } from '../geo/geocode.ts';
import { geoPoints, recordPoint, setLocation } from '../geo/records.ts';
import { PRECISIONS } from '../../shared/geo.ts';
import '../geo/jobs.ts';
import '../seqlab/geo.ts';

/** Country outlines for the globe (Natural Earth, public domain). */
route('GET', '/api/geo/world', (c) => { c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=86400' }); c.res.end(worldJson()); });

/** Points + records that only have a place NAME. Makes sure the location columns exist on the DNA tables first. */
route('GET', '/api/geo/points', (c) => {
  const project = c.query.get('project');
  const proj = project ? requireProject(c.user!.id, project, 'viewer') : null;
  const ws = proj?.workspace_id ?? c.query.get('workspace');
  if (!ws) throw bad('project or workspace is required');
  for (const t of q.all<{ id: string }>("SELECT id FROM tables WHERE workspace_id=? AND kind IN ('dna','rna')" + (proj ? ' AND project_id=?' : ''), ...(proj ? [ws, proj.id] : [ws]))) { try { ensureLabFields(t.id); } catch { /* read-only users still see what exists */ } }
  return geoPoints(c.user!.id, ws, proj?.id ?? null);
});

/** Look up coordinates for the given records' place names (background job; one OpenStreetMap request per second). */
route('POST', '/api/geo/locate', (c) => {
  const ids: string[] = (Array.isArray(c.body.recordIds) ? c.body.recordIds : []).map(String).slice(0, 200);
  if (!ids.length) throw bad('Choose at least one record.');
  const first = requireRecord(c.user!.id, ids[0], 'editor');
  for (const id of ids) requireRecord(c.user!.id, id, 'editor');
  return { jobId: enqueue({ workspaceId: first.table.workspace_id, projectId: first.table.project_id, type: 'geo.locate', name: `Find coordinates for ${ids.length} place name(s)`, payload: { recordIds: ids, force: c.body.force === true }, userId: c.user!.id, dedupeKey: `geo.locate:${first.table.id}` }) };
});

/** Try a place name without saving anything (what would the pin be, and how precise?). */
route('GET', '/api/geo/lookup', async (c) => {
  const text = str(c.query.get('text'), 'text', { max: 300 });
  const r = await geocodeText(text);
  return { text, place: r.place, note: r.note ?? null, tried: r.tried, scale: PRECISIONS };
});

/** Set a record's coordinates by hand (exact) or from a looked-up name. */
route('POST', '/api/geo/set', async (c) => {
  const id = str(c.body.recordId, 'recordId'); requireRecord(c.user!.id, id, 'editor');
  const lat = Number(c.body.lat), lon = Number(c.body.lon);
  if (c.body.lat !== undefined && c.body.lon !== undefined) {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw bad('Latitude must be between -90 and 90 and longitude between -180 and 180.');
    setLocation(id, { lat, lon, precision: oneOf(c.body.precision ?? 'exact', ['exact', 'site', 'suburb', 'city', 'province', 'country'] as const, 'precision'), displayName: `${lat}, ${lon}`, source: 'entered by user' }, { userId: c.user!.id, location: c.body.location ? String(c.body.location) : undefined });
    return { ok: true };
  }
  const r = await geocodeText(str(c.body.location, 'location', { max: 300 }));
  if (!r.place) throw bad('No place found for that name. Try a larger place (city, province or country), or enter coordinates.');
  setLocation(id, r.place, { userId: c.user!.id, location: String(c.body.location), sourceNote: r.note });
  return { ok: true, place: r.place, note: r.note ?? null };
});

// ---- Sequence Lab: where do the query and its reference sequences come from?
route('GET', '/api/lab/:id/geo', (c) => {
  requireRecord(c.user!.id, c.params.id, 'viewer');
  const op = latestOp(c.params.id, 'geo');
  const own = recordPoint(c.params.id, 'query');
  const points = [...(own ? [own] : []), ...((op?.result?.points ?? []) as any[]).filter((p) => p.kind !== 'query')];
  return { points, unresolved: op?.result?.unresolved ?? [], retrievedAt: op?.result?.retrievedAt ?? null, opId: op?.id ?? null, scale: PRECISIONS };
});
route('POST', '/api/lab/:id/geo/locate', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id, 'editor');
  return { jobId: enqueue({ workspaceId: table.workspace_id, projectId: table.project_id, type: 'seq.locate_members', name: 'Find collection places', payload: { recordId: c.params.id }, userId: c.user!.id, dedupeKey: `seq.locate_members:${c.params.id}` }) };
});
/** Save chosen BLAST hits as real records in the DNA table. */
route('POST', '/api/lab/:id/hits/save', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id, 'editor');
  const accessions: string[] = (Array.isArray(c.body.accessions) ? c.body.accessions : []).map(String).slice(0, 100);
  if (!accessions.length) throw bad('Select at least one hit.');
  const region = oneOf(c.body.region ?? 'aligned', ['aligned', 'whole'] as const, 'region');
  return { jobId: enqueue({ workspaceId: table.workspace_id, projectId: table.project_id, type: 'seq.save_hits', name: `Save ${accessions.length} BLAST hit(s) to the DNA table`, payload: { recordId: c.params.id, accessions, region, blastOpId: c.body.blastOpId ? String(c.body.blastOpId) : undefined }, userId: c.user!.id, dedupeKey: `seq.save_hits:${c.params.id}` }) };
});
