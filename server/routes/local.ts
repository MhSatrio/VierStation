// Local data management and network settings: nothing here needs an account.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { route, str, oneOf } from '../http.ts';
import { q } from '../db.ts';
import { config } from '../config.ts';
import { bad, notFound, HttpError } from '../util.ts';
import { purgeCache } from '../integrations/http.ts';
import { networkStatus, probe, setMode } from '../network.ts';
import { audit } from '../audit.ts';
import { backupDir, backupNow, dirBytes, exportWorkspace, listBackups, stagingDir, swapIn, unpackWorkspace } from '../archive.ts';
import { APP_VERSION } from '../../shared/app.ts';

// ---- network
route('GET', '/api/network', () => networkStatus());
route('POST', '/api/network', async (c) => {
  if (c.body.mode !== undefined) setMode(oneOf(c.body.mode, ['auto', 'offline'] as const, 'mode'));
  if (c.body.check === true) await probe();
  return networkStatus();
});

// ---- small settings kept in the local database
route('GET', '/api/local/settings', () => ({ contactEmail: q.get<{ value: string }>("SELECT value FROM meta WHERE key='setting:contact_email'")?.value ?? config.contactEmail }));
route('PUT', '/api/local/settings', (c) => {
  if (c.body.contactEmail !== undefined) {
    const v = str(c.body.contactEmail, 'E-mail', { max: 200, optional: true });
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw bad('Enter a valid e-mail address (or leave it empty).');
    q.run("INSERT INTO meta(key,value) VALUES('setting:contact_email',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", v);
    config.contactEmail = v;
  }
  return { ok: true };
});

// ---- facts about the local data
route('GET', '/api/local/info', (c) => {
  const cache = q.get<{ n: number; bytes: number | null }>('SELECT COUNT(*) n, SUM(length(body)) bytes FROM http_cache')!;
  const fileSize = (f: string) => (existsSync(f) ? statSync(f).size : 0);
  return {
    dataDir: config.dataDir, dbFile: config.dbFile,
    bytes: { database: fileSize(config.dbFile) + fileSize(config.dbFile + '-wal'), files: dirBytes(join(config.dataDir, 'files')), images: dirBytes(join(config.dataDir, 'images')), structures: dirBytes(join(config.dataDir, 'structures')), backups: dirBytes(backupDir()), responseCache: cache.bytes ?? 0 },
    responseCache: { entries: cache.n }, records: q.get<{ n: number }>('SELECT COUNT(*) n FROM records')!.n, relationships: q.get<{ n: number }>('SELECT COUNT(*) n FROM relationships')!.n,
    backups: listBackups(), node: process.version, version: APP_VERSION, identity: { id: c.user!.id, note: 'There are no accounts: this local workspace identity is used only to label audit-log entries.' },
  };
});

route('POST', '/api/local/cache/clear', (c) => {
  const what = oneOf(c.body.what, ['responses', 'images'] as const, 'what');
  if (what === 'responses') purgeCache(); else { q.run('DELETE FROM image_cache'); rmSync(join(config.dataDir, 'images'), { recursive: true, force: true }); }
  audit({ userId: c.user!.id, ip: c.ip }, null, `cache.clear.${what}`, 'local', what);
  return { ok: true };
});

// ---- backups
route('POST', '/api/local/backups', (c) => { const b = backupNow('manual'); audit({ userId: c.user!.id, ip: c.ip }, null, 'backup.create', 'local', b.name); return { backup: b.name, backups: listBackups() }; });
route('GET', '/api/local/backups', () => ({ backups: listBackups() }));
const backupFile = (name: string) => { if (!/^vierstation-[a-z0-9-]+\.db$/i.test(name) || !existsSync(join(backupDir(), name))) throw notFound('Backup not found'); return join(backupDir(), name); };
route('GET', '/api/local/backups/:name/download', (c) => {
  const f = backupFile(c.params.name);
  c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(f).size, 'Content-Disposition': `attachment; filename="${c.params.name}"`, 'Cache-Control': 'no-store' });
  createReadStream(f).pipe(c.res);
});
route('DELETE', '/api/local/backups/:name', (c) => { rmSync(backupFile(c.params.name), { force: true }); return { backups: listBackups() }; });
route('POST', '/api/local/restore', (c) => {
  const r = swapIn(backupFile(str(c.body.name, 'name', { max: 200 })), null);
  return { ok: true, ...r, note: 'Restored. A safety copy of the previous data was kept in the backups list.' };
});

// ---- whole-workspace export / import (.vsws)
route('GET', '/api/local/export', async (c) => {
  const dest = join(backupDir(), `export-${Date.now()}.tmp`);
  try {
    await exportWorkspace(dest);
    const name = `vierstation-workspace-${new Date().toISOString().slice(0, 10)}.vsws`;
    c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(dest).size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    await pipeline(createReadStream(dest), c.res);
  } finally { rmSync(dest, { force: true }); }
});
route('POST', '/api/local/import', async (c) => {
  mkdirSync(backupDir(), { recursive: true });
  const tmp = join(backupDir(), `import-${Date.now()}.tmp`), stage = stagingDir();
  try {
    await pipeline(c.req, createWriteStream(tmp));
    if (!statSync(tmp).size) throw bad('No file was received.');
    const u = await unpackWorkspace(tmp, stage).catch((e) => { throw e instanceof HttpError ? e : bad('This file could not be read as a VierStation workspace export (.vsws). Nothing was changed.'); });
    const r = swapIn(u.db, u.dirs);
    audit({ userId: c.user!.id, ip: c.ip }, null, 'workspace.import', 'local', 'vsws');
    return { ok: true, ...r, note: 'Imported. Your previous data was kept as a safety backup.' };
  } finally { rmSync(tmp, { force: true }); rmSync(stage, { recursive: true, force: true }); }
}, { stream: true });
