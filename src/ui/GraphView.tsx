// The table's “Graph” view and the record panel's relationship graph: the same Cytoscape explorer as the Explorer page, scoped to one table or one record.
// (The earlier hand-made force layout was replaced; see the project notes for what was wrong with it.)
import { lazy, Suspense } from 'react';
import { Spinner } from './common.tsx';

const ExplorerView = lazy(() => import('./explorer/Explorer.tsx').then((m) => ({ default: m.ExplorerView })));

export function GraphView({ source, onOpen }: { source: { kind: 'table' | 'record'; id: string }; depth?: number; onDepth?: (d: number) => void; onOpen: (id: string) => void; highlight?: string }) {
  return (
    <Suspense fallback={<div className="empty"><Spinner label="Loading the explorer…" /></div>}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {source.kind === 'record' ? <ExplorerView key={source.id} embedded focus={[source.id]} onOpenRecord={onOpen} /> : <ExplorerView key={source.id} embedded table={source.id} onOpenRecord={onOpen} />}
      </div>
    </Suspense>
  );
}
