// Grease-pencil marks: the verdicts look like an art director's marks on a contact sheet.
import clsx from 'clsx';

export function CheckMark({ className, animate = false }: { className?: string; animate?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx('text-proof', className)} aria-hidden>
      <path
        d="M3.5 12.8c1.6 1.5 3.4 3.6 5.6 6.4 2.6-5.6 6.9-10.8 11.6-15"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? 'mark-draw' : undefined}
        style={{ ['--len' as string]: 34 }}
      />
    </svg>
  );
}

export function CrossMark({ className, animate = false }: { className?: string; animate?: boolean }) {
  const cls = animate ? 'mark-draw' : undefined;
  return (
    <svg viewBox="0 0 24 24" className={clsx('text-mark', className)} aria-hidden>
      <path d="M5 4.6c4.4 4.4 9 9.6 14.2 14.8" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" className={cls} style={{ ['--len' as string]: 30 }} />
      <path d="M19.4 4.2c-5 4.6-9.6 9.8-14.6 15.4" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" className={cls} style={{ ['--len' as string]: 30 }} />
    </svg>
  );
}

/** A hand-drawn ring, for pins and for circling rejected frames. */
export function RingPath({ x, y, w, h, className }: { x: number; y: number; w: number; h: number; className?: string }) {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  // an ellipse drawn in one stroke that overshoots its start, like a pen ring
  const d = [
    `M ${cx + rx * 0.15} ${cy - ry * 1.02}`,
    `C ${cx + rx * 0.95} ${cy - ry * 1.05}, ${cx + rx * 1.06} ${cy - ry * 0.2}, ${cx + rx * 1.0} ${cy + ry * 0.2}`,
    `C ${cx + rx * 0.92} ${cy + ry * 1.0}, ${cx - rx * 0.2} ${cy + ry * 1.08}, ${cx - rx * 0.62} ${cy + ry * 0.86}`,
    `C ${cx - rx * 1.1} ${cy + ry * 0.55}, ${cx - rx * 1.06} ${cy - ry * 0.6}, ${cx - rx * 0.5} ${cy - ry * 0.95}`,
    `C ${cx - rx * 0.2} ${cy - ry * 1.12}, ${cx + rx * 0.35} ${cy - ry * 1.1}, ${cx + rx * 0.62} ${cy - ry * 0.88}`,
  ].join(' ');
  return <path d={d} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className={className} />;
}

export function VerdictMark({ verdict, className, animate }: { verdict: 'approve' | 'reject' | null; className?: string; animate?: boolean }) {
  if (verdict === 'approve') return <CheckMark className={className} animate={animate} />;
  if (verdict === 'reject') return <CrossMark className={className} animate={animate} />;
  return null;
}
