import { route, str, oneOf, int } from '../http.ts';
import { q, tx } from '../db.ts';
import { bad, forbidden, notFound, now, safeJson, uid } from '../util.ts';
import { atLeast, projectLevel, requireProject, requireTable, requireWorkspace, tableLevel, workspaceLevel, wsRole } from '../access.ts';
import type { TableRow } from '../access.ts';
import { auditCtx } from '../audit.ts';
import { createField, createTable, createView, deleteField, deleteTable, deleteView, getField, getView, listFields, listTables, listViews, reorderFields, updateField, updateView } from '../schema.ts';
import { TEMPLATES, applyTemplate, createProject, ensureProjectTable } from '../templates.ts';
import type { FieldType, ViewType } from '../../shared/types.ts';
import { publish } from '../events.ts';
import { Hydrator, toRaw } from '../records.ts';
import { workspacesFor } from './app.ts';
import { listJobs } from '../jobs.ts';
import { seedWorkspace } from '../templates.ts';

// ---------------- workspaces & members ----------------
route('POST', '/api/workspaces', (c) => {
  const name = str(c.body.name, 'Name', { max: 100 });
  const id = uid('wsp');
  tx(() => {
    q.run('INSERT INTO workspaces(id,name,created_at,created_by) VALUES (?,?,?,?)', id, name, now(), c.user!.id);
    q.run("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'owner')", id, c.user!.id);
    seedWorkspace(id, c.user!.id);
  });
  auditCtx(c, id, 'workspace.create', 'workspace', id);
  return { workspaces: workspacesFor(c.user!.id), id };
});

route('PATCH', '/api/workspaces/:id', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'admin');
  q.run('UPDATE workspaces SET name=? WHERE id=?', str(c.body.name, 'Name', { max: 100 }), c.params.id);
  auditCtx(c, c.params.id, 'workspace.rename', 'workspace', c.params.id);
  return { workspaces: workspacesFor(c.user!.id) };
});

route('GET', '/api/workspaces/:id/members', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  return { members: q.all<any>('SELECT u.id, u.name, u.email, m.role FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name', c.params.id) };
});

// ---------------- projects ----------------
const projectJson = (p: any, level: string) => ({ id: p.id, workspaceId: p.workspace_id, name: p.name, description: p.description, status: p.status, visibility: p.visibility, deadline: p.deadline, color: p.color, createdAt: p.created_at, level });

route('GET', '/api/workspaces/:id/projects', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  const rows = q.all<any>('SELECT * FROM projects WHERE workspace_id=? ORDER BY created_at', c.params.id);
  return { projects: rows.map((p) => ({ p, lvl: projectLevel(c.user!.id, p.id) })).filter((x) => x.lvl !== 'none').map((x) => projectJson(x.p, x.lvl)) };
});

route('POST', '/api/workspaces/:id/projects', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'editor');
  const r = createProject(c.params.id, c.user!.id, {
    name: str(c.body.name, 'Project name', { max: 120 }), description: str(c.body.description, 'Description', { max: 2000, optional: true }), template: c.body.template ?? 'discovery',
    visibility: c.body.visibility === 'private' ? 'private' : 'workspace', deadline: c.body.deadline || null, automations: c.body.automations !== false,
  });
  auditCtx(c, c.params.id, 'project.create', 'project', r.id, { template: c.body.template });
  publish(c.params.id, 'schema.changed', { projectId: r.id });
  return { id: r.id };
});

route('PATCH', '/api/projects/:id', (c) => {
  const p = requireProject(c.user!.id, c.params.id, 'admin');
  const cur = q.get<any>('SELECT * FROM projects WHERE id=?', p.id)!;
  q.run('UPDATE projects SET name=?, description=?, status=?, deadline=?, visibility=?, color=? WHERE id=?',
    c.body.name !== undefined ? str(c.body.name, 'Name', { max: 120 }) : cur.name, c.body.description !== undefined ? str(c.body.description, 'Description', { max: 2000, optional: true }) : cur.description,
    c.body.status !== undefined ? oneOf(c.body.status, ['active', 'paused', 'completed', 'archived'] as const, 'Status') : cur.status, c.body.deadline !== undefined ? c.body.deadline || null : cur.deadline,
    c.body.visibility !== undefined ? oneOf(c.body.visibility, ['workspace', 'private'] as const, 'Visibility') : cur.visibility, c.body.color !== undefined ? String(c.body.color).slice(0, 20) : cur.color, p.id);
  auditCtx(c, p.workspace_id, 'project.update', 'project', p.id);
  publish(p.workspace_id, 'schema.changed', { projectId: p.id });
  return { ok: true };
});

