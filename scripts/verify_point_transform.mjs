import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeStream, decodePlanarImage, encodeImage, encodePlanarImage, loadCore } from '../sdk/index.mjs';
import { createVerificationReport } from '../sdk/verification-report.mjs';
import { createOracle, readRaw, writeRaw } from './oracle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const hashSamples = (data) => hash(writeRaw(data));
const chunks = [1, 7, 4096];
const ptLiteral = Buffer.from(
  'ffd8fff7000b080001000101011100fff8000d01001f0009000f00170040ffda000801010003000220ffd9', 'hex');
const overflowLiteral = (bits) => Buffer.from(
  'ffd8fff7000b' + bits.toString(16).padStart(2, '0') + '0001000101011100ffda00080101000200020006ffd9', 'hex');

function run(command, args, input) {
  const result = spawnSync(command, args, { input, cwd: root, timeout: 30_000 });
  if (result.error) throw result.error;
  return { command: [command, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr.toString().trim() };
}

function marker(bytes, offset) {
  assert.equal(bytes[offset], 255, 'Expected JPEG-LS marker prefix');
  return bytes[offset + 1];
}

// Walk marker lengths outside entropy and skip stuffed FF bytes inside entropy.
function scanHeaders(input) {
  const bytes = Buffer.from(input);
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'SOI');
  const scans = [];
  let bits;
  let maxval = 0;
  let offset = 2;
  while (marker(bytes, offset) !== 0xd9) {
    const code = marker(bytes, offset);
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    if (code === 0xf7) bits = bytes[offset + 4];
    if (code === 0xf8 && bytes[offset + 4] === 1) maxval = bytes.readUInt16BE(offset + 5);
    if (code !== 0xda) {
      offset = end;
      continue;
    }
    const field = end - 1;
    offset = end;
    while (offset < bytes.length) {
      if (bytes[offset] !== 255) offset++;
      else if (bytes[offset + 1] < 128) offset += 2;
      else break;
    }
    scans.push({ field, maxval: maxval || 2 ** bits - 1, near: bytes[field - 2], entropy: bytes.subarray(end, offset) });
  }
  assert.ok(bits > 0 && scans.length > 0, 'JPEG-LS frame and scan are required');
  return { bits, scans };
}

function changePt(input, values) {
  const bytes = Buffer.from(input);
  const { scans } = scanHeaders(bytes);
  assert.equal(scans.length, values.length, 'Scan count');
  scans.forEach(({ field }, i) => { bytes[field] = values[i]; });
  return bytes;
}

function pixelOrder(planes) {
  return Uint16Array.from({ length: planes[0].length * planes.length },
    (_, index) => planes[index % planes.length][Math.floor(index / planes.length)]);
}

function planarOrder(samples, spec) {
  if (!spec.interleave) return samples;
  const count = spec.planes.length;
  const size = spec.width * spec.height;
  return Uint16Array.from({ length: samples.length },
    (_, index) => samples[index % size * count + Math.floor(index / size)]);
}

function sourcePlane(spec, pt, near, plane) {
  const step = 2 ** pt;
  const maximum = 2 ** spec.bits - 1;
  const qMax = Math.floor(maximum / step);
  const safe = near === 0 ? qMax : Math.max(0, qMax - near);
  const top = Math.min(maximum, safe * step + step - 1);
  const edges = [0, Math.min(step - 1, top), Math.min(step, top), Math.min(step + 1, top), Math.max(0, top - 1), top];
  return Uint16Array.from({ length: spec.width * spec.height }, (_, i) =>
    i < edges.length ? edges[i] : (i * 5153 + plane * 1237 + (i % 7) * 871) % (top + 1));
}

function defaultCase(name, bits, pt, near, interleave = 0, componentCount = 1) {
  const spec = { name, bits, width: 17, height: 3, pt, near, interleave };
  spec.pts = Array(interleave ? 1 : componentCount).fill(pt);
  spec.planePts = Array(componentCount).fill(pt);
  spec.planeNears = Array(componentCount).fill(near);
  spec.planes = spec.planePts.map((p, i) => sourcePlane(spec, p, spec.planeNears[i], i));
  return spec;
}

