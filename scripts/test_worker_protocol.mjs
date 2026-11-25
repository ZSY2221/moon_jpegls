// Run: node --experimental-vm-modules --test scripts/test_worker_protocol.mjs
// Optional baseline: MOONJLS_WORKER_SOURCE_ROOT=/path/to/review/package <command>
// Executes the actual Worker, client and SDK stream driver. Only loadCore is
// replaced by a deterministic session fixture: this is NOT a codec/Chrome test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

if (!vm.SourceTextModule) throw new Error('Run Node with --experimental-vm-modules');
const root = process.env.MOONJLS_WORKER_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const sources = Object.fromEntries(await Promise.all(['index.mjs', 'worker.mjs', 'worker-client.mjs'].map(async name =>
  [name, await readFile(path.join(root, 'sdk', name), 'utf8')])));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail(`Timed out waiting for ${label}`);
}

async function fixture({ width = 8, height = 12, partialInput = false, earlyFlush = false } = {}) {
  const frame = { width, height, bits: 16, near: 0 };
  const state = { clock: 0, steps: 0, reads: 0, loads: 0, cancellations: 0, workerMessages: [], clientMessages: [], terminated: false };
  const program = [{ status: 'NeedInput', at: 0 }];
  for (let row = 0; row < height; row++) {
    program.push({ status: 'RowReady', row, at: row + 1 + (partialInput && row >= 3 ? 100 : 0) + (earlyFlush && row >= 2 ? 20 : 0) });
    if (partialInput && row === 2) program.push({ status: 'NeedInput', at: 100 });
  }
  program.push({ status: 'Done', at: height + 2 + (partialInput ? 100 : 0) + (earlyFlush ? 20 : 0) });
  class Session {
    frame = frame;
    remaining = 0;
    coreWorkspaceBytes = 64;
    bridgeBufferBytes = 1;
    position = 0;
    stage(chunk) { this.remaining = chunk?.length ?? 0; }
    cancel() { state.cancellations++; }
    step() {
      const entry = program[this.position++];
      assert.ok(entry, 'Fixture must not be stepped after Done');
      state.steps++;
      state.clock = entry.at;
      const consumed = this.remaining;
      this.remaining = 0;
      const chunk = entry.row === undefined ? undefined : Uint16Array.from({ length: width }, (_, x) => entry.row * width + x);
      return { status: entry.status, consumed, produced: chunk?.length ?? 0, chunk };
    }
  }
  const globals = { AbortController, ArrayBuffer, Uint8Array, Uint16Array, URL, WebAssembly, console,
    performance: { now: () => state.clock } };
  const workerContext = vm.createContext({ ...globals });
  const sdk = new vm.SourceTextModule(sources['index.mjs'], { context: workerContext });
  await sdk.link(() => { throw new Error('Unexpected static SDK import'); });
  await sdk.evaluate();
  const core = { backend: 'js', loadMs: 0, createDecoder: () => new Session(), createEncoder: () => new Session() };
  const imported = new vm.SyntheticModule(['CodecError', 'decodeStream', 'encodeStream', 'loadCore'], function () {
    for (const name of ['CodecError', 'decodeStream', 'encodeStream']) this.setExport(name, sdk.namespace[name]);
    this.setExport('loadCore', async () => { state.loads++; return core; });
  }, { context: workerContext });
  let workerApi;
  let browserWorker;
  workerContext.self = {
    postMessage(message, transfer = []) {
      const data = structuredClone(message, { transfer });
      state.workerMessages.push(data);
      setImmediate(() => { if (!state.terminated) browserWorker.onmessage?.({ data }); });
    },
  };
  const workerModule = new vm.SourceTextModule(sources['worker.mjs'], { context: workerContext });
  await workerModule.link(specifier => {
    assert.equal(specifier, './index.mjs');
    return imported;
  });
  await workerModule.evaluate();
  workerApi = workerContext.self;

  class BrowserWorker {
    constructor() { browserWorker = this; }
    postMessage(message, transfer = []) {
      const data = structuredClone(message, { transfer });
      state.clientMessages.push(data);
      setImmediate(() => { if (!state.terminated) workerApi.onmessage({ data }); });
    }
    terminate() { state.terminated = true; }
  }
  const clientContext = vm.createContext({ ...globals, Worker: BrowserWorker });
  const clientImport = new vm.SyntheticModule(['CodecError'], function () {
    this.setExport('CodecError', sdk.namespace.CodecError);
  }, { context: clientContext });
  const clientModule = new vm.SourceTextModule(sources['worker-client.mjs'], {
    context: clientContext,
    initializeImportMeta(meta) { meta.url = pathToFileURL(path.join(root, 'sdk/worker-client.mjs')).href; },
  });
  await clientModule.link(specifier => {
    assert.equal(specifier, './index.mjs');
    return clientImport;
  });
  await clientModule.evaluate();
  return {
    state, frame,
    start(options = {}) {
      return clientModule.namespace.startWorker({ mode: 'decode', backend: 'js', trailing: 'allow', inputChunkSize: 256,
        read: () => { state.reads++; return Uint8Array.of(1); }, ...options });
    },
    send(message) { browserWorker.postMessage(message); },
  };
}

