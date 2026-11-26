import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeStream, encodePlanarImage, loadCore } from '../sdk/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const referencePath = new URL('./sampled_point_transform_reference.py', import.meta.url);
const chunks = [1, 7, 4096];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function integerBytes(samples, width = 2, big = false) {
  const bytes = Buffer.alloc(samples.length * width);
  for (const [i, sample] of samples.entries()) {
    if (big) bytes.writeUIntBE(sample, i * width, width);
    else bytes.writeUIntLE(sample, i * width, width);
  }
  return bytes;
}

function invoke(command, args, input) {
  const run = spawnSync(command, args, { input, cwd: root, timeout: 30000, maxBuffer: 16 * (1 << 20) });
  if (run.error) throw run.error;
  return { exitCode: run.status, output: run.stdout, stderr: run.stderr.toString().replaceAll('\0', '').trim() };
}

function pythonReference(python, fields) {
  const result = invoke(python, [fileURLToPath(referencePath)], JSON.stringify(fields));
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.output);
}

function dimensions(frame) {
  const { width, height, components } = frame;
  const maxH = Math.max(...components.map((c) => c.hSampling));
  const maxV = Math.max(...components.map((c) => c.vSampling));
  return components.map((c) => [Math.ceil(width * c.hSampling / maxH), Math.ceil(height * c.vSampling / maxV)]);
}

function caseMatrix() {
  const geometries = [
    { bits: 8, width: 5, height: 5, pt: 2, factors: [[2, 4], [1, 3], [2, 1]] },
    { bits: 12, width: 11, height: 9, pt: 4, factors: [[4, 4], [2, 3], [1, 2]] },
    { bits: 16, width: 13, height: 11, pt: 5, factors: [[3, 3], [2, 2], [1, 1]] },
  ];
  const components = (factors) => factors.map(([hSampling, vSampling], i) => ({ id: i + 1, hSampling, vSampling }));
  const cases = geometries.flatMap(({ bits, width, height, pt, factors }, i) => [0, 1].flatMap((ilv) => [0, 3].map((near) => {
    const frame = { bits, width, height, components: components(factors) };
    const scans = ilv ? [{ ids: [1, 2, 3], ilv, near, pt }]
      : [1, 2, 3].map((id) => ({ ids: [id], ilv, near, pt }));
    return { name: 'p' + bits + '-ilv' + ilv + '-near' + near, frame, scans, seed: 0xacd0 + i * 16 + ilv * 4 + near, nativeEncode: true };
  })));
  cases.push({
    name: 'p12-explicit-lse1',
    frame: { bits: 12, width: 7, height: 5, components: components([[2, 2], [1, 1]]) },
    scans: [{ ids: [1, 2], ilv: 1, pt: 2, near: 3, lse: [0, 10, 18, 40, 32] }],
    seed: 73, nativeEncode: true,
  });
  cases.push({
    name: 'p8-ilv2-equal-one-pixel-planes',
    frame: { bits: 8, width: 1, height: 1, components: components([[2, 2], [1, 1]]) },
    scans: [{ ids: [1, 2], ilv: 2, pt: 2, near: 0 }],
    seed: 255, nativeEncode: true,
  });
  cases.push({
    name: 'p12-sampled-hybrid',
    frame: { bits: 12, width: 9, height: 7, components: components([[2, 2], [1, 1], [1, 1]]) },
    scans: [{ ids: [2, 3], ilv: 2, pt: 4, near: 3 }, { ids: [1], ilv: 0, pt: 2, near: 0 }],
    seed: 19, nativeEncode: false,
  });
  cases.push({
    name: 'p16-ilv1-wide-reconstruction',
    frame: { bits: 16, width: 5, height: 5, components: components([[2, 4], [1, 3], [2, 1]]) },
    scans: [{ ids: [1, 2, 3], ilv: 1, pt: 2, near: 2 }],
    seed: 49, nativeEncode: true, wide: true,
  });
  return cases;
}

