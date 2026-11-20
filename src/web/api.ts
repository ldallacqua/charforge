import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Batch, BatchDetail, Character, CharacterDetail, Review, ServerEvent } from '../shared/types.ts';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const send = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

export const keys = {
  library: ['library'] as const,
  character: (slug: string) => ['character', slug] as const,
  batch: (id: number) => ['batch', id] as const,
};

export function useLibrary() {
  return useQuery({ queryKey: keys.library, queryFn: () => call<{ characters: Character[]; waiting: Batch[] }>('/api/characters') });
}

export function useCharacter(slug: string) {
  return useQuery({ queryKey: keys.character(slug), queryFn: () => call<CharacterDetail>(`/api/characters/${slug}`) });
}

export function useBatch(id: number) {
  return useQuery({ queryKey: keys.batch(id), queryFn: () => call<BatchDetail>(`/api/batches/${id}`) });
}

/** Writes a review with an optimistic update, so marking feels instant. */
export function useSaveReview(batchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, patch }: { itemId: number; patch: Partial<Review> }) =>
      call<Review>(`/api/items/${itemId}/review`, send('PUT', patch)),
    onMutate: async ({ itemId, patch }) => {
      await qc.cancelQueries({ queryKey: keys.batch(batchId) });
      qc.setQueryData<BatchDetail>(keys.batch(batchId), (b) => b && applyReview(b, itemId, { ...findReview(b, itemId), ...patch }));
    },
    onError: () => qc.invalidateQueries({ queryKey: keys.batch(batchId) }),
  });
}

export function useSubmitBatch(batchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => call<Batch>(`/api/batches/${batchId}/submit`, send('POST', { note })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.batch(batchId) });
      qc.invalidateQueries({ queryKey: keys.library });
    },
  });
}

export function useReopenBatch(batchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<Batch>(`/api/batches/${batchId}/reopen`, send('POST', {})),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.batch(batchId) }),
  });
}

export function useSetCover(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: number) => call<Character>(`/api/characters/${slug}`, send('PATCH', { coverItemId: itemId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.character(slug) });
      qc.invalidateQueries({ queryKey: keys.library });
    },
  });
}

function findReview(b: BatchDetail, itemId: number): Review {
  return b.items.find((i) => i.id === itemId)!.review;
}

function applyReview(b: BatchDetail, itemId: number, review: Review): BatchDetail {
  const items = b.items.map((i) => (i.id === itemId ? { ...i, review } : i));
  const approved = items.filter((i) => i.review.verdict === 'approve').length;
  const rejected = items.filter((i) => i.review.verdict === 'reject').length;
  return { ...b, items, counts: { total: items.length, approved, rejected, pending: items.length - approved - rejected } };
}

/** Live updates from the studio: new batches from the agent, reviews from another device. */
export function useLiveUpdates(onBatchCreated: (b: Batch) => void) {
  useEffect(() => {
    const es = new EventSource('/api/events');
    const handle = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as ServerEvent;
      if (e.type === 'batch.created') {
        queryClient.invalidateQueries({ queryKey: keys.library });
        queryClient.invalidateQueries({ queryKey: keys.character(e.batch.characterSlug) });
        onBatchCreated(e.batch);
      } else if (e.type === 'batch.updated') {
        queryClient.invalidateQueries({ queryKey: keys.library });
        queryClient.invalidateQueries({ queryKey: keys.character(e.batch.characterSlug) });
        queryClient.invalidateQueries({ queryKey: keys.batch(e.batch.id) });
      } else if (e.type === 'review.updated') {
        const b = queryClient.getQueryData<BatchDetail>(keys.batch(e.batchId));
        if (b && !queryClient.isMutating()) queryClient.setQueryData(keys.batch(e.batchId), applyReview(b, e.itemId, e.review));
      } else if (e.type === 'character.updated') {
        queryClient.invalidateQueries({ queryKey: keys.library });
        queryClient.invalidateQueries({ queryKey: keys.character(e.slug) });
      }
    };
    for (const t of ['batch.created', 'batch.updated', 'review.updated', 'character.updated']) es.addEventListener(t, handle);
    return () => es.close();
  }, [onBatchCreated]);
}
