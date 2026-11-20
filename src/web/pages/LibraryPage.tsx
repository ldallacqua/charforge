import { Link } from 'react-router';
import { useLibrary } from '../api.ts';
import { BatchRow, EmptyRing, PhaseTrack } from '../components/parts.tsx';

export function LibraryPage() {
  const { data, error } = useLibrary();
  return (
    <div className="min-h-dvh bg-panel">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 pb-16 md:px-8">
        <section className="pt-8">
          <h2 className="text-xl font-semibold">Esperando você</h2>
          <p className="mt-1 max-w-prose text-sm text-dim">Lotes que o Claude gerou e ainda não foram revisados.</p>
          <div className="mt-4 flex flex-col gap-3">
            {error && <p className="text-sm text-mark">O estúdio não respondeu: {error.message}</p>}
            {data?.waiting.map((b) => <BatchRow key={b.id} batch={b} showCharacter />)}
            {data && data.waiting.length === 0 && (
              <div className="flex items-center gap-4 rounded-lg border border-dashed border-line px-5 py-6">
                <EmptyRing className="size-10 shrink-0" />
                <p className="text-sm text-dim">Nada para revisar agora. Quando o Claude enviar um lote, ele aparece aqui na hora.</p>
              </div>
            )}
          </div>
        </section>

        <section className="pt-12">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold">Personagens</h2>
            <Link to="/new" className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm font-semibold hover:border-faint">
              Novo personagem
            </Link>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data?.characters.map((c) => (
              <Link key={c.id} to={`/c/${c.slug}`} className="group overflow-hidden rounded-xl border border-line bg-[#212121] transition-colors hover:border-faint">
                <div className="relative h-72 overflow-hidden bg-room">
                  {c.coverUrl && <img src={c.coverUrl} alt="" className="absolute inset-x-0 top-3 mx-auto h-[118%] w-auto max-w-none object-contain object-top" />}
                  <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#212121] to-transparent" />
                  {c.openBatches > 0 && (
                    <span className="absolute right-3 top-3 rounded-full bg-amber px-2 py-0.5 text-2xs font-semibold text-[#1a1a1a]">
                      {c.openBatches} {c.openBatches === 1 ? 'lote' : 'lotes'} para revisar
                    </span>
                  )}
                </div>
                <div className="px-4 pb-4">
                  <h3 className="font-wide text-3xl font-extrabold leading-none tracking-tight">{c.name}</h3>
                  {c.summary && <p className="mt-2 line-clamp-2 text-sm text-dim">{c.summary}</p>}
                  <div className="mt-4">
                    <PhaseTrack phases={c.phases} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {data && data.characters.length === 0 && (
            <p className="mt-4 max-w-prose text-sm text-dim">
              Nenhum personagem ainda. Crie um com o brief do que você quer, e o agente volta com as primeiras opções de conceito.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

export function TopBar() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:px-8">
        <Link to="/" className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
            <path d="M7 12V7h5M25 12V7h-5M7 20v5h5M25 20v5h-5" fill="none" stroke="var(--color-ink)" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="16" cy="16" r="4.2" fill="none" stroke="var(--color-mark)" strokeWidth="2.4" />
          </svg>
          <span className="font-wide text-lg font-extrabold tracking-tight">Charforge</span>
        </Link>
      </div>
    </header>
  );
}
