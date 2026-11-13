// Relationship explorer API: relationship types, relationships (many-to-many), reactions, pathways, tags, graph neighbourhoods, facets and exports.
import { route, str, oneOf, int } from '../http.ts';
import { q, tx } from '../db.ts';
import { bad, notFound } from '../util.ts';
import { publish } from '../events.ts';
import { auditCtx } from '../audit.ts';
import { requireProject, requireRecord, requireWorkspace } from '../access.ts';
import { fieldByKey } from '../schema.ts';
import { createRecord } from '../records.ts';
import { ensureProjectTable } from '../templates.ts';
import { GRAPH_KINDS } from '../../shared/graph.ts';
import * as M from '../graph/model.ts';
import * as R from '../graph/reactions.ts';
import { buildGraph, edgesCsv, facets, toCytoscapeJson, toGraphML } from '../graph/query.ts';
import type { GraphQuery } from '../graph/query.ts';
import { readFileSync } from 'node:fs';
import { cachedThumbnail, ensureThumbnail, thumbnailStatus } from '../images.ts';

const list = (v: string | null): string[] | undefined => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const changed = (ws: string, what: string, ids: string[] = []) => publish(ws, 'graph.changed', { what, ids });
const wsOfRecord = (userId: string, id: string, need: 'viewer' | 'editor' = 'viewer') => requireRecord(userId, id, need).table.workspace_id;

function graphQueryFrom(c: any): GraphQuery {
  const ws = str(c.query.get('workspace'), 'workspace'); requireWorkspace(c.user!.id, ws);
  const g = (k: string) => c.query.get(k) ?? undefined;
  return { workspaceId: ws, focus: list(c.query.get('focus')), depth: int(c.query.get('depth'), 'depth', 1, 0, 4), kinds: list(c.query.get('kinds')), types: list(c.query.get('types')), evidence: list(c.query.get('evidence')), tags: list(c.query.get('tags')), organism: g('organism'), sourceDb: g('source'), verification: g('verification'), pathway: g('pathway'), includeOrder: c.query.get('order') === '1', limit: int(c.query.get('limit'), 'limit', 400, 20, 3000), tableId: g('table') };
}

// ---------------------------------------------------------------- relationship types
route('GET', '/api/explorer/types', (c) => { const ws = str(c.query.get('workspace'), 'workspace'); requireWorkspace(c.user!.id, ws); return { types: M.listTypes(ws) }; });
route('POST', '/api/explorer/types', (c) => { const ws = str(c.body.workspaceId, 'workspaceId'); requireWorkspace(c.user!.id, ws, 'editor'); const t = M.createType(ws, c.body); auditCtx(c, ws, 'relationship_type.create', 'relationship_type', t.id); return { type: t }; });
route('PATCH', '/api/explorer/types/:id', (c) => { const t = M.typeById(c.params.id); if (!t) throw notFound('Relationship type not found'); requireWorkspace(c.user!.id, t.workspaceId, 'editor'); return { type: M.updateType(c.params.id, c.body) }; });
route('DELETE', '/api/explorer/types/:id', (c) => { const t = M.typeById(c.params.id); if (!t) throw notFound('Relationship type not found'); requireWorkspace(c.user!.id, t.workspaceId, 'editor'); M.deleteType(c.params.id); return { ok: true }; });

// ---------------------------------------------------------------- relationships
/**
 * Create one or several relationships. Each is stored independently; `atomic: true` saves all or none, otherwise each item reports its own result
 * (so “save individually” and “save all” use the same endpoint). Both the drag-and-drop panel and the table-driven editor call this.
 */
