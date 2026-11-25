export type Backend = 'js' | 'wasm-gc';
export type Status = 'NeedInput' | 'NeedOutput' | 'RowReady' | 'Done';
export type ErrorCode = 'InvalidData' | 'UnsupportedFeature' | 'ResourceLimit' | 'Truncated'
  | 'InvalidArgument' | 'Cancelled' | 'TrailingData' | 'RuntimeError';

export interface Preset {
  readonly maxval: number;
  readonly t1: number;
  readonly t2: number;
  readonly t3: number;
  readonly reset: number;
}

export interface ComponentSpec {
  readonly id: number;
  readonly hSampling?: number;
  readonly vSampling?: number;
}

export interface ScanSpec {
  readonly componentId?: number;
  readonly componentIds?: readonly number[];
  readonly interleave?: number;
  readonly pointTransform?: number;
  readonly near?: number;
  readonly maxval?: number;
  readonly preset?: Partial<Omit<Preset, 'maxval'>>;
}

export interface ScanInfo {
  readonly scanIndex: number;
  readonly componentIndex: number;
  readonly componentId: number;
  readonly componentIndices?: readonly number[];
  readonly componentIds?: readonly number[];
  readonly near: number;
  readonly interleave: number;
  readonly pointTransform: number;
  readonly preset?: Preset;
  readonly rows?: number;
  readonly completed?: boolean;
  readonly headerOffset?: number;
  readonly entropyOffset?: number;
  readonly endOffset?: number;
}

export interface MarkerRecord {
  readonly code: number;
  readonly offset: number;
  readonly length: number;
  readonly scanIndex: number;
  readonly detail: number;
}

export interface FrameInfo {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly components: readonly ComponentSpec[];
}

export interface StreamStructure {
  readonly soiOffset: number;
  readonly sofOffset: number;
  readonly sofLength: number;
  readonly eoiOffset: number;
  readonly frame: FrameInfo;
  readonly scans: readonly ScanInfo[];
  readonly markers: readonly MarkerRecord[];
}

export interface ErrorLocation {
  readonly scanIndex: number;
  readonly componentId: number;
  readonly marker: number;
  readonly offset: number;
}

export interface RowMeta {
  readonly scanIndex: number;
  readonly componentIndex: number;
  readonly componentId: number;
  readonly rowIndex: number | null;
  readonly height?: number;
  readonly near: number;
  readonly interleave?: number;
  readonly pointTransform?: number;
  readonly preset: Preset | null;
  readonly layout: 'planar';
  readonly stride: number;
  readonly sampleBytes: 2;
  readonly endianness: 'host-u16';
}

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly near: number;
  readonly interleave?: number;
  readonly pointTransform?: number;
  readonly maxval?: number;
  readonly preset?: Partial<Omit<Preset, 'maxval'>>;
  readonly components?: readonly (ComponentSpec | number)[];
  readonly scans?: readonly (ScanSpec | number)[];
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
  rowMeta?: RowMeta;
}

export class CodecError extends Error {
  code: ErrorCode;
  progress?: Pick<Step<never>, 'consumed' | 'produced'>;
  location?: ErrorLocation;
  constructor(
    code: ErrorCode,
    message: string,
    progress?: Pick<Step<never>, 'consumed' | 'produced'>,
    location?: ErrorLocation,
  );
}

export interface Session<Input, Output> {
  readonly frame: Frame | null;
  readonly frameInfo: FrameInfo | null;
  readonly components: readonly ComponentSpec[] | null;
  readonly scans: readonly ScanInfo[] | null;
  readonly currentScan: ScanInfo | null;
  readonly structure: StreamStructure | null;
  readonly rowMeta: RowMeta | null;
  readonly preset: Preset | null;
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
  /**
   * SDK: current output chunk. Worker: allocated batch / unacknowledged output
   * ArrayBuffer payload (a short transferred view still owns its full buffer).
   * Excludes output retained by the consumer after ACK and JS object overhead.
   */
  outputQueueBytes: number;
  inputPeakBytes: number;
  /**
   * Monotonic output-payload high water. Worker batching also includes the
   * source row while copying it into the batch. This is not total heap/RSS.
   */
  outputPeakBytes: number;
  firstRowInputConsumed: number | null;
  firstRowMs: number | null;
  elapsedMs: number;
}

export type Awaitable<T> = T | Promise<T>;
export interface StreamOptions<Input> extends SessionOptions {
  read(size: number): Awaitable<Input | null>;
  onProgress?(stats: Stats, frame: Frame | null, preset: Preset | null, structure?: StreamStructure | null): Awaitable<void>;
  signal?: AbortSignal;
}

export interface EncodeOptions extends StreamOptions<Uint16Array> {
  frame: Frame;
  onBytes(bytes: Uint8Array, stats: Stats, preset: Preset | null): Awaitable<void>;
}

export interface DecodeOptions extends StreamOptions<Uint8Array> {
  trailing?: 'allow' | 'reject';
  onRow?(row: Uint16Array, index: number, frame: Frame, stats: Stats, preset: Preset | null, rowMeta?: RowMeta): Awaitable<void>;
  onScanComplete?(scan: ScanInfo, stats: Stats, structure: StreamStructure | null): Awaitable<void>;
}

export function loadCore(options?: {
  backend?: Backend;
  url?: string | URL;
  module?: WebAssembly.Module;
  bytes?: BufferSource;
}): Promise<Core>;
export interface StreamResult {
  frame: Frame;
  frameInfo?: FrameInfo;
  components?: readonly ComponentSpec[];
  scans?: readonly ScanInfo[];
  structure?: StreamStructure;
  preset: Preset | null;
  stats: Stats;
}
export function encodeStream(core: Core, options: EncodeOptions): Promise<StreamResult>;
export function decodeStream(core: Core, options: DecodeOptions): Promise<StreamResult>;
export function encodeImage(core: Core, frame: Frame, samples: Uint16Array,
  options?: Omit<EncodeOptions, 'frame' | 'onBytes' | 'read'>): Promise<StreamResult & { bytes: Uint8Array }>;
export function componentDimensions(frame: Pick<Frame, 'width' | 'height' | 'components'>): {
  maxH: number;
  maxV: number;
  widths: number[];
  heights: number[];
  offsets: number[];
  total: number;
};
export function encodePlanarImage(core: Core, frame: Frame, input: Uint16Array | readonly Uint16Array[],
  options?: Omit<EncodeOptions, 'frame' | 'onBytes' | 'read'>): Promise<StreamResult & { bytes: Uint8Array; hostConversionBufferBytes: number }>;
export function decodeImage(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint16Array }>;
export function decodePlanarImage(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint16Array; planes: Uint16Array[] }>;
export function inspectStream(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<StreamResult>;
