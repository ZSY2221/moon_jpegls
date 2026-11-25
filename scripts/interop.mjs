import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOracle, readRaw, writeRaw } from './oracle.mjs';
import { CodecError, decodeImage, decodeStream, encodeImage, encodeStream, loadCore } from '../sdk/index.mjs';

function checkSamples(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, `${label}: sample count`);
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      throw new Error(`${label}: sample ${i}, got ${actual[i]} vs ${expected[i]}, limit ${tolerance}`);
    }
  }
}

function reader(input, options) {
  let offset = 0;
  let seed = options.seed >>> 0;
  let sawEmpty = false;
  return async (maximum) => {
    if (options.empty && !sawEmpty) {
      sawEmpty = true;
      return input.subarray(0, 0);
    }
    if (offset === input.length) return null;
    let size = maximum;
    if (options.split > offset) size = Math.min(size, options.split - offset);
    if (seed) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      size = Math.min(size, 1 + (seed >>> 0) % size);
    }
    const chunk = input.subarray(offset, offset + size);
    offset += chunk.length;
    return chunk;
  };
}

async function encode(core, frame, pixels, options = {}) {
  const blocks = [];
  const { stats } = await encodeStream(core, {
    frame,
    read: reader(pixels, options),
    inputChunkSize: options.chunk ?? 4096,
    outputChunkSize: options.output ?? 4096,
    onBytes: async (bytes) => blocks.push(Buffer.from(bytes))
  });
  assert.equal(stats.inputConsumed, pixels.length, 'encoder input consumption');
  const result = Buffer.concat(blocks);
  assert.equal(stats.outputProduced, result.length, 'encoder output production');
  return result;
}

async function decode(core, stream, options = {}) {
  const rows = [];
  let frame;
  const { stats } = await decodeStream(core, {
    read: reader(stream, options),
    inputChunkSize: options.chunk ?? 4096,
    limits: options.limits,
    trailing: options.trailing ?? 'reject',
    onRow: async (row, i, metadata) => {
      assert.ok(row instanceof Uint16Array, 'original integer samples must remain uint16');
      assert.equal(i, rows.length, 'row numbering');
      if (frame) assert.equal(row.length, frame.width, 'row width');
      frame = metadata;
      rows.push(row.slice());
    }
  });
  assert.ok(frame, 'frame metadata');
  assert.equal(rows.length, frame.height, 'row count');
  if (!options.trailing) assert.equal(stats.inputConsumed, stream.length, 'decoder input consumption');
  const pixels = new Uint16Array(frame.width * frame.height);
  for (let i = 0; i < rows.length; i++) pixels.set(rows[i], i * frame.width);
  return { pixels, frame, stats };
}

function compareFrame(actual, expected) {
  for (const key of ['width', 'height', 'bits', 'near']) assert.equal(actual[key], expected[key], key);
}

function compareBytes(actual, expected, label) {
  if (Buffer.compare(actual, expected) === 0) return;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
    if (actual[i] !== expected[i]) throw new Error(`${label}: byte ${i}, got ${actual[i]} vs ${expected[i]}`);
  }
  throw new Error(`${label}: byte size ${actual.length} vs ${expected.length}`);
}

export function scanStart(stream) {
  for (let i = 2; i + 3 < stream.length;) {
    assert.equal(stream[i], 255, 'expected marker');
    const segmentLength = (stream[i + 2] << 8) | stream[i + 3];
    if (stream[i + 1] === 0xda) return i + 2 + segmentLength;
    i += segmentLength + 2;
  }
  throw new Error('Missing SOS');
}

function withPreset(stream, values) {
  const segment = Buffer.alloc(15);
  segment.set([0xff, 0xf8, 0x00, 0x0d, 1]);
  values.forEach((value, i) => segment.writeUInt16BE(value, 5 + 2 * i));
  const position = scanStart(stream) - 10;
  assert.equal(stream[position + 1], 0xda);
  return Buffer.concat([stream.subarray(0, position), segment, stream.subarray(position)]);
}

function withMarker(stream, marker, payload) {
  const header = Buffer.of(0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255);
  return Buffer.concat([stream.subarray(0, 2), header, payload, stream.subarray(2)]);
}

