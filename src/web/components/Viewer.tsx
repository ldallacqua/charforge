// The light table: zoom and pan an image, show the agent's regions as crop marks and the owner's pins as
// pencil rings, compare with the previous round, and judge the cutout on several backgrounds.
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { Box, Pin, Region, RegionMark } from '../../shared/types.ts';
import { REGION_KIND_LABEL } from '../../shared/taxonomy.ts';
import { useAlphaMask, useSize } from '../hooks.ts';
import { RingPath } from './marks.tsx';

/** The view: image point (cx, cy) in 0..1 at the centre, z = zoom relative to "fit". */
export interface View {
  cx: number;
  cy: number;
  z: number;
}
export const FIT: View = { cx: 0.5, cy: 0.5, z: 1 };

export type Bg = 'checker' | 'room' | 'dark' | 'light' | 'magenta' | 'alpha';
export type Compare = 'after' | 'before' | 'split';

export const BACKGROUNDS: { id: Bg; label: string; hint: string }[] = [
  { id: 'checker', label: 'Xadrez', hint: 'transparência' },
  { id: 'room', label: 'Cinza', hint: 'neutro, para julgar cor' },
  { id: 'dark', label: 'Escuro', hint: 'mostra halo claro' },
  { id: 'light', label: 'Claro', hint: 'mostra borda escura' },
  { id: 'magenta', label: 'Magenta', hint: 'qualquer sobra de fundo salta' },
  { id: 'alpha', label: 'Alfa', hint: 'só o recorte' },
];

const BG_CLASS: Record<Bg, string> = {
  checker: 'bg-checker',
  room: 'bg-room',
  dark: 'bg-[#0d0d0d]',
  light: 'bg-[#f4f4f2]',
  magenta: 'bg-[#ff00d4]',
  alpha: 'bg-black',
};

export interface Focus {
  box: Box;
  key: string | number;
}

