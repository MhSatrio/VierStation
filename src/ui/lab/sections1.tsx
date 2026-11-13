// Sequence Lab sections 1: Overview, Raw sequence, Quality inspection (with chromatogram), Cleaning.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { post } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { Chip, Empty, Spinner, ago, confirmDialog, fmtDate } from '../common.tsx';
import { Icon } from '../icons.tsx';
import { HelpTip, Hint, Lbl } from '../Tip.tsx';
import { Section, act, useLab, useLabGet } from './useLab.tsx';
import { MergeDialog } from './pickers.tsx';

// ------------------------------------------------------------------ shared sequence rendering
export function SeqView({ seq, qual, edits, marks, removedAt, lineLen = 60, max = 20000 }: { seq: string; qual?: number[] | null; edits?: Set<number>; marks?: { start: number; end: number; note: string }[]; removedAt?: Set<number>; lineLen?: number; max?: number }) {
  const shown = seq.slice(0, max);
  const lines: ReactElement[] = [];
  for (let i = 0; i < shown.length; i += lineLen) {
    const kids: ReactElement[] = [];
    for (let j = i; j < Math.min(i + lineLen, shown.length); j++) {
      const c = shown[j], pos = j + 1;
      const marked = marks?.some((m) => pos >= m.start && pos <= m.end);
      const cls = `nt-${'ACGT'.includes(c) ? c : 'N'}${edits?.has(pos) ? ' nt-edit' : ''}${marked ? ' nt-mark' : ''}${removedAt?.has(pos) ? ' nt-x' : ''}`;
      const title = qual ? `${pos}: ${c}  Q${qual[j]}` : marked ? `${pos}: ${c} – ${marks?.find((m) => pos >= m.start && pos <= m.end)?.note}` : undefined;
      kids.push(<span key={j} className={cls} title={title}>{c}{(j + 1) % 10 === 0 && j + 1 < Math.min(i + lineLen, shown.length) ? ' ' : ''}</span>);
    }
    lines.push(<div key={i}><span className="ln">{i + 1}</span>{kids}</div>);
  }
  return <div className="seqbox" tabIndex={0} role="region" aria-label="Sequence">{lines}{seq.length > max && <div className="muted">… {seq.length - max} more bases not shown</div>}</div>;
}

const STEP_LABEL: Record<string, string> = { import: 'Import', clean: 'Cleaning', blast: 'NCBI BLAST', relatives: 'Related species', outgroups: 'Outgroups', dataset: 'Dataset', align: 'Alignment', align_edit: 'Alignment edit', tree: 'Phylogenetic tree', identify: 'Identification' };

