import clsx from 'clsx';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { PHASES } from '../../shared/phases.ts';
import { REGION_KIND_LABEL } from '../../shared/taxonomy.ts';
import type { Batch, Counts, Item, PhaseState, Region, RegionMark } from '../../shared/types.ts';
import { useSize } from '../hooks.ts';
import { CheckMark, CrossMark, RingPath, VerdictMark } from './marks.tsx';
import type { Bg } from './Viewer.tsx';

const BG_TILE: Record<Bg, string> = {
  checker: 'bg-checker-dark',
  room: 'bg-room',
  dark: 'bg-[#0d0d0d]',
  light: 'bg-[#f4f4f2]',
  magenta: 'bg-[#ff00d4]',
  alpha: 'bg-checker-dark',
};

/** A loupe: one region of the image, enlarged, with its own verdict. */
export function Loupe(props: {
  item: Item;
  region: Region;
  index: number;
  mark?: RegionMark;
  focused: boolean;
  bg: Bg;
  onClick: () => void;
}) {
  const { item, region, mark, focused } = props;
  const [ref, size] = useSize<HTMLButtonElement>();
  const [x0, y0, x1, y1] = region.box;
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const k = size.width ? Math.min(size.width / bw, size.height / bh) : 0;
  return (
    <button
      ref={ref}
      type="button"
      onClick={props.onClick}
      className={clsx(
        'group relative aspect-[5/4] w-full overflow-hidden rounded-md text-left outline-offset-2 transition-[box-shadow]',
        BG_TILE[props.bg],
        focused ? 'ring-2 ring-amber' : mark?.verdict === 'bad' ? 'ring-2 ring-mark/80' : 'ring-1 ring-line hover:ring-dim',
      )}
      aria-label={`Ampliar ${region.label}`}
    >
      {k > 0 && (
        <img
          src={item.url}
          alt=""
          draggable={false}
          className="absolute max-w-none"
          style={{
            width: item.width * k,
            height: item.height * k,
            left: (size.width - bw * k) / 2 - x0 * k,
            top: (size.height - bh * k) / 2 - y0 * k,
          }}
        />
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-5 text-xs">
        <span className="font-narrow font-semibold text-ink">
          {props.index + 1}  {region.label || REGION_KIND_LABEL[region.kind]}
        </span>
      </span>
      {mark && (
        <span className="absolute right-1.5 top-1.5 size-7 rounded-full bg-black/60 p-1">
          {mark.verdict === 'ok' ? <CheckMark className="size-full" /> : <CrossMark className="size-full" />}
        </span>
      )}
    </button>
  );
}

/** Contact-sheet thumbnails down the left edge, grouped (pose, set...). */
export function Filmstrip({ items, current, onSelect, horizontal = false }: { items: Item[]; current: number; onSelect: (i: number) => void; horizontal?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    refs.current[current]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  let lastGroup: string | null = null;
  return (
    <div className={clsx(horizontal ? 'flex gap-2 overflow-x-auto p-2' : 'flex h-full flex-col gap-1.5 overflow-y-auto p-2')}>
      {items.map((it, i) => {
        const header = !horizontal && it.group && it.group !== lastGroup;
        lastGroup = it.group;
        const v = it.review.verdict;
        return (
          <div key={it.id} className={clsx(horizontal && 'shrink-0')}>
            {header && <div className="mt-2 px-0.5 pb-1 font-narrow text-2xs font-semibold text-faint first:mt-0">{it.group}</div>}
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              onClick={() => onSelect(i)}
              className={clsx(
                'relative block overflow-hidden rounded bg-checker-dark',
                horizontal ? 'h-24 w-[60px]' : 'aspect-[3/4] w-full',
                i === current ? 'ring-2 ring-amber' : 'ring-1 ring-line hover:ring-dim',
              )}
              title={it.label}
            >
              <img src={it.thumbUrl} alt={it.label} loading="lazy" className={clsx('h-full w-full object-contain', v === 'approve' && 'opacity-60')} />
              <span className="absolute left-1 top-0.5 font-narrow text-2xs font-semibold text-ink [text-shadow:0_1px_2px_#000]">{String(i + 1).padStart(2, '0')}</span>
              {v && (
                <span className="absolute inset-0 grid place-items-center">
                  <VerdictMark verdict={v} className="size-10 drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]" />
                </span>
              )}
              {it.review.pins.length > 0 && (
                <span className="absolute bottom-0.5 right-1 rounded-full bg-mark px-1.5 text-2xs font-bold text-[#141414]">{it.review.pins.length}</span>
              )}
            </button>
            {!horizontal && <div className="truncate px-0.5 pt-0.5 text-2xs text-dim">{it.label}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** One segment per image: green approved, red rejected, grey pending. Shows where the problems are. */
export function SegmentBar({ items, current, onSelect }: { items: Item[]; current?: number; onSelect?: (i: number) => void }) {
  return (
    <div className="flex h-2 w-full gap-px overflow-hidden rounded-sm">
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          tabIndex={-1}
          onClick={() => onSelect?.(i)}
          title={it.label}
          className={clsx(
            'h-full flex-1',
            it.review.verdict === 'approve' ? 'bg-proof' : it.review.verdict === 'reject' ? 'bg-mark' : 'bg-line',
            i === current && 'outline outline-2 -outline-offset-1 outline-amber',
          )}
        />
      ))}
    </div>
  );
}

export function CountsLine({ counts, className }: { counts: Counts; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-3 text-xs text-dim', className)}>
      <span className="inline-flex items-center gap-1">
        <CheckMark className="size-3.5" /> {counts.approved}
      </span>
      <span className="inline-flex items-center gap-1">
        <CrossMark className="size-3.5" /> {counts.rejected}
      </span>
      <span>{counts.pending} pendentes</span>
    </span>
  );
}

/** The nine gates as a track. It is a real sequence, so the gates carry their numbers. */
export function PhaseTrack({ phases, labels = false }: { phases: Record<string, PhaseState>; labels?: boolean }) {
  return (
    <ol className={clsx('flex w-full', labels ? 'gap-1' : 'gap-[3px]')}>
      {PHASES.map((ph) => {
        const st = phases[ph.id] ?? 'idle';
        return (
          <li key={ph.id} className="min-w-0 flex-1" title={`G${ph.gate} ${ph.label}`}>
            <div
              className={clsx(
                'h-1.5 rounded-full',
                st === 'done' && 'bg-proof',
                st === 'waiting' && 'bg-amber',
                st === 'active' && 'bg-mark',
                st === 'idle' && 'bg-line',
              )}
            />
            {labels && (
              <div className={clsx('mt-2 truncate font-narrow text-xs', st === 'idle' ? 'text-faint' : 'text-ink')}>
                <span className="mr-1 font-semibold">G{ph.gate}</span>
                {ph.label}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function phaseLabel(id: string) {
  const ph = PHASES.find((p) => p.id === id);
  return ph ? `G${ph.gate} ${ph.label}` : id;
}

/** A batch as a strip of frames from a contact sheet. */
export function BatchRow({ batch, showCharacter = false }: { batch: Batch; showCharacter?: boolean }) {
  const open = batch.status === 'open';
  const done = batch.counts.total - batch.counts.pending;
  return (
    <Link
      to={`/review/${batch.id}`}
      className="group grid grid-cols-1 gap-4 rounded-lg border border-line bg-[#212121] p-3 transition-colors hover:border-faint md:grid-cols-[minmax(0,1fr)_260px]"
    >
      <div className="flex h-28 gap-1 overflow-hidden rounded bg-checker-dark p-1">
        {batch.thumbs.map((t, i) => (
          <img key={i} src={t} alt="" loading="lazy" className="h-full w-auto shrink-0 rounded-sm object-contain" />
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{batch.title}</h3>
          {open ? (
            <span className="shrink-0 rounded-full bg-amber px-2 py-0.5 text-2xs font-semibold text-[#1a1a1a]">Esperando você</span>
          ) : (
            <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-2xs text-dim">Enviado ao Claude</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 font-narrow text-xs text-dim">
          {showCharacter && <span className="font-semibold text-ink">{batch.characterName}</span>}
          <span>{phaseLabel(batch.phase)}</span>
          <span>Rodada {batch.round}</span>
          <span>{batch.kind === 'pick' ? 'Escolha entre candidatas' : 'Revisão imagem a imagem'}</span>
        </div>
        {batch.notes && <p className="line-clamp-2 text-xs text-dim">{batch.notes}</p>}
        <div className="mt-auto flex items-center gap-3">
          <CountsLine counts={batch.counts} />
          <span className="ml-auto font-narrow text-xs text-faint">
            {done}/{batch.counts.total}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-grid min-w-5 place-items-center rounded border border-line bg-raised px-1 font-sans text-2xs font-semibold text-dim">{children}</kbd>;
}

export function EmptyRing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={clsx('text-faint', className)} aria-hidden>
      <RingPath x={6} y={8} w={36} h={32} />
    </svg>
  );
}
