import clsx from 'clsx';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PHASES } from '../../shared/phases.ts';
import type { CharacterDetail, Job, NextStep } from '../../shared/types.ts';
import { useCharacter, useJobs, useNext, useSetGate } from '../api.ts';
import { CheckMark } from '../components/marks.tsx';
import { BatchRow, PhaseTrack } from '../components/parts.tsx';
import { TopBar } from './LibraryPage.tsx';

const BACKEND_NAME: Record<string, string> = { comfyui: 'GPU local (ComfyUI)', openai: 'API da OpenAI', codex: 'ChatGPT (Codex CLI)', command: 'comando local', mock: 'simulado' };

export function CharacterPage() {
  const slug = useParams().slug!;
  const { data: ch, error } = useCharacter(slug);
  const { data: next } = useNext(slug);
  const { data: jobs } = useJobs(slug);
  if (error) return <div className="grid min-h-dvh place-items-center text-dim">{error.message}</div>;
  if (!ch) return <div className="min-h-dvh bg-panel" />;
  const byPhase = PHASES.map((p) => ({ phase: p, batches: ch.batches.filter((b) => b.phase === p.id) }))
    .filter((g) => g.batches.length || ch.gates[g.phase.id])
    .reverse();
  const active = jobs?.filter((j) => j.status === 'queued' || j.status === 'running') ?? [];
  const failed = jobs?.filter((j) => j.status === 'failed').slice(0, 3) ?? [];

  return (
    <div className="min-h-dvh bg-panel">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 pb-16 md:px-8">
        <section className="grid grid-cols-1 items-end gap-6 pt-6 md:grid-cols-[280px_minmax(0,1fr)] md:gap-10">
          <div className="relative h-[380px] overflow-hidden rounded-xl bg-room">
            {ch.coverUrl ? (
              <img src={ch.coverUrl} alt="" className="absolute inset-x-0 top-4 mx-auto h-[112%] w-auto max-w-none object-contain object-top" />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-faint">A capa aparece com o primeiro lote de imagens.</div>
            )}
          </div>
          <div className="pb-2">
            <h1 className="font-wide text-6xl font-extrabold leading-[0.9] tracking-tight md:text-8xl">{ch.name}</h1>
            {ch.summary && <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-dim">{ch.summary}</p>}
            <div className="mt-8">
              <PhaseTrack phases={ch.phases} labels />
            </div>
          </div>
        </section>

        <section className="mt-10 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          {next && <NextPanel ch={ch} next={next} />}
          <div className="flex flex-col gap-4">
            <ProfileCard ch={ch} />
            {(active.length > 0 || failed.length > 0) && <JobsCard active={active} failed={failed} />}
          </div>
        </section>

        {ch.brief && (
          <details className="group mt-4 rounded-lg border border-line bg-[#1f1f1f] px-4 py-3">
            <summary className="cursor-pointer list-none text-sm font-semibold">
              Brief <span className="font-normal text-dim group-open:hidden">(o que você pediu)</span>
            </summary>
            <p className="mt-2 max-w-prose whitespace-pre-wrap text-[15px] leading-relaxed text-dim">{ch.brief}</p>
          </details>
        )}

        {byPhase.map(({ phase, batches }) => (
          <section key={phase.id} className="pt-10">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-lg font-semibold">
                <span className="mr-2 text-faint">G{phase.gate}</span>
                {phase.label}
              </h2>
              {ch.gates[phase.id] && (
                <span className="inline-flex items-center gap-1 text-xs text-proof">
                  <CheckMark className="size-3.5" /> Concluída
                </span>
              )}
            </div>
            <p className="mt-1 max-w-prose text-sm text-dim">{phase.focus}</p>
            <div className="mt-4 flex flex-col gap-3">
              {batches.map((b) => (
                <BatchRow key={b.id} batch={b} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function NextPanel({ ch, next }: { ch: CharacterDetail; next: NextStep }) {
  const setGate = useSetGate(ch.slug);
  const [showAgent, setShowAgent] = useState(false);
  const phase = PHASES.find((p) => p.id === next.gate);
  const canSignOff = next.state === 'signoff' && next.gate && !(PHASES.find((p) => p.id === next.gate)?.id === 'g0');
  return (
    <div className="rounded-xl border border-line bg-[#212121] p-5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">Próximo passo</h2>
        {phase && (
          <span className="font-narrow text-sm text-dim">
            G{phase.gate} {phase.label}
          </span>
        )}
      </div>
      {next.state === 'done' ? (
        <p className="mt-2 text-[15px]">Todas as fases concluídas.</p>
      ) : next.owner ? (
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed">
          <span className="font-semibold text-amber">Com você: </span>
          {next.owner}
        </p>
      ) : (
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed">
          <span className="font-semibold">Com o agente.</span> <span className="text-dim">Nada para você fazer agora.</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {next.state === 'owner' && next.batchId && (
          <Link to={`/review/${next.batchId}`} className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-[#161616] hover:bg-white">
            Revisar agora
          </Link>
        )}
        {canSignOff && (
          <button
            type="button"
            onClick={() => setGate.mutate({ gate: next.gate!, status: 'done' })}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-[#161616] hover:bg-white"
          >
            Concluir G{phase?.gate} {phase?.label}
          </button>
        )}
        {next.agent && (
          <button type="button" onClick={() => setShowAgent((v) => !v)} className="rounded-md border border-line px-3 py-1.5 text-sm text-dim hover:text-ink">
            {showAgent ? 'Esconder' : 'Ver'} instrução do agente
          </button>
        )}
      </div>
      {showAgent && next.agent && (
        <div className="mt-4 rounded-md bg-[#171717] p-3">
          <p className="text-sm leading-relaxed text-dim">{next.agent}</p>
          {next.commands.length > 0 && <pre className="mt-2 overflow-x-auto text-xs text-ink">{next.commands.join('\n')}</pre>}
          <p className="mt-2 text-xs text-faint">
            Para retomar com qualquer agente: peça para ele rodar <code className="text-dim">forge next {ch.slug}</code> neste repositório.
          </p>
        </div>
      )}
    </div>
  );
}

function ProfileCard({ ch }: { ch: CharacterDetail }) {
  const p = ch.profile;
  return (
    <div className="rounded-xl border border-line bg-[#212121] p-4">
      <h3 className="text-sm font-semibold">Geração de imagens</h3>
      {p ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-dim">SFW</dt>
          <dd>{BACKEND_NAME[p.sfw.backend] ?? p.sfw.backend}</dd>
          <dt className="text-dim">NSFW</dt>
          <dd>{p.nsfw ? BACKEND_NAME[p.nsfw.backend] ?? p.nsfw.backend : 'nenhum'}</dd>
          {[p.sfw, p.nsfw].flatMap((c) => ((c?.options?.loras as { name: string; weight: number }[] | undefined) ?? [])).slice(0, 1).map((l) => (
            <div key={l.name} className="contents">
              <dt className="text-dim">LoRA</dt>
              <dd className="truncate font-narrow">{l.name}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-dim">Ainda não escolhido.</p>
      )}
    </div>
  );
}

function JobsCard({ active, failed }: { active: Job[]; failed: Job[] }) {
  return (
    <div className="rounded-xl border border-line bg-[#212121] p-4">
      <h3 className="text-sm font-semibold">Gerando</h3>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm">
        {active.map((j) => (
          <li key={j.id} className="flex items-center gap-2">
            <span className={clsx('size-2 shrink-0 rounded-full', j.status === 'running' ? 'animate-pulse bg-amber' : 'bg-faint')} />
            <span className="min-w-0 flex-1 truncate">{j.title}</span>
            <span className="shrink-0 font-narrow text-xs text-dim">{j.status === 'running' ? 'gerando' : 'na fila'}</span>
          </li>
        ))}
        {failed.map((j) => (
          <li key={j.id} className="text-xs text-mark" title={j.error ?? ''}>
            Falhou: {j.title}. {j.error?.slice(0, 120)}
          </li>
        ))}
      </ul>
    </div>
  );
}
