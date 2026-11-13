// NCBI E-utilities (nuccore, gene, protein, taxonomy) and the BLAST URL API. Official, documented endpoints only.
import { config } from '../config.ts';
import { OfflineError, isOffline } from '../network.ts';
import { getJson, getText, request } from './http.ts';
import { sleep } from '../util.ts';
import { Fatal, RetryLater } from '../jobs.ts';
import { cleanSeq, stripVersion } from '../../shared/sequence.ts';

const EU = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function params(p: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') u.set(k, String(v));
  u.set('tool', config.toolName);
  if (config.contactEmail) u.set('email', config.contactEmail);
  if (config.ncbiApiKey) u.set('api_key', config.ncbiApiKey);
  return u.toString();
}
const eu = (util: string, p: Record<string, string | number | undefined>) => `${EU}/${util}.fcgi?${params(p)}`;

export const sourceUrl = {
  nuccore: (acc: string) => `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(acc)}`,
  gene: (id: string | number) => `https://www.ncbi.nlm.nih.gov/gene/${id}`,
  protein: (acc: string) => `https://www.ncbi.nlm.nih.gov/protein/${encodeURIComponent(acc)}`,
  taxonomy: (id: string | number) => `https://www.ncbi.nlm.nih.gov/datasets/taxonomy/${id}/`,
};

export interface NucSummary {
  uid: string; accession: string; title: string; organism: string; taxId: number | null; length: number; biomol: string; moltype: string;
  completeness: string; sourceDb: string; created: string; updated: string; topology: string; chromosome?: string;
}

/** Resolve an accession (with or without version) to its nuccore summary; null when it does not exist. */
export async function nucSummary(accession: string, signal?: AbortSignal): Promise<NucSummary | null> {
  let uid: string | undefined, failure: unknown;
  // NCBI answers some perfectly valid terms with HTTP 500 (seen live for "NR_037007.2[Accession]"); try the other spelling before giving up
  for (const term of [`${accession}[Accession]`, accession]) {
    try {
      const r = await getJson<any>(eu('esearch', { db: 'nuccore', term, retmode: 'json', retmax: 1 }), { ttl: 12 * 3600, signal });
      uid = r?.esearchresult?.idlist?.[0]; failure = undefined;
      if (uid) break;
    } catch (e) { if (((e as { status?: number }).status ?? 0) < 500) throw e; failure = e; }
  }
  if (!uid && failure) throw failure;
  if (!uid) return null;
  const sum = await getJson<any>(eu('esummary', { db: 'nuccore', id: uid, retmode: 'json' }), { ttl: 12 * 3600, signal });
  const r = sum?.result?.[uid];
  if (!r) return null;
  return {
    uid, accession: r.accessionversion ?? r.caption, title: r.title ?? '', organism: r.organism ?? '', taxId: r.taxid ?? null, length: Number(r.slen ?? 0),
    biomol: r.biomol ?? '', moltype: r.moltype ?? '', completeness: r.completeness ?? '', sourceDb: r.sourcedb ?? '', created: r.createdate ?? '', updated: r.updatedate ?? '',
    topology: r.topology ?? '', chromosome: r.subtype?.includes('chromosome') ? String(r.subname ?? '').split('|')[r.subtype.split('|').indexOf('chromosome')] : undefined,
  };
}

// ---------- GenBank flat file parsing ----------
export interface GbFeature { type: string; location: string; q: Record<string, string[]> }
export interface GenBank {
  accession: string; version: string; definition: string; length: number; molType: string; topology: string; division: string; date: string;
  organism: string; taxId: number | null; lineage: string; source: Record<string, string>; features: GbFeature[]; sequence: string; keywords: string;
  references: { title: string; authors: string; journal: string; pubmed: string | null }[]; dblink: Record<string, string>; comment: string;
}

