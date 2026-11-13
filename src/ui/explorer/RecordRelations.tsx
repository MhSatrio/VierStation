// “Relationships” section of the record panel: the table-driven way to create relationships (same records as drawing in the graph).
import { useCallback, useEffect, useState } from 'react';
import { get } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import { useEvent } from '../../lib/store.ts';
import { Modal, Spinner } from '../common.tsx';
import { HelpTip } from '../Tip.tsx';
import { Icon } from '../icons.tsx';
import { EdgeInspector, EvBadge } from './Inspector.tsx';
import { RelationEditor } from './RelationEditor.tsx';
import { ShapeGlyph } from './style.tsx';

export function RecordRelations({ recordId, name, kind, canEdit, onOpen }: { recordId: string; name: string; kind: string; canEdit: boolean; onOpen: (id: string) => void }) {
  const [rels, setRels] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<any | null>(null);
  const load = useCallback(() => { get(`/api/records/${recordId}/relationships`).then((r) => setRels(r.relationships), () => setRels([])); }, [recordId]);
  useEffect(() => { setRels(null); load(); }, [load]);
  useEvent('graph.changed', load, [recordId]);
  const edgeOf = (r: any) => ({ id: r.id, origin: 'relationship', source: r.sourceId, target: r.targetId, directional: r.directional, typeName: r.type.name, label: r.type.name, evidence: r.evidenceClass, predicted: ['computationally_predicted', 'unverified'].includes(r.evidenceClass) });
  return (
    <section>
      <h3><Icon name="graph" size={13} /> Relationships {rels ? `(${rels.length})` : ''} <HelpTip text="Typed, evidence-backed relationships between this record and others (binds to, inhibits, substrate of …). Add one here, or draw it in the Explorer – both store exactly the same thing." label="relationships" /></h3>
      {!rels ? <Spinner /> : !rels.length ? <div className="muted small">No relationships yet.</div> : rels.map((r) => {
        const out = r.sourceId === recordId; const other = out ? { id: r.targetId, name: r.targetName, kind: r.targetKind } : { id: r.sourceId, name: r.sourceName, kind: r.sourceKind };
        return (
          <div key={r.id} className="relitem">
            <button className="relmain" onClick={() => setOpen(r)} title="Show details, citations and edit"><ShapeGlyph type={other.kind} size={15} /><span><b>{out ? r.type.name : r.type.inverseName ?? `${r.type.name} (incoming)`}</b>{r.directional ? (out ? ' → ' : ' ← ') : ' – '}{other.name}</span></button>
            <EvBadge ev={r.evidenceClass} />
            <button className="btn ghost sm" style={{ padding: '0 6px' }} onClick={() => onOpen(other.id)} aria-label={`Open ${other.name}`}>Open</button>
          </div>
        );
      })}
      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        {canEdit && <button className="btn secondary sm" onClick={() => setAdding(true)}><Icon name="plus" /> Add relation</button>}
        <button className="btn ghost sm" onClick={() => navigate(`/explorer?focus=${recordId}`)}><Icon name="graph" /> Explore related network</button>
      </div>
      {adding && <Modal title={`Add relation to ${name}`} onClose={() => setAdding(false)} size="wide"><RelationEditor source={{ id: recordId, name, kind }} onSaved={load} onCancel={() => setAdding(false)} /></Modal>}
      {open && <Modal title="Relationship" onClose={() => { setOpen(null); load(); }} size="wide"><EdgeInspector edge={edgeOf(open)} names={{ [open.sourceId]: open.sourceName, [open.targetId]: open.targetName }} onClose={() => { setOpen(null); load(); }} onChanged={load} onSelectNode={(id) => { setOpen(null); onOpen(id); }} /></Modal>}
    </section>
  );
}
