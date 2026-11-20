import clsx from 'clsx';
import { ArrowLeft, Columns2, Eye, EyeOff, Focus as FocusIcon, History, Keyboard, MapPin, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { phaseOf } from '../../shared/phases.ts';
import { isApproval, REGION_KIND_LABEL, reasonOf } from '../../shared/taxonomy.ts';
import type { BatchDetail, Box, Item, Pin, Review } from '../../shared/types.ts';
import { useBatch, useReopenBatch, useSaveReview, useSubmitBatch } from '../api.ts';
import { useKeys } from '../hooks.ts';
import { CheckMark, CrossMark } from '../components/marks.tsx';
import { CountsLine, Filmstrip, Kbd, Loupe, SegmentBar, phaseLabel } from '../components/parts.tsx';
import { ApprovalChips, ReasonPicker } from '../components/Reasons.tsx';
import { BACKGROUNDS, FIT, Viewer, type Bg, type Compare, type Focus, type View } from '../components/Viewer.tsx';
import { PickBoard } from './PickBoard.tsx';

type Target = { type: 'item' } | { type: 'region'; id: string } | { type: 'pin'; id: string };

const loadBg = (): Bg => {
  try {
    return (localStorage.getItem('charforge.bg') as Bg) || 'checker';
  } catch {
    return 'checker';
  }
};

export function ReviewPage() {
  const id = Number(useParams().id);
  const { data: batch, error } = useBatch(id);
  if (error) return <div className="grid h-dvh place-items-center text-dim">{error.message}</div>;
  if (!batch) return <div className="h-dvh bg-room" />;
  return batch.kind === 'pick' ? <PickBoard batch={batch} /> : <ReviewBoard batch={batch} />;
}

export function useReviewActions(batch: BatchDetail) {
  const save = useSaveReview(batch.id);
  const locked = batch.status !== 'open';
  const patch = useCallback(
    (item: Item, p: Partial<Review>) => {
      if (!locked) save.mutate({ itemId: item.id, patch: p });
    },
    [locked, save],
  );
  return { patch, locked, saving: save.isPending, saveError: save.error };
}

function ReviewBoard({ batch }: { batch: BatchDetail }) {
  const [params, setParams] = useSearchParams();
  const items = batch.items;
  const index = Math.min(items.length - 1, Math.max(0, Number(params.get('i') ?? 0)));
  const item = items[index];
  const { patch, locked, saveError } = useReviewActions(batch);

  const [view, setView] = useState<View>(FIT);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [focusRegion, setFocusRegion] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>({ type: 'item' });
  const [bg, setBgState] = useState<Bg>(loadBg);
  const [compare, setCompare] = useState<Compare>('after');
  const [split, setSplit] = useState(0.5);
  const [overlays, setOverlays] = useState(true);
  const [pinMode, setPinMode] = useState(false);
  const [scale, setScale] = useState(1);
  const [help, setHelp] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const setBg = (b: Bg) => {
    setBgState(b);
    try {
      localStorage.setItem('charforge.bg', b);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };

  const go = (i: number) => {
    const next = Math.min(items.length - 1, Math.max(0, i));
    if (next === index) return;
    const label = item.regions.find((g) => g.id === focusRegion)?.label;
    const nextItem = items[next];
    const same = label ? nextItem.regions.find((g) => g.label === label) : undefined;
    setParams({ i: String(next) }, { replace: true });
    setTarget(same ? { type: 'region', id: same.id } : { type: 'item' });
    setPinMode(false);
    if (same) {
      // keep the loupe on the same hand while flipping expressions: the consistency check
      setFocusRegion(same.id);
      setFocus({ box: same.box, key: `${nextItem.id}:${same.id}` });
    } else {
      setFocusRegion(null);
      setFocus(null);
      setView(FIT);
    }
    if (!nextItem.prevUrl) setCompare('after');
  };

  const focusOn = (regionId: string | null) => {
    if (!regionId) {
      setFocusRegion(null);
      setTarget({ type: 'item' });
      setFocus(null);
      setView(FIT);
      return;
    }
    const g = item.regions.find((r) => r.id === regionId);
    if (!g) return;
    setFocusRegion(g.id);
    setTarget({ type: 'region', id: g.id });
    setFocus({ box: g.box, key: `${item.id}:${g.id}:${Date.now()}` });
  };

  const review = item.review;
  const setVerdict = (v: Review['verdict']) => patch(item, { verdict: review.verdict === v ? null : v });

  const approve = () => {
    patch(item, { verdict: 'approve' });
    if (review.verdict !== 'approve') setTimeout(() => go(nextPending(items, index)), 180);
  };

  const toggleReason = (code: string) => {
    if (isApproval(code)) {
      const has = review.reasons.includes(code);
      patch(item, { reasons: has ? review.reasons.filter((c) => c !== code) : [...review.reasons, code], verdict: has ? review.verdict : 'approve' });
      return;
    }
    const autoReject = review.verdict === null ? { verdict: 'reject' as const } : {};
    if (target.type === 'region') {
      const cur = review.regions[target.id] ?? { verdict: 'bad' as const, reasons: [] };
      const reasons = cur.reasons.includes(code) ? cur.reasons.filter((c) => c !== code) : [...cur.reasons, code];
      const regions = { ...review.regions };
      if (reasons.length) regions[target.id] = { verdict: 'bad', reasons };
      else delete regions[target.id];
      patch(item, { regions, ...(reasons.length ? autoReject : {}) });
    } else if (target.type === 'pin') {
      const pins = review.pins.map((p) => (p.id === target.id ? { ...p, reason: p.reason === code ? undefined : code } : p));
      patch(item, { pins, ...autoReject });
    } else {
      const has = review.reasons.includes(code);
      patch(item, { reasons: has ? review.reasons.filter((c) => c !== code) : [...review.reasons, code], ...(has ? {} : autoReject) });
    }
  };

  const markRegion = (regionId: string, verdict: 'ok' | 'bad' | null) => {
    const regions = { ...review.regions };
    if (verdict === null) delete regions[regionId];
    else regions[regionId] = { verdict, reasons: verdict === 'ok' ? [] : regions[regionId]?.reasons ?? [] };
    patch(item, { regions, ...(verdict === 'bad' && review.verdict === null ? { verdict: 'reject' } : {}) });
  };

  const okAndNext = () => {
    if (!focusRegion) return;
    markRegion(focusRegion, 'ok');
    const i = item.regions.findIndex((g) => g.id === focusRegion);
    const next = item.regions[i + 1];
    if (next) focusOn(next.id);
  };

  const addPin = (box: Box) => {
    const pin: Pin = { id: `p${Date.now().toString(36)}`, box };
    patch(item, { pins: [...review.pins, pin], ...(review.verdict === null ? { verdict: 'reject' } : {}) });
    setTarget({ type: 'pin', id: pin.id });
  };
  const removePin = (pinId: string) => {
    patch(item, { pins: review.pins.filter((p) => p.id !== pinId) });
    setTarget({ type: 'item' });
  };

  useKeys((e) => {
    const k = e.key;
    if (help && k !== '?') return setHelp(false);
    if (k === 'ArrowRight' || k === 'j' || k === 'ArrowDown') go(index + 1);
    else if (k === 'ArrowLeft' || k === 'k' || k === 'ArrowUp') go(index - 1);
    else if (k === 'a') approve();
    else if (k === 'r') patch(item, { verdict: 'reject' });
    else if (k === 'u') patch(item, { verdict: null });
    else if (k === 'o') okAndNext();
    else if (k === 'x' && focusRegion) markRegion(focusRegion, 'bad');
    else if (k === 'f' || k === '0' || k === 'Escape') focusOn(null);
    else if (/^[1-9]$/.test(k)) {
      const g = item.regions[Number(k) - 1];
      if (g) focusOn(g.id);
    } else if (k === 'Tab') {
      e.preventDefault();
      if (!item.regions.length) return;
      const i = item.regions.findIndex((g) => g.id === focusRegion);
      const n = (i + (e.shiftKey ? -1 : 1) + item.regions.length + 1) % (item.regions.length + 1);
      focusOn(n === item.regions.length ? null : item.regions[n].id);
    } else if (k === 'b') setBg(BACKGROUNDS[(BACKGROUNDS.findIndex((b) => b.id === bg) + 1) % BACKGROUNDS.length].id);
    else if (k === 'c' && item.prevUrl) setCompare((c) => (c === 'after' ? 'split' : c === 'split' ? 'before' : 'after'));
    else if (k === 'h') setOverlays((o) => !o);
    else if (k === 'p') setPinMode((m) => !m);
    else if (k === '?') setHelp((h) => !h);
    else if ((k === 'Backspace' || k === 'Delete') && target.type === 'pin') removePin(target.id);
    else return;
    e.preventDefault();
  });

  const targetKind = target.type === 'region' ? item.regions.find((g) => g.id === target.id)?.kind ?? null : null;
  const selectedCodes =
    target.type === 'region' ? review.regions[target.id]?.reasons ?? [] : target.type === 'pin' ? [review.pins.find((p) => p.id === target.id)?.reason].filter(Boolean) as string[] : review.reasons.filter((c) => !isApproval(c));
  const phase = phaseOf(batch.phase);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-panel">
      <ReviewHeader batch={batch} index={index} onSelect={go} onSubmit={() => setSubmitting(true)} onHelp={() => setHelp(true)} />
      {locked && <LockedBanner batch={batch} />}

      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[132px_minmax(0,1fr)_minmax(340px,380px)] lg:grid-rows-1 lg:overflow-hidden">
        <aside className="hidden min-h-0 overflow-hidden border-r border-line lg:block">
          <Filmstrip items={items} current={index} onSelect={go} />
        </aside>

        <section className="relative h-[62dvh] min-h-0 lg:h-auto">
          <Viewer
            className="h-full w-full"
            src={item.url}
            prevSrc={item.prevUrl}
            width={item.width}
            height={item.height}
            view={view}
            onView={setView}
            focus={focus}
            regions={item.regions}
            focusRegion={focusRegion}
            regionMarks={review.regions}
            onRegionClick={focusOn}
            pins={review.pins}
            selectedPin={target.type === 'pin' ? target.id : null}
            onPinCreate={locked ? undefined : addPin}
            onPinClick={(pid) => setTarget({ type: 'pin', id: pid })}
            pinMode={pinMode && !locked}
            bg={bg}
            compare={compare}
            split={split}
            onSplit={setSplit}
            overlays={overlays}
            onScale={setScale}
          />
          <ViewerToolbar
            bg={bg}
            setBg={setBg}
            hasPrev={!!item.prevUrl}
            compare={compare}
            setCompare={setCompare}
            overlays={overlays}
            setOverlays={setOverlays}
            pinMode={pinMode}
            setPinMode={locked ? undefined : setPinMode}
            scale={scale}
            onFit={() => focusOn(null)}
          />
          <div className="pointer-events-none absolute left-3 top-3 max-w-[60%]">
            <div className="font-narrow text-2xs text-faint">
              {String(index + 1).padStart(2, '0')} de {items.length}
              {item.group ? `, ${item.group}` : ''}
            </div>
            <div className="text-lg font-semibold leading-tight [text-shadow:0_1px_3px_rgba(0,0,0,.6)]">{item.label}</div>
          </div>
        </section>

        <aside className="flex flex-col border-t border-line lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="lg:hidden">
            <Filmstrip items={items} current={index} onSelect={go} horizontal />
          </div>
          <div className="px-4 pb-4 pt-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {phase && <p className="mb-3 text-xs leading-relaxed text-dim">{phase.focus}</p>}

            {item.checks.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {item.checks.map((c) => (
                  <span
                    key={c.name}
                    title={c.detail}
                    className={clsx(
                      'rounded border px-1.5 py-0.5 font-narrow text-2xs',
                      c.status === 'pass' && 'border-proof/40 text-proof',
                      c.status === 'warn' && 'border-amber/50 text-amber',
                      c.status === 'fail' && 'border-mark/60 text-mark',
                      c.status === 'info' && 'border-line text-dim',
                    )}
                  >
                    {c.name}
                    {c.detail ? `: ${c.detail}` : ''}
                  </span>
                ))}
              </div>
            )}

            {item.regions.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-2">
                {item.regions.map((g, i) => (
                  <Loupe key={g.id} item={item} region={g} index={i} mark={review.regions[g.id]} focused={focusRegion === g.id} bg={bg} onClick={() => focusOn(g.id)} />
                ))}
              </div>
            )}

            <TargetHeader item={item} target={target} setTarget={setTarget} focusRegion={focusRegion} markRegion={markRegion} removePin={removePin} locked={locked} />

            <fieldset disabled={locked} className="mt-3 disabled:opacity-60">
              <ReasonPicker kind={targetKind} selected={selectedCodes} onToggle={toggleReason} />
              {target.type === 'pin' && (
                <PinNote
                  key={target.id}
                  pin={review.pins.find((p) => p.id === target.id)}
                  onSave={(note) => patch(item, { pins: review.pins.map((p) => (p.id === target.id ? { ...p, note } : p)) })}
                />
              )}
              <ItemNote key={item.id} value={review.note} onSave={(note) => patch(item, { note })} />
            </fieldset>
            {saveError && <p className="mt-2 text-xs text-mark">Não salvou: {saveError.message}</p>}
          </div>

          <VerdictBar review={review} locked={locked} onApprove={approve} onReject={() => setVerdict('reject')} onToggleApproval={toggleReason} />
        </aside>
      </div>

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
      {submitting && <SubmitDialog batch={batch} onClose={() => setSubmitting(false)} />}
    </div>
  );
}

