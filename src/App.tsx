import { lazy, Suspense, useEffect } from 'react';
import { connectEvents, loadMe, session, useSession, refreshWorkspace } from './lib/store.ts';
import { matchRoute, navigate, useLocation } from './lib/router.tsx';
import { Shell } from './ui/Shell.tsx';
import { Overview } from './ui/Overview.tsx';
import { Projects, Databases } from './ui/Projects.tsx';
import { TablePage } from './ui/TablePage.tsx';
import { ErrorBoundary, Spinner } from './ui/common.tsx';
import { KindRedirect, RecordRedirect } from './ui/Redirects.tsx';
import { JobsPage, NotificationsPage } from './ui/Jobs.tsx';
import { Settings } from './ui/Settings.tsx';
import { Automations } from './ui/Automations.tsx';
import { TooltipLayer } from './ui/Tip.tsx';
import { FirstRun } from './ui/Setup.tsx';

const Lab = lazy(() => import('./ui/lab/Lab.tsx').then((m) => ({ default: m.Lab })));
const MapPage = lazy(() => import('./ui/MapPage.tsx').then((m) => ({ default: m.MapPage })));
const Explorer = lazy(() => import('./ui/explorer/Explorer.tsx').then((m) => ({ default: m.Explorer })));
const Analysis = lazy(() => import('./ui/Analysis.tsx').then((m) => ({ default: m.Analysis })));

export function App() {
  const ready = useSession((s) => s.ready);
  const user = useSession((s) => s.user);
  const bootError = useSession((s) => s.bootError);
  const setup = useSession((s) => s.setup);
  useEffect(() => { loadMe().catch((e) => session.set({ ready: true, bootError: e.message })); }, []);
  useEffect(() => { if (user) connectEvents(); }, [user]);
  if (!ready) return <div className="login"><Spinner label="Opening your local workspace…" /></div>;
  if (user && setup && !setup.termsAccepted) return <FirstRun />;
  // a server/network hiccup must never look like "you were signed out"
  if (bootError && !user) return <div className="login"><div className="box"><h2>Cannot load VierStation</h2><div className="notice err">{bootError}</div><button className="btn" onClick={() => { session.set({ ready: false, bootError: null }); loadMe().catch((e) => session.set({ ready: true, bootError: e.message })); }}>Try again</button></div></div>;
  return <Shell><ErrorBoundary label="This page hit a problem"><Router /></ErrorBoundary><TooltipLayer /></Shell>;
}

function Router() {
  const { path } = useLocation();
  const wsId = useSession((s) => s.wsId);
  const projectId = useSession((s) => s.projectId);
  // keep sidebar counts fresh when the SSE connection reports changes
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') void refreshWorkspace().catch(() => {}); }, 60_000); return () => clearInterval(t); }, []);
  let m: Record<string, string> | null;
  if (path === '/') return <Overview />;
  if (path === '/projects') return <Projects />;
  if (path === '/databases') return <Databases />;
  if ((m = matchRoute(path, '/t/:id'))) return <TablePage key={m.id} tableId={m.id} />;
  if ((m = matchRoute(path, '/kind/:kind'))) return <KindRedirect kind={m.kind} />;
  if ((m = matchRoute(path, '/record/:id'))) return <RecordRedirect id={m.id} />;
  if (path === '/analysis' || (m = matchRoute(path, '/analysis/:id'))) return <Suspense fallback={<div className="page"><Spinner /></div>}><Analysis id={m?.id} /></Suspense>;
  if (path === '/lab' || (m = matchRoute(path, '/lab/:id'))) return <Suspense fallback={<div className="page"><Spinner /></div>}><Lab id={m?.id} /></Suspense>;
  if (path === '/explorer') return <Suspense fallback={<div className="page"><Spinner /></div>}><Explorer /></Suspense>;
  if (path === '/map') return <Suspense fallback={<div className="page"><Spinner /></div>}><MapPage /></Suspense>;
  if (path === '/automations') return <Automations />;
  if (path === '/jobs') return <JobsPage />;
  if ((m = matchRoute(path, '/jobs/:id'))) return <JobsPage selected={m.id} />;
  if (path === '/notifications') return <NotificationsPage />;
  if (path === '/settings') return <Settings />;
  void navigate; void wsId; void projectId;
  return <div className="page"><div className="empty"><b>Page not found</b><a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Go to the overview</a></div></div>;
}
