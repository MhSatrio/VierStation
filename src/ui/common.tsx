import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { createStore, toasts, useStore } from '../lib/store.ts';
import { Link } from '../lib/router.tsx';
import { Hint } from './Tip.tsx';
import { EVIDENCE_LABELS } from '../../shared/types.ts';
import type { ChoiceColor, EvidenceClass, JobStatus, LinkMeta, SelectChoice } from '../../shared/types.ts';

export const COLOR_CLASS: Record<string, string> = { gray: 'gray', blue: 'blue', sky: 'sky', green: 'green', amber: 'amber', red: 'red', ink: 'ink' };
export function Chip({ color = 'gray', children, title, onClick }: { color?: ChoiceColor | string; children: ReactNode; title?: string; onClick?: () => void }) {
  return <span className={`chip ${COLOR_CLASS[color] ?? 'gray'}${onClick ? ' link' : ''}`} title={title} onClick={onClick}>{children}</span>;
}
export const ChoiceChip = ({ c }: { c: SelectChoice | undefined | null }) => (c ? <Chip color={c.color}>{c.name}</Chip> : null);

export function EvidenceTag({ cls, withLabel = true }: { cls?: EvidenceClass | string; withLabel?: boolean }) {
  const c = (cls ?? 'unverified') as EvidenceClass;
  return <Hint k={`ev_${c}`}><span className={`ev ${c}`} aria-label={EVIDENCE_LABELS[c] ?? c} tabIndex={0}><i />{withLabel && (EVIDENCE_LABELS[c] ?? c)}</span></Hint>;
}
export const EVIDENCE_COLOR: Record<string, string> = { experimentally_verified: '#1d8a57', database_annotated: '#4570b6', computationally_predicted: '#c98a00', sequence_inferred: '#8a56c2', user_supplied: '#5c6670', unverified: '#b3342a' };

export function EvidenceDetail({ meta }: { meta: LinkMeta }) {
  const items = (meta.details as any)?.items as { relationType?: string; evidenceClass: EvidenceClass; evidence: string; sourceDb: string; referenceUrl?: string }[] | undefined;
  return (
    <div className="evbox">
      <div className="row wrap"><EvidenceTag cls={meta.evidenceClass} />{meta.relationType && <Chip color="sky">{meta.relationType}</Chip>}{meta.sourceDb && <span className="muted small">{meta.sourceDb}</span>}</div>
      {items && items.length > 1 ? items.map((i, k) => (
        <div key={k} className="small"><EvidenceTag cls={i.evidenceClass} withLabel={false} /> <b>{i.sourceDb}</b>: {i.evidence} {i.referenceUrl && <a href={i.referenceUrl} target="_blank" rel="noreferrer noopener">source ↗</a>}</div>
      )) : meta.evidence && <div className="small">{meta.evidence}</div>}
      {meta.referenceUrl && (!items || items.length <= 1) && <a className="small" href={meta.referenceUrl} target="_blank" rel="noreferrer noopener">Reference ↗</a>}
    </div>
  );
}

export function StatusChip({ status }: { status: JobStatus | string }) {
  const m: Record<string, [string, string]> = { queued: ['gray', 'Queued'], running: ['amber', 'Running'], completed: ['green', 'Completed'], failed: ['red', 'Failed'], cancelled: ['gray', 'Cancelled'], skipped: ['gray', 'Skipped'] };
  const [c, l] = m[status] ?? ['gray', status];
  return <Chip color={c}>{status === 'running' && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}{l}</Chip>;
}

export function Spinner({ label }: { label?: string }) { return <span className="muted"><span className="spinner" /> {label}</span>; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><b>{title}</b>{children}</div>; }

// ---------- modal ----------
export function Modal({ title, onClose, children, footer, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'narrow' }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <header><h2>{title}</h2><button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>, document.body);
}

// ---------- popover anchored to an element ----------
export function Popover({ anchor, onClose, children, width, align = 'left' }: { anchor: RefObject<HTMLElement | null> | HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = anchor && 'current' in anchor ? anchor.current : anchor;
    if (!el || !ref.current) return;
    const r = el.getBoundingClientRect(), p = ref.current.getBoundingClientRect();
    let left = align === 'right' ? r.right - p.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
    let top = r.bottom + 4;
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, r.top - p.height - 4);
    setPos({ left, top, width: width ?? undefined });
  }, [anchor, width, align, children]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = anchor && 'current' in anchor ? anchor.current : anchor;
      if (ref.current?.contains(e.target as Node) || el?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [anchor, onClose]);
  return createPortal(<div className="pop" ref={ref} style={pos}>{children}</div>, document.body);
}

/** Button that toggles a popover. children receives close(). */
export function MenuButton({ label, icon, className = 'btn secondary sm', children, title, align }: { label?: ReactNode; icon?: string; className?: string; children: (close: () => void) => ReactNode; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button ref={ref} className={`${className}${open ? ' active' : ''}`} onClick={() => setOpen((o) => !o)} title={title} aria-haspopup="true" aria-expanded={open}>{icon && <Icon name={icon} />}{label}</button>
      {open && <Popover anchor={ref} onClose={close} align={align}>{children(close)}</Popover>}
    </>
  );
}

// ---------- confirm dialog (promise based) ----------
const confirmStore = createStore<{ q: { text: string; ok: string; danger: boolean; resolve: (v: boolean) => void } | null }>({ q: null });
export const confirmDialog = (text: string, ok = 'Confirm', danger = true) => new Promise<boolean>((resolve) => confirmStore.set({ q: { text, ok, danger, resolve } }));

export function GlobalOverlays() {
  const c = useStore(confirmStore, (s) => s.q);
  const list = useStore(toasts, (s) => s.list);
  return (
    <>
      {c && (
        <Modal size="narrow" title="Please confirm" onClose={() => { c.resolve(false); confirmStore.set({ q: null }); }}
          footer={<><button className="btn secondary" onClick={() => { c.resolve(false); confirmStore.set({ q: null }); }}>Cancel</button><button className={`btn ${c.danger ? 'danger' : ''}`} onClick={() => { c.resolve(true); confirmStore.set({ q: null }); }}>{c.ok}</button></>}>
          <p style={{ margin: 0 }}>{c.text}</p>
        </Modal>
      )}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.kind}`}><span>{t.text}</span>{t.link && <Link to={t.link.to}>{t.link.label}</Link>}</div>)}
      </div>
    </>
  );
}

// ---------- error boundary: a failing widget must never blank the whole app ----------
import { Component } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error('[ui]', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="empty" role="alert"><b>{this.props.label ?? 'Something went wrong'}</b>{this.state.err.message}<br /><button className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => this.setState({ err: null })}>Try again</button></div>;
  }
}

// ---------- small helpers ----------
export const fmtDate = (s?: string | null, withTime = false) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return withTime || s.length > 10 ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
};
export const ago = (s?: string | null) => {
  if (!s) return '';
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
};
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtNum = (n: unknown, precision?: number) => (typeof n === 'number' ? (precision !== undefined ? n.toFixed(precision) : String(Math.round(n * 1e6) / 1e6)) : '');
export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const useDebounced = <T,>(v: T, ms = 250): T => { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; };
export const copyText = async (s: string) => { try { await navigator.clipboard.writeText(s); return true; } catch { return false; } };

const Ctx = createContext<null>(null);
export { Ctx };
