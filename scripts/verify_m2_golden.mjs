import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImage, encodeImage, loadCore } from '../sdk/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixtureDir = join(root, 'tests', 'conformance', 'm2_golden');
const usage = 'Usage: node scripts/verify_m2_golden.mjs [--native-exe FILE [--native-wsl DISTRO]]';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readFixture = (name) => readFile(join(fixtureDir, name));
const chunked = { inputChunkSize: 1, outputChunkSize: 1 };
const FIELDS = ['maxval', 't1', 't2', 't3', 'reset'];

function parseArgs(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2);
    if (!['--native-exe', '--native-wsl'].includes(flag) || !value || options.has(flag)) {
      throw new Error(usage);
    }
    options.set(flag, value);
  }
  if (options.has('--native-wsl') && !options.has('--native-exe')) {
    throw new Error(usage);
  }
  return options;
}

function runChild(command, args, { input, allowEarlyInputClose = false } = {}) {
  const result = spawnSync(command, args, { timeout: 30_000, input });
  // A rejected input can close stdin before Node finishes feeding it.
  // Preserve its exit status and diagnostics for the caller's rejection assertions.
  const rejectedBeforeReading = allowEarlyInputClose && result.error?.code === 'EPIPE' && result.status > 0;
  if (result.error && !rejectedBeforeReading) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8').trimEnd(),
  };
}

function createNativeRunner(file, distro) {
  const binary = resolve(file);
  if (!distro) {
    return {
      binary,
      run: (args, input, allowEarlyInputClose) => runChild(binary, args, { input, allowEarlyInputClose }),
    };
  }
  const baseArgs = ['--distribution', distro, '--exec'];
  const converted = runChild('wsl.exe', [...baseArgs, 'wslpath', '-a', '-u', binary]);
  assert.equal(converted.status, 0, converted.stderr);
  const wslBinary = converted.stdout.toString('utf8').trim();
  return {
    binary,
    run: (args, input, allowEarlyInputClose) =>
      runChild('wsl.exe', [...baseArgs, wslBinary, ...args], { input, allowEarlyInputClose }),
  };
}

function readSamplesLe(bytes) {
  assert.equal(bytes.length % 2, 0, 'Golden raw samples must be uint16le');
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16LE(i * 2));
}

function nativeRaw(samples, bits) {
  if (bits <= 8) return Buffer.from(samples);
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeUInt16LE(samples[i], i * 2);
  return out;
}

function unpackNativeRaw(bytes, bits) {
  if (bits <= 8) return Uint16Array.from(bytes);
  assert.equal(bytes.length % 2, 0, 'Expected uint16le Native raw output');
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16LE(i * 2));
}

function pgmBytes(samples, width, height, maxval) {
  const header = Buffer.from(`P5\n${width} ${height}\n${maxval}\n`, 'ascii');
  if (maxval <= 255) return Buffer.concat([header, Buffer.from(samples)]);
  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) body.writeUInt16BE(samples[i], i * 2);
  return Buffer.concat([header, body]);
}

function cliPresetFlags(frame) {
  const flags = [];
  if (frame.maxval !== undefined) flags.push('--maxval', String(frame.maxval));
  if (frame.preset) {
    for (const key of ['t1', 't2', 't3', 'reset']) {
      if (frame.preset[key] !== undefined) flags.push(`--${key}`, String(frame.preset[key]));
    }
  }
  return flags;
}

function verifyFrame(decoded, expected, effectivePreset, label) {
  for (const field of ['width', 'height', 'bits', 'near']) {
    assert.equal(decoded.frame[field], expected[field], `${label}: frame.${field}`);
  }
  const actualMaxval = decoded.frame.maxval ?? (2 ** decoded.frame.bits - 1);
  assert.equal(actualMaxval, expected.maxval, `${label}: frame.maxval`);
  assert.deepEqual(decoded.preset, effectivePreset, `${label}: effectivePreset`);
  if (expected.preset !== undefined) {
    assert.deepEqual(decoded.frame.preset, expected.preset, `${label}: custom preset`);
  }
}

