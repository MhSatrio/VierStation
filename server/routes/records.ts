import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route, str, int } from '../http.ts';
import { q, tx } from '../db.ts';
import { bad, forbidden, notFound, now, safeJson, sha256, uid } from '../util.ts';
import { config } from '../config.ts';
import { requireRecord, requireTable, requireWorkspace, tableLevel } from '../access.ts';
import { auditCtx } from '../audit.ts';
import { createRecord, deleteRecords, getRecord, hydrateRows, updateRecord, bumpTable, reindexTable, readableRecord, getRaw } from '../records.ts';
import { clearQueryCache, globalSearch, queryRecords, specFromView } from '../query.ts';
import type { QuerySpec } from '../query.ts';
import { getView, listFields, listViews } from '../schema.ts';
import { exportRecords } from '../exporter.ts';
import { listProvenance } from '../ingest.ts';
import { findDuplicateChemicals, mergeChemicals, flagDuplicates } from '../discovery/chemical.ts';
import { notify } from '../notify.ts';
import { publish } from '../events.ts';
import type { FilterGroup, SortSpec } from '../../shared/types.ts';
import { Hydrator, toRaw } from '../records.ts';

function specFromBody(b: any): QuerySpec {
  const spec: QuerySpec = {
    filter: b.filter as FilterGroup | undefined, sorts: Array.isArray(b.sorts) ? (b.sorts as SortSpec[]) : undefined, groupBy: b.groupBy ?? undefined,
    search: typeof b.search === 'string' ? b.search.slice(0, 200) : undefined, offset: int(b.offset, 'offset', 0, 0, 10_000_000), limit: int(b.limit, 'limit', 200, 1, 5000),
    fieldIds: Array.isArray(b.fieldIds) ? b.fieldIds.map(String) : undefined, ids: Array.isArray(b.ids) ? b.ids.map(String).slice(0, 5000) : undefined,
  };
  if (spec.filter && (!Array.isArray(spec.filter.items) || !['and', 'or'].includes(spec.filter.mode))) throw bad('Invalid filter');
  return spec;
}

// Query a table, optionally through a saved view. Request-level filter/sort are ANDed/overridden on top of the view's own.
route('POST', '/api/tables/:id/query', (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  let spec = specFromBody(c.body);
  if (c.body.viewId) {
    const v = getView(String(c.body.viewId));
    if (v.tableId !== t.id) throw notFound('View not found');
    const base = specFromView(v.config);
    const reqItems = spec.filter?.items ?? [];
    spec = {
      ...spec,
      filter: base.filter?.items.length || reqItems.length ? { mode: 'and', items: [...(base.filter?.items.length ? [base.filter] : []), ...(reqItems.length ? [spec.filter!] : [])] } : undefined,
      sorts: spec.sorts?.length ? spec.sorts : base.sorts, groupBy: spec.groupBy === undefined ? base.groupBy : spec.groupBy,
    };
  }
  const r = queryRecords(t.id, spec);
  return { ...r, fields: undefined };
});

route('POST', '/api/tables/:id/records', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'editor');
  const inputs: Record<string, unknown>[] = Array.isArray(c.body.records) ? c.body.records : [c.body.fields ?? {}];
  if (inputs.length > 2000) throw bad('At most 2000 records per request');
  const out: ReturnType<typeof createRecord>[] = [];
  const bulk = inputs.length > 1;
  // one transaction for the whole batch (all-or-nothing, and ~10x faster than one commit per record)
  tx(() => { for (const inp of inputs) out.push(createRecord(t.id, inp, { userId: c.user!.id, createChoices: c.body.createChoices === true, silent: bulk, lean: bulk })); });
  if (bulk) { publish(t.workspace_id, 'record.changed', { tableId: t.id, ids: out.map((r) => r.id), op: 'created' }); }
  auditCtx(c, t.workspace_id, 'record.create', 'table', t.id, { count: out.length });
  return { records: out };
});

route('GET', '/api/records/:id', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id);
  const record = getRecord(c.params.id);
  const backlinkRows = q.all<any>(
    `SELECT l.field_id, l.from_id, l.to_id, l.meta FROM links l WHERE l.to_id=? OR l.from_id=?`, c.params.id, c.params.id);
  void backlinkRows;
  return {
    record, table: { id: table.id, name: table.name, kind: table.kind, projectId: table.project_id, workspaceId: table.workspace_id, level: tableLevel(c.user!.id, table) },
    fields: listFields(table.id), provenance: listProvenance(c.params.id),
    comments: q.all<any>('SELECT c.id, c.body, c.created_at AS createdAt, u.name AS author, u.id AS authorId FROM comments c JOIN users u ON u.id=c.user_id WHERE c.record_id=? ORDER BY c.created_at', c.params.id),
  };
});