function trace(messages) {
  return messages.filter(message => message.stats).map(message => ({
    type: message.type, count: message.count ?? (message.type === 'row' ? 1 : undefined),
    viewBytes: (message.row ?? message.samples)?.byteLength,
    backingBytes: (message.row ?? message.samples)?.buffer.byteLength,
    queue: message.stats.outputQueueBytes, peak: message.stats.outputPeakBytes,
  }));
}
function monotonic(messages) {
  let peak = 0;
  for (const message of messages.filter(value => value.stats)) {
    assert.ok(message.stats.outputPeakBytes >= peak, `Peak decreased in ${message.type}`);
    assert.ok(message.stats.outputPeakBytes >= message.stats.outputQueueBytes, 'Peak must cover queue');
    peak = message.stats.outputPeakBytes;
  }
}

test('real Worker/client/SDK driver: batch high water includes simultaneous source row and survives Done', async () => {
  const run = await fixture();
  const result = await run.start({ maxBatchBytes: 96 }).result;
  console.log('WORKER_BATCH_TRACE', JSON.stringify(trace(run.state.workerMessages)));
  const data = run.state.workerMessages.filter(message => message.type === 'row' || message.type === 'rows');
  assert.deepEqual(data.map(message => message.count ?? 1), [1, 6, 5]);
  assert.deepEqual(data.flatMap(message => [...(message.row ?? message.samples)]), Array.from({ length: 96 }, (_, i) => i));
  monotonic(run.state.workerMessages);
  assert.equal(result.stats.outputPeakBytes, 112, '96-byte batch and 16-byte source row overlap');
  assert.equal(result.stats.outputQueueBytes, 0);
  assert.equal(data[2].samples.buffer.byteLength, 80, 'Allocate at most the remaining image rows');
});

test('partial batch survives progress and NeedInput; early flush counts backing buffer, not only view', async () => {
  const run = await fixture({ height: 20, partialInput: true });
  const result = await run.start({ maxBatchBytes: 96 }).result;
  console.log('WORKER_PARTIAL_TRACE', JSON.stringify(trace(run.state.workerMessages)));
  const progress = run.state.workerMessages.find(message => message.type === 'progress');
  assert.ok(progress, 'Fixture must emit progress while rows are buffered');
  assert.equal(progress.stats.outputQueueBytes, 96);
  assert.equal(progress.stats.outputPeakBytes, 112);
  assert.equal(run.state.reads, 2, 'Partial batch must survive a second NeedInput/response');
  const early = run.state.workerMessages.find(message => message.type === 'rows' && message.count === 3);
  assert.ok(early);
  assert.equal(early.samples.byteLength, 48);
  assert.equal(early.samples.buffer.byteLength, 96);
  assert.equal(early.stats.outputQueueBytes, 96);
  monotonic(run.state.workerMessages);
  assert.equal(result.stats.outputQueueBytes, 0);
  assert.equal(result.stats.outputPeakBytes, 112);
});

