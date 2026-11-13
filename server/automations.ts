// Automation engine: trigger -> conditions -> actions. Reliable by construction:
//  * loop prevention  – changes made by an automation (or by jobs it started) never re-trigger that same automation, and chains stop at depth 3
//  * duplicate prevention – one live run per (automation, record); job actions use dedupe keys
//  * retries / rate limits / cancellation – inherited from the durable job queue; every run keeps a step log
//  * manual reruns – POST /api/automations/:id/run
import { q } from './db.ts';
import { bad, now, safeJson, uid } from './util.ts';
import type { AutomationSpec, ConditionType, FieldType, TableKind } from '../shared/types.ts';
import { onRecordChange, getRaw, createRecord, updateRecord, hydrateRows, findByValue } from './records.ts';
import type { ChangeEvent } from './records.ts';
import { enqueue, onJobFinished } from './jobs.ts';
import { fieldByKey, listFields } from './schema.ts';
import { notify } from './notify.ts';
import { cellText } from '../shared/filters.ts';
import { detectSeqKind } from '../shared/sequence.ts';
import { exportRecords } from './exporter.ts';
import { publish } from './events.ts';
import { relationField } from './ingest.ts';

export const MAX_CHAIN_DEPTH = 3;

interface AutoRow { id: string; workspace_id: string; project_id: string | null; table_id: string; name: string; enabled: number; spec: string; created_by: string | null; last_run_at: string | null; run_count: number; template: string | null }
const parse = (r: AutoRow) => ({ ...r, spec: safeJson<AutomationSpec>(r.spec, { trigger: { type: 'record_created' }, conditions: [], actions: [] }) });

// ---------------- CRUD ----------------
export function validateSpec(tableId: string, spec: AutomationSpec) {
  const triggers = ['record_created', 'field_changed', 'status_changed', 'file_uploaded', 'fetch_completed', 'analysis_completed', 'schedule'];
  if (!spec?.trigger || !triggers.includes(spec.trigger.type)) throw bad('Choose a trigger');
  if (!Array.isArray(spec.actions) || !spec.actions.length) throw bad('Add at least one action');
  if (spec.actions.length > 10) throw bad('An automation can have at most 10 actions');
  const actions = ['fetch_ncbi', 'search_uniprot', 'fetch_alphafold', 'search_pubchem', 'discover_chemicals', 'discover_genes', 'discover_proteins', 'create_linked', 'update_field', 'start_analysis', 'create_task', 'notify', 'export_results'];
  for (const a of spec.actions) if (!actions.includes(a.type)) throw bad(`Unknown action ${a.type}`);
  const conds = ['accession_exists', 'sequence_is_dna', 'structure_unavailable', 'chemical_has_verified_target', 'processing_failed', 'field_equals', 'field_not_empty'];
  for (const c of spec.conditions ?? []) if (!conds.includes(c.type)) throw bad(`Unknown condition ${c.type}`);
  if (spec.trigger.type === 'schedule') {
    const m = spec.trigger.everyMinutes;
    if (!spec.trigger.at && !(m && m >= 15 && m <= 60 * 24 * 30)) throw bad('Scheduled automations need "every N minutes" (15 or more) or a daily time');
  }
  const fids = new Set(listFields(tableId).map((f) => f.id));
  if (spec.trigger.fieldId && !fids.has(spec.trigger.fieldId)) throw bad('Trigger field does not exist');
  const ua = spec.actions.find((a) => a.type === 'update_field' && !fids.has(String(a.params.fieldId)));
  if (ua) throw bad('An "update field" action points to a field that does not exist');
}

