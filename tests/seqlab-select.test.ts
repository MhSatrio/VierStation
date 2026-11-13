import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENV_RE, chooseScopes, normaliseHit, rankHits } from '../server/seqlab/pipeline.ts';
import type { LabHit } from '../server/seqlab/pipeline.ts';
import type { Member } from '../server/seqlab/dataset.ts';

const mem = (id: string, genus: string, family: string, order: string, bits = 100): Member => ({
  id, label: id, accession: id, organism: `${genus} x`, taxId: 1, role: 'ingroup', reasons: [], seq: 'ACGT', region: null, identityPct: 99, coveragePct: 100, bitScore: bits, evalue: 0, source: 'blast',
  lineage: [{ taxId: 1, name: 'cellular organisms', rank: 'cellular root' }, { taxId: 2, name: 'Bacteria', rank: 'domain' }, { taxId: 5, name: 'Pseudomonadota', rank: 'phylum' }, { taxId: 6, name: 'Gammaproteobacteria', rank: 'class' }, { taxId: 10 + order.charCodeAt(0), name: order, rank: 'order' }, { taxId: 20 + family.length * 100 + family.charCodeAt(0), name: family, rank: 'family' }, { taxId: 30 + genus.charCodeAt(0), name: genus, rank: 'genus' }],
});

test('names that do not identify a species are flagged; real binomials are not', () => {
  for (const n of ['marine bacterium', 'bacterium BM0595', 'Escherichia sp.', 'uncultured Alphus sp.', 'Enterobacteriaceae bacterium', 'Methanobacteriales archaeon', 'synthetic construct', 'Candidatus Foo endosymbiont of Bar', 'Homo cf. sapiens']) assert.ok(ENV_RE.test(n), n);
  for (const n of ['Escherichia coli', 'Alphus primus', 'Bacteroides thetaiotaomicron', 'Shigella flexneri', 'Mycobacterium tuberculosis variant bovis']) assert.ok(!ENV_RE.test(n), n);
});

test('ingroup clade = lowest rank of the best match shared by ≥ 60% of the ingroup; outgroups come from the next rank up', () => {
  const same = [mem('a', 'Escherichia', 'Enterobacteriaceae', 'Enterobacterales', 200), mem('b', 'Escherichia', 'Enterobacteriaceae', 'Enterobacterales'), mem('c', 'Escherichia', 'Enterobacteriaceae', 'Enterobacterales')];
  let s = chooseScopes(same)!;
  assert.deepEqual([s.ingroup.name, s.ingroup.rank, s.outside.name, s.outside.rank, s.outliers], ['Escherichia', 'genus', 'Enterobacteriaceae', 'family', 0]);
  const mixed = [mem('a', 'Escherichia', 'Enterobacteriaceae', 'Enterobacterales', 200), mem('b', 'Shigella', 'Enterobacteriaceae', 'Enterobacterales'), mem('c', 'Salmonella', 'Enterobacteriaceae', 'Enterobacterales'), mem('d', 'Klebsiella', 'Enterobacteriaceae', 'Enterobacterales')];
  s = chooseScopes(mixed)!; assert.deepEqual([s.ingroup.name, s.ingroup.rank, s.outside.name, s.outside.rank], ['Enterobacteriaceae', 'family', 'Enterobacterales', 'order']);
  const outlier = [...mixed, mem('e', 'Vibrio', 'Vibrionaceae', 'Vibrionales')];
  s = chooseScopes(outlier)!; assert.equal(s.ingroup.name, 'Enterobacteriaceae'); assert.equal(s.outliers, 1);
  const split = [mem('a', 'Escherichia', 'Enterobacteriaceae', 'Enterobacterales', 200), mem('b', 'Vibrio', 'Vibrionaceae', 'Vibrionales'), mem('c', 'Pseudomonas', 'Pseudomonadaceae', 'Pseudomonadales')];
  s = chooseScopes(split)!; assert.deepEqual([s.ingroup.name, s.ingroup.rank, s.outside.name], ['Gammaproteobacteria', 'class', 'Pseudomonadota'], 'a single genus is not 60% of a mixed set');
  assert.equal(chooseScopes([{ ...mem('z', 'X', 'Y', 'Z'), lineage: [] }]), null, 'no lineage → no automatic scope');
  assert.equal(chooseScopes([{ ...mem('z', 'X', 'Y', 'Z'), lineage: [{ taxId: 2, name: 'Bacteria', rank: 'domain' }] }]), null, 'only a domain → too coarse for an automatic sister clade');
});

