// Run a Sequence Lab CPU task in a worker thread with real progress and cancellation.
import { Worker } from 'node:worker_threads';
import { Cancelled, Fatal } from '../jobs.ts';

export function runTask<T>(task: 'msa' | 'phylo', args: unknown, o: { signal?: AbortSignal; onProgress?: (done: number, total: number | null, message: string) => void } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { task, args }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    const onAbort = () => { void w.terminate(); reject(new Cancelled()); };
    if (o.signal?.aborted) { onAbort(); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    w.on('message', (m: any) => {
      if (m.type === 'progress') o.onProgress?.(m.done, m.total ?? null, m.message ?? '');
      else if (m.type === 'result') { o.signal?.removeEventListener('abort', onAbort); void w.terminate(); resolve(m.result as T); }
      else if (m.type === 'error') { o.signal?.removeEventListener('abort', onAbort); void w.terminate(); reject(m.error === 'Cancelled' ? new Cancelled() : new Fatal(m.error)); }
    });
    w.once('error', (e: Error) => { o.signal?.removeEventListener('abort', onAbort); reject(new Fatal(`Worker crashed: ${e.message}`)); });
  });
}