function fixtures(oracle) {
  const regular = [8, 12, 16].flatMap((bits, index) => [0, 3].map(
    (near) => defaultCase(`default-p${bits}-near${near}`, bits, [2, 4, 5][index], near)));
  const mixed = defaultCase('three-distinct-scans', 8, 0, 0, 0, 3);
  mixed.pts = mixed.planePts = [2, 0, 3];
  mixed.planeNears = [3, 0, 0];
  mixed.planes = mixed.planePts.map((pt, i) => sourcePlane(mixed, pt, mixed.planeNears[i], i));
  const explicit = { name: 'hand-derived-explicit-maxval', bits: 8, width: 1, height: 1, pt: 2, near: 3,
    interleave: 0, pts: [2], planePts: [2], planeNears: [3], maxval: 31, planes: [Uint16Array.of(127)] };
  return [...regular, defaultCase('pt-equals-precision', 8, 8, 0), defaultCase('pt-field-maximum', 8, 15, 0),
    defaultCase('line-interleave', 8, 2, 3, 1, 3), defaultCase('sample-interleave', 16, 5, 0, 2, 3),
    mixed, explicit].map((spec) => {
    const coded = spec.planes.map((plane, i) => Uint16Array.from(plane,
      (sample) => Math.floor(sample / 2 ** spec.planePts[i])));
    let reference;
    if (spec.maxval !== undefined) {
      reference = ptLiteral;
    } else if (spec === mixed) {
      const sof = Buffer.from('ffd8fff70011080003001103011100021100031100', 'hex');
      const bodies = coded.map((plane, i) => {
        const single = Buffer.from(oracle.encode(plane, { ...spec, near: spec.planeNears[i] }));
        const { scans: [scan] } = scanHeaders(single);
        const header = Buffer.from(single.subarray(scan.field - 9, scan.field + 1));
        assert.equal(header[1], 0xda);
        header[5] = i + 1;
        header[9] = spec.pts[i];
        return Buffer.concat([header, scan.entropy]);
      });
      reference = Buffer.concat([sof, ...bodies, Buffer.from('ffd9', 'hex')]);
    } else {
      const frame = { ...spec, components: coded.length };
      reference = changePt(oracle.encode(pixelOrder(coded), frame, 4), spec.pts);
    }
    const expected = referencePixels(oracle, spec, reference);
    if (spec.maxval !== undefined) assert.deepEqual([...expected], [112], 'Annex A.7.2 literal');
    return { spec, reference, expected };
  });
}

function referencePixels(oracle, spec, input) {
  const { bits, scans } = scanHeaders(input);
  assert.equal(bits, spec.bits, 'SOF source precision changed');
  assert.deepEqual(scans.map(({ field }) => input[field]), spec.pts, 'SOS Al/Ah');
  assert.deepEqual(scans.map(({ near }) => near), spec.interleave ? [spec.near] : spec.planeNears);
  assert.ok(scans.every(({ maxval }) => maxval === (spec.maxval ?? 2 ** bits - 1)));
  if (spec.maxval !== undefined) {
    // A.7.1/A.7.2, x=127 and Pt=2 give q=31. NEAR=3, MAXVAL=31 and
    // RANGE=6 give quantized error 4, modulo error -2, RItype=1, k=1,
    // mapped error 2. A zero run followed by Golomb 010 pads to 0x20.
    // The inverse recurrence gives qhat=28 and xhat=112. CharLS's
    // decoder treated custom MAXVAL as 255 on this fixture. FFmpeg is optional.
    assert.deepEqual(scans[0].entropy, Buffer.of(0x20));
    return Uint16Array.of(112);
  }
  const coded = oracle.decode(changePt(input, spec.pts.map(() => 0))).pixels;
  const samples = planarOrder(coded, spec);
  const planeSize = spec.width * spec.height;
  const rescaled = Array.from(samples, (qhat, index) => {
    const c = Math.floor(index / planeSize);
    const step = 2 ** spec.planePts[c];
    const x = spec.planes[c][index % planeSize];
    const q = Math.floor(x / step);
    const near = spec.planeNears[c];
    const codedError = Math.abs(q - qhat);
    const originalError = Math.abs(x - qhat * step);
    assert.ok(codedError <= near && originalError <= step * near + step - 1,
      `${spec.name}: component ${c} sample ${index % planeSize}`);
    return qhat * step;
  });
  assert.ok(rescaled.every((sample) => sample <= 2 ** spec.bits - 1), spec.name);
  return Uint16Array.from(rescaled);
}

