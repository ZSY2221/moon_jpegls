import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePlanarImage, encodePlanarImage, loadCore } from '../sdk/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'tests/conformance/manifest.json'), 'utf8'));
const usage = 'Usage: node scripts/validate_annex_e.mjs --check-manifest | --fixtures DIR [--cases ID,ID,...] [--native-exe FILE [--native-wsl DISTRO]] [--hp-reference DIR]';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const backends = ['js', 'wasm-gc'];

function checkManifest() {
  const digest = /^[0-9a-f]{64}$/;
  const states = new Set(['passed', 'unsupported', 'recognized_only', 'not_run', 'planned', 'blocked', 'failed', 'reference_unsupported']);
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.fixtureArchive.sha256, digest);
  assert.match(manifest.officialReference.sha256, digest);
  assert.deepEqual(manifest.cases.map((item) => item.id), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const item of manifest.cases) {
    assert.equal(item.test_id, `E.2-${item.id}`);
    assert.match(item.sha256, digest);
    assert.ok(item.bytes > 0 && item.sourceFiles.length > 0);
    assert.ok(['supported', 'unsupported'].includes(item.expected), `${item.test_id} scope`);
    assert.ok([0, 1, 2].includes(item.interleave), `${item.test_id} interleave`);
    for (const name of item.sourceFiles) assert.match(manifest.sourceFiles[name].sha256, digest);
    if (item.sampling) {
      assert.equal(item.sampling.length, item.components, `${item.test_id} sampling count`);
      item.sampling.forEach(({ id, h, v }, index) => {
        assert.equal(id, index + 1, `${item.test_id} component ID`);
        assert.ok([h, v].every((factor) => Number.isInteger(factor) && factor >= 1 && factor <= 4));
      });
    }
  }
  const ids = manifest.features.map((feature) => feature.feature_id);
  assert.equal(new Set(ids).size, ids.length, 'Unique feature identifiers');
  for (const feature of manifest.features) {
    for (const key of ['feature_id', 'standard_clause', 'reference_support', 'evidence_path', 'target_milestone']) {
      assert.ok(typeof feature[key] === 'string' && feature[key].length > 0, `${feature.feature_id}.${key}`);
    }
    for (const key of ['encode_status', 'decode_status', 'format_status']) {
      assert.ok(states.has(feature[key]), `${feature.feature_id}.${key}`);
    }
    assert.ok(Array.isArray(feature.test_ids));
    assert.ok(feature.source_revision === null || /^[0-9a-f]{40}$/.test(feature.source_revision));
  }
}

function parse(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    if (!['--fixtures', '--cases', '--native-exe', '--native-wsl', '--hp-reference'].includes(flag) || !value || options.has(flag)) {
      throw new Error(usage);
    }
    options.set(flag, value);
  }
  if (!options.has('--fixtures') || (options.has('--native-wsl') && !options.has('--native-exe'))) throw new Error(usage);
  return options;
}

function selectedCases(value) {
  if (!value) return null;
  const selected = value.split(',').map(Number);
  const ids = new Set(selected);
  if (!/^[0-9]+(?:,[0-9]+)*$/.test(value) || ids.size !== selected.length ||
    selected.some((id) => !manifest.cases.some((item) => item.id === id))) {
    throw new Error('Choose distinct numeric Annex E case IDs for --cases');
  }
  return ids;
}

function child(command, args, options = {}) {
  const result = spawnSync(command, args, { timeout: 30_000, ...options });
  const run = { command: [command, ...args], exitCode: result.status, signal: result.signal };
  if (options.cwd) run.cwd = options.cwd;
  if (result.error) throw Object.assign(result.error, { run });
  return { run, stdout: result.stdout, stderr: result.stderr.toString('utf8').trimEnd() };
}

