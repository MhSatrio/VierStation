// Scientific database templates (FR-1.4): each creates tables, fields, relationships, views and optional automation rules.
import { q, tx } from './db.ts';
import { bad, now, uid } from './util.ts';
import type { FieldOptions, FieldType, SelectChoice, TableKind, ViewConfig, ViewType, ChoiceColor } from '../shared/types.ts';
import { createField, createTable, createView, listFields } from './schema.ts';
import { installAutomationTemplates } from './automations.ts';

interface FDef { name: string; type: FieldType; options?: FieldOptions; key?: string }
interface VDef { name: string; type: ViewType; config?: (fid: (name: string) => string | undefined) => ViewConfig }
interface TDef { name: string; kind: TableKind; icon: string; description: string; fields: FDef[]; views: VDef[] }

const ch = (names: string, colors: ChoiceColor[]): SelectChoice[] => names.split('|').map((name, i) => ({ id: `tpl${i}`, name, color: colors[i % colors.length] }));
const RECORD_STATUS = ch('To fetch|Processing|Review|Completed|Failed', ['gray', 'amber', 'sky', 'green', 'red']);
const TASK_STATUS = ch('To do|In progress|Review|Done', ['gray', 'amber', 'sky', 'green']);
const PRIORITY = ch('Low|Medium|High|Urgent', ['gray', 'sky', 'amber', 'red']);

const status = (): FDef => ({ name: 'Status', type: 'status', options: { choices: RECORD_STATUS }, key: 'status' });
const kanban = (field = 'Status'): VDef => ({ name: 'Workflow board', type: 'kanban', config: (f) => ({ kanbanField: f(field) }) });
const graph: VDef = { name: 'Relationships', type: 'graph', config: () => ({ graphDepth: 2 }) };
const grid = (name = 'All records'): VDef => ({ name, type: 'grid' });
const gallery = (cover?: string): VDef => ({ name: 'Gallery', type: 'gallery', config: (f) => ({ coverField: cover ? f(cover) : undefined }) });

