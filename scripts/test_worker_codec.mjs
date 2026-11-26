// Run: node --test scripts/test_worker_codec.mjs (requires sdk/generated).
// Optional baseline: MOONJLS_WORKER_SOURCE_ROOT=/path/to/built/baseline <command>
// Runs the unmodified production Worker/client and real generated JS/Wasm GC
// codecs using a Node worker_threads web-Worker adapter. This is not Chrome.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
  const { loadCore, encodeImage, encodePlanarImage, decodePlanarImage, decodeStream, inspectStream } = await import(pathToFileURL(path.join(root, 'sdk/index.mjs')).href);
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

  function readBytes(bytes) {
    let offset = 0;
    return (size) => {
      if (offset === bytes.length) return null;
      const chunk = bytes.slice(offset, offset + size);
      offset += chunk.length;
      return chunk;
    };
  }

  // Independent CharLS coded-domain stream with SOS Al=1. q̂=32768
  // occurs at sample seven, where the inverse transform is exactly 65536.
  const wideLiteral = Uint8Array.from(Buffer.from(
    'ffd8fff7000b100002000801011100ffda0008010100030001f40000a380001498008191e009219008ffd9', 'hex',
  ));
  const wideReconstruction = Uint32Array.of(
    0, 0, 0, 0, 0, 32760, 65534, 65536,
    0, 65520, 2, 2, 2, 2, 65534, 65534,
  );

  test('SDK CLI wide decode writes little-endian pixels and names the output representation', async () => {
    const execute = promisify(execFile);
    const folder = await mkdtemp(path.join(tmpdir(), 'moonjls-wide-cli-'));
    const input = path.join(folder, 'input.jls');
    const output = path.join(folder, 'output.bin');
    const report = path.join(folder, 'report.json');
    const cli = path.join(root, 'sdk/cli.mjs');
    try {
      await writeFile(input, wideLiteral);
      await execute(process.execPath, [
        cli, 'decode', '--input', input, '--output', output, '--report', report, '--sample-format', 'u32', '--chunk', '1',
      ]);
      const bytes = await readFile(output);
      assert.equal(bytes.byteLength, wideReconstruction.byteLength);
      assert.deepEqual(Uint32Array.from(wideReconstruction, (_, index) => bytes.readUInt32LE(index * 4)), wideReconstruction);
      const evidence = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(evidence.status, 'passed');
      assert.equal(evidence.output.format, 'raw-u32le');
      assert.equal(evidence.output.layout, 'delivery-order');
      assert.equal(evidence.output.sampleBytes, 4);
      assert.equal(evidence.output.endianness, 'little');
      assert.equal(evidence.output.bytes, 64);
      assert.equal(evidence.stream.rowsDelivered, 2);
      const { stdout } = await execute(process.execPath, [cli, 'inspect', '--input', input, '--chunk', '7']);
      assert.equal(JSON.parse(stdout).scans[0].pointTransform, 1);
      await Promise.all([unlink(report), unlink(output)]);
      const mapped = Buffer.from('ffd8fff7000b020001000401011100fff80009020701c9d4dfeaffda0008010107000000a780ffd9', 'hex');
      await writeFile(input, mapped);
      await execute(process.execPath, [cli, 'decode', '--input', input, '--output', output, '--report', report, '--chunk', '1']);
      assert.deepEqual(await readFile(output), Buffer.of(201, 0, 234, 0, 212, 0, 223, 0));
      const narrow = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(narrow.output.format, 'raw-u16le');
      assert.equal(narrow.output.layout, 'delivery-order');
      assert.equal(narrow.output.sampleBytes, 2);
      assert.equal(narrow.output.endianness, 'little');
    } finally {
      await Promise.all([input, output, report].map(file => unlink(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      })));
      await rmdir(folder);
    }
  });

  for (const backend of ['js', 'wasm-gc']) {
    test(`real ${backend} wide SDK rows and planes preserve exact inverse Pt at arbitrary splits`, { timeout: 10000 }, async () => {
      const core = await loadCore({ backend });
      assert.throws(() => core.createDecoder({ sampleFormat: 'u24' }), { code: 'InvalidArgument' });
      await assert.rejects(decodePlanarImage(core, wideLiteral), { code: 'UnsupportedFeature' });
      for (const inputChunkSize of [1, 7, 4096]) {
        const options = { sampleFormat: 'u32', inputChunkSize };
        const decoded = await decodePlanarImage(core, wideLiteral, options);
        assert.deepEqual(decoded.samples, wideReconstruction);
        assert.deepEqual(decoded.planes, [wideReconstruction]);
        assert.equal(decoded.stats.outputProduced, 16);
        assert.equal(decoded.stats.outputPeakBytes, 32);

        const rows = [];
        const result = await decodeStream(core, {
          ...options, read: readBytes(wideLiteral),
          onRow(row, index, _frame, stats, _preset, meta) {
            assert.ok(row instanceof Uint32Array);
            assert.equal(meta.sampleBytes, 4);
            assert.equal(meta.endianness, 'host-u32');
            assert.equal(meta.stride, 8);
            assert.equal(index, rows.length / row.length);
            assert.equal(stats.outputQueueBytes, row.byteLength);
            rows.push(...row);
          },
        });
        assert.deepEqual(rows, [...wideReconstruction]);
        assert.equal(result.stats.outputQueueBytes, 0);
      }
      const inspected = await inspectStream(core, wideLiteral, { inputChunkSize: 1 });
      assert.equal(inspected.scans[0].pointTransform, 1);
      assert.equal(inspected.scans[0].completed, true);
    });

    test(`real ${backend} wide Worker batches respect byte budgets and wait for ACK`, { timeout: 10000 }, async () => {
      const wideFrame = { ...frame, near: 2, pointTransform: 2 };
      const source = new Uint16Array(frame.width * frame.height).fill(65535);
      const { bytes } = await encodeImage(await loadCore({ backend }), wideFrame, source);
      // First transformed source sample is 16383. Annex A quantizes its run
      // interruption at step 5 to q̂=16385, then a constant run preserves it.
      const expected = new Uint32Array(source.length).fill(65540);
      const decoded = new Uint32Array(expected.length);
      let ready;
      const hasBatch = new Promise(resolve => { ready = resolve; });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const read = readBytes(bytes);
      let reads = 0;
      let events = 0;
      let batch;
      const job = startWorker({
        mode: 'decode', backend, sampleFormat: 'u32', inputChunkSize: 7, maxBatchBytes: 96,
        read(size) { reads++; return read(size); },
        async onEvent(event) {
          events++;
          if (event.type !== 'row' && event.type !== 'rows') return;
          const payload = event.row ?? event.samples;
          assert.ok(payload instanceof Uint32Array);
          assert.equal(event.sampleBytes, 4);
          assert.equal(event.endianness, 'host-u32');
          assert.equal(event.stride, frame.width);
          assert.equal(event.stats.outputQueueBytes, payload.buffer.byteLength);
          assert.ok(payload.buffer.byteLength <= 96);
          decoded.set(payload, (event.index ?? event.startIndex) * frame.width);
          if (event.type === 'rows') {
            assert.ok(event.count <= 3, 'A 96-byte batch holds at most three 32-byte rows');
            if (!batch) { batch = event; ready(); await held; }
          }
        },
      });
      try {
        await Promise.race([hasBatch, job.result.then(() => assert.fail('Expected a held wide batch'))]);
        const beforeAck = { reads, events };
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual({ reads, events }, beforeAck, 'The worker must wait for the wide batch ACK');
      } finally {
        release();
      }
      const result = await job.result;
      assert.deepEqual(decoded, expected);
      assert.equal(result.stats.outputProduced, expected.length);
      assert.equal(result.stats.outputPeakBytes, 128, '96-byte batch and 32-byte source row overlap');
      assert.equal(result.stats.outputQueueBytes, 0);
    });

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

    test(`real ${backend} ILV=2 Worker preserves SOS row order through ACK, cancellation, and restart`, { timeout: 15000 }, async () => {
      const ilvFrame = {
        width: 9, height: 4, bits: 16, near: 0,
        components: [99, 10, 2],
        scans: [{ componentIds: [99, 10, 2], interleave: 2 }],
      };
      const planeSize = ilvFrame.width * ilvFrame.height;
      const planes = ilvFrame.components.map((_, ci) =>
        Uint16Array.from({ length: planeSize }, (_, p) => (p * 1297 + ci * 553 + 7) & 65535));
      const core = await loadCore({ backend });
      const { bytes: coded } = await encodePlanarImage(core, ilvFrame, planes, { inputChunkSize: 7, outputChunkSize: 3 });

      // The streaming Worker encoder takes one sample per SOS component at each pixel.
      const packed = new Uint16Array(planeSize * 3);
      for (let p = 0; p < planeSize; p++) {
        packed.set([planes[0][p], planes[1][p], planes[2][p]], p * 3);
      }
      let packedOffset = 0;
      const workerBytes = [];
      const encoder = startWorker({
        mode: 'encode', backend, frame: ilvFrame, inputChunkSize: 7, outputChunkSize: 3,
        read(size) {
          if (packedOffset === packed.length) return null;
          const chunk = packed.slice(packedOffset, packedOffset + size);
          packedOffset += chunk.length;
          return chunk;
        },
        onEvent(event) {
          if (event.type === 'bytes') workerBytes.push(event.chunk);
        },
      });
      const encoded = await encoder.result;
      assert.deepEqual(Uint8Array.from(workerBytes.flatMap(chunk => [...chunk])), coded);
      assert.equal(encoded.stats.outputQueueBytes, 0);

      // Cancel while the consumer holds the first row ACK, then immediately start a new decoder.
      let seenFirstRow;
      const firstRow = new Promise(resolve => { seenFirstRow = resolve; });
      let releaseAck;
      const ackGate = new Promise(resolve => { releaseAck = resolve; });
      let cancelledOffset = 0;
      let cancelledRows = 0;
      let cancelledAcks = 0;
      const cancelledJob = startWorker({
        mode: 'decode', backend, inputChunkSize: 7, maxBatchBytes: 54,
        read(size) {
          if (cancelledOffset === coded.length) return null;
          const chunk = coded.slice(cancelledOffset, cancelledOffset + size);
          cancelledOffset += chunk.length;
          return chunk;
        },
        async onEvent(event) {
          if (event.type !== 'row') return;
          cancelledRows++;
          seenFirstRow();
          await ackGate;
        },
        onAck(event) {
          if (event.type === 'row') cancelledAcks++;
        },
      });
      await Promise.race([firstRow, cancelledJob.result.then(() => assert.fail('Expected a held row ACK'))]);
      const cancelled = assert.rejects(cancelledJob.result, { code: 'Cancelled' });
      cancelledJob.cancel();

      // Stage through the entropy segment and hold EOI until every row has been delivered.
      const eoi = coded.length - 2;
      let releaseEoi;
      const eoiGate = new Promise(resolve => { releaseEoi = resolve; });
      let rowsReady;
      const allRows = new Promise(resolve => { rowsReady = resolve; });
      const delivered = [];
      let decodedOffset = 0;
      const job = startWorker({
        mode: 'decode', backend, inputChunkSize: 7, maxBatchBytes: 54,
        async read(size) {
          if (decodedOffset === coded.length) return null;
          if (decodedOffset === eoi) {
            assert.equal(delivered.length, 3 * ilvFrame.height, 'All rows must be delivered before reading EOI');
            await eoiGate;
          }
          const end = Math.min(decodedOffset + size, decodedOffset < eoi ? eoi : coded.length);
          const chunk = coded.slice(decodedOffset, end);
          decodedOffset = end;
          return chunk;
        },
        onEvent(event) {
          if (event.type !== 'row' && event.type !== 'rows') return;
          const payload = event.row ?? event.samples;
          const index = event.index ?? event.startIndex;
          assert.equal(event.count ?? 1, 1, 'Rows from different SOS components cannot share a batch');
          assert.equal(event.scanIndex, 0);
          assert.equal(event.interleave, 2);
          assert.equal(event.layout, 'planar');
          assert.equal(event.stride, ilvFrame.width);
          assert.equal(event.height, ilvFrame.height);
          assert.equal(event.sampleBytes, 2);
          assert.equal(event.stats.outputQueueBytes, payload.buffer.byteLength);
          assert.deepEqual(payload, planes[event.componentIndex].slice(index * ilvFrame.width, (index + 1) * ilvFrame.width));
          delivered.push([event.componentId, index]);
          if (delivered.length === 3 * ilvFrame.height) rowsReady();
        },
      });
      await cancelled;
      releaseAck();
      try {
        await Promise.race([allRows, job.result.then(() => assert.fail('Expected all rows before EOI'))]);
        assert.equal(cancelledRows, 1);
        assert.equal(cancelledAcks, 0);
        assert.deepEqual(delivered, Array.from({ length: ilvFrame.height }, (_, y) => [[99, y], [10, y], [2, y]]).flat());
        assert.equal(decodedOffset, eoi);
      } finally {
        releaseEoi();
      }
      const done = await job.result;
      assert.equal(done.stats.rows, 3 * ilvFrame.height);
      assert.equal(done.stats.outputQueueBytes, 0);
      assert.equal(done.stats.outputPeakBytes, 72, '54-byte batch and 18-byte source row');
      assert.ok(done.scans[0].completed);
    });

    test(`real ${backend} sampled Worker keeps real rows through ACK, cancellation, and finalization`, { timeout: 15000 }, async () => {
      const sampled = {
        width: 9, height: 7, bits: 8, near: 0, interleave: 1,
        components: [{ id: 10, hSampling: 1, vSampling: 2 }, { id: 20, hSampling: 2, vSampling: 1 }],
      };
      const widths = [5, 9];
      const heights = [7, 4];
      const planes = widths.map((width, ci) =>
        Uint16Array.from({ length: width * heights[ci] }, (_, p) => (p * 23 + ci * 75) & 255));
      const core = await loadCore({ backend });
      const { bytes: coded } = await encodePlanarImage(core, sampled, planes, {
        inputChunkSize: 7, outputChunkSize: 1, limits: { maxPixels: 71 },
      });
      await assert.rejects(decodePlanarImage(core, coded, { limits: { maxPixels: 70 } }), { code: 'ResourceLimit' });
      await assert.rejects(encodePlanarImage(core, { ...sampled, interleave: 2 }, planes), { code: 'InvalidArgument' });

      let heldBatch;
      const firstBatch = new Promise(resolve => { heldBatch = resolve; });
      let releaseAck;
      const ack = new Promise(resolve => { releaseAck = resolve; });
      let cancelledAcks = 0;
      const cancelledJob = startWorker({
        mode: 'decode', backend, inputChunkSize: 7, maxBatchBytes: 28,
        read: readBytes(coded),
        async onEvent(event) {
          if (event.type !== 'rows') return;
          heldBatch();
          await ack;
        },
        onAck(event) { if (event.type === 'rows') cancelledAcks++; },
      });
      await Promise.race([firstBatch, cancelledJob.result.then(() => assert.fail('Expected a held component batch ACK'))]);
      const cancelled = assert.rejects(cancelledJob.result, { code: 'Cancelled' });
      cancelledJob.pause();
      cancelledJob.cancel();

      let offset = 0;
      const eoi = coded.length - 2;
      const emitted = [];
      let deliveredSamples = 0;
      let reachedEoi;
      const eoiRequested = new Promise(resolve => { reachedEoi = resolve; });
      let resumeEoi;
      const heldEoi = new Promise(resolve => { resumeEoi = resolve; });
      const job = startWorker({
        mode: 'decode', backend, inputChunkSize: 7, maxBatchBytes: 28,
        limits: { maxPixels: 71 },
        async read(size) {
          if (offset === coded.length) return null;
          if (offset === eoi) {
            assert.equal(emitted.length, 11, 'All valid rows are delivered before requesting EOI');
            reachedEoi();
            await heldEoi;
          }
          const end = Math.min(offset + size, offset < eoi ? eoi : coded.length);
          const bytes = coded.slice(offset, end);
          offset = end;
          return bytes;
        },
        onEvent(event) {
          if (event.type !== 'row' && event.type !== 'rows') return;
          const ci = event.componentIndex;
          const index = event.index ?? event.startIndex;
          const count = event.count ?? 1;
          const row = event.row ?? event.samples;
          assert.equal(event.width, widths[ci]);
          assert.equal(event.stride, widths[ci]);
          assert.equal(event.height, heights[ci]);
          assert.equal(event.interleave, 1);
          assert.equal(event.layout, 'planar');
          assert.equal(event.sampleBytes, 2);
          assert.deepEqual(row, planes[ci].slice(index * event.stride, (index + count) * event.stride));
          assert.equal(event.stats.outputQueueBytes, row.buffer.byteLength);
          deliveredSamples += row.length;
          for (let i = 0; i < count; i++) emitted.push([event.componentId, index + i]);
        },
      });
      await cancelled;
      releaseAck();
      try {
        await Promise.race([eoiRequested, job.result.then(() => assert.fail('Expected the EOI request'))]);
        assert.equal(cancelledAcks, 0);
        assert.equal(deliveredSamples, 71);
        assert.deepEqual(emitted, [
          [10, 0], [10, 1], [20, 0],
          [10, 2], [10, 3], [20, 1],
          [10, 4], [10, 5], [20, 2],
          [10, 6], [20, 3],
        ]);
      } finally {
        resumeEoi();
      }
      const done = await job.result;
      assert.equal(done.stats.outputQueueBytes, 0);
      assert.equal(done.stats.rows, 11);
      assert.equal(done.stats.outputProduced, 71);
      assert.equal(done.scans[0].completed, true);
    });
  }
}