route('PATCH', '/api/records/:id', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id, 'editor');
  const r = updateRecord(c.params.id, c.body.fields ?? {}, { userId: c.user!.id, createChoices: c.body.createChoices === true, ifUnmodifiedSince: typeof c.body.ifUnmodifiedSince === 'string' ? c.body.ifUnmodifiedSince : undefined });
  notifyCollaborators(c.user!, table.workspace_id, r.id, table.name);
  return { record: r };
});

/** FR-1.24: tell the people attached to a record (creator, user-field values) when someone else changes it. */
function notifyCollaborators(actor: { id: string; name: string }, workspaceId: string, recordId: string, tableName: string) {
  const raw = getRaw(recordId);
  if (!raw) return;
  const targets = new Set<string>();
  if (raw.createdBy) targets.add(raw.createdBy);
  for (const f of listFields(raw.tableId)) if (f.type === 'user' && typeof raw.data[f.id] === 'string') targets.add(raw.data[f.id]);
  targets.delete(actor.id);
  const title = new Hydrator().display(raw);
  for (const u of targets) notify(u, { kind: 'collaborator_update', title: `${actor.name} updated ${title}`, body: `In ${tableName}`, link: `/record/${recordId}`, workspaceId, dedupe: 'collab' });
}

route('DELETE', '/api/records/:id', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id, 'editor');
  deleteRecords(table.id, [c.params.id], { userId: c.user!.id });
  auditCtx(c, table.workspace_id, 'record.delete', 'record', c.params.id);
  return { ok: true };
});

// bulk operations on selected rows
route('POST', '/api/tables/:id/bulk', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'editor');
  const ids: string[] = Array.isArray(c.body.ids) ? c.body.ids.map(String) : [];
  if (!ids.length) throw bad('Select at least one record');
  if (ids.length > 5000) throw bad('At most 5000 records per bulk action');
  const own = new Set(q.all<{ id: string }>(`SELECT id FROM records WHERE table_id=? AND id IN (${ids.map(() => '?').join(',')})`, t.id, ...ids).map((r) => r.id));
  const valid = ids.filter((i) => own.has(i));
  const op = String(c.body.op);
  let affected = 0;
  if (op === 'delete') { affected = deleteRecords(t.id, valid, { userId: c.user!.id }); auditCtx(c, t.workspace_id, 'record.bulk_delete', 'table', t.id, { count: affected }); }
  else if (op === 'update') {
    if (!c.body.fields || typeof c.body.fields !== 'object') throw bad('fields required');
    for (const id of valid) { updateRecord(id, c.body.fields, { userId: c.user!.id, silent: true, createChoices: c.body.createChoices === true }); affected++; }
    publish(t.workspace_id, 'record.changed', { tableId: t.id, ids: valid, op: 'updated' });
    auditCtx(c, t.workspace_id, 'record.bulk_update', 'table', t.id, { count: affected });
  } else if (op === 'duplicate') {
    const fields = listFields(t.id).filter((f) => !['relation', 'lookup', 'rollup', 'formula', 'createdTime', 'lastModifiedTime', 'attachment'].includes(f.type));
    for (const id of valid) { const raw = getRaw(id)!; const copy: Record<string, unknown> = {}; for (const f of fields) if (raw.data[f.id] !== undefined) copy[f.id] = raw.data[f.id]; const name = fields[0]; if (typeof copy[name.id] === 'string') copy[name.id] = `${copy[name.id]} (copy)`; createRecord(t.id, copy, { userId: c.user!.id, silent: true }); affected++; }
    publish(t.workspace_id, 'record.changed', { tableId: t.id, ids: [], op: 'created' });
  } else throw bad('Unknown bulk operation');
  return { affected };
});

// ---------------- comments ----------------
route('POST', '/api/records/:id/comments', (c) => {
  const { table } = requireRecord(c.user!.id, c.params.id, 'viewer');
  const body = str(c.body.body, 'Comment', { max: 4000 });
  const id = uid('cmt');
  q.run('INSERT INTO comments(id,record_id,user_id,body,created_at) VALUES (?,?,?,?,?)', id, c.params.id, c.user!.id, body, now());
  notifyCollaborators(c.user!, table.workspace_id, c.params.id, table.name);
  publish(table.workspace_id, 'comment.added', { recordId: c.params.id });
  return { id };
});
route('DELETE', '/api/comments/:id', (c) => {
  const cm = q.get<{ record_id: string; user_id: string }>('SELECT record_id, user_id FROM comments WHERE id=?', c.params.id);
  if (!cm) throw notFound('Comment not found');
  const { table } = requireRecord(c.user!.id, cm.record_id);
  if (cm.user_id !== c.user!.id && tableLevel(c.user!.id, table) !== 'admin') throw forbidden('You can only delete your own comments');
  q.run('DELETE FROM comments WHERE id=?', c.params.id);
  return { ok: true };
});