export function createAutomation(o: { workspaceId: string; projectId: string | null; tableId: string; name: string; spec: AutomationSpec; enabled?: boolean; userId: string | null; template?: string | null }) {
  validateSpec(o.tableId, o.spec);
  const id = uid('aut');
  q.run('INSERT INTO automations(id,workspace_id,project_id,table_id,name,enabled,spec,created_at,created_by,template) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, o.workspaceId, o.projectId, o.tableId, o.name.trim().slice(0, 120) || 'Automation', o.enabled === false ? 0 : 1, JSON.stringify(o.spec), now(), o.userId, o.template ?? null);
  return getAutomation(id)!;
}
export function updateAutomation(id: string, patch: { name?: string; enabled?: boolean; spec?: AutomationSpec }) {
  const a = getAutomation(id);
  if (!a) throw bad('Automation not found');
  if (patch.spec) validateSpec(a.table_id, patch.spec);
  q.run('UPDATE automations SET name=?, enabled=?, spec=? WHERE id=?', patch.name?.trim().slice(0, 120) || a.name, patch.enabled === undefined ? a.enabled : patch.enabled ? 1 : 0, JSON.stringify(patch.spec ?? a.spec), id);
  return getAutomation(id)!;
}
export const getAutomation = (id: string) => { const r = q.get<AutoRow>('SELECT * FROM automations WHERE id=?', id); return r ? parse(r) : undefined; };
export const deleteAutomation = (id: string) => { q.run('DELETE FROM automations WHERE id=?', id); };
export function listAutomations(workspaceId: string, projectId?: string | null) {
  const rows = projectId ? q.all<AutoRow>('SELECT * FROM automations WHERE workspace_id=? AND project_id=? ORDER BY created_at', workspaceId, projectId) : q.all<AutoRow>('SELECT * FROM automations WHERE workspace_id=? ORDER BY created_at', workspaceId);
  return rows.map(parse);
}
export function listRuns(automationId: string, limit = 50) {
  return q.all<any>('SELECT id, record_id AS recordId, status, started_at AS startedAt, finished_at AS finishedAt, log, trigger_event AS triggerEvent FROM automation_runs WHERE automation_id=? ORDER BY started_at DESC LIMIT ?', automationId, limit)
    .map((r) => ({ ...r, log: safeJson(r.log, []) }));
}

// ---------------- condition + template helpers ----------------
function valueByKey(tableId: string, data: Record<string, any>, key: string) { const f = fieldByKey(tableId, key); return f ? data[f.id] : undefined; }
const choiceName = (tableId: string, key: string, data: Record<string, any>) => {
  const f = fieldByKey(tableId, key);
  const v = f ? data[f.id] : undefined;
  return f?.options.choices?.find((c) => c.id === v)?.name ?? '';
};

export function checkCondition(c: { type: ConditionType; fieldId?: string; value?: string }, tableId: string, recordId: string, data: Record<string, any>): boolean {
  switch (c.type) {
    case 'accession_exists': { const f = c.fieldId ?? fieldByKey(tableId, 'accession')?.id; const v = f ? data[f] : undefined; return typeof v === 'string' && v.trim().length > 0; }
    case 'sequence_is_dna': { const f = fieldByKey(tableId, 'sequence'); const v = f ? data[f.id] : undefined; return typeof v === 'string' && v.length > 0 && detectSeqKind(v) === 'dna'; }
    case 'structure_unavailable': { const n = choiceName(tableId, 'structAvail', data); return n === '' || n === 'Unavailable' || n === 'Not checked'; }
    case 'processing_failed': return choiceName(tableId, 'status', data).toLowerCase() === 'failed';
    case 'field_equals': { const f = listFields(tableId).find((x) => x.id === c.fieldId); if (!f) return false; return cellText(data[f.id], f).toLowerCase() === String(c.value ?? '').toLowerCase() || String(data[f.id]) === c.value; }
    case 'field_not_empty': { const v = c.fieldId ? data[c.fieldId] : undefined; return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length); }
    case 'chemical_has_verified_target': {
      const rel = listFields(tableId).filter((f) => f.type === 'relation' && q.get<{ kind: string }>('SELECT kind FROM tables WHERE id=?', f.options.targetTable!)?.kind === 'protein');
      for (const f of rel) {
        const inv = f.options.inverseFieldId;
        const rows = q.all<{ meta: string | null }>('SELECT meta FROM links WHERE (field_id=? AND from_id=?) OR (field_id=? AND to_id=?)', f.id, recordId, inv ?? '', recordId);
        if (rows.some((r) => safeJson<any>(r.meta, null)?.evidenceClass === 'experimentally_verified')) return true;
      }
      return false;
    }
  }
}

