// LIVE smoke check of every scientific integration against the real public APIs (read-only, polite, a handful of requests).
// Not part of `npm test` (needs internet; ChEMBL alone can take 20+ s). Run: npm run live
import { openDb } from '../../server/db.ts';
import { config } from '../../server/config.ts';
import * as ncbi from '../../server/integrations/ncbi.ts';
import * as up from '../../server/integrations/uniprot.ts';
import { alphafoldModels } from '../../server/integrations/alphafold.ts';
import * as pc from '../../server/integrations/pubchem.ts';
import * as chembl from '../../server/integrations/chembl.ts';
import { affinitiesForUniprot } from '../../server/integrations/bindingdb.ts';
import { pdbEntry, pdbIdsForUniprot, pdbLigands } from '../../server/integrations/rcsb.ts';
import { interproForProtein } from '../../server/integrations/interpro.ts';
import { classifyNucleotide } from '../../server/discovery/dna.ts';
import { cdsFrom, genesFrom } from '../../server/integrations/ncbi.ts';

config.offline = false;
openDb(':memory:');
const results: { name: string; ok: boolean; ms: number; detail: string }[] = [];
async function check(name: string, f: () => Promise<string>) {
  const t0 = performance.now();
  try { const d = await f(); results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail: d }); }
  catch (e) { results.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: (e as Error).message }); }
  const r = results[results.length - 1];
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${String(r.ms).padStart(6)} ms  ${r.detail}`);
}
const need = (c: unknown, m: string) => { if (!c) throw new Error(m); };

await check('NCBI nuccore summary NM_000546', async () => { const s = await ncbi.nucSummary('NM_000546'); need(s?.length === 2512, 'unexpected summary'); return `${s!.accession} ${s!.length} bp ${s!.organism}`; });
await check('NCBI GenBank parse + classify', async () => { const gb = (await ncbi.fetchGenBank('NM_000546.6'))!; const g = genesFrom(gb), c = cdsFrom(gb); need(g[0]?.geneId === '7157' && c[0]?.translation.length === 393, 'parse mismatch'); const cl = classifyNucleotide({ moltype: 'rna', biomol: 'mRNA', length: gb.length, genes: g, cds: c, featureTypes: [], sequence: gb.sequence }); return `${g[0].symbol} GeneID ${g[0].geneId}, CDS ${c[0].proteinId}, class ${cl.cls}`; });
await check('NCBI Gene 7157', async () => { const g = await ncbi.geneSummary('7157'); need(g?.symbol === 'TP53', 'not TP53'); return `${g!.symbol} ${g!.organism} chr ${g!.chromosome}`; });
await check('NCBI elink nuccore → gene', async () => { const s = (await ncbi.nucSummary('NM_000546'))!; const ids = await ncbi.geneIdsForNucleotide(s.uid); need(ids.includes('7157'), 'no link'); return ids.join(','); });
await check('NCBI RefSeq proteins of gene 7157', async () => { const p = await ncbi.refseqProteinsForGene('7157'); need(p.length > 0, 'none'); return `${p.length} proteins, first ${p[0].accession}`; });
await check('UniProt by GeneID 7157', async () => { const e = await up.uniprotByGeneId('7157'); need(e[0]?.accession === 'P04637', 'P04637 missing'); return `${e[0].accession} reviewed=${e[0].reviewed} isoforms=${e[0].isoforms.length} PDB=${e[0].pdb.length}`; });
await check('UniProt isoform FASTA P04637-2', async () => { const s = await up.isoformSequence('P04637-2'); need(s && s.length > 100, 'no sequence'); return `${s!.length} aa`; });
await check('AlphaFold DB P04637', async () => { const m = (await alphafoldModels('P04637'))[0]; need(m?.meanPlddt, 'no model'); return `${m.entryId} pLDDT ${m.meanPlddt} (${m.tool})`; });
await check('AlphaFold DB absent / malformed id', async () => { const m = await alphafoldModels('ZZZZZZ'); need(m.length === 0, 'expected none'); return 'handled as "no model"'; });
await check('InterPro P04637', async () => { const e = await interproForProtein('P04637'); need(e.some((x) => x.accession === 'IPR002117'), 'family missing'); return `${e.length} entries`; });
await check('RCSB entry 1IEP', async () => { const e = await pdbEntry('1IEP'); need(e?.method, 'no entry'); return `${e!.method} ${e!.resolution} Å`; });
await check('RCSB search by UniProt P00519', async () => { const ids = await pdbIdsForUniprot('P00519', 5); need(ids.length > 0, 'none'); return ids.join(','); });
await check('RCSB GraphQL ligands 1IEP', async () => { const l = await pdbLigands('1IEP'); need(l.some((x) => x.compId === 'STI'), 'STI missing'); return l.map((x) => x.compId).join(','); });
await check('PubChem name → CID → properties', async () => { const c = await pc.cidsByName('imatinib'); need(c[0] === '5291', 'cid'); const [p] = await pc.propsForCids(c); need(p.inchiKey === 'KTUFNOKKBVMGRW-UHFFFAOYSA-N', 'inchikey'); return `${p.title} ${p.formula} ${p.inchiKey}`; });
await check('PubChem SMILES → CID (POST)', async () => { const [p] = await pc.propsForCids(['5291']); const c = await pc.cidsBySmiles(p.smiles); need(c.includes('5291'), 'not found'); return c.join(','); });
await check('PubChem bioassay summary', async () => { const b = await pc.bioactivity('5291'); need(b && b.activeAssays > 0, 'none'); return `${b!.activeAssays}/${b!.totalAssays} active, ${b!.targets.length} targets`; });
await check('BindingDB ABL1 (service is flaky)', async () => { const r = await affinitiesForUniprot('P00519', { cutoffNm: 100 }); need(r !== null, 'service unavailable (reported as a warning in the app)'); return `${r!.length} affinities`; });
await check('ChEMBL target / mechanism / activity (slow)', async () => {
  const t = (await chembl.targetsForUniprot('P00519'))[0]; need(t?.id, 'no target');
  const m = await chembl.mechanisms(t.id); const a = await chembl.activities(t.id, { limit: 10, minPchembl: 8 });
  need(m.length > 0 && a.length > 0, 'empty'); return `${t.id} ${t.type}: ${m.length} mechanisms, ${a.length} activities (${chembl.classifyMechanism(m[0]).relationType})`;
});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) console.log('Failed: ' + failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
