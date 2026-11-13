// Persistence for the DNA Sequence Lab: immutable raw sequence, derived versions with undo/redo/revert, and the per-record operation log.
import { q, tx } from '../db.ts';
import { bad, now, safeJson, uid } from '../util.ts';
import { createRecord, getRaw, updateRecord } from '../records.ts';
import { createField, fieldByKey, listFields } from '../schema.ts';
import { tableOfKind, addProvenance } from '../ingest.ts';
import type { ParsedRead } from './formats.ts';
import * as C from './clean.ts';
import { initialMap } from './clean.ts';
import { mergeReverse } from './merge.ts';
import { PRECISIONS } from '../../shared/geo.ts';

export interface Version { id: string; recordId: string; n: number; parentId: string | null; kind: 'raw' | 'derived'; seq: string; qual: number[] | null; map: number[] | null; marks: C.Mark[]; opId: string | null; label: string | null; createdAt: string }
const toVersion = (r: any): Version => ({ id: r.id, recordId: r.record_id, n: r.n, parentId: r.parent_id, kind: r.kind, seq: r.seq, qual: safeJson(r.qual, null), map: safeJson(r.map, null), marks: safeJson(r.marks, []), opId: r.op_id, label: r.label, createdAt: r.created_at });

export interface Op {
  id: string; recordId: string; step: string; name: string; inputRef: string | null; outputRef: string | null; params: Record<string, any>; changes: unknown; result: any;
  tool: string | null; toolVersion: string | null; dbSource: string | null; dbRetrievedAt: string | null; actor: string | null; actorName?: string | null; automatic: boolean; status: string; warnings: string[]; error: string | null; jobId: string | null; supersedes: string | null; createdAt: string;
}
const toOp = (r: any): Op => ({ id: r.id, recordId: r.record_id, step: r.step, name: r.name, inputRef: r.input_ref, outputRef: r.output_ref, params: safeJson(r.params, {}), changes: safeJson(r.changes, null), result: safeJson(r.result, null), tool: r.tool, toolVersion: r.tool_version, dbSource: r.db_source, dbRetrievedAt: r.db_retrieved_at, actor: r.actor, actorName: r.actor_name ?? null, automatic: !!r.automatic, status: r.status, warnings: safeJson(r.warnings, []), error: r.error, jobId: r.job_id, supersedes: r.supersedes, createdAt: r.created_at });

