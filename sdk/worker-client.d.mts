import type {
  Awaitable,
  Backend,
  ComponentSpec,
  Frame,
  FrameInfo,
  Preset,
  ScanInfo,
  SessionOptions,
  Stats,
  StreamStructure,
} from './index.mjs';

export interface WorkerRowMeta {
  scanIndex?: number;
  componentIndex?: number;
  componentId?: number;
  near?: number;
  height?: number;
  /** Coding interleave. Decoded rows use planar layout for all modes. */
  interleave?: number;
  pointTransform?: number;
  layout?: 'planar';
  stride?: number;
  sampleBytes?: 2;
  endianness?: 'host-u16';
}

export type WorkerEvent = { preset?: Preset | null } & (
  | { type: 'bytes'; seq: number; chunk: Uint8Array; stats: Stats }
  | ({ type: 'row'; seq: number; row: Uint16Array; index: number; frame: Frame; stats: Stats } & WorkerRowMeta)
  | ({ type: 'rows'; seq: number; samples: Uint16Array; startIndex: number; count: number; frame: Frame; stats: Stats } & WorkerRowMeta)
  | { type: 'scanComplete'; seq: number; scan: ScanInfo; stats: Stats; structure?: StreamStructure | null }
  | { type: 'progress'; seq: number; stats: Stats; frame: Frame | null; structure?: StreamStructure | null });

interface WorkerOptions extends SessionOptions {
  backend?: Backend;
  /**
   * Decode batch buffer budget, integer 0..1048576 bytes; 0 disables batching.
   * The first row of each component is delivered immediately, and batches never span components or scans.
   * Rows remain atomic if wider than this budget. An output copy can additionally hold
   * one source row, so this is not a total Worker memory limit. ACK follows completion of onEvent.
   */
  maxBatchBytes?: number;
  signal?: AbortSignal;
  onEvent?(event: WorkerEvent): Awaitable<void>;
  onAck?(event: WorkerEvent, hostElapsedMs: number): void;
}

export type WorkerInput = WorkerOptions & (
  | { mode: 'encode'; frame: Frame; read(maxSamples: number): Awaitable<Uint16Array | null> }
  | { mode: 'decode'; trailing?: 'allow' | 'reject'; read(maxBytes: number): Awaitable<Uint8Array | null> }
);

export interface WorkerJob {
  result: Promise<{
    type: 'done';
    frame: Frame;
    frameInfo?: FrameInfo;
    components?: readonly ComponentSpec[];
    scans?: readonly ScanInfo[];
    structure?: StreamStructure;
    preset: Preset | null;
    stats: Stats;
    backend: Backend;
    loadMs: number;
  }>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function startWorker(options: WorkerInput): WorkerJob;
