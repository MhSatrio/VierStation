// Scripted NCBI for the Sequence Lab tests. The BLAST JSON, subject records, taxonomy and E-utilities answers are SYNTHETIC (generated from a seeded
// simulation so that the correct answer is known); the response SHAPES follow real NCBI output captured in tests/fixtures.
import { setFetch } from '../server/integrations/http.ts';
import { reverseComplement } from '../shared/sequence.ts';
import { mulberry32 } from '../server/phylo/run.ts';

export const calls: { method: string; url: string; body?: string }[] = [];
export const lab = { restrictedEmpty: false, failBlast: false, emptySubsetOnce: false, taxErrors: 0, noHits: false };

const rng = mulberry32(2024);
const rnd = (n: number) => Array.from({ length: n }, () => 'ACGT'[Math.floor(rng() * 4)]).join('');
function mutate(s: string, rate: number, r: () => number): string {
  const ts: Record<string, string> = { A: 'G', G: 'A', C: 'T', T: 'C' };
  return s.split('').map((c) => (r() < rate ? (r() < 0.65 ? ts[c] : 'ACGT'.replace(c, '').replace(ts[c], '')[Math.floor(r() * 2)]) : c)).join('');
}
export const ROOT = rnd(700);
/** Collection places GenBank states for some synthetic records (the rest state none). */
export const GEO: Record<string, string> = {
  'KX000001.1': '                     /lat_lon="8.5069 S 115.2625 E"\n                     /geo_loc_name="Indonesia: Bali, Ubud"',
  'KX000002.1': '                     /geo_loc_name="Indonesia: Bali, Ubud"',
  'KX000003.1': '                     /geo_loc_name="Japan"',
  'KX000004.1': '                     /geo_loc_name="Atlantis: Lost City"',
};
/** What the (fake) OpenStreetMap Nominatim answers, by query text. */
export const NOMINATIM_ANSWERS: Record<string, unknown[]> = {
  'Ubud, Bali, Indonesia': [{ lat: '-8.5069', lon: '115.2625', place_rank: 22, display_name: 'Ubud, Gianyar, Bali, Indonesia' }],
  'Jakarta, Indonesia': [{ lat: '-6.1754', lon: '106.8272', place_rank: 16, display_name: 'Jakarta, Indonesia' }],
  'Bali, Indonesia': [{ lat: '-8.4095', lon: '115.1889', place_rank: 8, display_name: 'Bali, Indonesia' }],
};
const r2 = mulberry32(77);
const FAM_X = mutate(ROOT, 0.03, r2), FAM_Y = mutate(ROOT, 0.14, r2);
const ALPHA = mutate(FAM_X, 0.02, r2), BETA = mutate(FAM_X, 0.05, r2), GAMMA = mutate(FAM_Y, 0.03, r2), DELTA = mutate(FAM_Y, 0.05, r2);

export interface Subj { acc: string; org: string; taxId: number; seq: string; flank5: string; flank3: string; minus?: boolean; genus: string; family: string; title?: string }
const mk = (acc: string, org: string, taxId: number, marker: string, genus: string, family: string, minus = false): Subj => ({ acc, org, taxId, seq: marker, flank5: rnd(150), flank3: rnd(120), genus, family, minus });
export const QUERY = mutate(ALPHA, 0.004, mulberry32(5)); // the "unknown": a Genus-alpha species-1 isolate
export const SUBJECTS: Subj[] = [
  mk('KX000001.1', 'Alphus primus', 1001, mutate(ALPHA, 0.002, mulberry32(11)), 'Alphus', 'Famx'),
  mk('KX000002.1', 'Alphus primus', 1001, mutate(ALPHA, 0.003, mulberry32(12)), 'Alphus', 'Famx'), // same species: must be de-duplicated
  mk('KX000003.1', 'Alphus secundus', 1002, mutate(ALPHA, 0.025, mulberry32(13)), 'Alphus', 'Famx', true), // stored on the minus strand
  mk('KX000004.1', 'Betus tertius', 1003, BETA, 'Betus', 'Famx'),
  mk('KX000005.1', 'uncultured Alphus sp.', 1004, mutate(ALPHA, 0.01, mulberry32(14)), 'Alphus', 'Famx'), // environmental: excluded
  mk('KX000006.1', 'Alphus quartus', 1005, mutate(ALPHA, 0.04, mulberry32(15)), 'Alphus', 'Famx'),
];
export const OUTGROUPS: Subj[] = [
  mk('KY000001.1', 'Gammus primus', 2001, GAMMA, 'Gammus', 'Famy'),
  mk('KY000002.1', 'Deltus primus', 2002, DELTA, 'Deltus', 'Famy'),
  mk('KY000003.1', 'Gammus secundus', 2003, mutate(GAMMA, 0.02, mulberry32(16)), 'Gammus', 'Famy'), // same genus as KY000001: skipped
  mk('KY000004.1', 'Epsilonus mislabeled', 2004, mutate(ALPHA, 0.001, mulberry32(17)), 'Epsilonus', 'Famy'), // looks like the ingroup (a mislabeled GenBank entry, as seen in real data): must not be offered as outgroup
];
export const CONGENERS: Subj[] = [
  mk('KZ000001.1', 'Alphus quintus', 1011, mutate(ALPHA, 0.06, mulberry32(21)), 'Alphus', 'Famx'),
  mk('KZ000002.1', 'Alphus sextus', 1012, mutate(ALPHA, 0.08, mulberry32(22)), 'Alphus', 'Famx'),
  mk('KZ000003.1', 'Alphus septimus', 1013, mutate(ALPHA, 0.09, mulberry32(23)), 'Alphus', 'Famx'),
];
const ALL = [...SUBJECTS, ...OUTGROUPS, ...CONGENERS];
const full = (s: Subj) => { const body = s.minus ? reverseComplement(s.seq) : s.seq; return s.flank5 + body + s.flank3; };

