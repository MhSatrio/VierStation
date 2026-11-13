// One-command DNA identification run through the Sequence Lab (same code, same stored history as the app):
//   forward read (+ optional reverse read) → clean → merge → NCBI BLAST → related species → species typed by name → outgroups → alignment → tree
//   → outputs: workflow script (.py), PDF report, tree (Newick, SVG, PNG when a browser is available), alignment FASTA, Markdown change log, history JSON.
//
//   node --disable-warning=ExperimentalWarning scripts/identify.ts --forward fwd.fasta [--reverse rev.fasta] [--species "Trichoderma harzianum, Trichoderma viride"]
//        [--outgroup-species "Fusarium oxysporum"] [--out runs/my-sample] [--name sample1] [--bootstrap 200] [--method nj] [--program blastn|megablast] [--db core_nt]
//
// The run uses its OWN data folder (<out>/data) so your VierStation database is never touched. To open the finished run in the app:
//   set VIERSTATION_DATA_DIR=<out>\data  &&  npm start     (there is no login; how to open the run is saved in <out>/OPEN-THIS-RUN.txt)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, env } from 'node:process';

const args = new Map<string, string>();
for (let i = 2; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; args.set(k, v); }
const need = (k: string) => { const v = args.get(k); if (!v) { console.error(`Missing --${k}. See the header of scripts/identify.ts.`); process.exit(2); } return v; };
const out = resolve(args.get('out') ?? join('runs', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
mkdirSync(join(out, 'data'), { recursive: true });
env.VIERSTATION_DATA_DIR = join(out, 'data'); env.PORT = '0'; env.OPEN_REGISTRATION = 'true'; env.REGISTER_PER_HOUR = '1000'; env.VIERSTATION_OFFLINE = '0';
if (!env.VIERSTATION_CONTACT_EMAIL) env.VIERSTATION_CONTACT_EMAIL = '';

const { startServer } = await import('../server/index.ts');
const { config } = await import('../server/config.ts');
config.offline = false;
const srv = await startServer({ port: 0 }); const base = `http://127.0.0.1:${srv.port}`;
const api = async (method: string, path: string, body?: unknown, bin = false): Promise<any> => {
  const res = await fetch(base + path, { method, headers: { 'x-vs': '1', 'content-type': 'application/json', }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (bin) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text };
};
const log: string[] = [];
const say = (m: string) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); log.push(l); };
async function waitJob(id: string, label: string, ms = 2_400_000) {
  const t0 = Date.now(); let last = '';
  for (;;) {
    const j = (await api('GET', `/api/jobs/${id}`)).json.job;
    const msg = `${j.status}${j.message ? ` – ${j.message}` : ''}`; if (msg !== last) { last = msg; say(`${label}: ${msg}`); }
    if (['completed', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() - t0 > ms) throw new Error(`${label} timed out`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}
const must = (r: { status: number; json: any }, what: string) => { if (r.status >= 400) throw new Error(`${what}: ${r.json?.error ?? r.json?.message ?? r.status}`); return r.json; };
const list = (k: string) => (args.get(k) ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

try {
  // local mode: no account is created – the run uses the local workspace
  const reg = must(await api('GET', '/api/app/state'), 'workspace');
  const ws = reg.workspaces[0].id; const projectId = (await api('GET', `/api/workspaces/${ws}/projects`)).json.projects[0].id;
  writeFileSync(join(out, 'OPEN-THIS-RUN.txt'), `Data folder of this run: ${join(out, 'data')}

There is no login. To open this run in the app:
  set VIERSTATION_DATA_DIR=${join(out, 'data')}
  npm start
`);
  const name = args.get('name') ?? 'sample';

  // 1 import + clean
  const fwdText = readFileSync(resolve(need('forward')), 'utf8');
  const imp = must(await api('POST', '/api/lab/import', { projectId, text: fwdText.startsWith('>') ? fwdText : `>${name}_forward\n${fwdText}` }), 'import');
  let id: string = imp.recordIds[0]; const L = (p = '') => `/api/lab/${id}${p}`;
  const ov0 = (await api('GET', L())).json;
  const nCount = (s: string) => (s.match(/[^ACGT]/g) ?? []).length;
  say(`imported ${ov0.raw.length} bp forward read (${nCount(ov0.head.seq)} N/ambiguous = ${(nCount(ov0.head.seq) / ov0.head.seq.length * 100).toFixed(1)}%)`);
  const tr = (await api('POST', L('/clean'), { op: 'trim_ambiguous_ends' })).json; say(`clean: ${tr.summary}`);

  // 2 reverse read → ONE new merged record (the forward and reverse records stay unchanged); everything after this runs on the merged record
  if (args.get('reverse')) {
    const rev = readFileSync(resolve(args.get('reverse')!), 'utf8');
    const m = await api('POST', '/api/lab/merge-pair', { forwardRecordId: id, reverseText: rev.startsWith('>') ? rev : `>${name}_reverse
${rev}`, reverseName: `${name}_reverse`, orientation: args.get('orientation') ?? 'auto' });
    if (m.status >= 400) say(`MERGE REFUSED – continuing with the forward read alone: ${m.json?.error}`); else { id = m.json.recordId; say(`merge: created "${m.json.name}" – ${m.json.summary}`); say(`clean merged read: ${(await api('POST', L('/clean'), { op: 'trim_ambiguous_ends' })).json.summary}`); }
  } else say('no reverse read given – the forward read is used alone (add --reverse to merge both reads)');
  const afterClean = (await api('GET', L())).json;
  say(`working sequence: ${afterClean.head.length} bp, ${(nCount(afterClean.head.seq) / afterClean.head.seq.length * 100).toFixed(1)}% N/ambiguous`);

  // 3 BLAST
  const nFrac = nCount(afterClean.head.seq) / afterClean.head.seq.length;
  const program = args.get('program') ?? (nFrac > 0.05 ? 'blastn' : 'megablast');
  say(`BLAST (${program}, ${args.get('db') ?? 'core_nt'}) …`);
  let j = await waitJob(must(await api('POST', L('/blast'), { params: { db: args.get('db') ?? 'core_nt', program, hitlist: 100, expect: nFrac > 0.05 ? 10 : 0.05 } }), 'blast').jobId, 'BLAST');
  if (j.status !== 'completed') throw new Error(`BLAST failed: ${j.error}`);
  const hits = (await api('GET', L('/hits'))).json;
  for (const h of hits.hits.slice(0, 8)) say(`  hit: ${h.organism} ${h.accession} id ${h.identityPct}% cov ${h.coveragePct}% E=${h.evalue}`);
  if (!hits.hits.length) throw new Error('BLAST found no similarity: nothing to build a tree from.');
  const topCov = hits.hits[0].coveragePct;

  // 4 relatives from BLAST
  j = await waitJob(must(await api('POST', L('/relatives'), { params: { maxRelatives: 8, minCoverage: Math.max(10, Math.min(80, Math.floor(topCov - 5))), minIdentity: 60, maxPerGenus: 3, broaden: false } }), 'relatives').jobId, 'relatives');
  if (j.status !== 'completed') say(`relatives: ${j.error}`);

  // 5 species typed by name
  const species = list('species');
  if (species.length) { j = await waitJob(must(await api('POST', L('/species'), { names: species, role: 'ingroup', minCoverage: Math.max(10, Math.min(50, Math.floor(topCov - 5))) }), 'species').jobId, 'species by name'); if (j.status !== 'completed') say(`species: ${j.error}`); }
  const og = list('outgroup-species');
  if (og.length) { j = await waitJob(must(await api('POST', L('/species'), { names: og, role: 'outgroup', minCoverage: Math.max(10, Math.min(50, Math.floor(topCov - 5))) }), 'outgroup species').jobId, 'outgroup species by name'); if (j.status !== 'completed') say(`outgroup species: ${j.error}`); }

  // 6 outgroup assistant (when no outgroup was typed)
  let ds = (await api('GET', L('/dataset'))).json;
  if (!ds.members.some((m: any) => m.role === 'outgroup')) {
    j = await waitJob(must(await api('POST', L('/outgroups'), { params: { max: 3 } }), 'outgroups').jobId, 'outgroup assistant');
    ds = (await api('GET', L('/dataset'))).json; const a = ds.outgroupAssistant;
    if (a?.candidates?.length) { await api('POST', L('/dataset'), { action: 'add_candidates', opId: a.opId, ids: a.candidates.map((c: any) => c.id), role: 'outgroup' }); say(`accepted ${a.candidates.length} outgroup candidate(s): ${a.candidates.map((c: any) => c.organism).join(', ')}`); }
    else say(`no outgroup found: ${(a?.warnings ?? []).join(' ')}`);
    ds = (await api('GET', L('/dataset'))).json;
  }
  say(`dataset: ${ds.members.map((m: any) => `${m.role}:${m.organism}${m.accession ? ' ' + m.accession : ''} (${m.length} bp)`).join('; ')}`);

  // 7 alignment + tree
  if (ds.members.length < 4) say(`WARNING: only ${ds.members.length} sequences – a tree of fewer than 4 sequences is not informative.`);
  j = await waitJob(must(await api('POST', L('/align'), { params: { method: 'iterative' } }), 'align').jobId, 'alignment'); if (j.status !== 'completed') say(`alignment: ${j.error}`);
  const hasOut = ds.members.some((m: any) => m.role === 'outgroup');
  j = await waitJob(must(await api('POST', L('/tree'), { params: { method: args.get('method') ?? 'nj', distance: 'k2p', bootstrap: Number(args.get('bootstrap') ?? 200), rooting: hasOut ? 'outgroup' : 'midpoint' } }), 'tree').jobId, 'tree');
  const treeOk = j.status === 'completed'; if (!treeOk) say(`TREE NOT BUILT: ${j.error}`);
  const tree = treeOk ? (await api('GET', L('/tree'))).json.result : null;
  if (tree) say(`tree: ${tree.interpretation.summary}`);

  // 8 outputs
  const name0 = name.replace(/[^\w.-]+/g, '_');
  const save = (f: string, data: string | Buffer) => { writeFileSync(join(out, f), data); say(`wrote ${f}`); };
  save(`${name0}_workflow.py`, (await api('GET', L('/export/script?scope=workflow'))).json.code);
  save(`${name0}_report.pdf`, (await api('GET', L('/export/report'), undefined, true) as any).buf);
  save(`${name0}_changelog.md`, (await api('GET', L('/export/changelog'))).text);
  save(`${name0}_history.json`, (await api('GET', L('/export/history'))).text);
  if (tree) {
    save(`${name0}_tree.nwk`, (await api('GET', L('/export/newick'))).text);
    const svg = (await api('GET', L('/export/tree-svg'))).text; save(`${name0}_tree.svg`, svg);
    try { // PNG of the tree when a Chromium is installed (optional)
      const { chromium } = await import('playwright-core');
      const base2 = join(env.LOCALAPPDATA ?? '', 'ms-playwright'); const exe = ['chromium-1248', 'chromium-1234'].map((v) => join(base2, v, 'chrome-win64', 'chrome.exe')).find(existsSync);
      if (exe) { const b = await chromium.launch({ executablePath: exe, headless: true }); const pg = await b.newPage({ deviceScaleFactor: 2 }); await pg.setContent(`<body style="margin:0;background:#fff">${svg}</body>`); const el = await pg.$('svg'); save(`${name0}_tree.png`, (await el!.screenshot()) as Buffer); await b.close(); }
      else say('no Chromium found – tree PNG skipped (the SVG is the same drawing)');
    } catch (e) { say(`tree PNG skipped: ${(e as Error).message.slice(0, 120)}`); }
  }
  if (ds.members.length) save(`${name0}_dataset.fasta`, (await api('GET', L('/export/fasta?what=dataset'))).text);
  if (tree) save(`${name0}_alignment.fasta`, (await api('GET', L('/export/fasta?what=alignment'))).text);
  save(`${name0}_run.log`, log.join('\n') + '\n');
  console.log(`
DONE. Outputs in ${out}
To open this run in VierStation: see ${join(out, 'OPEN-THIS-RUN.txt')}`);
} catch (e) { console.error('\nRUN FAILED:', (e as Error).message); try { writeFileSync(join(out, 'run.log'), log.join('\n') + `\nFAILED: ${(e as Error).message}\n`); } catch { /* ignore */ } process.exitCode = 1; }
finally { await srv.close(); }
