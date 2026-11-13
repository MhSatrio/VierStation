// Offline-first network state. VierStation always works from the LOCAL database; the internet is only needed to fetch or refresh scientific data.
//   mode 'auto'    – use the internet when it is there; a failed probe marks the app offline and external jobs wait in the queue until a probe succeeds
//   mode 'offline' – the user chose to work offline: no outbound request is made at all
// Requests that need the internet while offline are never dropped silently: cached answers are served (even stale ones), jobs wait ("queued, waiting for a
// connection"), and anything else fails with an OfflineError that says so.
import { q } from './db.ts';
import { config } from './config.ts';
import { now } from './util.ts';
import { publishToUser } from './events.ts';
import { localUser } from './local.ts';

export class OfflineError extends Error {
  code = 'offline';
  constructor(what = 'This') { super(`${what} needs an internet connection, and VierStation is working offline. It is available from the local cache only if it was fetched before.`); }
}

type Mode = 'auto' | 'offline';
const st: { mode: Mode; online: boolean | null; checkedAt: string | null; lastError: string | null } = { mode: 'auto', online: null, checkedAt: null, lastError: null };
const listeners: (() => void)[] = [];
let timer: NodeJS.Timeout | null = null;
let probeFn: () => Promise<boolean> = defaultProbe;

export function loadNetworkSettings() {
  const m = q.get<{ value: string }>("SELECT value FROM meta WHERE key='setting:network_mode'")?.value;
  st.mode = m === 'offline' || (config.offline && process.env.VIERSTATION_TEST !== '1') ? 'offline' : 'auto'; // VIERSTATION_OFFLINE=1 starts the app in "work offline" mode
  const mail = q.get<{ value: string }>("SELECT value FROM meta WHERE key='setting:contact_email'")?.value;
  if (mail) config.contactEmail = mail;
}
export function setMode(mode: Mode) {
  st.mode = mode;
  q.run("INSERT INTO meta(key,value) VALUES('setting:network_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", mode);
  if (mode === 'auto') { st.online = null; void probe(); } else changed();
}
/** True when no outbound request should be attempted. */
export function isOffline(): boolean { return st.mode === 'offline' || st.online === false; }
export function networkStatus() {
  const queued = q.get<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE status='queued'")?.n ?? 0;
  return { mode: st.mode, online: st.mode === 'offline' ? false : st.online !== false, offline: isOffline(), checkedAt: st.checkedAt, lastError: st.lastError, waitingJobs: queued };
}
export const onNetworkRestored = (fn: () => void) => { listeners.push(fn); };
function changed() { try { publishToUser(localUser().id, 'network.changed', networkStatus()); } catch { /* no clients */ } }

async function defaultProbe(): Promise<boolean> {
  for (const url of ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json', 'https://rest.uniprot.org/']) {
    try { const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }); if (r.status > 0) return true; } catch { /* try the next one */ }
  }
  return false;
}
export const setProbe = (f: (() => Promise<boolean>) | null) => { probeFn = f ?? defaultProbe; };

/** Ask whether the internet is reachable (two small requests; never more than one probe at a time). */
let probing: Promise<boolean> | null = null;
export function probe(): Promise<boolean> {
  if (st.mode === 'offline' || (config.offline && process.env.VIERSTATION_TEST === '1')) return Promise.resolve(false);
  probing ??= (async () => {
    const was = st.online;
    let ok = false;
    try { ok = await probeFn(); } catch (e) { st.lastError = (e as Error).message; }
    st.online = ok; st.checkedAt = now(); if (ok) st.lastError = null;
    if (ok && was === false) for (const l of listeners) { try { l(); } catch { /* ignore */ } }
    if (was !== ok) changed();
    schedule();
    return ok;
  })().finally(() => { probing = null; });
  return probing;
}
/** A request failed in a way that looks like "no connection": check, and keep checking until it is back. */
export function suspectOffline() { if (st.online !== false && st.mode === 'auto') void probe(); }
function schedule() {
  if (timer) clearTimeout(timer);
  if (st.mode !== 'auto') return;
  timer = setTimeout(() => { void probe(); }, st.online === false ? 15_000 : 5 * 60_000);
  timer.unref?.();
}
export function startNetworkMonitor() { loadNetworkSettings(); if (!(config.offline && process.env.VIERSTATION_TEST === '1')) void probe(); }
export function stopNetworkMonitor() { if (timer) clearTimeout(timer); timer = null; }
