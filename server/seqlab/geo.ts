// Sequence Lab jobs around WHERE sequences come from and keeping BLAST hits:
//   seq.save_hits       – save chosen BLAST hits as real records in the DNA table (with collection information and location from GenBank)
//   seq.locate_members  – find collection places of the query and of the reference sequences in the dataset, for the sample map
import { Cancelled, Fatal, registerJob } from '../jobs.ts';
import { now } from '../util.ts';
import { toCtx } from '../discovery/jobs.ts';
import { tableOfKind, upsertByKey } from '../ingest.ts';
import { attachOrganism } from '../discovery/dna.ts';
import { collectionInfo, fetchGenBank, sourceUrl } from '../integrations/ncbi.ts';
import type { GenBank } from '../integrations/ncbi.ts';
import { geocodeText } from '../geo/geocode.ts';
import { countryPlace, parseGeoLocName, parseLatLon } from '../geo/places.ts';
import type { Place } from '../geo/places.ts';
import { recordPoint } from '../geo/records.ts';
import { precisionById } from '../../shared/geo.ts';
import type { GeoPoint } from '../../shared/geo.ts';
import { asOp, fetchHitRegion } from './pipeline.ts';
import type { LabHit } from './pipeline.ts';
import { currentDataset, recordName } from './dataset.ts';
import { ensureLabFields, getOp, latestOp, stateOf } from './store.ts';

/** Collection place stated by a GenBank record (never invented): coordinates when /lat_lon exists, else the country centre when only a country is stated. */
export function genbankPlace(gb: Pick<GenBank, 'source'>): { text: string; place: Place | null } {
  const geo = gb.source.geo_loc_name || gb.source.country || '';
  const ll = parseLatLon(gb.source.lat_lon ?? '');
  if (ll) return { text: geo || gb.source.lat_lon, place: { ...ll, precision: 'exact', displayName: gb.source.lat_lon, source: 'GenBank record (/lat_lon)' } };
  const g = parseGeoLocName(geo);
  if (g.country && !g.parts.length) { const cp = countryPlace(g.country); if (cp) return { text: geo, place: { ...cp, source: 'GenBank record (/geo_loc_name) – country centre' } }; }
  return { text: geo, place: null };
}

// ---------------------------------------------------------------- save BLAST hits into the DNA table
registerJob('seq.save_hits', async (j) => {
  const { recordId, accessions, region, blastOpId } = j.payload as { recordId: string; accessions: string[]; region: 'aligned' | 'whole'; blastOpId?: string };
  const blast = blastOpId ? getOp(blastOpId) : latestOp(recordId, 'blast');
  if (!blast?.result?.hits) throw new Fatal('Run an NCBI BLAST search first.');
  const hits: LabHit[] = blast.result.hits, qLen: number = blast.result.queryLength;
  const c = toCtx(j), st = stateOf(recordId), qName = recordName(recordId);
  const tableId = tableOfKind(c, 'dna'); ensureLabFields(tableId);
  return asOp(j, recordId, { step: 'hits_saved', name: `Save ${accessions.length} BLAST hit(s) to the DNA table`, inputRef: blast.id, params: { accessions, region }, tool: 'VierStation + NCBI efetch', dbSource: 'NCBI Nucleotide' }, async () => {
    const rows: { accession: string; status: 'created' | 'existing' | 'failed'; recordId?: string; detail: string }[] = [];
    let k = 0;
    for (const acc of [...new Set(accessions)].slice(0, 100)) {
      if (j.signal.aborted) throw new Cancelled();
      j.progress(k++, accessions.length, `Saving ${acc}`);
      const h = hits.find((x) => x.accession === acc);
      if (!h) { rows.push({ accession: acc, status: 'failed', detail: 'not in this BLAST result' }); continue; }
      try {
        const gb = await fetchGenBank(acc, { signal: j.signal });
        if (!gb) { rows.push({ accession: acc, status: 'failed', detail: 'NCBI returned no GenBank record' }); continue; }
        let seq = '', regionNote = '';
        if (region === 'whole' && gb.sequence.length <= 30_000) { seq = gb.sequence; regionNote = 'whole record'; }
        else {
          const r = await fetchHitRegion(h, qLen, j.signal);
          if (!r) { rows.push({ accession: acc, status: 'failed', detail: 'the aligned region could not be retrieved' }); continue; }
          seq = r.seq; regionNote = `aligned region ${r.region.from}–${r.region.to} (${r.region.strand} strand, given in your query's orientation)`;
        }
        const { text, place } = genbankPlace(gb);
        const info = collectionInfo(gb);
        const values: Record<string, unknown> = {
          name: (h.title || `${h.organism} ${acc}`).slice(0, 200), sequence: seq, length: seq.length, source: 'NCBI BLAST hit', retrieved: now(),
          collection: `${info}${info ? '\n' : ''}BLAST hit of “${qName}” (version ${st?.head.n ?? '?'}): ${h.identityPct}% identity over ${h.coveragePct}% of the query, E=${h.evalue}, bit score ${h.bitScore}; stored: ${regionNote}`,
        };
        if (text) values.location = text;
        if (place) { values.lat = Math.round(place.lat * 1e6) / 1e6; values.lon = Math.round(place.lon * 1e6) / 1e6; values.locPrecision = precisionById(place.precision).label; values.locSource = place.source; }
        const u = upsertByKey(c, tableId, 'accession', acc, values, { sourceDb: 'NCBI Nucleotide', accession: acc, query: `BLAST of ${qName}`, url: sourceUrl.nuccore(acc), step: 'import', note: `BLAST hit (${h.identityPct}% identity, ${h.coveragePct}% coverage); ${regionNote}` });
        await attachOrganism(c, tableId, u.id, h.taxId ?? gb.taxId, h.organism || gb.organism, 'NCBI Nucleotide', sourceUrl.nuccore(acc));
        rows.push({ accession: acc, status: u.created ? 'created' : 'existing', recordId: u.id, detail: u.created ? `${seq.length} bp, ${regionNote}${text ? `; place: ${text}` : '; GenBank states no collection place'}` : 'a record with this accession was already in the table (not duplicated)' });
      } catch (e) { if (e instanceof Cancelled) throw e; rows.push({ accession: acc, status: 'failed', detail: (e as Error).message }); }
    }
    const created = rows.filter((r) => r.status === 'created').length, existing = rows.filter((r) => r.status === 'existing').length, failed = rows.filter((r) => r.status === 'failed').length;
    if (!created && !existing) throw new Fatal(`None of the hits could be saved. ${rows.map((r) => `${r.accession}: ${r.detail}`).join(' ')}`);
    const summary = `${created} saved, ${existing} already present, ${failed} failed`;
    return { result: { rows, created, existing, failed, summary, tableId }, warnings: rows.filter((r) => r.status === 'failed').map((r) => `${r.accession}: ${r.detail}`), value: { summary, _notify: { kind: 'analysis_completed' as const, title: `BLAST hits saved to the DNA table (${summary})`, link: `/lab/${recordId}?section=matches` } } };
  });
}, { maxAttempts: 1 });

