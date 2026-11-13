// Lightweight, accessible tooltips. Hover (after a short delay), keyboard focus (immediate) and a touch-friendly info button.
// One tooltip is visible at a time; Esc, mouse-leave, blur or an outside tap dismisses it. No dependencies.
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createStore, useStore } from '../lib/store.ts';
import { HELP } from './help.ts';

interface Shown { id: string; text: ReactNode; rect: DOMRect; owner: HTMLElement; sticky: boolean }
const tip = createStore<{ shown: Shown | null }>({ shown: null });
const DELAY_MS = 500;

function describe(owner: HTMLElement, id: string | null) {
  const target = (owner.matches('button, a, input, select, textarea, [tabindex]') ? owner : owner.querySelector<HTMLElement>('button, a, input, select, textarea, [tabindex]')) ?? owner;
  if (id) target.setAttribute('aria-describedby', id); else target.removeAttribute('aria-describedby');
}
function hide(owner?: HTMLElement) {
  const s = tip.get().shown;
  if (!s || (owner && s.owner !== owner)) return;
  describe(s.owner, null);
  tip.set({ shown: null });
}
function show(owner: HTMLElement, id: string, text: ReactNode, sticky = false) {
  const prev = tip.get().shown; if (prev && prev.owner !== owner) describe(prev.owner, null);
  describe(owner, id);
  tip.set({ shown: { id, text, rect: owner.getBoundingClientRect(), owner, sticky } });
}

/** Wrap any element: `<Hint k="bootstrap"><button>…</button></Hint>` or `<Hint text="…">`. Adds no extra tab stop. */
export function Hint({ k, text, children, inline = true, delay = DELAY_MS }: { k?: string; text?: ReactNode; children: ReactNode; inline?: boolean; delay?: number }) {
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLSpanElement>(null);
  const content = text ?? (k ? HELP[k] : undefined);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => () => { clear(); hide(ref.current ?? undefined); }, []);
  if (!content) return <>{children}</>;
  return (
    <span ref={ref} className={`hint${inline ? '' : ' block'}`}
      onMouseEnter={() => { clear(); timer.current = setTimeout(() => ref.current && show(ref.current, `tip${id}`, content), delay); }}
      onMouseLeave={() => { clear(); hide(ref.current ?? undefined); }}
      onFocus={() => { clear(); if (ref.current) show(ref.current, `tip${id}`, content); }}
      onBlur={() => { clear(); hide(ref.current ?? undefined); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { clear(); hide(ref.current ?? undefined); } }}>
      {children}
    </span>
  );
}

/** Small (i) button for labels and headings. Click/tap toggles it, so it works on touch screens. */
export function HelpTip({ k, text, label }: { k?: string; text?: ReactNode; label?: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const content = text ?? (k ? HELP[k] : undefined);
  if (!content) return null;
  const title = label ?? (k ? k.replace(/([A-Z])/g, ' $1').toLowerCase() : 'this setting');
  return (
    <Hint text={content}>
      <button ref={btn} type="button" className="helptip" aria-label={`About ${title}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); const s = tip.get().shown; if (s && s.owner === btn.current?.parentElement && s.sticky) hide(); else if (btn.current?.parentElement) show(btn.current.parentElement, `tip${id}`, content, true); }}>i</button>
    </Hint>
  );
}

/** Label text followed by its help button. */
export function Lbl({ children, k, text }: { children: ReactNode; k?: string; text?: ReactNode }) {
  return <span className="lbl-help">{children}<HelpTip k={k} text={text} /></span>;
}

export function TooltipLayer() {
  useStore(tip, (t) => t.shown?.id ?? null); // select a primitive: the store compares selections with JSON.stringify, which must never see DOM nodes
  const s = tip.get().shown;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!s || !ref.current) return;
    const r = s.rect, p = ref.current.getBoundingClientRect(), pad = 8;
    let left = r.left + r.width / 2 - p.width / 2; left = Math.max(pad, Math.min(left, window.innerWidth - p.width - pad));
    let top = r.top - p.height - 8, above = true;
    if (top < pad) { top = r.bottom + 8; above = false; }
    setPos({ left, top, visibility: 'visible', ['--arrow-x' as string]: `${Math.max(10, Math.min(p.width - 10, r.left + r.width / 2 - left))}px`, ['--arrow-above' as string]: above ? '1' : '0' });
  }, [s]);
  const close = useCallback(() => hide(), []);
  useEffect(() => {
    if (!s) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const down = (e: PointerEvent) => { if (!s.owner.contains(e.target as Node) && !ref.current?.contains(e.target as Node)) close(); };
    const scroll = () => close();
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', down); window.addEventListener('scroll', scroll, true); window.addEventListener('resize', scroll);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll); };
  }, [s, close]);
  if (!s) return null;
  return createPortal(<div ref={ref} id={s.id} role="tooltip" className="tooltip" style={pos}>{s.text}</div>, document.body);
}
export const withHint = (el: ReactElement, k: string) => (isValidElement(el) ? <Hint k={k}>{cloneElement(el)}</Hint> : el);
