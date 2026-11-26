import type {
  Awaitable,
  Backend,
  ComponentSpec,
  DecodedSamples,
  DecodeSampleFormat,
  DecodeSampleOptions,
  Frame,
  FrameInfo,
  Preset,
  ScanInfo,
  SessionOptions,
  Stats,
  StreamStructure,
} from './index.mjs';

export interface WorkerRowMeta<Format extends DecodeSampleFormat = 'u16'> {
  scanIndex?: number;
  componentIndex?: number;
  componentId?: number;
  near?: number;
  height?: number;
  /** Coding interleave. Decoded rows use planar layout for all modes. */
  interleave?: number;
  pointTransform?: number;
  layout?: 'planar';
  width?: number;
  stride?: number;
  sampleBytes?: Format extends 'u32' ? 4 : 2;
  endianness?: Format extends 'u32' ? 'host-u32' : 'host-u16';
}

export type WorkerEvent<Format extends DecodeSampleFormat = 'u16'> = { preset?: Preset | null } & (
  | { type: 'bytes'; seq: number; chunk: Uint8Array; stats: Stats }
  | ({ type: 'row'; seq: number; row: DecodedSamples<Format>; index: number; frame: Frame; stats: Stats } & WorkerRowMeta<Format>)
  | ({ type: 'rows'; seq: number; samples: DecodedSamples<Format>; startIndex: number; count: number; frame: Frame; stats: Stats } & WorkerRowMeta<Format>)
  | { type: 'scanComplete'; seq: number; scan: ScanInfo; stats: Stats; structure?: StreamStructure | null }
  | { type: 'progress'; seq: number; stats: Stats; frame: Frame | null; structure?: StreamStructure | null });

interface WorkerOptions<Format extends DecodeSampleFormat> extends SessionOptions {
  backend?: Backend;
  /**
   * Decode batch buffer budget, integer 0..1048576 bytes; 0 disables batching.
   * The first row of each component is delivered immediately, and batches never span components or scans.
   * Rows remain atomic if wider than this budget. An output copy can additionally hold
   * one source row, so this is not a total Worker memory limit. ACK follows completion of onEvent.
   */
  maxBatchBytes?: number;
  signal?: AbortSignal;
  onEvent?(event: WorkerEvent<Format>): Awaitable<void>;
  onAck?(event: WorkerEvent<Format>, hostElapsedMs: number): void;
}

type EncodeWorkerInput = { mode: 'encode'; frame: Frame; read(maxSamples: number): Awaitable<Uint16Array | null> };
type DecodeWorkerInput<Format extends DecodeSampleFormat> = DecodeSampleOptions<Format> & {
  mode: 'decode';
  trailing?: 'allow' | 'reject';
  read(maxBytes: number): Awaitable<Uint8Array | null>;
};
export type WorkerInput<Format extends DecodeSampleFormat = 'u16'> = WorkerOptions<Format> & (
  DecodeWorkerInput<Format> | (Format extends 'u16' ? EncodeWorkerInput : never)
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

export function startWorker(options: WorkerInput<'u32'>): WorkerJob;
export function startWorker(options: WorkerInput): WorkerJob;