/** Replace {{Field name}} with the record's cell text. Unknown names render empty. */
export function renderTemplate(tpl: string, tableId: string, recordId: string): string {
  const row = hydrateRows(tableId, [getRaw(recordId)!])[0];
  const fields = listFields(tableId);
  return String(tpl ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => {
    if (name === 'record.id') return recordId;
    const f = fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? cellText(row.fields[f.id], f) : '';
  });
}

// ---------------- running ----------------
type LogLine = { ts: string; level: 'info' | 'warn' | 'error'; msg: string; jobId?: string };

const JOB_FOR: Record<string, (tableKind: string) => { type: string; name: string } | null> = {
  fetch_ncbi: (k) => (k === 'gene' ? { type: 'enrich.gene', name: 'Fetch NCBI gene' } : k === 'dna' || k === 'rna' ? { type: 'fetch.nucleotide', name: 'Fetch NCBI metadata' } : null),
  search_uniprot: (k) => (k === 'gene' ? { type: 'discover.proteins', name: 'Search UniProt for gene products' } : k === 'protein' ? { type: 'enrich.protein', name: 'Fetch UniProt entry' } : null),
  fetch_alphafold: (k) => (k === 'protein' ? { type: 'discover.structures', name: 'Retrieve AlphaFold structure' } : null),
  search_pubchem: (k) => (k === 'chemical' ? { type: 'enrich.chemical', name: 'Fetch PubChem metadata' } : null),
  discover_chemicals: (k) => (k === 'protein' ? { type: 'discover.chemicals', name: 'Find associated chemicals' } : null),
  discover_genes: (k) => (k === 'dna' || k === 'rna' ? { type: 'discover.genes', name: 'Find genes in DNA' } : null),
  discover_proteins: (k) => (k === 'gene' ? { type: 'discover.proteins', name: 'Find proteins for gene' } : null),
};

interface TriggerCtx { event: string; recordId: string | null; origin?: ChangeEvent['origin']; changed?: string[]; jobType?: string }

