import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePlanarImage, encodePlanarImage, inspectStream, loadCore } from '../sdk/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixtureDir = join(root, 'tests', 'conformance', 'm3a_golden');
const usage = 'Usage: node scripts/verify_m3a_golden.mjs [--native-exe FILE [--native-wsl DISTRO]] [--with-oracle]';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readFixture = (name) => readFile(join(fixtureDir, name));
const chunked = { inputChunkSize: 1, outputChunkSize: 1 };

function parseArgs(args) {
  const options = new Map();
  let withOracle = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--with-oracle') {
      withOracle = true;
      continue;
    }
    const value = args[i + 1];
    if (!['--native-exe', '--native-wsl'].includes(flag) || !value || options.has(flag)) {
      throw new Error(usage);
    }
    options.set(flag, value);
    i++;
  }
  if (options.has('--native-wsl') && !options.has('--native-exe')) {
    throw new Error(usage);
  }
  return { options, withOracle };
}

function runChild(command, args, options = {}) {
  const result = spawnSync(command, args, { timeout: 30_000, ...options });
  if (result.error) throw result.error;
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
      run: (args, input) => runChild(binary, args, { input, cwd: root }),
    };
  }
  const baseArgs = ['--distribution', distro, '--exec'];
  const converted = runChild('wsl.exe', [...baseArgs, 'wslpath', '-a', '-u', binary]);
  assert.equal(converted.status, 0, converted.stderr);
  const wslBinary = converted.stdout.toString('utf8').trim();
  const rootConverted = runChild('wsl.exe', [...baseArgs, 'wslpath', '-a', '-u', root]);
  assert.equal(rootConverted.status, 0, rootConverted.stderr);
  const wslRoot = rootConverted.stdout.toString('utf8').trim();
  return {
    binary,
    run: (args, input) => runChild('wsl.exe', ['--distribution', distro, '--cd', wslRoot, '--exec', wslBinary, ...args], { input }),
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

async function verifyHashes(manifest) {
  let verifiedFiles = 0;
  for (const item of manifest.cases) {
    for (const [filename, expectedDigest] of Object.entries(item.sha256)) {
      const bytes = await readFixture(filename);
      assert.equal(sha256(bytes), expectedDigest, `Frozen SHA-256 mismatch for ${filename}`);
      verifiedFiles++;
    }
  }
  for (const item of manifest.invalidStreams) {
    const bytes = await readFixture(item.input);
    assert.equal(sha256(bytes), item.sha256, `Frozen SHA-256 mismatch for ${item.input}`);
    verifiedFiles++;
  }
  return verifiedFiles;
}

function checkDecodedResult(dec, item, referenceSamples, label) {
  const { frame } = item;
  const compCount = frame.components.length;
  const planePx = frame.width * frame.height;
  assert.equal(dec.frame.width, frame.width, `${label}: width`);
  assert.equal(dec.frame.height, frame.height, `${label}: height`);
  assert.equal(dec.frame.bits, frame.bits, `${label}: bits`);
  assert.equal(dec.frame.components.length, compCount, `${label}: componentCount`);
  assert.equal(dec.scans.length, compCount, `${label}: scanCount`);

  if (item.expectedScanOrder) {
    assert.deepEqual(dec.scans.map((s) => s.componentId), item.expectedScanOrder, `${label}: scanOrder`);
  }
  if (item.expectedComponentIndices) {
    assert.deepEqual(dec.scans.map((s) => s.componentIndex), item.expectedComponentIndices, `${label}: componentIndices`);
  }
  if (item.expectedScanNears) {
    assert.deepEqual(dec.scans.map((s) => s.near), item.expectedScanNears, `${label}: scanNears`);
  }
  if (item.expectedScanPresets) {
    item.expectedScanPresets.forEach((expectedPreset, idx) => {
      assert.deepEqual(dec.scans[idx].preset, expectedPreset, `${label}: scan[${idx}].preset`);
    });
  }
  if (item.expectedMarkerCodes) {
    assert.deepEqual(dec.structure.markers.map((m) => m.code), item.expectedMarkerCodes, `${label}: markers`);
  }

  const scanNears = item.expectedScanNears ?? Array(compCount).fill(frame.near ?? 0);
  if (item.kind === 'decode_reference_samples') {
    assert.deepEqual([...dec.samples], [...referenceSamples], `${label}: exact samples`);
  } else {
    for (let c = 0; c < compCount; c++) {
      const tol = scanNears[c];
      for (let i = 0; i < planePx; i++) {
        const idx = c * planePx + i;
        const delta = Math.abs(dec.samples[idx] - referenceSamples[idx]);
        assert.ok(delta <= tol, `${label}: c=${c} idx=${i} delta=${delta} > near=${tol}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const { options, withOracle } = parseArgs(args);
  const manifest = JSON.parse(await readFixture('manifest.json'));
  const verifiedFiles = await verifyHashes(manifest);

  const cores = new Map([
    ['js', await loadCore({ backend: 'js' })],
    ['wasm-gc', await loadCore({ backend: 'wasm-gc' })],
  ]);
  const native = options.has('--native-exe')
    ? createNativeRunner(options.get('--native-exe'), options.get('--native-wsl'))
    : null;

  let oracle = null;
  if (withOracle) {
    const { createOracle } = await import('./oracle.mjs');
    oracle = await createOracle();
  }

  let positiveChecks = 0;
  let oracleChecks = 0;

  try {
    for (const item of manifest.cases) {
      const refStream = await readFixture(item.reference);
      const refSamples = item.referenceSamples
        ? readSamplesLe(await readFixture(item.referenceSamples))
        : readSamplesLe(await readFixture(item.input));

      let canonicalStream = null;
      let canonicalDecoded = null;

      for (const [backend, core] of cores) {
        for (const [modeName, opts] of [['normal', undefined], ['chunked', chunked]]) {
          const dec = await decodePlanarImage(core, refStream, opts);
          checkDecodedResult(dec, item, refSamples, `${backend}/${modeName}/${item.id}`);
          if (!canonicalDecoded) canonicalDecoded = dec.samples;
          else assert.deepEqual([...dec.samples], [...canonicalDecoded], `${backend}/${modeName}/${item.id}: ref decode mismatch`);
        }

        if (item.kind === 'roundtrip_and_reference') {
          const { frame } = item;
          const compCount = frame.components.length;
          const planePx = frame.width * frame.height;
          const planes = Array.from({ length: compCount }, (_, c) => refSamples.subarray(c * planePx, (c + 1) * planePx));
          const enc = await encodePlanarImage(core, frame, planes);
          const encBytes = Buffer.from(enc.bytes);
          assert.ok(encBytes.equals(refStream), `${backend}/${item.id}: encoded bytes differ from frozen golden stream`);
          canonicalStream ??= encBytes;
          const decRt = await decodePlanarImage(core, encBytes);
          checkDecodedResult(decRt, item, refSamples, `${backend}/rt/${item.id}`);
        }
        positiveChecks++;
      }

      if (native) {
        const decRes = native.run(['decode', '-', '-', 'raw-le', '4096'], refStream);
        assert.equal(decRes.status, 0, `native/${item.id} decode failed: ${decRes.stderr}`);
        const compCount = item.frame.components.length;
        const planePx = item.frame.width * item.frame.height;
        const compIds = item.frame.components.map((c) => c.id);
        const scanOrder = item.expectedScanOrder ?? compIds;
        const expectedScanStreamSamples = new Uint16Array(planePx * compCount);
        scanOrder.forEach((cid, sIdx) => {
          const cIdx = compIds.indexOf(cid);
          expectedScanStreamSamples.set(canonicalDecoded.subarray(cIdx * planePx, (cIdx + 1) * planePx), sIdx * planePx);
        });
        assert.deepEqual(
          [...unpackNativeRaw(decRes.stdout, item.frame.bits)],
          [...expectedScanStreamSamples],
          `native/${item.id}: decode mismatch`,
        );

        if (item.expectedScanOrder) {
          const evidenceBase = join(root, '.evidence');
          await mkdir(evidenceBase, { recursive: true });
          const tempDir = await mkdtemp(join(evidenceBase, 'm3a-pgms-'));
          try {
            const relDir = relative(root, tempDir).replace(/\\/g, '/');
            const outFiles = Array.from({ length: compCount }, (_, c) => `${relDir}/c${c}.pgm`);
            const jlsRel = `${relDir}/in.jls`;
            await (await import('node:fs/promises')).writeFile(join(root, jlsRel), refStream);
            const pgmsRes = native.run(['decode-pgms', jlsRel, ...outFiles]);
            assert.equal(pgmsRes.status, 0, `native/${item.id} decode-pgms failed: ${pgmsRes.stderr}`);
            for (let c = 0; c < compCount; c++) {
              const pgm = await readFile(join(root, outFiles[c]));
              const hdr = Buffer.from(`P5\n${item.frame.width} ${item.frame.height}\n${item.frame.maxval ?? (2 ** item.frame.bits - 1)}\n`, 'ascii');
              assert.deepEqual(pgm.subarray(0, hdr.length), hdr);
              const body = pgm.subarray(hdr.length);
              const decodedPlane = item.frame.bits <= 8
                ? Uint16Array.from(body)
                : Uint16Array.from({ length: planePx }, (_, i) => body.readUInt16BE(i * 2));
              assert.deepEqual([...decodedPlane], [...canonicalDecoded.subarray(c * planePx, (c + 1) * planePx)]);
            }
          } finally {
            await rm(tempDir, { recursive: true, force: true });
          }
        }

        const inspRes = native.run(['inspect', '-', '4096', '--json'], refStream);
        assert.equal(inspRes.status, 0, `native/${item.id} inspect failed: ${inspRes.stderr}`);
        const meta = JSON.parse(inspRes.stdout.toString('utf8'));
        assert.equal(meta.componentCount, compCount);
        assert.equal(meta.scanCount, compCount);
        assert.equal(meta.eoiOffset, refStream.length - 2);
        if (item.expectedMarkerCodes) {
          assert.deepEqual(meta.markers.map((m) => m.code), item.expectedMarkerCodes);
        }

        if (item.kind === 'roundtrip_and_reference') {
          const { frame } = item;
          const orderedSamples = new Uint16Array(planePx * compCount);
          scanOrder.forEach((cid, sIdx) => {
            const cIdx = compIds.indexOf(cid);
            orderedSamples.set(refSamples.subarray(cIdx * planePx, (cIdx + 1) * planePx), sIdx * planePx);
          });
          const cliArgs = [
            'encode-planar',
            String(frame.width), String(frame.height), String(frame.bits), String(compCount), String(frame.near ?? 0),
            '-', '-', 'raw-le', '4096',
            '--comp-ids', compIds.join(','),
            '--scan-order', scanOrder.join(','),
          ];
          if (frame.maxval !== undefined) cliArgs.push('--maxval', String(frame.maxval));
          const encRes = native.run(cliArgs, nativeRaw(orderedSamples, frame.bits));
          assert.equal(encRes.status, 0, `native/${item.id} encode-planar failed: ${encRes.stderr}`);
          assert.ok(encRes.stdout.equals(refStream), `native/${item.id}: encoded stream differs from JS/Wasm GC`);
        }
        positiveChecks++;
      }

      if (oracle && item.oracleVerified) {
        const oDec = oracle.decode(refStream);
        assert.equal(oDec.frame.components, item.frame.components.length);
        assert.deepEqual([...oDec.pixels], [...canonicalDecoded], `oracle/${item.id}: CharLS Wasm decode mismatch`);
        oracleChecks++;
      }
    }

    for (const neg of manifest.invalidStreams) {
      const bytes = await readFixture(neg.input);
      for (const [backend, core] of cores) {
        await assert.rejects(
          decodePlanarImage(core, bytes),
          { code: neg.expectedCode },
          `${backend}/${neg.id}: expected ${neg.expectedCode}`,
        );
      }
      if (native) {
        const res = native.run(['decode', '-', '-', 'raw-le', '4096'], bytes);
        assert.notEqual(res.status, 0, `native/${neg.id}: unexpectedly succeeded`);
        assert.ok(res.stderr.includes(neg.expectedCode), `native/${neg.id}: expected ${neg.expectedCode} in stderr, got ${res.stderr}`);
      }
    }

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      verifiedFrozenFiles: verifiedFiles,
      positiveCases: manifest.cases.length,
      negativeCases: manifest.invalidStreams.length,
      backendChecks: positiveChecks,
      oracleChecks,
      backends: ['js', 'wasm-gc', ...(native ? ['native'] : [])],
    }, null, 2)}\n`);
  } finally {
    oracle?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