function deliveryPlan({ frame, scans }, sizes) {
  const order = [];
  const place = (c, y, scanIndex) => order.push([c, y, sizes[c][0], scanIndex]);
  for (const [s, scan] of scans.entries()) {
    const indices = scan.ids.map((id) => frame.components.findIndex((c) => c.id === id));
    if (scan.ilv === 1) {
      const maxV = Math.max(...frame.components.map((c) => c.vSampling));
      for (let mcu = 0; mcu < Math.ceil(frame.height / maxV); mcu++) {
        for (const c of indices) {
          const v = frame.components[c].vSampling;
          for (let y = mcu * v; y < Math.min((mcu + 1) * v, sizes[c][1]); y++) place(c, y, s);
        }
      }
    } else {
      for (let y = 0; y < sizes[indices[0]][1]; y++) {
        for (const c of indices) place(c, y, s);
      }
    }
  }
  return order;
}

function assertReference(caseSpec, expected, data) {
  assert.deepEqual(data.frame, caseSpec.frame, caseSpec.name + ' frame');
  assert.deepEqual(data.padding, expected.padding, caseSpec.name + ' coded padding');
  let lse = [0, 0, 0, 0, 0];
  assert.equal(data.scans.length, caseSpec.scans.length, caseSpec.name + ' scan count');
  for (const [index, scan] of caseSpec.scans.entries()) {
    const actual = data.scans[index];
    for (const key of ['ids', 'near', 'ilv', 'pt']) assert.deepEqual(actual[key], scan[key]);
    lse = scan.lse ?? lse;
    const defaultMax = 2 ** caseSpec.frame.bits - 1;
    assert.equal(actual.lse[0] || defaultMax, lse[0] || defaultMax);
    for (const field of [1, 2, 3, 4]) {
      if (lse[field]) assert.equal(actual.lse[field], lse[field], 'explicit LSE1 override ' + field);
    }
  }
}

function errors(caseSpec, original, reconstructed) {
  return reconstructed.map((samples, c) => {
    const { pt, near } = caseSpec.scans.find((s) => s.ids.includes(caseSpec.frame.components[c].id));
    const step = 2 ** pt;
    const bound = step * near + step - 1;
    let coded = 0;
    let originalDomain = 0;
    assert.equal(samples.length, original[c].length);
    for (const [i, sample] of samples.entries()) {
      assert.equal(sample % step, 0);
      const x = original[c][i];
      coded = Math.max(coded, Math.abs(Math.floor(x / step) - sample / step));
      originalDomain = Math.max(originalDomain, Math.abs(x - sample));
    }
    assert.ok(coded <= near && originalDomain <= bound, caseSpec.name + ' error bound');
    return { coded, near, original: originalDomain, originalBound: bound };
  });
}

function sdkFrame({ frame, scans }) {
  return {
    ...frame,
    scans: scans.map(({ ids, ilv, near, pt, lse }) => ({
      componentIds: ids, interleave: ilv, near, pointTransform: pt,
      ...(lse ? { maxval: lse[0], preset: { t1: lse[1], t2: lse[2], t3: lse[3], reset: lse[4] } } : {}),
    })),
  };
}

function nativeInvocation(file, distro) {
  const binary = resolve(file);
  if (!distro) return { binary, path: (path) => path, run: (args, input) => invoke(binary, args, input) };
  const prefix = ['--distribution', distro, '--exec'];
  function path(input) {
    const result = invoke('wsl.exe', [...prefix, 'wslpath', '-a', '-u', input]);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.output.toString().trim();
  }
  const posix = path(binary);
  return { binary, path, run: (args, input) => invoke('wsl.exe', [...prefix, posix, ...args], input) };
}

function flattenDelivery(planes, plan) {
  return plan.flatMap(([c, y, width]) => planes[c].slice(y * width, (y + 1) * width));
}

