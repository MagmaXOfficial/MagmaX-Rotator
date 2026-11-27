import { useCallback, useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/ui';
import type { PageId } from './components/Shell';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Models } from './pages/Models';
import { RouterPage } from './pages/Router';
import { Skills } from './pages/Skills';
import { Integrations } from './pages/Integrations';
import { Monitoring } from './pages/Monitoring';
import { SettingsPage } from './pages/Settings';

const VALID: PageId[] = ['overview', 'providers', 'models', 'router', 'skills', 'integrations', 'monitoring', 'settings'];

function pageFromHash(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (VALID as string[]).includes(hash) ? (hash as PageId) : 'overview';
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: PageId) => {
    window.location.hash = `/${next}`;
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <ToastProvider>
      <Shell page={page} onNavigate={navigate}>
        {page === 'overview' ? <Overview navigate={navigate} /> : null}
        {page === 'providers' ? <Providers /> : null}
        {page === 'models' ? <Models /> : null}
        {page === 'router' ? <RouterPage /> : null}
        {page === 'skills' ? <Skills /> : null}
        {page === 'integrations' ? <Integrations /> : null}
        {page === 'monitoring' ? <Monitoring /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </Shell>
    </ToastProvider>
  );
}
