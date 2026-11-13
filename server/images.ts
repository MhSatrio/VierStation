// Images for chemicals and proteins, cached on disk (data/images) so they are still there offline.
//   chemical : the 2D depiction PubChem draws for a stable identifier (CID, else InChIKey, else SMILES). Never looked up by NAME, so an unrelated molecule can never appear.
//   protein  : a thumbnail DRAWN HERE from real coordinates (experimental PDB entry preferred, else AlphaFold model) – a projection of the backbone (C-alpha trace), coloured
//              from N- to C-terminus. If no coordinates exist nothing is invented; the UI shows an honest "no structure" placeholder.
// Every image keeps its source, identifier and retrieval time (table image_cache) and is shown with that provenance.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { q } from './db.ts';
import { config } from './config.ts';
import { now } from './util.ts';
import { getRaw } from './records.ts';
import { fieldByKey } from './schema.ts';
import { requestBuffer } from './integrations/http.ts';
import { alphafoldModels, downloadCoordinates } from './integrations/alphafold.ts';
import { pdbFileUrl, pdbUrl } from './integrations/rcsb.ts';
import { OfflineError, isOffline } from './network.ts';
import { enqueue, onJobFinished, registerJob } from './jobs.ts';

const imgDir = () => { const d = join(config.dataDir, 'images'); mkdirSync(d, { recursive: true }); return d; };
const structDir = () => { const d = join(config.dataDir, 'structures'); mkdirSync(d, { recursive: true }); return d; };
export interface ThumbInfo { kind: 'chemical' | 'protein'; source: string; sourceUrl: string | null; identifier: string | null; mime: string; note: string | null; retrievedAt: string; experimental: boolean | null }
export interface Thumb { file: string; mime: string; info: ThumbInfo }

const text = (recordId: string, key: string): string => { const r = getRaw(recordId); const f = r ? fieldByKey(r.tableId, key) : undefined; const v = r && f ? r.data[f.id] : undefined; return v === undefined || v === null ? '' : String(v).trim(); };
const kindOf = (recordId: string) => q.get<{ kind: string }>('SELECT t.kind FROM records r JOIN tables t ON t.id=r.table_id WHERE r.id=?', recordId)?.kind;

export function cachedThumbnail(recordId: string): Thumb | null {
  const r = q.get<{ kind: string; file: string; mime: string; source: string; source_url: string | null; identifier: string | null; note: string | null; retrieved_at: string }>('SELECT * FROM image_cache WHERE record_id=? AND file IS NOT NULL', recordId);
  if (!r) return null; const file = join(imgDir(), r.file); if (!existsSync(file)) return null;
  return { file, mime: r.mime, info: { kind: r.kind as 'chemical' | 'protein', source: r.source, sourceUrl: r.source_url, identifier: r.identifier, mime: r.mime, note: r.note, retrievedAt: r.retrieved_at, experimental: /PDB/.test(r.source) ? true : /AlphaFold/.test(r.source) ? false : null } };
}
function store(recordId: string, kind: 'chemical' | 'protein', data: Buffer | string, ext: 'png' | 'svg', info: Omit<ThumbInfo, 'kind' | 'mime' | 'retrievedAt' | 'experimental'>): Thumb {
  const file = `${recordId}.${ext}`; writeFileSync(join(imgDir(), file), data);
  const mime = ext === 'png' ? 'image/png' : 'image/svg+xml';
  q.run('INSERT INTO image_cache(record_id,kind,file,mime,source,source_url,identifier,note,retrieved_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET kind=excluded.kind, file=excluded.file, mime=excluded.mime, source=excluded.source, source_url=excluded.source_url, identifier=excluded.identifier, note=excluded.note, retrieved_at=excluded.retrieved_at', recordId, kind, file, mime, info.source, info.sourceUrl, info.identifier, info.note, now());
  return cachedThumbnail(recordId)!;
}
/** record why there is no image (so we do not retry on every page view; a refresh tries again) */
function remember(recordId: string, kind: string, note: string) { q.run('INSERT INTO image_cache(record_id,kind,file,mime,source,source_url,identifier,note,retrieved_at) VALUES (?,?,NULL,NULL,?,NULL,NULL,?,?) ON CONFLICT(record_id) DO UPDATE SET note=excluded.note, retrieved_at=excluded.retrieved_at WHERE file IS NULL', recordId, kind, 'none', note, now()); }
export const thumbnailStatus = (recordId: string) => q.get<{ note: string; retrieved_at: string }>('SELECT note, retrieved_at FROM image_cache WHERE record_id=? AND file IS NULL', recordId);