async function holdSink(core, frame, pixels, compressed, abort) {
  const controller = new AbortController();
  const { promise: entered, resolve: enter } = Promise.withResolvers();
  const { promise: waiting, resolve: resume } = Promise.withResolvers();
  let reads = 0;
  let writes = 0;
  let pendingBytes = 0;
  let completed = false;
  const read = reader(compressed ? compressed : pixels, {});
  const write = async (data) => {
    writes++;
    if (writes === 1) {
      pendingBytes = data.byteLength;
      enter();
      await waiting;
    }
  };
  const options = {
    inputChunkSize: 7,
    signal: controller.signal,
    read: async (maximum) => {
      reads++;
      return read(maximum);
    }
  };
  const result = compressed
    ? decodeStream(core, { ...options, onRow: write })
    : encodeStream(core, { ...options, frame, outputChunkSize: 1, onBytes: write });
  const outcome = result.then(
    (value) => ({ value }),
    (error) => ({ error })
  ).finally(() => { completed = true; });
  await Promise.race([entered, outcome.then(({ error }) => { throw error ?? new Error('sink did not receive output'); })]);
  const readCountAtPause = reads;
  await delay(15);
  let final;
  try {
    assert.equal(reads, readCountAtPause, 'paused sink stops upstream reads');
    assert.equal(writes, 1, 'paused sink stops writes');
    assert.equal(completed, false, 'paused stream must be pending');
    if (abort) {
      controller.abort();
      final = await Promise.race([
        outcome,
        delay(1000, null, { ref: false }).then(() => { throw new Error('cancellation is blocked on the paused sink'); })
      ]);
    }
  } finally {
    resume();
  }
  const { error, value } = final ?? await outcome;
  if (abort) {
    assert.equal(error?.code, 'Cancelled', 'abort must end the operation with a typed cancellation');
    assert.equal(reads, readCountAtPause, 'abort does not read again');
    assert.equal(writes, 1, 'abort does not deliver output again');
  } else {
    assert.ifError(error);
    assert.ok(writes > 1, 'resume must deliver remaining output');
  }
  return { pendingBytes, stats: value };
}

function errorLabel(error) {
  return [error.name, error.code, error.kind, error.message].filter(Boolean).join(' ');
}

async function invalidTests(core, initial, directory, label, counts) {
  const source = Buffer.from(initial);
  const nonJls = Buffer.from(source);
  nonJls[3] = 0xc0;
  const zeroHeight = Buffer.from(source);
  zeroHeight.writeUInt16BE(0, 7);
  const large = Buffer.from(source);
  large.writeUInt16BE(65535, 7);
  large.writeUInt16BE(65535, 9);
  const unsupportedPrecision = Buffer.from(source);
  unsupportedPrecision[6] = 9;
  const illegalNear = Buffer.from(source);
  illegalNear[scanStart(source) - 3] = 128;
  const badLength = Buffer.from(source);
  badLength.writeUInt16BE(1, 4);
  const badEnd = Buffer.from(source);
  badEnd[badEnd.length - 1] = 0xc0;
  const invalid = [
    ['wrong-soi', Buffer.concat([Buffer.of(0), source.subarray(1)]), 'InvalidData'],
    ['zero-segment-length', badLength, 'InvalidData'],
    ['non-jpegls-frame', nonJls, 'UnsupportedFeature'],
    ['missing-eoi', source.subarray(0, source.length - 1), 'Truncated'],
    ['wrong-eoi', badEnd, 'InvalidData'],
    ['unsupported-dnl', zeroHeight, 'UnsupportedFeature'],
    ['unsupported-precision-nine', unsupportedPrecision, 'UnsupportedFeature'],
    ['invalid-near-128', illegalNear, 'InvalidData'],
    ['invalid-preset-thresholds', withPreset(source, [255, 8, 3, 21, 64]), 'InvalidData'],
    ['unsupported-preset-thresholds', withPreset(source, [255, 4, 8, 21, 64]), 'UnsupportedFeature'],
    ['dimension-budget', large, 'ResourceLimit'],
    ['metadata-budget', withMarker(source, 0xe1, Buffer.of(1, 2)), 'ResourceLimit', { maxMetadataBytes: 5 }],
    ['tail-by-default', Buffer.concat([source, Buffer.of(1, 2)]), 'TrailingData']
  ];
  for (const [name, bytes, expected, limits] of invalid) {
    await writeFile(join(directory, `${label}-${name}.jls`), bytes);
    await assert.rejects(decode(core, bytes, { chunk: 1, limits }), { code: expected }, `${label} ${name}`);
    counts.negativeStructures++;
  }
  const tailResult = await decode(core, Buffer.concat([source, Buffer.of(0, 255, 216)]), { trailing: 'allow' });
  assert.equal(tailResult.stats.inputConsumed, source.length, 'EOI stops before trailing bytes');
  counts.trailingAllow++;
}