// ------------------------------------------------------------------ Overview
export function Overview() {
  const { ov, go } = useLab();
  const s = ov.steps as Record<string, { status: string; at: string } | null>;
  const next = !s.blast ? { t: 'Search NCBI for similar sequences', to: 'matches' } : !ov.dataset ? { t: 'Collect close relatives from the BLAST hits', to: 'relatives' } : !ov.dataset.outgroups ? { t: 'Choose outgroups', to: 'outgroups' } : !(s.align || s.align_edit) ? { t: 'Align the sequences', to: 'alignment' } : !s.tree ? { t: 'Build a phylogenetic tree', to: 'tree' } : !s.identify ? { t: 'Review the evidence and record your identification', to: 'final' } : { t: 'Export the workflow history and script', to: 'exports' };
  const rows: [string, string, string][] = [['import', 'Imported', 'raw'], ['clean', 'Cleaned', 'cleaning'], ['blast', 'NCBI BLAST', 'matches'], ['relatives', 'Related species', 'relatives'], ['outgroups', 'Outgroup assistant', 'outgroups'], ['align', 'Alignment', 'alignment'], ['tree', 'Tree', 'tree'], ['identify', 'Identification', 'final']];
  return (
    <Section title="Overview">
      <div className="tiles">
        <div className="tile"><div className="v">{ov.raw.length}</div><div className="l">Raw length (bp){ov.raw.hasQuality ? ' · with quality' : ' · no quality scores'}</div></div>
        <div className="tile"><div className="v">{ov.head.length}</div><div className="l">Working length (bp) · version {ov.head.n}</div></div>
        <div className="tile"><div className="v">{ov.versions.length}</div><div className="l">Versions kept</div></div>
        <div className="tile"><div className="v">{ov.dataset?.members ?? 0}</div><div className="l">Sequences in dataset</div></div>
      </div>
      <div className="notice"><b>Suggested next step (optional):</b> {next.t}. <button className="btn secondary sm" onClick={() => go(next.to)}>Go there</button><div className="small muted" style={{ marginTop: 4 }}>The steps below can be done in any order and repeated; a repeat creates a new result and keeps the old one.</div></div>
      <div className="panel"><table className="t"><thead><tr><th>Step</th><th>Status</th><th>Last run</th><th /></tr></thead><tbody>
        {rows.map(([k, label, to]) => { const x = s[k] ?? (k === 'align' ? s.align_edit : null); return (
          <tr key={k}><td><b>{label}</b></td><td>{x ? <Chip color={x.status === 'completed' ? 'green' : x.status === 'failed' ? 'red' : x.status === 'running' ? 'amber' : 'gray'}>{x.status}</Chip> : <span className="muted">not run</span>}</td><td className="muted small">{x ? ago(x.at) : ''}</td><td><button className="btn ghost sm" onClick={() => go(to)}>Open</button></td></tr>); })}
      </tbody></table></div>
      {ov.meta?.source === 'adopted' && <div className="notice warn">This record existed before the Sequence Lab. Its raw version is the sequence stored in the record when it entered the lab; the original file or chromatogram was not kept.</div>}
      <div className="small muted">Source: {ov.meta?.source ?? 'unknown'}{ov.meta?.fileName ? ` · ${ov.meta.fileName}` : ''}. Last change {ov.updatedAt ? fmtDate(ov.updatedAt, true) : ''}.</div>
    </Section>
  );
}

