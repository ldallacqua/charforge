import clsx from 'clsx';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateCharacter, usePresets } from '../api.ts';
import { TopBar } from './LibraryPage.tsx';

const slugify = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const BACKEND_NAME: Record<string, string> = { comfyui: 'GPU local', openai: 'API da OpenAI', codex: 'ChatGPT (Codex CLI)', command: 'comando local', mock: 'simulado' };

export function NewCharacterPage() {
  const nav = useNavigate();
  const { data } = usePresets();
  const create = useCreateCharacter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [brief, setBrief] = useState('');
  const [preset, setPreset] = useState('local');
  const [adult, setAdult] = useState(false);
  const effectiveSlug = slug || slugify(name);
  const ready = name.trim() && effectiveSlug && brief.trim().length >= 20 && adult;

  return (
    <div className="min-h-dvh bg-panel">
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 pb-20 pt-8 md:px-8">
        <h1 className="font-wide text-4xl font-extrabold tracking-tight">Novo personagem</h1>
        <p className="mt-2 max-w-prose text-[15px] text-dim">
          Descreva quem você quer. O agente lê o brief e volta com várias opções de conceito para você escolher do que gosta; as próximas rodadas juntam as partes escolhidas.
        </p>

        <form
          className="mt-8 flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            create.mutate({ slug: effectiveSlug, name: name.trim(), brief: brief.trim(), preset, adult }, { onSuccess: (ch) => nav(`/c/${ch.slug}`) });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">Nome</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full rounded-md border border-line bg-[#161616] px-3 py-2 text-[15px] focus:border-faint focus:outline-none" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">Identificador</span>
              <input
                value={effectiveSlug}
                onChange={(e) => setSlug(slugify(e.target.value))}
                className="w-full rounded-md border border-line bg-[#161616] px-3 py-2 font-narrow text-[15px] text-dim focus:border-faint focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-semibold">Brief</span>
            <span className="mb-2 block text-xs text-dim">
              Quem é, aparência, personalidade, onde vai ser usado (SillyTavern, jogo). Pode ser solto: o que importar, escreva. Referências de outros personagens só como inspiração de clima.
            </span>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={8}
              placeholder="Ex.: uma súcubo nobre, adulta, cabelo curto vermelho, olhos verdes, chifres escuros curvados; elegante e provocadora, mas leal. Para RP no SillyTavern, com versões vestida e nua."
              className="w-full rounded-md border border-line bg-[#161616] px-3 py-2.5 text-[15px] leading-relaxed placeholder:text-faint focus:border-faint focus:outline-none"
            />
          </label>

          <fieldset>
            <legend className="mb-1 text-sm font-semibold">Como as imagens são geradas</legend>
            <p className="mb-3 text-xs text-dim">Dá para trocar depois. Conteúdo NSFW só sai da GPU local: os serviços da OpenAI recusam.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {data?.presets.map((p) => (
                <label
                  key={p.id}
                  className={clsx('flex cursor-pointer flex-col gap-1 rounded-lg border p-3.5 transition-colors', preset === p.id ? 'border-amber bg-amber/5' : 'border-line hover:border-faint')}
                >
                  <input type="radio" name="preset" value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} className="sr-only" />
                  <span className="text-sm font-semibold">{p.label}</span>
                  <span className="text-xs leading-relaxed text-dim">{p.description}</span>
                  <span className="mt-1 flex flex-wrap gap-x-3 font-narrow text-2xs text-faint">
                    <span>SFW: {BACKEND_NAME[p.profile.sfw.backend]}</span>
                    <span>NSFW: {p.profile.nsfw ? BACKEND_NAME[p.profile.nsfw.backend] : 'nenhum'}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-start gap-3 rounded-lg border border-line p-3.5">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-amber)]" />
            <span className="text-sm">
              <span className="font-semibold">O personagem é adulto.</span>
              <span className="block text-xs text-dim">Obrigatório. O brief, o card e todos os prompts tratam o personagem como adulto.</span>
            </span>
          </label>

          {create.error && <p className="text-sm text-mark">{create.error.message}</p>}
          <div className="flex items-center gap-3">
            <button type="submit" disabled={!ready || create.isPending} className="rounded-md bg-ink px-4 py-2.5 text-sm font-semibold text-[#161616] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
              Criar personagem
            </button>
            {!ready && <span className="text-xs text-faint">Falta {!name.trim() ? 'o nome' : brief.trim().length < 20 ? 'um brief um pouco maior' : 'confirmar que é adulto'}.</span>}
          </div>
        </form>
      </main>
    </div>
  );
}
