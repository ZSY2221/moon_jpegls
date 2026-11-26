import { componentDimensions } from './index.mjs';

const schemaVersion = 'moonjls.verification/1';
const stageStates = new Set(['not_run', 'incomplete', 'passed', 'failed', 'cancelled']);
let sequence = 0;

export function createRunId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++sequence}`;
}

export function codecMeasurements(stats, scope) {
  if (!stats) return null;
  return {
    scope,
    corePayloadBytes: stats.coreWorkspaceBytes ?? null,
    bridgeBufferPeakBytes: stats.bridgeBufferPeakBytes ?? null,
    inputPayloadPeakBytes: stats.inputPeakBytes ?? null,
    outputPayloadPeakBytes: stats.outputPeakBytes ?? null,
    lastOutputQueueBytes: stats.outputQueueBytes ?? null,
  };
}

export function reconstructionErrorBound(near, pointTransform = 0) {
  return 2 ** pointTransform * (near + 1) - 1;
}

function scanErrorParameters(frame, scanFields) {
  const available = scanFields?.length ? scanFields : [frame];
  return available.map((scan, index) => {
    const near = scan.near ?? frame.near;
    const pointTransform = scan.pointTransform ?? frame.pointTransform ?? 0;
    return {
      scanIndex: scan.scanIndex ?? index,
      near,
      pointTransform,
      reconstructionErrorBound: reconstructionErrorBound(near, pointTransform),
    };
  });
}

function describeFrame(frame, preset) {
  if (!frame) return null;
  const { width, height, bits } = frame;
  const components = frame.componentCount ?? (Array.isArray(frame.components) ? frame.components.length : 1);
  const scanFields = Array.isArray(frame.scans) ? frame.scans : null;
  const scanParameters = scanErrorParameters(frame, scanFields);
  const { near, pointTransform } = scanParameters[0];
  const interleave = frame.interleave ?? scanFields?.[0]?.interleave ?? 0;
  const scans = frame.scanCount ?? scanFields?.length ?? (interleave === 0 ? components : 1);
  let componentGeometry;
  if (Array.isArray(frame.components)) {
    const normalized = frame.components.map((component) => typeof component === 'number'
      ? { id: component, hSampling: 1, vSampling: 1 }
      : { id: component.id, hSampling: component.hSampling ?? component.h ?? 1, vSampling: component.vSampling ?? component.v ?? 1 });
    const dims = componentDimensions({ width, height, components: normalized });
    componentGeometry = normalized.map((component, i) => ({
      ...component, width: dims.widths[i], height: dims.heights[i], sampleOffset: dims.offsets[i],
    }));
  }
  return {
    width, height, bits, near,
    maxval: scanFields?.[0]?.preset?.maxval ?? preset?.maxval ?? frame.maxval ?? (2 ** bits - 1),
    preset: scanFields?.[0]?.preset ?? preset ?? null,
    components,
    scans,
    interleave,
    pointTransform,
    ...(scanParameters.some((scan) => scan.pointTransform) ? { scanParameters } : {}),
    ...(componentGeometry ? { componentGeometry } : {}),
    mapping: false,
  };
}

export function createVerificationReport(fields) {
  const stages = { encode: 'not_run', decode: 'not_run', compare: 'not_run', ...fields.stages };
  if (!Object.values(stages).every((state) => stageStates.has(state)) ||
      !['passed', 'failed', 'cancelled'].includes(fields.status)) {
    throw new TypeError('Invalid verification state');
  }
  const frame = describeFrame(fields.frame, fields.preset);
  const transformed = frame?.scanParameters;
  const samples = {
    total: frame?.componentGeometry?.reduce((sum, component) => sum + component.width * component.height, 0)
      ?? (frame ? frame.width * frame.height * frame.components : null),
    verified: fields.samples?.verified ?? null,
    maxError: fields.samples?.maxError ?? null,
    errorBound: transformed
      ? Math.max(...transformed.map((scan) => scan.reconstructionErrorBound))
      : frame?.near ?? null,
    unit: 'sample',
    ...(transformed ? { coded: {
      maxError: fields.samples?.codedMaxError ?? null,
      errorBound: Math.max(...transformed.map((scan) => scan.near)),
    } } : {}),
  };
  if (stages.compare === 'passed' &&
      (!frame || samples.verified !== samples.total || !Number.isSafeInteger(samples.maxError) ||
       samples.maxError < 0 || samples.maxError > samples.errorBound ||
       (transformed && (!Number.isSafeInteger(samples.coded.maxError) ||
         samples.coded.maxError < 0 || samples.coded.maxError > samples.coded.errorBound)))) {
    throw new TypeError('A passing comparison needs every sample and an observed error within NEAR and the reconstruction bound');
  }

  const reference = fields.reference ?? { status: 'not_run', name: null, version: null };
  const unexecuted = new Set(fields.unexecuted);
  for (const stage of ['encode', 'decode', 'compare']) {
    if (stages[stage] === 'not_run') unexecuted.add(stage);
  }
  if (reference.status === 'not_run') unexecuted.add('independent_reference');
  if (fields.input && !fields.input.sha256) unexecuted.add('input_sha256');
  if (fields.output && !fields.output.sha256) unexecuted.add('output_sha256');
  return {
    schemaVersion,
    runId: fields.runId ?? createRunId(),
    host: fields.host,
    backend: fields.backend ?? null,
    status: fields.status,
    error: fields.error ?? null,
    source: fields.source ?? null,
    artifact: fields.artifact ?? null,
    input: fields.input ?? null,
    output: fields.output ?? null,
    frame,
    stages,
    samples,
    reference,
    timing: { elapsedMs: null, encodeMs: null, decodeMs: null, compareMs: null, boundary: null, ...fields.timing },
    memory: { encode: null, decode: null, host: null, ...fields.memory },
    stream: {
      rowsDecoded: null, rowsDelivered: null, provisionalRows: null, firstRowMs: null, firstRowInputConsumed: null,
      acknowledgedEvents: null, peakHostAckMs: null,
      trailingPolicy: null, strictEoi: null, ...fields.stream,
    },
    limits: fields.limits ?? null,
    physical: fields.physical ?? null,
    unexecuted: [...unexecuted],
  };
}

export function serializeVerificationReport(report) {
  if (report.schemaVersion !== schemaVersion) throw new TypeError('Unknown verification report version');
  return `${JSON.stringify(report, null, 2)}\n`;
}
