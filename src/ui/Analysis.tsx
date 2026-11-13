import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from '../lib/api.ts';
import { Link, navigate, useQueryParam } from '../lib/router.tsx';
import { loadTable, toast, useEvent, useSession } from '../lib/store.ts';
import type { TableDetail } from '../lib/store.ts';
import { Chip, Empty, Modal, Spinner, StatusChip, ago, copyText, fmtDate } from './common.tsx';
import { Icon } from './icons.tsx';
import { JobLine } from './RecordPanel.tsx';
import { AlignmentView, HeatMap, PairwiseView, PcaPlot, TreeView } from './Charts.tsx';
import { Lbl } from './Tip.tsx';

interface AType { type: string; label: string; needs: 'sequences' | 'matrix'; description: string }
interface Row { id: string; name: string; type: string; status: string; createdAt: string; jobId: string | null }

export function Analysis({ id }: { id?: string }) {
  const { wsId, projectId } = useSession((s) => ({ wsId: s.wsId, projectId: s.projectId }));
  const [list, setList] = useState<Row[]>([]);
  const load = useCallback(() => { if (wsId) get(`/api/workspaces/${wsId}/analyses${projectId ? `?project=${projectId}` : ''}`).then((r) => setList(r.analyses), () => {}); }, [wsId, projectId]);
  useEffect(load, [load]);
  useEvent('job.changed', (e) => { if (e.status === 'completed' || e.status === 'failed') load(); }, [load]);
  return (
    <div className="page" style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '0 0 330px', maxWidth: '100%' }}>
        <h1>Analysis</h1>
        <p className="lead" style={{ margin: '0 0 12px' }}>Alignments, comparisons, trees, heatmaps, PCA and statistics on your records – saved with their parameters and exportable as Python, R or Julia.</p>
        <NewAnalysis onStarted={load} />
        <h3 style={{ margin: '18px 0 6px' }}>Saved analyses</h3>
        <div className="panel">{list.length === 0 ? <div className="pb muted small">Nothing yet.</div> : list.map((a) => (
          <Link key={a.id} to={`/analysis/${a.id}`} className="linkrow" style={{ color: 'inherit', textDecoration: 'none', background: a.id === id ? 'var(--sky)' : undefined, borderBottom: '1px solid var(--line)' }}>
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b>{a.name}</b><div className="small muted">{a.type} · {ago(a.createdAt)}</div></span><StatusChip status={a.status} />
          </Link>
        ))}</div>
      </div>
      <div style={{ flex: '1 1 520px', minWidth: 0 }}>{id ? <Result id={id} /> : <Empty title="Run an analysis to see results here">Choose a type and the records to analyse on the left. Select rows in any grid and press <b>Analyse…</b> to start from a selection.</Empty>}</div>
    </div>
  );
}