route('DELETE', '/api/projects/:id', (c) => {
  const p = requireProject(c.user!.id, c.params.id, 'admin');
  q.run('DELETE FROM projects WHERE id=?', p.id);
  auditCtx(c, p.workspace_id, 'project.delete', 'project', p.id, { name: p.name });
  publish(p.workspace_id, 'schema.changed', { projectId: p.id });
  return { ok: true };
});

route('GET', '/api/projects/:id/members', (c) => {
  requireProject(c.user!.id, c.params.id);
  return { members: q.all<any>('SELECT u.id, u.name, u.email, pm.role FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=?', c.params.id) };
});
// dashboard: SQL aggregations only, cached 20 s per project (FR-1.18: no heavy frontend maths)
const dashCache = new Map<string, { at: number; data: unknown }>();
route('GET', '/api/projects/:id/dashboard', (c) => {
  const p = requireProject(c.user!.id, c.params.id);
  const hit = dashCache.get(p.id);
  if (hit && Date.now() - hit.at < 20_000 && c.query.get('fresh') !== '1') return hit.data;
  const tables = q.all<TableRow>('SELECT * FROM tables WHERE project_id=?', p.id);
  const recordsByKind: Record<string, number> = {};
  let total = 0;
  const statusTotals: Record<string, number> = {};
  for (const t of tables) {
    const n = q.get<{ n: number }>('SELECT COUNT(*) n FROM records WHERE table_id=?', t.id)!.n;
    recordsByKind[t.kind] = (recordsByKind[t.kind] ?? 0) + n;
    total += n;
    const sf = listFields(t.id).find((f) => f.key === 'status');
    if (sf && t.kind !== 'task') {
      for (const r of q.all<{ s: string | null; n: number }>(`SELECT json_extract(data, ?) s, COUNT(*) n FROM records WHERE table_id=? GROUP BY s`, `$."${sf.id}"`, t.id)) {
        const name = sf.options.choices?.find((c2) => c2.id === r.s)?.name ?? 'No status';
        statusTotals[name] = (statusTotals[name] ?? 0) + r.n;
      }
    }
  }
  // tasks
  const task = tables.find((t) => t.kind === 'task');
  let tasks = { total: 0, done: 0, pending: 0, overdue: 0, byStatus: {} as Record<string, number> };
  let deadlines: { id: string; title: string; due: string; status: string }[] = [];
  if (task) {
    const fs = listFields(task.id);
    const st = fs.find((f) => f.key === 'status'), due = fs.find((f) => f.key === 'due'), nm = fs[0];
    const rows = q.all<{ id: string; data: string }>('SELECT id, data FROM records WHERE table_id=?', task.id).map((r) => ({ id: r.id, d: safeJson<Record<string, any>>(r.data, {}) }));
    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      const sname = st?.options.choices?.find((c2) => c2.id === r.d[st.id])?.name ?? 'No status';
      tasks.byStatus[sname] = (tasks.byStatus[sname] ?? 0) + 1;
      tasks.total++;
      if (sname === 'Done') tasks.done++; else { tasks.pending++; if (due && r.d[due.id] && r.d[due.id] < today) tasks.overdue++; }
    }
    if (due) deadlines = rows.filter((r) => r.d[due.id] && st?.options.choices?.find((c2) => c2.id === r.d[st.id])?.name !== 'Done').sort((a, b) => String(a.d[due.id]).localeCompare(String(b.d[due.id]))).slice(0, 8)
      .map((r) => ({ id: r.id, title: String(r.d[nm.id] ?? ''), due: r.d[due.id], status: st?.options.choices?.find((c2) => c2.id === r.d[st.id])?.name ?? '' }));
  }
  const jobs = q.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM jobs WHERE project_id=? GROUP BY status', p.id);
  const jobCount = Object.fromEntries(jobs.map((j) => [j.status, j.n]));
  // recent activity: latest edited records + finished jobs
  const h = new Hydrator();
  const recent: { at: string; kind: string; text: string; link: string }[] = [];
  for (const t of tables) {
    for (const r of q.all<any>('SELECT * FROM records WHERE table_id=? ORDER BY updated_at DESC LIMIT 6', t.id)) {
      const raw = toRaw(r);
      recent.push({ at: raw.updatedAt, kind: raw.updatedAt === raw.createdAt ? 'created' : 'updated', text: `${t.name}: ${h.display(raw)}`, link: `/record/${raw.id}` });
    }
  }
  for (const j of listJobs(p.workspace_id, { projectId: p.id, limit: 8 })) if (j.finishedAt) recent.push({ at: j.finishedAt, kind: j.status, text: j.name, link: `/jobs/${j.id}` });
  recent.sort((a, b) => b.at.localeCompare(a.at));
  const meta = q.get<any>('SELECT deadline FROM projects WHERE id=?', p.id)!;
  const wfTotal = Object.values(statusTotals).reduce((a, b) => a + b, 0);
  const data = {
    projectId: p.id, recordCount: total, recordsByKind, tasks, deadlines, failedJobs: jobCount.failed ?? 0, runningJobs: (jobCount.running ?? 0) + (jobCount.queued ?? 0), jobCount, statusTotals,
    progress: { tasksPct: tasks.total ? Math.round((tasks.done / tasks.total) * 100) : null, recordsPct: wfTotal ? Math.round(((statusTotals.Completed ?? 0) / wfTotal) * 100) : null },
    projectDeadline: meta.deadline, recent: recent.slice(0, 12), generatedAt: now(),
  };
  dashCache.set(p.id, { at: Date.now(), data });
  return data;
});

