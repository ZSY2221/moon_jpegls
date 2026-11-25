import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const width = 768, height = 512, bits = 16, chunk = 8192;
const nears = [0, 3], backends = ['js', 'wasm-gc'];
const warmups = 5, repeats = 7, processPairs = 5;
const self = fileURLToPath(import.meta.url);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

function edges() {
  return Uint16Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return (Math.floor(x / 19) + Math.floor(y / 23)) % 2 ? 65535 : 0;
  });
}

function rawLE(samples) {
  const result = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) result.writeUInt16LE(samples[i], i * 2);
  return result;
}

function samplesLE(bytes) {
  assert.equal(bytes.length % 2, 0);
  return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16LE(i * 2));
}

function validate(result, reference, original, near) {
  assert.deepEqual(result.frame, { width, height, bits, near });
  assert.equal(result.samples.length, original.length);
  assert.equal(result.stats.rows, height);
  assert.equal(result.stats.outputProduced, original.length);
  let maxError = 0;
  for (let i = 0; i < original.length; i++) {
    if (result.samples[i] !== reference[i]) throw new Error(`Same-stream reconstruction differs at ${i}`);
    maxError = Math.max(maxError, Math.abs(result.samples[i] - original[i]));
  }
  assert.ok(maxError <= near, `Original-sample error ${maxError} exceeds NEAR ${near}`);
  return maxError;
}

async function sourceFiles(root, directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(root, name));
    else if ((name.endsWith('.mbt') && !name.endsWith('_test.mbt') && !name.endsWith('_wbtest.mbt')) || name.endsWith('moon.pkg')) files.push(name);
  }
  return files;
}

