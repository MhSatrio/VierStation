// Flow view (process cards) and relationship table: two more ways to read the SAME stored records as the network.
import { useEffect, useState } from 'react';
import { get } from '../../lib/api.ts';
import { useEvent, useSession } from '../../lib/store.ts';
import { Chip, Empty, Spinner } from '../common.tsx';
import { Hint } from '../Tip.tsx';
import { EvBadge } from './Inspector.tsx';
import { ShapeGlyph } from './style.tsx';
import type { PathView } from './layouts.ts';

const ORDER_TEXT: Record<string, string> = { ordered: 'Order defined', partial: 'Order partly defined', unknown: 'Order unknown / uncertain' };
export function PathwayBanner({ v }: { v: PathView }) {
  return (
    <div className="pwbanner">
      <Hint k="xpOrderState"><Chip color={v.orderState === 'ordered' ? 'blue' : v.orderState === 'partial' ? 'amber' : 'gray'}>{ORDER_TEXT[v.orderState]}</Chip></Hint>
      {v.hasBranches && <Chip color="sky">has branches</Chip>}{v.hasCycles && <Chip color="sky">has a cycle</Chip>}
      <span className="small muted">{v.steps.length} reaction{v.steps.length === 1 ? '' : 's'}</span>
      {v.orderState === 'unknown' && <span className="small muted">The reactions are shown as an unordered set – VierStation does not guess an order from shared chemicals or tags.</span>}
      <span className="grow" />
      <Hint k="xpStartChem"><span className="small"><b>Starting</b>: {v.chemicals.starting.map((c) => c.name).join(', ') || '—'}</span></Hint>
      <Hint k="xpIntermediate"><span className="small"><b>Intermediate</b>: {v.chemicals.intermediate.map((c) => c.name).join(', ') || '—'}</span></Hint>
      <Hint k="xpFinalChem"><span className="small"><b>Final</b>: {v.chemicals.final.map((c) => c.name).join(', ') || '—'}</span></Hint>
    </div>
  );
}

