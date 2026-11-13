// Types shared by the server and the browser client. Only erasable TypeScript (no enums) so Node can strip types.

export type FieldType =
  | 'text' | 'longtext' | 'number' | 'singleSelect' | 'multiSelect' | 'checkbox' | 'url' | 'attachment'
  | 'formula' | 'relation' | 'lookup' | 'rollup' | 'sequence' | 'structure' | 'thumbnail' | 'date' | 'createdTime'
  | 'lastModifiedTime' | 'user' | 'status';

export const FIELD_TYPES: { type: FieldType; label: string; computed?: boolean }[] = [
  { type: 'text', label: 'Text' },
  { type: 'longtext', label: 'Long text' },
  { type: 'number', label: 'Number' },
  { type: 'singleSelect', label: 'Single select' },
  { type: 'multiSelect', label: 'Multi select' },
  { type: 'status', label: 'Status' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'url', label: 'URL' },
  { type: 'attachment', label: 'Attachment' },
  { type: 'date', label: 'Date' },
  { type: 'user', label: 'User' },
  { type: 'sequence', label: 'Sequence' },
  { type: 'structure', label: 'Structure' },
  { type: 'relation', label: 'Link to records' },
  { type: 'lookup', label: 'Lookup', computed: true },
  { type: 'rollup', label: 'Rollup', computed: true },
  { type: 'formula', label: 'Formula', computed: true },
  { type: 'thumbnail', label: 'Structure image', computed: true },
  { type: 'createdTime', label: 'Created time', computed: true },
  { type: 'lastModifiedTime', label: 'Last modified time', computed: true },
];

/** Fields whose value is derived at read time and never stored in record data. */
export const COMPUTED_TYPES = new Set<FieldType>(['formula', 'relation', 'lookup', 'rollup', 'thumbnail', 'createdTime', 'lastModifiedTime']);

export type ChoiceColor = 'gray' | 'blue' | 'sky' | 'green' | 'amber' | 'red' | 'ink';
export interface SelectChoice { id: string; name: string; color?: ChoiceColor }

export type RollupFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countAll' | 'join' | 'unique' | 'earliest' | 'latest';
export type SeqType = 'dna' | 'rna' | 'protein';

export interface FieldOptions {
  choices?: SelectChoice[];
  precision?: number;
  formula?: string;
  targetTable?: string;
  inverseFieldId?: string | null;
  relationField?: string;
  lookupField?: string;
  rollupFn?: RollupFn;
  seqType?: SeqType;
  includeTime?: boolean;
  /** formula result display hint */
  resultType?: 'text' | 'number' | 'date' | 'checkbox';
}

export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  position: number;
  /** key used by templates/discovery so code can find "the accession field" even if the user renames it */
  key?: string | null;
}

export type TableKind =
  | 'custom' | 'dna' | 'rna' | 'gene' | 'protein' | 'chemical' | 'structure' | 'organism' | 'publication'
  | 'experiment' | 'analysis' | 'task' | 'job' | 'reaction' | 'pathway';

export const TABLE_KINDS: TableKind[] = ['custom', 'dna', 'rna', 'gene', 'protein', 'chemical', 'structure', 'organism', 'publication', 'experiment', 'analysis', 'task', 'job', 'reaction', 'pathway'];

export interface TableMeta {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  kind: TableKind;
  description: string;
  icon?: string | null;
  recordCount?: number;
  createdAt: string;
}

export type ViewType = 'grid' | 'kanban' | 'gallery' | 'list' | 'calendar' | 'graph';

export type FilterOp =
  | 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'isEmpty' | 'isNotEmpty'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'hasAny' | 'hasAll' | 'hasNone' | 'isTrue' | 'isFalse' | 'before' | 'after';

export interface FilterCondition { field: string; op: FilterOp; value?: unknown }
export interface FilterGroup { mode: 'and' | 'or'; items: (FilterCondition | FilterGroup)[] }
export interface SortSpec { field: string; dir: 'asc' | 'desc' }

export interface ViewConfig {
  filter?: FilterGroup;
  sorts?: SortSpec[];
  groupBy?: SortSpec | null;
  hidden?: string[];
  order?: string[];
  widths?: Record<string, number>;
  frozen?: number;
  // kanban
  kanbanField?: string;
  // gallery
  coverField?: string;
  cardFields?: string[];
  // calendar
  dateField?: string;
  endDateField?: string;
  // graph
  graphDepth?: number;
}

export interface ViewMeta {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  position: number;
}

export type CellValue = unknown;

export interface RecordRow {
  id: string;
  tableId: string;
  fields: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
}

export interface RelationRef { id: string; name: string; tableId?: string; meta?: LinkMeta | null }

/** Scientific evidence attached to a relationship (link). */
export type EvidenceClass =
  | 'experimentally_verified' | 'database_annotated' | 'computationally_predicted' | 'sequence_inferred' | 'user_supplied' | 'unverified';

export const EVIDENCE_LABELS: Record<EvidenceClass, string> = {
  experimentally_verified: 'Experimentally verified',
  database_annotated: 'Database annotated',
  computationally_predicted: 'Computationally predicted',
  sequence_inferred: 'Sequence inferred',
  user_supplied: 'User supplied',
  unverified: 'Unverified',
};

export interface LinkMeta {
  relationType?: string; // e.g. inhibitor, ligand, encodes, transcribed_from
  evidenceClass?: EvidenceClass;
  evidence?: string; // short human readable summary ("IC50 12 nM, binding assay")
  sourceDb?: string;
  sourceId?: string;
  referenceUrl?: string;
  details?: Record<string, unknown>;
}

export interface Provenance {
  id: string;
  recordId: string;
  sourceDb: string;
  accession: string | null;
  query: string | null;
  url: string | null;
  retrievedAt: string;
  step: string; // "import" | "metadata" | "discovery" | "manual" ...
  note?: string | null;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface JobInfo {
  id: string;
  type: string;
  name: string;
  status: JobStatus;
  workspaceId: string;
  projectId: string | null;
  progressDone: number | null;
  progressTotal: number | null;
  message: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
  output: { kind: string; ref: string; label?: string } | null;
  createdBy: string | null;
  automationId: string | null;
  depth: number;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export type TriggerType =
  | 'record_created' | 'field_changed' | 'status_changed' | 'file_uploaded' | 'fetch_completed' | 'analysis_completed' | 'schedule';

export type ActionType =
  | 'fetch_ncbi' | 'search_uniprot' | 'fetch_alphafold' | 'search_pubchem' | 'discover_chemicals' | 'discover_genes' | 'discover_proteins'
  | 'create_linked' | 'update_field' | 'start_analysis' | 'create_task' | 'notify' | 'export_results';

export type ConditionType =
  | 'accession_exists' | 'sequence_is_dna' | 'structure_unavailable' | 'chemical_has_verified_target' | 'processing_failed' | 'field_equals' | 'field_not_empty';

export interface AutomationSpec {
  trigger: { type: TriggerType; fieldId?: string; value?: string; everyMinutes?: number; at?: string };
  conditions: { type: ConditionType; fieldId?: string; value?: string }[];
  actions: { type: ActionType; params: Record<string, unknown> }[];
}
