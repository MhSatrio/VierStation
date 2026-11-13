// Local data safety: consistent database backups, restore, and a single-file workspace export/import (".vsws").
// The export is a gzip stream: "VSWS1\n", one manifest line, then entries (header line + raw bytes): the database snapshot, uploaded files, cached images and structures.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { closeDb, db, openDb, SCHEMA_VERSION as schemaVersion } from './db.ts';
import { bad, now } from './util.ts';
import { ensureLocalIdentity, resetLocalIdentityCache } from './local.ts';
import { runningCount } from './jobs.ts';
import { upgradeTemplateFields } from './templates.ts';

export const backupDir = () => { const d = join(config.dataDir, 'backups'); mkdirSync(d, { recursive: true }); return d; };
let stampN = 0; // unique even when two snapshots are taken in the same millisecond
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + String(stampN++ % 1000).padStart(3, '0');
const dataSubdirs = ['files', 'images', 'structures'] as const;

/** A consistent snapshot of the live database (SQLite VACUUM INTO – safe while the app is running). */
export function backupNow(label = 'backup'): { name: string; file: string; bytes: number } {
  const name = `vierstation-${label}-${stamp()}.db`, file = join(backupDir(), name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  pruneBackups();
  return { name, file, bytes: statSync(file).size };
}
/** One automatic backup per day at most (called an hour after start and then hourly). Returns the new backup, or null when one is recent enough. */
export function autoBackupIfDue(maxAgeMs = 23 * 3600_000): { name: string } | null {
  const last = listBackups().find((b) => b.label === 'auto');
  if (last && Date.now() - Date.parse(last.createdAt) < maxAgeMs) return null;
  return backupNow('auto');
}
let autoTimer: ReturnType<typeof setInterval> | null = null;
export function startAutoBackup() {
  if (process.env.VIERSTATION_TEST === '1' || process.env.VIERSTATION_NO_AUTO_BACKUP === '1' || autoTimer) return;
  const tick = () => { try { autoBackupIfDue(); } catch (e) { console.warn('Automatic backup failed:', (e as Error).message); } };
  setTimeout(tick, 60_000).unref(); autoTimer = setInterval(tick, 3600_000); autoTimer.unref();
}
export function stopAutoBackup() { if (autoTimer) clearInterval(autoTimer); autoTimer = null; }

/** keep the 20 newest automatic backups; manual and before-restore snapshots are never pruned */
function pruneBackups() {
  const auto = listBackups().filter((b) => b.label === 'auto');
  for (const b of auto.slice(20)) rmSync(join(backupDir(), b.name), { force: true });
}
export function listBackups() {
  return readdirSync(backupDir()).filter((f) => /^vierstation-.*\.db$/.test(f)).map((f) => {
    const st = statSync(join(backupDir(), f)); const m = /^vierstation-([a-z-]+?)-\d{4}-/.exec(f);
    return { name: f, bytes: st.size, createdAt: st.mtime.toISOString(), label: m?.[1] ?? 'backup' };
  }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Refuse to open a file that is not a healthy VierStation database. Returns its schema version. */
export function validateDb(file: string): number {
  let d: DatabaseSync | null = null;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    const ic = (d.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (ic !== 'ok') throw bad(`The database failed its integrity check (${ic}).`);
    const v = Number((d.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value);
    if (!Number.isFinite(v) || !d.prepare("SELECT 1 FROM sqlite_master WHERE name='records'").get()) throw bad('This file is not a VierStation database.');
    if (v > schemaVersion()) throw bad(`This data was written by a newer VierStation (schema ${v}, this version understands ${schemaVersion()}). Update VierStation first.`);
    return v;
  } catch (e) { if ((e as { status?: number }).status) throw e; throw bad(`Cannot read this database: ${(e as Error).message}`); }
  finally { d?.close(); }
}

/** Replace the live database (and optionally the file folders) with a staged copy. The current data is backed up first; nothing is lost if the staged copy is bad. */
export function swapIn(stagedDb: string, stagedDirs: string | null) {
  if (runningCount() > 0) throw bad('Background tasks are running. Wait for them to finish (or cancel them) before restoring.');
  validateDb(stagedDb);
  const safety = backupNow('before-restore');
  closeDb();
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbFile + suffix, { force: true });
    copyFileSync(stagedDb, config.dbFile);
    if (stagedDirs) for (const d of dataSubdirs) if (existsSync(join(stagedDirs, d))) copyTree(join(stagedDirs, d), join(config.dataDir, d));
  } catch (e) {
    // put the safety copy back so the user is never left without a database
    for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbFile + suffix, { force: true });
    copyFileSync(safety.file, config.dbFile);
    openDb(); resetLocalIdentityCache(); ensureLocalIdentity();
    throw bad(`Restore failed and your previous data was kept: ${(e as Error).message}`);
  }
  openDb(); resetLocalIdentityCache(); ensureLocalIdentity(); try { upgradeTemplateFields(); } catch { /* optional columns only */ }
  return { safetyBackup: safety.name };
}
function copyTree(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from, { withFileTypes: true })) { if (f.isDirectory()) copyTree(join(from, f.name), join(to, f.name)); else copyFileSync(join(from, f.name), join(to, f.name)); }
}
function* walk(dir: string, base = ''): Generator<{ rel: string; abs: string; size: number }> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${f.name}` : f.name, abs = join(dir, f.name);
    if (f.isDirectory()) yield* walk(abs, rel); else yield { rel, abs, size: statSync(abs).size };
  }
}
export function dirBytes(dir: string): number { let n = 0; for (const f of walk(dir)) n += f.size; return n; }

// ---------------------------------------------------------------- export / import of a whole workspace
export async function exportWorkspace(dest: string): Promise<{ entries: number }> {
  const snap = join(backupDir(), `export-snapshot-${stamp()}.tmp`);
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  const gz = createGzip({ level: 6 }); const out = createWriteStream(dest); gz.pipe(out);
  const put = async (buf: Buffer | string) => { if (!gz.write(buf)) await once(gz, 'drain'); };
  let entries = 0;
  try {
    await put('VSWS1\n');
    await put(JSON.stringify({ app: 'VierStation', schema: schemaVersion(), createdAt: now() }) + '\n');
    const add = async (name: string, abs: string, size: number) => {
      await put(JSON.stringify({ n: name, s: size }) + '\n');
      for await (const chunk of createReadStream(abs)) await put(chunk as Buffer);
      entries++;
    };
    await add('db.sqlite', snap, statSync(snap).size);
    for (const d of dataSubdirs) for (const f of walk(join(config.dataDir, d), d)) await add(f.rel, f.abs, f.size);
    await put(JSON.stringify({ end: true }) + '\n');
    gz.end(); await once(out, 'close');
  } finally { rmSync(snap, { force: true }); }
  return { entries };
}

class Reader {
  private buf = Buffer.alloc(0); private it: AsyncIterator<Buffer>;
  constructor(stream: AsyncIterable<Buffer>) { this.it = stream[Symbol.asyncIterator](); }
  private async fill(n: number) { while (this.buf.length < n) { const r = await this.it.next(); if (r.done) return false; this.buf = Buffer.concat([this.buf, r.value]); } return true; }
  async line(): Promise<string | null> {
    for (;;) { const i = this.buf.indexOf(10); if (i >= 0) { const l = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 1); return l; } if (!(await this.fill(this.buf.length + 1))) return null; }
  }
  async bytes(n: number, sink: (b: Buffer) => void) { let left = n; while (left > 0) { if (!(await this.fill(1))) throw bad('The export file is truncated.'); const take = Math.min(left, this.buf.length); sink(this.buf.subarray(0, take)); this.buf = this.buf.subarray(take); left -= take; } }
}
/** Unpack an export into a staging folder (never touches live data). */
export async function unpackWorkspace(srcFile: string, stageDir: string): Promise<{ db: string; dirs: string }> {
  mkdirSync(stageDir, { recursive: true });
  const r = new Reader(createReadStream(srcFile).pipe(createGunzip()));
  if ((await r.line()) !== 'VSWS1') throw bad('This is not a VierStation workspace export (.vsws).');
  const man = JSON.parse((await r.line()) ?? '{}'); if (man.app !== 'VierStation') throw bad('This is not a VierStation workspace export.');
  let sawDb = false;
  for (;;) {
    const l = await r.line(); if (l === null) throw bad('The export file ends unexpectedly.');
    const h = JSON.parse(l); if (h.end) break;
    const name = String(h.n); if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw bad('The export file contains an unsafe path.');
    const dest = join(stageDir, name); mkdirSync(dirname(dest), { recursive: true });
    const ws = createWriteStream(dest);
    await r.bytes(Number(h.s), (b) => { ws.write(b); });
    ws.end(); await once(ws, 'close');
    if (name === 'db.sqlite') sawDb = true;
  }
  if (!sawDb) throw bad('The export file contains no database.');
  return { db: join(stageDir, 'db.sqlite'), dirs: stageDir };
}
export const stagingDir = () => join(config.dataDir, `.import-${stamp()}`);
export { pipeline, renameSync, writeFileSync, basename };
