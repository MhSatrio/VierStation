// Shared vocabulary of the relationship explorer: evidence classes, reaction roles, entity types and the built-in relationship types.
// Used by the server (validation, storage) and the browser (labels, visual style, tooltips).

/** How well a relationship is supported. Never inferred from the fact that a record exists in an external database. */
export const EVIDENCE = [
  { id: 'experimentally_verified', label: 'Experimentally verified', solid: true, help: 'Observed in an experiment (for example a binding assay, a kinetic measurement or a knock-out). Cite the experiment.' },
  { id: 'database_annotated', label: 'Database annotated', solid: true, help: 'A curated or deposited database record states it (UniProt, NCBI, ChEMBL, KEGG …). The database may itself rely on experiments or on inference – read its source.' },
  { id: 'literature_reported', label: 'Literature reported', solid: true, help: 'A publication reports it. Cite the paper (DOI or PMID).' },
  { id: 'computationally_predicted', label: 'Computationally predicted', solid: false, help: 'Predicted by software (sequence similarity, docking, machine learning). A hypothesis, not an observation.' },
  { id: 'user_supplied', label: 'User supplied', solid: true, help: 'Entered by a researcher in VierStation, without a formal citation.' },
  { id: 'unverified', label: 'Unverified', solid: false, help: 'No supporting evidence has been recorded for this relationship.' },
] as const;
export type EvidenceId = (typeof EVIDENCE)[number]['id'];
export const EVIDENCE_IDS = EVIDENCE.map((e) => e.id) as EvidenceId[];
export const evidenceLabel = (id: string) => EVIDENCE.find((e) => e.id === id)?.label ?? id;
/** older records used 'sequence_inferred'; it means the same as a computational prediction */
export const normalizeEvidence = (id: string | undefined | null): EvidenceId => (id === 'sequence_inferred' ? 'computationally_predicted' : EVIDENCE_IDS.includes(id as EvidenceId) ? (id as EvidenceId) : 'unverified');
/** predicted / unverified relationships are drawn with dashed lines; the evidence class is ALSO written in the inspector – colour and line style are never the only signal */
export const isPredicted = (id: string) => id === 'computationally_predicted' || id === 'unverified';

export const VERIFICATION = [{ id: 'unverified', label: 'Not verified' }, { id: 'verified', label: 'Verified by a curator' }, { id: 'disputed', label: 'Disputed' }] as const;

export const REACTION_ROLES = [
  { id: 'reactant', label: 'Reactant', side: 'left', help: 'A substance consumed by the reaction (a substrate).' },
  { id: 'product', label: 'Product', side: 'right', help: 'A substance formed by the reaction.' },
  { id: 'catalyst', label: 'Catalyst', side: 'modifier', help: 'Speeds up the reaction without being consumed as a reactant.' },
  { id: 'enzyme', label: 'Enzyme', side: 'modifier', help: 'A protein that catalyses the reaction.' },
  { id: 'cofactor', label: 'Cofactor', side: 'modifier', help: 'A non-protein helper the enzyme needs (a metal ion, NAD+, a vitamin-derived molecule …).' },
  { id: 'inhibitor', label: 'Inhibitor', side: 'modifier', help: 'Slows or stops the reaction.' },
  { id: 'activator', label: 'Activator', side: 'modifier', help: 'Increases the rate of the reaction.' },
  { id: 'regulator', label: 'Regulator', side: 'modifier', help: 'Changes the reaction in a way that is not simply inhibition or activation (or is not yet known).' },
] as const;
export type ReactionRole = (typeof REACTION_ROLES)[number]['id'];
export const ROLE_IDS = REACTION_ROLES.map((r) => r.id) as ReactionRole[];

export const ORDER_BASIS = [{ id: 'curated', label: 'Curated source' }, { id: 'user', label: 'Defined by you' }, { id: 'unknown', label: 'Order unknown' }] as const;

/** Entity types shown in the explorer; each has its own node shape so the type is clear without colour.
 *  (Only non-rounded polygons for the polygon shapes: Cytoscape 3.30 crashes on parallel edges between rounded polygons, which this model needs – one pair can have several relationships.) */
