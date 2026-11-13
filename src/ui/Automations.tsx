import { useCallback, useEffect, useState } from 'react';
import type { ActionType, AutomationSpec, ConditionType, TriggerType } from '../../shared/types.ts';
import { del, get, patch, post } from '../lib/api.ts';
import { toast, useEvent, useSession } from '../lib/store.ts';
import { Chip, Empty, Modal, Spinner, StatusChip, ago, confirmDialog } from './common.tsx';
import { Icon } from './icons.tsx';

interface Auto { id: string; name: string; enabled: boolean; tableId: string; tableName: string; spec: AutomationSpec; lastRunAt: string | null; runCount: number; template: string | null }
interface Tpl { id: string; name: string; description: string; kinds: string[] }
interface Opt { kind: string; fields: { id: string; name: string; type: string; choices?: { id: string; name: string }[] }[]; statusField: string | null }

const TRIGGERS: { v: TriggerType; l: string }[] = [
  { v: 'record_created', l: 'A record is created' }, { v: 'field_changed', l: 'A field changes' }, { v: 'status_changed', l: 'Status changes' }, { v: 'file_uploaded', l: 'A file is uploaded' },
  { v: 'fetch_completed', l: 'A fetch / discovery job completes' }, { v: 'analysis_completed', l: 'An analysis completes' }, { v: 'schedule', l: 'On a schedule' },
];
const CONDITIONS: { v: ConditionType; l: string }[] = [
  { v: 'accession_exists', l: 'Accession exists' }, { v: 'sequence_is_dna', l: 'Sequence type is DNA' }, { v: 'structure_unavailable', l: 'Protein structure is unavailable' }, { v: 'chemical_has_verified_target', l: 'Chemical has an experimentally verified protein target' },
  { v: 'processing_failed', l: 'Processing status is failed' }, { v: 'field_equals', l: 'Field equals…' }, { v: 'field_not_empty', l: 'Field is not empty' },
];
const ACTIONS: { v: ActionType; l: string; kinds?: string[] }[] = [
  { v: 'fetch_ncbi', l: 'Fetch from NCBI', kinds: ['dna', 'rna', 'gene'] }, { v: 'discover_genes', l: 'Find genes in DNA', kinds: ['dna', 'rna'] }, { v: 'search_uniprot', l: 'Search UniProt', kinds: ['gene', 'protein'] }, { v: 'discover_proteins', l: 'Find proteins for gene', kinds: ['gene'] },
  { v: 'fetch_alphafold', l: 'Retrieve AlphaFold & PDB structures', kinds: ['protein'] }, { v: 'discover_chemicals', l: 'Find associated chemicals (ChEMBL / BindingDB / PDB)', kinds: ['protein'] }, { v: 'search_pubchem', l: 'Search PubChem', kinds: ['chemical'] },
  { v: 'create_linked', l: 'Create a linked record' }, { v: 'update_field', l: 'Update a field' }, { v: 'start_analysis', l: 'Start an analysis' }, { v: 'create_task', l: 'Create a task' }, { v: 'notify', l: 'Send a notification' }, { v: 'export_results', l: 'Export results (CSV/JSON)' },
];
const trig = (a: AutomationSpec) => TRIGGERS.find((t) => t.v === a.trigger.type)?.l ?? a.trigger.type;

