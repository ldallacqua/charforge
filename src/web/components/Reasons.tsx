import clsx from 'clsx';
import { approvalsFor, areasFor } from '../../shared/taxonomy.ts';
import type { RegionKind } from '../../shared/types.ts';

/** The problem vocabulary, opened at the areas that matter for what is in focus. */
export function ReasonPicker({ kind, phase, selected, onToggle, compact = false }: { kind: RegionKind | null; phase?: string; selected: string[]; onToggle: (code: string) => void; compact?: boolean }) {
  const areas = areasFor(kind, phase);
  const primary = kind ? areas.filter((a) => a.kinds.includes(kind)) : [];
  const rest = areas.filter((a) => !primary.includes(a));
  const shown = primary.length ? primary : rest.slice(0, compact ? 3 : rest.length);
  const hidden = primary.length ? rest : rest.slice(shown.length);
  return (
    <div className="flex flex-col gap-3">
      {shown.map((a) => (
        <AreaChips key={a.id} label={a.label} codes={a.reasons} selected={selected} onToggle={onToggle} />
      ))}
      {hidden.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs text-dim hover:text-ink">
            <span className="group-open:hidden">Outros motivos ({hidden.reduce((n, a) => n + a.reasons.length, 0)})</span>
            <span className="hidden group-open:inline">Menos motivos</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {hidden.map((a) => (
              <AreaChips key={a.id} label={a.label} codes={a.reasons} selected={selected} onToggle={onToggle} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function AreaChips({ label, codes, selected, onToggle }: { label: string; codes: { code: string; label: string }[]; selected: string[]; onToggle: (c: string) => void }) {
  return (
    <div>
      <div className="mb-1.5 font-narrow text-xs font-semibold text-dim">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {codes.map((r) => {
          const on = selected.includes(r.code);
          return (
            <button
              key={r.code}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(r.code)}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                on ? 'border-mark bg-mark/15 text-ink' : 'border-line text-dim hover:border-faint hover:text-ink',
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ApprovalChips({ phase, selected, onToggle }: { phase?: string; selected: string[]; onToggle: (code: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {approvalsFor(phase).map((r) => {
        const on = selected.includes(r.code);
        return (
          <button
            key={r.code}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(r.code)}
            className={clsx(
              'rounded-full border px-2.5 py-1 text-xs transition-colors',
              on ? 'border-proof bg-proof/15 text-ink' : 'border-line text-dim hover:border-faint hover:text-ink',
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