export async function runAutomation(autoId: string, recordId: string | null, t: TriggerCtx, byUser: string | null = null): Promise<{ runId: string; status: string }> {
  const a = getAutomation(autoId);
  if (!a) throw bad('Automation not found');
  const tableKind = q.get<{ kind: string }>('SELECT kind FROM tables WHERE id=?', a.table_id)?.kind ?? 'custom';
  // duplicate prevention: one live run per (automation, record)
  const live = recordId ? q.get<{ id: string }>("SELECT id FROM automation_runs WHERE automation_id=? AND record_id=? AND status='running'", autoId, recordId) : undefined;
  const runId = uid('run');
  const log: LogLine[] = [];
  const L = (level: LogLine['level'], msg: string, jobId?: string) => log.push({ ts: now(), level, msg, jobId });
  q.run("INSERT INTO automation_runs(id,automation_id,record_id,status,started_at,log,trigger_event) VALUES (?,?,?,?,?,?,?)", runId, autoId, recordId, live ? 'skipped' : 'running', now(), '[]', t.event);
  const finish = (status: string) => {
    q.run('UPDATE automation_runs SET status=?, finished_at=?, log=? WHERE id=?', status, now(), JSON.stringify(log), runId);
    q.run('UPDATE automations SET last_run_at=?, run_count=run_count+1 WHERE id=?', now(), autoId);
    publish(a.workspace_id, 'automation.run', { automationId: autoId, runId, status });
    return { runId, status };
  };
  if (live) { L('warn', 'Skipped: a run for this record is already in progress'); return finish('skipped'); }
  const depth = t.origin?.depth ?? 0;
  try {
    const raw = recordId ? getRaw(recordId) : undefined;
    if (recordId && !raw) { L('warn', 'Record no longer exists'); return finish('skipped'); }
    if (raw) {
      for (const c of a.spec.conditions) {
        const ok = checkCondition(c, a.table_id, raw.id, raw.data);
        L('info', `Condition ${c.type}: ${ok ? 'met' : 'not met'}`);
        if (!ok) return finish('skipped');
      }
    }
    for (const act of a.spec.actions) {
      const p = act.params ?? {};
      const jobSpec = JOB_FOR[act.type]?.(tableKind);
      if (JOB_FOR[act.type]) {
        if (!jobSpec) { L('warn', `${act.type} does not apply to a ${tableKind} table; skipped`); continue; }
        if (!recordId) { L('warn', `${act.type} needs a record; skipped`); continue; }
        const id = enqueue({
          workspaceId: a.workspace_id, projectId: a.project_id, type: jobSpec.type, name: `${jobSpec.name}`, payload: { recordId, ...(act.type === 'discover_chemicals' ? { sources: p.sources, maxCompounds: p.maxCompounds } : {}) },
          userId: byUser ?? a.created_by, dedupeKey: `auto:${jobSpec.type}:${recordId}`, automationId: a.id, depth, maxAttempts: Number((a.spec as any).retry?.maxAttempts) || undefined,
        });
        L('info', `Queued job: ${jobSpec.name}`, id);
        continue;
      }
      switch (act.type) {
        case 'update_field': {
          if (!recordId) { L('warn', 'update_field needs a record'); break; }
          updateRecord(recordId, { [String(p.fieldId)]: renderTemplate(String(p.value ?? ''), a.table_id, recordId) }, { userId: byUser ?? a.created_by, createChoices: false, origin: { automationId: a.id, depth: depth + 1 } });
          L('info', 'Updated field');
          break;
        }
        case 'create_task': {
          const tt = q.get<{ id: string }>("SELECT id FROM tables WHERE workspace_id=? AND project_id IS ? AND kind='task' ORDER BY position LIMIT 1", a.workspace_id, a.project_id);
          if (!tt) { L('warn', 'This project has no Tasks table'); break; }
          const title = recordId ? renderTemplate(String(p.title ?? 'Review {{record.id}}'), a.table_id, recordId) : String(p.title ?? 'Review');
          const dupKey = recordId ? `${title}` : title;
          const nameField = fieldByKey(tt.id, 'name')!;
          const existing = findByValue(tt.id, nameField.id, dupKey);
          if (existing) { L('info', 'A task with this title already exists; not duplicated'); break; }
          const vals: Record<string, unknown> = { [nameField.id]: dupKey };
          const sf = fieldByKey(tt.id, 'status'); if (sf) vals[sf.id] = 'To do';
          const pf = fieldByKey(tt.id, 'priority'); if (pf && p.priority) vals[pf.id] = String(p.priority);
          const af = fieldByKey(tt.id, 'assignee'); const assignee = (byUser ?? a.created_by); if (af && assignee) vals[af.id] = assignee;
          const df = fieldByKey(tt.id, 'due'); if (df && Number(p.dueInDays)) vals[df.id] = new Date(Date.now() + Number(p.dueInDays) * 86400_000).toISOString().slice(0, 10);
          const rel = relationField(tt.id, a.table_id);
          if (rel && recordId) vals[rel.id] = [recordId];
          const task = createRecord(tt.id, vals, { userId: byUser ?? a.created_by, createChoices: true, origin: { automationId: a.id, depth: depth + 1 } });
          L('info', `Created task "${dupKey}"`, undefined);
          void task;
          break;
        }
        case 'create_linked': {
          if (!recordId) break;
          const kind = String(p.targetKind ?? '');
          const target = q.get<{ id: string }>('SELECT id FROM tables WHERE workspace_id=? AND project_id IS ? AND (kind=? OR id=?) LIMIT 1', a.workspace_id, a.project_id, kind, kind);
          if (!target) { L('warn', `No ${kind} table in this project`); break; }
          const vals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries((p.values as Record<string, string>) ?? {})) { const f = fieldByKey(target.id, k) ?? listFields(target.id).find((x) => x.name === k || x.id === k); if (f) vals[f.id] = renderTemplate(v, a.table_id, recordId); }
          const rel = relationField(target.id, a.table_id);
          if (rel) vals[rel.id] = [recordId];
          createRecord(target.id, vals, { userId: byUser ?? a.created_by, createChoices: true, origin: { automationId: a.id, depth: depth + 1 } });
          L('info', 'Created linked record');
          break;
        }
        case 'notify': {
          const title = recordId ? renderTemplate(String(p.title ?? 'Automation: {{record.id}}'), a.table_id, recordId) : String(p.title ?? a.name);
          const body = recordId ? renderTemplate(String(p.body ?? ''), a.table_id, recordId) : String(p.body ?? '');
          const targets = p.to === 'all' ? q.all<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id=?', a.workspace_id).map((r) => r.user_id) : [String(p.to && p.to !== 'creator' ? p.to : (byUser ?? a.created_by ?? ''))].filter(Boolean);
          for (const u of targets) notify(u, { kind: (p.kind as any) ?? 'fetch_completed', title, body, link: recordId ? `/record/${recordId}` : null, workspaceId: a.workspace_id });
          L('info', `Notified ${targets.length} user(s)`);
          break;
        }
        case 'export_results': {
          const f = await exportRecords({ workspaceId: a.workspace_id, tableId: a.table_id, recordIds: recordId ? [recordId] : undefined, format: p.format === 'json' ? 'json' : 'csv', userId: byUser ?? a.created_by });
          L('info', `Exported ${f.rows} record(s) to ${f.name}`);
          if (byUser ?? a.created_by) notify((byUser ?? a.created_by)!, { kind: 'fetch_completed', title: `Export ready: ${f.name}`, link: `/api/files/${f.id}`, workspaceId: a.workspace_id });
          break;
        }
        case 'start_analysis': {
          const id = enqueue({ workspaceId: a.workspace_id, projectId: a.project_id, type: 'analysis.run', name: `Analysis: ${p.analysisType ?? 'alignment'}`, payload: { analysisType: p.analysisType ?? 'alignment', tableId: a.table_id, recordIds: recordId ? [recordId] : undefined, params: p.params ?? {}, name: `${a.name}` }, userId: byUser ?? a.created_by, automationId: a.id, depth });
          L('info', 'Started analysis', id);
          break;
        }
      }
    }
    return finish('completed');
  } catch (e) {
    L('error', (e as Error).message);
    const uid2 = byUser ?? a.created_by;
    if (uid2) notify(uid2, { kind: 'task_failed', title: `Automation "${a.name}" failed`, body: (e as Error).message, link: `/automations`, workspaceId: a.workspace_id });
    return finish('failed');
  }
}

