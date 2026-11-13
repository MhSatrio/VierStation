// Sequence Lab sections 2: Alignment, NCBI matches, Related species, Outgroups.
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { get, post } from '../../lib/api.ts';
import { Chip, Empty, Spinner, ago, confirmDialog, fmtDate } from '../common.tsx';
import { Icon } from '../icons.tsx';
import { HelpTip, Hint, Lbl } from '../Tip.tsx';
import { Section, act, useJobRunner, useLab, useLabGet } from './useLab.tsx';
import { toast } from '../../lib/store.ts';

const ncbiUrl = (acc: string) => `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(acc)}`;
const num = (v: string, d: number) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// ------------------------------------------------------------------ Alignment
const NT_COLOR: Record<string, string> = { A: '#1d8a57', C: '#4570b6', G: '#231f20', T: '#b3342a' };
function AlignmentBlocks({ labels, rows, roles, consensus, conservation, sel, onSel }: { labels: string[]; rows: string[]; roles: Record<string, string>; consensus: string; conservation: number[]; sel: { r: number; c: number } | null; onSel: (s: { r: number; c: number } | null) => void }) {
  const L = rows[0]?.length ?? 0, BLK = 90;
  const [blocks, setBlocks] = useState(6);
  const out = [];
  for (let b = 0; b < Math.min(blocks, Math.ceil(L / BLK)); b++) {
    const s = b * BLK, e = Math.min(L, s + BLK);
    const ruler = Array.from({ length: e - s }, (_, i) => ((s + i + 1) % 10 === 0 ? String(s + i + 1).padStart(1) : '')).map((t, i) => (t ? t.padStart(1) : ' ')).join('');
    void ruler;
    out.push(
      <div key={b} className="alnblk" style={{ marginBottom: 8 }}>
        <div className="row2"><span className="nm muted">position {s + 1}</span><span className="muted">{Array.from({ length: e - s }, (_, i) => ((s + i + 1) % 10 === 0 ? '|' : ' ')).join('')}</span></div>
        {rows.map((row, r) => {
          const runs: ReactElement[] = []; let i = s;
          while (i < e) {
            const ch = row[i], mism = ch !== '-' && consensus[i] !== '.' && ch !== consensus[i], selHere = sel && sel.r === r && sel.c === i;
            let j = i + 1;
            while (j < e && row[j] === ch && !(sel && sel.r === r && sel.c === j) && !selHere) j++;
            runs.push(<span key={i} className={`c${ch === '-' ? ' gap' : ''}${selHere ? ' sel' : ''}`} style={{ color: ch === '-' ? undefined : NT_COLOR[ch] ?? '#8a5d00', background: mism && !selHere ? '#fff1cf' : undefined, width: `${(j - i) * 1.05}ch`, letterSpacing: 0, overflow: 'hidden' }} onClick={() => onSel(selHere ? null : { r, c: i })}>{ch.repeat(j - i)}</span>);
            i = j;
          }
          const role = roles[labels[r]];
          return <div key={r} className="row2"><span className="nm" title={labels[r]} style={{ color: role === 'query' ? '#7a4f00' : role === 'outgroup' ? 'var(--gray)' : undefined, fontWeight: role === 'query' ? 600 : 400 }}>{labels[r]}</span><span>{runs}</span></div>;
        })}
        <div className="row2"><span className="nm muted"><Lbl k="consensus">consensus</Lbl></span><span className="muted">{consensus.slice(s, e)}</span></div>
        <div className="row2"><span className="nm muted"><Lbl k="conservation">conservation</Lbl></span><span style={{ color: '#4570b6' }}>{Array.from({ length: e - s }, (_, i) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((conservation[s + i] ?? 0) * 8))]).join('')}</span></div>
      </div>);
  }
  return <div>{out}{blocks * BLK < L && <button className="btn secondary sm" onClick={() => setBlocks((x) => x + 6)}>Show more columns ({L - blocks * BLK} left)</button>}</div>;
}