route('POST', '/api/relationships', (c) => {
  const items: any[] = Array.isArray(c.body.relationships) ? c.body.relationships : [c.body];
  if (!items.length || items.length > 100) throw bad('Send between 1 and 100 relationships.');
  const ws = wsOfRecord(c.user!.id, str(items[0].sourceId, 'sourceId'), 'editor');
  const results: { ok: boolean; relationship?: M.Relationship; error?: string; code?: string }[] = [];
  const run = () => { for (const it of items) { try { requireRecord(c.user!.id, str(it.sourceId, 'sourceId'), 'editor'); results.push({ ok: true, relationship: M.createRelationship(ws, c.user!.id, { ...it, origin: it.origin ?? 'user' }) }); } catch (e) { if (c.body.atomic) throw e; results.push({ ok: false, error: (e as Error).message, code: (e as { code?: string }).code }); } } };
  if (c.body.atomic) tx(run); else run();
  const made = results.filter((r) => r.ok).map((r) => r.relationship!);
  if (made.length) { auditCtx(c, ws, 'relationship.create', 'relationship', made[0].id, { count: made.length }); changed(ws, 'relationships', made.flatMap((m) => [m.sourceId, m.targetId])); }
  return Array.isArray(c.body.relationships) ? { results } : results[0].ok ? { relationship: results[0].relationship } : (() => { throw Object.assign(bad(results[0].error!), { code: results[0].code }); })();
});
route('GET', '/api/relationships', (c) => {
  const ws = str(c.query.get('workspace'), 'workspace'); requireWorkspace(c.user!.id, ws);
  const r = M.listRelationships({ workspaceId: ws, typeIds: list(c.query.get('types')), evidence: list(c.query.get('evidence')), tags: list(c.query.get('tags')), organism: c.query.get('organism') ?? undefined, sourceDb: c.query.get('source') ?? undefined, verification: c.query.get('verification') ?? undefined, q: c.query.get('q') ?? undefined, limit: int(c.query.get('limit'), 'limit', 200, 1, 2000), offset: int(c.query.get('offset'), 'offset', 0, 0, 1_000_000) });
  return r;
});
route('GET', '/api/relationships/:id', (c) => { const r = M.getRelationship(c.params.id); requireWorkspace(c.user!.id, r.workspaceId); return { relationship: r }; });
route('PATCH', '/api/relationships/:id', (c) => {
  const cur = M.getRelationship(c.params.id); requireWorkspace(c.user!.id, cur.workspaceId, 'editor');
  const r = M.updateRelationship(c.params.id, c.body); auditCtx(c, cur.workspaceId, 'relationship.update', 'relationship', cur.id); changed(cur.workspaceId, 'relationships', [cur.sourceId, cur.targetId]); return { relationship: r };
});
route('DELETE', '/api/relationships/:id', (c) => {
  const cur = M.getRelationship(c.params.id); requireWorkspace(c.user!.id, cur.workspaceId, 'editor');
  M.deleteRelationship(c.params.id); auditCtx(c, cur.workspaceId, 'relationship.delete', 'relationship', cur.id, { source: cur.sourceId, target: cur.targetId }); changed(cur.workspaceId, 'relationships', [cur.sourceId, cur.targetId]);
  return { ok: true, kept: [cur.sourceId, cur.targetId] }; // the two records are untouched
});
route('GET', '/api/records/:id/relationships', (c) => { wsOfRecord(c.user!.id, c.params.id); return { relationships: M.relationshipsOf(c.params.id) }; });
route('PUT', '/api/records/:id/tags', (c) => { const ws = wsOfRecord(c.user!.id, c.params.id, 'editor'); const tags = M.setRecordTags(c.params.id, c.body.tags); changed(ws, 'tags', [c.params.id]); return { tags }; });
route('GET', '/api/records/:id/tags', (c) => { wsOfRecord(c.user!.id, c.params.id); return { tags: M.tagsOfRecords([c.params.id]).get(c.params.id) ?? [] }; });

/** Turn a legacy field link (for example gene → protein created by discovery) into a full, editable relationship. The link itself stays. */
route('POST', '/api/links/:id/convert', (c) => {
  const l = q.get<{ id: number; from_id: string; to_id: string; meta: string | null; fname: string }>('SELECT l.id, l.from_id, l.to_id, l.meta, f.name fname FROM links l JOIN fields f ON f.id=l.field_id WHERE l.id=?', Number(c.params.id));
  if (!l) throw notFound('Link not found');
  const ws = wsOfRecord(c.user!.id, l.from_id, 'editor');
  if (q.get('SELECT 1 FROM relationships WHERE link_id=?', l.id)) throw bad('This link is already a relationship.');
  let m: any = {}; try { m = l.meta ? JSON.parse(l.meta) : {}; } catch { /* no meta */ }
  const rel = M.createRelationship(ws, c.user!.id, { sourceId: l.from_id, targetId: l.to_id, typeName: String(m.relationType ?? l.fname).replace(/_/g, ' '), directional: false, evidenceClass: m.evidenceClass ?? 'user_supplied', description: m.evidence ?? '', sourceDb: m.sourceDb, accession: m.sourceId, allowIncompatible: true, origin: 'discovery', linkId: l.id, citations: m.referenceUrl ? [{ kind: 'url', value: m.referenceUrl }] : [] });
  changed(ws, 'relationships', [l.from_id, l.to_id]); return { relationship: rel };
});

