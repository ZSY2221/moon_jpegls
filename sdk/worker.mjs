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
  const { mode, backend, frame, inputChunkSize, outputChunkSize, limits, trailing } = message;
  if (mode !== 'encode' && mode !== 'decode') throw new CodecError('InvalidArgument', 'Unknown job mode');
  const core = await loadCore({ backend });
  let reportedRows = 0;
  let lastProgress = 0;
  let deliveredRow = false;
  const settings = {
    frame, inputChunkSize, outputChunkSize, limits, trailing, signal: abort.signal,
    read: (maxElements) => request('needInput', { maxElements }),
    onProgress: (stats, info) => {
      if (deliveredRow) {
        deliveredRow = false;
        return;
      }
      if (stats.rows !== reportedRows || stats.elapsedMs - lastProgress >= 50) {
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
      return request('row', { row, index, frame: info, stats }, [row.buffer]);
    },
  };
  const result = await (mode === 'encode' ? encodeStream(core, settings) : decodeStream(core, settings));
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