export const TABLE_DEFS: Record<string, TDef> = {
  organism: {
    name: 'Organisms', kind: 'organism', icon: 'leaf', description: 'Species and strains',
    fields: [{ name: 'Scientific name', type: 'text', key: 'name' }, { name: 'Common name', type: 'text' }, { name: 'NCBI Taxonomy ID', type: 'text', key: 'taxid' }, { name: 'Lineage', type: 'longtext' }],
    views: [grid('All organisms')],
  },
  dna: {
    name: 'DNA Sequences', kind: 'dna', icon: 'dna', description: 'Nucleotide records with provenance, type and linked genes',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Accession', type: 'text', key: 'accession' },
      { name: 'Sequence', type: 'sequence', options: { seqType: 'dna' }, key: 'sequence' },
      { name: 'Length (bp)', type: 'number', key: 'length' },
      { name: 'GC content', type: 'formula', options: { formula: 'GC({Sequence})' } },
      { name: 'Sequence class', type: 'singleSelect', key: 'seqClass', options: { choices: ch('Coding DNA|Non-coding DNA|Partial sequence|Uncertain annotation|mRNA / cDNA|Genomic', ['green', 'gray', 'amber', 'red', 'blue', 'sky']) } },
      { name: 'Source database', type: 'text', key: 'source' },
      { name: 'Collection information', type: 'longtext', key: 'collection' },
      { name: 'Retrieved at', type: 'date', options: { includeTime: true }, key: 'retrieved' },
      status(),
      { name: 'Notes', type: 'longtext' },
    ],
    views: [grid(), kanban(), graph, { name: 'List', type: 'list' }],
  },
  gene: {
    name: 'Genes', kind: 'gene', icon: 'gene', description: 'Annotated genes linked to DNA records and proteins',
    fields: [
      { name: 'Symbol', type: 'text', key: 'name' },
      { name: 'NCBI Gene ID', type: 'text', key: 'geneId' },
      { name: 'Full name', type: 'text', key: 'fullName' },
      { name: 'Gene type', type: 'singleSelect', key: 'geneType', options: { choices: ch('protein-coding|ncRNA|tRNA|rRNA|pseudo|other', ['green', 'gray', 'gray', 'gray', 'amber', 'gray']) } },
      { name: 'Location', type: 'text', key: 'location' },
      { name: 'Summary', type: 'longtext', key: 'summary' },
      status(),
    ],
    views: [grid(), kanban(), graph, gallery()],
  },
  protein: {
    name: 'Proteins', kind: 'protein', icon: 'protein', description: 'Proteins with sequence, domains, structures and ligands',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Accession', type: 'text', key: 'accession' },
      { name: 'Sequence', type: 'sequence', options: { seqType: 'protein' }, key: 'sequence' },
      { name: 'Length (aa)', type: 'number', key: 'length' },
      { name: 'Mass (Da)', type: 'formula', options: { formula: 'MW({Sequence})' } },
      { name: 'Isoform', type: 'text', key: 'isoform' },
      { name: 'Reviewed (Swiss-Prot)', type: 'checkbox', key: 'reviewed' },
      { name: 'Function', type: 'longtext', key: 'function' },
      { name: 'Domains', type: 'longtext', key: 'domains' },
      { name: 'Protein type', type: 'singleSelect', key: 'protType', options: { choices: ch('Enzyme|Receptor|Transporter|Structural|Regulatory|Other', ['blue', 'sky', 'sky', 'gray', 'gray', 'gray']) } },
      { name: 'Structure image', type: 'thumbnail', key: 'thumb' },
      { name: 'Structure availability', type: 'singleSelect', key: 'structAvail', options: { choices: ch('Not checked|AlphaFold available|Experimental only|Unavailable', ['gray', 'green', 'sky', 'amber']) } },
      { name: 'Source database', type: 'text', key: 'source' },
      { name: 'Retrieved at', type: 'date', options: { includeTime: true }, key: 'retrieved' },
      status(),
    ],
    views: [grid(), kanban(), gallery(), graph],
  },
  chemical: {
    name: 'Chemicals', kind: 'chemical', icon: 'flask', description: 'Compounds identified by PubChem CID, InChIKey and ChEMBL ID',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'PubChem CID', type: 'text', key: 'cid' },
      { name: 'InChIKey', type: 'text', key: 'inchikey' },
      { name: 'ChEMBL ID', type: 'text', key: 'chembl' },
      { name: 'Chemical type', type: 'singleSelect', key: 'chemType', options: { choices: ch('Metabolite|Compound|Drug-like|Other', ['sky', 'blue', 'amber', 'gray']) } },
      { name: 'Structure image', type: 'thumbnail', key: 'thumb' },
      { name: 'Molecular formula', type: 'text', key: 'formula' },
      { name: 'Molecular weight', type: 'number', options: { precision: 3 }, key: 'mw' },
      { name: 'Canonical SMILES', type: 'longtext', key: 'smiles' },
      { name: 'Isomeric SMILES', type: 'longtext', key: 'isoSmiles' },
      { name: 'InChI', type: 'longtext', key: 'inchi' },
      { name: 'Bioactivity', type: 'longtext', key: 'bioactivity' },
      { name: 'Possible duplicate', type: 'checkbox', key: 'dupFlag' },
      { name: 'Source database', type: 'text', key: 'source' },
      status(),
    ],
    views: [grid(), gallery(), kanban(), graph],
  },
  structure: {
    name: 'Structures', kind: 'structure', icon: 'cube', description: 'Predicted (AlphaFold) and experimental (PDB) structures',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Structure ID', type: 'text', key: 'accession' },
      { name: 'Source', type: 'singleSelect', key: 'source', options: { choices: ch('AlphaFold DB|RCSB PDB|Uploaded', ['blue', 'green', 'gray']) } },
      { name: 'Type', type: 'singleSelect', key: 'method', options: { choices: ch('Predicted|X-ray|Cryo-EM|NMR|Other experimental', ['amber', 'green', 'green', 'green', 'green']) } },
      { name: 'Mean pLDDT', type: 'number', options: { precision: 1 }, key: 'plddt' },
      { name: 'Resolution (Å)', type: 'number', options: { precision: 2 }, key: 'resolution' },
      { name: 'Structure', type: 'structure', key: 'structure' },
      { name: 'Retrieved at', type: 'date', options: { includeTime: true }, key: 'retrieved' },
      status(),
    ],
    views: [grid(), gallery('Structure'), kanban()],
  },
  reaction: {
    name: 'Reactions', kind: 'reaction', icon: 'reaction', description: 'Chemical reactions: reactants, products, catalysts and evidence',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Equation', type: 'text', key: 'equation' },
      { name: 'Reversibility', type: 'singleSelect', key: 'reversible', options: { choices: ch('Irreversible|Reversible|Unknown', ['gray', 'blue', 'amber']) } },
      { name: 'EC number', type: 'text', key: 'ec' },
      { name: 'Organism', type: 'text', key: 'organism' },
      { name: 'Compartment', type: 'text', key: 'compartment' },
      { name: 'Conditions', type: 'longtext', key: 'conditions' },
      { name: 'Description', type: 'longtext', key: 'description' },
      { name: 'Evidence', type: 'singleSelect', key: 'evidence', options: { choices: ch('Experimentally verified|Database annotated|Literature reported|Computationally predicted|User supplied|Unverified', ['green', 'blue', 'sky', 'amber', 'gray', 'gray']) } },
      { name: 'Source database', type: 'text', key: 'source' },
      { name: 'Source ID', type: 'text', key: 'accession' },
      status(),
    ],
    views: [grid('All reactions')],
  },
  pathway: {
    name: 'Pathways', kind: 'pathway', icon: 'pathway', description: 'Ordered or branching sets of reactions',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Organism', type: 'text', key: 'organism' },
      { name: 'Cellular location', type: 'text', key: 'compartment' },
      { name: 'Description', type: 'longtext', key: 'description' },
      { name: 'Evidence', type: 'singleSelect', key: 'evidence', options: { choices: ch('Experimentally verified|Database annotated|Literature reported|Computationally predicted|User supplied|Unverified', ['green', 'blue', 'sky', 'amber', 'gray', 'gray']) } },
      { name: 'Source database', type: 'text', key: 'source' },
      { name: 'Source ID', type: 'text', key: 'accession' },
      status(),
    ],
    views: [grid('All pathways')],
  },
  publication: {
    name: 'Publications', kind: 'publication', icon: 'book', description: 'Papers supporting records and relationships',
    fields: [{ name: 'Title', type: 'text', key: 'name' }, { name: 'PMID', type: 'text', key: 'pmid' }, { name: 'DOI', type: 'text', key: 'doi' }, { name: 'Year', type: 'number', key: 'year' }, { name: 'Journal', type: 'text' }, { name: 'URL', type: 'url' }],
    views: [grid('All publications')],
  },
  experiment: {
    name: 'Experiments', kind: 'experiment', icon: 'beaker', description: 'Wet-lab or in-silico experiments with dates',
    fields: [{ name: 'Experiment', type: 'text', key: 'name' }, { name: 'Date', type: 'date', key: 'date' }, { name: 'Owner', type: 'user' }, { name: 'Protocol', type: 'longtext' }, { name: 'Result', type: 'longtext' }, status()],
    views: [grid(), { name: 'Schedule', type: 'calendar', config: (f) => ({ dateField: f('Date') }) }, kanban()],
  },
  analysis: {
    name: 'Analysis Results', kind: 'analysis', icon: 'chart', description: 'Saved analyses with parameters and reproducible code',
    fields: [
      { name: 'Name', type: 'text', key: 'name' },
      { name: 'Analysis type', type: 'singleSelect', key: 'analysisType', options: { choices: ch('Alignment|Comparison|Heatmap|PCA|Statistics|Phylogeny', ['blue', 'sky', 'amber', 'green', 'gray', 'blue']) } },
      { name: 'Summary', type: 'longtext', key: 'summary' },
      { name: 'Analysis ID', type: 'text', key: 'analysisId' },
      { name: 'Created', type: 'createdTime' },
      status(),
    ],
    views: [grid(), kanban(), { name: 'Timeline', type: 'calendar', config: (f) => ({ dateField: f('Created') }) }],
  },
  expression: {
    name: 'Expression', kind: 'custom', icon: 'chart', description: 'Gene expression measurements per sample',
    fields: [
      { name: 'Sample', type: 'text', key: 'name' }, { name: 'Condition', type: 'singleSelect', options: { choices: ch('Control|Treated|Time course|Other', ['gray', 'blue', 'amber', 'sky']) } },
      { name: 'Expression value', type: 'number', options: { precision: 3 }, key: 'value' }, { name: 'Unit', type: 'singleSelect', options: { choices: ch('TPM|FPKM|counts|log2FC|Ct', ['blue', 'blue', 'gray', 'green', 'amber']) } },
      { name: 'Replicate', type: 'number' },
    ],
    views: [grid()],
  },
  task: {
    name: 'Tasks', kind: 'task', icon: 'check', description: 'Research tasks, subtasks and deadlines',
    fields: [
      { name: 'Task', type: 'text', key: 'name' },
      { name: 'Status', type: 'status', options: { choices: TASK_STATUS }, key: 'status' },
      { name: 'Assignee', type: 'user', key: 'assignee' },
      { name: 'Due date', type: 'date', key: 'due' },
      { name: 'Priority', type: 'singleSelect', options: { choices: PRIORITY }, key: 'priority' },
      { name: 'Description', type: 'longtext' },
    ],
    views: [
      { name: 'Board', type: 'kanban', config: (f) => ({ kanbanField: f('Status') }) },
      grid('All tasks'), { name: 'List', type: 'list' },
      { name: 'Deadlines', type: 'calendar', config: (f) => ({ dateField: f('Due date') }) },
    ],
  },
};

