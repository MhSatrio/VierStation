// Sequence Lab sections 3: Phylogenetic tree, Final identification, Workflow history, Exports.
import { useMemo, useState } from 'react';
import { get, post } from '../../lib/api.ts';
import { Chip, Empty, Modal, Spinner, ago, copyText, fmtDate } from '../common.tsx';
import { Icon } from '../icons.tsx';
import { toast } from '../../lib/store.ts';
import { HelpTip, Hint, Lbl } from '../Tip.tsx';
import { Section, act, useJobRunner, useLab, useLabGet } from './useLab.tsx';
import { TreeViewer } from './TreeViewer.tsx';
import type { MemberInfo } from './TreeViewer.tsx';

const num = (v: string, d: number) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// ------------------------------------------------------------------ Tree
export function TreeSection() {
  const { id, canEdit, go } = useLab();
  const [opId, setOpId] = useState<string | null>(null);
  const { data: t, loading } = useLabGet<any>(`/api/lab/${id}/tree${opId ? `?op=${opId}` : ''}`, [opId]);
  const { data: ds } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const { data: al } = useLabGet<any>(`/api/lab/${id}/alignment`);
  const [p, setP] = useState({ method: 'nj', distance: 'k2p', useGamma: false, gamma: '1', mlModel: 'HKY85', mlGamma: true, gap: 'pairwise', cutoff: '5', bootstrap: '100', seed: '12345', rooting: 'outgroup' });
  const job = useJobRunner(() => setOpId(null));
  const distMethod = ['nj', 'upgma', 'me'].includes(p.method);
  const run = () => job.start(`/api/lab/${id}/tree`, { params: { method: p.method, distance: p.distance, gamma: distMethod && p.useGamma ? num(p.gamma, 1) : null, mlModel: p.mlModel, mlGamma: p.mlGamma, gap: p.gap === 'partial' ? { mode: 'partial', cutoff: num(p.cutoff, 5) } : { mode: p.gap }, bootstrap: num(p.bootstrap, 100), seed: num(p.seed, 12345), rooting: p.method === 'upgma' ? 'unrooted' : p.rooting } });
  const members: Record<string, MemberInfo> = useMemo(() => Object.fromEntries((ds?.members ?? []).map((m: any) => [m.label, { organism: m.organism, accession: m.accession, role: m.role }])), [ds]);
  const r = t?.result;
  const it = r?.interpretation;
  const outgroups = Object.entries(al?.roles ?? {}).filter(([, v]) => v === 'outgroup').length;
  const query = Object.entries(r?.roles ?? al?.roles ?? {}).find(([, v]) => v === 'query')?.[0] ?? null;
  return (
    <Section title={<Lbl k="tree">Phylogenetic tree</Lbl>}>
      {!al?.op && <div className="notice warn">Align the sequences first – the tree is built from the current alignment{al?.manualEdits ? ' (including your manual edits)' : ''}.</div>}
      <div className="panel"><div className="pb col">
        <div className="formgrid">
          <label className="field"><Lbl k="tree">Method</Lbl><select className="select" value={p.method} onChange={(e) => setP({ ...p, method: e.target.value })}><option value="nj">Neighbor-joining</option><option value="upgma">UPGMA</option><option value="me">Minimum evolution</option><option value="mp">Maximum parsimony</option><option value="ml">Maximum likelihood</option></select></label>
          {distMethod && <label className="field"><Lbl k="distanceModel">Distance model</Lbl><select className="select" value={p.distance} onChange={(e) => setP({ ...p, distance: e.target.value })}><option value="p">p-distance</option><option value="jc69">Jukes–Cantor</option><option value="k2p">Kimura 2-parameter</option><option value="tn93">Tamura–Nei</option></select></label>}
          {p.method === 'ml' && <label className="field"><Lbl k="mlModel">Substitution model</Lbl><select className="select" value={p.mlModel} onChange={(e) => setP({ ...p, mlModel: e.target.value })}><option value="JC69">JC69</option><option value="K80">K80</option><option value="F81">F81</option><option value="HKY85">HKY85</option></select></label>}
          <label className="field"><Lbl k="gapTreatment">Gaps / missing data</Lbl><select className="select" value={p.gap} onChange={(e) => setP({ ...p, gap: e.target.value })}><option value="pairwise">Pairwise deletion</option><option value="complete">Complete deletion</option><option value="partial">Partial deletion</option></select></label>
          {p.gap === 'partial' && <label className="field"><Lbl k="partialDeletion">Cutoff % gaps</Lbl><input className="input" type="number" min={0} max={100} value={p.cutoff} onChange={(e) => setP({ ...p, cutoff: e.target.value })} /></label>}
          <label className="field"><Lbl k="bootstrapReplicates">Bootstrap replicates</Lbl><input className="input" type="number" min={0} max={1000} value={p.bootstrap} onChange={(e) => setP({ ...p, bootstrap: e.target.value })} /></label>
          <label className="field"><Lbl k="seed">Random seed</Lbl><input className="input" type="number" min={0} value={p.seed} onChange={(e) => setP({ ...p, seed: e.target.value })} /></label>
          <label className="field"><Lbl k="rooting">Rooting</Lbl><select className="select" disabled={p.method === 'upgma'} value={p.method === 'upgma' ? 'unrooted' : p.rooting} onChange={(e) => setP({ ...p, rooting: e.target.value })}><option value="outgroup">Outgroup{outgroups ? ` (${outgroups} in dataset)` : ' (none in dataset)'}</option><option value="midpoint">Midpoint</option><option value="unrooted">Unrooted</option></select></label>
        </div>
        <div className="row wrap">
          {distMethod && <label className="check"><input type="checkbox" checked={p.useGamma} onChange={(e) => setP({ ...p, useGamma: e.target.checked })} /><Lbl k="gammaRates">Gamma rate variation</Lbl></label>}
          {distMethod && p.useGamma && <label className="row small">α <input className="input" style={{ width: 80 }} type="number" step="0.1" min={0.1} value={p.gamma} onChange={(e) => setP({ ...p, gamma: e.target.value })} /></label>}
          {p.method === 'ml' && <label className="check"><input type="checkbox" checked={p.mlGamma} onChange={(e) => setP({ ...p, mlGamma: e.target.checked })} /><Lbl k="mlGamma">Gamma rate variation (4 categories)</Lbl></label>}
        </div>
        {p.method === 'upgma' && <div className="notice small warn">UPGMA produces a rooted tree by construction and assumes a molecular clock, so the rooting option does not apply.</div>}
        {p.rooting === 'outgroup' && p.method !== 'upgma' && outgroups === 0 && <div className="notice small warn">No outgroup in the dataset – the tree will be shown unrooted. Choose outgroups first or switch to midpoint rooting.</div>}
        {p.method === 'ml' && <div className="small muted">Maximum likelihood bootstrapping is the slowest option; the built-in engine is meant for up to about 40 sequences.</div>}
        <div className="row wrap"><button className="btn" disabled={!canEdit || job.running || !al?.op} onClick={run}><Icon name="play" /> {r ? 'Build a new tree (keeps previous)' : 'Build tree'}</button></div>
        {job.view}
      </div></div>
      {loading && !t ? <Spinner /> : !r ? <Empty title="No tree yet" /> : (
        <>
          {t.history.length > 1 && <label className="row small">Tree version:<select className="select" style={{ width: 'auto' }} value={t.op.id} onChange={(e) => setOpId(e.target.value)}>{[...t.history].reverse().map((h: any) => <option key={h.id} value={h.id}>{h.name} · {fmtDate(h.at, true)} {h.status !== 'completed' ? `(${h.status})` : ''}</option>)}</select></label>}
          <div className="row wrap"><Chip color="blue">{r.method.toUpperCase()}</Chip><Chip>{r.labels.length} sequences</Chip><Chip>{r.sitesKept}/{r.sitesTotal} sites used</Chip><Hint k="variableSites"><Chip>{r.variableSites} variable</Chip></Hint><Hint k="informativeSites"><Chip>{r.informativeSites} informative</Chip></Hint><Chip color="sky">{r.rooting}</Chip>{r.bootstrapDone > 0 ? <Chip color="green">{r.bootstrapDone} bootstrap replicates</Chip> : <Chip color="amber">no bootstrap</Chip>}{r.score !== undefined && <Hint k={r.method === 'ml' ? 'lnL' : 'parsimonyScore'}><Chip color="gray">{r.scoreName}: {+Number(r.score).toPrecision(7)}</Chip></Hint>}</div>
          {r.model && <div className="small muted">Model: {Object.entries(r.model).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' · ')} <HelpTip k="aicBic" /></div>}
          <TreeViewer tree={r.tree} members={members} queryLabel={query} support={r.bootstrapDone > 0} filename={`tree_${r.method}`} />
          {it && (
            <div className="panel"><header><b>Interpretation</b><span className="muted small">generated from this tree – it describes the tree, it does not identify your sample</span></header><div className="pb col">
              <div>{it.statement}</div>
              {it.closestRelatives.length > 0 && <div className="small"><b>Nearest sequences by tree distance:</b> {it.closestRelatives.map((c: any) => `${c.organism}${c.accession ? ` (${c.accession})` : ''} – ${c.distance}`).join('; ')} <HelpTip k="patristicDistance" /></div>}
              {it.outgroupsFormOwnClade !== null && <div className="small"><Lbl k="monophyly">Outgroups form their own clade:</Lbl> <b>{it.outgroupsFormOwnClade ? 'yes' : 'no'}</b></div>}
              <details open><summary className="small"><b>What this cannot tell you</b></summary><ul className="small" style={{ margin: '4px 0 0 18px', padding: 0 }}>{it.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></details>
            </div></div>)}
          <div className="row wrap"><a className="btn secondary sm" href={`/api/lab/${id}/export/newick`}><Icon name="download" /> Newick</a><button className="btn secondary sm" onClick={() => go('exports')}>More exports</button><button className="btn secondary sm" onClick={() => go('final')}>Next: final identification →</button></div>
        </>)}
    </Section>
  );
}