// ---------------- links with evidence ----------------
route('PATCH', '/api/links/evidence', (c) => {
  // edit the evidence class/notes of one link (only user-supplied evidence may be edited freely)
  const fieldId = str(c.body.fieldId, 'fieldId'), a = str(c.body.recordId, 'recordId'), b = str(c.body.targetId, 'targetId');
  const { table } = requireRecord(c.user!.id, a, 'editor');
  const f = listFields(table.id).find((x) => x.id === fieldId && x.type === 'relation');
  if (!f) throw bad('Not a link field');
  const inv = f.options.inverseFieldId ?? '';
  const row = q.get<{ id: number; meta: string | null }>('SELECT id, meta FROM links WHERE (field_id=? AND from_id=? AND to_id=?) OR (field_id=? AND from_id=? AND to_id=?)', f.id, a, b, inv, b, a);
  if (!row) throw notFound('Link not found');
  const cur = safeJson<any>(row.meta, {});
  if (cur.evidenceClass && cur.evidenceClass !== 'user_supplied' && cur.evidenceClass !== 'unverified') throw forbidden('Evidence from a scientific database cannot be edited. Remove the link or add your own note.');
  const next = { ...cur, evidenceClass: ['user_supplied', 'unverified'].includes(c.body.evidenceClass) ? c.body.evidenceClass : cur.evidenceClass ?? 'user_supplied', relationType: typeof c.body.relationType === 'string' ? c.body.relationType.slice(0, 80) : cur.relationType, evidence: typeof c.body.evidence === 'string' ? c.body.evidence.slice(0, 1000) : cur.evidence, referenceUrl: typeof c.body.referenceUrl === 'string' && /^https?:\/\//.test(c.body.referenceUrl) ? c.body.referenceUrl : cur.referenceUrl };
  q.run('UPDATE links SET meta=? WHERE id=?', JSON.stringify(next), row.id);
  bumpTable(table.id);
  publish(table.workspace_id, 'record.changed', { tableId: table.id, ids: [a, b], op: 'updated' });
  return { ok: true };
});

// ---------------- search ----------------
route('GET', '/api/workspaces/:id/search', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  const text = (c.query.get('q') ?? '').slice(0, 200);
  const t0 = performance.now();
  const hits = globalSearch(c.user!.id, c.params.id, text, 25);
  return { hits, tookMs: Math.round(performance.now() - t0) };
});

// ---------------- provenance ----------------
route('GET', '/api/records/:id/provenance', (c) => { requireRecord(c.user!.id, c.params.id); return { provenance: listProvenance(c.params.id) }; });

// ---------------- export ----------------
route('POST', '/api/tables/:id/export', async (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  const spec = specFromBody(c.body);
  const f = await exportRecords({ workspaceId: t.workspace_id, tableId: t.id, recordIds: spec.ids, spec: { ...spec, ids: undefined }, format: c.body.format === 'json' ? 'json' : 'csv', userId: c.user!.id });
  auditCtx(c, t.workspace_id, 'export', 'table', t.id, { rows: f.rows, format: c.body.format });
  c.res.writeHead(200, {
    'Content-Type': c.body.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store', 'X-Rows': String(f.rows),
  });
  c.res.end(f.text);
});

// ---------------- duplicates (chemicals) ----------------
route('GET', '/api/tables/:id/duplicates', (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  if (t.kind !== 'chemical') throw bad('Duplicate detection is available for chemical tables');
  flagDuplicates(t.id); // keep the "Possible duplicate" checkbox in step with what the panel shows
  return { groups: findDuplicateChemicals(t.id) };
});
route('POST', '/api/tables/:id/merge', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'editor');
  if (t.kind !== 'chemical') throw bad('Merging is available for chemical tables');
  const keep = str(c.body.keepId, 'keepId');
  const drop: string[] = (Array.isArray(c.body.dropIds) ? c.body.dropIds : []).map(String);
  if (!drop.length || drop.includes(keep)) throw bad('Choose the record to keep and at least one different record to merge into it');
  const r = mergeChemicals(t.id, keep, drop, c.user!.id);
  bumpTable(t.id); clearQueryCache(); reindexTable(t.id); flagDuplicates(t.id);
  publish(t.workspace_id, 'record.changed', { tableId: t.id, ids: [keep, ...drop], op: 'updated' });
  auditCtx(c, t.workspace_id, 'record.merge', 'table', t.id, { keep, dropped: drop.length });
  return r;
});

