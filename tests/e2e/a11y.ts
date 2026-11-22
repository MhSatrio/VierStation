// Accessibility scan (axe-core, WCAG 2 A and AA) of VierStation's main screens, in real Chromium.
// Every violation is printed; the test fails on any "critical" or "serious" one.
//   npm run build && node --disable-warning=ExperimentalWarning --test --test-timeout=240000 tests/e2e/a11y.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import { register, start } from './harness.ts';
import { Api } from '../helpers.ts';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let h: Awaited<ReturnType<typeof start>>; let page: Page; let api: Api; let tableId = '';
before(async () => {
  h = await start(); const o = await h.open(); page = o.page; api = new Api(h.srv.base);
  await register(page, h.srv.base);
  const st = await api.get('/api/app/state'); const ws = st.json.workspaces[0].id;
  const proj = (await api.get(`/api/workspaces/${ws}/projects`)).json.projects[0].id;
  tableId = ((await api.get(`/api/workspaces/${ws}/tables?project=${proj}`)).json.tables as { id: string }[])[0].id;
});
after(async () => { await h.close(); });

test('no critical or serious accessibility violation on the main screens', async () => {
  const screens: [string, string][] = [['overview', '/'], ['projects', '/projects'], ['databases', '/databases'], ['a table', `/t/${tableId}`], ['analysis', '/analysis'], ['sequence lab', '/lab'], ['explorer', '/explorer'], ['automations', '/automations'], ['jobs', '/jobs'], ['notifications', '/notifications'], ['settings', '/settings']];
  const found: string[] = [];
  for (const [label, path] of screens) {
    await page.goto(h.srv.base + path); await page.waitForTimeout(1500);
    await page.evaluate((src) => { if (!(window as any).axe) (0, eval)(src); }, axeSource);
    const res = await page.evaluate(async () => {
      const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, where: v.nodes.slice(0, v.id === 'color-contrast' ? 60 : 3).map((n: any) => n.target.join(' ') + (v.id === 'aria-required-children' ? ' [' + (n.any[0]?.message ?? '').slice(0, 160) + ']' : v.id === 'color-contrast' ? ' [' + (/\(foreground color: (#\w+), background color: (#\w+)/.exec(n.any[0]?.message ?? '')?.slice(1).join(' on ') ?? '') + ']' : '')).join(' | ') }));
    });
    for (const v of res) { console.log(`  [a11y] ${label}: ${v.impact} ${v.id} (${v.n}) - ${v.help} @ ${v.where}`); if (v.impact === 'critical' || v.impact === 'serious') found.push(`${label}: ${v.id}`); }
  }
  assert.deepEqual(found, [], found.join('; '));
});