function nativeCommand(file, distro) {
  const binary = resolve(file);
  if (!distro) return { binary, path: resolve, run: (args, input) => child(binary, args, { input }) };
  const args = ['--distribution', distro, '--exec'];
  const path = (hostPath) => {
    const converted = child('wsl.exe', [...args, 'wslpath', '-a', '-u', resolve(hostPath)]);
    assert.equal(converted.run.exitCode, 0, converted.stderr);
    return converted.stdout.toString().trim();
  };
  const nativeBinary = path(binary);
  return { binary, path, run: (parameters, input) => child('wsl.exe', [...args, nativeBinary, ...parameters], { input }) };
}

async function knownBytes(directory, name, metadata) {
  const bytes = await readFile(join(directory, name));
  assert.equal(bytes.length, metadata.bytes, `${name} byte count`);
  assert.equal(sha256(bytes), metadata.sha256, `${name} SHA-256`);
  return bytes;
}

function removeIfPresent(file) {
  return unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function samplesFromPnm(bytes, expected, magic = 'P5', comps = 1) {
  const header = new RegExp(`^${magic}\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)(\\r?\\n| )`).exec(bytes.subarray(0, 120).toString('ascii'));
  assert.ok(header, `Expected a binary ${magic} image`);
  const [width, height, maxval] = header.slice(1, 4).map(Number);
  assert.deepEqual([width, height, maxval], [expected.width, expected.height, 2 ** expected.bits - 1]);
  const body = bytes.subarray(header[0].length);
  const wide = expected.bits > 8;
  assert.equal(body.length, width * height * comps * (wide ? 2 : 1));
  return Uint16Array.from({ length: width * height * comps }, (_, i) => wide ? body.readUInt16BE(i * 2) : body[i]);
}

function samplesFromPgm(bytes, expected) {
  return samplesFromPnm(bytes, expected, 'P5', 1);
}

function withGeometry(spec) {
  const sampling = spec.sampling ?? Array.from({ length: spec.components }, (_, i) => ({ id: i + 1, h: 1, v: 1 }));
  const maxH = Math.max(...sampling.map(({ h }) => h));
  const maxV = Math.max(...sampling.map(({ v }) => v));
  let samples = 0;
  const planes = sampling.map(({ id, h, v }) => {
    const width = Math.ceil(spec.width * h / maxH);
    const height = Math.ceil(spec.height * v / maxV);
    const plane = { id, h, v, width, height, bits: spec.bits, offset: samples };
    samples += width * height;
    return plane;
  });
  const sampled = sampling.some(({ h, v }) => h !== 1 || v !== 1);
  return { ...spec, sampling, planes, samples, sampled };
}

async function readPgmPlanes(paths, item) {
  assert.equal(paths.length, item.planes.length, 'PGM plane count');
  const planar = new Uint16Array(item.samples);
  for (const [index, path] of paths.entries()) {
    const plane = item.planes[index];
    planar.set(samplesFromPgm(await readFile(path), plane), plane.offset);
  }
  return planar;
}

function planarFromInterleaved(interleaved, item) {
  assert.ok(!item.sampled, 'Interleaved source requires full-resolution planes');
  const planeSize = item.width * item.height;
  assert.equal(interleaved.length, planeSize * item.components, 'Interleaved sample count');
  const planar = new Uint16Array(interleaved.length);
  for (let i = 0; i < planeSize; i++) {
    for (let c = 0; c < item.components; c++) {
      planar[c * planeSize + i] = interleaved[i * item.components + c];
    }
  }
  return planar;
}

function planarFromPpm(bytes, item) {
  return planarFromInterleaved(samplesFromPnm(bytes, item, 'P6', item.components), item);
}

function nativeSamples(bytes, bits) {
  if (bits <= 8) return Uint16Array.from(bytes);
  assert.equal(bytes.length % 2, 0, 'Native raw-le sample storage');
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16LE(i * 2));
}

