import type { Awaitable, Backend, Frame, SessionOptions, Stats } from './index.mjs';

export type WorkerEvent =
  | { type: 'bytes'; seq: number; chunk: Uint8Array; stats: Stats }
  | { type: 'row'; seq: number; row: Uint16Array; index: number; frame: Frame; stats: Stats }
  | { type: 'progress'; seq: number; stats: Stats; frame: Frame | null };

interface WorkerOptions extends SessionOptions {
  backend?: Backend;
  signal?: AbortSignal;
  onEvent?(event: WorkerEvent): Awaitable<void>;
}

export type WorkerInput = WorkerOptions & (
  | { mode: 'encode'; frame: Frame; read(maxSamples: number): Awaitable<Uint16Array | null> }
  | { mode: 'decode'; trailing?: 'allow' | 'reject'; read(maxBytes: number): Awaitable<Uint8Array | null> }
);

export interface WorkerJob {
  result: Promise<{ type: 'done'; frame: Frame; stats: Stats; backend: Backend; loadMs: number }>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function startWorker(options: WorkerInput): WorkerJob;