export function parseGenBank(text: string): GenBank | null {
  if (!/^LOCUS/m.test(text)) return null;
  const locus = /^LOCUS\s+(\S+)\s+(\d+)\s+(bp|aa)\s+(?:(\S+)\s+)?(linear|circular)?\s*(\w{3})?\s*(\d{2}-\w{3}-\d{4})?/m.exec(text);
  const def = /^DEFINITION\s+([\s\S]*?)(?=^\S)/m.exec(text)?.[1].replace(/\s*\n\s*/g, ' ').trim() ?? '';
  const version = /^VERSION\s+(\S+)/m.exec(text)?.[1] ?? '';
  const accession = /^ACCESSION\s+(\S+)/m.exec(text)?.[1] ?? stripVersion(version);
  const keywords = /^KEYWORDS\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const lineage = /^\s+ORGANISM\s+[^\n]*\n([\s\S]*?)(?=^\S)/m.exec(text)?.[1].replace(/\s*\n\s*/g, ' ').trim() ?? '';
  const featText = /^FEATURES[^\n]*\n([\s\S]*?)(?=^(?:ORIGIN|CONTIG|BASE COUNT)\b)/m.exec(text)?.[1] ?? '';
  const features: GbFeature[] = [];
  let cur: GbFeature | null = null;
  let curKey: string | null = null;
  for (const line of featText.split('\n')) {
    if (/^ {5}\S/.test(line)) {
      const m = /^ {5}(\S+)\s+(.+)$/.exec(line);
      if (!m) continue;
      cur = { type: m[1], location: m[2].trim(), q: {} };
      features.push(cur); curKey = null;
    } else if (cur && /^ {21}\//.test(line)) {
      const m = /^ {21}\/([^=]+)(?:=(.*))?$/.exec(line);
      if (!m) continue;
      curKey = m[1];
      (cur.q[curKey] ??= []).push((m[2] ?? '').replace(/^"/, ''));
    } else if (cur && curKey && /^ {21}/.test(line)) {
      const arr = cur.q[curKey];
      const piece = line.slice(21);
      // location continuation (multi-line join(...)) when no qualifier yet
      arr[arr.length - 1] += (curKey === 'translation' ? '' : ' ') + piece.replace(/^"/, '');
    } else if (cur && !curKey && /^ {21}\S/.test(line)) cur.location += line.trim();
  }
  for (const f of features) for (const k of Object.keys(f.q)) f.q[k] = f.q[k].map((v) => v.replace(/"$/, '').trim());
  const src = features.find((f) => f.type === 'source');
  const source: Record<string, string> = {};
  if (src) for (const [k, v] of Object.entries(src.q)) source[k] = v.join('; ');
  const taxon = (src?.q.db_xref ?? []).find((x) => x.startsWith('taxon:'));
  const orig = /^ORIGIN[^\n]*\n([\s\S]*?)^\/\//m.exec(text)?.[1] ?? '';
  const header = text.slice(0, text.search(/^FEATURES/m) >= 0 ? text.search(/^FEATURES/m) : undefined);
  const references = header.split(/^REFERENCE.*$/m).slice(1).map((blk) => {
    // each block holds subkeys (AUTHORS/TITLE/JOURNAL/PUBMED…) indented by 2 spaces, continuation lines by 12; stop at the next top-level key
    const body = blk.split(/^(?=\S)/m)[0];
    const get = (k: string) => {
      const m = new RegExp(`^ {2,3}${k}\\s+([\\s\\S]*?)(?=^ {2,3}[A-Z]|$(?![\\s\\S]))`, 'm').exec(body);
      return m ? m[1].replace(/\s*\n\s*/g, ' ').trim() : '';
    };
    return { title: get('TITLE'), authors: get('AUTHORS'), journal: get('JOURNAL'), pubmed: get('PUBMED') || null };
  });
  const dblink: Record<string, string> = {};
  for (const m of header.matchAll(/^DBLINK\s+([\s\S]*?)(?=^\S)/gm)) for (const l of m[1].split('\n')) { const kv = /^\s*([^:]+):\s*(.+)$/.exec(l); if (kv) dblink[kv[1].trim()] = kv[2].trim(); }
  const comment = /^COMMENT\s+([\s\S]*?)(?=^\S)/m.exec(header)?.[1]?.replace(/\s*\n\s*/g, ' ').trim() ?? '';
  return {
    accession, version, definition: def.replace(/\.$/, ''), length: Number(locus?.[2] ?? 0), molType: locus?.[4] ?? '', topology: locus?.[5] ?? '', division: locus?.[6] ?? '', date: locus?.[7] ?? '',
    organism: src?.q.organism?.[0] ?? '', taxId: taxon ? Number(taxon.slice(6)) : null, lineage, source, features, sequence: cleanSeq(orig), keywords, references, dblink, comment,
  };
}

export async function fetchGenBank(accession: string, o: { from?: number; to?: number; signal?: AbortSignal } = {}): Promise<GenBank | null> {
  const text = await getText(eu('efetch', { db: 'nuccore', id: accession, rettype: 'gb', retmode: 'text', seq_start: o.from, seq_stop: o.to }), { ttl: 24 * 3600, signal: o.signal, timeoutMs: 90_000 });
  if (!text) return null;
  return parseGenBank(text);
}

export async function fetchFasta(db: 'nuccore' | 'protein', accession: string, o: { from?: number; to?: number; strand?: 1 | 2; signal?: AbortSignal } = {}): Promise<string | null> {
  const t = await getText(eu('efetch', { db, id: accession, rettype: 'fasta', retmode: 'text', seq_start: o.from, seq_stop: o.to, strand: o.strand }), { ttl: 24 * 3600, signal: o.signal, timeoutMs: 90_000 });
  if (!t || !t.startsWith('>')) return null;
  return t;
}

/** Features that matter for discovery, extracted from a GenBank record. */
export interface GbGene { symbol: string; geneId: string | null; synonyms: string[]; description: string; location: string; partial: boolean; pseudo: boolean }
export interface GbCds { gene: string | null; geneId: string | null; product: string; proteinId: string | null; translation: string; location: string; codonStart: number; partial: boolean; note: string; complement: boolean }

export function genesFrom(gb: GenBank): GbGene[] {
  const seen = new Set<string>();
  const out: GbGene[] = [];
  for (const f of gb.features) {
    if (f.type !== 'gene') continue;
    const symbol = f.q.gene?.[0] ?? f.q.locus_tag?.[0] ?? '';
    const geneId = (f.q.db_xref ?? []).find((x) => x.startsWith('GeneID:'))?.slice(7) ?? null;
    const key = geneId ?? symbol + f.location;
    if (!symbol && !geneId || seen.has(key)) continue;
    seen.add(key);
    out.push({
      symbol, geneId, synonyms: (f.q.gene_synonym?.[0] ?? '').split(/;\s*/).filter(Boolean), description: f.q.note?.[0] ?? '', location: f.location,
      partial: /[<>]/.test(f.location), pseudo: 'pseudo' in f.q || 'pseudogene' in f.q,
    });
  }
  return out;
}
export function cdsFrom(gb: GenBank): GbCds[] {
  const out: GbCds[] = [];
  for (const f of gb.features) {
    if (f.type !== 'CDS') continue;
    out.push({
      gene: f.q.gene?.[0] ?? null, geneId: (f.q.db_xref ?? []).find((x) => x.startsWith('GeneID:'))?.slice(7) ?? null, product: f.q.product?.[0] ?? '',
      proteinId: f.q.protein_id?.[0] ?? null, translation: cleanSeq(f.q.translation?.[0] ?? ''), location: f.location, codonStart: Number(f.q.codon_start?.[0] ?? 1),
      partial: /[<>]/.test(f.location), note: f.q.note?.[0] ?? '', complement: f.location.startsWith('complement'),
    });
  }
  return out;
}

/** "source" qualifiers worth keeping as collection information. */
export function collectionInfo(gb: GenBank): string {
  const keys = ['strain', 'isolate', 'cultivar', 'serovar', 'host', 'isolation_source', 'geo_loc_name', 'country', 'lat_lon', 'collection_date', 'collected_by', 'tissue_type', 'cell_line', 'chromosome', 'map', 'plasmid', 'segment'];
  return keys.filter((k) => gb.source[k]).map((k) => `${k.replace(/_/g, ' ')}: ${gb.source[k]}`).join('\n');
}

// ---------- Gene ----------
export interface GeneInfo {
  geneId: string; symbol: string; name: string; description: string; organism: string; taxId: number | null; chromosome: string; mapLocation: string;
  aliases: string[]; summary: string; type: string; genomic: { accession: string; start: number; stop: number } | null; mim: string[];
}
export async function geneSummary(geneId: string, signal?: AbortSignal): Promise<GeneInfo | null> {
  const r = await getJson<any>(eu('esummary', { db: 'gene', id: geneId, retmode: 'json' }), { ttl: 24 * 3600, signal });
  const g = r?.result?.[geneId];
  if (!g || g.error) return null;
  const gi = g.genomicinfo?.[0];
  return {
    geneId: String(g.uid), symbol: g.name ?? '', name: g.nomenclaturename || g.description || '', description: g.description ?? '', organism: g.organism?.scientificname ?? '', taxId: g.organism?.taxid ?? null,
    chromosome: g.chromosome ?? '', mapLocation: g.maplocation ?? '', aliases: String(g.otheraliases ?? '').split(/,\s*/).filter(Boolean), summary: g.summary ?? '',
    type: geneTypeOf(g), genomic: gi ? { accession: gi.chraccver, start: gi.chrstart, stop: gi.chrstop } : null, mim: g.mim ?? [],
  };
}
function geneTypeOf(g: any): string {
  const t = String(g.genetype ?? '').toLowerCase();
  if (t) return t === 'protein-coding' ? 'protein-coding' : t;
  return g.description?.toLowerCase().includes('pseudogene') ? 'pseudo' : 'protein-coding';
}

export async function findGene(symbol: string, taxId?: number | string, signal?: AbortSignal): Promise<string | null> {
  const term = `${symbol}[Gene Name]` + (taxId ? ` AND ${taxId}[Taxonomy ID]` : '') + ' AND alive[prop]';
  const r = await getJson<any>(eu('esearch', { db: 'gene', term, retmode: 'json', retmax: 1 }), { ttl: 12 * 3600, signal });
  return r?.esearchresult?.idlist?.[0] ?? null;
}

/** Gene IDs that NCBI links to a nucleotide record. */
export async function geneIdsForNucleotide(uid: string, signal?: AbortSignal): Promise<string[]> {
  const r = await getJson<any>(eu('elink', { dbfrom: 'nuccore', db: 'gene', id: uid, retmode: 'json' }), { ttl: 12 * 3600, signal });
  return (r?.linksets?.[0]?.linksetdbs ?? []).flatMap((l: any) => l.links ?? []).map(String);
}

export interface RefSeqProtein { accession: string; title: string; length: number; organism: string }
export async function refseqProteinsForGene(geneId: string, signal?: AbortSignal): Promise<RefSeqProtein[]> {
  const l = await getJson<any>(eu('elink', { dbfrom: 'gene', db: 'protein', id: geneId, linkname: 'gene_protein_refseq', retmode: 'json' }), { ttl: 12 * 3600, signal });
  const ids: string[] = (l?.linksets?.[0]?.linksetdbs ?? []).flatMap((x: any) => x.links ?? []).slice(0, 40);
  if (!ids.length) return [];
  const s = await getJson<any>(eu('esummary', { db: 'protein', id: ids.join(','), retmode: 'json' }), { ttl: 12 * 3600, signal });
  return ids.map((id) => s?.result?.[id]).filter(Boolean).map((p: any) => ({ accession: p.accessionversion ?? p.caption, title: p.title ?? '', length: Number(p.slen ?? 0), organism: p.organism ?? '' }));
}

export async function taxonomyName(taxId: number | string, signal?: AbortSignal): Promise<{ taxId: number; scientificName: string; commonName: string; rank: string; lineage: string } | null> {
  const r = await getJson<any>(eu('esummary', { db: 'taxonomy', id: taxId, retmode: 'json' }), { ttl: 7 * 24 * 3600, signal });
  const t = r?.result?.[String(taxId)];
  if (!t || t.error) return null;
  return { taxId: Number(t.taxid), scientificName: t.scientificname ?? '', commonName: t.commonname ?? '', rank: t.rank ?? '', lineage: '' };
}

export interface TaxNode { taxId: number; name: string; rank: string }
export interface TaxLineage { taxId: number; name: string; rank: string; lineage: TaxNode[]; geneticCode: string }
const xmlText = (s: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1]?.trim() ?? '';
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Parse `efetch db=taxonomy` XML (one <Taxon> per requested id). Exported for tests with recorded fixtures. */
export function parseTaxonomyXml(xml: string): TaxLineage[] {
  const out: TaxLineage[] = [];
  const top = xml.replace(/<LineageEx>[\s\S]*?<\/LineageEx>/g, (m) => m.replace(/<(\/?)Taxon>/g, '<$1Anc>')); // keep ancestors from confusing the top-level split
  for (const blk of top.split(/(?=<Taxon>)/).filter((b) => b.startsWith('<Taxon>'))) {
    const ancestors = [...(/<LineageEx>([\s\S]*?)<\/LineageEx>/.exec(blk)?.[1] ?? '').matchAll(/<Anc>([\s\S]*?)<\/Anc>/g)].map((m) => ({ taxId: Number(xmlText(m[1], 'TaxId')), name: unxml(xmlText(m[1], 'ScientificName')), rank: xmlText(m[1], 'Rank') }));
    const head = blk.replace(/<LineageEx>[\s\S]*?<\/LineageEx>/, '');
    out.push({ taxId: Number(xmlText(head, 'TaxId')), name: unxml(xmlText(head, 'ScientificName')), rank: xmlText(head, 'Rank'), lineage: ancestors, geneticCode: xmlText(xmlText(head, 'GeneticCode'), 'GCName') });
  }
  return out;
}
/** Full lineage (with ranks and ids) for taxon ids; cached 7 days. */
export async function taxonomyLineage(taxIds: (number | string)[], signal?: AbortSignal): Promise<TaxLineage[]> {
  const ids = [...new Set(taxIds.map(String))].filter((x) => /^\d+$/.test(x));
  const out: TaxLineage[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const xml = await getText(eu('efetch', { db: 'taxonomy', id: ids.slice(i, i + 50).join(','), retmode: 'xml' }), { ttl: 7 * 24 * 3600, signal, timeoutMs: 60_000 });
    if (xml) out.push(...parseTaxonomyXml(xml));
  }
  return out;
}

/**
 * Resolve a name typed by a person to NCBI Taxonomy: exact scientific name first, then synonyms / common names.
 * NCBI's E-utilities answer valid taxonomy queries with HTTP 500 now and then (seen live), so each spelling is retried; if NCBI never ANSWERED,
 * `unavailable` is true and the caller must not report the name as unknown.
 */
export async function taxonomyByName(name: string, signal?: AbortSignal): Promise<{ via: string; taxa: TaxLineage[]; unavailable: boolean }> {
  const clean = name.trim().replace(/\s+/g, ' ').replace(/["[\]]/g, '');
  if (!clean) return { via: '', taxa: [], unavailable: false };
  let answered = false;
  for (const [via, term] of [['scientific name', `"${clean}"[Scientific Name]`], ['synonym or common name', `${clean}[All Names]`], ['synonym or common name', `"${clean}"[All Names]`]] as const) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let s: any;
      try { s = await getJson<any>(eu('esearch', { db: 'taxonomy', term, retmode: 'json', retmax: 5 }), { ttl: 24 * 3600, signal }); }
      catch (e) {
        const st = (e as { status?: number }).status;
        if (st === undefined || st < 500) throw e;
        await sleep(config.retryBaseMs * (attempt + 1), signal); continue;
      }
      answered = true;
      const ids: string[] = (s?.esearchresult?.idlist ?? []).map(String);
      if (ids.length) { const lin = await taxonomyLineage(ids, signal); return { via, taxa: ids.map((i) => lin.find((l) => String(l.taxId) === i)).filter((x): x is TaxLineage => !!x), unavailable: false }; }
      break; // NCBI answered "no such name" for this spelling: try the next spelling, do not repeat
    }
  }
  return { via: '', taxa: [], unavailable: !answered };
}

/** Generic Entrez text search returning small summaries – used by the unified search box. */
export async function entrezSearch(db: 'nuccore' | 'gene' | 'protein', term: string, retmax = 8, signal?: AbortSignal): Promise<any[]> {
  let s: any;
  try { s = await getJson<any>(eu('esearch', { db, term, retmode: 'json', retmax, sort: db === 'gene' ? undefined : 'relevance' }), { ttl: 3600, signal }); }
  catch (e) {
    // NCBI answers some perfectly valid terms with HTTP 500 when sort=relevance is requested (seen live on 2026-11-05); the default ordering works, so fall back to it
    if (db === 'gene' || (e as { status?: number }).status === undefined || (e as { status?: number }).status! < 500) throw e;
    s = await getJson<any>(eu('esearch', { db, term, retmode: 'json', retmax }), { ttl: 3600, signal });
  }
  const ids: string[] = s?.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const sum = await getJson<any>(eu('esummary', { db, id: ids.join(','), retmode: 'json' }), { ttl: 3600, signal });
  return ids.map((id) => sum?.result?.[id]).filter(Boolean);
}

// ---------- BLAST (URL API) ----------
export interface BlastHsp { bitScore: number; evalue: number; identity: number; alignLen: number; gaps: number; mismatches: number; queryFrom: number; queryTo: number; hitFrom: number; hitTo: number; strand: string; qseq?: string; hseq?: string; midline?: string }
export interface BlastHit { accession: string; title: string; taxId: number | null; organism: string; length: number; hsps: BlastHsp[]; bestIdentityPct: number; queryCoveragePct: number }
export interface BlastResult { rid: string; db: string; queryLength: number; hits: BlastHit[]; /** number of database sequences NCBI actually searched (0 = the taxon restriction matched nothing, which NCBI sometimes reports transiently) */ dbSequences?: number; message?: string }

const BLAST = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi';

export async function blastSubmit(seq: string, o: { db: string; program?: string; hitlist?: number; entrez?: string; expect?: number; megablast?: boolean; jobTitle?: string; signal?: AbortSignal }): Promise<{ rid: string; rtoe: number }> {
  const body = new URLSearchParams({
    CMD: 'Put', PROGRAM: o.program ?? 'blastn', DATABASE: o.db, QUERY: seq, HITLIST_SIZE: String(o.hitlist ?? 8), FORMAT_TYPE: 'JSON2_S', tool: config.toolName,
  });
  if ((o.program ?? 'blastn') === 'blastn' && o.megablast !== false) body.set('MEGABLAST', 'on'); // fast, high-identity search for nucleotides (off = traditional blastn, more sensitive)
  if (o.expect !== undefined) body.set('EXPECT', String(o.expect));
  if (o.entrez) body.set('ENTREZ_QUERY', o.entrez);
  if (o.jobTitle) body.set('JOB_TITLE', o.jobTitle.slice(0, 80)); // a distinct title makes NCBI run a fresh search instead of returning the cached RID of an identical one
  if (config.contactEmail) body.set('email', config.contactEmail);
  const r = await request(BLAST, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, accept: 'text/html', retries: 1, signal: o.signal });
  const rid = /RID = (\S+)/.exec(r.text)?.[1];
  const rtoe = Number(/RTOE = (\d+)/.exec(r.text)?.[1] ?? 15);
  if (!rid) {
    const err = /Message ID#\d+ Error: ([^\n<]+)/.exec(r.text)?.[1];
    throw new Fatal(`NCBI BLAST rejected the query${err ? ': ' + err : ''}`);
  }
  return { rid, rtoe };
}

export async function blastStatus(rid: string, signal?: AbortSignal): Promise<'WAITING' | 'READY' | 'FAILED' | 'UNKNOWN'> {
  const r = await request(`${BLAST}?CMD=Get&RID=${rid}&FORMAT_OBJECT=SearchInfo&tool=${config.toolName}`, { accept: 'text/html', signal });
  const st = /Status=(\w+)/.exec(r.text)?.[1];
  if (st === 'READY') return /ThereAreHits=yes/.test(r.text) ? 'READY' : 'READY';
  return (st as any) ?? 'UNKNOWN';
}

export async function blastFetch(rid: string, db: string, signal?: AbortSignal): Promise<BlastResult> {
  const r = await request(`${BLAST}?CMD=Get&RID=${rid}&FORMAT_TYPE=JSON2_S&tool=${config.toolName}`, { accept: 'application/json', signal, timeoutMs: 90_000 });
  let j: any;
  try { j = JSON.parse(r.text); } catch { throw new Error('BLAST returned an unreadable result'); }
  return parseBlast(j, rid, db);
}

export function parseBlast(j: any, rid: string, db: string): BlastResult {
  const search = j?.BlastOutput2?.[0]?.report?.results?.search;
  const qlen = Number(search?.query_len ?? 0);
  const hits: BlastHit[] = (search?.hits ?? []).map((h: any): BlastHit => {
    const d = h.description?.[0] ?? {};
    const hsps: BlastHsp[] = (h.hsps ?? []).map((x: any) => ({
      bitScore: x.bit_score, evalue: x.evalue, identity: x.identity, alignLen: x.align_len, gaps: x.gaps ?? 0, mismatches: Math.max(0, (x.align_len ?? 0) - (x.identity ?? 0) - (x.gaps ?? 0)), queryFrom: x.query_from, queryTo: x.query_to,
      hitFrom: x.hit_from, hitTo: x.hit_to, strand: x.hit_strand ?? 'Plus', qseq: x.qseq, hseq: x.hseq, midline: x.midline,
    }));
    const best = hsps[0];
    const covered = new Set<number>();
    for (const x of hsps) for (let i = Math.min(x.queryFrom, x.queryTo); i <= Math.max(x.queryFrom, x.queryTo) && covered.size <= qlen; i += 1) covered.add(i);
    return {
      accession: d.accession ?? '', title: d.title ?? '', taxId: d.taxid ?? null, organism: d.sciname ?? '', length: Number(h.len ?? 0), hsps,
      bestIdentityPct: best ? Math.round((best.identity / Math.max(1, best.alignLen)) * 1000) / 10 : 0,
      queryCoveragePct: qlen ? Math.round((Math.min(covered.size, qlen) / qlen) * 1000) / 10 : 0,
    };
  });
  return { rid, db, queryLength: qlen, hits, dbSequences: typeof search?.stat?.db_num === 'number' ? search.stat.db_num : undefined, message: typeof search?.message === 'string' ? search.message : undefined };
}

/**
 * Full BLAST run with polite polling. `onWait` lets the job report real status. Honors NCBI guidance:
 * wait the estimated time (RTOE) and then poll no more than once a minute… we poll every 20 s which NCBI tolerates for a handful of jobs.
 */
export async function blastRun(seq: string, o: { db: string; program?: string; entrez?: string; expect?: number; megablast?: boolean; hitlist?: number; signal?: AbortSignal; onWait?: (msg: string) => void; maxWaitMs?: number }): Promise<BlastResult> {
  if (config.offline && process.env.VIERSTATION_TEST !== '1') throw new OfflineError('NCBI BLAST');
  if (isOffline()) throw new OfflineError('NCBI BLAST');
  const once = async (jobTitle?: string): Promise<BlastResult> => {
    const { rid, rtoe } = await blastSubmit(seq, { ...o, jobTitle });
    o.onWait?.(`BLAST submitted (RID ${rid}), estimated ${rtoe}s`);
    const t0 = Date.now();
    await sleep(Math.max(config.blastMinWaitMs, Math.min(rtoe * 1000, 60_000)), o.signal);
    for (;;) {
      const st = await blastStatus(rid, o.signal);
      if (st === 'READY') return blastFetch(rid, o.db, o.signal);
      if (st === 'FAILED') throw new Fatal(`BLAST search ${rid} failed on the NCBI side`);
      if (st === 'UNKNOWN') throw new Fatal(`BLAST search ${rid} expired or is unknown`);
      if (Date.now() - t0 > (o.maxWaitMs ?? 8 * 60_000)) throw new RetryLater('BLAST is taking longer than expected', 60_000);
      o.onWait?.(`BLAST still running (${Math.round((Date.now() - t0) / 1000)}s)`);
      await sleep(config.blastPollMs, o.signal);
    }
  };
  let res = await once();
  // NCBI occasionally answers a taxon-restricted search with "0 sequences searched" (seen live); run it again as a fresh search (up to twice) before believing it
  for (let again = 1; again <= 2 && o.entrez && res.dbSequences === 0 && !res.hits.length; again++) {
    o.onWait?.(`NCBI reported that the taxon restriction matched no database sequences – repeating the search (${again}/2)`);
    res = await once(`VierStation retry ${again} ${Date.now().toString(36)}`);
  }
  return res;
}
