import { q } from './db.ts';
import { now } from './util.ts';
import type { Ctx } from './http.ts';

/** Append-only audit trail of security-relevant and data-changing actions. Never stores secrets or cell contents. */
export function audit(
  who: { userId?: string | null; ip?: string | null },
  workspaceId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
) {
  try {
    q.run('INSERT INTO audit_log(ts,user_id,workspace_id,action,target_type,target_id,detail,ip) VALUES (?,?,?,?,?,?,?,?)',
      now(), who.userId ?? null, workspaceId, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null, who.ip ?? null);
  } catch (e) {
    console.error('[audit] failed', e);
  }
}

export const auditCtx = (c: Ctx, workspaceId: string | null, action: string, targetType?: string, targetId?: string, detail?: Record<string, unknown>) =>
  audit({ userId: c.user?.id, ip: c.ip }, workspaceId, action, targetType, targetId, detail);
