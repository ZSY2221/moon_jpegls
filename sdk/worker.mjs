import { CodecError, decodeStream, encodeStream, loadCore } from './index.mjs';

let active = false;
let terminal = false;
let paused = false;
let sequence = 0;
let pending;
let releasePause;
const abort = new AbortController();
const cancelled = () => new CodecError('Cancelled', 'Operation cancelled');
// Same maximum as the SDK's input/output chunk capacities. This bounds the
// batch allocation, not a whole Worker: an atomic row can exceed this budget.
const maximumBatchBytes = 1024 * 1024;

function finish(type, data) {
  if (terminal) return;
  terminal = true;
  self.postMessage({ type, ...data });
}

function reportError(error) {
  finish('error', {
    code: typeof error.code === 'string' ? error.code : 'RuntimeError',
    message: error.message,
    location: error.location ?? null,
  });
}

async function request(type, data, transfer = []) {
  while (paused && !abort.signal.aborted) {
    await new Promise((resume) => { releasePause = resume; });
  }
  if (abort.signal.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const seq = ++sequence;
    pending = { seq, resolve, reject };
    self.postMessage({ type, seq, ...data }, transfer);
  });
}

async function run(message) {
  const {
    mode, backend, frame, inputChunkSize, outputChunkSize, limits, trailing, sampleFormat,
    maxBatchBytes = 0, wasmModule, wasmBytes,
  } = message;
  if (mode !== 'encode' && mode !== 'decode') throw new CodecError('InvalidArgument', 'Unknown job mode');
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < 0 || maxBatchBytes > maximumBatchBytes) {
    throw new CodecError('InvalidArgument', `maxBatchBytes must be an integer in 0..${maximumBatchBytes}`);
  }
  const core = await loadCore({ backend, module: wasmModule, bytes: wasmBytes });
  let reportedRows = 0;
  let lastProgress = 0;
  let lastBatchFlush = 0;
  let deliveredRow = false;
  let batch = null;
  let inFlightOutputBytes = 0;
  let outputPeakBytes = 0;
  const outputQueueBytes = () => (batch?.samples.buffer.byteLength ?? 0) + inFlightOutputBytes;
  const recordOutput = (stats, sourceBytes = 0) => {
    // Include the current source row during batch copies and component switches.
    // This counts explicit output payloads throughout the ACK lifetime.
    outputPeakBytes = Math.max(outputPeakBytes, stats.outputPeakBytes, outputQueueBytes() + sourceBytes);
  };
  const outputStats = (stats) => {
    recordOutput(stats);
    return { ...stats, outputQueueBytes: outputQueueBytes(), outputPeakBytes };
  };
  const sendOutput = async (type, data, payload, stats) => {
    // Transfer moves the entire buffer, even when payload is a shorter view.
    inFlightOutputBytes = payload.buffer.byteLength;
    try {
      await request(type, { ...data, stats: outputStats(stats) }, [payload.buffer]);
    } finally {
      // The consumer ACK (or cancellation) ends this output's queue lifetime.
      inFlightOutputBytes = 0;
    }
  };
  const flushBatch = () => {
    if (!batch || batch.count === 0) return;
    const { startIndex, count, samples, frame: info, preset, stats, meta, stride } = batch;
    batch = null;
    lastBatchFlush = stats.elapsedMs;
    const used = count * stride;
    // Keep a short view for the final/time-limited batch without a second copy.
    const payload = used === samples.length ? samples : samples.subarray(0, used);
    return sendOutput('rows', {
      startIndex, count, samples: payload, frame: info, preset, ...meta,
    }, payload, stats);
  };
  const settings = {
    frame, inputChunkSize, outputChunkSize, limits, trailing, sampleFormat, signal: abort.signal,
    read: (maxElements) => request('needInput', { maxElements }),
    onProgress: (stats, info, preset, structure) => {
      if (deliveredRow) {
        deliveredRow = false;
        return;
      }
      if ((reportedRows === 0 && stats.rows > 0) || stats.elapsedMs - lastProgress >= 50) {
        reportedRows = stats.rows;
        lastProgress = stats.elapsedMs;
        return request('progress', { stats: outputStats(stats), frame: info, preset, structure: structure ?? null });
      }
    },
    onScanComplete: async (scan, stats, structure) => {
      if (batch) await flushBatch();
      return request('scanComplete', { scan, stats: outputStats(stats), structure: structure ?? null });
    },
    onBytes: (chunk, stats, preset) => sendOutput('bytes', { chunk, preset }, chunk, stats),
    onRow: async (row, index, info, stats, preset, rowMeta) => {
      deliveredRow = true;
      reportedRows = stats.rows;
      lastProgress = stats.elapsedMs;
      const scanKey = rowMeta ? `${rowMeta.scanIndex}:${rowMeta.componentIndex}` : '0:0';
      if (batch && batch.scanKey !== scanKey) {
        recordOutput(stats, row.buffer.byteLength);
        await flushBatch();
      }
      const stride = rowMeta?.stride ?? info.width;
      const sampleBytes = row.BYTES_PER_ELEMENT;
      const metaFields = {
        scanIndex: rowMeta?.scanIndex ?? 0,
        componentIndex: rowMeta?.componentIndex ?? 0,
        componentId: rowMeta?.componentId ?? 1,
        near: rowMeta?.near ?? info.near,
        height: rowMeta?.height ?? info.height,
        interleave: rowMeta?.interleave ?? 0,
        pointTransform: rowMeta?.pointTransform ?? 0,
        layout: rowMeta?.layout ?? 'planar',
        width: rowMeta?.width ?? stride,
        stride,
        sampleBytes,
        endianness: sampleBytes === 4 ? 'host-u32' : 'host-u16',
      };
      const maxRows = Math.floor(maxBatchBytes / (stride * sampleBytes));
      if (index === 0 || maxRows <= 1) {
        lastBatchFlush = stats.elapsedMs;
        return sendOutput('row', { row, index, frame: info, preset, ...metaFields }, row, stats);
      }
      if (!batch) {
        const compHeight = rowMeta?.height ?? info.height;
        const capacityRows = Math.min(maxRows, compHeight - index);
        batch = {
          scanKey,
          meta: metaFields,
          stride,
          compHeight,
          startIndex: index,
          count: 0,
          samples: new row.constructor(capacityRows * stride),
          frame: info,
          preset,
          stats,
        };
      }
      recordOutput(stats, row.buffer.byteLength);
      batch.samples.set(row, batch.count * batch.stride);
      batch.count++;
      batch.stats = stats;
      if (batch.count * batch.stride === batch.samples.length || index === batch.compHeight - 1 || paused || abort.signal.aborted || stats.elapsedMs - lastBatchFlush >= 16) {
        return flushBatch();
      }
    },
  };
  try {
    const result = await (mode === 'encode' ? encodeStream(core, settings) : decodeStream(core, settings));
    if (batch) await flushBatch();
    finish('done', { ...result, stats: outputStats(result.stats), backend: core.backend, loadMs: core.loadMs });
  } finally {
    batch = null;
    inFlightOutputBytes = 0;
  }
}

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'start':
      if (active) return;
      active = true;
      run(data).catch(reportError);
      break;
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      releasePause?.();
      releasePause = undefined;
      break;
    case 'cancel':
      abort.abort();
      releasePause?.();
      pending?.reject(cancelled());
      pending = undefined;
      reportError(cancelled());
      break;
    case 'input':
    case 'ack':
      if (pending?.seq === data.seq) {
        const { resolve } = pending;
        pending = undefined;
        resolve(data.type === 'input' ? data.chunk : undefined);
      }
      break;
    default:
      break;
  }
};
