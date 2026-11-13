// A scripted stand-in for the scientific APIs, backed by REAL responses captured on 2026-11-05 (tests/fixtures).
// Only the data that must be synthetic (isoform FASTA, PubMed titles, BLAST JSON) is generated here, and says so.
import { fixture, fixtureJson } from './helpers.ts';
import { setFetch } from '../server/integrations/http.ts';

export interface Call { method: string; url: string; body?: string }
export const calls: Call[] = [];
export const IMATINIB_SMILES = JSON.parse(fixture('pc_props.json')).PropertyTable.Properties[0].SMILES as string;
export const mode = { chemblDown: false, afMissing: false, bindingdbDown: false, blastHits: true };

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const text = (s: string, status = 200) => new Response(s, { status });

export function installUpstream() {
  calls.length = 0;
  setFetch(async (rawUrl, init) => {
    const method = init?.method ?? 'GET';
    const url = decodeURIComponent(rawUrl);
    calls.push({ method, url, body: init?.body as string | undefined });
    const u = new URL(rawUrl);
    const p = u.searchParams;
    // ---- NCBI E-utilities ----
    if (u.host === 'eutils.ncbi.nlm.nih.gov') {
      const util = u.pathname.split('/').pop()!;
      const db = p.get('db');
      if (util === 'esearch.fcgi') {
        if (db === 'nuccore') return /NM_000546/.test(p.get('term') ?? '') ? text(fixture('esearch_nuc.json')) : json({ esearchresult: { idlist: [] } });
        if (db === 'gene') return text(fixture('esearch_gene.json'));
        return json({ esearchresult: { idlist: [] } });
      }
      if (util === 'esummary.fcgi') {
        if (db === 'nuccore') return text(fixture('esummary_nuc.json'));
        if (db === 'gene') return p.get('id') === '7157' ? text(fixture('esummary_gene.json')) : json({ result: { uids: [] } });
        if (db === 'taxonomy') return json({ result: { uids: ['9606'], 9606: { taxid: 9606, scientificname: 'Homo sapiens', commonname: 'human', rank: 'species' } } });
        if (db === 'pubmed') { const r: any = { uids: [] }; for (const id of (p.get('id') ?? '').split(',')) { r.uids.push(id); r[id] = { uid: id, title: `Synthetic test article ${id}`, pubdate: '2020 Jan', fulljournalname: 'Journal of Tests', articleids: [{ idtype: 'doi', value: `10.0000/test.${id}` }] }; } return json({ result: r }); }
      }
      if (util === 'efetch.fcgi') return db === 'nuccore' ? text(fixture('efetch_gb.txt')) : text('', 404);
      if (util === 'elink.fcgi') return p.get('dbfrom') === 'nuccore' ? text(fixture('elink_nuc_gene.json')) : json({ linksets: [{ linksetdbs: [] }] });
    }
    // ---- BLAST (synthetic result shaped like JSON2_S) ----
    if (u.host === 'blast.ncbi.nlm.nih.gov') {
      if (method === 'POST') return text('<html>RID = TESTRID1\n RTOE = 1\n</html>');
      if (p.get('FORMAT_OBJECT') === 'SearchInfo') return text('Status=READY\nThereAreHits=yes\n');
      const hit = mode.blastHits ? [{ num: 1, description: [{ accession: 'NM_000546', title: 'Homo sapiens tumor protein p53 (TP53), transcript variant 1, mRNA', taxid: 9606, sciname: 'Homo sapiens' }], len: 2512, hsps: [{ bit_score: 1900, evalue: 0, identity: 1000, align_len: 1000, gaps: 0, query_from: 1, query_to: 1000, hit_from: 143, hit_to: 1142, hit_strand: 'Plus' }] }] : [];
      return json({ BlastOutput2: [{ report: { results: { search: { query_len: 1000, hits: hit } } } }] });
    }
    // ---- UniProt ----
    if (u.host === 'rest.uniprot.org') {
      const query = p.get('query') ?? '';
      const iso = /\/uniprotkb\/(P\d+-\d+)\.fasta/.exec(u.pathname);
      if (iso) { const base = fixture('uniprot_P04637-2.fasta').split('\n').slice(1).join(''); return text(`>sp|${iso[1]}|X Isoform\n${base.slice(0, 120 + Number(iso[1].split('-')[1]) * 7)}\n`); }
      if (u.pathname.endsWith('/search')) {
        if (/geneid-7157|accession:P04637/.test(query)) return text(fixture('uniprot_geneid7157.json'));
        if (/accession:P00519/.test(query)) return text(fixture('uniprot_P00519.json'));
        return json({ results: [] });
      }
    }
    if ((u.host === 'alphafold.ebi.ac.uk' || u.host === 'files.rcsb.org') && /\.pdb$/.test(u.pathname)) return text(syntheticPdb());
    // ---- AlphaFold ----
    if (u.host === 'alphafold.ebi.ac.uk' && u.pathname.startsWith('/api/prediction/')) {
      const acc = u.pathname.split('/').pop();
      if (mode.afMissing) return text('', 404);
      if (acc === 'P04637') return text(fixture('af_P04637.json'));
      if (acc === 'P00519') return text(fixture('af_P00519.json'));
      return text('', 404);
    }
    // ---- InterPro ----
    if (u.host === 'www.ebi.ac.uk' && u.pathname.startsWith('/interpro/')) return /P04637/.test(u.pathname) ? text(fixture('interpro_P04637.json')) : json({ results: [] });
    // ---- ChEMBL ----
    if (u.host === 'www.ebi.ac.uk' && u.pathname.startsWith('/chembl/')) {
      if (mode.chemblDown) return text('<html>500</html>', 500);
      if (u.pathname.endsWith('target.json')) return text(fixture('chembl_targets_P00519.json'));
      if (u.pathname.endsWith('mechanism.json')) { // real ChEMBL mechanism list, first entry pointed at imatinib's parent compound so the sources can be reconciled
        const j = JSON.parse(fixture('chembl_mech_ABL1.json')); j.mechanisms[0].molecule_chembl_id = 'CHEMBL941'; return json(j);
      }
      if (u.pathname.endsWith('activity.json')) return text(fixture('chembl_act_ABL1.json'));
      if (u.pathname.endsWith('molecule.json')) return text(fixture('chembl_mol.json'));
    }
    // ---- BindingDB ----
    if (u.host === 'www.bindingdb.org') {
      if (mode.bindingdbDown) return text('Service Unavailable', 503);
      const j = JSON.parse(fixture('bindingdb_P00519.json')); // real rows + one imatinib row so BindingDB overlaps with ChEMBL and the PDB
      const arr = Object.values(Object.values(j)[0] as any)[0] as any[];
      arr.unshift({ query: 'Tyrosine-protein kinase ABL1', monomerid: '50000001', smile: IMATINIB_SMILES, affinity_type: 'Kd', affinity: '12', pmid: '11423618', doi: '' });
      return json(j);
    }
    // ---- RCSB ----
    if (u.host === 'data.rcsb.org') {
      if (u.pathname === '/graphql') return text(fixture('rcsb_gql_1IEP.json'));
      return text(fixture('rcsb_entry.json'));
    }
    if (u.host === 'search.rcsb.org') return text(fixture('rcsb_search.json'));
    // ---- PubChem ----
    if (u.host === 'pubchem.ncbi.nlm.nih.gov') {
      if (/assaysummary/.test(url)) return text(fixture('pc_assay.json'));
      if (/\/property\//.test(url)) return /\/cid\/5291\//.test(url) ? text(fixture('pc_props.json')) : json({ PropertyTable: { Properties: [] } });
      if (/synonyms/.test(url)) return json({ InformationList: { Information: [{ CID: 5291, Synonym: ['imatinib', 'Gleevec', 'STI-571'] }] } });
      if (/\/cids\//.test(url)) { // identity lookups only resolve for imatinib; any other structure/name is "not found", like PubChem for an unknown compound
        const known = method === 'POST' ? decodeURIComponent(String(init?.body ?? '')).includes(IMATINIB_SMILES) : /KTUFNOKKBVMGRW|imatinib/i.test(url);
        return known ? text(fixture('pc_cids.json')) : json({ Fault: { Code: 'PUGREST.NotFound' } }, 404);
      }
    }
    return text(`unscripted upstream request: ${method} ${url}`, 599);
  });
}

/** A 60-residue idealised alpha helix (CA/N/C/O atoms); the B-factor column ramps 95 -> 35 like AlphaFold pLDDT. Synthetic: used only to exercise the viewer. */
export function syntheticPdb(n = 60): string {
  const aa = ['ALA', 'LEU', 'GLU', 'LYS', 'GLY', 'SER'];
  const lines: string[] = [];
  let serial = 1;
  for (let i = 0; i < n; i++) {
    const ang = (i * 100 * Math.PI) / 180, x = 2.3 * Math.cos(ang), y = 2.3 * Math.sin(ang), z = i * 1.5, b = (95 - (60 * i) / n).toFixed(2).padStart(6);
    for (const [name, dx, dy, dz, el] of [['N', -0.9, -0.5, -0.6, 'N'], ['CA', 0, 0, 0, 'C'], ['C', 0.9, 0.5, 0.6, 'C'], ['O', 1.4, 0.8, 1.2, 'O']] as const) {
      lines.push(`ATOM  ${String(serial++).padStart(5)} ${name.padEnd(4)} ${aa[i % aa.length]} A${String(i + 1).padStart(4)}    ${(x + dx).toFixed(3).padStart(8)}${(y + dy).toFixed(3).padStart(8)}${(z + dz).toFixed(3).padStart(8)}  1.00${b}           ${el}`);
    }
  }
  return lines.join('\n') + '\nEND\n';
}

export const callsTo = (re: RegExp) => calls.filter((c) => re.test(c.url));
export { fixtureJson };