/** Relations created when BOTH tables are part of the template: [from, field name, to, inverse name]. */
const RELATIONS: [string, string, string, string][] = [
  ['dna', 'Genes', 'gene', 'DNA sequences'],
  ['dna', 'Organism', 'organism', 'DNA sequences'],
  ['gene', 'Organism', 'organism', 'Genes'],
  ['gene', 'Proteins', 'protein', 'Genes'],
  ['protein', 'Organism', 'organism', 'Proteins'],
  ['protein', 'Chemicals', 'chemical', 'Proteins'],
  ['protein', 'Structures', 'structure', 'Proteins'],
  ['protein', 'Publications', 'publication', 'Proteins'],
  ['protein', 'Experiments', 'experiment', 'Proteins'],
  ['chemical', 'Publications', 'publication', 'Chemicals'],
  ['gene', 'Publications', 'publication', 'Genes'],
  ['analysis', 'Proteins', 'protein', 'Analyses'],
  ['analysis', 'DNA sequences', 'dna', 'Analyses'],
  ['analysis', 'Chemicals', 'chemical', 'Analyses'],
  ['analysis', 'Genes', 'gene', 'Analyses'],
  ['expression', 'Gene', 'gene', 'Expression'],
  ['expression', 'Experiment', 'experiment', 'Expression'],
  ['experiment', 'Chemicals', 'chemical', 'Experiments'],
  ['task', 'Proteins', 'protein', 'Tasks'],
  ['task', 'Genes', 'gene', 'Tasks'],
  ['task', 'DNA sequences', 'dna', 'Tasks'],
  ['task', 'Chemicals', 'chemical', 'Tasks'],
  ['task', 'Experiments', 'experiment', 'Tasks'],
  ['task', 'Analyses', 'analysis', 'Tasks'],
];

