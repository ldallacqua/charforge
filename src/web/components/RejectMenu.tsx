// The reasons for one image, opened right on that image (no trip to a side panel).
import { useEffect, useRef, useState } from 'react';
import type { RegionKind } from '../../shared/types.ts';
import { ReasonPicker } from './Reasons.tsx';

export function RejectMenu(props: {
  kind: RegionKind | null;
  phase?: string;
  selected: string[];
  note: string;
  onToggle: (code: string) => void;
  onNote: (note: string) => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(props.note);
  const save = () => note !== props.note && props.onNote(note);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        save();
        props.onClose();
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        save();
        props.onClose();
      }
    };
    // next tick, so the click that opened the menu does not close it
    const t = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  });

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Motivos da recusa"
      className="absolute inset-x-2 bottom-[46px] z-20 max-h-[min(420px,80%)] overflow-y-auto rounded-lg border border-line bg-[#1b1b1b] p-3 shadow-[0_12px_40px_rgba(0,0,0,.6)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold">O que está errado?</span>
        <button type="button" onClick={props.onUndo} className="ml-auto text-xs text-dim underline-offset-2 hover:text-ink hover:underline">
          Desfazer recusa
        </button>
      </div>
      <ReasonPicker kind={props.kind} phase={props.phase} selected={props.selected} onToggle={props.onToggle} compact />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            save();
            props.onClose();
          }
        }}
        placeholder="Detalhe (opcional)"
        className="mt-3 w-full rounded-md border border-line bg-[#141414] px-2.5 py-1.5 text-sm placeholder:text-faint focus:border-faint focus:outline-none"
      />
    </div>
  );
}
