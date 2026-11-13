// Sequence Lab API: import → inspect → clean → BLAST → relatives → outgroups → align → tree → identify, plus history and exports.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { route, str, oneOf, int, rateLimit } from '../http.ts';
import { q } from '../db.ts';
import { bad, notFound } from '../util.ts';
import { config } from '../config.ts';
import { atLeast, requireProject, requireRecord, tableLevel, visibleTableIds } from '../access.ts';
import { fieldByKey } from '../schema.ts';
import { enqueue } from '../jobs.ts';
import { getRaw } from '../records.ts';
import { parseAb1, parseFastq, parseSequenceText, sniff } from '../seqlab/formats.ts';
import type { ParsedRead } from '../seqlab/formats.ts';
import { CLEAN_OPS, adoptRecord, applyClean, getOp, getVersion, importRead, latestOp, listOps, listVersions, redo, revertTo, setMeta, stateOf, undo } from '../seqlab/store.ts';
import { ambiguitySuggestions, addAccession, linkIdentification, pairwiseWith, chromatogramSlice, compareRaw, editAlignment, identification, identify, inspect, previewNcbiRecord } from '../seqlab/actions.ts';
import { currentDataset, editDataset, recordName } from '../seqlab/dataset.ts';
import type { DatasetEdit } from '../seqlab/dataset.ts';
import { RANKING_EXPLANATION, rankHits } from '../seqlab/pipeline.ts';
import type { HitFilter, LabHit } from '../seqlab/pipeline.ts';
import { buildScript, changeLogMarkdown } from '../seqlab/exports.ts';
import { DEFAULT_PARAMS } from '../phylo/run.ts';
import { detectAligners } from '../seqlab/external.ts';
import { buildReport } from '../seqlab/report.ts';
import { mergePair } from '../seqlab/pair.ts';
import { mergeReverse } from '../seqlab/merge.ts';

const sendText = (c: any, name: string, mime: string, text: string) => {
  c.res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  c.res.end(text);
};
const sendBin = (c: any, name: string, mime: string, data: Buffer) => {
  c.res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  c.res.end(data);
};
const rec = (c: any, need: 'viewer' | 'editor' = 'viewer') => {
  const r = requireRecord(c.user!.id, c.params.id, need);
  if (!['dna', 'rna'].includes(r.table.kind)) throw bad('The Sequence Lab works on DNA/RNA sequence records.');
  return r;
};
const withState = (c: any, need: 'viewer' | 'editor' = 'viewer') => {
  const r = rec(c, need);
  if (!stateOf(c.params.id)) { if (need === 'editor') adoptRecord(c.params.id, c.user!.id); else throw bad('This record has not entered the Sequence Lab yet. Open it as an editor to start.'); }
  return r;
};
const job = (c: any, type: string, name: string, payload: Record<string, unknown>) => {
  rateLimit(`lab-job:${c.user!.id}`, 40, 60_000); // each job may call NCBI; keep a runaway client from hammering it
  const { table } = withState(c, 'editor');
  return enqueue({ workspaceId: table.workspace_id, projectId: table.project_id, type, name, payload: { recordId: c.params.id, ...payload }, userId: c.user!.id, dedupeKey: `${type}:${c.params.id}` });
};

// ---------------------------------------------------------------- import
route('POST', '/api/lab/import', (c) => {
  const p = requireProject(c.user!.id, str(c.body.projectId, 'projectId'), 'editor');
  const o = { workspaceId: p.workspace_id, projectId: p.id, userId: c.user!.id, sampleId: c.body.sampleId ? String(c.body.sampleId).slice(0, 100) : undefined, marker: c.body.marker ? String(c.body.marker).slice(0, 100) : undefined, organism: c.body.organism ? String(c.body.organism).slice(0, 200) : undefined };
  let reads: ParsedRead[] = []; let fileName = c.body.fileName ? String(c.body.fileName).slice(0, 200) : undefined; let fileId: string | undefined;
  if (c.body.fileId) {
    const f = q.get<{ id: string; workspace_id: string; name: string }>('SELECT id, workspace_id, name FROM files WHERE id=?', String(c.body.fileId));
    if (!f || f.workspace_id !== p.workspace_id) throw notFound('Uploaded file not found');
    const buf = readFileSync(join(config.filesDir, f.id)); fileName = f.name; fileId = f.id;
    const kind = sniff(f.name, buf.subarray(0, 4096));
    try {
      if (kind === 'ab1') reads = [parseAb1ToRead(buf, f.name)];
      else if (kind === 'fastq') reads = parseFastq(buf.toString('utf8'));
      else reads = parseSequenceText(buf.toString('utf8'), f.name);
    } catch (e) { throw bad(`${f.name}: ${(e as Error).message}`); }
  } else {
    try { reads = parseSequenceText(str(c.body.text, 'Sequence', { max: 20_000_000 }), 'pasted sequence'); } catch (e) { throw bad((e as Error).message); }
  }
  if (!reads.length) throw bad('No sequence found in the input.');
  const capped = reads.slice(0, 200);
  const ids = capped.map((r) => {
    const id = importRead({ ...o, fileName, fileId, readsInFile: reads.length }, r);
    if (r.source === 'ab1' && fileId) setMeta(id, { fileId, fileName });
    return id;
  });
  return { recordIds: ids, imported: ids.length, skipped: reads.length - capped.length, warnings: capped.flatMap((r) => r.warnings).slice(0, 20), note: reads.length > 200 ? `Only the first 200 of ${reads.length} reads were imported.` : undefined };
});
function parseAb1ToRead(buf: Buffer, name: string): ParsedRead {
  const c = parseAb1(buf);
  return { id: (c.meta.sample || name.replace(/\.[^.]+$/, '')).slice(0, 100), description: `AB1 ${c.meta.model ?? ''}`.trim(), seq: c.seq, qual: c.qual.length ? c.qual : null, source: 'ab1', warnings: c.qual.length ? [] : ['This AB1 file has no quality values.'] };
}