async function fingerprint(root) {
  const names = [...await sourceFiles(root, 'core'), ...await sourceFiles(root, 'cmd/bridge'),
    'moon.mod', 'sdk/index.mjs', 'sdk/build.mjs'].sort();
  const sources = {};
  for (const name of names) sources[name] = sha(await readFile(join(root, name)));
  const assets = {};
  for (const name of ['sdk/index.mjs', 'sdk/generated/core.mjs', 'sdk/generated/core.wasm']) {
    const bytes = await readFile(join(root, name));
    assets[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  return { sourceDigest: sha(JSON.stringify(sources)), sources, assets };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

function summary(values) {
  const center = median(values);
  return { values, median: center, min: Math.min(...values), max: Math.max(...values), mad: median(values.map((v) => Math.abs(v - center))) };
}

async function prepare(baseline, candidate, output) {
  await mkdir(output, { recursive: true });
  const original = edges(), raw = rawLE(original);
  await writeFile(join(output, 'edges-768x512-16.raw'), raw);
  const roots = { baseline, candidate }, sessions = {};
  for (const [variant, root] of Object.entries(roots)) {
    const sdk = await import(pathToFileURL(join(root, 'sdk/index.mjs')).href);
    sessions[variant] = { sdk, cores: {} };
    for (const backend of backends) sessions[variant].cores[backend] = await sdk.loadCore({ backend });
  }
  const manifest = {
    preparedUtc: new Date().toISOString(),
    baseline: { label: '40d834f15949bc4646b1b58a9e9446572fb529be restored using supplied reverse patch', root: baseline, ...await fingerprint(baseline) },
    candidate: { label: 'e3a3e5c6f33df98df98f84e4d8e06dfe118ef263 plus correctness fixes; exact source digest below', root: candidate, ...await fingerprint(candidate) },
    runnerSha256: sha(await readFile(self)),
    fixture: { width, height, bits, bytes: raw.length, rawLeSha256: sha(raw), formula: '((floor(x/19)+floor(y/23))%2) ? 65535 : 0',
      corpusSourceSha256: sha(await readFile(join(baseline, 'scripts/corpus.py'))),
      origin: 'scripts/corpus.py benchmark_fixtures edges formula; no downloaded fixture' },
    referenceOrigin: 'Visual-baseline Wasm GC encoder; identical bitstreams checked across both source trees and both backends. No new CharLS oracle run.',
    chunk, streams: {}, checks: [],
  };
  for (const near of nears) {
    const frame = { width, height, bits, near };
    const { sdk, cores } = sessions.baseline;
    const encoded = await sdk.encodeImage(cores['wasm-gc'], frame, original, { inputChunkSize: chunk, outputChunkSize: chunk });
    const decoded = await sdk.decodeImage(cores['wasm-gc'], encoded.bytes, { inputChunkSize: chunk });
    const reconstructed = rawLE(decoded.samples);
    await writeFile(join(output, `reference-near${near}.jls`), encoded.bytes);
    await writeFile(join(output, `reference-near${near}.raw`), reconstructed);
    manifest.streams[near] = { bytes: encoded.bytes.length, sha256: sha(encoded.bytes), reconstructionSha256: sha(reconstructed) };
    for (const [variant, { sdk: api, cores: variants }] of Object.entries(sessions)) {
      for (const backend of backends) {
        const actual = await api.encodeImage(variants[backend], frame, original, { inputChunkSize: chunk, outputChunkSize: chunk });
        assert.deepEqual(actual.bytes, encoded.bytes, `${variant}/${backend}/NEAR${near} bitstream differs`);
        const roundTrip = await api.decodeImage(variants[backend], encoded.bytes, { inputChunkSize: chunk });
        const maxError = validate(roundTrip, decoded.samples, original, near);
        manifest.checks.push({ variant, backend, near, bitstreamMatch: true, samplesChecked: original.length,
          maxError, coreWorkspaceBytes: roundTrip.stats.coreWorkspaceBytes });
      }
    }
  }
  await writeJson(join(output, 'fixture-manifest.json'), manifest);
  console.log(JSON.stringify({ phase: 'prepare', fixture: manifest.fixture, streams: manifest.streams, checks: manifest.checks }, null, 2));
}

async function child(root, backend, near, output) {
  const input = await readFile(join(output, `reference-near${near}.jls`));
  const reference = samplesLE(await readFile(join(output, `reference-near${near}.raw`)));
  const original = samplesLE(await readFile(join(output, 'edges-768x512-16.raw')));
  const assetSha256 = {};
  for (const name of ['sdk/index.mjs', backend === 'js' ? 'sdk/generated/core.mjs' : 'sdk/generated/core.wasm']) {
    assetSha256[name] = sha(await readFile(join(root, name)));
  }
  const importAt = performance.now();
  const sdk = await import(pathToFileURL(join(root, 'sdk/index.mjs')).href);
  const sdkImportMs = performance.now() - importAt;
  const core = await sdk.loadCore({ backend });
  const samples = [];
  for (let i = 0; i < 1 + warmups + repeats; i++) {
    const start = performance.now();
    const result = await sdk.decodeImage(core, input, { inputChunkSize: chunk });
    const wallMs = performance.now() - start;
    const maxError = validate(result, reference, original, near);
    samples.push({ sequence: i, phase: i === 0 ? 'cold-decode' : i <= warmups ? 'warmup' : 'formal',
      index: i === 0 ? 1 : i <= warmups ? i : i - warmups, wallMs, firstRowMs: result.stats.firstRowMs,
      maxError, samplesChecked: result.samples.length, stats: result.stats });
  }
  console.log(JSON.stringify({ backend, near, sdkImportMs, coreLoadMs: core.loadMs, assetSha256,
    inputSha256: sha(input), referenceSha256: sha(rawLE(reference)), samples }));
}

async function run(baseline, candidate, output) {
  const manifest = await readJson(join(output, 'fixture-manifest.json'));
  const roots = { baseline, candidate };
  for (const [variant, root] of Object.entries(roots)) {
    const expected = manifest[variant];
    assert.deepEqual(await fingerprint(root), { sourceDigest: expected.sourceDigest, sources: expected.sources, assets: expected.assets });
  }
  assert.equal(sha(await readFile(self)), manifest.runnerSha256, 'Harness changed after fixture preparation');
  const report = {
    startedUtc: new Date().toISOString(), runnerSha256: manifest.runnerSha256,
    environment: { node: process.version, v8: process.versions.v8, platform: platform(), release: release(), cpu: cpus()[0].model,
      memoryBytes: totalmem(), execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null },
    sources: { baseline: manifest.baseline, candidate: manifest.candidate }, fixture: manifest.fixture, streams: manifest.streams,
    referenceOrigin: manifest.referenceOrigin,
    settings: { backends, nears, width, height, bits, chunk, processPairs, coldDecodesPerProcess: 1, warmupsPerProcess: warmups, formalPerProcess: repeats },
    timingBoundary: 'decodeImage call to complete Uint16Array result. Excludes SDK/module loading, fixture I/O and per-sample assertions. SDK import, core loading and first decode are recorded separately.',
    isolation: 'Fresh Node process for each variant/backend/NEAR/process pair; sequential processes with alternating variant order. No worker or browser measurement; no forced GC.',
    historicalStyleWindow: 'After one first decode, the next three raw decodes are also retained as a startup-window summary. This is not a rerun of the historical multi-fixture process order.',
    trials: [], summaries: [], errors: [],
  };
  const reportPath = join(output, 'paired.json');
  await writeFile(reportPath, '{}\n', { flag: 'wx' });
  try {
    for (const near of nears) for (const backend of backends) {
      for (let pair = 1; pair <= processPairs; pair++) {
        const order = pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const variant of order) {
          const command = [self, 'child', roots[variant], backend, String(near), output];
          const startedUtc = new Date().toISOString();
          const result = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
          if (result.error || result.status !== 0) throw new Error(`${variant}/${backend}/NEAR${near}: ${result.error ?? result.stderr ?? result.stdout}`);
          const trial = JSON.parse(result.stdout);
          assert.equal(trial.inputSha256, manifest.streams[near].sha256);
          assert.equal(trial.referenceSha256, manifest.streams[near].reconstructionSha256);
          for (const [name, digest] of Object.entries(trial.assetSha256)) assert.equal(digest, manifest[variant].assets[name].sha256);
          report.trials.push({ variant, pair, order: report.trials.length + 1, startedUtc, finishedUtc: new Date().toISOString(), command: [process.execPath, ...command], ...trial });
          await writeJson(reportPath, report);
        }
      }
      const group = { backend, near };
      for (const variant of ['baseline', 'candidate']) {
        const trials = report.trials.filter((t) => t.variant === variant && t.backend === backend && t.near === near);
        group[variant] = {
          coreLoadMs: summary(trials.map((t) => t.coreLoadMs)),
          coldDecodeMs: summary(trials.map((t) => t.samples[0].wallMs)),
          startupWindowMedianMs: summary(trials.map((t) => median(t.samples.slice(1, 4).map((s) => s.wallMs)))),
          formalProcessMedianMs: summary(trials.map((t) => median(t.samples.filter((s) => s.phase === 'formal').map((s) => s.wallMs)))),
          formalFirstRowProcessMedianMs: summary(trials.map((t) => median(t.samples.filter((s) => s.phase === 'formal').map((s) => s.firstRowMs)))),
        };
      }
      group.formalRegressionPercent = 100 * (group.candidate.formalProcessMedianMs.median / group.baseline.formalProcessMedianMs.median - 1);
      group.startupRegressionPercent = 100 * (group.candidate.startupWindowMedianMs.median / group.baseline.startupWindowMedianMs.median - 1);
      report.summaries.push(group);
      await writeJson(reportPath, report);
      console.log(JSON.stringify(group));
    }
    for (const [variant, root] of Object.entries(roots)) {
      const expected = manifest[variant];
      assert.deepEqual(await fingerprint(root), { sourceDigest: expected.sourceDigest, sources: expected.sources, assets: expected.assets });
    }
  } catch (error) {
    report.errors.push(error.stack ?? String(error));
    throw error;
  } finally {
    report.finishedUtc = new Date().toISOString();
    await writeJson(reportPath, report);
  }
}

const [mode, baselineArg, candidateArg, outputArg, childOutput] = process.argv.slice(2);
if (mode === 'child') await child(resolve(baselineArg), candidateArg, Number(outputArg), resolve(childOutput));
else if (['prepare', 'run'].includes(mode) && baselineArg && candidateArg && outputArg) {
  await (mode === 'prepare' ? prepare : run)(resolve(baselineArg), resolve(candidateArg), resolve(outputArg));
} else {
  throw new Error('Usage: node REVIEW_EVIDENCE/node_edges_regression.mjs prepare|run BASELINE_ROOT CANDIDATE_ROOT OUTPUT_DIRECTORY');
}