function nativeRaw(pixels, bits) {
  if (bits <= 8) return Buffer.from(pixels);
  const bytes = Buffer.alloc(pixels.length * 2);
  pixels.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

function compare(actual, expected, item, tolerance = 0) {
  assert.equal(actual.length, expected.length, 'Sample count');
  assert.equal(actual.length, item.samples, 'Annex E sample count');
  let maxAbsoluteError = 0;
  let firstDifference = null;
  let componentIndex = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    if (difference > tolerance && firstDifference === null) {
      while (componentIndex + 1 < item.planes.length && i >= item.planes[componentIndex + 1].offset) {
        componentIndex += 1;
      }
      const plane = item.planes[componentIndex];
      const withinPlane = i - plane.offset;
      firstDifference = {
        componentIndex, componentId: plane.id, x: withinPlane % plane.width, y: Math.floor(withinPlane / plane.width),
        actual: actual[i], expected: expected[i],
      };
    }
    maxAbsoluteError = Math.max(maxAbsoluteError, difference);
  }
  const comparison = { samples: actual.length, maxAbsoluteError, firstDifference };
  if (firstDifference !== null) {
    const { componentIndex, x, y } = firstDifference;
    throw Object.assign(new Error(`First disagreement at component index ${componentIndex}, (${x}, ${y}); tolerance ${tolerance}`),
      { comparison });
  }
  return comparison;
}

function sampleDigest(samples) {
  return sha256(nativeRaw(samples, 16));
}

function checkFrame(actual, item) {
  for (const key of ['width', 'height', 'bits', 'near']) assert.equal(actual[key], item[key], key);
  const actualComps = Array.isArray(actual.components) ? actual.components.length : (actual.components ?? 1);
  assert.equal(actualComps, item.components, 'components');
}

function streamEvidence(bytes, frame, components, scans, item) {
  checkFrame(frame, item);
  assert.equal(scans.length, item.scans, 'Scan count');
  const expectedIds = item.sampling.map(({ id }) => id);
  const sampling = components.map((comp) => ({
    id: comp.id, h: comp.hSampling ?? comp.h, v: comp.vSampling ?? comp.v,
  }));
  assert.deepEqual(sampling, item.sampling, 'Frame components and sampling');
  return {
    components: item.planes.map(({ id, h, v, width, height }) => ({ id, h, v, width, height })),
    scans: scans.map((scan, index) => {
      assert.ok(scan.completed, 'Complete scan');
      assert.equal(scan.near, item.near, 'Scan NEAR');
      assert.equal(scan.interleave, item.interleave, 'Scan ILV');
      assert.equal(scan.pointTransform, 0, 'Point transform');
      assert.deepEqual(scan.componentIds, item.interleave === 0 ? [expectedIds[index]] : expectedIds, 'Scan order');
      const rows = item.interleave === 0 ? item.planes[index].height : item.planes.reduce((sum, plane) => sum + plane.height, 0);
      assert.equal(scan.rows, rows, 'Valid decoded rows in scan');
      assert.ok(scan.entropyOffset < scan.endOffset && scan.endOffset <= bytes.length, 'Entropy bounds');
      const coded = bytes.subarray(scan.entropyOffset, scan.endOffset);
      return {
        componentIds: scan.componentIds, near: scan.near, interleave: scan.interleave,
        pointTransform: scan.pointTransform, preset: scan.preset, rows, codedBytes: coded.length, codedSha256: sha256(coded),
      };
    }),
  };
}

