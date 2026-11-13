// Unified scientific search (FR-1.5): classifies the query, fans out to the relevant databases in parallel, and returns
// normalised, importable hits. Slow/unreliable sources (ChEMBL, BindingDB) are opt-in or exact-ID only.
import { detectSeqKind, parseFasta, RE } from '../shared/sequence.ts';
import * as ncbi from './integrations/ncbi.ts';
import * as up from './integrations/uniprot.ts';
import { alphafoldModels, afPage } from './integrations/alphafold.ts';
import { cidsByInchiKey, cidsByName, propsForCids, pubchemUrl, resolveChemical } from './integrations/pubchem.ts';
import { pdbEntry, pdbSearchText, pdbUrl } from './integrations/rcsb.ts';
import { interproEntry, interproSearch, interproUrl } from './integrations/interpro.ts';
import * as chembl from './integrations/chembl.ts';
import { affinitiesForUniprot } from './integrations/bindingdb.ts';
import { getJson } from './integrations/http.ts';

export type Db = 'ncbi' | 'uniprot' | 'alphafold' | 'pubchem' | 'chembl' | 'bindingdb' | 'pdb' | 'interpro';
export const ALL_DBS: { id: Db; label: string; note: string; slow?: boolean }[] = [
  { id: 'ncbi', label: 'NCBI', note: 'DNA, RNA, genes, proteins' },
  { id: 'uniprot', label: 'UniProt', note: 'Protein information' },
  { id: 'alphafold', label: 'AlphaFold DB', note: 'Predicted structures (by UniProt accession)' },
  { id: 'pubchem', label: 'PubChem', note: 'Chemical compounds' },
  { id: 'pdb', label: 'RCSB PDB', note: 'Experimental structures' },
  { id: 'interpro', label: 'InterPro', note: 'Domains and families' },
  { id: 'chembl', label: 'ChEMBL', note: 'Bioactivity (can take 20 s+)', slow: true },
  { id: 'bindingdb', label: 'BindingDB', note: 'Protein–ligand binding (unreliable service)', slow: true },
];
export const DEFAULT_DBS: Db[] = ['ncbi', 'uniprot', 'alphafold', 'pubchem', 'pdb', 'interpro'];

export interface Hit {
  db: 'nuccore' | 'gene' | 'uniprot' | 'alphafold' | 'pubchem' | 'chembl' | 'bindingdb' | 'pdb' | 'interpro' | 'ncbi-protein';
  id: string;
  kind: 'dna' | 'gene' | 'protein' | 'chemical' | 'structure' | 'domain';
  title: string;
  subtitle: string;
  organism?: string;
  url: string;
  importable: boolean;
  badges?: string[];
}
export interface SearchResponse {
  query: string;
  interpreted: { type: string; detail: string };
  hits: Hit[];
  errors: { db: string; message: string }[];
  tookMs: number;
  sequence?: { kind: 'dna' | 'protein'; length: number; fasta: boolean };
}

export interface Interp { type: 'accession' | 'dna-sequence' | 'protein-sequence' | 'coordinates' | 'text'; detail: string; ids: { kind: string; value: string }[] }

