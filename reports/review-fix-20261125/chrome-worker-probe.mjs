import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const require = createRequire(resolve(root, 'web/package.json'));
const { chromium } = require('playwright-core');
const origin = process.env.MOONJLS_WEB_URL ?? 'http://127.0.0.1:8000';
const executablePath = process.env.MOONJLS_CHROME;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const response = await page.goto(origin + '/web/');
  assert.equal(response.status(), 200);
  for (const backend of ['js', 'wasm-gc']) {
    const result = await page.evaluate(async ({ backend }) => {
      const { encodeImage, loadCore } = await import('/sdk/index.mjs');
      const { startWorker } = await import('/sdk/worker-client.mjs');
      const frame = { width: 8, height: 12, bits: 16, near: 0 };
      const expected = Uint16Array.from({ length: frame.width * frame.height }, (_, i) => i * 123);
      const { bytes } = await encodeImage(await loadCore({ backend: 'js' }), frame, expected);
      function createReader() {
        let offset = 0;
        return (size) => {
          if (offset === bytes.length) return null;
          const chunk = bytes.slice(offset, offset + size);
          offset += chunk.length;
          return chunk;
        };
      }
      function cancellableTimeout(label, job) {
        let timer;
        return Promise.race([
          job,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), 12000); }),
        ]).finally(() => clearTimeout(timer));
      }
      async function decode() {
        const actual = new Uint16Array(expected.length);
        const trace = [];
        const done = await cancellableTimeout('normal Worker decode', startWorker({
          mode: 'decode', backend, inputChunkSize: 256, maxBatchBytes: 96,
          read: createReader(),
          onEvent(event) {
            const payload = event.row ?? event.samples;
            if (payload) actual.set(payload, (event.index ?? event.startIndex) * frame.width);
            trace.push({
              type: event.type,
              rows: event.stats.rows,
              index: event.index ?? event.startIndex,
              count: event.count ?? (event.type === 'row' ? 1 : undefined),
              viewBytes: payload?.byteLength,
              backingBytes: payload?.buffer.byteLength,
              queue: event.stats.outputQueueBytes,
              peak: event.stats.outputPeakBytes,
            });
          },
        }).result);
        return {
          backend: done.backend, trace, actual: [...actual],
          terminal: { queue: done.stats.outputQueueBytes, peak: done.stats.outputPeakBytes, rows: done.stats.rows },
        };
      }
      const first = await decode();
      const nativePost = Worker.prototype.postMessage;
      const nativeTerminate = Worker.prototype.terminate;
      let cancellations = 0;
      const sent = [];
      const received = [];
      const observed = new WeakSet();
      Worker.prototype.postMessage = function (message, ...args) {
        if (!observed.has(this)) {
          observed.add(this);
          this.addEventListener('message', ({ data }) => received.push({ type: data.type, code: data.code, seq: data.seq }));
        }
        sent.push({ type: message.type, seq: message.seq });
        return nativePost.call(this, message, ...args);
      };
      Worker.prototype.terminate = function () {
        cancellations++;
        return nativeTerminate.call(this);
      };
      let release;
      let notify;
      let canceled;
      const delivered = [];
      const held = new Promise(resolve => { release = resolve; });
      const firstRow = new Promise(resolve => { notify = resolve; });
      try {
        const job = startWorker({
          mode: 'decode', backend, inputChunkSize: 256, maxBatchBytes: 96,
          read: createReader(),
          async onEvent(event) {
            delivered.push(event.type);
            if (event.type === 'row' && event.index === 0) {
              notify(event.seq);
              await held;
            }
          },
        });
        const state = job.result.then(result => ({ status: result.type }), error => ({ status: error.code }));
        const seq = await cancellableTimeout('canceled job first row', Promise.race([
          firstRow, state.then(result => { throw new Error('Ended before first row: ' + result.status); }),
        ]));
        job.pause();
        job.cancel();
        canceled = await cancellableTimeout('cancel while first-row ACK is held', state);
        release();
        await new Promise(resolve => setTimeout(resolve, 50));
        canceled.acksAfterCancel = sent.slice(sent.findIndex(message => message.type === 'cancel') + 1)
          .filter(message => message.type === 'ack');
        canceled.firstRowAcknowledged = sent.some(message => message.type === 'ack' && message.seq === seq);
        canceled.workerDoneMessages = received.filter(message => message.type === 'done').length;
        canceled.workerCancelledMessages = received.filter(message => message.type === 'error' && message.code === 'Cancelled').length;
        canceled.terminated = cancellations;
        canceled.rowCallbacks = delivered.filter(type => type === 'row' || type === 'rows').length;
      } finally {
        release();
        Worker.prototype.postMessage = nativePost;
        Worker.prototype.terminate = nativeTerminate;
      }
      const restart = await decode();
      return { first, canceled, restart, expected: [...expected] };
    }, { backend });

    for (const [name, run] of [['decode', result.first], ['restart', result.restart]]) {
      assert.equal(run.backend, backend);
      assert.deepEqual(run.actual, result.expected, name + ' pixel array');
      const batches = run.trace.filter(item => item.count !== undefined);
      assert.deepEqual(batches.map(item => [item.type, item.index, item.count, item.queue, item.peak]), [
        ['row', 0, 1, 16, 16],
        ['rows', 1, 6, 96, 112],
        ['rows', 7, 5, 80, 112],
      ]);
      assert.ok(batches.every(item => item.queue === item.backingBytes));
      assert.deepEqual(run.terminal, { queue: 0, peak: 112, rows: 12 });
      const peaks = [...run.trace.map(item => item.peak), run.terminal.peak];
      assert.ok(peaks.every((peak, i) => i === 0 || peak >= peaks[i - 1]));
      console.log(JSON.stringify({ backend, test: name, pixelSamples: run.actual.length, trace: run.trace, terminal: run.terminal }));
    }
    assert.deepEqual(result.canceled, {
      status: 'Cancelled', acksAfterCancel: [], firstRowAcknowledged: false,
      workerDoneMessages: 0, workerCancelledMessages: 1, terminated: 1, rowCallbacks: 1,
    });
    console.log(JSON.stringify({ backend, test: 'cancel during pending row acknowledgement', ...result.canceled }));
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', browser: browser.version(), node: process.version, headless: true }));
} finally {
  await browser.close();
}