// ---------------- event wiring ----------------
function triggerMatches(a: ReturnType<typeof parse>, e: ChangeEvent): boolean {
  const tt = a.spec.trigger;
  if (e.type === 'created') return tt.type === 'record_created';
  if (e.type !== 'updated') return false;
  if (tt.type === 'field_changed') return !tt.fieldId || e.changed.includes(tt.fieldId);
  if (tt.type === 'status_changed') {
    const f = tt.fieldId ?? fieldByKey(e.tableId, 'status')?.id;
    if (!f || !e.changed.includes(f)) return false;
    if (!tt.value) return true;
    const ch = listFields(e.tableId).find((x) => x.id === f)?.options.choices?.find((c) => c.id === e.after?.[f]);
    return ch?.id === tt.value || ch?.name.toLowerCase() === tt.value.toLowerCase();
  }
  if (tt.type === 'file_uploaded') {
    const att = listFields(e.tableId).filter((f) => f.type === 'attachment' && e.changed.includes(f.id) && (!tt.fieldId || f.id === tt.fieldId));
    return att.some((f) => (e.after?.[f.id]?.length ?? 0) > (e.before?.[f.id]?.length ?? 0));
  }
  return false;
}

let started = false;
export function startAutomations() {
  if (started) return;
  started = true;
  onRecordChange((e) => {
    if (e.type === 'deleted') return;
    if ((e.origin?.depth ?? 0) >= MAX_CHAIN_DEPTH) return;
    const autos = q.all<AutoRow>('SELECT * FROM automations WHERE table_id=? AND enabled=1', e.tableId).map(parse);
    for (const a of autos) {
      if (e.origin?.automationId === a.id) continue; // an automation never re-triggers itself
      if (!triggerMatches(a, e)) continue;
      setImmediate(() => { void runAutomation(a.id, e.recordId, { event: `${a.spec.trigger.type}`, recordId: e.recordId, origin: e.origin, changed: e.changed }, e.userId).catch((err) => console.error('[automation]', err)); });
    }
  });
  onJobFinished((job, payload) => {
    if (job.status !== 'completed') return;
    const isAnalysis = job.type === 'analysis.run';
    const isFetch = /^(fetch|discover|enrich|import|pipeline)\./.test(job.type);
    if (!isAnalysis && !isFetch) return;
    const rid: string | undefined = isAnalysis ? (job.result as any)?.resultRecordId : payload?.recordId;
    if (!rid) return;
    const raw = getRaw(rid);
    if (!raw) return;
    const autos = q.all<AutoRow>('SELECT * FROM automations WHERE table_id=? AND enabled=1', raw.tableId).map(parse)
      .filter((a) => a.spec.trigger.type === (isAnalysis ? 'analysis_completed' : 'fetch_completed') && (!a.spec.trigger.value || a.spec.trigger.value === job.type));
    for (const a of autos) {
      if (job.automationId === a.id) continue;
      setImmediate(() => { void runAutomation(a.id, rid, { event: a.spec.trigger.type, recordId: rid, origin: { depth: job.depth, automationId: job.automationId ?? undefined }, jobType: job.type }, job.createdBy).catch((err) => console.error('[automation]', err)); });
    }
  });
  schedTimer = setInterval(schedulerTick, 60_000);
  schedTimer.unref();
}

