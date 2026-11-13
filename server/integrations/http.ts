// Polite outbound HTTP for scientific APIs: per-host rate limits + concurrency, retries with Retry-After,
// persistent response cache (SQLite), a fixture hook for offline tests, and no API keys in URLs we log.
import { q } from '../db.ts';
import { config } from '../config.ts';
import { sha256, sleep } from '../util.ts';
import { RetryLater } from '../jobs.ts';
import { OfflineError, isOffline, suspectOffline } from '../network.ts';

export class UpstreamError extends Error {
  status: number; host: string;
  constructor(host: string, status: number, message: string) { super(`${host}: ${message}`); this.host = host; this.status = status; }
}

interface HostPolicy { minIntervalMs: number; concurrency: number; timeoutMs: number }
const POLICIES: Record<string, HostPolicy> = {
  'eutils.ncbi.nlm.nih.gov': { minIntervalMs: 0, concurrency: 3, timeoutMs: 30_000 }, // interval set dynamically (key aware)
  'blast.ncbi.nlm.nih.gov': { minIntervalMs: 3_000, concurrency: 1, timeoutMs: 60_000 },
  'rest.uniprot.org': { minIntervalMs: 120, concurrency: 4, timeoutMs: 40_000 },
  'alphafold.ebi.ac.uk': { minIntervalMs: 120, concurrency: 4, timeoutMs: 40_000 },
  'www.ebi.ac.uk': { minIntervalMs: 150, concurrency: 2, timeoutMs: 90_000 }, // ChEMBL + InterPro: ChEMBL can take 20+ s
  'pubchem.ncbi.nlm.nih.gov': { minIntervalMs: 220, concurrency: 3, timeoutMs: 40_000 }, // PubChem allows 5 req/s
  'data.rcsb.org': { minIntervalMs: 100, concurrency: 4, timeoutMs: 40_000 },
  'search.rcsb.org': { minIntervalMs: 100, concurrency: 3, timeoutMs: 40_000 },
  'files.rcsb.org': { minIntervalMs: 100, concurrency: 3, timeoutMs: 60_000 },
  'nominatim.openstreetmap.org': { minIntervalMs: 1_100, concurrency: 1, timeoutMs: 30_000 }, // OpenStreetMap usage policy: at most 1 request per second
  'www.bindingdb.org': { minIntervalMs: 500, concurrency: 1, timeoutMs: 90_000 },
};
const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 200, concurrency: 2, timeoutMs: 30_000 };

function policyFor(host: string): HostPolicy {
  const p = POLICIES[host] ?? DEFAULT_POLICY;
  if (host === 'eutils.ncbi.nlm.nih.gov') return { ...p, minIntervalMs: config.ncbiApiKey ? 110 : 340 }; // 10 vs 3 requests/s
  return p;
}

interface HostState { next: number; active: number; waiters: (() => void)[] }
const hosts = new Map<string, HostState>();

async function acquire(host: string, signal?: AbortSignal) {
  const p = policyFor(host);
  let s = hosts.get(host);
  if (!s) { s = { next: 0, active: 0, waiters: [] }; hosts.set(host, s); }
  while (s.active >= p.concurrency) {
    await new Promise<void>((res, rej) => {
      s!.waiters.push(res);
      signal?.addEventListener('abort', () => rej(new Error('Cancelled')), { once: true });
    });
  }
  s.active++;
  const wait = Math.max(0, s.next - Date.now());
  s.next = Math.max(Date.now(), s.next) + p.minIntervalMs;
  if (wait) { try { await sleep(wait, signal); } catch (e) { release(host); throw e; } } // an aborted waiter must give its slot back, or a concurrency-1 host (BLAST) would block forever
}
function release(host: string) {
  const s = hosts.get(host)!;
  s.active--;
  s.waiters.shift()?.();
}

// ---- injectable fetch (tests supply fixtures; production uses global fetch) ----
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (u, i) => fetch(u, i);
export const setFetch = (f: FetchFn | null) => { fetchImpl = f ?? ((u, i) => fetch(u, i)); };
export const outboundLog: { url: string; ms: number; status: number; cached: boolean }[] = [];

export interface ReqOpts {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** cache time in seconds (0 = no cache). 404 responses are cached for min(ttl, 1h). */
  ttl?: number;
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  accept?: string;
  /** treat these statuses as a normal "not found" result instead of an error */
  okStatuses?: number[];
}
export interface Resp { status: number; text: string; json<T = any>(): T; cached: boolean; headers: Headers | null }

function cacheGet(key: string, anyAge = false): { status: number; body: string } | undefined {
  const r = q.get<{ status: number; body: string; fetched_at: number; ttl_s: number }>('SELECT status, body, fetched_at, ttl_s FROM http_cache WHERE key=?', key);
  if (!r) return undefined;
  if (!anyAge && Date.now() / 1000 - r.fetched_at > r.ttl_s) return undefined; // offline: a stale answer is better than none
  return { status: r.status, body: r.body };
}
function cachePut(key: string, status: number, body: string, ttl: number) {
  if (body.length > 3_000_000) return;
  q.run('INSERT INTO http_cache(key,status,body,fetched_at,ttl_s) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at, ttl_s=excluded.ttl_s',
    key, status, body, Math.floor(Date.now() / 1000), ttl);
}
export const purgeCache = () => q.run('DELETE FROM http_cache');

