import { lunarErrorMeters, lunarFixture, lunarMetadataFor } from '../sdk/lunar.mjs';
import { codecMeasurements, createVerificationReport, reconstructionErrorBound } from '../sdk/verification-report.mjs';

const hashLimit = 4 * 1024 * 1024;
let buildInfo;

async function blobSha256(blob) {
  if (!blob || blob.size > hashLimit || !globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function lunarIdentity(file) {
  if (file.size !== lunarFixture.pgmBytes) return null;
  return lunarMetadataFor({ sha256: await blobSha256(file), bytes: file.size, format: 'pgm' });
}

function deployedBuild() {
  buildInfo ??= fetch(new URL('./build-info.json', import.meta.url), { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null).catch(() => null);
  return buildInfo;
}

export function finishWorkbenchReport(job, status, error = null) {
  job.status = status;
  job.reportError = error && { code: error.code ?? error.name ?? 'Error', message: error.message };
  job.elapsed ??= job.started === undefined ? null : performance.now() - job.started;
  if (status === 'cancelled') {
    for (const stage of ['encode', 'decode', 'compare']) {
      if (job.stages[stage] === 'incomplete') job.stages[stage] = 'cancelled';
    }
  }
}

export async function workbenchReport(job) {
  const [inputSha, outputSha, build] = await Promise.all([
    job.pgm?.lunar?.pgmSha256 ?? blobSha256(job.file),
    blobSha256(job.artifact),
    deployedBuild(),
  ]);
  const inputFormat = job.inputFormat ?? (job.decodeOnly ? 'jls' : 'pgm');
  const provenance = lunarMetadataFor({ sha256: inputSha, bytes: job.file.size, format: inputFormat });
  const outputRetained = job.status === 'passed' && job.sinkMode !== 'bounded';
  const firstScan = job.structure?.scans?.[0] ?? job.frame;
  const physical = provenance && firstScan ? {
    unit: 'm',
    quantity: 'codec_added_elevation_error',
    errorBound: lunarErrorMeters(reconstructionErrorBound(firstScan.near, firstScan.pointTransform)),
    maxError: job.observedError === undefined ? null : lunarErrorMeters(job.observedError),
  } : null;
  const report = createVerificationReport({
    runId: job.runId,
    host: 'workbench',
    backend: job.backend,
    status: job.status,
    error: job.reportError,
    source: build?.source ?? null,
    artifact: build?.artifacts?.[job.backend] ?? null,
    input: { name: job.file.name, format: inputFormat, bytes: job.file.size, sha256: inputSha, provenance },
    output: {
      name: job.outputName, format: job.outputFormat ?? (job.decodeOnly ? 'pgm' : 'jls'), bytes: job.outputBytes ?? null,
      sha256: outputSha, retained: outputRetained, complete: outputRetained,
    },
    frame: job.frame && { ...job.frame, scans: job.structure?.scans ?? job.frame.scans },
    preset: job.preset,
    stages: job.stages,
    samples: { verified: job.verifiedSamples, maxError: job.observedError, codedMaxError: job.observedCodedError },
    physical,
    timing: {
      elapsedMs: job.elapsed,
      boundary: 'From sink open to successful close or failure/cancellation. Includes Worker load and host callbacks. Excludes preflight, host PPM planar conversion, and report hashing.',
    },
    memory: {
      encode: codecMeasurements(job.encodedStats, 'worker'), decode: codecMeasurements(job.stats, 'worker'),
      host: {
        sink: job.sinkMode,
        retainedOutputBytes: job.artifact?.size ?? (job.sinkMode === 'bounded' ? 0 : null),
        hostConversionBufferBytes: job.hostConversionBufferBytes ?? 0,
        previewBufferBytes: job.previewBufferBytes ?? 0,
      },
    },
    stream: {
      rowsDecoded: job.stats?.rows ?? null,
      rowsDelivered: job.rowsDelivered,
      provisionalRows: job.status === 'passed' ? 0 : job.rowsDelivered,
      firstRowMs: job.stats?.firstRowMs,
      firstRowInputConsumed: job.stats?.firstRowInputConsumed,
      trailingPolicy: 'reject',
      strictEoi: job.stages.decode === 'not_run' ? null : job.stages.decode === 'passed',
      acknowledgedEvents: job.acknowledgedEvents ?? null,
      peakHostAckMs: job.peakHostAckMs ?? null,
    },
    limits: { maxWidth: 65535, maxHeight: 65535, maxPixels: 100_000_000, maxMetadataBytes: 1_048_576,
      inputChunkSize: job.settings.inputChunkSize, outputChunkSize: job.settings.outputChunkSize },
  });
  if (job.componentStats?.length > 1) {
    report.samples.components = job.componentStats.map(({ absoluteError, ...component }) => ({
      ...component,
      meanAbsoluteError: component.verified ? absoluteError / component.verified : null,
      unverified: component.total - component.verified,
    }));
  }
  return report;
}
