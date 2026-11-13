// Generates the figures of the statistics case study in the documentation (illustrative, SEEDED data – not measurements) by driving the real app.
// Run: node --disable-warning=ExperimentalWarning tests/e2e/docs-case.ts   → tests/e2e/out/doc-*.png + doc-case.json (the numbers the app computed)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, register, start } from './harness.ts';
import { mulberry32 } from '../../server/phylo/run.ts';

const h = await start();
try {
  const { page } = await h.open({ width: 1360, height: 900 });
  await register(page, h.srv.base);
  const base = h.srv.base;
  const api = async (method: string, path: string, data?: unknown) => { const r = await page.request.fetch(base + path, { method, headers: { 'x-vs': '1', 'content-type': 'application/json' }, data: data === undefined ? undefined : JSON.stringify(data) }); return r.json(); };
  const me = await api('GET', '/api/app/state'); const ws = me.workspaces[0].id;
  const projectId = (await api('GET', `/api/workspaces/${ws}/projects`)).projects[0].id;
  const t = (await api('POST', `/api/projects/${projectId}/tables`, { name: 'Cell line assays (illustrative)' })).table;
  const fld = async (name: string, type: string, options?: unknown) => (await api('POST', `/api/tables/${t.id}/fields`, { name, type, options })).field.id as string;
  let meta = await api('GET', `/api/tables/${t.id}`);
  const nameId = meta.fields.find((f: any) => f.type === 'text')?.id as string;
  const fExpr = await fld('Gene X expression (log2 TPM)', 'number', { precision: 2 });
  const fA = await fld('Drug A IC50 (µM)', 'number', { precision: 2 });
  const fB = await fld('Drug B IC50 (µM)', 'number', { precision: 2 });
  const fD = await fld('Doubling time (h)', 'number', { precision: 1 });
  const fS = await fld('Subtype', 'singleSelect', { choices: [{ name: 'Epithelial', color: 'blue' }, { name: 'Mesenchymal', color: 'amber' }] });
  // illustrative generator: Drug A sensitivity falls as Gene X rises; Drug B is unrelated; doubling time follows Drug B a little
  const rnd = mulberry32(42); const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const rows = Array.from({ length: 16 }, (_, i) => {
    const mes = i % 2 === 1, expr = 5.2 + (mes ? 1.6 : 0) + 0.9 * gauss();
    const a = Math.exp(1.2 - 0.55 * expr + 0.25 * gauss()) * 3, b = Math.exp(0.4 + 0.5 * gauss()) * 2, d = 24 + 1.8 * Math.log(b) + 2.5 * gauss();
    return { [nameId]: `CL-${String(i + 1).padStart(2, '0')}`, [fExpr]: +expr.toFixed(2), [fA]: +a.toFixed(2), [fB]: +b.toFixed(2), [fD]: +d.toFixed(1), [fS]: mes ? 'Mesenchymal' : 'Epithelial' };
  });
  await api('POST', `/api/tables/${t.id}/records`, { records: rows, createChoices: true });
  await page.goto(`${base}/t/${t.id}`); await page.locator('.grid, [role=grid], table').first().waitFor();
  await page.waitForTimeout(600); await page.screenshot({ path: join(OUT, 'doc-stats-table.png') });

  const out: Record<string, unknown> = {};
  const runAnalysis = async (type: string, shot: string, tweak?: () => Promise<void>, key = type) => {
    await page.goto(`${base}/analysis`);
    await page.getByLabel('Analysis type').selectOption(type);
    await page.getByLabel('Records from').selectOption({ label: 'Cell line assays (illustrative)' }).catch(async () => { await page.getByLabel('Records from').selectOption(t.id); });
    await tweak?.();
    await page.getByRole('button', { name: /Run analysis/ }).click();
    await page.waitForURL(/\/analysis\/ana_/, { timeout: 30_000 });
    await page.getByText(/completed/).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, shot), fullPage: true });
    const id = page.url().split('/').pop()!;
    out[key] = (await api('GET', `/api/analysis/${id}`)).analysis.result;
    out[`${key}_id`] = id;
  };
  await runAnalysis('statistics', 'doc-stats-result.png');
  await runAnalysis('statistics', 'doc-stats-groups.png', async () => { await page.getByLabel('Compare two groups by').selectOption({ label: 'Subtype' }); await page.getByLabel('Correlation').selectOption('spearman').catch(() => {}); }, 'statistics_groups');
  await runAnalysis('heatmap', 'doc-stats-heatmap.png');
  await runAnalysis('pca', 'doc-stats-pca.png');
  writeFileSync(join(OUT, 'doc-case.json'), JSON.stringify({ rows, out }, null, 1));
  console.log('ok');
} finally { await h.close(); }