function encodeFrame(spec) {
  const { width, height, bits, near, interleave, maxval } = spec;
  const frame = { width, height, bits, near };
  if (maxval !== undefined) frame.maxval = maxval;
  if (spec.planes.length === 1) return { ...frame, pointTransform: spec.pt };
  const components = spec.planes.map((_, i) => ({ id: i + 1 }));
  if (interleave) return { ...frame, components, interleave, pointTransform: spec.pt };
  return { ...frame, components, scans: components.map(({ id }, i) =>
    ({ componentId: id, near: spec.planeNears[i], pointTransform: spec.pts[i] })) };
}

function nativeRunner(file, distro) {
  const binary = resolve(file);
  if (!distro) return { binary, run: (args, input) => run(binary, args, input) };
  const prefix = ['--distribution', distro, '--exec'];
  const path = run('wsl.exe', [...prefix, 'wslpath', '-a', '-u', binary]);
  assert.equal(path.exitCode, 0, path.stderr);
  return { binary, run: (args, input) => run('wsl.exe', [...prefix, path.stdout.toString().trim(), ...args], input) };
}

function nativePixels(data, bits) {
  return bits <= 8 ? Uint16Array.from(data) : readRaw(data);
}

function nativeBytes(samples, bits) {
  return bits <= 8 ? Buffer.from(samples) : writeRaw(samples);
}

function nativeOrder(samples, spec) {
  if (!spec.interleave) return samples;
  const { width, height, planes } = spec;
  const count = planes.length;
  return Uint16Array.from({ length: samples.length }, (_, i) => (
    samples[Math.floor(i / width) % count * width * height + Math.floor(i / (count * width)) * width + i % width]));
}

function resultsFor(run) {
  return { command: run.command, exitCode: run.exitCode };
}

function directDecode(ffmpeg, bytes, spec) {
  const mode = spec.bits <= 8 ? 'gray' : 'gray16le';
  const invocation = run(ffmpeg,
    ['-v', 'error', '-xerror', '-c:v', 'jpegls', '-f', 'image2pipe', '-i', '-', '-pix_fmt', mode, '-f', 'rawvideo', '-'], bytes);
  assert.equal(invocation.exitCode, 0, invocation.stderr);
  const shift = spec.bits <= 8 ? 0 : 16 - spec.bits;
  return { pixels: nativePixels(invocation.stdout, spec.bits).map((value) => value >>> shift), ...resultsFor(invocation) };
}

function checkFfmpeg(ffmpeg, bytes, spec, expected) {
  const direct = directDecode(ffmpeg, bytes, spec);
  assert.deepEqual(direct.pixels, expected, `FFmpeg direct ${spec.name}`);
  return { command: direct.command, exitCode: direct.exitCode, reconstructionSha256: hashSamples(direct.pixels) };
}

function errorExtrema(spec, expected) {
  const planeSize = spec.width * spec.height;
  return spec.planes.map((plane, component) => {
    const pt = spec.planePts[component];
    const near = spec.planeNears[component];
    const step = 2 ** pt;
    let original = 0;
    let coded = 0;
    for (let i = 0; i < planeSize; i++) {
      const reconstructed = expected[component * planeSize + i];
      original = Math.max(original, Math.abs(plane[i] - reconstructed));
      coded = Math.max(coded, Math.abs(Math.floor(plane[i] / step) - reconstructed / step));
    }
    return { pt, near, coded, original, originalBound: step * near + step - 1 };
  });
}

