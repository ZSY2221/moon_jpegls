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
  const { loadCore, encodeImage, encodePlanarImage, inspectStream } = await import(pathToFileURL(path.join(root, 'sdk/index.mjs')).href);
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

    test(`real ${backend} multicomponent Worker delivers scan 0 rows before scan 1 arrives & supports pause/cancel`, { timeout: 15000 }, async () => {
      const mFrame = {
        width: 12, height: 6, bits: 16, near: 0,
        components: [{ id: 10 }, { id: 2 }, { id: 99 }],
        scans: [
          { componentId: 99, near: 0 },
          { componentId: 10, near: 3 },
          { componentId: 2, near: 0, preset: { t1: 6, t2: 12, t3: 30, reset: 20 } },
        ],
      };
      const planeSize = mFrame.width * mFrame.height;
      const planes = mFrame.components.map((_, c) =>
        Uint16Array.from({ length: planeSize }, (_, i) => ((i * 517 + c * 911) & 65535)));
      const jsCore = await loadCore({ backend: 'js' });
      const coded = await encodePlanarImage(jsCore, mFrame, planes);
      const st = (await inspectStream(jsCore, coded.bytes)).structure;
      assert.equal(st.scans.length, 3);
      assert.deepEqual(st.frame.components.map((c) => c.id), [10, 2, 99]);
      assert.deepEqual(st.scans.map((s) => s.componentId), [99, 10, 2]);
      assert.equal(st.eoiOffset, coded.bytes.length - 2);

      // Gate input right after Scan 0 entropy (withholding Scan 1 SOS and EOI)
      const cutAfterScan0 = st.scans[0].endOffset;
      let offset = 0;
      let releaseRest;
      const restGate = new Promise((r) => { releaseRest = r; });
      let scan0RowsDelivered = 0;
      let scan0Ready;
      const scan0Done = new Promise((r) => { scan0Ready = r; });
      const rebuilt = mFrame.components.map(() => new Uint16Array(planeSize));
      const events = [];

      const job = startWorker({
        mode: 'decode', backend, inputChunkSize: 256, maxBatchBytes: 64,
        async read(size) {
          if (offset === coded.bytes.length) return null;
          if (offset === cutAfterScan0) await restGate;
          const end = offset < cutAfterScan0 ? Math.min(offset + size, cutAfterScan0) : Math.min(offset + size, coded.bytes.length);
          const chunk = coded.bytes.slice(offset, end);
          offset = end;
          return chunk;
        },
        onEvent(event) {
          events.push(event);
          if (event.type === 'row') {
            rebuilt[event.componentIndex].set(event.row, event.index * mFrame.width);
            if (event.scanIndex === 0) scan0RowsDelivered++;
          } else if (event.type === 'rows') {
            rebuilt[event.componentIndex].set(event.samples, event.startIndex * mFrame.width);
            if (event.scanIndex === 0) scan0RowsDelivered += event.count;
          }
          if (scan0RowsDelivered === mFrame.height) scan0Ready();
        },
      });
      await scan0Done;
      assert.equal(scan0RowsDelivered, mFrame.height);
      assert.deepEqual(rebuilt[2], planes[2], 'First scanned component must match before scan 2 bytes arrive');

      // Pause across boundary, release remaining bytes, then resume
      job.pause();
      releaseRest();
      await new Promise((r) => setTimeout(r, 30));
      job.resume();
      const done = await job.result;
      assert.equal(done.stats.rows, mFrame.height * 3);
      assert.equal(done.stats.outputQueueBytes, 0);
      assert.equal(done.structure.scans.length, 3);
      assert.deepEqual(rebuilt[1], planes[1]);
      for (let i = 0; i < planeSize; i++) {
        assert.ok(Math.abs(rebuilt[0][i] - planes[0][i]) <= 3);
      }

      // Cancel mid-stream and start fresh single-component job (isolation)
      let cOff = 0;
      let pauseCancel;
      const cancelJob = startWorker({
        mode: 'decode', backend, inputChunkSize: 32, maxBatchBytes: 0,
        async read(size) {
          if (cOff >= 40) await new Promise((r) => { pauseCancel = r; });
          const c = coded.bytes.slice(cOff, Math.min(cOff + size, coded.bytes.length));
          cOff += c.length;
          return c.length ? c : null;
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      cancelJob.cancel();
      pauseCancel?.();
      await assert.rejects(cancelJob.result, { code: 'Cancelled' });
    });
  }
}
