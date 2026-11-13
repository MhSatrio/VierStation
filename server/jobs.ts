// Durable background job queue (SQLite). Queued -> Running -> Completed / Failed / Cancelled.
// Retries with exponential backoff, cancellation, per-job logs, duplicate prevention, crash recovery.
import { q } from './db.ts';
import { config } from './config.ts';
import { now, safeJson, uid } from './util.ts';
import type { JobInfo, JobStatus } from '../shared/types.ts';
import { publish } from './events.ts';
import { notify } from './notify.ts';
import type { NotifyKind } from './notify.ts';
import { OfflineError, isOffline, onNetworkRestored } from './network.ts';

export class RetryLater extends Error {
  delayMs: number;
  constructor(message: string, delayMs: number) { super(message); this.delayMs = delayMs; }
}
export class Fatal extends Error {}
export class Cancelled extends Error { constructor() { super('Cancelled'); } }

export interface JobCtx {
  id: string;
  type: string;
  workspaceId: string;
  projectId: string | null;
  userId: string | null;
  payload: any;
  attempt: number;
  depth: number;
  automationId: string | null;
  signal: AbortSignal;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Only report real counts. Never invent a percentage. */
  progress: (done: number, total: number | null, message?: string) => void;
  setOutput: (o: { kind: string; ref: string; label?: string }) => void;
  throwIfCancelled: () => void;
}
/** Extension points set by feature modules (keeps jobs.ts independent of them). */
export const hooks = { subject: (_recordId: string): string | null => null };

export interface JobResult { [k: string]: unknown; _notify?: { kind: NotifyKind; title: string; body?: string; link?: string } }
export type JobHandler = (c: JobCtx) => Promise<JobResult | void>;

const handlers = new Map<string, { run: JobHandler; maxAttempts: number }>();
export function registerJob(type: string, run: JobHandler, opts: { maxAttempts?: number } = {}) {
  handlers.set(type, { run, maxAttempts: opts.maxAttempts ?? 3 });
}

type FinishListener = (j: JobInfo, payload: any) => void;
const finishListeners: FinishListener[] = [];
export const onJobFinished = (l: FinishListener) => { finishListeners.push(l); };

const running = new Map<string, AbortController>();
/** Jobs that never need the internet; every other type waits in the queue while VierStation is offline. */
export const LOCAL_ONLY_JOBS = new Set(['analysis.run', 'seq.align', 'seq.tree', 'import.fasta']);
onNetworkRestored(() => setImmediate(() => tick()));

interface JobRow {
  id: string; workspace_id: string; project_id: string | null; type: string; name: string; status: JobStatus; payload: string;
  progress_done: number | null; progress_total: number | null; message: string | null; attempts: number; max_attempts: number;
  run_at: string; created_at: string; started_at: string | null; finished_at: string | null; error: string | null; result: string | null;
  output: string | null; created_by: string | null; cancel_requested: number; automation_id: string | null; depth: number;
}
const toInfo = (r: JobRow): JobInfo => ({
  id: r.id, type: r.type, name: r.name, status: r.status, workspaceId: r.workspace_id, projectId: r.project_id,
  progressDone: r.progress_done, progressTotal: r.progress_total, message: r.message, attempts: r.attempts, maxAttempts: r.max_attempts,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error, result: safeJson(r.result, null),
  output: safeJson(r.output, null), createdBy: r.created_by, automationId: r.automation_id, depth: r.depth,
});

export function getJob(id: string): JobInfo | undefined {
  const r = q.get<JobRow>('SELECT * FROM jobs WHERE id=?', id);
  return r ? toInfo(r) : undefined;
}
export function listJobs(workspaceId: string, o: { projectId?: string | null; status?: string; limit?: number } = {}): JobInfo[] {
  const where = ['workspace_id=?']; const args: (string | number)[] = [workspaceId];
  if (o.projectId) { where.push('project_id=?'); args.push(o.projectId); }
  if (o.status) { where.push('status=?'); args.push(o.status); }
  return q.all<JobRow>(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args, o.limit ?? 100).map(toInfo);
}
export function jobLogs(id: string) {
  return q.all<{ ts: string; level: string; message: string }>('SELECT ts, level, message FROM job_logs WHERE job_id=? ORDER BY id LIMIT 500', id);
}
export function jobCounts(workspaceId: string, projectId?: string | null) {
  const rows = q.all<{ status: string; n: number }>(
    projectId ? 'SELECT status, COUNT(*) n FROM jobs WHERE workspace_id=? AND project_id=? GROUP BY status' : 'SELECT status, COUNT(*) n FROM jobs WHERE workspace_id=? GROUP BY status',
    ...(projectId ? [workspaceId, projectId] : [workspaceId]));
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}