async function validateSdk(backend, core, spec, reference, expected, oracle, ffmpeg) {
  const f = encodeFrame(spec);
  const result = { backend, decodes: [], encodes: [] };
  for (const chunk of chunks) {
    const options = { inputChunkSize: chunk, outputChunkSize: chunk };
    const decoded = await decodePlanarImage(core, reference, options);
    assert.deepEqual(decoded.samples, expected, `${backend} decode chunk ${chunk}`);
    assert.deepEqual(decoded.scans.map((scan) => scan.pointTransform), spec.pts);
    if (spec.maxval !== undefined) assert.equal(decoded.scans[0].preset.maxval, spec.maxval);
    const encoded = spec.planes.length === 1 ? await encodeImage(core, f, spec.planes[0], options)
      : await encodePlanarImage(core, f, spec.planes, options);
    const candidate = referencePixels(oracle, spec, encoded.bytes);
    assert.deepEqual(candidate, expected, `${backend} independent candidate reconstruction chunk ${chunk}`);
    result.decodes.push({ chunk, samplesSha256: hashSamples(decoded.samples) });
    const evidence = { chunk, bytes: encoded.bytes.length, sha256: hash(encoded.bytes), samplesSha256: hashSamples(candidate) };
    if (ffmpeg && spec.planes.length === 1 && chunk === 7) evidence.directReference = checkFfmpeg(ffmpeg, encoded.bytes, spec, expected);
    result.encodes.push(evidence);
  }
  return result;
}

function validateNative(native, spec, reference, expected, oracle, ffmpeg) {
  const result = { backend: 'native', decodes: [], encodes: [] };
  const planes = spec.planes.length;
  const input = Uint16Array.from(spec.planes.flatMap((plane) => [...plane]));
  const dimensions = [spec.width, spec.height, spec.bits].map(String);
  if (planes > 1) dimensions.push(String(planes));
  const specific = planes === 1 || spec.interleave ? ['--pt', String(spec.pt)] :
    ['--scan-pt', spec.pts.join(','), '--scan-near', spec.planeNears.join(',')];
  if (spec.interleave) specific.push('--ilv', String(spec.interleave));
  if (spec.maxval !== undefined) specific.push('--maxval', String(spec.maxval));
  for (const chunk of chunks) {
    const enc = native.run([planes === 1 ? 'encode' : 'encode-planar', ...dimensions, String(spec.near), '-', '-',
      'raw-le', String(chunk), ...specific], nativeBytes(input, spec.bits));
    assert.equal(enc.exitCode, 0, enc.stderr);
    const candidate = referencePixels(oracle, spec, enc.stdout);
    assert.deepEqual(candidate, expected, `Native independently decoded candidate chunk ${chunk}`);
    const dec = native.run(['decode', '-', '-', 'raw-le', String(chunk)], reference);
    assert.equal(dec.exitCode, 0, dec.stderr);
    assert.deepEqual(nativePixels(dec.stdout, spec.bits), nativeOrder(expected, spec), `Native decode chunk ${chunk}`);
    const evidence = { chunk, ...resultsFor(enc), bytes: enc.stdout.length, sha256: hash(enc.stdout), samplesSha256: hashSamples(candidate) };
    if (ffmpeg && planes === 1 && chunk === 7) evidence.directReference = checkFfmpeg(ffmpeg, enc.stdout, spec, expected);
    result.encodes.push(evidence);
    result.decodes.push({ chunk, ...resultsFor(dec), rowDeliverySamplesSha256: hashSamples(nativePixels(dec.stdout, spec.bits)) });
  }
  const inspect = native.run(['inspect', '-', '1', '--json'], reference);
  assert.equal(inspect.exitCode, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout).scans.map((scan) => scan.pointTransform), spec.pts);
  result.inspect = resultsFor(inspect);
  return result;
}

async function emptyInputs(core, reference, expected) {
  let offset = 0;
  let empty = true;
  const rows = [];
  await decodeStream(core, {
    inputChunkSize: 1,
    read() {
      if (offset === reference.length) return null;
      empty = !empty;
      if (!empty) return new Uint8Array(0);
      return reference.subarray(offset, ++offset);
    },
    onRow(row) { rows.push(...row); },
  });
  assert.deepEqual(rows, [...expected]);
}