// ---------------------------------------------------------------- chemicals
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
async function chemicalImage(recordId: string, signal?: AbortSignal): Promise<Thumb | null> {
  const cid = text(recordId, 'cid').replace(/\D/g, ''), ik = text(recordId, 'inchikey'), smiles = text(recordId, 'isoSmiles') || text(recordId, 'smiles');
  const tries: { path: string; id: string; label: string }[] = [];
  if (cid) tries.push({ path: `cid/${cid}`, id: `CID ${cid}`, label: 'PubChem CID' });
  if (/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(ik)) tries.push({ path: `inchikey/${ik}`, id: ik, label: 'InChIKey' });
  if (!tries.length && smiles && smiles.length < 400) tries.push({ path: `smiles/${encodeURIComponent(smiles)}`, id: smiles.slice(0, 60), label: 'SMILES' });
  if (!tries.length) { remember(recordId, 'chemical', 'No PubChem CID, InChIKey or SMILES is stored for this chemical, so no structure can be drawn. Images are never looked up by name.'); return null; }
  let lastErr = '';
  for (const t of tries) {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${t.path}/PNG?image_size=300x300`;
    try {
      const r = await requestBuffer(url, { signal, accept: 'image/png' });
      if (r.status === 200 && r.buf.subarray(0, 4).equals(PNG)) return store(recordId, 'chemical', r.buf, 'png', { source: 'PubChem 2D depiction', sourceUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid || ''}`.replace(/\/$/, ''), identifier: t.id, note: `Drawn by PubChem from its ${t.label}.` });
      lastErr = `PubChem answered HTTP ${r.status} for ${t.label}`;
    } catch (e) { if (e instanceof OfflineError) throw e; lastErr = (e as Error).message; }
  }
  remember(recordId, 'chemical', `PubChem has no depiction for this identifier (${lastErr}).`); return null;
}

