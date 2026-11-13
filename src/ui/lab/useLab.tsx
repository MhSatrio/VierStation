import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { get, post } from '../../lib/api.ts';
import { toast, useEvent } from '../../lib/store.ts';
import { JobLine } from '../RecordPanel.tsx';

export interface LabCtxValue { id: string; ov: any; refresh: () => Promise<void>; tick: number; bump: () => void; canEdit: boolean; go: (section: string) => void }
export const LabCtx = createContext<LabCtxValue>(null as unknown as LabCtxValue);
export const useLab = () => useContext(LabCtx);

/** Run an async action; show failures as a toast instead of throwing into React. */
export async function act<T>(fn: () => Promise<T>, okMsg?: string | ((r: T) => string | undefined)): Promise<T | undefined> {
  try { const r = await fn(); const m = typeof okMsg === 'function' ? okMsg(r) : okMsg; if (m) toast(m, 'ok'); return r; } catch (e) { toast((e as Error).message, 'err'); return undefined; }
}

/** Fetch lab data and refetch whenever the lab changes (tick). Stale responses are ignored. */
export function useLabGet<T = any>(path: string | null, deps: unknown[] = []): { data: T | null; loading: boolean; error: string; reload: () => void } {
  const { tick } = useLab();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const mine = ++seq.current; setLoading(true);
    get<T>(path).then((r) => { if (mine === seq.current) { setData(r); setError(''); setLoading(false); } }, (e) => { if (mine === seq.current) { setError(e.message); setLoading(false); } });
  }, [path, tick, n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, loading, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Start a background job and show its live progress; calls onDone when it finishes. */
export function useJobRunner(onDone?: (status: string, job: any) => void) {
  const { bump, refresh } = useLab();
  const [jobId, setJobId] = useState<string | null>(null);
  useEvent('job.changed', async (e) => {
    if (e.jobId !== jobId || !['completed', 'failed', 'cancelled'].includes(e.status)) return;
    const j = (await get(`/api/jobs/${jobId}`)).job;
    setJobId(null); await refresh(); bump(); onDone?.(e.status, j);
    if (e.status === 'failed') toast(j.error ?? 'The job failed', 'err');
  }, [jobId]);
  const start = async (path: string, body: unknown) => { const r = await act(() => post(path, body)); if (r?.jobId) setJobId(r.jobId); return r?.jobId as string | undefined; };
  return { jobId, running: !!jobId, start, view: jobId ? <JobLine id={jobId} /> : null as ReactNode };
}

export function Section({ title, help, children, right }: { title: ReactNode; help?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return <div className="lab-sec"><div className="row between wrap"><h2>{title}{help}</h2>{right}</div>{children}</div>;
}