// ---------------------------------------------------------------- records created from the editors (find-or-create by name: never duplicate “glucose”)
route('POST', '/api/explorer/quick-record', (c) => {
  const p = requireProject(c.user!.id, str(c.body.projectId, 'projectId'), 'editor');
  const kind = oneOf(c.body.kind, GRAPH_KINDS, 'kind'); const name = str(c.body.name, 'Name', { max: 200 });
  const tableId = q.get<{ id: string }>('SELECT id FROM tables WHERE workspace_id=? AND project_id=? AND kind=? ORDER BY position, created_at LIMIT 1', p.workspace_id, p.id, kind)?.id ?? ensureProjectTable(p.workspace_id, p.id, kind);
  const nf = fieldByKey(tableId, 'name'); if (!nf) throw bad(`The ${kind} table has no name field.`);
  const existing = q.get<{ id: string }>('SELECT id FROM records WHERE table_id=? AND lower(json_extract(data, ?)) = lower(?) LIMIT 1', tableId, `$.${nf.id}`, name);
  if (existing) return { id: existing.id, created: false, tableId };
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((c.body.fields ?? {}) as Record<string, unknown>)) { const f = fieldByKey(tableId, k); if (f) extra[f.id] = v; }
  const rec = createRecord(tableId, { [nf.id]: name, ...extra }, { userId: c.user!.id, createChoices: true });
  changed(p.workspace_id, 'records', [rec.id]);
  return { id: rec.id, created: true, tableId };
});

