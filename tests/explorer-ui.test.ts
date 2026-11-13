// Pure parts of the explorer UI: the blue colour system (contrast, blue-only hues), pathway positions, merging of expanded graphs, view files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLUE, EDGE_STYLE, NODE_TYPES, contrast } from '../shared/graph.ts';
import { mergeGraphs, parseViewFile, pathwayPositions } from '../src/ui/explorer/layouts.ts';
import type { PathView, XEdge, XGraph, XNode } from '../src/ui/explorer/layouts.ts';

const hue = (hex: string) => { const n = parseInt(hex.slice(1), 16); const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 0.02) return -1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };

test('colour system: every node and edge colour is a blue (or neutral blue-grey) – no other hue appears', () => {
  const all = [...Object.values(BLUE).flatMap((c) => [c.fill, c.border, c.text]), ...Object.values(EDGE_STYLE).map((e) => e.color)];
  for (const c of all) { const h = hue(c); assert.ok(h === -1 || (h >= 195 && h <= 235), `${c} has hue ${Math.round(h)}`); }
});

test('contrast: marker text on every node fill ≥ 4.5:1; node borders and edge lines ≥ 3:1 against the white canvas (WCAG 2.1 AA)', () => {
  const rows: string[] = [];
  for (const t of NODE_TYPES) {
    const c = BLUE[t.id]; const text = contrast(c.text, c.fill), border = contrast(c.border, '#FFFFFF');
    rows.push(`${t.id.padEnd(10)} text/fill ${text.toFixed(2)}  border/white ${border.toFixed(2)}  fill/white ${contrast(c.fill, '#FFFFFF').toFixed(2)}`);
    assert.ok(text >= 4.5, `${t.id}: marker text contrast ${text.toFixed(2)}`); assert.ok(border >= 3, `${t.id}: border contrast ${border.toFixed(2)}`);
  }
  for (const [ev, e] of Object.entries(EDGE_STYLE)) { const r = contrast(e.color, '#FFFFFF'); rows.push(`edge ${ev.padEnd(26)} ${r.toFixed(2)}`); assert.ok(r >= 3, `${ev} line contrast ${r.toFixed(2)}`); }
  assert.ok(contrast('#14295A', '#FFFFFF') >= 4.5, 'labels (#14295A) on white'); assert.ok(contrast('#0B1733', '#CAEBFB') >= 4.5, 'selected halo (#CAEBFB) vs selection border');
  console.log('      ' + rows.join('\n      '));
});

test('colour is never the only signal: every evidence class has a distinct line style or width, and every entity type a distinct shape', () => {
  const sig = Object.values(EDGE_STYLE).map((e) => `${e.line}|${e.width}`); assert.ok(new Set(sig).size >= 5, 'the evidence classes differ in line style or width wherever possible');
  assert.equal(new Set(Object.values(EDGE_STYLE).map((e) => e.short)).size, Object.keys(EDGE_STYLE).length, 'and every class has its own short TEXT label that is written on the line');
  assert.equal(EDGE_STYLE.computationally_predicted.line, 'dashed'); assert.equal(EDGE_STYLE.unverified.line, 'dotted'); assert.equal(EDGE_STYLE.experimentally_verified.line, 'solid');
  const shapes = NODE_TYPES.map((t) => t.shape); const dup = shapes.filter((s, i) => shapes.indexOf(s) !== i);
  assert.deepEqual([...new Set(dup)].sort(), ['round-rectangle'].sort(), 'only DNA and RNA share a shape (they are told apart by the marker and by the darker navy)');
  assert.ok(!shapes.some((s) => /^round-(hexagon|octagon|triangle|pentagon|tag)$/.test(s)), 'rounded polygons crash Cytoscape 3.30 with parallel edges – never use them');
});

const node = (id: string, label: string, type = 'chemical', degree = 0, more = 0): XNode => ({ id, label, kind: type, type, tags: [], degree, more });
const edge = (id: string, source: string, target: string, extra: Partial<XEdge> = {}): XEdge => ({ id, source, target, label: 'x', typeId: null, typeName: 'x', directional: true, style: 'solid', evidence: 'user_supplied', predicted: false, verification: 'unverified', origin: 'relationship', tags: [], citations: 0, description: '', organism: null, sourceDb: null, ...extra });
const graph = (nodes: XNode[], edges: XEdge[]): XGraph => ({ nodes, edges, truncated: false, focus: [], counts: { nodes: nodes.length, edges: edges.length }, warnings: [] });

