// Tables, fields and views: the "flexible schema" half of the Airtable-style engine.
import { q, tx } from './db.ts';
import { bad, notFound, now, safeJson, uid } from './util.ts';
import { COMPUTED_TYPES, FIELD_TYPES } from '../shared/types.ts';
import type { Field, FieldOptions, FieldType, SelectChoice, TableKind, TableMeta, ViewConfig, ViewMeta, ViewType, ChoiceColor } from '../shared/types.ts';
import { checkFormula, formulaRefs, parseFormula } from '../shared/formula.ts';
import { getTable } from './access.ts';
import { publish } from './events.ts';

// ---------- fields ----------
const fieldCache = new Map<string, Field[]>();
export const invalidateFields = (tableId: string) => fieldCache.delete(tableId);

interface FieldRow { id: string; table_id: string; name: string; type: string; options: string; position: number; key: string | null }
const toField = (r: FieldRow): Field => ({ id: r.id, tableId: r.table_id, name: r.name, type: r.type as FieldType, options: safeJson<FieldOptions>(r.options, {}), position: r.position, key: r.key });

export function listFields(tableId: string): Field[] {
  let f = fieldCache.get(tableId);
  if (!f) {
    f = q.all<FieldRow>('SELECT * FROM fields WHERE table_id=? ORDER BY position, rowid', tableId).map(toField);
    fieldCache.set(tableId, f);
  }
  return f;
}
export function getField(fieldId: string): Field {
  const r = q.get<FieldRow>('SELECT * FROM fields WHERE id=?', fieldId);
  if (!r) throw notFound('Field not found');
  return toField(r);
}
export const fieldByKey = (tableId: string, key: string): Field | undefined => listFields(tableId).find((f) => f.key === key);
export const primaryField = (tableId: string): Field => listFields(tableId)[0];

const COLORS: ChoiceColor[] = ['blue', 'green', 'amber', 'red', 'sky', 'gray', 'ink'];
export function normalizeChoices(raw: unknown, existing: SelectChoice[] = []): SelectChoice[] {
  if (!Array.isArray(raw)) return existing;
  const seen = new Set<string>();
  return raw.slice(0, 200).map((c, i) => {
    const o = typeof c === 'string' ? { name: c } : (c as Partial<SelectChoice>);
    const name = String(o.name ?? '').trim().slice(0, 100);
    if (!name) throw bad('Choice names cannot be empty');
    if (seen.has(name.toLowerCase())) throw bad(`Duplicate choice "${name}"`);
    seen.add(name.toLowerCase());
    const color = COLORS.includes(o.color as ChoiceColor) ? (o.color as ChoiceColor) : COLORS[i % COLORS.length];
    return { id: o.id && existing.some((e) => e.id === o.id) ? o.id : uid('sel'), name, color };
  });
}

/** Reject a formula that (directly or through other formula fields) depends on itself. */
function assertNoFormulaCycle(tableId: string, selfName: string, formula: string) {
  const me = selfName.toLowerCase();
  const graph = new Map<string, string[]>();
  for (const f of listFields(tableId)) {
    if (f.type !== 'formula' || f.name.toLowerCase() === me) continue;
    try { graph.set(f.name.toLowerCase(), [...formulaRefs(parseFormula(f.options.formula ?? ''))].map((s) => s.toLowerCase())); } catch { /* invalid formulas are reported elsewhere */ }
  }
  const stack = [...formulaRefs(parseFormula(formula))].map((s) => s.toLowerCase());
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === me) throw bad('This formula would reference itself (circular reference)');
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(graph.get(n) ?? []));
  }
}