export interface TemplateDef { id: string; name: string; description: string; tables: string[]; automations: string[] }

export const TEMPLATES: TemplateDef[] = [
  { id: 'discovery', name: 'Full research pipeline', description: 'DNA → Gene → Protein → Chemical → Structure → Analysis, with tasks. The recommended starting point.',
    tables: ['organism', 'dna', 'gene', 'protein', 'chemical', 'structure', 'publication', 'experiment', 'analysis', 'task'],
    automations: ['dna-fetch-ncbi', 'dna-discover-genes', 'protein-alphafold', 'protein-chemicals', 'chemical-pubchem', 'failed-fetch-task', 'analysis-notify'] },
  { id: 'dna-collection', name: 'DNA Sequence Collection', description: 'Collect nucleotide records by accession or FASTA; metadata and genes are fetched for you.',
    tables: ['organism', 'dna', 'gene', 'task'], automations: ['dna-fetch-ncbi', 'dna-discover-genes', 'failed-fetch-task'] },
  { id: 'protein-annotation', name: 'Protein Annotation Database', description: 'Proteins with UniProt annotation, InterPro domains and structure availability.',
    tables: ['organism', 'protein', 'structure', 'publication', 'task'], automations: ['protein-alphafold'] },
  { id: 'chemical-compounds', name: 'Chemical Compound Database', description: 'Compounds identified by PubChem CID / InChIKey with duplicate detection.',
    tables: ['chemical', 'publication', 'task'], automations: ['chemical-pubchem'] },
  { id: 'protein-ligand', name: 'Protein-Ligand Discovery', description: 'Proteins, their evidence-classified chemical relationships, and structures.',
    tables: ['protein', 'chemical', 'structure', 'publication', 'analysis', 'task'], automations: ['protein-alphafold', 'protein-chemicals', 'chemical-pubchem'] },
  { id: 'project-tracker', name: 'Research Project Tracker', description: 'Tasks, experiments and a calendar — no external databases.',
    tables: ['experiment', 'task'], automations: [] },
  { id: 'sequence-alignment', name: 'Sequence Alignment', description: 'DNA and protein sequences with saved alignment / comparison results.',
    tables: ['dna', 'protein', 'analysis', 'task'], automations: ['analysis-notify'] },
  { id: 'structure-collection', name: 'Molecular Structure Collection', description: 'Predicted and experimental structures with a gallery and 3D viewer.',
    tables: ['protein', 'structure', 'task'], automations: ['protein-alphafold'] },
  { id: 'gene-expression', name: 'Gene Expression Analysis', description: 'Genes, samples and expression values ready for heatmaps and PCA.',
    tables: ['organism', 'gene', 'experiment', 'expression', 'analysis', 'task'], automations: ['analysis-notify'] },
];

