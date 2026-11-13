import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route, str, rateLimit, oneOf } from '../http.ts';
import { q } from '../db.ts';
import { HttpError, bad, notFound } from '../util.ts';
import { config } from '../config.ts';
import { requireProject, requireRecord, requireTable, requireWorkspace } from '../access.ts';
import { auditCtx } from '../audit.ts';
import { ALL_DBS, DEFAULT_DBS, interpret, unifiedSearch } from '../search.ts';
import type { Db } from '../search.ts';
import { enqueue } from '../jobs.ts';
import { getRaw, Hydrator, toRaw } from '../records.ts';
import { listFields } from '../schema.ts';
import { alphafoldModels, downloadCoordinates, plddtFromPdb } from '../integrations/alphafold.ts';
import { pdbFileUrl } from '../integrations/rcsb.ts';
import { ANALYSIS_TYPES } from '../analysis/compute.ts';
import type { AnalysisType } from '../analysis/compute.ts';
import { codeFor, getAnalysis, listAnalyses } from '../analysis/index.ts';
import type { Lang } from '../analysis/codegen.ts';
import { detectSeqKind, parseFasta } from '../../shared/sequence.ts';
import { tableOfKind } from '../ingest.ts';
import '../discovery/jobs.ts';

// ---------------- unified search ----------------
route('GET', '/api/search/databases', () => ({ databases: ALL_DBS, defaults: DEFAULT_DBS }));

route('POST', '/api/search', async (c) => {
  rateLimit(`sci-search:${c.user!.id}`, 60, 60_000);
  const query = str(c.body.query, 'Query', { max: 2000 });
  const dbs = (Array.isArray(c.body.dbs) && c.body.dbs.length ? c.body.dbs : DEFAULT_DBS).filter((d: string) => ALL_DBS.some((x) => x.id === d)) as Db[];
  return unifiedSearch(query, dbs);
});

route('POST', '/api/search/sequence', (c) => {
  const w = requireWorkspace(c.user!.id, str(c.body.workspaceId, 'workspaceId'), 'viewer');
  void w;
  const rec = parseFasta(str(c.body.sequence, 'Sequence', { max: 200_000 }))[0];
  if (!rec) throw bad('No sequence found');
  const k = detectSeqKind(rec.seq);
  if (k === 'unknown') throw bad('This does not look like a DNA or protein sequence');
  const kind = k === 'protein' ? 'protein' : 'dna';
  if (rec.seq.length < (kind === 'protein' ? 12 : 25)) throw bad(`Sequence is too short for a reliable search (minimum ${kind === 'protein' ? 12 : 25}).`);
  const jobId = enqueue({ workspaceId: String(c.body.workspaceId), type: 'blast.sequence', name: `Sequence search (${kind === 'protein' ? 'BLASTP' : 'BLASTN'})`, payload: { seq: rec.seq.replace(/U/g, 'T'), kind }, userId: c.user!.id });
  return { jobId, kind, length: rec.seq.length };
});

route('POST', '/api/search/interpret', (c) => ({ interpretation: interpret(str(c.body.query, 'Query', { max: 2000 })) }));

// ---------------- import a hit / run discovery (all asynchronous) ----------------
function projectCtx(c: { user: { id: string } | null; body: any }) {
  const p = requireProject(c.user!.id, str(c.body.projectId, 'projectId'), 'editor');
  return { workspaceId: p.workspace_id, projectId: p.id };
}

route('POST', '/api/import/hit', (c) => {
  const { workspaceId, projectId } = projectCtx(c);
  const db = oneOf(c.body.db, ['nuccore', 'gene', 'uniprot', 'pubchem', 'pdb'] as const, 'db');
  const id = str(c.body.id, 'id', { max: 300 });
  const jobId = enqueue({ workspaceId, projectId, type: 'import.hit', name: `Import ${id} from ${db}`, payload: { db, id }, userId: c.user!.id, dedupeKey: `import:${projectId}:${db}:${id}` });
  auditCtx(c, workspaceId, 'import.hit', 'project', projectId, { db, id });
  return { jobId };
});

route('POST', '/api/import/accession', (c) => {
  const { workspaceId, projectId } = projectCtx(c);
  const input = str(c.body.value, 'Accession', { max: 200 });
  const jobId = enqueue({ workspaceId, projectId, type: 'fetch.nucleotide', name: `Fetch ${input}`, payload: { accession: input }, userId: c.user!.id, dedupeKey: `fetch:${projectId}:${input}` });
  return { jobId };
});