function NewAnalysis({ onStarted }: { onStarted: () => void }) {
  const { projectId, tables } = useSession((s) => ({ projectId: s.projectId, tables: s.tables }));
  const mine = tables.filter((t) => t.projectId === projectId);
  const qTable = useQueryParam('table'); const useSel = useQueryParam('selection') === '1';
  const [types, setTypes] = useState<AType[]>([]);
  const [type, setType] = useState('alignment');
  const [tableId, setTableId] = useState(qTable ?? '');
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [params, setParams] = useState<Record<string, any>>({});
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/api/analysis/types').then((r) => setTypes(r.types)); }, []);
  useEffect(() => { if (useSel) { try { setIds(JSON.parse(sessionStorage.getItem('vs.analysisIds') ?? 'null')); } catch { setIds(null); } } }, [useSel]);
  const needs = types.find((t) => t.type === type)?.needs ?? 'sequences';
  const candidates = useMemo(() => mine.filter((t) => t.kind !== 'task'), [mine]);
  useEffect(() => { if (!tableId) { const pref = candidates.find((t) => (needs === 'sequences' ? ['dna', 'protein'].includes(t.kind) : ['custom', 'chemical', 'protein'].includes(t.kind))); if (pref) setTableId(pref.id); } }, [needs, candidates, tableId]);
  useEffect(() => { if (tableId) loadTable(tableId).then(setDetail, () => setDetail(null)); else setDetail(null); }, [tableId]);
  useEffect(() => { setParams({}); setFieldIds([]); }, [type, tableId]);
  const seqFields = detail?.fields.filter((f) => f.type === 'sequence') ?? [];
  const numFields = detail?.fields.filter((f) => ['number', 'rollup', 'formula'].includes(f.type)) ?? [];
  const groupFields = detail?.fields.filter((f) => ['singleSelect', 'status', 'text'].includes(f.type)) ?? [];
  const P = (k: string, v: unknown) => setParams((p) => ({ ...p, [k]: v }));
  const ok = !!tableId && (needs === 'sequences' ? seqFields.length > 0 : numFields.length > 0);
  const start = async () => {
    setBusy(true);
    try {
      const r = await post('/api/analysis', { type, tableId, recordIds: ids ?? undefined, name: name.trim() || undefined, params: { ...params, ...(needs === 'matrix' && fieldIds.length ? { fieldIds } : {}) } });
      setJob(r.jobId); toast('Analysis started', 'info');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  useEvent('job.changed', async (e) => {
    if (e.jobId !== job || e.status !== 'completed') return;
    const j = (await get(`/api/jobs/${job}`)).job;
    onStarted(); setJob(null);
    if (j.result?.analysisId) navigate(`/analysis/${j.result.analysisId}`);
  }, [job]);
  return (
    <div className="panel"><div className="pb col">
      <label className="field">Analysis<select aria-label="Analysis type" className="select" value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></label>
      <div className="small muted">{types.find((t) => t.type === type)?.description}</div>
      <label className="field">Records from<select aria-label="Records from" className="select" value={tableId} onChange={(e) => { setTableId(e.target.value); setIds(null); }}><option value="" disabled>Choose a table…</option>{candidates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.recordCount})</option>)}</select></label>
      {ids && <div className="notice small row">Using the {ids.length} record(s) selected in the grid. <button className="btn ghost sm" onClick={() => setIds(null)}>Use all records</button></div>}
      {detail && needs === 'sequences' && (seqFields.length === 0 ? <div className="notice warn small">This table has no Sequence field.</div> : seqFields.length > 1 && <label className="field">Sequence field<select className="select" value={params.sequenceField ?? seqFields[0].id} onChange={(e) => P('sequenceField', e.target.value)}>{seqFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>)}
      {detail && needs === 'matrix' && (numFields.length === 0 ? <div className="notice warn small">This table has no numeric fields.</div> : (
        <div className="col" style={{ gap: 2 }}><b className="small">Numeric fields {fieldIds.length === 0 && <span className="muted">(all)</span>}</b>{numFields.map((f) => <label key={f.id} className="check small"><input type="checkbox" checked={fieldIds.includes(f.id)} onChange={(e) => setFieldIds((s) => (e.target.checked ? [...s, f.id] : s.filter((x) => x !== f.id)))} />{f.name}</label>)}</div>
      ))}
      {type === 'alignment' && <><label className="field"><Lbl k="alnGlobal">Method</Lbl><select className="select" value={params.mode ?? 'global'} onChange={(e) => P('mode', e.target.value)}><option value="global">Global (Needleman–Wunsch)</option><option value="local">Local (Smith–Waterman)</option><option value="msa">Multiple alignment (star)</option></select></label>
        <div className="row"><label className="field grow"><Lbl k="anaGapOpen">Gap open</Lbl><input className="input" type="number" min={0} step="0.5" placeholder="auto" value={params.gapOpen ?? ''} onChange={(e) => P('gapOpen', e.target.value === '' ? undefined : Number(e.target.value))} /></label><label className="field grow"><Lbl k="anaGapExtend">Gap extend</Lbl><input className="input" type="number" min={0} step="0.5" placeholder="auto" value={params.gapExtend ?? ''} onChange={(e) => P('gapExtend', e.target.value === '' ? undefined : Number(e.target.value))} /></label></div>
        <span className="muted small">Defaults: DNA match +2 / mismatch −3, gaps 5/2; protein BLOSUM62, gaps 11/1. Two selected sequences → pairwise; more → multiple alignment.</span></>}
      {type === 'comparison' && <label className="field"><Lbl k="anaCompare">Method</Lbl><select className="select" value={params.method ?? 'alignment'} onChange={(e) => P('method', e.target.value)}><option value="alignment">Pairwise alignment identity</option><option value="kmer">k-mer similarity (alignment-free)</option></select></label>}
      {type === 'phylogeny' && <label className="field"><Lbl k="anaTree">Tree method</Lbl><select className="select" value={params.method ?? 'nj'} onChange={(e) => P('method', e.target.value)}><option value="nj">Neighbor-joining</option><option value="upgma">UPGMA</option></select></label>}
      {type === 'heatmap' && <><label className="field"><Lbl k="anaScale">Scaling</Lbl><select className="select" value={params.scale ?? 'none'} onChange={(e) => P('scale', e.target.value)}><option value="none">None</option><option value="column">Z-score per column</option><option value="row">Z-score per row</option></select></label><label className="check"><input type="checkbox" checked={params.clusterRows !== false} onChange={(e) => P('clusterRows', e.target.checked)} /> <Lbl k="anaCluster">Cluster rows</Lbl></label><label className="check"><input type="checkbox" checked={params.clusterCols !== false} onChange={(e) => P('clusterCols', e.target.checked)} /> Cluster columns</label></>}
      {type === 'pca' && <><label className="check"><input type="checkbox" checked={params.scale !== false} onChange={(e) => P('scale', e.target.checked)} /> <Lbl k="anaPcaScale">Scale to unit variance</Lbl></label>{groupFields.length > 0 && <label className="field">Colour by<select className="select" value={params.groupField ?? ''} onChange={(e) => P('groupField', e.target.value || undefined)}><option value="">(none)</option>{groupFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}</>}
      {type === 'statistics' && <><label className="field"><Lbl k="anaCorrelation">Correlation</Lbl><select className="select" value={params.correlation ?? 'pearson'} onChange={(e) => P('correlation', e.target.value)}><option value="pearson">Pearson</option><option value="spearman">Spearman</option></select></label>{groupFields.length > 0 && <label className="field">Compare two groups by<select className="select" value={params.groupField ?? ''} onChange={(e) => P('groupField', e.target.value || undefined)}><option value="">(no group test)</option>{groupFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}</>}
      <label className="field">Name (optional)<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. p53 orthologs" maxLength={120} /></label>
      <button className="btn" disabled={busy || !ok || !!job} onClick={start}><Icon name="play" /> {job ? 'Running…' : 'Run analysis'}</button>
      {job && <JobLine id={job} />}
    </div></div>
  );
}

function Result({ id }: { id: string }) {
  const [a, setA] = useState<any>(null);
  const [err, setErr] = useState('');
  const [code, setCode] = useState<{ lang: string; filename: string; code: string } | null>(null);
  useEffect(() => { setA(null); setErr(''); get(`/api/analysis/${id}`).then((r) => setA(r.analysis), (e) => setErr(e.message)); }, [id]);
  const open = async (lang: 'python' | 'r' | 'julia') => { try { setCode(await get(`/api/analysis/${id}/code?lang=${lang}`)); } catch (e) { toast((e as Error).message, 'err'); } };
  if (err) return <Empty title="Cannot open this analysis">{err}</Empty>;
  if (!a) return <Spinner />;
  const r = a.result;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between wrap"><div><h2>{a.name}</h2><div className="muted small">{a.type} · {fmtDate(a.createdAt, true)} · {a.status}</div></div>
        <div className="row wrap">
          <button className="btn sm" onClick={() => open('python')}><Icon name="download" /> Python</button><button className="btn secondary sm" onClick={() => open('r')}>R</button><button className="btn secondary sm" onClick={() => open('julia')}>Julia</button>
          <a className="btn secondary sm" href={`/api/analysis/${id}/export?format=csv`}>CSV</a><a className="btn secondary sm" href={`/api/analysis/${id}/export?format=json`}>JSON</a>
          {a.resultRecordId && <Link to={`/record/${a.resultRecordId}`} className="btn ghost sm">Result record</Link>}
        </div></div>
      {a.status !== 'completed' || !r ? <div className="notice warn">This analysis did not complete ({a.status}).</div> : <Body type={a.type} r={r} />}
      <details><summary className="small"><b>Parameters & inputs</b> (exactly what was computed)</summary><div className="code" style={{ maxHeight: 220, marginTop: 6 }}>{JSON.stringify({ parameters: a.params, effective: r?.params ?? undefined, inputs: a.input.sequences ? a.input.sequences.map((s: any) => ({ label: s.label, length: s.seq.length })) : { rows: a.input.matrix?.rowLabels.length, columns: a.input.matrix?.colNames } }, null, 2)}</div></details>
      {code && (
        <Modal title={`${code.lang === 'r' ? 'R' : code.lang[0].toUpperCase() + code.lang.slice(1)} script`} size="wide" onClose={() => setCode(null)} footer={<><button className="btn secondary" onClick={async () => toast((await copyText(code.code)) ? 'Copied' : 'Copy failed', 'ok')}>Copy</button><a className="btn" href={`/api/analysis/${id}/code?lang=${code.lang}&download=1`}><Icon name="download" /> Download {code.filename}</a></>}>
          <div className="notice small" style={{ marginBottom: 8 }}>The script embeds the exact data and parameters used. Python scripts were checked to reproduce VierStation’s numbers; R and Julia scripts follow the same method but were not executed in this environment.</div>
          <pre className="code">{code.code}</pre>
        </Modal>
      )}
    </div>
  );
}

function Body({ type, r }: { type: string; r: any }) {
  if (type === 'alignment') return r.kind === 'pairwise'
    ? <div className="col"><div className="row wrap"><Chip color="blue">{r.alignment.mode}</Chip><Chip>score {r.alignment.score}</Chip><Chip color="green">{r.alignment.identityPct}% identity</Chip>{r.params.seqType === 'protein' && <Chip color="sky">{r.alignment.similarityPct}% similarity</Chip>}<Chip>{r.alignment.gaps} gap positions</Chip><Chip>{r.alignment.length} columns</Chip></div><PairwiseView a={r.alignment.a} b={r.alignment.b} labels={r.labels} /></div>
    : <div className="col"><div className="row wrap"><Chip color="blue">{r.method}</Chip><Chip>{r.rows.length} sequences</Chip><Chip>{r.length} columns</Chip><Chip color="green">{r.conservation.filter((c: number) => c === 1).length} fully conserved</Chip></div><AlignmentView labels={r.labels} rows={r.rows} consensus={r.consensus} conservation={r.conservation} /><h3>Pairwise identity</h3><HeatMap rows={r.labels} cols={r.labels} values={r.identity} min={0} max={1} cell={30} showValues /></div>;
  if (type === 'comparison') return <div className="col"><div className="muted small">{r.metric}</div><HeatMap rows={r.labels} cols={r.labels} values={r.matrix} min={0} max={1} cell={r.labels.length > 14 ? 20 : 34} showValues={r.labels.length <= 14} />
    <table className="t"><thead><tr><th>Sequence</th><th>Length</th>{r.sequences[0]?.gc !== null && <th>GC</th>}</tr></thead><tbody>{r.sequences.map((s: any) => <tr key={s.id}><td>{s.label}</td><td>{s.length.toLocaleString()}</td>{s.gc !== null && <td>{(s.gc * 100).toFixed(1)}%</td>}</tr>)}</tbody></table></div>;
  if (type === 'phylogeny') return <div className="col"><div className="row wrap"><Chip color="blue">{r.method === 'nj' ? 'Neighbor-joining' : 'UPGMA'}</Chip><Chip>{r.distance} distances</Chip><Chip>{r.alignmentLength} alignment columns</Chip></div><TreeView tree={r.tree} /><details><summary className="small"><b>Newick</b></summary><div className="code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6 }}>{r.newick}</div></details><h3>Distance matrix</h3><HeatMap rows={r.labels} cols={r.labels} values={r.distanceMatrix} cell={r.labels.length > 14 ? 20 : 32} showValues={r.labels.length <= 12} /></div>;
  if (type === 'heatmap') return <div className="col"><div className="row wrap"><Chip color="blue">{r.scale === 'none' ? 'unscaled' : `z-score per ${r.scale}`}</Chip><Chip>{r.rowLabels.length} × {r.colNames.length}</Chip>{r.clusteredRows && <Chip color="sky">rows clustered</Chip>}{r.clusteredCols && <Chip color="sky">columns clustered</Chip>}</div><HeatMap rows={r.rowLabels} cols={r.colNames} values={r.values} diverging={r.scale !== 'none'} rowOrder={r.rowOrder} colOrder={r.colOrder} cell={r.rowLabels.length > 60 ? 12 : 24} showValues={r.rowLabels.length <= 14 && r.colNames.length <= 10} /></div>;
  if (type === 'pca') return <div className="col"><div className="row wrap"><Chip color="blue">{r.scaled ? 'scaled' : 'centred'}</Chip>{r.explained.map((e: number, i: number) => <Chip key={i}>PC{i + 1} {(e * 100).toFixed(1)}%</Chip>)}</div><PcaPlot scores={r.scores} labels={r.rowLabels} explained={r.explained} groups={r.groups} groupName={r.groupName} />
    <h3>Loadings</h3><table className="t"><thead><tr><th>Field</th>{r.explained.map((_: number, i: number) => <th key={i}>PC{i + 1}</th>)}</tr></thead><tbody>{r.colNames.map((c: string, j: number) => <tr key={c}><td>{c}</td>{r.loadings.map((l: number[], i: number) => <td key={i}>{l[j]}</td>)}</tr>)}</tbody></table></div>;
  if (type === 'statistics') return (
    <div className="col"><h3>Summary</h3><div style={{ overflow: 'auto' }}><table className="t"><thead><tr><th>Variable</th><th>n</th><th>Mean</th><th>SD</th><th>Min</th><th>Q1</th><th>Median</th><th>Q3</th><th>Max</th><th>Missing</th></tr></thead><tbody>{r.summary.map((s: any) => <tr key={s.name}><td><b>{s.name}</b></td><td>{s.n}</td>{['mean', 'sd', 'min', 'q1', 'median', 'q3', 'max'].map((k) => <td key={k}>{s[k] === null ? '—' : +s[k].toPrecision(4)}</td>)}<td>{s.missing}</td></tr>)}</tbody></table></div>
      {r.correlation.matrix.length > 0 && <><h3>{r.correlation.method === 'spearman' ? 'Spearman' : 'Pearson'} correlation</h3><HeatMap rows={r.correlation.names} cols={r.correlation.names} values={r.correlation.matrix} diverging min={-1} max={1} cell={34} showValues /></>}
      {r.groupTest && <><h3>{r.groupTest.levels.join(' vs ')} ({r.groupTest.groupName})</h3><div className="muted small">{r.groupTest.test}. p-values are not corrected for multiple testing.</div><table className="t"><thead><tr><th>Variable</th><th>Mean A</th><th>Mean B</th><th>t</th><th>df</th><th>p</th></tr></thead><tbody>{r.groupTest.results.map((x: any) => <tr key={x.name}><td>{x.name}</td>{x.error ? <td colSpan={5} className="muted">{x.error}</td> : <><td>{+x.meanA.toPrecision(4)}</td><td>{+x.meanB.toPrecision(4)}</td><td>{+x.t.toPrecision(4)}</td><td>{+x.df.toPrecision(4)}</td><td>{x.p < 0.001 ? x.p.toExponential(2) : x.p.toFixed(4)}</td></>}</tr>)}</tbody></table></>}
      {r.groupNote && <div className="notice warn small">{r.groupNote}</div>}</div>
  );
  return null;
}
