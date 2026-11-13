// RFC 4180 CSV / TSV parser (quoted fields, escaped quotes, CRLF, embedded newlines). Shared by client import and server tests.
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const d = delimiter ?? (((t.split('\n', 1)[0] ?? '').match(/\t/g)?.length ?? 0) > ((t.split('\n', 1)[0] ?? '').match(/,/g)?.length ?? 0) ? '\t' : ',');
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}
