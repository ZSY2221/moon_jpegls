import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePlanarImage, encodePlanarImage, inspectStream, loadCore } from '../sdk/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'tests/conformance/manifest.json'), 'utf8'));
const usage = 'Usage: node scripts/validate_annex_e.mjs --check-manifest | --fixtures DIR [--native-exe FILE [--native-wsl DISTRO]] [--hp-reference DIR]';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const backends = ['js', 'wasm-gc'];

function checkManifest() {
  const digest = /^[0-9a-f]{64}$/;
  const states = new Set(['passed', 'unsupported', 'recognized_only', 'not_run', 'planned', 'blocked', 'failed']);
  const supportedCases = new Set([1, 4, 9, 10, 11, 12]);
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.fixtureArchive.sha256, digest);
  assert.match(manifest.officialReference.sha256, digest);
  assert.deepEqual(manifest.cases.map((item) => item.id), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const item of manifest.cases) {
    assert.equal(item.test_id, `E.2-${item.id}`);
    assert.match(item.sha256, digest);
    assert.ok(item.bytes > 0 && item.sourceFiles.length > 0);
    assert.equal(item.expected, supportedCases.has(item.id) ? 'supported' : 'unsupported');
    for (const name of item.sourceFiles) assert.match(manifest.sourceFiles[name].sha256, digest);
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
    if (!['--fixtures', '--native-exe', '--native-wsl', '--hp-reference'].includes(flag) || !value || options.has(flag)) {
      throw new Error(usage);
    }
    options.set(flag, value);
  }
  if (!options.has('--fixtures') || (options.has('--native-wsl') && !options.has('--native-exe'))) throw new Error(usage);
  return options;
}

function child(command, args, options = {}) {
  const result = spawnSync(command, args, { timeout: 30_000, ...options });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8').trimEnd() };
}

function nativeCommand(file, distro) {
  const binary = resolve(file);
  if (!distro) return { binary, run: (args, input) => child(binary, args, { input }) };
  const args = ['--distribution', distro, '--exec'];
  const converted = child('wsl.exe', [...args, 'wslpath', '-a', '-u', binary]);
  assert.equal(converted.status, 0, converted.stderr);
  return { binary, run: (parameters, input) => child('wsl.exe', [...args, converted.stdout.toString().trim(), ...parameters], { input }) };
}