function checkPreset(bytes, item) {
  if (!item.preset) return;
  for (let start = 2; start + 4 <= bytes.length; ) {
    const marker = bytes.readUInt16BE(start);
    if (marker === 0xffda) break;
    const length = bytes.readUInt16BE(start + 2);
    assert.ok(length >= 2 && start + 2 + length <= bytes.length, 'Segment length before SOS');
    if (marker === 0xfff8 && bytes[start + 4] === 1) {
      assert.equal(length, 13);
      const maxval = bytes.readUInt16BE(start + 5);
      assert.ok(maxval === 0 || maxval === 2 ** item.bits - 1, 'Annex E full-range MAXVAL');
      assert.deepEqual([7, 9, 11, 13].map((offset) => bytes.readUInt16BE(start + offset)),
        [item.preset.t1, item.preset.t2, item.preset.t3, item.preset.reset]);
      return;
    }
    start += 2 + length;
  }
  assert.fail('Required Annex E custom LSE1 is absent');
}

async function createReference(hpDirectory) {
  if (!hpDirectory) {
    const { createOracle } = await import('./oracle.mjs');
    const oracle = await createOracle();
    return {
      identity: { name: 'CharLS Wasm', version: '0.10.0', officialSoftware: false },
      decode(bytes, item, evidence) {
        evidence.run = { api: 'CharLS Wasm createJpegLSDecoder().decode', exitCode: null };
        let result;
        try {
          result = oracle.decode(bytes);
        } catch (error) {
          if (/\berrorCode: 7\b/.test(error.message)) {
            throw Object.assign(error, { status: 'reference_unsupported' });
          }
          throw error;
        }
        checkFrame(result.frame, item);
        // CharLS returns component planes for ILV=0 and pixel order for both interleaved modes.
        return item.interleave === 0 ? result.pixels : planarFromInterleaved(result.pixels, item);
      },
      close: () => oracle.close(),
    };
  }
  const path = resolve(hpDirectory);
  const binaries = new Map();
  for (const name of ['locod.exe', 'nlocod.exe', 'loco16d.exe', 'nloco16d.exe']) {
    const entry = manifest.officialReference.files[name];
    const bytes = await knownBytes(path, name, entry);
    binaries.set(name, sha256(bytes));
  }
  const work = await mkdtemp(join(tmpdir(), 'moonjls-annex-e-'));
  const input = join(work, 'stream.jls');
  const createdOutputs = new Set();
  return {
    identity: { name: 'HP JPEG-LS reference software', version: '1.00', officialSoftware: true,
      executableSha256: Object.fromEntries(binaries) },
    async decode(bytes, item, evidence) {
      const name = `${item.near ? 'n' : ''}loco${item.bits > 8 ? '16' : ''}d.exe`;
      await writeFile(input, bytes);
      const outNames = item.interleave === 2 ? ['result.ppm'] : item.components === 1
        ? ['result.pgm'] : Array.from({ length: item.components }, (_, idx) => `comp${idx}.pgm`);
      const outPaths = outNames.map((n) => join(work, n));
      outPaths.forEach((p) => createdOutputs.add(p));
      await Promise.all(outPaths.map(removeIfPresent));
      const result = child(join(path, name), ['stream.jls', ...outNames], { cwd: work });
      evidence.run = result.run;
      assert.equal(result.run.exitCode, 0, `${name}: ${result.stderr}\n${result.stdout}`);
      if (item.interleave === 2) return planarFromPpm(await readFile(outPaths[0]), item);
      return readPgmPlanes(outPaths, item);
    },
    async close() {
      await Promise.all([removeIfPresent(input), ...[...createdOutputs].map(removeIfPresent)]);
      await rmdir(work);
    },
  };
}

async function classified(evidence, check) {
  try {
    await check(evidence);
    evidence.status ??= 'passed';
  } catch (error) {
    evidence.status = error.status ?? (error.run ? 'blocked' : 'failed');
    evidence.message = error.message;
    evidence.code = error.code ?? null;
    if (error.comparison) evidence.comparison = error.comparison;
    if (error.run) evidence.failedRun = error.run;
  }
  return evidence;
}