test('batch ACK is backpressure; wrong ACK is ignored; pause blocks next request until resume', async () => {
  const run = await fixture();
  const held = deferred();
  let batchEvent;
  const job = run.start({ maxBatchBytes: 96, onEvent(event) {
    if (event.type === 'rows' && !batchEvent) { batchEvent = event; return held.promise; }
  } });
  await until(() => batchEvent, 'first batch');
  const steps = run.state.steps;
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(run.state.steps, steps, 'No decoding while batch callback has not ACKed');
  run.send({ type: 'ack', seq: batchEvent.seq + 100 });
  await tick();
  assert.equal(run.state.steps, steps, 'Wrong ACK cannot release the batch');
  job.pause();
  await tick();
  held.resolve();
  for (let i = 0; i < 4; i++) await tick();
  const requests = run.state.workerMessages.filter(message => message.seq).length;
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(run.state.workerMessages.filter(message => message.seq).length, requests, 'Pause blocks output/input requests');
  job.resume();
  await job.result;
  assert.equal(run.state.workerMessages.at(-1).type, 'done');
});

test('cancel during held batch ACK rejects once and sends no late ACK or Done', async () => {
  const run = await fixture();
  const held = deferred();
  let batchEvent;
  const job = run.start({ maxBatchBytes: 96, onEvent(event) {
    if (event.type === 'rows' && !batchEvent) { batchEvent = event; return held.promise; }
  } });
  const rejection = assert.rejects(job.result, error => error.code === 'Cancelled');
  await until(() => batchEvent, 'held batch');
  job.pause();
  job.cancel();
  await rejection;
  held.resolve();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(run.state.workerMessages.filter(message => message.type === 'error').length, 1);
  assert.equal(run.state.workerMessages.filter(message => message.type === 'done').length, 0);
  assert.equal(run.state.clientMessages.filter(message => message.type === 'ack' && message.seq === batchEvent.seq).length, 0);
});

for (const maxBatchBytes of [0, 1, 15, 16, 17, 31]) {
  test(`atomic row fallback with maxBatchBytes=${maxBatchBytes}`, async () => {
    const run = await fixture({ height: 3 });
    const result = await run.start({ maxBatchBytes }).result;
    assert.equal(run.state.workerMessages.filter(message => message.type === 'rows').length, 0);
    assert.equal(result.stats.outputPeakBytes, 16);
    assert.equal(result.stats.outputQueueBytes, 0);
  });
}

test('small images do not reserve the entire allowed batch capacity', async () => {
  const run = await fixture({ height: 3 });
  const result = await run.start({ maxBatchBytes: 1024 * 1024 }).result;
  const batch = run.state.workerMessages.find(message => message.type === 'rows');
  assert.equal(batch.samples.buffer.byteLength, 32);
  assert.equal(result.stats.outputPeakBytes, 48);
});

for (const maxBatchBytes of [-1, 0.5, NaN, Infinity, 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER, '96', null]) {
  test(`invalid batch capacity ${String(maxBatchBytes)} rejects before loading codec`, async () => {
    const run = await fixture({ height: 3 });
    await assert.rejects(run.start({ maxBatchBytes }).result, error => error.code === 'InvalidArgument');
    assert.equal(run.state.loads, 0);
    assert.equal(run.state.steps, 0);
  });
}

