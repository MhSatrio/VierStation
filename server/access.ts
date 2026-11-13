// Workspace + project permission model.
//   workspace role: owner > admin > editor > viewer
//   project.visibility 'workspace': every workspace member gets their workspace role on the project
//   project.visibility 'private'  : only project_members (and workspace owners/admins) have access
//   project_members can raise or lower access per project (editor | viewer)
import { q } from './db.ts';
import { forbidden, notFound } from './util.ts';

export type Level = 'none' | 'viewer' | 'editor' | 'admin';
const RANK: Record<Level, number> = { none: 0, viewer: 1, editor: 2, admin: 3 };
export const atLeast = (have: Level, need: Level) => RANK[have] >= RANK[need];

export function wsRole(userId: string, workspaceId: string): string | null {
  return q.get<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?', workspaceId, userId)?.role ?? null;
}
const roleLevel = (r: string | null): Level => (r === 'owner' || r === 'admin' ? 'admin' : r === 'editor' ? 'editor' : r === 'viewer' ? 'viewer' : 'none');

export function workspaceLevel(userId: string, workspaceId: string): Level {
  return roleLevel(wsRole(userId, workspaceId));
}

export function projectLevel(userId: string, projectId: string): Level {
  const p = q.get<{ workspace_id: string; visibility: string }>('SELECT workspace_id, visibility FROM projects WHERE id=?', projectId);
  if (!p) return 'none';
  const w = workspaceLevel(userId, p.workspace_id);
  if (w === 'none') return 'none';
  if (w === 'admin') return 'admin';
  const pm = q.get<{ role: string }>('SELECT role FROM project_members WHERE project_id=? AND user_id=?', projectId, userId);
  if (pm) return pm.role === 'editor' ? (w === 'viewer' ? 'viewer' : 'editor') : 'viewer';
  return p.visibility === 'private' ? 'none' : w;
}

export interface TableRow { id: string; workspace_id: string; project_id: string | null; name: string; kind: string; description: string; icon: string | null; position: number; created_at: string }

export function tableLevel(userId: string, t: TableRow): Level {
  return t.project_id ? projectLevel(userId, t.project_id) : workspaceLevel(userId, t.workspace_id);
}

export function getTable(id: string): TableRow {
  const t = q.get<TableRow>('SELECT * FROM tables WHERE id=?', id);
  if (!t) throw notFound('Table not found');
  return t;
}

/** Load a table and verify the caller's permission. Unknown/forbidden both look like 404 to avoid leaking existence. */
export function requireTable(userId: string, tableId: string, need: Level = 'viewer'): TableRow {
  const t = getTable(tableId);
  const lvl = tableLevel(userId, t);
  if (lvl === 'none') throw notFound('Table not found');
  if (!atLeast(lvl, need)) throw forbidden();
  return t;
}

export function requireProject(userId: string, projectId: string, need: Level = 'viewer') {
  const p = q.get<{ id: string; workspace_id: string; name: string }>('SELECT id, workspace_id, name FROM projects WHERE id=?', projectId);
  if (!p) throw notFound('Project not found');
  const lvl = projectLevel(userId, projectId);
  if (lvl === 'none') throw notFound('Project not found');
  if (!atLeast(lvl, need)) throw forbidden();
  return p;
}

export function requireWorkspace(userId: string, workspaceId: string, need: Level = 'viewer') {
  const lvl = workspaceLevel(userId, workspaceId);
  if (lvl === 'none') throw notFound('Workspace not found');
  if (!atLeast(lvl, need)) throw forbidden();
  return lvl;
}

export function requireRecord(userId: string, recordId: string, need: Level = 'viewer') {
  const r = q.get<{ id: string; table_id: string }>('SELECT id, table_id FROM records WHERE id=?', recordId);
  if (!r) throw notFound('Record not found');
  const t = requireTable(userId, r.table_id, need);
  return { record: r, table: t };
}

/** Ids of all tables the user can see in a workspace (used by global search). */
export function visibleTableIds(userId: string, workspaceId: string): string[] {
  return q.all<TableRow>('SELECT * FROM tables WHERE workspace_id=?', workspaceId).filter((t) => tableLevel(userId, t) !== 'none').map((t) => t.id);
}
