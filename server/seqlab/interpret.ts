// Plain-language reading of a finished tree. It states what the tree shows, how strongly it is supported, and what it cannot show.
import type { Nested } from '../phylo/tree.ts';
import type { PhyloResult } from '../phylo/run.ts';
import { distancesFrom } from '../phylo/run.ts';
import type { Member } from './dataset.ts';

export interface Interpretation {
  summary: string; queryLabel: string | null;
  closestRelatives: { label: string; organism: string; accession: string | null; distance: number }[];
  closestClade: { labels: string[]; organisms: string[]; support: number | null; speciesCount: number; genusCount: number } | null;
  outgroupsFormOwnClade: boolean | null; level: 'species' | 'genus' | 'inconclusive'; statement: string; limitations: string[];
}
type MemberLike = Pick<Member, 'label' | 'role' | 'organism' | 'accession'>;

const leavesOf = (n: Nested): string[] => (n.children ? n.children.flatMap(leavesOf) : [n.name ?? '']);

export function interpretTree(res: PhyloResult, members: MemberLike[]): Interpretation {
  const byLabel = new Map(members.map((m) => [m.label, m]));
  const queryLabel = members.find((m) => m.role === 'query')?.label ?? res.labels[0] ?? null;
  const limitations: string[] = [
    'A tree shows relationships among the sequences you supplied. It does not by itself prove the identity of your sample: it can only be as good as the reference sequences, their correct species labels in GenBank, and the marker used.',
    `The tree is based on ${res.sitesKept} alignment columns${res.sitesDropped ? ` (${res.sitesDropped} were excluded by the gap treatment)` : ''}, of which ${res.variableSites} vary and ${res.informativeSites} are parsimony-informative.`,
    'Bootstrap values measure how consistently the data support a branch under resampling of alignment columns – they are not the probability that the branch is true.',
  ];
  if (res.method === 'upgma') limitations.push('UPGMA assumes the same rate of evolution in all lineages (a molecular clock) and can give misleading topologies when rates differ.');
  if (res.method === 'nj' || res.method === 'upgma' || res.method === 'me') limitations.push('Distance methods compress the alignment into pairwise distances and lose some information that maximum likelihood or parsimony use.');
  if (res.bootstrapDone === 0) limitations.push('No bootstrap was run, so branch support is unknown.');
  if (res.params.bootstrap > 0 && res.params.bootstrap < 100) limitations.push(`Only ${res.params.bootstrap} bootstrap replicates were run; 100–1000 are usual for reporting.`);
  limitations.push(...res.warnings);
  const qi = queryLabel ? res.labels.indexOf(queryLabel) : -1;
  if (qi < 0) return { summary: 'The query sequence is not part of this tree.', queryLabel, closestRelatives: [], closestClade: null, outgroupsFormOwnClade: null, level: 'inconclusive', statement: 'The query sequence is not in the tree, so no placement can be described.', limitations };
  const dist = distancesFrom(res.edges, res.labels.length, qi);
  const closestRelatives = res.labels.map((l, i) => ({ l, i })).filter((x) => x.i !== qi).sort((a, b) => dist[a.i] - dist[b.i]).slice(0, 3)
    .map(({ l, i }) => ({ label: l, organism: byLabel.get(l)?.organism ?? l, accession: byLabel.get(l)?.accession ?? null, distance: +dist[i].toFixed(5) }));
  // smallest clade of the displayed (rooted) tree that contains the query and at least one ingroup sequence
  let closestClade: Interpretation['closestClade'] = null;
  const find = (n: Nested): { found: boolean; done: boolean } => {
    if (!n.children) return { found: n.name === queryLabel, done: false };
    let hasQ = false;
    for (const c of n.children) { const r = find(c); if (r.done) return r; if (r.found) hasQ = true; }
    if (hasQ) {
      const labels = leavesOf(n).filter((l) => l !== queryLabel && byLabel.get(l)?.role !== 'outgroup');
      if (labels.length) {
        const organisms = [...new Set(labels.map((l) => byLabel.get(l)?.organism ?? l))];
        closestClade = { labels, organisms, support: n.support ?? null, speciesCount: organisms.length, genusCount: new Set(organisms.map((o) => o.split(/\s+/)[0])).size };
        return { found: true, done: true };
      }
    }
    return { found: hasQ, done: false };
  };
  find(res.tree);
  const outs = members.filter((m) => m.role === 'outgroup').map((m) => m.label);
  let outgroupsFormOwnClade: boolean | null = null;
  if (outs.length === 1) limitations.push('Only one outgroup sequence was used, so whether the outgroup forms a clade cannot be checked and a single (possibly mislabeled or fast-evolving) sequence determines the root.');
  if (outs.length >= 2) {
    let smallest: string[] | null = null;
    const walk = (n: Nested): void => { if (!n.children) return; const lv = leavesOf(n); if (outs.every((o) => lv.includes(o)) && (!smallest || lv.length < smallest.length)) smallest = lv; n.children.forEach(walk); };
    walk(res.tree);
    outgroupsFormOwnClade = smallest ? (smallest as string[]).every((l) => outs.includes(l)) : null;
    if (outgroupsFormOwnClade === false) limitations.push('The outgroups do not form a clade of their own, so the outgroup rooting may be unreliable (or an outgroup is mislabelled / too distant).');
  } else if (outs.length === 0) limitations.push('No outgroup was used, so the position of the root is an assumption.');
  const cc = closestClade as Interpretation['closestClade'];
  let level: Interpretation['level'] = 'inconclusive', statement: string;
  const supp = cc?.support;
  const supportWords = supp === null || supp === undefined ? 'with no bootstrap support available' : supp >= 95 ? `with strong bootstrap support (${supp}%)` : supp >= 70 ? `with moderate bootstrap support (${supp}%)` : `but with weak bootstrap support (${supp}%)`;
  if (!cc) statement = 'The query does not group with any ingroup sequence in this tree, so no placement can be described.';
  else if (cc.speciesCount === 1) { level = supp !== null && supp !== undefined && supp < 70 ? 'inconclusive' : 'species'; statement = `The query groups with ${cc.organisms[0]} ${supportWords}.${level === 'inconclusive' ? ' Support is too weak to rely on this grouping.' : ' This is consistent with, but does not prove, that identity.'}`; }
  else if (cc.genusCount === 1) { level = supp !== null && supp !== undefined && supp < 70 ? 'inconclusive' : 'genus'; statement = `The query falls inside a clade of ${cc.speciesCount} species of ${cc.organisms[0].split(/\s+/)[0]} (${cc.organisms.join(', ')}) ${supportWords}. The marker does not separate these species in this tree, so identification is supported at genus level only.`; }
  else statement = `The query's closest clade mixes several genera (${cc.organisms.join(', ')}) ${supportWords}, so the tree does not support a confident identification below that level.`;
  if (res.informativeSites < 5) {
    level = 'inconclusive';
    statement = `The alignment holds too little phylogenetic signal (${res.informativeSites} parsimony-informative and ${res.variableSites} variable site(s) among ${res.sitesKept} columns), so this tree cannot support any identification: branch order and bootstrap values are essentially arbitrary. ${statement}`;
    limitations.unshift('Fewer than 5 parsimony-informative sites: the branching pattern is not supported by the data. Use a longer or more variable region, or a cleaner read, before interpreting a tree.');
  }
  const nearest = closestRelatives[0];
  const summary = `${statement}${nearest ? ` Nearest sequence by tree distance: ${nearest.organism}${nearest.accession ? ` (${nearest.accession})` : ''}, ${nearest.distance} substitutions/site.` : ''}`;
  return { summary, queryLabel, closestRelatives, closestClade: cc, outgroupsFormOwnClade, level, statement, limitations };
}