async function readOriginal(fixtures, item, evidence) {
  const sources = new Map(await Promise.all(item.sourceFiles.map(async (name) =>
    [name, await knownBytes(fixtures, name, manifest.sourceFiles[name])])));
  evidence.files = Object.fromEntries([...sources].map(([name, bytes]) =>
    [name, { bytes: bytes.length, sha256: sha256(bytes) }]));
  const pgms = [...sources].filter(([name]) => name.endsWith('.PGM'));
  const ppm = [...sources].find(([name]) => name.endsWith('.PPM'));
  let pixels;
  if (pgms.length) {
    assert.equal(pgms.length, item.components, 'Source plane count');
    pixels = new Uint16Array(item.samples);
    pgms.forEach(([, bytes], c) => {
      const plane = item.planes[c];
      pixels.set(samplesFromPgm(bytes, plane), plane.offset);
    });
  }
  if (ppm) {
    const ppmPixels = planarFromPpm(ppm[1], item);
    if (pixels) compare(ppmPixels, pixels, item);
    else pixels = ppmPixels;
  }
  assert.ok(pixels, 'Source samples');
  evidence.samples = pixels.length;
  evidence.planarU16leSha256 = sampleDigest(pixels);
  return pixels;
}

async function decodeTarget(core, native, bytes, item, evidence) {
  if (core) {
    evidence.decodeRun = { api: 'SDK decodePlanarImage', exitCode: null };
    const result = await decodePlanarImage(core, bytes, { trailing: 'reject' });
    const structure = streamEvidence(bytes, result.frame, result.frameInfo.components, result.scans, item);
    assert.deepEqual(result.planes.map(({ length }) => length), item.planes.map(({ width, height }) => width * height));
    return { pixels: result.samples, structure };
  }
  const pixels = await decodeNativePixels(native, bytes, item, evidence);
  const inspected = native.run(['inspect', '-', '4096', '--json'], bytes);
  evidence.inspectRun = inspected.run;
  assert.equal(inspected.run.exitCode, 0, inspected.stderr);
  const metadata = JSON.parse(inspected.stdout);
  const structure = streamEvidence(bytes, metadata, metadata.components, metadata.scans, item);
  return { pixels, structure };
}

async function decodeNativePixels(native, bytes, item, evidence) {
  if (!item.sampled) {
    const result = native.run(['decode', '-', '-', item.components > 1 ? 'ppm' : 'raw-le', '4096'], bytes);
    evidence.decodeRun = result.run;
    assert.equal(result.run.exitCode, 0, result.stderr);
    return item.components > 1 ? planarFromPpm(result.stdout, item) : nativeSamples(result.stdout, item.bits);
  }
  const work = await mkdtemp(join(tmpdir(), 'moonjls-annex-native-'));
  const paths = item.planes.map(({ id }) => join(work, `comp${id}.pgm`));
  try {
    const args = ['decode-pgms', '-', ...paths.map((path) => native.path(path)), '--chunk', '4096'];
    const result = native.run(args, bytes);
    evidence.decodeRun = result.run;
    assert.equal(result.run.exitCode, 0, result.stderr);
    return await readPgmPlanes(paths, item);
  } finally {
    await Promise.all(paths.map(removeIfPresent));
    await rmdir(work);
  }
}