async function sdkDecoded(core, caseSpec, bytes, plan, chunk, stageEoi = false) {
  const positions = [];
  const rows = [];
  const planes = caseSpec.frame.components.map(() => []);
  const cutoff = bytes.length - 2;
  let offset = 0;
  let beforeEoi = null;
  const result = await decodeStream(core, {
    inputChunkSize: chunk,
    ...(caseSpec.wide ? { sampleFormat: 'u32' } : {}),
    read(maximum) {
      if (offset === bytes.length) return null;
      if (stageEoi && offset === cutoff && beforeEoi === null) beforeEoi = positions.length;
      const boundary = stageEoi && offset < cutoff ? cutoff : bytes.length;
      const stop = Math.min(offset + maximum, boundary);
      const next = bytes.subarray(offset, stop);
      offset = stop;
      return next;
    },
    onRow(row, index, _frame, _stats, _preset, fields) {
      const c = fields.componentIndex;
      const scan = caseSpec.scans[fields.scanIndex];
      assert.equal(fields.componentId, caseSpec.frame.components[c].id);
      assert.equal(fields.pointTransform, scan.pt);
      assert.equal(fields.near, scan.near);
      assert.equal(fields.width, row.length);
      assert.equal(fields.stride, row.length);
      assert.equal(fields.height, dimensions(caseSpec.frame)[c][1]);
      assert.equal(fields.sampleBytes, caseSpec.wide ? 4 : 2);
      assert.equal(fields.endianness, caseSpec.wide ? 'host-u32' : 'host-u16');
      positions.push([c, index, row.length, fields.scanIndex]);
      rows.push(...row);
      planes[c].push(...row);
    },
  });
  assert.deepEqual(positions, plan, caseSpec.name + ' row lifecycle');
  assert.equal(result.stats.rows, plan.length);
  if (stageEoi) assert.equal(beforeEoi, plan.length, 'all valid rows before EOI');
  return { planes, rows, beforeEoi };
}

function assertNativeDecode(native, caseSpec, stream, expected, plan, chunk) {
  const args = ['decode', '-', '-', caseSpec.wide ? 'raw32-le' : 'raw-le', String(chunk)];
  const decoded = native.run(args, stream);
  assert.equal(decoded.exitCode, 0, decoded.stderr);
  const width = caseSpec.wide ? 4 : caseSpec.frame.bits <= 8 ? 1 : 2;
  assert.deepEqual(decoded.output, integerBytes(flattenDelivery(expected, plan), width),
    caseSpec.name + ' Native decoded range or row order');
  return { chunk, command: ['moonjls', ...args], exitCode: decoded.exitCode, rowSamplesSha256: hash(decoded.output) };
}

async function calibration(python, fixtures) {
  const manifest = JSON.parse(await readFile(join(root, 'tests/conformance/manifest.json'), 'utf8'));
  const receipt = await readFile(join(root, 'reports/t87-m3b-20261126/annex-e-final-hp.json'));
  const hpReceiptSha256 = 'a0bbe83fdef589eadc2e1f735c0944b3b17348d516ec15e53f796a84b9a2bb88';
  assert.equal(hash(receipt), hpReceiptSha256, 'frozen HP 1.00 reconstruction receipt');
  const hp = JSON.parse(receipt);
  const items = [7, 8].map((number) => manifest.cases.find((entry) => entry.id === number));
  const streams = await Promise.all(items.map((item) => readFile(join(fixtures, item.file))));
  const decoded = pythonReference(python, { mode: 'decode', streams: streams.map((value) => value.toString('hex')) });
  const cases = await Promise.all(decoded.map(async (value, i) => {
    const item = items[i];
    assert.equal(hash(streams[i]), item.sha256, item.file);
    const expected = hp.cases.find((row) => row.id === item.id).reference.planarU16leSha256;
    assert.equal(hash(integerBytes(value.samples.flat())), expected, item.file + ' HP reconstruction');
    const source = await Promise.all(item.sourceFiles.map(async (name, c) => {
      const bytes = await readFile(join(fixtures, name));
      assert.equal(hash(bytes), manifest.sourceFiles[name].sha256, name);
      return Array.from(bytes.subarray(-value.samples[c].length));
    }));
    return { ...value, source };
  }));
  const rebuilt = pythonReference(python, { mode: 'build', cases });
  return rebuilt.map((value, i) => {
    assert.deepEqual(Buffer.from(value.stream, 'hex'), streams[i], items[i].file + ' independent exact encoding');
    assert.deepEqual(value.samples, decoded[i].samples, items[i].file + ' encoder reconstruction');
    return { id: items[i].test_id, file: items[i].file, bytes: streams[i].length,
      encodedSha256: hash(streams[i]), reconstructionSha256: hash(integerBytes(value.samples.flat())),
      samples: value.samples.reduce((sum, plane) => sum + plane.length, 0), pt: 0, hpReceiptSha256 };
  });
}

