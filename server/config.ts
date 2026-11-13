import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (KEY=VALUE, # comments, optional quotes). Never overrides real environment variables. */
function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(join(ROOT, '.env'));

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Installation choices made in the first-run screen (lab name, data folder, terms). Environment variables still win. */
export const setupFile = process.env.VIERSTATION_CONFIG ? resolve(process.env.VIERSTATION_CONFIG) : join(ROOT, 'vierstation.config.json');
function readSetupCfg(): { dataDir?: string } { try { return JSON.parse(readFileSync(setupFile, 'utf8')); } catch { return {}; } }
const dataDir = process.env.VIERSTATION_DATA_DIR ? resolve(process.env.VIERSTATION_DATA_DIR) : readSetupCfg().dataDir ? resolve(readSetupCfg().dataDir!) : process.env.VIERSTATION_DEFAULT_DATA_DIR ? resolve(process.env.VIERSTATION_DEFAULT_DATA_DIR) : join(ROOT, 'data'); // the installed app passes a per-user folder
mkdirSync(join(dataDir, 'files'), { recursive: true });

function masterKey(): Buffer {
  const env = process.env.VIERSTATION_MASTER_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, 'hex');
  const f = join(dataDir, '.master.key');
  if (existsSync(f)) return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
  const k = randomBytes(32);
  writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir,
  dbFile: process.env.VIERSTATION_DB ?? join(dataDir, 'vierstation.db'),
  filesDir: join(dataDir, 'files'),
  distDir: join(ROOT, 'dist'),
  masterKey: masterKey(),
  /** Contact e-mail sent to NCBI/PubChem as required by their usage policies. Never the user's private address by default. */
  contactEmail: process.env.VIERSTATION_CONTACT_EMAIL ?? '',
  toolName: 'VierStation',
  ncbiApiKey: process.env.NCBI_API_KEY ?? '',
  appUrl: process.env.APP_URL ?? `http://localhost:${num(process.env.PORT, 8787)}`,
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  jobConcurrency: num(process.env.JOB_CONCURRENCY, 3),
  /** Allow open registration (first user always allowed and becomes owner). */
  /** Tests / offline: replace outbound network access with a fixture handler. */
  offline: process.env.VIERSTATION_OFFLINE === '1',
  /** Per-user API budget. Interactive use (live-updating grids, search-as-you-type) legitimately bursts; this only stops runaway clients. */
  apiRatePerMin: num(process.env.API_RATE_PER_MIN, 2400),
  /** BLAST polling cadence (NCBI asks clients to wait for the estimated time, then poll sparingly). Tests shorten these. */
  jobBackoffMs: num(process.env.JOB_BACKOFF_MS, 5000),
  retryBaseMs: num(process.env.RETRY_BASE_MS, 1500),
  blastMinWaitMs: num(process.env.BLAST_MIN_WAIT_MS, 5000),
  blastPollMs: num(process.env.BLAST_POLL_MS, 20000),
};
