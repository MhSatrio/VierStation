import { route, str, int, oneOf } from '../http.ts';
import { q } from '../db.ts';
import { bad, encrypt, mask, notFound, now, decrypt, safeJson } from '../util.ts';
import { requireProject, requireTable, requireWorkspace, workspaceLevel } from '../access.ts';
import { auditCtx } from '../audit.ts';
import { subscribe } from '../events.ts';
import { cancelJob, getJob, jobCounts, jobLogs, listJobs, retryJob } from '../jobs.ts';
import { AUTOMATION_TEMPLATES, createAutomation, deleteAutomation, getAutomation, installTemplateForTable, listAutomations, listRuns, runAutomation, updateAutomation } from '../automations.ts';
import type { AutomationSpec } from '../../shared/types.ts';
import { NOTIFY_KINDS } from '../notify.ts';
import { fieldByKey, listFields } from '../schema.ts';
import { config } from '../config.ts';

// ---------------- server-sent events ----------------
route('GET', '/api/events', (c) => { subscribe(c.res, c.user!.id); return undefined; });

// ---------------- jobs ----------------
route('GET', '/api/workspaces/:id/jobs', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  const project = c.query.get('project');
  return { jobs: listJobs(c.params.id, { projectId: project, status: c.query.get('status') ?? undefined, limit: int(c.query.get('limit'), 'limit', 100, 1, 500) }), counts: jobCounts(c.params.id, project) };
});
route('GET', '/api/jobs/:id', (c) => {
  const j = getJob(c.params.id);
  if (!j) throw notFound('Job not found');
  requireWorkspace(c.user!.id, j.workspaceId);
  return { job: j, logs: jobLogs(j.id) };
});
route('POST', '/api/jobs/:id/cancel', (c) => {
  const j = getJob(c.params.id);
  if (!j) throw notFound('Job not found');
  requireWorkspace(c.user!.id, j.workspaceId, 'editor');
  const ok = cancelJob(j.id);
  auditCtx(c, j.workspaceId, 'job.cancel', 'job', j.id);
  return { ok };
});
route('POST', '/api/jobs/:id/retry', (c) => {
  const j = getJob(c.params.id);
  if (!j) throw notFound('Job not found');
  requireWorkspace(c.user!.id, j.workspaceId, 'editor');
  const id = retryJob(j.id, c.user!.id);
  if (!id) throw bad('Only finished jobs can be re-run');
  auditCtx(c, j.workspaceId, 'job.retry', 'job', id);
  return { jobId: id };
});

// ---------------- notifications ----------------
route('GET', '/api/notifications', (c) => {
  const unreadOnly = c.query.get('unread') === '1';
  const rows = q.all<any>(`SELECT id, kind, title, body, link, read, created_at AS createdAt FROM notifications WHERE user_id=? ${unreadOnly ? 'AND read=0' : ''} ORDER BY created_at DESC LIMIT 100`, c.user!.id);
  const unread = q.get<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', c.user!.id)!.n;
  return { notifications: rows.map((r) => ({ ...r, read: !!r.read })), unread, kinds: NOTIFY_KINDS };
});
route('POST', '/api/notifications/read', (c) => {
  if (Array.isArray(c.body.ids) && c.body.ids.length) for (const id of c.body.ids.slice(0, 200)) q.run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', String(id), c.user!.id);
  else q.run('UPDATE notifications SET read=1 WHERE user_id=?', c.user!.id);
  return { ok: true };
});
route('DELETE', '/api/notifications', (c) => { q.run('DELETE FROM notifications WHERE user_id=? AND read=1', c.user!.id); return { ok: true }; });

// ---------------- automations ----------------
route('GET', '/api/automation-templates', () => ({ templates: AUTOMATION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, kinds: t.kinds })) }));

route('GET', '/api/workspaces/:id/automations', (c) => {
  requireWorkspace(c.user!.id, c.params.id);
  const project = c.query.get('project');
  const autos = listAutomations(c.params.id, project);
  const visible = autos.filter((a) => { try { requireTable(c.user!.id, a.table_id); return true; } catch { return false; } });
  return {
    automations: visible.map((a) => ({ id: a.id, name: a.name, enabled: !!a.enabled, tableId: a.table_id, projectId: a.project_id, spec: a.spec, lastRunAt: a.last_run_at, runCount: a.run_count, template: a.template,
      tableName: q.get<{ name: string }>('SELECT name FROM tables WHERE id=?', a.table_id)?.name })),
  };
});

route('POST', '/api/tables/:id/automations', (c) => {
  const t = requireTable(c.user!.id, c.params.id, 'admin');
  const a = c.body.template
    ? installTemplateForTable(String(c.body.template), t.id, c.user!.id)
    : createAutomation({ workspaceId: t.workspace_id, projectId: t.project_id, tableId: t.id, name: str(c.body.name, 'Name', { max: 120 }), spec: c.body.spec as AutomationSpec, enabled: c.body.enabled !== false, userId: c.user!.id });
  auditCtx(c, t.workspace_id, 'automation.create', 'automation', a.id);
  return { id: a.id };
});