const taxNode = (id: number, name: string, rank: string) => `<Taxon><TaxId>${id}</TaxId><ScientificName>${name}</ScientificName><Rank>${rank}</Rank></Taxon>`;
function lineageXml(id: number): string {
  const s = ALL.find((x) => x.taxId === id);
  if (!s) return '';
  const famId = s.family === 'Famx' ? 500 : 600, genId = 7000 + id;
  const anc = [taxNode(1, 'cellular organisms', 'cellular root'), taxNode(2759, 'Eukaryota', 'domain'), taxNode(33208, 'Metazoa', 'kingdom'), taxNode(100, 'Ordo magnus', 'order'), taxNode(famId, s.family, 'family'), taxNode(genId, s.genus, 'genus')];
  return `<Taxon><TaxId>${id}</TaxId><ScientificName>${s.org}</ScientificName><Rank>species</Rank><GeneticCode><GCId>1</GCId><GCName>Standard</GCName></GeneticCode><Lineage>x</Lineage><LineageEx>${anc.join('')}</LineageEx></Taxon>`;
}

function hsp(s: Subj, query: string) {
  const sub = s.seq; const q = query;
  const n = Math.min(q.length, sub.length);
  let ident = 0, mid = '';
  for (let i = 0; i < n; i++) { const same = q[i] === sub[i]; if (same) ident++; mid += same ? '|' : ' '; }
  const off = s.flank5.length;
  const from = s.minus ? off + sub.length : off + 1, to = s.minus ? off + 1 : off + sub.length;
  // on the minus strand the subject region starts at the high coordinate; hit_strand tells the orientation
  return { bit_score: Math.round(2 * n * (ident / n) * 1.9), evalue: 0, identity: ident, align_len: n, gaps: 0, query_from: 1, query_to: n, hit_from: from, hit_to: to, hit_strand: s.minus ? 'Minus' : 'Plus', qseq: q.slice(0, n), hseq: sub.slice(0, n), midline: mid };
}
export function blastJson(subs: Subj[], query: string) {
  return { BlastOutput2: [{ report: { results: { search: { query_len: query.length, hits: subs.map((s, i) => ({ num: i + 1, description: [{ accession: s.acc, title: `${s.org} voucher isolate marker gene, partial sequence`, taxid: s.taxId, sciname: s.org }], len: full(s).length, hsps: [hsp(s, query)] })) } } } }] };
}

function genbank(s: Subj): string {
  const seq = full(s), rows = seq.match(/.{1,60}/g)!.map((r, i) => `${String(i * 60 + 1).padStart(9)} ${r.toLowerCase().match(/.{1,10}/g)!.join(' ')}`).join('\n');
  return `LOCUS       ${s.acc.split('.')[0]}  ${seq.length} bp    DNA     linear   INV 01-JAN-2020
DEFINITION  ${s.org} voucher isolate marker gene, partial sequence.
ACCESSION   ${s.acc.split('.')[0]}
VERSION     ${s.acc}
KEYWORDS    .
SOURCE      ${s.org}
  ORGANISM  ${s.org}
            Eukaryota; Metazoa; ${s.family}; ${s.genus}.
REFERENCE   1  (bases 1 to ${seq.length})
  AUTHORS   Tester,T. and Example,E.
  TITLE     A synthetic test article about ${s.org}
  JOURNAL   J Tests 1 (1), 1-2 (2020)
   PUBMED   12345678
REFERENCE   2  (bases 1 to ${seq.length})
  AUTHORS   Tester,T.
  TITLE     Direct Submission
  JOURNAL   Submitted (01-JAN-2020) Test Lab
COMMENT     Synthetic record used for tests.
FEATURES             Location/Qualifiers
     source          1..${seq.length}
                     /organism="${s.org}"
                     /mol_type="genomic DNA"
                     /db_xref="taxon:${s.taxId}"${GEO[s.acc] ? '\n' + GEO[s.acc] : ''}
ORIGIN
${rows}
//
`;
}