async function negativeChecks(cores, native, oracle) {
  const { scans: [{ field }] } = scanHeaders(ptLiteral);
  const fieldChanged = (offset, value) => {
    const changed = Buffer.from(ptLiteral);
    changed[field + offset] = value;
    return changed;
  };
  const invalid = [
    ['mapping-with-transform', fieldChanged(-3, 1), 'InvalidData', /InvalidData|mapping|point transform/i],
    ['nonzero-Ah', fieldChanged(0, 0x12), 'InvalidData', /InvalidData|point transform|approximation|reserved|Ah/i],
    ['near-above-coded-max', fieldChanged(-2, 16), 'InvalidData', /NEAR|MAXVAL/i],
    ['truncated-EOI', ptLiteral.subarray(0, -1), 'Truncated', /truncat/i],
    ['trailing-byte', Buffer.concat([ptLiteral, Buffer.of(1)]), 'TrailingData', /trailing/i],
  ];
  const results = [];
  for (const [id, bytes, code, nativePattern] of invalid) {
    for (const [, core] of cores) {
      await assert.rejects(decodePlanarImage(core, bytes, { inputChunkSize: 1 }), { code });
    }
    const result = { id, sha256: hash(bytes), sdkCode: code };
    if (native) {
      const rejected = native.run(['decode', '-', '-', 'raw-le', '1'], bytes);
      assert.equal(rejected.exitCode, 1, rejected.stderr);
      assert.match(rejected.stderr, nativePattern);
      result.native = { ...resultsFor(rejected), stderr: rejected.stderr };
    }
    results.push(result);
  }
  for (const [, core] of cores) {
    await assert.rejects(encodeImage(core, { width: 1, height: 1, bits: 8, pointTransform: 16 }, Uint16Array.of(0)),
      { code: 'InvalidArgument' });
    await emptyInputs(core, ptLiteral, Uint16Array.of(112));
  }
  if (native) {
    const rejected = native.run(['encode', '1', '1', '8', '0', '-', '-', 'raw-le', '1', '--pt', '16'], Buffer.of(0));
    assert.notEqual(rejected.exitCode, 0, rejected.stderr);
    assert.match(rejected.stderr, /point transform|--pt/i);
  }
  for (const bits of [8, 12, 16]) {
    // Construct the exact same 1x1 run interruption at each original precision with
    // CharLS, since its initial model and Rice parameter depend on MAXVAL.
    const q = 2 ** (bits - 2) - 1;
    const bytes = changePt(oracle.encode(Uint16Array.of(q), { bits, width: 1, height: 1, near: 2 }, 4), [2]);
    if (bits === 8) assert.deepEqual(bytes, overflowLiteral(8));
    const [qhat] = oracle.decode(changePt(bytes, [0])).pixels;
    const expected = qhat * 4;
    assert.equal(expected, 2 ** bits + 4);
    for (const [, core] of cores) {
      const decode = decodePlanarImage(core, bytes, { inputChunkSize: 1 });
      if (bits === 16) await assert.rejects(decode, /16|65535|represent/i);
      else assert.deepEqual((await decode).samples, Uint16Array.of(expected));
    }
    const result = { id: `host-range-p${bits}`, expected, qhat, sha256: hash(bytes) };
    if (native) {
      const decoded = native.run(['decode', '-', '-', 'raw-le', '1'], bytes);
      if (bits === 12) {
        assert.equal(decoded.exitCode, 0, decoded.stderr);
        assert.deepEqual(nativePixels(decoded.stdout, bits), Uint16Array.of(expected));
      } else {
        assert.equal(decoded.exitCode, 1, decoded.stderr);
        assert.match(decoded.stderr, /range|represent|wider|byte/i);
      }
      result.native = { ...resultsFor(decoded), stderr: decoded.stderr };
    }
    results.push(result);
  }
  return results;
}

