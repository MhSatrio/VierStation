// VierStation has NO user accounts: the application is a local, offline-first workspace. This module provides the one implicit local identity
// ("workspace identity") that owns the data and is recorded in the audit log. It is NOT a login: whoever can reach the server (by default only
// this computer) can use it, so the server listens on 127.0.0.1 and refuses requests whose Host header is not local (DNS-rebinding protection).
import { q, tx } from './db.ts';
import { now, uid } from './util.ts';
import { seedWorkspace } from './templates.ts';

export interface LocalUser { id: string; email: string; name: string; prefs: Record<string, any> }
let cached: LocalUser | null = null;

/** Create (or find) the local identity and make it the owner of every workspace in the database, so projects created before accounts were removed stay accessible. */
export function ensureLocalIdentity(): LocalUser {
  let row = q.get<{ id: string; email: string; name: string; prefs: string }>('SELECT id, email, name, prefs FROM users ORDER BY created_at, rowid LIMIT 1');
  if (!row) {
    const id = 'usr_local';
    tx(() => {
      q.run('INSERT INTO users(id,email,name,pw_hash,created_at) VALUES (?,?,?,?,?)', id, 'local@vierstation.invalid', 'Local workspace', '!', now());
      const wsId = uid('wsp');
      q.run('INSERT INTO workspaces(id,name,created_at,created_by) VALUES (?,?,?,?)', wsId, 'My lab', now(), id);
      q.run("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'owner')", wsId, id);
      seedWorkspace(wsId, id);
    });
    row = q.get('SELECT id, email, name, prefs FROM users WHERE id=?', id)!;
  }
  // every workspace belongs to the local identity (databases created by earlier versions may have had other accounts)
  q.run("INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role) SELECT id, ?, 'owner' FROM workspaces", row.id);
  q.run("UPDATE workspace_members SET role='owner' WHERE user_id=?", row.id);
  let prefs: Record<string, any> = {}; try { prefs = JSON.parse(row.prefs); } catch { /* defaults */ }
  cached = { id: row.id, email: row.email, name: row.name === '' ? 'Local workspace' : row.name, prefs };
  return cached;
}
export function localUser(): LocalUser { return cached ?? ensureLocalIdentity(); }
export function resetLocalIdentityCache() { cached = null; }
export function savePrefs(patch: (p: Record<string, any>) => Record<string, any>) {
  const u = localUser(); const next = patch({ ...u.prefs });
  q.run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify(next), u.id);
  cached = { ...u, prefs: next }; return next;
}

/** Hosts a request may use. Anything else (for example a hostile web page that re-points its own DNS name at 127.0.0.1) is refused. */
export function hostAllowed(hostHeader: string | undefined): boolean {
  const h = String(hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')) return true;
  const extra = (process.env.VIERSTATION_ALLOWED_HOSTS ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return extra.includes(h);
}
