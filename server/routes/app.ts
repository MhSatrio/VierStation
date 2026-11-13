// Application state for the single local workspace (there are no accounts, no login and no e-mail).
import { route } from '../http.ts';
import { q } from '../db.ts';
import { NOTIFY_KINDS } from '../notify.ts';
import { savePrefs } from '../local.ts';
import { networkStatus } from '../network.ts';
import { readCfg, saveSetup, setupState, termsText } from '../setup.ts';

export function workspacesFor(userId: string) {
  return q.all<{ id: string; name: string; role: string }>(
    'SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at', userId);
}

/** Everything the browser needs to start: the local identity (for audit/preferences only), workspaces, notification kinds and the network state. */
route('GET', '/api/app/state', (c) => ({ user: c.user, workspaces: workspacesFor(c.user!.id), notificationKinds: NOTIFY_KINDS, network: networkStatus(), setup: setupState() }));

route('GET', '/api/app/terms', () => ({ text: termsText() }));

/** First-run choices: lab name (also renames the active workspace), data folder (restart to apply), acceptance of the terms. */
route('PUT', '/api/app/setup', (c) => {
  const result = saveSetup({ labName: c.body.labName, dataDir: c.body.dataDir, acceptTerms: c.body.acceptTerms });
  if (typeof c.body.labName === 'string' && typeof c.body.workspaceId === 'string') {
    const name = String(readCfg().labName ?? '').trim();
    if (name && workspacesFor(c.user!.id).some((w) => w.id === c.body.workspaceId)) q.run('UPDATE workspaces SET name=? WHERE id=?', name, c.body.workspaceId);
  }
  return { ...result, setup: setupState() };
});

route('PATCH', '/api/app/prefs', (c) => {
  const prefs = savePrefs((p) => {
    if (c.body.notifications && typeof c.body.notifications === 'object') {
      const clean: Record<string, unknown> = {};
      for (const k of NOTIFY_KINDS) { const v = c.body.notifications[k.kind]; if (v && typeof v === 'object') clean[k.kind] = { inApp: !!v.inApp, browser: !!v.browser }; }
      p.notifications = clean;
    }
    for (const k of ['sidebarCollapsed', 'tooltips', 'reduceMotion'] as const) if (typeof c.body[k] === 'boolean') p[k] = c.body[k];
    if (c.body.theme === 'light' || c.body.theme === 'dark' || c.body.theme === 'system') p.theme = c.body.theme;
    if (typeof c.body.activeWorkspace === 'string') p.activeWorkspace = c.body.activeWorkspace.slice(0, 40);
    if (typeof c.body.activeProject === 'string' || c.body.activeProject === null) p.activeProject = c.body.activeProject;
    if (c.body.defaults && typeof c.body.defaults === 'object') p.defaults = { ...(p.defaults ?? {}), ...Object.fromEntries(Object.entries(c.body.defaults).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 40)) };
    return p;
  });
  return { prefs };
});