export function interpret(raw: string): Interp {
  const text = raw.trim();
  const ids: Interp['ids'] = [];
  if (!text) return { type: 'text', detail: 'empty', ids };
  if (text.startsWith('>') || /^[A-Za-z*\-\s\d]{20,}$/.test(text) && /\s/.test(text) === false && text.length >= 20) {
    const recs = parseFasta(text);
    const seq = recs[0]?.seq ?? '';
    const k = detectSeqKind(seq);
    if (seq.length >= 12 && (k === 'dna' || k === 'rna')) return { type: 'dna-sequence', detail: `${seq.length} nt ${k.toUpperCase()}${recs.length > 1 ? `, ${recs.length} records` : ''}`, ids };
    if (seq.length >= 12 && k === 'protein' && seq.length >= 20) return { type: 'protein-sequence', detail: `${seq.length} aa protein`, ids };
  }
  if (RE.coords.test(text)) return { type: 'coordinates', detail: 'Genomic coordinates', ids: [{ kind: 'coords', value: text }] };
  const t = text.replace(/^(?:accession|acc):\s*/i, '');
  if (RE.inchiKey.test(t)) ids.push({ kind: 'inchikey', value: t });
  else if (RE.inchi.test(t)) ids.push({ kind: 'inchi', value: t });
  else if (RE.chembl.test(t)) ids.push({ kind: 'chembl', value: t.toUpperCase() });
  else if (RE.interpro.test(t)) ids.push({ kind: 'interpro', value: t.toUpperCase() });
  else if (RE.refseqProt.test(t)) ids.push({ kind: 'ncbi-protein', value: t });
  else if (RE.refseqNuc.test(t)) ids.push({ kind: 'nuccore', value: t });
  else if (RE.uniprot.test(t) && /\d/.test(t) && t.length >= 6) ids.push({ kind: 'uniprot', value: t.toUpperCase() });
  else if (RE.pdb.test(t) && /[A-Za-z]/.test(t)) { ids.push({ kind: 'pdb', value: t.toUpperCase() }); if (RE.genbankNuc.test(t)) ids.push({ kind: 'nuccore', value: t }); }
  else if (RE.genbankNuc.test(t) && /\d{5,}/.test(t)) ids.push({ kind: 'nuccore', value: t });
  else if (/^(?:GeneID:?\s*)?\d{1,9}$/i.test(t)) { const d = t.replace(/\D/g, ''); ids.push({ kind: 'gene', value: d }, { kind: 'pubchem', value: d }); }
  const type = ids.length ? 'accession' : 'text';
  return { type, detail: ids.length ? ids.map((i) => `${i.kind}: ${i.value}`).join(', ') : 'Free-text query', ids };
}

