// Optional external multiple-sequence aligners (MAFFT, MUSCLE, Clustal Omega). Used only when installed and chosen; the built-in aligner is the default.
// The adapter plumbing (detect, run, parse, verify) is tested with stand-in executables; it has NOT been run against the real programs in the authoring environment.
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cancelled, Fatal } from '../jobs.ts';

export type EngineId = 'mafft' | 'muscle' | 'clustalo';
export interface Aligner { id: EngineId; name: string; path: string; version: string }
const NAMES: Record<EngineId, string> = { mafft: 'MAFFT', muscle: 'MUSCLE', clustalo: 'Clustal Omega' };
const EXE: Record<EngineId, string> = { mafft: 'mafft', muscle: 'muscle', clustalo: 'clustalo' };

let cache: { at: number; list: Aligner[] } | null = null;
const quote = (a: string) => (/[\s&()^|<>%!]/.test(a) ? `"${a.replace(/"/g, '')}"` : a); // only used when a .cmd/.bat wrapper forces us through cmd.exe
const run = (file: string, args: string[], timeoutMs = 8000) => new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  execFile(viaShell ? quote(file) : file, viaShell ? args.map(quote) : args, { timeout: timeoutMs, windowsHide: true, shell: viaShell, maxBuffer: 4 << 20 }, (e, out, err) => resolve({ out: String(out), err: String(err), code: e ? ((e as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0 }));
});
async function which(exe: string): Promise<string | null> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [exe], 4000);
  const first = r.out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return r.code === 0 && first ? first : null;
}

/** Programs found on PATH, with their reported versions. Cached for a minute. */
export async function detectAligners(force = false): Promise<Aligner[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.list;
  const list: Aligner[] = [];
  for (const id of Object.keys(EXE) as EngineId[]) {
    const path = await which(EXE[id]); if (!path) continue;
    const v = await run(path, id === 'muscle' ? ['-version'] : ['--version']);
    const text = `${v.out}\n${v.err}`.trim().split(/\r?\n/).find((l) => /\d/.test(l)) ?? '';
    list.push({ id, name: NAMES[id], path, version: text.slice(0, 80) || 'unknown version' });
  }
  cache = { at: Date.now(), list };
  return list;
}

function fastaToRows(text: string, ids: string[]): string[] {
  const map = new Map<string, string>(); let cur = '';
  for (const line of text.split(/\r?\n/)) { if (line.startsWith('>')) { cur = line.slice(1).trim().split(/\s+/)[0]; map.set(cur, ''); } else if (cur) map.set(cur, (map.get(cur) ?? '') + line.trim()); }
  return ids.map((id) => { const r = map.get(id); if (r === undefined) throw new Fatal(`The aligner output has no sequence "${id}".`); return r.toUpperCase().replace(/\./g, '-'); });
}

/** Run an external aligner. Sequences are sent under neutral ids (s0, s1, …) and mapped back, and the result is verified: residues must be unchanged. */
export async function runExternal(a: Aligner, seqs: string[], o: { signal?: AbortSignal; threads?: number; timeoutMs?: number } = {}): Promise<{ rows: string[]; command: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'vs-aln-'));
  const inp = join(dir, 'in.fa'), outp = join(dir, 'out.fa'), ids = seqs.map((_, i) => `s${i}`);
  writeFileSync(inp, seqs.map((s, i) => `>${ids[i]}\n${s}\n`).join(''));
  const th = String(Math.max(1, Math.min(o.threads ?? 2, 8)));
  const isV3 = a.id === 'muscle' && /\bv?3\./.test(a.version);
  const args = a.id === 'mafft' ? ['--auto', '--quiet', '--thread', th, inp] : a.id === 'muscle' ? (isV3 ? ['-in', inp, '-out', outp, '-quiet'] : ['-align', inp, '-output', outp, '-threads', th]) : ['-i', inp, '-o', outp, '--force', '--outfmt=fasta', `--threads=${th}`];
  const command = `${EXE[a.id]} ${args.map((x) => (x === inp ? 'in.fasta' : x === outp ? 'out.fasta' : x)).join(' ')}${a.id === 'mafft' ? ' > out.fasta' : ''}`;
  try {
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(a.path);
    const child = spawn(viaShell ? quote(a.path) : a.path, viaShell ? args.map(quote) : args, { shell: viaShell, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < 64 << 20) stdout += d; }); child.stderr.on('data', (d) => { if (stderr.length < 1 << 20) stderr += d; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Fatal(`${a.name} did not finish within ${Math.round((o.timeoutMs ?? 600_000) / 60000)} minutes.`)); }, o.timeoutMs ?? 600_000);
      const abort = () => { child.kill(); clearTimeout(timer); reject(new Cancelled()); };
      if (o.signal?.aborted) abort(); else o.signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (e) => { clearTimeout(timer); reject(new Fatal(`Could not start ${a.name}: ${e.message}`)); });
      child.once('close', (c) => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); resolve(c); });
    });
    if (code !== 0) throw new Fatal(`${a.name} exited with code ${code}: ${stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)}`);
    const text = a.id === 'mafft' ? stdout : readFileSync(outp, 'utf8');
    const rows = fastaToRows(text, ids);
    if (new Set(rows.map((r) => r.length)).size !== 1) throw new Fatal(`${a.name} returned sequences of unequal length.`);
    rows.forEach((r, i) => { if (r.replace(/-/g, '') !== seqs[i].toUpperCase()) throw new Fatal(`${a.name} changed the residues of sequence ${i + 1}; its output was rejected.`); });
    return { rows, command };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