function PairwiseCard() {
  const { id, canEdit, bump } = useLab();
  const { data: ds } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const [p, setP] = useState({ member: '', mode: 'global', gapOpen: '', gapExtend: '' });
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const others = (ds?.members ?? []).filter((m: any) => m.role !== 'query');
  const run = async () => {
    setBusy(true);
    const r = await act(() => post(`/api/lab/${id}/pairwise`, { memberId: p.member || others[0]?.id, mode: p.mode, gapOpen: p.gapOpen === '' ? undefined : Number(p.gapOpen), gapExtend: p.gapExtend === '' ? undefined : Number(p.gapExtend) }));
    setBusy(false); if (r) { setRes(r); bump(); }
  };
  if (others.length === 0) return null;
  const a = res?.alignment; const W = 80; const rows: ReactElement[] = [];
  if (a) for (let i = 0; i < a.a.length; i += W) {
    const x = a.a.slice(i, i + W), y = a.b.slice(i, i + W);
    rows.push(<div key={i}>{`${String(i + 1).padStart(5)}  ${x}
       ${[...x].map((c: string, k: number) => (c === '-' || y[k] === '-' ? ' ' : c === y[k] ? '|' : '.')).join('')}
       ${y}

`}</div>);
  }
  return (
    <details className="panel"><summary style={{ padding: '10px 14px', cursor: 'pointer' }}><b>Pairwise alignment</b> <span className="muted small">– your sequence against one other sequence, global or local</span></summary>
      <div className="pb col">
        <div className="formgrid">
          <label className="field">Compare with<select className="select" value={p.member || others[0]?.id} onChange={(e) => setP({ ...p, member: e.target.value })}>{others.map((m: any) => <option key={m.id} value={m.id}>{m.organism}{m.accession ? ` (${m.accession})` : ''}</option>)}</select></label>
          <label className="field"><Lbl k="alignment">Mode</Lbl><select className="select" value={p.mode} onChange={(e) => setP({ ...p, mode: e.target.value })}><option value="global">Global (whole length, Needleman–Wunsch)</option><option value="local">Local (best matching part, Smith–Waterman)</option></select></label>
          <label className="field"><Lbl k="gapOpen">Gap open</Lbl><input className="input" type="number" placeholder="5" value={p.gapOpen} onChange={(e) => setP({ ...p, gapOpen: e.target.value })} /></label>
          <label className="field"><Lbl k="gapExtend">Gap extend</Lbl><input className="input" type="number" placeholder="2" value={p.gapExtend} onChange={(e) => setP({ ...p, gapExtend: e.target.value })} /></label>
        </div>
        <div><button className="btn secondary" disabled={!canEdit || busy} onClick={run}>Align pair</button> <span className="small muted">Scores: match +2, mismatch −3. Global mode charges for end gaps; use local mode when the sequences cover different regions.</span></div>
        {res && <><div className="row wrap"><Chip color="blue">{a.mode}</Chip><Chip color="green">{a.identityPct}% identity</Chip><Chip>{a.length} columns</Chip><Chip>{a.gaps} gap columns</Chip><Chip color="sky">score {a.score}</Chip></div><div className="alnpair">{rows}</div></>}
      </div></details>
  );
}

