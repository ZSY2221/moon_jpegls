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
  finish('error', { code: typeof error.code === 'string' ? error.code : 'RuntimeError', message: error.message });
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
  const { mode, backend, frame, inputChunkSize, outputChunkSize, limits, trailing, maxBatchBytes = 0, wasmModule, wasmBytes } = message;
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
    // Count explicit ArrayBuffer payloads, including the source row while it
    // is copied into a batch. This is not JS heap/RSS or consumer retention.
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
    const { startIndex, count, samples, frame: info, stats } = batch;
    batch = null;
    lastBatchFlush = stats.elapsedMs;
    const used = count * info.width;
    // Keep a short view for the final/time-limited batch without a second copy.
    const payload = used === samples.length ? samples : samples.subarray(0, used);
    return sendOutput('rows', { startIndex, count, samples: payload, frame: info }, payload, stats);
  };
  const settings = {
    frame, inputChunkSize, outputChunkSize, limits, trailing, signal: abort.signal,
    read: (maxElements) => request('needInput', { maxElements }),
    onProgress: (stats, info) => {
      if (deliveredRow) {
        deliveredRow = false;
        return;
      }
      if ((reportedRows === 0 && stats.rows > 0) || stats.elapsedMs - lastProgress >= 50) {
        reportedRows = stats.rows;
        lastProgress = stats.elapsedMs;
        return request('progress', { stats: outputStats(stats), frame: info });
      }
    },
    onBytes: (chunk, stats) => sendOutput('bytes', { chunk }, chunk, stats),
    onRow: (row, index, info, stats) => {
      deliveredRow = true;
      reportedRows = stats.rows;
      lastProgress = stats.elapsedMs;
      if (index === 0 || maxBatchBytes <= 0) {
        lastBatchFlush = stats.elapsedMs;
        return sendOutput('row', { row, index, frame: info }, row, stats);
      }
      const maxRows = Math.max(1, Math.floor(maxBatchBytes / (info.width * 2)));
      if (maxRows <= 1) {
        lastBatchFlush = stats.elapsedMs;
        return sendOutput('row', { row, index, frame: info }, row, stats);
      }
      if (!batch) {
        const capacityRows = Math.min(maxRows, info.height - index);
        batch = { startIndex: index, count: 0, samples: new Uint16Array(capacityRows * info.width), frame: info, stats };
      }
      recordOutput(stats, row.buffer.byteLength);
      batch.samples.set(row, batch.count * info.width);
      batch.count++;
      batch.stats = stats;
      if (batch.count * info.width === batch.samples.length || index === info.height - 1 || paused || abort.signal.aborted || stats.elapsedMs - lastBatchFlush >= 16) {
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
