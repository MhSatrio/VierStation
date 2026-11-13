// Server-sent events hub: one long-lived GET per browser tab. Keeps all open views synchronized and streams job progress.
import type { ServerResponse } from 'node:http';
import { q } from './db.ts';

interface Client { res: ServerResponse; userId: string; workspaces: Set<string> }
const clients = new Set<Client>();

export function subscribe(res: ServerResponse, userId: string) {
  const workspaces = new Set(q.all<{ workspace_id: string }>('SELECT workspace_id FROM workspace_members WHERE user_id=?', userId).map((r) => r.workspace_id));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const c: Client = { res, userId, workspaces };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); clients.delete(c); });
}

function send(c: Client, type: string, data: unknown) {
  c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Broadcast to everyone in a workspace. Clients re-check access when they refetch – events carry ids only, never data. */
export function publish(workspaceId: string, type: string, data: Record<string, unknown>) {
  for (const c of clients) if (c.workspaces.has(workspaceId)) send(c, type, { ...data, workspaceId });
}
export function publishToUser(userId: string, type: string, data: Record<string, unknown>) {
  for (const c of clients) if (c.userId === userId) send(c, type, data);
}
export function clientCount() { return clients.size; }