export function getTemplate(id: string): TemplateDef {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw bad('Unknown template');
  return t;
}

/** Create the template's tables in a project. Existing table names get " 2", " 3" suffixes. Returns table ids by def key. */
export function applyTemplate(workspaceId: string, projectId: string | null, tplId: string, o: { automations: boolean; enableAutomations?: boolean; userId: string | null }): Record<string, string> {
  const tpl = getTemplate(tplId);
  const ids: Record<string, string> = {};
  tx(() => {
    const existing = new Set(q.all<{ name: string }>('SELECT name FROM tables WHERE workspace_id=? AND project_id IS ?', workspaceId, projectId).map((r) => r.name.toLowerCase()));
    const uniq = (n: string) => { let x = n, i = 2; while (existing.has(x.toLowerCase())) x = `${n} ${i++}`; existing.add(x.toLowerCase()); return x; };
    // 1) tables with their scalar/computed fields (choice ids are regenerated per field so they are unique)
    for (const key of tpl.tables) {
      const d = TABLE_DEFS[key];
      const t = createTable({
        workspaceId, projectId, name: uniq(d.name), kind: d.kind, description: d.description, icon: d.icon, withDefaultView: false,
        fields: d.fields.map((f) => ({ ...f, options: f.options && f.options.choices ? { ...f.options, choices: f.options.choices.map((c) => ({ name: c.name, color: c.color })) as SelectChoice[] } : f.options })),
      });
      ids[key] = t.id;
    }
    // 2) relations (creates inverse fields)
    for (const [from, name, to, inverse] of RELATIONS) {
      if (!ids[from] || !ids[to]) continue;
      createField(ids[from], { name, type: 'relation', options: { targetTable: ids[to] }, inverseName: inverse }, { silent: true });
    }
    // task self-relation for subtasks
    if (ids.task) createField(ids.task, { name: 'Parent task', type: 'relation', options: { targetTable: ids.task }, inverseName: 'Subtasks' }, { silent: true });
    // 3) views, now that every field exists
    for (const key of tpl.tables) {
      const d = TABLE_DEFS[key];
      const fields = listFields(ids[key]);
      const fid = (n: string) => fields.find((f) => f.name === n)?.id;
      for (const v of d.views) createView(ids[key], { name: v.name, type: v.type, config: v.config?.(fid) });
      // a sensible default: hide long/technical columns in the first grid view is left to the user
    }
    if (o.automations && tpl.automations.length) installAutomationTemplates(workspaceId, projectId, ids, tpl.automations, { enabled: !!o.enableAutomations, userId: o.userId });
  });
  return ids;
}

