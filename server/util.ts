import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { config } from './config.ts';

export const now = () => new Date().toISOString();

/** Short, URL-safe, prefixed id: rec_aB3x... (72 bits of randomness). */
export const uid = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const bad = (m: string) => new HttpError(400, m, 'bad_request');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m, 'forbidden');


// ---- secrets at rest (AES-256-GCM) ----
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.masterKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', config.masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
export const mask = (s: string) => (s.length <= 8 ? '••••' : `${s.slice(0, 3)}••••${s.slice(-3)}`);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Cancelled')); }, { once: true });
  });

/** Escape a user string for LIKE with ESCAPE '\\'. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