async function attemptMutation(decodeTrial, isExpectedRejection) {
  try {
    const image = await decodeTrial();
    return { image, observation: { outcome: 'accepted', frame: image.frame } };
  } catch (error) {
    if (!isExpectedRejection(error)) throw error;
    return { observation: { outcome: 'rejected', name: error.name, code: error.code, message: error.message } };
  }
}

async function mutationTests(core, oracle, source, directory, backend, counts, seed) {
  let entropySeed = seed >>> 0;
  const start = scanStart(source);
  const chunk = 3;
  const trials = [];
  const corpus = {
    source: 'split-16bit-near3.jls',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    seed, backend, inputChunkSize: chunk, oracle: '@team-charls/charls-wasm 0.10.0'
  };
  for (let i = 0; i < 48; i++) {
    const changed = Buffer.from(source);
    entropySeed = (Math.imul(entropySeed, 1664525) + 1013904223) >>> 0;
    const offset = start + entropySeed % (changed.length - start - 2);
    const bit = entropySeed >>> 29;
    changed[offset] ^= 1 << bit;
    const trial = {
      index: i, entropySeed, offset, bit, originalByte: source[offset], mutatedByte: changed[offset],
      sha256: createHash('sha256').update(changed).digest('hex')
    };
    let moon;
    let reference;
    let classification = 'unexpected-moonjls-error';
    try {
      // Structural rejection codes for this fixed entropy-only corpus.
      moon = await attemptMutation(
        () => decode(core, changed, { chunk }),
        (error) => error instanceof CodecError && error.code === 'InvalidData'
      );
      trial.moonjls = moon.observation;
      classification = 'unexpected-charls-error';
      reference = await attemptMutation(
        () => oracle.decode(changed),
        (error) => error?.name === 'JpegLSError' && error.code === 5
      );
      trial.charls = reference.observation;
      classification = 'unadjudicated-acceptance-disagreement';
      assert.equal(moon.observation.outcome, reference.observation.outcome, `${backend} mutation ${i}: acceptance disagreement`);
      if (moon.image) {
        classification = 'reconstruction-mismatch';
        compareFrame(moon.image.frame, reference.image.frame);
        checkSamples(moon.image.pixels, reference.image.pixels, 0, `${backend} mutation ${i} reference reconstruction`);
        trial.reconstructedSamples = Array.from(moon.image.pixels);
        counts.entropyMutationAccepted++;
        trial.classification = 'matched-reconstruction';
      } else {
        counts.entropyMutationRejected++;
        trial.classification = 'matched-structural-rejection';
      }
      trials.push(trial);
    } catch (error) {
      const stem = `${backend}-failed-mutation-${i}`;
      await writeFile(join(directory, `${stem}.jls`), changed);
      const failure = {
        ...corpus, ...trial, classification, stream: `${stem}.jls`,
        error: { name: error?.name, code: error?.code, message: error?.message ?? String(error) },
        moonjlsSamples: moon?.image ? Array.from(moon.image.pixels) : undefined,
        charlsSamples: reference?.image ? Array.from(reference.image.pixels) : undefined
      };
      await writeFile(join(directory, `${stem}.json`), `${JSON.stringify(failure, null, 2)}\n`);
      throw new Error(`${backend} mutation ${i}: ${classification}, see ${stem}.json`, { cause: error });
    }
  }
  const report = `${backend}-entropy-mutations.json`;
  await writeFile(join(directory, report), `${JSON.stringify({ ...corpus, trials }, null, 2)}\n`);
  counts.entropyMutationReports.push(report);
}