async function validateCase(python, native, backends, caseSpec, expected, temp, checkInvalid) {
  const sizes = dimensions(caseSpec.frame);
  const plan = deliveryPlan(caseSpec, sizes);
  const stream = Buffer.from(expected.stream, 'hex');
  const alternate = expected.alternate && Buffer.from(expected.alternate.stream, 'hex');
  const cv = pythonReference(python, { mode: 'decode', streams: [expected.stream, ...(alternate ? [expected.alternate.stream] : [])] });
  assertReference(caseSpec, expected, cv[0]);
  assert.deepEqual(cv[0].samples, expected.samples);
  const error = errors(caseSpec, expected.source, cv[0].samples);
  const sampleBytes = caseSpec.wide ? 4 : 2;
  if (caseSpec.wide) assert.equal(cv[0].samples[0][0], 65540, 'independent wide reconstruction');
  if (alternate) {
    assertReference(caseSpec, expected, cv[1]);
    assert.deepEqual(cv[1].samples, expected.alternate.samples);
    errors(caseSpec, expected.source, cv[1].samples);
  }
  const actual = { id: caseSpec.name, frame: caseSpec.frame, scans: caseSpec.scans, seed: caseSpec.seed,
    dimensions: sizes, validRows: plan.length, validSamples: expected.samples.flat().length, paddingByScan: expected.padding, error,
    sampleBytes,
    originalSamplesSha256: hash(integerBytes(expected.source.flat())), referenceSha256: hash(stream),
    reconstructedSha256: hash(integerBytes(expected.samples.flat(), sampleBytes)), backends: {} };
  if (alternate) actual.alternatePadding = { streamSha256: hash(alternate), reconstructedSha256: hash(integerBytes(cv[1].samples.flat(), sampleBytes)) };

  const candidateStreams = [];
  const registerCandidate = (record, encoded, exactBytes) => {
    candidateStreams.push({ record, encoded });
    Object.assign(record, { bytes: encoded.length, sha256: hash(encoded), exactReferenceBytes: encoded.equals(exactBytes) });
  };

  for (const [name, core] of backends) {
    const receipt = { decode: [], encode: [], alternatePadding: [] };
    actual.backends[name] = receipt;
    const planes = expected.source.map((plane) => Uint16Array.from(plane));
    for (const chunk of chunks) {
      const canonical = await sdkDecoded(core, caseSpec, stream, plan, chunk);
      assert.deepEqual(canonical.planes, cv[0].samples);
      receipt.decode.push({ chunk, reconstructionSha256: hash(integerBytes(canonical.planes.flat(), sampleBytes)) });
      if (alternate) {
        const distinct = await sdkDecoded(core, caseSpec, alternate, plan, chunk, chunk === 1);
        assert.deepEqual(distinct.planes, cv[1].samples);
        receipt.alternatePadding.push({ chunk, beforeEoi: distinct.beforeEoi,
          reconstructionSha256: hash(integerBytes(distinct.planes.flat(), sampleBytes)) });
      }
      const { bytes } = await encodePlanarImage(core, sdkFrame(caseSpec), planes, { inputChunkSize: chunk, outputChunkSize: chunk });
      const record = { chunk };
      registerCandidate(record, Buffer.from(bytes), stream);
      receipt.encode.push(record);
    }
  }

  if (native) {
    const receipt = { decode: [], encode: [], alternatePadding: [] };
    actual.backends.native = receipt;
    let inputs = [];
    if (caseSpec.nativeEncode) {
      const base = native.path(temp);
      inputs = await Promise.all(sizes.map(async ([width, height], c) => {
        const name = caseSpec.name + '-' + c + '.pgm';
        const maximum = 2 ** caseSpec.frame.bits - 1;
        const bytes = Buffer.concat([Buffer.from('P5\n' + width + ' ' + height + '\n' + maximum + '\n'),
          integerBytes(expected.source[c], maximum <= 255 ? 1 : 2, true)]);
        await writeFile(join(temp, name), bytes);
        return base.replace(/[/\\]+$/, '') + '/' + name;
      }));
    } else {
      receipt.encodeStatus = 'not_applicable';
      receipt.encodeScope = 'Native CLI does not expose mixed ILV or per-scan Pt for sampled PGM inputs';
    }
    for (const chunk of chunks) {
      receipt.decode.push(assertNativeDecode(native, caseSpec, stream, cv[0].samples, plan, chunk));
      if (alternate) receipt.alternatePadding.push(assertNativeDecode(native, caseSpec, alternate, cv[1].samples, plan, chunk));
      if (!inputs.length) continue;
      const scan = caseSpec.scans[0];
      const flags = ['--pt', String(scan.pt), '--ilv', String(scan.ilv), '--chunk', String(chunk), '--sampling',
        caseSpec.frame.components.map((c) => c.hSampling + 'x' + c.vSampling).join(',')];
      if (scan.lse) for (const [index, flag] of ['t1', 't2', 't3', 'reset'].entries()) flags.push('--' + flag, String(scan.lse[index + 1]));
      const args = ['encode-pgms', String(scan.near), '-', ...flags];
      const encoded = native.run([...args, ...inputs]);
      assert.equal(encoded.exitCode, 0, caseSpec.name + ': ' + encoded.stderr);
      const record = { chunk, command: ['moonjls', ...args, ...inputs.map((_, c) => '<plane' + c + '.pgm>')], exitCode: encoded.exitCode };
      registerCandidate(record, encoded.output, stream);
      receipt.encode.push(record);
    }
  }

  if (caseSpec.wide) {
    actual.wideWitness = { componentId: caseSpec.frame.components[0].id, x: 0, y: 0, reconstructed: cv[0].samples[0][0] };
    actual.narrowRejected = {};
    for (const [name, core] of backends) {
      await assert.rejects(sdkDecoded(core, { ...caseSpec, wide: false }, stream, plan, 1), { code: 'UnsupportedFeature' });
      actual.narrowRejected[name] = true;
    }
    if (native) {
      const rejection = native.run(['decode', '-', '-', 'raw-le', '1'], stream);
      assert.notEqual(rejection.exitCode, 0);
      assert.match(rejection.stderr, /output sample range/i);
      actual.narrowRejected.native = { exitCode: rejection.exitCode };
    }
  }

  if (checkInvalid) {
    assert.ok(alternate, 'strict-stream checks require a fixture with alternate coded padding');
    const malformed = [
      ['last coded byte removed', Buffer.concat([alternate.subarray(0, -3), alternate.subarray(-2)])],
      ['trailing byte after EOI', Buffer.concat([alternate, Buffer.of(0)])],
    ];
    actual.invalid = [];
    for (const [label, file] of malformed) {
      const statuses = {};
      for (const [name, core] of backends) {
        await assert.rejects(sdkDecoded(core, caseSpec, file, plan, 1),
          (error) => ['InvalidData', 'Truncated', 'TrailingData'].includes(error.code));
        statuses[name] = 'rejected';
      }
      if (native) {
        const denied = native.run(['decode', '-', '-', 'raw-le', '1'], file);
        assert.notEqual(denied.exitCode, 0);
        statuses.native = { exitCode: denied.exitCode };
      }
      actual.invalid.push({ label, fileSha256: hash(file), statuses });
    }
  }

  const candidates = candidateStreams.map(({ encoded }) => encoded.toString('hex'));
  const unique = [...new Set(candidates)];
  const looks = unique.length ? pythonReference(python, { mode: 'decode', streams: unique }) : [];
  for (const [index, { record }] of candidateStreams.entries()) {
    const referenceDecoded = looks[unique.indexOf(candidates[index])];
    assertReference(caseSpec, expected, referenceDecoded);
    errors(caseSpec, expected.source, referenceDecoded.samples);
    assert.deepEqual(referenceDecoded.samples, cv[0].samples, caseSpec.name + ' independently decoded encode');
    record.independentReconstructionSha256 = hash(integerBytes(referenceDecoded.samples.flat(), sampleBytes));
  }
  return actual;
}

