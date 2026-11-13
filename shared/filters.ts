// Filter / sort / group evaluation. ONE canonical implementation, used by the server query engine.
import type { Field, FilterCondition, FilterGroup, FilterOp, SortSpec, CellValue } from './types.ts';

export const isGroup = (x: FilterCondition | FilterGroup): x is FilterGroup => (x as FilterGroup).items !== undefined;

/** Reduce any cell value to a comparable list of primitives (select ids, relation ids, strings, numbers). */
export function cellAtoms(v: CellValue): (string | number | boolean)[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(cellAtoms);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string') return [o.id];
    if (typeof o.name === 'string') return [o.name];
    return [JSON.stringify(v)];
  }
  return [v as string | number | boolean];
}

/** Text to search/compare on: relation refs and attachments use names, selects use their choice name. */
export function cellText(v: CellValue, field?: Field): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => cellText(x, field)).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.name ?? o.id ?? o.accession ?? JSON.stringify(v));
  }
  if (field?.options.choices && (field.type === 'singleSelect' || field.type === 'multiSelect' || field.type === 'status')) {
    return field.options.choices.find((c) => c.id === v)?.name ?? String(v);
  }
  return String(v);
}

const isEmpty = (v: CellValue): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function asNum(v: CellValue): number | null {
  const a = cellAtoms(v)[0];
  if (a === undefined) return null;
  const n = typeof a === 'number' ? a : Number(a);
  return Number.isNaN(n) ? null : n;
}
function asTime(v: CellValue): number | null {
  const a = cellAtoms(v)[0];
  if (a === undefined) return null;
  const t = Date.parse(String(a));
  return Number.isNaN(t) ? null : t;
}

export function matchCondition(c: FilterCondition, v: CellValue, field: Field | undefined): boolean {
  const op: FilterOp = c.op;
  const t = field?.type;
  if (op === 'isEmpty') return isEmpty(v) || (t === 'checkbox' && !v);
  if (op === 'isNotEmpty') return !isEmpty(v) && !(t === 'checkbox' && !v);
  if (op === 'isTrue') return v === true;
  if (op === 'isFalse') return v !== true;
  const want = c.value;
  if (t === 'number' || t === 'rollup' && typeof v === 'number' || (t === 'formula' && typeof v === 'number')) {
    const a = asNum(v), b = asNum(want as CellValue);
    if (op === 'is') return a !== null && a === b;
    if (op === 'isNot') return a !== b;
    if (a === null || b === null) return false;
    if (op === 'gt') return a > b;
    if (op === 'gte') return a >= b;
    if (op === 'lt') return a < b;
    if (op === 'lte') return a <= b;
  }
  if (t === 'date' || t === 'createdTime' || t === 'lastModifiedTime') {
    const a = asTime(v), b = asTime(want as CellValue);
    if (a === null || b === null) return op === 'isNot';
    const day = (x: number) => Math.floor(x / 864e5);
    if (op === 'is') return day(a) === day(b);
    if (op === 'isNot') return day(a) !== day(b);
    if (op === 'before' || op === 'lt') return a < b;
    if (op === 'after' || op === 'gt') return a > b;
    if (op === 'gte') return a >= b;
    if (op === 'lte') return a <= b;
  }
  if (op === 'hasAny' || op === 'hasAll' || op === 'hasNone') {
    const have = new Set(cellAtoms(v).map(String));
    const wants = cellAtoms(want as CellValue).map(String);
    if (op === 'hasAny') return wants.some((w) => have.has(w));
    if (op === 'hasAll') return wants.every((w) => have.has(w));
    return !wants.some((w) => have.has(w));
  }
  const isChoice = t === 'singleSelect' || t === 'multiSelect' || t === 'status' || t === 'user' || t === 'relation';
  if (isChoice && (op === 'is' || op === 'isNot')) {
    const have = cellAtoms(v).map(String);
    const hit = have.includes(String(want));
    return op === 'is' ? hit : !hit;
  }
  const text = cellText(v, field).toLowerCase();
  const w = String(want ?? '').toLowerCase();
  switch (op) {
    case 'is': return text === w;
    case 'isNot': return text !== w;
    case 'contains': return text.includes(w);
    case 'notContains': return !text.includes(w);
    case 'startsWith': return text.startsWith(w);
    case 'endsWith': return text.endsWith(w);
    case 'gt': return text > w;
    case 'gte': return text >= w;
    case 'lt': return text < w;
    case 'lte': return text <= w;
  }
  return false;
}

export function matchGroup(g: FilterGroup, get: (fieldId: string) => CellValue, fields: Map<string, Field>): boolean {
  if (!g.items.length) return true;
  const test = (it: FilterCondition | FilterGroup): boolean =>
    isGroup(it) ? matchGroup(it, get, fields) : matchCondition(it, get(it.field), fields.get(it.field));
  return g.mode === 'or' ? g.items.some(test) : g.items.every(test);
}

/** Sort key per field type: numbers numerically, dates by time, selects by choice order, everything else natural text order. */
export function sortKey(v: CellValue, field: Field | undefined): number | string | null {
  if (isEmpty(v)) return null;
  const t = field?.type;
  if (t === 'number' || typeof v === 'number') return asNum(v);
  if (t === 'checkbox') return v ? 1 : 0;
  if (t === 'date' || t === 'createdTime' || t === 'lastModifiedTime') return asTime(v);
  if ((t === 'singleSelect' || t === 'status') && field) {
    const i = field.options.choices?.findIndex((c) => c.id === v) ?? -1;
    return i < 0 ? 1e9 : i;
  }
  return cellText(v, field).toLowerCase();
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function compareKeys(a: number | string | null, b: number | string | null, dir: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // empties last in both directions
  if (b === null) return -1;
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return dir === 'asc' ? r : -r;
}

export function buildComparator(sorts: SortSpec[], fields: Map<string, Field>, get: (row: never, f: string) => CellValue) {
  return (x: never, y: never): number => {
    for (const s of sorts) {
      const f = fields.get(s.field);
      const r = compareKeys(sortKey(get(x, s.field), f), sortKey(get(y, s.field), f), s.dir);
      if (r) return r;
    }
    return 0;
  };
}
