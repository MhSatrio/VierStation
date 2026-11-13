// Load the example metabolic network (a glycolysis-style slice: chemicals, enzymes, reactions, two pathways, relationships with mixed evidence) into a RUNNING VierStation
// so you can try the Explorer. The records are illustrative, not curated database content, and are clearly named “(example)” where they could be mistaken for a reference.
//   npm start            (in one terminal)
//   npm run seed:example (in another)   [-- --url http://127.0.0.1:8787 --project <project id>]
// Running it twice does not duplicate anything (records are found by name; existing relationships are skipped).
import { GLYCOLYSIS_EXAMPLE, loadNetwork } from '../tests/fixtures/example-network.ts';

const args = process.argv.slice(2); const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt('url') ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
const api = {
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'x-vs': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, json, text };
  },
  get(p: string) { return this.req('GET', p); }, post(p: string, b: unknown = {}) { return this.req('POST', p, b); },
};
try {
  const st = await api.get('/api/app/state'); if (st.status !== 200) throw new Error(`Cannot reach VierStation at ${base} (start it with “npm start”).`);
  const ws = st.json.workspaces[0].id; const projects = (await api.get(`/api/workspaces/${ws}/projects`)).json.projects as { id: string; name: string }[];
  const project = opt('project') ?? projects[0]?.id; if (!project) throw new Error('This workspace has no project yet.');
  console.log(`Loading the example network into project “${projects.find((p) => p.id === project)?.name ?? project}” at ${base} …`);
  const out = await loadNetwork(api as never, project, GLYCOLYSIS_EXAMPLE, ws);
  console.log(`Done: ${Object.keys(out.ids).length} records, ${Object.keys(out.reactions).length} reactions, ${Object.keys(out.pathways).length} pathways. Open ${base}/explorer`);
} catch (e) { console.error((e as Error).message); process.exit(1); }
