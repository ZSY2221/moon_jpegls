import type { Frame, Preset, Stats } from './index.mjs';

type Status = 'passed' | 'failed' | 'cancelled';
type Stage = Status | 'not_run' | 'incomplete';
type Input = { name: string; format: string; bytes: number | null; sha256: string | null; provenance?: unknown };
type Output = Input & { retained: boolean; complete: boolean };
type CodecMeasurements = {
  scope: string;
  corePayloadBytes: number | null;
  bridgeBufferPeakBytes: number | null;
  inputPayloadPeakBytes: number | null;
  outputPayloadPeakBytes: number | null;
  lastOutputQueueBytes: number | null;
};

export interface VerificationReport {
  schemaVersion: 'moonjls.verification/1';
  runId: string;
  host: string;
  backend: string | null;
  status: Status;
  error: { code: string; message: string } | null;
  source: { revision: string; dirty: boolean } | null;
  artifact: { name: string; sha256: string } | null;
  input: Input | null;
  output: Output | null;
  frame: (Omit<Frame, 'maxval' | 'preset' | 'components' | 'scans'> & {
    maxval: number; components: number; scans: number; interleave: number; pointTransform: number; mapping: false;
    componentGeometry?: readonly {
      id: number; hSampling: number; vSampling: number; width: number; height: number; sampleOffset: number;
    }[];
    preset: Preset | null;
  }) | null;
  stages: Record<'encode' | 'decode' | 'compare', Stage>;
  samples: { total: number | null; verified: number | null; maxError: number | null; errorBound: number | null; unit: 'sample' };
  reference: { status: Stage; name: string | null; version: string | null };
  timing: {
    elapsedMs: number | null; encodeMs: number | null; decodeMs: number | null;
    compareMs: number | null; boundary: string | null;
  };
  memory: { encode: CodecMeasurements | null; decode: CodecMeasurements | null; host: object | null };
  stream: {
    rowsDecoded: number | null; rowsDelivered: number | null; provisionalRows: number | null; firstRowMs: number | null;
    firstRowInputConsumed: number | null; trailingPolicy: 'allow' | 'reject' | null; strictEoi: boolean | null;
    acknowledgedEvents: number | null; peakHostAckMs: number | null;
  };
  limits: object | null;
  physical: {
    unit: 'm'; quantity: 'codec_added_elevation_error'; errorBound: number; maxError: number | null;
  } | null;
  unexecuted: string[];
}

type ReportFields = Omit<Partial<VerificationReport>, 'schemaVersion' | 'frame' | 'stages' | 'samples' | 'timing' | 'memory' | 'stream'> & {
  host: string;
  status: Status;
  frame?: Frame | null;
  preset?: Preset | null;
  stages?: Partial<VerificationReport['stages']>;
  samples?: Partial<Pick<VerificationReport['samples'], 'verified' | 'maxError'>>;
  timing?: Partial<VerificationReport['timing']>;
  memory?: Partial<VerificationReport['memory']>;
  stream?: Partial<VerificationReport['stream']>;
};

export function createRunId(): string;
export function codecMeasurements(stats: Partial<Stats> | null | undefined, scope: string): CodecMeasurements | null;
export function createVerificationReport(fields: ReportFields): VerificationReport;
export function serializeVerificationReport(report: VerificationReport): string;