export interface EnqueueSpec {
  workspaceId: string; projectId?: string | null; type: string; name: string; payload?: unknown; userId?: string | null;
  dedupeKey?: string; maxAttempts?: number; delayMs?: number; automationId?: string | null; automationRunId?: string | null; depth?: number;
}
export function enqueue(s: EnqueueSpec): string {
  const id = uid('job');
  const h = handlers.get(s.type);
  if (!h) throw new Error(`No handler registered for job type ${s.type}`);
  try {
    q.run(`INSERT INTO jobs(id,workspace_id,project_id,type,name,status,payload,max_attempts,run_at,created_at,created_by,dedupe_key,automation_id,automation_run_id,depth)
           VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`,
      id, s.workspaceId, s.projectId ?? null, s.type, s.name, JSON.stringify(s.payload ?? {}), s.maxAttempts ?? h.maxAttempts,
      new Date(Date.now() + (s.delayMs ?? 0)).toISOString(), now(), s.userId ?? null, s.dedupeKey ?? null, s.automationId ?? null, s.automationRunId ?? null, s.depth ?? 0);
  } catch (e) {
    if (s.dedupeKey && /UNIQUE/i.test(String((e as Error).message))) {
      const dup = q.get<{ id: string }>("SELECT id FROM jobs WHERE dedupe_key=? AND status IN ('queued','running')", s.dedupeKey);
      if (dup) return dup.id;
    }
    throw e;
  }
  announce(id, s.workspaceId, 'queued');
  setImmediate(tick);
  return id;
}

function announce(id: string, workspaceId: string, status: string) {
  publish(workspaceId, 'job.changed', { jobId: id, status });
}

export function cancelJob(id: string): boolean {
  const j = q.get<JobRow>('SELECT * FROM jobs WHERE id=?', id);
  if (!j) return false;
  if (j.status === 'queued') {
    q.run("UPDATE jobs SET status='cancelled', finished_at=?, message='Cancelled before it started' WHERE id=?", now(), id);
    announce(id, j.workspace_id, 'cancelled');
    return true;
  }
  if (j.status === 'running') {
    q.run('UPDATE jobs SET cancel_requested=1 WHERE id=?', id);
    running.get(id)?.abort();
    return true;
  }
  return false;
}

export function retryJob(id: string, userId: string | null): string | null {
  const j = q.get<JobRow>('SELECT * FROM jobs WHERE id=?', id);
  if (!j || !['failed', 'cancelled', 'completed'].includes(j.status)) return null;
  return enqueue({ workspaceId: j.workspace_id, projectId: j.project_id, type: j.type, name: j.name, payload: safeJson(j.payload, {}), userId: userId ?? j.created_by, automationId: j.automation_id, depth: j.depth });
}

function log(jobId: string, message: string, level = 'info') {
  q.run('INSERT INTO job_logs(job_id,ts,level,message) VALUES (?,?,?,?)', jobId, now(), level, message.slice(0, 2000));
}

const OFFLINE_MSG = 'Waiting for an internet connection (VierStation is offline) – it starts automatically when you are online';
let ticking = false;
let timer: NodeJS.Timeout | null = null;

function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (running.size < config.jobConcurrency) {
      let j: JobRow | undefined;
      if (isOffline()) { // offline: only local jobs may start; the others stay queued with an honest message
        const waiting = q.all<JobRow>("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY created_at LIMIT 100", now());
        j = waiting.find((x) => LOCAL_ONLY_JOBS.has(x.type));
        for (const w of waiting) if (!LOCAL_ONLY_JOBS.has(w.type) && w.message !== OFFLINE_MSG) { q.run('UPDATE jobs SET message=? WHERE id=?', OFFLINE_MSG, w.id); announce(w.id, w.workspace_id, 'queued'); }
      } else j = q.get<JobRow>("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY created_at LIMIT 1", now());
      if (!j) break;
      q.run("UPDATE jobs SET status='running', started_at=COALESCE(started_at,?), attempts=attempts+1, error=NULL WHERE id=? AND status='queued'", now(), j.id);
      void runJob({ ...j, attempts: j.attempts + 1 });
    }
  } finally { ticking = false; }
}

