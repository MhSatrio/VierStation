import { parentPort, workerData } from 'node:worker_threads';
import { compute } from './compute.ts';

// Runs one analysis off the main thread; the server stays responsive while this computes.
try {
  const { type, input, params } = workerData;
  parentPort!.postMessage({ ok: true, result: compute(type, input, params) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
