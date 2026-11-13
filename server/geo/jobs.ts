// Background job: find coordinates for DNA records that have a place NAME but no coordinates yet.
import { registerJob, Cancelled } from '../jobs.ts';
import { getRaw } from '../records.ts';
import { geocodeText } from './geocode.ts';
import { geoFieldIds, isUserEntered, setLocation } from './records.ts';

registerJob('geo.locate', async (j) => {
  const { recordIds, force } = j.payload as { recordIds: string[]; force?: boolean };
  const located: { id: string; place: string; precision: string; note?: string }[] = [], skipped: { id: string; why: string }[] = [], failed: { id: string; text: string; why: string }[] = [];
  let k = 0;
  for (const id of recordIds.slice(0, 200)) {
    if (j.signal.aborted) throw new Cancelled();
    j.progress(k++, Math.min(recordIds.length, 200), 'Looking up place names');
    const rec = getRaw(id); if (!rec) { skipped.push({ id, why: 'record not found' }); continue; }
    const f = geoFieldIds(rec.tableId);
    const text = String((f.location ? rec.data[f.location] : '') ?? '').trim();
    const hasCoords = f.lat && f.lon && rec.data[f.lat] !== null && rec.data[f.lat] !== undefined && rec.data[f.lon] !== null && rec.data[f.lon] !== undefined;
    if (!text) { skipped.push({ id, why: 'no place name in “Collection location”' }); continue; }
    if (hasCoords && !force) { skipped.push({ id, why: 'already has coordinates' }); continue; }
    if (hasCoords && isUserEntered(f.locSource ? rec.data[f.locSource] : '')) { skipped.push({ id, why: 'coordinates were entered by a person – not overwritten' }); continue; }
    try {
      const r = await geocodeText(text, j.signal);
      if (!r.place) { failed.push({ id, text, why: 'no match for this name' }); continue; }
      setLocation(id, r.place, { userId: j.userId, sourceNote: r.note });
      located.push({ id, place: r.place.displayName, precision: r.place.precision, note: r.note });
    } catch (e) { if (e instanceof Cancelled) throw e; failed.push({ id, text, why: (e as Error).message }); }
  }
  const summary = `${located.length} located, ${skipped.length} skipped, ${failed.length} not found`;
  return { located, skipped, failed, summary, _notify: { kind: 'analysis_completed' as const, title: `Locations: ${summary}`, link: '/map' } };
});
