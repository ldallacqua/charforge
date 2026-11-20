import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import type { Batch } from '../shared/types.ts';
import { queryClient, useLibrary, useLiveUpdates } from './api.ts';
import { CharacterPage } from './pages/CharacterPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { NewCharacterPage } from './pages/NewCharacterPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import './styles.css';

function Arrivals() {
  const [toast, setToast] = useState<Batch | null>(null);
  const onBatch = useCallback((b: Batch) => {
    setToast(b);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification('Novo lote para revisar', { body: `${b.characterName}: ${b.title} (${b.counts.total} imagens)` });
    }
  }, []);
  useLiveUpdates(onBatch);

  // the tab title counts what is waiting
  const { data } = useLibrary();
  useEffect(() => {
    const n = data?.waiting.length ?? 0;
    document.title = n ? `(${n}) Charforge` : 'Charforge';
  }, [data?.waiting.length]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div role="status" className="fixed bottom-4 right-4 z-50 w-[min(360px,calc(100vw-32px))] rounded-xl border border-line bg-[#202020] p-4 shadow-[0_12px_40px_rgba(0,0,0,.5)]">
      <div className="text-sm font-semibold">O Claude enviou um lote</div>
      <div className="mt-0.5 text-sm text-dim">
        {toast.characterName}: {toast.title}, {toast.counts.total} {toast.counts.total === 1 ? 'imagem' : 'imagens'}
      </div>
      <div className="mt-3 flex gap-2">
        <Link to={`/review/${toast.id}`} onClick={() => setToast(null)} className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-[#161616]">
          Revisar agora
        </Link>
        <button type="button" onClick={() => setToast(null)} className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-ink">
          Depois
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/new" element={<NewCharacterPage />} />
          <Route path="/c/:slug" element={<CharacterPage />} />
          <Route path="/review/:id" element={<ReviewPage />} />
        </Routes>
        <Arrivals />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