const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function unifiedSearch(query: string, dbs: Db[], signal?: AbortSignal): Promise<SearchResponse> {
  const t0 = Date.now();
  const text = query.trim();
  const it = interpret(text);
  const hits: Hit[] = [];
  const errors: SearchResponse['errors'] = [];
  const tasks: { db: string; run: () => Promise<Hit[]> }[] = [];
  const want = (d: Db) => dbs.includes(d);
  const resp: SearchResponse = { query: text, interpreted: { type: it.type, detail: it.detail }, hits, errors, tookMs: 0 };

  if (it.type === 'dna-sequence' || it.type === 'protein-sequence') {
    const seq = parseFasta(text)[0]?.seq ?? '';
    resp.sequence = { kind: it.type === 'dna-sequence' ? 'dna' : 'protein', length: seq.length, fasta: text.startsWith('>') };
    resp.tookMs = Date.now() - t0;
    return resp;
  }
  if (it.type === 'coordinates') { resp.tookMs = Date.now() - t0; return resp; }

  const has = (k: string) => it.ids.find((i) => i.kind === k)?.value;
  const q = text.replace(/^(?:accession|acc):\s*/i, '');

  // ---- NCBI ----
  if (want('ncbi')) {
    if (has('nuccore')) tasks.push({ db: 'ncbi', run: async () => {
      const s = await ncbi.nucSummary(has('nuccore')!, signal);
      return s ? [{ db: 'nuccore', id: s.accession, kind: 'dna', title: s.title, subtitle: `${s.accession} · ${s.length.toLocaleString()} bp · ${s.moltype || s.biomol}`, organism: s.organism, url: ncbi.sourceUrl.nuccore(s.accession), importable: true, badges: [s.completeness, s.sourceDb].filter(Boolean) }] : [];
    } });
    if (has('gene')) tasks.push({ db: 'ncbi', run: async () => {
      const g = await ncbi.geneSummary(has('gene')!, signal);
      return g ? [{ db: 'gene', id: g.geneId, kind: 'gene', title: `${g.symbol} – ${g.name}`, subtitle: `Gene ID ${g.geneId} · chr ${g.chromosome || '?'} ${g.mapLocation}`, organism: g.organism, url: ncbi.sourceUrl.gene(g.geneId), importable: true, badges: [g.type] }] : [];
    } });
    if (has('ncbi-protein')) tasks.push({ db: 'ncbi', run: async () => {
      const r = await up.uniprotByRefSeq(has('ncbi-protein')!, signal);
      return r.map((e) => ({ db: 'uniprot' as const, id: e.accession, kind: 'protein' as const, title: e.name, subtitle: `${e.accession} · ${e.length} aa · cross-referenced to ${has('ncbi-protein')}`, organism: e.organism, url: up.uniprotUrl(e.accession), importable: true, badges: [e.reviewed ? 'reviewed' : 'unreviewed'] }));
    } });
    if (it.type === 'text') {
      const sym = /^[A-Za-z][A-Za-z0-9\-]{1,14}$/.test(q);
      tasks.push({ db: 'ncbi', run: async () => {
        const rows = await ncbi.entrezSearch('gene', sym ? `${q}[Gene Name] AND alive[prop]` : `${q} AND alive[prop]`, 6, signal);
        return rows.map((g: any): Hit => ({ db: 'gene', id: String(g.uid), kind: 'gene', title: `${g.name} – ${g.description}`, subtitle: `Gene ID ${g.uid} · chr ${g.chromosome || '?'}`, organism: g.organism?.scientificname, url: ncbi.sourceUrl.gene(g.uid), importable: true }));
      } });
      tasks.push({ db: 'ncbi', run: async () => {
        const rows = await ncbi.entrezSearch('nuccore', `${q}${sym ? '' : ''} AND srcdb_refseq[prop]`, 5, signal);
        return rows.map((s: any): Hit => ({ db: 'nuccore', id: s.accessionversion ?? s.caption, kind: 'dna', title: s.title, subtitle: `${s.accessionversion} · ${Number(s.slen).toLocaleString()} bp`, organism: s.organism, url: ncbi.sourceUrl.nuccore(s.caption), importable: true, badges: ['RefSeq'] }));
      } });
    }
  }
  // ---- UniProt ----
  if (want('uniprot')) {
    const acc = has('uniprot');
    if (acc) tasks.push({ db: 'uniprot', run: async () => {
      const e = await up.uniprotEntry(acc, signal);
      return e ? [protHit(e)] : [];
    } });
    else if (it.type === 'text') tasks.push({ db: 'uniprot', run: async () => (await up.uniprotSearch(q, { size: 6, signal })).map(protHit) });
  }
  // ---- AlphaFold ----
  if (want('alphafold') && has('uniprot')) tasks.push({ db: 'alphafold', run: async () => {
    const ms = await alphafoldModels(has('uniprot')!, signal);
    return ms.slice(0, 1).map((m): Hit => ({ db: 'alphafold', id: m.entryId, kind: 'structure', title: `AlphaFold model ${m.entryId}`, subtitle: `${m.gene ?? m.uniprot} · mean pLDDT ${m.meanPlddt ?? 'n/a'} · v${m.version} · predicted structure`, organism: m.organism, url: afPage(m.uniprot), importable: false, badges: ['predicted'] }));
  } });
  // ---- PubChem ----
  if (want('pubchem')) {
    const key = has('inchikey') ?? has('inchi') ?? (has('pubchem') ? has('pubchem') : undefined);
    if (key || it.type === 'text') tasks.push({ db: 'pubchem', run: async () => {
      const cids = key ? await resolveChemical(key, signal) : (await cidsByName(q, signal)).slice(0, 5);
      const props = await propsForCids(cids.slice(0, 5), signal);
      return props.map((p): Hit => ({ db: 'pubchem', id: p.cid, kind: 'chemical', title: p.title || p.iupacName || `CID ${p.cid}`, subtitle: `CID ${p.cid} · ${p.formula} · ${p.molecularWeight ?? '?'} g/mol`, url: pubchemUrl(p.cid), importable: true, badges: [p.inchiKey] }));
    } });
  }
  // ---- RCSB PDB ----
  if (want('pdb')) {
    const id = has('pdb');
    if (id) tasks.push({ db: 'pdb', run: async () => { const e = await pdbEntry(id, signal); return e ? [pdbHit(e)] : []; } });
    else if (it.type === 'text') tasks.push({ db: 'pdb', run: async () => { const ids = await pdbSearchText(q, 5, signal); const es = await Promise.all(ids.map((i) => pdbEntry(i, signal))); return es.filter(Boolean).map((e) => pdbHit(e!)); } });
  }
  // ---- InterPro ----
  if (want('interpro')) {
    const id = has('interpro');
    if (id) tasks.push({ db: 'interpro', run: async () => { const e = await interproEntry(id, signal); return e ? [{ db: 'interpro', id: e.accession, kind: 'domain', title: e.name, subtitle: `${e.accession} · ${e.type}`, url: interproUrl(e.accession), importable: false } as Hit] : []; } });
    else if (it.type === 'text' && q.length >= 3) tasks.push({ db: 'interpro', run: async () => (await interproSearch(q, 5, signal)).map((e): Hit => ({ db: 'interpro', id: e.accession, kind: 'domain', title: e.name, subtitle: `${e.accession} · ${e.type}`, url: interproUrl(e.accession), importable: false })) });
  }
  // ---- ChEMBL (slow) ----
  if (want('chembl')) {
    const id = has('chembl');
    if (id) tasks.push({ db: 'chembl', run: async () => (await chembl.molecules([id], signal)).map((m): Hit => ({ db: 'chembl', id: m.id, kind: 'chemical', title: m.name || m.id, subtitle: `${m.id}${m.formula ? ' · ' + m.formula : ''}${m.phase !== null ? ' · max phase ' + m.phase : ''}`, url: chembl.chemblUrl(m.id), importable: false, badges: [m.inchiKey ?? ''] })) });
    else if (has('uniprot')) tasks.push({ db: 'chembl', run: async () => (await chembl.targetsForUniprot(has('uniprot')!, signal)).slice(0, 3).map((t): Hit => ({ db: 'chembl', id: t.id, kind: 'protein', title: `ChEMBL target ${t.name}`, subtitle: `${t.id} · ${t.type}`, organism: t.organism, url: chembl.chemblTargetUrl(t.id), importable: false })) });
    else if (it.type === 'text') tasks.push({ db: 'chembl', run: async () => {
      const j = await getJson<any>(`https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(q)}&limit=5`, { ttl: 3600, signal, timeoutMs: 120_000 });
      return (j?.molecules ?? []).map((m: any): Hit => ({ db: 'chembl', id: m.molecule_chembl_id, kind: 'chemical', title: m.pref_name || m.molecule_chembl_id, subtitle: `${m.molecule_chembl_id}${m.molecule_properties?.full_molformula ? ' · ' + m.molecule_properties.full_molformula : ''}`, url: chembl.chemblUrl(m.molecule_chembl_id), importable: false }));
    } });
  }
  // ---- BindingDB (slow, exact UniProt only) ----
  if (want('bindingdb') && has('uniprot')) tasks.push({ db: 'bindingdb', run: async () => {
    const r = await affinitiesForUniprot(has('uniprot')!, { cutoffNm: 1000, signal });
    if (r === null) throw new Error('service unavailable');
    return [{ db: 'bindingdb', id: has('uniprot')!, kind: 'protein', title: `BindingDB: ${r.length} ligand affinity record(s) ≤ 1 µM`, subtitle: 'Measured Ki/IC50/Kd values; import via "Find chemicals" on a protein record', url: `https://www.bindingdb.org/rwd/bind/chemsearch/marvin/SDFdownload.jsp?target=${has('uniprot')}`, importable: false }];
  } });

  const budget = 28_000;
  await Promise.all(tasks.map((t) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { errors.push({ db: t.db, message: 'timed out' }); resolve(); }, budget);
    t.run().then((h) => { clearTimeout(timer); hits.push(...h); resolve(); }, (e) => { clearTimeout(timer); errors.push({ db: t.db, message: (e as Error).message }); resolve(); });
  })));
  // exact-accession hits first, then relevance order from the sources
  resp.tookMs = Date.now() - t0;
  return resp;
}

function protHit(e: up.UniProtEntry): Hit {
  return { db: 'uniprot', id: e.accession, kind: 'protein', title: `${e.name}${e.geneSymbol ? ` (${e.geneSymbol})` : ''}`, subtitle: `${e.accession} · ${e.length} aa${e.pdb.length ? ` · ${e.pdb.length} PDB` : ''}${e.hasAlphaFold ? ' · AlphaFold' : ''}`, organism: e.organism, url: up.uniprotUrl(e.accession), importable: true, badges: [e.reviewed ? 'reviewed' : 'unreviewed'] };
}
function pdbHit(e: { id: string; title: string; method: string; resolution: number | null }): Hit {
  return { db: 'pdb', id: e.id, kind: 'structure', title: `${e.id} – ${short(e.title, 100)}`, subtitle: `${e.method}${e.resolution ? ` · ${e.resolution} Å` : ''} · experimental structure`, url: pdbUrl(e.id), importable: true, badges: ['experimental'] };
}