async function knownBytes(directory, name, metadata) {
  const bytes = await readFile(join(directory, name));
  assert.equal(bytes.length, metadata.bytes, `${name} byte count`);
  assert.equal(sha256(bytes), metadata.sha256, `${name} SHA-256`);
  return bytes;
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

function planarFromPpm(bytes, expected) {
  const interleaved = samplesFromPnm(bytes, expected, 'P6', expected.components);
  const planeSize = expected.width * expected.height;
  const planar = new Uint16Array(planeSize * expected.components);
  for (let i = 0; i < planeSize; i++) {
    for (let c = 0; c < expected.components; c++) {
      planar[c * planeSize + i] = interleaved[i * expected.components + c];
    }
  }
  return planar;
}

function nativeRaw(pixels, bits) {
  if (bits <= 8) return Buffer.from(pixels);
  const bytes = Buffer.alloc(pixels.length * 2);
  pixels.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

function compare(actual, expected, tolerance = 0) {
  assert.equal(actual.length, expected.length, 'Sample count');
  let maxAbsoluteError = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    assert.ok(difference <= tolerance, `Sample ${i}: ${actual[i]} vs ${expected[i]}, allowed ${tolerance}`);
    maxAbsoluteError = Math.max(maxAbsoluteError, difference);
  }
  return maxAbsoluteError;
}

function checkFrame(actual, item) {
  for (const key of ['width', 'height', 'bits', 'near']) assert.equal(actual[key], item[key], key);
  const actualComps = Array.isArray(actual.components) ? actual.components.length : (actual.components ?? 1);
  assert.equal(actualComps, item.components, 'components');
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
      decode(bytes, item) {
        const result = oracle.decode(bytes);
        checkFrame(result.frame, item);
        return result.pixels;
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
  const remove = (file) => unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return {
    identity: { name: 'HP JPEG-LS reference software', version: '1.00', officialSoftware: true,
      executableSha256: Object.fromEntries(binaries) },
    async decode(bytes, item) {
      const name = `${item.near ? 'n' : ''}loco${item.bits > 8 ? '16' : ''}d.exe`;
      await writeFile(input, bytes);
      const outNames = item.components === 1
        ? ['result.pgm']
        : Array.from({ length: item.components }, (_, idx) => `comp${idx}.pgm`);
      const outPaths = outNames.map((n) => join(work, n));
      outPaths.forEach((p) => createdOutputs.add(p));
      await Promise.all(outPaths.map(remove));
      const result = child(join(path, name), ['stream.jls', ...outNames], { cwd: work });
      assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
      if (item.components === 1) {
        return samplesFromPgm(await readFile(outPaths[0]), item);
      }
      const planeSize = item.width * item.height;
      const planar = new Uint16Array(planeSize * item.components);
      for (let c = 0; c < item.components; c++) {
        planar.set(samplesFromPgm(await readFile(outPaths[c]), item), c * planeSize);
      }
      return planar;
    },
    async close() {
      await Promise.all([remove(input), ...[...createdOutputs].map(remove)]);
      await rmdir(work);
    },
  };
}

async function classified(check) {
  try { return await check(); }
  catch (error) { return { status: 'failed', message: error.message, code: error.code ?? null }; }
}

async function run(args) {
  const options = parse(args);
  const fixtures = resolve(options.get('--fixtures'));
  const cores = new Map(await Promise.all(backends.map(async (backend) => [backend, await loadCore({ backend })])));
  const native = options.has('--native-exe') ? nativeCommand(options.get('--native-exe'), options.get('--native-wsl')) : null;
  const reference = await createReference(options.get('--hp-reference'));
  const rows = [];
  let failed = false;
  try {
    for (const item of manifest.cases) {
      const official = await knownBytes(fixtures, item.file, item);
      const outside = item.expected === 'unsupported';
      const row = { id: item.id, test_id: item.test_id, file: item.file, sha256: item.sha256, expected: item.expected, backends: {} };
      let original;
      let expected;
      if (!outside) {
        if (item.components === 1) {
          const name = item.sourceFiles[0];
          original = samplesFromPgm(await knownBytes(fixtures, name, manifest.sourceFiles[name]), item);
        } else {
          const ppmName = item.sourceFiles.find((n) => n.endsWith('.PPM'));
          const pgmNames = item.sourceFiles.filter((n) => n.endsWith('.PGM'));
          assert.equal(pgmNames.length, item.components, `${item.test_id} source PGM planes`);
          const planeSize = item.width * item.height;
          original = new Uint16Array(planeSize * item.components);
          for (let c = 0; c < item.components; c++) {
            const pName = pgmNames[c];
            original.set(samplesFromPgm(await knownBytes(fixtures, pName, manifest.sourceFiles[pName]), item), c * planeSize);
          }
          if (ppmName) {
            const fromPpm = planarFromPpm(await knownBytes(fixtures, ppmName, manifest.sourceFiles[ppmName]), item);
            compare(fromPpm, original, 0);
          }
        }
        expected = await reference.decode(official, item);
        row.reference = { status: 'passed', samples: expected.length, maxAbsoluteError: compare(expected, original, item.near) };
      }
      let canonicalEncoded = null;
      for (const backend of [...backends, 'native']) {
        const core = cores.get(backend);
        if (!core && !native) {
          row.backends[backend] = { encode: { status: 'not_run' }, decode: { status: 'not_run' } };
          continue;
        }
        const decode = await classified(async () => {
          if (outside) {
            if (core) await assert.rejects(decodePlanarImage(core, official), { code: 'UnsupportedFeature' });
            else {
              const result = native.run(['decode', '-', '-', 'raw-le', '4096'], official);
              assert.ok(result.status && /\bUnsupportedFeature\b/.test(result.stderr), result.stderr);
              assert.equal(result.stdout.length, 0, 'Unsupported input emits no bytes');
            }
            return { status: 'expected_unsupported', code: 'UnsupportedFeature' };
          }
          if (core) {
            const result = await decodePlanarImage(core, official);
            checkFrame(result.frame, item);
            assert.equal(result.scans?.length ?? 1, item.scans);
            compare(result.samples, expected);
          } else {
            const result = native.run(['decode', '-', '-', 'raw-le', '4096'], official);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(result.stdout, nativeRaw(expected, item.bits));
          }
          return { status: 'passed', samples: expected.length, maxAbsoluteError: row.reference.maxAbsoluteError };
        });
        const encode = outside ? { status: 'not_run', reason: 'outside current interleave/subsampling scope' } : await classified(async () => {
          let bytes;
          if (core) {
            const { width, height, bits, near, preset, components } = item;
            const frame = components > 1
              ? { width, height, bits, near, ...(preset && { preset }), components: Array.from({ length: components }, (_, i) => ({ id: i + 1 })) }
              : { width, height, bits, near, ...(preset && { preset }) };
            bytes = Buffer.from((await encodePlanarImage(core, frame, original)).bytes);
          } else {
            const flags = item.preset ? Object.entries(item.preset).flatMap(([name, value]) => [`--${name}`, String(value)]) : [];
            const cmdArgs = item.components > 1
              ? ['encode-planar', ...[item.width, item.height, item.bits, item.components, item.near].map(String), '-', '-', 'raw-le', '4096', ...flags]
              : ['encode', ...[item.width, item.height, item.bits, item.near].map(String), '-', '-', 'raw-le', '4096', ...flags];
            const result = native.run(cmdArgs, nativeRaw(original, item.bits));
            assert.equal(result.status, 0, result.stderr);
            bytes = result.stdout;
          }
          if (canonicalEncoded === null) canonicalEncoded = bytes;
          else assert.ok(bytes.equals(canonicalEncoded), `${item.test_id} ${backend}: cross-backend encoded byte mismatch`);
          checkPreset(bytes, item);
          if (core) {
            const inspected = await inspectStream(core, bytes);
            assert.equal(inspected.scans?.length ?? 1, item.scans);
          }
          const actual = await reference.decode(bytes, item);
          compare(actual, item.near ? expected : original);
          return { status: 'passed', samples: actual.length, maxAbsoluteError: compare(actual, original, item.near),
            bytes: bytes.length, sha256: sha256(bytes) };
        });
        row.backends[backend] = { encode, decode };
        failed ||= encode.status === 'failed' || decode.status === 'failed';
      }
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
  const sourceRevision = git.status === 0 ? git.stdout.toString().trim() : null;
  const diff = child('git', ['status', '--porcelain', '--', 'core', 'cmd', 'sdk', 'moon.mod'], { cwd: root });
  const sourceDirty = diff.status === 0 ? diff.stdout.length > 0 : null;
  process.stdout.write(`${JSON.stringify({ standard: manifest.standard, sourceRevision, sourceDirty, node: process.version,
    command: ['node', 'scripts/validate_annex_e.mjs', ...args], fixtureArchive: manifest.fixtureArchive,
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