async function runJob(j: JobRow) {
  const h = handlers.get(j.type);
  const ac = new AbortController();
  running.set(j.id, ac);
  announce(j.id, j.workspace_id, 'running');
  const ctx: JobCtx = {
    id: j.id, type: j.type, workspaceId: j.workspace_id, projectId: j.project_id, userId: j.created_by, payload: safeJson(j.payload, {}),
    attempt: j.attempts, depth: j.depth, automationId: j.automation_id, signal: ac.signal,
    log: (m, l) => log(j.id, m, l),
    progress: (done, total, message) => {
      q.run('UPDATE jobs SET progress_done=?, progress_total=?, message=COALESCE(?, message) WHERE id=?', done, total, message ?? null, j.id);
      announce(j.id, j.workspace_id, 'running');
    },
    setOutput: (o) => { q.run('UPDATE jobs SET output=? WHERE id=?', JSON.stringify(o), j.id); },
    throwIfCancelled: () => { if (ac.signal.aborted) throw new Cancelled(); },
  };
  let finalStatus: JobStatus = 'completed';
  let result: JobResult | void = undefined;
  let error: string | null = null;
  try {
    if (!h) throw new Fatal(`No handler for job type ${j.type}`);
    log(j.id, j.attempts > 1 ? `Attempt ${j.attempts} of ${j.max_attempts}` : 'Started');
    result = await h.run(ctx);
  } catch (e) {
    const err = e as Error;
    if (err instanceof Cancelled || ac.signal.aborted) { finalStatus = 'cancelled'; error = null; log(j.id, 'Cancelled by user', 'warn'); }
    else if (err instanceof OfflineError || (err as { code?: string }).code === 'offline') { // no connection: wait, do not use up an attempt
      log(j.id, 'No internet connection – the job is waiting', 'warn');
      q.run("UPDATE jobs SET status='queued', attempts=MAX(0, attempts-1), run_at=?, message=? WHERE id=?", new Date(Date.now() + 15_000).toISOString(), OFFLINE_MSG, j.id);
      running.delete(j.id);
      announce(j.id, j.workspace_id, 'queued');
      scheduleTick(15_050);
      return;
    }
    else if (err instanceof RetryLater && j.attempts < j.max_attempts) {
      log(j.id, `${err.message} – retrying in ${Math.round(err.delayMs / 1000)}s`, 'warn');
      q.run("UPDATE jobs SET status='queued', run_at=?, message=? WHERE id=?", new Date(Date.now() + err.delayMs).toISOString(), `Waiting to retry: ${err.message}`.slice(0, 300), j.id);
      running.delete(j.id);
      announce(j.id, j.workspace_id, 'queued');
      scheduleTick(err.delayMs + 50);
      setImmediate(tick);
      return;
    } else if (!(err instanceof Fatal) && !(err instanceof RetryLater) && j.attempts < j.max_attempts) {
      const delay = Math.min(5 * 60_000, config.jobBackoffMs * 2 ** (j.attempts - 1));
      log(j.id, `${err.message} – retrying in ${Math.round(delay / 1000)}s`, 'warn');
      q.run("UPDATE jobs SET status='queued', run_at=?, message=? WHERE id=?", new Date(Date.now() + delay).toISOString(), `Waiting to retry: ${err.message}`.slice(0, 300), j.id);
      running.delete(j.id);
      announce(j.id, j.workspace_id, 'queued');
      scheduleTick(delay + 50);
      setImmediate(tick);
      return;
    } else { finalStatus = 'failed'; error = err.message || String(err); log(j.id, error, 'error'); if (!(err instanceof Fatal)) console.error('[job]', j.type, err); }
  }
  running.delete(j.id);
  const r = (result ?? null) as JobResult | null;
  const notifyInfo = r?._notify;
  if (r) delete r._notify;
  if (finalStatus === 'completed') q.run('UPDATE jobs SET progress_done=progress_total WHERE id=? AND progress_total IS NOT NULL', j.id); // it finished every unit it announced
  q.run('UPDATE jobs SET status=?, finished_at=?, error=?, result=?, message=COALESCE(?, message) WHERE id=?',
    finalStatus, now(), error, r ? JSON.stringify(r) : null, finalStatus === 'completed' ? (typeof r?.summary === 'string' ? r.summary : 'Completed') : finalStatus === 'cancelled' ? 'Cancelled' : error, j.id);
  announce(j.id, j.workspace_id, finalStatus);
  const info = getJob(j.id)!;
  if (j.created_by) {
    if (finalStatus === 'completed' && notifyInfo) {
      // Sequence Lab jobs name the sequence they ran on, so a notification read later cannot be mistaken for another record
      const rid = safeJson<{ recordId?: string }>(j.payload, {}).recordId, subject = j.type.startsWith('seq.') && rid ? hooks.subject(rid) : null;
      notify(j.created_by, { ...notifyInfo, ...(subject ? { title: `${notifyInfo.title} – ${subject}` } : {}), link: notifyInfo.link ?? `/jobs/${j.id}`, workspaceId: j.workspace_id });
    } else if (finalStatus === 'failed') notify(j.created_by, { kind: 'task_failed', title: `${j.name} failed`, body: error ?? '', link: `/jobs/${j.id}`, workspaceId: j.workspace_id });
  }
  for (const l of finishListeners) { try { l(info, safeJson(j.payload, {})); } catch (e) { console.error('[job listener]', e); } }
  setImmediate(tick);
}

function scheduleTick(ms: number) {
  setTimeout(tick, Math.min(ms, 2 ** 30)).unref();
}

export function startJobs() {
  // Crash recovery: anything left running when the process died goes back to the queue.
  q.run("UPDATE jobs SET status='queued', message='Re-queued after server restart' WHERE status='running'");
  timer = setInterval(tick, 1000);
  timer.unref();
  tick();
}
export function stopJobs() {
  if (timer) clearInterval(timer);
  for (const ac of running.values()) ac.abort();
}
export const runningCount = () => running.size;

/** Wait until a job leaves queued/running (used by tests). */
export async function waitForJob(id: string, timeoutMs = 60_000): Promise<JobInfo> {
  const t0 = Date.now();
  for (;;) {
    const j = getJob(id)!;
    if (['completed', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for job ${id} (${j.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
