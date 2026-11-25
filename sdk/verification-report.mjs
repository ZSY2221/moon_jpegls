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

function describeFrame(frame, preset) {
  if (!frame) return null;
  const { width, height, bits, near } = frame;
  return {
    width, height, bits, near,
    maxval: preset?.maxval ?? frame.maxval ?? (2 ** bits - 1),
    preset: preset ?? null,
    components: 1,
    scans: 1,
    interleave: 0,
    pointTransform: 0,
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
  const samples = {
    total: frame ? frame.width * frame.height : null,
    verified: fields.samples?.verified ?? null,
    maxError: fields.samples?.maxError ?? null,
    errorBound: frame?.near ?? null,
    unit: 'sample',
  };
  if (stages.compare === 'passed' &&
      (!frame || samples.verified !== samples.total || !Number.isSafeInteger(samples.maxError) ||
       samples.maxError < 0 || samples.maxError > frame.near)) {
    throw new TypeError('A passing comparison needs every sample and an observed error within NEAR');
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