const { values } = parseArgs({ options: {
  'native-exe': { type: 'string' },
  'native-wsl': { type: 'string' },
  'fixtures': { type: 'string' },
  'python': { type: 'string' },
  'reference-only': { type: 'boolean' },
} });
assert.ok(values['native-exe'] || values['reference-only'], 'specify --native-exe or --reference-only');
assert.ok(!values['native-wsl'] || values['native-exe'], '--native-wsl requires --native-exe');
const python = values.python ?? (process.platform === 'win32' ? 'python' : 'python3');
const fixtures = resolve(values.fixtures ?? join(root, '.tools/annex-e'));
const anchors = await calibration(python, fixtures);
const cases = caseMatrix();
const built = pythonReference(python, { mode: 'build', cases });
const native = !values['reference-only'] && nativeInvocation(values['native-exe'], values['native-wsl']);
const backends = values['reference-only'] ? [] : await Promise.all(['js', 'wasm-gc'].map(async (backend) => [backend, await loadCore({ backend })]));
const temp = await mkdtemp(join(tmpdir(), 'moonjls-pt-sampled-'));
try {
  const rows = [];
  for (const [index, caseSpec] of cases.entries()) {
    rows.push(await validateCase(python, native, backends, caseSpec, built[index], temp, caseSpec.name === 'p8-ilv1-near3'));
  }
  const summary = { cases: rows.length };
  for (const name of ['js', 'wasm-gc', 'native']) {
    const exercised = rows.map((row) => row.backends[name]).filter(Boolean);
    if (exercised.length) summary[name] = Object.fromEntries(['encode', 'decode', 'alternatePadding'].map((key) =>
      [key, exercised.reduce((sum, row) => sum + row[key].length, 0)]));
  }
  const artifacts = native ? await Promise.all([
    ['js', new URL('../sdk/generated/core.mjs', import.meta.url)],
    ['wasm-gc', new URL('../sdk/generated/core.wasm', import.meta.url)],
    ['native', native.binary],
  ].map(async ([backend, file]) => [backend, hash(await readFile(file))])) : [];
  const source = invoke('git', ['rev-parse', 'HEAD']);
  const status = invoke('git', ['status', '--porcelain', '--', 'core', 'cmd', 'sdk', 'scripts', 'web', '.github']);
  console.log(JSON.stringify({
    status: native ? 'passed' : 'reference_only', exitCode: 0,
    sourceRevision: source.exitCode === 0 ? source.output.toString().trim() : null,
    sourceDirty: status.exitCode === 0 ? status.output.length > 0 : null,
    node: process.version, python: invoke(python, ['--version']).output.toString().trim(),
    command: ['node', 'scripts/verify_sampled_point_transform.mjs', ...process.argv.slice(2)],
    reference: 'Independently implemented T.87 Annexes A/B/C/F in Python; E.2-7/8 calibrated against official bytes and frozen HP 1.00 sample hashes',
    referenceSha256: hash(await readFile(referencePath)), runnerSha256: hash(await readFile(new URL(import.meta.url))),
    artifacts: Object.fromEntries(artifacts), anchors, summary, cases: rows,
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
