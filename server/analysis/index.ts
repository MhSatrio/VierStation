// Analysis orchestration: gather inputs from table records, compute in a worker thread, persist parameters + result,
// create an Analysis Results record linked to its inputs, and keep everything needed to regenerate Python / R / Julia code.
import { Worker } from 'node:worker_threads';
import { Cancelled, Fatal, registerJob } from '../jobs.ts';
import type { JobCtx } from '../jobs.ts';
import { q } from '../db.ts';
import { bad, now, safeJson, uid } from '../util.ts';
import { fieldByKey, listFields } from '../schema.ts';
import { queryRecords } from '../query.ts';
import { cellText } from '../../shared/filters.ts';
import { cleanSeq, detectSeqKind } from '../../shared/sequence.ts';
import { ANALYSIS_TYPES, compute } from './compute.ts';
import type { AnalysisInput, AnalysisType, MatrixInput, Params, SeqInput } from './compute.ts';
import { linkByTables, tableOfKind, upsertByKey, setStatus } from '../ingest.ts';
import { toCtx } from '../discovery/jobs.ts';
import { generateCode } from './codegen.ts';
import type { Lang } from './codegen.ts';
import { getRaw } from '../records.ts';
import { Hydrator } from '../records.ts';
import type { Field } from '../../shared/types.ts';

const MAX_ROWS = 2000;

export function gatherInput(type: AnalysisType, tableId: string, recordIds: string[] | undefined, params: Params): AnalysisInput {
  const def = ANALYSIS_TYPES.find((t) => t.type === type);
  if (!def) throw bad('Unknown analysis type');
  const fields = listFields(tableId);
  const res = recordIds?.length ? queryRecords(tableId, { ids: recordIds }) : queryRecords(tableId, { limit: MAX_ROWS });
  const rows = res.records;
  if (!rows.length) throw bad('There are no records to analyse');
  const h = new Hydrator();
  const label = (id: string) => { const raw = getRaw(id); return raw ? h.display(raw) : id; };

  if (def.needs === 'sequences') {
    const sf: Field | undefined = fields.find((f) => f.id === params.sequenceField) ?? fieldByKey(tableId, 'sequence') ?? fields.find((f) => f.type === 'sequence');
    if (!sf) throw bad('This table has no Sequence field');
    const seqs: SeqInput[] = [];
    for (const r of rows) {
      const v = r.fields[sf.id];
      if (typeof v !== 'string' || !v) continue;
      seqs.push({ id: r.id, label: label(r.id), seq: cleanSeq(v).replace(/U/g, sf.options.seqType === 'protein' ? 'U' : 'T') });
    }
    if (seqs.length < 2) throw bad('Select at least two records that have a sequence');
    const declared = sf.options.seqType === 'protein' ? 'protein' : 'dna';
    const kind = detectSeqKind(seqs[0].seq);
    const seqType = kind === 'protein' ? 'protein' : kind === 'dna' || kind === 'rna' ? 'dna' : declared;
    const dup = new Set<string>();
    for (const s of seqs) { let l = s.label, i = 2; while (dup.has(l)) l = `${s.label} (${i++})`; dup.add(l); s.label = l; }
    return { sequences: seqs, seqType };
  }

  // numeric matrix
  const numeric = (f: Field) => ['number', 'rollup', 'formula'].includes(f.type);
  let cols: Field[] = params.fieldIds?.length ? fields.filter((f) => params.fieldIds.includes(f.id)) : fields.filter(numeric).filter((f) => rows.some((r) => typeof r.fields[f.id] === 'number'));
  cols = cols.filter((f) => rows.some((r) => typeof r.fields[f.id] === 'number'));
  if (!cols.length) throw bad('This table has no numeric fields with values. Add a Number field or choose fields.');
  const values = rows.map((r) => cols.map((f) => { const v = r.fields[f.id]; return typeof v === 'number' && Number.isFinite(v) ? v : null; }));
  const keep = values.map((r) => r.some((v) => v !== null));
  const m: MatrixInput = {
    rowIds: rows.filter((_, i) => keep[i]).map((r) => r.id), rowLabels: rows.filter((_, i) => keep[i]).map((r) => label(r.id)), colNames: cols.map((f) => f.name), colIds: cols.map((f) => f.id), values: values.filter((_, i) => keep[i]),
  };
  const gf = fields.find((f) => f.id === params.groupField);
  if (gf) { m.groups = rows.filter((_, i) => keep[i]).map((r) => { const t = cellText(r.fields[gf.id], gf); return t || null; }); m.groupName = gf.name; }
  return { matrix: m };
}

export function runInWorker(type: AnalysisType, input: AnalysisInput, params: Params, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    // Small inputs run inline: spawning a worker costs ~30 ms which exceeds the compute time.
    const size = (input.sequences?.reduce((a, s) => a + s.seq.length, 0) ?? 0) + (input.matrix ? input.matrix.values.length * (input.matrix.values[0]?.length ?? 0) : 0);
    if (size < 4000) { try { resolve(compute(type, input, params)); } catch (e) { reject(e); } return; }
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { type, input, params }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    const onAbort = () => { void w.terminate(); reject(new Cancelled()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    w.once('message', (m: { ok: boolean; result?: unknown; error?: string }) => { signal?.removeEventListener('abort', onAbort); void w.terminate(); m.ok ? resolve(m.result) : reject(new Fatal(m.error ?? 'Analysis failed')); });
    w.once('error', (e: Error) => { signal?.removeEventListener('abort', onAbort); reject(new Fatal(`Analysis worker crashed: ${e.message}`)); });
  });
}

