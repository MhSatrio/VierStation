import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { q } from './db.ts';
import { bad, now, sha256, uid } from './util.ts';
import { buildGeoJson, findLatLonFields } from '../shared/geojson.ts';
import { listFields } from './schema.ts';
import { queryRecords } from './query.ts';
import type { QuerySpec } from './query.ts';
import { cellText } from '../shared/filters.ts';
import type { Field, RecordRow } from '../shared/types.ts';

/** CSV cells that a spreadsheet would execute as formulas get a leading apostrophe (CSV injection guard). Numbers are left alone. */
export function csvCell(v: unknown): string {
  let s = typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function plainValue(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return '';
  if (f.type === 'relation') return (v as { name: string }[]).map((x) => x.name).join('; ');
  if (f.type === 'attachment') return (v as { name: string }[]).map((x) => x.name).join('; ');
  if (f.type === 'structure') { const o = v as any; return `${o.source}:${o.id}`; }
  if (f.type === 'multiSelect' || f.type === 'singleSelect' || f.type === 'status') return cellText(v, f).replace(/, /g, '; ');
  if (f.type === 'lookup') return (v as unknown[]).map((x) => cellText(x)).join('; ');
  if (f.type === 'user') return String(q.get<{ name: string }>('SELECT name FROM users WHERE id=?', String(v))?.name ?? v);
  return v;
}

export function toCsv(fields: Field[], rows: RecordRow[]): string {
  const head = fields.map((f) => csvCell(f.name)).join(',');
  const body = rows.map((r) => fields.map((f) => csvCell(plainValue(f, r.fields[f.id]))).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

export function toJson(tableName: string, fields: Field[], rows: RecordRow[]): string {
  return JSON.stringify({
    table: tableName, exportedAt: now(), fields: fields.map((f) => ({ name: f.name, type: f.type })),
    records: rows.map((r) => ({
      id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt,
      values: Object.fromEntries(fields.map((f) => [f.name, f.type === 'relation' ? (r.fields[f.id] as any[] ?? []).map((x) => ({ id: x.id, name: x.name, ...(x.meta ? { evidence: x.meta } : {}) })) : plainValue(f, r.fields[f.id])])),
    })),
  }, null, 2);
}

export async function exportRecords(o: { workspaceId: string; tableId: string; recordIds?: string[]; spec?: QuerySpec; format: 'csv' | 'json' | 'geojson'; userId: string | null }) {
  const fields = listFields(o.tableId);
  const rows: RecordRow[] = [];
  if (o.recordIds) rows.push(...queryRecords(o.tableId, { ids: o.recordIds }).records);
  else for (let off = 0; ; off += 2000) { const r = queryRecords(o.tableId, { ...(o.spec ?? {}), offset: off, limit: 2000 }); rows.push(...r.records); if (rows.length >= r.total || !r.records.length) break; }
  const tname = q.get<{ name: string }>('SELECT name FROM tables WHERE id=?', o.tableId)!.name;
  let text: string; let skipped = 0; let ext: string = o.format; let mime = o.format === 'csv' ? 'text/csv' : 'application/json';
  if (o.format === 'geojson') {
    // Sample points for QGIS and other GIS tools: every other column becomes a property of its point
    const ll = findLatLonFields(fields);
    if (!ll) throw bad('This table has no Latitude and Longitude columns, so it cannot be exported as GeoJSON.');
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const props = fields.filter((f) => f.id !== ll.lat.id && f.id !== ll.lon.id);
    const g = buildGeoJson(rows.map((r) => ({ lat: num(r.fields[ll.lat.id]), lon: num(r.fields[ll.lon.id]), properties: Object.fromEntries(props.map((f) => [f.name, plainValue(f, r.fields[f.id])])) })), tname);
    text = g.json; skipped = g.skipped; ext = 'geojson'; mime = 'application/geo+json';
  } else text = o.format === 'csv' ? toCsv(fields, rows) : toJson(tname, fields, rows);
  const id = uid('fil');
  const name = `${tname.replace(/[^\w.-]+/g, '_')}_${now().slice(0, 10)}.${ext}`;
  const buf = Buffer.from(text, 'utf8');
  writeFileSync(join(config.filesDir, id), buf);
  q.run('INSERT INTO files(id,workspace_id,record_id,field_id,name,size,mime,sha256,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, o.workspaceId, null, null, name, buf.length, mime, sha256(buf), now(), o.userId);
  return { id, name, rows: rows.length, bytes: buf.length, text, skipped, mime };
}
