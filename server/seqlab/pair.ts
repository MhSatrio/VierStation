// Forward + reverse read → one merged record (see store.importMerged).
import { bad } from '../util.ts';
import { stateOf } from './store.ts';
import type { MergeSource } from './store.ts';
import { importMerged } from './store.ts';
import { recordName } from './dataset.ts';
import { mergeReverse } from './merge.ts';

const source = (recordId: string): MergeSource => {
  const st = stateOf(recordId); if (!st) throw bad('That record is not in the Sequence Lab yet.');
  return { recordId, name: recordName(recordId), versionId: st.head.id, versionN: st.head.n, seq: st.head.seq.replace(/-/g, '').toUpperCase().replace(/U/g, 'T').replace(/[^ACGTRYSWKMBDHVN]/g, ''), qual: st.head.qual && st.head.qual.length === st.head.seq.length ? st.head.qual : null };
};

/** Merge the CURRENT working sequences of two lab records. Neither source record is changed. */
export function mergePair(o: { workspaceId: string; projectId: string | null; userId: string | null }, forwardId: string, reverseId: string, p: { orientation: 'auto' | 'as_is' | 'reverse_complement'; name?: string; minOverlap?: number; minIdentity?: number }) {
  if (forwardId === reverseId) throw bad('Choose two different records: one forward and one reverse read.');
  const f = source(forwardId), r = source(reverseId);
  let merged;
  try { merged = mergeReverse({ seq: f.seq, qual: f.qual, map: null, marks: [] }, { reverseSeq: r.seq, reverseQual: r.qual, orientation: p.orientation, minOverlap: p.minOverlap, minIdentity: p.minIdentity }); } catch (e) { throw bad((e as Error).message); }
  const recordId = importMerged({ ...o, name: p.name }, f, r, merged, p.orientation);
  return { recordId, summary: merged.summary, warnings: merged.warnings, forward: { id: f.recordId, name: f.name }, reverse: { id: r.recordId, name: r.name } };
}
