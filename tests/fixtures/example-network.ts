// Example network used by the browser tests and by `npm run seed:example`: a glycolysis-style slice of metabolism, written as DATA. The loader below is generic
// (it knows nothing about glycolysis) and goes through the public API only. These are illustrative records for trying the Explorer – NOT a curated database.
// Evidence classes are deliberately mixed (experimental, annotated, literature, predicted) so that every line style appears.
import type { Api } from '../helpers.ts';

export interface ExampleReaction { name: string; reversible: 'Irreversible' | 'Reversible' | 'Unknown'; ec?: string; parts: [string, string, number?][] }
export interface ExampleNetwork {
  chemicals: string[]; metabolites: string[]; enzymes: string[]; genes: string[]; organisms: string[]; publications: string[];
  reactions: ExampleReaction[];
  pathways: { name: string; steps: string[]; edges?: [string, string, 'next' | 'alternative'][]; linear?: boolean; tags?: string[] }[];
  relationships: { from: string; to: string; type: string; evidence: string; description?: string; tags?: string[]; organism?: string; citations?: { kind: string; value: string }[]; sourceDb?: string }[];
}

export const GLYCOLYSIS_EXAMPLE: ExampleNetwork = {
  metabolites: ['Glucose', 'Glucose-6-phosphate', 'Fructose-6-phosphate', 'Fructose-1,6-bisphosphate', 'Dihydroxyacetone phosphate', 'Glyceraldehyde-3-phosphate', '1,3-Bisphosphoglycerate', '3-Phosphoglycerate', '6-Phosphogluconolactone'],
  chemicals: ['ATP', 'ADP', 'NAD+', 'NADH', 'NADP+', 'NADPH', 'Phosphate', 'Mg2+', 'Citrate', 'Candidate inhibitor 17'],
  enzymes: ['Hexokinase', 'Glucose-6-phosphate isomerase', 'Phosphofructokinase', 'Fructose-bisphosphate aldolase', 'Triose-phosphate isomerase', 'GAPDH', 'Phosphoglycerate kinase', 'Glucose-6-phosphate dehydrogenase'],
  genes: ['HK1', 'PFKM'], organisms: ['Homo sapiens'], publications: ['Hexokinase kinetics (example)', 'Phosphofructokinase regulation (example)'],
  reactions: [
    { name: 'Hexokinase reaction', reversible: 'Irreversible', ec: '2.7.1.1', parts: [['Glucose', 'reactant'], ['ATP', 'reactant'], ['Glucose-6-phosphate', 'product'], ['ADP', 'product'], ['Hexokinase', 'enzyme'], ['Mg2+', 'cofactor']] },
    { name: 'Glucose-6-phosphate isomerase reaction', reversible: 'Reversible', ec: '5.3.1.9', parts: [['Glucose-6-phosphate', 'reactant'], ['Fructose-6-phosphate', 'product'], ['Glucose-6-phosphate isomerase', 'enzyme']] },
    { name: 'Phosphofructokinase reaction', reversible: 'Irreversible', ec: '2.7.1.11', parts: [['Fructose-6-phosphate', 'reactant'], ['ATP', 'reactant'], ['Fructose-1,6-bisphosphate', 'product'], ['ADP', 'product'], ['Phosphofructokinase', 'enzyme'], ['Citrate', 'inhibitor']] },
    { name: 'Aldolase reaction', reversible: 'Reversible', ec: '4.1.2.13', parts: [['Fructose-1,6-bisphosphate', 'reactant'], ['Dihydroxyacetone phosphate', 'product'], ['Glyceraldehyde-3-phosphate', 'product'], ['Fructose-bisphosphate aldolase', 'enzyme']] },
    { name: 'Triose-phosphate isomerase reaction', reversible: 'Reversible', ec: '5.3.1.1', parts: [['Dihydroxyacetone phosphate', 'reactant'], ['Glyceraldehyde-3-phosphate', 'product'], ['Triose-phosphate isomerase', 'enzyme']] },
    { name: 'GAPDH reaction', reversible: 'Reversible', ec: '1.2.1.12', parts: [['Glyceraldehyde-3-phosphate', 'reactant'], ['NAD+', 'reactant'], ['Phosphate', 'reactant'], ['1,3-Bisphosphoglycerate', 'product'], ['NADH', 'product'], ['GAPDH', 'enzyme']] },
    { name: 'Phosphoglycerate kinase reaction', reversible: 'Reversible', ec: '2.7.2.3', parts: [['1,3-Bisphosphoglycerate', 'reactant'], ['ADP', 'reactant'], ['3-Phosphoglycerate', 'product'], ['ATP', 'product'], ['Phosphoglycerate kinase', 'enzyme']] },
    { name: 'Glucose-6-phosphate dehydrogenase reaction', reversible: 'Irreversible', ec: '1.1.1.49', parts: [['Glucose-6-phosphate', 'reactant'], ['NADP+', 'reactant'], ['6-Phosphogluconolactone', 'product'], ['NADPH', 'product'], ['Glucose-6-phosphate dehydrogenase', 'enzyme']] },
  ],
  pathways: [
    { name: 'Glycolysis (example)', tags: ['Glycolysis'], steps: ['Hexokinase reaction', 'Glucose-6-phosphate isomerase reaction', 'Phosphofructokinase reaction', 'Aldolase reaction', 'Triose-phosphate isomerase reaction', 'GAPDH reaction', 'Phosphoglycerate kinase reaction'],
      edges: [['Hexokinase reaction', 'Glucose-6-phosphate isomerase reaction', 'next'], ['Glucose-6-phosphate isomerase reaction', 'Phosphofructokinase reaction', 'next'], ['Phosphofructokinase reaction', 'Aldolase reaction', 'next'], ['Aldolase reaction', 'Triose-phosphate isomerase reaction', 'alternative'], ['Aldolase reaction', 'GAPDH reaction', 'next'], ['Triose-phosphate isomerase reaction', 'GAPDH reaction', 'next'], ['GAPDH reaction', 'Phosphoglycerate kinase reaction', 'next']] },
    { name: 'Glucose utilisation (order not recorded)', tags: ['Glucose metabolism'], steps: ['Hexokinase reaction', 'Glucose-6-phosphate dehydrogenase reaction'] },
  ],
  relationships: [
    { from: 'Glucose', to: 'Hexokinase', type: 'Substrate of', evidence: 'experimentally_verified', description: 'Glucose is phosphorylated by hexokinase.', tags: ['Glycolysis'], organism: 'Homo sapiens', citations: [{ kind: 'doi', value: '10.1000/example.hexokinase' }] },
    { from: 'ATP', to: 'Hexokinase', type: 'Substrate of', evidence: 'database_annotated', sourceDb: 'UniProt', tags: ['Glycolysis'] },
    { from: 'Glucose', to: 'Hexokinase', type: 'Binds to', evidence: 'literature_reported', citations: [{ kind: 'pmid', value: '1234567' }] },
    { from: 'Citrate', to: 'Phosphofructokinase', type: 'Inhibits', evidence: 'literature_reported', description: 'Allosteric inhibition reported in the literature (example entry).', tags: ['Glycolysis'], citations: [{ kind: 'pmid', value: '7654321' }] },
    { from: 'Candidate inhibitor 17', to: 'Hexokinase', type: 'Inhibits', evidence: 'computationally_predicted', description: 'Docking prediction only – not tested.' },
    { from: 'HK1', to: 'Hexokinase', type: 'Encodes', evidence: 'database_annotated', sourceDb: 'NCBI Gene' },
    { from: 'PFKM', to: 'Phosphofructokinase', type: 'Encodes', evidence: 'database_annotated', sourceDb: 'NCBI Gene' },
    { from: 'Hexokinase', to: 'Homo sapiens', type: 'Expressed by', evidence: 'database_annotated', sourceDb: 'UniProt' },
    { from: 'Hexokinase', to: 'Hexokinase kinetics (example)', type: 'Cited in', evidence: 'user_supplied' },
    { from: 'Glucose-6-phosphate', to: 'Fructose-6-phosphate', type: 'Converted into', evidence: 'database_annotated', tags: ['Glycolysis'] },
  ],
};