// ---------------------------------------------------------------- places of the query and the reference sequences (for the sample map)
registerJob('seq.locate_members', async (j) => {
  const { recordId } = j.payload as { recordId: string };
  const ds = currentDataset(recordId);
  if (!ds) throw new Fatal('Build the reference dataset first (Related species) – the map shows where those sequences were collected.');
  return asOp(j, recordId, { step: 'geo', name: 'Find collection places of the query and its references', params: { members: ds.dataset.members.length }, tool: 'VierStation + NCBI GenBank + OpenStreetMap Nominatim', dbSource: 'NCBI Nucleotide (source qualifiers), OpenStreetMap Nominatim' }, async () => {
    const points: GeoPoint[] = [], unresolved: { label: string; accession: string | null; organism: string; reason: string }[] = [];
    const own = recordPoint(recordId, 'query'); if (own) points.push(own);
    let k = 0; const members = ds.dataset.members.filter((m) => m.accession);
    for (const m of members) {
      if (j.signal.aborted) throw new Cancelled();
      j.progress(k++, members.length, `Reading the collection place of ${m.accession}`);
      try {
        const gb = await fetchGenBank(m.accession!, { signal: j.signal });
        if (!gb) { unresolved.push({ label: m.label, accession: m.accession, organism: m.organism, reason: 'no GenBank record' }); continue; }
        const g = genbankPlace(gb); let place = g.place; const text = g.text; let note: string | undefined;
        if (!place && text) { const r = await geocodeText(text, j.signal); place = r.place; note = r.note; }
        if (!place) { unresolved.push({ label: m.label, accession: m.accession, organism: m.organism, reason: text ? `“${text}” could not be located` : 'GenBank states no collection place for this record' }); continue; }
        points.push({ id: m.id, name: `${m.organism} (${m.accession})`, lat: place.lat, lon: place.lon, precision: place.precision, location: text || place.displayName, source: place.source, kind: 'reference', accession: m.accession, organism: m.organism, note });
      } catch (e) { if (e instanceof Cancelled) throw e; unresolved.push({ label: m.label, accession: m.accession, organism: m.organism, reason: (e as Error).message }); }
    }
    const warnings = unresolved.length ? [`${unresolved.length} of ${members.length} reference sequence(s) have no usable collection place.`] : [];
    return { result: { points, unresolved, retrievedAt: now() }, warnings, value: { points: points.length, _notify: { kind: 'analysis_completed' as const, title: `Collection places found for ${points.length} sequence(s)`, link: `/map?lab=${recordId}` } } };
  });
}, { maxAttempts: 1 });