let lastEntrez = '';
let lastQuery = '';
export function installLabUpstream() {
  calls.length = 0; lab.restrictedEmpty = false; lab.failBlast = false; lab.emptySubsetOnce = false; lab.taxErrors = 0; lab.noHits = false;
  setFetch(async (rawUrl, init) => {
    const method = init?.method ?? 'GET'; const u = new URL(rawUrl); const p = u.searchParams;
    calls.push({ method, url: decodeURIComponent(rawUrl), body: init?.body as string | undefined });
    const text = (s: string, status = 200) => new Response(s, { status });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.host === 'blast.ncbi.nlm.nih.gov') {
      if (method === 'POST') {
        if (lab.failBlast) return text('<html>Message ID#4 Error: Query too short</html>');
        const b = new URLSearchParams(String(init?.body ?? '')); lastEntrez = b.get('ENTREZ_QUERY') ?? ''; lastQuery = (b.get('QUERY') ?? '').replace(/\s/g, '');
        return text(`<html>RID = LABRID${lastEntrez ? 'R' : 'M'}\n RTOE = 1\n</html>`);
      }
      if (p.get('FORMAT_OBJECT') === 'SearchInfo') return text('Status=READY\nThereAreHits=yes\n');
      if (lastEntrez && lab.emptySubsetOnce) { lab.emptySubsetOnce = false; return json({ BlastOutput2: [{ report: { results: { search: { query_len: lastQuery.length, hits: [], stat: { db_num: 0 }, message: 'No hits found' } } } }] }); } // what NCBI sometimes does (seen live)
      const only = /^txid(\d+)\[Organism:exp\]$/.exec(lastEntrez); // search restricted to ONE taxon (species typed by name)
      if (only) return json(blastJson(ALL.filter((x) => x.taxId === Number(only[1])), lastQuery));
      if (/^txid8\d{3}\[Organism:exp\] NOT/.test(lastEntrez)) return json(blastJson(CONGENERS, lastQuery)); // genus-restricted search for relatives
      if (/NOT txid/.test(lastEntrez)) return json(blastJson(lab.restrictedEmpty ? [] : OUTGROUPS, lastQuery));
      return json(blastJson(lab.noHits ? [] : SUBJECTS, lastQuery));
    }
    if (u.host === 'nominatim.openstreetmap.org') return json(NOMINATIM_ANSWERS[p.get('q') ?? ''] ?? []);
    if (u.host === 'eutils.ncbi.nlm.nih.gov') {
      const util = u.pathname.split('/').pop()!; const db = p.get('db');
      if (util === 'efetch.fcgi' && db === 'taxonomy') return text(`<?xml version="1.0"?><TaxaSet>${(p.get('id') ?? '').split(',').map((i) => lineageXml(Number(i))).join('')}</TaxaSet>`);
      if (util === 'esearch.fcgi' && db === 'taxonomy') { if (lab.taxErrors > 0) { lab.taxErrors--; return text('<html>Error 500</html>', 500); } const t = (p.get('term') ?? '').toLowerCase(); const s = ALL.find((x) => t.includes(`"${x.org.toLowerCase()}"`)); return json({ esearchresult: { idlist: s ? [String(s.taxId)] : [] } }); }
      if (util === 'efetch.fcgi' && db === 'nuccore' && p.get('rettype') === 'gb') { const g = ALL.find((x) => x.acc === p.get('id') || x.acc.split('.')[0] === p.get('id')); return g ? text(genbank(g)) : text('', 404); }
      if (util === 'efetch.fcgi' && db === 'nuccore' && p.get('rettype') === 'fasta') {
        const s = ALL.find((x) => x.acc === p.get('id') || x.acc.split('.')[0] === p.get('id')); if (!s) return text('', 404);
        let seq = full(s); const a = Number(p.get('seq_start') ?? 1), b = Number(p.get('seq_stop') ?? seq.length);
        seq = seq.slice(a - 1, b); if (p.get('strand') === '2') seq = reverseComplement(seq);
        return text(`>${s.acc} ${s.org}\n${seq.match(/.{1,70}/g)!.join('\n')}\n`);
      }
      if (util === 'esearch.fcgi' && db === 'nuccore') { const s = ALL.find((x) => (p.get('term') ?? '').includes(x.acc.split('.')[0])); return json({ esearchresult: { idlist: s ? [String(ALL.indexOf(s) + 100)] : [] } }); }
      if (util === 'esummary.fcgi' && db === 'nuccore') { const i = Number(p.get('id')) - 100; const s = ALL[i]; return json({ result: { uids: [p.get('id')], [p.get('id')!]: { accessionversion: s.acc, caption: s.acc, title: `${s.org} marker gene`, organism: s.org, taxid: s.taxId, slen: full(s).length, biomol: 'genomic', moltype: 'dna', completeness: 'partial', sourcedb: 'insd' } } }); }
    }
    return text(`unscripted upstream request: ${method} ${rawUrl}`, 599);
  });
}