function cleanOptions(type: FieldType, o: FieldOptions, tableId: string, existing?: FieldOptions, selfName = ''): FieldOptions {
  const out: FieldOptions = {};
  switch (type) {
    case 'singleSelect': case 'multiSelect': case 'status':
      out.choices = normalizeChoices(o.choices ?? [], existing?.choices ?? []);
      break;
    case 'number': out.precision = Math.min(10, Math.max(0, Math.trunc(Number(o.precision ?? 0)) || 0)); break;
    case 'formula': {
      const f = String(o.formula ?? '').trim();
      if (!f) throw bad('Formula cannot be empty');
      const err = checkFormula(f);
      if (err) throw bad(`Formula error: ${err}`);
      if (selfName) assertNoFormulaCycle(tableId, selfName, f);
      out.formula = f;
      break;
    }
    case 'relation': {
      const target = String(o.targetTable ?? '');
      const tt = getTable(target);
      if (tt.workspace_id !== getTable(tableId).workspace_id) throw bad('Linked table must be in the same workspace');
      out.targetTable = target;
      out.inverseFieldId = existing?.inverseFieldId ?? null;
      break;
    }
    case 'lookup': case 'rollup': {
      const rel = listFields(tableId).find((f) => f.id === o.relationField && f.type === 'relation');
      if (!rel) throw bad('Choose a link field to look through');
      const lf = listFields(rel.options.targetTable!).find((f) => f.id === o.lookupField);
      if (!lf) throw bad('Choose a field in the linked table');
      out.relationField = rel.id; out.lookupField = lf.id;
      if (type === 'rollup') {
        const fns = ['sum', 'avg', 'min', 'max', 'count', 'countAll', 'join', 'unique', 'earliest', 'latest'];
        out.rollupFn = fns.includes(String(o.rollupFn)) ? o.rollupFn : 'count';
      }
      break;
    }
    case 'sequence': out.seqType = ['dna', 'rna', 'protein'].includes(String(o.seqType)) ? o.seqType : 'dna'; break;
    case 'date': out.includeTime = !!o.includeTime; break;
  }
  return out;
}

export function createField(tableId: string, spec: { name: string; type: FieldType; options?: FieldOptions; key?: string | null; position?: number; inverseName?: string }, opts: { silent?: boolean; noInverse?: boolean } = {}): Field {
  const name = String(spec.name ?? '').trim().slice(0, 100);
  if (!name) throw bad('Field name is required');
  if (!FIELD_TYPES.some((t) => t.type === spec.type)) throw bad('Unknown field type');
  const fields = listFields(tableId);
  if (fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw bad(`A field named "${name}" already exists`);
  const options = cleanOptions(spec.type, spec.options ?? {}, tableId, undefined, name);
  const id = uid('fld');
  const position = spec.position ?? (fields.length ? Math.max(...fields.map((f) => f.position)) + 1 : 0);
  tx(() => {
    q.run('INSERT INTO fields(id,table_id,name,type,options,position,key) VALUES (?,?,?,?,?,?,?)', id, tableId, name, spec.type, JSON.stringify(options), position, spec.key ?? null);
    invalidateFields(tableId);
    if (spec.type === 'relation' && !opts.noInverse) {
      // Create the inverse field in the target table so the link is navigable from both sides.
      const target = options.targetTable!;
      const inverseName = uniqueName(target, spec.inverseName?.trim() || (target === tableId ? `${name} (inverse)` : getTable(tableId).name));
      const invId = uid('fld');
      const tpos = listFields(target).length;
      q.run('INSERT INTO fields(id,table_id,name,type,options,position,key) VALUES (?,?,?,?,?,?,NULL)', invId, target, inverseName, 'relation',
        JSON.stringify({ targetTable: tableId, inverseFieldId: id }), tpos);
      invalidateFields(target);
      q.run('UPDATE fields SET options=? WHERE id=?', JSON.stringify({ ...options, inverseFieldId: invId }), id);
      invalidateFields(tableId);
    }
  });
  const field = getField(id);
  if (!opts.silent) announceSchema(tableId);
  return field;
}

function uniqueName(tableId: string, base: string) {
  const names = new Set(listFields(tableId).map((f) => f.name.toLowerCase()));
  let n = base || 'Linked', i = 2;
  while (names.has(n.toLowerCase())) n = `${base} ${i++}`;
  return n;
}

const SCALAR_CONVERTIBLE = new Set<FieldType>(['text', 'longtext', 'url', 'sequence', 'number', 'singleSelect', 'multiSelect', 'status', 'checkbox', 'date']);

export function updateField(fieldId: string, patch: { name?: string; options?: FieldOptions; type?: FieldType; position?: number; key?: string | null }): { field: Field; lost: number } {
  const f = getField(fieldId);
  let lost = 0;
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 100) : f.name;
  if (!name) throw bad('Field name is required');
  if (listFields(f.tableId).some((x) => x.id !== f.id && x.name.toLowerCase() === name.toLowerCase())) throw bad(`A field named "${name}" already exists`);
  const type = patch.type ?? f.type;
  tx(() => {
    let options = f.options;
    if (type !== f.type) {
      if (!SCALAR_CONVERTIBLE.has(f.type)) throw bad(`Cannot convert ${f.type} to ${type}`);
      options = cleanOptions(type, patch.options ?? {}, f.tableId, undefined, name);
      if (SCALAR_CONVERTIBLE.has(type)) lost = convertValues(f, type, options);
      else if (type === 'formula' || type === 'thumbnail' || type === 'createdTime' || type === 'lastModifiedTime') q.run(`UPDATE records SET data = json_remove(data, '$."${f.id}"') WHERE table_id=?`, f.tableId);
      else throw bad(`Cannot convert ${f.type} to ${type}`);
    } else if (patch.options) {
      options = cleanOptions(type, { ...f.options, ...patch.options }, f.tableId, f.options, name);
    }
    // renaming a field rewrites {Old name} references in the table's formulas so they keep working
    if (name !== f.name) {
      for (const other of listFields(f.tableId)) {
        if (other.type !== 'formula' || other.id === f.id || !other.options.formula?.includes(`{${f.name}}`)) continue;
        q.run('UPDATE fields SET options=? WHERE id=?', JSON.stringify({ ...other.options, formula: other.options.formula.split(`{${f.name}}`).join(`{${name}}`) }), other.id);
      }
      if (type === 'formula' && options.formula) options = { ...options, formula: options.formula.split(`{${f.name}}`).join(`{${name}}`) };
    }
    q.run('UPDATE fields SET name=?, type=?, options=?, position=?, key=? WHERE id=?', name, type, JSON.stringify(options), patch.position ?? f.position, patch.key === undefined ? f.key ?? null : patch.key, f.id);
  });
  invalidateFields(f.tableId);
  announceSchema(f.tableId);
  return { field: getField(fieldId), lost };
}

