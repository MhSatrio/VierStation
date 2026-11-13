import { q } from './db.ts';
import { now, safeJson, uid } from './util.ts';
import { publishToUser } from './events.ts';

export type NotifyKind = 'fetch_completed' | 'structure_ready' | 'analysis_completed' | 'task_failed' | 'collaborator_update' | 'deadline' | 'system';
export const NOTIFY_KINDS: { kind: NotifyKind; label: string }[] = [
  { kind: 'fetch_completed', label: 'A fetch or discovery run completes' },
  { kind: 'structure_ready', label: 'A structure is ready' },
  { kind: 'analysis_completed', label: 'An analysis completes' },
  { kind: 'task_failed', label: 'A job or task fails' },
  { kind: 'collaborator_update', label: 'A collaborator updates a record' },
  { kind: 'deadline', label: 'A deadline approaches' },
];

export interface ChannelPrefs { inApp: boolean; browser: boolean }
const DEFAULT_PREFS: ChannelPrefs = { inApp: true, browser: true };

export function prefsFor(userId: string, kind: string): ChannelPrefs {
  const row = q.get<{ prefs: string }>('SELECT prefs FROM users WHERE id=?', userId);
  const all = safeJson<Record<string, any>>(row?.prefs, {});
  return { ...DEFAULT_PREFS, ...(all.notifications?.[kind] ?? {}) };
}

export function notify(userId: string, n: { kind: NotifyKind; title: string; body?: string; link?: string | null; workspaceId?: string | null; dedupe?: string }) {
  const p = prefsFor(userId, n.kind);
  if (!p.inApp && !p.browser) return null;
  if (n.dedupe) {
    const dup = q.get('SELECT id FROM notifications WHERE user_id=? AND kind=? AND link IS ? AND title=? AND created_at > ?', userId, n.kind, n.link ?? null, n.title, new Date(Date.now() - 20 * 3600_000).toISOString());
    if (dup) return null;
  }
  const id = uid('ntf');
  q.run('INSERT INTO notifications(id,user_id,workspace_id,kind,title,body,link,read,created_at) VALUES (?,?,?,?,?,?,?,0,?)',
    id, userId, n.workspaceId ?? null, n.kind, n.title, n.body ?? '', n.link ?? null, now());
  publishToUser(userId, 'notification', { id, kind: n.kind, title: n.title, body: n.body ?? '', link: n.link ?? null, browser: p.browser });
  return id;
}

/** Notify every member of a workspace/project that can see it, except `exceptUserId`. */
export function notifyWorkspace(workspaceId: string, n: Parameters<typeof notify>[1], exceptUserId?: string | null) {
  for (const m of q.all<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id=?', workspaceId)) {
    if (m.user_id !== exceptUserId) notify(m.user_id, { ...n, workspaceId });
  }
}
