// Structure image of a record (2D depiction of a chemical, backbone trace of a protein). The image is served from the local cache; when none exists the
// reason is shown instead of a made-up picture. Clicking opens a larger view with the source, identifier and a refresh button.
import { useEffect, useState } from 'react';
import { get, post } from '../../lib/api.ts';
import { toast } from '../../lib/store.ts';
import { Modal, Spinner, fmtDate } from '../common.tsx';
import { Icon } from '../icons.tsx';

interface Info { available: boolean; info: { source: string; identifier: string; sourceUrl: string | null; experimental: boolean | null; retrievedAt: string; note?: string } | null; reason: string | null }

export function Thumb({ id, size = 44, name, big }: { id: string; size?: number; name?: string; big?: boolean }) {
  const [state, setState] = useState<'loading' | 'ok' | 'none'>('loading');
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(0);
  useEffect(() => { setState('loading'); }, [id, v]);
  const label = `Structure image${name ? ` of ${name}` : ''}`;
  return (
    <>
      <button type="button" className="thumb" style={{ width: size, height: size, position: 'relative' }} onClick={(e) => { e.stopPropagation(); setOpen(true); }} aria-label={`${label}: open larger view`} title={state === 'none' ? 'No image available – click to see why' : 'Click for a larger view'}>
        {state !== 'none' && <img src={`/api/records/${id}/thumbnail?v=${v}`} alt={label} loading="lazy" width={size} height={size} onLoad={() => setState('ok')} onError={() => setState('none')} style={{ position: 'absolute', inset: 0, opacity: state === 'ok' ? 1 : 0 }} />}
        {state === 'loading' && <span className="spinner" aria-hidden="true" />}
        {state === 'none' && <span className="muted" aria-hidden="true" style={{ fontSize: Math.max(10, size / 3.2) }}><Icon name="cube" size={Math.round(size / 2.4)} /></span>}
      </button>
      {open && <ThumbViewer id={id} name={name} onClose={() => setOpen(false)} onRefreshed={() => setV((x) => x + 1)} />}
      {big && null}
    </>
  );
}

export function ThumbViewer({ id, name, onClose, onRefreshed }: { id: string; name?: string; onClose: () => void; onRefreshed?: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState(0);
  const load = () => get<Info>(`/api/records/${id}/thumbnail/info`).then(setInfo, () => setInfo({ available: false, info: null, reason: 'Could not read the image information.' }));
  useEffect(() => { void load(); }, [id, v]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = async () => {
    setBusy(true);
    try { const r = await post<Info>(`/api/records/${id}/thumbnail/refresh`, {}); setInfo(r); setV((x) => x + 1); onRefreshed?.(); toast(r.available ? 'Image refreshed' : (r.reason ?? 'No image is available'), r.available ? 'ok' : 'info'); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Structure image${name ? ` – ${name}` : ''}`} onClose={onClose} size="narrow" footer={<><button className="btn secondary" disabled={busy} onClick={() => void refresh()}>{busy ? <Spinner /> : <Icon name="download" />} Refresh from source</button><button className="btn" onClick={onClose}>Close</button></>}>
      {!info ? <Spinner /> : (
        <div className="col" style={{ alignItems: 'center' }}>
          {info.available ? <img src={`/api/records/${id}/thumbnail?v=${v}`} alt={`Structure image${name ? ` of ${name}` : ''}`} style={{ width: '100%', maxWidth: 360, aspectRatio: '1', objectFit: 'contain', border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} /> : <div className="notice" style={{ width: '100%' }}>{info.reason ?? 'No image is available for this record.'}<div className="small muted" style={{ marginTop: 6 }}>VierStation never shows an image it could not tie to a database identifier, and never looks one up by name.</div></div>}
          {info.info && (
            <dl className="kv" style={{ width: '100%' }}>
              <dt>Source</dt><dd>{info.info.source}</dd>
              <dt>Identifier</dt><dd className="mono">{info.info.identifier}</dd>
              <dt>Kind</dt><dd>{info.info.experimental === true ? 'Experimental structure' : info.info.experimental === false ? 'Computationally predicted' : 'Chemical depiction (drawn from the structure record)'}</dd>
              {info.info.sourceUrl && <><dt>Link</dt><dd><a href={info.info.sourceUrl} target="_blank" rel="noreferrer noopener">{info.info.sourceUrl.replace(/^https?:\/\//, '')} ↗</a></dd></>}
              <dt>Saved</dt><dd>{fmtDate(info.info.retrievedAt, true)} · stored on this computer</dd>
              {info.info.note && <><dt>Note</dt><dd>{info.info.note}</dd></>}
            </dl>
          )}
        </div>
      )}
    </Modal>
  );
}
