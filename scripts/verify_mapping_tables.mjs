import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decodePlanarImage, encodeImage, loadCore } from '../sdk/index.mjs';
import { createVerificationReport } from '../sdk/verification-report.mjs';

const { values: options } = parseArgs({
  options: { 'native-exe': { type: 'string' }, 'native-wsl': { type: 'string' } },
});
const hex = (text) => Buffer.from(text, 'hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stream = (...parts) => Buffer.concat(parts);
const eoi = hex('ffd9');
const gray2 = hex('ffd8fff7000b020001000401011100');
const gray16 = hex('ffd8fff7000b100001000701011100');
const multi2 = hex('ffd8fff7000e0200010004020911002a1100');
const lowIndices = [0, 3, 1, 2];
const lowMapped = [201, 234, 212, 223];
const highMapped = [201, 190, 132, 113, 124, 135, 146];

function mapSegment(entries, { kind = 2, tid = 7, width = 1 } = {}) {
  const header = Buffer.from([0xff, 0xf8, 0, 0, kind, tid, width]);
  header.writeUInt16BE(5 + entries.length, 2);
  return stream(header, Buffer.from(entries));
}

function grayScan({ component = 1, tid = 7, pt = 0, codes = 'a780' } = {}) {
  return stream(Buffer.from([0xff, 0xda, 0, 8, 1, component, tid, 0, 0, pt]), hex(codes));
}

const map = [201, 212, 223, 234];
const replacement = [39, 28, 17, 6];
const large = Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 11 + 201) % 256));
const first = mapSegment(large.subarray(0, 65530));
const rest = large.subarray(65530);
const last = mapSegment(rest, { kind: 3 });
const highScan = grayScan({ codes: 'a00423865002008000' });
const cases = [
  ['P2 mapped above MAXVAL', stream(gray2, mapSegment(map), grayScan(), eoi), lowMapped, [[7]], [2]],
  ['P16 continuation', stream(gray16, first, last, highScan, eoi), highMapped, [[7]], [2, 3]],
  ['P16 continuation with fill', stream(gray16, first, hex('ff'), last, highScan, eoi), highMapped, [[7]], [2, 3]],
  ['reuse across scans', stream(multi2, mapSegment(map), grayScan({ component: 9 }), grayScan({ component: 42 }), eoi),
    [...lowMapped, ...lowMapped], [[7], [7]], [2]],
  ['replace across scans', stream(multi2, mapSegment(map), grayScan({ component: 9 }), mapSegment(replacement), grayScan({ component: 42 }), eoi),
    [...lowMapped, 39, 6, 28, 17], [[7], [7]], [2, 2]],
  // One full joint run yields index zero in both components. Only ID 9 maps it.
  ['per-component selectors in ILV2', stream(hex('ffd8fff7000e0200010001020911002a1100'), mapSegment(map),
    hex('ffda000a0209072a0000020080ffd9')), [201, 0], [[7, 0]], [2]],
  // LSE1 supplies MAXVAL=2. The three-entry LSE2 occurs before the frame.
  ['pre-frame table with explicit MAXVAL', stream(hex('ffd8'), mapSegment([241, 37, 9]),
    hex('fff7000b020001000101011100fff8000d0100020000000000000000'),
    grayScan({ codes: '80' }), eoi), [241], [[7]], [2]],
  ['unreferenced two-byte table', stream(gray2, mapSegment([0, 1, 0, 2], { width: 2 }), grayScan({ tid: 0 }), eoi),
    lowIndices, [[]], [2]],
];
// Independent CharLS index and extracted-table witnesses for the two main formats.
assert.equal(sha256(cases[0][1]), 'fe78a55aece2854a06b9a28d088f6cfe8fc630e135759026e80508c887d13cfc');
assert.equal(sha256(cases[1][1]), '470f3b821aea0990b763f90f82599f677eb291290640c08413e90affc45a61af');
assert.equal(sha256(cases[4][1]), 'b9c8dae5ca1cec4ae01eeac2cfca55ad99495a04822a5142a62e24935c5a25f3');

const malformed = [
  ['external table required', stream(gray2, grayScan(), eoi), 'UnsupportedFeature'],
  ['unsupported opaque width', stream(gray2, mapSegment([0, 1, 0, 2, 0, 3, 0, 4], { width: 2 }), grayScan(), eoi), 'UnsupportedFeature'],
  ['nonzero Pt', stream(gray2, mapSegment(map), grayScan({ pt: 1 }), eoi), 'InvalidData'],
  ['too few entries', stream(gray2, mapSegment(map.slice(0, 3)), grayScan(), eoi), 'InvalidData'],
  ['too many entries', stream(gray2, mapSegment([...map, 0]), grayScan(), eoi), 'InvalidData'],
  ['missing continuation', stream(gray16, first, highScan, eoi), 'InvalidData'],
  ['orphan continuation', stream(gray16, last, highScan, eoi), 'InvalidData'],
  ['wrong continuation TID', stream(gray16, first, mapSegment(rest, { kind: 3, tid: 8 }), highScan, eoi), 'InvalidData'],
  ['wrong continuation Wt', stream(gray16, first, mapSegment(rest, { kind: 3, width: 2 }), highScan, eoi), 'InvalidData'],
  ['interrupted continuation', stream(gray16, first, hex('fffe0002'), last, highScan, eoi), 'InvalidData'],
  ['short initial segment', stream(gray2, mapSegment(map.slice(0, 2)), mapSegment(map.slice(2), { kind: 3 }), grayScan(), eoi), 'InvalidData'],
  ['truncated continuation', stream(gray16, first, last.subarray(0, -1)), 'Truncated'],
  ['late trailing byte', stream(cases[0][1], hex('20')), 'TrailingData'],
];