// ------------------------------------------------------------------ Raw
export function Raw() {
  const { id, ov } = useLab();
  const { data } = useLabGet(`/api/lab/${id}/compare`);
  if (!data) return <Spinner />;
  return (
    <Section title={<Lbl k="rawImmutable">Raw sequence</Lbl>} right={<a className="btn secondary sm" href={`/api/lab/${id}/export/fasta?what=raw`}><Icon name="download" /> Raw FASTA</a>}>
      {ov.links?.mergedFrom && <div className="notice small"><b>This sequence is a merge.</b> It was built from the forward read <Link to={`/lab/${ov.links.mergedFrom.forward.id}`}>{ov.links.mergedFrom.forward.name}</Link> (#{ov.links.mergedFrom.forward.id.slice(-6)}) and the reverse read <Link to={`/lab/${ov.links.mergedFrom.reverse.id}`}>{ov.links.mergedFrom.reverse.name}</Link> (#{ov.links.mergedFrom.reverse.id.slice(-6)}), which stay unchanged. The “raw” sequence below is the merge result.</div>}
      {ov.links?.mergedInto?.length > 0 && <div className="notice small"><b>This read was combined into</b> {ov.links.mergedInto.map((m: any, i: number) => <span key={m.id}>{i > 0 && ', '}<Link to={`/lab/${m.id}`}>{m.name}</Link></span>)}. Use that merged sequence for BLAST and the next steps.</div>}
      <div className="notice">Exactly as imported ({data.raw.length} bp). It is locked in the database: cleaning steps never modify it, they create new versions.</div>
      <div className="row wrap small"><Chip color="gray">{ov.meta?.source ?? 'unknown source'}</Chip>{ov.meta?.fileName && <Chip color="sky">{ov.meta.fileName}</Chip>}{ov.raw.hasQuality ? <Chip color="green">quality scores kept</Chip> : <Chip color="amber">no quality scores (FASTA / pasted)</Chip>}</div>
      <SeqView seq={data.raw} />
    </Section>
  );
}

// ------------------------------------------------------------------ Quality
function QualityPlot({ values, lows, threshold = 20 }: { values: number[]; lows: { from: number; to: number }[]; threshold?: number }) {
  const W = 1000, H = 150, n = values.length, maxQ = Math.max(40, ...values);
  const step = Math.max(1, Math.floor(n / 1000));
  const pts: string[] = [];
  for (let i = 0; i < n; i += step) { let t = 0, c = 0; for (let k = i; k < Math.min(i + step, n); k++) { t += values[k]; c++; } pts.push(`${((i / (n - 1 || 1)) * W).toFixed(1)},${(H - 6 - ((t / c) / maxQ) * (H - 14)).toFixed(1)}`); }
  const y = (q: number) => H - 6 - (q / maxQ) * (H - 14);
  return (
    <svg className="qplot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Phred quality along the read">
      {lows.map((r, i) => <rect key={i} x={(r.from / (n || 1)) * W} width={Math.max(2, ((r.to - r.from) / (n || 1)) * W)} y={0} height={H} fill="#fde7e4" />)}
      <line x1="0" x2={W} y1={y(20)} y2={y(20)} stroke="#c98a00" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" /><line x1="0" x2={W} y1={y(30)} y2={y(30)} stroke="#1d8a57" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <polyline points={pts.join(' ')} fill="none" stroke="#4570b6" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <text x="6" y={y(20) - 3} fontSize="11" fill="#8a5d00">Q{threshold}</text><text x="6" y={y(30) - 3} fontSize="11" fill="#1d8a57">Q30</text>
    </svg>
  );
}

const TRACE_COLOR: Record<string, string> = { A: '#1d8a57', C: '#4570b6', G: '#231f20', T: '#b3342a' };
function Chromatogram() {
  const { id, canEdit, bump } = useLab();
  const [from, setFrom] = useState(1);
  const WIN = 40;
  const { data, error } = useLabGet<any>(`/api/lab/${id}/chromatogram?from=${from}&to=${from + WIN - 1}`);
  const [sel, setSel] = useState<any>(null);
  const amb = useLabGet<any>(`/api/lab/${id}/ambiguity?minRatio=0.35`);
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Spinner />;
  const n = data.pointTo - data.pointFrom + 1, H = 190;
  const maxV = Math.max(1, ...(['A', 'C', 'G', 'T'] as const).flatMap((b) => data.traces[b]));
  const path = (b: string) => (data.traces[b] as number[]).map((v, i) => `${i === 0 ? 'M' : 'L'}${i},${(H - 4 - (v / maxV) * (H - 12)).toFixed(1)}`).join('');
  const jump = (p: number) => setFrom(Math.max(1, Math.min(data.rawLength - WIN + 1, p - Math.floor(WIN / 2))));
  const editBase = async (base: string) => {
    if (!sel?.headPos) return;
    await act(() => post(`/api/lab/${id}/clean`, { op: 'edit_base', pos: sel.headPos, base }), 'Base changed – see Cleaning for the change log');
    setSel(null); bump();
  };
  return (
    <div className="col">
      <div className="row wrap">
        <Hint k="chromatogram"><span className="small"><b>Chromatogram</b> (raw read, bases {data.from}–{data.to} of {data.rawLength})</span></Hint>
        <span className="grow" />
        <button className="btn secondary sm" onClick={() => setFrom((f) => Math.max(1, f - 30))} aria-label="Scroll left"><Icon name="chevL" /></button>
        <input aria-label="Jump to raw position" className="input" style={{ width: 90 }} type="number" min={1} max={data.rawLength} value={from} onChange={(e) => setFrom(Math.max(1, Number(e.target.value) || 1))} />
        <button className="btn secondary sm" onClick={() => setFrom((f) => Math.min(data.rawLength - WIN + 1, f + 30))} aria-label="Scroll right"><Icon name="chevR" /></button>
      </div>
      {data.note && <div className="notice small">{data.note}</div>}
      <div style={{ position: 'relative' }}>
        <svg className="chrom" viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" height={H} role="img" aria-label="Sequencer trace">
          {(['G', 'A', 'T', 'C'] as const).map((b) => <path key={b} d={path(b)} fill="none" stroke={TRACE_COLOR[b]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.9" />)}
        </svg>
        <div style={{ position: 'relative', height: 62, fontFamily: 'var(--mono)', fontSize: 12 }}>
          {data.bases.map((b: any) => (
            <button key={b.raw} onClick={() => setSel(b)} title={`raw ${b.raw}: ${b.base}  Q${b.q ?? '?'}${b.kept ? `  → current position ${b.headPos}` : '  (removed from current version)'}${b.secondary?.ratio >= 0.35 ? `  second peak ${b.secondary.base} ${Math.round(b.secondary.ratio * 100)}%` : ''}`}
              style={{ position: 'absolute', left: `${(b.x / n) * 100}%`, transform: 'translateX(-50%)', border: 0, background: sel?.raw === b.raw ? 'var(--sky)' : 'transparent', padding: '0 1px', cursor: 'pointer', textAlign: 'center', lineHeight: 1.15, opacity: b.kept ? 1 : 0.35 }}>
              <div style={{ color: TRACE_COLOR[b.base] ?? '#8a5d00', fontWeight: 600, background: b.secondary?.ratio >= 0.35 ? '#ffe3a3' : undefined }}>{b.base}</div>
              <div style={{ fontSize: 9, color: b.q !== null && b.q < 20 ? 'var(--red)' : 'var(--ink-3)' }}>{b.q ?? ''}</div>
              <div style={{ fontSize: 9, color: 'var(--ink-3)' }}>{b.raw % 10 === 0 ? b.raw : ''}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="row wrap small muted">{(['A', 'C', 'G', 'T'] as const).map((b) => <span key={b}><i className="legend-dot" style={{ background: TRACE_COLOR[b] }} />{b}</span>)}<span>· numbers under letters: Phred quality · faded = removed in the current version · highlighted = strong second peak</span></div>
      {sel && (
        <div className="panel"><div className="pb col">
          <div><b>Raw position {sel.raw}</b>: called <b>{sel.base}</b>, Q{sel.q ?? '?'}{sel.secondary?.ratio ? <> · second peak {sel.secondary.base} at {Math.round(sel.secondary.ratio * 100)}% of the called peak <HelpTip k="secondaryPeak" /></> : null}</div>
          {sel.kept ? (canEdit ? <div className="row wrap"><span className="small">Change position {sel.headPos} of the working sequence to:</span>{['A', 'C', 'G', 'T', 'R', 'Y', 'S', 'W', 'K', 'M', 'N'].map((b) => <button key={b} className="btn secondary sm" onClick={() => editBase(b)}>{b}</button>)}<button className="btn ghost sm" onClick={() => setSel(null)}>Close</button></div> : <div className="muted small">You have read-only access.</div>)
            : <div className="muted small">This base was removed by an earlier cleaning step. Undo that step to edit it.</div>}
        </div></div>
      )}
      {amb.data && <details><summary className="small"><b>{amb.data.count}</b> position(s) with a strong second peak (suggestions only – nothing is changed automatically)</summary>
        <table className="t" style={{ marginTop: 6 }}><thead><tr><th>Raw pos</th><th>Called</th><th>Second</th><th>Ratio</th><th>Q</th><th>Code</th><th /></tr></thead><tbody>{amb.data.items.slice(0, 40).map((x: any) => <tr key={x.rawPos}><td>{x.rawPos}</td><td>{x.called}</td><td>{x.second}</td><td>{Math.round(x.ratio * 100)}%</td><td>{x.q ?? '—'}</td><td>{x.suggested ?? '—'}</td><td><button className="btn ghost sm" onClick={() => jump(x.rawPos)}>Show</button></td></tr>)}</tbody></table>
        <div className="small muted">{amb.data.note}</div></details>}
    </div>
  );
}

export function Quality() {
  const { id, go, canEdit, bump } = useLab();
  const { data: q, error } = useLabGet<any>(`/api/lab/${id}/inspect`);
  if (error) return <div className="notice err">{error}</div>;
  if (!q) return <Spinner />;
  const apply = async (s: any) => { if (await confirmDialog(`Apply: ${s.why}`, 'Apply', false)) { await act(() => post(`/api/lab/${id}/clean`, s.params), (r: any) => r.summary); bump(); } };
  return (
    <Section title="Quality inspection" right={<span className="small muted">version {q.versionNumber} · inspection never changes your data</span>}>
      <div className="tiles">
        <div className="tile"><div className="v">{q.length}</div><div className="l">Length (bp)</div></div>
        <div className="tile"><div className="v">{q.gcPct ?? '—'}{q.gcPct !== null && '%'}</div><div className="l"><Lbl k="gc">GC content</Lbl></div></div>
        {q.quality && <><div className="tile"><div className="v">{q.quality.mean}</div><div className="l"><Lbl k="meanQ">Mean quality</Lbl></div></div>
          <div className="tile"><div className="v">{q.quality.q20Pct}%</div><div className="l"><Lbl k="q20">≥ Q20</Lbl></div></div>
          <div className="tile"><div className="v">{q.quality.q30Pct}%</div><div className="l"><Lbl k="q30">≥ Q30</Lbl></div></div></>}
        <div className="tile"><div className="v">{q.ambiguous}</div><div className="l"><Lbl k="ambiguity">Ambiguous bases</Lbl> ({q.ambiguousPct}%)</div></div>
      </div>
      {q.note && <div className="notice warn">{q.note}</div>}
      {q.quality?.values && <><div className="small"><b><Lbl k="phred">Phred quality along the read</Lbl></b> <span className="muted">· red bands: <Lbl k="lowQualityRegion">low-quality regions</Lbl></span></div><QualityPlot values={q.quality.values} lows={q.lowQualityRegions} /></>}
      {q.homopolymers.length > 0 && <div className="small"><Lbl k="homopolymer">Long homopolymer runs</Lbl>: {q.homopolymers.map((h: any) => `${h.base}×${h.length} at ${h.from}`).join(', ')}</div>}
      <div className="panel"><header><b>Suggested cleaning</b><span className="muted small">suggestions are not applied until you choose to</span></header><div className="pb col">
        {q.suggestions.length === 0 ? <span className="muted small">Nothing obvious to clean. Check the chromatogram if you have one.</span> : q.suggestions.map((s: any, i: number) => (
          <div key={i} className="row wrap"><span className="grow small">{s.why}</span>{canEdit && <button className="btn secondary sm" onClick={() => apply(s)}>Apply…</button>}</div>))}
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => go('cleaning')}>Open all cleaning tools →</button>
      </div></div>
      {q.hasChromatogram ? <Chromatogram /> : <div className="notice small">No chromatogram: {q.source === 'ab1' ? 'the AB1 file is no longer stored.' : 'only AB1 (Sanger) imports include trace data. Peak shapes are never shown for FASTA/FASTQ input.'}</div>}
    </Section>
  );
}

// ------------------------------------------------------------------ Cleaning
interface Field { key: string; label: string; def?: string | number; type?: 'number' | 'text' | 'select'; options?: [string, string][]; k?: string }
const OPS: { id: string; title: string; k: string; needsQ?: boolean; fields: Field[] }[] = [
  { id: 'trim_window', title: 'Trim low-quality ends (window)', k: 'trimWindow', needsQ: true, fields: [{ key: 'threshold', label: 'Min mean quality', def: 20, k: 'phred' }, { key: 'window', label: 'Window (bases)', def: 10 }, { key: 'ends', label: 'Ends', type: 'select', def: 'both', options: [['both', 'Both ends'], ['5', '5′ end only'], ['3', '3′ end only']] }] },
  { id: 'trim_mott', title: 'Trim low-quality ends (modified Mott)', k: 'trimMott', needsQ: true, fields: [{ key: 'errorCutoff', label: 'Error cutoff', def: 0.05 }] },
  { id: 'trim_ambiguous_ends', title: 'Trim ambiguous ends', k: 'trimAmbiguousEnds', fields: [] },
  { id: 'trim_region', title: 'Trim by region', k: 'trimRegion', fields: [{ key: 'from', label: 'From (1-based)', def: 1 }, { key: 'to', label: 'To', def: 100 }, { key: 'mode', label: 'Mode', type: 'select', def: 'keep', options: [['keep', 'Keep this region'], ['remove', 'Remove this region']] }] },
  { id: 'remove_bases', title: 'Remove bases', k: 'removeBases', fields: [{ key: 'chars', label: 'Characters', def: 'N', type: 'text' }] },
  { id: 'edit_base', title: 'Edit one base', k: 'editBase', fields: [{ key: 'pos', label: 'Position', def: 1 }, { key: 'base', label: 'New base / IUPAC code', def: 'N', type: 'text' }] },
  { id: 'mask_low_quality', title: 'Replace low-quality bases with N', k: 'maskLowQuality', needsQ: true, fields: [{ key: 'threshold', label: 'Below quality', def: 20, k: 'phred' }] },
  { id: 'mark_region', title: 'Mark uncertain region', k: 'markRegion', fields: [{ key: 'from', label: 'From', def: 1 }, { key: 'to', label: 'To', def: 10 }, { key: 'note', label: 'Note', type: 'text', def: '' }] },
  { id: 'reverse_complement', title: 'Reverse-complement', k: 'reverseComplement', fields: [] },
];

function OpCard({ spec, hasQ }: { spec: (typeof OPS)[number]; hasQ: boolean }) {
  const { id, canEdit, bump } = useLab();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, String(f.def ?? '')])));
  const [busy, setBusy] = useState(false);
  const blocked = spec.needsQ && !hasQ;
  const run = async () => {
    setBusy(true);
    const body: Record<string, unknown> = { op: spec.id };
    for (const f of spec.fields) body[f.key] = f.type === 'text' || f.type === 'select' ? vals[f.key] : Number(vals[f.key]);
    const r = await act(() => post(`/api/lab/${id}/clean`, body), (r: any) => r.summary + (r.warnings?.length ? ` – ${r.warnings[0]}` : ''));
    setBusy(false); if (r) bump();
  };
  return (
    <div className="opcard"><h4><Lbl k={spec.k}>{spec.title}</Lbl></h4>
      {spec.fields.length > 0 && <div className="formgrid">{spec.fields.map((f) => (
        <label key={f.key} className="field"><Lbl k={f.k}>{f.label}</Lbl>
          {f.type === 'select' ? <select className="select" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            : <input className="input" type={f.type === 'text' ? 'text' : 'number'} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}</label>))}</div>}
      {blocked && <div className="small muted">Needs quality scores (AB1 or FASTQ input).</div>}
      <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} disabled={!canEdit || busy || blocked} onClick={run}>{busy ? 'Applying…' : 'Apply'}</button>
    </div>
  );
}

function MergeCard() {
  const { id, canEdit, ov } = useLab();
  const [open, setOpen] = useState(false);
  const merged = ov.meta?.source === 'merged';
  return (
    <div className="panel"><div className="pb col">
      <b><Lbl k="mergeReverse">Combine with the reverse read</Lbl></b>
      {merged
        ? <div className="small muted">This sequence is already the merge of a forward and a reverse read (see Raw sequence and Workflow history for the two sources).</div>
        : <div className="small muted">Have the reverse read of the same amplicon? Merge them into <b>one new sequence</b>: N / ambiguous positions are filled from the other read and the sequence is extended where only one read reaches. This read stays unchanged; the merged sequence becomes its own entry that you open and BLAST next.</div>}
      {!merged && <div><button className="btn" disabled={!canEdit} onClick={() => setOpen(true)}>Merge with a reverse read…</button></div>}
      {open && <MergeDialog forwardId={id} onClose={() => setOpen(false)} />}
    </div></div>
  );
}

export function Cleaning() {
  const { id, ov, canEdit, bump } = useLab();
  const { data: cmp } = useLabGet<any>(`/api/lab/${id}/compare`);
  const { data: vers } = useLabGet<any>(`/api/lab/${id}/versions`);
  const { data: ops } = useLabGet<any>(`/api/lab/${id}/ops?step=clean`);
  const [view, setView] = useState<'current' | 'compare'>('current');
  const edits = useMemo(() => new Set<number>((cmp?.diff?.edits ?? []).map((e: any) => e.pos)), [cmp]);
  const removed = useMemo(() => { const s = new Set<number>(); for (const [a, b] of cmp?.diff?.removed ?? []) for (let i = a; i <= b && s.size < 50000; i++) s.add(i); return s; }, [cmp]);
  return (
    <Section title="Cleaning" right={<div className="row">
      <Hint k="undoRedo"><span className="row"><button className="btn secondary sm" disabled={!canEdit || !ov.canUndo} onClick={async () => { await act(() => post(`/api/lab/${id}/undo`)); bump(); }}>↶ Undo</button>
        <button className="btn secondary sm" disabled={!canEdit || !ov.canRedo} onClick={async () => { await act(() => post(`/api/lab/${id}/redo`)); bump(); }}>↷ Redo{ov.redoCount > 1 ? ` (${ov.redoCount})` : ''}</button></span></Hint></div>}>
      <div className="notice small">Each tool creates a <Lbl k="version">new version</Lbl> and logs exactly what changed. The <Lbl k="rawImmutable">raw sequence</Lbl> is never touched, and every step can be undone.</div>
      <div className="opcards">{OPS.map((o) => <OpCard key={o.id} spec={o} hasQ={ov.head.qual !== null || ov.raw.hasQuality} />)}</div>
      <MergeCard />
      <div className="row wrap"><div className="tabs" style={{ margin: 0, border: 0 }}><button className={view === 'current' ? 'on' : ''} onClick={() => setView('current')}>Working sequence</button><button className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}><Lbl k="rawVsClean">Raw vs cleaned</Lbl></button></div>
        <span className="small muted">{ov.head.length} bp · version {ov.head.n}{cmp?.diff?.available ? ` · ${cmp.diff.editCount} base(s) edited · ${cmp.diff.removedCount} bp removed` : ''}</span></div>
      {view === 'current' && <SeqView seq={ov.head.seq} qual={ov.head.qual} edits={edits} marks={ov.head.marks} />}
      {view === 'compare' && cmp && (cmp.diff.available ? (
        <div className="col"><div className="small"><b>Raw</b> – amber = removed in the current version, yellow = base edited</div><SeqView seq={cmp.raw} removedAt={removed} edits={new Set<number>(cmp.diff.edits.map((e: any) => e.rawPos))} />
          <div className="small"><b>Current</b> – yellow = base edited{cmp.diff.reversed ? ' · reverse-complemented relative to the raw read' : ''}</div><SeqView seq={cmp.current} edits={edits} marks={cmp.marks} />
          {cmp.diff.edits.length > 0 && <table className="t"><thead><tr><th>Current pos</th><th>Raw pos</th><th>Raw base</th><th>Now</th></tr></thead><tbody>{cmp.diff.edits.slice(0, 50).map((e: any) => <tr key={e.pos}><td>{e.pos}</td><td>{e.rawPos}</td><td>{e.from}</td><td>{e.to}</td></tr>)}</tbody></table>}
          {cmp.diff.removed.length > 0 && <div className="small">Removed raw regions: {cmp.diff.removed.slice(0, 20).map(([a, b]: number[]) => `${a}–${b}`).join(', ')}</div>}</div>
      ) : <div className="notice">{cmp.diff.reason}</div>)}
      <h3>Versions</h3>
      {!vers ? <Spinner /> : <table className="t"><thead><tr><th>#</th><th>Created by</th><th>Length</th><th>When</th><th /></tr></thead><tbody>{[...vers.versions].reverse().map((v: any) => (
        <tr key={v.id}><td>{v.n}</td><td>{v.label}{v.kind === 'raw' && <Chip color="gray">raw · locked</Chip>}</td><td>{v.length}</td><td className="muted small">{fmtDate(v.createdAt, true)}</td><td>{v.id === vers.head ? <Chip color="blue">current</Chip> : canEdit && <button className="btn ghost sm" onClick={async () => { if (await confirmDialog(`Make version ${v.n} the working sequence? This adds a new version; nothing is deleted.`, 'Revert', false)) { await act(() => post(`/api/lab/${id}/revert`, { versionId: v.id }), 'Reverted (new version created)'); bump(); } }}>Revert to this</button>}</td></tr>))}</tbody></table>}
      <h3>Change log of cleaning steps</h3>
      {!ops ? <Spinner /> : ops.ops.length === 0 ? <Empty title="No cleaning yet" /> : ops.ops.slice().reverse().map((o: any) => (
        <details key={o.id} className="timeline-op"><summary><b>{o.name}</b><span className="grow" /><span className="muted small">{ago(o.createdAt)}</span></summary><div className="tb">
          <div className="small">{o.changes?.summary}</div>{o.warnings?.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
          {o.changes?.changes?.length > 0 && <div className="small mono">{o.changes.changes.slice(0, 30).map((c: any) => `${c.pos}: ${c.from || '·'}→${c.to || '∅'}`).join('  ')}{o.changes.changes.length > 30 ? ' …' : ''}</div>}
          <div className="small muted mono">{JSON.stringify(o.params)}</div></div></details>))}
    </Section>
  );
}
void useEffect; void useRef;