export function FlowView({ pathwayId, onSelect, tick }: { pathwayId: string | null; onSelect: (id: string) => void; tick: number }) {
  const [v, setV] = useState<PathView | null>(null); const [err, setErr] = useState('');
  const load = () => { if (!pathwayId) return; get(`/api/pathways/${pathwayId}`).then((r) => { setV(r); setErr(''); }, (e) => setErr(e.message)); };
  useEffect(() => { setV(null); load(); }, [pathwayId, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('graph.changed', load, [pathwayId]);
  if (!pathwayId) return <Empty title="Choose a pathway">The flow view lays the steps of one pathway out as process cards. Pick a pathway above, or create one.</Empty>;
  if (err) return <Empty title="Could not load the pathway">{err}</Empty>;
  if (!v) return <div className="empty"><Spinner /></div>;
  const cols = new Map<number, PathView['steps']>(); for (const s of v.steps) (cols.get(v.orderState === 'unknown' ? 0 : s.level) ?? cols.set(v.orderState === 'unknown' ? 0 : s.level, []).get(v.orderState === 'unknown' ? 0 : s.level)!).push(s);
  const back = new Set(v.edges.filter((e) => e.back).map((e) => `${e.from}>${e.to}`)); // the order links connect STEP ids
  const nexts = (stepId: string) => v.edges.filter((e) => e.from === stepId).map((e) => ({ ...e, name: v.steps.find((s) => s.id === e.to)?.reactionName ?? e.to }));
  return (
    <div className="flowwrap">
      <PathwayBanner v={v} />
      <div className={`flowcols${v.orderState === 'unknown' ? ' unordered' : ''}`} role="list" aria-label={`Steps of ${v.pathway.name}`}>
        {[...cols.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, steps], ci, all) => (
          <div key={lvl} className="flowcol" role="listitem">
            {v.orderState !== 'unknown' && <div className="flowlvl">Step {ci + 1}</div>}
            {steps.map((s) => {
              const role = (r: string) => s.participants.filter((p) => p.role === r);
              return (
                <div key={s.reactionId} className="flowcard" tabIndex={0} role="button" aria-label={`Reaction ${s.reactionName}`} onClick={() => onSelect(s.reactionId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.reactionId); } }}>
                  <div className="row" style={{ gap: 6 }}><ShapeGlyph type="reaction" size={18} /><b>{s.label || s.reactionName}</b></div>
                  {s.label && <div className="muted small">{s.reactionName}</div>}
                  <div className="eq">{s.equation || '—'}</div>
                  {role('enzyme').length > 0 && <div className="small"><span className="muted">Enzyme:</span> {role('enzyme').map((p) => p.name).join(', ')}</div>}
                  {(['cofactor', 'inhibitor', 'activator', 'regulator', 'catalyst'] as const).map((r) => role(r).length > 0 && <div key={r} className="small"><span className="muted">{r[0].toUpperCase() + r.slice(1)}:</span> {role(r).map((p) => p.name).join(', ')}</div>)}
                  <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>{s.reversible && <Chip color="gray">{s.reversible}</Chip>}{s.branch && <Chip color="sky">{s.branch}</Chip>}<Chip color="gray" title="Where this step’s place in the order comes from">{s.orderBasis === 'curated' ? 'curated order' : s.orderBasis === 'user' ? 'order defined by user' : 'order unknown'}</Chip></div>
                  {s.evidence && <div style={{ marginTop: 4 }}><EvBadge ev={s.evidence.toLowerCase().replace(/ /g, '_')} /></div>}
                  {nexts(s.id).length > 0 && <div className="small muted" style={{ marginTop: 4 }}>{nexts(s.id).map((n) => `${n.kind === 'alternative' ? 'alternatively' : 'then'} → ${n.name}${back.has(`${s.id}>${n.to}`) ? ' (cycle)' : ''}`).join(' · ')}</div>}
                </div>
              );
            })}
            {ci < all.length - 1 && v.orderState !== 'unknown' && <div className="flowarrow" aria-hidden="true">➜</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- table mode
export interface TableFilters { types: string[]; evidence: string[]; tags: string[]; organism: string; source: string; verification: string }
const PAGE = 50;
export function RelTable({ filters, onSelect, tick }: { filters: TableFilters; onSelect: (r: any) => void; tick: number }) {
  const wsId = useSession((s) => s.wsId);
  const [q, setQ] = useState(''); const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: any[]; total: number } | null>(null); const [err, setErr] = useState('');
  useEffect(() => { setPage(0); }, [JSON.stringify(filters), q]);
  useEffect(() => {
    if (!wsId) return; const p = new URLSearchParams({ workspace: wsId, limit: String(PAGE), offset: String(page * PAGE) });
    if (filters.types.length) p.set('types', filters.types.join(',')); if (filters.evidence.length) p.set('evidence', filters.evidence.join(',')); if (filters.tags.length) p.set('tags', filters.tags.join(','));
    if (filters.organism) p.set('organism', filters.organism); if (filters.source) p.set('source', filters.source); if (filters.verification) p.set('verification', filters.verification); if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => get(`/api/relationships?${p}`).then((r) => { setData(r); setErr(''); }, (e) => setErr(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [wsId, page, q, JSON.stringify(filters), tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('graph.changed', () => setPage((p) => p), []);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  return (
    <div className="reltable">
      <div className="row" style={{ gap: 8, padding: '8px 12px' }}>
        <input className="input" style={{ maxWidth: 340 }} placeholder="Search relationships (record names, type, description)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search relationships" />
        <span className="muted small">{data ? `${data.total.toLocaleString()} relationship${data.total === 1 ? '' : 's'}` : ''}</span><span className="grow" />
        <button className="btn secondary sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="small">Page {page + 1} / {pages}</span><button className="btn secondary sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
      {err ? <Empty title="Could not load relationships">{err}</Empty> : !data ? <div className="empty"><Spinner /></div> : !data.rows.length ? <Empty title="No relationships match">Change the filters, or add a relation from a record or from the graph.</Empty> : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table className="tbl">
            <thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Evidence</th><th>Tags</th><th>Cites</th><th>Verification</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id} tabIndex={0} className="clickable" onClick={() => onSelect(r)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(r); }}>
                <td><ShapeGlyph type={r.sourceKind} size={14} /> {r.sourceName}</td><td><b>{r.type.name}</b>{r.directional ? ' →' : ''}</td><td><ShapeGlyph type={r.targetKind} size={14} /> {r.targetName}</td>
                <td><EvBadge ev={r.evidenceClass} /></td><td>{r.tags.map((t: string) => <Chip key={t} color="sky">{t}</Chip>)}</td><td>{r.citations.length || ''}</td><td className="small">{r.verification}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