export async function request(url: string, o: ReqOpts = {}): Promise<Resp> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(config.offline || u.hostname === 'localhost')) throw new Error('Only https upstream requests are allowed');
  const host = u.host;
  const method = o.method ?? 'GET';
  const key = sha256(`${method} ${url} ${o.body ?? ''}`);
  const ttl = o.ttl ?? 0;
  if (ttl > 0) {
    const hit = cacheGet(key);
    if (hit) { outboundLog.push({ url, ms: 0, status: hit.status, cached: true }); return mk(hit.status, hit.body, true, null); }
  }
  if (isOffline() && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    const old = cacheGet(key, true);
    if (old) { outboundLog.push({ url, ms: 0, status: old.status, cached: true }); return mk(old.status, old.body, true, null); }
    throw new OfflineError(`Fetching ${u.hostname}`);
  }
  const retries = o.retries ?? 3;
  const pol = policyFor(host);
  let lastErr: Error | null = null;
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw new Error('Cancelled');
    await acquire(host, o.signal);
    let waitMs = 0;
    try {
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error('timeout')), o.timeoutMs ?? pol.timeoutMs);
      const onAbort = () => ctl.abort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response, text: string;
      try {
        res = await fetchImpl(url, {
          method, body: o.body, signal: ctl.signal,
          headers: { 'user-agent': `${config.toolName}/0.1 (+${config.appUrl}${config.contactEmail ? '; ' + config.contactEmail : ''})`, accept: o.accept ?? 'application/json', ...o.headers },
        });
        text = await res.text();
      } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); }
      outboundLog.push({ url, ms: Date.now() - t0, status: res.status, cached: false });
      if (outboundLog.length > 500) outboundLog.splice(0, 250);
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, config.retryBaseMs * 2 ** attempt);
        lastErr = new UpstreamError(host, res.status, res.status === 429 ? 'rate limited' : `server error ${res.status}`);
        if (attempt >= retries && (res.status === 429 || res.status === 503)) throw new RetryLater(`${host} is busy (HTTP ${res.status})`, Math.max(waitMs, 20_000));
      } else {
        if (res.status >= 400 && res.status !== 404 && !(o.okStatuses ?? []).includes(res.status)) {
          throw new UpstreamError(host, res.status, `HTTP ${res.status}${text ? ': ' + text.slice(0, 160).replace(/\s+/g, ' ') : ''}`);
        }
        if (ttl > 0 && (res.status === 200 || res.status === 404 || (o.okStatuses ?? []).includes(res.status))) cachePut(key, res.status, text, res.status === 200 ? ttl : Math.min(ttl, 3600));
        return mk(res.status, text, false, res.headers);
      }
    } catch (e) {
      if (e instanceof RetryLater || (e instanceof UpstreamError && e.status < 500 && e.status !== 429 && e.status !== 0)) throw e;
      if (o.signal?.aborted) throw new Error('Cancelled');
      lastErr = e as Error;
      waitMs = Math.min(20_000, (config.retryBaseMs * 2 / 3) * 2 ** attempt);
    } finally {
      release(host);
    }
    if (attempt >= retries) break;
    await sleep(waitMs, o.signal); // back off OUTSIDE the host slot so other requests keep flowing
  }
  const msg = lastErr?.message ?? 'request failed';
  if (!(lastErr instanceof UpstreamError) || lastErr.status === 0) suspectOffline(); // no HTTP answer at all: is the internet gone?
  throw lastErr instanceof UpstreamError ? lastErr : new UpstreamError(host, 0, /abort|timeout/i.test(msg) ? 'timed out' : msg);
}

function mk(status: number, text: string, cached: boolean, headers: Headers | null): Resp {
  return { status, text, cached, headers, json: <T>() => JSON.parse(text) as T };
}

/** A binary download (images). Same per-host limits and the same offline rule as every other outbound call; nothing is cached in SQLite – callers keep the file. */
export async function requestBuffer(url: string, o: { signal?: AbortSignal; timeoutMs?: number; accept?: string } = {}): Promise<{ status: number; buf: Buffer; contentType: string }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(config.offline || u.hostname === 'localhost')) throw new Error('Only https upstream requests are allowed');
  if (isOffline() && u.hostname !== 'localhost') throw new OfflineError(`Fetching ${u.hostname}`);
  let last: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) throw new Error('Cancelled');
    await acquire(u.host, o.signal);
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(new Error('timeout')), o.timeoutMs ?? 30_000); const onAbort = () => ctl.abort(); o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': `${config.toolName}/0.1 (+${config.appUrl}${config.contactEmail ? '; ' + config.contactEmail : ''})`, accept: o.accept ?? '*/*' } });
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.status >= 500 && attempt === 0) { last = new UpstreamError(u.host, res.status, `server error ${res.status}`); } else return { status: res.status, buf, contentType: res.headers.get('content-type') ?? '' };
      } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); }
    } catch (e) { last = e as Error; if (o.signal?.aborted) throw new Error('Cancelled'); } finally { release(u.host); }
    await sleep(config.retryBaseMs, o.signal);
  }
  suspectOffline();
  throw last instanceof UpstreamError ? last : new UpstreamError(u.host, 0, last?.message ?? 'request failed');
}

/** GET JSON; returns null on 404 (a normal "no such record" answer for accession lookups). */
export async function getJson<T = any>(url: string, o: ReqOpts = {}): Promise<T | null> {
  const r = await request(url, { ttl: 6 * 3600, ...o });
  if (r.status === 404) return null;
  if (!r.text.trim()) return null;
  try { return r.json<T>(); } catch { throw new UpstreamError(new URL(url).host, r.status, 'returned a response that is not JSON'); }
}
export async function getText(url: string, o: ReqOpts = {}): Promise<string | null> {
  const r = await request(url, { ttl: 6 * 3600, accept: 'text/plain', ...o });
  return r.status === 404 ? null : r.text;
}