async function encodeTarget(core, native, fixtures, original, item, evidence) {
  const { width, height, bits, near, preset, components, interleave } = item;
  if (core) {
    const frame = { width, height, bits, near, ...(preset && { preset }) };
    if (components > 1) {
      frame.components = item.sampling.map(({ id, h, v }) => ({ id, hSampling: h, vSampling: v }));
      frame.interleave = interleave;
    }
    const planes = item.planes.map((plane) => original.subarray(plane.offset, plane.offset + plane.width * plane.height));
    evidence.encodeRun = { api: 'SDK encodePlanarImage', exitCode: null };
    return Buffer.from((await encodePlanarImage(core, frame, planes)).bytes);
  }
  const flags = preset ? Object.entries(preset).flatMap(([name, value]) => [`--${name}`, String(value)]) : [];
  if (item.sampled) {
    const paths = item.sourceFiles.map((name) => native.path(join(fixtures, name)));
    const sampling = item.sampling.map(({ h, v }) => `${h}x${v}`).join(',');
    const result = native.run(['encode-pgms', String(near), '-', '--ilv', String(interleave),
      '--chunk', '4096', '--sampling', sampling, ...flags, ...paths]);
    evidence.encodeRun = result.run;
    assert.equal(result.run.exitCode, 0, result.stderr);
    return result.stdout;
  }
  const args = components > 1
    ? ['encode-planar', ...[width, height, bits, components, near].map(String), '-', '-', 'raw-le', '4096',
      '--ilv', String(interleave), ...flags]
    : ['encode', ...[width, height, bits, near].map(String), '-', '-', 'raw-le', '4096', ...flags];
  const result = native.run(args, nativeRaw(original, bits));
  evidence.encodeRun = result.run;
  assert.equal(result.run.exitCode, 0, result.stderr);
  return result.stdout;
}

async function rejectUnsupported(core, native, official, evidence) {
  if (core) {
    evidence.decodeRun = { api: 'SDK decodePlanarImage', exitCode: null };
    await assert.rejects(decodePlanarImage(core, official), { code: 'UnsupportedFeature' });
  } else {
    const result = native.run(['decode', '-', '-', 'raw-le', '4096'], official);
    evidence.decodeRun = result.run;
    assert.ok(result.run.exitCode && /\bUnsupportedFeature\b/.test(result.stderr), result.stderr);
    assert.equal(result.stdout.length, 0, 'Unsupported input emits no bytes');
  }
  evidence.status = 'expected_unsupported';
  evidence.code = 'UnsupportedFeature';
}

