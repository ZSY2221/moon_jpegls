export type Backend = 'js' | 'wasm-gc';
export type DecodeSampleFormat = 'u16' | 'u32';
export type DecodedSamples<Format extends DecodeSampleFormat = 'u16'> =
  Format extends 'u32' ? Uint32Array : Uint16Array;
export type DecodeSampleOptions<Format extends DecodeSampleFormat = 'u16'> =
  Format extends 'u32' ? { sampleFormat: 'u32' } : { sampleFormat?: 'u16' };
type RowFormat<Output> = Output extends Uint32Array ? 'u32' : 'u16';
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
  /** 0: one component per scan, 1: line-interleaved, 2: sample-interleaved. */
  readonly interleave?: number;
  /** SOS Pt (0–15). Input samples remain in the original domain. */
  readonly pointTransform?: number;
  /** NEAR in the entropy-coded sample domain. */
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

export interface RowMeta<Format extends DecodeSampleFormat = 'u16'> {
  readonly scanIndex: number;
  readonly componentIndex: number;
  readonly componentId: number;
  readonly rowIndex: number | null;
  readonly height?: number;
  /** NEAR in the entropy-coded sample domain. */
  readonly near: number;
  readonly interleave?: number;
  readonly pointTransform?: number;
  readonly preset: Preset | null;
  readonly layout: 'planar';
  readonly width?: number;
  readonly stride: number;
  readonly sampleBytes: Format extends 'u32' ? 4 : 2;
  readonly endianness: Format extends 'u32' ? 'host-u32' : 'host-u16';
}

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  /** NEAR in the entropy-coded sample domain. */
  readonly near: number;
  readonly interleave?: number;
  /** SOS Pt (0–15). Per-scan Pt takes precedence when supplied. */
  readonly pointTransform?: number;
  /** Effective MAXVAL in the entropy-coded sample domain. */
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

export type DecoderSessionOptions<Format extends DecodeSampleFormat = 'u16'> =
  SessionOptions & DecodeSampleOptions<Format>;

export interface Step<Output> {
  status: Status;
  consumed: number;
  produced: number;
  chunk?: Output;
  rowMeta?: RowMeta<RowFormat<Output>>;
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
  readonly rowMeta: RowMeta<RowFormat<Output>> | null;
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
  createDecoder(options: DecoderSessionOptions<'u32'>): Session<Uint8Array, Uint32Array>;
  createDecoder(options?: DecoderSessionOptions): Session<Uint8Array, Uint16Array>;
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

export type DecodeOptions<Format extends DecodeSampleFormat = 'u16'> =
  StreamOptions<Uint8Array> & DecodeSampleOptions<Format> & {
  trailing?: 'allow' | 'reject';
  onRow?(row: DecodedSamples<Format>, index: number, frame: Frame, stats: Stats, preset: Preset | null, rowMeta?: RowMeta<Format>): Awaitable<void>;
  onScanComplete?(scan: ScanInfo, stats: Stats, structure: StreamStructure | null): Awaitable<void>;
};

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
export function decodeStream(core: Core, options: DecodeOptions<'u32'>): Promise<StreamResult>;
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
/**
 * An array holds one plane per declared component. A flat array already follows scan order:
 * full planes for ILV=0, lines for ILV=1, and one sample per SOS component at each pixel for ILV=2.
 */
export function encodePlanarImage(core: Core, frame: Frame, input: Uint16Array | readonly Uint16Array[],
  options?: Omit<EncodeOptions, 'frame' | 'onBytes' | 'read'>): Promise<StreamResult & { bytes: Uint8Array; hostConversionBufferBytes: number }>;
export function decodeImage(core: Core, bytes: Uint8Array,
  options: Omit<DecodeOptions<'u32'>, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint32Array }>;
export function decodeImage(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint16Array }>;
export function decodePlanarImage(core: Core, bytes: Uint8Array,
  options: Omit<DecodeOptions<'u32'>, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint32Array; planes: Uint32Array[] }>;
export function decodePlanarImage(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read'>): Promise<StreamResult & { samples: Uint16Array; planes: Uint16Array[] }>;
export function inspectStream(core: Core, bytes: Uint8Array,
  options?: Omit<DecodeOptions, 'onRow' | 'read' | 'sampleFormat'>): Promise<StreamResult>;
