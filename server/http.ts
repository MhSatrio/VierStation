import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, bad, forbidden, notFound } from './util.ts';
import { hostAllowed, localUser } from './local.ts';
import { config } from './config.ts';

export interface User { id: string; email: string; name: string; prefs: Record<string, any> } // the local workspace identity (no accounts)

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  body: any;
  user: User | null;
  /** raw body for uploads */
  raw?: Buffer;
}

type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean; raw: boolean; stream: boolean }
const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler, opts: { auth?: boolean; raw?: boolean; stream?: boolean } = {}) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }).replace(/\*/g, '.*') + '/?$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw, stream: !!opts.stream });
}

// ---------------- identity ----------------
// There are no accounts: every request is made by the one local workspace identity (see local.ts).
export const userFromRequest = (_req: IncomingMessage): User => localUser();

// ---------------- rate limiting (in-memory sliding window) ----------------
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const t = Date.now();
  const arr = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    const retry = Math.ceil((windowMs - (t - arr[0])) / 1000);
    throw new HttpError(429, `Too many requests. Try again in ${retry}s.`, 'rate_limited');
  }
  arr.push(t);
  buckets.set(key, arr);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > windowMs) buckets.delete(k);
}

// ---------------- responses ----------------
export function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://alphafold.ebi.ac.uk https://pubchem.ncbi.nlm.nih.gov https://cdn.rcsb.org; " +
    "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const MAX_JSON = 8 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'Request body too large', 'too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!url.pathname.startsWith('/api/')) return false;
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  try {
    let matched: Route | undefined, params: Record<string, string> = {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = r;
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      break;
    }
    if (!matched) throw pathMatched ? new HttpError(405, 'Method not allowed') : notFound('Unknown API route');

    const mutating = method !== 'GET' && method !== 'HEAD';
    // CSRF: cross-site requests cannot add custom headers without a CORS preflight, which we never grant.
    if (mutating && req.headers['x-vs'] !== '1') throw forbidden('Missing X-VS header');

    if (!hostAllowed(req.headers.host)) throw forbidden('This VierStation only answers requests addressed to localhost (it has no login). Set VIERSTATION_ALLOWED_HOSTS to allow another host name.');
    const user = userFromRequest(req);
    rateLimit(`api:${user?.id ?? ip}`, config.apiRatePerMin, 60_000);

    let body: any = undefined, raw: Buffer | undefined;
    if (mutating && !matched.stream) { // stream routes read the request themselves (large uploads go straight to disk)
      if (matched.raw) raw = await readBody(req, config.maxUploadBytes + 1024);
      else {
        const buf = await readBody(req, MAX_JSON);
        if (buf.length) {
          try { body = JSON.parse(buf.toString('utf8')); } catch { throw bad('Request body is not valid JSON'); }
        }
      }
    }
    const ctx: Ctx = { req, res, url, params, query: url.searchParams, ip, body: body ?? {}, user, raw };
    const result = await matched.handler(ctx);
    if (!res.headersSent && !res.writableEnded) json(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    if (res.headersSent) { res.end(); return true; }
    if (e instanceof HttpError) json(res, e.status, { error: e.message, code: e.code });
    else {
      console.error('[api error]', method, url.pathname, e);
      json(res, 500, { error: 'Internal server error', code: 'internal' });
    }
  }
  return true;
}

// ---------------- input validation helpers ----------------
export function str(v: unknown, name: string, opts: { max?: number; min?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw bad(`${name} is required`);
  }
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw bad(`${name} must be at least ${opts.min} characters`);
  if (s.length > (opts.max ?? 500)) throw bad(`${name} is too long (max ${opts.max ?? 500})`);
  return s;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return v as T;
}
export function int(v: unknown, name: string, d: number, min = 0, max = 1_000_000): number {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
