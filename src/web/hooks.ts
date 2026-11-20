import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const alphaCache = new Map<string, string>();

/** The alpha channel as a grey image (white = opaque), to check a cutout's matte. */
export function useAlphaMask(src: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => alphaCache.get(src) ?? null);
  useEffect(() => {
    if (!enabled) return;
    const hit = alphaCache.get(src);
    if (hit) return setUrl(hit);
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const a = p[i + 3];
        p[i] = p[i + 1] = p[i + 2] = a;
        p[i + 3] = 255;
      }
      ctx.putImageData(d, 0, 0);
      c.toBlob((b) => {
        if (!b || !alive) return;
        const u = URL.createObjectURL(b);
        alphaCache.set(src, u);
        setUrl(u);
      });
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src, enabled]);
  return enabled ? url : null;
}

/** Keyboard shortcuts that stay quiet while the owner is typing. */
export function useKeys(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      ref.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