export function logOp(recordId: string, o: Partial<Omit<Op, 'id' | 'recordId' | 'createdAt' | 'automatic' | 'warnings'>> & { step: string; name: string; automatic?: boolean; warnings?: string[]; id?: string }): string {
  const id = o.id ?? uid('sqo');
  // a re-run of the same step supersedes (does not overwrite) the previous result of that step
  const prev = o.supersedes ?? null;
  q.run(`INSERT INTO seq_ops(id,record_id,step,name,input_ref,output_ref,params,changes,result,tool,tool_version,db_source,db_retrieved_at,actor,automatic,status,warnings,error,job_id,supersedes,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, recordId, o.step, o.name, o.inputRef ?? null, o.outputRef ?? null, JSON.stringify(o.params ?? {}), o.changes === undefined ? null : JSON.stringify(o.changes), o.result === undefined ? null : JSON.stringify(o.result),
    o.tool ?? null, o.toolVersion ?? null, o.dbSource ?? null, o.dbRetrievedAt ?? null, o.actor ?? null, o.automatic === false ? 0 : 1, o.status ?? 'completed', JSON.stringify(o.warnings ?? []), o.error ?? null, o.jobId ?? null, prev, now());
  return id;
}
export function updateOp(id: string, patch: { result?: unknown; status?: string; error?: string | null; warnings?: string[]; outputRef?: string | null }) {
  const cur = q.get<any>('SELECT * FROM seq_ops WHERE id=?', id);
  if (!cur) return;
  q.run('UPDATE seq_ops SET result=?, status=?, error=?, warnings=?, output_ref=? WHERE id=?', patch.result === undefined ? cur.result : JSON.stringify(patch.result), patch.status ?? cur.status, patch.error === undefined ? cur.error : patch.error, patch.warnings ? JSON.stringify(patch.warnings) : cur.warnings, patch.outputRef === undefined ? cur.output_ref : patch.outputRef, id);
}
export const getOp = (id: string): Op | undefined => { const r = q.get<any>('SELECT o.*, u.name actor_name FROM seq_ops o LEFT JOIN users u ON u.id=o.actor WHERE o.id=?', id); return r ? toOp(r) : undefined; };
export function listOps(recordId: string, o: { step?: string; withResult?: boolean } = {}): Op[] {
  const rows = q.all<any>(`SELECT o.*, u.name actor_name FROM seq_ops o LEFT JOIN users u ON u.id=o.actor WHERE o.record_id=? ${o.step ? 'AND o.step=?' : ''} ORDER BY o.created_at, o.rowid`, ...(o.step ? [recordId, o.step] : [recordId]));
  return rows.map((r) => { const op = toOp(r); if (!o.withResult) op.result = op.result === null ? null : { _stored: true }; return op; });
}
/** Latest completed op of a step (with its full result). */
export function latestOp(recordId: string, step: string): Op | undefined {
  const r = q.get<any>("SELECT o.*, u.name actor_name FROM seq_ops o LEFT JOIN users u ON u.id=o.actor WHERE o.record_id=? AND o.step=? AND o.status='completed' ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1", recordId, step);
  return r ? toOp(r) : undefined;
}

// ---------------- versions ----------------
export const getVersion = (id: string): Version | undefined => { const r = q.get<any>('SELECT * FROM seq_versions WHERE id=?', id); return r ? toVersion(r) : undefined; };
export function stateOf(recordId: string) {
  const st = q.get<{ head: string; redo: string; meta: string }>('SELECT head, redo, meta FROM seq_state WHERE record_id=?', recordId);
  if (!st) return null;
  const head = getVersion(st.head)!;
  const raw = toVersion(q.get('SELECT * FROM seq_versions WHERE record_id=? AND kind=\'raw\'', recordId));
  return { head, raw, redo: safeJson<string[]>(st.redo, []), meta: safeJson<Record<string, any>>(st.meta, {}) };
}
export function listVersions(recordId: string) {
  return q.all<any>('SELECT id, n, parent_id, kind, label, length(seq) len, created_at, op_id FROM seq_versions WHERE record_id=? ORDER BY n', recordId)
    .map((r) => ({ id: r.id, n: r.n, parentId: r.parent_id, kind: r.kind as 'raw' | 'derived', label: r.label, length: r.len as number, createdAt: r.created_at, opId: r.op_id as string | null }));
}
function addVersion(recordId: string, parentId: string | null, kind: 'raw' | 'derived', st: C.SeqState, opId: string | null, label: string): Version {
  const n = (q.get<{ m: number | null }>('SELECT MAX(n) m FROM seq_versions WHERE record_id=?', recordId)?.m ?? 0) + 1;
  const id = uid('sqv');
  q.run('INSERT INTO seq_versions(id,record_id,n,parent_id,kind,seq,qual,map,marks,op_id,label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, recordId, n, parentId, kind, st.seq, st.qual ? JSON.stringify(st.qual) : null, st.map ? JSON.stringify(st.map) : null, JSON.stringify(st.marks), opId, label, now());
  return getVersion(id)!;
}

/** Keep the record's Sequence / Length fields equal to the working (head) sequence so grids, analyses and discovery use the cleaned data. */
function syncRecord(recordId: string, userId: string | null) {
  const rec = getRaw(recordId); const st = stateOf(recordId);
  if (!rec || !st) return;
  const sf = fieldByKey(rec.tableId, 'sequence'), lf = fieldByKey(rec.tableId, 'length');
  const patch: Record<string, unknown> = {};
  if (sf) patch[sf.id] = st.head.seq;
  if (lf) patch[lf.id] = st.head.seq.length;
  updateRecord(recordId, patch, { userId, origin: { jobId: 'seqlab', depth: 3 } });
}

const LAB_FIELDS: { name: string; key: string; type: 'text' | 'date' | 'number' | 'singleSelect'; options?: Record<string, unknown> }[] = [
  { name: 'Sample ID', key: 'sampleId', type: 'text' }, { name: 'Marker / gene', key: 'marker', type: 'text' }, { name: 'Read type', key: 'readType', type: 'text' },
  { name: 'Source file', key: 'fileSource', type: 'text' }, { name: 'Imported at', key: 'importedAt', type: 'date', options: { includeTime: true } },
  // where the sample was collected (drives the sample map); precision decides the pin colour: dark blue = specific, white = only the country is known
  { name: 'Collection location', key: 'location', type: 'text' }, { name: 'Latitude', key: 'lat', type: 'number', options: { precision: 6 } }, { name: 'Longitude', key: 'lon', type: 'number', options: { precision: 6 } },
  { name: 'Location precision', key: 'locPrecision', type: 'singleSelect', options: { choices: PRECISIONS.map((p, i) => ({ name: p.label, color: (['ink', 'blue', 'blue', 'blue', 'sky', 'sky', 'gray'] as const)[i] })) } },
  { name: 'Location source', key: 'locSource', type: 'text' },
];
/** Add the sequence-lab metadata columns to a DNA table that predates them. Idempotent. */
export function ensureLabFields(tableId: string) {
  for (const f of LAB_FIELDS) {
    if (fieldByKey(tableId, f.key)) continue;
    const clash = listFields(tableId).find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    if (clash) { q.run('UPDATE fields SET key=? WHERE id=?', f.key, clash.id); continue; }
    createField(tableId, { name: f.name, type: f.type, options: f.options, key: f.key }, { silent: true });
  }
  // the Organism table's lineage column becomes addressable by key (used when saving taxonomy)
  q.run("UPDATE fields SET key='lineage' WHERE key IS NULL AND name='Lineage' AND table_id IN (SELECT id FROM tables WHERE kind='organism' AND workspace_id=(SELECT workspace_id FROM tables WHERE id=?))", tableId);
}

export interface ImportOpts { workspaceId: string; projectId: string | null; userId: string | null; fileName?: string; fileId?: string; sampleId?: string; organism?: string; marker?: string; readsInFile?: number; chromatogramFile?: string }

/** Create a DNA record for one read plus its immutable raw version, and log the import. */
export function importRead(o: ImportOpts, read: ParsedRead): string {
  const tableId = tableOfKind({ workspaceId: o.workspaceId, projectId: o.projectId }, 'dna');
  ensureLabFields(tableId);
  const label = read.source === 'ab1' ? 'Sanger read (AB1)' : read.source === 'fastq' ? 'FASTQ read' : read.source === 'fasta' ? 'FASTA' : 'Pasted sequence';
  const values: Record<string, unknown> = { name: read.id, sequence: read.seq, length: read.seq.length, source: 'User upload', sampleId: o.sampleId ?? read.id, marker: o.marker, readType: label, fileSource: o.fileName ?? 'pasted text', importedAt: now() };
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) { const f = fieldByKey(tableId, k); if (f && v !== undefined && v !== '') input[f.id] = v; }
  let id = '';
  tx(() => {
    const rec = createRecord(tableId, input, { userId: o.userId, createChoices: true, origin: { jobId: 'seqlab', depth: 3 } });
    id = rec.id;
    const st: C.SeqState = { seq: read.seq, qual: read.qual, map: initialMap(read.seq.length), marks: [] };
    const opId = uid('sqo');
    const v = addVersion(id, null, 'raw', st, opId, 'Raw (as imported, immutable)');
    q.run('INSERT INTO seq_state(record_id, head, redo, meta) VALUES (?,?,?,?)', id, v.id, '[]', JSON.stringify({ source: read.source, fileName: o.fileName, fileId: o.fileId, organism: o.organism, readsInFile: o.readsInFile, description: read.description }));
    logOp(id, {
      id: opId, step: 'import', name: `Imported ${label}`, outputRef: v.id, params: { source: read.source, fileName: o.fileName ?? null, readId: read.id, length: read.seq.length, hasQuality: !!read.qual, readsInFile: o.readsInFile ?? 1, organism: o.organism ?? null, marker: o.marker ?? null },
      tool: 'VierStation importer', actor: o.userId, automatic: false, warnings: read.warnings,
    });
    addProvenance(id, { sourceDb: 'User upload', accession: read.id, query: o.fileName ?? 'pasted text', step: 'import', note: `${label}, ${read.seq.length} bp${read.qual ? ', with quality scores' : ''}` });
  });
  return id;
}

export interface CleanParams { op: string; [k: string]: any }
export const CLEAN_OPS: Record<string, { name: string; run: (s: C.SeqState, p: any) => C.CleanResult }> = {
  trim_window: { name: 'Trim low-quality ends (sliding window)', run: (s, p) => C.trimWindow(s, Number(p.threshold ?? 20), Number(p.window ?? 10), p.ends ?? 'both') },
  trim_mott: { name: 'Trim low-quality ends (modified Mott)', run: (s, p) => C.trimMott(s, Number(p.errorCutoff ?? 0.05)) },
  trim_ambiguous_ends: { name: 'Trim ambiguous ends', run: (s) => C.trimAmbiguousEnds(s) },
  trim_region: { name: 'Trim region', run: (s, p) => C.trimRegion(s, Number(p.from), Number(p.to), p.mode === 'remove' ? 'remove' : 'keep') },
  remove_bases: { name: 'Remove bases', run: (s, p) => C.removeBases(s, String(p.chars ?? '')) },
  edit_base: { name: 'Edit base', run: (s, p) => C.editBase(s, Number(p.pos), String(p.base)) },
  mask_low_quality: { name: 'Replace low-quality bases with N', run: (s, p) => C.maskLowQuality(s, Number(p.threshold ?? 20)) },
  mark_region: { name: 'Mark uncertain region', run: (s, p) => C.markRegion(s, Number(p.from), Number(p.to), String(p.note ?? '')) },
  reverse_complement: { name: 'Reverse-complement', run: (s) => C.reverseComplementOp(s) },
  merge_reverse: { name: 'Merge with reverse read', run: (s, p) => mergeReverse(s, { reverseSeq: String(p.reverseSeq ?? ''), reverseQual: Array.isArray(p.reverseQual) ? p.reverseQual : null, orientation: p.orientation ?? 'auto', minOverlap: p.minOverlap === undefined ? undefined : Number(p.minOverlap), minIdentity: p.minIdentity === undefined ? undefined : Number(p.minIdentity), qualityGap: p.qualityGap === undefined ? undefined : Number(p.qualityGap) }) },
};

/** Apply a cleaning operation to the head version → a NEW version; the previous one is kept. `automatic` = suggested by the system and not confirmed by a person. */
export function applyClean(recordId: string, userId: string | null, p: CleanParams, automatic = false) {
  const spec = CLEAN_OPS[p.op];
  if (!spec) throw bad(`Unknown cleaning operation "${p.op}"`);
  const cur = stateOf(recordId);
  if (!cur) throw bad('This record has no sequence history. Import it through the Sequence Lab first.');
  const input: C.SeqState = { seq: cur.head.seq, qual: cur.head.qual, map: cur.head.map, marks: cur.head.marks };
  let res: C.CleanResult;
  try { res = spec.run(input, p); } catch (e) { throw bad((e as Error).message); }
  const { op: _op, ...params } = p;
  void _op;
  if (res.state === input) return { version: cur.head, op: null, summary: res.summary, unchanged: true as const };
  let out: { version: Version; opId: string } | null = null;
  tx(() => {
    const opId = uid('sqo');
    const v = addVersion(recordId, cur.head.id, 'derived', res.state, opId, spec.name);
    logOp(recordId, { id: opId, step: 'clean', name: spec.name, inputRef: cur.head.id, outputRef: v.id, params: { op: p.op, ...params }, changes: { summary: res.summary, ...res.details, changes: res.changes, changeCount: res.changes.length }, tool: 'VierStation cleaning', actor: userId, automatic, warnings: res.warnings });
    q.run('UPDATE seq_state SET head=?, redo=? WHERE record_id=?', v.id, '[]', recordId);
    out = { version: v, opId };
  });
  syncRecord(recordId, userId);
  return { ...out!, summary: res.summary, unchanged: false as const, warnings: res.warnings };
}

export function undo(recordId: string, userId: string | null) {
  const s = stateOf(recordId);
  if (!s || !s.head.parentId) throw bad('Nothing to undo – this is the raw sequence.');
  tx(() => {
    q.run('UPDATE seq_state SET head=?, redo=? WHERE record_id=?', s.head.parentId!, JSON.stringify([...s.redo, s.head.id]), recordId);
    logOp(recordId, { step: 'history', name: 'Undo', inputRef: s.head.id, outputRef: s.head.parentId, params: {}, actor: userId, automatic: false });
  });
  syncRecord(recordId, userId);
}
export function redo(recordId: string, userId: string | null) {
  const s = stateOf(recordId);
  if (!s || !s.redo.length) throw bad('Nothing to redo.');
  const next = s.redo[s.redo.length - 1];
  tx(() => {
    q.run('UPDATE seq_state SET head=?, redo=? WHERE record_id=?', next, JSON.stringify(s.redo.slice(0, -1)), recordId);
    logOp(recordId, { step: 'history', name: 'Redo', inputRef: s.head.id, outputRef: next, params: {}, actor: userId, automatic: false });
  });
  syncRecord(recordId, userId);
}
/** Revert = a NEW version that copies an earlier one (so the history is never rewritten). */
export function revertTo(recordId: string, versionId: string, userId: string | null) {
  const s = stateOf(recordId); const target = getVersion(versionId);
  if (!s || !target || target.recordId !== recordId) throw bad('Version not found');
  if (target.id === s.head.id) throw bad('That version is already the current one.');
  tx(() => {
    const opId = uid('sqo');
    const v = addVersion(recordId, s.head.id, 'derived', { seq: target.seq, qual: target.qual, map: target.map, marks: target.marks }, opId, `Reverted to version ${target.n}`);
    logOp(recordId, { id: opId, step: 'clean', name: `Revert to version ${target.n}`, inputRef: s.head.id, outputRef: v.id, params: { op: 'revert', toVersion: target.n }, changes: { summary: `Restored the content of version ${target.n} (${target.seq.length} bp) as a new version`, before: s.head.seq.length, after: target.seq.length }, actor: userId, automatic: false });
    q.run('UPDATE seq_state SET head=?, redo=? WHERE record_id=?', v.id, '[]', recordId);
  });
  syncRecord(recordId, userId);
}

export function setMeta(recordId: string, patch: Record<string, unknown>) {
  const st = q.get<{ meta: string }>('SELECT meta FROM seq_state WHERE record_id=?', recordId);
  if (!st) return;
  q.run('UPDATE seq_state SET meta=? WHERE record_id=?', JSON.stringify({ ...safeJson(st.meta, {}), ...patch }), recordId);
}

/**
 * Records that existed before the Sequence Lab (or were created by other imports) get a raw version from the sequence they hold NOW.
 * The log says so explicitly: for such records VierStation cannot prove this equals the original input.
 */
export function adoptRecord(recordId: string, userId: string | null) {
  if (stateOf(recordId)) return;
  const rec = getRaw(recordId);
  if (!rec) throw bad('Record not found');
  const sf = fieldByKey(rec.tableId, 'sequence');
  const seq = sf ? String(rec.data[sf.id] ?? '') : '';
  if (!seq) throw bad('This record has no sequence to analyse. Add a sequence first.');
  ensureLabFields(rec.tableId);
  tx(() => {
    const opId = uid('sqo');
    const v = addVersion(recordId, null, 'raw', { seq, qual: null, map: initialMap(seq.length), marks: [] }, opId, 'Raw (taken from the record when it entered the Sequence Lab)');
    q.run('INSERT INTO seq_state(record_id, head, redo, meta) VALUES (?,?,?,?)', recordId, v.id, '[]', JSON.stringify({ source: 'adopted' }));
    logOp(recordId, { id: opId, step: 'import', name: 'Record entered the Sequence Lab', outputRef: v.id, params: { source: 'existing record', length: seq.length }, tool: 'VierStation', actor: userId, automatic: true, warnings: ['This record existed before the Sequence Lab. Its raw version is the sequence stored in the record at this moment; the original file or chromatogram was not kept.'] });
  });
}

// ---------------------------------------------------------------- merged forward + reverse records
export interface MergeSource { recordId: string; name: string; versionId: string; versionN: number; seq: string; qual: number[] | null }
const shortId = (id: string) => id.slice(-6);
export const mergedName = (f: { name: string; recordId: string }, r: { name: string; recordId: string }) => `Merged: ${f.name} (${shortId(f.recordId)}) + ${r.name} (${shortId(r.recordId)})`;

/**
 * The combined sequence of a forward and a reverse read becomes its OWN record (raw = the consensus, immutable), so there is one clear sequence to BLAST and
 * the two source reads stay untouched in the DNA table. The import operation stores both inputs and the merge parameters; the source records get a history entry
 * pointing at the merged record.
 */
export function importMerged(o: { workspaceId: string; projectId: string | null; userId: string | null; name?: string }, f: MergeSource, r: MergeSource, merged: C.CleanResult, orientation: string): string {
  const tableId = tableOfKind({ workspaceId: o.workspaceId, projectId: o.projectId }, 'dna');
  ensureLabFields(tableId);
  const name = (o.name ?? '').trim() || mergedName(f, r);
  const fRec = getRaw(f.recordId);
  const carry = (key: string) => { const fl = fRec ? fieldByKey(fRec.tableId, key) : undefined; return fl && fRec ? fRec.data[fl.id] : undefined; };
  const values: Record<string, unknown> = { name, sequence: merged.state.seq, length: merged.state.seq.length, source: 'User upload', sampleId: carry('sampleId'), marker: carry('marker'), readType: 'Merged forward + reverse', fileSource: `Merged from "${f.name}" (${shortId(f.recordId)}) + "${r.name}" (${shortId(r.recordId)})`, importedAt: now() };
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) { const fl = fieldByKey(tableId, k); if (fl && v !== undefined && v !== '' && v !== null) input[fl.id] = v; }
  let id = '';
  tx(() => {
    const rec = createRecord(tableId, input, { userId: o.userId, createChoices: true, origin: { jobId: 'seqlab', depth: 3 } });
    id = rec.id;
    const st: C.SeqState = { seq: merged.state.seq, qual: merged.state.qual, map: initialMap(merged.state.seq.length), marks: [] };
    const opId = uid('sqo');
    const v = addVersion(id, null, 'raw', st, opId, 'Raw (merged forward + reverse read, immutable)');
    q.run('INSERT INTO seq_state(record_id, head, redo, meta) VALUES (?,?,?,?)', id, v.id, '[]', JSON.stringify({ source: 'merged', forwardRecordId: f.recordId, reverseRecordId: r.recordId, description: `Merged ${f.name} + ${r.name}` }));
    logOp(id, {
      id: opId, step: 'import', name: 'Merged forward and reverse reads', outputRef: v.id,
      params: { source: 'merge', length: st.seq.length, hasQuality: !!st.qual, forwardRecordId: f.recordId, forwardName: f.name, forwardVersionId: f.versionId, forwardVersionN: f.versionN, forwardSeq: f.seq, forwardQual: f.qual, reverseRecordId: r.recordId, reverseName: r.name, reverseVersionId: r.versionId, reverseVersionN: r.versionN, reverseSeq: r.seq, reverseQual: r.qual, orientation },
      changes: { summary: merged.summary, ...merged.details, changes: merged.changes, changeCount: merged.changes.length },
      tool: 'VierStation read merger', actor: o.userId, automatic: false, warnings: merged.warnings,
    });
    addProvenance(id, { sourceDb: 'User upload', accession: name, query: `merge of ${f.recordId} + ${r.recordId}`, step: 'import', note: merged.summary });
    for (const [src, partner, role] of [[f, r, 'forward'], [r, f, 'reverse']] as const) {
      logOp(src.recordId, { step: 'merged', name: `Combined with ${partner.name} into "${name}"`, params: { mergedRecordId: id, mergedName: name, role, partnerRecordId: partner.recordId, partnerName: partner.name }, tool: 'VierStation read merger', actor: o.userId, automatic: false });
      const cur = safeJson<{ mergedInto?: string[] }>(q.get<{ meta: string }>('SELECT meta FROM seq_state WHERE record_id=?', src.recordId)?.meta, {});
      setMeta(src.recordId, { mergedInto: [...(cur.mergedInto ?? []), id] });
    }
  });
  return id;
}