export const NODE_TYPES = [
  { id: 'dna', label: 'DNA', shape: 'round-rectangle', help: 'A DNA sequence record.' },
  { id: 'rna', label: 'RNA', shape: 'round-rectangle', help: 'An RNA sequence record.' },
  { id: 'gene', label: 'Gene', shape: 'hexagon', help: 'A gene (NCBI Gene).' },
  { id: 'protein', label: 'Protein', shape: 'ellipse', help: 'A protein (UniProt).' },
  { id: 'enzyme', label: 'Enzyme', shape: 'octagon', help: 'A protein recorded as an enzyme (or acting as catalyst/enzyme in a reaction).' },
  { id: 'chemical', label: 'Chemical', shape: 'triangle', help: 'A chemical compound (PubChem).' },
  { id: 'metabolite', label: 'Metabolite', shape: 'pentagon', help: 'A small molecule taking part in metabolism.' },
  { id: 'reaction', label: 'Reaction', shape: 'diamond', help: 'A chemical reaction with reactants, products and catalysts.' },
  { id: 'pathway', label: 'Pathway', shape: 'tag', help: 'An organised set of related reactions.' },
  { id: 'organism', label: 'Organism', shape: 'barrel', help: 'A species or strain.' },
  { id: 'publication', label: 'Publication', shape: 'rectangle', help: 'A paper that supports records or relationships.' },
  { id: 'structure', label: 'Structure', shape: 'cut-rectangle', help: 'A 3D structure (experimental or predicted).' },
] as const;
export type NodeTypeId = (typeof NODE_TYPES)[number]['id'];
/** record kinds the explorer works with */
export const GRAPH_KINDS = ['dna', 'rna', 'gene', 'protein', 'chemical', 'reaction', 'pathway', 'organism', 'publication', 'structure'] as const;
export const nodeTypeOf = (kind: string, subtype?: string | null): NodeTypeId => {
  if (kind === 'protein' && /enzyme/i.test(subtype ?? '')) return 'enzyme';
  if (kind === 'chemical' && /metabolite/i.test(subtype ?? '')) return 'metabolite';
  return (NODE_TYPES.some((n) => n.id === kind) ? kind : 'chemical') as NodeTypeId;
};

/** Blue-only palette (VierApparatus #4570B6, light #CAEBFB and darker tones). Shape, size, border and line style carry the rest of the meaning. */
export const BLUE = {
  dna: { fill: '#2B4F8C', text: '#FFFFFF', border: '#14295A' }, rna: { fill: '#14295A', text: '#FFFFFF', border: '#0B1733' }, gene: { fill: '#7FA3D6', text: '#0B1733', border: '#2B4F8C' },
  protein: { fill: '#4570B6', text: '#FFFFFF', border: '#14295A' }, enzyme: { fill: '#3A63A8', text: '#FFFFFF', border: '#0B1733' }, chemical: { fill: '#A9D4F2', text: '#14295A', border: '#4570B6' },
  metabolite: { fill: '#DCEFFB', text: '#14295A', border: '#4570B6' }, reaction: { fill: '#FFFFFF', text: '#14295A', border: '#4570B6' }, pathway: { fill: '#F3F8FD', text: '#14295A', border: '#14295A' },
  organism: { fill: '#7C9CCB', text: '#0B1733', border: '#2B4F8C' }, publication: { fill: '#B7C3D4', text: '#1E2A3C', border: '#6C7B91' }, structure: { fill: '#8FB0DD', text: '#0B1733', border: '#2B4F8C' },
} as const;