async function verifyScanReport(cores) {
  const frame = {
    width: 2, height: 1, bits: 8, components: [1, 2],
    scans: [
      { componentId: 1, near: 0, pointTransform: 1, maxval: 20 },
      { componentId: 2, near: 1, pointTransform: 0, maxval: 200 },
    ],
  };
  const result = {};
  for (const [backend, core] of cores) {
    const encoded = await encodePlanarImage(core, frame, Uint16Array.of(1, 39, 0, 31));
    const decoded = await decodePlanarImage(core, encoded.bytes);
    assert.deepEqual(encoded.scans.map((scan) => scan.preset), decoded.scans.map((scan) => scan.preset));
    const report = createVerificationReport({ host: 'sdk-cli', status: 'passed', backend,
      frame: { ...encoded.frame, scans: encoded.scans }, preset: encoded.preset });
    assert.equal(report.frame.maxval, 20);
    assert.deepEqual(report.frame.preset, decoded.scans[0].preset);
    assert.deepEqual(report.frame.scanParameters.map((scan) => [scan.pointTransform, scan.near, scan.reconstructionErrorBound]),
      [[1, 0, 1], [0, 1, 1]]);
    result[backend] = 'passed';
  }
  return result;
}

const { values } = parseArgs({ options: {
  'native-exe': { type: 'string' },
  'native-wsl': { type: 'string' },
  ffmpeg: { type: 'string' },
  'reference-only': { type: 'boolean' },
} });
if (values['native-wsl'] && !values['native-exe']) throw new Error('--native-wsl requires --native-exe');
const native = values['native-exe'] ? nativeRunner(values['native-exe'], values['native-wsl']) : null;
const verifyProduct = !values['reference-only'];
const cores = verifyProduct ? await Promise.all(['js', 'wasm-gc'].map(async (backend) => [backend, await loadCore({ backend })])) : [];
const ffmpeg = values.ffmpeg ? run(values.ffmpeg, ['-version']).stdout.toString().split('\n')[0].trim() : null;
const oracle = await createOracle();
try {
  const rows = [];
  for (const { spec, reference, expected } of fixtures(oracle)) {
    const row = { id: spec.name, bits: spec.bits, interleave: spec.interleave, pointTransforms: spec.pts, nearByPlane: spec.planeNears,
      samples: expected.length, originalSha256: hashSamples(Uint16Array.from(spec.planes.flatMap((plane) => [...plane]))),
      referenceBytes: reference.length, referenceSha256: hash(reference), reconstructionSha256: hashSamples(expected),
      errorByPlane: errorExtrema(spec, expected), backends: [] };
    if (values.ffmpeg && spec.planes.length === 1) {
      row.ffmpeg = checkFfmpeg(values.ffmpeg, reference, spec, expected);
    }
    for (const [backend, core] of cores) row.backends.push(await validateSdk(backend, core, spec, reference, expected, oracle, values.ffmpeg));
    if (native && verifyProduct) row.backends.push(validateNative(native, spec, reference, expected, oracle, values.ffmpeg));
    rows.push(row);
  }
  let directCharls;
  try {
    oracle.decode(ptLiteral);
    directCharls = { status: 'accepted' };
  } catch (error) {
    assert.equal(error.code, 7);
    directCharls = { status: 'reference_unsupported', code: error.code };
  }
  const negatives = verifyProduct ? await negativeChecks(cores, native, oracle) : [];
  const scanReporting = verifyProduct ? await verifyScanReport(cores) : {};
  const source = run('git', ['rev-parse', 'HEAD']);
  const worktree = run('git', ['status', '--porcelain', '--', 'core', 'cmd', 'sdk', 'web', 'scripts', '.github', 'moon.mod']);
  const files = verifyProduct ? {
    js: new URL('../sdk/generated/core.mjs', import.meta.url),
    'wasm-gc': new URL('../sdk/generated/core.wasm', import.meta.url),
    ...(native && { native: native.binary }),
  } : {};
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(files)
    .map(async ([backend, file]) => [backend, hash(await readFile(file))])));
  console.log(JSON.stringify({ status: verifyProduct ? 'passed' : 'reference_only', exitCode: 0,
    sourceRevision: source.exitCode === 0 ? source.stdout.toString().trim() : null,
    sourceDirty: worktree.exitCode === 0 ? worktree.stdout.length > 0 : null, node: process.version,
    command: [process.execPath, ...process.argv.slice(1)], runnerSha256: hash(await readFile(new URL(import.meta.url))),
    artifacts, oracle: { charls: '@team-charls/charls-wasm 0.10.0', directCharls, ffmpeg },
    cases: rows, negativeChecks: negatives, scanReporting }, null, 2));
} finally {
  oracle.close();
}