interface Props {
  src: string;
  prevSrc?: string | null;
  width: number;
  height: number;
  view: View;
  onView: (v: View) => void;
  focus?: Focus | null;
  regions?: Region[];
  focusRegion?: string | null;
  regionMarks?: Record<string, RegionMark>;
  onRegionClick?: (id: string) => void;
  pins?: Pin[];
  selectedPin?: string | null;
  onPinCreate?: (box: Box) => void;
  onPinClick?: (id: string) => void;
  pinMode?: boolean;
  bg: Bg;
  compare?: Compare;
  split?: number;
  onSplit?: (x: number) => void;
  overlays?: boolean;
  padding?: number;
  className?: string;
  onScale?: (s: number) => void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function Viewer(p: Props) {
  const [ref, size] = useSize<HTMLDivElement>();
  const W = size.width;
  const H = size.height;
  const pad = p.padding ?? 0.92;
  const s0 = W && H ? Math.min(W / p.width, H / p.height) * pad : 1;
  const scale = s0 * p.view.z;
  const tx = W / 2 - p.view.cx * p.width * scale;
  const ty = H / 2 - p.view.cy * p.height * scale;
  const toScreen = (x: number, y: number) => [tx + x * scale, ty + y * scale] as const;
  const toImage = (sx: number, sy: number) => [(sx - tx) / scale, (sy - ty) / scale] as const;

  const alphaSrc = useAlphaMask(p.src, p.bg === 'alpha');
  const prevAlpha = useAlphaMask(p.prevSrc ?? p.src, p.bg === 'alpha' && !!p.prevSrc);
  const [draft, setDraft] = useState<Box | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  const stateRef = useRef({ p, W, H, s0, scale, tx, ty });
  stateRef.current = { p, W, H, s0, scale, tx, ty };

  useEffect(() => {
    p.onScale?.(scale);
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // fit a region when asked (focus.key changes), once the size is known
  useEffect(() => {
    if (!p.focus || !W || !H) return;
    const [x0, y0, x1, y1] = p.focus.box;
    const bw = Math.max(8, x1 - x0);
    const bh = Math.max(8, y1 - y0);
    const z = (Math.min(W / bw, H / bh) * 0.86) / s0;
    p.onView({ cx: (x0 + bw / 2) / p.width, cy: (y0 + bh / 2) / p.height, z: clamp(z, 0.25, 60) });
  }, [p.focus?.key, W, H]); // eslint-disable-line react-hooks/exhaustive-deps

  function zoomAbout(factor: number, sx: number, sy: number) {
    const st = stateRef.current;
    const [ix, iy] = [(sx - st.tx) / st.scale, (sy - st.ty) / st.scale];
    const z2 = clamp(st.p.view.z * factor, 0.25, 60);
    const s2 = st.s0 * z2;
    const tx2 = sx - ix * s2;
    const ty2 = sy - iy * s2;
    st.p.onView({ cx: (st.W / 2 - tx2) / (st.p.width * s2), cy: (st.H / 2 - ty2) / (st.p.height * s2), z: z2 });
  }

  // wheel and trackpad pinch (needs a non-passive listener)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = e.ctrlKey ? 0.012 : 0.0018;
      zoomAbout(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // pointer: pan, draw a pin box (pin mode or shift), drag the split line, pinch with two fingers
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { type: 'pan'; x: number; y: number; view: View }
    | { type: 'pin'; ix: number; iy: number; sx: number; sy: number }
    | { type: 'split' }
    | { type: 'pinch'; dist: number; z: number; mx: number; my: number }
    | null
  >(null);

  function local(e: React.PointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('[data-overlay-hit]')) return;
    ref.current!.setPointerCapture(e.pointerId);
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), z: p.view.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      setDraft(null);
      return;
    }
    const splitX = tx + (p.split ?? 0.5) * p.width * scale;
    if (p.compare === 'split' && p.prevSrc && Math.abs(pt.x - splitX) < 14) {
      gesture.current = { type: 'split' };
    } else if ((p.pinMode || e.shiftKey) && p.onPinCreate) {
      const [ix, iy] = toImage(pt.x, pt.y);
      gesture.current = { type: 'pin', ix, iy, sx: pt.x, sy: pt.y };
    } else {
      gesture.current = { type: 'pan', x: pt.x, y: pt.y, view: p.view };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / g.dist;
      const target = clamp(g.z * factor, 0.25, 60);
      zoomAbout(target / stateRef.current.p.view.z, g.mx, g.my);
    } else if (g.type === 'pan') {
      p.onView({ ...g.view, cx: g.view.cx - (pt.x - g.x) / (p.width * scale), cy: g.view.cy - (pt.y - g.y) / (p.height * scale) });
    } else if (g.type === 'split') {
      p.onSplit?.(clamp((pt.x - tx) / (p.width * scale), 0, 1));
    } else if (g.type === 'pin') {
      const [ix, iy] = toImage(pt.x, pt.y);
      setDraft([Math.min(g.ix, ix), Math.min(g.iy, iy), Math.max(g.ix, ix), Math.max(g.iy, iy)]);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.type === 'pin' && p.onPinCreate) {
      const pt = local(e);
      let box: Box;
      if (Math.hypot(pt.x - g.sx, pt.y - g.sy) < 8) {
        const r = Math.max(18, 26 / scale);
        box = [g.ix - r, g.iy - r, g.ix + r, g.iy + r];
      } else {
        const [ix, iy] = toImage(pt.x, pt.y);
        box = [Math.min(g.ix, ix), Math.min(g.iy, iy), Math.max(g.ix, ix), Math.max(g.iy, iy)];
      }
      const clean = box.map((v, i) => Math.round(clamp(v, 0, i % 2 ? p.height : p.width))) as Box;
      if (clean[2] - clean[0] > 2 && clean[3] - clean[1] > 2) p.onPinCreate(clean);
    }
    setDraft(null);
    gesture.current = pointers.current.size ? gesture.current : null;
  }

  function onDoubleClick(e: React.MouseEvent) {
    const r = ref.current!.getBoundingClientRect();
    if (p.view.z > 1.05) return p.onView(FIT);
    const oneToOne = 1 / s0;
    const target = oneToOne > 1.4 ? oneToOne : 3;
    zoomAbout(target / p.view.z, e.clientX - r.left, e.clientY - r.top);
  }

  const showBefore = p.compare === 'before' && p.prevSrc;
  const showSplit = p.compare === 'split' && p.prevSrc;
  const afterSrc = p.bg === 'alpha' ? alphaSrc ?? p.src : p.src;
  const beforeSrc = p.bg === 'alpha' ? prevAlpha ?? p.prevSrc : p.prevSrc;
  const overlays = p.overlays !== false;
  const splitX = tx + (p.split ?? 0.5) * p.width * scale;

  return (
    <div
      ref={ref}
      className={clsx('relative touch-none overflow-hidden select-none bg-room', p.pinMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing', p.className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {W > 0 && (
        <div
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{ width: p.width, height: p.height, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        >
          <div className={clsx('absolute inset-0', BG_CLASS[p.bg])} />
          <img
            src={showBefore ? beforeSrc! : afterSrc}
            width={p.width}
            height={p.height}
            draggable={false}
            className="absolute inset-0 max-w-none"
            alt=""
            onLoad={(e) => setLoaded((e.target as HTMLImageElement).getAttribute('src'))}
          />
          {showSplit && (
            <img
              src={beforeSrc!}
              width={p.width}
              height={p.height}
              draggable={false}
              alt=""
              className="absolute inset-0 max-w-none"
              style={{ clipPath: `inset(0 ${(1 - (p.split ?? 0.5)) * 100}% 0 0)` }}
            />
          )}
        </div>
      )}

      {W > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {overlays &&
            p.regions?.map((g, i) => {
              const [x0, y0] = toScreen(g.box[0], g.box[1]);
              const [x1, y1] = toScreen(g.box[2], g.box[3]);
              const focused = p.focusRegion === g.id;
              const mark = p.regionMarks?.[g.id];
              const color = focused ? 'var(--color-amber)' : mark?.verdict === 'bad' ? 'var(--color-mark)' : mark?.verdict === 'ok' ? 'var(--color-proof)' : 'rgba(236,235,231,.75)';
              const L = Math.max(6, Math.min(16, (x1 - x0) / 4, (y1 - y0) / 4));
              const d = `M${x0} ${y0 + L}V${y0}H${x0 + L} M${x1 - L} ${y0}H${x1}V${y0 + L} M${x1} ${y1 - L}V${y1}H${x1 - L} M${x0 + L} ${y1}H${x0}V${y1 - L}`;
              return (
                <g key={g.id} style={{ color }}>
                  <path d={d} fill="none" stroke="rgba(0,0,0,.55)" strokeWidth={4} strokeLinecap="square" />
                  <path d={d} fill="none" stroke="currentColor" strokeWidth={focused ? 2.2 : 1.6} strokeLinecap="square" />
                  <g
                    data-overlay-hit
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => p.onRegionClick?.(g.id)}
                  >
                    {(() => {
                      // full name only when there is room (or in focus); otherwise the number, like a frame mark
                      const name = g.label || REGION_KIND_LABEL[g.kind];
                      const full = focused || x1 - x0 > 150;
                      const text = full ? `${i + 1} ${name}` : String(i + 1);
                      return (
                        <>
                          <rect x={x0} y={y0 - 19} width={full ? Math.max(28, text.length * 6.1 + 10) : 18} height={16} rx={3} fill="rgba(20,20,20,.85)" />
                          <text x={x0 + (full ? 5 : 9)} y={y0 - 7} textAnchor={full ? 'start' : 'middle'} fill="currentColor" fontSize={11} className="font-narrow" style={{ fontWeight: 600 }}>
                            {text}
                          </text>
                        </>
                      );
                    })()}
                  </g>
                </g>
              );
            })}
          {overlays &&
            p.pins?.map((pin, i) => {
              const [x0, y0] = toScreen(pin.box[0], pin.box[1]);
              const [x1, y1] = toScreen(pin.box[2], pin.box[3]);
              const sel = p.selectedPin === pin.id;
              const pad = 6;
              return (
                <g key={pin.id} className={sel ? 'text-amber' : 'text-mark'}>
                  <RingPath x={x0 - pad} y={y0 - pad} w={x1 - x0 + pad * 2} h={y1 - y0 + pad * 2} />
                  <g data-overlay-hit className="pointer-events-auto cursor-pointer" onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onPinClick?.(pin.id)}>
                    <circle cx={x1 + pad} cy={y0 - pad} r={9} fill="currentColor" />
                    <text x={x1 + pad} y={y0 - pad + 4} textAnchor="middle" fontSize={11} fill="#141414" style={{ fontWeight: 700 }}>
                      {i + 1}
                    </text>
                  </g>
                </g>
              );
            })}
          {draft &&
            (() => {
              const [x0, y0] = toScreen(draft[0], draft[1]);
              const [x1, y1] = toScreen(draft[2], draft[3]);
              return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="rgba(229,64,47,.08)" stroke="var(--color-mark)" strokeDasharray="5 4" strokeWidth={1.5} />;
            })()}
          {showSplit && (
            <g>
              <line x1={splitX} x2={splitX} y1={0} y2={H} stroke="var(--color-amber)" strokeWidth={1.5} />
              <rect x={splitX - 22} y={H / 2 - 13} width={44} height={26} rx={13} fill="var(--color-amber)" />
              <path d={`M${splitX - 8} ${H / 2}l-5 0m0 0l3 -3m-3 3l3 3M${splitX + 8} ${H / 2}l5 0m0 0l-3 -3m3 3l-3 3`} stroke="#1a1a1a" strokeWidth={1.8} fill="none" strokeLinecap="round" />
              <text x={12} y={22} fill="var(--color-amber)" fontSize={12} style={{ fontWeight: 600 }}>antes</text>
              <text x={W - 12} y={22} fill="var(--color-amber)" fontSize={12} textAnchor="end" style={{ fontWeight: 600 }}>depois</text>
            </g>
          )}
        </svg>
      )}
      {W > 0 && loaded !== (showBefore ? beforeSrc : afterSrc) && (
        <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/60 px-2 py-0.5 text-xs text-dim">Carregando a imagem em resolução cheia</div>
      )}
      {showBefore && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-amber px-2 py-0.5 text-xs font-semibold text-[#1a1a1a]">Rodada anterior</div>
      )}
    </div>
  );
}