let schedTimer: NodeJS.Timeout | null = null;
export function stopAutomations() { if (schedTimer) clearInterval(schedTimer); started = false; }

/** Run due scheduled automations against each matching record (capped), and send deadline reminders. */
export function schedulerTick() {
  const t = Date.now();
  for (const a of q.all<AutoRow>("SELECT * FROM automations WHERE enabled=1 AND spec LIKE '%\"schedule\"%'").map(parse)) {
    if (a.spec.trigger.type !== 'schedule') continue;
    const last = a.last_run_at ? Date.parse(a.last_run_at) : 0;
    let due = false;
    if (a.spec.trigger.everyMinutes) due = t - last >= a.spec.trigger.everyMinutes * 60_000;
    else if (a.spec.trigger.at) {
      const [hh, mm] = a.spec.trigger.at.split(':').map(Number);
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      due = t >= d.getTime() && last < d.getTime();
    }
    if (!due) continue;
    q.run('UPDATE automations SET last_run_at=? WHERE id=?', now(), a.id); // claim first so a slow run is not repeated
    const ids = q.all<{ id: string }>('SELECT id FROM records WHERE table_id=? ORDER BY rowid LIMIT 200', a.table_id).map((r) => r.id);
    if (!ids.length) continue;
    void (async () => { for (const id of ids) await runAutomation(a.id, id, { event: 'schedule', recordId: id }, null).catch((e) => console.error('[automation]', e)); })();
  }
  deadlineReminders();
}

export function deadlineReminders() {
  for (const tt of q.all<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM tables WHERE kind='task'")) {
    const due = fieldByKey(tt.id, 'due'), asg = fieldByKey(tt.id, 'assignee'), st = fieldByKey(tt.id, 'status'), nm = fieldByKey(tt.id, 'name');
    if (!due || !asg || !nm) continue;
    const soon = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
    const today = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    for (const r of q.all<{ id: string; data: string }>(`SELECT id, data FROM records WHERE table_id=? AND json_extract(data, ?) BETWEEN ? AND ?`, tt.id, `$."${due.id}"`, today, soon)) {
      const d = safeJson<Record<string, any>>(r.data, {});
      const done = st && st.options.choices?.find((c) => c.id === d[st.id])?.name === 'Done';
      if (done || !d[asg.id]) continue;
      notify(d[asg.id], { kind: 'deadline', title: `Due ${d[due.id]}: ${d[nm.id] ?? 'task'}`, body: 'This task is due within the next day.', link: `/record/${r.id}`, workspaceId: tt.workspace_id, dedupe: 'deadline' });
    }
  }
}