/** Convert stored values when a field's type changes; returns the number of values that could not be converted. */
function convertValues(f: Field, to: FieldType, opts: FieldOptions): number {
  let lost = 0;
  const rows = q.all<{ id: string; data: string }>('SELECT id, data FROM records WHERE table_id=?', f.tableId);
  const choiceByName = new Map((opts.choices ?? []).map((c) => [c.name.toLowerCase(), c.id]));
  const oldChoice = new Map((f.options.choices ?? []).map((c) => [c.id, c.name]));
  const isSel = (t: FieldType) => t === 'singleSelect' || t === 'multiSelect' || t === 'status';
  const addChoices = new Map<string, SelectChoice>();
  const upd = (id: string, d: Record<string, unknown>) => q.run('UPDATE records SET data=? WHERE id=?', JSON.stringify(d), id);
  const toText = (v: unknown): string => Array.isArray(v) ? v.map(toText).join(', ') : isSel(f.type) && typeof v === 'string' ? oldChoice.get(v) ?? v : String(v);
  for (const r of rows) {
    const d = safeJson<Record<string, unknown>>(r.data, {});
    const v = d[f.id];
    if (v === undefined || v === null) continue;
    let nv: unknown = null;
    const txt = toText(v);
    if (to === 'number') { const n = Number(txt.replace(/,/g, '')); nv = Number.isNaN(n) || txt.trim() === '' ? null : n; }
    else if (to === 'checkbox') nv = ['true', '1', 'yes', 'x', '✓'].includes(txt.toLowerCase());
    else if (to === 'date') { const t = Date.parse(txt); nv = Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, opts.includeTime ? 24 : 10); }
    else if (isSel(to)) {
      const names = txt.split(',').map((s) => s.trim()).filter(Boolean);
      const ids = names.map((nm) => {
        let id = choiceByName.get(nm.toLowerCase());
        if (!id) { id = uid('sel'); choiceByName.set(nm.toLowerCase(), id); addChoices.set(id, { id, name: nm, color: COLORS[addChoices.size % COLORS.length] }); }
        return id;
      });
      nv = to === 'multiSelect' ? ids : ids[0] ?? null;
    } else nv = txt;
    if (nv === null) lost++;
    if (nv === null || nv === undefined) delete d[f.id]; else d[f.id] = nv;
    upd(r.id, d);
  }
  if (addChoices.size) opts.choices = [...(opts.choices ?? []), ...addChoices.values()];
  return lost;
}

