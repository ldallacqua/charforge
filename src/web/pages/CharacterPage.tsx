import { useParams } from 'react-router';
import { PHASES } from '../../shared/phases.ts';
import { useCharacter } from '../api.ts';
import { BatchRow, PhaseTrack } from '../components/parts.tsx';
import { TopBar } from './LibraryPage.tsx';

export function CharacterPage() {
  const slug = useParams().slug!;
  const { data: ch, error } = useCharacter(slug);
  if (error) return <div className="grid min-h-dvh place-items-center text-dim">{error.message}</div>;
  if (!ch) return <div className="min-h-dvh bg-panel" />;
  const byPhase = PHASES.map((p) => ({ phase: p, batches: ch.batches.filter((b) => b.phase === p.id) }))
    .filter((g) => g.batches.length)
    .reverse();
  return (
    <div className="min-h-dvh bg-panel">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 pb-16 md:px-8">
        <section className="grid grid-cols-1 items-end gap-6 pt-6 md:grid-cols-[280px_minmax(0,1fr)] md:gap-10">
          <div className="relative h-[380px] overflow-hidden rounded-xl bg-room">
            {ch.coverUrl && <img src={ch.coverUrl} alt="" className="absolute inset-x-0 top-4 mx-auto h-[112%] w-auto max-w-none object-contain object-top" />}
          </div>
          <div className="pb-2">
            <h1 className="font-wide text-6xl font-extrabold leading-[0.9] tracking-tight md:text-8xl">{ch.name}</h1>
            {ch.summary && <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-dim">{ch.summary}</p>}
            <div className="mt-8">
              <PhaseTrack phases={ch.phases} labels />
            </div>
          </div>
        </section>

        {byPhase.map(({ phase, batches }) => (
          <section key={phase.id} className="pt-10">
            <h2 className="text-lg font-semibold">
              <span className="mr-2 text-faint">G{phase.gate}</span>
              {phase.label}
            </h2>
            <p className="mt-1 max-w-prose text-sm text-dim">{phase.focus}</p>
            <div className="mt-4 flex flex-col gap-3">
              {batches.map((b) => (
                <BatchRow key={b.id} batch={b} />
              ))}
            </div>
          </section>
        ))}
        {ch.batches.length === 0 && <p className="pt-10 text-sm text-dim">Nenhum lote ainda. O primeiro aparece aqui quando o Claude enviar.</p>}
      </main>
    </div>
  );
}
