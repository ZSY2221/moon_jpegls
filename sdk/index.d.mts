export type Backend = 'js' | 'wasm-gc';
export type Status = 'NeedInput' | 'NeedOutput' | 'RowReady' | 'Done';
export type ErrorCode = 'InvalidData' | 'UnsupportedFeature' | 'ResourceLimit' | 'Truncated'
  | 'InvalidArgument' | 'Cancelled' | 'TrailingData' | 'RuntimeError';

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly near: number;
}

export interface Limits {
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
  maxMetadataBytes?: number;
}

export interface SessionOptions {
  inputChunkSize?: number;
  outputChunkSize?: number;
  limits?: Limits;
}

export interface Step<Output> {
  status: Status;
  consumed: number;
  produced: number;
  chunk?: Output;
}

export class CodecError extends Error {
  code: ErrorCode;
  progress?: Pick<Step<never>, 'consumed' | 'produced'>;
  constructor(code: ErrorCode, message: string, progress?: Pick<Step<never>, 'consumed' | 'produced'>);
}

export interface Session<Input, Output> {
  readonly frame: Frame | null;
  readonly remaining: number;
  readonly coreWorkspaceBytes: number;
  readonly bridgeBufferBytes: number;
  stage(input: Input | null): void;
  step(): Step<Output>;
  cancel(): void;
}

export interface Core {
  readonly backend: Backend;
  readonly loadMs: number;
  createEncoder(frame: Frame, options?: SessionOptions): Session<Uint16Array, Uint8Array>;
  createDecoder(options?: SessionOptions): Session<Uint8Array, Uint16Array>;
}

export interface Stats {
  inputUnit: 'samples' | 'bytes';
  outputUnit: 'samples' | 'bytes';
  inputConsumed: number;
  outputProduced: number;
  rows: number;
  coreWorkspaceBytes: number;
  bridgeBufferPeakBytes: number;
  inputQueueBytes: number;
  outputQueueBytes: number;
  inputPeakBytes: number;
  outputPeakBytes: number;
  firstRowInputConsumed: number | null;
  firstRowMs: number | null;
  elapsedMs: number;
}

export type Awaitable<T> = T | Promise<T>;
export interface StreamOptions<Input> extends SessionOptions {
  read(size: number): Awaitable<Input | null>;
  onProgress?(stats: Stats, frame: Frame | null): Awaitable<void>;
  signal?: AbortSignal;
}

export interface EncodeOptions extends StreamOptions<Uint16Array> {
  frame: Frame;
  onBytes(bytes: Uint8Array, stats: Stats): Awaitable<void>;
}

export interface DecodeOptions extends StreamOptions<Uint8Array> {
  trailing?: 'allow' | 'reject';
  onRow?(row: Uint16Array, index: number, frame: Frame, stats: Stats): Awaitable<void>;
}

export function loadCore(options?: { backend?: Backend; url?: string | URL }): Promise<Core>;
export function encodeStream(core: Core, options: EncodeOptions): Promise<{ frame: Frame; stats: Stats }>;
export function decodeStream(core: Core, options: DecodeOptions): Promise<{ frame: Frame; stats: Stats }>;
export function encodeImage(core: Core, frame: Frame, samples: Uint16Array,
  options?: Omit<EncodeOptions, 'frame' | 'onBytes' | 'read'>): Promise<{ frame: Frame; stats: Stats; bytes: Uint8Array }>;
export function decodeImage(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<{ frame: Frame; stats: Stats; samples: Uint16Array }>;