// ---------------- templates ----------------
route('GET', '/api/templates', () => ({ templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, tables: t.tables })) }));

route('POST', '/api/projects/:id/templates/:tid', (c) => {
  const p = requireProject(c.user!.id, c.params.id, 'editor');
  const ids = applyTemplate(p.workspace_id, p.id, c.params.tid, { automations: c.body.automations !== false, userId: c.user!.id });
  auditCtx(c, p.workspace_id, 'template.apply', 'project', p.id, { template: c.params.tid });
  return { tableIds: ids };
});

route('POST', '/api/projects/:id/tables/:kind', (c) => {
  const p = requireProject(c.user!.id, c.params.id, 'editor');
  const kind = oneOf(c.params.kind, ['dna', 'gene', 'protein', 'chemical', 'structure', 'organism', 'publication', 'experiment', 'analysis', 'task'] as const, 'Table kind');
  if (q.get('SELECT 1 FROM tables WHERE project_id=? AND kind=?', p.id, kind)) throw bad('This project already has that table');
  const id = ensureProjectTable(p.workspace_id, p.id, kind);
  auditCtx(c, p.workspace_id, 'table.create', 'table', id, { kind });
  return { tableId: id };
});

// ---------------- tables ----------------
route('GET', '/api/workspaces/:id/tables', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  const project = c.query.get('project');
  const all = listTables(c.params.id, project || undefined);
  const rows = q.all<TableRow>('SELECT * FROM tables WHERE workspace_id=?', c.params.id);
  const ok = new Set(rows.filter((t) => tableLevel(c.user!.id, t) !== 'none').map((t) => t.id));
  return { tables: all.filter((t) => ok.has(t.id)) };
});