function nextPending(items: Item[], from: number) {
  for (let i = from + 1; i < items.length; i++) if (!items[i].review.verdict) return i;
  return Math.min(items.length - 1, from + 1);
}

export function ReviewHeader({ batch, index, onSelect, onSubmit, onHelp }: { batch: BatchDetail; index?: number; onSelect?: (i: number) => void; onSubmit: () => void; onHelp: () => void }) {
  const open = batch.status === 'open';
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5 md:flex-row md:items-center md:gap-4 md:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link to={`/c/${batch.characterSlug}`} className="grid size-8 shrink-0 place-items-center rounded-md text-dim hover:bg-raised hover:text-ink" aria-label={`Voltar para ${batch.characterName}`}>
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-tight">{batch.title}</div>
          <div className="truncate font-narrow text-xs text-dim">
            {batch.characterName}, {phaseLabel(batch.phase)}, rodada {batch.round}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0 flex-1">
          <SegmentBar items={batch.items} current={index} onSelect={onSelect} />
        </div>
        <CountsLine counts={batch.counts} className="hidden shrink-0 sm:inline-flex" />
        <button type="button" onClick={onHelp} className="hidden size-8 shrink-0 place-items-center rounded-md text-dim hover:bg-raised hover:text-ink md:grid" aria-label="Atalhos de teclado">
          <Keyboard className="size-4" />
        </button>
        {open && (
          <button
            type="button"
            onClick={onSubmit}
            className={clsx(
              'shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold',
              batch.counts.pending === 0 ? 'bg-ink text-[#161616] hover:bg-white' : 'border border-line text-dim hover:text-ink',
            )}
          >
            Enviar revisão
          </button>
        )}
      </div>
    </header>
  );
}