export interface Loaded { ids: Record<string, string>; reactions: Record<string, string>; pathways: Record<string, string> }
/** Load an example network into a project through the public API. Re-running it reuses existing records (find-or-create by name), so it never duplicates a chemical. */
export async function loadNetwork(api: Api, projectId: string, n: ExampleNetwork, wsId?: string): Promise<Loaded> {
  const ids: Record<string, string> = {};
  const existing = async (kind: string, name: string) => { // reactions and pathways are created by their own endpoints: reuse an existing one with the same name
    if (!wsId) return null; const r = await api.get(`/api/explorer/search?workspace=${wsId}&q=${encodeURIComponent(name)}&kinds=${kind}`);
    return (r.json?.results as { id: string; name: string }[] | undefined)?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  };
  const rec = async (kind: string, name: string, fields: Record<string, unknown> = {}) => { const r = await api.post('/api/explorer/quick-record', { projectId, kind, name, fields }); if (r.status !== 200) throw new Error(`${name}: ${r.text}`); ids[name] = r.json.id; };
  for (const c of n.metabolites) await rec('chemical', c, { chemType: 'Metabolite' });
  for (const c of n.chemicals) await rec('chemical', c);
  for (const e of n.enzymes) await rec('protein', e, { protType: 'Enzyme' });
  for (const g of n.genes) await rec('gene', g);
  for (const o of n.organisms) await rec('organism', o);
  for (const p of n.publications) await rec('publication', p);
  const reactions: Record<string, string> = {}, pathways: Record<string, string> = {};
  for (const r of n.reactions) {
    const have = await existing('reaction', r.name); if (have) { reactions[r.name] = have; ids[r.name] = have; continue; }
    const out = await api.post('/api/reactions', { projectId, name: r.name, reversible: r.reversible, ec: r.ec, organism: 'Homo sapiens', evidence: 'Database annotated', tags: ['Glycolysis'], participants: r.parts.map(([nm, role, st]) => ({ recordId: ids[nm], role, stoichiometry: st })) });
    if (out.status !== 200) throw new Error(`${r.name}: ${out.text}`); reactions[r.name] = out.json.id; ids[r.name] = out.json.id;
  }
  for (const p of n.pathways) {
    const have = await existing('pathway', p.name); if (have) { pathways[p.name] = have; ids[p.name] = have; continue; }
    const out = await api.post('/api/pathways', { projectId, name: p.name, organism: 'Homo sapiens', evidence: 'Database annotated', tags: p.tags, linear: p.linear, steps: p.steps.map((s) => ({ reactionId: reactions[s], orderBasis: p.edges ? 'curated' : 'unknown' })), edges: (p.edges ?? []).map(([a, b, k]) => ({ from: reactions[a], to: reactions[b], kind: k, basis: 'curated' })) });
    if (out.status !== 200) throw new Error(`${p.name}: ${out.text}`); pathways[p.name] = out.json.id; ids[p.name] = out.json.id;
  }
  for (const r of n.relationships) {
    const out = await api.post('/api/relationships', { sourceId: ids[r.from], targetId: ids[r.to], typeName: r.type, evidenceClass: r.evidence, description: r.description, tags: r.tags, organism: r.organism, citations: r.citations, sourceDb: r.sourceDb, allowIncompatible: true });
    if (out.status !== 200 && !/already recorded/.test(out.text)) throw new Error(`${r.from} ${r.type} ${r.to}: ${out.text}`);
  }
  return { ids, reactions, pathways };
}