// ------------------------------------------------------------------ Final identification
function RecordPreview({ accession, onClose }: { accession: string; onClose: () => void }) {
  const { id, bump } = useLab();
  const { data, error } = useLabGet<any>(`/api/lab/${id}/ncbi/preview?accession=${encodeURIComponent(accession)}`);
  const job = useJobRunner(() => { bump(); onClose(); });
  return (
    <Modal title={`NCBI record ${accession}`} size="wide" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Close without saving</button><button className="btn" disabled={!data || job.running} onClick={() => job.start(`/api/lab/${id}/ncbi/save`, { accession })}>Save this record to VierStation</button></>}>
      {error ? <div className="notice err">{error}</div> : !data ? <Spinner label="Fetching from NCBI…" /> : (
        <div className="col">
          <div><b>{data.definition}</b><div className="small muted">{data.accession} · {data.length.toLocaleString()} bp · {data.molType} · {data.topology} · {data.division} · updated {data.date}</div></div>
          <div className="small"><b>Organism:</b> {data.organism} (taxon {data.taxId}) · <span className="muted">{data.lineage}</span></div>
          <div className="small"><b>Features:</b> {Object.entries(data.featureCounts).map(([k, v]) => `${k} ×${v}`).join(', ')}</div>
          {data.genes.length > 0 && <div className="small"><b>Genes:</b> {data.genes.map((g: any) => g.symbol).join(', ')}</div>}
          {data.cds.length > 0 && <div className="small"><b>Proteins (CDS):</b> {data.cds.map((c: any) => c.product || c.proteinId).join('; ')}</div>}
          {data.references.length > 0 && <details><summary className="small"><b>{data.references.length} reference(s)</b></summary><ul className="small">{data.references.map((r: any, i: number) => <li key={i}>{r.authors}. <i>{r.title}</i>. {r.journal}{r.pubmed ? <> · <a href={`https://pubmed.ncbi.nlm.nih.gov/${r.pubmed}/`} target="_blank" rel="noreferrer noopener">PubMed {r.pubmed}</a></> : ''}</li>)}</ul></details>}
          {Object.keys(data.dblink).length > 0 && <div className="small"><b>Linked:</b> {Object.entries(data.dblink).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
          {data.truncated && <div className="notice warn small">The preview reads only the first 200 kb of this large record.</div>}
          <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="notice ok small"><b>Will be saved:</b><ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{data.willSave.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
            <div className="notice small"><b>Not changed:</b><ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{data.willNotSave.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
          </div>
          {job.view}
        </div>)}
    </Modal>
  );
}

export function Final() {
  const { id, canEdit, bump } = useLab();
  const { data: d, loading } = useLabGet<any>(`/api/lab/${id}/identification`);
  const [f, setF] = useState({ taxon: '', rank: 'species', confidence: 'moderate', notes: '', link: false });
  const { data: ds } = useLabGet<any>(`/api/lab/${id}/dataset`);
  const [acc, setAcc] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  if (loading && !d) return <Spinner />;
  const ev = d?.evidence;
  const match = (ds?.members ?? []).find((m: any) => m.taxId && m.organism.toLowerCase() === f.taxon.trim().toLowerCase());
  const save = async () => { const { link, ...body } = f; const r = await act(() => post(`/api/lab/${id}/identification`, { ...body, taxId: match?.taxId, linkOrganism: link && !!match && f.confidence !== 'inconclusive' }), (x: any) => x.organism ? 'Recorded, and linked to the Organism record as your conclusion' : 'Identification recorded in the workflow history'); if (r) bump(); };
  return (
    <Section title={<Lbl k="identification">Final identification</Lbl>}>
      <div className="notice small">{d?.note}</div>
      {d?.missing?.length > 0 && <div className="notice warn small">Not done yet: {d.missing.join(', ')}. You can still record a conclusion, but the evidence below is incomplete.</div>}
      <div className="cols2">
        <div className="panel"><header><b>BLAST evidence</b></header><div className="pb">{ev?.topHit ? <><div><b>{ev.topHit.organism}</b> <a className="small" href={`https://www.ncbi.nlm.nih.gov/nuccore/${ev.topHit.accession}`} target="_blank" rel="noreferrer noopener">{ev.topHit.accession}</a></div>
          <div className="row wrap" style={{ marginTop: 4 }}><Hint k="percentIdentity"><Chip color="green">{ev.topHit.identityPct}% identity</Chip></Hint><Hint k="queryCoverage"><Chip color="blue">{ev.topHit.coveragePct}% coverage</Chip></Hint><Hint k="evalue"><Chip>E={ev.topHit.evalue}</Chip></Hint></div>
          <div className="small muted" style={{ marginTop: 6 }}>Identity and coverage are separate: read both. A high identity over a short part of your sequence is weak evidence.</div></> : <span className="muted">No BLAST search yet.</span>}</div></div>
        <div className="panel"><header><b>Tree evidence</b></header><div className="pb">{ev?.tree ? <><div>{ev.tree.summary}</div><details style={{ marginTop: 6 }}><summary className="small">Limitations</summary><ul className="small">{ev.tree.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></details></> : <span className="muted">No tree yet.</span>}</div></div>
      </div>
      {d?.decided && <div className="notice ok"><b>Your recorded conclusion:</b> {d.decided.taxon || '(inconclusive)'} ({d.decided.rank}) · confidence {d.decided.confidence}{d.decided.notes && <div className="small">{d.decided.notes}</div>}<div className="small muted">Recorded {ago(d.decided.decidedAt)}. Recording again adds a new entry; the earlier one stays in the history.</div></div>}
      <div className="panel"><header><b>{d?.decided ? 'Update your conclusion' : 'Record your conclusion'}</b></header><div className="pb col">
        <div className="formgrid">
          <label className="field">Taxon<input className="input" placeholder="e.g. Alphus primus" value={f.taxon} onChange={(e) => setF({ ...f, taxon: e.target.value })} /></label>
          <label className="field">Rank<select className="select" value={f.rank} onChange={(e) => setF({ ...f, rank: e.target.value })}>{['species', 'genus', 'family', 'order', 'class', 'phylum'].map((r) => <option key={r}>{r}</option>)}</select></label>
          <label className="field"><Lbl k="confidence">Confidence</Lbl><select className="select" value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value })}><option value="high">High</option><option value="moderate">Moderate</option><option value="low">Low</option><option value="inconclusive">Inconclusive</option></select></label>
        </div>
        {match && f.confidence !== 'inconclusive' && <label className="check small"><input type="checkbox" checked={f.link} onChange={(e) => setF({ ...f, link: e.target.checked })} /> Also link this sequence to the Organism record for {match.organism} (NCBI taxon {match.taxId}). The link is marked “user supplied”: it records your conclusion, not a database confirmation.</label>}
        <label className="field">Notes (what supports or limits this conclusion)<textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <div><button className="btn" disabled={!canEdit} onClick={save}>Record conclusion</button></div>
      </div></div>
      <div className="panel"><header><Lbl k="fullRecord"><b>Fetch full NCBI record</b></Lbl></header><div className="pb row wrap">
        <input className="input" style={{ maxWidth: 240 }} placeholder={ev?.topHit?.accession ?? 'accession, e.g. KX000001.1'} value={acc} onChange={(e) => setAcc(e.target.value)} />
        <button className="btn secondary" disabled={!canEdit} onClick={() => setPreview((acc || ev?.topHit?.accession || '').trim() || null)}>Preview…</button><span className="small muted">Shows the record, references and what would be saved. Nothing is saved until you confirm.</span>
      </div></div>
      {preview && <RecordPreview accession={preview} onClose={() => setPreview(null)} />}
    </Section>
  );
}

// ------------------------------------------------------------------ History
const STEP_COLOR: Record<string, string> = { import: 'gray', clean: 'blue', blast: 'sky', dataset: 'sky', relatives: 'sky', outgroups: 'sky', align: 'blue', align_edit: 'amber', tree: 'green', identify: 'ink', history: 'gray', ncbi_record: 'sky' };
function CodeModal({ opId, onClose }: { opId: string | null; onClose: () => void }) {
  const { id } = useLab();
  const { data, error } = useLabGet<any>(`/api/lab/${id}/export/script?scope=${opId ? 'op' : 'workflow'}${opId ? `&op=${opId}` : ''}`);
  return (
    <Modal title={opId ? 'Code for this step' : 'Workflow script (Python)'} size="wide" onClose={onClose} footer={data && <><button className="btn secondary" onClick={async () => toast((await copyText(data.code)) ? 'Copied' : 'Copy failed', 'ok')}>Copy</button><a className="btn" href={`/api/lab/${id}/export/script?scope=${opId ? 'op' : 'workflow'}${opId ? `&op=${opId}` : ''}&download=1`}><Icon name="download" /> Download {data.filename}</a></>}>
      {error ? <div className="notice err">{error}</div> : !data ? <Spinner /> : (
        <div className="col">
          <div className={`notice small ${data.reproducible === 'exact' ? 'ok' : 'warn'}`}><b><Lbl k="reproducible">Reproducibility: {data.reproducible === 'exact' ? 'exact' : 'partial'}</Lbl></b>{data.notes.length > 0 && <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{data.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}</div>
          <div className="small muted">Requires Python with Biopython (<code>pip install biopython</code>). No API keys are used or needed.</div>
          <pre className="code">{data.code}</pre>
        </div>)}
    </Modal>
  );
}

export function History() {
  const { id } = useLab();
  const [step, setStep] = useState('');
  const { data } = useLabGet<any>(`/api/lab/${id}/ops${step ? `?step=${step}` : ''}`, [step]);
  const [code, setCode] = useState<string | null | undefined>(undefined);
  return (
    <Section title="Workflow history" right={<div className="row"><select aria-label="Filter by step" className="select" style={{ width: 'auto' }} value={step} onChange={(e) => setStep(e.target.value)}><option value="">All steps</option>{Object.keys(STEP_COLOR).map((s) => <option key={s}>{s}</option>)}</select></div>}>
      <div className="notice small">Every operation on this record is stored here with its parameters, tool, database and time – this list is the source of the exported change log and scripts. <Lbl k="automatic">Automatic</Lbl> steps are labelled.</div>
      {!data ? <Spinner /> : data.ops.length === 0 ? <Empty title="No operations yet" /> : [...data.ops].reverse().map((o: any) => <OpRow key={o.id} op={o} onCode={() => setCode(o.id)} />)}
      {code !== undefined && <CodeModal opId={code} onClose={() => setCode(undefined)} />}
    </Section>
  );
}
function OpRow({ op, onCode }: { op: any; onCode: () => void }) {
  const { id } = useLab();
  const [full, setFull] = useState<any>(null);
  const load = async () => { if (!full && op.result) { try { setFull((await get(`/api/lab/${id}/ops/${op.id}`)).op); } catch { /* ignore */ } } };
  const r = full?.result;
  return (
    <details className="timeline-op" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void load(); }}>
      <summary><Chip color={STEP_COLOR[op.step] ?? 'gray'}>{op.step}</Chip><b>{op.name}</b><Chip color={op.status === 'completed' ? 'green' : op.status === 'failed' ? 'red' : op.status === 'running' ? 'amber' : 'gray'}>{op.status}</Chip>{op.automatic && <Hint k="automatic"><Chip color="amber">automatic</Chip></Hint>}<span className="grow" /><span className="small muted">{op.actorName ?? 'system'} · {fmtDate(op.createdAt, true)}</span></summary>
      <div className="tb">
        {op.tool && <div className="small"><b>Tool:</b> {op.tool}{op.toolVersion ? ` v${op.toolVersion}` : ''}{op.dbSource ? ` · ${op.dbSource}` : ''}{op.dbRetrievedAt ? ` · retrieved ${fmtDate(op.dbRetrievedAt, true)}` : ''}</div>}
        {op.supersedes && <div className="small muted">Re-run of an earlier {op.step} step; the earlier result is kept.</div>}
        {op.changes?.summary && <div className="small">{op.changes.summary}</div>}
        {r?.summary && <div className="small">{r.summary}</div>}
        {r?.interpretation?.summary && <div className="small">{r.interpretation.summary}</div>}
        {op.error && <div className="notice err small">{op.error}</div>}
        {op.warnings?.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
        {Object.keys(op.params ?? {}).length > 0 && <details><summary className="small">Parameters</summary><pre className="code" style={{ maxHeight: 200 }}>{JSON.stringify(op.params, null, 2)}</pre></details>}
        {op.status === 'completed' && ['clean', 'blast', 'relatives', 'outgroups', 'dataset', 'align', 'align_edit', 'tree', 'import'].includes(op.step) && <div><button className="btn secondary sm" onClick={onCode}>Show code for this step</button></div>}
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ Exports
export function Exports() {
  const { id, ov } = useLab();
  const [md, setMd] = useState<string | null>(null);
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const hasAlign = !!ov.steps.align || !!ov.steps.align_edit;
  const files: [string, string, string, boolean][] = [['Raw sequence (FASTA)', `/api/lab/${id}/export/fasta?what=raw`, 'The sequence exactly as imported.', true], ['Current working sequence (FASTA)', `/api/lab/${id}/export/fasta?what=current`, 'After cleaning.', true], ['Dataset sequences (FASTA)', `/api/lab/${id}/export/fasta?what=dataset`, 'Query, relatives and outgroups (unaligned).', !!ov.dataset], ['Alignment (FASTA)', `/api/lab/${id}/export/fasta?what=alignment`, 'Including any manual edits.', hasAlign], ['Tree (Newick)', `/api/lab/${id}/export/newick`, 'Latest tree with bootstrap values on internal nodes.', !!ov.steps.tree], ['Tree image (SVG)', `/api/lab/${id}/export/tree-svg`, 'Vector drawing of the latest tree (opens in any browser, Inkscape, Illustrator).', !!ov.steps.tree], ['Full history (JSON)', `/api/lab/${id}/export/history`, 'All versions and operations with complete results.', true]];
  return (
    <Section title="Exports">
      <div className="panel"><header><Lbl k="pdfReport"><b>PDF report</b></Lbl></header><div className="pb row wrap"><div className="small muted grow">Everything in this workflow on a few pages: summary, quality, cleaning and read merge, BLAST hits, reference sequences, alignment, tree, limitations, identification, history and reproducibility. Built from the stored history; steps not run are stated as not run.</div><a className="btn" href={`/api/lab/${id}/export/report`}><Icon name="download" /> Download PDF</a></div></div>
      <div className="cols2">
        <div className="panel"><header><Lbl k="changeLog"><b>Change log (Markdown)</b></Lbl></header><div className="pb col"><div className="small muted">A readable report generated from the stored history: every step with time, parameters, tool, database and result.</div>
          <div className="row wrap"><a className="btn" href={`/api/lab/${id}/export/changelog`}><Icon name="download" /> Download .md</a><button className="btn secondary" onClick={async () => setMd((await get(`/api/lab/${id}/export/changelog-preview`)).markdown)}>Preview</button></div></div></div>
        <div className="panel"><header><Lbl k="workflowScript"><b>Workflow script (Python)</b></Lbl></header><div className="pb col"><div className="small muted">Repeats the workflow; each step states whether it reproduces exactly or what the closest alternative is. Single steps can be exported from the History.</div>
          <div className="row wrap"><button className="btn" onClick={() => setCode(null)}>View &amp; download…</button></div></div></div>
      </div>
      <div className="panel"><header><b>Data files</b></header><div className="pb"><table className="t"><tbody>{files.map(([t, h, d, ok]) => <tr key={t}><td><b>{t}</b><div className="small muted">{d}</div></td><td style={{ textAlign: 'right' }}>{ok ? <a className="btn secondary sm" href={h}><Icon name="download" /> Download</a> : <span className="muted small">not available yet</span>}</td></tr>)}</tbody></table>
        <div className="small muted" style={{ marginTop: 6 }}>Tree images (SVG/PNG) are exported from the tree viewer toolbar.</div></div></div>
      {md !== null && <Modal title="Change log preview" size="wide" onClose={() => setMd(null)} footer={<a className="btn" href={`/api/lab/${id}/export/changelog`}><Icon name="download" /> Download</a>}><pre className="code" style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh' }}>{md}</pre></Modal>}
      {code !== undefined && <CodeModal opId={code} onClose={() => setCode(undefined)} />}
    </Section>
  );
}
void post;