function LockedBanner({ batch }: { batch: BatchDetail }) {
  const reopen = useReopenBatch(batch.id);
  const when = batch.submittedAt ? new Date(batch.submittedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  return (
    <div className="flex items-center gap-3 border-b border-line bg-raised/60 px-4 py-2 text-xs text-dim">
      <span>Revisão enviada ao Claude {when && `em ${when}`}. Os vereditos estão travados.</span>
      <button type="button" onClick={() => reopen.mutate()} className="ml-auto rounded border border-line px-2 py-1 text-ink hover:border-faint">
        Reabrir para editar
      </button>
    </div>
  );
}

function TargetHeader({ item, target, setTarget, focusRegion, markRegion, removePin, locked }: {
  item: Item; target: Target; setTarget: (t: Target) => void; focusRegion: string | null;
  markRegion: (id: string, v: 'ok' | 'bad' | null) => void; removePin: (id: string) => void; locked: boolean;
}) {
  const review = item.review;
  let title = 'Imagem inteira';
  let sub = 'Motivos valem para a imagem toda. Clique numa lupa para julgar uma região.';
  let actions: React.ReactNode = null;
  if (target.type === 'region') {
    const g = item.regions.find((r) => r.id === target.id);
    const mark = review.regions[target.id];
    title = g ? g.label || REGION_KIND_LABEL[g.kind] : 'Região';
    sub = 'Marque OK ou escolha o que está errado nesta região.';
    actions = (
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={locked}
          onClick={() => markRegion(target.id, mark?.verdict === 'ok' ? null : 'ok')}
          className={clsx('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold', mark?.verdict === 'ok' ? 'border-proof bg-proof/15 text-ink' : 'border-line text-dim hover:text-ink')}
        >
          <CheckMark className="size-3.5" /> OK <Kbd>O</Kbd>
        </button>
      </div>
    );
  } else if (target.type === 'pin') {
    const n = review.pins.findIndex((p) => p.id === target.id);
    title = `Marcação ${n + 1}`;
    sub = 'Escolha o motivo desta marcação e, se quiser, escreva o que viu.';
    actions = (
      <button type="button" disabled={locked} onClick={() => removePin(target.id)} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-dim hover:text-mark">
        <Trash2 className="size-3.5" /> Apagar
      </button>
    );
  }
  return (
    <div className="border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-dim">{sub}</div>
        </div>
        {actions}
      </div>
      {(target.type !== 'item' || focusRegion) && (
        <button type="button" onClick={() => setTarget({ type: 'item' })} className="mt-2 text-xs text-dim underline-offset-2 hover:text-ink hover:underline">
          Julgar a imagem inteira
        </button>
      )}
      {review.pins.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {review.pins.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setTarget({ type: 'pin', id: p.id })}
              className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs', target.type === 'pin' && target.id === p.id ? 'border-amber text-ink' : 'border-mark/50 text-dim')}
            >
              <span className="font-bold text-mark">{i + 1}</span> {p.reason ? reasonOf(p.reason)?.label : 'sem motivo'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemNote({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onSave(text), 700);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="mt-4 block">
      <span className="mb-1 block text-xs text-dim">Nota para o Claude</span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onSave(text)}
        rows={2}
        placeholder="O que você viu, o que espera na próxima rodada"
        className="w-full resize-y rounded-md border border-line bg-[#161616] px-2.5 py-2 text-sm text-ink placeholder:text-faint focus:border-faint focus:outline-none"
      />
    </label>
  );
}

function PinNote({ pin, onSave }: { pin?: Pin; onSave: (v: string) => void }) {
  const [text, setText] = useState(pin?.note ?? '');
  if (!pin) return null;
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== (pin.note ?? '') && onSave(text)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      placeholder="Detalhe desta marcação"
      className="mt-3 w-full rounded-md border border-line bg-[#161616] px-2.5 py-1.5 text-sm placeholder:text-faint focus:border-faint focus:outline-none"
    />
  );
}

function VerdictBar({ review, locked, onApprove, onReject, onToggleApproval }: { review: Review; locked: boolean; onApprove: () => void; onReject: () => void; onToggleApproval: (c: string) => void }) {
  const v = review.verdict;
  return (
    <div className="sticky bottom-0 z-10 shrink-0 border-t border-line bg-[#191919] px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
      {v === 'approve' && (
        <div className="mb-3">
          <ApprovalChips selected={review.reasons} onToggle={onToggleApproval} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={locked}
          onClick={onReject}
          className={clsx(
            'flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-semibold transition-colors disabled:opacity-50',
            v === 'reject' ? 'border-mark bg-mark text-[#160d0c]' : 'border-line text-ink hover:border-mark/70',
          )}
        >
          <CrossMark className={clsx('size-4', v === 'reject' && 'text-[#160d0c]')} animate={v === 'reject'} /> Recusar <Kbd>R</Kbd>
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={onApprove}
          className={clsx(
            'flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-semibold transition-colors disabled:opacity-50',
            v === 'approve' ? 'border-proof bg-proof text-[#0c160f]' : 'border-line text-ink hover:border-proof/70',
          )}
        >
          <CheckMark className={clsx('size-4', v === 'approve' && 'text-[#0c160f]')} animate={v === 'approve'} /> Aprovar <Kbd>A</Kbd>
        </button>
      </div>
    </div>
  );
}

function ViewerToolbar(p: {
  bg: Bg; setBg: (b: Bg) => void; hasPrev: boolean; compare: Compare; setCompare: (c: Compare) => void;
  overlays: boolean; setOverlays: (o: boolean) => void; pinMode: boolean; setPinMode?: (m: boolean) => void; scale: number; onFit: () => void;
}) {
  const btn = 'grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-dim hover:bg-white/10 hover:text-ink';
  return (
    <div className="absolute bottom-3 left-1/2 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl border border-line bg-[#171717]/90 p-1 shadow-[0_8px_30px_rgba(0,0,0,.45)] backdrop-blur">
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Fundo">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            type="button"
            role="radio"
            aria-checked={p.bg === b.id}
            title={`${b.label}: ${b.hint}`}
            onClick={() => p.setBg(b.id)}
            className={clsx('grid size-8 place-items-center rounded-md', p.bg === b.id ? 'bg-white/12 ring-1 ring-amber' : 'hover:bg-white/10')}
          >
            <span
              className={clsx(
                'size-4 rounded-sm ring-1 ring-white/25',
                b.id === 'checker' && 'bg-checker',
                b.id === 'room' && 'bg-room',
                b.id === 'dark' && 'bg-[#0d0d0d]',
                b.id === 'light' && 'bg-[#f4f4f2]',
                b.id === 'magenta' && 'bg-[#ff00d4]',
                b.id === 'alpha' && 'bg-[linear-gradient(90deg,#000_50%,#fff_50%)]',
              )}
            />
          </button>
        ))}
      </div>
      <span className="mx-1 h-5 w-px bg-line" />
      {p.hasPrev && (
        <button
          type="button"
          title="Comparar com a rodada anterior (C)"
          onClick={() => p.setCompare(p.compare === 'after' ? 'split' : p.compare === 'split' ? 'before' : 'after')}
          className={clsx(btn, p.compare !== 'after' && 'bg-white/12 text-amber')}
        >
          {p.compare === 'before' ? <History className="size-4" /> : <Columns2 className="size-4" />}
        </button>
      )}
      <button type="button" title="Mostrar ou esconder marcações (H)" onClick={() => p.setOverlays(!p.overlays)} className={btn}>
        {p.overlays ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </button>
      {p.setPinMode && (
        <button type="button" title="Marcar um ponto (P, ou Shift + arrastar)" onClick={() => p.setPinMode!(!p.pinMode)} className={clsx(btn, p.pinMode && 'bg-mark/20 text-mark')}>
          <MapPin className="size-4" />
        </button>
      )}
      <button type="button" title="Ver inteira (F)" onClick={p.onFit} className={btn}>
        <FocusIcon className="size-4" />
      </button>
      <span className="w-12 text-center font-narrow text-xs tabular-nums text-dim">{Math.round(p.scale * 100)}%</span>
    </div>
  );
}

export function HelpOverlay({ onClose, pick = false }: { onClose: () => void; pick?: boolean }) {
  const rows: [string, string][] = pick
    ? [
        ['1 – 9', 'Escolher a candidata'],
        ['← →', 'Grupo anterior e próximo'],
        ['Roda ou pinça', 'Zoom igual em todas'],
        ['F', 'Ver inteiras'],
        ['B', 'Trocar o fundo'],
      ]
    : [
        ['← →  ou  J K', 'Imagem anterior e próxima'],
        ['A', 'Aprovar e ir para a próxima pendente'],
        ['R', 'Recusar'],
        ['U', 'Tirar o veredito'],
        ['1 – 9', 'Ampliar a região'],
        ['Tab', 'Próxima região'],
        ['O', 'Região OK, ir para a próxima'],
        ['X', 'Região com problema'],
        ['F  ou  Esc', 'Ver a imagem inteira'],
        ['P  ou  Shift + arrastar', 'Marcar um ponto'],
        ['C', 'Comparar com a rodada anterior'],
        ['B', 'Trocar o fundo'],
        ['H', 'Esconder as marcações'],
        ['Duplo clique', 'Pixel real ou caber na tela'],
      ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">Atalhos</h2>
        <p className="mb-4 text-xs text-dim">Ao trocar de imagem, a lupa fica na mesma região: dá para comparar a mesma mão entre as expressões.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, d]) => (
            <div key={k} className="contents">
              <dt className="font-narrow font-semibold text-amber">{k}</dt>
              <dd className="text-dim">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function SubmitDialog({ batch, onClose }: { batch: BatchDetail; onClose: () => void }) {
  const submit = useSubmitBatch(batch.id);
  const [note, setNote] = useState('');
  const problems = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of batch.items) {
      const codes = [...it.review.reasons, ...Object.values(it.review.regions).flatMap((r) => r.reasons), ...it.review.pins.map((p) => p.reason).filter(Boolean) as string[]];
      for (const c of codes) if (!isApproval(c)) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [batch.items]);
  const pending = batch.kind === 'review' ? batch.counts.pending : 0;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Enviar revisão ao Claude</h2>
        <p className="mt-1 text-sm text-dim">
          {batch.counts.approved} aprovadas e {batch.counts.rejected} recusadas. O Claude lê os motivos e as marcações e prepara a próxima rodada.
        </p>
        {problems.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 text-sm">
            {problems.slice(0, 6).map(([code, n]) => (
              <li key={code} className="flex items-center gap-2">
                <span className="w-7 text-right font-narrow font-semibold text-mark">{n}×</span>
                <span>{reasonOf(code)?.label ?? code}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="mt-4 block">
          <span className="mb-1 block text-xs text-dim">Comentário geral (opcional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-line bg-[#161616] px-2.5 py-2 text-sm focus:border-faint focus:outline-none"
            placeholder="Prioridades, o que mais incomodou, o que manter"
          />
        </label>
        {pending > 0 && <p className="mt-3 text-sm text-amber">Faltam {pending} {pending === 1 ? 'imagem' : 'imagens'} sem veredito.</p>}
        {submit.error && <p className="mt-3 text-sm text-mark">{submit.error.message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-dim hover:text-ink">
            Continuar revisando
          </button>
          <button
            type="button"
            disabled={pending > 0 || submit.isPending}
            onClick={() => submit.mutate(note, { onSuccess: onClose })}
            className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-[#161616] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enviar revisão
          </button>
        </div>
      </div>
    </div>
  );
}