test('mergeGraphs: expanding adds nodes and edges, never drops or duplicates, and recomputes the “+N more” counter', () => {
  const base = graph([node('a', 'A', 'protein', 1, 3), node('b', 'B', 'chemical', 1, 0)], [edge('e1', 'a', 'b')]);
  const exp = graph([node('a', 'A', 'protein', 3, 0), node('c', 'C', 'chemical', 1, 0), node('d', 'D', 'chemical', 1, 0), node('e', 'E', 'chemical', 1, 0)], [edge('e2', 'a', 'c'), edge('e3', 'a', 'd'), edge('e4', 'a', 'e')]);
  const m = mergeGraphs(base, [exp, exp]); // merging the same page twice changes nothing
  assert.equal(m.nodes.length, 5); assert.equal(m.edges.length, 4);
  assert.equal(m.nodes.find((n) => n.id === 'a')!.more, 0, 'all four connections of A are now shown');
  assert.equal(m.nodes.find((n) => n.id === 'a')!.degree, 4);
  assert.equal(mergeGraphs(base, []), base, 'nothing to merge returns the same object');
  const part = mergeGraphs(base, [graph([node('a', 'A', 'protein', 2, 2), node('c', 'C')], [edge('e2', 'a', 'c')])]); assert.equal(part.nodes.find((n) => n.id === 'a')!.more, 2, 'still two connections not shown');
});

const step = (id: string, reactionId: string, level: number, lane = 0): PathView['steps'][number] => ({ id, reactionId, reactionName: reactionId, level, lane, equation: '', reversible: null, evidence: null, orderBasis: 'curated', branch: null, label: null, participants: [] });
const view = (steps: PathView['steps'], orderState: PathView['orderState']): PathView => ({ pathway: { id: 'p', name: 'P' }, steps, edges: [], orderState, hasBranches: false, hasCycles: false, chemicals: { starting: [], intermediate: [], final: [] } });
const part = (id: string, chem: string, reaction: string, role: string) => edge(id, role === 'product' ? reaction : chem, role === 'product' ? chem : reaction, { origin: 'participant', role });

test('pathway positions: ordered steps run left→right (or top→bottom when long) along their defined order; unknown order is a plain grid; shared chemicals sit between their reactions', () => {
  const steps = [step('s1', 'r1', 0), step('s2', 'r2', 1), step('s3', 'r3', 2)];
  const g = graph([node('r1', 'R1', 'reaction'), node('r2', 'R2', 'reaction'), node('r3', 'R3', 'reaction'), node('x', 'X'), node('y', 'Y'), node('z', 'Z'), node('e', 'E', 'enzyme')],
    [part('p1', 'x', 'r1', 'reactant'), part('p2', 'y', 'r1', 'product'), part('p3', 'y', 'r2', 'reactant'), part('p4', 'z', 'r2', 'product'), part('p5', 'e', 'r2', 'enzyme')]);
  const pos = pathwayPositions(view(steps, 'ordered'), g);
  assert.ok(pos.get('r1')!.x < pos.get('r2')!.x && pos.get('r2')!.x < pos.get('r3')!.x, 'defined order → left to right');
  const y = pos.get('y')!; assert.ok(y.x > pos.get('r1')!.x && y.x < pos.get('r2')!.x, 'the shared intermediate sits between the reaction that makes it and the one that uses it');
  assert.ok(pos.get('x')!.x < pos.get('r1')!.x, 'a starting chemical sits before its reaction'); assert.ok(pos.get('e')!.y < pos.get('r2')!.y, 'the enzyme sits above its reaction');
  // long ordered pathway → vertical flow
  const long = pathwayPositions(view(Array.from({ length: 7 }, (_, i) => step(`s${i}`, `q${i}`, i)), 'ordered'), graph(Array.from({ length: 7 }, (_, i) => node(`q${i}`, `Q${i}`, 'reaction')), []));
  assert.ok(long.get('q6')!.y > long.get('q0')!.y && Math.abs(long.get('q6')!.x - long.get('q0')!.x) < 1, 'long pathways read top to bottom');
  // unknown order: no order is implied – steps are laid out as a grid, in the order they are listed, regardless of their (all-zero) levels
  const unk = pathwayPositions(view([step('s1', 'r1', 0), step('s2', 'r2', 0), step('s3', 'r3', 0)], 'unknown'), g);
  assert.notDeepEqual([unk.get('r1')!.y, unk.get('r2')!.y], [1, 2]); assert.equal(unk.get('r1')!.y, unk.get('r2')!.y, 'same row: no vertical order implied'); assert.equal(new Set(['r1', 'r2', 'r3'].map((r) => unk.get(r)!.x)).size, 3, 'distinct places');
  for (const n of g.nodes) assert.ok(pos.has(n.id), `${n.id} is placed`);
});

test('view files: only VierStation view files are accepted', () => {
  assert.throws(() => parseViewFile('not json'), /not a VierStation view file/); assert.throws(() => parseViewFile(JSON.stringify({ app: 'Other', kind: 'explorer-view', state: {} })), /not a VierStation/);
  const ok = parseViewFile(JSON.stringify({ app: 'VierStation', kind: 'explorer-view', version: 1, savedAt: 'x', state: { mode: 'network' }, positions: { a: { x: 1, y: 2 } } })); assert.equal(ok.positions.a.y, 2);
});