test('hit ranking: five transparent sort orders, filters, one-per-species keep the best', () => {
  const mk = (acc: string, org: string, taxId: number, id: number, cov: number, bits: number, ev: number): LabHit => normaliseHit({ accession: acc, title: org, taxId, organism: org, length: 1000, bestIdentityPct: id, queryCoveragePct: cov, hsps: [{ bitScore: bits, evalue: ev, identity: Math.round(id * 10), alignLen: 1000, gaps: 0, mismatches: 1000 - Math.round(id * 10), queryFrom: 1, queryTo: 1000, hitFrom: 1, hitTo: 1000, strand: 'Plus' }] }, 1000, false);
  const hits = [mk('A', 'Sp one', 1, 99.9, 40, 500, 1e-100), mk('B', 'Sp two', 2, 97, 100, 1800, 0), mk('C', 'Sp two', 2, 96, 100, 1700, 0), mk('D', 'uncultured Sp three', 3, 100, 100, 1900, 0)];
  assert.deepEqual(rankHits(hits, { sort: 'bitScore' }).map((h) => h.accession), ['D', 'B', 'C', 'A']);
  assert.deepEqual(rankHits(hits, { sort: 'identity' }).map((h) => h.accession), ['D', 'A', 'B', 'C']);
  assert.deepEqual(rankHits(hits, { sort: 'coverage' }).map((h) => h.accession), ['D', 'B', 'C', 'A']);
  assert.equal(rankHits(hits, { sort: 'combined' })[0].accession, 'D'); assert.equal(rankHits(hits, { sort: 'combined' }).at(-1)!.accession, 'A', 'high identity over little coverage ranks last on the combined score');
  assert.deepEqual(rankHits(hits, { excludeEnvironmental: true, onePerSpecies: true, sort: 'bitScore' }).map((h) => h.accession), ['B', 'A']);
  assert.deepEqual(rankHits(hits, { minCoverage: 90, minIdentity: 96.5 }).map((h) => h.accession).sort(), ['B', 'D']);
  assert.equal(rankHits(hits, { text: 'one' }).length, 1);
  assert.equal(hits[0].identityPct, 99.9); assert.equal(hits[0].coveragePct, 40, 'identity and coverage stay separate');
});

test('tree reading: a single outgroup cannot be checked for monophyly, and this is said', async () => {
  const { interpretTree } = await import('../server/seqlab/interpret.ts');
  const leaf = (name: string, i: number) => ({ name, leaf: i, length: 0.01 });
  const tree = { length: 0, children: [{ length: 0.02, support: 99, children: [leaf('Q', 0), leaf('A', 1)] }, leaf('O', 2)] };
  const res: any = { labels: ['Q', 'A', 'O'], tree, edges: [[0, 3, 0.01], [1, 3, 0.01], [3, 2, 0.05]], sitesKept: 600, sitesDropped: 0, variableSites: 30, informativeSites: 12, warnings: [], bootstrapDone: 100, method: 'nj', params: { bootstrap: 100 } };
  const mk = (label: string, role: string, organism: string) => ({ label, role, organism, accession: null }) as any;
  const r = interpretTree(res, [mk('Q', 'query', 'Query'), mk('A', 'ingroup', 'Alphus primus'), mk('O', 'outgroup', 'Outus unus')]);
  assert.equal(r.outgroupsFormOwnClade, null);
  assert.ok(r.limitations.some((l) => /Only one outgroup/.test(l)));
  assert.ok(!r.limitations.some((l) => /do not form a clade/.test(l)));
  assert.match(r.statement, /groups with Alphus primus/);
});

test('tree reading: with almost no informative sites the tree is declared inconclusive instead of "grouping" the query', async () => {
  const { interpretTree } = await import('../server/seqlab/interpret.ts');
  const leaf = (name: string, i: number) => ({ name, leaf: i, length: 0.001 });
  const tree = { length: 0, children: [{ length: 0.002, support: 96, children: [leaf('Q', 0), leaf('A', 1)] }, leaf('B', 2)] };
  const res: any = { labels: ['Q', 'A', 'B'], tree, edges: [[0, 3, 0.001], [1, 3, 0.001], [3, 2, 0.002]], sitesKept: 505, sitesDropped: 0, variableSites: 16, informativeSites: 0, warnings: [], bootstrapDone: 200, method: 'nj', params: { bootstrap: 200 } };
  const mk = (label: string, role: string, organism: string) => ({ label, role, organism, accession: null }) as any;
  const r = interpretTree(res, [mk('Q', 'query', 'Query'), mk('A', 'ingroup', 'Alphus primus'), mk('B', 'ingroup', 'Betus tertius')]);
  assert.equal(r.level, 'inconclusive'); assert.match(r.statement, /too little phylogenetic signal \(0 parsimony-informative/); assert.match(r.limitations[0], /Fewer than 5 parsimony-informative/);
});

test('placeholder names such as "fungal endophyte" are not treated as species', () => {
  for (const n of ['fungal endophyte', 'endophytic fungus', 'Fungal sp. 3', 'uncultured fungus clone X']) assert.ok(ENV_RE.test(n), n);
  for (const n of ['Trichoderma harzianum', 'Hypomyces cervinigenus', 'Paraconiothyrium cyclothyrioides']) assert.ok(!ENV_RE.test(n), n);
});
