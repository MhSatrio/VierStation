// Test helpers: boot the real server in-process on an ephemeral port with a throw-away data directory, and a tiny API client.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const dir = mkdtempSync(join(tmpdir(), 'vierstation-test-'));
process.env.VIERSTATION_DATA_DIR = dir;
process.env.VIERSTATION_OFFLINE = '1';
process.env.PORT = '0';
process.env.VIERSTATION_NO_AUTO_IMAGES = '1';
process.env.VIERSTATION_TEST = '1';
process.env.RETRY_BASE_MS = '20';
process.env.JOB_BACKOFF_MS = '40';
const here = dirname(fileURLToPath(import.meta.url));

export const fixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');
export const hasFixture = (name: string) => existsSync(join(here, 'fixtures', name));
export const fixtureJson = (name: string) => JSON.parse(fixture(name));

export async function boot() {
  const { startServer } = await import('../server/index.ts');
  const s = await startServer({ port: 0 });
  return { ...s, base: `http://127.0.0.1:${s.port}` };
}

export class Api {
  base: string;
  constructor(base: string) { this.base = base; }
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method, headers: { 'x-vs': '1', 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  /** GET a binary download (PDF, images). */
  async getBuffer(path: string) {
    const res = await fetch(this.base + path, { headers: { 'x-vs': '1',} });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown = {}) => this.req('PATCH', p, b);
  put = (p: string, b: unknown = {}) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}

let n = 0;
/**
 * There are no accounts: every request is made by the one local workspace identity. Each call creates a FRESH workspace (seeded with the starter project
 * and tables) so that tests stay isolated from each other, and returns the same shape the account-based helper used to return.
 */
export async function newUser(base: string, name = 'Tester') {
  const api = new Api(base);
  const state = await api.get('/api/app/state');
  if (state.status !== 200) throw new Error('app state failed: ' + state.text);
  const made = await api.post('/api/workspaces', { name: `${name} lab ${++n}` });
  if (made.status !== 200) throw new Error('workspace failed: ' + made.text);
  const wsId: string = made.json.id;
  const projects = (await api.get(`/api/workspaces/${wsId}/projects`)).json.projects;
  const projectId: string = projects[0].id;
  const tables = (await api.get(`/api/workspaces/${wsId}/tables?project=${projectId}`)).json.tables as { id: string; kind: string; name: string }[];
  const byKind = Object.fromEntries(tables.map((t) => [t.kind, t.id])) as Record<string, string>;
  return { api, email: state.json.user.email as string, userId: state.json.user.id as string, wsId, projectId, tables: byKind };
}

export async function tableMeta(api: Api, tableId: string) {
  const r = await api.get(`/api/tables/${tableId}`);
  const fields = r.json.fields as { id: string; name: string; key?: string; type: string; options: any }[];
  const byName = (n: string) => fields.find((f) => f.name === n)!.id;
  const byKey = (k: string) => fields.find((f) => f.key === k)!.id;
  return { ...r.json, fields, byName, byKey };
}

export async function waitJob(api: Api, jobId: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api.get(`/api/jobs/${jobId}`);
    const st = r.json.job.status;
    if (['completed', 'failed', 'cancelled'].includes(st)) return r.json as { job: any; logs: any[] };
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still ${st}: ${r.json.job.message}`);
    await new Promise((res) => setTimeout(res, 40));
  }
}