export interface BuiltinRelType { name: string; inverse?: string; description: string; directional: boolean; source: string[]; target: string[]; style: 'solid' | 'dashed' | 'dotted' }
const C = ['chemical'], P = ['protein'], G = ['gene'];
export const BUILTIN_TYPES: BuiltinRelType[] = [
  { name: 'Binds to', description: 'Physically binds (a ligand and a protein, or two molecules). Does not by itself say that activity changes.', directional: false, source: ['chemical', 'protein', 'dna', 'rna'], target: ['protein', 'chemical', 'dna', 'rna'], style: 'solid' },
  { name: 'Inhibits', inverse: 'Inhibited by', description: 'Reduces the activity or rate of the target.', directional: true, source: ['chemical', 'protein', 'gene'], target: ['protein', 'reaction', 'gene'], style: 'solid' },
  { name: 'Activates', inverse: 'Activated by', description: 'Increases the activity or rate of the target.', directional: true, source: ['chemical', 'protein', 'gene'], target: ['protein', 'reaction', 'gene'], style: 'solid' },
  { name: 'Substrate of', inverse: 'Has substrate', description: 'Used as a reactant by an enzyme or a reaction.', directional: true, source: C, target: ['protein', 'reaction'], style: 'solid' },
  { name: 'Product of', inverse: 'Has product', description: 'Formed by an enzyme or a reaction.', directional: true, source: C, target: ['protein', 'reaction'], style: 'solid' },
  { name: 'Converted into', description: 'Chemically transformed into another compound.', directional: true, source: C, target: C, style: 'solid' },
  { name: 'Catalyzed by', inverse: 'Catalyzes', description: 'The reaction or conversion is speeded up by this enzyme.', directional: true, source: ['reaction', 'chemical'], target: P, style: 'solid' },
  { name: 'Encodes', inverse: 'Encoded by', description: 'The DNA or gene carries the information for this RNA or protein.', directional: true, source: ['dna', 'gene', 'rna'], target: ['protein', 'rna'], style: 'solid' },
  { name: 'Expressed by', inverse: 'Expresses', description: 'The gene or protein is produced in this organism, tissue or cell.', directional: true, source: ['gene', 'protein'], target: ['organism'], style: 'solid' },
  { name: 'Regulates', inverse: 'Regulated by', description: 'Changes the activity or expression of the target (direction of the effect not stated).', directional: true, source: ['gene', 'protein', 'chemical', 'rna'], target: ['gene', 'protein', 'reaction', 'pathway'], style: 'solid' },
  { name: 'Interacts with', description: 'Interacts (for example a protein–protein interaction).', directional: false, source: ['protein', 'gene', 'chemical'], target: ['protein', 'gene', 'chemical'], style: 'solid' },
  { name: 'Associated with', description: 'A general association. Say what kind in the description.', directional: false, source: [], target: [], style: 'dotted' },
  { name: 'Located in', description: 'Found in a compartment, tissue or organism.', directional: true, source: ['protein', 'gene', 'chemical', 'reaction'], target: ['organism', 'pathway'], style: 'solid' },
  { name: 'Part of pathway', inverse: 'Has pathway member', description: 'Takes part in the pathway.', directional: true, source: ['reaction', 'chemical', 'protein', 'gene'], target: ['pathway'], style: 'solid' },
  { name: 'Cytotoxic to', description: 'Kills or damages cells of the target (organism, cell line).', directional: true, source: C, target: ['organism'], style: 'solid' },
  { name: 'Coagulant activity', description: 'Promotes blood coagulation.', directional: true, source: ['chemical', 'protein'], target: ['organism', 'pathway', 'protein'], style: 'solid' },
  { name: 'Antimicrobial activity', description: 'Inhibits the growth of microorganisms.', directional: true, source: ['chemical', 'protein'], target: ['organism'], style: 'solid' },
  { name: 'Antioxidant activity', description: 'Neutralises reactive oxygen species or oxidation.', directional: true, source: ['chemical', 'protein'], target: ['reaction', 'pathway', 'organism'], style: 'solid' },
  { name: 'Cited in', description: 'The record is described or supported by this publication.', directional: true, source: [], target: ['publication'], style: 'dotted' },
];
export const CITATION_KINDS = ['doi', 'pmid', 'accession', 'uniprot', 'pubchem', 'url', 'record'] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];
export const citationUrl = (kind: string, value: string): string | null => {
  const v = encodeURIComponent(value.trim());
  switch (kind) {
    case 'doi': return `https://doi.org/${value.trim()}`; case 'pmid': return `https://pubmed.ncbi.nlm.nih.gov/${v}/`; case 'uniprot': return `https://www.uniprot.org/uniprotkb/${v}`;
    case 'pubchem': return `https://pubchem.ncbi.nlm.nih.gov/compound/${v}`; case 'accession': return `https://www.ncbi.nlm.nih.gov/nuccore/${v}`; case 'url': return /^https?:\/\//i.test(value) ? value.trim() : null; default: return null;
  }
};

/** WCAG 2.x contrast ratio between two #RRGGBB colours (4.5 = AA for normal text, 3 = AA for large text and graphical objects). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05);
}
/** Edge colours by evidence: all blue; line style (solid / dashed / dotted) and width repeat the meaning so it never depends on colour. */
export const EDGE_STYLE: Record<string, { color: string; width: number; line: 'solid' | 'dashed' | 'dotted'; short: string }> = {
  experimentally_verified: { color: '#14295A', width: 3.2, line: 'solid', short: 'experimental' },
  database_annotated: { color: '#2B4F8C', width: 2.4, line: 'solid', short: 'database' },
  literature_reported: { color: '#4570B6', width: 2.4, line: 'solid', short: 'literature' },
  user_supplied: { color: '#5C86C8', width: 2, line: 'solid', short: 'user' },
  computationally_predicted: { color: '#4570B6', width: 2, line: 'dashed', short: 'predicted' },
  unverified: { color: '#6F8FC0', width: 1.6, line: 'dotted', short: 'unverified' },
};
