// Pick existing DNA records for the Sequence Lab: "open a record from the DNA table" and "merge a forward and a reverse read into one record".
import { useEffect, useMemo, useState } from 'react';
import { get, post } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import { toast, useSession } from '../../lib/store.ts';
import { Chip, Modal, Spinner, ago } from '../common.tsx';
import { Lbl } from '../Tip.tsx';

interface DnaRec { id: string; name: string; length: number; inLab: boolean; table: string; merged: boolean; mergedInto: boolean; updatedAt: string }
function useDnaRecords() {
  const { projectId } = useSession((s) => ({ projectId: s.projectId }));
  const [list, setList] = useState<DnaRec[] | null>(null);
  useEffect(() => { get(`/api/lab/dna-records${projectId ? `?project=${projectId}` : ''}`).then((r) => setList(r.records), () => setList([])); }, [projectId]);
  return list;
}
const short = (id: string) => id.slice(-6);

/** Open a record that already exists in the DNA table. */
export function PickDialog({ onClose }: { onClose: () => void }) {
  const list = useDnaRecords();
  const [text, setText] = useState('');
  const shown = useMemo(() => (list ?? []).filter((r) => !text || `${r.name} ${r.id}`.toLowerCase().includes(text.toLowerCase())), [list, text]);
  return (
    <Modal title="Open a sequence from your DNA table" onClose={onClose} footer={<button className="btn secondary" onClick={onClose}>Close</button>}>
      <div className="col">
        <div className="small muted">These are the DNA records of this project. Opening one starts its Sequence Lab history (its current sequence becomes the immutable raw version). Protein records are not listed: the lab’s alignment and tree models are for nucleotides.</div>
        <input className="input" aria-label="Search records" placeholder="Search by name or record id…" value={text} onChange={(e) => setText(e.target.value)} />
        {list === null ? <Spinner /> : shown.length === 0 ? <div className="muted small">No DNA records found.</div> : (
          <div className="panel" style={{ maxHeight: 360, overflow: 'auto' }}><table className="t"><thead><tr><th>Sequence</th><th>Length</th><th>Status</th><th>Changed</th></tr></thead><tbody>
            {shown.map((r) => <tr key={r.id} className="hitrow" onClick={() => { onClose(); navigate(`/lab/${r.id}`); }}><td><b>{r.name}</b><div className="small muted">#{short(r.id)} · {r.table}</div></td><td>{r.length}</td><td>{r.merged ? <Chip color="blue">merged</Chip> : r.mergedInto ? <Chip color="gray">part of a merge</Chip> : r.inLab ? <Chip color="green">in the lab</Chip> : <Chip color="gray">not opened yet</Chip>}</td><td className="muted small">{ago(r.updatedAt)}</td></tr>)}
          </tbody></table></div>)}
      </div>
    </Modal>
  );
}

/** Combine a forward and a reverse read into ONE new record; the two reads stay untouched. */
export function MergeDialog({ forwardId, onClose }: { forwardId?: string; onClose: () => void }) {
  const list = useDnaRecords();
  const [fwd, setFwd] = useState(forwardId ?? '');
  const [mode, setMode] = useState<'record' | 'paste'>('record');
  const [rev, setRev] = useState('');
  const [text, setText] = useState('');
  const [orientation, setOrientation] = useState('auto');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const reads = (list ?? []).filter((r) => !r.merged);
  const f = reads.find((r) => r.id === fwd), r = reads.find((x) => x.id === rev);
  const defaultName = f && (mode === 'record' ? r : true) ? `Merged: ${f.name} (${short(f.id)}) + ${mode === 'record' ? `${r!.name} (${short(r!.id)})` : `${f.name}_reverse (new)`}` : 'Merged: <forward> (id) + <reverse> (id)';
  const can = !!fwd && (mode === 'record' ? !!rev && rev !== fwd : text.replace(/>.*\n?/g, '').replace(/\s/g, '').length >= 30);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await post('/api/lab/merge-pair', { forwardRecordId: fwd, ...(mode === 'record' ? { reverseRecordId: rev } : { reverseText: text }), orientation, name: name.trim() || undefined });
      toast(`Created “${res.name}” – ${res.summary}${res.warnings?.length ? ` – ${res.warnings[0]}` : ''}`, 'ok');
      onClose(); navigate(`/lab/${res.recordId}`);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Merge forward + reverse read" size="wide" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !can} onClick={submit}>{busy ? 'Merging…' : 'Create merged sequence'}</button></>}>
      <div className="col">
        <div className="notice small">The two reads are aligned where they overlap and combined into <b>one new sequence</b>: an N or ambiguity code takes the real base of the other read, and parts only one read covers are kept. Your forward and reverse records stay unchanged in the DNA table; the merged sequence is what you open and BLAST next.</div>
        {list === null ? <Spinner /> : (
          <>
            <label className="field">Forward read (a DNA record)<select className="select" value={fwd} onChange={(e) => setFwd(e.target.value)}><option value="">Choose…</option>{reads.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.length} bp · #{short(x.id)}</option>)}</select></label>
            <div className="tabs" style={{ margin: 0 }}><button className={mode === 'record' ? 'on' : ''} onClick={() => setMode('record')}>Reverse read from the DNA table</button><button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>Paste the reverse read</button></div>
            {mode === 'record'
              ? <label className="field">Reverse read (a DNA record)<select className="select" value={rev} onChange={(e) => setRev(e.target.value)}><option value="">Choose…</option>{reads.filter((x) => x.id !== fwd).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.length} bp · #{short(x.id)}</option>)}</select></label>
              : <label className="field">Reverse read (FASTA or plain sequence, as it came from the sequencer)<textarea className="textarea mono" rows={5} aria-label="Reverse read" placeholder={'>sample_R\nACGT…'} value={text} onChange={(e) => setText(e.target.value)} /></label>}
            <div className="formgrid">
              <label className="field"><Lbl k="mergeOrientation">Orientation of the reverse read</Lbl><select className="select" value={orientation} onChange={(e) => setOrientation(e.target.value)}><option value="auto">Automatic (best overlap)</option><option value="reverse_complement">Reverse-complement it</option><option value="as_is">Use as given</option></select></label>
              <label className="field">Name of the merged sequence (optional)<input className="input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} /></label>
            </div>
            <div className="small muted">Without a name it is called <b>{defaultName}</b> – the record ids make it traceable even if the reads were not named.</div>
          </>)}
      </div>
    </Modal>
  );
}