export function Automations() {
  const { wsId, projectId, tables } = useSession((s) => ({ wsId: s.wsId, projectId: s.projectId, tables: s.tables }));
  const [list, setList] = useState<Auto[] | null>(null);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [builder, setBuilder] = useState<{ auto?: Auto } | null>(null);
  const [history, setHistory] = useState<Auto | null>(null);
  const load = useCallback(() => { if (wsId) get(`/api/workspaces/${wsId}/automations${projectId ? `?project=${projectId}` : ''}`).then((r) => setList(r.automations), () => setList([])); }, [wsId, projectId]);
  useEffect(() => { load(); get('/api/automation-templates').then((r) => setTpls(r.templates), () => {}); }, [load]);
  useEvent('automation.run', load, [load]);
  const mine = tables.filter((t) => t.projectId === projectId);
  return (
    <div className="page">
      <div className="row between wrap"><div><h1>Automations</h1><p className="lead" style={{ margin: 0 }}>When something happens (trigger) and conditions are met, VierStation runs actions for you. Automations never re-trigger themselves, and chained changes stop after three steps.</p></div><button className="btn" onClick={() => setBuilder({})}><Icon name="plus" /> New automation</button></div>

      <h2 style={{ marginTop: 18 }}>Your automations</h2>
      {list === null ? <Spinner /> : list.length === 0 ? <Empty title="No automations yet">Start from a template below, or build your own.</Empty> : (
        <div className="panel" style={{ marginTop: 8 }}>
          {list.map((a) => (
            <div key={a.id} className="row wrap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
              <label className="check" title={a.enabled ? 'Enabled – click to disable' : 'Disabled – click to enable'}><span className="small" style={{ width: 22, color: a.enabled ? 'var(--green)' : 'var(--ink-3)', fontWeight: 600 }}>{a.enabled ? 'On' : 'Off'}</span><input type="checkbox" checked={a.enabled} onChange={async (e) => { const on = e.target.checked; setList((l) => l && l.map((x) => (x.id === a.id ? { ...x, enabled: on } : x))); try { await patch(`/api/automations/${a.id}`, { enabled: on }); } catch (x) { toast((x as Error).message, 'err'); load(); } }} aria-label={`Enable ${a.name}`} /></label>
              <div className="grow" style={{ minWidth: 220 }}>
                <b>{a.name}</b> <Chip color="sky">{a.tableName}</Chip>
                <div className="small muted">When: {trig(a.spec)}{a.spec.conditions.length ? ` · if ${a.spec.conditions.map((c) => CONDITIONS.find((x) => x.v === c.type)?.l).join(' and ')}` : ''} → {a.spec.actions.map((x) => ACTIONS.find((y) => y.v === x.type)?.l).join(', ')}</div>
              </div>
              <span className="muted small">{a.runCount} runs{a.lastRunAt ? ` · last ${ago(a.lastRunAt)}` : ''}</span>
              <button className="btn ghost sm" onClick={() => setHistory(a)}>History</button>
              <button className="btn secondary sm" onClick={async () => { if (!await confirmDialog(`Run “${a.name}” now on up to 50 records of ${a.tableName}?`, 'Run now', false)) return; try { const r = await post(`/api/automations/${a.id}/run`, {}); toast(`Ran on ${r.runs.length} record(s)`, 'ok'); load(); } catch (e) { toast((e as Error).message, 'err'); } }}>Run now</button>
              <button className="btn ghost sm" onClick={() => setBuilder({ auto: a })}>Edit</button>
              <button className="btn ghost icon sm" aria-label={`Delete ${a.name}`} onClick={async () => { if (await confirmDialog(`Delete the automation “${a.name}”?`, 'Delete')) { await del(`/api/automations/${a.id}`); load(); } }}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>Ready-made templates</h2>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', marginTop: 8 }}>
        {tpls.map((t) => (
          <div key={t.id} className="tile"><b>{t.name}</b><div className="small muted" style={{ margin: '3px 0 8px' }}>{t.description}</div>
            <div className="row wrap" style={{ gap: 4 }}>{t.kinds.map((k) => { const tbl = mine.find((x) => x.kind === k); return <button key={k} className="btn secondary sm" disabled={!tbl} title={tbl ? `Add to ${tbl.name}` : `This project has no ${k} table`} onClick={async () => { try { await post(`/api/tables/${tbl!.id}/automations`, { template: t.id }); toast(`Added to ${tbl!.name}`, 'ok'); load(); } catch (e) { toast((e as Error).message, 'err'); } }}><Icon name="plus" /> {tbl?.name ?? k}</button>; })}</div></div>
        ))}
      </div>
      {builder && <Builder auto={builder.auto} onClose={() => setBuilder(null)} onSaved={load} />}
      {history && <History a={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function History({ a, onClose }: { a: Auto; onClose: () => void }) {
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt: string; recordId: string | null; log: { ts: string; level: string; msg: string; jobId?: string }[] }[] | null>(null);
  useEffect(() => { get(`/api/automations/${a.id}/runs`).then((r) => setRuns(r.runs)); }, [a.id]);
  return (
    <Modal title={`Run history · ${a.name}`} size="wide" onClose={onClose}>
      {!runs ? <Spinner /> : runs.length === 0 ? <Empty title="Never ran" /> : runs.map((r) => (
        <details key={r.id} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
          <summary className="row" style={{ display: 'flex' }}><StatusChip status={r.status} /> <span className="small muted">{ago(r.startedAt)}</span>{r.recordId && <a className="small" href={`/record/${r.recordId}`}>record ↗</a>}</summary>
          <div className="code" style={{ marginTop: 6, maxHeight: 180 }}>{r.log.map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} ${l.msg}${l.jobId ? `  [job ${l.jobId}]` : ''}`).join('\n')}</div>
        </details>
      ))}
    </Modal>
  );
}

function Builder({ auto, onClose, onSaved }: { auto?: Auto; onClose: () => void; onSaved: () => void }) {
  const { projectId, tables } = useSession((s) => ({ projectId: s.projectId, tables: s.tables }));
  const mine = tables.filter((t) => t.projectId === projectId);
  const [name, setName] = useState(auto?.name ?? '');
  const [tableId, setTableId] = useState(auto?.tableId ?? mine[0]?.id ?? '');
  const [spec, setSpec] = useState<AutomationSpec>(auto?.spec ?? { trigger: { type: 'record_created' }, conditions: [], actions: [{ type: 'notify', params: { title: 'New record: {{record.id}}', to: 'creator' } }] });
  const [opt, setOpt] = useState<Opt | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (tableId) get(`/api/tables/${tableId}/automation-options`).then(setOpt, () => setOpt(null)); }, [tableId]);
  const setTrig = (p: Partial<AutomationSpec['trigger']>) => setSpec({ ...spec, trigger: { ...spec.trigger, ...p } });
  const setAct = (i: number, p: Partial<AutomationSpec['actions'][number]>) => setSpec({ ...spec, actions: spec.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const setActParams = (i: number, p: Record<string, unknown>) => setAct(i, { params: { ...spec.actions[i].params, ...p } });
  const statusField = opt?.fields.find((f) => f.id === (spec.trigger.fieldId ?? opt.statusField));
  const applicable = ACTIONS.filter((a) => !a.kinds || (opt && a.kinds.includes(opt.kind)));
  const save = async () => {
    setBusy(true); setErr('');
    try { auto ? await patch(`/api/automations/${auto.id}`, { name, spec }) : await post(`/api/tables/${tableId}/automations`, { name, spec }); toast('Automation saved', 'ok'); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const FieldSel = ({ value, onChange }: { value?: string; onChange: (v: string) => void }) => <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Field"><option value="">Choose a field…</option>{opt?.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>;
  return (
    <Modal title={auto ? 'Edit automation' : 'New automation'} size="wide" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save automation'}</button></>}>
      <div className="col" style={{ gap: 16 }}>
        {err && <div className="notice err">{err}</div>}
        <div className="row wrap"><label className="field grow">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fetch metadata for new DNA records" maxLength={120} /></label>
          <label className="field">Table<select aria-label="Table" className="select" value={tableId} disabled={!!auto} onChange={(e) => setTableId(e.target.value)}>{mine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>

        <div className="panel"><header><b>1 · When</b></header><div className="pb col">
          <select className="select" value={spec.trigger.type} onChange={(e) => setSpec({ ...spec, trigger: { type: e.target.value as TriggerType } })} aria-label="Trigger">{TRIGGERS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select>
          {spec.trigger.type === 'field_changed' && <FieldSel value={spec.trigger.fieldId} onChange={(v) => setTrig({ fieldId: v })} />}
          {spec.trigger.type === 'status_changed' && <label className="field">…to<select className="select" value={spec.trigger.value ?? ''} onChange={(e) => setTrig({ value: e.target.value })}><option value="">Any status</option>{statusField?.choices?.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></label>}
          {spec.trigger.type === 'file_uploaded' && <FieldSel value={spec.trigger.fieldId} onChange={(v) => setTrig({ fieldId: v })} />}
          {spec.trigger.type === 'fetch_completed' && <label className="field">Job type (optional)<select className="select" value={spec.trigger.value ?? ''} onChange={(e) => setTrig({ value: e.target.value })}><option value="">Any fetch / discovery job</option>{['fetch.nucleotide', 'enrich.gene', 'enrich.protein', 'enrich.chemical', 'discover.genes', 'discover.proteins', 'discover.structures', 'discover.chemicals', 'pipeline.full'].map((j) => <option key={j}>{j}</option>)}</select></label>}
          {spec.trigger.type === 'schedule' && <div className="row wrap"><label className="field">Every (minutes, ≥ 15)<input className="input" type="number" min={15} value={spec.trigger.everyMinutes ?? ''} onChange={(e) => setTrig({ everyMinutes: Number(e.target.value) || undefined, at: undefined })} /></label><span className="muted">or</span><label className="field">Daily at<input className="input" type="time" value={spec.trigger.at ?? ''} onChange={(e) => setTrig({ at: e.target.value || undefined, everyMinutes: undefined })} /></label><span className="muted small">Runs for up to 200 records of the table each time.</span></div>}
        </div></div>

        <div className="panel"><header><b>2 · Only if</b><span className="muted small">all conditions must be true</span></header><div className="pb col">
          {spec.conditions.map((c, i) => (
            <div key={i} className="row wrap">
              <select className="select grow" value={c.type} onChange={(e) => setSpec({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? { type: e.target.value as ConditionType } : x)) })} aria-label="Condition">{CONDITIONS.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}</select>
              {(c.type === 'field_equals' || c.type === 'field_not_empty') && <FieldSel value={c.fieldId} onChange={(v) => setSpec({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? { ...x, fieldId: v } : x)) })} />}
              {c.type === 'field_equals' && <input className="input" style={{ width: 160 }} placeholder="Value" value={c.value ?? ''} onChange={(e) => setSpec({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Value" />}
              <button className="btn ghost icon sm" onClick={() => setSpec({ ...spec, conditions: spec.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition"><Icon name="x" /></button>
            </div>
          ))}
          <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSpec({ ...spec, conditions: [...spec.conditions, { type: 'accession_exists' }] })}><Icon name="plus" /> Add condition</button>
        </div></div>

        <div className="panel"><header><b>3 · Then</b></header><div className="pb col">
          {spec.actions.map((a, i) => (
            <div key={i} className="evbox">
              <div className="row"><span className="badge">{i + 1}</span><select className="select grow" value={a.type} onChange={(e) => setAct(i, { type: e.target.value as ActionType, params: {} })} aria-label="Action">{(applicable.some((x) => x.v === a.type) ? applicable : [...applicable, ...ACTIONS.filter((x) => x.v === a.type)]).map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}</select>
                <button className="btn ghost icon sm" onClick={() => setSpec({ ...spec, actions: spec.actions.filter((_, j) => j !== i) })} aria-label="Remove action"><Icon name="x" /></button></div>
              {a.type === 'update_field' && <div className="row wrap"><FieldSel value={a.params.fieldId as string} onChange={(v) => setActParams(i, { fieldId: v })} /><input className="input grow" placeholder="New value – you can use {{Field name}}" value={String(a.params.value ?? '')} onChange={(e) => setActParams(i, { value: e.target.value })} aria-label="New value" /></div>}
              {a.type === 'create_task' && <div className="row wrap"><input className="input grow" placeholder="Task title – e.g. Review {{Accession}}" value={String(a.params.title ?? '')} onChange={(e) => setActParams(i, { title: e.target.value })} aria-label="Task title" /><select className="select" style={{ width: 110 }} value={String(a.params.priority ?? '')} onChange={(e) => setActParams(i, { priority: e.target.value })} aria-label="Priority"><option value="">Priority</option><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select><input className="input" style={{ width: 120 }} type="number" min={0} placeholder="Due in days" value={String(a.params.dueInDays ?? '')} onChange={(e) => setActParams(i, { dueInDays: Number(e.target.value) || undefined })} aria-label="Due in days" /></div>}
              {a.type === 'notify' && <div className="row wrap"><input className="input grow" placeholder="Title" value={String(a.params.title ?? '')} onChange={(e) => setActParams(i, { title: e.target.value })} aria-label="Notification title" /><input className="input grow" placeholder="Message (optional)" value={String(a.params.body ?? '')} onChange={(e) => setActParams(i, { body: e.target.value })} aria-label="Message" /><select className="select" style={{ width: 130 }} value={String(a.params.to ?? 'creator')} onChange={(e) => setActParams(i, { to: e.target.value })} aria-label="Recipients"><option value="creator">Me</option><option value="all">Everyone</option></select></div>}
              {a.type === 'create_linked' && <div className="row wrap"><select className="select" style={{ width: 150 }} value={String(a.params.targetKind ?? '')} onChange={(e) => setActParams(i, { targetKind: e.target.value })} aria-label="Table kind"><option value="">Table…</option>{['task', 'experiment', 'publication', 'organism', 'analysis'].map((k) => <option key={k}>{k}</option>)}</select><input className="input grow" placeholder="Name – e.g. Follow up {{Name}}" value={String((a.params.values as any)?.name ?? '')} onChange={(e) => setActParams(i, { values: { name: e.target.value } })} aria-label="Name template" /></div>}
              {a.type === 'discover_chemicals' && <label className="field">Max compounds<input className="input" style={{ width: 110 }} type="number" min={1} max={100} value={String(a.params.maxCompounds ?? 20)} onChange={(e) => setActParams(i, { maxCompounds: Number(e.target.value) })} /></label>}
              {a.type === 'start_analysis' && <select className="select" value={String(a.params.analysisType ?? 'comparison')} onChange={(e) => setActParams(i, { analysisType: e.target.value })} aria-label="Analysis type">{['alignment', 'comparison', 'phylogeny', 'heatmap', 'pca', 'statistics'].map((k) => <option key={k}>{k}</option>)}</select>}
              {a.type === 'export_results' && <select className="select" style={{ width: 140 }} value={String(a.params.format ?? 'csv')} onChange={(e) => setActParams(i, { format: e.target.value })} aria-label="Format"><option value="csv">CSV</option><option value="json">JSON</option></select>}
            </div>
          ))}
          <button className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSpec({ ...spec, actions: [...spec.actions, { type: applicable[0]?.v ?? 'notify', params: {} }] })}><Icon name="plus" /> Add action</button>
          <span className="muted small">Actions that fetch data run as background jobs with automatic retries and rate-limit handling. Use {'{{Field name}}'} to insert values from the record.</span>
        </div></div>
      </div>
    </Modal>
  );
}