function createNativeRunner(path, distro) {
  const binary = resolve(path);
  if (!distro) return { command: binary, prefix: [] };
  const prefix = ['--distribution', distro, '--exec'];
  const converted = spawnSync('wsl.exe', [...prefix, 'wslpath', '-a', '-u', binary], { encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  return { command: 'wsl.exe', prefix: [...prefix, converted.stdout.trim()] };
}

function tableMarkers(structure) {
  return structure.markers.filter((marker) => marker.code === 0xf8 && [2, 3].includes(marker.detail)).map((marker) => marker.detail);
}

function assertStructure(structure, selectors, markers, label) {
  assert.deepEqual(structure.scans.map((scan) => scan.mappingSelectors ?? []), selectors, label);
  assert.deepEqual(tableMarkers(structure), markers, label);
}

const cores = await Promise.all(['js', 'wasm-gc'].map(async (name) => [name, await loadCore(name)]));
const chunks = [1, 7, 4096];
for (const [backend, core] of cores) {
  for (const [name, bytes, expected, selectors, markers] of cases) {
    for (const inputChunkSize of chunks) {
      const label = `${backend} ${name} at ${inputChunkSize} B`;
      const result = await decodePlanarImage(core, bytes, { inputChunkSize });
      assert.deepEqual([...result.samples], expected, label);
      assertStructure(result.structure, selectors, markers, label);
      const report = createVerificationReport({
        host: 'mapping-acceptance', status: 'passed', stages: { decode: 'passed' },
        frame: { ...result.frame, scans: result.scans },
      });
      assert.equal(report.frame.mapping, selectors.some((ids) => ids.some(Boolean)), label);
      if (report.frame.mapping) assert.equal(report.samples.errorBound, null, label);
    }
  }
  for (const [name, bytes, code] of malformed) {
    for (const inputChunkSize of [1, 4096]) {
      await assert.rejects(decodePlanarImage(core, bytes, { inputChunkSize }), { code }, `${backend} ${name}`);
    }
  }
  await assert.rejects(decodePlanarImage(core, cases[1][1], {
    inputChunkSize: 7, limits: { maxMetadataBytes: 65549 },
  }), { code: 'ResourceLimit' }, backend);
  const exactBudget = await decodePlanarImage(core, cases[1][1], { limits: { maxMetadataBytes: 65550 } });
  assert.deepEqual([...exactBudget.samples], highMapped, backend);
  const mapped = await decodePlanarImage(core, cases[0][1]);
  await assert.rejects(encodeImage(core, mapped.frame, Uint16Array.from(lowIndices)), { code: 'UnsupportedFeature' });
  const { mappingSelectors, ...unmappedFrame } = mapped.frame;
  assert.deepEqual(mappingSelectors, [7]);
  await assert.rejects(encodeImage(core, { ...unmappedFrame, scans: mapped.scans }, Uint16Array.from(lowIndices)), { code: 'UnsupportedFeature' });
  const session = core.createDecoder({ inputChunkSize: 64 });
  session.stage(cases[0][1].subarray(0, -2));
  assert.equal(session.step().status, 'RowReady');
  assert.equal(session.step().status, 'NeedInput');
  assert.deepEqual(session.frame.mappingSelectors, [7]);
}

if (options['native-exe']) {
  const { command, prefix } = createNativeRunner(options['native-exe'], options['native-wsl']);
  const dir = mkdtempSync(join(tmpdir(), 'moonjls-mapping-'));
  const input = join(dir, 'test.jls');
  const launch = (args, bytes) => {
    writeFileSync(input, bytes);
    const fd = openSync(input, 'r');
    try {
      const result = spawnSync(command, [...prefix, ...args], { stdio: [fd, 'pipe', 'pipe'], timeout: 45_000 });
      if (result.error) throw result.error;
      return result;
    } finally {
      closeSync(fd);
    }
  };
  try {
    for (const [name, bytes, expected, selectors, markers] of cases) {
      for (const chunk of chunks) {
        const result = launch(['decode', '-', '-', 'raw32-le', String(chunk)], bytes);
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        assert.equal(result.stdout.length, 4 * expected.length, name);
        assert.deepEqual(expected.map((_, i) => result.stdout.readUInt32LE(i * 4)), expected, name);
      }
      const inspection = launch(['inspect', '-', '7', '--json'], bytes);
      assert.equal(inspection.status, 0, name);
      assertStructure(JSON.parse(inspection.stdout), selectors, markers, name);
    }
    const pgm = launch(['decode', '-', '-', 'pgm', '1'], cases[0][1]);
    assert.equal(pgm.status, 0, pgm.stderr.toString());
    assert.deepEqual(pgm.stdout, stream(Buffer.from('P5\n4 1\n255\n'), Buffer.from(lowMapped)));
    for (const [name, bytes, code] of malformed) {
      const result = launch(['verify', '-', '7', '--json'], bytes);
      assert.equal(result.status, 1, name);
      assert.equal(result.stdout.length, 0, name);
      assert.match(result.stderr.toString(), code === 'TrailingData' ? /trailing bytes after EOI/ : new RegExp(code), name);
    }
  } finally {
    rmSync(input, { force: true });
    rmdirSync(dir);
  }
}

console.log(JSON.stringify({
  status: 'passed',
  backends: options['native-exe'] ? ['js', 'wasm-gc', 'native'] : ['js', 'wasm-gc'],
  chunks,
  cases: cases.map(([name, bytes, reconstructed]) => ({ name, sha256: sha256(bytes), reconstructed })),
  malformed: malformed.map(([name, bytes, code]) => ({ name, sha256: sha256(bytes), code })),
  mappingBudgetBytes: 65550,
}));