// ---------------------------------------------------------------- proteins: draw the real backbone
interface Ca { x: number; y: number; z: number; chain: string }
export function parseCa(pdb: string): Ca[][] {
  const chains = new Map<string, Ca[]>();
  for (const l of pdb.split('\n')) {
    if (l.startsWith('ENDMDL')) break; // first model only
    if (!l.startsWith('ATOM') || l.slice(12, 16).trim() !== 'CA') continue;
    const alt = l[16]; if (alt && alt !== ' ' && alt !== 'A') continue;
    const x = Number(l.slice(30, 38)), y = Number(l.slice(38, 46)), z = Number(l.slice(46, 54)); if (![x, y, z].every(Number.isFinite)) continue;
    const c = l[21] || '_'; (chains.get(c) ?? chains.set(c, []).get(c)!).push({ x, y, z, chain: c });
  }
  return [...chains.values()].sort((a, b) => b.length - a.length);
}
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
/** orthographic projection of the C-alpha trace on its two principal axes (the most informative view), segments depth-sorted, blue N→C gradient */
export function traceSvg(chains: Ca[][], label: string, sub: string, size = 240): string {
  const main = chains[0]; if (!main || main.length < 8) throw new Error('too few residues to draw');
  const pts = (main.length > 3000 ? main.filter((_, i) => i % Math.ceil(main.length / 3000) === 0) : main);
  const n = pts.length, cx = pts.reduce((s, p) => s + p.x, 0) / n, cy = pts.reduce((s, p) => s + p.y, 0) / n, cz = pts.reduce((s, p) => s + p.z, 0) / n;
  const P = pts.map((p) => [p.x - cx, p.y - cy, p.z - cz]);
  // power iteration for the three principal axes of the covariance matrix
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const p of P) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += p[i] * p[j] / n;
  const axis = (excl: number[][]): number[] => { let v = [Math.random() + 0.1, Math.random() + 0.1, Math.random() + 0.1]; for (let it = 0; it < 60; it++) { let w = cov.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]); for (const e of excl) { const d = w[0] * e[0] + w[1] * e[1] + w[2] * e[2]; w = w.map((x, i) => x - d * e[i]); } const m = Math.hypot(...w) || 1; v = w.map((x) => x / m); } return v; };
  const a1 = axis([]), a2 = axis([a1]), a3 = [a1[1] * a2[2] - a1[2] * a2[1], a1[2] * a2[0] - a1[0] * a2[2], a1[0] * a2[1] - a1[1] * a2[0]];
  const T = P.map((p) => [p[0] * a1[0] + p[1] * a1[1] + p[2] * a1[2], p[0] * a2[0] + p[1] * a2[1] + p[2] * a2[2], p[0] * a3[0] + p[1] * a3[1] + p[2] * a3[2]]);
  const minX = Math.min(...T.map((t) => t[0])), maxX = Math.max(...T.map((t) => t[0])), minY = Math.min(...T.map((t) => t[1])), maxY = Math.max(...T.map((t) => t[1])), minZ = Math.min(...T.map((t) => t[2])), maxZ = Math.max(...T.map((t) => t[2]));
  const pad = 14, top = 6, bottom = 30, s = Math.min((size - 2 * pad) / (maxX - minX || 1), (size - top - bottom - pad) / (maxY - minY || 1));
  const X = (v: number) => pad + (v - minX) * s + ((size - 2 * pad) - (maxX - minX) * s) / 2, Y = (v: number) => top + pad / 2 + (v - minY) * s;
  const c0 = [20, 41, 90], c1 = [134, 169, 217]; // dark navy (N-terminus) → light blue (C-terminus)
  const segs = T.slice(1).map((t, i) => ({ i, a: T[i], b: t, z: (T[i][2] + t[2]) / 2 })).sort((p, q2) => p.z - q2.z); // far segments first
  const body = segs.map(({ i, a, b, z }) => { const near = (z - minZ) / (maxZ - minZ || 1); const col = mix(c0, c1, i / (n - 1)); return `<line x1="${X(a[0]).toFixed(1)}" y1="${Y(a[1]).toFixed(1)}" x2="${X(b[0]).toFixed(1)}" y2="${Y(b[1]).toFixed(1)}" stroke="rgb(${col})" stroke-width="${(1.1 + near * 1.5).toFixed(2)}" stroke-linecap="round" opacity="${(0.55 + near * 0.45).toFixed(2)}"/>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}"><rect width="${size}" height="${size}" rx="10" fill="#F3F8FD"/>${body}<text x="${pad}" y="${size - 17}" font-family="Jost,Arial,sans-serif" font-size="12" font-weight="600" fill="#14295A">${esc(label)}</text><text x="${pad}" y="${size - 5}" font-family="Jost,Arial,sans-serif" font-size="9.5" fill="#4a5a70">${esc(sub)}</text></svg>`;
}

/** structure files already on this computer for a protein: experimental (PDB id of a linked structure record) first, then the AlphaFold model */
function localStructure(recordId: string): { file: string; label: string; sub: string; experimental: boolean; identifier: string; url: string | null } | null {
  const files = existsSync(structDir()) ? readdirSync(structDir()) : [];
  const acc = text(recordId, 'accession').split('-')[0].toUpperCase();
  const linked = q.all<{ id: string }>("SELECT x.id FROM (SELECT to_id id FROM links WHERE from_id=? UNION SELECT from_id FROM links WHERE to_id=? UNION SELECT target_id FROM relationships WHERE source_id=? UNION SELECT source_id FROM relationships WHERE target_id=?) x JOIN records r ON r.id=x.id JOIN tables t ON t.id=r.table_id WHERE t.kind='structure'", recordId, recordId, recordId, recordId);
  for (const s of linked) { const id = text(s.id, 'accession').toUpperCase(); if (/^[1-9][A-Z0-9]{3}$/.test(id) && files.includes(`${id}.pdb`)) return { file: join(structDir(), `${id}.pdb`), label: `PDB ${id}`, sub: 'Experimental structure · backbone trace', experimental: true, identifier: id, url: pdbUrl(id) }; }
  const af = acc ? files.find((f) => f.startsWith(`AF-${acc}-F1`) && f.endsWith('.pdb')) : undefined;
  if (af) return { file: join(structDir(), af), label: `AlphaFold ${acc}`, sub: 'Predicted structure · backbone trace', experimental: false, identifier: af.replace(/\.pdb$/, ''), url: `https://alphafold.ebi.ac.uk/entry/${acc}` };
  return null;
}
async function proteinImage(recordId: string, signal?: AbortSignal): Promise<Thumb | null> {
  let s = localStructure(recordId);
  if (!s) { // not on this computer yet: fetch (online only) and keep the coordinates for offline use
    const acc = text(recordId, 'accession').split('-')[0];
    if (/^[A-Z0-9]{6,10}$/i.test(acc)) {
      try {
        const m = (await alphafoldModels(acc, signal))[0];
        if (m) { const name = `AF-${m.uniprot}-F1-v${m.version}.pdb`.replace(/[^\w.-]/g, '_'); const path = join(structDir(), name); if (!existsSync(path)) writeFileSync(path, await downloadCoordinates(m.pdbUrl, signal)); s = localStructure(recordId); }
      } catch (e) { if (e instanceof OfflineError) throw e; /* fall through to "no structure" */ }
    }
  }
  if (!s) { remember(recordId, 'protein', 'No structure coordinates are stored for this protein, and none were found at AlphaFold DB for its UniProt accession. Nothing is drawn rather than inventing one.'); return null; }
  try {
    const svg = traceSvg(parseCa(readFileSync(s.file, 'utf8')), s.label, s.sub);
    return store(recordId, 'protein', svg, 'svg', { source: s.experimental ? `RCSB PDB ${s.identifier}` : 'AlphaFold DB (predicted)', sourceUrl: s.url, identifier: s.identifier, note: s.experimental ? 'Experimentally determined structure; the picture is a projection of its C-alpha backbone.' : 'COMPUTATIONALLY PREDICTED structure (not experimental); the picture is a projection of its C-alpha backbone.' });
  } catch (e) { remember(recordId, 'protein', `The structure file could not be drawn: ${(e as Error).message}`); return null; }
}

/** The thumbnail of a record: from the local cache, else made now. Chemicals need the internet the first time; proteins are drawn from stored coordinates. */
export async function ensureThumbnail(recordId: string, o: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Thumb | null> {
  const kind = kindOf(recordId);
  if (kind !== 'chemical' && kind !== 'protein') return null;
  if (!o.refresh) { const c = cachedThumbnail(recordId); if (c) return c; const miss = thumbnailStatus(recordId); if (miss && Date.now() - Date.parse(miss.retrieved_at) < 24 * 3600_000) return null; }
  else { const old = q.get<{ file: string | null }>('SELECT file FROM image_cache WHERE record_id=?', recordId); if (old?.file) rmSync(join(imgDir(), old.file), { force: true }); q.run('DELETE FROM image_cache WHERE record_id=?', recordId); }
  if (kind === 'chemical') { if (isOffline()) return null; return chemicalImage(recordId, o.signal); }
  return proteinImage(recordId, o.signal);
}

// ---------------------------------------------------------------- background fetching after discovery
registerJob('images.fetch', async (j) => {
  const { recordIds } = j.payload as { recordIds: string[] };
  let done = 0, made = 0;
  for (const id of recordIds.slice(0, 100)) {
    if (j.signal.aborted) break;
    j.progress(done++, recordIds.length, 'Fetching structure images');
    try { if (await ensureThumbnail(id, { signal: j.signal })) made++; } catch (e) { if ((e as { code?: string }).code === 'offline') throw e; /* one bad image never fails the batch */ }
  }
  return { summary: `${made} image(s) ready`, made };
}, { maxAttempts: 2 });

const WATCH = new Set(['discover.chemicals', 'discover.proteins', 'discover.structures', 'enrich.chemical', 'enrich.protein', 'pipeline.full', 'import.hit', 'fetch.nucleotide']);
onJobFinished((job) => {
  if (process.env.VIERSTATION_NO_AUTO_IMAGES === '1' || !WATCH.has(job.type) || job.status !== 'completed') return;
  try {
    const rows = q.all<{ id: string }>(`SELECT r.id FROM records r JOIN tables t ON t.id=r.table_id WHERE t.workspace_id=? AND t.kind IN ('chemical','protein') AND NOT EXISTS (SELECT 1 FROM image_cache c WHERE c.record_id=r.id) ORDER BY r.updated_at DESC LIMIT 60`, job.workspaceId);
    if (rows.length) enqueue({ workspaceId: job.workspaceId, projectId: job.projectId, type: 'images.fetch', name: `Fetch ${rows.length} structure image(s)`, payload: { recordIds: rows.map((r) => r.id) }, userId: job.createdBy, dedupeKey: `images:${job.workspaceId}` });
  } catch { /* image fetching is a convenience: it never disturbs the job that triggered it */ }
});
