import { useEffect, useState } from 'react';
import { get } from '../lib/api.ts';
import { navigate } from '../lib/router.tsx';
import { post } from '../lib/api.ts';
import { toast, useSession } from '../lib/store.ts';
import { Empty, Spinner } from './common.tsx';
import { KIND_ICON, Icon } from './icons.tsx';

const NAMES: Record<string, string> = { dna: 'DNA Sequences', gene: 'Genes', protein: 'Proteins', chemical: 'Chemicals', structure: 'Structures', reaction: 'Reactions', pathway: 'Pathways' };

/** /kind/protein → the project's Proteins table (created from the built-in definition if the project has none yet). */
export function KindRedirect({ kind }: { kind: string }) {
  const s = useSession((x) => ({ tables: x.tables, projectId: x.projectId, ready: x.ready }));
  const t = s.tables.find((x) => x.projectId === s.projectId && x.kind === kind);
  useEffect(() => { if (t) navigate(`/t/${t.id}`, true); }, [t]);
  const [busy, setBusy] = useState(false);
  if (t) return <div className="page"><Spinner /></div>;
  if (!s.projectId) return <div className="page"><Empty title="No project selected">Create a project first.</Empty></div>;
  return (
    <div className="page">
      <Empty title={`This project has no ${NAMES[kind] ?? kind} table yet`}>
        <p>Add it with its standard fields and links to the other scientific tables.</p>
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { const r = await post(`/api/projects/${s.projectId}/tables/${kind}`); const { refreshTables } = await import('../lib/store.ts'); await refreshTables(); navigate(`/t/${r.tableId}`); } catch (e) { toast((e as Error).message, 'err'); setBusy(false); } }}><Icon name={KIND_ICON[kind] ?? 'plus'} /> Add {NAMES[kind] ?? kind}</button>
      </Empty>
    </div>
  );
}

/** /record/:id → /t/:table?r=:id so every record has a shareable URL. */
export function RecordRedirect({ id }: { id: string }) {
  const [err, setErr] = useState('');
  useEffect(() => { get(`/api/records/${id}`).then((r) => navigate(`/t/${r.table.id}?r=${id}`, true), (e) => setErr(e.message)); }, [id]);
  return <div className="page">{err ? <Empty title="Cannot open this record">{err}</Empty> : <Spinner />}</div>;
}