// ---------------------------------------------------------------- reactions and pathways
route('GET', '/api/reactions/:id', (c) => {
  const ws = wsOfRecord(c.user!.id, c.params.id);
  const ri = M.recordInfo([c.params.id]).get(c.params.id)!; if (ri.kind !== 'reaction') throw bad('That record is not a reaction.');
  const parts = R.participantsOf([c.params.id]).get(c.params.id) ?? [];
  return { id: c.params.id, workspaceId: ws, name: ri.name, equation: R.equationText(parts, M.selectText(ri.tableId, 'reversible', ri.data)), reversible: M.selectText(ri.tableId, 'reversible', ri.data), evidence: M.selectText(ri.tableId, 'evidence', ri.data), organism: M.selectText(ri.tableId, 'organism', ri.data), compartment: M.selectText(ri.tableId, 'compartment', ri.data), conditions: M.selectText(ri.tableId, 'conditions', ri.data), description: M.selectText(ri.tableId, 'description', ri.data), ec: M.selectText(ri.tableId, 'ec', ri.data), source: M.selectText(ri.tableId, 'source', ri.data), accession: M.selectText(ri.tableId, 'accession', ri.data), participants: parts, tags: M.tagsOfRecords([c.params.id]).get(c.params.id) ?? [], citations: M.citationsOf('record', c.params.id), pathways: R.pathwaysOfRecord(c.params.id) };
});
route('PUT', '/api/reactions/:id/participants', (c) => {
  const ws = wsOfRecord(c.user!.id, c.params.id, 'editor');
  const out = R.setParticipants(ws, c.params.id, Array.isArray(c.body.participants) ? c.body.participants : []);
  auditCtx(c, ws, 'reaction.participants', 'record', c.params.id, { count: out.participants.length }); changed(ws, 'reactions', [c.params.id, ...out.participants.map((p) => p.recordId)]); return out;
});
/** Create a reaction record together with its participants (the “create a reaction from a relationship” shortcut). */
route('POST', '/api/reactions', (c) => {
  const p = requireProject(c.user!.id, str(c.body.projectId, 'projectId'), 'editor');
  const tableId = q.get<{ id: string }>("SELECT id FROM tables WHERE workspace_id=? AND project_id=? AND kind='reaction' ORDER BY position LIMIT 1", p.workspace_id, p.id)?.id ?? ensureProjectTable(p.workspace_id, p.id, 'reaction');
  const f = (k: string) => fieldByKey(tableId, k)?.id; const input: Record<string, unknown> = { [f('name')!]: str(c.body.name, 'Name', { max: 200 }) };
  for (const k of ['reversible', 'evidence', 'organism', 'compartment', 'conditions', 'description', 'ec', 'source', 'accession']) if (c.body[k] !== undefined && c.body[k] !== '' && f(k)) input[f(k)!] = c.body[k];
  let id = '', result: ReturnType<typeof R.setParticipants> | null = null;
  tx(() => { id = createRecord(tableId, input, { userId: c.user!.id, createChoices: true }).id; if (Array.isArray(c.body.participants)) result = R.setParticipants(p.workspace_id, id, c.body.participants); if (c.body.tags) M.setRecordTags(id, c.body.tags); if (c.body.citations) M.setCitations('record', id, c.body.citations); });
  changed(p.workspace_id, 'reactions', [id]); return { id, ...(result ?? {}) };
});
route('GET', '/api/pathways/:id', (c) => { wsOfRecord(c.user!.id, c.params.id); const v = R.buildPathway(c.params.id); return { ...v, tags: M.tagsOfRecords([c.params.id]).get(c.params.id) ?? [], citations: M.citationsOf('record', c.params.id) }; });
route('PUT', '/api/pathways/:id/steps', (c) => {
  const ws = wsOfRecord(c.user!.id, c.params.id, 'editor');
  const v = R.setPathwaySteps(ws, c.params.id, Array.isArray(c.body.steps) ? c.body.steps : [], Array.isArray(c.body.edges) ? c.body.edges : [], c.body.linear === true);
  auditCtx(c, ws, 'pathway.steps', 'record', c.params.id, { steps: v.steps.length }); changed(ws, 'pathways', [c.params.id, ...v.steps.map((s) => s.reactionId)]); return v;
});
route('POST', '/api/pathways', (c) => {
  const p = requireProject(c.user!.id, str(c.body.projectId, 'projectId'), 'editor');
  const tableId = q.get<{ id: string }>("SELECT id FROM tables WHERE workspace_id=? AND project_id=? AND kind='pathway' ORDER BY position LIMIT 1", p.workspace_id, p.id)?.id ?? ensureProjectTable(p.workspace_id, p.id, 'pathway');
  const f = (k: string) => fieldByKey(tableId, k)?.id; const input: Record<string, unknown> = { [f('name')!]: str(c.body.name, 'Name', { max: 200 }) };
  for (const k of ['organism', 'compartment', 'description', 'evidence', 'source', 'accession']) if (c.body[k] !== undefined && c.body[k] !== '' && f(k)) input[f(k)!] = c.body[k];
  let id = ''; tx(() => { id = createRecord(tableId, input, { userId: c.user!.id, createChoices: true }).id; if (c.body.tags) M.setRecordTags(id, c.body.tags); if (c.body.citations) M.setCitations('record', id, c.body.citations); if (Array.isArray(c.body.steps)) R.setPathwaySteps(p.workspace_id, id, c.body.steps, c.body.edges ?? [], c.body.linear === true); });
  changed(p.workspace_id, 'pathways', [id]); return { id, pathway: R.buildPathway(id) };
});
route('GET', '/api/records/:id/citations', (c) => { wsOfRecord(c.user!.id, c.params.id); return { citations: M.citationsOf('record', c.params.id) }; });
route('PUT', '/api/records/:id/citations', (c) => { const ws = wsOfRecord(c.user!.id, c.params.id, 'editor'); M.setCitations('record', c.params.id, Array.isArray(c.body.citations) ? c.body.citations : []); changed(ws, 'citations', [c.params.id]); return { citations: M.citationsOf('record', c.params.id) }; });
route('GET', '/api/records/:id/pathways', (c) => { wsOfRecord(c.user!.id, c.params.id); return { pathways: R.pathwaysOfRecord(c.params.id) }; });