/** DNA/RNA records of the project's tables (whether or not they are in the lab yet): the picker for "open an existing record" and "merge two reads". */
route('GET', '/api/lab/dna-records', (c) => {
  const project = c.query.get('project');
  const proj = project ? requireProject(c.user!.id, project, 'viewer') : null;
  const ws = proj?.workspace_id ?? c.query.get('workspace');
  if (!ws) throw bad('project or workspace is required');
  const visible = new Set(visibleTableIds(c.user!.id, ws));
  const tables = q.all<{ id: string; kind: string; name: string }>("SELECT id, kind, name FROM tables WHERE workspace_id=? AND kind IN ('dna','rna')" + (proj ? ' AND project_id=?' : ''), ...(proj ? [ws, proj.id] : [ws])).filter((t) => visible.has(t.id));
  const out: any[] = [];
  for (const t of tables) {
    const nf = fieldByKey(t.id, 'name'), sf = fieldByKey(t.id, 'sequence');
    for (const r of q.all<any>('SELECT r.id, r.data, r.updated_at, (SELECT length(seq) FROM seq_versions v WHERE v.id=s.head) len, s.meta FROM records r LEFT JOIN seq_state s ON s.record_id=r.id WHERE r.table_id=? ORDER BY r.updated_at DESC LIMIT 300', t.id)) {
      let d: any = {}; try { d = JSON.parse(r.data); } catch { /* keep */ }
      const seq = sf ? String(d[sf.id] ?? '') : ''; if (!seq && r.len === null) continue;
      let meta: any = {}; try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* none */ }
      out.push({ id: r.id, name: String((nf ? d[nf.id] : '') || r.id), length: r.len ?? seq.length, inLab: r.len !== null, table: t.name, merged: meta.source === 'merged', mergedInto: Array.isArray(meta.mergedInto) && meta.mergedInto.length > 0, updatedAt: r.updated_at });
    }
  }
  return { records: out.slice(0, 300) };
});
/**
 * Combine a forward and a reverse read into ONE new record ("Merged: <forward> (id) + <reverse> (id)" unless you name it).
 * Both source records stay unchanged in the DNA table and get a history entry pointing at the merged record.
 * Reverse read: an existing record (reverseRecordId) or pasted text (reverseText).
 */
route('POST', '/api/lab/merge-pair', (c) => {
  const dna = (id: string, need: 'viewer' | 'editor') => { const r = requireRecord(c.user!.id, id, need); if (!['dna', 'rna'].includes(r.table.kind)) throw bad('Only DNA/RNA records can be merged.'); return r; };
  const fid = str(c.body.forwardRecordId, 'forwardRecordId');
  const f = dna(fid, 'editor');
  let rid = c.body.reverseRecordId ? String(c.body.reverseRecordId) : '';
  if (rid) { dna(rid, 'editor'); } else {
    let reads: ParsedRead[] = [];
    try { reads = parseSequenceText(str(c.body.reverseText, 'Reverse read', { max: 2_000_000 }), 'pasted reverse read'); } catch (e) { throw bad((e as Error).message); }
    if (!reads.length) throw bad('No sequence found in the reverse read input.');
    // try the merge in memory first: a pasted read that cannot be merged must not leave a stray record behind
    if (!stateOf(fid)) adoptRecord(fid, c.user!.id);
    const fs = stateOf(fid)!;
    try { mergeReverse({ seq: fs.head.seq, qual: fs.head.qual, map: null, marks: [] }, { reverseSeq: reads[0].seq, reverseQual: reads[0].qual, orientation: oneOf(c.body.orientation ?? 'auto', ['auto', 'as_is', 'reverse_complement'] as const, 'orientation') }); } catch (e) { throw bad((e as Error).message); }
    rid = importRead({ workspaceId: f.table.workspace_id, projectId: f.table.project_id, userId: c.user!.id, readsInFile: reads.length }, { ...reads[0], id: String(c.body.reverseName ?? '').trim().slice(0, 100) || `${recordName(fid)}_reverse` });
  }
  for (const x of [fid, rid]) if (!stateOf(x)) adoptRecord(x, c.user!.id);
  const orientation = oneOf(c.body.orientation ?? 'auto', ['auto', 'as_is', 'reverse_complement'] as const, 'orientation');
  const r = mergePair({ workspaceId: f.table.workspace_id, projectId: f.table.project_id, userId: c.user!.id }, fid, rid, { orientation, name: c.body.name ? String(c.body.name).slice(0, 200) : undefined, minOverlap: c.body.minOverlap === undefined ? undefined : Number(c.body.minOverlap), minIdentity: c.body.minIdentity === undefined ? undefined : Number(c.body.minIdentity) });
  return { ...r, name: recordName(r.recordId) };
});

