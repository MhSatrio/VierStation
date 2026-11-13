import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { openDb, q } from './db.ts';
import { SECURITY_HEADERS, dispatch, route } from './http.ts';
import { clientCount } from './events.ts';
import { runningCount, startJobs, stopJobs } from './jobs.ts';
import { startAutomations, stopAutomations } from './automations.ts';
import './routes/app.ts';
import './routes/local.ts';
import './routes/graph.ts';
import { ensureLocalIdentity } from './local.ts';
import { upgradeTemplateFields } from './templates.ts';
import { startAutoBackup, stopAutoBackup } from './archive.ts';
import { APP_VERSION } from '../shared/app.ts';
import { startNetworkMonitor, stopNetworkMonitor } from './network.ts';
import './routes/core.ts';
import './routes/records.ts';
import './routes/science.ts';
import './routes/ops.ts';
import './routes/lab.ts';
import './routes/geo.ts';
import './seqlab/pipeline.ts';
import './seqlab/actions.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);
const staticCache = new Map<string, { raw: Buffer; br?: Buffer; gz?: Buffer; mtime: number }>();

route('GET', '/api/health', () => ({ ok: true, version: APP_VERSION, uptimeS: Math.round(process.uptime()), jobsRunning: runningCount(), sseClients: clientCount(), users: q.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n }), { auth: false });

function serveStatic(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = normalize(join(config.distDir, rel));
  if (!file.startsWith(config.distDir + sep) && file !== config.distDir) { res.writeHead(403).end('Forbidden'); return; }
  const isAsset = rel.startsWith('/assets/');
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (isAsset || extname(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    file = join(config.distDir, 'index.html'); // SPA fallback
    if (!existsSync(file)) { res.writeHead(503, { 'Content-Type': 'text/plain' }).end('The web app has not been built yet. Run "npm run build".'); return; }
  }
  const mtime = statSync(file).mtimeMs;
  let ent = staticCache.get(file);
  if (!ent || ent.mtime !== mtime) { ent = { raw: readFileSync(file), mtime }; staticCache.set(file, ent); }
  const ext = extname(file);
  const ae = String(req.headers['accept-encoding'] ?? '');
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream', ...SECURITY_HEADERS,
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=86400', Vary: 'Accept-Encoding',
  };
  let body = ent.raw;
  if (COMPRESSIBLE.has(ext) && body.length > 512) {
    if (/\bbr\b/.test(ae)) { ent.br ??= brotliCompressSync(ent.raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }); body = ent.br; headers['Content-Encoding'] = 'br'; }
    else if (/\bgzip\b/.test(ae)) { ent.gz ??= gzipSync(ent.raw, { level: 9 }); body = ent.gz; headers['Content-Encoding'] = 'gzip'; }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function startServer(o: { port?: number; host?: string } = {}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  openDb();
  startAutoBackup(); ensureLocalIdentity(); try { upgradeTemplateFields(); } catch (e) { console.warn('Could not add the new template columns to existing tables:', (e as Error).message); }
  startNetworkMonitor();
  startJobs();
  startAutomations();
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!req.url?.startsWith('/api/files/')) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (await dispatch(req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      console.error('[server]', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });
  server.requestTimeout = 0; // SSE and long uploads; per-request body limits are enforced in dispatch
  server.headersTimeout = 20_000;
  return new Promise((resolve) => {
    server.listen(o.port ?? config.port, o.host ?? config.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      resolve({
        server, port,
        close: () => new Promise<void>((r) => { stopJobs(); stopAutomations(); stopNetworkMonitor(); server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { port } = await startServer();
  console.log(`VierStation listening on http://${config.host}:${port}  (data: ${config.dataDir})`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.warn('WARNING: VierStation has no login. It is listening on a network address (' + config.host + '): anyone who can reach this port can read and change your data. Publish the port to localhost only (for example docker run -p 127.0.0.1:8787:8787) or put your own authentication proxy in front.');
  const bye = () => { console.log('Shutting down…'); stopJobs(); stopAutomations(); stopNetworkMonitor(); stopAutoBackup(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
