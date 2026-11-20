// Types shared by the server, the web app and the agent CLI.
// Boxes are always in the image's own pixels: [x0, y0, x1, y1].

export type Box = [number, number, number, number];

export type RegionKind =
  | 'face' | 'eyes' | 'mouth' | 'hair' | 'horns'
  | 'hand' | 'feet' | 'body' | 'outfit' | 'accessory'
  | 'wings' | 'tail' | 'edge' | 'other';

/** A place the agent asks the owner to inspect up close (a loupe). */
export interface Region {
  id: string;
  kind: RegionKind;
  label: string;
  box: Box;
}

/** An automatic check the agent ran before submitting (qa_sprites.py and friends). */
export interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail?: string;
}

/** A spot the owner marked on the image. */
export interface Pin {
  id: string;
  box: Box;
  reason?: string;
  note?: string;
}

export interface RegionMark {
  verdict: 'ok' | 'bad';
  reasons: string[];
}

export type Verdict = 'approve' | 'reject' | null;

export interface Review {
  verdict: Verdict;
  reasons: string[];
  regions: Record<string, RegionMark>;
  pins: Pin[];
  note: string;
  updatedAt: string | null;
}

export type BatchKind = 'review' | 'pick';
export type BatchStatus = 'open' | 'submitted';

export interface Item {
  id: number;
  batchId: number;
  position: number;
  label: string;
  group: string;
  url: string;
  thumbUrl: string;
  prevUrl: string | null;
  width: number;
  height: number;
  hasAlpha: boolean;
  source: string | null;
  meta: Record<string, unknown>;
  regions: Region[];
  checks: Check[];
  review: Review;
}

export interface Counts {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
}

export interface Batch {
  id: number;
  characterId: number;
  characterSlug: string;
  characterName: string;
  phase: string;
  kind: BatchKind;
  title: string;
  notes: string;
  round: number;
  parentId: number | null;
  status: BatchStatus;
  createdAt: string;
  submittedAt: string | null;
  ownerNote: string;
  counts: Counts;
  thumbs: string[];
}

export interface BatchDetail extends Batch {
  items: Item[];
}

export interface Character {
  id: number;
  slug: string;
  name: string;
  summary: string;
  coverUrl: string | null;
  createdAt: string;
  openBatches: number;
  /** phase id -> 'done' | 'active' | 'waiting' (derived from the batches) */
  phases: Record<string, PhaseState>;
}

export type PhaseState = 'done' | 'active' | 'waiting' | 'idle';

export interface CharacterDetail extends Character {
  batches: Batch[];
}

/** What the agent sends with `forge submit` (file fields are multipart field names). */
export interface Manifest {
  character: string;
  phase: string;
  kind?: BatchKind;
  title: string;
  notes?: string;
  parentId?: number | null;
  items: ManifestItem[];
}

export interface ManifestItem {
  file: string;
  previous?: string;
  label?: string;
  group?: string;
  source?: string;
  meta?: Record<string, unknown>;
  regions?: Array<Omit<Region, 'id'> & { id?: string }>;
  checks?: Check[];
}

export type ServerEvent =
  | { type: 'batch.created'; batch: Batch }
  | { type: 'batch.updated'; batch: Batch }
  | { type: 'review.updated'; itemId: number; batchId: number; review: Review }
  | { type: 'character.updated'; slug: string };