// ---------------- attachments ----------------
const ALLOWED: Record<string, { mime: string; magic?: (b: Buffer) => boolean; text?: boolean }> = {
  png: { mime: 'image/png', magic: (b) => b.subarray(0, 4).toString('hex') === '89504e47' }, jpg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 }, jpeg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  gif: { mime: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' }, webp: { mime: 'image/webp', magic: (b) => b.subarray(8, 12).toString('latin1') === 'WEBP' }, pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  zip: { mime: 'application/zip', magic: (b) => b[0] === 0x50 && b[1] === 0x4b }, xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: (b) => b[0] === 0x50 && b[1] === 0x4b }, docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  ab1: { mime: 'application/octet-stream', magic: (b) => b.subarray(0, 4).toString('latin1') === 'ABIF' }, abi: { mime: 'application/octet-stream', magic: (b) => b.subarray(0, 4).toString('latin1') === 'ABIF' },
  gz: { mime: 'application/gzip', magic: (b) => b[0] === 0x1f && b[1] === 0x8b },
  txt: { mime: 'text/plain', text: true }, csv: { mime: 'text/csv', text: true }, tsv: { mime: 'text/tab-separated-values', text: true }, json: { mime: 'application/json', text: true }, md: { mime: 'text/plain', text: true },
  fasta: { mime: 'text/plain', text: true }, fa: { mime: 'text/plain', text: true }, fna: { mime: 'text/plain', text: true }, faa: { mime: 'text/plain', text: true }, fastq: { mime: 'text/plain', text: true },
  gb: { mime: 'text/plain', text: true }, gbk: { mime: 'text/plain', text: true }, pdb: { mime: 'text/plain', text: true }, cif: { mime: 'text/plain', text: true }, sdf: { mime: 'text/plain', text: true }, mol2: { mime: 'text/plain', text: true }, newick: { mime: 'text/plain', text: true }, nwk: { mime: 'text/plain', text: true },
};

/** Validates an upload: extension allow-list + content sniffing (declared type must match the bytes). Rejects HTML/SVG/scripts/executables. */
export function validateUpload(name: string, buf: Buffer): { mime: string; name: string } {
  const clean = name.replace(/[\\/\0]/g, '_').replace(/[^\w.\- ()+]/g, '_').slice(-120) || 'file';
  const ext = (clean.split('.').pop() ?? '').toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) throw bad(`Files of type ".${ext}" are not allowed. Allowed: ${Object.keys(ALLOWED).join(', ')}`);
  if (!buf.length) throw bad('The file is empty');
  if (rule.magic && !rule.magic(buf)) throw bad(`The file content does not match a .${ext} file`);
  if (rule.text) {
    if (buf.includes(0)) throw bad(`.${ext} files must be plain text`);
    const head = buf.subarray(0, 2048).toString('utf8').trimStart().toLowerCase();
    if (/^<(!doctype|html|script|svg|\?xml)/.test(head) || head.includes('<script')) throw bad('Markup and scripts are not allowed in uploads');
  }
  return { mime: rule.mime, name: clean };
}

route('POST', '/api/workspaces/:id/files', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'editor');
  const buf = c.raw ?? Buffer.alloc(0);
  if (buf.length > config.maxUploadBytes) throw new (class extends Error { status = 413; code = 'too_large' })('File too large') as never;
  const { mime, name } = validateUpload(c.query.get('name') ?? 'file', buf);
  const id = uid('fil');
  writeFileSync(join(config.filesDir, id), buf);
  q.run('INSERT INTO files(id,workspace_id,record_id,field_id,name,size,mime,sha256,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', id, c.params.id, null, null, name, buf.length, mime, sha256(buf), now(), c.user!.id);
  auditCtx(c, c.params.id, 'file.upload', 'file', id, { name, size: buf.length });
  return { file: { id, name, size: buf.length, type: mime } };
}, { raw: true });

route('GET', '/api/files/:id', (c) => {
  const f = q.get<{ id: string; workspace_id: string; name: string; mime: string; size: number }>('SELECT id, workspace_id, name, mime, size FROM files WHERE id=?', c.params.id);
  if (!f) throw notFound('File not found');
  requireWorkspace(c.user!.id, f.workspace_id);
  const p = join(config.filesDir, f.id);
  if (!existsSync(p)) throw notFound('File data missing');
  c.res.writeHead(200, {
    'Content-Type': f.mime, 'Content-Length': f.size, 'Content-Disposition': `attachment; filename="${f.name.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=3600',
  });
  createReadStream(p).pipe(c.res);
});

void hydrateRows; void readableRecord; void listViews; void toRaw;