export function Alignment() {
  const { id, canEdit, bump } = useLab();
  const { data: a, loading } = useLabGet<any>(`/api/lab/${id}/alignment`);
  const [engines, setEngines] = useState<any[]>([{ id: 'builtin', name: 'Built-in (progressive / iterative)' }]);
  useEffect(() => { get('/api/lab-meta/aligners').then((r) => setEngines(r.engines), () => {}); }, []);
  const [p, setP] = useState({ engine: 'builtin', method: 'progressive', matrix: 'simple', match: '2', mismatch: '-3', gapOpen: '5', gapExtend: '2', freeEndGaps: true, maxIterations: '3' });
  const job = useJobRunner();
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const { data: ds } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const run = () => job.start(`/api/lab/${id}/align`, { params: { engine: p.engine, method: p.method, matrix: p.matrix, match: num(p.match, 2), mismatch: num(p.mismatch, -3), gapOpen: num(p.gapOpen, 5), gapExtend: num(p.gapExtend, 2), freeEndGaps: p.freeEndGaps, maxIterations: num(p.maxIterations, 3) } });
  const cons = a?.rows && a.op ? a.rows : null;
  const stats = useMemo(() => {
    if (!cons) return null;
    const L = cons[0].length; let gapCols = 0, conserved = 0, variable = 0;
    for (let c = 0; c < L; c++) { const set = new Set(cons.map((r: string) => r[c])); if (set.has('-')) gapCols++; else if (set.size === 1) conserved++; else variable++; }
    return { L, gapCols, conserved, variable };
  }, [cons]);
  const edit = async (action: 'insert_gap' | 'delete_gap') => { if (!sel) return; const r = await act(() => post(`/api/lab/${id}/align/edit`, { action, label: a.labels[sel.r], col: sel.c, n: 1 }), (x: any) => x.summary); if (r) { setSel(null); bump(); } };
  return (
    <Section title={<Lbl k="alignment">Alignment</Lbl>}>
      {(ds?.members?.length ?? 0) < 2 && <div className="notice warn">The dataset has only {ds?.members?.length ?? 0} sequence(s). Collect close relatives first (Related species) – or add sequences manually.</div>}
      <div className="panel"><div className="pb col">
        <div className="formgrid">
          <label className="field"><Lbl k="alignment" text="Which program aligns the sequences. The built-in aligner needs nothing installed. MAFFT, MUSCLE and Clustal Omega appear here only if they are installed on the server; they use their own scoring.">Engine</Lbl><select className="select" value={p.engine} onChange={(e) => setP({ ...p, engine: e.target.value })}>{engines.map((e: any) => <option key={e.id} value={e.id}>{e.name}{e.version ? ` – ${e.version}` : ''}</option>)}</select></label>
          {p.engine === 'builtin' && <><label className="field"><Lbl k="alignment">Method</Lbl><select className="select" value={p.method} onChange={(e) => setP({ ...p, method: e.target.value })}><option value="progressive">Progressive (guide tree)</option><option value="iterative">Progressive + iterative refinement</option></select></label>
          <label className="field"><Lbl k="transitionMatrix">Scoring</Lbl><select className="select" value={p.matrix} onChange={(e) => setP({ ...p, matrix: e.target.value })}><option value="simple">Match / mismatch</option><option value="transition">Transition-aware</option></select></label>
          <label className="field"><Lbl k="matchScore">Match score</Lbl><input className="input" type="number" value={p.match} onChange={(e) => setP({ ...p, match: e.target.value })} /></label>
          <label className="field"><Lbl k="mismatchScore">Mismatch score</Lbl><input className="input" type="number" value={p.mismatch} onChange={(e) => setP({ ...p, mismatch: e.target.value })} /></label>
          <label className="field"><Lbl k="gapOpen">Gap open</Lbl><input className="input" type="number" min={0} value={p.gapOpen} onChange={(e) => setP({ ...p, gapOpen: e.target.value })} /></label>
          <label className="field"><Lbl k="gapExtend">Gap extend</Lbl><input className="input" type="number" min={0} value={p.gapExtend} onChange={(e) => setP({ ...p, gapExtend: e.target.value })} /></label>
          {p.method === 'iterative' && <label className="field"><Lbl k="iterative">Max refinement rounds</Lbl><input className="input" type="number" min={1} max={10} value={p.maxIterations} onChange={(e) => setP({ ...p, maxIterations: e.target.value })} /></label>}
        </>}
        </div>
        {p.engine === 'builtin' && <label className="check"><input type="checkbox" checked={p.freeEndGaps} onChange={(e) => setP({ ...p, freeEndGaps: e.target.checked })} /><Lbl k="freeEndGaps">Do not penalise end gaps</Lbl></label>}
        <div className="row wrap"><button className="btn" disabled={!canEdit || job.running} onClick={run}><Icon name="play" /> {a?.op ? 'Re-run alignment (keeps previous)' : 'Run alignment'}</button><span className="small muted">Built-in aligner (no external program). Not a replacement for MAFFT/MUSCLE on large or very divergent sets.</span></div>
        {job.view}
      </div></div>
      {loading && !a ? <Spinner /> : !a?.op ? <Empty title="No alignment yet">Run the aligner above to see it here.</Empty> : (
        <>
          {a.stale && <div className="notice warn">The dataset changed after this alignment was made. Re-run the alignment so the tree uses the current sequences.</div>}
          <div className="row wrap"><Chip color="blue">{a.method}</Chip><Chip>{a.labels.length} sequences</Chip><Chip>{a.length} columns</Chip>{stats && <><Chip color="green">{stats.conserved} identical columns</Chip><Chip>{stats.variable} variable</Chip><Chip color="gray">{stats.gapCols} with gaps</Chip></>}{a.spScore !== undefined && <Hint k="spScore"><Chip color="sky">SP score {a.spScore}</Chip></Hint>}{a.manualEdits > 0 && <Chip color="amber">{a.manualEdits} manual edit(s)</Chip>}<span className="small muted">{fmtDate(a.op.createdAt, true)}</span></div>
          {a.iterations?.length > 1 && <div className="small muted">Refinement: {a.iterations.map((i: any) => `round ${i.iteration}: ${i.spScore}${i.improved ? ` (${i.improved} improved)` : ''}`).join(' → ')}</div>}
          {a.warnings?.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
          <div className="row wrap small"><Hint k="manualAlignEdit"><span><b>Manual editing</b></span></Hint>
            <span className="muted">{sel ? `Selected: ${a.labels[sel.r]}, column ${sel.c + 1} (${a.rows[sel.r][sel.c]})` : 'Click a cell to select it'}</span>
            <button className="btn secondary sm" disabled={!canEdit || !sel} onClick={() => edit('insert_gap')}>Insert gap before</button>
            <button className="btn secondary sm" disabled={!canEdit || !sel || a.rows[sel.r][sel.c] !== '-'} onClick={() => edit('delete_gap')}>Delete this gap</button></div>
          {a.lastEdit && <div className="small muted">Last manual edit: {a.lastEdit.summary}. The automatic alignment remains in the history.</div>}
          <AlignmentBlocks labels={a.labels} rows={a.rows} roles={a.roles ?? {}} consensus={consensusOf(a.rows)} conservation={conservationOf(a.rows)} sel={sel} onSel={setSel} />
          <div className="row wrap"><a className="btn secondary sm" href={`/api/lab/${id}/export/fasta?what=alignment`}><Icon name="download" /> Alignment FASTA</a></div>
        </>)}
      <PairwiseCard />
    </Section>
  );
}
function conservationOf(rows: string[]) { const L = rows[0].length, out: number[] = []; for (let c = 0; c < L; c++) { const m = new Map<string, number>(); for (const r of rows) m.set(r[c], (m.get(r[c]) ?? 0) + 1); out.push(Math.max(...m.values()) / rows.length); } return out; }
function consensusOf(rows: string[]) { const L = rows[0].length; let s = ''; for (let c = 0; c < L; c++) { const m = new Map<string, number>(); for (const r of rows) m.set(r[c], (m.get(r[c]) ?? 0) + 1); let top = '-', n = 0; for (const [k, v] of m) if (v > n) { top = k; n = v; } s += n / rows.length >= 0.5 ? top : '.'; } return s; }

// ------------------------------------------------------------------ NCBI matches
function HitAlignment({ h }: { h: any }) {
  const x = h.hsps?.[0];
  if (!x?.qseq) return <div className="small muted">The alignment text is stored only for the 25 best hits. Strand: {h.strand}. Aligned query {x?.queryFrom}–{x?.queryTo}, subject {x?.hitFrom}–{x?.hitTo}.</div>;
  const out = []; const W = 70;
  for (let i = 0; i < x.qseq.length; i += W) {
    const qs = x.qseq.slice(i, i + W), ms = x.midline.slice(i, i + W), hs = x.hseq.slice(i, i + W);
    out.push(<Fragment key={i}>{`Query ${String(x.queryFrom + i - gapsBefore(x.qseq, i)).padStart(5)}  ${qs}\n            ${ms}\nSbjct ${String(Math.min(x.hitFrom, x.hitTo) + i - gapsBefore(x.hseq, i)).padStart(5)}  ${hs}\n\n`}</Fragment>);
  }
  return <div><div className="small row wrap" style={{ marginBottom: 4 }}><Chip>{x.alignLen} aligned columns</Chip><Chip color="green">{h.identityPct}% identity</Chip><Chip>{h.mismatches} mismatches</Chip><Chip>{h.gaps} gaps</Chip><Chip color="sky">strand {h.strand}</Chip><span className="muted">query {x.queryFrom}–{x.queryTo} · subject {x.hitFrom}–{x.hitTo}</span></div><div className="alnpair">{out}</div></div>;
}
const gapsBefore = (s: string, i: number) => (s.slice(0, i).match(/-/g) ?? []).length;

export function Matches() {
  const { id, canEdit, go, ov } = useLab();
  const seqNow: string = ov.head.seq;
  const nFrac = ((seqNow.match(/[^ACGT]/g) ?? []).length) / Math.max(1, seqNow.length);
  const longestClean = Math.max(0, ...(seqNow.match(/[ACGT]+/g) ?? []).map((x) => x.length));
  const nRich = nFrac > 0.05 || longestClean < 28; // megablast needs 28 identical bases in a row to start a match
  const [f, setF] = useState({ minIdentity: '', minCoverage: '', maxEvalue: '', text: '', excludeEnvironmental: false, onePerSpecies: false, sort: 'bitScore' });
  const qs = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v !== '' && v !== false) qs.set(k, v === true ? '1' : String(v)); });
  const { data, loading } = useLabGet<any>(`/api/lab/${id}/hits?${qs}`);
  const [bp, setBp] = useState({ db: 'core_nt', program: nRich ? 'blastn' : 'megablast', hitlist: nRich ? '100' : '50', expect: nRich ? '10' : '0.05', entrez: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const job = useJobRunner();
  const rel = useJobRunner();
  const save = useJobRunner((status) => { if (status === 'completed') toast('Saved to your DNA table – open DNA Sequences to see the new rows.', 'ok'); });
  const [region, setRegion] = useState('aligned');
  const run = () => job.start(`/api/lab/${id}/blast`, { params: { db: bp.db, program: bp.program, hitlist: num(bp.hitlist, 50), expect: num(bp.expect, 0.05), entrez: bp.entrez.trim() || undefined } });
  const runSensitive = () => { setBp({ ...bp, program: 'blastn', hitlist: '100', expect: '10' }); return job.start(`/api/lab/${id}/blast`, { params: { db: bp.db, program: 'blastn', hitlist: 100, expect: 10, entrez: bp.entrez.trim() || undefined } }); };
  const toggle = (a: string) => setPicked((s) => { const n = new Set(s); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const useSelected = async () => { await rel.start(`/api/lab/${id}/relatives`, { params: { only: [...picked], maxRelatives: Math.max(picked.size, 1) } }); setPicked(new Set()); };
  return (
    <Section title={<Lbl k="blast">NCBI similarity search (BLAST)</Lbl>}>
      <div className="notice small">Searching: <b>{ov.name}</b> · version {ov.head.n} · {ov.head.length} bp{nFrac > 0 ? ` · ${(nFrac * 100).toFixed(1)}% N / ambiguous` : ''}. BLAST always uses this working sequence.</div>
      {nRich && <div className="notice warn small"><b>Hard-to-match sequence.</b> {(nFrac * 100).toFixed(1)}% of it is N / ambiguous and its longest unbroken stretch is {longestClean} bases. <b>Megablast</b> needs 28 identical bases in a row to start a match, so it would probably return nothing; <b>blastn</b> (more sensitive) and an E-value of 10 are pre-selected. BLAST also counts every N as a mismatch, so identities look lower than they are. {ov.meta?.source === 'merged' ? '' : 'If you have the reverse read, merge the two reads first (Cleaning → Merge): the other read fills in most of the N’s.'}</div>}
      <div className="panel"><div className="pb col">
        <div className="formgrid">
          <label className="field"><Lbl k="blastDb">Database</Lbl><select className="select" value={bp.db} onChange={(e) => setBp({ ...bp, db: e.target.value })}>{[['core_nt', 'core_nt – nucleotide collection (recommended)'], ['nt', 'nt – all nucleotide'], ['refseq_rna', 'refseq_rna – RefSeq RNA']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><Lbl k="megablast">Program</Lbl><select className="select" value={bp.program} onChange={(e) => setBp({ ...bp, program: e.target.value })}><option value="megablast">Megablast (highly similar)</option><option value="blastn">blastn (more sensitive, slower)</option></select></label>
          <label className="field"><Lbl k="hitlist">Max hits</Lbl><input className="input" type="number" min={5} max={200} value={bp.hitlist} onChange={(e) => setBp({ ...bp, hitlist: e.target.value })} /></label>
          <label className="field"><Lbl k="evalueThreshold">E-value threshold</Lbl><input className="input" type="number" step="any" value={bp.expect} onChange={(e) => setBp({ ...bp, expect: e.target.value })} /></label>
          <label className="field" style={{ gridColumn: 'span 2' }}><Lbl k="taxonRestricted">Restrict by Entrez query (optional)</Lbl><input className="input" placeholder="e.g. txid7742[Organism:exp]" value={bp.entrez} onChange={(e) => setBp({ ...bp, entrez: e.target.value })} /></label>
        </div>
        <div className="row wrap"><button className="btn" disabled={!canEdit || job.running} onClick={run}><Icon name="play" /> {data?.op ? 'Run a new search (keeps previous)' : 'Run BLAST'}</button><span className="small muted">Sends your working sequence to NCBI. Typically 1–3 minutes; progress below reports NCBI’s status.</span></div>
        {job.view}
      </div></div>
      {loading && !data ? <Spinner /> : !data?.op ? <Empty title="No BLAST search yet" /> : (
        <>
          <div className="row wrap small"><Chip color="blue">{data.total} hit(s)</Chip><span className="muted">searched {ago(data.op.dbRetrievedAt ?? data.op.createdAt)} · query “{data.query?.name}”{data.query?.version ? ` v${data.query.version}` : ''}, {data.op.queryLength} bp · database {data.op.params.db} · {data.op.params.program} · request {data.op.rid}</span></div>
          {data.op.status === 'failed' && <div className="notice err">Latest search failed.</div>}
          {data.total === 0 && data.op.status !== 'failed' && <div className="notice warn"><b>BLAST found no hits for this search.</b> Common reasons: {data.op.params.program === 'megablast' ? <><b>megablast</b> cannot start a match without 28 identical bases in a row{nRich ? ' (this sequence has many N’s)' : ''}; </> : null}the E-value threshold ({data.op.params.expect}) was too strict; the Entrez restriction excluded everything; or the sequence is too short or too ambiguous. {data.op.params.program === 'megablast' && <div style={{ marginTop: 6 }}><button className="btn sm" disabled={!canEdit || job.running} onClick={runSensitive}>Run blastn instead (more sensitive, E-value 10)</button></div>}</div>}
          {data.total > 0 && data.shown === 0 && <div className="notice warn">The filters below hide all {data.total} hits. <button className="btn secondary sm" onClick={() => setF({ minIdentity: '', minCoverage: '', maxEvalue: '', text: '', excludeEnvironmental: false, onePerSpecies: false, sort: 'bitScore' })}>Reset filters</button></div>}
          <div className="panel"><div className="pb">
            <div className="formgrid">
              <label className="field"><Lbl k="percentIdentity">Min identity %</Lbl><input className="input" type="number" min={0} max={100} value={f.minIdentity} onChange={(e) => setF({ ...f, minIdentity: e.target.value })} /></label>
              <label className="field"><Lbl k="queryCoverage">Min coverage %</Lbl><input className="input" type="number" min={0} max={100} value={f.minCoverage} onChange={(e) => setF({ ...f, minCoverage: e.target.value })} /></label>
              <label className="field"><Lbl k="evalue">Max E-value</Lbl><input className="input" type="number" step="any" value={f.maxEvalue} onChange={(e) => setF({ ...f, maxEvalue: e.target.value })} /></label>
              <label className="field">Organism / title contains<input className="input" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
              <label className="field"><Lbl k="ranking">Sort by</Lbl><select className="select" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}><option value="bitScore">Bit score</option><option value="identity">Identity</option><option value="coverage">Coverage</option><option value="evalue">E-value</option><option value="combined">Identity × coverage</option></select></label>
            </div>
            <div className="row wrap" style={{ marginTop: 8 }}><label className="check"><input type="checkbox" checked={f.excludeEnvironmental} onChange={(e) => setF({ ...f, excludeEnvironmental: e.target.checked })} /><Lbl k="excludeEnvironmental">Hide uncultured / unresolved names</Lbl></label><label className="check"><input type="checkbox" checked={f.onePerSpecies} onChange={(e) => setF({ ...f, onePerSpecies: e.target.checked })} /><Lbl k="onePerSpecies">One hit per species</Lbl></label><span className="small muted">Showing {data.shown} of {data.total}. {data.ranking}</span></div>
          </div></div>
          {data.hits.length > 0 && <div className="row wrap small"><button className="btn ghost sm" onClick={() => setPicked(picked.size === data.hits.length ? new Set() : new Set(data.hits.map((h: any) => h.accession)))}>{picked.size === data.hits.length ? 'Clear selection' : `Select all ${data.hits.length} shown`}</button><span className="muted">Tick hits to keep them: as close relatives, or as real records in your DNA table.</span></div>}
          {picked.size > 0 && <div className="notice row wrap"><b>{picked.size}</b> selected <button className="btn sm" disabled={!canEdit || save.running} onClick={() => save.start(`/api/lab/${id}/hits/save`, { accessions: [...picked], region })}><Icon name="database" /> Save to the DNA table</button><label className="row small">Store<select className="select" style={{ width: 'auto' }} aria-label="Which part of each hit to store" value={region} onChange={(e) => setRegion(e.target.value)}><option value="aligned">the aligned region (like your sequence)</option><option value="whole">the whole GenBank record (up to 30 kb)</option></select></label><button className="btn sm" disabled={!canEdit || rel.running} onClick={useSelected}>Use selected as close relatives</button><button className="btn ghost sm" onClick={() => setPicked(new Set())}>Clear</button><span className="small muted">Their aligned regions are retrieved from NCBI and become the ingroup (previous dataset versions are kept).</span></div>}
          {rel.view}{save.view}
          <div className="panel" style={{ overflow: 'auto' }}><table className="t"><thead><tr><th /><th>#</th><th>Organism / record</th><th><Lbl k="percentIdentity">Identity</Lbl></th><th><Lbl k="queryCoverage">Coverage</Lbl></th><th><Lbl k="mismatches">Mism.</Lbl></th><th><Lbl k="gaps">Gaps</Lbl></th><th><Lbl k="evalue">E-value</Lbl></th><th><Lbl k="bitScore">Bits</Lbl></th><th><Lbl k="strand">Strand</Lbl></th></tr></thead><tbody>
            {data.hits.map((h: any, i: number) => (
              <Fragment key={h.accession}>
                <tr className={`hitrow${open === h.accession ? ' sel' : ''}`} onClick={() => setOpen(open === h.accession ? null : h.accession)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${h.accession}`} checked={picked.has(h.accession)} onChange={() => toggle(h.accession)} /></td>
                  <td>{i + 1}</td>
                  <td><b>{h.organism}</b>{h.environmental && <> <Hint k="excludeEnvironmental"><Chip color="amber">unresolved name</Chip></Hint></>}<div className="small muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><a href={ncbiUrl(h.accession)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{h.accession}</a> · {h.title}</div></td>
                  <td>{h.identityPct}%</td><td>{h.coveragePct}%</td><td>{h.mismatches}</td><td>{h.gaps}</td><td>{h.evalue === 0 ? '0.0' : Number(h.evalue).toExponential(1)}</td><td>{h.bitScore}</td><td>{h.strand}</td>
                </tr>
                {open === h.accession && <tr><td /><td colSpan={9}><HitAlignment h={h} /></td></tr>}
              </Fragment>))}
          </tbody></table></div>
          <div className="row wrap"><button className="btn secondary sm" onClick={() => go('relatives')}>Next: related species →</button></div>
        </>)}
    </Section>
  );
}

// ------------------------------------------------------------------ Related species (dataset)
export function MemberTable({ members, onRemove, onRole, canEdit }: { members: any[]; onRemove?: (ids: string[]) => void; onRole?: (ids: string[], role: string) => void; canEdit: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="panel" style={{ overflow: 'auto' }}><table className="t"><thead><tr><th><Lbl k="ingroup">Role</Lbl></th><th>Organism / record</th><th><Lbl k="percentIdentity">Identity</Lbl></th><th><Lbl k="queryCoverage">Coverage</Lbl></th><th>Length</th><th><Lbl k="homologousRegion">Region</Lbl></th><th /></tr></thead><tbody>
      {members.map((m) => (
        <Fragment key={m.id}>
          <tr className="hitrow" onClick={() => setOpen(open === m.id ? null : m.id)}>
            <td><Chip color={m.role === 'query' ? 'amber' : m.role === 'outgroup' ? 'gray' : 'blue'}>{m.role}</Chip></td>
            <td><b>{m.organism}</b><div className="small muted">{m.accession ? <a href={ncbiUrl(m.accession)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{m.accession}</a> : 'your sequence'}{m.source === 'manual' ? ' · added manually' : ''}</div></td>
            <td>{m.identityPct != null ? `${m.identityPct}%` : '—'}</td><td>{m.coveragePct != null ? `${m.coveragePct}%` : '—'}</td><td>{m.length}</td>
            <td className="small muted">{m.region ? `${m.region.from}–${m.region.to} (${m.region.strand})` : '—'}</td>
            <td onClick={(e) => e.stopPropagation()}>{canEdit && m.role !== 'query' && <div className="row"><button className="btn ghost sm" onClick={() => onRole?.([m.id], m.role === 'outgroup' ? 'ingroup' : 'outgroup')}>Make {m.role === 'outgroup' ? 'ingroup' : 'outgroup'}</button><button className="btn ghost sm" onClick={() => onRemove?.([m.id])} aria-label={`Remove ${m.accession ?? m.organism}`}><Icon name="trash" size={14} /></button></div>}</td>
          </tr>
          {open === m.id && <tr><td /><td colSpan={6}><div className="small"><b>Why it is in the dataset</b><ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{m.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>{m.lineage?.length > 0 && <div className="muted" style={{ marginTop: 4 }}>Lineage: {m.lineage.filter((l: any) => l.rank !== 'no rank' && l.rank !== 'clade').map((l: any) => `${l.name} (${l.rank})`).join(' › ')}</div>}</div></td></tr>}
        </Fragment>))}
    </tbody></table></div>
  );
}

function SpeciesCard({ species }: { species: any }) {
  const { id, canEdit } = useLab();
  const [names, setNames] = useState('');
  const [role, setRole] = useState('ingroup');
  const job = useJobRunner();
  const list = names.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="panel"><div className="pb col">
      <b><Lbl k="speciesByName">Add species by name</Lbl></b>
      <div className="small muted">Type scientific names – VierStation finds each in NCBI Taxonomy and collects the sequence of that species which matches your sequence best (a BLAST limited to that taxon), cut to the same region.</div>
      <textarea className="input" rows={3} aria-label="Species names" placeholder={'Trichoderma harzianum\nTrichoderma viride, Fusarium oxysporum'} value={names} onChange={(e) => setNames(e.target.value)} />
      <div className="row wrap">
        <label className="field" style={{ maxWidth: 220 }}>Add as<select className="select" value={role} onChange={(e) => setRole(e.target.value)}><option value="ingroup">Related species (ingroup)</option><option value="outgroup">Outgroup</option></select></label>
        <button className="btn" disabled={!canEdit || job.running || !list.length || list.length > 12} onClick={async () => { await job.start(`/api/lab/${id}/species`, { names: list, role }); setNames(''); }}><Icon name="play" /> Collect {list.length || ''} species</button>
        <span className="small muted">{list.length > 12 ? 'At most 12 per request. ' : ''}About a minute per species (one NCBI search each).</span>
      </div>
      {job.view}
      {species?.notes?.length > 0 && !job.running && (
        <div className="small"><b>Last request</b> ({ago(species.createdAt)}){species.status === 'failed' && <span className="notice warn"> {species.error}</span>}
          <ul>{species.notes.map((n: any, i: number) => <li key={i}><b>{n.name}</b> – {n.status === 'added' ? 'added: ' : n.status === 'not_found' ? 'not found: ' : 'not added: '}{n.detail}</li>)}</ul></div>)}
    </div></div>
  );
}

export function Relatives() {
  const { id, canEdit, bump, go } = useLab();
  const { data: ds, loading } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const { data: bl } = useLabGet<any>(`/api/lab/${id}/hits?limit=1`);
  const [p, setP] = useState({ maxRelatives: '10', minCoverage: '80', minIdentity: '70', maxPerGenus: '4', excludeEnvironmental: true, broaden: false });
  const [acc, setAcc] = useState('');
  const job = useJobRunner();
  const run = () => job.start(`/api/lab/${id}/relatives`, { params: { maxRelatives: num(p.maxRelatives, 10), minCoverage: num(p.minCoverage, 80), minIdentity: num(p.minIdentity, 70), maxPerGenus: num(p.maxPerGenus, 4), excludeEnvironmental: p.excludeEnvironmental, broaden: p.broaden } });
  const edit = async (body: Record<string, unknown>, msg: string) => { await act(() => post(`/api/lab/${id}/dataset`, body), msg); bump(); };
  return (
    <Section title={<Lbl k="relatives">Related species</Lbl>}>
      {!bl?.op && <div className="notice warn">Run an NCBI search first (NCBI matches) – close relatives are selected from its hits.</div>}
      <div className="panel"><div className="pb col">
        <div className="formgrid">
          <label className="field"><Lbl k="maxRelatives">Max relatives</Lbl><input className="input" type="number" min={1} max={30} value={p.maxRelatives} onChange={(e) => setP({ ...p, maxRelatives: e.target.value })} /></label>
          <label className="field"><Lbl k="minCoverage">Min coverage %</Lbl><input className="input" type="number" value={p.minCoverage} onChange={(e) => setP({ ...p, minCoverage: e.target.value })} /></label>
          <label className="field"><Lbl k="minIdentity">Min identity %</Lbl><input className="input" type="number" value={p.minIdentity} onChange={(e) => setP({ ...p, minIdentity: e.target.value })} /></label>
          <label className="field"><Lbl k="maxPerGenus">Max per genus</Lbl><input className="input" type="number" min={1} value={p.maxPerGenus} onChange={(e) => setP({ ...p, maxPerGenus: e.target.value })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={p.excludeEnvironmental} onChange={(e) => setP({ ...p, excludeEnvironmental: e.target.checked })} /><Lbl k="excludeEnvironmental">Exclude uncultured / unresolved names</Lbl></label>
        <label className="check"><input type="checkbox" checked={p.broaden} onChange={(e) => setP({ ...p, broaden: e.target.checked })} /><Lbl k="broadenGenus">Also search the best match’s genus for other species (extra NCBI search)</Lbl></label>
        <div className="row wrap"><button className="btn" disabled={!canEdit || job.running || !bl?.op} onClick={run}><Icon name="play" /> {ds?.members?.length ? 'Rebuild from BLAST hits (new version)' : 'Retrieve close relatives'}</button><span className="small muted">One sequence per species, the aligned region only, same orientation as your query. Outgroups already chosen are kept.</span></div>
        {job.view}
      </div></div>
      <SpeciesCard species={ds?.species} />
      {loading && !ds ? <Spinner /> : !ds?.members?.length ? <Empty title="No dataset yet" /> : (
        <>
          <div className="row wrap small"><Hint k="datasetVersion"><Chip color="blue">dataset version {ds.history.length}</Chip></Hint><span className="muted">{ds.members.length} sequences · updated {ago(ds.createdAt)}</span></div>
          <MemberTable members={ds.members} canEdit={canEdit} onRemove={(ids) => edit({ action: 'remove', ids }, 'Removed (new dataset version)')} onRole={(ids, role) => edit({ action: 'set_role', ids, role }, 'Role changed (new dataset version)')} />
          <div className="panel"><div className="pb row wrap"><b className="small">Add a sequence by accession</b><input className="input" style={{ maxWidth: 220 }} placeholder="e.g. NC_012920 or MN908947.3" value={acc} onChange={(e) => setAcc(e.target.value)} /><button className="btn secondary sm" disabled={!canEdit || !acc.trim()} onClick={async () => { await edit({ action: 'add_accession', accession: acc.trim(), role: 'ingroup' }, 'Added (oriented like your sequence)'); setAcc(''); }}>Add as ingroup</button><span className="small muted">The whole record is used; it is reverse-complemented automatically if it matches the opposite strand.</span></div></div>
          {ds.excluded?.length > 0 && <details><summary className="small"><b>{ds.excluded.length}</b> candidate(s) were not used – with the reason for each</summary><table className="t" style={{ marginTop: 6 }}><tbody>{ds.excluded.map((e: any, i: number) => <tr key={i}><td>{e.organism}<div className="small muted">{e.accession}</div></td><td className="small">{e.reason}</td></tr>)}</tbody></table></details>}
          <details><summary className="small">Dataset history ({ds.history.length} versions)</summary><ul className="small">{ds.history.map((h: any) => <li key={h.id}>{h.name} · {fmtDate(h.at, true)}{h.automatic ? ' · automatic' : ''}</li>)}</ul></details>
          <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => go('outgroups')}>Next: outgroups →</button>
        </>)}
    </Section>
  );
}

// ------------------------------------------------------------------ Outgroups
export function Outgroups() {
  const { id, canEdit, bump, go } = useLab();
  const { data: ds, loading } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const job = useJobRunner();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const og = ds?.outgroupAssistant;
  const current = ds?.members?.filter((m: any) => m.role === 'outgroup') ?? [];
  const accept = async () => { await act(() => post(`/api/lab/${id}/dataset`, { action: 'add_candidates', opId: og.opId, ids: [...chosen], role: 'outgroup' }), 'Outgroups added (new dataset version)'); setChosen(new Set()); bump(); };
  return (
    <Section title={<Lbl k="outgroup">Outgroups</Lbl>}>
      <div className="notice small"><Lbl k="outgroupAssistant">The assistant</Lbl> proposes up to five sequences from a <Lbl k="sisterLineage">sister lineage</Lbl> using a taxon-restricted BLAST. Nothing is added until you accept it, and if fewer than five suitable candidates exist it says so.</div>
      <div className="row wrap"><button className="btn" disabled={!canEdit || job.running || !ds?.members?.some((m: any) => m.role === 'ingroup')} onClick={() => job.start(`/api/lab/${id}/outgroups`, { params: { max: 5 } })}><Icon name="play" /> {og ? 'Search again (keeps previous)' : 'Find outgroup candidates'}</button>{!ds?.members?.some((m: any) => m.role === 'ingroup') && <span className="small muted">Build the related-species dataset first.</span>}</div>
      {job.view}
      {loading && !ds ? <Spinner /> : null}
      {current.length > 0 && <><h3>Outgroups in the dataset ({current.length})</h3><MemberTable members={current} canEdit={canEdit} onRemove={async (ids) => { await act(() => post(`/api/lab/${id}/dataset`, { action: 'remove', ids })); bump(); }} onRole={async (ids, role) => { await act(() => post(`/api/lab/${id}/dataset`, { action: 'set_role', ids, role })); bump(); }} /></>}
      {og && (
        <>
          <h3>Assistant result <span className="muted small">({ago(og.createdAt)})</span></h3>
          {og.scopes ? <div className="small col" style={{ gap: 2 }}><div>Ingroup clade: <b>{og.scopes.ingroup.name}</b> ({og.scopes.ingroup.rank}) · searched for sequences <i>outside</i> it, inside the wider clade(s) below:</div>{(og.rounds ?? [{ scope: og.scopes.outside, entrez: og.entrez, found: og.candidates.length }]).map((r: any, i: number) => <div key={i} className="muted">{i + 1}. <b>{r.scope.name}</b> ({r.scope.rank}) – NCBI query <code className="mono">{r.entrez}</code> · {r.found} candidate(s)</div>)}</div> : <div className="small muted">Scopes were given manually.</div>}
          {og.warnings?.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
          {og.candidates.length === 0 ? <Empty title="No suitable outgroup candidates" /> : (
            <div className="col">{og.candidates.map((c: any) => { const already = current.some((m: any) => m.id === c.id); return (
              <label key={c.id} className="panel" style={{ display: 'flex', gap: 10, padding: '10px 12px', opacity: already ? 0.6 : 1 }}>
                <input type="checkbox" disabled={already || !canEdit} checked={chosen.has(c.id) || already} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                <div className="grow"><b>{c.organism}</b> <a className="small" href={ncbiUrl(c.accession)} target="_blank" rel="noreferrer noopener">{c.accession}</a> <Chip color="gray">{c.identityPct}% identity</Chip> <Chip color="gray">{c.coveragePct}% coverage</Chip> {already && <Chip color="green">in dataset</Chip>}
                  <ul className="small muted" style={{ margin: '4px 0 0 18px', padding: 0 }}>{c.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></div></label>); })}
              <div className="row"><button className="btn" disabled={!canEdit || chosen.size === 0} onClick={accept}>Use {chosen.size || ''} selected as outgroup{chosen.size === 1 ? '' : 's'}</button></div></div>)}
          {og.excluded?.length > 0 && <details><summary className="small"><b>{og.excluded.length}</b> hit(s) not offered</summary><table className="t" style={{ marginTop: 6 }}><tbody>{og.excluded.map((e: any, i: number) => <tr key={i}><td>{e.organism}<div className="small muted">{e.accession}</div></td><td className="small">{e.reason}</td></tr>)}</tbody></table></details>}
        </>)}
      <div className="row wrap"><button className="btn secondary sm" onClick={() => go('alignment')}>Next: alignment →</button></div>
    </Section>
  );
}
void HelpTip;
