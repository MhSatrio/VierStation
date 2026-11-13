import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { createStore, useStore } from './store.ts';

const loc = createStore({ path: window.location.pathname, search: window.location.search });
window.addEventListener('popstate', () => loc.set({ path: window.location.pathname, search: window.location.search }));

export function navigate(to: string, replace = false) {
  const u = new URL(to, window.location.origin);
  if (u.pathname === loc.get().path && u.search === loc.get().search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', u.pathname + u.search);
  loc.set({ path: u.pathname, search: u.search });
}
export const useLocation = () => useStore(loc, (s) => s);
export const currentPath = () => loc.get().path;

/** Update a query parameter without adding history entries for every keystroke. */
export function setQuery(key: string, value: string | null, replace = true) {
  const u = new URL(window.location.href);
  if (value === null) u.searchParams.delete(key); else u.searchParams.set(key, value);
  navigate(u.pathname + u.search, replace);
}
export function useQueryParam(key: string): string | null {
  const { search } = useLocation();
  return new URLSearchParams(search).get(key);
}

export function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean), b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (b[i] !== a[i]) return null;
  }
  return params;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={to} {...rest} onClick={(e) => {
      rest.onClick?.(e);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || rest.target === '_blank' || to.startsWith('/api/')) return;
      e.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}