route('POST', '/api/projects/:id/tables', (c) => {
  const p = requireProject(c.user!.id, c.params.id, 'editor');
  const t = createTable({ workspaceId: p.workspace_id, projectId: p.id, name: str(c.body.name, 'Table name', { max: 100 }), kind: 'custom', description: str(c.body.description, 'Description', { max: 500, optional: true }) });
  auditCtx(c, p.workspace_id, 'table.create', 'table', t.id);
  return { table: t };
});

route('GET', '/api/tables/:id', (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  const lvl = tableLevel(c.user!.id, t);
  return {
    table: { id: t.id, workspaceId: t.workspace_id, projectId: t.project_id, name: t.name, kind: t.kind, description: t.description, icon: t.icon, level: lvl },
    fields: listFields(t.id), views: listViews(t.id),
    // names of linked tables, for the field editor / relation pickers
    linkedTables: q.all<any>('SELECT id, name, kind FROM tables WHERE workspace_id=? AND (project_id IS ? OR project_id IS NULL)', t.workspace_id, t.project_id),
  };
});

route('PATCH', '/api/tables/:id', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'admin');
  q.run('UPDATE tables SET name=?, description=? WHERE id=?', c.body.name !== undefined ? str(c.body.name, 'Name', { max: 100 }) : t.name, c.body.description !== undefined ? str(c.body.description, 'Description', { max: 500, optional: true }) : t.description, t.id);
  publish(t.workspace_id, 'schema.changed', { tableId: t.id });
  auditCtx(c, t.workspace_id, 'table.update', 'table', t.id);
  return { ok: true };
});

route('DELETE', '/api/tables/:id', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'admin');
  deleteTable(t.id);
  auditCtx(c, t.workspace_id, 'table.delete', 'table', t.id, { name: t.name });
  return { ok: true };
});

// ---------------- fields ----------------
route('POST', '/api/tables/:id/fields', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'admin');
  const f = createField(t.id, { name: str(c.body.name, 'Field name', { max: 100 }), type: c.body.type as FieldType, options: c.body.options ?? {} });
  auditCtx(c, t.workspace_id, 'field.create', 'field', f.id, { type: f.type });
  return { field: f, fields: listFields(t.id) };
});
route('PATCH', '/api/fields/:id', (c) => {
  const f = getField(c.params.id);
  const t = requireTable(c.user!.id, f.tableId, 'admin');
  const r = updateField(f.id, { name: c.body.name, options: c.body.options, type: c.body.type });
  auditCtx(c, t.workspace_id, 'field.update', 'field', f.id);
  return { ...r, fields: listFields(t.id) };
});
route('DELETE', '/api/fields/:id', (c) => {
  const f = getField(c.params.id);
  const t = requireTable(c.user!.id, f.tableId, 'admin');
  deleteField(f.id);
  auditCtx(c, t.workspace_id, 'field.delete', 'field', f.id, { name: f.name });
  return { fields: listFields(t.id) };
});
route('PUT', '/api/tables/:id/fields/order', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'admin');
  if (!Array.isArray(c.body.order)) throw bad('order must be a list of field ids');
  reorderFields(t.id, c.body.order.map(String));
  return { fields: listFields(t.id) };
});

// ---------------- views ----------------
route('POST', '/api/tables/:id/views', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'editor');
  const v = createView(t.id, { name: str(c.body.name, 'View name', { max: 100, optional: true }) || String(c.body.type), type: oneOf(c.body.type, ['grid', 'kanban', 'gallery', 'list', 'calendar', 'graph'] as ViewType[], 'View type'), config: c.body.config });
  publish(t.workspace_id, 'view.changed', { tableId: t.id });
  return { view: v };
});
route('PATCH', '/api/views/:id', (c) => {
  const v = getView(c.params.id);
  requireTable(c.user!.id, v.tableId, 'editor');
  return { view: updateView(v.id, { name: c.body.name, config: c.body.config, position: c.body.position }) };
});
route('DELETE', '/api/views/:id', (c) => {
  const v = getView(c.params.id);
  requireTable(c.user!.id, v.tableId, 'editor');
  deleteView(v.id);
  return { views: listViews(v.tableId) };
});

void int; void workspaceLevel; void atLeast;
