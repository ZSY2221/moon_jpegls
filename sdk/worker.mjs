import { CodecError, decodeStream, encodeStream, loadCore } from './index.mjs';

let active = false;
let terminal = false;
let paused = false;
let sequence = 0;
let pending;
let releasePause;
const abort = new AbortController();
const cancelled = () => new CodecError('Cancelled', 'Operation cancelled');

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
  const core = await loadCore({ backend, module: wasmModule, bytes: wasmBytes });
  let reportedRows = 0;
  let lastProgress = 0;
  let lastBatchFlush = 0;
  let deliveredRow = false;
  let batch = null;
  const flushBatch = () => {
    if (!batch || batch.count === 0) return;
    const { startIndex, count, samples, frame: info, stats } = batch;
    batch = null;
    lastBatchFlush = stats.elapsedMs;
    const used = count * info.width;
    const payload = used === samples.length ? samples : samples.slice(0, used);
    const batchStats = {
      ...stats,
      outputQueueBytes: payload.byteLength,
      outputPeakBytes: Math.max(stats.outputPeakBytes, payload.byteLength),
    };
    return request('rows', { startIndex, count, samples: payload, frame: info, stats: batchStats }, [payload.buffer]);
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
        return request('progress', { stats, frame: info });
      }
    },
    onBytes: (chunk, stats) => request('bytes', { chunk, stats }, [chunk.buffer]),
    onRow: (row, index, info, stats) => {
      deliveredRow = true;
      reportedRows = stats.rows;
      lastProgress = stats.elapsedMs;
      if (index === 0 || maxBatchBytes <= 0) {
        lastBatchFlush = stats.elapsedMs;
        return request('row', { row, index, frame: info, stats }, [row.buffer]);
      }
      const maxRows = Math.max(1, Math.floor(maxBatchBytes / (info.width * 2)));
      if (maxRows <= 1) {
        lastBatchFlush = stats.elapsedMs;
        return request('row', { row, index, frame: info, stats }, [row.buffer]);
      }
      if (!batch) {
        batch = { startIndex: index, count: 0, samples: new Uint16Array(maxRows * info.width), frame: info, stats };
      }
      batch.samples.set(row, batch.count * info.width);
      batch.count++;
      batch.stats = stats;
      if (batch.count === maxRows || index === info.height - 1 || paused || abort.signal.aborted || stats.elapsedMs - lastBatchFlush >= 16) {
        return flushBatch();
      }
    },
  };
  const result = await (mode === 'encode' ? encodeStream(core, settings) : decodeStream(core, settings));
  if (batch) await flushBatch();
  finish('done', { ...result, backend: core.backend, loadMs: core.loadMs });
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
