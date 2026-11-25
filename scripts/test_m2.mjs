import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeImage, encodeImage, loadCore } from '../sdk/index.mjs';

const [directory] = process.argv.slice(2);
const suite = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const chunked = { inputChunkSize: 1, outputChunkSize: 1 };
const read = (file) => readFile(join(directory, file));

function readSamples(bytes) {
  assert.equal(bytes.length % 2, 0, 'fixture samples use uint16le');
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16LE(2 * i));
}

function asBytes(samples) {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => output.writeUInt16LE(sample, 2 * i));
  return output;
}

function verifyFrame(result, expected, effectivePreset, label) {
  const { frame: decoded, preset } = result;
  for (const field of ['width', 'height', 'bits', 'near']) {
    assert.equal(decoded[field], expected[field], `${label}: ${field}`);
  }
  if (expected.maxval !== undefined) {
    assert.equal(decoded.maxval ?? ((1 << decoded.bits) - 1), expected.maxval, `${label}: MAXVAL`);
  }
  assert.deepEqual(preset, effectivePreset, `${label}: effective preset`);
  if (expected.preset !== undefined) assert.deepEqual(decoded.preset, expected.preset, `${label}: custom preset`);
}

function compareSamples(actual, expected, maxDifference, label) {
  assert.equal(actual.length, expected.length, `${label}: sample count`);
  let maximum = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    if (difference > maxDifference) {
      throw new Error(`${label}: index ${i}, got ${actual[i]}, expected ${expected[i]}, limit ${maxDifference}`);
    }
    maximum = Math.max(maximum, difference);
  }
  return maximum;
}

const results = [];
for (const backend of ['js', 'wasm-gc']) {
  const core = await loadCore({ backend });
  for (const caseSpec of suite.cases) {
    const { id, frame, expected, effectivePreset, input, reference, referenceSamples } = caseSpec;
    const label = `${backend}/${id}`;
    try {
      const original = readSamples(await read(input));
      const expectedSamples = readSamples(await read(referenceSamples));
      const encoded = Buffer.from((await encodeImage(core, frame, original)).bytes);
      const split = Buffer.from((await encodeImage(core, frame, original, chunked)).bytes);
      assert.ok(encoded.equals(split), `${label}: byte-identical encode quanta`);
      await writeFile(join(directory, `${id}.${backend}.jls`), encoded);

      const rebuilt = await decodeImage(core, encoded, chunked);
      verifyFrame(rebuilt, expected, effectivePreset, label);
      const maximum = compareSamples(rebuilt.samples, original, frame.near, `${label}: round trip`);
      const rebuiltBytes = asBytes(rebuilt.samples);
      await writeFile(join(directory, `${id}.${backend}.raw`), rebuiltBytes);

      const inputStream = await read(reference);
      const external = await decodeImage(core, inputStream, chunked);
      const normal = await decodeImage(core, inputStream);
      verifyFrame(external, expected, effectivePreset, `${label}/reference`);
      compareSamples(external.samples, expectedSamples, 0, `${label}: reference reconstruction`);
      compareSamples(normal.samples, expectedSamples, 0, `${label}: normal decode quantum`);
      results.push({
        id, backend, bytes: encoded.length, streamSha256: sha256(encoded),
        reconstructionSha256: sha256(rebuiltBytes), maxAbsoluteError: maximum,
      });
    } catch (error) {
      throw new Error(`${label}: ${error.message}`, { cause: error });
    }
  }

  for (const trial of suite.variants) {
    const { id, input, expectedCode, expected, effectivePreset, referenceSamples } = trial;
    const stream = await read(input);
    if (expectedCode) {
      await assert.rejects(decodeImage(core, stream, chunked), { code: expectedCode }, `${backend}/${id}`);
      results.push({ id, backend, code: expectedCode });
    } else {
      const decoded = await decodeImage(core, stream, chunked);
      verifyFrame(decoded, expected, effectivePreset, `${backend}/${id}`);
      compareSamples(decoded.samples, readSamples(await read(referenceSamples)), 0, `${backend}/${id}`);
      results.push({ id, backend, reconstructionSha256: sha256(asBytes(decoded.samples)) });
    }
  }

  for (const { id, frame, sample, expectedCode } of suite.invalidEncodes) {
    await assert.rejects(async () => encodeImage(core, frame, Uint16Array.of(sample), chunked),
      { code: expectedCode }, `${backend}/${id}`);
    results.push({ id, backend, code: expectedCode });
  }
}

await writeFile(join(directory, 'sdk-results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify({ node: process.version, comparisons: results.length }));
