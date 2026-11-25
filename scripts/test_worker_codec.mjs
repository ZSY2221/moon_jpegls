// Run: node --test scripts/test_worker_codec.mjs (requires sdk/generated).
// Optional baseline: MOONJLS_WORKER_SOURCE_ROOT=/path/to/built/baseline <command>
// Runs the unmodified production Worker/client and real generated JS/Wasm GC
// codecs using a Node worker_threads web-Worker adapter. This is not Chrome.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData, Worker as NodeWorker } from 'node:worker_threads';
import test from 'node:test';

if (!isMainThread) {
  const inbox = [];
  globalThis.self = {
    postMessage(message, transfer = []) { parentPort.postMessage(message, transfer); },
  };
  parentPort.on('message', data => {
    if (self.onmessage) self.onmessage({ data });
    else inbox.push(data);
  });
  await import(workerData.workerUrl);
  for (const data of inbox) self.onmessage({ data });
} else {
  const root = process.env.MOONJLS_WORKER_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
  const { loadCore, encodeImage } = await import(pathToFileURL(path.join(root, 'sdk/index.mjs')).href);
  class WebWorkerAdapter {
    constructor(url) {
      this.thread = new NodeWorker(new URL(import.meta.url), { workerData: { workerUrl: url.href } });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.({ message: error.message }));
      this.thread.on('messageerror', error => this.onmessageerror?.(error));
    }
    postMessage(message, transfer = []) { this.thread.postMessage(message, transfer); }
    terminate() { return this.thread.terminate(); }
  }
  globalThis.Worker = WebWorkerAdapter;
  const { startWorker } = await import(pathToFileURL(path.join(root, 'sdk/worker-client.mjs')).href);
  const frame = { width: 8, height: 12, bits: 16, near: 0 };
  const samples = Uint16Array.from({ length: frame.width * frame.height }, (_, i) => i * 123);
  const reference = await encodeImage(await loadCore({ backend: 'js' }), frame, samples);

  for (const backend of ['js', 'wasm-gc']) {
    test(`real ${backend} codec + real Worker/client: pixels, buffer high water, terminal queue`, { timeout: 10000 }, async () => {
      let offset = 0;
      const events = [];
      const decoded = new Uint16Array(samples.length);
      const job = startWorker({
        mode: 'decode', backend, inputChunkSize: 256, maxBatchBytes: 96,
        read(size) {
          if (offset === reference.bytes.length) return null;
          const chunk = reference.bytes.slice(offset, offset + size);
          offset += chunk.length;
          return chunk;
        },
        onEvent(event) {
          events.push(event);
          if (event.type === 'row') decoded.set(event.row, event.index * frame.width);
          if (event.type === 'rows') decoded.set(event.samples, event.startIndex * frame.width);
        },
      });
      const done = await job.result;
      const messages = [...events, done];
      console.log('REAL_WORKER_CODEC_TRACE', JSON.stringify({ backend, root, trace: messages.map(message => ({
        type: message.type, count: message.count ?? (message.type === 'row' ? 1 : undefined),
        viewBytes: (message.row ?? message.samples)?.byteLength,
        backingBytes: (message.row ?? message.samples)?.buffer.byteLength,
        queue: message.stats.outputQueueBytes, peak: message.stats.outputPeakBytes,
      })) }));
      assert.deepEqual(decoded, samples, 'Real codec output must exactly match original pixels');
      assert.equal(done.stats.rows, frame.height);
      assert.deepEqual(events.filter(message => message.type === 'row' || message.type === 'rows').map(message => message.count ?? 1), [1, 6, 5]);
      let peak = 0;
      for (const message of messages) {
        assert.ok(message.stats.outputPeakBytes >= peak, `Peak decreased at ${message.type}`);
        peak = message.stats.outputPeakBytes;
      }
      assert.equal(done.stats.outputPeakBytes, 112);
      assert.equal(done.stats.outputQueueBytes, 0);
    });
    test(`real ${backend} encoder Worker keeps byte ACKs and terminal peak`, { timeout: 10000 }, async () => {
      let offset = 0;
      const chunks = [];
      const peaks = [];
      const job = startWorker({
        mode: 'encode', backend, frame, inputChunkSize: 7, outputChunkSize: 3,
        read(size) {
          if (offset === samples.length) return null;
          const chunk = samples.slice(offset, offset + size);
          offset += chunk.length;
          return chunk;
        },
        onEvent(event) {
          peaks.push(event.stats.outputPeakBytes);
          if (event.type === 'bytes') chunks.push(event.chunk);
          assert.ok(event.type !== 'rows' && event.type !== 'row');
        },
      });
      const done = await job.result;
      assert.deepEqual(Uint8Array.from(chunks.flatMap(chunk => [...chunk])), reference.bytes);
      peaks.push(done.stats.outputPeakBytes);
      assert.ok(peaks.every((peak, index) => index === 0 || peak >= peaks[index - 1]));
      assert.equal(done.stats.outputPeakBytes, 3);
      assert.equal(done.stats.outputQueueBytes, 0);
    });
  }
}
