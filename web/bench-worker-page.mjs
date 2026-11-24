const fixtures = new Map();

async function bytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  return response.arrayBuffer();
}

async function fixture(near) {
  if (!fixtures.has(near)) {
    const [encoded, expected] = await Promise.all([
      bytes(`/fixtures/${near}.jls`), bytes(`/fixtures/${near}.raw`),
    ]);
    fixtures.set(near, { encoded: new Uint8Array(encoded), expected: new DataView(expected) });
  }
  return fixtures.get(near);
}

export async function workerTrial({ variant, near, backend, chunk, width, height, profile, timeoutMs }) {
  const { startWorker } = await import(`/${variant}/sdk/worker-client.mjs`);
  const { encoded, expected } = await fixture(near);
  if (expected.byteLength !== width * height * 2) throw new Error('Wrong reconstruction fixture length');
  const received = { needInput: 0, row: 0, progress: 0, done: 0, error: 0 };
  const sent = { start: 0, input: 0, rowAck: 0, progressAck: 0, cancel: 0 };
  let pendingSeq;
  let pendingType;
  let peakPending = 0;
  let protocolError;
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (!(data.type in received)) {
          protocolError ??= `Unexpected message ${data.type}`;
          return;
        }
        received[data.type]++;
        if (data.type === 'needInput' || data.type === 'progress' || data.type === 'row') {
          if (pendingSeq !== undefined) {
            peakPending = 2;
            protocolError ??= 'More than one pending Worker request';
          }
          pendingSeq = data.seq;
          pendingType = data.type;
          peakPending = Math.max(peakPending, 1);
        }
      });
    }
    postMessage(data, transfers) {
      if (data.type === 'ack' || data.type === 'input') {
        const matches = data.type === 'input' ? pendingType === 'needInput'
          : pendingType === 'progress' || pendingType === 'row';
        if (!matches || pendingSeq !== data.seq) protocolError ??= 'Worker reply has no matching request';
        const field = data.type === 'input' ? 'input' : pendingType === 'row' ? 'rowAck' : 'progressAck';
        sent[field]++;
        pendingSeq = undefined;
        pendingType = undefined;
      } else if (data.type === 'start' || data.type === 'cancel') sent[data.type]++;
      return super.postMessage(data, transfers);
    }
  };

  let offset = 0;
  let rows = 0;
  let sourceReads = 0;
  let eofReads = 0;
  let peakReadBytes = 0;
  let logicalSourceCopyBytes = 0;
  let checksum = 0x811c9dc5;
  let firstRowWallMs;
  let firstRowBytes;
  let retainedFirstRow;
  let sourceCallbackMs = 0;
  let rowCallbackMs = 0;
  const abort = new AbortController();
  const start = performance.now();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const job = startWorker({
      mode: 'decode', backend, inputChunkSize: chunk, signal: abort.signal,
      read(requested) {
        const began = profile ? performance.now() : 0;
        sourceReads++;
        if (requested < 1 || requested > chunk) throw new Error(`Invalid request length ${requested}`);
        if (offset === encoded.length) {
          eofReads++;
          if (profile) sourceCallbackMs += performance.now() - began;
          return null;
        }
        const end = Math.min(offset + requested, encoded.length);
        const part = encoded.slice(offset, end);
        offset = end;
        logicalSourceCopyBytes += part.byteLength;
        peakReadBytes = Math.max(peakReadBytes, part.byteLength);
        if (profile) sourceCallbackMs += performance.now() - began;
        return part;
      },
      onEvent(event) {
        if (event.type !== 'row') return;
        const began = profile ? performance.now() : 0;
        if (rows === 0) {
          firstRowWallMs = performance.now() - start;
          firstRowBytes = event.stats.firstRowInputConsumed;
          retainedFirstRow = event.row;
        } else if (retainedFirstRow.buffer === event.row.buffer) throw new Error('Reused transferred row buffer');
        if (event.index !== rows || !(event.row instanceof Uint16Array) || event.row.length !== width
          || event.row.byteLength !== event.row.buffer.byteLength) throw new Error(`Invalid row ${rows}`);
        for (let x = 0; x < width; x++) {
          const sample = event.row[x];
          if (sample !== expected.getUint16((rows * width + x) * 2, true)) throw new Error(`CharLS mismatch at ${x},${rows}`);
          checksum = Math.imul(checksum ^ sample, 0x01000193);
        }
        rows++;
        if (profile) rowCallbackMs += performance.now() - began;
      },
    });
    const result = await job.result;
    const wallMs = performance.now() - start;
    const frame = result.frame;
    if (frame.width !== width || frame.height !== height || frame.bits !== 16 || frame.near !== near) {
      throw new Error(`Unexpected frame ${JSON.stringify(frame)}`);
    }
    if (protocolError || pendingSeq !== undefined || received.done !== 1 || received.error !== 0 || sent.start !== 1
      || received.row !== height || rows !== height || sent.rowAck !== height || sent.progressAck !== received.progress
      || offset !== encoded.length || eofReads !== 1 || sourceReads !== received.needInput || sourceReads !== sent.input
      || result.stats.inputConsumed !== encoded.length || result.stats.outputProduced !== width * height
      || result.stats.rows !== height || result.stats.firstRowInputConsumed !== firstRowBytes
      || result.stats.inputPeakBytes !== peakReadBytes || result.stats.outputPeakBytes !== width * 2
      || retainedFirstRow[0] !== expected.getUint16(0, true) || retainedFirstRow.length !== width) {
      throw new Error(protocolError ?? 'Worker counts, ownership or statistics disagree');
    }
    return {
      wallMs, firstRowWallMs, firstRowBytes, loadMs: result.loadMs, frame, stats: result.stats,
      messages: { received, sent, peakPending },
      source: { reads: sourceReads, eofReads, peakReadBytes, logicalSourceCopyBytes },
      rows, checksum: (checksum >>> 0).toString(16).padStart(8, '0'),
      ...(profile ? { profile: { sourceCallbackMs, rowCallbackMs, worker: result.profile } } : {}),
    };
  } finally {
    clearTimeout(timer);
    globalThis.Worker = NativeWorker;
  }
}