route('POST', '/api/import/fasta', (c) => {
  const { workspaceId, projectId } = projectCtx(c);
  const text = str(c.body.text, 'Sequence', { max: 20_000_000 });
  const recs = parseFasta(text);
  if (!recs.length) throw bad('No sequence found. Paste FASTA text or a plain nucleotide sequence.');
  for (const r of recs.slice(0, 500)) {
    const k = detectSeqKind(r.seq);
    if (k === 'protein') throw bad(`"${r.id}" looks like a protein sequence. Paste it into the Proteins table instead (this importer is for DNA/RNA).`);
    if (k === 'unknown') throw bad(`"${r.id}" does not look like a nucleotide sequence.`);
  }
  const jobId = enqueue({ workspaceId, projectId, type: 'import.fasta', name: 'Import FASTA sequences', payload: { text }, userId: c.user!.id });
  return { jobId };
});

route('POST', '/api/records/:id/discover', (c) => {
  const { table, record } = requireRecord(c.user!.id, c.params.id, 'editor');
  const what = oneOf(c.body.what, ['pipeline', 'genes', 'proteins', 'structures', 'chemicals', 'metadata'] as const, 'what');
  const kind = table.kind;
  const base = { workspaceId: table.workspace_id, projectId: table.project_id, userId: c.user!.id, payload: { recordId: record.id, ...(c.body.options ?? {}) } };
  const named = (type: string, name: string) => enqueue({ ...base, type, name, dedupeKey: `${type}:${record.id}` });
  let jobId: string;
  switch (what) {
    case 'pipeline': jobId = named('pipeline.full', 'Discovery pipeline'); break;
    case 'genes': if (kind !== 'dna' && kind !== 'rna') throw bad('Gene discovery starts from a DNA record'); jobId = named('discover.genes', 'Find genes in DNA'); break;
    case 'proteins': if (kind !== 'gene') throw bad('Protein discovery starts from a gene record'); jobId = named('discover.proteins', 'Find proteins for gene'); break;
    case 'structures': if (kind !== 'protein') throw bad('Structure retrieval starts from a protein record'); jobId = named('discover.structures', 'Retrieve structures'); break;
    case 'chemicals': if (kind !== 'protein') throw bad('Chemical discovery starts from a protein record'); jobId = named('discover.chemicals', 'Find associated chemicals'); break;
    case 'metadata':
      if (kind === 'dna' || kind === 'rna') jobId = named('fetch.nucleotide', 'Fetch NCBI metadata');
      else if (kind === 'gene') jobId = named('enrich.gene', 'Fetch NCBI gene');
      else if (kind === 'protein') jobId = named('enrich.protein', 'Fetch UniProt entry');
      else if (kind === 'chemical') jobId = named('enrich.chemical', 'Fetch PubChem metadata');
      else throw bad('This kind of record has no external metadata source');
      break;
  }
  auditCtx(c, table.workspace_id, 'discover', 'record', record.id, { what });
  return { jobId: jobId! };
});

// ---------------- relationship graph ----------------
interface GNode { id: string; label: string; tableId: string; tableName: string; kind: string; status?: string }
interface GEdge { id: number; from: string; to: string; fieldId: string; field: string; meta: unknown }

function buildGraph(userId: string, seeds: string[], depth: number, cap: number) {
  const nodes = new Map<string, GNode>();
  const edges = new Map<number, GEdge>();
  const h = new Hydrator();
  const tmeta = new Map<string, { name: string; kind: string; ok: boolean }>();
  const meta = (tid: string) => {
    let m = tmeta.get(tid);
    if (!m) {
      const t = q.get<any>('SELECT * FROM tables WHERE id=?', tid);
      let ok = false;
      try { requireTable(userId, tid); ok = true; } catch { ok = false; }
      m = { name: t?.name ?? '', kind: t?.kind ?? 'custom', ok };
      tmeta.set(tid, m);
    }
    return m;
  };
  const fnames = new Map<string, string>();
  const add = (id: string) => {
    if (nodes.has(id)) return true;
    const raw = (h.raw.get(id) ?? (h.loadRaw([id]), h.raw.get(id)));
    if (!raw) return false;
    const m = meta(raw.tableId);
    if (!m.ok) return false;
    const sf = listFields(raw.tableId).find((f) => f.key === 'status');
    nodes.set(id, { id, label: h.display(raw), tableId: raw.tableId, tableName: m.name, kind: m.kind, status: sf?.options.choices?.find((c) => c.id === raw.data[sf.id])?.name });
    return true;
  };
  let frontier = seeds.filter(add);
  for (let d = 0; d < depth && frontier.length && nodes.size < cap; d++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += 300) {
      const part = frontier.slice(i, i + 300), ph = part.map(() => '?').join(',');
      for (const l of q.all<any>(`SELECT l.id, l.field_id, l.from_id, l.to_id, l.meta, f.name fname FROM links l JOIN fields f ON f.id=l.field_id WHERE l.from_id IN (${ph}) OR l.to_id IN (${ph}) LIMIT 4000`, ...part, ...part)) {
        if (nodes.size >= cap && (!nodes.has(l.from_id) || !nodes.has(l.to_id))) continue;
        if (!add(l.from_id) || !add(l.to_id)) continue;
        fnames.set(l.field_id, l.fname);
        if (!edges.has(l.id)) edges.set(l.id, { id: l.id, from: l.from_id, to: l.to_id, fieldId: l.field_id, field: l.fname, meta: l.meta ? JSON.parse(l.meta) : null });
        for (const x of [l.from_id, l.to_id]) if (!frontier.includes(x) && !next.includes(x)) next.push(x);
      }
    }
    frontier = next.filter((i) => nodes.has(i));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated: nodes.size >= cap };
}

