// Pick batches: several candidates for the same thing (seeds of one hand, epochs of a LoRA...).
// Every candidate shares one zoom and pan, so the same finger is compared across all of them.
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { isApproval } from '../../shared/taxonomy.ts';
import type { BatchDetail, Item, RegionKind } from '../../shared/types.ts';
import { useKeys } from '../hooks.ts';
import { CheckMark, CrossMark } from '../components/marks.tsx';
import { Kbd } from '../components/parts.tsx';
import { RejectMenu } from '../components/RejectMenu.tsx';
import { reasonOf } from '../../shared/taxonomy.ts';
import { BACKGROUNDS, FIT, Viewer, type Bg, type View } from '../components/Viewer.tsx';
import { HelpOverlay, ReviewHeader, SubmitDialog, useReviewActions } from './ReviewPage.tsx';

export function PickBoard({ batch }: { batch: BatchDetail }) {
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of batch.items) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return [...m.entries()];
  }, [batch.items]);
  const [gi, setGi] = useState(0);
  const [view, setView] = useState<View>(FIT);
  const [menu, setMenu] = useState<number | null>(null);
  const [bg, setBg] = useState<Bg>('checker');
  const [help, setHelp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { patch, locked } = useReviewActions(batch);

  const [groupName, cands] = groups[Math.min(gi, groups.length - 1)];
  const cols = cands.length <= 2 ? 2 : cands.length <= 4 ? 2 : cands.length <= 6 ? 3 : 4;

  const pick = (it: Item) => patch(it, { verdict: it.review.verdict === 'approve' ? null : 'approve', ...(it.review.verdict === 'approve' ? {} : { reasons: it.review.reasons.filter(isApproval) }) });
  const rejectAll = () => cands.filter((c) => c.review.verdict !== 'reject').forEach((c) => patch(c, { verdict: 'reject' }));

  useKeys((e) => {
    const k = e.key;
    if (help && k !== '?') return setHelp(false);
    if (/^[1-9]$/.test(k) && cands[Number(k) - 1]) pick(cands[Number(k) - 1]);
    else if (k === 'ArrowRight') setGi((g) => Math.min(groups.length - 1, g + 1));
    else if (k === 'ArrowLeft') setGi((g) => Math.max(0, g - 1));
    else if (k === 'f' || k === 'Escape') setView(FIT);
    else if (k === 'b') setBg(BACKGROUNDS[(BACKGROUNDS.findIndex((b) => b.id === bg) + 1) % BACKGROUNDS.length].id);
    else if (k === '?') setHelp(true);
    else return;
    e.preventDefault();
  });

  const toggleReason = (it: Item, code: string) => {
    const has = it.review.reasons.includes(code);
    const reasons = has ? it.review.reasons.filter((c) => c !== code) : [...it.review.reasons, code];
    patch(it, { reasons, ...(!has && !isApproval(code) && it.review.verdict !== 'reject' ? { verdict: 'reject' as const } : {}) });
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-panel">
      <ReviewHeader batch={batch} onSubmit={() => setSubmitting(true)} onHelp={() => setHelp(true)} />
      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <section className="flex flex-col lg:min-h-0">
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3 py-2">
            {groups.map(([name, its], i) => {
              const picked = its.some((c) => c.review.verdict === 'approve');
              const none = its.every((c) => c.review.verdict === 'reject');
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setGi(i)}
                  className={clsx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm', i === gi ? 'border-amber text-ink' : 'border-line text-dim hover:text-ink')}
                >
                  {picked ? <CheckMark className="size-3.5" /> : none ? <CrossMark className="size-3.5" /> : <span className="size-1.5 rounded-full bg-faint" />}
                  {name || 'Candidatas'}
                </button>
              );
            })}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {BACKGROUNDS.slice(0, 5).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  title={b.label}
                  onClick={() => setBg(b.id)}
                  className={clsx('grid size-7 place-items-center rounded-md', bg === b.id ? 'ring-1 ring-amber' : 'hover:bg-white/10')}
                >
                  <span className={clsx('size-3.5 rounded-sm ring-1 ring-white/25', { checker: 'bg-checker', room: 'bg-room', dark: 'bg-[#0d0d0d]', light: 'bg-[#f4f4f2]', magenta: 'bg-[#ff00d4]', alpha: '' }[b.id])} />
                </button>
              ))}
            </div>
          </div>
          <div className={clsx('grid grid-cols-2 gap-2 p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto', cols === 3 && 'lg:grid-cols-3', cols === 4 && 'lg:grid-cols-4')}>
            {cands.map((it, i) => {
              const v = it.review.verdict;
              return (
                <div
                  key={it.id}
                  className={clsx(
                    'relative flex h-[300px] flex-col rounded-lg border bg-room lg:h-auto lg:min-h-[260px]',
                    v === 'approve' ? 'border-proof' : menu === it.id ? 'border-mark' : 'border-line',
                  )}
                >
                  <div className="relative min-h-0 flex-1 overflow-hidden rounded-t-lg">
                    <Viewer className={clsx('h-full w-full', v === 'reject' && 'opacity-45')} src={it.url} width={it.width} height={it.height} view={view} onView={setView} bg={bg} padding={0.98} regions={it.regions} />
                    {v === 'approve' && <CheckMark className="pointer-events-none absolute right-3 top-3 size-10 drop-shadow-[0_1px_3px_rgba(0,0,0,.8)]" animate />}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 rounded-b-lg border-t border-line bg-[#1d1d1d] px-2.5 py-1.5">
                    <span className="font-narrow text-sm font-semibold">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-dim">{it.label}</div>
                      {v === 'reject' && (
                        <button type="button" disabled={locked} onClick={() => setMenu(it.id)} className="block max-w-full truncate text-left text-2xs text-mark hover:underline">
                          {it.review.reasons.length ? it.review.reasons.map((c) => reasonOf(c)?.label ?? c).join(', ') : 'Dizer o motivo'}
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        if (v !== 'reject') patch(it, { verdict: 'reject' });
                        setMenu(menu === it.id ? null : it.id);
                      }}
                      className={clsx('grid size-7 place-items-center rounded-md', v === 'reject' ? 'bg-mark/20' : 'hover:bg-white/10')}
                      aria-label={`Recusar ${it.label} e dizer o motivo`}
                      aria-expanded={menu === it.id}
                    >
                      <CrossMark className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => pick(it)}
                      className={clsx('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold', v === 'approve' ? 'bg-proof text-[#0c160f]' : 'border border-line hover:border-proof/70')}
                    >
                      {v === 'approve' ? 'Escolhida' : 'Escolher'} <Kbd>{i + 1}</Kbd>
                    </button>
                  </div>
                  {menu === it.id && (
                    <RejectMenu
                      kind={(it.meta.kind as RegionKind | undefined) ?? it.regions[0]?.kind ?? null}
                      phase={batch.phase}
                      selected={it.review.reasons}
                      note={it.review.note}
                      onToggle={(code) => toggleReason(it, code)}
                      onNote={(note) => patch(it, { note })}
                      onUndo={() => {
                        patch(it, { verdict: null, reasons: [] });
                        setMenu(null);
                      }}
                      onClose={() => setMenu(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <aside className="min-h-0 overflow-y-auto border-t border-line p-4 lg:border-l lg:border-t-0">
          <p className="text-sm text-dim">
            Escolha uma candidata por grupo. Roda do mouse ou pinça aproxima todas juntas, no mesmo ponto. Se nenhuma serve, recuse todas e diga por quê.
          </p>
          <button type="button" disabled={locked} onClick={rejectAll} className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs text-dim hover:border-mark/70 hover:text-ink">
            Nenhuma serve neste grupo
          </button>
          {batch.notes && (
            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-1 text-xs font-semibold text-dim">Notas do Claude</div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{batch.notes}</p>
            </div>
          )}
          <p className="mt-5 border-t border-line pt-4 text-xs text-faint">Para recusar, use o X embaixo da própria imagem: os motivos abrem ali mesmo.</p>
        </aside>
      </div>
      {help && <HelpOverlay pick onClose={() => setHelp(false)} />}
      {submitting && <SubmitDialog batch={batch} onClose={() => setSubmitting(false)} />}
    </div>
  );
}
