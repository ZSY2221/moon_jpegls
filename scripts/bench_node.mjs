import assert from 'node:assert/strict';
import { openSync, readSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { decodeImage, decodeStream, encodeImage, encodeStream, loadCore } from '../sdk/index.mjs';

function sampleAt(index, width) {
  const x = index % width;
  const y = Math.floor(index / width);
  return (x * 173 + y * 47 + ((x ^ y) & 31) * 3) & 65535;
}

function generatedSamples(width, height, chunkSize) {
  const storage = new Uint16Array(chunkSize);
  let offset = 0;
  return (request) => {
    const length = Math.min(request, width * height - offset);
    if (!length) return null;
    for (let i = 0; i < length; i++) storage[i] = sampleAt(offset + i, width);
    offset += length;
    return storage.subarray(0, length);
  };
}

function fileChunks(filename, diskBufferBytes) {
  const fd = openSync(filename, 'r');
  const buf = Buffer.alloc(diskBufferBytes);
  let index = 0;
  let length = 0;
  let diskReadCalls = 0;
  let peakPayloadBytes = 0;
  return {
    read(request) {
      if (index === length) {
        length = readSync(fd, buf);
        index = 0;
        diskReadCalls++;
        peakPayloadBytes = Math.max(peakPayloadBytes, length);
      }
      if (!length) return null;
      const start = index;
      index = Math.min(length, index + request);
      return buf.subarray(start, index);
    },
    stats() { return { diskReadCalls, diskBufferBytes: buf.length, peakPayloadBytes }; },
    close() { closeSync(fd); }
  };
}

function sampleRss() {
  // Node maps uv_getrusage().ru_maxrss to kibibytes on the measured Windows host.
  return process.resourceUsage().maxRSS * 1024;
}

async function resourceTrial(core, operation, filename, width, height, inputChunkSize, outputChunkSize, pause, isolated) {
  const frame = { width, height, bits: 16, near: 0 };
  const source = operation === 'encode' ? null : fileChunks(filename, 8192);
  const read = source ? source.read : generatedSamples(width, height, inputChunkSize);
  let reads = 0;
  let callbacks = 0;
  let checksum = 0;
  let pauseMs = null;
  let pauseOutputBytes = null;
  let pauseInputBytes = null;
  function sourceRead(request) {
    reads++;
    return read(request);
  }
  async function hold(data, stats) {
    const started = performance.now();
    const readsBeforePause = reads;
    assert.equal(stats.outputQueueBytes, data.byteLength);
    pauseOutputBytes = data.byteLength;
    pauseInputBytes = stats.inputQueueBytes;
    await delay(20);
    assert.equal(reads, readsBeforePause, 'source receives no request while the sink is paused');
    assert.equal(callbacks, 1, 'sink receives no second data item while paused');
    pauseMs = performance.now() - started;
  }
  const peakRssBeforeBytes = isolated ? sampleRss() : null;
  const started = performance.now();
  let stats;
  try {
    if (operation === 'encode') {
      ({ stats } = await encodeStream(core, {
        frame, read: sourceRead, inputChunkSize, outputChunkSize,
        onBytes(data, progress) {
          callbacks++;
          for (const byte of data) checksum = (checksum + byte) >>> 0;
          if (pause && callbacks === 1) return hold(data, progress);
        }
      }));
      assert.equal(stats.inputConsumed, width * height);
    } else {
      ({ stats } = await decodeStream(core, {
        read: sourceRead, inputChunkSize,
        onRow(row, index, frame, progress) {
          callbacks++;
          for (let x = 0; x < row.length; x++) {
            if (row[x] !== sampleAt(index * width + x, width)) throw new Error(`resource reconstruction mismatch at ${x}, ${index}`);
            checksum = (checksum + row[x]) >>> 0;
          }
          if (pause && callbacks === 1) return hold(row, progress);
        }
      }));
      assert.equal(stats.outputProduced, width * height);
      assert.equal(stats.rows, height);
    }
  } finally {
    source?.close();
  }
  const wallMs = performance.now() - started;
  return {
    backend: core.backend, operation, width, height, inputChunkSize, outputChunkSize,
    ...stats, pauseMs, pauseOutputBytes, pauseInputBytes, reads, callbacks, checksum,
    ...(isolated ? { peakRssBeforeBytes, peakRssBytes: sampleRss() } : {}),
    source: source?.stats() ?? { allocatedBytes: inputChunkSize * 2 },
    wallMs,
    rawMiBPerSecond: pause ? null : (2 * width * height * 1000 / 1048576) / stats.elapsedMs
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

function summary(values) {
  const center = median(values);
  return {
    median: center,
    min: Math.min(...values),
    max: Math.max(...values),
    mad: median(values.map((sample) => Math.abs(sample - center))),
  };
}

async function measure(run, warmup, repeats) {
  const warmupMs = [];
  const samplesMs = [];
  let result;
  for (let i = 0; i < warmup + repeats; i++) {
    const started = performance.now();
    const value = run();
    result = value instanceof Promise ? await value : value;
    (i < warmup ? warmupMs : samplesMs).push(performance.now() - started);
  }
  return { result, timings: { warmupMs, samplesMs, summaryMs: summary(samplesMs) } };
}

async function resource(backend, operation, filename, width, height, inputChunkSize, outputChunkSize, pause, warmup, repeats) {
  const core = await loadCore({ backend });
  const isolated = warmup === undefined;
  const trial = () => resourceTrial(core, operation, filename, width, height, inputChunkSize, outputChunkSize, pause, isolated);
  if (isolated) {
    return { coldLoadMs: core.loadMs, ...(await trial()) };
  }
  const warmupSamples = [];
  const samples = [];
  for (let i = 0; i < warmup + repeats; i++) {
    (i < warmup ? warmupSamples : samples).push(await trial());
  }
  const summarized = (key) => summary(samples.map((sample) => sample[key]));
  return {
    backend, operation, width, height, inputChunkSize, outputChunkSize,
    processLoadMs: core.loadMs, warmupSamples, samples,
    driverElapsedMs: summarized('elapsedMs'), trialWallMs: summarized('wallMs'),
    firstRowMs: summarized('firstRowMs'),
    rawMiBPerSecond: pause ? null : summarized('rawMiBPerSecond'),
  };
}

function errorBound(original, reconstructed, threshold) {
  assert.equal(original.length, reconstructed.length);
  let bound = 0;
  for (let i = 0; i < original.length; i++) {
    bound = Math.max(bound, Math.abs(original[i] - reconstructed[i]));
    if (bound > threshold) throw new Error(`sample ${i} exceeds NEAR=${threshold}`);
  }
  return bound;
}

async function effect(folder, warmup, repeats) {
  const cases = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  const js = await loadCore({ backend: 'js' });
  const wasm = await loadCore({ backend: 'wasm-gc' });
  const oracleStart = performance.now();
  const { createOracle, readRaw } = await import('./oracle.mjs');
  const oracle = await createOracle();
  const oracleLoadMs = performance.now() - oracleStart;
  const records = [];
  try {
    for (const item of cases) {
      const pixels = readRaw(await readFile(join(folder, `${item.name}.raw`)));
      for (const near of [0, 3]) {
        const frame = { width: item.width, height: item.height, bits: item.bits, near };
        const enc = await measure(() => oracle.encode(pixels, frame, 4), warmup, repeats);
        const dec = await measure(() => oracle.decode(enc.result), warmup, repeats);
        const report = {
          ...item, near,
          'charls-wasm': {
            bytes: enc.result.length, maxError: errorBound(pixels, dec.result.pixels, near),
            encode: enc.timings, decode: dec.timings,
          }
        };
        for (const core of [js, wasm]) {
          const encode = await measure(() => encodeImage(core, frame, pixels, {
            inputChunkSize: 8192, outputChunkSize: 8192,
          }), warmup, repeats);
          const compressed = encode.result.bytes;
          const decode = await measure(() => decodeImage(core, compressed, {
            inputChunkSize: 8192,
          }), warmup, repeats);
          const reconstruction = decode.result.samples;
          const reference = oracle.decode(compressed);
          assert.equal(errorBound(reference.pixels, reconstruction, 0), 0, 'same-stream reference reconstruction');
          report[core.backend] = {
            bytes: compressed.length, maxError: errorBound(pixels, reconstruction, near),
            encode: encode.timings, decode: decode.timings,
          };
        }
        records.push(report);
      }
    }
  } finally {
    oracle.close();
  }
  return {
    timingBoundary: 'Wall time from complete-result API call to usable result; excludes fixture I/O, module load, and external correctness checks.',
    representation: { encodeInput: 'Uint16Array samples', encodedBytes: 'Uint8Array', decodeOutput: 'Uint16Array samples' },
    coldLoadMs: { js: js.loadMs, 'wasm-gc': wasm.loadMs, 'charls-wasm': oracleLoadMs }, records,
  };
}

const [mode, ...args] = process.argv.slice(2);
let result;
if (mode === 'resource') {
  const [backend, operation, file, w, h, inChunk, outChunk, ...options] = args;
  const pause = options[0] === 'pause';
  if (pause) options.shift();
  let warmup;
  let repeats;
  if (options.length !== 0) {
    const [warmupFlag, warmupArg, repeatsFlag, repeatsArg] = options;
    assert.equal(options.length, 4);
    assert.equal(warmupFlag, '--warmup');
    assert.equal(repeatsFlag, '--repeats');
    warmup = Number(warmupArg);
    repeats = Number(repeatsArg);
    assert.ok(Number.isInteger(warmup) && warmup >= 0);
    assert.ok(Number.isInteger(repeats) && repeats > 0);
  }
  result = await resource(backend, operation, file, Number(w), Number(h), Number(inChunk), Number(outChunk), pause, warmup, repeats);
} else if (mode === 'effect') {
  const [folder, warmup, repeats] = args;
  result = await effect(folder, Number(warmup), Number(repeats));
} else {
  throw new Error('Usage: node scripts/bench_node.mjs resource BACKEND OPERATION FILE WIDTH HEIGHT IN_CHUNK OUT_CHUNK [pause] [--warmup N --repeats N] | effect FOLDER WARMUP REPEATS');
}
console.log(JSON.stringify({ node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, memoryBytes: totalmem(), ...result }));