// ---------------------------------------------------------------- the graph itself
route('GET', '/api/explorer/graph', (c) => buildGraph(graphQueryFrom(c)));
route('GET', '/api/explorer/facets', (c) => { const ws = str(c.query.get('workspace'), 'workspace'); requireWorkspace(c.user!.id, ws); M.ensureTypes(ws); return facets(ws); });
route('GET', '/api/explorer/search', (c) => {
  const ws = str(c.query.get('workspace'), 'workspace'); requireWorkspace(c.user!.id, ws);
  const term = str(c.query.get('q'), 'q', { max: 100, optional: true }); const kinds = list(c.query.get('kinds')) ?? [...GRAPH_KINDS];
  const out: { id: string; name: string; kind: string; accession: string | null }[] = [];
  for (const t of q.all<{ id: string; kind: string }>(`SELECT id, kind FROM tables WHERE workspace_id=? AND kind IN (${kinds.map(() => '?').join(',')})`, ws, ...kinds)) {
    const nf = fieldByKey(t.id, 'name'), af = fieldByKey(t.id, 'accession'); if (!nf) continue;
    const rows = q.all<{ id: string; n: string; a: string | null }>(`SELECT id, json_extract(data, ?) n, ${af ? 'json_extract(data, ?)' : 'NULL'} a FROM records WHERE table_id=? AND (json_extract(data, ?) LIKE ? ${af ? 'OR json_extract(data, ?) LIKE ?' : ''}) ORDER BY n LIMIT 20`, ...[`$.${nf.id}`, ...(af ? [`$.${af.id}`] : []), t.id, `$.${nf.id}`, `%${term}%`, ...(af ? [`$.${af.id}`, `%${term}%`] : [])]);
    for (const r of rows) out.push({ id: r.id, name: String(r.n ?? r.id), kind: t.kind, accession: r.a });
  }
  return { results: out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40) };
});
route('GET', '/api/explorer/export', (c) => {
  const g = buildGraph(graphQueryFrom(c)); const fmt = oneOf(c.query.get('format') ?? 'json', ['json', 'cytoscape', 'graphml', 'csv'] as const, 'format');
  const send = (name: string, mime: string, body: string) => { c.res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }); c.res.end(body); };
  if (fmt === 'graphml') return send('vierstation-network.graphml', 'application/xml', toGraphML(g));
  if (fmt === 'csv') return send('vierstation-relationships.csv', 'text/csv', edgesCsv(g));
  if (fmt === 'cytoscape') return send('vierstation-network.cyjs', 'application/json', JSON.stringify(toCytoscapeJson(g), null, 1));
  return send('vierstation-network.json', 'application/json', JSON.stringify(g, null, 1));
});

// ---------------------------------------------------------------- images (cached on this computer)
route('GET', '/api/records/:id/thumbnail', async (c) => {
  wsOfRecord(c.user!.id, c.params.id);
  const t = cachedThumbnail(c.params.id) ?? (await ensureThumbnail(c.params.id));
  if (!t) { c.res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); c.res.end(JSON.stringify({ error: thumbnailStatus(c.params.id)?.note ?? 'No image is available for this record.', code: 'no_image' })); return; }
  c.res.writeHead(200, { 'Content-Type': t.mime, 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  c.res.end(readFileSync(t.file));
});
route('GET', '/api/records/:id/thumbnail/info', async (c) => {
  wsOfRecord(c.user!.id, c.params.id);
  const t = cachedThumbnail(c.params.id); const miss = thumbnailStatus(c.params.id);
  return { available: !!t, info: t?.info ?? null, reason: t ? null : miss?.note ?? null, checkedAt: miss?.retrieved_at ?? t?.info.retrievedAt ?? null };
});
route('POST', '/api/records/:id/thumbnail/refresh', async (c) => {
  wsOfRecord(c.user!.id, c.params.id, 'editor');
  const t = await ensureThumbnail(c.params.id, { refresh: true });
  return { available: !!t, info: t?.info ?? null, reason: t ? null : thumbnailStatus(c.params.id)?.note ?? 'No image is available.' };
});