route('PATCH', '/api/automations/:id', (c) => {
  const a = getAutomation(c.params.id);
  if (!a) throw notFound('Automation not found');
  requireTable(c.user!.id, a.table_id, 'admin');
  updateAutomation(a.id, { name: c.body.name, enabled: c.body.enabled, spec: c.body.spec });
  auditCtx(c, a.workspace_id, 'automation.update', 'automation', a.id, { enabled: c.body.enabled });
  return { ok: true };
});
route('DELETE', '/api/automations/:id', (c) => {
  const a = getAutomation(c.params.id);
  if (!a) throw notFound('Automation not found');
  requireTable(c.user!.id, a.table_id, 'admin');
  deleteAutomation(a.id);
  auditCtx(c, a.workspace_id, 'automation.delete', 'automation', a.id);
  return { ok: true };
});
route('GET', '/api/automations/:id/runs', (c) => {
  const a = getAutomation(c.params.id);
  if (!a) throw notFound('Automation not found');
  requireTable(c.user!.id, a.table_id);
  return { runs: listRuns(a.id) };
});
// manual rerun: for one record, or (scheduled/no record) for up to 50 records of the table
route('POST', '/api/automations/:id/run', async (c) => {
  const a = getAutomation(c.params.id);
  if (!a) throw notFound('Automation not found');
  requireTable(c.user!.id, a.table_id, 'editor');
  const ids: string[] = c.body.recordId ? [String(c.body.recordId)] : q.all<{ id: string }>('SELECT id FROM records WHERE table_id=? ORDER BY rowid LIMIT 50', a.table_id).map((r) => r.id);
  const results = [];
  for (const id of ids) results.push(await runAutomation(a.id, id, { event: 'manual', recordId: id }, c.user!.id));
  auditCtx(c, a.workspace_id, 'automation.run', 'automation', a.id, { records: ids.length });
  return { runs: results };
});

// helper for the builder UI: what can this table's automations reference?
route('GET', '/api/tables/:id/automation-options', (c) => {
  const t = requireTable(c.user!.id, c.params.id);
  return { kind: t.kind, fields: listFields(t.id).map((f) => ({ id: f.id, name: f.name, type: f.type, choices: f.options.choices })), statusField: fieldByKey(t.id, 'status')?.id ?? null };
});

// ---------------- secrets (API keys never leave the server) ----------------
const SECRET_NAMES = ['ncbi_api_key'] as const;
route('GET', '/api/workspaces/:id/secrets', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'admin');
  const rows = q.all<{ name: string; enc: string; created_at: string }>('SELECT name, enc, created_at FROM secrets WHERE workspace_id=?', c.params.id);
  return {
    secrets: SECRET_NAMES.map((n) => { const r = rows.find((x) => x.name === n); let masked = ''; if (r) { try { masked = mask(decrypt(r.enc)); } catch { masked = '(unreadable)'; } } return { name: n, set: !!r, masked, createdAt: r?.created_at ?? null }; }),
    server: { ncbi: !!config.ncbiApiKey },
  };
});
route('PUT', '/api/workspaces/:id/secrets/:name', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'admin');
  const name = oneOf(c.params.name, SECRET_NAMES, 'Secret');
  const value = str(c.body.value, 'Value', { max: 300, min: 8 });
  q.run('INSERT INTO secrets(workspace_id,name,enc,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET enc=excluded.enc, created_at=excluded.created_at', c.params.id, name, encrypt(value), now());
  auditCtx(c, c.params.id, 'secret.set', 'secret', name); // the value is never logged
  return { ok: true };
});
route('DELETE', '/api/workspaces/:id/secrets/:name', (c) => {
  requireWorkspace(c.user!.id, c.params.id, 'admin');
  q.run('DELETE FROM secrets WHERE workspace_id=? AND name=?', c.params.id, oneOf(c.params.name, SECRET_NAMES, 'Secret'));
  auditCtx(c, c.params.id, 'secret.delete', 'secret', c.params.name);
  return { ok: true };
});
// ---------------- audit log ----------------
route('GET', '/api/workspaces/:id/audit', (c) => {
  if (workspaceLevel(c.user!.id, c.params.id) !== 'admin') throw bad('Only workspace owners and admins can read the audit log');
  const rows = q.all<any>(`SELECT a.id, a.ts, a.action, a.target_type AS targetType, a.target_id AS targetId, a.detail, a.ip, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT ?`, c.params.id, int(c.query.get('limit'), 'limit', 100, 1, 500));
  return { entries: rows.map((r) => ({ ...r, detail: safeJson(r.detail, null) })) };
});

void requireProject;