route('GET', '/api/records/:id/graph', (c) => {
  requireRecord(c.user!.id, c.params.id);
  return buildGraph(c.user!.id, [c.params.id], Math.min(3, Math.max(1, Number(c.query.get('depth') ?? 2))), 300);
});

route('GET', '/api/tables/:id/graph', (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  const depth = Math.min(3, Math.max(1, Number(c.query.get('depth') ?? 2)));
  const seeds = q.all<{ id: string }>('SELECT id FROM records WHERE table_id=? ORDER BY rowid LIMIT 60', t.id).map((r) => r.id);
  return buildGraph(c.user!.id, seeds, depth, 400);
});

// ---------------- structures ----------------
const structDir = join(config.dataDir, 'structures');
mkdirSync(structDir, { recursive: true });

route('GET', '/api/structures/model', async (c) => {
  const src = oneOf(c.query.get('src'), ['alphafold', 'pdb'] as const, 'src');
  const id = (c.query.get('id') ?? '').trim();
  let name: string, fetchUrl: string;
  if (src === 'alphafold') {
    if (!/^[A-Z0-9]{6,10}$/i.test(id)) throw bad('AlphaFold structures are requested by UniProt accession');
    const m = (await alphafoldModels(id))[0];
    if (!m) throw notFound(`AlphaFold DB has no model for ${id}`);
    name = `AF-${m.uniprot}-F1-v${m.version}.pdb`.replace(/[^\w.-]/g, '_'); fetchUrl = m.pdbUrl; // file name comes from an upstream response: never trust it as a path
  } else {
    if (!/^[1-9][A-Za-z0-9]{3}$/.test(id)) throw bad('Not a PDB ID');
    name = `${id.toUpperCase()}.pdb`; fetchUrl = pdbFileUrl(id);
  }
  const path = join(structDir, name);
  if (!existsSync(path)) writeFileSync(path, await downloadCoordinates(fetchUrl));
  const text = readFileSync(path, 'utf8');
  c.res.writeHead(200, { 'Content-Type': 'chemical/x-pdb; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, max-age=86400' });
  c.res.end(text);
});

route('GET', '/api/structures/info', async (c) => {
  const id = (c.query.get('uniprot') ?? '').trim();
  if (!/^[A-Z0-9]{6,10}$/i.test(id)) throw bad('Provide a UniProt accession');
  const m = (await alphafoldModels(id))[0];
  if (!m) return { available: false, uniprot: id };
  const name = `AF-${m.uniprot}-F1-v${m.version}.pdb`.replace(/[^\w.-]/g, '_');
  const path = join(structDir, name);
  if (!existsSync(path)) writeFileSync(path, await downloadCoordinates(m.pdbUrl));
  const residues = plddtFromPdb(readFileSync(path, 'utf8'));
  return { available: true, uniprot: m.uniprot, entryId: m.entryId, version: m.version, meanPlddt: m.meanPlddt, fractions: m.fractions, paeImageUrl: m.paeImageUrl, cifUrl: m.cifUrl, pdbUrl: m.pdbUrl, organism: m.organism, gene: m.gene, description: m.description, residues, tool: m.tool, sequenceLength: m.sequenceEnd - m.sequenceStart + 1 };
});

// ---------------- analysis ----------------
route('GET', '/api/analysis/types', () => ({ types: ANALYSIS_TYPES }));

