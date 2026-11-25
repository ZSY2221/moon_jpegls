import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { decodeImage, encodeImage, loadCore } from '../sdk/index.mjs';
import { lunarErrorMeters, lunarFixture, lunarMetadataFor } from '../sdk/lunar.mjs';
import { buildIdentity } from '../sdk/report-node.mjs';
import { codecMeasurements, createRunId, createVerificationReport, serializeVerificationReport } from '../sdk/verification-report.mjs';

const { values: args } = parseArgs({ options: {
  input: { type: 'string', default: '.evidence/real/lola.pgm' },
  output: { type: 'string', default: '.evidence/lunar-budget-20261125' },
  summary: { type: 'string' },
} });
const inputPath = resolve(args.input);
const outputDir = resolve(args.output);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
assert.equal((await stat(inputPath)).size, lunarFixture.pgmBytes, 'Expected the pinned NASA PGM length');
const source = await readFile(inputPath);
const inputSha256 = sha256(source);
const provenance = lunarMetadataFor({ sha256: inputSha256, bytes: source.length, format: 'pgm' });
assert.ok(provenance, 'Expected the pinned NASA PGM SHA-256');
const { width, height, bits } = provenance;
const samples = new Uint16Array(width * height);
const rawBytes = samples.byteLength;
const headerBytes = source.length - rawBytes;
for (let i = 0; i < samples.length; i++) samples[i] = source.readUInt16BE(headerBytes + 2 * i);

const limits = { maxWidth: 65_535, maxHeight: 65_535, maxPixels: 100_000_000, maxMetadataBytes: 1_048_576 };
const options = { inputChunkSize: 32 * 1024, outputChunkSize: 32 * 1024, limits };
const boundary = 'SDK whole-image encode, strict decode and full-sample comparison. Input read, core load, hashing and artifact writes are outside the timer.';
const rows = [];
await mkdir(outputDir, { recursive: true });

for (const backend of ['js', 'wasm-gc']) {
  const [core, identity] = await Promise.all([loadCore({ backend }), buildIdentity(backend)]);
  for (const near of [0, 1, 2, 3]) {
    const runId = createRunId();
    const frame = { width, height, bits, near };
    const begin = performance.now();
    const encoded = await encodeImage(core, frame, samples, options);
    const afterEncode = performance.now();
    const decoded = await decodeImage(core, encoded.bytes, { ...options, trailing: 'reject' });
    const afterDecode = performance.now();
    assert.deepEqual(decoded.frame, frame);
    assert.equal(encoded.stats.inputConsumed, samples.length);
    assert.equal(decoded.stats.inputConsumed, encoded.bytes.byteLength);
    assert.equal(decoded.stats.rows, height);
    assert.equal(decoded.samples.length, samples.length);
    let maxError = 0;
    let maxErrorIndex = 0;
    for (let i = 0; i < samples.length; i++) {
      const error = Math.abs(samples[i] - decoded.samples[i]);
      if (error > maxError) {
        maxError = error;
        maxErrorIndex = i;
      }
    }
    assert.ok(maxError <= near, `Observed ${maxError} sample counts at NEAR=${near}`);
    const afterCompare = performance.now();
    const physical = {
      unit: 'm', quantity: 'codec_added_elevation_error',
      errorBound: lunarErrorMeters(near), maxError: lunarErrorMeters(maxError),
    };
    const jlsSha256 = sha256(encoded.bytes);
    const reconstructed = Buffer.alloc(source.length);
    source.copy(reconstructed, 0, 0, headerBytes);
    for (let i = 0; i < samples.length; i++) reconstructed.writeUInt16BE(decoded.samples[i], headerBytes + 2 * i);
    const reconstructedSha256 = sha256(reconstructed);
    const evidenceDir = join(outputDir, `${backend}-near${near}-${runId}`);
    await mkdir(evidenceDir);
    await Promise.all([
      writeFile(join(evidenceDir, 'lola.jls'), encoded.bytes, { flag: 'wx' }),
      writeFile(join(evidenceDir, 'lola.reconstructed.pgm'), reconstructed, { flag: 'wx' }),
    ]);

    const report = createVerificationReport({
      runId, host: 'fixture-runner', backend, ...identity,
      input: { name: basename(inputPath), format: 'pgm', bytes: source.length, sha256: inputSha256, provenance },
      output: { name: 'lola.jls', format: 'jls', bytes: encoded.bytes.byteLength, sha256: jlsSha256, retained: true, complete: true },
      frame,
      stages: { encode: 'passed', decode: 'passed', compare: 'passed' },
      samples: { verified: samples.length, maxError },
      status: 'passed',
      timing: { boundary, elapsedMs: afterCompare - begin, encodeMs: afterEncode - begin,
        decodeMs: afterDecode - afterEncode, compareMs: afterCompare - afterDecode },
      memory: { encode: codecMeasurements(encoded.stats, 'sdk'), decode: codecMeasurements(decoded.stats, 'sdk') },
      stream: { rowsDecoded: decoded.stats.rows, rowsDelivered: decoded.stats.rows, provisionalRows: 0, firstRowMs: decoded.stats.firstRowMs,
        firstRowInputConsumed: decoded.stats.firstRowInputConsumed, trailingPolicy: 'reject', strictEoi: true },
      limits: { ...limits, inputChunkSize: options.inputChunkSize, outputChunkSize: options.outputChunkSize },
      physical,
      unexecuted: ['native', 'browser', 'worker', 'process_rss'],
    });
    await writeFile(join(evidenceDir, 'verification.json'), serializeVerificationReport(report), { flag: 'wx' });
    const maxErrorPixel = {
      x: maxErrorIndex % width, y: Math.floor(maxErrorIndex / width),
      original: samples[maxErrorIndex], reconstructed: decoded.samples[maxErrorIndex],
    };
    const entry = { report, reconstructedSha256, rawSamplesToJlsRatio: rawBytes / encoded.bytes.byteLength, maxErrorPixel };
    rows.push(entry);
    console.log(JSON.stringify({ backend, near, runId, jlsBytes: encoded.bytes.byteLength, maxError, maxErrorMeters: physical.maxError, evidenceDir }));
  }
}

for (const [js, wasm] of rows.slice(0, 4).map((entry, i) => [entry, rows[i + 4]])) {
  assert.equal(js.report.output.sha256, wasm.report.output.sha256);
  assert.equal(js.reconstructedSha256, wasm.reconstructedSha256);
}
const summary = { fixture: provenance, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  sameJlsAndReconstructionAcrossBackends: true, rows };
const summaryPath = resolve(args.summary ?? join(outputDir, `summary-${createRunId()}.json`));
await mkdir(dirname(summaryPath), { recursive: true });
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
console.log(summaryPath);