async function run(args) {
  const options = parse(args);
  const selected = selectedCases(options.get('--cases'));
  const fixtures = resolve(options.get('--fixtures'));
  const cores = new Map(await Promise.all(backends.map(async (backend) => [backend, await loadCore({ backend })])));
  const native = options.has('--native-exe') ? nativeCommand(options.get('--native-exe'), options.get('--native-wsl')) : null;
  const reference = await createReference(options.get('--hp-reference'));
  const rows = [];
  let failed = false;
  try {
    for (const spec of manifest.cases) {
      if (selected && !selected.has(spec.id)) continue;
      const item = withGeometry(spec);
      const official = await knownBytes(fixtures, item.file, item);
      const outside = item.expected === 'unsupported' && !selected;
      const row = { id: item.id, test_id: item.test_id, file: item.file, bytes: item.bytes, sha256: item.sha256,
        expected: outside ? 'unsupported' : 'supported', backends: {} };
      if (item.sampled) row.geometry = {
        width: item.width, height: item.height, bits: item.bits, near: item.near, interleave: item.interleave,
        pointTransform: 0, components: item.planes, samples: item.samples,
      };
      let original;
      let expected;
      if (!outside) {
        row.original = await classified({}, async (evidence) => { original = await readOriginal(fixtures, item, evidence); });
        row.reference = await classified({}, async (evidence) => {
          expected = await reference.decode(official, item, evidence);
          evidence.planarU16leSha256 = sampleDigest(expected);
          if (row.original.status === 'passed') Object.assign(evidence, compare(expected, original, item, item.near));
        });
      }
      for (const backend of [...backends, 'native']) {
        const core = cores.get(backend);
        if (!core && !native) {
          row.backends[backend] = { encode: { status: 'not_run' }, decode: { status: 'not_run' } };
          continue;
        }
        if (outside) {
          const decode = await classified({}, (evidence) => rejectUnsupported(core, native, official, evidence));
          row.backends[backend] = { encode: { status: 'not_run', reason: 'outside current interleave/subsampling scope' }, decode };
          failed ||= decode.status !== 'expected_unsupported';
          continue;
        }
        if (row.original.status !== 'passed' || row.reference.status !== 'passed') {
          const status = row.reference.status === 'reference_unsupported' ? 'reference_unsupported' : 'blocked';
          const reason = 'An original or reference reconstruction was unavailable';
          row.backends[backend] = { encode: { status, reason }, decode: { status, reason } };
          failed = true;
          continue;
        }
        const decode = await classified({}, async (evidence) => {
          const result = await decodeTarget(core, native, official, item, evidence);
          evidence.structure = result.structure;
          evidence.planarU16leSha256 = sampleDigest(result.pixels);
          evidence.referenceComparison = compare(result.pixels, item.near ? expected : original, item);
          Object.assign(evidence, compare(result.pixels, original, item, item.near));
        });
        const encode = await classified({}, async (evidence) => {
          const bytes = await encodeTarget(core, native, fixtures, original, item, evidence);
          evidence.bytes = bytes.length;
          evidence.sha256 = sha256(bytes);
          evidence.byteIdenticalToOfficial = bytes.equals(official);
          checkPreset(bytes, item);
          evidence.reference = {};
          const actual = await reference.decode(bytes, item, evidence.reference);
          evidence.reference.planarU16leSha256 = sampleDigest(actual);
          evidence.reference.comparison = compare(actual, item.near ? expected : original, item);
          evidence.candidateDecode = {};
          const decoded = await decodeTarget(core, native, bytes, item, evidence.candidateDecode);
          evidence.candidateDecode.planarU16leSha256 = sampleDigest(decoded.pixels);
          evidence.candidateDecode.comparison = compare(decoded.pixels, actual, item);
          evidence.structure = decoded.structure;
          if (!evidence.byteIdenticalToOfficial) {
            assert.deepEqual(decoded.structure, decode.structure, 'Official and candidate effective parameters and coded data');
          }
          Object.assign(evidence, compare(actual, original, item, item.near));
        });
        row.backends[backend] = { encode, decode };
        failed ||= encode.status !== 'passed' || decode.status !== 'passed';
      }
      const encodedDigests = Object.values(row.backends).map(({ encode }) => encode.sha256).filter(Boolean);
      if (encodedDigests.length >= 2) row.crossBackendByteIdentical = new Set(encodedDigests).size === 1;
      rows.push(row);
    }
  } finally {
    await reference.close();
  }
  const artifactFiles = { js: new URL('../sdk/generated/core.mjs', import.meta.url),
    'wasm-gc': new URL('../sdk/generated/core.wasm', import.meta.url), ...(native && { native: native.binary }) };
  const artifactSha256 = Object.fromEntries(await Promise.all(Object.entries(artifactFiles).map(async ([key, path]) =>
    [key, sha256(await readFile(path))])));
  const git = child('git', ['rev-parse', 'HEAD'], { cwd: root });
  const sourceRevision = git.run.exitCode === 0 ? git.stdout.toString().trim() : null;
  const diff = child('git', ['status', '--porcelain', '--', 'core', 'cmd', 'sdk', 'moon.mod'], { cwd: root });
  const sourceDirty = diff.run.exitCode === 0 ? diff.stdout.length > 0 : null;
  const runnerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  process.stdout.write(`${JSON.stringify({ standard: manifest.standard, sourceRevision, sourceDirty, node: process.version,
    command: ['node', 'scripts/validate_annex_e.mjs', ...args], exitCode: failed ? 1 : 0,
    fixtureArchive: manifest.fixtureArchive, runnerSha256,
    reference: reference.identity, artifactSha256, cases: rows }, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
}

const args = process.argv.slice(2);
if (args.includes('--help')) process.stdout.write(`${usage}\n`);
else if (args.length === 1 && args[0] === '--check-manifest') {
  checkManifest();
  process.stdout.write(`Checked ${manifest.features.length} feature rows and ${manifest.cases.length} Annex E entries\n`);
} else run(args).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