// ---------------- template catalog (FR-1.21) ----------------
interface TplSpec { id: string; name: string; description: string; kinds: TableKind[]; build: (tableId: string) => AutomationSpec }
export const AUTOMATION_TEMPLATES: TplSpec[] = [
  { id: 'dna-fetch-ncbi', name: 'New DNA record → Fetch NCBI metadata', description: 'When a DNA record with an accession is created, retrieve its sequence, organism, class and annotation from NCBI.', kinds: ['dna'],
    build: () => ({ trigger: { type: 'record_created' }, conditions: [{ type: 'accession_exists' }], actions: [{ type: 'fetch_ncbi', params: {} }] }) },
  { id: 'dna-discover-genes', name: 'DNA metadata fetched → Find genes', description: 'After NCBI metadata is retrieved, identify the annotated genes (or the best sequence-similarity match).', kinds: ['dna'],
    build: () => ({ trigger: { type: 'fetch_completed', value: 'fetch.nucleotide' }, conditions: [], actions: [{ type: 'discover_genes', params: {} }] }) },
  { id: 'protein-alphafold', name: 'New protein → Search AlphaFold', description: 'Look up the pre-calculated AlphaFold model and experimental PDB structures for each new protein with a UniProt accession.', kinds: ['protein'],
    build: () => ({ trigger: { type: 'record_created' }, conditions: [{ type: 'accession_exists' }], actions: [{ type: 'fetch_alphafold', params: {} }] }) },
  { id: 'protein-chemicals', name: 'New protein → Search associated chemicals', description: 'Query ChEMBL, BindingDB and the PDB for compounds with documented relationships to the new protein.', kinds: ['protein'],
    build: () => ({ trigger: { type: 'record_created' }, conditions: [{ type: 'accession_exists' }], actions: [{ type: 'discover_chemicals', params: { maxCompounds: 20 } }] }) },
  { id: 'chemical-pubchem', name: 'New chemical → Retrieve PubChem metadata', description: 'Fill CID, formula, weight, SMILES, InChI and bioactivity summary from PubChem.', kinds: ['chemical'],
    build: () => ({ trigger: { type: 'record_created' }, conditions: [], actions: [{ type: 'search_pubchem', params: {} }] }) },
  { id: 'analysis-notify', name: 'Analysis completed → Notify researcher', description: 'Send a notification when an analysis result is saved.', kinds: ['analysis'],
    build: () => ({ trigger: { type: 'analysis_completed' }, conditions: [], actions: [{ type: 'notify', params: { title: 'Analysis ready: {{Name}}', body: '{{Summary}}', kind: 'analysis_completed', to: 'creator' } }] }) },
  { id: 'failed-fetch-task', name: 'Failed fetch → Create review task', description: 'When a record\'s status becomes Failed, open a task so someone reviews it.', kinds: ['dna', 'gene', 'protein', 'chemical', 'structure'],
    build: () => ({ trigger: { type: 'status_changed', value: 'Failed' }, conditions: [], actions: [{ type: 'create_task', params: { title: 'Review failed fetch: {{record.id}}', priority: 'High', dueInDays: 2 } }] }) },
];

export function installAutomationTemplates(workspaceId: string, projectId: string | null, tableIdsByDef: Record<string, string>, templateIds: string[], o: { enabled: boolean; userId: string | null }) {
  const created: string[] = [];
  const kindToTable = new Map<string, string>();
  for (const id of Object.values(tableIdsByDef)) { const k = q.get<{ kind: string }>('SELECT kind FROM tables WHERE id=?', id)?.kind; if (k && !kindToTable.has(k)) kindToTable.set(k, id); }
  for (const tid of templateIds) {
    const tpl = AUTOMATION_TEMPLATES.find((x) => x.id === tid);
    if (!tpl) continue;
    for (const kind of tpl.kinds) {
      const table = kindToTable.get(kind);
      if (!table) continue;
      created.push(createAutomation({ workspaceId, projectId, tableId: table, name: tpl.name, spec: tpl.build(table), enabled: o.enabled, userId: o.userId, template: tpl.id }).id);
    }
  }
  return created;
}

/** Instantiate one catalog template for a specific table (from the UI). */
export function installTemplateForTable(templateId: string, tableId: string, userId: string | null) {
  const tpl = AUTOMATION_TEMPLATES.find((x) => x.id === templateId);
  if (!tpl) throw bad('Unknown automation template');
  const t = q.get<{ workspace_id: string; project_id: string | null; kind: string }>('SELECT workspace_id, project_id, kind FROM tables WHERE id=?', tableId)!;
  if (!tpl.kinds.includes(t.kind as TableKind)) throw bad(`This template is for ${tpl.kinds.join(' / ')} tables`);
  return createAutomation({ workspaceId: t.workspace_id, projectId: t.project_id, tableId, name: tpl.name, spec: tpl.build(tableId), enabled: true, userId, template: tpl.id });
}
export type { FieldType };
