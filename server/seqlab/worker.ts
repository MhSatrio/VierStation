// Worker-thread entry for CPU-heavy Sequence Lab tasks: multiple alignment, tree building (with parallel bootstrap sub-workers).
import { parentPort, workerData, Worker } from 'node:worker_threads';
import os from 'node:os';
import { runMsa } from './msa.ts';
import { runPhylo, bootstrapChunk } from '../phylo/run.ts';
import type { PhyloParams, BuildOpts } from '../phylo/run.ts';

const post = (m: unknown) => parentPort!.postMessage(m);

function bootstrapParallel(labels: string[], rows: string[], p: PhyloParams, reps: number, fixedModel: BuildOpts['fixedModel'], progress: (d: number) => void): Promise<Record<string, number>> {
  const nw = Math.max(1, Math.min(4, os.availableParallelism() - 1, reps));
  const per = Math.ceil(reps / nw), total: Record<string, number> = {}, done = new Array(nw).fill(0);
  return new Promise((resolve, reject) => {
    let finished = 0; const workers: Worker[] = [];
    for (let w = 0; w < nw; w++) {
      const from = w * per, to = Math.min(reps, from + per);
      if (from >= to) { finished++; continue; }
      const sub = new Worker(new URL(import.meta.url), { workerData: { task: 'bootstrap', args: { labels, rows, p, from, to, fixedModel } }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
      workers.push(sub);
      sub.on('message', (m: any) => {
        if (m.type === 'progress') { done[w] = m.done; progress(done.reduce((a, b) => a + b, 0)); }
        else if (m.type === 'result') { for (const [k, v] of Object.entries(m.result as Record<string, number>)) total[k] = (total[k] ?? 0) + v; void sub.terminate(); if (++finished === nw) resolve(total); }
        else if (m.type === 'error') { workers.forEach((x) => void x.terminate()); reject(new Error(m.error)); }
      });
      sub.on('error', (e) => { workers.forEach((x) => void x.terminate()); reject(e); });
    }
    if (finished === nw) resolve(total);
  });
}

(async () => {
  const { task, args } = workerData as { task: string; args: any };
  try {
    if (task === 'msa') post({ type: 'result', result: runMsa(args.labels, args.seqs, args.options, { onProgress: (d, t, msg) => post({ type: 'progress', done: d, total: t, message: msg }) }) });
    else if (task === 'phylo') {
      const r = await runPhylo({ labels: args.labels, rows: args.rows }, args.params, { onProgress: (d, t, msg) => post({ type: 'progress', done: d, total: t, message: msg }), bootstrapRunner: bootstrapParallel });
      post({ type: 'result', result: r });
    } else if (task === 'bootstrap') {
      post({ type: 'result', result: bootstrapChunk(args.labels, args.rows, args.p, args.from, args.to, args.fixedModel, (d) => post({ type: 'progress', done: d })) });
    } else throw new Error(`Unknown task ${task}`);
  } catch (e) { post({ type: 'error', error: (e as Error).message }); }
})();