route('POST', '/api/analysis', (c) => {
  const type = oneOf(c.body.type, ANALYSIS_TYPES.map((t) => t.type) as AnalysisType[], 'Analysis type');
  const t = requireTable(c.user!.id, str(c.body.tableId, 'tableId'), 'editor');
  const jobId = enqueue({
    workspaceId: t.workspace_id, projectId: t.project_id, type: 'analysis.run', name: `Analysis: ${ANALYSIS_TYPES.find((x) => x.type === type)!.label}`,
    payload: { analysisType: type, tableId: t.id, recordIds: Array.isArray(c.body.recordIds) ? c.body.recordIds.map(String).slice(0, 2000) : undefined, params: c.body.params ?? {}, name: typeof c.body.name === 'string' ? c.body.name.slice(0, 120) : undefined },
    userId: c.user!.id,
  });
  auditCtx(c, t.workspace_id, 'analysis.start', 'table', t.id, { type });
  return { jobId };
});

route('GET', '/api/workspaces/:id/analyses', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  return { analyses: listAnalyses(c.params.id, c.query.get('project')) };
});

route('GET', '/api/analysis/:id', (c) => {
  const a = getAnalysis(c.params.id);
  if (!a) throw notFound('Analysis not found');
  requireWorkspace(c.user!.id, a.workspaceId);
  return { analysis: { ...a, input: { ...a.input, sequences: a.input.sequences?.map((s) => ({ ...s, seq: s.seq.length > 200_000 ? s.seq.slice(0, 200_000) : s.seq })) } } };
});

route('GET', '/api/analysis/:id/code', (c) => {
  const a = getAnalysis(c.params.id);
  if (!a) throw notFound('Analysis not found');
  requireWorkspace(c.user!.id, a.workspaceId);
  const lang = oneOf(c.query.get('lang') ?? 'python', ['python', 'r', 'julia'] as Lang[], 'lang');
  const text = codeFor(a, lang);
  const ext = { python: 'py', r: 'R', julia: 'jl' }[lang];
  const name = `${a.name.replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;
  if (c.query.get('download') === '1') {
    c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    c.res.end(text);
    return;
  }
  return { lang, filename: name, code: text };
});

route('GET', '/api/analysis/:id/export', (c) => {
  const a = getAnalysis(c.params.id);
  if (!a) throw notFound('Analysis not found');
  requireWorkspace(c.user!.id, a.workspaceId);
  const fmt = oneOf(c.query.get('format') ?? 'json', ['json', 'csv'] as const, 'format');
  const safe = a.name.replace(/[^\w.-]+/g, '_').slice(0, 60);
  if (fmt === 'json') {
    c.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${safe}.json"` });
    c.res.end(JSON.stringify({ name: a.name, type: a.type, createdAt: a.createdAt, parameters: a.params, input: a.input, result: a.result }, null, 2));
    return;
  }
  // CSV of the primary tabular result
  const r = a.result;
  let rows: (string | number | null)[][] = [];
  if (a.type === 'pca') rows = [['record', ...r.scores[0].map((_: number, i: number) => `PC${i + 1}`)], ...r.scores.map((s: number[], i: number) => [r.rowLabels[i], ...s])];
  else if (a.type === 'heatmap') rows = [['', ...r.colNames], ...r.values.map((v: (number | null)[], i: number) => [r.rowLabels[i], ...v])];
  else if (a.type === 'comparison') rows = [['', ...r.labels], ...r.matrix.map((v: number[], i: number) => [r.labels[i], ...v])];
  else if (a.type === 'phylogeny') rows = [['', ...r.labels], ...r.distanceMatrix.map((v: number[], i: number) => [r.labels[i], ...v])];
  else if (a.type === 'statistics') rows = [['variable', 'n', 'mean', 'sd', 'min', 'q1', 'median', 'q3', 'max', 'missing'], ...r.summary.map((s: any) => [s.name, s.n, s.mean, s.sd, s.min, s.q1, s.median, s.q3, s.max, s.missing])];
  else if (a.type === 'alignment') rows = r.kind === 'msa' ? [['label', 'aligned'], ...r.labels.map((l: string, i: number) => [l, r.rows[i]])] : [['label', 'aligned'], [r.labels[0], r.alignment.a], [r.labels[1], r.alignment.b]];
  const csv = rows.map((row) => row.map((v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safe}.csv"` });
  c.res.end(csv + '\r\n');
});

void HttpError; void getRaw; void toRaw; void tableOfKind;
