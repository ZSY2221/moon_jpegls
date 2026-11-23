import assert from 'node:assert/strict';
import { openSync, readSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { decodeStream, encodeStream, loadCore } from '../sdk/index.mjs';

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

async function resource(backend, operation, filename, width, height, inputChunkSize, outputChunkSize, pause) {
  const core = await loadCore({ backend });
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
  const peakRssBeforeBytes = sampleRss();
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
  return {
    backend, operation, width, height, inputChunkSize, outputChunkSize,
    coldLoadMs: core.loadMs,
    ...stats, pauseMs, pauseOutputBytes, pauseInputBytes, reads, callbacks, checksum,
    peakRssBeforeBytes, peakRssBytes: sampleRss(),
    source: source?.stats() ?? { allocatedBytes: inputChunkSize * 2 },
    rawMiBPerSecond: pause ? null : (2 * width * height * 1000 / 1048576) / stats.elapsedMs
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

function measure(run, repeats) {
  const values = [];
  let result;
  for (let i = 0; i <= repeats; i++) {
    const t = performance.now();
    result = run();
    values.push(performance.now() - t);
  }
  return { result, firstMs: values[0], medianMs: median(values.slice(1)) };
}

async function measureStream(run, repeats) {
  const values = [];
  let result;
  for (let i = 0; i <= repeats; i++) {
    result = await run();
    values.push(result.stats.elapsedMs);
  }
  return { result, firstMs: values[0], medianMs: median(values.slice(1)) };
}

function arrayReader(input) {
  let index = 0;
  return (chunkSize) => {
    if (index === input.length) return null;
    const start = index;
    index = Math.min(input.length, index + chunkSize);
    return input.subarray(start, index);
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

async function effect(folder, repeats) {
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
        const enc = measure(() => oracle.encode(pixels, frame, 4), repeats);
        const dec = measure(() => oracle.decode(enc.result), repeats);
        const report = {
          ...item, near,
          'charls-wasm': {
            bytes: enc.result.length, maxError: errorBound(pixels, dec.result.pixels, near),
            encodeFirstMs: enc.firstMs, decodeFirstMs: dec.firstMs,
            encodeMedianMs: enc.medianMs, decodeMedianMs: dec.medianMs,
          }
        };
        for (const core of [js, wasm]) {
          let compressed;
          const encode = await measureStream(async () => {
            const blocks = [];
            const result = await encodeStream(core, {
              frame, read: arrayReader(pixels), inputChunkSize: 8192, outputChunkSize: 8192,
              onBytes(data) { blocks.push(data); }
            });
            compressed = Buffer.concat(blocks);
            return result;
          }, repeats);
          const reconstruction = new Uint16Array(pixels.length);
          const decode = await measureStream(() => decodeStream(core, {
            read: arrayReader(compressed), inputChunkSize: 8192,
            onRow(data, i) { reconstruction.set(data, i * frame.width); }
          }), repeats);
          const reference = oracle.decode(compressed);
          assert.equal(errorBound(reference.pixels, reconstruction, 0), 0, 'same-stream reference reconstruction');
          report[core.backend] = {
            bytes: compressed.length, maxError: errorBound(pixels, reconstruction, near),
            encodeFirstMs: encode.firstMs, decodeFirstMs: decode.firstMs,
            encodeMedianMs: encode.medianMs, decodeMedianMs: decode.medianMs,
          };
        }
        records.push(report);
      }
    }
  } finally {
    oracle.close();
  }
  return { coldLoadMs: { js: js.loadMs, 'wasm-gc': wasm.loadMs, 'charls-wasm': oracleLoadMs }, records };
}

const [mode, ...args] = process.argv.slice(2);
let result;
if (mode === 'resource') {
  const [backend, operation, file, w, h, inChunk, outChunk, pause] = args;
  result = await resource(backend, operation, file, Number(w), Number(h), Number(inChunk), Number(outChunk), pause === 'pause');
} else if (mode === 'effect') {
  const [folder, repeats] = args;
  result = await effect(folder, Number(repeats));
} else {
  throw new Error('Usage: node scripts/bench_node.mjs resource BACKEND OPERATION FILE WIDTH HEIGHT IN_CHUNK OUT_CHUNK [pause] | effect FOLDER REPEATS');
}
console.log(JSON.stringify({ node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, memoryBytes: totalmem(), ...result }));