/** Add one built-in table to a project on demand (used when an import needs e.g. Proteins and the project has none). */
/**
 * Projects created by an earlier version lack columns the templates gained later (protein/chemical sub-type and the structure-image column).
 * Add them to existing tables – never changing or removing anything the researcher has – so old projects keep working and get the new views.
 * Idempotent; called at start-up and after a restore/import.
 */
const ADDED_FIELDS: Record<string, string[]> = { protein: ['protType', 'thumb'], chemical: ['chemType', 'thumb'] };
export function upgradeTemplateFields(): number {
  let added = 0;
  for (const t of q.all<{ id: string; kind: string }>("SELECT id, kind FROM tables WHERE kind IN ('protein','chemical')")) {
    const def = TABLE_DEFS[t.kind]; if (!def) continue;
    const have = new Set(listFields(t.id).map((f) => f.key).filter(Boolean));
    for (const key of ADDED_FIELDS[t.kind] ?? []) {
      if (have.has(key)) continue; const f = def.fields.find((x) => x.key === key); if (!f) continue;
      try { createField(t.id, { name: f.name, type: f.type, options: f.options, key }, { silent: true }); added++; } catch { /* a field with that name already exists in the researcher's own layout: leave their table as it is */ }
    }
  }
  return added;
}

export function ensureProjectTable(workspaceId: string, projectId: string | null, kind: string): string {
  const key = Object.entries(TABLE_DEFS).find(([, d]) => d.kind === kind)?.[0];
  if (!key) throw bad(`No built-in table for kind "${kind}"`);
  const d = TABLE_DEFS[key];
  return tx(() => {
    const t = createTable({ workspaceId, projectId, name: d.name, kind: d.kind, description: d.description, icon: d.icon, withDefaultView: false, fields: d.fields });
    const siblings = q.all<{ id: string; kind: string }>('SELECT id, kind FROM tables WHERE workspace_id=? AND project_id IS ? AND id<>?', workspaceId, projectId, t.id);
    const idByKey = (k: string) => (k === key ? t.id : siblings.find((s) => s.kind === TABLE_DEFS[k]?.kind)?.id);
    for (const [from, name, to, inverse] of RELATIONS) {
      if (from !== key && to !== key) continue;
      const fromId = idByKey(from), toId = idByKey(to);
      if (!fromId || !toId || fromId === toId) continue;
      try { createField(fromId, { name, type: 'relation', options: { targetTable: toId }, inverseName: inverse }, { silent: true }); } catch { /* relation already exists */ }
    }
    const fields = listFields(t.id);
    const fid = (n: string) => fields.find((f) => f.name === n)?.id;
    for (const v of d.views) createView(t.id, { name: v.name, type: v.type, config: v.config?.(fid) });
    return t.id;
  });
}

export function createProject(workspaceId: string, userId: string, spec: { name: string; description?: string; template?: string; visibility?: 'workspace' | 'private'; deadline?: string | null; automations?: boolean }) {
  const id = uid('prj');
  const name = String(spec.name ?? '').trim().slice(0, 120);
  if (!name) throw bad('Project name is required');
  let tableIds: Record<string, string> = {};
  tx(() => {
    q.run('INSERT INTO projects(id,workspace_id,name,description,visibility,deadline,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)', id, workspaceId, name, (spec.description ?? '').slice(0, 2000), spec.visibility === 'private' ? 'private' : 'workspace', spec.deadline ?? null, now(), userId);
    if (spec.visibility === 'private') q.run("INSERT INTO project_members(project_id,user_id,role) VALUES (?,?,'editor')", id, userId);
    if (spec.template && spec.template !== 'blank') tableIds = applyTemplate(workspaceId, id, spec.template, { automations: spec.automations !== false, userId });
  });
  return { id, tableIds };
}

/** A new workspace starts with one ready-to-use project so the user sees a working pipeline immediately. */
export function seedWorkspace(workspaceId: string, userId: string) {
  createProject(workspaceId, userId, { name: 'My first project', description: 'Starter project with the full DNA → protein → chemical → structure pipeline.', template: 'discovery', automations: true });
}