function compareSamples(actual, expected, maxError, label) {
  assert.equal(actual.length, expected.length, `${label}: sample count`);
  let observedMax = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    assert.ok(delta <= maxError, `${label}: sample ${i} (${actual[i]} vs ${expected[i]}, limit ${maxError})`);
    if (delta > observedMax) observedMax = delta;
  }
  return observedMax;
}

function verifyMarkersHeader(stream, expectedFrame, expectedPreset, label) {
  assert.equal(stream[0], 0xff);
  assert.equal(stream[1], 0xd8);
  let pos = 2;
  let parsedFrame = null;
  let overrides = [0, 0, 0, 0, 0];
  while (pos + 4 <= stream.length) {
    assert.equal(stream[pos], 0xff, `${label}: marker prefix at ${pos}`);
    const code = stream[pos + 1];
    const len = stream.readUInt16BE(pos + 2);
    const end = pos + 2 + len;
    assert.ok(len >= 2 && end <= stream.length, `${label}: segment length`);
    const payload = stream.subarray(pos + 4, end);
    if (code === 0xf7) {
      parsedFrame = {
        bits: payload[0],
        height: payload.readUInt16BE(1),
        width: payload.readUInt16BE(3),
      };
    } else if (code === 0xf8 && payload[0] === 1) {
      overrides = FIELDS.map((_, idx) => payload.readUInt16BE(1 + idx * 2));
    } else if (code === 0xda) {
      parsedFrame.near = payload[3];
      assert.equal(parsedFrame.bits, expectedFrame.bits, `${label}: PGM encoded SOF55 bits`);
      assert.equal(parsedFrame.width, expectedFrame.width, `${label}: PGM encoded width`);
      assert.equal(parsedFrame.height, expectedFrame.height, `${label}: PGM encoded height`);
      assert.equal(parsedFrame.near, expectedFrame.near, `${label}: PGM encoded near`);
      if (overrides[0] !== 0) {
        assert.equal(overrides[0], expectedPreset.maxval, `${label}: PGM LSE1 maxval`);
      }
      return;
    }
    pos = end;
  }
  assert.fail(`${label}: missing SOS marker`);
}

async function verifyHashes(manifest) {
  let verifiedFiles = 0;
  for (const item of manifest.cases) {
    for (const key of ['input', 'reference', 'referenceSamples']) {
      const filename = item[key];
      const bytes = await readFixture(filename);
      assert.equal(sha256(bytes), item.sha256[filename], `Frozen SHA-256 mismatch for ${filename}`);
      verifiedFiles++;
    }
  }
  for (const variant of manifest.variants) {
    const bytes = await readFixture(variant.input);
    assert.equal(sha256(bytes), variant.sha256, `Frozen SHA-256 mismatch for ${variant.input}`);
    verifiedFiles++;
  }
  return verifiedFiles;
}