route('GET', '/api/lab', (c) => {
  const project = c.query.get('project');
  const proj = project ? requireProject(c.user!.id, project, 'viewer') : null;
  const ws = proj?.workspace_id ?? c.query.get('workspace');
  if (!ws) throw bad('project or workspace is required');
  const visible = new Set(visibleTableIds(c.user!.id, ws));
  const tables = q.all<{ id: string }>("SELECT id FROM tables WHERE workspace_id=? AND kind IN ('dna','rna')" + (proj ? ' AND project_id=?' : ''), ...(proj ? [ws, proj.id] : [ws])).filter((t) => visible.has(t.id));
  const out: any[] = [];
  for (const t of tables) {
    const nf = fieldByKey(t.id, 'name');
    for (const r of q.all<any>('SELECT s.record_id id, s.meta, r.data, r.updated_at, (SELECT length(seq) FROM seq_versions v WHERE v.id=s.head) len FROM seq_state s JOIN records r ON r.id=s.record_id WHERE r.table_id=? ORDER BY r.updated_at DESC LIMIT 100', t.id)) {
      let name = r.id; try { name = String(JSON.parse(r.data)[nf?.id ?? ''] ?? r.id); } catch { /* keep id */ }
      let source = ''; try { source = JSON.parse(r.meta).source ?? ''; } catch { /* none */ }
      let meta: any = {}; try { meta = JSON.parse(r.meta); } catch { /* none */ }
      const mergedFrom = meta.source === 'merged' && meta.forwardRecordId && meta.reverseRecordId ? { forward: { id: meta.forwardRecordId, name: recordName(meta.forwardRecordId) }, reverse: { id: meta.reverseRecordId, name: recordName(meta.reverseRecordId) } } : null;
      const mergedInto = Array.isArray(meta.mergedInto) && meta.mergedInto.length ? meta.mergedInto.map((x: string) => ({ id: x, name: recordName(x) })) : null;
      out.push({ id: r.id, name, length: r.len, source: mergedFrom ? 'merged forward + reverse' : source, updatedAt: r.updated_at, mergedFrom, mergedInto });
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { records: out.slice(0, 100) };
});
route('POST', '/api/lab/:id/adopt', (c) => { rec(c, 'editor'); adoptRecord(c.params.id, c.user!.id); return { ok: true }; });

// ---------------------------------------------------------------- overview & history
route('GET', '/api/lab/:id', (c) => {
  const { table } = rec(c);
  let st = stateOf(c.params.id);
  if (!st) {
    try { requireRecord(c.user!.id, c.params.id, 'editor'); adoptRecord(c.params.id, c.user!.id); st = stateOf(c.params.id); } catch { return { adoptable: true, name: recordName(c.params.id) }; }
  }
  if (!st) return { adoptable: true, name: recordName(c.params.id) };
  const steps = ['import', 'clean', 'blast', 'dataset', 'relatives', 'outgroups', 'align', 'align_edit', 'tree', 'identify'];
  const done: Record<string, { opId: string; status: string; at: string } | null> = {};
  for (const s of steps) { const o = q.get<{ id: string; status: string; created_at: string }>('SELECT id, status, created_at FROM seq_ops WHERE record_id=? AND step=? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.params.id, s); done[s] = o ? { opId: o.id, status: o.status, at: o.created_at } : null; }
  const r = getRaw(c.params.id);
  return {
    recordId: c.params.id, tableId: table.id, name: recordName(c.params.id), updatedAt: r?.updatedAt, meta: st.meta,
    links: { mergedFrom: st.meta.source === 'merged' ? { forward: { id: st.meta.forwardRecordId, name: recordName(st.meta.forwardRecordId) }, reverse: { id: st.meta.reverseRecordId, name: recordName(st.meta.reverseRecordId) } } : null, mergedInto: (Array.isArray(st.meta.mergedInto) ? st.meta.mergedInto : []).map((x: string) => ({ id: x, name: recordName(x) })) }, canEdit: atLeast(tableLevel(c.user!.id, table), 'editor'),
    raw: { length: st.raw.seq.length, hasQuality: !!st.raw.qual }, head: { id: st.head.id, n: st.head.n, length: st.head.seq.length, seq: st.head.seq, qual: st.head.qual, marks: st.head.marks, label: st.head.label },
    canUndo: !!st.head.parentId, canRedo: st.redo.length > 0, redoCount: st.redo.length, versions: listVersions(c.params.id), steps: done,
    dataset: (() => { const d = currentDataset(c.params.id); return d ? { opId: d.op.id, members: d.dataset.members.length, outgroups: d.dataset.members.filter((m) => m.role === 'outgroup').length } : null; })(),
  };
});
route('GET', '/api/lab/:id/versions', (c) => { withState(c); return { versions: listVersions(c.params.id), head: stateOf(c.params.id)!.head.id }; });
route('GET', '/api/lab/:id/versions/:vid', (c) => { withState(c); const v = q.get<any>('SELECT * FROM seq_versions WHERE id=? AND record_id=?', c.params.vid, c.params.id); if (!v) throw notFound('Version not found'); return { id: v.id, n: v.n, label: v.label, kind: v.kind, seq: v.seq, createdAt: v.created_at }; });
route('GET', '/api/lab/:id/ops', (c) => { withState(c); return { ops: listOps(c.params.id, { step: c.query.get('step') ?? undefined }) }; });
route('GET', '/api/lab/:id/ops/:opId', (c) => { withState(c); const o = getOp(c.params.opId); if (!o || o.recordId !== c.params.id) throw notFound('Operation not found'); return { op: o }; });

// ---------------------------------------------------------------- inspect / chromatogram / compare
route('GET', '/api/lab/:id/inspect', (c) => { withState(c); return inspect(c.params.id); });
route('GET', '/api/lab/:id/chromatogram', (c) => { withState(c); return chromatogramSlice(c.params.id, int(c.query.get('from'), 'from', 1, 1), int(c.query.get('to'), 'to', 120, 1)); });
route('GET', '/api/lab/:id/ambiguity', (c) => { withState(c); return ambiguitySuggestions(c.params.id, Number(c.query.get('minRatio') ?? 0.4)); });
route('GET', '/api/lab/:id/compare', (c) => { withState(c); return compareRaw(c.params.id); });

// ---------------------------------------------------------------- cleaning
route('GET', '/api/lab-meta/clean-ops', () => ({ ops: Object.entries(CLEAN_OPS).map(([id, v]) => ({ id, name: v.name })) }));
route('POST', '/api/lab/:id/clean', (c) => {
  withState(c, 'editor');
  const op = str(c.body.op, 'op');
  const r = applyClean(c.params.id, c.user!.id, { ...c.body, op });
  return { unchanged: r.unchanged, summary: r.summary, version: r.version.n, warnings: 'warnings' in r ? r.warnings : [] };
});
/**
 * Merge the REVERSE read of the same amplicon into this (forward) record. The reverse read is itself stored as a Sequence Lab record
 * (immutable raw + history) when pasted, so the merge is traceable to both inputs. Result = a new version of this record; undo restores the forward-only sequence.
 */
route('POST', '/api/lab/:id/merge-reverse', (c) => {
  const { table } = withState(c, 'editor');
  let revId = c.body.reverseRecordId ? String(c.body.reverseRecordId) : '';
  if (revId) {
    if (revId === c.params.id) throw bad('Choose a different record for the reverse read.');
    rec({ ...c, params: { id: revId } }, 'viewer'); // must be a DNA record the user can read
    if (!stateOf(revId)) adoptRecord(revId, c.user!.id);
  } else {
    let reads: ParsedRead[] = [];
    try { reads = parseSequenceText(str(c.body.text, 'Reverse read', { max: 2_000_000 }), 'pasted reverse read'); } catch (e) { throw bad((e as Error).message); }
    if (!reads.length) throw bad('No sequence found in the reverse read input.');
    const fwdName = recordName(c.params.id);
    revId = importRead({ workspaceId: table.workspace_id, projectId: table.project_id, userId: c.user!.id, marker: stateOf(c.params.id)?.meta?.marker, sampleId: undefined, fileName: undefined, readsInFile: reads.length }, { ...reads[0], id: String(c.body.name ?? '').trim().slice(0, 100) || `${fwdName}_reverse` });
  }
  const rv = stateOf(revId)!;
  const orientation = oneOf(c.body.orientation ?? 'auto', ['auto', 'as_is', 'reverse_complement'] as const, 'orientation');
  const revSeq = rv.raw.seq.toUpperCase().replace(/U/g, 'T').replace(/[^ACGTRYSWKMBDHVN]/g, '');
  const r = applyClean(c.params.id, c.user!.id, { op: 'merge_reverse', reverseRecordId: revId, reverseSeq: revSeq, reverseQual: rv.raw.qual && rv.raw.qual.length === revSeq.length ? rv.raw.qual : null, orientation, minOverlap: c.body.minOverlap === undefined ? undefined : Number(c.body.minOverlap), minIdentity: c.body.minIdentity === undefined ? undefined : Number(c.body.minIdentity) });
  return { unchanged: r.unchanged, summary: r.summary, version: r.version.n, warnings: 'warnings' in r ? r.warnings : [], reverseRecordId: revId };
});
route('POST', '/api/lab/:id/undo', (c) => { withState(c, 'editor'); undo(c.params.id, c.user!.id); return { ok: true }; });
route('POST', '/api/lab/:id/redo', (c) => { withState(c, 'editor'); redo(c.params.id, c.user!.id); return { ok: true }; });
route('POST', '/api/lab/:id/revert', (c) => { withState(c, 'editor'); revertTo(c.params.id, str(c.body.versionId, 'versionId'), c.user!.id); return { ok: true }; });

// ---------------------------------------------------------------- BLAST
route('POST', '/api/lab/:id/blast', (c) => {
  const p = c.body.params ?? {};
  const params = {
    db: oneOf(p.db ?? 'core_nt', ['core_nt', 'nt', 'refseq_rna'] as const, 'db'),
    program: oneOf(p.program ?? 'megablast', ['megablast', 'blastn'] as const, 'program'), hitlist: int(p.hitlist, 'hitlist', 50, 5, 200), expect: Number(p.expect ?? 0.05),
    entrez: p.entrez ? String(p.entrez).slice(0, 300) : undefined,
  };
  if (!(params.expect > 0 && params.expect <= 1000)) throw bad('E-value threshold must be between 0 and 1000');
  return { jobId: job(c, 'seq.blast', 'NCBI BLAST', { params }) };
});
route('GET', '/api/lab/:id/hits', (c) => {
  withState(c);
  const opId = c.query.get('op'); const op = opId ? getOp(opId) : latestOp(c.params.id, 'blast');
  if (!op || !op.result?.hits) return { op: null, hits: [], total: 0 };
  const f: HitFilter = {
    minIdentity: c.query.get('minIdentity') ? Number(c.query.get('minIdentity')) : undefined, minCoverage: c.query.get('minCoverage') ? Number(c.query.get('minCoverage')) : undefined, maxEvalue: c.query.get('maxEvalue') ? Number(c.query.get('maxEvalue')) : undefined,
    text: c.query.get('text') ?? undefined, excludeEnvironmental: c.query.get('excludeEnvironmental') === '1', onePerSpecies: c.query.get('onePerSpecies') === '1', sort: (c.query.get('sort') as HitFilter['sort']) ?? 'bitScore', limit: c.query.get('limit') ? Number(c.query.get('limit')) : undefined,
  };
  const all: LabHit[] = op.result.hits, ranked = rankHits(all, f);
  const qv = op.inputRef ? getVersion(op.inputRef) : undefined;
  return { query: { name: recordName(c.params.id), version: qv?.n ?? null, length: op.result.queryLength }, op: { id: op.id, params: op.params, createdAt: op.createdAt, dbRetrievedAt: op.dbRetrievedAt, rid: op.result.rid, queryLength: op.result.queryLength, summary: op.result.summary, status: op.status }, total: all.length, shown: ranked.length, hits: ranked, ranking: RANKING_EXPLANATION[f.sort ?? 'bitScore'] };
});

// ---------------------------------------------------------------- dataset (relatives / outgroups)
route('POST', '/api/lab/:id/relatives', (c) => {
  const p = c.body.params ?? {};
  return { jobId: job(c, 'seq.relatives', 'Retrieve close relatives', { params: { maxRelatives: int(p.maxRelatives, 'maxRelatives', 10, 1, 30), minCoverage: Number(p.minCoverage ?? 80), minIdentity: Number(p.minIdentity ?? 70), maxPerGenus: int(p.maxPerGenus, 'maxPerGenus', 4, 1, 30), excludeEnvironmental: p.excludeEnvironmental !== false, blastOpId: p.blastOpId, only: Array.isArray(p.only) ? p.only.map(String).slice(0, 30) : undefined, broaden: p.broaden === true, broadenMax: int(p.broadenMax, 'broadenMax', 5, 1, 10) } }) };
});
route('POST', '/api/lab/:id/outgroups', (c) => { const p = c.body.params ?? {}; return { jobId: job(c, 'seq.outgroups', 'Outgroup assistant', { params: { max: int(p.max, 'max', 5, 1, 5), minCoverage: Number(p.minCoverage ?? 60), hitlist: 100 } }) }; });
/** Species typed by name (one per line or comma-separated) → NCBI Taxonomy → taxon-restricted BLAST of the query → homologous region of the best record. */
route('POST', '/api/lab/:id/species', (c) => {
  const raw = Array.isArray(c.body.names) ? c.body.names.map(String) : String(c.body.names ?? '').split(/[\n,;]+/);
  const names: string[] = [...new Set<string>(raw.map((n: string) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))];
  if (!names.length) throw bad('Type at least one species name.');
  if (names.length > 12) throw bad('Add at most 12 species per request (each needs its own NCBI search).');
  if (names.some((n) => n.length > 120)) throw bad('A species name is too long.');
  return { jobId: job(c, 'seq.add_species', `Add ${names.length} species by name`, { params: { names, role: oneOf(c.body.role ?? 'ingroup', ['ingroup', 'outgroup'] as const, 'role'), minCoverage: Number(c.body.minCoverage ?? 15) } }) };
});
route('GET', '/api/lab/:id/dataset', (c) => {
  withState(c);
  const d = currentDataset(c.params.id), og = latestOp(c.params.id, 'outgroups'), rel = latestOp(c.params.id, 'relatives');
  return {
    opId: d?.op.id ?? null, createdAt: d?.op.createdAt ?? null, members: (d?.dataset.members ?? []).map((m) => ({ ...m, seq: undefined, length: m.seq.length })), excluded: (d?.op.result as any)?.excluded ?? rel?.result?.excluded ?? [],
    outgroupAssistant: og ? { opId: og.id, status: og.status, createdAt: og.createdAt, scopes: og.result?.scopes ?? null, entrez: og.result?.entrez ?? null, rounds: og.result?.rounds ?? null, candidates: (og.result?.candidates ?? []).map((m: any) => ({ ...m, seq: undefined, length: m.seq.length })), excluded: og.result?.excluded ?? [], warnings: og.warnings } : null,
    species: (() => { const o = latestOp(c.params.id, 'species'); return o ? { opId: o.id, status: o.status, createdAt: o.createdAt, names: o.params?.names ?? [], notes: o.result?.notes ?? [], warnings: o.warnings, error: o.error } : null; })(),
    history: listOps(c.params.id, { step: 'dataset' }).map((o) => ({ id: o.id, name: o.name, at: o.createdAt, automatic: o.automatic })),
  };
});
route('POST', '/api/lab/:id/dataset', async (c) => {
  withState(c, 'editor');
  const action = oneOf(c.body.action, ['remove', 'set_role', 'add_candidates', 'add_accession', 'refresh_query'] as const, 'action');
  const ids = Array.isArray(c.body.ids) ? c.body.ids.map(String) : [];
  let opId: string;
  if (action === 'add_accession') opId = await addAccession(c.params.id, c.user!.id, str(c.body.accession, 'accession', { max: 40 }), oneOf(c.body.role ?? 'ingroup', ['ingroup', 'outgroup'] as const, 'role'));
  else {
    const edit: DatasetEdit = action === 'remove' ? { action, ids } : action === 'set_role' ? { action, ids, role: oneOf(c.body.role, ['ingroup', 'outgroup'] as const, 'role') } : action === 'add_candidates' ? { action, opId: str(c.body.opId, 'opId'), ids, role: oneOf(c.body.role ?? 'outgroup', ['ingroup', 'outgroup'] as const, 'role') } : { action };
    const names: Record<string, string> = { remove: 'Removed sequences from the dataset', set_role: 'Changed sequence roles', add_candidates: 'Accepted suggested sequences', refresh_query: 'Refreshed the query sequence' };
    opId = editDataset(c.params.id, c.user!.id, names[action], edit);
  }
  return { opId };
});

// ---------------------------------------------------------------- alignment
route('GET', '/api/lab-meta/aligners', async () => ({ engines: [{ id: 'builtin', name: 'Built-in (progressive / iterative)', available: true }, ...(await detectAligners()).map((a) => ({ id: a.id, name: a.name, available: true, version: a.version }))] }));
route('POST', '/api/lab/:id/align', (c) => {
  const p = c.body.params ?? {};
  const params = { engine: oneOf(p.engine ?? 'builtin', ['builtin', 'mafft', 'muscle', 'clustalo'] as const, 'engine'), method: oneOf(p.method ?? 'progressive', ['progressive', 'iterative'] as const, 'method'), matrix: oneOf(p.matrix ?? 'simple', ['simple', 'transition'] as const, 'matrix'), match: Number(p.match ?? 2), mismatch: Number(p.mismatch ?? -3), gapOpen: Number(p.gapOpen ?? 5), gapExtend: Number(p.gapExtend ?? 2), freeEndGaps: p.freeEndGaps !== false, maxIterations: int(p.maxIterations, 'maxIterations', 3, 1, 10), seqType: 'dna' as const };
  if (!(params.match > 0 && params.mismatch < 0 && params.gapOpen >= 0 && params.gapExtend >= 0)) throw bad('Use a positive match score, a negative mismatch score and non-negative gap penalties.');
  return { jobId: job(c, 'seq.align', 'Multiple alignment', { params }) };
});
route('GET', '/api/lab/:id/alignment', (c) => {
  withState(c);
  const a = latestOp(c.params.id, 'align'), e = latestOp(c.params.id, 'align_edit');
  const op = e && a && e.createdAt >= a.createdAt ? e : a;
  if (!op?.result?.rows) return { op: null };
  const r = op.result;
  return { op: { id: op.id, step: op.step, createdAt: op.createdAt, params: op.params, warnings: op.warnings, tool: op.tool }, labels: r.labels, rows: r.rows, length: r.length, method: r.method, spScore: r.spScore, iterations: r.iterations, roles: r.roles, manualEdits: r.manualEdits ?? 0, lastEdit: r.edit ?? null, guideTree: r.guideTree, stale: (() => { const d = currentDataset(c.params.id); return !!d && d.op.id !== r.datasetOp && op.step === 'align' && d.op.createdAt > op.createdAt; })() };
});
route('POST', '/api/lab/:id/pairwise', (c) => {
  withState(c, 'editor');
  const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return pairwiseWith(c.params.id, c.user!.id, str(c.body.memberId, 'memberId'), { mode: oneOf(c.body.mode ?? 'global', ['global', 'local'] as const, 'mode'), match: n(c.body.match), mismatch: n(c.body.mismatch), gapOpen: n(c.body.gapOpen), gapExtend: n(c.body.gapExtend) });
});
route('POST', '/api/lab/:id/align/edit', (c) => {
  withState(c, 'editor');
  const action = oneOf(c.body.action, ['insert_gap', 'delete_gap'] as const, 'action');
  return editAlignment(c.params.id, c.user!.id, { action, label: str(c.body.label, 'label'), col: int(c.body.col, 'col', 0, 0, 1_000_000), n: int(c.body.n, 'n', 1, 1, 50) });
});

// ---------------------------------------------------------------- tree
route('GET', '/api/lab-meta/tree-defaults', () => ({ defaults: DEFAULT_PARAMS }));
route('POST', '/api/lab/:id/tree', (c) => {
  const p = c.body.params ?? {};
  const gapMode = oneOf(p.gap?.mode ?? 'pairwise', ['pairwise', 'complete', 'partial'] as const, 'gap treatment');
  const params = {
    method: oneOf(p.method ?? 'nj', ['nj', 'upgma', 'me', 'mp', 'ml'] as const, 'method'), distance: oneOf(p.distance ?? 'k2p', ['p', 'jc69', 'k2p', 'tn93'] as const, 'distance model'), gamma: p.gamma ? Number(p.gamma) : null,
    mlModel: oneOf(p.mlModel ?? 'HKY85', ['JC69', 'K80', 'F81', 'HKY85'] as const, 'ML model'), mlGamma: p.mlGamma !== false,
    gap: gapMode === 'partial' ? { mode: 'partial' as const, cutoff: Math.max(0, Math.min(100, Number(p.gap?.cutoff ?? 5))) } : { mode: gapMode },
    bootstrap: int(p.bootstrap, 'bootstrap', 100, 0, 1000), seed: int(p.seed, 'seed', 12345, 0, 2_000_000_000), rooting: oneOf(p.rooting ?? 'outgroup', ['unrooted', 'midpoint', 'outgroup'] as const, 'rooting'),
    outgroups: Array.isArray(p.outgroups) ? p.outgroups.map(String) : [],
  };
  if (params.gamma !== null && !(params.gamma > 0.05 && params.gamma < 100)) throw bad('Gamma shape must be between 0.05 and 100');
  return { jobId: job(c, 'seq.tree', `Phylogenetic tree (${params.method.toUpperCase()})`, { params }) };
});
route('GET', '/api/lab/:id/tree', (c) => {
  withState(c);
  const op = c.query.get('op') ? getOp(c.query.get('op')!) : latestOp(c.params.id, 'tree');
  if (!op?.result?.newick) return { op: null };
  const r = op.result;
  return { op: { id: op.id, createdAt: op.createdAt, params: op.params, warnings: op.warnings, tool: op.tool }, result: r, history: listOps(c.params.id, { step: 'tree' }).map((o) => ({ id: o.id, name: o.name, at: o.createdAt, status: o.status })) };
});

// ---------------------------------------------------------------- identification and full NCBI record
route('GET', '/api/lab/:id/identification', (c) => { withState(c); return identification(c.params.id); });
route('POST', '/api/lab/:id/identification', async (c) => {
  withState(c, 'editor');
  const b = c.body, taxId = b.taxId ? Number(b.taxId) : null;
  if (taxId !== null && !(Number.isInteger(taxId) && taxId > 0)) throw bad('taxId must be a positive integer');
  const confidence = oneOf(b.confidence, ['high', 'moderate', 'low', 'inconclusive'] as const, 'confidence');
  const opId = identify(c.params.id, c.user!.id, { taxon: String(b.taxon ?? ''), rank: String(b.rank ?? 'species').slice(0, 40), taxId, confidence, notes: b.notes ? String(b.notes) : '' });
  let organism: { organismRecordId: string; linked: boolean } | null = null;
  if (b.linkOrganism === true) {
    if (!taxId || confidence === 'inconclusive') throw bad('Linking to an Organism record needs a taxon id and a non-inconclusive conclusion.');
    organism = await linkIdentification(c.params.id, c.user!.id, { taxId, name: String(b.taxon), rank: String(b.rank ?? 'species'), confidence, opId });
  }
  return { opId, organism };
});
route('GET', '/api/lab/:id/ncbi/preview', async (c) => { withState(c); return previewNcbiRecord(str(c.query.get('accession'), 'accession', { max: 40 })); });
route('POST', '/api/lab/:id/ncbi/save', (c) => ({ jobId: job(c, 'seq.save_reference', 'Fetch full NCBI record', { accession: str(c.body.accession, 'accession', { max: 40 }) }) }));

// ---------------------------------------------------------------- exports
route('GET', '/api/lab/:id/export/changelog', (c) => { withState(c); sendText(c, `${recordName(c.params.id).replace(/[^\w.-]+/g, '_')}_workflow_history.md`, 'text/markdown', changeLogMarkdown(c.params.id)); });
route('GET', '/api/lab/:id/export/changelog-preview', (c) => { withState(c); return { markdown: changeLogMarkdown(c.params.id) }; });
route('GET', '/api/lab/:id/export/script', (c) => {
  withState(c);
  const scope = oneOf(c.query.get('scope') ?? 'workflow', ['workflow', 'op'] as const, 'scope');
  const s = buildScript(c.params.id, { scope, opId: c.query.get('op') ?? undefined });
  if (c.query.get('download') === '1') { sendText(c, s.filename, 'text/x-python', s.code); return; }
  return s;
});
route('GET', '/api/lab/:id/export/fasta', (c) => {
  withState(c);
  const what = oneOf(c.query.get('what') ?? 'current', ['raw', 'current', 'alignment', 'dataset'] as const, 'what');
  const st = stateOf(c.params.id)!; const name = recordName(c.params.id).replace(/[^\w.-]+/g, '_');
  const wrap = (s: string) => s.match(/.{1,70}/g)?.join('\n') ?? '';
  let text = '';
  if (what === 'raw') text = `>${name}_raw\n${wrap(st.raw.seq)}\n`;
  else if (what === 'current') text = `>${name}_v${st.head.n}\n${wrap(st.head.seq)}\n`;
  else if (what === 'dataset') { const d = currentDataset(c.params.id); if (!d) throw bad('No dataset yet'); text = d.dataset.members.map((m) => `>${m.label}\n${wrap(m.role === 'query' ? st.head.seq : m.seq)}\n`).join(''); }
  else { const a = latestOp(c.params.id, 'align_edit') ?? latestOp(c.params.id, 'align'); if (!a?.result?.rows) throw bad('No alignment yet'); text = a.result.labels.map((l: string, i: number) => `>${l}\n${wrap(a.result.rows[i])}\n`).join(''); }
  sendText(c, `${name}_${what}.fasta`, 'text/plain', text);
});
route('GET', '/api/lab/:id/export/newick', (c) => { withState(c); const t = latestOp(c.params.id, 'tree'); if (!t?.result?.newick) throw bad('No tree yet'); sendText(c, `${recordName(c.params.id).replace(/[^\w.-]+/g, '_')}_tree.nwk`, 'text/plain', t.result.newick + '\n'); });
route('GET', '/api/lab/:id/export/history', (c) => { withState(c); sendText(c, `${recordName(c.params.id).replace(/[^\w.-]+/g, '_')}_history.json`, 'application/json', JSON.stringify({ versions: listVersions(c.params.id), operations: listOps(c.params.id, { withResult: true }) }, null, 2)); });

// PDF report (branded) and the tree as a vector image. Both are generated from the stored history only.
route('GET', '/api/lab/:id/export/report', (c) => {
  withState(c);
  const r = buildReport(c.params.id, { generatedFor: c.user!.name });
  sendBin(c, `${recordName(c.params.id).replace(/[^\w.-]+/g, '_')}_sequence_report.pdf`, 'application/pdf', r.pdf);
});
route('GET', '/api/lab/:id/export/tree-svg', (c) => {
  withState(c);
  const r = buildReport(c.params.id);
  if (!r.treeSvg) throw bad('No tree yet');
  sendText(c, `${recordName(c.params.id).replace(/[^\w.-]+/g, '_')}_tree.svg`, 'image/svg+xml', r.treeSvg);
});
void existsSync;