export function deleteField(fieldId: string) {
  const f = getField(fieldId);
  const fields = listFields(f.tableId);
  if (fields[0]?.id === f.id) throw bad('The primary field cannot be deleted. Make another field primary first.');
  tx(() => {
    // dependents: lookups / rollups through this relation, and lookups of this field
    for (const other of q.all<FieldRow>('SELECT * FROM fields')) {
      const o = safeJson<FieldOptions>(other.options, {});
      if (other.id !== f.id && (o.relationField === f.id || o.lookupField === f.id)) q.run('DELETE FROM fields WHERE id=?', other.id);
    }
    if (f.type === 'relation' && f.options.inverseFieldId) q.run('DELETE FROM fields WHERE id=?', f.options.inverseFieldId);
    q.run('DELETE FROM fields WHERE id=?', f.id);
    if (!COMPUTED_TYPES.has(f.type)) q.run(`UPDATE records SET data = json_remove(data, '$."${f.id}"') WHERE table_id=?`, f.tableId);
    // strip the field from every view
    for (const v of q.all<{ id: string; config: string }>('SELECT id, config FROM views')) {
      const c = safeJson<ViewConfig>(v.config, {});
      const strip = (x: unknown) => JSON.stringify(x).includes(f.id);
      if (!strip(c)) continue;
      c.hidden = c.hidden?.filter((i) => i !== f.id); c.order = c.order?.filter((i) => i !== f.id);
      c.sorts = c.sorts?.filter((s) => s.field !== f.id);
      if (c.groupBy?.field === f.id) c.groupBy = null;
      if (c.kanbanField === f.id) delete c.kanbanField;
      if (c.dateField === f.id) delete c.dateField;
      if (c.coverField === f.id) delete c.coverField;
      if (c.filter) c.filter = pruneFilter(c.filter, f.id);
      q.run('UPDATE views SET config=? WHERE id=?', JSON.stringify(c), v.id);
    }
  });
  invalidateFields(f.tableId);
  if (f.options.targetTable) invalidateFields(f.options.targetTable);
  announceSchema(f.tableId);
}

function pruneFilter(g: NonNullable<ViewConfig['filter']>, fieldId: string): NonNullable<ViewConfig['filter']> {
  return { mode: g.mode, items: g.items.filter((i) => ('items' in i ? true : i.field !== fieldId)).map((i) => ('items' in i ? pruneFilter(i, fieldId) : i)) };
}

/** Persist a new left-to-right order. The first id becomes the primary field. */
export function reorderFields(tableId: string, ids: string[]) {
  const fields = listFields(tableId);
  const known = new Set(fields.map((f) => f.id));
  const order = [...ids.filter((i) => known.has(i)), ...fields.map((f) => f.id).filter((i) => !ids.includes(i))];
  const first = fields.find((f) => f.id === order[0])!;
  if (COMPUTED_TYPES.has(first.type) && first.type !== 'formula') throw bad('A link, lookup or rollup field cannot be the primary field');
  tx(() => order.forEach((id, i) => q.run('UPDATE fields SET position=? WHERE id=?', i, id)));
  invalidateFields(tableId);
  announceSchema(tableId);
}

function announceSchema(tableId: string) {
  const t = q.get<{ workspace_id: string }>('SELECT workspace_id FROM tables WHERE id=?', tableId);
  if (t) publish(t.workspace_id, 'schema.changed', { tableId });
}

// ---------- tables ----------
const toTable = (r: any): TableMeta => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, kind: r.kind as TableKind, description: r.description, icon: r.icon, createdAt: r.created_at,
  recordCount: r.n,
});

export function listTables(workspaceId: string, projectId?: string | null): TableMeta[] {
  const rows = projectId
    ? q.all('SELECT t.*, (SELECT COUNT(*) FROM records r WHERE r.table_id=t.id) n FROM tables t WHERE t.workspace_id=? AND t.project_id=? ORDER BY t.position, t.created_at', workspaceId, projectId)
    : q.all('SELECT t.*, (SELECT COUNT(*) FROM records r WHERE r.table_id=t.id) n FROM tables t WHERE t.workspace_id=? ORDER BY t.position, t.created_at', workspaceId);
  return rows.map(toTable);
}