function verifyNativeHeader(native, stream, expected, effectivePreset, label) {
  const res = native.run(['verify', '-', '4096', '--json'], stream);
  assert.equal(res.status, 0, `${label}: native verify stderr: ${res.stderr}`);
  const meta = JSON.parse(res.stdout.toString('utf8'));
  for (const field of ['width', 'height', 'bits', 'near', 'maxval']) {
    assert.equal(meta[field], expected[field], `${label}: native verify ${field}`);
  }
  assert.equal(meta.rows, expected.height, `${label}: native verify rows`);
  assert.equal(meta.inputBytes, stream.length, `${label}: native verify inputBytes`);
  assert.deepEqual(meta.preset, effectivePreset, `${label}: native verify preset`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const options = parseArgs(args);
  const manifest = JSON.parse(await readFixture('manifest.json'));
  const verifiedFiles = await verifyHashes(manifest);

  const cores = new Map([
    ['js', await loadCore({ backend: 'js' })],
    ['wasm-gc', await loadCore({ backend: 'wasm-gc' })],
  ]);
  const native = options.has('--native-exe')
    ? createNativeRunner(options.get('--native-exe'), options.get('--native-wsl'))
    : null;

  const caseOutputs = new Map();
  let pgmChecks = 0;

  for (const item of manifest.cases) {
    const { id, frame, expected, effectivePreset } = item;
    const original = readSamplesLe(await readFixture(item.input));
    const refStream = await readFixture(item.reference);
    const refSamples = readSamplesLe(await readFixture(item.referenceSamples));
    let canonicalEncoded = null;

    for (const [backend, core] of cores) {
      const label = `${backend}/${id}`;
      const normalDec = await decodeImage(core, refStream);
      const chunkedDec = await decodeImage(core, refStream, chunked);
      verifyFrame(normalDec, expected, effectivePreset, `${label}/ref-normal`);
      verifyFrame(chunkedDec, expected, effectivePreset, `${label}/ref-chunked`);
      compareSamples(normalDec.samples, refSamples, 0, `${label}/ref-normal`);
      compareSamples(chunkedDec.samples, refSamples, 0, `${label}/ref-chunked`);

      const normalEnc = Buffer.from((await encodeImage(core, frame, original)).bytes);
      const chunkedEnc = Buffer.from((await encodeImage(core, frame, original, chunked)).bytes);
      assert.ok(normalEnc.equals(chunkedEnc), `${label}: chunk-invariant encode bytes`);
      if (canonicalEncoded === null) canonicalEncoded = normalEnc;
      else assert.ok(normalEnc.equals(canonicalEncoded), `${label}: cross-backend encode byte equality`);

      const roundtrip = await decodeImage(core, normalEnc, chunked);
      verifyFrame(roundtrip, expected, effectivePreset, `${label}/roundtrip`);
      compareSamples(roundtrip.samples, original, frame.near, `${label}/roundtrip`);
    }

    if (native) {
      const label = `native/${id}`;
      const rawIn = nativeRaw(original, frame.bits);
      const flags = cliPresetFlags(frame);
      const encArgsNormal = ['encode', String(frame.width), String(frame.height), String(frame.bits), String(frame.near), '-', '-', 'raw-le', '4096', ...flags];
      const encArgsChunk1 = ['encode', String(frame.width), String(frame.height), String(frame.bits), String(frame.near), '-', '-', 'raw-le', '1', ...flags];
      const normRes = native.run(encArgsNormal, rawIn);
      assert.equal(normRes.status, 0, `${label}: encode 4096 failed: ${normRes.stderr}`);
      const splitRes = native.run(encArgsChunk1, rawIn);
      assert.equal(splitRes.status, 0, `${label}: encode 1 failed: ${splitRes.stderr}`);
      assert.ok(normRes.stdout.equals(splitRes.stdout), `${label}: chunk-invariant encode bytes`);
      assert.ok(normRes.stdout.equals(canonicalEncoded), `${label}: Native matches JS/Wasm encoded bytes`);

      for (const decChunk of ['1', '4096']) {
        const decRef = native.run(['decode', '-', '-', 'raw-le', decChunk], refStream);
        assert.equal(decRef.status, 0, `${label}: decode ref (${decChunk}) failed: ${decRef.stderr}`);
        compareSamples(unpackNativeRaw(decRef.stdout, expected.bits), refSamples, 0, `${label}/ref-${decChunk}`);
      }
      const decOwn = native.run(['decode', '-', '-', 'raw-le', '1'], normRes.stdout);
      assert.equal(decOwn.status, 0, `${label}: decode own failed: ${decOwn.stderr}`);
      const ownSamples = unpackNativeRaw(decOwn.stdout, frame.bits);
      compareSamples(ownSamples, original, frame.near, `${label}/roundtrip`);
      verifyNativeHeader(native, refStream, expected, effectivePreset, `${label}/verify`);
      caseOutputs.set(id, { encoded: normRes.stdout, rebuilt: ownSamples, original, item });
    }
  }

  if (native) {
    for (const id of manifest.pgmChecks) {
      const { encoded, rebuilt, original, item } = caseOutputs.get(id);
      const { frame, expected, effectivePreset } = item;
      const expectedPgm = pgmBytes(rebuilt, expected.width, expected.height, effectivePreset.maxval);
      const decPgm = native.run(['decode', '-', '-', 'pgm', '1'], encoded);
      assert.equal(decPgm.status, 0, `native/${id}/pgm decode failed: ${decPgm.stderr}`);
      assert.ok(decPgm.stdout.equals(expectedPgm), `native/${id}/pgm output mismatch`);

      const inputPgm = pgmBytes(original, expected.width, expected.height, effectivePreset.maxval);
      const pgmFlags = cliPresetFlags({ preset: frame.preset });
      const encPgm = native.run(['encode-pgm', String(frame.near), '-', '-', '1', ...pgmFlags], inputPgm);
      assert.equal(encPgm.status, 0, `native/${id}/encode-pgm failed: ${encPgm.stderr}`);
      const expectedBits = Math.max(2, effectivePreset.maxval.toString(2).length);
      verifyMarkersHeader(
        encPgm.stdout,
        { width: expected.width, height: expected.height, bits: expectedBits, near: frame.near },
        effectivePreset,
        `native/${id}/encode-pgm`,
      );
      const decPgmOwn = native.run(['decode', '-', '-', 'raw-le', '1'], encPgm.stdout);
      assert.equal(decPgmOwn.status, 0, `native/${id}/pgm re-decode failed: ${decPgmOwn.stderr}`);
      compareSamples(unpackNativeRaw(decPgmOwn.stdout, expectedBits), rebuilt, 0, `native/${id}/pgm-redecode`);
      pgmChecks++;
    }
  }

  for (const variant of manifest.variants) {
    const stream = await readFixture(variant.input);
    for (const [backend, core] of cores) {
      const label = `${backend}/${variant.id}`;
      if (variant.expectedCode) {
        await assert.rejects(decodeImage(core, stream, chunked), { code: variant.expectedCode }, label);
      } else {
        const refSamples = readSamplesLe(await readFixture(variant.referenceSamples));
        const decoded = await decodeImage(core, stream, chunked);
        verifyFrame(decoded, variant.expected, variant.effectivePreset, label);
        compareSamples(decoded.samples, refSamples, 0, label);
      }
    }
    if (native) {
      const label = `native/${variant.id}`;
      if (variant.expectedCode) {
        const res = native.run(['verify', '-', '1', '--json'], stream, true);
        assert.notEqual(res.status, 0, `${label}: expected failure`);
        assert.equal(res.stdout.length, 0, `${label}: rejected variant emitted stdout`);
        const expectedToken = variant.expectedCode === 'TrailingData' ? 'CommandError.Input' : variant.expectedCode;
        assert.ok(new RegExp(`\\b${expectedToken.replace('.', '\\.')}\\b`).test(res.stderr),
          `${label}: stderr missing ${expectedToken}: ${res.stderr}`);
      } else {
        const refSamples = readSamplesLe(await readFixture(variant.referenceSamples));
        verifyNativeHeader(native, stream, variant.expected, variant.effectivePreset, label);
        const decRes = native.run(['decode', '-', '-', 'raw-le', '1'], stream);
        assert.equal(decRes.status, 0, `${label}: decode failed: ${decRes.stderr}`);
        compareSamples(unpackNativeRaw(decRes.stdout, variant.expected.bits), refSamples, 0, label);
      }
    }
  }

  for (const bad of manifest.invalidEncodes) {
    for (const [backend, core] of cores) {
      await assert.rejects(
        () => encodeImage(core, bad.frame, Uint16Array.of(bad.sample), chunked),
        { code: bad.expectedCode },
        `${backend}/${bad.id}`,
      );
    }
    if (native) {
      const rawIn = nativeRaw(Uint16Array.of(bad.sample), bad.frame.bits);
      const flags = cliPresetFlags(bad.frame);
      const res = native.run(
        ['encode', String(bad.frame.width), String(bad.frame.height), String(bad.frame.bits), String(bad.frame.near), '-', '-', 'raw-le', '1', ...flags],
        rawIn,
        true,
      );
      assert.notEqual(res.status, 0, `native/${bad.id}: expected failure`);
      assert.ok(new RegExp(`\\b${bad.expectedCode}\\b`).test(res.stderr),
        `native/${bad.id}: stderr missing ${bad.expectedCode}: ${res.stderr}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    verifiedFixtureFiles: verifiedFiles,
    cases: manifest.cases.length,
    variants: manifest.variants.length,
    invalidEncodes: manifest.invalidEncodes.length,
    pgmChecks,
    backends: native ? ['js', 'wasm-gc', 'native'] : ['js', 'wasm-gc'],
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