async function main(directory, backends) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const counts = {
    images: manifest.cases.length, encodes: 0, sameStreamComparisons: 0,
    backendByteMatches: 0, outputQuantumByteMatches: 0, allSingleCuts: 0, wholeImageMatches: 0, truncationPrefixes: 0,
    supportedOfficial: 0, unsupportedOfficial: 0, explicitPresetVariants: 0,
    pauseResume: 0, cancellation: 0, negativeStructures: 0, trailingAllow: 0,
    entropyMutationAccepted: 0, entropyMutationRejected: 0, entropyMutationDistinctInputs: 48, entropyMutationReports: []
  };
  let mostStuffed = { entropyFF: 0, entropyBytes: 0 };
  const loaded = new Map();
  for (const backend of backends) loaded.set(backend, await loadCore({ backend }));
  const oracle = await createOracle();
  try {
    for (const frame of manifest.cases) {
      const { name, bits, near } = frame;
      const pixels = readRaw(await readFile(join(directory, `${name}.raw`)));
      const external = Buffer.from(oracle.encode(pixels, frame, 4));
      const start = scanStart(external);
      const entropy = external.subarray(start, -2);
      const entropyFF = entropy.reduce((sum, byte) => sum + (byte === 255), 0);
      if (entropyFF > mostStuffed.entropyFF) mostStuffed = { name, entropyFF, entropyBytes: entropy.length };
      await writeFile(join(directory, `${name}.charls-wasm.jls`), external);

      const streams = new Map([['charls-wasm', external]]);
      if (frame.charlsWasmImplicit) {
        const implicit = Buffer.from(oracle.encode(pixels, frame, 0));
        assert.equal(scanStart(external) - scanStart(implicit), 15, `${name} explicit LSE marker size`);
        await writeFile(join(directory, `${name}.charls-wasm-implicit.jls`), implicit);
        streams.set('charls-wasm-implicit', implicit);
      }
      if (bits !== 12) streams.set('native', await readFile(join(directory, `${name}.native.jls`)));
      let prior;
      for (const [backend, core] of loaded) {
        const baseline = await encode(core, frame, pixels);
        await writeFile(join(directory, `${name}.${backend}.jls`), baseline);
        const whole = await encodeImage(core, frame, pixels);
        compareBytes(Buffer.from(whole.bytes), baseline, `${name}/${backend} whole-image encode`);
        counts.wholeImageMatches++;
        const splitOptions = { chunk: manifest.nearMatrix ? 1 : 23, output: manifest.nearMatrix ? 1 : 3,
          seed: manifest.seed, empty: true };
        const split = await encode(core, frame, pixels, splitOptions);
        if (!baseline.equals(split)) await writeFile(join(directory, `${name}.${backend}.split.jls`), split);
        compareBytes(split, baseline, `${name}/${backend} output/input quantum`);
        counts.outputQuantumByteMatches++;
        counts.encodes += 2;
        if (prior) {
          compareBytes(prior, baseline, `${name} backend bytes`);
          counts.backendByteMatches++;
        }
        prior = baseline;
        streams.set(backend, baseline);
      }

      for (const [source, stream] of streams) {
        const reference = oracle.decode(stream);
        compareFrame(reference.frame, frame);
        checkSamples(reference.pixels, pixels, near, `${name}/${source} reference precision`);
        for (const [backend, core] of loaded) {
          const chunk = manifest.nearMatrix || name.includes('stuffing-runs') ? 1 : 37;
          const got = await decode(core, stream, { chunk, seed: manifest.seed, empty: true });
          const output = join(directory, `${name}.${source}.${backend}.raw`);
          await writeFile(output, writeRaw(got.pixels));
          compareFrame(got.frame, frame);
          checkSamples(got.pixels, reference.pixels, 0, `${name}/${source}/${backend} reference reconstruction`);
          checkSamples(got.pixels, pixels, near, `${name}/${source}/${backend} precision`);
          counts.sameStreamComparisons++;
          if (source === 'charls-wasm') {
            const whole = await decodeImage(core, stream);
            checkSamples(whole.samples, got.pixels, 0, `${name}/${backend} whole-image decode`);
            counts.wholeImageMatches++;
          }
        }
      }
    }

    for (const [backend, core] of loaded) {
      const pixels = Uint16Array.of(0, 32767, 32768, 65535, 65535, 12, 65520, 0, 0, 0, 0, 0, 0, 0, 65535, 65535, 2, 0, 0, 0, 0, 0);
      const frame = { width: 11, height: 2, bits: 16, near: 3 };
      const stream = Buffer.from(oracle.encode(pixels, frame, 4));
      const expected = oracle.decode(stream).pixels;
      await writeFile(join(directory, 'split-16bit-near3.jls'), stream);
      for (let cut = 1; cut < stream.length; cut++) {
        checkSamples((await decode(core, stream, { split: cut, empty: true })).pixels, expected, 0, `${backend} cut ${cut}`);
        counts.allSingleCuts++;
      }
      for (let cut = 0; cut < stream.length; cut++) {
        await assert.rejects(decode(core, stream.subarray(0, cut), { chunk: 3 }), { code: 'Truncated' }, `${backend} truncate at ${cut}`);
        counts.truncationPrefixes++;
      }
      const implicit = Buffer.from(oracle.encode(pixels, frame, 0));
      const zeroLse = withPreset(implicit, [0, 0, 0, 0, 0]);
      for (const variant of [implicit, zeroLse]) {
        checkSamples(oracle.decode(variant).pixels, expected, 0, 'CharLS high-precision LSE equivalence');
        checkSamples((await decode(core, variant, { chunk: 1 })).pixels, expected, 0, `${backend} high-precision LSE equivalence`);
        counts.explicitPresetVariants++;
      }
      for (const abort of [false, true]) {
        await holdSink(core, frame, pixels, null, abort);
        await holdSink(core, frame, pixels, stream, abort);
        counts[abort ? 'cancellation' : 'pauseResume'] += 2;
      }

      const gray = Uint16Array.of(0, 220, 15, 15, 1, 0, 15, 3);
      const grayFrame = { width: 4, height: 2, bits: 8, near: 0 };
      const plain = Buffer.from(oracle.encode(gray, grayFrame));
      for (const values of [[0, 0, 0, 0, 0], [255, 3, 7, 21, 64]]) {
        const modified = withPreset(plain, values);
        checkSamples(oracle.decode(modified).pixels, gray, 0, 'CharLS explicit LSE equivalence');
        checkSamples((await decode(core, modified, { chunk: 1 })).pixels, gray, 0, `${backend} explicit LSE equivalence`);
        counts.explicitPresetVariants++;
      }
      const metadata = withMarker(withMarker(plain, 0xe1, Buffer.of(0xff, 0xd9, 0xe0)), 0xfe, Buffer.from('comment'));
      checkSamples((await decode(core, metadata, { chunk: 1 })).pixels, gray, 0, `${backend} bounded metadata skips`);
      await invalidTests(core, plain, directory, backend, counts);
      await mutationTests(core, oracle, stream, directory, backend, counts, manifest.seed);

      for (const item of manifest.conformance) {
        const official = await readFile(join(directory, item.name));
        if (item.expected === 'valid') {
          const result = await decode(core, official, { chunk: 103, seed: manifest.seed });
          const reference = readRaw(await readFile(join(directory, `${item.name}.raw`)));
          assert.equal(result.frame.near, item.near, item.name);
          checkSamples(result.pixels, reference, 0, item.name);
          counts.supportedOfficial++;
        } else {
          await assert.rejects(decode(core, official, { chunk: 29 }), (error) => /unsupported/i.test(errorLabel(error)), item.name);
          counts.unsupportedOfficial++;
        }
      }
    }
  } finally {
    oracle.close();
  }
  if (manifest.cases.some(({ name }) => name.includes('stuffing-runs'))) assert.ok(mostStuffed.entropyFF >= 4, 'stuffing fixture must generate FF');
  process.stdout.write(`${JSON.stringify({ ...counts, mostStuffed, node: process.version, wasmOracle: '@team-charls/charls-wasm 0.10.0' })}\n`);
}

const [directory, ...backends] = process.argv.slice(2);
await access(join(directory, 'manifest.json'));
await main(directory, backends);