test('multi-scan fixture flushes batch at scan boundary and tracks component identity', async () => {
  const frame = {
    width: 8, height: 4, bits: 16, near: 0,
    components: [{ id: 10 }, { id: 20 }],
  };
  const scans = [
    { scanIndex: 0, componentIndex: 0, componentId: 10, near: 0, completed: false },
    { scanIndex: 1, componentIndex: 1, componentId: 20, near: 2, completed: false },
  ];
  const program = [{ status: 'NeedInput' }];
  for (let s = 0; s < 2; s++) {
    for (let r = 0; r < 4; r++) program.push({ status: 'RowReady', s, r, doneScan: r === 3 });
  }
  program.push({ status: 'Done' });
  const state = { pos: 0, workerMessages: [], terminated: false };
  class MultiSession {
    frame = frame;
    remaining = 0;
    coreWorkspaceBytes = 128;
    bridgeBufferBytes = 16;
    rowMeta = null;
    scans = null;
    stage(chunk) { this.remaining = chunk?.length ?? 0; }
    cancel() {}
    step() {
      const e = program[state.pos++];
      const consumed = this.remaining;
      this.remaining = 0;
      if (e.status !== 'RowReady') {
        this.rowMeta = null;
        return { status: e.status, consumed, produced: 0 };
      }
      if (e.doneScan) scans[e.s] = { ...scans[e.s], completed: true };
      this.scans = scans.map(x => ({ ...x }));
      this.rowMeta = {
        scanIndex: e.s, componentIndex: e.s, componentId: e.s === 0 ? 10 : 20,
        rowIndex: e.r, near: e.s * 2, layout: 'planar', stride: 8, sampleBytes: 2, endianness: 'host-u16',
      };
      const chunk = Uint16Array.from({ length: 8 }, (_, x) => e.s * 100 + e.r * 8 + x);
      return { status: 'RowReady', consumed, produced: chunk.length, chunk, rowMeta: this.rowMeta };
    }
  }
  const globals = { AbortController, ArrayBuffer, Uint8Array, Uint16Array, URL, WebAssembly, console, performance: { now: () => state.pos } };
  const workerCtx = vm.createContext({ ...globals });
  const sdkMod = new vm.SourceTextModule(sources['index.mjs'], { context: workerCtx });
  await sdkMod.link(() => { throw new Error('unexpected import'); });
  await sdkMod.evaluate();
  const imported = new vm.SyntheticModule(['CodecError', 'decodeStream', 'encodeStream', 'loadCore'], function () {
    for (const n of ['CodecError', 'decodeStream', 'encodeStream']) this.setExport(n, sdkMod.namespace[n]);
    this.setExport('loadCore', async () => ({ backend: 'js', loadMs: 0, createDecoder: () => new MultiSession(), createEncoder: () => new MultiSession() }));
  }, { context: workerCtx });
  let workerApi;
  let browserWorker;
  workerCtx.self = {
    postMessage(message, transfer = []) {
      const data = structuredClone(message, { transfer });
      state.workerMessages.push(data);
      setImmediate(() => { if (!state.terminated) browserWorker.onmessage?.({ data }); });
    },
  };
  const workerMod = new vm.SourceTextModule(sources['worker.mjs'], { context: workerCtx });
  await workerMod.link(() => imported);
  await workerMod.evaluate();
  workerApi = workerCtx.self;
  class BrowserWorker {
    constructor() { browserWorker = this; }
    postMessage(message, transfer = []) {
      const data = structuredClone(message, { transfer });
      setImmediate(() => { if (!state.terminated) workerApi.onmessage({ data }); });
    }
    terminate() { state.terminated = true; }
  }
  const clientCtx = vm.createContext({ ...globals, Worker: BrowserWorker });
  const clientMod = new vm.SourceTextModule(sources['worker-client.mjs'], {
    context: clientCtx,
    initializeImportMeta(meta) { meta.url = pathToFileURL(path.join(root, 'sdk/worker-client.mjs')).href; },
  });
  await clientMod.link(() => new vm.SyntheticModule(['CodecError'], function () { this.setExport('CodecError', sdkMod.namespace.CodecError); }, { context: clientCtx }));
  await clientMod.evaluate();
  const job = clientMod.namespace.startWorker({
    mode: 'decode', backend: 'js', trailing: 'allow', inputChunkSize: 64, maxBatchBytes: 96,
    read: () => Uint8Array.of(1),
  });
  const done = await job.result;
  const rowMsgs = state.workerMessages.filter(m => m.type === 'row' || m.type === 'rows');
  assert.deepEqual(rowMsgs.map(m => [m.scanIndex, m.componentId, m.type === 'row' ? 1 : m.count]), [
    [0, 10, 1], [0, 10, 3],
    [1, 20, 1], [1, 20, 3],
  ]);
  assert.equal(state.workerMessages.filter(m => m.type === 'scanComplete').length, 2);
  monotonic(state.workerMessages);
  assert.equal(done.stats.outputQueueBytes, 0);
});