export function createTable(spec: {
  workspaceId: string; projectId?: string | null; name: string; kind?: TableKind; description?: string; icon?: string | null;
  fields?: { name: string; type: FieldType; options?: FieldOptions; key?: string; inverseName?: string }[]; withDefaultView?: boolean;
}): TableMeta {
  const name = String(spec.name ?? '').trim().slice(0, 100);
  if (!name) throw bad('Table name is required');
  const id = uid('tbl');
  tx(() => {
    const pos = (q.get<{ m: number | null }>('SELECT MAX(position) m FROM tables WHERE workspace_id=?', spec.workspaceId)?.m ?? -1) + 1;
    q.run('INSERT INTO tables(id,workspace_id,project_id,name,kind,description,icon,position,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, spec.workspaceId, spec.projectId ?? null, name, spec.kind ?? 'custom', spec.description ?? '', spec.icon ?? null, pos, now());
    const fields = spec.fields?.length ? spec.fields : [{ name: 'Name', type: 'text' as FieldType }];
    // non-relation fields first so relation targets/lookups resolve
    for (const f of fields) createField(id, f, { silent: true });
    if (spec.withDefaultView !== false) createView(id, { name: 'Grid', type: 'grid' });
  });
  publish(spec.workspaceId, 'schema.changed', { tableId: id });
  return toTable({ ...getTable(id), n: 0 });
}

export function deleteTable(tableId: string) {
  const t = getTable(tableId);
  tx(() => {
    // remove fields in other tables that point here (relations + their lookups)
    for (const other of q.all<FieldRow>('SELECT * FROM fields WHERE table_id<>?', tableId)) {
      const o = safeJson<FieldOptions>(other.options, {});
      if (o.targetTable === tableId) q.run('DELETE FROM fields WHERE id=?', other.id);
    }
    q.run('DELETE FROM search WHERE tid=?', tableId);
    q.run('DELETE FROM tables WHERE id=?', tableId);
  });
  fieldCache.clear();
  publish(t.workspace_id, 'schema.changed', { tableId });
}

// ---------- views ----------
const VIEW_TYPES: ViewType[] = ['grid', 'kanban', 'gallery', 'list', 'calendar', 'graph'];
const toView = (r: any): ViewMeta => ({ id: r.id, tableId: r.table_id, name: r.name, type: r.type, config: safeJson<ViewConfig>(r.config, {}), position: r.position });

export function listViews(tableId: string): ViewMeta[] {
  return q.all('SELECT * FROM views WHERE table_id=? ORDER BY position, rowid', tableId).map(toView);
}
export function getView(id: string): ViewMeta {
  const r = q.get('SELECT * FROM views WHERE id=?', id);
  if (!r) throw notFound('View not found');
  return toView(r);
}

/** Choose sensible defaults when a view is created so Kanban/Calendar/Gallery work immediately. */
function defaultConfig(tableId: string, type: ViewType, given: ViewConfig = {}): ViewConfig {
  const fields = listFields(tableId);
  const c: ViewConfig = { ...given };
  if (type === 'kanban' && !c.kanbanField) c.kanbanField = (fields.find((f) => f.type === 'status') ?? fields.find((f) => f.type === 'singleSelect'))?.id;
  if (type === 'calendar' && !c.dateField) c.dateField = fields.find((f) => f.type === 'date')?.id;
  if (type === 'gallery' && !c.coverField) c.coverField = fields.find((f) => f.type === 'structure' || f.type === 'attachment')?.id;
  return c;
}

export function createView(tableId: string, spec: { name: string; type: ViewType; config?: ViewConfig }): ViewMeta {
  if (!VIEW_TYPES.includes(spec.type)) throw bad('Unknown view type');
  const name = String(spec.name ?? '').trim().slice(0, 100) || spec.type;
  const id = uid('viw');
  const pos = (q.get<{ m: number | null }>('SELECT MAX(position) m FROM views WHERE table_id=?', tableId)?.m ?? -1) + 1;
  q.run('INSERT INTO views(id,table_id,name,type,config,position) VALUES (?,?,?,?,?,?)', id, tableId, name, spec.type, JSON.stringify(defaultConfig(tableId, spec.type, spec.config)), pos);
  return getView(id);
}
export function updateView(id: string, patch: { name?: string; config?: ViewConfig; position?: number }): ViewMeta {
  const v = getView(id);
  q.run('UPDATE views SET name=?, config=?, position=? WHERE id=?', patch.name?.trim().slice(0, 100) || v.name, JSON.stringify(patch.config ?? v.config), patch.position ?? v.position, id);
  const t = getTable(v.tableId);
  publish(t.workspace_id, 'view.changed', { tableId: v.tableId, viewId: id });
  return getView(id);
}
export function deleteView(id: string) {
  const v = getView(id);
  if (listViews(v.tableId).length <= 1) throw bad('A table needs at least one view');
  q.run('DELETE FROM views WHERE id=?', id);
}