function summarize(type: AnalysisType, r: any): string {
  switch (type) {
    case 'alignment': return r.kind === 'pairwise' ? `Pairwise ${r.alignment.mode} alignment: score ${r.alignment.score}, ${r.alignment.identityPct}% identity over ${r.alignment.length} columns` : `Multiple alignment of ${r.rows.length} sequences, ${r.length} columns`;
    case 'comparison': return `${r.labels.length} sequences compared (${r.method})`;
    case 'phylogeny': return `${r.method === 'nj' ? 'Neighbor-joining' : 'UPGMA'} tree of ${r.labels.length} sequences`;
    case 'heatmap': return `${r.rowLabels.length} × ${r.colNames.length} heatmap (${r.scale} scaling)`;
    case 'pca': return `PCA: PC1 ${(r.explained[0] * 100).toFixed(1)}%, PC2 ${((r.explained[1] ?? 0) * 100).toFixed(1)}% of variance`;
    case 'statistics': return `${r.summary.length} variable(s), ${r.rows} row(s)`;
  }
}

registerJob('analysis.run', async (j: JobCtx) => {
  const c = toCtx(j);
  const p = j.payload as { analysisType: AnalysisType; tableId: string; recordIds?: string[]; params?: Params; name?: string };
  const params = p.params ?? {};
  j.progress(0, 3, 'Collecting inputs');
  const input = gatherInput(p.analysisType, p.tableId, p.recordIds, params);
  const id = uid('ana');
  const label = ANALYSIS_TYPES.find((t) => t.type === p.analysisType)!.label;
  const name = (p.name ?? '').trim() || `${label} – ${now().slice(0, 16).replace('T', ' ')}`;
  q.run("INSERT INTO analyses(id,workspace_id,project_id,name,type,params,input,status,job_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,'running',?,?,?)",
    id, j.workspaceId, j.projectId, name, p.analysisType, JSON.stringify(params), JSON.stringify(input), j.id, j.userId, now());
  j.progress(1, 3, 'Computing');
  try {
    const result = await runInWorker(p.analysisType, input, params, j.signal);
    j.progress(2, 3, 'Saving result');
    const summary = summarize(p.analysisType, result);
    q.run("UPDATE analyses SET result=?, status='completed' WHERE id=?", JSON.stringify(result), id);
    // Analysis Results record, linked to the input records
    const at = tableOfKind(c, 'analysis');
    const typeLabel = { alignment: 'Alignment', comparison: 'Comparison', heatmap: 'Heatmap', pca: 'PCA', statistics: 'Statistics', phylogeny: 'Phylogeny' }[p.analysisType];
    const rec = upsertByKey(c, at, 'analysisId', id, { name, analysisType: typeLabel, summary }, { sourceDb: 'VierStation analysis', accession: id, query: JSON.stringify(params).slice(0, 300), step: 'analysis', note: summary });
    const inputIds = input.sequences?.map((s) => s.id) ?? input.matrix?.rowIds ?? [];
    for (const rid of inputIds.slice(0, 200)) linkByTables(at, rec.id, p.tableId, rid, { relationType: 'input to analysis', evidenceClass: 'user_supplied', evidence: `Used as input for analysis "${name}"`, sourceDb: 'VierStation' });
    setStatus(at, rec.id, 'Completed', c);
    q.run('UPDATE analyses SET result_record_id=? WHERE id=?', rec.id, id);
    j.setOutput({ kind: 'analysis', ref: id, label: name });
    return { analysisId: id, resultRecordId: rec.id, summary, _notify: { kind: 'analysis_completed', title: `Analysis complete: ${name}`, body: summary, link: `/analysis/${id}` } };
  } catch (e) {
    q.run("UPDATE analyses SET status=? WHERE id=?", e instanceof Cancelled ? 'cancelled' : 'failed', id);
    throw e;
  }
}, { maxAttempts: 1 });

export interface AnalysisRow { id: string; workspaceId: string; projectId: string | null; name: string; type: AnalysisType; params: Params; input: AnalysisInput; result: any; status: string; jobId: string | null; createdAt: string; resultRecordId: string | null }
export function getAnalysis(id: string): AnalysisRow | undefined {
  const r = q.get<any>('SELECT * FROM analyses WHERE id=?', id);
  return r ? { id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, type: r.type, params: safeJson(r.params, {}), input: safeJson(r.input, {}), result: safeJson(r.result, null), status: r.status, jobId: r.job_id, createdAt: r.created_at, resultRecordId: r.result_record_id } : undefined;
}
export function listAnalyses(workspaceId: string, projectId?: string | null) {
  const rows = projectId ? q.all<any>('SELECT id, name, type, status, created_at, project_id, job_id FROM analyses WHERE workspace_id=? AND project_id=? ORDER BY created_at DESC LIMIT 200', workspaceId, projectId)
    : q.all<any>('SELECT id, name, type, status, created_at, project_id, job_id FROM analyses WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200', workspaceId);
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, status: r.status, createdAt: r.created_at, projectId: r.project_id, jobId: r.job_id }));
}
export function codeFor(a: AnalysisRow, lang: Lang): string {
  if (a.status !== 'completed') throw bad('Only completed analyses can be exported as code');
  return generateCode(lang, { type: a.type, name: a.name, params: a.params, input: a.input, result: a.result, createdAt: a.createdAt });
}
